// /frontend/js/store.js
import { EMPRESA_ID } from '../core/env.js';

/**
 * STORE (ZapChat Atendimentos)
 * - Cache por empresa
 * - Conversas: por instância (para não misturar listas)
 * - Histórico: agora é "base unificada" por (instância + conversa)
 *
 * ✅ Mantém compat com módulos antigos:
 *   - state.clientesCache / state.nextCursor continuam existindo (instância atual)
 *   - cacheHistoricos legado continua existindo (para não quebrar quem ainda usa)
 * ✅ Novo recomendado:
 *   - getConversasKeyed()/setConversasKeyed()/appendConversasKeyed()
 *   - pushMsgKeyed()/saveMsgsKeyed()/getMsgsKeyed()
 */

const EID = String(EMPRESA_ID ?? '').trim() || '0';

/* =========================
   Keys de storage
   ========================= */
const LS_META = `zc:meta:${EID}`;

// ✅ LEGADO (mantém)
const LS_CLIENTES_LEGACY = `clientesCache:${EID}`;
const LS_HIST_LEGACY     = `cacheHistoricos:${EID}`;

// ✅ NOVO (por instância / unificado)
const LS_CONVS_V2 = `zc:convs:v2:${EID}`; // { [instKey]: { items:[], nextCursor, ts } }
const LS_HIST_V2  = `zc:hist:v2:${EID}`;  // { [k]: Mensagem[] } onde k = `${instKey}:${convId}`

/* =========================
   DB_MODE flags
   ========================= */
export const DB_MODE = {
  bootFetched: false,
  allowListReloadAfterBoot: false,
  allowPreviewHydrateFromServer: false,
};

/* =========================
   Helpers internos
   ========================= */
function safeJsonParse(v, fallback){
  try { return JSON.parse(v); } catch { return fallback; }
}

function normStr(v){
  const s = (v == null ? '' : String(v)).trim();
  return s;
}

// instância ativa (mesma lógica do init.js)
function getActiveInstKey(){
  try {
    const k = `instAtiva:${EID}`;
    const ls = normStr(localStorage.getItem(k));
    const w  = normStr(window.INSTANCIA_ATIVA);
    // preferir window > ls
    const v = w || ls;
    return v ? String(v) : 'all';
  } catch {
    return 'all';
  }
}

function instKeyFromValue(v){
  const s = normStr(v);
  return s ? s : 'all';
}

