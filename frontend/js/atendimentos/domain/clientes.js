// /frontend/js/atendimentos/domain/clientes.js
// =====================================================================
// LISTA DE CONVERSAS (render, dedupe, preview, paginação)
// ✅ Falhou imagem => placeholder (SEM refresh)
// ✅ Daily refresh 1x/dia: só sem foto, top 50, conc 2, localStorage
// ✅ FIX GRUPOS: detecta JID @g.us, preserva jid/remoteJid, is_group, normaliza tel
// ✅ FIX CHATKEY: conversation_key canônica = c:<cliente_id>:<instancia_id> / g:<grupo_id>:<instancia_id>
// ✅ Dedupe seguro: conversa é identificada por conversation_key
// ✅ Dedupe legado: fallback por entity_id + instância + kind quando vier item cru
// ✅ Click/merge: mantém instância + dados canônicos (jid/tel_norm)
// ✅ FIX BIGINT/GRUPOS: IDs string-first (NUNCA Number() no id da conversa)
// ✅ ALINHADO COM store.js v2 (convsByInst + clientesCache legado)
// ✅ FIX HORÁRIO: nunca inventa “agora” quando ts vier vazio/inválido
// ✅ FIX STALE: primeira página é fonte da verdade (não reanexa conversas velhas do cache)
// ✅ FIX PREVIEW: só chama syncPreviewFromCache quando JÁ existe histórico em cache
// =====================================================================

import { EMPRESA_ID } from '../core/env.js';
import { fetchWithCache } from '../core/cache.js';
import { _matchInstancia, _instQuery } from './instances.js';
import {
  state,
  persist,
  getConversationKey,
  getConversationEntityId,
  getConversationKind,
} from '../state/store.js';
import { tsToMillis, formatChatTime } from '../core/time.js';
import { escapeHtml, formatarNumeroBR, badge } from '../core/format.js';
import { primeWith, getHist } from './hist-cache.js';

/* =========================================================
   ID helpers (string-first)
   ========================================================= */
function idKey(v) {
  const s = String(v ?? '').trim();
  if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
  return s;
}
function idEq(a, b) {
  const A = idKey(a);
  const B = idKey(b);
  if (!A || !B) return false;
  return A === B;
}
function idToBig(v) {
  const s = idKey(v);
  if (!s) return 0n;
  if (/^\d+$/.test(s)) {
    try { return BigInt(s); } catch { return 0n; }
  }
  return 0n;
}
function normStr(v) {
  return String(v ?? '').trim();
}
function instKey(v) {
  const s = normStr(v);
  if (!s) return null;
  if (['null', 'undefined', 'nan', '0', 'all', '*', '-'].includes(s.toLowerCase())) return null;
  return s;
}
function onlyDigits(s) {
  return String(s ?? '').replace(/\D+/g, '');
}

/* =========================================================
   Conversation key helpers
   ========================================================= */
function parseConversationKey(raw) {
  const s = idKey(raw);
  if (!s) return null;
  const m = s.match(/^([cg]):(\d+):([^:]+)$/i);
  if (!m) return null;
  return {
    key: `${m[1].toLowerCase()}:${m[2]}:${m[3]}`,
    kind: m[1].toLowerCase(),
    entityId: m[2],
    instId: instKey(m[3]),
  };
}

function buildConversationKey(kind, entityId, instanciaId) {
  const k = String(kind || '').toLowerCase() === 'g' ? 'g' : 'c';
  const eid = idKey(entityId);
  const iid = instKey(instanciaId);
  if (!eid) return null;
  return `${k}:${eid}:${iid ?? '0'}`;
}

function convRefOf(itemOrId, row = null) {
  if (typeof itemOrId === 'object' && itemOrId) {
    const item = itemOrId;
    const raw =
      item?.conversation_key ??
      item?.conversation_id ??
      item?.id ??
      item?.cliente_id ??
      item?.grupo_id ??
      null;

    const parsed = parseConversationKey(raw);
    if (parsed) return parsed;

    const kind = getConversationKind(raw, item) || (Boolean(item?.is_group) ? 'g' : 'c');
    const entityId =
      getConversationEntityId(raw, item) ??
      idKey(item?.entity_id) ??
      idKey(kind === 'g' ? item?.grupo_id : item?.cliente_id) ??
      null;
    const instId =
      instKey(item?.instancia_id) ??
      instKey(item?.instancia) ??
      instKey(item?.instance_name) ??
      null;

    const key = getConversationKey(raw, item, instId) || buildConversationKey(kind, entityId, instId) || idKey(raw);
    const reparsed = parseConversationKey(key);

    return reparsed || {
      key,
      kind,
      entityId,
      instId,
    };
  }

  const raw = itemOrId;
  const parsed = parseConversationKey(raw);
  if (parsed) return parsed;

  const key = getConversationKey(raw, row || null) || idKey(raw);
  const reparsed = parseConversationKey(key);

  if (reparsed) return reparsed;

  return {
    key,
    kind: row ? (getConversationKind(raw, row) || (Boolean(row?.is_group) ? 'g' : 'c')) : null,
    entityId: row ? (getConversationEntityId(raw, row) || null) : (/^\d+$/.test(String(key || '')) ? String(key) : null),
    instId: row
      ? (instKey(row?.instancia_id) ?? instKey(row?.instancia) ?? instKey(row?.instance_name) ?? null)
      : null,
  };
}

function convKeyOf(itemOrId, row = null) {
  return convRefOf(itemOrId, row).key || null;
}
function convEntityIdOf(itemOrId, row = null) {
  return convRefOf(itemOrId, row).entityId || null;
}
function convKindOf(itemOrId, row = null) {
  return convRefOf(itemOrId, row).kind || 'c';
}

