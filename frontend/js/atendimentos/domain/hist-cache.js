// /frontend/js/atendimentos/domain/hist-cache.js
// Cache local de histórico (instância + conversa) com dedup por msg_id
// e fallback por (ts + trecho de conteúdo).
//
// Correção de performance:
// - Não deixa histórico crescer infinito no navegador.
// - Salva cache com TTL.
// - Limita mensagens por conversa.
// - Limpa cache legado pesado.
// - Evita guardar base64/raw pesado de mídia no localStorage.
// - Mantém compatibilidade com window.cacheHistoricos e funções antigas.

import { cacheGet, cacheSet, cacheDel } from '../core/cache.js';

/* =====================================================================
   CONFIGURAÇÃO DE PERFORMANCE
   ===================================================================== */

/*
  Quantas mensagens no máximo o navegador guarda por conversa.

  180 é um número seguro:
  - suficiente para abrir rápido;
  - não estoura memória;
  - histórico antigo continua vindo do banco quando precisar.
*/
const HIST_MAX_MESSAGES = Number(window.ZC_HIST_MAX_MESSAGES || 80);

/*
  Tempo que o histórico fica salvo no localStorage.
  Depois disso, o navegador limpa e busca de novo quando precisar.
*/
const HIST_CACHE_TTL_MS = Number(
  window.ZC_HIST_CACHE_TTL_MS || 6 * 60 * 60 * 1000
); // 6 horas

/*
  Cursor pode durar um pouco mais, mas também não deve ser infinito.
*/
const HIST_CURSOR_TTL_MS = Number(
  window.ZC_HIST_CURSOR_TTL_MS || 12 * 60 * 60 * 1000
); // 12 horas

/*
  Quantas conversas ficam espelhadas em memória.
  Isso impede o window.cacheHistoricos de virar um monstro.
*/
const HIST_MIRROR_MAX_CONVERSAS = Number(
  window.ZC_HIST_MIRROR_MAX_CONVERSAS || 6
);

/*
  Se algum cache antigo estiver gigante, limpa automaticamente.
*/
const HIST_BIG_CACHE_BYTES = Number(
  window.ZC_HIST_BIG_CACHE_BYTES || 1_500_000
); // ~1.5 MB por chave

/*
  Por padrão vamos remover cache legado de histórico.
  Isso é importante porque o sistema novo já usa chave por instância + conversa.
*/
const HIST_REMOVE_LEGACY_CACHE = window.ZC_HIST_REMOVE_LEGACY_CACHE !== false;

/*
  RAM primeiro: por padrão NÃO persistimos histórico no localStorage.
  Mantemos só em memória limitada. O banco é a fonte real do histórico.
  Se algum dia quiser voltar a salvar, defina window.ZC_HIST_SAVE_TO_LS = true antes do boot.
*/
const HIST_SAVE_TO_LOCALSTORAGE = window.ZC_HIST_SAVE_TO_LS === true;

/* =====================================================================
   Utils
   ===================================================================== */

function toMillis(ts) {
  if (ts == null) return 0;

  if (typeof ts === 'number') {
    if (ts > 1e12) return Math.floor(ts);
    if (ts > 1e8) return Math.floor(ts * 1000);
    return 0;
  }

  const n = Number(ts);
  if (Number.isFinite(n)) return toMillis(n);

  const p = Date.parse(String(ts));
  return Number.isFinite(p) ? p : 0;
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(v, min, max, fallback) {
  const n = Math.floor(safeNumber(v, fallback));
  return Math.max(min, Math.min(max, n));
}

const MAX_MESSAGES_SAFE = clampInt(HIST_MAX_MESSAGES, 30, 180, 80);

function _norm(v) {
  return (v ?? '').toString().trim();
}

const _tsOf = (m) => {
  const t = m?.timestamp || m?.ts || m?.data || m?.created_at || null;
  const d = t ? new Date(t) : null;
  return d && !isNaN(d) ? d.getTime() : 0;
};

const _isTmp = (m) => {
  const id = m?.msg_id || m?.id || '';
  return typeof id === 'string' && id.startsWith('tmp:');
};

/* =====================================================================
   Sanitização de mídia
   ===================================================================== */

const HEAVY_KEYS = new Set([
  'base64',
  'b64',
  'filebase64',
  'file_base64',
  'data',
  'raw',
  'buffer',
  'bytes',
  'binary',
  'stream',
  'bodybase64',
  'media_base64',
  'mediaBase64',
]);

function isHeavyKey(key) {
  return HEAVY_KEYS.has(String(key || '').trim().toLowerCase());
}

function sanitizeMediaObject(obj, depth = 0) {
  if (obj == null) return obj;

  if (typeof obj === 'string') {
    /*
      Não deixa string gigante ir para o cache.
      Normalmente isso é base64, payload bruto ou dataURL.
    */
    if (obj.length > 4000) return '';
    return obj;
  }

  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj
      .slice(0, 20)
      .map((x) => sanitizeMediaObject(x, depth + 1))
      .filter((x) => x !== undefined);
  }

  if (depth > 3) {
    return null;
  }

  const out = {};

  Object.entries(obj).forEach(([key, value]) => {
    if (isHeavyKey(key)) return;

    if (typeof value === 'string' && value.length > 4000) {
      return;
    }

    out[key] = sanitizeMediaObject(value, depth + 1);
  });

  return out;
}

