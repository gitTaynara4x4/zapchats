// /frontend/js/atendimentos/ui/flyout.js
// Flyout lateral do atendimento (carrega /frontend/partials/sidebar-atendimentos.html)
// - Gatilho único: botão criado no HEADER da coluna de chats (#btnKebabHeader)
// - Botão fica na PRIMEIRA posição da .wpp-header-titulo-row (logo após a linha cinza)
// - Delegação por data-attributes (não depende de scripts do partial)
// - Reexecuta <script> do partial (inclui type="module")
// - Acessibilidade: aria/inert, foco cíclico, fechar com backdrop/ESC/rota
// - Desktop: sidebar fixa na lateral quando o usuário abrir.
// - Mobile: comportamento de flyout/overlay.

const PARTIAL_URL = '/frontend/partials/sidebar-atendimentos.html';
const MOBILE_MAX_WIDTH = 920;

(function () {
  const host = document.getElementById('zcSidebarHost');
  if (!host) return;

  const panel =
    host.querySelector('[role="dialog"][aria-label]') ||
    host.querySelector('[role="dialog"]');

  const backdrop =
    host.querySelector('.zc-flyout__backdrop') ||
    host.querySelector('[tabindex="-1"]');

  if (!panel || !backdrop) return;

  // garante estado inicial fechado
  host.classList.remove('is-open', 'is-opening', 'is-closing');

  // ===== Utils de viewport =====
  function isMobileView() {
    try {
      if (window.matchMedia) {
        return window.matchMedia(`(max-width:${MOBILE_MAX_WIDTH}px)`).matches;
      }
    } catch {}
    return window.innerWidth <= MOBILE_MAX_WIDTH;
  }

  // mode: "modal" (overlay) | "pinned" (fixo na lateral)
  function getMode() {
    const attr = host.getAttribute('data-mode');
    if (attr === 'pinned' || attr === 'modal') return attr;
    return isMobileView() ? 'modal' : 'pinned';
  }
  function setMode(mode) {
    host.setAttribute('data-mode', mode);
  }

  // ====== helpers para garantir os botões corretos ======

  // Cria/posiciona o kebab SEM depender do HTML
  function ensureHeaderKebab() {
    const row = document.querySelector(
      '.wpp-header-externo .wpp-header-titulo-row'
    );
    if (!row) return null;

    let btn = document.getElementById('btnKebabHeader');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btnKebabHeader';
      btn.type = 'button';
      // usa mesma base visual dos botões de header (sem moldura)
      btn.className = 'hdr-icon-btn';
      btn.setAttribute('aria-label', 'Mais opções');
      btn.title = 'Menu';

      // ícone simples (usa Font Awesome que já está na página)
      btn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';
    }

    // POSIÇÃO: sempre como primeiro filho da linha do título
    // => fica “bem depois” da linha vertical, antes da logo.
    if (row.firstElementChild !== btn) {
      row.insertBefore(btn, row.firstElementChild);
    }

    // Garante que esteja visível
    try {
      btn.style.removeProperty('display');
      btn.style.removeProperty('visibility');
      btn.style.removeProperty('opacity');
    } catch {}

    return btn;
  }

  // Se ainda existir o antigo botão da leftbar, some com ele
  function ensureLeftbarKebab() {
    const btn = document.getElementById('menuOnlyBtn');
    if (!btn) return null;
    try {
      btn.style.setProperty('display', 'none', 'important');
      btn.style.visibility = 'hidden';
      btn.style.opacity = '0';
      btn.setAttribute('aria-hidden', 'true');
    } catch {}
    return btn;
  }

  const headerBtn = ensureHeaderKebab();
  ensureLeftbarKebab();

  const triggers = [headerBtn].filter(Boolean);
  if (triggers.length === 0) return;

  let lastTrigger = null;

  // ===== Helpers visibilidade/backdrop =====
  function applyPointerMode() {
    const mode = getMode();
    const mobile = isMobileView();
    const isModal = mode === 'modal' && mobile;

    if (!host.classList.contains('is-open')) {
      host.style.pointerEvents = 'none';
      panel.style.pointerEvents = 'auto';
      return;
    }

    if (isModal) {
      // overlay: host inteiro captura clique
      host.style.pointerEvents = 'auto';
      panel.style.pointerEvents = 'auto';
    } else {
      // sidebar fixa: só o painel captura cliques
      host.style.pointerEvents = 'none';
      panel.style.pointerEvents = 'auto';
    }
  }

  function showBackdrop() {
    backdrop.classList?.remove('hidden');
    backdrop.removeAttribute?.('aria-hidden');
    backdrop.style.display = 'block';
  }
  function hideBackdrop() {
    backdrop.classList?.add('hidden');
    backdrop.setAttribute?.('aria-hidden', 'true');
    backdrop.style.display = 'none';
  }

  // ===== A11y / estado =====
  const setA11y = (open) => {
    const mode = getMode();
    const isModal = mode === 'modal' && isMobileView();

    triggers.forEach((btn) =>
      btn.setAttribute('aria-expanded', open ? 'true' : 'false')
    );
    host.setAttribute('aria-hidden', open ? 'false' : 'true');

    // Somente no mobile (overlay) a gente trava o fundo
    const body = document.body;
    const main = document.querySelector('main');

    if (isModal) {
      body.classList.toggle('no-scroll', open);
      if (main) {
        if (open) main.setAttribute('inert', '');
        else main.removeAttribute('inert');
      }
    } else {
      body.classList.remove('no-scroll');
      if (main) main.removeAttribute('inert');
    }
  };

  // ===== Focus trap (só no mobile/modal) =====
  function trapFocus(e) {
    if (!host.classList.contains('is-open')) return;
    if (e.key !== 'Tab') return;

    const mode = getMode();
    const isModal = mode === 'modal' && isMobileView();
    if (!isModal) return;

    const focusables = panel.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const openFlyout = (opts = {}) => {
    const mobile = isMobileView();
    const mode = opts.mode || (mobile ? 'modal' : 'pinned');
    setMode(mode);

    host.classList.remove('is-closing');
    host.classList.add('is-open', 'is-opening');

    if (mode === 'modal' && mobile) {
      showBackdrop();
    } else {
      hideBackdrop();
    }

    applyPointerMode();
    setA11y(true);

    setTimeout(() => host.classList.remove('is-opening'), 300);

    setTimeout(() => {
      // No desktop/pinned não forçamos foco; deixamos natural.
      if (mode === 'pinned' && !mobile) return;

      const focusable = panel.querySelector(
        '[autofocus], [href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      (focusable || panel).focus?.();
    }, 10);
  };

  const closeFlyout = (opts = {}) => {
    const force = !!opts.force;
    const mobile = isMobileView();
    const mode = getMode();

    // No desktop modo "pinned" a gente não fecha automaticamente,
    // a não ser que venha um force:true (usuário clicou no botão).
    if (mode === 'pinned' && !mobile && !force) {
      return;
    }

    host.classList.remove('is-opening');
    host.classList.add('is-closing');

    setTimeout(() => {
      host.classList.remove('is-open', 'is-closing');
      hideBackdrop();
      applyPointerMode();
      setA11y(false);
      lastTrigger?.focus?.();
      lastTrigger = null;
    }, 230);
  };

  // ===== Loader do partial =====
  let loaded = false;
  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const html = await fetch(PARTIAL_URL, { credentials: 'include' }).then(
        (r) => r.text()
      );
      panel.innerHTML = html;

      // 1) Delegação (data-action)
      wireActions(panel);

      // 2) Links fecham o flyout (apenas modal/mobile)
      panel.querySelectorAll('a[href]').forEach((a) => {
        a.addEventListener('click', () => {
          const href = (a.getAttribute('href') || '').trim();
          if (!href || href.startsWith('#')) return;
          const mode = getMode();
          if (mode === 'modal' && isMobileView()) {
            closeFlyout({ force: true });
          }
        });
      });

      // 3) Marca rota ativa
      try {
        const here = location.pathname.replace(/\/+$/, '');
        panel.querySelectorAll('nav a[href]').forEach((a) => {
          const href = (a.getAttribute('href') || '').replace(/\/+$/, '');
          const active = href && (here === href || here.endsWith(href));
          a.classList.toggle('active', active);
          if (active) a.setAttribute('aria-current', 'page');
        });
      } catch {}

      // 4) Reexecuta scripts do partial (inclui type="module")
      reExecuteScripts(panel);

      // 5) Move modais do partial pro <body> se necessário
      hoistLooseModals(panel);

      // 6) Atualiza label do tema (se existir)
      updateThemeLabel(panel);
    } catch (e) {
      panel.innerHTML =
        '<div style="padding:16px">Não foi possível carregar o menu.</div>';
      console.error('[menu flyout]', e);
    }
  }

  // ===== Delegação de ações =====
  function wireActions(root) {
    root.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;

      const action = el.getAttribute('data-action');
      switch (action) {
        case 'open-settings':
          location.href = '/frontend/configuracoes.html';
          break;
        case 'open-contatos':
          location.href = '/frontend/clientes.html';
          break;
        case 'new-conversation':
          try {
            window.dispatchEvent(new CustomEvent('nova:conversa'));
          } catch {}
          closeFlyout({ force: true });
          break;
        case 'toggle-theme':
          toggleTheme();
          updateThemeLabel(root);
          break;
        default:
          if (typeof window.onSidebarAction === 'function') {
            window.onSidebarAction(action, el);
          }
          break;
      }
    });
  }

  // ===== Tema (simples) =====
  function toggleTheme() {
    try {
      const el = document.documentElement;
      const cur = el.getAttribute('data-theme') || 'dark';
      const next = cur === 'dark' ? 'light' : 'dark';
      el.setAttribute('data-theme', next);
      localStorage.setItem('zc:theme', next);
      dispatchEvent(
        new CustomEvent('theme:changed', { detail: { theme: next } })
      );
    } catch {}
  }
  function updateThemeLabel(root) {
    const labelSpan = root.querySelector('[data-action="toggle-theme"] .label');
    if (!labelSpan) return;
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    labelSpan.textContent = cur === 'dark' ? 'Tema claro' : 'Tema escuro';
  }

  // ===== Reexecuta scripts do partial =====
  function reExecuteScripts(root) {
    const scripts = Array.from(root.querySelectorAll('script'));
    for (const s of scripts) {
      if (s.type === 'module') {
        const m = document.createElement('script');
        m.type = 'module';
        if (s.src) m.src = s.src;
        else m.textContent = s.textContent || '';
        document.body.appendChild(m);
      } else {
        const n = document.createElement('script');
        if (s.type) n.type = s.type;
        if (s.src) {
          n.src = s.src;
          n.async = s.async;
          n.defer = s.defer;
        } else {
          n.textContent = s.textContent || '';
        }
        document.body.appendChild(n);
      }
      s.remove();
    }
  }

  // ===== Move modais para o <body> =====
  function hoistLooseModals(root) {
    const ids = ['pfModalAtt'];
    ids.forEach((id) => {
      const el = root.querySelector('#' + id);
      if (el && el.parentElement !== document.body) {
        document.body.appendChild(el);
      }
    });
  }

  // Rerender do header (se o app mexer na barra, recoloca o kebab)
  (function watchHeader() {
    const root =
      document.querySelector('.wpp-header-externo') ||
      document.querySelector('header');
    if (!root) return;
    const mo = new MutationObserver(() => {
      try {
        ensureHeaderKebab();
      } catch {}
    });
    mo.observe(root, { childList: true, subtree: true });
    ensureHeaderKebab();
  })();

  // ===== Eventos básicos =====
  triggers.forEach((btn) => {
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-controls', 'zcSidebarHost');
    btn.setAttribute('aria-expanded', 'false');

    btn.addEventListener('click', () => {
      lastTrigger = btn;
      const isOpen = host.classList.contains('is-open');
      const mode = getMode();
      const mobile = isMobileView();

      if (isOpen && mode === 'pinned' && !mobile) {
        // desktop -> alterna (permite esconder se quiser)
        closeFlyout({ force: true });
      } else if (isOpen && mode === 'modal' && mobile) {
        closeFlyout({ force: true });
      } else {
        openFlyout();
        loadOnce();
      }
    });
  });

  backdrop.addEventListener('click', () => closeFlyout({ force: true }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFlyout({ force: true });
    if (e.key === 'Tab') trapFocus(e);
  });

  // Impede clique dentro do painel de fechar
  ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend'].forEach((ev) => {
    panel.addEventListener(
      ev,
      (e) => e.stopPropagation(),
      true
    );
  });

  // Fechar ao navegar (apenas modal/mobile)
  addEventListener('popstate', () => {
    if (isMobileView() && getMode() === 'modal') {
      closeFlyout({ force: true });
    }
  });
  addEventListener('route:change', () => {
    if (isMobileView() && getMode() === 'modal') {
      closeFlyout({ force: true });
    }
  });

  // Fail-safe: backdrop oculto no boot
  hideBackdrop();
  applyPointerMode();
  setA11y(false);

  // ===== Layout inicial: NÃO abre sozinho, só define o modo =====
  function applyInitialLayout() {
    setMode(isMobileView() ? 'modal' : 'pinned');
    // continua fechado; só abre quando clicar
  }
  applyInitialLayout();

  // Se mudar tamanho da tela (desktop <-> mobile), ajusta o modo
  addEventListener('resize', () => {
    const mobile = isMobileView();
    const mode = getMode();
    const isOpen = host.classList.contains('is-open');

    if (!mobile && mode !== 'pinned') {
      // virou desktop: ajusta para pinned
      setMode('pinned');
      if (isOpen) {
        hideBackdrop();
        applyPointerMode();
        setA11y(true);
      } else {
        hideBackdrop();
        applyPointerMode();
        setA11y(false);
      }
    } else if (mobile && mode === 'pinned') {
      // virou mobile: ajusta para modal
      setMode('modal');
      if (isOpen) {
        showBackdrop();
        applyPointerMode();
        setA11y(true);
      } else {
        hideBackdrop();
        applyPointerMode();
        setA11y(false);
      }
    }
  });
})();
