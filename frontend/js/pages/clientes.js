// clientes.js
(function ClientesPage(){
  'use strict';

  const PERM_REQUIRED_ANY = ['clientes.ver','clientes.gerenciar'];

  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const LS = localStorage;
  const EMPRESA_ID = Number(LS.getItem('empresa_id') || '') || null;

  const MAX_LOCAL = 400;         // teto em memória local no front
  const PAGE = { limit: 20, offset: 0, loading: false, done: false };

  // ===== Loader dinâmico do cliente-editar.js =====
  let _editorLoading = null;
  function ensureClienteEditorLoaded(){
    if (window.ClienteEditor) return Promise.resolve(true);
    if (_editorLoading) return _editorLoading;
    _editorLoading = new Promise((resolve)=>{
      const s = document.createElement('script');
      // ajuste o caminho conforme sua estrutura de pastas:
      s.src = '/frontend/js/pages/cliente-editar.js';
      s.async = true;
      s.onload  = ()=> resolve(true);
      s.onerror = ()=> { console.warn('Não foi possível carregar cliente-editar.js'); resolve(false); };
      document.head.appendChild(s);
    });
    return _editorLoading;
  }

  // ===== API =====
  const authFetch = (url, opt={}) => {
    const f = (window.ZAuth && ZAuth.authFetch) ? ZAuth.authFetch : fetch;
    const headers = Object.assign(
      { 'Accept':'application/json' },
      opt.headers || {},
      EMPRESA_ID ? { 'X-Empresa-Id': String(EMPRESA_ID) } : {}
    );
    return f(url, { credentials:'include', ...opt, headers });
  };
  function withEmpresaIdQuery(path){
    try{
      const u = new URL(path, location.origin);
      if (EMPRESA_ID && !u.searchParams.has('empresa_id')) u.searchParams.set('empresa_id', String(EMPRESA_ID));
      return u.toString();
    }catch{
      const sep = path.includes('?') ? '&' : '?';
      return (EMPRESA_ID && !/(\?|&)empresa_id=/.test(path)) ? path+sep+'empresa_id='+EMPRESA_ID : path;
    }
  }
  async function parseMaybeJSON(res){
    const txt = await res.text().catch(()=> '');
    try { return txt ? JSON.parse(txt) : null; } catch { return txt || null; }
  }
  function throwHTTP(res, data){
    const err = new Error((data && (data.detail || data.message)) || res.statusText || 'Erro');
    err.status = res.status; err.data = data; throw err;
  }
  async function apiGet(path){
    const r = await authFetch(withEmpresaIdQuery(path));
    const data = await parseMaybeJSON(r);
    if (!r.ok) throwHTTP(r, data);
    return data;
  }
  async function apiPost(path, body){
    const r = await authFetch(withEmpresaIdQuery(path), {
      method:'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(body||{})
    });
    const data = await parseMaybeJSON(r);
    if (!r.ok) throwHTTP(r, data);
    return data;
  }

  // ===== DOM
  const busca        = $('#busca');
  const selectDepto  = $('#select-depto');
  const selectResp   = $('#select-resp');
  const dataInicio   = $('#data_inicio');
  const dataFim      = $('#data_fim');
  const btnFiltrar   = $('#btn-filtrar');
  const btnAdd       = $('#btn-add-cliente');
  const btnExp       = $('#btnExportar');
  const btnImp       = $('#btnImportar');

  const tbody        = $('#corpo-tabela-clientes');
  const emptyState   = $('#empty-state');
  const totalEl      = $('#totalClientes');
  const btnMore      = $('#btnMore');

  // Seleção
  const checkAll     = $('#checkAll');
  const bulkInfo     = $('#bulkInfo');
  const btnClearSel  = $('#btnClearSel');
  const selCount     = $('#selCount');
  const selCount2    = $('#selCount2');
  const expOnlySel   = $('#expOnlySel');
  const btnRespBulk  = $('#btnRespBulk');
  const btnDeptoBulk = $('#btnDeptoBulk');

  // Modais Export/Import
  const expModal     = $('#exp-backdrop');
  const expOk        = $('#expOk');
  const expCancel    = $('#expCancel'); const expClose = $('#expClose');
  const impModal     = $('#imp-backdrop');
  const impOk        = $('#impOk');
  const impCancel    = $('#impCancel'); const impClose = $('#impClose');
  const impFile      = $('#impFile');   const impPick  = $('#impPick'); const impFileName = $('#impFileName');

  // Modal Colaborador (bulk)
  const respModal    = $('#resp-backdrop');
  const respOk       = $('#respOk');
  const respCancel   = $('#respCancel'); const respClose = $('#respClose');
  const selectRespModal = $('#selectRespModal');

  // Modal Departamento (bulk)
  const deptoModal   = $('#depto-backdrop');
  const deptoOk      = $('#deptoOk');
  const deptoCancel  = $('#deptoCancel'); const deptoClose = $('#deptoClose');
  const selectDeptoModal = $('#selectDeptoModal');

  // Modal "Novo cliente"
  const novoModal    = $('#novo-backdrop');
  const novoNome     = $('#novoNome');
  const novoTel      = $('#novoTel');
  const novoDepto    = $('#novoDepto');
  const novoDeptoList= $('#novoDeptoList');
  const novoColab    = $('#novoColab');
  const novoSobre    = $('#novoSobre');
  const novoOk       = $('#novoOk');
  const novoCancel   = $('#novoCancel'); const novoClose = $('#novoClose');

  const toastEl      = $('#toast');

  // Chip calendário
  const HAS_SHOWPICKER = !!(window.HTMLInputElement && 'showPicker' in HTMLInputElement.prototype);
  document.documentElement.setAttribute('data-showpicker', HAS_SHOWPICKER ? '1' : '0');
  const icoDi = $('#ico_data_inicio');
  const icoDf = $('#ico_data_fim');

  // ===== STATE
  const state = {
    setores: [],
    responsaveis: [],
    clientes: [],
    seen: new Set(),
    selected: new Set(),
    filtro: { q:'', deptoId:'', di:'', df:'', respId:'' } // '' (todos) | '0' (sem colaborador) | id
  };

  // ===== Utils
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
  function pad(n){ return String(n).padStart(2,'0'); }
  function formatDateBR(x){
    const d = x ? new Date(x) : null;
    if (!d || Number.isNaN(+d)) return '';
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
  }
  function escapeHtml(s){
    return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  function toast(msg, type='ok'){
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    toastEl.style.background = type==='err' ? '#7f1d1d'
                         : type==='warn'? '#78350f'
                         : '#065f46';
    clearTimeout(toast._t);
    toast._t = setTimeout(()=>{ toastEl.style.display='none'; }, 2400);
  }
  function safeFocus(el){
    try{ el && typeof el.focus === 'function' && el.focus(); }catch{}
  }

  // ===== Cache local (por filtros)
  function cacheKey(){
    const k = {
      emp: EMPRESA_ID || 0,
      q: (state.filtro.q||'').trim(),
      d: String(state.filtro.deptoId||''),
      di: String(state.filtro.di||''),
      df: String(state.filtro.df||''),
      r:  String(state.filtro.respId||'')
    };
    return 'clientes:v5:' + btoa(unescape(encodeURIComponent(JSON.stringify(k))));
  }
  function saveCache(){
    try{
      const key = cacheKey();
      const slim = state.clientes.slice(0, MAX_LOCAL);
      const payload = { at: Date.now(), items: slim };
      LS.setItem(key, JSON.stringify(payload));
    }catch{}
  }
  function loadCache(){
    try{
      const raw = LS.getItem(cacheKey());
      if (!raw) return null;
      const { items } = JSON.parse(raw);
      return Array.isArray(items) ? items : null;
    }catch{ return null; }
  }
  function clearClientesCaches(){
    try{
      const rm = [];
      for (let i=0;i<LS.length;i++){
        const k = LS.key(i);
        if (k && k.startsWith('clientes:v')) rm.push(k);
      }
      rm.forEach(k => LS.removeItem(k));
    }catch{}
  }

  // ===== Hidratações
  function hydrateDepartamentoNome(arr){
    if (!Array.isArray(arr) || !arr.length || !state.setores?.length) return;
    const mapa = new Map(state.setores.map(s => [Number(s.id), s.nome]));
    for (const c of arr){
      const depId = Number(c?.departamento_id ?? c?.depto_id ?? c?.setor_id ?? c?.setorId);
      if (depId){
        const nome = mapa.get(depId);
        if (nome){
          c.departamento_id = depId;
          c.setor_nome = c.setor_nome || nome;
          c.departamento = c.departamento || nome;
        }
      }
    }
  }
  function hydrateColaboradorNome(arr){
    if (!Array.isArray(arr) || !arr.length || !state.responsaveis?.length) return;
    const mapa = new Map(state.responsaveis.map(r => [Number(r.id), r.nome]));
    for (const c of arr){
      const id = Number(c?.colaborador_id ?? c?.responsavel_id ?? c?.colab_id ?? c?.user_id);
      if (id && id !== 0){
        if (!c.colaborador_id) c.colaborador_id = id;
        if (!c.colaborador_nome){
          const nome = mapa.get(id);
          if (nome) c.colaborador_nome = nome;
        }
      }
    }
  }

  // ===== Loads
  async function loadSetores(){
    const tries = ['/api/atendimento/clientes/departamentos','/api/departamentos'];
    for (const url of tries){
      try{
        const data = await apiGet(url);
        const arr = Array.isArray(data) ? data : (data?.items || data?.data || []);
        if (arr?.length){
          state.setores = arr.map(s => ({
            id:   Number(s.id ?? s.dep_id ?? s.depto_id ?? s.value ?? s.ID),
            nome: s.nome ?? s.name ?? s.titulo ?? s.label ?? '—'
          })).filter(s => s.id!=null && s.nome);
          renderSetores();
          if (state.clientes.length){
            hydrateDepartamentoNome(state.clientes);
            renderFromScratch();
          }
          return;
        }
      }catch{}
    }
    state.setores = [];
    renderSetores();
  }
  async function loadResponsaveis(){
    try{
      const data = await apiGet('/api/clientes/colaboradores');
      const items = Array.isArray(data) ? data : (data?.items || []);
      state.responsaveis = items.map(x => ({ id: Number(x.id), nome: x.nome || '(sem nome)' }));
      renderResponsaveis();
      if (state.clientes.length){
        hydrateColaboradorNome(state.clientes);
        renderFromScratch();
      }
    }catch(e){
      console.warn('Falha ao carregar colaboradores', e);
      state.responsaveis = [];
      renderResponsaveis();
    }
  }

  function renderSetores(){
    if (selectDepto){
      const first = selectDepto.querySelector('option');
      selectDepto.innerHTML = '';
      if (first) selectDepto.appendChild(first);
      state.setores.forEach(s => selectDepto.appendChild(new Option(s.nome, s.id)));
    }
    if (selectDeptoModal){
      selectDeptoModal.innerHTML = '';
      selectDeptoModal.appendChild(new Option('— Remover departamento —', ''));
      state.setores.forEach(s => selectDeptoModal.appendChild(new Option(s.nome, String(s.id))));
    }
    if (novoDeptoList){
      novoDeptoList.innerHTML = '';
      state.setores.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.nome;
        novoDeptoList.appendChild(opt);
      });
    }
  }
  function renderResponsaveis(){
    if (selectResp){
      selectResp.innerHTML = '';
      selectResp.appendChild(new Option('Todos', ''));
      selectResp.appendChild(new Option('Sem colaborador', '0'));
      state.responsaveis.forEach(r => selectResp.appendChild(new Option(r.nome, String(r.id))));
    }
    if (selectRespModal){
      selectRespModal.innerHTML = '';
      selectRespModal.appendChild(new Option('— Remover colaborador —', ''));
      state.responsaveis.forEach(r => selectRespModal.appendChild(new Option(r.nome, String(r.id))));
    }
    if (novoColab){
      novoColab.innerHTML = '';
      novoColab.appendChild(new Option('— Sem responsável —', ''));
      state.responsaveis.forEach(r => novoColab.appendChild(new Option(r.nome, String(r.id))));
    }
  }

  function apiUrlForPage(){
    const p = new URLSearchParams();
    if (state.filtro.q)        p.set('q', state.filtro.q);
    if (state.filtro.di)       p.set('data_inicio', state.filtro.di);
    if (state.filtro.df)       p.set('data_fim', state.filtro.df);
    if (state.filtro.respId !== '' && state.filtro.respId != null) {
      p.set('colaborador_id', String(state.filtro.respId)); // '0' pode significar "sem colaborador"
    }
    p.set('limit', String(PAGE.limit));
    p.set('offset', String(PAGE.offset));
    return '/api/clientes' + (p.toString()?`?${p}`:'');
  }

  function updateLoadMore(){
    if (!btnMore) return;
    if (PAGE.done){
      btnMore.style.display = 'none';
    } else {
      btnMore.style.display = '';
      btnMore.disabled = PAGE.loading;
    }
  }

  async function fetchNextPage(){
    if (PAGE.loading || PAGE.done) return;
    PAGE.loading = true;
    btnMore?.classList.add('is-loading');

    try{
      const url = apiUrlForPage();
      const res = await apiGet(url);
      const items = Array.isArray(res) ? res : (res?.items || []);
      const has_more = Array.isArray(res) ? (items.length === PAGE.limit) : !!res?.has_more;
      const next_offset = Array.isArray(res) ? (PAGE.offset + items.length) : (res?.next_offset ?? (PAGE.offset + items.length));

      hydrateColaboradorNome(items);
      hydrateDepartamentoNome(items);

      let touchedExisting = false;
      for (const c of items){
        if (!c || c.id == null) continue;
        const idx = state.clientes.findIndex(x => x.id === c.id);
        if (idx >= 0){
          state.clientes[idx] = c;
          touchedExisting = true;
        } else {
          state.clientes.push(c);
          state.seen.add(c.id);
        }
      }
      if (state.clientes.length > MAX_LOCAL){
        const toDrop = state.clientes.length - MAX_LOCAL;
        state.clientes.splice(0, toDrop);
        state.seen = new Set(state.clientes.map(x => x.id));
      }

      PAGE.offset = next_offset || (PAGE.offset + items.length);
      PAGE.done = !has_more || items.length === 0;

      if (touchedExisting) renderFromScratch();
      else                 renderAppend(items);

      totalEl.textContent = String(state.clientes.filter(rowMatchesDept).length);
      saveCache();
    }catch(e){
      console.error(e);
      toast('Erro ao carregar clientes.','err');
    }finally{
      PAGE.loading = false;
      btnMore?.classList.remove('is-loading');
      updateLoadMore();
    }
  }

  // ===== Render
  function renderSetDeptName(c){
    return c.setor_nome || c.departamento || c.departamento_nome || c.setor || '-';
  }
  function rowMatchesDept(c){
    const depId = String(state.filtro.deptoId||'');
    if (!depId) return true;
    const nomeDoId = state.setores.find(s => String(s.id)===depId)?.nome;
    if (!nomeDoId) return true;
    return (renderSetDeptName(c) || '').toLowerCase() === String(nomeDoId).toLowerCase();
  }

  function makeRow(c){
    const tel = formatTelBR(c.telefone);
    const depName = renderSetDeptName(c);
    const dt = formatDateBR(c.created_at || c.data_cadastro || c.dt_cadastro || c.timestamp);
    const checked = state.selected.has(c.id) ? 'checked' : '';
    const resp = (c.colaborador_nome ?? c.responsavel_nome) || '-';

    // evita telefone virar "Nome"
    const nomeOk = (() => {
      const n = (c.nome || '').trim();
      const nd = digits(n);
      const td = digits(c.telefone || '');
      if (!n) return '-';
      if (nd && td && (nd.endsWith(td) || nd === td)) return '-';
      return n;
    })();

    const tr = document.createElement('tr');
    tr.classList.add('cliente-row');
    tr.dataset.id = String(c.id);

    tr.innerHTML = `
      <td class="td-select" data-th="Sel.">
        <input type="checkbox" class="row-check" data-id="${c.id}" ${checked}>
      </td>
      <td data-th="Nome">${escapeHtml(nomeOk)}</td>
      <td data-th="Telefone">${escapeHtml(tel || '-')}</td>
      <td data-th="Departamento" class="td-depto">${escapeHtml(depName)}</td>
      <td data-th="Responsável" class="td-colab">${escapeHtml(resp)}</td>
      <td data-th="Data Cadastro">${escapeHtml(dt || '-')}</td>
      <td data-th="Ações" class="td-actions">
        <button class="btn secondary" data-action="view" data-id="${c.id}"><i class="fa fa-eye"></i> Ver</button>
        <button class="btn secondary" data-action="edit" data-id="${c.id}"><i class="fa fa-pen"></i> Editar</button>
        <button class="btn secondary" data-action="msg"  data-id="${c.id}"><i class="fa fa-paper-plane"></i> Mensagem</button>
      </td>
    `.trim();
    return tr;
  }

  function clearList(){ tbody.innerHTML = ''; }

  function renderAppend(newItems){
    const rows = (newItems||[]).filter(rowMatchesDept);
    if (!rows.length && state.clientes.length === 0){
      if (emptyState) emptyState.style.display='flex';
      totalEl.textContent = '0';
      return;
    }
    if (emptyState) emptyState.style.display='none';
    const frag = document.createDocumentFragment();
    rows.forEach(c => frag.appendChild(makeRow(c)));
    tbody.appendChild(frag);
    totalEl.textContent = String(state.clientes.filter(rowMatchesDept).length);
    updateCheckAllUI();
  }

  function renderFromScratch(){
    clearList();
    const rows = state.clientes.filter(rowMatchesDept);
    if (!rows.length){
      if (emptyState) emptyState.style.display='flex';
      totalEl.textContent = '0';
      updateCheckAllUI();
      return;
    }
    if (emptyState) emptyState.style.display='none';
    const frag = document.createDocumentFragment();
    rows.forEach(c => frag.appendChild(makeRow(c)));
    tbody.appendChild(frag);
    totalEl.textContent = String(rows.length);
    updateCheckAllUI();
  }

  // ===== Atualizações otimistas
  function applyColaboradorLocal(ids, colabId, colabNome){
    let touched = false;
    for (const id of ids){
      const idx = state.clientes.findIndex(c => c.id === id);
      if (idx >= 0){
        state.clientes[idx] = {
          ...state.clientes[idx],
          colaborador_id: colabId,
          colaborador_nome: colabNome || '-'
        };
        touched = true;
        const row = tbody.querySelector(`tr.cliente-row[data-id="${id}"]`);
        const td = row?.querySelector('.td-colab');
        if (td) td.textContent = colabNome || '-';
        const chk = row?.querySelector('.row-check');
        if (chk) chk.checked = false;
      }
      state.selected.delete(id);
    }
    if (touched){
      updateSelUI();
      updateCheckAllUI();
      saveCache();
    }
  }
  function applyDepartamentoLocal(ids, deptoId, deptoNome){
    let touched = false;
    for (const id of ids){
      const idx = state.clientes.findIndex(c => c.id === id);
      if (idx >= 0){
        state.clientes[idx] = {
          ...state.clientes[idx],
          departamento_id: deptoId,
          setor_nome: deptoNome || '-',
          departamento: deptoNome || '-'
        };
        touched = true;
        const row = tbody.querySelector(`tr.cliente-row[data-id="${id}"]`);
        const td = row?.querySelector('.td-depto');
        if (td) td.textContent = deptoNome || '-';
        const chk = row?.querySelector('.row-check');
        if (chk) chk.checked = false;
      }
      state.selected.delete(id);
    }
    if (touched){
      updateSelUI();
      updateCheckAllUI();
      saveCache();
    }
  }

  // ===== Seleção
  function updateSelUI(){
    const n = state.selected.size;
    if (selCount)  selCount.textContent = String(n);
    if (selCount2) selCount2.textContent = String(n);
    if (bulkInfo)  bulkInfo.hidden = n === 0;
    if (btnRespBulk)  btnRespBulk.disabled  = n === 0;
    if (btnDeptoBulk) btnDeptoBulk.disabled = n === 0;
    if (expOnlySel){
      expOnlySel.disabled = n === 0;
      if (n === 0) expOnlySel.checked = false;
    }
  }
  function updateCheckAllUI(){
    const chks = $$('.row-check', tbody);
    if (!checkAll) return;
    if (!chks.length){ checkAll.checked=false; checkAll.indeterminate=false; return; }
    const sel = chks.filter(c => c.checked).length;
    checkAll.checked = sel === chks.length;
    checkAll.indeterminate = sel > 0 && sel < chks.length;
  }

  // ===== Novo cliente – helpers
  function resetNovoForm(){
    if (!novoModal) return;
    if (novoNome)  novoNome.value = '';
    if (novoTel)   novoTel.value = '';
    if (novoDepto) novoDepto.value = '';
    if (novoSobre) novoSobre.value = '';
    if (novoColab) novoColab.value = '';
  }
  function openNovoModal(){
    if (!novoModal){ /* fallback opcional */ return; }
    renderSetores();
    renderResponsaveis();
    resetNovoForm();
    openModal(novoModal);
    safeFocus(novoTel || novoNome);
  }

  async function handleNovoSave(){
    if (!novoModal) return;
    const telDigits = digits(novoTel?.value || '');
    if (!telDigits || telDigits.length < 8){
      toast('Informe um telefone válido (mín. 8 dígitos).','warn');
      safeFocus(novoTel); return;
    }
    const nome  = (novoNome?.value || '').trim();
    const depto = (novoDepto?.value || '').trim();
    const sobre = (novoSobre?.value || '').trim();
    const colabRaw = (novoColab?.value ?? '');
    const colaborador_id = (colabRaw === '' ? null : Number(colabRaw));

    const payload = {
      telefone: telDigits,
      nome: nome || null,
      departamento: depto || null,
      sobre_cliente: sobre || null,
      colaborador_id
    };

    const old = novoOk?.textContent;
    if (novoOk){ novoOk.disabled = true; novoOk.textContent = 'Criando…'; }

    try{
      const res = await apiPost('/api/clientes/novo', payload);
      const id = Number(res?.id);
      const existed = !!(res?.exists || res?.already_exists);

      if (!id){
        toast('Erro ao criar cliente.','err');
        return;
      }

      // detalhe:
      let cli = null;
      try { cli = await apiGet(`/api/clientes/${id}`); } catch {}

      if (existed){
        if (cli) upsertClienteLocal(cli, /*toTop*/false);
        closeModal(novoModal);
        toast('Cliente já existia — exibindo registro.');
        setSearchAndReload(telDigits); // mostra só aquele número
        return;
      }

      // Novo mesmo:
      if (cli){
        upsertClienteLocal(cli, /*toTop*/true);
      }else{
        const now = new Date().toISOString();
        upsertClienteLocal({
          id,
          nome: nome || 'Cliente',
          telefone: telDigits,
          departamento: depto || null,
          sobre: sobre || null,
          colaborador_id: colaborador_id ?? null,
          colaborador_nome: (colaborador_id ? (state.responsaveis.find(r=>r.id===colaborador_id)?.nome || '-') : null),
          timestamp: now,
          data_cadastro: now
        }, /*toTop*/true);
      }

      clearClientesCaches();
      renderFromScratch();
      totalEl.textContent = String(state.clientes.filter(rowMatchesDept).length);

      closeModal(novoModal);
      toast('Cliente criado!');
    }catch(e){
      console.error(e);
      toast(e?.data?.detail || 'Falha ao criar cliente.','err');
    }finally{
      if (novoOk){ novoOk.disabled = false; novoOk.textContent = old || 'Criar'; }
    }
  }

  function upsertClienteLocal(cli, toTop=false){
    if (!cli || cli.id==null) return;
    hydrateColaboradorNome([cli]);
    hydrateDepartamentoNome([cli]);

    const idx = state.clientes.findIndex(x => x.id === cli.id);
    if (idx >= 0){
      state.clientes[idx] = { ...state.clientes[idx], ...cli };
    }else{
      if (toTop) state.clientes.unshift(cli);
      else state.clientes.push(cli);
      state.seen.add(cli.id);
      if (state.clientes.length > MAX_LOCAL){
        state.clientes.length = MAX_LOCAL;
        state.seen = new Set(state.clientes.map(x=>x.id));
      }
    }
    saveCache();
  }

  // ===== Bind
  function bindEvents(){
    // Busca com debounce
    let t = null;
    busca?.addEventListener('input', ()=>{
      clearTimeout(t);
      t = setTimeout(()=>{ state.filtro.q = busca.value.trim(); resetAndLoad(); }, 250);
    });

    selectDepto?.addEventListener('change', ()=>{
      state.filtro.deptoId = selectDepto.value;
      renderFromScratch(); // depto é client-side
    });

    selectResp?.addEventListener('change', ()=>{
      state.filtro.respId = selectResp.value; // '' | '0' | id
      resetAndLoad();
    });

    dataInicio?.addEventListener('change', ()=>{ state.filtro.di = dataInicio.value; });
    dataFim?.addEventListener('change', ()=>{ state.filtro.df = dataFim.value; });
    btnFiltrar?.addEventListener('click', ()=> resetAndLoad());

    // Seleção por checkbox
    document.addEventListener('change', (e)=>{
      const chk = e.target?.closest?.('.row-check');
      if (!chk) return;
      const id = Number(chk.dataset.id);
      if (chk.checked) state.selected.add(id);
      else state.selected.delete(id);
      updateSelUI();
      updateCheckAllUI();
    });

    // Selecionar todos (visíveis)
    checkAll?.addEventListener('change', ()=>{
      const checked = !!checkAll.checked;
      $$('.row-check', tbody).forEach(ch => {
        ch.checked = checked;
        const id = Number(ch.dataset.id);
        if (checked) state.selected.add(id); else state.selected.delete(id);
      });
      updateSelUI();
      updateCheckAllUI();
    });

    // Limpar seleção
    btnClearSel?.addEventListener('click', ()=>{
      state.selected.clear();
      $$('.row-check', tbody).forEach(ch => ch.checked = false);
      updateSelUI();
      updateCheckAllUI();
    });

    // Abrir modal colaborador (bulk)
    btnRespBulk?.addEventListener('click', ()=>{
      if (state.selected.size === 0) return;
      openModal(respModal);
    });
    respCancel?.addEventListener('click', ()=> closeModal(respModal));
    respClose?.addEventListener('click', ()=> closeModal(respModal));
    respOk?.addEventListener('click', async ()=>{
      const ids = Array.from(state.selected);
      if (!ids.length) return;

      const val = (selectRespModal?.value ?? '');
      const colabId   = (val === '') ? null : Number(val);
      const colabNome = (val === '')
        ? '-'
        : (state.responsaveis.find(r => r.id === colabId)?.nome || '-');

      applyColaboradorLocal(ids, colabId, colabNome);

      const oldLabel = respOk.textContent;
      respOk.disabled = true;
      respOk.textContent = 'Salvando…';

      try{
        await apiPost('/api/clientes/bulk/colaborador', { ids, colaborador_id: colabId });
        toast('Colaborador atualizado!');
        closeModal(respModal);
      }catch(e){
        console.error(e);
        toast(e?.data?.detail || 'Falha ao atualizar colaborador.','err');
        resetAndLoad();
        closeModal(respModal);
      }finally{
        respOk.disabled = false;
        respOk.textContent = oldLabel;
      }
    });

    // Abrir modal departamento (bulk)
    btnDeptoBulk?.addEventListener('click', ()=>{
      if (state.selected.size === 0) return;
      openModal(deptoModal);
    });
    deptoCancel?.addEventListener('click', ()=> closeModal(deptoModal));
    deptoClose?.addEventListener('click', ()=> closeModal(deptoModal));
    deptoOk?.addEventListener('click', async ()=>{
      const ids = Array.from(state.selected);
      if (!ids.length) return;

      const val = (selectDeptoModal?.value ?? '');
      const depId   = (val === '') ? null : Number(val);
      const depNome = (val === '')
        ? '-'
        : (state.setores.find(s => String(s.id) === String(depId))?.nome || '-');

      applyDepartamentoLocal(ids, depId, depNome);

      const old = deptoOk.textContent;
      deptoOk.disabled = true; deptoOk.textContent = 'Salvando…';

      try{
        await apiPost('/api/clientes/bulk/departamento', { ids, departamento_id: depId });
        toast('Departamento atualizado!');
        closeModal(deptoModal);
      }catch(e){
        console.error(e);
        toast(e?.data?.detail || 'Falha ao atualizar departamento.','err');
        resetAndLoad();
        closeModal(deptoModal);
      }finally{
        deptoOk.disabled = false; deptoOk.textContent = old;
      }
    });

    // ===== Botão "Novo cliente"
    btnAdd?.addEventListener('click', ()=>{
      if (novoModal) openNovoModal();
    });
    novoCancel?.addEventListener?.('click', ()=> closeModal(novoModal));
    novoClose?.addEventListener?.('click',  ()=> closeModal(novoModal));
    novoTel?.addEventListener?.('keydown', (e)=>{ if (e.key === 'Enter') handleNovoSave(); });
    novoNome?.addEventListener?.('keydown', (e)=>{ if (e.key === 'Enter' && (e.ctrlKey||e.metaKey)) handleNovoSave(); });
    novoDepto?.addEventListener?.('keydown', (e)=>{ if (e.key === 'Enter' && (e.ctrlKey||e.metaKey)) handleNovoSave(); });
    novoSobre?.addEventListener?.('keydown', (e)=>{ if (e.key === 'Enter' && (e.ctrlKey||e.metaKey)) handleNovoSave(); });
    novoOk?.addEventListener?.('click', handleNovoSave);

    // Exportar
    btnExp?.addEventListener('click', ()=> { openModal(expModal); updateSelUI(); });
    expCancel?.addEventListener('click', ()=> closeModal(expModal));
    expClose?.addEventListener('click', ()=> closeModal(expModal));
    expOk?.addEventListener('click', ()=>{
      const fmt = (document.querySelector('input[name="expfmt"]:checked')?.value || 'csv');
      let url = `/api/clientes/export?fmt=${encodeURIComponent(fmt)}`;
      if (expOnlySel && expOnlySel.checked && state.selected.size){
        const ids = Array.from(state.selected).join(',');
        url += `&ids=${encodeURIComponent(ids)}`;
      }
      closeModal(expModal);
      const a = document.createElement('a');
      a.href = withEmpresaIdQuery(url);
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    // Importar (placeholder simples)
    btnImp?.addEventListener('click', ()=> openModal(impModal));
    impCancel?.addEventListener('click', ()=> closeModal(impModal));
    impClose?.addEventListener('click', ()=> closeModal(impModal));
    impPick?.addEventListener('click', ()=> impFile?.click());
    impFile?.addEventListener('change', ()=>{ if (impFileName) impFileName.textContent = (impFile.files?.[0]?.name || 'Nenhum arquivo escolhido'); });
    impOk?.addEventListener('click', ()=>{ closeModal(impModal); toast('Importando…'); });

    // ===== Ações da tabela — delega para ClienteEditor
    document.addEventListener('click', async (e)=>{
      const b = e.target.closest?.('[data-action]');
      if (!b) return;
      const id = Number(b.dataset.id);
      if (!id) return;

      const ok = await ensureClienteEditorLoaded();
      if (!ok || !window.ClienteEditor){
        toast('Módulo de edição não carregou.', 'err');
        return;
      }
      if (b.dataset.action === 'view'){ window.ClienteEditor.openView?.(id); return; }
      if (b.dataset.action === 'edit'){ window.ClienteEditor.openEdit?.(id); return; }
      if (b.dataset.action === 'msg'){  window.ClienteEditor.openMessage?.(id) ?? (location.href = `/frontend/atendimentos.html?cliente_id=${id}`); return; }
    });

    // showPicker chips
    if (HAS_SHOWPICKER) {
      icoDi?.addEventListener('mousedown', (e)=>{ e.preventDefault(); dataInicio?.showPicker?.(); });
      icoDf?.addEventListener('mousedown', (e)=>{ e.preventDefault(); dataFim?.showPicker?.(); });
      dataInicio?.addEventListener('click', ()=> dataInicio?.showPicker?.());
      dataFim?.addEventListener('click', ()=> dataFim?.showPicker?.());
    }

    // Botão carregar mais
    btnMore?.addEventListener('click', ()=> { fetchNextPage(); });

    // Clique na linha inteira alterna o checkbox
    tbody?.addEventListener('click', (e) => {
      const isInteractive = (el) => {
        const tag = el?.tagName;
        if (!tag) return false;
        if (['INPUT','BUTTON','A','SELECT','TEXTAREA','LABEL'].includes(tag)) return true;
        if (tag === 'SVG' || tag === 'PATH') return true;
        if (el.closest?.('[data-action]')) return true;
        if (el.closest?.('.row-check')) return true;
        return false;
      };
      if (isInteractive(e.target)) return;

      const row = e.target.closest?.('.cliente-row');
      if (!row) return;

      const chk = row.querySelector('.row-check');
      if (!chk) return;

      chk.checked = !chk.checked;

      const id = Number(chk.dataset.id);
      if (chk.checked) state.selected.add(id);
      else state.selected.delete(id);

      updateSelUI();
      updateCheckAllUI();
    });

    // ESC fecha modais + clique fora
    const backs = [expModal, impModal, respModal, deptoModal, novoModal].filter(Boolean);
    document.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape') backs.forEach(b => b.style.display = 'none');
    });
    backs.forEach(b=>{
      b.addEventListener('mousedown', (e)=>{
        if (e.target === b) b.style.display = 'none';
      });
    });

    // Sincroniza com edições feitas no modal do editor
    window.addEventListener('cliente:updated', (ev)=>{
      const cli = ev?.detail;
      if (!cli || cli.id==null) return;
      upsertClienteLocal(cli, /*toTop*/false); // mantém cache coeso
      saveCache();
    });
  }

  function openModal(el){ if (el) el.style.display='grid'; }
  function closeModal(el){ if (el) el.style.display='none'; }

  function resetAndLoad(){
    PAGE.offset = 0; PAGE.done = false; PAGE.loading = false;
    state.clientes = []; state.seen = new Set();
    clearList();

    const cached = loadCache();
    if (cached && cached.length){
      cached.forEach(c => { if (!state.seen.has(c.id)){ state.seen.add(c.id); state.clientes.push(c); }});
      hydrateColaboradorNome(state.clientes);
      hydrateDepartamentoNome(state.clientes);
      renderFromScratch();
      totalEl.textContent = String(state.clientes.filter(rowMatchesDept).length);
      PAGE.offset = state.clientes.length - (state.clientes.length % PAGE.limit);
    } else {
      totalEl.textContent = '0';
    }

    updateLoadMore();
    fetchNextPage();
  }

  function setSearchAndReload(q){
    const v = String(q || '').trim();
    state.filtro.q = v;
    if (busca) busca.value = v;
    resetAndLoad();
  }

  // ===== Boot
  async function init(){
    if (!hasAnyPerm(PERM_REQUIRED_ANY)){
      renderNoPerm();
      return;
    }
    if (window.ZAuth?.softEnsureAuth) { try { await ZAuth.softEnsureAuth(); } catch {} }

    bindEvents();
    await Promise.all([loadSetores(), loadResponsaveis()]);
    resetAndLoad();
    updateSelUI();
  }

  // ===== Perms helpers
  function normPerm(p){
    if (p == null) return null;
    if (typeof p === 'string') return p.trim().toLowerCase();
    if (typeof p === 'object'){
      return String(p.id ?? p.key ?? p.chave ?? p.slug ?? p.name ?? p.permissao ?? '')
        .trim()
        .toLowerCase();
    }
    return null;
  }
  function getAllPerms(){
    const out = new Set();
    const add = (vals) => { try { (vals || []).map(normPerm).filter(Boolean).forEach(v => out.add(v)); } catch {} };

    try { add(window.ZAuth?.getPerms?.()); } catch {}
    try {
      const b = (typeof window.Page?.getPerms === 'function')
        ? window.Page.getPerms()
        : window.Page?.perms;
      add(b);
    } catch {}

    const KEYS = ['permissoes','permissions','user_perms','perms'];
    for (const k of KEYS){
      try{
        const raw = LS.getItem(k);
        if (!raw) continue;

        let val = null;
        try { val = JSON.parse(raw); } catch { val = raw; }

        if (Array.isArray(val)){
          add(val);
        } else if (typeof val === 'string'){
          add(val.split(/[,\s]+/));
        } else if (val && typeof val === 'object'){
          add(Object.values(val));
        }
      }catch{}
    }

    try{
      const m = document.cookie.match(/(?:^|;\s*)permissoes=([^;]+)/);
      if (m){
        const parts = decodeURIComponent(m[1]).split(/[,\s]+/);
        add(parts);
      }
    }catch{}

    return Array.from(out);
  }

  function hasAnyPerm(permsNeeded){
    const found = getAllPerms();
    const need  = (permsNeeded||[]).map(p=>String(p).toLowerCase());
    const ok = need.some(p => found.includes(p));
    return ok || found.length === 0;
  }
  function renderNoPerm(){
    const main = document.querySelector('.main');
    if (!main) return;
    main.innerHTML = `
      <div class="box" style="margin:1rem auto; max-width:680px; text-align:center">
        <h2 style="margin:0 0 .5rem">Sem permissão</h2>
        <p style="color:var(--muted)">Você precisa de <code>clientes.ver</code> ou <code>clientes.gerenciar</code> para acessar esta página.</p>
      </div>
    `;
  }

  // ========= Ajuste visual do select de responsável =========
  (function enhanceSelectResponsavel(){
    const sel = selectResp;
    if (!sel) return;

    let measurer = null;
    function ensureMeasurer(){
      if (measurer) return measurer;
      measurer = document.createElement('span');
      measurer.textContent = '';
      const cs = getComputedStyle(sel);
      Object.assign(measurer.style, {
        position:'absolute', visibility:'hidden', whiteSpace:'nowrap',
        pointerEvents:'none', left:'-9999px', top:'0',
        fontFamily: cs.fontFamily, fontSize: cs.fontSize,
        fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing
      });
      document.body.appendChild(measurer);
      return measurer;
    }

    const isAll = () => {
      const v = String(sel.value ?? '').trim().toLowerCase();
      const label = sel.selectedOptions[0]?.textContent?.trim().toLowerCase() || '';
      return v === '' || v === '0' || v === 'todos' || v === 'all' || label === 'todos' || label === 'all';
    };

    function setWidthForText(text){
      if (window.matchMedia('(max-width: 900px)').matches){
        sel.style.width = '';
        return;
      }
      const span = ensureMeasurer();
      span.textContent = text || '';
      const base = span.getBoundingClientRect().width;
      const EXTRA = 28, MIN_ALL = 84, MIN_VAL = 140, MAX = 420;

      if (isAll()){
        sel.style.width = `${MIN_ALL}px`;
        return;
      }
      const w = Math.min(Math.max(Math.ceil(base + EXTRA), MIN_VAL), MAX);
      sel.style.width = `${w}px`;
    }

    function sync(){
      const all = isAll();
      sel.classList.toggle('is-all', all);
      sel.classList.toggle('has-value', !all);
      const text = sel.selectedOptions[0]?.textContent || '';
      setWidthForText(text);
    }

    sel.addEventListener('change', sync);
    window.addEventListener('resize', sync);

    const obs = new MutationObserver(sync);
    obs.observe(sel, { childList:true, subtree:true, characterData:true });

    requestAnimationFrame(sync);
  })();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();
