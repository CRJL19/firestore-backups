/**
 * Lee Firestore para hacer copias completas o incrementales.
 *
 * Todas las lecturas de documentos van dentro de una transacción de solo lectura,
 * de modo que la copia representa un único instante aunque la app siga escribiendo.
 *
 * Contrato de la copia incremental, que la app debe respetar:
 *   1. Todo documento lleva updatedAt, actualizado en cada escritura.
 *   2. Cambiar una subcolección también actualiza updatedAt del documento padre.
 *   3. Cada borrado deja una marca en _tombstones.
 * Las escrituras hechas por fuera de la app no cumplen este contrato. Por eso cada
 * copia guarda además los conteos reales, que la verificación compara después.
 */
const { Timestamp } = require('firebase-admin/firestore');
const { encodeValue } = require('./serialize');

// Colecciones internas: no son datos de negocio y no se copian.
const isInternal = (collection) => collection.id.startsWith('_');

// Un documento escrito justo antes de la copia anterior podría no haber sido visible
// para ella. Copiar de más es inofensivo porque restaurar es idempotente.
const OVERLAP_SECONDS = 300;

async function rootCollections(db) {
  return (await db.listCollections()).filter((collection) => !isInternal(collection));
}

const toRecord = (doc) => ({ k: 'doc', p: doc.ref.path, d: encodeValue(doc.data()) });

function collectionIdOf(docPath) {
  const parts = docPath.split('/');
  return parts[parts.length - 2];
}

/** Copia completa: todos los documentos, a cualquier profundidad. */
async function dumpFull(db) {
  const roots = await rootCollections(db);
  return db.runTransaction(async (transaction) => {
    const records = [];
    const counts = {};
    let readTime = null;
    let apiCalls = 0;

    async function walk(collection) {
      const snapshot = await transaction.get(collection);
      readTime ??= snapshot.readTime;
      apiCalls += 1;
      for (const doc of snapshot.docs) {
        records.push(toRecord(doc));
        counts[collection.id] = (counts[collection.id] ?? 0) + 1;
      }
      // listDocuments, y no snapshot.docs: incluye los documentos "fantasma", que no
      // existen pero conservan subcolecciones. Un recorrido ingenuo los perdería.
      const refs = await collection.listDocuments();
      apiCalls += 1;
      for (const ref of refs) {
        const subcollections = await ref.listCollections();
        apiCalls += 1;
        for (const subcollection of subcollections) await walk(subcollection);
      }
    }

    for (const root of roots) await walk(root);
    return { records, counts, readTime: readTime ?? Timestamp.now(), apiCalls };
  }, { readOnly: true });
}

/** Copia incremental: lo cambiado desde la copia padre, más los borrados. */
async function dumpIncremental(db, parent, knownCollectionIds = []) {
  const since = new Timestamp(parent.readTime.seconds - OVERLAP_SECONDS, parent.readTime.nanoseconds);
  const roots = await rootCollections(db);

  return db.runTransaction(async (transaction) => {
    const records = [];
    const seen = new Set(knownCollectionIds);
    let readTime = null;
    let apiCalls = 0;

    async function walk(collection) {
      seen.add(collection.id);
      const snapshot = await transaction.get(collection.where('updatedAt', '>=', since));
      readTime ??= snapshot.readTime;
      apiCalls += 1;
      for (const doc of snapshot.docs) {
        records.push(toRecord(doc));
        const subcollections = await doc.ref.listCollections();
        apiCalls += 1;
        for (const subcollection of subcollections) await walk(subcollection);
      }
    }

    for (const root of roots) await walk(root);

    const tombstones = await transaction.get(db.collection('_tombstones').where('deletedAt', '>=', since));
    apiCalls += 1;
    for (const doc of tombstones.docs) {
      records.push({ k: 'del', p: doc.get('path'), at: encodeValue(doc.get('deletedAt')) });
    }

    // Conteo real del origen, con agregaciones: cuesta 1 lectura por cada 1000 documentos.
    const counts = {};
    for (const id of [...seen].sort()) {
      const result = await transaction.get(db.collectionGroup(id).count());
      apiCalls += 1;
      const total = result.data().count;
      if (total > 0) counts[id] = total;
    }
    return { records, counts, readTime: readTime ?? tombstones.readTime, apiCalls };
  }, { readOnly: true });
}

/** Estado actual de la base como Map de ruta -> documento codificado. */
async function readState(db) {
  const { records, counts } = await dumpFull(db);
  return { state: new Map(records.map((record) => [record.p, record.d])), counts };
}

module.exports = { dumpFull, dumpIncremental, readState, collectionIdOf, OVERLAP_SECONDS };
