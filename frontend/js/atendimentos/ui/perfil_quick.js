// /frontend/js/atendimentos/ui/perfil_quick.js
// Painel RÁPIDO de perfil — abre só ao clicar no NOME/FOTO do header.
// *** AJUSTE: NOME vem SOMENTE do BD (sem Evolution) ***
// - Ao abrir, chama /api/atendimento/clientes/:id/profile?empresa_id=... (apenas BD)
// - Atualiza APENAS o nome no cache e no header (não mexe no avatar do header/lista).
// - ✅ NOVO: avatar NÃO faz refresh no onerror. Falhou => ícone.
// - ✅ NOVO: refreshAvatarFromEvolution agora é "manual/diário", aceitando instância/numero via opt.
// - ✅ NOVO: helpers para aplicar avatar no DOM (lista/header) sem re-render pesado.

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

  // instância segura (reusa lógica da Agenda)
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
    return { instancia_id: iid, instance: /^\d+$/.test(String(inst)) ? undefined : String(inst) };
  }

  function resolveInstOpt(raw){
    try{
      if (raw == null) return { instancia_id: undefined, instance: undefined };
      if (typeof raw === 'object') {
        const iid = Number(raw.id || raw.instancia_id || raw.instance_id || 0) || undefined;
        const name = raw.instance_name || raw.name || raw.instancia || raw.instance || undefined;
        return { instancia_id: iid, instance: name };
      }
      const s = String(raw).trim();
      if (!s) return { instancia_id: undefined, instance: undefined };
      if (/^\d+$/.test(s)) return { instancia_id: Number(s), instance: undefined };
      return { instancia_id: undefined, instance: s };
    }catch{
      return { instancia_id: undefined, instance: undefined };
    }
  }

  const skeletonHTML = () => `
    <div class="qcHero">
      <div class="avatar qcSkeleton"></div>
      <div class="info">
        <div class="qcSk-name qcSkeleton"></div>
        <div class="qcSk-line qcSk-line--120 qcSkeleton"></div>
      </div>
    </div>
    <div class="qcCard">
      <div class="label">Status</div>
      <div class="content qcSk-line qcSkeleton"></div>
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
        nome: (bd?.nome ?? undefined),
        nome_whatsapp: (bd?.nome_whatsapp ?? undefined),
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

      updateHeaderNameFromBD(patch);

      if (typeof window.persist === 'function') window.persist();
      try { window.renderListaClientes?.(st.clientesCache || []); } catch {}
      try { window.syncPreviewFromCache?.(Number(clienteId)); } catch {}
    }catch(e){ console.warn('[perfil_quick] patchClienteCacheNameOnly falhou:', e); }
  }

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

  function wireDrawerAvatarFallback(){
    try{
      const drawer = document.getElementById('qcDrawer');
      if (!drawer) return;
      const img = drawer.querySelector('.qcAvatarImg');
      if (!img) return;

      img.addEventListener('error', () => {
        try{
          const parent = img.parentElement;
          img.remove();

          const span = document.createElement('span');
          span.className = 'avatar qcAvatarFallback';
          span.innerHTML = '<i class="fa fa-user-circle"></i>';

          if (parent) parent.insertBefore(span, parent.firstChild);
        }catch{}
      }, { once:true });
    }catch{}
  }

  function renderProfileFromBD(bd){
    const name = (bd?.nome_whatsapp || bd?.nome || '').trim();
    const isBiz = !!bd?.is_business;
    const statusTxt = (bd?.status_text || '').trim();
    const statusAt  = bd?.status_at ? fmtDateTimeISO(bd.status_at) : '';
    const pic = (bd?.avatar_url || '').trim();
    const desc = (bd?.description || bd?.descricao || '').trim();
    const site = (bd?.website || '').trim();
    const phoneShown = ($('#historico')?.dataset?.telefone) || '';

    const avatarHTML = pic
      ? `<img class="avatar qcAvatarImg" alt="" src="${pic}">`
      : `<span class="avatar qcAvatarFallback" aria-hidden="true"><i class="fa fa-user-circle"></i></span>`;

    return `
      <div class="qcHero">
        ${avatarHTML}
        <div class="info">
          <div class="qcName">${name || '—'}</div>
          <div class="qcPhone">${phoneShown || '—'}</div>
          ${isBiz ? `<div class="qcBadge" title="Conta comercial">Conta comercial</div>` : ``}
        </div>
      </div>

      <div class="qcCard">
        <div class="label">Status</div>
        <div class="content">${statusTxt ? statusTxt : '—'}</div>
        ${statusAt ? `<div class="label qcLabel--mt6">Atualizado em</div><div class="content">${statusAt}</div>` : ``}
      </div>

      ${(isBiz || desc || site || bd?.email) ? `
        <div class="qcCard">
          <div class="label">Informações públicas</div>
          ${desc ? `<div class="content qcContent--mb8">${desc}</div>` : ``}
          ${site ? `<div class="qcRow"><span class="label">Website</span><a class="qcLink" href="${site}" target="_blank" rel="noopener">Abrir</a></div>` : ``}
          ${bd?.email ? `<div class="qcRow"><span class="label">E-mail</span><a class="qcLink" href="mailto:${bd.email}">Enviar</a></div>` : ``}
        </div>
      ` : ``}
    `;
  }

  // ===== Request guard =====
  let currentReq = { ctrl: null, token: null };

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

      patchClienteCacheNameOnly(clienteId, bd);
      if (!currentReq.token || currentReq.token.clienteId !== Number(clienteId)) return;

      window.__qcPerfil.setBody( renderProfileFromBD(bd) );
      wireDrawerAvatarFallback();
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
     ✅ AVATAR: placeholder SEM refresh no onerror
     ========================= */
  function ensureAvatarPlaceholder(span, mode='list'){
    try{
      if (!span) return;
      span.classList.add(mode === 'header' ? 'avatar-default' : 'placeholder');
      span.innerHTML = '<i class="fa fa-user-circle"></i>';
    }catch{}
  }

  // ✅ handler do LISTA: só placeholder
  window.handleListAvatarError = function onListImgError(imgEl, clienteId){
    try{
      if (!imgEl) return;
      try { imgEl.onerror = null; } catch {}
      const span = imgEl.closest?.('.avatar') || imgEl.parentElement;
      try { imgEl.remove(); } catch {}
      ensureAvatarPlaceholder(span, 'list');
    }catch{}
  };

  // ✅ handler do HEADER: só placeholder
  window.handleAvatarError = function onHeaderImgError(imgEl){
    try{
      if (!imgEl) return;
      try { imgEl.onerror = null; } catch {}
      const span = imgEl.closest?.('.avatar') || imgEl.parentElement;
      try { imgEl.remove(); } catch {}
      ensureAvatarPlaceholder(span, 'header');
    }catch{}
  };

  function applyAvatarToListDOM(clienteId, url){
    try{
      const li = document.querySelector(`li.chat-item[data-id="${Number(clienteId)}"], li.cliente-item[data-id="${Number(clienteId)}"], #chat-${Number(clienteId)}`);
      const span = li?.querySelector?.('.avatar');
      if (!span) return;

      if (!url) { ensureAvatarPlaceholder(span, 'list'); return; }

      span.classList.remove('placeholder');
      span.innerHTML = '';
      const img = document.createElement('img');
      img.alt = '';
      img.src = String(url);
      img.dataset.clienteId = String(clienteId);
      img.addEventListener('error', () => { try { window.handleListAvatarError?.(img, clienteId); } catch {} }, { once:true });
      span.appendChild(img);
    }catch{}
  }

  function applyAvatarToHeaderDOM(clienteId, url){
    try{
      const st = window.state || {};
      const curId = Number(st?.clienteSel?.id ?? st?.clienteSel?.conversation_id ?? 0);
      if (curId !== Number(clienteId)) return;

      const box = document.getElementById('chat-avatar');
      if (!box) return;

      if (!url) {
        box.innerHTML = `<span class="avatar avatar-default"><i class="fa fa-user-circle"></i></span>`;
        return;
      }

      const span = document.createElement('span');
      span.className = 'avatar';
      const img = document.createElement('img');
      img.alt = '';
      img.src = String(url);
      img.dataset.clienteId = String(clienteId);
      img.addEventListener('error', () => { try { window.handleAvatarError?.(img); } catch {} }, { once:true });
      span.appendChild(img);
      box.innerHTML = '';
      box.appendChild(span);
    }catch{}
  }

  // ✅ Refresh via Evolution (usado pelo "diário" / manual)
  async function refreshAvatarFromEvolution(clienteId, opt = {}){
    try{
      const cid = Number(clienteId || 0);
      if (!cid || !EMPRESA_ID) return null;

      // número: preferir opt.number, senão buscar
      const numRaw = opt?.number ? String(opt.number) : await getTelefoneAsync(cid);
      const number = onlyDigits(numRaw);
      if (!number || number.length < 10) return null;

      // instância: preferir opt (do cliente), senão ativa
      let instOpt = { instancia_id: opt?.instancia_id, instance: opt?.instance };
      if (!instOpt.instancia_id && !instOpt.instance && opt?.instancia_raw != null) {
        instOpt = resolveInstOpt(opt.instancia_raw);
      }
      if (!instOpt.instancia_id && !instOpt.instance) {
        instOpt = getInstanciaAtivaSafe();
      }
      if (!instOpt.instancia_id && !instOpt.instance) return null; // evita 400

      const body = {
        number,
        empresa_id: EMPRESA_ID || undefined,
        instancia_id: instOpt.instancia_id ?? undefined,
        instance: instOpt.instance ?? undefined,
      };

      const r = await fetch('/api/evolution/fetchProfile', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify(body),
      });
      if (!r.ok) return null;

      const prof = await r.json().catch(()=>null);
      const pic = (prof?.picture && String(prof.picture).trim() && !/^(null|undefined)$/i.test(String(prof.picture).trim()))
        ? String(prof.picture).trim()
        : null;

      if (!pic) return null;

      // patch no cache
      try{
        const st2 = window.state || {};
        const lists = [st2.clientesCache, st2.todosContatosCache];
        const patch = { avatar_url: pic };

        lists.forEach(arr => {
          if (!Array.isArray(arr)) return;
          const idx = arr.findIndex(x => (x?.id ?? x?.conversation_id) === cid);
          if (idx >= 0) arr[idx] = { ...arr[idx], ...patch };
        });

        if (st2.clienteSel && (Number(st2.clienteSel.id ?? st2.clienteSel.conversation_id) === cid)) {
          Object.assign(st2.clienteSel, patch);
        }

        if (typeof window.persist === 'function') window.persist();
      }catch{}

      // aplica no DOM (sem re-render pesado)
      applyAvatarToListDOM(cid, pic);
      applyAvatarToHeaderDOM(cid, pic);

      return { picture: pic, profile: prof || null };
    }catch{
      return null;
    }
  }
  window.refreshAvatarFromEvolution = refreshAvatarFromEvolution;

})();
