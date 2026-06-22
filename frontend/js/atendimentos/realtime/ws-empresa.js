// /frontend/js/atendimentos/realtime/ws-empresa.js
// ====================================================================
// ZapsChat - WebSocket da empresa/instância
//
// Regra crítica:
// - Conversa é: tipo + entidade + instância
// - Mesmo telefone em outra instância NÃO é a mesma conversa
// - Mesmo cliente_id em outra instância NÃO é a mesma conversa
// - WS NUNCA cria conversa fantasma na lista
// - WS só renderiza bolha se a conversa aberta bater com a instância correta
// - Conversa aberta: sem bolinha de nova mensagem
// - Conversa fechada: soma bolinha de nova mensagem
//
// Correção desta versão:
// - Se a conversa está aberta, mas o item da lista/cache não bateu ainda,
//   o WS usa o contexto aberto e renderiza a bolha mesmo assim.
// - Corrige match aberto quando a instância aparece como ID em um lugar
//   e como instance_name em outro.
// - Prefere a conversation_key canônica recebida pelo WS quando ela pertence
//   à conversa aberta.
// - Mensagem recebida via WS atualiza bolha/cache/lista sem forçar reload
//   pesado do histórico quando a conversa já está aberta.
// ====================================================================

import { tsToMillis } from '../core/time.js';
import { renderHistoricoDoCache } from '../domain/historico.js';
import { pushOneNew, getHist, primeWith } from '../domain/hist-cache.js';

import {
  state,
  mergeIncomingMessage,
  updateAck,
  moveConversaToTopKeyed,
  marcarLidas
} from '../state/store.js';

import { EMPRESA_ID as EMPRESA_ID_ENV } from '../core/env.js';

import {
  ensureEmpresaWS as ensureCoreEmpresaWS,
  onEmpresaMessage as onCoreEmpresaMessage
} from '../../realtime/ws-core.js';

const EMPRESA_ID = Number(
  EMPRESA_ID_ENV ||
  window.EMPRESA_ID ||
  localStorage.getItem('empresa_id') ||
  0
);

const DEBUG_WS = Boolean(window.DEBUG_WS ?? false);

const WS_CID = (() => {
  try {
    if (window.__ZC_WS_CID__) return window.__ZC_WS_CID__;

    const v =
      crypto?.randomUUID?.() ||
      `cid-${Math.random().toString(16).slice(2)}-${Date.now()}`;

    window.__ZC_WS_CID__ = v;
    return v;
  } catch {
    return `cid-${Math.random().toString(16).slice(2)}-${Date.now()}`;
  }
})();

let sockInst = null;
let closedInstByMe = false;
let hbInstTimer = null;
let retryBaseInst = 800;

let unsubEmpresaWS = null;

let lastServerTs = 0;
let lagTimer = null;

let __reloadListTimer = null;
let __lastReloadListAt = 0;

// v12: evita processar a mesma mensagem duas vezes quando existem 2 listeners/abas/loads rápidos.
const LIVE_MSG_DEDUPE_MS = 60_000;
const LIVE_MSG_SEEN = (() => {
  try {
    return window.__ZC_WS_LIVE_MSG_SEEN__ || (window.__ZC_WS_LIVE_MSG_SEEN__ = new Map());
  } catch {
    return new Map();
  }
})();

function isPageActuallyVisible() {
  try {
    if (document.hidden) return false;
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
  } catch {}

  return true;
}

function isOpenChatVisualized(convRef) {
  return Boolean(isOpenChat(convRef) && isPageActuallyVisible());
}

function messageDedupeKey(data = {}) {
  const id = pickMsgId(data);
  const conv =
    data?.conversation_key ??
    data?.conversationKey ??
    data?.conversation_id ??
    data?.conversationId ??
    data?.cliente_id ??
    data?.clienteId ??
    data?.grupo_id ??
    data?.grupoId ??
    '';

  if (id) return `${conv || 'msg'}:${id}`;

  const ts = pickTimestamp(data) || data?.serverTimestamp || '';
  const txt = pickText(data) || '';
  const inst = pickInstanciaFromAny(data) || '';
  return `${conv}:${inst}:${ts}:${txt}`.slice(0, 260);
}

function shouldSkipDuplicateLiveMessage(data = {}) {
  try {
    const k = messageDedupeKey(data);
    if (!k || k === ':::') return false;

    const now = Date.now();

    for (const [key, at] of LIVE_MSG_SEEN.entries()) {
      if (!at || now - Number(at) > LIVE_MSG_DEDUPE_MS) {
        LIVE_MSG_SEEN.delete(key);
      }
    }

    const prev = LIVE_MSG_SEEN.get(k);
    if (prev && now - Number(prev) < LIVE_MSG_DEDUPE_MS) {
      if (DEBUG_WS) console.debug('[WS MSG][duplicada ignorada]', k);
      return true;
    }

    LIVE_MSG_SEEN.set(k, now);
  } catch {}

  return false;
}

/* =========================================================
   BASE HELPERS
========================================================= */

function idKey(v) {
  const s = String(v ?? '').trim();
  if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
  return s;
}

function onlyDigits(v) {
  return String(v || '').replace(/\D+/g, '');
}

function instKey(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;

  const low = s.toLowerCase();
  if (
    low === 'null' ||
    low === 'undefined' ||
    low === 'nan' ||
    low === '0' ||
    low === 'all' ||
    low === 'todos' ||
    low === '*' ||
    low === '-'
  ) {
    return null;
  }

  return s;
}

function samePhone(a, b) {
  const A = onlyDigits(a);
  const B = onlyDigits(b);

  if (!A || !B) return false;

  return A === B || A.endsWith(B) || B.endsWith(A);
}

function phoneFromRow(row) {
  return (
    row?.telefone_norm ??
    row?.telefone ??
    row?.phone ??
    row?.numero ??
    row?.number ??
    row?.remoteJid ??
    row?.remote_jid ??
    row?.jid ??
    ''
  );
}

function unreadFromRow(row) {
  const raw =
    row?.novas ??
    row?.unread_count ??
    row?.unread ??
    row?.nao_lidas ??
    row?.naoLidas ??
    row?.qtd_nao_lidas ??
    row?.qtdNaoLidas ??
    0;

  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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

  if (!eid || !iid) return null;

  return `${k}:${eid}:${iid}`;
}

function getInstanciasList() {
  try {
    const candidates = [
      window.ZC_INSTANCIAS,
      window.INSTANCIAS,
      window.instancias,
      window.state?.instancias,
      state?.instancias,
    ];

    for (const c of candidates) {
      if (Array.isArray(c)) return c;
    }
  } catch {}

  return [];
}

function instanciaValues(row) {
  if (!row || typeof row !== 'object') return [];

  return [
    row.id,
    row.instancia_id,
    row.instanciaId,
    row.instance_id,
    row.instanceId,
    row.instancia,
    row.instance,
    row.instance_name,
    row.instanceName,
    row.nome,
    row.slug,
  ]
    .map(instKey)
    .filter(Boolean);
}

/*
  Aqui é propositalmente rígido:
  - Se ambos são iguais, ok.
  - Se os dois aparecem na mesma linha de instância conhecida, ok.
  - Fora isso, é diferente.
  Nunca retorna true só porque um lado está vazio.
*/
function sameInstStrict(a, b) {
  const A = instKey(a);
  const B = instKey(b);

  if (!A || !B) return false;
  if (A === B) return true;

  const list = getInstanciasList();

  for (const row of list) {
    const vals = instanciaValues(row);
    if (vals.includes(A) && vals.includes(B)) {
      return true;
    }
  }

  return false;
}

function resolveInstanceName(inst) {
  const I = instKey(inst);
  if (!I) return null;

  const list = getInstanciasList();

  for (const row of list) {
    const vals = instanciaValues(row);
    if (!vals.includes(I)) continue;

    return (
      row.instance_name ||
      row.instanceName ||
      row.instancia ||
      row.instance ||
      row.nome ||
      null
    );
  }

  return null;
}

