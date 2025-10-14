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

    // instâncias (WhatsApp)
    instsCache: null,       // [{id, slug, name, number, connected}]

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
  const pClose       = $('#perfil-fechar');    // (fica oculto; usamos fechar do rodapé)
  const pClose2      = $('#perfil-fechar2');
  const pEdit        = $('#perfil-editar');
  const pSave        = $('#perfil-salvar');    // topo (oculto no layout)
  const pCancel      = $('#perfil-cancelar');  // topo (oculto no layout)
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
      footEl.insertBefore(pSaveFoot, footEl.lastElementChild); // antes do fechar padrão
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

  // ====== Instâncias (WhatsApp) ======
  function normInstances(items){
    if (!Array.isArray(items)) return [];
    return items.map(x=>{
      const id   = (x.id!=null) ? Number(x.id)
                : (x.instancia_id!=null ? Number(x.instancia_id) : null);
      const slug = String(x.instance_name ?? x.slug ?? x.nome ?? '').trim();
      const name = String((x.apelido ?? x.name ?? x.nome ?? slug) || '').trim();
      const number = x.numero_instancia ?? x.numero ?? null;
      const connected = !!x.connected || !!x.online || (String(x.status||'').toLowerCase()==='connected');
      return (id || slug) ? { id, slug, name: name || slug, number, connected } : null;
    }).filter(Boolean);
  }
  async function fetchInstances(){
    if (state.instsCache) return state.instsCache;
    let arr = [];
    if (EMPRESA_ID){
      try{
        const data = await apiGet(`/api/empresas/${EMPRESA_ID}/whatsapp`);
        arr = normInstances(Array.isArray(data?.instancias) ? data.instancias : (Array.isArray(data) ? data : []));
      }catch(e){ console.warn('instancias whatsapp', e); }
    }
    if (!arr.length){
      const fallbacks = ['/api/atendimento/instances','/api/instances'];
      for (const url of fallbacks){
        try{
          const d = await apiGet(url);
          const items = Array.isArray(d?.items) ? d.items : (Array.isArray(d) ? d : []);
          arr = normInstances(items);
          if (arr.length) break;
        }catch{}
      }
    }
    state.instsCache = arr;
    return arr;
  }
  function coalesceInstIds(c){
    // aceita vários formatos vindos do back
    const raw = c?.instancias_ids ?? c?.instances_ids ?? c?.whatsapp_instancias_ids
             ?? c?.whatsapp_ids ?? c?.whatsapps_ids ?? c?.instancias ?? c?.instances ?? null;
    if (!raw) return [];
    if (Array.isArray(raw)){
      if (raw.length && typeof raw[0] === 'object'){
        return raw.map(x=> Number(x.id ?? x.instancia_id ?? x.instance_id ?? x.value))
                  .filter(n=> !Number.isNaN(n));
      }
      return raw.map(x=> Number(x)).filter(n=> !Number.isNaN(n));
    }
    if (typeof raw === 'string'){
      try{
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.map(Number).filter(n=> !Number.isNaN(n));
      }catch{}
      return raw.split(',').map(s=>Number(s.trim())).filter(n=>!Number.isNaN(n));
    }
    return [];
  }
  function getInstsSelecionadasEdit(){
    return [...document.querySelectorAll('#e-insts input[name="inst-edit"]:checked')]
      .map(i => Number(i.value))
      .filter(n => !Number.isNaN(n));
  }
  async function saveInsts(id, ids){
    // Tenta salvar pelo endpoint dedicado; se não tiver, envia no PUT do colaborador
    try{
      await apiJSON(`/api/colaboradores/${id}/instancias`, 'PUT', { instancias_ids: ids });
      return true;
    }catch(e1){
      try{
        await apiJSON(`/api/colaboradores/${id}`, 'PUT', { instancias_ids: ids });
        return true;
      }catch(e2){
        try{
          await apiJSON(`/api/colaboradores/${id}/whatsapp`, 'PUT', { instancias_ids: ids });
          return true;
        }catch(e3){
          console.warn('falha ao salvar instancias', e1, e2, e3);
          return false;
        }
      }
    }
  }

  // cria/garante a seção (títulos, área de visualização e de edição)
  function ensureInstsSection(){
    let wrap = document.getElementById('insts-wrap');
    if (!wrap){
      wrap = document.createElement('div');
      wrap.id = 'insts-wrap';
      wrap.className = 'fieldbox';
      wrap.innerHTML = `
        <label style="display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap">
          Este atendente pode ter acesso às conversas de quais WhatsApps?
          <span class="muted">(marque um ou mais — opcional)</span>
        </label>

        <div id="inst-actions" style="display:none;gap:.5rem;margin:.35rem 0 .5rem 0">
          <button type="button" id="inst-select-all" class="btn btn-ghost" style="padding:.25rem .5rem;font-size:.85rem">Selecionar todos</button>
          <button type="button" id="inst-clear" class="btn btn-ghost" style="padding:.25rem .5rem;font-size:.85rem">Limpar</button>
        </div>

        <div id="e-insts" style="display:none;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:.5rem"></div>
        <div id="d-insts" class="chips" style="display:flex;flex-wrap:wrap;gap:.5rem"></div>
      `;
      // insere antes do bloco de permissões (se existir)
      if (ePerms && ePerms.parentElement){
        ePerms.parentElement.insertBefore(wrap, ePerms);
      } else {
        perfilModal?.querySelector('.body')?.appendChild(wrap);
      }
    }
    return wrap;
  }
  async function renderInstsView(colab){
    const wrap = ensureInstsSection();
    const chipsWrap = wrap.querySelector('#d-insts');
    const editGrid  = wrap.querySelector('#e-insts');
    const actions   = wrap.querySelector('#inst-actions');
    // modo visualização
    actions.style.display = 'none';
    editGrid.style.display = 'none';
    chipsWrap.style.display = 'flex';
    chipsWrap.innerHTML = '';
    const ids = coalesceInstIds(colab);
    if (!ids.length){
      chipsWrap.textContent = '—';
      return;
    }
    const items = await fetchInstances();
    ids.forEach(id=>{
      const obj = items.find(x => Number(x.id)===Number(id));
      const lbl = obj ? `${obj.name || obj.slug}${obj.number ? ' • '+obj.number : ''}` : `#${id}`;
      chipsWrap.appendChild(chip(lbl));
    });
  }
  async function ensureInstsEdit(){
    const wrap = ensureInstsSection();
    const chipsWrap = wrap.querySelector('#d-insts');
    const editGrid  = wrap.querySelector('#e-insts');
    const actions   = wrap.querySelector('#inst-actions');

    chipsWrap.style.display = 'none';
    editGrid.style.display  = 'grid';
    actions.style.display   = 'flex';
    editGrid.innerHTML = '<div class="muted">Carregando instâncias…</div>';

    const items = await fetchInstances();
    editGrid.innerHTML = '';

    const current = new Set(coalesceInstIds(state.viewing).map(String));
    if (!items.length){
      editGrid.innerHTML = '<div class="muted">Nenhuma instância encontrada.</div>';
    } else {
      // conectadas primeiro
      items.sort((a,b)=> (a.connected===b.connected) ? String(a.name).localeCompare(String(b.name),'pt-BR') : (a.connected? -1 : 1));
      items.forEach(i=>{
        if (i.id == null) return;
        const lab = document.createElement('label');
        lab.className = 'chk-line';
        const labelTxt = [
          i.name || i.slug,
          i.number ? ` • ${i.number}` : '',
          i.connected ? '' : ' • offline'
        ].join('');
        lab.innerHTML = `
          <input type="checkbox" name="inst-edit" value="${i.id}">
          <span>${labelTxt}</span>
        `;
        const cb = lab.querySelector('input');
        if (cb && current.has(String(i.id))) cb.checked = true;
        editGrid.appendChild(lab);
      });
    }

    // ações
    const selectAllBtn = wrap.querySelector('#inst-select-all');
    const clearBtn     = wrap.querySelector('#inst-clear');
    if (selectAllBtn){
      selectAllBtn.onclick = ()=> editGrid.querySelectorAll('input[name="inst-edit"]').forEach(cb=> cb.checked = true);
    }
    if (clearBtn){
      clearBtn.onclick = ()=> editGrid.querySelectorAll('input[name="inst-edit"]').forEach(cb=> cb.checked = false);
    }
  }

  // ====== Mapeia nomes alternativos vindos da API ======
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
      // borda verde
      badge.style.border = '1px solid #22c55e';
      badge.style.color  = '#22c55e';
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
    const fSetor = $('#c-setor'); // compat
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
  // Preferir avatar do colaborador; depois do usuário; por fim avatar_url do payload
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

    // Instâncias (visual)
    await renderInstsView(colab);

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
    if (!wrap.dataset.viewHtml) wrap.dataset.viewHtml = wrap.innerHTML; // cache
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

  // ---- validação ----
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
    const telOk   = telDigits.length >= 10;   // 10/11 dígitos
    const cargoOk = cargo.length >= 2;

    if (!nomeOk)  msgs.push('• Nome completo (mín. 2 letras)');
    if (!emailOk) msgs.push('• E-mail inválido');
    if (!setorOk) msgs.push('• Departamento (selecione um)');
    if (!telOk)   msgs.push('• Telefone com DDD (10–11 dígitos)');
    if (!cargoOk) msgs.push('• Cargo (mín. 2 letras)');

    // marca visual apenas se deve mostrar
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

    // Topo: só "Fechar" (mantemos oculto pelo CSS); usamos rodapé dinâmico
    pEdit.style.display   = 'none';
    pSave.style.display   = 'none';
    pCancel.style.display = 'none';
    if (pClose) pClose.style.display = '';

    // Rodapé: Salvar/Cancelar no lugar do Fechar
    ensureFooterButtons();
    if (pSaveFoot)   pSaveFoot.style.display = '';
    if (pCancelFoot) pCancelFoot.style.display = '';
    if (pClose2)     pClose2.style.display = 'none';

    // Botão "Salvar" vira "Criar" no modo novo
    if (perfilModal.dataset.mode === 'create') {
      pSaveFoot.innerHTML = '<i class="fa fa-check"></i> Criar';
    } else {
      pSaveFoot.innerHTML = '<i class="fa fa-check"></i> Salvar';
    }

    perfilModal.classList.add('editing');

    // ---- campos editáveis ----
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

    // preencher valores atuais (edição) / vazios (criação)
    $('#e-nome').value  = coalesceName(state.viewing) || '';
    $('#e-email').value = coalesceEmail(state.viewing) || '';
    $('#e-tel').value   = (coalescePhone(state.viewing) ? maskPhoneBR(coalescePhone(state.viewing)) : '');
    $('#e-cargo').value = coalesceCargo(state.viewing) || '';

    // badge Admin também no modo edição (segue cargo digitado)
    renderAdminBadge({ ...state.viewing, cargo: $('#e-cargo').value });

    // Máscaras e saneamentos
    $('#e-nome')?.addEventListener('input', ()=>{
      const el = $('#e-nome');
      let v = el.value.replace(/[0-9]/g,'');      // sem dígitos no nome
      v = v.replace(/\s{2,}/g,' ');
      el.value = v;
      validateFormLive();
    });
    $('#e-email')?.addEventListener('input', ()=>{
      const el = $('#e-email');
      el.value = el.value.replace(/\s+/g,'').toLowerCase(); // sem espaço e minúsculo
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

    // Permissões (se for criação, já mostra)
    if (perfilModal.dataset.mode === 'create'){
      ensurePermsEdit();
      ePerms.style.display = 'grid';
    }

    // Instâncias (WhatsApp) – sempre mostrar no modo edição
    ensureInstsEdit();

    // Iniciar com validação aplicada (sem mostrar erros ainda)
    validateFormLive(false);
  }

  function exitInlineEdit(restore=true){
    // restaura wrappers
    restoreFieldbox('fb-nome');
    restoreFieldbox('fb-email');
    restoreFieldbox('fb-depto');
    restoreFieldbox('fb-tel');
    restoreFieldbox('fb-cargo');

    state.inlineEdit = false;
    state.showErrors = false;

    // Topo: volta ao normal
    pEdit.style.display   = '';
    pSave.style.display   = 'none';
    pCancel.style.display = 'none';
    if (pClose) pClose.style.display = 'none';

    // Rodapé: volta Fechar; esconde botões de ação
    if (pClose2)     pClose2.style.display = '';
    if (pSaveFoot)   pSaveFoot.style.display = 'none';
    if (pCancelFoot) pCancelFoot.style.display = 'none';

    perfilModal.classList.remove('editing');

    if (restore && state.viewing) renderPerfilView(state.viewing);
  }

  async function saveInline(){
    // 1) valida “silencioso”
    validateFormLive(false);

    const mode = perfilModal.dataset.mode || 'view';
    const id = Number(perfilModal.dataset.currentId||'0')||0;

    const { eNome, eEmail, eSetor, eTel, eCargo } = getEditInputs();
    const nome  = eNome?.value.trim();
    const email = eEmail?.value.trim();
    const setor = eSetor?.value || '';
    const tel   = eTel?.value || '';
    const cargo = eCargo?.value || '';

    // 2) valida final + exibe erro via toast e sublinhado
    state.showErrors = true;
    const check = validateFormLive(true);

    if (!check.ok){
      toast('Corrija os campos:\n' + check.msgs.join('\n'),'warn');
      return;
    }

    // Instâncias marcadas
    const instsSel = getInstsSelecionadasEdit();

    if (mode === 'create'){
      // Criação: envia FormData (inclui avatar, permissões e instâncias)
      const fd = new FormData();
      fd.append('nome', nome);
      fd.append('email', email);
      fd.append('setor_id', String(Number(setor)));
      fd.append('telefone', telE164(tel));
      fd.append('cargo', (cargo||'').trim());

      const permsCreate = getPermsSelecionadasEdit();
      if (permsCreate.length) fd.append('permissoes', JSON.stringify(permsCreate));
      if (instsSel.length)    fd.append('instancias_ids', JSON.stringify(instsSel));

      if (state.newAvatarFile) fd.append('avatar', state.newAvatarFile);

      try{
        const created = await apiForm('/api/colaboradores/', 'POST', fd);
        toast('Colaborador criado.');

        // reseta estado "novo"
        state.newAvatarFile = null;
        state.showErrors = false;

        perfilModal.dataset.mode = 'view';
        perfilModal.dataset.currentId = String(created?.id||'');
        const fresh = await loadColabFull(created.id);
        // força instâncias visualizadas após criar
        fresh.instancias_ids = instsSel;

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

    // Edição normal
    const payload = {
      nome, email,
      setor_id: Number(setor),
      telefone: telE164(tel),
      cargo: (cargo||'').trim(),
      instancias_ids: instsSel, // se o back ignorar, salvamos via fallback saveInsts()
      atualizar_usuario: !!state.viewing?.usuario_id
    };

    try{
      await apiJSON(`/api/colaboradores/${id}`, 'PUT', payload);

      // se permissões estiverem ativas:
      let permsUpdated = false;
      if (ePerms.style.display !== 'none'){
        const arr = getPermsSelecionadasEdit();
        permsUpdated = await savePerms(id, arr);
        if (permsUpdated) state.viewing.permissoes = arr;
      }

      // salvar instâncias via endpoint dedicado (fallback)
      let instsUpdated = true;
      try{
        instsUpdated = await saveInsts(id, instsSel);
      }catch{ instsUpdated = false; }

      state.showErrors = false;
      const msg = [
        'Alterações salvas.',
        permsUpdated ? 'Permissões OK.' : '',
        instsUpdated ? 'Instâncias OK.' : ''
      ].filter(Boolean).join(' ');
      toast(msg || 'Alterações salvas.');

      // Revalida com o servidor
      const fresh = await loadColabFull(id);
      fresh.instancias_ids = instsSel; // garante espelho no front mesmo se o back não devolver já
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
    // objeto vazio
    const blank = { id:null, nome:'', email:'', telefone:'', cargo:'', setor_id:null, permissoes:[], instancias_ids:[] };
    perfilModal.dataset.mode = 'create';
    perfilModal.dataset.currentId = '';
    state.showErrors = false;
    await renderPerfilView(blank);

    // ativa listeners do hint
    if (btnAddAvatar && pAvatarInput){
      btnAddAvatar.onclick = ()=> pAvatarInput.click();
      pAvatarInput.onchange = ()=> handleAvatarFile(pAvatarInput.files && pAvatarInput.files[0]);
    }

    // clicar no avatar para escolher arquivo + drag&drop (só no create)
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

    // abre modal e entra em edição
    perfilModal.setAttribute('aria-hidden','false');
    document.documentElement.classList.add('modal-open');
    enterInlineEdit(); // entra em edição após abrir (com validação live)
  }

  // ====== Events ======
  function bind(){
    // filtros
    filtroTxt?.addEventListener('input', debounce(()=>{
      state.filtroTexto = filtroTxt.value.trim();
      renderLista();
    },160));
    filtroDepto?.addEventListener('change', ()=>{ state.filtroSetorId = filtroDepto.value; renderLista(); });
    btnFiltrar?.addEventListener('click', renderLista);

    // novo
    btnAdd?.addEventListener('click', openNovo);

    // Ações da tabela
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

    // Perfil modal – botões
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
    pSave?.addEventListener('click', saveInline); // (topo oculto, mantemos por segurança)

    // clicar fora fecha
    perfilModal?.addEventListener('mousedown', (ev)=>{
      const card = perfilModal.querySelector('.modal-card');
      if (card && !card.contains(ev.target)) closePerfil();
    });
    perfilModal?.querySelector('.modal-card')?.addEventListener('mousedown', ev => ev.stopPropagation());

    // ESC fecha modal
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
