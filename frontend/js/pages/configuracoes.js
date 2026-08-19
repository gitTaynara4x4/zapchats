(function ConfiguracoesPage() {
  'use strict';

  const KEYS = {
    theme: 'zapschat_theme',
    sound: 'zc:notify:sound_enabled',
    desktop: 'zc:notify:desktop_enabled',
    alwaysBeep: 'zc:notify:always_beep'
  };

  const state = {
    summary: null,
    reportBusy: false,
    securityBusy: false,
    valoraBusy: false,
    valoraIntegration: null
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function safeSet(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_) {}
  }

  function readBool(key, fallback) {
    const raw = safeGet(key);
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    safeSet(key, fallback ? '1' : '0');
    return Boolean(fallback);
  }

  function showToast(message, isError = false, timeout = 3800) {
    const el = $('#ZapsChat-toast');
    const icon = el && $('.toast-icon', el);
    const text = el && $('.toast-text', el);
    if (!el || !icon || !text) return;

    text.textContent = message || '';
    el.classList.remove('is-error', 'is-success', 'show');
    icon.className = 'toast-icon fa-solid';

    if (isError) {
      el.classList.add('is-error');
      icon.classList.add('fa-circle-exclamation');
    } else {
      el.classList.add('is-success');
      icon.classList.add('fa-circle-check');
    }

    void el.offsetWidth;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.remove('show'), timeout);
  }

  function setSaveState(label, mode = 'saved') {
    const el = $('#save-state');
    if (!el) return;

    el.classList.remove('is-saving', 'is-error');
    const icon = $('i', el);
    const text = $('.save-state-text', el);

    if (mode === 'saving') {
      el.classList.add('is-saving');
      if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
    } else if (mode === 'error') {
      el.classList.add('is-error');
      if (icon) icon.className = 'fa-solid fa-circle-exclamation';
    } else if (icon) {
      icon.className = 'fa-solid fa-circle-check';
    }

    if (text) text.textContent = label;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body != null && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(path, {
      credentials: 'include',
      cache: 'no-store',
      ...options,
      headers
    });

    let data = null;
    const contentType = response.headers.get('content-type') || '';
    try {
      data = contentType.includes('application/json') ? await response.json() : await response.text();
    } catch (_) {}

    if (!response.ok) {
      const detail = typeof data === 'object' && data
        ? (data.detail || data.message || data.error)
        : data;
      throw new Error(detail || `Erro HTTP ${response.status}`);
    }

    return data;
  }

  function currentTheme() {
    if (window.AppTheme && typeof window.AppTheme.get === 'function') {
      return window.AppTheme.get() === 'dark' ? 'dark' : 'light';
    }
    return safeGet(KEYS.theme) === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    const normalized = theme === 'dark' ? 'dark' : 'light';

    if (window.AppTheme && typeof window.AppTheme.set === 'function') {
      window.AppTheme.set(normalized);
    } else {
      safeSet(KEYS.theme, normalized);
      document.documentElement.classList.toggle('dark', normalized === 'dark');
      document.documentElement.setAttribute('data-theme', normalized);
      try {
        window.dispatchEvent(new CustomEvent('zapschat-theme-changed', {
          detail: { theme: normalized, source: 'configuracoes' }
        }));
      } catch (_) {}
    }

    syncThemeUI(normalized);
  }

  function syncThemeUI(theme = currentTheme()) {
    $$('input[name="theme"]').forEach((input) => {
      input.checked = input.value === theme;
    });

    const metric = $('#metric-theme');
    if (metric) metric.textContent = theme === 'dark' ? 'Escuro' : 'Claro';
  }

  function bindTheme() {
    syncThemeUI();

    $$('input[name="theme"]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        applyTheme(input.value);
        setSaveState('Preferências locais salvas');
        showToast(`Tema ${input.value === 'dark' ? 'escuro' : 'claro'} aplicado.`);
      });
    });

    window.addEventListener('zapschat-theme-changed', (event) => {
      syncThemeUI(event?.detail?.theme || currentTheme());
    });
    window.addEventListener('app:theme-change', (event) => {
      syncThemeUI(event?.detail?.theme || currentTheme());
    });
  }

  function desktopPermissionHint() {
    const hint = $('#desktop-permission-hint');
    if (!hint) return;

    if (!('Notification' in window)) {
      hint.textContent = 'Este navegador não oferece notificações de desktop.';
      return;
    }

    if (Notification.permission === 'denied') {
      hint.textContent = 'Permissão bloqueada no navegador. Libere nas configurações do site.';
    } else if (Notification.permission === 'granted') {
      hint.textContent = 'Permissão concedida pelo navegador.';
    } else {
      hint.textContent = 'O navegador pedirá permissão ao ativar.';
    }
  }

  function syncNotificationUI() {
    const sound = readBool(KEYS.sound, true);
    let desktop = readBool(
      KEYS.desktop,
      'Notification' in window && Notification.permission === 'granted'
    );
    const alwaysBeep = readBool(KEYS.alwaysBeep, false);

    if (!('Notification' in window) || Notification.permission === 'denied') {
      desktop = false;
      safeSet(KEYS.desktop, '0');
    }

    const soundToggle = $('#toggle-sound');
    const desktopToggle = $('#toggle-desktop');
    const alwaysToggle = $('#toggle-always-beep');

    if (soundToggle) soundToggle.checked = sound;
    if (desktopToggle) desktopToggle.checked = desktop;
    if (alwaysToggle) {
      alwaysToggle.checked = alwaysBeep;
      alwaysToggle.disabled = !sound;
    }

    const metric = $('#metric-notifications');
    const detail = $('#metric-notifications-detail');
    const active = sound || desktop;
    if (metric) metric.textContent = active ? 'Ativas' : 'Desativadas';
    if (detail) {
      const parts = [];
      if (sound) parts.push('som');
      if (desktop) parts.push('desktop');
      detail.textContent = parts.length ? parts.join(' e ') : 'Nenhum aviso habilitado';
    }

    desktopPermissionHint();
  }

  async function enableDesktopNotifications() {
    if (!('Notification' in window)) {
      throw new Error('Este navegador não suporta notificações na área de trabalho.');
    }
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') {
      throw new Error('As notificações estão bloqueadas nas configurações do navegador.');
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('A permissão de notificações não foi concedida.');
    }
    return true;
  }

  function bindNotifications() {
    syncNotificationUI();

    $('#toggle-sound')?.addEventListener('change', (event) => {
      safeSet(KEYS.sound, event.target.checked ? '1' : '0');
      syncNotificationUI();
      setSaveState('Preferências locais salvas');
      showToast(event.target.checked ? 'Som de novas mensagens ativado.' : 'Som de novas mensagens desativado.');
    });

    $('#toggle-always-beep')?.addEventListener('change', (event) => {
      safeSet(KEYS.alwaysBeep, event.target.checked ? '1' : '0');
      syncNotificationUI();
      setSaveState('Preferências locais salvas');
      showToast(event.target.checked
        ? 'O som também tocará com a conversa aberta.'
        : 'O som será evitado quando a conversa estiver aberta.');
    });

    $('#toggle-desktop')?.addEventListener('change', async (event) => {
      const input = event.target;
      input.disabled = true;
      try {
        if (input.checked) await enableDesktopNotifications();
        safeSet(KEYS.desktop, input.checked ? '1' : '0');
        setSaveState('Preferências locais salvas');
        showToast(input.checked
          ? 'Notificações na área de trabalho ativadas.'
          : 'Notificações na área de trabalho desativadas.');
      } catch (error) {
        input.checked = false;
        safeSet(KEYS.desktop, '0');
        showToast(error?.message || 'Não foi possível ativar as notificações.', true);
      } finally {
        input.disabled = false;
        syncNotificationUI();
      }
    });
  }

  function planLabel(value) {
    const normalized = String(value || '').trim().toUpperCase();
    const labels = {
      FREE: 'Grátis',
      START: 'Start',
      BUSINESS: 'Business',
      ENTERPRISE: 'Enterprise'
    };
    return labels[normalized] || (normalized ? normalized.charAt(0) + normalized.slice(1).toLowerCase() : '—');
  }

  function initials(name) {
    const parts = String(name || 'ZapsChat').trim().split(/\s+/).filter(Boolean);
    return (parts.slice(0, 2).map((part) => part.charAt(0)).join('') || 'Z').toUpperCase();
  }

  function formatDate(value) {
    if (!value) return 'agora';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'data não informada';
    try {
      return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      }).format(date).replace('.', '');
    } catch (_) {
      return date.toLocaleString('pt-BR');
    }
  }

  function statusLabel(status) {
    const normalized = String(status || 'aberto').toLowerCase();
    return {
      aberto: 'Aberto',
      analisando: 'Em análise',
      resolvido: 'Resolvido',
      fechado: 'Fechado'
    }[normalized] || normalized;
  }

  function renderReports(relatos) {
    const list = $('#report-history');
    const count = $('#report-count');
    if (!list) return;

    const rows = Array.isArray(relatos) ? relatos : [];
    if (count) count.textContent = String(rows.length);

    if (!rows.length) {
      list.innerHTML = '<div class="history-empty"><div><i class="fa-regular fa-message"></i><br>Nenhum relato enviado ainda.</div></div>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const suggestion = row.tipo === 'sugestao';
      const resolved = ['resolvido', 'fechado'].includes(String(row.status || '').toLowerCase());
      return `
        <div class="history-item${suggestion ? ' is-suggestion' : ''}" title="${escapeHtml(row.descricao || '')}">
          <span class="history-icon"><i class="fa-solid ${suggestion ? 'fa-lightbulb' : 'fa-bug'}"></i></span>
          <span class="history-copy">
            <strong>${escapeHtml(row.titulo || 'Relato')}</strong>
            <span>${escapeHtml(formatDate(row.created_at))}</span>
          </span>
          <span class="history-status${resolved ? ' is-resolved' : ''}">${escapeHtml(statusLabel(row.status))}</span>
        </div>`;
    }).join('');
  }

  function renderSummary(summary) {
    state.summary = summary || {};
    const empresa = state.summary.empresa || {};
    const identity = state.summary.identity || {};
    const companyName = empresa.nome || 'Empresa';
    const plan = planLabel(empresa.plano);
    const total = Number(empresa.instancias_total || 0);
    const connected = Number(empresa.instancias_conectadas || 0);

    $('#metric-company').textContent = companyName;
    $('#metric-plan').textContent = `Plano ${plan}`;
    $('#metric-instances').textContent = `${connected}/${total}`;
    $('#metric-instances-detail').textContent = connected === 1
      ? '1 conexão ativa'
      : `${connected} conexões ativas`;

    $('#company-avatar').textContent = initials(companyName);
    $('#company-name').textContent = companyName;
    $('#company-plan').textContent = `Plano ${plan}`;
    $('#company-connected').textContent = String(connected);
    $('#company-total').textContent = String(total);

    const securityToggle = $('#toggle-login-token');
    const securityNote = $('#security-note');
    if (securityToggle) {
      securityToggle.checked = Boolean(empresa.requer_token_login);
      securityToggle.disabled = !identity.can_edit_security;
    }
    if (securityNote) {
      securityNote.classList.toggle('is-admin', Boolean(identity.can_edit_security));
      securityNote.textContent = identity.can_edit_security
        ? 'Somente administradores podem alterar esta proteção. A mudança vale para toda a empresa.'
        : 'Apenas o administrador da empresa pode alterar esta proteção.';
    }

    renderReports(state.summary.relatos || []);
    if (!identity.is_admin) renderValoraIntegration({ pareado: false });
  }

  async function loadSummary({ quiet = false } = {}) {
    if (!quiet) setSaveState('Carregando configurações', 'saving');
    try {
      const summary = await api('/api/configuracoes');
      renderSummary(summary);
      setSaveState('Preferências locais salvas');
      return summary;
    } catch (error) {
      console.error('[configuracoes] Falha ao carregar resumo:', error);
      renderReports([]);
      setSaveState('Falha ao carregar dados da empresa', 'error');
      if (!quiet) showToast(error?.message || 'Não foi possível carregar as configurações.', true);
      return null;
    }
  }

  function bindSecurity() {
    const input = $('#toggle-login-token');
    if (!input) return;

    input.addEventListener('change', async () => {
      if (state.securityBusy) return;
      const previous = !input.checked;
      state.securityBusy = true;
      input.disabled = true;
      setSaveState('Salvando segurança', 'saving');

      try {
        const result = await api('/api/configuracoes/acesso', {
          method: 'PUT',
          body: JSON.stringify({ requer_token_login: input.checked })
        });
        input.checked = Boolean(result.requer_token_login);
        if (state.summary?.empresa) {
          state.summary.empresa.requer_token_login = input.checked;
        }
        setSaveState('Configuração de segurança salva');
        showToast(input.checked
          ? 'Token adicional exigido no login dos colaboradores.'
          : 'Token adicional removido do login dos colaboradores.');
      } catch (error) {
        input.checked = previous;
        setSaveState('Falha ao salvar segurança', 'error');
        showToast(error?.message || 'Não foi possível salvar a segurança.', true);
      } finally {
        state.securityBusy = false;
        input.disabled = !state.summary?.identity?.can_edit_security;
      }
    });
  }

  function renderValoraIntegration(data) {
    state.valoraIntegration = data || null;
    const status = $('#valora-integration-status');
    const connectedBox = $('#valora-connected-box');
    const company = $('#valora-connected-company');
    const lastUse = $('#valora-connected-last-use');
    const generate = $('#btn-gerar-codigo-valora');
    const revoke = $('#btn-revogar-valora');
    const isAdmin = Boolean(state.summary?.identity?.is_admin);
    const paired = Boolean(data?.pareado);

    if (status) {
      status.classList.toggle('is-connected', paired);
      status.classList.toggle('is-restricted', !isAdmin);
      status.textContent = !isAdmin ? 'Somente administrador' : (paired ? 'Conectado' : 'Não conectado');
    }
    if (connectedBox) connectedBox.hidden = !paired;
    if (company) company.textContent = data?.valora_empresa_nome || 'Valora CRM';
    if (lastUse) lastUse.textContent = data?.ultimo_uso_em ? `Último uso: ${formatDate(data.ultimo_uso_em)}` : 'Aguardando primeiro uso';
    if (generate) generate.disabled = !isAdmin || state.valoraBusy;
    if (revoke) revoke.disabled = !isAdmin || state.valoraBusy;
  }

  async function loadValoraIntegration({ quiet = false } = {}) {
    const isAdmin = Boolean(state.summary?.identity?.is_admin);
    if (!isAdmin) {
      renderValoraIntegration({ pareado: false });
      return null;
    }
    try {
      const data = await api('/api/integracoes/valora/admin/status');
      renderValoraIntegration(data);
      return data;
    } catch (error) {
      const status = $('#valora-integration-status');
      if (status) {
        status.textContent = 'Falha ao verificar';
        status.classList.add('is-restricted');
      }
      if (!quiet) showToast(error?.message || 'Não foi possível verificar a integração com o Valora.', true);
      return null;
    }
  }

  function bindValoraIntegration() {
    const generate = $('#btn-gerar-codigo-valora');
    const copy = $('#btn-copiar-codigo-valora');
    const revoke = $('#btn-revogar-valora');

    generate?.addEventListener('click', async () => {
      if (state.valoraBusy || !state.summary?.identity?.is_admin) return;
      state.valoraBusy = true;
      generate.disabled = true;
      const original = generate.innerHTML;
      generate.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Gerando…</span>';
      try {
        const data = await api('/api/integracoes/valora/admin/codigo-pareamento', { method: 'POST' });
        const card = $('#pairing-code-card');
        const code = $('#valora-pairing-code');
        const expiry = $('#valora-pairing-expiry');
        if (code) code.textContent = String(data.codigo || '').replace(/(\d{4})(\d{4})/, '$1 $2');
        if (expiry) expiry.textContent = data.expira_em ? `Expira ${formatDate(data.expira_em)}` : 'Expira em 10 minutos';
        if (card) card.hidden = false;
        showToast('Código gerado. Agora cole-o no Valora CRM.');
      } catch (error) {
        showToast(error?.message || 'Não foi possível gerar o código.', true);
      } finally {
        state.valoraBusy = false;
        generate.disabled = false;
        generate.innerHTML = original;
      }
    });

    copy?.addEventListener('click', async () => {
      const raw = String($('#valora-pairing-code')?.textContent || '').replace(/\D/g, '');
      if (!raw) return;
      try {
        await navigator.clipboard.writeText(raw);
        showToast('Código copiado.');
      } catch (_) {
        showToast('Não foi possível copiar automaticamente.', true);
      }
    });

    revoke?.addEventListener('click', async () => {
      if (state.valoraBusy || !state.summary?.identity?.is_admin) return;
      if (!confirm('Desconectar o Valora desta empresa? As cobranças por WhatsApp deixarão de ser enviadas até um novo pareamento.')) return;
      state.valoraBusy = true;
      revoke.disabled = true;
      try {
        await api('/api/integracoes/valora/admin/conexao', { method: 'DELETE' });
        const card = $('#pairing-code-card');
        if (card) card.hidden = true;
        showToast('Integração com o Valora desconectada.');
        await loadValoraIntegration({ quiet: true });
      } catch (error) {
        showToast(error?.message || 'Não foi possível desconectar o Valora.', true);
      } finally {
        state.valoraBusy = false;
        revoke.disabled = false;
      }
    });
  }

  function bindReportForm() {
    const form = $('#form-report');
    const type = $('#report-type');
    const title = $('#report-title');
    const description = $('#report-description');
    const page = $('#report-page');
    const counter = $('#report-counter');
    const button = $('#btn-send-report');
    if (!form || !type || !title || !description || !page || !button) return;

    page.value = location.pathname || '/configuracoes';

    const updateCounter = () => {
      if (counter) counter.textContent = String(description.value.length);
    };
    description.addEventListener('input', updateCounter);
    updateCounter();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.reportBusy) return;

      const payload = {
        tipo: type.value === 'sugestao' ? 'sugestao' : 'bug',
        titulo: title.value.trim(),
        descricao: description.value.trim(),
        pagina: page.value || location.pathname
      };

      if (payload.titulo.length < 4) {
        showToast('Informe um título mais claro para o relato.', true);
        title.focus();
        return;
      }
      if (payload.descricao.length < 10) {
        showToast('Descreva melhor o que aconteceu.', true);
        description.focus();
        return;
      }

      state.reportBusy = true;
      button.disabled = true;
      const original = button.innerHTML;
      button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Enviando…</span>';

      try {
        const result = await api('/api/configuracoes/relatos', {
          method: 'POST',
          body: JSON.stringify(payload)
        });

        form.reset();
        page.value = location.pathname || '/configuracoes';
        updateCounter();

        const current = Array.isArray(state.summary?.relatos) ? state.summary.relatos : [];
        const next = [result.relato, ...current.filter((item) => item.id !== result.relato.id)].slice(0, 6);
        if (!state.summary) state.summary = {};
        state.summary.relatos = next;
        renderReports(next);
        showToast('Relato registrado com sucesso.');
      } catch (error) {
        console.error('[configuracoes] Falha ao enviar relato:', error);
        showToast(error?.message || 'Não foi possível registrar o relato.', true);
      } finally {
        state.reportBusy = false;
        button.disabled = false;
        button.innerHTML = original;
      }
    });
  }

  async function init() {
    bindTheme();
    bindNotifications();
    bindSecurity();
    bindValoraIntegration();
    bindReportForm();
    await loadSummary();
    await loadValoraIntegration({ quiet: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
