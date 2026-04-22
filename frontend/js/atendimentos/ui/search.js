// /frontend/js/atendimentos/ui/search.js
// Busca global (contatos + mensagens) e "procurar no chat aberto"
// ✅ sem CSS inline
// ✅ usa /frontend/css/atendimentos/search.css

(function () {
  if (window.__ATD_SEARCH_INIT__) return;
  window.__ATD_SEARCH_INIT__ = true;

  const hist = document.getElementById('historico');
  const searchInput = document.getElementById('wpp-header-search');
  const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);

  if (!searchInput) return;

  function _normalize(s) {
    return (s || '')
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[ch]));
  }

  function formatarNumeroBR(numero) {
    function onlyDigits(s) { return String(s || '').replace(/\D/g, ''); }
    if (!numero) return '';
    let n = onlyDigits(numero);
    if (!n.startsWith('55')) n = '55' + n;
    n = n.slice(0, 14);

    const ddd = n.slice(2, 4);
    const resto = n.slice(4);

    if (resto.length === 9 && resto[0] === '9') {
      return `+55 ${ddd} ${resto.slice(0, 5)}-${resto.slice(5)}`;
    }
    if (resto.length === 8) {
      return `+55 ${ddd} ${resto.slice(0, 4)}-${resto.slice(4)}`;
    }
    return `+55 ${ddd} ${resto}`;
  }

  const MARKER_RE = /^\[(Imagem|Vídeo|Video|Áudio\/ptt|Áudio|Audio|Documento|Figurinha|Localização|Contatos?|M[íi]dia)\](?:\s.*)?$/i;

  function ensureResultsPanel() {
    let panel = document.getElementById('search-results');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'search-results';
    panel.className = 'sr-container hidden';

    const anchor =
      searchInput.closest('.wpp-header-search-row') ||
      searchInput.parentElement ||
      document.body;

    anchor.insertAdjacentElement('afterend', panel);
    return panel;
  }

  let resultsEl = ensureResultsPanel();

  function srShowLoading() {
    resultsEl.classList.remove('hidden');
    resultsEl.innerHTML = `
      <div class="sr-loading">
        <span class="sr-spinner" aria-hidden="true"></span>
        <span class="sr-loading-text">Procurando…</span>
      </div>
    `;
  }

  function srHide() {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
  }

  function srRender(html) {
    resultsEl.innerHTML = html || '';
    resultsEl.classList.toggle('hidden', !html);
  }

  let _searchActive = false;
  let _searchAbort = null;

  async function serverSearch(q, limit = 50) {
    if (!q || !q.trim()) return { contatos: [], mensagens: [] };

    if (_searchAbort) {
      try { _searchAbort.abort(); } catch {}
    }
    _searchAbort = new AbortController();

    const instQuery = (typeof window._instQuery === 'function') ? window._instQuery() : '';
    const url = `/api/atendimento/search?empresa_id=${EMPRESA_ID}&q=${encodeURIComponent(q)}&limit=${limit}${instQuery}`;

    const res = await fetch(url, {
      signal: _searchAbort.signal,
      credentials: 'include',
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`[search] HTTP ${res.status} ${txt?.slice(0, 150)}`);
    }

    const data = await res.json();
    return {
      contatos: Array.isArray(data.contatos) ? data.contatos : [],
      mensagens: Array.isArray(data.mensagens) ? data.mensagens : [],
    };
  }

  function renderSearchPanel({ q, contatos, mensagens }) {
    const query = (q || '').trim();
    let html = '';

    if (mensagens?.length) {
      html += `
        <div class="sr-group">
          <div class="sr-title"><i class="fa fa-message"></i> Mensagens</div>
          <ul class="sr-list">
            ${mensagens.slice(0, 80).map((m) => {
              const cache = (window.todosContatosCache || window.clientesCache || [])
                .find((x) => Number(x.id) === Number(m.cliente_id)) || {};

              const telRaw = String(m.cliente_telefone || cache.telefone || '').trim();
              const telBR = telRaw ? formatarNumeroBR(telRaw) : '';

              const rawNome =
                String(m.cliente_nome || '').trim() ||
                String(cache.push_name || '').trim() ||
                String(cache.nome || '').trim();

              const displayNome = rawNome || telBR;
              const nomeHtml =
                escapeHtml(displayNome || '') +
                (rawNome && telBR ? `<span> · ${escapeHtml(telBR)}</span>` : '');

              const when = (window.formatChatTime || (() => ''))(m.hora || '') || '';
              const snipRaw = m.snippet || '';
              const snip = MARKER_RE.test(snipRaw) ? '' : escapeHtml(snipRaw).slice(0, 220);

              return `
                <li class="sr-item sr-msg" data-id="${m.cliente_id}" data-q="${encodeURIComponent(query)}" tabindex="0">
                  <div class="sr-bullet"></div>
                  <div class="sr-text">
                    <div class="sr-name">${nomeHtml}</div>
                    <div class="sr-msgline">${snip ? '… ' + snip : ''}</div>
                  </div>
                  <div class="sr-meta">${when}</div>
                </li>
              `;
            }).join('')}
          </ul>
        </div>
      `;
    }

    if (contatos?.length) {
      html += `
        <div class="sr-group">
          <div class="sr-title"><i class="fa fa-user"></i> Contatos</div>
          <ul class="sr-list">
            ${contatos.slice(0, 80).map((c) => {
              const nome = c.push_name?.trim() || c.nome || formatarNumeroBR(c.telefone || '');
              const av = c.avatar_url
                ? `
                  <span class="sr-avatar">
                    <img
                      src="${c.avatar_url}"
                      alt=""
                      onerror="this.onerror=null;this.parentElement.classList.add('avatar-default');this.remove();"
                    >
                  </span>
                `
                : `
                  <span class="sr-avatar avatar-default">
                    <i class="fa fa-user-circle" style="font-size:28px;"></i>
                  </span>
                `;

              const lastRaw = c.ultima_mensagem || '';
              const lastClean = MARKER_RE.test(lastRaw) ? '' : lastRaw;
              const preview = (lastClean && lastClean.trim()) ? lastClean.trim() : '[mídia]';

              return `
                <li class="sr-item" data-id="${c.id}" data-q="${encodeURIComponent(query)}" tabindex="0">
                  ${av}
                  <div class="sr-text">
                    <div class="sr-name">${escapeHtml(nome || '')}</div>
                    <div class="sr-last">${escapeHtml(preview || '')}</div>
                  </div>
                  <div class="sr-meta">${(window.formatChatTime || (() => ''))(c.hora || c.last_ts) || ''}</div>
                </li>
              `;
            }).join('')}
          </ul>
        </div>
      `;
    }

    if (!html) {
      html = `<div class="sr-empty">Nenhum resultado</div>`;
    }

    srRender(html);

    resultsEl.querySelectorAll('.sr-item').forEach((li) => {
      const openItem = async () => {
        const id = Number(li.dataset.id);
        const q2 = decodeURIComponent(li.dataset.q || query);

        await window.selecionarClienteObj?.(id);

        if (q2) {
          _findInRendered._lastIndex = 0;
          if (!_findInRendered(q2)) {
            await _loadMoreHistoryUntilMatch(q2);
          }
        }
      };

      li.addEventListener('click', openItem);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openItem();
        }
      });
    });
  }

  function _allRenderedMsgNodes() {
    return Array.from((hist?.querySelectorAll('.bubble')) || []);
  }

  function _findInRendered(query, from = 0) {
    const q = _normalize(query);
    if (!q) return false;

    const nodes = _allRenderedMsgNodes();
    for (let i = Math.max(0, from); i < nodes.length; i++) {
      if (_normalize(nodes[i].textContent).includes(q)) {
        _focusHit(nodes[i]);
        _findInRendered._lastIndex = i;
        return true;
      }
    }
    return false;
  }
  _findInRendered._lastIndex = 0;

  function _focusHit(el) {
    if (!el || !hist) return;

    hist.querySelectorAll('.search-hit').forEach((n) => {
      n.classList.remove('search-hit', 'search-hit-fade');
    });

    const bubble = el.closest('.bubble') || el;
    bubble.classList.add('search-hit');
    bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });

    setTimeout(() => bubble.classList.add('search-hit-fade'), 400);
    setTimeout(() => bubble.classList.remove('search-hit', 'search-hit-fade'), 2400);
  }

  async function _loadMoreHistoryUntilMatch(query, maxPages = 8) {
    if (!window.clienteSel) return false;
    const id = window.clienteSel.id;

    for (let p = 0; p < maxPages; p++) {
      const ok = await window.carregarMaisHistorico?.(id);
      if (!ok) return false;
      if (_findInRendered(query)) return true;
    }
    return false;
  }

  function localSearchGlobal(q) {
    const query = _normalize(q);

    const contatos = (window.todosContatosCache || [])
      .filter((c) => {
        const nome = _normalize(c.nome || c.push_name || '');
        const tel = _normalize(c.telefone || c.celular || c.numero || '');
        const ult = _normalize(c.ultima_mensagem || '');
        return nome.includes(query) || tel.includes(query) || ult.includes(query);
      })
      .slice(0, 80);

    const mensagens = [];
    const ch = window.cacheHistoricos || {};

    Object.entries(ch).forEach(([cid, arr]) => {
      arr?.forEach((m) => {
        if (_normalize(m.conteudo).includes(query)) {
          mensagens.push({
            cliente_id: Number(cid),
            snippet: m.conteudo,
            hora: m.timestamp,
          });
        }
      });
    });

    renderSearchPanel({ q, contatos, mensagens });
  }

  let _deb = null;

  async function onSearchInput() {
    const q = (searchInput?.value || '').trim();

    if (!q) {
      srHide();
      window.renderListaClientes?.(window.clientesCache || []);
      _searchActive = false;
      return;
    }

    srShowLoading();
    clearTimeout(_deb);

    _deb = setTimeout(async () => {
      try {
        const res = await serverSearch(q, 80);

        const ids = new Set(res.contatos.map((c) => String(c.id)));
        (window.todosContatosCache || []).forEach((c) => {
          const nome = _normalize(c.nome || c.push_name || '');
          const tel = _normalize(c.telefone || c.celular || c.numero || '');
          const ult = _normalize(c.ultima_mensagem || '');
          const qn = _normalize(q);

          if (!ids.has(String(c.id)) && (nome.includes(qn) || tel.includes(qn) || ult.includes(qn))) {
            res.contatos.push(c);
          }
        });

        srRender('');
        renderSearchPanel({ q, contatos: res.contatos, mensagens: res.mensagens });
        _searchActive = true;
      } catch (e) {
        console.warn('[search] fallback global local:', e.message || e);
        localSearchGlobal(q);
        _searchActive = true;
      }
    }, 200);
  }

  async function onSearchEnter() {
    const q = (searchInput?.value || '').trim();
    if (!q) return;

    if (window.clienteSel) {
      _findInRendered._lastIndex = 0;
      if (_findInRendered(q)) return;
      await _loadMoreHistoryUntilMatch(q);
      return;
    }

    const qn = _normalize(q);
    const cand = (window.todosContatosCache || []).find((c) => {
      const nome = _normalize(c.nome || c.push_name || '');
      const tel = _normalize(c.telefone || c.celular || c.numero || '');
      const ult = _normalize(c.ultima_mensagem || '');
      return nome.includes(qn) || tel.includes(qn) || ult.includes(qn);
    });

    if (cand) await window.selecionarClienteObj?.(cand.id);
  }

  searchInput.addEventListener('input', onSearchInput);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSearchEnter();
    }

    if (e.key === 'Escape') {
      searchInput.value = '';
      srHide();
      window.renderListaClientes?.(window.clientesCache || []);
      _searchActive = false;
    }
  });

  document.addEventListener('keydown', async (e) => {
    const key = (e.key || '').toLowerCase();

    if (e.key === 'F3' || (key === 'g' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();

      const q = searchInput?.value?.trim();
      if (!q) return;

      if (_findInRendered(q, (_findInRendered._lastIndex ?? -1) + 1)) return;
      await _loadMoreHistoryUntilMatch(q, 1);
    }
  });

  document.addEventListener('click', (e) => {
    const inSearch =
      e.target.closest('#search-results') ||
      e.target.closest('#wpp-header-search') ||
      e.target.closest('.wpp-header-search-row');

    if (!inSearch && _searchActive && !(searchInput?.value || '').trim()) {
      srHide();
    }
  });

  window._findInRendered = _findInRendered;
  window._loadMoreHistoryUntilMatch = _loadMoreHistoryUntilMatch;
})();