function sameConversation(a, b) {
  const A = convKeyOf(a, typeof a === 'object' ? a : null);
  const B = convKeyOf(b, typeof b === 'object' ? b : null);
  if (A && B) return A === B;

  const ra = convRefOf(a, typeof a === 'object' ? a : null);
  const rb = convRefOf(b, typeof b === 'object' ? b : null);
  return !!ra.entityId && !!rb.entityId &&
    ra.entityId === rb.entityId &&
    (ra.kind || 'c') === (rb.kind || 'c') &&
    (ra.instId || '') === (rb.instId || '');
}

/* =========================================================
   Toggle global: prefetch leve de mensagens (ligado por padrão)
   ========================================================= */
if (typeof window !== 'undefined') {
  if (window.PREFETCH_HISTORIES === undefined) {
    window.PREFETCH_HISTORIES = true;
  }
}

/* =========================================================
   Compat refs (legado)
   ========================================================= */
function syncLegacyRefs() {
  try { window.clientesCache = Array.isArray(state.clientesCache) ? state.clientesCache : []; } catch {}
  try { window.todosContatosCache = Array.isArray(state.todosContatosCache) ? state.todosContatosCache : []; } catch {}
  try { window.cacheHistoricos = window.cacheHistoricos || Object.create(null); } catch {}
}

function getActiveInstKey() {
  try {
    const emp = Number(localStorage.getItem('empresa_id') || EMPRESA_ID || 0);
    const lsKey = emp ? `instAtiva:${emp}` : null;
    const w = instKey(window.INSTANCIA_ATIVA);
    const ls = lsKey ? instKey(localStorage.getItem(lsKey) || '') : null;
    return (w || ls || 'all');
  } catch {
    return 'all';
  }
}

function syncActiveConvs(list, nextCursor = null) {
  const items = Array.isArray(list) ? list.slice() : [];
  const instKeyNow = getActiveInstKey();

  state.convsByInst = state.convsByInst || {};
  state.convsByInst[instKeyNow] = {
    items,
    nextCursor: nextCursor ?? null,
    ts: Date.now(),
  };

  state.clientesCache = items;
  state.nextCursor = nextCursor ?? null;

  syncLegacyRefs();
  persist();
}

/* =========================================================
   AVATAR: handlers globais (placeholder-only, sem refresh onerror)
   ========================================================= */
function _ensureAvatarPlaceholder(span) {
  try {
    if (!span) return;
    span.classList.add('placeholder');
    span.innerHTML = '<i class="fa fa-user-circle"></i>';
  } catch {}
}

if (typeof window !== 'undefined') {
  window.handleListAvatarError = function (imgEl) {
    try {
      if (!imgEl) return;
      try { imgEl.onerror = null; } catch {}
      const span = imgEl.closest?.('.avatar') || imgEl.parentElement;
      try { imgEl.remove(); } catch {}
      _ensureAvatarPlaceholder(span);
    } catch {}
  };

  window.handleAvatarError = function (imgEl) {
    try {
      if (!imgEl) return;
      try { imgEl.onerror = null; } catch {}
      const span = imgEl.closest?.('.avatar') || imgEl.parentElement;
      try { imgEl.remove(); } catch {}
      if (span) {
        span.classList.add('avatar-default');
        span.innerHTML = '<i class="fa fa-user-circle text-2xl text-gray-400"></i>';
      }
    } catch {}
  };
}

/* =========================================================
   Daily refresh (1x/dia) - só quem tá sem foto, top 50, conc 2
   ========================================================= */
let __dailyKickScheduled = false;
let __dailyRunning = false;

function _ymdLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}
function _dailyKey() {
  return `av_daily:v1:e${Number(EMPRESA_ID || 0)}:d${_ymdLocal()}`;
}
function _shouldRunDaily() {
  try {
    if (window.AVATAR_DAILY_REFRESH === false) return false;
    const k = _dailyKey();
    return !localStorage.getItem(k);
  } catch {
    return true;
  }
}
function _markDaily() {
  try { localStorage.setItem(_dailyKey(), String(Date.now())); } catch {}
}

async function runDailyAvatarRefresh() {
  try {
    if (__dailyRunning) return;
    if (!_shouldRunDaily()) return;
    if (typeof window.refreshAvatarFromEvolution !== 'function') return;

    __dailyRunning = true;

    const limit = Math.max(1, Math.min(200, Number(window.AVATAR_DAILY_LIMIT || 50)));
    const conc = Math.max(1, Math.min(6, Number(window.AVATAR_DAILY_CONCURRENCY || 2)));

    const base = Array.isArray(state.clientesCache) ? state.clientesCache.slice() : [];
    if (!base.length) { _markDaily(); return; }

    const topRecent = ordenarConversasDesc(base).slice(0, limit);
    const targets = topRecent.filter((c) => {
      if (c?.avatar_url) return false;
      if (convKindOf(c) !== 'c') return false; // só contato, grupo não usa refresh de profile igual
      return true;
    });

    _markDaily();
    if (!targets.length) return;

    const queue = targets.slice();

    const workers = Array.from(
      { length: Math.min(conc, queue.length) },
      async () => {
        while (queue.length) {
          const c = queue.shift();
          const entityId = convEntityIdOf(c);
          if (!entityId || !/^\d+$/.test(String(entityId))) continue;

          const cidNum = Number(entityId);
          if (!Number.isFinite(cidNum) || cidNum <= 0) continue;

          const number = (c?.telefone_norm || c?.telefone || c?.number || '');
          const instRaw = (c?.instancia_id ?? c?.instancia ?? null);

          const opt = { trigger: 'daily', number, instancia_raw: instRaw };
          try { await window.refreshAvatarFromEvolution(cidNum, opt); } catch {}
        }
      }
    );

    await Promise.all(workers);
  } finally {
    __dailyRunning = false;
  }
}

function kickDailyAvatarRefreshSoon() {
  if (__dailyKickScheduled) return;
  __dailyKickScheduled = true;
  setTimeout(() => { try { runDailyAvatarRefresh(); } catch {} }, 350);
}

