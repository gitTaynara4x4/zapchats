// /frontend/js/atendimentos/ui/header-actions.js
// Lupa + 3 pontinhos + pesquisa lateral + seleção de mensagens + encaminhar real
// + Mobile: coloca IA/Notas, Transferir departamento e Instância dentro dos 3 pontinhos

(function () {
  if (window.__ZC_CHAT_HEADER_ACTIONS__) return;
  window.__ZC_CHAT_HEADER_ACTIONS__ = true;

  const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);

  const state = {
    searchOpen: false,
    menuOpen: false,
    selectMode: false,
    forwardOpen: false,
    searchTimer: 0,
    results: [],
    selectedMsgIds: new Set(),
    forwarding: false,
  };

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function $all(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[ch]));
  }

  function normalize(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function headerEl() {
    return document.getElementById('chat-header');
  }

  function historyEl() {
    return document.getElementById('historico');
  }

  function onlyDigits(v) {
    return String(v || '').replace(/\D+/g, '');
  }

  function isJid(v) {
    return /@g\.us$/i.test(String(v || '')) || /@s\.whatsapp\.net$/i.test(String(v || ''));
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

  function stripUndefined(obj) {
    Object.keys(obj || {}).forEach((k) => {
      if (obj[k] === undefined) delete obj[k];
    });
    return obj;
  }

  function isMobileHeader() {
    try {
      return window.matchMedia && window.matchMedia('(max-width: 920px)').matches;
    } catch {
      return window.innerWidth <= 920;
    }
  }

  function cleanText(el) {
    return String(el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isUsableButton(btn) {
    if (!btn) return false;
    if (btn.disabled) return false;
    if (btn.hidden) return false;
    if (btn.getAttribute('aria-hidden') === 'true') return false;
    return true;
  }

  function clickExistingButton(selector, fallbackTitle = 'Ação não encontrada') {
    const btn = $(selector);

    if (!btn) {
      toast({
        title: fallbackTitle,
        msg: 'Não encontrei o botão original dessa ação.',
        type: 'error',
      });
      return false;
    }

    closeMenu();

    setTimeout(() => {
      try {
        btn.click();
      } catch (err) {
        console.error('[header-actions] erro ao clicar botão original:', selector, err);
      }
    }, 40);

    return true;
  }

  function getCurrentInstanceText() {
    const status = cleanText($('#status-bateria'));
    if (status) return status;

    const current = cleanText($('#zc-inst-current-label'));
    if (current) return `WhatsApp: ${current}`;

    const activeInst =
      $('#inst-switch .is-active') ||
      $('#inst-switch .ativo') ||
      $('#inst-switch .active') ||
      $('#inst-switch [aria-current="true"]') ||
      $('#inst-switch [aria-selected="true"]');

    const activeText = cleanText(activeInst);
    if (activeText) return `WhatsApp: ${activeText}`;

    return 'WhatsApp atual';
  }

  function openInstanceSelectorFromMenu() {
    closeMenu();

    /*
      No mobile o aside fica escondido quando body.is-chat-open.
      Para trocar WhatsApp, volta para a lista e abre o seletor da instância.
    */
    if (isMobileHeader()) {
      document.body.classList.remove('is-chat-open');
    }

    setTimeout(() => {
      const trigger = $('#zc-inst-trigger');
      if (trigger) {
        try {
          trigger.click();
        } catch {}
      } else {
        toast({
          title: 'Seletor não encontrado',
          msg: 'Não encontrei o botão de trocar WhatsApp.',
          type: 'error',
        });
      }
    }, 160);
  }

  function openNotesOrIaFromMenu() {
    /*
      O botão original do topo é #btn-sobre.
      Mesmo escondido no mobile pelo CSS, o click programático continua funcionando.
    */
    if (clickExistingButton('#btn-sobre', 'Notas/IA não encontrada')) return;

    /*
      Fallback caso algum módulo tenha mudado o botão.
    */
    try {
      if (typeof window.abrirNotasClienteAtual === 'function') {
        closeMenu();
        window.abrirNotasClienteAtual();
        return;
      }

      if (typeof window.abrirIaClienteAtual === 'function') {
        closeMenu();
        window.abrirIaClienteAtual();
        return;
      }
    } catch {}

    toast({
      title: 'IA / Notas não disponível',
      msg: 'Não encontrei a função original para abrir.',
      type: 'error',
    });
  }

  function transferirDepartamentoFromMenu() {
    clickExistingButton('#btnTransferirDepartamento', 'Transferência não encontrada');
  }

  function toast({ title = 'Pronto', msg = '', type = 'ok', timeout = 2600 } = {}) {
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
        <div class="t-title">${escapeHtml(title)}</div>
        ${msg ? `<div class="t-msg">${escapeHtml(msg)}</div>` : ''}
      </div>
      <button class="t-close" aria-label="Fechar">×</button>
    `;
    host.appendChild(el);

    requestAnimationFrame(() => el.classList.add('on'));
    el.querySelector('.t-close')?.addEventListener('click', () => el.remove());
    if (timeout) setTimeout(() => el.remove(), timeout);
  }

  function stringifyErr(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw.trim();

    if (Array.isArray(raw)) {
      return raw.map((item) => stringifyErr(item)).filter(Boolean).join(' | ');
    }

    if (typeof raw === 'object') {
      if (typeof raw.detail === 'string') return raw.detail.trim();
      if (typeof raw.message === 'string') return raw.message.trim();
      if (typeof raw.error === 'string') return raw.error.trim();

      try {
        return JSON.stringify(raw);
      } catch {
        return String(raw);
      }
    }

    return String(raw).trim();
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

  function sameConversation(a, b) {
    const A = conversationRefOf(a, typeof a === 'object' ? a : null);
    const B = conversationRefOf(b, typeof b === 'object' ? b : null);

    if (A?.key && B?.key) return A.key === B.key;
    if (!A?.entityId || !B?.entityId) return false;

    return (
      (A.kind || 'c') === (B.kind || 'c') &&
      A.entityId === B.entityId &&
      String(A.instId || '') === String(B.instId || '')
    );
  }

  function resolveCurrentClienteId() {
    const hist = historyEl();
    const sel = window.state?.clienteSel || window.clienteSel || null;

    const candidates = [
      hist?.dataset?.clienteId,
      hist?.dataset?.entityId,
      hist?.dataset?.id,
      sel?.id,
      sel?.cliente_id,
      sel?.backend_id,
      sel?.entity_id,
      sel?.conversation_id,
      window.CLIENTE_ID_ATUAL,
      window.currentClienteId,
      window.__perfilClienteIdAtual,
    ];

    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }

    return 0;
  }

  function hasOpenChat() {
    return resolveCurrentClienteId() > 0;
  }

  function currentChatTitle() {
    return (
      $('#chat-title')?.textContent?.trim() ||
      $('#chat-header .title')?.textContent?.trim() ||
      $('#chatTitle')?.textContent?.trim() ||
      $('[data-role="chat-title"]')?.textContent?.trim() ||
      $('.chat-title')?.textContent?.trim() ||
      'conversa'
    );
  }

  function getSelectedConversationKey() {
    const hist = historyEl();
    const sel = window.state?.clienteSel || window.clienteSel || null;

    const raw =
      idKey(hist?.dataset?.conversationKey) ||
      idKey(hist?.dataset?.clienteId) ||
      idKey(sel?.conversation_key) ||
      idKey(sel?.conversation_id) ||
      idKey(sel?.id) ||
      null;

    return conversationRefOf(raw, sel).key || null;
  }

  function getConversationPools() {
    return [
      ...(Array.isArray(window.state?.clientesCache) ? window.state.clientesCache : []),
      ...(Array.isArray(window.state?.todosContatosCache) ? window.state.todosContatosCache : []),
      ...(window.state?.clienteSel ? [window.state.clienteSel] : []),
      ...(window.clienteSel ? [window.clienteSel] : []),
    ].filter(Boolean);
  }

  function getConversationByRef(conversationRef = null) {
    const targetKey = conversationRefOf(
      conversationRef ?? getSelectedConversationKey(),
      window.state?.clienteSel || null
    ).key;

    if (!targetKey) return null;

    return getConversationPools().find((x) => sameConversation(x, targetKey)) || null;
  }

  function resolveRawTel(cli) {
    if (!cli) return '';
    if (cli.telefone) return cli.telefone;
    if (cli.whatsapp) return cli.whatsapp;
    if (cli.numero) return cli.numero;
    if (cli.number) return cli.number;
    if (cli.remote_jid) return String(cli.remote_jid);
    if (cli.remoteJid) return String(cli.remoteJid);
    if (cli.jid) return String(cli.jid);
    if (cli.telefone_norm) return cli.telefone_norm;
    return '';
  }

  function toE164(raw) {
    if (!raw) return '';
    if (isJid(raw)) return String(raw).trim();

    const d = onlyDigits(raw);
    if (!d) return '';

    if (d.startsWith('55') && d.length >= 12) return d;
    if (d.length === 10 || d.length === 11) return `55${d}`;
    return d;
  }

  function numberForApi(conversationRef = null) {
    const cli = getConversationByRef(conversationRef);
    const raw = String(resolveRawTel(cli) || '').trim();
    if (!raw) return '';
    if (isJid(raw)) return raw;
    return toE164(raw);
  }

  function getInstanciaAtivaGlobal() {
    return instKey(
      window.getInstanciaAtiva?.() ??
      window.INSTANCIA_ATIVA ??
      null
    );
  }

  function getConversationInstancia(conversationRef = null) {
    const cli = getConversationByRef(conversationRef);
    const ref = conversationRefOf(cli || conversationRef, cli || null);

    return (
      instKey(cli?.instancia_id) ||
      instKey(cli?.instancia) ||
      instKey(cli?.instance_name) ||
      ref.instId ||
      null
    );
  }

  function getInstPayload(conversationRef = null) {
    const inst = getConversationInstancia(conversationRef) || getInstanciaAtivaGlobal();
    if (!inst) return {};

    const n = Number(inst);
    if (Number.isFinite(n) && String(n) === String(inst)) {
      return { instancia_id: n };
    }

    return { instance: String(inst) };
  }

  function getIdentityPayload(conversationRef = null) {
    const cli = typeof conversationRef === 'object' && conversationRef
      ? conversationRef
      : getConversationByRef(conversationRef);

    const ref = conversationRefOf(conversationRef || cli, cli);

    return stripUndefined({
      conversation_key: ref.key || undefined,
      cliente_id: ref.kind === 'c' ? ref.entityId : undefined,
      grupo_id: ref.kind === 'g' ? ref.entityId : undefined,
    });
  }

  async function fetchJsonOrThrow(url, payload) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });

    const respText = await r.text().catch(() => '');
    let respJson = null;
    try {
      respJson = respText ? JSON.parse(respText) : null;
    } catch {}

    if (!r.ok) {
      const rawMsg =
        (respJson && (respJson.detail ?? respJson.message ?? respJson.error)) ||
        respText ||
        null;

      const msg =
        stringifyErr(rawMsg) ||
        (r.status === 400 ? 'Dados inválidos (destino ou instância).' : 'Falha ao enviar.');

      throw new Error(msg);
    }

    return respJson || {};
  }

  function guessMimeFromExt(name) {
    const ext = (name || '').split('.').pop()?.toLowerCase() || '';

    switch (ext) {
      case 'pdf': return 'application/pdf';
      case 'doc': return 'application/msword';
      case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'xls': return 'application/vnd.ms-excel';
      case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      case 'ppt': return 'application/vnd.ms-powerpoint';
      case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      case 'webp': return 'image/webp';
      case 'gif': return 'image/gif';
      case 'mp4': return 'video/mp4';
      case 'mp3': return 'audio/mpeg';
      case 'ogg': return 'audio/ogg';
      case 'wav': return 'audio/wav';
      case 'txt': return 'text/plain';
      default: return 'application/octet-stream';
    }
  }

  function guessMediaType(mime) {
    if (!mime) return 'document';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'document';
  }

  function nameFromUrl(url) {
    try {
      const u = new URL(url, window.location.origin);
      const last = decodeURIComponent((u.pathname || '').split('/').pop() || '').trim();
      return last || 'arquivo';
    } catch {
      return 'arquivo';
    }
  }

  function blobToDataUrl(fileOrBlob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(fileOrBlob);
    });
  }

  function cleanDataUrl(s) {
    if (!s) return '';
    const i = s.indexOf(',');
    return i >= 0 ? s.slice(i + 1).trim() : s.trim();
  }

  async function fetchBlobFromUrl(url) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) {
      throw new Error('Não foi possível ler a mídia original para encaminhar.');
    }
    return resp.blob();
  }

  async function sendTextToConversation(targetConversation, text) {
    const dest = numberForApi(targetConversation);
    const inst = getInstPayload(targetConversation);

    if (!dest) throw new Error('Destino inválido para encaminhar.');
    if (!inst.instancia_id && !inst.instance) throw new Error('Instância não selecionada para a conversa destino.');

    const payload = stripUndefined({
      empresa_id: EMPRESA_ID || undefined,
      ...getIdentityPayload(targetConversation),
      number: dest,
      text,
      ...inst,
    });

    return fetchJsonOrThrow('/api/atendimento/send/text', payload);
  }

  async function sendBlobToConversation(targetConversation, blob, {
    fileName,
    mimeType,
    mediaType,
    caption,
  } = {}) {
    const dest = numberForApi(targetConversation);
    const inst = getInstPayload(targetConversation);

    if (!dest) throw new Error('Destino inválido para encaminhar.');
    if (!inst.instancia_id && !inst.instance) throw new Error('Instância não selecionada para a conversa destino.');

    const finalMime = mimeType || blob.type || guessMimeFromExt(fileName || '');
    const finalType = mediaType || guessMediaType(finalMime);
    const dataUrl = await blobToDataUrl(blob);
    const base64 = cleanDataUrl(dataUrl);

    if (finalType === 'audio') {
      const payload = stripUndefined({
        empresa_id: EMPRESA_ID || undefined,
        ...getIdentityPayload(targetConversation),
        number: dest,
        audio: base64,
        ...inst,
      });
      return fetchJsonOrThrow('/api/atendimento/send/audio', payload);
    }

    const payload = stripUndefined({
      empresa_id: EMPRESA_ID || undefined,
      ...getIdentityPayload(targetConversation),
      number: dest,
      media: base64,
      mediatype: finalType,
      mimetype: finalMime,
      fileName: fileName || undefined,
      caption: caption || undefined,
      ...inst,
    });

    return fetchJsonOrThrow('/api/atendimento/send/media', payload);
  }

  function ensureActionsHost() {
    const hdr = headerEl();
    if (!hdr) return null;

    let host = hdr.querySelector('.zc-chat-actions');
    if (host) return host;

    host = document.createElement('div');
    host.className = 'zc-chat-actions';
    hdr.appendChild(host);
    return host;
  }

  function iconBtn({ id, title, iconHtml, onClick }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.className = 'zc-chat-icon-btn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = iconHtml;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function searchIcon() {
    return `<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>`;
  }

  function dotsIcon() {
    return `<i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i>`;
  }

  function ensureButtons() {
    const host = ensureActionsHost();
    if (!host) return;

    if (!document.getElementById('btn-chat-search')) {
      const btnSearch = iconBtn({
        id: 'btn-chat-search',
        title: 'Pesquisar',
        iconHtml: searchIcon(),
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!hasOpenChat()) {
            toast({ title: 'Selecione uma conversa', type: 'error' });
            return;
          }
          openSearchDrawer();
          closeMenu();
        },
      });
      host.appendChild(btnSearch);
    }

    if (!document.getElementById('btn-chat-more')) {
      const btnMore = iconBtn({
        id: 'btn-chat-more',
        title: 'Mais opções',
        iconHtml: dotsIcon(),
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!hasOpenChat()) {
            toast({ title: 'Selecione uma conversa', type: 'error' });
            return;
          }
          toggleMenu();
        },
      });
      host.appendChild(btnMore);
    }

    ensureSearchDrawer();
    ensureMenu();
    ensureSelectBar();
    ensureForwardDrawer();
  }

  /* =========================================================
     SEARCH DRAWER
     ========================================================= */

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
        <div class="zc-chat-search-drawer-title">Pesquisar mensagens</div>
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
          <div class="zc-chat-search-empty">Digite para pesquisar nesta conversa.</div>
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
      if (input) {
        input.value = '';
        renderSearchEmpty('Digite para pesquisar nesta conversa.');
        clearSearchMarks();
        input.focus();
      }
    });

    input?.addEventListener('input', () => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
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

        await performDrawerSearch({ forceLoadMore: true });
      }
    });

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeSearchDrawer();
    });
  }

  function openSearchDrawer() {
    ensureSearchDrawer();

    const backdrop = document.getElementById('zc-chat-search-backdrop');
    const drawer = document.getElementById('zc-chat-search-drawer');
    const input = document.getElementById('zc-chat-search-input');

    state.searchOpen = true;
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

    state.searchOpen = false;
    backdrop?.classList.remove('is-open');
    drawer?.classList.remove('is-open');

    if (input) input.value = '';
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
      results.innerHTML = `<div class="zc-chat-search-empty">${escapeHtml(text || 'Nenhum resultado.')}</div>`;
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

  function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

    hist.querySelectorAll('.search-hit, .search-hit-fade').forEach((el) => {
      el.classList.remove('search-hit', 'search-hit-fade');
    });

    state.results = [];
  }

  function getDateLabelForRow(row) {
    let prev = row?.previousElementSibling || null;

    while (prev) {
      if (prev.matches?.('.zc-day-divider')) return prev.textContent.trim();
      if (prev.matches?.('.date-chip')) return prev.textContent.trim();
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
    if (txt) return txt;

    if (bubble.querySelector('.msg-media-group, .msg-media-img, .msg-media-video, .wa-audio, .doc-card, .msg-sticker')) {
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
        dateLabel: getDateLabelForRow(row),
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
      if (found.length) return true;
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
        ${item.dateLabel ? `<div class="zc-chat-search-result-date">${escapeHtml(item.dateLabel)}</div>` : ''}
        <div class="zc-chat-search-result-row">
          <div class="zc-chat-search-result-snippet">${highlightQuery(item.snippet || '', query)}</div>
          <div class="zc-chat-search-result-time">${escapeHtml(item.time || '')}</div>
        </div>
      </button>
    `).join('');

    $all('.zc-chat-search-result', results).forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-idx') || '-1');
        if (!Number.isFinite(idx) || idx < 0 || idx >= items.length) return;
        focusSearchResult(items[idx]);
      });
    });
  }

  function findBubbleByMsgId(msgId) {
    if (!msgId) return null;
    try {
      return historyEl()?.querySelector(`.msg-row[data-msg-id="${CSS.escape(String(msgId))}"] .bubble`) || null;
    } catch {
      return null;
    }
  }

  function pulseBubble(bubble) {
    if (!bubble) return;

    clearSearchMarks();
    bubble.classList.add('search-hit');
    bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });

    setTimeout(() => bubble.classList.add('search-hit-fade'), 300);
    setTimeout(() => {
      bubble.classList.remove('search-hit', 'search-hit-fade');
    }, 2400);
  }

  function focusSearchResult(item) {
    if (!item) return;

    const bubble = findBubbleByMsgId(item.msgId) || item.bubbleRef || null;
    if (!bubble) return;

    pulseBubble(bubble);
    closeSearchDrawer();
  }

  async function performDrawerSearch(opts = {}) {
    const input = document.getElementById('zc-chat-search-input');
    const q = (input?.value || '').trim();

    if (!q) {
      renderSearchEmpty('Digite para pesquisar nesta conversa.');
      return;
    }

    renderSearchLoading();

    let items = collectRenderedMatches(q);

    if ((!items.length || opts.forceLoadMore) && typeof window.carregarMaisHistorico === 'function') {
      await tryLoadMoreForQuery(q, 8);
      items = collectRenderedMatches(q);
    }

    state.results = items;
    renderSearchResults(q, items);
  }

  /* =========================================================
     SELECT MODE
     ========================================================= */

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
        <button type="button" class="zc-selectbar-btn" id="zc-selectbar-close" aria-label="Cancelar seleção" title="Cancelar seleção">
          <i class="fa-solid fa-xmark"></i>
        </button>

        <div class="zc-selectbar-count">
          <strong id="zc-selectbar-count-num">0</strong>
          <span id="zc-selectbar-count-text">mensagens selecionadas</span>
        </div>
      </div>

      <div class="zc-selectbar-actions">
        <button type="button" class="zc-selectbar-btn" id="zc-selectbar-forward" aria-label="Encaminhar" title="Encaminhar" disabled>
          <i class="fa-solid fa-share"></i>
        </button>
      </div>
    `;
    hdr.appendChild(bar);

    $('#zc-selectbar-close', bar)?.addEventListener('click', stopSelectionMode);
    $('#zc-selectbar-forward', bar)?.addEventListener('click', () => {
      if (!state.selectedMsgIds.size) {
        toast({ title: 'Selecione pelo menos uma mensagem', type: 'error' });
        return;
      }
      openForwardDrawer();
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

    const count = state.selectedMsgIds.size;

    if (bar) {
      bar.hidden = !state.selectMode;
      bar.classList.toggle('is-open', !!state.selectMode);
    }

    if (hist) hist.classList.toggle('zc-select-mode', !!state.selectMode);

    if (num) num.textContent = String(count);
    if (txt) txt.textContent = count === 1 ? 'mensagem selecionada' : 'mensagens selecionadas';
    if (fwd) fwd.disabled = !count || state.forwarding;
  }

  function toggleRowSelection(row, force = null) {
    const msgId = rowMsgId(row);
    if (!msgId) return;

    const shouldSelect = force == null
      ? !state.selectedMsgIds.has(msgId)
      : !!force;

    if (shouldSelect) {
      state.selectedMsgIds.add(msgId);
      row.classList.add('is-selected');
    } else {
      state.selectedMsgIds.delete(msgId);
      row.classList.remove('is-selected');
    }

    syncSelectBar();
  }

  function clearSelections() {
    state.selectedMsgIds.clear();
    getSelectableRows().forEach((row) => {
      row.classList.remove('is-selected');
    });
    syncSelectBar();
  }

  function startSelectionMode() {
    if (!hasOpenChat()) {
      toast({ title: 'Selecione uma conversa', type: 'error' });
      return;
    }

    ensureSelectBar();
    ensureRowChecks();
    closeMenu();
    closeSearchDrawer();
    closeForwardDrawer();

    state.selectMode = true;
    clearSelections();
    syncSelectBar();
  }

  function stopSelectionMode() {
    state.selectMode = false;
    clearSelections();
    closeForwardDrawer();
    syncSelectBar();
  }

  function bindSelectModeHistory() {
    const hist = historyEl();
    if (!hist || hist.__zcSelectBound) return;
    hist.__zcSelectBound = true;

    hist.addEventListener('click', (e) => {
      if (!state.selectMode) return;

      const row = e.target.closest('.msg-row');
      if (!row || row.getAttribute('data-cluster-hidden') === '1') return;

      e.preventDefault();
      e.stopPropagation();

      toggleRowSelection(row);
    }, true);
  }

  function getSelectedRowsInVisualOrder() {
    const ids = state.selectedMsgIds;
    return getSelectableRows().filter((row) => ids.has(rowMsgId(row)));
  }

  function getBubbleForwardText(bubble) {
    const txt = bubble?.querySelector('.msg-text')?.textContent || '';
    const clean = String(txt).replace(/\u00A0/g, ' ').trim();
    if (!clean) return '';
    if (/^\[[^\]]+\]$/i.test(clean)) return '';
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

    const imageAnchors = $all('[data-media-view="1"][data-media-kind="image"]', bubble);
    imageAnchors.forEach((a, idx) => {
      const url = a.getAttribute('data-media-src') || a.getAttribute('href') || '';
      const fileName = a.getAttribute('data-media-name') || nameFromUrl(url) || `imagem-${idx + 1}.jpg`;
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
      const url = v.currentSrc || v.getAttribute('src') || '';
      const fileName = nameFromUrl(url) || `video-${idx + 1}.mp4`;
      out.push({
        type: 'media',
        mediaType: 'video',
        url,
        fileName,
        mimeType: v.getAttribute('type') || guessMimeFromExt(fileName) || 'video/mp4',
        caption: !out.length && idx === 0 ? caption : undefined,
      });
    });

    const audios = $all('.wa-audio', bubble);
    audios.forEach((a, idx) => {
      const srcs = String(a.getAttribute('data-src') || '').split('|').filter(Boolean);
      const url = srcs[0] || '';
      const fileName = nameFromUrl(url) || `audio-${idx + 1}.ogg`;
      out.push({
        type: 'media',
        mediaType: 'audio',
        url,
        fileName,
        mimeType: guessMimeFromExt(fileName) || 'audio/ogg',
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
      const fileName = nameFromUrl(url) || `figurinha-${idx + 1}.webp`;
      out.push({
        type: 'media',
        mediaType: 'image',
        url,
        fileName,
        mimeType: img.getAttribute('type') || guessMimeFromExt(fileName) || 'image/webp',
      });
    });

    const items = dedupeByUrl(out);
    if (items.length) return items;

    if (caption) {
      return [{ type: 'text', text: caption }];
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

  /* =========================================================
     FORWARD DRAWER
     ========================================================= */

  function ensureForwardDrawer() {
    if (document.getElementById('zc-forward-backdrop')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'zc-forward-backdrop';
    backdrop.className = 'zc-forward-backdrop';

    const drawer = document.createElement('aside');
    drawer.id = 'zc-forward-drawer';
    drawer.className = 'zc-forward-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Encaminhar mensagens');

    drawer.innerHTML = `
      <div class="zc-forward-head">
        <button class="zc-forward-close" type="button" aria-label="Fechar">
          <i class="fa-solid fa-arrow-left"></i>
        </button>
        <div class="zc-forward-title-wrap">
          <div class="zc-forward-title">Encaminhar para</div>
          <div class="zc-forward-sub" id="zc-forward-sub">0 mensagens</div>
        </div>
      </div>

      <div class="zc-forward-toolbar">
        <div class="zc-forward-input-wrap">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
          <input
            id="zc-forward-input"
            class="zc-forward-input"
            type="text"
            placeholder="Pesquisar conversa"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
      </div>

      <div class="zc-forward-body">
        <div id="zc-forward-list" class="zc-forward-list"></div>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    $('.zc-forward-close', drawer)?.addEventListener('click', closeForwardDrawer);

    $('#zc-forward-input', drawer)?.addEventListener('input', () => {
      renderForwardList();
    });

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeForwardDrawer();
    });
  }

  function closeForwardDrawer() {
    state.forwardOpen = false;
    $('#zc-forward-backdrop')?.classList.remove('is-open');
    $('#zc-forward-drawer')?.classList.remove('is-open');
  }

  function openForwardDrawer() {
    ensureForwardDrawer();

    const count = state.selectedMsgIds.size;
    $('#zc-forward-sub').textContent = count === 1 ? '1 mensagem' : `${count} mensagens`;

    state.forwardOpen = true;
    $('#zc-forward-backdrop')?.classList.add('is-open');
    $('#zc-forward-drawer')?.classList.add('is-open');

    const input = $('#zc-forward-input');
    if (input) input.value = '';

    renderForwardList();

    setTimeout(() => input?.focus(), 40);
  }

  function getConversationCandidates() {
    const currentKey = getSelectedConversationKey();
    const pools = getConversationPools();
    const map = new Map();

    pools.forEach((item) => {
      const ref = conversationRefOf(item, item);
      if (!ref?.key || !ref.entityId) return;

      const name =
        String(
          item.nome_whatsapp ||
          item.nome ||
          item.title ||
          item.subject ||
          item.telefone_fmt ||
          item.telefone ||
          ''
        ).trim();

      const phone =
        String(item.telefone_fmt || item.telefone || item.numero || '').trim();

      const subtitle =
        String(item.ultima_mensagem || item.last_message || item.last || phone || '').trim();

      map.set(ref.key, {
        refKey: ref.key,
        kind: ref.kind,
        entityId: ref.entityId,
        instId: ref.instId,
        raw: item,
        name: name || phone || 'Conversa',
        phone,
        subtitle,
        isCurrent: currentKey ? sameConversation(ref.key, currentKey) : false,
      });
    });

    return Array.from(map.values())
      .sort((a, b) => {
        if (a.isCurrent && !b.isCurrent) return -1;
        if (!a.isCurrent && b.isCurrent) return 1;
        return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
      });
  }

  function renderForwardList() {
    const list = $('#zc-forward-list');
    const query = normalize($('#zc-forward-input')?.value || '');
    if (!list) return;

    const items = getConversationCandidates().filter((item) => {
      if (!query) return true;
      return (
        normalize(item.name).includes(query) ||
        normalize(item.phone).includes(query) ||
        normalize(item.subtitle).includes(query)
      );
    });

    if (!items.length) {
      list.innerHTML = `<div class="zc-forward-empty">Nenhuma conversa encontrada.</div>`;
      return;
    }

    list.innerHTML = items.map((item) => `
      <button
        type="button"
        class="zc-forward-item${item.isCurrent ? ' is-current' : ''}"
        data-conversation-key="${escapeHtml(item.refKey)}"
      >
        <span class="zc-forward-avatar">
          <i class="fa-regular fa-user"></i>
        </span>

        <span class="zc-forward-main">
          <span class="zc-forward-name">${escapeHtml(item.name)}</span>
          <span class="zc-forward-subtitle">${escapeHtml(item.subtitle || item.phone || '')}</span>
        </span>

        ${item.isCurrent ? `<span class="zc-forward-badge">atual</span>` : ''}
      </button>
    `).join('');

    $all('.zc-forward-item', list).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const refKey = btn.getAttribute('data-conversation-key');
        if (!refKey) return;
        await handleForwardToConversation(refKey, btn);
      });
    });
  }

  async function handleForwardToConversation(targetConversationKey, clickedBtn) {
    if (state.forwarding) return;

    const items = collectForwardItemsFromSelection();
    if (!items.length) {
      toast({
        title: 'Nada para encaminhar',
        msg: 'As mensagens selecionadas não têm conteúdo encaminhável.',
        type: 'error',
      });
      return;
    }

    const target = getConversationByRef(targetConversationKey);
    if (!target) {
      toast({ title: 'Destino inválido', type: 'error' });
      return;
    }

    const dest = numberForApi(targetConversationKey);
    const inst = getInstPayload(targetConversationKey);

    if (!dest) {
      toast({ title: 'Destino sem telefone válido', type: 'error' });
      return;
    }

    if (!inst.instancia_id && !inst.instance) {
      toast({ title: 'A conversa destino não tem instância definida', type: 'error' });
      return;
    }

    state.forwarding = true;
    syncSelectBar();

    const buttons = $all('.zc-forward-item', $('#zc-forward-list'));
    buttons.forEach((b) => { b.disabled = true; });
    if (clickedBtn) clickedBtn.classList.add('is-loading');

    toast({
      title: 'Encaminhando...',
      msg: `${items.length} item(ns)`,
      type: 'ok',
      timeout: 1600,
    });

    try {
      for (const item of items) {
        if (item.type === 'text') {
          await sendTextToConversation(targetConversationKey, item.text);
          await sleep(120);
          continue;
        }

        const blob = await fetchBlobFromUrl(item.url);
        await sendBlobToConversation(targetConversationKey, blob, {
          fileName: item.fileName,
          mimeType: item.mimeType || blob.type,
          mediaType: item.mediaType,
          caption: item.caption,
        });
        await sleep(120);
      }

      toast({
        title: 'Encaminhado',
        msg: items.length === 1 ? '1 item encaminhado.' : `${items.length} itens encaminhados.`,
        type: 'ok',
      });

      closeForwardDrawer();
      stopSelectionMode();
    } catch (err) {
      console.error('[header-actions][forward] erro', err);
      toast({
        title: 'Erro ao encaminhar',
        msg: err?.message || 'Falha ao encaminhar mensagens.',
        type: 'error',
        timeout: 3600,
      });
    } finally {
      state.forwarding = false;
      syncSelectBar();
      buttons.forEach((b) => { b.disabled = false; });
      clickedBtn?.classList.remove('is-loading');
    }
  }

  /* =========================================================
     MENU
     ========================================================= */

  function menuItems() {
    const items = [];

    /*
      No mobile, o topo fica limpo.
      Então colocamos aqui as ações que foram escondidas via CSS:
      - IA / Notas
      - Transferir departamento
      - Instância atual
      - Trocar WhatsApp
    */
    if (isMobileHeader()) {
      items.push(
        {
          label: 'IA / Notas do cliente',
          icon: 'fa-solid fa-wand-magic-sparkles',
          action() {
            openNotesOrIaFromMenu();
          },
        },
        {
          label: 'Transferir departamento',
          icon: 'fa-solid fa-arrow-right-arrow-left',
          action() {
            transferirDepartamentoFromMenu();
          },
        }
      );

      const btnAccept = $('#btnAceitarConversa');
      const btnRelease = $('#btnLiberarConversa');
      const btnTransfer = $('#btnTransferirColaborador');

      if (isUsableButton(btnAccept)) {
        items.push({
          label: 'Aceitar conversa',
          icon: 'fa-solid fa-check',
          action() {
            clickExistingButton('#btnAceitarConversa', 'Aceite não encontrado');
          },
        });
      }

      if (isUsableButton(btnRelease)) {
        items.push({
          label: 'Liberar conversa',
          icon: 'fa-solid fa-unlock',
          action() {
            clickExistingButton('#btnLiberarConversa', 'Liberação não encontrada');
          },
        });
      }

      if (isUsableButton(btnTransfer)) {
        items.push({
          label: 'Transferir atendente',
          icon: 'fa-solid fa-user-plus',
          action() {
            clickExistingButton('#btnTransferirColaborador', 'Transferência não encontrada');
          },
        });
      }

      items.push(
        { divider: true },
        {
          label: getCurrentInstanceText(),
          icon: 'fa-brands fa-whatsapp',
          disabled: true,
          action() {},
        },
        {
          label: 'Trocar WhatsApp',
          icon: 'fa-solid fa-repeat',
          action() {
            openInstanceSelectorFromMenu();
          },
        },
        { divider: true }
      );
    }

    items.push(
      {
        label: 'Dados do contato',
        icon: 'fa-regular fa-circle-user',
        action() {
          const clienteId = resolveCurrentClienteId();

          if (!clienteId) {
            toast({ title: 'Selecione uma conversa', type: 'error' });
            return;
          }

          if (typeof window.abrirPerfilAtual === 'function') {
            window.abrirPerfilAtual({ cliente_id: clienteId });
          } else {
            toast({ title: 'Função abrirPerfilAtual não encontrada', type: 'error' });
          }
        },
      },
      {
        label: 'Pesquisar',
        icon: 'fa-solid fa-magnifying-glass',
        action() {
          openSearchDrawer();
        },
      },
      {
        label: 'Selecionar mensagens',
        icon: 'fa-regular fa-square-check',
        action() {
          startSelectionMode();
        },
      },
      { divider: true },
      {
        label: 'Silenciar notificações',
        icon: 'fa-regular fa-bell-slash',
        action() {
          toast({ title: 'Ainda não implementado', msg: 'Essa ação ainda não foi ligada no backend.', type: 'error' });
        },
      },
      {
        label: 'Mensagens temporárias',
        icon: 'fa-regular fa-clock',
        action() {
          toast({ title: 'Ainda não implementado', msg: 'Essa ação ainda não foi ligada no backend.', type: 'error' });
        },
      },
      {
        label: 'Adicionar aos Favoritos',
        icon: 'fa-regular fa-heart',
        action() {
          toast({ title: 'Ainda não implementado', msg: 'Essa ação ainda não foi ligada no backend.', type: 'error' });
        },
      },
      {
        label: 'Adicionar à lista',
        icon: 'fa-regular fa-rectangle-list',
        action() {
          toast({ title: 'Ainda não implementado', msg: 'Essa ação ainda não foi ligada no backend.', type: 'error' });
        },
      },
      {
        label: 'Fechar conversa',
        icon: 'fa-regular fa-circle-xmark',
        action() {
          if (typeof window.fecharChatAtual === 'function') {
            window.fecharChatAtual();
          } else {
            toast({ title: 'Ainda não implementado', msg: 'Função fecharChatAtual não encontrada.', type: 'error' });
          }
        },
      },
      { divider: true },
      {
        label: 'Denunciar',
        icon: 'fa-regular fa-flag',
        action() {
          toast({ title: 'Ainda não implementado', msg: 'Essa ação ainda não foi ligada no backend.', type: 'error' });
        },
      },
      {
        label: 'Bloquear',
        icon: 'fa-solid fa-ban',
        action() {
          toast({ title: 'Ainda não implementado', msg: 'Essa ação ainda não foi ligada no backend.', type: 'error' });
        },
      },
      {
        label: 'Limpar conversa',
        icon: 'fa-regular fa-trash-can',
        action() {
          toast({ title: 'Ainda não implementado', msg: 'Essa ação ainda não foi ligada no backend.', type: 'error' });
        },
      },
      {
        label: 'Apagar conversa',
        icon: 'fa-regular fa-trash-can',
        danger: true,
        action() {
          toast({ title: 'Ainda não implementado', msg: 'Essa ação ainda não foi ligada no backend.', type: 'error' });
        },
      }
    );

    return items;
  }

  function ensureMenu() {
    let menu = document.getElementById('zc-chat-more-menu');
    if (menu) return menu;

    menu = document.createElement('div');
    menu.id = 'zc-chat-more-menu';
    menu.className = 'zc-chat-more-menu';
    menu.hidden = true;

    document.body.appendChild(menu);

    window.addEventListener('resize', positionMenu, { passive: true });
    window.addEventListener('scroll', positionMenu, { passive: true });

    return menu;
  }

  function renderMenu() {
    const menu = ensureMenu();
    if (!menu) return null;

    const defsAll = menuItems();

    menu.innerHTML = defsAll.map((item) => {
      if (item.divider) {
        return `<div class="zc-chat-menu-divider"></div>`;
      }

      return `
        <button
          type="button"
          class="zc-chat-menu-item${item.danger ? ' is-danger' : ''}${item.disabled ? ' is-disabled' : ''}"
          data-label="${escapeHtml(item.label)}"
          ${item.disabled ? 'disabled aria-disabled="true"' : ''}
        >
          <span class="zc-chat-menu-icon"><i class="${escapeHtml(item.icon)}"></i></span>
          <span class="zc-chat-menu-text">${escapeHtml(item.label)}</span>
        </button>
      `;
    }).join('');

    const allItems = $all('.zc-chat-menu-item', menu);
    const defs = defsAll.filter((x) => !x.divider);

    allItems.forEach((btn, idx) => {
      const def = defs[idx];

      if (!def || def.disabled) return;

      btn.addEventListener('click', () => {
        closeMenu();
        def.action?.();
      });
    });

    return menu;
  }

  function positionMenu() {
    const menu = document.getElementById('zc-chat-more-menu');
    const btn = document.getElementById('btn-chat-more');
    if (!menu || !btn || menu.hidden) return;

    const rect = btn.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 24);

    menu.style.width = `${width}px`;

    requestAnimationFrame(() => {
      const mw = menu.offsetWidth || width;
      let left = rect.right - mw;
      left = Math.max(12, Math.min(left, window.innerWidth - mw - 12));

      menu.style.left = `${left}px`;
      menu.style.top = `${rect.bottom + 8}px`;
    });
  }

  function openMenu() {
    const menu = renderMenu();
    if (!menu) return;

    state.menuOpen = true;
    menu.hidden = false;
    positionMenu();
  }

  function closeMenu() {
    const menu = document.getElementById('zc-chat-more-menu');
    if (!menu) return;

    state.menuOpen = false;
    menu.hidden = true;
  }

  function toggleMenu() {
    if (state.menuOpen) closeMenu();
    else openMenu();
  }

  /* =========================================================
     GLOBAL EVENTS
     ========================================================= */

  function bindGlobalEvents() {
    if (document.__zcChatHeaderActionsBound) return;
    document.__zcChatHeaderActionsBound = true;

    document.addEventListener('click', (e) => {
      const inMenu = e.target.closest('#zc-chat-more-menu');
      const onMenuBtn = e.target.closest('#btn-chat-more');

      if (!inMenu && !onMenuBtn) closeMenu();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (state.menuOpen) {
          closeMenu();
          return;
        }
        if (state.forwardOpen) {
          closeForwardDrawer();
          return;
        }
        if (state.searchOpen) {
          closeSearchDrawer();
          return;
        }
        if (state.selectMode) {
          stopSelectionMode();
        }
      }
    });

    document.addEventListener('cliente:selecionar', () => {
      closeMenu();
      closeSearchDrawer();
      closeForwardDrawer();
      stopSelectionMode();
    });

    document.addEventListener('zc:open_chat', () => {
      closeMenu();
      closeSearchDrawer();
      closeForwardDrawer();
      stopSelectionMode();
    });

    document.addEventListener('chat:open', () => {
      closeMenu();
      closeSearchDrawer();
      closeForwardDrawer();
      stopSelectionMode();
    });

    window.addEventListener('resize', () => {
      ensureRowChecks();

      if (state.menuOpen) {
        renderMenu();
        positionMenu();
      }
    }, { passive: true });
  }

  function watchHeader() {
    const boot = () => {
      ensureButtons();
      ensureSearchDrawer();
      ensureMenu();
      ensureSelectBar();
      ensureForwardDrawer();
      bindSelectModeHistory();
      ensureRowChecks();
    };

    boot();

    const hdr = headerEl();
    if (hdr && !hdr.__zcHeaderActionsObs) {
      hdr.__zcHeaderActionsObs = true;
      const mo = new MutationObserver(() => {
        ensureButtons();
        ensureSelectBar();
      });
      mo.observe(hdr, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    }

    const hist = historyEl();
    if (hist && !hist.__zcHeaderActionsHistObs) {
      hist.__zcHeaderActionsHistObs = true;
      const mo = new MutationObserver(() => {
        bindSelectModeHistory();
        if (state.selectMode) ensureRowChecks();
      });
      mo.observe(hist, {
        childList: true,
        subtree: true,
      });
    }

    if (!window.__zcHeaderActionsEnsureInt) {
      window.__zcHeaderActionsEnsureInt = setInterval(() => {
        ensureButtons();
        bindSelectModeHistory();
        if (state.selectMode) ensureRowChecks();
      }, 1200);
    }
  }

  function start() {
    bindGlobalEvents();
    watchHeader();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();