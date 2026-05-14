/* ====================================================================
 * ZapsChat – Página Atalhos do teclado
 * /frontend/js/atendimentos/ui/atalhos-teclado.js
 * ==================================================================== */

'use strict';

(function () {
  if (window.__ZC_SETTINGS_ATALHOS__) return;
  window.__ZC_SETTINGS_ATALHOS__ = true;

  function start() {
    const H = window.ZCSettingsPage;
    if (!H) return;

    H.register({
      match: 'Atalhos do teclado',
      title: 'Atalhos do teclado',
      subtitle: 'Ações rápidas no atendimento',
      render() {
        return `
          ${H.block('Atalhos disponíveis', `
            <p class="zc-settings-desc">
              Use estes atalhos para trabalhar mais rápido no painel de atendimento.
            </p>
          `)}

          ${H.list(`
            ${H.row({
              icon: 'fa-solid fa-magnifying-glass',
              title: 'Pesquisar conversa',
              desc: 'Foca no campo de busca da lista.',
              shortcut: 'Ctrl + K'
            })}

            ${H.row({
              icon: 'fa-solid fa-plus',
              title: 'Nova conversa',
              desc: 'Abre o modal para iniciar atendimento.',
              shortcut: 'Ctrl + N'
            })}

            ${H.row({
              icon: 'fa-regular fa-paper-plane',
              title: 'Enviar mensagem',
              desc: 'Envia a mensagem digitada no campo.',
              shortcut: 'Enter'
            })}

            ${H.row({
              icon: 'fa-solid fa-arrow-turn-down',
              title: 'Quebrar linha',
              desc: 'Insere nova linha no campo de mensagem.',
              shortcut: 'Shift + Enter'
            })}

            ${H.row({
              icon: 'fa-solid fa-xmark',
              title: 'Fechar painel ou modal',
              desc: 'Fecha menus, drawers ou modais abertos.',
              shortcut: 'Esc'
            })}

            ${H.row({
              icon: 'fa-solid fa-paperclip',
              title: 'Anexar arquivo',
              desc: 'Abre o seletor de arquivos.',
              shortcut: 'Ctrl + U'
            })}
          `)}
        `;
      }
    });
  }

  if (window.ZCSettingsPage) start();
  else window.addEventListener('zc:settings-page-helper-ready', start, { once: true });
})();