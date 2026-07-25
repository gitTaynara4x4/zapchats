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
  onEmpresaMessage as onCoreEmpresaMessage,
  closeEmpresaWS as closeCoreEmpresaWS,
  closeAllWS as closeCoreAllWS
} from '../../realtime/ws-core.js';

const EMPRESA_ID = Number(
  EMPRESA_ID_ENV ||
  window.EMPRESA_ID ||
  localStorage.getItem('empresa_id') ||
  0
);

const DEBUG_WS = Boolean(window.DEBUG_WS ?? false);

// v11/teste: deixa o WS do atendimento leve por padrão.
// O problema testado aqui: ao chegar mensagem em tempo real, o frontend fazia
// render/badge várias vezes e podia atrasar clique/navegação para outras telas.
const WS_LIGHT_MODE = window.ZC_WS_LIGHT_MODE !== false;
const WS_BADGE_REPEAT_LIGHT = window.ZC_WS_BADGE_REPEAT_LIGHT !== false;
const WS_OPEN_SEEN_DELAY_MS = Number(window.ZC_WS_OPEN_SEEN_DELAY_MS || 6500);
const WS_BURST_NAV_GRACE_MS = Number(window.ZC_WS_BURST_NAV_GRACE_MS || 1800);
// V5: fila de mensagens WS. Em rajada, o navegador não pode processar 4/10 mensagens
// de uma vez antes de aceitar clique no menu. Processa 1 por vez e sempre deixa o
// event-loop respirar. Ao sair da tela, a fila é descartada imediatamente.
const WS_MESSAGE_QUEUE_DELAY_MS = Number(window.ZC_WS_MESSAGE_QUEUE_DELAY_MS || 180);
const WS_MESSAGE_QUEUE_MAX_PENDING = Number(window.ZC_WS_MESSAGE_QUEUE_MAX_PENDING || 200);
let __zcWsLastInboundAt = 0;
let __zcWsMessageQueue = [];
let __zcWsMessageFlushTimer = 0;
let __zcWsMessageProcessing = false;


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
let __zcWsNavigatingAway = false;

// v12/teste: quando chegam várias mensagens em sequência, não podemos
// martelar o DOM várias vezes por mensagem. Mantemos só a última atualização
// de badge por conversa e aplicamos em lote pequeno.
const __zcWsBadgeTimers = new Map();
const __zcWsBadgeLatest = new Map();

function isNavigatingAway() {
  try {
    if (!String(location.pathname || '').includes('/atendimentos')) return true;
    if (__zcWsNavigatingAway) return true;
    if (window.__ZC_ATENDIMENTOS_NAVIGATING_AWAY__ === true) return true;
    // Não usar sessionStorage aqui. Ele fica vivo entre páginas e pode fazer o
    // Atendimento novo achar que ainda está saindo, mesmo depois de voltar.
  } catch {}
  return false;
}

function clearWsPendingWork(reason = 'nav-away') {
  try { window.__ZC_ATENDIMENTO_FETCH_GUARD__?.abortAll?.(reason || 'ws-clear'); } catch {}
  try { if (__zcWsOpenRenderTimer) clearTimeout(__zcWsOpenRenderTimer); } catch {}
  try { if (__zcWsOpenDbRefreshTimer) clearTimeout(__zcWsOpenDbRefreshTimer); } catch {}
  try { if (__reloadListTimer) clearTimeout(__reloadListTimer); } catch {}
  try { for (const t of __zcWsBadgeTimers.values()) clearTimeout(t); } catch {}
  try { __zcWsBadgeTimers.clear(); __zcWsBadgeLatest.clear(); } catch {}
  try { __zcWsEventQueue.length = 0; } catch {}
  try { if (__zcWsEventFlushTimer) clearTimeout(__zcWsEventFlushTimer); } catch {}
  try { if (__zcWsMessageFlushTimer) clearTimeout(__zcWsMessageFlushTimer); } catch {}
  try { __zcWsMessageQueue.length = 0; } catch {}
  __zcWsMessageProcessing = false;
  __zcWsOpenRenderTimer = 0;
  __reloadListTimer = null;
  __zcWsEventFlushTimer = 0;
  __zcWsMessageFlushTimer = 0;

  try { window.ZCForceClearLoading?.(reason); } catch {}
  try { window.PageLoading?.hide?.(); } catch {}
  try { window.PageLoading?.reset?.(); } catch {}
  try { window.Splash?.hide?.(); } catch {}
}

