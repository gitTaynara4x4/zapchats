// /frontend/js/atendimentos/ui/lista-active-sync.js
// Mantém a conversa aberta marcada na lista lateral.
// Também copia a cor do avatar padrão da lista para o avatar do header.
// Corrigido: nunca pinta o wrapper #chat-avatar, só a bolinha interna.

(function () {
  'use strict';

  const VERSION = 'zc-lista-active-sync-v5-no-mutation-loop';

  if (window.__ZC_LISTA_ACTIVE_SYNC__ === VERSION) return;
  window.__ZC_LISTA_ACTIVE_SYNC__ = VERSION;

  const AVATAR_COLOR_CLASSES = [
    'avatar-color-1',
    'avatar-color-2',
    'avatar-color-3',
    'avatar-color-4',
    'avatar-color-5',
    'avatar-color-6',
  ];

  // Evita loop mortal:
  // observer da lista via mudança de class -> sync -> muda class -> observer -> sync...
  let isSyncingActiveList = false;
  let scheduledTimer = 0;

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function $all(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function clean(v) {
    return String(v ?? '').trim();
  }

  function valid(v) {
    const s = clean(v);
    if (!s) return '';
    if (['null', 'undefined', 'nan', '0', 'all', 'todos', '*', '-'].includes(s.toLowerCase())) return '';
    return s;
  }

  function numId(v) {
    const s = clean(v);
    if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return '';
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? String(n) : '';
  }

  function parseConversationKey(raw) {
    const s = clean(raw);
    if (!s) return null;

    const m = s.match(/^([cg]):(\d+):([^:]+)$/i);
    if (!m) return null;

    return {
      key: `${m[1].toLowerCase()}:${m[2]}:${m[3]}`,
      kind: m[1].toLowerCase(),
      entityId: m[2],
      instId: valid(m[3]),
    };
  }

  function buildConversationKey(kind, entityId, instId) {
    const k = String(kind || '').toLowerCase() === 'g' ? 'g' : 'c';
    const eid = numId(entityId);
    const iid = valid(instId);

    if (!eid) return '';
    return `${k}:${eid}:${iid || '0'}`;
  }

  function datasetOf(el) {
    return el && el.dataset ? el.dataset : {};
  }

  function inferKindFromDataset(ds) {
    const explicit = clean(
      ds.kind ||
      ds.conversationKind ||
      ds.tipoConversa ||
      ds.tipo ||
      ''
    ).toLowerCase();

    if (['g', 'grupo', 'group'].includes(explicit)) return 'g';
    if (['c', 'cliente', 'contato'].includes(explicit)) return 'c';

    if (
      ds.grupoId ||
      ds.groupId ||
      ds.isGroup === '1' ||
      ds.isGroup === 'true' ||
      ds.grupo === '1' ||
      ds.grupo === 'true'
    ) {
      return 'g';
    }

    return 'c';
  }

  function getCurrentSelectedObject() {
    return (
      window.state?.clienteSel ||
      window.clienteSel ||
      window.__ZC_CONVERSA_ATUAL ||
      window.__zcConversaAtual ||
      window.__zcSelectedConversation ||
      window.__ZC_SELECTED_CONVERSATION ||
      null
    );
  }

  function getCurrentFromDom() {
    const hist = $('#historico');
    const head = $('#chat-header');

    const histDs = datasetOf(hist);
    const headDs = datasetOf(head);

    const rawKey =
      valid(histDs.conversationKey) ||
      valid(histDs.conversationId) ||
      valid(histDs.chatKey) ||
      valid(histDs.convKey) ||
      valid(headDs.conversationKey) ||
      valid(headDs.conversationId) ||
      valid(headDs.chatKey) ||
      valid(headDs.convKey) ||
      '';

    const parsed = parseConversationKey(rawKey);
    if (parsed) return parsed;

    const kind = inferKindFromDataset(histDs) || inferKindFromDataset(headDs);

    const entityId =
      numId(histDs.entityId) ||
      numId(histDs.clienteId) ||
      numId(histDs.grupoId) ||
      numId(histDs.id) ||
      numId(headDs.entityId) ||
      numId(headDs.clienteId) ||
      numId(headDs.grupoId) ||
      numId(headDs.id) ||
      numId(window.CLIENTE_ID_ATUAL) ||
      numId(window.currentClienteId) ||
      '';

    const instId =
      valid(histDs.instanciaId) ||
      valid(histDs.instancia) ||
      valid(headDs.instanciaId) ||
      valid(headDs.instancia) ||
      valid(window.INSTANCIA_ATIVA) ||
      '';

    const key = buildConversationKey(kind, entityId, instId);
    return key ? parseConversationKey(key) : null;
  }

  function getCurrentFromState() {
    const sel = getCurrentSelectedObject();
    if (!sel || typeof sel !== 'object') return null;

    const rawKey =
      valid(sel.conversation_key) ||
      valid(sel.conversationKey) ||
      valid(sel.conversation_id) ||
      valid(sel.conversationId) ||
      valid(sel.chat_key) ||
      valid(sel.chatKey) ||
      valid(sel.conv_key) ||
      valid(sel.convKey) ||
      valid(sel.key) ||
      '';

    const parsed = parseConversationKey(rawKey);
    if (parsed) return parsed;

    const kind =
      sel.kind === 'g' ||
      sel.tipo_conversa === 'grupo' ||
      sel.is_group === true ||
      sel.grupo === true ||
      sel.grupo_id
        ? 'g'
        : 'c';

    const entityId =
      numId(sel.entity_id) ||
      numId(sel.entityId) ||
      numId(sel.backend_id) ||
      numId(sel.cliente_id) ||
      numId(sel.clienteId) ||
      numId(sel.grupo_id) ||
      numId(sel.grupoId) ||
      numId(sel.id) ||
      '';

    const instId =
      valid(sel.instancia_id) ||
      valid(sel.instanciaId) ||
      valid(sel.instancia) ||
      valid(sel.instance_name) ||
      valid(sel.instance) ||
      valid(window.INSTANCIA_ATIVA) ||
      '';

    const key = buildConversationKey(kind, entityId, instId);
    return key ? parseConversationKey(key) : null;
  }

  function getCurrentRef() {
    return getCurrentFromDom() || getCurrentFromState();
  }

  function getItemRef(el) {
    const ds = datasetOf(el);

    const rawKey =
      valid(ds.conversationKey) ||
      valid(ds.conversationId) ||
      valid(ds.chatKey) ||
      valid(ds.convKey) ||
      valid(ds.key) ||
      '';

    const parsed = parseConversationKey(rawKey);
    if (parsed) return parsed;

    const kind = inferKindFromDataset(ds);

    const entityId =
      numId(ds.entityId) ||
      numId(ds.backendId) ||
      numId(ds.clienteId) ||
      numId(ds.cliente) ||
      numId(ds.grupoId) ||
      numId(ds.groupId) ||
      numId(ds.apiId) ||
      numId(ds.id) ||
      '';

    const instId =
      valid(ds.instanciaId) ||
      valid(ds.instancia) ||
      valid(ds.instanceName) ||
      valid(ds.instance) ||
      '';

    const key = buildConversationKey(kind, entityId, instId);
    return key ? parseConversationKey(key) : null;
  }

  function sameConversation(a, b) {
    if (!a || !b) return false;

    if (a.key && b.key && a.key === b.key) return true;
    if (!a.entityId || !b.entityId) return false;
    if ((a.kind || 'c') !== (b.kind || 'c')) return false;

    const ai = valid(a.instId);
    const bi = valid(b.instId);

    if (ai && bi && ai !== bi) return false;
    return a.entityId === b.entityId;
  }

  function getListItems() {
    const list = $('#lista-clientes');
    if (!list) return [];

    return $all('li, .chat-item, .cliente-item, .conversa-item', list)
      .filter((el, idx, arr) => arr.indexOf(el) === idx)
      .filter((el) => {
        if (el.classList.contains('load-more-item')) return false;
        if (el.classList.contains('empty-chat-list')) return false;
        return true;
      });
  }

  function hasAnyActiveClass(el) {
    return !!(
      el &&
      (
        el.classList.contains('active') ||
        el.classList.contains('ativo') ||
        el.classList.contains('is-active') ||
        el.classList.contains('chat-active') ||
        el.classList.contains('selected') ||
        el.classList.contains('is-selected') ||
        el.getAttribute('aria-current') === 'true' ||
        el.getAttribute('aria-selected') === 'true'
      )
    );
  }

  function clearActive(exceptEl = null) {
    getListItems().forEach((el) => {
      if (!el || el === exceptEl) return;
      if (!hasAnyActiveClass(el)) return;

      el.classList.remove(
        'active',
        'ativo',
        'is-active',
        'chat-active',
        'selected',
        'is-selected'
      );

      if (el.hasAttribute('aria-current')) el.removeAttribute('aria-current');
      if (el.getAttribute('aria-selected') !== 'false') el.setAttribute('aria-selected', 'false');
    });
  }

  function markElementActive(el) {
    if (!el) return;

    if (!el.classList.contains('active')) el.classList.add('active');
    if (!el.classList.contains('is-active')) el.classList.add('is-active');
    if (!el.classList.contains('chat-active')) el.classList.add('chat-active');
    if (el.getAttribute('aria-current') !== 'true') el.setAttribute('aria-current', 'true');
    if (el.getAttribute('aria-selected') !== 'true') el.setAttribute('aria-selected', 'true');
  }

  function getAvatarColorClassFromItem(item) {
    if (!item) return '';

    for (const cls of AVATAR_COLOR_CLASSES) {
      if (item.classList.contains(cls)) return cls;
    }

    const avatar = item.querySelector('.avatar, .cliente-avatar, .chat-avatar');
    if (avatar) {
      for (const cls of AVATAR_COLOR_CLASSES) {
        if (avatar.classList.contains(cls)) return cls;
      }
    }

    return '';
  }

  function getListAvatarElement(item) {
    if (!item) return null;

    return (
      item.querySelector('.avatar.placeholder') ||
      item.querySelector('.avatar.avatar-default') ||
      item.querySelector('.avatar') ||
      item.querySelector('.cliente-avatar') ||
      item.querySelector('.chat-avatar') ||
      null
    );
  }

  function readComputedAvatarColors(item) {
    const avatar = getListAvatarElement(item);
    if (!avatar) return null;

    const cs = window.getComputedStyle(avatar);
    const background = cs.backgroundColor || '';
    const color = cs.color || '';

    if (!background || background === 'rgba(0, 0, 0, 0)' || background === 'transparent') {
      return null;
    }

    return { background, color };
  }

  function clearHeaderAvatarColorClasses() {
    const chatAvatar = document.getElementById('chat-avatar');
    const chatHeader = document.getElementById('chat-header');

    [chatAvatar, chatHeader].forEach((el) => {
      if (!el) return;
      AVATAR_COLOR_CLASSES.forEach((cls) => el.classList.remove(cls));
    });
  }

  function clearHeaderInlineAvatarStyles() {
    const wrap = document.getElementById('chat-avatar');
    if (wrap) {
      wrap.style.backgroundColor = '';
      wrap.style.color = '';
      wrap.style.borderRadius = '';
      wrap.style.overflow = '';
    }

    const inner = wrap?.querySelector('.avatar');
    if (inner) {
      inner.style.backgroundColor = '';
      inner.style.color = '';
      inner.style.borderRadius = '';
      inner.style.overflow = '';
    }
  }

  function getHeaderAvatarInner() {
    const wrap = document.getElementById('chat-avatar');
    if (!wrap) return null;

    return (
      wrap.querySelector('.avatar.placeholder') ||
      wrap.querySelector('.avatar.avatar-default') ||
      wrap.querySelector('.avatar') ||
      null
    );
  }

  function headerHasPhoto() {
    const wrap = document.getElementById('chat-avatar');
    if (!wrap) return false;
    return !!wrap.querySelector('img');
  }

  function applyAvatarColorToHeaderFromItem(item) {
    if (!item) return;

    const colorClass = getAvatarColorClassFromItem(item);
    const computed = readComputedAvatarColors(item);

    const chatAvatar = document.getElementById('chat-avatar');
    const chatHeader = document.getElementById('chat-header');

    clearHeaderAvatarColorClasses();
    clearHeaderInlineAvatarStyles();

    [chatAvatar, chatHeader].forEach((el) => {
      if (!el) return;
      if (colorClass) el.classList.add(colorClass);
    });

    if (headerHasPhoto()) return;

    const inner = getHeaderAvatarInner();
    if (!inner) return;

    if (computed) {
      inner.style.backgroundColor = computed.background;
      inner.style.color = computed.color;
    }

    inner.style.borderRadius = '50%';
    inner.style.overflow = 'hidden';
  }

  function syncActiveListItem() {
    const current = getCurrentRef();
    if (!current) return;

    const items = getListItems();
    if (!items.length) return;

    let found = null;

    for (const item of items) {
      const ref = getItemRef(item);
      if (sameConversation(ref, current)) {
        found = item;
        break;
      }
    }

    if (isSyncingActiveList) return;

    try {
      isSyncingActiveList = true;

      clearActive(found);

      if (found) {
        markElementActive(found);
        applyAvatarColorToHeaderFromItem(found);
      }
    } finally {
      setTimeout(() => { isSyncingActiveList = false; }, 0);
    }
  }

  function scheduleSync(ms = 0) {
    const delay = Math.max(0, Number(ms || 0));

    if (scheduledTimer) {
      clearTimeout(scheduledTimer);
      scheduledTimer = 0;
    }

    scheduledTimer = setTimeout(() => {
      scheduledTimer = 0;
      syncActiveListItem();
    }, delay);
  }

  function bindEvents() {
    const events = [
      'cliente:selecionar',
      'cliente:selecionado',
      'zc:cliente_sel',
      'zc:conversation-opened',
      'zc:conversation-changed',
      'zc:conversation-selected',
      'zc:conversa-aberta',
      'zc:conversa-atualizada',
      'zc:historico-rendered',
      'historico:ready',
      'historico:rendered',
      'zc:lista-renderizada',
      'zc:atendimentos-ready',
    ];

    events.forEach((name) => {
      window.addEventListener(name, () => {
        scheduleSync(0);
        scheduleSync(80);
        scheduleSync(250);
        scheduleSync(600);
        scheduleSync(1200);
      });

      document.addEventListener(name, () => {
        scheduleSync(0);
        scheduleSync(80);
        scheduleSync(250);
        scheduleSync(600);
        scheduleSync(1200);
      });
    });

    document.addEventListener('click', (ev) => {
      const item = ev.target.closest?.(
        '#lista-clientes li, #lista-clientes .chat-item, #lista-clientes .cliente-item, #lista-clientes .conversa-item'
      );

      if (!item) return;

      try {
        isSyncingActiveList = true;
        clearActive(item);
        markElementActive(item);
        applyAvatarColorToHeaderFromItem(item);
      } finally {
        setTimeout(() => { isSyncingActiveList = false; }, 0);
      }

      scheduleSync(250);
    }, true);

    const list = $('#lista-clientes');
    if (list) {
      const obs = new MutationObserver(() => {
        if (isSyncingActiveList) return;
        scheduleSync(120);
      });

      obs.observe(list, {
        childList: true,
        subtree: false,
        attributes: true,
        // Não observar class: este próprio módulo muda classes active/is-active.
        // Observar class aqui criava loop infinito e fazia a aba bater 3GB/5GB.
        attributeFilter: [
          'data-conversation-key',
          'data-conversation-id',
          'data-chat-key',
          'data-cliente-id',
          'data-grupo-id',
          'data-instancia-id',
        ],
      });
    }

    // Removido observer do header.
    // Ele observava class/subtree e o próprio sync mudava classe/estilo do avatar,
    // gerando repaint e loops em algumas máquinas. Eventos acima já cobrem troca de conversa.
  }

  function init() {
    bindEvents();

    scheduleSync(0);
    scheduleSync(300);
    scheduleSync(900);
    scheduleSync(1500);

    window.zcSyncListaConversaAtiva = syncActiveListItem;

    try {
      console.info('[ZapsChat][lista-active-sync] carregado:', VERSION);
    } catch {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();