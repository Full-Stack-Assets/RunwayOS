import fs from 'node:fs/promises';
import path from 'node:path';
import { OFFBOARDING_STATUS_ENUM } from './domain.mjs';
import { ConflictError } from './errors.mjs';

const DEFAULT_SAVE_DEBOUNCE_MS = 250;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createEmptyDatabase() {
  return { version: 1, workspaces: {} };
}

function seatKey(employeeEmail, platformName) {
  return `${employeeEmail}::${platformName}`;
}

function computeRunwayFrozen(seats) {
  return Object.values(seats).some((seat) => seat.status === 'pending_removal');
}

export class JsonRunwayStore {
  constructor(filePath, { clock = () => Date.now(), saveDebounceMs = DEFAULT_SAVE_DEBOUNCE_MS } = {}) {
    this.filePath = filePath;
    this._db = null;
    this._pendingSave = null;
    this._clock = clock;
    this._saveDebounceMs = saveDebounceMs;
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this._db = JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      this._db = createEmptyDatabase();
      await this.save();
    }
  }

  async save() {
    if (!this._db) {
      this._db = createEmptyDatabase();
    }

    if (!this._pendingSave) {
      this._pendingSave = new Promise((resolve, reject) => {
        setTimeout(async () => {
          try {
            const tmpPath = `${this.filePath}.tmp`;
            await fs.writeFile(tmpPath, `${JSON.stringify(this._db, null, 2)}\n`);
            await fs.rename(tmpPath, this.filePath);
            resolve();
          } catch (error) {
            reject(error);
          } finally {
            this._pendingSave = null;
          }
        }, this._saveDebounceMs);
      });
    }

    return this._pendingSave;
  }

  ensureLoaded() {
    if (!this._db) {
      throw new Error('store must be loaded before use');
    }
  }

  getWorkspace(workspaceId) {
    this.ensureLoaded();
    return this._db.workspaces[workspaceId] ?? null;
  }

  _ensureWorkspace(workspaceId) {
    this.ensureLoaded();
    if (!this._db.workspaces[workspaceId]) {
      this._db.workspaces[workspaceId] = {
        id: workspaceId,
        seats: {},
        webhookEvents: {},
        runwayFrozen: false,
        updatedAt: new Date(this._clock()).toISOString()
      };
    }

    return this._db.workspaces[workspaceId];
  }

  listSeats(workspaceId) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      return [];
    }

    return Object.values(workspace.seats).map(clone);
  }

  hasWebhookEvent(workspaceId, eventId) {
    const workspace = this.getWorkspace(workspaceId);
    return Boolean(workspace?.webhookEvents?.[eventId]);
  }

  recordWebhookEvent(workspaceId, record) {
    const workspace = this._ensureWorkspace(workspaceId);
    if (workspace.webhookEvents[record.eventId]) {
      throw new ConflictError(`webhook event ${record.eventId} already processed`);
    }

    workspace.webhookEvents[record.eventId] = {
      ...record,
      receivedAt: record.receivedAt ?? new Date(this._clock()).toISOString()
    };
    workspace.updatedAt = new Date(this._clock()).toISOString();
  }

  upsertSeat(workspaceId, seatInput) {
    const workspace = this._ensureWorkspace(workspaceId);
    const key = seatKey(seatInput.employeeEmail, seatInput.platformName);
    const now = seatInput.updatedAt ?? new Date(this._clock()).toISOString();
    const current = workspace.seats[key];

    workspace.seats[key] = {
      employeeEmail: seatInput.employeeEmail,
      platformName: seatInput.platformName,
      status: seatInput.status,
      source: seatInput.source ?? current?.source ?? 'api',
      updatedAt: now
    };
    workspace.runwayFrozen = computeRunwayFrozen(workspace.seats);
    workspace.updatedAt = now;

    return {
      seat: clone(workspace.seats[key]),
      runwayFrozen: workspace.runwayFrozen
    };
  }

  getSeat(workspaceId, employeeEmail, platformName) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      return null;
    }

    return clone(workspace.seats[seatKey(employeeEmail, platformName)] ?? null);
  }

  snapshot() {
    this.ensureLoaded();
    return clone(this._db);
  }
}

export function createInMemoryStore(initialState = createEmptyDatabase()) {
  const state = clone(initialState);
  const clock = () => Date.now();

  return {
    async load() {},
    async save() {},
    getWorkspace(workspaceId) {
      return state.workspaces[workspaceId] ?? null;
    },
    listSeats(workspaceId) {
      const workspace = state.workspaces[workspaceId];
      return workspace ? Object.values(workspace.seats).map(clone) : [];
    },
    hasWebhookEvent(workspaceId, eventId) {
      return Boolean(state.workspaces[workspaceId]?.webhookEvents?.[eventId]);
    },
    recordWebhookEvent(workspaceId, record) {
      const workspace = state.workspaces[workspaceId] ?? (state.workspaces[workspaceId] = {
        id: workspaceId,
        seats: {},
        webhookEvents: {},
        runwayFrozen: false,
        updatedAt: new Date(clock()).toISOString()
      });

      if (workspace.webhookEvents[record.eventId]) {
        throw new ConflictError(`webhook event ${record.eventId} already processed`);
      }

      workspace.webhookEvents[record.eventId] = {
        ...record,
        receivedAt: record.receivedAt ?? new Date(clock()).toISOString()
      };
      workspace.updatedAt = new Date(clock()).toISOString();
    },
    upsertSeat(workspaceId, seatInput) {
      const workspace = state.workspaces[workspaceId] ?? (state.workspaces[workspaceId] = {
        id: workspaceId,
        seats: {},
        webhookEvents: {},
        runwayFrozen: false,
        updatedAt: new Date(clock()).toISOString()
      });
      const key = seatKey(seatInput.employeeEmail, seatInput.platformName);
      const now = seatInput.updatedAt ?? new Date(clock()).toISOString();
      const current = workspace.seats[key];
      workspace.seats[key] = {
        employeeEmail: seatInput.employeeEmail,
        platformName: seatInput.platformName,
        status: seatInput.status,
        source: seatInput.source ?? current?.source ?? 'api',
        updatedAt: now
      };
      workspace.runwayFrozen = computeRunwayFrozen(workspace.seats);
      workspace.updatedAt = now;
      return {
        seat: clone(workspace.seats[key]),
        runwayFrozen: workspace.runwayFrozen
      };
    },
    getSeat(workspaceId, employeeEmail, platformName) {
      const workspace = state.workspaces[workspaceId];
      return workspace ? clone(workspace.seats[seatKey(employeeEmail, platformName)] ?? null) : null;
    },
    snapshot() {
      return clone(state);
    }
  };
}

export function validateStoreState(store) {
  for (const workspace of Object.values(store.snapshot().workspaces ?? {})) {
    for (const seat of Object.values(workspace.seats ?? {})) {
      if (!OFFBOARDING_STATUS_ENUM.includes(seat.status)) {
        throw new Error(`invalid seat status persisted: ${seat.status}`);
      }
    }
  }
}
