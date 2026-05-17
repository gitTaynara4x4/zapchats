// /frontend/js/atendimentos/ui/header-actions/select-mode.js
// Modo de seleção de mensagens
// - Barra superior de seleção
// - Marcação visual das mensagens
// - Seleção/deseleção de mensagens
// - Coleta dos itens selecionados para encaminhar

(function () {
  'use strict';

  const H = window.ZCHeaderActions;

  if (!H || !H.__coreReady) {
    console.warn('[header-actions][select-mode] core.js precisa ser carregado antes.');
    return;
  }

  if (H.__selectModeReady) return;
  H.__selectModeReady = true;

  const REQUIRED = [
    '$',
    '$all',
    'historyEl',
    'headerEl',
    'toast',
    'hasOpenChat',
    'nameFromUrl',
    'guessMimeFromExt',
  ];

  if (!H.require(REQUIRED, 'select-mode')) {
    return;
  }

  const {
    $,
    $all,
    historyEl,
    headerEl,
    toast,
    hasOpenChat,
    nameFromUrl,
    guessMimeFromExt,
  } = H;

  function closeMenuSafe() {
    if (typeof H.closeMenu === 'function') {
      H.closeMenu();
    }
  }

  function closeSearchDrawerSafe() {
    if (typeof H.closeSearchDrawer === 'function') {
      H.closeSearchDrawer();
    }
  }

  function closeForwardDrawerSafe() {
    if (typeof H.closeForwardDrawer === 'function') {
      H.closeForwardDrawer();
    }
  }

  function openForwardDrawerSafe() {
    if (typeof H.openForwardDrawer === 'function') {
      H.openForwardDrawer();
      return;
    }

    toast({
      title: 'Encaminhar indisponível',
      msg: 'O módulo de encaminhamento ainda não foi carregado.',
      type: 'error',
    });
  }

  function ensureSelectBar() {
    if (document.getElementById('zc-selectbar')) return;

    const hdr = headerEl();

    if (!hdr) return;

    const bar = document.createElement('div');
    bar.id = 'zc-selectbar';
    bar.className = 'zc-selectbar';
    bar.hidden = true;

    bar.innerHTML = `
      <div class="zc-selectbar-left">
        <button
          type="button"
          class="zc-selectbar-btn"
          id="zc-selectbar-close"
          aria-label="Cancelar seleção"
          title="Cancelar seleção"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>

        <div class="zc-selectbar-count">
          <strong id="zc-selectbar-count-num">0</strong>
          <span id="zc-selectbar-count-text">mensagens selecionadas</span>
        </div>
      </div>

      <div class="zc-selectbar-actions">
        <button
          type="button"
          class="zc-selectbar-btn"
          id="zc-selectbar-forward"
          aria-label="Encaminhar"
          title="Encaminhar"
          disabled
        >
          <i class="fa-solid fa-share"></i>
        </button>
      </div>
    `;

    hdr.appendChild(bar);

    $('#zc-selectbar-close', bar)?.addEventListener('click', stopSelectionMode);

    $('#zc-selectbar-forward', bar)?.addEventListener('click', () => {
      if (!H.state.selectedMsgIds.size) {
        toast({
          title: 'Selecione pelo menos uma mensagem',
          type: 'error',
        });
        return;
      }

      openForwardDrawerSafe();
    });
  }

  function getSelectableRows() {
    const hist = historyEl();

    if (!hist) return [];

    return $all('.msg-row', hist).filter((row) => {
      if (row.getAttribute('data-cluster-hidden') === '1') return false;
      if (!row.querySelector('.bubble')) return false;
      if (!row.offsetParent) return false;

      return true;
    });
  }

  function ensureRowChecks() {
    getSelectableRows().forEach((row) => {
      if (row.querySelector('.zc-msg-check')) return;

      const check = document.createElement('span');
      check.className = 'zc-msg-check';
      check.innerHTML = `<i class="fa-solid fa-check"></i>`;

      row.appendChild(check);
    });
  }

  function rowMsgId(row) {
    if (!row) return '';

    return (
      row.getAttribute('data-msg-id') ||
      row.querySelector('.bubble')?.getAttribute('data-msg-id') ||
      row.getAttribute('data-id') ||
      ''
    );
  }

  function syncSelectBar() {
    const bar = $('#zc-selectbar');
    const num = $('#zc-selectbar-count-num');
    const txt = $('#zc-selectbar-count-text');
    const fwd = $('#zc-selectbar-forward');
    const hist = historyEl();

    const count = H.state.selectedMsgIds.size;

    if (bar) {
      bar.hidden = !H.state.selectMode;
      bar.classList.toggle('is-open', !!H.state.selectMode);
    }

    if (hist) {
      hist.classList.toggle('zc-select-mode', !!H.state.selectMode);
    }

    if (num) {
      num.textContent = String(count);
    }

    if (txt) {
      txt.textContent = count === 1
        ? 'mensagem selecionada'
        : 'mensagens selecionadas';
    }

    if (fwd) {
      fwd.disabled = !count || H.state.forwarding;
    }
  }

  function toggleRowSelection(row, force = null) {
    const msgId = rowMsgId(row);

    if (!msgId) return;

    const shouldSelect = force == null
      ? !H.state.selectedMsgIds.has(msgId)
      : !!force;

    if (shouldSelect) {
      H.state.selectedMsgIds.add(msgId);
      row.classList.add('is-selected');
    } else {
      H.state.selectedMsgIds.delete(msgId);
      row.classList.remove('is-selected');
    }

    syncSelectBar();
  }

  function clearSelections() {
    H.state.selectedMsgIds.clear();

    getSelectableRows().forEach((row) => {
      row.classList.remove('is-selected');
    });

    syncSelectBar();
  }

  function startSelectionMode() {
    if (!hasOpenChat()) {
      toast({
        title: 'Selecione uma conversa',
        type: 'error',
      });
      return;
    }

    ensureSelectBar();
    ensureRowChecks();

    closeMenuSafe();
    closeSearchDrawerSafe();
    closeForwardDrawerSafe();

    H.state.selectMode = true;

    clearSelections();
    syncSelectBar();
  }

  function stopSelectionMode() {
    H.state.selectMode = false;

    clearSelections();
    closeForwardDrawerSafe();
    syncSelectBar();
  }

  function bindSelectModeHistory() {
    const hist = historyEl();

    if (!hist || hist.__zcSelectBound) return;

    hist.__zcSelectBound = true;

    hist.addEventListener(
      'click',
      (e) => {
        if (!H.state.selectMode) return;

        const row = e.target.closest('.msg-row');

        if (!row || row.getAttribute('data-cluster-hidden') === '1') {
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        toggleRowSelection(row);
      },
      true
    );
  }

  function getSelectedRowsInVisualOrder() {
    const ids = H.state.selectedMsgIds;

    return getSelectableRows().filter((row) => {
      return ids.has(rowMsgId(row));
    });
  }

  function getBubbleForwardText(bubble) {
    const txt = bubble?.querySelector('.msg-text')?.textContent || '';

    const clean = String(txt)
      .replace(/\u00A0/g, ' ')
      .trim();

    if (!clean) return '';

    if (/^\[[^\]]+\]$/i.test(clean)) {
      return '';
    }

    return clean;
  }

  function dedupeByUrl(items) {
    const out = [];
    const seen = new Set();

    for (const item of items || []) {
      const key = `${item.type || ''}|${item.url || ''}|${item.fileName || ''}`;

      if (!item.url || seen.has(key)) continue;

      seen.add(key);
      out.push(item);
    }

    return out;
  }

  function extractForwardItemsFromRow(row) {
    const bubble = row?.querySelector('.bubble');

    if (!bubble) return [];

    const caption = getBubbleForwardText(bubble);
    const out = [];

    const imageAnchors = $all(
      '[data-media-view="1"][data-media-kind="image"]',
      bubble
    );

    imageAnchors.forEach((a, idx) => {
      const url =
        a.getAttribute('data-media-src') ||
        a.getAttribute('href') ||
        '';

      const fileName =
        a.getAttribute('data-media-name') ||
        nameFromUrl(url) ||
        `imagem-${idx + 1}.jpg`;

      out.push({
        type: 'media',
        mediaType: 'image',
        url,
        fileName,
        mimeType: guessMimeFromExt(fileName),
        caption: idx === 0 ? caption : undefined,
      });
    });

    const videos = $all('.msg-media-video', bubble);

    videos.forEach((v, idx) => {
      const url =
        v.currentSrc ||
        v.getAttribute('src') ||
        '';

      const fileName =
        nameFromUrl(url) ||
        `video-${idx + 1}.mp4`;

      out.push({
        type: 'media',
        mediaType: 'video',
        url,
        fileName,
        mimeType:
          v.getAttribute('type') ||
          guessMimeFromExt(fileName) ||
          'video/mp4',
        caption: !out.length && idx === 0 ? caption : undefined,
      });
    });

    const audios = $all('.wa-audio', bubble);

    audios.forEach((a, idx) => {
      const srcs = String(a.getAttribute('data-src') || '')
        .split('|')
        .filter(Boolean);

      const url = srcs[0] || '';

      const fileName =
        nameFromUrl(url) ||
        `audio-${idx + 1}.ogg`;

      out.push({
        type: 'media',
        mediaType: 'audio',
        url,
        fileName,
        mimeType:
          guessMimeFromExt(fileName) ||
          'audio/ogg',
      });
    });

    const docs = $all('.doc-card .doc-name', bubble);

    docs.forEach((a, idx) => {
      const url = a.getAttribute('href') || '';

      const fileName =
        a.getAttribute('download') ||
        a.getAttribute('title') ||
        a.textContent?.trim() ||
        nameFromUrl(url) ||
        `arquivo-${idx + 1}`;

      out.push({
        type: 'media',
        mediaType: 'document',
        url,
        fileName,
        mimeType: guessMimeFromExt(fileName),
        caption: !out.length && idx === 0 ? caption : undefined,
      });
    });

    const stickers = $all('.msg-sticker', bubble);

    stickers.forEach((img, idx) => {
      const url = img.getAttribute('src') || '';

      const fileName =
        nameFromUrl(url) ||
        `figurinha-${idx + 1}.webp`;

      out.push({
        type: 'media',
        mediaType: 'image',
        url,
        fileName,
        mimeType:
          img.getAttribute('type') ||
          guessMimeFromExt(fileName) ||
          'image/webp',
      });
    });

    const items = dedupeByUrl(out);

    if (items.length) {
      return items;
    }

    if (caption) {
      return [
        {
          type: 'text',
          text: caption,
        },
      ];
    }

    return [];
  }

  function collectForwardItemsFromSelection() {
    const rows = getSelectedRowsInVisualOrder();
    const items = [];

    rows.forEach((row) => {
      items.push(...extractForwardItemsFromRow(row));
    });

    return items;
  }

  H.extend({
    ensureSelectBar,
    getSelectableRows,
    ensureRowChecks,
    rowMsgId,
    syncSelectBar,
    toggleRowSelection,
    clearSelections,
    startSelectionMode,
    stopSelectionMode,
    bindSelectModeHistory,

    getSelectedRowsInVisualOrder,
    getBubbleForwardText,
    dedupeByUrl,
    extractForwardItemsFromRow,
    collectForwardItemsFromSelection,
  });

  console.log('[header-actions] select-mode carregado');
})();