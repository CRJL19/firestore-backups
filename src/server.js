const { createFirestore } = require('./firestore');
const { createApp } = require('./app');
const { createBackupLister } = require('./github');

const db = createFirestore();

// Sin EDIT_KEY en producción la app queda de solo lectura, que es el fallo seguro.
const editKey = process.env.EDIT_KEY || (process.env.FIRESTORE_EMULATOR_HOST ? 'dev-key' : null);
if (!editKey) console.warn('[server] Falta EDIT_KEY: la app queda en modo de solo lectura.');
if (process.env.FIRESTORE_EMULATOR_HOST && !process.env.EDIT_KEY) console.log('[server] Clave de edición local: dev-key');

const app = createApp({
  db,
  editKey,
  listBackups: createBackupLister({ repository: process.env.BACKUPS_REPOSITORY }),
});

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => console.log(`[server] http://localhost:${port}`));

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
