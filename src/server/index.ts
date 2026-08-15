import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate, openDatabase } from './db.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
migrate(db);
const app = await buildApp({ db, config });
await app.listen({ host: '0.0.0.0', port: config.port });

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await app.close();
  db.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
