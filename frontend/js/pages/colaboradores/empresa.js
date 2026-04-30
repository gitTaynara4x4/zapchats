// frontend/js/pages/colaboradores/empresa.js

import { apiGet, apiJSON } from './api.js';
import { EMPRESA_ID, state } from './state.js';
import { els } from './dom.js';
import { toast } from './feedback.js';

export async function loadEmpresa(force = false){
  if (!EMPRESA_ID) return null;
  if (!force && state.empresa) return state.empresa;

  const { chkRequerToken } = els();

  try {
    const data = await apiGet(`/api/empresas/${EMPRESA_ID}`);

    state.empresa = data;

    if (chkRequerToken) {
      chkRequerToken.checked = !!data.requer_token_login;
    }

    return data;
  } catch (e) {
    console.warn('[colaboradores] loadEmpresa falhou', e);
    return null;
  }
}

export async function saveEmpresaLoginConfig(requerToken){
  if (!EMPRESA_ID) return;

  const { chkRequerToken } = els();

  const payload = {
    requer_token_login: !!requerToken
  };

  try {
    const resp = await apiJSON(`/api/empresas/${EMPRESA_ID}/login-config`, 'PUT', payload);

    state.empresa = resp || {
      ...(state.empresa || {}),
      requer_token_login: !!requerToken
    };

    toast('Configuração de login atualizada.');
  } catch (e) {
    console.warn('[colaboradores] falha ao atualizar requer_token_login', e);
    toast('Não foi possível salvar a configuração de login.', 'err');

    if (chkRequerToken && state.empresa) {
      chkRequerToken.checked = !!state.empresa.requer_token_login;
    }
  }
}