if (typeof window !== 'undefined') {
  window.runDailyAvatarRefresh = window.runDailyAvatarRefresh || runDailyAvatarRefresh;
}

/* =========================================================
   Helpers
   ========================================================= */
function isGroupJid(s) {
  const v = String(s || '');
  return /@g\.us$/i.test(v);
}
function looksLikeNumericGroupId(digits) {
  const d = String(digits || '');
  return d.startsWith('120') && d.length >= 15;
}
function normalizeJidOrPhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { is_group: false, jid: '', tel_norm: '' };

  if (s.includes('@')) {
    const jid = s;
    return { is_group: isGroupJid(jid), jid, tel_norm: '' };
  }

  const d = onlyDigits(s);

  if (looksLikeNumericGroupId(d)) {
    return { is_group: true, jid: `${d}@g.us`, tel_norm: '' };
  }

  const sem55 = (d.startsWith('55') && d.length > 11) ? d.slice(2) : d;
  const tel_norm = (sem55.length === 10 || sem55.length === 11) ? sem55 : '';
  return { is_group: false, jid: '', tel_norm };
}
function normalizaTelefoneBR(s) {
  const raw = String(s ?? '');
  if (raw.includes('@')) return '';
  const d = raw.replace(/\D/g, '');
  if (looksLikeNumericGroupId(d)) return '';
  const sem55 = (d.startsWith('55') && d.length > 11) ? d.slice(2) : d;
  return (sem55.length === 10 || sem55.length === 11) ? sem55 : '';
}
function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}
function temValor(v) {
  return v !== undefined && v !== null;
}

function scoreRecencia(c) {
  const ts = tsToMillis(c.hora || c.last_ts) || 0;
  const mid = Number(c.ultima_msg_id || 0);
  const ack = Number(c.last_ack || 0);
  const ava = c.avatar_url ? 1 : 0;
  return ts * 1_000_000 + mid * 1_000 + ack * 10 + ava;
}

function ordenarConversasDesc(arr) {
  const A = Array.isArray(arr) ? arr.slice() : [];
  return A.sort((a, b) => {
    const pinCmp = Number(b?.pinned ? 1 : 0) - Number(a?.pinned ? 1 : 0);
    if (pinCmp !== 0) return pinCmp;

    const recCmp = scoreRecencia(b) - scoreRecencia(a);
    if (recCmp !== 0) return recCmp;

    const kb = convKeyOf(b) || '';
    const ka = convKeyOf(a) || '';
    return kb.localeCompare(ka, 'pt-BR', { numeric: true, sensitivity: 'base' });
  });
}

function getHistoryForConversation(convOrId) {
  const convKey = typeof convOrId === 'object'
    ? convKeyOf(convOrId)
    : convKeyOf(convOrId);

  if (!convKey) return [];

  const inst = typeof convOrId === 'object'
    ? (convOrId?.instancia_id ?? convOrId?.instancia ?? parseConversationKey(convKey)?.instId ?? null)
    : (parseConversationKey(convKey)?.instId ?? null);

  const keyed = getHist(inst, convKey);
  if (Array.isArray(keyed) && keyed.length) return keyed;

  const legacy = window.cacheHistoricos?.[convKey];
  if (Array.isArray(legacy) && legacy.length) return legacy;

  return [];
}

function syncPreviewIfCached(convOrId) {
  try {
    const convKey = typeof convOrId === 'object'
      ? convKeyOf(convOrId)
      : convKeyOf(convOrId);

    if (!convKey) return false;

    const hist = getHistoryForConversation(convOrId);
    if (!hist.length) return false;

    window.syncPreviewFromCache?.(convKey);
    return true;
  } catch {
    return false;
  }
}

/* =========================================================
   Dedupe
   - prioridade total: conversation_key
   - fallback: kind + entity_id + instância
   - fallback legado apenas quando não houver entity_id
   ========================================================= */
function dedupeConversas(arr) {
  if (!Array.isArray(arr)) return [];

  const base = ordenarConversasDesc(arr.map(normalizeCliente));

  const exact = new Map();

  for (const c of base) {
    const convKey = convKeyOf(c);
    const ref = convRefOf(c);

    const dedupeKey =
      convKey ||
      (ref.entityId ? `${ref.kind || 'c'}:${ref.entityId}:${ref.instId || '0'}` : null) ||
      null;

    if (!dedupeKey) continue;

    const cur = exact.get(dedupeKey);
    if (!cur || scoreRecencia(c) > scoreRecencia(cur)) {
      exact.set(dedupeKey, mergeConversaCanonica(c, cur));
    } else if (cur) {
      cur.pinned = Boolean(cur.pinned || c.pinned);
    }
  }

  const noEntity = [];
  for (const c of exact.values()) {
    const ref = convRefOf(c);
    if (!ref.entityId) noEntity.push(c);
  }

  const already = new Map();
  for (const c of exact.values()) {
    const ref = convRefOf(c);
    if (ref.entityId) already.set(convKeyOf(c), c);
  }

  const legacyMap = new Map();
  for (const c of noEntity) {
    const ref = convRefOf(c);
    const inst = ref.instId || instKey(c.instancia_id ?? c.instancia) || 'all';
    const isGrp = Boolean(c.is_group) || ref.kind === 'g' || isGroupJid(c.jid || c.remoteJid || c.telefone || '');

    if (isGrp) {
      const gid =
        idKey(c.jid) ||
        idKey(c.remoteJid) ||
        (String(c.telefone || '').includes('@') ? idKey(c.telefone) : null) ||
        convKeyOf(c) ||
        `g:${Math.random()}`;

      const key = `${inst}:__group__:${gid}`;
      const cur = legacyMap.get(key);
      if (!cur || scoreRecencia(c) > scoreRecencia(cur)) legacyMap.set(key, mergeConversaCanonica(c, cur));
      else if (cur) cur.pinned = Boolean(cur.pinned || c.pinned);
      continue;
    }

    const telNorm = normalizaTelefoneBR(c.telefone);
    if (telNorm) {
      const key = `${inst}:__fone__:${telNorm}`;
      const cur = legacyMap.get(key);
      if (!cur || scoreRecencia(c) > scoreRecencia(cur)) legacyMap.set(key, mergeConversaCanonica(c, cur));
      else if (cur) cur.pinned = Boolean(cur.pinned || c.pinned);
      continue;
    }

    const nomeNorm = normalizeName(c.nome_whatsapp || c.nome || c.push_name);
    if (nomeNorm) {
      const key = `${inst}:__nome__:${nomeNorm}`;
      const cur = legacyMap.get(key);
      if (!cur || scoreRecencia(c) > scoreRecencia(cur)) legacyMap.set(key, mergeConversaCanonica(c, cur));
      else if (cur) cur.pinned = Boolean(cur.pinned || c.pinned);
      continue;
    }

    const uniq = convKeyOf(c) || `__uniq__:${Math.random()}`;
    legacyMap.set(uniq, c);
  }

  const merged = [...already.values(), ...legacyMap.values()].map(normalizeCliente);
  return ordenarConversasDesc(merged);
}

