(() => {
  // ===== Helpers de rede/format =====
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

  // ===== DOM refs =====
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
  let ACTIVE = null;
  const CONVS = new Map();
  const MSGS  = new Map();
  const MUTED  = new Set(JSON.parse(localStorage.getItem('muted_threads')  || '[]'));
  const PINNED = new Set(JSON.parse(localStorage.getItem('pinned_threads') || '[]'));
  const saveSet = (k,set)=> localStorage.setItem(k, JSON.stringify([...set]));

  function trySetMeIdOnce(val){
    if (val == null) return;
    if (ME_ID == null && !Number.isNaN(Number(val))) {
      ME_ID = Number(val);
      if (ACTIVE) drawMsgs(ACTIVE);
    }
  }

  // tenta resolver ME_ID
  try { trySetMeIdOnce((window.AUTH && (window.AUTH.id_colab || window.AUTH.id)) || null); } catch {}
  if (ME_ID == null) trySetMeIdOnce(Number(localStorage.getItem('colab_id') || localStorage.getItem('user_id')) || null);

  // ===== UI =====
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

      // seleção
      li.addEventListener('click', (ev)=>{
        if (ev.target && ev.target.closest('.conv-opts')) return;
        selectThread(c.thread_id);
      });

      // menu rápido
      li.querySelector('.conv-opts')?.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        const rect = ev.currentTarget.getBoundingClientRect();
        openConvMenu(c.thread_id, rect.left, rect.bottom + 6);
      });

      // clique direito
      li.addEventListener('contextmenu', (ev)=>{ ev.preventDefault(); openConvMenu(c.thread_id, ev.pageX, ev.pageY); });

      // long press
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

  function isMsgMine(m){ return ME_ID != null && Number(m.autor_id) === Number(ME_ID); }

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

  // ===== Menu contexto =====
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
    el.appendChild(mkBtn('Marcar como lida', async ()=>{ await j(`/api/internal-chat/conversations/${tid}/read`, { method:'POST' }); const cc = CONVS.get(tid); if (cc) { cc.unread_count = 0; CONVS.set(tid, cc); drawConvs(); } }));
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

  // ===== Ações =====
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
    if (peerNameEl) peerNameEl.textContent = (c && c.titulo) || 'Conversa';
    if (peerStatusEl) peerStatusEl.textContent = '—';

    const list = await j(`/api/internal-chat/conversations/${tid}/messages?limit=50`);
    const asc = list.slice().reverse();
    MSGS.set(tid, asc);
    drawMsgs(tid);

    await j(`/api/internal-chat/conversations/${tid}/read`, { method:'POST' });
    const cc = CONVS.get(tid);
    if (cc) { cc.unread_count = 0; CONVS.set(tid, cc); drawConvs(); }

    document.body?.setAttribute('data-pane','chat');
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

  async function createChannelPromptFallback(){
    const titulo = prompt('Nome da conversa:', 'Nova conversa');
    if (!titulo) return;
    const conv = await j('/api/internal-chat/conversations', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ titulo })
    });
    await selectThread(conv.thread_id);
  }

  async function promptRename(tid){
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

  // (+) agora usa apenas prompt — sem modal
  btnNewChannel?.addEventListener('click', createChannelPromptFallback);

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

    try { const me = await j('/api/internal-chat/me'); trySetMeIdOnce(me?.colab_id); } catch {}

    try { await loadConvs(); } catch (e) { console.warn('Falha ao carregar conversas', e); }

    // API interna opcional
    window.CHAT_INT = {
      state(){ return { ACTIVE, CONVS, MSGS, ME_ID, MUTED:[...MUTED], PINNED:[...PINNED] }; },
      selectThread,
      createChannelPromptFallback,
      promptRename,
      setMeId(v){ trySetMeIdOnce(v); },
    };
  })();

})();
