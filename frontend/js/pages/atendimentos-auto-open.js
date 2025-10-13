// frontend/js/pages/atendimentos-autoopen.js
(function AutoOpenConversa(){
  'use strict';

  // ===== Helpers base / auth =====
  const LS = localStorage;
  const EMPRESA_ID = Number(LS.getItem('empresa_id') || '') || null;

  const authFetch = (url, opt={}) => {
    const f = (window.ZAuth && ZAuth.authFetch) ? ZAuth.authFetch : fetch;
    const headers = Object.assign(
      { 'Accept':'application/json' },
      opt.headers || {},
      EMPRESA_ID ? { 'X-Empresa-Id': String(EMPRESA_ID) } : {}
    );
    return f(url, { credentials:'include', ...opt, headers });
  };
  const $ = (s, r=document)=>r.querySelector(s);

  function toast(msg, type='ok'){
    const el = document.getElementById('toast');
    if (!el){ console.log('[autoopen]', msg); return; }
    el.textContent = msg;
    el.style.display = 'block';
    el.style.background = type==='err' ? '#7f1d1d'
                      : type==='warn'? '#78350f'
                      : '#065f46';
    clearTimeout(toast._t);
    toast._t = setTimeout(()=> el.style.display='none', 2200);
  }
  function digits(s){ return String(s||'').replace(/\D+/g,''); }
  function formatTelBR(v){
    const d = digits(v);
    if (!d) return '';
    if (d.length >= 11){
      const dd=d.slice(-11,-9), n=d.slice(-9);
      return `(${dd}) ${n[0]} ${n.slice(1,5)}-${n.slice(5)}`;
    }
    if (d.length >= 10){
      const dd=d.slice(-10,-8), n=d.slice(-8);
      return `(${dd}) ${n.slice(0,4)}-${n.slice(4)}`;
    }
    return d;
  }
  function isoToTime(s){
    try{ const d = new Date(s); return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }catch{ return ''; }
  }

  function setActiveInstance(slug){
    if (!slug) return;
    window.INSTANCIA_ATIVA = slug;
    try{ LS.setItem('INSTANCIA_ATIVA', slug); }catch{}
    try{ document.cookie = `INSTANCIA_ATIVA=${encodeURIComponent(slug)}; path=/; max-age=${60*60*24*30}`; }catch{}
  }

  // ===== API =====
  async function apiGet(path){
    const r = await authFetch(path);
    const t = await r.text().catch(()=> '');
    let data = null; try{ data = t? JSON.parse(t): null; }catch{ data = t || null; }
    if (!r.ok){
      const err = new Error((data && (data.detail || data.message)) || r.statusText || 'Erro');
      err.status = r.status; err.data = data; throw err;
    }
    return data;
  }

  // ===== Fallback UI (se o seu layout não “pegar” os dados) =====
  function ensureFallbackContainers(){
    let wrap = document.getElementById('autoopen-wrap');
    if (wrap) return wrap;

    wrap = document.createElement('div');
    wrap.id = 'autoopen-wrap';
    wrap.style.cssText = `
      position:relative; display:flex; flex-direction:column; height:calc(100vh - 64px);
      max-width:100%; margin:0 auto;
    `;

    const header = document.createElement('div');
    header.id = 'autoopen-header';
    header.style.cssText = `
      display:flex; align-items:center; gap:.75rem; padding:.7rem 1rem;
      border-bottom:1px solid var(--border, #333); background:var(--card, #161617);
    `;
    header.innerHTML = `
      <div class="av" style="width:36px;height:36px;border-radius:999px;overflow:hidden;background:#222"></div>
      <div style="line-height:1.1">
        <div class="nm" style="font-weight:700"></div>
        <div class="sub" style="opacity:.7; font-size:.85rem"></div>
      </div>
      <div style="margin-left:auto"><span class="chip" style="border:1px solid var(--border,#333);padding:.2rem .6rem;border-radius:999px;font-size:.78rem;opacity:.8"></span></div>
    `;

    const thread = document.createElement('div');
    thread.id = 'autoopen-thread';
    thread.style.cssText = `
      flex:1; overflow:auto; padding:1rem; background:transparent;
      display:flex; flex-direction:column; gap:.4rem;
    `;

    document.body.appendChild(wrap);
    wrap.appendChild(header);
    wrap.appendChild(thread);
    return wrap;
  }

  function setHeader(cli, instanceSlug){
    // tente preencher seu header se existir
    const nameEl = $('.chat-header .name') || $('#chat-title') || $('#top-name');
    const phoneEl= $('.chat-header .phone')|| $('#top-phone');
    const avImg  = $('.chat-header .avatar img') || $('.chat-header img');

    const nome = (cli?.nome_whatsapp || cli?.nome || '').trim() || formatTelBR(cli?.telefone||'') || 'Contato';
    const tel  = formatTelBR(cli?.telefone || '');

    if (nameEl) nameEl.textContent = nome;
    if (phoneEl) phoneEl.textContent = tel;
    if (avImg && cli?.avatar_url) avImg.src = cli.avatar_url;

    // fallback bonito
    const wrap = ensureFallbackContainers();
    wrap.querySelector('.nm').textContent = nome;
    wrap.querySelector('.sub').textContent = tel || '—';
    wrap.querySelector('.chip').textContent = instanceSlug || 'instância';
    const av = wrap.querySelector('.av');
    av.innerHTML = '';
    if (cli?.avatar_url){
      const img = document.createElement('img');
      img.src = cli.avatar_url; img.alt = ''; img.style.width='100%'; img.style.height='100%'; img.style.objectFit='cover';
      av.appendChild(img);
    }else{
      av.style.background = '#2a2a2b';
    }
  }

  function renderMessagesFallback(msgs){
    const thread = document.getElementById('autoopen-thread') || ensureFallbackContainers().querySelector('#autoopen-thread');
    thread.innerHTML = '';

    msgs.forEach(m=>{
      const isOut = (String(m.tipo||'').toLowerCase() === 'saida');   // 'saida' x 'entrada'
      const bubble = document.createElement('div');
      bubble.style.cssText = `
        max-width:70%; align-self:${isOut?'flex-end':'flex-start'};
        background:${isOut?'#075e54':'#202226'}; color:#fff;
        border-radius:12px; padding:.55rem .7rem; line-height:1.3;
      `;
      bubble.innerHTML = `
        <div>${(m.conteudo || '').replace(/</g,'&lt;')}</div>
        <div style="opacity:.7; font-size:.75rem; text-align:right; margin-top:.2rem">
          ${isoToTime(m.timestamp || '')}${isOut && m.ack!=null ? ` • ✓${Number(m.ack)>=2?'✓':''}`:''}
        </div>
      `;
      // mídias (links simples)
      if (Array.isArray(m.midias) && m.midias.length){
        m.midias.forEach(md=>{
          const a = document.createElement('a');
          a.href = `/api/atendimento/midias/${encodeURIComponent(md.id)}`;
          a.textContent = md.filename || md.mimetype || 'arquivo';
          a.target = '_blank';
          a.style.cssText = 'display:inline-block;margin-top:.35rem;text-decoration:underline;';
          bubble.appendChild(a);
        });
      }
      thread.appendChild(bubble);
    });
    // scroll bottom
    thread.scrollTop = thread.scrollHeight + 999;
  }

  // ===== Auto abrir a partir dos parâmetros =====
  async function autoOpen(){
    const qs = new URLSearchParams(location.search);
    const clienteId = Number(qs.get('cliente_id') || qs.get('cliente') || '');
    if (!clienteId) return;

    const instSlug = (qs.get('instancia') || LS.getItem('INSTANCIA_ATIVA') || '').trim();
    if (instSlug) setActiveInstance(instSlug);

    try{
      // 1) Cliente (header)
      const cli = await apiGet(`/api/clientes/${clienteId}${EMPRESA_ID ? `?empresa_id=${EMPRESA_ID}`:''}`).catch(()=>null);
      if (cli) setHeader(cli, instSlug || '');

      // 2) Mensagens (força inicializar a conversa)
      const url = new URL(`/api/atendimento/conversas/${clienteId}/mensagens`, location.origin);
      if (EMPRESA_ID) url.searchParams.set('empresa_id', String(EMPRESA_ID));
      if (instSlug)   url.searchParams.set('instance', instSlug);
      url.searchParams.set('limit','50');
      const data = await apiGet(url.toString());
      const mensagens = (data && (data.items || data.mensagens)) || [];

      // 3) Tenta acionar handlers nativos, se existirem
      let handled = false;
      try{
        if (window.Chat && typeof window.Chat.abrir === 'function'){
          window.Chat.abrir(clienteId, { instance: instSlug || null, preload: mensagens });
          handled = true;
        }else if (typeof window.dispatchEvent === 'function'){
          window.dispatchEvent(new CustomEvent('chat:autoopen', {
            detail: { cliente_id: clienteId, instance: instSlug || null, mensagens }
          }));
        }
      }catch{}

      // 4) Se ninguém cuidou, renderiza fallback bonito
      if (!handled){
        renderMessagesFallback(mensagens);
      }

    }catch(e){
      console.error('[autoopen] falhou:', e);
      toast(e?.data?.detail || 'Não foi possível carregar a conversa.','err');
    }
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', autoOpen, { once:true });
  }else{
    autoOpen();
  }
})();
