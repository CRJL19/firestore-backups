/**
 * Almacén de copias: cada una es una carpeta con manifest.json y data.enc.
 *
 * data.enc = NDJSON -> gzip -> AES-256-GCM. El manifiesto queda en claro para
 * poder resolver la cadena sin la clave, pero no contiene datos de negocio.
 * Las copias viven en artifacts de un repositorio público, que cualquier usuario
 * con sesión en GitHub puede descargar: el cifrado no es opcional.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const IV_BYTES = 12;
const TAG_BYTES = 16;

function parseKey(raw) {
  const key = Buffer.from(String(raw ?? '').trim(), 'base64');
  if (key.length !== 32) {
    throw new Error('BACKUP_KEY debe ser de 32 bytes en base64. Genera una con: openssl rand -base64 32');
  }
  return key;
}

/** Enlaza los datos con su identidad: no se puede cambiar un data.enc por el de otra copia. */
function additionalData(manifest) {
  return Buffer.from(`${manifest.id}|${manifest.type}|${manifest.parent ?? ''}`);
}

function encrypt(plain, key, manifest) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additionalData(manifest));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(file, key, manifest) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, file.subarray(0, IV_BYTES));
  decipher.setAAD(additionalData(manifest));
  decipher.setAuthTag(file.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(file.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    throw new Error(`No se pudo descifrar ${manifest.id}: clave incorrecta o archivo alterado.`);
  }
}

function writeBackup(dir, manifest, records, key) {
  const ndjson = records.map((record) => JSON.stringify(record)).join('\n');
  const file = encrypt(zlib.gzipSync(ndjson), key, manifest);
  const complete = {
    ...manifest,
    records: records.length,
    bytes: file.length,
    sha256: crypto.createHash('sha256').update(file).digest('hex'),
  };
  const folder = path.join(dir, manifest.id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'data.enc'), file);
  fs.writeFileSync(path.join(folder, 'manifest.json'), `${JSON.stringify(complete, null, 2)}\n`);
  return complete;
}

function readRecords(dir, manifest, key) {
  const file = fs.readFileSync(path.join(dir, manifest.id, 'data.enc'));
  const sha256 = crypto.createHash('sha256').update(file).digest('hex');
  if (sha256 !== manifest.sha256) throw new Error(`La copia ${manifest.id} está dañada: el SHA-256 no coincide.`);
  const ndjson = zlib.gunzipSync(decrypt(file, key, manifest)).toString('utf8');
  return ndjson ? ndjson.split('\n').map((line) => JSON.parse(line)) : [];
}

/** Manifiestos ordenados del más antiguo al más reciente. */
function listManifests(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'manifest.json')))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(dir, entry.name, 'manifest.json'), 'utf8')))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Devuelve [completa, incremental, ..., id]. Falla si falta un eslabón. */
function resolveChain(manifests, id) {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const chain = [];
  let current = byId.get(id);
  if (!current) throw new Error(`No existe la copia ${id}.`);
  while (current) {
    chain.unshift(current);
    if (current.type === 'full') return chain;
    const parent = byId.get(current.parent);
    if (!parent) throw new Error(`Cadena rota: falta ${current.parent}, de la que depende ${current.id}.`);
    current = parent;
  }
  throw new Error(`La copia ${id} no tiene una copia completa de origen.`);
}

/**
 * Reconstruye el estado aplicando la cadena en orden. Dentro de cada copia los
 * borrados van antes que los documentos: un documento presente en la copia
 * existía al hacerla, así que siempre gana al borrado.
 */
function mergeChain(dir, chain, key) {
  const state = new Map();
  for (const manifest of chain) {
    const records = readRecords(dir, manifest, key);
    for (const record of records) {
      if (record.k !== 'del') continue;
      for (const existing of [...state.keys()]) {
        if (existing === record.p || existing.startsWith(`${record.p}/`)) state.delete(existing);
      }
    }
    for (const record of records) {
      if (record.k === 'doc') state.set(record.p, record.d);
    }
  }
  return state;
}

module.exports = { parseKey, writeBackup, readRecords, listManifests, resolveChain, mergeChain };