/*
  Match tolerante SOMENTE para a conversa aberta.

  Por que existe:
  - às vezes o DOM aberto fica com instância como instance_name;
  - o payload do WS chega com instancia_id numérico;
  - se usarmos só sameInstStrict(), openNow vira false e a bolha não renderiza
    até clicar/F5.

  Segurança:
  - só é usado depois de confirmar mesmo kind + mesmo cliente/grupo;
  - nunca cria conversa nova na lista.
*/
function sameInstForOpen(a, b) {
  const A = instKey(a);
  const B = instKey(b);

  if (!A || !B) return false;
  if (sameInstStrict(A, B)) return true;

  const active = getActiveInstKey();

  if (active) {
    const aLooksActive = A === active || sameInstStrict(A, active);
    const bLooksActive = B === active || sameInstStrict(B, active);

    if (aLooksActive || bLooksActive) return true;
  }

  const nameA = resolveInstanceName(A);
  const nameB = resolveInstanceName(B);

  if (nameA && (nameA === B || sameInstStrict(nameA, B))) return true;
  if (nameB && (nameB === A || sameInstStrict(nameB, A))) return true;

  return false;
}

function pickCanonicalOpenRef(open, incoming, fallbackKind = 'c') {
  const kind = incoming?.kind || open?.kind || fallbackKind || 'c';
  const entityId = incoming?.entityId || open?.entityId || null;
  const instId = incoming?.instId || open?.instId || getActiveInstKey() || null;

  const key =
    incoming?.key ||
    buildConversationKey(kind, entityId, instId) ||
    open?.key ||
    null;

  if (!key || !entityId || !instId) return null;

  return {
    key,
    kind,
    entityId,
    instId,
  };
}

function conversationKindFromRow(row) {
  if (!row || typeof row !== 'object') return 'c';

  const explicit = String(
    row.kind ??
    row.conversation_kind ??
    row.tipo_conversa ??
    row.tipo_ref ??
    ''
  ).trim().toLowerCase();

  if (explicit === 'g' || explicit === 'grupo' || explicit === 'group') return 'g';
  if (explicit === 'c' || explicit === 'cliente' || explicit === 'contato') return 'c';

  if (
    row.is_group === true ||
    row.isGroup === true ||
    row.grupo === true ||
    row.group === true ||
    row.grupo_id != null ||
    row.grupoId != null ||
    row.group_id != null ||
    row.groupId != null
  ) {
    return 'g';
  }

  return 'c';
}

function conversationEntityId(raw, row = null) {
  const parsed = parseConversationKey(raw);
  if (parsed?.entityId) return parsed.entityId;

  if (row && typeof row === 'object') {
    const kind = conversationKindFromRow(row);

    const rawId =
      row.entity_id ??
      row.entityId ??
      row.backend_id ??
      row.backendClienteId ??
      row.api_id ??
      row.apiClienteId ??
      row.id_backend ??
      row.idBackend ??
      (kind === 'g'
        ? (
            row.grupo_id ??
            row.grupoId ??
            row.group_id ??
            row.groupId ??
            null
          )
        : (
            row.cliente_id ??
            row.clienteId ??
            row.id_cliente ??
            row.idCliente ??
            row.cid ??
            null
          ));

    const s = idKey(rawId);
    if (s && /^\d+$/.test(s)) return s;
  }

  const s = idKey(raw);
  if (s && /^\d+$/.test(s)) return s;

  return null;
}

function conversationInstanciaId(raw, row = null) {
  const parsed = parseConversationKey(raw);
  if (parsed?.instId) return parsed.instId;

  if (row && typeof row === 'object') {
    return (
      instKey(row.instancia_id) ||
      instKey(row.instanciaId) ||
      instKey(row.instancia) ||
      instKey(row.instance_id) ||
      instKey(row.instanceId) ||
      instKey(row.instance_name) ||
      instKey(row.instanceName) ||
      instKey(row.instance) ||
      null
    );
  }

  return null;
}

function rawConversationCandidate(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  return (
    obj.conversation_key ??
    obj.conversationKey ??
    obj.conversation_id ??
    obj.conversationId ??
    obj.conv_key ??
    obj.convKey ??
    obj.id ??
    obj.cliente_id ??
    obj.clienteId ??
    obj.grupo_id ??
    obj.grupoId ??
    null
  );
}

function normalizeConversationRef(raw, row = null) {
  if (raw && typeof raw === 'object') {
    row = raw;
    raw = rawConversationCandidate(raw);
  }

  const parsed = parseConversationKey(raw);
  if (parsed) return parsed;

  const fromRowKey =
    idKey(row?.conversation_key) ||
    idKey(row?.conversationKey) ||
    idKey(row?.conversation_id) ||
    idKey(row?.conversationId) ||
    idKey(row?.conv_key) ||
    idKey(row?.convKey) ||
    null;

  const parsedRowKey = parseConversationKey(fromRowKey);
  if (parsedRowKey) return parsedRowKey;

  const kind = conversationKindFromRow(row);
  const entityId = conversationEntityId(raw, row);
  const instId = conversationInstanciaId(raw, row);

  const built = buildConversationKey(kind, entityId, instId);

  return {
    key: built,
    kind,
    entityId,
    instId,
  };
}

function getConversationIdFromRow(row) {
  return normalizeConversationRef(row, row)?.key || null;
}

/* =========================================================
   CONVERSAS EXISTENTES
========================================================= */

function getAllConversationEntries() {
  const entries = [];

  try {
    if (Array.isArray(state?.clientesCache)) {
      entries.push({
        type: 'clientesCache',
        arr: state.clientesCache,
      });
    }
  } catch {}

  try {
    if (Array.isArray(state?.todosContatosCache)) {
      entries.push({
        type: 'todosContatosCache',
        arr: state.todosContatosCache,
      });
    }
  } catch {}

  try {
    const byInst = state?.convsByInst || {};
    for (const [inst, box] of Object.entries(byInst)) {
      if (Array.isArray(box?.items)) {
        entries.push({
          type: 'convsByInst',
          inst,
          box,
          arr: box.items,
        });
      }
    }
  } catch {}

  try {
    if (Array.isArray(window.__zcListaConversas)) {
      entries.push({
        type: '__zcListaConversas',
        arr: window.__zcListaConversas,
      });
    }
  } catch {}

  return entries;
}

function getAllConversations() {
  const out = [];
  const seen = new Set();

  for (const entry of getAllConversationEntries()) {
    for (const c of entry.arr || []) {
      const k = getConversationIdFromRow(c);
      if (!k || seen.has(k)) continue;

      seen.add(k);
      out.push(c);
    }
  }

  return out;
}

function findKnownConversationByRef(ref, data = null) {
  if (!ref?.kind || !ref?.entityId || !ref?.instId) return null;

  const all = getAllConversations();

  const exact = all.find((c) => {
    const ck = getConversationIdFromRow(c);
    return ck && ref.key && ck === ref.key;
  });

  if (exact) return exact;

  const byEntityInst = all.find((c) => {
    const cr = normalizeConversationRef(c, c);

    if (!cr?.kind || !cr?.entityId || !cr?.instId) return false;
    if (cr.kind !== ref.kind) return false;
    if (String(cr.entityId) !== String(ref.entityId)) return false;

    return sameInstStrict(cr.instId, ref.instId);
  });

  if (byEntityInst) return byEntityInst;

  /*
    Telefone só pode ser usado se:
    - for a mesma instância de verdade
    - for o mesmo tipo de conversa
    Nunca cruza instância.
  */
  const incomingPhone =
    data?.telefone_norm ??
    data?.telefone ??
    data?.phone ??
    data?.numero ??
    data?.number ??
    data?.remoteJid ??
    data?.remote_jid ??
    data?.jid ??
    '';

  if (incomingPhone) {
    const byPhoneSameInst = all.find((c) => {
      const cr = normalizeConversationRef(c, c);

      if (!cr?.kind || !cr?.instId) return false;
      if (cr.kind !== ref.kind) return false;
      if (!sameInstStrict(cr.instId, ref.instId)) return false;

      return samePhone(phoneFromRow(c), incomingPhone);
    });

    if (byPhoneSameInst) return byPhoneSameInst;
  }

  return null;
}

