// frontend/js/pages/colaboradores/state.js

export const VIEW_PERM       = 'colaboradores.ver';
export const EDIT_PERM       = 'colaboradores.gerenciar';
export const RESET_PASS_PERM = 'colaboradores.redefinir_senha';

export const LS = localStorage;
export const EMPRESA_ID = Number(LS.getItem('empresa_id') || '') || null;

export const state = {
  setores: [],
  colaboradores: [],
  filtroTexto: '',
  filtroSetorId: '',
  permsSet: null,

  viewing: null,
  inlineEdit: false,

  newAvatarFile: null,
  instsCache: null,
  showErrors: false,
  empresa: null,

  avatarThumbCache: new Map(),
  avatarThumbInflight: new Map(),

  didBindLista: false,
  didBindModal: false,

  pSaveFoot: null,
  pCancelFoot: null,
  poller: null
};