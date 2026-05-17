// /frontend/js/atendimentos/ui/perfil_quick.js
// Clique na FOTO/NOME do header abre "Dados do cliente".
// Para GRUPO, NÃO chama perfil de cliente. Dispara evento/função de grupo se existir.
// Também expõe:
//   window.zcApplyAvatarEverywhere(clienteId, avatarUrl?, opts?)
//   window.zcApplyGroupAvatarEverywhere(grupoId, avatarUrl?, opts?)
//
// Otimizações desta versão:
// - Remove loop pesado de avatar a cada 1.2s.
// - Não usa Date.now() toda hora no src da imagem.
// - Não chama renderListaClientes() ao atualizar avatar.
// - Não tenta abrir /clientes/{id}/profile quando a conversa é grupo.
// - Atualiza header/lista/caches apenas quando recebe evento, seleção ou refresh real.
// - Blindagem: header não reaproveita foto de outra conversa.

(() => {
  const VERSION = 'zc-perfil-quick-v9-avatar-header-strict';

  if (window.__ZC_PERFIL_QUICK_VERSION__ === VERSION) return;
  window.__ZC_PERFIL_QUICK_VERSION__ = VERSION;

  try {
    if (window.__zcPerfilQuickEnsureInterval) {
      clearInterval(window.__zcPerfilQuickEnsureInterval);
      window.__zcPerfilQuickEnsureInterval = null;
    }
  } catch {}

  const $ = (s, r = document) => r.querySelector(s);

  const avatarApplyTimers = new Map();
  const lastAvatarUrlByKey = new Map();

  function getEmpresaId() {
    return (
      window.EMPRESA_ID ||
      window.empresa_id ||
      window.state?.empresa_id ||
      localStorage.getItem('empresa_id') ||
      ''
    );
  }

  function cleanStr(v) {
    return String(v ?? '').trim();
  }

  function instKey(v) {
    const s = cleanStr(v);
    if (!s) return '';

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
      return '';
    }

    return s;
  }

  function parseConversationKey(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const m = raw.match(/^([cg]):(\d+):([^:]+)$/i);
    if (!m) return null;

    return {
      raw: `${m[1].toLowerCase()}:${m[2]}:${m[3]}`,
      kind: m[1].toLowerCase() === 'g' ? 'grupo' : 'cliente',
      prefix: m[1].toLowerCase(),
      entityId: Number(m[2]),
      instanciaId: instKey(m[3]) || null,
    };
  }

  function idFromAny(v) {
    if (v == null) return 0;

    const s = String(v).trim();
    if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return 0;

    const key = parseConversationKey(s);
    if (key && Number.isFinite(key.entityId) && key.entityId > 0) {
      return key.entityId;
    }

    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function getStateSelected() {
    return window.state?.clienteSel || window.clienteSel || null;
  }

  function getSelectedConversationKey() {
    const hist = $('#historico');
    const head = $('#chat-header');
    const sel = getStateSelected();

    const candidates = [
      hist?.dataset?.conversationKey,
      hist?.dataset?.conversationId,
      hist?.dataset?.chatKey,
      hist?.dataset?.convKey,

      head?.dataset?.conversationKey,
      head?.dataset?.conversationId,
      head?.dataset?.chatKey,
      head?.dataset?.convKey,

      sel?.conversation_key,
      sel?.conversationKey,
      sel?.conversation_id,
      sel?.conversationId,
      sel?.chat_key,
      sel?.chatKey,
      sel?.conv_key,
      sel?.convKey,
      sel?.key,
    ];

    for (const v of candidates) {
      const raw = String(v || '').trim();
      if (parseConversationKey(raw)) return raw;
    }

    return '';
  }

  function getSelectedKind() {
    const key = parseConversationKey(getSelectedConversationKey());
    if (key) return key.kind;

    const hist = $('#historico');
    const head = $('#chat-header');
    const sel = getStateSelected();

    const rawFlags = [
      hist?.dataset?.isGroup,
      hist?.dataset?.grupo,
      hist?.dataset?.kind,
      hist?.dataset?.tipo,

      head?.dataset?.isGroup,
      head?.dataset?.grupo,
      head?.dataset?.kind,
      head?.dataset?.tipo,

      sel?.is_group,
      sel?.isGroup,
      sel?.grupo,
      sel?.kind,
      sel?.tipo,
      sel?.conversation_kind,
      sel?.conversationKind,
    ];

    for (const v of rawFlags) {
      const s = String(v ?? '').trim().toLowerCase();
      if (['1', 'true', 'sim', 'yes', 'grupo', 'group', 'g'].includes(s)) return 'grupo';
      if (['0', 'false', 'nao', 'não', 'no', 'cliente', 'client', 'contact', 'c'].includes(s)) return 'cliente';
    }

    return 'cliente';
  }

  function getSelectedClienteId() {
    if (getSelectedKind() === 'grupo') return 0;

    const hist = $('#historico');
    const head = $('#chat-header');
    const sel = getStateSelected();

    const candidates = [
      hist?.dataset?.backendClienteId,
      hist?.dataset?.entityId,
      hist?.dataset?.apiClienteId,
      hist?.dataset?.clienteId,
      hist?.dataset?.conversationKey,
      hist?.dataset?.conversationId,

      head?.dataset?.backendClienteId,
      head?.dataset?.entityId,
      head?.dataset?.apiClienteId,
      head?.dataset?.clienteId,
      head?.dataset?.conversationKey,
      head?.dataset?.conversationId,

      sel?.backend_cliente_id,
      sel?.backendClienteId,
      sel?.entity_id,
      sel?.entityId,
      sel?.cliente_id,
      sel?.clienteId,
      sel?.backend_id,
      sel?.backendId,
      sel?.id,
      sel?.conversation_key,
      sel?.conversationKey,
      sel?.conversation_id,
      sel?.conversationId,

      window.CLIENTE_ID_ATUAL,
      window.currentClienteId,
      window.__perfilClienteIdAtual,
    ];

    for (const v of candidates) {
      const n = idFromAny(v);
      if (n > 0) return n;
    }

    return 0;
  }

  function getSelectedGroupId() {
    if (getSelectedKind() !== 'grupo') return 0;

    const key = parseConversationKey(getSelectedConversationKey());
    if (key?.kind === 'grupo' && key.entityId > 0) return key.entityId;

    const hist = $('#historico');
    const head = $('#chat-header');
    const sel = getStateSelected();

    const candidates = [
      hist?.dataset?.grupoId,
      hist?.dataset?.groupId,
      hist?.dataset?.entityId,
      hist?.dataset?.clienteId,
      hist?.dataset?.conversationKey,
      hist?.dataset?.conversationId,

      head?.dataset?.grupoId,
      head?.dataset?.groupId,
      head?.dataset?.entityId,
      head?.dataset?.clienteId,
      head?.dataset?.conversationKey,
      head?.dataset?.conversationId,

      sel?.grupo_id,
      sel?.grupoId,
      sel?.group_id,
      sel?.groupId,
      sel?.entity_id,
      sel?.entityId,
      sel?.cliente_id,
      sel?.clienteId,
      sel?.id,
      sel?.conversation_key,
      sel?.conversationKey,
      sel?.conversation_id,
      sel?.conversationId,
    ];

    for (const v of candidates) {
      const n = idFromAny(v);
      if (n > 0) return n;
    }

    return 0;
  }

  function getSelectedEntityId() {
    return getSelectedKind() === 'grupo'
      ? getSelectedGroupId()
      : getSelectedClienteId();
  }

  function getSelectedInstId() {
    const key = parseConversationKey(getSelectedConversationKey());
    if (key?.instanciaId) return String(key.instanciaId);

    const hist = $('#historico');
    const head = $('#chat-header');
    const sel = getStateSelected();

    return (
      instKey(hist?.dataset?.instanciaId) ||
      instKey(hist?.dataset?.instancia) ||
      instKey(head?.dataset?.instanciaId) ||
      instKey(head?.dataset?.instancia) ||
      instKey(sel?.instancia_id) ||
      instKey(sel?.instanciaId) ||
      instKey(sel?.instancia) ||
      instKey(sel?.instance_id) ||
      instKey(sel?.instanceId) ||
      instKey(sel?.instance) ||
      instKey(sel?.instance_name) ||
      instKey(sel?.instanceName) ||
      ''
    );
  }

  function getSelectedRef() {
    const key = parseConversationKey(getSelectedConversationKey());
    if (key) {
      return {
        conversationKey: key.raw,
        kind: key.kind,
        entityId: key.entityId,
        instanciaId: key.instanciaId || '',
      };
    }

    const kind = getSelectedKind();
    const entityId = getSelectedEntityId();
    const instanciaId = getSelectedInstId();

    return {
      conversationKey: kind && entityId && instanciaId
        ? `${kind === 'grupo' ? 'g' : 'c'}:${entityId}:${instanciaId}`
        : '',
      kind,
      entityId,
      instanciaId,
    };
  }

  function refFromIdKind(id, kind, opts = {}) {
    const k = kind === 'grupo' ? 'grupo' : 'cliente';

    const rawKey =
      opts.conversation_key ||
      opts.conversationKey ||
      opts.conversation_id ||
      opts.conversationId ||
      opts.chat_key ||
      opts.chatKey ||
      '';

    const parsed = parseConversationKey(rawKey);
    if (parsed) {
      return {
        conversationKey: parsed.raw,
        kind: parsed.kind,
        entityId: parsed.entityId,
        instanciaId: parsed.instanciaId || '',
      };
    }

    const entityId = idFromAny(id);
    const instanciaId =
      instKey(opts.instancia_id) ||
      instKey(opts.instanciaId) ||
      instKey(opts.instancia) ||
      instKey(opts.instance_id) ||
      instKey(opts.instanceId) ||
      instKey(opts.instance) ||
      instKey(opts.instance_name) ||
      instKey(opts.instanceName) ||
      '';

    return {
      conversationKey: entityId && instanciaId
        ? `${k === 'grupo' ? 'g' : 'c'}:${entityId}:${instanciaId}`
        : '',
      kind: k,
      entityId,
      instanciaId,
    };
  }

  function isCurrentHeaderTarget(id, kind, opts = {}) {
    const current = getSelectedRef();
    const target = refFromIdKind(id, kind, opts);

    if (!current.entityId || !target.entityId) return false;
    if (current.kind !== target.kind) return false;
    if (Number(current.entityId) !== Number(target.entityId)) return false;

    /*
      Se os dois têm conversation_key completa, precisa bater exatamente.
      Isso evita avatar de uma conversa ser jogado no header de outra.
    */
    if (current.conversationKey && target.conversationKey) {
      return String(current.conversationKey) === String(target.conversationKey);
    }

    /*
      Se temos instância dos dois lados, também precisa bater.
    */
    if (current.instanciaId && target.instanciaId) {
      return String(current.instanciaId) === String(target.instanciaId);
    }

    /*
      Compatibilidade com dados antigos sem instância:
      se não existe instância no evento, ainda permite quando ID e tipo batem.
    */
    return true;
  }

  function hasOpenChat() {
    return getSelectedEntityId() > 0;
  }

  function escAttr(v) {
    return String(v ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function cssEscapeSafe(v) {
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(String(v));
      }
    } catch {}
    return String(v).replace(/["\\]/g, '\\$&');
  }

  function addCacheBust(url, bust = false) {
    const s = String(url || '').trim();
    if (!s) return null;
    if (!bust) return s;

    const sep = s.includes('?') ? '&' : '?';
    return `${s}${sep}v=${Date.now()}`;
  }

  function zcAvatarProxyUrl(id, opts = {}) {
    const realId = idFromAny(id);
    if (!realId) return null;

    const kind = opts.kind === 'grupo' ? 'grupo' : 'cliente';
    const empresaId = getEmpresaId();

    const qs = new URLSearchParams();
    qs.set('kind', kind);

    if (empresaId) qs.set('empresa_id', String(empresaId));

    return `/api/atendimento/avatar/${encodeURIComponent(realId)}?${qs.toString()}`;
  }

  function normalizeAvatarUrl(id, avatarUrl = null, opts = {}) {
    const raw = String(avatarUrl || '').trim();
    const bust = !!opts.bust;
    const kind = opts.kind === 'grupo' ? 'grupo' : 'cliente';

    if (raw) return addCacheBust(raw, bust);

    const proxy = zcAvatarProxyUrl(id, { kind });
    return addCacheBust(proxy, bust);
  }

  function sameUrl(a, b) {
    try {
      const aa = new URL(String(a || ''), location.origin);
      const bb = new URL(String(b || ''), location.origin);
      aa.searchParams.delete('v');
      bb.searchParams.delete('v');
      return aa.toString() === bb.toString();
    } catch {
      return String(a || '') === String(b || '');
    }
  }

  function markImgError(img) {
    if (!img) return;

    img.dataset.avatarError = '1';

    if (typeof window.handleAvatarError === 'function') {
      try {
        window.handleAvatarError(img);
        return;
      } catch {}
    }

    try {
      img.removeAttribute('src');
      img.style.display = 'none';
    } catch {}
  }

  function setImgSrc(img, url, id, kind) {
    if (!img || !url) return;

    const current = img.getAttribute('src') || img.src || '';
    if (current && sameUrl(current, url) && img.dataset.avatarError !== '1') return;

    img.dataset.avatarError = '0';
    img.dataset.avatarId = String(id || '');
    img.dataset.avatarKind = kind === 'grupo' ? 'grupo' : 'cliente';

    img.setAttribute('referrerpolicy', 'no-referrer');
    img.onerror = function () {
      markImgError(this);
    };

    img.style.display = '';
    img.src = url;
  }

  function putImgIntoBox(box, url, id, kind, extraImgClass = '') {
    if (!box || !url) return;

    const img = document.createElement('img');
    img.alt = '';
    img.dataset.avatarId = String(id || '');
    img.dataset.avatarKind = kind === 'grupo' ? 'grupo' : 'cliente';

    if (extraImgClass) img.className = extraImgClass;

    img.setAttribute('referrerpolicy', 'no-referrer');
    img.onerror = function () {
      markImgError(this);
    };

    img.src = url;
    box.innerHTML = '';
    box.appendChild(img);
  }

  function setDefaultAvatarBox(box, id, kind) {
    if (!box) return;

    const finalKind = kind === 'grupo' ? 'grupo' : 'cliente';

    box.innerHTML = `
      <span
        class="avatar avatar-default"
        data-avatar-id="${escAttr(id || '')}"
        data-avatar-kind="${escAttr(finalKind)}"
      >
        <i class="fa fa-user-circle text-2xl text-gray-400"></i>
      </span>
    `;
  }

  function clearHeaderAvatar(id, kind, opts = {}) {
    try {
      if (!isCurrentHeaderTarget(id, kind, opts)) return;

      if (typeof window.zcClearHeaderAvatarSafe === 'function') {
        try {
          const current = getSelectedRef();
          const refLike = current.conversationKey || {
            id,
            cliente_id: kind === 'cliente' ? id : undefined,
            grupo_id: kind === 'grupo' ? id : undefined,
            kind: kind === 'grupo' ? 'g' : 'c',
            instancia_id: current.instanciaId || undefined,
          };

          const ok = window.zcClearHeaderAvatarSafe(refLike);
          if (ok) return;
        } catch {}
      }

      const av = document.getElementById('chat-avatar');
      if (!av) return;

      setDefaultAvatarBox(av, id, kind);
    } catch {}
  }

  function candidateIdForCacheItem(c, kind) {
    if (!c || typeof c !== 'object') return 0;

    if (kind === 'grupo') {
      const key = parseConversationKey(
        c.conversation_key ||
        c.conversationKey ||
        c.conversation_id ||
        c.conversationId ||
        c.chat_key ||
        c.chatKey ||
        ''
      );

      if (key?.kind === 'grupo') return key.entityId;

      const isGroup = !!(
        c.is_group ||
        c.isGroup ||
        c.grupo ||
        String(c.kind || c.tipo || '').toLowerCase() === 'grupo' ||
        String(c.kind || c.tipo || '').toLowerCase() === 'group'
      );

      if (!isGroup) return 0;

      return (
        idFromAny(c.grupo_id) ||
        idFromAny(c.grupoId) ||
        idFromAny(c.group_id) ||
        idFromAny(c.groupId) ||
        idFromAny(c.entity_id) ||
        idFromAny(c.entityId) ||
        idFromAny(c.id) ||
        idFromAny(c.cliente_id) ||
        idFromAny(c.clienteId)
      );
    }

    const key = parseConversationKey(
      c.conversation_key ||
      c.conversationKey ||
      c.conversation_id ||
      c.conversationId ||
      c.chat_key ||
      c.chatKey ||
      ''
    );

    if (key?.kind === 'cliente') return key.entityId;
    if (key?.kind === 'grupo') return 0;

    return (
      idFromAny(c.backend_cliente_id) ||
      idFromAny(c.backendClienteId) ||
      idFromAny(c.entity_id) ||
      idFromAny(c.entityId) ||
      idFromAny(c.cliente_id) ||
      idFromAny(c.clienteId) ||
      idFromAny(c.backend_id) ||
      idFromAny(c.backendId) ||
      idFromAny(c.id)
    );
  }

  function updateCacheArray(arr, id, url, kind) {
    if (!Array.isArray(arr)) return;

    arr.forEach((c) => {
      const cid = candidateIdForCacheItem(c, kind);

      if (cid === id) {
        c.avatar_url = url;
        c.avatar = url;
        c.foto = url;
        c.foto_url = url;
        c.profile_pic_url = url;
        c.profilePictureUrl = url;

        if (kind === 'grupo') {
          c.group_avatar_url = url;
          c.grupo_avatar_url = url;
        }
      }
    });
  }

  function updateKnownCaches(id, url, kind) {
    try {
      updateCacheArray(window.state?.clientesCache, id, url, kind);
      updateCacheArray(window.clientesCache, id, url, kind);
      updateCacheArray(window.state?.todosContatosCache, id, url, kind);
      updateCacheArray(window.todosContatosCache, id, url, kind);
      updateCacheArray(window.state?.conversasCache, id, url, kind);
      updateCacheArray(window.conversasCache, id, url, kind);

      const boxes = window.state?.convsByInst || {};
      Object.values(boxes).forEach((box) => {
        updateCacheArray(box?.items, id, url, kind);
        updateCacheArray(box, id, url, kind);
      });
    } catch {}
  }

  function updateSelectedState(id, url, kind) {
    try {
      window.state = window.state || {};
      const sel = window.state.clienteSel || window.clienteSel || null;
      if (!sel) return;

      const selKind = getSelectedKind();
      const selId = kind === 'grupo'
        ? getSelectedGroupId()
        : getSelectedClienteId();

      if (selKind === kind && selId === id) {
        sel.avatar_url = url;
        sel.avatar = url;
        sel.foto = url;
        sel.foto_url = url;
        sel.profile_pic_url = url;
        sel.profilePictureUrl = url;

        if (kind === 'grupo') {
          sel.group_avatar_url = url;
          sel.grupo_avatar_url = url;
        }

        if (window.state.clienteSel) window.state.clienteSel = sel;
        window.clienteSel = sel;
      }
    } catch {}
  }

  function updateHeaderAvatar(id, url, kind, opts = {}) {
    try {
      if (!isCurrentHeaderTarget(id, kind, opts)) return;

      const av = document.getElementById('chat-avatar');
      if (!av) return;

      if (!url) {
        clearHeaderAvatar(id, kind, opts);
        return;
      }

      if (typeof window.zcSetHeaderAvatarSafe === 'function') {
        try {
          const current = getSelectedRef();
          const refLike = current.conversationKey || {
            id,
            cliente_id: kind === 'cliente' ? id : undefined,
            grupo_id: kind === 'grupo' ? id : undefined,
            kind: kind === 'grupo' ? 'g' : 'c',
            instancia_id: current.instanciaId || undefined,
          };

          const ok = window.zcSetHeaderAvatarSafe(refLike, url);
          if (ok) return;
        } catch {}
      }

      const existing =
        av.querySelector('img') ||
        (av.matches?.('img') ? av : null);

      if (existing) {
        setImgSrc(existing, url, id, kind);
        return;
      }

      av.innerHTML = '<span class="avatar"></span>';
      const box = av.querySelector('.avatar') || av;
      putImgIntoBox(box, url, id, kind);
    } catch {}
  }

  function updateListAvatar(id, url, kind, opts = {}) {
    try {
      const selected = getSelectedRef();
      const selectedMatches =
        selected.kind === kind &&
        Number(selected.entityId) === Number(id);

      const convKey = selectedMatches ? selected.conversationKey : '';
      const selectors = [];

      if (convKey) {
        const ck = cssEscapeSafe(convKey);
        selectors.push(
          `#lista-clientes [data-conversation-key="${ck}"]`,
          `#lista-clientes [data-conversation-id="${ck}"]`,
          `#lista-clientes [data-chat-key="${ck}"]`,
          `#lista-clientes [data-key="${ck}"]`,
          `.cliente-item[data-conversation-key="${ck}"]`,
          `.cliente-item[data-chat-key="${ck}"]`,
          `.cliente-item[data-key="${ck}"]`,
          `.chat-item[data-conversation-key="${ck}"]`,
          `.chat-item[data-chat-key="${ck}"]`,
          `.chat-item[data-key="${ck}"]`
        );
      }

      if (kind === 'grupo') {
        selectors.push(
          `#lista-clientes [data-grupo-id="${id}"]`,
          `#lista-clientes [data-group-id="${id}"]`,
          `#lista-clientes [data-entity-id="${id}"][data-is-group="1"]`,
          `#lista-clientes [data-entity-id="${id}"][data-kind="g"]`,
          `#lista-clientes [data-entity-id="${id}"][data-kind="grupo"]`,
          `.cliente-item[data-grupo-id="${id}"]`,
          `.cliente-item[data-group-id="${id}"]`,
          `.chat-item[data-grupo-id="${id}"]`,
          `.chat-item[data-group-id="${id}"]`
        );
      } else {
        selectors.push(
          `#lista-clientes [data-id="${id}"]`,
          `#lista-clientes [data-cliente-id="${id}"]`,
          `#lista-clientes [data-api-cliente-id="${id}"]`,
          `#lista-clientes [data-backend-cliente-id="${id}"]`,
          `#lista-clientes [data-entity-id="${id}"][data-is-group="0"]`,
          `#lista-clientes [data-entity-id="${id}"][data-is-group="false"]`,
          `#lista-clientes [data-entity-id="${id}"][data-kind="c"]`,
          `#lista-clientes [data-entity-id="${id}"][data-kind="cliente"]`,
          `.cliente-item[data-id="${id}"]`,
          `.cliente-item[data-cliente-id="${id}"]`,
          `.cliente-item[data-api-cliente-id="${id}"]`,
          `.cliente-item[data-backend-cliente-id="${id}"]`,
          `.cliente-item[data-entity-id="${id}"]`,
          `.chat-item[data-id="${id}"]`,
          `.chat-item[data-cliente-id="${id}"]`
        );
      }

      const uniqueSelectors = [...new Set(selectors)].join(',');
      if (!uniqueSelectors) return;

      document.querySelectorAll(uniqueSelectors).forEach((item) => {
        item.dataset.avatar = url;
        item.dataset.avatarUrl = url;
        item.dataset.foto = url;

        const img =
          item.querySelector('img.avatar-img') ||
          item.querySelector('.avatar img') ||
          item.querySelector('.cliente-avatar img') ||
          item.querySelector('.chat-avatar img') ||
          item.querySelector('.foto img') ||
          item.querySelector('[data-role="avatar"] img') ||
          item.querySelector('img');

        if (img) {
          setImgSrc(img, url, id, kind);
          return;
        }

        const box =
          item.querySelector('.avatar') ||
          item.querySelector('.cliente-avatar') ||
          item.querySelector('.chat-avatar') ||
          item.querySelector('.foto') ||
          item.querySelector('[data-role="avatar"]');

        if (box) {
          putImgIntoBox(box, url, id, kind);
        }
      });
    } catch {}
  }

  function updateAgendaAvatar(id, url, kind) {
    if (kind !== 'cliente') return;

    try {
      document
        .querySelectorAll(`#agList .ag-item[data-id="${id}"]`)
        .forEach((item) => {
          item.dataset.avatar = url;

          const box = item.querySelector('.ag-avatar');
          if (box) {
            box.classList.remove('ag-avatar--default');

            const img = box.querySelector('img');
            if (img) {
              setImgSrc(img, url, id, kind);
            } else {
              putImgIntoBox(box, url, id, kind);
            }
          }
        });
    } catch {}
  }

  function updateDrawerAvatar(id, url, kind) {
    try {
      document
        .querySelectorAll([
          '[data-cliente-avatar]',
          '[data-role="cliente-avatar"]',
          '[data-group-avatar]',
          '[data-role="group-avatar"]',
          '.cliente-dados-avatar',
          '.perfil-avatar',
          '.contact-avatar',
          '.group-avatar',
          '.drawer-avatar',
        ].join(','))
        .forEach((box) => {
          const insideDrawer = box.closest(
            '#perfilDrawer, #contactDrawer, #grupoDrawer, #groupDrawer, .perfil-drawer, .contact-drawer, .grupo-drawer, .group-drawer, .drawer, aside'
          );

          if (!insideDrawer) return;

          const img = box.matches?.('img') ? box : box.querySelector('img');
          if (img) {
            setImgSrc(img, url, id, kind);
          }
        });
    } catch {}
  }

  function dispatchAvatarEvent(id, url, kind) {
    try {
      window.dispatchEvent(
        new CustomEvent(kind === 'grupo' ? 'zc:grupo-avatar-updated' : 'zc:cliente-avatar-updated', {
          detail: kind === 'grupo'
            ? { grupo_id: id, id, avatar_url: url, kind }
            : { cliente_id: id, id, avatar_url: url, kind },
        })
      );
    } catch {}
  }

  function applyAvatarGeneric(idRaw, avatarUrl = null, opts = {}) {
    const id = idFromAny(idRaw);
    if (!id) return;

    const kind = opts.kind === 'grupo' ? 'grupo' : 'cliente';
    const bust = !!opts.bust;
    const force = !!opts.force;

    const url = normalizeAvatarUrl(id, avatarUrl, { kind, bust });
    if (!url) return;

    const mapKey = `${kind}:${id}`;
    const last = lastAvatarUrlByKey.get(mapKey);

    if (!force && last && sameUrl(last, url)) {
      // Mesmo URL: ainda atualiza DOM porque a lista/header pode ter sido re-renderizado.
    } else {
      lastAvatarUrlByKey.set(mapKey, url);
    }

    updateSelectedState(id, url, kind);
    updateKnownCaches(id, url, kind);
    updateHeaderAvatar(id, url, kind, opts);
    updateListAvatar(id, url, kind, opts);
    updateAgendaAvatar(id, url, kind);
    updateDrawerAvatar(id, url, kind);
    dispatchAvatarEvent(id, url, kind);
  }

  function zcApplyAvatarEverywhere(clienteId, avatarUrl = null, opts = {}) {
    applyAvatarGeneric(clienteId, avatarUrl, {
      ...opts,
      kind: 'cliente',
    });
  }

  function zcApplyGroupAvatarEverywhere(grupoId, avatarUrl = null, opts = {}) {
    applyAvatarGeneric(grupoId, avatarUrl, {
      ...opts,
      kind: 'grupo',
    });
  }

  function scheduleAvatarSpread(idRaw, avatarUrl = null, opts = {}) {
    const id = idFromAny(idRaw);
    if (!id) return;

    const kind = opts.kind === 'grupo' ? 'grupo' : 'cliente';
    const key = `${kind}:${id}:${String(avatarUrl || '')}:${opts.bust ? 'bust' : 'stable'}`;

    if (avatarApplyTimers.has(key)) return;

    const timers = [];

    [80, 350].forEach((ms) => {
      const t = setTimeout(() => {
        try {
          applyAvatarGeneric(id, avatarUrl, {
            ...opts,
            kind,
            bust: !!opts.bust,
            force: ms === 350,
          });
        } catch {}
      }, ms);

      timers.push(t);
    });

    avatarApplyTimers.set(key, timers);

    setTimeout(() => {
      avatarApplyTimers.delete(key);
    }, 900);
  }

  window.zcAvatarProxyUrl = zcAvatarProxyUrl;
  window.zcApplyAvatarEverywhere = zcApplyAvatarEverywhere;
  window.zcApplyGroupAvatarEverywhere = zcApplyGroupAvatarEverywhere;

  function removeLegacyQuickProfile() {
    try { document.getElementById('btn-perfil')?.remove(); } catch {}
    try { document.getElementById('qcBackdrop')?.remove(); } catch {}
    try { document.getElementById('qcDrawer')?.remove(); } catch {}

    try {
      document.querySelectorAll('.qcBackdrop, .qcDrawer').forEach((el) => el.remove());
    } catch {}
  }

  function isBlockedTarget(target) {
    if (!target) return false;

    return !!target.closest([
      '.zc-chat-actions',
      '.zc-chat-header-actions',
      '.zc-chat-icon-btn',
      '#btn-chat-search',
      '#btn-chat-more',
      '.zc-transfer-top-btn',
      '.zc-chat-searchbar',
      '.zc-chat-more-menu',
      'button',
      'a',
      'input',
      'textarea',
      'select',
      '[data-no-profile="1"]',
    ].join(','));
  }

  function isOpenTarget(target) {
    if (!target) return false;

    return !!target.closest([
      '#chat-avatar',
      '#chat-avatar img',
      '#chat-avatar .avatar',
      '#chat-title',
      '#chat-header .title',
      '#chat-header .chat-title',
      '#chat-header [data-role="chat-title"]',
      '#chat-header [data-role="contact-name"]',
      '#chat-header [data-role="contact-avatar"]',
      '#chat-header .name',
      '#chat-header .user-name',
      '#chat-header .contact-name',
    ].join(','));
  }

  async function openGroupData() {
    const gid = getSelectedGroupId();
    if (!gid) return;

    scheduleAvatarSpread(gid, null, { kind: 'grupo', bust: false });

    const fns = [
      window.abrirGrupoAtual,
      window.abrirDadosGrupoAtual,
      window.abrirPerfilGrupoAtual,
      window.openGroupProfile,
      window.openGroupData,
    ];

    for (const fn of fns) {
      if (typeof fn !== 'function') continue;

      try {
        await fn({ grupo_id: gid, id: gid, conversation_key: getSelectedConversationKey() });
        return;
      } catch (err) {
        console.error('[perfil_quick] erro ao abrir dados do grupo:', err);
      }
    }

    try {
      document.dispatchEvent(
        new CustomEvent('zc:open-group-data', {
          detail: {
            grupo_id: gid,
            id: gid,
            conversation_key: getSelectedConversationKey(),
          },
        })
      );
    } catch {}
  }

  async function openContactData() {
    removeLegacyQuickProfile();

    if (!hasOpenChat()) return;

    if (getSelectedKind() === 'grupo') {
      await openGroupData();
      return;
    }

    if (typeof window.abrirPerfilAtual === 'function') {
      try {
        await window.abrirPerfilAtual({});
        return;
      } catch (err) {
        console.error('[perfil_quick] erro ao abrir dados do contato:', err);
      }
    }

    try {
      document.dispatchEvent(new CustomEvent('zc:open-contact-data', { detail: {} }));
    } catch {}
  }

  function applyClickableState() {
    const els = document.querySelectorAll([
      '#chat-avatar',
      '#chat-avatar img',
      '#chat-avatar .avatar',
      '#chat-title',
      '#chat-header .title',
      '#chat-header .chat-title',
      '#chat-header [data-role="chat-title"]',
      '#chat-header [data-role="contact-name"]',
      '#chat-header [data-role="contact-avatar"]',
      '#chat-header .name',
      '#chat-header .user-name',
      '#chat-header .contact-name',
    ].join(','));

    els.forEach((el) => {
      if (hasOpenChat()) {
        el.style.cursor = 'pointer';
        el.setAttribute('data-open-contact-drawer', '1');
      } else {
        el.style.cursor = '';
        el.removeAttribute('data-open-contact-drawer');
      }
    });
  }

  function bindHeaderOnce() {
    const hdr = document.getElementById('chat-header');
    if (!hdr || hdr.dataset.zcPerfilQuickBound === VERSION) return;

    hdr.dataset.zcPerfilQuickBound = VERSION;

    hdr.addEventListener('click', async (e) => {
      const t = e.target;
      if (!t) return;

      if (isBlockedTarget(t)) return;
      if (!isOpenTarget(t)) return;
      if (!hasOpenChat()) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();

      await openContactData();
    }, true);
  }

  function watchHeader() {
    const hdr = document.getElementById('chat-header');
    if (!hdr || hdr.__zcPerfilQuickObsVersion === VERSION) return;

    hdr.__zcPerfilQuickObsVersion = VERSION;

    try {
      if (hdr.__zcPerfilQuickObs) {
        hdr.__zcPerfilQuickObs.disconnect();
      }
    } catch {}

    let timer = null;

    const mo = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        removeLegacyQuickProfile();
        bindHeaderOnce();
        applyClickableState();
      }, 120);
    });

    mo.observe(hdr, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'data-conversation-key',
        'data-conversation-id',
        'data-conv-key',
        'data-cliente-id',
        'data-grupo-id',
        'data-instancia-id',
      ],
    });

    hdr.__zcPerfilQuickObs = mo;
  }

  function bindAvatarRefreshHooks() {
    if (window.__zcAvatarRefreshHooksBoundVersion === VERSION) return;
    window.__zcAvatarRefreshHooksBoundVersion = VERSION;

    [
      'zc:profile-updated',
      'zc:contact-profile-updated',
      'zc:contact-refreshed',
      'zc:perfil-atualizado',
      'cliente:profile-updated',
      'cliente:avatar-updated',
    ].forEach((evName) => {
      window.addEventListener(evName, (ev) => {
        const d = ev?.detail || {};

        const id =
          idFromAny(d.cliente_id) ||
          idFromAny(d.clienteId) ||
          idFromAny(d.id) ||
          idFromAny(d.entity_id) ||
          idFromAny(d.entityId) ||
          0;

        const url =
          d.avatar_url ||
          d.profile_avatar_url ||
          d.profilePictureUrl ||
          d.profile_picture_url ||
          d.avatar ||
          d.foto ||
          null;

        if (id) {
          scheduleAvatarSpread(id, url, {
            ...d,
            kind: 'cliente',
            bust: true,
          });
        }
      });
    });

    [
      'zc:group-profile-updated',
      'zc:group-refreshed',
      'zc:grupo-atualizado',
      'grupo:profile-updated',
      'grupo:avatar-updated',
    ].forEach((evName) => {
      window.addEventListener(evName, (ev) => {
        const d = ev?.detail || {};

        const id =
          idFromAny(d.grupo_id) ||
          idFromAny(d.grupoId) ||
          idFromAny(d.group_id) ||
          idFromAny(d.groupId) ||
          idFromAny(d.id) ||
          idFromAny(d.entity_id) ||
          idFromAny(d.entityId) ||
          0;

        const url =
          d.avatar_url ||
          d.group_avatar_url ||
          d.grupo_avatar_url ||
          d.profilePictureUrl ||
          d.profile_picture_url ||
          d.avatar ||
          d.foto ||
          null;

        if (id) {
          scheduleAvatarSpread(id, url, {
            ...d,
            kind: 'grupo',
            bust: true,
          });
        }
      });
    });

    const tryWrapClientRefresh = () => {
      const fn = window.refreshAvatarFromEvolution;
      if (typeof fn !== 'function') return false;
      if (fn.__zcWrappedAvatarRefreshVersion === VERSION) return true;

      const wrapped = async function (...args) {
        const fallbackId = idFromAny(args[0]);
        const resp = await fn.apply(this, args);

        const realId =
          idFromAny(resp?.cliente_id) ||
          idFromAny(resp?.clienteId) ||
          idFromAny(resp?.id) ||
          idFromAny(resp?.entity_id) ||
          idFromAny(resp?.entityId) ||
          fallbackId;

        const url =
          resp?.avatar_url ||
          resp?.profile_avatar_url ||
          resp?.profilePictureUrl ||
          resp?.profile_picture_url ||
          resp?.avatar ||
          resp?.foto ||
          null;

        if (realId) {
          scheduleAvatarSpread(realId, url, {
            ...(resp || {}),
            kind: 'cliente',
            bust: true,
          });
        }

        return resp;
      };

      wrapped.__zcWrappedAvatarRefreshVersion = VERSION;
      wrapped.__zcOriginal = fn;
      window.refreshAvatarFromEvolution = wrapped;
      return true;
    };

    const tryWrapGroupRefresh = () => {
      const names = [
        'refreshGroupAvatarFromEvolution',
        'refreshGrupoAvatarFromEvolution',
        'refreshGroupProfile',
        'refreshGrupoProfile',
      ];

      let wrappedAny = false;

      names.forEach((name) => {
        const fn = window[name];
        if (typeof fn !== 'function') return;
        if (fn.__zcWrappedGroupAvatarRefreshVersion === VERSION) {
          wrappedAny = true;
          return;
        }

        const wrapped = async function (...args) {
          const fallbackId = idFromAny(args[0]);
          const resp = await fn.apply(this, args);

          const realId =
            idFromAny(resp?.grupo_id) ||
            idFromAny(resp?.grupoId) ||
            idFromAny(resp?.group_id) ||
            idFromAny(resp?.groupId) ||
            idFromAny(resp?.id) ||
            idFromAny(resp?.entity_id) ||
            idFromAny(resp?.entityId) ||
            fallbackId;

          const url =
            resp?.avatar_url ||
            resp?.group_avatar_url ||
            resp?.grupo_avatar_url ||
            resp?.profilePictureUrl ||
            resp?.profile_picture_url ||
            resp?.avatar ||
            resp?.foto ||
            null;

          if (realId) {
            scheduleAvatarSpread(realId, url, {
              ...(resp || {}),
              kind: 'grupo',
              bust: true,
            });
          }

          return resp;
        };

        wrapped.__zcWrappedGroupAvatarRefreshVersion = VERSION;
        wrapped.__zcOriginal = fn;
        window[name] = wrapped;
        wrappedAny = true;
      });

      return wrappedAny;
    };

    if (!tryWrapClientRefresh() || !tryWrapGroupRefresh()) {
      const t = setInterval(() => {
        const ok1 = tryWrapClientRefresh();
        const ok2 = tryWrapGroupRefresh();

        if (ok1 && ok2) clearInterval(t);
      }, 900);

      setTimeout(() => clearInterval(t), 10000);
    }
  }

  function syncAfterConversationChange() {
    removeLegacyQuickProfile();
    bindHeaderOnce();
    watchHeader();
    applyClickableState();

    const kind = getSelectedKind();

    if (kind === 'grupo') {
      const gid = getSelectedGroupId();

      if (gid) {
        const sel = getStateSelected();
        const raw =
          sel?.group_avatar_url ||
          sel?.grupo_avatar_url ||
          sel?.avatar_url ||
          sel?.profilePictureUrl ||
          sel?.profile_pic_url ||
          sel?.avatar ||
          sel?.foto ||
          sel?.foto_url ||
          null;

        if (raw) {
          scheduleAvatarSpread(gid, raw, {
            kind: 'grupo',
            bust: false,
            conversation_key: getSelectedConversationKey(),
          });
        } else {
          clearHeaderAvatar(gid, 'grupo', {
            conversation_key: getSelectedConversationKey(),
          });
        }
      }

      return;
    }

    const cid = getSelectedClienteId();
    const sel = getStateSelected();

    const raw =
      sel?.avatar_url ||
      sel?.profilePictureUrl ||
      sel?.profile_pic_url ||
      sel?.avatar ||
      sel?.foto ||
      sel?.foto_url ||
      null;

    if (cid && raw) {
      scheduleAvatarSpread(cid, raw, {
        kind: 'cliente',
        bust: false,
        conversation_key: getSelectedConversationKey(),
      });
      return;
    }

    /*
      Ponto crítico:
      se a conversa atual não tem foto, limpa o header.
      Assim a foto da conversa anterior nunca fica presa.
    */
    if (cid) {
      clearHeaderAvatar(cid, 'cliente', {
        conversation_key: getSelectedConversationKey(),
      });
    }
  }

  function bindConversationEvents() {
    if (document.__zcPerfilQuickChatEventsBoundVersion === VERSION) return;
    document.__zcPerfilQuickChatEventsBoundVersion = VERSION;

    [
      'cliente:selecionar',
      'cliente:selecionado',
      'zc:cliente_sel',
      'zc:open_chat',
      'chat:open',
      'historico:rendered',
      'historico:ready',
    ].forEach((ev) => {
      document.addEventListener(ev, () => {
        setTimeout(syncAfterConversationChange, 80);
      });
    });

    [
      'atendimento:conversation-selected',
      'zc:conversation-selected',
      'zc:chat-selected',
    ].forEach((ev) => {
      window.addEventListener(ev, () => {
        setTimeout(syncAfterConversationChange, 80);
      });
    });

    window.addEventListener('load', () => {
      setTimeout(syncAfterConversationChange, 120);
    });

    window.addEventListener('resize', () => {
      applyClickableState();
    }, { passive: true });
  }

  function watchAppMount() {
    if (document.__zcPerfilQuickMountObsVersion === VERSION) return;
    document.__zcPerfilQuickMountObsVersion = VERSION;

    let timer = null;

    const mo = new MutationObserver((mutations) => {
      let relevant = false;

      for (const m of mutations) {
        for (const node of m.addedNodes || []) {
          if (!node || node.nodeType !== 1) continue;

          if (
            node.id === 'chat-header' ||
            node.id === 'chat-avatar' ||
            node.querySelector?.('#chat-header, #chat-avatar')
          ) {
            relevant = true;
            break;
          }
        }

        if (relevant) break;
      }

      if (!relevant) return;

      clearTimeout(timer);
      timer = setTimeout(() => {
        bindHeaderOnce();
        watchHeader();
        applyClickableState();
      }, 160);
    });

    try {
      mo.observe(document.body, {
        childList: true,
        subtree: true,
      });
    } catch {}
  }

  function start() {
    removeLegacyQuickProfile();
    bindHeaderOnce();
    bindConversationEvents();
    bindAvatarRefreshHooks();
    watchHeader();
    watchAppMount();
    applyClickableState();

    setTimeout(syncAfterConversationChange, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  window.abrirPerfilRapido = openContactData;
  window.openQuickProfile = openContactData;
})();