/* =========================================================
   Normalização
   ========================================================= */
export function normalizeCliente(c) {
  const kind = convKindOf(c, c) || (Boolean(c?.is_group || c?.grupo || c?.isGroup) ? 'g' : 'c');

  const inst =
    instKey(c.instancia_id) ??
    instKey(c.instancia) ??
    instKey(c.instancia_slug) ??
    instKey(c.instance_id) ??
    instKey(c.instance) ??
    instKey(c.session) ??
    instKey(c.sessionName) ??
    instKey(c.sessao) ??
    instKey(c.inst_slug) ??
    parseConversationKey(c?.conversation_key || c?.conversation_id || c?.id || '')?.instId ??
    null;

  const entityId =
    convEntityIdOf(c, c) ??
    idKey(c.entity_id) ??
    idKey(kind === 'g' ? (c.grupo_id ?? c.group_id) : c.cliente_id) ??
    null;

  let conversation_key =
    convKeyOf(c, c) ??
    buildConversationKey(kind, entityId, inst) ??
    null;

  if (conversation_key && !parseConversationKey(conversation_key)) {
    const parsed = parseConversationKey(getConversationKey(conversation_key, c, inst));
    if (parsed?.key) conversation_key = parsed.key;
  }

  const rawHora =
    c.ultima_ts ??
    c.hora ??
    c.last_ts ??
    c.updated_at ??
    c.last_message_at ??
    c.timestamp ??
    null;

  const preview =
    c.ultima_texto ??
    c.ultima_mensagem ??
    c.ultima ??
    c.last_text ??
    c.preview ??
    '';

  const fotoRaw =
    c.avatar_url || c.foto_url || c.foto || c.avatar || c.profile_pic_url || '';
  const fotoStr = String(fotoRaw || '').trim();
  const fotoOk = fotoStr && !/^(null|undefined|about:blank)$/i.test(fotoStr);
  const foto = fotoOk ? fotoStr : '';

  const remote =
    c.remoteJid ?? c.remote_jid ?? c.jid ?? c.chat_jid ?? c.key_remoteJid ??
    c.telefone ?? c.number ?? c.wuid ?? c.numero ?? null;

  const parsed = normalizeJidOrPhone(remote);

  const hintedGroup =
    Boolean(c.is_group) || Boolean(c.grupo) || Boolean(c.isGroup) || kind === 'g';

  let jid = parsed.jid || (isGroupJid(remote) ? String(remote) : '');

  if (!jid && hintedGroup) {
    const d = onlyDigits(remote);
    if (d && looksLikeNumericGroupId(d)) jid = `${d}@g.us`;
  }

  const is_group =
    hintedGroup ||
    Boolean(parsed.is_group) ||
    isGroupJid(remote) ||
    isGroupJid(jid);

  const telRaw = c.telefone ?? c.number ?? c.wuid ?? c.numero ?? null;
  const tel_norm = is_group ? '' : (parsed.tel_norm || normalizaTelefoneBR(telRaw));

  const telForUi = is_group
    ? (jid || String(remote || ''))
    : telRaw;

  return {
    ...c,

    // identidade canônica
    id: conversation_key ?? idKey(c.id) ?? null,
    conversation_key,
    conversation_id: conversation_key,
    kind: is_group ? 'g' : (kind || 'c'),
    entity_id: entityId,
    backend_id: entityId,
    api_id: entityId,

    cliente_id: (is_group ? idKey(c.cliente_id) : (entityId ?? idKey(c.cliente_id))) ?? null,
    grupo_id: (is_group ? (entityId ?? idKey(c.grupo_id) ?? idKey(c.group_id)) : (idKey(c.grupo_id) ?? idKey(c.group_id))) ?? null,

    nome_whatsapp: c.nome_whatsapp ?? null,
    nome: c.nome ?? null,
    push_name: c.push_name ?? null,

    telefone: telForUi,
    telefone_norm: tel_norm,

    jid: jid || null,
    remoteJid: jid || null,
    is_group,

    avatar_url: foto ? foto : null,

    ultima_msg_id: c.ultima_msg_id ?? c.last_msg_id ?? null,
    ultima_mensagem: preview,
    hora: rawHora,
    last_ts: c.last_ts ?? rawHora ?? null,

    novas: Number(c.novas ?? c.nao_lidas ?? c.unread ?? 0),
    last_tipo: c.ultima_tipo ?? c.last_tipo ?? c.tipo ?? null,
    last_ack: c.ultima_ack ?? c.last_ack ?? c.ack ?? null,

    instancia_id: inst,
    instancia: inst,

    pinned: Boolean(c.pinned || c.fixado || c.pin || false),

    instance_name: c.instance_name ?? c.instancia_nome ?? c.inst_name ?? inst ?? null,
    status: c.status ?? c.statusatendimento ?? null,
    statusatendimento: c.statusatendimento ?? c.status ?? null,
  };
}

