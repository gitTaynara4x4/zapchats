// /frontend/js/atendimentos/ui/media-render/viewer.js
// Viewer / Lightbox de mídias
// - Abre imagens em tela cheia
// - Suporta galeria/mosaico
// - Thumbnails inferiores
// - Navegação anterior/próxima
// - Fecha com ESC ou clique no fundo
// - Coleta itens a partir de .msg-media-img, .msg-media-cell, .msg-sticker e imagens soltas

(function () {
  'use strict';

  const M = window.ZCMediaRender;

  if (!M || !M.__coreReady) {
    console.warn('[media-render][viewer] core.js precisa ser carregado antes.');
    return;
  }

  if (M.__viewerReady) return;
  M.__viewerReady = true;

  const REQUIRED = [
    'escapeHtml',
    'decodeViewerItems',
    'closeIconSvg',
    'chevronLeftSvg',
    'chevronRightSvg',
  ];

  if (!M.require(REQUIRED, 'viewer')) {
    return;
  }

  const {
    escapeHtml,
    decodeViewerItems,
    closeIconSvg,
    chevronLeftSvg,
    chevronRightSvg,
  } = M;

  function itemFromMediaAnchor(anchor) {
    if (!anchor) return null;

    const img = anchor.querySelector('img');

    const href =
      anchor.getAttribute('href') ||
      anchor.dataset?.mediaSrc ||
      anchor.getAttribute('data-media-src') ||
      img?.getAttribute('src') ||
      '';

    const src =
      img?.getAttribute('src') ||
      anchor.dataset?.mediaThumb ||
      anchor.getAttribute('data-media-thumb') ||
      href ||
      '';

    const name =
      anchor.dataset?.name ||
      anchor.getAttribute('data-name') ||
      anchor.dataset?.mediaName ||
      anchor.getAttribute('data-media-name') ||
      img?.getAttribute('alt') ||
      'imagem';

    if (!href && !src) return null;

    return {
      type: 'image',
      src: href || src,
      thumb: src || href,
      name,
    };
  }

  function itemFromSticker(img) {
    if (!img) return null;

    const src = img.getAttribute('src') || '';

    if (!src) return null;

    return {
      type: 'image',
      src,
      thumb: src,
      name: img.getAttribute('alt') || 'figurinha',
    };
  }

  function itemFromLooseImage(img) {
    if (!img) return null;

    const src = img.getAttribute('src') || '';

    if (!src) return null;

    return {
      type: 'image',
      src,
      thumb: src,
      name:
        img.dataset?.name ||
        img.getAttribute('data-name') ||
        img.getAttribute('alt') ||
        'imagem',
    };
  }

  function normalizeViewerItems(items) {
    return (items || [])
      .map((item) => ({
        type: item?.type || 'image',
        src: String(item?.src || '').trim(),
        thumb: String(item?.thumb || item?.src || '').trim(),
        name: String(item?.name || 'imagem').trim() || 'imagem',
      }))
      .filter((item) => item.src);
  }

  function ensureViewer() {
    if (M.state.viewerRef) {
      return M.state.viewerRef;
    }

    const el = document.createElement('div');
    el.className = 'zc-media-viewer';
    el.setAttribute('aria-hidden', 'true');

    el.innerHTML = `
      <div class="zc-media-viewer__backdrop"></div>

      <div class="zc-media-viewer__top">
        <div class="zc-media-viewer__meta">
          <div class="zc-media-viewer__count">1 de 1</div>
          <div class="zc-media-viewer__name">Mídia</div>
        </div>

        <div class="zc-media-viewer__top-actions">
          <button class="zc-media-viewer__icon-btn zc-media-viewer__close" type="button" aria-label="Fechar">
            ${closeIconSvg()}
          </button>
        </div>
      </div>

      <button class="zc-media-viewer__nav zc-media-viewer__nav--prev" type="button" aria-label="Anterior">
        ${chevronLeftSvg()}
      </button>

      <div class="zc-media-viewer__stage">
        <div class="zc-media-viewer__frame">
          <div class="zc-media-viewer__media-wrap">
            <div class="zc-media-viewer__empty">Sem mídia</div>
          </div>
        </div>
      </div>

      <button class="zc-media-viewer__nav zc-media-viewer__nav--next" type="button" aria-label="Próxima">
        ${chevronRightSvg()}
      </button>

      <div class="zc-media-viewer__thumbs"></div>
    `;

    document.body.appendChild(el);

    const ref = {
      el,
      count: el.querySelector('.zc-media-viewer__count'),
      name: el.querySelector('.zc-media-viewer__name'),
      closeBtn: el.querySelector('.zc-media-viewer__close'),
      prevBtn: el.querySelector('.zc-media-viewer__nav--prev'),
      nextBtn: el.querySelector('.zc-media-viewer__nav--next'),
      mediaWrap: el.querySelector('.zc-media-viewer__media-wrap'),
      thumbs: el.querySelector('.zc-media-viewer__thumbs'),
      state: {
        items: [],
        index: 0,
      },
    };

    function pauseStageMedia() {
      ref.mediaWrap.querySelectorAll('video').forEach((video) => {
        try {
          video.pause();
        } catch {}
      });
    }

    function renderThumbs() {
      const { items, index } = ref.state;

      if (!ref.thumbs) return;

      ref.thumbs.innerHTML = items.map((item, idx) => `
        <button
          class="zc-media-viewer__thumb ${idx === index ? 'is-active' : ''}"
          type="button"
          data-index="${idx}"
          aria-label="Abrir mídia ${idx + 1}"
        >
          <img src="${escapeHtml(item.thumb || item.src)}" alt="${escapeHtml(item.name)}">
        </button>
      `).join('');
    }

    function renderCurrent() {
      const { items, index } = ref.state;
      const item = items[index];

      if (!item) {
        ref.mediaWrap.innerHTML = `<div class="zc-media-viewer__empty">Sem mídia</div>`;

        if (ref.count) ref.count.textContent = '0 de 0';
        if (ref.name) ref.name.textContent = 'Mídia';
        if (ref.prevBtn) ref.prevBtn.style.display = 'none';
        if (ref.nextBtn) ref.nextBtn.style.display = 'none';
        if (ref.thumbs) ref.thumbs.innerHTML = '';

        return;
      }

      if (ref.count) {
        ref.count.textContent = `${index + 1} de ${items.length}`;
      }

      if (ref.name) {
        ref.name.textContent = item.name || 'Mídia';
      }

      if (ref.prevBtn) {
        ref.prevBtn.style.display = items.length > 1 ? '' : 'none';
      }

      if (ref.nextBtn) {
        ref.nextBtn.style.display = items.length > 1 ? '' : 'none';
      }

      if (ref.thumbs) {
        ref.thumbs.style.display = items.length > 1 ? '' : 'none';
      }

      pauseStageMedia();

      if (item.type === 'video') {
        ref.mediaWrap.innerHTML = `
          <video
            class="zc-media-viewer__video"
            src="${escapeHtml(item.src)}"
            controls
            autoplay
          ></video>
        `;
      } else {
        ref.mediaWrap.innerHTML = `
          <img
            class="zc-media-viewer__img"
            src="${escapeHtml(item.src)}"
            alt="${escapeHtml(item.name || 'imagem')}"
          >
        `;
      }

      renderThumbs();
    }

    function open(items, index = 0) {
      const normalized = normalizeViewerItems(items);

      if (!normalized.length) return;

      ref.state.items = normalized;
      ref.state.index = Math.max(
        0,
        Math.min(normalized.length - 1, Number(index) || 0)
      );

      renderCurrent();

      ref.el.classList.add('is-open');
      ref.el.setAttribute('aria-hidden', 'false');
      document.body.classList.add('zc-media-viewer-open');
    }

    function close() {
      pauseStageMedia();

      ref.el.classList.remove('is-open');
      ref.el.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('zc-media-viewer-open');
    }

    function go(delta) {
      const items = ref.state.items || [];

      if (!items.length) return;

      const next =
        (ref.state.index + delta + items.length) % items.length;

      ref.state.index = next;
      renderCurrent();
    }

    ref.closeBtn?.addEventListener('click', close);

    ref.el
      .querySelector('.zc-media-viewer__backdrop')
      ?.addEventListener('click', close);

    ref.prevBtn?.addEventListener('click', () => {
      go(-1);
    });

    ref.nextBtn?.addEventListener('click', () => {
      go(1);
    });

    ref.thumbs?.addEventListener('click', (e) => {
      const btn = e.target.closest('.zc-media-viewer__thumb');

      if (!btn) return;

      const idx = Number(btn.dataset.index);

      if (!Number.isFinite(idx)) return;

      ref.state.index = idx;
      renderCurrent();
    });

    document.addEventListener('keydown', (e) => {
      if (!ref.el.classList.contains('is-open')) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(1);
      }
    });

    ref.open = open;
    ref.close = close;
    ref.go = go;
    ref.renderCurrent = renderCurrent;
    ref.renderThumbs = renderThumbs;
    ref.pauseStageMedia = pauseStageMedia;

    M.state.viewerRef = ref;

    return ref;
  }

  function collectViewerItemsFromClick(target) {
    if (!target || typeof target.closest !== 'function') {
      return null;
    }

    const group = target.closest('.msg-media-group');

    if (group) {
      const items = decodeViewerItems(group.dataset.viewerItems || '');
      const idx = Number(
        target.closest('[data-viewer-index]')?.dataset.viewerIndex || 0
      );

      return {
        items,
        index: Number.isFinite(idx) ? idx : 0,
      };
    }

    const mediaAnchor =
      target.closest('.msg-media-cell') ||
      target.closest('.msg-media-img') ||
      target.closest('[data-media-view="1"]');

    if (mediaAnchor) {
      const item = itemFromMediaAnchor(mediaAnchor);

      return item
        ? {
            items: [item],
            index: 0,
          }
        : null;
    }

    const sticker = target.closest('.msg-sticker');

    if (sticker) {
      const item = itemFromSticker(sticker);

      return item
        ? {
            items: [item],
            index: 0,
          }
        : null;
    }

    const looseImg = target.closest('.bubble img');

    if (looseImg && !looseImg.closest('.wa-avatar')) {
      const item = itemFromLooseImage(looseImg);

      return item
        ? {
            items: [item],
            index: 0,
          }
        : null;
    }

    return null;
  }

  function bindViewerClicks() {
    if (document.__zcMediaViewerBound) return;

    document.__zcMediaViewerBound = true;

    document.addEventListener(
      'click',
      (e) => {
        const hit = collectViewerItemsFromClick(e.target);

        if (!hit || !hit.items || !hit.items.length) return;

        const isMedia =
          e.target.closest('.msg-media-cell') ||
          e.target.closest('.msg-media-img') ||
          e.target.closest('[data-media-view="1"]') ||
          e.target.closest('.msg-sticker') ||
          e.target.closest('.bubble img');

        if (!isMedia) return;

        e.preventDefault();
        e.stopPropagation();

        ensureViewer().open(hit.items, hit.index);
      },
      true
    );
  }

  function openMediaViewer(items, index = 0) {
    ensureViewer().open(items, index);
  }

  function closeMediaViewer() {
    const ref = ensureViewer();

    if (ref && typeof ref.close === 'function') {
      ref.close();
    }
  }

  M.extend({
    itemFromMediaAnchor,
    itemFromSticker,
    itemFromLooseImage,

    normalizeViewerItems,

    ensureViewer,
    collectViewerItemsFromClick,
    bindViewerClicks,

    openMediaViewer,
    closeMediaViewer,
  });

  console.log('[media-render] viewer carregado');
})();