function convIdOf(item){
  const v =
    item?.conversation_id ?? item?.cliente_id ?? item?.id ?? item?.cid ??
    item?.clienteId ?? null;
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// base: recência + msg_id; pins primeiro (se existir)
function tsToMillisAny(x){
  if (!x) return 0;
  if (typeof x === 'number') return x;
  const t = Date.parse(String(x));
  return Number.isFinite(t) ? t : 0;
}
function scoreRecencia(c){
  const ts = tsToMillisAny(c?.hora || c?.ultima_ts || c?.last_ts || c?.updated_at || c?.last_message_at) || 0;
  const mid = Number(c?.ultima_msg_id ?? c?.last_msg_id ?? 0) || 0;
  const ack = Number(c?.ultima_ack ?? c?.last_ack ?? 0) || 0;
  return ts * 1_000_000 + mid * 1_000 + ack * 10;
}
function sortConversasDesc(arr){
  const A = Array.isArray(arr) ? arr.slice() : [];
  return A.sort((a,b)=>{
    const pinCmp = Number(!!b?.pinned) - Number(!!a?.pinned);
    if (pinCmp !== 0) return pinCmp;
    const r = scoreRecencia(b) - scoreRecencia(a);
    if (r !== 0) return r;
    const ib = Number(b?.conversation_id ?? b?.id ?? 0) || 0;
    const ia = Number(a?.conversation_id ?? a?.id ?? 0) || 0;
    return ib - ia;
  });
}

/* =========================
   Normalização conversa (mínima)
   ========================= */
function normalizeConversa(item){
  const conversation_id = convIdOf(item) ?? (
    // fallback antigo (não ideal, mas não quebra)
    item?.telefone ?? item?.name ?? item?.nome ?? null
  );

  const inst =
    item?.instancia_id ?? item?.instancia ?? item?.instancia_slug ??
    item?.instance_id ?? item?.instance ?? item?.session ?? item?.sessionName ??
    item?.sessao ?? item?.inst_slug ?? null;

  const lastTs =
    item?.ultima_ts ?? item?.hora ?? item?.last_ts ?? item?.updated_at ?? item?.last_message_at ?? null;

  const preview =
    item?.ultima_texto ?? item?.ultima_mensagem ?? item?.preview ?? item?.last_text ?? item?.ultima ?? '';

  return {
    // ids
    conversation_id,
    cliente_id: item?.cliente_id ?? item?.id ?? conversation_id ?? null,

    // nomes
    nome_whatsapp: item?.nome_whatsapp ?? null,
    nome: item?.nome ?? item?.name ?? '',
    push_name: item?.push_name ?? null,

    // contatos
    telefone: item?.telefone ?? item?.number ?? item?.wuid ?? item?.numero ?? null,
    avatar_url: item?.avatar_url ?? item?.foto_url ?? item?.foto ?? item?.avatar ?? item?.profile_pic_url ?? null,

    // preview
    ultima_msg_id: item?.ultima_msg_id ?? item?.last_msg_id ?? null,
    ultima_mensagem: String(preview || ''),
    hora: lastTs,
    last_ts: item?.last_ts ?? null,
    last_tipo: item?.ultima_tipo ?? item?.last_tipo ?? item?.tipo ?? null,
    last_ack: item?.ultima_ack ?? item?.last_ack ?? item?.ack ?? null,

    // contadores
    novas: Number(item?.novas ?? item?.nao_lidas ?? item?.unread ?? 0) || 0,

    // instância
    instancia_id: inst,
    instancia: inst,

    // pin
    pinned: Boolean(item?.pinned || item?.fixado || item?.pin || false),
  };
}

/* =========================
   Estado inicial
   ========================= */
const _legacyClientes = safeJsonParse(localStorage.getItem(LS_CLIENTES_LEGACY) || '[]', []);
const _legacyHist     = safeJsonParse(localStorage.getItem(LS_HIST_LEGACY) || '{}', {});

const _v2Convs = safeJsonParse(localStorage.getItem(LS_CONVS_V2) || '{}', {});
const _v2Hist  = safeJsonParse(localStorage.getItem(LS_HIST_V2)  || '{}', {});

const _meta    = safeJsonParse(localStorage.getItem(LS_META) || '{"ver":2}', { ver: 2 });

/** Estado global simples do front */
export const state = {
  // ===== legado (mantido) =====
  clientesCache: Array.isArray(_legacyClientes) ? _legacyClientes : [],
  cacheHistoricos: (_legacyHist && typeof _legacyHist === 'object') ? _legacyHist : {},

  // ===== v2 =====
  convsByInst: (_v2Convs && typeof _v2Convs === 'object') ? _v2Convs : {}, // {instKey:{items,nextCursor,ts}}
  histByKey:  (_v2Hist  && typeof _v2Hist  === 'object') ? _v2Hist  : {},  // { "inst:conv": Mensagem[] }

  meta: _meta,

  // contatos completos
  todosContatosCache: [],

  // conversa selecionada
  clienteSel: null,

  // paginação (compat)
  nextCursor: null,
  isLoadingMore: false,

  selectionToken: 0,
};

/* =========================
   Persistência
   ========================= */
export function persist(){
  try{
    // V2
    localStorage.setItem(LS_CONVS_V2, JSON.stringify(state.convsByInst || {}));
    localStorage.setItem(LS_HIST_V2,  JSON.stringify(state.histByKey  || {}));

    // Meta
    localStorage.setItem(LS_META, JSON.stringify(state.meta || { ver: 2 }));

    // Legado (mantém para compat)
    localStorage.setItem(LS_CLIENTES_LEGACY, JSON.stringify(Array.isArray(state.clientesCache)?state.clientesCache:[]));
    localStorage.setItem(LS_HIST_LEGACY,     JSON.stringify(state.cacheHistoricos || {}));
  }catch{}
}

export function clearAll(){
  state.clientesCache   = [];
  state.cacheHistoricos = {};
  state.convsByInst     = {};
  state.histByKey       = {};
  state.meta            = { ver: 2 };
  state.nextCursor      = null;
  persist();
}

/* =========================
   Seleção atual
   ========================= */
export function setClienteSel(c){ state.clienteSel = c; }
export function getClienteSel(){ return state.clienteSel; }

/* =========================
   CONVERSAS - V2 (por instância)
   ========================= */
export function getConversasKeyed(instanciaKey = null){
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());
  const box = state.convsByInst?.[k];
  const items = Array.isArray(box?.items) ? box.items : [];
  return items;
}

