/**
 * Modelo del inventario.
 *
 *   suppliers/{id}                   name
 *   products/{id}                    name, sku, stock, tags, location (GeoPoint),
 *                                    supplier (referencia), movementCount, updatedAt
 *   products/{id}/movements/{id}     delta, note, updatedAt
 *   _tombstones/{hash}               path, deletedAt
 *
 * Las escrituras cumplen el contrato que necesita la copia incremental: mantienen
 * updatedAt, actualizan al padre al cambiar una subcolección y marcan los borrados.
 */
const crypto = require('node:crypto');
const { FieldValue, GeoPoint, Timestamp } = require('firebase-admin/firestore');

const TOMBSTONE_DAYS = 30;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, `${field} es obligatorio.`);
  if (value.trim().length > max) throw new ApiError(400, `${field} admite hasta ${max} caracteres.`);
  return value.trim();
}

function validId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ApiError(404, 'No existe.');
  return id;
}

const toIso = (time) => (time ? time.toDate().toISOString() : null);

function productToJson(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    name: data.name,
    sku: data.sku,
    stock: data.stock,
    tags: data.tags ?? [],
    location: data.location ? { lat: data.location.latitude, lng: data.location.longitude } : null,
    supplierId: data.supplier ? data.supplier.id : null,
    movementCount: data.movementCount ?? 0,
    updatedAt: toIso(data.updatedAt),
  };
}

async function listSuppliers(db) {
  const snapshot = await db.collection('suppliers').orderBy('name').limit(100).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, name: doc.get('name') }));
}

async function listProducts(db) {
  const snapshot = await db.collection('products').orderBy('name').limit(100).get();
  return snapshot.docs.map(productToJson);
}

async function createProduct(db, body) {
  const name = text(body?.name, 'El nombre', 80);
  const sku = text(body?.sku, 'El SKU', 30);
  const stock = body?.stock ?? 0;
  if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) throw new ApiError(400, 'El stock debe ser un entero entre 0 y 1000000.');

  const tags = body?.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 10 || tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 30)) {
    throw new ApiError(400, 'Las etiquetas deben ser hasta 10 textos cortos.');
  }

  const data = { name, sku, stock, tags: tags.map((tag) => tag.trim()), movementCount: 0, updatedAt: FieldValue.serverTimestamp() };

  if (body?.supplierId) {
    const supplier = db.collection('suppliers').doc(validId(body.supplierId));
    if (!(await supplier.get()).exists) throw new ApiError(400, 'El proveedor no existe.');
    data.supplier = supplier;
  }
  if (body?.location) {
    const { lat, lng } = body.location;
    if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new ApiError(400, 'La ubicación no es válida.');
    }
    data.location = new GeoPoint(lat, lng);
  }

  const ref = await db.collection('products').add(data);
  return productToJson(await ref.get());
}

/** Una transacción, porque hay que leer el stock para impedir que quede negativo. */
async function addMovement(db, productId, body) {
  const delta = body?.delta;
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100_000) {
    throw new ApiError(400, 'La cantidad debe ser un entero distinto de cero.');
  }
  const note = body?.note ? text(body.note, 'La nota', 120) : '';
  const ref = db.collection('products').doc(validId(productId));

  await db.runTransaction(async (transaction) => {
    const product = await transaction.get(ref);
    if (!product.exists) throw new ApiError(404, 'El producto no existe.');
    if (product.get('stock') + delta < 0) throw new ApiError(409, 'No hay stock suficiente.');
    const now = FieldValue.serverTimestamp();
    transaction.create(ref.collection('movements').doc(), { delta, note, updatedAt: now });
    transaction.update(ref, {
      stock: FieldValue.increment(delta),
      movementCount: FieldValue.increment(1),
      updatedAt: now,
    });
  });
  return productToJson(await ref.get());
}

async function listMovements(db, productId) {
  const ref = db.collection('products').doc(validId(productId));
  const snapshot = await ref.collection('movements').orderBy('updatedAt', 'desc').limit(50).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, delta: doc.get('delta'), note: doc.get('note'), at: toIso(doc.get('updatedAt')) }));
}

/** Borra el producto con sus movimientos y deja la marca que verá la copia incremental. */
async function deleteProduct(db, productId) {
  const ref = db.collection('products').doc(validId(productId));
  if (!(await ref.get()).exists) throw new ApiError(404, 'El producto no existe.');

  const tombstoneId = crypto.createHash('sha256').update(ref.path).digest('hex');
  const batch = db.batch();
  batch.set(db.collection('_tombstones').doc(tombstoneId), { path: ref.path, deletedAt: FieldValue.serverTimestamp() });
  batch.delete(ref);
  await batch.commit();
  await db.recursiveDelete(ref);
  await purgeOldTombstones(db);
}

/** Una marca solo sirve hasta que la recoge una copia, así que las antiguas se eliminan. */
async function purgeOldTombstones(db) {
  const limit = Timestamp.fromMillis(Date.now() - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000);
  const old = await db.collection('_tombstones').where('deletedAt', '<', limit).limit(100).get();
  if (old.empty) return;
  const batch = db.batch();
  old.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

module.exports = { ApiError, listSuppliers, listProducts, createProduct, addMovement, listMovements, deleteProduct };
