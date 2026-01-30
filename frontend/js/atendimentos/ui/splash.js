// /frontend/js/atendimentos/ui/splash.js
// Splash full-screen que SÓ aparece quando há sincronização de mensagens.
// Regras:
//  - Abre em 'sync:start' OU 'ws:history_sync_start'
//  - Fecha quando todos os 'sync:done' chegarem OU em 'ws:history_sync_done'
//  - Pode ser usado manualmente com Splash.lock(scope, text)

// ✅ SEM CSS inline/inject — CSS vai para /frontend/css/atendimentos.css

(function () {
  if (window.__zcSplashLoaded) return;
  window.__zcSplashLoaded = true;

  const LOGO_SRC = "/frontend/img/carregar.png";
  const FALLBACK = "/frontend/img/wpp.png";
  const SAFETY_TIMEOUT_MS = 15000;

  let locks = 0;
  let safetyTimer = null;

  function ensureDom() {
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

      const img = el.querySelector('#splash-logo');
      if (img) img.onerror = () => { img.onerror = null; img.src = FALLBACK; };
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
      return () => {
        if (!rel){
          rel = true;
          window.dispatchEvent(new CustomEvent('sync:done'));
        }
      };
    },
    show(t){ locks++; show(t); },
    hide(){ hide(true); }
  };
})();
