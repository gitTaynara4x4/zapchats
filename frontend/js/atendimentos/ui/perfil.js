// /frontend/js/atendimentos/ui/perfil.js
// Drawer “Dados do cliente”
// - abre rápido com GET do banco
// - NÃO chama Evolution automaticamente ao abrir
// - Evolution só no botão "Atualizar"
// - corrige race condition entre clientes (abort + seq check)
// - corrige leitura do cliente atual (não reutiliza o cliente anterior)
// - mostra business info + mídias recentes
// - preview de mídia estilo WhatsApp Web (pequeno/médio)
// - no resumo mostra só 4 thumbs
// - "Ver tudo" abre modal com mais mídias
// - abertura via import { abrirPerfilAtual } ou window.abrirPerfilAtual(...)
// - suporte a GRUPO: abre /api/atendimento/grupos/{grupo_id}/profile
//   quando a conversa atual for g:{grupo_id}:{instancia_id}
// - CACHE LOCAL: abrir/fechar/abrir não fica batendo no banco toda hora
// - Botão "Atualizar" ignora cache e consulta Evolution

const $ = (s, r = document) => r.querySelector(s);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);

let PERFIL_CLIENTE_ID = 0;
let PERFIL_GRUPO_ID = 0;
let PERFIL_KIND_ATUAL = 'cliente';

let drawerRefs = null;
let drawerBound = false;

let PERFIL_MEDIA_ITEMS = [];
let PERFIL_MEDIA_FILTER = 'all';
let mediaModalRefs = null;
let mediaModalBound = false;

/* =========================
   CACHE LOCAL DO PERFIL
   ========================= */

const PERFIL_CACHE_TTL_MS = Number(window.ZC_PERFIL_CACHE_TTL_MS || 90_000);
const PERFIL_STALE_CACHE_TTL_MS = Number(window.ZC_PERFIL_STALE_CACHE_TTL_MS || 10 * 60_000);
const PERFIL_MEDIA_CACHE_TTL_MS = Number(window.ZC_PERFIL_MEDIA_CACHE_TTL_MS || 45_000);

const perfilMemoryCache = new Map();

function nowMs() {
  return Date.now();
}

function safeJsonParse(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function perfilCacheBucket(type, kind, id) {
  const k = String(kind || 'cliente') === 'grupo' ? 'grupo' : 'cliente';
  const n = Number(id || 0);
  if (!EMPRESA_ID || !n) return '';
  return `${type}:${k}:${n}`;
}

function perfilStorageKey(bucket) {
  return `zc:perfil:${EMPRESA_ID}:${bucket}`;
}

function getPerfilCache(type, kind, id, { allowStale = false } = {}) {
  const bucket = perfilCacheBucket(type, kind, id);
  if (!bucket) return { hit: false, fresh: false, value: null };

  let obj = perfilMemoryCache.get(bucket) || null;

  if (!obj) {
    obj = safeJsonParse(localStorage.getItem(perfilStorageKey(bucket)));
    if (obj && typeof obj === 'object') {
      perfilMemoryCache.set(bucket, obj);
    }
  }

  if (!obj || typeof obj !== 'object' || !('value' in obj)) {
    return { hit: false, fresh: false, value: null };
  }

  const at = Number(obj.at || 0);
  const exp = Number(obj.exp || 0);
  const staleExp = Number(obj.staleExp || 0);
  const ts = nowMs();

  const fresh = exp > ts;
  const staleOk = allowStale && staleExp > ts;

  if (!fresh && !staleOk) {
    try {
      perfilMemoryCache.delete(bucket);
      localStorage.removeItem(perfilStorageKey(bucket));
    } catch {}
    return { hit: false, fresh: false, value: null };
  }

  return {
    hit: true,
    fresh,
    stale: !fresh && staleOk,
    value: obj.value,
    at,
  };
}

function setPerfilCache(type, kind, id, value, ttlMs = PERFIL_CACHE_TTL_MS) {
  const bucket = perfilCacheBucket(type, kind, id);
  if (!bucket || value == null) return;

  const ts = nowMs();

  const obj = {
    at: ts,
    exp: ts + Number(ttlMs || PERFIL_CACHE_TTL_MS),
    staleExp: ts + PERFIL_STALE_CACHE_TTL_MS,
    value,
  };

  try {
    perfilMemoryCache.set(bucket, obj);
  } catch {}

  try {
    localStorage.setItem(perfilStorageKey(bucket), JSON.stringify(obj));
  } catch {}
}

function delPerfilCache(type, kind, id) {
  const bucket = perfilCacheBucket(type, kind, id);
  if (!bucket) return;

  try {
    perfilMemoryCache.delete(bucket);
  } catch {}

  try {
    localStorage.removeItem(perfilStorageKey(bucket));
  } catch {}
}

function invalidatePerfilCache(kind, id) {
  delPerfilCache('profile', kind, id);
  delPerfilCache('media', kind, id);
}

function clearAllPerfilCache() {
  try {
    perfilMemoryCache.clear();
  } catch {}

  try {
    const prefix = `zc:perfil:${EMPRESA_ID}:`;
    Object.keys(localStorage).forEach((k) => {
      if (k.startsWith(prefix)) localStorage.removeItem(k);
    });
  } catch {}
}

window.zcClearPerfilCache = clearAllPerfilCache;
window.zcInvalidatePerfilCache = invalidatePerfilCache;

/* =========================
   CONTROLE DE REQUEST ATIVO
   ========================= */

let perfilRequestSeq = 0;
let perfilAbortController = null;

function abortPerfilRequests() {
  try {
    perfilAbortController?.abort();
  } catch {}
  perfilAbortController = null;
}

function beginPerfilRequest(id) {
  abortPerfilRequests();
  perfilRequestSeq += 1;
  perfilAbortController = new AbortController();

  return {
    seq: perfilRequestSeq,
    id: Number(id),
    signal: perfilAbortController.signal,
  };
}

/* =========================
   IDENTIFICAÇÃO CLIENTE / GRUPO
   ========================= */

function parsePerfilConversationKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const m = raw.match(/^([cg]):(\d+):(\d+)$/i);
  if (!m) return null;

  return {
    raw,
    kind: m[1].toLowerCase() === 'g' ? 'grupo' : 'cliente',
    prefix: m[1].toLowerCase(),
    entityId: Number(m[2]),
    instanciaId: Number(m[3]) || null,
  };
}

