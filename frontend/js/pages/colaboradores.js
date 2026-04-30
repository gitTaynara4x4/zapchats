// frontend/js/pages/colaboradores.js

(function BootColaboradores(){
  'use strict';

  if (window.__zcColaboradoresBootLoaded) return;
  window.__zcColaboradoresBootLoaded = true;

  function releasePageLoader(){
    try { window.ready?.(); } catch {}
    try { window.Page?.ready?.(); } catch {}

    try {
      document.documentElement.classList.remove('prepaint');
      document.documentElement.setAttribute('data-head-ready', '1');
      document.documentElement.setAttribute('data-loader-ready', '1');
    } catch {}
  }

  async function boot(){
    releasePageLoader();

    try {
      const mod = await import('./colaboradores/index.js?v=split-fast-2');
      await mod.initColaboradoresPage();
    } catch (e) {
      console.error('[colaboradores] erro ao iniciar:', e);
    } finally {
      releasePageLoader();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once:true });
  } else {
    boot();
  }

  setTimeout(releasePageLoader, 300);
  setTimeout(releasePageLoader, 1000);
  setTimeout(releasePageLoader, 2500);
})();