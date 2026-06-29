// frontend/js/pages/colaboradores/modal.js

import { state, EDIT_PERM } from './state.js';
import { apiGet, apiForm, apiJSON } from './api.js';
import { $, els } from './dom.js';
import { toast } from './feedback.js';
import {
  chip,
  maskPhoneBR,
  maskPhoneDisplay,
  telE164,
  maskTimeInput,
  normStr
} from './helpers.js';
import {
  coalesceName,
  coalesceEmail,
  coalescePhone,
  coalesceCargo,
  coalesceDeptId,
  coalesceDeptName,
  coalesceHorarioInicio,
  coalesceHorarioFim,
  isAdminFlag
} from './coalesce.js';
import { hasPerm, canEditPassword } from './permissions.js';
import { loadEmpresa } from './empresa.js';
import { loadSetores } from './setores.js';
import { getDeptHorarioById } from './setores.js';
import { renderDeptHintBySetorId, applyExpPersonalizarUI, buildHorarioModoPayload } from './horario.js';
import {
  fetchAvatarURLFor,
  setPerfilAvatar,
  bindAvatarDnDAndPaste,
  handleAvatarFile,
  uploadAvatarTo,
  invalidateAvatarThumb
} from './avatar.js';
import {
  renderInstsView,
  ensureInstsEdit,
  getInstsSelecionadasEdit,
  saveInsts
} from './instancias.js';
import {
  renderDepartamentosView,
  ensureDepartamentosEdit,
  getDepartamentosSelecionadosEdit,
  saveDepartamentos
} from './departamentos.js';
import {
  ensurePermsEdit,
  getPermsSelecionadasEdit,
  savePerms
} from './permissoes.js';
import {
  clearValidationErrors,
  validateFormLive,
  getEditInputs
} from './validacao.js';
import { loadColaboradores, renderLista } from './lista.js';

function ensureFooterButtons(){
  const { perfilModal, pClose2 } = els();

  const footEl = perfilModal?.querySelector('.foot');
  const footActionsEl = perfilModal?.querySelector('.foot-actions') || footEl;
  const container = footActionsEl || footEl;

  if (!container) return;

  // O HTML novo já tem os botões do wizard. Reutiliza eles em vez de criar duplicado.
  const existingSave = perfilModal?.querySelector('#perfil-salvar-foot');
  const existingCancel = perfilModal?.querySelector('#perfil-cancelar-foot');

  if (!state.pSaveFoot){
    state.pSaveFoot = existingSave || document.createElement('button');

    if (!existingSave){
      state.pSaveFoot.id = 'perfil-salvar-foot';
      state.pSaveFoot.className = 'btn btn-primary';
      state.pSaveFoot.type = 'button';
      state.pSaveFoot.innerHTML = '<i class="fa fa-check"></i> Salvar';

      const before = pClose2 && pClose2.parentElement === container
        ? pClose2
        : container.lastElementChild;

      container.insertBefore(state.pSaveFoot, before || null);
    }

    if (!state.pSaveFoot.dataset.boundSaveInline){
      state.pSaveFoot.addEventListener('click', ev => {
        ev.preventDefault();

        const modal = els().perfilModal;
        const { idx } = activeWizardStep(modal);

        // Segurança extra: se algum CSS antigo fizer o botão de rodapé aparecer
        // antes da última etapa, ele avança no wizard em vez de tentar salvar
        // e cobrar senha antes da hora.
        if (modal?.classList.contains('editing') && idx < WIZARD_STEPS.length - 1) {
          goWizardStep(modal, WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, idx + 1)]);
          return;
        }

        saveInline();
      });
      state.pSaveFoot.dataset.boundSaveInline = '1';
    }
  }

  if (!state.pCancelFoot){
    state.pCancelFoot = existingCancel || document.createElement('button');

    if (!existingCancel){
      state.pCancelFoot.id = 'perfil-cancelar-foot';
      state.pCancelFoot.className = 'btn btn-ghost';
      state.pCancelFoot.type = 'button';
      state.pCancelFoot.textContent = 'Cancelar';
      container.insertBefore(state.pCancelFoot, state.pSaveFoot);
    }

    if (!state.pCancelFoot.dataset.boundCancelInline){
      state.pCancelFoot.addEventListener('click', () => {
        if (els().perfilModal?.dataset.mode === 'create') closePerfil();
        else exitInlineEdit(true);
      });
      state.pCancelFoot.dataset.boundCancelInline = '1';
    }
  }
}

function renderAdminBadge(colab){
  const fb = $('#fb-cargo');
  if (!fb) return;

  const label = fb.querySelector('label') || fb;
  let badge = fb.querySelector('#badge-admin');

  if (!badge){
    badge = document.createElement('span');
    badge.id = 'badge-admin';
    badge.className = 'chip chip-admin';
    badge.textContent = 'Administrador';
    badge.style.marginLeft = '8px';
    badge.style.border = '1px solid #22c55e';
    badge.style.color = '#22c55e';
    label.appendChild(badge);
  }

  badge.style.display = isAdminFlag(colab) ? '' : 'none';
}

