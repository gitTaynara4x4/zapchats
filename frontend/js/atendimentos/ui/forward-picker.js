// /frontend/js/atendimentos/ui/forward-picker.js
// Encaminhar mensagens selecionadas estilo WhatsApp Web
// - abre drawer lateral
// - lista conversas
// - permite buscar e selecionar destinos
// - no confirmar:
//    1) chama window.confirmarEncaminhamentoMensagens(payload), se existir
//    2) senão dispara evento zc:forward-selected-to-chats

(function () {
  if (window.__ZC_FORWARD_PICKER__) return;
  window.__ZC_FORWARD_PICKER__ = true;

  const state = {
    open: false,
    query: '',
    messages: [],
    chats: [],
    selected: new Map(),
  };

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function $all(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[m]));
  }

  function norm(v) {
    return String(v || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function notify({ title = 'Pronto', msg = '', type = 'ok', timeout = 2600 } = {}) {
    if (typeof window.toast === 'function') {
      try {
        window.toast({ title, msg, type, timeout });
        return;
      } catch {}
      try {
        window.toast(msg || title, type !== 'error');
        return;
      } catch {}
    }

    let host = document.getElementById('zcToastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'zcToastHost';
      host.className = 'zcToastHost';
      document.body.appendChild(host);
    }

    const el = document.createElement('div');
    el.className = `zcToast ${type === 'error' ? 'err' : 'ok'}`;
    el.innerHTML = `
      <div>
        <div class="t-title">${esc(title)}</div>
        ${msg ? `<div class="t-msg">${esc(msg)}</div>` : ''}
      </div>
      <button class="t-close" aria-label="Fechar"><i class="fa-solid fa-xmark"></i></button>
    `;
    host.appendChild(el);

    requestAnimationFrame(() => el.classList.add('on'));
    el.querySelector('.t-close')?.addEventListener('click', () => el.remove());
    if (timeout) setTimeout(() => el.remove(), timeout);
  }

  function idKey(v) {
    const s = String(v ?? '').trim();
    if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
    return s;
  }

  function instKey(v) {
    const s = String(v ?? '').trim();
    if (!s) return null;
    if (['null', 'undefined', 'nan', '0', 'all', '*', '-'].includes(s.toLowerCase())) return null;
    return s;
  }

  function buildConversationKey(kind, entityId, instId) {
    const k = String(kind || '').toLowerCase() === 'g' ? 'g' : 'c';
    const eid = idKey(entityId);
    const iid = instKey(instId) || '0';
    if (!eid) return null;
    return `${k}:${eid}:${iid}`;
  }

  function parseConversationKey(raw) {
    const s = idKey(raw);
    if (!s) return null;

    const m = s.match(/^([cg]):(\d+):([^:]+)$/i);
    if (!m) return null;

    return {
      key: `${m[1].toLowerCase()}:${m[2]}:${m[3]}`,
      kind: m[1].toLowerCase(),
      entityId: m[2],
      instId: instKey(m[3]) || '0',
    };
  }

  function getCurrentConversationKey() {
    const hist = document.getElementById('historico');
    const sel = window.state?.clienteSel || window.clienteSel || null;

    const candidates = [
      hist?.dataset?.conversationKey,
      sel?.conversation_key,
      sel?.conversation_id,
      buildConversationKey(
        sel?.is_group || sel?.grupo || sel?.grupo_id != null ? 'g' : 'c',
        sel?.entity_id || sel?.backend_id || sel?.api_id || sel?.cliente_id || sel?.grupo_id || sel?.id,
        sel?.instancia_id || sel?.instancia || sel?.instance_name || sel?.instance
      ),
    ];

    for (const raw of candidates) {
      const parsed = parseConversationKey(raw);
      if (parsed?.key) return parsed.key;
    }

    return null;
  }

  function pickChatName(item) {
    return (
      item?.nome ||
      item?.nome_whatsapp ||
      item?.cliente_nome ||
      item?.title ||
      item?.display_name ||
      item?.label ||
      item?.telefone_fmt ||
      item?.telefone ||
      'Conversa'
    );
  }

  function pickChatSub(item) {
    return (
      item?.telefone_fmt ||
      item?.telefone ||
      item?.subtitle ||
      item?.ultima_mensagem ||
      item?.last_message ||
      ''
    );
  }

  function pickChatAvatar(item) {
    return (
      item?.avatar_url ||
      item?.avatar ||
      item?.picture ||
      ''
    );
  }

  function pickChatKind(item) {
    if (item?.kind === 'g' || item?.conversation_kind === 'g') return 'g';
    if (item?.is_group === true || item?.grupo === true || item?.grupo_id != null) return 'g';
    return 'c';
  }

  function pickConversationKey(item) {
    const direct = parseConversationKey(
      item?.conversation_key ||
      item?.conversation_id ||
      item?.key ||
      null
    );
    if (direct?.key) return direct.key;

    return buildConversationKey(
      pickChatKind(item),
      item?.entity_id || item?.backend_id || item?.api_id || item?.cliente_id || item?.grupo_id || item?.id,
      item?.instancia_id || item?.instancia || item?.instance_name || item?.instance
    );
  }

  function getChatsFromState() {
    const st = window.state || {};
    const merged = [
      ...(Array.isArray(st.clientesCache) ? st.clientesCache : []),
      ...(Array.isArray(st.todosContatosCache) ? st.todosContatosCache : []),
    ];

    const out = [];
    const seen = new Set();

    for (const item of merged) {
      const key = pickConversationKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      out.push({
        key,
        kind: pickChatKind(item),
        entity_id: parseConversationKey(key)?.entityId || null,
        instancia_id: parseConversationKey(key)?.instId || null,
        nome: pickChatName(item),
        subtitle: pickChatSub(item),
        avatar_url: pickChatAvatar(item),
        raw: item,
      });
    }

    return out;
  }

  function getChatsFromDOM() {
    const nodes = $all('[data-conversation-key], .cliente-item[data-id], li.chat-item[data-id]');
    const out = [];
    const seen = new Set();

    nodes.forEach((el) => {
      const rawKey =
        el.getAttribute('data-conversation-key') ||
        el.getAttribute('data-id') ||
        null;

      let key = parseConversationKey(rawKey)?.key || null;

      if (!key) {
        const entityId =
          el.getAttribute('data-entity-id') ||
          el.getAttribute('data-cliente-id') ||
          null;
        const inst =
          el.getAttribute('data-instancia-id') ||
          el.getAttribute('data-instancia') ||
          null;

        key = buildConversationKey('c', entityId, inst);
      }

      if (!key || seen.has(key)) return;
      seen.add(key);

      const nome =
        el.querySelector('.name, .nome, .cliente-nome, .chat-title, .title')?.textContent?.trim() ||
        el.textContent?.trim() ||
        'Conversa';

      const subtitle =
        el.querySelector('.last, .last-message, .preview, .subtitle')?.textContent?.trim() ||
        '';

      const avatar =
        el.querySelector('img')?.getAttribute('src') ||
        '';

      out.push({
        key,
        kind: parseConversationKey(key)?.kind || 'c',
        entity_id: parseConversationKey(key)?.entityId || null,
        instancia_id: parseConversationKey(key)?.instId || null,
        nome,
        subtitle,
        avatar_url: avatar,
        raw: null,
      });
    });

    return out;
  }

  function loadChats() {
    const currentKey = getCurrentConversationKey();

    const merged = [
      ...getChatsFromState(),
      ...getChatsFromDOM(),
    ];

    const out = [];
    const seen = new Set();

    for (const item of merged) {
      if (!item?.key) continue;
      if (seen.has(item.key)) continue;
      seen.add(item.key);

      out.push(item);
    }

    out.sort((a, b) => {
      if (a.key === currentKey) return -1;
      if (b.key === currentKey) return 1;
      return String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR');
    });

    state.chats = out;
  }

  function filteredChats() {
    const q = norm(state.query);
    if (!q) return state.chats;

    return state.chats.filter((item) => {
      const hay = norm([
        item.nome,
        item.subtitle,
        item.entity_id,
        item.key,
      ].join(' '));

      return hay.includes(q);
    });
  }

  function ensureModal() {
    if (document.getElementById('zcForwardBackdrop')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'zcForwardBackdrop';
    backdrop.className = 'zc-forward-backdrop';

    const modal = document.createElement('aside');
    modal.id = 'zcForwardModal';
    modal.className = 'zc-forward-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Encaminhar mensagens');

    modal.innerHTML = `
      <div class="zc-forward-head">
        <button type="button" class="zc-forward-close" id="zcForwardClose" aria-label="Fechar">
          <i class="fa-solid fa-arrow-left"></i>
        </button>
        <div class="zc-forward-head-text">
          <strong>Encaminhar mensagens</strong>
          <small id="zcForwardHeadMeta">0 mensagens selecionadas</small>
        </div>
      </div>

      <div class="zc-forward-toolbar">
        <div class="zc-forward-search">
          <i class="fa-solid fa-magnifying-glass"></i>
          <input
            id="zcForwardSearch"
            type="text"
            placeholder="Pesquisar conversa"
            autocomplete="off"
            spellcheck="false"
          >
        </div>
      </div>

      <div class="zc-forward-body">
        <div id="zcForwardSelectedMeta" class="zc-forward-selected-meta hidden"></div>
        <div id="zcForwardList" class="zc-forward-list"></div>
      </div>

      <div class="zc-forward-foot">
        <button type="button" class="zc-forward-btn zc-forward-btn-ghost" id="zcForwardCancel">
          Cancelar
        </button>
        <button type="button" class="zc-forward-btn zc-forward-btn-primary" id="zcForwardConfirm" disabled>
          Encaminhar
        </button>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);

    $('#zcForwardClose')?.addEventListener('click', closeModal);
    $('#zcForwardCancel')?.addEventListener('click', closeModal);

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });

    $('#zcForwardSearch')?.addEventListener('input', (e) => {
      state.query = e.target.value || '';
      renderList();
    });

    $('#zcForwardConfirm')?.addEventListener('click', confirmForward);

    document.addEventListener('keydown', (e) => {
      if (!state.open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
      }
    });
  }

  function openModal(payload) {
    ensureModal();

    state.open = true;
    state.query = '';
    state.selected.clear();
    state.messages = Array.isArray(payload?.items) ? payload.items.slice() : [];

    loadChats();
    renderHeader();
    renderList();
    renderSelectedMeta();
    refreshConfirmButton();

    $('#zcForwardBackdrop')?.classList.add('is-open');
    $('#zcForwardModal')?.classList.add('is-open');

    const input = $('#zcForwardSearch');
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 40);
    }
  }

  function closeModal() {
    state.open = false;
    state.query = '';
    state.selected.clear();

    $('#zcForwardBackdrop')?.classList.remove('is-open');
    $('#zcForwardModal')?.classList.remove('is-open');
  }

  function renderHeader() {
    const meta = $('#zcForwardHeadMeta');
    if (!meta) return;

    const count = state.messages.length;
    meta.textContent = count === 1
      ? '1 mensagem selecionada'
      : `${count} mensagens selecionadas`;
  }

  function renderSelectedMeta() {
    const el = $('#zcForwardSelectedMeta');
    if (!el) return;

    const count = state.selected.size;
    if (!count) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }

    el.textContent = count === 1
      ? '1 conversa selecionada'
      : `${count} conversas selecionadas`;

    el.classList.remove('hidden');
  }

  function avatarHTML(item) {
    const name = esc(item?.nome || 'Conversa');
    const avatar = String(item?.avatar_url || '').trim();

    if (avatar) {
      return `<img src="${esc(avatar)}" alt="${name}" loading="lazy">`;
    }

    return `<span class="zc-forward-avatar-fallback"><i class="fa-regular fa-user"></i></span>`;
  }

  function renderList() {
    const host = $('#zcForwardList');
    if (!host) return;

    const items = filteredChats();

    if (!items.length) {
      host.innerHTML = `<div class="zc-forward-empty">Nenhuma conversa encontrada.</div>`;
      return;
    }

    host.innerHTML = items.map((item) => {
      const selected = state.selected.has(item.key);
      return `
        <button
          type="button"
          class="zc-forward-item${selected ? ' is-selected' : ''}"
          data-key="${esc(item.key)}"
        >
          <span class="zc-forward-avatar">
            ${avatarHTML(item)}
          </span>

          <span class="zc-forward-item-main">
            <span class="zc-forward-item-title">${esc(item.nome || 'Conversa')}</span>
            <span class="zc-forward-item-sub">${esc(item.subtitle || '')}</span>
          </span>

          <span class="zc-forward-item-check">
            <i class="fa-solid fa-check"></i>
          </span>
        </button>
      `;
    }).join('');

    $all('.zc-forward-item', host).forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-key');
        toggleTarget(key);
      });
    });
  }

  function toggleTarget(key) {
    if (!key) return;

    const chat = state.chats.find((x) => x.key === key);
    if (!chat) return;

    if (state.selected.has(key)) {
      state.selected.delete(key);
    } else {
      state.selected.set(key, chat);
    }

    renderList();
    renderSelectedMeta();
    refreshConfirmButton();
  }

  function refreshConfirmButton() {
    const btn = $('#zcForwardConfirm');
    if (!btn) return;

    const targetCount = state.selected.size;
    btn.disabled = targetCount <= 0 || state.messages.length <= 0;

    if (targetCount <= 0) {
      btn.textContent = 'Encaminhar';
      return;
    }

    btn.textContent = targetCount === 1
      ? 'Encaminhar para 1 conversa'
      : `Encaminhar para ${targetCount} conversas`;
  }

  async function confirmForward() {
    const targets = Array.from(state.selected.values());
    const messages = Array.isArray(state.messages) ? state.messages.slice() : [];

    if (!messages.length) {
      notify({
        title: 'Encaminhar',
        msg: 'Nenhuma mensagem selecionada.',
        type: 'error',
      });
      return;
    }

    if (!targets.length) {
      notify({
        title: 'Encaminhar',
        msg: 'Selecione ao menos uma conversa.',
        type: 'error',
      });
      return;
    }

    const payload = {
      messages,
      targets,
      total_messages: messages.length,
      total_targets: targets.length,
    };

    try {
      if (typeof window.confirmarEncaminhamentoMensagens === 'function') {
        await window.confirmarEncaminhamentoMensagens(payload);
      } else {
        document.dispatchEvent(
          new CustomEvent('zc:forward-selected-to-chats', { detail: payload })
        );
      }

      closeModal();
      if (typeof window.cancelarSelecaoMensagens === 'function') {
        window.cancelarSelecaoMensagens();
      }

      notify({
        title: 'Encaminhamento',
        msg: `Preparado para ${targets.length} conversa(s).`,
        type: 'ok',
      });
    } catch (err) {
      console.error('[forward-picker] erro ao confirmar encaminhamento', err);
      notify({
        title: 'Erro ao encaminhar',
        msg: 'Não foi possível continuar o encaminhamento.',
        type: 'error',
      });
    }
  }

  function encaminharMensagensSelecionadas(payload) {
    openModal(payload || {});
  }

  window.encaminharMensagensSelecionadas = encaminharMensagensSelecionadas;
})();