function markWsNavigatingAway(reason = 'nav-away') {
  __zcWsNavigatingAway = true;
  try { window.__ZC_ATENDIMENTOS_NAVIGATING_AWAY__ = true; } catch {}
  clearWsPendingWork(reason);
  try { closeCoreAllWS(); } catch {}
  try { disconnectInstWS(); } catch {}
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
    // Sem conversa realmente aberta na tela, não usa state.clienteSel antigo.
    // Isso evita zerar/travar a bolha quando a lista está aberta e o chat não.
    if (!isChatUiActuallyOpen()) return false;

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
  // Não considera conversa aberta só por state antigo.
  // Precisa existir chat visível de verdade.
  if (!isChatUiActuallyOpen()) return null;

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


function getOpenRefForIncomingUsingOpenKey(incomingRef, data = null) {
  /*
    Fallback seguro para conversa JÁ ABERTA.

    Para o histórico aberto, a key que manda é a key que está no DOM.
    Se o evento WS vem com outra representação de instância, renderizar pela
    key do evento faz o historico.js ignorar o append por segurança.
  */
  try {
    if (!isChatUiActuallyOpen()) return null;

    const open = getOpenContext();
    if (!open) return null;

    const incoming = normalizeConversationRef(
      incomingRef,
      typeof incomingRef === 'object' ? incomingRef : data
    );

    if (!incoming?.kind || !incoming?.entityId) return null;

    const openKind = open.kind || incoming.kind || 'c';
    if (String(openKind || 'c') !== String(incoming.kind || 'c')) return null;

    let sameEntity = false;

    if (open.entityId && incoming.entityId) {
      sameEntity = String(open.entityId) === String(incoming.entityId);
    }

    if (!sameEntity && incoming.kind === 'c') {
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

      if (incomingPhone && open.phone && samePhone(open.phone, incomingPhone)) {
        sameEntity = true;
      }
    }

    if (!sameEntity) return null;

    let instOk = false;

    if (open.instId && incoming.instId) {
      instOk = sameInstForOpen(open.instId, incoming.instId);
    }

    if (!instOk) {
      const active = getActiveInstKey();
      if (active && incoming.instId && sameInstForOpen(active, incoming.instId)) {
        if (!open.instId || sameInstForOpen(open.instId, active)) instOk = true;
      }
    }

    if (!instOk && !open.instId && incoming.instId) {
      instOk = true;
    }

    if (!instOk) return null;

    const entityId = open.entityId || incoming.entityId;
    const instId = open.instId || getActiveInstKey() || incoming.instId;
    const key = open.key || buildConversationKey(openKind, entityId, instId);

    if (!key || !entityId || !instId) return null;

    return {
      key,
      kind: openKind,
      entityId,
      instId,
      from: 'open-dom',
    };
  } catch {
    return null;
  }
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
  const openRef = getOpenRefForIncomingUsingOpenKey(incoming, data) || getOpenRefIfMatchesIncoming(incoming, data);
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

function isElementVisible(el) {
  try {
    if (!el || el.hidden) return false;
    const cs = window.getComputedStyle(el);
    if (!cs) return false;
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  } catch {
    return false;
  }
}

function isChatUiActuallyOpen() {
  try {
    const hist = document.getElementById('historico');
    const head = document.getElementById('chat-header');
    const footer = document.getElementById('chat-footer');
    const title = document.getElementById('chat-title');

    if (isElementVisible(head) || isElementVisible(hist) || isElementVisible(footer)) return true;

    const titleText = String(title?.textContent || '').trim();
    if (titleText && isElementVisible(title)) return true;

    const hasMessages = !!hist?.querySelector(
      '.bubble, .bolha-mensagem, .msg-row, .linha-mensagem, .date-chip, .zc-day-divider, [data-message-id], [data-msg-id]'
    );

    return hasMessages && isElementVisible(hist);
  } catch {
    return false;
  }
}

function cssEscapeSafe(value) {
  const s = String(value ?? '');

  try {
    return CSS.escape(s);
  } catch {
    return s.replace(/["\\]/g, '\\$&');
  }
}

function findConversationListItems(refOrKey, patch = null) {
  const ref = normalizeConversationRef(refOrKey, typeof refOrKey === 'object' ? refOrKey : patch);

  if (!ref?.kind || !ref?.entityId) return [];

  const found = [];
  const seen = new Set();

  const add = (el) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    found.push(el);
  };

  const trySelector = (sel) => {
    try {
      document.querySelectorAll(sel).forEach(add);
    } catch {}
  };

  if (ref.key) {
    const k = cssEscapeSafe(ref.key);

    trySelector(`.chat-item[data-id="${k}"]`);
    trySelector(`.cliente-item[data-id="${k}"]`);
    trySelector(`[data-conversation-key="${k}"]`);
    trySelector(`[data-conversation-id="${k}"]`);
    trySelector(`[data-conv-key="${k}"]`);
  }

  const entity = cssEscapeSafe(ref.entityId);

  if (ref.kind === 'c') {
    trySelector(`.chat-item[data-cliente-id="${entity}"]`);
    trySelector(`.cliente-item[data-cliente-id="${entity}"]`);
    trySelector(`.chat-item[data-api-cliente-id="${entity}"]`);
    trySelector(`.chat-item[data-backend-cliente-id="${entity}"]`);
    trySelector(`.cliente-item[data-api-cliente-id="${entity}"]`);
    trySelector(`.cliente-item[data-backend-cliente-id="${entity}"]`);
  } else {
    trySelector(`.chat-item[data-grupo-id="${entity}"]`);
    trySelector(`.cliente-item[data-grupo-id="${entity}"]`);
  }

  trySelector(`.chat-item[data-entity-id="${entity}"]`);
  trySelector(`.cliente-item[data-entity-id="${entity}"]`);
  trySelector(`.chat-item[data-id="${entity}"]`);
  trySelector(`.cliente-item[data-id="${entity}"]`);

  const phoneIncoming =
    patch?.telefone_norm ??
    patch?.telefone ??
    patch?.phone ??
    patch?.numero ??
    patch?.number ??
    '';

  document.querySelectorAll('.chat-item, .cliente-item').forEach((li) => {
    try {
      if (seen.has(li)) return;

      const d = li.dataset || {};

      const rowLike = {
        conversation_key:
          d.conversationKey ||
          d.conversationId ||
          d.convKey ||
          d.id ||
          null,

        kind:
          d.kind ||
          d.tipoConversa ||
          d.tipoRef ||
          (d.grupoId ? 'g' : 'c'),

        entity_id:
          d.entityId ||
          d.clienteId ||
          d.apiClienteId ||
          d.backendClienteId ||
          d.grupoId ||
          d.id ||
          null,

        cliente_id:
          d.clienteId ||
          d.apiClienteId ||
          d.backendClienteId ||
          null,

        grupo_id:
          d.grupoId ||
          null,

        instancia_id:
          d.instanciaId ||
          d.instancia ||
          d.instanceId ||
          d.instanceName ||
          d.instance ||
          null,

        telefone:
          d.telefone ||
          d.phone ||
          d.numero ||
          d.number ||
          null,

        telefone_norm:
          d.telefoneNorm ||
          d.telefone ||
          null,
      };

      const liRef = normalizeConversationRef(rowLike, rowLike);

      if (liRef?.key && ref.key && liRef.key === ref.key) {
        add(li);
        return;
      }

      if (liRef?.kind && liRef?.entityId) {
        const sameKind = liRef.kind === ref.kind;
        const sameEntity = String(liRef.entityId) === String(ref.entityId);

        if (sameKind && sameEntity) {
          const liInst = liRef.instId || rowLike.instancia_id;

          if (!ref.instId || !liInst || sameInstStrict(liInst, ref.instId) || sameInstForOpen(liInst, ref.instId)) {
            add(li);
            return;
          }
        }
      }

      if (
        ref.kind === 'c' &&
        phoneIncoming &&
        samePhone(rowLike.telefone_norm || rowLike.telefone, phoneIncoming)
      ) {
        const liInst = liRef?.instId || rowLike.instancia_id;

        if (!ref.instId || !liInst || sameInstStrict(liInst, ref.instId) || sameInstForOpen(liInst, ref.instId)) {
          add(li);
          return;
        }
      }
    } catch {}
  });

  return found;
}

function ensureUnreadBadgeElement(li) {
  if (!li) return null;

  let badgeEl = li.querySelector('.zc-unread-badge, .unread-badge, .badge');

  if (badgeEl) return badgeEl;

  badgeEl = document.createElement('span');
  badgeEl.className = 'badge zc-unread-badge unread-badge';
  badgeEl.setAttribute('aria-label', 'Mensagens não lidas');

  const anchor =
    li.querySelector('.chat-meta, .cliente-meta, .chat-side, .chat-right, .chat-time')?.parentElement ||
    li.querySelector('.chat-meta, .cliente-meta, .chat-side, .chat-right') ||
    li;

  anchor.appendChild(badgeEl);

  return badgeEl;
}

function forceUnreadBadgeDom(refOrKey, unread, patch = null) {
  const ref = normalizeConversationRef(refOrKey, typeof refOrKey === 'object' ? refOrKey : patch);

  if (!ref?.kind || !ref?.entityId) return 0;

  const nRaw = Number(unread);
  const n = Number.isFinite(nRaw) && nRaw > 0 ? Math.floor(nRaw) : 0;

  const items = findConversationListItems(ref, patch);

  for (const li of items) {
    try {
      li.dataset.novas = String(n);
      li.dataset.unread = String(n);
      li.dataset.unreadCount = String(n);
      li.dataset.naoLidas = String(n);

      li.classList.toggle('has-unread', n > 0);
      li.classList.toggle('unread', n > 0);
      li.classList.toggle('is-unread', n > 0);

      const badgeEl = ensureUnreadBadgeElement(li);

      if (badgeEl) {
        badgeEl.textContent = n > 0 ? String(n) : '';
        badgeEl.style.display = n > 0 ? 'inline-flex' : 'none';
        badgeEl.hidden = n <= 0;
        badgeEl.setAttribute('data-count', String(n));
      }

      const timeEl = li.querySelector('.chat-time, .cliente-time, [data-role="time"]');
      if (timeEl) {
        timeEl.classList.toggle('has-unread-time', n > 0);
      }
    } catch {}
  }

  try {
    if (items.length && DEBUG_WS) {
      console.debug('[WS MSG][badge-dom]', {
        conversation_key: ref.key,
        entity_id: ref.entityId,
        instancia_id: ref.instId,
        unread: n,
        items: items.length,
      });
    }
  } catch {}

  return items.length;
}


// V6: atualização local da lista lateral sem chamar /api/atendimento/conversas.
// A V4/V5 precisou bloquear reload pesado da lista para não travar a navegação.
// Este patch mantém a lista visual atualizada mexendo só no <li> da conversa.
function formatListTimeFromPayload(payload = null) {
  try {
    const raw =
      payload?.timestamp ??
      payload?.ts ??
      payload?.ultima_mensagem_ts ??
      payload?.last_ts ??
      payload?.updated_at ??
      payload?.created_at ??
      Date.now();

    let ms = tsToMillis(raw);
    if (!ms && typeof raw === 'number') ms = raw < 10000000000 ? raw * 1000 : raw;
    if (!ms) ms = Date.now();

    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';

    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const oneDay = 24 * 60 * 60 * 1000;

    if (startMsg === startToday) {
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    if (startToday - startMsg === oneDay) return 'ontem';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  } catch {
    return '';
  }
}

function previewTextFromPayloadLocal(payload = null) {
  try {
    const text = pickText(payload);
    if (text && String(text).trim()) return String(text).trim();

    const tipo = String(
      payload?.messageType ??
      payload?.tipo_midia ??
      payload?.media_type ??
      payload?.type ??
      ''
    ).toLowerCase();

    if (tipo.includes('audio') || payload?.audio || payload?.ptt) return '[Áudio]';
    if (tipo.includes('image') || tipo.includes('imagem') || payload?.image || payload?.imagem) return '[Imagem]';
    if (tipo.includes('video') || payload?.video) return '[Vídeo]';
    if (tipo.includes('document') || tipo.includes('arquivo') || payload?.documento || payload?.file) return '[Arquivo]';
    if (Array.isArray(payload?.midias) && payload.midias.length) return '[Mídia]';
  } catch {}
  return '';
}

function patchConversationListPreviewDom(refOrKey, payload = null, opts = {}) {
  if (isNavigatingAway()) return 0;

  const ref = normalizeConversationRef(refOrKey, typeof refOrKey === 'object' ? refOrKey : payload);
  if (!ref?.kind || !ref?.entityId) return 0;

  const text = previewTextFromPayloadLocal(payload);
  const timeText = formatListTimeFromPayload(payload);

  const isOutgoing =
    payload?.from_me === true ||
    payload?.fromMe === true ||
    payload?.tipo === 'saida' ||
    payload?.origem === 'atendente';

  const openNow = opts.openNow === true || isOpenChat(ref);

  const items = findConversationListItems(ref, payload);
  if (!items.length) return 0;

  const rawUnread =
    payload?.novas ??
    payload?.unread_count ??
    payload?.unread ??
    payload?.nao_lidas ??
    payload?.naoLidas ??
    payload?.qtd_nao_lidas ??
    payload?.qtdNaoLidas ??
    null;

  for (const li of items) {
    try {
      if (ref.key) {
        li.dataset.id = li.dataset.id || ref.key;
        li.dataset.conversationKey = ref.key;
        li.dataset.conversationId = ref.key;
      }
      li.dataset.kind = ref.kind || li.dataset.kind || 'c';
      li.dataset.entityId = ref.entityId || li.dataset.entityId || '';
      if (ref.instId) li.dataset.instanciaId = ref.instId;
      if (ref.kind === 'c') li.dataset.clienteId = ref.entityId;
      if (ref.kind === 'g') li.dataset.grupoId = ref.entityId;

      if (text) {
        li.dataset.preview = text;
        li.dataset.ultimaMensagem = text;
        li.dataset.lastMessage = text;

        const previewEl =
          li.querySelector('.preview-text') ||
          li.querySelector('[data-role="preview"]') ||
          li.querySelector('.chat-preview') ||
          li.querySelector('.cliente-preview') ||
          li.querySelector('.last-message') ||
          li.querySelector('.last-line');

        if (previewEl) {
          previewEl.textContent = text;
        } else {
          const last = li.querySelector('.chat-last, .cliente-last');
          if (last) last.textContent = text;
        }
      }

      if (timeText) {
        li.dataset.lastTs = String(tsToMillis(payload?.timestamp ?? payload?.ts ?? payload?.ultima_mensagem_ts ?? payload?.last_ts ?? payload?.updated_at) || Date.now());
        const timeEl = li.querySelector('.chat-time, .cliente-time, time, [data-role="time"]');
        if (timeEl) timeEl.textContent = timeText;
      }

      let unread = null;
      if (openNow) {
        unread = 0;
      } else if (rawUnread !== null && rawUnread !== undefined && rawUnread !== '') {
        const n = Number(rawUnread);
        unread = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
      } else if (!isOutgoing) {
        const prev = Number(li.dataset.novas || li.dataset.unread || 0);
        unread = Math.max(0, (Number.isFinite(prev) ? prev : 0) + 1);
      }

      if (unread !== null) {
        li.dataset.novas = String(unread);
        li.dataset.unread = String(unread);
        li.dataset.unreadCount = String(unread);
        li.dataset.naoLidas = String(unread);
        li.classList.toggle('has-unread', unread > 0);
        li.classList.toggle('unread', unread > 0);
        li.classList.toggle('is-unread', unread > 0);

        const badgeEl = ensureUnreadBadgeElement(li);
        if (badgeEl) {
          badgeEl.textContent = unread > 0 ? String(unread) : '';
          badgeEl.hidden = unread <= 0;
          badgeEl.style.display = unread > 0 ? 'inline-flex' : 'none';
          badgeEl.setAttribute('data-count', String(unread));
        }
      }

      // Mantém a conversa no topo sem recarregar a lista inteira.
      if (opts.moveTop !== false) {
        const parent = li.parentElement;
        if (parent && parent.firstElementChild !== li) {
          const firstReal = Array.from(parent.children).find(el => el && el.classList && !el.classList.contains('load-more-item'));
          if (firstReal && firstReal !== li) parent.insertBefore(li, firstReal);
        }
      }
    } catch {}
  }

  try {
    document.dispatchEvent(new CustomEvent('ws:list_preview_patched', {
      detail: {
        conversation_key: ref.key,
        conversation_id: ref.key,
        kind: ref.kind,
        entity_id: ref.entityId,
        instancia_id: ref.instId,
        preview: text,
        openNow,
        items: items.length,
      },
    }));
  } catch {}

  return items.length;
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

const WS_RENDER_DEBOUNCE_MS = Number(
  window.ZC_WS_RENDER_DEBOUNCE_MS ?? (WS_LIGHT_MODE ? 180 : (window.ZC_LOW_RAM_MODE ? 250 : 0))
);
let __zcWsOpenRenderTimer = 0;
let __zcWsOpenRenderKey = '';

function renderOpenConversationFromWs(convRef) {
  if (isNavigatingAway()) return;

  const ref = normalizeConversationRef(convRef, typeof convRef === 'object' ? convRef : null);
  if (!ref?.key) return;

  try {
    ensureDomContextFor(ref);
  } catch {}

  const renderOnce = () => {
    if (isNavigatingAway()) return;
    try {
      renderHistoricoDoCache(ref.key, true);
      scrollBottomSoon();
    } catch (e) {
      if (DEBUG_WS) console.warn('[WS MSG][renderOpenConversationFromWs] falhou', e);
    }
  };

  // Modo leve: uma mensagem via WS não precisa redesenhar o chat 4 vezes.
  // Debounce evita estouro de RAM quando chegam mensagens/ACKs em lote.
  if (window.ZC_LOW_RAM_MODE || WS_RENDER_DEBOUNCE_MS > 0) {
    __zcWsOpenRenderKey = ref.key;
    if (__zcWsOpenRenderTimer) clearTimeout(__zcWsOpenRenderTimer);
    __zcWsOpenRenderTimer = setTimeout(() => {
      if (isNavigatingAway()) return;
      if (__zcWsOpenRenderKey !== ref.key) return;
      renderOnce();
    }, WS_RENDER_DEBOUNCE_MS || 120);
    return;
  }

  renderOnce();

  try {
    requestAnimationFrame(renderOnce);
  } catch {}

  setTimeout(renderOnce, 80);
  setTimeout(renderOnce, 250);
}

function badgeKeyFromRef(refOrKey, patch = null) {
  try {
    if (typeof refOrKey === 'string') return refOrKey || 'unknown';
    if (refOrKey?.key) return String(refOrKey.key);
    if (refOrKey?.conversation_key) return String(refOrKey.conversation_key);
    if (refOrKey?.conversation_id) return String(refOrKey.conversation_id);
    if (patch?.conversation_key) return String(patch.conversation_key);
    if (patch?.conversation_id) return String(patch.conversation_id);
    const k = normalizeConversationRef(refOrKey, patch)?.key;
    if (k) return String(k);
  } catch {}
  return 'unknown';
}

function scheduleForceUnreadBadgeDom(refOrKey, unread, patch = null) {
  if (isNavigatingAway()) return;

  const runNow = (r, u, p) => {
    if (isNavigatingAway()) return;
    try { forceUnreadBadgeDom(r, u, p); } catch {}
  };

  // v12/teste: em modo leve, debounce por conversa. Sem isso, 7 mensagens
  // geravam várias passagens completas no DOM e podiam atrasar clique/navegação.
  if (WS_LIGHT_MODE || window.ZC_LOW_RAM_MODE || WS_BADGE_REPEAT_LIGHT) {
    const key = badgeKeyFromRef(refOrKey, patch);
    __zcWsBadgeLatest.set(key, { refOrKey, unread, patch });

    try {
      const oldTimer = __zcWsBadgeTimers.get(key);
      if (oldTimer) clearTimeout(oldTimer);
    } catch {}

    const timer = setTimeout(() => {
      if (isNavigatingAway()) return;
      const latest = __zcWsBadgeLatest.get(key);
      __zcWsBadgeTimers.delete(key);
      __zcWsBadgeLatest.delete(key);
      if (!latest) return;
      runNow(latest.refOrKey, latest.unread, latest.patch);
    }, Number(window.ZC_WS_BADGE_DEBOUNCE_MS ?? 160));

    __zcWsBadgeTimers.set(key, timer);
    return;
  }

  const run = () => runNow(refOrKey, unread, patch);
  run();
  try { requestAnimationFrame(run); } catch {}
  try { setTimeout(run, 0); } catch {}
  try { setTimeout(run, 60); } catch {}
  try { setTimeout(run, 180); } catch {}
  try { setTimeout(run, 420); } catch {}
  try { setTimeout(run, 900); } catch {}
}
/* =========================================================
   LISTA OFICIAL
========================================================= */

function requestOfficialListReload(reason = 'ws-reload') {
  if (isNavigatingAway()) return;

  // Mensagem chegando na conversa aberta não pode buscar lista oficial.
  // O payload WS já atualiza cache/preview/bolha. Esse GET era um dos pedidos
  // que ficavam pendurados e atrasavam pagehide ao sair do Atendimento.
  if (String(reason || '').startsWith('ws-open-')) return;

  const now = Date.now();

  if (now - __lastReloadListAt < 1800) return;
  __lastReloadListAt = now;

  clearTimeout(__reloadListTimer);

  __reloadListTimer = setTimeout(() => {
    if (isNavigatingAway()) return;

    // Correção v10:
    // Nunca força reload pesado da lista a partir de WS.
    // O force:true + convForceReload era o gatilho do carregamento infinito.
    try {
      sessionStorage.removeItem('convForceReload');
    } catch {}

    try {
      window.carregarClientes?.({
        // v11: precisa buscar do backend quando o patch local da lista falhar.
        // force:false só redesenha cache fresco e não traz o preview novo.
        force: true,
        reason: `soft-force:${reason}`,
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
  }, 900);
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

  const openNow = isOpenChat(ref);

  const existingRow = findKnownConversationByRef(ref, msg);
  const previousUnread = unreadFromRow(existingRow);

  const rawUnread =
    msg?.novas ??
    msg?.unread_count ??
    msg?.unread ??
    msg?.nao_lidas ??
    msg?.naoLidas ??
    msg?.qtd_nao_lidas ??
    msg?.qtdNaoLidas ??
    null;

  const explicitUnread = Number(rawUnread);
  const hasExplicitUnread =
    rawUnread !== null &&
    rawUnread !== undefined &&
    Number.isFinite(explicitUnread) &&
    explicitUnread >= 0;

  /*
    Regra:
    - mensagem enviada por atendente: não mostra bolinha
    - conversa aberta: não mostra bolinha
    - conversa fechada: usa contador real do backend; se não vier, soma +1
  */
  const unread =
    openNow
      ? 0
      : isOutgoing
        // Mensagem de saída/automática NÃO pode apagar contador de conversa fechada.
        // Ela só muda preview/hora. Quem limpa bolha é abrir conversa ou marcar como lida.
        ? previousUnread
        : hasExplicitUnread
          ? explicitUnread
          : previousUnread + 1;

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
    // v12: bumpPreview não agenda reload sozinho. O chamador sabe se a conversa
    // está aberta e decide um fallback leve/debounced. Duplicar aqui fazia uma
    // busca da lista oficial em cada rajada e prendia a saída da tela.
    return null;
  }

  const finalKey = getConversationIdFromRow(updated) || ref.key;

  try {
    window.Lista?.updatePreview?.(finalKey, patch);
  } catch {}

  // v11/teste: uma única atualização de badge é suficiente.
  // Antes essa chamada aparecia duas vezes no mesmo bumpPreview(),
  // multiplicando timers/DOM quando chegava mensagem via WS.
  try {
    scheduleForceUnreadBadgeDom(finalKey, unread, {
      ...patch,
      conversation_key: finalKey,
      conversation_id: finalKey,
      kind: ref.kind,
      entity_id: ref.entityId,
      cliente_id: ref.kind === 'c' ? ref.entityId : patch?.cliente_id,
      grupo_id: ref.kind === 'g' ? ref.entityId : patch?.grupo_id,
      instancia_id: ref.instId,
    });
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



let __zcWsOpenDbRefreshTimer = 0;
let __zcWsOpenDbRefreshKey = '';

function forceRefreshOpenConversationFromDbSoon(convRef, reason = 'ws-open-db-refresh') {
  if (isNavigatingAway()) return;

  // Produção: não faz GET /mensagens em toda mensagem recebida na conversa aberta.
  // O payload WS já foi salvo no cache e renderizado. O refresh DB fica só como
  // fallback manual/diagnóstico, porque ele era uma das causas do atraso ao sair
  // de /atendimentos para Dashboard/Mídias.
  if (window.ZC_WS_FORCE_DB_REFRESH !== true) return;

  const ref = normalizeConversationRef(convRef, typeof convRef === 'object' ? convRef : null);
  if (!ref?.key) return;

  const open = getOpenContext();
  const openKey = open?.key || ref.key;

  if (!openKey) return;

  __zcWsOpenDbRefreshKey = String(openKey);

  if (__zcWsOpenDbRefreshTimer) clearTimeout(__zcWsOpenDbRefreshTimer);

  __zcWsOpenDbRefreshTimer = setTimeout(() => {
    if (isNavigatingAway()) return;

    const current = getOpenContext();
    const currentKey = current?.key || '';

    if (currentKey && String(currentKey) !== __zcWsOpenDbRefreshKey) return;

    try {
      if (typeof window.zcForceHistoryRefresh === 'function') {
        window.zcForceHistoryRefresh(__zcWsOpenDbRefreshKey, {
          append: true,
          limit: 12,
          reason,
        });
        return;
      }
    } catch {}

    try {
      if (typeof window.abrirHistorico === 'function') {
        window.abrirHistorico(__zcWsOpenDbRefreshKey);
      }
    } catch {}
  }, Number(window.ZC_WS_OPEN_DB_REFRESH_MS || 450));
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
    if (key) {
      updateAck(key, msgId, ack, ref?.instId || pickInstanciaFromAny(data));
    }
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


function scheduleWsMessageQueueFlush(delay = WS_MESSAGE_QUEUE_DELAY_MS) {
  if (isNavigatingAway()) {
    try { __zcWsMessageQueue.length = 0; } catch {}
    return;
  }
  if (__zcWsMessageFlushTimer) return;
  __zcWsMessageFlushTimer = setTimeout(() => {
    __zcWsMessageFlushTimer = 0;
    flushWsMessageQueue();
  }, Math.max(0, Number(delay || 0)));
}

function flushWsMessageQueue() {
  if (isNavigatingAway()) {
    try { __zcWsMessageQueue.length = 0; } catch {}
    __zcWsMessageProcessing = false;
    return;
  }
  if (__zcWsMessageProcessing) return;

  const item = __zcWsMessageQueue.shift();
  if (!item) return;

  __zcWsMessageProcessing = true;
  try {
    processNovaMensagemNow(item);
  } catch (e) {
    if (DEBUG_WS) console.warn('[WS MSG][queue][erro]', e);
  } finally {
    __zcWsMessageProcessing = false;
  }

  if (__zcWsMessageQueue.length) {
    scheduleWsMessageQueueFlush(WS_MESSAGE_QUEUE_DELAY_MS);
  }
}

function handleNovaMensagem(data) {
  if (isNavigatingAway()) return;

  // V5: prioridade absoluta para clique/navegação.
  // Mensagem WS entra na fila e o processamento pesado fica para um tick separado.
  try { __zcWsLastInboundAt = Date.now(); window.__ZC_WS_LAST_INBOUND_AT__ = __zcWsLastInboundAt; } catch {}

  try {
    __zcWsMessageQueue.push(data);
    if (__zcWsMessageQueue.length > WS_MESSAGE_QUEUE_MAX_PENDING) {
      __zcWsMessageQueue.splice(0, __zcWsMessageQueue.length - WS_MESSAGE_QUEUE_MAX_PENDING);
    }
  } catch {}

  scheduleWsMessageQueueFlush(__zcWsMessageQueue.length <= 1 ? 0 : WS_MESSAGE_QUEUE_DELAY_MS);
}

function processNovaMensagemNow(data) {
  if (isNavigatingAway()) return;
  try { __zcWsLastInboundAt = Date.now(); window.__ZC_WS_LAST_INBOUND_AT__ = __zcWsLastInboundAt; } catch {}

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

  const openRefDirect = getOpenRefForIncomingUsingOpenKey(incomingRef, data) || getOpenRefIfMatchesIncoming(incomingRef, data);
  const knownRef = openRefDirect || resolveKnownRefForIncoming(data);

  /*
    WS NUNCA cria conversa fantasma na lista.
    Mas se a conversa JÁ ESTÁ ABERTA, pode renderizar usando o contexto aberto.
  */
  if (!knownRef?.key || !knownRef?.instId) {
    const openRef = openRefDirect || getOpenRefForIncomingUsingOpenKey(incomingRef, data) || getOpenRefIfMatchesIncoming(incomingRef, data);

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

    // v11: este é o caminho que causava "atualiza só a conversa".
    // Quando o WS acha a conversa aberta, mas não acha o item na lista/cache,
    // ele renderizava a bolha e saía sem tocar na lista lateral.
    // Tenta patch local; se não achar a linha da lista, faz reload oficial leve.
    const updatedOpen = bumpPreview(openRef, normalizedOpenPayload, openRef.instId);
    try { patchConversationListPreviewDom(openRef, normalizedOpenPayload, { openNow: true, moveTop: true }); } catch {}
    if (!updatedOpen) {
      // Conversa aberta: não chama /api/atendimento/conversas.
      // A bolha já foi empurrada pelo WS; a lista lateral é corrigida localmente acima.
    }

    dispatchRealtimeMessageEvents(normalizedOpenPayload);

    /*
      A conversa já está aberta e recebeu a mensagem pelo WebSocket.
      Não força reload pesado aqui, porque isso reabre /atendimentos,
      mostra spinner e pode parecer que a tela caiu.
      Se a lista não bateu, o reload acima é leve/noLoading e debounced.
    */

    renderOpenConversationFromWs(openRef);
    // V4: conversa aberta não faz refresh DB nem notificação desktop/toast.
    // Em rajada, isso competia com o clique para sair.
    // forceRefreshOpenConversationFromDbSoon(openRef, 'ws-open-unknown');

    return;
  }

  const openNow = Boolean(openRefDirect) || isOpenChat(knownRef) || knownRef.from === 'open' || knownRef.from === 'open-phone';

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
  try { patchConversationListPreviewDom(knownRef, normalizedPayload, { openNow, moveTop: true }); } catch {}

  if (!WS_LIGHT_MODE) {
    try {
      const explicitUnread = unreadFromRow(normalizedPayload);
      const existingUnread = unreadFromRow(findKnownConversationByRef(knownRef, normalizedPayload));
      const fallbackUnread = existingUnread > 0 ? existingUnread : explicitUnread;

      if (!openNow) {
        scheduleForceUnreadBadgeDom(knownRef, fallbackUnread, normalizedPayload);
      } else {
        scheduleForceUnreadBadgeDom(knownRef, 0, normalizedPayload);
      }
    } catch {}
  }

  dispatchRealtimeMessageEvents(normalizedPayload);

  /*
    A bolha do chat e a lista lateral são fluxos diferentes.

    Se a conversa está aberta, o WS já empurra a bolha e bumpPreview tenta
    atualizar a lista em memória. Não força reload oficial, porque o reload
    chama carregarClientes(), troca o estado da tela e gera o spinner infinito.

    Se a conversa NÃO está aberta e o preview não conseguiu atualizar, aí sim
    recarrega a lista para criar/posicionar a conversa corretamente.
  */
  if (!updated) {
    if (!openNow) {
      requestOfficialListReload('ws-message-update-miss');
      return;
    }
    // Conversa aberta: não chama /api/atendimento/conversas durante rajada de WS.
    // Isso evita request pendurado segurando navegação para Dashboard/Departamentos.
  }

  if (openNow) {
    try {
      // V4: em rajada de mensagens com a conversa aberta, não faz seen/meta/lista
      // imediatamente. Limpa visualmente e agenda um seen tardio e único.
      // Se o usuário sair, o fetch guard aborta/cancela antes de ocupar conexão.
      try { window.zcScheduleMarkChatAsSeen?.(knownRef.key, normalizedPayload, { delay: WS_OPEN_SEEN_DELAY_MS }); } catch {}

      renderOpenConversationFromWs(knownRef);
      // O payload WS já atualiza o cache/histórico local; refresh DB fica desligado.
      // forceRefreshOpenConversationFromDbSoon(knownRef, 'ws-open-known');
    } catch (e) {
      if (DEBUG_WS) console.warn('[WS MSG][render falhou]', e);
    }
  } else if (DEBUG_WS) {
    console.debug('[WS MSG][não aberto - só preview/badge]', {
      incoming: knownRef.key,
      open: getOpenContext()?.key,
      data: normalizedPayload,
    });
  }

  if (!openNow) {
    notifyNewMessage(normalizedPayload, knownRef.key);
  }

  try {
    const outgoingPayload =
      normalizedPayload?.from_me === true ||
      normalizedPayload?.fromMe === true ||
      normalizedPayload?.tipo === 'saida' ||
      normalizedPayload?.origem === 'atendente';

    const rowAfter = findKnownConversationByRef(knownRef, normalizedPayload);
    const currentUnread = unreadFromRow(rowAfter);

    const rawUnreadFinal =
      normalizedPayload?.novas ??
      normalizedPayload?.unread_count ??
      normalizedPayload?.unread ??
      normalizedPayload?.nao_lidas ??
      normalizedPayload?.naoLidas ??
      normalizedPayload?.qtd_nao_lidas ??
      normalizedPayload?.qtdNaoLidas ??
      null;

    const explicitFinal = Number(rawUnreadFinal);
    const hasExplicitFinal =
      rawUnreadFinal !== null &&
      rawUnreadFinal !== undefined &&
      Number.isFinite(explicitFinal) &&
      explicitFinal >= 0;

    const deltaFinal = Number(
      normalizedPayload?.unreadDelta ??
      normalizedPayload?.unread_delta ??
      normalizedPayload?.unreadIncrement ??
      0
    );

    const finalBadgeUnread = openNow
      ? 0
      : outgoingPayload
        ? currentUnread
        : hasExplicitFinal
          ? explicitFinal
          : Math.max(0, currentUnread + (Number.isFinite(deltaFinal) ? deltaFinal : 1));

    if (!WS_LIGHT_MODE) {
      scheduleForceUnreadBadgeDom(knownRef, finalBadgeUnread, normalizedPayload);
    }
  } catch {}

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


// v12/teste: fila cooperativa. Em rajadas, processa poucos eventos por vez
// e devolve o controle para o navegador entre eles, para clique no menu não
// ficar preso esperando o Atendimento terminar render/badge/seen.
const WS_EVENT_QUEUE_ENABLED = window.ZC_WS_EVENT_QUEUE_ENABLED !== false;
const WS_EVENT_CHUNK_DELAY_MS = Number(window.ZC_WS_EVENT_CHUNK_DELAY_MS ?? 35);
const WS_EVENT_MAX_PER_TICK = Math.max(1, Number(window.ZC_WS_EVENT_MAX_PER_TICK ?? 1));
let __zcWsEventQueue = [];
let __zcWsEventFlushTimer = 0;
let __zcWsEventFlushing = false;

function scheduleWsEventFlush() {
  if (isNavigatingAway()) {
    __zcWsEventQueue.length = 0;
    return;
  }
  if (__zcWsEventFlushTimer) return;
  __zcWsEventFlushTimer = setTimeout(flushWsEventQueue, WS_EVENT_CHUNK_DELAY_MS);
}

function flushWsEventQueue() {
  __zcWsEventFlushTimer = 0;
  if (isNavigatingAway()) {
    __zcWsEventQueue.length = 0;
    return;
  }
  if (__zcWsEventFlushing) return;

  __zcWsEventFlushing = true;
  try {
    let count = 0;
    while (count < WS_EVENT_MAX_PER_TICK && __zcWsEventQueue.length && !isNavigatingAway()) {
      const ev = __zcWsEventQueue.shift();
      try { handleMessageImmediate(ev); } catch (e) {
        if (DEBUG_WS) console.warn('[WS][queue] falha processando evento', e);
      }
      count += 1;
    }
  } finally {
    __zcWsEventFlushing = false;
  }

  if (__zcWsEventQueue.length && !isNavigatingAway()) {
    scheduleWsEventFlush();
  }
}

function handleMessage(ev) {
  if (isNavigatingAway()) return;
  if (!WS_EVENT_QUEUE_ENABLED) {
    handleMessageImmediate(ev);
    return;
  }

  __zcWsEventQueue.push(ev);

  // Proteção: se vier rajada absurda, preserva eventos recentes e não deixa
  // o navegador afogar em backlog velho.
  if (__zcWsEventQueue.length > 80) {
    __zcWsEventQueue = __zcWsEventQueue.slice(-80);
  }

  scheduleWsEventFlush();
}

function handleMessageImmediate(ev) {
  if (isNavigatingAway()) return;

  if (typeof ev?.data === 'string' && (ev.data === 'pong' || ev.data === 'ping')) return;

  const raw = typeof ev?.data === 'string' ? safeJson(ev.data) : ev?.data;
  const data = unwrap(raw);

  if (!data || typeof data !== 'object') return;

  const sTs = Number(data.serverTimestamp ?? 0);
  if (Number.isFinite(sTs) && sTs > 0) lastServerTs = sTs;

  if (data.type === 'presence_update') {
    const detail = { ...data };

    try {
      window.dispatchEvent(new CustomEvent('zc:presence-update', { detail }));
    } catch {}

    try {
      document.dispatchEvent(new CustomEvent('ws:presence_update', { detail }));
    } catch {}

    return;
  }

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

  if (data.type === 'atendimento_claim_updated') {
    const convKey =
      data.conversation_key ||
      data.conversation_id ||
      (
        data.cliente_id && data.instancia_id
          ? `c:${data.cliente_id}:${data.instancia_id}`
          : null
      );

    const ref = convKey ? normalizeConversationRef(convKey, data) : null;

    if (ref?.key) {
      storeUpdateKnownConversation(ref, {
        operador_id: data.operador_id ?? data.responsavel_id ?? null,
        responsavel_id: data.responsavel_id ?? data.operador_id ?? null,
        operador_nome: data.operador_nome ?? data.responsavel_nome ?? null,
        responsavel_nome: data.responsavel_nome ?? data.operador_nome ?? null,
        status: data.status ?? null,
        statusatendimento: data.status ?? null,
        departamento_id: data.departamento_id ?? null,
        instancia_id: ref.instId,
        is_accepted: Boolean(data.operador_id ?? data.responsavel_id),
      }, ref.instId);
    }

    const detail = {
      ...data,
      conversation_key: ref?.key || convKey,
      conversation_id: ref?.key || convKey,
    };

    try {
      window.dispatchEvent(new CustomEvent('zc:remote-claim-updated', { detail }));
    } catch {}

    try {
      document.dispatchEvent(new CustomEvent('ws:atendimento_claim_updated', { detail }));
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
  if (isNavigatingAway()) return;
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

  try {
    closeCoreEmpresaWS(EMPRESA_ID);
  } catch {}

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
    if (isNavigatingAway()) {
      try { clearWsPendingWork('boot-navigating-away'); } catch {}
      return;
    }
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

  if (!window.__ZC_WS_NAV_AWAY_BOUND__) {
    window.__ZC_WS_NAV_AWAY_BOUND__ = true;

    window.addEventListener('zc:navigate-away', () => {
      try { markWsNavigatingAway('zc:navigate-away'); } catch {}
    });

    window.addEventListener('pagehide', () => {
      try { markWsNavigatingAway('pagehide'); } catch {}
    });
  }

  if (!window.__ZC_WS_BEFOREUNLOAD_BOUND__) {
    window.__ZC_WS_BEFOREUNLOAD_BOUND__ = true;

    window.addEventListener('beforeunload', () => {
      try { markWsNavigatingAway('beforeunload'); } catch {}

      try {
        disconnectInstWS();
      } catch {}

      try {
        disconnectEmpresaWS();
      } catch {}
    });
  }
} catch {}

try {
  window.zcForceUnreadBadgeDom = forceUnreadBadgeDom;
  window.zcScheduleForceUnreadBadgeDom = scheduleForceUnreadBadgeDom;
  window.zcAtendimentoWsMarkNavigatingAway = markWsNavigatingAway;
  window.zcAtendimentoWsClearPendingWork = clearWsPendingWork;
} catch {}

export {
  connectEmpresaWS,
  disconnectEmpresaWS,
  connectInstWS,
  disconnectInstWS,
};