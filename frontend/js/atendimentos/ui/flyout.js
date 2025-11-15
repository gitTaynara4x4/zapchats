// /frontend/js/atendimentos/ui/flyout.js
(function () {
  'use strict';

  // ============================
  // 1. CSS do flyout (overlay)
  // ============================
  function injectFlyoutCSS() {
    if (document.getElementById('zc-flyout-style')) return;

    const css = `
      /* ===== Overlay lateral genérico ===== */
      .zc-flyout {
        position: fixed;
        inset: 0;
        display: none;           /* começa SEMPRE escondido */
        z-index: 10000;
        display: none;
        align-items: stretch;
        justify-content: flex-start; /* painel vem da ESQUERDA */
      }

      .zc-flyout.is-open {
        display: flex;           /* só aparece quando tiver .is-open */
      }

      .zc-flyout__panel {
        width: min(360px, 88vw);
        max-width: 420px;
        height: 100%;
        background: var(--card, #0b0b0f);
        border-right: 1px solid var(--border, #27272a);
        box-shadow: 18px 0 45px rgba(0,0,0,.55);
        transform: translateX(-100%);
        animation: zc-flyout-in-left .18s ease-out forwards;
        overflow: auto;
      }

      .zc-flyout.is-closing .zc-flyout__panel {
        animation: zc-flyout-out-left .14s ease-in forwards;
      }

      .zc-flyout__backdrop {
        flex: 1;
        background: rgba(0,0,0,.45);
        border: 0;
        padding: 0;
        margin: 0;
        cursor: pointer;
      }

      @keyframes zc-flyout-in-left {
        from { transform: translateX(-100%); opacity: .8; }
        to   { transform: translateX(0);     opacity: 1; }
      }

      @keyframes zc-flyout-out-left {
        from { transform: translateX(0);     opacity: 1; }
        to   { transform: translateX(-100%); opacity: .8; }
      }

      html.zc-no-scroll,
      html.zc-no-scroll body {
        overflow: hidden !important;
      }

      .zc-flyout__error,
      .zc-flyout__loading {
        padding: 1.25rem 1.5rem;
        font-size: .95rem;
        line-height: 1.4;
      }

      .zc-flyout__error {
        color: #fca5a5;
      }

      .zc-flyout__loading {
        color: #e5e7eb;
      }

      html:not(.dark) .zc-flyout__loading {
        color: #374151;
      }
    `;

    const st = document.createElement('style');
    st.id = 'zc-flyout-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ========================================
  // 2. Host, painel e backdrop do flyout
  // ========================================
  function ensureHost() {
    let host = document.getElementById('zcSidebarHost');
    if (!host) {
      // fallback se não existir no HTML (no seu caso já existe)
      host = document.createElement('div');
      host.id = 'zcSidebarHost';
      host.className = 'zc-flyout';
      host.setAttribute('aria-hidden', 'true');

      const panel = document.createElement('div');
      panel.className = 'zc-flyout__panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Menu lateral');

      const backdrop = document.createElement('button');
      backdrop.type = 'button';
      backdrop.className = 'zc-flyout__backdrop';
      backdrop.tabIndex = -1;
      backdrop.setAttribute('aria-hidden', 'true');

      host.appendChild(panel);
      host.appendChild(backdrop);
      document.body.appendChild(host);

      return { host, panel, backdrop };
    }

    // já existe
    let panel = host.querySelector('.zc-flyout__panel');
    if (!panel) {
      panel =
        host.querySelector('[role="dialog"]') ||
        host.firstElementChild ||
        document.createElement('div');

      panel.classList.add('zc-flyout__panel');
    }

    let backdrop = host.querySelector('.zc-flyout__backdrop');
    if (!backdrop) {
      backdrop = document.createElement('button');
      backdrop.type = 'button';
      backdrop.className = 'zc-flyout__backdrop';
      backdrop.tabIndex = -1;
      backdrop.setAttribute('aria-hidden', 'true');
      host.appendChild(backdrop);
    }

    return { host, panel, backdrop };
  }

  // ============================
  // 3. Inicialização principal
  // ============================
  function init() {
    injectFlyoutCSS();

    const triggers = [];
    const ids = ['btnSidebarFlyout', 'btnKebabHeader', 'zcSidebarToggle'];

    ids.forEach(function (id) {
      const el = document.getElementById(id);
      if (el) triggers.push(el);
    });

    if (!triggers.length) {
      console.warn('[Flyout] Nenhum botão de trigger encontrado (#btnSidebarFlyout / #btnKebabHeader).');
      return;
    }

    const { host, panel, backdrop } = ensureHost();
    if (!host || !panel || !backdrop) {
      console.warn('[Flyout] Host/painel/backdrop do flyout não encontrados.');
      return;
    }

    let loaded = false;
    let loading = false;

    async function loadSidebarOnce() {
      if (loaded || loading) return;
      loading = true;

      panel.innerHTML =
        '<div class="zc-flyout__loading">Carregando menu…</div>';

      try {
        const res = await fetch('/frontend/partials/sidebar-atendimentos.html', {
          credentials: 'include'
        });

        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }

        const html = await res.text();
        const tmp = document.createElement('div');
        tmp.innerHTML = html;

        // move links de preload (se tiver) pro <head>
        tmp.querySelectorAll('link[rel="preload"]').forEach(function (lnk) {
          document.head.appendChild(lnk);
        });

        const sidebar = tmp.querySelector('.app-sidebar');
        if (!sidebar) {
          panel.innerHTML =
            '<div class="zc-flyout__error">' +
              'Menu não disponível.<br>' +
              '<small>Sidebar (.app-sidebar) não encontrada.</small>' +
            '</div>';
          return;
        }

        const pfModal = tmp.querySelector('#pfModalAtt');

        // limpa e injeta
        panel.innerHTML = '';

        // estilos específicos da sidebar
        tmp.querySelectorAll('style').forEach(function (st) {
          panel.appendChild(st);
        });

        panel.appendChild(sidebar);

        // modal de perfil vai pro body
        if (pfModal) {
          document.body.appendChild(pfModal);
        }

        // scripts do partial
        tmp.querySelectorAll('script').forEach(function (old) {
          const s = document.createElement('script');
          if (old.src) {
            s.src = old.src;
          } else {
            s.textContent = old.textContent || '';
          }
          if (old.type) s.type = old.type;
          document.body.appendChild(s);
        });

        loaded = true;
      } catch (err) {
        console.error('[Flyout] Erro ao carregar sidebar:', err);
        panel.innerHTML =
          '<div class="zc-flyout__error">' +
            'Menu não disponível.<br>' +
            '<small>' + (err && err.message ? err.message : 'Erro ao carregar o menu.') + '</small>' +
          '</div>';
      } finally {
        loading = false;
      }
    }

    function openFlyout() {
      host.classList.remove('is-closing');
      host.classList.add('is-open');
      host.setAttribute('aria-hidden', 'false');
      document.documentElement.classList.add('zc-no-scroll');
    }

    function closeFlyout() {
      host.classList.add('is-closing');
      setTimeout(function () {
        host.classList.remove('is-open', 'is-closing');
        host.setAttribute('aria-hidden', 'true');
        document.documentElement.classList.remove('zc-no-scroll');
      }, 140);
    }

    async function handleOpenFromTrigger(ev) {
      if (ev) ev.preventDefault();
      if (host.classList.contains('is-open')) {
        closeFlyout();
      } else {
        await loadSidebarOnce();
        openFlyout();
      }
    }

    // triggers: clique + hover nos 3 pontinhos
    triggers.forEach(function (btn) {
      // clique
      btn.addEventListener('click', handleOpenFromTrigger);

      // hover (passar o mouse)
      btn.addEventListener('mouseenter', function () {
        if (!host.classList.contains('is-open')) {
          handleOpenFromTrigger();
        }
      });
    });

    // clique no backdrop fecha
    backdrop.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (host.classList.contains('is-open')) {
        closeFlyout();
      }
    });

    // ESC fecha
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && host.classList.contains('is-open')) {
        closeFlyout();
      }
    });

    // helper global
    window.ZCSidebarFlyout = {
      open: openFlyout,
      close: closeFlyout
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
