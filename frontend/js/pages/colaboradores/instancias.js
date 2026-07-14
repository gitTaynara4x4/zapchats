// frontend/js/pages/colaboradores/instancias.js

import { state, EMPRESA_ID } from './state.js';
import { apiGet, apiJSON } from './api.js';
import { els } from './dom.js';
import { chip } from './helpers.js';

// Mantém uma fotografia explícita da seleção exibida no modo de visualização.
// Isso evita perder os checks quando a grade de edição é recriada de forma assíncrona.
let lastRenderedInstIds = [];

function normalizeInstIds(values){
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value > 0)
  )];
}

function readStoredInstIds(wrap){
  try {
    const parsed = JSON.parse(wrap?.dataset?.selectedInstIds || '[]');
    return normalizeInstIds(parsed);
  } catch {
    return [];
  }
}

function storeInstIds(wrap, ids){
  const normalized = normalizeInstIds(ids);
  lastRenderedInstIds = normalized;

  if (wrap) {
    wrap.dataset.selectedInstIds = JSON.stringify(normalized);
  }

  return normalized;
}

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
            <span>WhatsApps que este colaborador pode acessar</span>
            <span class="muted">Controle quais números aparecem para ele no atendimento.</span>
          </div>

          <div
            class="muted"
            style="
              display:grid;
              gap:.35rem;
              margin:.55rem 0 .75rem;
              line-height:1.45;
              font-size:.92rem;
            "
          >
            <div>
              Marque os WhatsApps que este colaborador poderá visualizar e atender.
            </div>

            <div>
              Se uma conversa ainda estiver sem departamento, ela só aparece na
              <b>Entrada geral</b> para admin/gestor ou para quem tiver essa liberação.
            </div>

            <div>
              Se nenhum WhatsApp for marcado, este colaborador ficará <b>sem acesso</b>
              aos atendimentos de WhatsApp. Para liberar todos, use “Selecionar todos”.
            </div>
          </div>

          <div id="inst-actions" style="display:none">
            <button type="button" id="inst-select-all" class="btn btn-ghost">Selecionar todos</button>
            <button type="button" id="inst-clear" class="btn btn-ghost">Limpar seleção</button>
          </div>

          <div id="inst-selection-warning" class="muted" hidden
               style="margin:.55rem 0;color:#b45309;font-weight:600;">
            Nenhum WhatsApp selecionado. Este colaborador não verá conversas.
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

    const guideFull = document.getElementById('zc-colab-access-guide');
    const grid = document.querySelector('#details-grid, .details-grid');

    if (permFull && permFull.parentElement){
      permFull.parentElement.insertBefore(full, permFull);
    } else if (guideFull && guideFull.parentElement){
      guideFull.parentElement.insertBefore(full, guideFull.nextSibling);
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
  const selectionWarning = wrap.querySelector('#inst-selection-warning');

  if (selectionWarning) selectionWarning.hidden = true;
  if (actions) actions.style.display = 'none';
  if (editGrid) editGrid.style.display = 'none';

  if (chipsWrap){
    chipsWrap.style.display = 'flex';
    chipsWrap.innerHTML = '';
  }

  const ids = storeInstIds(wrap, coalesceInstIds(colab));

  if (!ids.length){
    if (chipsWrap) chipsWrap.appendChild(chip('Nenhum WhatsApp permitido'));
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

  // Capture a seleção antes de qualquer await. O fallback usa exatamente os IDs
  // que estavam aparecendo como chips no modo de visualização.
  const stateIds = normalizeInstIds(coalesceInstIds(state.viewing));
  const storedIds = readStoredInstIds(wrap);
  const currentIds = stateIds.length
    ? stateIds
    : (storedIds.length ? storedIds : normalizeInstIds(lastRenderedInstIds));
  const current = new Set(currentIds.map(String));

  const items = await fetchInstances();

  if (!editGrid) return;

  editGrid.innerHTML = '';

  const selectionWarning = wrap.querySelector('#inst-selection-warning');

  const updateSelectionWarning = () => {
    if (!editGrid) return;

    const selectedNow = [...editGrid.querySelectorAll('input[name="inst-edit"]:checked')]
      .map(input => Number(input.value));

    storeInstIds(wrap, selectedNow);

    if (selectionWarning) {
      selectionWarning.hidden = selectedNow.length > 0;
    }
  };

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
      lab.className = 'chk-line access-instance-row';

      const safeName = String(i.name || i.slug || 'WhatsApp');
      const safeNumber = String(i.number || 'Número não informado');
      const statusText = i.connected ? 'Online' : 'Offline';
      const statusClass = i.connected ? 'online' : 'offline';

      lab.innerHTML = `
        <input type="checkbox" name="inst-edit" value="${i.id}">
        <span class="access-instance-icon" aria-hidden="true">
          <i class="fa-brands fa-whatsapp"></i>
        </span>
        <span class="access-instance-copy">
          <strong>${safeName}</strong>
          <small>${safeNumber}</small>
        </span>
        <span class="access-instance-status ${statusClass}">
          <span class="access-instance-dot" aria-hidden="true"></span>
          ${statusText}
        </span>
      `;

      const cb = lab.querySelector('input');

      if (cb && current.has(String(i.id))) {
        cb.checked = true;
      }

      cb?.addEventListener('change', updateSelectionWarning);
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

      updateSelectionWarning();
    };
  }

  if (clearBtn){
    clearBtn.onclick = () => {
      editGrid.querySelectorAll('input[name="inst-edit"]').forEach(cb => {
        cb.checked = false;
      });

      updateSelectionWarning();
    };
  }

  updateSelectionWarning();
}