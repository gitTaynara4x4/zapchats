// frontend/js/pages/colaboradores/departamentos.js

import { state } from './state.js';
import { apiGet, apiJSON } from './api.js';
import { chip, normStr } from './helpers.js';

function normalizeDepartamentos(data){
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.results)
          ? data.results
          : [];

  const out = [];
  const seen = new Set();

  function getId(x){
    return (
      x?.id ??
      x?.departamento_id ??
      x?.dep_id ??
      x?.depto_id ??
      x?.setor_id ??
      x?.value ??
      x?.ID ??
      x?.Id
    );
  }

  function getName(x){
    return (
      x?.nome ??
      x?.name ??
      x?.titulo ??
      x?.label ??
      x?.text ??
      'Departamento'
    );
  }

  function getPath(x){
    if (Array.isArray(x?.path)) {
      return x.path.map(v => String(v || '').trim()).filter(Boolean);
    }

    if (typeof x?.path === 'string') {
      return x.path
        .split(/\s*(?:>|\/|\u203A)\s*/g)
        .map(v => String(v || '').trim())
        .filter(Boolean);
    }

    if (Array.isArray(x?.path_parts)) {
      return x.path_parts.map(v => String(v || '').trim()).filter(Boolean);
    }

    return [];
  }

  function getChildren(x){
    return (
      x?.filhos ??
      x?.children ??
      x?.itens ??
      x?.items ??
      x?.nodes ??
      x?.departamentos ??
      x?.subdepartamentos ??
      x?.sub ??
      []
    );
  }

  function walk(node, level = 0){
    if (!node) return;

    const idRaw = getId(node);
    const id = Number(idRaw);

    if (Number.isFinite(id) && id > 0 && !seen.has(id)) {
      seen.add(id);

      const nome = String(getName(node) || '').trim() || `Departamento ${id}`;
      const path = getPath(node);

      out.push({
        id,
        nome,
        path,
        level,
        ativo: node?.ativo ?? node?.active ?? true
      });
    }

    const kids = getChildren(node);
    if (Array.isArray(kids)) {
      kids.forEach(child => walk(child, level + 1));
    }
  }

  raw.forEach(item => walk(item, 0));

  out.sort((a, b) => {
    const pa = (a.path?.length ? a.path.join(' / ') : a.nome).toLowerCase();
    const pb = (b.path?.length ? b.path.join(' / ') : b.nome).toLowerCase();
    return pa.localeCompare(pb, 'pt-BR');
  });

  return out;
}

export async function fetchDepartamentos(force = false){
  if (!force && Array.isArray(state.departamentosCache)) {
    return state.departamentosCache;
  }

  const tries = [
    '/api/departamentos/tree',
    '/api/atendimento/clientes/departamentos/tree',
    '/api/departamentos',
    '/api/atendimento/clientes/departamentos'
  ];

  let lastErr = null;

  for (const url of tries){
    try {
      const data = await apiGet(url);
      const arr = normalizeDepartamentos(data);

      if (arr.length) {
        state.departamentosCache = arr;
        return arr;
      }
    } catch (e) {
      lastErr = e;
    }
  }

  console.warn('[colaboradores/departamentos] não carregou departamentos', lastErr);
  state.departamentosCache = [];
  return [];
}

export function coalesceDepartamentosIds(colab){
  const raw =
    colab?.departamentos_ids ??
    colab?.departamento_ids ??
    colab?.deptos_ids ??
    colab?.depts_ids ??
    colab?.departamentos ??
    colab?.departments ??
    null;

  const out = [];
  const seen = new Set();

  function add(v){
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  }

  if (Array.isArray(raw)) {
    raw.forEach(item => {
      if (item && typeof item === 'object') {
        add(
          item.id ??
          item.departamento_id ??
          item.dep_id ??
          item.depto_id ??
          item.value
        );
      } else {
        add(item);
      }
    });
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        parsed.forEach(add);
      } else {
        String(raw)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .forEach(add);
      }
    } catch {
      raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(add);
    }
  }

  const setorId =
    colab?.setor_id ??
    colab?.departamento_id ??
    colab?.dep_id ??
    colab?.depto_id ??
    null;

  if (!out.length && setorId != null) {
    add(setorId);
  }

  return out;
}

function labelDepto(d){
  if (!d) return 'Departamento';

  if (Array.isArray(d.path) && d.path.length) {
    return d.path.join(' / ');
  }

  return d.nome || `Departamento ${d.id}`;
}

