// /frontend/js/atendimentos/ui/media-render/quoted.js
// Preview de mensagem respondida dentro da bolha
// - Normaliza quoted_preview / reply_preview
// - Normaliza quoted / quotedMessage da Evolution
// - Renderiza .zc-quoted-bubble
// - Expõe helpers para render-message.js
// - Clique no quoted tenta focar a mensagem original

(function () {
  'use strict';

  const M = window.ZCMediaRender;

  if (!M || !M.__coreReady) {
    console.warn('[media-render][quoted] core.js precisa ser carregado antes.');
    return;
  }

  if (M.__quotedReady) return;
  M.__quotedReady = true;

  const REQUIRED = [
    'escapeHtml',
    'cleanOneLine',
    'jsonAttr',
    'H',
    'injectStyle',
  ];

  if (!M.require(REQUIRED, 'quoted')) {
    return;
  }

  const {
    escapeHtml,
    cleanOneLine,
    jsonAttr,
    H,
    injectStyle,
  } = M;

  function ensureQuotedFocusCss() {
    injectStyle('zc-media-render-quoted-focus-css', `
      .msg-row.zc-quoted-target-hit .bubble{
        outline:2px solid rgba(83,189,235,.95);
        box-shadow:0 0 0 5px rgba(83,189,235,.16);
      }

      .bubble.zc-quoted-target-hit{
        outline:2px solid rgba(83,189,235,.95);
        box-shadow:0 0 0 5px rgba(83,189,235,.16);
      }
    `);
  }

  function firstTextFromQuotedMessageObject(message) {
    if (!message || typeof message !== 'object') return '';

    return cleanOneLine(
      message.conversation ||
      message?.extendedTextMessage?.text ||
      message?.imageMessage?.caption ||
      message?.videoMessage?.caption ||
      message?.documentMessage?.caption ||
      ''
    );
  }

  function mediaLabelFromQuotedMessageObject(message) {
    if (!message || typeof message !== 'object') return '';

    if (message.imageMessage) return '[imagem]';
    if (message.videoMessage) return '[vídeo]';
    if (message.audioMessage) return '[áudio]';
    if (message.documentMessage) return '[documento]';
    if (message.stickerMessage) return '[figurinha]';
    if (message.locationMessage) return '[localização]';
    if (message.contactMessage || message.contactsArrayMessage) return '[contato]';

    return '';
  }

  function normalizeDirection(value, fallback = 'in') {
    const v = String(value || '').toLowerCase().trim();

    if (
      v === 'out' ||
      v === 'saida' ||
      v === 'sent' ||
      v === 'atendente' ||
      v === 'me' ||
      v === 'from_me'
    ) {
      return 'out';
    }

    if (
      v === 'in' ||
      v === 'entrada' ||
      v === 'received' ||
      v === 'cliente' ||
      v === 'contato'
    ) {
      return 'in';
    }

    return fallback === 'out' ? 'out' : 'in';
  }

  function normalizeQuotedPreviewFromDirect(direct) {
    if (!direct || typeof direct !== 'object') return null;

    const direction = normalizeDirection(
      direct.direction ||
      direct.dir ||
      direct.tipo ||
      direct.origem ||
      '',
      'in'
    );

    const msgId = String(
      direct.msg_id ||
      direct.id ||
      direct.message_id ||
      direct.wa_msg_id ||
      direct.key_id ||
      direct.keyId ||
      ''
    ).trim();

    const text = cleanOneLine(
      direct.text ||
      direct.conversation ||
      direct.caption ||
      direct.conteudo ||
      direct.mensagem ||
      direct.body ||
      '',
      '[mensagem]'
    );

    const author = cleanOneLine(
      direct.author ||
      direct.nome ||
      direct.name ||
      direct.push_name ||
      direct.pushName ||
      direct.sender ||
      '',
      direction === 'out' ? 'Você' : 'Contato'
    );

    return {
      msg_id: msgId,
      text,
      author,
      direction,
    };
  }

  function normalizeQuotedPreviewFromEvolutionQuoted(quoted) {
    if (!quoted || typeof quoted !== 'object') return null;

    const key = quoted.key || quoted.messageKey || quoted.message_key || {};
    const message = quoted.message || quoted.quotedMessage || quoted.quoted_message || quoted;

    const text =
      firstTextFromQuotedMessageObject(message) ||
      mediaLabelFromQuotedMessageObject(message) ||
      cleanOneLine(
        quoted.text ||
        quoted.conteudo ||
        quoted.mensagem ||
        quoted.caption ||
        quoted.body ||
        '',
        '[mensagem]'
      );

    const fromMe = Boolean(
      key?.fromMe ||
      quoted.from_me === true ||
      quoted.fromMe === true ||
      quoted.origem === 'atendente' ||
      quoted.tipo === 'saida'
    );

    const msgId = String(
      key?.id ||
      quoted.msg_id ||
      quoted.id ||
      quoted.message_id ||
      quoted.wa_msg_id ||
      quoted.key_id ||
      ''
    ).trim();

    const author = cleanOneLine(
      quoted.author ||
      quoted.nome ||
      quoted.name ||
      quoted.push_name ||
      quoted.pushName ||
      '',
      fromMe ? 'Você' : 'Contato'
    );

    return {
      msg_id: msgId,
      text,
      author,
      direction: fromMe ? 'out' : 'in',
    };
  }

  function normalizeQuotedPreviewFromMsg(m) {
    const direct =
      m?.quoted_preview ||
      m?.quotedPreview ||
      m?.reply_preview ||
      m?.replyPreview ||
      null;

    if (direct && typeof direct === 'object') {
      return normalizeQuotedPreviewFromDirect(direct);
    }

    const quoted =
      m?.quoted ||
      m?.quote ||
      m?.quotedMessage ||
      m?.quoted_message ||
      null;

    if (!quoted || typeof quoted !== 'object') {
      return null;
    }

    return normalizeQuotedPreviewFromEvolutionQuoted(quoted);
  }

  function renderQuotedPreviewHtml(q) {
    if (!q || typeof q !== 'object') return '';

    const msgId = escapeHtml(q.msg_id || q.id || '');
    const author = escapeHtml(
      q.author || (q.direction === 'out' ? 'Você' : 'Contato')
    );
    const text = escapeHtml(
      q.text || q.conversation || '[mensagem]'
    );

    return `
      <div class="zc-quoted-bubble" data-quoted-msg-id="${msgId}" title="Mensagem respondida">
        <div class="zc-quoted-bar" aria-hidden="true"></div>
        <div class="zc-quoted-content">
          <div class="zc-quoted-author">${author}</div>
          <div class="zc-quoted-text">${text}</div>
        </div>
      </div>
    `;
  }

  function buildQuotedRenderData(m) {
    const quotedPreview = normalizeQuotedPreviewFromMsg(m);

    const quotedPreviewAttr = quotedPreview
      ? jsonAttr(quotedPreview)
      : '';

    const quotedAttr = m?.quoted && typeof m.quoted === 'object'
      ? jsonAttr(m.quoted)
      : '';

    const quotedPreviewData = quotedPreviewAttr
      ? ` data-quoted-preview="${quotedPreviewAttr}"`
      : '';

    const quotedData = quotedAttr
      ? ` data-quoted="${quotedAttr}"`
      : '';

    const quoteHtml = renderQuotedPreviewHtml(quotedPreview);

    return {
      quotedPreview,
      quotedPreviewAttr,
      quotedAttr,
      quotedPreviewData,
      quotedData,
      quoteHtml,
      hasQuoted: !!quotedPreview,
    };
  }

  function findQuotedTargetRow(msgId) {
    const id = String(msgId || '').trim();

    if (!id) return null;

    const hist = H();

    if (!hist) return null;

    const selectors = [
      `.msg-row[data-msg-id="${cssEscape(id)}"]`,
      `.msg-row[data-message-id="${cssEscape(id)}"]`,
      `.msg-row[data-wa-msg-id="${cssEscape(id)}"]`,
      `.msg-row[data-id="${cssEscape(id)}"]`,
      `.bubble[data-msg-id="${cssEscape(id)}"]`,
      `.bubble[data-message-id="${cssEscape(id)}"]`,
      `.bubble[data-wa-msg-id="${cssEscape(id)}"]`,
    ];

    for (const sel of selectors) {
      try {
        const el = hist.querySelector(sel);

        if (el) {
          return el.classList.contains('msg-row')
            ? el
            : el.closest('.msg-row') || el;
        }
      } catch {}
    }

    return null;
  }

  function cssEscape(value) {
    const s = String(value || '');

    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(s);
    }

    return s.replace(/["\\]/g, '\\$&');
  }

  function focusQuotedMessage(msgId) {
    ensureQuotedFocusCss();

    const target = findQuotedTargetRow(msgId);

    if (!target) {
      return false;
    }

    const row = target.classList?.contains('msg-row')
      ? target
      : target.closest?.('.msg-row') || target;

    const bubble = row.querySelector?.('.bubble') || row;

    try {
      row.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    } catch {
      row.scrollIntoView?.();
    }

    row.classList.add('zc-quoted-target-hit');
    bubble.classList.add('zc-quoted-target-hit');

    setTimeout(() => {
      row.classList.remove('zc-quoted-target-hit');
      bubble.classList.remove('zc-quoted-target-hit');
    }, 2600);

    return true;
  }

  function bindQuotedPreviewClicks(root = document) {
    const doc = root === document ? document : root;

    if (doc.__zcQuotedPreviewBound) return;

    doc.__zcQuotedPreviewBound = true;

    doc.addEventListener('click', (e) => {
      const quoted = e.target?.closest?.('.zc-quoted-bubble');

      if (!quoted) return;

      const msgId = quoted.getAttribute('data-quoted-msg-id') || '';

      if (!msgId) return;

      const focused = focusQuotedMessage(msgId);

      if (focused) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  M.extend({
    ensureQuotedFocusCss,

    firstTextFromQuotedMessageObject,
    mediaLabelFromQuotedMessageObject,

    normalizeDirection,
    normalizeQuotedPreviewFromDirect,
    normalizeQuotedPreviewFromEvolutionQuoted,
    normalizeQuotedPreviewFromMsg,

    renderQuotedPreviewHtml,
    buildQuotedRenderData,

    findQuotedTargetRow,
    focusQuotedMessage,
    bindQuotedPreviewClicks,
  });

  console.log('[media-render] quoted carregado');
})();