function sanitizeMidias(midias) {
  if (!Array.isArray(midias)) return [];

  return midias
    .slice(0, 20)
    .map((m) => sanitizeMediaObject(m))
    .filter(Boolean);
}

function sanitizeQuoted(obj) {
  if (!obj || typeof obj !== 'object') return obj || null;
  return sanitizeMediaObject(obj);
}

/* =====================================================================
   Normalização de mensagem
   ===================================================================== */

function normMsg(m) {
  const msg_id =
    m?.msg_id ?? m?.msgId ?? m?.message_id ?? m?.messageId ?? m?.id ?? null;

  const tipo =
    m?.tipo === 'saida' || m?.from_me === true || m?.origem === 'atendente'
      ? 'saida'
      : 'entrada';

  const tsRaw =
    m?.ts ??
    m?.timestamp ??
    m?.data ??
    m?.created_at ??
    m?.hora ??
    null;

  const isTmpId = typeof msg_id === 'string' && msg_id.startsWith('tmp:');
  const tsParsed = toMillis(tsRaw);

  const ts = Number.isFinite(tsParsed) && tsParsed > 0
    ? tsParsed
    : (isTmpId ? Date.now() : 0);

  let ack = null;

  if (tipo === 'saida') {
    const a = m?.ack ?? m?.delivery_ack ?? m?.status_ack;
    ack = a == null ? null : Number(a) || 0;
  }

  const midias = sanitizeMidias(Array.isArray(m?.midias) ? m.midias : []);

  const origem =
    m?.origem != null
      ? m.origem
      : tipo === 'saida' || m?.from_me === true
        ? 'atendente'
        : 'cliente';

  const autor_nome =
    m?.autor_nome ?? m?.atendente_nome ?? m?.user_nome ?? null;

  const quoted =
    m?.quoted ??
    m?.quote ??
    m?.quotedMessage ??
    m?.quoted_message ??
    null;

  const quoted_preview =
    m?.quoted_preview ??
    m?.quotedPreview ??
    m?.reply_preview ??
    m?.replyPreview ??
    null;

  const db_id =
    m?.db_id ??
    m?.mensagem_id ??
    m?.message_db_id ??
    m?.messageDbId ??
    (m?.msg_id ? m?.id : null) ??
    null;

  const normalized = {
    msg_id: msg_id || null,
    db_id: db_id || null,
    mensagem_id: db_id || null,
    conteudo: m?.conteudo ?? m?.texto ?? m?.mensagem ?? '',
    tipo,
    timestamp: tsRaw || (isTmpId ? new Date(ts).toISOString() : null),
    ack,
    midias,
    instancia_id: m?.instancia_id ?? null,
    instance_name: m?.instance_name ?? null,
    ts,
    origem: origem ?? null,
    autor_nome: autor_nome ?? null,
    apagada_cliente: Boolean(m?.apagada_cliente),
    apagada_usuario: Boolean(m?.apagada_usuario),
  };

  if (quoted && typeof quoted === 'object') {
    normalized.quoted = sanitizeQuoted(quoted);
  }

  if (quoted_preview && typeof quoted_preview === 'object') {
    normalized.quoted_preview = sanitizeQuoted(quoted_preview);
  }

  return normalized;
}

/* =====================================================================
   Compactação
   ===================================================================== */