export function getNextCursorKeyed(instanciaKey = null){
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());
  return state.convsByInst?.[k]?.nextCursor ?? null;
}

export function setConversasKeyed(items, { nextCursor = null, instanciaKey = null } = {}){
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());
  const norm = (items || []).map(normalizeConversa);
  const sorted = sortConversasDesc(norm);

  state.convsByInst[k] = {
    items: sorted,
    nextCursor: (typeof nextCursor === 'undefined') ? null : nextCursor,
    ts: Date.now(),
  };

  // compat: aponta estado "ativo"
  state.clientesCache = sorted;
  state.nextCursor = state.convsByInst[k].nextCursor;

  persist();
}

export function appendConversasKeyed(items, { nextCursor = null, instanciaKey = null } = {}){
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());

  const box = state.convsByInst[k] || { items: [], nextCursor: null, ts: 0 };
  const cur = Array.isArray(box.items) ? box.items.slice() : [];
  const map = new Map(cur.map(c => [String(c.conversation_id ?? c.id), c]));

  for (const it of (items || [])){
    const n = normalizeConversa(it);
    const id = String(n.conversation_id ?? n.id);
    const prev = map.get(id) || {};
    const merged = { ...prev, ...n };
    merged.pinned = Boolean((prev && prev.pinned) || n.pinned);
    map.set(id, merged);
  }

  const sorted = sortConversasDesc([...map.values()]);
  state.convsByInst[k] = { items: sorted, nextCursor, ts: Date.now() };

  // compat: aponta estado "ativo"
  state.clientesCache = sorted;
  state.nextCursor = nextCursor;

  persist();
}

export function moveConversaToTopKeyed(conversation_id, patch = {}, instanciaKey = null){
  const cid = Number(conversation_id ?? 0) || 0;
  if (!cid) return;

  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());
  const box = state.convsByInst[k] || { items: [], nextCursor: null, ts: 0 };
  const cur = Array.isArray(box.items) ? box.items.slice() : [];

  const idx = cur.findIndex(c => Number(c.conversation_id ?? c.id ?? 0) === cid);
  if (idx === -1) return;

  const updated = { ...cur[idx], ...patch };
  cur.splice(idx, 1);
  cur.unshift(updated);

  const sorted = sortConversasDesc(cur);
  state.convsByInst[k] = { ...box, items: sorted, ts: Date.now() };

  // compat: aponta estado "ativo"
  state.clientesCache = sorted;

  persist();
}

/* =========================
   CONVERSAS - LEGADO (compat)
   ========================= */
export function getConversas(){
  // preferir o "ativo" do v2, se existir
  const k = getActiveInstKey();
  const v2 = getConversasKeyed(k);
  if (Array.isArray(v2) && v2.length) return v2;
  return state.clientesCache || [];
}