function idPerfilFromAny(value) {
  if (value == null) return 0;

  const raw = String(value).trim();
  if (!raw || raw === 'null' || raw === 'undefined' || raw === 'NaN') return 0;

  const key = parsePerfilConversationKey(raw);
  if (key && Number.isFinite(key.entityId) && key.entityId > 0) {
    return key.entityId;
  }

  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function getPerfilStateSelected() {
  return window.state?.clienteSel || window.clienteSel || null;
}

function getPerfilConversationKey() {
  const hist = $('#historico');
  const head = $('#chat-header');
  const sel = getPerfilStateSelected();

  const candidates = [
    hist?.dataset?.conversationKey,
    hist?.dataset?.conversationId,
    hist?.dataset?.chatKey,

    head?.dataset?.conversationKey,
    head?.dataset?.conversationId,
    head?.dataset?.chatKey,

    sel?.conversation_key,
    sel?.conversationKey,
    sel?.conversation_id,
    sel?.conversationId,
    sel?.chat_key,
    sel?.chatKey,
    sel?.key,
  ];

  for (const v of candidates) {
    const raw = String(v || '').trim();
    if (parsePerfilConversationKey(raw)) return raw;
  }

  return '';
}

function getPerfilSelectedKind(opts = {}) {
  const explicitKind = String(
    opts.kind ||
    opts.tipo ||
    opts.conversation_kind ||
    opts.conversationKind ||
    ''
  ).trim().toLowerCase();

  if (['grupo', 'group', 'g'].includes(explicitKind)) return 'grupo';
  if (['cliente', 'client', 'contact', 'c'].includes(explicitKind)) return 'cliente';

  const explicitKey = parsePerfilConversationKey(
    opts.conversation_key ||
    opts.conversationKey ||
    opts.conversation_id ||
    opts.conversationId ||
    ''
  );

  if (explicitKey) return explicitKey.kind;

  const key = parsePerfilConversationKey(getPerfilConversationKey());
  if (key) return key.kind;

  const hist = $('#historico');
  const head = $('#chat-header');
  const sel = getPerfilStateSelected();

  const rawFlags = [
    opts.is_group,
    opts.isGroup,
    opts.grupo,
    opts.group,

    hist?.dataset?.isGroup,
    hist?.dataset?.grupo,
    hist?.dataset?.kind,
    hist?.dataset?.tipo,

    head?.dataset?.isGroup,
    head?.dataset?.grupo,
    head?.dataset?.kind,
    head?.dataset?.tipo,

    sel?.is_group,
    sel?.isGroup,
    sel?.grupo,
    sel?.group,
    sel?.kind,
    sel?.tipo,
    sel?.conversation_kind,
    sel?.conversationKind,
  ];

  for (const v of rawFlags) {
    const s = String(v ?? '').trim().toLowerCase();

    if (['1', 'true', 'sim', 'yes', 'grupo', 'group', 'g'].includes(s)) {
      return 'grupo';
    }

    if (['0', 'false', 'nao', 'não', 'no', 'cliente', 'client', 'contact', 'c'].includes(s)) {
      return 'cliente';
    }
  }

  return PERFIL_KIND_ATUAL === 'grupo' ? 'grupo' : 'cliente';
}

function getClienteId(explicitId = null) {
  if (getPerfilSelectedKind() === 'grupo') return 0;

  const hist = $('#historico');
  const sel = getPerfilStateSelected();

  const candidates = [
    explicitId,

    hist?.dataset?.backendClienteId,
    hist?.dataset?.entityId,
    hist?.dataset?.apiClienteId,
    hist?.dataset?.clienteId,
    hist?.dataset?.id,
    hist?.dataset?.conversationKey,
    hist?.dataset?.conversationId,

    sel?.backend_cliente_id,
    sel?.backendClienteId,
    sel?.entity_id,
    sel?.entityId,
    sel?.api_cliente_id,
    sel?.apiClienteId,
    sel?.cliente_id,
    sel?.clienteId,
    sel?.backend_id,
    sel?.backendId,
    sel?.id,
    sel?.conversation_key,
    sel?.conversationKey,
    sel?.conversation_id,
    sel?.conversationId,

    window.CLIENTE_ID_ATUAL,
    window.currentClienteId,
    window.__perfilClienteIdAtual,

    PERFIL_CLIENTE_ID,
  ];

  for (const v of candidates) {
    const n = idPerfilFromAny(v);
    if (n > 0) return n;
  }

  return 0;
}

function getClienteIdFromCurrentSelection() {
  return getClienteId(null);
}

function getGrupoId(explicitId = null) {
  const explicit = idPerfilFromAny(explicitId);
  if (explicit > 0) return explicit;

  const key = parsePerfilConversationKey(getPerfilConversationKey());
  if (key?.kind === 'grupo' && key.entityId > 0) return key.entityId;

  const hist = $('#historico');
  const head = $('#chat-header');
  const sel = getPerfilStateSelected();

  const candidates = [
    hist?.dataset?.grupoId,
    hist?.dataset?.groupId,
    hist?.dataset?.entityId,
    hist?.dataset?.clienteId,
    hist?.dataset?.id,
    hist?.dataset?.conversationKey,
    hist?.dataset?.conversationId,

    head?.dataset?.grupoId,
    head?.dataset?.groupId,
    head?.dataset?.entityId,
    head?.dataset?.clienteId,
    head?.dataset?.conversationKey,
    head?.dataset?.conversationId,

    sel?.grupo_id,
    sel?.grupoId,
    sel?.group_id,
    sel?.groupId,
    sel?.entity_id,
    sel?.entityId,
    sel?.cliente_id,
    sel?.clienteId,
    sel?.id,
    sel?.conversation_key,
    sel?.conversationKey,
    sel?.conversation_id,
    sel?.conversationId,

    window.__perfilGrupoIdAtual,
    PERFIL_GRUPO_ID,
  ];

  for (const v of candidates) {
    const parsed = parsePerfilConversationKey(v);
    if (parsed?.kind === 'grupo' && parsed.entityId > 0) {
      return parsed.entityId;
    }

    const n = idPerfilFromAny(v);
    if (n > 0) return n;
  }

  return 0;
}

function isPerfilRequestStillValid(seq, id, kind = 'cliente') {
  if (kind === 'grupo') {
    return (
      Number(seq) === Number(perfilRequestSeq) &&
      Number(id) > 0 &&
      PERFIL_KIND_ATUAL === 'grupo' &&
      Number(PERFIL_GRUPO_ID) === Number(id)
    );
  }

  const atual = getClienteIdFromCurrentSelection();

  return (
    Number(seq) === Number(perfilRequestSeq) &&
    Number(id) > 0 &&
    PERFIL_KIND_ATUAL === 'cliente' &&
    Number(PERFIL_CLIENTE_ID) === Number(id) &&
    Number(atual) === Number(id)
  );
}

function perfilProfileUrl(kind, id, suffix = '') {
  const base = kind === 'grupo'
    ? `/api/atendimento/grupos/${encodeURIComponent(id)}/profile`
    : `/api/atendimento/clientes/${encodeURIComponent(id)}/profile`;

  return `${base}${suffix}?empresa_id=${encodeURIComponent(EMPRESA_ID)}`;
}

/* =========================
   TEMA / HTML
   ========================= */

function getTheme() {
  try {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
  } catch {}

  try {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {}

  return 'dark';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[ch]));
}

function iconSvg(theme) {
  const fill = theme === 'light' ? '#080808' : '#ffffff';

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"
         class="perfil-ico" fill="${fill}" viewBox="0 0 256 256" aria-hidden="true">
      <path d="M154,80a6,6,0,0,1,6-6h88a6,6,0,0,1,0,12H160A6,6,0,0,1,154,80Zm94,42H160a6,6,0,0,0,0,12h88a6,6,0,0,0,0-12Zm0,48H184a6,6,0,0,0,0,12h64a6,6,0,0,0,0-12Zm-98.19,20.5a6,6,0,1,1-11.62,3C131.7,168.29,107.23,150,80,150s-51.7,18.29-58.19,43.49a6,6,0,1,1-11.62-3c5.74-22.28,23-40.07,44.67-48a46,46,0,1,1,50.28,0C126.79,150.43,144.08,168.22,149.81,190.5ZM80,138a34,34,0,1,0-34-34A34,34,0,0,0,80,138Z"></path>
    </svg>
  `;
}

function bannerSvg(theme) {
  const fill = theme === 'light' ? '#080808' : '#ffffff';

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="${fill}" viewBox="0 0 256 256" aria-hidden="true">
      <path d="M222,114.56a54,54,0,0,0-58.67-74.73,54,54,0,0,0-94,13.46A54,54,0,0,0,34,141.44a54,54,0,0,0,35.56,73.65A54.54,54.54,0,0,0,83.59,217a52.86,52.86,0,0,0,9.06-.78,54,54,0,0,0,94-13.46A54,54,0,0,0,222,114.56ZM183.37,52.5a42,42,0,0,1,29.21,53.14,54.84,54.84,0,0,0-5.08-3.33L163,76.62a6,6,0,0,0-6,0l-47,27.13V80.66l41.5-24A41.73,41.73,0,0,1,183.37,52.5ZM78,72a42,42,0,0,1,72.92-28.43,56.18,56.18,0,0,0-5.42,2.74L101,72a6,6,0,0,0-3,5.19v54.27L78,119.92ZM39.13,85.93a41.75,41.75,0,0,1,27.22-20A55.09,55.09,0,0,0,66,72v51.38a6,6,0,0,0,3,5.2l47,27.13L96,167.26l-41.5-24A42,42,0,0,1,39.13,85.93ZM72.63,203.5a42,42,0,0,1-29.21-53.14,54.84,54.84,0,0,0,5.08,3.33L93,179.38a6,6,0,0,0,6,0l47-27.13v23.09l-41.5,24A41.73,41.73,0,0,1,72.63,203.5ZM178,184a42,42,0,0,1-72.92,28.43,56.18,56.18,0,0,0,5.42-2.74L155,184a6,6,0,0,0,3-5.19V124.54l20,11.54Zm38.87-13.93a41.75,41.75,0,0,1-27.22,20A55.09,55.09,0,0,0,190,184V132.62a6,6,0,0,0-3-5.2l-47-27.13,20-11.55,41.5,24A42,42,0,0,1,216.87,170.07Z"></path>
    </svg>
  `;
}

/* =========================
   TOAST
   ========================= */

function ensureToastHost() {
  let host = document.getElementById('zcToastHost');

  if (!host) {
    host = document.createElement('div');
    host.id = 'zcToastHost';
    host.className = 'zcToastHost';
    document.body.appendChild(host);
  }

  return host;
}

function toastLocal({ title = 'Pronto', msg = '', type = 'ok', timeout = 2800 } = {}) {
  if (typeof window.toast === 'function') {
    try {
      window.toast({ title, msg, type, timeout });
      return;
    } catch {}

    try {
      window.toast(msg || title, type !== 'error');
      return;
    } catch {}
  }

  const host = ensureToastHost();

  const el = document.createElement('div');
  el.className = `zcToast ${type === 'error' ? 'err' : 'ok'}`;
  el.innerHTML = `
    <div>
      <div class="t-title">${escapeHtml(title)}</div>
      ${msg ? `<div class="t-msg">${escapeHtml(msg)}</div>` : ''}
    </div>
    <button class="t-close" aria-label="Fechar"><i class="fa-solid fa-xmark"></i></button>
  `;

  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));

  el.querySelector('.t-close')?.addEventListener('click', () => el.remove());

  if (timeout) {
    setTimeout(() => el.remove(), timeout);
  }
}

