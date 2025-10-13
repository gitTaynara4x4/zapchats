// /frontend/js/atendimentos/ui/new-chat.js
// Nova conversa – agora com mensagens de erro mais específicas para casos de erro do cliente
// Regras:
// - Achou cliente no BD → abre conversa direto. Header usa nome/avatar do BD (se tiver).
// - Achou cliente no BD mas não tem conversa → idem (nome do BD, avatar do BD ou vazio).
// - Não achou cliente → cria com o nome digitado no formulário; abre; depois tenta buscar
//   foto no Evolution e só ATUALIZA A FOTO (não mexe no nome).

import { EMPRESA_ID } from '../core/env.js';
import { numeroE164 } from '../core/format.js';

(function () {
  // ---------------- helpers ----------------
  const $  = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
  const ensure55 = (d) => (String(d || '').startsWith('55') ? String(d) : '55' + String(d || ''));
  const insert9IfNeeded = (d) => {
    if (!/^55\d{2}\d+$/.test(d)) return d;
    const ddd = d.slice(2, 4), rest = d.slice(4);
    return rest.length === 8 ? `55${ddd}9${rest}` : d;
  };
  const digitsFromJid = (jid) => String(jid || '').replace(/@.*$/, '').replace(/\D/g, '');
  const isTpl = (s) => /\{\{[^}]+\}\}/.test(String(s || ''));
  const formatTelBR = (d) => String(onlyDigits(d)).replace(/^(\+?55)?(\d{2})(\d{4,5})(\d{4})$/, '+55 ($2) $3-$4');

  // Toast com duração customizável
  function toast(msg, ok = true, ms = 2200) {
    let t = $('#__app_toast');
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
    t.__timer = setTimeout(() => { t.style.opacity = '0'; }, Math.max(1200, Number(ms)||2200));
  }

  // Helpers de parsing de erro
  const pick = (o, keys) => keys.map(k => o && o[k]).find(Boolean);
  function extractMessage(obj){
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj)) return extractMessage(obj[0]);
    return (
      pick(obj,['message','msg','detail','error','erro','status','reason','descricao']) ||
      (obj.error && (obj.error.message||obj.error.msg)) ||
      (Array.isArray(obj.detail) && obj.detail[0] && (obj.detail[0].msg || obj.detail[0].message)) ||
      ''
    );
  }

  // ---------------- Evolution (sem URL hardcoded) ----------------
  const ENV = (typeof window !== 'undefined' && (window.ENV || {})) || {};
  const EVO_CFG = ENV.EVOLUTION || window.EVOLUTION || {};
  let EVO_URL  = String(EVO_CFG.apiUrl || '').replace(/\/+$/, '');
  let EVO_KEY  = String(EVO_CFG.apiKey || localStorage.getItem('evo_api_key') || '');
  let DEFAULT_EVO_INSTANCE = String(EVO_CFG.defaultInstance || '');

  async function ensureEvoConfig() {
    if (EVO_URL && !isTpl(EVO_URL)) return;
    try {
      const r = await fetch('/api/env/evolution', { credentials: 'include' });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j.apiUrl && !isTpl(j.apiUrl)) EVO_URL = String(j.apiUrl).replace(/\/+$/, '');
        if (!EVO_KEY && j.apiKey) EVO_KEY = String(j.apiKey);
        if (!DEFAULT_EVO_INSTANCE && j.defaultInstance && !isTpl(j.defaultInstance)) {
          DEFAULT_EVO_INSTANCE = String(j.defaultInstance);
        }
      }
    } catch {}
    if (!EVO_URL) throw new Error('Evolution URL ausente (configure em env.js ou /api/env/evolution).');
  }

  function resolveInstanceSlug() {
    const mem = (typeof localStorage !== 'undefined' && localStorage.getItem('evo_instance')) || '';
    const act = (typeof window !== 'undefined') ? window.INSTANCIA_ATIVA : null;
    const v = (act && String(act).trim()) || (mem && String(mem).trim()) ||
              (DEFAULT_EVO_INSTANCE && String(DEFAULT_EVO_INSTANCE).trim()) || '';
    if (!v || isTpl(v)) throw new Error('Evolution instance ausente.');
    return v;
  }

  // Retorna erro enriquecido quando Evolution responde !=200 para permitir mensagens específicas
  async function evoCheckNumber(e164Digits) {
    await ensureEvoConfig();
    const instance = resolveInstanceSlug();
    const url = `${EVO_URL}/chat/whatsappNumbers/${encodeURIComponent(instance)}`;
    const headers = { 'Content-Type': 'application/json' };
    if (EVO_KEY) headers['apikey'] = EVO_KEY;

    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ numbers: [e164Digits] }) });
    const text = await resp.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch {}

    if (!resp.ok) {
      const err = new Error(`Evolution ${resp.status}`);
      err.name = 'EvolutionError';
      err.status = resp.status;
      err.body = data || text;
      err.instance = instance;
      err.endpoint = url;
      throw err;
    }

    let exists = false, jid = null;
    const tryRead = (e) => {
      if (!e) return;
      if (jid == null && e.jid) jid = e.jid;
      const v = (e.exists===true)||(e.isWA===true)||(e.isWhatsapp===true)||(e.valid===true)||
                (e.available===true)||(e.canReceive===true)||
                (/^(ok|true|valid|exists|available)$/i.test(String(e.status||'')));
      if (v) exists = true;
    };
    [data, data?.results, data?.response, data?.numbers].some(b => {
      if (Array.isArray(b) && b.length) { tryRead(b[0]); return true; }
      if (b && !Array.isArray(b)) { tryRead(b); return true; }
      return false;
    });
    try { localStorage.setItem('evo_instance', instance); } catch {}
    const canonical = jid ? digitsFromJid(jid) : null;
    return { exists: !!exists, canonical, jid: jid || null, raw: data };
  }

  async function evoFetchProfile(jid) {
    await ensureEvoConfig();
    const instance = resolveInstanceSlug();
    const url = `${EVO_URL}/chat/fetchProfile/${encodeURIComponent(instance)}`;
    const headers = { 'Content-Type': 'application/json' };
    if (EVO_KEY) headers['apikey'] = EVO_KEY;

    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ wuid: String(jid) }) });
    if (!r.ok) throw new Error(`Evolution profile HTTP ${r.status}`);
    const p = await r.json().catch(() => ({}));

    try { localStorage.setItem('evo_instance', instance); } catch {}
    return {
      name: String(p?.name || '').trim() || null,
      picture: String(p?.picture || '').trim() || null,
      statusTxt: (p?.status && (p.status.status || p.status.text)) || p?.description || null,
      raw: p
    };
  }

  // ---------------- backend utils ----------------
  async function getClienteDetalhe(id){
    const r = await fetch(`/api/clientes/${id}?empresa_id=${encodeURIComponent(String(EMPRESA_ID))}`, { credentials:'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }

  async function findClienteByTelefone(e164Digits) {
    const qs = new URLSearchParams({ empresa_id:String(EMPRESA_ID), q:e164Digits, limit:'5', offset:'0' });
    const r = await fetch(`/api/clientes?${qs.toString()}`, { credentials:'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = await r.json().catch(() => ({}));
    const items = Array.isArray(list?.items) ? list.items : [];
    const onlyD = (s) => String(s || '').replace(/\D/g, '');
    const without55 = e164Digits.startsWith('55') ? e164Digits.slice(2) : e164Digits;
    return items.find(i => {
      const tel = onlyD(i?.telefone || '');
      return tel === e164Digits || tel === without55;
    }) || null;
  }

  // ---------------- header (sem placeholder) ----------------
  const TITLE_SELS  = ['#chat-header .title', '.chat-title', '[data-role="chat-title"]', '#chatTitle', 'header .title'];
  const SUB_SELS    = ['#chat-header .subtitle', '.chat-subtitle', '[data-role="chat-subtitle"]', '#chatSubtitle', 'header .subtitle'];
  const AVATAR_SELS = ['#chat-header .avatar img', '.chat-avatar img', 'img.avatar', 'img[alt="avatar"]'];

  function qAny(sels){ for (const s of sels){ const el=$(s); if (el) return el; } return null; }

  function setHeaderFromDB(cliente) {
    const tel = onlyDigits(cliente?.telefone || cliente?.whatsapp || '');
    const name = cliente?.nome || (tel ? formatTelBR(tel) : 'Cliente');

    const titleEl = qAny(TITLE_SELS);
    const subEl   = qAny(SUB_SELS);
    const imgEl   = qAny(AVATAR_SELS);

    if (titleEl) titleEl.textContent = name;
    if (subEl)   subEl.textContent   = '';
    if (imgEl) {
      if (cliente?.avatar_url) {
        imgEl.src = cliente.avatar_url;
        imgEl.removeAttribute('srcset');
      }
    }

    try { window.__HEADER_LOCKED_NAME = name; } catch {}
  }

  function updateHeaderPicture(url) {
    if (!url) return;
    const imgEl = qAny(AVATAR_SELS);
    if (imgEl) {
      imgEl.src = url;
      imgEl.removeAttribute('srcset');
    }
  }

  async function tryEvolutionPictureIfMissing(cliente) {
    if (cliente?.avatar_url) return;

    const telRaw = onlyDigits(cliente?.telefone || cliente?.whatsapp || '');
    if (!telRaw) return;

    let d = ensure55(telRaw);
    let jid = `${d}@s.whatsapp.net`;

    try {
      const p = await evoFetchProfile(jid);
      if (p?.picture) updateHeaderPicture(p.picture);
      return;
    } catch {}

    try {
      const with9 = insert9IfNeeded(d);
      if (with9 !== d) {
        jid = `${with9}@s.whatsapp.net`;
        const p2 = await evoFetchProfile(jid);
        if (p2?.picture) updateHeaderPicture(p2.picture);
        return;
      }
    } catch {}

    try {
      const chk = await evoCheckNumber(d);
      const can = chk.canonical || d;
      jid = chk.jid || `${can}@s.whatsapp.net`;
      const p3 = await evoFetchProfile(jid);
      if (p3?.picture) updateHeaderPicture(p3.picture);
    } catch {}
  }

  // ---------------- abrir chat (sem placeholders) ----------------
  function openById(id) {
    id = Number(id);
    if (!Number.isFinite(id)) return false;
    let ok = false;
    try { window.__CURRENT_CHAT_ID = id; } catch {}

    try { if (typeof window.selecionarClienteObj === 'function') { window.selecionarClienteObj(id); ok = true; } } catch {}
    try { if (typeof window.selecionarClienteId  === 'function') { window.selecionarClienteId(id);  ok = true; } } catch {}
    try { document.dispatchEvent(new CustomEvent('cliente:selecionar', { detail: { id } })); ok = true; } catch {}
    try { document.dispatchEvent(new CustomEvent('zc:open_chat',      { detail: { id } })); ok = true; } catch {}
    try { document.dispatchEvent(new CustomEvent('chat:open',         { detail: { id } })); ok = true; } catch {}
    try { location.hash = `#cliente-${id}`; ok = true; } catch {}

    getClienteDetalhe(id)
      .then(c => {
        if (Number(window.__CURRENT_CHAT_ID) !== Number(id)) return;
        setHeaderFromDB(c);
        return tryEvolutionPictureIfMissing(c);
      })
      .catch(() => {});

    return ok;
  }

  // --------- Validações de entrada (erros de cliente) ---------
  function validatePhoneOrExplain(rawDigits){
    const digits = onlyDigits(String(rawDigits||''));
    if (!digits){
      toast('Informe um telefone com DDI+DDD+Número. Ex.: 55 11 9 8888‑7777', false, 3200);
      return null;
    }

    // Normaliza para E.164 BR
    let e164 = (numeroE164(digits) || digits).replace(/\D/g,'');
    if (!e164.startsWith('55')) e164 = '55' + e164;

    // Comprimento mínimo/máximo
    // 55 + DDD (2) + número (8 ou 9)
    if (e164.length < 12){
      toast('Telefone incompleto. Use DDI(55)+DDD(2)+Número (8 ou 9 dígitos).', false, 3200);
      return null;
    }
    if (e164.length > 13){
      toast('Telefone muito longo. Remova caracteres extras e tente novamente.', false, 3000);
      return null;
    }

    // Heurística de móvel/fixo (Brasil): se tiver 9 na frente é celular; com 8 pode ser fixo
    const ddd = e164.slice(2,4);
    const local = e164.slice(4);
    if (!/^\d{2}$/.test(ddd) || ddd === '00'){
      toast('DDD inválido. Verifique os 2 dígitos do DDD.', false, 3000);
      return null;
    }
    if (local.length === 8){
      // não bloqueia, mas informa que tentaremos adicionar o 9 ao validar
      // Apenas segue; a verificação Evolution vai confirmar.
    } else if (local.length === 9 && !/^9\d{8}$/.test(local)){
      // 9 dígitos mas não começa com 9 — provavelmente não é celular
      // Não bloqueia, mas avisa em caso de falha posterior
    }

    return e164;
  }

  function explainEvolutionError(err, e164){
    const tel = formatTelBR(e164);
    const status = Number(err?.status || 0);
    const b = err?.body;
    const msg = extractMessage(b);

    if (status === 400){
      // Normalmente, erro de entrada (telefone mal formatado)
      toast(msg || `Telefone inválido para validação no WhatsApp (${tel}). Confira DDI/DDD e o dígito 9.`, false, 4000);
      return;
    }
    if (status === 401){ toast('API Key da Evolution inválida. Configure uma chave válida para validar números.', false, 3500); return; }
    if (status === 403){ toast('Sem permissão para validar números nesta instância Evolution.', false, 3200); return; }
    if (status === 404){ toast('Instância da Evolution não encontrada. Selecione/defina a instância correta.', false, 3200); return; }
    if (status === 429){ toast('Você atingiu o limite de validações. Aguarde um pouco e tente de novo.', false, 3200); return; }

    // Falhas de rede/SSL ou 5xx — não culpa do cliente
    toast('Não foi possível validar o número no provedor. Tente novamente em instantes.', false, 3200);
  }

  function explainCreateError(err){
    const status = Number(err?.status || 0);
    const b = err?.body;
    const msg = extractMessage(b);

    if (status === 400){ toast(msg || 'Dados inválidos (nome/telefone). Corrija e tente novamente.', false, 3200); return; }
    if (status === 401){ toast('Sessão expirada. Faça login novamente.', false, 2800); return; }
    if (status === 403){ toast('Você não tem permissão para criar contatos.', false, 2800); return; }
    if (status === 409){ toast('Já existe um contato com este telefone.', false, 2800); return; }
    if (status === 422){ toast(msg || 'Campos obrigatórios ausentes ou inválidos.', false, 3000); return; }
    if (status === 429){ toast('Limite de criação atingido no seu plano. Tente mais tarde ou atualize o plano.', false, 3200); return; }

    toast('Falha ao criar contato. Tente novamente.', false, 2600);
  }

  // ---------------- Drawer "Nova conversa" ----------------
  function buildUI() {
    if ($('#ncBackdrop')) return;
    const back = document.createElement('div'); back.id='ncBackdrop';
    Object.assign(back.style,{position:'fixed',inset:'0',background:'rgba(0,0,0,.35)',backdropFilter:'saturate(140%) blur(2px)',opacity:'0',pointerEvents:'none',transition:'opacity .18s',zIndex:'60'});
    const dr = document.createElement('aside'); dr.id='ncDrawer';
    Object.assign(dr.style,{position:'fixed',top:0,right:'-380px',width:'360px',maxWidth:'95vw',height:'100%',background:'#111b21',color:'#e9edef',
      borderLeft:'1px solid #223038',boxShadow:'-20px 0 50px rgba(0,0,0,.35)',transition:'right .22s',zIndex:'61',display:'flex',flexDirection:'column'});

    dr.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #223038">
        <div style="font-weight:600">Nova conversa</div>
        <button id="ncClose" style="background:transparent;border:0;color:#aebac1;cursor:pointer;padding:6px;border-radius:8px">✕</button>
      </div>
      <div style="padding:8px" id="ncBody">
        <ul style="list-style:none;margin:6px 0;padding:0;display:flex;flex-direction:column;gap:6px">
          <li id="ncNewContact" style="display:flex;gap:12px;align-items:center;padding:10px;border-radius:12px;border:1px solid #223038;background:#0b141a;cursor:pointer">
            <div style="width:38px;height:38px;border-radius:999px;background:#00a884;display:grid;place-items:center;color:#0b141a;font-weight:700">+</div>
            <div><div style="font-weight:600">Novo contato</div><div style="font-size:12px;color:#9aaeb5">Criar contato manualmente</div></div>
          </li>
        </ul>
        <div style="border-top:1px solid #223038;margin:8px 0"></div>
        <div style="padding:8px 10px;color:#9aaeb5;font-size:12px">Dica: pesquise um nome/telefone na barra superior.</div>
      </div>
    `;

    document.body.append(back, dr);
    const close = () => { back.style.opacity='0'; back.style.pointerEvents='none'; dr.style.right='-380px'; };
    const open  = () => { back.style.opacity='1'; back.style.pointerEvents='auto'; dr.style.right='0'; };
    $('#ncClose')?.addEventListener('click', close);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    window.__NewChat = { open, close, setBody(html){ $('#ncBody').innerHTML = html; } };
    $('#ncNewContact')?.addEventListener('click', renderNewContactForm);
  }

  function renderNewContactForm() {
    const body = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #223038">
        <div style="font-weight:600">Novo contato</div>
        <button id="ncBack" style="background:transparent;border:0;color:#aebac1;cursor:pointer;padding:6px;border-radius:8px">←</button>
      </div>
      <form id="ncForm" style="display:flex;flex-direction:column;gap:10px;padding:8px">
        <input class="nc-input" id="ncName" placeholder="Nome completo" autocomplete="off" style="background:#0b141a;border:1px solid #223038;border-radius:10px;color:#e9edef;padding:10px 12px;outline:none"/>
        <input class="nc-input" id="ncPhone" placeholder="Telefone (DDI+DDD+Número, só dígitos)" style="background:#0b141a;border:1px solid #223038;border-radius:10px;color:#e9edef;padding:10px 12px;outline:none"/>
        <div style="display:flex;gap:8px">
          <button class="nc-btn" id="ncSave" type="submit" style="background:#00a884;border:0;color:#0b141a;font-weight:700;padding:10px 12px;border-radius:10px;cursor:pointer">Salvar contato</button>
          <button type="button" id="ncCancel" style="background:transparent;border:0;color:#9aaeb5;cursor:pointer">Cancelar</button>
        </div>
      </form>`;
    window.__NewChat.setBody(body);
    $('#ncCancel')?.addEventListener('click', () => window.__NewChat.close());
    $('#ncBack')?.addEventListener('click', buildRoot);
    $('#ncForm')?.addEventListener('submit', onSaveContact);
    $('#ncName')?.focus();
  }

  function buildRoot() {
    window.__NewChat.close();
    setTimeout(() => window.__NewChat.open(), 10);
    const b = `
      <ul style="list-style:none;margin:6px 0;padding:0;display:flex;flex-direction:column;gap:6px">
        <li id="ncNewContact" style="display:flex;gap:12px;align-items:center;padding:10px;border-radius:12px;border:1px solid #223038;background:#0b141a;cursor:pointer">
          <div style="width:38px;height:38px;border-radius:999px;background:#00a884;display:grid;place-items:center;color:#0b141a;font-weight:700">+</div>
          <div><div style="font-weight:600">Novo contato</div><div style="font-size:12px;color:#9aaeb5">Criar contato manualmente</div></div>
        </li>
      </ul>
      <div style="border-top:1px solid #223038;margin:8px 0"></div>
      <div style="padding:8px 10px;color:#9aaeb5;font-size:12px">Dica: pesquise um nome/telefone na barra superior.</div>`;
    window.__NewChat.setBody(b);
    $('#ncNewContact')?.addEventListener('click', renderNewContactForm);
  }

  // ---------------- criar/abrir contato ----------------
  async function onSaveContact(ev) {
    ev.preventDefault();

    const nomeManual = String($('#ncName')?.value || '').trim();
    const raw        = onlyDigits($('#ncPhone')?.value || '');

    const e164 = validatePhoneOrExplain(raw);
    if (!e164) return; // já mostramos o motivo

    $('#ncSave')?.setAttribute('disabled', 'disabled');

    try {
      // Já existe (qualquer variante)?
      const found1 = await findClienteByTelefone(e164);
      if (found1?.id) { window.__NewChat.close(); setTimeout(() => openById(found1.id), 0); return; }

      const with9 = insert9IfNeeded(e164);
      if (with9 !== e164) {
        const found2 = await findClienteByTelefone(with9);
        if (found2?.id) { window.__NewChat.close(); setTimeout(() => openById(found2.id), 0); return; }
      }

      // Valida número na Evolution (para explicar "número não existe")
      if (!EVO_KEY && !localStorage.getItem('evo_api_key')) {
        toast('Configure a API key da Evolution para validar o número.', false, 3200); return;
      }

      let existsCheck = null;
      try {
        existsCheck = await evoCheckNumber(e164);
      } catch (err) {
        explainEvolutionError(err, e164);
        return; // interrompe o fluxo
      }

      if (!existsCheck?.exists){
        const shown = formatTelBR(insert9IfNeeded(e164));
        toast(`Este número não está no WhatsApp: ${shown}. Verifique o DDD e o dígito 9.`, false, 4200);
        return;
      }

      const canonical = (existsCheck.canonical || with9 || e164);

      // Cria no backend com o NOME DIGITADO (sem esperar Evolution)
      const url = '/api/clientes/novo';
      const rCreate = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Empresa-Id': String(EMPRESA_ID) },
        credentials: 'include',
        body: JSON.stringify({ nome: (nomeManual || 'Cliente'), telefone: canonical })
      });

      const text = await rCreate.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch {}

      if (!rCreate.ok){
        const err = new Error(`HTTP ${rCreate.status}`);
        err.status = rCreate.status; err.body = data || text; err.endpoint = url;
        throw err;
      }

      const newId  = Number(data?.id) || null;
      if (newId) {
        window.__NewChat.close();
        openById(newId);
        try {
          const jid = `${canonical}@s.whatsapp.net`;
          const profile = await evoFetchProfile(jid);
          if (profile?.picture) updateHeaderPicture(profile.picture);
        } catch {}
        return;
      }

      toast('Não foi possível criar/abrir o contato.', false, 2600);
    } catch (e) {
      console.error('[new-chat] create failed', e);
      if (e?.status) return explainCreateError(e);
      toast('Falha ao criar contato.', false, 2400);
    } finally {
      $('#ncSave')?.removeAttribute('disabled');
    }
  }

  // ---------------- botão "+" ----------------
  function ensurePlusButtonMounted() {
    const candidates = ['#chat-header .actions', '.chat-actions', '#header-actions', '.topbar .actions', '#chat-actions', '#navbar-actions'];
    let host = null;
    for (const sel of candidates) { host = document.querySelector(sel); if (host) break; }
    if (!host) host = document.querySelector('#chat-header, .topbar, header');
    if (!host) return;

    let btn = document.getElementById('btn-sidemodal-nova-conversa');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btn-sidemodal-nova-conversa';
      btn.type = 'button';
      btn.title = 'Nova conversa';
      btn.setAttribute('aria-label', 'Nova conversa');
      Object.assign(btn.style,{display:'inline-flex',alignItems:'center',justifyContent:'center',width:'32px',height:'32px',marginLeft:'8px',
        borderRadius:'8px',background:'transparent',border:'1px solid #223038',color:'#aebac1',cursor:'pointer'});
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style="width:18px;height:18px">
        <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
      host.appendChild(btn);
    }
    if (!btn.dataset.boundNewChat) {
      btn.dataset.boundNewChat = '1';
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); try { window.__NewChat?.open(); } catch {} });
    }
  }

  function wire() { buildUI(); ensurePlusButtonMounted(); }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', wire); } else { wire(); }
  try { new MutationObserver(() => ensurePlusButtonMounted()).observe(document.body, { childList: true, subtree: true }); } catch {}
})();