/* =========================================================
   CONTEXTO ABERTO
========================================================= */

function getOpenContext() {
  try {
    const hist = document.getElementById('historico');
    const head = document.getElementById('chat-header');

    const rawDom =
      hist?.dataset?.conversationKey ??
      hist?.dataset?.conversationId ??
      hist?.dataset?.convKey ??
      head?.dataset?.conversationKey ??
      head?.dataset?.conversationId ??
      head?.dataset?.convKey ??
      null;

    const selected =
      state?.clienteSel ||
      window?.clienteSel ||
      null;

    const domRef = normalizeConversationRef(rawDom, {
      instancia_id:
        hist?.dataset?.instanciaId ||
        head?.dataset?.instanciaId ||
        selected?.instancia_id ||
        selected?.instanciaId,
      instancia:
        hist?.dataset?.instancia ||
        head?.dataset?.instancia ||
        selected?.instancia,
      instance_name:
        hist?.dataset?.instanceName ||
        head?.dataset?.instanceName ||
        selected?.instance_name ||
        selected?.instanceName,
      kind:
        hist?.dataset?.kind ||
        head?.dataset?.kind ||
        selected?.kind,
      entity_id:
        hist?.dataset?.entityId ||
        head?.dataset?.entityId ||
        selected?.entity_id ||
        selected?.entityId,
      cliente_id:
        hist?.dataset?.apiClienteId ||
        hist?.dataset?.backendClienteId ||
        hist?.dataset?.clienteId ||
        head?.dataset?.apiClienteId ||
        head?.dataset?.backendClienteId ||
        head?.dataset?.clienteId ||
        selected?.cliente_id ||
        selected?.clienteId ||
        selected?.id,
      grupo_id:
        hist?.dataset?.grupoId ||
        head?.dataset?.grupoId ||
        selected?.grupo_id ||
        selected?.grupoId,
    });

    const selectedRef = normalizeConversationRef(selected, selected);

    const key =
      domRef?.key ||
      selectedRef?.key ||
      null;

    const kind =
      domRef?.kind ||
      selectedRef?.kind ||
      'c';

    const entityId =
      domRef?.entityId ||
      selectedRef?.entityId ||
      idKey(hist?.dataset?.entityId) ||
      idKey(head?.dataset?.entityId) ||
      idKey(hist?.dataset?.apiClienteId) ||
      idKey(hist?.dataset?.backendClienteId) ||
      idKey(hist?.dataset?.clienteId) ||
      idKey(head?.dataset?.apiClienteId) ||
      idKey(head?.dataset?.backendClienteId) ||
      idKey(head?.dataset?.clienteId) ||
      idKey(selected?.cliente_id) ||
      idKey(selected?.clienteId) ||
      idKey(selected?.id) ||
      null;

    const instId =
      domRef?.instId ||
      selectedRef?.instId ||
      instKey(hist?.dataset?.instanciaId) ||
      instKey(head?.dataset?.instanciaId) ||
      instKey(selected?.instancia_id) ||
      instKey(selected?.instanciaId) ||
      instKey(window.INSTANCIA_ATIVA) ||
      null;

    const phone =
      hist?.dataset?.telefone ||
      head?.dataset?.phone ||
      selected?.telefone_norm ||
      selected?.telefone ||
      selected?.phone ||
      selected?.numero ||
      selected?.number ||
      selected?.remoteJid ||
      selected?.remote_jid ||
      '';

    return {
      key,
      kind,
      entityId,
      instId,
      phone,
      hist,
      head,
      selected,
    };
  } catch {
    return {
      key: null,
      kind: 'c',
      entityId: null,
      instId: null,
      phone: '',
      hist: null,
      head: null,
      selected: null,
    };
  }
}

