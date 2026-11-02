/**
 * Pruebas de la API por HTTP real contra el emulador.
 */
const assert = require('node:assert/strict');
const { before, beforeEach, after, test } = require('node:test');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, GeoPoint, DocumentReference } = require('firebase-admin/firestore');

const { createApp } = require('../src/app');
const { createBackupLister } = require('../src/github');
const { wipe } = require('../src/backup/restore');
const { seed } = require('../src/seed');

const KEY = 'clave-de-prueba';
let db;
let server;
let base;

before(async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Estas pruebas borran datos: solo corren en el emulador.');
  db = getFirestore(initializeApp({ projectId: 'demo-stockseguro' }, 'api-tests'));
  const app = createApp({
    db,
    editKey: KEY,
    listBackups: async () => ({ configured: false, backups: [] }),
    limits: { read: 10_000, write: 10_000 },
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => wipe(db));
after(() => new Promise((resolve) => server.close(resolve)));

function call(method, url, body, key = KEY) {
  return fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Edit-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createProduct(extra = {}) {
  const response = await call('POST', '/api/products', { name: 'Teclado', sku: 'T-1', stock: 5, ...extra });
  assert.equal(response.status, 201);
  return response.json();
}

test('el health check responde', async () => {
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const ready = await fetch(`${base}/api/health/ready`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).database, 'up');
});

test('leer no necesita clave y escribir sí', async () => {
  assert.equal((await fetch(`${base}/api/products`)).status, 200);
  assert.equal((await call('POST', '/api/products', { name: 'x', sku: 'y' }, null)).status, 403);
  assert.equal((await call('POST', '/api/products', { name: 'x', sku: 'y' }, 'incorrecta')).status, 403);
  const product = await createProduct();
  assert.equal((await call('DELETE', `/api/products/${product.id}`, undefined, null)).status, 403);
  assert.equal((await call('POST', `/api/products/${product.id}/movements`, { delta: 1 }, null)).status, 403);
});

test('sin clave configurada la app queda en solo lectura', async () => {
  const app = createApp({ db, editKey: null, listBackups: async () => ({}), limits: { read: 100, write: 100 } });
  const other = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const response = await fetch(`http://127.0.0.1:${other.address().port}/api/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Edit-Key': 'cualquiera' },
    body: JSON.stringify({ name: 'x', sku: 'y' }),
  });
  assert.equal(response.status, 403);
  await new Promise((resolve) => other.close(resolve));
});

test('crea un producto con referencia y ubicación como tipos nativos', async () => {
  const supplier = await db.collection('suppliers').add({ name: 'Andina' });
  const product = await createProduct({ supplierId: supplier.id, location: { lat: -18, lng: -70 }, tags: ['a'] });
  assert.equal(product.supplierId, supplier.id);

  const stored = (await db.doc(`products/${product.id}`).get()).data();
  assert.ok(stored.supplier instanceof DocumentReference);
  assert.ok(stored.location instanceof GeoPoint);
  assert.ok(stored.updatedAt, 'updatedAt lo necesita la copia incremental');
});

test('valida los datos de entrada', async () => {
  const bad = [
    { sku: 'y' },
    { name: 'x' },
    { name: 'x', sku: 'y', stock: -1 },
    { name: 'x', sku: 'y', stock: 1.5 },
    { name: 'x', sku: 'y', tags: 'no-lista' },
    { name: 'x', sku: 'y', location: { lat: 200, lng: 0 } },
    { name: 'x', sku: 'y', supplierId: 'inexistente' },
  ];
  for (const body of bad) assert.equal((await call('POST', '/api/products', body)).status, 400, JSON.stringify(body));
});

test('un movimiento ajusta el stock y actualiza updatedAt del padre', async () => {
  const product = await createProduct();
  const before = (await db.doc(`products/${product.id}`).get()).get('updatedAt');
  await new Promise((resolve) => setTimeout(resolve, 5));

  const response = await call('POST', `/api/products/${product.id}/movements`, { delta: 3, note: 'Compra' });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).stock, 8);

  const after = (await db.doc(`products/${product.id}`).get()).get('updatedAt');
  assert.ok(after.toMillis() >= before.toMillis());
  const movements = await (await fetch(`${base}/api/products/${product.id}/movements`)).json();
  assert.equal(movements.length, 1);
  assert.equal(movements[0].note, 'Compra');
});

test('el stock nunca queda negativo, ni con salidas simultáneas', async () => {
  const product = await createProduct({ stock: 3 });
  assert.equal((await call('POST', `/api/products/${product.id}/movements`, { delta: -4 })).status, 409);

  const results = await Promise.all(
    Array.from({ length: 5 }, () => call('POST', `/api/products/${product.id}/movements`, { delta: -1 })),
  );
  assert.equal(results.filter((response) => response.status === 201).length, 3);
  assert.equal((await db.doc(`products/${product.id}`).get()).get('stock'), 0);
});

test('un movimiento inválido o sobre un producto inexistente se rechaza', async () => {
  const product = await createProduct();
  for (const delta of [0, 1.5, 'x', null]) {
    assert.equal((await call('POST', `/api/products/${product.id}/movements`, { delta })).status, 400);
  }
  assert.equal((await call('POST', '/api/products/noexiste/movements', { delta: 1 })).status, 404);
});

test('borrar elimina los movimientos y deja una marca para la copia incremental', async () => {
  const product = await createProduct();
  await call('POST', `/api/products/${product.id}/movements`, { delta: 1 });

  assert.equal((await call('DELETE', `/api/products/${product.id}`)).status, 204);
  assert.equal((await db.collection(`products/${product.id}/movements`).get()).size, 0);

  const tombstones = await db.collection('_tombstones').get();
  assert.equal(tombstones.size, 1);
  assert.equal(tombstones.docs[0].get('path'), `products/${product.id}`);
  assert.equal((await call('DELETE', `/api/products/${product.id}`)).status, 404);
});

test('los errores no filtran detalles y un id con barras no escapa de la colección', async () => {
  assert.equal((await call('DELETE', '/api/products/..%2Fsuppliers')).status, 404);
  const invalid = await fetch(`${base}/api/products`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edit-Key': KEY }, body: '{roto',
  });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(`${base}/api/nada`)).status, 404);
});

test('el sembrado no pisa una base con datos', async () => {
  const first = await seed(db);
  assert.equal(first.skipped, false);
  const count = (await db.collection('products').get()).size;
  assert.equal((await seed(db)).skipped, true);
  assert.equal((await db.collection('products').get()).size, count);
});

test('el panel lista copias, calcula su antigüedad y filtra otros artifacts', async () => {
  let now = Date.parse('2026-01-02T00:00:00Z');
  let calls = 0;
  const artifacts = [
    { name: 'backup-20260101T000000000Z-incremental', expired: false, size_in_bytes: 10, created_at: '2026-01-01T00:00:00Z', expires_at: 'x' },
    { name: 'backup-20251231T000000000Z-full', expired: false, size_in_bytes: 20, created_at: '2025-12-31T00:00:00Z', expires_at: 'x' },
    { name: 'backup-20251201T000000000Z-full', expired: true, size_in_bytes: 20, created_at: '2025-12-01T00:00:00Z', expires_at: 'x' },
    { name: 'otro-artifact', expired: false, size_in_bytes: 5, created_at: '2026-01-01T12:00:00Z', expires_at: 'x' },
  ];
  const list = createBackupLister({
    repository: 'a/b',
    now: () => now,
    fetchFn: async () => { calls += 1; return { ok: true, json: async () => ({ artifacts }) }; },
  });

  const result = await list();
  assert.deepEqual(result.backups.map((backup) => backup.type), ['incremental', 'full']);
  assert.equal(result.ageHours, 24);
  assert.equal(result.healthy, true);

  await list();
  assert.equal(calls, 1, 'la caché evita gastar el límite de la API anónima');

  now += 3 * 24 * 60 * 60 * 1000;
  assert.equal((await list()).healthy, false, 'una copia vieja se marca como incumplimiento del RPO');
  assert.equal(calls, 2);
});

test('el panel sobrevive a una caída de la API de GitHub', async () => {
  const list = createBackupLister({ repository: 'a/b', fetchFn: async () => { throw new Error('sin red'); } });
  const original = console.error;
  console.error = () => {};
  try {
    const result = await list();
    assert.equal(result.available, false);
    assert.deepEqual(result.backups, []);
  } finally {
    console.error = original;
  }
});
