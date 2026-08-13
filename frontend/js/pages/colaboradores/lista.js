// frontend/js/pages/colaboradores/lista.js

import { state, EDIT_PERM, EMPRESA_ID } from './state.js';
import { apiGet, authFetch, withEmpresa, parseMaybeJSON, throwHTTP } from './api.js';
import { els, $ } from './dom.js';
import { debounce, normStr } from './helpers.js';
import {
  coalesceName,
  coalesceEmail,
  coalescePhone,
  coalesceCargo,
  coalesceDeptId,
  coalesceDeptName,
  isAdminFlag
} from './coalesce.js';
import { invalidateAvatarThumb, mountMiniAvatarInto } from './avatar.js?v=colab-avatar-photo-20260810-1';
import { toast, showConfirm } from './feedback.js';
import { hasPerm } from './permissions.js';
import { saveEmpresaLoginConfig } from './empresa.js';


const LIST_SLOW_NOTICE_MS = 4500;
const LIST_CACHE_VERSION = 'v2-avatar-20260809';
const LIST_CACHE_FRESH_MS = 2 * 60 * 1000;
const LIST_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
let listLoading = false;
let listLoadError = null;
let listSlowTimer = null;
let activeLoadId = 0;

function listCacheKey(){
  const empresaId = Number(
    EMPRESA_ID ||
    window.APP_EMPRESA_ID ||
    localStorage.getItem('empresa_id') ||
    0
  );

  const userScope = String(
    localStorage.getItem('usuario_id') ||
    localStorage.getItem('usuario_email') ||
    'usuario'
  ).trim();

  return empresaId
    ? `zc:colaboradores:${LIST_CACHE_VERSION}:empresa:${empresaId}:user:${encodeURIComponent(userScope)}`
    : '';
}

function readListCache(){
  const key = listCacheKey();
  if (!key) return null;

  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const savedAt = Number(parsed?.savedAt || 0);
    const items = Array.isArray(parsed?.items) ? parsed.items : null;
    const ageMs = Date.now() - savedAt;

    if (!items || !savedAt || ageMs < 0 || ageMs > LIST_CACHE_MAX_AGE_MS) {
      sessionStorage.removeItem(key);
      return null;
    }

    return { items, savedAt, ageMs };
  } catch (e) {
    console.warn('[colaboradores/cache] leitura inválida', e);
    try { sessionStorage.removeItem(key); } catch {}
    return null;
  }
}

function writeListCache(items){
  const key = listCacheKey();
  if (!key || !Array.isArray(items)) return;

  try {
    sessionStorage.setItem(key, JSON.stringify({
      savedAt: Date.now(),
      items
    }));
  } catch (e) {
    console.warn('[colaboradores/cache] não foi possível salvar', e);
  }
}

function listUI(){
  return {
    region: document.querySelector('#colab-list-region'),
    loading: document.querySelector('#colab-loading-state'),
    loadingTitle: document.querySelector('#colab-loading-title'),
    loadingDetail: document.querySelector('#colab-loading-detail'),
    error: document.querySelector('#colab-error-state'),
    errorDetail: document.querySelector('#colab-error-detail'),
    selectAll: document.querySelector('#colab-select-all')
  };
}

function loadingRowsHTML(count = 4){
  const row = `
    <tr class="colab-skeleton-row" aria-hidden="true">
      <td class="check-col"><span class="colab-skeleton sk-check"></span></td>
      <td><span class="colab-skeleton sk-member"></span></td>
      <td><span class="colab-skeleton sk-status"></span></td>
      <td><span class="colab-skeleton sk-email"></span></td>
      <td><span class="colab-skeleton sk-teams"></span></td>
      <td><span class="colab-skeleton sk-actions"></span></td>
    </tr>`;
  return Array.from({ length: count }, () => row).join('');
}

function setListStatsLoading(){
  ['#count-colaboradores', '#stat-colab-total', '#stat-colab-active', '#stat-colab-pending', '#overview-colab-total']
    .forEach(selector => {
      const el = document.querySelector(selector);
      if (el) el.textContent = '…';
    });
}

