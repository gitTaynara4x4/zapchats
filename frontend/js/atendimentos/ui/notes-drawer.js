// /frontend/js/atendimentos/ui/notes-drawer.js
// Drawer "Notas" + botão no header (#btn-sobre).
// - Lê/salva nota por cliente no BD (campo Cliente.sobre_cliente)
// - Faz GET /api/atendimento/clientes/{cliente_id}/profile
// - Faz PATCH /api/atendimento/clientes/{cliente_id}/profile
// - Mostra mensagem de sucesso/erro pro usuário
// ✅ Sem CSS inline no JS
// ✅ Alinhado com conversation_key canônica:
//    c:<cliente_id>:<instancia_id> e g:<grupo_id>:<instancia_id>
// ✅ LocalStorage por conversation_key para não misturar instâncias
// ✅ Backend só é chamado para contato individual (kind = c)

import { getClientPermissions } from '../core/client-permissions.js';

(function () {
  if (window.__zcNotesLoaded) return;
  window.__zcNotesLoaded = true;

  /* ---------- tema + ícone ---------- */
  function getTheme() {
    try {
      const t = document.documentElement.getAttribute('data-theme');
      if (t) return t;
    } catch {}
    try {
      return (matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    } catch {}
    return 'dark';
  }

  function iconSvg(theme) {
    const fill = theme === 'light' ? '#080808' : '#ffffff';
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="${fill}" viewBox="0 0 256 256" aria-hidden="true">
        <path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H156.69A15.92,15.92,0,0,0,168,219.31L219.31,168A15.92,15.92,0,0,0,224,156.69V48A16,16,0,0,0,208,32ZM96,88h64a8,8,0,0,1,0,16H96a8,8,0,0,1,0-16Zm32,80H96a8,8,0,0,1,0-16h32a8,8,0,0,1,0,16ZM96,136a8,8,0,0,1,0-16h64a8,8,0,0,1,0,16Zm64,68.69V160h44.7Z"></path>
      </svg>
    `;
  }

  /* ---------- helpers de conversa ---------- */
  function idKey(v) {
    const s = String(v ?? '').trim();
    if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
    return s;
  }

  function isNotesAbortLike(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    const msg = String(err.message || err.reason || err || '').toLowerCase();
    return msg.includes('atendimento-fetch-timeout') || msg.includes('abortado');
  }

  function instKey(v) {
    const s = String(v ?? '').trim();
    if (!s) return null;
    if (['null', 'undefined', 'nan', '0', 'all', '*', '-'].includes(s.toLowerCase())) return null;
    return s;
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
      instId: instKey(m[3]),
    };
  }

  function buildConversationKey(kind, entityId, instId) {
    const k = String(kind || '').toLowerCase() === 'g' ? 'g' : 'c';
    const eid = idKey(entityId);
    const iid = instKey(instId);
    if (!eid) return null;
    return `${k}:${eid}:${iid ?? '0'}`;
  }

  function kindFromObject(obj) {
    if (!obj || typeof obj !== 'object') return 'c';

    const explicit =
      obj.kind ??
      obj.conversation_kind ??
      obj.tipo_conversa ??
      null;

    const e = String(explicit || '').trim().toLowerCase();
    if (e === 'g' || e === 'grupo' || e === 'group') return 'g';
    if (e === 'c' || e === 'cliente' || e === 'contato') return 'c';

    if (obj.is_group === true || obj.grupo === true || obj.isGroup === true || obj.grupo_id != null) {
      return 'g';
    }

    return 'c';
  }

  function entityIdFromAny(raw, row = null) {
    const parsed = parseConversationKey(raw);
    if (parsed?.entityId) return parsed.entityId;

    if (row && typeof row === 'object') {
      const direct =
        row.entity_id ??
        row.backend_id ??
        row.api_id ??
        (kindFromObject(row) === 'g' ? row.grupo_id : row.cliente_id) ??
        row.id_backend ??
        null;

      const d = idKey(direct);
      if (d && /^\d+$/.test(d)) return d;
    }

    const s = idKey(raw);
    if (s && /^\d+$/.test(s)) return s;

    return null;
  }

  function instIdFromAny(raw, row = null) {
    const parsed = parseConversationKey(raw);
    if (parsed?.instId) return parsed.instId;

    if (row && typeof row === 'object') {
      return (
        instKey(row.instancia_id) ||
        instKey(row.instancia) ||
        instKey(row.instance_name) ||
        instKey(row.instance) ||
        null
      );
    }

    return null;
  }

  function conversationRefOf(raw, row = null) {
    if (raw && typeof raw === 'object') {
      const obj = raw;

      const fromStoreHelper = typeof window.getConversationKey === 'function'
        ? window.getConversationKey(
            obj.conversation_key ?? obj.conversation_id ?? obj.id ?? obj.cliente_id ?? obj.grupo_id ?? null,
            obj,
            obj.instancia_id ?? obj.instancia ?? obj.instance_name ?? null
          )
        : null;

      const parsedStore = parseConversationKey(fromStoreHelper);
      if (parsedStore) return parsedStore;

      const directRaw =
        obj.conversation_key ??
        obj.conversation_id ??
        obj.id ??
        null;

      const parsedDirect = parseConversationKey(directRaw);
      if (parsedDirect) return parsedDirect;

      const kind = kindFromObject(obj);
      const entityId = entityIdFromAny(directRaw, obj);
      const instId = instIdFromAny(directRaw, obj);

      const built = buildConversationKey(kind, entityId, instId) || idKey(directRaw);
      const parsedBuilt = parseConversationKey(built);

      return parsedBuilt || {
        key: built,
        kind,
        entityId,
        instId,
      };
    }

    const fromStoreHelper = typeof window.getConversationKey === 'function'
      ? window.getConversationKey(raw, row || null, row?.instancia_id ?? row?.instancia ?? null)
      : null;

    const parsedStore = parseConversationKey(fromStoreHelper);
    if (parsedStore) return parsedStore;

    const parsed = parseConversationKey(raw);
    if (parsed) return parsed;

    const kind = row && typeof row === 'object' ? kindFromObject(row) : 'c';
    const entityId = entityIdFromAny(raw, row);
    const instId = instIdFromAny(raw, row);

    const built = buildConversationKey(kind, entityId, instId) || idKey(raw);

    return parseConversationKey(built) || {
      key: built,
      kind,
      entityId,
      instId,
    };
  }

  function getSelectedConversationRef() {
    const hist = document.getElementById('historico');
    const hdr = document.getElementById('chat-header');
    const row = window.state?.clienteSel || window.clienteSel || null;

    const raw =
      idKey(hist?.dataset?.conversationKey) ||
      idKey(hist?.dataset?.clienteId) ||
      idKey(hdr?.dataset?.conversationKey) ||
      idKey(row?.conversation_key) ||
      idKey(row?.conversation_id) ||
      idKey(row?.id) ||
      null;

    return conversationRefOf(raw, row);
  }

  /* ---------- contexto ---------- */
  function getEmpresaId() {
    try {
      const raw = window.localStorage.getItem('empresa_id') || window.EMPRESA_ID || null;
      const n = Number(raw || 0);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  function getCtx() {
    const ref = getSelectedConversationRef();
    return {
      empresaId: getEmpresaId(),
      conversationKey: ref?.key || null,
      clienteId: ref?.kind === 'c' ? (ref?.entityId || null) : null,
      kind: ref?.kind || 'c',
      instanciaId: ref?.instId || null,
    };
  }

  function makeKey(ctx) {
    const emp = ctx?.empresaId != null ? String(ctx.empresaId) : 'noEmp';
    const conv = idKey(ctx?.conversationKey) || 'noConv';
    return `zcNotes:${emp}:conv:${conv}`;
  }

  function loadFromStorage(ctx) {
    try {
      return window.localStorage.getItem(makeKey(ctx)) || '';
    } catch {
      return '';
    }
  }

  function saveToStorage(ctx, txt) {
    try {
      window.localStorage.setItem(makeKey(ctx), txt || '');
      return true;
    } catch {
      return false;
    }
  }

  /* ---------- fetch autenticado ---------- */
  function authFetchJson(url, opt = {}) {
    const baseFetch =
      (window.ZAuth && typeof window.ZAuth.authFetch === 'function')
        ? window.ZAuth.authFetch.bind(window.ZAuth)
        : window.fetch.bind(window);

    const headers = Object.assign(
      { Accept: 'application/json', 'Content-Type': 'application/json' },
      opt.headers || {}
    );

    return baseFetch(url, Object.assign({}, opt, { headers }));
  }

  function permissionToast(message) {
    const toast = window.ZCHeaderActions?.toast;

    if (typeof toast === 'function') {
      toast({
        title: 'Sem permissão',
        msg: message,
        type: 'error',
      });
      return;
    }

    console.warn('[NOTES][PERMISSION]', message);
  }

  /* ---------- status ---------- */
  let statusTimeout = null;
  let hideTimeout = null;

  function getStatusEl() {
    return document.getElementById('zcNotesStatus');
  }

  function ensureStatusEl() {
    let el = getStatusEl();
    if (el) return el;

    const body = document.querySelector('.zcNotes-body');
    if (!body) return null;

    el = document.createElement('div');
    el.id = 'zcNotesStatus';
    el.className = 'zcNotes-status';
    el.setAttribute('aria-live', 'polite');

    const actions = body.querySelector('.zcNotes-actions');
    body.insertBefore(el, actions || body.firstChild);
    return el;
  }

  function clearStatusTimers() {
    if (statusTimeout) {
      clearTimeout(statusTimeout);
      statusTimeout = null;
    }
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  }

  function clearStatus() {
    const el = getStatusEl();
    clearStatusTimers();
    if (!el) return;

    el.textContent = '';
    el.classList.remove('ok', 'err', 'is-visible', 'is-hiding');
  }

  function showStatus(msg, kind) {
    const el = ensureStatusEl();
    if (!el) return;

    clearStatusTimers();

    el.textContent = msg || '';
    el.classList.remove('ok', 'err', 'is-hiding');

    if (kind === 'ok') el.classList.add('ok');
    if (kind === 'err') el.classList.add('err');

    el.classList.add('is-visible');

    statusTimeout = setTimeout(() => {
      el.classList.add('is-hiding');

      hideTimeout = setTimeout(() => {
        el.classList.remove('is-visible', 'is-hiding');
        if (el.textContent === msg) {
          el.textContent = '';
          el.classList.remove('ok', 'err');
        }
      }, 280);
    }, 2600);
  }

  /* ---------- BD: carregar ---------- */
  async function loadFromBackend(ctx) {
    if (!ctx || !ctx.clienteId || ctx.kind !== 'c') return;

    const perms = await getClientPermissions();
    if (!perms.view) return;

    const expectedKey = makeKey(ctx);

    try {
      const params = new URLSearchParams();
      params.set('empresa_id', String(ctx.empresaId || ''));
      if (ctx.instanciaId) params.set('instancia_id', String(ctx.instanciaId));

      const res = await authFetchJson(
        `/api/atendimento/clientes/${encodeURIComponent(ctx.clienteId)}/profile?${params.toString()}`,
        { method: 'GET' }
      );

      if (!res.ok) return;

      const data = await res.json().catch(() => null);
      const note = data && (data.sobre_cliente || data.sobreCliente || '');

      const ta = document.getElementById('zcNotesText');
      if (!ta) return;

      const ctxNow = getCtx();
      if (makeKey(ctxNow) !== expectedKey) return;

      if (!ta.value.trim()) {
        ta.value = note || '';
      }

      saveToStorage(ctxNow, ta.value || '');
    } catch (err) {
      if (isNotesAbortLike(err)) {
        console.debug('[NOTES] carga de nota cancelada/timeout leve:', err);
        return;
      }
      console.error('[NOTES] erro ao carregar nota do BD:', err);
    }
  }

  /* ---------- BD: salvar ---------- */
  async function saveToBackend(ctx, txt) {
    if (!ctx || !ctx.clienteId || ctx.kind !== 'c') {
      showStatus('Notas salvas apenas neste navegador para esta conversa.', 'ok');
      return false;
    }

    const perms = await getClientPermissions({ force: true });
    if (!perms.view || !perms.edit) {
      showStatus('Você não tem permissão para editar clientes.', 'err');
      return false;
    }

    const payload = { sobre_cliente: txt || null };

    try {
      const params = new URLSearchParams();
      params.set('empresa_id', String(ctx.empresaId || ''));
      if (ctx.instanciaId) params.set('instancia_id', String(ctx.instanciaId));

      const res = await authFetchJson(
        `/api/atendimento/clientes/${encodeURIComponent(ctx.clienteId)}/profile?${params.toString()}`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }
      );

      const data = await res.json().catch(() => null);

      if (!res.ok || !data || data.ok !== true) {
        showStatus('Não foi possível salvar as notas no servidor.', 'err');
        return false;
      }

      showStatus('Notas salvas com sucesso.', 'ok');
      return true;
    } catch (err) {
      if (isNotesAbortLike(err)) {
        console.debug('[NOTES] salvamento cancelado/timeout leve:', err);
        showStatus('Não foi possível salvar agora. Tente novamente.', 'err');
        return false;
      }
      console.error('[NOTES] erro ao salvar nota no BD:', err);
      showStatus('Erro de conexão ao salvar as notas.', 'err');
      return false;
    }
  }

  /* ---------- cria drawer ---------- */
  function ensureDrawer() {
    if (document.getElementById('zcNotesDrawer')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'zcNotesBackdrop';
    backdrop.className = 'zcNotes-backdrop';

    const drawer = document.createElement('aside');
    drawer.id = 'zcNotesDrawer';
    drawer.className = 'zcNotes-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');

    drawer.innerHTML = `
      <div class="zcNotes-head">
        <div class="zcNotes-title">
          <span class="zcNotes-icon" aria-hidden="true">${iconSvg(getTheme())}</span>
          Notas
        </div>
        <button class="zcNotes-close" id="zcNotesClose" title="Fechar" aria-label="Fechar notas">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" aria-hidden="true" viewBox="0 0 256 256">
            <path fill="currentColor" d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66A8 8 0 0 1 61.66 50.34L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128z"/>
          </svg>
        </button>
      </div>

      <div class="zcNotes-body">
        <textarea
          id="zcNotesText"
          class="zcNotes-text"
          placeholder="Escreva anotações sobre esta conversa…"
        ></textarea>

        <div class="zcNotes-actions">
          <button id="zcNotesSave" class="zcNotes-btnPrimary" type="button">Salvar</button>
          <button id="zcNotesCancel" class="zcNotes-btnGhost" type="button">Cancelar</button>
        </div>

        <div id="zcNotesStatus" class="zcNotes-status" aria-live="polite"></div>
      </div>
    `;

    document.body.append(backdrop, drawer);

    async function open() {
      const ctx = getCtx();
      let canEdit = true;

      if (ctx.kind === 'c') {
        const perms = await getClientPermissions({ force: true });

        if (!perms.view) {
          permissionToast('Você não tem permissão para visualizar clientes.');
          return;
        }

        canEdit = !!perms.edit;
      }

      backdrop.classList.add('is-open');
      drawer.classList.add('is-open');
      try { document.querySelector('main')?.setAttribute('inert', ''); } catch {}

      clearStatus();

      const ta = document.getElementById('zcNotesText');
      const saveBtn = document.getElementById('zcNotesSave');

      if (ta) {
        ta.value = '';
        ta.readOnly = ctx.kind === 'c' && !canEdit;
        ta.setAttribute('aria-readonly', ta.readOnly ? 'true' : 'false');
      }

      if (saveBtn) {
        saveBtn.hidden = ctx.kind === 'c' && !canEdit;
        saveBtn.disabled = ctx.kind === 'c' && !canEdit;
      }

      const localTxt = loadFromStorage(ctx);
      if (ta && localTxt) ta.value = localTxt;

      if (ctx.kind !== 'c') {
        showStatus('Notas locais para esta conversa. Sincronização com servidor só para contatos.', 'ok');
      } else {
        if (!canEdit) {
          showStatus('Somente visualização. Você não tem permissão para editar clientes.', 'ok');
        }
        loadFromBackend(ctx);
      }

      setTimeout(() => document.getElementById('zcNotesText')?.focus(), 0);
    }

    function close() {
      backdrop.classList.remove('is-open');
      drawer.classList.remove('is-open');
      try { document.querySelector('main')?.removeAttribute('inert'); } catch {}
    }

    document.getElementById('zcNotesClose')?.addEventListener('click', close);
    document.getElementById('zcNotesCancel')?.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    const ta = document.getElementById('zcNotesText');
    if (ta) {
      ta.addEventListener('input', () => {
        if (ta.readOnly) return;
        const ctx = getCtx();
        saveToStorage(ctx, ta.value || '');
      });
    }

    document.getElementById('zcNotesSave')?.addEventListener('click', async () => {
      const textarea = document.getElementById('zcNotesText');
      if (textarea?.readOnly) return;

      const txt = (textarea?.value || '').trim();
      const ctx = getCtx();

      const saved = await saveToBackend(ctx, txt);
      if (saved || ctx.kind !== 'c') {
        saveToStorage(ctx, txt || '');
      }
    });

    window.zcNotes = { open, close };
  }

  /* ---------- botão header ---------- */
  function ensureHeaderNotesButton() {
    const btn = document.getElementById('btn-sobre');
    if (!btn) return;
    if (btn.dataset.bound === '1') return;

    btn.dataset.bound = '1';
    btn.setAttribute('title', 'Notas do cliente');
    btn.setAttribute('aria-label', 'Notas do cliente');
    btn.setAttribute('data-notes-open', '1');
    btn.innerHTML = `<span class="zcNotes-icon" aria-hidden="true">${iconSvg(getTheme())}</span>`;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      ensureDrawer();
      window.zcNotes.open();
    });

    const updateBtnIcon = () => {
      const holder = btn.querySelector('.zcNotes-icon');
      if (holder) holder.innerHTML = iconSvg(getTheme());
    };

    addEventListener('theme:changed', updateBtnIcon);
    addEventListener('storage', (e) => {
      if (e && e.key === 'zc:theme') updateBtnIcon();
    });

    try {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      (mq.addEventListener ? mq.addEventListener('change', updateBtnIcon) : mq.addListener(updateBtnIcon));
    } catch {}
  }

  /* ---------- clique global ---------- */
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-notes-open]');
    if (!el) return;
    ev.preventDefault();
    ensureDrawer();
    window.zcNotes.open();
  });

  const hdr = document.getElementById('chat-header');
  if (hdr) {
    const mo = new MutationObserver(() => ensureHeaderNotesButton());
    mo.observe(hdr, { attributes: true, attributeFilter: ['style', 'class'] });
  }

  ensureHeaderNotesButton();

  window.zcNotesSetContextFromCliente = function (cliente) {
    try {
      const hdrEl = document.getElementById('chat-header');
      if (!hdrEl || !cliente) return;

      const raw =
        cliente.conversation_key ??
        cliente.conversation_id ??
        cliente.id ??
        cliente.cliente_id ??
        cliente.grupo_id ??
        null;

      const kind = kindFromObject(cliente);
      const entityId = entityIdFromAny(raw, cliente);
      const instId =
        instIdFromAny(raw, cliente) ||
        instKey(cliente.instancia_id) ||
        instKey(cliente.instancia) ||
        null;

      const convKey =
        parseConversationKey(raw)?.key ||
        buildConversationKey(kind, entityId, instId) ||
        idKey(raw) ||
        null;

      if (convKey) hdrEl.dataset.conversationKey = String(convKey);
      if (kind) hdrEl.dataset.kind = String(kind);
      if (entityId) hdrEl.dataset.entityId = String(entityId);

      // compat legado
      if (convKey) hdrEl.dataset.clienteId = String(convKey);
    } catch {}
  };
})();