function ensureAccessExplanationBox(){
  let full = document.getElementById('zc-colab-access-guide');

  if (!full){
    const { dPerms, ePerms } = els();

    full = document.createElement('div');
    full.id = 'zc-colab-access-guide';
    full.className = 'full';

    full.innerHTML = `
      <dt>Acesso no atendimento</dt>
      <dd>
        <div
          class="fieldbox zc-access-guide"
          style="
            display:grid;
            gap:.55rem;
            padding:.85rem .95rem;
            border:1px solid rgba(34,197,94,.24);
            background:rgba(34,197,94,.07);
            border-radius:14px;
          "
        >
          <div style="display:flex; align-items:center; gap:.55rem; font-weight:700;">
            <i class="fa fa-circle-info" style="color:#22c55e;"></i>
            <span>Como funciona o acesso deste colaborador</span>
          </div>

          <div class="muted" style="line-height:1.45;">
            Para o colaborador ver uma conversa, ele precisa ter acesso ao
            <b>WhatsApp</b> onde a mensagem chegou e ao <b>setor</b> da conversa.
          </div>

          <div style="display:grid; gap:.35rem; font-size:.92rem; line-height:1.45;">
            <div>
              <b>Setores que atende:</b>
              define de quais setores/departamentos ele poderá ver e atender conversas.
            </div>

            <div>
              <b>WhatsApps que pode acessar:</b>
              define quais números de WhatsApp aparecem para ele no atendimento.
            </div>

            <div>
              <b>Permissões:</b>
              define o que ele pode fazer no sistema, como ver atendimento,
              enviar mensagem ou gerenciar equipe.
            </div>

            <div>
              <b>Entrada geral:</b>
              conversas que ainda não têm setor aparecem para quem tem acesso
              ao WhatsApp onde a mensagem chegou.
            </div>
          </div>
        </div>
      </dd>
    `;

    const permFull =
      dPerms?.closest('.full') ||
      ePerms?.closest('.full') ||
      dPerms?.parentElement?.closest('.full') ||
      ePerms?.parentElement?.closest('.full');

    const instsFull = document.getElementById('insts-full');
    const grid = document.querySelector('#details-grid, .details-grid');

    if (instsFull && instsFull.parentElement){
      instsFull.parentElement.insertBefore(full, instsFull);
    } else if (permFull && permFull.parentElement){
      permFull.parentElement.insertBefore(full, permFull);
    } else if (grid){
      grid.appendChild(full);
    }
  }

  return full;
}

async function loadColabFull(id){
  const c = await apiGet(`/api/colaboradores/${id}`);

  try {
    const p = await apiGet(`/api/permissoes/colaboradores/${id}`);
    c.permissoes = Array.isArray(p) ? p : (p?.items || p?.data || []);
  } catch (e) {
    console.warn('[colaboradores] permissões do colaborador indisponíveis', e);
  }

  return c;
}

function setPlaceholderPerfil(){
  const {
    pTitle
  } = els();

  const vNome = $('#v-nome');
  const vEmailA = $('#v-email');
  const vEmpresa = $('#v-empresa');
  const vDepto = $('#v-depto');
  const vTelA = $('#v-tel');
  const vCargo = $('#v-cargo');
  const vExpIni = $('#v-exp-ini');
  const vExpFim = $('#v-exp-fim');

  if (pTitle) pTitle.textContent = 'Carregando…';

  if (vNome) vNome.textContent = '—';

  if (vEmailA){
    vEmailA.textContent = '—';
    vEmailA.href = '#';
  }

  if (vEmpresa) vEmpresa.textContent = '—';
  if (vDepto) vDepto.textContent = '—';

  if (vTelA){
    vTelA.textContent = '—';
    vTelA.href = '#';
  }

  if (vCargo) vCargo.textContent = '—';
  if (vExpIni) vExpIni.textContent = '—';
  if (vExpFim) vExpFim.textContent = '—';
}

function swapFieldbox(boxId, html){
  const wrap = document.getElementById(boxId);

  if (!wrap) return null;

  if (!wrap.dataset.viewHtml) {
    wrap.dataset.viewHtml = wrap.innerHTML;
  }

  wrap.classList.add('is-editing');
  wrap.innerHTML = html.trim();

  return wrap.firstElementChild;
}

function restoreFieldbox(boxId){
  const wrap = document.getElementById(boxId);

  if (wrap && wrap.dataset.viewHtml != null){
    wrap.innerHTML = wrap.dataset.viewHtml;
    wrap.classList.remove('is-editing');
    delete wrap.dataset.viewHtml;
  }
}

