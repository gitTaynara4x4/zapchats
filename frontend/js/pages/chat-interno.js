(() => {
  // ===== Helpers =====
  const $ = (sel) => document.querySelector(sel);

  async function j(url, init){
    const r = await fetch(url, { credentials:'include', ...(init||{}) });
    const ct = (r.headers.get('content-type')||'').toLowerCase();
    const txt = await r.text();
    if (r.status === 204 || !txt.trim()) return { ok:r.ok, status:r.status };
    if (ct.includes('application/json')) return JSON.parse(txt);
    return { ok:r.ok, status:r.status, raw:txt };
  }

  const fmtTimeShort = (iso)=>{
    if (!iso) return '—';
    const d=new Date(iso), now=new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const sameYear = d.getFullYear() === now.getFullYear();
    const dateStr = d.toLocaleDateString([], {day:'2-digit', month:'2-digit'}) + (sameYear?'':'/'+(''+d.getFullYear()).slice(-2));
    const timeStr = d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    return `${dateStr} ${timeStr}`;
  };

  const esc = (s)=> (s||'').toString().replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]));
  const debounce = (fn,ms)=>{ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); } };
  const scrollBottom = ()=>{ const el = $('#msgsScroll'); if (el) el.scrollTop = el.scrollHeight; };

  // ===== Toast (usa .toaststack/.toast do seu CSS) =====
  function toast(msg, type='ok', ms=2600){
    let stack = document.querySelector('.toaststack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toaststack';
      document.body.appendChild(stack);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(()=>{ el.classList.add('hide'); setTimeout(()=>el.remove(), 240); }, ms);
  }

  // ===== DOM =====
  const listaEl          = $('#listaConversas');
  const msgsEl           = $('#msgsScroll');
  const peerNameEl       = $('#peerName');
  const peerStatusEl     = $('#peerStatus');
  const totalConversasEl = $('#totalConversas');
  const txtMsg           = $('#txtMsg');
  const btnSend          = $('#btnSend');
  const btnAttach        = $('#btnAttach');
  const btnBackList      = $('#btnBackList');
  const btnNewChannel    = $('#btnNewChannel');
  const inpSearch        = $('#inpSearch');

  // ===== Estado =====
  let ME_ID = null;
  let EMPRESA_ID = null;
  let ACTIVE = null;

  const CONVS = new Map(); // thread_id -> { thread_id, titulo, participantes, last_texto, last_created_at, unread_count }
  const MSGS  = new Map(); // thread_id -> [{id, autor_id, texto, titulo, created_at, kind}]
  const MUTED  = new Set(JSON.parse(localStorage.getItem('muted_threads')  || '[]'));
  const PINNED = new Set(JSON.parse(localStorage.getItem('pinned_threads') || '[]'));
  const saveSet = (k,set)=> localStorage.setItem(k, JSON.stringify([...set]));

  // ===== WS =====
  let ws = null;
  let wsTries = 0;
  let wsPing = null;

  function trySetMeIdOnce(val){
    if (val == null) return;
    if (ME_ID == null && !Number.isNaN(Number(val))) {
      ME_ID = Number(val);
      if (ACTIVE) drawMsgs(ACTIVE);
    }
  }
  function isMsgMine(m){ return ME_ID != null && Number(m.autor_id) === Number(ME_ID); }

  function wsUrl(empId){
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/api/internal-chat/ws/${empId}`;
  }

  function openWS(empId){
    if (!empId) return;
    try { if (ws) { ws.close(); ws = null; } } catch {}
    const url = wsUrl(empId);
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      wsTries = 0;
      clearInterval(wsPing);
      wsPing = setInterval(() => { try { ws?.readyState === 1 && ws.send('ping'); } catch {} }, 25000);
    });

    ws.addEventListener('message', (ev) => {
      let data = null;
      try { data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; }
      catch { return; }
      if (!data || typeof data !== 'object') return;
      handleWS(data);
    });

    ws.addEventListener('close', () => {
      clearInterval(wsPing);
      wsPing = null;
      const t = Math.min(30000, 1000 * Math.pow(2, wsTries++)) + Math.floor(Math.random()*500);
      setTimeout(() => openWS(empId), t);
    });

    ws.addEventListener('error', () => { try { ws?.close(); } catch {} });
  }

  function handleWS(msg){
    switch (msg.type) {
      case 'thread.created':       onThreadCreated(msg); break;
      case 'message.created':      onMessageCreated(msg); break;
      case 'thread.renamed':       onThreadRenamed(msg); break;
      case 'participants.updated': onParticipantsUpdated(msg); break;
      case 'read.updated':         break;
      case 'message.deleted':      onMessageDeleted(msg); break;
      default: break;
    }
  }

  function ensureMsgsArray(tid){
    if (!MSGS.has(tid)) MSGS.set(tid, []);
    return MSGS.get(tid);
  }

  function bumpConvMeta(tid, partial){
    const cur = CONVS.get(tid) || { thread_id: tid, titulo: 'Conversa', unread_count: 0 };
    const next = { ...cur, ...partial };
    CONVS.set(tid, next);
    drawConvs();
  }

  function onThreadCreated(e){
    const { thread_id, titulo, participantes } = e;
    if (!CONVS.has(thread_id)) {
      CONVS.set(thread_id, {
        thread_id, titulo: titulo || 'Conversa', participantes: participantes || [],
        last_texto: '', last_created_at: null, unread_count: 0
      });
    } else {
      const c = CONVS.get(thread_id);
      c.titulo = titulo || c.titulo;
      c.participantes = participantes || c.participantes || [];
      CONVS.set(thread_id, c);
    }
    drawConvs();
  }
  function onThreadRenamed(e){
    const { thread_id, titulo } = e;
    if (!CONVS.has(thread_id)) return;
    const c = CONVS.get(thread_id);
    c.titulo = titulo || c.titulo;
    CONVS.set(thread_id, c);
    if (ACTIVE === thread_id && peerNameEl) peerNameEl.textContent = c.titulo || 'Conversa';
    drawConvs();
  }
  function onParticipantsUpdated(e){
    const { thread_id, participantes } = e;
    const c = CONVS.get(thread_id);
    if (c) {
      c.participantes = participantes || [];
      CONVS.set(thread_id, c);
    }
    if (ME_ID != null && !(participantes || []).includes(ME_ID)) {
      CONVS.delete(thread_id);
      MSGS.delete(thread_id);
      if (ACTIVE === thread_id) {
        ACTIVE = null;
        if (msgsEl) msgsEl.innerHTML = '<div class="empty" id="emptyState">Selecione uma conversa para começar.</div>';
      }
    }
    drawConvs();
  }
  function onMessageDeleted(e){
    const { thread_id, id } = e;
    if (ACTIVE === thread_id) {
      const bubble = msgsEl?.querySelector(`.msg[data-id="${id}"]`);
      if (bubble) bubble.remove();
    }
  }
  function onMessageCreated(e){
    const { thread_id, id, autor_id, texto, created_at } = e;
    const arr = ensureMsgsArray(thread_id);
    if (!arr.some(x => Number(x.id) === Number(id))) {
      const m = { id, autor_id, texto, created_at, kind:'msg' };
      arr.push(m);
      if (ACTIVE === thread_id) {
        appendMsgBubble(m);
        $('#emptyState')?.remove?.();
        scrollBottom();
        markAsRead(thread_id);
        const cc = CONVS.get(thread_id);
        if (cc) { cc.unread_count = 0; CONVS.set(thread_id, cc); }
      } else {
        const cc = CONVS.get(thread_id) || { thread_id, titulo: 'Conversa', unread_count: 0 };
        if (!isMsgMine(m)) cc.unread_count = Number(cc.unread_count || 0) + 1;
        CONVS.set(thread_id, cc);
      }
    }
    bumpConvMeta(thread_id, { last_texto: texto || '', last_created_at: created_at || new Date().toISOString() });
  }

  // ===== UI: lista e mensagens =====
  function drawConvs(listSrc){
    if (!listaEl) return;
    let arr = listSrc || Array.from(CONVS.values());
    arr = arr.sort((a,b)=>{
      const ap = PINNED.has(a.thread_id) ? 1 : 0;
      const bp = PINNED.has(b.thread_id) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return new Date(b.last_created_at||0) - new Date(a.last_created_at||0);
    });

    listaEl.innerHTML = '';
    arr.forEach(c => {
      const li = document.createElement('li');
      li.className = 'conv';
      li.setAttribute('role','option');
      li.dataset.tid = c.thread_id;
      li.setAttribute('aria-selected', c.thread_id === ACTIVE ? 'true' : 'false');

      const isMuted = MUTED.has(c.thread_id);
      const isPinned = PINNED.has(c.thread_id);

      li.innerHTML = `
        <div class="avatar" aria-hidden="true"></div>
        <div>
          <div class="name">${esc(c.titulo || 'Conversa')}${isPinned ? ' 📌' : ''}</div>
          <div class="last">${esc(c.last_texto || '')}</div>
        </div>
        <div class="right">
          <div class="time">${fmtTimeShort(c.last_created_at)}${isMuted ? ' 🔕' : ''}</div>
          ${Number(c.unread_count) > 0 ? `<div class="badge">${c.unread_count}</div>` : ''}
          <button class="conv-opts" title="Opções" aria-label="Opções" style="
            margin-top:.2rem; width:28px; height:28px; display:grid; place-items:center;
            border:1px solid var(--border); border-radius:8px; background:var(--card2); color:var(--fg); cursor:pointer; line-height:0;">⋯</button>
        </div>`;

      li.addEventListener('click', (ev)=>{
        if (ev.target && ev.target.closest('.conv-opts')) return;
        selectThread(c.thread_id);
      });

      li.querySelector('.conv-opts')?.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        const rect = ev.currentTarget.getBoundingClientRect();
        openConvMenu(c.thread_id, rect.left, rect.bottom + 6);
      });

      li.addEventListener('contextmenu', (ev)=>{ ev.preventDefault(); openConvMenu(c.thread_id, ev.pageX, ev.pageY); });

      let pressTimer = null;
      li.addEventListener('pointerdown', (ev)=>{
        if (ev.button !== 0) return;
        pressTimer = setTimeout(()=>{
          openConvMenu(c.thread_id, ev.pageX || (ev.clientX + window.scrollX), ev.pageY || (ev.clientY + window.scrollY));
        }, 500);
      });
      ['pointerup','pointerleave','pointercancel'].forEach(e => li.addEventListener(e, ()=>{ clearTimeout(pressTimer); }));

      listaEl.appendChild(li);
    });
    if (totalConversasEl) totalConversasEl.textContent = arr.length;
  }

  function appendMsgBubble(m){
    if (!msgsEl) return;
    const me = isMsgMine(m);
    const wrap = document.createElement('div');
    wrap.className = 'msg' + (me ? ' me' : '');
    wrap.dataset.id = m.id;

    const text = (m.texto ?? m.titulo ?? '').toString();
    wrap.innerHTML = `
      <div class="bubble">
        <div class="text"></div>
        <div class="meta"><span>${fmtTimeShort(m.created_at)}</span></div>
      </div>`;
    wrap.querySelector('.text').textContent = text;

    if (me) {
      wrap.title = 'Alt+Clique para excluir';
      wrap.addEventListener('click', async (e)=>{
        if (!e.altKey) return;
        const ok = confirm('Remover esta mensagem?'); if (!ok) return;
        try { await j(`/api/internal-chat/messages/${m.id}`, { method:'DELETE' }); } catch{}
      });
    }
    msgsEl.appendChild(wrap);
  }

  function drawMsgs(tid){
    if (!msgsEl) return;
    msgsEl.innerHTML = '';
    const arr = (MSGS.get(tid) || []);
    arr.forEach(m => appendMsgBubble(m));
    $('#emptyState')?.remove?.();
    scrollBottom();
  }

  // ===== Menu contexto da conversa =====
  let openMenuEl = null;
  function closeMenu(){ if(openMenuEl){ openMenuEl.remove(); openMenuEl=null; document.removeEventListener('click', onDocClickClose, true); document.removeEventListener('keydown', onEscClose, true); } }
  function onDocClickClose(e){ if (!openMenuEl) return; if (!openMenuEl.contains(e.target)) closeMenu(); }
  function onEscClose(e){ if (e.key === 'Escape') closeMenu(); }

  function openConvMenu(tid, x, y){
    closeMenu();
    const c = CONVS.get(tid); if (!c) return;

    const el = document.createElement('div');
    el.role = 'menu';
    el.style.position = 'absolute';
    el.style.zIndex = '9999';
    el.style.left = Math.max(8, Math.min(x, window.innerWidth - 240)) + 'px';
    el.style.top  = Math.max(8, Math.min(y, window.innerHeight - 10)) + 'px';
    el.style.width = '220px';
    el.style.background = getComputedStyle(document.documentElement).getPropertyValue('--card') || '#222';
    el.style.border = '1px solid ' + (getComputedStyle(document.documentElement).getPropertyValue('--border') || '#444');
    el.style.borderRadius = '10px';
    el.style.boxShadow = '0 10px 30px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.04)';
    el.style.overflow = 'hidden';

    const mkBtn = (label, fn, danger=false)=>{
      const b = document.createElement('button');
      b.type='button';
      b.textContent = label;
      b.style.display='block';
      b.style.width='100%';
      b.style.textAlign='left';
      b.style.padding='10px 12px';
      b.style.border='0';
      b.style.background='transparent';
      b.style.color = danger ? '#ef4444' : 'inherit';
      b.style.cursor='pointer';
      b.onmouseenter = ()=> b.style.background = getComputedStyle(document.documentElement).getPropertyValue('--hover') || 'rgba(255,255,255,.06)';
      b.onmouseleave = ()=> b.style.background = 'transparent';
      b.onclick = async ()=>{ try{ await fn(); } finally{ closeMenu(); } };
      return b;
    };

    const muted = MUTED.has(tid);
    const pinned = PINNED.has(tid);

    el.appendChild(mkBtn('Abrir', ()=> selectThread(tid)));
    el.appendChild(mkBtn(muted ? 'Ativar som' : 'Silenciar', ()=>{ muted ? MUTED.delete(tid) : MUTED.add(tid); saveSet('muted_threads', MUTED); drawConvs(); }));
    el.appendChild(mkBtn(pinned ? 'Desafixar do topo' : 'Fixar no topo', ()=>{ pinned ? PINNED.delete(tid) : PINNED.add(tid); saveSet('pinned_threads', PINNED); drawConvs(); }));
    el.appendChild(mkBtn('Marcar como lida', async ()=>{ await markAsRead(tid); const cc = CONVS.get(tid); if (cc) { cc.unread_count = 0; CONVS.set(tid, cc); drawConvs(); } }));
    el.appendChild(mkBtn('Renomear', ()=> promptRename(tid)));
    el.appendChild(mkBtn('Apagar p/ mim (sair)', async ()=>{
      if (ME_ID == null) {
        try { const me = await j('/api/internal-chat/me'); trySetMeIdOnce(me?.colab_id); } catch {}
      }
      if (ME_ID == null) { alert('Não consegui identificar seu usuário. Tente novamente.'); return; }
      const ok = confirm('Sair desta conversa?'); if (!ok) return;
      await j(`/api/internal-chat/conversations/${tid}/participants`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ remove:[ME_ID] }) });
      CONVS.delete(tid); drawConvs();
      if (ACTIVE === tid) { ACTIVE = null; MSGS.delete(tid); if (msgsEl) msgsEl.innerHTML = '<div class="empty" id="emptyState">Selecione uma conversa para começar.</div>'; }
    }, true));

    document.body.appendChild(el);
    openMenuEl = el;
    setTimeout(()=>{ document.addEventListener('click', onDocClickClose, true); document.addEventListener('keydown', onEscClose, true); }, 0);
  }

  // ===== Ações de dados =====
  async function loadConvs(query){
    const q = query ? `&q=${encodeURIComponent(query)}` : '';
    const rows = await j(`/api/internal-chat/conversations?limit=50&offset=0${q}`);
    CONVS.clear();
    rows.forEach(c => CONVS.set(c.thread_id, c));
    drawConvs();
  }

  async function selectThread(tid){
    ACTIVE = tid;
    listaEl?.querySelectorAll('.conv').forEach(li => li.setAttribute('aria-selected', li.dataset.tid === tid ? 'true':'false'));
    const c = CONVS.get(tid);
    if (peerNameEl)  peerNameEl.textContent  = (c && c.titulo) || 'Conversa';
    if (peerStatusEl) peerStatusEl.textContent = '—';

    const list = await j(`/api/internal-chat/conversations/${tid}/messages?limit=50`);
    const asc = list.slice().reverse();
    MSGS.set(tid, asc);
    drawMsgs(tid);

    await markAsRead(tid);
    const cc = CONVS.get(tid);
    if (cc) { cc.unread_count = 0; CONVS.set(tid, cc); drawConvs(); }

    document.body?.setAttribute('data-pane','chat');
  }

  async function markAsRead(tid){
    try { await j(`/api/internal-chat/conversations/${tid}/read`, { method:'POST' }); } catch {}
  }

  async function sendActive(){
    if (!ACTIVE || !txtMsg) return;
    const texto = txtMsg.value.trim(); if (!texto) return;
    txtMsg.value = ''; txtMsg.style.height = 'auto';

    const res = await j(`/api/internal-chat/conversations/${ACTIVE}/messages`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ texto })
    });
    if (res && typeof res === 'object' && res.id && res.autor_id != null) {
      trySetMeIdOnce(res.autor_id);
    }
  }

  // ===== Utils de avatar =====
  function getInitials(name){
    const n = (name || '').trim().split(/\s+/).filter(Boolean);
    if (n.length === 0) return '??';
    if (n.length === 1) return n[0].slice(0,2).toUpperCase();
    return (n[0][0] + n[n.length-1][0]).toUpperCase();
  }

  // ===== Modal: Nova conversa (com foto real) =====
  function closeAnyModal(){
    document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
  }

  function buildNewChannelModal(colabs){
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.tabIndex = -1;

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <header>Nova conversa</header>
      <div class="content">
        <p style="margin-bottom:.6rem">Escolha os participantes e, se quiser, defina um título.</p>
        <label style="font-weight:600; display:block; margin:.25rem 0 .35rem">Título (opcional)</label>
        <input type="text" id="nc-title" placeholder="Ex.: Suporte Nível 1" />
        <div style="display:flex; align-items:center; gap:.5rem; margin:.8rem 0 .4rem">
          <input id="nc-checkall" type="checkbox" />
          <label for="nc-checkall" style="user-select:none; cursor:pointer">Selecionar todos</label>
        </div>
        <div class="search" role="search" style="margin:.35rem 0 .55rem">
          <input id="nc-search" type="search" placeholder="Buscar colaborador…" aria-label="Buscar colaborador" />
        </div>
        <div id="nc-list" style="max-height:340px; overflow:auto; border:1px solid var(--border); border-radius:.5rem; padding:.2rem .2rem"></div>
      </div>
      <footer>
        <button class="btn ghost" id="nc-cancel">Cancelar</button>
        <button class="btn primary" id="nc-create">Criar conversa</button>
      </footer>
    `;
    overlay.appendChild(modal);

    // Fechar clicando fora ou ESC
    overlay.addEventListener('click', (e)=>{ if (e.target === overlay) closeAnyModal(); });
    document.addEventListener('keydown', escOnce);
    function escOnce(ev){ if (ev.key === 'Escape') { closeAnyModal(); document.removeEventListener('keydown', escOnce); } }

    const listEl = modal.querySelector('#nc-list');
    const searchEl = modal.querySelector('#nc-search');
    const checkAllEl = modal.querySelector('#nc-checkall');
    const titleEl = modal.querySelector('#nc-title');

    function renderList(filter=''){
      listEl.innerHTML = '';
      const f = filter.trim().toLowerCase();
      const rows = !f ? colabs : colabs.filter(c => {
        const n = (c.nome || c.name || c.nome_completo || '').toLowerCase();
        const d = (c.setor_nome || c.departamento || c.depto || '').toLowerCase();
        return n.includes(f) || d.includes(f);
      });

      rows.forEach(c => {
        const id   = Number(c.id);
        const nome = c.nome || c.name || c.nome_completo || ('Colaborador #' + id);
        const dept = c.setor_nome || c.departamento || c.depto || '';
        const ini  = getInitials(nome);
        const avatarSrc = `/api/colaboradores/${id}/avatar`; // foto real do colaborador

        const item = document.createElement('label');
        item.style.display = 'grid';
        item.style.gridTemplateColumns = '24px 28px 1fr';
        item.style.alignItems = 'center';
        item.style.gap = '.55rem';
        item.style.padding = '.45rem .55rem';
        item.style.borderBottom = '1px solid var(--border)';
        item.style.cursor = 'pointer';

        item.innerHTML = `
          <input type="checkbox" data-id="${id}" />
          <div class="ava" aria-hidden="true" style="
              width:28px;height:28px;border-radius:999px;overflow:hidden;display:grid;place-items:center;
              background:linear-gradient(135deg,#4f46e5,#22d3ee); color:#fff; font-weight:800; font-size:.8rem;">
            <img src="${avatarSrc}" alt="" style="width:100%;height:100%;object-fit:cover;display:block"
                 onload="if(!this.naturalWidth){this.onerror()}"
                 onerror="this.remove(); this.nextElementSibling.style.display='grid';">
            <div class="ava-fb" style="display:none;place-items:center;width:100%;height:100%;">${esc(ini)}</div>
          </div>
          <div style="min-width:0">
            <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${esc(nome)}</div>
            <div style="font-size:.86rem; color:var(--muted)">${esc(dept)}</div>
          </div>
        `;
        listEl.appendChild(item);
      });
    }
    renderList();

    searchEl.addEventListener('input', debounce(() => renderList(searchEl.value||''), 180));
    checkAllEl.addEventListener('change', ()=>{
      listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = checkAllEl.checked);
    });

    modal.querySelector('#nc-cancel').addEventListener('click', ()=> closeAnyModal());
    modal.querySelector('#nc-create').addEventListener('click', async ()=>{
      const ids = [...listEl.querySelectorAll('input[type="checkbox"]')].filter(cb => cb.checked).map(cb => Number(cb.dataset.id));
      if (ids.length === 0) { toast('Selecione pelo menos 1 colaborador.', 'warn'); return; }
      const titulo = (titleEl.value||'').trim() || undefined;
      const body = titulo ? { titulo, participantes: ids } : { participantes: ids };
      try{
        const conv = await j('/api/internal-chat/conversations', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
        });
        closeAnyModal();
        toast('Conversa criada!', 'ok');
        await selectThread(conv.thread_id);
      }catch(e){
        toast('Falha ao criar a conversa.', 'err');
      }
    });

    document.body.appendChild(overlay);
    titleEl.focus();
  }

  async function fetchColaboradores(){
    // Usa o endpoint que você já tem
    try {
      const rows = await j('/api/colaboradores');
      if (Array.isArray(rows)) return rows;
    } catch {}
    return [];
  }

  async function openNewChannelModal(){
    const colabs = await fetchColaboradores();
    if (!Array.isArray(colabs) || colabs.length === 0) {
      toast('Não encontrei colaboradores para listar.', 'warn');
      return;
    }
    buildNewChannelModal(colabs);
  }

  async function promptRename(tid){
    // mantém prompt por enquanto (se quiser, converto pra mini-modal depois)
    const c = CONVS.get(tid);
    const novo = prompt('Renomear conversa para:', (c && c.titulo) || 'Conversa');
    if (!novo || !novo.trim()) return;
    await j(`/api/internal-chat/conversations/${tid}`, {
      method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ titulo: novo.trim() })
    });
  }

  // ===== Listeners =====
  document.addEventListener('click', (e)=>{
    const b = e.target.closest('#btnKebabHeader');
    if(!b) return;
    b.setAttribute('aria-expanded', b.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
  });

  btnSend?.addEventListener('click', sendActive);
  txtMsg?.addEventListener('keydown', (e)=>{ if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendActive(); } });
  txtMsg?.addEventListener('input', ()=>{ txtMsg.style.height='auto'; txtMsg.style.height=Math.min(txtMsg.scrollHeight,160)+'px'; });

  btnAttach?.addEventListener('click', ()=>{ alert('Upload/anexo não implementado.'); });
  btnBackList?.addEventListener('click', ()=>{ document.body?.setAttribute('data-pane','list'); });

  // (+) MODAL com fotos reais
  btnNewChannel?.addEventListener('click', openNewChannelModal);

  const doSearch = debounce(async () => {
    const q = (inpSearch?.value || '').trim();
    if (!q) { loadConvs(); return; }
    await loadConvs(q);
  }, 250);
  inpSearch?.addEventListener('input', doSearch);

  // ===== Boot =====
  (async function boot(){
    const density = localStorage.getItem('ui_density') || 'comfortable';
    document.body.classList.toggle('compact', density === 'compact');

    try {
      const me = await j('/api/internal-chat/me');
      trySetMeIdOnce(me?.colab_id);
      if (me?.empresa_id) EMPRESA_ID = Number(me.empresa_id);
    } catch {}

    if (!EMPRESA_ID) {
      const fromLS = Number(localStorage.getItem('empresa_id') || 0);
      if (fromLS) EMPRESA_ID = fromLS;
    }

    if (EMPRESA_ID) openWS(EMPRESA_ID);

    try { await loadConvs(); } catch (e) { console.warn('Falha ao carregar conversas', e); }

    window.CHAT_INT = {
      state(){ return { ACTIVE, CONVS, MSGS, ME_ID, EMPRESA_ID, MUTED:[...MUTED], PINNED:[...PINNED] }; },
      selectThread,
      openNewChannelModal,
      setMeId(v){ trySetMeIdOnce(v); },
      _openWS: openWS
    };
  })();

})();
