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
    'eagerImgAttrs',
    'lazyImgAttrs',
    'lazyVideoAttrs',
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
    eagerImgAttrs,
    lazyImgAttrs,
    lazyVideoAttrs,
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

  function looksLikeSystemEventText(value) {
    try {
      const txt = String(value || '').trim().toLowerCase();
      if (!txt) return false;

      return (
        txt.includes('assumiu este atendimento') ||
        txt.includes('liberou este atendimento') ||
        txt.includes('transferiu este atendimento') ||
        txt.includes('atendimento liberado automaticamente') ||
        txt.includes('voltou para') && txt.includes('expediente')
      );
    } catch {
      return false;
    }
  }

  function isSystemMessage(m) {
    const tipo = String(m?.tipo || m?.message_type || m?.messageType || '').trim().toLowerCase();
    const origem = String(m?.origem || m?.origin || m?.source || '').trim().toLowerCase();
    const msgId = getMessageId(m).toLowerCase();
    const text = getMessageText(m);

    return (
      tipo === 'sistema' ||
      tipo === 'system' ||
      tipo === 'evento' ||
      origem === 'sistema' ||
      origem === 'system' ||
      msgId.startsWith('sys:') ||
      looksLikeSystemEventText(text)
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

  function parseReactionText(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const m = raw.match(/^\[\s*Rea[cç][aã]o\s*\]\s*(.*)$/i);
    if (!m) return null;

    let rest = String(m[1] || '').trim();

    // Compatibilidade com registros antigos: "[Reação] 👍 → ACA..." / "⇢ 3EB..."
    rest = rest
      .replace(/\s*(?:[→⇢➜➡]|-{1,2}>|=>)\s*[A-Za-z0-9._:@-]+.*$/u, '')
      .trim();

    if (!rest) {
      return { emoji: '', chatText: '[Reação]', previewText: '[Reação]' };
    }

    return {
      emoji: rest,
      chatText: rest,
      previewText: `[Reação] ${rest}`,
    };
  }

  function normalizeReactionTextForChat(value) {
    const parsed = parseReactionText(value);
    return parsed ? parsed.chatText : String(value || '').trim();
  }

  function normalizeReactionTextForPreview(value) {
    const parsed = parseReactionText(value);
    return parsed ? parsed.previewText : String(value || '').trim();
  }

  function looksLikeChatbotText(value) {
    try {
      const txt = String(value || '').trim().toLowerCase();
      if (!txt) return false;
      return (
        txt.includes('para direcionar seu atendimento') ||
        txt.includes('digite apenas o número da opção desejada') ||
        txt.includes('bem-vindo(a)') ||
        txt.includes('vou te encaminhar para') ||
        txt.includes('não entendi sua opção') ||
        txt.includes('não consegui identificar a opção desejada')
      );
    } catch {
      return false;
    }
  }

  function isBotOutgoingMessage(m) {
    const msgId = getMessageId(m).toLowerCase();
    const origem = String(m?.origem || m?.origin || m?.source || '').trim().toLowerCase();
    const text = getMessageText(m);

    return (
      msgId.startsWith('bot:') ||
      origem === 'bot' ||
      origem === 'chatbot' ||
      looksLikeChatbotText(text)
    );
  }

  function getOutgoingAuthorName(m) {
    const raw = (
      m?.autor_nome ||
      m?.enviado_por_nome ||
      m?.colaborador_nome ||
      m?.atendente_nome ||
      m?.sender_name ||
      m?.user_nome ||
      m?.operador_nome ||
      ''
    );

    const name = String(raw || '').trim();
    const lowerName = name.toLowerCase();

    // Se o backend ainda devolveu "WhatsApp" para uma mensagem automática,
    // o front corrige visualmente para "Bot" pelo conteúdo/origem.
    if (isBotOutgoingMessage(m)) {
      return 'Bot';
    }

    if (name && !['null', 'undefined', 'nan'].includes(lowerName)) {
      return name;
    }

    // Saída sem colaborador identificado = mensagem enviada fora do ZapsChat,
    // normalmente direto pelo WhatsApp/celular conectado.
    // Não inventamos atendente; exibimos uma origem neutra e clara.
    return 'WhatsApp';
  }

  function normalizeAuthorKey(name) {
    try {
      return String(name || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    } catch {
      return String(name || '').trim().toLowerCase();
    }
  }

  function getAuthorFirstName(name) {
    const full = String(name || '').trim().replace(/\s+/g, ' ');
    if (!full) return '';

    const first = full.split(' ')[0] || full;
    if (!first) return '';

    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }

  function applyOutgoingAuthorGrouping(root) {
    try {
      const scope = root || document;
      const nodes = Array.from(scope.querySelectorAll('.zc-day-divider, .msg-row'));
      let lastDir = '';
      let lastAuthorKey = '';

      for (const node of nodes) {
        if (node?.matches?.('.zc-day-divider')) {
          lastDir = '';
          lastAuthorKey = '';
          continue;
        }

        const row = node;
        const bubble = row.querySelector?.('.bubble');
        const authorEl = bubble?.querySelector?.('.zc-msg-author');
        const isOut =
          row.classList?.contains('msg-sent') ||
          bubble?.classList?.contains('bubble-out') ||
          row.dataset?.fromMe === '1' ||
          bubble?.dataset?.fromMe === '1';

        if (!isOut) {
          lastDir = 'in';
          lastAuthorKey = '';
          continue;
        }

        if (!authorEl) {
          lastDir = 'out';
          lastAuthorKey = '';
          continue;
        }

        const rawName = (
          row.dataset?.authorName ||
          bubble?.dataset?.authorName ||
          authorEl.getAttribute('title') ||
          authorEl.textContent ||
          ''
        );
        const key = row.dataset?.authorKey || bubble?.dataset?.authorKey || normalizeAuthorKey(rawName);

        if (!key) {
          authorEl.style.display = 'none';
          bubble?.classList?.add('zc-author-hidden');
          row.classList?.add('zc-author-repeated');
          lastDir = 'out';
          lastAuthorKey = '';
          continue;
        }

        const repeated = lastDir === 'out' && lastAuthorKey === key;
        row.classList?.toggle('zc-author-repeated', repeated);
        bubble?.classList?.toggle('zc-author-hidden', repeated);
        authorEl.style.display = repeated ? 'none' : '';

        lastDir = 'out';
        lastAuthorKey = key;
      }
    } catch {}
  }

  try {
    window.ZCNormalizeAuthorKey = window.ZCNormalizeAuthorKey || normalizeAuthorKey;
    window.ZCGetAuthorFirstName = window.ZCGetAuthorFirstName || getAuthorFirstName;
    window.ZCApplyOutgoingAuthorGrouping = applyOutgoingAuthorGrouping;
  } catch {}

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


  function attachmentBytes(a) {
    const raw = Number(
      a?.size ??
      a?.bytes ??
      a?.length ??
      a?.file_size ??
      a?.filesize ??
      0
    );
    return Number.isFinite(raw) ? raw : 0;
  }

  function shouldUseEagerImage(a) {
    const tipo = attachmentTipo(a);
    const mime = attachmentMime(a);
    const bytes = attachmentBytes(a);

    if (tipo.includes('figurinha') || tipo.includes('sticker')) return true;
    if (!mime.startsWith('image/') && !tipo.includes('imagem') && !tipo.includes('image')) return false;

    // Mais parecido com WhatsApp Web: miniaturas e imagens leves aparecem logo.
    if (!bytes) return true;
    return bytes <= 420000;
  }

  function renderImageAttachment(m, a, url, alts) {
    const mime = attachmentMime(a);
    const tipo = attachmentTipo(a);
    const name = attachmentRawName(a);

    if (tipo.includes('figurinha') || tipo.includes('sticker')) {
      return `<img
        class="msg-sticker"
        ${eagerImgAttrs(url, alts.join('|'))}
        alt="${escapeHtml(name)}"
      >`;
    }

    const { fileName } = deriveFileName({
      mimetype: mime,
      filename: name,
      url,
    });

    const imgAttrs = shouldUseEagerImage(a)
      ? eagerImgAttrs(url, alts.join('|'))
      : lazyImgAttrs(url, alts.join('|'));

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
        ${imgAttrs}
        alt="${escapeHtml(name)}"
      >
    </a>`;
  }

  function renderVideoAttachment(url, alts) {
    return `<video
      class="msg-media-video"
      controls
      ${lazyVideoAttrs(url, alts.join('|'))}
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

    const safeExtUp = String(extUp || 'ARQ').trim() || 'ARQ';
    const sizeTxt = humanSize(a?.size || a?.bytes || a?.length) || '';
    const metaText = [safeExtUp, sizeTxt].filter(Boolean).join(' • ') || 'arquivo';

    return `<a
      class="doc-card"
      href="${escapeHtml(url)}"
      target="_blank"
      rel="noopener"
      download="${escapeHtml(fileName)}"
      title="${escapeHtml(fileName)}"
    >
      <span class="doc-ico" data-ext="${escapeHtml(extLower)}">
        <span class="ext">${escapeHtml(safeExtUp)}</span>
      </span>

      <span class="doc-body">
        <span class="doc-name">${escapeHtml(fileName)}</span>
        <span class="doc-meta">${escapeHtml(metaText)}</span>
      </span>

      <span class="doc-open" aria-hidden="true">↗</span>
    </a>`;
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

    const hora = formatOnlyTime(getMessageTimestamp(m));
    const textoRaw = getMessageText(m);
    const reactionData = parseReactionText(textoRaw);
    const texto = reactionData ? reactionData.chatText : textoRaw;

    const msgId = getMessageId(m);
    const msgIdEsc = escapeHtml(msgId);

    if (isSystemMessage(m)) {
      return `<div class="msg-row msg-system"
        data-id="${msgIdEsc}"
        data-msg-id="${msgIdEsc}"
        data-message-id="${msgIdEsc}"
        data-wa-msg-id="${msgIdEsc}"
        data-from-me="0"
        data-system-message="1">
        <div class="zc-system-card" role="note" aria-label="Evento do atendimento">
          <span class="zc-system-icon" aria-hidden="true">i</span>
          <span class="zc-system-text">${escapeHtml(texto)}</span>
          ${hora ? `<span class="zc-system-time">${escapeHtml(hora)}</span>` : ''}
        </div>
      </div>`;
    }

    const isSaida = isOutgoingMessage(m);
    const dir = isSaida ? 'out' : 'in';

    const ackHtml = getAckHtml(m, msgIdEsc, isSaida);
    const authorName = isSaida ? getOutgoingAuthorName(m) : '';
    const authorLabel = authorName ? getAuthorFirstName(authorName) : '';
    const authorKey = authorName ? normalizeAuthorKey(authorName) : '';
    const authorNameEsc = escapeHtml(authorName);
    const authorKeyEsc = escapeHtml(authorKey);
    const authorHtml = (!reactionData && authorLabel)
      ? `<div class="zc-msg-author zc-msg-author-out" title="${authorNameEsc}" data-author-key="${authorKeyEsc}">${escapeHtml(authorLabel)}</div>`
      : '';

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
    const textHtml = reactionData
      ? `<div class="msg-text msg-reaction-text" title="${escapeHtml(reactionData.previewText || '[Reação]')}">${escapeHtml(reactionData.chatText || '👍')}</div>`
      : buildTextHtml(texto, hasMedia);

    const rowClasses = [
      'msg-row',
      isSaida ? 'msg-sent' : 'msg-received',
      reactionData ? 'msg-reaction-row' : '',
      quotedPreview ? 'has-quoted' : '',
    ].filter(Boolean).join(' ');

    const bubbleClasses = [
      'bubble',
      isSaida ? 'bubble-out' : 'bubble-in',
      reactionData ? 'bubble-reaction' : '',
      onlyGalleryImages ? 'has-media-group' : '',
      hasSingleImagePreview ? 'has-media-single' : '',
      quotedPreview ? 'has-quoted' : '',
    ].filter(Boolean).join(' ');

    const authorDataAttrs = authorKey
      ? ` data-author-key="${authorKeyEsc}" data-author-name="${authorNameEsc}"`
      : '';

    return `<div class="${rowClasses}"
      data-id="${msgIdEsc}"
      data-msg-id="${msgIdEsc}"
      data-message-id="${msgIdEsc}"
      data-wa-msg-id="${msgIdEsc}"
      data-from-me="${isSaida ? '1' : '0'}"${authorDataAttrs}${quotedPreviewData}${quotedDataAttr}>
      <div class="${bubbleClasses}"
        data-msg-id="${msgIdEsc}"
        data-message-id="${msgIdEsc}"
        data-wa-msg-id="${msgIdEsc}"
        data-from-me="${isSaida ? '1' : '0'}"${authorDataAttrs}${quotedPreviewData}${quotedDataAttr}>
        ${authorHtml}
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
    isSystemMessage,
    getMessageText,
    getMessageId,
    getMessageTimestamp,
    parseReactionText,
    normalizeReactionTextForChat,
    normalizeReactionTextForPreview,
    getOutgoingAuthorName,
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

  try {
    window.ZCParseReactionText = window.ZCParseReactionText || parseReactionText;
    window.ZCNormalizeReactionTextForChat = window.ZCNormalizeReactionTextForChat || normalizeReactionTextForChat;
    window.ZCNormalizeReactionTextForPreview = window.ZCNormalizeReactionTextForPreview || normalizeReactionTextForPreview;
  } catch {}

  M.exposeGlobal?.('criarHTMLDaMensagem', criarHTMLDaMensagem);

  console.log('[media-render] render-message carregado');
})();