import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRunwayApp } from '../src/app.mjs';
import { JsonRunwayStore } from '../src/store.mjs';

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
