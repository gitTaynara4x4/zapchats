// /frontend/js/atendimentos/ui/new-chat.js
// Nova conversa – via proxy backend + bloqueio quando filtro estiver em "Todos"
// - CSS removido -> agora usa classes + CSS no atendimentos.css

import { EMPRESA_ID } from '../core/env.js';
import { numeroE164 } from '../core/format.js';
import { state } from '../state/store.js';

(function () {
  // ---------------- helpers ----------------
  const $  = function (s, root) { return (root || document).querySelector(s); };
  const onlyDigits = function (s) { return String(s || '').replace(/\D/g, ''); };
  const ensure55 = function (d) { return String(d || '').startsWith('55') ? String(d) : '55' + String(d || ''); };
  const insert9IfNeeded = function (d) {
    if (!/^55\d{2}\d+$/.test(d)) return d;
    const ddd = d.slice(2, 4), rest = d.slice(4);
    return rest.length === 8 ? '55' + ddd + '9' + rest : d;
  };
  const formatTelBR = function (d) {
    const s = onlyDigits(d);
    const m = s.match(/^(\+?55)?(\d{2})(\d{4,5})(\d{4})$/);
    return m ? '+55 (' + m[2] + ') ' + m[3] + '-' + m[4] : s;
  };

  // Toast com duração customizável (mantém inline style pois é componente global pequeno)
  function toast(msg, ok, ms) {
    if (ok === void 0) ok = true;
    if (ms === void 0) ms = 2200;
    var t = document.getElementById('__app_toast');
    if (!t) {
      t = document.createElement('div');
      t.id = '__app_toast';
      Object.assign(t.style, {
        position: 'fixed', left: '50%', bottom: '20px', transform: 'translateX(-50%)',
        padding: '8px 12px', borderRadius: '10px',
        background: ok ? '#1f2937' : '#7f1d1d', color: '#fff',
        fontSize: '13px', lineHeight: '1.2',
        boxShadow: '0 10px 30px rgba(0,0,0,.35)', zIndex: 99999,
        opacity: '0', transition: 'opacity .18s, transform .18s', pointerEvents: 'none',
        maxWidth: '92vw', textAlign: 'center'
      });
      document.body.appendChild(t);
    }
    t.textContent = String(msg || '');
    t.style.background = ok ? '#1f2937' : '#7f1d1d';
    t.style.opacity = '1';
    clearTimeout(t.__timer);
    t.__timer = setTimeout(function () {
      t.style.opacity = '0';
    }, Math.max(1200, Number(ms) || 2200));
  }

  // Helpers de parsing de erro
  const pick = function (o, keys) {
    var i;
    for (i = 0; i < keys.length; i++) {
      if (o && o[keys[i]]) return o[keys[i]];
    }
    return null;
  };
  function extractMessage(obj){
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj)) return extractMessage(obj[0]);
    return (
      pick(obj,['message','msg','detail','error','erro','status','reason','descricao']) ||
      (obj.error && (obj.error.message || obj.error.msg)) ||
      (Array.isArray(obj.detail) && obj.detail[0] && (obj.detail[0].msg || obj.detail[0].message)) ||
      ''
    );
  }

  // ---------------- Checagem de instância selecionada ("Todos" bloqueia) ----------------
  function hasSelectedInstance() {
    var v = (window.INSTANCIA_ATIVA == null ? '' : String(window.INSTANCIA_ATIVA)).trim();
    if (!v) return false;
    var bad = ['todos','all','*','0','-',''];
    var lower = v.toLowerCase();
    return bad.indexOf(lower) === -1;
  }
  function reflectPlusBtnState(btn){
    var ok = hasSelectedInstance();
    btn.disabled = !ok;
    btn.style.opacity = ok ? '1' : '0.55';
    btn.style.cursor  = ok ? 'pointer' : 'not-allowed';
    btn.title = ok ? 'Nova conversa' : 'Selecione o WhatsApp para enviar';
  }

  // ---------------- Evolution via backend (SEM whatsappNumbers) ----------------
  async function evoFetchProfileByNumber(numberDigits) {
    if (!hasSelectedInstance()) return null;
    const digits = onlyDigits(numberDigits);
    if (!digits) throw new Error('number vazio');

    const instRaw = (window.INSTANCIA_ATIVA && String(window.INSTANCIA_ATIVA).trim()) || '';
    const body = {
      number: digits,
      empresa_id: Number(window.EMPRESA_ID || 0) || undefined,
      instancia_id: /^\d+$/.test(instRaw) ? Number(instRaw) : undefined,
      instance: /^\d+$/.test(instRaw) ? undefined : (instRaw || undefined)
    };

    const r = await fetch('/api/evolution/fetchProfile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    const txt = await r.text();
    let p = null; try { p = txt ? JSON.parse(txt) : null; } catch (e) {}

    if (!r.ok) {
      const err = new Error('fetchProfile proxy ' + r.status);
      err.status = r.status; err.body = p || txt;
      throw err;
    }
    return {
      name: (p && p.name ? String(p.name).trim() : null) || null,
      picture: (p && p.picture ? String(p.picture).trim() : null) || null,
      statusTxt: (p && p.status && (p.status.status || p.status.text)) || (p && p.description) || null,
      raw: p
    };
  }

  // ---------------- backend utils ----------------
  async function getClienteDetalhe(id){
    const r = await fetch('/api/clientes/' + encodeURIComponent(String(id)) + '?empresa_id=' + encodeURIComponent(String(EMPRESA_ID)), { credentials:'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  }

  async function findClienteByTelefone(e164Digits) {
    const qs = new URLSearchParams({ empresa_id:String(EMPRESA_ID), q:e164Digits, limit:'5', offset:'0' });
    const r = await fetch('/api/clientes?' + qs.toString(), { credentials:'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = await r.json().catch(function () { return {}; });
    const items = Array.isArray(list && list.items) ? list.items : [];
    const onlyD = function (s) { return String(s || '').replace(/\D/g, ''); };
    const without55 = e164Digits.startsWith('55') ? e164Digits.slice(2) : e164Digits;
    return items.find(function (i) {
      const tel = onlyD(i && i.telefone || '');
      return tel === e164Digits || tel === without55;
    }) || null;
  }

  // ---------------- header (sem placeholder) ----------------
  const TITLE_SELS  = ['#chat-header .title', '.chat-title', '#chat-title', '[data-role="chat-title"]', '#chatTitle', 'header .title'];
  const SUB_SELS    = ['#chat-header .subtitle', '.chat-subtitle', '[data-role="chat-subtitle"]', '#chatSubtitle', 'header .subtitle'];
  const AVATAR_SELS = ['#chat-header .avatar img', '.chat-avatar img', 'img.avatar', 'img[alt="avatar"]'];

  function qAny(sels){
    for (var i = 0; i < sels.length; i++){
      var el = document.querySelector(sels[i]);
      if (el) return el;
    }
    return null;
  }

  function resolveDisplayName(cliente){
    cliente = cliente || {};
    const tel = onlyDigits(cliente.telefone || cliente.whatsapp || '');
    const nomeWhats = (cliente.nome_whatsapp ? String(cliente.nome_whatsapp).trim() : '');
    const nomeBd = (cliente.nome ? String(cliente.nome).trim() : '');
    const push = (cliente.push_name ? String(cliente.push_name).trim() : '');
    if (nomeWhats) return nomeWhats;
    if (nomeBd && nomeBd !== 'Cliente') return nomeBd;
    if (push) return push;
    return tel ? formatTelBR(tel) : 'Cliente';
  }

  function setHeaderFromDB(cliente) {
    const titleEl = qAny(TITLE_SELS);
    const subEl   = qAny(SUB_SELS);
    const imgEl   = qAny(AVATAR_SELS);

    const name = resolveDisplayName(cliente || {});
    if (titleEl) titleEl.textContent = name;
    if (subEl)   subEl.textContent   = '';

    if (imgEl && cliente && cliente.avatar_url) {
      imgEl.src = cliente.avatar_url;
      imgEl.removeAttribute('srcset');
    }

    try { window.__HEADER_LOCKED_NAME = name; } catch (e) {}
  }

  function updateHeaderPicture(url) {
    if (!url) return;
    const imgEl = qAny(AVATAR_SELS);
    if (imgEl) {
      imgEl.src = url;
      imgEl.removeAttribute('srcset');
    }
  }

  // ---- helpers para sincar novo cliente no cache e no state ----
  function mergeClienteInCaches(cliente){
    if (!cliente || cliente.id == null) return;
    var idNum = Number(cliente.id);

    try {
      var names = ['todosContatosCache','clientesCache'];
      names.forEach(function (name){
        var arr = window[name];
        if (Array.isArray(arr)){
          var idx = arr.findIndex(function (c){ return Number(c.id) === idNum; });
          if (idx >= 0) arr[idx] = Object.assign({}, arr[idx], cliente);
          else arr.unshift(cliente);
        }
      });
    } catch (e) {}

    try {
      if (state){
        if (!Array.isArray(state.clientesCache)) state.clientesCache = [];
        var idx2 = state.clientesCache.findIndex(function (c){ return Number(c.id) === idNum; });
        if (idx2 >= 0) state.clientesCache[idx2] = Object.assign({}, state.clientesCache[idx2], cliente);
        else state.clientesCache.unshift(cliente);
      }
    } catch (e) {}
  }

  function forceSelectCliente(cliente){
    if (!cliente || cliente.id == null) return;
    try { mergeClienteInCaches(cliente); } catch (e) {}
    try { if (state) state.clienteSel = cliente; } catch (e) {}
    try { window.clienteSel = cliente; } catch (e) {}
  }

  async function tryEvolutionPictureIfMissing(cliente) {
    if (!hasSelectedInstance()) return;
    if (cliente && cliente.avatar_url) return;

    const telRaw = onlyDigits(cliente && (cliente.telefone || cliente.whatsapp) || '');
    if (!telRaw) return;

    try {
      const prof = await evoFetchProfileByNumber(ensure55(telRaw));
      if (prof && prof.picture) { updateHeaderPicture(prof.picture); return; }
    } catch (e) {}

    try {
      const d = ensure55(telRaw);
      if (/^55\d{2}\d{8}$/.test(d)) {
        const ddd = d.slice(2,4), rest = d.slice(4);
        const with9 = '55' + ddd + '9' + rest;
        const prof2 = await evoFetchProfileByNumber(with9);
        if (prof2 && prof2.picture) updateHeaderPicture(prof2.picture);
      }
    } catch (e) {}
  }

  // ---------------- abrir chat (sem placeholders) ----------------
  function openById(id) {
    id = Number(id);
    if (!Number.isFinite(id)) return false;
    var ok = false;
    try { window.__CURRENT_CHAT_ID = id; } catch (e) {}

    try { if (typeof window.selecionarClienteObj === 'function') { window.selecionarClienteObj(id); ok = true; } } catch (e) {}
    try { if (typeof window.selecionarClienteId  === 'function') { window.selecionarClienteId(id);  ok = true; } } catch (e) {}
    try { document.dispatchEvent(new CustomEvent('cliente:selecionar', { detail: { id: id } })); ok = true; } catch (e) {}
    try { document.dispatchEvent(new CustomEvent('zc:open_chat',      { detail: { id: id } })); ok = true; } catch (e) {}
    try { document.dispatchEvent(new CustomEvent('chat:open',         { detail: { id: id } })); ok = true; } catch (e) {}
    try { window.location.hash = '#cliente-' + id; ok = true; } catch (e) {}

    getClienteDetalhe(id)
      .then(function (c) {
        if (Number(window.__CURRENT_CHAT_ID) !== Number(id)) return;
        setHeaderFromDB(c);
        forceSelectCliente(c);
        return tryEvolutionPictureIfMissing(c);
      })
      .catch(function () {});

    return ok;
  }

  // --------- Validações de entrada ---------
  function validatePhoneOrExplain(rawDigits){
    const digits = onlyDigits(String(rawDigits || ''));
    if (!digits){
      toast('Informe um telefone com DDI+DDD+Número. Ex.: 55 11 9 8888-7777', false, 3200);
      return null;
    }

    let e164 = (numeroE164(digits) || digits).replace(/\D/g,'');
    if (!e164.startsWith('55')) e164 = '55' + e164;

    if (e164.length < 12){
      toast('Telefone incompleto. Use DDI(55)+DDD(2)+Número (8 ou 9 dígitos).', false, 3200);
      return null;
    }
    if (e164.length > 13){
      toast('Telefone muito longo. Remova caracteres extras e tente novamente.', false, 3000);
      return null;
    }

    const ddd = e164.slice(2,4);
    if (!/^\d{2}$/.test(ddd) || ddd === '00'){
      toast('DDD inválido. Verifique os 2 dígitos do DDD.', false, 3000);
      return null;
    }
    return e164;
  }

  function explainCreateError(err){
    const status = Number(err && err.status || 0);
    const b = err && err.body;
    const msg = extractMessage(b);

    if (status === 400){ toast(msg || 'Dados inválidos (nome/telefone). Corrija e tente novamente.', false, 3200); return; }
    if (status === 401){ toast('Sessão expirada. Faça login novamente.', false, 2800); return; }
    if (status === 403){ toast('Você não tem permissão para criar contatos.', false, 2800); return; }
    if (status === 409){ toast('Já existe um contato com este telefone.', false, 2800); return; }
    if (status === 422){ toast(msg || 'Campos obrigatórios ausentes ou inválidos.', false, 3000); return; }
    if (status === 429){ toast('Limite de criação atingido no seu plano. Tente mais tarde ou atualize o plano.', false, 3200); return; }

    toast('Falha ao criar contato. Tente novamente.', false, 2600);
  }

  // ---------------- Drawer "Nova conversa" (SEM inline CSS) ----------------
  function buildUI() {
    if (document.getElementById('ncBackdrop')) return;

    const back = document.createElement('div');
    back.id='ncBackdrop';

    const dr = document.createElement('aside');
    dr.id='ncDrawer';

    dr.innerHTML =
      '<div class="nc-drawer-header">' +
      '  <div class="nc-drawer-title">Nova conversa</div>' +
      '  <button id="ncClose" class="nc-close" type="button" aria-label="Fechar">✕</button>' +
      '</div>' +
      '<div id="ncBody">' +
      '  <ul class="nc-list">' +
      '    <li id="ncNewContact" class="nc-item" role="button" tabindex="0">' +
      '      <div class="nc-icon-plus">+</div>' +
      '      <div>' +
      '        <div class="nc-item-title">Novo contato</div>' +
      '        <div class="nc-item-sub">Criar contato manualmente</div>' +
      '      </div>' +
      '    </li>' +
      '  </ul>' +
      '  <div class="nc-sep"></div>' +
      '  <div class="nc-tip">Dica: pesquise um nome/telefone na barra superior.</div>' +
      '</div>';

    document.body.append(back, dr);

    const close = function () {
      back.style.opacity='0';
      back.style.pointerEvents='none';
      dr.style.right='-380px';
    };
    const open  = function () {
      back.style.opacity='1';
      back.style.pointerEvents='auto';
      dr.style.right='0';
    };

    $('#ncClose') && $('#ncClose').addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    window.__NewChat = {
      open: open,
      close: close,
      setBody: function (html){
        var body = document.getElementById('ncBody');
        if (body) body.innerHTML = html;
      }
    };

    $('#ncNewContact') && $('#ncNewContact').addEventListener('click', renderNewContactForm);
    $('#ncNewContact') && $('#ncNewContact').addEventListener('keydown', function(e){
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renderNewContactForm(); }
    });
  }

  function renderNewContactForm() {
    const body =
      '<div class="nc-drawer-header">' +
      '  <div class="nc-drawer-title">Novo contato</div>' +
      '  <button id="ncBack" class="nc-back" type="button" aria-label="Voltar">←</button>' +
      '</div>' +
      '<form id="ncForm" class="nc-form">' +
      '  <input class="nc-input" id="ncName" placeholder="Nome completo" autocomplete="off"/>' +
      '  <input class="nc-input" id="ncPhone" placeholder="Telefone (DDI+DDD+Número, só dígitos)"/>' +
      '  <div class="nc-form-actions">' +
      '    <button class="nc-save" id="ncSave" type="submit">Salvar contato</button>' +
      '    <button type="button" class="nc-cancel" id="ncCancel">Cancelar</button>' +
      '  </div>' +
      '</form>';

    window.__NewChat && window.__NewChat.setBody(body);

    $('#ncCancel') && $('#ncCancel').addEventListener('click', function () { window.__NewChat && window.__NewChat.close(); });
    $('#ncBack') && $('#ncBack').addEventListener('click', buildRoot);
    $('#ncForm') && $('#ncForm').addEventListener('submit', onSaveContact);

    const name = $('#ncName');
    name && name.focus();
  }

  function buildRoot() {
    if (!window.__NewChat) return;

    window.__NewChat.close();
    setTimeout(function () { window.__NewChat && window.__NewChat.open(); }, 10);

    const b =
      '<ul class="nc-list">' +
      '  <li id="ncNewContact" class="nc-item" role="button" tabindex="0">' +
      '    <div class="nc-icon-plus">+</div>' +
      '    <div>' +
      '      <div class="nc-item-title">Novo contato</div>' +
      '      <div class="nc-item-sub">Criar contato manualmente</div>' +
      '    </div>' +
      '  </li>' +
      '</ul>' +
      '<div class="nc-sep"></div>' +
      '<div class="nc-tip">Dica: pesquise um nome/telefone na barra superior.</div>';

    window.__NewChat.setBody(b);

    $('#ncNewContact') && $('#ncNewContact').addEventListener('click', renderNewContactForm);
    $('#ncNewContact') && $('#ncNewContact').addEventListener('keydown', function(e){
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renderNewContactForm(); }
    });
  }

  // ---------------- criar/abrir contato ----------------
  async function onSaveContact(ev) {
    ev.preventDefault();

    if (!hasSelectedInstance()){
      toast('Selecione o WhatsApp para enviar mensagens.', false, 3000);
      return;
    }

    const nomeManual = String($('#ncName') && $('#ncName').value || '').trim();
    const raw        = onlyDigits($('#ncPhone') && $('#ncPhone').value || '');

    const e164 = validatePhoneOrExplain(raw);
    if (!e164) return;

    const btnSave = $('#ncSave');
    btnSave && btnSave.setAttribute('disabled', 'disabled');

    try {
      const found1 = await findClienteByTelefone(e164);
      if (found1 && found1.id) {
        window.__NewChat && window.__NewChat.close();
        setTimeout(function () { openById(found1.id); }, 0);
        return;
      }

      const with9 = insert9IfNeeded(e164);
      if (with9 !== e164) {
        const found2 = await findClienteByTelefone(with9);
        if (found2 && found2.id) {
          window.__NewChat && window.__NewChat.close();
          setTimeout(function () { openById(found2.id); }, 0);
          return;
        }
      }

      const canonical = insert9IfNeeded(e164);

      const url = '/api/clientes/novo';
      const rCreate = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Empresa-Id': String(EMPRESA_ID) },
        credentials: 'include',
        body: JSON.stringify({ nome: (nomeManual || 'Cliente'), telefone: canonical })
      });

      const text = await rCreate.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) {}

      if (!rCreate.ok){
        const err = new Error('HTTP ' + rCreate.status);
        err.status = rCreate.status; err.body = data || text; err.endpoint = url;
        throw err;
      }

      const newId  = Number(data && data.id) || null;
      if (newId) {
        const simpleCliente = { id: newId, nome: nomeManual || 'Cliente', telefone: canonical };
        forceSelectCliente(simpleCliente);

        window.__NewChat && window.__NewChat.close();
        openById(newId);

        try {
          const prof = await evoFetchProfileByNumber(canonical);
          if (prof && prof.picture) updateHeaderPicture(prof.picture);
        } catch (e) {}
        return;
      }

      toast('Não foi possível criar/abrir o contato.', false, 2600);
    } catch (e) {
      console.error('[new-chat] create failed', e);
      if (e && e.status) { explainCreateError(e); return; }
      toast('Falha ao criar contato.', false, 2400);
    } finally {
      btnSave && btnSave.removeAttribute('disabled');
    }
  }

  // ---------------- botão "+" ----------------
  function ensurePlusButtonMounted() {
    const candidates = ['#chat-header .actions', '.chat-actions', '#header-actions', '.topbar .actions', '#chat-actions', '#navbar-actions'];
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
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '</svg>';
      host.appendChild(btn);
    }

    reflectPlusBtnState(btn);

    if (!btn.dataset.boundNewChat) {
      btn.dataset.boundNewChat = '1';
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (!hasSelectedInstance()){
          toast('Selecione o WhatsApp para enviar mensagens.', false, 2800);
          return;
        }
        try { window.__NewChat && window.__NewChat.open(); } catch (err) {}
      });
    }

    if (!btn.__instEvtBound) {
      btn.__instEvtBound = true;
      document.addEventListener('inst:change', function () {
        reflectPlusBtnState(btn);
      });
    }
  }

  function wire() {
    try { buildUI(); } catch (e) { console.error('[new-chat] buildUI failed', e); }
    try { ensurePlusButtonMounted(); } catch (e) { console.error('[new-chat] ensurePlusButtonMounted failed', e); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
