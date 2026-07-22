// /frontend/js/atendimentos/ui/new-chat.js
// Nova conversa – via proxy backend + bloqueio quando filtro estiver em "Todos"
// - sem CSS inline no JS
// - usa classes + CSS no atendimentos.css
// ✅ Nome oficial: nome > nome_whatsapp > push_name > telefone
// ✅ Blindagem: avatar do header nunca reaproveita foto de outro cliente

import { EMPRESA_ID } from '../core/env.js';
import { numeroE164 } from '../core/format.js';
import { state } from '../state/store.js';

(function () {
  const $ = (s, root) => (root || document).querySelector(s);
  const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
  const ensure55 = (d) => (String(d || '').startsWith('55') ? String(d) : `55${String(d || '')}`);

  const insert9IfNeeded = (d) => {
    if (!/^55\d{2}\d+$/.test(d)) return d;

    const ddd = d.slice(2, 4);
    const rest = d.slice(4);

    return rest.length === 8 ? `55${ddd}9${rest}` : d;
  };

  const formatTelBR = (d) => {
    const s = onlyDigits(d);
    const m = s.match(/^(\+?55)?(\d{2})(\d{4,5})(\d{4})$/);

    return m ? `+55 (${m[2]}) ${m[3]}-${m[4]}` : s;
  };

  function cleanName(v) {
    const s = String(v ?? '').trim();

    if (!s) return '';

    const low = s.toLowerCase();

    if (['null', 'undefined', 'nan', 'none'].includes(low)) return '';

    return s;
  }

  function isPlaceholderName(v) {
    const s = cleanName(v).toLowerCase();

    if (!s) return true;

    return [
      'cliente',
      'contato',
      'sem nome',
      'desconhecido',
    ].includes(s);
  }

  function toast(msg, ok = true, ms = 2200) {
    let t = document.getElementById('__app_toast');

    if (!t) {
      t = document.createElement('div');
      t.id = '__app_toast';
      document.body.appendChild(t);
    }

    t.textContent = String(msg || '');
    t.classList.toggle('is-error', !ok);
    t.classList.add('on');

    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => {
      t.classList.remove('on');
    }, Math.max(1200, Number(ms) || 2200));
  }

  const pick = (o, keys) => {
    for (let i = 0; i < keys.length; i++) {
      if (o && o[keys[i]]) return o[keys[i]];
    }

    return null;
  };

  function extractMessage(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj)) return extractMessage(obj[0]);

    return (
      pick(obj, ['message', 'msg', 'detail', 'error', 'erro', 'status', 'reason', 'descricao']) ||
      (obj.error && (obj.error.message || obj.error.msg)) ||
      (Array.isArray(obj.detail) && obj.detail[0] && (obj.detail[0].msg || obj.detail[0].message)) ||
      ''
    );
  }

  function hasSelectedInstance() {
    const v = window.INSTANCIA_ATIVA == null ? '' : String(window.INSTANCIA_ATIVA).trim();

    if (!v) return false;

    const bad = ['todos', 'all', '*', '0', '-', ''];

    return !bad.includes(v.toLowerCase());
  }

  function getSelectedInstance() {
    const v = window.INSTANCIA_ATIVA == null ? '' : String(window.INSTANCIA_ATIVA).trim();

    if (!v) return '';

    const bad = ['todos', 'all', '*', '0', '-', ''];

    return bad.includes(v.toLowerCase()) ? '' : v;
  }

  function reflectPlusBtnState(btn) {
    const ok = hasSelectedInstance();

    btn.disabled = !ok;
    btn.title = ok ? 'Nova conversa' : 'Selecione o WhatsApp para enviar';
    btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
  }

  async function evoFetchProfileByNumber(numberDigits) {
    if (!hasSelectedInstance()) return null;

    const digits = onlyDigits(numberDigits);

    if (!digits) throw new Error('number vazio');

    const instRaw = getSelectedInstance();

    const body = {
      number: digits,
      empresa_id: Number(window.EMPRESA_ID || EMPRESA_ID || 0) || undefined,
      instancia_id: /^\d+$/.test(instRaw) ? Number(instRaw) : undefined,
      instance: /^\d+$/.test(instRaw) ? undefined : (instRaw || undefined),
    };

    const r = await fetch('/api/evolution/fetchProfile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });

    const txt = await r.text();

    let p = null;

    try {
      p = txt ? JSON.parse(txt) : null;
    } catch {}

    if (!r.ok) {
      const err = new Error(`fetchProfile proxy ${r.status}`);
      err.status = r.status;
      err.body = p || txt;
      throw err;
    }

    return {
      name: (p && p.name ? String(p.name).trim() : null) || null,
      picture: (p && p.picture ? String(p.picture).trim() : null) || null,
      statusTxt: (p && p.status && (p.status.status || p.status.text)) || (p && p.description) || null,
      raw: p,
    };
  }

  async function getClienteDetalhe(id) {
    const r = await fetch(
      `/api/clientes/${encodeURIComponent(String(id))}?empresa_id=${encodeURIComponent(String(EMPRESA_ID))}`,
      { credentials: 'include' }
    );

    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    return await r.json();
  }

  async function findClienteByTelefone(e164Digits) {
    const qs = new URLSearchParams({
      empresa_id: String(EMPRESA_ID),
      q: e164Digits,
      limit: '5',
      offset: '0',
    });

    const r = await fetch(`/api/clientes?${qs.toString()}`, { credentials: 'include' });

    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const list = await r.json().catch(() => ({}));
    const items = Array.isArray(list?.items) ? list.items : [];
    const normalize = (s) => String(s || '').replace(/\D/g, '');
    const without55 = e164Digits.startsWith('55') ? e164Digits.slice(2) : e164Digits;

    return (
      items.find((i) => {
        const tel = normalize(i?.telefone || '');
        return tel === e164Digits || tel === without55;
      }) || null
    );
  }

  const TITLE_SELS = [
    '#chat-title',
    '#chat-header .title',
    '.chat-title',
    '[data-role="chat-title"]',
    '#chatTitle',
    'header .title',
  ];

  const SUB_SELS = [
    '#chat-header .subtitle',
    '.chat-subtitle',
    '[data-role="chat-subtitle"]',
    '#chatSubtitle',
    'header .subtitle',
  ];

  const AVATAR_WRAP_SELS = [
    '#chat-avatar',
    '#chat-header [data-role="contact-avatar"]',
    '#chat-header .chat-avatar',
    '.chat-avatar',
  ];

  const AVATAR_IMG_SELS = [
    '#chat-avatar img',
    '#chat-header .avatar img',
    '.chat-avatar img',
    'img.avatar',
    'img[alt="avatar"]',
  ];

  function qAny(sels) {
    for (let i = 0; i < sels.length; i++) {
      const el = document.querySelector(sels[i]);

      if (el) return el;
    }

    return null;
  }

  function resolveDisplayName(cliente) {
    const tel = onlyDigits(cliente?.telefone || cliente?.whatsapp || '');
    const nomeBd = cleanName(cliente?.nome);
    const nomeWhats = cleanName(cliente?.nome_whatsapp);
    const push = cleanName(cliente?.push_name || cliente?.pushName);

    if (nomeBd && !isPlaceholderName(nomeBd)) return nomeBd;
    if (nomeWhats && !isPlaceholderName(nomeWhats)) return nomeWhats;
    if (push && !isPlaceholderName(push)) return push;

    return tel ? formatTelBR(tel) : 'Cliente';
  }

  function escapeAttr(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function idKey(v) {
    const s = String(v ?? '').trim();

    if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return '';

    return s;
  }

  function instKey(v) {
    const s = String(v ?? '').trim();

    if (!s) return '';

    const low = s.toLowerCase();

    if (
      low === 'null' ||
      low === 'undefined' ||
      low === 'nan' ||
      low === '0' ||
      low === 'all' ||
      low === 'todos' ||
      low === '*' ||
      low === '-'
    ) {
      return '';
    }

    return s;
  }

  function inferKindFromCliente(cliente = {}) {
    const explicit = String(
      cliente.kind ||
      cliente.conversation_kind ||
      cliente.tipo_conversa ||
      cliente.tipo ||
      ''
    ).trim().toLowerCase();

    if (explicit === 'g' || explicit === 'grupo' || explicit === 'group') return 'g';
    if (explicit === 'c' || explicit === 'cliente' || explicit === 'contato') return 'c';

    if (
      cliente.grupo_id != null ||
      cliente.grupoId != null ||
      cliente.group_id != null ||
      cliente.groupId != null ||
      cliente.is_group === true ||
      cliente.isGroup === true ||
      cliente.grupo === true
    ) {
      return 'g';
    }

    return 'c';
  }

  function inferEntityIdFromCliente(cliente = {}) {
    const kind = inferKindFromCliente(cliente);

    const raw =
      cliente.entity_id ??
      cliente.entityId ??
      cliente.backend_id ??
      cliente.backendClienteId ??
      cliente.id_backend ??
      cliente.conversation_entity_id ??
      cliente.conversationEntityId ??
      (
        kind === 'g'
          ? (
              cliente.grupo_id ??
              cliente.grupoId ??
              cliente.group_id ??
              cliente.groupId ??
              null
            )
          : (
              cliente.cliente_id ??
              cliente.clienteId ??
              cliente.id_cliente ??
              cliente.idCliente ??
              cliente.cid ??
              cliente.id ??
              null
            )
      );

    const s = idKey(raw);

    if (s && /^\d+$/.test(s)) return s;

    const fallback =
      cliente.api_id ??
      cliente.apiClienteId ??
      cliente.id_api ??
      cliente.id ??
      null;

    const f = idKey(fallback);

    if (f && /^\d+$/.test(f)) return f;

    return '';
  }

  function inferInstIdFromCliente(cliente = {}) {
    return (
      instKey(cliente.instancia_id) ||
      instKey(cliente.instanciaId) ||
      instKey(cliente.instancia) ||
      instKey(cliente.instance_id) ||
      instKey(cliente.instanceId) ||
      instKey(cliente.instance) ||
      instKey(cliente.instance_name) ||
      instKey(cliente.instanceName) ||
      instKey(cliente.session) ||
      instKey(cliente.sessionName) ||
      getSelectedInstance() ||
      ''
    );
  }

  function parseConversationKey(raw) {
    const s = String(raw || '').trim();
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

    if (!eid || !iid) return '';

    return `${k}:${eid}:${iid}`;
  }

  function refFromCliente(cliente = {}) {
    const rawKey =
      cliente.conversation_key ||
      cliente.conversationKey ||
      cliente.conversation_id ||
      cliente.conversationId ||
      cliente.conv_key ||
      cliente.convKey ||
      '';

    const parsed = parseConversationKey(rawKey);

    if (parsed) return parsed;

    const kind = inferKindFromCliente(cliente);
    const entityId = inferEntityIdFromCliente(cliente);
    const instId = inferInstIdFromCliente(cliente);
    const key = buildConversationKey(kind, entityId, instId);

    return {
      key,
      kind,
      entityId,
      instId,
    };
  }

  function ensureClienteInstance(cliente = {}) {
    const inst = inferInstIdFromCliente(cliente);

    if (!inst) return cliente;

    const out = { ...(cliente || {}) };

    if (!out.instancia_id && /^\d+$/.test(String(inst))) {
      out.instancia_id = Number(inst);
    }

    if (!out.instancia && !/^\d+$/.test(String(inst))) {
      out.instancia = String(inst);
    }

    if (!out.instance_name && !/^\d+$/.test(String(inst))) {
      out.instance_name = String(inst);
    }

    const ref = refFromCliente(out);

    if (ref.key) {
      out.conversation_key = ref.key;
      out.conversation_id = ref.key;
    }

    return out;
  }

  function getHeaderConversationKey() {
    const head = document.getElementById('chat-header');
    const hist = document.getElementById('historico');

    return (
      head?.dataset?.conversationKey ||
      head?.dataset?.conversationId ||
      head?.dataset?.convKey ||
      hist?.dataset?.conversationKey ||
      hist?.dataset?.conversationId ||
      hist?.dataset?.convKey ||
      ''
    );
  }

  function isSameHeaderConversation(ref) {
    if (!ref?.key) return false;

    const currentKey = getHeaderConversationKey();

    if (!currentKey) {
      const currentId = Number(window.__CURRENT_CHAT_ID || 0);
      return currentId && Number(ref.entityId) === currentId;
    }

    return String(currentKey) === String(ref.key);
  }

  function setHeaderDatasetFromRef(ref) {
    const head = document.getElementById('chat-header');
    const hist = document.getElementById('historico');
    const av = qAny(AVATAR_WRAP_SELS);

    [head, hist, av].forEach((el) => {
      if (!el || !ref?.key) return;

      el.dataset.conversationKey = String(ref.key || '');
      el.dataset.conversationId = String(ref.key || '');
      el.dataset.convKey = String(ref.key || '');
      el.dataset.kind = String(ref.kind || '');
      el.dataset.entityId = String(ref.entityId || '');
      el.dataset.clienteId = String(ref.entityId || '');

      if (ref.instId) {
        el.dataset.instanciaId = String(ref.instId);
      } else {
        el.removeAttribute('data-instancia-id');
      }
    });
  }

  function avatarDefaultHtml(ref = {}) {
    return `
      <span
        class="avatar avatar-default"
        data-conversation-key="${escapeAttr(ref.key || '')}"
        data-cliente-id="${escapeAttr(ref.entityId || '')}"
        data-instancia-id="${escapeAttr(ref.instId || '')}"
      >
        <i class="fa fa-user-circle text-2xl text-gray-400"></i>
      </span>
    `;
  }

  function avatarImageHtml(ref = {}, url = '') {
    return `
      <span
        class="avatar"
        data-conversation-key="${escapeAttr(ref.key || '')}"
        data-cliente-id="${escapeAttr(ref.entityId || '')}"
        data-instancia-id="${escapeAttr(ref.instId || '')}"
      >
        <img
          src="${escapeAttr(url)}"
          alt=""
          data-conversation-key="${escapeAttr(ref.key || '')}"
          data-cliente-id="${escapeAttr(ref.entityId || '')}"
          data-instancia-id="${escapeAttr(ref.instId || '')}"
          onerror="window.handleAvatarError && window.handleAvatarError(this)"
        >
      </span>
    `;
  }

  function setHeaderAvatarDefault(clienteOrRef = {}) {
    const ref = clienteOrRef?.key
      ? clienteOrRef
      : refFromCliente(ensureClienteInstance(clienteOrRef));

    if (!ref?.key) return false;

    const wrap = qAny(AVATAR_WRAP_SELS);

    if (window.zcClearHeaderAvatarSafe) {
      try {
        const ok = window.zcClearHeaderAvatarSafe(ref);
        if (ok) return true;
      } catch {}
    }

    if (!wrap) {
      const imgEl = qAny(AVATAR_IMG_SELS);

      if (imgEl) {
        imgEl.removeAttribute('src');
        imgEl.removeAttribute('srcset');
        imgEl.style.display = 'none';
      }

      return false;
    }

    setHeaderDatasetFromRef(ref);
    wrap.innerHTML = avatarDefaultHtml(ref);

    return true;
  }

  function setHeaderAvatarImage(clienteOrRef = {}, url = '') {
    const finalUrl = String(url || '').trim();

    if (!finalUrl) {
      return setHeaderAvatarDefault(clienteOrRef);
    }

    const ref = clienteOrRef?.key
      ? clienteOrRef
      : refFromCliente(ensureClienteInstance(clienteOrRef));

    if (!ref?.key) return false;

    if (window.zcAvatarBroken && window.zcAvatarBroken(finalUrl)) {
      return setHeaderAvatarDefault(ref);
    }

    if (!isSameHeaderConversation(ref)) {
      return false;
    }

    if (window.zcSetHeaderAvatarSafe) {
      try {
        const ok = window.zcSetHeaderAvatarSafe(ref, finalUrl);
        if (ok) return true;
      } catch {}
    }

    const wrap = qAny(AVATAR_WRAP_SELS);

    if (wrap) {
      setHeaderDatasetFromRef(ref);
      wrap.innerHTML = avatarImageHtml(ref, finalUrl);
      return true;
    }

    const imgEl = qAny(AVATAR_IMG_SELS);

    if (imgEl) {
      imgEl.src = finalUrl;
      imgEl.removeAttribute('srcset');
      imgEl.dataset.conversationKey = String(ref.key || '');
      imgEl.dataset.clienteId = String(ref.entityId || '');
      imgEl.dataset.instanciaId = String(ref.instId || '');
      imgEl.style.display = '';
      return true;
    }

    return false;
  }

  function setHeaderFromDB(cliente) {
    const safeCliente = ensureClienteInstance(cliente || {});
    const ref = refFromCliente(safeCliente);
    const titleEl = qAny(TITLE_SELS);
    const subEl = qAny(SUB_SELS);

    const name = resolveDisplayName(safeCliente || {});

    if (ref?.key) {
      setHeaderDatasetFromRef(ref);
    }

    if (titleEl) {
      titleEl.textContent = name;
    }

    if (subEl) {
      subEl.textContent = '';
    }

    /*
      Ponto crítico:
      - se o cliente tem foto, aplica somente se for a conversa atual;
      - se NÃO tem foto, limpa imediatamente qualquer foto antiga.
    */
    if (safeCliente?.avatar_url) {
      setHeaderAvatarImage(ref, safeCliente.avatar_url);
    } else {
      setHeaderAvatarDefault(ref);
    }

    try {
      window.__HEADER_LOCKED_NAME = name;
    } catch {}
  }

  function updateHeaderPicture(url, cliente = null) {
    const finalUrl = String(url || '').trim();

    if (!finalUrl) return false;

    const baseCliente =
      cliente ||
      state?.clienteSel ||
      window.clienteSel ||
      {
        id: window.__CURRENT_CHAT_ID || null,
        instancia_id: getSelectedInstance(),
      };

    const safeCliente = ensureClienteInstance(baseCliente);
    const ref = refFromCliente(safeCliente);

    if (!ref?.key) return false;

    if (!isSameHeaderConversation(ref)) {
      return false;
    }

    return setHeaderAvatarImage(ref, finalUrl);
  }

  function mergeClienteInCaches(cliente) {
    if (!cliente || cliente.id == null) return;

    const safeCliente = ensureClienteInstance(cliente);
    const idNum = Number(safeCliente.id);

    try {
      ['todosContatosCache', 'clientesCache'].forEach((name) => {
        const arr = window[name];

        if (Array.isArray(arr)) {
          const idx = arr.findIndex((c) => Number(c.id) === idNum);

          if (idx >= 0) arr[idx] = Object.assign({}, arr[idx], safeCliente);
          else arr.unshift(safeCliente);
        }
      });
    } catch {}

    try {
      if (state) {
        if (!Array.isArray(state.clientesCache)) state.clientesCache = [];

        const idx2 = state.clientesCache.findIndex((c) => Number(c.id) === idNum);

        if (idx2 >= 0) state.clientesCache[idx2] = Object.assign({}, state.clientesCache[idx2], safeCliente);
        else state.clientesCache.unshift(safeCliente);
      }
    } catch {}
  }

  function forceSelectCliente(cliente) {
    if (!cliente || cliente.id == null) return;

    const safeCliente = ensureClienteInstance(cliente);

    try {
      mergeClienteInCaches(safeCliente);
    } catch {}

    try {
      if (state) state.clienteSel = safeCliente;
    } catch {}

    try {
      window.clienteSel = safeCliente;
    } catch {}
  }

  async function tryEvolutionPictureIfMissing(cliente) {
    if (!hasSelectedInstance()) return;

    const safeCliente = ensureClienteInstance(cliente || {});

    if (safeCliente?.avatar_url) {
      updateHeaderPicture(safeCliente.avatar_url, safeCliente);
      return;
    }

    const ref = refFromCliente(safeCliente);

    if (!ref?.key || !isSameHeaderConversation(ref)) return;

    const telRaw = onlyDigits(safeCliente?.telefone || safeCliente?.whatsapp || '');

    if (!telRaw) {
      setHeaderAvatarDefault(ref);
      return;
    }

    try {
      const prof = await evoFetchProfileByNumber(ensure55(telRaw));

      if (!isSameHeaderConversation(ref)) return;

      if (prof?.picture) {
        updateHeaderPicture(prof.picture, safeCliente);
        return;
      }
    } catch {}

    try {
      const d = ensure55(telRaw);

      if (/^55\d{2}\d{8}$/.test(d)) {
        const ddd = d.slice(2, 4);
        const rest = d.slice(4);
        const with9 = `55${ddd}9${rest}`;

        const prof2 = await evoFetchProfileByNumber(with9);

        if (!isSameHeaderConversation(ref)) return;

        if (prof2?.picture) {
          updateHeaderPicture(prof2.picture, safeCliente);
          return;
        }
      }
    } catch {}

    if (isSameHeaderConversation(ref)) {
      setHeaderAvatarDefault(ref);
    }
  }

  async function openById(input) {
    const seed = normalizePickerItem(
      input && typeof input === 'object'
        ? input
        : { id: input, cliente_id: input, entity_id: input }
    );

    const id = pickerClienteId(seed || input || {});

    if (!id) return false;

    const inst = getSelectedInstance();
    let cliente = ensureClienteInstance({
      ...(seed || {}),
      id,
      cliente_id: id,
      entity_id: id,
      instancia_id: /^\d+$/.test(inst) ? Number(inst) : (seed?.instancia_id || undefined),
      instancia: /^\d+$/.test(inst) ? (seed?.instancia || undefined) : (inst || seed?.instancia || undefined),
      instance_name: /^\d+$/.test(inst) ? (seed?.instance_name || undefined) : (inst || seed?.instance_name || undefined),
    });

    /*
      Busca o cadastro completo antes de abrir. Assim o fluxo oficial recebe
      telefone, nome, conversation_key e instância corretos de uma vez só.
      Antes este arquivo disparava selecionarClienteObj, selecionarClienteId e
      três eventos diferentes para o mesmo clique. Isso iniciava carregamentos
      duplicados do histórico e podia terminar na tela de timeout.
    */
    try {
      const detalhe = await getClienteDetalhe(id);
      cliente = ensureClienteInstance({
        ...cliente,
        ...(detalhe || {}),
        id,
        cliente_id: id,
        entity_id: id,
        instancia_id:
          detalhe?.instancia_id ??
          cliente?.instancia_id ??
          (/^\d+$/.test(inst) ? Number(inst) : undefined),
        instancia:
          detalhe?.instancia ??
          cliente?.instancia ??
          (!/^\d+$/.test(inst) ? (inst || undefined) : undefined),
        instance_name:
          detalhe?.instance_name ??
          cliente?.instance_name ??
          (!/^\d+$/.test(inst) ? (inst || undefined) : undefined),
      });
    } catch (e) {
      console.warn('[new-chat] detalhe do contato não carregou; usando dados da lista:', e?.message || e);
    }

    const finalRef = refFromCliente(cliente);

    if (!finalRef?.key || !finalRef?.instId) {
      toast('Não foi possível identificar a instância deste contato.', false, 3000);
      return false;
    }

    cliente.conversation_key = finalRef.key;
    cliente.conversation_id = finalRef.key;
    cliente.kind = 'c';
    cliente.entity_id = id;

    try {
      window.__CURRENT_CHAT_ID = id;
      forceSelectCliente(cliente);
      setHeaderAvatarDefault(cliente);
    } catch {}

    if (typeof window.selecionarClienteObj !== 'function') {
      toast('A tela de conversas ainda está carregando. Tente novamente.', false, 2600);
      return false;
    }

    try {
      /* Um clique = uma única abertura oficial. */
      await Promise.resolve(
        window.selecionarClienteObj(cliente, {
          forceReload: true,
          timeoutMs: 45000,
          source: 'new-chat-picker',
        })
      );

      return true;
    } catch (e) {
      console.error('[new-chat] falha ao abrir conversa:', e);
      toast('Não foi possível carregar esta conversa. Tente novamente.', false, 3000);
      return false;
    }
  }

  function validatePhoneOrExplain(rawDigits) {
    const digits = onlyDigits(String(rawDigits || ''));

    if (!digits) {
      toast('Informe um telefone com DDI+DDD+Número. Ex.: 55 11 9 8888-7777', false, 3200);
      return null;
    }

    let e164 = (numeroE164(digits) || digits).replace(/\D/g, '');

    if (!e164.startsWith('55')) e164 = `55${e164}`;

    if (e164.length < 12) {
      toast('Telefone incompleto. Use DDI(55)+DDD(2)+Número (8 ou 9 dígitos).', false, 3200);
      return null;
    }

    if (e164.length > 13) {
      toast('Telefone muito longo. Remova caracteres extras e tente novamente.', false, 3000);
      return null;
    }

    const ddd = e164.slice(2, 4);

    if (!/^\d{2}$/.test(ddd) || ddd === '00') {
      toast('DDD inválido. Verifique os 2 dígitos do DDD.', false, 3000);
      return null;
    }

    return e164;
  }

  function explainCreateError(err) {
    const status = Number(err?.status || 0);
    const b = err?.body;
    const msg = extractMessage(b);

    if (status === 400) return toast(msg || 'Dados inválidos (nome/telefone). Corrija e tente novamente.', false, 3200);
    if (status === 401) return toast('Sessão expirada. Faça login novamente.', false, 2800);
    if (status === 403) return toast('Você não tem permissão para criar contatos.', false, 2800);
    if (status === 409) return toast('Já existe um contato com este telefone.', false, 2800);
    if (status === 422) return toast(msg || 'Campos obrigatórios ausentes ou inválidos.', false, 3000);
    if (status === 429) return toast('Limite de criação atingido no seu plano. Tente mais tarde ou atualize o plano.', false, 3200);

    toast('Falha ao criar contato. Tente novamente.', false, 2600);
  }

  const pickerState = {
    cacheItems: [],
    dbItems: [],
    query: '',
    offset: 0,
    hasMore: true,
    loading: false,
    startedDb: false,
    controller: null,
    debounceTimer: null,
    requestSeq: 0,
    error: '',
  };

  function abortPickerRequest() {
    try { pickerState.controller?.abort(); } catch {}
    pickerState.controller = null;
    pickerState.loading = false;

    if (pickerState.debounceTimer) {
      clearTimeout(pickerState.debounceTimer);
      pickerState.debounceTimer = null;
    }
  }

  function buildUI() {
    if (document.getElementById('ncBackdrop')) return;

    const back = document.createElement('div');
    back.id = 'ncBackdrop';

    const dr = document.createElement('aside');
    dr.id = 'ncDrawer';

    dr.innerHTML = `
      <div id="ncBody" class="nc-body-shell"></div>
    `;

    const asideHost = document.querySelector('.wpp-root > aside') || document.querySelector('aside');

    if (asideHost) {
      asideHost.append(back, dr);
    } else {
      document.body.append(back, dr);
    }

    const close = () => {
      abortPickerRequest();
      back.classList.remove('is-open');
      dr.classList.remove('is-open');
    };

    const open = () => {
      buildRoot();
      back.classList.add('is-open');
      dr.classList.add('is-open');
      setTimeout(() => $('#ncSearch')?.focus(), 40);
    };

    back.addEventListener('click', () => close());

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    window.__NewChat = {
      open,
      close,
      setBody(html) {
        const body = document.getElementById('ncBody');

        if (body) body.innerHTML = html;
      },
    };
  }

  function initialsFromName(name) {
    const base = String(name || '').trim();

    if (!base) return '??';

    const parts = base.split(/\s+/).filter(Boolean).slice(0, 2);

    return parts.map((p) => p[0]).join('').toUpperCase();
  }

  function escapeHtml(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeSearch(v) {
    return String(v || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim();
  }

  function getContactPools() {
    const pools = [];

    try {
      if (Array.isArray(window.todosContatosCache)) pools.push(window.todosContatosCache);
    } catch {}

    try {
      if (Array.isArray(window.clientesCache)) pools.push(window.clientesCache);
    } catch {}

    try {
      if (Array.isArray(state?.clientesCache)) pools.push(state.clientesCache);
    } catch {}

    return pools;
  }

  function pickerClienteId(cliente = {}) {
    /*
      Na lista principal, `id` pode ser a chave canônica da conversa
      (ex.: c:123:4), e não o ID numérico do cliente. Por isso não podemos
      usar Number(cliente.id || cliente.cliente_id): a string composta vence
      o `||` e vira NaN, mesmo quando cliente_id está correto.
    */
    const ref = refFromCliente(cliente || {});

    if (ref?.kind !== 'g' && /^\d+$/.test(String(ref?.entityId || ''))) {
      return Number(ref.entityId);
    }

    const candidates = [
      cliente?.cliente_id,
      cliente?.clienteId,
      cliente?.entity_id,
      cliente?.entityId,
      cliente?.backend_id,
      cliente?.backendClienteId,
      cliente?.id_backend,
      cliente?.id_cliente,
      cliente?.idCliente,
      cliente?.cid,
      cliente?.api_id,
      cliente?.apiClienteId,
      cliente?.id_api,
      cliente?.id,
    ];

    for (const raw of candidates) {
      const value = String(raw ?? '').trim();

      if (/^\d+$/.test(value)) return Number(value);

      const parsed = parseConversationKey(value);

      if (parsed?.kind === 'c' && /^\d+$/.test(String(parsed.entityId || ''))) {
        return Number(parsed.entityId);
      }
    }

    return 0;
  }

  function normalizePickerItem(raw) {
    const cliente = ensureClienteInstance(raw || {});
    const id = pickerClienteId(cliente);
    const telefone = onlyDigits(cliente?.telefone || cliente?.whatsapp || '');
    const nome = resolveDisplayName(cliente);

    if (!id && !telefone) return null;

    return {
      ...cliente,
      /* Mantém conversation_key em campo próprio e garante ID numérico. */
      id: id || cliente?.id,
      cliente_id: id || cliente?.cliente_id,
      entity_id: id || cliente?.entity_id,
      nome_exibicao: nome,
    };
  }

  function dedupePickerItems(items) {
    const out = [];
    const seen = new Set();

    (Array.isArray(items) ? items : []).forEach((raw) => {
      const cliente = normalizePickerItem(raw);

      if (!cliente) return;

      const id = pickerClienteId(cliente);
      const telefone = onlyDigits(cliente?.telefone || cliente?.whatsapp || '');
      const key = id ? `id:${id}` : `tel:${telefone}`;

      if (!key || seen.has(key)) return;

      seen.add(key);
      out.push(cliente);
    });

    return out;
  }

  function collectLoadedContacts() {
    const merged = [];

    getContactPools().forEach((arr) => merged.push(...arr));

    return dedupePickerItems(merged).sort((a, b) =>
      resolveDisplayName(a).localeCompare(resolveDisplayName(b), 'pt-BR', { sensitivity: 'base' })
    );
  }

  function combinedPickerContacts() {
    return dedupePickerItems([
      ...(pickerState.cacheItems || []),
      ...(pickerState.dbItems || []),
    ]).sort((a, b) =>
      resolveDisplayName(a).localeCompare(resolveDisplayName(b), 'pt-BR', { sensitivity: 'base' })
    );
  }

  function filterPickerContacts(items, searchTerm = '') {
    const term = normalizeSearch(searchTerm);

    if (!term) return items;

    return items.filter((cliente) => {
      const nome = normalizeSearch(resolveDisplayName(cliente));
      const telefone = onlyDigits(cliente?.telefone || cliente?.whatsapp || '');
      const telefoneFormatado = normalizeSearch(formatTelBR(telefone));

      return nome.includes(term) || telefone.includes(term) || telefoneFormatado.includes(term);
    });
  }

  function buildQuickActionsHtml() {
    return `
      <div class="nc-quick-list">
        <button id="ncNewGroup" class="nc-quick-item" type="button">
          <span class="nc-action-icon"><i class="fa fa-users"></i></span>
          <span class="nc-quick-copy">
            <span class="nc-quick-title">Novo grupo</span>
            <span class="nc-quick-sub">Criar um grupo manualmente</span>
          </span>
        </button>

        <button id="ncNewContact" class="nc-quick-item" type="button">
          <span class="nc-action-icon"><i class="fa fa-user-plus"></i></span>
          <span class="nc-quick-copy">
            <span class="nc-quick-title">Novo contato</span>
            <span class="nc-quick-sub">Criar contato manualmente</span>
          </span>
        </button>
      </div>
    `;
  }

  function renderPickerStatus() {
    const host = document.getElementById('ncPickerStatus');

    if (!host) return;

    if (pickerState.loading) {
      host.innerHTML = `
        <div class="nc-loading-row">
          <span class="nc-loading-spinner" aria-hidden="true"></span>
          <span>Carregando mais contatos...</span>
        </div>
      `;
      return;
    }

    if (pickerState.error) {
      host.innerHTML = `<div class="nc-error-row">${escapeHtml(pickerState.error)}</div>`;
      return;
    }

    if (pickerState.startedDb && !pickerState.hasMore) {
      host.innerHTML = `<div class="nc-end-row">Todos os contatos foram carregados.</div>`;
      return;
    }

    if (!pickerState.startedDb && !pickerState.query) {
      host.innerHTML = `<div class="nc-end-row">Role até o final para carregar mais contatos do banco.</div>`;
      return;
    }

    host.innerHTML = '';
  }

  async function openPickerConversation(cliente) {
    const safeCliente = normalizePickerItem(cliente);
    const id = pickerClienteId(safeCliente);

    if (!id) {
      toast('Não foi possível abrir este contato.', false, 2600);
      return;
    }

    window.__NewChat?.close();

    const opened = await openById(safeCliente || { id, cliente_id: id, entity_id: id });

    if (!opened) {
      toast('Não foi possível abrir a conversa.', false, 2600);
    }
  }

  function renderPickerContacts(searchTerm = '') {
    const host = document.getElementById('ncContactResults');

    if (!host) return;

    const scrollHost = document.querySelector('#ncDrawer .nc-scroll-area');
    const previousScrollTop = scrollHost?.scrollTop || 0;
    const items = filterPickerContacts(combinedPickerContacts(), searchTerm);

    if (!items.length) {
      host.innerHTML = `
        <div class="nc-empty-state">
          <div class="nc-empty-title">Nenhum contato encontrado</div>
          <div class="nc-empty-sub">Pesquise outro nome ou número.</div>
        </div>
      `;
      renderPickerStatus();
      return;
    }

    let html = '';
    let currentLetter = '';

    items.forEach((cliente) => {
      const id = pickerClienteId(cliente);
      const nome = resolveDisplayName(cliente);
      const letra = normalizeSearch(nome).charAt(0).toUpperCase() || '#';
      const telefone = onlyDigits(cliente?.telefone || cliente?.whatsapp || '');
      const subtitulo = telefone ? formatTelBR(telefone) : 'Contato';
      const avatar = String(cliente?.avatar_url || cliente?.foto || cliente?.picture || '').trim();

      if (letra !== currentLetter) {
        currentLetter = letra;
        html += `<div class="nc-letter">${escapeHtml(currentLetter)}</div>`;
      }

      html += `
        <button class="nc-contact-item" type="button" data-id="${escapeAttr(id)}">
          <span class="nc-contact-avatar ${avatar ? 'has-image' : 'is-initials'}">
            ${avatar
              ? `<img src="${escapeAttr(avatar)}" alt="${escapeAttr(nome)}" loading="lazy">`
              : `<span class="nc-contact-initials">${escapeHtml(initialsFromName(nome))}</span>`}
          </span>
          <span class="nc-contact-copy">
            <span class="nc-contact-name">${escapeHtml(nome)}</span>
            <span class="nc-contact-sub">${escapeHtml(subtitulo)}</span>
          </span>
        </button>
      `;
    });

    host.innerHTML = html;

    host.querySelectorAll('.nc-contact-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id || 0);
        const cliente = combinedPickerContacts().find((item) =>
          pickerClienteId(item) === id
        );

        openPickerConversation(cliente || { id, cliente_id: id });
      });
    });

    if (scrollHost) {
      requestAnimationFrame(() => {
        scrollHost.scrollTop = previousScrollTop;
      });
    }

    renderPickerStatus();
  }

  function pickerApiUrl({ query = '', offset = 0, limit = 50 } = {}) {
    const params = new URLSearchParams({
      empresa_id: String(EMPRESA_ID),
      limit: String(limit),
      offset: String(offset),
    });

    const q = String(query || '').trim();

    if (q) params.set('q', q);

    const inst = getSelectedInstance();

    if (/^\d+$/.test(inst)) params.set('instancia_id', inst);

    return `/api/clientes?${params.toString()}`;
  }

  async function loadPickerPage({ reset = false, reason = 'scroll' } = {}) {
    if (pickerState.loading) return;
    if (!reset && !pickerState.hasMore) return;

    if (reset) {
      abortPickerRequest();
      pickerState.dbItems = [];
      pickerState.offset = 0;
      pickerState.hasMore = true;
      pickerState.startedDb = false;
      pickerState.error = '';
    }

    const requestQuery = pickerState.query;
    const requestOffset = pickerState.offset;
    const requestSeq = ++pickerState.requestSeq;
    const controller = new AbortController();

    pickerState.controller = controller;
    pickerState.loading = true;
    pickerState.startedDb = true;
    pickerState.error = '';
    renderPickerStatus();

    try {
      const response = await fetch(
        pickerApiUrl({ query: requestQuery, offset: requestOffset, limit: 50 }),
        {
          credentials: 'include',
          signal: controller.signal,
          zcTimeoutMs: 18000,
        }
      );

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }

      const payload = await response.json().catch(() => ({}));

      if (requestSeq !== pickerState.requestSeq) return;
      if (requestQuery !== pickerState.query) return;

      const received = Array.isArray(payload?.items) ? payload.items : [];

      pickerState.dbItems = dedupePickerItems([
        ...pickerState.dbItems,
        ...received,
      ]);
      pickerState.offset = Number(payload?.next_offset ?? (requestOffset + received.length));
      pickerState.hasMore = Boolean(payload?.has_more) && received.length > 0;

      renderPickerContacts(pickerState.query);
    } catch (err) {
      if (err?.name === 'AbortError') return;

      console.error('[new-chat] falha ao carregar contatos do banco', err, reason);

      pickerState.error = Number(err?.status) === 403
        ? 'Você não tem permissão para consultar os contatos.'
        : 'Não foi possível carregar mais contatos. Role novamente para tentar.';
    } finally {
      if (requestSeq === pickerState.requestSeq) {
        pickerState.loading = false;
        pickerState.controller = null;
        renderPickerStatus();
      }
    }
  }

  function schedulePickerSearch(value) {
    const query = String(value || '').trim();

    pickerState.query = query;
    pickerState.dbItems = [];
    pickerState.offset = 0;
    pickerState.hasMore = true;
    pickerState.startedDb = false;
    pickerState.error = '';

    abortPickerRequest();
    renderPickerContacts(query);

    if (!query) return;

    pickerState.debounceTimer = setTimeout(() => {
      pickerState.debounceTimer = null;
      loadPickerPage({ reset: true, reason: 'search' });
    }, 320);
  }

  function wireRootEvents() {
    pickerState.cacheItems = collectLoadedContacts();
    pickerState.dbItems = [];
    pickerState.query = '';
    pickerState.offset = 0;
    pickerState.hasMore = true;
    pickerState.loading = false;
    pickerState.startedDb = false;
    pickerState.error = '';

    $('#ncCloseTop')?.addEventListener('click', () => window.__NewChat?.close());

    $('#ncNewContact')?.addEventListener('click', renderNewContactForm);

    $('#ncNewGroup')?.addEventListener('click', () => {
      toast('Criação de grupo pelo painel entra em breve.', true, 2600);
    });

    $('#ncSearch')?.addEventListener('input', (e) => {
      schedulePickerSearch(e.target?.value || '');
    });

    const scrollHost = document.querySelector('#ncDrawer .nc-scroll-area');

    scrollHost?.addEventListener('scroll', () => {
      const distanceFromBottom = scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight;

      if (distanceFromBottom <= 140) {
        loadPickerPage({ reset: false, reason: 'scroll' });
      }
    }, { passive: true });

    scrollHost?.addEventListener('wheel', (event) => {
      if (Number(event?.deltaY || 0) <= 0) return;

      const distanceFromBottom = scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight;

      if (distanceFromBottom <= 140) {
        loadPickerPage({ reset: false, reason: 'wheel-bottom' });
      }
    }, { passive: true });

    renderPickerContacts('');
  }

  function renderNewContactForm() {
    const body = `
      <div class="nc-wpp-head nc-wpp-head--form">
        <button id="ncBack" class="nc-nav-btn" type="button" aria-label="Voltar">
          <i class="fa fa-arrow-left"></i>
        </button>
        <div class="nc-drawer-title">Novo contato</div>
      </div>

      <form id="ncForm" class="nc-form">
        <input class="nc-input" id="ncName" placeholder="Nome completo" autocomplete="off">
        <input class="nc-input" id="ncPhone" placeholder="Telefone (DDI+DDD+Número, só dígitos)">
        <div class="nc-form-actions">
          <button class="nc-save" id="ncSave" type="submit">Salvar contato</button>
          <button type="button" class="nc-cancel" id="ncCancel">Cancelar</button>
        </div>
      </form>
    `;

    window.__NewChat?.setBody(body);

    $('#ncCancel')?.addEventListener('click', () => window.__NewChat?.close());
    $('#ncBack')?.addEventListener('click', buildRoot);
    $('#ncForm')?.addEventListener('submit', onSaveContact);

    $('#ncName')?.focus();
  }

  function buildRoot() {
    if (!window.__NewChat) return;

    const html = `
      <div class="nc-wpp-head">
        <button id="ncCloseTop" class="nc-nav-btn" type="button" aria-label="Voltar">
          <i class="fa fa-arrow-left"></i>
        </button>
        <div class="nc-drawer-title">Nova conversa</div>
      </div>

      <div class="nc-search-wrap">
        <div class="nc-search-row">
          <i class="fa fa-search"></i>
          <input id="ncSearch" class="nc-search-input" type="text" placeholder="Pesquisar nome ou número" autocomplete="off">
        </div>
      </div>

      <div class="nc-scroll-area">
        ${buildQuickActionsHtml()}
        <div id="ncContactResults" class="nc-contact-results"></div>
        <div id="ncPickerStatus" class="nc-picker-status" aria-live="polite"></div>
      </div>
    `;

    window.__NewChat.setBody(html);
    wireRootEvents();
  }

  async function onSaveContact(ev) {
    ev.preventDefault();

    if (!hasSelectedInstance()) {
      toast('Selecione o WhatsApp para enviar mensagens.', false, 3000);
      return;
    }

    const nomeManual = String($('#ncName')?.value || '').trim();
    const raw = onlyDigits($('#ncPhone')?.value || '');

    const e164 = validatePhoneOrExplain(raw);

    if (!e164) return;

    const btnSave = $('#ncSave');

    btnSave?.setAttribute('disabled', 'disabled');

    try {
      const found1 = await findClienteByTelefone(e164);

      if (found1?.id) {
        window.__NewChat?.close();
        setTimeout(() => openById(found1), 0);
        return;
      }

      const with9 = insert9IfNeeded(e164);

      if (with9 !== e164) {
        const found2 = await findClienteByTelefone(with9);

        if (found2?.id) {
          window.__NewChat?.close();
          setTimeout(() => openById(found2), 0);
          return;
        }
      }

      const canonical = insert9IfNeeded(e164);
      const url = '/api/clientes/novo';

      const rCreate = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Empresa-Id': String(EMPRESA_ID),
        },
        credentials: 'include',
        body: JSON.stringify({
          nome: nomeManual || 'Cliente',
          telefone: canonical,
        }),
      });

      const text = await rCreate.text();

      let data = null;

      try {
        data = text ? JSON.parse(text) : null;
      } catch {}

      if (!rCreate.ok) {
        const err = new Error(`HTTP ${rCreate.status}`);
        err.status = rCreate.status;
        err.body = data || text;
        err.endpoint = url;
        throw err;
      }

      const newId = Number(data?.id) || null;

      if (newId) {
        const inst = getSelectedInstance();

        const simpleCliente = ensureClienteInstance({
          id: newId,
          cliente_id: newId,
          nome: nomeManual || 'Cliente',
          telefone: canonical,
          instancia_id: /^\d+$/.test(inst) ? Number(inst) : undefined,
          instancia: /^\d+$/.test(inst) ? undefined : inst || undefined,
        });

        forceSelectCliente(simpleCliente);
        window.__NewChat?.close();
        openById(simpleCliente);

        try {
          const prof = await evoFetchProfileByNumber(canonical);

          if (prof?.picture) {
            updateHeaderPicture(prof.picture, simpleCliente);
          }
        } catch {}

        return;
      }

      toast('Não foi possível criar/abrir o contato.', false, 2600);
    } catch (e) {
      console.error('[new-chat] create failed', e);

      if (e?.status) {
        explainCreateError(e);
        return;
      }

      toast('Falha ao criar contato.', false, 2400);
    } finally {
      btnSave?.removeAttribute('disabled');
    }
  }

  function ensurePlusButtonMounted() {
    const candidates = [
      '#chat-header .actions',
      '.chat-actions',
      '#header-actions',
      '.topbar .actions',
      '#chat-actions',
      '#navbar-actions',
    ];

    let host = null;

    for (let i = 0; i < candidates.length; i++) {
      host = document.querySelector(candidates[i]);

      if (host) break;
    }

    if (!host) host = document.querySelector('#chat-header, .topbar, header');
    if (!host) return;

    let btn = document.getElementById('btn-sidemodal-nova-conversa');

    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btn-sidemodal-nova-conversa';
      btn.type = 'button';
      btn.title = 'Nova conversa';
      btn.setAttribute('aria-label', 'Nova conversa');
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      `;
      host.appendChild(btn);
    }

    reflectPlusBtnState(btn);

    if (!btn.dataset.boundNewChat) {
      btn.dataset.boundNewChat = '1';

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (!hasSelectedInstance()) {
          toast('Selecione o WhatsApp para enviar mensagens.', false, 2800);
          return;
        }

        try {
          window.__NewChat?.open();
        } catch {}
      });
    }

    if (!btn.__instEvtBound) {
      btn.__instEvtBound = true;

      document.addEventListener('inst:change', () => {
        reflectPlusBtnState(btn);
      });
    }
  }

  function wire() {
    try {
      buildUI();
    } catch (e) {
      console.error('[new-chat] buildUI failed', e);
    }

    try {
      ensurePlusButtonMounted();
    } catch (e) {
      console.error('[new-chat] ensurePlusButtonMounted failed', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();