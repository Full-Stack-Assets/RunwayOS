import { ConflictError, UnauthorizedError, ValidationError } from './errors.mjs';
import {
  parseEventId,
  validateLifecycleActionPayload,
  validatePolicyPayload,
  validateSeatPayload,
  validateWebhookPayload,
  verifyWebhookSignature
} from './validation.mjs';

const SUPPORTED_ROUTE_TYPES = [
  'seat-update',
  'seat-list',
  'policy-update',
  'lifecycle-action',
  'audit-log',
  'summary',
  'export',
  'webhook'
];

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: `${JSON.stringify(body)}\n`
  };
}

function csvResponse(body, filename) {
  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`
    },
    body
  };
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text) || /^\s|\s$/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function serializeCsv(rows) {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function compareSeatExportEntries(left, right) {
  // The store normally persists complete seat records, but this keeps list and export
  // stable if a workspace contains legacy or manually seeded partial rows.
  const leftEmail = left.employeeEmail ?? '';
  const rightEmail = right.employeeEmail ?? '';
  const emailComparison = leftEmail.localeCompare(rightEmail);
  if (emailComparison !== 0) {
    return emailComparison;
  }

  return (left.platformName ?? '').localeCompare(right.platformName ?? '');
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function routeMatch(url, method) {
  const parsed = new URL(url, 'http://localhost');
  const parts = parsed.pathname.split('/').filter(Boolean);
  const hasWorkspacePrefix = parts.length >= 3 && parts[0] === 'api' && parts[1] === 'workspaces';

  if (hasWorkspacePrefix && parts.length === 5 && parts[3] === 'offboarding' && parts[4] === 'seats') {
    if (method === 'PATCH' || method === 'GET') {
      return { type: method === 'GET' ? 'seat-list' : 'seat-update', workspaceId: parts[2] };
    }
  }

  if (hasWorkspacePrefix && parts.length === 4 && parts[3] === 'policies' && method === 'PATCH') {
    return { type: 'policy-update', workspaceId: parts[2] };
  }

  if (hasWorkspacePrefix && parts.length === 4 && parts[3] === 'summary' && method === 'GET') {
    return { type: 'summary', workspaceId: parts[2] };
  }

  if (hasWorkspacePrefix && parts.length === 4 && parts[3] === 'audit-log' && method === 'GET') {
    return { type: 'audit-log', workspaceId: parts[2] };
  }

  if (hasWorkspacePrefix && parts.length === 5 && parts[3] === 'offboarding' && parts[4] === 'actions' && method === 'POST') {
    return { type: 'lifecycle-action', workspaceId: parts[2] };
  }

  if (hasWorkspacePrefix && parts.length === 5 && parts[3] === 'offboarding' && parts[4] === 'export' && method === 'GET') {
    return { type: 'export', workspaceId: parts[2] };
  }

  if (method === 'PATCH' && hasWorkspacePrefix && parts.length === 5 && parts[3] === 'offboarding' && parts[4] === 'seats') {
    return { type: 'seat-update', workspaceId: parts[2] };
  }

  const isWebhookPath = hasWorkspacePrefix && (
    (parts.length === 4 && parts[3] === 'webhook')
    || (parts.length === 5 && parts[3] === 'offboarding' && parts[4] === 'webhook')
  );
  if (method === 'POST' && isWebhookPath) {
    return { type: 'webhook', workspaceId: parts[2] };
  }

  return null;
}

export function createRunwayApp({ store, webhookSecret, replayWindowSeconds = 300, clock = () => Date.now() }) {
  if (!store) {
    throw new Error('store is required');
  }

  async function handleSeatUpdate(workspaceId, rawBody) {
    const body = JSON.parse(rawBody.toString('utf8'));
    const seat = validateSeatPayload(body);
    const policies = store.getPolicies(workspaceId);
    if (policies.approvalRequired && seat.status === 'deactivated') {
      throw new ValidationError('workspace policy requires approval before deactivation');
    }

    const result = store.upsertSeat(workspaceId, { ...seat, source: 'api' });
    store.recordAuditEvent(workspaceId, {
      type: 'seat_updated',
      actor: 'api',
      employeeEmail: seat.employeeEmail,
      platformName: seat.platformName,
      status: seat.status,
      details: {
        monthlyCost: seat.monthlyCost,
        currency: seat.currency,
        notes: seat.notes
      }
    });
    await store.save();

    return jsonResponse(200, {
      status: 'success',
      message: `Seat for ${seat.platformName} updated to ${seat.status}.`,
      workspaceId,
      runwayUnfrozen: !result.runwayFrozen,
      seat: result.seat,
      summary: store.summarizeWorkspace(workspaceId)
    });
  }

  async function handleSeatList(workspaceId) {
    const seats = store.listSeats(workspaceId).sort(compareSeatExportEntries);

    return jsonResponse(200, {
      status: 'success',
      workspaceId,
      seats,
      summary: store.summarizeWorkspace(workspaceId),
      policies: store.getPolicies(workspaceId)
    });
  }

  async function handleWebhook(workspaceId, rawBody, headers) {
    verifyWebhookSignature({
      rawBody,
      headers,
      secret: webhookSecret,
      now: clock(),
      toleranceSeconds: replayWindowSeconds
    });

    const payload = validateWebhookPayload(JSON.parse(rawBody.toString('utf8')));
    if (payload.workspaceId !== workspaceId) {
      throw new ValidationError('payload workspaceId does not match route workspace');
    }

    const eventId = parseEventId(headers, payload);
    const alreadyProcessed = store.hasWebhookEvent(workspaceId, eventId);
    if (!alreadyProcessed) {
      const policies = store.getPolicies(workspaceId);
      if (policies.approvalRequired && payload.status === 'deactivated') {
        throw new ValidationError('workspace policy requires approval before deactivation');
      }

      store.recordWebhookEvent(workspaceId, {
        eventId,
        provider: payload.source,
        rawBody: rawBody.toString('utf8'),
        receivedAt: new Date(clock()).toISOString()
      });

      const result = store.upsertSeat(workspaceId, {
        employeeEmail: payload.employeeEmail,
        platformName: payload.platformName,
        status: payload.status,
        monthlyCost: payload.monthlyCost,
        currency: payload.currency,
        notes: payload.notes,
        source: 'webhook'
      });
      store.recordAuditEvent(workspaceId, {
        type: 'webhook_processed',
        actor: `webhook:${payload.source}`,
        eventId,
        employeeEmail: payload.employeeEmail,
        platformName: payload.platformName,
        status: payload.status,
        details: {
          monthlyCost: payload.monthlyCost,
          currency: payload.currency,
          notes: payload.notes
        },
        runwayFrozen: result.runwayFrozen
      });
      await store.save();
    }

    const seat = store.getSeat(workspaceId, payload.employeeEmail, payload.platformName);
    const workspace = store.getWorkspace(workspaceId);
    return jsonResponse(200, {
      status: 'success',
      replayed: alreadyProcessed,
      workspaceId,
      eventId,
      runwayUnfrozen: !workspace?.runwayFrozen,
      seat,
      summary: store.summarizeWorkspace(workspaceId)
    });
  }

  async function handlePolicyUpdate(workspaceId, rawBody) {
    const policy = validatePolicyPayload(JSON.parse(rawBody.toString('utf8')));
    const updated = store.updatePolicies(workspaceId, policy);
    store.recordAuditEvent(workspaceId, {
      type: 'policy_updated',
      actor: 'api',
      details: updated
    });
    await store.save();
    return jsonResponse(200, {
      status: 'success',
      workspaceId,
      policies: updated
    });
  }

  async function handleLifecycleAction(workspaceId, rawBody) {
    const action = validateLifecycleActionPayload(JSON.parse(rawBody.toString('utf8')));
    const policies = store.getPolicies(workspaceId);
    if (action.action === 'override' && !policies.manualOverrideEnabled) {
      throw new ValidationError('manual overrides are disabled by workspace policy');
    }

    const nextStatus = action.action === 'approve'
      ? 'pending_removal'
      : action.status;

    const result = store.upsertSeat(workspaceId, {
      employeeEmail: action.employeeEmail,
      platformName: action.platformName,
      status: nextStatus,
      monthlyCost: action.monthlyCost,
      currency: action.currency,
      notes: action.notes,
      source: action.action
    });
    const auditTypes = {
      approve: 'seat_approved',
      reconcile: 'seat_reconciled',
      override: 'seat_overridden'
    };
    store.recordAuditEvent(workspaceId, {
      type: auditTypes[action.action],
      actor: action.actor,
      employeeEmail: action.employeeEmail,
      platformName: action.platformName,
      status: nextStatus,
      reason: action.reason,
      details: {
        monthlyCost: action.monthlyCost,
        currency: action.currency,
        notes: action.notes
      }
    });
    await store.save();
    return jsonResponse(200, {
      status: 'success',
      workspaceId,
      action: action.action,
      seat: result.seat,
      summary: store.summarizeWorkspace(workspaceId)
    });
  }

  async function handleAuditLog(workspaceId) {
    return jsonResponse(200, {
      status: 'success',
      workspaceId,
      auditLog: store.listAuditEvents(workspaceId)
    });
  }

  async function handleSummary(workspaceId) {
    return jsonResponse(200, {
      status: 'success',
      workspaceId,
      summary: store.summarizeWorkspace(workspaceId)
    });
  }

  async function handleExport(workspaceId) {
    const workspace = store.getWorkspace(workspaceId);
    const seats = store.listSeats(workspaceId).sort(compareSeatExportEntries);
    const rows = [
      // source records the persisted origin label; legacy rows may leave it blank.
      ['workspaceId', 'employeeEmail', 'platformName', 'status', 'source', 'monthlyCost', 'currency', 'notes', 'updatedAt']
    ];

    for (const seat of seats) {
      rows.push([
        workspaceId,
        seat.employeeEmail,
        seat.platformName,
        seat.status,
        seat.source ?? '',
        seat.monthlyCost ?? '',
        seat.currency ?? '',
        seat.notes ?? '',
        seat.updatedAt ?? ''
      ]);
    }

    return csvResponse(
      serializeCsv(rows),
      `runwayos-${workspace?.id ?? workspaceId}-export.csv`
    );
  }

  async function handleRequest(req, res) {
    try {
      const route = routeMatch(req.url, req.method);
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(`${JSON.stringify({ error: 'not_found' })}\n`);
        return;
      }

      const rawBody = await readRequestBody(req);
      let result;
      switch (route.type) {
        case 'seat-update':
          result = await handleSeatUpdate(route.workspaceId, rawBody);
          break;
        case 'seat-list':
          result = await handleSeatList(route.workspaceId);
          break;
        case 'policy-update':
          result = await handlePolicyUpdate(route.workspaceId, rawBody);
          break;
        case 'lifecycle-action':
          result = await handleLifecycleAction(route.workspaceId, rawBody);
          break;
        case 'audit-log':
          result = await handleAuditLog(route.workspaceId);
          break;
        case 'summary':
          result = await handleSummary(route.workspaceId);
          break;
        case 'export':
          result = await handleExport(route.workspaceId);
          break;
        case 'webhook':
          result = await handleWebhook(route.workspaceId, rawBody, req.headers);
          break;
        default:
          throw new Error(`Internal error: unsupported route type "${route.type}". Expected one of: ${SUPPORTED_ROUTE_TYPES.join(', ')}`);
      }

      res.writeHead(result.statusCode, result.headers);
      res.end(result.body);
    } catch (error) {
      const statusCode = error.statusCode ?? (error instanceof SyntaxError ? 400 : 500);
      const payload = {
        error: error.name === 'SyntaxError' ? 'invalid_json' : 'request_failed',
        message: error.message
      };

      if (error instanceof ConflictError) {
        payload.error = 'conflict';
      } else if (error instanceof UnauthorizedError) {
        payload.error = 'unauthorized';
      } else if (error instanceof ValidationError) {
        payload.error = 'validation_error';
      }

      res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      res.end(`${JSON.stringify(payload)}\n`);
    }
  }

  return { handleRequest };
}
