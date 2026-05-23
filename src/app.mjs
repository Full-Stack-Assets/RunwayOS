import { ConflictError, UnauthorizedError, ValidationError } from './errors.mjs';
import { parseEventId, validateSeatPayload, validateWebhookPayload, verifyWebhookSignature } from './validation.mjs';

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: `${JSON.stringify(body)}\n`
  };
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
    const result = store.upsertSeat(workspaceId, { ...seat, source: 'api' });
    await store.save();

    return jsonResponse(200, {
      status: 'success',
      message: `Seat for ${seat.platformName} updated to ${seat.status}.`,
      workspaceId,
      runwayUnfrozen: !result.runwayFrozen,
      seat: result.seat
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
      store.recordWebhookEvent(workspaceId, {
        eventId,
        provider: payload.source,
        rawBody: rawBody.toString('utf8'),
        receivedAt: new Date(clock()).toISOString()
      });
      store.upsertSeat(workspaceId, {
        employeeEmail: payload.employeeEmail,
        platformName: payload.platformName,
        status: payload.status,
        source: 'webhook'
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
      seat
    });
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
      const result = route.type === 'seat-update'
        ? await handleSeatUpdate(route.workspaceId, rawBody)
        : await handleWebhook(route.workspaceId, rawBody, req.headers);

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
