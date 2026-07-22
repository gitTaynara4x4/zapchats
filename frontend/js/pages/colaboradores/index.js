// frontend/js/pages/colaboradores/index.js

import { releasePageLoader } from './helpers.js';
import { VIEW_PERM } from './state.js';

import { preloadPerms } from './permissions.js';
import { loadEmpresa } from './empresa.js';
import { loadSetores } from './setores.js';
import { loadColaboradores, renderLista, startPoller, stopPoller, bindLista } from './lista.js?v=midias-match-3';
import { bindModal } from './modal.js?v=colab-whatsapp-opcional-20260722';

import { initColaboradoresTabs } from './ui/tabs.js?v=colab-required-20260713';
import { initColaboradoresSelects } from './ui/selects.js?v=colab-select-fix-1';

let didInit = false;

async function init(){
  if (didInit) return;
  didInit = true;

  try {
    if (window.ZAuth?.softEnsureAuth) {
      try {
        await ZAuth.softEnsureAuth();
      } catch (e) {
        console.warn('[colaboradores] softEnsureAuth falhou', e);
      }
    }

    await preloadPerms();

    bindLista();
    bindModal();

    initColaboradoresTabs();
    initColaboradoresSelects();

    try { await loadEmpresa(); } catch (e) { console.warn('[colaboradores] empresa falhou', e); }
    try { await loadSetores(); } catch (e) { console.warn('[colaboradores] setores falhou', e); }
    try { await loadColaboradores(); } catch (e) { console.warn('[colaboradores] colaboradores falhou', e); }

    renderLista();
    startPoller();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPoller();
      else startPoller();
    });

    window.addEventListener('beforeunload', () => {
      stopPoller();
    });

  } catch (e) {
    console.error('[colaboradores] erro geral no init:', e);
  } finally {
    releasePageLoader();
  }
}

export async function initColaboradoresPage(){
  try {
    if (window.Page?.guarded) {
      window.Page.guarded(VIEW_PERM, init, {
        msg: 'Sem permissão para Colaboradores'
      });
    } else {
      await init();
    }
  } catch (e) {
    console.error('[colaboradores] erro no guarded:', e);
    releasePageLoader();
  }
}

// Auto-inicialização da página.
// Sem isso o arquivo era carregado, mas nada ligava os cliques da tela.
function bootColaboradoresPage(){
  initColaboradoresPage();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootColaboradoresPage, { once: true });
} else {
  bootColaboradoresPage();
}

window.initColaboradoresPage = initColaboradoresPage;
