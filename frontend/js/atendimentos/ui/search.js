// /frontend/js/atendimentos/ui/search.js
// Busca global rápida (contatos + mensagens) e "procurar no chat aberto"
// ✅ não fica preso no "Procurando..."
// ✅ busca local instantânea + busca no banco com timeout
// ✅ abre conversa usando conversation_key c:<cliente_id>:<instancia_id>

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

  function onlyDigits(s) {
    return String(s || '').replace(/\D/g, '');
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
    if (!numero) return '';
    let n = onlyDigits(numero);
    if (!n) return '';
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

  function srShowLoading(text = 'Procurando…') {
    resultsEl.classList.remove('hidden');
    resultsEl.innerHTML = `
      <div class="sr-loading">
        <span class="sr-spinner" aria-hidden="true"></span>
        <span class="sr-loading-text">${escapeHtml(text)}</span>
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

  function getConvKey(row) {
    const raw = row?.conversation_key || row?.conversationKey || row?.conv_key || row?.convKey || row?.conversation_id || row?.conversationId || '';
    if (/^[cg]:\d+:[^:]+$/i.test(String(raw))) return String(raw);

    const id = getClienteId(row);
    const inst = getInstanciaId(row);
    return id && inst ? `c:${id}:${inst}` : '';
  }

  function getClienteId(row) {
    if (!row) return '';

    const rawKey = row.conversation_key || row.conversationKey || row.conv_key || row.convKey || row.conversation_id || row.conversationId || '';
    const m = String(rawKey || '').match(/^[cg]:(\d+):([^:]+)$/i);
    if (m) return m[1];

    const rawId = row.cliente_id ?? row.clienteId ?? row.entity_id ?? row.entityId ?? row.id ?? '';
    const m2 = String(rawId || '').match(/^[cg]:(\d+):([^:]+)$/i);
    if (m2) return m2[1];

    return String(rawId || '').replace(/\D/g, '') || '';
  }

  function getInstanciaId(row) {
    if (!row) return '';

    const rawKey = row.conversation_key || row.conversationKey || row.conv_key || row.convKey || row.conversation_id || row.conversationId || row.id || '';
    const m = String(rawKey || '').match(/^[cg]:(\d+):([^:]+)$/i);
    if (m) return m[2];

    return String(
      row.instancia_id ??
      row.instanciaId ??
      row.instance_id ??
      row.instanceId ??
      row.inst_id ??
      row.instId ??
      ''
    ).trim();
  }

  function itemKey(row) {
    return getConvKey(row) || `${getClienteId(row)}:${getInstanciaId(row)}`;
  }

  function poolContatos() {
    const out = [];

    [
      window.todosContatosCache,
      window.clientesCache,
      window.__zcListaConversas,
      window.state?.todosContatosCache,
      window.state?.clientesCache,
    ].forEach((arr) => {
      if (Array.isArray(arr)) out.push(...arr);
    });

    try {
      const byInst = window.state?.convsByInst || {};
      Object.values(byInst).forEach((box) => {
        if (Array.isArray(box?.items)) out.push(...box.items);
      });
    } catch {}

    const seen = new Set();
    return out.filter((x) => {
      if (!x) return false;
      const k = itemKey(x) || JSON.stringify([x.id, x.telefone, x.nome]);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function collectLocalResults(q) {
    const query = _normalize(q);
    const qDigits = onlyDigits(q);

    if (!query && !qDigits) return { contatos: [], mensagens: [] };

    const contatos = poolContatos()
      .filter((c) => {
        const nome = _normalize(c.nome || c.push_name || c.nome_whatsapp || c.nomeWhatsapp || c.name || '');
        const tel = onlyDigits(c.telefone || c.celular || c.numero || c.phone || c.telefone_fmt || '');
        const ult = _normalize(c.ultima_mensagem || c.last_message || c.preview || '');
        const key = _normalize(getConvKey(c));

        return (
          (query && (nome.includes(query) || ult.includes(query) || key.includes(query))) ||
          (qDigits && tel.includes(qDigits))
        );
      })
      .slice(0, 80);

    const mensagens = [];
    const ch = window.cacheHistoricos || {};

    Object.entries(ch).forEach(([cid, arr]) => {
      if (!Array.isArray(arr)) return;

      const keyRaw = String(cid || '');
      const km = keyRaw.match(/^[cg]:(\d+):([^:]+)$/i);
      const keyClienteId = km ? km[1] : keyRaw.replace(/\D/g, '');
      const keyInstanciaId = km ? km[2] : '';
      const keyConv = km ? keyRaw : '';

      arr.forEach((m) => {
        const conteudo = m.conteudo || m.text || m.body || '';
        if (_normalize(conteudo).includes(query) || (qDigits && onlyDigits(conteudo).includes(qDigits))) {
          mensagens.push({
            mensagem_id: m.id || m.mensagem_id || m.db_id || '',
            db_id: m.id || m.mensagem_id || m.db_id || '',
            msg_id: m.msg_id || m.wa_msg_id || m.message_id || '',
            cliente_id: Number(m.cliente_id || keyClienteId) || keyClienteId,
            id: Number(m.cliente_id || keyClienteId) || keyClienteId,
            instancia_id: m.instancia_id || m.instanciaId || keyInstanciaId || window.INSTANCIA_ID || '',
            conversation_key: m.conversation_key || m.conversationKey || keyConv || '',
            snippet: conteudo,
            hora: m.timestamp || m.hora || m.created_at,
          });
        }
      });
    });

    return { contatos, mensagens: mensagens.slice(0, 80) };
  }

  function mergeResults(server, local) {
    const outContatos = [];
    const seenContatos = new Set();

    [...(server?.contatos || []), ...(local?.contatos || [])].forEach((c) => {
      const k = itemKey(c) || String(c.id || c.cliente_id || Math.random());
      if (seenContatos.has(k)) return;
      seenContatos.add(k);
      outContatos.push(c);
    });

    const outMensagens = [];
    const seenMsgs = new Set();

    [...(server?.mensagens || []), ...(local?.mensagens || [])].forEach((m) => {
      const k = `${m.mensagem_id || m.db_id || m.msg_id || ''}:${itemKey(m)}:${m.hora || ''}:${String(m.snippet || '').slice(0, 40)}`;
      if (seenMsgs.has(k)) return;
      seenMsgs.add(k);
      outMensagens.push(m);
    });

    return { contatos: outContatos.slice(0, 80), mensagens: outMensagens.slice(0, 80) };
  }

  let _searchAbort = null;
  let _searchSeq = 0;

  function activeInstQuery() {
    try {
      return (typeof window._instQuery === 'function') ? (window._instQuery() || '') : '';
    } catch {
      return '';
    }
  }

  async function serverSearch(q, limit = 50, timeoutMs = 6500, opts = {}) {
    if (!q || !q.trim()) return { contatos: [], mensagens: [] };

    if (_searchAbort) {
      try { _searchAbort.abort(); } catch {}
    }

    const controller = new AbortController();
    _searchAbort = controller;

    const timer = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, timeoutMs);

    const deep = opts?.deep === true || opts?.deep === 1;
    const instQuery = opts?.useActiveInst ? activeInstQuery() : '';
    const url = `/api/atendimento/search?empresa_id=${EMPRESA_ID}&q=${encodeURIComponent(q)}&limit=${limit}${deep ? '&deep=1' : ''}${instQuery}`;

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`[search] HTTP ${res.status} ${txt?.slice(0, 150)}`);
      }

      const data = await res.json();
      return {
        contatos: Array.isArray(data.contatos) ? data.contatos : [],
        mensagens: Array.isArray(data.mensagens) ? data.mensagens : [],
        deep: !!data.deep,
        modo: data.modo || '',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function serverSearchSmart(q, limit = 50, timeoutMs = 6500, opts = {}) {
    const hasActiveInst = !!activeInstQuery();

    // Primeiro tenta exatamente o WhatsApp/instância que está selecionado na tela.
    // Se não voltar nada, tenta global nas instâncias permitidas.
    if (hasActiveInst) {
      const scoped = await serverSearch(q, limit, timeoutMs, { ...opts, useActiveInst: true });
      if ((scoped.contatos?.length || 0) || (scoped.mensagens?.length || 0)) return scoped;
    }

    return serverSearch(q, limit, timeoutMs, { ...opts, useActiveInst: false });
  }


  let _openSeq = 0;
  let _pendingJump = null;

  function _currentOpenConvKey() {
    return String(
      hist?.dataset?.conversationKey ||
      hist?.dataset?.conversationId ||
      hist?.dataset?.convKey ||
      ''
    ).trim();
  }

  function _lockSearchJumpScroll(ms = 18000) {
    const until = Date.now() + Number(ms || 18000);
    try {
      window.__ZC_SUPPRESS_AUTO_SCROLL_UNTIL = Math.max(Number(window.__ZC_SUPPRESS_AUTO_SCROLL_UNTIL || 0), until);
      window.__ZC_SEARCH_JUMP_ACTIVE_UNTIL = until;
      if (hist) hist.__zcPreserveOldScrollUntil = Math.max(Number(hist.__zcPreserveOldScrollUntil || 0), until);
    } catch {}
  }

  function _isSearchJumpStillActive(seq, convKey = '') {
    if (seq && seq !== _openSeq) return false;
    if (convKey && _currentOpenConvKey() && _currentOpenConvKey() !== convKey) return false;
    return true;
  }

  function _waitConversationOpen(convKey, timeoutMs = 1000) {
    if (!convKey) return Promise.resolve(false);
    if (_currentOpenConvKey() === convKey) return Promise.resolve(true);

    return new Promise((resolve) => {
      let done = false;
      const started = Date.now();

      const finish = (ok) => {
        if (done) return;
        done = true;
        try { window.removeEventListener('zc:conversation-selected', onSelected); } catch {}
        try { clearInterval(timer); } catch {}
        resolve(!!ok);
      };

      const onSelected = (ev) => {
        const key = String(ev?.detail?.conversation_key || ev?.detail?.conversation_id || '').trim();
        if (key === convKey || _currentOpenConvKey() === convKey) finish(true);
      };

      const timer = setInterval(() => {
        if (_currentOpenConvKey() === convKey) return finish(true);
        if (Date.now() - started >= timeoutMs) return finish(false);
      }, 40);

      try { window.addEventListener('zc:conversation-selected', onSelected); } catch {}
    });
  }

  function renderSearchPanel({ q, contatos, mensagens, footerText = '' }) {
    const query = (q || '').trim();
    let html = '';

    if (mensagens?.length) {
      html += `
        <div class="sr-group">
          <div class="sr-title"><i class="fa fa-message"></i> Mensagens</div>
          <ul class="sr-list">
            ${mensagens.slice(0, 80).map((m) => {
              const cache = poolContatos()
                .find((x) => String(getClienteId(x)) === String(getClienteId(m)) && (!getInstanciaId(m) || String(getInstanciaId(x)) === String(getInstanciaId(m)))) || {};

              const id = getClienteId(m) || getClienteId(cache);
              const inst = getInstanciaId(m) || getInstanciaId(cache);
              const convKey = getConvKey(m) || (id && inst ? `c:${id}:${inst}` : '');
              const msgDbId = String(m.mensagem_id || m.db_id || m.message_db_id || '').trim();
              const waMsgId = String(m.msg_id || m.wa_msg_id || m.message_id || '').trim();

              const telRaw = String(m.cliente_telefone || cache.telefone || '').trim();
              const telBR = telRaw ? formatarNumeroBR(telRaw) : '';

              const rawNome =
                String(m.cliente_nome || '').trim() ||
                String(cache.push_name || '').trim() ||
                String(cache.nome_whatsapp || '').trim() ||
                String(cache.nome || '').trim();

              const displayNome = rawNome || telBR || `Contato ${id}`;
              const nomeHtml =
                escapeHtml(displayNome || '') +
                (rawNome && telBR ? `<span> · ${escapeHtml(telBR)}</span>` : '');

              const when = (window.formatChatTime || (() => ''))(m.hora || '') || '';
              const snipRaw = m.snippet || '';
              const snip = MARKER_RE.test(snipRaw) ? '' : escapeHtml(snipRaw).slice(0, 220);

              return `
                <li class="sr-item sr-msg"
                    data-id="${escapeHtml(id)}"
                    data-instancia-id="${escapeHtml(inst)}"
                    data-conversation-key="${escapeHtml(convKey)}"
                    data-nome="${escapeHtml(displayNome || '')}"
                    data-telefone="${escapeHtml(telRaw || telBR || '')}"
                    data-avatar-url="${escapeHtml(cache.avatar_url || '')}"
                    data-message-db-id="${escapeHtml(msgDbId)}"
                    data-wa-msg-id="${escapeHtml(waMsgId)}"
                    data-q="${encodeURIComponent(query)}"
                    tabindex="0">
                  <div class="sr-bullet"></div>
                  <div class="sr-text">
                    <div class="sr-name">${nomeHtml}</div>
                    <div class="sr-msgline">${snip ? '… ' + snip : ''}</div>
                  </div>
                  <div class="sr-meta">${escapeHtml(when)}</div>
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
              const id = getClienteId(c);
              const inst = getInstanciaId(c);
              const convKey = getConvKey(c) || (id && inst ? `c:${id}:${inst}` : '');
              const nome = c.push_name?.trim?.() || c.nome_whatsapp || c.nome || c.name || formatarNumeroBR(c.telefone || '');
              const av = c.avatar_url
                ? `
                  <span class="sr-avatar">
                    <img
                      src="${escapeHtml(c.avatar_url)}"
                      alt=""
                      onerror="this.onerror=null;this.parentElement.classList.add('avatar-default');this.remove();"
                    >
                  </span>
                `
                : `
                  <span class="sr-avatar avatar-default">
                    <i class="fa fa-user-circle"></i>
                  </span>
                `;

              const lastRaw = c.ultima_mensagem || c.last_message || c.preview || '';
              const lastClean = MARKER_RE.test(lastRaw) ? '' : lastRaw;
              const preview = (lastClean && String(lastClean).trim()) ? String(lastClean).trim() : '[mídia]';

              return `
                <li class="sr-item"
                    data-id="${escapeHtml(id)}"
                    data-instancia-id="${escapeHtml(inst)}"
                    data-conversation-key="${escapeHtml(convKey)}"
                    data-nome="${escapeHtml(nome || '')}"
                    data-telefone="${escapeHtml(c.telefone || c.telefone_fmt || c.phone || c.numero || '')}"
                    data-avatar-url="${escapeHtml(c.avatar_url || '')}"
                    data-q="${encodeURIComponent(query)}"
                    tabindex="0">
                  ${av}
                  <div class="sr-text">
                    <div class="sr-name">${escapeHtml(nome || '')}</div>
                    <div class="sr-last">${escapeHtml(preview || '')}</div>
                  </div>
                  <div class="sr-meta">${escapeHtml((window.formatChatTime || (() => ''))(c.hora || c.last_ts) || '')}</div>
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

    if (footerText) {
      html += `<div class="sr-empty">${escapeHtml(footerText)}</div>`;
    }

    srRender(html);

    resultsEl.querySelectorAll('.sr-item').forEach((li) => {
      const openItem = async () => {
        const id = String(li.dataset.id || '').trim();
        const inst = String(li.dataset.instanciaId || '').trim();
        const convKey = String(li.dataset.conversationKey || '').trim() || (id && inst ? `c:${id}:${inst}` : '');
        const q2 = decodeURIComponent(li.dataset.q || query);
        const msgDbId = String(li.dataset.messageDbId || '').trim();
        const waMsgId = String(li.dataset.waMsgId || '').trim();
        // Só tratamos como salto exato de mensagem quando existe id real da mensagem.
        // Se for apenas uma linha agrupada/preview, abre como contato normal para não deixar o histórico branco.
        const isMsgResult = li.classList.contains('sr-msg') && (!!msgDbId || !!waMsgId);

        const nome = String(li.dataset.nome || '').trim();
        const telefone = String(li.dataset.telefone || '').trim();
        const avatarUrl = String(li.dataset.avatarUrl || '').trim();

        const payload = {
          id: Number(id) || id,
          cliente_id: Number(id) || id,
          instancia_id: Number(inst) || inst,
          conversation_key: convKey,
          conversation_id: convKey,
          nome,
          nome_whatsapp: nome,
          push_name: nome,
          telefone,
          telefone_fmt: telefone,
          avatar_url: avatarUrl,
        };

        const jumpSeq = ++_openSeq;
        _pendingJump = isMsgResult
          ? { jumpSeq, mensagemId: msgDbId, waMsgId, query: q2, convKey, clienteId: id, instanciaId: inst }
          : null;

        // Ao clicar em CONTATO, só abre a conversa.
        // Ao clicar em MENSAGEM com id real, trava apenas o auto-scroll enquanto foca o item.
        // IMPORTANTE v9:
        // não esconda o painel de pesquisa ao abrir a conversa.
        // O usuário pode querer clicar em outro resultado da mesma busca.
        // A busca só fecha ao limpar o campo, apertar ESC ou clicar fora sem texto.
        if (isMsgResult) _lockSearchJumpScroll(18000);

        try {
          resultsEl.querySelectorAll('.sr-item.is-selected').forEach((x) => x.classList.remove('is-selected'));
          li.classList.add('is-selected');
        } catch {}

        if (_searchAbort) {
          try { _searchAbort.abort(); } catch {}
        }

        let openPromise = Promise.resolve();
        if (typeof window.selecionarClienteObj === 'function') {
          try {
            // Não esperamos a carga completa da conversa, porque ela pode demorar.
            // A UI abre rápido; o foco da mensagem é feito em paralelo por mensagem_id.
            openPromise = Promise.resolve(window.selecionarClienteObj(payload, isMsgResult ? { searchJump: true } : {}));
            openPromise.catch(() => {});
          } catch (e) {
            console.warn('[search] falha abrindo conversa:', e?.message || e);
          }
        }

        await _waitConversationOpen(convKey, 1200);

        if (!isMsgResult) {
          _pendingJump = null;
          return;
        }

        // Garante que, mesmo que o contexto da mensagem falhe, o histórico normal apareça.
        try {
          if (convKey && hist && !hist.querySelector('.msg-row, .bubble') && typeof window.renderHistoricoDoCache === 'function') {
            window.renderHistoricoDoCache(convKey, false);
          }
        } catch {}

        _findInRendered._lastIndex = 0;

        const focused = await _focusMessageResult({
          mensagemId: msgDbId,
          waMsgId,
          query: q2,
          convKey,
          clienteId: id,
          instanciaId: inst,
          jumpSeq,
        });

        if (!focused && jumpSeq === _openSeq) {
          // Último fallback: procura somente no que já está renderizado.
          // Não carrega 12 páginas antigas automaticamente para não mexer a tela sozinho.
          _findInRendered(q2);
        }

        // Mantém a promise consumida para evitar erro silencioso no console.
        openPromise.catch(() => {});
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

    _lockSearchJumpScroll(9000);

    hist.querySelectorAll('.search-hit').forEach((n) => {
      n.classList.remove('search-hit', 'search-hit-fade');
    });

    const bubble =
      el.classList?.contains('bubble')
        ? el
        : (el.querySelector?.('.bubble') || el.closest?.('.bubble') || el);

    bubble.classList.add('search-hit');
    bubble.scrollIntoView({ behavior: 'auto', block: 'center' });

    setTimeout(() => bubble.classList.add('search-hit-fade'), 650);
    setTimeout(() => bubble.classList.remove('search-hit', 'search-hit-fade'), 4200);
  }

  function _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function _findMessageNodeByIds(ids = []) {
    const wanted = new Set(
      ids
        .map((x) => String(x || '').trim())
        .filter(Boolean)
    );
    if (!wanted.size || !hist) return null;

    const nodes = Array.from(hist.querySelectorAll('.msg-row, .bubble'));
    return nodes.find((n) => (
      wanted.has(String(n.getAttribute('data-id') || '').trim()) ||
      wanted.has(String(n.getAttribute('data-msg-id') || '').trim()) ||
      wanted.has(String(n.getAttribute('data-message-id') || '').trim()) ||
      wanted.has(String(n.getAttribute('data-wa-msg-id') || '').trim()) ||
      wanted.has(String(n.getAttribute('data-db-id') || '').trim()) ||
      wanted.has(String(n.getAttribute('data-message-db-id') || '').trim())
    )) || null;
  }

  async function _fetchMessageContext({ mensagemId, clienteId, instanciaId }) {
    if (!mensagemId) return [];

    const qs = new URLSearchParams();
    qs.set('empresa_id', String(EMPRESA_ID));
    qs.set('mensagem_id', String(mensagemId));
    qs.set('limit', '40');

    if (clienteId) qs.set('cliente_id', String(clienteId));
    if (instanciaId) qs.set('instancia_id', String(instanciaId));

    const url = `/api/atendimento/search/mensagem-contexto?${qs.toString()}`;
    const res = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });

    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data.items) ? data.items : (Array.isArray(data.mensagens) ? data.mensagens : []);
  }

  async function _focusMessageResult({ mensagemId, waMsgId, query, convKey, clienteId, instanciaId, jumpSeq }) {
    const ids = [mensagemId, waMsgId];
    const key = convKey || (clienteId && instanciaId ? `c:${clienteId}:${instanciaId}` : clienteId);

    _lockSearchJumpScroll(22000);

    // 1) tenta imediatamente no que já está na tela.
    let node = _findMessageNodeByIds(ids);
    if (node && _isSearchJumpStillActive(jumpSeq, key)) {
      _focusHit(node);
      return true;
    }

    // 2) espera só um pouco a conversa renderizar; não fica esperando 15s.
    for (let i = 0; i < 8; i++) {
      await _sleep(80);
      if (!_isSearchJumpStillActive(jumpSeq, key)) return false;
      node = _findMessageNodeByIds(ids);
      if (node) {
        _focusHit(node);
        return true;
      }
    }

    // 3) se é resultado de mensagem do banco, carrega uma janela ao redor dela.
    // Isso é rápido porque usa mensagem_id. Não pagina 12 vezes nem mexe a tela depois.
    if (mensagemId && typeof window.salvarNoCache === 'function' && typeof window.renderHistoricoDoCache === 'function') {
      let items = [];
      try {
        items = await _fetchMessageContext({ mensagemId, clienteId, instanciaId });
      } catch (e) {
        console.warn('[search] contexto da mensagem falhou:', e?.message || e);
      }

      if (!_isSearchJumpStillActive(jumpSeq, key)) return false;

      if (items.length) {
        _lockSearchJumpScroll(12000);
        try { window.salvarNoCache(key, items); } catch {}
        try { window.renderHistoricoDoCache(key, false); } catch {}

        await _sleep(120);
        if (!_isSearchJumpStillActive(jumpSeq, key)) return false;

        node = _findMessageNodeByIds(ids);
        if (node) {
          _focusHit(node);
          return true;
        }

        if (query && _findInRendered(query)) return true;
      }
    }

    return false;
  }

  async function _loadMoreHistoryUntilMatch(query, maxPages = 5) {
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
    const local = collectLocalResults(q);
    renderSearchPanel({ q, contatos: local.contatos, mensagens: local.mensagens });
  }

  let _deb = null;

  async function onSearchInput() {
    const q = (searchInput?.value || '').trim();
    const seq = ++_searchSeq;

    if (!q) {
      if (_searchAbort) {
        try { _searchAbort.abort(); } catch {}
      }
      srHide();
      window.renderListaClientes?.(window.clientesCache || []);
      return;
    }

    if (q.length < 2 && onlyDigits(q).length < 2) {
      srRender('<div class="sr-empty">Digite pelo menos 2 caracteres</div>');
      return;
    }

    const local = collectLocalResults(q);
    const hasLocal = (local.contatos.length || local.mensagens.length);

    if (hasLocal) {
      renderSearchPanel({ q, contatos: local.contatos, mensagens: local.mensagens, footerText: 'Buscando mais resultados no banco…' });
    } else {
      srShowLoading('Procurando no banco…');
    }

    clearTimeout(_deb);

    _deb = setTimeout(async () => {
      let merged = local;

      try {
        const quick = await serverSearchSmart(q, 50, 6500, { deep: false });
        if (seq !== _searchSeq) return;

        merged = mergeResults(quick, local);
        renderSearchPanel({
          q,
          contatos: merged.contatos,
          mensagens: merged.mensagens,
          footerText: 'Buscando histórico completo…',
        });
      } catch (e) {
        if (seq !== _searchSeq) return;

        const msg = String(e?.name || e?.message || e || '');
        const timedOut = msg.includes('Abort') || msg.includes('abort');

        if (hasLocal) {
          renderSearchPanel({
            q,
            contatos: local.contatos,
            mensagens: local.mensagens,
            footerText: timedOut ? 'Mostrando os resultados disponíveis enquanto concluímos a pesquisa.' : 'Buscando histórico completo…',
          });
        } else {
          srShowLoading('Buscando histórico completo…');
        }

        console.warn('[search] busca rápida fallback:', e?.message || e);
      }

      try {
        const deep = await serverSearchSmart(q, 50, 22000, { deep: true });
        if (seq !== _searchSeq) return;

        merged = mergeResults(deep, merged);
        renderSearchPanel({ q, contatos: merged.contatos, mensagens: merged.mensagens });
      } catch (e) {
        if (seq !== _searchSeq) return;

        const msg = String(e?.name || e?.message || e || '');
        const timedOut = msg.includes('Abort') || msg.includes('abort');

        if ((merged?.contatos?.length || merged?.mensagens?.length)) {
          renderSearchPanel({
            q,
            contatos: merged.contatos,
            mensagens: merged.mensagens,
            footerText: timedOut ? 'Mostrando os resultados encontrados. A pesquisa completa demorou mais que o esperado.' : '',
          });
        } else {
          srRender('<div class="sr-empty">Nenhum resultado</div>');
        }

        console.warn('[search] busca profunda fallback:', e?.message || e);
      }
    }, 380);
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
    const qDigits = onlyDigits(q);
    const cand = poolContatos().find((c) => {
      const nome = _normalize(c.nome || c.push_name || c.nome_whatsapp || '');
      const tel = onlyDigits(c.telefone || c.celular || c.numero || '');
      const ult = _normalize(c.ultima_mensagem || c.last_message || '');
      return (qn && (nome.includes(qn) || ult.includes(qn))) || (qDigits && tel.includes(qDigits));
    });

    if (cand && typeof window.selecionarClienteObj === 'function') {
      const id = getClienteId(cand);
      const inst = getInstanciaId(cand);
      await window.selecionarClienteObj({
        ...cand,
        id: Number(id) || id || cand.id,
        cliente_id: Number(id) || id || cand.cliente_id,
        instancia_id: Number(inst) || inst || cand.instancia_id,
        conversation_key: getConvKey(cand),
      });
    }
  }

  searchInput.addEventListener('input', onSearchInput);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSearchEnter();
    }

    if (e.key === 'Escape') {
      searchInput.value = '';
      if (_searchAbort) {
        try { _searchAbort.abort(); } catch {}
      }
      srHide();
      window.renderListaClientes?.(window.clientesCache || []);
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

    if (!inSearch && !(searchInput?.value || '').trim()) {
      srHide();
    }
  });

  window._findInRendered = _findInRendered;
  window._loadMoreHistoryUntilMatch = _loadMoreHistoryUntilMatch;
})();
