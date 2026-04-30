// /frontend/js/atendimentos/ui/message-actions.js

(function () {
  if (window.__zcMessageActionsLoaded) return;
  window.__zcMessageActionsLoaded = true;

  const HIST_SELECTOR = '#historico';
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

  let menuEl = null;
  let reactEl = null;
  let activeBubble = null;
  let activeShell = null;
  let observer = null;

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function $all(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function isDesktopHover() {
    try {
      return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    } catch {
      return true;
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[m]));
  }

  function createToast(msg, ok = true) {
    let t = document.getElementById('__zc_msg_actions_toast');

    if (!t) {
      t = document.createElement('div');
      t.id = '__zc_msg_actions_toast';
      t.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:26px',
        'transform:translateX(-50%)',
        'z-index:10050',
        'background:#161717',
        'color:#fff',
        'padding:10px 14px',
        'border-radius:10px',
        'font-size:13px',
        'box-shadow:0 10px 28px rgba(0,0,0,.28)',
        'opacity:0',
        'pointer-events:none',
        'transition:opacity .16s ease'
      ].join(';');

      document.body.appendChild(t);
    }

    t.textContent = String(msg || '');
    t.style.background = ok ? '#161717' : '#7f1d1d';
    t.style.opacity = '1';

    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => {
      t.style.opacity = '0';
    }, 1500);
  }

  function ensureGlobals() {
    if (!menuEl) {
      menuEl = document.createElement('div');
      menuEl.className = 'zc-msg-menu';
      menuEl.innerHTML = `
        <button class="zc-msg-menu-item" data-action="reply" type="button">
          <i class="fa-solid fa-reply"></i>
          <span>Responder</span>
        </button>

        <button class="zc-msg-menu-item" data-action="copy" type="button">
          <i class="fa-regular fa-copy"></i>
          <span>Copiar</span>
        </button>

        <button class="zc-msg-menu-item" data-action="react" type="button">
          <i class="fa-regular fa-face-smile"></i>
          <span>Reagir</span>
        </button>

        <button class="zc-msg-menu-item" data-action="forward" type="button">
          <i class="fa-solid fa-share"></i>
          <span>Encaminhar</span>
        </button>

        <button class="zc-msg-menu-item" data-action="pin" type="button">
          <i class="fa-solid fa-thumbtack"></i>
          <span>Fixar</span>
        </button>

        <button class="zc-msg-menu-item" data-action="favorite" type="button">
          <i class="fa-regular fa-star"></i>
          <span>Favoritar</span>
        </button>

        <div class="zc-msg-menu-sep"></div>

        <button class="zc-msg-menu-item" data-action="report" type="button">
          <i class="fa-regular fa-flag"></i>
          <span>Denunciar</span>
        </button>

        <button class="zc-msg-menu-item is-danger" data-action="delete" type="button">
          <i class="fa-regular fa-trash-can"></i>
          <span>Apagar</span>
        </button>
      `;

      document.body.appendChild(menuEl);

      menuEl.addEventListener('click', async (ev) => {
        const item = ev.target.closest('.zc-msg-menu-item');
        if (!item || !activeBubble) return;

        ev.preventDefault();
        ev.stopPropagation();

        const action = item.dataset.action;
        const meta = getMessageMeta(activeBubble);

        if (action === 'react') {
          closeMenu(false);
          openReactions(activeBubble, activeShell);
          return;
        }

        closeAllPopups();
        await runAction(action, meta);
      });
    }

    if (!reactEl) {
      reactEl = document.createElement('div');
      reactEl.className = 'zc-msg-react-pop';

      reactEl.innerHTML = `
        ${REACTIONS.map((emoji) => `
          <button class="zc-msg-react-btn" data-emoji="${emoji}" type="button">${emoji}</button>
        `).join('')}

        <button class="zc-msg-react-btn zc-msg-react-more" data-emoji="+" type="button">
          <i class="fa-solid fa-plus"></i>
        </button>
      `;

      document.body.appendChild(reactEl);

      reactEl.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.zc-msg-react-btn');
        if (!btn || !activeBubble) return;

        ev.preventDefault();
        ev.stopPropagation();

        const emoji = btn.dataset.emoji;
        const meta = getMessageMeta(activeBubble);

        if (emoji === '+') {
          dispatchMessageAction('react_more', meta, { emoji: null });
          closeAllPopups();
          createToast('Seletor completo de reação depois.');
          return;
        }

        applyLocalReaction(activeBubble, emoji);
        dispatchMessageAction('react', meta, { emoji });
        closeAllPopups();
      });
    }
  }

  function showPopupForMeasure(popup) {
    if (!popup) return;
    popup.style.visibility = 'hidden';
    popup.classList.add('show');
  }

  function finishPopupPosition(popup, left, top) {
    if (!popup) return;
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
    popup.style.visibility = '';
  }

  function getBubbleRect(bubble) {
    return bubble.getBoundingClientRect();
  }

  function getDirection(bubble) {
    if (!bubble) return 'in';

    const row = bubble.closest('.msg-row, .linha-mensagem');

    if (
      bubble.classList.contains('bubble-out') ||
      bubble.classList.contains('bolha-out') ||
      bubble.closest('.bubble-out') ||
      bubble.closest('.linha-out') ||
      row?.classList?.contains('msg-sent') ||
      row?.classList?.contains('direita')
    ) {
      return 'out';
    }

    return 'in';
  }

  function positionMenuPopup(popup, bubble) {
    if (!popup || !bubble) return;

    showPopupForMeasure(popup);

    const bubbleRect = getBubbleRect(bubble);
    const popRect = popup.getBoundingClientRect();
    const dir = getDirection(bubble);

    let top = bubbleRect.bottom + 8;
    let left = dir === 'out'
      ? bubbleRect.right - popRect.width
      : bubbleRect.left;

    if (left < 12) left = 12;

    if (left + popRect.width > window.innerWidth - 12) {
      left = window.innerWidth - popRect.width - 12;
    }

    if (top + popRect.height > window.innerHeight - 12) {
      top = bubbleRect.top - popRect.height - 8;
    }

    if (top < 12) top = 12;

    finishPopupPosition(popup, left, top);
  }

  function positionReactionPopup(popup, bubble) {
    if (!popup || !bubble) return;

    showPopupForMeasure(popup);

    const bubbleRect = getBubbleRect(bubble);
    const popRect = popup.getBoundingClientRect();
    const dir = getDirection(bubble);

    let top = bubbleRect.top - popRect.height - 8;
    let left = dir === 'out'
      ? bubbleRect.right - popRect.width
      : bubbleRect.left;

    if (left < 12) left = 12;

    if (left + popRect.width > window.innerWidth - 12) {
      left = window.innerWidth - popRect.width - 12;
    }

    if (top < 12) {
      top = bubbleRect.bottom + 8;
    }

    if (top + popRect.height > window.innerHeight - 12) {
      top = Math.max(12, window.innerHeight - popRect.height - 12);
    }

    finishPopupPosition(popup, left, top);
  }

  function openMenu(bubble, shell) {
    ensureGlobals();
    closeAllPopups(false);

    activeBubble = bubble;
    activeShell = shell;

    if (shell) shell.classList.add('zc-msg-actions-open');

    positionMenuPopup(menuEl, bubble);
  }

  function closeMenu(clearActive = true) {
    if (menuEl) {
      menuEl.classList.remove('show');
      menuEl.style.visibility = '';
    }

    if (activeShell) {
      activeShell.classList.remove('zc-msg-actions-open');
    }

    if (clearActive) {
      activeBubble = null;
      activeShell = null;
    }
  }

  function openReactions(bubble, shell) {
    ensureGlobals();
    closeAllPopups(false);

    activeBubble = bubble;
    activeShell = shell;

    if (shell) shell.classList.add('zc-msg-actions-open');

    positionReactionPopup(reactEl, bubble);
  }

  function closeReactions(clearActive = true) {
    if (reactEl) {
      reactEl.classList.remove('show');
      reactEl.style.visibility = '';
    }

    if (activeShell) {
      activeShell.classList.remove('zc-msg-actions-open');
    }

    if (clearActive) {
      activeBubble = null;
      activeShell = null;
    }
  }

  function closeAllPopups(clearActive = true) {
    closeMenu(false);
    closeReactions(false);

    if (activeShell) {
      activeShell.classList.remove('zc-msg-actions-open');
    }

    if (clearActive) {
      activeBubble = null;
      activeShell = null;
    }
  }

  function getMessageId(bubble) {
    const row =
      bubble?.closest('[data-message-id]') ||
      bubble?.closest('[data-msg-id]') ||
      bubble?.closest('[data-id]') ||
      bubble;

    return (
      row?.dataset?.messageId ||
      row?.dataset?.msgId ||
      row?.dataset?.id ||
      bubble?.dataset?.messageId ||
      bubble?.dataset?.msgId ||
      bubble?.dataset?.id ||
      null
    );
  }

  function getMessageText(bubble) {
    if (!bubble) return '[mensagem]';

    const clone = bubble.cloneNode(true);

    $all(
      [
        '.zc-msg-hover-actions',
        '.zc-msg-local-reaction',
        '.zc-quoted-bubble',
        '.msg-time',
        '.time',
        '.tempo-mensagem',
        '.msg-ack',
        '.wa-audio',
        'audio',
        'video',
        'button',
        '.meta',
        '.msg-meta'
      ].join(', '),
      clone
    ).forEach((el) => el.remove());

    let text = (clone.innerText || clone.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) {
      if (bubble.querySelector('img')) text = '[imagem]';
      else if (bubble.querySelector('video')) text = '[vídeo]';
      else if (bubble.querySelector('.wa-audio, audio')) text = '[áudio]';
      else if (bubble.querySelector('.doc-card')) text = '[documento]';
      else text = '[mensagem]';
    }

    return text;
  }

  function normalizeBool(v, fallback = false) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v === 1;

    const s = String(v ?? '').trim().toLowerCase();

    if (['1', 'true', 'sim', 'yes', 'y', 'saida', 'out', 'sent', 'fromme'].includes(s)) {
      return true;
    }

    if (['0', 'false', 'nao', 'não', 'no', 'n', 'entrada', 'in', 'received'].includes(s)) {
      return false;
    }

    return fallback;
  }

  function safeJsonParse(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;

    try {
      return JSON.parse(String(raw));
    } catch {
      return null;
    }
  }

  function pickFirst(...values) {
    for (const v of values) {
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }

    return null;
  }

  function getPath(obj, path) {
    if (!obj || !path) return null;

    const parts = String(path).split('.').filter(Boolean);
    let cur = obj;

    for (const part of parts) {
      if (cur == null) return null;
      cur = cur?.[part];
    }

    return cur == null ? null : cur;
  }

  function getRawMessageObject(bubble, row) {
    const id = getMessageId(bubble);

    const direct = pickFirst(
      bubble?.__zcMessage,
      bubble?.__mensagem,
      bubble?.__message,
      row?.__zcMessage,
      row?.__mensagem,
      row?.__message
    );

    if (direct && typeof direct === 'object') return direct;

    const datasetJson = pickFirst(
      row?.dataset?.rawMessage,
      row?.dataset?.messageRaw,
      row?.dataset?.mensagemRaw,
      row?.dataset?.evoRaw,
      row?.dataset?.evolutionRaw,
      bubble?.dataset?.rawMessage,
      bubble?.dataset?.messageRaw,
      bubble?.dataset?.mensagemRaw,
      bubble?.dataset?.evoRaw,
      bubble?.dataset?.evolutionRaw
    );

    const parsed = safeJsonParse(datasetJson);
    if (parsed) return parsed;

    const maps = [
      window.__ZC_MESSAGES_BY_ID,
      window.__ZC_MSG_BY_ID,
      window.ZC_MESSAGES_BY_ID,
      window.mensagensPorId,
      window.messagesById,
      window.state?.mensagensPorId,
      window.state?.messagesById
    ];

    for (const map of maps) {
      if (!map || !id) continue;

      const found =
        map[id] ||
        map[String(id)] ||
        map[Number(id)];

      if (found) return found;
    }

    const arrays = [
      window.historicoCache,
      window.mensagensCache,
      window.messagesCache,
      window.state?.historico,
      window.state?.mensagens,
      window.state?.messages
    ];

    for (const arr of arrays) {
      if (!Array.isArray(arr) || !id) continue;

      const found = arr.find((m) => {
        const mid = pickFirst(
          m?.id,
          m?.msg_id,
          m?.message_id,
          m?.mensagem_id,
          m?.db_id
        );

        const wid = pickFirst(
          m?.wa_id,
          m?.wa_msg_id,
          m?.evo_msg_id,
          m?.evolution_msg_id,
          m?.messageKeyId,
          m?.message_key_id,
          m?.key?.id
        );

        return String(mid || '') === String(id) || String(wid || '') === String(id);
      });

      if (found) return found;
    }

    return null;
  }

  function normalizeQuotedMessageFromRaw(raw, fallbackText) {
    if (!raw) {
      return {
        conversation: String(fallbackText || '[mensagem]')
      };
    }

    const message = pickFirst(
      raw?.message,
      raw?.message_obj,
      raw?.messageObj,
      raw?.evolution_message,
      raw?.evolutionMessage,
      raw?.raw?.message,
      raw?.data?.message
    );

    if (message && typeof message === 'object') {
      return message;
    }

    const conversation = pickFirst(
      typeof message === 'string' ? message : null,
      getPath(raw, 'message.conversation'),
      getPath(raw, 'message.extendedTextMessage.text'),
      getPath(raw, 'message.imageMessage.caption'),
      getPath(raw, 'message.videoMessage.caption'),
      raw?.texto,
      raw?.text,
      raw?.body,
      fallbackText
    );

    return {
      conversation: String(conversation || '[mensagem]')
    };
  }

  function getQuotedPayload(bubble) {
    if (!bubble) return null;

    const row =
      bubble.closest('.msg-row, .linha-mensagem') ||
      bubble.closest('[data-msg-id], [data-message-id], [data-id]') ||
      bubble;

    const raw = getRawMessageObject(bubble, row);
    const direction = getDirection(bubble);
    const fallbackText = getMessageText(bubble);

    const keyObj = pickFirst(
      raw?.key,
      raw?.message_key,
      raw?.messageKey,
      raw?.evolution_key,
      raw?.evolutionKey,
      raw?.raw?.key,
      raw?.data?.key
    );

    const id = pickFirst(
      row?.dataset?.waId,
      row?.dataset?.waMsgId,
      row?.dataset?.evoMsgId,
      row?.dataset?.evolutionMsgId,
      row?.dataset?.messageKeyId,
      row?.dataset?.keyId,
      row?.dataset?.stanzaId,
      row?.dataset?.msgId,
      row?.dataset?.messageId,
      bubble?.dataset?.waId,
      bubble?.dataset?.waMsgId,
      bubble?.dataset?.evoMsgId,
      bubble?.dataset?.evolutionMsgId,
      bubble?.dataset?.messageKeyId,
      bubble?.dataset?.keyId,
      bubble?.dataset?.stanzaId,
      bubble?.dataset?.msgId,
      bubble?.dataset?.messageId,
      keyObj?.id,
      raw?.wa_id,
      raw?.wa_msg_id,
      raw?.evo_msg_id,
      raw?.evolution_msg_id,
      raw?.messageKeyId,
      raw?.message_key_id,
      raw?.stanzaId,
      raw?.msg_id_evolution,
      raw?.id_evolution,
      raw?.msg_id,
      raw?.id,
      getPath(raw, 'key.id'),
      getPath(raw, 'raw.key.id'),
      getPath(raw, 'data.key.id')
    );

    const remoteJid = pickFirst(
      row?.dataset?.remoteJid,
      row?.dataset?.remotejid,
      row?.dataset?.jid,
      row?.dataset?.chatJid,
      row?.dataset?.participantJid,
      bubble?.dataset?.remoteJid,
      bubble?.dataset?.remotejid,
      bubble?.dataset?.jid,
      bubble?.dataset?.chatJid,
      bubble?.dataset?.participantJid,
      keyObj?.remoteJid,
      raw?.remoteJid,
      raw?.remote_jid,
      raw?.jid,
      raw?.chat_jid,
      raw?.numero_jid,
      raw?.participant_jid,
      raw?.participantJid,
      getPath(raw, 'key.remoteJid'),
      getPath(raw, 'raw.key.remoteJid'),
      getPath(raw, 'data.key.remoteJid')
    );

    const participant = pickFirst(
      row?.dataset?.participant,
      row?.dataset?.participantJid,
      bubble?.dataset?.participant,
      bubble?.dataset?.participantJid,
      keyObj?.participant,
      raw?.participant,
      raw?.participant_jid,
      raw?.participantJid,
      getPath(raw, 'key.participant'),
      getPath(raw, 'raw.key.participant'),
      getPath(raw, 'data.key.participant')
    );

    const fromMeRaw = pickFirst(
      row?.dataset?.fromMe,
      row?.dataset?.fromme,
      bubble?.dataset?.fromMe,
      bubble?.dataset?.fromme,
      keyObj?.fromMe,
      raw?.fromMe,
      raw?.from_me,
      getPath(raw, 'key.fromMe'),
      getPath(raw, 'raw.key.fromMe'),
      getPath(raw, 'data.key.fromMe')
    );

    const fromMe = normalizeBool(fromMeRaw, direction === 'out');

    if (!id) {
      return null;
    }

    const key = {
      id: String(id)
    };

    if (remoteJid) {
      key.remoteJid = String(remoteJid);
    }

    if (fromMeRaw !== null || direction) {
      key.fromMe = Boolean(fromMe);
    }

    if (participant) {
      key.participant = String(participant);
    }

    return {
      key,
      message: normalizeQuotedMessageFromRaw(raw, fallbackText)
    };
  }

  function getMessageMeta(bubble) {
    const row = bubble?.closest('.msg-row, .linha-mensagem') || null;
    const direction = getDirection(bubble);
    const quoted = getQuotedPayload(bubble);
    const msgId = getMessageId(bubble);

    const fallbackQuoted = !quoted && msgId
      ? {
          key: {
            id: String(msgId)
          },
          message: {
            conversation: getMessageText(bubble)
          }
        }
      : quoted;

    return {
      id: msgId,
      msg_id: msgId,
      wa_msg_id: fallbackQuoted?.key?.id || null,
      remote_jid: fallbackQuoted?.key?.remoteJid || null,
      from_me: fallbackQuoted?.key?.fromMe ?? (direction === 'out'),
      quoted: fallbackQuoted,
      text: getMessageText(bubble),
      direction,
      tipo: direction === 'out' ? 'saida' : 'entrada',
      row,
      bubble
    };
  }

  function normalizeQuotedForSend(quoted, fallbackText = '[mensagem]') {
    if (!quoted || !quoted.key || !quoted.key.id) return null;

    const key = {
      id: String(quoted.key.id)
    };

    if (quoted.key.remoteJid) {
      key.remoteJid = String(quoted.key.remoteJid);
    }

    if (quoted.key.fromMe !== undefined && quoted.key.fromMe !== null) {
      key.fromMe = Boolean(quoted.key.fromMe);
    }

    if (quoted.key.participant) {
      key.participant = String(quoted.key.participant);
    }

    let message = quoted.message;

    if (!message || typeof message !== 'object') {
      message = {
        conversation: String(fallbackText || '[mensagem]')
      };
    }

    return { key, message };
  }

  function getCurrentQuotedForSend() {
    const reply = window.__zcReplyMessage || null;
    if (!reply) return null;

    const direct = normalizeQuotedForSend(reply.quoted, reply.text);
    if (direct) return direct;

    const id = pickFirst(
      reply.wa_msg_id,
      reply.msg_id,
      reply.id
    );

    if (!id) return null;

    return {
      key: {
        id: String(id)
      },
      message: {
        conversation: String(reply.text || '[mensagem]')
      }
    };
  }

  function buildQuotedPreviewFromReply(reply, quoted) {
    if (!reply && !quoted) return null;

    const msgId = String(
      reply?.wa_msg_id ||
      reply?.msg_id ||
      quoted?.key?.id ||
      ''
    ).trim();

    const text = normalizeReplyPreviewText(
      reply?.text ||
      quoted?.message?.conversation ||
      quoted?.message?.extendedTextMessage?.text ||
      quoted?.message?.imageMessage?.caption ||
      quoted?.message?.videoMessage?.caption ||
      '[mensagem]'
    );

    const direction = reply?.direction || (quoted?.key?.fromMe ? 'out' : 'in');
    const author = reply?.author || (direction === 'out' ? 'Você' : getCurrentChatName());

    return {
      msg_id: msgId || null,
      text: text || '[mensagem]',
      author: author || 'Contato',
      direction: direction === 'out' ? 'out' : 'in'
    };
  }

  function setPendingQuotedPreview(preview, sentText) {
    if (!preview || !preview.text) return;

    window.__zcPendingQuotedPreview = {
      ...preview,
      sent_text: normalizeReplyPreviewText(sentText || ''),
      created_at: Date.now(),
      expires_at: Date.now() + 20000,
      used: false
    };

    setTimeout(() => decorateQuotedBubbles(), 80);
    setTimeout(() => decorateQuotedBubbles(), 250);
    setTimeout(() => decorateQuotedBubbles(), 700);
    setTimeout(() => decorateQuotedBubbles(), 1300);
    setTimeout(() => decorateQuotedBubbles(), 2500);
  }

  function renderQuotedPreviewHtml(q) {
    if (!q) return '';

    const msgId = escapeHtml(q.msg_id || q.id || '');
    const author = escapeHtml(q.author || (q.direction === 'out' ? 'Você' : 'Contato'));
    const text = escapeHtml(q.text || q.conversation || '[mensagem]');

    return `
      <div class="zc-quoted-bubble" data-quoted-msg-id="${msgId}">
        <div class="zc-quoted-bar" aria-hidden="true"></div>
        <div class="zc-quoted-content">
          <div class="zc-quoted-author">${author}</div>
          <div class="zc-quoted-text">${text}</div>
        </div>
      </div>
    `;
  }

  function getQuotedPreviewFromRaw(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const q =
      raw.quoted_preview ||
      raw.quotedPreview ||
      raw.reply_preview ||
      raw.replyPreview ||
      null;

    if (q && typeof q === 'object') return q;

    const quoted = raw.quoted || raw.contextInfo?.quotedMessage || null;
    if (!quoted) return null;

    const key = quoted.key || {};
    const message = quoted.message || quoted;

    const text =
      message?.conversation ||
      message?.extendedTextMessage?.text ||
      message?.imageMessage?.caption ||
      message?.videoMessage?.caption ||
      raw.quoted_text ||
      raw.quotedText ||
      '[mensagem]';

    return {
      msg_id: key.id || raw.quoted_msg_id || raw.quotedMsgId || null,
      text,
      author: key.fromMe ? 'Você' : 'Contato',
      direction: key.fromMe ? 'out' : 'in'
    };
  }

  function getQuotedPreviewForBubble(bubble) {
    const row = bubble?.closest('.msg-row, .linha-mensagem') || bubble;
    if (!row || !bubble) return null;

    const datasetRaw =
      row.dataset?.quotedPreview ||
      row.dataset?.quotedpreview ||
      bubble.dataset?.quotedPreview ||
      bubble.dataset?.quotedpreview ||
      null;

    const parsed = safeJsonParse(datasetRaw);
    if (parsed && typeof parsed === 'object') return parsed;

    const raw = getRawMessageObject(bubble, row);
    const fromRaw = getQuotedPreviewFromRaw(raw);
    if (fromRaw) return fromRaw;

    return null;
  }

  function insertQuotedPreviewIntoBubble(bubble, q) {
    if (!bubble || !q) return false;
    if (bubble.querySelector(':scope > .zc-quoted-bubble')) return false;

    const html = renderQuotedPreviewHtml(q).trim();
    if (!html) return false;

    bubble.insertAdjacentHTML('afterbegin', html);
    return true;
  }

  function decorateQuotedBubbles(root = document) {
    const hist = root.matches?.(HIST_SELECTOR)
      ? root
      : $(HIST_SELECTOR, root) || $(HIST_SELECTOR);

    if (!hist) return;

    const bubbles = $all('.bubble, .bubble-in, .bubble-out, .bolha-mensagem', hist);

    // 1) aplica previews que vieram do backend/render
    bubbles.forEach((bubble) => {
      if (shouldIgnoreBubble(bubble)) return;
      if (bubble.querySelector(':scope > .zc-quoted-bubble')) return;

      const q = getQuotedPreviewForBubble(bubble);
      if (!q) return;

      insertQuotedPreviewIntoBubble(bubble, q);
    });

    // 2) fallback forte: aplica o preview pendente no último balão verde
    const pending = window.__zcPendingQuotedPreview || null;
    if (!pending || pending.used) return;

    if (Date.now() > Number(pending.expires_at || 0)) {
      window.__zcPendingQuotedPreview = null;
      return;
    }

    const sentText = normalizeReplyPreviewText(pending.sent_text || '');

    const outBubbles = bubbles
      .filter((bubble) => {
        if (shouldIgnoreBubble(bubble)) return false;
        if (bubble.querySelector(':scope > .zc-quoted-bubble')) return false;
        return getDirection(bubble) === 'out';
      })
      .reverse();

    if (!outBubbles.length) return;

    let target = null;

    if (sentText) {
      target = outBubbles.find((bubble) => {
        const bubbleText = normalizeReplyPreviewText(getMessageText(bubble));
        return (
          bubbleText &&
          (
            bubbleText.includes(sentText) ||
            sentText.includes(bubbleText)
          )
        );
      });
    }

    if (!target) {
      target = outBubbles[0];
    }

    if (target) {
      insertQuotedPreviewIntoBubble(target, pending);
      pending.used = true;

      setTimeout(() => {
        window.__zcPendingQuotedPreview = null;
      }, 1500);
    }
  }

  function isSendUrl(input) {
    const url = typeof input === 'string'
      ? input
      : String(input?.url || '');

    return /\/api\/atendimento\/send\/(text|audio|media|sticker)\b/.test(url);
  }

  function isJsonContentType(headers) {
    if (!headers) return true;

    try {
      if (headers instanceof Headers) {
        const ct = headers.get('Content-Type') || headers.get('content-type') || '';
        return !ct || ct.toLowerCase().includes('application/json');
      }

      if (Array.isArray(headers)) {
        const pair = headers.find(([k]) => String(k).toLowerCase() === 'content-type');
        const ct = pair ? String(pair[1] || '') : '';
        return !ct || ct.toLowerCase().includes('application/json');
      }

      const ct = headers['Content-Type'] || headers['content-type'] || '';
      return !ct || String(ct).toLowerCase().includes('application/json');
    } catch {
      return true;
    }
  }

  function installReplyFetchInjector() {
    if (window.__zcReplyFetchInjectorInstalled) return;
    if (typeof window.fetch !== 'function') return;

    window.__zcReplyFetchInjectorInstalled = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = function zcFetchWithReplyQuoted(input, init) {
      try {
        const opts = init ? { ...init } : {};
        const reply = window.__zcReplyMessage || null;

        if (isSendUrl(input) && reply && isJsonContentType(opts.headers)) {
          const quoted = getCurrentQuotedForSend();

          if (quoted?.key?.id) {
            let bodyObj = null;

            if (typeof opts.body === 'string') {
              bodyObj = safeJsonParse(opts.body);
            } else if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
              bodyObj = opts.body;
            }

            if (bodyObj && typeof bodyObj === 'object') {
              if (!bodyObj.quoted) {
                bodyObj.quoted = quoted;
              }

              if (!bodyObj.quoted_preview) {
                const preview = buildQuotedPreviewFromReply(reply, bodyObj.quoted);

                if (preview) {
                  bodyObj.quoted_preview = preview;
                }
              }

              setPendingQuotedPreview(
                bodyObj.quoted_preview,
                bodyObj.text || bodyObj.caption || bodyObj.mensagem || ''
              );

              opts.body = JSON.stringify(bodyObj);

              try {
                console.log('[reply] quoted + preview injetado no envio:', {
                  quoted: bodyObj.quoted,
                  quoted_preview: bodyObj.quoted_preview
                });
              } catch {}
            }
          }
        }

        return originalFetch(input, opts);
      } catch (err) {
        try {
          console.warn('[reply] falha ao injetar quoted:', err);
        } catch {}

        return originalFetch(input, init);
      }
    };
  }

  function dispatchMessageAction(action, meta, extra = {}) {
    const detail = { action, meta, extra };

    try {
      window.dispatchEvent(new CustomEvent('zc:message-action', { detail }));
    } catch {}

    const callbacks = {
      reply: window.zcMessageReply,
      react: window.zcMessageReact,
      react_more: window.zcMessageReactMore,
      forward: window.zcMessageForward,
      pin: window.zcMessagePin,
      favorite: window.zcMessageFavorite,
      report: window.zcMessageReport,
      delete: window.zcMessageDelete
    };

    const fn = callbacks[action];

    if (typeof fn === 'function') {
      try {
        fn(detail);
      } catch (err) {
        console.error(`[message-actions] erro em ${action}`, err);
      }
    }
  }

  function getCurrentChatName() {
    return (
      document.getElementById('chat-title')?.textContent?.trim() ||
      document.querySelector('[data-role="chat-title"]')?.textContent?.trim() ||
      window.state?.clienteSel?.nome ||
      window.state?.clienteSel?.nome_whatsapp ||
      window.clienteSel?.nome ||
      window.clienteSel?.nome_whatsapp ||
      'Contato'
    );
  }

  function getComposerInput() {
    return (
      document.getElementById('mensagem') ||
      document.querySelector('#chat-input') ||
      document.querySelector('[data-chat-input]') ||
      document.querySelector('.wa-composer-input')
    );
  }

  function getComposerFooter() {
    return (
      document.getElementById('chat-footer') ||
      document.querySelector('footer')
    );
  }

  function getComposerBox() {
    return (
      document.querySelector('#chat-footer .wa-composer') ||
      document.querySelector('.wa-composer') ||
      getComposerInput()?.closest('.wa-composer')
    );
  }

  function normalizeReplyPreviewText(text) {
    return String(text || '[mensagem]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
  }

  function createReplyPreview(text, meta = {}) {
    const footer = getComposerFooter();
    const composer = getComposerBox();
    const input = getComposerInput();

    if (!footer || !composer || !input) {
      createToast('Não encontrei o campo de mensagem.', false);
      return;
    }

    let reply = document.getElementById('zcReplyPreview');

    if (!reply) {
      reply = document.createElement('div');
      reply.id = 'zcReplyPreview';
      reply.className = 'zc-reply-preview';

      reply.innerHTML = `
        <div class="zc-reply-line" aria-hidden="true"></div>

        <div class="zc-reply-content">
          <div class="zc-reply-author"></div>
          <div class="zc-reply-text"></div>
        </div>

        <button type="button" class="zc-reply-close" aria-label="Cancelar resposta" title="Cancelar resposta">
          <i class="fa-solid fa-xmark"></i>
        </button>
      `;

      footer.insertBefore(reply, composer);

      reply.querySelector('.zc-reply-close')?.addEventListener('click', () => {
        clearReplyPreview(true);
      });
    }

    const isOut =
      meta?.direction === 'out' ||
      meta?.tipo === 'saida' ||
      meta?.row?.classList?.contains('msg-sent') ||
      meta?.bubble?.classList?.contains('bubble-out');

    const author = isOut ? 'Você' : getCurrentChatName();
    const preview = normalizeReplyPreviewText(text || meta?.text || '[mensagem]');

    const quoted = normalizeQuotedForSend(
      meta?.quoted ||
      (
        meta?.wa_msg_id || meta?.msg_id || meta?.id
          ? {
              key: {
                id: String(meta?.wa_msg_id || meta?.msg_id || meta?.id)
              },
              message: {
                conversation: preview
              }
            }
          : null
      ),
      preview
    );

    window.__zcReplyMessage = {
      msg_id: meta?.msg_id || meta?.id || quoted?.key?.id || null,
      wa_msg_id: meta?.wa_msg_id || quoted?.key?.id || null,
      remote_jid: meta?.remote_jid || quoted?.key?.remoteJid || null,
      from_me: meta?.from_me ?? quoted?.key?.fromMe ?? isOut,
      quoted,
      text: preview,
      author,
      direction: isOut ? 'out' : 'in',
      ts: Date.now()
    };

    try {
      window.dispatchEvent(new CustomEvent('zc:reply-selected', {
        detail: {
          reply: window.__zcReplyMessage,
          meta
        }
      }));
    } catch {}

    reply.querySelector('.zc-reply-author').textContent = author;
    reply.querySelector('.zc-reply-text').textContent = preview || '[mensagem]';

    reply.classList.add('is-visible');
    footer.classList.add('has-reply-preview');

    try {
      input.focus({ preventScroll: true });
    } catch {
      try { input.focus(); } catch {}
    }
  }

  function clearReplyPreview(focusInput = false) {
    window.__zcReplyMessage = null;

    const reply = document.getElementById('zcReplyPreview');
    const footer = getComposerFooter();
    const input = getComposerInput();

    if (footer) footer.classList.remove('has-reply-preview');

    if (!reply) {
      if (focusInput && input) {
        try { input.focus({ preventScroll: true }); } catch { input.focus(); }
      }
      return;
    }

    reply.classList.remove('is-visible');

    setTimeout(() => {
      if (!window.__zcReplyMessage) {
        try { reply.remove(); } catch {}
      }
    }, 140);

    if (focusInput && input) {
      try {
        input.focus({ preventScroll: true });
      } catch {
        try { input.focus(); } catch {}
      }
    }
  }

  window.zcClearReplyPreview = clearReplyPreview;
  window.zcOpenReplyPreview = createReplyPreview;
  window.zcGetReplyQuotedPayload = getCurrentQuotedForSend;
  window.zcGetCurrentReplyMessage = () => window.__zcReplyMessage || null;

  function scheduleClearReplyAfterSend() {
    if (!window.__zcReplyMessage) return;

    setTimeout(() => {
      const input = getComposerInput();

      if (!input || !String(input.value || '').trim()) {
        clearReplyPreview(false);
      }
    }, 350);

    setTimeout(() => {
      const input = getComposerInput();

      if (!input || !String(input.value || '').trim()) {
        clearReplyPreview(false);
      }
    }, 900);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text || '');
      createToast('Mensagem copiada.');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text || '';
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        createToast('Mensagem copiada.');
      } catch {
        createToast('Não foi possível copiar.', false);
      }
    }
  }

  function applyLocalReaction(bubble, emoji) {
    if (!bubble) return;

    let chip = bubble.querySelector('.zc-msg-local-reaction');

    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'zc-msg-local-reaction';
      bubble.appendChild(chip);
    }

    chip.textContent = emoji;
  }

  async function runAction(action, meta) {
    switch (action) {
      case 'reply':
        dispatchMessageAction('reply', meta);
        createReplyPreview(meta.text, meta);
        break;

      case 'copy':
        await copyText(meta.text);
        break;

      case 'forward':
        dispatchMessageAction('forward', meta);
        createToast('Encaminhar pronto para integrar.');
        break;

      case 'pin':
        dispatchMessageAction('pin', meta);
        createToast('Mensagem fixada.');
        break;

      case 'favorite':
        dispatchMessageAction('favorite', meta);
        createToast('Mensagem favoritada.');
        break;

      case 'report':
        dispatchMessageAction('report', meta);
        createToast('Denúncia pronta para integrar.');
        break;

      case 'delete':
        dispatchMessageAction('delete', meta);
        createToast('Apagar pronto para integrar.');
        break;

      default:
        dispatchMessageAction(action, meta);
        break;
    }
  }

  function buildHoverActions() {
    const el = document.createElement('div');
    el.className = 'zc-msg-hover-actions';

    el.innerHTML = `
      <button type="button" class="zc-msg-hover-btn zc-msg-hover-react" data-zc-msg-action="react" title="Reagir" aria-label="Reagir">
        <i class="fa-regular fa-face-smile"></i>
      </button>

      <button type="button" class="zc-msg-hover-btn zc-msg-hover-menu" data-zc-msg-action="menu" title="Mais opções" aria-label="Mais opções">
        <i class="fa-solid fa-chevron-down"></i>
      </button>
    `;

    return el;
  }

  function shouldIgnoreBubble(bubble) {
    if (!bubble) return true;
    if (bubble.closest('.zc-msg-menu')) return true;
    if (bubble.closest('.zc-msg-react-pop')) return true;
    if (bubble.closest('#zcReplyPreview')) return true;
    if (bubble.closest('.zc-media-viewer')) return true;
    if (bubble.closest('.hist-loader')) return true;
    if (bubble.closest('.zc-day-divider')) return true;
    return false;
  }

  function enhanceBubble(bubble) {
    if (shouldIgnoreBubble(bubble)) return;

    if (bubble.dataset.zcMsgActionsReady === '1') {
      const currentShell = bubble.closest('.zc-msg-action-shell');

      if (currentShell && !currentShell.querySelector(':scope > .zc-msg-hover-actions')) {
        currentShell.appendChild(buildHoverActions());
      }

      return;
    }

    bubble.dataset.zcMsgActionsReady = '1';
    bubble.classList.add('zc-msg-has-actions');

    let shell = bubble.closest('.zc-msg-action-shell');

    if (!shell) {
      shell = document.createElement('span');
      shell.className = 'zc-msg-action-shell';

      const parent = bubble.parentNode;

      if (!parent) return;

      parent.insertBefore(shell, bubble);
      shell.appendChild(bubble);
    }

    if (!shell.querySelector(':scope > .zc-msg-hover-actions')) {
      shell.appendChild(buildHoverActions());
    }
  }

  function enhanceAll() {
    const hist = $(HIST_SELECTOR);
    if (!hist) return;

    const selectors = [
      '.msg-row .bubble',
      '.msg-row .bubble-in',
      '.msg-row .bubble-out',
      '.linha-mensagem .bubble',
      '.linha-mensagem .bubble-in',
      '.linha-mensagem .bubble-out'
    ].join(', ');

    $all(selectors, hist).forEach(enhanceBubble);
    decorateQuotedBubbles(hist);
  }

  function scrollToQuotedMessage(msgId) {
    const id = String(msgId || '').trim();
    if (!id) return false;

    const hist = $(HIST_SELECTOR);
    if (!hist) return false;

    const esc = window.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');

    const selectors = [
      `[data-msg-id="${esc}"]`,
      `[data-message-id="${esc}"]`,
      `[data-id="${esc}"]`,
      `[data-wa-id="${esc}"]`,
      `[data-wa-msg-id="${esc}"]`,
      `[data-evo-msg-id="${esc}"]`
    ];

    const target = selectors
      .map((sel) => {
        try { return hist.querySelector(sel); } catch { return null; }
      })
      .find(Boolean);

    if (!target) return false;

    const bubble = target.matches('.bubble, .bubble-in, .bubble-out, .bolha-mensagem')
      ? target
      : target.querySelector('.bubble, .bubble-in, .bubble-out, .bolha-mensagem') || target;

    try {
      bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {
      bubble.scrollIntoView();
    }

    bubble.classList.add('search-hit', 'search-hit-fade');

    setTimeout(() => {
      bubble.classList.remove('search-hit', 'search-hit-fade');
    }, 2300);

    return true;
  }

  function bindHistoryDelegates() {
    const hist = $(HIST_SELECTOR);
    if (!hist || hist.dataset.zcMsgActionsDelegated === '1') return;

    hist.dataset.zcMsgActionsDelegated = '1';

    hist.addEventListener('click', (ev) => {
      const quoted = ev.target.closest('.zc-quoted-bubble');
      if (quoted) {
        const msgId = quoted.dataset.quotedMsgId || '';
        if (msgId) {
          ev.preventDefault();
          ev.stopPropagation();
          scrollToQuotedMessage(msgId);
          return;
        }
      }

      const btn = ev.target.closest('.zc-msg-hover-btn');
      if (!btn) return;

      ev.preventDefault();
      ev.stopPropagation();

      const shell = btn.closest('.zc-msg-action-shell');
      const bubble = shell?.querySelector('.bubble, .bubble-in, .bubble-out');

      if (!shell || !bubble) return;

      const action = btn.dataset.zcMsgAction;

      if (action === 'react') {
        openReactions(bubble, shell);
        return;
      }

      openMenu(bubble, shell);
    });

    hist.addEventListener('contextmenu', (ev) => {
      const bubble = ev.target.closest('.bubble, .bubble-in, .bubble-out');
      if (!bubble || shouldIgnoreBubble(bubble)) return;

      ev.preventDefault();

      const shell = bubble.closest('.zc-msg-action-shell');
      openMenu(bubble, shell);
    });
  }

  function bindGlobalEvents() {
    document.addEventListener('click', (ev) => {
      if (
        ev.target.closest('.zc-msg-menu') ||
        ev.target.closest('.zc-msg-react-pop') ||
        ev.target.closest('.zc-msg-hover-actions') ||
        ev.target.closest('.zc-msg-hover-btn')
      ) {
        return;
      }

      closeAllPopups();
    }, true);

    window.addEventListener('scroll', () => closeAllPopups(), true);
    window.addEventListener('resize', () => closeAllPopups(), true);

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        closeAllPopups();

        if (window.__zcReplyMessage) {
          clearReplyPreview(true);
        }
      }
    });

    document.addEventListener('click', (ev) => {
      const btn = ev.target.closest('#btn-enviar, .wa-action-btn.is-send, [data-send-message]');
      if (!btn) return;

      scheduleClearReplyAfterSend();
    }, true);

    document.addEventListener('keydown', (ev) => {
      const input = ev.target.closest?.('#mensagem, #chat-input, [data-chat-input], .wa-composer-input');
      if (!input) return;

      if (ev.key === 'Enter' && !ev.shiftKey) {
        scheduleClearReplyAfterSend();
      }
    }, true);

    document.addEventListener('cliente:selecionado', () => clearReplyPreview(false));
    document.addEventListener('zc:cliente_sel', () => clearReplyPreview(false));

    document.addEventListener('historico:ready', () => {
      closeAllPopups();
      setTimeout(enhanceAll, 40);
    });
  }

  function setupObserver() {
    const hist = $(HIST_SELECTOR);
    if (!hist || observer) return;

    observer = new MutationObserver(() => {
      window.requestAnimationFrame(enhanceAll);
    });

    observer.observe(hist, {
      childList: true,
      subtree: true
    });
  }

  function init() {
    ensureGlobals();
    installReplyFetchInjector();
    bindHistoryDelegates();
    bindGlobalEvents();
    enhanceAll();
    setupObserver();

    setTimeout(enhanceAll, 150);
    setTimeout(enhanceAll, 500);
    setTimeout(enhanceAll, 1200);

    if (!isDesktopHover()) {
      document.documentElement.classList.add('zc-no-desktop-hover');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();