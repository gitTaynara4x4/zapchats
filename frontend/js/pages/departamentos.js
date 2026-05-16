// /frontend/js/pages/departamentos.js
(function DepartamentosPage(){
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const debounce = (fn, ms = 180) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  const EMPRESA_ID = Number(localStorage.getItem('empresa_id') || '') || null;
  const IS_COARSE = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
  const IS_MOBILE = IS_COARSE || window.innerWidth <= 1024;

  const Loader = {
    show(t){
      if (window.PageLoading?.show) PageLoading.show(t, { scope: '.main' });
      else if (window.Loading?.show) Loading.show(t);
      else if (window.wait) wait(t);
    },
    hide(){
      if (window.PageLoading?.hide) PageLoading.hide();
      else if (window.Loading?.hide) Loading.hide();
      else if (window.ready) ready();
    }
  };

  const authFetch = (url, opt = {}) => {
    const F = window.ZAuth?.guardFetch || window.ZAuth?.authFetch || fetch;

    const headers = Object.assign(
      { Accept: 'application/json' },
      opt.headers || {},
      EMPRESA_ID ? { 'X-Empresa-Id': String(EMPRESA_ID) } : {}
    );

    return F(url, {
      credentials: 'include',
      ...opt,
      headers
    });
  };

  function withEmpresaIdQuery(path){
    try {
      const u = new URL(path, location.origin);

      if (EMPRESA_ID && !u.searchParams.has('empresa_id')) {
        u.searchParams.set('empresa_id', String(EMPRESA_ID));
      }

      return u.toString();
    } catch {
      const sep = path.includes('?') ? '&' : '?';

      return EMPRESA_ID && !/(\?|&)empresa_id=/.test(path)
        ? path + sep + 'empresa_id=' + EMPRESA_ID
        : path;
    }
  }

  async function parseMaybeJSON(res){
    const txt = await res.text().catch(() => '');

    try {
      return txt ? JSON.parse(txt) : null;
    } catch {
      return txt || null;
    }
  }

  function throwHTTP(res, data){
    const err = new Error(
      (data && (data.detail || data.message || data.error)) ||
      res.statusText ||
      'Erro'
    );

    err.status = res.status;
    err.data = data;

    throw err;
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await parseMaybeJSON(r);

    if (!r.ok) throwHTTP(r, data);

    return data;
  }

  const SVGS = {
    edit: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M225.9,74.78,181.21,30.09a14,14,0,0,0-19.8,0L38.1,153.41a13.94,13.94,0,0,0-4.1,9.9V208a14,14,0,0,0,14,14H92.69a13.94,13.94,0,0,0,9.9-4.1L225.9,94.58a14,14,0,0,0,0-19.8ZM94.1,209.41a2,2,0,0,1-1.41.59H48a2,2,0,0,1-2-2V163.31a2,2,0,0,1,.59-1.41L136,72.48,183.51,120ZM217.41,86.1,192,111.51,144.49,64,169.9,38.58a2,2,0,0,1,2.83,0l44.68,44.69a2,2,0,0,1,0,2.83Z"/></svg>',
    add: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M222,128a6,6,0,0,1-6,6H134v82a6,6,0,0,1-12,0V134H40a6,6,0,0,1,0-12h82V40a6,6,0,0,1,12,0v82h82A6,6,0,0,1,222,128Z"/></svg>',
    trash: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M216,50H174V40a22,22,0,0,0-22-22H104A22,22,0,0,0,82,40V50H40a6,6,0,0,0,0,12H50V208a14,14,0,0,0,14,14H192a14,14,0,0,0,14-14V62h10a6,6,0,0,0,0-12ZM94,40a10,10,0,0,1,10-10h48a10,10,0,0,1,10,10V50H94ZM194,208a2,2,0,0,1-2,2H64a2,2,0,0,1-2-2V62H194ZM110,104v64a6,6,0,0,1-12,0V104a6,6,0,0,1,12,0Z"/></svg>'
  };

  const SUGESTOES = [
    'Financeiro',
    'Contabilidade',
    'Fiscal',
    'Cobrança',
    'Comercial',
    'Pré-vendas',
    'Pós-vendas',
    'Marketing',
    'Produto',
    'Sucesso do Cliente',
    'Atendimento',
    'Suporte',
    'Operações',
    'Logística',
    'Expedição',
    'Compras',
    'Recursos Humanos',
    'Pessoas & Cultura',
    'Treinamento',
    'TI',
    'Desenvolvimento',
    'Infraestrutura',
    'Segurança da Informação',
    'Jurídico',
    'Qualidade',
    'Projetos',
    'Parcerias',
    'Administrativo',
    'Diretoria',
    'Vendas'
  ];

  let filtro;
  let btnAdd;
  let btnExpand;
  let btnCollapse;
  let tbody;
  let empty;

  let modal;
  let modalTit;
  let btnX;
  let btnSalva;
  let btnCanc;
  let form;
  let inpId;
  let inpNome;
  let selParent;
  let inpCodigo;
  let chkAtivo;
  let txtDesc;
  let toastEl;

  let pathPrevWrap;
  let pathPrevCode;

  let btnViewTable;
  let btnViewOrg;
  let sectionTable;
  let sectionOrg;
  let orgContainer;

  let inpExpIniPadrao;
  let inpExpFimPadrao;

  const state = {
    flat: [],
    nested: [],
    q: '',
    editing: null,
    expanded: new Set(),
    view: 'table',
    companyName: null,
    highlightId: null,
    animateNext: false
  };

  function releasePageLoader(){
    try { window.ready?.(); } catch {}
    try { window.Page?.ready?.(); } catch {}

    try {
      document.documentElement.classList.remove('prepaint');
      document.documentElement.setAttribute('data-head-ready', '1');
      document.documentElement.setAttribute('data-loader-ready', '1');
    } catch {}
  }

  function toast(msg, type = 'ok'){
    if (!toastEl) return;

    toastEl.textContent = String(msg || '');
    toastEl.style.display = 'block';
    toastEl.style.background = type === 'err'
      ? '#7f1d1d'
      : type === 'warn'
        ? '#78350f'
        : '#065f46';

    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      toastEl.style.display = 'none';
    }, 2500);
  }

  function escapeHtml(s){
    return String(s ?? '').replace(/[&<>"']/g, m => (
      m === '&' ? '&amp;' :
      m === '<' ? '&lt;' :
      m === '>' ? '&gt;' :
      m === '"' ? '&quot;' :
      '&#39;'
    ));
  }

  function normTime(val){
    if (val === null || val === undefined) return '';

    const s = String(val).trim();
    if (!s) return '';

    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return '';

    const hh = String(m[1]).padStart(2, '0');
    const mm = m[2];

    return `${hh}:${mm}`;
  }

  function normalizeRows(rows){
    const arr = Array.isArray(rows) ? rows : [];

    return arr.map(r => {
      const id = Number(r.id ?? r.dep_id ?? r.depto_id ?? r.ID);

      const parentRaw = r.parent_id ?? r.parentId ?? r.pai_id ?? r.parent ?? null;

      const parent_id = parentRaw !== null && parentRaw !== undefined
        ? (Number(parentRaw) || null)
        : null;

      let path = [];

      if (Array.isArray(r.path)) {
        path = r.path.map(s => String(s ?? '').trim()).filter(Boolean);
      } else if (typeof r.path === 'string') {
        path = r.path
          .split(/\s*(?:>|\/|\u203A)\s*/g)
          .map(s => s.trim())
          .filter(Boolean);
      } else if (Array.isArray(r.path_parts)) {
        path = r.path_parts.map(s => String(s ?? '').trim()).filter(Boolean);
      }

      const codigo = r.codigo ?? r.code ?? r.sigla ?? null;
      const ativo = (r.ativo ?? r.active ?? true) ? true : false;
      const descricao = r.descricao ?? r.obs ?? r.descr ?? null;
      const nomeRaw = r.nome ?? r.name ?? r.titulo ?? r.label ?? (path[path.length - 1] || '');
      const nome = String(nomeRaw).trim();

      const hora_login_inicio_padrao =
        r.hora_login_inicio_padrao ??
        r.login_inicio_padrao ??
        null;

      const hora_login_fim_padrao =
        r.hora_login_fim_padrao ??
        r.login_fim_padrao ??
        null;

      return {
        id,
        parent_id,
        nome,
        path,
        codigo,
        ativo,
        descricao,
        hora_login_inicio_padrao,
        hora_login_fim_padrao,
        children: []
      };
    }).filter(x => Number.isFinite(x.id));
  }

  function labelOf(n){
    if (n && n.nome && String(n.nome).trim()) return String(n.nome).trim();

    if (n && Array.isArray(n.path) && n.path.length) {
      return String(n.path[n.path.length - 1]).trim();
    }

    return '(sem nome)';
  }

  async function loadTree(){
    Loader.show('Carregando...');

    try {
      let rows = null;

      try {
        rows = await apiGet('/api/atendimento/clientes/departamentos/tree');
      } catch {
        rows = await apiGet('/api/departamentos/tree');
      }

      state.flat = normalizeRows(rows);
      buildNested();
      fillParentSelect();

      if (state.view === 'table') renderTable();
      if (state.view === 'org') renderOrg();

    } finally {
      Loader.hide();
      releasePageLoader();
    }
  }

  async function loadEmpresaName(){
    if (!EMPRESA_ID) {
      state.companyName = null;
      return;
    }

    try {
      const emp = await apiGet(`/api/empresas/${EMPRESA_ID}`);
      state.companyName = String(emp?.nome || '').trim() || null;
    } catch {
      state.companyName = null;
    }
  }

  async function loadDeptoDetails(id){
    try {
      return await apiGet(`/api/atendimento/clientes/departamentos/${id}`);
    } catch {
      try {
        return await apiGet(`/api/departamentos/${id}`);
      } catch {
        return null;
      }
    }
  }

  function buildNested(){
    const byId = new Map();
    const roots = [];

    state.flat.forEach(d => {
      byId.set(d.id, { ...d, children: [] });
    });

    state.flat.forEach(d => {
      const node = byId.get(d.id);

      if (d.parent_id && byId.has(d.parent_id)) {
        byId.get(d.parent_id).children.push(node);
      } else {
        roots.push(node);
      }
    });

    const sortRec = n => {
      n.children.sort((a, b) => labelOf(a).localeCompare(labelOf(b), 'pt-BR'));
      n.children.forEach(sortRec);
    };

    roots.forEach(sortRec);
    state.nested = roots;
  }

  function fillParentSelect(){
    if (!selParent) return;

    const current = selParent.value || '';

    selParent.innerHTML = '<option value="">Empresa (raiz)</option>';

    const push = (n, level = 0) => {
      const opt = document.createElement('option');
      opt.value = String(n.id);
      opt.textContent = `${'— '.repeat(level)}${labelOf(n)}`;
      selParent.appendChild(opt);

      n.children.forEach(c => push(c, level + 1));
    };

    state.nested.forEach(n => push(n, 0));
    selParent.value = current;

    setParentButtonText();

    const parentPanel = $('#parent-panel');
    if (parentPanel && parentPanel.classList.contains('open')) {
      renderParentList();
    }
  }

  function hasMatchInSubtree(n, q){
    if (!q) return true;

    if (labelOf(n).toLowerCase().includes(q)) return true;

    return n.children.some(c => hasMatchInSubtree(c, q));
  }

  function renderTable(){
    if (!tbody || !empty) return;

    const q = (state.q || '').toLowerCase();

    tbody.innerHTML = '';

    let index = 0;
    const hasAny = state.nested.length > 0;

    empty.style.display = hasAny ? 'none' : 'flex';

    const drawNode = (n, level = 0) => {
      const label = labelOf(n);
      const include = !q || label.toLowerCase().includes(q) || hasMatchInSubtree(n, q);

      if (!include) return;

      const expanded = IS_MOBILE ? true : (state.expanded.has(n.id) || !!q);

      const tr = document.createElement('tr');
      tr.dataset.id = String(n.id);
      tr.draggable = true;

      tr.innerHTML = `
        <td>${++index}</td>

        <td>
          <div class="tree-node">
            <span class="indent" style="--level:${level}"></span>

            ${IS_MOBILE ? '' : `
              <button class="twisty ${n.children.length ? (expanded ? 'is-open' : '') : 'is-leaf'}"
                      aria-label="${expanded ? 'Recolher' : 'Expandir'}"
                      type="button">
                <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
              </button>
            `}

            <span class="label">${escapeHtml(label)}</span>
          </div>
        </td>

        <td><code>${Array.isArray(n.path) ? escapeHtml(n.path.join(' / ')) : ''}</code></td>
        <td>${escapeHtml(n.codigo || '')}</td>
        <td>${n.ativo ? '<i class="fa fa-check" aria-label="Ativo"></i>' : '<i class="fa fa-xmark" aria-label="Inativo"></i>'}</td>

        <td class="td-actions">
          <button class="btn" data-action="edit" data-id="${n.id}" title="Editar" type="button" aria-label="Editar">${SVGS.edit}</button>
          <button class="btn" data-action="add-child" data-id="${n.id}" title="Adicionar filho" type="button" aria-label="Adicionar filho">${SVGS.add}</button>
          <button class="btn" data-action="del" data-id="${n.id}" title="Remover" type="button" aria-label="Remover">${SVGS.trash}</button>
        </td>
      `.trim();

      tbody.appendChild(tr);

      if (!IS_MOBILE) {
        const twisty = tr.querySelector('.twisty');

        if (twisty && n.children.length) {
          twisty.addEventListener('click', () => {
            if (expanded) state.expanded.delete(n.id);
            else state.expanded.add(n.id);

            renderTable();
          });
        }
      }

      attachDragHandlers(tr);

      if (expanded) {
        n.children.forEach(c => drawNode(c, level + 1));
      }
    };

    state.nested.forEach(n => drawNode(n, 0));

    if (state.highlightId) {
      const tr = $(`#tb-deptos tr[data-id="${state.highlightId}"]`);

      if (tr) {
        tr.classList.add('flash-new');
        tr.scrollIntoView({ behavior: 'smooth', block: 'center' });

        setTimeout(() => tr.classList.remove('flash-new'), 1600);
      }

      state.highlightId = null;
    }
  }

  let draggingId = null;

  function attachDragHandlers(tr){
    tr.addEventListener('dragstart', e => {
      draggingId = Number(tr.dataset.id);
      tr.classList.add('dragging');
      e.dataTransfer.setData('text/plain', String(draggingId));
    });

    tr.addEventListener('dragend', () => {
      draggingId = null;
      tr.classList.remove('dragging');
      $$('.drop-target', tbody).forEach(el => el.classList.remove('drop-target'));
    });

    tr.addEventListener('dragover', e => {
      if (!draggingId) return;

      e.preventDefault();
      tr.classList.add('drop-target');
    });

    tr.addEventListener('dragleave', () => {
      tr.classList.remove('drop-target');
    });

    tr.addEventListener('drop', async e => {
      e.preventDefault();
      tr.classList.remove('drop-target');

      const targetId = Number(tr.dataset.id);

      if (!draggingId || draggingId === targetId) return;

      try {
        Loader.show('Movendo...');
        await patchMove(draggingId, targetId);

        toast('Movido.');
        state.expanded.add(targetId);

        await loadTree();
      } catch (err) {
        console.error(err);
        toast(err?.data?.detail || 'Falha ao mover.', 'err');
      } finally {
        Loader.hide();
      }
    });
  }

  async function patchMove(id, newParentId){
    const body = { new_parent_id: newParentId ?? null };

    try {
      await apiJSON(`/api/atendimento/clientes/departamentos/${id}`, 'PATCH', body);
      return;
    } catch {}

    try {
      await apiJSON(`/api/atendimento/clientes/departamentos/${id}/move`, 'PATCH', body);
      return;
    } catch {}

    await apiJSON(`/api/departamentos/${id}/move`, 'PATCH', body);
  }

  function renderOrg(){
    if (!orgContainer) return;

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

    const inner = document.createElement('div');
    inner.className = 'org-inner';

    const rootLi = document.createElement('li');

    const rootCard = buildNodeCard({
      id: 0,
      nome: state.companyName || 'Empresa',
      path: [],
      ativo: true,
      children: state.nested
    }, true);

    rootLi.appendChild(rootCard);

    const ulRoots = document.createElement('ul');
    rootLi.appendChild(ulRoots);

    const ulTop = document.createElement('ul');
    ulTop.className = 'org';
    ulTop.appendChild(rootLi);

    inner.appendChild(ulTop);
    stage.appendChild(inner);
    viewport.appendChild(stage);

    orgContainer.appendChild(viewport);
    orgContainer.appendChild(toolbar);

    const q = (state.q || '').toLowerCase();

    const draw = (n, parentUL) => {
      if (!hasMatchInSubtree(n, q)) return;

      const li = document.createElement('li');
      li.className = 'node-li';

      const card = buildNodeCard(n, false);

      if (!q || labelOf(n).toLowerCase().includes(q)) {
        card.classList.add('match');
      }

      li.appendChild(card);

      const expanded = state.expanded.has(n.id) || !!q || IS_MOBILE;

      if (n.children?.length) {
        const childUL = document.createElement('ul');

        if (expanded) {
          n.children.forEach(c => draw(c, childUL));
        }

        li.appendChild(childUL);
      }

      parentUL.appendChild(li);
    };

    state.nested.forEach(n => draw(n, ulRoots));

    setupSimplePanZoom(viewport, stage);

    toolbar.querySelector('.org-zoom-in')?.addEventListener('click', () => zoomStage(stage, viewport, 1.15));
    toolbar.querySelector('.org-zoom-out')?.addEventListener('click', () => zoomStage(stage, viewport, 1 / 1.15));
    toolbar.querySelector('.org-zoom-reset')?.addEventListener('click', () => resetStage(stage));
  }

  function buildNodeCard(n, isRoot){
    const card = document.createElement('div');
    card.className = 'node-card' + (isRoot ? ' is-root' : '');

    const head = document.createElement('div');
    head.className = 'node-head';

    const title = document.createElement('div');
    title.className = 'node-title';
    title.textContent = isRoot ? (state.companyName || 'Empresa') : labelOf(n);

    const twist = document.createElement('button');
    twist.type = 'button';
    twist.className = 'node-twisty' + (n.children?.length ? '' : ' is-leaf');

    twist.innerHTML = n.children?.length
      ? '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>'
      : '';

    twist.addEventListener('click', ev => {
      ev.stopPropagation();

      if (!n.children?.length) return;

      const expanded = state.expanded.has(n.id);

      if (expanded) state.expanded.delete(n.id);
      else state.expanded.add(n.id);

      renderOrg();
    });

    head.appendChild(title);
    head.appendChild(twist);

    const path = document.createElement('div');
    path.className = 'node-path';
    path.textContent = isRoot ? '' : (Array.isArray(n.path) ? n.path.join(' / ') : '');

    const actions = document.createElement('div');
    actions.className = 'node-actions';

    if (!isRoot) {
      actions.innerHTML = `
        <button class="btn" data-action="edit" data-id="${n.id}" title="Editar" type="button" aria-label="Editar">${SVGS.edit}</button>
        <button class="btn" data-action="add-child" data-id="${n.id}" title="Adicionar filho" type="button" aria-label="Adicionar filho">${SVGS.add}</button>
        <button class="btn" data-action="del" data-id="${n.id}" title="Remover" type="button" aria-label="Remover">${SVGS.trash}</button>
      `;
    }

    card.appendChild(head);

    if (!isRoot) {
      card.appendChild(path);
      card.appendChild(actions);
    }

    return card;
  }

  function resetStage(stage){
    state.zoom = 1;
    state.tx = 0;
    state.ty = 0;
    applyStageTransform(stage);
  }

  function zoomStage(stage, viewport, factor){
    state.zoom = Math.min(2.5, Math.max(0.5, (state.zoom || 1) * factor));
    applyStageTransform(stage, viewport);
  }

  function applyStageTransform(stage){
    stage.style.transform = `translate(${state.tx || 0}px, ${state.ty || 0}px) scale(${state.zoom || 1})`;
  }

  function setupSimplePanZoom(viewport, stage){
    state.zoom = state.zoom || 1;
    state.tx = state.tx || 0;
    state.ty = state.ty || 0;

    applyStageTransform(stage);

    let pan = false;
    let lx = 0;
    let ly = 0;

    viewport.addEventListener('pointerdown', e => {
      if (e.target.closest('button,a,input,select,textarea')) return;

      pan = true;
      lx = e.clientX;
      ly = e.clientY;

      viewport.setPointerCapture?.(e.pointerId);
      viewport.classList.add('is-panning');
    });

    viewport.addEventListener('pointermove', e => {
      if (!pan) return;

      const dx = e.clientX - lx;
      const dy = e.clientY - ly;

      lx = e.clientX;
      ly = e.clientY;

      state.tx = (state.tx || 0) + dx;
      state.ty = (state.ty || 0) + dy;

      applyStageTransform(stage);
    });

    const up = e => {
      pan = false;
      viewport.classList.remove('is-panning');

      try {
        viewport.releasePointerCapture?.(e.pointerId);
      } catch {}
    };

    viewport.addEventListener('pointerup', up);
    viewport.addEventListener('pointercancel', up);

    viewport.addEventListener('wheel', e => {
      e.preventDefault();

      const factor = Math.pow(1.0015, -e.deltaY);
      state.zoom = Math.min(2.5, Math.max(0.5, (state.zoom || 1) * factor));

      applyStageTransform(stage);
    }, { passive: false });
  }

  function showModal(){
    if (!modal) return;

    modal.style.display = 'grid';
    modal.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('modal-open');
    document.addEventListener('keydown', onEscClose);
  }

  function closeModal(){
    if (!modal) return;

    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    modal.classList.remove('is-new');

    document.documentElement.classList.remove('modal-open');
    document.removeEventListener('keydown', onEscClose);

    $('#nome-dropdown')?.classList.remove('open');
    toggleParentPanel(false);
  }

  function onEscClose(e){
    if (e.key === 'Escape') closeModal();
  }

  async function openModalNovo(parentId = null){
    state.editing = null;

    form?.reset();

    inpId.value = '';
    inpNome.value = '';
    inpCodigo.value = '';
    txtDesc.value = '';
    chkAtivo.checked = true;
    selParent.value = parentId ? String(parentId) : '';

    if (inpExpIniPadrao) inpExpIniPadrao.value = '';
    if (inpExpFimPadrao) inpExpFimPadrao.value = '';

    setParentButtonText();

    modalTit.textContent = 'Novo departamento';
    modal.classList.add('is-new');

    showModal();
    updatePathPreview();

    setTimeout(() => inpNome?.focus(), 50);
  }

  async function openModalEditar(item){
    state.editing = item;

    inpId.value = String(item.id);
    inpNome.value = item.nome || labelOf(item) || '';
    inpCodigo.value = item.codigo || '';
    txtDesc.value = item.descricao || '';
    chkAtivo.checked = !!item.ativo;
    selParent.value = item.parent_id ? String(item.parent_id) : '';

    setParentButtonText();

    modalTit.textContent = 'Editar departamento';
    modal.classList.remove('is-new');

    let hi = item?.hora_login_inicio_padrao ?? null;
    let hf = item?.hora_login_fim_padrao ?? null;

    if (!hi && !hf) {
      try {
        const det = await loadDeptoDetails(item.id);
        hi = det?.hora_login_inicio_padrao ?? det?.login_inicio_padrao ?? null;
        hf = det?.hora_login_fim_padrao ?? det?.login_fim_padrao ?? null;
      } catch {}
    }

    if (inpExpIniPadrao) inpExpIniPadrao.value = normTime(hi);
    if (inpExpFimPadrao) inpExpFimPadrao.value = normTime(hf);

    showModal();
    updatePathPreview();

    setTimeout(() => inpNome?.focus(), 50);
  }

  function updatePathPreview(){
    if (!pathPrevWrap || !pathPrevCode) return;

    const selText = selParent?.options[selParent.selectedIndex]?.textContent || 'Empresa (raiz)';
    const nome = (inpNome.value || '').trim() || 'Novo departamento';

    const parts = [];

    if (selText && !/empresa/i.test(selText)) {
      parts.push(selText.replace(/^—\s*/g, '').trim());
    }

    parts.push(nome);

    pathPrevCode.textContent = parts.join(' › ');
    pathPrevWrap.style.display = 'grid';
  }

  function getPayload(){
    const nome = (inpNome.value || '').trim();

    return {
      nome,
      descricao: (txtDesc.value || '').trim() || null,
      parent_id: selParent.value ? Number(selParent.value) : null,
      codigo: (inpCodigo.value || '').trim() || null,
      ativo: !!chkAtivo.checked,
      hora_login_inicio_padrao: inpExpIniPadrao?.value || null,
      hora_login_fim_padrao: inpExpFimPadrao?.value || null
    };
  }

  async function saveDepto(){
    const payload = getPayload();

    if (!payload.nome) {
      toast('Informe o nome do departamento.', 'warn');
      inpNome?.focus();
      return;
    }

    try {
      Loader.show('Salvando...');

      let saved = null;

      if (state.editing?.id) {
        try {
          saved = await apiJSON(`/api/atendimento/clientes/departamentos/${state.editing.id}`, 'PUT', payload);
        } catch {
          saved = await apiJSON(`/api/departamentos/${state.editing.id}`, 'PUT', payload);
        }

        toast('Departamento atualizado.');
        state.highlightId = state.editing.id;
      } else {
        try {
          saved = await apiJSON('/api/atendimento/clientes/departamentos', 'POST', payload);
        } catch {
          saved = await apiJSON('/api/departamentos', 'POST', payload);
        }

        toast('Departamento criado.');
        state.highlightId = saved?.id || null;
      }

      closeModal();
      await loadTree();

    } catch (e) {
      console.error(e);

      const msg = e?.data?.detail || e?.data?.message || e?.message || 'Erro ao salvar.';
      toast(msg, 'err');

    } finally {
      Loader.hide();
    }
  }

  async function deleteDepto(id){
    if (!confirm('Remover este departamento?')) return;

    try {
      Loader.show('Removendo...');

      try {
        await apiJSON(`/api/atendimento/clientes/departamentos/${id}`, 'DELETE', {});
      } catch {
        await apiJSON(`/api/departamentos/${id}`, 'DELETE', {});
      }

      toast('Departamento removido.');
      await loadTree();

    } catch (e) {
      console.error(e);
      toast(e?.data?.detail || 'Erro ao remover.', 'err');
    } finally {
      Loader.hide();
    }
  }

  function setParentButtonText(){
    const btn = $('#parent-btn');
    if (!btn || !selParent) return;

    const txt = selParent.options[selParent.selectedIndex]?.textContent || 'Empresa (raiz)';
    btn.textContent = txt;
  }

  function toggleParentPanel(force){
    const btn = $('#parent-btn');
    const panel = $('#parent-panel');

    if (!btn || !panel) return;

    const open = typeof force === 'boolean'
      ? force
      : !panel.classList.contains('open');

    panel.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));

    if (open) renderParentList();
  }

  function renderParentList(){
    const panel = $('#parent-panel');
    if (!panel || !selParent) return;

    panel.innerHTML = '';

    const addItem = (value, text, level = 0) => {
      const item = document.createElement('div');
      item.className = 'dd-item';
      item.style.setProperty('--i', String(panel.children.length));
      item.textContent = text;
      item.dataset.value = value == null ? '' : String(value);
      item.style.paddingLeft = `${0.75 + level * 1.1}rem`;

      if (String(selParent.value || '') === String(value || '')) {
        item.classList.add('selected');
      }

      item.addEventListener('click', () => {
        selParent.value = item.dataset.value;
        setParentButtonText();
        updatePathPreview();
        toggleParentPanel(false);
      });

      panel.appendChild(item);
    };

    addItem('', 'Empresa (raiz)', 0);

    const push = (n, level = 0) => {
      if (state.editing && Number(state.editing.id) === Number(n.id)) {
        return;
      }

      addItem(n.id, labelOf(n), level);
      n.children.forEach(c => push(c, level + 1));
    };

    state.nested.forEach(n => push(n, 0));
  }

  function initSuggestions(){
    const datalist = $('#departamento-sugestoes');
    const dropdown = $('#nome-dropdown');

    if (datalist) {
      datalist.innerHTML = SUGESTOES
        .map(s => `<option value="${escapeHtml(s)}"></option>`)
        .join('');
    }

    if (!dropdown || !inpNome) return;

    const render = () => {
      const q = (inpNome.value || '').trim().toLowerCase();

      const list = SUGESTOES
        .filter(s => !q || s.toLowerCase().includes(q))
        .slice(0, 12);

      dropdown.innerHTML = '';

      list.forEach((s, idx) => {
        const item = document.createElement('div');
        item.className = 'dd-item';
        item.style.setProperty('--i', String(idx));
        item.textContent = s;

        item.addEventListener('mousedown', e => {
          e.preventDefault();

          inpNome.value = s;
          dropdown.classList.remove('open');
          updatePathPreview();
        });

        dropdown.appendChild(item);
      });

      dropdown.classList.toggle('open', !!list.length && document.activeElement === inpNome);
    };

    inpNome.addEventListener('focus', render);
    inpNome.addEventListener('input', render);

    inpNome.addEventListener('blur', () => {
      setTimeout(() => dropdown.classList.remove('open'), 150);
    });
  }

  function setView(view){
    state.view = view === 'org' ? 'org' : 'table';

    if (sectionTable) sectionTable.style.display = state.view === 'table' ? '' : 'none';
    if (sectionOrg) sectionOrg.style.display = state.view === 'org' ? '' : 'none';

    if (btnViewTable) btnViewTable.setAttribute('aria-selected', String(state.view === 'table'));
    if (btnViewOrg) btnViewOrg.setAttribute('aria-selected', String(state.view === 'org'));

    btnViewTable?.classList.toggle('is-active', state.view === 'table');
    btnViewOrg?.classList.toggle('is-active', state.view === 'org');

    if (state.view === 'table') renderTable();
    if (state.view === 'org') renderOrg();
  }

  function bindActions(){
    document.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;

      const id = Number(btn.dataset.id);
      const item = state.flat.find(x => Number(x.id) === id);
      const action = btn.dataset.action;

      if (action === 'edit' && item) {
        openModalEditar(item);
      }

      if (action === 'add-child') {
        openModalNovo(id);
      }

      if (action === 'del') {
        deleteDepto(id);
      }
    });

    btnAdd?.addEventListener('click', () => openModalNovo());
    $('#btn-add-empty')?.addEventListener('click', () => openModalNovo());

    btnX?.addEventListener('click', closeModal);
    btnCanc?.addEventListener('click', closeModal);
    btnSalva?.addEventListener('click', saveDepto);

    modal?.addEventListener('mousedown', ev => {
      const card = modal.querySelector('.modal-card');
      if (card && !card.contains(ev.target)) closeModal();
    });

    modal?.querySelector('.modal-card')?.addEventListener('mousedown', ev => {
      ev.stopPropagation();
    });

    filtro?.addEventListener('input', debounce(() => {
      state.q = filtro.value.trim();

      if (state.view === 'table') renderTable();
      if (state.view === 'org') renderOrg();
    }, 180));

    btnExpand?.addEventListener('click', () => {
      state.flat.forEach(d => state.expanded.add(d.id));

      if (state.view === 'table') renderTable();
      if (state.view === 'org') renderOrg();
    });

    btnCollapse?.addEventListener('click', () => {
      state.expanded.clear();

      if (state.view === 'table') renderTable();
      if (state.view === 'org') renderOrg();
    });

    btnViewTable?.addEventListener('click', () => setView('table'));
    btnViewOrg?.addEventListener('click', () => setView('org'));

    inpNome?.addEventListener('input', updatePathPreview);
    selParent?.addEventListener('change', () => {
      setParentButtonText();
      updatePathPreview();
    });

    $('#parent-btn')?.addEventListener('click', () => toggleParentPanel());

    document.addEventListener('click', ev => {
      const wrap = $('#fi-parent');
      if (wrap && !wrap.contains(ev.target)) toggleParentPanel(false);
    });
  }

  function cacheEls(){
    filtro = $('#filtro');
    btnAdd = $('#btn-add');
    btnExpand = $('#btn-expand');
    btnCollapse = $('#btn-collapse');
    tbody = $('#tb-deptos');
    empty = $('#empty');

    modal = $('#modal-depto');
    modalTit = $('#modal-title');
    btnX = $('#modal-fechar');
    btnSalva = $('#modal-salvar');
    btnCanc = $('#modal-cancelar');
    form = $('#form-depto');

    inpId = $('[name="id"]', form);
    inpNome = $('#d-nome');
    selParent = $('#d-parent');
    inpCodigo = $('#d-codigo');
    chkAtivo = $('#d-ativo');
    txtDesc = $('#d-desc');
    toastEl = $('#toast');

    pathPrevWrap = $('#path-preview');
    pathPrevCode = $('#path-preview-code');

    btnViewTable = $('#btn-view-table');
    btnViewOrg = $('#btn-view-org');
    sectionTable = $('#section-table');
    sectionOrg = $('#section-org');
    orgContainer = $('#org-container');

    inpExpIniPadrao = $('#d-exp-ini');
    inpExpFimPadrao = $('#d-exp-fim');
  }

  async function boot(){
    cacheEls();
    bindActions();
    initSuggestions();

    if (IS_MOBILE) {
      setView('table');
    } else {
      setView('table');
    }

    await loadEmpresaName();
    await loadTree();

    releasePageLoader();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  setTimeout(releasePageLoader, 300);
  setTimeout(releasePageLoader, 1000);
  setTimeout(releasePageLoader, 2500);
})();