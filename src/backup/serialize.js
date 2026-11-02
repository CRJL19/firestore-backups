/**
 * Convierte documentos de Firestore a JSON sin perder sus tipos.
 *
 * JSON.stringify convertiría un Timestamp, un GeoPoint o una referencia en un
 * objeto corriente, y al restaurar ya no serían esos tipos. Por eso cada tipo
 * especial se etiqueta. Un tipo desconocido lanza un error: es preferible que
 * falle la copia a que parezca correcta y le falten datos.
 */
const crypto = require('node:crypto');
const { Timestamp, GeoPoint, DocumentReference } = require('firebase-admin/firestore');

function encodeValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $num: String(value) };
  if (value instanceof Timestamp) return { $ts: [value.seconds, value.nanoseconds] };
  if (value instanceof GeoPoint) return { $geo: [value.latitude, value.longitude] };
  if (value instanceof DocumentReference) return { $ref: value.path };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(encodeValue);

  const prototype = value === undefined ? undefined : Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    const out = {};
    let hasReservedKey = false;
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('$')) hasReservedKey = true;
      out[key] = encodeValue(item);
    }
    // Un mapa del usuario con claves "$..." no debe confundirse con una etiqueta.
    return hasReservedKey ? { $map: out } : out;
  }
  throw new TypeError(`Tipo de Firestore no soportado por la copia: ${value?.constructor?.name ?? typeof value}`);
}

function decodeValue(value, db) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => decodeValue(item, db));
  if ('$num' in value) return Number(value.$num);
  if ('$ts' in value) return new Timestamp(value.$ts[0], value.$ts[1]);
  if ('$geo' in value) return new GeoPoint(value.$geo[0], value.$geo[1]);
  if ('$ref' in value) return db.doc(value.$ref);
  if ('$bytes' in value) return Buffer.from(value.$bytes, 'base64');
  const source = '$map' in value ? value.$map : value;
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, decodeValue(item, db)]));
}

/** JSON con las claves ordenadas: el mismo contenido siempre da el mismo texto. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Huella del estado completo. state es un Map de ruta -> documento codificado. */
function fingerprint(state) {
  const hash = crypto.createHash('sha256');
  for (const path of [...state.keys()].sort()) {
    hash.update(path).update('\0').update(canonical(state.get(path))).update('\n');
  }
  return hash.digest('hex');
}

module.exports = { encodeValue, decodeValue, canonical, fingerprint };
