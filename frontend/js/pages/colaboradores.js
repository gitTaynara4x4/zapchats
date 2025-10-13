// /frontend/js/pages/colaboradores.js
// Colaboradores – lista + modal de perfil (visualização/edição) e fluxo de criação
(function ColaboradoresPage(){
  'use strict';

  // ====== Helpers ======
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];

  const LS = localStorage;
  const EMPRESA_ID = Number(LS.getItem('empresa_id') || '') || null;

  // fetch autenticado (usa ZAuth se tiver)
  const authFetch = (url, opt={}) => {
    const f = (window.ZAuth && ZAuth.authFetch) ? ZAuth.authFetch : fetch;
    const headers = Object.assign(
      { 'Accept':'application/json' },
      opt.headers || {},
      EMPRESA_ID ? { 'X-Empresa-Id': String(EMPRESA_ID) } : {}
    );
    return f(url, { credentials:'include', ...opt, headers });
  };
  const withEmpresa = (url) => {
    try {
      const u = new URL(url, location.origin);
      if (EMPRESA_ID && !u.searchParams.has('empresa_id')) u.searchParams.set('empresa_id', EMPRESA_ID);
      return u.toString();
    } catch {
      const sep = url.includes('?') ? '&' : '?';
      return EMPRESA_ID && !/(\?|&)empresa_id=/.test(url) ? url + sep + 'empresa_id=' + EMPRESA_ID : url;
    }
  };
  async function parseMaybeJSON(res){
    const txt = await res.text().catch(()=> '');
    try { return txt ? JSON.parse(txt) : null; } catch { return txt || null; }
  }
  function throwHTTP(res, data){
    const err = new Error((data && (data.detail||data.message)) || res.statusText || 'Erro');
    err.status = res.status; err.data = data; throw err;
  }
  async function apiGet(path){
    const r = await authFetch(withEmpresa(path));
    const data = await parseMaybeJSON(r);
    if (!r.ok) throwHTTP(r,data);
    return data;
  }
  async function apiJSON(path, method, body){
    const r = await authFetch(withEmpresa(path), {
      method,
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(body)
    });
    const data = await parseMaybeJSON(r);
    if (!r.ok) throwHTTP(r,data);
    return data;
  }
  async function apiForm(path, method, fd){
    const r = await authFetch(withEmpresa(path), { method, body: fd });
    const data = await parseMaybeJSON(r);
    if (!r.ok) throwHTTP(r,data);
    return data;
  }
  const debounce = (fn,ms=160)=>{ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; };

  // ====== Perms guard ======
  const VIEW_PERM = 'colaboradores.ver';
  const EDIT_PERM = 'colaboradores.gerenciar';

  const state = {
    setores: [],
    colaboradores: [],
    filtroTexto: '',
    filtroSetorId: '',
    permsSet: null,         // minhas permissões efetivas

    // perfil
    viewing: null,          // objeto colaborador atual
    inlineEdit: false,

    // criação via modal de perfil
    newAvatarFile: null,    // arquivo escolhido no hint (modo "novo")

    // exibir erros de validação só depois da 1ª tentativa de salvar
    showErrors: false
  };

  async function preloadPerms(){
    try{
      const list = await apiGet('/api/permissoes/minhas');
      const arr  = Array.isArray(list) ? list : (list?.items || []);
      state.permsSet = new Set(arr);
    }catch(e){
      console.warn('[perms] falhou', e);
      state.permsSet = null;
    }
  }
  const hasPerm = (p)=>{
    if (state.permsSet) return state.permsSet.has(p);
    const fn = window.ZAuth?.hasPerm?.bind?.(window.ZAuth);
    if (typeof fn === 'function') return !!fn(p);
    return true;
  };

  // ====== Toast ======
  const toastEl = $('#toast');
  function toast(msg, type='ok'){
    if (!toastEl) return;
    const icon = type === 'err' ? 'fa-triangle-exclamation'
                : type === 'warn'? 'fa-circle-exclamation'
                : 'fa-circle-check';
    toastEl.className = '';
    toastEl.innerHTML = `<i class="fa-solid ${icon}"></i><span class="toast-msg">${msg}</span>`;
    toastEl.classList.add(`toast-${type}`,'show');
    clearTimeout(toast._t);
    toast._t = setTimeout(()=> toastEl.classList.remove('show'), 3200);
  }

  // ====== Elements ======
  const filtroTxt   = $('#filtro');
  const filtroDepto = $('#filtro-depto');
  const btnFiltrar  = $('#btn-filtrar');
  const btnAdd      = $('#btn-add-colaborador');
  const tbody       = $('#tabela-colaboradores');
  const emptyState  = $('#empty-state');
  const countEl     = $('#count-colaboradores');

  // Modal PERFIL
  const perfilModal  = $('#modal-perfil');
  const pClose       = $('#perfil-fechar');
  const pClose2      = $('#perfil-fechar2');
  const pEdit        = $('#perfil-editar');
  const pSave        = $('#perfil-salvar');
  const pCancel      = $('#perfil-cancelar');
  const pTitle       = $('#perfil-title');

  // avatar + status
  const pAvatar  = $('#p-avatar');
  const pMono    = $('#p-mono');
  const dStatus  = $('#p-status');
  const dStatusText = $('#p-status-text');

  // hint/CTA avatar (apenas modo "novo")
  const avatarHint   = $('#avatar-hint');
  const btnAddAvatar = $('#btn-add-avatar');
  const pAvatarInput = $('#p-avatar-input');

  // Fieldboxes (view)
  const vNome    = $('#v-nome');
  const vEmailA  = $('#v-email');
  const vEmpresa = $('#v-empresa');
  const vDepto   = $('#v-depto');
  const vTelA    = $('#v-tel');
  const vCargo   = $('#v-cargo');
  const dPerms   = $('#d-perms');
  const ePerms   = $('#e-perms');

  // Rodapé (para botões dinâmicos)
  const footEl  = perfilModal?.querySelector('.foot');
  let pSaveFoot = null, pCancelFoot = null;

  function ensureFooterButtons(){
    if (!footEl) return;
    if (!pSaveFoot){
      pSaveFoot = document.createElement('button');
      pSaveFoot.id = 'perfil-salvar-foot';
      pSaveFoot.className = 'btn btn-primary';
      pSaveFoot.type = 'button';
      pSaveFoot.innerHTML = '<i class="fa fa-check"></i> Salvar';
      pSaveFoot.addEventListener('click', saveInline);
      footEl.insertBefore(pSaveFoot, footEl.lastElementChild);
    }
    if (!pCancelFoot){
      pCancelFoot = document.createElement('button');
      pCancelFoot.id = 'perfil-cancelar-foot';
      pCancelFoot.className = 'btn btn-ghost';
      pCancelFoot.type = 'button';
      pCancelFoot.textContent = 'Cancelar';
      pCancelFoot.addEventListener('click', ()=> {
        if (perfilModal?.dataset.mode === 'create') closePerfil();
        else exitInlineEdit(true);
      });
      footEl.insertBefore(pCancelFoot, pSaveFoot);
    }
  }

  // ====== Utils (máscaras e validações) ======
  const digits = (s)=> String(s||'').replace(/\D+/g,'');
  function maskPhoneBR(v){
    let d=digits(v).slice(0,11), dd=d.slice(0,2), n=d.slice(2);
    if(!d.length) return '';
    if(d.length<=10){
      if(n.length>4) return `(${dd}) ${n.slice(0,4)}-${n.slice(4)}`;
      if(n.length)   return `(${dd}) ${n}`;
      return dd?`(${dd}`:'';
    }
    return `(${dd}) ${n[0]} ${n.slice(1,5)}-${n.slice(5)}`;
  }
  function telE164(v){
    const d = digits(v||'');
    if (!d) return '';
    if (d.startsWith('55')) return `+${d}`;
    return `+55${d}`;
  }
  function maskPhoneDisplay(v){
    const d=digits(v||''); if(!d) return '—';
    const dd=d.slice(0,2), n=d.slice(2);
    return n.length<=8 ? `(${dd}) ${n.slice(0,4)}-${n.slice(4)}`
                       : `(${dd}) ${n[0]} ${n.slice(1,5)}-${n.slice(5)}`;
  }
  function initials(name){
    const parts = String(name||'').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'AZ';
    if (parts.length===1) return parts[0].slice(0,2).toUpperCase();
    return (parts[0][0]+parts[parts.length-1][0]).toUpperCase();
  }
  function hashColor(seed){
    let h=0; for(let i=0;i<seed.length;i++){ h=(h*31+seed.charCodeAt(i))|0; }
    const hue=Math.abs(h)%360; return `hsl(${hue} 35% 40%)`;
  }
  function chip(text){
    const s=document.createElement('span');
    s.className='chip'; s.textContent=text; return s;
  }

  // Mapeia nomes alternativos vindos da API
  function coalescePhone(c){
    return c.telefone ?? c.telefone_norm ?? c.phone ?? c.celular ?? c.whatsapp ?? c.fone
        ?? c.usuario?.telefone ?? c.user?.phone ?? '';
  }
  function coalesceDeptId(c){
    return c.setor_id ?? c.departamento_id ?? c.dep_id ?? c.depto_id ?? c.dept_id ?? null;
  }
  function coalesceDeptName(c){
    return c.setor_nome ?? c.departamento_nome ?? c.departamento ?? c.depto_nome ?? c.dep_nome ?? null;
  }
  function coalesceName(c){
    return c.nome ?? c.nome_completo ?? c.display_name ?? c.full_name
        ?? c.usuario?.nome ?? c.user?.name ?? '';
  }
  function coalesceEmail(c){
    return c.email ?? c.usuario?.email ?? c.user?.email ?? '';
  }
  function coalesceCargo(c){
    return c.cargo ?? c.funcao ?? c.usuario?.cargo ?? c.user?.job_title ?? '';
  }

  // ====== Admin badge ======
  function isAdminFlag(c){
    return !!(c && (
      c.is_admin === true ||
      /^\s*admin\s*$/i.test(coalesceCargo(c) || '') ||
      (c.usuario && c.usuario.is_admin === true)
    ));
  }
  function renderAdminBadge(colab){
    const fb = $('#fb-cargo');
    if (!fb) return;
    const label = fb.querySelector('label') || fb;
    let badge = fb.querySelector('#badge-admin');
    if (!badge){
      badge = document.createElement('span');
      badge.id = 'badge-admin';
      badge.className = 'chip chip-admin';
      badge.textContent = 'Administrador';
      badge.style.marginLeft = '8px';
      label.appendChild(badge);
    }
    badge.style.display = isAdminFlag(colab) ? '' : 'none';
  }

  // ====== Data ======
  async function loadSetores(){
    const tries = [
      '/api/departamentos',
      '/api/departamentos/tree',
      '/api/atendimento/clientes/departamentos',
      '/api/atendimento/clientes/departamentos/tree',
    ];
    for (const u of tries){
      try{
        const data = await apiGet(u);
        const arr = Array.isArray(data) ? data : (data?.items || data?.data || []);
        if (arr?.length){
          state.setores = arr.map(x=>({
            id: String(x.id ?? x.dep_id ?? x.value ?? x.ID),
            nome: x.nome ?? x.name ?? x.titulo ?? x.label ?? '—'
          }));
          renderSetores(); return;
        }
      }catch{}
    }
    state.setores = [];
    renderSetores();
  }

  async function loadColaboradores(){
    const p = new URLSearchParams();
    if (state.filtroTexto) p.set('q', state.filtroTexto);
    const url = '/api/colaboradores' + (p.toString()?`?${p}`:'');
    try{
      const res = await apiGet(url);
      state.colaboradores = Array.isArray(res) ? res : (res?.items||[]);
    }catch(e){
      console.error(e); state.colaboradores = [];
      toast('Erro ao carregar colaboradores.','err');
    }
  }

  // ====== Render lista ======
  function renderSetores(){
    const filtroDepto = $('#filtro-depto');
    const fSetor = $('#c-setor');
    if (filtroDepto){
      const first = filtroDepto.querySelector('option');
      filtroDepto.innerHTML=''; if (first) filtroDepto.appendChild(first);
      state.setores.forEach(s => filtroDepto.appendChild(new Option(s.nome,s.id)));
      if (state.filtroSetorId) filtroDepto.value = state.filtroSetorId;
    }
    if (fSetor){
      fSetor.innerHTML = '';
      state.setores.forEach(s => fSetor.appendChild(new Option(s.nome,s.id)));
    }
  }
  function renderLista(){
    const q = (state.filtroTexto||'').toLowerCase();
    const depId = String(state.filtroSetorId||'');
    const rows = state.colaboradores
      .filter(c => !q || [c.nome,c.email,coalescePhone(c),c.cargo].some(v => String(v||'').toLowerCase().includes(q)))
      .filter(c => !depId || String(coalesceDeptId(c) ?? '') === depId);

    countEl.textContent = rows.length;
    tbody.innerHTML = '';
    if (!rows.length){ emptyState.style.display='flex'; return; }
    emptyState.style.display='none';

    rows.forEach((c,i)=>{
      const depName = coalesceDeptName(c)
        || state.setores.find(s => String(s.id)===String(coalesceDeptId(c)))?.nome
        || '-';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i+1}</td>
        <td>${c.nome||'-'}</td>
        <td>${c.email||'-'}</td>
        <td>${depName}</td>
        <td class="td-actions">
          <button class="btn btn-ghost" data-action="view" data-id="${c.id}" title="Ver perfil"><i class="fa fa-pen"></i></button>
          <button class="btn btn-ghost" data-action="del" data-id="${c.id}" title="Remover"><i class="fa fa-trash"></i></button>
        </td>
      `.trim();
      tbody.appendChild(tr);
    });
  }

  // ====== Avatar (perfil/hint) ======
  function setPerfilAvatar(nome, url){
    if (url){
      pAvatar.src=url; pAvatar.style.display='block'; pMono.style.display='none';
    } else {
      pMono.textContent = initials(nome);
      pMono.style.display='grid'; pAvatar.removeAttribute('src'); pAvatar.style.display='none';
      pMono.parentElement.style.background = hashColor(nome||'ZapChats');
    }
  }
  async function fetchAvatarURLFor(colab){
    try{
      const r1 = await authFetch(withEmpresa(`/api/colaboradores/${colab.id}/avatar`));
      if (r1.ok && r1.status === 200) {
        const blob = await r1.blob();
        return URL.createObjectURL(blob);
      }
    }catch{}
    if (colab.usuario_id){
      try{
        const r2 = await authFetch(withEmpresa(`/api/usuarios/${colab.usuario_id}/avatar`));
        if (r2.ok && r2.status === 200){
          const blob = await r2.blob();
          return URL.createObjectURL(blob);
        }
      }catch{}
    }
    return colab.avatar_url || null;
  }

  async function loadEmpresa(){
    if (!EMPRESA_ID) return null;
    try{ return await apiGet(`/api/empresas/${EMPRESA_ID}`); }catch{ return null; }
  }

  // BACKEND retorna ColaboradorOut plano
  async function loadColabFull(id){
    const c = await apiGet(`/api/colaboradores/${id}`);
    try{
      const p = await apiGet(`/api/permissoes/colaboradores/${id}`);
      c.permissoes = Array.isArray(p) ? p : (p?.items || p?.data || []);
    }catch{}
    return c;
  }

  async function renderPerfilView(colab){
    const empresa = await loadEmpresa();
    if (!state.setores.length) { try{ await loadSetores(); }catch{} }
    state.viewing = colab;
    state.showErrors = false;

    // título + avatar + status
    pTitle.textContent = perfilModal.dataset.mode === 'create'
      ? 'Novo colaborador'
      : (coalesceName(colab) || 'Perfil do colaborador');

    const photoURL = await fetchAvatarURLFor(colab);
    setPerfilAvatar(coalesceName(colab), photoURL);

    dStatus.style.background = '#008b32';
    dStatusText.textContent = 'Disponível';

    // valores (com mapeamento de campos)
    const nome  = coalesceName(colab);
    const email = coalesceEmail(colab);

    vNome.textContent     = nome || '—';
    vEmailA.textContent   = email || '—';
    vEmailA.href          = email ? `mailto:${email}` : '#';
    vEmpresa.textContent  = empresa?.nome || '—';

    const depId   = coalesceDeptId(colab);
    const depName = coalesceDeptName(colab) || state.setores.find(s => String(s.id)===String(depId))?.nome;
    vDepto.textContent    = depName || '—';

    const telRaw  = coalescePhone(colab);
    const telDisp = telRaw ? maskPhoneDisplay(telRaw.replace(/^\+/,'')) : '—';
    vTelA.textContent = telDisp;
    vTelA.href        = telRaw ? `tel:${telE164(telRaw)}` : '#';

    // 👇 se for admin, esconde o texto "admin" e deixa só a badge
    const cargoVal = coalesceCargo(colab);
    const adm = isAdminFlag(colab);
    vCargo.textContent = adm ? '' : (cargoVal || '—');

    // badge de Administrador
    renderAdminBadge(colab);

    // permissões (chips)
    dPerms.innerHTML = '';
    const permsList = (colab.permissoes||[]).map(x => (x.id||x).toString());
    if (permsList.length) permsList.forEach(p => dPerms.appendChild(chip(p)));
    else dPerms.textContent = '—';

    // hint de avatar só no modo "create"
    avatarHint.style.display = (perfilModal.dataset.mode === 'create') ? 'grid' : 'none';

    // permissões na criação
    if (perfilModal.dataset.mode === 'create'){
      ePerms.style.display = 'grid';
      await ensurePermsEdit();
    } else {
      ePerms.style.display = 'none';
      ePerms.innerHTML = '';
    }

    // edição inline desligada por padrão (vamos ligar no modo "create")
    exitInlineEdit(false);
  }

  // ====== Edição inline ======
  function swapFieldbox(boxId, html){
    const wrap = document.getElementById(boxId);
    if (!wrap) return null;
    if (!wrap.dataset.viewHtml) wrap.dataset.viewHtml = wrap.innerHTML;
    wrap.classList.add('is-editing');
    wrap.innerHTML = html.trim();
    return wrap.firstElementChild;
  }
  function restoreFieldbox(boxId){
    const wrap = document.getElementById(boxId);
    if (wrap && wrap.dataset.viewHtml != null){
      wrap.innerHTML = wrap.dataset.viewHtml;
      wrap.classList.remove('is-editing');
      delete wrap.dataset.viewHtml;
    }
  }

  function markValidity(input, isValid){
    if (!input) return;
    const wrap = input.closest('.fieldbox');
    input.classList.toggle('invalid', !isValid);
    input.setAttribute('aria-invalid', String(!isValid));
    if (wrap) wrap.classList.toggle('invalid', !isValid);
  }
  function setSaveEnabled(_ok){
    [pSaveFoot, pSave].forEach(btn=>{
      if (!btn) return;
      btn.disabled = false;
      btn.removeAttribute('aria-disabled');
    });
  }
  function getEditInputs(){
    return {
      eNome:  $('#e-nome'),
      eEmail: $('#e-email'),
      eSetor: $('#e-setor'),
      eTel:   $('#e-tel'),
      eCargo: $('#e-cargo'),
    };
  }
  function validateFormLive(forceShow){
    const show = (typeof forceShow === 'boolean') ? forceShow : state.showErrors;

    const { eNome, eEmail, eSetor, eTel, eCargo } = getEditInputs();
    const nome   = eNome?.value.trim()   || '';
    const email  = (eEmail?.value || '').trim();
    const setor  = eSetor?.value || '';
    const tel    = eTel?.value   || '';
    const cargo  = eCargo?.value.trim()  || '';

    const msgs = [];
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const telDigits = digits(tel);
    const nomeOk  = nome.length >= 2;
    const setorOk = !!setor;
    const telOk   = telDigits.length >= 10;
    const cargoOk = cargo.length >= 2;

    if (!nomeOk)  msgs.push('• Nome completo (mín. 2 letras)');
    if (!emailOk) msgs.push('• E-mail inválido');
    if (!setorOk) msgs.push('• Departamento (selecione um)');
    if (!telOk)   msgs.push('• Telefone com DDD (10–11 dígitos)');
    if (!cargoOk) msgs.push('• Cargo (mín. 2 letras)');

    markValidity(eNome,  show ? nomeOk  : true);
    markValidity(eEmail, show ? emailOk : true);
    if (eSetor) {
      const wrap = eSetor.closest('.fieldbox');
      const ok = show ? setorOk : true;
      eSetor.classList.toggle('invalid', !ok);
      eSetor.setAttribute('aria-invalid', String(!ok));
      if (wrap) wrap.classList.toggle('invalid', !ok);
    }
    markValidity(eTel,   show ? telOk   : true);
    markValidity(eCargo, show ? cargoOk : true);

    const ok = nomeOk && emailOk && setorOk && telOk && cargoOk;
    setSaveEnabled(ok);
    return { ok, msgs };
  }

  async function ensurePermsEdit(){
    ePerms.innerHTML = '';
    ePerms.style.display = 'grid';
    try{
      const list = await apiGet('/api/permissoes');
      const items = Array.isArray(list) ? list : (list?.items||[]);
      const current = new Set((state.viewing?.permissoes||[]).map(x => (x.id||x)+''));
      items.forEach(p=>{
        const idRaw = p.id ?? p.value ?? p.key;
        const label = p.nome || idRaw;
        const el = document.createElement('label');
        el.className = 'chk-line';
        el.innerHTML = `<input type="checkbox" name="perm-edit" value="${idRaw}" ${current.has(String(idRaw))?'checked':''}><span>${label}</span>`;
        ePerms.appendChild(el);
      });
    }catch{
      ePerms.innerHTML = `<div style="opacity:.75">Permissões indisponíveis.</div>`;
    }
  }
  function getPermsSelecionadasEdit(){
    return [...document.querySelectorAll('#e-perms input[name="perm-edit"]:checked')].map(i=> i.value);
  }
  async function savePerms(id, arr){
    try{
      await apiJSON(`/api/permissoes/colaboradores/${id}`, 'PUT', { permissoes: arr });
      return true;
    }catch(e1){
      try{
        await apiJSON(`/api/colaboradores/${id}`, 'PUT', { permissoes: arr });
        return true;
      }catch(e2){
        console.warn('falha ao salvar perms', e1, e2);
        return false;
      }
    }
  }

  function enterInlineEdit(){
    if (!state.viewing || state.inlineEdit) return;
    state.inlineEdit = true;
    state.showErrors = false;

    pEdit.style.display   = 'none';
    pSave.style.display   = 'none';
    pCancel.style.display = 'none';
    if (pClose) pClose.style.display = '';

    ensureFooterButtons();
    if (pSaveFoot)   pSaveFoot.style.display = '';
    if (pCancelFoot) pCancelFoot.style.display = '';
    if (pClose2)     pClose2.style.display = 'none';

    if (perfilModal.dataset.mode === 'create') {
      pSaveFoot.innerHTML = '<i class="fa fa-check"></i> Criar';
    } else {
      pSaveFoot.innerHTML = '<i class="fa fa-check"></i> Salvar';
    }

    perfilModal.classList.add('editing');

    swapFieldbox('fb-nome',  `<input id="e-nome" class="input" type="text" maxlength="120" required autocomplete="off" placeholder="Seu nome completo">`);
    swapFieldbox('fb-email', `<input id="e-email" class="input" type="email" maxlength="160" required autocomplete="off" placeholder="nome@empresa.com">`);

    const selHtml = `<select id="e-setor" class="select" required>
        <option value="">Selecione…</option>
        ${state.setores.map(s=>`<option value="${s.id}">${s.nome}</option>`).join('')}
      </select>`;
    const sel = swapFieldbox('fb-depto', selHtml);
    const depId = coalesceDeptId(state.viewing);
    if (depId != null && sel) sel.value = String(depId);

    swapFieldbox('fb-tel', `<input id="e-tel" class="input" type="tel" required inputmode="numeric" placeholder="(DD) 9 9999-9999">`);
    swapFieldbox('fb-cargo', `<input id="e-cargo" class="input" type="text" maxlength="80" required placeholder="Cargo">`);

    $('#e-nome').value  = coalesceName(state.viewing) || '';
    $('#e-email').value = coalesceEmail(state.viewing) || '';
    $('#e-tel').value   = (coalescePhone(state.viewing) ? maskPhoneBR(coalescePhone(state.viewing)) : '');
    $('#e-cargo').value = coalesceCargo(state.viewing) || '';

    renderAdminBadge({ ...state.viewing, cargo: $('#e-cargo').value });

    $('#e-nome')?.addEventListener('input', ()=>{
      const el = $('#e-nome');
      let v = el.value.replace(/[0-9]/g,'');
      v = v.replace(/\s{2,}/g,' ');
      el.value = v;
      validateFormLive();
    });
    $('#e-email')?.addEventListener('input', ()=>{
      const el = $('#e-email');
      el.value = el.value.replace(/\s+/g,'').toLowerCase();
      validateFormLive();
    });
    $('#e-tel')?.addEventListener('input', ()=>{
      const el = $('#e-tel');
      el.value = maskPhoneBR(el.value);
      validateFormLive();
    });
    $('#e-cargo')?.addEventListener('input', ()=>{
      validateFormLive();
      renderAdminBadge({ ...state.viewing, cargo: $('#e-cargo').value });
    });
    sel?.addEventListener('change', ()=> validateFormLive());

    if (perfilModal.dataset.mode === 'create'){
      ensurePermsEdit();
      ePerms.style.display = 'grid';
    }

    validateFormLive(false);
  }

  function exitInlineEdit(restore=true){
    restoreFieldbox('fb-nome');
    restoreFieldbox('fb-email');
    restoreFieldbox('fb-depto');
    restoreFieldbox('fb-tel');
    restoreFieldbox('fb-cargo');

    state.inlineEdit = false;
    state.showErrors = false;

    pEdit.style.display   = '';
    pSave.style.display   = 'none';
    pCancel.style.display = 'none';
    if (pClose) pClose.style.display = 'none';

    if (pClose2)     pClose2.style.display = '';
    if (pSaveFoot)   pSaveFoot.style.display = 'none';
    if (pCancelFoot) pCancelFoot.style.display = 'none';

    perfilModal.classList.remove('editing');

    if (restore && state.viewing) renderPerfilView(state.viewing);
  }

  async function saveInline(){
    validateFormLive(false);

    const mode = perfilModal.dataset.mode || 'view';
    const id = Number(perfilModal.dataset.currentId||'0')||0;

    const { eNome, eEmail, eSetor, eTel, eCargo } = getEditInputs();
    const nome  = eNome?.value.trim();
    const email = eEmail?.value.trim();
    const setor = eSetor?.value || '';
    const tel   = eTel?.value || '';
    const cargo = eCargo?.value || '';

    state.showErrors = true;
    const check = validateFormLive(true);

    if (!check.ok){
      toast('Corrija os campos:\n' + check.msgs.join('\n'),'warn');
      return;
    }

    if (mode === 'create'){
      const fd = new FormData();
      fd.append('nome', nome);
      fd.append('email', email);
      fd.append('setor_id', String(Number(setor)));
      fd.append('telefone', telE164(tel));
      fd.append('cargo', (cargo||'').trim());

      const permsCreate = getPermsSelecionadasEdit();
      if (permsCreate.length) fd.append('permissoes', JSON.stringify(permsCreate));
      // fd.append('criar_usuario', 'true'); fd.append('senha', 'temp@123');

      if (state.newAvatarFile) fd.append('avatar', state.newAvatarFile);

      try{
        const created = await apiForm('/api/colaboradores/', 'POST', fd);
        toast('Colaborador criado.');

        state.newAvatarFile = null;
        state.showErrors = false;

        perfilModal.dataset.mode = 'view';
        perfilModal.dataset.currentId = String(created?.id||'');
        const fresh = await loadColabFull(created.id);
        state.viewing = fresh;
        await loadColaboradores(); renderLista();
        await renderPerfilView(fresh);
        exitInlineEdit(false);
      }catch(e){
        console.error(e);
        if (e.status===409) return toast('E-mail já cadastrado.','warn');
        toast('Erro ao criar.','err');
      }
      return;
    }

    const payload = {
      nome, email,
      setor_id: Number(setor),
      telefone: telE164(tel),
      cargo: (cargo||'').trim(),
      atualizar_usuario: !!state.viewing?.usuario_id
    };

    try{
      await apiJSON(`/api/colaboradores/${id}`, 'PUT', payload);

      let permsUpdated = false;
      if (ePerms.style.display !== 'none'){
        const arr = getPermsSelecionadasEdit();
        permsUpdated = await savePerms(id, arr);
        if (permsUpdated) state.viewing.permissoes = arr;
      }

      state.showErrors = false;
      toast(permsUpdated ? 'Alterações e permissões salvas.' : 'Alterações salvas.');

      const fresh = await loadColabFull(id);
      state.viewing = fresh;
      await loadColaboradores(); renderLista();
      renderPerfilView(fresh);
    }catch(e){
      console.error(e);
      if (e.status===409) return toast('E-mail já cadastrado.','warn');
      if (e.status===404) return toast('Registro não encontrado.','warn');
      toast('Erro ao salvar.','err');
    }
  }

  // ====== Flow de abrir perfil/novo ======
  async function openPerfil(id){
    try{
      perfilModal.dataset.mode = 'view';
      const colab = await loadColabFull(id);
      await renderPerfilView(colab);
      perfilModal.dataset.currentId = String(id);
      if (hasPerm(EDIT_PERM)) pEdit.style.display = ''; else pEdit.style.display = 'none';
      perfilModal.setAttribute('aria-hidden','false');
      document.documentElement.classList.add('modal-open');
    }catch(e){
      console.error(e);
      toast('Não foi possível abrir o perfil.','err');
    }
  }
  function closePerfil(){
    perfilModal.setAttribute('aria-hidden','true');
    document.documentElement.classList.remove('modal-open');
    perfilModal.dataset.mode = 'view';
    state.newAvatarFile = null;
    state.showErrors = false;
    $('#avatar-wrap')?.classList.remove('drag-over');
  }

  // Helper para validar e aplicar arquivo de avatar
  function handleAvatarFile(file){
    if (!file) return;
    if (!/image\//.test(file.type) && !/\.svg$/i.test(file.name)){
      toast('Envie uma imagem.','warn'); return;
    }
    state.newAvatarFile = file;
    const url = URL.createObjectURL(file);
    setPerfilAvatar($('#e-nome')?.value || 'Novo Colaborador', url);
  }

  async function openNovo(){
    if (!hasPerm(EDIT_PERM)) { toast('Sem permissão para criar.','warn'); return; }
    const blank = { id:null, nome:'', email:'', telefone:'', cargo:'', setor_id:null, permissoes:[] };
    perfilModal.dataset.mode = 'create';
    perfilModal.dataset.currentId = '';
    state.showErrors = false;
    await renderPerfilView(blank);

    if (btnAddAvatar && pAvatarInput){
      btnAddAvatar.onclick = ()=> pAvatarInput.click();
      pAvatarInput.onchange = ()=> handleAvatarFile(pAvatarInput.files && pAvatarInput.files[0]);
    }

    const avatarWrap = $('#avatar-wrap');
    if (avatarWrap && pAvatarInput){
      avatarWrap.onclick = ()=>{ if (perfilModal.dataset.mode === 'create') pAvatarInput.click(); };
      ['dragenter','dragover'].forEach(ev=>{
        avatarWrap.addEventListener(ev, (e)=> {
          if (perfilModal.dataset.mode !== 'create') return;
          e.preventDefault(); e.stopPropagation();
          avatarWrap.classList.add('drag-over');
        });
      });
      ['dragleave','dragend','drop'].forEach(ev=>{
        avatarWrap.addEventListener(ev, (e)=> {
          if (perfilModal.dataset.mode !== 'create') return;
          e.preventDefault(); e.stopPropagation();
          if (ev !== 'drop') avatarWrap.classList.remove('drag-over');
        });
      });
      avatarWrap.addEventListener('drop', (e)=>{
        if (perfilModal.dataset.mode !== 'create') return;
        const f = e.dataTransfer?.files?.[0];
        avatarWrap.classList.remove('drag-over');
        handleAvatarFile(f);
      });
    }

    perfilModal.setAttribute('aria-hidden','false');
    document.documentElement.classList.add('modal-open');
    enterInlineEdit();
  }

  // ====== Events ======
  function bind(){
    filtroTxt?.addEventListener('input', debounce(()=>{
      state.filtroTexto = filtroTxt.value.trim();
      renderLista();
    },160));
    filtroDepto?.addEventListener('change', ()=>{ state.filtroSetorId = filtroDepto.value; renderLista(); });
    btnFiltrar?.addEventListener('click', renderLista);

    btnAdd?.addEventListener('click', openNovo);

    document.addEventListener('click', (e)=>{
      const b = e.target.closest('[data-action]'); if (!b) return;
      const id = Number(b.dataset.id);
      if (b.dataset.action === 'view') return openPerfil(id);
      if (b.dataset.action === 'del'){
        if (!hasPerm(EDIT_PERM)) return toast('Sem permissão para remover.','warn');
        if (!confirm('Remover este colaborador?')) return;
        apiJSON(`/api/colaboradores/${id}`, 'DELETE', {}).then(async ()=>{
          toast('Removido.'); await loadColaboradores(); renderLista();
        }).catch(()=> toast('Não foi possível remover.','err'));
      }
    }, { capture:true });

    pClose?.addEventListener('click', closePerfil);
    pClose2?.addEventListener('click', closePerfil);
    pEdit?.addEventListener('click', ()=>{
      if (!hasPerm(EDIT_PERM)) return toast('Sem permissão para editar.','warn');
      enterInlineEdit();
    });
    pCancel?.addEventListener('click', ()=>{
      if (perfilModal?.dataset.mode === 'create') closePerfil();
      else exitInlineEdit(true);
    });
    pSave?.addEventListener('click', saveInline);

    perfilModal?.addEventListener('mousedown', (ev)=>{
      const card = perfilModal.querySelector('.modal-card');
      if (card && !card.contains(ev.target)) closePerfil();
    });
    perfilModal?.querySelector('.modal-card')?.addEventListener('mousedown', ev => ev.stopPropagation());

    document.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape' && perfilModal?.getAttribute('aria-hidden') === 'false'){
        closePerfil();
      }
    });
  }

  // ====== Init / Poller ======
  let _poller = null;
  function startPoller(){
    if (_poller) return;
    _poller = setInterval(async ()=>{ await loadColaboradores(); renderLista(); }, 60000);
  }
  function stopPoller(){
    if (_poller){ clearInterval(_poller); _poller = null; }
  }

  async function init(){
    if (init._did) return;
    init._did = true;
    if (window.ZAuth?.softEnsureAuth) { try{ await ZAuth.softEnsureAuth(); }catch{} }
    await preloadPerms();
    bind();
    await loadSetores();
    await loadColaboradores();
    renderLista();
    startPoller();

    document.addEventListener('visibilitychange', ()=>{
      if (document.hidden) stopPoller(); else startPoller();
    });
    window.addEventListener('beforeunload', ()=> stopPoller());
  }

  function run(){
    if (run._did) return; run._did = true;
    if (window.Page?.guarded){
      window.Page.guarded(VIEW_PERM, init, { msg:'Sem permissão para Colaboradores' });
    } else {
      init();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once:true });
  else run();

})();
