// /frontend/js/atendimentos/domain/instances.js
// Instância ativa (chips do header) + helpers de filtro — ES Module

export let INSTANCIA_ATIVA = null;

/* =========================
   Persistência por empresa
   ========================= */

function empresaIdLS() {
  return Number(localStorage.getItem('empresa_id') || 0) || 0;
}

function keyLS() {
  const emp = empresaIdLS();
  return emp ? `instAtiva:${emp}` : null;
}

function normInst(v) {
  const s = String(v ?? '').trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  return s;
}

function loadFromLS() {
  const k = keyLS();
  if (!k) return null;
  try {
    return normInst(localStorage.getItem(k));
  } catch {
    return null;
  }
}

function saveToLS(v) {
  const k = keyLS();
  if (!k) return;
  try {
    const n = normInst(v);
    if (n) localStorage.setItem(k, n);
    else localStorage.removeItem(k);
  } catch {}
}

function syncWindowInstancia() {
  try {
    window.INSTANCIA_ATIVA = INSTANCIA_ATIVA;
  } catch {}
}

/* carrega ao importar */
INSTANCIA_ATIVA = loadFromLS();
syncWindowInstancia();

/* =========================
   Lista de instâncias
   ========================= */

function getInstanciasList() {
  try {
    const arr =
      window.ZC_INSTANCIAS ||
      window.INSTANCIAS ||
      window.state?.instancias ||
      [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function getInstCandidates(raw) {
  const v = normInst(raw);
  if (!v) return [];

  const out = new Set();
  out.add(v);
  out.add(v.toLowerCase());

  const list = getInstanciasList();

  const found =
    list.find((x) => String(x?.instancia_id ?? x?.id ?? x?.instance_id ?? '') === v) ||
    list.find((x) => String(x?.instance_name ?? '').toLowerCase() === v.toLowerCase()) ||
    list.find((x) => String(x?.instancia ?? '').toLowerCase() === v.toLowerCase()) ||
    list.find((x) => String(x?.slug ?? '').toLowerCase() === v.toLowerCase()) ||
    list.find((x) => String(x?.nome ?? '').toLowerCase() === v.toLowerCase());

  if (found) {
    const vals = [
      found?.instancia_id,
      found?.id,
      found?.instance_id,
      found?.instance_name,
      found?.instancia,
      found?.slug,
      found?.nome,
    ];

    vals.forEach((item) => {
      const s = normInst(item);
      if (!s) return;
      out.add(s);
      out.add(s.toLowerCase());
    });
  }

  return [...out];
}

function sameInst(a, b) {
  const A = getInstCandidates(a);
  const B = getInstCandidates(b);

  if (!A.length || !B.length) return false;
  return A.some((x) => B.includes(x));
}

/* =========================
   Extrai instância de um cliente/objeto
   ========================= */

export function getClienteInst(c) {
  return (
    c?.instancia_id ??
    c?.instancia ??
    c?.instancia_slug ??
    c?.instance_id ??
    c?.instance ??
    c?.instance_name ??
    c?.session ??
    c?.sessionName ??
    c?.sessao ??
    c?.inst_slug ??
    null
  );
}

/* =========================
   Match por instância ativa
   ========================= */

export function matchInstancia(c) {
  if (!INSTANCIA_ATIVA) return true;

  const v = getClienteInst(c);
  if (v == null || v === '') return true; // não sumir se backend já filtrou

  return sameInst(v, INSTANCIA_ATIVA);
}

/* =========================
   Querystring / payload
   ========================= */

export function instQuery() {
  if (!INSTANCIA_ATIVA) return '';

  const v = String(INSTANCIA_ATIVA);
  const enc = encodeURIComponent(v);

  if (/^\d+$/.test(v)) {
    return `&instancia_id=${enc}`;
  }

  return `&instance=${enc}`;
}

export function instPayload() {
  if (!INSTANCIA_ATIVA) return {};

  const v = String(INSTANCIA_ATIVA);
  return /^\d+$/.test(v)
    ? { instancia_id: Number(v) }
    : { instance: v };
}

/* =========================
   UI dos chips
   ========================= */

function getChipValue(el) {
  return normInst(
    el?.getAttribute('data-inst') ||
    el?.getAttribute('data-inst-id') ||
    el?.getAttribute('data-instancia') ||
    ''
  );
}

function markActiveChips() {
  document.querySelectorAll('[data-inst],[data-inst-id],[data-instancia]').forEach((el) => {
    const val = getChipValue(el);
    const active = !INSTANCIA_ATIVA
      ? !val
      : sameInst(val, INSTANCIA_ATIVA);

    el.classList.toggle('active', !!active);
    el.classList.toggle('selected', !!active);
    el.classList.toggle('is-active', !!active);
    el.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

/* =========================
   Limpeza de cache
   ========================= */

function clearAtendimentoCaches() {
  try { window.cacheDel?.(`clientes:${window.EMPRESA_ID}`); } catch {}
  try { window.cacheDel?.(`contatos:${window.EMPRESA_ID}`); } catch {}

  try { window.clientesCache = []; } catch {}
  try { window.todosContatosCache = []; } catch {}
  try { window.cacheHistoricos = {}; } catch {}

  try {
    if (window.state) {
      window.state.clientesCache = [];
      window.state.todosContatosCache = [];
      window.state.cacheHistoricos = {};
      window.state.nextCursor = null;
    }
  } catch {}

  try { window.salvarCache?.(); } catch {}
  try { window.persist?.(); } catch {}
}

/* =========================
   Troca instância ativa
   ========================= */

export async function setInstanciaAtiva(idOuSlug, opt = {}) {
  const next = normInst(idOuSlug);
  const prev = INSTANCIA_ATIVA;

  INSTANCIA_ATIVA = next;
  saveToLS(INSTANCIA_ATIVA);
  syncWindowInstancia();

  markActiveChips();

  const changed = !sameInst(prev, INSTANCIA_ATIVA) || (!prev && !!INSTANCIA_ATIVA) || (!!prev && !INSTANCIA_ATIVA);

  try {
    document.dispatchEvent(new CustomEvent('inst:change', {
      detail: { id: INSTANCIA_ATIVA, value: INSTANCIA_ATIVA }
    }));
  } catch {}

  if (!changed) return INSTANCIA_ATIVA;

  clearAtendimentoCaches();

  if (opt.reload !== false) {
    try { await window.carregarClientes?.({ force: true, reason: 'instancia' }); } catch {}
    try { await window.carregarTodosContatos?.(); } catch {}
  }

  return INSTANCIA_ATIVA;
}

/* =========================
   Bind dos chips
   ========================= */

export function wireInstanciaChips(root = document) {
  root.querySelectorAll('[data-inst],[data-inst-id],[data-instancia]').forEach((el) => {
    if (el.dataset.instBound === '1') return;
    el.dataset.instBound = '1';

    const onPick = () => {
      const val = getChipValue(el);
      setInstanciaAtiva(val || null);
    };

    el.addEventListener('click', onPick);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPick();
      }
    });
  });

  markActiveChips();
}

/* =========================
   Compat / aliases
   ========================= */

export { instQuery as _instQuery, matchInstancia as _matchInstancia, getClienteInst as _getClienteInst };

/* =========================
   Bridge p/ window
   ========================= */

try {
  if (typeof window !== 'undefined') {
    window._instQuery = instQuery;
    window._matchInstancia = matchInstancia;
    window._getClienteInst = getClienteInst;
    window.instPayload = instPayload;
    window.setInstanciaAtiva = setInstanciaAtiva;
    window.wireInstanciaChips = wireInstanciaChips;

    Object.defineProperty(window, 'INSTANCIA_ATIVA', {
      get() {
        return INSTANCIA_ATIVA;
      },
      set(v) {
        INSTANCIA_ATIVA = normInst(v);
        saveToLS(INSTANCIA_ATIVA);
        markActiveChips();
      },
      configurable: true
    });
  }
} catch {}

/* =========================
   Boot
   ========================= */

function boot() {
  markActiveChips();
  wireInstanciaChips(document);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}