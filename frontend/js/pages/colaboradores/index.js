// frontend/js/pages/colaboradores/index.js

import { releasePageLoader } from './helpers.js';
import { VIEW_PERM, EMPRESA_ID } from './state.js';

import { preloadPerms } from './permissions.js';
import { loadEmpresa } from './empresa.js';
import { loadSetores } from './setores.js';
import {
  loadColaboradores,
  renderLista,
  bindLista,
  applyPresenceUpdate,
  applyPresenceSnapshot
} from './lista.js?v=colab-session-cache-20260726-1';
import { bindModal } from './modal.js?v=colab-profile-help-20260727-1';

import { initColaboradoresTabs } from './ui/tabs.js?v=colab-required-20260713';
import { initColaboradoresSelects } from './ui/selects.js?v=colab-select-fix-1';
import { ensureEmpresaWS, onEmpresaMessage } from '../../realtime/ws-core.js?v=colab-presence-20260725-1';

let didInit = false;
let offPresence = null;

function bindPresenceRealtime(){
  const empresaId = Number(
    EMPRESA_ID ||
    window.APP_EMPRESA_ID ||
    localStorage.getItem('empresa_id') ||
    0
  );
  if (!empresaId || offPresence) return;

  ensureEmpresaWS(empresaId, { presenceSnapshot: true });
  offPresence = onEmpresaMessage(empresaId, (evt) => {
    if (evt?.type !== 'message') return;
    const data = evt?.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'ZAPSCHAT_PRESENCE') {
      applyPresenceUpdate(data);
      return;
    }

    if (data.type === 'ZAPSCHAT_PRESENCE_SNAPSHOT') {
      applyPresenceSnapshot(data.items || []);
    }
  });
}

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

    bindLista();
    bindModal();

    initColaboradoresTabs();
    initColaboradoresSelects();

    // A presença e a lista começam imediatamente. Permissões, empresa e
    // departamentos não bloqueiam mais a chamada /api/colaboradores.
    releasePageLoader();
    bindPresenceRealtime();

    const [permsResult, empresaResult, setoresResult, colaboradoresResult] = await Promise.allSettled([
      preloadPerms(),
      loadEmpresa(),
      loadSetores(),
      loadColaboradores({ preferCache: true })
    ]);

    if (permsResult.status === 'rejected') {
      console.warn('[colaboradores] permissões falharam', permsResult.reason);
    }
    if (empresaResult.status === 'rejected') {
      console.warn('[colaboradores] empresa falhou', empresaResult.reason);
    }
    if (setoresResult.status === 'rejected') {
      console.warn('[colaboradores] setores falhou', setoresResult.reason);
    }
    if (colaboradoresResult.status === 'rejected') {
      console.warn('[colaboradores] colaboradores falhou', colaboradoresResult.reason);
    }

    // Reaplica ações e botões após as permissões chegarem, sem refazer a API.
    renderLista();

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
