/* ====================================================================
 * ZapsChat – Configurações internas de notificações
 * Mantém as mesmas preferências da página /configuracoes.
 * ==================================================================== */

'use strict';

(function () {
  if (window.__ZC_SETTINGS_NOTIFICACAO__) return;
  window.__ZC_SETTINGS_NOTIFICACAO__ = true;

  const KEYS = {
    desktop: 'zc:notify:desktop_enabled',
    sound: 'zc:notify:sound_enabled',
    alwaysBeep: 'zc:notify:always_beep'
  };

  function getBool(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === '1') return true;
      if (raw === '0') return false;
      return Boolean(fallback);
    } catch {
      return Boolean(fallback);
    }
  }

  function setBool(key, value) {
    try { localStorage.setItem(key, value ? '1' : '0'); } catch {}
  }

  async function enableDesktop(H) {
    if (!('Notification' in window)) {
      H.showToast('Navegador sem suporte');
      return false;
    }

    if (Notification.permission === 'denied') {
      H.showToast('Permissão bloqueada no navegador');
      return false;
    }

    if (Notification.permission !== 'granted') {
      try {
        const result = await Notification.requestPermission();
        if (result !== 'granted') {
          H.showToast('Permissão não concedida');
          return false;
        }
      } catch {
        H.showToast('Não foi possível ativar');
        return false;
      }
    }

    return true;
  }

  function setSwitch(btn, enabled) {
    const sw = btn?.querySelector('.zc-settings-switch');
    if (sw) sw.classList.toggle('is-on', Boolean(enabled));
  }

  function start() {
    const H = window.ZCSettingsPage;
    if (!H) return;

    H.register({
      match: 'Notificações',
      title: 'Notificações',
      subtitle: 'Avisos e sons de novas mensagens',
      render() {
        const desktopDefault = 'Notification' in window && Notification.permission === 'granted';
        const desktop = getBool(KEYS.desktop, desktopDefault);
        const sound = getBool(KEYS.sound, true);
        const alwaysBeep = getBool(KEYS.alwaysBeep, false);

        return `
          ${H.block('Alertas', `
            <p class="zc-settings-desc">
              Estas preferências são as mesmas da página principal de Configurações.
            </p>
          `)}

          ${H.list(`
            ${H.row({
              icon: 'fa-regular fa-bell',
              title: 'Notificações no navegador',
              desc: 'Receber alertas mesmo com a aba em segundo plano.',
              switchOn: desktop,
              action: 'desktop'
            })}

            ${H.row({
              icon: 'fa-solid fa-volume-high',
              title: 'Som de nova mensagem',
              desc: 'Tocar um alerta quando uma nova mensagem chegar.',
              switchOn: sound,
              action: 'sound'
            })}

            ${H.row({
              icon: 'fa-regular fa-message',
              title: 'Tocar com a conversa aberta',
              desc: 'Manter o som mesmo enquanto você lê o mesmo atendimento.',
              switchOn: alwaysBeep,
              action: 'always-beep'
            })}

            ${H.row({
              icon: 'fa-solid fa-sliders',
              title: 'Configurações completas',
              desc: 'Ver aparência, segurança e relatos de suporte.',
              side: 'Abrir',
              action: 'full-settings'
            })}
          `)}
        `;
      },
      onOpen(page, H) {
        page.addEventListener('click', async (event) => {
          const btn = event.target.closest('[data-action]');
          if (!btn) return;

          const action = btn.dataset.action;

          if (action === 'full-settings') {
            window.location.href = '/configuracoes';
            return;
          }

          if (action === 'desktop') {
            const current = getBool(
              KEYS.desktop,
              'Notification' in window && Notification.permission === 'granted'
            );
            const next = !current;

            if (next && !(await enableDesktop(H))) {
              setBool(KEYS.desktop, false);
              setSwitch(btn, false);
              return;
            }

            setBool(KEYS.desktop, next);
            setSwitch(btn, next);
            H.showToast(next ? 'Notificações ativadas' : 'Notificações desativadas');
            return;
          }

          if (action === 'sound') {
            const next = !getBool(KEYS.sound, true);
            setBool(KEYS.sound, next);
            setSwitch(btn, next);
            H.showToast(next ? 'Som ativado' : 'Som desativado');
            return;
          }

          if (action === 'always-beep') {
            const next = !getBool(KEYS.alwaysBeep, false);
            setBool(KEYS.alwaysBeep, next);
            setSwitch(btn, next);
            H.showToast(next ? 'Aviso com conversa aberta ativado' : 'Aviso com conversa aberta desativado');
          }
        });
      }
    });
  }

  if (window.ZCSettingsPage) start();
  else window.addEventListener('zc:settings-page-helper-ready', start, { once: true });
})();
