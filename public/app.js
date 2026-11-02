'use strict';

const $ = (id) => document.getElementById(id);
const KEY_STORAGE = 'stockseguro-edit-key';

function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 4000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Edit-Key': $('edit-key').value },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Error ${response.status}`);
  return body;
}

const dateTime = new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short' });
const formatDate = (iso) => (iso ? dateTime.format(new Date(iso)) : '-');

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(hours) {
  if (hours < 1) return 'hace menos de una hora';
  if (hours < 48) return `hace ${Math.round(hours)} h`;
  return `hace ${Math.round(hours / 24)} días`;
}

function cell(row, text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  row.append(td);
  return td;
}

function emptyRow(tbody, columns, text) {
  const row = document.createElement('tr');
  cell(row, text, 'muted').colSpan = columns;
  tbody.replaceChildren(row);
}

async function loadBackups() {
  const status = $('backup-status');
  const summary = $('backup-summary');
  const rows = $('backup-rows');
  let data;
  try {
    data = await api('/api/backups');
  } catch {
    data = { configured: true, available: false, backups: [] };
  }

  if (!data.configured) {
    status.textContent = 'Sin configurar';
    status.className = 'badge';
    summary.textContent = 'Falta indicar BACKUPS_REPOSITORY. En local las copias se manejan con la línea de comandos.';
  } else if (!data.available) {
    status.textContent = 'No disponible';
    status.className = 'badge';
    summary.textContent = 'No se pudo consultar GitHub. Esto no significa que las copias hayan fallado.';
  } else if (data.ageHours === null) {
    status.textContent = 'Sin copias';
    status.className = 'badge bad';
    summary.textContent = 'Todavía no hay ninguna copia vigente.';
  } else {
    status.textContent = data.healthy ? 'Al día' : 'Atrasada';
    status.className = data.healthy ? 'badge good' : 'badge bad';
    summary.textContent = `Última copia ${formatAge(data.ageHours)}. Objetivo: no perder más de ${data.rpoHours} h de datos.`;
  }

  if (data.backups.length === 0) {
    emptyRow(rows, 5, 'Sin copias que mostrar.');
    return;
  }
  rows.replaceChildren(...data.backups.map((backup) => {
    const row = document.createElement('tr');
    cell(row, backup.id, 'mono');
    cell(row, backup.label ? `${backup.type}, ${backup.label}` : backup.type);
    cell(row, formatBytes(backup.bytes));
    cell(row, formatDate(backup.createdAt));
    cell(row, formatDate(backup.expiresAt));
    return row;
  }));
}

async function moveStock(product, delta) {
  try {
    await api(`/api/products/${product.id}/movements`, { method: 'POST', body: JSON.stringify({ delta, note: 'Ajuste manual' }) });
    await loadProducts();
  } catch (error) {
    toast(error.message);
  }
}

async function removeProduct(product) {
  if (!window.confirm(`¿Eliminar "${product.name}" y sus movimientos?`)) return;
  try {
    await api(`/api/products/${product.id}`, { method: 'DELETE' });
    toast('Producto eliminado.');
    await loadProducts();
  } catch (error) {
    toast(error.message);
  }
}

function actionButton(label, title, onClick, className = 'secondary') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', onClick);
  return button;
}

async function loadProducts() {
  const rows = $('product-rows');
  let products;
  try {
    products = await api('/api/products');
  } catch (error) {
    emptyRow(rows, 6, error.message);
    return;
  }
  $('product-count').textContent = `${products.length} productos`;
  if (products.length === 0) {
    emptyRow(rows, 6, 'El inventario está vacío.');
    return;
  }
  rows.replaceChildren(...products.map((product) => {
    const row = document.createElement('tr');
    cell(row, product.name);
    cell(row, product.sku, 'mono');
    cell(row, String(product.stock));
    cell(row, String(product.movementCount));
    cell(row, formatDate(product.updatedAt));
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      actionButton('+1', `Sumar 1 a ${product.name}`, () => moveStock(product, 1)),
      actionButton('-1', `Restar 1 a ${product.name}`, () => moveStock(product, -1)),
      actionButton('Eliminar', `Eliminar ${product.name}`, () => removeProduct(product), 'danger'),
    );
    cell(row, '').append(actions);
    return row;
  }));
}

async function loadSuppliers() {
  try {
    const suppliers = await api('/api/suppliers');
    $('supplier').append(...suppliers.map((supplier) => new Option(supplier.name, supplier.id)));
  } catch {
    // El formulario sigue funcionando sin proveedor.
  }
}

$('product-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: $('name').value,
        sku: $('sku').value,
        stock: Number($('stock').value),
        supplierId: $('supplier').value || undefined,
      }),
    });
    event.target.reset();
    toast('Producto agregado.');
    await loadProducts();
  } catch (error) {
    toast(error.message);
  }
});

try {
  $('edit-key').value = sessionStorage.getItem(KEY_STORAGE) || '';
  $('edit-key').addEventListener('input', (event) => sessionStorage.setItem(KEY_STORAGE, event.target.value));
} catch {
  // Sin sessionStorage la clave solo dura hasta recargar.
}

loadBackups();
loadProducts();
loadSuppliers();
