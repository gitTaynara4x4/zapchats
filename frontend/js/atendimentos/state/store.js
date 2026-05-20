// /frontend/js/atendimentos/state/store.js

import { EMPRESA_ID } from '../core/env.js';

/**
 * STORE (ZapsChat Atendimentos)
 *
 * Objetivo:
 * - Guardar estado leve da lista de conversas.
 * - NÃO carregar histórico pesado no boot.
 * - NÃO salvar histórico duplicado no localStorage.
 *
 * Regra oficial:
 *   conversation_key = c:<cliente_id>:<instancia_id>
 *   conversation_key = g:<grupo_id>:<instancia_id>
 *
 * Correção de performance:
 * - state.histByKey e state.cacheHistoricos agora são memória leve.
 * - LS_HIST_V2 e LS_HIST_LEGACY não são mais hidratados no boot.
 * - persist() não salva histórico no localStorage.
 * - limpa automaticamente caches antigos de histórico.
 * - limita quantidade de conversas guardadas por instância.
 */

const EID = String(EMPRESA_ID ?? '').trim() || '0';

/* =========================
   Keys de storage
   ========================= */
const LS_META = `zc:meta:${EID}`;

// legado
const LS_CLIENTES_LEGACY = `clientesCache:${EID}`;
const LS_HIST_LEGACY = `cacheHistoricos:${EID}`;

// novo
const LS_CONVS_V2 = `zc:convs:v2:${EID}`;
const LS_HIST_V2 = `zc:hist:v2:${EID}`;

/* =========================
   Performance config
   ========================= */
const MAX_CONVS_PER_INST = Number(window.ZC_STORE_MAX_CONVS_PER_INST || 300);
const MAX_MSGS_PER_CONVERSA = Number(window.ZC_STORE_MAX_MSGS_PER_CONVERSA || 180);

