/**
 * Conexión a Firestore mediante el Admin SDK.
 *
 * - Producción: credencial de cuenta de servicio en FIREBASE_SERVICE_ACCOUNT
 *   (el contenido del JSON, tal cual o codificado en base64).
 * - Desarrollo y pruebas: si existe FIRESTORE_EMULATOR_HOST el SDK habla con el
 *   emulador local, que no necesita credenciales.
 */
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function parseServiceAccount(raw) {
  const text = raw.trim();
  const json = text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8');
  try {
    return JSON.parse(json);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT no contiene un JSON válido.');
  }
}

function createFirestore(env = process.env) {
  if (env.FIRESTORE_EMULATOR_HOST) {
    const projectId = env.GCLOUD_PROJECT || 'demo-stockseguro';
    console.log(`[firestore] Emulador en ${env.FIRESTORE_EMULATOR_HOST} (proyecto ${projectId})`);
    return getFirestore(initializeApp({ projectId }));
  }

  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('Falta FIREBASE_SERVICE_ACCOUNT (o FIRESTORE_EMULATOR_HOST para desarrollo local).');
  }

  const serviceAccount = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
  console.log(`[firestore] Proyecto ${serviceAccount.project_id}`);
  return getFirestore(initializeApp({ credential: cert(serviceAccount) }));
}

module.exports = { createFirestore, parseServiceAccount };
