// frontend/js/pages/colaboradores.js
// Compatibilidade: carrega e inicia a versão modular corrigida.
(function(){
  'use strict';
  if (window.__zcColaboradoresModuloShimLoaded) return;
  window.__zcColaboradoresModuloShimLoaded = true;

  import('/frontend/js/pages/colaboradores/index.js?v=colab-wizard-final-click-fix-20260628')
    .then(mod => {
      if (mod && typeof mod.initColaboradoresPage === 'function') {
        mod.initColaboradoresPage();
      }
    })
    .catch(err => console.error('[colaboradores] falha ao carregar módulo principal', err));
})();
