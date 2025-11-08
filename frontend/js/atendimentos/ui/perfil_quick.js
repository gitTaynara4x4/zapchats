// /frontend/js/atendimentos/ui/perfil_quick.js
// Painel RÁPIDO de perfil — abre só ao clicar no NOME/FOTO do header.
// *** AJUSTE: NOME vem SOMENTE do BD (sem Evolution) ***
// - Ao abrir, chama /api/atendimento/clientes/:id/profile?empresa_id=... (apenas BD)
// - Atualiza APENAS o nome no cache e no header (não mexe no avatar do header/lista).
// - Mantém o fluxo existente de avatar (refresh via Evolution onerror), com guards p/ não gerar 400.
// - Evita dados “fantasma” ao trocar de conversa (AbortController + token por cliente).

(() => {
  /* --------------- helpers --------------- */
  const $  = (s, r=document)=> r.querySelector(s);
  const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);

  function ensureToast(msg, type='ok'){
    if (window.toast) { window.toast({ title: type==='ok'?'Pronto':'Erro', msg, type: type==='ok'?'ok':'error' }); }
    else { if(type==='ok') console.log('[perfil]', msg); else console.error(msg); }
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

  // **NOVO**: instância segura (reusa lógica da Agenda)
  function getInstanciaAtivaSafe(){
    const sel = (window.state?.clienteSel) || null;
    const inst = sel?.instancia_id ?? sel?.instancia ?? window.INSTANCIA_ATIVA ?? null;
    if (inst == null || inst === '') return { instancia_id: undefined, instance: undefined };
    if (typeof inst === 'object') {
      const iid = Number(inst.id || inst.instancia_id || 0) || undefined;
      const name = inst.instance_name || inst.name || undefined;
      return { instancia_id: iid, instance: name };
    }
    const iid = /^\d+$/.test(String(inst)) ? Number(inst) : undefined;
    return { instancia_id: iid, instance: undefined };
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

  // tenta extrair telefone do DOM; se tiver clienteId, consulta BD como fallback
  async function getTelefoneAsync(forClienteId){
    const hist = $('#historico');
    const cands = [hist?.dataset?.telefone, hist?.dataset?.phone, hist?.dataset?.number];
    for (const v of cands){ if (v && /\d{10,}/.test(v)) return v; }

    const h = $('#chat-header [data-phone]');
    if (h){ const v = h.getAttribute('data-phone'); if (v) return v; }

    const txt = $('#chat-header')?.textContent || '';
    const m = txt.match(/(\d{10,15})/);
    if (m) return m[1];

    // Prioriza o parâmetro recebido (Agenda chama com id do item)
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

  /* ---- SOMENTE NOME do BD: patch no cache + header ---- */
  function updateHeaderNameFromBD(patch){
    const t = document.getElementById('chat-title');
    if (!t) return;
    const display =
      (patch?.nome_whatsapp && String(patch.nome_whatsapp).trim()) ? String(patch.nome_whatsapp).trim()
      : (patch?.nome && String(patch.nome).trim()) ? String(patch.nome).trim()
      : '';
    if (display) t.textContent = display;
  }

  function patchClienteCacheNameOnly(clienteId, bd){
    try{
      const st = window.state || {};
      const patch = {
        // ❗ NÃO tocar em avatar_url aqui
        nome: (bd?.nome ?? undefined),
        nome_whatsapp: (bd?.nome_whatsapp ?? undefined),
        // extras (não alteram header/fluxo)
        is_business: (typeof bd?.is_business === 'boolean') ? bd.is_business : undefined,
        status_whatsapp: bd?.status_text ?? undefined,
        descricao:  bd?.description ?? undefined,
        website:    bd?.website ?? undefined,
        email:      bd?.email ?? undefined,
      };

      const lists = [st.clientesCache, st.todosContatosCache];
      lists.forEach(arr => {
        if (!Array.isArray(arr)) return;
        const idx = arr.findIndex(x => (x?.id ?? x?.conversation_id) === Number(clienteId));
        if (idx >= 0) arr[idx] = { ...arr[idx], ...patch };
      });

      if (st.clienteSel && (Number(st.clienteSel.id ?? st.clienteSel.conversation_id) === Number(clienteId))) {
        Object.assign(st.clienteSel, patch);
      }

      // ✅ só NOME no header
      updateHeaderNameFromBD(patch);

      if (typeof window.persist === 'function') window.persist();
      try { window.renderListaClientes?.(st.clientesCache || []); } catch {}
      try { window.syncPreviewFromCache?.(Number(clienteId)); } catch {}
    }catch(e){ console.warn('[perfil_quick] patchClienteCacheNameOnly falhou:', e); }
  }

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

  /* --------------- UI (drawer) --------------- */
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

  // Painel renderizado com CAMPOS DO BD (nome/status/etc). A foto exibida aqui é a do BD,
  // mas isso é visual do painel — não altera o avatar do header/lista.
  function renderProfileFromBD(bd){
    const name = (bd?.nome_whatsapp || bd?.nome || '').trim();
    const isBiz = !!bd?.is_business;
    const statusTxt = (bd?.status_text || '').trim();
    const statusAt  = bd?.status_at ? fmtDateTimeISO(bd.status_at) : '';
    const pic = bd?.avatar_url || '';
    const desc = (bd?.description || bd?.descricao || '').trim();
    const site = (bd?.website || '').trim();
    const phoneShown = ($('#historico')?.dataset?.telefone) || '';

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

      ${(isBiz || desc || site || bd?.email) ? `
        <div class="qcCard">
          <div class="label">Informações públicas</div>
          ${desc ? `<div class="content" style="margin-bottom:8px">${desc}</div>` : ``}
          ${site ? `<div class="qcRow"><span class="label">Website</span><a class="qcLink" href="${site}" target="_blank" rel="noopener">Abrir</a></div>` : ``}
          ${bd?.email ? `<div class="qcRow"><span class="label">E-mail</span><a class="qcLink" href="mailto:${bd.email}">Enviar</a></div>` : ``}
        </div>
      ` : ``}
    `;
  }

  // ===== Request guard =====
  let currentReq = { ctrl: null, token: null };

  // >>> BUSCA APENAS NO BD
  async function fetchBDProfile(clienteId, signal){
    if (!clienteId || !EMPRESA_ID) throw new Error('Cliente/empresa inválidos.');
    const r = await fetch(`/api/atendimento/clientes/${clienteId}/profile?empresa_id=${EMPRESA_ID}`, {
      credentials:'include',
      signal
    });
    if (!r.ok){
      let raw = '';
      try { raw = await r.text(); } catch {}
      let detail = raw;
      try { const j = JSON.parse(raw); detail = j?.detail || j?.message || raw; } catch {}
      throw new Error(`Falha ao buscar perfil no BD: ${detail || (r.status+' '+r.statusText)}`);
    }
    return r.json();
  }

  async function startFetch(clienteId){
    try { currentReq.ctrl?.abort(); } catch {}
    const ctrl = new AbortController();
    const token = { clienteId: Number(clienteId), openedAt: Date.now() };
    currentReq = { ctrl, token };

    try{
      const bd = await fetchBDProfile(clienteId, ctrl.signal);
      if (!currentReq.token || currentReq.token.clienteId !== Number(clienteId)) return;
      if (!window.__qcPerfil?.isOpen?.()) return;

      // ✅ merge só do NOME no cache + header (sem tocar avatar)
      patchClienteCacheNameOnly(clienteId, bd);
      if (!currentReq.token || currentReq.token.clienteId !== Number(clienteId)) return;

      // painel mostra o que está no BD
      window.__qcPerfil.setBody( renderProfileFromBD(bd) );
    }catch(err){
      if (err?.name === 'AbortError') return;
      console.error('[perfil_quick] erro', err);
      if (window.__qcPerfil?.isOpen?.()) {
        window.__qcPerfil.setBody(`<div class="qcCard"><div class="content">Não foi possível carregar o perfil.<br><small>${String(err.message||err)}</small></div></div>`);
        ensureToast('Não foi possível carregar o perfil.', 'error');
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

    // CAPTURE FIRST
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

    // Fallback bubble
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

  /* =========================
     ⚠️ AVATAR (com guards)
     ========================= */
  // ---- cooldown leve por cliente/trigger (localStorage) ----
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

  async function refreshAvatarFromEvolution(clienteId){
    try{
      const number = await getTelefoneAsync(clienteId);
      if (!number) return; // sem telefone não tenta Evolution

      // **NOVO**: pega instância de forma segura
      const inst = getInstanciaAtivaSafe();
      // sem instancia_id nem nome → não chama (evita 400)
      if (!inst.instancia_id && !inst.instance) return;

      const body = {
        number: onlyDigits(number),
        empresa_id: EMPRESA_ID || undefined,
        instancia_id: inst.instancia_id ?? undefined,
        instance: inst.instance ?? undefined,
      };

      const r = await fetch('/api/evolution/fetchProfile', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify(body),
      });
      if (!r.ok) return;
      const prof = await r.json();

      // 🔄 Atualiza avatar no cache/header/lista
      try{
        const st2 = window.state || {};
        const lists = [st2.clientesCache, st2.todosContatosCache];
        const patch = { avatar_url: prof.picture || null };
        lists.forEach(arr => {
          if (!Array.isArray(arr)) return;
          const idx = arr.findIndex(x => (x?.id ?? x?.conversation_id) === Number(clienteId));
          if (idx >= 0) arr[idx] = { ...arr[idx], ...patch };
        });
        if (st2.clienteSel && (Number(st2.clienteSel.id ?? st2.clienteSel.conversation_id) === Number(clienteId))) {
          Object.assign(st2.clienteSel, patch);
        }
        if (typeof window.persist === 'function') window.persist();

        // atualiza header avatar (se tiver aberto)
        const av = document.getElementById('chat-avatar');
        if (av && patch.avatar_url){
          const safe = String(patch.avatar_url).replace(/"/g,'&quot;');
          av.innerHTML =
            `<span class="avatar">
               <img src="${safe}" alt="" data-cliente-id="${clienteId}"
                    onerror="window.handleAvatarError && window.handleAvatarError(this)">
             </span>`;
        }

        try { window.renderListaClientes?.(st2.clientesCache || []); } catch {}
      }catch{}
    }catch{}
  }
  window.refreshAvatarFromEvolution = refreshAvatarFromEvolution;

  // handlers globais já esperados pela lista/header
  window.handleListAvatarError = async function onListImgError(imgEl, clienteId){
    try{
      if (imgEl) {
        imgEl.onerror = null;
        imgEl.remove();
        imgEl.parentElement?.classList?.add('placeholder');
      }
      if (!clienteId || !EMPRESA_ID) return;

      if (!canRunCooldown(clienteId, 'list')) return;
      markCooldown(clienteId, 'list');

      await refreshAvatarFromEvolution(Number(clienteId));
    }catch{}
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

      if (!canRunCooldown(clienteId, 'chat')) return;
      markCooldown(clienteId, 'chat');

      await refreshAvatarFromEvolution(Number(clienteId));
    }catch{}
  };
})();