export function setConversas(items, { nextCursor = null } = {}){
  // agora seta no v2 (instância ativa)
  setConversasKeyed(items, { nextCursor, instanciaKey: getActiveInstKey() });
}

export function appendConversas(items, { nextCursor = null } = {}){
  appendConversasKeyed(items, { nextCursor, instanciaKey: getActiveInstKey() });
}

export function moveConversaToTop(conversation_id, patch = {}){
  moveConversaToTopKeyed(conversation_id, patch, getActiveInstKey());
}

export function setNextCursor(cursor){
  const k = getActiveInstKey();
  const box = state.convsByInst[k] || { items: [], nextCursor: null, ts: 0 };
  box.nextCursor = cursor;
  state.convsByInst[k] = box;
  state.nextCursor = cursor;
  persist();
}
export function getNextCursor(){
  const k = getActiveInstKey();
  const v = state.convsByInst?.[k]?.nextCursor;
  if (v != null) return v;
  return state.nextCursor;
}

/* =========================
   HISTÓRICO - V2 (unificado inst+conv)
   ========================= */
const MAX_MSGS_PER_CONVERSA = 200;

function makeHistKey(instanciaKey, conversation_id){
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());
  const cid = Number(conversation_id ?? 0) || 0;
  return `${k}:${cid}`;
}

export function getMsgsKeyed(instanciaKey, conversation_id){
  const hk = makeHistKey(instanciaKey, conversation_id);
  return state.histByKey[hk] || [];
}

export function saveMsgsKeyed(instanciaKey, conversation_id, msgs){
  const hk = makeHistKey(instanciaKey, conversation_id);
  const arr = Array.isArray(msgs) ? msgs.slice(-MAX_MSGS_PER_CONVERSA) : [];
  state.histByKey[hk] = arr;
  persist();
}

export function pushMsgKeyed(instanciaKey, conversation_id, msg){
  const hk = makeHistKey(instanciaKey, conversation_id);
  const arr = state.histByKey[hk] || [];
  arr.push(msg);
  state.histByKey[hk] = arr.slice(-MAX_MSGS_PER_CONVERSA);
  persist();
}

export function preloadMsgsKeyed(instanciaKey, conversation_id, msgs){
  if (!Array.isArray(msgs)) msgs = [];
  const sorted = msgs.slice().sort((a,b) => {
    const ai = a.id ?? 0, bi = b.id ?? 0;
    if (ai && bi) return ai - bi;
    const at = (new Date(a.ts||a.timestamp||0)).getTime();
    const bt = (new Date(b.ts||b.timestamp||0)).getTime();
    return at - bt;
  });
  saveMsgsKeyed(instanciaKey, conversation_id, sorted);
}

export function prependOldMsgsKeyed(instanciaKey, conversation_id, olderMsgs){
  const hk = makeHistKey(instanciaKey, conversation_id);
  const cur = state.histByKey[hk] || [];
  const seen = new Set(cur.map(m => m.id ?? m.msg_id));
  const toAdd = (olderMsgs || []).filter(m => !seen.has(m.id ?? m.msg_id));
  state.histByKey[hk] = toAdd.concat(cur).slice(-MAX_MSGS_PER_CONVERSA);
  persist();
}

/* =========================
   HISTÓRICO - LEGADO (compat)
   ========================= */
