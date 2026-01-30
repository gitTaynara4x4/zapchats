// /frontend/js/atendimentos/ui/notes-drawer.js
// Drawer "Notas" + botão no header (#btn-sobre).
// - Lê/salva nota por cliente no BD (campo Cliente.sobre_cliente)
// - Faz GET /api/atendimento/clientes/{cliente_id}/profile
// - Faz PATCH /api/atendimento/clientes/{cliente_id}/profile
// - Mostra mensagem de sucesso/erro pro usuário
// ✅ CSS removido (vai no atendimentos.css)

(function () {
  if (window.__zcNotesLoaded) return;
  window.__zcNotesLoaded = true;

  // ---------- tema + ícone ----------
  function getTheme(){
    try{
      const t = document.documentElement.getAttribute('data-theme');
      if (t) return t;
    }catch{}
    try{
      return (matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }catch{}
    return 'dark';
  }

  function iconSvg(theme){
    const fill = theme === 'light' ? '#080808' : '#ffffff';
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="${fill}" viewBox="0 0 256 256" aria-hidden="true">
        <path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H156.69A15.92,15.92,0,0,0,168,219.31L219.31,168A15.92,15.92,0,0,0,224,156.69V48A16,16,0,0,0,208,32ZM96,88h64a8,8,0,0,1,0,16H96a8,8,0,0,1,0-16Zm32,80H96a8,8,0,0,1,0-16h32a8,8,0,0,1,0,16ZM96,136a8,8,0,0,1,0-16h64a8,8,0,0,1,0,16Zm64,68.69V160h44.7Z"></path>
      </svg>
    `;
  }

  // ---------- contexto (empresa + cliente) ----------
  function getEmpresaId(){
    try{
      const raw = window.localStorage.getItem('empresa_id');
      const n = raw ? parseInt(raw,10) : null;
      return Number.isFinite(n) ? n : null;
    }catch{
      return null;
    }
  }

  function getSelectedClienteId(){
    // 1) #chat-header[data-cliente-id]
    const hdr = document.getElementById('chat-header');
    if (hdr){
      const cid = hdr.getAttribute('data-cliente-id') || hdr.dataset.clienteId;
      if (cid){
        const n = parseInt(cid, 10);
        if (Number.isFinite(n)) return n;
      }
    }
    // 2) fallback: state global (se você usar)
    try{
      if (window.ZC_AT_STATE && window.ZC_AT_STATE.clienteSel && window.ZC_AT_STATE.clienteSel.id){
        const n = parseInt(window.ZC_AT_STATE.clienteSel.id, 10);
        if (Number.isFinite(n)) return n;
      }
    }catch{}
    return null;
  }

  function getCtx(){
    return {
      empresaId: getEmpresaId(),
      clienteId: getSelectedClienteId(),
    };
  }

  function makeKey(ctx){
    const emp = ctx.empresaId != null ? String(ctx.empresaId) : 'noEmp';
    const cli = ctx.clienteId != null ? String(ctx.clienteId) : 'noCli';
    return `zcNotes:${emp}:cli:${cli}`;
  }

  function loadFromStorage(ctx){
    try{
      return window.localStorage.getItem(makeKey(ctx)) || '';
    }catch{
      return '';
    }
  }

  function saveToStorage(ctx, txt){
    try{
      window.localStorage.setItem(makeKey(ctx), txt || '');
      return true;
    }catch{
      return false;
    }
  }

  // ---------- fetch autenticado ----------
  function authFetchJson(url, opt = {}){
    const baseFetch = (window.ZAuth && ZAuth.authFetch) ? ZAuth.authFetch : fetch;
    const headers = Object.assign(
      { 'Accept':'application/json', 'Content-Type':'application/json' },
      opt.headers || {}
    );
    return baseFetch(url, Object.assign({}, opt, { headers }));
  }

  // ---------- status (mensagem pro usuário) ----------
  let statusTimeout = null;

  function getStatusEl(){
    return document.getElementById('zcNotesStatus');
  }

  function ensureStatusEl(){
    let el = getStatusEl();
    if (el) return el;

    const body = document.querySelector('.zcNotes-body');
    if (!body) return null;

    el = document.createElement('div');
    el.id = 'zcNotesStatus';
    el.className = 'zcNotes-status';

    const actions = body.querySelector('.zcNotes-actions');
    body.insertBefore(el, actions || body.firstChild);
    return el;
  }

  function clearStatus(){
    if (statusTimeout){
      clearTimeout(statusTimeout);
      statusTimeout = null;
    }
    const el = getStatusEl();
    if (!el) return;
    el.textContent = '';
    el.classList.remove('ok','err');
    el.style.display = 'none';
    el.style.opacity = '';
  }

  function showStatus(msg, kind){
    const el = ensureStatusEl();
    if (!el) return;

    el.textContent = msg;
    el.classList.remove('ok','err');
    if (kind === 'ok') el.classList.add('ok');
    if (kind === 'err') el.classList.add('err');

    el.style.display = 'block';
    el.style.opacity = '1';

    if (statusTimeout) clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => {
        if (el.textContent === msg){
          el.style.display = 'none';
          el.style.opacity = '';
        }
      }, 300);
    }, 2600);
  }

  // ---------- BD: carregar nota existente ----------
  async function loadFromBackend(ctx){
    if (!ctx || !ctx.clienteId) return;
    const expectedKey = makeKey(ctx);

    try{
      console.log('[NOTES] GET profile ctx=', ctx);
      const res = await authFetchJson(`/api/atendimento/clientes/${ctx.clienteId}/profile`, {
        method: 'GET'
      });

      if (!res.ok){
        console.warn('[NOTES] GET profile falhou:', res.status);
        return;
      }

      const data = await res.json().catch(() => null);
      const note = data && (data.sobre_cliente || data.sobreCliente || '');

      const ta = document.getElementById('zcNotesText');
      if (!ta) return;

      const ctxNow = getCtx();
      if (makeKey(ctxNow) !== expectedKey){
        console.log('[NOTES] contexto mudou durante GET, ignorando resposta.');
        return;
      }

      if (!ta.value.trim()){
        ta.value = note || '';
      }
      saveToStorage(ctxNow, ta.value || '');
    }catch(err){
      console.error('[NOTES] erro ao carregar nota do BD:', err);
    }
  }

  // ---------- BD: salvar nota ----------
  async function saveToBackend(ctx, txt){
    if (!ctx || !ctx.clienteId){
      showStatus('Não foi possível identificar o cliente. Nota salva apenas neste navegador.', 'err');
      return false;
    }

    const payload = { sobre_cliente: txt || null };
    console.log('[NOTES] PATCH profile ctx=', ctx, 'payload=', payload);

    try{
      const res = await authFetchJson(`/api/atendimento/clientes/${ctx.clienteId}/profile`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data || data.ok !== true){
        console.warn('[NOTES] PATCH profile falhou:', res.status, data);
        showStatus('Não foi possível salvar as notas no servidor.', 'err');
        return false;
      }

      showStatus('Notas salvas com sucesso.', 'ok');
      return true;
    }catch(err){
      console.error('[NOTES] erro ao salvar nota no BD:', err);
      showStatus('Erro de conexão ao salvar as notas.', 'err');
      return false;
    }
  }

  // ---------- cria o drawer uma vez ----------
  function ensureDrawer(){
    if (document.getElementById('zcNotesDrawer')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'zcNotesBackdrop';
    backdrop.className = 'zcNotes-backdrop';

    const drawer = document.createElement('aside');
    drawer.id = 'zcNotesDrawer';
    drawer.className = 'zcNotes-drawer';
    drawer.setAttribute('role','dialog');
    drawer.setAttribute('aria-modal','true');

    drawer.innerHTML = `
      <div class="zcNotes-head">
        <div class="zcNotes-title">
          <span class="zcNotes-icon" aria-hidden="true">${iconSvg(getTheme())}</span> Notas
        </div>
        <button class="zcNotes-close" id="zcNotesClose" title="Fechar" aria-label="Fechar notas">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" aria-hidden="true" viewBox="0 0 256 256"><path fill="currentColor" d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66A8 8 0 0 1 61.66 50.34L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128z"/></svg>
        </button>
      </div>
      <div class="zcNotes-body">
        <textarea id="zcNotesText" class="zcNotes-text" placeholder="Escreva anotações sobre este contato…"></textarea>
        <div class="zcNotes-actions">
          <button id="zcNotesSave" class="zcNotes-btnPrimary" type="button">Salvar</button>
          <button id="zcNotesCancel" class="zcNotes-btnGhost" type="button">Cancelar</button>
        </div>
        <div id="zcNotesStatus" class="zcNotes-status" aria-live="polite"></div>
      </div>
    `;

    document.body.append(backdrop, drawer);

    function open(){
      backdrop.classList.add('is-open');
      drawer.classList.add('is-open');
      try { document.querySelector('main')?.setAttribute('inert',''); } catch {}
      clearStatus();

      const ta = document.getElementById('zcNotesText');
      if (ta) ta.value = '';

      const ctx = getCtx();
      console.log('[NOTES] open ctx=', ctx, 'key=', makeKey(ctx));

      // 1) cache local
      const localTxt = loadFromStorage(ctx);
      if (ta && localTxt){
        ta.value = localTxt;
      }

      // 2) BD
      loadFromBackend(ctx);

      setTimeout(()=> document.getElementById('zcNotesText')?.focus(), 0);
    }

    function close(){
      backdrop.classList.remove('is-open');
      drawer.classList.remove('is-open');
      try { document.querySelector('main')?.removeAttribute('inert'); } catch {}
    }

    document.getElementById('zcNotesClose')?.addEventListener('click', close);
    document.getElementById('zcNotesCancel')?.addEventListener('click', close);
    backdrop.addEventListener('click', (e)=>{ if (e.target === backdrop) close(); });
    document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') close(); });

    const ta = document.getElementById('zcNotesText');
    if (ta){
      ta.addEventListener('input', () => {
        const ctx = getCtx();
        saveToStorage(ctx, ta.value || '');
      });
    }

    document.getElementById('zcNotesSave')?.addEventListener('click', async () => {
      const textarea = document.getElementById('zcNotesText');
      const txt = (textarea?.value || '').trim();
      const ctx = getCtx();
      saveToStorage(ctx, txt || '');
      await saveToBackend(ctx, txt);
    });

    window.zcNotes = { open, close };
  }

  // ---------- botão no header ----------
  function ensureHeaderNotesButton(){
    const btn = document.getElementById('btn-sobre');
    if (!btn) return;
    if (btn.dataset.bound === '1') return;

    btn.dataset.bound = '1';
    btn.setAttribute('title', 'Notas do cliente');
    btn.setAttribute('aria-label', 'Notas do cliente');
    btn.setAttribute('data-notes-open', '1');
    btn.innerHTML = `<span class="zcNotes-icon" aria-hidden="true">${iconSvg(getTheme())}</span>`;

    btn.addEventListener('click', (e)=>{
      e.preventDefault();
      ensureDrawer();
      window.zcNotes.open();
    });

    const updateBtnIcon = ()=> {
      const holder = btn.querySelector('.zcNotes-icon');
      if (holder) holder.innerHTML = iconSvg(getTheme());
    };
    addEventListener('theme:changed', updateBtnIcon);
    addEventListener('storage', (e)=>{ if(e && e.key === 'zc:theme') updateBtnIcon(); });
    try {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      (mq.addEventListener ? mq.addEventListener('change', updateBtnIcon) : mq.addListener(updateBtnIcon));
    } catch {}
  }

  // ---------- click qualquer data-notes-open ----------
  document.addEventListener('click', (ev)=>{
    const el = ev.target.closest('[data-notes-open]');
    if (!el) return;
    ev.preventDefault();
    ensureDrawer();
    window.zcNotes.open();
  });

  // Observa o header aparecer
  const hdr = document.getElementById('chat-header');
  if (hdr) {
    const mo = new MutationObserver(()=> ensureHeaderNotesButton());
    mo.observe(hdr, { attributes:true, attributeFilter:['style','class'] });
  }
  ensureHeaderNotesButton();

  // helper global pra você amarrar o cliente no header
  window.zcNotesSetContextFromCliente = function(cliente){
    try{
      const hdr = document.getElementById('chat-header');
      if (!hdr || !cliente) return;
      if (cliente.id != null){
        hdr.dataset.clienteId = String(cliente.id);
      }
    }catch{}
  };
})();
