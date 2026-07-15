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
  getInstsSelecionadasEdit
} from './instancias.js?v=colab-instancias-selection-20260711';
import {
  renderDepartamentosView,
  ensureDepartamentosEdit,
  getDepartamentosSelecionadosEdit
} from './departamentos.js';
import {
  ensurePermsEdit,
  getPermsSelecionadasEdit
} from './permissoes.js';
import {
  clearValidationErrors,
  validateFormLive,
  getEditInputs
} from './validacao.js?v=colab-required-20260713';
import { loadColaboradores, renderLista } from './lista.js';

let saveStatusTimer = null;

function getSaveStatusElements(modal = els().perfilModal){
  return {
    wrap: modal?.querySelector('#perfil-save-status') || null,
    title: modal?.querySelector('#perfil-save-status-title') || null,
    detail: modal?.querySelector('#perfil-save-status-detail') || null,
    saveButton: modal?.querySelector('#perfil-salvar-foot') || null
  };
}

function clearSaveStatus(){
  const modal = els().perfilModal;
  const { wrap } = getSaveStatusElements(modal);

  clearTimeout(saveStatusTimer);
  saveStatusTimer = null;

  if (wrap){
    wrap.hidden = true;
    wrap.classList.remove('is-loading', 'is-success', 'is-warning', 'is-error');
  }
}

function setSaveStatus(type, titleText, detailText = ''){
  const modal = els().perfilModal;
  const { wrap, title, detail } = getSaveStatusElements(modal);

  if (!wrap) return;

  wrap.hidden = false;
  wrap.classList.remove('is-loading', 'is-success', 'is-warning', 'is-error');
  wrap.classList.add(`is-${type || 'loading'}`);

  if (title) title.textContent = titleText || 'Salvando colaborador...';
  if (detail) {
    detail.textContent = detailText || '';
    detail.hidden = !detailText;
  }
}

function setModalControlsLocked(modal, locked){
  if (!modal) return;

  const controls = modal.querySelectorAll('button, input, select, textarea');

  controls.forEach(control => {
    if (locked){
      if (control.dataset.saveLock !== '1') {
        control.dataset.saveWasDisabled = control.disabled ? '1' : '0';
      }

      control.dataset.saveLock = '1';
      control.disabled = true;
      return;
    }

    if (control.dataset.saveLock === '1') {
      control.disabled = control.dataset.saveWasDisabled === '1';
      delete control.dataset.saveLock;
      delete control.dataset.saveWasDisabled;
    }
  });
}

function beginModalSave({ mode = 'edit', title, detail } = {}){
  const modal = els().perfilModal;
  if (!modal || state.saving) return false;

  clearTimeout(saveStatusTimer);
  saveStatusTimer = null;

  state.saving = true;
  modal.dataset.saving = '1';
  modal.classList.add('is-saving');
  modal.setAttribute('aria-busy', 'true');

  const isCreate = mode === 'create';
  const mainText = title || (isCreate ? 'Criando colaborador...' : 'Salvando alterações...');
  const detailText = detail || (
    isCreate
      ? 'Salvando dados, acessos e permissões.'
      : 'Atualizando os dados do colaborador.'
  );

  setSaveStatus('loading', mainText, detailText);
  setModalControlsLocked(modal, true);

  const { saveButton } = getSaveStatusElements(modal);
  if (saveButton){
    saveButton.style.display = 'inline-flex';
    saveButton.innerHTML = `
      <span class="colab-button-spinner" aria-hidden="true"></span>
      <span>${mainText}</span>
    `;
  }

  return true;
}

function updateModalSave(title, detail = ''){
  if (!state.saving) return;

  const modal = els().perfilModal;
  const { saveButton } = getSaveStatusElements(modal);

  setSaveStatus('loading', title, detail);

  if (saveButton){
    saveButton.innerHTML = `
      <span class="colab-button-spinner" aria-hidden="true"></span>
      <span>${title}</span>
    `;
  }
}

