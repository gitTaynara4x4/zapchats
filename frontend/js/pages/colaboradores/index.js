// frontend/js/pages/colaboradores/index.js

import { releasePageLoader } from './helpers.js';
import { VIEW_PERM } from './state.js';

import { preloadPerms } from './permissions.js';
import { loadEmpresa } from './empresa.js';
import { loadSetores } from './setores.js';
import { loadColaboradores, renderLista, startPoller, stopPoller, bindLista } from './lista.js';
import { bindModal } from './modal.js';

import { initColaboradoresTabs } from './ui/tabs.js';
import { initColaboradoresSelects } from './ui/selects.js';

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