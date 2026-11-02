/**
 * Pruebas del motor de copias contra el emulador de Firestore.
 * Cada prueba empieza con la base vacía y una carpeta de copias nueva.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, beforeEach, after, test } = require('node:test');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, GeoPoint, Timestamp } = require('firebase-admin/firestore');

const { parseKey, listManifests, resolveChain, mergeChain, readRecords } = require('../src/backup/store');
const { fingerprint, encodeValue, decodeValue } = require('../src/backup/serialize');
const { createBackup, verifyBackup, restoreBackup, compareCounts } = require('../src/backup/engine');
const { readState } = require('../src/backup/dump');
const { wipe, META_PATH } = require('../src/backup/restore');
const inventory = require('../src/inventory');
const { seed } = require('../src/seed');

const KEY = crypto.randomBytes(32);
const DAY = 24 * 60 * 60 * 1000;
let db;
let dir;

before(() => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Estas pruebas borran datos: solo corren en el emulador.');
  db = getFirestore(initializeApp({ projectId: 'demo-stockseguro' }, 'backup-tests'));
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backups-'));
  await wipe(db);
  await db.doc(META_PATH).delete();
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const stateOf = async () => (await readState(db)).state;
/** Fechas crecientes para que el orden de las copias sea determinista. */
const at = (days) => new Date(Date.UTC(2026, 0, 1) + days * DAY);
const backup = (options) => createBackup(db, { dir, key: KEY, ...options });

async function product(name = 'Producto', stock = 10) {
  return inventory.createProduct(db, { name, sku: name.slice(0, 5), stock });
}

test('la copia conserva cada tipo de dato de Firestore', async () => {
  const supplier = db.doc('suppliers/s1');
  await supplier.set({ name: 'S', updatedAt: Timestamp.now() });
  await db.doc('products/p1').set({
    text: 'ñandú', int: 7, float: 1.5, bool: false, nothing: null,
    when: new Timestamp(1700000000, 123456000),
    where: new GeoPoint(-18.01, -70.25),
    ref: supplier,
    blob: Buffer.from([0, 1, 254, 255]),
    list: [1, 'dos', { tres: new Timestamp(5, 0) }],
    nested: { deep: { deeper: new GeoPoint(1, 2) } },
    dollar: { $ts: 'esto es un texto del usuario, no una etiqueta' },
    updatedAt: Timestamp.now(),
  });
  const before = await stateOf();

  const manifest = await backup({ type: 'full' });
  await wipe(db);
  assert.equal((await stateOf()).size, 0);
  await restoreBackup(db, { dir, key: KEY, id: manifest.id, mode: 'replace' });

  const data = (await db.doc('products/p1').get()).data();
  assert.ok(data.when instanceof Timestamp, 'Timestamp');
  assert.equal(data.when.nanoseconds, 123456000);
  assert.ok(data.where instanceof GeoPoint, 'GeoPoint');
  assert.equal(data.ref.path, 'suppliers/s1');
  assert.deepEqual([...data.blob], [0, 1, 254, 255]);
  assert.ok(data.list[2].tres instanceof Timestamp);
  assert.ok(data.nested.deep.deeper instanceof GeoPoint);
  assert.equal(data.dollar.$ts, 'esto es un texto del usuario, no una etiqueta');
  assert.equal(fingerprint(await stateOf()), fingerprint(before));
});

test('un tipo desconocido hace fallar la copia en lugar de perder el dato', () => {
  class Rare {}
  assert.throws(() => encodeValue({ value: new Rare() }), /no soportado/);
});

test('los valores no finitos sobreviven a JSON', () => {
  const decoded = decodeValue(JSON.parse(JSON.stringify(encodeValue({ a: NaN, b: Infinity }))), db);
  assert.ok(Number.isNaN(decoded.a));
  assert.equal(decoded.b, Infinity);
});

