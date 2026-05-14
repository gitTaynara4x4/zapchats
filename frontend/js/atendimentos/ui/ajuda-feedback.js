/* ====================================================================
 * ZapsChat – Página Ajuda e feedback
 * /frontend/js/atendimentos/ui/ajuda-feedback.js
 * ==================================================================== */

'use strict';

(function () {
  if (window.__ZC_SETTINGS_AJUDA__) return;
  window.__ZC_SETTINGS_AJUDA__ = true;

  function start() {
    const H = window.ZCSettingsPage;
    if (!H) return;

    H.register({
      match: 'Ajuda e feedback',
      title: 'Ajuda e feedback',
      subtitle: 'Suporte, política e informações do sistema',
      render() {
        return `
          ${H.block('Suporte', `
            <p class="zc-settings-desc">
              Encontre ajuda, envie feedback ou consulte informações importantes do ZapsChat.
            </p>
          `)}

          ${H.list(`
            ${H.row({
              icon: 'fa-regular fa-circle-question',
              title: 'Central de Ajuda',
              desc: 'Ver tutoriais e dúvidas frequentes.',
              side: 'Abrir',
              action: 'help'
            })}

            ${H.row({
              icon: 'fa-regular fa-comment-dots',
              title: 'Fale conosco',
              desc: 'Enviar uma mensagem para o suporte.',
              side: 'Contato',
              action: 'contact'
            })}

            ${H.row({
              icon: 'fa-regular fa-flag',
              title: 'Enviar feedback',
              desc: 'Contar o que pode melhorar no painel.',
              side: 'Enviar',
              action: 'feedback'
            })}

            ${H.row({
              icon: 'fa-solid fa-shield-halved',
              title: 'Política de Privacidade',
              desc: 'Ver regras de privacidade e uso de dados.',
              side: 'Ver',
              action: 'privacy'
            })}

            ${H.row({
              icon: 'fa-solid fa-circle-info',
              title: 'Sobre o ZapsChat',
              desc: 'Versão, ambiente e informações técnicas.',
              side: 'Ver',
              action: 'about'
            })}
          `)}
        `;
      },
      onOpen(page, H) {
        page.addEventListener('click', (event) => {
          const btn = event.target.closest('[data-action]');
          if (!btn) return;

          const action = btn.dataset.action;

          if (action === 'help') {
            H.showToast('Central de ajuda em breve');
            return;
          }

          if (action === 'contact') {
            H.showToast('Suporte em breve');
            return;
          }

          if (action === 'feedback') {
            H.showToast('Feedback registrado');
            return;
          }

          if (action === 'privacy') {
            H.showToast('Política em breve');
            return;
          }

          if (action === 'about') {
            const version =
              window.__ZC_ATENDIMENTOS_MAIN_VERSION__ ||
              window.__ZC_PERFIL_INSTANCIA_VERSION__ ||
              'ZapsChat';

            H.showToast(`Versão: ${version}`);
          }
        });
      }
    });
  }

  if (window.ZCSettingsPage) start();
  else window.addEventListener('zc:settings-page-helper-ready', start, { once: true });
})();