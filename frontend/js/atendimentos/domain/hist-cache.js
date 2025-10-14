// /frontend/js/atendimentos/domain/hist-cache.js
// Cache local de histórico de conversas (por instância + conversa).
// - Usa cache.js (localStorage) com namespace da empresa
// - Mantém espelho em window.cacheHistoricos[convId] para compat c/ código existente
// - Dedup por msg_id; fallback por (ts_normalizado + hash de conteudo)
// - Ordena por timestamp asc (do mais antigo para o mais novo)
// - Guarda cursores (oldest/newest) por conversa/instância
//
// Chaves no storage (via cache.js):
//   hist:{inst}:{convId}              -> Array<mensagem> normalizada
//   cursor:{inst}:{convId}:oldest     -> string|null
//   cursor:{inst}:{convId}:newest     -> string|null
//
// API:
//   getHist(inst, convId) -> array
//   setHist(inst, convId, arr)
//   mergeNew(inst, convId, msgs)              // adiciona novas (fim)
//   mergeOld(inst, convId, msgs)              // adiciona antigas (início)
//   getCursors(inst, convId) -> { oldest, newest }
//   setCursors(inst, convId, { oldest?, newest? })
//   primeWith(inst, convId, msgs, cursors?)   // grava primeiro bloco (ex.: limit=50)
//   clear(inst?, convId?)                     // limpa uma conversa, uma instância ou tudo
//
// Convenções de mensagem normalizada:
//   {
//     msg_id, conteudo, tipo, timestamp, ack|null, midias[],
//     instancia_id|null, instance_name|null, ts:number(ms),
//     // meta p/ UI (OperatorLine, etc.):
//     origem|null,          // 'atendente' | 'whatsapp_fisico' | 'cliente' | ...
//     autor_nome|null       // nome do atendente/autor quando disponível
//   }

import { cacheGet, cacheSet, cacheDel } from '../core/cache.js';

// ===================== Utils =====================
function toMillis(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') {
    if (ts > 1e12) return Math.floor(ts);        // já em ms
    if (ts > 1e8)  return Math.floor(ts * 1000); // seg -> ms
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

  // ======= META usada pelo banner/UX =======
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
    // meta p/ OperatorLine / render
    origem: origem ?? null,
    autor_nome: autor_nome ?? null,
  };
}

// helpers extras p/ merge tmp -> real
const _norm = (v)=> (v ?? '').toString().trim();
const _tsOf = (m)=>{
  const t = m?.timestamp || m?.ts || m?.data || m?.created_at || null;
  const d = t ? new Date(t) : null;
  return d && !isNaN(d) ? d.getTime() : Date.now();
};
const _isTmp = (m)=>{
  const id = m?.msg_id || m?.id || '';
  return typeof id === 'string' && id.startsWith('tmp_');
};

