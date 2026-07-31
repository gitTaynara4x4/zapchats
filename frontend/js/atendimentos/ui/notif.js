//frontend\js\atendimentos\ui\notif.js
// som/prime, fallback beep, Web Notifications e badge global (recomputeUnread)
// ✅ sem CSS inline no JS
// ✅ alinhado com conversation_key canônica:
//    c:<cliente_id>:<instancia_id> e g:<grupo_id>:<instancia_id>
// ✅ nunca usa Number(...) direto em conversation_id composto
// ✅ POST /seen usa entity_id da conversa
// ✅ comparação de conversa exige a ref completa (ou kind + entity_id + instância)

(function () {
  const DESKTOP_NOTIF_ICON = '/favicon-192.png';

  /* ==================== Áudio (prime + fallback) ==================== */
  const AUDIO_SOURCES = [
    '/frontend/img/whatsapp-short-ringtone.mp3',
    '/img/whatsapp-short-ringtone.mp3',
    '/frontend/audio/whatsapp-short-ringtone.mp3'
  ];

  let __audioSrcIdx = 0;
  const audioNotificacao = new Audio(AUDIO_SOURCES[__audioSrcIdx]);
  audioNotificacao.preload = 'auto';
  audioNotificacao.volume = 0.6;

  let __audioPrimed = false;

  function primeNotificationAudioOnce() {
    if (__audioPrimed) return;
    __audioPrimed = true;

    try {
      audioNotificacao.muted = true;
      audioNotificacao.currentTime = 0;

      audioNotificacao.play()
        .then(() => {
          setTimeout(() => {
            try {
              audioNotificacao.pause();
              audioNotificacao.currentTime = 0;
            } catch {}
            audioNotificacao.muted = false;
          }, 30);
        })
        .catch(() => {
          __audioPrimed = false;
        });
    } catch {
      __audioPrimed = false;
    }
  }

  ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((ev) => {
    document.addEventListener(ev, primeNotificationAudioOnce, {
      once: true,
      capture: true
    });
  });

  audioNotificacao.addEventListener('error', () => {
    if (__audioSrcIdx < AUDIO_SOURCES.length - 1) {
      __audioSrcIdx += 1;
      audioNotificacao.src = AUDIO_SOURCES[__audioSrcIdx];
      audioNotificacao.load();
    }
  });

  async function playBeepFallback() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;

      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();

      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.value = 0.06;

      o.connect(g);
      g.connect(ctx.destination);
      o.start();

      setTimeout(() => {
        try { o.stop(); } catch {}
        try { ctx.close(); } catch {}
      }, 180);
    } catch {}
  }

  /* ==================== Toast ==================== */
  function ensureToastEl() {
    let t = document.getElementById('__app_toast');
    if (t) return t;

    t = document.createElement('div');
    t.id = '__app_toast';
    t.className = 'zc-inline-toast';
    document.body.appendChild(t);
    return t;
  }

  function toast(msg, ok = true, ms = 1600) {
    const t = ensureToastEl();

    t.textContent = String(msg || '');
    t.classList.toggle('is-error', !ok);
    t.classList.add('on');

    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => {
      t.classList.remove('on');
    }, Math.max(1200, Number(ms) || 1600));
  }

  /* ==================== Helpers de conversa ==================== */
  function idKey(v) {
    const s = String(v ?? '').trim();
    if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
    return s;
  }

  function instKey(v) {
    const s = String(v ?? '').trim();
    if (!s) return null;
    if (['null', 'undefined', 'nan', '0', 'all', '*', '-'].includes(s.toLowerCase())) return null;
    return s;
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

    if (obj.is_group === true || obj.grupo === true || obj.isGroup === true || obj.grupo_id != null) {
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
      if (d && /^\d+$/.test(d)) return d;
    }

    const s = idKey(raw);
    if (s && /^\d+$/.test(s)) return s;

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

  function kindFromAny(raw, row = null) {
    const parsed = parseConversationKey(raw);
    if (parsed?.kind) return parsed.kind;
    if (row && typeof row === 'object') return kindFromObject(row);
    return 'c';
  }

  function conversationRefOf(raw, row = null) {
    if (raw && typeof raw === 'object') {
      const obj = raw;

      const fromStoreHelper = typeof window.getConversationKey === 'function'
        ? window.getConversationKey(
            obj.conversation_key ?? obj.conversation_id ?? obj.id ?? obj.cliente_id ?? obj.grupo_id ?? null,
            obj,
            obj.instancia_id ?? obj.instancia ?? obj.instance_name ?? null
          )
        : null;

      const parsedStore = parseConversationKey(fromStoreHelper);
      if (parsedStore) return parsedStore;

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

    const fromStoreHelper = typeof window.getConversationKey === 'function'
      ? window.getConversationKey(raw, row || null, row?.instancia_id ?? row?.instancia ?? null)
      : null;

    const parsedStore = parseConversationKey(fromStoreHelper);
    if (parsedStore) return parsedStore;

    const parsed = parseConversationKey(raw);
    if (parsed) return parsed;

    const kind = kindFromAny(raw, row);
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

    if (!A?.key || !B?.key) return false;
    if (A.key === B.key) return true;

    if (!A.entityId || !B.entityId) return false;
    if ((A.kind || 'c') !== (B.kind || 'c')) return false;

    const aInst = A.instId || '';
    const bInst = B.instId || '';
    if (aInst && bInst) return A.entityId === B.entityId && aInst === bInst;

    return A.entityId === B.entityId && aInst === bInst;
  }

  function getSelectedConversationRef() {
    try {
      const hist = document.getElementById('historico');
      const head = document.getElementById('chat-header');

      const raw =
        idKey(hist?.dataset?.conversationKey) ||
        idKey(hist?.dataset?.clienteId) ||
        idKey(head?.dataset?.conversationKey) ||
        idKey(window.state?.clienteSel?.conversation_key) ||
        idKey(window.state?.clienteSel?.conversation_id) ||
        idKey(window.state?.clienteSel?.id) ||
        idKey(window.clienteSel?.conversation_key) ||
        idKey(window.clienteSel?.conversation_id) ||
        idKey(window.clienteSel?.id) ||
        null;

      return conversationRefOf(raw, window.state?.clienteSel || window.clienteSel || null).key || null;
    } catch {
      return null;
    }
  }

  function getSelectedEntityId() {
    try {
      const hist = document.getElementById('historico');
      const head = document.getElementById('chat-header');
      const row = window.state?.clienteSel || window.clienteSel || null;

      const direct =
        idKey(hist?.dataset?.entityId) ||
        idKey(head?.dataset?.entityId) ||
        idKey(row?.entity_id) ||
        idKey(row?.backend_id) ||
        idKey(row?.api_id) ||
        null;

      if (direct && /^\d+$/.test(direct)) return direct;

      const ref = conversationRefOf(getSelectedConversationRef(), row);
      return ref.entityId || null;
    } catch {
      return null;
    }
  }

  function getSelectedKind() {
    try {
      const hist = document.getElementById('historico');
      const head = document.getElementById('chat-header');
      const row = window.state?.clienteSel || window.clienteSel || null;

      const direct =
        idKey(hist?.dataset?.kind) ||
        idKey(head?.dataset?.kind) ||
        idKey(row?.kind) ||
        null;

      if (direct && /^(c|g)$/i.test(direct)) return direct.toLowerCase();

      const ref = conversationRefOf(getSelectedConversationRef(), row);
      return ref.kind || 'c';
    } catch {
      return 'c';
    }
  }

  /* ==================== Contexto ativo ==================== */
  function isChatActive(clienteId) {
    try {
      const openRef = getSelectedConversationRef();
      const incomingRef = conversationRefOf(clienteId, typeof clienteId === 'object' ? clienteId : null).key;
      const hist = document.getElementById('historico');
      const visible = !!hist && hist.style.display !== 'none';
      const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;

      return sameConversation(openRef, incomingRef) && visible && focused;
    } catch {
      return false;
    }
  }

  /* ==================== Som ==================== */
  function notificationSoundEnabled() {
    try {
      return localStorage.getItem('zc:notify:sound_enabled') !== '0';
    } catch {
      return true;
    }
  }

  function alwaysBeepEnabled() {
    try {
      return localStorage.getItem('zc:notify:always_beep') === '1';
    } catch {
      return false;
    }
  }

  function tocarNotificacao(clienteId) {
    if (!notificationSoundEnabled()) return;

    if (alwaysBeepEnabled() || document.hidden || !isChatActive(clienteId)) {
      try {
        audioNotificacao.currentTime = 0;
      } catch {}

      audioNotificacao.play().catch(playBeepFallback);

      try {
        if (navigator.vibrate) navigator.vibrate(40);
      } catch {}
    }
  }

  /* ==================== Web Notifications ==================== */
  function canNotifyDesktop() {
    return 'Notification' in window;
  }

  async function ensureNotifPermission() {
    if (!canNotifyDesktop()) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;

    try {
      const r = await Notification.requestPermission();
      return r === 'granted';
    } catch {
      return false;
    }
  }

  function desktopNotificationsEnabled() {
    try {
      const raw = localStorage.getItem('zc:notify:desktop_enabled');
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch {}

    return canNotifyDesktop() && Notification.permission === 'granted';
  }

  async function showDesktopNotification({ title, body, icon, tag, data } = {}) {
    if (!desktopNotificationsEnabled()) return;
    if (data?.clienteId && isChatActive(data.clienteId) && !document.hidden) return;
    if (!(await ensureNotifPermission())) return;

    try {
      const n = new Notification(title || 'Nova mensagem', {
        body: body || '',
        icon: icon || DESKTOP_NOTIF_ICON,
        badge: icon || DESKTOP_NOTIF_ICON,
        tag: tag || ('msg-' + Date.now()),
        renotify: true,
        silent: true
      });

      n.onclick = () => {
        try { window.focus(); } catch {}

        if (data?.clienteId && typeof window.selecionarClienteObj === 'function') {
          window.selecionarClienteObj(data.clienteId);
        }

        n.close();
      };

      setTimeout(() => {
        try { n.close(); } catch {}
      }, 8000);
    } catch {}
  }

  /* ==================== Badge global (título + opcional) ==================== */
  let __titleBase = document.title.replace(/^\(\d+\)\s*/, '');

  function setAppUnread(total) {
    const unread = Math.max(0, Number(total) || 0);
    document.title = unread > 0 ? `(${unread}) ${__titleBase}` : __titleBase;

    const badgeEl = document.getElementById('notif-badge');
    if (badgeEl) {
      badgeEl.textContent = unread > 99 ? '99+' : (unread ? String(unread) : '');
      badgeEl.style.display = unread ? '' : 'none';
    }
  }

  function getClientesCache() {
    if (Array.isArray(window.state?.clientesCache)) return window.state.clientesCache;
    if (Array.isArray(window.clientesCache)) return window.clientesCache;
    return [];
  }

  function recomputeUnread() {
    try {
      const arr = getClientesCache();
      const total = arr.reduce((acc, c) => acc + (Number(c?.novas) || 0), 0);
      setAppUnread(total);
    } catch {
      setAppUnread(0);
    }
  }

  /* ==================== Exports globais ==================== */
  window.tocarNotificacao = tocarNotificacao;
  window.showDesktopNotification = showDesktopNotification;
  window.setAppUnread = setAppUnread;
  window.recomputeUnread = recomputeUnread;
  window.isChatActiveForNotif = isChatActive;

  /* ==================== Auto-limpeza ao foco/visível ==================== */
  const ZC_NOTIF_SEEN_FOCUS_DEBOUNCE_MS = Number(window.ZC_NOTIF_SEEN_FOCUS_DEBOUNCE_MS || 1600);
  let __zcNotifSeenTimer = 0;
  let __zcNotifSeenLastAt = 0;

  function isAtendimentoLeaving() {
    try {
      return Boolean(
        window.__ZC_ATENDIMENTOS_NAVIGATING_AWAY__ === true ||
        window.__ZC_APP_NAVIGATING_AWAY__ === true ||
        document.body?.dataset?.zcLeaving === '1' ||
        document.documentElement?.dataset?.zcLeaving === '1'
      );
    } catch {
      return false;
    }
  }

  function scheduleClearUnreadOfOpenChat(reason = 'focus') {
    try {
      if (isAtendimentoLeaving()) return;
      clearTimeout(__zcNotifSeenTimer);
      __zcNotifSeenTimer = setTimeout(() => {
        if (isAtendimentoLeaving()) return;
        clearUnreadOfOpenChatAndPingServer(reason);
      }, ZC_NOTIF_SEEN_FOCUS_DEBOUNCE_MS);
    } catch {}
  }

  try {
    window.addEventListener('zc:navigate-away', () => {
      try { clearTimeout(__zcNotifSeenTimer); } catch {}
    }, true);
    window.addEventListener('pagehide', () => {
      try { clearTimeout(__zcNotifSeenTimer); } catch {}
    }, true);
    window.addEventListener('beforeunload', () => {
      try { clearTimeout(__zcNotifSeenTimer); } catch {}
    }, true);
  } catch {}

  async function clearUnreadOfOpenChatAndPingServer(reason = 'manual') {
    try {
      const selectedRef = getSelectedConversationRef();
      const selectedKind = getSelectedKind();
      const entityId = getSelectedEntityId();

      if (isAtendimentoLeaving()) return;
      if (!selectedRef || !entityId) return;

      // seen atual só é para cliente
      if (selectedKind !== 'c') {
        recomputeUnread();
        return;
      }

      const empresaIdRaw =
        window.EMPRESA_ID ||
        localStorage.getItem('empresa_id') ||
        0;

      const EMPRESA_ID = Number(empresaIdRaw || 0);
      if (!EMPRESA_ID) return;

      const arr = getClientesCache();

      const cl = arr.find((x) => sameConversation(x, selectedRef));

      const hadUnread = Boolean(cl && Number(cl.novas || 0) > 0);

      if (cl && Number(cl.novas || 0) > 0) {
        cl.novas = 0;

        try { window.salvarCache?.(); } catch {}
        try { window.persist?.(); } catch {}
        try { window.renderListaClientes?.(getClientesCache()); } catch {}

        recomputeUnread();
      }

      // Não faz POST paralelo próprio. Usa o markChatAsSeen centralizado do boot/init.js,
      // que tem dedupe + timeout + abort no navigate-away. Isso evita 3 ou 4 /seen
      // pendurados segurando pagehide quando o usuário sai do Atendimento.
      if (!hadUnread && reason !== 'force') return;

      const now = Date.now();
      if (now - __zcNotifSeenLastAt < 5000) return;
      __zcNotifSeenLastAt = now;

      if (typeof window.zcMarkChatAsSeen === 'function') {
        await window.zcMarkChatAsSeen(selectedRef, cl || null).catch(() => null);
      }
    } catch {}
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleClearUnreadOfOpenChat('visibility');
  });

  window.addEventListener('focus', () => {
    scheduleClearUnreadOfOpenChat('focus');
    recomputeUnread();
  }, { passive: true });

  setTimeout(recomputeUnread, 300);

  /* ==================== API opcional de toast ==================== */
  window.zcNotifyToast = toast;
})();