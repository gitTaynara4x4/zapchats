// frontend/js/pages/colaboradores/permissions.js

import { apiGet } from './api.js';
import { state, EDIT_PERM, RESET_PASS_PERM } from './state.js';

export async function preloadPerms(){
  try {
    const list = await apiGet('/api/permissoes/minhas');
    const arr = Array.isArray(list) ? list : (list?.items || []);

    state.permsSet = new Set(arr);
  } catch (e) {
    console.warn('[colaboradores/perms] falhou', e);
    state.permsSet = null;
  }
}

export function hasPerm(p){
  if (state.permsSet) return state.permsSet.has(p);

  const fn = window.ZAuth?.hasPerm?.bind?.(window.ZAuth);

  if (typeof fn === 'function') {
    return !!fn(p);
  }

  return true;
}

export function canEditPassword(){
  return hasPerm(RESET_PASS_PERM) || hasPerm(EDIT_PERM);
}