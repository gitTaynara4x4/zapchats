// /frontend/js/atendimentos/ui/agenda.js
// Agenda (BD) — scroll infinito no feed normal;
// Busca no servidor SÓ quando estiver pesquisando (q).
// Lazy avatar: usa o que vier; só consulta BD/Evolution quando faltar/quebrar.
// ✅ Não carrega histórico manualmente.
// ✅ Não limpa #historico.
// ✅ Não força state.clienteSel na marra.
// ✅ Abre conversa pelo fluxo oficial: window.selecionarClienteObj(...)
// ✅ Preserva conversation_key / instancia_id quando o backend enviar.

(() => {
  if (window.__ZC_AGENDA_LOADED__) return;
  window.__ZC_AGENDA_LOADED__ = true;

  /* ---------------- helpers ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem("empresa_id") || 0);

  async function canViewClients() {
    try {
      const auth = window.ZAuth || window.Auth;
      if (auth && typeof auth.ensurePerm === "function") {
        return !!(await auth.ensurePerm("clientes.ver", { autoHandle: false }));
      }

      const r = await fetch("/api/permissoes/minhas", {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!r.ok) return false;
      const list = await r.json().catch(() => []);
      return Array.isArray(list) && list.includes("clientes.ver");
    } catch {
      return false;
    }
  }

  async function refreshAgendaPermissionUI() {
    const allowed = await canViewClients();
    document.querySelectorAll("#btn-contatos,[data-role='btn-agenda']").forEach((btn) => {
      btn.hidden = !allowed;
      btn.setAttribute("aria-hidden", allowed ? "false" : "true");
    });
    return allowed;
  }

  function debounce(fn, ms = 250) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  function escHtml(v) {
    return String(v ?? "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[m]));
  }

  function escAttr(v) {
    return escHtml(v).replace(/`/g, "&#96;");
  }

  function norm(v) {
    return String(v ?? "").trim();
  }

  function idKey(v) {
    const s = norm(v);
    if (!s || s === "null" || s === "undefined" || s === "NaN") return null;
    return s;
  }

  function instKey(v) {
    const s = norm(v);
    if (!s) return null;
    if (["null", "undefined", "nan", "0", "all", "*", "-"].includes(s.toLowerCase())) {
      return null;
    }
    return s;
  }

  function toIntOrNull(v) {
    const s = idKey(v);
    if (!s) return null;
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function onlyDigits(v) {
    return String(v || "").replace(/\D+/g, "");
  }

  const toast = {
    ok: (m) =>
      window.toast
        ? window.toast({ title: "Pronto", msg: m, type: "ok" })
        : console.log("[Agenda]", m),
    err: (m) =>
      window.toast
        ? window.toast({ title: "Erro", msg: m, type: "error" })
        : console.error("[Agenda]", m),
  };

  /*
    Importante:
    Aqui NÃO usamos window.state?.clienteSel.
    A Agenda deve pegar a instância selecionada no filtro/topo,
    não a instância da conversa anterior aberta.
  */
  function getInstanciaAtiva() {
    const candidates = [
      window.INSTANCIA_ATIVA,
      EMPRESA_ID ? localStorage.getItem(`instAtiva:${EMPRESA_ID}`) : null,
      EMPRESA_ID ? localStorage.getItem(`instanciaAtiva:${EMPRESA_ID}`) : null,
    ];

    for (const c of candidates) {
      const s = instKey(c);
      if (s) return s;
    }

    return null;
  }

  function splitInst(raw) {
    const s = instKey(raw);
    if (!s) {
      return {
        raw: null,
        instancia_id: null,
        instancia: null,
      };
    }

    if (/^\d+$/.test(s)) {
      return {
        raw: s,
        instancia_id: Number(s),
        instancia: null,
      };
    }

    return {
      raw: s,
      instancia_id: null,
      instancia: s,
    };
  }

  function normalizeKind(v) {
    const s = norm(v).toLowerCase();
    if (s === "g" || s === "grupo" || s === "group") return "g";
    return "c";
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

  function buildConversationKey(kind, entityId, instRaw) {
    const k = normalizeKind(kind);
    const eid = idKey(entityId);
    const iid = instKey(instRaw);
    if (!eid) return null;
    return `${k}:${eid}:${iid || "0"}`;
  }

  function pickFirst(obj, keys) {
    for (const k of keys) {
      const v = obj?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
    return null;
  }

  function getSkeletonHtml(count = 8) {
    return Array.from({ length: count })
      .map(
        () => `
          <div class="ag-skel" aria-hidden="true">
            <div class="dot"></div>
            <div class="meta">
              <div class="line line--lg"></div>
              <div class="line line--sm"></div>
            </div>
          </div>
        `
      )
      .join("");
  }

  function getAgendaLoadingHtml(label = "Carregando clientes...", skeletonCount = 0, extraClass = "") {
    const safeLabel = escHtml(label);
    const skeletons = skeletonCount > 0 ? getSkeletonHtml(skeletonCount) : "";

    return `
      <div class="ag-loading-state ${extraClass}" role="status" aria-live="polite">
        <span class="ag-loading-spinner" aria-hidden="true"></span>
        <span>${safeLabel}</span>
      </div>
      ${skeletons}
    `;
  }

  function showAgendaLoading(label, { append = false, skeletonCount = 0 } = {}) {
    const list = $("#agList");
    if (!list) return;

    list.querySelectorAll(".ag-loading-state--more").forEach((el) => el.remove());

    if (append) {
      list.insertAdjacentHTML(
        "beforeend",
        getAgendaLoadingHtml(label || "Carregando mais clientes...", 0, "ag-loading-state--more")
      );
      return;
    }

    list.innerHTML = getAgendaLoadingHtml(label || "Carregando clientes...", skeletonCount);
  }

  function clearAgendaMoreLoading() {
    const list = $("#agList");
    if (!list) return;
    list.querySelectorAll(".ag-loading-state--more").forEach((el) => el.remove());
  }

  function avatarHtml(url) {
    if (!url) {
      return `<span class="ag-avatar ag-avatar--default"><i class="fa fa-user-circle"></i></span>`;
    }

    const esc = escAttr(url);
    return `
      <span class="ag-avatar">
        <img src="${esc}" alt="" loading="lazy" referrerpolicy="no-referrer" crossorigin="anonymous"
             onerror="this.closest('.ag-avatar').classList.add('ag-avatar--default'); this.remove();">
      </span>
    `;
  }

  /* ---------------- Drawer ---------------- */
  function buildDrawer() {
    if ($("#agBackdrop")) return;

    const backdrop = document.createElement("div");
    backdrop.id = "agBackdrop";
    backdrop.className = "ag-backdrop";

    const drawer = document.createElement("aside");
    drawer.id = "agDrawer";
    drawer.className = "ag-drawer";
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");

    drawer.innerHTML = `
      <div class="ag-head">
        <div class="ag-title">Agenda</div>
        <button class="ag-close" id="agClose" title="Fechar" aria-label="Fechar">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 256 256">
            <path fill="currentColor" d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66A8 8 0 0 1 61.66 50.34L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128z"/>
          </svg>
        </button>
      </div>
      <div class="ag-search">
        <input id="agQuery" type="search" placeholder="Buscar por nome ou número…" autocomplete="off" />
      </div>
      <div class="ag-list" id="agList">
        ${getSkeletonHtml(8)}
      </div>
    `;

    document.body.append(backdrop, drawer);

    const close = () => {
      backdrop.classList.remove("is-open");
      drawer.classList.remove("is-open");
    };

    $("#agClose")?.addEventListener("click", close);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });

    window.__Agenda = {
      open: () => {
        backdrop.classList.add("is-open");
        drawer.classList.add("is-open");
        $("#agQuery")?.focus();
      },
      close,
      setList(html) {
        const l = $("#agList");
        if (l) l.innerHTML = html;
      },
    };
  }

  /* ------------- Botão “Contatos” (robusto) ------------- */
  function getHeaderIconsHost() {
    const candidates = [
      ".wpp-header-icons",
      "#wpp-header-icons",
      "#chat-header .wpp-header-icons",
      "#chat-header .header-icons",
      "#chat-header .icons",
      "#chat-header .actions",
    ];

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    const hdr = document.querySelector("#chat-header");
    if (hdr) {
      let created = hdr.querySelector(".wpp-header-icons");
      if (!created) {
        created = document.createElement("div");
        created.className = "wpp-header-icons";
        hdr.appendChild(created);
      }
      return created;
    }

    return null;
  }

  function ensureAgendaButton() {
    const host = getHeaderIconsHost();
    if (!host) return;

    let btn = host.querySelector("#btn-contatos, [data-role='btn-agenda']");
    if (!btn) {
      btn = document.createElement("button");
      btn.className = "wpp-header-icon";
      btn.id = "btn-contatos";
      btn.setAttribute("data-role", "btn-agenda");
      btn.type = "button";
      btn.title = "Contatos";
      btn.setAttribute("aria-label", "Contatos");
      btn.innerHTML = `<i class="fa fa-address-book"></i>`;
      host.prepend(btn);
    }

    if (!btn.dataset.agendaBound) {
      btn.dataset.agendaBound = "1";
      btn.addEventListener("click", (ev) => {
        ev.preventDefault?.();
        ev.stopPropagation?.();
        abrirAgenda();
      });
    }
  }

  (function watchHeader() {
    ensureAgendaButton();
    try {
      new MutationObserver(() => ensureAgendaButton()).observe(document.body, {
        childList: true,
        subtree: true,
      });
    } catch {}
  })();

  /* ---------------- Data/paginação ---------------- */
  const PAGE_SIZE = 100;

  const dataState = {
    mode: "feed", // 'feed' | 'search'
    q: "",
    items: [],
    offset: 0,
    cursor: null,
    next_page_token: null,
    total: null,
    hasMore: true,
    loading: false,
    lastKey: "",
  };

  function normalizeItem(it) {
    const raw = it || {};

    const foto =
      raw.avatar_url ||
      raw.foto_url ||
      raw.foto ||
      raw.avatar ||
      raw.profile_pic_url ||
      "";

    const id =
      raw.cliente_id ??
      raw.id_cliente ??
      raw.entity_id ??
      raw.conversation_entity_id ??
      raw.id ??
      raw.conversation_id ??
      null;

    const kind = normalizeKind(
      raw.kind ??
      raw.conversation_kind ??
      raw.tipo_conversa ??
      raw.tipo ??
      "c"
    );

    const rawConversationKey =
      raw.conversation_key ||
      raw.conversationId ||
      raw.conversation_id ||
      raw.conv_key ||
      raw.convKey ||
      null;

    const parsedKey = parseConversationKey(rawConversationKey);

    const activeInst = getInstanciaAtiva();

    const instRaw =
      parsedKey?.instId ||
      raw.instancia_id ||
      raw.instanciaId ||
      raw.instance_id ||
      raw.instanceId ||
      raw.instancia ||
      raw.instance ||
      raw.instance_name ||
      raw.instanceName ||
      activeInst ||
      null;

    const inst = splitInst(instRaw);

    const finalId =
      parsedKey?.entityId ||
      idKey(id);

    const conversationKey =
      parsedKey?.key ||
      buildConversationKey(kind, finalId, inst.raw);

    const nome = norm(
      raw.nome_whatsapp ||
      raw.push_name ||
      raw.pushName ||
      raw.nome ||
      raw.name ||
      raw.telefone ||
      raw.phone ||
      raw.numero ||
      ""
    );

    const telefone = norm(
      raw.telefone ||
      raw.phone ||
      raw.numero ||
      raw.whatsapp ||
      raw.telefone_norm ||
      raw.number ||
      ""
    );

    return {
      id: finalId,
      cliente_id: finalId,
      conversation_key: conversationKey,
      conversation_id: conversationKey,
      kind,
      nome,
      telefone,
      avatar_url: foto && String(foto).trim() !== "" ? String(foto) : null,
      instancia_id: inst.instancia_id,
      instancia: inst.instancia,
      instance_name: inst.instancia,
      instancia_raw: inst.raw,
      raw,
    };
  }

  function buildKey(mode, q) {
    const inst = getInstanciaAtiva() || "";
    return `${EMPRESA_ID}|${inst}|${mode}|${q || ""}`;
  }

  function buildClientesURL({ initial = false } = {}) {
    const qs = new URLSearchParams({
      empresa_id: String(EMPRESA_ID),
      limit: String(PAGE_SIZE),
    });

    /*
      Mesmo que o endpoint ignore esses parâmetros, não tem problema.
      Se ele aceitar, melhor: a Agenda já vem filtrada pela instância correta.
    */
    const activeInst = getInstanciaAtiva();
    if (activeInst) {
      if (/^\d+$/.test(activeInst)) qs.set("instancia_id", activeInst);
      else qs.set("instance", activeInst);
    }

    if (dataState.mode === "search" && dataState.q) {
      qs.set("q", dataState.q);
    }

    if (!initial) {
      if (dataState.next_page_token) qs.set("next_page_token", dataState.next_page_token);
      else if (dataState.cursor) qs.set("cursor", dataState.cursor);
      else qs.set("offset", String(dataState.offset));
    } else {
      dataState.offset = 0;
      dataState.cursor = null;
      dataState.next_page_token = null;
    }

    return "/api/clientes?" + qs.toString();
  }

  async function fetchNextPage({ initial = false } = {}) {
    if (dataState.loading) return;

    dataState.loading = true;

    try {
      const key = buildKey(dataState.mode, dataState.q);

      if (initial || dataState.lastKey !== key) {
        dataState.items = [];
        dataState.total = null;
        dataState.hasMore = true;
        dataState.offset = 0;
        dataState.cursor = null;
        dataState.next_page_token = null;
        dataState.lastKey = key;
      }

      if (!dataState.hasMore) return;

      const r = await fetch(buildClientesURL({ initial }), { credentials: "include" });

      if (!r.ok) {
        let detail = "";
        try {
          const j = await r.json();
          detail = j?.detail || j?.message || "";
        } catch {
          detail = await r.text();
        }
        throw new Error(detail || r.status + " " + r.statusText);
      }

      const payload = await r.json();

      const items = Array.isArray(payload?.items)
        ? payload.items
        : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload)
        ? payload
        : [];

      dataState.next_page_token = payload?.next_page_token ?? null;
      dataState.cursor = payload?.next_cursor ?? payload?.cursor ?? null;
      dataState.total = payload?.total != null ? Number(payload.total) : dataState.total;

      if (typeof payload?.has_more === "boolean") {
        dataState.hasMore = payload.has_more;
      } else if (payload?.next_page_token != null) {
        dataState.hasMore = Boolean(payload.next_page_token);
      } else if (payload?.next_cursor != null || payload?.cursor != null) {
        dataState.hasMore = Boolean(payload.next_cursor || payload.cursor);
      } else if (dataState.total != null) {
        dataState.hasMore = dataState.items.length + items.length < dataState.total;
      } else {
        dataState.hasMore = items.length === PAGE_SIZE;
      }

      if (!dataState.next_page_token && !dataState.cursor) {
        dataState.offset += items.length;
        if (payload?.next_offset != null) dataState.offset = Number(payload.next_offset);
      }

      const normalized = items
        .map(normalizeItem)
        .filter((x) => x && x.id != null && x.id !== "");

      dataState.items.push(...normalized);
    } finally {
      dataState.loading = false;
    }
  }

  /* ---------------- Render ---------------- */
  function htmlItem(it) {
    const attrs = [];

    attrs.push(`data-id="${escAttr(it.id)}"`);
    attrs.push(`data-cliente-id="${escAttr(it.cliente_id || it.id)}"`);

    if (it.conversation_key) {
      attrs.push(`data-conversation-key="${escAttr(it.conversation_key)}"`);
      attrs.push(`data-conversation-id="${escAttr(it.conversation_key)}"`);
    }

    attrs.push(`data-kind="${escAttr(it.kind || "c")}"`);

    if (it.telefone) attrs.push(`data-phone="${escAttr(it.telefone)}"`);
    if (it.avatar_url) attrs.push(`data-avatar="${escAttr(it.avatar_url)}"`);
    if (it.instancia_id != null) attrs.push(`data-instancia-id="${escAttr(it.instancia_id)}"`);
    if (it.instancia) attrs.push(`data-instance="${escAttr(it.instancia)}"`);
    if (it.instancia_raw) attrs.push(`data-instancia-raw="${escAttr(it.instancia_raw)}"`);

    const displayName = it.nome || it.telefone || "—";
    const displayPhone = it.telefone || "";

    return `
      <div class="ag-item" ${attrs.join(" ")}>
        ${avatarHtml(it.avatar_url)}
        <div class="ag-meta">
          <div class="ag-name">${escHtml(displayName)}</div>
          <div class="ag-phone">${escHtml(displayPhone)}</div>
        </div>
      </div>
    `;
  }

  function getItemFromElement(el) {
    if (!el) return null;

    const id = idKey(el.getAttribute("data-cliente-id") || el.getAttribute("data-id"));
    if (!id) return null;

    const nome = el.querySelector(".ag-name")?.textContent?.trim() || "";
    const tel = el.getAttribute("data-phone") || "";
    const av = el.getAttribute("data-avatar") || null;
    const kind = normalizeKind(el.getAttribute("data-kind") || "c");

    const rawConvKey =
      el.getAttribute("data-conversation-key") ||
      el.getAttribute("data-conversation-id") ||
      "";

    const parsed = parseConversationKey(rawConvKey);

    const rawInst =
      parsed?.instId ||
      el.getAttribute("data-instancia-id") ||
      el.getAttribute("data-instance") ||
      el.getAttribute("data-instancia-raw") ||
      getInstanciaAtiva();

    const inst = splitInst(rawInst);

    const conversationKey =
      parsed?.key ||
      buildConversationKey(kind, id, inst.raw);

    return {
      id,
      cliente_id: id,
      conversation_key: conversationKey,
      conversation_id: conversationKey,
      kind,
      telefone: tel,
      nome: nome || tel || "Cliente",
      avatar_url: av || null,
      instancia_id: inst.instancia_id,
      instancia: inst.instancia,
      instance_name: inst.instancia,
    };
  }

  function getSelectedConversationKeyFromDom() {
    const hist = $("#historico");
    const head = $("#chat-header");

    return (
      hist?.dataset?.conversationKey ||
      hist?.dataset?.conversationId ||
      hist?.dataset?.convKey ||
      head?.dataset?.conversationKey ||
      head?.dataset?.conversationId ||
      head?.dataset?.convKey ||
      ""
    );
  }

  function getSelectedClienteIdFromDom() {
    const hist = $("#historico");
    const head = $("#chat-header");
    const sel = window.state?.clienteSel || null;

    return idKey(
      hist?.dataset?.clienteId ||
      hist?.dataset?.entityId ||
      head?.dataset?.clienteId ||
      head?.dataset?.entityId ||
      sel?.cliente_id ||
      sel?.id ||
      null
    );
  }

  function selectionLooksCorrect(seed) {
    if (!seed) return false;

    const targetKey = idKey(seed.conversation_key || seed.conversation_id);
    const selectedKey = idKey(getSelectedConversationKeyFromDom());

    if (targetKey && selectedKey) {
      return selectedKey === targetKey;
    }

    const targetId = idKey(seed.cliente_id || seed.id);
    const selectedId = getSelectedClienteIdFromDom();

    return !!targetId && !!selectedId && targetId === selectedId;
  }

  async function openAgendaItem(el) {
    const seed = getItemFromElement(el);
    if (!seed?.cliente_id) return;

    if (!seed.instancia_id && !seed.instancia && window.ZC_REQUIRE_INSTANCE !== false) {
      toast.err("Não consegui identificar a instância desta conversa.");
      return;
    }

    if (typeof window.selecionarClienteObj !== "function") {
      toast.err("O atendimento ainda não terminou de carregar. Tente novamente.");
      return;
    }

    el.classList.add("is-opening");

    try {
      /*
        Importante:
        Passamos o OBJETO completo, não só o id.
        Assim o boot/init consegue usar conversation_key, instancia_id,
        telefone, nome e avatar corretos.
      */
      await window.selecionarClienteObj(seed);

      if (!selectionLooksCorrect(seed)) {
        console.warn("[Agenda] conversa aberta não bateu com a conversa clicada", {
          seed,
          selectedKey: getSelectedConversationKeyFromDom(),
          selectedClienteId: getSelectedClienteIdFromDom(),
        });

        toast.err("Não consegui abrir essa conversa com segurança. Tente pela lista de atendimentos.");
        return;
      }

      try {
        window.dispatchEvent(
          new CustomEvent("agenda:conversation-opened", {
            detail: {
              ...seed,
              source: "agenda",
            },
          })
        );
      } catch {}

      window.__Agenda?.close?.();
    } catch (e) {
      console.error("[Agenda] erro ao abrir conversa pelo fluxo oficial:", e);
      toast.err(e?.message || "Não foi possível abrir essa conversa.");
    } finally {
      el.classList.remove("is-opening");
    }
  }

  function bindItemClicks() {
    $$(".ag-item", $("#agList")).forEach((el) => {
      if (el.dataset.agClickBound === "1") return;
      el.dataset.agClickBound = "1";

      el.addEventListener(
        "click",
        async () => {
          await openAgendaItem(el);
        },
        { passive: true }
      );
    });
  }

  function renderList() {
    const list = $("#agList");
    if (!list) return;

    const prevTop = list.scrollTop;

    list.innerHTML = dataState.items.length
      ? dataState.items.map(htmlItem).join("")
      : `<div class="ag-empty">Nenhum contato encontrado.</div>`;

    bindItemClicks();

    document.dispatchEvent(new CustomEvent("agenda:render"));
    list.scrollTop = prevTop;
  }

  /* ---------------- Scroll infinito ---------------- */
  function ensureInfiniteScroll() {
    const list = $("#agList");
    if (!list || list.dataset.agScrollBound) return;

    list.dataset.agScrollBound = "1";
    list.addEventListener(
      "scroll",
      debounce(async () => {
        const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 140;
        if (nearBottom && dataState.hasMore && !dataState.loading) {
          showAgendaLoading("Carregando mais clientes...", { append: true });

          try {
            await fetchNextPage({ initial: false });
            renderList();
          } catch (e) {
            console.error("[Agenda] autoload paginação", e);
            clearAgendaMoreLoading();
          }
        }
      }, 80),
      { passive: true }
    );
  }

  /* ---------------- Fluxos ---------------- */
  async function abrirAgenda() {
    if (!(await canViewClients())) {
      toast.err('Você não tem permissão para visualizar clientes.');
      return;
    }

    const instRaw = getInstanciaAtiva();

    if (!instRaw || String(instRaw).trim() === "") {
      toast.err("Selecione uma instância antes de abrir a Agenda.");
      return;
    }

    buildDrawer();

    window.__Agenda.open();

    const list = $("#agList");
    showAgendaLoading("Carregando clientes...", { skeletonCount: 6 });

    dataState.mode = "feed";
    dataState.q = "";

    try {
      await fetchNextPage({ initial: true });
      renderList();
      ensureInfiniteScroll();
    } catch (e) {
      console.error("[Agenda] falha ao carregar contatos", e);
      if (list) {
        list.innerHTML = `<div class="ag-empty">Erro ao carregar a Agenda.<br><small>${escHtml(
          e.message || e
        )}</small></div>`;
      }
      toast.err("Não foi possível carregar a Agenda.");
    }
  }

  const onSearch = debounce(async () => {
    const q = ($("#agQuery")?.value || "").trim();
    const list = $("#agList");

    if (q.length === 0) {
      dataState.mode = "feed";
      dataState.q = "";
      showAgendaLoading("Carregando clientes...", { skeletonCount: 4 });

      try {
        await fetchNextPage({ initial: true });
        renderList();
        ensureInfiniteScroll();
      } catch (e) {
        console.error("[Agenda] feed", e);
        if (list) {
          list.innerHTML = `<div class="ag-empty">Erro ao carregar contatos.<br><small>${escHtml(
            e.message || e
          )}</small></div>`;
        }
      }

      return;
    }

    dataState.mode = "search";
    dataState.q = q;

    showAgendaLoading("Buscando clientes...", { skeletonCount: 4 });

    try {
      await fetchNextPage({ initial: true });
      renderList();
      ensureInfiniteScroll();
    } catch (e) {
      console.error("[Agenda] busca", e);
      if (list) {
        list.innerHTML = `<div class="ag-empty">Erro na busca.<br><small>${escHtml(
          e.message || e
        )}</small></div>`;
      }
    }
  }, 250);

  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t && t instanceof HTMLElement && t.id === "agQuery") onSearch();
  });

  document.addEventListener(
    "click",
    (e) => {
      const trg = e.target && e.target.closest?.("#btn-contatos,[data-role='btn-agenda']");
      if (trg) {
        e.preventDefault?.();
        e.stopPropagation?.();
        abrirAgenda();
      }
    },
    { passive: false }
  );

  refreshAgendaPermissionUI().catch(() => {});
  window.addEventListener("auth:change", () => refreshAgendaPermissionUI().catch(() => {}));

  /* ================== AGENDA: Lazy avatar (BD -> Evolution -> BD) ================== */
  (function agendaAvatarHydrator() {
    const TRIED_BD = new Set();
    const TRIED_EVOLUTION = new Set();

    const isSuspectWhatsAppURL = (u) =>
      /(^https?:\/\/pps\.whatsapp\.net)|(_nc_|\/v\/t61\.)/i.test(String(u || ""));

    async function fetchProfileBD(id) {
      try {
        const qs = new URLSearchParams({ empresa_id: String(EMPRESA_ID) });
        const r = await fetch(`/api/atendimento/clientes/${id}/profile?` + qs.toString(), {
          credentials: "include",
        });
        if (!r.ok) return null;
        return r.json().catch(() => null);
      } catch {
        return null;
      }
    }

    function setAvatarImg(container, url) {
      const box = container.querySelector(".ag-avatar");
      if (!box) return;

      if (!url) {
        box.classList.add("ag-avatar--default");
        box.innerHTML = `<i class="fa fa-user-circle"></i>`;
        return;
      }

      const safe = escAttr(url);
      box.classList.remove("ag-avatar--default");
      box.innerHTML = `<img src="${safe}" alt="" loading="lazy" referrerpolicy="no-referrer" crossorigin="anonymous">`;

      const img = box.querySelector("img");
      if (img) img.addEventListener("error", () => onImgError(container));
    }

    async function hydrateOne(container) {
      const id = Number(container?.getAttribute("data-id") || 0);
      if (!id) return;

      const currentImg = container.querySelector(".ag-avatar img");
      if (currentImg) {
        currentImg.addEventListener("error", () => onImgError(container));
        return;
      }

      const hinted = container.getAttribute("data-avatar");
      if (hinted && hinted.trim() !== "") {
        setAvatarImg(container, hinted);
        return;
      }

      if (!TRIED_BD.has(id)) {
        TRIED_BD.add(id);
        const bd = await fetchProfileBD(id);
        const fromBD = bd?.avatar_url && String(bd.avatar_url).trim() ? bd.avatar_url : null;
        if (fromBD && !isSuspectWhatsAppURL(fromBD)) {
          setAvatarImg(container, fromBD);
          return;
        }
      }

      setAvatarImg(container, null);
    }

    async function onImgError(container) {
      const id = Number(container?.getAttribute("data-id") || 0);
      if (!id) return;

      if (TRIED_EVOLUTION.has(id)) return;
      TRIED_EVOLUTION.add(id);

      const box = container.querySelector(".ag-avatar");
      if (box) {
        box.classList.add("ag-avatar--default");
        box.innerHTML = `<i class="fa fa-user-circle"></i>`;
      }

      try {
        if (typeof window.refreshAvatarFromEvolution === "function") {
          await window.refreshAvatarFromEvolution(id);
        }
      } catch {}

      const bd = await fetchProfileBD(id);
      const url = bd?.avatar_url && String(bd.avatar_url).trim() ? bd.avatar_url : null;
      setAvatarImg(container, url && !isSuspectWhatsAppURL(url) ? url : null);
    }

    let io = null;

    function getObserver() {
      if (io) return io;

      try {
        io = new IntersectionObserver(
          (entries) => {
            entries.forEach((e) => {
              if (e.isIntersecting) hydrateOne(e.target).catch(() => {});
            });
          },
          {
            root: document.querySelector("#agList") || null,
            rootMargin: "120px 0px",
            threshold: 0.01,
          }
        );
      } catch {
        io = null;
      }

      return io;
    }

    function wireObserver() {
      const list = document.getElementById("agList");
      if (!list) return;

      const observer = getObserver();

      try {
        observer?.disconnect?.();
      } catch {}

      list.querySelectorAll(".ag-item").forEach((it) => {
        const img = it.querySelector(".ag-avatar img");
        if (img) img.addEventListener("error", () => onImgError(it));

        if (observer) {
          observer.observe(it);
        } else {
          hydrateOne(it).catch(() => {});
        }
      });
    }

    document.addEventListener("agenda:render", wireObserver);
    setTimeout(wireObserver, 0);
  })();
})();