export async function renderPerfilView(colab){
  const {
    perfilModal,
    pTitle,
    dStatus,
    dStatusText,
    avatarHint,
    dPerms,
    ePerms
  } = els();

  clearValidationErrors();

  state.viewing = colab;
  state.showErrors = false;

  const vNome = $('#v-nome');
  const vEmailA = $('#v-email');
  const vEmpresa = $('#v-empresa');
  const vDepto = $('#v-depto');
  const vTelA = $('#v-tel');
  const vCargo = $('#v-cargo');
  const vExpIni = $('#v-exp-ini');
  const vExpFim = $('#v-exp-fim');

  const empresa = await loadEmpresa();

  if (!state.setores.length) {
    try {
      await loadSetores();
    } catch (e) {
      console.warn('[colaboradores] loadSetores dentro do perfil falhou', e);
    }
  }

  if (pTitle) {
    pTitle.textContent = perfilModal?.dataset.mode === 'create'
      ? 'Novo colaborador'
      : (coalesceName(colab) || 'Perfil do colaborador');
  }

  const pSubtitle = document.querySelector('#perfil-subtitle');
  if (pSubtitle) {
    pSubtitle.textContent = perfilModal?.dataset.mode === 'create'
      ? 'Convide alguém para acessar a plataforma'
      : 'Gerencie perfil, acesso e permissões deste colaborador';
  }

  const photoURL = await fetchAvatarURLFor(colab);
  setPerfilAvatar(coalesceName(colab), photoURL);

  if (dStatus) dStatus.style.background = '#008b32';
  if (dStatusText) dStatusText.textContent = 'Disponível';

  const nome = coalesceName(colab);
  const email = coalesceEmail(colab);

  if (vNome) vNome.textContent = nome || '—';

  if (vEmailA){
    vEmailA.textContent = email || '—';
    vEmailA.href = email ? `mailto:${email}` : '#';
  }

  if (vEmpresa) vEmpresa.textContent = empresa?.nome || '—';

  const depId = coalesceDeptId(colab);
  const depName =
    coalesceDeptName(colab) ||
    state.setores.find(s => String(s.id) === String(depId))?.nome;

  if (vDepto) vDepto.textContent = depName || '—';

  const telRaw = coalescePhone(colab);
  const telDisp = telRaw ? maskPhoneDisplay(telRaw.replace(/^\+/,'')) : '—';

  if (vTelA){
    vTelA.textContent = telDisp;
    vTelA.href = telRaw ? `tel:${telE164(telRaw)}` : '#';
  }

  const cargoVal = coalesceCargo(colab);
  const adm = isAdminFlag(colab);

  if (vCargo) vCargo.textContent = adm ? '' : (cargoVal || '—');

  renderAdminBadge(colab);

  const colIni = coalesceHorarioInicio(colab);
  const colFim = coalesceHorarioFim(colab);
  const depHor = getDeptHorarioById(depId, depName);
  const isCustom = !!(colIni || colFim);

  if (vExpIni){
    if (colIni) vExpIni.textContent = colIni;
    else if (depHor.ini) vExpIni.textContent = `${depHor.ini} (padrão)`;
    else vExpIni.textContent = '—';
  }

  if (vExpFim){
    if (colFim) vExpFim.textContent = colFim;
    else if (depHor.fim) vExpFim.textContent = `${depHor.fim} (padrão)`;
    else vExpFim.textContent = '—';
  }

  renderDeptHintBySetorId(depId, {
    personalizar: isCustom,
    setorNome: depName
  });

  const rowToggle = document.getElementById('row-exp-toggle');
  if (rowToggle) rowToggle.style.display = 'none';

  const rowIni = document.getElementById('row-exp-ini');
  const rowFim = document.getElementById('row-exp-fim');

  if (rowIni) rowIni.style.display = '';
  if (rowFim) rowFim.style.display = '';

  if (dPerms){
    dPerms.innerHTML = '';

    const permsList = (colab.permissoes || [])
      .map(x => String(x.id ?? x));

    if (permsList.length) {
      permsList.forEach(p => dPerms.appendChild(chip(p)));
    } else {
      dPerms.textContent = '—';
    }

    dPerms.style.display = '';
  }

  if (ePerms){
    ePerms.style.display = 'none';
    ePerms.innerHTML = '';
  }

  ensureAccessExplanationBox();

  const isCreate = perfilModal?.dataset.mode === 'create';

  if (isCreate) {
    const dDeptos = document.querySelector('#d-deptos');
    const eDeptos = document.querySelector('#e-deptos');
    const dInsts = document.querySelector('#d-insts');
    const eInsts = document.querySelector('#e-insts');
    const deptActions = document.querySelector('#dept-actions');
    const instActions = document.querySelector('#inst-actions');

    if (dDeptos) { dDeptos.innerHTML = ''; dDeptos.style.display = ''; }
    if (eDeptos) { eDeptos.innerHTML = ''; eDeptos.style.display = 'none'; }
    if (dInsts) { dInsts.innerHTML = ''; dInsts.style.display = ''; }
    if (eInsts) { eInsts.innerHTML = ''; eInsts.style.display = 'none'; }
    if (deptActions) deptActions.style.display = 'none';
    if (instActions) instActions.style.display = 'none';
  } else {
    await renderDepartamentosView(colab);
    await renderInstsView(colab);
  }

  if (avatarHint) {
    avatarHint.style.display = perfilModal?.dataset.mode === 'create'
      ? 'grid'
      : 'none';
  }

  const wrapSenha = $('#wrap-senha');
  const senhaHelp = $('#senha-help');
  const canPass = canEditPassword();

  if (wrapSenha) {
    wrapSenha.style.display = (canPass && (isCreate || state.inlineEdit))
      ? 'flex'
      : 'none';
  }

  if (senhaHelp) {
    senhaHelp.style.display = (canPass && isCreate) ? '' : 'none';
  }

  bindAvatarDnDAndPaste();
  exitInlineEdit(false);
}



function setPermGroupOpen(group, open){
  if (!group) return;

  const head = group.querySelector('.perm-group-head');
  const body = group.querySelector('.perm-group-body');

  group.classList.toggle('open', !!open);
  group.dataset.open = open ? '1' : '0';

  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (body) body.hidden = !open;
}

function setupPermAccordion(root, opts = {}){
  if (!root) return;

  const groups = Array.from(root.querySelectorAll('.perm-group'));
  if (!groups.length) return;

  const collapseAll = opts.collapseAll !== false;

  groups.forEach((group, index) => {
    const head = group.querySelector('.perm-group-head');
    const body = group.querySelector('.perm-group-body');
    if (!head || !body) return;

    group.classList.add('is-collapsible');

    if (!body.id) body.id = `perm-group-body-${index + 1}`;

    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-controls', body.id);

    const title = head.querySelector('.perm-group-title') || head;
    if (!title.querySelector('.perm-collapse-ico')) {
      const ico = document.createElement('span');
      ico.className = 'perm-collapse-ico';
      ico.setAttribute('aria-hidden', 'true');
      ico.textContent = '›';
      title.prepend(ico);
    }

    if (!head.dataset.accordionBound) {
      head.dataset.accordionBound = '1';

      const toggle = ev => {
        if (ev?.target?.closest?.('button,input,label,select,a,.perm-group-controls')) return;
        setPermGroupOpen(group, !group.classList.contains('open'));
      };

      head.addEventListener('click', toggle);
      head.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        toggle(ev);
      });
    }

    if (collapseAll && group.dataset.open !== '1') {
      setPermGroupOpen(group, false);
    } else {
      setPermGroupOpen(group, group.classList.contains('open'));
    }
  });
}

