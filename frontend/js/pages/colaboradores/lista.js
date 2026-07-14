// frontend/js/pages/colaboradores/lista.js

import { state, EDIT_PERM } from './state.js';
import { apiGet, authFetch, withEmpresa, parseMaybeJSON, throwHTTP } from './api.js';
import { els, $ } from './dom.js';
import { debounce, normStr } from './helpers.js';
import {
  coalesceName,
  coalesceEmail,
  coalescePhone,
  coalesceCargo,
  coalesceDeptId,
  coalesceDeptName
} from './coalesce.js';
import { invalidateAvatarThumb, mountMiniAvatarInto } from './avatar.js';
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

function escapeHTML(value){
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeMailto(email){
  const s = String(email || '').trim();
  if (!s || s === '-') return '#';
  return 'mailto:' + encodeURIComponent(s);
}

function handleFrom(name, email){
  const raw = String(email || '').split('@')[0] || String(name || 'colaborador');
  const cleaned = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '')
    .slice(0, 24);

  return '@' + (cleaned || 'colaborador');
}

function isInactive(c){
  const raw = String(c?.status || c?.situacao || '').trim().toLowerCase();

  return (
    c?.ativo === false ||
    c?.active === false ||
    c?.bloqueado === true ||
    c?.disabled === true ||
    c?.inativo === true ||
    raw === 'offline' ||
    raw === 'inativo' ||
    raw === 'bloqueado' ||
    raw === 'disabled'
  );
}

function statusInfo(c){
  if (isInactive(c)) {
    return { label:'Offline', cls:'offline' };
  }

  if (c?.troca_senha_pendente) {
    return { label:'Trocar senha', cls:'warn' };
  }

  if (c?.convite_pendente) {
    return { label:'Convite pendente', cls:'warn' };
  }

  if (c?.tem_usuario === false) {
    return { label:'Sem login', cls:'warn' };
  }

  return { label:'Ativo', cls:'active' };
}

function setorNameById(id){
  const sid = String(id ?? '');
  if (!sid) return '';

  return state.setores.find(s => String(s.id) === sid)?.nome || '';
}

function teamTagsFor(c){
  const out = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (!s || s === '-') return;
    if (!out.some(x => normStr(x) === normStr(s))) out.push(s);
  };

  add(coalesceDeptName(c) || setorNameById(coalesceDeptId(c)));

  if (Array.isArray(c?.departamentos_ids)) {
    c.departamentos_ids.forEach(id => add(setorNameById(id)));
  }

  if (c?.is_admin) add('Admin');

  if (!out.length) out.push('Sem departamento');

  return out;
}

function filteredRows(){
  const q = (state.filtroTexto || '').toLowerCase();
  const depId = String(state.filtroSetorId || '');

  const depSelName = depId
    ? (state.setores.find(s => String(s.id) === depId)?.nome || '')
    : '';

  const depSelNorm = depSelName ? normStr(depSelName) : '';

  return state.colaboradores
    .filter(c => {
      if (!q) return true;

      const name = coalesceName(c);
      const email = coalesceEmail(c);
      const phone = coalescePhone(c);
      const cargo = coalesceCargo(c);
      const depto = teamTagsFor(c).join(' ');

      return [name, email, phone, cargo, depto]
        .some(v => String(v || '').toLowerCase().includes(q));
    })
    .filter(c => {
      if (!depId) return true;

      const cid = String(coalesceDeptId(c) ?? '');

      if (cid && cid === depId) return true;

      if (Array.isArray(c?.departamentos_ids) && c.departamentos_ids.some(id => String(id) === depId)) {
        return true;
      }

      const cn =
        coalesceDeptName(c) ||
        state.setores.find(s => String(s.id) === cid)?.nome ||
        '';

      if (cn && depSelNorm) return normStr(cn) === depSelNorm;

      return false;
    });
}

function syncSelectAllState(){
  const selectAll = $('#colab-select-all');
  const checks = Array.from(document.querySelectorAll('#tabela-colaboradores .row-select'));
  const checked = checks.filter(c => c.checked);

  if (selectAll) {
    selectAll.checked = checks.length > 0 && checked.length === checks.length;
    selectAll.indeterminate = checked.length > 0 && checked.length < checks.length;
  }

  const selectedEl = $('#overview-colab-selected');
  if (selectedEl) selectedEl.textContent = checked.length;

  const selectedStatEl = $('#stat-colab-selected');
  if (selectedStatEl) selectedStatEl.textContent = checked.length;
}

