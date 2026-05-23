import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRunwayApp } from '../src/app.mjs';
import { createInMemoryStore, JsonRunwayStore } from '../src/store.mjs';

async function startServer(app) {
  const server = http.createServer((req, res) => {
    void app.handleRequest(req, res);
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return {
    port,
    server,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function signWebhook(secret, timestamp, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

test('PATCH seat updates persist and unfreeze when deactivated', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runwayos-'));
  const store = new JsonRunwayStore(path.join(tmpDir, 'db.json'));
  await store.load();
  const app = createRunwayApp({ store, webhookSecret: 'secret', clock: () => Date.now() });
  const { port, close } = await startServer(app);

  try {
    const pending = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/offboarding/seats`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // Mixed casing confirms the handler normalizes seat identity before persistence.
        employeeEmail: 'Alex.Chen@StackAudit.io',
        platformName: 'slack',
        status: 'pending_removal'
      })
    });

    assert.equal(pending.status, 200);
    const pendingJson = await pending.json();
    assert.equal(pendingJson.runwayUnfrozen, false);

    const active = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/offboarding/seats`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        employeeEmail: 'alex.chen@stackaudit.io',
        platformName: 'slack',
        status: 'deactivated'
      })
    });

    assert.equal(active.status, 200);
    const activeJson = await active.json();
    assert.equal(activeJson.runwayUnfrozen, true);
    assert.equal(activeJson.seat.status, 'deactivated');
    assert.equal(activeJson.seat.employeeEmail, 'alex.chen@stackaudit.io');

    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, 'db.json'), 'utf8'));
    assert.equal(persisted.workspaces.acme.seats['alex.chen@stackaudit.io::slack'].status, 'deactivated');
  } finally {
    await close();
  }
});

test('webhook ingestion verifies signatures and deduplicates replayed events', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runwayos-'));
  const store = new JsonRunwayStore(path.join(tmpDir, 'db.json'));
  await store.load();
  const secret = 'test-secret';
  const app = createRunwayApp({
    store,
    webhookSecret: secret,
    clock: () => 1_700_000_000_000
  });
  const { port, close } = await startServer(app);

  try {
    const body = JSON.stringify({
      eventId: 'evt_1',
      workspaceId: 'acme',
      employeeEmail: 'alex.chen@stackaudit.io',
      platformName: 'slack',
      status: 'pending_removal',
      source: 'slack'
    });
    const timestamp = Math.floor(1_700_000_000_000 / 1000);
    const signature = signWebhook(secret, timestamp, body);

    const first = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/offboarding/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runway-timestamp': String(timestamp),
        'x-runway-signature': signature,
        'x-runway-event-id': 'evt_1'
      },
      body
    });

    assert.equal(first.status, 200);
    const firstJson = await first.json();
    assert.equal(firstJson.replayed, false);
    assert.equal(firstJson.seat.status, 'pending_removal');

    const replay = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/offboarding/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runway-timestamp': String(timestamp),
        'x-runway-signature': signature,
        'x-runway-event-id': 'evt_1'
      },
      body
    });

    assert.equal(replay.status, 200);
    const replayJson = await replay.json();
    assert.equal(replayJson.eventId, 'evt_1');
    assert.equal(replayJson.replayed, true);

    const wrongSignature = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/offboarding/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runway-timestamp': String(timestamp),
        'x-runway-signature': 'sha256=deadbeef',
        'x-runway-event-id': 'evt_2'
      },
      body
    });

    assert.equal(wrongSignature.status, 401);
  } finally {
    await close();
  }
});