/* =========================================================
   Merge canônico SOMENTE da mesma conversa
   ========================================================= */
function mergeConversaCanonica(novo, antigo) {
  const n = normalizeCliente(novo || {});
  const a = antigo ? normalizeCliente(antigo) : null;
  if (!a) return n;

  if (!sameConversation(n, a)) return n;

  if (!n.jid && a.jid) n.jid = a.jid;
  if (!n.remoteJid && a.remoteJid) n.remoteJid = a.remoteJid;

  n.is_group = Boolean(
    n.is_group ||
    a.is_group ||
    isGroupJid(n.telefone) ||
    isGroupJid(a.telefone) ||
    isGroupJid(n.jid) ||
    isGroupJid(a.jid)
  );

  if (n.is_group) {
    const keep =
      n.jid ||
      n.remoteJid ||
      a.jid ||
      a.remoteJid ||
      n.telefone ||
      a.telefone ||
      '';
    if (keep) n.telefone = keep;
    n.telefone_norm = '';
  } else {
    if (!n.telefone_norm && a.telefone_norm) n.telefone_norm = a.telefone_norm;
    if (!n.telefone && a.telefone) n.telefone = a.telefone;
  }

  if (!n.avatar_url && a.avatar_url) n.avatar_url = a.avatar_url;
  if (!n.nome && a.nome) n.nome = a.nome;
  if (!n.nome_whatsapp && a.nome_whatsapp) n.nome_whatsapp = a.nome_whatsapp;
  if (!n.push_name && a.push_name) n.push_name = a.push_name;

  const oldTs = tsToMillis(a?.hora || a?.last_ts);
  const newTs = tsToMillis(n.hora || n.last_ts);

  if (a && oldTs && newTs && oldTs > newTs) {
    if (a.ultima_mensagem && String(a.ultima_mensagem).trim()) n.ultima_mensagem = a.ultima_mensagem;
    if (a.last_tipo) n.last_tipo = a.last_tipo;
    if (a.last_tipo === 'saida' && temValor(a.last_ack)) {
      n.last_ack = Math.max(Number(n.last_ack || 0), Number(a.last_ack || 0));
    }
    if (temValor(a.novas) && (Number(n.novas) || 0) === 0) n.novas = Number(a.novas) || 0;
    if (temValor(a.hora)) n.hora = a.hora;
    if (temValor(a.last_ts) && !temValor(n.last_ts)) n.last_ts = a.last_ts;
  } else {
    if ((!n.ultima_mensagem || !String(n.ultima_mensagem).trim()) && a?.ultima_mensagem) {
      n.ultima_mensagem = a.ultima_mensagem;
    }
    if (temValor(a?.novas) && (Number(n.novas) || 0) === 0) n.novas = Number(a.novas) || 0;
  }

  if (temValor(a?.last_ack)) {
    if (!temValor(n.last_ack)) n.last_ack = a.last_ack;
    else n.last_ack = Math.max(Number(n.last_ack || 0), Number(a.last_ack || 0));
  }

  n.pinned = Boolean(n.pinned || a?.pinned);
  if (!n.instance_name && a?.instance_name) n.instance_name = a.instance_name;
  if (!n.instancia_id && a?.instancia_id) n.instancia_id = a.instancia_id;
  if (!n.instancia && a?.instancia) n.instancia = a.instancia;
  if (!n.status && a?.status) n.status = a.status;
  if (!n.statusatendimento && a?.statusatendimento) n.statusatendimento = a.statusatendimento;
  if (!n.entity_id && a?.entity_id) n.entity_id = a.entity_id;
  if (!n.conversation_key && a?.conversation_key) n.conversation_key = a.conversation_key;
  if (!n.conversation_id && a?.conversation_id) n.conversation_id = a.conversation_id;

  return n;
}

/* =========================================================
   PRIME: baixar últimas 30 msgs por conversa (prefetch leve)
   ========================================================= */
function buildMsgsUrl(convKeyOrItem, instanciaId, extra = {}) {
  const entityId = typeof convKeyOrItem === 'object'
    ? convEntityIdOf(convKeyOrItem)
    : convEntityIdOf(convKeyOrItem);

  if (!entityId) return null;

  const qs = new URLSearchParams({
    empresa_id: String(EMPRESA_ID),
    limit: String(extra.limit || 30),
  });

  const parsed = parseConversationKey(typeof convKeyOrItem === 'object' ? convKeyOf(convKeyOrItem) : convKeyOrItem);
  const instFinal = instanciaId ?? parsed?.instId ?? null;

  if (instFinal != null && instFinal !== '' && instFinal !== 'all') {
    qs.set('instancia_id', String(instFinal));
  }
  if (extra.since_ts) qs.set('since_ts', String(extra.since_ts));
  if (extra.since_id) qs.set('since_id', String(extra.since_id));

  return `/api/atendimento/conversas/${encodeURIComponent(String(entityId))}/mensagens?` + qs.toString();
}

async function fetchConv30(convOrItem, instanciaId) {
  const url = buildMsgsUrl(convOrItem, instanciaId);
  if (!url) throw new Error('Conversa inválida para prefetch');

  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('Falha ao carregar mensagens da conversa');
  const data = await r.json();
  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
  const cursors = {
    oldest: data?.prev_cursor ?? null,
    newest: data?.next_cursor ?? null,
  };
  return { items, cursors };
}

const PREFETCH_LIMIT = 10;