export function renderLista(){
  const { tbody, emptyState, countEl } = els();
  const rows = filteredRows();

  if (countEl) countEl.textContent = rows.length;

  const activeCount = rows.filter(c => statusInfo(c).cls === 'active').length;
  const pendingCount = Math.max(0, rows.length - activeCount);

  const statTotal = $('#stat-colab-total');
  if (statTotal) statTotal.textContent = rows.length;

  const statActive = $('#stat-colab-active');
  if (statActive) statActive.textContent = activeCount;

  const statPending = $('#stat-colab-pending');
  if (statPending) statPending.textContent = pendingCount;

  const securityText = $('#stat-security-text');
  if (securityText) securityText.textContent = $('#chk-requer-token')?.checked ? 'Código ativo' : 'Segurança extra';

  const overviewTotal = $('#overview-colab-total');
  if (overviewTotal) overviewTotal.textContent = rows.length;

  const overviewFilter = $('#overview-colab-filter');
  if (overviewFilter) {
    const depId = String(state.filtroSetorId || '');
    const depName = depId
      ? (state.setores.find(s => String(s.id) === depId)?.nome || 'Filtrado')
      : 'Todos';
    overviewFilter.textContent = depName;
  }

  if (tbody) tbody.innerHTML = '';

  if (!rows.length){
    if (emptyState) emptyState.style.display = 'flex';
    syncSelectAllState();
    return;
  }

  if (emptyState) emptyState.style.display = 'none';

  rows.forEach((c) => {
    const name = coalesceName(c) || '-';
    const email = coalesceEmail(c) || '-';
    const cargo = coalesceCargo(c) || '';
    const id = c?.id ?? '';
    const status = statusInfo(c);
    const teams = teamTagsFor(c);

    const tr = document.createElement('tr');
    tr.dataset.id = String(id || '');

    const teamHTML = teams.slice(0, 4).map((team, idx) => {
      const tone = team === 'Sem departamento' ? 'tone-muted' : `tone-${(idx % 4) + 1}`;
      return `<span class="team-chip ${tone}">${escapeHTML(team)}</span>`;
    }).join('');

    const extraTeams = teams.length > 4
      ? `<span class="team-chip tone-muted">+${teams.length - 4}</span>`
      : '';

    tr.innerHTML = `
      <td class="check-col">
        <input class="row-select" type="checkbox" aria-label="Selecionar ${escapeHTML(name)}">
      </td>
      <td>
        <div class="member-cell">
          <div class="td-avatar"></div>
          <div class="member-copy">
            <span class="member-name" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
            <span class="member-user" title="${escapeHTML(cargo || handleFrom(name, email))}">${escapeHTML(handleFrom(name, email))}</span>
          </div>
        </div>
      </td>
      <td>
        <span class="status-pill ${escapeHTML(status.cls)}">${escapeHTML(status.label)}</span>
      </td>
      <td>
        <a class="email-link" href="${safeMailto(email)}" title="${escapeHTML(email)}">${escapeHTML(email)}</a>
      </td>
      <td>
        <div class="team-tags">${teamHTML}${extraTeams}</div>
      </td>
      <td class="td-actions">
        <button class="btn btn-ghost" data-action="view" data-id="${escapeHTML(id)}" title="Editar perfil" aria-label="Editar ${escapeHTML(name)}">
          <i class="fa fa-pen"></i>
        </button>
        <button class="btn btn-ghost" data-action="del" data-id="${escapeHTML(id)}" title="Remover" aria-label="Remover ${escapeHTML(name)}">
          <i class="fa fa-trash"></i>
        </button>
      </td>
    `.trim();

    tbody.appendChild(tr);

    const tdAv = tr.querySelector('.td-avatar');
    mountMiniAvatarInto(tdAv, c);
  });

  syncSelectAllState();
}

function exportCSV(){
  const rows = filteredRows();

  if (!rows.length){
    toast('Nenhum colaborador para exportar.', 'warn');
    return;
  }

  const header = ['Nome', 'E-mail', 'Status', 'Cargo', 'Departamentos'];
  const lines = [header, ...rows.map(c => {
    const st = statusInfo(c);
    return [
      coalesceName(c) || '',
      coalesceEmail(c) || '',
      st.label,
      coalesceCargo(c) || '',
      teamTagsFor(c).join(' | ')
    ];
  })];

  const csv = lines.map(line => line.map(value => {
    const s = String(value ?? '');
    return /[";,\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\n');

  const blob = new Blob(['\ufeff' + csv], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);

  a.href = url;
  a.download = `colaboradores-${date}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1200);
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

  $('#btn-export-colaboradores')?.addEventListener('click', exportCSV);

  $('#colab-select-all')?.addEventListener('change', e => {
    const checked = !!e.currentTarget.checked;
    document.querySelectorAll('#tabela-colaboradores .row-select').forEach(cb => {
      cb.checked = checked;
    });
    syncSelectAllState();
  });

  document.addEventListener('change', e => {
    if (e.target?.matches?.('#tabela-colaboradores .row-select')) {
      syncSelectAllState();
    }
  }, { capture:true });

  if (chkRequerToken){
    chkRequerToken.addEventListener('change', () => {
      const securityText = $('#stat-security-text');
      if (securityText) securityText.textContent = chkRequerToken.checked ? 'Código ativo' : 'Segurança extra';
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