function compactMessages(arr, mode = 'latest') {
  const list = Array.isArray(arr)
    ? arr
        .map(normMsg)
        .filter(Boolean)
        .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    : [];

  if (list.length <= MAX_MESSAGES_SAFE) return list;

  /*
    latest:
    - usado no fluxo normal.
    - mantém as mensagens mais recentes.

    oldest:
    - usado quando o usuário puxa histórico antigo.
    - mantém o bloco mais antigo carregado naquele momento.

    balanced:
    - mantém um pouco do começo e bastante do final.
  */
  if (mode === 'oldest') {
    return list.slice(0, MAX_MESSAGES_SAFE);
  }

  if (mode === 'balanced') {
    const headCount = Math.floor(MAX_MESSAGES_SAFE * 0.25);
    const tailCount = MAX_MESSAGES_SAFE - headCount;

    const head = list.slice(0, headCount);
    const tail = list.slice(-tailCount);

    const out = [];
    const seen = new Set();

    [...head, ...tail].forEach((m) => {
      const key = buildIdKey(m);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(m);
    });

    return out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  return list.slice(-MAX_MESSAGES_SAFE);
}

/* =====================================================================
   Temp message merge
   ===================================================================== */

function _findTmpCandidate(arr, incoming) {
  const isOut =
    incoming.tipo === 'saida' ||
    incoming.from_me === true ||
    incoming.origem === 'atendente';

  if (!isOut) return -1;

  const realId = incoming.msg_id;

  if (!realId || (typeof realId === 'string' && realId.startsWith('tmp:'))) {
    return -1;
  }

  const txt = _norm(incoming.conteudo || incoming.texto || incoming.caption || '');
  if (!txt) return -1;

  const now = Date.now();
  const WINDOW_MS = 15_000;

  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];

    if (!_isTmp(m)) continue;

    if (!(m.tipo === 'saida' || m.from_me === true || m.origem === 'atendente')) {
      continue;
    }

    const mt = _norm(m.conteudo || m.texto || m.caption || '');
    if (mt !== txt) continue;

    if (Math.abs(now - _tsOf(m)) > WINDOW_MS) continue;

    return i;
  }

  return -1;
}

/* =====================================================================
   Keys
   ===================================================================== */

function kHist(inst, convId) {
  return `hist:${String(inst || 'all')}:${String(convId)}`;
}

function kCurOld(inst, convId) {
  return `cursor:${String(inst || 'all')}:${String(convId)}:oldest`;
}

function kCurNew(inst, convId) {
  return `cursor:${String(inst || 'all')}:${String(convId)}:newest`;
}

/* =====================================================================
   In-memory mirror limitado
   ===================================================================== */

if (!window.cacheHistoricos) {
  window.cacheHistoricos = Object.create(null);
}

if (!window.__ZC_HIST_MIRROR_ORDER__) {
  window.__ZC_HIST_MIRROR_ORDER__ = [];
}

function touchMirrorKey(convId) {
  const key = String(convId);

  const order = window.__ZC_HIST_MIRROR_ORDER__;
  const idx = order.indexOf(key);

  if (idx >= 0) order.splice(idx, 1);

  order.push(key);

  while (order.length > HIST_MIRROR_MAX_CONVERSAS) {
    const old = order.shift();

    try {
      delete window.cacheHistoricos[String(old)];
    } catch {
      window.cacheHistoricos[String(old)] = [];
    }
  }
}

function setMirror(convId, arr) {
  const key = String(convId);
  const safe = Array.isArray(arr) ? arr : [];

  if (!safe.length) {
    try {
      delete window.cacheHistoricos[key];
    } catch {
      window.cacheHistoricos[key] = [];
    }
    return;
  }

  window.cacheHistoricos[key] = safe;
  touchMirrorKey(key);
}

function getMirror(convId) {
  const a = window.cacheHistoricos[String(convId)];
  return Array.isArray(a) ? a : [];
}

/* =====================================================================
   Dedup / Merge
   ===================================================================== */

function buildIdKey(m) {
  const dbId = m.db_id || m.mensagem_id || m.message_db_id || null;
  if (dbId) return `db:${dbId}`;

  if (m.msg_id && !(typeof m.msg_id === 'string' && m.msg_id.startsWith('tmp:'))) {
    return `id:${m.msg_id}`;
  }

  const content = String(m.conteudo || '').slice(0, 64);
  return `ts:${m.ts}|c:${content}`;
}

