// /frontend/js/store.js
import { EMPRESA_ID } from '../core/env.js';

/**
 * Cache em localStorage por empresa.
 * clientesCache: array de conversas (prévia/ordenadas por última mensagem)
 * cacheHistoricos: mapa { [conversation_id]: Mensagem[] } (guardamos as últimas N)
 */
const LS_CLIENTES = `clientesCache:${EMPRESA_ID}`;
const LS_HIST     = `cacheHistoricos:${EMPRESA_ID}`;
const LS_META     = `zc:meta:${EMPRESA_ID}`;

export const DB_MODE = {
  // flags usadas pelo app para decidir se recarrega do servidor
  bootFetched: false,
  allowListReloadAfterBoot: false,
  allowPreviewHydrateFromServer: false,
};

/** Estado global simples do front */
export const state = {
  clientesCache:        JSON.parse(localStorage.getItem(LS_CLIENTES) || '[]'),
  cacheHistoricos:      JSON.parse(localStorage.getItem(LS_HIST)     || '{}'),
  meta:                 JSON.parse(localStorage.getItem(LS_META)     || '{"ver":1}'),

  // contatos completos (se você usa em outro lugar)
  todosContatosCache: [],

  // conversa selecionada
  clienteSel: null,

  // paginação da lista de conversas
  nextCursor: null,
  isLoadingMore: false,

  // token simples para invalidar seleções antigas
  selectionToken: 0,
};

/* ===========================
   Persistência
   =========================== */
export function persist(){
  try{
    localStorage.setItem(LS_CLIENTES, JSON.stringify(Array.isArray(state.clientesCache)?state.clientesCache:[]));
    localStorage.setItem(LS_HIST,     JSON.stringify(state.cacheHistoricos || {}));
    localStorage.setItem(LS_META,     JSON.stringify(state.meta || {ver:1}));
  }catch{}
}

export function clearAll(){
  state.clientesCache   = [];
  state.cacheHistoricos = {};
  state.meta            = { ver: 1 };
  state.nextCursor      = null;
  persist();
}

/* ===========================
   Seleção atual
   =========================== */
export function setClienteSel(c){ state.clienteSel = c; }
export function getClienteSel(){ return state.clienteSel; }

/* ===========================
   Helpers internos
   =========================== */
const byDesc = (a,b) => (b.ultima_msg_id??0) - (a.ultima_msg_id??0);

function normalizeConversa(item){
  // Aceita tanto o formato antigo (clientes) quanto o novo (conversas)
  const conversation_id = item.conversation_id ?? item.id ?? item.cliente_id ?? item.clienteId ?? item.telefone ?? item.name ?? item.nome;
  const lastTs = item.ultima_ts ?? item.hora ?? item.last_ts ?? null;

  return {
    conversation_id,
    cliente_id: item.cliente_id ?? item.id ?? conversation_id,
    nome: item.nome ?? item.name ?? '',
    telefone: item.telefone ?? null,
    avatar_url: item.avatar_url ?? null,
    // preview
    ultima_msg_id: item.ultima_msg_id ?? item.last_msg_id ?? null,
    ultima_texto: (item.ultima_texto ?? item.ultima_mensagem ?? item.preview ?? '') || '',
    ultima_ts: lastTs,
    ultima_tipo: item.ultima_tipo ?? item.last_tipo ?? null,
    ultima_ack: item.ultima_ack ?? item.last_ack ?? null,
    // contadores
    novas: item.novas ?? item.nao_lidas ?? 0,
  };
}

function upsertBy(arr, key, obj){
  const i = arr.findIndex(x => x[key] === obj[key]);
  if (i >= 0){
    arr[i] = { ...arr[i], ...obj };
  } else {
    arr.push(obj);
  }
  return arr;
}

/* ===========================
   Conversas (clientesCache)
   =========================== */
export function getConversas(){
  return state.clientesCache;
}

export function setConversas(items, { nextCursor=null } = {}){
  const norm = (items||[]).map(normalizeConversa);
  state.clientesCache = norm.sort(byDesc);
  if (typeof nextCursor !== 'undefined') state.nextCursor = nextCursor;
  persist();
}

export function appendConversas(items, { nextCursor=null } = {}){
  const cur = state.clientesCache.slice(0);
  for (const it of (items||[])){
    upsertBy(cur, 'conversation_id', normalizeConversa(it));
  }
  state.clientesCache = cur.sort(byDesc);
  if (nextCursor !== null) state.nextCursor = nextCursor;
  persist();
}

export function moveConversaToTop(conversation_id, patch = {}){
  const cur = state.clientesCache.slice(0);
  const idx = cur.findIndex(c => c.conversation_id === conversation_id);
  if (idx === -1) return; // ainda não conhecemos essa conversa
  const updated = { ...cur[idx], ...patch };
  cur.splice(idx, 1);
  cur.unshift(updated);
  state.clientesCache = cur;
  persist();
}