function resetLazyEditFlags(){
  const { perfilModal } = els();
  if (!perfilModal) return;

  delete perfilModal.dataset.deptosEditLoaded;
  delete perfilModal.dataset.instsEditLoaded;
  delete perfilModal.dataset.permsEditLoaded;
}

function ensureLazyEditStep(key){
  const { perfilModal, dPerms, ePerms } = els();
  if (!perfilModal || !state.inlineEdit) return;

  const step = key || activeWizardStep(perfilModal).key || 'perfil';

  function runOnce(flag, loader){
    if (perfilModal.dataset[flag] === '1' || perfilModal.dataset[flag] === 'loading') return;

    perfilModal.dataset[flag] = 'loading';

    Promise.resolve()
      .then(loader)
      .then(() => {
        perfilModal.dataset[flag] = '1';
      })
      .catch(e => {
        delete perfilModal.dataset[flag];
        console.warn('[colaboradores] falha ao carregar etapa do modal', step, e);
      });
  }

  if (step === 'acessos') {
    runOnce('deptosEditLoaded', ensureDepartamentosEdit);
    runOnce('instsEditLoaded', ensureInstsEdit);
  }

  if (step === 'permissoes') {
    if (dPerms) dPerms.style.display = 'none';
    if (ePerms) {
      ePerms.style.display = 'grid';
      if (!ePerms.children.length) {
        ePerms.innerHTML = '<div class="muted">Carregando permissões…</div>';
      }
    }

    if (perfilModal.dataset.permsEditLoaded === '1') {
      setTimeout(() => setupPermAccordion(ePerms, { collapseAll:false }), 0);
    } else {
      runOnce('permsEditLoaded', () => {
        ensurePermsEdit();
        setTimeout(() => setupPermAccordion(ePerms, { collapseAll:true }), 0);
        setTimeout(() => setupPermAccordion(ePerms, { collapseAll:false }), 120);
      });
    }
  }
}

export function enterInlineEdit(){
  const {
    perfilModal,
    pEdit,
    pSave,
    pCancel,
    pClose,
    pClose2,
    dPerms,
    ePerms
  } = els();

  if (!state.viewing || state.inlineEdit) return;

  state.inlineEdit = true;
  state.showErrors = false;

  ensureAccessExplanationBox();

  if (pEdit) pEdit.style.display = 'none';
  if (pSave) pSave.style.display = 'inline-flex';
  if (pCancel) pCancel.style.display = 'none';
  if (pClose) pClose.style.display = '';

  ensureFooterButtons();

  if (state.pSaveFoot) state.pSaveFoot.style.display = 'none';
  if (state.pCancelFoot) state.pCancelFoot.style.display = 'none';
  if (pClose2) pClose2.style.display = 'none';

  if (state.pSaveFoot){
    state.pSaveFoot.innerHTML = perfilModal?.dataset.mode === 'create'
      ? '<i class="fa fa-check"></i> Criar colaborador'
      : '<i class="fa fa-check"></i> Salvar alterações';
  }

  perfilModal?.classList.add('editing');

  swapFieldbox(
    'fb-nome',
    `<input id="e-nome" class="input" type="text" maxlength="120" required autocomplete="off" placeholder="Seu nome completo">`
  );

  swapFieldbox(
    'fb-email',
    `<input id="e-email" class="input" type="email" maxlength="160" required autocomplete="off" placeholder="nome@empresa.com">`
  );

  const selHtml = `
    <select id="e-setor" class="select" required>
      <option value="">Selecione…</option>
      ${state.setores.map(s => `<option value="${s.id}">${s.nome}</option>`).join('')}
    </select>
  `;

  const sel = swapFieldbox('fb-depto', selHtml);

  const depIdRaw = coalesceDeptId(state.viewing);
  const depName = coalesceDeptName(state.viewing);

  let depValue = '';

  if (depIdRaw != null) {
    depValue = String(depIdRaw);
  } else if (depName && state.setores.length) {
    const alvo = normStr(depName);
    const found = state.setores.find(s => normStr(s?.nome) === alvo);

    if (found) depValue = String(found.id);
  }

  if (sel && depValue) {
    const hasOpt = Array.from(sel.options || [])
      .some(o => o.value === depValue);

    if (!hasOpt) {
      sel.appendChild(new Option(depName || 'Departamento atual', depValue));
    }

    sel.value = depValue;
  }

  swapFieldbox(
    'fb-tel',
    `<input id="e-tel" class="input" type="tel" required inputmode="numeric" placeholder="(DD) 9 9999-9999">`
  );

  swapFieldbox(
    'fb-cargo',
    `<input id="e-cargo" class="input" type="text" maxlength="80" required placeholder="Cargo">`
  );

  swapFieldbox(
    'fb-exp-ini',
    `<input id="e-exp-ini" class="input" type="text" inputmode="numeric" placeholder="08:00">`
  );

  swapFieldbox(
    'fb-exp-fim',
    `<input id="e-exp-fim" class="input" type="text" inputmode="numeric" placeholder="18:00">`
  );

  $('#e-nome').value = coalesceName(state.viewing) || '';
  $('#e-email').value = coalesceEmail(state.viewing) || '';
  $('#e-tel').value = coalescePhone(state.viewing)
    ? maskPhoneBR(coalescePhone(state.viewing))
    : '';
  $('#e-cargo').value = coalesceCargo(state.viewing) || '';

  const hIni = coalesceHorarioInicio(state.viewing) || '';
  const hFim = coalesceHorarioFim(state.viewing) || '';

  $('#e-exp-ini').value = hIni;
  $('#e-exp-fim').value = hFim;

  const tgl = document.getElementById('e-exp-personalizar');

  if (tgl){
    const isCreate = perfilModal?.dataset.mode === 'create';
    tgl.checked = !isCreate && !!(hIni || hFim);

    tgl.onchange = () => {
      applyExpPersonalizarUI();
      validateFormLive();
    };
  }

  renderAdminBadge({
    ...state.viewing,
    cargo: $('#e-cargo').value
  });

  $('#e-nome')?.addEventListener('input', () => {
    const el = $('#e-nome');
    let v = el.value.replace(/[0-9]/g,'');
    v = v.replace(/\s{2,}/g,' ');
    el.value = v;
    validateFormLive();
  });

  $('#e-email')?.addEventListener('input', () => {
    const el = $('#e-email');
    el.value = el.value.replace(/\s+/g,'').toLowerCase();
    validateFormLive();
  });

  $('#e-tel')?.addEventListener('input', () => {
    const el = $('#e-tel');
    el.value = maskPhoneBR(el.value);
    validateFormLive();
  });

  $('#e-cargo')?.addEventListener('input', () => {
    validateFormLive();

    renderAdminBadge({
      ...state.viewing,
      cargo: $('#e-cargo').value
    });
  });

  sel?.addEventListener('change', () => {
    applyExpPersonalizarUI();
    validateFormLive();
  });

  $('#e-exp-ini')?.addEventListener('input', () => {
    const el = $('#e-exp-ini');
    maskTimeInput(el);
    validateFormLive();
  });

  $('#e-exp-fim')?.addEventListener('input', () => {
    const el = $('#e-exp-fim');
    maskTimeInput(el);
    validateFormLive();
  });

  const senhaInput = $('#e-senha');

  if (senhaInput) {
    senhaInput.addEventListener('input', () => validateFormLive());
  }

  if (ePerms){
    ePerms.style.display = 'none';
    ePerms.innerHTML = '';
  }

  if (dPerms) {
    dPerms.style.display = 'none';
  }

  // Não carrega permissões/WhatsApps/departamentos no primeiro clique.
  // Cada bloco entra sob demanda quando a pessoa chega na etapa do wizard.
  ensureLazyEditStep(activeWizardStep(perfilModal).key);

  const wrapSenha = $('#wrap-senha');
  const senhaHelp = $('#senha-help');
  const toggle = $('#toggle-senha');
  const canPass = canEditPassword();

  if (wrapSenha) {
    wrapSenha.style.display = canPass ? 'flex' : 'none';
  }

  if (senhaHelp) {
    senhaHelp.style.display = (canPass && perfilModal?.dataset.mode === 'create')
      ? ''
      : 'none';
  }

  if (toggle){
    const input = $('#e-senha');

    if (!canPass){
      if (input) input.value = '';
      toggle.onclick = null;
    } else {
      toggle.onclick = () => {
        if (!input) return;

        input.type = input.type === 'password' ? 'text' : 'password';

        const ico = toggle.querySelector('i');

        if (ico){
          ico.classList.toggle('fa-eye');
          ico.classList.toggle('fa-eye-slash');
        }

        input.focus();
      };
    }
  }

  bindAvatarDnDAndPaste();
  applyExpPersonalizarUI();

  if (sel && sel.value) {
    const setorNome = sel?.options?.[sel.selectedIndex]?.text || '';

    renderDeptHintBySetorId(sel.value, {
      personalizar: !!tgl?.checked,
      setorNome
    });
  } else {
    renderDeptHintBySetorId('', {
      personalizar: !!tgl?.checked,
      setorNome: ''
    });
  }

  validateFormLive(false);
  updateWizardFooter(perfilModal);
}

