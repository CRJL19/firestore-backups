const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const inventory = require('./inventory');

const { ApiError } = inventory;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();

function createApp({ db, editKey, listBackups, limits = {} }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '16kb' }));

  // Sin tocar la base: Render lo consulta seguido y gastaría la cuota gratuita.
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  app.get('/api/health/ready', async (req, res) => {
    try {
      await db.collection('suppliers').limit(1).get();
      res.json({ status: 'ok', database: 'up' });
    } catch (error) {
      console.error(`[ready] ${error.message}`);
      res.status(503).json({ status: 'error', database: 'down' });
    }
  });

  const standard = { standardHeaders: 'draft-7', legacyHeaders: false };
  const readLimit = rateLimit({ ...standard, windowMs: 60_000, limit: limits.read ?? 120 });
  const writeLimit = rateLimit({ ...standard, windowMs: 60_000, limit: limits.write ?? 30 });

  /** Esta app es pública: sin la clave se puede mirar, pero no modificar. */
  function requireEditKey(req, res, next) {
    const given = req.get('X-Edit-Key');
    if (!editKey || !given || !crypto.timingSafeEqual(sha256(given), sha256(editKey))) {
      return next(new ApiError(403, 'Se necesita la clave de edición.'));
    }
    return next();
  }

  const handle = (fn) => (req, res, next) => fn(req, res).catch(next);

  app.use('/api', readLimit);

  app.get('/api/suppliers', handle(async (req, res) => res.json(await inventory.listSuppliers(db))));
  app.get('/api/products', handle(async (req, res) => res.json(await inventory.listProducts(db))));
  app.get('/api/products/:id/movements', handle(async (req, res) => res.json(await inventory.listMovements(db, req.params.id))));
  app.get('/api/backups', handle(async (req, res) => res.json(await listBackups())));

  app.post('/api/products', writeLimit, requireEditKey, handle(async (req, res) => {
    res.status(201).json(await inventory.createProduct(db, req.body));
  }));
  app.post('/api/products/:id/movements', writeLimit, requireEditKey, handle(async (req, res) => {
    res.status(201).json(await inventory.addMovement(db, req.params.id, req.body));
  }));
  app.delete('/api/products/:id', writeLimit, requireEditKey, handle(async (req, res) => {
    await inventory.deleteProduct(db, req.params.id);
    res.status(204).end();
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof ApiError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
    console.error(error);
    return res.status(500).json({ error: 'Error interno.' });
  });

  return app;
}

module.exports = { createApp };
