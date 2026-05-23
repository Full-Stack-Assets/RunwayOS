import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunwayApp } from './app.mjs';
import { JsonRunwayStore } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.env.RUNWAYOS_DATA_FILE ?? path.join(__dirname, '..', 'data', 'runwayos.json');
const store = new JsonRunwayStore(dataPath);
await store.load();

const webhookSecret = process.env.RUNWAYOS_WEBHOOK_SECRET;
if (!webhookSecret && process.env.NODE_ENV === 'production') {
  throw new Error('RUNWAYOS_WEBHOOK_SECRET is required in production');
}

const app = createRunwayApp({
  store,
  webhookSecret: webhookSecret ?? 'development-webhook-secret',
  replayWindowSeconds: Number(process.env.WEBHOOK_TOLERANCE_SECONDS ?? 300),
  clock: () => Date.now()
});

const server = http.createServer((req, res) => {
  void app.handleRequest(req, res);
});

const port = Number(process.env.PORT ?? 8000);
server.listen(port, () => {
  process.stdout.write(`RunwayOS listening on http://localhost:${port}\n`);
});