function finishModalSave({ type = 'success', title, detail = '', keepMs } = {}){
  const modal = els().perfilModal;

  state.saving = false;

  if (modal){
    delete modal.dataset.saving;
    modal.classList.remove('is-saving');
    modal.removeAttribute('aria-busy');
    setModalControlsLocked(modal, false);
    updateWizardFooter(modal);
  }

  setSaveStatus(type, title, detail);

  const delay = Number.isFinite(Number(keepMs))
    ? Number(keepMs)
    : (type === 'success' ? 2400 : 4200);

  clearTimeout(saveStatusTimer);
  saveStatusTimer = setTimeout(clearSaveStatus, delay);
}

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

        if (state.saving) return;

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
        if (state.saving) return;
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
  // O guia grande poluía o wizard. Agora a explicação fica no ícone de ajuda
  // do título da etapa Acesso. Também remove qualquer box antigo já injetado.
  const old = document.getElementById('zc-colab-access-guide');
  if (old) old.remove();

  const panelTitle = document.querySelector('#modal-perfil [data-panel="acessos"] .panel-title h3');
  if (!panelTitle) return null;

  let help = panelTitle.querySelector('#acesso-help-icon') || panelTitle.querySelector('#zc-colab-access-help');
  if (!help) {
    help = document.createElement('span');
    help.id = 'zc-colab-access-help';
    help.className = 'zc-help-icon';
    help.tabIndex = 0;
    help.setAttribute('role', 'button');
    help.setAttribute('aria-label', 'Ajuda sobre acesso no atendimento');
    help.innerHTML = '<i class="fa-regular fa-circle-question" aria-hidden="true"></i>';
    panelTitle.appendChild(help);
  }

  help.dataset.help = 'Para ver uma conversa, o colaborador precisa ter acesso ao WhatsApp onde a mensagem chegou e ao departamento da conversa. Permissões definem ações como ver atendimento, enviar mensagem ou gerenciar equipe.';
  return help;
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

function updateProfilePreview({ nome = '', cargo = '', empresa = '', departamento = '' } = {}){
  const nameEl = document.querySelector('#side-preview-name');
  const roleEl = document.querySelector('#side-preview-role');
  const companyEl = document.querySelector('#side-preview-company');
  const deptEl = document.querySelector('#side-preview-dept');

  if (nameEl) nameEl.textContent = String(nome || '').trim() || 'Novo colaborador';
  if (roleEl) roleEl.textContent = String(cargo || '').trim() || 'Personalize o perfil do colaborador';
  if (companyEl) companyEl.textContent = String(empresa || '').trim() || 'Empresa atual';
  if (deptEl) deptEl.textContent = String(departamento || '').trim() || 'Não definido';
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
  clearWizardStepErrors(perfilModal);

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
      : 'Gerencie dados, acesso e permissões deste colaborador';
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

  updateProfilePreview({
    nome,
    cargo: adm ? 'Administrador' : cargoVal,
    empresa: empresa?.nome || '',
    departamento: depName || ''
  });

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
    avatarHint.style.display = isCreate ? '' : 'none';
  }

  applyAccessModeUI();

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


function getAcessoModo(){
  const checked = document.querySelector('#modal-perfil input[name="acesso_modo"]:checked');
  const value = String(checked?.value || '').trim().toLowerCase();

  if (value === 'manual') return 'manual';
  if (value === 'convite') return 'convite';

  // Na edição nenhuma opção começa selecionada. Isso significa manter a senha atual.
  return 'manter';
}

function getAccessEmailCopy(isCreate){
  if (isCreate) {
    return {
      label: 'Enviar convite por e-mail',
      description: 'O colaborador cria a própria senha pelo e-mail.',
      help: 'O colaborador recebe um convite no e-mail cadastrado e cria a própria senha.'
    };
  }

  if (!state.viewing?.usuario_id && !state.viewing?.tem_usuario) {
    return {
      label: 'Enviar convite por e-mail',
      description: 'Cria o acesso e envia o link para definir a senha.',
      help: 'Como este colaborador ainda não possui usuário de acesso, o sistema criará o login e enviará um convite por e-mail.'
    };
  }

  if (state.viewing?.convite_pendente) {
    return {
      label: 'Reenviar convite por e-mail',
      description: 'Gera um novo código e reenvia o convite.',
      help: 'O convite anterior será substituído por um novo código de confirmação enviado ao e-mail cadastrado.'
    };
  }

  return {
    label: 'Enviar link de redefinição por e-mail',
    description: 'O colaborador define uma nova senha pelo e-mail.',
    help: 'Envia um novo código para o colaborador redefinir a própria senha com segurança.'
  };
}

function resetAccessModeSelection(){
  const { perfilModal } = els();
  const isCreate = perfilModal?.dataset.mode === 'create';
  const conviteRadio = document.querySelector('#acesso-modo-convite');
  const manualRadio = document.querySelector('#acesso-modo-manual');
  const senhaInput = document.querySelector('#e-senha');

  if (conviteRadio) conviteRadio.checked = !!isCreate;
  if (manualRadio) manualRadio.checked = false;

  if (senhaInput) {
    senhaInput.value = '';
    senhaInput.type = 'password';
  }

  const toggleIcon = document.querySelector('#toggle-senha i');
  if (toggleIcon) {
    toggleIcon.classList.add('fa-eye');
    toggleIcon.classList.remove('fa-eye-slash');
  }
}

