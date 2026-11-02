/**
 * Datos de demostración. Se niega a actuar si la base ya tiene productos.
 * Usa a propósito todos los tipos que una copia ingenua perdería.
 */
const { FieldValue, GeoPoint } = require('firebase-admin/firestore');
const { createFirestore } = require('./firestore');

const SUPPLIERS = ['Andina Tech', 'Sur Logística', 'Tacna Insumos'];
const PRODUCTS = [
  ['Laptop 14 pulgadas', 'LAP-014', 12, ['computo'], [-18.0146, -70.2536]],
  ['Monitor 24 pulgadas', 'MON-024', 30, ['computo', 'pantallas'], [-18.0146, -70.2536]],
  ['Teclado mecánico', 'TEC-101', 45, ['perifericos'], [-16.409, -71.5375]],
  ['Mouse inalámbrico', 'MOU-202', 60, ['perifericos'], [-16.409, -71.5375]],
  ['Disco SSD 1 TB', 'SSD-001', 25, ['almacenamiento'], [-12.0464, -77.0428]],
  ['Memoria RAM 16 GB', 'RAM-016', 40, ['componentes'], [-12.0464, -77.0428]],
  ['Router Wi-Fi 6', 'RTR-006', 18, ['redes'], [-18.0146, -70.2536]],
  ['Switch de 24 puertos', 'SWT-024', 9, ['redes'], [-16.409, -71.5375]],
];

async function seed(db) {
  const existing = await db.collection('products').limit(1).get();
  if (!existing.empty) return { skipped: true };

  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  const suppliers = SUPPLIERS.map((name) => {
    const ref = db.collection('suppliers').doc();
    batch.set(ref, { name, updatedAt: now });
    return ref;
  });

  let movements = 0;
  PRODUCTS.forEach(([name, sku, stock, tags, [lat, lng]], index) => {
    const ref = db.collection('products').doc();
    const entries = [Math.ceil(stock / 2), Math.floor(stock / 2)].filter(Boolean);
    entries.forEach((delta, order) => {
      batch.set(ref.collection('movements').doc(), { delta, note: order === 0 ? 'Compra inicial' : 'Reposición', updatedAt: now });
    });
    movements += entries.length;
    batch.set(ref, {
      name,
      sku,
      stock,
      tags,
      location: new GeoPoint(lat, lng),
      supplier: suppliers[index % suppliers.length],
      movementCount: entries.length,
      updatedAt: now,
    });
  });
  await batch.commit();
  return { skipped: false, suppliers: suppliers.length, products: PRODUCTS.length, movements };
}

if (require.main === module) {
  seed(createFirestore())
    .then((result) => {
      console.log(result.skipped ? 'La base ya tiene productos: no se sembró nada.' : `Sembrados: ${JSON.stringify(result)}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { seed };
