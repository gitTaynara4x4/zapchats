// Permissões de Clientes usadas dentro do Atendimento.
// Mantém uma única leitura curta de /api/permissoes/minhas e falha fechado.

const CACHE_TTL_MS = 15_000;

let cache = null;
let cacheAt = 0;
let inFlight = null;

function emptyState() {
  return Object.freeze({
    loaded: false,
    view: false,
    create: false,
    edit: false,
    delete: false,
    all: Object.freeze([]),
  });
}

function normalize(list) {
  const all = Array.isArray(list)
    ? list.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const set = new Set(all);

  return Object.freeze({
    loaded: true,
    view: set.has('clientes.ver'),
    create: set.has('clientes.criar'),
    edit: set.has('clientes.editar'),
    delete: set.has('clientes.excluir'),
    all: Object.freeze(all.slice()),
  });
}

export function getCachedClientPermissions() {
  return cache || emptyState();
}

export function invalidateClientPermissions() {
  cache = null;
  cacheAt = 0;
  inFlight = null;
}

export async function getClientPermissions({ force = false } = {}) {
  const now = Date.now();

  if (!force && cache && (now - cacheAt) < CACHE_TTL_MS) {
    return cache;
  }

  if (!force && inFlight) {
    return inFlight;
  }

  const request = (async () => {
    try {
      const auth = window.ZAuth || window.Auth || null;
      const headers = { Accept: 'application/json' };
      const empresaId =
        auth?.getEmpresaId?.() ||
        localStorage.getItem('empresa_id') ||
        window.EMPRESA_ID ||
        '';

      if (empresaId) headers['X-Empresa-Id'] = String(empresaId);

      const fetcher = auth && typeof auth.authFetch === 'function'
        ? auth.authFetch.bind(auth)
        : window.fetch.bind(window);

      const response = await fetcher('/api/permissoes/minhas', {
        method: 'GET',
        credentials: 'include',
        headers,
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error(`Permissões HTTP ${response.status}`);
      }

      const payload = await response.json().catch(() => []);
      const list = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.permissoes) ? payload.permissoes : []);

      cache = normalize(list);
      cacheAt = Date.now();
      return cache;
    } catch (error) {
      console.warn('[atendimento][client-permissions] falha ao carregar permissões', error);
      cache = emptyState();
      cacheAt = Date.now();
      return cache;
    } finally {
      inFlight = null;
    }
  })();

  inFlight = request;
  return request;
}