test('seat status changes control runway freeze state', () => {
  const store = createInMemoryStore();

  assert.equal(store.upsertSeat('acme', {
    employeeEmail: 'alex.chen@stackaudit.io',
    platformName: 'slack',
    status: 'active'
  }).runwayFrozen, false);

  assert.equal(store.upsertSeat('acme', {
    employeeEmail: 'alex.chen@stackaudit.io',
    platformName: 'slack',
    status: 'pending_removal'
  }).runwayFrozen, true);

  assert.equal(store.upsertSeat('acme', {
    employeeEmail: 'jordan.lee@stackaudit.io',
    platformName: 'github',
    status: 'pending_removal'
  }).runwayFrozen, true);

  assert.equal(store.upsertSeat('acme', {
    employeeEmail: 'alex.chen@stackaudit.io',
    platformName: 'slack',
    status: 'deactivated'
  }).runwayFrozen, true);

  assert.equal(store.upsertSeat('acme', {
    employeeEmail: 'jordan.lee@stackaudit.io',
    platformName: 'github',
    status: 'deactivated'
  }).runwayFrozen, false);
});


test('workspace policies, audit logs, and persistence recovery work end to end', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runwayos-'));
  const dbFile = path.join(tmpDir, 'db.json');
  const store = new JsonRunwayStore(dbFile);
  await store.load();
  const app = createRunwayApp({ store, webhookSecret: 'secret', clock: () => Date.now() });
  const { port, close } = await startServer(app);

  try {
    const seeded = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/offboarding/seats`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        employeeEmail: 'sam.ira@stackaudit.io',
        platformName: 'zoom',
        status: 'active',
        monthlyCost: 29,
        currency: 'usd'
      })
    });
    assert.equal(seeded.status, 200);

    const policyUpdate = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/policies`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalRequired: true, manualOverrideEnabled: false })
    });
    assert.equal(policyUpdate.status, 200);

    const blocked = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/offboarding/seats`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        employeeEmail: 'sam.ira@stackaudit.io',
        platformName: 'zoom',
        status: 'deactivated'
      })
    });
    assert.equal(blocked.status, 422);

    const approved = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/offboarding/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'approve',
        actor: 'operator-1',
        employeeEmail: 'sam.ira@stackaudit.io',
        platformName: 'zoom',
        monthlyCost: 29,
        currency: 'USD'
      })
    });
    assert.equal(approved.status, 200);
    const approvedJson = await approved.json();
    assert.equal(approvedJson.seat.status, 'pending_removal');

    const reconciled = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/offboarding/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'reconcile',
        actor: 'operator-1',
        employeeEmail: 'sam.ira@stackaudit.io',
        platformName: 'zoom',
        status: 'deactivated',
        monthlyCost: 29,
        currency: 'USD',
        reason: 'provider confirmed deprovisioned'
      })
    });
    assert.equal(reconciled.status, 200);

    const summary = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/summary`);
    assert.equal(summary.status, 200);
    const summaryJson = await summary.json();
    assert.equal(summaryJson.summary.recoveredMonthly, 29);
    assert.equal(summaryJson.summary.statusCounts.deactivated, 1);

    const auditLog = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/audit-log`);
    assert.equal(auditLog.status, 200);
    const auditJson = await auditLog.json();
    assert.ok(auditJson.auditLog.some((entry) => entry.type === 'policy_updated'));
    assert.ok(auditJson.auditLog.some((entry) => entry.type === 'seat_reconciled'));

    const seats = await fetch(`http://127.0.0.1:${port}/api/workspaces/acme/offboarding/seats`);
    assert.equal(seats.status, 200);
    const seatsJson = await seats.json();
    assert.equal(seatsJson.seats[0].status, 'deactivated');

    await close();

    const recoveredStore = new JsonRunwayStore(dbFile);
    await recoveredStore.load();
    assert.equal(recoveredStore.getSeat('acme', 'sam.ira@stackaudit.io', 'zoom').status, 'deactivated');
    assert.equal(recoveredStore.summarizeWorkspace('acme').recoveredMonthly, 29);
    assert.ok(recoveredStore.listAuditEvents('acme').length >= 3);
  } finally {
    await close().catch(() => {});
  }
});
