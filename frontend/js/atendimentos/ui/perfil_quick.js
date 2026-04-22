// /frontend/js/atendimentos/ui/perfil_quick.js
// Painel RÁPIDO de perfil — abre só ao clicar no NOME/FOTO do header.
// - Nome vem SOMENTE do BD.
// - Ao abrir, chama /api/atendimento/clientes/:id/profile?empresa_id=...
// - Atualiza APENAS o nome no cache e no header.
// - Avatar não faz refresh automático no onerror; falhou => ícone.
// - refreshAvatarFromEvolution fica manual/diário.
// - Helpers para aplicar avatar no DOM sem re-render pesado.
// ✅ alinhado com conversation_key canônica:
//    c:<cliente_id>:<instancia_id> e g:<grupo_id>:<instancia_id>
// ✅ se o BD vier sem avatar, busca automaticamente na Evolution ao abrir.
// ✅ se o avatar 404, limpa do cache para não ficar repetindo request.

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);

  function ensureToast(msg, type = 'ok') {
    if (typeof window.toast === 'function') {
      window.toast({
        title: type === 'ok' ? 'Pronto' : 'Erro',
        msg,
        type: type === 'ok' ? 'ok' : 'error',
      });
      return;
    }
    if (type === 'ok') console.log('[perfil_quick]', msg);
    else console.error('[perfil_quick]', msg);
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

  function onlyDigits(v) {
    return String(v || '').replace(/\D+/g, '');
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

  function sameConversation(a, b) {
    const A = conversationRefOf(a, typeof a === 'object' ? a : null);
    const B = conversationRefOf(b, typeof b === 'object' ? b : null);

    if (!A?.key || !B?.key) return false;
    if (A.key === B.key) return true;

    if (!A.entityId || !B.entityId) return false;
    if ((A.kind || 'c') !== (B.kind || 'c')) return false;

    const aInst = A.instId || '';
    const bInst = B.instId || '';
    return A.entityId === B.entityId && aInst === bInst;
  }

  function pickProfileAvatar(obj) {
    const candidates = [
      obj?.avatar_url,
      obj?.picture,
      obj?.profilePictureUrl,
      obj?.profilePicUrl,
      obj?.pictureUrl,
      obj?.avatar_remote_url,
      obj?.imgUrl,
    ];

    for (const v of candidates) {
      const s = String(v || '').trim();
      if (s && !/^(null|undefined|about:blank)$/i.test(s)) return s;
    }
    return null;
  }

  function getSelectedConversationRef() {
    const hist = $('#historico');
    const head = $('#chat-header');
    const row = window.state?.clienteSel || window.clienteSel || null;

    const raw =
      idKey(hist?.dataset?.conversationKey) ||
      idKey(hist?.dataset?.clienteId) ||
      idKey(head?.dataset?.conversationKey) ||
      idKey(row?.conversation_key) ||
      idKey(row?.conversation_id) ||
      idKey(row?.id) ||
      null;

    return conversationRefOf(raw, row).key || null;
  }

  function getSelectedKind() {
    const hist = $('#historico');
    const head = $('#chat-header');
    const row = window.state?.clienteSel || window.clienteSel || null;

    const direct =
      idKey(hist?.dataset?.kind) ||
      idKey(head?.dataset?.kind) ||
      idKey(row?.kind) ||
      null;

    if (direct && /^(c|g)$/i.test(direct)) return direct.toLowerCase();

    return conversationRefOf(getSelectedConversationRef(), row).kind || 'c';
  }

  function getClienteId() {
    const hist = $('#historico');
    const head = $('#chat-header');
    const row = window.state?.clienteSel || window.clienteSel || null;

    const direct =
      idKey(hist?.dataset?.entityId) ||
      idKey(head?.dataset?.entityId) ||
      idKey(row?.entity_id) ||
      idKey(row?.backend_id) ||
      idKey(row?.api_id) ||
      null;

    if (direct && /^\d+$/.test(direct)) return direct;

    const ref = conversationRefOf(getSelectedConversationRef(), row);
    if (ref.kind !== 'c') return null;

    return ref.entityId || null;
  }

  function getCurrentConversationForPatch() {
    const row = window.state?.clienteSel || window.clienteSel || null;
    const ref = conversationRefOf(getSelectedConversationRef(), row);
    return ref.key || null;
  }

  function fmtDateTimeISO(v) {
    if (!v) return '';
    try {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return '';
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
    } catch {
      return '';
    }
  }

  function getInstanciaAtivaSafe() {
    const sel = window.state?.clienteSel || null;
    const inst =
      instKey(sel?.instancia_id) ||
      instKey(sel?.instancia) ||
      instKey(window.INSTANCIA_ATIVA) ||
      null;

    if (!inst) {
      return { instancia_id: undefined, instance: undefined };
    }

    if (/^\d+$/.test(String(inst))) {
      return { instancia_id: Number(inst), instance: undefined };
    }

    return { instancia_id: undefined, instance: String(inst) };
  }

  function resolveInstOpt(raw) {
    try {
      if (raw == null) return { instancia_id: undefined, instance: undefined };

      if (typeof raw === 'object') {
        const iid = Number(raw.id || raw.instancia_id || raw.instance_id || 0) || undefined;
        const name = raw.instance_name || raw.name || raw.instancia || raw.instance || undefined;
        return { instancia_id: iid, instance: name };
      }

      const s = String(raw).trim();
      if (!s) return { instancia_id: undefined, instance: undefined };
      if (/^\d+$/.test(s)) return { instancia_id: Number(s), instance: undefined };
      return { instancia_id: undefined, instance: s };
    } catch {
      return { instancia_id: undefined, instance: undefined };
    }
  }

  function clearAvatarFromCaches(clienteId) {
    try {
      const cid = idKey(clienteId);
      if (!cid) return;

      const st = window.state || {};
      const patch = { avatar_url: null, avatar_remote_url: null };

      const lists = [st.clientesCache, st.todosContatosCache];
      lists.forEach((arr) => {
        if (!Array.isArray(arr)) return;
        arr.forEach((item, idx) => {
          const ref = conversationRefOf(item, item);
          if (ref.kind === 'c' && ref.entityId === cid) {
            arr[idx] = { ...item, ...patch };
          }
        });
      });

      if (st.clienteSel) {
        const ref = conversationRefOf(st.clienteSel, st.clienteSel);
        if (ref.kind === 'c' && ref.entityId === cid) Object.assign(st.clienteSel, patch);
      }

      try { window.persist?.(); } catch {}
    } catch (e) {
      console.warn('[perfil_quick] clearAvatarFromCaches falhou:', e);
    }
  }

  const skeletonHTML = () => `
    <div class="qcHero">
      <div class="avatar qcSkeleton"></div>
      <div class="info">
        <div class="qcSk-name qcSkeleton"></div>
        <div class="qcSk-line qcSk-line--120 qcSkeleton"></div>
      </div>
    </div>

    <div class="qcCard">
      <div class="label">Resumo</div>
      <div class="qcMetaGrid">
        <div class="qcMetaItem">
          <div class="label">Status</div>
          <div class="content qcSk-line qcSkeleton"></div>
        </div>
        <div class="qcMetaItem">
          <div class="label">Atualizado em</div>
          <div class="content qcSk-line qcSkeleton"></div>
        </div>
      </div>
    </div>
  `;

  async function getTelefoneAsync(forClienteId) {
    const hist = $('#historico');
    const cands = [
      hist?.dataset?.telefone,
      hist?.dataset?.phone,
      hist?.dataset?.number,
      $('#chat-header [data-phone]')?.getAttribute?.('data-phone'),
      $('#chat-header')?.getAttribute?.('data-phone'),
    ];

    for (const v of cands) {
      if (v && /\d{10,}/.test(v)) return v;
    }

    const txt = $('#chat-header')?.textContent || '';
    const m = txt.match(/(\d{10,15})/);
    if (m) return m[1];

    const cid = idKey(forClienteId || getClienteId() || '');
    if (cid && EMPRESA_ID) {
      try {
        const r = await fetch(`/api/atendimento/clientes/${cid}/profile?empresa_id=${EMPRESA_ID}`, {
          credentials: 'include',
        });
        if (r.ok) {
          const j = await r.json();
          if (j?.telefone) return j.telefone;
        }
      } catch {}
    }

    return '';
  }

  function updateHeaderNameFromBD(patch) {
    const display =
      (patch?.nome_whatsapp && String(patch.nome_whatsapp).trim()) ||
      (patch?.nome && String(patch.nome).trim()) ||
      '';

    if (!display) return;

    const nodes = [
      document.getElementById('chat-title'),
      document.querySelector('[data-role="contact-name"]'),
    ].filter(Boolean);

    nodes.forEach((n) => {
      n.textContent = display;
    });
  }

  function patchClienteCacheNameOnly(conversationRef, bd) {
    try {
      const st = window.state || {};
      const selectedKey = conversationRefOf(conversationRef, st?.clienteSel || null).key;
      if (!selectedKey) return;

      const patch = {
        nome: bd?.nome ?? undefined,
        nome_whatsapp: bd?.nome_whatsapp ?? undefined,
        is_business: typeof bd?.is_business === 'boolean' ? bd.is_business : undefined,
        status_whatsapp: bd?.status_text ?? undefined,
        descricao: bd?.description ?? undefined,
        website: bd?.website ?? undefined,
        email: bd?.email ?? undefined,
      };

      const lists = [st.clientesCache, st.todosContatosCache];
      lists.forEach((arr) => {
        if (!Array.isArray(arr)) return;
        const idx = arr.findIndex((x) => sameConversation(x, selectedKey));
        if (idx >= 0) arr[idx] = { ...arr[idx], ...patch };
      });

      if (st.clienteSel && sameConversation(st.clienteSel, selectedKey)) {
        Object.assign(st.clienteSel, patch);
      }

      updateHeaderNameFromBD(patch);

      if (typeof window.persist === 'function') window.persist();
      try { window.renderListaClientes?.(st.clientesCache || []); } catch {}
      try { window.syncPreviewFromCache?.(selectedKey); } catch {}
    } catch (e) {
      console.warn('[perfil_quick] patchClienteCacheNameOnly falhou:', e);
    }
  }

  function buildDrawer() {
    if (document.getElementById('qcBackdrop')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'qcBackdrop';
    backdrop.className = 'qcBackdrop';

    const drawer = document.createElement('aside');
    drawer.id = 'qcDrawer';
    drawer.className = 'qcDrawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');

    drawer.innerHTML = `
      <div class="qcHead">
        <div class="qcTitle">Perfil do WhatsApp</div>
        <button class="qcClose" id="qcClose" title="Fechar" aria-label="Fechar">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 256 256">
            <path fill="currentColor" d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66A8 8 0 0 1 61.66 50.34L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128z"/>
          </svg>
        </button>
      </div>
      <div class="qcBody" id="qcBody">${skeletonHTML()}</div>
    `;

    document.body.append(backdrop, drawer);

    const close = () => {
      backdrop.classList.remove('is-open');
      drawer.classList.remove('is-open');
    };

    document.getElementById('qcClose')?.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    window.__qcPerfil = {
      open: () => {
        backdrop.classList.add('is-open');
        drawer.classList.add('is-open');
      },
      close,
      setBody(html) {
        const b = $('#qcBody');
        if (b) b.innerHTML = html;
      },
      isOpen: () => document.getElementById('qcDrawer')?.classList.contains('is-open'),
      setSkeleton: () => {
        const b = $('#qcBody');
        if (b) b.innerHTML = skeletonHTML();
      },
    };
  }

  function wireDrawerAvatarFallback(clienteId) {
    try {
      const drawer = document.getElementById('qcDrawer');
      if (!drawer) return;

      const img = drawer.querySelector('.qcAvatarImg');
      if (!img) return;

      img.addEventListener('error', () => {
        try {
          const parent = img.parentElement;
          img.remove();

          const span = document.createElement('span');
          span.className = 'avatar qcAvatarFallback';
          span.innerHTML = '<i class="fa fa-user-circle"></i>';

          if (parent) parent.insertBefore(span, parent.firstChild);
        } catch {}

        try {
          clearAvatarFromCaches(clienteId);
        } catch {}
      }, { once: true });
    } catch {}
  }

  function renderProfileFromBD(bd) {
    const name = (bd?.nome_whatsapp || bd?.nome || '').trim();
    const isBiz = !!bd?.is_business;
    const statusTxt = (bd?.status_text || '').trim();
    const statusAt = bd?.status_at ? fmtDateTimeISO(bd.status_at) : '';
    const pic = pickProfileAvatar(bd);
    const desc = (bd?.description || bd?.descricao || '').trim();
    const site = (bd?.website || '').trim();
    const email = (bd?.email || '').trim();
    const phoneShown = ($('#historico')?.dataset?.telefone || bd?.telefone || '').trim();

    const avatarHTML = pic
      ? `<img class="avatar qcAvatarImg" alt="" src="${esc(pic)}">`
      : `<span class="avatar qcAvatarFallback" aria-hidden="true"><i class="fa fa-user-circle"></i></span>`;

    return `
      <div class="qcHero">
        ${avatarHTML}
        <div class="info">
          <div class="qcName">${esc(name || '—')}</div>
          <div class="qcPhone">${esc(phoneShown || '—')}</div>
          ${isBiz ? `<div class="qcBadge" title="Conta comercial">Conta comercial</div>` : ''}
        </div>
      </div>

      <div class="qcCard">
        <div class="label">Resumo</div>
        <div class="qcMetaGrid">
          <div class="qcMetaItem">
            <div class="label">Status</div>
            <div class="content">${esc(statusTxt || '—')}</div>
          </div>
          ${statusAt ? `
            <div class="qcMetaItem">
              <div class="label">Atualizado em</div>
              <div class="content">${esc(statusAt)}</div>
            </div>
          ` : ''}
        </div>
      </div>

      ${(isBiz || desc || site || email) ? `
        <div class="qcCard">
          <div class="label">Informações públicas</div>
          <div class="qcInfoGrid">
            ${desc ? `
              <div class="qcInfoItem is-full">
                <div class="label">Descrição</div>
                <div class="content">${esc(desc)}</div>
              </div>
            ` : ''}

            ${site ? `
              <div class="qcInfoItem">
                <div class="label">Website</div>
                <div class="content">
                  <a class="qcLink" href="${esc(site)}" target="_blank" rel="noopener">Abrir</a>
                </div>
              </div>
            ` : ''}

            ${email ? `
              <div class="qcInfoItem">
                <div class="label">E-mail</div>
                <div class="content">
                  <a class="qcLink" href="mailto:${esc(email)}">Enviar</a>
                </div>
              </div>
            ` : ''}
          </div>
        </div>
      ` : ''}
    `;
  }

  let currentReq = { ctrl: null, token: null };

  async function fetchBDProfile(clienteId, signal) {
    if (!clienteId || !EMPRESA_ID) {
      throw new Error('Cliente/empresa inválidos.');
    }

    const r = await fetch(`/api/atendimento/clientes/${clienteId}/profile?empresa_id=${EMPRESA_ID}`, {
      credentials: 'include',
      signal,
    });

    if (!r.ok) {
      let raw = '';
      try { raw = await r.text(); } catch {}

      let detail = raw;
      try {
        const j = JSON.parse(raw);
        detail = j?.detail || j?.message || raw;
      } catch {}

      throw new Error(`Falha ao buscar perfil no BD: ${detail || `${r.status} ${r.statusText}`}`);
    }

    return r.json();
  }

  async function startFetch(clienteId, conversationKey) {
    try { currentReq.ctrl?.abort(); } catch {}

    const ctrl = new AbortController();
    const token = { clienteId: idKey(clienteId), conversationKey: idKey(conversationKey), openedAt: Date.now() };
    currentReq = { ctrl, token };

    try {
      let bd = await fetchBDProfile(clienteId, ctrl.signal);

      if (!currentReq.token || currentReq.token.clienteId !== idKey(clienteId)) return;
      if (!window.__qcPerfil?.isOpen?.()) return;

      patchClienteCacheNameOnly(conversationKey, bd);

      const hasAvatar = !!pickProfileAvatar(bd);

      if (!hasAvatar) {
        try {
          await refreshAvatarFromEvolution(clienteId, { conversationKey });
        } catch {}

        if (!currentReq.token || currentReq.token.clienteId !== idKey(clienteId)) return;
        if (!window.__qcPerfil?.isOpen?.()) return;

        try {
          bd = await fetchBDProfile(clienteId, ctrl.signal);
        } catch {}
      }

      if (!currentReq.token || currentReq.token.clienteId !== idKey(clienteId)) return;
      if (!window.__qcPerfil?.isOpen?.()) return;

      window.__qcPerfil.setBody(renderProfileFromBD(bd));
      wireDrawerAvatarFallback(clienteId);
    } catch (err) {
      if (err?.name === 'AbortError') return;

      console.error('[perfil_quick] erro', err);

      if (window.__qcPerfil?.isOpen?.()) {
        window.__qcPerfil.setBody(`
          <div class="qcCard">
            <div class="label">Perfil</div>
            <div class="content">
              Não foi possível carregar o perfil.<br>
              <small>${esc(String(err.message || err))}</small>
            </div>
          </div>
        `);
        ensureToast('Não foi possível carregar o perfil.', 'error');
      }
    }
  }

  async function abrirPerfilRapido() {
    buildDrawer();
    window.__qcPerfil.open();
    window.__qcPerfil.setSkeleton();

    const selectedKind = getSelectedKind();
    const conversationKey = getCurrentConversationForPatch();

    if (selectedKind !== 'c') {
      window.__qcPerfil.setBody(`
        <div class="qcCard">
          <div class="label">Perfil</div>
          <div class="content">
            O perfil rápido está disponível apenas para contatos individuais.<br>
            <small>Para grupos, use os dados da própria conversa.</small>
          </div>
        </div>
      `);
      return;
    }

    const cid = getClienteId();
    if (!cid || !conversationKey) {
      window.__qcPerfil.setBody(`
        <div class="qcCard">
          <div class="label">Perfil</div>
          <div class="content">
            Não foi possível carregar o perfil.<br>
            <small>Cliente não selecionado.</small>
          </div>
        </div>
      `);
      return;
    }

    await startFetch(cid, conversationKey);
  }

  window.abrirPerfilRapido = abrirPerfilRapido;

  const BLOCK_OPEN_SELECTOR = [
    '.btn-note', '.btn-notes', '[data-action="notes"]',
    '.btn-gpt', '.btn-ai', '[data-action="ai"]',
    '.btn', 'button', 'a[href]', '[role="button"]',
    '[data-no-profile="1"]',
  ].join(',');

  const OPEN_TARGET_SELECTOR = [
    '#chat-title',
    '#chat-avatar',
    '#chat-avatar .avatar',
    '#chat-avatar img',
    '[data-role="contact-name"]',
    '[data-role="contact-avatar"]',
  ].join(',');

  function attachHeaderHook() {
    const hdr = document.getElementById('chat-header');
    if (!hdr || hdr.dataset.qcBound === '1') return;
    hdr.dataset.qcBound = '1';

    hdr.addEventListener('click', (e) => {
      const t = e.target;
      if (!t) return;
      if (t.closest(BLOCK_OPEN_SELECTOR)) return;

      const openFrom = t.closest(OPEN_TARGET_SELECTOR);
      if (!openFrom) return;

      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      e.preventDefault();
      e.stopImmediatePropagation?.();
      e.stopPropagation();

      abrirPerfilRapido();
    }, { capture: true, passive: false });

    hdr.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || t.closest(BLOCK_OPEN_SELECTOR)) return;
      if (!t.closest(OPEN_TARGET_SELECTOR)) return;
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      e.preventDefault();
      e.stopPropagation();

      abrirPerfilRapido();
    }, { passive: false });
  }

  (function watchHeader() {
    const hdrEl = document.getElementById('chat-header');
    if (hdrEl) {
      const mo = new MutationObserver(() => attachHeaderHook());
      mo.observe(hdrEl, { childList: true, subtree: true });
    }
    attachHeaderHook();
  })();

  (function watchHistoricoCliente() {
    const hist = document.getElementById('historico');
    if (!hist) return;

    const mo = new MutationObserver(() => {
      const open = window.__qcPerfil?.isOpen?.();
      const selectedKind = getSelectedKind();
      const newCid = getClienteId();
      const newConv = getCurrentConversationForPatch();

      if (open) {
        window.__qcPerfil.setSkeleton();

        if (selectedKind === 'c' && newCid && newConv) {
          startFetch(newCid, newConv);
        } else {
          currentReq.ctrl?.abort();
          window.__qcPerfil.setBody(`
            <div class="qcCard">
              <div class="label">Perfil</div>
              <div class="content">
                O perfil rápido está disponível apenas para contatos individuais.
              </div>
            </div>
          `);
        }
      } else {
        currentReq.ctrl?.abort();
      }
    });

    mo.observe(hist, {
      attributes: true,
      attributeFilter: ['data-conversation-key', 'data-kind', 'data-entity-id', 'data-cliente-id']
    });
  })();

  function ensureAvatarPlaceholder(span, mode = 'list') {
    try {
      if (!span) return;
      span.classList.add(mode === 'header' ? 'avatar-default' : 'placeholder');
      span.innerHTML = '<i class="fa fa-user-circle"></i>';
    } catch {}
  }

  window.handleListAvatarError = function handleListAvatarError(imgEl) {
    try {
      if (!imgEl) return;
      try { imgEl.onerror = null; } catch {}

      const li = imgEl?.closest?.('[data-conversation-key], [data-id]');
      const conv =
        li?.getAttribute?.('data-conversation-key') ||
        li?.getAttribute?.('data-id') ||
        null;

      const entityId =
        li?.getAttribute?.('data-entity-id') ||
        conversationRefOf(conv).entityId ||
        null;

      const span = imgEl.closest?.('.avatar') || imgEl.parentElement;

      try { imgEl.removeAttribute('src'); } catch {}
      try { imgEl.remove(); } catch {}

      ensureAvatarPlaceholder(span, 'list');

      if (entityId && conversationRefOf(conv).kind === 'c') {
        clearAvatarFromCaches(entityId);
      }

      try { window.persist?.(); } catch {}
    } catch {}
  };

  window.handleAvatarError = function handleAvatarError(imgEl) {
    try {
      if (!imgEl) return;
      try { imgEl.onerror = null; } catch {}

      const entityId = getClienteId();
      const span = imgEl.closest?.('.avatar') || imgEl.parentElement;

      try { imgEl.removeAttribute('src'); } catch {}
      try { imgEl.remove(); } catch {}

      ensureAvatarPlaceholder(span, 'header');

      if (entityId) {
        clearAvatarFromCaches(entityId);
      }

      try { window.persist?.(); } catch {}
    } catch {}
  };

  function applyAvatarToListDOM(conversationKey, url) {
    try {
      const convKey = idKey(conversationKey);
      if (!convKey) return;

      const li = document.querySelector(
        `li.chat-item[data-conversation-key="${CSS.escape(convKey)}"], li.cliente-item[data-conversation-key="${CSS.escape(convKey)}"], [data-conversation-key="${CSS.escape(convKey)}"]`
      );
      const span = li?.querySelector?.('.avatar');
      if (!span) return;

      if (!url) {
        ensureAvatarPlaceholder(span, 'list');
        return;
      }

      span.classList.remove('placeholder');
      span.innerHTML = '';

      const img = document.createElement('img');
      img.alt = '';
      img.src = String(url);
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        try { window.handleListAvatarError?.(img); } catch {}
      }, { once: true });

      span.appendChild(img);
    } catch {}
  }

  function applyAvatarToHeaderDOM(conversationKey, url) {
    try {
      const currentRef = getCurrentConversationForPatch();
      if (!currentRef || !sameConversation(currentRef, conversationKey)) return;

      const box = document.getElementById('chat-avatar');
      if (!box) return;

      if (!url) {
        box.innerHTML = `<span class="avatar avatar-default"><i class="fa fa-user-circle"></i></span>`;
        return;
      }

      const span = document.createElement('span');
      span.className = 'avatar';

      const img = document.createElement('img');
      img.alt = '';
      img.src = String(url);
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        try { window.handleAvatarError?.(img); } catch {}
      }, { once: true });

      span.appendChild(img);
      box.innerHTML = '';
      box.appendChild(span);
    } catch {}
  }

  async function refreshAvatarFromEvolution(clienteId, opt = {}) {
    try {
      const cid = idKey(clienteId || '');
      if (!cid || !EMPRESA_ID) return null;

      const conversationKey =
        idKey(opt?.conversationKey) ||
        getCurrentConversationForPatch() ||
        buildConversationKey('c', cid, getInstanciaAtivaSafe().instancia_id || getInstanciaAtivaSafe().instance) ||
        null;

      const numRaw = opt?.number ? String(opt.number) : await getTelefoneAsync(cid);
      const number = onlyDigits(numRaw);
      if (!number || number.length < 10) return null;

      let instOpt = {
        instancia_id: opt?.instancia_id,
        instance: opt?.instance,
      };

      if (!instOpt.instancia_id && !instOpt.instance && opt?.instancia_raw != null) {
        instOpt = resolveInstOpt(opt.instancia_raw);
      }

      if (!instOpt.instancia_id && !instOpt.instance) {
        instOpt = getInstanciaAtivaSafe();
      }

      if (!instOpt.instancia_id && !instOpt.instance) return null;

      const body = {
        number,
        empresa_id: EMPRESA_ID || undefined,
        instancia_id: instOpt.instancia_id ?? undefined,
        instance: instOpt.instance ?? undefined,
      };

      const r = await fetch('/api/evolution/fetchProfile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (!r.ok) return null;

      const prof = await r.json().catch(() => null);
      const pic = pickProfileAvatar(prof);
      if (!pic) return null;

      try {
        const st2 = window.state || {};
        const lists = [st2.clientesCache, st2.todosContatosCache];
        const patch = { avatar_url: pic };

        lists.forEach((arr) => {
          if (!Array.isArray(arr)) return;
          arr.forEach((item, idx) => {
            const ref = conversationRefOf(item, item);
            if (ref.kind === 'c' && ref.entityId === cid) {
              arr[idx] = { ...item, ...patch };
            }
          });
        });

        if (st2.clienteSel) {
          const ref = conversationRefOf(st2.clienteSel, st2.clienteSel);
          if (ref.kind === 'c' && ref.entityId === cid) {
            Object.assign(st2.clienteSel, patch);
          }
        }

        if (typeof window.persist === 'function') window.persist();
      } catch {}

      if (conversationKey) {
        applyAvatarToListDOM(conversationKey, pic);
        applyAvatarToHeaderDOM(conversationKey, pic);
      }

      return { picture: pic, profile: prof || null };
    } catch {
      return null;
    }
  }

  window.refreshAvatarFromEvolution = refreshAvatarFromEvolution;
})();