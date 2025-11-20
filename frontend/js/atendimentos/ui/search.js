// /frontend/js/atendimentos/ui/search.js
// Busca global (contatos + mensagens) e "procurar no chat aberto"

(function(){
  const hist        = document.getElementById('historico');
  const searchInput = document.getElementById('wpp-header-search');
  const EMPRESA_ID  = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);

  function _normalize(s){
    return (s||'').toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g,'')
      .toLowerCase()
      .trim();
  }
  function escapeHtml(s){
    return (s||'').replace(/[&<>"]/g, ch => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'
    }[ch]));
  }
  function formatarNumeroBR(numero){
    function onlyDigits(s){ return (s||'').replace(/\D/g,''); }
    if (!numero) return "";
    let n = onlyDigits(numero);
    if (!n.startsWith('55')) n = '55' + n;
    n = n.slice(0,14);
    const ddd = n.slice(2,4), resto = n.slice(4);
    if (resto.length===9 && resto[0]==='9') return `+55 ${ddd} ${resto.slice(0,5)}-${resto.slice(5)}`;
    if (resto.length===8) return `+55 ${ddd} ${resto.slice(0,4)}-${resto.slice(4)}`;
    return `+55 ${ddd} ${resto}`;
  }
  const MARKER_RE = /^\[(Imagem|Vídeo|Video|Áudio\/ptt|Áudio|Audio|Documento|Figurinha|Localização|Contatos?|M[íi]dia)\](?:\s.*)?$/i;

  // painel/resultados
  let resultsEl = document.getElementById('search-results');
  if (!resultsEl){
    resultsEl=document.createElement('div');
    resultsEl.id='search-results';
    resultsEl.className='sr-container hidden';
    resultsEl.style.cssText='position:relative;padding:8px 8px 6px;color:#e9edef;background:#111b21;border-bottom:1px solid #223038;';
    (searchInput?.closest('.wpp-header-search-row')||searchInput?.parentElement||document.body)
      ?.insertAdjacentElement('afterend',resultsEl);
  }
  function srShowLoading(){
    resultsEl.classList.remove('hidden');
    resultsEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 6px;">
        <span style="width:16px;height:16px;border-radius:9999px;border:2px solid #2a3942;border-top-color:#25d366;display:inline-block;animation:spin .8s linear infinite"></span>
        <span style="font-size:13px;color:#aebac1;">Procurando…</span>
      </div>
      <style>@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}</style>`;
  }
  function srHide(){
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML='';
  }
  function srRender(html){
    resultsEl.innerHTML=html||'';
    resultsEl.classList.toggle('hidden',!html);
  }

  let _searchActive=false, _searchAbort=null;

  async function serverSearch(q, limit=50){
    if (!q?.trim()) return {contatos:[], mensagens:[]};
    if (_searchAbort){ try{_searchAbort.abort();}catch{} }
    _searchAbort = new AbortController();

    const instQuery = (typeof window._instQuery === 'function') ? window._instQuery() : '';
    const url = `/api/atendimento/search?empresa_id=${EMPRESA_ID}&q=${encodeURIComponent(q)}&limit=${limit}${instQuery}`;
    const res = await fetch(url,{ signal:_searchAbort.signal, credentials:'include' });
    if (!res.ok){
      const txt=await res.text().catch(()=> '');
      throw new Error(`[search] HTTP ${res.status} ${txt?.slice(0,150)}`);
    }
    const data = await res.json();
    return {
      contatos: Array.isArray(data.contatos)?data.contatos:[],
      mensagens: Array.isArray(data.mensagens)?data.mensagens:[]
    };
  }

  function renderSearchPanel({q,contatos,mensagens}){
    const query=(q||'').trim();
    let html='';

    // --------- BLOCO MENSAGENS (usa cliente_nome / cliente_telefone do back) ----------
    if (mensagens?.length){
      html += `<div class="sr-group" style="padding:6px 2px;">
        <div class="sr-title" style="color:#7aa39a;font-size:12px;text-transform:uppercase;margin:6px 4px 4px;"><i class="fa fa-message"></i> Mensagens</div>
        <ul class="sr-list" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;">` +
        mensagens.slice(0,80).map(m=>{
          const cache = (window.todosContatosCache||window.clientesCache||[])
            .find(x=> Number(x.id)===Number(m.cliente_id)) || {};

          const telRaw = (m.cliente_telefone || cache.telefone || '').toString().trim();
          const telBR  = telRaw ? formatarNumeroBR(telRaw) : '';

          const rawNome =
            (m.cliente_nome || '').toString().trim() ||
            (cache.push_name || '').toString().trim() ||
            (cache.nome || '').toString().trim();

          const displayNome = rawNome || telBR;
          const nomeHtml =
            escapeHtml(displayNome || '') +
            (rawNome && telBR ? `<span style="opacity:.6;"> · ${escapeHtml(telBR)}</span>` : '');

          const when    = (window.formatChatTime||(()=>''))(m.hora||'') || '';
          const snipRaw = m.snippet || '';
          const snip    = MARKER_RE.test(snipRaw) ? '' : escapeHtml(snipRaw).slice(0,220);

          return `<li class="sr-item sr-msg" data-id="${m.cliente_id}" data-q="${encodeURIComponent(query)}"
              style="display:flex;gap:10px;align-items:flex-start;padding:6px;border-radius:8px;cursor:pointer;">
            <div class="sr-bullet" style="width:6px;height:6px;border-radius:9999px;background:#25d366;margin-top:8px;"></div>
            <div class="sr-text" style="flex:1;min-width:0;">
              <div class="sr-name" style="font-size:13px;color:#e9edef;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${nomeHtml}</div>
              <div class="sr-msgline" style="font-size:12px;color:#aebac1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${snip ? '… '+snip : ''}</div>
            </div>
            <div class="sr-meta" style="font-size:11px;color:#6b7c85;">${when}</div>
          </li>`;
        }).join('') + `</ul></div>`;
    }

    // --------- BLOCO CONTATOS (igual estava) ----------
    if (contatos?.length){
      html += `<div class="sr-group" style="padding:6px 2px;">
        <div class="sr-title" style="color:#7aa39a;font-size:12px;text-transform:uppercase;margin:6px 4px 4px;"><i class="fa fa-user"></i> Contatos</div>
        <ul class="sr-list" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;">` +
        contatos.slice(0,80).map(c=>{
          const nome = c.push_name?.trim() || c.nome || formatarNumeroBR(c.telefone||'');
          const av = c.avatar_url
            ? `<span class="avatar"><img src="${c.avatar_url}" onerror="this.onerror=null;this.parentElement.classList.add('avatar-default');this.remove();" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;"></span>`
            : `<span class="avatar avatar-default"><i class="fa fa-user-circle" style="font-size:28px;color:#9aa0a6;"></i></span>`;
          const lastRaw = c.ultima_mensagem || '';
          const lastClean = MARKER_RE.test(lastRaw) ? '' : lastRaw;
          const preview = (lastClean && lastClean.trim()) ? lastClean.trim() : '[mídia]';
          return `<li class="sr-item" data-id="${c.id}" data-q="${encodeURIComponent(query)}"
                style="display:flex;gap:10px;align-items:center;padding:6px;border-radius:8px;cursor:pointer;">
            ${av}
            <div class="sr-text" style="flex:1;min-width:0;">
              <div class="sr-name" style="font-size:13px;color:#e9edef;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(nome||'')}</div>
              <div class="sr-last" style="font-size:12px;color:#aebac1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(preview||'')}</div>
            </div>
            <div class="sr-meta" style="font-size:11px;color:#6b7c85;">${(window.formatChatTime||(()=>''))(c.hora || c.last_ts)||''}</div>
          </li>`;
        }).join('') + `</ul></div>`;
    }

    if (!html) html = `<div class="sr-empty" style="padding:10px 6px;color:#aebac1;font-size:13px;">Nenhum resultado</div>`;
    srRender(html);

    resultsEl.querySelectorAll('.sr-item').forEach(li=>{
      li.addEventListener('click', async ()=>{
        const id = Number(li.dataset.id);
        const q2  = decodeURIComponent(li.dataset.q || query);
        await window.selecionarClienteObj?.(id);
        if (q2){
          _findInRendered._lastIndex=0;
          if (!_findInRendered(q2)) await _loadMoreHistoryUntilMatch(q2);
        }
      });
    });
  }

  // procurar dentro do chat renderizado
  function _allRenderedMsgNodes(){
    return Array.from(hist?.querySelectorAll('.bubble')||[]);
  }
  function _findInRendered(query, from=0){
    const q=_normalize(query); if(!q) return false;
    const nodes=_allRenderedMsgNodes();
    for(let i=Math.max(0,from); i<nodes.length; i++){
      if (_normalize(nodes[i].textContent).includes(q)){
        _focusHit(nodes[i]); _findInRendered._lastIndex=i; return true;
      }
    }
    return false;
  }
  _findInRendered._lastIndex=0;

  function _focusHit(el){
    if (!el) return;
    hist.querySelectorAll('.search-hit')
        .forEach(n => n.classList.remove('search-hit','search-hit-fade'));
    const bubble = el.closest('.bubble') || el;
    bubble.classList.add('search-hit');
    bubble.scrollIntoView({ behavior:'smooth', block:'center' });
    setTimeout(() => bubble.classList.add('search-hit-fade'), 400);
    setTimeout(() => bubble.classList.remove('search-hit','search-hit-fade'), 2400);
  }

  async function _loadMoreHistoryUntilMatch(query, maxPages=8){
    if (!window.clienteSel) return false;
    const id=window.clienteSel.id;
    for (let p=0; p<maxPages; p++){
      const ok = await window.carregarMaisHistorico?.(id);
      if (!ok) return false;
      if (_findInRendered(query)) return true;
    }
    return false;
  }

  function localSearchGlobal(q){
    const query=_normalize(q);
    const contatos = (window.todosContatosCache||[])
      .filter(c=>{
        const nome=_normalize(c.nome||c.push_name||'');
        const tel=_normalize(c.telefone||c.celular||c.numero||'');
        const ult=_normalize(c.ultima_mensagem||'');
        return nome.includes(query)||tel.includes(query)||ult.includes(query);
      })
      .slice(0,80);
    const mensagens=[];
    const ch=window.cacheHistoricos||{};
    Object.entries(ch).forEach(([cid,arr])=>{
      arr?.forEach(m=>{
        if (_normalize(m.conteudo).includes(query)){
          mensagens.push({cliente_id:Number(cid), snippet:m.conteudo, hora:m.timestamp});
        }
      });
    });
    renderSearchPanel({q,contatos,mensagens});
  }

  // input events
  let _deb=null;
  async function onSearchInput(){
    const q=(searchInput?.value||'').trim();
    if (!q){
      srHide();
      window.renderListaClientes?.(window.clientesCache||[]);
      _searchActive=false;
      return;
    }
    srShowLoading();
    clearTimeout(_deb);
    _deb=setTimeout(async()=>{
      try{
        const res = await serverSearch(q,80);
        // complementa com cache local (caso o backend não traga tudo)
        const ids = new Set(res.contatos.map(c=>String(c.id)));
        (window.todosContatosCache||[]).forEach(c=>{
          const nome=_normalize(c.nome||c.push_name||'');
          const tel=_normalize(c.telefone||c.celular||c.numero||'');
          const ult=_normalize(c.ultima_mensagem||'');
          const qn=_normalize(q);
          if (!ids.has(String(c.id)) && (nome.includes(qn)||tel.includes(qn)||ult.includes(qn))){
            res.contatos.push(c);
          }
        });
        srRender('');
        renderSearchPanel({q,contatos:res.contatos, mensagens:res.mensagens});
        _searchActive=true;
      }catch(e){
        console.warn('[search] fallback global local:', e.message||e);
        localSearchGlobal(q); _searchActive=true;
      }
    },200);
  }
  async function onSearchEnter(){
    const q=(searchInput?.value||'').trim();
    if (!q) return;
    if (window.clienteSel){
      _findInRendered._lastIndex=0;
      if (_findInRendered(q)) return;
      await _loadMoreHistoryUntilMatch(q);
      return;
    }
    const qn=_normalize(q);
    const cand=(window.todosContatosCache||[]).find(c=>{
      const nome=_normalize(c.nome||c.push_name||'');
      const tel=_normalize(c.telefone||c.celular||c.numero||'');
      const ult=_normalize(c.ultima_mensagem||'');
      return nome.includes(qn)||tel.includes(qn)||ult.includes(qn);
    });
    if (cand) await window.selecionarClienteObj?.(cand.id);
  }

  if (searchInput){
    searchInput.addEventListener('input', onSearchInput);
    searchInput.addEventListener('keydown', e=>{
      if (e.key==='Enter'){ e.preventDefault(); onSearchEnter(); }
      if (e.key==='Escape'){
        searchInput.value='';
        srHide();
        window.renderListaClientes?.(window.clientesCache||[]);
        _searchActive=false;
      }
    });
  }

  document.addEventListener('keydown', async e=>{
    const key = (e.key || '').toLowerCase();
    if (e.key==='F3' || (key==='g' && (e.ctrlKey||e.metaKey))){
      e.preventDefault();
      const q=searchInput?.value?.trim(); if (!q) return;
      if (_findInRendered(q, (_findInRendered._lastIndex??-1)+1)) return;
      await _loadMoreHistoryUntilMatch(q,1);
    }
  });

  // exporta (se precisar)
  window._findInRendered = _findInRendered;
  window._loadMoreHistoryUntilMatch = _loadMoreHistoryUntilMatch;
})();
