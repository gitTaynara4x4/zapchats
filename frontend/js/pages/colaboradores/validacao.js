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

export function validateFormLive(forceShow, options = {}){
  const { perfilModal } = els();

  const show = (typeof forceShow === 'boolean')
    ? forceShow
    : state.showErrors;

  const scope = String(options?.scope || 'all').toLowerCase();
  const validateProfile = scope === 'all' || scope === 'perfil';
  const validateAccess = scope === 'all' || scope === 'acessos';

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
  const tel = eTel?.value || '';
  const cargo = eCargo?.value.trim() || '';
  const hIni = eExpIni?.value.trim() || '';
  const hFim = eExpFim?.value.trim() || '';
  const expOn = !!eExpPersonalizar?.checked;

  const msgs = [];
  const fields = [];

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const telDigits = digits(tel);
  const nomeOk = nome.length >= 2;
  const telOk = !telDigits.length || telDigits.length >= 10;
  const cargoOk = cargo.length >= 2;

  if (validateProfile) {
    if (!nomeOk) {
      msgs.push('• Nome completo (mín. 2 letras)');
      if (eNome) fields.push(eNome);
    }

    if (!emailOk) {
      msgs.push('• E-mail inválido');
      if (eEmail) fields.push(eEmail);
    }

    if (!telOk) {
      msgs.push('• Telefone com DDD (10–11 dígitos), se informado');
      if (eTel) fields.push(eTel);
    }

    if (!cargoOk) {
      msgs.push('• Cargo (mín. 2 letras)');
      if (eCargo) fields.push(eCargo);
    }

    markValidity(eNome, show ? nomeOk : true, nomeOk ? '' : 'Nome completo (mín. 2 letras)');
    markValidity(eEmail, show ? emailOk : true, emailOk ? '' : 'E-mail inválido');
    markValidity(eSetor, true, '');
    markValidity(eTel, show ? telOk : true, telOk ? '' : 'Telefone com DDD (10–11 dígitos)');
    markValidity(eCargo, show ? cargoOk : true, cargoOk ? '' : 'Cargo (mín. 2 letras)');
  }

  let hIniOk = true;
  let hFimOk = true;
  let hOrderOk = true;

  if (validateProfile && expOn){
    hIniOk = isValidTimeHHMM(hIni);
    hFimOk = isValidTimeHHMM(hFim);

    if (!hIniOk) {
      msgs.push('• Entrada do expediente no formato HH:MM');
      if (eExpIni) fields.push(eExpIni);
    }

    if (!hFimOk) {
      msgs.push('• Saída do expediente no formato HH:MM');
      if (eExpFim) fields.push(eExpFim);
    }

    if (hIniOk && hFimOk){
      const mi = timeToMinutes(hIni);
      const mf = timeToMinutes(hFim);

      if (mi != null && mf != null && mi >= mf){
        hOrderOk = false;
        msgs.push('• Início do expediente deve ser antes do fim');
        if (eExpIni && !fields.includes(eExpIni)) fields.push(eExpIni);
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
  } else if (validateProfile) {
    if (eExpIni) markValidity(eExpIni, true, '');
    if (eExpFim) markValidity(eExpFim, true, '');
  }

  let senhaOk = true;

  const senhaEl = document.querySelector('#e-senha');
  const isCreate = perfilModal?.dataset.mode === 'create';
  const canPass = canEditPassword();
  const acessoModo = document.querySelector('#modal-perfil input[name="acesso_modo"]:checked')?.value || (isCreate ? 'convite' : 'manter');

  if (senhaEl && canPass && validateAccess) {
    const s = (senhaEl.value || '').trim();
    const senhaManual = acessoModo === 'manual';

    senhaOk = senhaManual ? (s.length >= 6 && s.length <= 72) : true;

    if (!senhaOk) {
      msgs.push('• Senha temporária (mín. 6 caracteres)');
      fields.push(senhaEl);
    }

    markValidity(
      senhaEl,
      show ? senhaOk : true,
      senhaOk ? '' : 'Senha temporária (mín. 6 caracteres)'
    );
  } else if (senhaEl && validateAccess) {
    markValidity(senhaEl, true, '');
    senhaOk = true;
  }

  const profileOk = nomeOk && emailOk && telOk && cargoOk && hIniOk && hFimOk && hOrderOk;
  const accessOk = senhaOk;
  const ok =
    (validateProfile ? profileOk : true) &&
    (validateAccess ? accessOk : true);

  // O botão de salvar só representa o formulário completo. A validação de uma
  // etapa isolada não deve habilitar/desabilitar o salvamento final por engano.
  if (scope === 'all') {
    setSaveEnabled(ok);
  }

  return { ok, msgs, fields, scope };
}

