// /frontend/js/atendimentos/ui/media-render/boot.js
// Boot do media-render dividido
// - Roda enhance() no histórico
// - Observa mudanças no #historico
// - Reprocessa mídias quando trocar conversa/cliente
// - Reprocessa avatar dos áudios
// - Expõe funções globais compatíveis com o arquivo antigo
//
// Correção de performance:
// - Remove loops fixos pesados de setInterval.
// - Não fica varrendo o DOM a cada poucos segundos.
// - Processa mídia só quando o histórico muda, conversa abre/troca ou evento dispara.
// - MutationObserver com debounce maior e sem reprocessar em excesso.
// - Mantém compatibilidade com funções antigas.

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

  const ENHANCE_DEBOUNCE_MS = Number(window.ZC_MEDIA_ENHANCE_DEBOUNCE_MS || 180);
  const ENHANCE_OPEN_CHAT_MS = Number(window.ZC_MEDIA_OPEN_CHAT_DEBOUNCE_MS || 220);
  const OBSERVER_DEBOUNCE_MS = Number(window.ZC_MEDIA_OBSERVER_DEBOUNCE_MS || 220);
  const RESIZE_DEBOUNCE_MS = Number(window.ZC_MEDIA_RESIZE_DEBOUNCE_MS || 260);

  const LAZY_MEDIA_MAX_LOADED = Number(window.ZC_LAZY_MEDIA_MAX_LOADED || 12);
  const LAZY_MEDIA_ROOT_MARGIN = String(window.ZC_LAZY_MEDIA_ROOT_MARGIN || '520px 0px');
  const LAZY_PLACEHOLDER = M.LAZY_MEDIA_PLACEHOLDER || window.ZC_LAZY_MEDIA_PLACEHOLDER || '';

  /*
    Segurança:
    se alguma versão antiga deixou intervalos vivos, mata aqui.
    Esta versão NÃO recria esses intervalos.
  */
  try {
    if (window.__zcMediaEnsureInterval) {
      clearInterval(window.__zcMediaEnsureInterval);
      window.__zcMediaEnsureInterval = null;
    }
  } catch {}

  try {
    if (window.__zcMediaAvatarInterval) {
      clearInterval(window.__zcMediaAvatarInterval);
      window.__zcMediaAvatarInterval = null;
    }
  } catch {}

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

  function initControlledLazyMediaSafe(root) {
    initControlledLazyMedia(root);
  }

  function getSafeRoot(root) {
    return root || H() || document;
  }


  /* =====================================================================
     Lazy media com limite de RAM
     ===================================================================== */

  function getLazyState(hist) {
    const key = '__zcLazyMediaState';
    const root = hist || document;

    if (!root[key]) {
      root[key] = {
        observer: null,
        loaded: new Set(),
      };
    }

    return root[key];
  }

  function lazyScope(root) {
    return getSafeRoot(root);
  }

  function isLoadedLazyMedia(el) {
    return el && el.dataset && el.dataset.zcLazyLoaded === '1';
  }

  function getLazyMediaLabel(el) {
    try {
      const tag = String(el?.tagName || '').toLowerCase();
      const raw = String(el?.dataset?.alt || el?.getAttribute?.('alt') || '').toLowerCase();

      if (tag === 'video') return 'Carregando vídeo...';
      if (el?.classList?.contains('msg-sticker') || raw.includes('figurinha') || raw.includes('sticker')) {
        return 'Carregando figurinha...';
      }
      return 'Carregando imagem...';
    } catch {
      return 'Carregando mídia...';
    }
  }

  function getLazyMediaHost(el) {
    try {
      return (
        el?.closest?.('.msg-media-img, .msg-media-cell, .msg-media-video-wrap, .msg-media-group, .msg-bubble, .bubble, .message-bubble') ||
        el?.parentElement ||
        null
      );
    } catch {
      return el?.parentElement || null;
    }
  }

  function setLazyMediaStatus(el, status) {
    try {
      if (!el) return;

      const host = getLazyMediaHost(el);
      const st = String(status || 'loading');
      const label = st === 'failed' ? 'Não foi possível carregar mídia' : getLazyMediaLabel(el);

      el.dataset.zcLazyStatus = st;

      if (!host) return;

      host.classList.add('zc-lazy-media-host');
      host.classList.toggle('zc-media-loading', st === 'loading' || st === 'idle');
      host.classList.toggle('zc-media-loaded', st === 'loaded');
      host.classList.toggle('zc-media-failed', st === 'failed');
      host.dataset.zcMediaLoadingLabel = label;
    } catch {}
  }

  function bindLazyMediaStatusEvents(el) {
    try {
      if (!el || el.__zcLazyStatusBound) return;
      el.__zcLazyStatusBound = true;

      const tag = String(el.tagName || '').toLowerCase();
      const loaded = () => {
        if (el.dataset?.zcLazyLoaded === '1') {
          setLazyMediaStatus(el, 'loaded');
        }
      };
      const failed = () => setLazyMediaStatus(el, 'failed');

      if (tag === 'video') {
        el.addEventListener('loadedmetadata', loaded);
        el.addEventListener('loadeddata', loaded);
        el.addEventListener('canplay', loaded);
        el.addEventListener('error', failed);
      } else {
        el.addEventListener('load', loaded);
        el.addEventListener('error', failed);
      }
    } catch {}
  }

  function isElementNearViewport(el, margin = 260) {
    try {
      const hist = H();
      const box = el.getBoundingClientRect();
      const rootBox = hist ? hist.getBoundingClientRect() : {
        top: 0,
        bottom: window.innerHeight || document.documentElement.clientHeight || 0,
      };

      return box.bottom >= rootBox.top - margin && box.top <= rootBox.bottom + margin;
    } catch {
      return false;
    }
  }

  function loadLazyMedia(el, state) {
    try {
      if (!el || isLoadedLazyMedia(el)) return;

      const src = el.dataset?.zcLazySrc || '';
      if (!src) return;

      const tag = String(el.tagName || '').toLowerCase();

      bindLazyMediaStatusEvents(el);
      setLazyMediaStatus(el, 'loading');

      if (tag === 'video') {
        el.src = src;
        try { el.load(); } catch {}
      } else {
        el.src = src;
      }

      el.dataset.zcLazyLoaded = '1';
      el.classList.add('zc-lazy-loaded');
      state?.loaded?.add(el);

      /*
        Se a mídia já veio do cache do navegador, o evento load pode não disparar
        depois da troca de src. Então confirma no próximo tick.
      */
      setTimeout(() => {
        try {
          if (tag !== 'video' && el.complete && el.naturalWidth > 0) {
            setLazyMediaStatus(el, 'loaded');
          }
        } catch {}
      }, 60);
    } catch {}
  }

  function unloadLazyMedia(el) {
    try {
      if (!el || !isLoadedLazyMedia(el)) return;
      if (isElementNearViewport(el, 180)) return;

      const tag = String(el.tagName || '').toLowerCase();

      if (tag === 'video') {
        try { el.pause(); } catch {}
        el.removeAttribute('src');
        try { el.load(); } catch {}
      } else if (LAZY_PLACEHOLDER) {
        el.src = LAZY_PLACEHOLDER;
      } else {
        el.removeAttribute('src');
      }

      el.dataset.zcLazyLoaded = '0';
      el.classList.remove('zc-lazy-loaded');
      setLazyMediaStatus(el, 'loading');
    } catch {}
  }

  function pruneLazyLoadedMedia(state) {
    try {
      if (!state?.loaded) return;

      const arr = Array.from(state.loaded).filter((el) => el && el.isConnected && isLoadedLazyMedia(el));
      state.loaded = new Set(arr);

      const max = Math.max(4, Math.min(40, Number(LAZY_MEDIA_MAX_LOADED) || 12));
      if (arr.length <= max) return;

      const candidates = arr.filter((el) => !isElementNearViewport(el, 220));
      const extra = arr.length - max;

      candidates.slice(0, extra).forEach((el) => {
        unloadLazyMedia(el);
        state.loaded.delete(el);
      });
    } catch {}
  }

  function initControlledLazyMedia(root) {
    try {
      const hist = H() || document;
      const scope = lazyScope(root);
      const state = getLazyState(hist);

      const nodes = Array.from(
        scope.querySelectorAll?.('[data-zc-lazy-media][data-zc-lazy-src]') || []
      );

      nodes.forEach((el) => {
        bindLazyMediaStatusEvents(el);
        if (isLoadedLazyMedia(el)) {
          setLazyMediaStatus(el, 'loaded');
        } else {
          setLazyMediaStatus(el, 'loading');
        }
      });

      if (!nodes.length) {
        pruneLazyLoadedMedia(state);
        return;
      }

      const eagerMax = Math.max(4, Math.min(12, Number(LAZY_MEDIA_MAX_LOADED) || 12));
      const visibleNow = nodes.filter((el) => !isLoadedLazyMedia(el) && isElementNearViewport(el, 260));
      visibleNow.slice(0, eagerMax).forEach((el) => loadLazyMedia(el, state));

      if (!('IntersectionObserver' in window)) {
        nodes
          .filter((el) => !isLoadedLazyMedia(el))
          .slice(0, eagerMax)
          .forEach((el) => loadLazyMedia(el, state));
        pruneLazyLoadedMedia(state);
        return;
      }

      if (!state.observer) {
        state.observer = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            const el = entry.target;
            if (entry.isIntersecting || entry.intersectionRatio > 0) {
              loadLazyMedia(el, state);
            }
          });

          pruneLazyLoadedMedia(state);
        }, {
          root: hist && hist.id === 'historico' ? hist : null,
          rootMargin: LAZY_MEDIA_ROOT_MARGIN,
          threshold: 0.01,
        });
      }

      nodes.forEach((el) => {
        if (isElementNearViewport(el, 260) && !isLoadedLazyMedia(el)) {
          loadLazyMedia(el, state);
        }
        if (el.__zcLazyObserved) return;
        el.__zcLazyObserved = true;
        state.observer.observe(el);
      });

      clearTimeout(state.__zcLazyKickTimer);
      state.__zcLazyKickTimer = setTimeout(() => {
        try {
          nodes
            .filter((el) => el && el.isConnected && !isLoadedLazyMedia(el) && isElementNearViewport(el, 320))
            .slice(0, eagerMax)
            .forEach((el) => loadLazyMedia(el, state));
          pruneLazyLoadedMedia(state);
        } catch {}
      }, 250);

      if (hist && !hist.__zcLazyScrollBound) {
        hist.__zcLazyScrollBound = true;
        hist.addEventListener('scroll', () => {
          try {
            const liveNodes = Array.from(hist.querySelectorAll('[data-zc-lazy-media][data-zc-lazy-src]'));
            liveNodes
              .filter((el) => !isLoadedLazyMedia(el) && isElementNearViewport(el, 280))
              .slice(0, eagerMax)
              .forEach((el) => loadLazyMedia(el, state));
            pruneLazyLoadedMedia(state);
          } catch {}
        }, { passive: true });
      }

      pruneLazyLoadedMedia(state);
    } catch {}
  }

  function isElementInsideHistorico(el) {
    try {
      const hist = H();

      if (!hist || !el) return false;

      if (el === hist) return true;

      return hist.contains(el);
    } catch {
      return false;
    }
  }

  function getLightRootFromMutationList(mutations) {
    try {
      const hist = H();

      if (!hist || !Array.isArray(mutations) || !mutations.length) {
        return hist || document;
      }

      /*
        Se chegou uma mensagem nova, processa o próprio histórico.
        Evita document inteiro.
      */
      for (const mut of mutations) {
        if (!mut) continue;

        if (mut.target && isElementInsideHistorico(mut.target)) {
          return hist;
        }

        const added = Array.from(mut.addedNodes || []);

        for (const node of added) {
          if (!node || node.nodeType !== 1) continue;

          if (isElementInsideHistorico(node)) {
            return hist;
          }
        }
      }

      return hist;
    } catch {
      return H() || document;
    }
  }

  function rootHasMedia(root) {
    try {
      const scope = root || H() || document;
      return !!scope.querySelector?.([
        '[data-zc-lazy-media]',
        '[data-zc-lazy-src]',
        '.zc-media',
        '.zc-gallery',
        '.msg-media',
        '.wa-audio',
        'audio',
        'video',
        'img[data-zc-lazy-src]',
        'img.zc-msg-img',
        '.document-card',
      ].join(','));
    } catch {
      return false;
    }
  }

  function enhance(root) {
    root = getSafeRoot(root);

    if (M.state.enhancing) {
      return;
    }

    try {
      M.state.enhancing = true;

      ensureMsgMediaCssSafe();

      // Se não tem mídia, não varre/reprocessa tudo. Conversa de texto fica leve.
      if (!rootHasMedia(root) && window.ZC_MEDIA_RENDER_FOR_TEXT !== true) {
        bindQuotedPreviewClicksSafe(document);
        return;
      }

      upgradeNativeAudiosSafe(root);
      injectMarkerMediasSafe(root);
      initMediaFallbacksSafe(root);
      initAudioPlayersSafe(root);
      refreshAudioAvatarsSafe(root);
      bindViewerClicksSafe(root);
      bindQuotedPreviewClicksSafe(document);
      groupConsecutiveImageRowsSafe(root);
      initControlledLazyMediaSafe(root);
    } finally {
      M.state.enhancing = false;
    }
  }

  function scheduleEnhance(root, delay = ENHANCE_DEBOUNCE_MS) {
    const target = getSafeRoot(root);

    clearTimeout(M.state.enhanceTimer);

    M.state.enhanceTimer = setTimeout(() => {
      try {
        enhance(target);
      } catch (err) {
        console.warn('[media-render][boot] scheduleEnhance falhou:', err);
      }
    }, Math.max(40, Number(delay) || ENHANCE_DEBOUNCE_MS));
  }

  function scheduleAvatarRefresh(root, delay = 260) {
    clearTimeout(M.state.avatarRefreshTimer);

    M.state.avatarRefreshTimer = setTimeout(() => {
      try {
        refreshAudioAvatarsSafe(getSafeRoot(root));
      } catch (err) {
        console.warn('[media-render][boot] avatar refresh falhou:', err);
      }
    }, Math.max(80, Number(delay) || 260));
  }

  function disconnectObserverFor(hist) {
    if (!hist) return;

    try {
      if (hist.__zcMediaRenderObs) {
        hist.__zcMediaRenderObs.disconnect();
      }
    } catch {}

    try {
      clearTimeout(hist.__zcMediaRenderTimer);
    } catch {}

    try {
      if (hist.__zcLazyMediaState?.observer) {
        hist.__zcLazyMediaState.observer.disconnect();
      }
      hist.__zcLazyMediaState = null;
    } catch {}

    try {
      hist.__zcMediaRenderObs = null;
      hist.__zcMediaRenderTimer = null;
    } catch {}
  }

  function observeHistory(hist) {
    if (!hist) {
      return;
    }

    // RAM seguro: não mantém MutationObserver permanente no histórico.
    // O enhance roda por evento historico:rendered e só quando há mídia.
    if (window.ZC_DISABLE_MEDIA_RENDER_OBSERVER === true) {
      try { disconnectObserverFor(hist); } catch {}
      return;
    }

    /*
      Se já está observando esse mesmo elemento, não faz nada.
    */
    if (hist.__zcMediaRenderObs) {
      return;
    }

    /*
      Se o histórico foi recriado no DOM, desconecta observer antigo.
    */
    try {
      const oldHist = M.state.observedHistory || null;

      if (oldHist && oldHist !== hist) {
        disconnectObserverFor(oldHist);
      }
    } catch {}

    if (window.ZC_DISABLE_MEDIA_RENDER_OBSERVER === true || window.ZC_ESSENTIAL_CHAT_MODE === true) {
      return;
    }

    const obs = new MutationObserver((mutations) => {
      clearTimeout(hist.__zcMediaRenderTimer);

      hist.__zcMediaRenderTimer = setTimeout(() => {
        const root = getLightRootFromMutationList(Array.from(mutations || []));

        /*
          Um único enhance depois do lote de mudanças.
          Isso evita processar a cada bolha individual.
        */
        enhance(root);
      }, OBSERVER_DEBOUNCE_MS);
    });

    obs.observe(hist, {
      childList: true,
      subtree: true,
    });

    hist.__zcMediaRenderObs = obs;
    M.state.observer = obs;
    M.state.observedHistory = hist;
  }

  function bootObserver() {
    const hist = H();

    observeHistory(hist);

    /*
      Primeira passada ao abrir a tela/conversa.
    */
    scheduleEnhance(hist || document, 80);
  }

  function bindMediaRenderEvents() {
    if (document.__zcMediaRenderBootEventsBound) {
      return;
    }

    document.__zcMediaRenderBootEventsBound = true;

    /*
      Eventos do histórico.
      Agora todos passam por debounce; nada de loop.
    */
    document.addEventListener('historico:ready', () => {
      bootObserver();
      scheduleEnhance(H() || document, 80);
    });

    document.addEventListener('historico:rendered', () => {
      observeHistory(H());
      scheduleEnhance(H() || document, 80);
    });

    /*
      Eventos de troca/abertura de conversa.
    */
    document.addEventListener('cliente:selecionado', () => {
      observeHistory(H());
      scheduleEnhance(H() || document, ENHANCE_OPEN_CHAT_MS);
      scheduleAvatarRefresh(H() || document, ENHANCE_OPEN_CHAT_MS + 80);
    });

    document.addEventListener('cliente:selecionar', () => {
      observeHistory(H());
      scheduleEnhance(H() || document, ENHANCE_OPEN_CHAT_MS);
      scheduleAvatarRefresh(H() || document, ENHANCE_OPEN_CHAT_MS + 80);
    });

    document.addEventListener('zc:cliente_sel', () => {
      observeHistory(H());
      scheduleEnhance(H() || document, ENHANCE_OPEN_CHAT_MS);
      scheduleAvatarRefresh(H() || document, ENHANCE_OPEN_CHAT_MS + 80);
    });

    document.addEventListener('zc:open_chat', () => {
      observeHistory(H());
      scheduleEnhance(H() || document, ENHANCE_OPEN_CHAT_MS);
      scheduleAvatarRefresh(H() || document, ENHANCE_OPEN_CHAT_MS + 80);
    });

    document.addEventListener('chat:open', () => {
      observeHistory(H());
      scheduleEnhance(H() || document, ENHANCE_OPEN_CHAT_MS);
      scheduleAvatarRefresh(H() || document, ENHANCE_OPEN_CHAT_MS + 80);
    });

    /*
      Eventos de mensagem nova.
      Caso algum módulo dispare esses nomes, processa uma vez só.
    */
    document.addEventListener('atendimento:mensagem-recebida', () => {
      scheduleEnhance(H() || document, 120);
    });

    document.addEventListener('zc:message-upsert', () => {
      scheduleEnhance(H() || document, 120);
    });

    document.addEventListener('zc:message-created', () => {
      scheduleEnhance(H() || document, 120);
    });

    /*
      Resize só precisa reagrupar galeria.
      Também com debounce.
    */
    let resizeTimer = null;

    window.addEventListener(
      'resize',
      () => {
        clearTimeout(resizeTimer);

        resizeTimer = setTimeout(() => {
          groupConsecutiveImageRowsSafe(H() || document);
          initControlledLazyMediaSafe(H() || document);
        }, RESIZE_DEBOUNCE_MS);
      },
      {
        passive: true,
      }
    );
  }

  /*
    Mantido por compatibilidade.
    Antes criava intervalos pesados.
    Agora só limpa intervalos antigos e faz uma passada leve.
  */
  function startIntervals() {
    try {
      if (window.__zcMediaEnsureInterval) {
        clearInterval(window.__zcMediaEnsureInterval);
        window.__zcMediaEnsureInterval = null;
      }
    } catch {}

    try {
      if (window.__zcMediaAvatarInterval) {
        clearInterval(window.__zcMediaAvatarInterval);
        window.__zcMediaAvatarInterval = null;
      }
    } catch {}

    observeHistory(H());
    scheduleEnhance(H() || document, 120);
  }

  function stopIntervals() {
    try {
      if (window.__zcMediaEnsureInterval) {
        clearInterval(window.__zcMediaEnsureInterval);
        window.__zcMediaEnsureInterval = null;
      }
    } catch {}

    try {
      if (window.__zcMediaAvatarInterval) {
        clearInterval(window.__zcMediaAvatarInterval);
        window.__zcMediaAvatarInterval = null;
      }
    } catch {}
  }

  function exposeGlobals() {
    M.exposeGlobal?.('initMediaFallbacks', M.initMediaFallbacks);
    M.exposeGlobal?.('initAudioPlayers', M.initAudioPlayers);
    M.exposeGlobal?.('refreshAudioAvatars', M.refreshAudioAvatars);
    M.exposeGlobal?.('groupConsecutiveImageRows', M.groupConsecutiveImageRows);
    M.exposeGlobal?.('criarHTMLDaMensagem', M.criarHTMLDaMensagem);
    M.exposeGlobal?.('ensureMsgMediaCss', M.ensureMsgMediaCss);
    M.exposeGlobal?.('zcMediaRenderEnhance', enhance);

    try {
      window.zcMediaRenderEnhance = enhance;
      window.zcInitControlledLazyMedia = initControlledLazyMedia;
      window.zcMediaRenderScheduleEnhance = scheduleEnhance;
      window.zcMediaRenderRefreshAudioAvatars = function () {
        scheduleAvatarRefresh(H() || document, 80);
      };
    } catch {}
  }

  function start() {
    stopIntervals();

    if (M.state.booted) {
      bootObserver();
      return;
    }

    M.state.booted = true;

    exposeGlobals();
    bindMediaRenderEvents();
    bootObserver();

    /*
      Importante:
      NÃO chamamos mais setInterval.
      O media-render agora trabalha por evento + MutationObserver.
    */
    startIntervals();
  }

  M.extend({
    enhance,
    scheduleEnhance,
    scheduleAvatarRefresh,
    observeHistory,
    bootObserver,
    bindMediaRenderEvents,
    initControlledLazyMedia,
    startIntervals,
    stopIntervals,
    exposeGlobals,
    start,
  });

  onReady(start);

  console.log('[media-render] boot carregado: sem intervalos pesados');
})();