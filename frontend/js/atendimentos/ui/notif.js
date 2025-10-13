// /frontend/js/atendimentos/ui/notif.js
// som/prime, fallback beep, Web Notifications e badge global (recomputeUnread)

(function(){
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
            try { audioNotificacao.pause(); audioNotificacao.currentTime = 0; } catch {}
            audioNotificacao.muted = false;
          }, 30);
        })
        .catch(() => { __audioPrimed = false; });
    } catch { __audioPrimed = false; }
  }
  ['pointerdown','touchstart','click','keydown'].forEach(ev =>
    document.addEventListener(ev, primeNotificationAudioOnce, { once: true, capture: true })
  );

  audioNotificacao.addEventListener('error', () => {
    if (__audioSrcIdx < AUDIO_SOURCES.length - 1) {
      __audioSrcIdx++;
      audioNotificacao.src = AUDIO_SOURCES[__audioSrcIdx];
      audioNotificacao.load();
    }
  });

  async function playBeepFallback() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.06;
      o.connect(g); g.connect(ctx.destination);
      o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 180);
    } catch {}
  }

  /* ==================== Contexto ativo ==================== */
  function isChatActive(clienteId){
    try{
      const openId  = window.clienteSel?.id || window.state?.clienteSel?.id || null;
      const hist    = document.getElementById('historico');
      const visible = !!hist && hist.style.display !== 'none';
      const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
      return Number(openId) === Number(clienteId) && visible && focused;
    }catch{ return false; }
  }

  /* ==================== Som ==================== */
  function tocarNotificacao(clienteId) {
    // só toca se NÃO estiver na conversa ativa e/ou a aba estiver oculta
    if (document.hidden || !isChatActive(clienteId)) {
      try { audioNotificacao.currentTime = 0; } catch {}
      audioNotificacao.play().catch(playBeepFallback);
      try { navigator.vibrate && navigator.vibrate(40); } catch {}
    }
  }

  /* ==================== Web Notifications ==================== */
  function canNotifyDesktop(){ return 'Notification' in window; }
  async function ensureNotifPermission(){
    if (!canNotifyDesktop()) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      const r = await Notification.requestPermission();
      return r === 'granted';
    } catch { return false; }
  }
  async function showDesktopNotification({ title, body, icon, tag, data }){
    // se conversa ativa e foco → nem mostra desktop notification
    if (data?.clienteId && isChatActive(data.clienteId) && !document.hidden) return;

    if (!(await ensureNotifPermission())) return;
    try{
      const n = new Notification(title || 'Nova mensagem', {
        body: body || '',
        icon: icon || DESKTOP_NOTIF_ICON,
        badge: icon || DESKTOP_NOTIF_ICON,
        tag: tag || ('msg-'+Date.now()),
        renotify: true,
        silent: true
      });
      n.onclick = () => {
        try{ window.focus(); }catch{}
        if (data?.clienteId && typeof window.selecionarClienteObj === 'function') {
          window.selecionarClienteObj(data.clienteId);
        }
        n.close();
      };
      setTimeout(()=> n.close(), 8000);
    }catch{}
  }

  /* ==================== Badge global (título + opcional) ==================== */
  let __titleBase = document.title.replace(/^\(\d+\)\s*/, '');
  function setAppUnread(total){
    const unread = Math.max(0, Number(total)||0);
    document.title = unread > 0 ? `(${unread}) ${__titleBase}` : __titleBase;

    // opcional: badge num header (se existir)
    const badgeEl = document.getElementById('notif-badge');
    if (badgeEl){
      badgeEl.textContent = unread > 99 ? '99+' : (unread ? String(unread) : '');
      badgeEl.style.display = unread ? '' : 'none';
    }
  }

  // soma c.novas do cache atual (state ou window)
  function recomputeUnread(){
    try{
      const arr = Array.isArray(window.state?.clientesCache) ? window.state.clientesCache
                : Array.isArray(window.clientesCache) ? window.clientesCache
                : [];
      const total = arr.reduce((acc,c)=> acc + (Number(c?.novas)||0), 0);
      setAppUnread(total);
    }catch{
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
  function clearUnreadOfOpenChatAndPingServer(){
    if (window.clienteSel?.id){
      try{
        const EMPRESA_ID = Number(localStorage.getItem('empresa_id') || 0);
        const arr = (window.state?.clientesCache || window.clientesCache || []);
        const cl = arr.find(x=> Number(x.id ?? x.conversation_id ?? x.cliente_id)===Number(window.clienteSel.id));
        if (cl && cl.novas>0){
          cl.novas = 0;
          window.salvarCache?.();
          // re-render e recalc
          window.renderListaClientes?.(window.state?.clientesCache || window.clientesCache || []);
          recomputeUnread();
        }
        // marca como visto no servidor
        fetch(`/api/atendimento/clientes/${Number(window.clienteSel.id)}/seen?empresa_id=${EMPRESA_ID}`, { method:'POST' }).catch(()=>{});
      }catch{}
    }
  }

  // Quando a aba volta a ficar visível
  document.addEventListener('visibilitychange', ()=>{
    if (!document.hidden) clearUnreadOfOpenChatAndPingServer();
  });

  // Quando a janela recebe foco
  window.addEventListener('focus', ()=>{
    clearUnreadOfOpenChatAndPingServer();
    recomputeUnread();
  }, { passive:true });

  // Primeira passagem (depois que a UI sobe)
  setTimeout(recomputeUnread, 300);
})();