/* =========================
   MÁSCARAS / VALIDAÇÃO
   ========================= */

const UF_LIST = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
  'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN',
  'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
];

const UF_SET = new Set(UF_LIST);

const onlyDigits = s => String(s || '').replace(/\D+/g, '');
const keepRGChars = s => String(s || '').replace(/[^0-9xX]/g, '').toUpperCase();

function fmtCPF(d) {
  d = onlyDigits(d).slice(0, 11);

  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
}

function fmtCNPJ(d) {
  d = onlyDigits(d).slice(0, 14);

  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3/$4')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})(\d)/, '$1.$2.$3/$4-$5');
}

function fmtCPForCNPJ(v) {
  const d = onlyDigits(v);
  return d.length <= 11 ? fmtCPF(d) : fmtCNPJ(d);
}

function fmtRG(v) {
  let s = keepRGChars(v).slice(0, 10);
  let body = s;
  let dv = '';

  if (s.length === 10) {
    body = s.slice(0, 9);
    dv = s.slice(9);
  }

  body = body
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3');

  return dv ? `${body}-${dv}` : body;
}

function fmtCEP(v) {
  let d = onlyDigits(v).slice(0, 8);

  if (d.length > 5) {
    d = d.replace(/^(\d{5})(\d{1,3})$/, '$1-$2');
  }

  return d;
}

function fmtNumero(v) {
  return onlyDigits(v).slice(0, 8);
}

