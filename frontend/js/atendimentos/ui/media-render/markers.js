// /frontend/js/atendimentos/ui/media-render/markers.js
// Renderização por marcadores
// - [Imagem]
// - [Vídeo]
// - [Áudio]
// - [Documento]
// - [Figurinha]
// - [Mídia]
// - Usa a URL canônica por msg_id quando a mensagem não veio com anexo estruturado

(function () {
  'use strict';

  const M = window.ZCMediaRender;

  if (!M || !M.__coreReady) {
    console.warn('[media-render][markers] core.js precisa ser carregado antes.');
    return;
  }

  if (M.__markersReady) return;
  M.__markersReady = true;

  const REQUIRED = [
    'escapeHtml',
    'lazyImgAttrs',
    'lazyVideoAttrs',
    'buildCanonUrlByMsgId',
    'makeWaAudioHTML',
  ];

  if (!M.require(REQUIRED, 'markers')) {
    return;
  }

  const {
    escapeHtml,
    lazyImgAttrs,
    lazyVideoAttrs,
    buildCanonUrlByMsgId,
    makeWaAudioHTML,
  } = M;

  const MARKER_RE = /^\[(Imagem|Vídeo|Video|Áudio\/ptt|Áudio|Audio|Documento|Figurinha|Localização|Contatos?|M[íi]dia)\]/i;

  function markerKind(txt) {
    return String(txt || '')
      .replace(/^\[/, '')
      .replace(/\].*$/g, '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function isPureMarkerText(txt) {
    const value = String(txt || '').trim();

    // Documento com nome no texto, por exemplo:
    // [Documento] SantanderComprovantes.pdf
    // O nome já será exibido dentro do card e não deve aparecer duplicado abaixo.
    if (/^\[Documento\]\s*.+$/i.test(value)) return true;

    return /^\[[^\]]+\]$/i.test(value);
  }

  function markerDocumentName(txt) {
    const value = String(txt || '').trim();
    const match = value.match(/^\[Documento\]\s*(.+)$/i);
    const raw = String(match?.[1] || '').trim();
    return raw || 'arquivo.bin';
  }

  function markerDocumentExt(fileName) {
    const clean = String(fileName || '').split(/[?#]/)[0];
    const parts = clean.split('.');
    if (parts.length < 2) return 'bin';
    return String(parts.pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  }

  function hasRenderedMediaInsideBubble(bubble) {
    if (!bubble) return false;

    return !!bubble.querySelector(
      '.wa-audio, audio[controls], .msg-media-img, .msg-media-video, .msg-sticker, .doc-card, .msg-media-group'
    );
  }

  function getMsgIdFromRow(row, bubble) {
    return String(
      row?.getAttribute('data-msg-id') ||
      bubble?.getAttribute('data-msg-id') ||
      row?.getAttribute('data-id') ||
      bubble?.getAttribute('data-id') ||
      row?.dataset?.msgId ||
      bubble?.dataset?.msgId ||
      ''
    ).trim();
  }

  function renderMarkerImage(src) {
    return `<a
      class="msg-media-img msg-media-img--single"
      href="${escapeHtml(src)}"
      data-media-view="1"
      data-zc-media-open="1"
      data-media-kind="image"
      data-media-src="${escapeHtml(src)}"
      data-media-thumb="${escapeHtml(src)}"
      data-media-name="imagem"
      data-name="imagem"
      aria-label="imagem"
    >
      <img ${lazyImgAttrs(src, '')} alt="imagem">
    </a>`;
  }

  function renderMarkerSticker(src) {
    return `<img
      class="msg-sticker"
      ${lazyImgAttrs(src, '')}
      alt="figurinha"
    >`;
  }

  function renderMarkerVideo(src) {
    return `<video
      class="msg-media-video"
      controls
      ${lazyVideoAttrs(src, '')}
    ></video>`;
  }

  function renderMarkerDocument(src, markerText = '') {
    const fname = markerDocumentName(markerText);
    const ext = markerDocumentExt(fname);
    const extLabel = ext === 'bin' ? 'ARQ' : ext.toUpperCase();

    return `<a
      class="doc-card doc-card--marker"
      href="${escapeHtml(src)}"
      target="_blank"
      rel="noopener"
      download="${escapeHtml(fname)}"
      title="${escapeHtml(fname)}"
    >
      <span class="doc-ico" data-ext="${escapeHtml(ext)}">
        <span class="ext">${escapeHtml(extLabel)}</span>
      </span>

      <span class="doc-body">
        <span class="doc-name">${escapeHtml(fname)}</span>
        <span class="doc-meta">${escapeHtml(extLabel)}</span>
      </span>

      <span class="doc-open" aria-hidden="true">↗</span>
    </a>`;
  }

  function renderHtmlForMarkerKind(kind, src, dir, markerText = '') {
    const k = String(kind || '');

    if (k.startsWith('imagem') || k.startsWith('midia')) {
      return {
        html: renderMarkerImage(src),
        className: 'has-media-single',
      };
    }

    if (k.startsWith('figurinha')) {
      return {
        html: renderMarkerSticker(src),
        className: '',
      };
    }

    if (k.startsWith('video')) {
      return {
        html: renderMarkerVideo(src),
        className: '',
      };
    }

    if (k.startsWith('audio')) {
      return {
        html: makeWaAudioHTML([src], { dir }),
        className: '',
      };
    }

    if (k.startsWith('documento')) {
      return {
        html: renderMarkerDocument(src, markerText),
        className: '',
      };
    }

    /*
      Localização/contato/mídias desconhecidas ainda caem como documento,
      porque pelo msg_id a rota canônica pode devolver o arquivo/conteúdo.
    */
    return {
      html: renderMarkerDocument(src, markerText),
      className: '',
    };
  }

  function injectMarkerMedias(root) {
    root = root || document;

    root.querySelectorAll('.msg-row').forEach((row) => {
      const bubble = row.querySelector('.bubble');

      if (!bubble) return;

      if (hasRenderedMediaInsideBubble(bubble)) {
        return;
      }

      const txtEl = bubble.querySelector('.msg-text');
      const txt = String(txtEl?.textContent || '').trim();

      if (!MARKER_RE.test(txt)) {
        return;
      }

      const msgId = getMsgIdFromRow(row, bubble);

      if (!msgId) {
        return;
      }

      const src = buildCanonUrlByMsgId(msgId);

      if (!src) {
        return;
      }

      const kind = markerKind(txt);
      const dir = bubble.classList.contains('bubble-out') ? 'out' : 'in';

      const rendered = renderHtmlForMarkerKind(kind, src, dir, txt);

      if (!rendered.html) {
        return;
      }

      bubble.insertAdjacentHTML('afterbegin', rendered.html);

      if (rendered.className) {
        bubble.classList.add(rendered.className);
      }

      if (txtEl && isPureMarkerText(txt)) {
        txtEl.style.display = 'none';
      }
    });
  }

  function markerMediaHtmlFromMessage(m, texto, dir) {
    const msgId = String(
      m?.msg_id ||
      m?.msgId ||
      m?.message_id ||
      m?.messageId ||
      m?.id ||
      ''
    ).trim();

    const txt = String(texto || '').trim();

    if (!msgId || !MARKER_RE.test(txt)) {
      return '';
    }

    const src = buildCanonUrlByMsgId(msgId);
    const kind = markerKind(txt);
    const rendered = renderHtmlForMarkerKind(kind, src, dir, txt);

    return rendered.html || '';
  }

  M.extend({
    MARKER_RE,

    markerKind,
    isPureMarkerText,
    markerDocumentName,
    markerDocumentExt,
    hasRenderedMediaInsideBubble,
    getMsgIdFromRow,

    renderMarkerImage,
    renderMarkerSticker,
    renderMarkerVideo,
    renderMarkerDocument,
    renderHtmlForMarkerKind,

    injectMarkerMedias,
    markerMediaHtmlFromMessage,
  });

  console.log('[media-render] markers carregado');
})();