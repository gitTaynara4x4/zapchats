// frontend/js/pages/colaboradores.js
// Compatibilidade: carrega e inicia a versão modular corrigida.
(function(){
  'use strict';
  if (window.__zcColaboradoresModuloShimLoaded) return;
  window.__zcColaboradoresModuloShimLoaded = true;

  import('/frontend/js/pages/colaboradores/index.js?v=colab-modal-clean-20260711')
    .then(mod => {
      if (mod && typeof mod.initColaboradoresPage === 'function') {
        mod.initColaboradoresPage();
      }
    })
    .catch(err => console.error('[colaboradores] falha ao carregar módulo principal', err));
})();
