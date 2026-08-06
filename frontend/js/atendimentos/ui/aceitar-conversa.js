// /frontend/js/atendimentos/ui/aceitar-conversa.js
(function () {
  if (window.__zcAceitarConversaLoaded) return;
  window.__zcAceitarConversaLoaded = true;

  const BTN_ACEITAR_ID = "btnAceitarConversa";
  const BTN_LIBERAR_ID = "btnLiberarConversa";
  const BTN_TRANSFERIR_ID = "btnTransferirColaborador";
  const MODAL_ID = "zcTransferirColaboradorModal";

  /*
    Correção principal:
    - Não mostra mais "Carregando estado da conversa..."
    - Busca /meta em silêncio
    - Só mostra barra se a conversa realmente exigir aceite
    - Debounce + cache curto para não bater no backend toda hora
  */
  const META_CACHE_TTL_MS = Number(window.ZC_META_CACHE_TTL_MS || 30000);
  const META_FETCH_TIMEOUT_MS = Number(window.ZC_META_FETCH_TIMEOUT_MS || 2500);
  const REFRESH_DEBOUNCE_MS = 180;
  // Após o backend confirmar Atender/Liberar/Transferir, preserva o estado
  // retornado pela própria ação. Isso impede que um GET /meta ou o eco do
  // WebSocket, iniciado logo em seguida, recoloque na tela o estado anterior.
  const OPTIMISTIC_MUTATION_HOLD_MS = Number(
    window.ZC_CLAIM_OPTIMISTIC_HOLD_MS || 12000
  );

  let __refreshTimer = null;
  let __lastRenderedConversationKey = "";
  let __refreshSerial = 0;
  let __zcMetaLeaving = false;
  const __metaInFlightByKey = new Map();
  const __metaAbortByKey = new Map();

  /*
    Controle de concorrência do /meta.

    Sem isso, uma consulta iniciada antes de Atender/Liberar podia terminar
    depois da ação e sobrescrever o cache com o estado antigo. O resultado
    visual era a barra continuar em "Atendimento com você" até F5.
  */
  const __metaRequestVersionByKey = new Map();
  const __metaMutationVersionByKey = new Map();

  function isAtendimentoLeaving() {
    try {
      return Boolean(
        __zcMetaLeaving === true ||
        window.__ZC_ATENDIMENTOS_NAVIGATING_AWAY__ === true ||
        window.__ZC_APP_NAVIGATING_AWAY__ === true ||
        document.body?.dataset?.zcLeaving === "1" ||
        document.documentElement?.dataset?.zcLeaving === "1"
      );
    } catch {
      return false;
    }
  }

  function abortMetaRequests(reason = "abort-meta") {
    __zcMetaLeaving = true;
    try { if (__refreshTimer) clearTimeout(__refreshTimer); } catch {}
    __refreshTimer = null;
    try { __refreshSerial++; } catch {}
    try {
      for (const ctrl of __metaAbortByKey.values()) {
        try { ctrl.abort(reason); } catch {}
      }
      __metaAbortByKey.clear();
    } catch {}
    try { __metaInFlightByKey.clear(); } catch {}
    try { __metaRequestVersionByKey.clear(); } catch {}
    try { __metaMutationVersionByKey.clear(); } catch {}
  }

  try {
    window.zcAbortConversationMetaRequests = abortMetaRequests;
    window.addEventListener("zc:navigate-away", () => abortMetaRequests("zc:navigate-away"), true);
    window.addEventListener("pagehide", () => abortMetaRequests("pagehide"), true);
    window.addEventListener("beforeunload", () => abortMetaRequests("beforeunload"), true);
  } catch {}

  function toInt(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function parseJwt(token) {
    try {
      const payload = String(token || "").split(".")[1];
      if (!payload) return null;

      const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(base64));
    } catch {
      return null;
    }
  }

  function getEmpresaId() {
    return (
      toInt(window.empresa_id) ||
      toInt(window.EMPRESA_ID) ||
      toInt(window.__EMPRESA_ID__) ||
      toInt(localStorage.getItem("empresa_id")) ||
      toInt(localStorage.getItem("EMPRESA_ID")) ||
      toInt(document.body?.dataset?.empresaId) ||
      toInt(document.documentElement?.dataset?.empresaId) ||
      null
    );
  }

  function getIdentityJwt() {
    const token =
      localStorage.getItem("access_token") ||
      localStorage.getItem("token") ||
      localStorage.getItem("auth_token") ||
      "";

    return parseJwt(token) || {};
  }

  function getCurrentColabId() {
    const jwt = getIdentityJwt();

    for (const key of ["id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"]) {
      const val =
        toInt(jwt[key]) ||
        toInt(localStorage.getItem(key));

      if (val) return val;
    }

    const sub = String(jwt.sub || "").trim().toLowerCase();
    if (sub.startsWith("colab-")) {
      const rest = sub.slice("colab-".length);
      const val = toInt(rest);
      if (val) return val;
    }

    return null;
  }

  function parseConversationRef(raw) {
    const s = String(raw || "").trim();
    const m = s.match(/^([cg]):(\d+):(\d+)$/i);
    if (!m) return null;

    return {
      kind: m[1].toLowerCase() === "g" ? "grupo" : "cliente",
      id: Number(m[2]),
      instancia_id: Number(m[3]) || null,
      is_group: m[1].toLowerCase() === "g",
      conversation_id: s,
      conversation_key: s
    };
  }

  function buildConversationKey(conv) {
    if (!conv) return "";

    const raw =
      conv.conversation_key ||
      conv.conversation_id ||
      "";

    const parsed = parseConversationRef(raw);
    if (parsed) return parsed.conversation_key;

    const id =
      toInt(conv.id) ||
      toInt(conv.cliente_id) ||
      toInt(conv.grupo_id) ||
      toInt(conv.entity_id);

    if (!id) return "";

    const isGroup =
      Boolean(conv.is_group) ||
      String(conv.kind || "").toLowerCase() === "g" ||
      String(conv.kind || "").toLowerCase() === "grupo";

    const instId = toInt(conv.instancia_id) || 0;

    return `${isGroup ? "g" : "c"}:${id}:${instId}`;
  }

  function getCurrentConversation() {
    const historico = document.getElementById("historico");

    const historicoRaw =
      historico?.dataset?.conversationId ||
      historico?.dataset?.conversationKey ||
      historico?.dataset?.convKey ||
      historico?.dataset?.chatKey ||
      "";

    const parsedHistorico = parseConversationRef(historicoRaw);
    if (parsedHistorico) return parsedHistorico;

    const hClienteId =
      toInt(historico?.dataset?.clienteId) ||
      toInt(historico?.dataset?.entityId);

    const hInstanciaId = toInt(historico?.dataset?.instanciaId);

    if (hClienteId) {
      const hIsGroup =
        String(historico?.dataset?.kind || "").toLowerCase() === "g" ||
        String(historico?.dataset?.isGroup || "").toLowerCase() === "true";

      return {
        kind: hIsGroup ? "grupo" : "cliente",
        id: hClienteId,
        instancia_id: hInstanciaId,
        is_group: hIsGroup,
        conversation_id: `${hIsGroup ? "g" : "c"}:${hClienteId}:${hInstanciaId || 0}`,
        conversation_key: `${hIsGroup ? "g" : "c"}:${hClienteId}:${hInstanciaId || 0}`
      };
    }

    const activeItem =
      document.querySelector("[data-conversation-id].active") ||
      document.querySelector("[data-conversation-key].active") ||
      document.querySelector(".cliente-item.active") ||
      document.querySelector(".chat-item.active") ||
      document.querySelector(".conversa-item.active") ||
      document.querySelector("#lista-clientes .active");

    if (activeItem) {
      const raw =
        activeItem.dataset.conversationId ||
        activeItem.dataset.conversationKey ||
        activeItem.dataset.convKey ||
        activeItem.dataset.chatKey ||
        "";

      const parsed = parseConversationRef(raw);
      if (parsed) return parsed;

      const clienteId =
        toInt(activeItem.dataset.clienteId) ||
        toInt(activeItem.dataset.entityId) ||
        toInt(activeItem.dataset.id);

      const instanciaId = toInt(activeItem.dataset.instanciaId);

      const isGroup =
        String(activeItem.dataset.isGroup || "").toLowerCase() === "true" ||
        String(activeItem.dataset.kind || "").toLowerCase() === "g";

      if (clienteId) {
        return {
          kind: isGroup ? "grupo" : "cliente",
          id: clienteId,
          instancia_id: instanciaId,
          is_group: isGroup,
          conversation_id: `${isGroup ? "g" : "c"}:${clienteId}:${instanciaId || 0}`,
          conversation_key: `${isGroup ? "g" : "c"}:${clienteId}:${instanciaId || 0}`
        };
      }
    }

    if (window.__zcCurrentConversation) {
      const raw =
        window.__zcCurrentConversation.conversation_key ||
        window.__zcCurrentConversation.conversation_id ||
        "";

      const parsed = parseConversationRef(raw);
      if (parsed) return parsed;

      const key = buildConversationKey(window.__zcCurrentConversation);
      const parsedKey = parseConversationRef(key);
      if (parsedKey) return parsedKey;
    }

    return null;
  }

  function showToast(message, kind = "success") {
    if (typeof window.showToast === "function") {
      window.showToast(message, kind);
      return;
    }

    if (typeof window.toast === "function") {
      window.toast(message, kind);
      return;
    }

    console.log(`[${kind}] ${message}`);
  }

  async function fetchJSON(url, options = {}) {
    const { timeoutMs = 0, controller = null, headers = {}, ...fetchOptions } = options || {};
    const ctrl = controller || (timeoutMs ? new AbortController() : null);
    let timeout = 0;

    if (timeoutMs && ctrl) {
      timeout = setTimeout(() => {
        try { ctrl.abort("fetch-timeout"); } catch {}
      }, Math.max(500, Number(timeoutMs) || 0));
    }

    let res;
    try {
      res = await fetch(url, {
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(headers || {})
        },
        ...fetchOptions,
        ...(ctrl ? { signal: ctrl.signal } : {})
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    const text = await res.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text || null;
    }

    if (!res.ok) {
      const msg =
        (data && data.detail && data.detail.message) ||
        (data && data.detail) ||
        (data && data.message) ||
        `HTTP ${res.status}`;

      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }

    return data;
  }

  function ensureClaimActionButtons() {
    const bar = document.getElementById("zc-claim-bar");
    if (!bar) return;

    let actions = bar.querySelector(".zc-claim-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "zc-claim-actions";
      const card = bar.querySelector(".zc-claim-card") || bar;
      card.appendChild(actions);
    }

    function makeButton(id, text, title) {
      let btn = document.getElementById(id);
      if (btn) return btn;

      btn = document.createElement("button");
      btn.id = id;
      btn.type = "button";
      btn.className = "hdr-pill-btn";
      btn.title = title || text;
      btn.setAttribute("aria-label", title || text);
      btn.hidden = true;

      const span = document.createElement("span");
      span.className = "hdr-pill-btn-text";
      span.textContent = text;
      btn.appendChild(span);

      return btn;
    }

    const aceitar = makeButton(BTN_ACEITAR_ID, "Atender", "Atender conversa");
    const liberar = makeButton(BTN_LIBERAR_ID, "Liberar", "Liberar atendimento");
    const transferir = makeButton(BTN_TRANSFERIR_ID, "Transferir", "Transferir atendimento");

    if (!aceitar.parentElement) actions.appendChild(aceitar);
    if (!liberar.parentElement) {
      if (aceitar.parentElement === actions && aceitar.nextSibling) {
        actions.insertBefore(liberar, aceitar.nextSibling);
      } else {
        actions.appendChild(liberar);
      }
    }
    if (!transferir.parentElement) actions.appendChild(transferir);
  }

  function getButtons() {
    ensureClaimActionButtons();

    return {
      aceitar: document.getElementById(BTN_ACEITAR_ID),
      liberar: document.getElementById(BTN_LIBERAR_ID),
      transferir: document.getElementById(BTN_TRANSFERIR_ID)
    };
  }

  function getClaimEls() {
    return {
      footer: document.getElementById("chat-footer"),
      bar: document.getElementById("zc-claim-bar"),
      title: document.getElementById("zc-claim-title"),
      subtitle: document.getElementById("zc-claim-subtitle")
    };
  }

  function setBtnText(btn, text) {
    if (!btn || text == null) return;

    const span = btn.querySelector(".hdr-pill-btn-text");
    if (span) {
      span.textContent = text;
      return;
    }

    btn.textContent = text;
  }

  function setBtnIcon(btn, icon) {
    if (!btn || !icon) return;

    const iconEl = btn.querySelector("i");
    if (iconEl) iconEl.className = icon;
  }

  function setBtnBase(
    btn,
    {
      text,
      icon,
      title,
      disabled = false,
      hidden = false,
      accepted = false,
      busy = false
    } = {}
  ) {
    if (!btn) return;

    btn.hidden = !!hidden;
    btn.disabled = !!disabled;
    btn.title = title || text || "";
    btn.setAttribute("aria-label", title || text || "");
    btn.classList.toggle("is-accepted", !!accepted);
    btn.classList.toggle("is-busy", !!busy);

    setBtnText(btn, text);
    setBtnIcon(btn, icon);
  }

  function setClaimBarState({
    open = false,
    locked = false,
    accepted = false,
    busy = false,
    canAccept = false,
    canRelease = false,
    canTransfer = false,
    title = "",
    subtitle = ""
  } = {}) {
    const { footer, bar, title: titleEl, subtitle: subtitleEl } = getClaimEls();

    if (!bar || !footer) return;

    if (!open) {
      bar.hidden = true;
      bar.classList.remove("is-open", "is-locked", "is-accepted", "is-busy", "is-can-accept", "is-can-release", "is-can-transfer");
      bar.dataset.canAccept = "0";
      bar.dataset.podeAceitar = "0";
      bar.dataset.podeLiberar = "0";
      bar.dataset.podeTransferir = "0";
      bar.dataset.aceitaPorMim = "0";
      bar.dataset.exigirAceite = "0";
      footer.dataset.sendLocked = "0";
      footer.dataset.podeLiberar = "0";
      footer.dataset.aceitaPorMim = "0";
      footer.dataset.exigirAceite = "0";
      return;
    }

    bar.hidden = false;
    bar.classList.add("is-open");
    bar.classList.toggle("is-locked", !!locked);
    bar.classList.toggle("is-accepted", !!accepted);
    bar.classList.toggle("is-busy", !!busy);
    bar.classList.toggle("is-can-accept", !!canAccept);
    bar.classList.toggle("is-can-release", !!canRelease);
    bar.classList.toggle("is-can-transfer", !!canTransfer);
    bar.dataset.canAccept = canAccept ? "1" : "0";
    bar.dataset.podeAceitar = canAccept ? "1" : "0";
    bar.dataset.podeLiberar = canRelease ? "1" : "0";
    bar.dataset.canRelease = canRelease ? "1" : "0";
    bar.dataset.podeTransferir = canTransfer ? "1" : "0";
    bar.dataset.aceitaPorMim = accepted ? "1" : "0";
    bar.dataset.acceptedByMe = accepted ? "1" : "0";
    bar.dataset.exigirAceite = "1";
    footer.dataset.podeLiberar = canRelease ? "1" : "0";
    footer.dataset.canRelease = canRelease ? "1" : "0";
    footer.dataset.aceitaPorMim = accepted ? "1" : "0";
    footer.dataset.acceptedByMe = accepted ? "1" : "0";
    footer.dataset.exigirAceite = "1";

    if (titleEl && title != null) titleEl.textContent = title;
    if (subtitleEl && subtitle != null) subtitleEl.textContent = subtitle;

    footer.dataset.sendLocked = locked || busy ? "1" : "0";
  }

  function hideAllButtons() {
    const { aceitar, liberar, transferir } = getButtons();

    [aceitar, liberar, transferir].forEach((btn) => {
      if (!btn) return;

      btn.hidden = true;
      btn.disabled = true;
      btn.classList.remove("is-accepted", "is-busy");
    });
  }

  function hideClaimUi() {
    hideAllButtons();

    setClaimBarState({
      open: false,
      locked: false,
      accepted: false,
      busy: false
    });
  }

  function metaRequiresAcceptance(meta) {
    return Boolean(
      meta?.exigir_aceite === true ||
      meta?.aceite_obrigatorio === true ||
      meta?.fila_exigir_aceite === true ||
      meta?.aguardando_aceite === true
    );
  }

  function metaCanRespond(meta) {
    if (!meta) return true;

    if (meta.pode_responder === false) return false;
    if (meta.can_send === false) return false;
    if (meta.locked === true) return false;

    return true;
  }


  function isDepartmentClaim(meta) {
    const depId =
      toInt(meta?.departamento_id) ||
      toInt(meta?.atendimento_departamento_id) ||
      toInt(meta?.cliente_departamento_id) ||
      toInt(meta?.departamento?.id);

    return Boolean(
      meta?.claim_mode === "departamento" ||
      meta?.departamento_claim === true ||
      meta?.tipo_aceite === "departamento" ||
      (depId && (meta?.aguardando_aceite === true || meta?.pode_aceitar === true || meta?.can_accept === true))
    );
  }

  function claimWords(meta) {
    const dep = isDepartmentClaim(meta);

    return dep
      ? {
          accept: "Atender",
          accepting: "Atendendo...",
          accepted: "Atendimento assumido",
          acceptedByYou: "Atendimento com você",
          acceptTitle: "Atender conversa",
          waitingTitle: "Atenda para responder",
          waitingSubtitle: "Clique em Atender para assumir este atendimento.",
          acceptedSubtitle: "Agora você pode responder normalmente.",
          otherTitle: "Atendimento em andamento",
          otherSubtitle: "Você pode participar sem alterar o responsável principal.",
          success: "Atendimento assumido com sucesso.",
          joined: "Você entrou no atendimento para colaborar.",
          already: "Você já participa deste atendimento."
        }
      : {
          accept: "Aceitar",
          accepting: "Aceitando...",
          accepted: "Aceita",
          acceptedByYou: "Conversa aceita por você",
          acceptTitle: "Aceitar conversa",
          waitingTitle: "Aceite a conversa para responder",
          waitingSubtitle: "Enquanto você não aceitar, o envio fica bloqueado.",
          acceptedSubtitle: "Agora você já pode responder normalmente.",
          otherTitle: "Conversa em atendimento",
          otherSubtitle: "Você pode participar da conversa junto com o responsável atual.",
          success: "Conversa aceita com sucesso.",
          joined: "Você entrou na conversa para colaborar.",
          already: "Você já participa desta conversa."
        };
  }

  async function fetchMeta(conv) {
    const empresaId = getEmpresaId();

    if (isAtendimentoLeaving()) return null;
    if (!empresaId || !conv || conv.is_group) return null;

    const key = buildConversationKey(conv) || String(conv.id || "");
    const url = new URL(`/api/atendimento/conversas/${conv.id}/meta`, window.location.origin);
    url.searchParams.set("empresa_id", String(empresaId));

    if (conv.instancia_id) {
      url.searchParams.set("instancia_id", String(conv.instancia_id));
    }

    const ctrl = new AbortController();
    if (key) __metaAbortByKey.set(key, ctrl);

    try {
      return await fetchJSON(url.toString(), {
        controller: ctrl,
        timeoutMs: META_FETCH_TIMEOUT_MS,
      });
    } finally {
      if (key && __metaAbortByKey.get(key) === ctrl) {
        __metaAbortByKey.delete(key);
      }
    }
  }

  function getMetaCache() {
    if (!window.__zcConversationMetaCache || typeof window.__zcConversationMetaCache !== "object") {
      window.__zcConversationMetaCache = {};
    }

    return window.__zcConversationMetaCache;
  }

  function resolveMetaKey(convOrKey) {
    if (typeof convOrKey === "string") {
      return String(convOrKey || "").trim();
    }

    if (!convOrKey || typeof convOrKey !== "object") {
      return "";
    }

    return String(
      convOrKey.conversation_key ||
      convOrKey.conversation_id ||
      buildConversationKey(convOrKey) ||
      ""
    ).trim();
  }

  function markOptimisticMutation(meta, action) {
    if (!meta || typeof meta !== "object") return meta;

    const now = Date.now();
    meta._mutation_action = String(action || "claim-action");
    meta._mutation_confirmed_at = now;
    meta._mutation_hold_until = now + Math.max(1000, OPTIMISTIC_MUTATION_HOLD_MS);
    return meta;
  }

  function hasActiveOptimisticMutation(meta) {
    if (!meta || typeof meta !== "object") return false;

    const until = Number(meta._mutation_hold_until || 0);
    if (!Number.isFinite(until) || until <= Date.now()) {
      return false;
    }

    return true;
  }

  function abortMetaRequestForKey(key, reason = "meta-invalidated") {
    if (!key) return;

    const ctrl = __metaAbortByKey.get(key);
    if (ctrl) {
      try { ctrl.abort(reason); } catch {}
    }

    __metaAbortByKey.delete(key);
    __metaInFlightByKey.delete(key);
  }

  function invalidateMetaCache(convOrKey, options = {}) {
    const key = resolveMetaKey(convOrKey);
    if (!key) return "";

    const {
      abort = true,
      bumpMutation = true,
      removeCache = true,
      reason = "meta-invalidated"
    } = options;

    if (bumpMutation) {
      const next = Number(__metaMutationVersionByKey.get(key) || 0) + 1;
      __metaMutationVersionByKey.set(key, next);
    }

    // Invalida resultados de requisições que já estavam em andamento.
    const nextRequestVersion = Number(__metaRequestVersionByKey.get(key) || 0) + 1;
    __metaRequestVersionByKey.set(key, nextRequestVersion);

    if (abort) {
      abortMetaRequestForKey(key, reason);
    }

    if (removeCache) {
      try { delete getMetaCache()[key]; } catch {}
    }

    return key;
  }

  // Disponível para módulos de realtime e diagnóstico, sem alterar o backend.
  window.zcInvalidateConversationMeta = function (convOrKey, options = {}) {
    return invalidateMetaCache(convOrKey, options);
  };

  function normalizeMetaForComposer(conv, meta) {
    const conversation_key = buildConversationKey(conv);

    if (!conv || conv.is_group) {
      return {
        conversation_key,
        conversation_id: conversation_key,
        cliente_id: conv?.id || null,
        instancia_id: conv?.instancia_id || null,
        is_group: true,
        can_send: true,
        can_accept: false,
        accepted_by_me: true,
        accepted_by_anyone: false,
        pode_aceitar: false,
        pode_liberar: false,
        aceita_por_mim: true,
        exigir_aceite: false,
        aceite_obrigatorio: false,
        aguardando_aceite: false,
        raw: meta || null
      };
    }

    const exigirAceite = metaRequiresAcceptance(meta);
    const podeResponder = metaCanRespond(meta);

    const operadorId =
      toInt(meta?.responsavel_id) ??
      toInt(meta?.operador_id);

    const currentColabId = getCurrentColabId();

    const acceptedByMe = Boolean(
      meta?.aceita_por_mim ??
      meta?.accepted_by_me ??
      (operadorId && currentColabId && operadorId === currentColabId)
    );

    const acceptedByAnyone = Boolean(
      meta?.accepted_by_anyone ??
      meta?.tem_participantes ??
      (Array.isArray(meta?.participantes) && meta.participantes.length > 0) ??
      operadorId
    );

    const adminCanIntervene = Boolean(meta?.admin_can_intervene === true);
    const adminIntervening = Boolean(
      adminCanIntervene &&
      meta?.admin_intervening === true &&
      operadorId &&
      !acceptedByMe
    );

    const canAccept = Boolean(
      exigirAceite &&
      (
        meta?.pode_aceitar ??
        meta?.can_accept ??
        !acceptedByMe
      )
    );

    const canSend = adminIntervening
      ? Boolean(podeResponder)
      : (exigirAceite ? Boolean(podeResponder && acceptedByMe) : Boolean(podeResponder));

    const canRelease = Boolean(
      exigirAceite &&
      (
        meta?.pode_liberar ??
        meta?.can_release ??
        acceptedByMe
      )
    );

    const canTransferDepartment = Boolean(
      exigirAceite &&
      (
        meta?.pode_transferir_departamento ??
        meta?.can_transfer_department ??
        (isDepartmentClaim(meta) && (canAccept || acceptedByMe || adminIntervening))
      )
    );

    const canTransferCollaborator = Boolean(
      exigirAceite &&
      (
        meta?.pode_transferir_colaborador ??
        meta?.can_transfer_collaborator ??
        meta?.pode_transferir ??
        meta?.can_transfer ??
        (acceptedByMe || adminIntervening)
      )
    );

    return {
      conversation_key,
      conversation_id: conversation_key,
      cliente_id: conv.id,
      instancia_id: conv.instancia_id || null,
      is_group: false,

      can_send: canSend,
      can_accept: canAccept,
      accepted_by_me: exigirAceite ? acceptedByMe : false,
      accepted_by_anyone: exigirAceite ? acceptedByAnyone : false,

      pode_aceitar: canAccept,
      pode_liberar: canRelease,
      pode_responder: canSend,
      pode_transferir_departamento: canTransferDepartment,
      can_transfer_department: canTransferDepartment,
      pode_transferir_colaborador: canTransferCollaborator,
      can_transfer_collaborator: canTransferCollaborator,
      pode_transferir: canTransferCollaborator,
      can_transfer: canTransferCollaborator,
      aceita_por_mim: exigirAceite ? acceptedByMe : false,

      operador_id: operadorId,
      responsavel_id: operadorId,
      operador_nome: meta?.operador_nome || meta?.responsavel_nome || null,
      responsavel_nome: meta?.responsavel_nome || meta?.operador_nome || null,

      exigir_aceite: exigirAceite,
      aceite_obrigatorio: exigirAceite,
      aguardando_aceite: Boolean(exigirAceite && meta?.aguardando_aceite),

      fila_id: meta?.fila_id ?? null,
      fila_nome: meta?.fila_nome ?? null,
      fila_exigir_aceite: Boolean(meta?.fila_exigir_aceite),

      claim_mode: meta?.claim_mode || null,
      departamento_claim: Boolean(meta?.departamento_claim),
      admin_can_intervene: adminCanIntervene,
      admin_intervening: adminIntervening,

      raw: meta || null
    };
  }

  function saveMetaCache(conv, meta) {
    if (!conv) return null;

    const normalized = normalizeMetaForComposer(conv, meta);
    const cache = getMetaCache();

    normalized._cached_at = Date.now();
    cache[normalized.conversation_key] = normalized;

    return normalized;
  }

  async function fetchAndCacheMeta(conv, { force = false } = {}) {
    if (!conv || conv.is_group) return null;

    const key = buildConversationKey(conv);
    if (!key) return null;

    const cache = getMetaCache();
    const cached = cache[key];

    if (isAtendimentoLeaving()) {
      return cached || null;
    }

    // A própria resposta do POST é a confirmação mais recente da mutação.
    // Durante uma janela curta, nem force:true pode trocar esse estado por um
    // /meta atrasado ou pelo eco do WebSocket da mesma ação.
    if (hasActiveOptimisticMutation(cached)) {
      return cached;
    }

    // force:true precisa realmente ignorar o TTL e qualquer GET antigo.
    if (!force && cached && cached._cached_at) {
      const age = Date.now() - Number(cached._cached_at || 0);

      if (age >= 0 && age < META_CACHE_TTL_MS) {
        return cached;
      }
    }

    if (!force && __metaInFlightByKey.has(key)) {
      return await __metaInFlightByKey.get(key).catch(() => cache[key] || cached || null);
    }

    if (force) {
      abortMetaRequestForKey(key, "meta-force-refresh");
    }

    const requestVersion = Number(__metaRequestVersionByKey.get(key) || 0) + 1;
    const mutationVersion = Number(__metaMutationVersionByKey.get(key) || 0);
    __metaRequestVersionByKey.set(key, requestVersion);

    const promise = (async () => {
      try {
        const meta = await fetchMeta(conv);
        if (!meta) return cache[key] || cached || null;

        // Uma ação (aceitar/liberar/transferir) aconteceu enquanto este GET
        // estava em andamento: jamais deixa a resposta antiga sobrescrever.
        if (Number(__metaRequestVersionByKey.get(key) || 0) !== requestVersion) {
          return cache[key] || null;
        }

        if (Number(__metaMutationVersionByKey.get(key) || 0) !== mutationVersion) {
          return cache[key] || null;
        }

        const detail = saveMetaCache(conv, meta);
        emitMetaEvents(detail);

        return detail;
      } catch (err) {
        if (err?.name === "AbortError") {
          return cache[key] || null;
        }

        if (cache[key]) return cache[key];
        if (cached) return cached;
        throw err;
      }
    })();

    __metaInFlightByKey.set(key, promise);

    try {
      return await promise;
    } finally {
      if (__metaInFlightByKey.get(key) === promise) {
        __metaInFlightByKey.delete(key);
      }
    }
  }

  function emitMetaEvents(detail) {
    if (!detail) return;

    try {
      window.dispatchEvent(
        new CustomEvent("atendimento:meta", { detail })
      );
    } catch {}

    try {
      window.dispatchEvent(
        new CustomEvent("atendimento:meta-updated", { detail })
      );
    } catch {}

    try {
      window.dispatchEvent(
        new CustomEvent("atendimento:refresh-meta", { detail })
      );
    } catch {}

    try {
      window.dispatchEvent(
        new CustomEvent("zc:claim-updated", { detail })
      );
    } catch {}
  }

  function dispatchLightHistoryRefresh(conv, reason = "claim-action") {
    if (!conv) return;

    const conversationKey = buildConversationKey(conv);
    const detail = {
      conversation_key: conversationKey,
      conversation_id: conversationKey,
      cliente_id: conv.id || null,
      entity_id: conv.id || null,
      instancia_id: conv.instancia_id || null,
      is_group: !!conv.is_group,
      limit: 6,
      reason
    };

    try {
      window.dispatchEvent(new CustomEvent("zc:history-force-refresh", { detail }));
    } catch {}
  }

  function appendSystemEventToHistory(conv, data, reason = "claim-system-event") {
    if (!conv || conv.is_group) return;

    const event = data?.system_event || data?.evento_sistema || null;

    if (!event) {
      // Sem evento novo = normalmente requisição idempotente/duplo clique.
      return;
    }

    const conversationKey = buildConversationKey(conv);
    const detail = {
      ...event,
      conversation_key: conversationKey,
      conversation_id: conversationKey,
      cliente_id: event.cliente_id || conv.id || null,
      entity_id: event.cliente_id || conv.id || null,
      instancia_id: event.instancia_id || conv.instancia_id || null,
      is_group: false,
      reason
    };

    if (typeof window.zcAppendSystemEventToOpenHistory === "function") {
      try {
        window.zcAppendSystemEventToOpenHistory(detail);
        return;
      } catch (err) {
        console.warn("[aceitar-conversa] append system event falhou; usando refresh leve", err);
      }
    }

    dispatchLightHistoryRefresh(conv, reason);
  }

  window.getConversationMeta = function (conversationKey) {
    const key =
      typeof conversationKey === "string"
        ? conversationKey
        : (
            conversationKey?.conversation_key ||
            conversationKey?.conversation_id ||
            buildConversationKey(conversationKey)
          );

    if (!key) return null;

    const cache = getMetaCache();
    return cache[key] || null;
  };

  window.refreshConversationMeta = async function (conversationKey) {
    let conv = null;

    if (typeof conversationKey === "string") {
      conv = parseConversationRef(conversationKey);
    } else if (conversationKey && typeof conversationKey === "object") {
      if (conversationKey.conversation_key || conversationKey.conversation_id) {
        conv =
          parseConversationRef(conversationKey.conversation_key || conversationKey.conversation_id) ||
          conversationKey;
      } else {
        conv = conversationKey;
      }
    }

    if (!conv) {
      conv = getCurrentConversation();
    }

    if (!conv) return null;

    const meta = await fetchAndCacheMeta(conv, { force: true });
    if (!meta) return null;

    renderClaimFromMeta(conv, meta);
    return meta;
  };

  function renderClaimFromMeta(conv, meta) {
    const currentColabId = getCurrentColabId();
    const { aceitar, liberar, transferir } = getButtons();

    if (!conv || conv.is_group || !meta) {
      hideClaimUi();
      return;
    }

    const exigeAceite = metaRequiresAcceptance(meta);
    const words = claimWords(meta);

    /*
      REGRA PRINCIPAL:
      Só mostra barra quando a conversa exige ação:
      - fila com aceite obrigatório; ou
      - atendimento por departamento aguardando alguém clicar em Atender.
    */
    if (!exigeAceite) {
      hideClaimUi();
      return;
    }

    const podeAceitar = Boolean(meta.pode_aceitar || meta.can_accept);
    const podeLiberar = Boolean(meta.pode_liberar || meta.can_release);
    const aceitaPorMim = Boolean(meta.aceita_por_mim || meta.accepted_by_me);

    const operadorId =
      toInt(meta.responsavel_id) ??
      toInt(meta.operador_id);

    const responsavelPorMim = meta.responsavel_por_mim != null
      ? Boolean(meta.responsavel_por_mim)
      : Boolean(operadorId && currentColabId && operadorId === currentColabId);
    const temParticipantes = Boolean(
      meta.accepted_by_anyone ||
      meta.tem_participantes ||
      (Array.isArray(meta.participantes) && meta.participantes.length > 0) ||
      operadorId
    );
    const podeTransferir = Boolean(
      meta.pode_transferir_colaborador ??
      meta.can_transfer_collaborator ??
      meta.pode_transferir ??
      meta.can_transfer ??
      responsavelPorMim
    );

    const operadorNome =
      meta.responsavel_nome ||
      meta.operador_nome ||
      null;

    if (podeAceitar) {
      const depClaim = isDepartmentClaim(meta);
      const joiningExisting = Boolean(temParticipantes || operadorId);
      setBtnBase(aceitar, {
        text: joiningExisting ? "Participar" : (depClaim ? "Atender" : words.accept),
        icon: joiningExisting ? "fa-solid fa-user-plus" : "fa-solid fa-headset",
        title: joiningExisting
          ? "Participar deste atendimento"
          : (depClaim ? "Atender conversa" : words.acceptTitle),
        disabled: false,
        hidden: false
      });

      setBtnBase(liberar, { hidden: true });

      setBtnBase(transferir, {
        text: "Transferir",
        icon: "fa-solid fa-user-arrow-down",
        title: "Transferir para outro colaborador",
        disabled: !podeTransferir,
        hidden: !podeTransferir
      });

      setClaimBarState({
        open: true,
        locked: true,
        accepted: false,
        busy: false,
        canAccept: true,
        canRelease: false,
        canTransfer: podeTransferir,
        title: joiningExisting
          ? (operadorNome ? `Atendimento com ${operadorNome}` : words.otherTitle)
          : words.waitingTitle,
        subtitle: joiningExisting
          ? "Clique em Participar para responder junto sem trocar o responsável principal."
          : words.waitingSubtitle
      });

      return;
    }

    if (
      aceitaPorMim ||
      (operadorId && currentColabId && operadorId === currentColabId)
    ) {
      setBtnBase(aceitar, {
        text: words.accepted,
        icon: "fa-solid fa-circle-check",
        title: words.acceptedByYou,
        disabled: true,
        hidden: true,
        accepted: true
      });

      setBtnBase(liberar, {
        text: responsavelPorMim ? "Liberar" : "Sair",
        icon: responsavelPorMim ? "fa-solid fa-unlock" : "fa-solid fa-right-from-bracket",
        title: responsavelPorMim ? "Sair e liberar/promover outro participante" : "Sair deste atendimento",
        disabled: !podeLiberar,
        hidden: false
      });

      setBtnBase(transferir, {
        text: "Transferir",
        icon: "fa-solid fa-user-arrow-down",
        title: "Transferir para outro colaborador",
        disabled: !podeTransferir,
        hidden: !podeTransferir
      });

      setClaimBarState({
        open: true,
        locked: false,
        accepted: true,
        busy: false,
        canAccept: false,
        canRelease: podeLiberar || aceitaPorMim || (operadorId && currentColabId && operadorId === currentColabId),
        canTransfer: podeTransferir,
        title: responsavelPorMim
          ? words.acceptedByYou
          : (operadorNome ? `Participando com ${operadorNome}` : "Você está participando"),
        subtitle: responsavelPorMim
          ? words.acceptedSubtitle
          : "Você pode responder normalmente. O responsável principal não foi alterado."
      });

      return;
    }

    if (meta.admin_intervening === true && meta.admin_can_intervene === true) {
      setBtnBase(aceitar, {
        text: "Em atendimento",
        icon: "fa-solid fa-user-check",
        title: operadorNome
          ? `Responsável atual: ${operadorNome}`
          : words.otherTitle,
        disabled: true,
        hidden: false
      });

      setBtnBase(liberar, { hidden: true });

      setBtnBase(transferir, {
        text: "Transferir",
        icon: "fa-solid fa-user-arrow-down",
        title: "Transferir para outro colaborador",
        disabled: false,
        hidden: false
      });

      setClaimBarState({
        open: true,
        locked: false,
        accepted: false,
        busy: false,
        canAccept: false,
        canRelease: false,
        canTransfer: true,
        title: operadorNome
          ? `Atendimento em andamento por ${operadorNome}`
          : words.otherTitle,
        subtitle: "Como administrador, você pode responder sem alterar o responsável atual."
      });

      return;
    }

    setBtnBase(aceitar, {
      text: "Em atendimento",
      icon: "fa-solid fa-user-check",
      title: operadorNome
        ? `Responsável atual: ${operadorNome}`
        : words.otherTitle,
      disabled: true,
      hidden: false
    });

    setBtnBase(liberar, { hidden: true });

    setBtnBase(transferir, {
      text: "Transferir",
      icon: "fa-solid fa-user-arrow-down",
      title: "Transferir para outro colaborador",
      disabled: false,
      hidden: false
    });

    setClaimBarState({
      open: true,
      locked: true,
      accepted: false,
      busy: false,
      title: operadorNome
        ? `Atendimento em andamento por ${operadorNome}`
        : words.otherTitle,
      subtitle: words.otherSubtitle
    });
  }

  async function refreshResponsavelButtons(options = {}) {
    if (isAtendimentoLeaving()) return;

    const force = !!options.force;
    const conv = getCurrentConversation();

    if (!conv || conv.is_group) {
      __lastRenderedConversationKey = "";
      hideClaimUi();
      return;
    }

    const key = buildConversationKey(conv);
    if (!key) {
      __lastRenderedConversationKey = "";
      hideClaimUi();
      return;
    }

    const serial = ++__refreshSerial;

    if (__lastRenderedConversationKey && __lastRenderedConversationKey !== key) {
      hideClaimUi();
    }

    __lastRenderedConversationKey = key;

    try {
      /*
        Não mostra loading visual.
        Busca /meta em silêncio.
      */
      const meta = await fetchAndCacheMeta(conv, { force });

      if (serial !== __refreshSerial) return;

      const current = getCurrentConversation();
      const currentKey = buildConversationKey(current);

      if (currentKey !== key) return;

      renderClaimFromMeta(conv, meta);
    } catch (err) {
      if (isAtendimentoLeaving() || err?.name === "AbortError") return;

      console.error("[aceitar-conversa] refresh erro:", err);

      /*
        Segurança visual:
        se falhar /meta, não deixa a tela presa/piscando.
        O backend ainda valida o envio.
      */
      hideClaimUi();
    }
  }

  function scheduleRefreshResponsavelButtons(options = {}) {
    if (isAtendimentoLeaving()) return;

    clearTimeout(__refreshTimer);

    __refreshTimer = setTimeout(() => {
      if (isAtendimentoLeaving()) return;
      refreshResponsavelButtons(options);
    }, REFRESH_DEBOUNCE_MS);
  }

  async function aceitarConversaAtual() {
    if (window.__zcAceitarAtendimentoBusy === true) {
      return;
    }

    const conv = getCurrentConversation();
    const empresaId = getEmpresaId();
    const currentColabId = getCurrentColabId();
    const { aceitar } = getButtons();

    if (!conv || conv.is_group) {
      showToast("Abra uma conversa individual para aceitar.", "warning");
      return;
    }

    if (!empresaId) {
      showToast("empresa_id não encontrado.", "error");
      return;
    }

    try {
      window.__zcAceitarAtendimentoBusy = true;

      const prevMeta = window.getConversationMeta
        ? window.getConversationMeta(buildConversationKey(conv))
        : null;
      const words = claimWords(prevMeta || {});

      setBtnBase(aceitar, {
        text: words.accepting,
        icon: "fa-solid fa-spinner fa-spin",
        title: words.acceptTitle,
        disabled: true,
        hidden: false,
        busy: true
      });

      setClaimBarState({
        open: true,
        locked: true,
        accepted: false,
        busy: true,
        canAccept: false,
        canRelease: false,
        canTransfer: false,
        title: words.accepting,
        subtitle: "Aguarde um instante."
      });

      const payload = {
        empresa_id: empresaId,
        instancia_id: conv.instancia_id || null
      };

      const data = await fetchJSON(
        `/api/atendimento/conversas/${conv.id}/aceitar`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );

      const isDeptClaim = isDepartmentClaim(data) || isDepartmentClaim(prevMeta);

      // Cancela qualquer /meta iniciado antes do clique. Sem isso, uma
      // resposta antiga podia desfazer visualmente o aceite recém-confirmado.
      invalidateMetaCache(conv, {
        abort: true,
        bumpMutation: true,
        removeCache: true,
        reason: "claim-accepted"
      });

      const claimedOperatorId =
        toInt(data?.responsavel_id) ||
        toInt(data?.operador_id) ||
        currentColabId ||
        null;

      const optimisticMeta = saveMetaCache(conv, {
        ...data,
        claim_mode: isDeptClaim ? "departamento" : (data?.claim_mode || prevMeta?.claim_mode || null),
        departamento_claim: isDeptClaim,
        exigir_aceite: true,
        aceite_obrigatorio: true,
        fila_exigir_aceite: isDeptClaim ? false : true,
        pode_aceitar: false,
        pode_liberar: true,
        pode_responder: true,
        aceita_por_mim: true,
        accepted_by_me: true,
        accepted_by_anyone: true,
        operador_id: claimedOperatorId,
        responsavel_id: claimedOperatorId,
        responsavel_por_mim: Boolean(currentColabId && claimedOperatorId === currentColabId),
        operador_nome:
          data?.operador_nome ||
          data?.responsavel_nome ||
          null,
        responsavel_nome:
          data?.responsavel_nome ||
          data?.operador_nome ||
          null
      });

      markOptimisticMutation(optimisticMeta, "claim-accepted");
      emitMetaEvents(optimisticMeta);

      renderClaimFromMeta(conv, optimisticMeta);
      appendSystemEventToHistory(conv, data, "claim-accepted");

      showToast(
        data?.already_accepted
          ? words.already
          : (data?.joined_as_participant ? words.joined : words.success),
        "success"
      );

      window.dispatchEvent(
        new CustomEvent("zc:conversation-accepted", {
          detail: {
            ...data,
            conversation_key: buildConversationKey(conv)
          }
        })
      );

      refreshAfterAction({
        light: true,
        conv,
        data,
        reason: "claim-accepted"
      }).catch(() => {});
    } catch (err) {
      console.error("[aceitar-conversa] erro:", err);
      showToast(err?.message || "Falha ao aceitar conversa.", "error");
      await refreshResponsavelButtons({ force: true });
    } finally {
      window.__zcAceitarAtendimentoBusy = false;
    }
  }

  async function liberarConversaAtual() {
    if (window.__zcLiberarAtendimentoBusy === true) {
      return;
    }

    const conv = getCurrentConversation();
    const empresaId = getEmpresaId();
    const { liberar } = getButtons();

    if (!conv || conv.is_group) {
      showToast("Abra uma conversa individual para liberar.", "warning");
      return;
    }

    if (!empresaId) {
      showToast("empresa_id não encontrado.", "error");
      return;
    }

    try {
      window.__zcLiberarAtendimentoBusy = true;

      setBtnBase(liberar, {
        text: "Liberando...",
        icon: "fa-solid fa-spinner fa-spin",
        title: "Liberando atendimento",
        disabled: true,
        hidden: false,
        busy: true
      });

      setClaimBarState({
        open: true,
        locked: true,
        accepted: false,
        busy: true,
        canAccept: false,
        canRelease: false,
        canTransfer: false,
        title: "Liberando atendimento...",
        subtitle: "Aguarde um instante."
      });

      const payload = {
        empresa_id: empresaId,
        instancia_id: conv.instancia_id || null
      };

      const data = await fetchJSON(
        `/api/atendimento/conversas/${conv.id}/liberar`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );

      const previousMeta = window.getConversationMeta
        ? window.getConversationMeta(buildConversationKey(conv))
        : null;

      const isDeptClaim = Boolean(
        isDepartmentClaim(data) ||
        isDepartmentClaim(previousMeta) ||
        data?.departamento_claim === true ||
        toInt(data?.departamento_id)
      );

      invalidateMetaCache(conv, {
        abort: true,
        bumpMutation: true,
        removeCache: true,
        reason: "claim-released"
      });

      // O backend já devolve o estado final completo. Se havia outros
      // participantes, eles permanecem e um deles pode ter sido promovido.
      const optimisticMeta = saveMetaCache(conv, {
        ...(previousMeta || {}),
        ...data,
        claim_mode: isDeptClaim ? "departamento" : (data?.claim_mode || previousMeta?.claim_mode || null),
        departamento_claim: isDeptClaim,
        can_accept: Boolean(data?.pode_aceitar),
        can_release: Boolean(data?.pode_liberar),
        can_send: Boolean(data?.pode_responder),
        accepted_by_me: Boolean(data?.aceita_por_mim),
        accepted_by_anyone: Boolean(data?.tem_participantes),
        locked: data?.pode_responder === false
      });

      markOptimisticMutation(optimisticMeta, "claim-released");
      emitMetaEvents(optimisticMeta);
      renderClaimFromMeta(conv, optimisticMeta);
      appendSystemEventToHistory(conv, data, "claim-released");

      const releaseMessage = data?.released_to_queue
        ? "Atendimento liberado para o departamento."
        : (data?.promoted_responsavel_id
            ? "Você saiu do atendimento e outro participante assumiu como responsável."
            : "Você saiu deste atendimento.");
      showToast(releaseMessage, "success");

      window.dispatchEvent(
        new CustomEvent("zc:conversation-released", {
          detail: {
            ...data,
            conversation_key: buildConversationKey(conv)
          }
        })
      );

      refreshAfterAction({
        light: true,
        conv,
        data,
        reason: "claim-released"
      }).catch(() => {});
    } catch (err) {
      console.error("[liberar-conversa] erro:", err);
      showToast(err?.message || "Falha ao liberar atendimento.", "error");
      await refreshResponsavelButtons({ force: true });
    } finally {
      window.__zcLiberarAtendimentoBusy = false;
    }
  }


  function ensureTransferColabModalStyle() {
    if (document.getElementById("zc-transfer-colab-modal-style")) return;

    const style = document.createElement("style");
    style.id = "zc-transfer-colab-modal-style";
    style.textContent = `
      #zcTransferirColaboradorModal,
      .zc-transfer-dep-modal{
        position:fixed !important;
        inset:0 !important;
        z-index:10080 !important;
        display:none !important;
        align-items:center !important;
        justify-content:center !important;
        padding:18px !important;
        box-sizing:border-box !important;
        background:rgba(0,0,0,.52) !important;
        backdrop-filter:blur(2px) !important;
        -webkit-backdrop-filter:blur(2px) !important;
        color:#e9edef !important;
        font-family:"Inter","Segoe UI","Helvetica Neue",Arial,sans-serif !important;
      }

      #zcTransferirColaboradorModal.is-open,
      .zc-transfer-dep-modal.is-open{
        display:flex !important;
      }

      .zc-transfer-dep-card{
        width:min(420px, calc(100vw - 32px)) !important;
        max-height:min(92vh, 560px) !important;
        display:flex !important;
        flex-direction:column !important;
        overflow:hidden !important;
        border-radius:18px !important;
        border:1px solid rgba(255,255,255,.10) !important;
        background:#161717 !important;
        box-shadow:0 22px 70px rgba(0,0,0,.48) !important;
        color:#e9edef !important;
        animation:zcTransferColabIn .16s ease-out both !important;
      }

      @keyframes zcTransferColabIn{
        from{ opacity:0; transform:translateY(8px) scale(.98); }
        to{ opacity:1; transform:translateY(0) scale(1); }
      }

      .zc-transfer-dep-head{
        min-height:58px !important;
        display:flex !important;
        align-items:center !important;
        justify-content:space-between !important;
        gap:12px !important;
        padding:0 16px !important;
        border-bottom:1px solid rgba(255,255,255,.08) !important;
        background:#1b1c1d !important;
      }

      .zc-transfer-dep-title{
        min-width:0 !important;
        font-size:16px !important;
        line-height:1.2 !important;
        font-weight:700 !important;
        letter-spacing:-.2px !important;
        color:#f4f6f7 !important;
        white-space:nowrap !important;
        overflow:hidden !important;
        text-overflow:ellipsis !important;
      }

      .zc-transfer-dep-close{
        width:34px !important;
        height:34px !important;
        flex:0 0 34px !important;
        display:grid !important;
        place-items:center !important;
        border:0 !important;
        border-radius:999px !important;
        background:transparent !important;
        color:#aebac1 !important;
        font-size:18px !important;
        line-height:1 !important;
        cursor:pointer !important;
        transition:background .14s ease,color .14s ease,transform .08s ease !important;
      }

      .zc-transfer-dep-close:hover{
        background:rgba(255,255,255,.07) !important;
        color:#ffffff !important;
      }

      .zc-transfer-dep-close:active{
        transform:translateY(1px) !important;
      }

      .zc-transfer-dep-body{
        display:grid !important;
        gap:10px !important;
        padding:16px !important;
        background:#161717 !important;
      }

      .zc-transfer-dep-label{
        display:block !important;
        margin:0 !important;
        font-size:13px !important;
        line-height:1.2 !important;
        font-weight:600 !important;
        color:#cfd7dc !important;
      }

      .zc-transfer-dep-select{
        width:100% !important;
        height:42px !important;
        box-sizing:border-box !important;
        border:1px solid rgba(255,255,255,.10) !important;
        border-radius:12px !important;
        outline:none !important;
        padding:0 12px !important;
        background:#202123 !important;
        color:#e9edef !important;
        font:500 14px/1.2 "Inter","Segoe UI","Helvetica Neue",Arial,sans-serif !important;
        color-scheme:dark !important;
      }

      .zc-transfer-dep-select:focus{
        border-color:rgba(37,211,102,.72) !important;
        box-shadow:0 0 0 3px rgba(37,211,102,.14) !important;
      }

      .zc-transfer-dep-select:disabled{
        opacity:.72 !important;
        cursor:not-allowed !important;
      }

      .zc-transfer-dep-help{
        margin:0 !important;
        font-size:12.5px !important;
        line-height:1.38 !important;
        color:#9ca3af !important;
      }

      .zc-transfer-dep-error{
        display:none !important;
        margin-top:2px !important;
        padding:9px 10px !important;
        border-radius:10px !important;
        border:1px solid rgba(239,68,68,.28) !important;
        background:rgba(239,68,68,.10) !important;
        color:#fecaca !important;
        font-size:12.5px !important;
        line-height:1.35 !important;
      }

      .zc-transfer-dep-error.is-visible{
        display:block !important;
      }

      .zc-transfer-dep-foot{
        display:flex !important;
        align-items:center !important;
        justify-content:flex-end !important;
        gap:8px !important;
        padding:12px 16px 16px !important;
        border-top:1px solid rgba(255,255,255,.06) !important;
        background:#161717 !important;
      }

      .zc-transfer-dep-btn-secondary,
      .zc-transfer-dep-btn-primary{
        min-width:96px !important;
        height:38px !important;
        display:inline-flex !important;
        align-items:center !important;
        justify-content:center !important;
        gap:7px !important;
        border:0 !important;
        border-radius:999px !important;
        padding:0 15px !important;
        font:700 13px/1 "Inter","Segoe UI","Helvetica Neue",Arial,sans-serif !important;
        cursor:pointer !important;
        transition:background .14s ease,color .14s ease,opacity .14s ease,transform .08s ease !important;
      }

      .zc-transfer-dep-btn-secondary{
        background:#252728 !important;
        color:#d1d7db !important;
      }

      .zc-transfer-dep-btn-secondary:hover{
        background:#2f3334 !important;
        color:#ffffff !important;
      }

      .zc-transfer-dep-btn-primary{
        background:#25d366 !important;
        color:#071d12 !important;
      }

      .zc-transfer-dep-btn-primary:hover{
        background:#20bd5a !important;
        color:#04160d !important;
      }

      .zc-transfer-dep-btn-secondary:active,
      .zc-transfer-dep-btn-primary:active{
        transform:translateY(1px) !important;
      }

      .zc-transfer-dep-btn-secondary:disabled,
      .zc-transfer-dep-btn-primary:disabled{
        opacity:.62 !important;
        cursor:not-allowed !important;
        transform:none !important;
      }

      html[data-theme="light"] #zcTransferirColaboradorModal,
      html[data-theme="light"] .zc-transfer-dep-modal{
        background:rgba(17,27,33,.28) !important;
        color:#111b21 !important;
      }

      html[data-theme="light"] .zc-transfer-dep-card{
        background:#ffffff !important;
        color:#111b21 !important;
        border-color:rgba(17,27,33,.10) !important;
        box-shadow:0 22px 64px rgba(17,27,33,.18) !important;
      }

      html[data-theme="light"] .zc-transfer-dep-head,
      html[data-theme="light"] .zc-transfer-dep-body,
      html[data-theme="light"] .zc-transfer-dep-foot{
        background:#ffffff !important;
      }

      html[data-theme="light"] .zc-transfer-dep-head,
      html[data-theme="light"] .zc-transfer-dep-foot{
        border-color:rgba(17,27,33,.10) !important;
      }

      html[data-theme="light"] .zc-transfer-dep-title{
        color:#111b21 !important;
      }

      html[data-theme="light"] .zc-transfer-dep-close{
        color:#667781 !important;
      }

      html[data-theme="light"] .zc-transfer-dep-close:hover{
        background:#f0f2f5 !important;
        color:#111b21 !important;
      }

      html[data-theme="light"] .zc-transfer-dep-label{
        color:#3b4a54 !important;
      }

      html[data-theme="light"] .zc-transfer-dep-select{
        background:#f0f2f5 !important;
        color:#111b21 !important;
        border-color:#d9dee2 !important;
        color-scheme:light !important;
      }

      html[data-theme="light"] .zc-transfer-dep-help{
        color:#667781 !important;
      }

      html[data-theme="light"] .zc-transfer-dep-error{
        background:#fff1f2 !important;
        border-color:#fecdd3 !important;
        color:#b42318 !important;
      }

      html[data-theme="light"] .zc-transfer-dep-btn-secondary{
        background:#f0f2f5 !important;
        color:#3b4a54 !important;
      }

      html[data-theme="light"] .zc-transfer-dep-btn-secondary:hover{
        background:#e9edef !important;
        color:#111b21 !important;
      }

      html[data-theme="light"] .zc-transfer-dep-btn-primary{
        background:#00a884 !important;
        color:#ffffff !important;
      }

      html[data-theme="light"] .zc-transfer-dep-btn-primary:hover{
        background:#008f72 !important;
      }

      @media (max-width:640px){
        #zcTransferirColaboradorModal,
        .zc-transfer-dep-modal{
          align-items:flex-end !important;
          padding:10px !important;
        }

        .zc-transfer-dep-card{
          width:100% !important;
          border-radius:18px !important;
        }

        .zc-transfer-dep-foot{
          display:grid !important;
          grid-template-columns:1fr 1fr !important;
        }

        .zc-transfer-dep-btn-secondary,
        .zc-transfer-dep-btn-primary{
          width:100% !important;
          min-width:0 !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function ensureModal() {
    ensureTransferColabModalStyle();

    if (document.getElementById(MODAL_ID)) return;

    const html = `
      <div id="${MODAL_ID}" class="zc-transfer-dep-modal" aria-hidden="true">
        <div class="zc-transfer-dep-card" role="dialog" aria-modal="true" aria-labelledby="zcTransferColabTitle">
          <div class="zc-transfer-dep-head">
            <div id="zcTransferColabTitle" class="zc-transfer-dep-title">Transferir conversa</div>
            <button type="button" class="zc-transfer-dep-close" data-close-transfer-colab-modal aria-label="Fechar">✕</button>
          </div>

          <div class="zc-transfer-dep-body">
            <label class="zc-transfer-dep-label" for="zcTransferColabSelect">Novo responsável</label>
            <select id="zcTransferColabSelect" class="zc-transfer-dep-select">
              <option value="">Carregando...</option>
            </select>

            <div class="zc-transfer-dep-help" id="zcTransferColabHelp">
              O colaborador exibido aqui já respeita a instância e o departamento da conversa.
            </div>

            <div class="zc-transfer-dep-error" id="zcTransferColabError"></div>
          </div>

          <div class="zc-transfer-dep-foot">
            <button type="button" class="zc-transfer-dep-btn-secondary" data-close-transfer-colab-modal>Cancelar</button>
            <button type="button" class="zc-transfer-dep-btn-primary" id="zcTransferColabSubmit">Transferir</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", html);

    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
      if (e.target.closest("[data-close-transfer-colab-modal]")) closeModal();
    });
  }

  function getModalEls() {
    return {
      modal: document.getElementById(MODAL_ID),
      select: document.getElementById("zcTransferColabSelect"),
      submit: document.getElementById("zcTransferColabSubmit"),
      error: document.getElementById("zcTransferColabError"),
      help: document.getElementById("zcTransferColabHelp")
    };
  }

  function setError(msg) {
    const { error } = getModalEls();
    if (!error) return;

    if (!msg) {
      error.textContent = "";
      error.classList.remove("is-visible");
      return;
    }

    error.textContent = msg;
    error.classList.add("is-visible");
  }

  function openModal() {
    const { modal } = getModalEls();
    if (!modal) return;

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    const { modal, submit } = getModalEls();
    if (!modal) return;

    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");

    if (submit) submit.disabled = false;
    setError("");
  }

  async function carregarColaboradoresTransferiveis() {
    const empresaId = getEmpresaId();
    const conv = getCurrentConversation();

    if (!empresaId) throw new Error("empresa_id não encontrado na tela");
    if (!conv || conv.is_group) throw new Error("Conversa inválida para transferência");

    const url = new URL(
      `/api/atendimento/conversas/${conv.id}/colaboradores-transferiveis`,
      window.location.origin
    );

    url.searchParams.set("empresa_id", String(empresaId));

    if (conv.instancia_id) {
      url.searchParams.set("instancia_id", String(conv.instancia_id));
    }

    return await fetchJSON(url.toString());
  }

  function preencherSelectColaboradores(data) {
    const { select, help } = getModalEls();
    if (!select) return;

    const items = Array.isArray(data?.items) ? data.items : [];
    const currentId = data?.current_colaborador_id ?? null;

    if (!items.length) {
      select.innerHTML = `<option value="">Nenhum colaborador disponível</option>`;
      select.disabled = true;

      if (help) {
        help.innerHTML = "Não há colaboradores disponíveis para essa instância/departamento.";
      }

      return;
    }

    select.disabled = false;
    select.innerHTML = items
      .map((item) => {
        const selected = currentId === item.id ? "selected" : "";
        const currentTxt = item.is_current ? " (atual)" : "";
        const cargoTxt = item.cargo ? ` • ${item.cargo}` : "";
        return `<option value="${item.id}" ${selected}>${item.nome}${cargoTxt}${currentTxt}</option>`;
      })
      .join("");

    if (help) {
      help.innerHTML = "Só aparecem aqui colaboradores compatíveis com a instância e com o departamento da conversa.";
    }
  }

  async function abrirTransferencia() {
    const conv = getCurrentConversation();
    const { transferir } = getButtons();

    if (!conv || conv.is_group) {
      showToast("Abra uma conversa individual para transferir.", "warning");
      return;
    }

    if (transferir) transferir.disabled = true;

    try {
      ensureModal();
      openModal();
      setError("");

      const { select } = getModalEls();

      if (select) {
        select.innerHTML = `<option value="">Carregando...</option>`;
        select.disabled = true;
      }

      const data = await carregarColaboradoresTransferiveis();
      preencherSelectColaboradores(data);
    } catch (err) {
      setError(err?.message || "Falha ao carregar colaboradores.");
    } finally {
      if (transferir) transferir.disabled = false;
    }
  }

  async function confirmarTransferencia() {
    const empresaId = getEmpresaId();
    const conv = getCurrentConversation();
    const currentColabId = getCurrentColabId();
    const { select, submit } = getModalEls();

    if (!empresaId) {
      setError("empresa_id não encontrado.");
      return;
    }

    if (!conv || conv.is_group) {
      setError("Conversa inválida para transferência.");
      return;
    }

    const colaboradorId = Number(select?.value || 0);

    if (!colaboradorId) {
      setError("Selecione um colaborador.");
      return;
    }

    try {
      setError("");
      if (submit) submit.disabled = true;

      const payload = {
        empresa_id: empresaId,
        instancia_id: conv.instancia_id || null,
        colaborador_id: colaboradorId
      };

      const data = await fetchJSON(
        `/api/atendimento/conversas/${conv.id}/transferir-colaborador`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );

      const exigeAceite = metaRequiresAcceptance(data);
      const assignedToMe = Boolean(data?.aceita_por_mim);

      invalidateMetaCache(conv, {
        abort: true,
        bumpMutation: true,
        removeCache: true,
        reason: "claim-transferred"
      });

      const optimisticMeta = saveMetaCache(conv, {
        ...data,
        pode_aceitar: Boolean(data?.pode_aceitar),
        pode_liberar: Boolean(data?.pode_liberar),
        pode_responder: Boolean(data?.pode_responder),
        aceita_por_mim: assignedToMe,
        accepted_by_me: assignedToMe,
        accepted_by_anyone: Boolean(data?.tem_participantes),
        responsavel_por_mim: Boolean(currentColabId && currentColabId === colaboradorId),
        operador_id: colaboradorId,
        responsavel_id: colaboradorId,
        operador_nome: data?.operador_nome || null,
        responsavel_nome: data?.operador_nome || null
      });

      markOptimisticMutation(optimisticMeta, "claim-transferred");
      emitMetaEvents(optimisticMeta);
      renderClaimFromMeta(conv, optimisticMeta);

      showToast(`Conversa transferida para ${data.operador_nome}.`, "success");
      closeModal();

      window.dispatchEvent(
        new CustomEvent("zc:conversation-assigned", {
          detail: {
            ...data,
            conversation_key: buildConversationKey(conv)
          }
        })
      );

      await refreshAfterAction({
        light: true,
        conv,
        data,
        reason: "claim-transferred"
      });
    } catch (err) {
      setError(err?.message || "Falha ao transferir a conversa.");
      if (submit) submit.disabled = false;
    }
  }

  async function refreshAfterAction(options = {}) {
    const light = options.light !== false;
    const conv = options.conv || getCurrentConversation();
    const reason = options.reason || "claim-action";

    if (light) {
      // Modo leve: a resposta do POST já confirmou a ação e já foi colocada
      // no cache acima. Não faz GET /meta forçado imediatamente, pois esse GET
      // pode chegar com o estado anterior e desfazer o botão Atender na tela.
      if (conv) {
        try {
          const cached = window.getConversationMeta?.(buildConversationKey(conv));
          if (cached) renderClaimFromMeta(conv, cached);
          else await fetchAndCacheMeta(conv, { force: false });
        } catch {}
      }

      try { await refreshResponsavelButtons({ force: false }); } catch {}

      try {
        window.dispatchEvent(new CustomEvent("zc:conversation-light-refresh", {
          detail: {
            ...(options.data || {}),
            conversation_key: conv ? buildConversationKey(conv) : null,
            cliente_id: conv?.id || options.data?.cliente_id || null,
            instancia_id: conv?.instancia_id || options.data?.instancia_id || null,
            reason
          }
        }));
      } catch {}

      return;
    }

    // Fallback pesado/manual: mantido para telas antigas, mas não usado no
    // Atender/Liberar normal porque pesa e dá sensação de travamento.
    if (typeof window.carregarClientes === "function") {
      try { await window.carregarClientes(); } catch {}
    }

    if (typeof window.carregarHistorico === "function") {
      try { await window.carregarHistorico(); } catch {}
    }

    if (typeof window.recarregarConversaAtual === "function") {
      try { await window.recarregarConversaAtual(); } catch {}
    }

    if (conv) {
      try {
        await fetchAndCacheMeta(conv, { force: true });
      } catch {}
    }

    await refreshResponsavelButtons({ force: true });
  }

  function bindButtons() {
    ensureClaimActionButtons();
    const { aceitar, liberar, transferir } = getButtons();

    if (aceitar && aceitar.dataset.bound !== "1") {
      aceitar.dataset.bound = "1";

      aceitar.addEventListener("click", function (e) {
        e.preventDefault();
        aceitarConversaAtual();
      });
    }

    const { bar } = getClaimEls();
    if (bar && bar.dataset.cardClickBound !== "1") {
      bar.dataset.cardClickBound = "1";

      bar.addEventListener("click", function (e) {
        if (e.target.closest("button,a,input,select,textarea")) return;
        if (bar.dataset.canAccept !== "1") return;

        e.preventDefault();
        aceitarConversaAtual();
      });
    }

    if (liberar && liberar.dataset.bound !== "1") {
      liberar.dataset.bound = "1";

      liberar.addEventListener("click", function (e) {
        e.preventDefault();
        liberarConversaAtual();
      });
    }

    if (transferir && transferir.dataset.bound !== "1") {
      transferir.dataset.bound = "1";

      transferir.addEventListener("click", function (e) {
        e.preventDefault();
        abrirTransferencia();
      });
    }

    if (!document.__zcTransferColabSubmitBound) {
      document.__zcTransferColabSubmitBound = true;

      document.addEventListener("click", function (e) {
        const submit = e.target.closest("#zcTransferColabSubmit");

        if (submit) {
          e.preventDefault();
          confirmarTransferencia();
        }
      });
    }
  }

  function bindRefreshTriggers() {
    const historico = document.getElementById("historico");
    const lista = document.getElementById("lista-clientes");

    if (historico && !historico.dataset.acceptObserverBound) {
      historico.dataset.acceptObserverBound = "1";

      const mo = new MutationObserver(() => {
        scheduleRefreshResponsavelButtons();
      });

      mo.observe(historico, {
        attributes: true,
        attributeFilter: [
          "data-conversation-id",
          "data-conversation-key",
          "data-conv-key",
          "data-chat-key",
          "data-cliente-id",
          "data-entity-id",
          "data-instancia-id",
          "data-kind",
          "data-is-group"
        ]
      });
    }

    if (lista && !lista.dataset.acceptClickBound) {
      lista.dataset.acceptClickBound = "1";

      lista.addEventListener("click", function () {
        scheduleRefreshResponsavelButtons();
      });
    }

    if (!window.__zcAceitarConversaEventsBound) {
      window.__zcAceitarConversaEventsBound = true;

      [
        "zc:conversation-changed",
        "zc:conversation-opened",
        "zc:conversation-transferred",
        "zc:conversation-accepted",
        "zc:conversation-released",
        "zc:conversation-assigned",
        "zc:claim-updated"
      ].forEach((evt) => {
        window.addEventListener(evt, () => {
          scheduleRefreshResponsavelButtons();
        });
      });

      window.addEventListener("zc:remote-claim-updated", (ev) => {
        const detail = ev?.detail || {};
        const key =
          detail.conversation_key ||
          detail.conversation_id ||
          (
            detail.cliente_id && detail.instancia_id
              ? `c:${detail.cliente_id}:${detail.instancia_id}`
              : ""
          );

        const current = getCurrentConversation();
        const currentKey = buildConversationKey(current);
        const cachedCurrent = key ? getMetaCache()[key] : null;

        // O backend ecoa a própria ação pelo WebSocket. Se esta aba acabou de
        // confirmar a mesma mutação, mantém o estado otimista já confirmado em
        // vez de apagar o cache e consultar /meta cedo demais. Outras abas, que
        // não possuem esse marcador, continuam atualizando normalmente.
        if (key && hasActiveOptimisticMutation(cachedCurrent)) {
          if (current && currentKey === key) {
            appendSystemEventToHistory(current, detail, "remote-claim-updated");
            renderClaimFromMeta(current, cachedCurrent);
            scheduleRefreshResponsavelButtons();
          }
          return;
        }

        if (key) {
          invalidateMetaCache(key, {
            abort: true,
            bumpMutation: true,
            removeCache: true,
            reason: "remote-claim-updated"
          });
        }

        if (!current || !currentKey || (key && key !== currentKey)) return;

        appendSystemEventToHistory(current, detail, "remote-claim-updated");
        scheduleRefreshResponsavelButtons({ force: true });
      });

      window.addEventListener("focus", () => {
        scheduleRefreshResponsavelButtons();
      });
    }
  }

  function init() {
    ensureModal();
    bindButtons();
    bindRefreshTriggers();

    /*
      Primeira leitura também é silenciosa.
      Não aparece loading de estado.
    */
    scheduleRefreshResponsavelButtons({ force: true });
  }

  window.zcRefreshResponsavelButtons = function (options = {}) {
    return refreshResponsavelButtons({ ...options, force: true });
  };

  window.zcScheduleRefreshResponsavelButtons = scheduleRefreshResponsavelButtons;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  try {
    console.info("[ZapsChat][aceitar-conversa] carregado: zc-claim-shared-participants-v3");
  } catch {}
})();