test('la copia completa incluye subcolecciones bajo documentos fantasma', async () => {
  // El padre no existe, pero su subcolección sí: un collection.get() no la encontraría.
  await db.doc('products/fantasma/movements/m1').set({ delta: 1, updatedAt: Timestamp.now() });
  assert.equal((await db.collection('products').get()).size, 0);

  const manifest = await backup({ type: 'full' });
  assert.equal(manifest.counts.movements, 1);

  await wipe(db);
  await restoreBackup(db, { dir, key: KEY, id: manifest.id, mode: 'replace' });
  assert.ok((await db.doc('products/fantasma/movements/m1').get()).exists);
});

test('las colecciones internas no entran en la copia', async () => {
  await seed(db);
  const victim = (await inventory.listProducts(db))[0];
  await inventory.deleteProduct(db, victim.id);
  const manifest = await backup({ type: 'full' });
  assert.deepEqual(Object.keys(manifest.counts).sort(), ['movements', 'products', 'suppliers']);
  assert.ok(readRecords(dir, manifest, KEY).every((record) => !record.p.startsWith('_')));
});

test('la cadena completa e incrementales reproduce altas, cambios y borrados', async () => {
  const keep = await product('Queda');
  const gone = await product('Se borra');
  await inventory.addMovement(db, gone.id, { delta: 1 });
  const full = await backup({ type: 'full', now: at(0) });

  const added = await product('Nuevo');
  await inventory.addMovement(db, keep.id, { delta: 5, note: 'cambio' });
  const first = await backup({ type: 'incremental', now: at(1) });

  await inventory.deleteProduct(db, gone.id);
  const second = await backup({ type: 'incremental', now: at(2) });

  assert.equal(first.parent, full.id);
  assert.equal(second.parent, first.id);
  assert.ok(first.records < full.records + 10);

  const expected = await stateOf();
  const result = await verifyBackup(db, { dir, key: KEY, id: second.id });
  assert.deepEqual(result.problems, []);
  assert.equal(result.chainLength, 3);

  const restored = await stateOf();
  assert.equal(fingerprint(restored), fingerprint(expected));
  assert.ok(restored.has(`products/${added.id}`));
  assert.ok(!restored.has(`products/${gone.id}`));
  assert.ok(![...restored.keys()].some((key) => key.startsWith(`products/${gone.id}/`)), 'los movimientos también se borran');
  assert.equal(restored.get(`products/${keep.id}`).stock, 15);
});

test('una incremental lee menos que una completa', async () => {
  await seed(db);
  const full = await backup({ type: 'full', now: at(0) });
  // Salimos de la ventana de solapamiento moviendo la copia padre al futuro cercano.
  const manifestPath = path.join(dir, full.id, 'manifest.json');
  const stored = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  stored.readTime.seconds += 3600;
  fs.writeFileSync(manifestPath, JSON.stringify(stored));

  const incremental = await backup({ type: 'incremental', now: at(1) });
  assert.equal(incremental.records, 0);
  assert.ok(full.records > 0);
  assert.equal(incremental.counts.products, full.counts.products, 'los conteos reales se registran igual');
});

test('se puede restaurar a un punto intermedio de la cadena', async () => {
  await product('A');
  const full = await backup({ type: 'full', now: at(0) });
  const b = await product('B');
  const middle = await backup({ type: 'incremental', now: at(1) });
  await product('C');
  await backup({ type: 'incremental', now: at(2) });

  await restoreBackup(db, { dir, key: KEY, id: middle.id, mode: 'replace' });
  const names = (await inventory.listProducts(db)).map((item) => item.name);
  assert.deepEqual(names, ['A', 'B']);
  assert.ok(full.id && b.id);
});

