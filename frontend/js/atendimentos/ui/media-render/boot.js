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

  function getSafeRoot(root) {
    return root || H() || document;
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

  function enhance(root) {
    root = getSafeRoot(root);

    if (M.state.enhancing) {
      return;
    }

    try {
      M.state.enhancing = true;

      /*
        CSS pode ser garantido sempre.
        O resto tenta ficar restrito ao root recebido.
      */
      ensureMsgMediaCssSafe();

      upgradeNativeAudiosSafe(root);
      injectMarkerMediasSafe(root);
      initMediaFallbacksSafe(root);
      initAudioPlayersSafe(root);
      refreshAudioAvatarsSafe(root);
      bindViewerClicksSafe(root);

      /*
        Quoted preview usa delegate/click global em algumas versões.
        Chamar com document mantém compatibilidade, mas não roda em loop.
      */
      bindQuotedPreviewClicksSafe(document);

      groupConsecutiveImageRowsSafe(root);
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
      hist.__zcMediaRenderObs = null;
      hist.__zcMediaRenderTimer = null;
    } catch {}
  }

  function observeHistory(hist) {
    if (!hist) {
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
    startIntervals,
    stopIntervals,
    exposeGlobals,
    start,
  });

  onReady(start);

  console.log('[media-render] boot carregado: sem intervalos pesados');
})();