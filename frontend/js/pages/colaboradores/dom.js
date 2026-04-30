// frontend/js/pages/colaboradores/dom.js

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

export function els(){
  return {
    filtroTxt: $('#filtro'),
    filtroDepto: $('#filtro-depto'),
    btnFiltrar: $('#btn-filtrar'),
    btnAdd: $('#btn-add-colaborador'),
    tbody: $('#tabela-colaboradores'),
    emptyState: $('#empty-state'),
    countEl: $('#count-colaboradores'),
    chkRequerToken: $('#chk-requer-token'),

    perfilModal: $('#modal-perfil'),
    pClose: $('#perfil-fechar'),
    pClose2: $('#perfil-fechar2'),
    pEdit: $('#perfil-editar'),
    pSave: $('#perfil-salvar'),
    pCancel: $('#perfil-cancelar'),
    pTitle: $('#perfil-title'),

    pAvatar: $('#p-avatar'),
    pMono: $('#p-mono'),
    dStatus: $('#p-status'),
    dStatusText: $('#p-status-text'),

    avatarHint: $('#avatar-hint'),
    btnAddAvatar: $('#btn-add-avatar'),
    pAvatarInput: $('#p-avatar-input'),

    dPerms: $('#d-perms'),
    ePerms: $('#e-perms'),

    confirmModal: $('#zc-confirm'),
    confirmMsgEl: $('#zc-confirm .zc-confirm-message'),

    toastEl: $('#toast')
  };
}