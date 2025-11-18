// /frontend/js/atendimentos/ui/notes-drawer.js
// Drawer "Notas" + botão no header (#btn-sobre), alinhado e com feedback visual igual ao #btn-ia.
// Agora: salva em BD (sobre_cliente) e busca nota existente por cliente.

(function () {
  if (window.__zcNotesLoaded) return;
  window.__zcNotesLoaded = true;

  // ---------- CSS ----------
  const CSS = `
  .zcNotes-backdrop{
    position:fixed;inset:0;background:rgba(0,0,0,.42);
    opacity:0;pointer-events:none;transition:opacity .18s ease;z-index:9998
  }
  .zcNotes-backdrop.is-open{opacity:1;pointer-events:auto}

  .zcNotes-drawer{
    position:fixed;top:0;right:0;height:100vh;width:min(520px,95vw);
    background:#1f2c33;color:#e9edef;border-left:1px solid #26343a;
    transform:translateX(100%);transition:transform .18s ease;z-index:9999;
    display:flex;flex-direction:column;pointer-events:none
  }
  .zcNotes-drawer.is-open{transform:translateX(0);pointer-events:auto}

  .zcNotes-head{
    display:flex;align-items:center;justify-content:space-between;
    padding:12px 16px;border-bottom:1px solid #26343a
  }
  .zcNotes-title{font-weight:600;font-size:16px;display:flex;align-items:center;gap:8px}

  /* Ícone (no título do drawer e no #btn-sobre) */
  .zcNotes-icon{display:inline-flex;align-items:center;line-height:0}
  .zcNotes-icon svg{
    display:block;width:24px;height:24px;vertical-align:middle;
    transform: translateY(1px); /* nudge p/ baixo = mesma linha do #btn-ia */
    /* mesma vibe do IA (leve glow) */
    filter: drop-shadow(0 0 5px rgba(168,85,247,.50));
  }

  .zcNotes-close{background:transparent;border:0;color:#aebac1;cursor:pointer;padding:6px;border-radius:8px}
  .zcNotes-close:hover{color:#fff;background:#233238}

  .zcNotes-body{flex:1;display:flex;flex-direction:column;gap:12px;padding:14px}
  .zcNotes-text{
    flex:1;min-height:220px;background:#0b141a;color:#e9edef;border:1px solid #2a3942;
    border-radius:12px;padding:12px;outline:none;resize:vertical
  }
  .zcNotes-actions{display:flex;gap:10px;margin-top:auto}

  .zcNotes-btnPrimary{
    flex:1;background:#25d366;border:1px solid #1fb05a;color:#061a0e;
    padding:10px 12px;border-radius:10px;cursor:pointer;font-weight:600
  }
  .zcNotes-btnPrimary:hover{filter:brightness(1.05)}
  .zcNotes-btnGhost{
    flex:1;background:transparent;border:1px solid #2a3942;color:#e9edef;
    padding:10px 12px;border-radius:10px;cursor:pointer
  }
  .zcNotes-btnGhost:hover{background:#152028}

  /* Mensagem de status (sucesso/erro) */
  .zcNotes-status{
    font-size:12px;
    color:#9ca3af;
    margin-bottom:4px;
    min-height:1em;
    display:none;
    transition:opacity .2s ease;
  }
  .zcNotes-status.ok{ color:#22c55e; }   /* verde */
  .zcNotes-status.err{ color:#f97373; }  /* vermelho */

  /* Botão no header: mesma caixa/feedback do #btn-ia */
  #btn-sobre{
    display:inline-grid;place-items:center;
    width:24px;height:24px;line-height:0;
    padding:0;background:transparent;border:0;
    margin-left:6px;margin-right:0;vertical-align:middle;
    border-radius:8px; cursor:pointer;
    transition: background .15s, color .15s, transform .08s;
    color: inherit;
  }
  /* hover sutil no dark */
  #btn-sobre:hover{ background:rgba(255,255,255,.06); }
  /* hover sutil no light */
  html[data-theme="light"] #btn-sobre:hover{ background:rgba(0,0,0,.06); }
  /* feedback de click (pressionado) */
  #btn-sobre:active{ transform: translateY(1px); }
  /* acessibilidade: foco visível */
  #btn-sobre:focus-visible{
    outline:2px solid color-mix(in oklab, var(--accent) 55%, transparent);
    outline-offset:2px;
  }

  @media (max-width: 480px){ .zcNotes-drawer{width:100vw} }
  `;

  // injeta CSS
  (function injectCSS(){
    if (!document.getElementById('zcNotes-style')) {
      const st = document.createElement('style');
      st.id = 'zcNotes-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
  })();

  // ---------- helpers de tema + ícone ----------
  function _getTheme(){
    try{
      const t = document.documentElement.getAttribute('data-theme');
      if (t) return t;
    }catch{}
    try{ return (matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; }catch{}
    return 'dark';
  }
  // ÍCONE: dark -> #ffffff, light -> #080808 (24×24)
  function _iconSvg(theme){
    const fill = theme === 'light' ? '#080808' : '#ffffff';
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="${fill}" viewBox="0 0 256 256" aria-hidden="true">
        <path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H156.69A15.92,15.92,0,0,0,168,219.31L219.31,168A15.92,15.92,0,0,0,224,156.69V48A16,16,0,0,0,208,32ZM96,88h64a8,8,0,0,1,0,16H96a8,8,0,0,1,0-16Zm32,80H96a8,8,0,0,1,0-16h32a8,8,0,0,1,0,16ZM96,136a8,8,0,0,1,0-16h64a8,8,0,0,1,0,16Zm64,68.69V160h44.7Z"></path>
      </svg>
    `;
  }

  // ---------- helpers de contexto / storage / fetch ----------
  function getEmpresaId(){
    try{
      const raw = window.localStorage.getItem('empresa_id');
      const n = raw ? parseInt(raw, 10) : null;
      return Number.isFinite(n) ? n : null;
    }catch{
      return null;
    }
  }

  // tenta descobrir o cliente atual:
  // 1) #chat-header[data-cliente-id]
  // 2) algum state global (caso você exponha window.ZC_AT_STATE.clienteSel.id, por ex.)
  function getSelectedClienteId(){
    const hdr = document.getElementById('chat-header');
    if (hdr){
      const cid = hdr.getAttribute('data-cliente-id') || (hdr.dataset && hdr.dataset.clienteId);
      if (cid){
        const n = parseInt(cid, 10);
        if (Number.isFinite(n)) return n;
      }
    }
    // opcional: se você expuser seu state global, isso já cobre
    try{
      if (window.ZC_AT_STATE && window.ZC_AT_STATE.clienteSel && window.ZC_AT_STATE.clienteSel.id){
        const n = parseInt(window.ZC_AT_STATE.clienteSel.id, 10);
        if (Number.isFinite(n)) return n;
      }
    }catch{}
    return null;
  }

  function getCtx(){
    const ctx = {
      empresaId: getEmpresaId(),
      clienteId: getSelectedClienteId(),
    };
    return ctx;
  }

  function makeKey(ctx){
    const emp = ctx.empresaId != null ? String(ctx.empresaId) : 'noEmp';
    const cli = ctx.clienteId != null ? String(ctx.clienteId) : 'noCli';
    // chave AGORA é por cliente (não mais "zcNotes:2:at:cli")
    return `zcNotes:${emp}:cli:${cli}`;
  }

  function loadFromStorage(ctx){
    try{
      const key = makeKey(ctx);
      const raw = window.localStorage.getItem(key);
      return raw || '';
    }catch{
      return '';
    }
  }

  function saveToStorage(ctx, txt){
    try{
      const key = makeKey(ctx);
      window.localStorage.setItem(key, txt || '');
      return true;
    }catch{
      return false;
    }
  }

  // fetch autenticado padrão (usa ZAuth.authFetch se existir)
  function authFetchJson(url, opt = {}){
    const baseFetch = (window.ZAuth && ZAuth.authFetch) ? ZAuth.authFetch : fetch;
    const headers = Object.assign(
      { 'Accept':'application/json', 'Content-Type':'application/json' },
      opt.headers || {}
    );
    return baseFetch(url, Object.assign({}, opt, { headers }));
  }

  // ----- status (mensagem pra cliente) -----
  let statusTimeout = null;

  function getStatusEl(){
    const drawerBody = document.querySelector('.zcNotes-body');
    if (!drawerBody) return null;
    let el = drawerBody.querySelector('#zcNotesStatus');
    if (!el){
      el = document.createElement('div');
      el.id = 'zcNotesStatus';
      el.className = 'zcNotes-status';
      const actions = drawerBody.querySelector('.zcNotes-actions');
      drawerBody.insertBefore(el, actions || drawerBody.lastChild);
    }
    return el;
  }

  function clearStatus(){
    if (statusTimeout){
      clearTimeout(statusTimeout);
      statusTimeout = null;
    }
    const el = document.getElementById('zcNotesStatus');
    if (!el) return;
    el.textContent = '';
    el.classList.remove('ok','err');
    el.style.display = 'none';
    el.style.opacity = '';
  }

  function showStatus(msg, kind){
    const el = getStatusEl();
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('ok','err');
    if (kind === 'ok') el.classList.add('ok');
    if (kind === 'err') el.classList.add('err');
    el.style.display = 'block';
    el.style.opacity = '1';
    if (statusTimeout){
      clearTimeout(statusTimeout);
    }
    statusTimeout = setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => {
        if (el.textContent === msg){ // não apaga se outra msg aparecer no meio
          el.style.display = 'none';
          el.style.opacity = '';
        }
      }, 400);
    }, 2600);
  }

  // ----- BD: carregar nota existente (sobre_cliente) -----
  async function loadFromBackend(ctx){
    if (!ctx || !ctx.clienteId) return;
    const expectedKey = makeKey(ctx);

    try{
      const res = await authFetchJson(`/api/atendimento/clientes/${ctx.clienteId}/profile`, {
        method: 'GET'
      });

      if (!res.ok){
        console.warn('[NOTES] erro ao buscar notas do BD:', res.status);
        // silencioso pra não encher o saco, só avisa se você quiser:
        // showStatus('Não foi possível carregar as notas deste cliente.', 'err');
        return;
      }

      const data = await res.json().catch(() => null);
      const note = (data && data.sobre_cliente) || '';

      const ta = document.getElementById('zcNotesText');
      if (!ta) return;

      // se o contexto mudou enquanto carregava, ignora (evita sobrescrever outro cliente)
      const ctxNow = getCtx();
      if (makeKey(ctxNow) !== expectedKey){
        console.log('[NOTES] contexto mudou durante loadFromBackend, ignorando resposta.');
        return;
      }

      // só preenche se textarea ainda estiver vazia (pra não apagar digitação do usuário)
      if (!ta.value.trim()){
        ta.value = note || '';
      }
      saveToStorage(ctxNow, ta.value || '');
    }catch(err){
      console.error('[NOTES] erro ao carregar nota do BD:', err);
      // showStatus('Falha ao carregar as notas do servidor.', 'err');
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
          <span class="zcNotes-icon" aria-hidden="true">${_iconSvg(_getTheme())}</span> Notas
        </div>
        <button class="zcNotes-close" id="zcNotesClose" title="Fechar" aria-label="Fechar notas">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" aria-hidden="true" viewBox="0 0 256 256"><path fill="currentColor" d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66A8 8 0 0 1 61.66 50.34L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128z"/></svg>
        </button>
      </div>
      <div class="zcNotes-body">
        <textarea id="zcNotesText" class="zcNotes-text" placeholder="Escreva anotações sobre este contato…"></textarea>
        <div class="zcNotes-actions">
          <button id="zcNotesSave" class="zcNotes-btnPrimary">Salvar</button>
          <button id="zcNotesCancel" class="zcNotes-btnGhost">Cancelar</button>
        </div>
      </div>
    `;

    document.body.append(backdrop, drawer);

    function open(){
      backdrop.classList.add('is-open');
      drawer.classList.add('is-open');
      try { document.querySelector('main')?.setAttribute('inert',''); } catch {}
      clearStatus();

      const ta = document.getElementById('zcNotesText');
      if (ta){
        ta.value = '';
      }

      const ctx = getCtx();
      console.log('[NOTES] open ctx:', ctx, 'key:', makeKey(ctx));

      // 1) carrega do localStorage (por cliente)
      const txtLocal = loadFromStorage(ctx);
      if (ta && txtLocal){
        ta.value = txtLocal;
      }

      // 2) busca nota do BD (sobre_cliente) e sincroniza
      loadFromBackend(ctx);

      setTimeout(()=> document.getElementById('zcNotesText')?.focus(), 0);
    }

    function close(){
      backdrop.classList.remove('is-open');
      drawer.classList.remove('is-open');
      try { document.querySelector('main')?.removeAttribute('inert'); } catch {}
      // não apaga texto nem storage aqui; deixa como "rascunho"
    }

    document.getElementById('zcNotesClose')?.addEventListener('click', close);
    document.getElementById('zcNotesCancel')?.addEventListener('click', close);
    backdrop.addEventListener('click', (e)=>{ if (e.target === backdrop) close(); });
    document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') close(); });

    // auto-save local ao digitar
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
      const key = makeKey(ctx);

      const payload = { sobre_cliente: txt || null };
      console.log('[NOTES] salvar payload:', { ctx, key, payload });

      // sempre salva localmente (mesmo se não tiver clienteId)
      saveToStorage(ctx, txt || '');

      if (!ctx.clienteId){
        showStatus('Não foi possível identificar o cliente. Nota salva apenas neste navegador.', 'err');
        return;
      }

      try{
        const res = await authFetchJson(`/api/atendimento/clientes/${ctx.clienteId}/profile`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });

        const data = await res.json().catch(()=>null);

        if (!res.ok || !data || data.ok !== true){
          console.warn('[NOTES] erro ao salvar no BD:', res.status, data);
          showStatus('Não foi possível salvar as notas no servidor.', 'err');
          return;
        }

        showStatus('Notas salvas com sucesso.', 'ok');
      }catch(err){
        console.error('[NOTES] falha na requisição de salvar nota:', err);
        showStatus('Erro de conexão ao salvar as notas.', 'err');
      }
    });

    // expõe
    window.zcNotes = { open, close };
  }

  // ---------- botão no header (ao lado do nome) ----------
  function ensureHeaderNotesButton(){
    const btn = document.getElementById('btn-sobre');
    if (!btn) return;
    if (btn.dataset.bound === '1') return;

    btn.dataset.bound = '1';
    btn.setAttribute('title', 'Notas do cliente');
    btn.setAttribute('aria-label', 'Notas do cliente');
    btn.setAttribute('data-notes-open', '1');
    btn.innerHTML = `<span class="zcNotes-icon" aria-hidden="true">${_iconSvg(_getTheme())}</span>`;

    btn.addEventListener('click', (e)=>{
      e.preventDefault();
      ensureDrawer();
      window.zcNotes.open();
    });

    const updateBtnIcon = ()=> {
      const holder = btn.querySelector('.zcNotes-icon');
      if (holder) holder.innerHTML = _iconSvg(_getTheme());
    };
    addEventListener('theme:changed', updateBtnIcon);
    addEventListener('storage', (e)=>{ if(e && e.key === 'zc:theme') updateBtnIcon(); });
    try {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      (mq.addEventListener ? mq.addEventListener('change', updateBtnIcon) : mq.addListener(updateBtnIcon));
    } catch {}
  }

  // listener opcional: qualquer [data-notes-open] também abre
  document.addEventListener('click', (ev)=>{
    const el = ev.target.closest('[data-notes-open]');
    if (!el) return;
    ev.preventDefault();
    ensureDrawer();
    window.zcNotes.open();
  });

  // Observa o header aparecer (ele vem com display:none até abrir um chat)
  const hdr = document.getElementById('chat-header');
  if (hdr) {
    const mo = new MutationObserver(()=> ensureHeaderNotesButton());
    mo.observe(hdr, { attributes:true, attributeFilter:['style','class'] });
  }
  // tenta já agora
  ensureHeaderNotesButton();
})();