export function setNextCursor(cursor){ state.nextCursor = cursor; persist(); }
export function getNextCursor(){ return state.nextCursor; }

/* ===========================
   Mensagens (cacheHistoricos)
   =========================== */

const MAX_MSGS_PER_CONVERSA = 200; // suficiente; altere se quiser

export function getMsgs(conversation_id){
  return state.cacheHistoricos[String(conversation_id)] || [];
}

/** Salva o histórico da conversa (substitui) */
export function saveMsgs(conversation_id, msgs){
  const arr = Array.isArray(msgs) ? msgs.slice(-MAX_MSGS_PER_CONVERSA) : [];
  state.cacheHistoricos[String(conversation_id)] = arr;
  persist();
}

/** Acrescenta mensagens no fim (típico de novas via WS) */
export function pushMsg(conversation_id, msg){
  const cid = String(conversation_id);
  const arr = state.cacheHistoricos[cid] || [];
  arr.push(msg);
  state.cacheHistoricos[cid] = arr.slice(-MAX_MSGS_PER_CONVERSA);
  persist();
}

/** Pré-carrega lote (ex.: 50 últimas) garantindo ordenação ASC por id/ts */
export function preloadMsgs(conversation_id, msgs){
  if (!Array.isArray(msgs)) msgs = [];
  // tenta ordenar por 'id' ou 'ts'
  const sorted = msgs.slice().sort((a,b) => {
    const ai = a.id ?? 0, bi = b.id ?? 0;
    if (ai && bi) return ai - bi;
    const at = (new Date(a.ts||a.timestamp||0)).getTime();
    const bt = (new Date(b.ts||b.timestamp||0)).getTime();
    return at - bt;
  });
  saveMsgs(conversation_id, sorted);
}

/** Insere mensagens antigas (scroll-back) na frente (sem duplicar) */
export function prependOldMsgs(conversation_id, olderMsgs){
  const cid = String(conversation_id);
  const cur = state.cacheHistoricos[cid] || [];
  const seen = new Set(cur.map(m => m.id ?? m.msg_id));
  const toAdd = (olderMsgs||[]).filter(m => !seen.has(m.id ?? m.msg_id));
  state.cacheHistoricos[cid] = toAdd.concat(cur).slice(-MAX_MSGS_PER_CONVERSA);
  persist();
}

/* ===========================
   Merge de mensagem recebida/enviada
   =========================== */
export function mergeIncomingMessage(conversation_id, message){
  // 1) salva no histórico
  pushMsg(conversation_id, message);

  // 2) atualiza preview e move conversa para o topo
  const preview = {
    ultima_msg_id: message.id ?? message.db_id ?? null,
    ultima_texto: message.texto ?? message.conteudo ?? '',
    ultima_ts: Date.now(),
    ultima_tipo: message.tipo ?? null,
    ultima_ack: typeof message.ack === 'number' ? message.ack : null,
  };
  moveConversaToTop(conversation_id, preview);
}

/* ===========================
   Acks e leitura
   =========================== */
export function updateAck(conversation_id, msg_id, ack){
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
}

export function marcarLidas(conversation_id){
  // zera badge 'novas' e persiste
  const list = state.clientesCache.slice(0);
  const i = list.findIndex(c => c.conversation_id === conversation_id);
  if (i >= 0){
    list[i] = { ...list[i], novas: 0 };
    state.clientesCache = list;
    persist();
  }
}

/* ===========================
   Utilidades diversas
   =========================== */
export function replaceOrInsertConversa(item){
  const norm = normalizeConversa(item);
  state.clientesCache = upsertBy(state.clientesCache.slice(0), 'conversation_id', norm).sort(byDesc);
  persist();
}

export function removeConversa(conversation_id){
  state.clientesCache = state.clientesCache.filter(c => c.conversation_id !== conversation_id);
  delete state.cacheHistoricos[String(conversation_id)];
  persist();
}

/**
 * Aplica um patch em massa de conversas (ex.: retorno do servidor),
 * preservando conversas que já estavam no topo mas não vieram no lote.
 */
export function hydrateConversasFromServer(items, nextCursor = null){
  const map = new Map(state.clientesCache.map(c => [c.conversation_id, c]));
  for (const it of (items||[])){
    const n = normalizeConversa(it);
    map.set(n.conversation_id, { ...(map.get(n.conversation_id)||{}), ...n });
  }
  state.clientesCache = Array.from(map.values()).sort(byDesc);
  state.nextCursor = nextCursor;
  persist();
}

/* ===========================
   Boot helpers
   =========================== */
export function hasAnyCache(){
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
