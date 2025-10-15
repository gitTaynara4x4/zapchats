// /frontend/js/pages/departamentos.js
(function DepartamentosPage(){
  'use strict';

  // ===== Helpers =====
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const debounce = (fn, ms=180)=> { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
  const clamp = (v, a, b)=> Math.min(b, Math.max(a, v));

  const EMPRESA_ID = Number(localStorage.getItem('empresa_id') || '') || null;
  const IS_COARSE  = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
  const IS_MOBILE  = IS_COARSE || (typeof window !== 'undefined' && window.innerWidth <= 1024);

  const Loader = {
    show(t){ if (window.PageLoading?.show) PageLoading.show(t,{scope:'.main'}); else if (window.Loading?.show) Loading.show(t); else if (window.wait) wait(t); },
    hide(){ if (window.PageLoading?.hide) PageLoading.hide(); else if (window.Loading?.hide) Loading.hide(); else if (window.ready) ready(); }
  };

  // ✅ usa guardFetch se existir (melhor UX em 401/403)
  const authFetch = (url, opt = {}) => {
    const F = window.ZAuth?.guardFetch || window.ZAuth?.authFetch || fetch;
    const headers = Object.assign(
      { 'Accept':'application/json' },
      opt.headers || {},
      EMPRESA_ID ? { 'X-Empresa-Id': String(EMPRESA_ID) } : {}
    );
    return F(url, { credentials:'include', ...opt, headers });
  };

  function withEmpresaIdQuery(path){
    try{
      const u = new URL(path, location.origin);
      if (EMPRESA_ID && !u.searchParams.has('empresa_id')){
        u.searchParams.set('empresa_id', String(EMPRESA_ID));
      }
      return u.toString();
    }catch{
      const sep = path.includes('?') ? '&' : '?';
      return (EMPRESA_ID && !/(\?|&)empresa_id=/.test(path)) ? path+sep+'empresa_id='+EMPRESA_ID : path;
    }
  }

  async function parseMaybeJSON(res){
    const txt = await res.text().catch(()=> '');
    try{ return txt ? JSON.parse(txt) : null; }catch{ return txt || null; }
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
  async function apiJSON(path, method, body){
    const r = await authFetch(withEmpresaIdQuery(path), {
      method,
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(body)
    });
    const data = await parseMaybeJSON(r);
    if (!r.ok) throwHTTP(r, data);
    return data;
  }

  // ===== UI refs =====
  let filtro, btnAdd, btnExpand, btnCollapse, tbody, empty;
  let modal, modalTit, btnX, btnSalva, btnCanc, form, inpId, inpNome, selParent, inpCodigo, chkAtivo, txtDesc, toastEl;
  let pathPrevWrap, pathPrevCode;
  let btnViewTable, btnViewOrg, sectionTable, sectionOrg, orgContainer;

  // Whats (instâncias)
  let whatsBtn, whatsPanel, whatsSearch, whatsListEl, whatsChipsEl;

  // ===== ÍCONES SVG (currentColor) =====
  const SVGS = {
    edit:  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M225.9,74.78,181.21,30.09a14,14,0,0,0-19.8,0L38.1,153.41a13.94,13.94,0,0,0-4.1,9.9V208a14,14,0,0,0,14,14H92.69a13.94,13.94,0,0,0,9.9-4.1L225.9,94.58a14,14,0,0,0,0-19.8ZM94.1,209.41a2,2,0,0,1-1.41.59H48a2,2,0,0,1-2-2V163.31a2,2,0,0,1,.59-1.41L136,72.48,183.51,120ZM217.41,86.1,192,111.51,144.49,64,169.9,38.58a2,2,0,0,1,2.83,0l44.68,44.69a2,2,0,0,1,0,2.83Z"/></svg>',
    add:   '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M222,128a6,6,0,0,1-6,6H134v82a6,6,0,0,1-12,0V134H40a6,6,0,0,1,0-12h82V40a6,6,0,0,1,12,0v82h82A6,6,0,0,1,222,128Z"/></svg>',
    trash: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M216,50H174V40a22,22,0,0,0-22-22H104A22,22,0,0,0,82,40V50H40a6,6,0,0,0,0,12H50V208a14,14,0,0,0,14,14H192a14,14,0,0,1,14-14V62h10a6,6,0,0,0,0-12ZM94,40a10,10,0,0,1,10-10h48a10,10,0,0,1,10,10V50H94ZM194,208a2,2,0,0,1-2,2H64a2,2,0,0,1-2-2V62H194ZM110,104v64a6,6,0,0,1-12,0V104a6,6,0,0,1,12,0Z"/></svg>'
  };

  const state = {
    flat: [],
    nested: [],
    q: '',
    editing: null,
    expanded: new Set(),
    view: 'org',          // vai ser ajustado no init antes de carregar
    companyName: null,
    zoom: 1, tx: 0, ty: 0, _pzInit: false,

    // Whats (instâncias)
    instancias: [],           // [{id, nome, numero}]
    instanciasLoaded: false,
    whatsSelected: new Set(), // Set<number>
  };

  const PZ = { MIN: 0.5, MAX: 2.5, STEP: 1.2 };

  const SUGESTOES = [
    'Financeiro','Contabilidade','Fiscal','Cobrança','Comercial','Pré-vendas','Pós-vendas',
    'Marketing','Produto','Sucesso do Cliente','Atendimento','Suporte','Operações',
    'Logística','Expedição','Compras','Recursos Humanos','Pessoas & Cultura','Treinamento',
    'TI','Desenvolvimento','Infraestrutura','Segurança da Informação','Jurídico',
    'Qualidade','Projetos','Parcerias','Administrativo','Diretoria','Vendas'
  ];

  function toast(msg, type='ok'){
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    toastEl.style.background = type==='err' ? '#7f1d1d'
                           : type==='warn'? '#78350f'
                           : '#065f46';
    clearTimeout(toast._t);
    toast._t = setTimeout(()=>{ toastEl.style.display='none'; }, 2200);
  }

  // ===== Normalização =====
  function normalizeRows(rows){
    const arr = Array.isArray(rows) ? rows : [];
    return arr.map(r => {
      const id = Number(r.id ?? r.dep_id ?? r.depto_id ?? r.ID);
      const parent_id_raw = r.parent_id ?? r.parentId ?? r.pai_id ?? r.parent ?? null;
      const parent_id = (parent_id_raw !== null && parent_id_raw !== undefined)
        ? (Number(parent_id_raw) || null)
        : null;

      let path = [];
      if (Array.isArray(r.path)) {
        path = r.path.map(s => String(s ?? '').trim()).filter(Boolean);
      } else if (typeof r.path === 'string') {
        path = r.path.split(/\s*(?:>|\/|\u203A)\s*/g).map(s => s.trim()).filter(Boolean);
      } else if (Array.isArray(r.path_parts)) {
        path = r.path_parts.map(s => String(s ?? '').trim()).filter(Boolean);
      }

      const codigo    = r.codigo ?? r.code ?? r.sigla ?? null;
      const ativo     = (r.ativo ?? r.active ?? true) ? true : false;
      const descricao = r.descricao ?? r.obs ?? r.descr ?? null;
      const nomeRaw   = r.nome ?? r.name ?? r.titulo ?? r.label ?? (path[path.length-1] || '');
      const nome      = String(nomeRaw).trim();

      // Whats: aceita vários formatos e normaliza para array numérico
      let whats = r.whatsapp_instancias ?? r.whatsapps ?? r.whats_ids ?? r.instances ?? [];
      if (!Array.isArray(whats)) whats = [whats];
      const whatsapp_instancias = whats.map(n => Number(n)).filter(Number.isFinite);

      return { id, parent_id, nome, path, codigo, ativo, descricao, whatsapp_instancias, children: [] };
    }).filter(x => Number.isFinite(x.id));
  }

  function labelOf(n){
    if (n && n.nome && String(n.nome).trim()) return String(n.nome).trim();
    if (n && Array.isArray(n.path) && n.path.length) return String(n.path[n.path.length-1]).trim();
    return '(sem nome)';
  }

  // ===== Data =====
  async function loadTree(){
    Loader.show('Carregando...');
    try{
      let rows = null;
      try{
        rows = await apiGet('/api/atendimento/clientes/departamentos/tree');
      }catch{
        rows = await apiGet('/api/departamentos/tree');
      }
      state.flat = normalizeRows(rows);
      buildNested();
      fillParentSelect();
      if (state.view === 'table') renderTable();
      if (state.view === 'org')   renderOrg();
    } finally { Loader.hide(); }
  }

  async function loadEmpresaName(){
    if (!EMPRESA_ID) { state.companyName = null; return; }
    try{
      const emp = await apiGet(`/api/empresas/${EMPRESA_ID}`);
      state.companyName = String(emp?.nome || '').trim() || null;
    }catch{ state.companyName = null; }
  }

  function normalizeInstancias(arr){
    // desembrulha respostas {instancias:[]}, {results:[]}, {data:[]}, {items:[]}
    const raw = Array.isArray(arr) ? arr
              : Array.isArray(arr?.instancias) ? arr.instancias
              : Array.isArray(arr?.results)    ? arr.results
              : Array.isArray(arr?.data)       ? arr.data
              : Array.isArray(arr?.items)      ? arr.items
              : [];

    return raw.map(i=>{
      // id pode vir com vários nomes
      const id =
        Number(
          i.id ?? i.instance_id ?? i.instancia_id ?? i.ID ?? i.pk ?? i.whatsapp_id
        );

      // nome pode vir como "apelido", "instance_name", "slug", etc.
      const slugLike = String(i.instance_name ?? i.slug ?? '').trim();
      const preferido =
        i.apelido ?? i.nome ?? i.name ?? i.alias ?? i.label ??
        i.sessionName ?? i.instance ?? i.titulo ?? slugLike;

      const nome = (preferido ? String(preferido).trim() : '') || (id ? `Instância ${id}` : '');
      // número também muda de chave em APIs diferentes
      const numero = String(
        i.numero_instancia ?? i.numero ?? i.number ?? i.phone ??
        i.msisdn ?? i.whatsapp ?? ''
      ).replace(/[^\d+]/g,'');

      return (Number.isFinite(id) || nome) ? { id, nome, numero } : null;
    }).filter(Boolean);
  }

  async function loadInstanciasWhats(){
    if (state.instanciasLoaded) return;
    Loader.show('Carregando instâncias...');
    try{
      let data = null;

      // PRIORIDADE: endpoint por empresa
      if (EMPRESA_ID){
        try{
          data = await apiGet(`/api/empresas/${EMPRESA_ID}/whatsapp`);
          if (data && Array.isArray(data.instancias)) data = data.instancias;
          else if (data && Array.isArray(data.results)) data = data.results;
          else if (data && Array.isArray(data.data))    data = data.data;
        }catch(e){}
      }

      // Fallbacks
      if (!Array.isArray(data) || data.length === 0){
        try{ data = await apiGet('/api/whatsapp/instancias'); }catch(e){}
      }
      if (!Array.isArray(data) || data.length === 0){
        try{ data = await apiGet('/api/instancias'); }catch(e){}
      }
      if (!Array.isArray(data) || data.length === 0){
        try{ data = await apiGet('/api/whats/instances'); }catch(e){}
      }

      state.instancias = normalizeInstancias(data || []);
      state.instanciasLoaded = true;

      renderWhatsList();
      renderWhatsChips();
      setWhatsButtonText();
    }catch(e){
      console.error(e);
      state.instancias = [];
      state.instanciasLoaded = true;
      renderWhatsList();
    }finally{
      Loader.hide();
    }
  }

  // Para editar: busca detalhes do depto se a lista de instâncias não veio no tree
  async function loadDeptoDetails(id){
    try{ return await apiGet(`/api/atendimento/clientes/departamentos/${id}`); }
    catch(_){ try{ return await apiGet(`/api/departamentos/${id}`); }
    catch(_2){ return null; } }
  }

  // ===== Montagem do nested =====
  function buildNested(){
    const byId = new Map();
    const roots = [];
    state.flat.forEach(d => byId.set(d.id, {...d, children: []}));
    state.flat.forEach(d => {
      const node = byId.get(d.id);
      if (d.parent_id && byId.has(d.parent_id)) byId.get(d.parent_id).children.push(node);
      else roots.push(node);
    });
    const sortRec = (n) => {
      n.children.sort((a,b)=> (labelOf(a) || '').localeCompare((labelOf(b) || ''),'pt-BR'));
      n.children.forEach(sortRec);
    };
    roots.forEach(sortRec);
    state.nested = roots;
  }

  function fillParentSelect(){
    if (!selParent) return;
    const selVal = selParent.value || '';
    selParent.innerHTML = '<option value="">Empresa (raiz)</option>';
    const dash = '\u2014 ';
    const push = (n, level=0) => {
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = `${dash.repeat(level)}${labelOf(n)}`;
      selParent.appendChild(opt);
      n.children.forEach(c => push(c, level+1));
    };
    state.nested.forEach(n => push(n, 0));
    selParent.value = selVal;
  }

  // ===== Render — TABELA =====
  function escapeHtml(s){
    return String(s ?? '').replace(/[&<>"']/g, m => (
      m==='&'?'&amp;' : m==='<'?'&lt;' : m==='>'?'&gt;' : m==='"'?'&quot;' : '&#39;'
    ));
  }

  function hasMatchInSubtree(n, q){
    if (!q) return true;
    if ((labelOf(n) || '').toLowerCase().includes(q)) return true;
    return n.children.some(c => hasMatchInSubtree(c, q));
  }

  function renderTable(){
    if (!tbody || !empty) return;
    const q = (state.q||'').toLowerCase();
    tbody.innerHTML = '';
    let i = 0;

    const hasAny = state.nested.length > 0;
    empty.style.display = hasAny ? 'none' : 'flex';

    const drawNode = (n, level=0) => {
      const label = labelOf(n);
      const include = !q || (label || '').toLowerCase().includes(q) || hasMatchInSubtree(n, q);
      if (!include) return;

      // 👉 no mobile: sempre expandido (sem toggle)
      const expanded = IS_MOBILE ? true : (state.expanded.has(n.id) || !!q);

      const tr = document.createElement('tr');
      tr.dataset.id = n.id;
      tr.draggable = true;

      tr.innerHTML = `
        <td>${++i}</td>
        <td>
          <div class="tree-node">
            <span class="indent" style="--level:${level}"></span>
            ${IS_MOBILE ? '' : `
              <button class="twisty ${n.children.length? (expanded?'is-open':'') : 'is-leaf'}"
                      aria-label="${expanded?'Recolher':'Expandir'}" type="button">
                <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
              </button>
            `}
            <span class="label">${escapeHtml(label)}</span>
          </div>
        </td>
        <td><code>${Array.isArray(n.path) ? n.path.join(' / ') : ''}</code></td>
        <td>${escapeHtml(n.codigo||'')}</td>
        <td>${n.ativo ? '<i class="fa fa-check" aria-label="Ativo"></i>' : '<i class="fa fa-xmark" aria-label="Inativo"></i>'}</td>
        <td class="td-actions">
          <button class="btn" data-action="edit" data-id="${n.id}" title="Editar" type="button" aria-label="Editar">${SVGS.edit}</button>
          <button class="btn" data-action="add-child" data-id="${n.id}" title="Adicionar filho" type="button" aria-label="Adicionar filho">${SVGS.add}</button>
          <button class="btn" data-action="del"  data-id="${n.id}" title="Remover" type="button" aria-label="Remover">${SVGS.trash}</button>
        </td>
      `.trim();
      tbody.appendChild(tr);

      // toggle só no desktop
      if (!IS_MOBILE){
        const twisty = tr.querySelector('.twisty');
        if (twisty && n.children.length){
          twisty.addEventListener('click', ()=>{
            if (expanded) state.expanded.delete(n.id);
            else state.expanded.add(n.id);
            renderTable();
          });
        }
      }

      attachDragHandlers(tr);

      if (expanded){
        n.children.forEach(c => drawNode(c, level+1));
      }
    };

    state.nested.forEach(n => drawNode(n, 0));
  }

  // ===== Drag & Drop (tabela)
  let draggingId = null;
  function attachDragHandlers(tr){
    tr.addEventListener('dragstart', e=>{
      draggingId = Number(tr.dataset.id);
      tr.classList.add('dragging');
      e.dataTransfer.setData('text/plain', draggingId);
    });
    tr.addEventListener('dragend', ()=>{
      draggingId = null;
      tr.classList.remove('dragging');
      $$('.drop-target', tbody).forEach(el=> el.classList.remove('drop-target'));
    });
    tr.addEventListener('dragover', e=>{
      if (!draggingId) return;
      e.preventDefault();
      tr.classList.add('drop-target');
    });
    tr.addEventListener('dragleave', ()=>{
      tr.classList.remove('drop-target');
    });
    tr.addEventListener('drop', async e=>{
      e.preventDefault();
      tr.classList.remove('drop-target');
      const targetId = Number(tr.dataset.id);
      if (!draggingId || draggingId === targetId) return;

      try{
        Loader.show('Movendo...');
        await patchMove(draggingId, targetId);
        toast('Movido.');
        await loadTree();
        state.expanded.add(targetId);
        renderTable();
      }catch(err){
        console.error(err);
        toast(err?.data?.detail || 'Falha ao mover','err');
      }finally{ Loader.hide(); }
    });
  }

  async function patchMove(id, newParentId){
    const body = { new_parent_id: newParentId ?? null };
    try{
      await apiJSON(`/api/atendimento/clientes/departamentos/${id}`, 'PATCH', body);
      return;
    }catch{}
    try{
      await apiJSON(`/api/atendimento/clientes/departamentos/${id}/move`, 'PATCH', body);
    }catch{
      await apiJSON(`/api/departamentos/${id}/move`, 'PATCH', body);
    }
  }

  // ===== Render — ORGANOGRAMA (desktop) =====
  let orgResizeObs = null;
  let wireRaf = 0;

  const queueWireDraw = ()=>{
    if (wireRaf) cancelAnimationFrame(wireRaf);
    wireRaf = requestAnimationFrame(()=> requestAnimationFrame(()=>{ drawOrgWires(); }));
  };

  function renderOrg(){
    if (!orgContainer) return;

    if (orgResizeObs){ try{ orgResizeObs.disconnect(); }catch{} orgResizeObs = null; }
    orgContainer.innerHTML = '';

    const toolbar = document.createElement('div');
    toolbar.className = 'org-toolbar';
    toolbar.innerHTML = `
      <button type="button" class="org-zoom-out" aria-label="Diminuir">−</button>
      <button type="button" class="org-zoom-reset" aria-label="Centralizar">⤿</button>
      <button type="button" class="org-zoom-in" aria-label="Aumentar">+</button>
    `;

    const viewport = document.createElement('div');
    viewport.className = 'org-viewport';
    const stage = document.createElement('div');
    stage.className = 'org-stage';
    viewport.appendChild(stage);

    const inner = document.createElement('div');
    inner.className = 'org-inner';

    const rootLi = document.createElement('li');
    const rootCard = buildNodeCard({ id: 0, nome: state.companyName || 'Empresa', path: [], ativo:true }, true);
    rootLi.appendChild(rootCard);
    const ulRoots = document.createElement('ul'); rootLi.appendChild(ulRoots);

    const ulTop = document.createElement('ul'); ulTop.className = 'org'; ulTop.appendChild(rootLi);
    inner.appendChild(ulTop);

    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('class','org-wires');
    inner.appendChild(svg);

    stage.appendChild(inner);
    orgContainer.appendChild(viewport);
    orgContainer.appendChild(toolbar);

    const q = (state.q||'').toLowerCase();
    const draw = (n, parentUL) => {
      const include = hasMatchInSubtree(n, q);
      if (!include) return;
      const li = document.createElement('li'); li.className = 'node-li';
      const card = buildNodeCard(n, false);
      if (!q || (labelOf(n) || '').toLowerCase().includes(q)) card.classList.add('match');
      li.appendChild(card);

      const expanded = state.expanded.has(n.id) || !!q;
      if (n.children?.length){
        const childUL = document.createElement('ul');
        if (expanded) n.children.forEach(c => draw(c, childUL));
        li.appendChild(childUL);
      }
      parentUL.appendChild(li);
    };
    state.nested.forEach(n => draw(n, ulRoots));

    queueWireDraw();
    setupPanZoom(viewport, stage, inner, rootCard);

    orgResizeObs = new ResizeObserver(debounce(()=> {
      if (state.view === 'org') queueWireDraw();
    }, 80));
    orgResizeObs.observe(inner);

    toolbar.querySelector('.org-zoom-in').addEventListener('click', ()=>{
      zoomAt(viewport, stage, PZ.STEP, viewport.clientWidth/2, viewport.clientHeight/2);
    });
    toolbar.querySelector('.org-zoom-out').addEventListener('click', ()=>{
      zoomAt(viewport, stage, 1/PZ.STEP, viewport.clientWidth/2, viewport.clientHeight/2);
    });
    toolbar.querySelector('.org-zoom-reset').addEventListener('click', ()=>{
      resetView(viewport, stage, inner, rootCard);
    });

    resetView(viewport, stage, inner, rootCard);
    state._pzInit = true;
  }

  function buildNodeCard(n, isRoot){
    const card = document.createElement('div');
    card.className = 'node-card' + (isRoot ? ' is-root' : '');

    const head = document.createElement('div'); head.className = 'node-head';
    const title = document.createElement('div'); title.className = 'node-title';
    title.textContent = isRoot ? (state.companyName || 'Empresa') : (labelOf(n) || '');

    const twist = document.createElement('button');
    twist.type = 'button';
    twist.className = 'node-twisty' + ((n.children?.length) ? '' : ' is-leaf');
    twist.innerHTML = (n.children?.length ? '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>' : '');
    twist.addEventListener('pointerdown', (ev)=>{ ev.stopPropagation(); });

    if (!isRoot && state.expanded.has(n.id)) twist.classList.add('is-open');

    if (!isRoot && n.children?.length){
      twist.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        const expanded = state.expanded.has(n.id);
        if (expanded) state.expanded.delete(n.id);
        else state.expanded.add(n.id);
        renderOrg();
      });
    }

    head.appendChild(title); head.appendChild(twist);

    const path = document.createElement('div'); path.className = 'node-path';
    path.textContent = isRoot ? '' : (Array.isArray(n.path) ? n.path.join(' / ') : '');

    const actions = document.createElement('div'); actions.className = 'node-actions';
    actions.addEventListener('pointerdown', ev => ev.stopPropagation());
    if (!isRoot){
      actions.innerHTML = `
        <button class="btn" data-action="edit" data-id="${n.id}" title="Editar" type="button" aria-label="Editar">${SVGS.edit}</button>
        <button class="btn" data-action="add-child" data-id="${n.id}" title="Adicionar filho" type="button" aria-label="Adicionar filho">${SVGS.add}</button>
        <button class="btn" data-action="del" data-id="${n.id}" title="Remover" type="button" aria-label="Remover">${SVGS.trash}</button>
      `;
    }

    card.appendChild(head);
    if (!isRoot) card.appendChild(path);
    if (!isRoot) card.appendChild(actions);
    return card;
  }

  // ===== Conectores via SVG =====
  function drawOrgWires(){
    const inner = orgContainer?.querySelector('.org-inner');
    const svg   = orgContainer?.querySelector('.org-wires');
    if (!inner || !svg) return;

    const sw = inner.scrollWidth;
    const sh = inner.scrollHeight;
    svg.setAttribute('width',  sw);
    svg.setAttribute('height', sh);
    svg.setAttribute('viewBox', `0 0 ${sw} ${sh}`);
    svg.innerHTML = '';

    const stroke =
      getComputedStyle(document.documentElement).getPropertyValue('--org-line').trim() || '#667085';

    const mkLine = (x1,y1,x2,y2) => {
      const p = document.createElementNS('http://www.w3.org/2000/svg','path');
      p.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`);
      p.setAttribute('stroke', stroke);
      p.setAttribute('stroke-width', '1');
      p.setAttribute('fill', 'none');
      p.setAttribute('shape-rendering','crispEdges');
      p.setAttribute('vector-effect','non-scaling-stroke');
      return p;
    };

    const mkPath = (d) => {
      const p = document.createElementNS('http://www.w3.org/2000/svg','path');
      p.setAttribute('d', d);
      p.setAttribute('stroke', stroke);
      p.setAttribute('stroke-width', '1');
      p.setAttribute('fill', 'none');
      p.setAttribute('shape-rendering','crispEdges');
      p.setAttribute('vector-effect','non-scaling-stroke');
      return p;
    };

    const isMobile = window.matchMedia('(max-width: 720px)').matches;

    inner.querySelectorAll('.org li').forEach(li => {
      const parentCard = li.querySelector(':scope > .node-card');
      const childUL = li.querySelector(':scope > ul');
      if (!parentCard || !childUL) return;

      const kids = Array.from(childUL.querySelectorAll(':scope > li > .node-card'));
      if (!kids.length) return;

      const p = _rectLayout(parentCard, inner);
      const boxes = kids.map(k => _rectLayout(k, inner));

      if (isMobile){
        boxes.forEach(b => {
          const midY = Math.round((p.bottom + b.top) / 2);
          svg.appendChild(mkPath(`M ${p.cx} ${p.bottom} V ${midY} H ${b.cx} V ${b.top}`));
        });
      }else{
        const gap = 10;
        const yLine = Math.min(...boxes.map(b => b.top)) - gap;
        svg.appendChild(mkLine(p.cx, p.bottom, p.cx, yLine));
        const x1 = Math.min(...boxes.map(b => b.cx));
        const x2 = Math.max(...boxes.map(b => b.cx));
        svg.appendChild(mkLine(x1, yLine, x2, yLine));
        boxes.forEach(b => svg.appendChild(mkLine(b.cx, yLine, b.cx, b.top)));
      }
    });
  }

  function _rectLayout(el, rel){
    let x = 0, y = 0;
    for (let n = el; n && n !== rel; n = n.offsetParent){ x += n.offsetLeft; y += n.offsetTop; }
    const w = el.offsetWidth, h = el.offsetHeight;
    return {
      left: x, top: y, width: w, height: h,
      get right(){ return this.left + this.width },
      get bottom(){ return this.top + this.height },
      get cx(){ return this.left + this.width/2 },
    };
  }

  // ===== Pan & Zoom =====
  function applyTransform(stage, viewport){
    stage.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.zoom})`;
    viewport?.classList?.toggle('is-zoomed', state.zoom !== 1);
  }
  function zoomAt(viewport, stage, factor, vx, vy){
    const prev = state.zoom;
    const next = clamp(prev * factor, PZ.MIN, PZ.MAX);
    const eff  = next / prev;
    state.tx = vx - eff * (vx - state.tx);
    state.ty = vy - eff * (vy - state.ty);
    state.zoom = next;
    applyTransform(stage, viewport);
  }
  function resetView(viewport, stage, inner, rootCard){
    const vpW = viewport.clientWidth, vpH = viewport.clientHeight;
    let x = 0, y = 0, w = rootCard.offsetWidth, h = rootCard.offsetHeight;
    for (let n = rootCard; n && n !== inner; n = n.offsetParent){ x += n.offsetLeft; y += n.offsetTop; }
    const rootCX = x + w/2, rootCY = y + h/2;
    state.zoom = 1; state.tx = (vpW/2) - rootCX; state.ty = Math.min(20, (vpH/2) - rootCY);
    applyTransform(stage, viewport);
  }
  function setupPanZoom(viewport, stage, inner, rootCard){
    stage.style.transformOrigin = '0 0';
    stage.style.willChange = 'transform';
    stage.style.userSelect = 'none';
    let isPanning = false, lastX = 0, lastY = 0;
    const pts = new Map();
    const INTERACTIVE = '.node-twisty, .node-actions .btn, .td-actions .btn, button, [role="button"], a, input, select, textarea';

    const onPointerDown = (e)=>{
      if (e.target?.closest?.(INTERACTIVE)) return;
      if (e.pointerType === 'mouse'){
        if (e.button !== 0) return;
        viewport.setPointerCapture?.(e.pointerId);
        pts.set(e.pointerId, {x:e.clientX, y:e.clientY});
        isPanning = true; lastX = e.clientX; lastY = e.clientY;
        viewport.classList.add('is-panning'); return;
      }
      pts.set(e.pointerId, {x:e.clientX, y:e.clientY});
      if (IS_COARSE && state.zoom == 1 && pts.size === 1){ return; }
      if (IS_COARSE && pts.size === 2){
        for (const id of pts.keys()){ try{ viewport.setPointerCapture?.(id); }catch{} }
        return;
      }
      if (IS_COARSE && state.zoom !== 1){
        viewport.setPointerCapture?.(e.pointerId);
        isPanning = true; lastX = e.clientX; lastY = e.clientY;
        viewport.classList.add('is-panning');
      }
    };
    const onPointerMove = (e)=>{
      if (!pts.has(e.pointerId)) return;
      const r = viewport.getBoundingClientRect();
      pts.set(e.pointerId, {x:e.clientX, y:e.clientY});
      if (pts.size === 2){
        const [p1, p2] = Array.from(pts.values());
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (!setupPanZoom._startDist){ setupPanZoom._startDist = dist; setupPanZoom._startZoom = state.zoom; }
        else{
          const factor = dist / setupPanZoom._startDist;
          const nz = clamp(setupPanZoom._startZoom * factor, PZ.MIN, PZ.MAX);
          const eff = nz / state.zoom;
          const cx = ((p1.x + p2.x)/2) - r.left, cy = ((p1.y + p2.y)/2) - r.top;
          state.tx = cx - eff * (cx - state.tx); state.ty = cy - eff * (cy - state.ty);
          state.zoom = nz; applyTransform(stage, viewport);
        }
        isPanning = false; return;
      }
      if (IS_COARSE && state.zoom === 1 && e.pointerType !== 'mouse'){ return; }
      if (isPanning){
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        state.tx += dx; state.ty += dy; lastX = e.clientX; lastY = e.clientY;
        applyTransform(stage, viewport);
      }
    };
    const onPointerUp = (e)=>{
      pts.delete(e.pointerId);
      if (pts.size < 2){ setupPanZoom._startDist = null; setupPanZoom._startZoom = null; }
      if (pts.size === 0){ isPanning = false; viewport.classList.remove('is-panning'); }
      try{ viewport.releasePointerCapture?.(e.pointerId); }catch{}
    };

    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerUp);
    viewport.addEventListener('pointerleave', onPointerUp);

    viewport.addEventListener('wheel', (e)=>{
      e.preventDefault();
      const r = viewport.getBoundingClientRect();
      const vx = e.clientX - r.left, vy = e.clientY - r.top;
      const factor = Math.pow(1.0015, -e.deltaY);
      zoomAt(viewport, stage, factor, vx, vy);
    }, { passive:false });

    let lastTap = 0;
    viewport.addEventListener('pointerdown', (e)=>{
      if (e.target?.closest?.(INTERACTIVE)) return;
      const now = Date.now();
      if (now - lastTap < 300){
        const r = viewport.getBoundingClientRect();
        zoomAt(viewport, stage, PZ.STEP, e.clientX - r.left, e.clientY - r.top);
      }
      lastTap = now;
    });

    window.addEventListener('orientationchange', ()=> setTimeout(()=> resetView(viewport, stage, inner, rootCard), 120));
  }

  // ===== Modal =====
  function showModal(){
    modal.style.display = 'grid';
    modal.setAttribute('aria-hidden','false');
    document.documentElement.classList.add('modal-open');
    document.addEventListener('keydown', onEscClose);
  }
  function closeModal(){
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden','true');
    document.documentElement.classList.remove('modal-open');
    modal.classList.remove('is-new');
    document.removeEventListener('keydown', onEscClose);
    // fecha dropdowns abertos
    $('#nome-dropdown')?.classList.remove('open');
    whatsPanel?.classList.remove('open');
    whatsBtn?.setAttribute('aria-expanded','false');
  }
  function onEscClose(e){ if (e.key === 'Escape') closeModal(); }

  function resetWhatsSelection(arrIds=[]){
    state.whatsSelected = new Set((Array.isArray(arrIds)?arrIds:[]).map(n=>Number(n)).filter(Number.isFinite));
    renderWhatsList();
    renderWhatsChips();
    setWhatsButtonText();
  }

  async function openModalNovo(parentId=null){
    state.editing = null;
    form?.reset();
    inpId.value = '';
    inpNome.value = '';
    inpCodigo.value = '';
    txtDesc.value = '';
    chkAtivo.checked = true;
    selParent.value = parentId ? String(parentId) : '';
    modalTit.textContent = 'Novo departamento';
    modal.classList.add('is-new');

    // Whats
    await loadInstanciasWhats();
    resetWhatsSelection([]);

    showModal();
    updatePathPreview();
  }

  async function openModalEditar(item){
    state.editing = item;
    inpId.value = String(item.id);
    inpNome.value = item.nome || labelOf(item) || '';
    inpCodigo.value = item.codigo || '';
    txtDesc.value = item.descricao || '';
    chkAtivo.checked = !!item.ativo;
    selParent.value = item.parent_id ? String(item.parent_id) : '';
    modalTit.textContent = 'Editar departamento';
    modal.classList.remove('is-new');

    await loadInstanciasWhats();

    let sel = [];
    if (Array.isArray(item.whatsapp_instancias) && item.whatsapp_instancias.length){
      sel = item.whatsapp_instancias;
    }else{
      // tenta puxar detalhes do depto
      try{
        const det = await loadDeptoDetails(item.id);
        let w = det?.whatsapp_instancias ?? det?.whatsapps ?? det?.whats_ids ?? det?.instances ?? [];
        if (!Array.isArray(w)) w = [w];
        sel = w.map(n=>Number(n)).filter(Number.isFinite);
      }catch{}
    }
    resetWhatsSelection(sel);

    showModal();
    updatePathPreview();
  }

  function updatePathPreview(){
    if (!pathPrevWrap || !pathPrevCode) return;
    const sel  = selParent?.options[selParent.selectedIndex]?.textContent || 'Empresa (raiz)';
    const nome = (inpNome.value || '').trim() || 'Novo departamento';
    const parts = [];
    if (sel && !/empresa/i.test(sel)) parts.push(sel.replace(/^\u2014\s*/g,'').trim());
    parts.push(nome);
    pathPrevCode.textContent = parts.join(' \u203A ');
    pathPrevWrap.style.display = parts.length ? 'block' : 'none';
  }

  async function salvar(){
    const nome = (inpNome.value||'').trim();
    if (!nome){ toast('Informe o nome.','warn'); inpNome.focus(); return; }

    const payload = {
      nome,
      descricao: (txtDesc.value||'').trim() || null,
      parent_id: selParent.value ? Number(selParent.value) : null,
      codigo: (inpCodigo.value||'').trim() || null,
      ativo: !!chkAtivo.checked,
      whatsapp_instancias: Array.from(state.whatsSelected) // mantém as instâncias selecionadas
    };

    if (btnSalva) btnSalva.disabled = true;
    Loader.show('Salvando...');
    try{
      if (!state.editing){
        await apiJSON('/api/atendimento/clientes/departamentos', 'POST', payload)
          .catch(async()=> await apiJSON('/api/departamentos', 'POST', payload));
      }else{
        const id = state.editing.id;
        await apiJSON(`/api/atendimento/clientes/departamentos/${id}`, 'PUT', payload)
          .catch(async()=> await apiJSON(`/api/departamentos/${id}`, 'PUT', payload));
      }
      toast('Salvo com sucesso.');
      closeModal();
      await loadTree();
    }catch(e){
      console.error(e);
      const msg = e?.data?.detail
        || (e?.status===409 ? 'Já existe um departamento com esse nome.' : null)
        || 'Não foi possível salvar. Tente novamente.';
      toast(msg, 'err');
    }finally{
      Loader.hide();
      if (btnSalva) btnSalva.disabled = false;
    }
  }

  async function remover(id){
    if (!id) return;
    if (!confirm('Remover este departamento? Filhos precisam ser movidos/removidos antes.')) return;

    Loader.show('Removendo...');
    try{
      try{ await apiJSON(`/api/atendimento/clientes/departamentos/${id}`, 'DELETE'); }
      catch(_){ await apiJSON(`/api/departamentos/${id}`, 'DELETE'); }
      toast('Removido.');
      await loadTree();
    }catch(e){
      console.error(e);
      toast(e?.data?.detail || 'Não foi possível remover.','err');
    }finally{
      Loader.hide();
    }
  }

  // ===== Whats (UI) =====
  function setWhatsButtonText(){
    if (!whatsBtn) return;
    const n = state.whatsSelected.size;
    if (!n){ whatsBtn.textContent = 'Selecione as instâncias...'; return; }
    if (n === 1){
      const id = [...state.whatsSelected][0];
      const it = state.instancias.find(x => x.id === id);
      whatsBtn.textContent = it ? `${it.nome}${it.numero?` (${it.numero})`:''}` : '1 instância selecionada';
    }else{
      whatsBtn.textContent = `${n} instâncias selecionadas`;
    }
  }

  function renderWhatsList(){
    if (!whatsListEl) return;
    const q = (whatsSearch?.value || '').trim().toLowerCase();
    const data = state.instancias.filter(i => {
      if (!q) return true;
      return (i.nome||'').toLowerCase().includes(q) || (i.numero||'').toLowerCase().includes(q);
    });

    whatsListEl.innerHTML = '';
    if (!data.length){
      const empty = document.createElement('div');
      empty.className = 'dd-item';
      empty.style.opacity = .7;
      empty.textContent = 'Nenhuma instância disponível';
      whatsListEl.appendChild(empty);
      return;
    }

    data.forEach(i=>{
      const row = document.createElement('label');
      row.className = 'dd-item';
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '.55rem';
      row.dataset.id = String(i.id);

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = String(i.id);
      cb.checked = state.whatsSelected.has(i.id);
      cb.addEventListener('change', ()=>{
        if (cb.checked) state.whatsSelected.add(i.id);
        else state.whatsSelected.delete(i.id);
        renderWhatsChips();
        setWhatsButtonText();
      });

      const text = document.createElement('span');
      text.innerHTML = `<strong>${escapeHtml(i.nome)}</strong>${i.numero?` — <span style="opacity:.8">${escapeHtml(i.numero)}</span>`:''}`;

      row.appendChild(cb);
      row.appendChild(text);
      whatsListEl.appendChild(row);
    });
  }

  function renderWhatsChips(){
    if (!whatsChipsEl) return;
    whatsChipsEl.innerHTML = '';
    if (!state.whatsSelected.size) return;

    const ids = [...state.whatsSelected];
    ids.forEach(id=>{
      const it = state.instancias.find(x => x.id === id);
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.marginTop = '.45rem';
      chip.style.marginRight = '.45rem';
      chip.innerHTML = `${escapeHtml(it?.nome || String(id))}${it?.numero?` <small style="opacity:.75">${escapeHtml(it.numero)}</small>`:''} <button type="button" aria-label="Remover" style="border:0;background:transparent;cursor:pointer;font-weight:900">×</button>`;
      chip.querySelector('button').addEventListener('click', ()=>{
        state.whatsSelected.delete(id);
        // desmarca no dropdown pelo id (evita colisão por nome igual)
        const cb = whatsListEl?.querySelector(`input[type="checkbox"][data-id="${id}"]`);
        if (cb) cb.checked = false;
        renderWhatsChips();
        setWhatsButtonText();
        renderWhatsList(); // para refletir checkboxes
      });
      whatsChipsEl.appendChild(chip);
    });
  }

  function toggleWhatsPanel(open){
    if (!whatsPanel || !whatsBtn) return;
    if (open === undefined) open = !whatsPanel.classList.contains('open');

    whatsPanel.classList.toggle('open', open);
    // garante que aparece mesmo sem CSS
    whatsPanel.style.display = open ? 'block' : 'none';

    // se abriu, (re)renderiza a lista (caso tenha sido filtrada antes)
    if (open) renderWhatsList();

    whatsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function bindWhats(){
    // garante o posicionamento do dropdown
    const multi = $('#fi-whats .multi');
    if (multi && multi.style) multi.style.position = 'relative';

    // 🔒 evita registrar mais de uma vez
    if (bindWhats._bound) return;
    bindWhats._bound = true;

    // Abre/fecha ao clicar no botão (delegação global)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest?.('#whats-btn');
      if (!btn) return;

      // abre imediatamente
      toggleWhatsPanel();

      // carrega em paralelo, sem travar o abrir
      if (!state.instanciasLoaded) {
        loadInstanciasWhats().catch(console.error);
      }

      // foca a busca se abriu
      if (whatsPanel?.classList.contains('open')) {
        whatsSearch?.focus();
      }
    });

    // Busca no dropdown
    whatsSearch?.addEventListener('input', debounce(renderWhatsList, 80));

    // Fecha ao clicar fora / rolar / ESC / resize
    const ddCloseIfOutside = (e)=>{
      if (!whatsPanel?.classList.contains('open')) return;
      if (!e.target.closest?.('#fi-whats')) toggleWhatsPanel(false);
    };
    document.addEventListener('pointerdown', ddCloseIfOutside);

    const modalBody = document.querySelector('#modal-depto .modal-body');
    modalBody?.addEventListener('scroll', ()=> toggleWhatsPanel(false));
    document.addEventListener('keydown', (e)=>{ if (e.key==='Escape') toggleWhatsPanel(false); });
    window.addEventListener('resize', ()=> toggleWhatsPanel(false));
  }

  // ===== Bind =====
  function bind(){
    filtro.addEventListener('input', debounce(()=>{
      state.q = (filtro.value||'').trim();
      (state.view==='table' ? renderTable : renderOrg)();
      if (state.view==='org') queueWireDraw();
    }, 160));
    btnAdd.addEventListener('click', ()=> openModalNovo());
    $('#btn-add-empty')?.addEventListener('click', ()=> openModalNovo());

    btnExpand.addEventListener('click', ()=>{
      state.flat.forEach(d => state.expanded.add(d.id));
      (state.view==='table' ? renderTable : renderOrg)();
      if (state.view==='org') queueWireDraw();
    });
    btnCollapse.addEventListener('click', ()=>{
      state.expanded.clear();
      (state.view==='table' ? renderTable : renderOrg)();
      if (state.view==='org') queueWireDraw();
    });

    // Toggle de visualização
    btnViewTable.addEventListener('click', ()=>{
      state.view = 'table';
      btnViewTable.classList.add('is-active'); btnViewTable.setAttribute('aria-selected','true');
      btnViewOrg.classList.remove('is-active'); btnViewOrg.setAttribute('aria-selected','false');
      sectionTable.style.display = '';
      sectionOrg.style.display = 'none';
      renderTable();
    });
    btnViewOrg.addEventListener('click', ()=>{
      state.view = 'org';
      btnViewOrg.classList.add('is-active'); btnViewOrg.setAttribute('aria-selected','true');
      btnViewTable.classList.remove('is-active'); btnViewTable.setAttribute('aria-selected','false');
      sectionTable.style.display = 'none';
      sectionOrg.style.display = '';
      renderOrg();
    });

    // ações dos botões (edit/add/delete)
    document.addEventListener('click', (e)=>{
      const b = e.target.closest?.('[data-action]');
      if (!b) return;
      const id = Number(b.dataset.id);
      if (b.dataset.action === 'edit'){
        const item = state.flat.find(x => Number(x.id)===id);
        if (item) openModalEditar(item);
      }else if (b.dataset.action === 'del'){
        remover(id);
      }else if (b.dataset.action === 'add-child'){
        openModalNovo(id);
      }
    });

    // Dropdown de sugestões (Nome)
    const dd = $('#nome-dropdown');
    const openDD = ()=>{
      openNomeDropdown();
      inpNome?.setAttribute('aria-expanded','true');
    };
    inpNome.addEventListener('pointerdown', openDD);
    inpNome.addEventListener('input', openDD);
    inpNome.addEventListener('blur', ()=>{
      setTimeout(()=>{
        dd?.classList.remove('open');
        inpNome?.setAttribute('aria-expanded','false');
      }, 120);
    });

    // FECHAMENTO extra do dropdown de nome
    const modalBody = document.querySelector('#modal-depto .modal-body');
    if (modalBody){
      modalBody.addEventListener('scroll', ()=> dd?.classList.remove('open'));
    }
    document.addEventListener('pointerdown', (e)=>{
      if (!e.target.closest?.('.fi-nome')) dd?.classList.remove('open');
    });
    document.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape') dd?.classList.remove('open');
    });

    // Whats
    bindWhats();

    // ✅ Prévia atualiza ao digitar/trocar o pai
    inpNome.addEventListener('input', updatePathPreview);
    selParent.addEventListener('change', updatePathPreview);

    window.addEventListener('resize', debounce(()=>{
      if (state.view==='org') queueWireDraw();
    }, 140));
  }

  function openNomeDropdown(){
    const dd = $('#nome-dropdown');
    if (!dd) return;
    const q = (inpNome.value||'').toLowerCase();
    dd.innerHTML = '';
    SUGESTOES.filter(s => !q || s.toLowerCase().includes(q))
      .forEach(s=>{
        const it = document.createElement('div');
        it.className = 'dd-item';
        it.textContent = s;
        it.addEventListener('mousedown', (ev)=>{
          ev.preventDefault();
          inpNome.value = s;
          updatePathPreview();
          dd.classList.remove('open');
          inpNome?.setAttribute('aria-expanded','false');
        });
        dd.appendChild(it);
      });
    dd.classList.add('open');
  }

  // ===== Init =====
  async function init(){
    filtro      = $('#filtro');
    btnAdd      = $('#btn-add');
    btnExpand   = $('#btn-expand');
    btnCollapse = $('#btn-collapse');
    tbody       = $('#tb-deptos');
    empty       = $('#empty');

    sectionTable = $('#section-table');
    sectionOrg   = $('#section-org');
    orgContainer = $('#org-container');
    btnViewTable = $('#btn-view-table');
    btnViewOrg   = $('#btn-view-org');

    modal    = $('#modal-depto');
    modalTit = $('#modal-title');
    btnX     = $('#modal-fechar');
    btnSalva = $('#modal-salvar');
    btnCanc  = $('#modal-cancelar');
    form     = $('#form-depto');
    inpId    = form?.querySelector('input[name="id"]') || document.createElement('input');
    inpNome  = $('#d-nome');
    selParent= $('#d-parent');
    inpCodigo= $('#d-codigo');
    chkAtivo = $('#d-ativo');
    txtDesc  = $('#d-desc');
    pathPrevWrap = $('#path-preview');
    pathPrevCode = $('#path-preview-code');
    toastEl  = $('#toast');

    // Whats refs
    whatsBtn    = $('#whats-btn');
    whatsPanel  = $('#whats-panel');
    whatsSearch = $('#whats-search');
    whatsListEl = $('#whats-list');
    whatsChipsEl= $('#whats-chips');

    bind();

    // ✅ DECIDE A VIEW PRIMEIRO (antes de carregar dados)
    if (IS_MOBILE){
      state.view = 'table';

      if (btnViewOrg){
        btnViewOrg.style.display = 'none';
        btnViewOrg.setAttribute('aria-hidden','true');
        btnViewOrg.tabIndex = -1;
      }
      if (sectionOrg) sectionOrg.style.display = 'none';

      // tudo expandido por padrão (melhor navegação)
      // (o render respeita isso)
      // será populado após loadTree
      btnViewTable.classList.add('is-active'); btnViewTable.setAttribute('aria-selected','true');
      sectionTable.style.display = '';
    } else {
      state.view = 'org';
      btnViewTable.classList.remove('is-active'); btnViewTable.setAttribute('aria-selected','false');
      btnViewOrg.classList.add('is-active');      btnViewOrg.setAttribute('aria-selected','true');
      sectionTable.style.display = 'none';
      sectionOrg.style.display   = '';
    }

    btnX.addEventListener('click', closeModal);
    btnCanc.addEventListener('click', closeModal);
    btnSalva.addEventListener('click', salvar);
    form.addEventListener('submit', (e)=>{ e.preventDefault(); salvar(); });

    await loadEmpresaName();
    await loadTree();

    if (IS_MOBILE){
      // após ter a árvore, expande tudo
      state.flat.forEach(d => state.expanded.add(d.id));
      renderTable();
    }
  }

  // Gate / Start (usa Page.guarded se disponível)
  const run = () => (window.Page?.guarded?.(
    'departamentos.gerenciar',
    init,
    { msg: 'Sem permissão para Departamentos' }
  ) ?? init());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once:true });
  } else {
    run();
  }
})();
