/* Colaboradores – lista + modal de perfil (visualização/edição) e fluxo de criação
   (versão com: troca de senha em edição, validação opcional da senha, salvamento de instâncias,
   correção de refs DOM recriadas nas fieldboxes + limpeza de erros ao trocar de colaborador
   + salvamento de PERMISSÕES por colaborador em /api/permissoes/colaboradores/{id}
   + respeito à permissão colaboradores.redefinir_senha para mexer em senha
   + modal de confirmação custom para remoção de colaborador (#zc-confirm)
   + horário de expediente (hora_login_inicio / hora_login_fim) com validação HH:MM
   + 🔐 flag de empresa requer_token_login controlado na página de colaboradores
   + 🕘 herança de horário do departamento + toggle “Personalizar horário”
   + ✅ FIX: depto padrão vindo como hora_login_inicio_padrao/fim_padrao
   + ✅ FIX: quando colaborador tem setor_id (setor) mas horário está no departamento, faz fallback por nome
   + ✅ NOVO: coluna "Foto" na lista (avatar mini com fallback de iniciais + cache local de thumbs + avatar_url)
) */
(function ColaboradoresPage(){
  'use strict';

  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];

  const LS = localStorage;
  const EMPRESA_ID = Number(LS.getItem('empresa_id') || '') || null;

  const normStr = (s)=> String(s||'')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

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

  const VIEW_PERM       = 'colaboradores.ver';
  const EDIT_PERM       = 'colaboradores.gerenciar';
  const RESET_PASS_PERM = 'colaboradores.redefinir_senha';

  const state = {
    setores: [],
    colaboradores: [],
    filtroTexto: '',
    filtroSetorId: '',
    permsSet: null,

    viewing: null,
    inlineEdit: false,

    newAvatarFile: null,
    instsCache: null,
    showErrors: false,
    empresa: null,

    avatarThumbCache: new Map(),
    avatarThumbInflight: new Map()
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
  const canEditPassword = () => hasPerm(RESET_PASS_PERM) || hasPerm(EDIT_PERM);

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

  const confirmModal = $('#zc-confirm');
  const confirmMsgEl = confirmModal ? confirmModal.querySelector('.zc-confirm-message') : null;

  function showConfirm(message){
    if (!confirmModal) return Promise.resolve(window.confirm(message || 'Confirmar ação?'));

    if (confirmMsgEl) confirmMsgEl.textContent = message || 'Confirmar ação?';
    confirmModal.setAttribute('aria-hidden','false');
    document.documentElement.classList.add('modal-open');

    return new Promise(resolve=>{
      const onClick = (ev)=>{
        const btn = ev.target.closest('[data-confirm]');
        if (!btn) return;
        cleanup(btn.getAttribute('data-confirm') === 'yes');
      };
      const onKey = (ev)=>{ if (ev.key === 'Escape') cleanup(false); };
      const onBackdrop = (ev)=>{ if (ev.target === confirmModal) cleanup(false); };

      function cleanup(result){
        confirmModal.setAttribute('aria-hidden','true');
        document.documentElement.classList.remove('modal-open');
        confirmModal.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey);
        confirmModal.removeEventListener('mousedown', onBackdrop);
        resolve(result);
      }
      confirmModal.addEventListener('click', onClick);
      document.addEventListener('keydown', onKey);
      confirmModal.addEventListener('mousedown', onBackdrop);
    });
  }

  const filtroTxt   = $('#filtro');
  const filtroDepto = $('#filtro-depto');
  const btnFiltrar  = $('#btn-filtrar');
  const btnAdd      = $('#btn-add-colaborador');
  const tbody       = $('#tabela-colaboradores');
  const emptyState  = $('#empty-state');
  const countEl     = $('#count-colaboradores');
  const chkRequerToken = $('#chk-requer-token');

  const perfilModal  = $('#modal-perfil');
  const pClose       = $('#perfil-fechar');
  const pClose2      = $('#perfil-fechar2');
  const pEdit        = $('#perfil-editar');
  const pSave        = $('#perfil-salvar');
  const pCancel      = $('#perfil-cancelar');
  const pTitle       = $('#perfil-title');

  const pAvatar  = $('#p-avatar');
  const pMono    = $('#p-mono');
  const dStatus  = $('#p-status');
  const dStatusText = $('#p-status-text');

  const avatarHint   = $('#avatar-hint');
  const btnAddAvatar = $('#btn-add-avatar');
  const pAvatarInput = $('#p-avatar-input');

  const dPerms   = $('#d-perms');
  const ePerms   = $('#e-perms');

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
      pCancelFoot.addEventListener('click', ()=>{
        if (perfilModal?.dataset.mode === 'create') closePerfil();
        else exitInlineEdit(true);
      });
      footEl.insertBefore(pCancelFoot, pSaveFoot);
    }
  }

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

  function maskTimeInput(el){
    if (!el) return;
    let v = String(el.value || '').replace(/[^\d]/g,'');
    if (v.length > 4) v = v.slice(0,4);
    if (v.length >= 3) v = v.slice(0,2) + ':' + v.slice(2);
    el.value = v;
  }
  function isValidTimeHHMM(str){
    if (!str) return false;
    const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
    if (!m) return false;
    const h = Number(m[1]), mm = Number(m[2]);
    return h >= 0 && h <= 23 && mm >= 0 && mm <= 59;
  }
  function timeToMinutes(str){
    const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
    if (!m) return null;
    const h = Number(m[1]), mm = Number(m[2]);
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
    return h*60 + mm;
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

  function getDeptHorarioById(setorId, setorNome){
    let s = state.setores.find(x => String(x.id) === String(setorId));
    if (!s && setorNome){
      const alvo = normStr(setorNome);
      s = state.setores.find(x => normStr(x?.nome) === alvo);
    }

    const ini = (s && (
      s.hora_login_inicio_padrao ?? s.hora_login_inicio ??
      s.hora_inicio ?? s.expediente_inicio ?? s.horario_inicio ??
      s.inicio_expediente ?? s.hora_entrada ?? s.entrada ??
      s.expediente?.inicio ?? s.horario?.inicio
    )) || '';

    const fim = (s && (
      s.hora_login_fim_padrao ?? s.hora_login_fim ??
      s.hora_fim ?? s.expediente_fim ?? s.horario_fim ??
      s.fim_expediente ?? s.hora_saida ?? s.saida ??
      s.expediente?.fim ?? s.horario?.fim
    )) || '';

    return { ini: String(ini||''), fim: String(fim||''), has: !!(ini || fim), dept: s || null };
  }

  function renderDeptHintBySetorId(setorId, opts={}){
    const el = document.getElementById('dept-exp-hint');
    if (!el) return;

    const setorNome = opts.setorNome || '';
    const { ini, fim, has } = getDeptHorarioById(setorId, setorNome);

    if (!has){
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }

    const personalizar = !!opts.personalizar;
    const linha2 = personalizar
      ? '⚙️ <strong>Este colaborador está com horário personalizado.</strong>'
      : '✅ <strong>O colaborador usa esse horário automaticamente.</strong>';

    const cta = personalizar
      ? '<span style="opacity:.85">(desmarque “Personalizar horário” para voltar ao padrão.)</span>'
      : '<span style="opacity:.85">(marque “Personalizar horário” se precisar diferente.)</span>';

    el.style.display = 'block';
    el.innerHTML = `
      <strong>Horário padrão do departamento:</strong> ${ini || '—'}–${fim || '—'}<br>
      ${linha2}<br>
      ${cta}
    `.trim();
  }

  function applyExpPersonalizarUI(){
    const rowToggle = document.getElementById('row-exp-toggle');
    const rowIni    = document.getElementById('row-exp-ini');
    const rowFim    = document.getElementById('row-exp-fim');
    const tgl       = document.getElementById('e-exp-personalizar');
    if (!tgl || !rowIni || !rowFim) return;

    if (rowToggle) rowToggle.style.display = state.inlineEdit ? '' : 'none';

    const on = !!tgl.checked;
    rowIni.style.display = on ? '' : 'none';
    rowFim.style.display = on ? '' : 'none';

    const sel = document.getElementById('e-setor');
    const setorId = sel?.value || '';
    const setorNome = sel?.options?.[sel.selectedIndex]?.text || '';

    renderDeptHintBySetorId(setorId, { personalizar: on, setorNome });

    if (on){
      const eIni = document.getElementById('e-exp-ini');
      const eFim = document.getElementById('e-exp-fim');
      if (eIni && eFim && !String(eIni.value||'').trim() && !String(eFim.value||'').trim()){
        const { ini, fim } = getDeptHorarioById(setorId, setorNome);
        if (ini) eIni.value = ini;
        if (fim) eFim.value = fim;
      }
    } else {
      const eIni = document.getElementById('e-exp-ini');
      const eFim = document.getElementById('e-exp-fim');
      if (eIni) eIni.value = '';
      if (eFim) eFim.value = '';
    }
  }

  async function fetchInstances(){
    if (state.instsCache) return state.instsCache;
    let arr = [];
    if (EMPRESA_ID){
      try{
        const data = await apiGet(`/api/empresas/${EMPRESA_ID}/whatsapp`);
        const normInstances = (items)=>{
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
        };
        arr = normInstances(Array.isArray(data?.instancias) ? data.instancias : (Array.isArray(data) ? data : []));
      }catch{}
    }
    state.instsCache = arr;
    return arr;
  }

  function coalesceInstIds(c){
    const raw = c?.instancias_ids ?? c?.instances_ids ?? c?.whatsapp_instancias_ids
             ?? c?.whatsapp_ids ?? c?.whatsapps_ids ?? c?.instancias ?? c?.instances ?? null;
    if (!raw) return [];
    if (Array.isArray(raw)){
      if (raw.length && typeof raw[0] === 'object'){
        return raw.map(x=> Number(x.id ?? x.instancia_id ?? x.instance_id ?? x.value)).filter(n=> !Number.isNaN(n));
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

  function ensureInstsSection(){
    let full = document.getElementById('insts-full');
    if (!full){
      full = document.createElement('div');
      full.id = 'insts-full';
      full.className = 'full';
      full.innerHTML = `
        <dt>WhatsApps</dt>
        <dd>
          <div id="insts-wrap" class="fieldbox">
            <label style="display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap">
              Quais WhatsApps este atendente pode acessar?
              <span class="muted">(marque um ou mais — opcional)</span>
            </label>

            <div id="inst-actions" style="display:none;gap:.5rem;margin:.35rem 0 .5rem 0">
              <button type="button" id="inst-select-all" class="btn btn-ghost" style="padding:.25rem .5rem;font-size:.85rem">Selecionar todos</button>
              <button type="button" id="inst-clear" class="btn btn-ghost" style="padding:.25rem .5rem;font-size:.85rem">Limpar</button>
            </div>

            <div id="e-insts" style="display:none;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:.5rem"></div>
            <div id="d-insts" class="chips" style="display:flex;flex-wrap:wrap;gap:.5rem"></div>
          </div>
        </dd>
      `;

      const permFull =
        dPerms?.closest('.full') ||
        ePerms?.closest('.full') ||
        dPerms?.parentElement?.closest('.full') ||
        ePerms?.parentElement?.closest('.full');

      const grid = document.querySelector('#details-grid, .details-grid');
      if (permFull && permFull.parentElement){
        permFull.parentElement.insertBefore(full, permFull);
      } else if (grid){
        grid.appendChild(full);
      }
    }
    return full.querySelector('#insts-wrap');
  }

  async function renderInstsView(colab){
    const wrap = ensureInstsSection();
    const chipsWrap = wrap.querySelector('#d-insts');
    const editGrid  = wrap.querySelector('#e-insts');
    const actions   = wrap.querySelector('#inst-actions');
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

    const selectAllBtn = wrap.querySelector('#inst-select-all');
    const clearBtn     = wrap.querySelector('#inst-clear');
    if (selectAllBtn){
      selectAllBtn.onclick = ()=> editGrid.querySelectorAll('input[name="inst-edit"]').forEach(cb=> cb.checked = true);
    }
    if (clearBtn){
      clearBtn.onclick = ()=> editGrid.querySelectorAll('input[name="inst-edit"]').forEach(cb=> cb.checked = false);
    }
  }

  function coalescePhone(c){
    return c?.telefone ?? c?.telefone_norm ?? c?.phone ?? c?.celular ?? c?.whatsapp ?? c?.fone
        ?? c?.usuario?.telefone ?? c?.user?.phone ?? '';
  }
  function coalesceDeptId(c){
    if (!c) return null;
    return (
      c.setor_id ?? c.departamento_id ?? c.dep_id ?? c.depto_id ?? c.dept_id ??
      c.setor?.id ?? c.departamento?.id ?? c.depto?.id ??
      null
    );
  }
  function coalesceDeptName(c){
    if (!c) return null;
    return (
      c.setor_nome ?? c.departamento_nome ?? c.departamento ?? c.depto_nome ?? c.dep_nome ??
      c.setor?.nome ?? c.departamento?.nome ?? c.depto?.nome ??
      null
    );
  }
  function coalesceName(c){
    return c?.nome ?? c?.nome_completo ?? c?.display_name ?? c?.full_name
        ?? c?.usuario?.nome ?? c?.user?.name ?? '';
  }
  function coalesceEmail(c){
    return c?.email ?? c?.usuario?.email ?? c?.user?.email ?? '';
  }
  function coalesceCargo(c){
    return c?.cargo ?? c?.funcao ?? c?.usuario?.cargo ?? c?.user?.job_title ?? '';
  }
  function coalesceHorarioInicio(c){
    return c?.hora_login_inicio
        ?? c?.hora_inicio
        ?? c?.horario_inicio
        ?? c?.expediente_inicio
        ?? c?.inicio_expediente
        ?? c?.hora_entrada
        ?? null;
  }
  function coalesceHorarioFim(c){
    return c?.hora_login_fim
        ?? c?.hora_fim
        ?? c?.horario_fim
        ?? c?.expediente_fim
        ?? c?.fim_expediente
        ?? c?.hora_saida
        ?? null;
  }

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
      badge.style.border = '1px solid #22c55e';
      badge.style.color  = '#22c55e';
      label.appendChild(badge);
    }
    badge.style.display = isAdminFlag(colab) ? '' : 'none';
  }

  async function loadSetores(){
    const tries = ['/api/departamentos','/api/departamentos/tree','/api/atendimento/clientes/departamentos','/api/atendimento/clientes/departamentos/tree'];
    for (const u of tries){
      try{
        const data = await apiGet(u);
        const arr = Array.isArray(data) ? data : (data?.items || data?.data || []);
        if (arr?.length){
          const out = [];
          const seen = new Set();

          const getId   = (x)=> x?.id ?? x?.dep_id ?? x?.departamento_id ?? x?.setor_id ?? x?.value ?? x?.ID ?? x?.Id;
          const getName = (x)=> x?.nome ?? x?.name ?? x?.titulo ?? x?.label ?? x?.text ?? '—';

          const getIni = (x)=>
            x?.hora_login_inicio_padrao ??
            x?.hora_login_inicio ?? x?.hora_inicio ?? x?.expediente_inicio ?? x?.horario_inicio ??
            x?.inicio_expediente ?? x?.hora_entrada ?? x?.entrada ??
            x?.expediente?.inicio ?? x?.horario?.inicio ?? null;

          const getFim = (x)=>
            x?.hora_login_fim_padrao ??
            x?.hora_login_fim ?? x?.hora_fim ?? x?.expediente_fim ?? x?.horario_fim ??
            x?.fim_expediente ?? x?.hora_saida ?? x?.saida ??
            x?.expediente?.fim ?? x?.horario?.fim ?? null;

          const getKids = (x)=> x?.filhos ?? x?.children ?? x?.itens ?? x?.items ?? x?.nodes ?? x?.departamentos ?? x?.subdepartamentos ?? x?.sub ?? [];

          const walk = (node)=>{
            if (!node) return;
            const id0  = getId(node);
            const id   = (id0 == null) ? null : String(id0);
            const nome = String(getName(node) ?? '—');

            if (id && !seen.has(id)){
              seen.add(id);
              const ini = getIni(node);
              const fim = getFim(node);
              out.push({
                id,
                nome,
                hora_login_inicio_padrao: (ini != null) ? String(ini) : null,
                hora_login_fim_padrao:    (fim != null) ? String(fim) : null,
                hora_login_inicio:        (ini != null) ? String(ini) : null,
                hora_login_fim:           (fim != null) ? String(fim) : null
              });
            }

            const kids = getKids(node);
            if (Array.isArray(kids)) kids.forEach(walk);
          };

          (Array.isArray(arr) ? arr : [arr]).forEach(walk);
          state.setores = out;
          renderSetores();
          return;
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
      console.error(e);
      state.colaboradores = [];
      toast('Erro ao carregar colaboradores.','err');
    }
  }

  async function loadEmpresa(force){
    if (!EMPRESA_ID) return null;
    if (!force && state.empresa) return state.empresa;
    try{
      const data = await apiGet(`/api/empresas/${EMPRESA_ID}`);
      state.empresa = data;
      if (chkRequerToken) chkRequerToken.checked = !!data.requer_token_login;
      return data;
    }catch{
      return null;
    }
  }

  async function saveEmpresaLoginConfig(requerToken){
    if (!EMPRESA_ID) return;
    const payload = { requer_token_login: !!requerToken };
    try{
      const resp = await apiJSON(`/api/empresas/${EMPRESA_ID}/login-config`, 'PUT', payload);
      state.empresa = resp || { ...(state.empresa || {}), requer_token_login: !!requerToken };
      toast('Configuração de login atualizada.');
    }catch(e){
      console.warn('Falha ao atualizar requer_token_login', e);
      toast('Não foi possível salvar a configuração de login.','err');
      if (chkRequerToken && state.empresa) chkRequerToken.checked = !!state.empresa.requer_token_login;
    }
  }

  function renderSetores(){
    const filtroDepto = $('#filtro-depto');
    const fSetor = $('#c-setor');
    if (filtroDepto){
      const first = filtroDepto.querySelector('option');
      filtroDepto.innerHTML='';
      if (first) filtroDepto.appendChild(first);
      state.setores.forEach(s => filtroDepto.appendChild(new Option(s.nome,s.id)));
    }
    if (fSetor){
      fSetor.innerHTML = '';
      state.setores.forEach(s => fSetor.appendChild(new Option(s.nome,s.id)));
    }
  }

  function revokeBlobURL(u){
    try{
      if (u && String(u).startsWith('blob:')) URL.revokeObjectURL(u);
    }catch{}
  }
  function clearAvatarThumbCache(){
    for (const v of state.avatarThumbCache.values()){
      if (typeof v === 'string') revokeBlobURL(v);
    }
    state.avatarThumbCache.clear();
    state.avatarThumbInflight.clear();
  }
  window.addEventListener('beforeunload', clearAvatarThumbCache);

  async function fetchAvatarThumbURLFor(colab){
    const id = Number(colab?.id || 0) || 0;
    if (!id) return colab?.avatar_url || null;

    if (state.avatarThumbCache.has(id)) return state.avatarThumbCache.get(id);
    if (state.avatarThumbInflight.has(id)) return state.avatarThumbInflight.get(id);

    const p = (async ()=>{
      let url = null;

      try{
        const r1 = await authFetch(withEmpresa(`/api/colaboradores/${id}/avatar`));
        if (r1.ok && r1.status === 200){
          const blob = await r1.blob();
          url = URL.createObjectURL(blob);
        }
      }catch{}

      if (!url && colab?.usuario_id){
        try{
          const r2 = await authFetch(withEmpresa(`/api/usuarios/${colab.usuario_id}/avatar`));
          if (r2.ok && r2.status === 200){
            const blob = await r2.blob();
            url = URL.createObjectURL(blob);
          }
        }catch{}
      }

      if (!url && colab?.avatar_url){
        url = colab.avatar_url;
      }

      state.avatarThumbCache.set(id, url || null);
      return url || null;
    })().finally(()=>{
      state.avatarThumbInflight.delete(id);
    });

    state.avatarThumbInflight.set(id, p);
    return p;
  }

  function mountMiniAvatarInto(td, colab){
    if (!td) return;

    const name = coalesceName(colab) || coalesceEmail(colab) || `#${colab?.id||''}`;

    const wrap = document.createElement('div');
    wrap.className = 'avatar-mini';
    wrap.style.background = hashColor(String(name));

    const span = document.createElement('span');
    span.className = 'avatar-mini-initials';
    span.textContent = initials(name);

    const img = document.createElement('img');
    img.className = 'avatar-mini-img';
    img.alt = name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.style.display = 'none';

    img.onload = () => {
      img.style.display = 'block';
      span.style.display = 'none';
      wrap.style.background = 'transparent';
    };

    img.onerror = () => {
      img.removeAttribute('src');
      img.style.display = 'none';
      span.style.display = 'grid';
    };

    wrap.appendChild(span);
    wrap.appendChild(img);
    td.innerHTML = '';
    td.appendChild(wrap);

    fetchAvatarThumbURLFor(colab).then((url)=>{
      if (!td.isConnected || !url) return;
      img.src = url;
    }).catch(()=>{});
  }

  function renderLista(){
    const q = (state.filtroTexto||'').toLowerCase();
    const depId = String(state.filtroSetorId||'');

    const depSelName = depId ? (state.setores.find(s => String(s.id)===depId)?.nome || '') : '';
    const depSelNorm = depSelName ? normStr(depSelName) : '';

    const rows = state.colaboradores
      .filter(c => {
        if (!q) return true;
        const name  = coalesceName(c);
        const email = coalesceEmail(c);
        const phone = coalescePhone(c);
        const cargo = coalesceCargo(c);
        return [name, email, phone, cargo].some(v => String(v||'').toLowerCase().includes(q));
      })
      .filter(c => {
        if (!depId) return true;
        const cid = String(coalesceDeptId(c) ?? '');
        if (cid && cid === depId) return true;
        const cn = coalesceDeptName(c) || state.setores.find(s => String(s.id)===cid)?.nome || '';
        if (cn && depSelNorm) return normStr(cn) === depSelNorm;
        return false;
      });

    if (countEl) countEl.textContent = rows.length;
    if (tbody) tbody.innerHTML = '';
    if (!rows.length){
      if (emptyState) emptyState.style.display='flex';
      return;
    }
    if (emptyState) emptyState.style.display='none';

    rows.forEach((c,i)=>{
      const depName = coalesceDeptName(c)
        || state.setores.find(s => String(s.id)===String(coalesceDeptId(c)))?.nome
        || '-';

      const name  = coalesceName(c) || '-';
      const email = coalesceEmail(c) || '-';
      const id    = c?.id ?? '';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i+1}</td>
        <td class="td-avatar"></td>
        <td>${name}</td>
        <td>${email}</td>
        <td>${depName}</td>
        <td class="td-actions">
          <button class="btn btn-ghost" data-action="view" data-id="${id}" title="Ver perfil"><i class="fa fa-pen"></i></button>
          <button class="btn btn-ghost" data-action="del"  data-id="${id}" title="Remover"><i class="fa fa-trash"></i></button>
        </td>
      `.trim();

      tbody.appendChild(tr);
      const tdAv = tr.querySelector('.td-avatar');
      mountMiniAvatarInto(tdAv, c);
    });
  }

  function replaceExt(name, ext){
    return (name || 'avatar').replace(/\.[^.]+$/, '') + ext;
  }
  function convertToPng(file){
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try{
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          canvas.toBlob((blob) => {
            if (!blob) return reject(new Error('toBlob falhou'));
            const out = new File([blob], replaceExt(file.name, '.png'), { type: 'image/png' });
            URL.revokeObjectURL(url);
            resolve(out);
          }, 'image/png', 0.92);
        }catch(e){
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }
  async function uploadAvatarTo(url, file){
    const fieldNames = ['avatar','file','upload'];
    for (const name of fieldNames){
      const fd = new FormData();
      fd.append(name, file);
      try {
        await apiForm(url, 'PUT', fd);
        return true;
      } catch(e) {}
    }
    return false;
  }
  function setPerfilAvatar(nome, url){
    if (url){
      if (pAvatar){ pAvatar.src=url; pAvatar.style.display='block'; }
      if (pMono)  pMono.style.display='none';
    } else {
      if (pMono){
        pMono.textContent = initials(nome);
        pMono.style.display='grid';
        pMono.parentElement && (pMono.parentElement.style.background = hashColor(nome||'zapschat'));
      }
      if (pAvatar){ pAvatar.removeAttribute('src'); pAvatar.style.display='none'; }
    }
  }
  async function fetchAvatarURLFor(colab){
    if (!colab || !colab.id) return colab && colab.avatar_url ? colab.avatar_url : null;
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

  async function handleAvatarFile(file){
    if (!file) return;

    const okByMime = /^image\//i.test(file.type || '');
    const okByExt  = /\.(png|jpe?g|webp|gif|bmp|svg|avif|heic|heif)$/i.test(file.name || '');
    if (!okByMime && !okByExt){
      toast('Envie uma imagem (PNG, JPG, WEBP, GIF, SVG, AVIF, HEIC).','warn');
      return;
    }
    const needConvert = /image\/(webp|avif|heic|heif)/i.test(file.type || '') ||
                        /\.(webp|avif|heic|heif)$/i.test(file.name || '');
    if (needConvert){
      try { file = await convertToPng(file); } catch(e){}
    }
    state.newAvatarFile = file;
    const url = URL.createObjectURL(file);
    setPerfilAvatar($('#e-nome')?.value || coalesceName(state.viewing) || 'Novo Colaborador', url);
  }

  function bindAvatarDnDAndPaste(){
    const avatarWrap = $('#avatar-wrap');
    const fileInput  = $('#p-avatar-input');
    if (!avatarWrap) return;

    if (fileInput){
      fileInput.setAttribute('accept','image/*,.svg,.webp,.avif,.heic,.heif');
      avatarWrap.onclick = () => { fileInput.value = ''; fileInput.click(); };
      fileInput.onchange = () => handleAvatarFile(fileInput.files?.[0] || null);
    }

    if (avatarWrap.dataset.dndBound !== '1'){
      avatarWrap.dataset.dndBound = '1';

      const onDragOver = (e)=>{ e.preventDefault(); e.stopPropagation(); avatarWrap.classList.add('drag-over'); };
      const onDragLeave= (e)=>{ e.preventDefault(); e.stopPropagation(); avatarWrap.classList.remove('drag-over'); };
      const onDrop = (e)=>{
        e.preventDefault(); e.stopPropagation();
        avatarWrap.classList.remove('drag-over');
        const f = e.dataTransfer?.files?.[0];
        if (f) handleAvatarFile(f);
      };
      ['dragenter','dragover'].forEach(ev=> avatarWrap.addEventListener(ev, onDragOver));
      ['dragleave','dragend'].forEach(ev=> avatarWrap.addEventListener(ev, onDragLeave));
      avatarWrap.addEventListener('drop', onDrop);
    }

    if (!window.__avatarPasteBound){
      window.__avatarPasteBound = true;
      window.addEventListener('paste', async (e)=>{
        const files = e.clipboardData?.files;
        if (files && files.length){
          handleAvatarFile(files[0]);
          return;
        }
        const items = e.clipboardData?.items || [];
        for (const it of items){
          if (it.type && it.type.indexOf('image') === 0){
            const blob = it.getAsFile();
            if (blob) {
              handleAvatarFile(new File([blob], 'clipboard.png', { type: blob.type || 'image/png' }));
              return;
            }
          }
          if (it.type === 'text/plain'){
            const url = await new Promise(r => it.getAsString(r));
            if (/^https?:\/\/.+\.(png|jpe?g|webp|gif|svg|avif|heic|heif)(\?.*)?$/i.test(url)){
              try{
                const res = await fetch(url);
                const b   = await res.blob();
                const name = url.split('/').pop()?.split('?')[0] || 'image';
                handleAvatarFile(new File([b], name, { type: b.type || 'image/png' }));
              }catch{}
            }
          }
        }
      });
    }
  }

  async function loadColabFull(id){
    const c = await apiGet(`/api/colaboradores/${id}`);
    try{
      const p = await apiGet(`/api/permissoes/colaboradores/${id}`);
      c.permissoes = Array.isArray(p) ? p : (p?.items || p?.data || []);
    }catch{}
    return c;
  }

  function setPlaceholderPerfil(){
    const vNome   = $('#v-nome');
    const vEmailA = $('#v-email');
    const vEmpresa= $('#v-empresa');
    const vDepto  = $('#v-depto');
    const vTelA   = $('#v-tel');
    const vCargo  = $('#v-cargo');
    const vExpIni = $('#v-exp-ini');
    const vExpFim = $('#v-exp-fim');

    if (pTitle) pTitle.textContent = 'Carregando…';
    if (vNome)  vNome.textContent = '—';
    if (vEmailA){ vEmailA.textContent = '—'; vEmailA.href = '#'; }
    if (vEmpresa) vEmpresa.textContent = '—';
    if (vDepto) vDepto.textContent = '—';
    if (vTelA){ vTelA.textContent = '—'; vTelA.href = '#'; }
    if (vCargo) vCargo.textContent = '—';
    if (vExpIni) vExpIni.textContent = '—';
    if (vExpFim) vExpFim.textContent = '—';
  }

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

  function markValidity(input, isValid, message){
    if (!input) return;
    const wrap = input.closest('.fieldbox') || input.parentElement;
    input.classList.toggle('invalid', !isValid);
    input.setAttribute('aria-invalid', String(!isValid));
    if (!wrap) return;

    let err = wrap.nextElementSibling;
    if (!err || !err.classList.contains('field-error')) {
      err = document.createElement('div');
      err.className = 'field-error';
      wrap.insertAdjacentElement('afterend', err);
    }

    wrap.classList.toggle('invalid', !isValid);

    if (!isValid && message) {
      err.textContent = message;
      err.style.display = 'block';
    } else {
      err.textContent = '';
      err.style.display = 'none';
    }
  }

  function clearValidationErrors(){
    document.querySelectorAll('#modal-perfil .field-error').forEach(el => el.remove());
    document.querySelectorAll('#modal-perfil .input.invalid, #modal-perfil .select.invalid, #modal-perfil .fieldbox.invalid')
      .forEach(el => {
        el.classList.remove('invalid');
        if (typeof el.removeAttribute === 'function') el.removeAttribute('aria-invalid');
      });
  }

  function setSaveEnabled(ok){
    [pSaveFoot, pSave].forEach(btn=>{
      if (!btn) return;
      btn.classList.toggle('btn-soft-disabled', !ok);
      btn.setAttribute('aria-disabled', String(!ok));
    });
  }

  function getEditInputs(){
    return {
      eNome:   $('#e-nome'),
      eEmail:  $('#e-email'),
      eSetor:  $('#e-setor'),
      eTel:    $('#e-tel'),
      eCargo:  $('#e-cargo'),
      eExpIni: $('#e-exp-ini'),
      eExpFim: $('#e-exp-fim'),
      eExpPersonalizar: $('#e-exp-personalizar')
    };
  }

  function validateFormLive(forceShow){
    const show = (typeof forceShow === 'boolean') ? forceShow : state.showErrors;

    const { eNome, eEmail, eSetor, eTel, eCargo, eExpIni, eExpFim, eExpPersonalizar } = getEditInputs();
    const nome   = eNome?.value.trim()   || '';
    const email  = (eEmail?.value || '').trim();
    const setor  = eSetor?.value || '';
    const tel    = eTel?.value   || '';
    const cargo  = eCargo?.value.trim()  || '';
    const hIni   = eExpIni?.value.trim() || '';
    const hFim   = eExpFim?.value.trim() || '';
    const expOn = !!eExpPersonalizar?.checked;

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

    markValidity(eNome,  show ? nomeOk  : true,  nomeOk  ? '' : 'Nome completo (mín. 2 letras)');
    markValidity(eEmail, show ? emailOk : true, emailOk ? '' : 'E-mail inválido');
    markValidity(eSetor, show ? setorOk : true, setorOk ? '' : 'Selecione um departamento');
    markValidity(eTel,   show ? telOk   : true, telOk   ? '' : 'Telefone com DDD (10–11 dígitos)');
    markValidity(eCargo, show ? cargoOk : true, cargoOk ? '' : 'Cargo (mín. 2 letras)');

    let hIniOk = true;
    let hFimOk = true;
    let hOrderOk = true;

    if (expOn){
      hIniOk = isValidTimeHHMM(hIni);
      hFimOk = isValidTimeHHMM(hFim);

      if (!hIniOk) msgs.push('• Entrada do expediente no formato HH:MM');
      if (!hFimOk) msgs.push('• Saída do expediente no formato HH:MM');

      if (hIniOk && hFimOk){
        const mi = timeToMinutes(hIni);
        const mf = timeToMinutes(hFim);
        if (mi != null && mf != null && mi >= mf){
          hOrderOk = false;
          msgs.push('• Início do expediente deve ser antes do fim');
        }
      }

      if (eExpIni){
        const okField = hIniOk && hOrderOk;
        markValidity(eExpIni, show ? okField : true, okField ? '' : 'Informe no formato HH:MM (ex.: 08:00)');
      }
      if (eExpFim){
        const okField = hFimOk && hOrderOk;
        markValidity(eExpFim, show ? okField : true, okField ? '' : 'Informe no formato HH:MM (ex.: 18:00)');
      }
    } else {
      if (eExpIni) markValidity(eExpIni, true, '');
      if (eExpFim) markValidity(eExpFim, true, '');
      hIniOk = true; hFimOk = true; hOrderOk = true;
    }

    let senhaOk = true;
    const senhaEl  = document.querySelector('#e-senha');
    const isCreate = (perfilModal.dataset.mode === 'create');
    const canPass  = canEditPassword();

    if (senhaEl && canPass) {
      const s = (senhaEl.value || '').trim();
      if (isCreate) {
        senhaOk = s.length >= 6 && s.length <= 72;
        if (!senhaOk) msgs.push('• Senha (mín. 6 caracteres)');
        markValidity(senhaEl, show ? senhaOk : true, senhaOk ? '' : 'Senha (mín. 6 caracteres)');
      } else {
        if (s.length > 0) {
          senhaOk = s.length >= 6 && s.length <= 72;
          if (!senhaOk) msgs.push('• Senha (mín. 6 caracteres)');
          markValidity(senhaEl, show ? senhaOk : true, senhaOk ? '' : 'Senha (mín. 6 caracteres)');
        } else {
          markValidity(senhaEl, true, '');
        }
      }
    } else if (senhaEl) {
      markValidity(senhaEl, true, '');
      senhaOk = true;
    }

    const ok = nomeOk && emailOk && setorOk && telOk && cargoOk && senhaOk && hIniOk && hFimOk && hOrderOk;
    setSaveEnabled(ok);
    return { ok, msgs };
  }

  async function ensurePermsEdit(){
    if (!ePerms) return;

    ePerms.innerHTML = '';
    ePerms.style.display = 'grid';

    try {
      const list  = await apiGet('/api/permissoes');
      const items = Array.isArray(list) ? list : (list?.items || list?.data || []);
      const current = new Set((state.viewing?.permissoes || []).map(x => String(x.id ?? x.value ?? x.key ?? x)));

      if (!items.length){
        ePerms.innerHTML = '<div style="opacity:.75">Nenhuma permissão cadastrada.</div>';
        return;
      }

      items.sort((a,b) => String(a.nome || a.id || '').localeCompare(String(b.nome || b.id || ''), 'pt-BR'));

      items.forEach(p => {
        const idRaw = p.id ?? p.value ?? p.key;
        if (idRaw == null) return;

        const label   = p.nome || idRaw;
        const checked = current.has(String(idRaw));

        const el = document.createElement('label');
        el.className = 'chk-line';
        el.innerHTML = `
          <input type="checkbox" name="perm-edit" value="${idRaw}" ${checked ? 'checked' : ''}>
          <span>${label}</span>
        `.trim();
        ePerms.appendChild(el);
      });
    } catch (e) {
      console.warn('Falha ao carregar lista de permissões', e);
      ePerms.innerHTML = '<div style="opacity:.75">Permissões indisponíveis.</div>';
    }
  }

  function getPermsSelecionadasEdit(){
    return [...document.querySelectorAll('#e-perms input[name="perm-edit"]:checked')].map(i=> i.value);
  }

  async function savePerms(id, arr){
    const payload = { permissoes: arr };
    const tries = [
      { path: `/api/permissoes/colaboradores/${id}`, method: 'PUT' },
      { path: `/api/colaboradores/${id}/permissoes`, method: 'PUT' },
      { path: `/api/colaboradores/${id}/permissoes`, method: 'POST' },
      { path: `/api/colaboradores/${id}`, method: 'PUT' },
    ];

    let lastError = null;
    for (const t of tries){
      try{
        await apiJSON(t.path, t.method, payload);
        return true;
      }catch(e){
        lastError = e;
      }
    }
    console.warn('falha ao salvar perms', id, lastError);
    return false;
  }

  async function renderPerfilView(colab){
    clearValidationErrors();
    state.viewing = colab;
    state.showErrors = false;

    const vNome   = $('#v-nome');
    const vEmailA = $('#v-email');
    const vEmpresa= $('#v-empresa');
    const vDepto  = $('#v-depto');
    const vTelA   = $('#v-tel');
    const vCargo  = $('#v-cargo');
    const vExpIni = $('#v-exp-ini');
    const vExpFim = $('#v-exp-fim');

    const empresa = await loadEmpresa();
    if (!state.setores.length) { try{ await loadSetores(); }catch{} }

    if (pTitle) pTitle.textContent = perfilModal.dataset.mode === 'create'
      ? 'Novo colaborador'
      : (coalesceName(colab) || 'Perfil do colaborador');

    const photoURL = await fetchAvatarURLFor(colab);
    setPerfilAvatar(coalesceName(colab), photoURL);

    if (dStatus) dStatus.style.background = '#008b32';
    if (dStatusText) dStatusText.textContent = 'Disponível';

    const nome  = coalesceName(colab);
    const email = coalesceEmail(colab);

    if (vNome)    vNome.textContent     = nome || '—';
    if (vEmailA){ vEmailA.textContent   = email || '—'; vEmailA.href = email ? `mailto:${email}` : '#'; }
    if (vEmpresa) vEmpresa.textContent  = empresa?.nome || '—';

    const depId   = coalesceDeptId(colab);
    const depName = coalesceDeptName(colab) || state.setores.find(s => String(s.id)===String(depId))?.nome;

    if (vDepto) vDepto.textContent = depName || '—';

    const telRaw  = coalescePhone(colab);
    const telDisp = telRaw ? maskPhoneDisplay(telRaw.replace(/^\+/,'')) : '—';
    if (vTelA){ vTelA.textContent = telDisp; vTelA.href = telRaw ? `tel:${telE164(telRaw)}` : '#'; }

    const cargoVal = coalesceCargo(colab);
    const adm = isAdminFlag(colab);
    if (vCargo) vCargo.textContent = adm ? '' : (cargoVal || '—');
    renderAdminBadge(colab);

    const colIni = coalesceHorarioInicio(colab);
    const colFim = coalesceHorarioFim(colab);
    const depHor = getDeptHorarioById(depId, depName);

    const isCustom = !!(colIni || colFim);
    if (vExpIni){
      if (colIni) vExpIni.textContent = colIni;
      else if (depHor.ini) vExpIni.textContent = `${depHor.ini} (padrão)`;
      else vExpIni.textContent = '—';
    }
    if (vExpFim){
      if (colFim) vExpFim.textContent = colFim;
      else if (depHor.fim) vExpFim.textContent = `${depHor.fim} (padrão)`;
      else vExpFim.textContent = '—';
    }

    renderDeptHintBySetorId(depId, { personalizar: isCustom, setorNome: depName });

    const rowToggle = document.getElementById('row-exp-toggle');
    if (rowToggle) rowToggle.style.display = 'none';
    const rowIni = document.getElementById('row-exp-ini');
    const rowFim = document.getElementById('row-exp-fim');
    if (rowIni) rowIni.style.display = '';
    if (rowFim) rowFim.style.display = '';

    if (dPerms){
      dPerms.innerHTML = '';
      const permsList = (colab.permissoes||[]).map(x => String(x.id ?? x));
      if (permsList.length) permsList.forEach(p => dPerms.appendChild(chip(p)));
      else dPerms.textContent = '—';
      dPerms.style.display = '';
    }
    if (ePerms){
      ePerms.style.display = 'none';
      ePerms.innerHTML = '';
    }

    await renderInstsView(colab);

    if (avatarHint) avatarHint.style.display = (perfilModal.dataset.mode === 'create') ? 'grid' : 'none';

    const wrapSenha = $('#wrap-senha');
    const senhaHelp = $('#senha-help');
    const isCreate  = (perfilModal.dataset.mode === 'create');
    const canPass   = canEditPassword();
    if (wrapSenha) wrapSenha.style.display = (canPass && (isCreate || state.inlineEdit)) ? 'flex' : 'none';
    if (senhaHelp) senhaHelp.style.display = (canPass && isCreate) ? '' : 'none';

    bindAvatarDnDAndPaste();
    exitInlineEdit(false);
  }

  function enterInlineEdit(){
    if (!state.viewing || state.inlineEdit) return;
    state.inlineEdit = true;
    state.showErrors = false;

    if (pEdit)   pEdit.style.display   = 'none';
    if (pSave)   pSave.style.display   = 'none';
    if (pCancel) pCancel.style.display = 'none';
    if (pClose)  pClose.style.display  = '';

    ensureFooterButtons();
    if (pSaveFoot)   pSaveFoot.style.display = '';
    if (pCancelFoot) pCancelFoot.style.display = '';
    if (pClose2)     pClose2.style.display = 'none';

    if (pSaveFoot){
      pSaveFoot.innerHTML = (perfilModal.dataset.mode === 'create')
        ? '<i class="fa fa-check"></i> Criar'
        : '<i class="fa fa-check"></i> Salvar';
    }

    perfilModal.classList.add('editing');

    swapFieldbox('fb-nome',  `<input id="e-nome" class="input" type="text" maxlength="120" required autocomplete="off" placeholder="Seu nome completo">`);
    swapFieldbox('fb-email', `<input id="e-email" class="input" type="email" maxlength="160" required autocomplete="off" placeholder="nome@empresa.com">`);

    const selHtml = `<select id="e-setor" class="select" required>
        <option value="">Selecione…</option>
        ${state.setores.map(s=>`<option value="${s.id}">${s.nome}</option>`).join('')}
      </select>`;
    const sel = swapFieldbox('fb-depto', selHtml);

    const depIdRaw  = coalesceDeptId(state.viewing);
    const depName   = coalesceDeptName(state.viewing);
    let depValue  = '';

    if (depIdRaw != null) depValue = String(depIdRaw);
    else if (depName && state.setores.length) {
      const alvo = normStr(depName);
      const found = state.setores.find(s => normStr(s?.nome) === alvo);
      if (found) depValue = String(found.id);
    }

    if (sel && depValue) {
      const hasOpt = Array.from(sel.options || []).some(o => o.value === depValue);
      if (!hasOpt) sel.appendChild(new Option(depName || 'Departamento atual', depValue));
      sel.value = depValue;
    }

    swapFieldbox('fb-tel', `<input id="e-tel" class="input" type="tel" required inputmode="numeric" placeholder="(DD) 9 9999-9999">`);
    swapFieldbox('fb-cargo', `<input id="e-cargo" class="input" type="text" maxlength="80" required placeholder="Cargo">`);
    swapFieldbox('fb-exp-ini', `<input id="e-exp-ini" class="input" type="text" inputmode="numeric" placeholder="08:00">`);
    swapFieldbox('fb-exp-fim', `<input id="e-exp-fim" class="input" type="text" inputmode="numeric" placeholder="18:00">`);

    $('#e-nome').value  = coalesceName(state.viewing) || '';
    $('#e-email').value = coalesceEmail(state.viewing) || '';
    $('#e-tel').value   = (coalescePhone(state.viewing) ? maskPhoneBR(coalescePhone(state.viewing)) : '');
    $('#e-cargo').value = coalesceCargo(state.viewing) || '';

    const hIni = coalesceHorarioInicio(state.viewing) || '';
    const hFim = coalesceHorarioFim(state.viewing)   || '';
    $('#e-exp-ini').value = hIni;
    $('#e-exp-fim').value = hFim;

    const tgl = document.getElementById('e-exp-personalizar');
    if (tgl){
      const isCreate = (perfilModal.dataset.mode === 'create');
      tgl.checked = !isCreate && !!(hIni || hFim);
      tgl.onchange = ()=>{
        applyExpPersonalizarUI();
        validateFormLive();
      };
    }

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

    sel?.addEventListener('change', ()=>{
      applyExpPersonalizarUI();
      validateFormLive();
    });

    $('#e-exp-ini')?.addEventListener('input', ()=>{
      const el = $('#e-exp-ini');
      maskTimeInput(el);
      validateFormLive();
    });
    $('#e-exp-fim')?.addEventListener('input', ()=>{
      const el = $('#e-exp-fim');
      maskTimeInput(el);
      validateFormLive();
    });

    const senhaInput = $('#e-senha');
    if (senhaInput) senhaInput.addEventListener('input', ()=> validateFormLive());

    if (ePerms){
      ePerms.style.display = 'grid';
      ensurePermsEdit();
    }
    if (dPerms) dPerms.style.display = 'none';

    ensureInstsEdit();

    const wrapSenha = $('#wrap-senha');
    const senhaHelp = $('#senha-help');
    const toggle    = $('#toggle-senha');
    const canPass   = canEditPassword();

    if (wrapSenha) wrapSenha.style.display = canPass ? 'flex' : 'none';
    if (senhaHelp) senhaHelp.style.display = (canPass && perfilModal.dataset.mode === 'create') ? '' : 'none';

    if (toggle){
      const input = $('#e-senha');
      if (!canPass){
        if (input) input.value = '';
        toggle.onclick = null;
      } else {
        toggle.onclick = () => {
          if (!input) return;
          input.type = (input.type === 'password') ? 'text' : 'password';
          const ico = toggle.querySelector('i');
          if (ico){
            ico.classList.toggle('fa-eye');
            ico.classList.toggle('fa-eye-slash');
          }
          input.focus();
        };
      }
    }

    bindAvatarDnDAndPaste();
    applyExpPersonalizarUI();

    if (sel && sel.value) {
      const setorNome = sel?.options?.[sel.selectedIndex]?.text || '';
      renderDeptHintBySetorId(sel.value, { personalizar: !!tgl?.checked, setorNome });
    } else {
      renderDeptHintBySetorId('', { personalizar: !!tgl?.checked, setorNome: '' });
    }

    validateFormLive(false);
  }

  function exitInlineEdit(restore=true){
    restoreFieldbox('fb-nome');
    restoreFieldbox('fb-email');
    restoreFieldbox('fb-depto');
    restoreFieldbox('fb-tel');
    restoreFieldbox('fb-cargo');
    restoreFieldbox('fb-exp-ini');
    restoreFieldbox('fb-exp-fim');

    state.inlineEdit = false;
    state.showErrors = false;

    if (pEdit)   pEdit.style.display   = '';
    if (pSave)   pSave.style.display   = 'none';
    if (pCancel) pCancel.style.display = 'none';
    if (pClose)  pClose.style.display  = 'none';

    if (pClose2)     pClose2.style.display = '';
    if (pSaveFoot)   pSaveFoot.style.display = 'none';
    if (pCancelFoot) pCancelFoot.style.display = 'none';

    perfilModal.classList.remove('editing');

    const rowToggle = document.getElementById('row-exp-toggle');
    if (rowToggle) rowToggle.style.display = 'none';
    const rowIni = document.getElementById('row-exp-ini');
    const rowFim = document.getElementById('row-exp-fim');
    if (rowIni) rowIni.style.display = '';
    if (rowFim) rowFim.style.display = '';

    if (restore && state.viewing) renderPerfilView(state.viewing);
  }

  async function saveInline(){
    validateFormLive(false);

    const mode = perfilModal.dataset.mode || 'view';
    const id = Number(perfilModal.dataset.currentId || '0') || 0;
    const canPass = canEditPassword();

    const { eNome, eEmail, eSetor, eTel, eCargo, eExpIni, eExpFim, eExpPersonalizar } = getEditInputs();
    const nome   = eNome?.value.trim();
    const email  = eEmail?.value.trim();
    const setor  = eSetor?.value || '';
    const tel    = eTel?.value || '';
    const cargo  = eCargo?.value || '';
    const expOn  = !!eExpPersonalizar?.checked;
    const hIni   = (expOn ? (eExpIni?.value.trim() || '') : '');
    const hFim   = (expOn ? (eExpFim?.value.trim() || '') : '');

    state.showErrors = true;
    const check = validateFormLive(true);
    if (!check.ok){
      toast('Corrija os campos:\n' + check.msgs.join('\n'),'warn');
      return;
    }

    const instsSel = getInstsSelecionadasEdit();
    const permsSel = getPermsSelecionadasEdit();

    if (mode === 'create'){
      const fd = new FormData();
      fd.append('nome', nome);
      fd.append('email', email);
      fd.append('setor_id', String(Number(setor)));
      fd.append('telefone', telE164(tel));
      fd.append('cargo', (cargo||'').trim());

      if (expOn){
        fd.append('hora_login_inicio', hIni);
        fd.append('hora_login_fim', hFim);
      }

      if (!canPass){
        toast('Você não tem permissão para definir senha deste colaborador.','warn');
        return;
      }

      const senhaInp  = document.querySelector('#e-senha');
      const s = (senhaInp?.value || '').trim();
      if (s.length < 6 || s.length > 72) {
        toast('Defina uma senha entre 6 e 72 caracteres.', 'warn');
        return;
      }
      fd.append('senha', s);

      permsSel.forEach(p => fd.append('permissoes[]', String(p)));
      instsSel.forEach(n => fd.append('instancias_ids[]', String(n)));

      if (state.newAvatarFile) fd.append('avatar', state.newAvatarFile);

      try{
        const created = await apiForm('/api/colaboradores/', 'POST', fd);

        if (created?.id != null){
          try { await savePerms(created.id, permsSel); } catch(ePerm){ console.warn('perm create', ePerm); }
        }

        toast('Colaborador criado.');

        if (state.newAvatarFile) {
          let upOK = false;
          if (created?.usuario_id){
            upOK = await uploadAvatarTo(`/api/usuarios/${created.usuario_id}/avatar`, state.newAvatarFile);
          }
          if (!upOK && created?.id){
            upOK = await uploadAvatarTo(`/api/colaboradores/${created.id}/avatar`, state.newAvatarFile);
          }
        }

        state.newAvatarFile = null;
        state.showErrors = false;

        perfilModal.dataset.mode = 'view';
        perfilModal.dataset.currentId = String(created?.id||'');

        const fresh = await loadColabFull(created.id);
        fresh.instancias_ids    = instsSel;
        if (permsSel.length) fresh.permissoes = permsSel;
        fresh.hora_login_inicio = expOn ? (hIni || null) : null;
        fresh.hora_login_fim    = expOn ? (hFim || null) : null;

        state.viewing = fresh;
        await loadColaboradores();
        renderLista();
        await renderPerfilView(fresh);
        exitInlineEdit(false);
      }catch(e){
        console.error('[create error]', e.status, e.data);
        const msg = (e?.data && (e.data.detail || e.data.message || (typeof e.data === 'string' ? e.data : ''))) || null;
        if (e.status===409) return toast('E-mail já cadastrado.','warn');
        if (e.status===422) return toast(msg || 'Dados inválidos (422).','warn');
        toast(msg || 'Erro ao criar.','err');
      }
      return;
    }

    const payload = {
      nome, email,
      setor_id: Number(setor),
      telefone: telE164(tel),
      cargo: (cargo||'').trim(),
      instancias_ids: instsSel,
      atualizar_usuario: !!state.viewing?.usuario_id
    };

    payload.hora_login_inicio = expOn ? (hIni || null) : null;
    payload.hora_login_fim    = expOn ? (hFim || null) : null;

    const senhaEl = document.querySelector('#e-senha');
    const newPass = (senhaEl?.value || '').trim();
    if (canPass && newPass) {
      payload.senha = newPass;
      payload.atualizar_usuario = true;
    }

    try{
      await apiJSON(`/api/colaboradores/${id}`, 'PUT', payload);

      if (state.newAvatarFile){
        let upOK = false;
        if (state.viewing?.usuario_id){
          upOK = await uploadAvatarTo(`/api/usuarios/${state.viewing.usuario_id}/avatar`, state.newAvatarFile);
        }
        if (!upOK){
          upOK = await uploadAvatarTo(`/api/colaboradores/${id}/avatar`, state.newAvatarFile);
        }
        if (upOK) state.newAvatarFile = null;
      }

      let permsUpdated = true;
      try{
        permsUpdated = await savePerms(id, permsSel);
        if (permsUpdated) state.viewing.permissoes = permsSel;
      }catch(ePerm){
        permsUpdated = false;
        console.warn('Erro ao salvar permissões (edit)', ePerm);
      }

      let instsUpdated = true;
      try{ instsUpdated = await saveInsts(id, instsSel); }catch{ instsUpdated = false; }

      state.showErrors = false;
      const msg = [
        'Alterações salvas.',
        permsUpdated ? 'Permissões OK.' : '',
        instsUpdated ? 'Instâncias OK.' : ''
      ].filter(Boolean).join(' ');
      toast(msg || 'Alterações salvas.');

      const fresh = await loadColabFull(id);
      fresh.instancias_ids    = instsSel;
      if (permsSel.length) fresh.permissoes = permsSel;
      fresh.hora_login_inicio = expOn ? (hIni || null) : null;
      fresh.hora_login_fim    = expOn ? (hFim || null) : null;

      state.viewing = fresh;
      await loadColaboradores();
      renderLista();
      renderPerfilView(fresh);
    }catch(e){
      console.error(e);
      if (e.status===409) return toast('E-mail já cadastrado.','warn');
      if (e.status===404) return toast('Registro não encontrado.','warn');
      toast('Erro ao salvar.','err');
    }
  }

  async function openPerfil(id){
    try{
      if (Number.isNaN(Number(id)) || !Number(id)){
        toast('ID do colaborador inválido.','err');
        return;
      }
      perfilModal.dataset.mode = 'view';
      perfilModal.setAttribute('aria-hidden','false');
      document.documentElement.classList.add('modal-open');
      setPlaceholderPerfil();

      const colab = await loadColabFull(id);
      await renderPerfilView(colab);
      perfilModal.dataset.currentId = String(id);
      if (pEdit) pEdit.style.display = hasPerm('colaboradores.gerenciar') ? '' : 'none';
    }catch(e){
      console.error(e);
      toast('Não foi possível abrir o perfil.','err');
    }
  }

  function closePerfil(){
    clearValidationErrors();
    perfilModal.setAttribute('aria-hidden','true');
    document.documentElement.classList.remove('modal-open');
    perfilModal.dataset.mode = 'view';
    state.newAvatarFile = null;
    state.showErrors = false;
    $('#avatar-wrap')?.classList.remove('drag-over');
  }

  async function openNovo(){
    if (!hasPerm(EDIT_PERM)) { toast('Sem permissão para criar.','warn'); return; }
    if (!canEditPassword()) { toast('Sem permissão para criar (requer permissão de redefinir senha).','warn'); return; }

    const blank = {
      id:null,
      nome:'',
      email:'',
      telefone:'',
      cargo:'',
      setor_id:null,
      permissoes:[],
      instancias_ids:[],
      hora_login_inicio:null,
      hora_login_fim:null
    };
    perfilModal.dataset.mode = 'create';
    perfilModal.dataset.currentId = '';
    state.showErrors = false;
    await renderPerfilView(blank);

    if (pAvatarInput){
      pAvatarInput.setAttribute('accept','image/*,.svg,.webp,.avif,.heic,.heif');
      pAvatarInput.onchange = () => handleAvatarFile(pAvatarInput.files?.[0] || null);
    }
    if (btnAddAvatar){
      btnAddAvatar.onclick = () => { if (pAvatarInput){ pAvatarInput.value=''; pAvatarInput.click(); } };
    }

    bindAvatarDnDAndPaste();

    const wrapSenha = document.querySelector('#wrap-senha');
    const toggle = document.querySelector('#toggle-senha');
    const canPass = canEditPassword();
    if (wrapSenha) wrapSenha.style.display = canPass ? 'flex' : 'none';
    if (toggle){
      const input = document.querySelector('#e-senha');
      if (!canPass){
        if (input) input.value = '';
        toggle.onclick = null;
      } else {
        toggle.onclick = () => {
          if (!input) return;
          input.type = (input.type === 'password') ? 'text' : 'password';
          const ico = toggle.querySelector('i');
          if (ico){
            ico.classList.toggle('fa-eye');
            ico.classList.toggle('fa-eye-slash');
          }
          input.focus();
        };
      }
    }

    perfilModal.setAttribute('aria-hidden','false');
    document.documentElement.classList.add('modal-open');
    enterInlineEdit();
  }

  function bind(){
    filtroTxt?.addEventListener('input', debounce(()=>{
      state.filtroTexto = filtroTxt.value.trim();
      renderLista();
    },160));
    filtroDepto?.addEventListener('change', ()=>{ state.filtroSetorId = filtroDepto.value; renderLista(); });
    btnFiltrar?.addEventListener('click', renderLista);
    btnAdd?.addEventListener('click', openNovo);

    if (chkRequerToken){
      chkRequerToken.addEventListener('change', () => {
        saveEmpresaLoginConfig(chkRequerToken.checked);
      });
    }

    document.addEventListener('click', (e)=>{
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const raw = b.dataset.id;
      const id  = Number(raw);

      if (b.dataset.action === 'view'){
        if (!raw || Number.isNaN(id) || !id){ toast('ID do colaborador inválido.','err'); return; }
        openPerfil(id);
        return;
      }
      if (b.dataset.action === 'del'){
        if (!hasPerm(EDIT_PERM)) return toast('Sem permissão para remover.','warn');
        if (!raw || Number.isNaN(id) || !id){ toast('ID do colaborador inválido.','err'); return; }

        showConfirm('Remover este colaborador?').then(async (ok)=>{
          if (!ok) return;
          try{
            const resp = await authFetch(withEmpresa(`/api/colaboradores/${id}`), { method:'DELETE' });
            const data = await parseMaybeJSON(resp);
            if (!resp.ok) throwHTTP(resp, data);
            toast('Removido.');
            await loadColaboradores();
            renderLista();
          }catch(err){
            console.error(err);
            toast('Não foi possível remover.','err');
          }
        });
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
    await loadEmpresa();
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
    if (run._did) return;
    run._did = true;
    if (window.Page?.guarded){
      window.Page.guarded(VIEW_PERM, init, { msg:'Sem permissão para Colaboradores' });
    } else {
      init();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once:true });
  else run();

})();

(()=>{
  if (document.body.dataset.page !== 'colaboradores') return;

  function getSurfaceColor(el){
    let n = el;
    while (n && n !== document.documentElement){
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
      n = n.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  }

  function enhanceSelect(sel){
    if (!sel || sel.dataset.enhanced) return;
    sel.dataset.enhanced = '1';
    sel.classList.add('select--replaced');

    const wrap = document.createElement('div');
    wrap.className = 'x-select';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    wrap.style.setProperty('--x-surface', getSurfaceColor(wrap));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'x-sel-btn';
    btn.setAttribute('aria-haspopup','listbox');
    btn.setAttribute('aria-expanded','false');
    wrap.appendChild(btn);

    const list = document.createElement('ul');
    list.className = 'x-sel-list';
    list.setAttribute('role','listbox');
    wrap.appendChild(list);

    function render(){
      btn.textContent = sel.options[sel.selectedIndex]?.text || 'Selecione…';
      list.innerHTML = '';
      Array.from(sel.options).forEach(opt => {
        const li = document.createElement('li');
        li.className = 'x-sel-opt';
        li.setAttribute('role','option');
        li.dataset.value = opt.value;
        li.textContent = opt.text;
        if (opt.selected) li.setAttribute('aria-selected','true');
        li.addEventListener('click', () => {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles:true } ));
          btn.textContent = opt.text;
          close();
        });
        list.appendChild(li);
      });
    }

    function open(){
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded','true');
      const cur = list.querySelector('[aria-selected="true"]');
      if (cur) cur.scrollIntoView({ block:'nearest' });
      window.addEventListener('click', onDocClick, { once:true });
    }
    function close(){
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded','false');
    }
    function onDocClick(e){ if (!wrap.contains(e.target)) close(); }

    btn.addEventListener('click', () => wrap.classList.contains('open') ? close() : open());
    sel.addEventListener('change', render);

    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); open();
      } else if (e.key === 'Escape') {
        close();
      }
    });

    const syncDisabled = () => { btn.disabled = sel.disabled; };
    const mo = new MutationObserver(syncDisabled);
    mo.observe(sel, { attributes:true, attributeFilter:['disabled'] });
    syncDisabled();

    render();
  }

  document.querySelectorAll('#modal-perfil .select, .details-grid .select').forEach(enhanceSelect);

  const rootObs = new MutationObserver(() => {
    document.querySelectorAll('#modal-perfil .select:not([data-enhanced]), .details-grid .select:not([data-enhanced])').forEach(enhanceSelect);
  });
  rootObs.observe(document.body, { childList:true, subtree:true });
})();