function _mergeOrPushOne(out, seen, m) {
  const key = buildIdKey(m);

  if (seen.has(key)) return;

  const idxTmp = _findTmpCandidate(out, m);

  if (idxTmp >= 0) {
    const prev = out[idxTmp];
    const merged = { ...prev, ...m };

    merged.msg_id = m.msg_id || prev.msg_id;

    if (m.origem != null) merged.origem = m.origem;
    if (m.autor_nome != null) merged.autor_nome = m.autor_nome;
    if (m.timestamp) merged.timestamp = m.timestamp;
    if (m.quoted != null) merged.quoted = m.quoted;
    if (m.quoted_preview != null) merged.quoted_preview = m.quoted_preview;

    const mergedTs = toMillis(
      merged.timestamp ??
      merged.ts ??
      merged.data ??
      merged.created_at ??
      null
    );

    merged.ts = mergedTs || _tsOf(merged) || (typeof prev?.ts === 'number' ? prev.ts : 0);

    out[idxTmp] = merged;
    seen.set(buildIdKey(merged), true);
    return;
  }

  out.push(m);
  seen.set(key, true);
}

function mergeMessages(current, incoming, side = 'new') {
  const out = Array.isArray(current) ? current.slice() : [];
  const seen = new Map();

  for (const x of out) {
    seen.set(buildIdKey(x), true);
  }

  const normed = (Array.isArray(incoming) ? incoming : []).map(normMsg);

  if (side === 'old') {
    for (let i = normed.length - 1; i >= 0; i--) {
      const m = normed[i];
      const key = buildIdKey(m);

      if (seen.has(key)) continue;

      out.unshift(m);
      seen.set(key, true);
    }
  } else {
    for (const m of normed) {
      _mergeOrPushOne(out, seen, m);
    }
  }

  out.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  return out;
}

/* =====================================================================
   Limpeza automática de cache antigo/pesado
   ===================================================================== */

function lsKeys() {
  const keys = [];

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
  } catch {}

  return keys;
}

function isHistStorageKey(key) {
  const k = String(key || '');

  return (
    k.startsWith('cacheHistoricos:') ||
    k.includes(':hist:') ||
    k.includes(':cursor:')
  );
}

function isLegacyHistKey(key) {
  return String(key || '').startsWith('cacheHistoricos:');
}

function cleanupHeavyHistoryStorage() {
  try {
    const keys = lsKeys();
    let removed = 0;

    for (const key of keys) {
      if (!isHistStorageKey(key)) continue;

      const raw = localStorage.getItem(key);

      if (raw == null) continue;

      if (isLegacyHistKey(key) && HIST_REMOVE_LEGACY_CACHE) {
        localStorage.removeItem(key);
        removed += 1;
        continue;
      }

      if (raw.length > HIST_BIG_CACHE_BYTES) {
        localStorage.removeItem(key);
        removed += 1;
        continue;
      }

      /*
        Remove cache expirado mesmo se cacheGet ainda não foi chamado.
      */
      try {
        const obj = JSON.parse(raw);

        if (
          obj &&
          typeof obj === 'object' &&
          Number(obj.exp || 0) > 0 &&
          Number(obj.exp || 0) < Date.now()
        ) {
          localStorage.removeItem(key);
          removed += 1;
        }
      } catch {}
    }

    if (removed && window.HIST_DEBUG === true) {
      console.log('[hist-cache] caches antigos/pesados removidos:', removed);
    }
  } catch {}
}

try {
  if (!window.__ZC_HIST_CACHE_CLEANED_ONCE__) {
    window.__ZC_HIST_CACHE_CLEANED_ONCE__ = true;

    // Limpa antes de qualquer getHist/cacheGet para não parsear JSON gigante antigo.
    cleanupHeavyHistoryStorage();

    setTimeout(() => {
      cleanupHeavyHistoryStorage();
    }, 800);
  }
} catch {}

/* =====================================================================
   Public API
   ===================================================================== */

export function getHist(inst, convId) {
  const key = kHist(inst, convId);

  if (!HIST_SAVE_TO_LOCALSTORAGE) {
    const mem = getMirror(convId);
    return mem.length ? compactMessages(mem, 'latest') : [];
  }

  const arr = cacheGet(key);

  if (Array.isArray(arr)) {
    const safe = compactMessages(arr, 'latest');

    /*
      Se veio gigante do cache, já regrava compacto.
    */
    if (safe.length !== arr.length) {
      cacheSet(key, safe, HIST_CACHE_TTL_MS);
    }

    setMirror(convId, safe);
    return safe;
  }

  const mem = getMirror(convId);

  if (mem.length) {
    return compactMessages(mem, 'latest');
  }

  return [];
}

export function setHist(inst, convId, arr, mode = 'latest') {
  const safe = compactMessages(arr, mode);

  if (HIST_SAVE_TO_LOCALSTORAGE) {
    cacheSet(kHist(inst, convId), safe, HIST_CACHE_TTL_MS);
  } else {
    try { cacheDel(kHist(inst, convId)); } catch {}
  }

  setMirror(convId, safe);

  return safe;
}

