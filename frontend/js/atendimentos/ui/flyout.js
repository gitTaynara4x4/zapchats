/* /frontend/js/flyout.js
   Mantém o FLYOUT só pro MOBILE (onde não tem hover).
   No desktop, o sidebar-atendimentos.html já expande sozinho no hover.
*/
(function () {
  'use strict';

  function isMobileLike() {
    return window.matchMedia('(hover: none), (pointer: coarse), (max-width: 920px)').matches;
  }

  let lastTrigger = null;

  function closeNestedUserMenus(host) {
    if (!host) return;

    const openMenus = host.querySelectorAll('.wpp-leftbar-user-menu.show');
    openMenus.forEach(menu => {
      menu.classList.remove('show');
    });

    const activeBtns = host.querySelectorAll('.wpp-leftbar-user-btn.active');
    activeBtns.forEach(btn => {
      btn.classList.remove('active');
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  function openFlyout(host, trigger) {
    if (!host) return;
    lastTrigger = trigger || lastTrigger;

    host.classList.add('is-open');
    host.setAttribute('aria-hidden', 'false');

    const panel = host.querySelector('[role="dialog"]');
    if (panel) {
      const focusable = panel.querySelector(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable && typeof focusable.focus === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try { focusable.focus(); } catch {}
        }));
      }
    }
  }

  function closeFlyout(host) {
    if (!host) return;

    closeNestedUserMenus(host);

    host.classList.remove('is-open');
    host.setAttribute('aria-hidden', 'true');

    if (lastTrigger && typeof lastTrigger.focus === 'function') {
      setTimeout(() => { try { lastTrigger.focus(); } catch {} }, 0);
    }
  }

  function bindTriggers(host) {
    if (!isMobileLike()) return;

    const btnSidebar = document.getElementById('btnSidebarFlyout');
    const btnHeader = document.getElementById('btnKebabHeader');
    const triggers = [btnSidebar, btnHeader].filter(Boolean);

    triggers.forEach(btn => {
      if (btn.dataset.zcFlyoutBound) return;
      btn.dataset.zcFlyoutBound = '1';
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        openFlyout(host, btn);
      });
    });

    const backdrop = host.querySelector('.zc-flyout__backdrop');
    if (backdrop && !backdrop.dataset.zcFlyoutBound) {
      backdrop.dataset.zcFlyoutBound = '1';
      backdrop.addEventListener('click', function (ev) {
        ev.preventDefault();
        closeFlyout(host);
      });
    }

    if (!document.documentElement.dataset.zcFlyoutEscBound) {
      document.documentElement.dataset.zcFlyoutEscBound = '1';
      document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape') return;

        const modal = document.getElementById('pfModalAtt');
        const modalOpen = modal && modal.getAttribute('aria-hidden') === 'false';
        if (modalOpen) return;

        if (host.classList.contains('is-open')) {
          ev.preventDefault();
          closeFlyout(host);
        }
      });
    }
  }

  function ensureBaseStyles() {
    if (document.getElementById('zcFlyoutBaseStyles')) return;

    const style = document.createElement('style');
    style.id = 'zcFlyoutBaseStyles';
    style.textContent = `
      #zcSidebarHost.zc-flyout{
        position:fixed;
        inset:0;
        z-index:10000;
        pointer-events:none;
      }
      #zcSidebarHost.zc-flyout[aria-hidden="false"]{
        pointer-events:auto;
      }

      #zcSidebarHost .zc-flyout__backdrop{
        position:absolute;
        inset:0;
        border:0;
        padding:0;
        margin:0;
        background:rgba(0,0,0,.55);
        opacity:0;
        transition:opacity .18s ease;
        pointer-events:none;
      }
      #zcSidebarHost.is-open .zc-flyout__backdrop{
        opacity:1;
        pointer-events:auto;
      }

      #zcSidebarHost [role="dialog"]{
        position:absolute;
        top:0;
        left:0;
        height:100%;
        width:min(92vw,360px);
        background:var(--card,#161617);
        border-right:1px solid var(--border,#27272a);
        transform:translateX(-10px);
        opacity:0;
        transition:transform .22s ease,opacity .18s ease;
        outline:none;
        overflow:auto;
        padding:14px 10px;
      }
      #zcSidebarHost.is-open [role="dialog"]{
        transform:translateX(0);
        opacity:1;
      }
    `;
    document.head.appendChild(style);
  }

  function init() {
    const host = document.getElementById('zcSidebarHost');
    if (!host) return;
    if (host.dataset.zcFlyoutReady === '1') return;
    host.dataset.zcFlyoutReady = '1';

    ensureBaseStyles();
    bindTriggers(host);

    window.addEventListener('resize', () => {
      if (!isMobileLike() && host.classList.contains('is-open')) {
        closeFlyout(host);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();