async function primeHistories(convs, { concurrency = 2 } = {}) {
  if (!window.PREFETCH_HISTORIES) return;

  const lista = Array.isArray(convs) ? convs.slice() : [];
  const unread = lista.filter((c) => Number(c.novas || 0) > 0).slice(0, PREFETCH_LIMIT);
  if (!unread.length) return;

  const queue = unread.slice();

  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, queue.length)) },
    async () => {
      while (queue.length) {
        const c = queue.shift();
        const convKey = convKeyOf(c);
        if (!convKey) continue;

        const inst = c.instancia_id ?? c.instancia ?? parseConversationKey(convKey)?.instId ?? null;

        try {
          const { items, cursors } = await fetchConv30(c, inst);
          primeWith(inst, convKey, items, cursors);
          syncPreviewIfCached(c);
        } catch (e) {
          try { console.debug('[primeHistories] erro conv', convKey, e); } catch {}
        }
      }
    }
  );

  await Promise.all(runners);
}

/* =========================================================
   Carregar primeira página (20 conversas)
   ========================================================= */
let _isWired = false;
let __loadingConversas = false;

export async function carregarClientes({ force = false } = {}) {
  if (__loadingConversas) return state.clientesCache || [];
  __loadingConversas = true;

  try {
    const instQuery = (_instQuery() || '').replace(/^[?&]+/, '') || 'all';
    const key = `conversas:v1:${EMPRESA_ID}:${instQuery}`;
    const url = `/api/atendimento/conversas?empresa_id=${EMPRESA_ID}&limit=20${_instQuery()}`;

    const forceFlag = force || (sessionStorage.getItem('convForceReload') === '1');
    if (forceFlag) { try { sessionStorage.removeItem('convForceReload'); } catch {} }

    const raw = await fetchWithCache(
      url,
      { ttlMs: forceFlag ? 0 : 30_000, key, bust: forceFlag }
    );

    const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : []);
    const next = raw?.next_cursor ?? null;

    let cs = items.map(normalizeCliente).filter(_matchInstancia);

    const antigo = Array.isArray(state.clientesCache) ? state.clientesCache.map(normalizeCliente) : [];
    const antigoMap = new Map();

    for (const a of antigo) {
      const k = convKeyOf(a);
      if (k) antigoMap.set(k, a);
    }

    cs = cs.map((n) => {
      const k = convKeyOf(n);
      return mergeConversaCanonica(n, k ? antigoMap.get(k) : null);
    });

    let all = dedupeConversas(cs);

    const selKey = convKeyOf(state?.clienteSel);
    if (selKey && !all.some((x) => convKeyOf(x) === selKey)) {
      const sel = antigoMap.get(selKey) || state?.clienteSel || null;
      if (sel) {
        const normSel = normalizeCliente(sel);
        all = dedupeConversas([...all, normSel]);
      }
    }

    syncActiveConvs(all, next);

    renderListaClientes(all);
    try { window.Lista?.render(all); } catch {}

    try {
      (state.clientesCache || []).forEach((c) => {
        syncPreviewIfCached(c);
      });
    } catch {}

    if (window.PREFETCH_HISTORIES) {
      try { await primeHistories(state.clientesCache, { concurrency: 2 }); } catch {}
    }

    kickDailyAvatarRefreshSoon();
    return all;
  } finally {
    __loadingConversas = false;
  }
}

/* =========================================================
   Carregar mais conversas (botão)
   ========================================================= */
export function wireListaInfiniteScroll() {
  if (_isWired) return;
  _isWired = true;
}

export async function loadMoreConversas() {
  const cursor = state.nextCursor;
  if (!cursor) return;

  const url = `/api/atendimento/conversas?empresa_id=${EMPRESA_ID}&limit=20&cursor_last_msg_id=${encodeURIComponent(cursor)}${_instQuery()}`;
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) return;
  const data = await r.json();

  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
  const next = data?.next_cursor ?? null;

  const mais = items.map(normalizeCliente).filter(_matchInstancia);

  const map = new Map(
    (state.clientesCache || []).map((c) => [String(convKeyOf(c) || ''), normalizeCliente(c)])
  );

  for (const it of mais) {
    const key = String(convKeyOf(it) || '');
    if (!key) continue;

    const prev = map.get(key) || {};
    const merged = mergeConversaCanonica({ ...prev, ...it }, prev);
    merged.pinned = Boolean((prev && prev.pinned) || it.pinned);

    merged.is_group = Boolean(
      merged.is_group ||
      prev?.is_group ||
      it?.is_group ||
      convKindOf(merged) === 'g' ||
      isGroupJid(merged.telefone) ||
      isGroupJid(merged.jid) ||
      isGroupJid(merged.remoteJid)
    );

    if (merged.is_group) {
      const keep =
        merged.jid ||
        merged.remoteJid ||
        prev?.jid ||
        prev?.remoteJid ||
        it?.jid ||
        it?.remoteJid ||
        merged.telefone ||
        prev?.telefone ||
        it?.telefone ||
        '';
      if (keep) merged.telefone = keep;
      merged.telefone_norm = '';
    } else {
      if (!merged.telefone_norm) {
        merged.telefone_norm =
          prev?.telefone_norm ||
          it?.telefone_norm ||
          normalizaTelefoneBR(merged.telefone);
      }
    }

    map.set(key, normalizeCliente(merged));
  }

  const arr = dedupeConversas([...map.values()]);
  syncActiveConvs(arr, next);

  renderListaClientes(arr);
  try { window.Lista?.render(arr); } catch {}
  try {
    (state.clientesCache || []).forEach((c) => {
      syncPreviewIfCached(c);
    });
  } catch {}
}

/* =========================================================
   Render da lista
   ========================================================= */