test('la verificación detecta un borrado hecho por fuera de la app', async () => {
  const a = await product('A');
  await product('B');
  await backup({ type: 'full', now: at(0) });

  // Borrado directo, sin marca: la incremental no puede verlo, pero los conteos sí.
  await db.doc(`products/${a.id}`).delete();
  const incremental = await backup({ type: 'incremental', now: at(1) });

  const result = await verifyBackup(db, { dir, key: KEY, id: incremental.id });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /products: la copia dice 1 y la restauración tiene 2/);
});

test('una copia completa posterior resuelve esa desviación', async () => {
  const a = await product('A');
  await backup({ type: 'full', now: at(0) });
  await db.doc(`products/${a.id}`).delete();
  await product('B');
  const full = await backup({ type: 'full', now: at(1) });
  const result = await verifyBackup(db, { dir, key: KEY, id: full.id });
  assert.deepEqual(result.problems, []);
});

test('la verificación se niega a correr fuera del emulador', async () => {
  await product();
  const manifest = await backup({ type: 'full' });
  await assert.rejects(verifyBackup(db, { dir, key: KEY, id: manifest.id, env: {} }), /solo se ejecuta contra el emulador/);
  assert.equal((await inventory.listProducts(db)).length, 1, 'no borró nada');
});

test('la restauración selectiva recupera un producto sin tocar el resto', async () => {
  const lost = await product('Perdido');
  await inventory.addMovement(db, lost.id, { delta: 3 });
  const other = await product('Otro', 1);
  const manifest = await backup({ type: 'full', now: at(0) });

  await inventory.addMovement(db, other.id, { delta: 8 });
  await inventory.deleteProduct(db, lost.id);

  const result = await restoreBackup(db, { dir, key: KEY, id: manifest.id, mode: 'replace', only: `products/${lost.id}` });
  assert.equal(result.written, 2, 'el producto y su movimiento');

  const items = await inventory.listProducts(db);
  assert.equal(items.find((item) => item.name === 'Perdido').stock, 13);
  assert.equal(items.find((item) => item.name === 'Otro').stock, 9, 'el cambio posterior sigue ahí');
});

test('la restauración selectiva avisa si la ruta no está en la copia', async () => {
  await product();
  const manifest = await backup({ type: 'full' });
  await assert.rejects(restoreBackup(db, { dir, key: KEY, id: manifest.id, only: 'products/nada' }), /no contiene nada/);
});

test('el modo merge conserva lo que la copia no conoce', async () => {
  await product('Viejo');
  const manifest = await backup({ type: 'full' });
  await product('Posterior');
  await restoreBackup(db, { dir, key: KEY, id: manifest.id, mode: 'merge' });
  assert.equal((await inventory.listProducts(db)).length, 2);

  await restoreBackup(db, { dir, key: KEY, id: manifest.id, mode: 'replace' });
  assert.deepEqual((await inventory.listProducts(db)).map((item) => item.name), ['Viejo']);
});

test('tras restaurar, la siguiente copia automática es completa', async () => {
  await product();
  const first = await backup({ type: 'auto', now: at(0) });
  assert.equal(first.type, 'full');

  const second = await backup({ type: 'auto', now: at(1) });
  assert.equal(second.type, 'incremental');

  await restoreBackup(db, { dir, key: KEY, id: first.id, mode: 'replace' });
  const third = await backup({ type: 'auto', now: at(2) });
  assert.equal(third.type, 'full');
  assert.match(third.reason, /restauración/);
});

test('la copia automática vuelve a ser completa a los 7 días', async () => {
  await product();
  await backup({ type: 'auto', now: at(0) });
  assert.equal((await backup({ type: 'auto', now: at(6) })).type, 'incremental');
  assert.equal((await backup({ type: 'auto', now: at(7) })).type, 'full');
});

test('una copia etiquetada no entra en la cadena automática', async () => {
  await product();
  const full = await backup({ type: 'auto', now: at(0) });
  await backup({ type: 'full', label: 'prerestore', now: at(1) });
  const next = await backup({ type: 'auto', now: at(2) });
  assert.equal(next.parent, full.id);
});

