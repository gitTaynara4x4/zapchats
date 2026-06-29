// frontend/js/pages/colaboradores/validacao.js

import { state } from './state.js';
import { els } from './dom.js';
import { digits, isValidTimeHHMM, timeToMinutes } from './helpers.js';
import { canEditPassword } from './permissions.js';

export function markValidity(input, isValid, message){
  if (!input) return;

  const wrap = input.closest('.fieldbox') || input.parentElement;

  input.classList.toggle('invalid', !isValid);
  input.setAttribute('aria-invalid', String(!isValid));

  if (!wrap) return;

  let err = wrap.nextElementSibling;

  if (!err || !err.classList.contains('field-error')) {
    err = document.createElement('div');
    err.className = 'field-error';
    wrap.insertAdjacentElement('afterend', err);
  }

  wrap.classList.toggle('invalid', !isValid);

  if (!isValid && message) {
    err.textContent = message;
    err.style.display = 'block';
  } else {
    err.textContent = '';
    err.style.display = 'none';
  }
}

export function clearValidationErrors(){
  document.querySelectorAll('#modal-perfil .field-error').forEach(el => {
    el.remove();
  });

  document
    .querySelectorAll('#modal-perfil .input.invalid, #modal-perfil .select.invalid, #modal-perfil .fieldbox.invalid')
    .forEach(el => {
      el.classList.remove('invalid');

      if (typeof el.removeAttribute === 'function') {
        el.removeAttribute('aria-invalid');
      }
    });
}

export function setSaveEnabled(ok){
  const { pSave } = els();

  [state.pSaveFoot, pSave].forEach(btn => {
    if (!btn) return;

    // Quando o botão do topo está como "Continuar", ele não pode parecer bloqueado.
    // A validação pesada fica para o último passo, quando a ação vira salvar/criar.
    const isNextAction = btn.dataset?.wizardAction === 'next';
    const allowed = isNextAction ? true : !!ok;

    btn.classList.toggle('btn-soft-disabled', !allowed);
    btn.setAttribute('aria-disabled', String(!allowed));
  });
}

export function getEditInputs(){
  return {
    eNome: document.querySelector('#e-nome'),
    eEmail: document.querySelector('#e-email'),
    eSetor: document.querySelector('#e-setor'),
    eTel: document.querySelector('#e-tel'),
    eCargo: document.querySelector('#e-cargo'),
    eExpIni: document.querySelector('#e-exp-ini'),
    eExpFim: document.querySelector('#e-exp-fim'),
    eExpPersonalizar: document.querySelector('#e-exp-personalizar')
  };
}

export function validateFormLive(forceShow){
  const { perfilModal } = els();

  const show = (typeof forceShow === 'boolean')
    ? forceShow
    : state.showErrors;

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

  const nome = eNome?.value.trim() || '';
  const email = (eEmail?.value || '').trim();
  const setor = eSetor?.value || '';
  const tel = eTel?.value || '';
  const cargo = eCargo?.value.trim() || '';
  const hIni = eExpIni?.value.trim() || '';
  const hFim = eExpFim?.value.trim() || '';
  const expOn = !!eExpPersonalizar?.checked;

  const msgs = [];

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const telDigits = digits(tel);
  const nomeOk = nome.length >= 2;
  const setorOk = !!setor;
  const telOk = telDigits.length >= 10;
  const cargoOk = cargo.length >= 2;

  if (!nomeOk) msgs.push('• Nome completo (mín. 2 letras)');
  if (!emailOk) msgs.push('• E-mail inválido');
  if (!setorOk) msgs.push('• Departamento (selecione um)');
  if (!telOk) msgs.push('• Telefone com DDD (10–11 dígitos)');
  if (!cargoOk) msgs.push('• Cargo (mín. 2 letras)');

  markValidity(eNome, show ? nomeOk : true, nomeOk ? '' : 'Nome completo (mín. 2 letras)');
  markValidity(eEmail, show ? emailOk : true, emailOk ? '' : 'E-mail inválido');
  markValidity(eSetor, show ? setorOk : true, setorOk ? '' : 'Selecione um departamento');
  markValidity(eTel, show ? telOk : true, telOk ? '' : 'Telefone com DDD (10–11 dígitos)');
  markValidity(eCargo, show ? cargoOk : true, cargoOk ? '' : 'Cargo (mín. 2 letras)');

  let hIniOk = true;
  let hFimOk = true;
  let hOrderOk = true;

  if (expOn){
    hIniOk = isValidTimeHHMM(hIni);
    hFimOk = isValidTimeHHMM(hFim);

    if (!hIniOk) msgs.push('• Entrada do expediente no formato HH:MM');
    if (!hFimOk) msgs.push('• Saída do expediente no formato HH:MM');

    if (hIniOk && hFimOk){
      const mi = timeToMinutes(hIni);
      const mf = timeToMinutes(hFim);

      if (mi != null && mf != null && mi >= mf){
        hOrderOk = false;
        msgs.push('• Início do expediente deve ser antes do fim');
      }
    }

    if (eExpIni){
      const okField = hIniOk && hOrderOk;

      markValidity(
        eExpIni,
        show ? okField : true,
        okField ? '' : 'Informe no formato HH:MM (ex.: 08:00)'
      );
    }

    if (eExpFim){
      const okField = hFimOk && hOrderOk;

      markValidity(
        eExpFim,
        show ? okField : true,
        okField ? '' : 'Informe no formato HH:MM (ex.: 18:00)'
      );
    }
  } else {
    if (eExpIni) markValidity(eExpIni, true, '');
    if (eExpFim) markValidity(eExpFim, true, '');

    hIniOk = true;
    hFimOk = true;
    hOrderOk = true;
  }

  let senhaOk = true;

  const senhaEl = document.querySelector('#e-senha');
  const isCreate = perfilModal?.dataset.mode === 'create';
  const canPass = canEditPassword();

  if (senhaEl && canPass) {
    const s = (senhaEl.value || '').trim();

    if (isCreate) {
      const activeStep = perfilModal?.dataset.activeStep || document.querySelector('#modal-perfil .colab-tab.active')?.dataset?.tab || 'perfil';
      const headerSave = document.querySelector('#perfil-salvar');
      const isFinalSave = headerSave?.dataset?.wizardAction === 'save';
      const shouldValidateSenha = activeStep === 'acessos' || activeStep === 'permissoes' || isFinalSave || show;

      senhaOk = shouldValidateSenha ? (s.length >= 6 && s.length <= 72) : true;

      if (shouldValidateSenha && !senhaOk) msgs.push('• Senha (mín. 6 caracteres)');

      markValidity(
        senhaEl,
        (show && shouldValidateSenha) ? senhaOk : true,
        senhaOk ? '' : 'Senha (mín. 6 caracteres)'
      );
    } else {
      if (s.length > 0) {
        senhaOk = s.length >= 6 && s.length <= 72;

        if (!senhaOk) msgs.push('• Senha (mín. 6 caracteres)');

        markValidity(
          senhaEl,
          show ? senhaOk : true,
          senhaOk ? '' : 'Senha (mín. 6 caracteres)'
        );
      } else {
        markValidity(senhaEl, true, '');
      }
    }
  } else if (senhaEl) {
    markValidity(senhaEl, true, '');
    senhaOk = true;
  }

  const ok =
    nomeOk &&
    emailOk &&
    setorOk &&
    telOk &&
    cargoOk &&
    senhaOk &&
    hIniOk &&
    hFimOk &&
    hOrderOk;

  setSaveEnabled(ok);

  return { ok, msgs };
}