function applyAccessModeUI(){
  const { perfilModal } = els();
  const isCreate = perfilModal?.dataset.mode === 'create';
  const isEditing = isCreate || state.inlineEdit || perfilModal?.classList.contains('editing');
  const canPass = canEditPassword();
  let modo = getAcessoModo();

  const manualRadio = document.querySelector('#acesso-modo-manual');
  const conviteRadio = document.querySelector('#acesso-modo-convite');
  const accessTitle = document.querySelector('#access-mode-title');
  const accessModeHelp = document.querySelector('#access-mode-help');
  const emailLabel = document.querySelector('#access-email-label');
  const emailDescription = document.querySelector('#access-email-description');
  const emailHelp = document.querySelector('#access-email-help');
  const manualLabel = document.querySelector('#access-manual-label');
  const manualDescription = document.querySelector('#access-manual-description');
  const manualHelp = document.querySelector('#access-manual-help');

  const emailCopy = getAccessEmailCopy(isCreate);

  if (accessTitle) accessTitle.textContent = isCreate ? 'Forma de acesso' : 'Alterar acesso ou senha';
  if (emailLabel) emailLabel.textContent = emailCopy.label;
  if (emailDescription) emailDescription.textContent = emailCopy.description;
  if (emailHelp) emailHelp.dataset.help = emailCopy.help;

  if (manualLabel) {
    manualLabel.textContent = isCreate
      ? 'Definir senha manualmente'
      : 'Definir nova senha temporária';
  }

  if (manualDescription) {
    manualDescription.textContent = isCreate
      ? 'Cria uma senha temporária e exige a troca depois.'
      : 'Substitui a senha atual e exige uma nova troca no próximo acesso.';
  }

  if (manualHelp) {
    manualHelp.dataset.help = isCreate
      ? 'Use somente quando o colaborador não consegue acessar o e-mail agora. A senha é temporária e o sistema exige troca no primeiro acesso.'
      : 'A senha atual será substituída por uma senha temporária. No próximo acesso, o colaborador será direcionado para criar uma nova senha pessoal.';
  }

  if (accessModeHelp) {
    accessModeHelp.dataset.help = isCreate
      ? 'Escolha como o primeiro acesso será criado. Convite por e-mail é a opção recomendada.'
      : 'Nenhuma opção começa marcada. Escolha uma delas apenas quando quiser alterar o acesso ou a senha; caso contrário, a senha atual será mantida.';
  }

  if (manualRadio) manualRadio.disabled = !canPass;
  if (conviteRadio) conviteRadio.disabled = !canPass;

  if (!canPass) {
    if (manualRadio) manualRadio.checked = false;
    if (conviteRadio) conviteRadio.checked = false;
    modo = 'manter';
  }

  const grid = document.querySelector('#access-mode-grid');
  const manualPanel = document.querySelector('#manual-senha-panel');
  const wrapSenha = document.querySelector('#wrap-senha');
  const senhaHelp = document.querySelector('#senha-help');
  const senhaInput = document.querySelector('#e-senha');

  if (grid) grid.style.display = (isEditing && canPass) ? 'grid' : 'none';

  const showManual = isEditing && canPass && modo === 'manual';

  if (manualPanel) manualPanel.style.display = showManual ? 'block' : 'none';
  if (wrapSenha) wrapSenha.style.display = showManual ? 'flex' : 'none';

  if (!showManual && senhaInput) senhaInput.value = '';

  if (senhaInput) {
    senhaInput.placeholder = isCreate
      ? 'Defina a senha temporária'
      : 'Digite a nova senha temporária';
    senhaInput.required = showManual;
    senhaInput.setAttribute('aria-required', String(showManual));
  }

  if (senhaHelp) {
    senhaHelp.style.display = isEditing ? 'block' : 'none';

    if (!isEditing) {
      senhaHelp.textContent = '';
    } else if (!canPass) {
      senhaHelp.textContent = 'Você não possui permissão para redefinir a senha deste colaborador.';
    } else if (isCreate) {
      senhaHelp.textContent = modo === 'manual'
        ? 'Defina uma senha temporária de 6 a 72 caracteres. O colaborador será obrigado a criar outra senha no primeiro acesso.'
        : 'O colaborador receberá um convite por e-mail para criar a própria senha.';
    } else if (modo === 'manual') {
      senhaHelp.textContent = 'Digite uma nova senha temporária. A senha atual será substituída e o colaborador deverá trocá-la no próximo acesso.';
    } else if (modo === 'convite') {
      senhaHelp.textContent = emailCopy.label + '. A senha atual não será exibida nem enviada.';
    } else {
      senhaHelp.textContent = 'Escolha uma opção somente se quiser alterar o acesso ou a senha. Sem seleção, a senha atual será mantida.';
    }
  }

  const acessoHelp = document.querySelector('#acesso-help-icon');
  if (acessoHelp) {
    acessoHelp.dataset.help = isCreate
      ? 'Configure como o colaborador criará a senha e quais atendimentos poderá acessar.'
      : 'A edição não altera a senha automaticamente. Selecione e-mail ou senha temporária apenas quando quiser redefinir o acesso.';
  }
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

  // Sempre remonta departamentos, WhatsApps e permissões ao iniciar uma nova edição.
  // Sem isso, uma flag antiga podia impedir a restauração dos checks.
  resetLazyEditFlags();

  ensureAccessExplanationBox();

  if (pEdit) pEdit.style.display = 'none';
  if (pSave) pSave.style.display = 'none';
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

  // Exibe o editor de foto somente quando o perfil está realmente em edição.
  // A sidebar estava escondida pelo CSS final da página e o hint também era
  // mantido como display:none, por isso não havia nenhuma ação visível.
  const avatarHintEdit = document.querySelector('#avatar-hint');
  const avatarButtonEdit = document.querySelector('#btn-add-avatar');

  if (avatarHintEdit) avatarHintEdit.style.display = '';

  if (avatarButtonEdit) {
    const label = avatarButtonEdit.querySelector('strong');
    const help = avatarButtonEdit.querySelector('small');
    const hasAvatar = Boolean(
      state.newAvatarFile ||
      state.viewing?.avatar_url ||
      document.querySelector('#p-avatar')?.getAttribute('src')
    );

    if (label) label.textContent = hasAvatar ? 'Alterar foto' : 'Adicionar foto';
    if (help) help.textContent = 'JPG, PNG ou WEBP de até 5 MB';
  }

  bindAvatarDnDAndPaste();

  swapFieldbox(
    'fb-nome',
    `<input id="e-nome" class="input" type="text" maxlength="120" required autocomplete="off" placeholder="Seu nome completo">`
  );

  swapFieldbox(
    'fb-email',
    `<input id="e-email" class="input" type="email" maxlength="160" required autocomplete="off" placeholder="nome@empresa.com">`
  );

  // Departamento principal foi removido do cadastro.
  // A fonte oficial agora é "Departamentos que atende" em departamentos_membros.
  const sel = null;

  swapFieldbox(
    'fb-tel',
    `<input id="e-tel" class="input" type="tel" inputmode="numeric" placeholder="(DD) 9 9999-9999">`
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

  const syncProfilePreview = () => {
    updateProfilePreview({
      nome: $('#e-nome')?.value || '',
      cargo: $('#e-cargo')?.value || '',
      empresa: document.querySelector('#v-empresa')?.textContent || '',
      departamento: document.querySelector('#side-preview-dept')?.textContent || ''
    });
  };

  ['#e-nome', '#e-cargo'].forEach(selector => {
    const input = document.querySelector(selector);
    if (input) input.addEventListener('input', syncProfilePreview);
  });
  syncProfilePreview();

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

  resetAccessModeSelection();
  applyAccessModeUI();

  const toggle = $('#toggle-senha');
  const canPass = canEditPassword();

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

  const avatarHintView = document.querySelector('#avatar-hint');
  if (avatarHintView) {
    avatarHintView.style.display = 'none';
  }

  resetLazyEditFlags();

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

  if (state.saving) return;

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
    eTel,
    eCargo,
    eExpIni,
    eExpFim,
    eExpPersonalizar
  } = getEditInputs();

  const nome = eNome?.value.trim();
  const email = eEmail?.value.trim();
  const tel = eTel?.value || '';
  const cargo = eCargo?.value || '';
  const expOn = !!eExpPersonalizar?.checked;
  const hIni = expOn ? (eExpIni?.value.trim() || '') : '';
  const hFim = expOn ? (eExpFim?.value.trim() || '') : '';

  state.showErrors = true;

  const check = validateFormLive(true, { scope: 'all' });

  if (!check.ok){
    markWizardStepErrors(perfilModal, check.fields);

    const firstInvalid = check.fields?.[0] ||
      perfilModal?.querySelector('[aria-invalid="true"]');
    const targetStep = wizardStepForField(firstInvalid);

    focusValidationField(perfilModal, firstInvalid, targetStep);

    toast('Corrija os campos:\n' + check.msgs.join('\n'), 'warn');
    return;
  }

  clearWizardStepErrors(perfilModal);

  const instsSel = getInstsSelecionadasEdit();
  const deptosSel = getDepartamentosSelecionadosEdit();
  const permsSel = getPermsSelecionadasEdit();

  const usaAtendimento = permsSel.some(perm => {
    const idPerm = String(perm || '').trim().toLowerCase();
    return idPerm === 'atendimento.ver' || idPerm === 'atendimento.enviar';
  });

  if (usaAtendimento && !instsSel.length) {
    goWizardStep(perfilModal, 'acessos');

    setTimeout(() => {
      const warning = document.querySelector('#inst-selection-warning');
      if (warning) warning.hidden = false;

      document.querySelector('#inst-select-all')?.focus?.();
    }, 80);

    toast(
      'Selecione pelo menos um WhatsApp para este colaborador atender. Para liberar todos, clique em “Selecionar todos”.',
      'warn'
    );
    return;
  }

  const departamentoPrincipalId = deptosSel.length ? deptosSel[0] : null;
  const horarioModo = buildHorarioModoPayload(departamentoPrincipalId, expOn);
  const acessoModo = getAcessoModo();
  const senhaEl = document.querySelector('#e-senha');
  const newPass = (senhaEl?.value || '').trim();

  if (acessoModo === 'manual') {
    if (!canPass) {
      toast(
        mode === 'create'
          ? 'Você não tem permissão para definir senha deste colaborador.'
          : 'Você não tem permissão para redefinir a senha deste colaborador.',
        'warn'
      );
      return;
    }

    if (newPass.length < 6 || newPass.length > 72) {
      goWizardStep(perfilModal, 'acessos');
      toast(
        mode === 'create'
          ? 'Defina uma senha temporária entre 6 e 72 caracteres.'
          : 'Defina uma nova senha temporária entre 6 e 72 caracteres.',
        'warn'
      );
      senhaEl?.focus?.();
      return;
    }
  }

  if (mode === 'create'){
    const fd = new FormData();

    fd.append('nome', nome);
    fd.append('email', email);
    fd.append('telefone', telE164(tel));
    fd.append('cargo', (cargo || '').trim());
    fd.append('horario_modo', horarioModo);
    fd.append('modo_acesso', acessoModo);

    // Cria também o usuário de login vinculado ao colaborador.
    // Convite por e-mail é o padrão; senha manual vira senha temporária.
    fd.append('criar_usuario', 'true');

    if (departamentoPrincipalId) {
      // Compatibilidade: backend antigo pode usar setor_id como fallback,
      // mas a regra oficial fica em departamentos_ids[].
      fd.append('setor_id', String(Number(departamentoPrincipalId)));
    }

    if (expOn){
      fd.append('hora_login_inicio', hIni);
      fd.append('hora_login_fim', hFim);
    }

    if (acessoModo === 'manual') {
      fd.append('senha', newPass);
      fd.append('forcar_troca_senha', 'true');
    }

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

    if (!beginModalSave({
      mode: 'create',
      title: 'Criando colaborador...',
      detail: 'Salvando dados, acessos, permissões e foto de perfil.'
    })) return;

    try {
      const created = await apiForm('/api/colaboradores/', 'POST', fd);

      if (!created?.id) {
        throw new Error('A API não retornou o colaborador criado.');
      }

      updateModalSave(
        'Atualizando a equipe...',
        'O cadastro foi concluído. Estamos atualizando a lista de colaboradores.'
      );

      if (state.newAvatarFile) {
        invalidateAvatarThumb(created.id);
      }

      const fresh = {
        ...created,
        instancias_ids: instsSel,
        departamentos_ids: deptosSel,
        permissoes: permsSel,
        hora_login_inicio: expOn ? (hIni || null) : null,
        hora_login_fim: expOn ? (hFim || null) : null,
        horario_modo: horarioModo
      };

      state.newAvatarFile = null;
      state.showErrors = false;
      state.viewing = fresh;

      perfilModal.dataset.mode = 'view';
      perfilModal.dataset.currentId = String(created.id);

      await loadColaboradores();
      renderLista();

      exitInlineEdit(false);
      await renderPerfilView(fresh);

      const conviteFalhou = acessoModo === 'convite'
        && created?.convite_email_solicitado === true
        && created?.convite_email_enviado === false;

      if (conviteFalhou) {
        const detalheEmail = created?.convite_email_erro
          || 'O convite não pôde ser enviado agora. Abra o perfil e use “Reenviar convite por e-mail”.';

        finishModalSave({
          type: 'warning',
          title: 'Colaborador criado, mas o e-mail não foi enviado',
          detail: detalheEmail,
          keepMs: 6500
        });

        toast(`Colaborador criado. ${detalheEmail}`, 'warn');
      } else {
        const successDetail = acessoModo === 'manual'
          ? 'A senha temporária foi criada e deverá ser alterada no primeiro acesso.'
          : 'O convite de acesso foi enviado para o e-mail cadastrado.';

        finishModalSave({
          type: 'success',
          title: 'Colaborador criado com sucesso',
          detail: successDetail
        });

        toast(
          acessoModo === 'manual'
            ? 'Colaborador criado. Ele deverá trocar a senha no primeiro acesso.'
            : 'Colaborador criado e convite enviado por e-mail.'
        );
      }
    } catch (e) {
      console.error('[create error]', e?.status, e?.data || e);

      const apiMessage = (e?.data && (
        e.data.detail ||
        e.data.message ||
        (typeof e.data === 'string' ? e.data : '')
      )) || null;

      let userMessage = apiMessage || 'Tente novamente em alguns instantes.';

      if (e?.status === 409) userMessage = 'Este e-mail já está cadastrado.';
      if (e?.status === 422) userMessage = apiMessage || 'Confira os dados informados.';

      finishModalSave({
        type: 'error',
        title: 'Não foi possível criar o colaborador',
        detail: userMessage
      });

      toast(userMessage, e?.status === 409 || e?.status === 422 ? 'warn' : 'err');
    }

    return;
  }

  const payload = {
    nome,
    email,
    telefone: telE164(tel),
    cargo: (cargo || '').trim(),
    instancias_ids: instsSel,
    departamentos_ids: deptosSel,
    permissoes: permsSel,
    atualizar_usuario: !!state.viewing?.usuario_id,
    horario_modo: horarioModo,
    setor_id: departamentoPrincipalId ? Number(departamentoPrincipalId) : null,
    hora_login_inicio: expOn ? (hIni || null) : null,
    hora_login_fim: expOn ? (hFim || null) : null
  };

  if (acessoModo === 'manual') {
    payload.senha = newPass;
    payload.atualizar_usuario = true;
    payload.forcar_troca_senha = true;
  }

  if (!beginModalSave({
    mode: 'edit',
    title: 'Salvando alterações...',
    detail: 'Atualizando dados, departamentos, WhatsApps e permissões.'
  })) return;

  let accessEmailSent = false;
  let accessEmailFailed = false;
  let avatarUploadFailed = false;

  try {
    const updated = await apiJSON(`/api/colaboradores/${id}`, 'PUT', payload);

    if (acessoModo === 'convite') {
      updateModalSave(
        'Enviando e-mail de acesso...',
        'Os dados já foram salvos. Agora estamos enviando o link ao colaborador.'
      );

      try {
        await apiJSON(`/api/colaboradores/${id}/enviar-acesso-email`, 'POST', {});
        accessEmailSent = true;
      } catch (emailError) {
        accessEmailFailed = true;
        console.warn('Erro ao enviar acesso por e-mail', emailError);
      }
    }

    if (state.newAvatarFile){
      updateModalSave(
        'Enviando foto de perfil...',
        'Finalizando a atualização do colaborador.'
      );

      let upOK = false;

      // O endpoint do colaborador é a fonte principal da tela de equipe e já
      // sincroniza a mesma imagem com o usuário de login. Mantemos a rota de
      // usuário apenas como fallback para instalações antigas.
      upOK = await uploadAvatarTo(`/api/colaboradores/${id}/avatar`, state.newAvatarFile);

      if (!upOK && state.viewing?.usuario_id){
        upOK = await uploadAvatarTo(`/api/usuarios/${state.viewing.usuario_id}/avatar`, state.newAvatarFile);
      }

      if (upOK){
        invalidateAvatarThumb(id);
        state.newAvatarFile = null;
      } else {
        avatarUploadFailed = true;
      }
    }

    updateModalSave(
      'Atualizando a equipe...',
      'As alterações foram salvas. Estamos atualizando a lista de colaboradores.'
    );

    const fresh = {
      ...(state.viewing || {}),
      ...(updated || {}),
      instancias_ids: instsSel,
      departamentos_ids: deptosSel,
      permissoes: permsSel,
      hora_login_inicio: expOn ? (hIni || null) : null,
      hora_login_fim: expOn ? (hFim || null) : null,
      horario_modo: horarioModo
    };

    state.showErrors = false;
    state.viewing = fresh;

    await loadColaboradores();
    renderLista();

    exitInlineEdit(false);
    await renderPerfilView(fresh);

    const warnings = [];
    if (accessEmailFailed) warnings.push('O e-mail de acesso não pôde ser enviado.');
    if (avatarUploadFailed) warnings.push('A foto de perfil não pôde ser enviada.');

    if (warnings.length) {
      finishModalSave({
        type: 'warning',
        title: 'Alterações salvas com uma pendência',
        detail: warnings.join(' ')
      });
      toast(`Alterações salvas. ${warnings.join(' ')}`, 'warn');
    } else {
      const successParts = ['Dados atualizados com sucesso.'];
      if (acessoModo === 'manual') successParts.push('Nova senha temporária definida.');
      if (accessEmailSent) successParts.push('E-mail de acesso enviado.');

      finishModalSave({
        type: 'success',
        title: 'Alterações salvas',
        detail: successParts.join(' ')
      });
      toast(successParts.join(' '));
    }
  } catch (e) {
    console.error('[colaboradores/save]', e);

    let userMessage = 'Tente novamente em alguns instantes.';

    if (e?.status === 409) userMessage = 'Este e-mail já está cadastrado.';
    if (e?.status === 404) userMessage = 'O colaborador não foi encontrado.';
    if (e?.status === 422) {
      userMessage = e?.data?.detail || e?.data?.message || 'Confira os dados informados.';
    }

    finishModalSave({
      type: 'error',
      title: 'Não foi possível salvar as alterações',
      detail: userMessage
    });

    toast(userMessage, e?.status === 409 || e?.status === 422 ? 'warn' : 'err');
  }
}

