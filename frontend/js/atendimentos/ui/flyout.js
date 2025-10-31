// /frontend/js/atendimentos/ui/flyout.js
// Flyout lateral do atendimento (carrega /frontend/partials/sidebar-atendimentos.html)
// - Suporta múltiplos gatilhos (#menuOnlyBtn, #btnKebabHeader)
// - Kebab fixado no lado direito do header (desktop e mobile)
// - Delegação por data-attributes (não depende de scripts do partial)
// - Reexecuta <script> do partial (inclui type="module")
// - Acessibilidade: aria/inert, foco cíclico, fechar com backdrop/ESC/rota
// - Hardening mobile: backdrop fechado não captura clique (display:none)

const PARTIAL_URL = '/frontend/partials/sidebar-atendimentos.html';

(function () {
  const host = document.getElementById('zcSidebarHost');
  if (!host) return;

  // NÃO usamos mais .zc-flyout__panel — buscamos por role="dialog"
  const panel =
    host.querySelector('[role="dialog"][aria-label]') ||
    host.querySelector('[role="dialog"]');

  // Backdrop: tenta pela classe; se não existir, pega o botão tabindex="-1"
  const backdrop =
    host.querySelector('.zc-flyout__backdrop') ||
    host.querySelector('[tabindex="-1"]');

  // ====== helpers para garantir os botões corretos ======

  // Garante um "slot" de ícones à direita do header e injeta o kebab lá dentro.
  function ensureHeaderKebab(){
    const row =
      document.querySelector('.wpp-header-externo .wpp-header-titulo-row') ||
      document.querySelector('header');

    if (!row) return null;

    // container de ícones no lado direito
    let slot = row.querySelector('.wpp-header-icons');
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'wpp-header-icons';
      slot.style.display    = 'flex';
      slot.style.gap        = '4px';
      slot.style.marginLeft = 'auto';
      row.appendChild(slot);
    }

    // cria/recupera o botão do header
    let btn = document.getElementById('btnKebabHeader');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btnKebabHeader';
      btn.type = 'button';
      btn.className = 'hdr-icon-btn';
      btn.setAttribute('aria-label','Mais opções');
      btn.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
          '<circle cx="5" cy="12" r="2"/>' +
          '<circle cx="12" cy="12" r="2"/>' +
          '<circle cx="19" cy="12" r="2"/>' +
        '</svg>';
    }
    if (btn.parentElement !== slot) slot.appendChild(btn);

    // força mostrar no desktop e mobile
    try {
      btn.style.setProperty('display','inline-grid','important');
      btn.style.removeProperty('visibility');
      btn.style.removeProperty('opacity');
    } catch {}

    return btn;
  }

  // Opcional: se existir um kebab na leftbar, mantemos oculto p/ evitar duplicado
  function ensureLeftbarKebab(){
    const btn = document.getElementById('menuOnlyBtn');
    if (!btn) return null;
    try {
      btn.style.setProperty('display','none','important');
      btn.style.visibility = 'hidden';
      btn.style.opacity    = '0';
    } catch {}
    return btn;
  }

  // injeta/organiza antes de capturar gatilhos
  const headerBtn  = ensureHeaderKebab();
  ensureLeftbarKebab();

  // Gatilhos (desktop + mobile) — após garantir o headerBtn
  const triggers = [headerBtn, document.getElementById('menuOnlyBtn')].filter(Boolean);

  if (!panel || !backdrop || triggers.length === 0) return;

  let lastTrigger = null;

  // ===== Helpers visibilidade/backdrop =====
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
    triggers.forEach((btn) =>
      btn.setAttribute('aria-expanded', open ? 'true' : 'false')
    );
    host.setAttribute('aria-hidden', open ? 'false' : 'true');
    document.body.classList.toggle('no-scroll', open);

    // inert no <main>
    try {
      const main = document.querySelector('main');
      if (main) {
        if (open) main.setAttribute('inert', '');
        else main.removeAttribute('inert');
      }
    } catch {}
  };

  // ===== Focus trap =====
  function trapFocus(e) {
    if (!host.classList.contains('is-open')) return;
    if (e.key !== 'Tab') return;

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

  const openFlyout = () => {
    host.classList.remove('is-closing');
    host.classList.add('is-open', 'is-opening');
    showBackdrop();
    setA11y(true);
    setTimeout(() => host.classList.remove('is-opening'), 300);

    // Foco inicial
    setTimeout(() => {
      const focusable = panel.querySelector(
        '[autofocus], [href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      (focusable || panel).focus?.();
    }, 10);
  };

  const closeFlyout = () => {
    host.classList.remove('is-opening');
    host.classList.add('is-closing');
    setTimeout(() => {
      host.classList.remove('is-open', 'is-closing');
      hideBackdrop();
      setA11y(false);
      lastTrigger?.focus?.();
      lastTrigger = null;
    }, 230);
  };

  // ===== Eventos básicos =====
  triggers.forEach((btn) => {
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-controls', 'zcSidebarHost');
    btn.setAttribute('aria-expanded', 'false');

    btn.addEventListener('click', () => {
      lastTrigger = btn;
      openFlyout();
      loadOnce();
    });
  });

  backdrop.addEventListener('click', closeFlyout);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFlyout();
    if (e.key === 'Tab') trapFocus(e);
  });

  // Impede clique dentro do painel de fechar
  ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend'].forEach((ev) => {
    panel.addEventListener(ev, (e) => e.stopPropagation(), true);
  });

  // Fechar ao navegar
  addEventListener('popstate', closeFlyout);
  addEventListener('route:change', closeFlyout);

  // ===== Loader do partial =====
  let loaded = false;
  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const html = await fetch(PARTIAL_URL, { credentials: 'include' }).then((r) => r.text());
      panel.innerHTML = html;

      // 1) Delegação (data-action)
      wireActions(panel);

      // 2) Links fecham o flyout
      panel.querySelectorAll('a[href]').forEach((a) => {
        a.addEventListener('click', () => {
          const href = (a.getAttribute('href') || '').trim();
          if (href && !href.startsWith('#')) closeFlyout();
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
          try { window.dispatchEvent(new CustomEvent('nova:conversa')); } catch {}
          closeFlyout();
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
      dispatchEvent(new CustomEvent('theme:changed', { detail: { theme: next } }));
    } catch {}
  }
  function updateThemeLabel(root) {
    const btn = root.querySelector('[data-action="toggle-theme"] .label');
    if (!btn) return;
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    btn.textContent = cur === 'dark' ? 'Tema claro' : 'Tema escuro';
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

  // ===== Alinhamento opcional do botão lateral (mantido, mas oculto) =====
  function alignDots() {
    try {
      const leftBtn = document.getElementById('menuOnlyBtn');
      if (!leftBtn) return;
      const row = document.querySelector('.wpp-header-externo .wpp-header-titulo-row');
      if (!row) return;
      const r1 = row.getBoundingClientRect();
      const r2 = leftBtn.getBoundingClientRect();
      leftBtn.style.marginTop =
        14 + Math.round(r1.top + r1.height / 2 - (r2.top + r2.height / 2)) + 'px';
    } catch {}
  }
  addEventListener('load', alignDots);
  addEventListener('resize', alignDots);
  try {
    new ResizeObserver(alignDots).observe(
      document.querySelector('.wpp-header-externo') || document.body
    );
  } catch {}

  // Rerender do header (ex.: breakpoint/mobile) — recoloca o kebab na direita
  (function watchHeader(){
    const root = document.querySelector('.wpp-header-externo') || document.querySelector('header');
    if (!root) return;
    const mo = new MutationObserver(() => { try { ensureHeaderKebab(); } catch {} });
    mo.observe(root, { childList: true, subtree: true });
    ensureHeaderKebab();
  })();

  // Fail-safe: backdrop oculto no boot
  hideBackdrop();
})();
