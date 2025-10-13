// Instância ativa (chips do header) + helpers de filtro — ES Module

export let INSTANCIA_ATIVA = null;

// --- persistência por empresa ---
function keyLS() {
  const emp = Number(localStorage.getItem('empresa_id') || 0);
  return emp ? `instAtiva:${emp}` : null;
}
function loadFromLS(){
  const k = keyLS(); if (!k) return null;
  const v = localStorage.getItem(k) || '';
  return v ? String(v) : null;
}
function saveToLS(v){
  const k = keyLS(); if (!k) return;
  try { localStorage.setItem(k, v ? String(v) : ''); } catch {}
}
// carrega ao importar
INSTANCIA_ATIVA = loadFromLS();

// -------- util: extrai instância de um objeto cliente --------
export function getClienteInst(c) {
  return (
    c?.instancia_id ??
    c?.instancia ??
    c?.instancia_slug ??
    c?.instance_id ??
    c?.instance ??
    c?.session ??
    c?.sessionName ??
    c?.sessao ??
    c?.inst_slug ??
    null
  );
}

// -------- match por instância ativa (para listas) --------
export function matchInstancia(c) {
  if (!INSTANCIA_ATIVA) return true;
  const v = getClienteInst(c);
  if (v == null || v === '') return true; // se servidor já filtrou, não sumir item sem campo
  return String(v).toLowerCase() === String(INSTANCIA_ATIVA).toLowerCase();
}

// -------- helper de querystring (para GETs) --------
export function instQuery() {
  if (!INSTANCIA_ATIVA) return '';
  const enc = encodeURIComponent(String(INSTANCIA_ATIVA));
  // servidor pode aceitar instance_name (string) OU instancia_id (numérico):
  const isNum = /^\d+$/.test(String(INSTANCIA_ATIVA));
  return isNum ? `&instancia_id=${enc}` : `&instance=${enc}`;
}

// -------- helper de payload (para POSTs) --------
export function instPayload() {
  if (!INSTANCIA_ATIVA) return {};
  const v = String(INSTANCIA_ATIVA);
  return /^\d+$/.test(v) ? { instancia_id: Number(v) } : { instance: v };
}

// -------- troca instância ativa + limpa caches --------
export async function setInstanciaAtiva(idOuSlug) {
  INSTANCIA_ATIVA = (idOuSlug && String(idOuSlug).trim()) || null;
  saveToLS(INSTANCIA_ATIVA);

  try { window.cacheDel?.(`clientes:${window.EMPRESA_ID}`); } catch {}
  try { window.cacheDel?.(`contatos:${window.EMPRESA_ID}`); } catch {}
  window.clientesCache = [];
  window.todosContatosCache = [];
  window.cacheHistoricos = {};
  window.salvarCache?.();

  // marca chip ativo (para elementos que usam data-attrs)
  document.querySelectorAll('[data-inst],[data-inst-id],[data-instancia]').forEach(el => {
    const val = el.getAttribute('data-inst') ||
                el.getAttribute('data-inst-id') ||
                el.getAttribute('data-instancia') || '';
    const active = String(val || '').toLowerCase() === String(INSTANCIA_ATIVA || '').toLowerCase();
    el.classList.toggle('active', active);
    el.classList.toggle('selected', active);
  });

  // notifica módulos
  document.dispatchEvent(new CustomEvent('inst:change', { detail:{ id: INSTANCIA_ATIVA }}));

  // força recarregar listas
  await window.carregarClientes?.({ force: true, reason: 'instancia' });
  await window.carregarTodosContatos?.();
}

// -------- liga os chips do header --------
export function wireInstanciaChips() {
  document.querySelectorAll('[data-inst],[data-inst-id],[data-instancia]').forEach(el => {
    el.addEventListener('click', () => {
      const val = el.getAttribute('data-inst') ||
                  el.getAttribute('data-inst-id') ||
                  el.getAttribute('data-instancia') || '';
      setInstanciaAtiva(val || null);
    });
  });
}

// ---- Aliases de compat ----
export { instQuery as _instQuery, matchInstancia as _matchInstancia, getClienteInst as _getClienteInst };

// ---- Bridge p/ window ----
try {
  if (typeof window !== 'undefined') {
    window._instQuery = instQuery;
    window._matchInstancia = matchInstancia;
    window.setInstanciaAtiva = setInstanciaAtiva;
    window.wireInstanciaChips = wireInstanciaChips;
    window.instPayload = instPayload;

    if (!Object.getOwnPropertyDescriptor(window, 'INSTANCIA_ATIVA')) {
      Object.defineProperty(window, 'INSTANCIA_ATIVA', {
        get() { return INSTANCIA_ATIVA; },
        set(v) { INSTANCIA_ATIVA = v == null ? null : String(v); saveToLS(INSTANCIA_ATIVA); },
        configurable: true
      });
    }
  }
} catch {}
