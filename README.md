# StockSeguro: estrategias de copia de seguridad en Firestore

Inventario sobre **Google Cloud Firestore** con copias de seguridad automáticas, cifradas y comprobadas: cada copia se restaura en un emulador antes de darla por buena.

Proyecto de la actividad sobre **estrategias de copia de seguridad NoSQL**, Base de Datos II, Universidad Privada de Tacna.

| Integrante |
|---|
| Carlos Jimenez Laura |
| Arturo Cutipa Flores |

| Recurso | Enlace |
|---|---|
| Aplicación | <https://stockseguro-firestore.onrender.com> |
| Repositorio | <https://github.com/CRJL19/firestore-backups> |
| Video | `[PENDIENTE]` |

## Estrategias

| Estrategia | Cómo funciona | Por qué |
|---|---|---|
| Copia completa | Recorre todas las colecciones y subcolecciones. Cada 7 días | Es el punto de partida de la cadena y corrige cualquier desviación |
| Copia incremental | Lee lo cambiado según `updatedAt`, más las marcas de borrado. Cada día | Gasta menos cuota de lectura |
| Instantánea coherente | Todas las lecturas van en una transacción de solo lectura | La copia representa un único instante aunque la app siga escribiendo |
| Verificación | Restaura en el emulador y compara huellas y conteos | Una copia que nadie restauró no está comprobada |
| Cifrado | AES-256-GCM, con cada archivo enlazado a su manifiesto | Los artifacts de un repositorio público se pueden descargar |
| Restauración selectiva | `--only products/abc123` recupera una rama sin tocar el resto | Un error pequeño no debería obligar a volver atrás toda la base |
| Copia previa | Antes de restaurar en producción se copia el estado actual | Permite deshacer una restauración equivocada |

### Objetivos

- **RPO:** 24 horas, por la copia diaria. El panel avisa si la última supera las 26 horas.
- **RTO:** minutos con estos volúmenes. Cada verificación mide lo que tarda la restauración.

### Retención

Las copias completas se guardan 90 días y las incrementales 30. Las completas duran más porque las incrementales dependen de ellas.

### Por qué no usar la exportación nativa

Firestore tiene copias administradas, pero no están en el plan gratuito. Este proyecto hace una copia lógica con el Admin SDK.

| | Exportación administrada | PITR o copias programadas | Copia lógica (este proyecto) |
|---|---|---|---|
| Plan | De pago, con un bucket de Cloud Storage | De pago | Gratuito |
| Costo | Por documento leído y almacenamiento | Por almacenamiento | Por documento leído, dentro de la cuota gratuita |
| Fuera de Google | No directamente | No | Sí |
| Cifrado con clave propia | Requiere configuración aparte | Requiere configuración aparte | Sí |
| Apta para grandes volúmenes | Sí | Sí | No: usa memoria y tiempo proporcionales a los datos |

Para una base grande en producción, la opción correcta es la nativa.

## Lo que hace difícil copiar una base NoSQL

- **No hay esquema.** Un `JSON.stringify` convierte un `Timestamp` o un `GeoPoint` en un objeto corriente. `src/backup/serialize.js` etiqueta cada tipo, y un tipo desconocido hace fallar la copia en lugar de perder el dato.
- **Las subcolecciones no se leen con su padre**, y pueden colgar de un documento que ya no existe. El recorrido usa `listDocuments` para no perderlas.
- **Un borrado no deja rastro.** Una consulta por `updatedAt` nunca verá un documento eliminado, así que la app deja una marca en `_tombstones`.
- **La copia incremental depende de un contrato** que solo cumple la app. Por eso cada copia guarda los conteos reales del origen, y la verificación falla si un cambio externo los hace discrepar.

## Arquitectura

```
                    cada día a las 03:00 (Perú)
 GitHub Actions ───────────────────────────────┐
   │ 1. Lee con una cuenta de solo lectura     ▼
   │                                      Firestore ◄── Render (Express) ◄── Navegador
   │ 2. Comprime y cifra                                      │
   │ 3. Restaura en un emulador y compara                     │ lista las copias
   ▼ 4. Solo si coincide, guarda                              ▼
 Artifacts de GitHub ◄─────────────────────────────── API pública de GitHub
```

El historial de copias se lee de GitHub y no de Firestore: si la base se pierde, sigue visible.

## Modelo de datos

