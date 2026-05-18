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
  const META_CACHE_TTL_MS = 2500;
  const REFRESH_DEBOUNCE_MS = 180;

  let __refreshTimer = null;
  let __lastRenderedConversationKey = "";
  let __refreshSerial = 0;
  const __metaInFlightByKey = new Map();

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
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      ...options
    });

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

  function getButtons() {
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
    title = "",
    subtitle = ""
  } = {}) {
    const { footer, bar, title: titleEl, subtitle: subtitleEl } = getClaimEls();

    if (!bar || !footer) return;

    if (!open) {
      bar.hidden = true;
      bar.classList.remove("is-open", "is-locked", "is-accepted", "is-busy");
      footer.dataset.sendLocked = "0";
      return;
    }

    bar.hidden = false;
    bar.classList.add("is-open");
    bar.classList.toggle("is-locked", !!locked);
    bar.classList.toggle("is-accepted", !!accepted);
    bar.classList.toggle("is-busy", !!busy);

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

  async function fetchMeta(conv) {
    const empresaId = getEmpresaId();

    if (!empresaId || !conv || conv.is_group) return null;

    const url = new URL(`/api/atendimento/conversas/${conv.id}/meta`, window.location.origin);
    url.searchParams.set("empresa_id", String(empresaId));

    if (conv.instancia_id) {
      url.searchParams.set("instancia_id", String(conv.instancia_id));
    }

    return await fetchJSON(url.toString());
  }

  function getMetaCache() {
    if (!window.__zcConversationMetaCache || typeof window.__zcConversationMetaCache !== "object") {
      window.__zcConversationMetaCache = {};
    }

    return window.__zcConversationMetaCache;
  }

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

    const canAccept = Boolean(
      exigirAceite &&
      (
        meta?.pode_aceitar ??
        meta?.can_accept ??
        !acceptedByMe
      )
    );

    const canSend = exigirAceite ? Boolean(podeResponder && acceptedByMe) : Boolean(podeResponder);

    const canRelease = Boolean(
      exigirAceite &&
      (
        meta?.pode_liberar ??
        meta?.can_release ??
        acceptedByMe
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

    if (!force && cached && cached._cached_at) {
      const age = Date.now() - Number(cached._cached_at || 0);

      if (age >= 0 && age < META_CACHE_TTL_MS) {
        return cached;
      }
    }

    if (!force && __metaInFlightByKey.has(key)) {
      return await __metaInFlightByKey.get(key);
    }

    const promise = (async () => {
      const meta = await fetchMeta(conv);
      if (!meta) return null;

      const detail = saveMetaCache(conv, meta);
      emitMetaEvents(detail);

      return detail;
    })();

    __metaInFlightByKey.set(key, promise);

    try {
      return await promise;
    } finally {
      __metaInFlightByKey.delete(key);
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

    /*
      REGRA PRINCIPAL:
      Se não veio de fila que exige aceite, não mostra barra,
      não trava composer e não exibe "Carregando" nem "Em atendimento".
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

    const operadorNome =
      meta.responsavel_nome ||
      meta.operador_nome ||
      null;

    if (podeAceitar) {
      setBtnBase(aceitar, {
        text: "Aceitar",
        icon: "fa-solid fa-hand",
        title: "Aceitar conversa",
        disabled: false,
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
        title: "Aceite a conversa para responder",
        subtitle: "Enquanto você não aceitar, o envio fica bloqueado."
      });

      return;
    }

    if (
      aceitaPorMim ||
      (operadorId && currentColabId && operadorId === currentColabId)
    ) {
      setBtnBase(aceitar, {
        text: "Aceita",
        icon: "fa-solid fa-circle-check",
        title: "Essa conversa já está com você",
        disabled: true,
        hidden: true,
        accepted: true
      });

      setBtnBase(liberar, {
        text: "Liberar",
        icon: "fa-solid fa-unlock",
        title: "Liberar conversa",
        disabled: !podeLiberar,
        hidden: false
      });

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
        accepted: true,
        busy: false,
        title: "Conversa aceita por você",
        subtitle: "Agora você já pode responder normalmente."
      });

      return;
    }

    setBtnBase(aceitar, {
      text: "Em atendimento",
      icon: "fa-solid fa-user-check",
      title: operadorNome
        ? `Responsável atual: ${operadorNome}`
        : "Essa conversa já está em atendimento",
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
        ? `Conversa em atendimento por ${operadorNome}`
        : "Conversa em atendimento",
      subtitle: "Você não pode responder enquanto a conversa estiver em atendimento."
    });
  }

  async function refreshResponsavelButtons(options = {}) {
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
    clearTimeout(__refreshTimer);

    __refreshTimer = setTimeout(() => {
      refreshResponsavelButtons(options);
    }, REFRESH_DEBOUNCE_MS);
  }

  async function aceitarConversaAtual() {
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
      setBtnBase(aceitar, {
        text: "Aceitando...",
        icon: "fa-solid fa-spinner fa-spin",
        title: "Aceitando conversa",
        disabled: true,
        hidden: false,
        busy: true
      });

      setClaimBarState({
        open: true,
        locked: true,
        accepted: false,
        busy: true,
        title: "Aceitando conversa...",
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

      const optimisticMeta = saveMetaCache(conv, {
        ...data,
        exigir_aceite: true,
        aceite_obrigatorio: true,
        fila_exigir_aceite: true,
        pode_aceitar: false,
        pode_liberar: true,
        pode_responder: true,
        aceita_por_mim: true,
        accepted_by_me: true,
        accepted_by_anyone: true,
        operador_id: currentColabId,
        responsavel_id: currentColabId,
        operador_nome:
          data?.operador_nome ||
          data?.responsavel_nome ||
          null,
        responsavel_nome:
          data?.responsavel_nome ||
          data?.operador_nome ||
          null
      });

      emitMetaEvents(optimisticMeta);

      renderClaimFromMeta(conv, optimisticMeta);

      showToast(
        data?.already_accepted
          ? "Essa conversa já estava com você."
          : "Conversa aceita com sucesso.",
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

      await refreshAfterAction();
    } catch (err) {
      console.error("[aceitar-conversa] erro:", err);
      showToast(err?.message || "Falha ao aceitar conversa.", "error");
      await refreshResponsavelButtons({ force: true });
    }
  }

  async function liberarConversaAtual() {
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
      setBtnBase(liberar, {
        text: "Liberando...",
        icon: "fa-solid fa-spinner fa-spin",
        title: "Liberando conversa",
        disabled: true,
        hidden: false,
        busy: true
      });

      setClaimBarState({
        open: true,
        locked: true,
        accepted: false,
        busy: true,
        title: "Liberando conversa...",
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

      const exigeAceite = metaRequiresAcceptance(data);

      const optimisticMeta = saveMetaCache(conv, {
        ...data,
        pode_aceitar: exigeAceite,
        pode_liberar: false,
        pode_responder: !exigeAceite,
        aceita_por_mim: false,
        accepted_by_me: false,
        accepted_by_anyone: false,
        operador_id: null,
        responsavel_id: null,
        operador_nome: null,
        responsavel_nome: null
      });

      emitMetaEvents(optimisticMeta);
      renderClaimFromMeta(conv, optimisticMeta);

      showToast("Conversa liberada com sucesso.", "success");

      window.dispatchEvent(
        new CustomEvent("zc:conversation-released", {
          detail: {
            ...data,
            conversation_key: buildConversationKey(conv)
          }
        })
      );

      await refreshAfterAction();
    } catch (err) {
      console.error("[liberar-conversa] erro:", err);
      showToast(err?.message || "Falha ao liberar conversa.", "error");
      await refreshResponsavelButtons({ force: true });
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
      const assignedToMe = !!currentColabId && currentColabId === colaboradorId;

      const optimisticMeta = saveMetaCache(conv, {
        ...data,
        pode_aceitar: exigeAceite && !assignedToMe,
        pode_liberar: exigeAceite && assignedToMe,
        pode_responder: !exigeAceite || assignedToMe,
        aceita_por_mim: exigeAceite && assignedToMe,
        accepted_by_me: exigeAceite && assignedToMe,
        accepted_by_anyone: exigeAceite,
        operador_id: colaboradorId,
        responsavel_id: colaboradorId,
        operador_nome: data?.operador_nome || null,
        responsavel_nome: data?.operador_nome || null
      });

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

      await refreshAfterAction();
    } catch (err) {
      setError(err?.message || "Falha ao transferir a conversa.");
      if (submit) submit.disabled = false;
    }
  }

  async function refreshAfterAction() {
    if (typeof window.carregarClientes === "function") {
      try { await window.carregarClientes(); } catch {}
    }

    if (typeof window.carregarHistorico === "function") {
      try { await window.carregarHistorico(); } catch {}
    }

    if (typeof window.recarregarConversaAtual === "function") {
      try { await window.recarregarConversaAtual(); } catch {}
    }

    const conv = getCurrentConversation();

    if (conv) {
      try {
        await fetchAndCacheMeta(conv, { force: true });
      } catch {}
    }

    await refreshResponsavelButtons({ force: true });
  }

  function bindButtons() {
    const { aceitar, liberar, transferir } = getButtons();

    if (aceitar && aceitar.dataset.bound !== "1") {
      aceitar.dataset.bound = "1";

      aceitar.addEventListener("click", function (e) {
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
})();