// tenta achar uma bolha tmp compatível para fundir com a entrante real
function _findTmpCandidate(arr, incoming){
  const isOut = (incoming.tipo === 'saida' || incoming.from_me === true || incoming.origem === 'atendente');
  if (!isOut) return -1;
  const realId = incoming.msg_id;
  if (!realId || (typeof realId === 'string' && realId.startsWith('tmp_'))) return -1;

  const txt = _norm(incoming.conteudo || incoming.texto || incoming.caption || '');
  if (!txt) return -1;

  const now = Date.now();
  const WINDOW_MS = 15_000; // 15s é o bastante p/ casar a tmp
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

// chave de storage
function kHist(inst, convId)   { return `hist:${String(inst||'all')}:${String(convId)}`; }
function kCurOld(inst, convId) { return `cursor:${String(inst||'all')}:${String(convId)}:oldest`; }
function kCurNew(inst, convId) { return `cursor:${String(inst||'all')}:${String(convId)}:newest`; }

// ===================== In-memory mirror =====================
if (!window.cacheHistoricos) window.cacheHistoricos = Object.create(null);

// mantém window.cacheHistoricos[convId] sincronizado (sempre array ordenado ASC)
function setMirror(convId, arr) {
  window.cacheHistoricos[String(convId)] = Array.isArray(arr) ? arr : [];
}
function getMirror(convId) {
  const a = window.cacheHistoricos[String(convId)];
  return Array.isArray(a) ? a : [];
}

// ===================== Dedup / Merge =====================
function buildIdKey(m) {
  // Não considerar IDs temporários como "chave definitiva"
  if (m.msg_id && !(typeof m.msg_id === 'string' && m.msg_id.startsWith('tmp_'))) {
    return `id:${m.msg_id}`;
  }
  // Fallback: usa ts + conteúdo (curto) para evitar duplicatas
  const content = String(m.conteudo || '').slice(0, 64);
  return `ts:${m.ts}|c:${content}`;
}

// merge de um item (append) com fusão tmp->real
function _mergeOrPushOne(out, seen, m) {
  const key = buildIdKey(m);
  // Se já vimos por chave, ignora
  if (seen.has(key)) return;

  // Se é uma saída com id real, tente fundir uma tmp compatível
  const idxTmp = _findTmpCandidate(out, m);
  if (idxTmp >= 0){
    const prev = out[idxTmp];
    const merged = { ...prev, ...m };
    merged.msg_id = m.msg_id || prev.msg_id;
    // Preserve meta (origem/autor_nome) se chegar agora
    if (m.origem != null) merged.origem = m.origem;
    if (m.autor_nome != null) merged.autor_nome = m.autor_nome;
    if (m.timestamp) merged.timestamp = m.timestamp;
    merged.ts = toMillis(merged.timestamp) || _tsOf(merged);
    out[idxTmp] = merged;
    seen.set(buildIdKey(merged), true);
    return;
  }

  // Caso normal: empurra no fim
  out.push(m);
  seen.set(key, true);
}

// Merge genérico; side = 'new' (append) | 'old' (prepend)
function mergeMessages(current, incoming, side = 'new') {
  const out = Array.isArray(current) ? current.slice() : [];
  const seen = new Map();
  for (const x of out) seen.set(buildIdKey(x), true);

  const normed = (Array.isArray(incoming) ? incoming : []).map(normMsg);

  if (side === 'old') {
    // antigas entram no começo (sem a lógica de tmp->real, que só faz sentido para novas)
    for (let i = normed.length - 1; i >= 0; i--) {
      const m = normed[i];
      const key = buildIdKey(m);
      if (seen.has(key)) continue;
      out.unshift(m);
      seen.set(key, true);
    }
  } else {
    // novas: usar mergeOrPushOne (faz a fusão tmp -> real)
    for (const m of normed) {
      _mergeOrPushOne(out, seen, m);
    }
  }

  // ordena por ts asc (do mais antigo -> mais novo)
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
  cacheSet(kHist(inst, convId), safe, null); // sem expiração
  setMirror(convId, safe);
  return safe;
}

// Adiciona mensagens mais novas (fim)
export function mergeNew(inst, convId, msgs) {
  const cur = getHist(inst, convId);
  const merged = mergeMessages(cur, msgs, 'new');
  setHist(inst, convId, merged);
  return merged;
}

// Adiciona mensagens mais antigas (início)
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
    // limpa tudo em memória (não remove do storage da empresa inteira)
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
  // limpar todas conversas de uma instancia específica não é barato sem index;
  // manter implementação simples: não faz nada extra aqui.
}

// ===================== Helpers p/ outras camadas =====================
// Salva uma única mensagem "nova" (útil para WS/Rabbit):
export function pushOneNew(inst, convId, msg) {
  return mergeNew(inst, convId, [msg]);
}
// Salva uma única mensagem "antiga" (útil para paginação para cima):
export function pushOneOld(inst, convId, msg) {
  return mergeOld(inst, convId, [msg]);
}

// Reexport leve para compatibilidade (alguns módulos chamam salvarNoCache)
try {
  // salvarNoCache(conversationId, msgs[]) — append no final (novas)
  window.salvarNoCache = function (convId, msgs) {
    const inst =
      (window.state?.clienteSel?.instancia_id ?? window.INSTANCIA_ATIVA ?? null);
    mergeNew(inst, convId, msgs);
  };
} catch {}
