// frontend/js/pages/colaboradores/feedback.js

import { els } from './dom.js';

export function toast(msg, type = 'ok'){
  const { toastEl } = els();

  if (!toastEl) return;

  const icon = type === 'err'
    ? 'fa-triangle-exclamation'
    : type === 'warn'
      ? 'fa-circle-exclamation'
      : 'fa-circle-check';

  toastEl.className = '';
  toastEl.innerHTML = `<i class="fa-solid ${icon}"></i><span class="toast-msg">${String(msg || '')}</span>`;
  toastEl.classList.add(`toast-${type}`, 'show');

  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 3200);
}

export function showConfirm(message){
  const { confirmModal, confirmMsgEl } = els();

  if (!confirmModal) {
    return Promise.resolve(window.confirm(message || 'Confirmar ação?'));
  }

  if (confirmMsgEl) {
    confirmMsgEl.textContent = message || 'Confirmar ação?';
  }

  confirmModal.setAttribute('aria-hidden', 'false');
  document.documentElement.classList.add('modal-open');

  return new Promise(resolve => {
    const onClick = ev => {
      const btn = ev.target.closest('[data-confirm]');
      if (!btn) return;

      cleanup(btn.getAttribute('data-confirm') === 'yes');
    };

    const onKey = ev => {
      if (ev.key === 'Escape') cleanup(false);
    };

    const onBackdrop = ev => {
      if (ev.target === confirmModal) cleanup(false);
    };

    function cleanup(result){
      confirmModal.setAttribute('aria-hidden', 'true');
      document.documentElement.classList.remove('modal-open');

      confirmModal.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      confirmModal.removeEventListener('mousedown', onBackdrop);

      resolve(result);
    }

    confirmModal.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    confirmModal.addEventListener('mousedown', onBackdrop);
  });
}