export function getMsgs(conversation_id){
  // fallback legado (instância não entra)
  return state.cacheHistoricos[String(conversation_id)] || [];
}
export function saveMsgs(conversation_id, msgs){
  const arr = Array.isArray(msgs) ? msgs.slice(-MAX_MSGS_PER_CONVERSA) : [];
  state.cacheHistoricos[String(conversation_id)] = arr;
  persist();
}
export function pushMsg(conversation_id, msg){
  const cid = String(conversation_id);
  const arr = state.cacheHistoricos[cid] || [];
  arr.push(msg);
  state.cacheHistoricos[cid] = arr.slice(-MAX_MSGS_PER_CONVERSA);
  persist();
}
export function preloadMsgs(conversation_id, msgs){
  if (!Array.isArray(msgs)) msgs = [];
  const sorted = msgs.slice().sort((a,b) => {
    const ai = a.id ?? 0, bi = b.id ?? 0;
    if (ai && bi) return ai - bi;
    const at = (new Date(a.ts||a.timestamp||0)).getTime();
    const bt = (new Date(b.ts||b.timestamp||0)).getTime();
    return at - bt;
  });
  saveMsgs(conversation_id, sorted);
}
export function prependOldMsgs(conversation_id, olderMsgs){
  const cid = String(conversation_id);
  const cur = state.cacheHistoricos[cid] || [];
  const seen = new Set(cur.map(m => m.id ?? m.msg_id));
  const toAdd = (olderMsgs||[]).filter(m => !seen.has(m.id ?? m.msg_id));
  state.cacheHistoricos[cid] = toAdd.concat(cur).slice(-MAX_MSGS_PER_CONVERSA);
  persist();
}

/* =========================
   Merge de mensagem recebida/enviada (compat + v2 opcional)
   ========================= */
export function mergeIncomingMessage(conversation_id, message, instanciaKey = null){
  // 1) salva no histórico
  try {
    // v2 (se tiver convId numérico)
    const cid = Number(conversation_id ?? 0) || 0;
    if (cid) pushMsgKeyed(instanciaKey ?? getActiveInstKey(), cid, message);
  } catch {}
  // legado
  try { pushMsg(conversation_id, message); } catch {}

  // 2) atualiza preview e move conversa para o topo
  const preview = {
    ultima_msg_id: message.id ?? message.db_id ?? message.msg_id ?? null,
    ultima_mensagem: message.texto ?? message.conteudo ?? message.mensagem ?? '',
    hora: message.ts ?? message.timestamp ?? new Date().toISOString(),
    last_tipo: message.tipo ?? null,
    last_ack: typeof message.ack === 'number' ? message.ack : null,
  };

  try { moveConversaToTopKeyed(conversation_id, preview, instanciaKey ?? getActiveInstKey()); } catch {}
  try { moveConversaToTop(conversation_id, preview); } catch {}
}

/* =========================
   Acks e leitura
   ========================= */
export function updateAck(conversation_id, msg_id, ack, instanciaKey = null){
  // v2
  try{
    const hk = makeHistKey(instanciaKey ?? getActiveInstKey(), conversation_id);
    const arr = state.histByKey[hk] || [];
    let changed = false;
    for (const m of arr){
      const mid = m.id ?? m.msg_id;
      if (mid === msg_id){
        m.ack = ack;
        changed = true;
        break;
      }
    }
    if (changed){
      state.histByKey[hk] = arr;
      persist();
    }
  }catch{}

  // legado
  try{
    const cid = String(conversation_id);
    const arr = state.cacheHistoricos[cid] || [];
    let changed = false;
    for (const m of arr){
      const mid = m.id ?? m.msg_id;
      if (mid === msg_id){
        m.ack = ack;
        changed = true;
        break;
      }
    }
    if (changed){
      state.cacheHistoricos[cid] = arr;
      persist();
    }
  }catch{}
}

export function marcarLidas(conversation_id, instanciaKey = null){
  // zera badge 'novas' e persiste (v2 + compat)
  const cid = Number(conversation_id ?? 0) || 0;
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());

  // v2
  try{
    const box = state.convsByInst[k];
    const items = Array.isArray(box?.items) ? box.items.slice() : [];
    const i = items.findIndex(c => Number(c.conversation_id ?? c.id ?? 0) === cid);
    if (i >= 0){
      items[i] = { ...items[i], novas: 0 };
      state.convsByInst[k] = { ...(box||{}), items, ts: Date.now() };
      state.clientesCache = items;
    }
  }catch{}

  // legado
  try{
    const list = state.clientesCache.slice(0);
    const i = list.findIndex(c => Number(c.conversation_id ?? c.id ?? 0) === cid);
    if (i >= 0){
      list[i] = { ...list[i], novas: 0 };
      state.clientesCache = list;
    }
  }catch{}

  persist();
}

