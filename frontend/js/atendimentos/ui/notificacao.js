/* ====================================================================
 * ZapsChat – Página Notificações
 * /frontend/js/atendimentos/ui/notificacao.js
 * ==================================================================== */

'use strict';

(function () {
  if (window.__ZC_SETTINGS_NOTIFICACAO__) return;
  window.__ZC_SETTINGS_NOTIFICACAO__ = true;

  async function requestPermission(H) {
    try {
      if (!('Notification' in window)) {
        H.showToast('Navegador sem suporte');
        return;
      }

      const result = await Notification.requestPermission();

      if (result === 'granted') {
        H.showToast('Notificações ativadas');
      } else {
        H.showToast('Permissão não concedida');
      }
    } catch {
      H.showToast('Não foi possível ativar');
    }
  }

  function start() {
    const H = window.ZCSettingsPage;
    if (!H) return;

    H.register({
      match: 'Notificações',
      title: 'Notificações',
      subtitle: 'Mensagens, grupos e sons',
      render() {
        return `
          ${H.block('Alertas', `
            <p class="zc-settings-desc">
              Controle como o ZapsChat avisa sobre novas mensagens e atividades importantes.
            </p>
          `)}

          ${H.list(`
            ${H.row({
              icon: 'fa-regular fa-bell',
              title: 'Notificações no navegador',
              desc: 'Receber alertas mesmo com a aba em segundo plano.',
              side: 'Ativar',
              action: 'browser-permission'
            })}

            ${H.row({
              icon: 'fa-regular fa-message',
              title: 'Mensagens',
              desc: 'Alertas para novas mensagens de clientes.',
              switchOn: true,
              action: 'messages'
            })}

            ${H.row({
              icon: 'fa-solid fa-users',
              title: 'Grupos',
              desc: 'Alertas para novas mensagens em grupos.',
              switchOn: true,
              action: 'groups'
            })}

            ${H.row({
              icon: 'fa-solid fa-volume-high',
              title: 'Sons',
              desc: 'Tocar som ao receber mensagem.',
              switchOn: true,
              action: 'sounds'
            })}

            ${H.row({
              icon: 'fa-solid fa-at',
              title: 'Menções e respostas',
              desc: 'Destacar quando uma conversa exigir atenção.',
              switchOn: true,
              action: 'mentions'
            })}
          `)}
        `;
      },
      onOpen(page, H) {
        page.addEventListener('click', (event) => {
          const btn = event.target.closest('[data-action]');
          if (!btn) return;

          const action = btn.dataset.action;

          if (action === 'browser-permission') {
            requestPermission(H);
            return;
          }

          const sw = btn.querySelector('.zc-settings-switch');

          if (sw) {
            sw.classList.toggle('is-on');
            H.showToast('Preferência atualizada');
          }
        });
      }
    });
  }

  if (window.ZCSettingsPage) start();
  else window.addEventListener('zc:settings-page-helper-ready', start, { once: true });
})();