export function mergeNew(inst, convId, msgs) {
  const cur = getHist(inst, convId);
  const merged = mergeMessages(cur, msgs, 'new');

  return setHist(inst, convId, merged, 'latest');
}

export function mergeOld(inst, convId, msgs) {
  const cur = getHist(inst, convId);
  const merged = mergeMessages(cur, msgs, 'old');

  // Mantém uma parte das antigas + as recentes. Assim o usuário pode carregar
  // histórico sem o cache esquecer o final da conversa.
  return setHist(inst, convId, merged, 'balanced');
}

export function getCursors(inst, convId) {
  if (!HIST_SAVE_TO_LOCALSTORAGE) {
    const mem = window.__ZC_HIST_CURSOR_MEM__ || {};
    const prefix = `${String(inst || 'all')}:${String(convId)}`;
    return {
      oldest: mem[`${prefix}:oldest`] ?? null,
      newest: mem[`${prefix}:newest`] ?? null,
    };
  }

  return {
    oldest: cacheGet(kCurOld(inst, convId)) ?? null,
    newest: cacheGet(kCurNew(inst, convId)) ?? null,
  };
}

export function setCursors(inst, convId, { oldest, newest } = {}) {
  if (!HIST_SAVE_TO_LOCALSTORAGE) {
    window.__ZC_HIST_CURSOR_MEM__ = window.__ZC_HIST_CURSOR_MEM__ || {};
    const prefix = `${String(inst || 'all')}:${String(convId)}`;
    if (oldest !== undefined) window.__ZC_HIST_CURSOR_MEM__[`${prefix}:oldest`] = oldest;
    if (newest !== undefined) window.__ZC_HIST_CURSOR_MEM__[`${prefix}:newest`] = newest;
    return;
  }

  if (oldest !== undefined) {
    cacheSet(kCurOld(inst, convId), oldest, HIST_CURSOR_TTL_MS);
  }

  if (newest !== undefined) {
    cacheSet(kCurNew(inst, convId), newest, HIST_CURSOR_TTL_MS);
  }
}

export function primeWith(inst, convId, msgs, cursors = null) {
  const normed = (Array.isArray(msgs) ? msgs : []).map(normMsg);
  normed.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const saved = setHist(inst, convId, normed, 'latest');

  if (cursors && (cursors.oldest !== undefined || cursors.newest !== undefined)) {
    setCursors(inst, convId, cursors);
  }

  return saved;
}

export function hasHistory(inst, convId) {
  const a = getHist(inst, convId);
  return Array.isArray(a) && a.length > 0;
}

export function clear(inst = null, convId = null) {
  if (inst == null && convId == null) {
    try {
      window.cacheHistoricos = Object.create(null);
      window.__ZC_HIST_MIRROR_ORDER__ = [];
    } catch {}

    /*
      Limpa somente histórico/cursor.
      Não mexe em token, empresa_id, tema, usuário etc.
    */
    try {
      for (const key of lsKeys()) {
        if (isHistStorageKey(key)) {
          localStorage.removeItem(key);
        }
      }
    } catch {}

    return;
  }

  if (inst != null && convId != null) {
    cacheDel(kHist(inst, convId));
    cacheDel(kCurOld(inst, convId));
    cacheDel(kCurNew(inst, convId));
    setMirror(convId, []);
  }
}

export function pushOneNew(inst, convId, msg) {
  return mergeNew(inst, convId, [msg]);
}

export function pushOneOld(inst, convId, msg) {
  return mergeOld(inst, convId, [msg]);
}

/* =====================================================================
   Compatibilidade com módulos antigos
   ===================================================================== */


try {
  if (!HIST_SAVE_TO_LOCALSTORAGE) {
    for (const key of lsKeys()) {
      if (isHistStorageKey(key)) localStorage.removeItem(key);
    }
  }
} catch {}

try {
  window.salvarNoCache = function (convId, msgs) {
    const inst =
      window.state?.clienteSel?.instancia_id ??
      window.INSTANCIA_ATIVA ??
      null;

    mergeNew(inst, convId, msgs);
  };
} catch {}

try {
  window.getHist = getHist;
  window.setHist = setHist;
  window.primeWith = primeWith;
  window.mergeNew = mergeNew;
  window.mergeOld = mergeOld;
  window.HistCache = {
    get: getHist,
    set: setHist,
    mergeNew,
    mergeOld,
    primeWith,
    clear,
  };
} catch {}