/* =========================
   Utilidades diversas
   ========================= */
export function replaceOrInsertConversa(item, instanciaKey = null){
  const n = normalizeConversa(item);
  const cid = Number(n.conversation_id ?? 0) || 0;
  if (!cid) return;

  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());
  const box = state.convsByInst[k] || { items: [], nextCursor: null, ts: 0 };
  const cur = Array.isArray(box.items) ? box.items.slice() : [];

  const idx = cur.findIndex(c => Number(c.conversation_id ?? c.id ?? 0) === cid);
  if (idx >= 0) cur[idx] = { ...cur[idx], ...n };
  else cur.push(n);

  const sorted = sortConversasDesc(cur);
  state.convsByInst[k] = { ...box, items: sorted, ts: Date.now() };

  // compat
  state.clientesCache = sorted;

  persist();
}

export function removeConversa(conversation_id, instanciaKey = null){
  const cid = Number(conversation_id ?? 0) || 0;
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());

  // v2
  try{
    const box = state.convsByInst[k] || { items: [], nextCursor: null, ts: 0 };
    const items = Array.isArray(box.items) ? box.items : [];
    state.convsByInst[k] = {
      ...box,
      items: items.filter(c => Number(c.conversation_id ?? c.id ?? 0) !== cid),
      ts: Date.now()
    };
    delete state.histByKey[makeHistKey(k, cid)];
  }catch{}

  // legado
  try{
    state.clientesCache = (state.clientesCache || []).filter(c => Number(c.conversation_id ?? c.id ?? 0) !== cid);
    delete state.cacheHistoricos[String(cid)];
  }catch{}

  persist();
}

/**
 * Hydrate em massa (retorno do servidor), preservando conversas existentes
 * dentro da instância atual (v2).
 */
export function hydrateConversasFromServer(items, nextCursor = null, instanciaKey = null){
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());
  const box = state.convsByInst[k] || { items: [], nextCursor: null, ts: 0 };

  const map = new Map((box.items || []).map(c => [String(c.conversation_id ?? c.id), c]));
  for (const it of (items || [])){
    const n = normalizeConversa(it);
    const id = String(n.conversation_id ?? n.id);
    map.set(id, { ...(map.get(id) || {}), ...n });
  }

  const merged = sortConversasDesc([...map.values()]);
  state.convsByInst[k] = { items: merged, nextCursor, ts: Date.now() };

  // compat
  state.clientesCache = merged;
  state.nextCursor = nextCursor;

  persist();
}

/* =========================
   Boot helpers
   ========================= */
export function hasAnyCache(){
  const k = getActiveInstKey();
  const v2 = getConversasKeyed(k);
  if (Array.isArray(v2) && v2.length) return true;
  return (state.clientesCache && state.clientesCache.length > 0);
}

export function rememberBootFetched(flag=true){
  DB_MODE.bootFetched = !!flag;
}

export function setMeta(key, value){
  state.meta = { ...(state.meta||{}), [key]: value };
  persist();
}
export function getMeta(key, def=null){
  const m = state.meta || {};
  return (key in m) ? m[key] : def;
}

/* =========================
   Pequena ponte: ao carregar, aponta o "ativo" do v2 se existir
   ========================= */
(function bootstrapActiveFromV2(){
  try{
    const k = getActiveInstKey();
    const box = state.convsByInst?.[k];
    if (box && Array.isArray(box.items)) {
      state.clientesCache = box.items;
      state.nextCursor = box.nextCursor ?? null;
    }
  }catch{}
})();
