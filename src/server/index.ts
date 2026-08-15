import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate, openDatabase } from './db.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
migrate(db);
const app = await buildApp({ db, config });
app.addHook('onClose', async () => db.close());
await app.listen({ host: '0.0.0.0', port: config.port });