function fmtComplemento(v) {
  return String(v || '')
    .replace(/[^0-9A-Za-zÀ-ÿ\s#\/\-\.\º°]/g, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 40);
}

function fmtCidade(v) {
  return String(v || '')
    .replace(/[^A-Za-zÀ-ÿ\s\-']/g, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 50);
}

function fmtUF(v) {
  return String(v || '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .slice(0, 2);
}

function fmtDataBR(v) {
  const d = onlyDigits(v).slice(0, 8);

  if (d.length <= 2) return d;
  if (d.length <= 4) return d.replace(/^(\d{2})(\d{0,2})$/, '$1/$2');

  return d.replace(/^(\d{2})(\d{2})(\d{0,4}).*$/, '$1/$2/$3');
}

function isValidDataBR(v) {
  const m = String(v || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return false;

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);

  if (yyyy < 1900) return false;
  if (mm < 1 || mm > 12) return false;

  const dt = new Date(yyyy, mm - 1, dd);

  if (
    dt.getFullYear() !== yyyy ||
    dt.getMonth() + 1 !== mm ||
    dt.getDate() !== dd
  ) {
    return false;
  }

  if (dt.getTime() > Date.now()) return false;

  return true;
}

function toISOFromDataBR(v) {
  if (!isValidDataBR(v)) return '';

  const [dd, mm, yyyy] = v.split('/');
  return `${yyyy}-${mm}-${dd}`;
}

function toDataBRFromAny(x) {
  if (!x) return '';

  const s = String(x);

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return s;

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  return '';
}

function isValidEmail(v) {
  if (!v) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

function isValidCEP(v) {
  return onlyDigits(v).length === 8;
}

function isValidCPF(d) {
  d = onlyDigits(d);

  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;

  let s = 0;

  for (let i = 0; i < 9; i++) {
    s += Number(d[i]) * (10 - i);
  }

  let dg = (s * 10) % 11;
  if (dg === 10) dg = 0;
  if (dg !== Number(d[9])) return false;

  s = 0;

  for (let i = 0; i < 10; i++) {
    s += Number(d[i]) * (11 - i);
  }

  dg = (s * 10) % 11;
  if (dg === 10) dg = 0;

  return dg === Number(d[10]);
}

function isValidCNPJ(c) {
  c = onlyDigits(c);

  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;

  const calc = (base) => {
    const seq = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2].slice(12 - base.length);
    const sum = base.split('').reduce((acc, ch, i) => acc + Number(ch) * seq[i], 0);
    const r = sum % 11;

    return r < 2 ? 0 : 11 - r;
  };

  const b1 = c.substring(0, 12);
  const d1 = calc(b1);
  const d2 = calc(b1 + String(d1));

  return c === b1 + String(d1) + String(d2);
}

function validCPForCNPJ(v) {
  const d = onlyDigits(v);

  if (!d.length) return true;

  return d.length <= 11 ? isValidCPF(d) : isValidCNPJ(d);
}

function maskInput(el, formatter, validator) {
  if (!el) return;

  const apply = () => {
    el.value = formatter(el.value);

    if (validator) {
      const ok = validator(el.value);
      el.classList.toggle('is-invalid', !ok);
      el.title = ok ? '' : 'Valor inválido';
    }
  };

  on(el, 'input', apply);
  on(el, 'blur', apply);

  apply();
}

/* =========================
   BRASILAPI
   ========================= */

async function preencherPorCEP(cep) {
  const d = onlyDigits(cep);

  if (d.length !== 8) return false;

  try {
    const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${d}`);
    if (!r.ok) return false;

    const j = await r.json();
    const est = String(j.state || '').toUpperCase();

    if ($('#pf_estado') && UF_SET.has(est)) $('#pf_estado').value = est;
    if ($('#pf_cidade')) $('#pf_cidade').value = j.city || '';
    if ($('#pf_bairro')) $('#pf_bairro').value = j.neighborhood || '';
    if ($('#pf_endereco')) $('#pf_endereco').value = j.street || '';

    setBannerTip('Endereço sugerido a partir do CEP. Confira antes de salvar.');
    return true;
  } catch (e) {
    console.warn('[CEP] BrasilAPI erro', e);
    return false;
  }
}

/* =========================
   HELPERS DE MÍDIA
   ========================= */

function mediaCategory(item = {}) {
  const raw = String(item?.categoria || item?.tipo || item?.mime_group || '').toLowerCase();

  if (raw.includes('imagem') || raw.includes('image') || raw.includes('foto') || raw.includes('sticker')) return 'imagem';
  if (raw.includes('video') || raw.includes('vídeo')) return 'video';
  if (raw.includes('audio') || raw.includes('áudio') || raw.includes('ptt') || raw.includes('voice')) return 'audio';

  return 'documento';
}

function mediaUrl(item = {}) {
  return item?.url || item?.download_url || item?.message_media_url || item?.local_url || '#';
}

function mediaThumb(item = {}) {
  return item?.thumb_url || item?.preview_url || item?.url || item?.download_url || '';
}

function mediaTitle(item = {}) {
  return item?.nome_original || item?.filename || item?.file_name || item?.title || 'mídia';
}

function isVisualMedia(item = {}) {
  const cat = mediaCategory(item);
  return cat === 'imagem' || cat === 'video';
}

function calcMediaCounts(items = []) {
  const out = {
    total: 0,
    imagens: 0,
    videos: 0,
    audios: 0,
    documentos: 0,
  };

  for (const item of items) {
    out.total += 1;

    const cat = mediaCategory(item);

    if (cat === 'imagem') out.imagens += 1;
    else if (cat === 'video') out.videos += 1;
    else if (cat === 'audio') out.audios += 1;
    else out.documentos += 1;
  }

  return out;
}

function previewMediaItems(items = []) {
  const visuals = items.filter(isVisualMedia);

  if (visuals.length) return visuals.slice(0, 4);

  return items.slice(0, 4);
}

function renderMediaPreviewItem(item = {}, idx = 0) {
  const cat = mediaCategory(item);
  const title = escapeHtml(mediaTitle(item));
  const thumb = escapeHtml(mediaThumb(item));
  const url = escapeHtml(mediaUrl(item));

  if (cat === 'imagem') {
    return `
      <button type="button" class="zcPerfilMediaThumb" data-open-media="1" data-media-index="${idx}" title="${title}">
        <img src="${thumb}" alt="${title}" loading="lazy">
      </button>
    `;
  }

  if (cat === 'video') {
    return `
      <button type="button" class="zcPerfilMediaThumb is-video" data-open-media="1" data-media-index="${idx}" title="${title}">
        <img src="${thumb || url}" alt="${title}" loading="lazy">
        <span class="zcPerfilMediaThumbPlay"><i class="fa-solid fa-play"></i></span>
      </button>
    `;
  }

  if (cat === 'audio') {
    return `
      <button type="button" class="zcPerfilMediaThumb is-file" data-open-media="1" data-media-index="${idx}" title="${title}">
        <span class="zcPerfilMediaThumbFileIco"><i class="fa-solid fa-waveform"></i></span>
        <span class="zcPerfilMediaThumbFileTxt">Áudio</span>
      </button>
    `;
  }

  return `
    <button type="button" class="zcPerfilMediaThumb is-file" data-open-media="1" data-media-index="${idx}" title="${title}">
      <span class="zcPerfilMediaThumbFileIco"><i class="fa-regular fa-file-lines"></i></span>
      <span class="zcPerfilMediaThumbFileTxt">Doc</span>
    </button>
  `;
}

function renderMediaModalItem(item = {}) {
  const cat = mediaCategory(item);
  const title = escapeHtml(mediaTitle(item));
  const url = escapeHtml(mediaUrl(item));
  const thumb = escapeHtml(mediaThumb(item));

  if (cat === 'imagem') {
    return `
      <a class="zcPerfilMediaModalCard" href="${url}" target="_blank" rel="noopener">
        <div class="zcPerfilMediaModalVisual">
          <img src="${thumb}" alt="${title}" loading="lazy">
        </div>
        <div class="zcPerfilMediaModalCaption">${title}</div>
      </a>
    `;
  }

  if (cat === 'video') {
    return `
      <a class="zcPerfilMediaModalCard is-video" href="${url}" target="_blank" rel="noopener">
        <div class="zcPerfilMediaModalVisual">
          <img src="${thumb || url}" alt="${title}" loading="lazy">
          <span class="zcPerfilMediaModalPlay"><i class="fa-solid fa-play"></i></span>
        </div>
        <div class="zcPerfilMediaModalCaption">${title}</div>
      </a>
    `;
  }

  if (cat === 'audio') {
    return `
      <a class="zcPerfilMediaModalFile" href="${url}" target="_blank" rel="noopener">
        <span class="zcPerfilMediaModalFileIco"><i class="fa-solid fa-waveform"></i></span>
        <span class="zcPerfilMediaModalFileBody">
          <strong>Áudio</strong>
          <small>${title}</small>
        </span>
      </a>
    `;
  }

  return `
    <a class="zcPerfilMediaModalFile" href="${url}" target="_blank" rel="noopener">
      <span class="zcPerfilMediaModalFileIco"><i class="fa-regular fa-file-lines"></i></span>
      <span class="zcPerfilMediaModalFileBody">
        <strong>Documento</strong>
        <small>${title}</small>
      </span>
    </a>
  `;
}

async function tryLoadAllMedia({ bust = false } = {}) {
  if (PERFIL_KIND_ATUAL === 'grupo') {
    return PERFIL_MEDIA_ITEMS;
  }

  const cid = getClienteIdFromCurrentSelection() || PERFIL_CLIENTE_ID;

  if (!cid || !EMPRESA_ID) return PERFIL_MEDIA_ITEMS;

  if (!bust) {
    const cached = getPerfilCache('media', 'cliente', cid);

    if (cached.hit && cached.fresh && Array.isArray(cached.value)) {
      PERFIL_MEDIA_ITEMS = cached.value;
      return PERFIL_MEDIA_ITEMS;
    }
  }

  try {
    const resp = await fetch(
      `/api/atendimento/clientes/${cid}/profile/media?empresa_id=${EMPRESA_ID}`,
      {
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      }
    );

    if (!resp.ok) throw new Error(`status ${resp.status}`);

    const data = await resp.json();

    if (Array.isArray(data)) {
      PERFIL_MEDIA_ITEMS = data;
    } else if (Array.isArray(data?.items)) {
      PERFIL_MEDIA_ITEMS = data.items;
    }

    setPerfilCache('media', 'cliente', cid, PERFIL_MEDIA_ITEMS, PERFIL_MEDIA_CACHE_TTL_MS);

    return PERFIL_MEDIA_ITEMS;
  } catch {
    const cached = getPerfilCache('media', 'cliente', cid, { allowStale: true });

    if (cached.hit && Array.isArray(cached.value)) {
      PERFIL_MEDIA_ITEMS = cached.value;
    }

    return PERFIL_MEDIA_ITEMS;
  }
}

/* =========================
   MODAL DE MÍDIAS
   ========================= */

function ensureMediaModal() {
  if (mediaModalRefs) return mediaModalRefs;

  const backdrop = document.createElement('div');
  backdrop.id = 'zcPerfilMediaBackdrop';
  backdrop.className = 'zcPerfilMediaBackdrop';

  const modal = document.createElement('div');
  modal.id = 'zcPerfilMediaModal';
  modal.className = 'zcPerfilMediaModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  modal.innerHTML = `
    <div class="zcPerfilMediaModalHead">
      <div class="zcPerfilMediaModalTitle">
        <span>Mídia, links e docs</span>
        <small id="zcPerfilMediaModalCount">0 itens</small>
      </div>
      <button type="button" id="zcPerfilMediaClose" class="zcPerfilMediaClose" aria-label="Fechar">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>

    <div class="zcPerfilMediaTabs" id="zcPerfilMediaTabs">
      <button type="button" class="zcPerfilMediaTab is-active" data-filter="all">Tudo</button>
      <button type="button" class="zcPerfilMediaTab" data-filter="imagem">Imagens</button>
      <button type="button" class="zcPerfilMediaTab" data-filter="video">Vídeos</button>
      <button type="button" class="zcPerfilMediaTab" data-filter="audio">Áudios</button>
      <button type="button" class="zcPerfilMediaTab" data-filter="documento">Docs</button>
    </div>

    <div class="zcPerfilMediaModalBody">
      <div id="zcPerfilMediaModalGrid" class="zcPerfilMediaModalGrid"></div>
    </div>
  `;

  document.body.append(backdrop, modal);

  mediaModalRefs = {
    backdrop,
    modal,
    close: $('#zcPerfilMediaClose', modal),
    tabs: $('#zcPerfilMediaTabs', modal),
    count: $('#zcPerfilMediaModalCount', modal),
    grid: $('#zcPerfilMediaModalGrid', modal),
  };

  bindMediaModal();

  return mediaModalRefs;
}

function bindMediaModal() {
  if (!mediaModalRefs || mediaModalBound) return;

  mediaModalBound = true;

  const m = mediaModalRefs;

  const close = () => {
    m.backdrop.classList.remove('is-open');
    m.modal.classList.remove('is-open');
  };

  on(m.close, 'click', close);

  on(m.backdrop, 'click', (e) => {
    if (e.target === m.backdrop) close();
  });

  on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && m.modal.classList.contains('is-open')) {
      close();
    }
  });

  on(m.tabs, 'click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;

    PERFIL_MEDIA_FILTER = btn.dataset.filter || 'all';

    renderMediaModal();
  });
}

function renderMediaModal() {
  const m = ensureMediaModal();
  const all = Array.isArray(PERFIL_MEDIA_ITEMS) ? PERFIL_MEDIA_ITEMS : [];

  const filtered = PERFIL_MEDIA_FILTER === 'all'
    ? all
    : all.filter((item) => mediaCategory(item) === PERFIL_MEDIA_FILTER);

  if (m.count) {
    m.count.textContent = `${filtered.length} item(ns)`;
  }

  const tabButtons = m.tabs?.querySelectorAll('[data-filter]') || [];

  tabButtons.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.filter === PERFIL_MEDIA_FILTER);
  });

  if (!filtered.length) {
    m.grid.innerHTML = `<div class="zcPerfilMediaModalEmpty">Nenhuma mídia encontrada.</div>`;
    return;
  }

  m.grid.innerHTML = filtered.map(renderMediaModalItem).join('');
}

async function openMediaModal(filter = 'all') {
  ensureMediaModal();

  PERFIL_MEDIA_FILTER = filter || 'all';

  await tryLoadAllMedia();

  renderMediaModal();

  mediaModalRefs.backdrop.classList.add('is-open');
  mediaModalRefs.modal.classList.add('is-open');
}

/* =========================
   DRAWER
   ========================= */

function refreshBannerIcon(container) {
  const slot = container?.querySelector('.b-ico');

  if (slot) {
    slot.innerHTML = bannerSvg(getTheme());
  }
}

function setBanner(msg, tip = '') {
  const banner = $('#zcPerfilBanner');

  if (!banner) return;

  const msgEl = banner.querySelector('.b-msg');
  const tipEl = banner.querySelector('.b-tip');

  if (msgEl) msgEl.innerHTML = msg || '';
  if (tipEl) tipEl.textContent = tip;

  refreshBannerIcon(banner);
}

function setBannerTip(tip) {
  const tipEl = $('#zcPerfilBanner .b-tip');

  if (!tipEl) return;

  tipEl.textContent = tip || '';

  try {
    tipEl.animate(
      [{ opacity: .25 }, { opacity: 1 }],
      { duration: 160, fill: 'forwards' }
    );
  } catch {}
}

function formatPhoneDisplay(j) {
  return (
    j?.telefone_fmt ||
    j?.telefone_e164 ||
    j?.telefone ||
    j?.remote_jid ||
    ''
  );
}

function renderMediaPreviewSection() {
  const r = ensureDrawer();
  const items = Array.isArray(PERFIL_MEDIA_ITEMS) ? PERFIL_MEDIA_ITEMS : [];
  const preview = previewMediaItems(items);

  if (!r.recentMedia) return;

  if (!preview.length) {
    r.recentMedia.innerHTML = `<div class="zcPerfilMediaPreviewEmpty">Nenhuma mídia para prévia.</div>`;
  } else {
    r.recentMedia.innerHTML = preview.map((item, idx) => renderMediaPreviewItem(item, idx)).join('');
  }

  r.recentMedia.querySelectorAll('[data-open-media]').forEach((btn) => {
    btn.addEventListener('click', () => openMediaModal('all'));
  });
}

function ensureDrawer() {
  if (drawerRefs) return drawerRefs;

  const UF_OPTIONS = UF_LIST.map((uf) => `<option value="${uf}">${uf}</option>`).join('');

  const backdrop = document.createElement('div');
  backdrop.id = 'zcPerfilBackdrop';
  backdrop.className = 'zcPerfil-backdrop';

  const drawer = document.createElement('aside');
  drawer.id = 'zcPerfilDrawer';
  drawer.className = 'zcPerfil-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');

  drawer.innerHTML = `
    <div class="zcPerfil-head">
      <div class="zcPerfil-title" id="zcPerfilTitle">
        ${iconSvg(getTheme())}
        <span>Dados do cliente</span>
      </div>

      <button class="zcPerfil-close" id="zcPerfilClose" title="Fechar" aria-label="Fechar">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 256 256" aria-hidden="true">
          <path fill="currentColor" d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66A8 8 0 0 1 61.66 50.34L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128z"/>
        </svg>
      </button>
    </div>

    <div class="zcPerfil-body">
      <div class="zcPerfil-banner" id="zcPerfilBanner" aria-live="polite">
        <span class="b-ico"></span>
        <div>
          <div class="b-msg"></div>
          <div class="b-tip"></div>
        </div>
      </div>

      <section class="zcPerfilSummary" id="zcPerfilSummary">
        <div class="zcPerfilHero">
          <div class="zcPerfilAvatarWrap">
            <img id="pf_avatar" class="zcPerfilAvatar" alt="" hidden>
            <div id="pf_avatar_fallback" class="zcPerfilAvatarFallback">
              <i class="fa-regular fa-user"></i>
            </div>
          </div>

          <div class="zcPerfilHeroInfo">
            <div id="pf_display_name" class="zcPerfilDisplayName">Cliente</div>
            <div id="pf_display_phone" class="zcPerfilDisplayPhone"></div>

            <div class="zcPerfilBadges">
              <span id="pf_badge_business" class="zcPerfilPill" hidden>Conta comercial</span>
              <span id="pf_badge_status" class="zcPerfilPill is-soft" hidden>Status disponível</span>
            </div>
          </div>

          <button id="pf_refresh_btn" type="button" class="zcPerfilRefreshBtn" title="Atualizar dados do WhatsApp">
            <i class="fa-solid fa-rotate-right"></i>
          </button>
        </div>

        <div id="pf_sync_note" class="zcPerfilSyncNote"></div>

        <div class="zcPerfilInfoGrid">
          <div class="zcPerfilMiniCard">
            <div class="zcPerfilMiniLabel">Status do WhatsApp</div>
            <div id="pf_status_text" class="zcPerfilMiniValue is-pre">—</div>
          </div>

          <div id="pf_business_card" class="zcPerfilMiniCard" hidden>
            <div class="zcPerfilMiniLabel">Informações comerciais</div>
            <div class="zcPerfilBusinessList">
              <div><span>E-mail:</span> <strong id="pf_business_email">—</strong></div>
              <div><span>Descrição:</span> <strong id="pf_business_description">—</strong></div>
              <div><span>Website:</span> <strong id="pf_business_website">—</strong></div>
            </div>
          </div>
        </div>

        <div class="zcPerfilMediaCard">
          <div class="zcPerfilSectionHead">
            <div class="zcPerfilSectionTitle">Mídia, links e docs</div>
            <div id="pf_media_total" class="zcPerfilSectionMeta">0 itens</div>
          </div>

          <div class="zcPerfilMediaSummary" id="pf_media_summary">
            <span class="zcPerfilMediaChip">Imagens: <strong id="pf_media_imagens">0</strong></span>
            <span class="zcPerfilMediaChip">Vídeos: <strong id="pf_media_videos">0</strong></span>
            <span class="zcPerfilMediaChip">Áudios: <strong id="pf_media_audios">0</strong></span>
            <span class="zcPerfilMediaChip">Docs: <strong id="pf_media_documentos">0</strong></span>
          </div>

          <div class="zcPerfilMediaPreview" id="pf_recent_media">
            <div class="zcPerfilMediaPreviewEmpty">Nenhuma mídia para prévia.</div>
          </div>

          <div class="zcPerfilMediaActions">
            <button type="button" id="pf_media_open" class="zcPerfil-btnMini">
              Ver tudo
            </button>
          </div>
        </div>
      </section>

      <div class="zcPerfil-stack">
        <div class="zcPerfil-field">
          <label>Nome completo</label>
          <input id="pf_nome_completo" autocomplete="off" maxlength="120">
        </div>

        <div class="zcPerfil-field">
          <label>CPF/CNPJ</label>
          <input id="pf_cpf_cnpj" autocomplete="off" inputmode="numeric" maxlength="18" placeholder="CPF ou CNPJ">
        </div>

        <div class="zcPerfil-field">
          <label>RG</label>
          <input id="pf_rg" autocomplete="off" maxlength="12" placeholder="00.000.000-X">
        </div>

        <div class="zcPerfil-field">
          <label>E-mail</label>
          <input id="pf_email" type="email" autocomplete="off" maxlength="120" placeholder="email@dominio.com">
        </div>

        <div class="zcPerfil-row zcPerfil-row--datagen">
          <div class="zcPerfil-field field--dob">
            <label>Data de nascimento</label>
            <input id="pf_data_nasc" autocomplete="off" inputmode="numeric" maxlength="10" placeholder="DD/MM/AAAA">
          </div>

          <div class="zcPerfil-field field--genero">
            <label>Gênero</label>
            <div class="zcPerfil-selectWrap">
              <select id="pf_genero">
                <option value="">Selecione…</option>
                <option value="Masculino">Masculino</option>
                <option value="Feminino">Feminino</option>
                <option value="Outro">Outro</option>
                <option value="Prefiro não dizer">Prefiro não dizer</option>
              </select>
            </div>
          </div>
        </div>

        <div class="zcPerfil-row zcPerfil-row--cepuf">
          <div class="zcPerfil-field field--cep">
            <label>CEP</label>
            <input id="pf_cep" autocomplete="off" inputmode="numeric" maxlength="9" placeholder="00000-000">
          </div>

          <div class="zcPerfil-field field--uf">
            <label>Estado (UF)</label>
            <div class="zcPerfil-selectWrap">
              <select id="pf_estado">
                <option value="">UF</option>
                ${UF_OPTIONS}
              </select>
            </div>
          </div>
        </div>

        <div class="zcPerfil-field">
          <label>Endereço</label>
          <input id="pf_endereco" autocomplete="off" maxlength="80" placeholder="Rua, Av., Travessa…">
        </div>

        <div class="zcPerfil-row zcPerfil-row--numcomp">
          <div class="zcPerfil-field field--numero">
            <label>Número</label>
            <input id="pf_numero" autocomplete="off" inputmode="numeric" maxlength="8">
          </div>

          <div class="zcPerfil-field field--complemento">
            <label>Complemento</label>
            <input id="pf_complemento" autocomplete="off" maxlength="40" placeholder="Apto, Bloco, Casa, Sala…">
          </div>
        </div>

        <div class="zcPerfil-field">
          <label>Bairro</label>
          <input id="pf_bairro" autocomplete="off" maxlength="50">
        </div>

        <div class="zcPerfil-field">
          <label>Cidade</label>
          <input id="pf_cidade" autocomplete="off" maxlength="50">
        </div>
      </div>

      <div class="zcPerfil-actions">
        <button class="zcPerfil-btnPrimary" id="zcPerfilSave" type="button">Salvar</button>
        <button class="zcPerfil-btnGhost" id="zcPerfilCancel" type="button">Cancelar</button>
      </div>
    </div>
  `;

  document.body.append(backdrop, drawer);

  drawerRefs = {
    backdrop,
    drawer,

    title: $('#zcPerfilTitle', drawer),
    banner: $('#zcPerfilBanner', drawer),
    save: $('#zcPerfilSave', drawer),
    cancel: $('#zcPerfilCancel', drawer),
    close: $('#zcPerfilClose', drawer),

    avatar: $('#pf_avatar', drawer),
    avatarFallback: $('#pf_avatar_fallback', drawer),
    displayName: $('#pf_display_name', drawer),
    displayPhone: $('#pf_display_phone', drawer),
    badgeBusiness: $('#pf_badge_business', drawer),
    badgeStatus: $('#pf_badge_status', drawer),
    statusText: $('#pf_status_text', drawer),
    businessCard: $('#pf_business_card', drawer),
    businessEmail: $('#pf_business_email', drawer),
    businessDescription: $('#pf_business_description', drawer),
    businessWebsite: $('#pf_business_website', drawer),
    refreshBtn: $('#pf_refresh_btn', drawer),
    syncNote: $('#pf_sync_note', drawer),

    mediaTotal: $('#pf_media_total', drawer),
    mediaImagens: $('#pf_media_imagens', drawer),
    mediaVideos: $('#pf_media_videos', drawer),
    mediaAudios: $('#pf_media_audios', drawer),
    mediaDocumentos: $('#pf_media_documentos', drawer),
    recentMedia: $('#pf_recent_media', drawer),
    mediaOpen: $('#pf_media_open', drawer),

    nome: $('#pf_nome_completo', drawer),
    cpfCnpj: $('#pf_cpf_cnpj', drawer),
    rg: $('#pf_rg', drawer),
    email: $('#pf_email', drawer),
    dataNasc: $('#pf_data_nasc', drawer),
    genero: $('#pf_genero', drawer),
    cep: $('#pf_cep', drawer),
    endereco: $('#pf_endereco', drawer),
    numero: $('#pf_numero', drawer),
    complemento: $('#pf_complemento', drawer),
    bairro: $('#pf_bairro', drawer),
    cidade: $('#pf_cidade', drawer),
    estado: $('#pf_estado', drawer),
  };

  bindDrawer();
  refreshDrawerIcons();

  return drawerRefs;
}

function refreshDrawerIcons() {
  if (!drawerRefs) return;

  if (drawerRefs.title) {
    const isGroup = PERFIL_KIND_ATUAL === 'grupo';
    drawerRefs.title.innerHTML = `${iconSvg(getTheme())}<span>${isGroup ? 'Dados do grupo' : 'Dados do cliente'}</span>`;
  }

  refreshBannerIcon(drawerRefs.drawer);
}

function setPerfilDrawerMode(kind) {
  const r = ensureDrawer();
  const isGroup = kind === 'grupo';

  PERFIL_KIND_ATUAL = isGroup ? 'grupo' : 'cliente';

  if (r.title) {
    r.title.innerHTML = `${iconSvg(getTheme())}<span>${isGroup ? 'Dados do grupo' : 'Dados do cliente'}</span>`;
  }

  if (r.displayName) {
    r.displayName.textContent = isGroup ? 'Grupo' : 'Cliente';
  }

  if (r.displayPhone) {
    r.displayPhone.textContent = '';
  }

  const nomeLabel = r.nome?.closest('.zcPerfil-field')?.querySelector('label');
  if (nomeLabel) {
    nomeLabel.textContent = isGroup ? 'Nome do grupo' : 'Nome completo';
  }

  const personalFields = [
    r.cpfCnpj?.closest('.zcPerfil-field'),
    r.rg?.closest('.zcPerfil-field'),
    r.email?.closest('.zcPerfil-field'),
    r.dataNasc?.closest('.zcPerfil-field'),
    r.genero?.closest('.zcPerfil-field'),
    r.cep?.closest('.zcPerfil-field'),
    r.estado?.closest('.zcPerfil-field'),
    r.endereco?.closest('.zcPerfil-field'),
    r.numero?.closest('.zcPerfil-field'),
    r.complemento?.closest('.zcPerfil-field'),
    r.bairro?.closest('.zcPerfil-field'),
    r.cidade?.closest('.zcPerfil-field'),
  ];

  personalFields.forEach((el) => {
    if (el) el.hidden = isGroup;
  });

  if (r.save) {
    r.save.hidden = isGroup;
  }

  if (r.cancel) {
    r.cancel.textContent = isGroup ? 'Fechar' : 'Cancelar';
  }

  if (r.refreshBtn) {
    r.refreshBtn.hidden = false;
    r.refreshBtn.title = isGroup
      ? 'Atualizar dados do grupo no WhatsApp'
      : 'Atualizar dados do WhatsApp';
  }
}

function bindDrawer() {
  if (!drawerRefs || drawerBound) return;

  drawerBound = true;

  const r = drawerRefs;

  const close = () => {
    abortPerfilRequests();

    PERFIL_CLIENTE_ID = 0;
    PERFIL_GRUPO_ID = 0;
    PERFIL_KIND_ATUAL = 'cliente';

    r.backdrop.classList.remove('is-open');
    r.drawer.classList.remove('is-open');
  };

  on(r.close, 'click', close);
  on(r.cancel, 'click', close);

  on(r.backdrop, 'click', (e) => {
    if (e.target === r.backdrop) close();
  });

  on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && r.drawer.classList.contains('is-open')) {
      close();
    }
  });

  maskInput(r.cpfCnpj, fmtCPForCNPJ, validCPForCNPJ);
  maskInput(r.rg, fmtRG, null);
  maskInput(r.cep, fmtCEP, (v) => isValidCEP(v) || v === '');
  maskInput(r.numero, fmtNumero, null);
  maskInput(r.complemento, fmtComplemento, null);
  maskInput(r.cidade, fmtCidade, null);
  maskInput(r.dataNasc, fmtDataBR, (v) => isValidDataBR(v) || v === '');

  if (r.email) {
    const applyEmail = () => {
      r.email.value = String(r.email.value || '').trim().toLowerCase();

      const ok = isValidEmail(r.email.value);

      r.email.classList.toggle('is-invalid', !ok);
      r.email.title = ok ? '' : 'E-mail inválido';
    };

    on(r.email, 'blur', applyEmail);
    applyEmail();
  }

  on(r.cep, 'blur', async () => {
    const ok = await preencherPorCEP(r.cep.value);

    if (!ok && onlyDigits(r.cep.value).length === 8) {
      setBannerTip('Não foi possível sugerir o endereço para este CEP.');
    }
  });

  on(r.save, 'click', salvarPerfil);

  on(r.refreshBtn, 'click', async () => {
    await refreshEvolutionProfile();
  });

  on(r.mediaOpen, 'click', async () => {
    await openMediaModal('all');
  });
}

function openDrawer() {
  const r = ensureDrawer();

  r.backdrop.classList.add('is-open');
  r.drawer.classList.add('is-open');

  setTimeout(() => {
    if (PERFIL_KIND_ATUAL === 'cliente') {
      r.nome?.focus();
    }
  }, 0);
}

function resetForm() {
  const r = ensureDrawer();

  [
    r.nome,
    r.cpfCnpj,
    r.rg,
    r.email,
    r.dataNasc,
    r.cep,
    r.endereco,
    r.numero,
    r.complemento,
    r.bairro,
    r.cidade,
  ].forEach((el) => {
    if (el) el.value = '';
  });

  if (r.estado) r.estado.value = '';
  if (r.genero) r.genero.value = '';

  [r.cpfCnpj, r.email, r.dataNasc].forEach((el) => {
    el?.classList.remove('is-invalid');

    if (el) el.title = '';
  });
}

function resetSummary() {
  const r = ensureDrawer();

  PERFIL_MEDIA_ITEMS = [];

  if (r.avatar) {
    r.avatar.hidden = true;
    r.avatar.removeAttribute('src');
  }

  if (r.avatarFallback) {
    r.avatarFallback.hidden = false;
  }

  if (r.displayName) {
    r.displayName.textContent = PERFIL_KIND_ATUAL === 'grupo' ? 'Grupo' : 'Cliente';
  }

  if (r.displayPhone) r.displayPhone.textContent = '';
  if (r.badgeBusiness) r.badgeBusiness.hidden = true;
  if (r.badgeStatus) r.badgeStatus.hidden = true;
  if (r.statusText) r.statusText.textContent = '—';
  if (r.businessCard) r.businessCard.hidden = true;
  if (r.businessEmail) r.businessEmail.textContent = '—';
  if (r.businessDescription) r.businessDescription.textContent = '—';
  if (r.businessWebsite) r.businessWebsite.textContent = '—';
  if (r.syncNote) r.syncNote.textContent = '';

  if (r.mediaTotal) r.mediaTotal.textContent = '0 itens';
  if (r.mediaImagens) r.mediaImagens.textContent = '0';
  if (r.mediaVideos) r.mediaVideos.textContent = '0';
  if (r.mediaAudios) r.mediaAudios.textContent = '0';
  if (r.mediaDocumentos) r.mediaDocumentos.textContent = '0';

  if (r.recentMedia) {
    r.recentMedia.innerHTML = `<div class="zcPerfilMediaPreviewEmpty">Nenhuma mídia para prévia.</div>`;
  }
}

function applyProfileToSummary(j = {}) {
  const r = ensureDrawer();
  const isGroup = PERFIL_KIND_ATUAL === 'grupo' || j.kind === 'grupo';

  const displayName =
    j.nome_whatsapp ||
    j.nome_completo ||
    j.nome ||
    (isGroup ? 'Grupo' : 'Cliente');

  const phone = formatPhoneDisplay(j);
  const isBusiness = !isGroup && !!j.is_business;
  const statusText = String(j.status_text || '').trim();
  const avatarUrl = j.avatar_url || '';

  if (r.displayName) r.displayName.textContent = displayName;
  if (r.displayPhone) r.displayPhone.textContent = phone || '';

  if (avatarUrl) {
    r.avatar.hidden = false;
    r.avatar.src = avatarUrl;
    r.avatar.alt = displayName;
    r.avatarFallback.hidden = true;

    r.avatar.onerror = () => {
      r.avatar.hidden = true;
      r.avatarFallback.hidden = false;
    };
  } else {
    r.avatar.hidden = true;
    r.avatar.removeAttribute('src');
    r.avatarFallback.hidden = false;
  }

  if (r.badgeBusiness) {
    r.badgeBusiness.hidden = !isBusiness;
  }

  if (r.badgeStatus) {
    if (isGroup) {
      r.badgeStatus.hidden = false;
      r.badgeStatus.textContent = 'Grupo';
    } else {
      r.badgeStatus.hidden = !statusText;
      r.badgeStatus.textContent = 'Status disponível';
    }
  }

  if (r.statusText) {
    r.statusText.textContent = statusText || (isGroup ? 'Grupo do WhatsApp' : 'Sem status disponível');
  }

  if (isBusiness) {
    if (r.businessCard) r.businessCard.hidden = false;
    if (r.businessEmail) r.businessEmail.textContent = j.email || '—';
    if (r.businessDescription) r.businessDescription.textContent = j.description || '—';

    if (r.businessWebsite) {
      r.businessWebsite.innerHTML = j.website
        ? `<a class="qcLink" href="${escapeHtml(j.website)}" target="_blank" rel="noopener">${escapeHtml(j.website)}</a>`
        : '—';
    }
  } else {
    if (r.businessCard) r.businessCard.hidden = true;
  }

  PERFIL_MEDIA_ITEMS = Array.isArray(j.midias_recentes) ? j.midias_recentes : [];

  const resumo = j.midias_resumo || calcMediaCounts(PERFIL_MEDIA_ITEMS);

  if (r.mediaTotal) r.mediaTotal.textContent = `${Number(resumo.total || 0)} item(ns)`;
  if (r.mediaImagens) r.mediaImagens.textContent = String(Number(resumo.imagens || 0));
  if (r.mediaVideos) r.mediaVideos.textContent = String(Number(resumo.videos || 0));
  if (r.mediaAudios) r.mediaAudios.textContent = String(Number(resumo.audios || 0));
  if (r.mediaDocumentos) r.mediaDocumentos.textContent = String(Number(resumo.documentos || 0));

  renderMediaPreviewSection();
}

function applyProfileToForm(j = {}) {
  const r = ensureDrawer();
  const isGroup = PERFIL_KIND_ATUAL === 'grupo' || j.kind === 'grupo';

  if (isGroup) {
    r.nome.value = j.nome_completo || j.nome_whatsapp || j.nome || '';
    return;
  }

  r.nome.value = j.nome_completo || '';
  r.cpfCnpj.value = fmtCPForCNPJ(j.cpf_cnpj || '');
  r.rg.value = fmtRG(j.rg || '');
  r.email.value = String(j.email || '').trim().toLowerCase();

  const nascRaw = j.data_nascimento || j.nascimento || j.dataNascimento || '';
  r.dataNasc.value = toDataBRFromAny(nascRaw);

  r.genero.value = j.genero || j.sexo || '';
  r.cep.value = fmtCEP(j.cep || '');
  r.endereco.value = j.endereco || '';
  r.numero.value = fmtNumero(j.numero || '');
  r.complemento.value = fmtComplemento(j.complemento || '');
  r.bairro.value = j.bairro || '';
  r.cidade.value = fmtCidade(j.cidade || '');

  const uf = fmtUF(j.estado || '');

  if (UF_SET.has(uf)) {
    r.estado.value = uf;
  } else {
    r.estado.value = '';
  }
}

function applyProfile(j = {}, { syncForm = false, syncNote = '' } = {}) {
  applyProfileToSummary(j);

  if (syncForm) {
    applyProfileToForm(j);
  }

  if (syncNote) {
    setBannerTip(syncNote);
  }
}

function setLoadingState(loading, text = '') {
  const r = ensureDrawer();

  if (r.refreshBtn) {
    r.refreshBtn.disabled = !!loading;
    r.refreshBtn.classList.toggle('is-loading', !!loading);
  }

  if (r.syncNote) {
    r.syncNote.textContent = text || '';
  }
}

/* =========================
   CARREGAR / ATUALIZAR
   ========================= */

async function carregarPerfilBanco(explicitId = null, opts = {}) {
  const kind = PERFIL_KIND_ATUAL === 'grupo' ? 'grupo' : 'cliente';
  const id = kind === 'grupo'
    ? getGrupoId(explicitId)
    : getClienteId(explicitId);

  const bust = opts.bust === true || opts.force === true;

  if (!id || !EMPRESA_ID) {
    toastLocal({
      title: kind === 'grupo' ? 'Selecione um grupo' : 'Selecione um cliente',
      type: 'error',
    });

    return null;
  }

  if (!bust) {
    const cached = getPerfilCache('profile', kind, id, { allowStale: true });

    if (cached.hit) {
      applyProfile(cached.value, {
        syncForm: true,
        syncNote: cached.fresh
          ? 'Dados carregados do cache local. Use “Atualizar” para consultar o WhatsApp.'
          : 'Exibindo cache local enquanto atualizamos os dados do sistema.',
      });

      if (cached.fresh) {
        return cached.value;
      }
    }
  }

  const req = beginPerfilRequest(id);

  try {
    const resp = await fetch(
      perfilProfileUrl(kind, id),
      {
        credentials: 'include',
        signal: req.signal,
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      }
    );

    if (!resp.ok) {
      throw new Error(`Falha ao buscar perfil (${resp.status})`);
    }

    const j = await resp.json();

    if (!isPerfilRequestStillValid(req.seq, id, kind)) {
      return null;
    }

    setPerfilCache('profile', kind, id, j, PERFIL_CACHE_TTL_MS);

    applyProfile(j, {
      syncForm: true,
      syncNote: kind === 'grupo'
        ? 'Dados do grupo carregados do sistema. Clique em atualizar para consultar o WhatsApp.'
        : 'Dados carregados do sistema. Clique em atualizar para consultar o WhatsApp.',
    });

    return j;
  } catch (err) {
    if (err?.name === 'AbortError') return null;

    console.error('[perfil] carregar banco', err);

    if (!isPerfilRequestStillValid(req.seq, id, kind)) {
      return null;
    }

    const fallback = getPerfilCache('profile', kind, id, { allowStale: true });

    if (fallback.hit) {
      applyProfile(fallback.value, {
        syncForm: true,
        syncNote: 'Não conseguimos consultar o sistema agora. Exibindo último cache salvo.',
      });

      return fallback.value;
    }

    toastLocal({
      title: 'Não foi possível carregar o perfil',
      type: 'error',
    });

    return null;
  }
}

async function refreshEvolutionProfile(explicitId = null) {
  const kind = PERFIL_KIND_ATUAL === 'grupo' ? 'grupo' : 'cliente';
  const id = kind === 'grupo'
    ? getGrupoId(explicitId)
    : getClienteId(explicitId);

  if (!id || !EMPRESA_ID) return null;

  const req = beginPerfilRequest(id);

  setLoadingState(
    true,
    kind === 'grupo'
      ? 'Atualizando dados do grupo…'
      : 'Atualizando dados do WhatsApp…'
  );

  try {
    const resp = await fetch(
      perfilProfileUrl(kind, id, '/refresh'),
      {
        method: 'POST',
        credentials: 'include',
        signal: req.signal,
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      }
    );

    if (!resp.ok) {
      throw new Error(`Falha no refresh (${resp.status})`);
    }

    const j = await resp.json();

    if (!isPerfilRequestStillValid(req.seq, id, kind)) {
      return null;
    }

    const r = ensureDrawer();

    const canSyncEmail = !String(r.email.value || '').trim();

    if (kind === 'cliente' && canSyncEmail && j.email) {
      r.email.value = String(j.email || '').trim().toLowerCase();
    }

    setPerfilCache('profile', kind, id, j, PERFIL_CACHE_TTL_MS);

    if (kind === 'cliente' && Array.isArray(j.midias_recentes)) {
      setPerfilCache('media', kind, id, j.midias_recentes, PERFIL_MEDIA_CACHE_TTL_MS);
    }

    applyProfile(j, {
      syncForm: false,
      syncNote: j.refreshed
        ? (kind === 'grupo'
          ? 'Dados do grupo atualizados via WhatsApp.'
          : 'Dados atualizados via WhatsApp.')
        : 'Não foi possível atualizar pela Evolution. Exibindo dados do sistema.',
    });

    toastLocal({
      title: 'Atualizado',
      msg: kind === 'grupo'
        ? 'Dados do grupo consultados com sucesso.'
        : 'Dados do WhatsApp consultados com sucesso.',
      type: 'ok',
    });

    try {
      if (kind === 'grupo' && typeof window.zcApplyGroupAvatarEverywhere === 'function') {
        window.zcApplyGroupAvatarEverywhere(id, j.avatar_url || null, { bust: true });
      }

      if (kind === 'cliente' && typeof window.zcApplyAvatarEverywhere === 'function') {
        window.zcApplyAvatarEverywhere(id, j.avatar_url || null, { bust: true });
      }
    } catch {}

    return j;
  } catch (err) {
    if (err?.name === 'AbortError') return null;

    console.warn('[perfil] refresh evolution', err);

    if (!isPerfilRequestStillValid(req.seq, id, kind)) {
      return null;
    }

    setBannerTip('Não foi possível atualizar agora pela Evolution.');

    toastLocal({
      title: 'Falha ao atualizar',
      msg: 'Não foi possível consultar o WhatsApp agora.',
      type: 'error',
    });

    return null;
  } finally {
    if (isPerfilRequestStillValid(req.seq, id, kind)) {
      setLoadingState(false, '');
    }
  }
}

/* =========================
   SALVAR
   ========================= */

async function salvarPerfil() {
  const kind = PERFIL_KIND_ATUAL === 'grupo' ? 'grupo' : 'cliente';

  if (kind === 'grupo') {
    toastLocal({
      title: 'Dados do grupo',
      msg: 'Por enquanto o grupo é somente visualização neste drawer.',
      type: 'ok',
    });

    return;
  }

  const cid = getClienteId();

  if (!cid || !EMPRESA_ID) {
    toastLocal({
      title: 'Selecione um cliente',
      type: 'error',
    });

    return;
  }

  const r = ensureDrawer();

  const email = String(r.email.value || '').trim().toLowerCase();
  const cpfcnpj = r.cpfCnpj.value || '';
  const cep = r.cep.value || '';
  const ufSel = r.estado.value || '';
  const dnBr = r.dataNasc.value || '';
  const generoSel = String(r.genero.value || '').trim();

  const invalids = [];

  if (!isValidEmail(email)) invalids.push('E-mail inválido');
  if (!validCPForCNPJ(cpfcnpj)) invalids.push('CPF/CNPJ inválido');
  if (cep && !isValidCEP(cep)) invalids.push('CEP inválido');
  if (ufSel && !UF_SET.has(ufSel)) invalids.push('UF inválida');
  if (dnBr && !isValidDataBR(dnBr)) invalids.push('Data de nascimento inválida');

  if (invalids.length) {
    toastLocal({
      title: 'Verifique os campos',
      msg: invalids.join(' · '),
      type: 'error',
    });

    return;
  }

  const payload = {
    nome_completo: String(r.nome.value || '').trim() || undefined,
    cpf_cnpj: onlyDigits(cpfcnpj) || undefined,
    rg: String(r.rg.value || '').replace(/\./g, '').toUpperCase() || undefined,
    email: email || undefined,
    data_nascimento: dnBr ? toISOFromDataBR(dnBr) : undefined,
    genero: generoSel || undefined,
    cep: onlyDigits(cep) || undefined,
    endereco: String(r.endereco.value || '').trim() || undefined,
    numero: onlyDigits(r.numero.value || '') || undefined,
    complemento: String(r.complemento.value || '').trim() || undefined,
    bairro: String(r.bairro.value || '').trim() || undefined,
    cidade: String(r.cidade.value || '').trim() || undefined,
    estado: String(ufSel || '').toUpperCase() || undefined,
  };

  r.save.disabled = true;
  r.save.textContent = 'Salvando…';

  try {
    const resp = await fetch(
      perfilProfileUrl('cliente', cid),
      {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
      }
    );

    if (!resp.ok) {
      throw new Error(`Falha ao salvar (${resp.status})`);
    }

    invalidatePerfilCache('cliente', cid);

    setBannerTip('Dados salvos com sucesso.');

    toastLocal({
      title: 'Salvo',
      msg: 'Informações do cliente atualizadas.',
      type: 'ok',
    });

    await carregarPerfilBanco(cid, { bust: true });
  } catch (err) {
    console.error('[perfil] salvar()', err);

    toastLocal({
      title: 'Erro ao salvar',
      msg: 'Não foi possível atualizar o cliente.',
      type: 'error',
    });
  } finally {
    r.save.disabled = false;
    r.save.textContent = 'Salvar';
  }
}

/* =========================
   API GLOBAL
   ========================= */

export async function abrirPerfilAtual(opts = {}) {
  if (getPerfilSelectedKind(opts) === 'grupo') {
    return abrirPerfilGrupoAtual(opts);
  }

  const explicit =
    opts?.cliente_id ??
    opts?.clienteId ??
    opts?.id ??
    null;

  const cid = explicit
    ? Number(explicit)
    : Number(getClienteIdFromCurrentSelection());

  if (!Number.isFinite(cid) || cid <= 0) {
    toastLocal({
      title: 'Selecione um cliente',
      type: 'error',
    });

    return;
  }

  abortPerfilRequests();

  PERFIL_KIND_ATUAL = 'cliente';
  PERFIL_CLIENTE_ID = cid;
  PERFIL_GRUPO_ID = 0;

  window.__perfilKindAtual = 'cliente';
  window.__perfilClienteIdAtual = cid;

  ensureDrawer();
  ensureMediaModal();
  setPerfilDrawerMode('cliente');
  resetForm();
  resetSummary();
  openDrawer();

  setBanner(
    'Abrimos os dados salvos no sistema. Para consultar foto, status e dados comerciais do WhatsApp em tempo real, clique em “Atualizar”.',
    ''
  );

  await carregarPerfilBanco(cid);
}

export async function abrirPerfilGrupoAtual(opts = {}) {
  const explicit =
    opts?.grupo_id ??
    opts?.grupoId ??
    opts?.group_id ??
    opts?.groupId ??
    opts?.id ??
    null;

  const gid = getGrupoId(explicit);

  if (!Number.isFinite(gid) || gid <= 0) {
    toastLocal({
      title: 'Selecione um grupo',
      type: 'error',
    });

    return;
  }

  abortPerfilRequests();

  PERFIL_KIND_ATUAL = 'grupo';
  PERFIL_GRUPO_ID = gid;
  PERFIL_CLIENTE_ID = 0;

  window.__perfilKindAtual = 'grupo';
  window.__perfilGrupoIdAtual = gid;

  ensureDrawer();
  ensureMediaModal();
  setPerfilDrawerMode('grupo');
  resetForm();
  resetSummary();
  openDrawer();

  setBanner(
    'Abrimos os dados do grupo salvos no sistema. Para consultar foto e nome do grupo no WhatsApp, clique em “Atualizar”.',
    ''
  );

  await carregarPerfilBanco(gid);
}

window.abrirPerfilAtual = abrirPerfilAtual;
window.abrirPerfilGrupoAtual = abrirPerfilGrupoAtual;
window.abrirGrupoAtual = abrirPerfilGrupoAtual;
window.abrirDadosGrupoAtual = abrirPerfilGrupoAtual;
window.openGroupProfile = abrirPerfilGrupoAtual;
window.openGroupData = abrirPerfilGrupoAtual;

document.addEventListener('zc:open-group-data', (ev) => {
  try {
    abrirPerfilGrupoAtual(ev?.detail || {});
  } catch {}
});

/* =========================
   LIMPEZA DO BOTÃO ANTIGO
   ========================= */

(function cleanupOldHeaderButton() {
  function removeBtn() {
    const oldBtn = document.getElementById('btn-perfil');
    if (oldBtn) oldBtn.remove();
  }

  removeBtn();

  const hdr = document.getElementById('chat-header');

  if (hdr) {
    const mo = new MutationObserver(() => removeBtn());
    mo.observe(hdr, { childList: true, subtree: true });
  }
})();