// frontend/js/pages/colaboradores/state.js

export const VIEW_PERM       = 'colaboradores.ver';
export const EDIT_PERM       = 'colaboradores.gerenciar';
export const RESET_PASS_PERM = 'colaboradores.redefinir_senha';

export const LS = localStorage;
export const EMPRESA_ID = Number(LS.getItem('empresa_id') || '') || null;

export const state = {
  // =========================
  // Dados principais da página
  // =========================
  setores: [],
  colaboradores: [],

  // ✅ Modelo 2:
  // Departamentos que o colaborador atende.
  // Usado por frontend/js/pages/colaboradores/departamentos.js
  departamentosCache: null,

  // =========================
  // Filtros
  // =========================
  filtroTexto: '',
  filtroSetorId: '',

  // =========================
  // Permissões do usuário logado
  // =========================
  permsSet: null,

  // =========================
  // Modal / edição
  // =========================
  viewing: null,
  inlineEdit: false,
  showErrors: false,
  saving: false,

  // =========================
  // Avatar
  // =========================
  newAvatarFile: null,
  avatarThumbCache: new Map(),
  avatarThumbInflight: new Map(),

  // =========================
  // Instâncias / WhatsApps
  // =========================
  instsCache: null,

  // =========================
  // Empresa
  // =========================
  empresa: null,

  // =========================
  // Controle de bind / boot
  // =========================
  didBindLista: false,
  didBindModal: false,

  // =========================
  // Botões criados dinamicamente no modal
  // =========================
  pSaveFoot: null,
  pCancelFoot: null,

  // =========================
  // Poller da lista
  // =========================
  poller: null
};