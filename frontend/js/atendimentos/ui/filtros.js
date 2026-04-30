/* /frontend/js/atendimentos/ui/filtros.js
   Filtros da lista lateral:
   - Tudo
   - Novas
   - Não lidas
   - Grupos

   Regra prática usada aqui:
   - Tudo: mostra tudo
   - Novas: conversa 1:1 sem atendimento/departamento, ou triagem ativa, ou status novo/aguardando
   - Não lidas: badge/contador > 0
   - Grupos: somente grupos

   Observação:
   Esse arquivo é leve e não fica travando a tela.
*/

const ZCFiltrosAtendimento = (() => {
  const STATE = {
    ativo: "tudo",
    observer: null,
    initialized: false,
  };

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function $$(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function toInt(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function normTxt(v) {
    return String(v || "")
      .trim()
      .toLowerCase();
  }

  function boolVal(v) {
    const s = normTxt(v);
    return s === "1" || s === "true" || s === "yes" || s === "sim";
  }

  function getLista() {
    return $("#lista-clientes");
  }

  function getFiltroBar() {
    return $("#wpp-header-filtros") || $(".wpp-header-filtros-row");
  }

  function getFiltroBtns() {
    const bar = getFiltroBar();
    if (!bar) return [];
    return $$(".wpp-header-filtro", bar);
  }

  function getItems() {
    const lista = getLista();
    if (!lista) return [];
    return Array.from(lista.children).filter((el) => el && el.nodeType === 1);
  }

  function getConversationId(el) {
    return (
      el?.dataset?.conversationId ||
      el?.dataset?.conversationKey ||
      el?.dataset?.convKey ||
      el?.getAttribute?.("data-conversation-id") ||
      el?.getAttribute?.("data-conversation-key") ||
      ""
    );
  }

  function isGroupItem(el) {
    const ds = el?.dataset || {};
    if (boolVal(ds.isGroup)) return true;

    const convId = getConversationId(el);
    if (/^g:\d+:\d+$/i.test(convId)) return true;

    const cls = String(el.className || "").toLowerCase();
    if (cls.includes("grupo")) return true;

    const grupoId = ds.grupoId || el.getAttribute?.("data-grupo-id");
    if (grupoId) return true;

    return false;
  }

  function getUnreadCount(el) {
    const ds = el?.dataset || {};

    const candidates = [
      ds.unread,
      ds.unreadCount,
      ds.naoLidas,
      ds.naoLidasCount,
      ds.novas,
      ds.badge,
    ];

    for (const c of candidates) {
      const n = toInt(c);
      if (n && n > 0) return n;
    }

    const badge =
      el.querySelector?.("[data-unread]") ||
      el.querySelector?.(".chat-badge") ||
      el.querySelector?.(".badge-unread") ||
      el.querySelector?.(".nao-lidas") ||
      el.querySelector?.(".cliente-badge") ||
      el.querySelector?.(".conv-badge") ||
      el.querySelector?.(".unread-badge") ||
      el.querySelector?.(".wpp-badge");

    if (badge) {
      const txt = String(badge.textContent || "").replace(/\D+/g, "");
      const n = toInt(txt);
      if (n && n > 0) return n;
    }

    return 0;
  }

  function getStatus(el) {
    const ds = el?.dataset || {};
    return normTxt(
      ds.status ||
      ds.atendimentoStatus ||
      ds.statusAtendimento ||
      ds.convStatus
    );
  }

  function getAtendimentoId(el) {
    const ds = el?.dataset || {};
    return toInt(ds.atendimentoId || ds.atendimento);
  }

  function getDepartamentoId(el) {
    const ds = el?.dataset || {};
    return toInt(ds.departamentoId || ds.departamento);
  }

  function isTriagemAtiva(el) {
    const ds = el?.dataset || {};
    return boolVal(ds.triagemAtiva || ds.noBot || ds.bot);
  }

  function isNovaItem(el) {
    if (isGroupItem(el)) return false;

    const status = getStatus(el);
    const atendimentoId = getAtendimentoId(el);
    const departamentoId = getDepartamentoId(el);
    const triagemAtiva = isTriagemAtiva(el);

    if (triagemAtiva) return true;

    if (status === "novo" || status === "aguardando") return true;

    if (atendimentoId === null || atendimentoId <= 0) return true;

    if (departamentoId === null || departamentoId <= 0) return true;

    return false;
  }

  function matchesFiltro(el, filtro) {
    switch (filtro) {
      case "grupos":
        return isGroupItem(el);

      case "nao_lidas":
        return getUnreadCount(el) > 0;

      case "novas":
        return isNovaItem(el);

      case "tudo":
      default:
        return true;
    }
  }

  function ensureButtonSetup() {
    const btns = getFiltroBtns();
    if (!btns.length) return;

    const wanted = [
      { key: "tudo", label: "Tudo" },
      { key: "novas", label: "Novas" },
      { key: "nao_lidas", label: "Não lidas" },
      { key: "grupos", label: "Grupos" },
    ];

    btns.forEach((btn, idx) => {
      const cfg = wanted[idx];
      if (!cfg) return;
      btn.dataset.filtro = cfg.key;
      btn.textContent = cfg.label;
    });
  }

  function updateButtons() {
    const btns = getFiltroBtns();
    btns.forEach((btn) => {
      const ativo = btn.dataset.filtro === STATE.ativo;
      btn.classList.toggle("ativo", ativo);
      btn.classList.toggle("active", ativo);
      btn.setAttribute("aria-pressed", ativo ? "true" : "false");
    });
  }

  function ensureEmptyState() {
    const lista = getLista();
    if (!lista) return null;

    let box = $("#zc-filtro-empty-state", lista.parentElement || document);
    if (box) return box;

    box = document.createElement("div");
    box.id = "zc-filtro-empty-state";
    box.style.display = "none";
    box.style.padding = "18px 14px";
    box.style.color = "var(--text-2, #aebac1)";
    box.style.fontSize = "13px";
    box.style.textAlign = "center";
    box.style.opacity = "0.9";
    box.textContent = "Nenhuma conversa encontrada neste filtro.";

    lista.insertAdjacentElement("afterend", box);
    return box;
  }

  function updateEmptyState() {
    const box = ensureEmptyState();
    const items = getItems();
    const visible = items.filter((el) => el.style.display !== "none");

    if (!box) return;
    box.style.display = visible.length ? "none" : "block";

    if (STATE.ativo === "novas") {
      box.textContent = "Nenhuma conversa nova no momento.";
    } else if (STATE.ativo === "nao_lidas") {
      box.textContent = "Nenhuma conversa não lida.";
    } else if (STATE.ativo === "grupos") {
      box.textContent = "Nenhum grupo encontrado.";
    } else {
      box.textContent = "Nenhuma conversa encontrada.";
    }
  }

  function aplicarFiltro() {
    ensureButtonSetup();
    updateButtons();

    const items = getItems();
    items.forEach((el) => {
      const show = matchesFiltro(el, STATE.ativo);
      el.style.display = show ? "" : "none";
    });

    updateEmptyState();

    window.dispatchEvent(
      new CustomEvent("zc:filtro-changed", {
        detail: { filtro: STATE.ativo },
      })
    );
  }

  function setFiltro(filtro) {
    const allowed = new Set(["tudo", "novas", "nao_lidas", "grupos"]);
    STATE.ativo = allowed.has(filtro) ? filtro : "tudo";
    aplicarFiltro();
  }

  function bindClicks() {
    const bar = getFiltroBar();
    if (!bar || bar.dataset.zcFiltrosBound === "1") return;

    bar.dataset.zcFiltrosBound = "1";

    bar.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".wpp-header-filtro");
      if (!btn) return;

      ev.preventDefault();
      const filtro = btn.dataset.filtro || "tudo";
      setFiltro(filtro);
    });
  }

  function observeLista() {
    const lista = getLista();
    if (!lista) return;

    if (STATE.observer) {
      try { STATE.observer.disconnect(); } catch {}
      STATE.observer = null;
    }

    let raf = 0;
    const refresh = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        aplicarFiltro();
      });
    };

    STATE.observer = new MutationObserver(() => {
      refresh();
    });

    STATE.observer.observe(lista, {
      childList: true,
      subtree: false,
    });
  }

  function bindWindowHooks() {
    if (window.__zcFiltrosHooksBound) return;
    window.__zcFiltrosHooksBound = true;

    const refresh = () => aplicarFiltro();

    window.addEventListener("zc:clientes-rendered", refresh);
    window.addEventListener("zc:conversation-opened", refresh);
    window.addEventListener("zc:conversation-transferred", refresh);
    window.addEventListener("zc:conversation-changed", refresh);
  }

  function init() {
    if (STATE.initialized) return;
    STATE.initialized = true;

    ensureButtonSetup();
    bindClicks();
    bindWindowHooks();
    observeLista();
    aplicarFiltro();
  }

  return {
    init,
    aplicarFiltro,
    setFiltro,
    getFiltroAtual: () => STATE.ativo,
  };
})();

window.ZCFiltrosAtendimento = ZCFiltrosAtendimento;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    ZCFiltrosAtendimento.init();
  }, { once: true });
} else {
  ZCFiltrosAtendimento.init();
}