/*
  Segurança: lista de conversas pode ficar em localStorage.
  Histórico NÃO.
*/
const STORE_SAVE_HISTORY_TO_LS = false;

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
function safeJsonParse(v, fallback) {
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function getLS(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function setLS(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function delLS(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function normStr(v) {
  return (v == null ? '' : String(v)).trim();
}

function idKey(v) {
  const s = normStr(v);
  if (!s) return null;
  if (s === 'null' || s === 'undefined' || s === 'NaN') return null;
  return s;
}

function idEq(a, b) {
  const A = idKey(a);
  const B = idKey(b);
  return !!A && !!B && A === B;
}

function numOrNull(v) {
  if (v == null) return null;

  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

const MAX_CONVS_SAFE = clampNumber(MAX_CONVS_PER_INST, 50, 1000, 300);
const MAX_MSGS_SAFE = clampNumber(MAX_MSGS_PER_CONVERSA, 50, 500, 180);

function instValue(v) {
  const s = normStr(v);
  if (!s) return null;

  if (
    ['null', 'undefined', 'nan', '0', 'all', '*', '-'].includes(
      s.toLowerCase()
    )
  ) {
    return null;
  }

  return s;
}

function instKeyFromValue(v) {
  return instValue(v) || 'all';
}

function getActiveInstKey() {
  try {
    const k = `instAtiva:${EID}`;
    const fromWindow = instValue(window.INSTANCIA_ATIVA);
    const fromLS = instValue(getLS(k, ''));

    return instKeyFromValue(fromWindow || fromLS || 'all');
  } catch {
    return 'all';
  }
}

function isActiveInst(instanciaKey) {
  return instKeyFromValue(instanciaKey) === getActiveInstKey();
}

function unreadFrom(src) {
  return Number(
    src?.novas ??
    src?.nao_lidas ??
    src?.unread ??
    src?.unread_count ??
    0
  ) || 0;
}

function localStorageKeys() {
  const keys = [];

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
  } catch {}

  return keys;
}

/*
  Limpa histórico antigo/pesado do store.
  Isso não remove login, empresa_id, tema etc.
*/
function cleanupHistoryStorageFromOldStore() {
  try {
    delLS(LS_HIST_LEGACY);
    delLS(LS_HIST_V2);

    for (const k of localStorageKeys()) {
      if (
        k.startsWith('cacheHistoricos:') ||
        k.startsWith(`zc:hist:v2:${EID}`) ||
        k.includes(':hist:') ||
        k.includes(':cursor:')
      ) {
        localStorage.removeItem(k);
      }
    }
  } catch {}
}

try {
  if (!window.__ZC_STORE_CLEANED_HIST_ONCE__) {
    window.__ZC_STORE_CLEANED_HIST_ONCE__ = true;

    setTimeout(() => {
      cleanupHistoryStorageFromOldStore();
    }, 300);
  }
} catch {}

/* =========================
   Conversation ref helpers
   ========================= */
function parseComposedConversationKey(raw) {
  const s = idKey(raw);
  if (!s) return null;

  const m = s.match(/^([cg]):(\d+):([^:]+)$/i);
  if (!m) return null;

  return {
    key: `${m[1].toLowerCase()}:${m[2]}:${m[3]}`,
    kind: m[1].toLowerCase(),
    entityId: m[2],
    instId: instValue(m[3]),
  };
}

function inferKindFromItem(item) {
  const src = item && typeof item === 'object' ? item : {};

  const explicit =
    src?.kind ??
    src?.conversation_kind ??
    src?.tipo_conversa ??
    src?.tipo_ref ??
    null;

  const e = normStr(explicit).toLowerCase();

  if (e === 'c' || e === 'contato' || e === 'cliente') return 'c';
  if (e === 'g' || e === 'grupo' || e === 'group') return 'g';

  const fromKeys = [
    src?.conversation_key,
    src?.conversation_id,
    src?.id,
  ];

  for (const k of fromKeys) {
    const parsed = parseComposedConversationKey(k);
    if (parsed?.kind) return parsed.kind;
  }

  if (
    src?.grupo_id != null ||
    src?.is_group === true ||
    src?.grupo === true ||
    src?.isGroup === true
  ) {
    return 'g';
  }

  return 'c';
}

function inferInstFromItem(item) {
  const src = item && typeof item === 'object' ? item : {};

  const direct =
    src?.instancia_id ??
    src?.instancia ??
    src?.instancia_slug ??
    src?.instance_id ??
    src?.instance ??
    src?.instance_name ??
    src?.session ??
    src?.sessionName ??
    src?.sessao ??
    src?.inst_slug ??
    null;

  const val = instValue(direct);
  if (val) return val;

  const fromKeys = [
    src?.conversation_key,
    src?.conversation_id,
    src?.id,
  ];

  for (const k of fromKeys) {
    const parsed = parseComposedConversationKey(k);
    if (parsed?.instId) return parsed.instId;
  }

  return null;
}

function inferEntityIdFromItem(item, forcedKind = null) {
  const src = item && typeof item === 'object' ? item : {};
  const kind = forcedKind || inferKindFromItem(src);

  const fromKeys = [
    src?.conversation_key,
    src?.conversation_id,
    src?.id,
  ];

  for (const k of fromKeys) {
    const parsed = parseComposedConversationKey(k);
    if (parsed?.entityId) return parsed.entityId;
  }

  const direct =
    src?.entity_id ??
    src?.backend_id ??
    src?.id_backend ??
    src?.conversation_entity_id ??
    (
      kind === 'g'
        ? (src?.grupo_id ?? src?.group_id ?? null)
        : (
            src?.cliente_id ??
            src?.clienteId ??
            src?.cid ??
            src?.id_cliente ??
            src?.idCliente ??
            null
          )
    ) ??
    src?.api_id ??
    src?.id_api ??
    null;

  const s = idKey(direct);
  if (s && /^\d+$/.test(s)) return s;

  return null;
}

function buildConversationKey(kind, entityId, instId) {
  const k = String(kind || '').toLowerCase() === 'g' ? 'g' : 'c';
  const eid = idKey(entityId);
  const iid = instValue(instId);

  if (!eid) return null;

  return `${k}:${eid}:${iid ?? '0'}`;
}

function parseConversationRef(raw, row = null) {
  const rawStr = idKey(raw);

  const fromRowKey =
    idKey(row?.conversation_key) ||
    idKey(row?.conversation_id) ||
    idKey(row?.id) ||
    null;

  const candidate = rawStr || fromRowKey || '';

  const parsed = parseComposedConversationKey(candidate);
  if (parsed) return parsed;

  const kind = inferKindFromItem(row || {});

  const entityId =
    (rawStr && /^\d+$/.test(rawStr) ? rawStr : null) ||
    inferEntityIdFromItem(row || {}, kind) ||
    null;

  const instId = inferInstFromItem(row || {});

  return {
    key: buildConversationKey(kind, entityId, instId) || candidate || '',
    kind,
    entityId,
    instId,
  };
}

function getAllKnownConversas() {
  const out = [];
  const seen = new Set();

  const pushOne = (item) => {
    if (!item || typeof item !== 'object') return;

    const key =
      parseConversationRef(
        item?.conversation_key ?? item?.conversation_id ?? item?.id ?? null,
        item
      ).key || null;

    const dedupeKey = key || `raw:${Math.random()}`;

    if (seen.has(dedupeKey)) return;

    seen.add(dedupeKey);
    out.push(item);
  };

  try {
    Object.values(state?.convsByInst || {}).forEach((box) => {
      (Array.isArray(box?.items) ? box.items : []).forEach(pushOne);
    });
  } catch {}

  try {
    (Array.isArray(state?.clientesCache) ? state.clientesCache : []).forEach(pushOne);
  } catch {}

  try {
    (Array.isArray(state?.todosContatosCache) ? state.todosContatosCache : []).forEach(pushOne);
  } catch {}

  return out;
}

function resolveConversationKeyLoose(raw, row = null, instanciaKey = null) {
  const ref = parseConversationRef(raw, row);

  if (parseComposedConversationKey(ref.key)) return ref.key;

  if (row) {
    const rowRef = parseConversationRef(
      row?.conversation_key ?? row?.conversation_id ?? row?.id ?? null,
      row
    );

    if (parseComposedConversationKey(rowRef.key)) return rowRef.key;
  }

  if (ref.entityId) {
    const all = getAllKnownConversas();

    const wantedInst = instValue(instanciaKey);
    const activeInst = getActiveInstKey();

    const hits = all.filter((c) => {
      const cr = parseConversationRef(
        c?.conversation_key ?? c?.conversation_id ?? c?.id ?? null,
        c
      );

      if (!cr.entityId || cr.entityId !== ref.entityId) return false;
      if (ref.kind && cr.kind && cr.kind !== ref.kind) return false;

      return true;
    });

    if (wantedInst) {
      const exact = hits.find((c) => {
        const cr = parseConversationRef(
          c?.conversation_key ?? c?.conversation_id ?? c?.id ?? null,
          c
        );

        return cr.instId === wantedInst;
      });

      if (exact) {
        return parseConversationRef(
          exact?.conversation_key ?? exact?.conversation_id ?? exact?.id ?? null,
          exact
        ).key;
      }
    }

    if (activeInst && activeInst !== 'all') {
      const exactActive = hits.find((c) => {
        const cr = parseConversationRef(
          c?.conversation_key ?? c?.conversation_id ?? c?.id ?? null,
          c
        );

        return cr.instId === activeInst;
      });

      if (exactActive) {
        return parseConversationRef(
          exactActive?.conversation_key ??
          exactActive?.conversation_id ??
          exactActive?.id ??
          null,
          exactActive
        ).key;
      }
    }

    if (hits.length === 1) {
      return parseConversationRef(
        hits[0]?.conversation_key ?? hits[0]?.conversation_id ?? hits[0]?.id ?? null,
        hits[0]
      ).key;
    }
  }

  return idKey(raw) || null;
}

function convIdOf(item) {
  return resolveConversationKeyLoose(
    item?.conversation_key ??
    item?.conversation_id ??
    item?.id ??
    item?.cliente_id ??
    item?.grupo_id ??
    null,
    item,
    inferInstFromItem(item)
  );
}

function entityIdOf(item) {
  const ref = parseConversationRef(
    item?.conversation_key ??
    item?.conversation_id ??
    item?.id ??
    item?.cliente_id ??
    item?.grupo_id ??
    null,
    item
  );

  return ref.entityId || null;
}

function kindOf(item) {
  const ref = parseConversationRef(
    item?.conversation_key ??
    item?.conversation_id ??
    item?.id ??
    item?.cliente_id ??
    item?.grupo_id ??
    null,
    item
  );

  return ref.kind || 'c';
}

function tsToMillisAny(x) {
  if (!x) return 0;
  if (typeof x === 'number') return x;

  const t = Date.parse(String(x));
  return Number.isFinite(t) ? t : 0;
}

function scoreRecencia(c) {
  const ts =
    tsToMillisAny(
      c?.hora ||
      c?.ultima_ts ||
      c?.last_ts ||
      c?.updated_at ||
      c?.last_message_at
    ) || 0;

  const mid = numOrNull(c?.ultima_msg_id ?? c?.last_msg_id ?? 0) || 0;
  const ack = numOrNull(c?.ultima_ack ?? c?.last_ack ?? c?.ack ?? 0) || 0;

  return ts * 1_000_000 + mid * 1_000 + ack * 10;
}

function sortConversasDesc(arr) {
  const list = Array.isArray(arr) ? arr.slice() : [];

  return list.sort((a, b) => {
    const pinCmp = Number(!!b?.pinned) - Number(!!a?.pinned);
    if (pinCmp !== 0) return pinCmp;

    const recCmp = scoreRecencia(b) - scoreRecencia(a);
    if (recCmp !== 0) return recCmp;

    const ib = convIdOf(b) || '';
    const ia = convIdOf(a) || '';

    return ib.localeCompare(ia, 'pt-BR', {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function compactConversas(arr) {
  const sorted = sortConversasDesc(Array.isArray(arr) ? arr : []);

  /*
    Mantém as mais recentes/fixadas.
    Se o usuário paginar muito, o banco continua sendo a fonte.
  */
  return sorted.slice(0, MAX_CONVS_SAFE);
}

function normalizeConversa(item) {
  const src = item && typeof item === 'object' ? item : {};

  const kind = inferKindFromItem(src);
  const entityId = inferEntityIdFromItem(src, kind);
  const inst = inferInstFromItem(src);

  let conversation_key = convIdOf(src);

  if (!parseComposedConversationKey(conversation_key)) {
    conversation_key = buildConversationKey(kind, entityId, inst) || conversation_key || null;
  }

  const ref = parseConversationRef(conversation_key, {
    ...src,
    kind,
    entity_id: entityId,
    instancia_id: inst,
  });

  const finalKey = ref.key || conversation_key || null;
  const finalKind = ref.kind || kind || 'c';
  const finalEntityId = ref.entityId || entityId || null;
  const finalInst = ref.instId || inst || null;

  const lastTs =
    src?.ultima_ts ??
    src?.hora ??
    src?.last_ts ??
    src?.updated_at ??
    src?.last_message_at ??
    null;

  const preview =
    src?.ultima_texto ??
    src?.ultima_mensagem ??
    src?.preview ??
    src?.last_text ??
    src?.ultima ??
    '';

  const is_group =
    finalKind === 'g' ||
    Boolean(src?.is_group || src?.grupo || src?.isGroup || false);

  const cliente_id =
    finalKind === 'c'
      ? (finalEntityId ?? idKey(src?.cliente_id) ?? null)
      : (idKey(src?.cliente_id) ?? null);

  const grupo_id =
    finalKind === 'g'
      ? (finalEntityId ?? idKey(src?.grupo_id) ?? idKey(src?.group_id) ?? null)
      : (idKey(src?.grupo_id) ?? idKey(src?.group_id) ?? null);

  const unread = unreadFrom(src);

  return {
    ...src,

    id: finalKey ?? idKey(src?.id) ?? null,
    conversation_key: finalKey,
    conversation_id: finalKey,
    kind: finalKind,
    entity_id: finalEntityId,
    backend_id: finalEntityId,

    api_id: finalEntityId,
    cliente_id,
    grupo_id,

    nome_whatsapp: src?.nome_whatsapp ?? null,
    nome: src?.nome ?? src?.name ?? '',
    push_name: src?.push_name ?? null,

    telefone: src?.telefone ?? src?.number ?? src?.wuid ?? src?.numero ?? null,
    telefone_norm: src?.telefone_norm ?? null,

    jid: src?.jid ?? src?.remoteJid ?? null,
    remoteJid: src?.remoteJid ?? src?.jid ?? null,

    avatar_url:
      src?.avatar_url ??
      src?.foto_url ??
      src?.foto ??
      src?.avatar ??
      src?.profile_pic_url ??
      null,

    ultima_msg_id: src?.ultima_msg_id ?? src?.last_msg_id ?? null,
    ultima_mensagem: String(preview || ''),
    hora: lastTs,
    last_ts: src?.last_ts ?? lastTs ?? null,
    last_tipo: src?.ultima_tipo ?? src?.last_tipo ?? src?.tipo ?? null,
    last_ack: src?.ultima_ack ?? src?.last_ack ?? src?.ack ?? null,

    novas: unread,
    unread_count: unread,

    instancia_id: finalInst,
    instancia: finalInst,
    instance_name: src?.instance_name ?? src?.instance ?? finalInst ?? null,

    pinned: Boolean(src?.pinned || src?.fixado || src?.pin || false),
    is_group,
  };
}

function normalizeConvsByInst(raw) {
  const out = {};

  if (!raw || typeof raw !== 'object') return out;

  Object.entries(raw).forEach(([instKey, box]) => {
    const items = Array.isArray(box?.items)
      ? box.items.map(normalizeConversa).filter((it) => !!convIdOf(it))
      : [];

    out[instKeyFromValue(instKey)] = {
      items: compactConversas(items),
      nextCursor: box?.nextCursor ?? null,
      ts: Number(box?.ts || 0) || 0,
    };
  });

  return out;
}

function messageKeyOf(m) {
  return idKey(m?.id) ?? idKey(m?.msg_id) ?? null;
}

function sortMsgsAsc(msgs) {
  return (Array.isArray(msgs) ? msgs : []).slice().sort((a, b) => {
    const ai = numOrNull(a?.id);
    const bi = numOrNull(b?.id);

    if (ai != null && bi != null && ai !== bi) return ai - bi;

    const at = new Date(a?.ts || a?.timestamp || 0).getTime();
    const bt = new Date(b?.ts || b?.timestamp || 0).getTime();

    if (at !== bt) return at - bt;

    const ak = messageKeyOf(a) || '';
    const bk = messageKeyOf(b) || '';

    return ak.localeCompare(bk, 'pt-BR', {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function compactMsgs(msgs) {
  const arr = sortMsgsAsc(Array.isArray(msgs) ? msgs : []);

  if (arr.length <= MAX_MSGS_SAFE) return arr;

  return arr.slice(-MAX_MSGS_SAFE);
}

/* =========================
   Estado inicial
   ========================= */
const _legacyClientes = safeJsonParse(getLS(LS_CLIENTES_LEGACY, '[]'), []);
const _v2Convs = safeJsonParse(getLS(LS_CONVS_V2, '{}'), {});
const _meta = safeJsonParse(getLS(LS_META, '{"ver":3}'), { ver: 3 });

/*
  IMPORTANTE:
  NÃO ler mais:
  - cacheHistoricos:<empresa>
  - zc:hist:v2:<empresa>

  Esses caches antigos eram o que deixava o Chrome pesado.
*/
export const state = {
  clientesCache: Array.isArray(_legacyClientes)
    ? compactConversas(_legacyClientes.map(normalizeConversa))
    : [],

  /*
    Histórico agora nasce vazio.
    Quem cuida do cache de mensagem por conversa é domain/hist-cache.js.
  */
  cacheHistoricos: Object.create(null),
  histByKey: Object.create(null),

  convsByInst: normalizeConvsByInst(_v2Convs),

  meta: {
    ver: 3,
    ...(_meta || {}),
    historyInStoreDisabled: true,
  },

  todosContatosCache: [],

  clienteSel: null,

  nextCursor: null,
  isLoadingMore: false,

  selectionToken: 0,
};

/* =========================
   Compat global
   ========================= */
function syncLegacyGlobals() {
  if (typeof window === 'undefined') return;

  window.state = state;
  window.clientesCache = state.clientesCache;
  window.cacheHistoricos = state.cacheHistoricos;
  window.todosContatosCache = state.todosContatosCache;
  window.clienteSel = state.clienteSel;
  window.DB_MODE = DB_MODE;

  window.persist = persist;
  window.salvarCache = persist;

  window.getConversas = getConversas;
  window.getMsgs = getMsgs;
  window.pushMsg = pushMsg;
  window.preloadMsgs = preloadMsgs;
  window.prependOldMsgs = prependOldMsgs;

  window.getConversationKey = getConversationKey;
  window.getConversationEntityId = getConversationEntityId;
  window.getConversationKind = getConversationKind;
}

function syncActiveCompatFromV2(instanciaKey = null) {
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());
  const box = state.convsByInst?.[k];

  state.clientesCache = Array.isArray(box?.items)
    ? compactConversas(box.items)
    : [];

  state.nextCursor = box?.nextCursor ?? null;

  syncLegacyGlobals();
}

/* =========================
   Persistência
   ========================= */
export function persist() {
  try {
    /*
      Salva só estado leve.
      NÃO salva histórico.
    */
    const safeConvs = normalizeConvsByInst(state.convsByInst || {});

    state.convsByInst = safeConvs;

    setLS(LS_CONVS_V2, JSON.stringify(safeConvs));

    setLS(
      LS_META,
      JSON.stringify({
        ...(state.meta || { ver: 3 }),
        ver: 3,
        historyInStoreDisabled: true,
      })
    );

    setLS(
      LS_CLIENTES_LEGACY,
      JSON.stringify(Array.isArray(state.clientesCache) ? compactConversas(state.clientesCache) : [])
    );

    /*
      Segurança:
      remove histórico duplicado antigo sempre que persistir.
    */
    if (!STORE_SAVE_HISTORY_TO_LS) {
      delLS(LS_HIST_LEGACY);
      delLS(LS_HIST_V2);
    }
  } catch {}

  syncLegacyGlobals();
}

export function clearAll() {
  state.clientesCache = [];
  state.cacheHistoricos = Object.create(null);
  state.convsByInst = {};
  state.histByKey = Object.create(null);
  state.meta = {
    ver: 3,
    historyInStoreDisabled: true,
  };
  state.nextCursor = null;
  state.todosContatosCache = [];
  state.clienteSel = null;

  cleanupHistoryStorageFromOldStore();
  persist();
}

/* =========================
   Helpers públicos de conversa
   ========================= */
export function getConversationKey(value, row = null, instanciaKey = null) {
  return resolveConversationKeyLoose(value, row, instanciaKey);
}

export function getConversationEntityId(value, row = null) {
  const ref = parseConversationRef(value, row);
  return ref.entityId || null;
}

export function getConversationKind(value, row = null) {
  const ref = parseConversationRef(value, row);
  return ref.kind || 'c';
}

/* =========================
   Seleção atual
   ========================= */
export function setClienteSel(c) {
  state.clienteSel = c ? normalizeConversa(c) : null;
  syncLegacyGlobals();
}

export function getClienteSel() {
  return state.clienteSel;
}

/* =========================
   Contatos completos
   ========================= */
export function setTodosContatosCache(items) {
  state.todosContatosCache = Array.isArray(items)
    ? compactConversas(items.map(normalizeConversa))
    : [];

  syncLegacyGlobals();
}

export function getTodosContatosCache() {
  return Array.isArray(state.todosContatosCache) ? state.todosContatosCache : [];
}

/* =========================
   CONVERSAS - V2
   ========================= */
export function getConversasKeyed(instanciaKey = null) {
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());
  const box = state.convsByInst?.[k];

  return Array.isArray(box?.items) ? box.items : [];
}

export function getNextCursorKeyed(instanciaKey = null) {
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());
  return state.convsByInst?.[k]?.nextCursor ?? null;
}

export function setConversasKeyed(items, { nextCursor = null, instanciaKey = null } = {}) {
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());

  const norm = (items || [])
    .map(normalizeConversa)
    .filter((it) => !!convIdOf(it));

  const sorted = compactConversas(norm);

  state.convsByInst[k] = {
    items: sorted,
    nextCursor: typeof nextCursor === 'undefined' ? null : nextCursor,
    ts: Date.now(),
  };

  if (isActiveInst(k)) {
    state.clientesCache = sorted;
    state.nextCursor = state.convsByInst[k].nextCursor;
  }

  persist();
}

export function appendConversasKeyed(items, { nextCursor = null, instanciaKey = null } = {}) {
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());
  const box = state.convsByInst[k] || { items: [], nextCursor: null, ts: 0 };
  const cur = Array.isArray(box.items) ? box.items.slice() : [];

  const map = new Map();

  for (const c of cur) {
    const key = convIdOf(c);
    if (key) map.set(key, c);
  }

  for (const it of (items || [])) {
    const n = normalizeConversa(it);
    const key = convIdOf(n);

    if (!key) continue;

    const prev = map.get(key) || {};
    const merged = normalizeConversa({ ...prev, ...n });
    merged.pinned = Boolean((prev && prev.pinned) || n.pinned);

    map.set(key, merged);
  }

  const sorted = compactConversas([...map.values()]);

  state.convsByInst[k] = {
    items: sorted,
    nextCursor: typeof nextCursor === 'undefined' ? box.nextCursor ?? null : nextCursor,
    ts: Date.now(),
  };

  if (isActiveInst(k)) {
    state.clientesCache = sorted;
    state.nextCursor = state.convsByInst[k].nextCursor;
  }

  persist();
}

function updateConversationInsideBox(boxKey, cid, patch = {}) {
  const k = instKeyFromValue(boxKey);
  const box = state.convsByInst[k] || { items: [], nextCursor: null, ts: 0 };
  const cur = Array.isArray(box.items) ? box.items.slice() : [];

  const idx = cur.findIndex((c) => idEq(convIdOf(c), cid));
  if (idx < 0) return false;

  const prev = normalizeConversa(cur[idx]);
  const mergedPatch = { ...(patch || {}) };

  const oldUnread = unreadFrom(prev);

  const patchHasUnread =
    Object.prototype.hasOwnProperty.call(mergedPatch, 'novas') ||
    Object.prototype.hasOwnProperty.call(mergedPatch, 'unread') ||
    Object.prototype.hasOwnProperty.call(mergedPatch, 'unread_count') ||
    Object.prototype.hasOwnProperty.call(mergedPatch, 'nao_lidas');

  if (!patchHasUnread && oldUnread > 0) {
    mergedPatch.novas = oldUnread;
    mergedPatch.unread_count = oldUnread;
  }

  const updated = normalizeConversa({
    ...prev,
    ...mergedPatch,
    id: cid,
    conversation_key: cid,
    conversation_id: cid,
  });

  cur.splice(idx, 1);
  cur.unshift(updated);

  const sorted = compactConversas(cur);

  state.convsByInst[k] = {
    ...box,
    items: sorted,
    ts: Date.now(),
  };

  if (isActiveInst(k)) {
    state.clientesCache = sorted;
    state.nextCursor = state.convsByInst[k].nextCursor ?? state.nextCursor ?? null;
  }

  return true;
}

export function moveConversaToTopKeyed(conversation_id, patch = {}, instanciaKey = null) {
  const cid = resolveConversationKeyLoose(conversation_id, patch, instanciaKey);
  if (!cid) return false;

  const parsed = parseConversationRef(cid, patch);
  const activeKey = getActiveInstKey();

  const preferredKey = instKeyFromValue(
    instanciaKey ??
    parsed.instId ??
    patch?.instancia_id ??
    patch?.instancia ??
    activeKey
  );

  const candidateKeys = [];

  const addKey = (k) => {
    const kk = instKeyFromValue(k);
    if (!candidateKeys.includes(kk)) candidateKeys.push(kk);
  };

  addKey(preferredKey);
  addKey(activeKey);
  addKey(parsed.instId);
  addKey(patch?.instancia_id);
  addKey(patch?.instancia);
  addKey('all');

  Object.keys(state.convsByInst || {}).forEach(addKey);

  let touched = false;

  for (const k of candidateKeys) {
    if (updateConversationInsideBox(k, cid, patch)) {
      touched = true;
    }
  }

  /*
    Segurança extra:
    se por algum motivo a conversa está em clientesCache mas não está
    no box correto, atualiza a lista visível também.
  */
  try {
    const arr = Array.isArray(state.clientesCache) ? state.clientesCache.slice() : [];
    const idx = arr.findIndex((c) => idEq(convIdOf(c), cid));

    if (idx >= 0) {
      const prev = normalizeConversa(arr[idx]);
      const oldUnread = unreadFrom(prev);
      const mergedPatch = { ...(patch || {}) };

      const patchHasUnread =
        Object.prototype.hasOwnProperty.call(mergedPatch, 'novas') ||
        Object.prototype.hasOwnProperty.call(mergedPatch, 'unread') ||
        Object.prototype.hasOwnProperty.call(mergedPatch, 'unread_count') ||
        Object.prototype.hasOwnProperty.call(mergedPatch, 'nao_lidas');

      if (!patchHasUnread && oldUnread > 0) {
        mergedPatch.novas = oldUnread;
        mergedPatch.unread_count = oldUnread;
      }

      const updated = normalizeConversa({
        ...prev,
        ...mergedPatch,
        id: cid,
        conversation_key: cid,
        conversation_id: cid,
      });

      arr.splice(idx, 1);
      arr.unshift(updated);

      const sorted = compactConversas(arr);
      state.clientesCache = sorted;

      const ak = activeKey;
      const box = state.convsByInst[ak] || {
        items: [],
        nextCursor: state.nextCursor ?? null,
        ts: 0,
      };

      state.convsByInst[ak] = {
        ...box,
        items: sorted,
        ts: Date.now(),
      };

      touched = true;
    }
  } catch {}

  /*
    Se a conversa ainda não existe em nenhuma lista, cria entrada mínima.
  */
  if (!touched) {
    const insertKey = preferredKey || activeKey || 'all';

    const n = normalizeConversa({
      id: cid,
      conversation_key: cid,
      conversation_id: cid,
      kind: parsed.kind || patch?.kind || 'c',
      entity_id:
        parsed.entityId ||
        patch?.entity_id ||
        patch?.cliente_id ||
        patch?.grupo_id ||
        null,
      cliente_id:
        (parsed.kind || patch?.kind) === 'g'
          ? patch?.cliente_id ?? null
          : (parsed.entityId || patch?.cliente_id || null),
      grupo_id:
        (parsed.kind || patch?.kind) === 'g'
          ? (parsed.entityId || patch?.grupo_id || null)
          : patch?.grupo_id ?? null,
      instancia_id: parsed.instId || patch?.instancia_id || patch?.instancia || null,
      instancia: parsed.instId || patch?.instancia_id || patch?.instancia || null,
      ...patch,
    });

    const box = state.convsByInst[insertKey] || {
      items: [],
      nextCursor: null,
      ts: 0,
    };

    const cur = Array.isArray(box.items) ? box.items.slice() : [];
    cur.unshift(n);

    const sorted = compactConversas(cur);

    state.convsByInst[insertKey] = {
      ...box,
      items: sorted,
      ts: Date.now(),
    };

    if (isActiveInst(insertKey) || activeKey === insertKey) {
      state.clientesCache = sorted;
      state.nextCursor = state.convsByInst[insertKey].nextCursor ?? state.nextCursor ?? null;
    }

    touched = true;
  }

  persist();
  return touched;
}

/* =========================
   CONVERSAS - LEGADO
   ========================= */
export function getConversas() {
  syncActiveCompatFromV2();
  return state.clientesCache || [];
}

export function setConversas(items, { nextCursor = null } = {}) {
  setConversasKeyed(items, {
    nextCursor,
    instanciaKey: getActiveInstKey(),
  });
}

export function appendConversas(items, { nextCursor = null } = {}) {
  appendConversasKeyed(items, {
    nextCursor,
    instanciaKey: getActiveInstKey(),
  });
}

export function moveConversaToTop(conversation_id, patch = {}) {
  return moveConversaToTopKeyed(conversation_id, patch, getActiveInstKey());
}

export function setNextCursor(cursor) {
  const k = getActiveInstKey();
  const box = state.convsByInst[k] || { items: [], nextCursor: null, ts: 0 };

  box.nextCursor = cursor;
  state.convsByInst[k] = box;

  if (isActiveInst(k)) {
    state.nextCursor = cursor;
  }

  persist();
}

export function getNextCursor() {
  syncActiveCompatFromV2();
  return state.nextCursor;
}

/* =========================
   HISTÓRICO - V2
   ========================= */
function makeHistKey(instanciaKey, conversation_id) {
  const ref = parseConversationRef(conversation_id);
  const cid = resolveConversationKeyLoose(conversation_id, null, instanciaKey);
  const k = instKeyFromValue(ref.instId ?? instanciaKey ?? getActiveInstKey());

  return cid ? `${k}:${cid}` : `${k}:__invalid__`;
}

export function getMsgsKeyed(instanciaKey, conversation_id) {
  const hk = makeHistKey(instanciaKey, conversation_id);
  const cid = resolveConversationKeyLoose(conversation_id, null, instanciaKey);

  const arr =
    state.histByKey[hk] ||
    state.cacheHistoricos[String(cid)] ||
    [];

  return Array.isArray(arr) ? arr : [];
}

export function saveMsgsKeyed(instanciaKey, conversation_id, msgs) {
  const hk = makeHistKey(instanciaKey, conversation_id);
  const cid = resolveConversationKeyLoose(conversation_id, null, instanciaKey);
  const arr = compactMsgs(msgs);

  state.histByKey[hk] = arr;

  if (cid) {
    state.cacheHistoricos[String(cid)] = arr;
  }

  /*
    Não salva histórico no localStorage.
    Só sincroniza globals.
  */
  syncLegacyGlobals();

  return arr;
}

export function pushMsgKeyed(instanciaKey, conversation_id, msg) {
  const hk = makeHistKey(instanciaKey, conversation_id);
  const cid = resolveConversationKeyLoose(conversation_id, null, instanciaKey);

  const arr =
    state.histByKey[hk] ||
    state.cacheHistoricos[String(cid)] ||
    [];

  const msgKey = messageKeyOf(msg);
  const exists = msgKey ? arr.some((m) => messageKeyOf(m) === msgKey) : false;

  const next = exists
    ? arr.map((m) => messageKeyOf(m) === msgKey ? { ...m, ...msg } : m)
    : arr.concat(msg);

  const sorted = compactMsgs(next);

  state.histByKey[hk] = sorted;

  if (cid) {
    state.cacheHistoricos[String(cid)] = sorted;
  }

  syncLegacyGlobals();

  return sorted;
}

export function preloadMsgsKeyed(instanciaKey, conversation_id, msgs) {
  return saveMsgsKeyed(instanciaKey, conversation_id, sortMsgsAsc(msgs));
}

export function prependOldMsgsKeyed(instanciaKey, conversation_id, olderMsgs) {
  const hk = makeHistKey(instanciaKey, conversation_id);
  const cid = resolveConversationKeyLoose(conversation_id, null, instanciaKey);

  const cur =
    state.histByKey[hk] ||
    state.cacheHistoricos[String(cid)] ||
    [];

  const seen = new Set(cur.map((m) => messageKeyOf(m)).filter(Boolean));

  const toAdd = (olderMsgs || []).filter((m) => {
    const key = messageKeyOf(m);

    if (!key) return true;

    return !seen.has(key);
  });

  const sorted = compactMsgs(toAdd.concat(cur));

  state.histByKey[hk] = sorted;

  if (cid) {
    state.cacheHistoricos[String(cid)] = sorted;
  }

  syncLegacyGlobals();

  return sorted;
}

/* =========================
   HISTÓRICO - LEGADO
   ========================= */
export function getMsgs(conversation_id) {
  const cid = resolveConversationKeyLoose(conversation_id) || String(conversation_id);
  const arr = state.cacheHistoricos[String(cid)] || [];

  return Array.isArray(arr) ? arr : [];
}

export function saveMsgs(conversation_id, msgs) {
  const cid = resolveConversationKeyLoose(conversation_id) || String(conversation_id);
  const arr = compactMsgs(msgs);

  state.cacheHistoricos[String(cid)] = arr;

  syncLegacyGlobals();

  return arr;
}

export function pushMsg(conversation_id, msg) {
  const cid = resolveConversationKeyLoose(conversation_id) || String(conversation_id);
  const arr = state.cacheHistoricos[cid] || [];

  const msgKey = messageKeyOf(msg);
  const exists = msgKey ? arr.some((m) => messageKeyOf(m) === msgKey) : false;

  const next = exists
    ? arr.map((m) => messageKeyOf(m) === msgKey ? { ...m, ...msg } : m)
    : arr.concat(msg);

  const sorted = compactMsgs(next);

  state.cacheHistoricos[cid] = sorted;

  syncLegacyGlobals();

  return sorted;
}

export function preloadMsgs(conversation_id, msgs) {
  return saveMsgs(conversation_id, sortMsgsAsc(msgs));
}

export function prependOldMsgs(conversation_id, olderMsgs) {
  const cid = resolveConversationKeyLoose(conversation_id) || String(conversation_id);
  const cur = state.cacheHistoricos[cid] || [];
  const seen = new Set(cur.map((m) => messageKeyOf(m)).filter(Boolean));

  const toAdd = (olderMsgs || []).filter((m) => {
    const key = messageKeyOf(m);

    if (!key) return true;

    return !seen.has(key);
  });

  const sorted = compactMsgs(toAdd.concat(cur));

  state.cacheHistoricos[cid] = sorted;

  syncLegacyGlobals();

  return sorted;
}

/* =========================
   Merge de mensagem
   ========================= */
export function mergeIncomingMessage(conversation_id, message, instanciaKey = null) {
  const cid =
    resolveConversationKeyLoose(conversation_id, message, instanciaKey) ||
    resolveConversationKeyLoose(message?.conversation_key, message, instanciaKey);

  if (!cid) return;

  const targetInst = instKeyFromValue(
    parseConversationRef(cid, message).instId ??
    instanciaKey ??
    message?.instancia_id ??
    message?.instancia ??
    getActiveInstKey()
  );

  try {
    pushMsgKeyed(targetInst, cid, message);
  } catch {}

  const msgTs =
    message?.ts ??
    message?.timestamp ??
    message?.data ??
    message?.created_at ??
    null;

  const preview = {
    conversation_key: cid,
    conversation_id: cid,
    ultima_msg_id: message.id ?? message.db_id ?? message.msg_id ?? null,
    ultima_mensagem: message.texto ?? message.conteudo ?? message.mensagem ?? '',
    hora: msgTs || new Date().toISOString(),
    last_ts: msgTs || new Date().toISOString(),
    last_tipo: message.tipo ?? null,
    last_ack: typeof message.ack === 'number' ? message.ack : null,
  };

  try {
    moveConversaToTopKeyed(cid, preview, targetInst);
  } catch {}
}

/* =========================
   Acks e leitura
   ========================= */
export function updateAck(conversation_id, msg_id, ack, instanciaKey = null) {
  const cid = resolveConversationKeyLoose(conversation_id, null, instanciaKey);
  if (!cid) return;

  try {
    const hk = makeHistKey(instanciaKey ?? getActiveInstKey(), cid);
    const arr = state.histByKey[hk] || [];
    let changed = false;
    const wanted = idKey(msg_id);

    for (const m of arr) {
      const mid = messageKeyOf(m);

      if (wanted && mid === wanted) {
        m.ack = ack;
        changed = true;
        break;
      }
    }

    if (changed) {
      state.histByKey[hk] = compactMsgs(arr);
      state.cacheHistoricos[String(cid)] = state.histByKey[hk];
      syncLegacyGlobals();
    }
  } catch {}

  try {
    const arr = state.cacheHistoricos[String(cid)] || [];
    let changed = false;
    const wanted = idKey(msg_id);

    for (const m of arr) {
      const mid = messageKeyOf(m);

      if (wanted && mid === wanted) {
        m.ack = ack;
        changed = true;
        break;
      }
    }

    if (changed) {
      state.cacheHistoricos[String(cid)] = compactMsgs(arr);
      syncLegacyGlobals();
    }
  } catch {}
}

export function marcarLidas(conversation_id, instanciaKey = null) {
  const cid = resolveConversationKeyLoose(conversation_id, null, instanciaKey);
  if (!cid) return;

  const k = instKeyFromValue(
    parseConversationRef(cid).instId ??
    instanciaKey ??
    getActiveInstKey()
  );

  const applyZero = (item) => normalizeConversa({
    ...item,
    novas: 0,
    unread: 0,
    unread_count: 0,
    nao_lidas: 0,
  });

  try {
    const box = state.convsByInst[k];
    const items = Array.isArray(box?.items) ? box.items.slice() : [];
    const i = items.findIndex((c) => idEq(convIdOf(c), cid));

    if (i >= 0) {
      items[i] = applyZero(items[i]);

      state.convsByInst[k] = {
        ...(box || {}),
        items: compactConversas(items),
        ts: Date.now(),
      };

      if (isActiveInst(k)) {
        state.clientesCache = state.convsByInst[k].items;
      }
    }
  } catch {}

  try {
    const list = state.clientesCache.slice(0);
    const i = list.findIndex((c) => idEq(convIdOf(c), cid));

    if (i >= 0) {
      list[i] = applyZero(list[i]);
      state.clientesCache = compactConversas(list);
    }
  } catch {}

  persist();
}

/* =========================
   Utilidades diversas
   ========================= */
export function replaceOrInsertConversa(item, instanciaKey = null) {
  const n = normalizeConversa(item);
  const cid = convIdOf(n);

  if (!cid) return;

  const k = instKeyFromValue(
    parseConversationRef(cid, n).instId ??
    instanciaKey ??
    getActiveInstKey()
  );

  const box = state.convsByInst[k] || { items: [], nextCursor: null, ts: 0 };
  const cur = Array.isArray(box.items) ? box.items.slice() : [];

  const idx = cur.findIndex((c) => idEq(convIdOf(c), cid));

  if (idx >= 0) {
    const prev = normalizeConversa(cur[idx]);
    cur[idx] = normalizeConversa({ ...prev, ...n });
  } else {
    cur.push(n);
  }

  const sorted = compactConversas(cur);

  state.convsByInst[k] = {
    ...box,
    items: sorted,
    ts: Date.now(),
  };

  if (isActiveInst(k)) {
    state.clientesCache = sorted;
  }

  persist();
}

export function removeConversa(conversation_id, instanciaKey = null) {
  const cid = resolveConversationKeyLoose(conversation_id, null, instanciaKey);
  if (!cid) return;

  const k = instKeyFromValue(
    parseConversationRef(cid).instId ??
    instanciaKey ??
    getActiveInstKey()
  );

  try {
    const box = state.convsByInst[k] || { items: [], nextCursor: null, ts: 0 };
    const items = Array.isArray(box.items) ? box.items : [];

    state.convsByInst[k] = {
      ...box,
      items: compactConversas(items.filter((c) => !idEq(convIdOf(c), cid))),
      ts: Date.now(),
    };

    delete state.histByKey[makeHistKey(k, cid)];

    if (isActiveInst(k)) {
      state.clientesCache = state.convsByInst[k].items;
      state.nextCursor = state.convsByInst[k].nextCursor ?? null;
    }
  } catch {}

  try {
    state.clientesCache = compactConversas(
      (state.clientesCache || []).filter((c) => !idEq(convIdOf(c), cid))
    );

    delete state.cacheHistoricos[String(cid)];
  } catch {}

  persist();
}

export function hydrateConversasFromServer(items, nextCursor = null, instanciaKey = null) {
  const k = instKeyFromValue(instanciaKey ?? getActiveInstKey());
  const box = state.convsByInst[k] || { items: [], nextCursor: null, ts: 0 };

  const map = new Map();

  for (const c of (box.items || [])) {
    const key = convIdOf(c);

    if (key) map.set(key, c);
  }

  for (const it of (items || [])) {
    const n = normalizeConversa(it);
    const key = convIdOf(n);

    if (!key) continue;

    const prev = map.get(key) || {};
    map.set(key, normalizeConversa({ ...prev, ...n }));
  }

  const merged = compactConversas([...map.values()]);

  state.convsByInst[k] = {
    items: merged,
    nextCursor,
    ts: Date.now(),
  };

  if (isActiveInst(k)) {
    state.clientesCache = merged;
    state.nextCursor = nextCursor;
  }

  persist();
}

/* =========================
   Boot helpers
   ========================= */
export function hasAnyCache() {
  const k = getActiveInstKey();
  const v2 = getConversasKeyed(k);

  if (Array.isArray(v2) && v2.length) return true;

  return !!(state.clientesCache && state.clientesCache.length > 0);
}

export function rememberBootFetched(flag = true) {
  DB_MODE.bootFetched = !!flag;
  syncLegacyGlobals();
}

export function setMeta(key, value) {
  state.meta = {
    ...(state.meta || {}),
    [key]: value,
  };

  persist();
}

export function getMeta(key, def = null) {
  const m = state.meta || {};
  return key in m ? m[key] : def;
}

/* =========================
   Debug leve
   ========================= */
export function getStoreStats() {
  const convBoxes = Object.entries(state.convsByInst || {}).map(([k, box]) => ({
    instancia: k,
    conversas: Array.isArray(box?.items) ? box.items.length : 0,
    nextCursor: box?.nextCursor ?? null,
  }));

  const histKeys = Object.keys(state.histByKey || {});
  const legacyHistKeys = Object.keys(state.cacheHistoricos || {});

  return {
    empresa_id: EID,
    activeInst: getActiveInstKey(),
    convBoxes,
    totalHistKeysMemory: histKeys.length,
    totalLegacyHistKeysMemory: legacyHistKeys.length,
    historySavedToLocalStorage: STORE_SAVE_HISTORY_TO_LS,
    maxConvsPerInst: MAX_CONVS_SAFE,
    maxMsgsPerConversationMemory: MAX_MSGS_SAFE,
  };
}

try {
  window.zcStoreStats = getStoreStats;
} catch {}

/* =========================
   Bootstrap
   ========================= */
(function bootstrapActiveFromV2() {
  syncActiveCompatFromV2();

  cleanupHistoryStorageFromOldStore();

  if (typeof document !== 'undefined') {
    document.addEventListener('inst:change', () => {
      syncActiveCompatFromV2();
    });
  }
})();