test('una cadena con un eslabón ausente se rechaza con un mensaje claro', async () => {
  await product();
  const full = await backup({ type: 'full', now: at(0) });
  const inc = await backup({ type: 'incremental', now: at(1) });
  fs.rmSync(path.join(dir, full.id), { recursive: true });
  assert.throws(() => resolveChain(listManifests(dir), inc.id), /Cadena rota/);
});

test('el contenido en disco está cifrado', async () => {
  await product('SecretoVisible');
  const manifest = await backup({ type: 'full' });
  const file = fs.readFileSync(path.join(dir, manifest.id, 'data.enc'));
  assert.ok(!file.includes('SecretoVisible'));
  assert.ok(!fs.readFileSync(path.join(dir, manifest.id, 'manifest.json'), 'utf8').includes('SecretoVisible'));
});

test('una clave incorrecta no puede leer la copia', async () => {
  await product();
  const manifest = await backup({ type: 'full' });
  assert.throws(() => readRecords(dir, manifest, crypto.randomBytes(32)), /clave incorrecta o archivo alterado/);
});

test('un archivo alterado se detecta', async () => {
  await product();
  const manifest = await backup({ type: 'full' });
  const file = path.join(dir, manifest.id, 'data.enc');
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  assert.throws(() => readRecords(dir, manifest, KEY), /está dañada/);
});

test('no se puede cambiar el data.enc de una copia por el de otra', async () => {
  await product('A');
  const one = await backup({ type: 'full', now: at(0) });
  await product('B');
  const two = await backup({ type: 'full', now: at(1) });

  // Incluso ajustando el SHA-256 del manifiesto, el descifrado autenticado lo rechaza.
  const stolen = fs.readFileSync(path.join(dir, one.id, 'data.enc'));
  fs.writeFileSync(path.join(dir, two.id, 'data.enc'), stolen);
  const forged = { ...two, sha256: crypto.createHash('sha256').update(stolen).digest('hex') };
  assert.throws(() => readRecords(dir, forged, KEY), /clave incorrecta o archivo alterado/);
});

test('una clave con el tamaño equivocado se rechaza', () => {
  assert.throws(() => parseKey('corta'), /32 bytes/);
  assert.equal(parseKey(crypto.randomBytes(32).toString('base64')).length, 32);
});

test('escribir durante la copia no rompe su verificación', async () => {
  await seed(db);
  const items = await inventory.listProducts(db);
  const writes = Promise.all(items.map((item) => inventory.addMovement(db, item.id, { delta: 1, note: 'durante la copia' })));
  const manifest = await backup({ type: 'full' });
  await writes;

  const result = await verifyBackup(db, { dir, key: KEY, id: manifest.id });
  assert.deepEqual(result.problems, []);
});

test('el conteo compara en ambos sentidos', () => {
  assert.deepEqual(compareCounts({ a: 1 }, { a: 1 }), []);
  assert.equal(compareCounts({ a: 1 }, {}).length, 1);
  assert.equal(compareCounts({}, { b: 1 }).length, 1);
});

test('mergeChain da prioridad al documento sobre un borrado de la misma copia', async () => {
  const ref = db.doc('products/recreado');
  await ref.set({ name: 'v1', updatedAt: Timestamp.now() });
  await backup({ type: 'full', now: at(0) });

  // Se borra y se vuelve a crear con el mismo id entre dos copias.
  const tombstone = crypto.createHash('sha256').update(ref.path).digest('hex');
  await db.collection('_tombstones').doc(tombstone).set({ path: ref.path, deletedAt: FieldValue.serverTimestamp() });
  await ref.set({ name: 'v2', updatedAt: FieldValue.serverTimestamp() });
  const incremental = await backup({ type: 'incremental', now: at(1) });

  const state = mergeChain(dir, resolveChain(listManifests(dir), incremental.id), KEY);
  assert.equal(state.get(ref.path).name, 'v2');
});
