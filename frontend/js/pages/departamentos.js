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
    const upperMethod = String(method || 'GET').toUpperCase();

    const opt = {
      method: upperMethod,
      headers: {}
    };

    // DELETE no FastAPI não precisa de body.
    // Enviar {} em alguns proxies/backends gera erro estranho e dificulta debug.
    if (body !== undefined && body !== null && upperMethod !== 'DELETE') {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }

    const r = await authFetch(withEmpresaIdQuery(path), opt);
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
    view: 'org',
    companyName: null,
    didAutoExpand: false,
    orgTouched: false,
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

      if (!state.didAutoExpand) {
        state.flat.forEach(d => state.expanded.add(d.id));
        state.didAutoExpand = true;
      }

      fillParentSelect();

      renderOrg();

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

  function countDescendants(n){
    return (n?.children || []).reduce((total, child) => total + 1 + countDescendants(child), 0);
  }

  function initialsOf(text){
    const words = String(text || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);

    const initials = words.map(w => w[0]).join('').toUpperCase();
    return initials || 'ZC';
  }

  function renderOrg(){
    if (!orgContainer) return;

    orgContainer.innerHTML = '';

    const total = state.flat.length;
    const active = state.flat.filter(d => d.ativo !== false).length;
    const totalHero = document.getElementById('dept-total');
    if (totalHero) totalHero.textContent = String(total);
    const q = (state.q || '').toLowerCase();

    const topbar = document.createElement('div');
    topbar.className = 'org-topbar';
    topbar.innerHTML = `
      <div class="org-topbar-title">
        <span class="org-kicker"><i class="fa-solid fa-diagram-project"></i> Organograma</span>
        <strong>${escapeHtml(state.companyName || 'ZapsChat')}</strong>
      </div>
      <div class="org-stats" aria-label="Resumo dos departamentos">
        <span><b>${total}</b> departamentos</span>
        <span><b>${active}</b> ativos</span>
      </div>
    `;

    const toolbar = document.createElement('div');
    toolbar.className = 'org-toolbar';
    toolbar.innerHTML = `
      <button type="button" class="org-zoom-out" aria-label="Diminuir zoom" title="Diminuir">−</button>
      <button type="button" class="org-zoom-reset" aria-label="Centralizar organograma" title="Centralizar"><i class="fa-solid fa-location-crosshairs"></i></button>
      <button type="button" class="org-zoom-in" aria-label="Aumentar zoom" title="Aumentar">+</button>
    `;

    const viewport = document.createElement('div');
    viewport.className = 'org-viewport';

    const stage = document.createElement('div');
    stage.className = 'org-stage org-board';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('org-svg');
    svg.setAttribute('aria-hidden', 'true');

    const layer = document.createElement('div');
    layer.className = 'org-nodes-layer';

    const cloneVisible = n => {
      if (!hasMatchInSubtree(n, q)) return null;

      const isOpen = !!q || state.expanded.has(n.id) || IS_MOBILE;
      const children = isOpen
        ? (n.children || []).map(cloneVisible).filter(Boolean)
        : [];

      return {
        ...n,
        children,
        _allChildren: (n.children || []).length,
        _descendants: countDescendants(n),
        _collapsed: !!((n.children || []).length && !isOpen)
      };
    };

    const visibleRoots = (state.nested || []).map(cloneVisible).filter(Boolean);

    const root = {
      id: 0,
      nome: state.companyName || 'ZapsChat',
      descricao: 'Estrutura da empresa',
      codigo: 'ORG',
      ativo: true,
      path: [],
      children: visibleRoots,
      _root: true,
      _allChildren: visibleRoots.length,
      _descendants: total,
      _collapsed: false
    };

    const viewWForLayout = Math.max(
      360,
      Number(orgContainer.clientWidth || 0),
      Number(window.innerWidth || 0) - 34
    );

    const CARD_W = IS_MOBILE ? 246 : 292;
    const CARD_H = IS_MOBILE ? 126 : 132;
    const GAP_X = IS_MOBILE ? 16 : 28;
    const GAP_Y = IS_MOBILE ? 54 : 68;
    const ROW_GAP = IS_MOBILE ? 32 : 38;
    const PAD_X = IS_MOBILE ? 18 : 56;
    const PAD_Y = IS_MOBILE ? 18 : 26;
    const BUS_GAP = IS_MOBILE ? 18 : 24;

    const maxCols = (() => {
      const usable = Math.max(CARD_W, viewWForLayout - PAD_X * 2);
      const byWidth = Math.max(1, Math.floor((usable + GAP_X) / (CARD_W + GAP_X)));

      if (IS_MOBILE || viewWForLayout <= 560) return Math.min(1, byWidth);
      if (viewWForLayout <= 860) return Math.min(2, byWidth);
      if (viewWForLayout <= 1220) return Math.min(3, byWidth);
      return Math.min(4, byWidth);
    })();

    const measure = node => {
      if (!node.children?.length) {
        node._subW = CARD_W;
        node._subH = CARD_H;
        return node._subW;
      }

      const childrenW = node.children.reduce((sum, child, index) => (
        sum + measure(child) + (index ? GAP_X : 0)
      ), 0);

      const maxChildH = Math.max(...node.children.map(child => child._subH || CARD_H), CARD_H);
      node._subW = Math.max(CARD_W, childrenW);
      node._subH = CARD_H + GAP_Y + maxChildH;
      return node._subW;
    };

    const placeSubtree = (node, left, top, depth) => {
      node._x = left + (node._subW / 2) - (CARD_W / 2);
      node._y = top;
      node._depth = depth;

      if (!node.children?.length) return;

      const childrenW = node.children.reduce((sum, child, index) => (
        sum + child._subW + (index ? GAP_X : 0)
      ), 0);

      let cursor = left + (node._subW - childrenW) / 2;

      node.children.forEach((child, index) => {
        if (index) cursor += GAP_X;
        placeSubtree(child, cursor, top + CARD_H + GAP_Y, depth + 1);
        cursor += child._subW;
      });
    };

    root.children.forEach(measure);

    const packRows = children => {
      const usable = Math.max(CARD_W, viewWForLayout - PAD_X * 2);
      const rows = [];
      let row = [];
      let rowW = 0;

      children.forEach(child => {
        const itemW = Math.max(CARD_W, child._subW || CARD_W);
        const nextW = rowW + (row.length ? GAP_X : 0) + itemW;
        const shouldBreak = row.length && (
          row.length >= maxCols ||
          (nextW > usable && row.length >= Math.min(maxCols, 2))
        );

        if (shouldBreak) {
          rows.push({ items: row, width: rowW, height: Math.max(...row.map(x => x._subH || CARD_H), CARD_H) });
          row = [];
          rowW = 0;
        }

        rowW += (row.length ? GAP_X : 0) + itemW;
        row.push(child);
      });

      if (row.length) {
        rows.push({ items: row, width: rowW, height: Math.max(...row.map(x => x._subH || CARD_H), CARD_H) });
      }

      return rows;
    };

    const rootRows = packRows(root.children || []);
    const widestRow = rootRows.reduce((max, row) => Math.max(max, row.width), CARD_W);
    const boardWTarget = Math.max(CARD_W + PAD_X * 2, widestRow + PAD_X * 2, viewWForLayout);
    let boardW = Math.ceil(boardWTarget);

    root._subW = CARD_W;
    root._subH = CARD_H;
    root._x = Math.round((boardW - CARD_W) / 2);
    root._y = PAD_Y;
    root._depth = 0;

    let rowTop = root._y + CARD_H + GAP_Y;
    const rowMeta = [];

    rootRows.forEach((row, rowIndex) => {
      let cursor = Math.round((boardW - row.width) / 2);
      row.top = rowTop;
      row.busY = rowTop - BUS_GAP;
      row.centers = [];

      row.items.forEach((child, index) => {
        if (index) cursor += GAP_X;

        child._rootRow = rowIndex;
        placeSubtree(child, cursor, rowTop, 1);
        row.centers.push(child._x + CARD_W / 2);

        cursor += Math.max(CARD_W, child._subW || CARD_W);
      });

      rowMeta.push(row);
      rowTop += row.height + ROW_GAP;
    });

    const allNodes = [];
    const links = [];
    const rootLinks = [];

    const collect = (node, parent = null) => {
      allNodes.push(node);

      if (parent) {
        if (parent._root) rootLinks.push({ parent, child: node });
        else links.push({ parent, child: node });
      }

      node.children?.forEach(child => collect(child, node));
    };

    collect(root);
    const maxRight = Math.max(...allNodes.map(n => n._x + CARD_W), CARD_W) + PAD_X;
    const maxBottom = Math.max(...allNodes.map(n => n._y + CARD_H), CARD_H) + PAD_Y;
    boardW = Math.ceil(Math.max(maxRight, boardW));
    const boardH = Math.ceil(Math.max(maxBottom, 420));

    stage.style.width = `${boardW}px`;
    stage.style.height = `${boardH}px`;
    stage.dataset.boardW = String(boardW);
    stage.dataset.boardH = String(boardH);

    svg.setAttribute('width', String(boardW));
    svg.setAttribute('height', String(boardH));
    svg.setAttribute('viewBox', `0 0 ${boardW} ${boardH}`);

    const makePath = d => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'org-link');
      svg.appendChild(path);
      return path;
    };

    const makeDot = (x, y, r = 4.5) => {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(y));
      dot.setAttribute('r', String(r));
      dot.setAttribute('class', 'org-link-dot');
      svg.appendChild(dot);
      return dot;
    };

    if (rootLinks.length && rowMeta.length) {
      const rootX = root._x + CARD_W / 2;
      const rootY = root._y + CARD_H;

      rowMeta.forEach(row => {
        const centers = row.items.map(child => child._x + CARD_W / 2);
        if (!centers.length) return;

        const minX = Math.min(...centers);
        const maxX = Math.max(...centers);
        const busY = row.busY;
        const rootKneeY = Math.min(busY, rootY + 22);

        makePath(`M ${rootX} ${rootY} C ${rootX} ${rootKneeY}, ${rootX} ${busY}, ${rootX} ${busY}`);

        if (Math.abs(maxX - minX) > 1) {
          makePath(`M ${minX} ${busY} L ${maxX} ${busY}`);
        }

        row.items.forEach(child => {
          const cX = child._x + CARD_W / 2;
          const cY = child._y;
          makePath(`M ${cX} ${busY} C ${cX} ${busY + 10}, ${cX} ${cY - 10}, ${cX} ${cY}`);
          makeDot(cX, cY);
        });
      });
    }

    links.forEach(({ parent, child }) => {
      const pX = parent._x + CARD_W / 2;
      const pY = parent._y + CARD_H;
      const cX = child._x + CARD_W / 2;
      const cY = child._y;
      const midY = pY + Math.max(24, (cY - pY) * .45);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${pX} ${pY} C ${pX} ${midY}, ${cX} ${midY}, ${cX} ${cY}`);
      path.setAttribute('class', 'org-link');
      svg.appendChild(path);

      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', String(cX));
      dot.setAttribute('cy', String(cY));
      dot.setAttribute('r', '4.5');
      dot.setAttribute('class', 'org-link-dot');
      svg.appendChild(dot);
    });

    allNodes.forEach((node, index) => {
      const wrap = document.createElement('div');
      wrap.className = 'org-card-wrap';
      wrap.style.setProperty('--node-delay', `${Math.min(index * 38, 380)}ms`);
      wrap.style.left = `${node._x}px`;
      wrap.style.top = `${node._y}px`;
      wrap.style.width = `${CARD_W}px`;
      wrap.style.height = `${CARD_H}px`;

      const card = buildNodeCard(node, !!node._root);

      if (!q || labelOf(node).toLowerCase().includes(q) || node._root) {
        if (q && !node._root && labelOf(node).toLowerCase().includes(q)) {
          card.classList.add('match');
        }
      }

      wrap.appendChild(card);
      layer.appendChild(wrap);
    });

    if (!total) {
      const emptyHint = document.createElement('div');
      emptyHint.className = 'org-empty-hint';
      emptyHint.innerHTML = `
        <i class="fa-regular fa-folder-open"></i>
        <strong>Nenhum departamento criado ainda.</strong>
        <span>Clique em <b>Novo</b> para começar a montar a estrutura.</span>
      `;
      layer.appendChild(emptyHint);
    }

    svg.querySelectorAll('.org-link').forEach((el, index) => {
      el.setAttribute('pathLength', '1');
      el.style.setProperty('--line-delay', `${Math.min(index * 28, 360)}ms`);
    });

    svg.querySelectorAll('.org-link-dot').forEach((el, index) => {
      el.style.setProperty('--dot-delay', `${Math.min(160 + index * 22, 460)}ms`);
    });

    stage.appendChild(svg);
    stage.appendChild(layer);
    viewport.appendChild(stage);

    orgContainer.appendChild(topbar);
    orgContainer.appendChild(viewport);
    orgContainer.appendChild(toolbar);

    setupSimplePanZoom(viewport, stage);

    if (!state.orgTouched) {
      resetStage(stage, viewport);
    } else {
      applyStageTransform(stage);
    }

    toolbar.querySelector('.org-zoom-in')?.addEventListener('click', () => zoomStage(stage, viewport, 1.15));
    toolbar.querySelector('.org-zoom-out')?.addEventListener('click', () => zoomStage(stage, viewport, 1 / 1.15));
    toolbar.querySelector('.org-zoom-reset')?.addEventListener('click', () => resetStage(stage, viewport));
  }

  function buildNodeCard(n, isRoot){
    const card = document.createElement('div');
    const tone = Math.abs(Number(n.id || 0)) % 6;

    card.className = `node-card org-node-card tone-${tone}` + (isRoot ? ' is-root' : '') + (n.ativo === false ? ' is-inactive' : '');
    card.dataset.id = String(n.id || 0);

    const label = isRoot ? (state.companyName || 'ZapsChat') : labelOf(n);
    const childTotal = isRoot ? state.flat.length : Number(n._descendants || 0);
    const directChildren = Number(n._allChildren || 0);
    const code = isRoot ? 'Empresa' : (n.codigo || 'Setor');
    const description = isRoot
      ? 'Estrutura organizacional'
      : (n.descricao || (Array.isArray(n.path) && n.path.length ? n.path.join(' / ') : 'Departamento do atendimento'));

    const head = document.createElement('div');
    head.className = 'org-card-head';

    const avatar = document.createElement('div');
    avatar.className = 'org-avatar';
    avatar.innerHTML = isRoot
      ? '<i class="fa-solid fa-building"></i>'
      : `<span>${escapeHtml(initialsOf(label))}</span>`;

    const text = document.createElement('div');
    text.className = 'org-card-text';
    text.innerHTML = `
      <div class="node-title" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
      <div class="node-path" title="${escapeHtml(description)}">${escapeHtml(description)}</div>
    `;

    const twist = document.createElement('button');
    twist.type = 'button';
    twist.className = 'node-twisty' + (directChildren ? '' : ' is-leaf') + ((directChildren && !n._collapsed) ? ' is-open' : '');
    twist.title = n._collapsed ? 'Expandir' : 'Recolher';
    twist.setAttribute('aria-label', twist.title);
    twist.innerHTML = directChildren
      ? '<i class="fa-solid fa-chevron-down" aria-hidden="true"></i>'
      : '<i class="fa-solid fa-circle" aria-hidden="true"></i>';

    twist.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!directChildren || isRoot) return;

      const expanded = state.expanded.has(n.id);
      if (expanded) state.expanded.delete(n.id);
      else state.expanded.add(n.id);

      renderOrg();
    });

    head.appendChild(avatar);
    head.appendChild(text);
    head.appendChild(twist);
    card.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'org-card-meta';

    const metaParts = [
      isRoot
        ? `<span><i class="fa-solid fa-building"></i>${escapeHtml(code)}</span>`
        : `<span><i class="fa-solid fa-tag"></i>${escapeHtml(code)}</span>`
    ];

    if (isRoot || directChildren > 0) {
      metaParts.push(`<span><i class="fa-solid fa-sitemap"></i>${directChildren} direto${directChildren === 1 ? '' : 's'}</span>`);
    }

    if (isRoot || childTotal > directChildren) {
      metaParts.push(`<span><i class="fa-solid fa-layer-group"></i>${childTotal} total</span>`);
    }

    meta.innerHTML = metaParts.join('');
    card.appendChild(meta);

    if (!isRoot) {
      const actions = document.createElement('div');
      actions.className = 'node-actions org-card-actions';
      actions.innerHTML = `
        <button class="btn" data-action="edit" data-id="${n.id}" title="Editar" type="button" aria-label="Editar">${SVGS.edit}</button>
        <button class="btn" data-action="add-child" data-id="${n.id}" title="Adicionar abaixo" type="button" aria-label="Adicionar abaixo">${SVGS.add}</button>
        <button class="btn" data-action="del" data-id="${n.id}" title="Remover" type="button" aria-label="Remover">${SVGS.trash}</button>
      `;
      card.appendChild(actions);

      card.addEventListener('dblclick', () => {
        const item = state.flat.find(x => Number(x.id) === Number(n.id));
        if (item) openModalEditar(item);
      });
    }

    return card;
  }

  function clampNumber(value, min, max){
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function resetStage(stage, viewport){
    const boardW = Number(stage?.dataset?.boardW || 0);
    const boardH = Number(stage?.dataset?.boardH || 0);
    const viewW = Number(viewport?.clientWidth || 0);
    const viewH = Number(viewport?.clientHeight || 0);

    const pad = IS_MOBILE ? 16 : 28;
    const fitX = boardW > 0 && viewW > 0 ? (viewW - pad * 2) / boardW : 1;
    const fitY = boardH > 0 && viewH > 0 ? (viewH - pad * 2) / boardH : 1;

    // V5: primeiro ele quebra em linhas. O zoom só ajusta levemente,
    // para não deixar os cards minúsculos como na versão anterior.
    const minZoom = IS_MOBILE ? 0.64 : 0.76;
    const nextZoom = clampNumber(Math.min(1, fitX, fitY), minZoom, 1);

    state.zoom = nextZoom;
    state.tx = Math.round((viewW - boardW * nextZoom) / 2);
    state.ty = Math.round(Math.max(pad, (viewH - boardH * nextZoom) / 2));
    state.orgTouched = false;

    applyStageTransform(stage);
  }

  function zoomAt(stage, viewport, nextZoom, anchorX, anchorY){
    const oldZoom = state.zoom || 1;
    const oldTx = state.tx || 0;
    const oldTy = state.ty || 0;

    const safeZoom = clampNumber(nextZoom, IS_MOBILE ? 0.62 : 0.72, 2.5);
    const ax = Number.isFinite(anchorX) ? anchorX : (Number(viewport?.clientWidth || 0) / 2);
    const ay = Number.isFinite(anchorY) ? anchorY : (Number(viewport?.clientHeight || 0) / 2);

    state.zoom = safeZoom;
    state.tx = ax - ((ax - oldTx) / oldZoom) * safeZoom;
    state.ty = ay - ((ay - oldTy) / oldZoom) * safeZoom;
    state.orgTouched = true;

    applyStageTransform(stage);
  }

  function zoomStage(stage, viewport, factor){
    zoomAt(stage, viewport, (state.zoom || 1) * factor);
  }

  function applyStageTransform(stage){
    stage.style.transform = `translate3d(${state.tx || 0}px, ${state.ty || 0}px, 0) scale(${state.zoom || 1})`;
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

      state.orgTouched = true;
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

      const rect = viewport.getBoundingClientRect();
      const factor = Math.pow(1.0015, -e.deltaY);
      zoomAt(
        stage,
        viewport,
        (state.zoom || 1) * factor,
        e.clientX - rect.left,
        e.clientY - rect.top
      );
    }, { passive: false });
  }

  function showModal(){
    if (!modal) return;

    modal.style.display = 'grid';
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('modal-open');
    document.addEventListener('keydown', onEscClose);
  }

  function closeModal(){
    if (!modal) return;

    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    modal.classList.remove('open');
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
    if (!id) {
      toast('Departamento inválido para remover.', 'err');
      return;
    }

    if (!confirm('Remover este departamento? Os filhos sobem um nível e os vínculos antigos ficam sem departamento.')) return;

    try {
      Loader.show('Removendo...');

      let lastError = null;
      let removed = false;

      const urls = [
        `/api/atendimento/clientes/departamentos/${id}`,
        `/api/departamentos/${id}`
      ];

      for (const url of urls) {
        try {
          await apiJSON(url, 'DELETE');
          removed = true;
          lastError = null;
          break;
        } catch (err) {
          lastError = err;

          // Só tenta a rota compatível se a rota oficial realmente não existir.
          // Se deu 400/403/409/500, é erro real do backend e não adianta duplicar chamada.
          if (![404, 405].includes(Number(err?.status || 0))) {
            break;
          }
        }
      }

      if (!removed) throw lastError || new Error('Erro ao remover.');

      toast('Departamento removido.');
      await loadTree();

    } catch (e) {
      console.error(e);
      const msg = e?.data?.detail || e?.data?.message || e?.message || 'Erro ao remover.';
      toast(msg, 'err');
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
    // Versão visual: a tela de Departamentos agora usa somente o organograma.
    // A tabela antiga foi removida da interface para ficar igual às referências.
    state.view = 'org';

    if (sectionTable) sectionTable.style.display = 'none';
    if (sectionOrg) sectionOrg.style.display = '';

    if (btnViewTable) btnViewTable.setAttribute('aria-selected', 'false');
    if (btnViewOrg) btnViewOrg.setAttribute('aria-selected', 'true');

    btnViewTable?.classList.remove('is-active');
    btnViewOrg?.classList.add('is-active');

    renderOrg();
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
      state.orgTouched = false;

      renderOrg();
    }, 180));

    btnExpand?.addEventListener('click', () => {
      state.flat.forEach(d => state.expanded.add(d.id));
      state.orgTouched = false;

      renderOrg();
    });

    btnCollapse?.addEventListener('click', () => {
      state.expanded.clear();
      state.orgTouched = false;

      renderOrg();
    });

    btnViewTable?.addEventListener('click', () => setView('table'));
    btnViewOrg?.addEventListener('click', () => setView('org'));

    window.addEventListener('resize', debounce(() => {
      if (state.view !== 'org') return;
      state.orgTouched = false;
      renderOrg();
    }, 160), { passive: true });

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
      setView('org');
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