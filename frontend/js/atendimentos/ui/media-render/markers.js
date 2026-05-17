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
    'buildCanonUrlByMsgId',
    'makeWaAudioHTML',
  ];

  if (!M.require(REQUIRED, 'markers')) {
    return;
  }

  const {
    escapeHtml,
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
    return /^\[[^\]]+\]$/i.test(String(txt || '').trim());
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
      <img src="${escapeHtml(src)}" alt="imagem" loading="lazy">
    </a>`;
  }

  function renderMarkerSticker(src) {
    return `<img
      class="msg-sticker"
      src="${escapeHtml(src)}"
      alt="figurinha"
      loading="lazy"
    >`;
  }

  function renderMarkerVideo(src) {
    return `<video
      class="msg-media-video"
      controls
      preload="metadata"
      src="${escapeHtml(src)}"
    ></video>`;
  }

  function renderMarkerDocument(src) {
    const fname = 'arquivo.bin';

    return `<div class="doc-card">
      <div class="doc-ico" data-ext="bin">
        <span class="ext">FILE</span>
      </div>

      <div class="doc-body">
        <a
          class="doc-name"
          href="${escapeHtml(src)}"
          target="_blank"
          rel="noopener"
          download="${escapeHtml(fname)}"
          title="${escapeHtml(fname)}"
        >${escapeHtml(fname)}</a>

        <div class="doc-meta">arquivo</div>
      </div>

      <div class="doc-actions">
        <a
          class="doc-btn"
          href="${escapeHtml(src)}"
          target="_blank"
          rel="noopener"
        >Abrir</a>

        <a
          class="doc-btn"
          href="${escapeHtml(src)}"
          download="${escapeHtml(fname)}"
        >Salvar</a>
      </div>
    </div>`;
  }

  function renderHtmlForMarkerKind(kind, src, dir) {
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
        html: renderMarkerDocument(src),
        className: '',
      };
    }

    /*
      Localização/contato/mídias desconhecidas ainda caem como documento,
      porque pelo msg_id a rota canônica pode devolver o arquivo/conteúdo.
    */
    return {
      html: renderMarkerDocument(src),
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

      const rendered = renderHtmlForMarkerKind(kind, src, dir);

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
    const rendered = renderHtmlForMarkerKind(kind, src, dir);

    return rendered.html || '';
  }

  M.extend({
    MARKER_RE,

    markerKind,
    isPureMarkerText,
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