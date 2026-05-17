// /frontend/js/atendimentos/ui/header-actions/conversation.js
// Helpers de conversa do header-actions
// - conversation_key
// - tipo da conversa: cliente/grupo
// - cliente/grupo selecionado
// - instância da conversa
// - número/JID para API
// - payloads de identidade para envio/ações

(function () {
  'use strict';

  const H = window.ZCHeaderActions;

  if (!H || !H.__coreReady) {
    console.warn('[header-actions][conversation] core.js precisa ser carregado antes.');
    return;
  }

  if (H.__conversationReady) return;
  H.__conversationReady = true;

  const {
    $,
    idKey,
    instKey,
    onlyDigits,
    isJid,
    stripUndefined,
    cleanText,
    historyEl,
  } = H;

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

  function buildConversationKey(kind, entityId, instId) {
    const k = String(kind || '').toLowerCase() === 'g' ? 'g' : 'c';
    const eid = idKey(entityId);
    const iid = instKey(instId);

    if (!eid) return null;

    return `${k}:${eid}:${iid ?? '0'}`;
  }

  function kindFromObject(obj) {
    if (!obj || typeof obj !== 'object') return 'c';

    const explicit =
      obj.kind ??
      obj.conversation_kind ??
      obj.tipo_conversa ??
      null;

    const e = String(explicit || '').trim().toLowerCase();

    if (e === 'g' || e === 'grupo' || e === 'group') return 'g';
    if (e === 'c' || e === 'cliente' || e === 'contato') return 'c';

    if (
      obj.is_group === true ||
      obj.grupo === true ||
      obj.isGroup === true ||
      obj.grupo_id != null
    ) {
      return 'g';
    }

    return 'c';
  }

  function entityIdFromAny(raw, row = null) {
    const parsed = parseConversationKey(raw);
    if (parsed?.entityId) return parsed.entityId;

    if (row && typeof row === 'object') {
      const direct =
        row.entity_id ??
        row.backend_id ??
        row.api_id ??
        (kindFromObject(row) === 'g' ? row.grupo_id : row.cliente_id) ??
        row.id_backend ??
        null;

      const d = idKey(direct);

      if (d && /^\d+$/.test(d)) {
        return d;
      }
    }

    const s = idKey(raw);

    if (s && /^\d+$/.test(s)) {
      return s;
    }

    return null;
  }

  function instIdFromAny(raw, row = null) {
    const parsed = parseConversationKey(raw);
    if (parsed?.instId) return parsed.instId;

    if (row && typeof row === 'object') {
      return (
        instKey(row.instancia_id) ||
        instKey(row.instancia) ||
        instKey(row.instance_name) ||
        instKey(row.instance) ||
        null
      );
    }

    return null;
  }

  function conversationRefOf(raw, row = null) {
    if (raw && typeof raw === 'object') {
      const obj = raw;

      const directRaw =
        obj.conversation_key ??
        obj.conversation_id ??
        obj.id ??
        null;

      const parsedDirect = parseConversationKey(directRaw);
      if (parsedDirect) return parsedDirect;

      const kind = kindFromObject(obj);
      const entityId = entityIdFromAny(directRaw, obj);
      const instId = instIdFromAny(directRaw, obj);

      const built = buildConversationKey(kind, entityId, instId) || idKey(directRaw);
      const parsedBuilt = parseConversationKey(built);

      return parsedBuilt || {
        key: built,
        kind,
        entityId,
        instId,
      };
    }

    const parsed = parseConversationKey(raw);
    if (parsed) return parsed;

    const kind = row && typeof row === 'object' ? kindFromObject(row) : 'c';
    const entityId = entityIdFromAny(raw, row);
    const instId = instIdFromAny(raw, row);

    const built = buildConversationKey(kind, entityId, instId) || idKey(raw);

    return parseConversationKey(built) || {
      key: built,
      kind,
      entityId,
      instId,
    };
  }

  function sameConversation(a, b) {
    const A = conversationRefOf(a, typeof a === 'object' ? a : null);
    const B = conversationRefOf(b, typeof b === 'object' ? b : null);

    if (A?.key && B?.key) {
      return A.key === B.key;
    }

    if (!A?.entityId || !B?.entityId) {
      return false;
    }

    return (
      (A.kind || 'c') === (B.kind || 'c') &&
      A.entityId === B.entityId &&
      String(A.instId || '') === String(B.instId || '')
    );
  }

  function resolveCurrentClienteId() {
    const hist = historyEl();
    const sel = window.state?.clienteSel || window.clienteSel || null;

    const candidates = [
      hist?.dataset?.clienteId,
      hist?.dataset?.entityId,
      hist?.dataset?.id,
      sel?.id,
      sel?.cliente_id,
      sel?.backend_id,
      sel?.entity_id,
      sel?.conversation_id,
      window.CLIENTE_ID_ATUAL,
      window.currentClienteId,
      window.__perfilClienteIdAtual,
    ];

    for (const v of candidates) {
      const n = Number(v);

      if (Number.isFinite(n) && n > 0) {
        return n;
      }
    }

    return 0;
  }

  function hasOpenChat() {
    return resolveCurrentClienteId() > 0;
  }

  function currentChatTitle() {
    return (
      $('#chat-title')?.textContent?.trim() ||
      $('#chat-header .title')?.textContent?.trim() ||
      $('#chatTitle')?.textContent?.trim() ||
      $('[data-role="chat-title"]')?.textContent?.trim() ||
      $('.chat-title')?.textContent?.trim() ||
      'conversa'
    );
  }

  function getSelectedConversationKey() {
    const hist = historyEl();
    const sel = window.state?.clienteSel || window.clienteSel || null;

    const raw =
      idKey(hist?.dataset?.conversationKey) ||
      idKey(hist?.dataset?.clienteId) ||
      idKey(sel?.conversation_key) ||
      idKey(sel?.conversation_id) ||
      idKey(sel?.id) ||
      null;

    return conversationRefOf(raw, sel).key || null;
  }

  function getConversationPools() {
    return [
      ...(Array.isArray(window.state?.clientesCache) ? window.state.clientesCache : []),
      ...(Array.isArray(window.state?.todosContatosCache) ? window.state.todosContatosCache : []),
      ...(window.state?.clienteSel ? [window.state.clienteSel] : []),
      ...(window.clienteSel ? [window.clienteSel] : []),
    ].filter(Boolean);
  }

  function getConversationByRef(conversationRef = null) {
    const targetKey = conversationRefOf(
      conversationRef ?? getSelectedConversationKey(),
      window.state?.clienteSel || null
    ).key;

    if (!targetKey) return null;

    return getConversationPools().find((x) => sameConversation(x, targetKey)) || null;
  }

  function resolveRawTel(cli) {
    if (!cli) return '';

    if (cli.telefone) return cli.telefone;
    if (cli.whatsapp) return cli.whatsapp;
    if (cli.numero) return cli.numero;
    if (cli.number) return cli.number;
    if (cli.remote_jid) return String(cli.remote_jid);
    if (cli.remoteJid) return String(cli.remoteJid);
    if (cli.jid) return String(cli.jid);
    if (cli.telefone_norm) return cli.telefone_norm;

    return '';
  }

  function toE164(raw) {
    if (!raw) return '';

    if (isJid(raw)) {
      return String(raw).trim();
    }

    const d = onlyDigits(raw);

    if (!d) return '';

    if (d.startsWith('55') && d.length >= 12) {
      return d;
    }

    if (d.length === 10 || d.length === 11) {
      return `55${d}`;
    }

    return d;
  }

  function numberForApi(conversationRef = null) {
    const cli = getConversationByRef(conversationRef);
    const raw = String(resolveRawTel(cli) || '').trim();

    if (!raw) return '';

    if (isJid(raw)) {
      return raw;
    }

    return toE164(raw);
  }

  function getInstanciaAtivaGlobal() {
    return instKey(
      window.getInstanciaAtiva?.() ??
      window.INSTANCIA_ATIVA ??
      null
    );
  }

  function getConversationInstancia(conversationRef = null) {
    const cli = getConversationByRef(conversationRef);
    const ref = conversationRefOf(cli || conversationRef, cli || null);

    return (
      instKey(cli?.instancia_id) ||
      instKey(cli?.instancia) ||
      instKey(cli?.instance_name) ||
      ref.instId ||
      null
    );
  }

  function getInstPayload(conversationRef = null) {
    const inst =
      getConversationInstancia(conversationRef) ||
      getInstanciaAtivaGlobal();

    if (!inst) return {};

    const n = Number(inst);

    if (Number.isFinite(n) && String(n) === String(inst)) {
      return { instancia_id: n };
    }

    return { instance: String(inst) };
  }

  function getIdentityPayload(conversationRef = null) {
    const cli =
      typeof conversationRef === 'object' && conversationRef
        ? conversationRef
        : getConversationByRef(conversationRef);

    const ref = conversationRefOf(conversationRef || cli, cli);

    return stripUndefined({
      conversation_key: ref.key || undefined,
      cliente_id: ref.kind === 'c' ? ref.entityId : undefined,
      grupo_id: ref.kind === 'g' ? ref.entityId : undefined,
    });
  }

  function getCurrentInstanceText() {
    const status = cleanText($('#status-bateria'));
    if (status) return status;

    const current = cleanText($('#zc-inst-current-label'));
    if (current) return `WhatsApp: ${current}`;

    const activeInst =
      $('#inst-switch .is-active') ||
      $('#inst-switch .ativo') ||
      $('#inst-switch .active') ||
      $('#inst-switch [aria-current="true"]') ||
      $('#inst-switch [aria-selected="true"]');

    const activeText = cleanText(activeInst);
    if (activeText) return `WhatsApp: ${activeText}`;

    return 'WhatsApp atual';
  }

  H.extend({
    parseConversationKey,
    buildConversationKey,
    kindFromObject,
    entityIdFromAny,
    instIdFromAny,
    conversationRefOf,
    sameConversation,
    resolveCurrentClienteId,
    hasOpenChat,
    currentChatTitle,
    getSelectedConversationKey,
    getConversationPools,
    getConversationByRef,
    resolveRawTel,
    toE164,
    numberForApi,
    getInstanciaAtivaGlobal,
    getConversationInstancia,
    getInstPayload,
    getIdentityPayload,
    getCurrentInstanceText,
  });

  console.log('[header-actions] conversation carregado');
})();