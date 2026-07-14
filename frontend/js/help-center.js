// Integração leve do Help Center global.
// Não cria outro botão flutuante: as páginas já usam /frontend/js/help/help-*.js.
// Aqui apenas evitamos erro de import e fazemos botões globais abrirem a ajuda da página.
(function(){
  'use strict';

  if (window.__ZAPS_HELP_CENTER_READY__) return;
  window.__ZAPS_HELP_CENTER_READY__ = true;

  function ready(fn){
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once:true });
    else fn();
  }

  function openPageHelp(){
    const pageHelpButton = document.querySelector('.zc-page-help-btn');
    if (pageHelpButton) {
      pageHelpButton.click();
      return true;
    }
    return false;
  }

  ready(function(){
    document.documentElement.classList.add('zc-help-center-ready');

    document.querySelectorAll('[data-help-center-open], [data-help-open], .js-help-open').forEach(function(btn){
      if (btn.__zcHelpCenterBound) return;
      btn.__zcHelpCenterBound = true;
      btn.addEventListener('click', function(ev){
        if (openPageHelp()) ev.preventDefault();
      });
    });
  });
})();
