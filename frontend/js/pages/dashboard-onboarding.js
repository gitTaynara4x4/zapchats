(function ZapsChatOnboarding() {
  'use strict';

  const STATUS_URL = '/api/usuarios/me/onboarding';
  const COMPLETE_URL = '/api/usuarios/me/onboarding/complete';
  const LOCAL_SEEN_PREFIX = 'zapschat:onboarding:v1:seen';
  const OPEN_EVENT = 'zapschat:onboarding:open';

  const steps = [
    {
      eyebrow: 'Bem-vindo ao ZapsChat',
      title: 'Todos os atendimentos em um só lugar',
      text: 'Centralize as conversas do WhatsApp, organize sua equipe e acompanhe cada cliente sem perder o histórico.',
      points: ['Conversas centralizadas', 'Histórico preservado', 'Visão clara da operação'],
      accent: 'welcome'
    },
    {
      eyebrow: 'Atendimento organizado',
      title: 'Assuma conversas com segurança',
      text: 'Novas mensagens entram na fila. O colaborador clica em Atender, assume a conversa e o sistema registra quem ficou responsável.',
      points: ['Fila de novos atendimentos', 'Responsável identificado', 'Menos respostas duplicadas'],
      accent: 'service'
    },
    {
      eyebrow: 'Equipe alinhada',
      title: 'Transfira para o setor certo',
      text: 'Organize colaboradores por departamento, transfira atendimentos e mantenha todo o contexto disponível para quem continuar a conversa.',
      points: ['Departamentos e filas', 'Transferências com contexto', 'Permissões por colaborador'],
      accent: 'team'
    },
    {
      eyebrow: 'Tudo pronto',
      title: 'Comece conectando sua operação',
      text: 'Conecte o WhatsApp, confira sua equipe e abra a área de atendimentos. A apresentação não aparecerá novamente automaticamente.',
      points: ['Conectar WhatsApp', 'Cadastrar equipe', 'Começar a atender'],
      accent: 'ready'
    }
  ];

  let currentStep = 0;
  let shell = null;
  let lastFocused = null;
  let firstOpenRecorded = false;
  let currentIdentityKey = '';
  let autoOpenTimer = 0;

  function authFetch(url, options) {
    const fetcher = window.ZAuth?.guardFetch || window.ZAuth?.authFetch || window.fetch;
    return fetcher(url, {
      credentials: 'include',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options?.headers || {})
      }
    });
  }

  function safeLocalGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function safeLocalSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {}
  }

  function localSeenKey(identityKey) {
    return identityKey ? `${LOCAL_SEEN_PREFIX}:${identityKey}` : '';
  }

  function identityKeyFrom(data) {
    const kind = String(data?.actor_kind || '').trim();
    const id = Number(data?.actor_id || 0);
    return kind && id > 0 ? `${kind}:${id}` : '';
  }

  function isOpen() {
    return !!(shell && !shell.hidden && shell.classList.contains('is-open'));
  }

  function iconSvg(name) {
    const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    const icons = {
      welcome: `<svg ${common}><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4.4A2.5 2.5 0 0 1 4 13.5z"></path><path d="M8 9h8"></path><path d="M8 12h5"></path></svg>`,
      service: `<svg ${common}><path d="M4 5h16v11H7l-3 3z"></path><path d="M8 9h8"></path><path d="M8 12h5"></path><path d="m16.5 18 1.5 1.5 3-3"></path></svg>`,
      team: `<svg ${common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
      ready: `<svg ${common}><circle cx="12" cy="12" r="9"></circle><path d="m8 12 2.6 2.6L16.5 8.7"></path></svg>`,
      close: `<svg ${common}><path d="m18 6-12 12"></path><path d="m6 6 12 12"></path></svg>`,
      back: `<svg ${common}><path d="m15 18-6-6 6-6"></path></svg>`,
      next: `<svg ${common}><path d="m9 18 6-6-6-6"></path></svg>`
    };
    return icons[name] || icons.welcome;
  }

  function ensureShell() {
    if (shell && document.body.contains(shell)) return shell;

    shell = document.createElement('div');
    shell.className = 'zc-onboarding-shell';
    shell.hidden = true;
    shell.setAttribute('aria-hidden', 'true');
    shell.innerHTML = `
      <div class="zc-onboarding-backdrop" data-zc-onboarding-close></div>
      <section class="zc-onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="zc-onboarding-title" aria-describedby="zc-onboarding-text">
        <button class="zc-onboarding-close" type="button" aria-label="Fechar apresentação" data-zc-onboarding-close>
          ${iconSvg('close')}
        </button>

        <aside class="zc-onboarding-visual" aria-hidden="true">
          <div class="zc-onboarding-orbit orbit-one"></div>
          <div class="zc-onboarding-orbit orbit-two"></div>
          <div class="zc-onboarding-visual-badge" data-zc-onboarding-icon>${iconSvg('welcome')}</div>
          <img src="/frontend/img/help/zc-robot-floating.png" alt="" class="zc-onboarding-robot" />
          <div class="zc-onboarding-mini-card mini-card-top">
            <span class="mini-dot"></span>
            <span>WhatsApp conectado</span>
          </div>
          <div class="zc-onboarding-mini-card mini-card-bottom">
            <strong>Atendimento organizado</strong>
            <small>Equipe, filas e histórico</small>
          </div>
        </aside>

        <div class="zc-onboarding-content">
          <div class="zc-onboarding-progress" aria-label="Progresso da apresentação">
            ${steps.map((_, index) => `<span data-zc-onboarding-dot="${index}"></span>`).join('')}
          </div>

          <span class="zc-onboarding-eyebrow" data-zc-onboarding-eyebrow></span>
          <h2 id="zc-onboarding-title" data-zc-onboarding-title></h2>
          <p id="zc-onboarding-text" data-zc-onboarding-text></p>

          <div class="zc-onboarding-points" data-zc-onboarding-points></div>

          <div class="zc-onboarding-footer">
            <button type="button" class="zc-onboarding-skip" data-zc-onboarding-skip>Pular apresentação</button>
            <div class="zc-onboarding-actions">
              <button type="button" class="zc-onboarding-secondary" data-zc-onboarding-back>
                ${iconSvg('back')}<span>Voltar</span>
              </button>
              <button type="button" class="zc-onboarding-primary" data-zc-onboarding-next>
                <span>Próximo</span>${iconSvg('next')}
              </button>
            </div>
          </div>
        </div>
      </section>
    `;

    document.body.appendChild(shell);
    bindShell(shell);
    return shell;
  }

  function bindShell(root) {
    root.querySelectorAll('[data-zc-onboarding-close]').forEach((button) => {
      button.addEventListener('click', closeOnboarding);
    });

    root.querySelector('[data-zc-onboarding-skip]')?.addEventListener('click', closeOnboarding);
    root.querySelector('[data-zc-onboarding-back]')?.addEventListener('click', () => {
      if (currentStep > 0) {
        currentStep -= 1;
        renderStep();
      }
    });
    root.querySelector('[data-zc-onboarding-next]')?.addEventListener('click', () => {
      if (currentStep < steps.length - 1) {
        currentStep += 1;
        renderStep();
        return;
      }
      closeOnboarding();
      window.location.href = '/atendimentos';
    });

    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeOnboarding();
        return;
      }

      if (event.key === 'ArrowRight' && currentStep < steps.length - 1) {
        currentStep += 1;
        renderStep();
      }

      if (event.key === 'ArrowLeft' && currentStep > 0) {
        currentStep -= 1;
        renderStep();
      }

      if (event.key === 'Tab') trapFocus(event, root);
    });
  }

  function trapFocus(event, root) {
    const focusable = Array.from(root.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter((element) => !element.hidden && element.offsetParent !== null);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function renderStep() {
    const root = ensureShell();
    const step = steps[currentStep];

    root.dataset.step = String(currentStep + 1);
    root.dataset.accent = step.accent;
    root.querySelector('[data-zc-onboarding-eyebrow]').textContent = step.eyebrow;
    root.querySelector('[data-zc-onboarding-title]').textContent = step.title;
    root.querySelector('[data-zc-onboarding-text]').textContent = step.text;
    root.querySelector('[data-zc-onboarding-icon]').innerHTML = iconSvg(step.accent);

    const points = root.querySelector('[data-zc-onboarding-points]');
    points.innerHTML = step.points.map((point) => `
      <div class="zc-onboarding-point">
        <span class="zc-onboarding-check" aria-hidden="true">✓</span>
        <span>${point}</span>
      </div>
    `).join('');

    root.querySelectorAll('[data-zc-onboarding-dot]').forEach((dot, index) => {
      dot.classList.toggle('is-active', index === currentStep);
      dot.classList.toggle('is-complete', index < currentStep);
    });

    const backButton = root.querySelector('[data-zc-onboarding-back]');
    const nextButton = root.querySelector('[data-zc-onboarding-next]');
    const skipButton = root.querySelector('[data-zc-onboarding-skip]');

    backButton.disabled = currentStep === 0;
    backButton.classList.toggle('is-hidden', currentStep === 0);
    nextButton.querySelector('span').textContent = currentStep === steps.length - 1 ? 'Começar agora' : 'Próximo';
    nextButton.classList.toggle('is-final', currentStep === steps.length - 1);
    skipButton.textContent = currentStep === steps.length - 1 ? 'Ficar no Dashboard' : 'Pular apresentação';
  }

  function openOnboarding(options) {
    if (autoOpenTimer) {
      window.clearTimeout(autoOpenTimer);
      autoOpenTimer = 0;
    }

    const root = ensureShell();
    currentStep = 0;
    lastFocused = document.activeElement;
    renderStep();

    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('zc-onboarding-open');
    requestAnimationFrame(() => {
      root.classList.add('is-open');
      root.querySelector('[data-zc-onboarding-next]')?.focus({ preventScroll: true });
    });

    if (options?.firstVisit) recordFirstOpen();
  }

  function closeOnboarding() {
    if (!shell || shell.hidden) return;

    shell.classList.remove('is-open');
    shell.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('zc-onboarding-open');

    window.setTimeout(() => {
      if (shell) shell.hidden = true;
      if (lastFocused && typeof lastFocused.focus === 'function') {
        try { lastFocused.focus({ preventScroll: true }); } catch (_) {}
      }
    }, 180);
  }

  async function recordFirstOpen() {
    if (firstOpenRecorded) return;
    firstOpenRecorded = true;
    const seenKey = localSeenKey(currentIdentityKey);
    if (seenKey) safeLocalSet(seenKey, '1');

    try {
      const response = await authFetch(COMPLETE_URL, { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.warn('[onboarding] Não foi possível salvar a conclusão no servidor.', error);
    }
  }

  async function checkFirstVisit() {
    try {
      const response = await authFetch(STATUS_URL, { method: 'GET', cache: 'no-store' });
      if (!response.ok) return;

      const data = await response.json();
      currentIdentityKey = identityKeyFrom(data);
      const seenKey = localSeenKey(currentIdentityKey);
      const locallySeen = seenKey ? safeLocalGet(seenKey) === '1' : false;

      if (data?.completed) {
        if (seenKey) safeLocalSet(seenKey, '1');
        return;
      }

      if (locallySeen || isOpen()) {
        recordFirstOpen();
        return;
      }

      autoOpenTimer = window.setTimeout(() => {
        autoOpenTimer = 0;
        if (!isOpen()) openOnboarding({ firstVisit: true });
      }, 450);
    } catch (error) {
      console.warn('[onboarding] Verificação inicial indisponível.', error);
    }
  }

  function start() {
    ensureShell();
    window.addEventListener(OPEN_EVENT, () => openOnboarding({ firstVisit: false }));
    checkFirstVisit();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
