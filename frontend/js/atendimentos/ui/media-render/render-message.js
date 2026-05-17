// /frontend/js/atendimentos/ui/media-render/render-message.js
// Render principal de mensagem
// - Monta HTML da bolha
// - Renderiza texto
// - Renderiza anexos/mídias
// - Renderiza galeria/mosaico
// - Renderiza áudio estilo WhatsApp
// - Renderiza documentos
// - Renderiza quoted/reply preview
// - Mantém compatibilidade com window.criarHTMLDaMensagem

(function () {
  'use strict';

  const M = window.ZCMediaRender;

  if (!M || !M.__coreReady) {
    console.warn('[media-render][render-message] core.js precisa ser carregado antes.');
    return;
  }

  if (M.__renderMessageReady) return;
  M.__renderMessageReady = true;

  const REQUIRED = [
    'escapeHtml',
    'humanSize',
    'formatOnlyTime',

    'ensureMsgMediaCss',

    'resolveUrlsForMedia',
    'deriveFileName',

    'isImageAttachment',
    'isGalleryImageAttachment',
    'renderImageGroup',

    'makeWaAudioHTML',

    'MARKER_RE',
    'markerKind',
    'isPureMarkerText',
    'markerMediaHtmlFromMessage',

    'buildQuotedRenderData',
  ];

  if (!M.require(REQUIRED, 'render-message')) {
    return;
  }

  const {
    escapeHtml,
    humanSize,
    formatOnlyTime,

    ensureMsgMediaCss,

    resolveUrlsForMedia,
    deriveFileName,

    isImageAttachment,
    isGalleryImageAttachment,
    renderImageGroup,

    makeWaAudioHTML,

    MARKER_RE,
    markerKind,
    isPureMarkerText,
    markerMediaHtmlFromMessage,

    buildQuotedRenderData,
  } = M;

  function isOutgoingMessage(m) {
    return (
      m?.tipo === 'saida' ||
      m?.from_me === true ||
      m?.fromMe === true ||
      m?.origem === 'atendente'
    );
  }

  function getMessageText(m) {
    return String(
      m?.conteudo ??
      m?.mensagem ??
      m?.texto ??
      m?.body ??
      ''
    ).trim();
  }

  function getMessageId(m) {
    return String(
      m?.msg_id ||
      m?.msgId ||
      m?.message_id ||
      m?.messageId ||
      m?.wa_msg_id ||
      m?.waMsgId ||
      m?.id ||
      ''
    ).trim();
  }

  function getMessageTimestamp(m) {
    return (
      m?.timestamp ||
      m?.data ||
      m?.created_at ||
      m?.createdAt ||
      m?.ts ||
      ''
    );
  }

  function collectMessageAttachments(m) {
    let anexos = [];

    if (Array.isArray(m?.midias) && m.midias.length) {
      anexos.push(...m.midias.filter(Boolean));
    } else if (Array.isArray(m?.anexos) && m.anexos.length) {
      anexos.push(...m.anexos.filter(Boolean));
    } else if (m?.midia && typeof m.midia === 'object') {
      anexos.push(m.midia);
    }

    const seen = new Set();

    anexos = anexos.filter((a) => {
      if (!a) return false;

      const k = [
        a.id ?? '',
        a.url || a.url_api || a.link || a.path || '',
        a.tipo || a.tipo_midia || '',
        a.mimetype || a.mime || '',
        a.filename || a.name || a.fileName || '',
      ].join('|');

      if (seen.has(k)) return false;

      seen.add(k);
      return true;
    });

    return anexos;
  }

  function getAckHtml(m, msgIdEsc, isSaida) {
    if (!isSaida || typeof window.getAckIcon !== 'function') {
      return '';
    }

    try {
      let ackHtml = String(window.getAckIcon(m?.ack ?? 0) || '');

      if (ackHtml.includes('<span class="msg-ack"') && msgIdEsc) {
        ackHtml = ackHtml.replace(
          '<span class="msg-ack"',
          `<span class="msg-ack" data-msg-id="${msgIdEsc}"`
        );
      }

      return ackHtml;
    } catch {
      return '';
    }
  }

  function attachmentMime(a) {
    return String(a?.mimetype || a?.mime || '').toLowerCase();
  }

  function attachmentTipo(a) {
    return String(a?.tipo || a?.tipo_midia || '').toLowerCase();
  }

  function attachmentRawName(a) {
    return (
      a?.filename ||
      a?.name ||
      a?.fileName ||
      a?.nome_original ||
      'arquivo'
    );
  }

  function renderImageAttachment(m, a, url, alts) {
    const mime = attachmentMime(a);
    const tipo = attachmentTipo(a);
    const name = attachmentRawName(a);

    if (tipo.includes('figurinha') || tipo.includes('sticker')) {
      return `<img
        class="msg-sticker"
        src="${escapeHtml(url)}"
        data-alt="${escapeHtml(alts.join('|'))}"
        alt="${escapeHtml(name)}"
        loading="lazy"
      >`;
    }

    const { fileName } = deriveFileName({
      mimetype: mime,
      filename: name,
      url,
    });

    return `<a
      class="msg-media-img msg-media-img--single"
      href="${escapeHtml(url)}"
      data-media-view="1"
      data-zc-media-open="1"
      data-media-kind="image"
      data-media-src="${escapeHtml(url)}"
      data-media-thumb="${escapeHtml(url)}"
      data-media-alt="${escapeHtml(alts.join('|'))}"
      data-media-name="${escapeHtml(fileName)}"
      data-name="${escapeHtml(fileName)}"
      aria-label="${escapeHtml(fileName)}"
    >
      <img
        src="${escapeHtml(url)}"
        data-alt="${escapeHtml(alts.join('|'))}"
        alt="${escapeHtml(name)}"
        loading="lazy"
      >
    </a>`;
  }

  function renderVideoAttachment(url, alts) {
    return `<video
      class="msg-media-video"
      controls
      preload="metadata"
      src="${escapeHtml(url)}"
      data-alt="${escapeHtml(alts.join('|'))}"
    ></video>`;
  }

  function renderAudioAttachment(urls, dir) {
    return makeWaAudioHTML(urls, { dir });
  }

  function renderDocumentAttachment(a, url) {
    const mime = attachmentMime(a);
    const name = attachmentRawName(a);

    const { fileName, extUp, extLower } = deriveFileName({
      mimetype: mime,
      filename: name,
      url,
    });

    const sizeTxt =
      humanSize(a?.size || a?.bytes || a?.length) ||
      '';

    return `<div class="doc-card">
      <div class="doc-ico" data-ext="${escapeHtml(extLower)}">
        <span class="ext">${escapeHtml(extUp)}</span>
      </div>

      <div class="doc-body">
        <a
          class="doc-name"
          href="${escapeHtml(url)}"
          target="_blank"
          rel="noopener"
          download="${escapeHtml(fileName)}"
          title="${escapeHtml(fileName)}"
        >${escapeHtml(fileName)}</a>

        <div class="doc-meta">${escapeHtml(sizeTxt || 'arquivo')}</div>
      </div>

      <div class="doc-actions">
        <a
          class="doc-btn"
          href="${escapeHtml(url)}"
          target="_blank"
          rel="noopener"
        >Abrir</a>

        <a
          class="doc-btn"
          href="${escapeHtml(url)}"
          download="${escapeHtml(fileName)}"
        >Salvar</a>
      </div>
    </div>`;
  }

  function renderAttachment(m, a, dir) {
    const urls = resolveUrlsForMedia(m, a);
    const [url, ...alts] = urls;

    if (!url) return '';

    const mime = attachmentMime(a);
    const tipo = attachmentTipo(a);

    if (isImageAttachment(a)) {
      return renderImageAttachment(m, a, url, alts);
    }

    if (
      tipo.includes('vídeo') ||
      tipo.includes('video') ||
      mime.startsWith('video/')
    ) {
      return renderVideoAttachment(url, alts);
    }

    if (
      tipo.includes('áudio') ||
      tipo.includes('audio') ||
      tipo.includes('ptt') ||
      mime.startsWith('audio/')
    ) {
      return renderAudioAttachment(urls, dir);
    }

    return renderDocumentAttachment(a, url);
  }

  function buildMediaHtmlFromAttachments(m, anexos, dir) {
    const onlyGalleryImages =
      anexos.length > 1 &&
      anexos.every(isGalleryImageAttachment);

    if (onlyGalleryImages) {
      return {
        html: renderImageGroup(m, anexos),
        onlyGalleryImages: true,
        hasSingleImagePreview: false,
      };
    }

    const hasSingleImagePreview =
      anexos.length === 1 &&
      anexos.every(isGalleryImageAttachment);

    return {
      html: anexos.map((a) => renderAttachment(m, a, dir)).join(''),
      onlyGalleryImages: false,
      hasSingleImagePreview,
    };
  }

  function isMarkerImageLike(texto) {
    if (!texto || !MARKER_RE.test(texto)) return false;

    const kind = markerKind(texto);

    return (
      kind.startsWith('imagem') ||
      kind.startsWith('midia')
    );
  }

  function buildMediaHtmlFromMarker(m, texto, dir) {
    if (!texto || !MARKER_RE.test(texto)) {
      return '';
    }

    return markerMediaHtmlFromMessage(m, texto, dir) || '';
  }

  function buildTextHtml(texto, hasMedia) {
    const shouldHidePureMarkerText =
      hasMedia &&
      isPureMarkerText(texto);

    if (texto && !shouldHidePureMarkerText) {
      return `<div class="msg-text">${escapeHtml(texto)}</div>`;
    }

    if (!hasMedia) {
      return `<div class="msg-text">&nbsp;</div>`;
    }

    return '';
  }

  function criarHTMLDaMensagem(m) {
    ensureMsgMediaCss();

    const isSaida = isOutgoingMessage(m);
    const dir = isSaida ? 'out' : 'in';

    const hora = formatOnlyTime(getMessageTimestamp(m));
    const texto = getMessageText(m);

    const msgId = getMessageId(m);
    const msgIdEsc = escapeHtml(msgId);

    const ackHtml = getAckHtml(m, msgIdEsc, isSaida);

    const quotedData = buildQuotedRenderData(m);
    const quotedPreview = quotedData.quotedPreview;
    const quotedPreviewData = quotedData.quotedPreviewData || '';
    const quotedDataAttr = quotedData.quotedData || '';
    const quoteHtml = quotedData.quoteHtml || '';

    const anexos = collectMessageAttachments(m);

    const mediaFromAttachments = buildMediaHtmlFromAttachments(m, anexos, dir);

    let mediaHtml = mediaFromAttachments.html || '';
    let onlyGalleryImages = mediaFromAttachments.onlyGalleryImages;
    let hasSingleImagePreview = mediaFromAttachments.hasSingleImagePreview;

    if (!mediaHtml && msgId && MARKER_RE.test(texto)) {
      mediaHtml = buildMediaHtmlFromMarker(m, texto, dir);

      if (mediaHtml && isMarkerImageLike(texto)) {
        hasSingleImagePreview = true;
      }
    }

    const hasMedia = mediaHtml.trim().length > 0;
    const textHtml = buildTextHtml(texto, hasMedia);

    const rowClasses = [
      'msg-row',
      isSaida ? 'msg-sent' : 'msg-received',
      quotedPreview ? 'has-quoted' : '',
    ].filter(Boolean).join(' ');

    const bubbleClasses = [
      'bubble',
      isSaida ? 'bubble-out' : 'bubble-in',
      onlyGalleryImages ? 'has-media-group' : '',
      hasSingleImagePreview ? 'has-media-single' : '',
      quotedPreview ? 'has-quoted' : '',
    ].filter(Boolean).join(' ');

    return `<div class="${rowClasses}"
      data-id="${msgIdEsc}"
      data-msg-id="${msgIdEsc}"
      data-message-id="${msgIdEsc}"
      data-wa-msg-id="${msgIdEsc}"
      data-from-me="${isSaida ? '1' : '0'}"${quotedPreviewData}${quotedDataAttr}>
      <div class="${bubbleClasses}"
        data-msg-id="${msgIdEsc}"
        data-message-id="${msgIdEsc}"
        data-wa-msg-id="${msgIdEsc}"
        data-from-me="${isSaida ? '1' : '0'}"${quotedPreviewData}${quotedDataAttr}>
        ${quoteHtml}
        ${mediaHtml}
        ${textHtml}
        <div class="meta">
          ${ackHtml}
          <span class="msg-time">${escapeHtml(hora)}</span>
        </div>
      </div>
    </div>`;
  }

  M.extend({
    isOutgoingMessage,
    getMessageText,
    getMessageId,
    getMessageTimestamp,
    collectMessageAttachments,

    getAckHtml,

    attachmentMime,
    attachmentTipo,
    attachmentRawName,

    renderImageAttachment,
    renderVideoAttachment,
    renderAudioAttachment,
    renderDocumentAttachment,
    renderAttachment,

    buildMediaHtmlFromAttachments,
    buildMediaHtmlFromMarker,
    buildTextHtml,

    criarHTMLDaMensagem,
  });

  M.exposeGlobal?.('criarHTMLDaMensagem', criarHTMLDaMensagem);

  console.log('[media-render] render-message carregado');
})();