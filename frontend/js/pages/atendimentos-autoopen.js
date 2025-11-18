// /frontend/js/pages/atendimentos-autoopen.js
(function AutoOpenConversa(){
  'use strict';

  console.debug('[autoopen] script carregado');

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
    if (!el){ console.log('[autoopen-toast]', msg); return; }
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

  function setActiveInstance(val){ // aceita id ou slug
    if (!val) return;
    const v = String(val).trim();
    window.INSTANCIA_ATIVA = v;
    try{ LS.setItem('INSTANCIA_ATIVA', v); }catch{}
    try{
      document.cookie = `INSTANCIA_ATIVA=${encodeURIComponent(v)}; path=/; max-age=${60*60*24*30}`;
    }catch{}
  }

  async function apiGet(path){
    let url;
    try{
      url = new URL(path, location.origin);
      if (EMPRESA_ID && !url.searchParams.has('empresa_id')) {
        url.searchParams.set('empresa_id', String(EMPRESA_ID));
      }
    }catch{ url = path; }
    const r = await authFetch(url);
    const t = await r.text().catch(()=> '');
    let data = null; try{ data = t? JSON.parse(t): null; }catch{ data = t || null; }
    if (!r.ok){
      const err = new Error((data && (data.detail || data.message)) || r.statusText || 'Erro');
      err.status = r.status; err.data = data; throw err;
    }
    return data;
  }

  // ===== Fallback UI (se o layout padrão não “pegar” a conversa) =====
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

  function setHeader(cli, instanceTxt){
    const nameEl = $('.chat-header .name') || $('#chat-title') || $('#top-name');
    const phoneEl= $('.chat-header .phone')|| $('#top-phone');
    const avImg  = $('.chat-header .avatar img') || $('.chat-header img');

    const nome = (cli?.nome_whatsapp || cli?.nome || '').trim() || formatTelBR(cli?.telefone||'') || 'Contato';
    const tel  = formatTelBR(cli?.telefone || '');

    if (nameEl) nameEl.textContent = nome;
    if (phoneEl) phoneEl.textContent = tel;
    if (avImg && cli?.avatar_url) avImg.src = cli.avatar_url;

    const wrap = ensureFallbackContainers();
    wrap.querySelector('.nm').textContent = nome;
    wrap.querySelector('.sub').textContent = tel || '—';
    wrap.querySelector('.chip').textContent = instanceTxt || 'instância';
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

  // >>>>>>> NOVO: hidratar state.clienteSel com telefone, nome etc.
  function hydrateClienteSel(cli, opts){
    window.state = window.state || {};
    const prev = window.state.clienteSel || {};
    const rawTel =
      cli?.telefone ||
      cli?.phone ||
      cli?.numero ||
      cli?.whatsapp ||
      cli?.wa_id ||
      '';

    const telDigits = digits(rawTel);

    const novo = {
      ...prev,
      id:          cli?.id ?? prev.id ?? opts?.clienteId,
      cliente_id:  cli?.id ?? prev.cliente_id ?? prev.id ?? opts?.clienteId,
      nome:        cli?.nome || cli?.nome_whatsapp || prev.nome,
      nome_whatsapp: cli?.nome_whatsapp || prev.nome_whatsapp,
      telefone:    telDigits,
      telefone_raw: rawTel,
      numero:      telDigits,
      wa_id:       cli?.wa_id || cli?.whatsapp_id || prev.wa_id,
      avatar_url:  cli?.avatar_url || prev.avatar_url,
      instancia_id: prev.instancia_id ?? opts?.instancia_id ?? null,
      instancia:    prev.instancia ?? opts?.instancia ?? null
    };

    window.state.clienteSel = novo;
    // alguns códigos antigos podem usar isso:
    window.CLIENTE_ATUAL = novo;

    console.debug('[autoopen] clienteSel hidratado:', novo);
  }

  function renderMessagesFallback(msgs){
    const thread = document.getElementById('autoopen-thread') || ensureFallbackContainers().querySelector('#autoopen-thread');
    thread.innerHTML = '';

    msgs.forEach(m=>{
      const isOut = (String(m.tipo||'').toLowerCase() === 'saida') || m.from_me === true;
      const bubble = document.createElement('div');
      bubble.style.cssText = `
        max-width:70%; align-self:${isOut?'flex-end':'flex-start'};
        background:${isOut?'#075e54':'#202226'}; color:#fff;
        border-radius:12px; padding:.55rem .7rem; line-height:1.3;
      `;
      bubble.innerHTML = `
        <div>${(m.conteudo || m.mensagem || m.texto || '').replace(/</g,'&lt;')}</div>
        <div style="opacity:.7; font-size:.75rem; text-align:right; margin-top:.2rem">
          ${isoToTime(m.timestamp || m.data || m.created_at || '')}${isOut && m.ack!=null ? ` • ✓${Number(m.ack)>=2?'✓':''}`:''}
        </div>
      `;
      if (Array.isArray(m.midias) && m.midias.length){
        m.midias.forEach(md=>{
          const a = document.createElement('a');
          a.href = `/api/atendimento/midias/${encodeURIComponent(md.id)}${EMPRESA_ID?`?empresa_id=${EMPRESA_ID}`:''}`;
          a.textContent = md.filename || md.mimetype || 'arquivo';
          a.target = '_blank';
          a.style.cssText = 'display:inline-block;margin-top:.35rem;text-decoration:underline;';
          bubble.appendChild(a);
        });
      }
      thread.appendChild(bubble);
    });
    thread.scrollTop = thread.scrollHeight + 999;
  }

  async function openWithHistorico(clienteId){
    console.debug('[autoopen] abrindo com historico.js', clienteId);

    let hist = document.getElementById('historico');
    if (!hist){
      const main = $('#chatMain') || $('.main') || document.getElementById('chat-main') || document.body;
      hist = document.createElement('div');
      hist.id = 'historico';
      hist.style.minHeight = '240px';
      hist.style.overflowY = 'auto';
      main.appendChild(hist);
    }

    document.body.dataset.chatOpen = '1';
    document.getElementById('chat-empty')?.remove();
    document.getElementById('empty-hero')?.remove();
    const welcome = document.getElementById('welcome-screen');
    if (welcome) welcome.style.display = 'none';

    const header = document.getElementById('chat-header');
    const footer = document.getElementById('chat-footer');
    if (header) header.style.display = '';
    if (footer) footer.style.display = '';
    hist.style.display = '';

    try{
      await window.abrirHistorico(clienteId, { forceReload:true });
    }catch(e){
      console.error('[autoopen] erro ao chamar abrirHistorico', e);
    }

    const input = $('#mensagem') || $('#composerInput') || $('#chatInput') || $('textarea, input[type="text"]');
    input?.focus?.();
  }

  async function prepareAutoOpen(){
    const qs = new URLSearchParams(location.search);
    const clienteId = Number(qs.get('cliente_id') || qs.get('cliente') || '');
    if (!clienteId) {
      console.debug('[autoopen] sem cliente_id na URL, nada pra fazer');
      return;
    }

    console.debug('[autoopen] cliente_id detectado:', clienteId);

    const instIdParam   = qs.get('instancia_id') || qs.get('instance_id');
    const instSlugParam = qs.get('instancia')   || qs.get('instance');
    const instValue = (instIdParam && String(instIdParam).trim())
                   || (instSlugParam && String(instSlugParam).trim())
                   || LS.getItem('INSTANCIA_ATIVA')
                   || '';

    if (instValue) setActiveInstance(instValue);

    // base mínima
    window.state = window.state || {};
    window.state.clienteSel = {
      id: clienteId,
      cliente_id: clienteId,
      instancia_id: (instIdParam && Number(instIdParam)) || null,
      instancia: (!instIdParam && instSlugParam) ? String(instSlugParam) : null
    };

    // carrega dados básicos do cliente pra header E pra telefone
    let cli = null;
    try{
      cli = await apiGet(`/api/clientes/${clienteId}`);
      if (cli) {
        setHeader(cli, String(instValue || ''));
        hydrateClienteSel(cli, {
          clienteId,
          instancia_id: (instIdParam && Number(instIdParam)) || null,
          instancia: (!instIdParam && instSlugParam) ? String(instSlugParam) : null
        });
      }
    }catch(e){
      console.warn('[autoopen] não conseguiu carregar cliente', e);
    }

    const maxAttempts = 40;   // ~10s (40 * 250ms)
    let attempts = 0;

    async function step(){
      attempts++;
      const hasHistorico = typeof window.abrirHistorico === 'function';
      console.debug('[autoopen] step', { attempts, hasHistorico });

      if (hasHistorico){
        await openWithHistorico(clienteId);
        return;
      }

      if (attempts >= maxAttempts){
        console.warn('[autoopen] historico.js não apareceu, usando fallback simples');
        try{
          const url = new URL(`/api/atendimento/conversas/${clienteId}/mensagens`, location.origin);
          if (EMPRESA_ID) url.searchParams.set('empresa_id', String(EMPRESA_ID));
          if (instIdParam && /^\d+$/.test(String(instIdParam))) {
            url.searchParams.set('instancia_id', String(instIdParam));
          } else if (instSlugParam) {
            url.searchParams.set('instance', String(instSlugParam));
          } else if (instValue) {
            if (/^\d+$/.test(String(instValue))) url.searchParams.set('instancia_id', String(instValue));
            else url.searchParams.set('instance', String(instValue));
          }
          url.searchParams.set('limit','30');

          const data = await apiGet(url.toString());
          const mensagens = (data && (data.items || data.mensagens)) || [];
          renderMessagesFallback(mensagens);
        }catch(e){
          console.error('[autoopen] fallback falhou', e);
          toast(e?.data?.detail || 'Não foi possível carregar a conversa.','err');
        }
        return;
      }

      setTimeout(step, 250);
    }

    step();
  }

  // dispara logo que o script carrega
  prepareAutoOpen();

  // CSS pra esconder hero/welcome quando um chat estiver aberto
  (function injectCSS(){
    const id='auto-open-css';
    if (document.getElementById(id)) return;
    const s=document.createElement('style');
    s.id=id;
    s.textContent = `
      body[data-chat-open="1"] #chat-empty,
      body[data-chat-open="1"] #empty-hero,
      body[data-chat-open="1"] #welcome-screen {
        display:none !important;
      }
    `;
    (document.head||document.documentElement).appendChild(s);
  })();

})();