export function renderListaClientes(data) {
  const arr = dedupeConversas(
    (Array.isArray(data) ? data : []).map(normalizeCliente).filter(_matchInstancia)
  );
  const ul = document.getElementById('lista-clientes');
  if (!ul) return;

  const ordenado = ordenarConversasDesc(arr);

  let html = ordenado.map((c) => {
    const convKey = convKeyOf(c) ?? '';
    const entityId = convEntityIdOf(c) ?? '';
    const kind = convKindOf(c) || 'c';

    const nome = (c.nome_whatsapp && c.nome_whatsapp.trim())
      ? c.nome_whatsapp.trim()
      : (c.nome && c.nome.trim() && c.nome !== 'Cliente')
        ? c.nome.trim()
        : (c.push_name?.trim() || formatarNumeroBR(c.telefone));

    const serverMs = tsToMillis(c.hora || c.last_ts) || 0;
    let when = serverMs ? formatChatTime(serverMs) : '';
    let preview = (c.ultima_mensagem || '').trim();
    let outboundFlag = (c.last_tipo === 'saida');
    let ackValForIcon = Number(c.last_ack ?? 0) || 0;

    try {
      const instCanon = (c.instancia_id ?? c.instancia ?? parseConversationKey(convKey)?.instId ?? null) || null;
      const arrHistKeyed = getHist(instCanon, convKey);
      const arrHistLegacy = window.cacheHistoricos?.[convKey];
      const arrHist = Array.isArray(arrHistKeyed) && arrHistKeyed.length
        ? arrHistKeyed
        : (Array.isArray(arrHistLegacy) ? arrHistLegacy : []);

      if (Array.isArray(arrHist) && arrHist.length) {
        const last = arrHist[arrHist.length - 1];
        const histMs = Number(last?.ts || 0) || Date.parse(last?.timestamp || '') || 0;
        const rawHistText = (last?.texto || last?.text || last?.conteudo || last?.mensagem || '').trim();

        const useHist =
          (!serverMs && histMs) ||
          (histMs && serverMs && histMs > serverMs + 999) ||
          (!preview && rawHistText);

        if (useHist) {
          outboundFlag = (last?.tipo === 'saida') || !!last?.from_me || (last?.origem === 'atendente');
          ackValForIcon = outboundFlag ? (Number(last?.ack || 0) || 0) : 0;

          if (histMs) when = formatChatTime(histMs);

          if (rawHistText) {
            preview = rawHistText;
          } else {
            const a = Array.isArray(last?.midias) ? last.midias : [];
            const mime = String(a[0]?.mimetype || a[0]?.mime || '').toLowerCase();
            const hasAny = a.length > 0;
            preview = hasAny
              ? (mime.includes('image') ? '[Foto]'
                : mime.includes('video') ? '[Vídeo]'
                : mime.includes('audio') ? '[Áudio]'
                : mime.includes('pdf') ? '[PDF]'
                : '[Arquivo]')
              : '';
          }
        } else {
          const histAck = Number(last?.ack || 0) || 0;
          if (histAck > ackValForIcon) ackValForIcon = histAck;
        }

        if (!when && serverMs) when = formatChatTime(serverMs);
      }
    } catch {}

    const outbound = outboundFlag;
    const dirStr = outbound ? 'out' : 'in';
    const ackVal = ackValForIcon;

    const ackHtml = outbound && typeof window.getAckIcon === 'function'
      ? `<span class="preview-ack" data-ack="${ackVal}">${window.getAckIcon(ackVal)}</span>`
      : '';

    const avatarUrl = c.avatar_url ? String(c.avatar_url).replace(/"/g, '&quot;') : '';
    const av = avatarUrl
      ? `<span class="avatar"><img src="${avatarUrl}" alt="" data-entity-id="${escapeHtml(String(entityId))}" referrerpolicy="no-referrer"
                onerror="window.handleListAvatarError && window.handleListAvatarError(this)" /></span>`
      : `<span class="avatar placeholder"><i class="fa fa-user-circle"></i></span>`;

    const pinClass = c.pinned ? ' is-pinned' : '';
    const isGrp = Boolean(c.is_group) || kind === 'g' || isGroupJid(c.telefone || '') || isGroupJid(c.jid || '') || isGroupJid(c.remoteJid || '');
    const grpAttr = isGrp ? '1' : '0';
    const jidAttr = escapeHtml(String(c.jid || c.remoteJid || (isGrp ? c.telefone : '') || ''));
    const instAttr = escapeHtml(String(c.instancia_id ?? c.instancia ?? ''));

    return `
      <li class="chat-item cliente-item${pinClass}${isGrp ? ' is-group' : ''}"
          id="chat-${escapeHtml(convKey)}"
          data-id="${escapeHtml(convKey)}"
          data-conversation-key="${escapeHtml(convKey)}"
          data-kind="${escapeHtml(kind)}"
          data-entity-id="${escapeHtml(String(entityId))}"
          data-instancia-id="${instAttr}"
          data-is-group="${grpAttr}"
          data-jid="${jidAttr}"
          data-telefone="${escapeHtml(String(c.telefone || ''))}"
          data-last-outbound="${outbound ? '1' : '0'}"
          data-last-dir="${dirStr}">
        ${av}
        <div class="chat-text">
          <div class="chat-name">${escapeHtml(nome || '')}</div>
          <div class="chat-last">
            ${ackHtml}
            <span class="preview-text">${escapeHtml(preview)}</span>
          </div>
        </div>
        <div class="chat-meta">
          <div class="chat-time">${when}</div>
          ${badge(c.novas)}
        </div>
      </li>`;
  }).join('');

  const hasMore = Boolean(state.nextCursor);
  if (hasMore) {
    html += `
      <li class="chat-item load-more-item" id="lista-load-more">
        <button type="button" class="load-more-btn">Carregar mais conversas</button>
      </li>`;
  }

  ul.innerHTML = html;
  document.dispatchEvent(new CustomEvent('lista:rendered'));

  (function fixBrokenAvatars() {
    ul.querySelectorAll('.avatar img').forEach((img) => {
      const src = String(img.getAttribute('src') || '').trim();
      const isBadSrc = !src || /^(null|undefined|about:blank)$/i.test(src);

      const fix = () => {
        try {
          window.handleListAvatarError?.(img);
        } catch {}
      };

      try { img.addEventListener('error', fix, { once: true }); } catch {}
      if (isBadSrc) return fix();
      if (img.complete && img.naturalWidth === 0) return fix();
    });

    ul.querySelectorAll('.avatar').forEach((span) => {
      if (!span.querySelector('img, i')) {
        span.classList.add('placeholder');
        span.innerHTML = '<i class="fa fa-user-circle"></i>';
      }
    });
  })();

  ul.querySelectorAll('.chat-item.cliente-item').forEach((el) => {
    el.addEventListener('click', () => window.selecionarClienteObj?.(String(el.dataset.id || '')));
  });

  if (hasMore) {
    const btn = ul.querySelector('#lista-load-more .load-more-btn');
    if (btn) {
      btn.addEventListener('click', async () => {
        if (!state.nextCursor) return;
        btn.disabled = true;
        btn.textContent = 'Carregando...';
        try { await loadMoreConversas(); } catch {}
      });
    }
  }
}

/* =========================================================
   SHIM opcional de UI
   ========================================================= */
function _findClienteIndex(id) {
  const wanted = convKeyOf(id);
  const arr = Array.isArray(state.clientesCache) ? state.clientesCache : [];
  return arr.findIndex((c) => idEq(convKeyOf(c), wanted));
}

function _reRender() {
  const arr = dedupeConversas(state.clientesCache || []);
  syncActiveConvs(arr, state.nextCursor ?? null);
  renderListaClientes(arr);
}

function _touchHora(c, tsLike) {
  if (!c) return false;

  const ms = tsToMillis(tsLike);
  if (!ms || !Number.isFinite(ms) || ms <= 0) return false;

  c.hora = ms;
  return true;
}

function _touchHoraNow(c) {
  if (!c) return;
  c.hora = Date.now();
}

if (!window.Lista) {
  window.Lista = {
    render(data) {
      renderListaClientes(Array.isArray(data) ? data : (state.clientesCache || []));
    },

    updatePreview(clienteId, { texto, ts, ack, unreadDelta, instancia_id, instance_name, status } = {}) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;

      const c = state.clientesCache[idx];

      if (typeof texto === 'string') c.ultima_mensagem = texto;
      if (temValor(instancia_id)) c.instancia_id = instancia_id, c.instancia = instancia_id;
      if (instance_name) c.instance_name = instance_name;
      if (status) c.status = status, c.statusatendimento = status;

      if (temValor(ack)) {
        c.last_ack = Number(ack);
        c.last_tipo = 'saida';
      }

      if (unreadDelta) {
        c.novas = Math.max(0, Number(c.novas || 0) + Number(unreadDelta || 0));
      }

      _touchHora(c, ts);
      _reRender();
    },

    setAck(clienteId, ack) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;

      const c = state.clientesCache[idx];
      c.last_tipo = 'saida';

      const novo = Math.max(Number(c.last_ack || 0), Number(ack || 0));
      c.last_ack = novo;

      syncActiveConvs(state.clientesCache, state.nextCursor ?? null);
      _reRender();
    },

    bumpToTop(clienteId) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;

      const c = state.clientesCache[idx];
      _touchHoraNow(c);
      _reRender();
    },

    resetUnread(clienteId) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;

      state.clientesCache[idx].novas = 0;
      _reRender();
    },

    setPinned(clienteId, isPinned) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;

      state.clientesCache[idx].pinned = !!isPinned;
      _reRender();
    }
  };
}

