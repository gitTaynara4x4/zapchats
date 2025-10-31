// Cache local de histórico (instância + conversa) com dedup por msg_id
// e fallback por (ts + trecho de conteúdo). Mantém espelho em window.cacheHistoricos.

import { cacheGet, cacheSet, cacheDel } from '../core/cache.js';

// ===================== Utils =====================
function toMillis(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') {
    if (ts > 1e12) return Math.floor(ts);
    if (ts > 1e8)  return Math.floor(ts * 1000);
    return 0;
  }
  const n = Number(ts);
  if (Number.isFinite(n)) return toMillis(n);
  const p = Date.parse(String(ts));
  return Number.isFinite(p) ? p : 0;
}

function normMsg(m) {
  const msg_id =
    m?.msg_id ?? m?.msgId ?? m?.message_id ?? m?.messageId ?? m?.id ?? null;

  const tipo = (m?.tipo === 'saida' || m?.from_me === true || m?.origem === 'atendente')
    ? 'saida' : 'entrada';

  const tsRaw = m?.ts ?? m?.timestamp ?? null;
  const ts = toMillis(tsRaw) || Date.now();

  let ack = null;
  if (tipo === 'saida') {
    const a = (m?.ack ?? m?.delivery_ack ?? m?.status_ack);
    ack = (a == null) ? null : Number(a) || 0;
  }

  const midias = Array.isArray(m?.midias) ? m.midias : [];

  const origem =
    (m?.origem != null)
      ? m.origem
      : ((tipo === 'saida' || m?.from_me === true) ? 'atendente' : 'cliente');

  const autor_nome =
    m?.autor_nome ?? m?.atendente_nome ?? m?.user_nome ?? null;

  return {
    msg_id: msg_id || null,
    conteudo: m?.conteudo ?? m?.texto ?? m?.mensagem ?? '',
    tipo,
    timestamp: m?.timestamp ?? m?.ts ?? new Date(ts).toISOString(),
    ack,
    midias,
    instancia_id: m?.instancia_id ?? null,
    instance_name: m?.instance_name ?? null,
    ts,
    origem: origem ?? null,
    autor_nome: autor_nome ?? null,
  };
}

const _norm = (v)=> (v ?? '').toString().trim();
const _tsOf = (m)=>{
  const t = m?.timestamp || m?.ts || m?.data || m?.created_at || null;
  const d = t ? new Date(t) : null;
  return d && !isNaN(d) ? d.getTime() : Date.now();
};
const _isTmp = (m)=>{
  const id = m?.msg_id || m?.id || '';
  return typeof id === 'string' && id.startsWith('tmp:');
};

function _findTmpCandidate(arr, incoming){
  const isOut = (incoming.tipo === 'saida' || incoming.from_me === true || incoming.origem === 'atendente');
  if (!isOut) return -1;
  const realId = incoming.msg_id;
  if (!realId || (typeof realId === 'string' && realId.startsWith('tmp:'))) return -1;

  const txt = _norm(incoming.conteudo || incoming.texto || incoming.caption || '');
  if (!txt) return -1;

  const now = Date.now();
  const WINDOW_MS = 15_000;
  for (let i = arr.length - 1; i >= 0; i--){
    const m = arr[i];
    if (!_isTmp(m)) continue;
    if (!(m.tipo === 'saida' || m.from_me === true || m.origem === 'atendente')) continue;
    const mt = _norm(m.conteudo || m.texto || m.caption || '');
    if (mt !== txt) continue;
    if (Math.abs(now - _tsOf(m)) > WINDOW_MS) continue;
    return i;
  }
  return -1;
}

// keys
function kHist(inst, convId)   { return `hist:${String(inst||'all')}:${String(convId)}`; }
function kCurOld(inst, convId) { return `cursor:${String(inst||'all')}:${String(convId)}:oldest`; }
function kCurNew(inst, convId) { return `cursor:${String(inst||'all')}:${String(convId)}:newest`; }