```
suppliers/{id}                   name, updatedAt
products/{id}                    name, sku, stock, tags, location (GeoPoint),
                                 supplier (referencia), movementCount, updatedAt
products/{id}/movements/{id}     delta, note, updatedAt
_tombstones/{hash}               path, deletedAt
_backup_meta/state               restoredAt
```

Las colecciones que empiezan por `_` son internas y no entran en las copias.

## Ejecución local

No necesitas cuenta de Google: el emulador oficial reemplaza a Firestore. Requiere Node.js 22 o superior y Java 17 o superior.

```bash
npm ci
npm run dev
```

La app queda en <http://localhost:3000> y la clave de edición local es `dev-key`.

También puedes usar Docker, sin instalar Java:

```bash
docker compose up --build
```

## Pruebas

```bash
npm test
```

Son 39 pruebas de integración contra el emulador. Cubren todos los tipos de datos, documentos fantasma, cadenas incrementales, borrados externos, archivos alterados, clave incorrecta y restauración selectiva.

## Línea de comandos

```bash
node src/backup/cli.js create --dir backups --type auto
node src/backup/cli.js list --dir backups
node src/backup/cli.js verify --dir backups --id ID
node src/backup/cli.js restore --dir backups --id ID --mode replace --confirm RESTAURAR
node src/backup/cli.js restore --dir backups --id ID --only products/abc123 --confirm RESTAURAR
```

Necesita `BACKUP_KEY`. `verify` borra la base de destino, así que se niega a correr fuera del emulador.

## Automatización

| Workflow | Cuándo | Qué hace |
|---|---|---|
| `ci-cd.yml` | Cada `push` a `main` | Pruebas, imagen Docker y despliegue en Render |
| `backup.yml` | Cada día, o manual | Copia, verifica en el emulador y guarda |
| `restore.yml` | Manual, escribiendo `RESTAURAR` | Copia previa y restauración en producción |
| `demo.yml` | Manual | Carga datos de ejemplo o simula un desastre |

### Configurarlo desde cero

1. **Firebase:** crea un proyecto y una base Firestore en modo de producción.
2. **Cuentas de servicio:** en Google Cloud crea dos, cada una con una clave JSON guardada fuera del repositorio.
   - `backup-reader`, con el rol **Lector de Cloud Datastore**. Solo hace copias.
   - `stockseguro-app`, con el rol **Usuario de Cloud Datastore**. La usan la app y la restauración.
3. **Clave de cifrado:** genérala con `openssl rand -base64 32` y guárdala también fuera de GitHub. **Sin ella las copias no se pueden recuperar.**
4. **Render:** New → Blueprint → este repositorio. Indica `BACKUPS_REPOSITORY` y pega en `FIREBASE_SERVICE_ACCOUNT` el JSON de `stockseguro-app`.
5. **GitHub:** en Settings → Secrets and variables → Actions crea estos secrets:
   - `FIREBASE_BACKUP_SA`: JSON de `backup-reader`.
   - `FIREBASE_RESTORE_SA`: JSON de `stockseguro-app`.
   - `BACKUP_KEY`: la clave de cifrado.
   - `RENDER_DEPLOY_HOOK`: la URL del Deploy Hook de Render.

## Limitaciones conocidas

- **Dos ubicaciones, no tres.** Hay datos en Firestore y copias en GitHub. La regla 3-2-1 pediría una tercera copia, como descargar periódicamente los artifacts.
- **Enteros y decimales.** El SDK de JavaScript no distingue `1` de `1.0`, así que un `double` entero vuelve como entero. Tampoco se conservan `createTime` ni `updateTime`, que asigna el servidor.
- **Escrituras externas.** Una incremental no ve cambios hechos por fuera de la app. La verificación detecta los que alteran los conteos, pero una modificación externa sin cambio de conteo solo se recoge en la siguiente completa.
- **Panel de copias.** Usa la API anónima de GitHub, que limita las consultas por IP. Si falla, el panel muestra «No disponible» y reintenta: es un problema de la vista, no de las copias.
- **Memoria.** Cada copia se procesa completa en memoria, adecuado para miles de documentos, no para millones.
- **GitHub Actions.** La hora programada puede retrasarse, y GitHub desactiva los programas tras 60 días sin actividad en el repositorio.
- **Plan gratuito.** Firestore Spark permite 50 000 lecturas y 20 000 escrituras al día. La instancia gratuita de Render se duerme tras un rato sin tráfico.

## Licencia

MIT