/* =========================================================
   Booster leve de preview + ACK
   ========================================================= */
(function () {
  'use strict';

  function updatePreviewInline(clienteId, { texto, ack, ts, unreadDelta } = {}) {
    const id = String(convKeyOf(clienteId) || '');
    const li = document.querySelector(`li.chat-item[data-id="${CSS.escape(id)}"]`);
    if (!li) return;

    if (typeof texto === 'string') {
      const preview = li.querySelector('.preview-text');
      if (preview) preview.textContent = texto;
    }

    try {
      if (typeof window.getAckIcon === 'function' && (ack ?? null) !== null) {
        let wrap = li.querySelector('.preview-ack');

        if (!wrap) {
          const last = li.querySelector('.chat-last') || li.querySelector('.last-line') || li;
          wrap = document.createElement('span');
          wrap.className = 'preview-ack';
          last.prepend(wrap);
          last.insertBefore(document.createTextNode(' '), wrap.nextSibling);
        }

        wrap.setAttribute('data-ack', String(ack));
        wrap.innerHTML = window.getAckIcon(ack);
      }
    } catch {}

    if (ts !== undefined && ts !== null && ts !== '') {
      const el = li.querySelector('.chat-time, time');
      if (el) {
        const txt = formatChatTime(ts);
        if (txt) el.textContent = txt;
      }
    }

    if (unreadDelta) {
      const badgeEl = li.querySelector('.badge, .unread');
      if (badgeEl) {
        const cur = Number(badgeEl.textContent || '0') || 0;
        const val = Math.max(0, cur + Number(unreadDelta || 0));
        badgeEl.textContent = String(val);
        badgeEl.hidden = val <= 0;
      }
    }
  }

  function setAckInline(clienteId, ack) {
    updatePreviewInline(clienteId, { ack });
  }

  const L = (window.Lista = window.Lista || {});
  const prevUpdate = typeof L.updatePreview === 'function' ? L.updatePreview.bind(L) : null;
  const prevSetAck = typeof L.setAck === 'function' ? L.setAck.bind(L) : null;

  L.updatePreview = function (cid, payload) {
    try { updatePreviewInline(cid, payload || {}); } catch {}
    return prevUpdate ? prevUpdate(cid, payload) : undefined;
  };

  L.setAck = function (cid, ack) {
    try { setAckInline(cid, ack); } catch {}
    return prevSetAck ? prevSetAck(cid, ack) : undefined;
  };
})();

/* =========================================================
   Exports / globals
   ========================================================= */
syncLegacyRefs();

try {
  window.renderListaClientes = renderListaClientes;
  window.carregarClientes = carregarClientes;
  window.loadMoreConversas = loadMoreConversas;
} catch {}