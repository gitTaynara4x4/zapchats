/* ====================================================================
 * ZapsChat – Página Conta
 * /frontend/js/atendimentos/ui/conta.js
 *
 * Corrigido:
 * - Não redireciona mais para /perfil.html
 * - Abre/mostra informações dentro do próprio painel de configurações
 * ==================================================================== */

'use strict';

(function () {
  if (window.__ZC_SETTINGS_CONTA__) return;
  window.__ZC_SETTINGS_CONTA__ = true;

  function getUserData() {
    function readJson(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }

    const user =
      readJson('usuario') ||
      readJson('user') ||
      readJson('zc:user') ||
      {};

    const nome =
      user.nome ||
      user.name ||
      user.nome_completo ||
      localStorage.getItem('usuario_nome') ||
      localStorage.getItem('nome') ||
      'Usuário';

    const email =
      user.email ||
      localStorage.getItem('usuario_email') ||
      localStorage.getItem('email') ||
      'email não informado';

    const empresa =
      user.empresa_nome ||
      user.empresa ||
      localStorage.getItem('empresa_nome') ||
      localStorage.getItem('empresa') ||
      'Empresa atual';

    return { nome, email, empresa };
  }

  function showInfo(H, title, message) {
    if (H && typeof H.showToast === 'function') {
      H.showToast(message || title);
      return;
    }

    if (typeof window.toast === 'function') {
      try {
        window.toast({ title, msg: message || '', type: 'ok' });
        return;
      } catch {}

      try {
        window.toast(message || title, true);
        return;
      } catch {}
    }

    alert(`${title}\n\n${message || ''}`);
  }

  function start() {
    const H = window.ZCSettingsPage;
    if (!H) return;

    H.register({
      match: 'Conta',
      title: 'Conta',
      subtitle: 'Segurança, dados da conta e acesso',
      render() {
        return `
          ${H.block('Segurança', `
            <p class="zc-settings-desc">
              Gerencie dados de segurança, sessão e informações da sua conta no ZapsChat.
            </p>
          `)}

          ${H.list(`
            ${H.row({
              icon: 'fa-solid fa-shield-halved',
              title: 'Notificações de segurança',
              desc: 'Receba alertas quando houver mudanças importantes na conta.',
              switchOn: true,
              action: 'security-notifications'
            })}

            ${H.row({
              icon: 'fa-solid fa-key',
              title: 'Senha e acesso',
              desc: 'Configuração de senha e métodos de acesso.',
              side: 'Ver',
              action: 'password-access'
            })}

            ${H.row({
              icon: 'fa-regular fa-id-card',
              title: 'Dados da conta',
              desc: 'Nome, e-mail, empresa e permissões vinculadas.',
              side: 'Ver',
              action: 'account-data'
            })}

            ${H.row({
              icon: 'fa-solid fa-download',
              title: 'Solicitar dados',
              desc: 'Gerar uma cópia das informações da sua conta.',
              side: 'Solicitar',
              action: 'request-data'
            })}

            ${H.row({
              icon: 'fa-solid fa-right-from-bracket',
              title: 'Sair desta sessão',
              desc: 'Encerrar o acesso neste navegador.',
              side: 'Sair',
              action: 'logout'
            })}
          `)}
        `;
      },
      onOpen(page, H) {
        page.addEventListener('click', async (event) => {
          const btn = event.target.closest('[data-action]');
          if (!btn) return;

          const action = btn.dataset.action;

          if (action === 'security-notifications') {
            const sw = btn.querySelector('.zc-settings-switch');
            if (sw) sw.classList.toggle('is-on');
            H.showToast('Preferência atualizada');
            return;
          }

          if (action === 'password-access') {
            showInfo(
              H,
              'Senha e acesso',
              'Essa opção será configurada dentro do painel. Nenhum redirecionamento para /perfil.html será feito.'
            );
            return;
          }

          if (action === 'account-data') {
            const u = getUserData();

            showInfo(
              H,
              'Dados da conta',
              `Nome: ${u.nome} · E-mail: ${u.email} · Empresa: ${u.empresa}`
            );
            return;
          }

          if (action === 'request-data') {
            H.showToast('Solicitação registrada');
            return;
          }

          if (action === 'logout') {
            try {
              await fetch('/api/auth/logout', {
                method: 'POST',
                credentials: 'include'
              });
            } catch {}

            try {
              localStorage.clear();
              sessionStorage.clear();
            } catch {}

            window.location.replace('/');
          }
        });
      }
    });
  }

  if (window.ZCSettingsPage) start();
  else window.addEventListener('zc:settings-page-helper-ready', start, { once: true });
})();