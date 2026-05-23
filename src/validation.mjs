import crypto from 'node:crypto';
import { OFFBOARDING_PLATFORM_ENUM, OFFBOARDING_STATUS_ENUM, isOffboardingPlatform, isOffboardingStatus } from './domain.mjs';
import { UnauthorizedError, ValidationError } from './errors.mjs';

const EMAIL_PATTERN = /^(?:[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+|"(?:[^"\\]|\\.)+")@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/;
const TIMESTAMP_HEADER_NAMES = ['x-runway-timestamp', 'x-signature-timestamp'];
const SIGNATURE_HEADER_NAMES = ['x-runway-signature', 'x-signature'];
const EVENT_ID_HEADER_NAMES = ['x-runway-event-id', 'x-event-id'];

export function normalizeEmail(email) {
  if (typeof email !== 'string') {
    throw new ValidationError('employeeEmail must be a string');
  }

  const normalized = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new ValidationError('employeeEmail must be a valid email address');
  }

  return normalized;
}

export function validateSeatPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('request body must be a JSON object');
  }

  const employeeEmail = normalizeEmail(payload.employeeEmail);
  const platformName = payload.platformName;
  const status = payload.status;
  const monthlyCost = payload.monthlyCost;
  const currency = typeof payload.currency === 'string' ? payload.currency.trim().toUpperCase() : '';
  const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';

  if (!isOffboardingPlatform(platformName)) {
    throw new ValidationError(`platformName must be one of: ${OFFBOARDING_PLATFORM_ENUM.join(', ')}`);
  }

  if (!isOffboardingStatus(status)) {
    throw new ValidationError(`status must be one of: ${OFFBOARDING_STATUS_ENUM.join(', ')}`);
  }

  if (monthlyCost !== undefined && (!Number.isFinite(monthlyCost) || monthlyCost < 0)) {
    throw new ValidationError('monthlyCost must be a non-negative number');
  }

  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError('currency must be an ISO 4217 code');
  }

  return {
    employeeEmail,
    platformName,
    status,
    monthlyCost: monthlyCost ?? undefined,
    currency: currency || undefined,
    notes: notes || undefined
  };
}

export function validateWebhookPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('webhook payload must be a JSON object');
  }

  const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
  if (!eventId) {
    throw new ValidationError('webhook payload must include a non-empty eventId');
  }

  const { employeeEmail, platformName, status } = validateSeatPayload(payload);
  const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId.trim() : '';
  if (!workspaceId) {
    throw new ValidationError('webhook payload must include workspaceId');
  }

  return {
    eventId,
    workspaceId,
    employeeEmail,
    platformName,
    status,
    monthlyCost: payload.monthlyCost,
    currency: typeof payload.currency === 'string' ? payload.currency.trim().toUpperCase() : '',
    notes: typeof payload.notes === 'string' ? payload.notes.trim() : '',
    source: typeof payload.source === 'string' ? payload.source.trim() : 'webhook'
  };
}

export function validatePolicyPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('policy payload must be a JSON object');
  }

  const policy = {};
  for (const key of ['approvalRequired', 'autoReconcile', 'manualOverrideEnabled']) {
    if (payload[key] !== undefined) {
      if (typeof payload[key] !== 'boolean') {
        throw new ValidationError(`${key} must be a boolean`);
      }
      policy[key] = payload[key];
    }
  }

  if (Object.keys(policy).length === 0) {
    throw new ValidationError('policy payload must include at least one policy field');
  }

  return policy;
}

export function validateLifecycleActionPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('action payload must be a JSON object');
  }

  const action = typeof payload.action === 'string' ? payload.action.trim() : '';
  if (!['approve', 'reconcile', 'override'].includes(action)) {
    throw new ValidationError('action must be one of: approve, reconcile, override');
  }

  const employeeEmail = normalizeEmail(payload.employeeEmail);
  const platformName = payload.platformName;
  if (!isOffboardingPlatform(platformName)) {
    throw new ValidationError(`platformName must be one of: ${OFFBOARDING_PLATFORM_ENUM.join(', ')}`);
  }

  const status = action === 'approve' ? 'pending_removal' : payload.status;
  if (action !== 'approve' && !isOffboardingStatus(status)) {
    throw new ValidationError(`status must be one of: ${OFFBOARDING_STATUS_ENUM.join(', ')}`);
  }

  if (action === 'approve' && payload.status !== undefined && !isOffboardingStatus(payload.status)) {
    throw new ValidationError(`status must be one of: ${OFFBOARDING_STATUS_ENUM.join(', ')}`);
  }

  const monthlyCost = payload.monthlyCost;
  if (monthlyCost !== undefined && (!Number.isFinite(monthlyCost) || monthlyCost < 0)) {
    throw new ValidationError('monthlyCost must be a non-negative number');
  }

  const currency = typeof payload.currency === 'string' ? payload.currency.trim().toUpperCase() : '';
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError('currency must be an ISO 4217 code');
  }

  const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';

  if (action === 'override' && typeof payload.reason !== 'string' && typeof payload.reason !== 'undefined') {
    throw new ValidationError('override reason must be a string');
  }

  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  const actor = typeof payload.actor === 'string' ? payload.actor.trim() : 'operator';

  return {
    action,
    actor: actor || 'operator',
    reason: reason || undefined,
    employeeEmail,
    platformName,
    status,
    monthlyCost: monthlyCost ?? undefined,
    currency: currency || undefined,
    notes: notes || undefined
  };
}

export function getHeaderValue(headers, names) {
  for (const name of names) {
    const value = headers[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

export function parseReplayTimestamp(headers) {
  const timestampValue = getHeaderValue(headers, TIMESTAMP_HEADER_NAMES);
  if (!timestampValue) {
    throw new UnauthorizedError('missing signature timestamp');
  }

  const timestamp = Number(timestampValue);
  if (!Number.isFinite(timestamp)) {
    throw new UnauthorizedError('invalid signature timestamp');
  }

  return timestamp;
}

export function parseEventId(headers, payload) {
  const headerEventId = getHeaderValue(headers, EVENT_ID_HEADER_NAMES);
  if (headerEventId) {
    return headerEventId;
  }

  if (payload && typeof payload.eventId === 'string' && payload.eventId.trim()) {
    return payload.eventId.trim();
  }

  throw new ValidationError('eventId is required');
}

export function verifyWebhookSignature({ rawBody, headers, secret, now = Date.now(), toleranceSeconds = 300 }) {
  if (!secret) {
    throw new UnauthorizedError('webhook secret is not configured');
  }

  const timestamp = parseReplayTimestamp(headers);
  const skewMilliseconds = now - timestamp * 1000;
  if (skewMilliseconds < 0 || skewMilliseconds > toleranceSeconds * 1000) {
    throw new UnauthorizedError('signature timestamp outside acceptance window');
  }

  const signature = getHeaderValue(headers, SIGNATURE_HEADER_NAMES);
  if (!signature) {
    throw new UnauthorizedError('missing webhook signature');
  }

  const rawBytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const baseString = `${timestamp}.${rawBytes.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(baseString).digest('hex');
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  const expectedBuffer = Buffer.from(expected, 'hex');
  const providedBuffer = Buffer.from(provided, 'hex');
  const validLength = expectedBuffer.length === providedBuffer.length;
  const matches = validLength && crypto.timingSafeEqual(expectedBuffer, providedBuffer);

  if (!matches) {
    throw new UnauthorizedError('signature mismatch');
  }

  return { timestamp };
}