function beginListLoading(){
  listLoading = true;
  listLoadError = null;

  clearTimeout(listSlowTimer);

  const { region, loading, loadingTitle, loadingDetail, error, selectAll } = listUI();
  const { tbody, emptyState } = els();

  region?.classList.add('is-loading');
  region?.classList.remove('has-error');
  region?.setAttribute('aria-busy', 'true');

  if (loading) loading.hidden = false;
  if (error) error.hidden = true;
  if (loadingTitle) loadingTitle.textContent = 'Carregando equipe...';
  if (loadingDetail) loadingDetail.textContent = 'Buscando os colaboradores da empresa.';
  if (emptyState) emptyState.style.display = 'none';
  if (selectAll) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    selectAll.disabled = true;
  }
  if (tbody) tbody.innerHTML = loadingRowsHTML();

  setListStatsLoading();

  listSlowTimer = window.setTimeout(() => {
    if (!listLoading) return;
    const ui = listUI();
    if (ui.loadingTitle) ui.loadingTitle.textContent = 'A equipe ainda está carregando...';
    if (ui.loadingDetail) {
      ui.loadingDetail.textContent = 'A API está demorando mais que o normal, mas o ZapsChat continua tentando.';
    }
  }, LIST_SLOW_NOTICE_MS);
}

function finishListLoading(){
  listLoading = false;
  clearTimeout(listSlowTimer);
  listSlowTimer = null;

  const { region, loading, error, selectAll } = listUI();
  region?.classList.remove('is-loading', 'has-error');
  region?.setAttribute('aria-busy', 'false');
  if (loading) loading.hidden = true;
  if (error) error.hidden = true;
  if (selectAll) selectAll.disabled = false;
}

function failListLoading(error){
  listLoading = false;
  listLoadError = error || new Error('Falha ao carregar colaboradores.');
  clearTimeout(listSlowTimer);
  listSlowTimer = null;

  const { region, loading, error: errorBox, errorDetail, selectAll } = listUI();
  const { tbody, emptyState } = els();

  region?.classList.remove('is-loading');
  region?.classList.add('has-error');
  region?.setAttribute('aria-busy', 'false');
  if (loading) loading.hidden = true;
  if (errorBox) errorBox.hidden = false;
  if (errorDetail) {
    const status = Number(listLoadError?.status || 0);
    errorDetail.textContent = status === 401
      ? 'Sua sessão expirou. Entre novamente e tente carregar a equipe.'
      : 'A lista não foi perdida. Confira a conexão e tente novamente.';
  }
  if (selectAll) selectAll.disabled = !state.colaboradores.length;
  if (emptyState) emptyState.style.display = 'none';
  if (tbody && !state.colaboradores.length) tbody.innerHTML = '';
}

export async function loadColaboradores({ preferCache = false } = {}){
  const loadId = ++activeLoadId;
  const p = new URLSearchParams();

  if (state.filtroTexto) p.set('q', state.filtroTexto);

  const hasServerFilter = p.toString().length > 0;
  const url = '/api/colaboradores' + (hasServerFilter ? `?${p}` : '');
  const cached = preferCache && !hasServerFilter ? readListCache() : null;
  const hasCachedList = !!cached;

  if (cached) {
    state.colaboradores = cached.items;
    listLoadError = null;
    finishListLoading();
    renderLista();

    // Ao voltar para a página logo depois do primeiro acesso, usa somente o
    // cache da sessão. A presença online continua atualizada pelo WebSocket.
    if (cached.ageMs <= LIST_CACHE_FRESH_MS) {
      return true;
    }
  } else {
    beginListLoading();
  }

  try {
    const res = await apiGet(url);
    if (loadId !== activeLoadId) return false;

    state.colaboradores = Array.isArray(res) ? res : (res?.items || []);
    listLoadError = null;

    if (!hasServerFilter) {
      writeListCache(state.colaboradores);
    }

    finishListLoading();
    renderLista();
    return true;
  } catch (e) {
    if (loadId !== activeLoadId) return false;

    console.error('[colaboradores] erro ao carregar colaboradores:', e);

    // Se a lista já apareceu pelo cache, não substitui tudo por uma tela de
    // erro. Mantém os dados visíveis e tenta novamente na próxima entrada.
    if (hasCachedList) {
      finishListLoading();
      return true;
    }

    failListLoading(e);
    toast('Não foi possível carregar os colaboradores.', 'err');
    return false;
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

function formatLastAccess(value){
  if (!value) return 'Nunca acessou o ZapsChat';

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Nunca acessou o ZapsChat';

  const now = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86400000);
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) return `Último acesso hoje às ${time}`;
  if (diffDays === 1) return `Último acesso ontem às ${time}`;

  const date = d.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  });

  return `Último acesso em ${date} às ${time}`;
}

