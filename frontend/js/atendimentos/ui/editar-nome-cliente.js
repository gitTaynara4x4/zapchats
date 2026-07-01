// /frontend/js/atendimentos/ui/editar-nome-cliente.js
// Etapa 9.16 — editar nome exibido do cliente direto no atendimento.
// - Sem observer pesado.
// - Sem interval.
// - Não mexe no telefone.
// - Atualiza header/lista/cache local na hora.

(function () {
  'use strict';

  const VERSION = 'zc-editar-nome-cliente-v2-isolado-menu-safe';
  if (window.__ZC_EDITAR_NOME_CLIENTE__ === VERSION) return;
  window.__ZC_EDITAR_NOME_CLIENTE__ = VERSION;

  const BTN_ID = 'btnEditarNomeCliente';
  const MODAL_ID = 'zcEditarNomeClienteModal';

  function $(sel, root = document) {
    try { return root.querySelector(sel); } catch { return null; }
  }

  function toInt(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function cleanText(v) {
    return String(v ?? '')
      .replace(/\r|\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getEmpresaId() {
    return (
      toInt(window.empresa_id) ||
      toInt(window.EMPRESA_ID) ||
      toInt(window.__EMPRESA_ID__) ||
      toInt(localStorage.getItem('empresa_id')) ||
      toInt(localStorage.getItem('EMPRESA_ID')) ||
      toInt(document.body?.dataset?.empresaId) ||
      toInt(document.documentElement?.dataset?.empresaId) ||
      null
    );
  }

  function parseConvKey(raw) {
    const s = String(raw || '').trim();
    const m = s.match(/^([cg]):(\d+):([^:]+)$/i);
    if (!m) return null;
    return {
      key: `${m[1].toLowerCase()}:${m[2]}:${m[3]}`,
      kind: m[1].toLowerCase(),
      entityId: Number(m[2]),
      instanciaId: /^\d+$/.test(String(m[3])) ? Number(m[3]) : null,
    };
  }

  function currentHeader() {
    return document.getElementById('chat-header');
  }

  function currentHist() {
    return document.getElementById('historico');
  }

  function currentSelectedRaw() {
    return window.state?.clienteSel || window.clienteSel || null;
  }

  function getCurrentConversation() {
    const sel = currentSelectedRaw() || {};
    const hdr = currentHeader();
    const hist = currentHist();

    const key =
      sel.conversation_key ||
      sel.conversation_id ||
      hdr?.dataset?.conversationKey ||
      hdr?.dataset?.conversationId ||
      hdr?.dataset?.convKey ||
      hist?.dataset?.conversationKey ||
      hist?.dataset?.conversationId ||
      hist?.dataset?.convKey ||
      '';

    const parsed = parseConvKey(key);

    const kind =
      parsed?.kind ||
      String(sel.kind || hdr?.dataset?.kind || hist?.dataset?.kind || 'c').toLowerCase().slice(0, 1) ||
      'c';

    const entityId =
      parsed?.entityId ||
      toInt(sel.entity_id) ||
      toInt(sel.cliente_id) ||
      toInt(sel.id) ||
      toInt(hdr?.dataset?.entityId) ||
      toInt(hdr?.dataset?.clienteId) ||
      toInt(hist?.dataset?.entityId) ||
      toInt(hist?.dataset?.clienteId) ||
      null;

    const instanciaId =
      parsed?.instanciaId ||
      toInt(sel.instancia_id) ||
      toInt(sel.instancia) ||
      toInt(hdr?.dataset?.instanciaId) ||
      toInt(hist?.dataset?.instanciaId) ||
      null;

    const convKey = parsed?.key || (entityId ? `${kind === 'g' ? 'g' : 'c'}:${entityId}:${instanciaId || 0}` : '');

    return {
      key: convKey,
      kind: kind === 'g' ? 'g' : 'c',
      clienteId: entityId,
      entityId,
      instanciaId,
      selected: sel,
    };
  }

  function getCurrentName() {
    const sel = currentSelectedRaw() || {};
    const hdr = currentHeader();
    const hist = currentHist();
    const conv = getCurrentConversation();

    const row = findListRow(conv);

    return cleanText(
      sel.nome ||
      sel.cliente_nome ||
      sel.nome_cliente ||
      sel.nome_exibicao ||
      row?.dataset?.nome ||
      $('#chat-title')?.textContent ||
      hdr?.querySelector?.('.chat-title,.title,[data-role="chat-title"],[data-role="contact-name"]')?.textContent ||
      ''
    );
  }

  function findListRow(conv = null) {
    conv = conv || getCurrentConversation();
    const key = String(conv.key || '').trim();
    const id = conv.entityId ? String(conv.entityId) : '';
    const inst = conv.instanciaId ? String(conv.instanciaId) : '';

    const candidates = Array.from(document.querySelectorAll('#lista-clientes .chat-item, #lista-clientes .cliente-item'));

    for (const li of candidates) {
      const d = li.dataset || {};
      if (key && (d.conversationKey === key || d.conversationId === key || d.id === key || d.convKey === key)) return li;
    }

    for (const li of candidates) {
      const d = li.dataset || {};
      const sameId = id && String(d.entityId || d.clienteId || d.backendClienteId || '').trim() === id;
      const sameInst = !inst || !String(d.instanciaId || '').trim() || String(d.instanciaId || '').trim() === inst;
      if (sameId && sameInst) return li;
    }

    return null;
  }

  function showToast(msg, ok = true) {
    if (typeof window.toast === 'function') {
      try { window.toast(msg, ok); return; } catch {}
    }
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, ok ? 'success' : 'error'); return; } catch {}
    }
    console[ok ? 'log' : 'warn'](msg);
  }

  function ensureStyles() {
    if (document.getElementById('zc-editar-nome-cliente-css')) return;
    const st = document.createElement('style');
    st.id = 'zc-editar-nome-cliente-css';
    st.textContent = `
      #${BTN_ID}{
        width:28px;height:28px;border:0;border-radius:999px;background:transparent;color:#64748b;
        display:inline-flex;align-items:center;justify-content:center;cursor:pointer;margin-left:6px;
        transition:background .12s ease,color .12s ease;
      }
      #${BTN_ID}:hover{background:rgba(15,23,42,.08);color:#059669;}
      #${BTN_ID} i{font-size:13px;pointer-events:none;}
      .dark #${BTN_ID}{color:#94a3b8;}
      .dark #${BTN_ID}:hover{background:rgba(255,255,255,.08);color:#34d399;}
      #${MODAL_ID}{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;background:rgba(15,23,42,.45);padding:16px;}
      #${MODAL_ID}.is-open{display:flex;}
      .zc-edit-name-card{width:min(440px,96vw);background:#fff;border-radius:22px;box-shadow:0 24px 70px rgba(15,23,42,.24);border:1px solid rgba(148,163,184,.25);overflow:hidden;}
      .dark .zc-edit-name-card{background:#111827;color:#f8fafc;border-color:rgba(148,163,184,.18);}
      .zc-edit-name-head{display:flex;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid rgba(148,163,184,.22);}
      .zc-edit-name-ico{width:38px;height:38px;border-radius:14px;background:#ecfdf5;color:#059669;display:flex;align-items:center;justify-content:center;}
      .zc-edit-name-title{font-size:17px;font-weight:800;color:#0f172a;margin:0;}
      .dark .zc-edit-name-title{color:#fff;}
      .zc-edit-name-sub{font-size:12px;color:#64748b;margin-top:2px;}
      .dark .zc-edit-name-sub{color:#94a3b8;}
      .zc-edit-name-body{padding:18px 20px 20px;}
      .zc-edit-name-label{font-size:12px;font-weight:800;color:#334155;margin-bottom:8px;display:block;}
      .dark .zc-edit-name-label{color:#cbd5e1;}
      .zc-edit-name-input{width:100%;height:46px;border:1px solid #dbe4ef;border-radius:14px;padding:0 13px;font-size:15px;outline:none;background:#fff;color:#0f172a;}
      .zc-edit-name-input:focus{border-color:#10b981;box-shadow:0 0 0 4px rgba(16,185,129,.12);}
      .dark .zc-edit-name-input{background:#0b1220;border-color:#334155;color:#fff;}
      .zc-edit-name-help{font-size:12px;color:#64748b;margin-top:8px;line-height:1.35;}
      .dark .zc-edit-name-help{color:#94a3b8;}
      .zc-edit-name-actions{display:flex;justify-content:flex-end;gap:10px;padding:0 20px 20px;}
      .zc-edit-name-btn{border:0;border-radius:13px;height:40px;padding:0 16px;font-weight:800;cursor:pointer;}
      .zc-edit-name-cancel{background:#f1f5f9;color:#334155;}
      .zc-edit-name-save{background:#059669;color:#fff;box-shadow:0 10px 24px rgba(5,150,105,.22);}
      .zc-edit-name-save[disabled]{opacity:.7;cursor:wait;}
      .dark .zc-edit-name-cancel{background:#1f2937;color:#cbd5e1;}
    `;
    document.head.appendChild(st);
  }

  function ensureModal() {
    ensureStyles();
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="zc-edit-name-card" role="dialog" aria-modal="true" aria-labelledby="zcEditNameTitle">
        <div class="zc-edit-name-head">
          <div class="zc-edit-name-ico"><i class="fa-solid fa-pen"></i></div>
          <div>
            <h3 class="zc-edit-name-title" id="zcEditNameTitle">Editar nome do cliente</h3>
            <div class="zc-edit-name-sub">Altera só o nome exibido no ZapsChat.</div>
          </div>
        </div>
        <div class="zc-edit-name-body">
          <label class="zc-edit-name-label" for="zcEditNameInput">Nome exibido</label>
          <input class="zc-edit-name-input" id="zcEditNameInput" maxlength="140" autocomplete="off" />
          <div class="zc-edit-name-help">O telefone/WhatsApp não será alterado.</div>
        </div>
        <div class="zc-edit-name-actions">
          <button type="button" class="zc-edit-name-btn zc-edit-name-cancel" data-zc-edit-name-close>Cancelar</button>
          <button type="button" class="zc-edit-name-btn zc-edit-name-save" data-zc-edit-name-save>Salvar</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (ev) => {
      if (ev.target === modal || ev.target.closest('[data-zc-edit-name-close]')) closeModal();
      if (ev.target.closest('[data-zc-edit-name-save]')) saveName();
    });

    modal.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeModal();
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        saveName();
      }
    });

    return modal;
  }

  function openModal() {
    const conv = getCurrentConversation();
    if (!conv.entityId || conv.kind === 'g') {
      showToast('Abra uma conversa de cliente para editar o nome.', false);
      return;
    }

    const modal = ensureModal();
    const input = document.getElementById('zcEditNameInput');
    if (input) {
      input.value = getCurrentName();
      setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 30);
    }
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeModal() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
  }

  async function saveName() {
    const conv = getCurrentConversation();
    const input = document.getElementById('zcEditNameInput');
    const btn = document.querySelector('[data-zc-edit-name-save]');
    const nome = cleanText(input?.value || '');

    if (!conv.entityId || conv.kind === 'g') {
      showToast('Conversa inválida para editar nome.', false);
      return;
    }

    if (!nome) {
      showToast('Informe um nome para o cliente.', false);
      try { input?.focus(); } catch {}
      return;
    }

    const empresaId = getEmpresaId();
    if (!empresaId) {
      showToast('Empresa não identificada na sessão.', false);
      return;
    }

    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Salvando...';
      }

      const res = await fetch(`/api/atendimento/conversas/${encodeURIComponent(conv.entityId)}/nome`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          empresa_id: empresaId,
          instancia_id: conv.instanciaId || null,
          nome,
        }),
      });

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }

      if (!res.ok) {
        const msg = data?.detail || data?.message || `HTTP ${res.status}`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }

      applyNameLocally(nome, data || {});
      closeModal();
      showToast('Nome do cliente atualizado.');
    } catch (err) {
      console.error('[editar-nome-cliente] erro ao salvar:', err);
      showToast(err?.message || 'Não foi possível salvar o nome.', false);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Salvar';
      }
    }
  }

  function applyNameLocally(nome, data = {}) {
    const conv = getCurrentConversation();
    const convKey = data.conversation_key || data.conversation_id || conv.key;
    const clienteId = String(data.cliente_id || conv.entityId || '');

    const sel = currentSelectedRaw();
    if (sel) {
      sel.nome = nome;
      sel.cliente_nome = nome;
      sel.nome_exibicao = nome;
      if (convKey) {
        sel.conversation_key = convKey;
        sel.conversation_id = convKey;
      }
    }

    try {
      if (window.state) window.state.clienteSel = sel;
      window.clienteSel = sel;
    } catch {}

    const title = document.getElementById('chat-title') || $('#chat-header .title') || $('#chat-header .chat-title');
    if (title) {
      title.textContent = nome;
      title.title = nome;
      title.dataset.nome = nome;
    }

    const hdr = currentHeader();
    if (hdr) {
      hdr.dataset.nome = nome;
      hdr.dataset.clienteNome = nome;
    }

    const row = findListRow({ key: convKey, entityId: clienteId, instanciaId: conv.instanciaId });
    if (row) {
      row.dataset.nome = nome;
      const nameEl = row.querySelector('.chat-name, .cliente-nome, [data-role="name"]');
      if (nameEl) nameEl.textContent = nome;
    }

    const caches = [
      window.state?.clientesCache,
      window.clientesCache,
      window.Lista?.items,
    ];

    for (const arr of caches) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        const key = String(item?.conversation_key || item?.conversation_id || item?.id || '');
        const id = String(item?.cliente_id || item?.entity_id || item?.backend_id || '');
        if ((convKey && key === convKey) || (clienteId && id === clienteId)) {
          item.nome = nome;
          item.cliente_nome = nome;
          item.nome_exibicao = nome;
        }
      }
    }

    try {
      window.dispatchEvent(new CustomEvent('zc:cliente-nome-updated', {
        detail: { nome, cliente_id: clienteId, conversation_key: convKey }
      }));
    } catch {}
  }

  function ensureButton() {
    ensureStyles();

    const conv = getCurrentConversation();
    const title = document.getElementById('chat-title') || $('#chat-header .title') || $('#chat-header .chat-title');
    const hdr = currentHeader();

    if (!title || !hdr || !conv.entityId || conv.kind === 'g') {
      const old = document.getElementById(BTN_ID);
      if (old) old.style.display = 'none';
      return;
    }

    let btn = document.getElementById(BTN_ID);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.title = 'Editar nome do cliente';
      btn.setAttribute('aria-label', 'Editar nome do cliente');
      btn.setAttribute('data-no-profile', '1');
      btn.setAttribute('data-zc-inline-edit-name', '1');
      btn.innerHTML = '<i class="fa-solid fa-pen"></i>';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation?.();
        openModal();
      }, true);
    }

    btn.style.display = 'inline-flex';

    /*
      Importante:
      - o lápis não pode ocupar o lugar dos 3 pontinhos;
      - não mexe na área de ações do header;
      - apenas entra ao lado do texto do nome.
    */
    const titleParent = title.parentElement || hdr;
    if (btn.parentElement !== titleParent || title.nextElementSibling !== btn) {
      try { title.insertAdjacentElement('afterend', btn); }
      catch { try { titleParent.appendChild(btn); } catch {} }
    }
  }

  function bindMenuFallback() {
    document.addEventListener('click', (ev) => {
      const item = ev.target.closest('[data-action="editar-nome-cliente"],[data-zc-action="editar-nome-cliente"]');
      if (!item) return;
      ev.preventDefault();
      ev.stopPropagation();
      openModal();
    }, true);
  }

  function scheduleEnsureButton() {
    clearTimeout(scheduleEnsureButton.__t);
    scheduleEnsureButton.__t = setTimeout(ensureButton, 60);
  }

  function init() {
    ensureStyles();
    bindMenuFallback();
    ensureButton();

    [
      'zc:conversation-selected',
      'zc:conversation-opened',
      'zc:conversa-atualizada',
      'zc:atendimentos-ready',
      'zc:atendimentos-runtime-ready',
      'lista:rendered',
    ].forEach((evt) => {
      window.addEventListener(evt, scheduleEnsureButton);
      document.addEventListener(evt, scheduleEnsureButton);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.zcAbrirEditarNomeCliente = openModal;
})();
