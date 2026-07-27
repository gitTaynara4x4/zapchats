(() => {
  'use strict';

  /* =========================================================
     Chat Interno - ZapsChat
     Correção principal:
     - pinta a tela imediatamente;
     - usa cache local antes das APIs;
     - carrega /me, /roster e /conversations em paralelo;
     - nomes/ícones aparecem rápido;
     - criar grupo, contatos, favoritos, menções e filtro funcionam.
  ========================================================= */

  // ===== DOM / helpers =====
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const API = '/api/internal-chat';

  const listaEl = $('#listaConversas');
  const msgsEl = $('#msgsScroll');
  const peerNameEl = $('#peerName');
  const peerStatusEl = $('#peerStatus');
  const totalConversasEl = $('#totalConversas');
  const txtMsg = $('#txtMsg');
  const btnSend = $('#btnSend');
  const btnAttach = $('#btnAttach');
  const btnBackList = $('#btnBackList');
  const btnNewChannel = $('#btnNewChannel');
  const inpSearch = $('#inpSearch');
  const peerAvatarEl = $('#peerAvatar');
  const profilePanel = $('#profilePanel');
  const profileAvatarEl = $('#profileAvatar');
  const profileNameEl = $('#profileName');
  const profileRoleEl = $('#profileRole');
  const profileLastAccessEl = $('#profileLastAccess');
  const profilePhoneEl = $('#profilePhone');
  const profileEmailEl = $('#profileEmail');
  const profileFullNameEl = $('#profileFullName');
  const profileLocationEl = $('#profileLocation');
  const profileSinceEl = $('#profileSince');
  const profileWebsiteEl = $('#profileWebsite');
  const rosterListEl = $('#rosterList');
  const btnCloseProfile = $('#btnCloseProfile');
  const btnToggleProfile = $('#btnToggleProfile');
  const btnInfoProfile = $('#btnInfoProfile');
  const btnMention = $('#btnMention');
  const btnFilter = $('#btnFilter');
  const btnCreateGroup = $('#btnCreateGroup');
  const filterLabelEl = $('#filterLabel');
  const conversationTitleEl = $('#conversationTitle');
  const conversationSubtitleEl = $('#conversationSubtitle');
  const railLinks = $$('.rail-link[data-view]');

  const CONVS = new Map();
  const MSGS = new Map();
  const COLABS = new Map();

  let ME_ID = readNumLS('internal_chat_me_id');
  let EMPRESA_ID = readNumLS('empresa_id') || readNumLS('internal_chat_empresa_id');
  let ACTIVE = null;
  let CURRENT_VIEW = localStorage.getItem('internal_chat_view') || 'chats';
  let CURRENT_FILTER = localStorage.getItem('internal_chat_filter') || 'all';
  let ws = null;
  let wsPing = null;
  let wsTries = 0;
  let offCompanyWS = null;
  let filterMenu = null;
  let mentionMenu = null;

  const FAVORITES = new Set(
    safeJson(localStorage.getItem('internal_chat_favorite_colabs'), [])
      .map(Number)
      .filter(Boolean)
  );

  const FILTERS = {
    all: 'Todos',
    unread: 'Não lidas',
    favorites: 'Favoritos',
    groups: 'Grupos'
  };

  const VIEW_META = {
    chats: ['Chats', 'Conversas da equipe'],
    groups: ['Grupos', 'Conversas com mais de uma pessoa'],
    mentions: ['Menções', 'Mensagens que citaram você ou a equipe'],
    contacts: ['Contatos', 'Colaboradores da empresa']
  };

  function unhideFast() {
    const html = document.documentElement;
    html.classList.remove('prepaint');
    html.setAttribute('data-head-ready', '1');
    html.setAttribute('data-loader-ready', '1');
    document.body.style.visibility = 'visible';
  }

  function safeJson(raw, fallback) {
    try {
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function readNumLS(key) {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function saveFavorites() {
    localStorage.setItem('internal_chat_favorite_colabs', JSON.stringify([...FAVORITES]));
  }

  function rosterCacheKeys() {
    const emp = EMPRESA_ID || localStorage.getItem('empresa_id') || '';
    return [`internal_chat_roster:${emp}`, 'internal_chat_roster:last'];
  }

  function convsCacheKeys() {
    const emp = EMPRESA_ID || localStorage.getItem('empresa_id') || '';
    return [`internal_chat_convs:${emp}`, 'internal_chat_convs:last'];
  }

  function cacheSet(keys, value) {
    const raw = JSON.stringify(value || []);
    keys.forEach((k) => {
      try { localStorage.setItem(k, raw); } catch {}
    });
  }

  function cacheGet(keys) {
    for (const k of keys) {
      const data = safeJson(localStorage.getItem(k), null);
      if (Array.isArray(data) && data.length) return data;
    }
    return [];
  }

  async function api(url, init = {}) {
    const headers = { ...(init.headers || {}) };
    const hasBody = init.body != null;

    if (hasBody && !(init.body instanceof FormData)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }

    const r = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      ...init,
      headers
    });

    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const txt = await r.text();

    let data = null;
    if (txt && ct.includes('application/json')) {
      try { data = JSON.parse(txt); } catch { data = null; }
    } else if (txt) {
      data = { raw: txt };
    }

    if (!r.ok) {
      const msg = data?.detail || data?.message || `Erro ${r.status}`;
      throw new Error(Array.isArray(msg) ? msg.map(x => x.msg || x).join('\n') : String(msg));
    }

    if (r.status === 204) return { ok: true };
    return data ?? { ok: true };
  }

  const debounce = (fn, ms = 250) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  }

  function fmtTimeShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString([], {
      day: '2-digit',
      month: '2-digit',
      ...(sameYear ? {} : { year: '2-digit' })
    });
  }

  function fmtSince(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function fmtLastAccess(iso) {
    if (!iso) return 'Nunca acessou o ZapsChat';

    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Nunca acessou o ZapsChat';

    const now = new Date();
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.round((today.getTime() - day.getTime()) / 86400000);
    const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    if (diffDays === 0) return `Último acesso hoje às ${time}`;
    if (diffDays === 1) return `Último acesso ontem às ${time}`;

    const date = d.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
    });
    return `Último acesso em ${date} às ${time}`;
  }

  function normalizedPresenceStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    return ['online', 'away'].includes(status) ? status : 'offline';
  }

  function fmtPresence(colab) {
    const status = normalizedPresenceStatus(colab?.presence_status);
    if (status === 'online') return 'Online agora';
    if (status === 'away') return 'Ausente';
    return fmtLastAccess(colab?.last_access_at);
  }

  function applyPresenceItem(item, { render = true } = {}) {
    if (!item || typeof item !== 'object') return false;
    const id = Number(item.colaborador_id || item.id || 0);
    if (!id) return false;

    const colab = COLABS.get(id);
    if (!colab) return false;

    colab.presence_status = normalizedPresenceStatus(item.presence_status);
    colab.presence_updated_at = item.presence_updated_at || null;
    colab.presence_expires_at = item.presence_expires_at || null;
    colab.presence_activity_at = item.presence_activity_at || null;

    if (colab.presence_status === 'offline' && item.presence_updated_at) {
      colab.last_access_at = item.presence_updated_at;
    }

    COLABS.set(id, colab);
    if (render) {
      cacheSet(rosterCacheKeys(), [...COLABS.values()]);
      renderAll();
      if (document.body.classList.contains('profile-open') && ACTIVE) {
        updateProfile(CONVS.get(ACTIVE));
      }
    }
    return true;
  }

  function applyPresenceSnapshot(items) {
    const active = new Map();
    (Array.isArray(items) ? items : []).forEach((item) => {
      const id = Number(item?.colaborador_id || item?.id || 0);
      if (id) active.set(id, item);
    });

    COLABS.forEach((colab, id) => {
      const item = active.get(Number(id));
      if (item) {
        applyPresenceItem(item, { render: false });
      } else {
        colab.presence_status = 'offline';
        colab.presence_expires_at = null;
        COLABS.set(Number(id), colab);
      }
    });

    cacheSet(rosterCacheKeys(), [...COLABS.values()]);
    renderAll();
    if (document.body.classList.contains('profile-open') && ACTIVE) {
      updateProfile(CONVS.get(ACTIVE));
    }
  }

  function toast(msg, type = 'ok', ms = 2600) {
    let stack = $('.toaststack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toaststack';
      document.body.appendChild(stack);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 240);
    }, ms);
  }

  function setIconAvatar(el, type = 'user') {
    if (!el) return;
    el.classList.add('avatar', 'has-user-icon');
    el.innerHTML = type === 'group'
      ? '<i class="fa-solid fa-user-group" aria-hidden="true"></i>'
      : '<i class="fa-solid fa-user" aria-hidden="true"></i>';
  }

  function scrollBottom() {
    if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function setPane(pane) {
    document.body.setAttribute('data-pane', pane);
  }

  // ===== Normalização =====
  function normColab(c) {
    const id = Number(c?.id);
    return {
      id,
      nome: c?.nome || c?.name || c?.nome_completo || `Colaborador #${id}`,
      nome_completo: c?.nome_completo || c?.nome || c?.name || `Colaborador #${id}`,
      setor_nome: c?.setor_nome || c?.setor || c?.departamento || '',
      email: c?.email || '',
      telefone: c?.telefone || c?.phone || '',
      cargo: c?.cargo || '',
      created_at: c?.created_at || c?.timestamp || '',
      last_access_at: c?.last_access_at || c?.ultimo_acesso || '',
      presence_status: normalizedPresenceStatus(c?.presence_status),
      presence_updated_at: c?.presence_updated_at || '',
      presence_expires_at: c?.presence_expires_at || '',
      presence_activity_at: c?.presence_activity_at || '',
      avatar_url: c?.avatar_url || (id ? `/api/colaboradores/${id}/avatar` : '')
    };
  }

  function normConv(c) {
    const tid = c?.thread_id || c?.id || c?.threadId;
    const parts = Array.isArray(c?.participantes) ? c.participantes.map(Number).filter(Boolean) : [];
    return {
      thread_id: tid,
      titulo: c?.titulo || 'Conversa',
      participantes: parts,
      last_texto: c?.last_texto || c?.texto || '',
      last_kind: c?.last_kind || '',
      last_created_at: c?.last_created_at || c?.created_at || null,
      unread_count: Number(c?.unread_count || 0)
    };
  }

  function getOtherParticipantId(c) {
    const parts = (c?.participantes || []).map(Number).filter(Boolean);
    if (!parts.length) return null;
    if (ME_ID && parts.includes(Number(ME_ID))) {
      return parts.find((p) => p !== Number(ME_ID)) || parts[0];
    }
    return parts[0];
  }

  function getPeerColab(c) {
    const id = getOtherParticipantId(c);
    return id ? COLABS.get(Number(id)) || null : null;
  }

  function isGroupConv(c) {
    return (c?.participantes || []).length > 2;
  }

  function isDirectConv(c) {
    return !isGroupConv(c);
  }

  function colabNameById(id) {
    const c = COLABS.get(Number(id));
    return c?.nome || c?.nome_completo || `Colaborador #${id}`;
  }

  function getConvDisplayName(c) {
    if (!c) return 'Conversa';
    const raw = String(c.titulo || '').trim();

    if (isGroupConv(c)) {
      if (raw && raw.toLowerCase() !== 'conversa') return raw;
      const names = (c.participantes || [])
        .filter((id) => Number(id) !== Number(ME_ID))
        .slice(0, 3)
        .map(colabNameById);
      return names.length ? names.join(', ') : 'Grupo';
    }

    const peer = getPeerColab(c);
    if (peer) return peer.nome || peer.nome_completo;

    if (raw && raw.toLowerCase() !== 'conversa') return raw;
    return 'Conversa';
  }

  function isFavoriteConv(c) {
    const id = getOtherParticipantId(c);
    return id ? FAVORITES.has(Number(id)) : false;
  }

  function hasMention(c) {
    const txt = String(c?.last_texto || '').toLowerCase();
    if (!txt.includes('@')) return false;

    const me = ME_ID ? COLABS.get(Number(ME_ID)) : null;
    const meName = String(me?.nome || me?.nome_completo || '').replace(/\s+/g, '').toLowerCase();
    return txt.includes('@todos') || txt.includes('@all') || !meName || txt.includes('@' + meName);
  }

  function directConvKey(c) {
    const parts = (c?.participantes || []).map(Number).filter(Boolean).sort((a, b) => a - b);
    if (parts.length !== 2) return '';
    return parts.join(':');
  }

  function preferConversation(a, b) {
    if (!b) return a;

    const aHasMsg = String(a?.last_texto || '').trim() && a?.last_kind === 'msg';
    const bHasMsg = String(b?.last_texto || '').trim() && b?.last_kind === 'msg';
    if (aHasMsg !== bHasMsg) return aHasMsg ? a : b;

    const aHasText = String(a?.last_texto || '').trim();
    const bHasText = String(b?.last_texto || '').trim();
    if (!!aHasText !== !!bHasText) return aHasText ? a : b;

    const ad = new Date(a?.last_created_at || 0).getTime() || 0;
    const bd = new Date(b?.last_created_at || 0).getTime() || 0;
    return ad >= bd ? a : b;
  }

  function dedupeDirectConversations(rows) {
    const groups = [];
    const direct = new Map();

    (rows || []).forEach((c) => {
      if (!c?.thread_id) return;
      if (isGroupConv(c)) {
        groups.push(c);
        return;
      }

      const key = directConvKey(c) || String(c.thread_id);
      direct.set(key, preferConversation(c, direct.get(key)));
    });

    return groups.concat([...direct.values()]);
  }

  function compactConversationsMap() {
    const rows = dedupeDirectConversations([...CONVS.values()]);
    CONVS.clear();
    rows.forEach((c) => {
      if (c?.thread_id) CONVS.set(c.thread_id, c);
    });
    return rows;
  }

  function findBestDirectConversation(otherId) {
    const id = Number(otherId);
    if (!id) return null;

    const target = [Number(ME_ID), id].filter(Boolean).sort((a, b) => a - b).join(':');
    if (!target) return null;

    return dedupeDirectConversations([...CONVS.values()]).find((c) => directConvKey(c) === target) || null;
  }

  function filteredConvs() {
    const q = String(inpSearch?.value || '').trim().toLowerCase();
    let arr = dedupeDirectConversations([...CONVS.values()]);

    if (CURRENT_VIEW === 'groups') arr = arr.filter(isGroupConv);
    if (CURRENT_VIEW === 'mentions') arr = arr.filter(hasMention);

    if (CURRENT_FILTER === 'unread') arr = arr.filter((c) => Number(c.unread_count || 0) > 0);
    if (CURRENT_FILTER === 'favorites') arr = arr.filter(isFavoriteConv);
    if (CURRENT_FILTER === 'groups') arr = arr.filter(isGroupConv);

    if (q) {
      arr = arr.filter((c) => {
        const name = getConvDisplayName(c).toLowerCase();
        const txt = String(c.last_texto || '').toLowerCase();
        const people = (c.participantes || []).map(colabNameById).join(' ').toLowerCase();
        return name.includes(q) || txt.includes(q) || people.includes(q);
      });
    }

    arr.sort((a, b) => new Date(b.last_created_at || 0) - new Date(a.last_created_at || 0));
    return arr;
  }

  function filteredColabs() {
    const q = String(inpSearch?.value || '').trim().toLowerCase();
    let arr = [...COLABS.values()].filter((c) => Number(c.id) !== Number(ME_ID));

    if (CURRENT_FILTER === 'favorites') arr = arr.filter((c) => FAVORITES.has(Number(c.id)));

    if (q) {
      arr = arr.filter((c) => [c.nome, c.nome_completo, c.email, c.telefone, c.setor_nome, c.cargo]
        .join(' ')
        .toLowerCase()
        .includes(q));
    }

    arr.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
    return arr;
  }

  // ===== Render =====
  function renderTitle() {
    const [title, sub] = VIEW_META[CURRENT_VIEW] || VIEW_META.chats;
    if (conversationTitleEl) conversationTitleEl.textContent = title;
    if (conversationSubtitleEl) conversationSubtitleEl.textContent = sub;
    if (filterLabelEl) filterLabelEl.textContent = FILTERS[CURRENT_FILTER] || 'Filtrar';

    railLinks.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === CURRENT_VIEW);
    });

    if (totalConversasEl) totalConversasEl.textContent = String(dedupeDirectConversations([...CONVS.values()]).length || 0);
  }

  function renderAll() {
    renderTitle();
    renderRoster();
    if (CURRENT_VIEW === 'contacts') renderContacts();
    else renderConvs();
    if (ACTIVE) updatePeerHeader(CONVS.get(ACTIVE));
  }

  function emptyList(icon, title, text) {
    return `
      <li class="empty empty-list-row" aria-disabled="true">
        <i class="${esc(icon)}" aria-hidden="true"></i>
        <strong>${esc(title)}</strong>
        <span>${esc(text)}</span>
      </li>`;
  }

  function renderRoster() {
    if (!rosterListEl) return;

    const list = [...COLABS.values()]
      .filter((c) => Number(c.id) !== Number(ME_ID))
      .sort((a, b) => {
        const fa = FAVORITES.has(Number(a.id)) ? 0 : 1;
        const fb = FAVORITES.has(Number(b.id)) ? 0 : 1;
        if (fa !== fb) return fa - fb;
        return String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR');
      })
      .slice(0, 18);

    if (!list.length) {
      rosterListEl.innerHTML = '<div class="empty mini-empty"><span>Sem colaboradores ainda</span></div>';
      return;
    }

    rosterListEl.innerHTML = list.map((c) => `
      <button type="button" class="roster-item" data-colab-id="${Number(c.id)}" title="${esc(c.nome)} — ${esc(fmtPresence(c))}">
        <span class="avatar mini-avatar has-user-icon"><i class="fa-solid fa-user" aria-hidden="true"></i></span>
        <strong>${esc(c.nome)}</strong>
        <span class="roster-dot ${esc(normalizedPresenceStatus(c.presence_status))}" aria-label="${esc(fmtPresence(c))}"></span>
        ${FAVORITES.has(Number(c.id)) ? '<small><i class="fa-solid fa-star"></i></small>' : ''}
      </button>
    `).join('');
  }

  function renderConvs() {
    if (!listaEl) return;
    const arr = filteredConvs();

    if (!arr.length) {
      listaEl.innerHTML = emptyList(
        'fa-regular fa-comments',
        CONVS.size ? 'Nada encontrado' : 'Carregando conversas...',
        CONVS.size ? 'Tente outro filtro ou outra busca.' : 'A lista aparece assim que a API responder.'
      );
      return;
    }

    listaEl.innerHTML = arr.map((c) => {
      const selected = ACTIVE === c.thread_id;
      const name = getConvDisplayName(c);
      const unread = Number(c.unread_count || 0);
      const last = c.last_texto || (isGroupConv(c) ? 'Grupo criado' : 'Conversa iniciada');
      const fav = isFavoriteConv(c);
      const group = isGroupConv(c);

      return `
        <li class="conv" role="option" tabindex="0" aria-selected="${selected ? 'true' : 'false'}" data-thread-id="${esc(c.thread_id)}">
          <div class="avatar has-user-icon" aria-hidden="true">
            <i class="fa-solid ${group ? 'fa-user-group' : 'fa-user'}"></i>
          </div>
          <div class="conv-main">
            <div class="name">${esc(name)}${fav ? '<i class="fa-solid fa-star mini-star" aria-hidden="true"></i>' : ''}</div>
            <div class="last">${esc(last)}</div>
          </div>
          <div class="right">
            <span class="time">${esc(fmtTimeShort(c.last_created_at))}</span>
            ${unread > 0 ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}
          </div>
          <button type="button" class="conv-opts" data-thread-menu="${esc(c.thread_id)}" aria-label="Opções"><i class="fa-solid fa-ellipsis"></i></button>
        </li>`;
    }).join('');
  }

  function renderContacts() {
    if (!listaEl) return;
    const arr = filteredColabs();

    if (!arr.length) {
      listaEl.innerHTML = emptyList('fa-regular fa-address-book', 'Nenhum contato encontrado', 'Confira a busca ou cadastre colaboradores.');
      return;
    }

    listaEl.innerHTML = arr.map((c) => {
      const fav = FAVORITES.has(Number(c.id));
      return `
        <li class="conv contact-row" role="option" tabindex="0" data-colab-id="${Number(c.id)}">
          <div class="avatar has-user-icon" aria-hidden="true"><i class="fa-solid fa-user"></i></div>
          <div class="conv-main">
            <div class="name">${esc(c.nome)}${fav ? '<i class="fa-solid fa-star mini-star" aria-hidden="true"></i>' : ''}</div>
            <div class="last">${esc(c.cargo || c.setor_nome || c.email || 'Colaborador')}</div>
          </div>
          <div class="right">
            <button type="button" class="favorite-toggle ${fav ? 'active' : ''}" data-fav-id="${Number(c.id)}" title="Favorito" aria-label="Favorito"><i class="fa-solid fa-star"></i></button>
            <button type="button" class="contact-chat" data-start-chat="${Number(c.id)}" title="Conversar" aria-label="Conversar"><i class="fa-regular fa-comment-dots"></i></button>
          </div>
        </li>`;
    }).join('');
  }

  function renderMessagesLoading() {
    if (!msgsEl) return;
    msgsEl.innerHTML = `
      <div class="empty" id="emptyState">
        <i class="fa-regular fa-comments" aria-hidden="true"></i>
        <strong>Carregando mensagens...</strong>
        <span>Aguarde só um instante.</span>
      </div>`;
  }

  function renderEmptyChat() {
    if (!msgsEl) return;
    msgsEl.innerHTML = `
      <div class="empty" id="emptyState">
        <i class="fa-regular fa-comments" aria-hidden="true"></i>
        <strong>Selecione uma conversa</strong>
        <span>Escolha alguém na lista para iniciar o atendimento interno.</span>
      </div>`;
  }

  function renderMessages(threadId) {
    if (!msgsEl) return;
    const arr = MSGS.get(threadId) || [];

    if (!arr.length) {
      msgsEl.innerHTML = `
        <div class="empty" id="emptyState">
          <i class="fa-regular fa-comment-dots" aria-hidden="true"></i>
          <strong>Sem mensagens ainda</strong>
          <span>Envie a primeira mensagem dessa conversa.</span>
        </div>`;
      return;
    }

    msgsEl.innerHTML = arr.map(messageHtml).join('');
    scrollBottom();
  }

  function messageHtml(m) {
    const mine = ME_ID != null && Number(m.autor_id) === Number(ME_ID);
    const system = m.kind === 'system';
    const text = m.texto || m.titulo || '';

    if (system) {
      return `
        <div class="msg system" data-id="${Number(m.id) || ''}">
          <div class="bubble"><div class="text">${formatMentions(text)}</div><div class="meta">${esc(fmtTimeShort(m.created_at))}</div></div>
        </div>`;
    }

    return `
      <div class="msg ${mine ? 'me' : ''}" data-id="${Number(m.id) || ''}">
        <div class="bubble">
          <div class="text">${formatMentions(text)}</div>
          <div class="meta">${esc(fmtTimeShort(m.created_at))}</div>
        </div>
      </div>`;
  }

  function appendMessage(m) {
    if (!msgsEl) return;
    $('#emptyState')?.remove?.();
    const wrap = document.createElement('div');
    wrap.innerHTML = messageHtml(m).trim();
    msgsEl.appendChild(wrap.firstElementChild);
    scrollBottom();
  }

  function formatMentions(text) {
    return esc(text).replace(/(^|\s)(@[\wÀ-ÿ._-]+)/g, '$1<span class="mention-token">$2</span>');
  }

  function updatePeerHeader(c) {
    if (!c) {
      if (peerNameEl) peerNameEl.textContent = 'Selecionar conversa';
      if (peerStatusEl) {
        peerStatusEl.textContent = 'Escolha uma conversa para começar';
        peerStatusEl.title = '';
        delete peerStatusEl.dataset.presence;
      }
      setIconAvatar(peerAvatarEl, 'user');
      return;
    }

    const group = isGroupConv(c);
    if (peerNameEl) peerNameEl.textContent = getConvDisplayName(c);
    if (peerStatusEl) {
      if (group) {
        peerStatusEl.textContent = `${c.participantes.length} participantes`;
        peerStatusEl.title = 'Grupo interno';
        delete peerStatusEl.dataset.presence;
      } else {
        const peer = getPeerColab(c);
        peerStatusEl.textContent = fmtPresence(peer);
        peerStatusEl.dataset.presence = normalizedPresenceStatus(peer?.presence_status);
        peerStatusEl.title = peer?.cargo || peer?.setor_nome || 'Colaborador';
      }
    }
    setIconAvatar(peerAvatarEl, group ? 'group' : 'user');
  }

  function resetProfile() {
    if (profileNameEl) profileNameEl.textContent = 'Nenhuma conversa';
    if (profileRoleEl) profileRoleEl.textContent = 'Selecione um colaborador';
    if (profileLastAccessEl) {
      profileLastAccessEl.textContent = '';
      profileLastAccessEl.hidden = true;
      delete profileLastAccessEl.dataset.presence;
    }
    if (profilePhoneEl) profilePhoneEl.textContent = '—';
    if (profileEmailEl) profileEmailEl.textContent = '—';
    if (profileFullNameEl) profileFullNameEl.textContent = '—';
    if (profileLocationEl) profileLocationEl.textContent = '—';
    if (profileSinceEl) profileSinceEl.textContent = '—';
    if (profileWebsiteEl) profileWebsiteEl.textContent = '—';
    setIconAvatar(profileAvatarEl, 'user');
  }

  function updateProfile(c) {
    if (!c) return resetProfile();

    if (isGroupConv(c)) {
      if (profileNameEl) profileNameEl.textContent = getConvDisplayName(c);
      if (profileRoleEl) profileRoleEl.textContent = `${c.participantes.length} participantes`;
      if (profileLastAccessEl) {
        profileLastAccessEl.textContent = '';
        profileLastAccessEl.hidden = true;
      }
      if (profilePhoneEl) profilePhoneEl.textContent = '—';
      if (profileEmailEl) profileEmailEl.textContent = '—';
      if (profileFullNameEl) profileFullNameEl.textContent = c.participantes.map(colabNameById).join(', ');
      if (profileLocationEl) profileLocationEl.textContent = 'Grupo';
      if (profileSinceEl) profileSinceEl.textContent = '—';
      if (profileWebsiteEl) profileWebsiteEl.textContent = '—';
      setIconAvatar(profileAvatarEl, 'group');
      return;
    }

    const peer = getPeerColab(c);
    if (!peer) return resetProfile();

    if (profileNameEl) profileNameEl.textContent = peer.nome || 'Colaborador';
    if (profileRoleEl) profileRoleEl.textContent = peer.cargo || peer.setor_nome || 'Colaborador';
    if (profileLastAccessEl) {
      profileLastAccessEl.textContent = fmtPresence(peer);
      profileLastAccessEl.dataset.presence = normalizedPresenceStatus(peer?.presence_status);
      profileLastAccessEl.hidden = false;
    }
    if (profilePhoneEl) profilePhoneEl.textContent = peer.telefone || '—';
    if (profileEmailEl) profileEmailEl.textContent = peer.email || '—';
    if (profileFullNameEl) profileFullNameEl.textContent = peer.nome_completo || peer.nome || '—';
    if (profileLocationEl) profileLocationEl.textContent = peer.setor_nome || '—';
    if (profileSinceEl) profileSinceEl.textContent = fmtSince(peer.created_at);
    if (profileWebsiteEl) profileWebsiteEl.textContent = '—';
    setIconAvatar(profileAvatarEl, 'user');
  }

  // ===== API load =====
  function loadCacheFast() {
    cacheGet(rosterCacheKeys()).map(normColab).forEach((c) => {
      if (c.id) COLABS.set(Number(c.id), c);
    });

    cacheGet(convsCacheKeys()).map(normConv).forEach((c) => {
      if (c.thread_id) CONVS.set(c.thread_id, c);
    });

    compactConversationsMap();
    renderAll();
  }

  async function loadMe() {
    const me = await api(`${API}/me`);
    EMPRESA_ID = Number(me.empresa_id || EMPRESA_ID || 0) || null;
    ME_ID = Number(me.colab_id || ME_ID || 0) || null;

    if (EMPRESA_ID) {
      localStorage.setItem('empresa_id', String(EMPRESA_ID));
      localStorage.setItem('internal_chat_empresa_id', String(EMPRESA_ID));
    }
    if (ME_ID) localStorage.setItem('internal_chat_me_id', String(ME_ID));

    return me;
  }

  async function loadRoster() {
    const rows = await api(`${API}/roster`);
    COLABS.clear();
    (Array.isArray(rows) ? rows : []).map(normColab).forEach((c) => {
      if (c.id) COLABS.set(Number(c.id), c);
    });
    cacheSet(rosterCacheKeys(), [...COLABS.values()]);
    renderAll();
  }

  async function loadConversations(q = '') {
    const url = new URL(`${API}/conversations`, window.location.origin);
    url.searchParams.set('limit', '100');
    if (q) url.searchParams.set('q', q);

    const rows = await api(url.pathname + url.search);
    CONVS.clear();
    (Array.isArray(rows) ? rows : []).map(normConv).forEach((c) => {
      if (c.thread_id) CONVS.set(c.thread_id, c);
    });
    compactConversationsMap();
    cacheSet(convsCacheKeys(), [...CONVS.values()]);
    renderAll();
  }

  async function loadMessages(threadId) {
    renderMessagesLoading();
    const rows = await api(`${API}/conversations/${encodeURIComponent(threadId)}/messages?limit=80`);
    const arr = (Array.isArray(rows) ? rows : [])
      .map((m) => ({
        id: m.id,
        kind: m.kind || 'msg',
        autor_id: Number(m.autor_id || 0),
        texto: m.texto || '',
        titulo: m.titulo || '',
        created_at: m.created_at || null
      }))
      .reverse();

    MSGS.set(threadId, arr);
    renderMessages(threadId);
    await markAsRead(threadId, false);
  }

  async function refreshAll() {
    renderAll();

    let meOk = false;
    try {
      await loadMe();
      meOk = true;
      renderAll();
      openWS();
    } catch (e) {
      toast(`Não consegui identificar o usuário: ${e.message}`, 'err');
    }

    await Promise.allSettled([
      loadRoster().catch((e) => toast(`Erro ao carregar contatos: ${e.message}`, 'err')),
      loadConversations().catch((e) => toast(`Erro ao carregar conversas: ${e.message}`, 'err'))
    ]);

    if (meOk) renderAll();
  }

  // ===== Actions =====
  async function openConversation(threadId) {
    const c = CONVS.get(threadId);
    if (!c) return;

    ACTIVE = threadId;
    setPane('chat');

    c.unread_count = 0;
    CONVS.set(threadId, c);
    updatePeerHeader(c);
    updateProfile(c);
    renderConvs();

    if (MSGS.has(threadId)) renderMessages(threadId);

    try {
      await loadMessages(threadId);
    } catch (e) {
      toast(`Erro ao carregar mensagens: ${e.message}`, 'err');
      renderMessages(threadId);
    }
  }

  async function markAsRead(threadId, redraw = true) {
    if (!threadId) return;
    try { await api(`${API}/conversations/${encodeURIComponent(threadId)}/read`, { method: 'POST' }); } catch {}
    const c = CONVS.get(threadId);
    if (c) {
      c.unread_count = 0;
      CONVS.set(threadId, c);
      if (redraw) renderConvs();
    }
  }

  async function sendCurrentMessage() {
    const text = String(txtMsg?.value || '').trim();
    if (!text) return;

    if (!ACTIVE) {
      toast('Selecione uma conversa primeiro.', 'warn');
      return;
    }

    if (txtMsg) {
      txtMsg.value = '';
      autoGrowTextarea();
    }

    const optimistic = {
      id: Date.now(),
      kind: 'msg',
      autor_id: ME_ID,
      texto: text,
      created_at: new Date().toISOString(),
      optimistic: true
    };

    const arr = MSGS.get(ACTIVE) || [];
    arr.push(optimistic);
    MSGS.set(ACTIVE, arr);
    appendMessage(optimistic);

    const c = CONVS.get(ACTIVE);
    if (c) {
      c.last_texto = text;
      c.last_created_at = optimistic.created_at;
      CONVS.set(ACTIVE, c);
      renderConvs();
    }

    try {
      const saved = await api(`${API}/conversations/${encodeURIComponent(ACTIVE)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ texto: text })
      });

      optimistic.id = saved.id || optimistic.id;
      optimistic.created_at = saved.created_at || optimistic.created_at;
      optimistic.optimistic = false;
      renderMessages(ACTIVE);
    } catch (e) {
      toast(`Erro ao enviar: ${e.message}`, 'err');
    }
  }

  async function startDirectChat(colabId) {
    const id = Number(colabId);
    if (!id) return;

    compactConversationsMap();

    const existing = findBestDirectConversation(id);
    if (existing) {
      await openConversation(existing.thread_id);
      return;
    }

    try {
      const row = await api(`${API}/conversations`, {
        method: 'POST',
        body: JSON.stringify({ titulo: 'Conversa', participantes: [id] })
      });

      const c = normConv({ ...row, last_texto: '', last_created_at: new Date().toISOString(), unread_count: 0 });
      CONVS.set(c.thread_id, c);
      compactConversationsMap();
      cacheSet(convsCacheKeys(), [...CONVS.values()]);
      renderAll();
      await openConversation(c.thread_id);
      toast('Conversa criada.', 'ok');
    } catch (e) {
      toast(`Não consegui criar conversa: ${e.message}`, 'err');
    }
  }

  async function createGroup(title, selectedIds) {
    const ids = selectedIds.map(Number).filter(Boolean);
    if (ids.length < 2) {
      toast('Escolha pelo menos 2 pessoas para criar grupo.', 'warn');
      return;
    }

    try {
      const row = await api(`${API}/conversations`, {
        method: 'POST',
        body: JSON.stringify({ titulo: title || 'Grupo', participantes: ids })
      });

      const c = normConv({ ...row, last_texto: 'Grupo criado', last_created_at: new Date().toISOString(), unread_count: 0 });
      CONVS.set(c.thread_id, c);
      cacheSet(convsCacheKeys(), [...CONVS.values()]);
      closeModal();
      CURRENT_VIEW = 'groups';
      localStorage.setItem('internal_chat_view', CURRENT_VIEW);
      renderAll();
      await openConversation(c.thread_id);
      toast('Grupo criado.', 'ok');
    } catch (e) {
      toast(`Erro ao criar grupo: ${e.message}`, 'err');
    }
  }

  function toggleFavorite(colabId) {
    const id = Number(colabId);
    if (!id) return;
    if (FAVORITES.has(id)) FAVORITES.delete(id);
    else FAVORITES.add(id);
    saveFavorites();
    renderAll();
  }

  // ===== Menus / Modals =====
  function closeModal() {
    $$('.modal-overlay').forEach((el) => el.remove());
  }

  function openNewChatModal(mode = 'direct') {
    const isGroup = mode === 'group';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const colabs = [...COLABS.values()]
      .filter((c) => Number(c.id) !== Number(ME_ID))
      .sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));

    overlay.innerHTML = `
      <section class="modal chat-create-modal" role="dialog" aria-modal="true" aria-label="${isGroup ? 'Criar grupo' : 'Nova conversa'}">
        <header>${isGroup ? 'Criar grupo' : 'Nova conversa'}</header>
        <div class="content">
          ${isGroup ? `
            <p class="modal-help">Dê um nome para o grupo e selecione os colaboradores.</p>
            <label class="modal-label" for="groupTitleInput">Nome do grupo</label>
            <input id="groupTitleInput" type="text" placeholder="Ex: Equipe técnica" maxlength="80" autocomplete="off"/>` : `
            <p class="modal-help">Escolha um colaborador para iniciar uma conversa.</p>`}

          <label class="modal-label" for="modalSearchColab">Colaboradores</label>
          <input id="modalSearchColab" class="modal-search" type="search" placeholder="Buscar colaborador..." autocomplete="off"/>
          <div class="selected-counter" id="selectedCounter">0 selecionados</div>
          <div class="modal-colab-list" id="modalColabList">
            ${colabs.length ? colabs.map((c) => modalColabItem(c, isGroup)).join('') : '<div class="modal-empty">Nenhum colaborador encontrado.</div>'}
          </div>
        </div>
        <footer>
          <button type="button" class="btn ghost" data-close-modal>Cancelar</button>
          <button type="button" class="btn primary" id="modalCreateBtn">${isGroup ? 'Criar grupo' : 'Iniciar conversa'}</button>
        </footer>
      </section>`;

    document.body.appendChild(overlay);

    const search = $('#modalSearchColab', overlay);
    const list = $('#modalColabList', overlay);
    const counter = $('#selectedCounter', overlay);
    const create = $('#modalCreateBtn', overlay);

    const updateCounter = () => {
      const checked = $$('input[data-modal-colab]:checked', overlay).length;
      if (counter) counter.textContent = `${checked} selecionado${checked === 1 ? '' : 's'}`;
    };

    search?.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      const rows = colabs.filter((c) => [c.nome, c.nome_completo, c.email, c.setor_nome, c.cargo].join(' ').toLowerCase().includes(q));
      list.innerHTML = rows.length ? rows.map((c) => modalColabItem(c, isGroup)).join('') : '<div class="modal-empty">Nenhum colaborador encontrado.</div>';
      updateCounter();
    });

    overlay.addEventListener('change', (ev) => {
      if (!ev.target.matches('input[data-modal-colab]')) return;
      if (!isGroup && ev.target.checked) {
        $$('input[data-modal-colab]', overlay).forEach((i) => {
          if (i !== ev.target) i.checked = false;
        });
      }
      updateCounter();
    });

    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay || ev.target.closest('[data-close-modal]')) closeModal();
    });

    create?.addEventListener('click', async () => {
      const ids = $$('input[data-modal-colab]:checked', overlay).map((i) => Number(i.value)).filter(Boolean);
      if (isGroup) {
        const title = String($('#groupTitleInput', overlay)?.value || '').trim();
        await createGroup(title, ids);
      } else {
        if (!ids[0]) return toast('Escolha um colaborador.', 'warn');
        closeModal();
        await startDirectChat(ids[0]);
      }
    });

    setTimeout(() => search?.focus(), 40);
  }

  function modalColabItem(c, checkbox = true) {
    return `
      <label class="modal-colab-item">
        <input type="${checkbox ? 'checkbox' : 'radio'}" name="modal_colab" data-modal-colab value="${Number(c.id)}"/>
        <span class="avatar modal-avatar has-user-icon"><i class="fa-solid fa-user" aria-hidden="true"></i></span>
        <span class="modal-colab-main">
          <strong>${esc(c.nome)}</strong>
          <small>${esc(c.cargo || c.setor_nome || c.email || 'Colaborador')}</small>
        </span>
      </label>`;
  }

  function closeFilterMenu() {
    filterMenu?.remove();
    filterMenu = null;
  }

  function toggleFilterMenu() {
    if (filterMenu) return closeFilterMenu();
    if (!btnFilter) return;

    const rect = btnFilter.getBoundingClientRect();
    filterMenu = document.createElement('div');
    filterMenu.className = 'filter-menu';
    filterMenu.innerHTML = Object.entries(FILTERS).map(([key, label]) => `
      <button type="button" data-filter="${key}" class="${CURRENT_FILTER === key ? 'active' : ''}">
        <i class="fa-solid fa-check"></i><span>${esc(label)}</span>
      </button>
    `).join('');

    document.body.appendChild(filterMenu);
    const left = Math.min(window.innerWidth - filterMenu.offsetWidth - 10, rect.right - filterMenu.offsetWidth);
    filterMenu.style.left = `${Math.max(10, left)}px`;
    filterMenu.style.top = `${rect.bottom + 8}px`;

    filterMenu.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-filter]');
      if (!btn) return;
      CURRENT_FILTER = btn.dataset.filter || 'all';
      localStorage.setItem('internal_chat_filter', CURRENT_FILTER);
      closeFilterMenu();
      renderAll();
    });
  }

  function closeMentionMenu() {
    mentionMenu?.remove();
    mentionMenu = null;
  }

  function openMentionMenu() {
    closeMentionMenu();
    if (!txtMsg) return;

    const list = [...COLABS.values()].filter((c) => Number(c.id) !== Number(ME_ID)).slice(0, 12);
    mentionMenu = document.createElement('div');
    mentionMenu.className = 'mention-menu';
    mentionMenu.innerHTML = `
      <button type="button" data-mention="todos">
        <span class="avatar mention-avatar has-user-icon"><i class="fa-solid fa-users"></i></span>
        <span><strong>@todos</strong><small>Mencionar todo mundo do grupo</small></span>
      </button>
      ${list.map((c) => `
        <button type="button" data-mention="${esc(c.nome.replace(/\s+/g, ''))}">
          <span class="avatar mention-avatar has-user-icon"><i class="fa-solid fa-user"></i></span>
          <span><strong>${esc(c.nome)}</strong><small>${esc(c.setor_nome || c.cargo || c.email || '')}</small></span>
        </button>`).join('')}`;

    document.body.appendChild(mentionMenu);
    const rect = txtMsg.getBoundingClientRect();
    mentionMenu.style.left = `${Math.max(10, rect.left)}px`;
    mentionMenu.style.top = `${Math.max(10, rect.top - mentionMenu.offsetHeight - 8)}px`;

    mentionMenu.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-mention]');
      if (!btn) return;
      insertAtCursor(txtMsg, '@' + btn.dataset.mention + ' ');
      closeMentionMenu();
      txtMsg.focus();
      autoGrowTextarea();
    });
  }

  function insertAtCursor(input, text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const pos = start + text.length;
    input.setSelectionRange(pos, pos);
  }

  // ===== WebSocket =====
  // O Chat Interno usa o mesmo ws-core das demais telas. Assim, mensagens,
  // notificações e presença compartilham uma única conexão da empresa.
  function wsUrl() {
    if (!EMPRESA_ID) return null;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}${API}/ws/${EMPRESA_ID}`;
  }

  function openLegacyWS() {
    const url = wsUrl();
    if (!url) return;

    try { ws?.close(); } catch {}
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      wsTries = 0;
      clearInterval(wsPing);
      wsPing = setInterval(() => {
        try { if (ws?.readyState === 1) ws.send('ping'); } catch {}
      }, 25000);
    });

    ws.addEventListener('message', (ev) => {
      let data = null;
      try { data = JSON.parse(ev.data); } catch { return; }
      handleWS(data);
    });

    ws.addEventListener('close', () => {
      clearInterval(wsPing);
      wsPing = null;
      const delay = Math.min(30000, 1000 * Math.pow(2, wsTries++)) + Math.floor(Math.random() * 500);
      setTimeout(openLegacyWS, delay);
    });

    ws.addEventListener('error', () => {
      try { ws?.close(); } catch {}
    });
  }

  async function openWS() {
    if (!EMPRESA_ID || offCompanyWS) return;

    try {
      const core = await import('/frontend/js/realtime/ws-core.js?v=chat-presence-20260725-1');
      core.ensureEmpresaWS(EMPRESA_ID, { presenceSnapshot: true });
      offCompanyWS = core.onEmpresaMessage(EMPRESA_ID, (evt) => {
        if (evt?.type === 'message') handleWS(evt.data);
      });
    } catch (err) {
      console.warn('[chat-interno] ws-core indisponível; usando conexão compatível.', err);
      openLegacyWS();
    }
  }

  function handleWS(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ZAPSCHAT_PRESENCE') {
      applyPresenceItem(msg);
      return;
    }

    if (msg.type === 'ZAPSCHAT_PRESENCE_SNAPSHOT') {
      applyPresenceSnapshot(msg.items || []);
      return;
    }

    if (msg.type === 'thread.created') {
      const c = normConv({
        thread_id: msg.thread_id,
        titulo: msg.titulo || 'Conversa',
        participantes: msg.participantes || [],
        last_texto: '',
        last_created_at: new Date().toISOString(),
        unread_count: 0
      });
      CONVS.set(c.thread_id, c);
      cacheSet(convsCacheKeys(), [...CONVS.values()]);
      renderAll();
      return;
    }

    if (msg.type === 'thread.renamed') {
      const c = CONVS.get(msg.thread_id);
      if (c) {
        c.titulo = msg.titulo || c.titulo;
        CONVS.set(c.thread_id, c);
        renderAll();
      }
      return;
    }

    if (msg.type === 'participants.updated') {
      const c = CONVS.get(msg.thread_id);
      if (c) {
        c.participantes = (msg.participantes || []).map(Number).filter(Boolean);
        CONVS.set(c.thread_id, c);
      }
      renderAll();
      return;
    }

    if (msg.type === 'message.created') {
      const m = {
        id: msg.id,
        kind: 'msg',
        autor_id: Number(msg.autor_id || 0),
        texto: msg.texto || '',
        created_at: msg.created_at || new Date().toISOString()
      };

      const arr = MSGS.get(msg.thread_id) || [];
      if (!arr.some((x) => Number(x.id) === Number(m.id))) {
        arr.push(m);
        MSGS.set(msg.thread_id, arr);
        if (ACTIVE === msg.thread_id) {
          appendMessage(m);
          markAsRead(msg.thread_id, false);
        }
      }

      const c = CONVS.get(msg.thread_id) || normConv({
        thread_id: msg.thread_id,
        titulo: 'Conversa',
        participantes: [],
        unread_count: 0
      });
      c.last_texto = m.texto;
      c.last_created_at = m.created_at;
      if (ACTIVE !== msg.thread_id && Number(m.autor_id) !== Number(ME_ID)) {
        c.unread_count = Number(c.unread_count || 0) + 1;
      }
      CONVS.set(msg.thread_id, c);
      renderAll();
    }
  }

  // ===== Events =====
  function autoGrowTextarea() {
    if (!txtMsg) return;
    txtMsg.style.height = 'auto';
    txtMsg.style.height = `${Math.min(140, Math.max(40, txtMsg.scrollHeight))}px`;
  }

  function bindEvents() {
    listaEl?.addEventListener('click', async (ev) => {
      const menuBtn = ev.target.closest('[data-thread-menu]');
      if (menuBtn) {
        ev.stopPropagation();
        return showThreadMenu(menuBtn.dataset.threadMenu, menuBtn);
      }

      const favBtn = ev.target.closest('[data-fav-id]');
      if (favBtn) {
        ev.stopPropagation();
        toggleFavorite(favBtn.dataset.favId);
        return;
      }

      const startBtn = ev.target.closest('[data-start-chat]');
      if (startBtn) {
        ev.stopPropagation();
        await startDirectChat(startBtn.dataset.startChat);
        return;
      }

      const contactRow = ev.target.closest('[data-colab-id]');
      if (contactRow && CURRENT_VIEW === 'contacts') {
        await startDirectChat(contactRow.dataset.colabId);
        return;
      }

      const conv = ev.target.closest('[data-thread-id]');
      if (conv) await openConversation(conv.dataset.threadId);
    });

    listaEl?.addEventListener('keydown', async (ev) => {
      if (ev.key !== 'Enter') return;
      const conv = ev.target.closest('[data-thread-id]');
      const contact = ev.target.closest('[data-colab-id]');
      if (conv) await openConversation(conv.dataset.threadId);
      else if (contact) await startDirectChat(contact.dataset.colabId);
    });

    rosterListEl?.addEventListener('click', async (ev) => {
      const item = ev.target.closest('[data-colab-id]');
      if (item) await startDirectChat(item.dataset.colabId);
    });

    railLinks.forEach((btn) => {
      btn.addEventListener('click', () => {
        CURRENT_VIEW = btn.dataset.view || 'chats';
        localStorage.setItem('internal_chat_view', CURRENT_VIEW);
        renderAll();
      });
    });

    inpSearch?.addEventListener('input', debounce(() => renderAll(), 120));
    btnSend?.addEventListener('click', sendCurrentMessage);
    txtMsg?.addEventListener('input', autoGrowTextarea);
    txtMsg?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        sendCurrentMessage();
      }
    });

    btnBackList?.addEventListener('click', () => setPane('list'));
    btnNewChannel?.addEventListener('click', () => openNewChatModal('direct'));
    btnCreateGroup?.addEventListener('click', () => openNewChatModal('group'));
    btnFilter?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleFilterMenu();
    });
    btnMention?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openMentionMenu();
    });
    btnAttach?.addEventListener('click', () => toast('Anexos ainda não estão ativos neste chat.', 'warn'));

    btnInfoProfile?.addEventListener('click', () => {
      if (ACTIVE) updateProfile(CONVS.get(ACTIVE));
      document.body.classList.add('profile-open');
    });
    btnToggleProfile?.addEventListener?.('click', () => document.body.classList.toggle('profile-open'));
    btnCloseProfile?.addEventListener('click', () => document.body.classList.remove('profile-open'));
    $('.peer')?.addEventListener('click', () => {
      if (ACTIVE) updateProfile(CONVS.get(ACTIVE));
      document.body.classList.add('profile-open');
    });

    document.addEventListener('click', (ev) => {
      if (filterMenu && !ev.target.closest('.filter-menu') && !ev.target.closest('#btnFilter')) closeFilterMenu();
      if (mentionMenu && !ev.target.closest('.mention-menu') && !ev.target.closest('#btnMention')) closeMentionMenu();
      if (!ev.target.closest('.ctx-menu') && !ev.target.closest('[data-thread-menu]')) closeThreadMenus();
    });

    window.addEventListener('resize', () => {
      closeFilterMenu();
      closeMentionMenu();
      closeThreadMenus();
    });
  }

  function closeThreadMenus() {
    $$('.ctx-menu').forEach((el) => el.remove());
  }

  function showThreadMenu(threadId, anchor) {
    closeThreadMenus();
    const c = CONVS.get(threadId);
    if (!c) return;

    const peerId = getOtherParticipantId(c);
    const fav = peerId && FAVORITES.has(Number(peerId));
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.innerHTML = `
      ${peerId ? `<button type="button" data-action="fav"><i class="fa-solid fa-star"></i>${fav ? 'Remover favorito' : 'Favoritar'}</button>` : ''}
      <button type="button" data-action="profile"><i class="fa-regular fa-address-card"></i>Ver perfil</button>
      ${isGroupConv(c) ? '<button type="button" data-action="rename"><i class="fa-solid fa-pen"></i>Renomear grupo</button>' : ''}
    `;
    document.body.appendChild(menu);

    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.min(window.innerWidth - menu.offsetWidth - 10, rect.right - menu.offsetWidth)}px`;
    menu.style.top = `${rect.bottom + 6}px`;

    menu.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      closeThreadMenus();

      if (action === 'fav' && peerId) toggleFavorite(peerId);
      if (action === 'profile') {
        ACTIVE = threadId;
        updateProfile(c);
        document.body.classList.add('profile-open');
      }
      if (action === 'rename') {
        const title = prompt('Novo nome do grupo:', getConvDisplayName(c));
        if (!title || !title.trim()) return;
        try {
          await api(`${API}/conversations/${encodeURIComponent(threadId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ titulo: title.trim() })
          });
          c.titulo = title.trim();
          CONVS.set(threadId, c);
          renderAll();
          toast('Grupo renomeado.', 'ok');
        } catch (e) {
          toast(`Erro ao renomear: ${e.message}`, 'err');
        }
      }
    });
  }

  // ===== Start =====
  function init() {
    unhideFast();
    setIconAvatar(peerAvatarEl, 'user');
    setIconAvatar(profileAvatarEl, 'user');
    resetProfile();
    bindEvents();
    loadCacheFast();
    refreshAll();
    setTimeout(unhideFast, 300);
    setTimeout(unhideFast, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
