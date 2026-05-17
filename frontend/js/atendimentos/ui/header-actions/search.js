// /frontend/js/atendimentos/ui/header-actions/search.js
// Pesquisa lateral dentro da conversa
// - Abre drawer de pesquisa
// - Pesquisa mensagens renderizadas no histórico
// - Tenta carregar histórico antigo se não encontrar
// - Destaca/foca a bolha encontrada

(function () {
  'use strict';

  const H = window.ZCHeaderActions;

  if (!H || !H.__coreReady) {
    console.warn('[header-actions][search] core.js precisa ser carregado antes.');
    return;
  }

  if (H.__searchReady) return;
  H.__searchReady = true;

  const REQUIRED = [
    '$',
    '$all',
    'escapeHtml',
    'normalize',
    'escapeRegExp',
    'historyEl',
    'resolveCurrentClienteId',
  ];

  if (!H.require(REQUIRED, 'search')) {
    return;
  }

  const {
    $,
    $all,
    escapeHtml,
    normalize,
    escapeRegExp,
    historyEl,
    resolveCurrentClienteId,
  } = H;

  function ensureSearchDrawer() {
    if (document.getElementById('zc-chat-search-backdrop')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'zc-chat-search-backdrop';
    backdrop.className = 'zc-chat-search-backdrop';

    const drawer = document.createElement('aside');
    drawer.id = 'zc-chat-search-drawer';
    drawer.className = 'zc-chat-search-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Pesquisar mensagens');

    drawer.innerHTML = `
      <div class="zc-chat-search-drawer-head">
        <button class="zc-chat-search-drawer-close" type="button" aria-label="Fechar">
          <i class="fa-solid fa-arrow-left"></i>
        </button>

        <div class="zc-chat-search-drawer-title">
          Pesquisar mensagens
        </div>
      </div>

      <div class="zc-chat-search-drawer-toolbar">
        <div class="zc-chat-search-drawer-input-wrap">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>

          <input
            id="zc-chat-search-input"
            class="zc-chat-search-input"
            type="text"
            placeholder="Pesquisar nesta conversa"
            autocomplete="off"
            spellcheck="false"
          />

          <button class="zc-chat-search-drawer-clear" type="button" aria-label="Limpar">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>

      <div class="zc-chat-search-drawer-body">
        <div id="zc-chat-search-meta" class="zc-chat-search-meta hidden"></div>

        <div id="zc-chat-search-results" class="zc-chat-search-results">
          <div class="zc-chat-search-empty">
            Digite para pesquisar nesta conversa.
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    const closeBtn = drawer.querySelector('.zc-chat-search-drawer-close');
    const clearBtn = drawer.querySelector('.zc-chat-search-drawer-clear');
    const input = drawer.querySelector('#zc-chat-search-input');

    closeBtn?.addEventListener('click', closeSearchDrawer);

    clearBtn?.addEventListener('click', () => {
      if (!input) return;

      input.value = '';
      renderSearchEmpty('Digite para pesquisar nesta conversa.');
      clearSearchMarks();
      input.focus();
    });

    input?.addEventListener('input', () => {
      clearTimeout(H.state.searchTimer);

      H.state.searchTimer = setTimeout(() => {
        performDrawerSearch();
      }, 180);
    });

    input?.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSearchDrawer();
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();

        const first = $('#zc-chat-search-results .zc-chat-search-result');

        if (first) {
          first.click();
          return;
        }

        await performDrawerSearch({
          forceLoadMore: true,
        });
      }
    });

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        closeSearchDrawer();
      }
    });
  }

  function openSearchDrawer() {
    ensureSearchDrawer();

    const backdrop = document.getElementById('zc-chat-search-backdrop');
    const drawer = document.getElementById('zc-chat-search-drawer');
    const input = document.getElementById('zc-chat-search-input');

    H.state.searchOpen = true;

    backdrop?.classList.add('is-open');
    drawer?.classList.add('is-open');

    setTimeout(() => {
      input?.focus();
      input?.select?.();
    }, 40);
  }

  function closeSearchDrawer() {
    const backdrop = document.getElementById('zc-chat-search-backdrop');
    const drawer = document.getElementById('zc-chat-search-drawer');
    const input = document.getElementById('zc-chat-search-input');

    H.state.searchOpen = false;

    backdrop?.classList.remove('is-open');
    drawer?.classList.remove('is-open');

    if (input) {
      input.value = '';
    }

    renderSearchEmpty('Digite para pesquisar nesta conversa.');
    clearSearchMarks();
  }

  function renderSearchEmpty(text) {
    const results = document.getElementById('zc-chat-search-results');
    const meta = document.getElementById('zc-chat-search-meta');

    if (meta) {
      meta.textContent = '';
      meta.classList.add('hidden');
    }

    if (results) {
      results.innerHTML = `
        <div class="zc-chat-search-empty">
          ${escapeHtml(text || 'Nenhum resultado.')}
        </div>
      `;
    }
  }

  function renderSearchLoading() {
    const results = document.getElementById('zc-chat-search-results');
    const meta = document.getElementById('zc-chat-search-meta');

    if (meta) {
      meta.textContent = '';
      meta.classList.add('hidden');
    }

    if (results) {
      results.innerHTML = `
        <div class="zc-chat-search-loading">
          <span class="zc-chat-search-spinner"></span>
          <span>Procurando…</span>
        </div>
      `;
    }
  }

  function highlightQuery(text, query) {
    const safe = escapeHtml(text || '');
    const q = String(query || '').trim();

    if (!q) return safe;

    const re = new RegExp(`(${escapeRegExp(q)})`, 'ig');

    return safe.replace(re, '<mark>$1</mark>');
  }

  function clearSearchMarks() {
    const hist = historyEl();

    if (!hist) return;

    hist
      .querySelectorAll('.search-hit, .search-hit-fade')
      .forEach((el) => {
        el.classList.remove('search-hit', 'search-hit-fade');
      });

    H.state.results = [];
  }

  function getDateLabelForRowSafe(row) {
    if (typeof H.getDateLabelForRow === 'function') {
      return H.getDateLabelForRow(row);
    }

    let prev = row?.previousElementSibling || null;

    while (prev) {
      if (prev.matches?.('.zc-day-divider')) {
        return prev.textContent.trim();
      }

      if (prev.matches?.('.date-chip')) {
        return prev.textContent.trim();
      }

      prev = prev.previousElementSibling;
    }

    return '';
  }

  function getTimeForRow(row) {
    return (
      row?.querySelector('.msg-time')?.textContent?.trim() ||
      row?.querySelector('.time')?.textContent?.trim() ||
      row?.querySelector('.tempo-mensagem')?.textContent?.trim() ||
      ''
    );
  }

  function getSnippetForRow(row) {
    const bubble = row?.querySelector('.bubble');

    if (!bubble) return '';

    const txt = bubble.querySelector('.msg-text')?.textContent?.trim();

    if (txt) {
      return txt;
    }

    if (
      bubble.querySelector(
        '.msg-media-group, .msg-media-img, .msg-media-video, .wa-audio, .doc-card, .msg-sticker'
      )
    ) {
      return '[mídia]';
    }

    return '';
  }

  function collectRenderedMatches(query) {
    const hist = historyEl();

    if (!hist) return [];

    const q = normalize(query);

    if (!q) return [];

    const out = [];
    const seen = new Set();

    $all('.msg-row', hist).forEach((row) => {
      if (row.getAttribute('data-cluster-hidden') === '1') return;

      const bubble = row.querySelector('.bubble');

      if (!bubble || !bubble.offsetParent) return;

      const snippet = getSnippetForRow(row);

      if (!snippet) return;
      if (!normalize(snippet).includes(q)) return;

      const msgId =
        row.getAttribute('data-msg-id') ||
        bubble.getAttribute('data-msg-id') ||
        row.getAttribute('data-id') ||
        '';

      const key = `${msgId}|${snippet}|${getTimeForRow(row)}`;

      if (seen.has(key)) return;

      seen.add(key);

      out.push({
        msgId,
        snippet,
        time: getTimeForRow(row),
        dateLabel: getDateLabelForRowSafe(row),
        bubbleRef: bubble,
      });
    });

    return out;
  }

  async function tryLoadMoreForQuery(query, maxPages = 8) {
    const cid = resolveCurrentClienteId();

    if (!cid) return false;
    if (typeof window.carregarMaisHistorico !== 'function') return false;

    for (let i = 0; i < maxPages; i++) {
      let ok = false;

      try {
        ok = await window.carregarMaisHistorico(cid);
      } catch {
        ok = false;
      }

      if (!ok) return false;

      const found = collectRenderedMatches(query);

      if (found.length) {
        return true;
      }
    }

    return false;
  }

  function renderSearchResults(query, items) {
    const results = document.getElementById('zc-chat-search-results');
    const meta = document.getElementById('zc-chat-search-meta');

    if (!results) return;

    if (!items.length) {
      renderSearchEmpty('Nenhuma mensagem encontrada.');
      return;
    }

    if (meta) {
      meta.textContent = `${items.length} resultado${items.length > 1 ? 's' : ''}`;
      meta.classList.remove('hidden');
    }

    results.innerHTML = items.map((item, idx) => `
      <button
        type="button"
        class="zc-chat-search-result"
        data-idx="${idx}"
        data-msg-id="${escapeHtml(item.msgId || '')}"
      >
        ${
          item.dateLabel
            ? `<div class="zc-chat-search-result-date">${escapeHtml(item.dateLabel)}</div>`
            : ''
        }

        <div class="zc-chat-search-result-row">
          <div class="zc-chat-search-result-snippet">
            ${highlightQuery(item.snippet || '', query)}
          </div>

          <div class="zc-chat-search-result-time">
            ${escapeHtml(item.time || '')}
          </div>
        </div>
      </button>
    `).join('');

    $all('.zc-chat-search-result', results).forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-idx') || '-1');

        if (!Number.isFinite(idx) || idx < 0 || idx >= items.length) {
          return;
        }

        focusSearchResult(items[idx]);
      });
    });
  }

  function findBubbleByMsgIdSafe(msgId) {
    if (typeof H.findBubbleByMsgId === 'function') {
      return H.findBubbleByMsgId(msgId);
    }

    const id = String(msgId || '').trim();
    const hist = historyEl();

    if (!id || !hist) return null;

    try {
      return hist.querySelector(
        `.msg-row[data-msg-id="${CSS.escape(id)}"] .bubble`
      ) || null;
    } catch {
      return null;
    }
  }

  function pulseBubble(bubble) {
    if (!bubble) return;

    clearSearchMarks();

    bubble.classList.add('search-hit');

    try {
      bubble.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    } catch {
      bubble.scrollIntoView();
    }

    setTimeout(() => {
      bubble.classList.add('search-hit-fade');
    }, 300);

    setTimeout(() => {
      bubble.classList.remove('search-hit', 'search-hit-fade');
    }, 2400);
  }

  function focusSearchResult(item) {
    if (!item) return;

    const bubble =
      findBubbleByMsgIdSafe(item.msgId) ||
      item.bubbleRef ||
      null;

    if (!bubble) return;

    pulseBubble(bubble);
    closeSearchDrawer();
  }

  async function performDrawerSearch(opts = {}) {
    const input = document.getElementById('zc-chat-search-input');
    const q = String(input?.value || '').trim();

    if (!q) {
      renderSearchEmpty('Digite para pesquisar nesta conversa.');
      return;
    }

    renderSearchLoading();

    let items = collectRenderedMatches(q);

    if (
      (!items.length || opts.forceLoadMore) &&
      typeof window.carregarMaisHistorico === 'function'
    ) {
      await tryLoadMoreForQuery(q, 8);
      items = collectRenderedMatches(q);
    }

    H.state.results = items;

    renderSearchResults(q, items);
  }

  H.extend({
    ensureSearchDrawer,
    openSearchDrawer,
    closeSearchDrawer,

    renderSearchEmpty,
    renderSearchLoading,
    highlightQuery,
    clearSearchMarks,

    getTimeForRow,
    getSnippetForRow,
    collectRenderedMatches,
    tryLoadMoreForQuery,
    renderSearchResults,

    pulseBubble,
    focusSearchResult,
    performDrawerSearch,
  });

  console.log('[header-actions] search carregado');
})();