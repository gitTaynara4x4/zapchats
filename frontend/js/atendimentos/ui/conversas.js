/* ====================================================================
 * ZapsChat – Página Conversas
 * /frontend/js/atendimentos/ui/conversas.js
 * ==================================================================== */

'use strict';

(function () {
  if (window.__ZC_SETTINGS_CONVERSAS__) return;
  window.__ZC_SETTINGS_CONVERSAS__ = true;

  function getTheme() {
    try {
      return localStorage.getItem('zapschat_theme') ||
             localStorage.getItem('zc:theme') ||
             localStorage.getItem('theme') ||
             localStorage.getItem('valora_theme') ||
             'dark';
    } catch {
      return 'dark';
    }
  }

  function setTheme(mode) {
    const dark = mode === 'dark';
    const root = document.documentElement;

    root.classList.toggle('dark', dark);
    root.setAttribute('data-theme', dark ? 'dark' : 'light');

    try {
      localStorage.setItem('zapschat_theme', dark ? 'dark' : 'light');
      localStorage.setItem('zc:theme', dark ? 'dark' : 'light');
      localStorage.setItem('theme', dark ? 'dark' : 'light');
      localStorage.setItem('valora_theme', dark ? 'dark' : 'light');
    } catch {}
  }

  function start() {
    const H = window.ZCSettingsPage;
    if (!H) return;

    H.register({
      match: 'Conversas',
      title: 'Conversas',
      subtitle: 'Tema, papel de parede e comportamento do chat',
      render() {
        const theme = getTheme();

        return `
          ${H.block('Aparência', `
            <p class="zc-settings-desc">
              Ajuste o visual da tela de atendimento sem alterar as conversas ou mensagens.
            </p>
          `)}

          ${H.list(`
            ${H.row({
              icon: 'fa-solid fa-circle-half-stroke',
              title: 'Tema',
              desc: 'Alternar entre claro e escuro.',
              side: theme === 'dark' ? 'Escuro' : 'Claro',
              action: 'theme'
            })}

            ${H.row({
              icon: 'fa-regular fa-image',
              title: 'Papel de parede',
              desc: 'Usar o fundo estilo WhatsApp no histórico.',
              switchOn: true,
              action: 'wallpaper'
            })}

            ${H.row({
              icon: 'fa-solid fa-keyboard',
              title: 'Enter para enviar',
              desc: 'Enviar mensagem ao apertar Enter.',
              switchOn: true,
              action: 'enter-send'
            })}

            ${H.row({
              icon: 'fa-solid fa-box-archive',
              title: 'Histórico sob demanda',
              desc: 'Carregar histórico somente da conversa aberta.',
              switchOn: true,
              action: 'history-demand'
            })}

            ${H.row({
              icon: 'fa-solid fa-broom',
              title: 'Limpar cache visual',
              desc: 'Forçar atualização de tema e componentes.',
              side: 'Limpar',
              action: 'clear-cache'
            })}
          `)}
        `;
      },
      onOpen(page, H) {
        page.addEventListener('click', (event) => {
          const btn = event.target.closest('[data-action]');
          if (!btn) return;

          const action = btn.dataset.action;

          if (action === 'theme') {
            const current = getTheme();
            setTheme(current === 'dark' ? 'light' : 'dark');
            H.showToast('Tema alterado');
            return;
          }

          if (action === 'wallpaper') {
            const sw = btn.querySelector('.zc-settings-switch');
            if (sw) sw.classList.toggle('is-on');

            const main = document.getElementById('chat-main') || document.querySelector('main');
            if (main) {
              main.classList.add('whatsapp-auto-bg');
            }

            H.showToast('Papel de parede mantido');
            return;
          }

          if (action === 'enter-send' || action === 'history-demand') {
            const sw = btn.querySelector('.zc-settings-switch');
            if (sw) sw.classList.toggle('is-on');
            H.showToast('Preferência atualizada');
            return;
          }

          if (action === 'clear-cache') {
            try {
              localStorage.setItem('zc:force-refresh', String(Date.now()));
            } catch {}

            H.showToast('Cache visual limpo');
          }
        });
      }
    });
  }

  if (window.ZCSettingsPage) start();
  else window.addEventListener('zc:settings-page-helper-ready', start, { once: true });
})();