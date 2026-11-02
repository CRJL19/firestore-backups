/**
 * Operaciones de alto nivel: hacer, verificar y restaurar copias.
 */
const { Timestamp } = require('firebase-admin/firestore');
const { fingerprint } = require('./serialize');
const { writeBackup, listManifests, resolveChain, mergeChain } = require('./store');
const { dumpFull, dumpIncremental, readState } = require('./dump');
const { restoreState, wipe, META_PATH } = require('./restore');

const FULL_EVERY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const timestampToJson = (time) => ({ seconds: time.seconds, nanoseconds: time.nanoseconds });
const makeId = (date, type, label) => {
  const stamp = date.toISOString().replace(/[-:.]/g, '');
  return [stamp, type, label].filter(Boolean).join('-');
};

/** La cadena automática ignora las copias con etiqueta, como las previas a una restauración. */
const regularBackups = (manifests) => manifests.filter((manifest) => !manifest.label);

/** Decide el tipo de la copia automática y explica por qué. */
async function chooseType(db, manifests, now) {
  const regular = regularBackups(manifests);
  const last = regular.at(-1);
  if (!last) return { type: 'full', reason: 'no hay copias anteriores' };

  const meta = await db.doc(META_PATH).get();
  const restoredAt = meta.exists ? meta.get('restoredAt') : null;
  if (restoredAt && restoredAt.seconds >= last.readTime.seconds) {
    return { type: 'full', reason: 'hubo una restauración después de la última copia' };
  }

  const lastFull = regular.filter((manifest) => manifest.type === 'full').at(-1);
  if (!lastFull) return { type: 'full', reason: 'no hay una copia completa de origen' };
  if (now - new Date(lastFull.createdAt) >= FULL_EVERY_DAYS * DAY_MS) {
    return { type: 'full', reason: `la última completa tiene ${FULL_EVERY_DAYS} días o más` };
  }
  return { type: 'incremental', reason: 'hay una cadena vigente' };
}

async function createBackup(db, { dir, key, type = 'auto', label = null, now = new Date() }) {
  const manifests = listManifests(dir);
  const startedAt = Date.now();

  let reason = 'solicitada de forma explícita';
  let finalType = type;
  if (type === 'auto') ({ type: finalType, reason } = await chooseType(db, manifests, now));

  let parent = null;
  let dump;
  if (finalType === 'full') {
    dump = await dumpFull(db);
  } else if (finalType === 'incremental') {
    parent = regularBackups(manifests).at(-1);
    if (!parent) throw new Error('Una copia incremental necesita una copia anterior.');
    dump = await dumpIncremental(db, parent, Object.keys(parent.counts));
  } else {
    throw new Error(`Tipo de copia desconocido: ${finalType}`);
  }

  const id = makeId(now, finalType, label);
  const manifest = {
    format: 1,
    id,
    type: finalType,
    parent: parent ? parent.id : null,
    label,
    reason,
    createdAt: now.toISOString(),
    readTime: timestampToJson(dump.readTime),
    counts: dump.counts,
    apiCalls: dump.apiCalls,
    durationMs: Date.now() - startedAt,
    cipher: 'aes-256-gcm',
    compression: 'gzip',
    // Solo la completa puede calcular la huella del estado sin releer toda la base.
    fingerprint: finalType === 'full'
      ? fingerprint(new Map(dump.records.map((record) => [record.p, record.d])))
      : null,
  };
  return writeBackup(dir, manifest, dump.records, key);
}

function compareCounts(expected, actual) {
  const ids = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...ids].sort().flatMap((id) => (
    (expected[id] ?? 0) === (actual[id] ?? 0)
      ? []
      : [`${id}: la copia dice ${expected[id] ?? 0} y la restauración tiene ${actual[id] ?? 0}`]
  ));
}

/**
 * Restaura en una base desechable y comprueba el resultado. Solo se permite contra el
 * emulador: esta operación empieza borrando todo lo que encuentra.
 */
async function verifyBackup(db, { dir, key, id, env = process.env }) {
  if (!env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('La verificación borra la base de destino: solo se ejecuta contra el emulador.');
  }
  const manifests = listManifests(dir);
  const chain = resolveChain(manifests, id ?? manifests.at(-1)?.id);
  const target = chain.at(-1);
  const expected = mergeChain(dir, chain, key);

  const startedAt = Date.now();
  await wipe(db);
  await restoreState(db, expected, { mode: 'replace' });
  const restoreMs = Date.now() - startedAt;

  const { state, counts } = await readState(db);
  const problems = compareCounts(target.counts, counts);
  const expectedPrint = fingerprint(expected);
  const actualPrint = fingerprint(state);
  if (expectedPrint !== actualPrint) problems.push('la huella de lo restaurado no coincide con la de la copia');
  if (target.fingerprint && target.fingerprint !== actualPrint) {
    problems.push('la huella de lo restaurado no coincide con la tomada del origen');
  }
  return { id: target.id, chainLength: chain.length, documents: state.size, restoreMs, fingerprint: actualPrint, ok: problems.length === 0, problems };
}

async function restoreBackup(db, { dir, key, id, mode, only }) {
  const manifests = listManifests(dir);
  const chain = resolveChain(manifests, id);
  const startedAt = Date.now();
  const { written } = await restoreState(db, mergeChain(dir, chain, key), { mode, only });
  return { id, chainLength: chain.length, written, restoreMs: Date.now() - startedAt };
}

module.exports = { createBackup, verifyBackup, restoreBackup, chooseType, compareCounts, Timestamp };