function normalizedPresenceStatus(value){
  const status = String(value || '').trim().toLowerCase();
  return ['online', 'away'].includes(status) ? status : 'offline';
}

function presenceInfo(c){
  const status = normalizedPresenceStatus(c?.presence_status);

  if (status === 'online') {
    return {
      status,
      label: 'Online agora',
      cls: 'online',
      icon: 'fa-solid fa-circle',
      title: 'Esta pessoa está usando o ZapsChat agora.'
    };
  }

  if (status === 'away') {
    return {
      status,
      label: 'Ausente',
      cls: 'away',
      icon: 'fa-solid fa-circle',
      title: 'O ZapsChat está aberto, mas a pessoa está ausente ou em outra aba.'
    };
  }

  const hasLastAccess = !!c?.last_access_at;
  const label = formatLastAccess(c?.last_access_at);
  return {
    status: 'offline',
    label,
    cls: 'offline',
    icon: hasLastAccess ? 'fa-regular fa-clock' : 'fa-regular fa-circle-question',
    title: label
  };
}

function updateOpenProfilePresence(c){
  if (!c || Number(state.viewing?.id || 0) !== Number(c.id || 0)) return;

  const presence = presenceInfo(c);
  const subtitle = document.querySelector('#perfil-subtitle');
  if (subtitle) subtitle.textContent = presence.label;

  const statusText = document.querySelector('#p-status-text');
  const statusDot = document.querySelector('#p-status');
  if (statusText) statusText.textContent = presence.label;
  if (statusDot) {
    statusDot.dataset.presence = presence.status;
    statusDot.style.background = presence.status === 'online'
      ? '#16a34a'
      : (presence.status === 'away' ? '#f59e0b' : '#98a2b3');
  }
}

export function applyPresenceUpdate(payload){
  if (!payload || typeof payload !== 'object') return false;

  const id = Number(payload.colaborador_id || payload.id || 0);
  if (!id) return false;

  const colaborador = state.colaboradores.find(c => Number(c?.id || 0) === id);
  if (!colaborador) return false;

  colaborador.presence_status = normalizedPresenceStatus(payload.presence_status);
  colaborador.presence_updated_at = payload.presence_updated_at || null;
  colaborador.presence_expires_at = payload.presence_expires_at || null;
  colaborador.presence_activity_at = payload.presence_activity_at || null;
  colaborador.presence_session_count = Number(payload.presence_session_count || 0);

  if (colaborador.presence_status === 'offline' && payload.presence_updated_at) {
    colaborador.last_access_at = payload.presence_updated_at;
  }

  if (Number(state.viewing?.id || 0) === id) {
    Object.assign(state.viewing, colaborador);
    updateOpenProfilePresence(colaborador);
  }

  renderLista();
  return true;
}

