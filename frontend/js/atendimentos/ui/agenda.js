// /frontend/js/atendimentos/ui/agenda.js
// Agenda (BD) — scroll infinito no feed normal;
// Busca no servidor SÓ quando estiver pesquisando (q).
// Lazy avatar: usa o que vier; só consulta BD/Evolution quando faltar/quebrar.

(() => {
  /* ---------------- helpers ---------------- */
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);

  function debounce(fn, ms=250){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
  const toast = {
    ok:  (m)=> window.toast ? window.toast({title:'Pronto', msg:m, type:'ok'})    : console.log('[Agenda]', m),
    err: (m)=> window.toast ? window.toast({title:'Erro',   msg:m, type:'error'}) : console.error('[Agenda]', m),
  };

  function getInstanciaAtiva(){
    const sel = (window.state?.clienteSel) || null;
    const inst = sel?.instancia_id ?? sel?.instancia ?? window.INSTANCIA_ATIVA ?? null;
    return (inst == null || inst === '') ? null : String(inst);
  }

  function avatarHtml(url){
    if (!url) return `<span class="ag-avatar ag-avatar--default"><i class="fa fa-user-circle"></i></span>`;
    const esc = String(url).replace(/"/g,'&quot;');
    return `
      <span class="ag-avatar">
        <img src="${esc}" alt="" loading="lazy" referrerpolicy="no-referrer" crossorigin="anonymous"
             onerror="this.closest('.ag-avatar').classList.add('ag-avatar--default'); this.remove();">
      </span>`;
  }

  /* ---------------- Drawer ---------------- */
  function buildDrawer(){
    if ($('#agBackdrop')) return;
    const backdrop = document.createElement('div');
    backdrop.id = 'agBackdrop';
    backdrop.className = 'ag-backdrop';

    const drawer = document.createElement('aside');
    drawer.id = 'agDrawer';
    drawer.className = 'ag-drawer';
    drawer.setAttribute('role','dialog'); drawer.setAttribute('aria-modal','true');

    drawer.innerHTML = `
      <div class="ag-head">
        <div class="ag-title">Agenda</div>
        <button class="ag-close" id="agClose" title="Fechar" aria-label="Fechar">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 256 256"><path fill="currentColor" d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66A8 8 0 0 1 61.66 50.34L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128z"/></svg>
        </button>
      </div>
      <div class="ag-search">
        <input id="agQuery" type="search" placeholder="Buscar por nome ou número…" autocomplete="off" />
      </div>
      <div class="ag-list" id="agList">
        ${Array.from({length:8}).map(()=>`
          <div class="ag-skel"><div class="dot"></div><div class="line"></div></div>
        `).join('')}
      </div>
    `;
    document.body.append(backdrop, drawer);

    const close = ()=>{ backdrop.classList.remove('is-open'); drawer.classList.remove('is-open'); };
    $('#agClose')?.addEventListener('click', close);
    backdrop.addEventListener('click', e=>{ if(e.target===backdrop) close(); });
    document.addEventListener('keydown', e=>{ if(e.key==='Escape') close(); });

    window.__Agenda = {
      open: ()=>{ backdrop.classList.add('is-open'); drawer.classList.add('is-open'); $('#agQuery')?.focus(); },
      close,
      setList(html){ const l=$('#agList'); if(l) l.innerHTML = html; }
    };
  }

  /* ------------- Botão “Contatos” (robusto) ------------- */
  function getHeaderIconsHost() {
    const candidates = [
      '.wpp-header-icons', '#wpp-header-icons',
      '#chat-header .wpp-header-icons', '#chat-header .header-icons',
      '#chat-header .icons', '#chat-header .actions',
    ];
    for (const sel of candidates) { const el=document.querySelector(sel); if (el) return el; }
    const hdr = document.querySelector('#chat-header');
    if (hdr) {
      let created = hdr.querySelector('.wpp-header-icons');
      if (!created) {
        created = document.createElement('div');
        created.className = 'wpp-header-icons';
        created.style.display = 'flex';
        created.style.alignItems = 'center';
        created.style.gap = '8px';
        hdr.appendChild(created);
      }
      return created;
    }
    return null;
  }

  function ensureAgendaButton(){
    const host = getHeaderIconsHost();
    if (!host) return;

    let btn = host.querySelector('#btn-contatos, [data-role="btn-agenda"]');
    if (!btn){
      btn = document.createElement('button');
      btn.className = 'wpp-header-icon';
      btn.id = 'btn-contatos';
      btn.setAttribute('data-role','btn-agenda');
      btn.type = 'button';
      btn.title = 'Contatos';
      btn.innerHTML = `<i class="fa fa-address-book"></i>`;
      host.prepend(btn);
    }
    if (!btn.dataset.agendaBound){
      btn.dataset.agendaBound = '1';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault?.(); ev.stopPropagation?.();
        abrirAgenda();
      });
    }
  }

  (function watchHeader(){
    ensureAgendaButton();
    try{
      new MutationObserver(() => ensureAgendaButton())
        .observe(document.body, { childList:true, subtree:true });
    }catch{}
  })();

  /* ---------------- Data/paginação ---------------- */
  const PAGE_SIZE = 100;

  // Estado separando feed normal x busca
  const dataState = {
    mode: 'feed',   // 'feed' | 'search'
    q: '',

    items: [],      // itens mostrados no momento (do modo atual)
    offset: 0,
    cursor: null,
    next_page_token: null,
    total: null,
    hasMore: true,
    loading: false,

    // para saber quando resetar (empresa/instância ou termo mudaram)
    lastKey: '',
  };

  function normalizeItem(it){
    const foto = it.avatar_url || it.foto_url || it.foto || it.avatar || it.profile_pic_url || '';
    const nome = (it.nome_whatsapp || it.nome || it.telefone || '').trim();
    return {
      id: it.id ?? it.cliente_id ?? it.conversation_id ?? it.id_cliente,
      nome,
      telefone: it.telefone || '',
      avatar_url: foto && String(foto).trim() !== '' ? String(foto) : null,
    };
  }

  function buildKey(mode, q){
    const inst = getInstanciaAtiva() || '';
    return `${EMPRESA_ID}|${inst}|${mode}|${q||''}`;
  }

  // 🔹 Agora a Agenda lista todos os contatos da empresa (sem filtrar por instância)
  function buildClientesURL({ initial=false }={}){
    const qs = new URLSearchParams({ empresa_id: String(EMPRESA_ID), limit: String(PAGE_SIZE) });
    if (dataState.mode === 'search' && dataState.q) qs.set('q', dataState.q); // chamada ao servidor SÓ quando buscando

    if (!initial){
      if (dataState.next_page_token) qs.set('next_page_token', dataState.next_page_token);
      else if (dataState.cursor)     qs.set('cursor', dataState.cursor);
      else                           qs.set('offset', String(dataState.offset));
    } else {
      dataState.offset = 0;
      dataState.cursor = null;
      dataState.next_page_token = null;
    }
    return '/api/clientes?' + qs.toString();
  }

  async function fetchNextPage({ initial=false }={}){
    if (dataState.loading) return;
    dataState.loading = true;

    const key = buildKey(dataState.mode, dataState.q);
    if (initial || dataState.lastKey !== key){
      dataState.items = [];
      dataState.total = null;
      dataState.hasMore = true;
      dataState.offset = 0;
      dataState.cursor = null;
      dataState.next_page_token = null;
      dataState.lastKey = key;
    }

    if (!dataState.hasMore){ dataState.loading=false; return; }

    const r = await fetch(buildClientesURL({ initial }), { credentials:'include' });
    if (!r.ok){
      dataState.loading=false;
      let detail=''; try{ detail=(await r.json())?.detail||''; }catch{ detail=await r.text(); }
      throw new Error(detail || (r.status+' '+r.statusText));
    }
    const payload = await r.json();
    const items = Array.isArray(payload?.items) ? payload.items
                : Array.isArray(payload)       ? payload
                : [];

    dataState.next_page_token = payload?.next_page_token ?? dataState.next_page_token ?? null;
    dataState.cursor          = payload?.next_cursor     ?? dataState.cursor ?? null;
    dataState.total           = (payload?.total != null) ? Number(payload.total) : dataState.total;

    if (typeof payload?.has_more === 'boolean'){
      dataState.hasMore = payload.has_more;
    } else if (payload?.next_page_token != null){
      dataState.hasMore = Boolean(payload.next_page_token);
    } else if (payload?.next_cursor != null){
      dataState.hasMore = Boolean(payload.next_cursor);
    } else if (dataState.total != null){
      dataState.hasMore = (dataState.items.length + items.length) < dataState.total;
    } else {
      dataState.hasMore = items.length === PAGE_SIZE;
    }

    if (!dataState.next_page_token && !dataState.cursor){
      dataState.offset += items.length;
      if (payload?.next_offset != null) dataState.offset = Number(payload.next_offset);
    }

    dataState.items.push(...items.map(normalizeItem).filter(x=>x.id!=null));
    dataState.loading = false;
  }

  /* ---------------- Render ---------------- */
  function htmlItem(it){
    const av = it.avatar_url ? ` data-avatar="${String(it.avatar_url).replace(/"/g,'&quot;')}"` : '';
    return `
      <div class="ag-item" data-id="${it.id}" data-phone="${it.telefone}"${av}>
        ${avatarHtml(it.avatar_url)}
        <div class="ag-meta">
          <div class="ag-name">${it.nome || '—'}</div>
          <div class="ag-phone">${it.telefone || ''}</div>
        </div>
      </div>`;
  }

  function bindItemClicks(){
    $$('.ag-item', $('#agList')).forEach(el => {
      el.addEventListener('click', async () => {
        const id   = Number(el.getAttribute('data-id') || 0);
        if (!id) return;

        // dados básicos do contato (para header/avatar)
        const nome = el.querySelector('.ag-name')?.textContent?.trim() || '';
        const tel  = el.getAttribute('data-phone') || '';
        const av   = el.getAttribute('data-avatar');

        // trata instância ativa: pode ser ID numérico ou slug
        const rawInst = getInstanciaAtiva();
        let inst_id = null;
        let inst_slug = null;
        if (rawInst != null && rawInst !== '') {
          const s = String(rawInst);
          if (/^\d+$/.test(s)) inst_id = Number(s);
          else inst_slug = s;
        }

        const seed = {
          id,
          cliente_id: id,
          telefone: tel,
          nome: nome || tel || 'Cliente',
          avatar_url: av || null,
          instancia_id: inst_id,
          instancia: inst_slug,
        };

        if (typeof window.selecionarClienteObj === 'function') {
          try {
            await window.selecionarClienteObj(id);

            const sel = window.state?.clienteSel;
            if (!sel || sel.cliente_id !== id) {
              console.warn('[Agenda] selecionarClienteObj não montou header, usando fallback');
              window.state = window.state || {};
              window.state.clienteSel = seed;
              setChatHeader(seed);
              try { await openByProfileFallback(id, seed); } catch (e2) { console.error('[Agenda] fallback open', e2); }
            }
          } catch (e) {
            console.error('[Agenda] erro selecionarClienteObj, usando fallback', e);
            window.state = window.state || {};
            window.state.clienteSel = seed;
            setChatHeader(seed);
            try { await openByProfileFallback(id, seed); } catch (e2) { console.error('[Agenda] fallback open', e2); }
          }
        } else {
          window.state = window.state || {};
          window.state.clienteSel = seed;
          setChatHeader(seed);
          try { await openByProfileFallback(id, seed); } catch (e) { console.error('[Agenda] fallback open', e); }
        }

        window.__Agenda.close();
      }, { passive:true });
    });
  }

  function renderList(){
    const list = $('#agList'); if (!list) return;
    const prevTop = list.scrollTop;
    list.innerHTML = dataState.items.length
      ? dataState.items.map(htmlItem).join('')
      : `<div class="ag-empty">Nenhum contato encontrado.</div>`;
    bindItemClicks();
    document.dispatchEvent(new CustomEvent('agenda:render'));
    list.scrollTop = prevTop;
  }

  /* ---------------- Scroll infinito ---------------- */
  function ensureInfiniteScroll(){
    const list = $('#agList');
    if (!list || list.dataset.agScrollBound) return;
    list.dataset.agScrollBound = '1';
    list.addEventListener('scroll', debounce(async () => {
      const nearBottom = (list.scrollTop + list.clientHeight) >= (list.scrollHeight - 140);
      if (nearBottom && dataState.hasMore && !dataState.loading){
        try{
          await fetchNextPage({ initial:false });
          renderList();
        }catch(e){ console.error('[Agenda] autoload paginação', e); }
      }
    }, 80), { passive:true });
  }

  /* --------- /profile (merge, sem sobrescrever avatar BD) --------- */
  async function openByProfileFallback(cliente_id, seed){
    const qs = new URLSearchParams({ empresa_id: String(EMPRESA_ID) });
    const r = await fetch(`/api/atendimento/clientes/${cliente_id}/profile?`+qs.toString(), { credentials:'include' });
    if (!r.ok) return;
    const p = await r.json();

    const rawInst =
      (p && (p.instancia_id ?? p.instance)) ??
      (seed && (seed.instancia_id ?? seed.instancia)) ??
      getInstanciaAtiva();

    let inst_id = null;
    let inst_slug = null;
    if (rawInst != null && rawInst !== '') {
      const s = String(rawInst);
      if (/^\d+$/.test(s)) inst_id = Number(s);
      else inst_slug = s;
    }

    const sel = {
      id: cliente_id,
      cliente_id: cliente_id,
      telefone: p.telefone || seed?.telefone || '',
      nome: (p.nome_whatsapp || p.nome || seed?.nome || seed?.telefone || 'Cliente').trim(),
      avatar_url: (seed?.avatar_url && String(seed.avatar_url).trim() !== '') ? seed.avatar_url
                  : (p.avatar_url && String(p.avatar_url).trim() !== '' ? p.avatar_url : null),
      instancia_id: inst_id,
      instancia: inst_slug,
    };

    window.state = window.state || {};
    window.state.clienteSel = sel;
    setChatHeader(sel);
    try { await tryLoadHistorico(sel); } catch {}
  }

  function setChatHeader(sel){
    $('#welcome-screen')?.classList.add('hidden');
    const hdr = $('#chat-header'); const ftr = $('#chat-footer'); const his = $('#historico');
    if (hdr) hdr.style.display = 'flex';
    if (ftr) ftr.style.display = 'flex';
    if (his) his.style.display = 'block';
    const av = $('#chat-avatar'); if (av) av.innerHTML = avatarHtml(sel.avatar_url);
    const tt = $('#chat-title');  if (tt) tt.textContent = sel.nome || sel.telefone || 'Cliente';
  }

  async function tryLoadHistorico(sel){
    if (!sel?.cliente_id) return;
    const qs = new URLSearchParams({ empresa_id: String(EMPRESA_ID), limit: '50', offset: '0' });

    if (sel.instancia_id != null && sel.instancia_id !== '') qs.set('instancia_id', String(sel.instancia_id));
    else if (sel.instancia != null && sel.instancia !== '') qs.set('instance', String(sel.instancia));

    const r = await fetch(`/api/atendimento/conversas/${sel.cliente_id}/mensagens?` + qs.toString(), { credentials:'include' });
    if (!r.ok) return;
    const payload = await r.json();
    if (typeof window.renderHistoricoMensagens === 'function') {
      window.renderHistoricoMensagens(payload);
      return;
    }
    const his = $('#historico');
    if (his) {
      his.innerHTML = '';
      if (!Array.isArray(payload) || !payload.length) his.innerHTML = `<div class="p-4 text-sm opacity-70">Sem mensagens anteriores.</div>`;
    }
  }

  /* ---------------- Fluxos ---------------- */
  async function abrirAgenda(){
    const instRaw = (typeof window !== 'undefined') ? window.INSTANCIA_ATIVA : null;
    if (!instRaw || String(instRaw).trim() === '') {
      toast.err('Selecione uma instância antes de abrir a Agenda.');
      return;
    }

    buildDrawer();
    window.__Agenda.open();
    $('#agList').innerHTML = Array.from({length:8})
      .map(()=>`<div class="ag-skel"><div class="dot"></div><div class="line"></div></div>`).join('');

    dataState.mode = 'feed';
    dataState.q = '';
    try{
      await fetchNextPage({ initial:true });
      renderList();
      ensureInfiniteScroll();
    }catch(e){
      console.error('[Agenda] falha ao carregar contatos', e);
      $('#agList').innerHTML = `<div class="ag-empty">Erro ao carregar a Agenda.<br><small>${String(e.message||e)}</small></div>`;
      toast.err('Não foi possível carregar a Agenda.');
    }
  }

  const onSearch = debounce(async () => {
    const q = ($('#agQuery')?.value || '').trim();

    if (q.length === 0){
      dataState.mode = 'feed';
      dataState.q = '';
      $('#agList').innerHTML = Array.from({length:4})
        .map(()=>`<div class="ag-skel"><div class="dot"></div><div class="line"></div></div>`).join('');
      await fetchNextPage({ initial:true });
      renderList();
      return;
    }

    dataState.mode = 'search';
    dataState.q = q;
    $('#agList').innerHTML = Array.from({length:4})
      .map(()=>`<div class="ag-skel"><div class="dot"></div><div class="line"></div></div>`).join('');
    try{
      await fetchNextPage({ initial:true });
      renderList();
      ensureInfiniteScroll();
    }catch(e){
      console.error('[Agenda] busca', e);
      $('#agList').innerHTML = `<div class="ag-empty">Erro na busca.<br><small>${String(e.message||e)}</small></div>`;
    }
  }, 250);

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t && t instanceof HTMLElement && t.id === 'agQuery') onSearch();
  });

  document.addEventListener('click', (e) => {
    const trg = e.target && (e.target.closest?.('#btn-contatos,[data-role="btn-agenda"]'));
    if (trg){ e.preventDefault?.(); e.stopPropagation?.(); abrirAgenda(); }
  }, { passive:false });

  /* ================== AGENDA: Lazy avatar (BD -> Evolution -> BD) ================== */
  (function agendaAvatarHydrator(){
    const TRIED_BD = new Set();
    const TRIED_EVOLUTION = new Set();

    const isSuspectWhatsAppURL = (u) => /(^https?:\/\/pps\.whatsapp\.net)|(_nc_|\/v\/t61\.)/i.test(String(u||''));

    async function fetchProfileBD(id){
      try{
        const qs = new URLSearchParams({ empresa_id: String(EMPRESA_ID) });
        const r = await fetch(`/api/atendimento/clientes/${id}/profile?`+qs.toString(), { credentials:'include' });
        if (!r.ok) return null;
        return r.json().catch(()=>null);
      }catch{ return null; }
    }

    function setAvatarImg(container, url){
      const box = container.querySelector('.ag-avatar');
      if (!box) return;

      if (!url){
        box.classList.add('ag-avatar--default');
        box.innerHTML = `<i class="fa fa-user-circle"></i>`;
        return;
      }

      const safe = String(url).replace(/"/g,'&quot;');
      box.classList.remove('ag-avatar--default');
      box.innerHTML = `<img src="${safe}" alt="" loading="lazy" referrerpolicy="no-referrer" crossorigin="anonymous">`;

      const img = box.querySelector('img');
      if (img) img.addEventListener('error', () => onImgError(container));
    }

    async function hydrateOne(container){
      const id = Number(container?.getAttribute('data-id') || 0);
      if (!id) return;

      const currentImg = container.querySelector('.ag-avatar img');
      if (currentImg){
        currentImg.addEventListener('error', () => onImgError(container));
        return;
      }

      const hinted = container.getAttribute('data-avatar');
      if (hinted && hinted.trim() !== ''){
        setAvatarImg(container, hinted);
        return;
      }

      if (!TRIED_BD.has(id)){
        TRIED_BD.add(id);
        const bd = await fetchProfileBD(id);
        const fromBD = bd?.avatar_url && String(bd.avatar_url).trim() ? bd.avatar_url : null;
        if (fromBD && !isSuspectWhatsAppURL(fromBD)){
          setAvatarImg(container, fromBD);
          return;
        }
      }

      setAvatarImg(container, null);
    }

    async function onImgError(container){
      const id = Number(container?.getAttribute('data-id') || 0);
      if (!id) return;

      if (TRIED_EVOLUTION.has(id)) return;
      TRIED_EVOLUTION.add(id);

      const box = container.querySelector('.ag-avatar');
      if (box){ box.classList.add('ag-avatar--default'); box.innerHTML = `<i class="fa fa-user-circle"></i>`; }

      try{
        if (typeof window.refreshAvatarFromEvolution === 'function'){
          await window.refreshAvatarFromEvolution(id);
        }
      }catch{}

      const bd = await fetchProfileBD(id);
      const url = bd?.avatar_url && String(bd.avatar_url).trim() ? bd.avatar_url : null;
      setAvatarImg(container, (url && !isSuspectWhatsAppURL(url)) ? url : null);
    }

    const io = new IntersectionObserver((entries)=>{
      entries.forEach(e=>{
        if (e.isIntersecting) { hydrateOne(e.target).catch(()=>{}); }
      });
    }, { root: document.querySelector('#agList') || null, rootMargin: '120px 0px', threshold: 0.01 });

    function wireObserver(){
      const list = document.getElementById('agList');
      if (!list) return;
      try{ io.disconnect(); }catch{}
      list.querySelectorAll('.ag-item').forEach(it=>{
        const img = it.querySelector('.ag-avatar img');
        if (img) img.addEventListener('error', () => onImgError(it));
        io.observe(it);
      });
    }

    document.addEventListener('agenda:render', wireObserver);
    setTimeout(wireObserver, 0);
  })();

})();
