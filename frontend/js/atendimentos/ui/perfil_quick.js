// /frontend/js/atendimentos/ui/perfil_quick.js
// Painel RÁPIDO de perfil (Evolution) — abre só ao clicar no NOME/FOTO do header.
// - Resolve instância de forma robusta (clienteSel > data-instancia-id > INSTANCIA_ATIVA).
// - Evita dados “fantasma” ao trocar de conversa (AbortController + token por cliente).
// - Intercepta no CAPTURE e bloqueia outros handlers (não abre o drawer completo com “bairro”, etc).
// - Atualiza o cache/UI com o que veio do BD após o merge, inclusive avatar/nome.
// - Recarrega avatar automaticamente quando a imagem quebra (403/expirada), com cooldown.

(() => {
  /* --------------- helpers --------------- */
  const $  = (s, r=document)=> r.querySelector(s);
  const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);

  function ensureToast(msg, type='ok'){
    if (window.toast) { window.toast({ title: type==='ok'?'Pronto':'Erro', msg, type: type==='ok'?'ok':'error' }); }
    else { if(type==='ok') console.log('[perfil]', msg); else alert(msg); }
  }
  const onlyDigits = s => String(s||'').replace(/\D+/g,'');
  const getClienteId = () => Number($('#historico')?.dataset?.clienteId || 0);

  function fmtDateTimeISO(s){
    if (!s) return '';
    try{
      const d = new Date(s);
      if (isNaN(d.getTime())) return '';
      const dd = String(d.getDate()).padStart(2,'0');
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const yyyy = d.getFullYear();
      const hh = String(d.getHours()).padStart(2,'0');
      const mi = String(d.getMinutes()).padStart(2,'0');
      return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
    }catch{ return ''; }
  }

  const skeletonHTML = () => `
    <div class="qcHero">
      <div class="avatar qcSkeleton" style="width:64px;height:64px;border-radius:50%"></div>
      <div class="info">
        <div class="qcSk-name qcSkeleton"></div>
        <div class="qcSk-line qcSkeleton" style="width:120px"></div>
      </div>
    </div>
    <div class="qcCard">
      <div class="label">Status</div>
      <div class="content qcSk-line qcSkeleton" style="height:14px;"></div>
    </div>
  `;

  async function getTelefoneAsync(forClienteId){
    const hist = $('#historico');
    const cands = [hist?.dataset?.telefone, hist?.dataset?.phone, hist?.dataset?.number];
    for (const v of cands){ if (v && /\d{10,}/.test(v)) return v; }

    const h = $('#chat-header [data-phone]');
    if (h){ const v = h.getAttribute('data-phone'); if (v) return v; }

    const txt = $('#chat-header')?.textContent || '';
    const m = txt.match(/(\d{10,15})/);
    if (m) return m[1];

    const cid = Number(forClienteId || getClienteId() || 0);
    if (cid && EMPRESA_ID){
      try{
        const r = await fetch(`/api/atendimento/clientes/${cid}/profile?empresa_id=${EMPRESA_ID}`, { credentials:'include' });
        if (r.ok){
          const j = await r.json();
          if (j?.telefone) return j.telefone;
        }
      }catch{}
    }
    return '';
  }

  // ---- resolve instância de forma robusta ----
  function resolveInstForPerfil() {
    const st = window.state || {};
    const sel = st.clienteSel;

    if (sel?.instancia_id) return { instancia_id: Number(sel.instancia_id) };

    const hist = document.getElementById('historico');
    const dataInst = hist?.dataset?.instanciaId || hist?.dataset?.instancia_id;
    if (dataInst && /^\d+$/.test(String(dataInst))) {
      return { instancia_id: Number(dataInst) };
    }

    const g = window.INSTANCIA_ATIVA;
    if (g && /^\d+$/.test(String(g))) return { instancia_id: Number(g) };
    if (g && typeof g === 'object') {
      const id = Number(g.id || g.instancia_id || 0) || undefined;
      const name = g.instance_name || g.name || undefined;
      return { instancia_id: id, instance_name: name };
    }
    return {};
  }

  /* ---- patch UI/cache ---- */
  function updateHeaderAvatar(url){
    const av = document.getElementById('chat-avatar');
    if (!av) return;

    if (url) {
      const cid = getClienteId() || Number(window.state?.clienteSel?.id || 0) || '';
      const safe = String(url).replace(/"/g,'&quot;');
      const cidAttr = cid ? ` data-cliente-id="${cid}"` : '';
      av.innerHTML =
        `<span class="avatar">
           <img src="${safe}" alt=""${cidAttr}
                onerror="window.handleAvatarError && window.handleAvatarError(this)">
         </span>`;
    } else {
      av.innerHTML = `<span class="avatar avatar-default"><i class="fa fa-user-circle text-2xl text-gray-400"></i></span>`;
    }
  }

  function updateHeaderName(name){
    const t = document.getElementById('chat-title');
    if (t && name) t.textContent = name;
  }

  function patchClienteCache(clienteId, patch){
    try{
      const st = window.state || {};
      const lists = [st.clientesCache, st.todosContatosCache];
      lists.forEach(arr => {
        if (!Array.isArray(arr)) return;
        const idx = arr.findIndex(x => (x?.id ?? x?.conversation_id) === Number(clienteId));
        if (idx >= 0) arr[idx] = { ...arr[idx], ...patch };
      });
      if (st.clienteSel && (st.clienteSel.id === Number(clienteId) || st.clienteSel.conversation_id === Number(clienteId))) {
        Object.assign(st.clienteSel, patch);
      }
      if (typeof window.persist === 'function') window.persist();

      if ('avatar_url' in patch) updateHeaderAvatar(patch.avatar_url || '');
      if (patch.nome || patch.nome_whatsapp) updateHeaderName(patch.nome || patch.nome_whatsapp);

      window.syncPreviewFromCache?.(Number(clienteId));
    }catch(e){ console.warn('[perfil_quick] patchClienteCache falhou:', e); }
  }

  async function syncWithDBAndPatchCaches(clienteId, prof){
    if (!clienteId || !EMPRESA_ID) return;
    try{
      const r = await fetch(`/api/atendimento/clientes/${clienteId}/profile?empresa_id=${EMPRESA_ID}`, { credentials:'include' });
      let dbProf = null;
      if (r.ok) dbProf = await r.json();

      const patch = {
        avatar_url: dbProf?.avatar_url ?? (prof.picture || null),
        nome:       dbProf?.nome || undefined,
        nome_whatsapp: dbProf?.nome_whatsapp ?? (prof.name || undefined),
        is_business: (typeof dbProf?.is_business === 'boolean') ? dbProf.is_business : !!prof.isBusiness,
        status_whatsapp: dbProf?.status_text ?? (prof?.status?.status || undefined),
        descricao:  dbProf?.description || undefined,
        website:    dbProf?.website || undefined,
        email:      dbProf?.email || undefined,
      };
      patchClienteCache(clienteId, patch);
    }catch{
      const patch = {
        avatar_url: prof.picture || null,
        nome_whatsapp: prof.name || undefined,
        is_business: !!prof.isBusiness,
        status_whatsapp: prof?.status?.status || undefined,
      };
      patchClienteCache(clienteId, patch);
    }
  }

  /* ---- atualização silenciosa de avatar (403 / expirado) ---- */
  async function refreshAvatarFromEvolution(clienteId){
    if (!clienteId) return;
    try{
      const prof = await fetchEvolutionProfile(clienteId, undefined);
      await syncWithDBAndPatchCaches(clienteId, prof);
    }catch(e){
      console.warn('[perfil_quick] refreshAvatarFromEvolution erro:', e);
    }
  }
  // expõe pro resto do front (lista, header, etc)
  window.refreshAvatarFromEvolution = refreshAvatarFromEvolution;

  /* ---- cooldown leve por cliente/trigger (localStorage) ---- */
  const CD_MS = { list: 30 * 60 * 1000, chat: 10 * 60 * 1000, manual: 0 };
  const cdKey = (clienteId, trigger) =>
    `av_cd:v1:e${EMPRESA_ID}:c${Number(clienteId)}:t${trigger}`;

  function canRunCooldown(clienteId, trigger){
    try{
      const ms = CD_MS[trigger] ?? 0;
      if (ms <= 0) return true;
      const last = Number(localStorage.getItem(cdKey(clienteId, trigger)) || 0);
      return (Date.now() - last) > ms;
    }catch{ return true; }
  }
  function markCooldown(clienteId, trigger){
    try{ localStorage.setItem(cdKey(clienteId, trigger), String(Date.now())); }catch{}
  }

  /* ---- handlers globais para usar no onerror do <img> ---- */
  window.handleListAvatarError = async function onListImgError(imgEl, clienteId){
    try{
      if (imgEl) {
        imgEl.onerror = null;
        imgEl.remove(); // remove a imagem quebrada
        imgEl.parentElement?.classList?.add('placeholder');
      }
      if (!clienteId || !EMPRESA_ID) return;

      // respeita cooldown de lista
      if (!canRunCooldown(clienteId, 'list')) return;
      markCooldown(clienteId, 'list');

      await refreshAvatarFromEvolution(Number(clienteId));
    }catch(e){ /* silencioso */ }
  };

  window.handleAvatarError = async function onHeaderImgError(imgEl){
    try{
      if (imgEl) {
        imgEl.onerror = null;
        imgEl.remove();
        imgEl.parentElement?.classList?.add('avatar-default');
      }

      const cidFromAttr = Number(imgEl?.getAttribute('data-cliente-id') || 0);
      const clienteId =
        cidFromAttr ||
        Number(window.state?.clienteSel?.id || window.state?.clienteSel?.conversation_id || 0);

      if (!clienteId || !EMPRESA_ID) return;

      // cooldown menor ao entrar no chat
      if (!canRunCooldown(clienteId, 'chat')) return;
      markCooldown(clienteId, 'chat');

      await refreshAvatarFromEvolution(Number(clienteId));
    }catch(e){ /* silencioso */ }
  };

  /* --------------- CSS --------------- */
  (function injectCSS(){
    if (document.getElementById('qcPerfil-style')) return;
    const st = document.createElement('style');
    st.id = 'qcPerfil-style';
    st.textContent = `
      .qcBackdrop{ position:fixed; inset:0; background:rgba(0,0,0,.42);
        opacity:0; pointer-events:none; transition:opacity .18s; z-index:9998; }
      .qcBackdrop.is-open{ opacity:1; pointer-events:auto; }

      .qcDrawer{
        position:fixed; top:0; right:0; height:100vh; width:min(420px,94vw);
        background:var(--panel-2,#1f2c33); color:var(--text,#e9edef);
        border-left:1px solid var(--border,#26343a);
        transform:translateX(100%); transition:transform .18s ease; z-index:9999;
        display:flex; flex-direction:column; overflow:hidden; pointer-events:none;
      }
      .qcDrawer.is-open{ transform:translateX(0); pointer-events:auto; }

      .qcHead{ display:flex; align-items:center; justify-content:space-between;
        padding:12px 14px; border-bottom:1px solid var(--border,#26343a); }
      .qcTitle{ font-weight:600; font-size:16px; }
      .qcClose{ background:transparent; border:0; color:#aebac1; cursor:pointer; padding:6px; border-radius:8px; }
      .qcClose:hover{ color:#fff; background:#233238; }

      .qcBody{ padding:14px; display:flex; flex-direction:column; gap:14px; overflow:auto; }

      .qcHero{ display:flex; gap:12px; align-items:center; }
      .qcHero .avatar{ width:64px; height:64px; border-radius:50%; object-fit:cover; background:#0b141a; border:1px solid var(--border,#2a3942); }
      .qcHero .info{ display:flex; flex-direction:column; gap:4px; min-width:0; }
      .qcName{ font-size:16px; font-weight:700; }
      .qcPhone{ font-size:12px; color:#9aa7ad; word-break:break-all; }
      .qcBadge{ display:inline-flex; gap:6px; align-items:center; font-size:12px;
        border:1px solid #2a3942; border-radius:999px; padding:3px 8px; color:#9aa7ad; }
      html[data-theme="light"] .qcBadge{ border-color:#dadde0; color:#4b5563; }

      .qcCard{ border:1px solid var(--border,#2a3942); border-radius:12px; padding:10px 12px; background:var(--panel-1,#0b141a); }
      html[data-theme="light"] .qcCard{ background:#fff; border-color:#dadde0; }
      .qcCard .label{ font-size:12px; color:#9aa7ad; margin-bottom:6px; }
      .qcCard .content{ font-size:13.5px; line-height:1.35; white-space:pre-wrap; word-break:break-word; }

      .qcRow{ display:flex; gap:10px; align-items:center; justify-content:space-between; }
      .qcLink{ color:var(--accent,#25d366); text-decoration:none; font-weight:600; }
      .qcLink:hover{ text-decoration:underline; }

      .qcSkeleton{ background:linear-gradient(90deg, rgba(255,255,255,.06), rgba(255,255,255,.14), rgba(255,255,255,.06));
        background-size: 200% 100%; animation: qc-shimmer 1.2s infinite; border-radius:8px; }
      .qcSk-name{ height:16px; width:180px; }
      .qcSk-line{ height:12px; width:80%; }
      @keyframes qc-shimmer{ 0%{background-position:200% 0} 100%{background-position:-200% 0} }
    `;
    document.head.appendChild(st);
  })();

  /* --------------- UI --------------- */
  function buildDrawer(){
    if (document.getElementById('qcBackdrop')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'qcBackdrop';
    backdrop.className = 'qcBackdrop';

    const drawer = document.createElement('aside');
    drawer.id = 'qcDrawer';
    drawer.className = 'qcDrawer';
    drawer.setAttribute('role','dialog'); drawer.setAttribute('aria-modal','true');

    drawer.innerHTML = `
      <div class="qcHead">
        <div class="qcTitle">Perfil do WhatsApp</div>
        <button class="qcClose" id="qcClose" title="Fechar" aria-label="Fechar">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 256 256"><path fill="currentColor" d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66A8 8 0 0 1 61.66 50.34L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128z"/></svg>
        </button>
      </div>
      <div class="qcBody" id="qcBody">${skeletonHTML()}</div>
    `;

    document.body.append(backdrop, drawer);

    const close = ()=>{ backdrop.classList.remove('is-open'); drawer.classList.remove('is-open'); };
    document.getElementById('qcClose')?.addEventListener('click', close);
    backdrop.addEventListener('click', e=>{ if(e.target===backdrop) close(); });
    document.addEventListener('keydown', e=>{ if(e.key==='Escape') close(); });

    window.__qcPerfil = {
      open: ()=>{ backdrop.classList.add('is-open'); drawer.classList.add('is-open'); },
      close,
      setBody(html){ const b=$('#qcBody'); if(b){ b.innerHTML = html; } },
      isOpen: ()=> document.getElementById('qcDrawer')?.classList.contains('is-open'),
      setSkeleton: ()=>{ const b=$('#qcBody'); if(b){ b.innerHTML = skeletonHTML(); } }
    };
  }

  function renderProfile(p){
    const name = (p.name || '').trim();
    const isBiz = !!p.isBusiness;
    const statusTxt = (p.status && p.status.status) ? String(p.status.status) : '';
    const statusAt  = (p.status && p.status.setAt)  ? fmtDateTimeISO(p.status.setAt) : '';
    const pic = p.picture || '';
       const desc = (p.description || '').trim();
    const site = (p.website || '').trim();
    const phoneShown = ($('#historico')?.dataset?.telefone) || (p.wuid || '').replace('@s.whatsapp.net','');

    return `
      <div class="qcHero">
        <img class="avatar" alt="" src="${pic || ''}" onerror="this.style.visibility='hidden'">
        <div class="info">
          <div class="qcName">${name || '—'}</div>
          <div class="qcPhone">${phoneShown || '—'}</div>
          ${isBiz ? `<div class="qcBadge" title="Conta comercial">Conta comercial</div>` : ``}
        </div>
      </div>

      <div class="qcCard">
        <div class="label">Status</div>
        <div class="content">${statusTxt ? statusTxt : '—'}</div>
        ${statusAt ? `<div class="label" style="margin-top:6px">Atualizado em</div><div class="content">${statusAt}</div>` : ``}
      </div>

      ${(isBiz || desc || site || p.email) ? `
        <div class="qcCard">
          <div class="label">Informações públicas</div>
          ${desc ? `<div class="content" style="margin-bottom:8px">${desc}</div>` : ``}
          ${site ? `<div class="qcRow"><span class="label">Website</span><a class="qcLink" href="${site}" target="_blank" rel="noopener">Abrir</a></div>` : ``}
          ${p.email ? `<div class="qcRow"><span class="label">E-mail</span><a class="qcLink" href="mailto:${p.email}">Enviar</a></div>` : ``}
        </div>
      ` : ``}
    `;
  }

  // ===== Request guard =====
  let currentReq = { ctrl: null, token: null };

  async function fetchEvolutionProfile(clienteId, signal){
    const number = await getTelefoneAsync(clienteId);
    if (!number){ throw new Error('Telefone do cliente não encontrado na tela.'); }

    const instInfo = resolveInstForPerfil();

    const body = {
      number: onlyDigits(number),
      empresa_id: EMPRESA_ID || undefined,
      instancia_id: instInfo.instancia_id ?? undefined,
      instance: instInfo.instance_name ?? undefined,
    };

    const r = await fetch('/api/evolution/fetchProfile', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      credentials:'include',
      body: JSON.stringify(body),
      signal
    });

    if (!r.ok){
      let raw = '';
      try { raw = await r.text(); } catch {}
      let detail = raw;
      try { const j = JSON.parse(raw); detail = j?.detail || j?.message || raw; } catch {}
      if (/Connection Closed|evolution.*(502|503)/i.test(String(detail))) {
        throw new Error('Instância do WhatsApp desconectada ou Evolution indisponível.');
      }
      throw new Error(`Falha ao buscar perfil: ${detail || (r.status+' '+r.statusText)}`);
    }
    return r.json();
  }

  async function startFetch(clienteId){
    try { currentReq.ctrl?.abort(); } catch {}
    const ctrl = new AbortController();
    const token = { clienteId: Number(clienteId), openedAt: Date.now() };
    currentReq = { ctrl, token };

    try{
      const prof = await fetchEvolutionProfile(clienteId, ctrl.signal);
      if (!currentReq.token || currentReq.token.clienteId !== Number(clienteId)) return;
      if (!window.__qcPerfil?.isOpen?.()) return;

      await syncWithDBAndPatchCaches(clienteId, prof);
      if (!currentReq.token || currentReq.token.clienteId !== Number(clienteId)) return;

      window.__qcPerfil.setBody( renderProfile(prof) );
    }catch(err){
      if (err?.name === 'AbortError') return;
      console.error('[perfil_quick] erro', err);
      if (window.__qcPerfil?.isOpen?.()) {
        window.__qcPerfil.setBody(`<div class="qcCard"><div class="content">Não foi possível carregar o perfil.<br><small>${String(err.message||err)}</small></div></div>`);
        ensureToast('Não foi possível carregar o perfil do WhatsApp.', 'error');
      }
    }
  }

  async function abrirPerfilRapido(){
    buildDrawer();
    window.__qcPerfil.open();
    window.__qcPerfil.setSkeleton();

    const cid = getClienteId();
    if (!cid){
      window.__qcPerfil.setBody(`<div class="qcCard"><div class="content">Não foi possível carregar o perfil.<br><small>Cliente não selecionado.</small></div></div>`);
      return;
    }
    await startFetch(cid);
  }
  window.abrirPerfilRapido = abrirPerfilRapido;

  /* --------------- Clique permitido APENAS em nome/foto --------------- */
  const BLOCK_OPEN_SELECTOR = [
    '.btn-note', '.btn-notes', '[data-action="notes"]',
    '.btn-gpt', '.btn-ai', '[data-action="ai"]',
    '.btn', 'button', 'a[href]', '[role="button"]',
    '[data-no-profile="1"]'
  ].join(',');

  const OPEN_TARGET_SELECTOR = [
    '#chat-title',
    '#chat-avatar',
    '#chat-avatar .avatar',
    '#chat-avatar img',
    '[data-role="contact-name"]',
    '[data-role="contact-avatar"]'
  ].join(',');

  function attachHeaderHook(){
    const hdr = document.getElementById('chat-header');
    if (!hdr || hdr.dataset.qcBound === '1') return;
    hdr.dataset.qcBound = '1';

    // CAPTURE FIRST: intercepta antes e bloqueia o drawer completo
    hdr.addEventListener('click', (e) => {
      const t = e.target;
      if (!t) return;

      if (t.closest(BLOCK_OPEN_SELECTOR)) return;

      const openFrom = t.closest(OPEN_TARGET_SELECTOR);
      if (!openFrom) return;

      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      e.preventDefault();
      e.stopImmediatePropagation?.();
      e.stopPropagation();

      abrirPerfilRapido();
    }, { capture:true, passive:false });

    // Bubble como fallback — abre só se nada bloqueou
    hdr.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || t.closest(BLOCK_OPEN_SELECTOR)) return;
      if (!t.closest(OPEN_TARGET_SELECTOR)) return;
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      abrirPerfilRapido();
    }, { passive:false });
  }

  (function watchHeader(){
    const hdrEl = document.getElementById('chat-header');
    if (hdrEl){
      const mo = new MutationObserver(() => attachHeaderHook());
      mo.observe(hdrEl, { childList:true, subtree:true });
    }
    attachHeaderHook();
  })();

  // --------------- Atualiza se trocar de conversa com o drawer aberto ---------------
  (function watchHistoricoCliente(){
    const hist = document.getElementById('historico');
    if (!hist) return;
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'data-cliente-id') {
          if (window.__qcPerfil?.isOpen?.()) {
            window.__qcPerfil.setSkeleton();
            const newCid = Number(hist.dataset.clienteId || 0);
            if (newCid) startFetch(newCid);
            else currentReq.ctrl?.abort();
          } else {
            currentReq.ctrl?.abort();
          }
        }
      }
    });
    mo.observe(hist, { attributes:true, attributeFilter:['data-cliente-id'] });
  })();
})();
