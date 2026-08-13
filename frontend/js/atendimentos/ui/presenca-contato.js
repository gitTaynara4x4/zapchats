/* ====================================================================
 * ZapsChat – presença do contato desativada
 *
 * A Evolution usada pelo projeto não fornece de forma confiável online,
 * digitando, gravando áudio ou visto por último. Este arquivo fica como
 * compatibilidade para referências antigas, sem consultar ou exibir presença.
 *
 * Status das mensagens (enviado, entregue e lido) não passam por este módulo.
 * ==================================================================== */
(function () {
  'use strict';

  if (window.__ZC_CONTACT_PRESENCE_LOADED__) return;
  window.__ZC_CONTACT_PRESENCE_LOADED__ = true;

  const VERSION = 'zc-contact-presence-disabled-v1';

  function hide() {
    const el = document.getElementById('chat-presenca');
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('is-online', 'is-activity');
    el.removeAttribute('title');
  }

  function noopAsync() {
    hide();
    return Promise.resolve(false);
  }

  hide();

  window.ZCContactPresence = Object.freeze({
    version: VERSION,
    disabled: true,
    refresh: noopAsync,
    subscribe: noopAsync,
    render: hide,
    current: () => null,
    state: () => null,
  });
})();
