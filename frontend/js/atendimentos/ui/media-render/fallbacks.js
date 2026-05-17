// /frontend/js/atendimentos/ui/media-render/fallbacks.js
// Fallbacks de mídia
// - img[data-alt]: tenta próxima URL se a atual falhar
// - video[data-alt]: tenta próxima URL se a atual falhar
// - audio[controls]: troca áudio nativo pelo player estilo WhatsApp

(function () {
  'use strict';

  const M = window.ZCMediaRender;

  if (!M || !M.__coreReady) {
    console.warn('[media-render][fallbacks] core.js precisa ser carregado antes.');
    return;
  }

  if (M.__fallbacksReady) return;
  M.__fallbacksReady = true;

  const REQUIRED = [
    'uniq',
    'makeWaAudioHTML',
  ];

  if (!M.require(REQUIRED, 'fallbacks')) {
    return;
  }

  const {
    uniq,
    makeWaAudioHTML,
  } = M;

  function initMediaFallbacks(root) {
    root = root || document;

    root.querySelectorAll('img[data-alt]').forEach((img) => {
      if (img._fb) return;
      img._fb = true;

      img.addEventListener('error', () => {
        const list = String(img.dataset.alt || '')
          .split('|')
          .filter(Boolean);

        if (!list.length) return;

        const next = list.shift();

        img.src = next;
        img.dataset.alt = list.join('|');
      });
    });

    root.querySelectorAll('video[data-alt]').forEach((video) => {
      if (video._fb) return;
      video._fb = true;

      video.addEventListener(
        'error',
        () => {
          const list = String(video.dataset.alt || '')
            .split('|')
            .filter(Boolean);

          if (!list.length) return;

          const next = list.shift();

          video.src = next;
          video.dataset.alt = list.join('|');

          try {
            video.load();
          } catch {}
        },
        {
          passive: true,
        }
      );
    });
  }

  function upgradeNativeAudios(root) {
    root = root || document;

    root.querySelectorAll('audio[controls]:not([data-up-wa="1"])').forEach((audioEl) => {
      audioEl.setAttribute('data-up-wa', '1');

      const srcs = [];

      const directSrc =
        audioEl.getAttribute('src') ||
        audioEl.currentSrc ||
        audioEl.src ||
        '';

      if (directSrc) {
        srcs.push(directSrc);
      }

      audioEl.querySelectorAll('source').forEach((sourceEl) => {
        const u =
          sourceEl.getAttribute('src') ||
          sourceEl.src ||
          '';

        if (u) {
          srcs.push(u);
        }
      });

      const alt = audioEl.dataset?.alt
        ? String(audioEl.dataset.alt)
        : '';

      if (alt) {
        alt.split('|').forEach((u) => {
          if (u) srcs.push(u);
        });
      }

      const urls = uniq(srcs);

      if (!urls.length) return;

      const bubble = audioEl.closest('.bubble');
      const dir = bubble?.classList.contains('bubble-out') ? 'out' : 'in';

      const wrap = document.createElement('div');
      wrap.innerHTML = makeWaAudioHTML(urls, {
        dir,
      });

      const node = wrap.firstElementChild;

      if (!node) return;

      audioEl.replaceWith(node);
    });
  }

  M.extend({
    initMediaFallbacks,
    upgradeNativeAudios,
  });

  console.log('[media-render] fallbacks carregado');
})();