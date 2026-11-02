#!/usr/bin/env node
/**
 * Línea de comandos de las copias de seguridad.
 *
 *   node src/backup/cli.js create  --dir backups [--type auto|full|incremental] [--label texto]
 *   node src/backup/cli.js list    --dir backups
 *   node src/backup/cli.js verify  --dir backups [--id ID]
 *   node src/backup/cli.js restore --dir backups --id ID [--mode replace|merge] [--only ruta] --confirm RESTAURAR
 *   node src/backup/cli.js wipe    --confirm DESASTRE
 *
 * Requiere BACKUP_KEY para leer o escribir copias, y las variables de src/firestore.js.
 */
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { createFirestore } = require('../firestore');
const { parseKey, listManifests } = require('./store');
const { createBackup, verifyBackup, restoreBackup } = require('./engine');
const { wipe } = require('./restore');

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: 'backups' },
    type: { type: 'string', default: 'auto' },
    label: { type: 'string' },
    id: { type: 'string' },
    mode: { type: 'string', default: 'replace' },
    only: { type: 'string' },
    confirm: { type: 'string' },
  },
});

/** Publica un valor como salida del paso de GitHub Actions. */
function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** Añade texto al resumen visible de la ejecución de GitHub Actions. */
function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

const commands = {
  async create() {
    const db = createFirestore();
    const manifest = await createBackup(db, {
      dir: args.dir, key: parseKey(process.env.BACKUP_KEY), type: args.type, label: args.label ?? null,
    });
    console.log(`Copia ${manifest.id}: ${manifest.records} registros, ${manifest.bytes} bytes, ${manifest.durationMs} ms (${manifest.reason})`);
    console.log('Conteos del origen:', manifest.counts);
    setOutput('id', manifest.id);
    setOutput('type', manifest.type);
    summary(`### Copia \`${manifest.id}\`\n\n- Tipo: ${manifest.type} (${manifest.reason})\n- Registros: ${manifest.records}\n- Tamaño cifrado: ${manifest.bytes} bytes\n- Duración: ${manifest.durationMs} ms`);
  },

  async list() {
    for (const manifest of listManifests(args.dir)) {
      console.log(`${manifest.id}  ${manifest.type.padEnd(11)}  ${String(manifest.records).padStart(6)} registros  padre: ${manifest.parent ?? '-'}`);
    }
  },

  async verify() {
    const db = createFirestore();
    const result = await verifyBackup(db, { dir: args.dir, key: parseKey(process.env.BACKUP_KEY), id: args.id });
    console.log(`Verificación de ${result.id}: ${result.documents} documentos restaurados en ${result.restoreMs} ms (cadena de ${result.chainLength})`);
    summary(`### Verificación\n\n- Restaurados en el emulador: ${result.documents} documentos en ${result.restoreMs} ms\n- Copias en la cadena: ${result.chainLength}\n- Resultado: ${result.ok ? 'correcta' : 'FALLIDA'}`);
    if (!result.ok) {
      result.problems.forEach((problem) => console.error(`- ${problem}`));
      summary(result.problems.map((problem) => `- ${problem}`).join('\n'));
      throw new Error('La copia no pasó la verificación. Si la base cambió por fuera de la app, haz una copia completa.');
    }
    console.log('La copia es correcta.');
  },

  async restore() {
    if (args.confirm !== 'RESTAURAR') throw new Error('Para restaurar, añade --confirm RESTAURAR.');
    if (!args.id) throw new Error('Indica la copia con --id.');
    const db = createFirestore();
    const result = await restoreBackup(db, {
      dir: args.dir, key: parseKey(process.env.BACKUP_KEY), id: args.id, mode: args.mode, only: args.only ?? null,
    });
    console.log(`Restaurados ${result.written} documentos de ${result.id} en ${result.restoreMs} ms (cadena de ${result.chainLength}).`);
    summary(`### Restauración\n\n- Copia: \`${result.id}\`\n- Modo: ${args.mode}${args.only ? `, solo \`${args.only}\`` : ''}\n- Documentos escritos: ${result.written}\n- Tiempo: ${result.restoreMs} ms`);
  },

  async wipe() {
    if (args.confirm !== 'DESASTRE') throw new Error('Para borrar la base, añade --confirm DESASTRE.');
    await wipe(createFirestore());
    console.log('Base de datos vaciada.');
  },
};

const command = commands[positionals[0]];
if (!command) {
  console.error(`Comando desconocido. Usa: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
command().then(() => process.exit(0)).catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