function isOpenChat(refOrKey) {
  try {
    const open = getOpenContext();
    const ref = normalizeConversationRef(refOrKey, typeof refOrKey === 'object' ? refOrKey : null);

    if (!open || !ref) return false;

    /*
      1) Match perfeito por conversation_key.
    */
    if (open.key && ref.key && open.key === ref.key) return true;

    /*
      2) Match por tipo + entidade.
      A instância entra depois com tolerância controlada.
    */
    if (open.kind && ref.kind && open.kind !== ref.kind) return false;

    if (open.entityId && ref.entityId && String(open.entityId) !== String(ref.entityId)) {
      return false;
    }

    if (open.instId && ref.instId) {
      return sameInstForOpen(open.instId, ref.instId);
    }

    /*
      3) Fallback seguro:
      se a entidade bate e a instância existente é a instância ativa,
      considera aberta.
    */
    if (open.entityId && ref.entityId && String(open.entityId) === String(ref.entityId)) {
      const active = getActiveInstKey();
      const onlyInst = open.instId || ref.instId;

      if (active && onlyInst && sameInstForOpen(active, onlyInst)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

function getOpenRefIfMatchesIncoming(incomingRef, data = null) {
  const open = getOpenContext();

  if (!open) return null;

  const incoming = normalizeConversationRef(incomingRef, typeof incomingRef === 'object' ? incomingRef : data);

  if (!incoming?.kind || !incoming?.entityId) return null;

  const openLike = {
    key: open.key || buildConversationKey(open.kind || incoming.kind, open.entityId || incoming.entityId, open.instId || incoming.instId),
    kind: open.kind || incoming.kind || 'c',
    entityId: open.entityId || incoming.entityId || null,
    instId: open.instId || incoming.instId || null,
  };

  if (!openLike.entityId) return null;

  const sameKind = (openLike.kind || 'c') === (incoming.kind || 'c');
  const sameEntity = String(openLike.entityId) === String(incoming.entityId);

  const sameInst =
    openLike.instId && incoming.instId
      ? sameInstForOpen(openLike.instId, incoming.instId)
      : false;

  if (sameKind && sameEntity && sameInst) {
    const canon = pickCanonicalOpenRef(openLike, incoming, openLike.kind);

    if (!canon?.key || !canon?.instId) return null;

    return {
      ...canon,
      from: 'open',
    };
  }

  /*
    Fallback por telefone só para 1:1.
    Ainda exige instância compatível com a conversa aberta/ativa.
  */
  const incomingPhone =
    data?.telefone_norm ??
    data?.telefone ??
    data?.phone ??
    data?.numero ??
    data?.number ??
    data?.remoteJid ??
    data?.remote_jid ??
    data?.jid ??
    '';

  if (
    incoming.kind === 'c' &&
    openLike.kind === 'c' &&
    incomingPhone &&
    open.phone &&
    samePhone(open.phone, incomingPhone)
  ) {
    const instOk =
      openLike.instId && incoming.instId
        ? sameInstForOpen(openLike.instId, incoming.instId)
        : false;

    if (instOk) {
      const canon = pickCanonicalOpenRef(
        { ...openLike, kind: 'c' },
        { ...incoming, kind: 'c', entityId: openLike.entityId || incoming.entityId },
        'c'
      );

      if (!canon?.key || !canon?.instId) return null;

      return {
        ...canon,
        kind: 'c',
        from: 'open-phone',
      };
    }
  }

  return null;
}

/* =========================================================
   INSTÂNCIA / TOPIC
========================================================= */

function pickInstanciaFromAny(data) {
  const direct =
    data?.instancia_id ??
    data?.instanciaId ??
    data?.instancia ??
    data?.instance_id ??
    data?.instanceId ??
    data?.instance_name ??
    data?.instanceName ??
    data?.instance ??
    null;

  const s = instKey(direct);
  if (s) return s;

  const ref = normalizeConversationRef(
    data?.conversation_key ??
    data?.conversationKey ??
    data?.conversation_id ??
    data?.conversationId ??
    null
  );

  return ref?.instId || null;
}

function getActiveInstKey() {
  try {
    const fromWin = instKey(window.INSTANCIA_ATIVA);
    if (fromWin) return fromWin;

    const lsKey = EMPRESA_ID ? `instAtiva:${EMPRESA_ID}` : null;
    const fromLs = lsKey ? instKey(localStorage.getItem(lsKey) || '') : null;
    if (fromLs) return fromLs;
  } catch {}

  return null;
}

function resolveInstTopic() {
  const active = getActiveInstKey();
  if (!active) return null;

  const maybeName = resolveInstanceName(active);
  return maybeName || active;
}

/* =========================================================
   PAYLOAD
========================================================= */

function unwrap(raw) {
  let data = raw;

  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return data;
    }
  }

  if (!data || typeof data !== 'object') return data;

  if (data.data && typeof data.data === 'object') {
    const inner = data.data;

    const outerType = data.type || data.event;
    const innerType = inner.type || inner.event;

    if (!innerType && outerType) {
      inner.type = outerType;
    }

    if (data.serverTimestamp && !inner.serverTimestamp) {
      inner.serverTimestamp = data.serverTimestamp;
    }

    return inner;
  }

  return data;
}

function safeJson(v) {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function pickText(data) {
  return (
    data?.mensagem ??
    data?.texto ??
    data?.conteudo ??
    data?.message ??
    data?.body ??
    data?.content ??
    ''
  );
}

function pickTimestamp(data) {
  return (
    data?.timestamp ??
    data?.ts ??
    data?.data ??
    data?.created_at ??
    data?.createdAt ??
    data?.hora ??
    null
  );
}

function pickAck(data) {
  const raw =
    data?.ack ??
    data?.delivery_ack ??
    data?.status_ack ??
    data?.statusAck ??
    null;

  if (raw == null) return null;

  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function pickMsgId(data) {
  return (
    data?.msg_id ??
    data?.msgId ??
    data?.message_id ??
    data?.messageId ??
    data?.id ??
    null
  );
}

function normalizeIncomingConversationRef(data) {
  const explicitKey =
    data?.conversation_key ??
    data?.conversationKey ??
    data?.conversation_id ??
    data?.conversationId ??
    data?.conv_key ??
    data?.convKey ??
    null;

  const explicitRef = normalizeConversationRef(explicitKey, data);
  if (explicitRef?.key && explicitRef?.entityId && explicitRef?.instId) {
    return explicitRef;
  }

  const inst = pickInstanciaFromAny(data);

  const isGroup =
    data?.is_group === true ||
    data?.isGroup === true ||
    data?.grupo === true ||
    String(data?.kind || '').toLowerCase() === 'g' ||
    String(data?.kind || '').toLowerCase() === 'grupo' ||
    data?.grupo_id != null ||
    data?.grupoId != null ||
    data?.group_id != null ||
    data?.groupId != null;

  const kind = isGroup ? 'g' : 'c';

  const entity =
    idKey(data?.entity_id) ||
    idKey(data?.entityId) ||
    (kind === 'g'
      ? (
          idKey(data?.grupo_id) ||
          idKey(data?.grupoId) ||
          idKey(data?.group_id) ||
          idKey(data?.groupId)
        )
      : (
          idKey(data?.cliente_id) ||
          idKey(data?.clienteId) ||
          idKey(data?.client_id) ||
          idKey(data?.clientId)
        )
    ) ||
    null;

  const key = buildConversationKey(kind, entity, inst);

  return {
    key,
    kind,
    entityId: entity,
    instId: inst,
  };
}

function resolveKnownRefForIncoming(data) {
  const incoming = normalizeIncomingConversationRef(data);

  if (!incoming?.kind || !incoming?.entityId || !incoming?.instId || !incoming?.key) {
    return null;
  }

  /*
    Primeiro tenta a conversa aberta.
    Isso resolve o problema: mensagem chega via WS, está na conversa aberta,
    mas a lista/cache ainda não reconheceu o item.
  */
  const openRef = getOpenRefIfMatchesIncoming(incoming, data);
  if (openRef?.key) return openRef;

  const known = findKnownConversationByRef(incoming, data);
  if (!known) return null;

  const knownRef = normalizeConversationRef(known, known);

  if (!knownRef?.key || !knownRef?.entityId || !knownRef?.instId) return null;

  return {
    ...knownRef,
    from: 'known-list',
  };
}

/* =========================================================
   DOM
========================================================= */

function H() {
  return document.getElementById('historico');
}

function ensureDomContextFor(convRef) {
  const ref = normalizeConversationRef(convRef, typeof convRef === 'object' ? convRef : null);
  if (!ref?.key) return false;

  const hist = H();
  const head = document.getElementById('chat-header');

  if (hist) {
    hist.dataset.conversationKey = ref.key;
    hist.dataset.conversationId = ref.key;
    hist.dataset.convKey = ref.key;
    hist.dataset.entityId = ref.entityId || '';
    hist.dataset.kind = ref.kind || 'c';

    if (ref.instId) {
      hist.dataset.instanciaId = ref.instId;
    }

    if (ref.kind === 'g') {
      hist.dataset.grupoId = ref.entityId || '';
      hist.dataset.isGroup = 'true';
      hist.dataset.clienteId = ref.key;
    } else {
      hist.dataset.apiClienteId = ref.entityId || '';
      hist.dataset.backendClienteId = ref.entityId || '';
      hist.dataset.clienteId = ref.entityId || '';
      hist.dataset.isGroup = 'false';
    }
  }

  if (head) {
    head.dataset.conversationKey = ref.key;
    head.dataset.conversationId = ref.key;
    head.dataset.convKey = ref.key;
    head.dataset.entityId = ref.entityId || '';
    head.dataset.kind = ref.kind || 'c';

    if (ref.instId) {
      head.dataset.instanciaId = ref.instId;
    }

    if (ref.kind === 'g') {
      head.dataset.grupoId = ref.entityId || '';
      head.dataset.isGroup = 'true';
    } else {
      head.dataset.apiClienteId = ref.entityId || '';
      head.dataset.backendClienteId = ref.entityId || '';
      head.dataset.clienteId = ref.entityId || '';
      head.dataset.isGroup = 'false';
    }
  }

  return !!hist;
}

function scrollBottomSoon() {
  try {
    requestAnimationFrame(() => {
      const hist = H();
      if (!hist) return;
      hist.scrollTop = hist.scrollHeight;
    });
  } catch {}
}

function renderOpenConversationFromWs(convRef) {
  const ref = normalizeConversationRef(convRef, typeof convRef === 'object' ? convRef : null);
  if (!ref?.key) return;

  try {
    ensureDomContextFor(ref);
  } catch {}

  const renderOnce = () => {
    try {
      renderHistoricoDoCache(ref.key, true);
      scrollBottomSoon();
    } catch (e) {
      if (DEBUG_WS) console.warn('[WS MSG][renderOpenConversationFromWs] falhou', e);
    }
  };

  renderOnce();

  try {
    requestAnimationFrame(renderOnce);
  } catch {}

  setTimeout(renderOnce, 80);
  setTimeout(renderOnce, 250);
}

/* =========================================================
   LISTA OFICIAL
========================================================= */

function requestOfficialListReload(reason = 'ws-reload') {
  const now = Date.now();

  if (now - __lastReloadListAt < 1200) return;
  __lastReloadListAt = now;

  clearTimeout(__reloadListTimer);

  __reloadListTimer = setTimeout(() => {
    // Correção v10:
    // Nunca força reload pesado da lista a partir de WS.
    // O force:true + convForceReload era o gatilho do carregamento infinito.
    try {
      sessionStorage.removeItem('convForceReload');
    } catch {}

    try {
      window.carregarClientes?.({
        force: false,
        reason: `soft:${reason}`,
        noLoading: true,
      });
    } catch {}

    try {
      document.dispatchEvent(new CustomEvent('ws:reload_clientes_soft', {
        detail: {
          type: 'reload_clientes_soft',
          reason,
          serverTimestamp: Date.now(),
        },
      }));
    } catch {}
  }, 250);
}

/* =========================================================
   UPDATE DE CONVERSA EXISTENTE
========================================================= */

function persistSafe() {
  try {
    state.persist?.();
  } catch {}

  try {
    window.persist?.();
  } catch {}
}

/*
  CRÍTICO:
  Essa função NUNCA cria conversa.
  Ela só atualiza item que já existe.
*/
function storeUpdateKnownConversation(convKey, patch, inst = null) {
  const ref = normalizeConversationRef(convKey, {
    ...patch,
    instancia_id: inst ?? patch?.instancia_id ?? patch?.instanciaId ?? null,
  });

  if (!ref?.kind || !ref?.entityId || !ref?.instId || !ref?.key) {
    return null;
  }

  let updated = null;
  let updatedKey = ref.key;

  for (const entry of getAllConversationEntries()) {
    const arr = entry.arr || [];

    const idx = arr.findIndex((x) => {
      const xr = normalizeConversationRef(x, x);

      if (!xr?.kind || !xr?.entityId || !xr?.instId) return false;

      if (xr.key && xr.key === ref.key) return true;

      if (xr.kind !== ref.kind) return false;
      if (String(xr.entityId) !== String(ref.entityId)) return false;

      return sameInstStrict(xr.instId, ref.instId);
    });

    if (idx < 0) continue;

    const old = arr[idx] || {};
    const oldKey = getConversationIdFromRow(old) || ref.key;

    const finalPatch = {
      ...(patch || {}),
      conversation_key: oldKey,
      conversation_id: oldKey,
      kind: ref.kind,
      entity_id: ref.entityId,
      instancia_id: ref.instId,
    };

    if (ref.kind === 'g') {
      finalPatch.grupo_id = ref.entityId;
      finalPatch.is_group = true;
    } else {
      finalPatch.cliente_id = ref.entityId;
      finalPatch.is_group = false;
    }

    arr[idx] = {
      ...old,
      ...finalPatch,
      id: old.id ?? finalPatch.id,
    };

    updated = arr[idx];
    updatedKey = oldKey;
  }

  if (!updated) return null;

  persistSafe();

  try {
    moveConversaToTopKeyed(updatedKey);
  } catch {}

  return updated;
}

function bumpPreview(convKey, msg, inst = null) {
  const ref = normalizeConversationRef(convKey, {
    ...msg,
    instancia_id: inst ?? msg?.instancia_id ?? null,
  });

  if (!ref?.key) return null;

  const text = pickText(msg);
  const ts = pickTimestamp(msg);
  const tsMs = tsToMillis(ts) || Date.now();

  const isOutgoing =
    msg?.from_me === true ||
    msg?.fromMe === true ||
    msg?.tipo === 'saida' ||
    msg?.origem === 'atendente';

  const openNow = isOpenChatVisualized(ref);

  const existingRow = findKnownConversationByRef(ref, msg);
  const previousUnread = unreadFromRow(existingRow);

  /*
    Regra:
    - conversa aberta: não mostra bolinha
    - conversa fechada: soma +1
  */
  const unread = isOutgoing || openNow ? 0 : previousUnread + 1;

  const patch = {
    ultima_mensagem: text,
    preview: text,
    last_message: text,
    last_msg: text,
    timestamp: ts,
    ultima_mensagem_ts: ts,
    last_ts: tsMs,
    updated_at: ts,

    novas: unread,
    unread: unread,
    unread_count: unread,
    nao_lidas: unread,
    naoLidas: unread,
    qtd_nao_lidas: unread,
    qtdNaoLidas: unread,

    instancia_id: ref.instId,
    instance_name: msg?.instance_name || msg?.instanceName || resolveInstanceName(ref.instId) || null,

    telefone: msg?.telefone || null,
    telefone_norm: msg?.telefone_norm || null,
  };

  const updated = storeUpdateKnownConversation(ref.key, patch, ref.instId);

  if (!updated) {
    requestOfficialListReload('ws-preview-conversation-not-found');
    return null;
  }

  const finalKey = getConversationIdFromRow(updated) || ref.key;

  try {
    window.Lista?.updatePreview?.(finalKey, patch);
  } catch {}

  try {
    window.recomputeUnread?.();
  } catch {}

  try {
    document.dispatchEvent(new CustomEvent('zc:unread-changed', {
      detail: {
        conversation_key: finalKey,
        conversation_id: finalKey,
        unread,
        novas: unread,
        unread_count: unread,
      },
    }));
  } catch {}

  try {
    document.dispatchEvent(new CustomEvent('ws:preview_updated', {
      detail: {
        conversation_key: finalKey,
        conversation_id: finalKey,
        ...patch,
      },
    }));
  } catch {}

  return updated;
}

/* =========================================================
   HISTÓRICO
========================================================= */

function normalizeMsgForHist(data, convRef) {
  const ref = normalizeConversationRef(convRef, typeof convRef === 'object' ? convRef : null);

  const tipo =
    data?.tipo === 'saida' ||
    data?.from_me === true ||
    data?.fromMe === true ||
    data?.origem === 'atendente'
      ? 'saida'
      : 'entrada';

  const text = pickText(data);
  const msgId = pickMsgId(data);
  const ts = pickTimestamp(data);

  const out = {
    msg_id: msgId ? String(msgId) : null,
    conteudo: text || '',
    texto: text || '',
    mensagem: text || '',
    tipo,
    origem: tipo === 'saida' ? 'atendente' : 'cliente',
    from_me: tipo === 'saida',
    timestamp: ts,
    ts: tsToMillis(ts) || Date.now(),
    ack: tipo === 'saida' ? (pickAck(data) ?? 0) : null,
    midias: Array.isArray(data?.midias) ? data.midias : [],
    instancia_id: ref.instId || data?.instancia_id || data?.instanciaId || null,
    instance_name: data?.instance_name || data?.instanceName || null,
    conversation_key: ref.key,
    conversation_id: ref.key,
    kind: ref.kind,
    entity_id: ref.entityId,
  };

  if (ref.kind === 'g') {
    out.grupo_id = ref.entityId;
    out.is_group = true;
    out.author_jid = data?.author_jid || data?.participant || data?.participantJid || null;
    out.autor_nome = data?.autor_nome || data?.senderName || data?.push_name || data?.pushName || null;
    out.autor_cliente_id = data?.autor_cliente_id || null;
  } else {
    out.cliente_id = ref.entityId;
    out.is_group = false;
  }

  const quoted =
    data?.quoted ??
    data?.quote ??
    data?.quotedMessage ??
    data?.quoted_message ??
    null;

  const quotedPreview =
    data?.quoted_preview ??
    data?.quotedPreview ??
    data?.reply_preview ??
    data?.replyPreview ??
    null;

  if (quoted && typeof quoted === 'object') out.quoted = quoted;
  if (quotedPreview && typeof quotedPreview === 'object') out.quoted_preview = quotedPreview;

  if (data?.apagada_cliente != null) out.apagada_cliente = Boolean(data.apagada_cliente);
  if (data?.apagada_usuario != null) out.apagada_usuario = Boolean(data.apagada_usuario);

  return out;
}

function candidateInstKeysForCache(ref, msg = null, explicitInst = null) {
  const out = new Set();

  const add = (v) => {
    const s = instKey(v);
    if (s) out.add(s);
  };

  add(ref?.instId);
  add(explicitInst);
  add(msg?.instancia_id);
  add(msg?.instanciaId);
  add(msg?.instance_id);
  add(msg?.instanceId);
  add(msg?.instance_name);
  add(msg?.instanceName);
  add(msg?.instance);
  add(msg?.instancia);

  const active = getActiveInstKey();
  if (active && ref?.instId && sameInstForOpen(active, ref.instId)) {
    add(active);
  }

  try {
    const open = getOpenContext();
    if (open?.entityId && ref?.entityId && String(open.entityId) === String(ref.entityId)) {
      if (!open.kind || !ref.kind || open.kind === ref.kind) {
        if (!open.instId || !ref.instId || sameInstForOpen(open.instId, ref.instId)) {
          add(open.instId);
        }
      }
    }
  } catch {}

  return [...out];
}

function pushIncomingToHist(convKey, msg, inst = null) {
  const ref = normalizeConversationRef(convKey, {
    ...msg,
    instancia_id: inst ?? msg?.instancia_id ?? null,
  });

  if (!ref?.key || !ref?.instId) return false;

  const normalized = normalizeMsgForHist(msg, ref);
  const instCandidates = candidateInstKeysForCache(ref, msg, inst);

  if (!instCandidates.length) return false;

  let okAny = false;

  for (const instCandidate of instCandidates) {
    try {
      pushOneNew(instCandidate, ref.key, normalized);
      okAny = true;
      continue;
    } catch {}

    try {
      const current = getHist(instCandidate, ref.key) || [];
      primeWith(instCandidate, ref.key, [...current, normalized]);
      okAny = true;
    } catch {}
  }

  return okAny;
}

function dispatchRealtimeMessageEvents(payload) {
  const detail = {
    ...payload,
    conversation_key: payload.conversation_key || payload.conversation_id,
    conversation_id: payload.conversation_id || payload.conversation_key,
  };

  [
    'atendimento:mensagem-recebida',
    'zc:message-upsert',
    'zc:message-created',
    'zc:message-received',
    'zc:new-message',
    'atendimento:message',
    'atendimento:message-received',
  ].forEach((name) => {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {}

    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {}
  });
}

/* =========================================================
   NOTIFICAÇÕES
========================================================= */

function notifyNewMessage(data, convKey) {
  try {
    document.dispatchEvent(new CustomEvent('ws:nova_mensagem', {
      detail: {
        ...data,
        conversation_key: convKey,
        conversation_id: convKey,
      },
    }));
  } catch {}

  try {
    window.recomputeUnread?.();
  } catch {}

  try {
    window.ZCNotif?.onNewMessage?.(data);
  } catch {}
}

/* =========================================================
   ACK
========================================================= */

function handleAckGeneric(data) {
  const msgId = pickMsgId(data);
  const ack = pickAck(data);

  if (!msgId || ack == null) return;

  const ref = resolveKnownRefForIncoming(data);
  const key = ref?.key || null;

  try {
    updateAck(msgId, ack, key || undefined);
  } catch {}

  try {
    document.dispatchEvent(new CustomEvent('ws:ack', {
      detail: {
        ...data,
        msg_id: msgId,
        ack,
        conversation_key: key,
        conversation_id: key,
        instancia_id: ref?.instId || pickInstanciaFromAny(data),
      },
    }));
  } catch {}

  if (key && isOpenChat(ref)) {
    try {
      renderOpenConversationFromWs(ref);
    } catch {}
  }
}

/* =========================================================
   DELETE
========================================================= */

function handleDeleteMensagem(data) {
  const msgId = pickMsgId(data);
  if (!msgId) return;

  const ref = resolveKnownRefForIncoming(data);

  if (!ref?.key || !ref?.instId) {
    requestOfficialListReload('ws-delete-unknown-conversation');
    return;
  }

  try {
    const arr = getHist(ref.instId, ref.key) || [];

    const next = arr.map((m) => {
      const mid =
        m?.msg_id ??
        m?.msgId ??
        m?.message_id ??
        m?.messageId ??
        m?.id ??
        null;

      if (String(mid || '') !== String(msgId)) return m;

      return {
        ...m,
        apagada_cliente: Boolean(data.apagada_cliente ?? data.deleted_by_client ?? m.apagada_cliente),
        apagada_usuario: Boolean(data.apagada_usuario ?? data.deleted_by_user ?? m.apagada_usuario),
      };
    });

    primeWith(ref.instId, ref.key, next);
  } catch {}

  if (isOpenChat(ref)) {
    try {
      renderOpenConversationFromWs(ref);
    } catch {}
  }

  try {
    document.dispatchEvent(new CustomEvent('ws:message_deleted', {
      detail: {
        ...data,
        conversation_key: ref.key,
        conversation_id: ref.key,
        msg_id: msgId,
      },
    }));
  } catch {}
}

/* =========================================================
   NOVA MENSAGEM
========================================================= */

function handleNovaMensagem(data) {
  if (shouldSkipDuplicateLiveMessage(data)) return;

  const incomingRef = normalizeIncomingConversationRef(data);

  if (!incomingRef?.key || !incomingRef?.kind || !incomingRef?.entityId || !incomingRef?.instId) {
    if (DEBUG_WS) {
      console.warn('[WS MSG][sem ref completa - reload oficial]', {
        incomingRef,
        data,
      });
    }

    requestOfficialListReload('ws-message-without-complete-ref');
    return;
  }

  const openRefDirect = getOpenRefIfMatchesIncoming(incomingRef, data);
  const knownRef = openRefDirect || resolveKnownRefForIncoming(data);

  /*
    WS NUNCA cria conversa fantasma na lista.
    Mas se a conversa JÁ ESTÁ ABERTA, pode renderizar usando o contexto aberto.
  */
  if (!knownRef?.key || !knownRef?.instId) {
    const openRef = openRefDirect || getOpenRefIfMatchesIncoming(incomingRef, data);

    if (!openRef?.key || !openRef?.instId) {
      if (DEBUG_WS) {
        console.warn('[WS MSG][conversa desconhecida - sem criar fantasma]', {
          incomingRef,
          data,
        });
      }

      requestOfficialListReload('ws-new-message-unknown-conversation');
      return;
    }

    const textOpen = pickText(data);
    const msgIdOpen = pickMsgId(data);

    const normalizedOpenPayload = {
      ...data,
      type: data.type || 'message',
      event: data.event || 'message',

      conversation_key: openRef.key,
      conversation_id: openRef.key,
      kind: openRef.kind,
      entity_id: openRef.entityId,

      instancia_id: openRef.instId,
      instance_name: data.instance_name || data.instanceName || resolveInstanceName(openRef.instId) || null,

      mensagem: textOpen,
      texto: textOpen,
      conteudo: textOpen,
      msg_id: msgIdOpen,

      from_me: Boolean(data.from_me ?? data.fromMe ?? data.tipo === 'saida'),
      is_group: openRef.kind === 'g',
    };

    if (openRef.kind === 'g') {
      normalizedOpenPayload.grupo_id = openRef.entityId;
      normalizedOpenPayload.cliente_id = data.cliente_id ?? null;
    } else {
      normalizedOpenPayload.cliente_id = openRef.entityId;
    }

    try {
      mergeIncomingMessage(openRef.key, normalizedOpenPayload, openRef.instId);
    } catch {}

    pushIncomingToHist(openRef, normalizedOpenPayload, openRef.instId);
    dispatchRealtimeMessageEvents(normalizedOpenPayload);

    /*
      A conversa já está aberta e recebeu a mensagem pelo WebSocket.
      Não força reload oficial aqui, porque isso reabre /atendimentos,
      mostra spinner e pode parecer que a tela caiu.
    */

    renderOpenConversationFromWs(openRef);
    notifyNewMessage(normalizedOpenPayload, openRef.key);

    return;
  }

  const openNow = (Boolean(openRefDirect) || isOpenChat(knownRef) || knownRef.from === 'open' || knownRef.from === 'open-phone');
  const visualizedNow = openNow && isPageActuallyVisible();

  const text = pickText(data);
  const msgId = pickMsgId(data);

  const normalizedPayload = {
    ...data,
    type: data.type || 'message',
    event: data.event || 'message',

    conversation_key: knownRef.key,
    conversation_id: knownRef.key,
    kind: knownRef.kind,
    entity_id: knownRef.entityId,

    instancia_id: knownRef.instId,
    instance_name: data.instance_name || data.instanceName || resolveInstanceName(knownRef.instId) || null,

    mensagem: text,
    texto: text,
    conteudo: text,
    msg_id: msgId,

    from_me: Boolean(data.from_me ?? data.fromMe ?? data.tipo === 'saida'),
    is_group: knownRef.kind === 'g',
  };

  if (knownRef.kind === 'g') {
    normalizedPayload.grupo_id = knownRef.entityId;
    normalizedPayload.cliente_id = data.cliente_id ?? null;
  } else {
    normalizedPayload.cliente_id = knownRef.entityId;
  }

  try {
    mergeIncomingMessage(knownRef.key, normalizedPayload, knownRef.instId);
  } catch {}

  pushIncomingToHist(knownRef, normalizedPayload, knownRef.instId);

  const updated = bumpPreview(knownRef, normalizedPayload, knownRef.instId);

  dispatchRealtimeMessageEvents(normalizedPayload);

  /*
    A bolha do chat e a lista lateral são fluxos diferentes.

    Se a conversa está aberta, o WS já empurra a bolha e bumpPreview tenta
    atualizar a lista em memória. Não força reload oficial, porque o reload
    chama carregarClientes(), troca o estado da tela e gera o spinner infinito.

    Se a conversa NÃO está aberta e o preview não conseguiu atualizar, aí sim
    recarrega a lista para criar/posicionar a conversa corretamente.
  */
  if (!updated && !openNow) {
    requestOfficialListReload('ws-message-update-miss');
    return;
  }

  if (visualizedNow) {
    try {
      renderOpenConversationFromWs(knownRef);

      try {
        marcarLidas(knownRef.key);
      } catch {}

      try {
        if (knownRef.kind === 'c' && knownRef.entityId) {
          document.dispatchEvent(new CustomEvent('zc:seen-current', {
            detail: {
              cliente_id: knownRef.entityId,
              instancia_id: knownRef.instId,
              conversation_key: knownRef.key,
            },
          }));
        }
      } catch {}
    } catch (e) {
      if (DEBUG_WS) console.warn('[WS MSG][render falhou]', e);
    }
  } else if (DEBUG_WS) {
    console.debug(openNow ? '[WS MSG][aberto mas não visualizado - mantém bolha]' : '[WS MSG][não aberto - só preview/badge]', {
      incoming: knownRef.key,
      open: getOpenContext()?.key,
      data: normalizedPayload,
    });
  }

  notifyNewMessage(normalizedPayload, knownRef.key);

  if (DEBUG_WS) {
    console.debug('[WS MSG]', {
      convKey: knownRef.key,
      inst: knownRef.instId,
      openNow,
      text,
      msgId,
      raw: data,
    });
  }
}

/* =========================================================
   STATUS / PIN
========================================================= */

function handleConvStatus(payload) {
  const ref = resolveKnownRefForIncoming(payload);

  if (!ref?.key) {
    requestOfficialListReload('ws-status-unknown-conversation');
    return;
  }

  const rawStatus =
    payload?.status ??
    payload?.statusatendimento ??
    payload?.status_atendimento ??
    null;

  const status = String(rawStatus || '').trim().toLowerCase();
  if (!status) return;

  const updated = storeUpdateKnownConversation(ref, {
    status,
    statusatendimento: status,
    instancia_id: ref.instId,
    instance_name:
      payload?.instance_name ||
      payload?.instanceName ||
      payload?.instance ||
      resolveInstanceName(ref.instId) ||
      null,
  }, ref.instId);

  if (!updated) {
    requestOfficialListReload('ws-status-update-miss');
    return;
  }

  try {
    const li = document.querySelector(`li.chat-item[data-id="${CSS.escape(String(ref.key))}"]`);
    if (li) li.dataset.status = status;
  } catch {}

  try {
    window.Lista?.updatePreview?.(ref.key, { status, statusatendimento: status });
  } catch {}

  try {
    document.dispatchEvent(new CustomEvent('ws:conv_status', {
      detail: {
        conversation_key: ref.key,
        conversation_id: ref.key,
        cliente_id: ref.kind === 'c' ? ref.entityId : null,
        grupo_id: ref.kind === 'g' ? ref.entityId : null,
        instancia_id: ref.instId,
        status,
      },
    }));
  } catch {}
}

function inferPinFlag(p) {
  if (typeof p.pin === 'boolean') return p.pin;
  if (typeof p.pinned === 'boolean') return p.pinned;
  if (p.fixado != null) return !!p.fixado;

  const a = String(p.action || p.act || p.event || p.type || '').toLowerCase();

  if (a.includes('unpin') || a.includes('desfix') || a.includes('desafix')) return false;
  if (a.includes('pin') || a.includes('fix')) return true;

  return null;
}

function handleConvPin(payload) {
  const ref = resolveKnownRefForIncoming(payload);

  if (!ref?.key) {
    requestOfficialListReload('ws-pin-unknown-conversation');
    return;
  }

  const flag = inferPinFlag(payload);
  if (flag == null) return;

  const updated = storeUpdateKnownConversation(ref, { pinned: !!flag }, ref.instId);

  if (!updated) {
    requestOfficialListReload('ws-pin-update-miss');
    return;
  }

  try {
    window.Lista?.setPinned?.(ref.key, !!flag);
  } catch {}

  try {
    const li = document.querySelector(`li.chat-item[data-id="${CSS.escape(String(ref.key))}"]`);
    if (li) li.classList.toggle('is-pinned', !!flag);
  } catch {}

  try {
    sessionStorage.setItem('convForceReload', '1');
  } catch {}
}

/* =========================================================
   WS URL / STATUS
========================================================= */

function protocolWs() {
  return location.protocol === 'https:' ? 'wss:' : 'ws:';
}

function wsUrlInst(topic, { wantQR = false } = {}) {
  const qs = new URLSearchParams();

  qs.set('cid', WS_CID);

  if (EMPRESA_ID) qs.set('empresa_id', String(EMPRESA_ID));
  if (wantQR) qs.set('qr', '1');

  try {
    const token =
      localStorage.getItem('access_token') ||
      localStorage.getItem('token') ||
      '';

    if (token) qs.set('token', token);
  } catch {}

  return `${protocolWs()}//${location.host}/ws/instancia/${encodeURIComponent(topic)}?${qs.toString()}`;
}

function badge(text, mode = 'ok') {
  try {
    const el =
      document.getElementById('status-bateria') ||
      document.getElementById('zc-ws-status') ||
      null;

    if (!el) return;

    el.dataset.ws = mode;
    el.setAttribute('data-ws', mode);

    if (text) {
      el.title = text;
    }
  } catch {}
}

function startLagTimer() {
  if (lagTimer) return;

  lagTimer = setInterval(() => {
    try {
      if (!lastServerTs) return;

      const lag = Date.now() - Number(lastServerTs || 0);

      if (lag > 120000) badge('Tempo real atrasado', 'crit');
      else if (lag > 45000) badge('Tempo real instável', 'warn');
      else badge('Tempo real', 'ok');
    } catch {}
  }, 15000);
}

function scheduleHeartbeat(sock) {
  clearInterval(hbInstTimer);

  hbInstTimer = setInterval(() => {
    try {
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      sock.send(JSON.stringify({ type: 'ping', cid: WS_CID, t: Date.now() }));
    } catch {}
  }, 25000);
}

function backoff(fn, ref) {
  const wait = Math.min(ref.val || 800, 20000);

  setTimeout(() => {
    try {
      fn();
    } catch {}
  }, wait);

  ref.val = Math.min(wait * 1.7, 20000);
}

/* =========================================================
   DISPATCHER
========================================================= */

function handleMessage(ev) {
  if (typeof ev?.data === 'string' && (ev.data === 'pong' || ev.data === 'ping')) return;

  const raw = typeof ev?.data === 'string' ? safeJson(ev.data) : ev?.data;
  const data = unwrap(raw);

  if (!data || typeof data !== 'object') return;

  const sTs = Number(data.serverTimestamp ?? 0);
  if (Number.isFinite(sTs) && sTs > 0) lastServerTs = sTs;

  if (data.type === 'history_sync_start') {
    document.dispatchEvent(new CustomEvent('ws:history_sync_start'));
    return;
  }

  if (data.type === 'history_sync_done') {
    document.dispatchEvent(new CustomEvent('ws:history_sync_done'));
    return;
  }

  if (data.type === 'reload_clientes' || data.type === 'reload_grupos') {
    // Correção v10:
    // reload_clientes vindo por WS não pode forçar carregarClientes(force:true),
    // nem setar convForceReload, porque isso recarrega /atendimentos e fecha o WS com 1001.
    // Mantemos apenas o evento leve para quem quiser atualizar badge/localmente.
    try {
      document.dispatchEvent(new CustomEvent('ws:reload_clientes', { detail: data }));
    } catch {}

    if (window.ZC_ALLOW_WS_RELOAD_CLIENTES === true) {
      requestOfficialListReload(data.type);
    } else if (DEBUG_WS) {
      console.debug('[WS] reload_clientes ignorado para não travar a tela', data);
    }

    return;
  }

  if (data.reload || data.action === 'reload') {
    if (DEBUG_WS) console.warn('[WS] reload genérico ignorado');
    document.dispatchEvent(new CustomEvent('ws:generic_reload', { detail: data }));
    return;
  }

  if (data.reload_whatsapp || data.type === 'reload_whatsapp') {
    document.dispatchEvent(new CustomEvent('ws:reload_whatsapp', { detail: data }));

    try {
      window.loadInstances?.(EMPRESA_ID);
    } catch {}

    return;
  }

  if (data.type === 'conv_status') {
    handleConvStatus(data);
    return;
  }

  const t = String(data.type || data.event || '').toLowerCase();

  if (
    t === 'conv.pin' ||
    t === 'conv_unpin' ||
    t === 'conv.unpin' ||
    t === 'convfix' ||
    t === 'conv_unfix' ||
    t === 'conv.unfix' ||
    t === 'pin' ||
    t === 'unpin' ||
    (t === 'conv' && String(data.action || '').toLowerCase().includes('pin'))
  ) {
    handleConvPin(data);
    return;
  }

  if (
    t === 'msg_deleted' ||
    t === 'messages_delete' ||
    t === 'message_delete' ||
    t === 'messages.delete' ||
    t === 'messagedelete'
  ) {
    handleDeleteMensagem(data);
    return;
  }

  const maybeAck = pickAck(data);

  if (data.type === 'ack' || maybeAck != null) {
    handleAckGeneric(data);
  }

  const hasText =
    data.mensagem != null ||
    data.texto != null ||
    data.conteudo != null ||
    data.message != null ||
    data.body != null ||
    data.content != null;

  const hasMidias = Array.isArray(data.midias) && data.midias.length > 0;

  const hasConversation =
    data.cliente_id != null ||
    data.clienteId != null ||
    data.client_id != null ||
    data.clientId != null ||
    data.grupo_id != null ||
    data.grupoId != null ||
    data.group_id != null ||
    data.groupId != null ||
    data.entity_id != null ||
    data.entityId != null ||
    data.conversation_id != null ||
    data.conversationId != null ||
    data.conversation_key != null ||
    data.conversationKey != null;

  if (hasConversation && (hasText || hasMidias)) {
    handleNovaMensagem(data);
    return;
  }

  if (DEBUG_WS) console.debug('[WS IGNORADO]', data);
}

/* =========================================================
   LIFECYCLE
========================================================= */

function isAtendimentosPage() {
  try {
    if (location.pathname.includes('/atendimentos')) return true;
    return !!document.getElementById('historico');
  } catch {
    return false;
  }
}

function connectEmpresaWS() {
  if (!EMPRESA_ID) return;

  ensureCoreEmpresaWS(EMPRESA_ID);

  if (unsubEmpresaWS) return;

  unsubEmpresaWS = onCoreEmpresaMessage(EMPRESA_ID, (evt) => {
    if (!evt || typeof evt !== 'object') return;

    if (evt.type === 'open') {
      startLagTimer();
      lastServerTs = Date.now();
      badge('Tempo real', 'ok');

      if (DEBUG_WS) {
        console.debug('[WS OPEN EMP][shared ws-core]', EMPRESA_ID);
      }

      return;
    }

    if (evt.type === 'close') {
      badge('Reconectando…', 'loading');

      if (DEBUG_WS) {
        console.debug('[WS CLOSE EMP][shared ws-core]', EMPRESA_ID);
      }

      return;
    }

    if (evt.type === 'error') {
      badge('Reconectando…', 'loading');

      if (DEBUG_WS) {
        console.debug('[WS ERROR EMP][shared ws-core]', EMPRESA_ID);
      }

      return;
    }

    if (evt.type === 'heartbeat') return;

    if (evt.type === 'message') {
      handleMessage({ data: evt.data });
    }
  });
}

function disconnectEmpresaWS() {
  try {
    if (typeof unsubEmpresaWS === 'function') {
      unsubEmpresaWS();
    }
  } catch {}

  unsubEmpresaWS = null;
  badge('Desconectado', 'crit');
}

function connectInstWS({ wantQR = false } = {}) {
  const topic = resolveInstTopic();
  if (!topic) return;

  if (
    sockInst &&
    (
      sockInst.readyState === WebSocket.OPEN ||
      sockInst.readyState === WebSocket.CONNECTING
    )
  ) {
    return;
  }

  try {
    sockInst?.close();
  } catch {}

  closedInstByMe = false;

  const url = wsUrlInst(topic, { wantQR });
  sockInst = new WebSocket(url);

  sockInst.addEventListener('open', () => {
    retryBaseInst = 800;
    scheduleHeartbeat(sockInst);
    startLagTimer();
    lastServerTs = Date.now();

    if (DEBUG_WS) console.debug('[WS OPEN INST]', url);
  });

  sockInst.addEventListener('message', (ev) => {
    if (typeof ev?.data === 'string') {
      try {
        const parsed = JSON.parse(ev.data);

        const ts = Number(
          parsed?.serverTimestamp ??
          parsed?.ts ??
          (parsed?.timestamp ? tsToMillis(parsed.timestamp) : 0)
        );

        if (Number.isFinite(ts) && ts > 0) {
          lastServerTs = Math.max(lastServerTs || 0, ts);
        }
      } catch {}
    }

    handleMessage(ev);
  });

  sockInst.addEventListener('close', () => {
    clearInterval(hbInstTimer);

    if (!closedInstByMe) {
      if (DEBUG_WS) console.debug('[WS CLOSE INST] retry');

      backoff(() => connectInstWS({ wantQR: false }), {
        get val() {
          return retryBaseInst;
        },
        set val(v) {
          retryBaseInst = v;
        },
      });
    }
  });

  sockInst.addEventListener('error', () => {
    try {
      sockInst.close();
    } catch {}
  });
}

function disconnectInstWS() {
  closedInstByMe = true;
  clearInterval(hbInstTimer);

  try {
    sockInst?.close();
  } catch {}

  sockInst = null;
}

/* =========================================================
   BOOT
========================================================= */

try {
  const boot = () => {
    if (window.__ZC_WS_EMPRESA_BOOTED__) {
      if (DEBUG_WS) console.debug('[WS] boot ignorado: websocket já inicializado nesta página');
      return;
    }

    window.__ZC_WS_EMPRESA_BOOTED__ = true;

    connectEmpresaWS();

    /*
      Na tela de atendimentos não abrimos /ws/instancia.
      O tempo real das mensagens vem pelo WS da empresa.
      Isso evita loop quando o Engine.IO/Socket.IO da Evolution fecha.
    */
    if (isAtendimentosPage()) {
      disconnectInstWS();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  if (!window.__ZC_WS_INST_CHANGE_BOUND__) {
    window.__ZC_WS_INST_CHANGE_BOUND__ = true;

    document.addEventListener('inst:change', () => {
      if (DEBUG_WS) console.debug('[WS] inst:change → mantendo somente WS empresa');

      /*
        Troca de instância no atendimento não precisa abrir /ws/instancia.
        A lista/histórico continuam recebendo mensagem pelo WS da empresa.
      */
      disconnectInstWS();
    });
  }

  if (!window.__ZC_WS_BEFOREUNLOAD_BOUND__) {
    window.__ZC_WS_BEFOREUNLOAD_BOUND__ = true;

    window.addEventListener('beforeunload', () => {
      try {
        disconnectInstWS();
      } catch {}

      try {
        disconnectEmpresaWS();
      } catch {}
    });
  }
} catch {}

export {
  connectEmpresaWS,
  disconnectEmpresaWS,
  connectInstWS,
  disconnectInstWS,
};