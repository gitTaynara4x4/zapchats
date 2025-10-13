// Splash full-screen que SÓ aparece quando há sincronização de mensagens.
// Regras:
//  - Abre em 'sync:start' OU 'ws:history_sync_start'
//  - Fecha quando todos os 'sync:done' chegarem OU em 'ws:history_sync_done'
//  - Pode ser usado manualmente com Splash.lock(scope, text)

(function () {
  if (window.__zcSplashLoaded) return;
  window.__zcSplashLoaded = true;

  const LOGO_SRC = "/frontend/img/carregar.png";
  const FALLBACK = "/frontend/img/wpp.png";
  const SAFETY_TIMEOUT_MS = 15000;

  let locks = 0;
  let safetyTimer = null;

  function injectStyle() {
    if (document.getElementById('splash-inline-style')) return;
    const st = document.createElement('style');
    st.id = 'splash-inline-style';
    st.textContent = `
      html.is-loading, body.is-loading{ overflow:hidden !important; }
      #splash-screen{
        position:fixed; inset:0; z-index:10000;
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        background:#0b141a; color:#e9edef; opacity:1; transition:opacity .18s ease;
      }
      #splash-screen .brand{ width:8rem; height:auto; margin-bottom:1rem; }
      #splash-screen .msg{ font-size:.9rem; opacity:.9; text-align:center; margin:0; }
      #splash-screen .bar-outer{
        width:clamp(220px,28vw,360px); height:3px; margin-top:.75rem;
        background:rgba(255,255,255,.08); border-radius:999px; overflow:hidden;
      }
      #splash-screen .bar-inner{
        width:200%; height:100%;
        background:linear-gradient(90deg,#22c55e,#06b6d4,#6366f1);
        animation:zc-progress 1.2s ease-in-out infinite;
      }
      #splash-screen .crypto{ font-size:.75rem; margin-top:.9rem; opacity:.85; }
      @keyframes zc-progress{
        0%{transform:translateX(-100%)} 50%{transform:translateX(0)} 100%{transform:translateX(100%)}
      }
    `;
    document.head.appendChild(st);
  }

  function ensureDom() {
    injectStyle();
    let el = document.getElementById('splash-screen');
    if (!el) {
      el = document.createElement('div');
      el.id = 'splash-screen';
      el.innerHTML = `
        <img id="splash-logo" class="brand" src="${LOGO_SRC}" alt="ZapChats">
        <p id="splash-msg" class="msg">Sincronizando…</p>
        <div class="bar-outer"><div class="bar-inner"></div></div>
        <p class="crypto">Protegida com a criptografia de ponta a ponta</p>
      `;
      document.body.appendChild(el);
      el.querySelector('#splash-logo').onerror = () => { el.querySelector('#splash-logo').src = FALLBACK; };
    }
    return el;
  }

  function setMessage(t) {
    const el = document.getElementById('splash-msg');
    if (el) el.textContent = t || 'Sincronizando…';
  }

  function show(text) {
    ensureDom();
    document.documentElement.classList.add('is-loading');
    document.body.classList.add('is-loading');
    setMessage(text);
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => hide(true), SAFETY_TIMEOUT_MS);
  }

  function hide(force=false) {
    if (!force && locks > 0) return;
    locks = 0;
    const el = document.getElementById('splash-screen');
    if (!el) {
      document.documentElement.classList.remove('is-loading');
      document.body.classList.remove('is-loading');
      if (safetyTimer) clearTimeout(safetyTimer);
      safetyTimer = null;
      return;
    }
    el.style.opacity = '0';
    setTimeout(() => {
      try { el.remove(); } catch {}
      document.documentElement.classList.remove('is-loading');
      document.body.classList.remove('is-loading');
      if (safetyTimer) clearTimeout(safetyTimer);
      safetyTimer = null;
    }, 180);
  }

  // Eventos (MOSTRA APENAS EM SYNC DE HISTÓRICO / DELTAS)
  window.addEventListener('sync:start', (e) => {
    locks++;
    show(e?.detail?.text || 'Sincronizando…');
  });
  window.addEventListener('sync:done', () => {
    locks = Math.max(0, locks - 1);
    if (locks === 0) hide();
  });

  // Ponte com o websocket (quando o backend sinaliza catch-up)
  document.addEventListener('ws:history_sync_start', () => {
    window.dispatchEvent(new CustomEvent('sync:start', { detail: { text: 'Atualizando mensagens…' } }));
  });
  document.addEventListener('ws:history_sync_done', () => {
    window.dispatchEvent(new CustomEvent('sync:done'));
  });

  // API manual
  window.Splash = {
    lock(text){
      window.dispatchEvent(new CustomEvent('sync:start', { detail: { text } }));
      let rel = false;
      return () => { if (!rel){ rel = true; window.dispatchEvent(new CustomEvent('sync:done')); } };
    },
    show(t){ locks++; show(t); },
    hide(){ hide(true); }
  };
})();