export function applyPresenceSnapshot(items){
  const active = new Map();
  (Array.isArray(items) ? items : []).forEach(item => {
    const id = Number(item?.colaborador_id || item?.id || 0);
    if (id) active.set(id, item);
  });

  state.colaboradores.forEach(c => {
    const id = Number(c?.id || 0);
    const item = active.get(id);
    if (item) {
      c.presence_status = normalizedPresenceStatus(item.presence_status);
      c.presence_updated_at = item.presence_updated_at || null;
      c.presence_expires_at = item.presence_expires_at || null;
      c.presence_activity_at = item.presence_activity_at || null;
      c.presence_session_count = Number(item.presence_session_count || 0);
    } else {
      c.presence_status = 'offline';
      c.presence_expires_at = null;
      c.presence_session_count = 0;
    }
  });

  if (state.viewing?.id) {
    const current = state.colaboradores.find(c => Number(c?.id || 0) === Number(state.viewing.id));
    if (current) {
      Object.assign(state.viewing, current);
      updateOpenProfilePresence(current);
    }
  }

  renderLista();
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

  if (isAdminFlag(c)) add('Proprietário');

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
  const checks = Array.from(document.querySelectorAll('#tabela-colaboradores .row-select:not(:disabled)'));
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

  if (listLoading) {
    if (emptyState) emptyState.style.display = 'none';
    if (tbody && !tbody.querySelector('.colab-skeleton-row')) {
      tbody.innerHTML = loadingRowsHTML();
    }
    syncSelectAllState();
    return;
  }

  if (listLoadError && !state.colaboradores.length) {
    if (tbody) tbody.innerHTML = '';
    if (emptyState) emptyState.style.display = 'none';
    syncSelectAllState();
    return;
  }

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
    const presence = presenceInfo(c);
    const isOwner = isAdminFlag(c);

    const tr = document.createElement('tr');
    tr.dataset.id = String(id || '');
    tr.dataset.owner = isOwner ? 'true' : 'false';

    const teamHTML = teams.slice(0, 4).map((team, idx) => {
      const tone = team === 'Proprietário'
        ? 'tone-owner'
        : (team === 'Sem departamento' ? 'tone-muted' : `tone-${(idx % 4) + 1}`);
      return `<span class="team-chip ${tone}">${escapeHTML(team)}</span>`;
    }).join('');

    const extraTeams = teams.length > 4
      ? `<span class="team-chip tone-muted">+${teams.length - 4}</span>`
      : '';

    tr.innerHTML = `
      <td class="check-col">
        <input class="row-select" type="checkbox" aria-label="Selecionar ${escapeHTML(name)}" ${isOwner ? 'disabled title="O proprietário da empresa é protegido"' : ''}>
      </td>
      <td>
        <div class="member-cell">
          <div class="td-avatar"></div>
          <div class="member-copy">
            <span class="member-name-line">
              <span class="member-name" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
              ${isOwner ? '<span class="owner-badge" title="Criador e administrador principal da empresa"><i class="fa-solid fa-crown" aria-hidden="true"></i> Proprietário</span>' : ''}
            </span>
            <span class="member-user" title="${escapeHTML(cargo || handleFrom(name, email))}">${escapeHTML(handleFrom(name, email))}</span>
            <span class="member-presence ${escapeHTML(presence.cls)}" title="${escapeHTML(presence.title)}">
              <i class="member-presence-icon ${escapeHTML(presence.icon)}" aria-hidden="true"></i>
              <span>${escapeHTML(presence.label)}</span>
            </span>
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
        <button class="btn btn-ghost" data-action="edit" data-id="${escapeHTML(id)}" title="Editar colaborador" aria-label="Editar ${escapeHTML(name)}">
          <i class="fa fa-pen"></i>
        </button>
        ${isOwner ? '' : `
        <button class="btn btn-ghost" data-action="del" data-id="${escapeHTML(id)}" title="Remover" aria-label="Remover ${escapeHTML(name)}">
          <i class="fa fa-trash"></i>
        </button>`}
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
    const mod = await import('./modal.js?v=colab-direct-edit-20260810-1');
    mod.openNovo();
  });

  $('#btn-export-colaboradores')?.addEventListener('click', exportCSV);

  $('#btn-retry-colaboradores')?.addEventListener('click', async () => {
    await loadColaboradores();
  });

  $('#colab-select-all')?.addEventListener('change', e => {
    const checked = !!e.currentTarget.checked;
    document.querySelectorAll('#tabela-colaboradores .row-select:not(:disabled)').forEach(cb => {
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

    if (b.dataset.action === 'edit'){
      if (!raw || Number.isNaN(id) || !id){
        toast('ID do colaborador inválido.', 'err');
        return;
      }

      if (!hasPerm(EDIT_PERM)) {
        toast('Sem permissão para editar.', 'warn');
        return;
      }

      const mod = await import('./modal.js?v=colab-direct-edit-20260810-1');
      mod.openPerfil(id, { edit: true });
      return;
    }

    if (b.dataset.action === 'del'){
      const colaborador = state.colaboradores.find(item => Number(item?.id || 0) === id);
      if (isAdminFlag(colaborador)) {
        toast('O proprietário da empresa não pode ser removido.', 'warn');
        renderLista();
        return;
      }

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
        const detail = String(err?.data?.detail || err?.message || '').trim();
        toast(detail || 'Não foi possível remover.', 'err');
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
