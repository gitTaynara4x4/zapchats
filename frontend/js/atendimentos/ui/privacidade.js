/* ====================================================================
 * ZapsChat – Página Privacidade
 * /frontend/js/atendimentos/ui/privacidade.js
 * ==================================================================== */

'use strict';

(function () {
  if (window.__ZC_SETTINGS_PRIVACIDADE__) return;
  window.__ZC_SETTINGS_PRIVACIDADE__ = true;

  function start() {
    const H = window.ZCSettingsPage;
    if (!H) return;

    H.register({
      match: 'Privacidade',
      title: 'Privacidade',
      subtitle: 'Contatos, bloqueios e mensagens temporárias',
      render() {
        return `
          ${H.block('Quem pode ver meus dados', `
            <p class="zc-settings-desc">
              Estas opções organizam as preferências visuais do painel. Algumas permissões reais dependem do WhatsApp conectado.
            </p>
          `)}

          ${H.list(`
            ${H.row({
              icon: 'fa-regular fa-clock',
              title: 'Visto por último e online',
              desc: 'Controlar como informações de presença aparecem no painel.',
              side: 'Meus contatos',
              action: 'last-seen'
            })}

            ${H.row({
              icon: 'fa-regular fa-image',
              title: 'Foto do perfil',
              desc: 'Definir quem pode visualizar sua foto.',
              side: 'Todos',
              action: 'profile-photo'
            })}

            ${H.row({
              icon: 'fa-regular fa-message',
              title: 'Recado',
              desc: 'Controlar visibilidade do recado/status.',
              side: 'Todos',
              action: 'about'
            })}

            ${H.row({
              icon: 'fa-solid fa-users',
              title: 'Grupos',
              desc: 'Quem pode adicionar você em grupos.',
              side: 'Meus contatos',
              action: 'groups'
            })}

            ${H.row({
              icon: 'fa-solid fa-ban',
              title: 'Contatos bloqueados',
              desc: 'Ver e gerenciar contatos bloqueados.',
              side: '0',
              action: 'blocked'
            })}

            ${H.row({
              icon: 'fa-regular fa-hourglass-half',
              title: 'Mensagens temporárias',
              desc: 'Configurar duração padrão para novas conversas.',
              side: 'Desativado',
              action: 'temporary-messages'
            })}
          `)}
        `;
      },
      onOpen(page, H) {
        page.addEventListener('click', (event) => {
          const btn = event.target.closest('[data-action]');
          if (!btn) return;

          H.showToast('Opção de privacidade selecionada');
        });
      }
    });
  }

  if (window.ZCSettingsPage) start();
  else window.addEventListener('zc:settings-page-helper-ready', start, { once: true });
})();