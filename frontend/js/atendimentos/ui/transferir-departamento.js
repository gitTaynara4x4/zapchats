(function () {
  if (window.__zcTransferirDepartamentoLoaded) return;
  window.__zcTransferirDepartamentoLoaded = true;

  const BTN_ID = "btnTransferirDepartamento";
  const MODAL_ID = "zcTransferirDepartamentoModal";
  const STYLE_ID = "zcTransferirDepartamentoStyles";

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[m]));
  }

  function toInt(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function getEmpresaId() {
    return (
      toInt(window.empresa_id) ||
      toInt(window.EMPRESA_ID) ||
      toInt(window.__EMPRESA_ID__) ||
      toInt(localStorage.getItem("empresa_id")) ||
      toInt(document.body?.dataset?.empresaId) ||
      toInt(document.documentElement?.dataset?.empresaId) ||
      null
    );
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
    };
  }

  function getCurrentConversation() {
    const historico = document.getElementById("historico");
    const rawHistorico =
      historico?.dataset?.conversationId ||
      historico?.dataset?.conversationKey ||
      historico?.dataset?.convKey ||
      null;

    const parsedHistorico = parseConversationRef(rawHistorico);
    if (parsedHistorico) return parsedHistorico;

    const activeItem =
      document.querySelector("[data-conversation-id].active") ||
      document.querySelector("[data-conversation-key].active") ||
      document.querySelector(".cliente-item.active") ||
      document.querySelector(".chat-item.active") ||
      document.querySelector(".conversa-item.active");

    if (activeItem) {
      const raw =
        activeItem.dataset.conversationId ||
        activeItem.dataset.conversationKey ||
        activeItem.dataset.convKey ||
        null;

      const parsed = parseConversationRef(raw);
      if (parsed) return parsed;

      const clienteId = toInt(
        activeItem.dataset.clienteId ||
        activeItem.dataset.id ||
        activeItem.dataset.clienteBaseId
      );
      const instanciaId = toInt(activeItem.dataset.instanciaId);
      const isGroup = String(activeItem.dataset.isGroup || "").toLowerCase() === "true";

      if (clienteId) {
        return {
          kind: isGroup ? "grupo" : "cliente",
          id: clienteId,
          instancia_id: instanciaId,
          is_group: isGroup,
          conversation_id: `${isGroup ? "g" : "c"}:${clienteId}:${instanciaId || 0}`,
        };
      }
    }

    if (window.__zcCurrentConversation) {
      const raw =
        window.__zcCurrentConversation.conversation_id ||
        window.__zcCurrentConversation.conversation_key;
      const parsed = parseConversationRef(raw);
      if (parsed) return parsed;
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

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${MODAL_ID}{
        position:fixed;
        inset:0;
        z-index:99999;
        display:none;
        align-items:center;
        justify-content:center;
        padding:18px;
        background:rgba(0,0,0,.56);
      }

      #${MODAL_ID}.is-open{
        display:flex;
      }

      #${MODAL_ID} .zc-transfer-dep-card{
        width:100%;
        max-width:460px;
        background:#111b21;
        color:#e9edef;
        border:1px solid rgba(255,255,255,.08);
        border-radius:18px;
        box-shadow:0 24px 80px rgba(0,0,0,.38);
        overflow:hidden;
      }

      #${MODAL_ID} .zc-transfer-dep-head{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        padding:16px 18px;
        border-bottom:1px solid rgba(255,255,255,.08);
      }

      #${MODAL_ID} .zc-transfer-dep-title{
        font-size:15px;
        font-weight:700;
        color:#fff;
      }

      #${MODAL_ID} .zc-transfer-dep-close{
        width:34px;
        height:34px;
        border:none;
        border-radius:999px;
        background:transparent;
        color:#aebac1;
        cursor:pointer;
        font-size:16px;
      }

      #${MODAL_ID} .zc-transfer-dep-close:hover{
        background:rgba(255,255,255,.07);
        color:#fff;
      }

      #${MODAL_ID} .zc-transfer-dep-body{
        padding:18px;
      }

      #${MODAL_ID} .zc-transfer-dep-label{
        display:block;
        margin-bottom:8px;
        font-size:12.5px;
        font-weight:700;
        color:#aebac1;
      }

      #${MODAL_ID} .zc-transfer-dep-select{
        width:100%;
        height:44px;
        border-radius:12px;
        border:1px solid rgba(255,255,255,.10);
        background:#202c33;
        color:#fff;
        padding:0 12px;
        outline:none;
      }

      #${MODAL_ID} .zc-transfer-dep-help{
        margin-top:10px;
        font-size:12px;
        line-height:1.45;
        color:#aebac1;
      }

      #${MODAL_ID} .zc-transfer-dep-error{
        margin-top:12px;
        display:none;
        padding:10px 12px;
        border-radius:12px;
        background:rgba(255,74,74,.10);
        border:1px solid rgba(255,74,74,.18);
        color:#ffb3b3;
        font-size:12px;
        line-height:1.4;
      }

      #${MODAL_ID} .zc-transfer-dep-error.is-visible{
        display:block;
      }

      #${MODAL_ID} .zc-transfer-dep-foot{
        display:flex;
        justify-content:flex-end;
        gap:10px;
        padding:16px 18px 18px;
        border-top:1px solid rgba(255,255,255,.08);
      }

      #${MODAL_ID} .zc-transfer-dep-btn-secondary,
      #${MODAL_ID} .zc-transfer-dep-btn-primary{
        min-width:120px;
        height:42px;
        border:none;
        border-radius:12px;
        font-weight:700;
        cursor:pointer;
      }

      #${MODAL_ID} .zc-transfer-dep-btn-secondary{
        background:rgba(255,255,255,.07);
        color:#fff;
      }

      #${MODAL_ID} .zc-transfer-dep-btn-primary{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:8px;
        background:#25d366;
        color:#0b141a;
      }

      #${MODAL_ID} .zc-transfer-dep-btn-primary:disabled{
        opacity:.65;
        cursor:wait;
      }

      #${MODAL_ID} .zc-transfer-dep-spinner{
        width:14px;
        height:14px;
        flex:0 0 14px;
        border-radius:999px;
        border:2px solid rgba(11,20,26,.24);
        border-top-color:currentColor;
        animation:zc-transfer-dep-spin .72s linear infinite;
      }

      @keyframes zc-transfer-dep-spin{
        to{ transform:rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureModal() {
    if (document.getElementById(MODAL_ID)) return;

    const html = `
      <div id="${MODAL_ID}" aria-hidden="true">
        <div class="zc-transfer-dep-card" role="dialog" aria-modal="true" aria-labelledby="zcTransferDepTitle">
          <div class="zc-transfer-dep-head">
            <div id="zcTransferDepTitle" class="zc-transfer-dep-title">Transferir conversa</div>
            <button type="button" class="zc-transfer-dep-close" data-close-transfer-modal aria-label="Fechar">✕</button>
          </div>

          <div class="zc-transfer-dep-body">
            <label class="zc-transfer-dep-label" for="zcTransferDepSelect">Novo departamento</label>
            <select id="zcTransferDepSelect" class="zc-transfer-dep-select">
              <option value="">Carregando...</option>
            </select>

            <div class="zc-transfer-dep-help" id="zcTransferDepHelp">
              Se você transferir, a conversa passa a seguir a regra de visibilidade do novo departamento.
            </div>

            <div class="zc-transfer-dep-error" id="zcTransferDepError"></div>
          </div>

          <div class="zc-transfer-dep-foot">
            <button type="button" class="zc-transfer-dep-btn-secondary" data-close-transfer-modal>Cancelar</button>
            <button type="button" class="zc-transfer-dep-btn-primary" id="zcTransferDepSubmit">Transferir</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", html);

    const modal = document.getElementById(MODAL_ID);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
      if (e.target.closest("[data-close-transfer-modal]")) closeModal();
    });
  }

  function getModalEls() {
    return {
      modal: document.getElementById(MODAL_ID),
      select: document.getElementById("zcTransferDepSelect"),
      submit: document.getElementById("zcTransferDepSubmit"),
      error: document.getElementById("zcTransferDepError"),
      help: document.getElementById("zcTransferDepHelp"),
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

  function setTransferLoading(loading) {
    const { modal, select, submit } = getModalEls();
    if (!submit) return;

    if (!submit.dataset.defaultHtml) {
      submit.dataset.defaultHtml = submit.innerHTML || "Transferir";
    }

    submit.disabled = Boolean(loading);
    submit.classList.toggle("is-loading", Boolean(loading));

    if (loading) {
      submit.setAttribute("aria-busy", "true");
      submit.innerHTML = `
        <span class="zc-transfer-dep-spinner" aria-hidden="true"></span>
        <span>Transferindo...</span>
      `;

      if (select) {
        select.dataset.wasDisabledBeforeTransfer = select.disabled ? "1" : "0";
        select.disabled = true;
      }
    } else {
      submit.removeAttribute("aria-busy");
      submit.innerHTML = submit.dataset.defaultHtml || "Transferir";

      if (select && select.dataset.wasDisabledBeforeTransfer != null) {
        select.disabled = select.dataset.wasDisabledBeforeTransfer === "1";
        delete select.dataset.wasDisabledBeforeTransfer;
      }
    }

    modal?.querySelectorAll("[data-close-transfer-modal]").forEach((button) => {
      button.disabled = Boolean(loading);
    });
  }

  function openModal() {
    const { modal } = getModalEls();
    if (!modal) return;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    const { modal } = getModalEls();
    if (!modal) return;
    setTransferLoading(false);
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    setError("");
  }

  async function fetchJSON(url, options = {}) {
    const headers = {
      Accept: "application/json",
      ...(options.headers || {}),
    };

    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers,
    });

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }

    if (!res.ok) {
      const msg =
        data?.detail?.message ||
        data?.detail ||
        data?.message ||
        `HTTP ${res.status}`;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }

    return data;
  }

  async function carregarDepartamentos() {
    const empresaId = getEmpresaId();
    const conv = getCurrentConversation();

    if (!empresaId) throw new Error("empresa_id não encontrado na tela");
    if (!conv || conv.is_group) throw new Error("Conversa inválida para transferência");

    const url = new URL("/api/atendimento/departamentos-transferiveis", window.location.origin);
    url.searchParams.set("empresa_id", empresaId);
    url.searchParams.set("cliente_id", conv.id);
    if (conv.instancia_id) {
      url.searchParams.set("instancia_id", conv.instancia_id);
    }

    return fetchJSON(url.toString(), { method: "GET" });
  }

  function preencherSelect(data) {
    const { select, help } = getModalEls();
    if (!select) return;

    const items = Array.isArray(data?.items) ? data.items : [];
    const currentId = data?.current_departamento_id ?? null;

    if (!items.length) {
      select.innerHTML = `<option value="">Nenhum departamento disponível</option>`;
      select.disabled = true;
      if (help) {
        help.innerHTML = "Não há departamentos disponíveis para transferência nessa instância.";
      }
      return;
    }

    select.disabled = false;
    select.innerHTML = items.map((item) => {
      const selected = Number(currentId) === Number(item.id) ? "selected" : "";
      const currentTxt = item.is_current ? " (atual)" : "";
      return `<option value="${item.id}" ${selected}>${escapeHtml(item.nome)}${currentTxt}</option>`;
    }).join("");

    if (help) {
      help.innerHTML = "A conversa será movida para o novo departamento e seguirá a visibilidade dele.";
    }
  }

  async function abrirTransferencia() {
    const conv = getCurrentConversation();
    const btn = document.getElementById(BTN_ID);

    if (!conv || conv.is_group) {
      showToast("Abra uma conversa individual para transferir de departamento.", "warning");
      return;
    }

    if (btn) btn.disabled = true;

    try {
      ensureStyles();
      ensureModal();
      openModal();
      setError("");

      const { select } = getModalEls();
      if (select) {
        select.innerHTML = `<option value="">Carregando...</option>`;
        select.disabled = true;
      }

      const data = await carregarDepartamentos();
      preencherSelect(data);
    } catch (err) {
      setError(err?.message || "Falha ao carregar departamentos.");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function confirmarTransferencia() {
    const empresaId = getEmpresaId();
    const conv = getCurrentConversation();
    const { select, submit } = getModalEls();

    if (!empresaId) {
      setError("empresa_id não encontrado.");
      return;
    }
    if (!conv || conv.is_group) {
      setError("Conversa inválida para transferência.");
      return;
    }

    const departamentoId = Number(select?.value || 0);
    if (!departamentoId) {
      setError("Selecione um departamento.");
      return;
    }

    try {
      setError("");
      setTransferLoading(true);

      const payload = {
        empresa_id: empresaId,
        instancia_id: conv.instancia_id || null,
        departamento_id: departamentoId,
        atribuir_responsavel_primario: true,
        limpar_operador_atual: true,
      };

      const data = await fetchJSON(
        `/api/atendimento/conversas/${conv.id}/transferir-departamento`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        }
      );

      showToast(`Conversa transferida para ${data.departamento_nome || "o novo departamento"}.`, "success");
      closeModal();

      const conversationKey =
        data?.conversation_key ||
        data?.conversation_id ||
        conv.conversation_id ||
        `c:${conv.id}:${conv.instancia_id || 0}`;

      // O cache antigo fazia Atender/Liberar/Transferir continuarem no estado
      // anterior até expirar ou dar F5. Invalida e relê /meta imediatamente.
      try {
        if (typeof window.zcInvalidateConversationMeta === "function") {
          window.zcInvalidateConversationMeta(conversationKey, {
            abort: true,
            bumpMutation: true,
            removeCache: true,
            reason: "department-transferred",
          });
        }
      } catch (_) {}

      try {
        if (typeof window.refreshConversationMeta === "function") {
          await window.refreshConversationMeta(conversationKey);
        }
      } catch (_) {}

      window.dispatchEvent(new CustomEvent("zc:conversation-transferred", {
        detail: {
          ...data,
          conversation_key: conversationKey,
          conversation_id: conversationKey,
        },
      }));

      try {
        if (typeof window.zcRefreshResponsavelButtons === "function") {
          await window.zcRefreshResponsavelButtons({ force: true });
        }
      } catch (_) {}

      if (typeof window.carregarClientes === "function") {
        try { await window.carregarClientes(); } catch (_) {}
      }
    } catch (err) {
      setTransferLoading(false);
      setError(err?.message || "Falha ao transferir a conversa.");
    }
  }

  function updateButtonState() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;

    const conv = getCurrentConversation();
    btn.disabled = !conv || !!conv.is_group;
    btn.title = conv && !conv.is_group
      ? "Transferir departamento"
      : "Abra uma conversa individual para transferir";
  }

  function bindEvents() {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(`#${BTN_ID}`);
      if (btn) {
        e.preventDefault();
        abrirTransferencia();
        return;
      }

      const submit = e.target.closest("#zcTransferDepSubmit");
      if (submit) {
        e.preventDefault();
        confirmarTransferencia();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const { modal } = getModalEls();
        if (modal?.classList.contains("is-open")) {
          closeModal();
        }
      }
    });

    window.addEventListener("zc:conversation-changed", updateButtonState);
    window.addEventListener("zc:conversation-opened", updateButtonState);

    document.addEventListener("click", () => {
      setTimeout(updateButtonState, 50);
    });
  }

  function init() {
    ensureStyles();
    ensureModal();
    updateButtonState();
    bindEvents();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();