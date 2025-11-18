// /frontend/js/atendimentos/ui/flyout.js
(function () {
  'use strict';

  const PARTIAL_URL = '/frontend/partials/sidebar-atendimentos.html';
  let lastTrigger = null;

  function log() {
    try {
      console.log('[flyout.js]', ...arguments);
    } catch {}
  }

  // ---------- Abertura / Fechamento do Flyout ----------
  function openFlyout(host, trigger) {
    if (!host) return;
    lastTrigger = trigger || lastTrigger;

    host.classList.add('is-open');
    host.setAttribute('aria-hidden', 'false');

    // foca no primeiro elemento focável dentro do sidebar
    const panel = host.querySelector('.app-sidebar') || host.querySelector('[role="dialog"]');
    if (panel) {
      const focusable = panel.querySelector(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable && typeof focusable.focus === 'function') {
        setTimeout(() => focusable.focus(), 0);
      }
    }
  }

  function closeFlyout(host) {
    if (!host) return;

    host.classList.remove('is-open');
    host.setAttribute('aria-hidden', 'true');

    if (lastTrigger && typeof lastTrigger.focus === 'function') {
      setTimeout(() => lastTrigger.focus(), 0);
    }
  }

  function bindTriggers(host) {
    const btnSidebar = document.getElementById('btnSidebarFlyout');
    const btnHeader  = document.getElementById('btnKebabHeader');
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

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && host.classList.contains('is-open')) {
        ev.preventDefault();
        closeFlyout(host);
      }
    });
  }

  // ---------- Hover na mini-leftbar para abrir/fechar o flyout ----------
  function bindHoverMini(host){
    // raiz da barrinha vertical com os ícones (lado esquerdo do WhatsApp)
    const mini = document.querySelector('.wpp-leftbar');
    if (!mini || mini.dataset.zcFlyoutHoverBound) return;
    mini.dataset.zcFlyoutHoverBound = '1';

    // pequenos delays pra não ficar abrindo/fechando espasmando
    let openTimer = null;
    let closeTimer = null;

    function scheduleOpen(){
      clearTimeout(closeTimer);
      openTimer = setTimeout(() => {
        openFlyout(host, mini);
      }, 60);
    }

    function scheduleClose(){
      clearTimeout(openTimer);
      closeTimer = setTimeout(() => {
        // verifica se o mouse ainda está em cima da mini-barra ou do flyout
        const overMini = mini.matches(':hover');
        const overHost = host.matches(':hover'); // host = overlay inteiro (backdrop + painel)

        // só fecha se o mouse NÃO estiver nem na mini bar, nem em qualquer parte do flyout
        if (!overMini && !overHost) {
          closeFlyout(host);
        }
      }, 100);
    }

    // abre quando entra na barrinha
    mini.addEventListener('mouseenter', scheduleOpen);
    // começa a contagem pra fechar quando sai da barrinha
    mini.addEventListener('mouseleave', scheduleClose);

    // se o mouse entrar em QUALQUER parte do flyout (painel ou backdrop), cancela o fechamento
    host.addEventListener('mouseenter', () => {
      clearTimeout(closeTimer);
    });

    // se sair de qualquer parte do flyout, agenda fechamento
    host.addEventListener('mouseleave', scheduleClose);
  }

  // ---------- Mini barra (wpp-leftbar) baseada no partial ----------
  function buildMiniSidebarFromAside(aside) {
    const container = document.querySelector('.wpp-leftbar .wpp-leftbar-icons');
    if (!container || !aside) return;

    container.innerHTML = '';

    const links = aside.querySelectorAll('nav a[href]');
    const currentPath = (location.pathname.replace(/\/+$/, '') || '/');

    links.forEach(link => {
      const hrefRaw = (link.getAttribute('href') || '').trim();
      if (!hrefRaw || hrefRaw === '#') return;

      const href = hrefRaw.replace(/\/+$/, '') || '/';

      const labelEl = link.querySelector('.label');
      const labelText = (labelEl && labelEl.textContent || '').trim();

      const mini = document.createElement('a');
      mini.className = 'wpp-leftbar-icon';
      mini.href = hrefRaw;

      if (labelText) {
        mini.title = labelText;
        mini.setAttribute('aria-label', labelText);
      }

      // Ícone: clona o mesmo SVG do sidebar
      const iconSource = link.querySelector('.att-nav-icon svg') || link.querySelector('svg');
      if (iconSource) {
        const iconClone = iconSource.cloneNode(true);
        mini.appendChild(iconClone);
      } else {
        // fallback bem simples
        const i = document.createElement('i');
        i.className = 'fa-solid fa-circle';
        mini.appendChild(i);
      }

      // Label opcional
      if (labelText) {
        const span = document.createElement('span');
        span.className = 'wpp-label';
        span.textContent = labelText;
        mini.appendChild(span);
      }

      // marca como página atual
      if (href === currentPath) {
        mini.setAttribute('aria-current', 'page');
      }

      container.appendChild(mini);
    });
  }

  // ---------- Carregar partial + rodar o <script> dele ----------
  async function loadSidebarPartial(host, panelShell) {
    try {
      log('carregando partial:', PARTIAL_URL);
      const res = await fetch(PARTIAL_URL, { credentials: 'include' });
      if (!res.ok) {
        log('falha ao carregar partial:', res.status, res.statusText);
        return;
      }

      const html = await res.text();
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      const fragment = tpl.content;

      // joga <link preload> e <style> pro <head>
      fragment.querySelectorAll('link[rel="preload"], style').forEach(node => {
        document.head.appendChild(node);
      });

      // pega sidebar, modal e scripts do partial
      const aside  = fragment.querySelector('.app-sidebar');
      const modal  = fragment.querySelector('#pfModalAtt');
      const scripts = Array.from(fragment.querySelectorAll('script'));

      if (!aside) {
        log('app-sidebar não encontrado no partial');
        return;
      }

      // injeta sidebar no flyout
      panelShell.innerHTML = '';
      panelShell.appendChild(aside);

      // injeta modal no body (se ainda não existir)
      if (modal && !document.getElementById('pfModalAtt')) {
        document.body.appendChild(modal);
      }

      // executa os <script> que estavam dentro do partial (theme, perfil, logout...)
      scripts.forEach(script => {
        const code = script.textContent || '';
        if (!code.trim()) return;
        try {
          // roda no escopo global
          new Function(code)();
        } catch (err) {
          console.error('[flyout.js] erro ao executar script do partial:', err);
        }
      });

      // monta a mini barra lateral com base nos <a> da sidebar
      buildMiniSidebarFromAside(aside);

      log('sidebar carregado e inicializado.');
    } catch (err) {
      console.error('[flyout.js] erro ao carregar partial:', err);
    }
  }

  // ---------- Init ----------
  function init() {
    const host = document.getElementById('zcSidebarHost');
    if (!host) {
      log('zcSidebarHost não encontrado; nada a fazer.');
      return;
    }
    if (host.dataset.zcFlyoutReady === '1') {
      return;
    }
    host.dataset.zcFlyoutReady = '1';

    const panelShell = host.querySelector('[role="dialog"]') || host;
    bindTriggers(host);
    bindHoverMini(host);
    loadSidebarPartial(host, panelShell);
    log('inicializado');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