export function exitInlineEdit(restore = true){
  const {
    perfilModal,
    pEdit,
    pSave,
    pCancel,
    pClose,
    pClose2
  } = els();

  restoreFieldbox('fb-nome');
  restoreFieldbox('fb-email');
  restoreFieldbox('fb-depto');
  restoreFieldbox('fb-tel');
  restoreFieldbox('fb-cargo');
  restoreFieldbox('fb-exp-ini');
  restoreFieldbox('fb-exp-fim');

  state.inlineEdit = false;
  state.showErrors = false;

  if (pEdit) pEdit.style.display = '';
  if (pSave) pSave.style.display = 'none';
  if (pCancel) pCancel.style.display = 'none';
  if (pClose) pClose.style.display = '';

  if (pClose2) pClose2.style.display = 'none';
  if (state.pSaveFoot) state.pSaveFoot.style.display = 'none';
  if (state.pCancelFoot) state.pCancelFoot.style.display = 'none';

  perfilModal?.classList.remove('editing');

  const rowToggle = document.getElementById('row-exp-toggle');
  if (rowToggle) rowToggle.style.display = 'none';

  const rowIni = document.getElementById('row-exp-ini');
  const rowFim = document.getElementById('row-exp-fim');

  if (rowIni) rowIni.style.display = '';
  if (rowFim) rowFim.style.display = '';

  if (restore && state.viewing) {
    renderPerfilView(state.viewing);
  }
}

