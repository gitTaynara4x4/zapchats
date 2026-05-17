// /frontend/js/atendimentos/ui/header-actions/boot.js
// Inicialização do header-actions dividido
// - Eventos globais
// - Tecla ESC
// - Fecha drawers/menus ao trocar conversa
// - Observa mudanças no header
// - Observa mudanças no histórico
// - Garante que botões/menus/drawers sejam recriados quando o DOM muda

(function () {
  'use strict';

  const H = window.ZCHeaderActions;

  if (!H || !H.__coreReady) {
    console.warn('[header-actions][boot] core.js precisa ser carregado antes.');
    return;
  }

  if (H.__bootReady) return;
  H.__bootReady = true;

  /*
    Compatibilidade com o arquivo antigo.
    Se por algum motivo o header-actions.js monolítico antigo ainda for carregado
    depois dos arquivos divididos, esse flag impede ele de rodar por cima.
  */
  window.__ZC_CHAT_HEADER_ACTIONS__ = true;

  const REQUIRED = [
    'headerEl',
    'historyEl',
    'onReady',
  ];

  if (!H.require(REQUIRED, 'boot')) {
    return;
  }

  const {
    headerEl,
    historyEl,
    onReady,
  } = H;

  function call(name, ...args) {
    const fn = H[name];

    if (typeof fn !== 'function') {
      return null;
    }

    try {
      return fn(...args);
    } catch (err) {
      console.warn(`[header-actions][boot] ${name} falhou:`, err);
      return null;
    }
  }

  function closeMenuSafe() {
    call('closeMenu');
  }

  function closeSearchDrawerSafe() {
    call('closeSearchDrawer');
  }

  function closeDateJumpDialogSafe() {
    call('closeDateJumpDialog');
  }

  function closeForwardDrawerSafe() {
    call('closeForwardDrawer');
  }

  function stopSelectionModeSafe() {
    call('stopSelectionMode');
  }

  function ensureButtonsSafe() {
    call('ensureButtons');
  }

  function ensureSearchDrawerSafe() {
    call('ensureSearchDrawer');
  }

  function ensureDateJumpDialogSafe() {
    call('ensureDateJumpDialog');
  }

  function ensureMenuSafe() {
    call('ensureMenu');
  }

  function ensureSelectBarSafe() {
    call('ensureSelectBar');
  }

  function ensureForwardDrawerSafe() {
    call('ensureForwardDrawer');
  }

  function bindSelectModeHistorySafe() {
    call('bindSelectModeHistory');
  }

  function ensureRowChecksSafe() {
    call('ensureRowChecks');
  }

  function renderMenuSafe() {
    call('renderMenu');
  }

  function positionMenuSafe() {
    call('positionMenu');
  }

  function bindGlobalEvents() {
    if (document.__zcChatHeaderActionsBound) return;

    document.__zcChatHeaderActionsBound = true;

    document.addEventListener('click', (e) => {
      const target = e.target;

      if (!target || typeof target.closest !== 'function') {
        return;
      }

      const inMenu = target.closest('#zc-chat-more-menu');
      const onMenuBtn = target.closest('#btn-chat-more');

      if (!inMenu && !onMenuBtn) {
        closeMenuSafe();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;

      if (H.state.menuOpen) {
        closeMenuSafe();
        return;
      }

      if (H.state.forwardOpen) {
        closeForwardDrawerSafe();
        return;
      }

      if (H.state.searchOpen) {
        closeSearchDrawerSafe();
        return;
      }

      if (H.state.dateJumpOpen) {
        closeDateJumpDialogSafe();
        return;
      }

      if (H.state.selectMode) {
        stopSelectionModeSafe();
      }
    });

    document.addEventListener('cliente:selecionar', () => {
      closeMenuSafe();
      closeSearchDrawerSafe();
      closeDateJumpDialogSafe();
      closeForwardDrawerSafe();
      stopSelectionModeSafe();
    });

    document.addEventListener('zc:open_chat', () => {
      closeMenuSafe();
      closeSearchDrawerSafe();
      closeForwardDrawerSafe();
      stopSelectionModeSafe();
    });

    document.addEventListener('chat:open', () => {
      closeMenuSafe();
      closeSearchDrawerSafe();
      closeForwardDrawerSafe();
      stopSelectionModeSafe();
    });

    window.addEventListener(
      'resize',
      () => {
        ensureRowChecksSafe();

        if (H.state.menuOpen) {
          renderMenuSafe();
          positionMenuSafe();
        }
      },
      {
        passive: true,
      }
    );
  }

  function bootOnce() {
    ensureButtonsSafe();
    ensureSearchDrawerSafe();
    ensureDateJumpDialogSafe();
    ensureMenuSafe();
    ensureSelectBarSafe();
    ensureForwardDrawerSafe();
    bindSelectModeHistorySafe();
    ensureRowChecksSafe();
  }

  function watchHeader() {
    bootOnce();

    const hdr = headerEl();

    if (hdr && !hdr.__zcHeaderActionsObs) {
      hdr.__zcHeaderActionsObs = true;

      const mo = new MutationObserver(() => {
        ensureButtonsSafe();
        ensureSelectBarSafe();
      });

      mo.observe(hdr, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    }

    const hist = historyEl();

    if (hist && !hist.__zcHeaderActionsHistObs) {
      hist.__zcHeaderActionsHistObs = true;

      const mo = new MutationObserver(() => {
        bindSelectModeHistorySafe();

        if (H.state.selectMode) {
          ensureRowChecksSafe();
        }
      });

      mo.observe(hist, {
        childList: true,
        subtree: true,
      });
    }

    if (!window.__zcHeaderActionsEnsureInt) {
      window.__zcHeaderActionsEnsureInt = setInterval(() => {
        ensureButtonsSafe();
        bindSelectModeHistorySafe();

        if (H.state.selectMode) {
          ensureRowChecksSafe();
        }
      }, 1200);
    }
  }

  function start() {
    bindGlobalEvents();
    watchHeader();
  }

  H.extend({
    bindGlobalEvents,
    bootOnce,
    watchHeader,
    start,
  });

  onReady(start);

  console.log('[header-actions] boot carregado');
})();