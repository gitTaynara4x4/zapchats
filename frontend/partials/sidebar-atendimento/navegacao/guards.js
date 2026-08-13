(function(){
  if (window.__ZC_SIDEBAR_FAST_LEAVE_GUARD__) return;
  window.__ZC_SIDEBAR_FAST_LEAVE_GUARD__ = true;

  function norm(p){ return String(p||'').split('?')[0].split('#')[0].replace(/\/+$/,'') || '/'; }

  function go(ev){
    try {
      if (norm(location.pathname) !== '/atendimentos') return;
      var a = ev.target && ev.target.closest && ev.target.closest('a.wpp-leftbar-icon[href], .wpp-leftbar-logo-link[href]');
      if (!a) return;
      var u = new URL(a.getAttribute('href') || '', location.origin);
      if (u.origin !== location.origin) return;
      if (norm(u.pathname) === '/atendimentos' || norm(u.pathname) === norm(location.pathname)) return;

      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();

      try { window.__ZC_ATENDIMENTOS_NAVIGATING_AWAY__ = true; } catch(e){}
      try { window.dispatchEvent(new CustomEvent('zc:navigate-away', { detail:{ from: location.pathname, to: u.pathname, reason:'sidebar-fast-leave', hard:true }})); } catch(e){}
      try { window.__ZC_ATENDIMENTO_FETCH_GUARD__ && window.__ZC_ATENDIMENTO_FETCH_GUARD__.abortAll && window.__ZC_ATENDIMENTO_FETCH_GUARD__.abortAll('sidebar-fast-leave'); } catch(e){}
      try { window.ZC_CLOSE_ALL_WS && window.ZC_CLOSE_ALL_WS(); } catch(e){}
      window.location.href = u.href;
    } catch(e){}
  }

  document.addEventListener('pointerdown', go, { capture:true });
  document.addEventListener('mousedown', go, { capture:true });
  document.addEventListener('click', go, { capture:true });
  try { document.addEventListener('touchstart', go, { capture:true, passive:false }); } catch(e){}
})();

(function(){
  if (window.__ZC_SIDEBAR_SELF_NAV_GUARD__) return;
  window.__ZC_SIDEBAR_SELF_NAV_GUARD__ = true;
  function norm(p){ return String(p||'').split('?')[0].split('#')[0].replace(/\/+$/,'') || '/'; }
  document.addEventListener('click', function(ev){
    var a = ev.target && ev.target.closest && ev.target.closest('a[data-zc-no-self-nav="1"], a.wpp-leftbar-icon[href="/atendimentos"]');
    if (!a) return;
    try {
      var u = new URL(a.getAttribute('href') || '', location.origin);
      if (u.origin === location.origin && norm(u.pathname) === norm(location.pathname)) {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        try { window.ZCForceClearLoading && window.ZCForceClearLoading('sidebar-self-nav'); } catch(e){}
        try { console.warn('[ZapsChat][v6] clique repetido no menu Atendimentos bloqueado'); } catch(e){}
      }
    } catch(e){}
  }, true);
})();