export async function saveInline(){
  const { perfilModal } = els();

  // O cadastro é em etapas. Se algum botão antigo/duplicado chamar salvar
  // antes da última etapa, não valida senha ainda: apenas avança.
  const { idx } = activeWizardStep(perfilModal);
  if (perfilModal?.classList.contains('editing') && idx < WIZARD_STEPS.length - 1) {
    goWizardStep(perfilModal, WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, idx + 1)]);
    return;
  }

  validateFormLive(false);

  const mode = perfilModal?.dataset.mode || 'view';
  const id = Number(perfilModal?.dataset.currentId || '0') || 0;
  const canPass = canEditPassword();

  const {
    eNome,
    eEmail,
    eSetor,
    eTel,
    eCargo,
    eExpIni,
    eExpFim,
    eExpPersonalizar
  } = getEditInputs();

  const nome = eNome?.value.trim();
  const email = eEmail?.value.trim();
  const setor = eSetor?.value || '';
  const tel = eTel?.value || '';
  const cargo = eCargo?.value || '';
  const expOn = !!eExpPersonalizar?.checked;
  const hIni = expOn ? (eExpIni?.value.trim() || '') : '';
  const hFim = expOn ? (eExpFim?.value.trim() || '') : '';

  state.showErrors = true;

  const check = validateFormLive(true);

  if (!check.ok){
    if (check.msgs.some(m => String(m).toLowerCase().includes('senha'))) {
      goWizardStep(perfilModal, 'acessos');

      setTimeout(() => {
        const senhaEl = document.querySelector('#e-senha');
        senhaEl?.focus?.();
      }, 80);
    }

    toast('Corrija os campos:\n' + check.msgs.join('\n'), 'warn');
    return;
  }

  const instsSel = getInstsSelecionadasEdit();
  const deptosSel = getDepartamentosSelecionadosEdit();
  const permsSel = getPermsSelecionadasEdit();
  const horarioModo = buildHorarioModoPayload(setor, expOn);

  if (mode === 'create'){
    const fd = new FormData();

    fd.append('nome', nome);
    fd.append('email', email);
    fd.append('setor_id', String(Number(setor)));
    fd.append('telefone', telE164(tel));
    fd.append('cargo', (cargo || '').trim());
    fd.append('horario_modo', horarioModo);

    // Cria também o usuário de login vinculado ao colaborador.
    // Sem isso, a senha era enviada, mas o backend criava apenas o registro em colaboradores.
    fd.append('criar_usuario', 'true');

    if (expOn){
      fd.append('hora_login_inicio', hIni);
      fd.append('hora_login_fim', hFim);
    }

    if (!canPass){
      toast('Você não tem permissão para definir senha deste colaborador.', 'warn');
      return;
    }

    const senhaInp = document.querySelector('#e-senha');
    const s = (senhaInp?.value || '').trim();

    if (s.length < 6 || s.length > 72) {
      toast('Defina uma senha entre 6 e 72 caracteres.', 'warn');
      return;
    }

    fd.append('senha', s);

    permsSel.forEach(p => {
      fd.append('permissoes[]', String(p));
    });

    deptosSel.forEach(n => {
      fd.append('departamentos_ids[]', String(n));
    });

    instsSel.forEach(n => {
      fd.append('instancias_ids[]', String(n));
    });

    if (state.newAvatarFile) {
      fd.append('avatar', state.newAvatarFile);
    }

    try {
      const created = await apiForm('/api/colaboradores/', 'POST', fd);

      if (created?.id != null){
        try {
          await saveDepartamentos(created.id, deptosSel);
        } catch (eDept){
          console.warn('departamentos create', eDept);
        }

        try {
          await savePerms(created.id, permsSel);
        } catch (ePerm){
          console.warn('perm create', ePerm);
        }
      }

      toast('Colaborador criado.');

      if (state.newAvatarFile) {
        let upOK = false;

        if (created?.usuario_id){
          upOK = await uploadAvatarTo(`/api/usuarios/${created.usuario_id}/avatar`, state.newAvatarFile);
        }

        if (!upOK && created?.id){
          upOK = await uploadAvatarTo(`/api/colaboradores/${created.id}/avatar`, state.newAvatarFile);
        }

        if (created?.id) {
          invalidateAvatarThumb(created.id);
        }
      }

      state.newAvatarFile = null;
      state.showErrors = false;

      perfilModal.dataset.mode = 'view';
      perfilModal.dataset.currentId = String(created?.id || '');

      const fresh = await loadColabFull(created.id);

      fresh.instancias_ids = instsSel;
      fresh.departamentos_ids = deptosSel;

      if (permsSel.length) {
        fresh.permissoes = permsSel;
      }

      fresh.hora_login_inicio = expOn ? (hIni || null) : null;
      fresh.hora_login_fim = expOn ? (hFim || null) : null;
      fresh.horario_modo = horarioModo;

      state.viewing = fresh;

      await loadColaboradores();
      renderLista();

      await renderPerfilView(fresh);
      exitInlineEdit(false);
    } catch (e) {
      console.error('[create error]', e.status, e.data);

      const msg = (e?.data && (
        e.data.detail ||
        e.data.message ||
        (typeof e.data === 'string' ? e.data : '')
      )) || null;

      if (e.status === 409) return toast('E-mail já cadastrado.', 'warn');
      if (e.status === 422) return toast(msg || 'Dados inválidos (422).', 'warn');

      toast(msg || 'Erro ao criar.', 'err');
    }

    return;
  }

  const payload = {
    nome,
    email,
    setor_id: Number(setor),
    telefone: telE164(tel),
    cargo: (cargo || '').trim(),
    instancias_ids: instsSel,
    departamentos_ids: deptosSel,
    atualizar_usuario: !!state.viewing?.usuario_id,
    horario_modo: horarioModo
  };

  payload.hora_login_inicio = expOn ? (hIni || null) : null;
  payload.hora_login_fim = expOn ? (hFim || null) : null;

  const senhaEl = document.querySelector('#e-senha');
  const newPass = (senhaEl?.value || '').trim();

  if (canPass && newPass) {
    payload.senha = newPass;
    payload.atualizar_usuario = true;
  }

  try {
    await apiJSON(`/api/colaboradores/${id}`, 'PUT', payload);

    if (state.newAvatarFile){
      let upOK = false;

      if (state.viewing?.usuario_id){
        upOK = await uploadAvatarTo(`/api/usuarios/${state.viewing.usuario_id}/avatar`, state.newAvatarFile);
      }

      if (!upOK){
        upOK = await uploadAvatarTo(`/api/colaboradores/${id}/avatar`, state.newAvatarFile);
      }

      if (upOK){
        invalidateAvatarThumb(id);
        state.newAvatarFile = null;
      }
    }

    let permsUpdated = true;

    try {
      permsUpdated = await savePerms(id, permsSel);

      if (permsUpdated) {
        state.viewing.permissoes = permsSel;
      }
    } catch (ePerm){
      permsUpdated = false;
      console.warn('Erro ao salvar permissões (edit)', ePerm);
    }

    let deptosUpdated = true;

    try {
      deptosUpdated = await saveDepartamentos(id, deptosSel);
    } catch (eDept){
      deptosUpdated = false;
      console.warn('Erro ao salvar departamentos (edit)', eDept);
    }

    let instsUpdated = true;

    try {
      instsUpdated = await saveInsts(id, instsSel);
    } catch {
      instsUpdated = false;
    }

    state.showErrors = false;

    const msg = [
      'Alterações salvas.',
      deptosUpdated ? 'Departamentos OK.' : '',
      permsUpdated ? 'Permissões OK.' : '',
      instsUpdated ? 'Instâncias OK.' : ''
    ].filter(Boolean).join(' ');

    toast(msg || 'Alterações salvas.');

    const fresh = await loadColabFull(id);

    fresh.instancias_ids = instsSel;
    fresh.departamentos_ids = deptosSel;

    if (permsSel.length) {
      fresh.permissoes = permsSel;
    }

    fresh.hora_login_inicio = expOn ? (hIni || null) : null;
    fresh.hora_login_fim = expOn ? (hFim || null) : null;
    fresh.horario_modo = horarioModo;

    state.viewing = fresh;

    await loadColaboradores();
    renderLista();
    renderPerfilView(fresh);
  } catch (e) {
    console.error(e);

    if (e.status === 409) return toast('E-mail já cadastrado.', 'warn');
    if (e.status === 404) return toast('Registro não encontrado.', 'warn');

    toast('Erro ao salvar.', 'err');
  }
}

