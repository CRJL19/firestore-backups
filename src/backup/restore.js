/**
 * Escribe un estado reconstruido en Firestore.
 *
 * Modos:
 *   replace: borra lo que había y deja la base igual que en la copia.
 *   merge:   escribe los documentos de la copia y conserva todo lo demás.
 * Con only, cualquiera de los dos se limita a una ruta y lo que cuelga de ella.
 */
const { FieldValue } = require('firebase-admin/firestore');
const { decodeValue } = require('./serialize');

const META_PATH = '_backup_meta/state';

const matchesOnly = (path, only) => !only || path === only || path.startsWith(`${only}/`);

/** Borra todos los datos de negocio y las marcas de borrado. */
async function wipe(db) {
  const collections = await db.listCollections();
  for (const collection of collections) {
    if (!collection.id.startsWith('_') || collection.id === '_tombstones') {
      await db.recursiveDelete(collection);
    }
  }
}

async function clearPath(db, only) {
  const isCollectionPath = only.split('/').length % 2 === 1;
  await db.recursiveDelete(isCollectionPath ? db.collection(only) : db.doc(only));
}

async function restoreState(db, state, { mode = 'replace', only = null } = {}) {
  if (!['replace', 'merge'].includes(mode)) throw new Error(`Modo de restauración desconocido: ${mode}`);

  const paths = [...state.keys()].filter((path) => matchesOnly(path, only));
  if (only && paths.length === 0) throw new Error(`La copia no contiene nada bajo ${only}.`);

  if (mode === 'replace') {
    if (only) await clearPath(db, only);
    else await wipe(db);
  }

  const writer = db.bulkWriter();
  const errors = [];
  for (const path of paths) {
    writer.set(db.doc(path), decodeValue(state.get(path), db)).catch((error) => errors.push(`${path}: ${error.message}`));
  }
  await writer.close();
  if (errors.length > 0) {
    throw new Error(`Fallaron ${errors.length} de ${paths.length} escrituras. Primera: ${errors[0]}`);
  }

  // Los documentos restaurados conservan su updatedAt antiguo y una incremental no los
  // vería. Esta marca obliga a que la siguiente copia automática sea completa.
  await db.doc(META_PATH).set({ restoredAt: FieldValue.serverTimestamp() }, { merge: true });
  return { written: paths.length };
}

module.exports = { restoreState, wipe, META_PATH };
