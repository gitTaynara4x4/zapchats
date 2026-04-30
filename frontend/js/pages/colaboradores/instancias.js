// frontend/js/pages/colaboradores/instancias.js

import { state, EMPRESA_ID } from './state.js';
import { apiGet, apiJSON } from './api.js';
import { els } from './dom.js';
import { chip } from './helpers.js';

export async function fetchInstances(){
  if (state.instsCache) return state.instsCache;

  let arr = [];

  if (EMPRESA_ID){
    try {
      const data = await apiGet(`/api/empresas/${EMPRESA_ID}/whatsapp`);

      const normInstances = items => {
        if (!Array.isArray(items)) return [];

        return items.map(x => {
          const id = x.id != null
            ? Number(x.id)
            : (x.instancia_id != null ? Number(x.instancia_id) : null);

          const slug = String(x.instance_name ?? x.slug ?? x.nome ?? '').trim();
          const name = String((x.apelido ?? x.name ?? x.nome ?? slug) || '').trim();
          const number = x.numero_instancia ?? x.numero ?? null;
          const connected = !!x.connected || !!x.online || (String(x.status || '').toLowerCase() === 'connected');

          return (id || slug)
            ? { id, slug, name: name || slug, number, connected }
            : null;
        }).filter(Boolean);
      };

      arr = normInstances(
        Array.isArray(data?.instancias)
          ? data.instancias
          : (Array.isArray(data) ? data : [])
      );
    } catch (e) {
      console.warn('[colaboradores] falha ao buscar instâncias', e);
    }
  }

  state.instsCache = arr;

  return arr;
}

export function coalesceInstIds(c){
  const raw =
    c?.instancias_ids ??
    c?.instances_ids ??
    c?.whatsapp_instancias_ids ??
    c?.whatsapp_ids ??
    c?.whatsapps_ids ??
    c?.instancias ??
    c?.instances ??
    null;

  if (!raw) return [];

  if (Array.isArray(raw)){
    if (raw.length && typeof raw[0] === 'object'){
      return raw
        .map(x => Number(x.id ?? x.instancia_id ?? x.instance_id ?? x.value))
        .filter(n => !Number.isNaN(n));
    }

    return raw
      .map(x => Number(x))
      .filter(n => !Number.isNaN(n));
  }

  if (typeof raw === 'string'){
    try {
      const arr = JSON.parse(raw);

      if (Array.isArray(arr)) {
        return arr.map(Number).filter(n => !Number.isNaN(n));
      }
    } catch {}

    return raw
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => !Number.isNaN(n));
  }

  return [];
}

export function getInstsSelecionadasEdit(){
  return [...document.querySelectorAll('#e-insts input[name="inst-edit"]:checked')]
    .map(i => Number(i.value))
    .filter(n => !Number.isNaN(n));
}

export async function saveInsts(id, ids){
  try {
    await apiJSON(`/api/colaboradores/${id}/instancias`, 'PUT', {
      instancias_ids: ids
    });

    return true;
  } catch (e1) {
    try {
      await apiJSON(`/api/colaboradores/${id}`, 'PUT', {
        instancias_ids: ids
      });

      return true;
    } catch (e2) {
      try {
        await apiJSON(`/api/colaboradores/${id}/whatsapp`, 'PUT', {
          instancias_ids: ids
        });

        return true;
      } catch (e3) {
        console.warn('falha ao salvar instancias', e1, e2, e3);
        return false;
      }
    }
  }
}

export function ensureInstsSection(){
  let full = document.getElementById('insts-full');

  if (!full){
    const { dPerms, ePerms } = els();

    full = document.createElement('div');
    full.id = 'insts-full';
    full.className = 'full';

    full.innerHTML = `
      <dt>WhatsApps</dt>
      <dd>
        <div id="insts-wrap" class="fieldbox">
          <div class="inst-title-line">
            <span>Quais WhatsApps este atendente pode acessar?</span>
            <span class="muted">(se não marcar nenhum, ele vê todos)</span>
          </div>

          <div id="inst-actions" style="display:none">
            <button type="button" id="inst-select-all" class="btn btn-ghost">Selecionar todos</button>
            <button type="button" id="inst-clear" class="btn btn-ghost">Limpar</button>
          </div>

          <div id="e-insts" style="display:none"></div>
          <div id="d-insts" class="chips"></div>
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

export async function renderInstsView(colab){
  const wrap = ensureInstsSection();
  if (!wrap) return;

  const chipsWrap = wrap.querySelector('#d-insts');
  const editGrid = wrap.querySelector('#e-insts');
  const actions = wrap.querySelector('#inst-actions');

  if (actions) actions.style.display = 'none';
  if (editGrid) editGrid.style.display = 'none';

  if (chipsWrap){
    chipsWrap.style.display = 'flex';
    chipsWrap.innerHTML = '';
  }

  const ids = coalesceInstIds(colab);

  if (!ids.length){
    if (chipsWrap) chipsWrap.textContent = 'Todas';
    return;
  }

  const items = await fetchInstances();

  ids.forEach(id => {
    const obj = items.find(x => Number(x.id) === Number(id));

    const lbl = obj
      ? `${obj.name || obj.slug}${obj.number ? ' • ' + obj.number : ''}`
      : `#${id}`;

    chipsWrap?.appendChild(chip(lbl));
  });
}

export async function ensureInstsEdit(){
  const wrap = ensureInstsSection();
  if (!wrap) return;

  const chipsWrap = wrap.querySelector('#d-insts');
  const editGrid = wrap.querySelector('#e-insts');
  const actions = wrap.querySelector('#inst-actions');

  if (chipsWrap) chipsWrap.style.display = 'none';

  if (editGrid){
    editGrid.style.display = 'grid';
    editGrid.innerHTML = '<div class="muted">Carregando instâncias…</div>';
  }

  if (actions) actions.style.display = 'flex';

  const items = await fetchInstances();

  if (!editGrid) return;

  editGrid.innerHTML = '';

  const current = new Set(coalesceInstIds(state.viewing).map(String));

  if (!items.length){
    editGrid.innerHTML = '<div class="muted">Nenhuma instância encontrada.</div>';
  } else {
    items.sort((a,b) => {
      if (a.connected === b.connected) {
        return String(a.name).localeCompare(String(b.name), 'pt-BR');
      }

      return a.connected ? -1 : 1;
    });

    items.forEach(i => {
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

      if (cb && current.has(String(i.id))) {
        cb.checked = true;
      }

      editGrid.appendChild(lab);
    });
  }

  const selectAllBtn = wrap.querySelector('#inst-select-all');
  const clearBtn = wrap.querySelector('#inst-clear');

  if (selectAllBtn){
    selectAllBtn.onclick = () => {
      editGrid.querySelectorAll('input[name="inst-edit"]').forEach(cb => {
        cb.checked = true;
      });
    };
  }

  if (clearBtn){
    clearBtn.onclick = () => {
      editGrid.querySelectorAll('input[name="inst-edit"]').forEach(cb => {
        cb.checked = false;
      });
    };
  }
}