export async function openPerfil(id){
  const { perfilModal, pEdit } = els();

  try {
    if (Number.isNaN(Number(id)) || !Number(id)){
      toast('ID do colaborador inválido.', 'err');
      return;
    }

    resetLazyEditFlags();
    perfilModal.dataset.mode = 'view';
    perfilModal.setAttribute('aria-hidden','false');
    document.documentElement.classList.add('modal-open');

    setPlaceholderPerfil();

    const colab = await loadColabFull(id);

    await renderPerfilView(colab);

    perfilModal.dataset.currentId = String(id);

    if (pEdit) {
      pEdit.style.display = hasPerm('colaboradores.gerenciar') ? '' : 'none';
    }

    const { pSave, pCancel, pClose, pClose2 } = els();
    if (pSave) pSave.style.display = 'none';
    if (pCancel) pCancel.style.display = 'none';
    if (pClose) pClose.style.display = '';
    if (pClose2) pClose2.style.display = 'none';
    updateWizardFooter(perfilModal);
  } catch (e) {
    console.error(e);
    toast('Não foi possível abrir o perfil.', 'err');
  }
}

export function closePerfil(){
  const { perfilModal } = els();

  clearValidationErrors();
  resetLazyEditFlags();

  perfilModal?.setAttribute('aria-hidden','true');
  document.documentElement.classList.remove('modal-open');

  if (perfilModal) {
    perfilModal.dataset.mode = 'view';
  }

  state.newAvatarFile = null;
  state.showErrors = false;

  $('#avatar-wrap')?.classList.remove('drag-over');
}

export async function openNovo(){
  const {
    perfilModal,
    pAvatarInput,
    btnAddAvatar
  } = els();

  if (!hasPerm(EDIT_PERM)) {
    toast('Sem permissão para criar.', 'warn');
    return;
  }

  if (!canEditPassword()) {
    toast('Sem permissão para criar (requer permissão de redefinir senha).', 'warn');
    return;
  }

  const blank = {
    id: null,
    nome: '',
    email: '',
    telefone: '',
    cargo: '',
    setor_id: null,
    permissoes: [],
    instancias_ids: [],
    departamentos_ids: [],
    hora_login_inicio: null,
    hora_login_fim: null,
    horario_modo: 'livre'
  };

  perfilModal.dataset.mode = 'create';
  perfilModal.dataset.currentId = '';

  state.showErrors = false;
  resetLazyEditFlags();
  setPlaceholderPerfil();

  const tituloNovo = document.querySelector('#perfil-title');
  if (tituloNovo) tituloNovo.textContent = 'Novo colaborador';

  perfilModal.setAttribute('aria-hidden','false');
  document.documentElement.classList.add('modal-open');

  await renderPerfilView(blank);

  if (pAvatarInput){
    pAvatarInput.setAttribute('accept','image/*,.svg,.webp,.avif,.heic,.heif');

    pAvatarInput.onchange = () => {
      handleAvatarFile(pAvatarInput.files?.[0] || null);
    };
  }

  if (btnAddAvatar){
    btnAddAvatar.onclick = () => {
      if (pAvatarInput){
        pAvatarInput.value = '';
        pAvatarInput.click();
      }
    };
  }

  bindAvatarDnDAndPaste();

  const wrapSenha = document.querySelector('#wrap-senha');
  const toggle = document.querySelector('#toggle-senha');
  const canPass = canEditPassword();

  if (wrapSenha) {
    wrapSenha.style.display = canPass ? 'flex' : 'none';
  }

  if (toggle){
    const input = document.querySelector('#e-senha');

    if (!canPass){
      if (input) input.value = '';
      toggle.onclick = null;
    } else {
      toggle.onclick = () => {
        if (!input) return;

        input.type = input.type === 'password' ? 'text' : 'password';

        const ico = toggle.querySelector('i');

        if (ico){
          ico.classList.toggle('fa-eye');
          ico.classList.toggle('fa-eye-slash');
        }

        input.focus();
      };
    }
  }

  enterInlineEdit();
  goWizardStep(perfilModal, 'perfil');
  updateWizardFooter(perfilModal);
}


