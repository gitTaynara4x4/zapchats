// /frontend/js/pages/departamentos.js
// Departamentos - organograma profissional e isolado desta tela.
(function DepartamentosPage(){
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const EMPRESA_ID = Number(localStorage.getItem('empresa_id') || '') || null;
  const IS_COARSE = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
  const IS_MOBILE = IS_COARSE || window.innerWidth <= 920;
  const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  const state = {
    flat: [],
    nested: [],
    companyName: null,
    q: '',
    expanded: new Set(),
    selectedId: 0,
    selectedMembers: [],
    membrosSelecionados: new Set(),
    colaboradores: [],
    membrosLoaded: false,
    membrosLoading: false,
    instancias: [],
    instanciasLoaded: false,
    instanciasLoading: false,
    instanciasSelecionadas: new Set(),
    editing: null,
    modalStep: 1,
    modalMode: 'members',
    zoom: 1,
    tx: 0,
    ty: 0,
    orgTouched: false,
    openMenuId: null,
    sideMenuOpen: false,
    stage: null,
    didAutoExpand: false
  };

  function companyLabel(){
    return String(state.companyName || '').trim() || 'Empresa';
  }

  const Loader = {
    show(t){
      if (window.PageLoading?.show) PageLoading.show(t, { scope: '.departments-page' });
      else if (window.Loading?.show) Loading.show(t);
      else if (window.wait) wait(t);
    },
    hide(){
      if (window.PageLoading?.hide) PageLoading.hide();
      else if (window.Loading?.hide) Loading.hide();
      else if (window.ready) ready();
    }
  };

  let filtro, btnAdd, btnExpand, btnCollapse, orgContainer, sidePanel;
  let zoomOut, zoomIn, zoomReset, zoomLabel;
  let modal, modalTitle, modalStepLabel, modalProgress, btnX, btnBack, btnNext, btnSave, btnCancel, form;
  let modalHelpToggle, modalHelpPopover, modalHelpPopoverContent;
  let inpId, inpNome, txtDesc, inpCodigo, chkAtivo, selParent, inpHoraInicio, inpHoraFim, chkUsarHorarioGeral;
  let parentChip, parentEdit, parentPanel;
  let membrosSearch, membrosList, membrosCount, membrosAll, membrosClear, membrosToggle, membrosPanel, membrosSummary;
  let instanciasList, instanciasCount, instanciasAll, instanciasClear;
  let toastEl;

  function releasePageLoader(){
    try { window.ready?.(); } catch {}
    try { window.Page?.ready?.(); } catch {}
    try {
      document.documentElement.classList.remove('prepaint');
      document.documentElement.setAttribute('data-head-ready', '1');
      document.documentElement.setAttribute('data-loader-ready', '1');
    } catch {}
  }

  function debounce(fn, ms = 160){
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function escapeHtml(s){
    return String(s ?? '').replace(/[&<>"']/g, m => (
      m === '&' ? '&amp;' :
      m === '<' ? '&lt;' :
      m === '>' ? '&gt;' :
      m === '"' ? '&quot;' : '&#39;'
    ));
  }

  function toast(msg, type = 'ok'){
    if (!toastEl) return;
    toastEl.textContent = String(msg || '');
    toastEl.style.display = 'block';
    toastEl.style.background = type === 'err' ? '#7f1d1d' : type === 'warn' ? '#78350f' : '#065f46';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toastEl.style.display = 'none'; }, 2800);
  }

  function authFetch(url, opt = {}){
    const F = window.ZAuth?.guardFetch || window.ZAuth?.authFetch || fetch;
    const headers = Object.assign(
      { Accept: 'application/json' },
      opt.headers || {},
      EMPRESA_ID ? { 'X-Empresa-Id': String(EMPRESA_ID) } : {}
    );
    return F(url, { credentials: 'include', ...opt, headers });
  }

  function withEmpresaIdQuery(path){
    try {
      const u = new URL(path, location.origin);
      if (EMPRESA_ID && !u.searchParams.has('empresa_id')) u.searchParams.set('empresa_id', String(EMPRESA_ID));
      return u.toString();
    } catch {
      const sep = path.includes('?') ? '&' : '?';
      return EMPRESA_ID && !/(\?|&)empresa_id=/.test(path) ? path + sep + 'empresa_id=' + EMPRESA_ID : path;
    }
  }

  async function parseMaybeJSON(res){
    const txt = await res.text().catch(() => '');
    try { return txt ? JSON.parse(txt) : null; }
    catch { return txt || null; }
  }

  function throwHTTP(res, data){
    const err = new Error((data && (data.detail || data.message || data.error)) || res.statusText || 'Erro');
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
    const opt = { method: upperMethod, headers: {} };
    if (body !== undefined && body !== null && upperMethod !== 'DELETE') {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await authFetch(withEmpresaIdQuery(path), opt);
    const data = await parseMaybeJSON(r);
    if (!r.ok) throwHTTP(r, data);
    return data;
  }

  function normTime(val){
    const s = String(val ?? '').trim();
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return '';
    const hhmm = `${String(m[1]).padStart(2, '0')}:${m[2]}`;
    return HORA_RE.test(hhmm) ? hhmm : '';
  }

  function hasInvalidTime(input){
    if (!input) return false;
    const raw = String(input.value ?? '').trim();
    return !!raw && !normTime(raw);
  }

  function hasHorarioPersonalizado(){
    return !!(normTime(inpHoraInicio?.value) || normTime(inpHoraFim?.value));
  }

  function syncDisponibilidadeUi(){
    const usaGeral = chkUsarHorarioGeral ? !!chkUsarHorarioGeral.checked : !hasHorarioPersonalizado();
    if (chkUsarHorarioGeral) chkUsarHorarioGeral.checked = usaGeral;
    [inpHoraInicio, inpHoraFim].forEach(input => {
      if (!input) return;
      input.disabled = usaGeral;
      input.closest('.time-mini-field')?.classList.toggle('is-disabled', usaGeral);
    });
    modal?.querySelector('.availability-custom')?.classList.toggle('is-disabled', usaGeral);
    modal?.querySelector('.availability-card-main')?.classList.toggle('is-active', usaGeral);
  }

  function setDisponibilidadeFromCurrentValues(){
    if (chkUsarHorarioGeral) chkUsarHorarioGeral.checked = !hasHorarioPersonalizado();
    syncDisponibilidadeUi();
  }

  function normalizeRows(rows){
    const arr = Array.isArray(rows) ? rows : [];
    return arr.map(r => {
      const id = Number(r.id ?? r.dep_id ?? r.depto_id ?? r.ID);
      const parentRaw = r.parent_id ?? r.parentId ?? r.pai_id ?? r.parent ?? null;
      const parent_id = parentRaw !== null && parentRaw !== undefined ? (Number(parentRaw) || null) : null;

      let path = [];
      if (Array.isArray(r.path)) path = r.path.map(x => String(x ?? '').trim()).filter(Boolean);
      else if (typeof r.path === 'string') path = r.path.split(/\s*(?:>|\/|›)\s*/g).map(x => x.trim()).filter(Boolean);
      else if (Array.isArray(r.path_parts)) path = r.path_parts.map(x => String(x ?? '').trim()).filter(Boolean);

      return {
        id,
        parent_id,
        nome: String(r.nome ?? r.name ?? r.titulo ?? r.label ?? path[path.length - 1] ?? '').trim(),
        path,
        codigo: r.codigo ?? r.code ?? r.sigla ?? null,
        ativo: (r.ativo ?? r.active ?? true) ? true : false,
        descricao: r.descricao ?? r.obs ?? r.descr ?? null,
        hora_login_inicio_padrao: r.hora_login_inicio_padrao ?? r.login_inicio_padrao ?? null,
        hora_login_fim_padrao: r.hora_login_fim_padrao ?? r.login_fim_padrao ?? null,
        colaboradores_count: Number(r.colaboradores_count ?? r.total_colaboradores ?? r.colaboradores_total ?? r.membros_count ?? 0) || 0,
        children: []
      };
    }).filter(x => Number.isFinite(x.id) && x.id > 0);
  }

  function normalizeColaboradores(data){
    const arr = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : [];
    const out = [];
    const seen = new Set();
    arr.forEach(item => {
      const id = Number(item?.id ?? item?.colaborador_id ?? item?.usuario_id ?? item?.value);
      if (!Number.isFinite(id) || id <= 0 || seen.has(id)) return;
      seen.add(id);
      const nome = String(item?.nome ?? item?.name ?? item?.label ?? item?.email ?? `Colaborador ${id}`).trim();
      out.push({
        id,
        nome,
        email: item?.email ?? null,
        telefone: item?.telefone ?? null,
        cargo: item?.cargo ?? item?.role ?? item?.funcao ?? null,
        avatar_url: item?.avatar_url ?? item?.avatar ?? item?.foto_url ?? null,
        departamentos_ids: item?.departamentos_ids ?? item?.departamento_ids ?? []
      });
    });
    out.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    return out;
  }


  function normalizeInstancias(data){
    const raw = Array.isArray(data)
      ? data
      : Array.isArray(data?.instancias)
        ? data.instancias
        : Array.isArray(data?.items)
          ? data.items
          : [];

    const seen = new Set();
    return raw.map(item => {
      const id = Number(item?.id ?? item?.instancia_id ?? item?.value);
      if (!Number.isFinite(id) || id <= 0 || seen.has(id)) return null;
      seen.add(id);
      const nome = String(item?.apelido || item?.instance_name || item?.nome || item?.label || `Instância ${id}`).trim();
      const numero = String(item?.numero_instancia || item?.numero || item?.phone || '').trim();
      const connected = item?.connected === true || item?.conectada === true || item?.status === 'connected';
      return { id, nome, numero, connected };
    }).filter(Boolean).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  function labelOf(n){
    if (n?.nome && String(n.nome).trim()) return String(n.nome).trim();
    if (Array.isArray(n?.path) && n.path.length) return String(n.path[n.path.length - 1]).trim();
    return '(sem nome)';
  }

  function initialsOf(text){
    const words = String(text || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return words.map(w => w[0]).join('').toUpperCase() || 'AA';
  }

  function shortCode(n){
    const code = String(n?.codigo || '').trim();
    if (code) return code.slice(0, 3).toUpperCase();
    const name = labelOf(n);
    const m = name.match(/^\s*(\d{1,2})/);
    if (m) return m[1].padStart(2, '0');
    return initialsOf(name).slice(0, 2);
  }

  function buildNested(){
    const map = new Map();
    state.flat.forEach(d => map.set(Number(d.id), { ...d, children: [] }));
    const roots = [];
    map.forEach(n => {
      const p = n.parent_id ? map.get(Number(n.parent_id)) : null;
      if (p && p.id !== n.id) p.children.push(n);
      else roots.push(n);
    });
    const sort = arr => {
      arr.sort((a, b) => labelOf(a).localeCompare(labelOf(b), 'pt-BR', { numeric: true }));
      arr.forEach(x => sort(x.children || []));
    };
    sort(roots);
    state.nested = roots;
  }

  function findDept(id){
    id = Number(id);
    return state.flat.find(x => Number(x.id) === id) || null;
  }

  async function loadEmpresaName(){
    if (!EMPRESA_ID) { state.companyName = null; return; }
    try {
      const emp = await apiGet(`/api/empresas/${EMPRESA_ID}`);
      state.companyName = String(emp?.nome || emp?.name || '').trim() || null;
    } catch {
      state.companyName = null;
    }
  }

  async function loadTree(){
    Loader.show('Carregando departamentos...');
    try {
      let rows = null;
      try { rows = await apiGet('/api/atendimento/clientes/departamentos/tree'); }
      catch { rows = await apiGet('/api/departamentos/tree'); }

      state.flat = normalizeRows(rows);
      buildNested();

      if (!state.didAutoExpand) {
        state.flat.forEach(d => state.expanded.add(Number(d.id)));
        state.didAutoExpand = true;
      }

      if (state.selectedId && state.selectedId !== 0 && !findDept(state.selectedId)) state.selectedId = 0;
      fillParentSelect();
      renderAll();
      if (state.selectedId) await loadSelectedMembers();
      else renderSidePanel(false);
    } finally {
      Loader.hide();
      releasePageLoader();
    }
  }

  async function loadColaboradores(force = false){
    if (!force && state.membrosLoaded) return state.colaboradores;
    state.membrosLoading = true;
    try {
      let data = null;
      try { data = await apiGet('/api/atendimento/clientes/departamentos/colaboradores'); }
      catch { data = await apiGet('/api/departamentos/colaboradores'); }
      state.colaboradores = normalizeColaboradores(data);
      state.membrosLoaded = true;
      return state.colaboradores;
    } catch (err) {
      console.warn('[departamentos] falha ao carregar colaboradores', err);
      state.colaboradores = [];
      state.membrosLoaded = true;
      return [];
    } finally {
      state.membrosLoading = false;
    }
  }


  async function loadInstancias(force = false){
    if (!EMPRESA_ID) {
      state.instancias = [];
      state.instanciasLoaded = true;
      return [];
    }
    if (!force && state.instanciasLoaded) return state.instancias;
    state.instanciasLoading = true;
    try {
      let data = null;
      try { data = await apiGet(`/api/empresas/${EMPRESA_ID}/whatsapp`); }
      catch {
        try { data = await apiGet('/api/instancias/list'); }
        catch { data = { instancias: [] }; }
      }
      state.instancias = normalizeInstancias(data);
      state.instanciasLoaded = true;
      return state.instancias;
    } catch (err) {
      console.warn('[departamentos] falha ao carregar instâncias', err);
      state.instancias = [];
      state.instanciasLoaded = true;
      return [];
    } finally {
      state.instanciasLoading = false;
    }
  }

  async function loadDeptoDetails(id){
    try { return await apiGet(`/api/atendimento/clientes/departamentos/${id}`); }
    catch {
      try { return await apiGet(`/api/departamentos/${id}`); }
      catch { return null; }
    }
  }

  async function loadDepartamentoMembros(id){
    if (!id) return [];
    try { return await apiGet(`/api/atendimento/clientes/departamentos/${id}/membros`); }
    catch {
      try { return await apiGet(`/api/departamentos/${id}/membros`); }
      catch { return []; }
    }
  }

  async function saveDepartamentoMembros(id, colaboradoresIds){
    if (!id) return [];
    const body = { colaboradores_ids: (colaboradoresIds || []).map(Number).filter(n => Number.isFinite(n) && n > 0) };
    try { return await apiJSON(`/api/atendimento/clientes/departamentos/${id}/membros`, 'PUT', body); }
    catch { return await apiJSON(`/api/departamentos/${id}/membros`, 'PUT', body); }
  }

  function normalizeMembersForPanel(data, deptId){
    let members = normalizeColaboradores(data);
    if (!members.length && deptId) {
      members = state.colaboradores.filter(c => {
        const deps = c.departamentos_ids || [];
        return Array.isArray(deps) && deps.some(x => Number(x) === Number(deptId));
      });
    }
    return members;
  }

  async function loadSelectedMembers(){
    if (!state.selectedId) {
      state.selectedMembers = [];
      renderSidePanel();
      return;
    }
    const data = await loadDepartamentoMembros(state.selectedId);
    state.selectedMembers = normalizeMembersForPanel(data, state.selectedId);
    renderSidePanel();
  }

  function countDescendants(n){
    return (n?.children || []).reduce((total, child) => total + 1 + countDescendants(child), 0);
  }

  function hasMatchInSubtree(n, q){
    if (!q) return true;
    const hay = `${labelOf(n)} ${n.codigo || ''} ${n.descricao || ''}`.toLowerCase();
    return hay.includes(q) || (n.children || []).some(c => hasMatchInSubtree(c, q));
  }

  function renderAll(){
    renderOrg();
    renderSidePanel();
    renderWizardPreview();
  }

  function renderOrg(){
    if (!orgContainer) return;
    orgContainer.innerHTML = '';

    const q = String(state.q || '').trim().toLowerCase();
    const cloneVisible = n => {
      if (!hasMatchInSubtree(n, q)) return null;
      const isOpen = !!q || state.expanded.has(Number(n.id)) || IS_MOBILE;
      const children = isOpen ? (n.children || []).map(cloneVisible).filter(Boolean) : [];
      return {
        ...n,
        children,
        _allChildren: (n.children || []).length,
        _descendants: countDescendants(n),
        _collapsed: !!((n.children || []).length && !isOpen)
      };
    };

    const roots = (state.nested || []).map(cloneVisible).filter(Boolean);
    const root = {
      id: 0,
      nome: companyLabel(),
      descricao: 'Departamento da empresa',
      codigo: 'Empresa',
      ativo: true,
      children: roots,
      _root: true,
      _allChildren: roots.length,
      _descendants: state.flat.length,
      _collapsed: false
    };

    const CARD_W = IS_MOBILE ? 220 : 242;
    const CARD_H = IS_MOBILE ? 112 : 112;
    const GAP_X = IS_MOBILE ? 18 : 26;
    const GAP_Y = IS_MOBILE ? 48 : 56;
    const ROW_GAP = IS_MOBILE ? 24 : 30;
    const PAD_X = IS_MOBILE ? 28 : 58;
    const PAD_Y = IS_MOBILE ? 30 : 56;
    const BUS_GAP = IS_MOBILE ? 18 : 22;

    const viewW = Math.max(360, Number(orgContainer.clientWidth || 0));
    const maxCols = (() => {
      const usable = Math.max(CARD_W, viewW - PAD_X * 2);
      const byWidth = Math.max(1, Math.floor((usable + GAP_X) / (CARD_W + GAP_X)));
      if (viewW < 560) return Math.min(1, byWidth);
      if (viewW < 900) return Math.min(2, byWidth);
      if (viewW < 1240) return Math.min(3, byWidth);
      return Math.min(4, byWidth);
    })();

    const measure = node => {
      if (!node.children?.length) {
        node._subW = CARD_W;
        node._subH = CARD_H;
        return node._subW;
      }
      const childrenW = node.children.reduce((sum, child, index) => sum + measure(child) + (index ? GAP_X : 0), 0);
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

      const childrenW = node.children.reduce((sum, child, index) => sum + child._subW + (index ? GAP_X : 0), 0);
      let cursor = left + (node._subW - childrenW) / 2;
      node.children.forEach((child, index) => {
        if (index) cursor += GAP_X;
        placeSubtree(child, cursor, top + CARD_H + GAP_Y, depth + 1);
        cursor += child._subW;
      });
    };

    root.children.forEach(measure);

    const packRows = children => {
      const usable = Math.max(CARD_W, viewW - PAD_X * 2);
      const rows = [];
      let row = [];
      let rowW = 0;
      children.forEach(child => {
        const itemW = Math.max(CARD_W, child._subW || CARD_W);
        const nextW = rowW + (row.length ? GAP_X : 0) + itemW;
        const shouldBreak = row.length && (row.length >= maxCols || (nextW > usable && row.length >= Math.min(maxCols, 2)));
        if (shouldBreak) {
          rows.push({ items: row, width: rowW, height: Math.max(...row.map(x => x._subH || CARD_H), CARD_H) });
          row = [];
          rowW = 0;
        }
        rowW += (row.length ? GAP_X : 0) + itemW;
        row.push(child);
      });
      if (row.length) rows.push({ items: row, width: rowW, height: Math.max(...row.map(x => x._subH || CARD_H), CARD_H) });
      return rows;
    };

    const rootRows = packRows(root.children || []);
    const widestRow = rootRows.reduce((max, row) => Math.max(max, row.width), CARD_W);
    let boardW = Math.ceil(Math.max(CARD_W + PAD_X * 2, widestRow + PAD_X * 2, viewW));

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
      row.items.forEach((child, index) => {
        if (index) cursor += GAP_X;
        child._rootRow = rowIndex;
        placeSubtree(child, cursor, rowTop, 1);
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
      (node.children || []).forEach(c => collect(c, node));
    };
    collect(root);

    const maxRight = Math.max(...allNodes.map(n => n._x + CARD_W), CARD_W) + PAD_X;
    const maxBottom = Math.max(...allNodes.map(n => n._y + CARD_H), CARD_H) + PAD_Y;
    boardW = Math.ceil(Math.max(maxRight, boardW));
    const boardH = Math.ceil(Math.max(maxBottom, 520));

    const stage = document.createElement('div');
    stage.className = 'org-stage';
    stage.style.width = `${boardW}px`;
    stage.style.height = `${boardH}px`;
    stage.dataset.boardW = String(boardW);
    stage.dataset.boardH = String(boardH);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('org-svg');
    svg.setAttribute('width', String(boardW));
    svg.setAttribute('height', String(boardH));
    svg.setAttribute('viewBox', `0 0 ${boardW} ${boardH}`);

    const layer = document.createElement('div');
    layer.className = 'org-nodes-layer';

    const activeIds = new Set();
    let cursorDept = state.selectedId ? findDept(state.selectedId) : null;
    while (cursorDept) {
      activeIds.add(Number(cursorDept.id));
      cursorDept = cursorDept.parent_id ? findDept(cursorDept.parent_id) : null;
    }

    const makePath = (d, active = false) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', `org-link${active ? ' is-active' : ''}`);
      svg.appendChild(path);
    };
    const makeDot = (x, y) => {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(y));
      dot.setAttribute('r', '4.5');
      dot.setAttribute('class', 'org-link-dot');
      svg.appendChild(dot);
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
        const activeRow = row.items.some(child => activeIds.has(Number(child.id)) || state.selectedId === 0);
        makePath(`M ${rootX} ${rootY} C ${rootX} ${rootY + 20}, ${rootX} ${busY}, ${rootX} ${busY}`, activeRow);
        if (Math.abs(maxX - minX) > 1) makePath(`M ${minX} ${busY} L ${maxX} ${busY}`, activeRow);
        row.items.forEach(child => {
          const cX = child._x + CARD_W / 2;
          const cY = child._y;
          makePath(`M ${cX} ${busY} C ${cX} ${busY + 10}, ${cX} ${cY - 10}, ${cX} ${cY}`, activeIds.has(Number(child.id)) || state.selectedId === 0);
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
      const active = activeIds.has(Number(parent.id)) && activeIds.has(Number(child.id));
      makePath(`M ${pX} ${pY} C ${pX} ${midY}, ${cX} ${midY}, ${cX} ${cY}`, active);
      makeDot(cX, cY);
    });

    allNodes.forEach((node, index) => {
      const wrap = document.createElement('div');
      wrap.className = 'org-card-wrap';
      wrap.style.left = `${node._x}px`;
      wrap.style.top = `${node._y}px`;
      wrap.style.width = `${CARD_W}px`;
      wrap.style.height = `${CARD_H}px`;
      const nodeId = Number(node.id || 0);
      const menuOpen = state.openMenuId === nodeId;
      if (menuOpen) wrap.classList.add('is-menu-open');
      wrap.style.zIndex = menuOpen ? '9000' : String(10 + index);
      wrap.appendChild(buildNodeCard(node, !!node._root, q));
      layer.appendChild(wrap);
    });

    if (!state.flat.length) {
      const empty = document.createElement('div');
      empty.className = 'org-empty-hint';
      empty.innerHTML = `
        <i class="fa-regular fa-folder-open"></i>
        <strong>Nenhum departamento criado ainda.</strong>
        <span>Clique em <b>ADICIONAR</b> para começar a montar a estrutura.</span>
      `;
      layer.appendChild(empty);
    }

    stage.appendChild(svg);
    stage.appendChild(layer);
    orgContainer.appendChild(stage);
    state.stage = stage;

    setupPanZoom(stage);
    if (!state.orgTouched) resetStage();
    else applyStageTransform();
  }

  function buildNodeCard(n, isRoot, q){
    const card = document.createElement('article');
    const selected = Number(state.selectedId || 0) === Number(n.id || 0);
    const direct = Number(n._allChildren || 0);
    const total = Number(n._descendants || 0);
    const memberCount = isRoot ? state.colaboradores.length : Number(n.colaboradores_count || 0);
    const title = isRoot ? (companyLabel()) : labelOf(n);
    const description = isRoot ? 'Departamento da empresa' : (n.descricao || 'Departamento');
    const match = q && !isRoot && `${title} ${n.codigo || ''} ${n.descricao || ''}`.toLowerCase().includes(q);

    card.className = `org-card${isRoot ? ' is-root' : ''}${selected ? ' is-selected' : ''}${match ? ' match' : ''}${n.ativo === false ? ' is-inactive' : ''}`;
    card.dataset.id = String(n.id || 0);

    const showBadge = selected || isRoot;
    const badgeLabel = isRoot ? 'EMPRESA' : 'SELECIONADO';
    card.innerHTML = `
      ${showBadge ? `<div class="org-selected-badge">${badgeLabel}</div>` : ''}
      <div class="org-card-main">
        <div class="org-icon">${isRoot ? '<i class="fa-solid fa-building"></i>' : escapeHtml(shortCode(n))}</div>
        <div class="org-info">
          <strong class="org-title" title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
          <div class="org-sub" title="${escapeHtml(description)}">${escapeHtml(description)}</div>
          <div class="org-count">${memberCount} colaborador${memberCount === 1 ? '' : 'es'}</div>
        </div>
        <button class="org-menu-btn${state.openMenuId === Number(n.id || 0) ? ' is-open' : ''}" type="button" aria-label="Ações" title="Ações" data-menu-id="${n.id || 0}">
          <i class="fa-solid fa-ellipsis"></i>
        </button>
      </div>
      <button class="org-footer${direct ? '' : ' is-empty'}" type="button" data-toggle-id="${n.id || 0}" ${direct ? '' : 'aria-disabled="true"'}>
        <span>${direct} ${isRoot ? 'departamento' : 'subdepartamento'}${direct === 1 ? '' : 's'}</span>
        ${direct ? `<i class="fa-solid ${n._collapsed ? 'fa-angle-right' : 'fa-angle-up'}"></i>` : ''}
      </button>
    `;

    if (state.openMenuId === Number(n.id || 0)) {
      const menu = document.createElement('div');
      menu.className = 'org-action-menu';
      menu.innerHTML = isRoot ? `
        <button type="button" data-action="add-child" data-id="0"><i class="fa-solid fa-plus"></i><strong>Novo departamento</strong><span>Criar abaixo da empresa.</span></button>
        <button type="button" data-action="fit" data-id="0"><i class="fa-solid fa-crosshairs"></i><strong>Centralizar organograma</strong><span>Voltar para a visão completa.</span></button>
      ` : `
        <button type="button" data-action="edit" data-id="${n.id}"><i class="fa-solid fa-pen-to-square"></i><strong>Editar departamento</strong><span>Nome, descrição, código e status.</span></button>
        <button type="button" data-action="add-child" data-id="${n.id}"><i class="fa-solid fa-folder-plus"></i><strong>Novo subdepartamento</strong><span>Criar abaixo deste setor.</span></button>
        <button type="button" data-action="members" data-id="${n.id}"><i class="fa-solid fa-users-gear"></i><strong>Colaboradores</strong><span>Selecionar membros deste departamento.</span></button>
        <button type="button" data-action="schedule" data-id="${n.id}"><i class="fa-solid fa-clock"></i><strong>Disponibilidade</strong><span>Quando este setor recebe atendimentos.</span></button>
        <button type="button" data-action="instances" data-id="${n.id}"><i class="fa-solid fa-mobile-screen-button"></i><strong>Canais de entrada</strong><span>WhatsApps que podem rotear para o setor.</span></button>
        <button type="button" data-action="transfer" data-id="${n.id}"><i class="fa-solid fa-right-left"></i><strong>Mover departamento</strong><span>Trocar o departamento principal.</span></button>
        <button type="button" class="danger" data-action="del" data-id="${n.id}"><i class="fa-solid fa-trash-can"></i><strong>Remover</strong><span>Excluir da estrutura.</span></button>
      `;
      card.appendChild(menu);

      // O menu fica dentro do canvas do organograma. Sem estes stops,
      // wheel/touch podem vazar para o pan/zoom do canvas e impedir
      // que a lista do menu role até o final.
      menu.addEventListener('wheel', ev => ev.stopPropagation(), { passive: true });
      menu.addEventListener('touchmove', ev => ev.stopPropagation(), { passive: true });

      const menuTrigger = card.querySelector('.org-menu-btn');
      placeOrgActionMenu(menu, menuTrigger, card);
    }

    card.addEventListener('click', ev => {
      if (ev.target.closest('.org-menu-btn,.org-action-menu,.org-footer')) return;
      selectDepartment(Number(n.id || 0));
    });

    card.addEventListener('dblclick', ev => {
      if (isRoot || ev.target.closest('button')) return;
      const item = findDept(n.id);
      if (item) openModalEditar(item, 1);
    });

    card.querySelector('.org-menu-btn')?.addEventListener('click', ev => {
      ev.stopPropagation();
      const id = Number(ev.currentTarget.dataset.menuId || 0);
      state.openMenuId = state.openMenuId === id ? null : id;
      renderOrg();
    });

    card.querySelector('.org-footer')?.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!direct) return;
      if (isRoot) {
        state.flat.forEach(d => state.expanded.add(Number(d.id)));
      } else if (state.expanded.has(Number(n.id))) {
        state.expanded.delete(Number(n.id));
      } else {
        state.expanded.add(Number(n.id));
      }
      state.orgTouched = true;
      renderOrg();
    });

    return card;
  }

  function clampNumber(value, min, max){
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function placeOrgActionMenu(menu, trigger, card){
    if (!menu || !trigger || !card) return;
    const canvas = document.querySelector('.dept-canvas') || document.querySelector('.org-container') || document.body;

    menu.classList.remove('is-flip-y', 'is-align-right');
    menu.style.top = '';
    menu.style.bottom = '';
    menu.style.left = '';
    menu.style.right = '';
    menu.style.maxHeight = '';

    const canvasRect = canvas.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const safeTop = Math.max(canvasRect.top, 12);
    const safeBottom = Math.min(canvasRect.bottom, viewportHeight - 12);
    const safeLeft = Math.max(canvasRect.left, 12);
    const safeRight = Math.min(canvasRect.right, viewportWidth - 12);

    const openBelowTop = Math.max(40, triggerRect.bottom - cardRect.top + 8);
    const openAboveBottom = Math.max(8, cardRect.bottom - triggerRect.top + 8);
    const spaceBelow = Math.max(180, Math.floor(safeBottom - triggerRect.bottom - 12));
    const spaceAbove = Math.max(180, Math.floor(triggerRect.top - safeTop - 12));

    if (spaceBelow < 280 && spaceAbove > spaceBelow) {
      menu.classList.add('is-flip-y');
      menu.style.bottom = `${openAboveBottom}px`;
      menu.style.maxHeight = `${Math.min(spaceAbove, 560)}px`;
    } else {
      menu.style.top = `${openBelowTop}px`;
      menu.style.maxHeight = `${Math.min(spaceBelow, 560)}px`;
    }

    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > safeRight) {
        menu.classList.add('is-align-right');
        menu.style.left = 'auto';
        menu.style.right = '0';
      }
      const rect2 = menu.getBoundingClientRect();
      if (rect2.left < safeLeft) {
        menu.classList.remove('is-align-right');
        menu.style.left = '0';
        menu.style.right = 'auto';
      }
    });
  }

  function snapZoom(value){
    const z = Number(value) || 1;
    return Math.abs(z - 1) < .055 ? 1 : z;
  }

  function applyStageTransform(){
    if (!state.stage) return;
    const zoom = snapZoom(state.zoom || 1);
    state.zoom = zoom;
    const tx = zoom === 1 ? Math.round(state.tx || 0) : Number((state.tx || 0).toFixed(2));
    const ty = zoom === 1 ? Math.round(state.ty || 0) : Number((state.ty || 0).toFixed(2));

    /* Evita scale fracionado no estado normal.
       scale(0.95/0.98) deixa texto e ícones com aparência borrada no Chrome. */
    state.stage.style.transform = zoom === 1
      ? `translate(${tx}px, ${ty}px)`
      : `translate(${tx}px, ${ty}px) scale(${Number(zoom.toFixed(4))})`;

    if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function resetStage(){
    const stage = state.stage;
    const viewport = orgContainer;
    if (!stage || !viewport) return;
    const boardW = Number(stage.dataset.boardW || 0);
    const boardH = Number(stage.dataset.boardH || 0);
    const viewW = Number(viewport.clientWidth || 0);
    const viewH = Number(viewport.clientHeight || 0);
    const pad = IS_MOBILE ? 18 : 32;
    const fitX = boardW > 0 && viewW > 0 ? (viewW - pad * 2) / boardW : 1;
    const fitY = boardH > 0 && viewH > 0 ? (viewH - pad * 2) / boardH : 1;
    const minZoom = IS_MOBILE ? .62 : .72;
    const rawFitZoom = clampNumber(Math.min(1, fitX, fitY), minZoom, 1);
    /* Quando cabe quase inteiro, mantém 100% para não borrar as fontes.
       Se ficar levemente maior, o usuário ainda pode arrastar ou centralizar. */
    state.zoom = (!IS_MOBILE && rawFitZoom >= .90) ? 1 : rawFitZoom;
    state.tx = Math.round((viewW - boardW * state.zoom) / 2);
    state.ty = Math.round(Math.max(pad, (viewH - boardH * state.zoom) / 2));
    state.orgTouched = false;
    applyStageTransform();
  }

  function zoomAt(nextZoom, anchorX, anchorY){
    const oldZoom = state.zoom || 1;
    const oldTx = state.tx || 0;
    const oldTy = state.ty || 0;
    const viewW = Number(orgContainer?.clientWidth || 0);
    const viewH = Number(orgContainer?.clientHeight || 0);
    const ax = Number.isFinite(anchorX) ? anchorX : viewW / 2;
    const ay = Number.isFinite(anchorY) ? anchorY : viewH / 2;
    state.zoom = snapZoom(clampNumber(nextZoom, .5, 2.2));
    state.tx = ax - ((ax - oldTx) / oldZoom) * state.zoom;
    state.ty = ay - ((ay - oldTy) / oldZoom) * state.zoom;
    state.orgTouched = true;
    applyStageTransform();
  }

  function setupPanZoom(stage){
    applyStageTransform();
    let pan = false;
    let lx = 0;
    let ly = 0;

    orgContainer.onpointerdown = e => {
      if (e.target.closest('button,a,input,textarea,select,.org-action-menu')) return;
      pan = true;
      lx = e.clientX;
      ly = e.clientY;
      state.orgTouched = true;
      orgContainer.setPointerCapture?.(e.pointerId);
    };
    orgContainer.onpointermove = e => {
      if (!pan) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      state.tx += dx;
      state.ty += dy;
      applyStageTransform();
    };
    const up = e => {
      pan = false;
      try { orgContainer.releasePointerCapture?.(e.pointerId); } catch {}
    };
    orgContainer.onpointerup = up;
    orgContainer.onpointercancel = up;
    orgContainer.onwheel = e => {
      // Quando o mouse está em cima do menu de ações, a rolagem deve
      // descer/subir o próprio menu. Antes o canvas interceptava o wheel,
      // dava preventDefault e transformava tudo em zoom, por isso o menu
      // parecia travado.
      if (e.target.closest('.org-action-menu')) {
        e.stopPropagation();
        return;
      }

      e.preventDefault();
      const rect = orgContainer.getBoundingClientRect();
      const factor = Math.pow(1.0015, -e.deltaY);
      zoomAt((state.zoom || 1) * factor, e.clientX - rect.left, e.clientY - rect.top);
    };
  }

  function selectDepartment(id){
    state.selectedId = Number(id || 0);
    state.openMenuId = null;
    renderOrg();
    renderSidePanel(true);
    loadSelectedMembers().catch(err => console.warn('[departamentos] membros painel', err));
  }

  function sideActionMenuHtml(isRoot, id){
    if (!state.sideMenuOpen) return '';
    if (isRoot) {
      return `
        <div class="side-action-menu" role="menu">
          <button type="button" data-action="add-child" data-id="0"><i class="fa-solid fa-plus"></i><span>Novo departamento</span></button>
          <button type="button" data-action="fit" data-id="0"><i class="fa-solid fa-crosshairs"></i><span>Centralizar</span></button>
        </div>
      `;
    }
    return `
      <div class="side-action-menu" role="menu">
        <button type="button" data-action="edit" data-id="${id}"><i class="fa-solid fa-pen-to-square"></i><span>Editar departamento</span></button>
        <button type="button" data-action="members" data-id="${id}"><i class="fa-solid fa-users-gear"></i><span>Colaboradores</span></button>
        <button type="button" data-action="schedule" data-id="${id}"><i class="fa-solid fa-clock"></i><span>Disponibilidade</span></button>
        <button type="button" data-action="instances" data-id="${id}"><i class="fa-solid fa-mobile-screen-button"></i><span>Canais de entrada</span></button>
        <button type="button" data-action="transfer" data-id="${id}"><i class="fa-solid fa-right-left"></i><span>Mover departamento</span></button>
        <button type="button" class="danger" data-action="del" data-id="${id}"><i class="fa-solid fa-trash-can"></i><span>Remover</span></button>
      </div>
    `;
  }

  function renderSidePanel(loading = false){
    if (!sidePanel) return;
    const isRoot = !state.selectedId;
    const dept = isRoot ? null : findDept(state.selectedId);
    const title = isRoot ? (companyLabel()) : (dept ? labelOf(dept) : 'Departamento');
    const subtitle = isRoot ? 'Raiz da empresa' : (dept?.descricao || dept?.codigo || 'Departamento');
    const members = loading ? [] : (isRoot ? [] : state.selectedMembers || []);
    const total = isRoot ? state.flat.length : members.length;

    const peopleHtml = members.length ? members.map(p => personRowHtml(p)).join('') : `
      <div class="side-empty">
        <div class="empty-illustration"><i class="fa-solid fa-sitemap"></i></div>
        <strong>${isRoot ? 'Selecione um departamento' : 'Adicionar colaboradores'}</strong>
        <p>${isRoot ? 'Clique em um card do organograma para ver os colaboradores e detalhes.' : 'Vincule colaboradores a este departamento na etapa de configurações.'}</p>
        ${isRoot ? '' : `<button class="blue-add" type="button" data-action="members" data-id="${state.selectedId || 0}">Adicionar</button>`}
      </div>
    `;

    sidePanel.innerHTML = `
      <div class="side-head">
        <div class="side-title">
          <h2 title="${escapeHtml(title)}">${escapeHtml(title)}</h2>
          <small>${escapeHtml(subtitle)}</small>
        </div>
        <div class="side-icons">
          <button type="button" class="${state.sideMenuOpen ? 'is-open' : ''}" data-action="menu" data-id="${state.selectedId || 0}" title="Ações"><i class="fa-solid fa-ellipsis"></i></button>
          <button type="button" data-action="fit" data-id="0" title="Centralizar"><i class="fa-solid fa-arrow-down-short-wide"></i></button>
          ${sideActionMenuHtml(isRoot, state.selectedId || 0)}
        </div>
      </div>
      <div class="side-body">
        <div class="side-summary">
          <div class="summary-box"><span>${isRoot ? 'Departamentos cadastrados' : 'Total de colaboradores'}</span><strong>${loading ? '...' : total}</strong></div>
          <div class="summary-box"><span>Configurações</span><em class="soon">${isRoot ? 'Geral' : 'Departamento'}</em></div>
        </div>
        <label class="side-search">
          <i class="fa-solid fa-magnifying-glass"></i>
          <input id="side-people-search" type="search" placeholder="Buscar por nome ou cargo" autocomplete="off" spellcheck="false">
        </label>
        ${isRoot ? '' : `
        <section class="side-section">
          <div class="section-head">
            <h3>Colaboradores <b>${loading ? '' : total}</b></h3>
            <button type="button" class="section-action-btn" data-action="members" data-id="${state.selectedId || 0}">Gerenciar</button>
          </div>
          <div id="side-people-list" class="people-list">${loading ? '<div class="members-empty">Carregando...</div>' : peopleHtml}</div>
        </section>
        `}
        <div class="side-bottom">
          <div class="info-box"><span>Status</span><strong>${isRoot || dept?.ativo !== false ? 'Ativo' : 'Inativo'}</strong></div>
          <div class="info-box"><span>Código</span><strong>${escapeHtml(isRoot ? 'Empresa' : (dept?.codigo || 'Departamento'))}</strong></div>
          <div class="info-box"><span>Disponibilidade</span><strong>${escapeHtml(isRoot ? 'Geral' : ([dept?.hora_login_inicio_padrao, dept?.hora_login_fim_padrao].filter(Boolean).join(' às ') || 'Geral da empresa'))}</strong></div>
        </div>
      </div>
    `;

    const sideSearch = $('#side-people-search', sidePanel);
    sideSearch?.addEventListener('input', debounce(() => {
      const q = sideSearch.value.trim().toLowerCase();
      const filtered = members.filter(p => `${p.nome || ''} ${p.email || ''} ${p.cargo || ''}`.toLowerCase().includes(q));
      const list = $('#side-people-list', sidePanel);
      if (list) list.innerHTML = filtered.length ? filtered.map(p => personRowHtml(p)).join('') : '<div class="members-empty">Nenhum colaborador encontrado.</div>';
    }, 120));
  }

  function personRowHtml(p){
    const sub = [p.cargo, p.email].filter(Boolean).join(' • ') || 'Cargo não especificado';
    const avatar = p.avatar_url
      ? `<span class="avatar"><img src="${escapeHtml(p.avatar_url)}" alt=""></span>`
      : `<span class="avatar">${escapeHtml(initialsOf(p.nome))}</span>`;
    return `
      <div class="person-row">
        ${avatar}
        <span class="person-main"><strong>${escapeHtml(p.nome || 'Colaborador')}</strong><small>${escapeHtml(sub)}</small></span>
        <button class="dots" type="button" aria-label="Ações"><i class="fa-solid fa-ellipsis"></i></button>
      </div>
    `;
  }

  function fillParentSelect(){
    if (!selParent) return;
    const current = selParent.value;
    selParent.innerHTML = `<option value="">${escapeHtml(companyLabel())}</option>`;
    const editingId = Number(state.editing?.id || 0);
    const descendants = new Set();
    if (editingId) collectDescendantIds(editingId, descendants);

    const push = (n, level = 0) => {
      if (Number(n.id) === editingId || descendants.has(Number(n.id))) return;
      const opt = document.createElement('option');
      opt.value = String(n.id);
      opt.textContent = `${'— '.repeat(level)}${labelOf(n)}`;
      selParent.appendChild(opt);
      (n.children || []).forEach(c => push(c, level + 1));
    };
    state.nested.forEach(n => push(n, 0));
    if ([...selParent.options].some(o => o.value === current)) selParent.value = current;
  }

  function collectDescendantIds(id, out){
    const node = findNested(Number(id));
    const walk = n => {
      (n.children || []).forEach(c => {
        out.add(Number(c.id));
        walk(c);
      });
    };
    if (node) walk(node);
  }

  function findNested(id, arr = state.nested){
    for (const n of arr || []) {
      if (Number(n.id) === Number(id)) return n;
      const found = findNested(id, n.children || []);
      if (found) return found;
    }
    return null;
  }

  function setParentUi(){
    if (!selParent || !parentChip) return;
    const text = selParent.options[selParent.selectedIndex]?.textContent?.replace(/^—\s*/g, '').trim() || companyLabel();
    parentChip.querySelector('span').textContent = text || companyLabel();
  }

  function toggleParentPanel(force){
    if (!parentPanel) return;
    const open = typeof force === 'boolean' ? force : !parentPanel.classList.contains('open');
    parentPanel.classList.toggle('open', open);
    if (open) renderParentPanel();
  }

  function renderParentPanel(){
    if (!parentPanel || !selParent) return;
    parentPanel.innerHTML = '';
    const addItem = (value, text, level = 0) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'parent-item' + (String(selParent.value || '') === String(value || '') ? ' selected' : '');
      item.style.paddingLeft = `${10 + level * 18}px`;
      item.innerHTML = `<span class="parent-item-symbol" aria-hidden="true">${value ? 'D' : 'E'}</span><span>${escapeHtml(text)}</span>`;
      item.addEventListener('click', () => {
        selParent.value = value == null ? '' : String(value);
        setParentUi();
        renderWizardPreview();
        toggleParentPanel(false);
      });
      parentPanel.appendChild(item);
    };
    addItem('', companyLabel(), 0);
    const editingId = Number(state.editing?.id || 0);
    const descendants = new Set();
    if (editingId) collectDescendantIds(editingId, descendants);
    const push = (n, level = 0) => {
      if (Number(n.id) === editingId || descendants.has(Number(n.id))) return;
      addItem(n.id, labelOf(n), level);
      (n.children || []).forEach(c => push(c, level + 1));
    };
    state.nested.forEach(n => push(n, 0));
  }

  async function prepareMembrosModal(departamentoId = null){
    state.membrosSelecionados = new Set();
    if (membrosSearch) membrosSearch.value = '';
    renderMembrosList();

    const [colabs, membros] = await Promise.all([
      loadColaboradores(),
      departamentoId ? loadDepartamentoMembros(departamentoId) : Promise.resolve([])
    ]);

    const ids = [];
    if (Array.isArray(membros)) {
      membros.forEach(item => {
        const id = Number(item?.id ?? item?.colaborador_id ?? item?.usuario_id ?? item?.value);
        if (Number.isFinite(id) && id > 0) ids.push(id);
      });
    }
    state.membrosSelecionados = new Set(ids);

    if (!ids.length && departamentoId && Array.isArray(colabs)) {
      colabs.forEach(c => {
        const deps = c.departamentos_ids || [];
        if (Array.isArray(deps) && deps.some(x => Number(x) === Number(departamentoId))) state.membrosSelecionados.add(Number(c.id));
      });
    }

    renderMembrosList();
    renderWizardPreview();
  }

  function renderMembrosList(){
    if (!membrosList) return;
    const q = (membrosSearch?.value || '').trim().toLowerCase();
    const list = (state.colaboradores || []).filter(c => !q || `${c.nome || ''} ${c.email || ''} ${c.cargo || ''}`.toLowerCase().includes(q));
    membrosList.innerHTML = '';

    if (state.membrosLoading) {
      membrosList.innerHTML = '<div class="members-empty">Carregando colaboradores...</div>';
      updateMembrosCount();
      return;
    }
    if (!state.colaboradores.length) {
      membrosList.innerHTML = '<div class="members-empty">Nenhum colaborador cadastrado ainda. Crie os colaboradores na tela Colaboradores.</div>';
      updateMembrosCount();
      return;
    }
    if (!list.length) {
      membrosList.innerHTML = '<div class="members-empty">Nenhum colaborador encontrado.</div>';
      updateMembrosCount();
      return;
    }

    list.forEach(c => {
      const row = document.createElement('label');
      row.className = 'member-row';
      const checked = state.membrosSelecionados.has(Number(c.id));
      const sub = [c.cargo, c.email].filter(Boolean).join(' • ') || 'Colaborador';
      row.innerHTML = `
        <input type="checkbox" value="${c.id}" ${checked ? 'checked' : ''}>
        <span class="member-avatar">${escapeHtml(initialsOf(c.nome))}</span>
        <span class="member-main"><strong>${escapeHtml(c.nome)}</strong><small>${escapeHtml(sub)}</small></span>
      `;
      const input = row.querySelector('input');
      input.addEventListener('change', () => {
        const id = Number(input.value);
        if (input.checked) state.membrosSelecionados.add(id);
        else state.membrosSelecionados.delete(id);
        updateMembrosCount();
        renderWizardPreview();
      });
      membrosList.appendChild(row);
    });
    updateMembrosCount();
  }

  function renderInstanciasList(){
    if (!instanciasList) return;
    const list = state.instancias || [];
    if (!list.length) {
      instanciasList.innerHTML = '<div class="members-empty">Nenhuma instância encontrada para esta empresa.</div>';
      updateInstanciasCount();
      return;
    }

    instanciasList.innerHTML = '';
    list.forEach(inst => {
      const row = document.createElement('label');
      row.className = 'instancia-pill';
      row.innerHTML = `
        <input type="checkbox" value="${inst.id}" ${state.instanciasSelecionadas.has(Number(inst.id)) ? 'checked' : ''}>
        <span class="instancia-main">
          <strong>${escapeHtml(inst.nome)}</strong>
          <small>${escapeHtml(inst.numero || 'Sem número informado')}</small>
        </span>
        <span class="instancia-badge">${inst.connected ? 'Conectada' : 'Off'}</span>
      `;
      const input = $('input', row);
      input?.addEventListener('change', () => {
        const id = Number(input.value || 0);
        if (input.checked) state.instanciasSelecionadas.add(id);
        else state.instanciasSelecionadas.delete(id);
        updateInstanciasCount();
        renderWizardPreview();
      });
      instanciasList.appendChild(row);
    });
    updateInstanciasCount();
  }

  function updateInstanciasCount(){
    const qtd = state.instanciasSelecionadas?.size || 0;
    const text = qtd === 1 ? '1 selecionada' : `${qtd} selecionadas`;
    if (instanciasCount) instanciasCount.textContent = text;
    const reviewInst = $('#review-instancias');
    const reviewInline = $('#review-instancias-inline');
    if (reviewInst) reviewInst.textContent = text;
    if (reviewInline) reviewInline.textContent = text;
  }

  function getInstanciasSelecionadas(){
    return Array.from(state.instanciasSelecionadas || []).map(Number).filter(n => Number.isFinite(n) && n > 0);
  }

  function renderMembrosSummary(){
    if (!membrosSummary) return;
    const ids = getMembrosSelecionados();
    if (!ids.length) {
      membrosSummary.textContent = 'Nenhum colaborador selecionado.';
      return;
    }

    const byId = new Map((state.colaboradores || []).map(c => [Number(c.id), c]));
    const chips = ids.slice(0, 4).map(id => {
      const c = byId.get(Number(id));
      const nome = c?.nome || `Colaborador ${id}`;
      return `<span class="member-chip-clean"><b>${escapeHtml(nome)}</b></span>`;
    });
    const extra = ids.length > 4 ? `<span class="member-chip-more">+${ids.length - 4}</span>` : '';
    membrosSummary.innerHTML = chips.join('') + extra;
  }

  function updateMembrosCount(){
    const qtd = state.membrosSelecionados?.size || 0;
    if (membrosCount) membrosCount.textContent = qtd === 1 ? '1 selecionado' : `${qtd} selecionados`;
    const reviewColabs = $('#review-colabs');
    if (reviewColabs) reviewColabs.textContent = qtd === 1 ? '1 selecionado' : `${qtd} selecionados`;
    renderMembrosSummary();
  }

  function getMembrosSelecionados(){
    return Array.from(state.membrosSelecionados || []).map(Number).filter(n => Number.isFinite(n) && n > 0);
  }


  const HELP_CONTENT = {
    step1: '<strong>Etapa 1</strong><p>Defina o local do departamento na estrutura, o nome e uma descrição opcional.</p>',
    step2: '<strong>Etapa 2</strong><p>Selecione os colaboradores que poderão visualizar e atender este departamento.</p>',
    step3: '<strong>Etapa 3</strong><p>Revise os dados antes de salvar.</p>',
    parent: '<strong>Fica dentro de</strong><p>Escolha onde este departamento aparece na estrutura. Se ele ficar direto na raiz, deixe como Empresa.</p>',
    nome: '<strong>Nome</strong><p>Use um nome curto e claro, como Financeiro, Comercial ou Suporte.</p>',
    descricao: '<strong>Descrição</strong><p>Explique rapidamente a função do departamento ou o tipo de atendimento que ele faz.</p>',
    codigo: '<strong>Código</strong><p>Opcional. Pode ser uma sigla interna, como FIN, COM ou SUP.</p>',
    schedule: '<strong>Disponibilidade do setor</strong><p>Define quando este departamento pode receber novos atendimentos. Isso não altera o horário dos colaboradores.</p>',
    instances: '<strong>Canais de entrada</strong><p>Use apenas para roteamento: estes WhatsApps podem encaminhar conversas para o departamento. Isso não libera acesso ao número para colaboradores; esse acesso continua em Colaboradores.</p>'
  };

  function currentStepHelpKey(){
    if (state.modalStep === 2 && state.modalMode === 'schedule') return 'schedule';
    if (state.modalStep === 2 && state.modalMode === 'instances') return 'instances';
    return state.modalStep === 1 ? 'step1' : state.modalStep === 2 ? 'step2' : 'step3';
  }

  function openHelpPopover(anchor, key){
    if (!modalHelpPopover || !modalHelpPopoverContent || !anchor) return;
    const html = HELP_CONTENT[key] || HELP_CONTENT[currentStepHelpKey()] || '';
    modalHelpPopoverContent.innerHTML = html;
    modalHelpPopover.hidden = false;
    modalHelpPopover.dataset.key = key || '';

    const card = modal?.querySelector('.modal-card');
    if (!card) return;
    const a = anchor.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const top = (a.bottom - c.top) + 10;
    let left = (a.left - c.left) - 120;
    const minLeft = 20;
    const maxLeft = Math.max(20, c.width - 300);
    left = Math.max(minLeft, Math.min(maxLeft, left));
    modalHelpPopover.style.top = `${top}px`;
    modalHelpPopover.style.left = `${left}px`;
  }

  function closeHelpPopover(){
    if (!modalHelpPopover) return;
    modalHelpPopover.hidden = true;
    modalHelpPopover.dataset.key = '';
  }

  function showModal(){
    if (!modal) return;
    closeHelpPopover();
    modal.classList.add('open');
    modal.style.display = 'grid';
    modal.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('modal-open');
    document.addEventListener('keydown', onEscClose);
  }

  function closeModal(){
    if (!modal) return;
    modal.classList.remove('open');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('modal-open');
    document.removeEventListener('keydown', onEscClose);
    toggleParentPanel(false);
    if (membrosPanel) membrosPanel.hidden = true;
    if (membrosToggle) membrosToggle.textContent = 'Gerenciar';
    closeHelpPopover();
    state.editing = null;
  }

  function onEscClose(e){ if (e.key === 'Escape') closeModal(); }

  async function ensureModalListsReady(deptId = null){
    const mode = state.modalMode || 'members';
    if (mode === 'instances') {
      await loadInstancias();
      renderInstanciasList();
      renderWizardPreview();
      return;
    }
    if (mode === 'schedule') {
      renderWizardPreview();
      return;
    }
    await prepareMembrosModal(deptId);
  }

  function resetModalListsPlaceholders(){
    state.membrosSelecionados = new Set();
    if (membrosList) membrosList.innerHTML = '<div class="members-empty">Carregando colaboradores...</div>';
    if (membrosPanel) membrosPanel.hidden = false;
    if (membrosToggle) membrosToggle.textContent = 'Gerenciar';
    if (instanciasList) instanciasList.innerHTML = '';
    updateMembrosCount();
    updateInstanciasCount();
  }

  async function openModalNovo(parentId = null, step = 1, mode = 'members'){
    state.editing = null;
    state.modalMode = mode || 'members';
    fillParentSelect();
    form?.reset();
    inpId.value = '';
    inpNome.value = '';
    txtDesc.value = '';
    inpCodigo.value = '';
    chkAtivo.checked = true;
    if (inpHoraInicio) inpHoraInicio.value = '';
    if (inpHoraFim) inpHoraFim.value = '';
    if (chkUsarHorarioGeral) chkUsarHorarioGeral.checked = true;
    syncDisponibilidadeUi();
    state.instanciasSelecionadas = new Set();
    selParent.value = parentId ? String(parentId) : '';
    setParentUi();
    resetModalListsPlaceholders();
    if (step >= 2) await ensureModalListsReady(null);
    setModalStep(step);
    showModal();
    setTimeout(() => inpNome?.focus(), 60);
  }

  async function openModalEditar(item, step = 1, mode = 'members'){
    if (!item) return;
    state.editing = item;
    state.modalMode = mode || 'members';
    fillParentSelect();
    inpId.value = String(item.id);
    inpNome.value = item.nome || labelOf(item) || '';
    txtDesc.value = item.descricao || '';
    inpCodigo.value = item.codigo || '';
    chkAtivo.checked = item.ativo !== false;
    if (inpHoraInicio) inpHoraInicio.value = normTime(item.hora_login_inicio_padrao);
    if (inpHoraFim) inpHoraFim.value = normTime(item.hora_login_fim_padrao);
    setDisponibilidadeFromCurrentValues();
    state.instanciasSelecionadas = new Set(Array.isArray(item.whatsapp_instancias) ? item.whatsapp_instancias.map(Number).filter(Boolean) : []);
    selParent.value = item.parent_id ? String(item.parent_id) : '';
    setParentUi();

    try {
      const det = await loadDeptoDetails(item.id);
      if (det) {
        txtDesc.value = det.descricao ?? det.obs ?? txtDesc.value ?? '';
        inpCodigo.value = det.codigo ?? det.code ?? inpCodigo.value ?? '';
        if (inpHoraInicio) inpHoraInicio.value = normTime(det.hora_login_inicio_padrao ?? det.login_inicio_padrao ?? item.hora_login_inicio_padrao);
        if (inpHoraFim) inpHoraFim.value = normTime(det.hora_login_fim_padrao ?? det.login_fim_padrao ?? item.hora_login_fim_padrao);
        setDisponibilidadeFromCurrentValues();
        state.instanciasSelecionadas = new Set((det.whatsapp_instancias || item.whatsapp_instancias || []).map(Number).filter(Boolean));
      }
    } catch {}

    resetModalListsPlaceholders();
    if (step >= 2) await ensureModalListsReady(item.id);
    setModalStep(step);
    showModal();
    setTimeout(() => {
      if (step === 1) inpNome?.focus();
      else if (state.modalMode === 'schedule') chkUsarHorarioGeral?.focus();
      else if (state.modalMode === 'instances') instanciasList?.querySelector('input')?.focus();
      else membrosSearch?.focus();
    }, 60);
  }

  function setModalStep(step){
    state.modalStep = clampNumber(step, 1, 3);
    const mode = state.modalMode || 'members';
    const modalCard = modal?.querySelector('.modal-card');
    if (modalCard) {
      modalCard.classList.toggle('modal-mode-members', mode === 'members');
      modalCard.classList.toggle('modal-mode-schedule', mode === 'schedule');
      modalCard.classList.toggle('modal-mode-instances', mode === 'instances');
    }
    $$('.wizard-step').forEach(el => el.classList.toggle('is-active', Number(el.dataset.step) === state.modalStep));
    if (modalStepLabel) modalStepLabel.textContent = `Etapa ${state.modalStep} de 3`;
    if (modalTitle) {
      modalTitle.textContent = state.modalStep === 1
        ? 'Nome e descrição do departamento'
        : state.modalStep === 2
          ? (mode === 'schedule' ? 'Disponibilidade do setor' : mode === 'instances' ? 'Canais de entrada do departamento' : 'Equipe do departamento')
          : 'Revisão e conclusão';
    }

    if (modalProgress) {
      const stepItems = $$('.wizard-stepper-item', modalProgress);
      if (stepItems.length) {
        stepItems.forEach(item => {
          const idx = Number(item.dataset.stepIndex || 0);
          const textEl = $('.step-text', item);
          if (idx === 2 && textEl) textEl.textContent = mode === 'schedule' ? 'Disponibilidade' : mode === 'instances' ? 'Canais' : 'Equipe';
          item.classList.toggle('is-active', idx === state.modalStep);
          item.classList.toggle('is-complete', idx < state.modalStep);
          const dot = $('.step-dot', item);
          if (dot) dot.textContent = idx < state.modalStep ? '✓' : String(idx || '');
        });
        $$('.step-line', modalProgress).forEach((line, idx) => {
          line.classList.toggle('is-complete', idx + 1 < state.modalStep);
          line.classList.toggle('is-active', idx + 1 === state.modalStep - 1);
        });
      } else {
        $$('span', modalProgress).forEach((bar, idx) => bar.classList.toggle('active', idx < state.modalStep));
      }
    }

    const isScheduleQuick = state.modalStep === 2 && mode === 'schedule';
    if (btnBack) btnBack.style.visibility = (state.modalStep > 1 && !isScheduleQuick) ? 'visible' : 'hidden';
    if (btnNext) btnNext.style.display = (state.modalStep < 3 && !isScheduleQuick) ? 'inline-flex' : 'none';
    if (btnSave) {
      btnSave.style.display = (state.modalStep === 3 || isScheduleQuick) ? 'inline-flex' : 'none';
      btnSave.innerHTML = isScheduleQuick
        ? 'Salvar disponibilidade <i class="fa-solid fa-check"></i>'
        : 'Salvar <i class="fa-solid fa-check"></i>';
    }
    if (modalHelpToggle) modalHelpToggle.title = isScheduleQuick ? 'Ajuda sobre disponibilidade' : 'Ajuda da etapa';
    if (isScheduleQuick) syncDisponibilidadeUi();
    closeHelpPopover();
    renderWizardPreview();
  }

  function validateStep(step){
    if (step === 1 && !(inpNome.value || '').trim()) {
      toast('Informe o nome do departamento.', 'warn');
      inpNome.focus();
      return false;
    }
    if (step === 2) {
      const hi = normTime(inpHoraInicio?.value);
      const hf = normTime(inpHoraFim?.value);
      const usaGeral = chkUsarHorarioGeral ? !!chkUsarHorarioGeral.checked : !hasHorarioPersonalizado();
      if ((state.modalMode || 'members') === 'schedule' && !usaGeral && (hasInvalidTime(inpHoraInicio) || hasInvalidTime(inpHoraFim))) {
        toast('Horário inválido. Use o formato HH:MM, exemplo 08:00.', 'warn');
        (hasInvalidTime(inpHoraInicio) ? inpHoraInicio : inpHoraFim)?.focus();
        return false;
      }
      if ((state.modalMode || 'members') === 'schedule' && !usaGeral && (!hi || !hf)) {
        toast('Informe entrada e saída ou use o horário geral da empresa.', 'warn');
        (!hi ? inpHoraInicio : inpHoraFim)?.focus();
        return false;
      }
      if (hi && hf && hi > hf) {
        toast('O horário de entrada não pode ser maior que o de saída.', 'warn');
        inpHoraInicio?.focus();
        return false;
      }
    }
    return true;
  }

  function renderWizardPreview(){
    const company = companyLabel();
    ['preview-company','preview-company-2'].forEach(id => { const el = $('#' + id); if (el) el.textContent = company; });
    const name = (inpNome?.value || '').trim() || 'Departamento de Vendas';
    const parentText = selParent?.options[selParent.selectedIndex]?.textContent?.replace(/^—\s*/g, '').trim() || company;
    const count = state.membrosSelecionados?.size || 0;
    const horarios = [normTime(inpHoraInicio?.value), normTime(inpHoraFim?.value)].filter(Boolean);
    const usarHorarioGeral = chkUsarHorarioGeral ? !!chkUsarHorarioGeral.checked : horarios.length === 0;
    const horarioLabel = usarHorarioGeral ? 'Geral da empresa' : (horarios.length === 2 ? `${horarios[0]} às ${horarios[1]}` : horarios.length === 1 ? horarios[0] : 'Não definido');
    const instanciasQtd = state.instanciasSelecionadas?.size || 0;

    const previewHtml = `
      <div class="preview-company-box">${escapeHtml(company)}</div>
      <div class="preview-parent-box">${escapeHtml(parentText)}</div>
      <div class="preview-dept-card">
        <div class="preview-dept-title">${escapeHtml(name)}</div>
        <div class="preview-mini-user">
          <span class="preview-mini-avatar"></span>
          <span class="preview-mini-lines"><span></span><span></span></span>
        </div>
        <div class="preview-dept-meta">
          <span>Colaboradores <b>${count} colaborador${count === 1 ? '' : 'es'}</b></span>
        </div>
      </div>
    `;
    ['wizard-preview','wizard-preview-2','wizard-preview-3'].forEach(id => { const el = $('#' + id); if (el) el.innerHTML = previewHtml; });

    const reviewNome = $('#review-nome');
    const reviewParent = $('#review-parent');
    const reviewStatus = $('#review-status');
    const reviewHorario = $('#review-horario');
    const reviewHorarioInline = $('#review-horario-inline');
    if (reviewNome) reviewNome.textContent = name;
    if (reviewParent) reviewParent.textContent = parentText;
    if (reviewStatus) reviewStatus.textContent = chkAtivo?.checked ? 'Ativo' : 'Inativo';
    if (reviewHorario) reviewHorario.textContent = horarioLabel;
    if (reviewHorarioInline) reviewHorarioInline.textContent = horarioLabel;
    updateMembrosCount();
    updateInstanciasCount();
  }

  function getPayload(){
    const usaHorarioGeral = chkUsarHorarioGeral ? !!chkUsarHorarioGeral.checked : !hasHorarioPersonalizado();
    const payload = {
      nome: (inpNome.value || '').trim(),
      descricao: (txtDesc.value || '').trim() || null,
      parent_id: selParent.value ? Number(selParent.value) : null,
      codigo: (inpCodigo.value || '').trim() || null,
      ativo: !!chkAtivo.checked,
      hora_login_inicio_padrao: usaHorarioGeral ? null : (normTime(inpHoraInicio?.value) || null),
      hora_login_fim_padrao: usaHorarioGeral ? null : (normTime(inpHoraFim?.value) || null)
    };

    // Segurança de dados: só envia canais/instâncias quando essa tela foi aberta
    // especificamente para editar canais. Assim editar nome, equipe ou horário
    // nunca limpa vínculos de WhatsApp por acidente.
    if ((state.modalMode || 'members') === 'instances') {
      payload.whatsapp_instancias = getInstanciasSelecionadas();
    }

    return payload;
  }

  async function saveDepto(){
    if (!validateStep(1)) return;
    if ((state.modalMode || 'members') === 'schedule' && state.modalStep === 2 && !validateStep(2)) return;
    const payload = getPayload();
    try {
      Loader.show('Salvando...');
      let saved = null;
      if (state.editing?.id) {
        try { saved = await apiJSON(`/api/atendimento/clientes/departamentos/${state.editing.id}`, 'PUT', payload); }
        catch { saved = await apiJSON(`/api/departamentos/${state.editing.id}`, 'PUT', payload); }
        const id = Number(saved?.id || state.editing.id);
        if ((state.modalMode || 'members') === 'members') {
          await saveDepartamentoMembros(id, getMembrosSelecionados());
        }
        state.selectedId = id;
        toast('Departamento atualizado.');
      } else {
        try { saved = await apiJSON('/api/atendimento/clientes/departamentos', 'POST', payload); }
        catch { saved = await apiJSON('/api/departamentos', 'POST', payload); }
        const id = Number(saved?.id || 0);
        if (id) {
          if ((state.modalMode || 'members') === 'members') {
            await saveDepartamentoMembros(id, getMembrosSelecionados());
          }
          state.selectedId = id;
        }
        toast('Departamento criado.');
      }
      closeModal();
      state.orgTouched = false;
      await loadTree();
    } catch (e) {
      console.error(e);
      toast(e?.data?.detail || e?.data?.message || e?.message || 'Erro ao salvar.', 'err');
    } finally {
      Loader.hide();
    }
  }

  async function patchMove(id, newParentId){
    const body = { new_parent_id: newParentId ?? null, parent_id: newParentId ?? null };
    try { await apiJSON(`/api/atendimento/clientes/departamentos/${id}`, 'PATCH', body); return; }
    catch {}
    try { await apiJSON(`/api/atendimento/clientes/departamentos/${id}/move`, 'PATCH', body); return; }
    catch {}
    await apiJSON(`/api/departamentos/${id}/move`, 'PATCH', body);
  }

  async function deleteDepto(id){
    if (!id) return toast('Departamento inválido.', 'err');
    if (!confirm('Remover este departamento? Os subdepartamentos sobem um nível.')) return;
    try {
      Loader.show('Removendo...');
      let lastError = null;
      let removed = false;
      for (const url of [`/api/atendimento/clientes/departamentos/${id}`, `/api/departamentos/${id}`]) {
        try { await apiJSON(url, 'DELETE'); removed = true; break; }
        catch (err) {
          lastError = err;
          if (![404, 405].includes(Number(err?.status || 0))) break;
        }
      }
      if (!removed) throw lastError || new Error('Erro ao remover.');
      if (Number(state.selectedId) === Number(id)) state.selectedId = 0;
      toast('Departamento removido.');
      await loadTree();
    } catch (e) {
      console.error(e);
      toast(e?.data?.detail || e?.data?.message || e?.message || 'Erro ao remover.', 'err');
    } finally {
      Loader.hide();
    }
  }

  function bindActions(){
    btnAdd?.addEventListener('click', () => openModalNovo());
    btnExpand?.addEventListener('click', () => {
      state.flat.forEach(d => state.expanded.add(Number(d.id)));
      state.orgTouched = false;
      renderOrg();
    });
    btnCollapse?.addEventListener('click', () => {
      state.expanded.clear();
      state.orgTouched = false;
      renderOrg();
    });
    filtro?.addEventListener('input', debounce(() => {
      state.q = filtro.value.trim();
      state.orgTouched = false;
      renderOrg();
    }, 160));
    zoomIn?.addEventListener('click', () => zoomAt((state.zoom || 1) * 1.15));
    zoomOut?.addEventListener('click', () => zoomAt((state.zoom || 1) / 1.15));
    zoomReset?.addEventListener('click', resetStage);

    btnX?.addEventListener('click', closeModal);
    btnCancel?.addEventListener('click', closeModal);
    modalHelpToggle?.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!modalHelpPopover?.hidden && modalHelpPopover?.dataset.key === currentStepHelpKey()) closeHelpPopover();
      else openHelpPopover(modalHelpToggle, currentStepHelpKey());
    });
    btnBack?.addEventListener('click', () => setModalStep(state.modalStep - 1));
    btnNext?.addEventListener('click', async () => {
      if (!validateStep(state.modalStep)) return;
      const nextStep = state.modalStep + 1;
      if (nextStep === 2) {
        try {
          Loader.show('Carregando configurações...');
          await ensureModalListsReady(state.editing?.id || null);
        } finally {
          Loader.hide();
        }
      }
      setModalStep(nextStep);
    });
    btnSave?.addEventListener('click', saveDepto);
    modal?.addEventListener('mousedown', ev => {
      const card = modal.querySelector('.modal-card');
      if (card && !card.contains(ev.target)) closeModal();
    });
    modal?.querySelector('.modal-card')?.addEventListener('mousedown', ev => ev.stopPropagation());

    parentEdit?.addEventListener('click', () => toggleParentPanel());
    inpNome?.addEventListener('input', renderWizardPreview);
    txtDesc?.addEventListener('input', renderWizardPreview);
    chkAtivo?.addEventListener('change', renderWizardPreview);
    selParent?.addEventListener('change', () => { setParentUi(); renderWizardPreview(); });
    chkUsarHorarioGeral?.addEventListener('change', () => {
      if (chkUsarHorarioGeral.checked) {
        if (inpHoraInicio) inpHoraInicio.value = '';
        if (inpHoraFim) inpHoraFim.value = '';
      }
      syncDisponibilidadeUi();
      renderWizardPreview();
    });
    inpHoraInicio?.addEventListener('input', () => { if (chkUsarHorarioGeral && hasHorarioPersonalizado()) chkUsarHorarioGeral.checked = false; syncDisponibilidadeUi(); renderWizardPreview(); });
    inpHoraFim?.addEventListener('input', () => { if (chkUsarHorarioGeral && hasHorarioPersonalizado()) chkUsarHorarioGeral.checked = false; syncDisponibilidadeUi(); renderWizardPreview(); });

    membrosSearch?.addEventListener('input', debounce(renderMembrosList, 120));
    membrosToggle?.addEventListener('click', () => {
      if (!membrosPanel) return;
      membrosPanel.hidden = !membrosPanel.hidden;
      if (membrosToggle) membrosToggle.textContent = membrosPanel.hidden ? 'Gerenciar' : 'Fechar';
      if (!membrosPanel.hidden) setTimeout(() => membrosSearch?.focus(), 30);
    });
    instanciasAll?.addEventListener('click', () => {
      state.instancias.forEach(i => state.instanciasSelecionadas.add(Number(i.id)));
      renderInstanciasList();
      renderWizardPreview();
    });
    instanciasClear?.addEventListener('click', () => {
      state.instanciasSelecionadas.clear();
      renderInstanciasList();
      renderWizardPreview();
    });
    membrosAll?.addEventListener('click', () => {
      state.colaboradores.forEach(c => state.membrosSelecionados.add(Number(c.id)));
      renderMembrosList();
      renderWizardPreview();
    });
    membrosClear?.addEventListener('click', () => {
      state.membrosSelecionados.clear();
      renderMembrosList();
      renderWizardPreview();
    });

    document.addEventListener('click', ev => {
      const actionBtn = ev.target.closest('[data-action]');
      if (actionBtn) {
        const action = actionBtn.dataset.action;
        const id = Number(actionBtn.dataset.id || 0);
        const item = findDept(id);

        if (action === 'menu') {
          ev.preventDefault();
          ev.stopPropagation();
          state.openMenuId = null;
          state.sideMenuOpen = !state.sideMenuOpen;
          renderSidePanel();
          return;
        }

        state.openMenuId = null;
        state.sideMenuOpen = false;
        if (action === 'edit' && item) openModalEditar(item, 1);
        else if (action === 'add-child') openModalNovo(id || null, 1);
        else if (action === 'members') {
          if (item) openModalEditar(item, 2, 'members');
          else openModalNovo(null, 2, 'members');
        }
        else if (action === 'schedule' && item) openModalEditar(item, 2, 'schedule');
        else if (action === 'instances' && item) openModalEditar(item, 2, 'instances');
        else if (action === 'transfer' && item) openModalEditar(item, 1);
        else if (action === 'del') deleteDepto(id);
        else if (action === 'fit') resetStage();
        else if (action === 'invite') toast('Convite fica para a tela de colaboradores. Aqui deixei apenas o atalho visual para facilitar.', 'warn');
        renderSidePanel();
        renderOrg();
        return;
      }
      if (!ev.target.closest('.org-action-menu,.org-menu-btn')) {
        if (state.openMenuId !== null) {
          state.openMenuId = null;
          renderOrg();
        }
      }
      if (!ev.target.closest('.side-action-menu,.side-icons')) {
        if (state.sideMenuOpen) {
          state.sideMenuOpen = false;
          renderSidePanel();
        }
      }
      const helpBtn = ev.target.closest('.field-help-icon');
      if (helpBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const key = helpBtn.dataset.helpKey || currentStepHelpKey();
        if (!modalHelpPopover?.hidden && modalHelpPopover?.dataset.key === key) closeHelpPopover();
        else openHelpPopover(helpBtn, key);
        return;
      }
      if (!ev.target.closest('#modal-help-popover') && !ev.target.closest('.field-help-icon') && !ev.target.closest('#modal-help-toggle')) closeHelpPopover();
      if (!ev.target.closest('.parent-fi')) toggleParentPanel(false);
    });

    window.addEventListener('resize', debounce(() => {
      state.orgTouched = false;
      renderOrg();
    }, 180), { passive: true });
  }

  function cacheEls(){
    filtro = $('#filtro');
    btnAdd = $('#btn-add');
    btnExpand = $('#btn-expand');
    btnCollapse = $('#btn-collapse');
    orgContainer = $('#org-container');
    sidePanel = $('#dept-side-panel');
    zoomOut = $('#org-zoom-out');
    zoomIn = $('#org-zoom-in');
    zoomReset = $('#org-zoom-reset');
    zoomLabel = $('#org-zoom-label');
    toastEl = $('#toast');

    modal = $('#modal-depto');
    modalTitle = $('#modal-title');
    modalStepLabel = $('#modal-step-label');
    modalProgress = $('.modal-progress');
    modalHelpToggle = $('#modal-help-toggle');
    modalHelpPopover = $('#modal-help-popover');
    modalHelpPopoverContent = $('#modal-help-popover-content');
    btnX = $('#modal-fechar');
    btnBack = $('#modal-voltar');
    btnNext = $('#modal-avancar');
    btnSave = $('#modal-salvar');
    btnCancel = $('#modal-cancelar');
    form = $('#form-depto');
    inpId = $('[name="id"]', form);
    inpNome = $('#d-nome');
    txtDesc = $('#d-desc');
    inpCodigo = $('#d-codigo');
    chkAtivo = $('#d-ativo');
    inpHoraInicio = $('#d-hora-inicio');
    inpHoraFim = $('#d-hora-fim');
    chkUsarHorarioGeral = $('#d-usar-horario-geral');
    selParent = $('#d-parent');
    parentChip = $('#parent-chip');
    parentEdit = $('#parent-edit');
    parentPanel = $('#parent-panel');
    membrosSearch = $('#d-membros-search');
    membrosList = $('#d-membros-list');
    membrosCount = $('#d-membros-count');
    membrosAll = $('#d-membros-all');
    membrosClear = $('#d-membros-clear');
    membrosToggle = $('#d-membros-toggle');
    membrosPanel = $('#d-membros-panel');
    membrosSummary = $('#d-membros-summary');
    instanciasList = $('#d-instancias-list');
    instanciasCount = $('#d-instancias-count');
    instanciasAll = $('#d-instancias-all');
    instanciasClear = $('#d-instancias-clear');
  }

  async function boot(){
    cacheEls();
    bindActions();
    setModalStep(1);
    renderSidePanel(true);
    await loadEmpresaName();
    await loadTree();
    releasePageLoader();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  setTimeout(releasePageLoader, 400);
  setTimeout(releasePageLoader, 1200);
  setTimeout(releasePageLoader, 2600);
})();