// ===================== In-memory mirror =====================
if (!window.cacheHistoricos) window.cacheHistoricos = Object.create(null);

function setMirror(convId, arr) {
  window.cacheHistoricos[String(convId)] = Array.isArray(arr) ? arr : [];
}
function getMirror(convId) {
  const a = window.cacheHistoricos[String(convId)];
  return Array.isArray(a) ? a : [];
}

// ===================== Dedup / Merge =====================
function buildIdKey(m) {
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
  if (idxTmp >= 0){
    const prev = out[idxTmp];
    const merged = { ...prev, ...m };
    merged.msg_id = m.msg_id || prev.msg_id;
    if (m.origem != null) merged.origem = m.origem;
    if (m.autor_nome != null) merged.autor_nome = m.autor_nome;
    if (m.timestamp) merged.timestamp = m.timestamp;
    merged.ts = toMillis(merged.timestamp) || _tsOf(merged);
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
  for (const x of out) seen.set(buildIdKey(x), true);

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

// ===================== Public API =====================
export function getHist(inst, convId) {
  const key = kHist(inst, convId);
  const arr = cacheGet(key);
  if (Array.isArray(arr)) {
    setMirror(convId, arr);
    return arr;
  }
  const mem = getMirror(convId);
  if (mem.length) return mem;
  return [];
}

export function setHist(inst, convId, arr) {
  const safe = Array.isArray(arr) ? arr.map(normMsg).sort((a,b)=>a.ts-b.ts) : [];
  cacheSet(kHist(inst, convId), safe, null);
  setMirror(convId, safe);
  return safe;
}

export function mergeNew(inst, convId, msgs) {
  const cur = getHist(inst, convId);
  const merged = mergeMessages(cur, msgs, 'new');
  setHist(inst, convId, merged);
  return merged;
}

export function mergeOld(inst, convId, msgs) {
  const cur = getHist(inst, convId);
  const merged = mergeMessages(cur, msgs, 'old');
  setHist(inst, convId, merged);
  return merged;
}

export function getCursors(inst, convId) {
  return {
    oldest: cacheGet(kCurOld(inst, convId)) ?? null,
    newest: cacheGet(kCurNew(inst, convId)) ?? null
  };
}

export function setCursors(inst, convId, { oldest, newest } = {}) {
  if (oldest !== undefined) cacheSet(kCurOld(inst, convId), oldest, null);
  if (newest !== undefined) cacheSet(kCurNew(inst, convId), newest, null);
}

export function primeWith(inst, convId, msgs, cursors = null) {
  const normed = (Array.isArray(msgs) ? msgs : []).map(normMsg);
  normed.sort((a,b)=>a.ts-b.ts);
  setHist(inst, convId, normed);
  if (cursors && (cursors.oldest !== undefined || cursors.newest !== undefined)) {
    setCursors(inst, convId, cursors);
  }
  return normed;
}

export function hasHistory(inst, convId) {
  const a = getHist(inst, convId);
  return Array.isArray(a) && a.length > 0;
}

export function clear(inst = null, convId = null) {
  if (inst == null && convId == null) {
    window.cacheHistoricos = Object.create(null);
    return;
  }
  if (inst != null && convId != null) {
    cacheDel(kHist(inst, convId));
    cacheDel(kCurOld(inst, convId));
    cacheDel(kCurNew(inst, convId));
    setMirror(convId, []);
    return;
  }
}

export function pushOneNew(inst, convId, msg) {
  return mergeNew(inst, convId, [msg]);
}
export function pushOneOld(inst, convId, msg) {
  return mergeOld(inst, convId, [msg]);
}

// compat: alguns módulos chamam window.salvarNoCache
try {
  window.salvarNoCache = function (convId, msgs) {
    const inst =
      (window.state?.clienteSel?.instancia_id ?? window.INSTANCIA_ATIVA ?? null);
    mergeNew(inst, convId, msgs);
  };
} catch {}