const WIZARD_STEPS = ['perfil', 'acessos', 'permissoes'];

function activeWizardStep(modal){
  const active = modal?.querySelector('.colab-tab.active');
  const key = active?.dataset?.tab || 'perfil';
  const idx = Math.max(0, WIZARD_STEPS.indexOf(key));
  return { key, idx };
}

function updateWizardFooter(modal){
  if (!modal) return;

  const { key, idx } = activeWizardStep(modal);
  modal.dataset.activeStep = key;

  const prev = modal.querySelector('#perfil-voltar-step');
  const next = modal.querySelector('#perfil-continuar-step');
  const saveFoot = modal.querySelector('#perfil-salvar-foot');
  const cancelFoot = modal.querySelector('#perfil-cancelar-foot');
  const closeFoot = modal.querySelector('#perfil-fechar2');
  const headerSave = modal.querySelector('#perfil-salvar');
  const headerEdit = modal.querySelector('#perfil-editar');
  const headerCancel = modal.querySelector('#perfil-cancelar');
  const title = modal.querySelector('#perfil-title');

  // Mantém os botões antigos no DOM para compatibilidade, mas eles não aparecem.
  [prev, next, saveFoot, cancelFoot, closeFoot, headerCancel].forEach(btn => {
    if (btn) btn.style.display = 'none';
  });

  const isEditing = modal.classList.contains('editing') || modal.dataset.mode === 'create';
  const isView = modal.dataset.mode === 'view' && !isEditing;
  const isLast = idx >= WIZARD_STEPS.length - 1;
  const isNovo = String(title?.textContent || '').toLowerCase().includes('novo') || modal.dataset.mode === 'create';

  if (headerEdit) {
    headerEdit.style.display = isView ? '' : 'none';
  }

  if (!headerSave) return;

  headerSave.style.display = isEditing ? 'inline-flex' : 'none';
  headerSave.dataset.wizardAction = isLast ? 'save' : 'next';
  headerSave.classList.remove('btn-soft-disabled');
  headerSave.removeAttribute('aria-disabled');

  if (!isEditing) return;

  if (isLast){
    headerSave.innerHTML = isNovo
      ? '<i class="fa-solid fa-check" aria-hidden="true"></i><span>Criar colaborador</span>'
      : '<i class="fa-solid fa-check" aria-hidden="true"></i><span>Salvar alterações</span>';
  } else {
    headerSave.innerHTML = '<span>Continuar</span><i class="fa-solid fa-arrow-right" aria-hidden="true"></i>';
  }
}

function goWizardStep(modal, key){
  const btn = modal?.querySelector('.colab-tab[data-tab="' + key + '"]');
  if (btn) btn.click();
  setTimeout(() => updateWizardFooter(modal), 20);
}

function bindWizardModal(){
  const { perfilModal } = els();
  const modal = perfilModal;

  if (!modal || modal.dataset.wizardBound === '1') return;
  modal.dataset.wizardBound = '1';

  const prev = modal.querySelector('#perfil-voltar-step');
  const next = modal.querySelector('#perfil-continuar-step');
  const save = modal.querySelector('#perfil-salvar-foot');
  const cancel = modal.querySelector('.wizard-footer-nav #perfil-cancelar-foot');
  const expCheck = modal.querySelector('#e-exp-personalizar');

  prev?.addEventListener('click', () => {
    const { idx } = activeWizardStep(modal);
    goWizardStep(modal, WIZARD_STEPS[Math.max(0, idx - 1)]);
  });

  next?.addEventListener('click', () => {
    const { idx } = activeWizardStep(modal);
    goWizardStep(modal, WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, idx + 1)]);
  });

  // Salvar/Cancelar são conectados em ensureFooterButtons().
  // Assim o clique não dispara duas vezes quando o modal entra em modo edição/criação.

  if (expCheck){
    const syncExp = () => modal.classList.toggle('exp-custom', !!expCheck.checked);
    expCheck.addEventListener('change', syncExp);
    syncExp();
  }

  modal.querySelectorAll('.colab-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      setTimeout(() => {
        updateWizardFooter(modal);
        ensureLazyEditStep(activeWizardStep(modal).key);
      }, 20);
    });
  });

  updateWizardFooter(modal);
}

export function bindModal(){
  if (state.didBindModal) return;
  state.didBindModal = true;

  bindWizardModal();

  const {
    perfilModal,
    pClose,
    pClose2,
    pEdit,
    pCancel,
    pSave
  } = els();

  pClose?.addEventListener('click', closePerfil);
  pClose2?.addEventListener('click', closePerfil);

  pEdit?.addEventListener('click', () => {
    if (!hasPerm(EDIT_PERM)) {
      toast('Sem permissão para editar.', 'warn');
      return;
    }

    enterInlineEdit();
  });

  pCancel?.addEventListener('click', () => {
    if (perfilModal?.dataset.mode === 'create') closePerfil();
    else exitInlineEdit(true);
  });

  pSave?.addEventListener('click', ev => {
    ev.preventDefault();

    const modal = els().perfilModal;
    const action = pSave.dataset.wizardAction || 'save';

    if (action === 'next') {
      const { idx } = activeWizardStep(modal);
      goWizardStep(modal, WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, idx + 1)]);
      return;
    }

    saveInline();
  });

  perfilModal?.addEventListener('mousedown', ev => {
    const card = perfilModal.querySelector('.modal-card');

    if (card && !card.contains(ev.target)) {
      closePerfil();
    }
  });

  perfilModal
    ?.querySelector('.modal-card')
    ?.addEventListener('mousedown', ev => ev.stopPropagation());

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && perfilModal?.getAttribute('aria-hidden') === 'false'){
      closePerfil();
    }
  });
}