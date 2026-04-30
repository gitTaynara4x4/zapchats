// frontend/js/pages/colaboradores/lista.js

import { state, EDIT_PERM } from './state.js';
import { apiGet, authFetch, withEmpresa, parseMaybeJSON, throwHTTP } from './api.js';
import { els } from './dom.js';
import { debounce, normStr, initials, hashColor } from './helpers.js';
import {
  coalesceName,
  coalesceEmail,
  coalescePhone,
  coalesceCargo,
  coalesceDeptId,
  coalesceDeptName
} from './coalesce.js';
import { invalidateAvatarThumb } from './avatar.js';
import { toast, showConfirm } from './feedback.js';
import { hasPerm } from './permissions.js';
import { saveEmpresaLoginConfig } from './empresa.js';

export async function loadColaboradores(){
  const p = new URLSearchParams();

  if (state.filtroTexto) p.set('q', state.filtroTexto);

  const url = '/api/colaboradores' + (p.toString() ? `?${p}` : '');

  try {
    const res = await apiGet(url);
    state.colaboradores = Array.isArray(res) ? res : (res?.items || []);
  } catch (e) {
    console.error('[colaboradores] erro ao carregar colaboradores:', e);
    state.colaboradores = [];
    toast('Erro ao carregar colaboradores.', 'err');
  }
}

function mountMiniAvatarStatic(td, colab){
  if (!td) return;

  const name = coalesceName(colab) || coalesceEmail(colab) || `#${colab?.id || ''}`;

  const wrap = document.createElement('div');
  wrap.className = 'avatar-mini';
  wrap.style.background = hashColor(String(name));

  const span = document.createElement('span');
  span.className = 'avatar-mini-initials';
  span.textContent = initials(name);

  wrap.appendChild(span);

  td.innerHTML = '';
  td.appendChild(wrap);
}

export function renderLista(){
  const { tbody, emptyState, countEl } = els();

  const q = (state.filtroTexto || '').toLowerCase();
  const depId = String(state.filtroSetorId || '');

  const depSelName = depId
    ? (state.setores.find(s => String(s.id) === depId)?.nome || '')
    : '';

  const depSelNorm = depSelName ? normStr(depSelName) : '';

  const rows = state.colaboradores
    .filter(c => {
      if (!q) return true;

      const name = coalesceName(c);
      const email = coalesceEmail(c);
      const phone = coalescePhone(c);
      const cargo = coalesceCargo(c);

      return [name, email, phone, cargo]
        .some(v => String(v || '').toLowerCase().includes(q));
    })
    .filter(c => {
      if (!depId) return true;

      const cid = String(coalesceDeptId(c) ?? '');

      if (cid && cid === depId) return true;

      const cn =
        coalesceDeptName(c) ||
        state.setores.find(s => String(s.id) === cid)?.nome ||
        '';

      if (cn && depSelNorm) return normStr(cn) === depSelNorm;

      return false;
    });

  if (countEl) countEl.textContent = rows.length;
  if (tbody) tbody.innerHTML = '';

  if (!rows.length){
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }

  if (emptyState) emptyState.style.display = 'none';

  rows.forEach((c, i) => {
    const depName =
      coalesceDeptName(c) ||
      state.setores.find(s => String(s.id) === String(coalesceDeptId(c)))?.nome ||
      '-';

    const name = coalesceName(c) || '-';
    const email = coalesceEmail(c) || '-';
    const id = c?.id ?? '';

    const tr = document.createElement('tr');

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td class="td-avatar"></td>
      <td>${name}</td>
      <td>${email}</td>
      <td>${depName}</td>
      <td class="td-actions">
        <button class="btn btn-ghost" data-action="view" data-id="${id}" title="Ver perfil">
          <i class="fa fa-pen"></i>
        </button>
        <button class="btn btn-ghost" data-action="del" data-id="${id}" title="Remover">
          <i class="fa fa-trash"></i>
        </button>
      </td>
    `.trim();

    tbody.appendChild(tr);

    const tdAv = tr.querySelector('.td-avatar');
    mountMiniAvatarStatic(tdAv, c);
  });
}

export function bindLista(){
  if (state.didBindLista) return;
  state.didBindLista = true;

  const {
    filtroTxt,
    filtroDepto,
    btnFiltrar,
    btnAdd,
    chkRequerToken
  } = els();

  filtroTxt?.addEventListener('input', debounce(() => {
    state.filtroTexto = filtroTxt.value.trim();
    renderLista();
  }, 160));

  filtroDepto?.addEventListener('change', () => {
    state.filtroSetorId = filtroDepto.value;
    renderLista();
  });

  btnFiltrar?.addEventListener('click', renderLista);

  btnAdd?.addEventListener('click', async () => {
    const mod = await import('./modal.js');
    mod.openNovo();
  });

  if (chkRequerToken){
    chkRequerToken.addEventListener('change', () => {
      saveEmpresaLoginConfig(chkRequerToken.checked);
    });
  }

  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-action]');
    if (!b) return;

    const raw = b.dataset.id;
    const id = Number(raw);

    if (b.dataset.action === 'view'){
      if (!raw || Number.isNaN(id) || !id){
        toast('ID do colaborador inválido.', 'err');
        return;
      }

      const mod = await import('./modal.js');
      mod.openPerfil(id);
      return;
    }

    if (b.dataset.action === 'del'){
      if (!hasPerm(EDIT_PERM)) {
        toast('Sem permissão para remover.', 'warn');
        return;
      }

      if (!raw || Number.isNaN(id) || !id){
        toast('ID do colaborador inválido.', 'err');
        return;
      }

      const ok = await showConfirm('Remover este colaborador?');
      if (!ok) return;

      try {
        const resp = await authFetch(withEmpresa(`/api/colaboradores/${id}`), {
          method: 'DELETE'
        });

        const data = await parseMaybeJSON(resp);

        if (!resp.ok) throwHTTP(resp, data);

        toast('Removido.');

        invalidateAvatarThumb(id);

        await loadColaboradores();
        renderLista();
      } catch (err) {
        console.error(err);
        toast('Não foi possível remover.', 'err');
      }
    }
  }, { capture:true });
}

export function startPoller(){
  if (state.poller) return;

  state.poller = setInterval(async () => {
    try {
      await loadColaboradores();
      renderLista();
    } catch (e) {
      console.warn('[colaboradores] poller falhou', e);
    }
  }, 60000);
}

export function stopPoller(){
  if (state.poller){
    clearInterval(state.poller);
    state.poller = null;
  }
}