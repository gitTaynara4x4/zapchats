// /frontend/js/atendimentos/ui/notes-drawer.js
// Drawer "Notas" + botão no header (#btn-sobre), alinhado e com feedback visual igual ao #btn-ia.

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

  // ---------- tema + SVG ----------
  function _getTheme(){
    try{
      const t = document.documentElement.getAttribute('data-theme');
      if (t) return t;
    }catch{}
    try{ return (matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; }catch{}
    return 'dark';
  }
  // ÍCONE solicitado: dark -> #ffffff, light -> #080808 (24×24)
  function _iconSvg(theme){
    const fill = theme === 'light' ? '#080808' : '#ffffff';
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="${fill}" viewBox="0 0 256 256" aria-hidden="true">
        <path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H156.69A15.92,15.92,0,0,0,168,219.31L219.31,168A15.92,15.92,0,0,0,224,156.69V48A16,16,0,0,0,208,32ZM96,88h64a8,8,0,0,1,0,16H96a8,8,0,0,1,0-16Zm32,80H96a8,8,0,0,1,0-16h32a8,8,0,0,1,0,16ZM96,136a8,8,0,0,1,0-16h64a8,8,0,0,1,0,16Zm64,68.69V160h44.7Z"></path>
      </svg>
    `;
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

    document.getElementById('zcNotesSave')?.addEventListener('click', async () => {
      const txt = document.getElementById('zcNotesText')?.value?.trim() || '';
      console.log('[NOTES] salvar:', txt);
      // TODO: plugue seu endpoint aqui.
      close();
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

    btn.addEventListener('click', (e)=>{ e.preventDefault(); ensureDrawer(); window.zcNotes.open(); });

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
    ensureDrawer(); window.zcNotes.open();
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
