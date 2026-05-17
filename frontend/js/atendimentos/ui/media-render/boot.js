// /frontend/js/atendimentos/ui/media-render/boot.js
// Boot do media-render dividido
// - Roda enhance() no histórico
// - Observa mudanças no #historico
// - Reprocessa mídias quando trocar conversa/cliente
// - Reprocessa avatar dos áudios
// - Expõe funções globais compatíveis com o arquivo antigo

(function () {
  'use strict';

  const M = window.ZCMediaRender;

  if (!M || !M.__coreReady) {
    console.warn('[media-render][boot] core.js precisa ser carregado antes.');
    return;
  }

  if (M.__bootReady) return;
  M.__bootReady = true;

  const REQUIRED = [
    'H',
    'onReady',
  ];

  if (!M.require(REQUIRED, 'boot')) {
    return;
  }

  const {
    H,
    onReady,
  } = M;

  function call(name, ...args) {
    const fn = M[name];

    if (typeof fn !== 'function') {
      return null;
    }

    try {
      return fn(...args);
    } catch (err) {
      console.warn(`[media-render][boot] ${name} falhou:`, err);
      return null;
    }
  }

  function ensureMsgMediaCssSafe() {
    call('ensureMsgMediaCss');
  }

  function upgradeNativeAudiosSafe(root) {
    call('upgradeNativeAudios', root);
  }

  function injectMarkerMediasSafe(root) {
    call('injectMarkerMedias', root);
  }

  function initMediaFallbacksSafe(root) {
    call('initMediaFallbacks', root);
  }

  function initAudioPlayersSafe(root) {
    call('initAudioPlayers', root);
  }

  function refreshAudioAvatarsSafe(root) {
    call('refreshAudioAvatars', root);
  }

  function bindViewerClicksSafe(root) {
    call('bindViewerClicks', root);
  }

  function bindQuotedPreviewClicksSafe(root) {
    call('bindQuotedPreviewClicks', root);
  }

  function groupConsecutiveImageRowsSafe(root) {
    call('groupConsecutiveImageRows', root);
  }

  function enhance(root) {
    root = root || document;

    if (M.state.enhancing) {
      return;
    }

    try {
      M.state.enhancing = true;

      ensureMsgMediaCssSafe();
      upgradeNativeAudiosSafe(root);
      injectMarkerMediasSafe(root);
      initMediaFallbacksSafe(root);
      initAudioPlayersSafe(root);
      refreshAudioAvatarsSafe(root);
      bindViewerClicksSafe(root);
      bindQuotedPreviewClicksSafe(document);
      groupConsecutiveImageRowsSafe(root);
    } finally {
      M.state.enhancing = false;
    }
  }

  function scheduleEnhance(root, delay = 80) {
    const target = root || H() || document;

    clearTimeout(M.state.enhanceTimer);

    M.state.enhanceTimer = setTimeout(() => {
      enhance(target);
    }, delay);
  }

  function observeHistory(hist) {
    if (!hist || hist.__zcMediaRenderObs) {
      return;
    }

    const obs = new MutationObserver(() => {
      clearTimeout(hist.__zcMediaRenderTimer);

      hist.__zcMediaRenderTimer = setTimeout(() => {
        enhance(hist);
      }, 80);
    });

    obs.observe(hist, {
      childList: true,
      subtree: true,
    });

    hist.__zcMediaRenderObs = obs;
    M.state.observer = obs;
  }

  function bootObserver() {
    const hist = H();

    observeHistory(hist);

    enhance(hist || document);
  }

  function bindMediaRenderEvents() {
    if (document.__zcMediaRenderBootEventsBound) {
      return;
    }

    document.__zcMediaRenderBootEventsBound = true;

    document.addEventListener('historico:ready', () => {
      scheduleEnhance(H() || document, 40);
    });

    document.addEventListener('historico:rendered', () => {
      scheduleEnhance(H() || document, 40);
    });

    document.addEventListener('cliente:selecionado', () => {
      scheduleEnhance(H() || document, 120);
    });

    document.addEventListener('cliente:selecionar', () => {
      scheduleEnhance(H() || document, 120);
    });

    document.addEventListener('zc:cliente_sel', () => {
      scheduleEnhance(H() || document, 120);
    });

    document.addEventListener('zc:open_chat', () => {
      scheduleEnhance(H() || document, 120);
    });

    document.addEventListener('chat:open', () => {
      scheduleEnhance(H() || document, 120);
    });

    window.addEventListener(
      'resize',
      () => {
        groupConsecutiveImageRowsSafe(H() || document);
      },
      {
        passive: true,
      }
    );
  }

  function startIntervals() {
    try {
      if (window.__zcMediaEnsureInterval) {
        clearInterval(window.__zcMediaEnsureInterval);
      }
    } catch {}

    try {
      if (window.__zcMediaAvatarInterval) {
        clearInterval(window.__zcMediaAvatarInterval);
      }
    } catch {}

    window.__zcMediaEnsureInterval = setInterval(() => {
      try {
        const hist = H();

        observeHistory(hist);
        enhance(hist || document);
      } catch (err) {
        console.warn('[media-render][boot] intervalo enhance falhou:', err);
      }
    }, 2500);

    window.__zcMediaAvatarInterval = setInterval(() => {
      try {
        refreshAudioAvatarsSafe(H() || document);
      } catch (err) {
        console.warn('[media-render][boot] intervalo avatar falhou:', err);
      }
    }, 3000);
  }

  function exposeGlobals() {
    M.exposeGlobal?.('initMediaFallbacks', M.initMediaFallbacks);
    M.exposeGlobal?.('initAudioPlayers', M.initAudioPlayers);
    M.exposeGlobal?.('refreshAudioAvatars', M.refreshAudioAvatars);
    M.exposeGlobal?.('groupConsecutiveImageRows', M.groupConsecutiveImageRows);
    M.exposeGlobal?.('criarHTMLDaMensagem', M.criarHTMLDaMensagem);
    M.exposeGlobal?.('ensureMsgMediaCss', M.ensureMsgMediaCss);
    M.exposeGlobal?.('zcMediaRenderEnhance', enhance);
  }

  function start() {
    if (M.state.booted) {
      bootObserver();
      return;
    }

    M.state.booted = true;

    exposeGlobals();
    bindMediaRenderEvents();
    bootObserver();
    startIntervals();
  }

  M.extend({
    enhance,
    scheduleEnhance,
    observeHistory,
    bootObserver,
    bindMediaRenderEvents,
    startIntervals,
    exposeGlobals,
    start,
  });

  onReady(start);

  console.log('[media-render] boot carregado');
})();