export async function renderDepartamentosView(colab){
  const dWrap = document.querySelector('#d-deptos');
  const eWrap = document.querySelector('#e-deptos');
  const actions = document.querySelector('#dept-actions');

  if (!dWrap && !eWrap) return;

  const deps = await fetchDepartamentos();
  const selected = new Set(coalesceDepartamentosIds(colab).map(Number));

  if (eWrap) {
    eWrap.style.display = 'none';
    eWrap.innerHTML = '';
  }

  if (actions) {
    actions.style.display = 'none';
  }

  if (!dWrap) return;

  dWrap.innerHTML = '';

  if (!selected.size) {
    dWrap.textContent = 'Nenhum departamento selecionado.';
    return;
  }

  const byId = new Map(deps.map(d => [Number(d.id), d]));

  selected.forEach(id => {
    const dep = byId.get(Number(id));

    if (dep) {
      dWrap.appendChild(chip(labelDepto(dep)));
    } else {
      dWrap.appendChild(chip(`Departamento ${id}`));
    }
  });
}

function makeDeptCheckbox(dep, selectedSet){
  const label = document.createElement('label');
  label.className = 'chk-line';
  label.style.alignItems = 'flex-start';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = 'dept-edit';
  input.value = String(dep.id);
  input.checked = selectedSet.has(Number(dep.id));

  const span = document.createElement('span');

  const strong = document.createElement('strong');
  strong.textContent = labelDepto(dep);

  const small = document.createElement('span');
  small.className = 'muted';
  small.style.display = 'block';
  small.style.fontSize = '.84rem';
  small.style.marginTop = '2px';

  if (dep.ativo === false) {
    small.textContent = 'Inativo';
  } else {
    small.textContent = 'Pode atender conversas deste departamento';
  }

  span.appendChild(strong);
  span.appendChild(small);

  label.appendChild(input);
  label.appendChild(span);

  return label;
}

export async function ensureDepartamentosEdit(){
  const eWrap = document.querySelector('#e-deptos');
  const dWrap = document.querySelector('#d-deptos');
  const actions = document.querySelector('#dept-actions');
  const btnAll = document.querySelector('#dept-select-all');
  const btnClear = document.querySelector('#dept-clear');

  if (!eWrap) return;

  const deps = await fetchDepartamentos();
  const selected = new Set(coalesceDepartamentosIds(state.viewing).map(Number));

  eWrap.innerHTML = '';

  if (!deps.length) {
    eWrap.style.display = 'block';
    eWrap.innerHTML = `
      <div class="muted" style="padding:.5rem 0">
        Nenhum departamento cadastrado.
      </div>
    `;
    if (dWrap) dWrap.style.display = 'none';
    if (actions) actions.style.display = 'none';
    return;
  }

  deps.forEach(dep => {
    eWrap.appendChild(makeDeptCheckbox(dep, selected));
  });

  eWrap.style.display = 'grid';

  if (dWrap) {
    dWrap.style.display = 'none';
  }

  if (actions) {
    actions.style.display = 'flex';
  }

  if (btnAll) {
    btnAll.onclick = () => {
      eWrap
        .querySelectorAll('input[name="dept-edit"]')
        .forEach(input => {
          input.checked = true;
        });
    };
  }

  if (btnClear) {
    btnClear.onclick = () => {
      eWrap
        .querySelectorAll('input[name="dept-edit"]')
        .forEach(input => {
          input.checked = false;
        });
    };
  }
}

export function getDepartamentosSelecionadosEdit(){
  return [...document.querySelectorAll('#e-deptos input[name="dept-edit"]:checked')]
    .map(input => Number(input.value))
    .filter(n => Number.isFinite(n) && n > 0);
}

export async function saveDepartamentos(id, departamentosIds){
  const colabId = Number(id);
  if (!Number.isFinite(colabId) || colabId <= 0) {
    throw new Error('ID do colaborador inválido');
  }

  const ids = Array.isArray(departamentosIds)
    ? departamentosIds.map(Number).filter(n => Number.isFinite(n) && n > 0)
    : [];

  const resp = await apiJSON(`/api/colaboradores/${colabId}/departamentos`, 'PUT', {
    departamentos_ids: ids
  });

  return resp;
}

export function getDepartamentoPrincipalSelecionado(){
  const ids = getDepartamentosSelecionadosEdit();
  if (ids.length) return ids[0];

  const eSetor = document.querySelector('#e-setor');
  const n = Number(eSetor?.value || 0);

  return Number.isFinite(n) && n > 0 ? n : null;
}