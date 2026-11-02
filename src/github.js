/**
 * Lista las copias desde la API pública de GitHub.
 *
 * El panel no las guarda en Firestore a propósito: si la base se pierde, el historial
 * de copias debe seguir visible. La API anónima permite 60 consultas por hora, de ahí la
 * caché de 5 minutos.
 */
const CACHE_MS = 5 * 60 * 1000;
const NAME = /^backup-(.+)$/;

function createBackupLister({ repository, rpoHours = 26, fetchFn = fetch, now = () => Date.now() }) {
  let cache = null;

  async function load() {
    const response = await fetchFn(`https://api.github.com/repos/${repository}/actions/artifacts?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'stockseguro' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`GitHub respondió ${response.status}`);
    const { artifacts } = await response.json();
    return artifacts
      .filter((artifact) => NAME.test(artifact.name) && !artifact.expired)
      .map((artifact) => {
        const id = artifact.name.match(NAME)[1];
        return {
          id,
          type: id.includes('-incremental') ? 'incremental' : 'full',
          label: id.includes('-prerestore') ? 'previa a una restauración' : null,
          bytes: artifact.size_in_bytes,
          createdAt: artifact.created_at,
          expiresAt: artifact.expires_at,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return async function listBackups() {
    if (!repository) return { configured: false, backups: [] };

    let stale = false;
    if (!cache || now() - cache.at > CACHE_MS) {
      try {
        cache = { at: now(), backups: await load() };
      } catch (error) {
        console.error(`[github] ${error.message}`);
        if (!cache) return { configured: true, available: false, backups: [] };
        stale = true;
      }
    }

    const regular = cache.backups.filter((backup) => !backup.label);
    const lastAt = regular[0] ? new Date(regular[0].createdAt).getTime() : null;
    const ageHours = lastAt === null ? null : (now() - lastAt) / 3_600_000;
    return {
      configured: true,
      available: true,
      stale,
      rpoHours,
      ageHours,
      healthy: ageHours !== null && ageHours <= rpoHours,
      backups: cache.backups,
    };
  };
}

module.exports = { createBackupLister };