export async function openPerfil(id){
  const { perfilModal, pEdit } = els();

  clearSaveStatus();

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

  if (state.saving) return;

  clearSaveStatus();
  clearValidationErrors();
  clearWizardStepErrors(perfilModal);
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

  clearSaveStatus();

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

  applyAccessModeUI();

  const toggle = document.querySelector('#toggle-senha');
  const canPass = canEditPassword();

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

function wizardStepForField(field){
  const id = String(field?.id || '');

  if (id === 'e-senha' || field?.closest?.('[data-panel="acessos"]')) {
    return 'acessos';
  }

  if (field?.closest?.('[data-panel="permissoes"]')) {
    return 'permissoes';
  }

  return 'perfil';
}

function clearWizardStepErrors(modal){
  modal?.querySelectorAll('.colab-tab.has-error').forEach(tab => {
    tab.classList.remove('has-error');
  });
}

function markWizardStepErrors(modal, fields = []){
  clearWizardStepErrors(modal);

  fields.forEach(field => {
    const step = wizardStepForField(field);
    modal?.querySelector(`.colab-tab[data-tab="${step}"]`)?.classList.add('has-error');
  });
}

function focusValidationField(modal, field, stepKey){
  if (!field) return;

  const targetStep = stepKey || wizardStepForField(field);
  const currentStep = activeWizardStep(modal).key;

  if (targetStep && currentStep !== targetStep) {
    goWizardStep(modal, targetStep);
  }

  window.setTimeout(() => {
    const target = document.getElementById(field.id) || field;
    const scrollTarget = target?.closest?.('.fieldbox') || target;

    try {
      scrollTarget?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    } catch {
      scrollTarget?.scrollIntoView?.();
    }

    window.setTimeout(() => {
      try {
        target?.focus?.({ preventScroll: true });
      } catch {
        target?.focus?.();
      }
    }, 120);
  }, 60);
}

function validateWizardStep(modal, stepKey, { notify = true, focus = true } = {}){
  let check = { ok: true, msgs: [], fields: [] };

  if (stepKey === 'perfil') {
    check = validateFormLive(true, { scope: 'perfil' });
  } else if (stepKey === 'acessos') {
    check = validateFormLive(true, { scope: 'acessos' });
  }

  const tab = modal?.querySelector(`.colab-tab[data-tab="${stepKey}"]`);
  tab?.classList.toggle('has-error', !check.ok);

  if (!check.ok) {
    if (notify) {
      toast(
        'Preencha os campos obrigatórios antes de continuar:\n' + check.msgs.join('\n'),
        'warn'
      );
    }

    if (focus) {
      focusValidationField(modal, check.fields?.[0], stepKey);
    }
  }

  return check;
}

function updateWizardFooter(modal){
  if (!modal) return;
  if (state.saving || modal.dataset.saving === '1') return;

  const { key, idx } = activeWizardStep(modal);
  modal.dataset.activeStep = key;

  const prev = modal.querySelector('#perfil-voltar-step');
  const next = modal.querySelector('#perfil-continuar-step');
  const saveFoot = modal.querySelector('#perfil-salvar-foot');
  const cancelFoot = modal.querySelector('#perfil-cancelar-foot');
  const closeFoot = modal.querySelector('#perfil-fechar2');
  const legacySave = modal.querySelector('#perfil-salvar');
  const editButton = modal.querySelector('#perfil-editar');
  const legacyCancel = modal.querySelector('#perfil-cancelar');
  const title = modal.querySelector('#perfil-title');

  [prev, next, saveFoot, cancelFoot, closeFoot, legacySave, editButton, legacyCancel].forEach(btn => {
    if (btn) btn.style.display = 'none';
  });

  const isEditing = modal.classList.contains('editing') || modal.dataset.mode === 'create';
  const isView = modal.dataset.mode === 'view' && !isEditing;
  const isLast = idx >= WIZARD_STEPS.length - 1;
  const isNovo = String(title?.textContent || '').toLowerCase().includes('novo') || modal.dataset.mode === 'create';

  if (isView){
    if (closeFoot) closeFoot.style.display = 'inline-flex';
    if (editButton && hasPerm(EDIT_PERM)) editButton.style.display = 'inline-flex';
    return;
  }

  if (!isEditing) return;

  if (cancelFoot) cancelFoot.style.display = 'inline-flex';

  if (idx > 0 && prev) {
    prev.style.display = 'inline-flex';
  }

  if (!isLast && next){
    next.style.display = 'inline-flex';
    next.innerHTML = '<span>Continuar</span><i class="fa-solid fa-arrow-right" aria-hidden="true"></i>';
  }

  if (isLast && saveFoot){
    saveFoot.style.display = 'inline-flex';
    saveFoot.innerHTML = isNovo
      ? '<i class="fa-solid fa-check" aria-hidden="true"></i><span>Criar colaborador</span>'
      : '<i class="fa-solid fa-check" aria-hidden="true"></i><span>Salvar alterações</span>';
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
  const acessoRadios = Array.from(modal.querySelectorAll('input[name="acesso_modo"]'));

  // Impede avançar enquanto os campos obrigatórios da etapa atual estiverem
  // incompletos. O listener em captura roda antes do controle visual das abas.
  modal.addEventListener('click', ev => {
    const tab = ev.target.closest('.colab-tab');
    if (!tab || !modal.contains(tab)) return;

    if (state.saving) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }

    const { key: currentKey, idx: currentIdx } = activeWizardStep(modal);
    const targetKey = tab.dataset.tab || currentKey;
    const targetIdx = WIZARD_STEPS.indexOf(targetKey);

    if (targetIdx <= currentIdx) return;

    const check = validateWizardStep(modal, currentKey, {
      notify: true,
      focus: true
    });

    if (!check.ok) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }

    // Não permite pular uma etapa pelo cabeçalho. Se a etapa atual estiver
    // válida, segue para a próxima etapa na ordem 1 → 2 → 3.
    if (targetIdx > currentIdx + 1) {
      ev.preventDefault();
      ev.stopImmediatePropagation();

      window.setTimeout(() => {
        goWizardStep(modal, WIZARD_STEPS[currentIdx + 1]);
      }, 0);
    }
  }, true);

  acessoRadios.forEach(radio => {
    if (radio.dataset.boundAccessMode === '1') return;
    radio.dataset.boundAccessMode = '1';
    radio.addEventListener('change', () => {
      applyAccessModeUI();
      validateFormLive(false);
    });
  });


  if (modal.dataset.boundDeptChangeHint !== '1') {
    modal.dataset.boundDeptChangeHint = '1';
    document.addEventListener('colaboradores:departamentos-change', () => {
      applyExpPersonalizarUI();
      validateFormLive(false);
    });
  }

  prev?.addEventListener('click', () => {
    if (state.saving) return;
    const { idx } = activeWizardStep(modal);
    goWizardStep(modal, WIZARD_STEPS[Math.max(0, idx - 1)]);
  });

  next?.addEventListener('click', () => {
    if (state.saving) return;
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
    if (state.saving) return;
    if (perfilModal?.dataset.mode === 'create') closePerfil();
    else exitInlineEdit(true);
  });

  pSave?.addEventListener('click', ev => {
    ev.preventDefault();

    if (state.saving) return;

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