// /frontend/js/pages/chatbot.js
// Chatbot Config – ZapsChat
// ✅ Modo 1: Resposta automática simples
// ✅ Modo 2: Menu para o cliente escolher a FILA
// ✅ Usa departamentos retornados por: /api/chatbot/config?empresa_id=...&instancia_id=...
// ✅ Mantém IDs antigos "dept..." no DOM para não quebrar CSS/HTML
// ✅ Salva config em /api/chatbot/config
// ✅ O departamento é aplicado no atendimento quando o cliente escolher.
// ✅ Corrigido: departamentos NÃO vêm marcados por padrão. O usuário precisa marcar manualmente.

(() => {
  'use strict';

  const VERSION = 'zc-chatbot-departamentos-v2';
  if (window.__ZC_CHATBOT_PAGE_VERSION__ === VERSION) return;
  window.__ZC_CHATBOT_PAGE_VERSION__ = VERSION;

  const LS = localStorage;
  const EMPRESA_ID   = () => Number(LS.getItem('empresa_id') || LS.getItem('EMPRESA_ID') || 0);
  const EMPRESA_NOME = () => (LS.getItem('empresa_nome') || '[Empresa]').trim();
  const TOKEN        = () => LS.getItem('token') || LS.getItem('auth_token') || LS.getItem('access_token') || '';
  const FALLBACK_TZ  = 'America/Sao_Paulo';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

  async function authFetch(input, init = {}) {
    const t = TOKEN();
    const headers = {
      ...(init.headers || {}),
      ...(t ? { Authorization: `Bearer ${t}` } : {})
    };

    if (window.ZAuth && typeof window.ZAuth.authFetch === 'function') {
      return window.ZAuth.authFetch(input, { ...init, headers, credentials: 'include' });
    }

    return fetch(input, { ...init, headers, credentials: 'include' });
  }

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function ensureToastHost() {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = el('div', 'toast-host');
      host.id = 'toast-host';
      host.style.cssText = 'position:fixed;right:16px;top:16px;z-index:99999;display:flex;flex-direction:column;gap:8px';
      document.body.appendChild(host);
    }
    return host;
  }

  function toast(msg, kind = 'success') {
    const host = ensureToastHost();
    const box = el('div', 'toast');

    box.style.cssText =
      'min-width:280px;max-width:520px;padding:12px 14px;border-radius:12px;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.25);font:14px/1.35 Inter,system-ui;transition:.25s';

    const color = kind === 'error' ? '#fee2e2' : kind === 'warn' ? '#fef3c7' : '#ecfeff';
    box.style.background = color;
    box.style.color = '#0f172a';
    box.textContent = msg;

    host.appendChild(box);

    setTimeout(() => {
      box.style.opacity = '0';
      box.style.transform = 'translateY(-6px)';
      setTimeout(() => box.remove(), 240);
    }, 2800);
  }

  function showRobotCelebration() {
    const box = document.getElementById('robotCelebration');
    if (!box) return;
    box.classList.remove('show');
    box.setAttribute('aria-hidden', 'false');
    clearTimeout(showRobotCelebration._t);
    requestAnimationFrame(() => {
      box.classList.add('show');
      showRobotCelebration._t = setTimeout(() => {
        box.classList.remove('show');
        box.setAttribute('aria-hidden', 'true');
      }, 3200);
    });
  }

  function initRobotUI() {
    const onboard = document.getElementById('robotOnboarding');
    const onboardClose = document.getElementById('robotOnboardingClose');
    const tip = document.getElementById('robotTipCard');
    const tipClose = document.getElementById('robotTipClose');

    const ONBOARD_KEY = 'zc-chatbot-robot-onboarding-closed:v1';
    const TIP_KEY = 'zc-chatbot-robot-tip-closed:v1';

    try {
      if (onboard && LS.getItem(ONBOARD_KEY) !== '1') onboard.hidden = false;
      if (tip && LS.getItem(TIP_KEY) !== '1') tip.hidden = false;
    } catch (_) {
      if (onboard) onboard.hidden = false;
      if (tip) tip.hidden = false;
    }

    onboardClose?.addEventListener('click', () => {
      if (onboard) onboard.hidden = true;
      try { LS.setItem(ONBOARD_KEY, '1'); } catch (_) {}
    });

    tipClose?.addEventListener('click', () => {
      if (tip) tip.hidden = true;
      try { LS.setItem(TIP_KEY, '1'); } catch (_) {}
    });
  }

  function notify({ title = 'Atenção', message = '', kind = 'warn', details = null, actions = [] } = {}) {
    const overlay = el('div');
    overlay.className = `zc-clean-modal zc-clean-modal--${kind || 'warn'}`;
    overlay.setAttribute('role', 'presentation');

    const card = el('div');
    card.className = 'zc-clean-dialog';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'zc-clean-notify-title');

    const head = el('div');
    head.className = 'zc-clean-dialog__head';

    const icon = el('span');
    icon.className = 'zc-clean-dialog__icon';
    icon.innerHTML = kind === 'error'
      ? '<i class="fa-solid fa-triangle-exclamation"></i>'
      : (kind === 'success' ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-circle-info"></i>');

    const titleWrap = el('div');
    titleWrap.className = 'zc-clean-dialog__titlewrap';

    const h = el('h3');
    h.id = 'zc-clean-notify-title';
    h.textContent = title;

    titleWrap.append(h);
    head.append(icon, titleWrap);

    const body = el('div');
    body.className = 'zc-clean-dialog__body';
    body.innerHTML = String(message || '').replace(/\n/g, '<br>');

    const detWrap = el('div');
    detWrap.className = 'zc-clean-dialog__details';
    detWrap.hidden = !details;

    const toggle = el('button');
    toggle.type = 'button';
    toggle.className = 'zc-clean-dialog__details-btn';
    toggle.textContent = 'Ver detalhes técnicos';

    const pre = el('pre');
    pre.textContent = details || '';
    pre.hidden = true;

    toggle.addEventListener('click', () => {
      pre.hidden = !pre.hidden;
      toggle.textContent = pre.hidden ? 'Ver detalhes técnicos' : 'Ocultar detalhes técnicos';
    });

    detWrap.append(toggle, pre);

    const footer = el('div');
    footer.className = 'zc-clean-dialog__footer';

    actions.forEach((actionBtn) => {
      if (actionBtn && actionBtn.nodeType === 1) {
        actionBtn.classList.add('zc-clean-dialog__action');
      }
    });

    const ok = el('button');
    ok.type = 'button';
    ok.textContent = 'OK';
    ok.className = 'zc-clean-dialog__btn zc-clean-dialog__btn--primary';
    ok.addEventListener('click', () => overlay.remove());

    footer.append(...actions, ok);
    card.append(head, body, detWrap, footer);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.addEventListener('keydown', function onEsc(e){
      if (e.key !== 'Escape') return;
      overlay.remove();
      document.removeEventListener('keydown', onEsc);
    });

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => ok.focus?.(), 0);
  }

  function confirmAction({
    title = 'Confirmar ação',
    message = 'Tem certeza que deseja continuar?',
    confirmText = 'Sim, desligar',
    cancelText = 'Cancelar',
    kind = 'warn'
  } = {}) {
    return new Promise((resolve) => {
      const overlay = el('div');
      overlay.className = `zc-clean-modal zc-clean-modal--${kind || 'warn'}`;
      overlay.setAttribute('role', 'presentation');

      const card = el('div');
      card.className = 'zc-clean-dialog zc-clean-dialog--confirm';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', 'zc-clean-confirm-title');

      const head = el('div');
      head.className = 'zc-clean-dialog__head';

      const icon = el('span');
      icon.className = 'zc-clean-dialog__icon';
      icon.innerHTML = kind === 'error'
        ? '<i class="fa-solid fa-trash-can"></i>'
        : (kind === 'success' ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-power-off"></i>');

      const titleWrap = el('div');
      titleWrap.className = 'zc-clean-dialog__titlewrap';

      const h = el('h3');
      h.id = 'zc-clean-confirm-title';
      h.textContent = title;

      titleWrap.append(h);
      head.append(icon, titleWrap);

      const body = el('div');
      body.className = 'zc-clean-dialog__body';
      body.innerHTML = String(message || '').replace(/\n/g, '<br>');

      const footer = el('div');
      footer.className = 'zc-clean-dialog__footer';

      const cancel = el('button');
      cancel.type = 'button';
      cancel.textContent = cancelText;
      cancel.className = 'zc-clean-dialog__btn zc-clean-dialog__btn--ghost';

      const confirm = el('button');
      confirm.type = 'button';
      confirm.textContent = confirmText;
      confirm.className = 'zc-clean-dialog__btn zc-clean-dialog__btn--danger';

      function close(v) {
        overlay.remove();
        resolve(v);
      }

      cancel.addEventListener('click', () => close(false));
      confirm.addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });

      document.addEventListener('keydown', function onEsc(e){
        if (e.key !== 'Escape') return;
        close(false);
        document.removeEventListener('keydown', onEsc);
      });

      footer.append(cancel, confirm);
      card.append(head, body, footer);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      setTimeout(() => cancel.focus?.(), 0);
    });
  }

  function friendlyHttpError(status, detailText = '') {
    const msgs = {
      0:   ['Sem conexão', 'Não conseguimos falar com o servidor.'],
      400: ['Não foi possível salvar', 'Revise os horários e os textos das mensagens.'],
      401: ['Sessão expirada', 'Faça login novamente para continuar.'],
      403: ['Permissão negada', 'Você não pode alterar esta instância.'],
      404: ['Não encontrado', 'A instância, configuração ou departamento não foi encontrada.'],
      409: ['Conflito', 'As configurações mudaram enquanto você editava.'],
      422: ['Dados incompletos', 'Preencha os campos obrigatórios e salve de novo.'],
      429: ['Muitas tentativas', 'Aguarde alguns segundos e tente novamente.'],
      500: ['Ops! Algo deu errado', 'Falha no servidor. Tente novamente.']
    };

    const k = (status >= 500) ? 500 : (msgs[status] ? status : 0);
    const [title, message] = msgs[k];
    return { title, message, details: detailText || '' };
  }

  const instBtn   = document.getElementById('instMenuBtnChat');
  const instLabel = document.getElementById('instMenuLabelChat');
  const instMenu  = document.getElementById('inst-menu-chat');
  const instList  = document.getElementById('instMenuListChat');

  const normalizeInstValue = (v) => (v ?? '').toString().trim();
  const getActiveInstKey   = () => normalizeInstValue(window.__INST_ID || '');

  function requireActiveInstKey() {
    const k = getActiveInstKey();
    if (!k) throw new Error('INST_REQUIRED');
    return k;
  }

  function lockUI(locked, msg) {
    const controls = document.querySelectorAll(
      '.tswitch input, textarea, input[type="time"], #saveAuto, #saveDept, ' +
      'button:not(#instMenuBtnChat):not(.inst-item):not(#helpChatbotBtn):not(#automationHelpBtn):not(.help-close):not([data-close-modal]), select'
    );

    controls.forEach(x => {
      x.disabled = !!locked;
    });

    let banner = document.getElementById('instRequiredBanner');

    if (locked) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'instRequiredBanner';
        banner.className = 'alert warn';
        banner.style.margin = '.75rem 0';
        banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${msg || 'Selecione uma instância para configurar o chatbot.'}`;
        document.querySelector('.section-title')?.after(banner);
      } else {
        banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${msg || 'Selecione uma instância para configurar o chatbot.'}`;
      }
    } else if (banner) {
      banner.remove();
    }
  }

  const swAutoHdr   = document.getElementById('swAutoHdr');
  const pillAutoHdr = document.getElementById('pillAutoHdr');
  const swDeptHdr   = document.getElementById('swDeptHdr');
  const pillDeptHdr = document.getElementById('pillDeptHdr');

  const headAuto = document.querySelector('[data-toggle="auto"]');
  const bodyAuto = document.getElementById('body-auto');

  const swWelcome = document.getElementById('swWelcome');
  const pillWelcome = document.getElementById('pillWelcome');
  const msgWelcome = document.getElementById('msgWelcome');
  const wcCount = document.getElementById('wcCount');
  const wStart = document.getElementById('wStart');
  const wEnd   = document.getElementById('wEnd');

  const swOff = document.getElementById('swOff');
  const pillOff = document.getElementById('pillOff');
  const msgOff = document.getElementById('msgOff');
  const offCount = document.getElementById('offCount');
  const oStart = document.getElementById('oStart');
  const oEnd   = document.getElementById('oEnd');

  const prevW = document.getElementById('prevW');
  const prevWText = document.getElementById('prevWText');
  const prevO = document.getElementById('prevO');

  const saveAuto = document.getElementById('saveAuto');
  const cancelAuto = document.getElementById('cancelAuto');

  const headAutoDept = document.querySelector('[data-toggle="auto-dept"]');
  const bodyAutoDept = document.getElementById('body-auto-dept');
  const saveDept = document.getElementById('saveDept');
  const cancelDept = document.getElementById('cancelDept');
  const saveGlobal = document.getElementById('saveGlobal');
  const previewEmptyText = document.getElementById('previewEmptyText');

  const swDeptWelcome   = document.getElementById('swDeptWelcome');
  const pillDeptWelcome = document.getElementById('pillDeptWelcome');
  const msgDeptWelcome  = document.getElementById('msgDeptWelcome');
  const dwCount         = document.getElementById('dwCount');
  const dwStart         = document.getElementById('dwStart');
  const dwEnd           = document.getElementById('dwEnd');

  const deptSearch = document.getElementById('deptSearch');
  const deptAll    = document.getElementById('deptAll');
  const deptNone   = document.getElementById('deptNone');
  const deptList   = document.getElementById('deptList');
  const deptCount  = document.getElementById('deptCount');

  const schedWelcome = document.getElementById('schedWelcome');
  const schedOff     = document.getElementById('schedOff');
  const schedDeptWelcomeEl = document.getElementById('schedDeptWelcome');

  const prevDept = document.getElementById('prevDept');
  const prevDeptText = document.getElementById('prevDeptText');

  const autoModeNotice = document.getElementById('autoModeNotice');
  const deptModeNotice = document.getElementById('deptModeNotice');

  let cfg = null;
  let _lastLoadedSnapshot = null;
  let _filaCache = null;
  let _filaDraftItems = null;
  let _empresaNome = (LS.getItem('empresa_nome') || '').trim() || null;

  let __persisting = false;
  let __persistTimer = null;
  let __filaSafetyQueue = Promise.resolve();
  let __filaSafetyPending = 0;

  const LOCAL_DEFAULTS = {
    timezone: FALLBACK_TZ,
    features: {
      auto_messages: {
        enabled: false,
        welcome: {
          enabled: false,
          text: buildAutoWelcomeTemplate(),
          start: '08:00',
          end: '18:00'
        },
        off_hours: {
          enabled: false,
          text: 'Atendemos de 08:00 às 18:00. Deixe sua mensagem e responderemos no próximo expediente.',
          start: '18:00',
          end: '08:00'
        }
      },
      auto_messages_departments: {
        enabled: false,
        welcome: {
          enabled: false,
          text: '',
          start: '08:00',
          end: '18:00'
        },
        items: {}
      }
    }
  };

  function buildAutoWelcomeTemplate() {
    return (
`Olá! 👋 Você fala com {empresa}.

Como podemos te ajudar hoje?`
    );
  }

  function buildFilaTriagemTemplate() {
    return (
`Olá! 👋
Bem-vindo(a) à {empresa}.

Para direcionar seu atendimento, escolha uma opção abaixo:

{menu_departamentos}

Digite apenas o número da opção desejada.`
    );
  }

  function cleanLabel(value) {
    return String(value || '')
      .trim()
      .replace(/^\s*\d+\s*[-–—.)]\s*/, '')
      .trim();
  }

  function setSwitch(node, on, pillEl) {
    if (!node) return;
    node.dataset.on = on ? 'true' : 'false';

    const input = node.querySelector('input');
    if (input) input.checked = !!on;

    if (pillEl) {
      pillEl.textContent = on ? 'on' : 'off';
      pillEl.classList.toggle('on', !!on);
      pillEl.classList.toggle('off', !on);
    }
  }

  function getSwitch(node) {
    return !!node?.querySelector('input')?.checked;
  }

  function setHeaderSwitch(node, pill, on) {
    setSwitch(node, on, pill);
    node?.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function deepMerge(base, extra) {
    if (!extra || typeof extra !== 'object') return base;

    const out = Array.isArray(base) ? base.slice() : { ...base };

    for (const k of Object.keys(extra)) {
      const v = extra[k];
      out[k] = (v && typeof v === 'object' && !Array.isArray(v))
        ? deepMerge(out[k] || {}, v)
        : v;
    }

    return out;
  }

  function ensureMasters(c) {
    c.features ??= {};

    // Compatibilidade com configs antigas salvas como auto_messages_filas.
    if (!c.features.auto_messages_departments && c.features.auto_messages_filas) {
      c.features.auto_messages_departments = c.features.auto_messages_filas;
    }
    delete c.features.auto_messages_filas;

    c.features.auto_messages ??= {};
    if (typeof c.features.auto_messages.enabled !== 'boolean') {
      c.features.auto_messages.enabled = false;
    }

    c.features.auto_messages.welcome ??= {
      enabled: false,
      text: buildAutoWelcomeTemplate(),
      start: '08:00',
      end: '18:00'
    };

    c.features.auto_messages.off_hours ??= {
      enabled: false,
      text: 'Atendemos de 08:00 às 18:00. Deixe sua mensagem e responderemos no próximo expediente.',
      start: '18:00',
      end: '08:00'
    };

    c.features.auto_messages_departments ??= {
      enabled: false,
      welcome: {
        enabled: false,
        text: '',
        start: '08:00',
        end: '18:00'
      },
      items: {}
    };

    c.features.auto_messages_departments.welcome ??= {
      enabled: false,
      text: '',
      start: '08:00',
      end: '18:00'
    };

    if (!c.features.auto_messages_departments.items || typeof c.features.auto_messages_departments.items !== 'object' || Array.isArray(c.features.auto_messages_departments.items)) {
      c.features.auto_messages_departments.items = {};
    }

    c.timezone = (c.timezone || '').trim() || FALLBACK_TZ;
  }

  function filaFeature() {
    ensureMasters(cfg);
    return cfg.features.auto_messages_departments;
  }

  function ensureFilaItems() {
    const f = filaFeature();

    if (!f.items || typeof f.items !== 'object' || Array.isArray(f.items)) {
      f.items = {};
    }

    return f.items;
  }

  function cloneFilaItems(items) {
    try {
      return JSON.parse(JSON.stringify(items || {}));
    } catch {
      return {};
    }
  }

  function resetFilaDraftItems() {
    _filaDraftItems = cloneFilaItems(ensureFilaItems());
    return _filaDraftItems;
  }

  function ensureFilaDraftItems() {
    if (!_filaDraftItems || typeof _filaDraftItems !== 'object' || Array.isArray(_filaDraftItems)) {
      return resetFilaDraftItems();
    }

    return _filaDraftItems;
  }

  function commitFilaDraftItems() {
    const f = filaFeature();
    f.items = cloneFilaItems(ensureFilaDraftItems());
    return f.items;
  }

  function normalizePersistedFilaItems(config) {
    ensureMasters(config);

    const feature = config.features.auto_messages_departments;
    const items = (feature.items && typeof feature.items === 'object' && !Array.isArray(feature.items))
      ? feature.items
      : {};

    const legacyAllEnabled = Object.keys(items).length === 0;

    (_filaCache || []).forEach(dep => {
      const id = String(dep.id);
      const nome = cleanLabel(dep.nome);

      if (!items[id] || typeof items[id] !== 'object' || Array.isArray(items[id])) {
        items[id] = { enabled: legacyAllEnabled, label: nome };
        return;
      }

      items[id] = {
        ...items[id],
        enabled: !!items[id].enabled,
        label: String(items[id].label || nome)
      };
    });

    feature.items = items;
    return items;
  }

  function persistedFilaEnabled(id) {
    if (!cfg) return false;

    const items = ensureFilaItems();
    const keys = Object.keys(items);

    // Configuração antiga sem "items" significava todos os departamentos ativos.
    if (!keys.length) return true;

    return !!items[String(id)]?.enabled;
  }

  async function persistFilaDisableNow(ids) {
    if (!cfg) return false;

    while (__persisting) {
      await new Promise(resolve => setTimeout(resolve, 60));
    }

    const uniqueIds = [...new Set((ids || []).map(String).filter(Boolean))];
    if (!uniqueIds.length) return true;

    const payload = structuredClone(cfg);
    const feature = payload.features.auto_messages_departments;
    const items = normalizePersistedFilaItems(payload);

    uniqueIds.forEach(id => {
      const dep = (_filaCache || []).find(item => String(item.id) === id);
      const nome = cleanLabel(dep?.nome || items[id]?.label || '');

      items[id] = {
        ...(items[id] || {}),
        enabled: false,
        label: String(items[id]?.label || nome)
      };
    });

    const hasEnabledDepartment = Object.values(items).some(item => !!item?.enabled);

    // Sem nenhum departamento ativo, desliga o modo inteiro para garantir
    // que nenhuma mensagem de menu seja enviada ao cliente.
    if (!hasEnabledDepartment) {
      feature.enabled = false;
      (feature.welcome ||= {}).enabled = false;
    }

    __persisting = true;
    updateSaveButtons();

    try {
      await putConfig(payload);

      cfg = payload;
      _lastLoadedSnapshot = JSON.stringify(cfg);

      if (!hasEnabledDepartment) {
        setHeaderSwitch(swDeptHdr, pillDeptHdr, false);
        setSwitch(swDeptWelcome, false, pillDeptWelcome);
        syncSectionState();
        toast('Menu de departamentos desativado imediatamente.');
      } else {
        toast(uniqueIds.length === 1
          ? 'Departamento removido do menu imediatamente.'
          : 'Departamentos removidos do menu imediatamente.');
      }

      renderFilaPicker();
      renderFilaPreview();
      scheduleSummaryRefresh();
      return true;
    } catch (_) {
      // Se a gravação falhar, volta o checkbox ao estado realmente salvo.
      const draft = ensureFilaDraftItems();
      uniqueIds.forEach(id => {
        if (!draft[id]) draft[id] = {};
        draft[id].enabled = persistedFilaEnabled(id);
      });

      renderFilaPicker();
      renderFilaPreview();
      return false;
    } finally {
      __persisting = false;
      updateSaveButtons();
    }
  }

  function queueImmediateFilaDisable(ids) {
    const uniqueIds = [...new Set((ids || []).map(String).filter(Boolean))];
    if (!uniqueIds.length) return Promise.resolve(true);

    __filaSafetyPending += 1;
    updateSaveButtons();

    const task = __filaSafetyQueue
      .catch(() => false)
      .then(() => persistFilaDisableNow(uniqueIds));

    __filaSafetyQueue = task.finally(() => {
      __filaSafetyPending = Math.max(0, __filaSafetyPending - 1);
      updateSaveButtons();
    });

    return task;
  }

  async function persistDepartmentModeOffNow({ showToast = true } = {}) {
    if (!cfg) return false;

    clearTimeout(__persistTimer);

    while (__persisting || __filaSafetyPending > 0) {
      await new Promise(resolve => setTimeout(resolve, 60));
    }

    // A chave continua visualmente ligada durante a gravação. Ela só aparece
    // desligada depois que o backend confirmar, evitando uma falsa sensação
    // de segurança enquanto a configuração antiga ainda estiver ativa.
    syncCfgFromUI();

    const payload = structuredClone(cfg);
    ensureMasters(payload);

    const feature = payload.features.auto_messages_departments;
    feature.enabled = false;
    (feature.welcome ||= {}).enabled = false;

    const input = swDeptHdr?.querySelector('input');
    swDeptHdr?.classList.add('disabled');
    if (input) input.disabled = true;

    __persisting = true;
    updateSaveButtons();

    try {
      await putConfig(payload);

      cfg = payload;
      _lastLoadedSnapshot = JSON.stringify(cfg);

      setHeaderSwitch(swDeptHdr, pillDeptHdr, false);
      setSwitch(swDeptWelcome, false, pillDeptWelcome);
      setAccordionOpen(headAutoDept, bodyAutoDept, false);
      syncSectionState();

      if (showToast) toast('Menu de departamentos desligado. Nenhuma mensagem desse menu será enviada.');
      return true;
    } catch (_) {
      // Em caso de falha, a chave permanece ligada, refletindo o estado real
      // que ainda está salvo no servidor.
      return false;
    } finally {
      __persisting = false;
      swDeptHdr?.classList.remove('disabled');
      if (input) input.disabled = false;
      updateSaveButtons();
    }
  }

  function insertAtCaret(ta, text) {
    if (!ta) return;

    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? ta.value.length;

    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);

    const pos = s + text.length;
    ta.focus();

    try {
      ta.setSelectionRange(pos, pos);
    } catch {}

    if (ta === msgWelcome && wcCount) wcCount.textContent = `${ta.value.length} caracteres`;
    if (ta === msgOff && offCount) offCount.textContent = `${ta.value.length} caracteres`;
    if (ta === msgDeptWelcome && dwCount) dwCount.textContent = `${ta.value.length} caracteres`;

    if (ta === msgWelcome) renderWelcomePreview();
    if (ta === msgOff) renderOffPreview();
    if (ta === msgDeptWelcome) renderFilaPreview();

    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function variableOptionsFor(targetId) {
    const common = [
      {
        label: 'Nome da empresa',
        value: '{empresa}',
        hint: 'O sistema coloca o nome da empresa sozinho.'
      },
      {
        label: 'Saudação pronta',
        value: 'Olá! 👋\n',
        hint: 'Coloca um começo simples para a mensagem.'
      }
    ];

    if (targetId === 'msgDeptWelcome') {
      return [
        ...common,
        {
          label: 'Lista de departamentos/opções',
          value: '{menu_departamentos}',
          hint: 'Mostra as opções para o cliente escolher, tipo Vendas, Suporte e Financeiro.'
        },
        {
          label: 'Instrução para escolher',
          value: 'Digite apenas o número da opção desejada.',
          hint: 'Explica para o cliente o que ele deve fazer.'
        }
      ];
    }

    return common;
  }

  function closeVariablePopover() {
    const old = document.getElementById('zcVariablePopover');
    if (old) old.remove();
    document.removeEventListener('keydown', closeVariablePopover._esc);
    document.removeEventListener('click', closeVariablePopover._doc, true);
  }

  function activateEditorForVariable(targetId) {
    if (targetId === 'msgWelcome') {
      setHeaderSwitch(swAutoHdr, pillAutoHdr, true);
      setSwitch(swWelcome, true, pillWelcome);
    }

    if (targetId === 'msgOff') {
      setHeaderSwitch(swAutoHdr, pillAutoHdr, true);
      setSwitch(swOff, true, pillOff);
    }

    if (targetId === 'msgDeptWelcome') {
      setHeaderSwitch(swDeptHdr, pillDeptHdr, true);
      setSwitch(swDeptWelcome, true, pillDeptWelcome);
    }

    syncSectionState();
  }

  function openVariablePopover(btn, textarea) {
    if (!btn || !textarea) return;

    closeVariablePopover();

    const targetId = btn.dataset.target || textarea.id || '';
    const items = variableOptionsFor(targetId);

    const pop = document.createElement('div');
    pop.id = 'zcVariablePopover';
    pop.className = 'variable-popover';
    pop.setAttribute('role', 'menu');
    pop.innerHTML = `
      <div class="variable-popover-title"><strong>Adicionar informação automática</strong><small>Escolha o que o sistema coloca sozinho na mensagem.</small></div>
      <div class="variable-popover-list"></div>
    `;

    const list = pop.querySelector('.variable-popover-list');

    items.forEach(item => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'variable-option';
      opt.setAttribute('role', 'menuitem');
      opt.innerHTML = `
        <span>
          <strong>${escapeHtml(item.label)}</strong>
          <small>${escapeHtml(item.hint || item.value)}</small>
        </span>
        <code>${escapeHtml(item.value)}</code>
      `;

      opt.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activateEditorForVariable(targetId);
        insertAtCaret(textarea, item.value);
        updateSaveButtons();
        schedulePersist(250, { silent: true });
        scheduleSummaryRefresh();
        closeVariablePopover();
      });

      list.appendChild(opt);
    });

    document.body.appendChild(pop);

    const r = btn.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const top = Math.min(window.innerHeight - pr.height - 12, r.bottom + 8);
    const left = Math.max(12, Math.min(window.innerWidth - pr.width - 12, r.right - pr.width));

    pop.style.top = `${Math.max(12, top)}px`;
    pop.style.left = `${left}px`;

    closeVariablePopover._esc = (e) => {
      if (e.key === 'Escape') closeVariablePopover();
    };
    closeVariablePopover._doc = (e) => {
      if (!pop.contains(e.target) && !btn.contains(e.target)) closeVariablePopover();
    };

    setTimeout(() => {
      document.addEventListener('keydown', closeVariablePopover._esc);
      document.addEventListener('click', closeVariablePopover._doc, true);
    }, 0);
  }

  function handleVariableButtonClick(e, btn) {
    if (!btn) return;

    e?.preventDefault?.();
    e?.stopPropagation?.();

    const targetId = btn.dataset.target || '';
    const textarea = targetId ? document.getElementById(targetId) : null;

    if (!textarea) {
      toast('Campo de mensagem não encontrado.', 'warn');
      return;
    }

    /*
      Importante: em algumas versões o clique não chegava no botão porque
      outros listeners do card/accordion interceptavam o evento. Por isso
      o clique agora também é tratado por delegação em capture.
    */
    activateEditorForVariable(targetId);
    openVariablePopover(btn, textarea);
  }

  function bindVariableButtons() {
    if (document.documentElement.dataset.zcVariableDelegated !== '1') {
      document.documentElement.dataset.zcVariableDelegated = '1';

      document.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('.insert-variable');
        if (!btn) return;
        handleVariableButtonClick(e, btn);
      }, true);
    }

    $$('.insert-variable').forEach(btn => {
      if (btn.dataset.boundVariable === '1') return;
      btn.dataset.boundVariable = '1';

      btn.addEventListener('click', (e) => handleVariableButtonClick(e, btn));
    });
  }

  function timeValid(v) {
    if (typeof v !== 'string' || !/^\d{2}:\d{2}$/.test(v)) return false;
    const [h, m] = v.split(':').map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  }

  function markInvalid(node, on = true) {
    if (!node) return;
    node.setAttribute('aria-invalid', on ? 'true' : 'false');
    node.style.outline = on ? '2px solid #ef4444' : '';
    node.style.outlineOffset = on ? '2px' : '';
  }

  const DAY = 24 * 60;
  const pad2 = n => String(n).padStart(2, '0');
  const m2hhmm = m => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;

  function hhmmToMin(s) {
    if (!timeValid(s)) return NaN;
    const [h, m] = s.split(':').map(Number);
    return (h * 60 + m) % DAY;
  }

  function segs(a, b) {
    return a === b ? [] : (a < b ? [[a, b]] : [[a, DAY], [0, b]]);
  }

  function overlap(a1, a2, b1, b2) {
    for (const [x, y] of segs(a1, a2)) {
      for (const [u, v] of segs(b1, b2)) {
        if (Math.min(y, v) > Math.max(x, u)) {
          return [Math.max(x, u), Math.min(y, v)];
        }
      }
    }

    return null;
  }

  function isComplement(wS, wE, oS, oE) {
    return oS === wE && oE === wS;
  }

  function getSelectedFilas() {
    if (!cfg) return [];

    const items = ensureFilaDraftItems();

    const selectedIds = new Set(
      Object.entries(items)
        .filter(([, it]) => !!it?.enabled)
        .map(([id]) => String(id))
    );

    return (_filaCache || [])
      .filter(f => selectedIds.has(String(f.id)))
      .map(f => ({
        id: String(f.id),
        nome: cleanLabel(f.nome),
        departamento_id: f.departamento_id || null,
        prioridade: f.prioridade || 'normal'
      }))
      .filter(f => f.nome);
  }

  function buildMenuFilasText() {
    const selected = getSelectedFilas();

    if (!selected.length) {
      return 'Nenhum departamento selecionado';
    }

    return selected
      .map((f, i) => `${i + 1} - ${cleanLabel(f.nome)}`)
      .join('\n');
  }

  function renderFilaTemplate(text) {
    const empresa = _empresaNome || EMPRESA_NOME() || '[Empresa]';
    const menu = buildMenuFilasText();

    return String(text || '')
      .replace(/\{empresa\}/gi, empresa)
      .replace(/\{menu_filas\}/gi, menu)
      .replace(/\{menu_departamentos\}/gi, menu);
  }

  function expandTemplate(text) {
    let out = String(text || '');

    if (_empresaNome && _empresaNome !== '[Empresa]') {
      out = out.replace(/\{empresa\}|\[empresa\]|\[Empresa\]/gi, _empresaNome);
    }

    return out;
  }

  function attachFilaSuggestions(textarea) {
    const wrap = document.getElementById('deptChips');
    if (!wrap || !textarea) return;

    wrap.innerHTML = '';

    const chips = [
      { label: 'Empresa', insert: '{empresa}' },
      { label: 'Lista de departamentos', insert: '{menu_departamentos}' },
      { label: 'Saudação pronta', insert: 'Olá! 👋\nBem-vindo(a) à {empresa}.\n\n' },
      { label: 'Texto do menu', insert: 'Para direcionar seu atendimento, escolha uma opção abaixo:\n\n{menu_departamentos}\n\n' },
      { label: 'Instrução final', insert: 'Digite apenas o número da opção desejada.' },
    ];

    chips.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = c.label;
      b.addEventListener('click', () => insertAtCaret(textarea, c.insert));
      wrap.appendChild(b);
    });
  }

  function seedFilaItemsDefault() {
    if (!cfg) return;
    if (!Array.isArray(_filaCache) || !_filaCache.length) return;

    const items = ensureFilaDraftItems();

    _filaCache.forEach(f => {
      const id = String(f.id);
      const nome = cleanLabel(f.nome);

      if (!items[id]) {
        items[id] = { enabled: false, label: nome };
      } else {
        items[id].enabled = !!items[id].enabled;
        if (!String(items[id].label || '').trim()) {
          items[id].label = nome;
        }
      }
    });
  }

  function countSelectedFilas() {
    if (!cfg) return 0;
    const items = ensureFilaDraftItems();

    return Object.values(items).reduce((acc, it) => acc + (it?.enabled ? 1 : 0), 0);
  }

  function setFilaPickerEnabled(enabled) {
    if (deptSearch) deptSearch.disabled = !enabled;
    if (deptAll) deptAll.disabled = !enabled;
    if (deptNone) deptNone.disabled = !enabled;

    if (deptList) {
      deptList.classList.toggle('disabled', !enabled);
      deptList.querySelectorAll('input[type="checkbox"]').forEach(ch => {
        ch.disabled = !enabled;
      });
    }
  }

  function refreshFilaTemplateIfDefaultLike() {
    const current = (msgDeptWelcome?.value || '').trim();

    const isDefaultLike =
      !current ||
      current.includes('{menu_departamentos}') ||
      current.includes('{menu_departamentos}') ||
      current.includes('Digite apenas o número da opção desejada.') ||
      current.includes('Você está falando com o departamento');

    if (msgDeptWelcome && isDefaultLike) {
      msgDeptWelcome.value = buildFilaTriagemTemplate();
      if (dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
    }
  }

  function syncPreviewEmpty() {
    if (!previewEmptyText) return;
    const welcomeVisible = !!(prevW && prevW.style.display !== 'none');
    const offVisible = !!(prevO && prevO.style.display !== 'none');
    const filaVisible = !!(prevDept && prevDept.style.display !== 'none');
    previewEmptyText.classList.toggle('is-hidden', welcomeVisible || offVisible || filaVisible);
  }

  function renderFilaPreview() {
    if (!prevDept || !prevDeptText) return;

    const on = getSwitch(swDeptWelcome) && getSwitch(swDeptHdr);
    prevDept.style.display = on ? '' : 'none';
    prevDeptText.textContent = renderFilaTemplate(msgDeptWelcome?.value || '');
    syncPreviewEmpty();
  }

  function renderFilaPicker() {
    if (!deptList) return;

    if (!cfg) {
      deptList.innerHTML = '';
      return;
    }

    const items = ensureFilaDraftItems();
    const q = String(deptSearch?.value || '').trim().toLowerCase();

    deptList.innerHTML = '';

    if (!Array.isArray(_filaCache) || !_filaCache.length) {
      const empty = document.createElement('div');
      empty.className = 'dept-empty';
      empty.innerHTML = 'Nenhum departamento encontrado. Cadastre departamentos em <strong>Departamentos</strong> para usar este modo.';
      deptList.appendChild(empty);

      if (deptCount) deptCount.textContent = '0 selecionadas';

      setFilaPickerEnabled(false);
      return;
    }

    const list = _filaCache
      .map(f => ({
        id: String(f.id),
        nome: cleanLabel(f.nome),
        prioridade: f.prioridade || 'normal',
        departamento_nome: f.departamento_nome || ''
      }))
      .filter(f => f.nome)
      .filter(f => !q || f.nome.toLowerCase().includes(q) || String(f.departamento_nome || '').toLowerCase().includes(q));

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'dept-empty';
      empty.textContent = 'Nada encontrado.';
      deptList.appendChild(empty);

      if (deptCount) deptCount.textContent = `${countSelectedFilas()} selecionadas`;
      return;
    }

    const enabledHdr = getSwitch(swDeptHdr);

    list.forEach(f => {
      if (!items[f.id]) {
        items[f.id] = { enabled: false, label: f.nome };
      }

      const row = document.createElement('label');
      row.className = 'dept-row';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!items[f.id]?.enabled;
      chk.disabled = !enabledHdr;

      chk.addEventListener('change', () => {
        items[f.id] = {
          ...(items[f.id] || {}),
          enabled: !!chk.checked,
          label: items[f.id]?.label || f.nome
        };

        if (deptCount) deptCount.textContent = `${countSelectedFilas()} selecionadas`;

        refreshFilaTemplateIfDefaultLike();
        renderFilaPreview();
        updateSaveButtons();
        scheduleSummaryRefresh();

        // Desmarcar é uma ação de segurança: grava imediatamente no backend.
        // Marcar continua aguardando o clique em "Salvar".
        if (!chk.checked) {
          queueImmediateFilaDisable([f.id]);
        }
      });

      const nameWrap = document.createElement('span');
      nameWrap.className = 'dept-copy';

      const name = document.createElement('span');
      name.className = 'dept-name';
      name.textContent = f.nome;

      const meta = document.createElement('small');
      meta.className = 'dept-meta';
      const prioridade = cleanLabel(f.prioridade || 'normal');
      meta.textContent = prioridade
        ? `Prioridade ${prioridade.charAt(0).toUpperCase()}${prioridade.slice(1)}`
        : '';

      nameWrap.appendChild(name);
      if (meta.textContent) nameWrap.appendChild(meta);

      row.appendChild(chk);
      row.appendChild(nameWrap);
      deptList.appendChild(row);
    });

    if (deptCount) deptCount.textContent = `${countSelectedFilas()} selecionadas`;

    setFilaPickerEnabled(enabledHdr);
  }

  function setAccordionOpen(head, body, open) {
    head?.setAttribute('aria-expanded', open ? 'true' : 'false');

    if (body) {
      body.style.height = open ? 'auto' : '0px';
      body.style.opacity = open ? '1' : '0';
      body.style.pointerEvents = open ? 'auto' : 'none';
      body.setAttribute('aria-hidden', open ? 'false' : 'true');
    }

    head?.closest('.item')?.classList.toggle('open', !!open);
  }

  function bindAccordion(head, body) {
    head?.addEventListener('click', (e) => {
      if (e.target.closest('.tswitch')) return;

      const open = head.getAttribute('aria-expanded') === 'true';
      setAccordionOpen(head, body, !open);
    });
  }

  function syncHiddenChildToggles() {
    const autoOn = getSwitch(swAutoHdr);
    const filaOn = getSwitch(swDeptHdr);

    /*
      A tela ficou mais simples para usuário leigo: existe só o toggle do modo.
      Estes switches internos continuam no DOM apenas para compatibilidade com o backend antigo,
      mas são sincronizados automaticamente e não aparecem na interface.
    */
    setSwitch(swWelcome, autoOn, pillWelcome);
    setSwitch(swOff, autoOn, pillOff);
    setSwitch(swDeptWelcome, filaOn, pillDeptWelcome);
  }

  function updateScheduleVisibility() {
    const onA = getSwitch(swAutoHdr);
    const wOn = onA && getSwitch(swWelcome);
    const oOn = onA && getSwitch(swOff);

    schedWelcome?.classList.toggle('show', wOn);
    schedOff?.classList.toggle('show', oOn);

    const onF = getSwitch(swDeptHdr);
    const fOn = onF && getSwitch(swDeptWelcome);

    schedDeptWelcomeEl?.classList.toggle('show', fOn);
  }

  function updateModeNotices() {
    const autoOn = !!cfg?.features?.auto_messages?.enabled;
    const filaOn = !!cfg?.features?.auto_messages_departments?.enabled;

    if (autoModeNotice) autoModeNotice.hidden = !filaOn;
    if (deptModeNotice) deptModeNotice.hidden = !autoOn;
  }

  function setAutoChildrenEnabled(enabled) {
    swWelcome?.classList.toggle('disabled', !enabled);
    if (swWelcome?.querySelector('input')) swWelcome.querySelector('input').disabled = !enabled;
    if (msgWelcome) msgWelcome.disabled = !enabled || !getSwitch(swWelcome);
    if (wStart) wStart.disabled = !enabled;
    if (wEnd) wEnd.disabled = !enabled;

    swOff?.classList.toggle('disabled', !enabled);
    if (swOff?.querySelector('input')) swOff.querySelector('input').disabled = !enabled;
    if (msgOff) msgOff.disabled = !enabled || !getSwitch(swOff);
    if (oStart) oStart.disabled = !enabled;
    if (oEnd) oEnd.disabled = !enabled;

    updateScheduleVisibility();
  }

  function setFilaChildrenEnabled(enabled) {
    swDeptWelcome?.classList.toggle('disabled', !enabled);
    if (swDeptWelcome?.querySelector('input')) swDeptWelcome.querySelector('input').disabled = !enabled;
    if (msgDeptWelcome) msgDeptWelcome.disabled = !enabled || !getSwitch(swDeptWelcome);
    if (dwStart) dwStart.disabled = !enabled;
    if (dwEnd) dwEnd.disabled = !enabled;

    updateScheduleVisibility();
    setFilaPickerEnabled(!!enabled);
    renderFilaPreview();
  }

  function syncSectionState() {
    if (!cfg?.features) return;

    ensureMasters(cfg);
    syncHiddenChildToggles();

    cfg.features.auto_messages.enabled = !!getSwitch(swAutoHdr);
    cfg.features.auto_messages_departments.enabled = !!getSwitch(swDeptHdr);

    (cfg.features.auto_messages.welcome ||= {}).enabled = !!getSwitch(swWelcome);
    (cfg.features.auto_messages.off_hours ||= {}).enabled = !!getSwitch(swOff);
    (cfg.features.auto_messages_departments.welcome ||= {}).enabled = !!getSwitch(swDeptWelcome);

    setAutoChildrenEnabled(!!cfg.features.auto_messages.enabled);
    setFilaChildrenEnabled(!!cfg.features.auto_messages_departments.enabled);

    renderWelcomePreview();
    renderOffPreview();
    renderFilaPreview();
    renderFilaPicker();

    if (getSwitch(swAutoHdr)) setAccordionOpen(headAuto, bodyAuto, true);
    if (getSwitch(swDeptHdr)) setAccordionOpen(headAutoDept, bodyAutoDept, true);

    updateSaveButtons();
    updateScheduleVisibility();
    updateModeNotices();
    updateSummary();
    updateSimulatorBadge();
  }

  function renderWelcomePreview() {
    const on = getSwitch(swWelcome) && getSwitch(swAutoHdr);

    if (prevW) prevW.style.display = on ? '' : 'none';
    if (prevWText) prevWText.textContent = (msgWelcome?.value || '—').trim() || '—';
    syncPreviewEmpty();
  }

  function renderOffPreview() {
    // Preview lateral mostra a primeira resposta para não poluir.
    // A mensagem fora do horário continua salva e usada pelo backend, mas não aparece junto da boas-vindas.
    const on = getSwitch(swOff) && getSwitch(swAutoHdr) && !getSwitch(swWelcome);

    if (prevO) prevO.style.display = on ? '' : 'none';
    if (prevO) prevO.textContent = (msgOff?.value || '—').trim() || '—';
    syncPreviewEmpty();
  }

  function syncCfgFromUI() {
    if (!cfg?.features) return;

    ensureMasters(cfg);
    syncHiddenChildToggles();

    cfg.timezone = (cfg.timezone || '').trim() || FALLBACK_TZ;

    cfg.features.auto_messages.enabled = !!getSwitch(swAutoHdr);

    cfg.features.auto_messages.welcome = {
      ...(cfg.features.auto_messages.welcome || {}),
      enabled: !!(getSwitch(swAutoHdr) && getSwitch(swWelcome)),
      text: (msgWelcome?.value || '').trim(),
      start: (wStart?.value || '08:00'),
      end: (wEnd?.value || '18:00'),
    };

    cfg.features.auto_messages.off_hours = {
      ...(cfg.features.auto_messages.off_hours || {}),
      enabled: !!(getSwitch(swAutoHdr) && getSwitch(swOff)),
      text: (msgOff?.value || '').trim(),
      start: (oStart?.value || '18:00'),
      end: (oEnd?.value || '08:00'),
    };

    cfg.features.auto_messages_departments.enabled = !!getSwitch(swDeptHdr);

    cfg.features.auto_messages_departments.welcome = {
      ...(cfg.features.auto_messages_departments.welcome || {}),
      enabled: !!(getSwitch(swDeptHdr) && getSwitch(swDeptWelcome)),
      text: (msgDeptWelcome?.value || '').trim(),
      start: (dwStart?.value || '08:00'),
      end: (dwEnd?.value || '18:00'),
    };

    ensureFilaItems();
  }

  async function persistUI({ silent = true } = {}) {
    if (!cfg || __persisting) return false;

    syncCfgFromUI();

    const autoOn = getSwitch(swAutoHdr);
    const filaOn = getSwitch(swDeptHdr);

    if (autoOn && !validateBeforeSave('auto')) return false;
    if (filaOn && !validateBeforeSave('dept')) return false;

    __persisting = true;
    updateSaveButtons();

    try {
      await putConfig(cfg);
      _lastLoadedSnapshot = JSON.stringify(cfg);
      if (!silent) {
        toast('Configurações salvas com sucesso.');
        showRobotCelebration();
      }
      return true;
    } catch (_) {
      // putConfig já mostra notify
      return false;
    } finally {
      __persisting = false;
      updateSaveButtons();
    }
  }

  function schedulePersist(delay = 500, opts = { silent: true }) {
    clearTimeout(__persistTimer);
    __persistTimer = setTimeout(() => {
      persistUI(opts);
    }, delay);
  }

  function getConfirmMessage(labelEl) {
    if (labelEl === swAutoHdr) return 'Tem certeza que deseja desligar as mensagens automáticas?';
    if (labelEl === swDeptHdr) return 'Tem certeza que deseja desligar o menu de departamentos?';
    if (labelEl === swWelcome) return 'Tem certeza que deseja desligar a mensagem de boas-vindas?';
    if (labelEl === swOff) return 'Tem certeza que deseja desligar a mensagem de fora do horário?';
    if (labelEl === swDeptWelcome) return 'Tem certeza que deseja desligar a mensagem inicial do menu?';
    return 'Tem certeza que deseja desligar esta opção?';
  }

  function shouldConfirmOff(labelEl, wasOn, newVal) {
    if (!wasOn || newVal) return false;

    return (
      labelEl === swAutoHdr ||
      labelEl === swDeptHdr ||
      labelEl === swWelcome ||
      labelEl === swOff ||
      labelEl === swDeptWelcome
    );
  }

  function bindSwitch(labelEl, pillEl, onToggle) {
    if (!labelEl) return;

    const input = labelEl.querySelector('input');

    labelEl.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const wasOn = !!input?.checked;
      const newVal = !wasOn;

      if (shouldConfirmOff(labelEl, wasOn, newVal)) {
        const ok = await confirmAction({
          title: 'Confirmar desligamento',
          message: getConfirmMessage(labelEl),
          confirmText: 'Sim, desligar',
          cancelText: 'Cancelar',
          kind: 'warn'
        });

        if (!ok) return;
      }

      if (labelEl === swAutoHdr && newVal && getSwitch(swDeptHdr)) {
        const ok = await confirmAction({
          title: 'Ativar mensagens automáticas?',
          message: 'O menu de departamentos será desligado, porque só um modo pode ficar ativo por vez.',
          confirmText: 'Ativar e desligar menu',
          cancelText: 'Cancelar',
          kind: 'warn'
        });

        if (!ok) return;

        const disabled = await persistDepartmentModeOffNow({ showToast: false });
        if (!disabled) return;
      }

      if (labelEl === swDeptHdr && newVal && getSwitch(swAutoHdr)) {
        const ok = await confirmAction({
          title: 'Ativar menu de departamentos?',
          message: 'As mensagens automáticas serão desligadas, porque os dois modos não podem ficar ativos ao mesmo tempo.',
          confirmText: 'Ativar menu e desligar automático',
          cancelText: 'Cancelar',
          kind: 'warn'
        });

        if (!ok) return;

        setHeaderSwitch(swAutoHdr, pillAutoHdr, false);
        setSwitch(swWelcome, false, pillWelcome);
        setSwitch(swOff, false, pillOff);

        cfg.features.auto_messages.enabled = false;
        (cfg.features.auto_messages.welcome ||= {}).enabled = false;
        (cfg.features.auto_messages.off_hours ||= {}).enabled = false;
      }

      if (labelEl === swWelcome && newVal && getSwitch(swDeptHdr)) {
        notify({
          title: 'Modo incompatível',
          message: 'Desligue primeiro o menu de departamentos para ativar a resposta automática.',
          kind: 'warn'
        });
        return;
      }

      if (labelEl === swOff && newVal && getSwitch(swDeptHdr)) {
        notify({
          title: 'Modo incompatível',
          message: 'Desligue primeiro o menu de departamentos para ativar a resposta automática.',
          kind: 'warn'
        });
        return;
      }

      if (labelEl === swDeptWelcome && newVal && getSwitch(swAutoHdr)) {
        notify({
          title: 'Modo incompatível',
          message: 'Desligue primeiro a resposta automática para ativar o menu de departamentos.',
          kind: 'warn'
        });
        return;
      }

      // O botão principal do menu é uma trava geral. Ao desligar, grava primeiro
      // no servidor e só depois mostra a chave desligada na tela.
      if (labelEl === swDeptHdr && wasOn && !newVal) {
        await persistDepartmentModeOffNow();
        return;
      }

      setSwitch(labelEl, newVal, pillEl);

      if (labelEl === swAutoHdr) setAccordionOpen(headAuto, bodyAuto, newVal);
      if (labelEl === swDeptHdr) setAccordionOpen(headAutoDept, bodyAutoDept, newVal);

      onToggle?.(newVal);

      if (!cfg?.features) return;

      ensureMasters(cfg);

      if (labelEl === swAutoHdr) {
        cfg.features.auto_messages.enabled = newVal;

        if (!newVal) {
          setSwitch(swWelcome, false, pillWelcome);
          setSwitch(swOff, false, pillOff);

          (cfg.features.auto_messages.welcome ||= {}).enabled = false;
          (cfg.features.auto_messages.off_hours ||= {}).enabled = false;
        }

        syncSectionState();
        schedulePersist(200, { silent: false });
        return;
      }

      if (labelEl === swDeptHdr) {
        cfg.features.auto_messages_departments.enabled = newVal;

        if (!newVal) {
          setSwitch(swDeptWelcome, false, pillDeptWelcome);
          (cfg.features.auto_messages_departments.welcome ||= {}).enabled = false;
        }

        syncSectionState();
        schedulePersist(200, { silent: false });
        return;
      }

      if (labelEl === swWelcome) {
        if (newVal && !getSwitch(swAutoHdr)) {
          setHeaderSwitch(swAutoHdr, pillAutoHdr, true);
          cfg.features.auto_messages.enabled = true;
        }

        (cfg.features.auto_messages.welcome ||= {}).enabled = newVal;

        syncSectionState();
        schedulePersist(200, { silent: false });
        return;
      }

      if (labelEl === swOff) {
        if (newVal && !getSwitch(swAutoHdr)) {
          setHeaderSwitch(swAutoHdr, pillAutoHdr, true);
          cfg.features.auto_messages.enabled = true;
        }

        (cfg.features.auto_messages.off_hours ||= {}).enabled = newVal;

        syncSectionState();
        schedulePersist(200, { silent: false });
        return;
      }

      if (labelEl === swDeptWelcome) {
        if (newVal && !getSwitch(swDeptHdr)) {
          setHeaderSwitch(swDeptHdr, pillDeptHdr, true);
          cfg.features.auto_messages_departments.enabled = true;
        }

        (cfg.features.auto_messages_departments.welcome ||= {}).enabled = newVal;

        syncSectionState();
        schedulePersist(200, { silent: false });
      }
    });
  }

  function updateSaveButtons() {
    const busy = __persisting || __filaSafetyPending > 0;
    if (saveAuto) saveAuto.disabled = busy;
    if (saveDept) saveDept.disabled = busy;
    if (saveGlobal) saveGlobal.disabled = busy;
  }

  async function getConfig() {
    const url = new URL('/api/chatbot/config', location.origin);
    url.searchParams.set('empresa_id', String(EMPRESA_ID()));
    url.searchParams.set('instancia_id', requireActiveInstKey());

    const r = await authFetch(url.toString());

    if (!r.ok) {
      let detail = '';
      try { detail = await r.text(); } catch {}
      throw new Error(`GET config ${r.status}: ${detail}`);
    }

    const data = await r.json();

    if (data?.empresa_nome) {
      _empresaNome = String(data.empresa_nome).trim();
      try { LS.setItem('empresa_nome', _empresaNome); } catch {}
    }

    _filaCache = Array.isArray(data?.departamentos)
      ? data.departamentos.map(dep => ({
          id: String(dep.id),
          nome: cleanLabel(dep.nome),
          departamento_id: dep.id || null,
          departamento_nome: dep.nome || '',
          prioridade: 'normal'
        })).filter(dep => dep.id && dep.nome)
      : [];

    const merged = deepMerge(structuredClone(LOCAL_DEFAULTS), data?.config || {});
    merged.timezone = (merged.timezone || '').trim() || FALLBACK_TZ;

    ensureMasters(merged);

    return merged;
  }

  async function loadFilasPublicas() {
    /*
      Compatibilidade: o código antigo chamava este bloco de "filas públicas".
      Agora o menu do chatbot é por departamento e os departamentos já vêm no
      GET /api/chatbot/config, no campo data.departamentos.
    */
    if (!Array.isArray(_filaCache)) _filaCache = [];
    return _filaCache;
  }

  async function putConfig(data) {
    data.timezone = (data.timezone || '').trim() || FALLBACK_TZ;

    const url = new URL('/api/chatbot/config', location.origin);
    url.searchParams.set('empresa_id', String(EMPRESA_ID()));
    url.searchParams.set('instancia_id', requireActiveInstKey());

    const r = await authFetch(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: data })
    });

    let detail = '';

    try {
      const body = await r.clone().json();
      detail = body?.detail ? (typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)) : '';
    } catch {
      detail = await r.text();
    }

    if (!r.ok) {
      const dlow = (detail || '').toLowerCase();
      const tzMissing = (dlow.includes(' tz ') || dlow.includes('"tz"')) && (dlow.includes('not-null') || dlow.includes('null'));

      if (tzMissing) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = `Usar ${FALLBACK_TZ} e salvar`;
        btn.style.cssText = 'padding:8px 12px;border-radius:10px;background:#10b981;color:#111827;border:0;font-weight:700;cursor:pointer';

        btn.addEventListener('click', async () => {
          try {
            data.timezone = FALLBACK_TZ;
            await putConfig(data);
            toast('Fuso horário aplicado e configurações salvas.');
          } catch {}
        });

        notify({
          title: 'Defina o fuso horário da empresa',
          message: `Para salvar as mensagens automáticas, precisamos do fuso horário.<br>Você pode ajustar em <b>Configurações → Empresa → Fuso horário</b> (ex.: ${FALLBACK_TZ}) ou clicar no botão abaixo.`,
          kind: 'warn',
          details: detail,
          actions: [btn]
        });

        throw new Error('missing_timezone');
      }

      const { title, message, details } = friendlyHttpError(r.status, detail);
      notify({ title, message, kind: (r.status >= 400 ? 'error' : 'warn'), details });
      throw new Error(message);
    }

    return true;
  }

  function validateBeforeSave(kind = 'auto') {
    [wStart, wEnd, oStart, oEnd, dwStart, dwEnd, msgWelcome, msgOff, msgDeptWelcome].forEach(x => markInvalid(x, false));

    const errors = [];
    const fixes = [];

    if (kind === 'auto' && getSwitch(swAutoHdr)) {
      if (getSwitch(swWelcome)) {
        if (!msgWelcome?.value?.trim()) {
          errors.push('Mensagem de boas-vindas não pode ficar vazia.');
          markInvalid(msgWelcome, true);
        }

        if (wStart && !timeValid(wStart.value)) {
          errors.push('Horário inicial do atendimento inválido.');
          markInvalid(wStart, true);
        }

        if (wEnd && !timeValid(wEnd.value)) {
          errors.push('Horário final do atendimento inválido.');
          markInvalid(wEnd, true);
        }
      }

      if (getSwitch(swOff)) {
        if (!msgOff?.value?.trim()) {
          errors.push('Mensagem de fora do horário não pode ficar vazia.');
          markInvalid(msgOff, true);
        }

        if (oStart && !timeValid(oStart.value)) {
          errors.push('Horário de fechamento inválido.');
          markInvalid(oStart, true);
        }

        if (oEnd && !timeValid(oEnd.value)) {
          errors.push('Horário de abertura inválido.');
          markInvalid(oEnd, true);
        }
      }

      if (!getSwitch(swWelcome) && !getSwitch(swOff)) {
        errors.push('Ative a resposta automática simples para editar as mensagens.');
      }

      const both = getSwitch(swWelcome) && getSwitch(swOff)
        && timeValid(wStart?.value || '') && timeValid(wEnd?.value || '')
        && timeValid(oStart?.value || '') && timeValid(oEnd?.value || '');

      if (both) {
        const ws = hhmmToMin(wStart.value);
        const we = hhmmToMin(wEnd.value);
        const os = hhmmToMin(oStart.value);
        const oe = hhmmToMin(oEnd.value);
        const ov = overlap(ws, we, os, oe);

        if (ov) {
          const [s, e] = ov;

          errors.push(`Os horários se sobrepõem entre ${m2hhmm(s)} e ${m2hhmm(e)}.`);
          markInvalid(oStart, true);
          markInvalid(wEnd, true);

          const fix = document.createElement('button');
          fix.type = 'button';
          fix.textContent = `Ajustar “Quando fecha” para ${wEnd.value}`;
          fix.style.cssText = 'padding:8px 12px;border-radius:10px;background:#10b981;color:#111827;border:0;font-weight:700;cursor:pointer';

          fix.addEventListener('click', () => {
            oStart.value = wEnd.value;
            markInvalid(oStart, false);
            markInvalid(wEnd, false);
            toast('Corrigido: sem sobreposição.');
          });

          fixes.push(fix);
        } else if (!isComplement(ws, we, os, oe)) {
          const fix = document.createElement('button');
          fix.type = 'button';
          fix.textContent = 'Complementar automaticamente';
          fix.style.cssText = 'padding:8px 12px;border-radius:10px;background:#60a5fa;color:#111827;border:0;font-weight:700;cursor:pointer';

          fix.addEventListener('click', () => {
            oStart.value = wEnd.value;
            oEnd.value = wStart.value;
            toast('Horário fora do atendimento ajustado.');
          });

          errors.push('Os intervalos não são complementares (pode sobrar horário sem mensagem).');
          fixes.push(fix);
        }
      }
    }

    if (kind === 'dept' && getSwitch(swDeptHdr)) {
      if (getSwitch(swDeptWelcome)) {
        if (!msgDeptWelcome?.value?.trim()) {
          errors.push('Mensagem do menu de departamentos não pode ficar vazia.');
          markInvalid(msgDeptWelcome, true);
        }

        if (dwStart && !timeValid(dwStart.value)) {
          errors.push('Horário inicial do atendimento inválido.');
          markInvalid(dwStart, true);
        }

        if (dwEnd && !timeValid(dwEnd.value)) {
          errors.push('Horário final do atendimento inválido.');
          markInvalid(dwEnd, true);
        }
      } else {
        errors.push('Ative o menu para salvar este bloco.');
      }

      if (Array.isArray(_filaCache) && _filaCache.length) {
        if (countSelectedFilas() <= 0) {
          errors.push('Selecione ao menos 1 departamento para o menu do cliente.');
        }
      } else {
        errors.push('Nenhum departamento ativo encontrado. Cadastre um departamento primeiro.');
      }
    }

    if (errors.length) {
      const msg = 'Por favor, revise os pontos abaixo:\n\n• ' + errors.join('\n• ');
      notify({ title: 'Não conseguimos salvar', message: msg, kind: 'warn', actions: fixes });
      return false;
    }

    return true;
  }

  function maybeFillWelcome() {
    if (!msgWelcome) return;

    msgWelcome.value = expandTemplate(msgWelcome.value);

    const v = (msgWelcome.value || '').trim();

    const precisaTrocar = (
      !v ||
      /\{empresa\}|\[Empresa\]/i.test(v) ||
      v === 'Olá! 👋 Como posso ajudar?' ||
      v.startsWith('Olá! 👋 Você fala com')
    );

    if (precisaTrocar) {
      msgWelcome.value = expandTemplate(buildAutoWelcomeTemplate());
    }

    if (wcCount) wcCount.textContent = `${msgWelcome.value.length} caracteres`;

    renderWelcomePreview();
  }

  function maybeFillFilaWelcome() {
    if (!msgDeptWelcome) return;

    let v = (msgDeptWelcome.value || '').trim();

    if (
      !v ||
      /\{empresa\}/i.test(v) ||
      /\{menu_filas\}/i.test(v) ||
      /\{menu_departamentos\}/i.test(v) ||
      v.includes('Você está falando com o departamento')
    ) {
      msgDeptWelcome.value = buildFilaTriagemTemplate();
    } else {
      msgDeptWelcome.value = msgDeptWelcome.value.replace(/\{menu_filas\}/gi, '{menu_departamentos}');
    }

    if (dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;

    renderFilaPreview();
  }

  async function loadAll() {
    cfg = await getConfig();
    ensureMasters(cfg);
    resetFilaDraftItems();

    await loadFilasPublicas();

    seedFilaItemsDefault();

    _lastLoadedSnapshot = JSON.stringify(cfg);

    setHeaderSwitch(swAutoHdr, pillAutoHdr, !!cfg.features.auto_messages.enabled);
    setHeaderSwitch(swDeptHdr, pillDeptHdr, !!cfg.features.auto_messages_departments.enabled);

    const w = cfg.features.auto_messages.welcome || {};
    setSwitch(swWelcome, !!w.enabled, pillWelcome);
    if (msgWelcome) msgWelcome.value = w.text ?? buildAutoWelcomeTemplate();
    if (wStart) wStart.value = w.start ?? '08:00';
    if (wEnd) wEnd.value = w.end ?? '18:00';
    if (wcCount) wcCount.textContent = `${(msgWelcome?.value || '').length} caracteres`;
    maybeFillWelcome();

    const o = cfg.features.auto_messages.off_hours || {};
    setSwitch(swOff, !!o.enabled, pillOff);
    if (msgOff) msgOff.value = o.text ?? 'Atendemos de 08:00 às 18:00. Deixe sua mensagem e responderemos no próximo expediente.';
    if (oStart) oStart.value = o.start ?? '18:00';
    if (oEnd) oEnd.value = o.end ?? '08:00';
    if (offCount) offCount.textContent = `${(msgOff?.value || '').length} caracteres`;

    const fw = cfg.features.auto_messages_departments.welcome || {};
    setSwitch(swDeptWelcome, !!fw.enabled, pillDeptWelcome);

    if (msgDeptWelcome) {
      msgDeptWelcome.value = (fw.text ?? '').trim() || buildFilaTriagemTemplate();
      if (dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
    }

    maybeFillFilaWelcome();

    if (dwStart) dwStart.value = fw.start ?? '08:00';
    if (dwEnd) dwEnd.value = fw.end ?? '18:00';

    attachFilaSuggestions(msgDeptWelcome);
    renderFilaPicker();
    syncSectionState();
  }

  async function saveAutoBlock() {
    await persistUI({ silent: false });
  }

  async function saveFilaBlock() {
    if (!cfg || __persisting || __filaSafetyPending > 0) return;

    const previousItems = cloneFilaItems(ensureFilaItems());
    commitFilaDraftItems();

    const saved = await persistUI({ silent: false });

    if (saved) {
      resetFilaDraftItems();
    } else {
      filaFeature().items = previousItems;
    }

    renderFilaPicker();
  }

  function restoreSnapshot(showToast = true) {
    try {
      if (!_lastLoadedSnapshot) return;

      clearTimeout(__persistTimer);
      cfg = JSON.parse(_lastLoadedSnapshot);
      ensureMasters(cfg);
      resetFilaDraftItems();
      seedFilaItemsDefault();

      setHeaderSwitch(swAutoHdr, pillAutoHdr, !!cfg.features.auto_messages.enabled);
      setHeaderSwitch(swDeptHdr, pillDeptHdr, !!cfg.features.auto_messages_departments.enabled);

      const w = cfg.features.auto_messages.welcome || {};
      setSwitch(swWelcome, !!w.enabled, pillWelcome);
      if (msgWelcome) msgWelcome.value = w.text ?? buildAutoWelcomeTemplate();
      if (wStart) wStart.value = w.start ?? '08:00';
      if (wEnd) wEnd.value = w.end ?? '18:00';
      if (wcCount) wcCount.textContent = `${(msgWelcome?.value || '').length} caracteres`;
      maybeFillWelcome();

      const o = cfg.features.auto_messages.off_hours || {};
      setSwitch(swOff, !!o.enabled, pillOff);
      if (msgOff) msgOff.value = o.text ?? 'Atendemos de 08:00 às 18:00. Deixe sua mensagem e responderemos no próximo expediente.';
      if (oStart) oStart.value = o.start ?? '18:00';
      if (oEnd) oEnd.value = o.end ?? '08:00';
      if (offCount) offCount.textContent = `${(msgOff?.value || '').length} caracteres`;

      const fw = cfg.features.auto_messages_departments.welcome || {};
      setSwitch(swDeptWelcome, !!fw.enabled, pillDeptWelcome);

      if (msgDeptWelcome) {
        msgDeptWelcome.value = (fw.text ?? '').trim() || buildFilaTriagemTemplate();
        if (dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
      }

      maybeFillFilaWelcome();

      if (dwStart) dwStart.value = fw.start ?? '08:00';
      if (dwEnd) dwEnd.value = fw.end ?? '18:00';

      renderFilaPicker();
      syncSectionState();

      if (showToast) toast('Alterações descartadas.', 'warn');
    } catch {}
  }

  async function initInstDropdown() {
    if (!instBtn || !instMenu || !instList) return;

    if (!window.CSS) window.CSS = {};

    if (typeof CSS.escape !== 'function') {
      CSS.escape = (v) => String(v ?? '').replace(/["\\]/g, '\\$&').replace(/\s/g, '\\ ');
    }

    function openMenu() {
      instMenu.setAttribute('aria-hidden', 'false');
      instBtn.setAttribute('aria-expanded', 'true');

      (instList.querySelector('.inst-item[aria-selected="true"]') || instList.querySelector('.inst-item'))?.focus();

      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('keydown', onKey);
    }

    function closeMenu() {
      instMenu.setAttribute('aria-hidden', 'true');
      instBtn.setAttribute('aria-expanded', 'false');

      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    }

    function toggleMenu() {
      (instMenu.getAttribute('aria-hidden') !== 'false') ? openMenu() : closeMenu();
    }

    function onDocClick(e) {
      if (!instMenu.contains(e.target) && e.target !== instBtn) closeMenu();
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        instBtn.focus();
      }

      if (instMenu.getAttribute('aria-hidden') === 'true') return;

      const items = Array.from(instList.querySelectorAll('.inst-item'));
      const i = items.indexOf(document.activeElement);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        (items[i + 1] || items[0])?.focus();
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        (items[i - 1] || items[items.length - 1])?.focus();
      }

      if (e.key === 'Home') {
        e.preventDefault();
        items[0]?.focus();
      }

      if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1]?.focus();
      }

      if (e.key === 'Enter' || e.key === ' ') {
        const a = document.activeElement;

        if (a && a.classList.contains('inst-item')) {
          e.preventDefault();
          selectValue(a.dataset.value, a.dataset.label);
        }
      }
    }

    instBtn.addEventListener('click', toggleMenu);

    const empresaId = EMPRESA_ID();
    const instValue = (i) => i.instancia_id ?? i.id ?? i.instance_id ?? i.session ?? i.sessionName ?? '';
    const instLabel2 = (i, v) => i.apelido || i.nome || i.instance_name || String(v) || 'Instância';

    function itemTpl(text, value, selected) {
      const li = document.createElement('li');
      const b = document.createElement('button');

      b.type = 'button';
      b.className = 'inst-item';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', selected ? 'true' : 'false');
      b.tabIndex = -1;
      b.dataset.value = String(value ?? '');
      b.dataset.label = text;
      b.innerHTML = `<span class="radio" aria-hidden="true"></span><span>${text}</span>`;

      b.addEventListener('click', () => selectValue(String(value ?? ''), text));

      li.appendChild(b);
      return li;
    }

    function setActiveUI(value, text) {
      instList.querySelectorAll('.inst-item').forEach(b => {
        b.setAttribute('aria-selected', b.dataset.value === String(value) ? 'true' : 'false');
      });

      const active = instList.querySelector(`.inst-item[data-value="${CSS.escape(String(value || ''))}"]`);

      if (active) {
        instMenu.setAttribute('aria-activedescendant', active.id || (active.id = 'inst-opt-chat-' + String(value || 'x')));
      }

      if (instLabel) {
        instLabel.textContent = text || (value ? `Instância ${value}` : 'Selecione uma instância');
      }
    }

    function selectValue(value, text) {
      window.__INST_ID = value ? normalizeInstValue(value) : '';

      setActiveUI(value, text);

      if (window.__INST_ID) {
        lockUI(false);

        loadAll().catch(e => {
          const { title, message, details } = friendlyHttpError(0, String(e?.message || e));
          notify({ title, message, details });
        });
      } else {
        lockUI(true, 'Selecione uma instância para configurar o chatbot.');
      }

      closeMenu();
      instBtn.focus();
    }

    async function loadList() {
      instList.innerHTML = '';

      let items = [];

      if (empresaId) {
        try {
          const r = await authFetch(`/api/empresas/${empresaId}/whatsapp`);
          if (!r.ok) throw 0;

          const j = await r.json();
          items = Array.isArray(j.instancias) ? j.instancias : [];
        } catch {
          try {
            const r2 = await authFetch(`/api/instancias/list?empresa_id=${empresaId}`);
            if (!r2.ok) throw 0;

            const j2 = await r2.json();
            items = Array.isArray(j2) ? j2 : (Array.isArray(j2?.instancias) ? j2.instancias : []);
          } catch {
            items = [];
          }
        }
      }

      items.forEach(i => {
        const v = normalizeInstValue(instValue(i));
        const t = instLabel2(i, v);
        instList.appendChild(itemTpl(t, v, false));
      });

      if (window.__INST_ID == null || window.__INST_ID === '') {
        const firstConnected = items.find(x => !!(x.connected || x.conectada || x.status === 'CONNECTED'));
        const firstAny = items[0];
        const chosen = firstConnected || firstAny;

        window.__INST_ID = chosen ? normalizeInstValue(instValue(chosen)) : '';
      }

      if (window.__INST_ID) {
        const sel = instList.querySelector(`.inst-item[data-value="${CSS.escape(String(window.__INST_ID))}"]`);
        const text = sel?.dataset?.label || `Instância ${window.__INST_ID}`;

        setActiveUI(sel?.dataset?.value ?? String(window.__INST_ID), text);
        lockUI(false);
      } else {
        setActiveUI('', 'Selecione uma instância');
        lockUI(true, 'Nenhuma instância disponível. Conecte um WhatsApp primeiro.');
      }
    }

    await loadList();
  }

  function activeMode() {
    if (getSwitch(swDeptHdr) && getSwitch(swDeptWelcome)) return 'dept';
    if (getSwitch(swAutoHdr) && (getSwitch(swWelcome) || getSwitch(swOff))) return 'auto';
    return 'none';
  }

  function updateSummary() {
    const inst = String(instLabel?.textContent || '').trim() || '—';
    const mode = activeMode();
    const filas = getSelectedFilas();

    let modeLabel = 'Nenhum ativo';
    let behavior = 'Nada configurado';
    let badge = 'Modo: nenhum';

    if (mode === 'auto') {
      modeLabel = 'Resposta automática simples';
      badge = 'Modo: simples';

      if (getSwitch(swWelcome) && getSwitch(swOff)) {
        behavior = 'Envia boas-vindas e também mensagem fora do horário';
      } else if (getSwitch(swWelcome)) {
        behavior = 'Envia mensagem de boas-vindas';
      } else if (getSwitch(swOff)) {
        behavior = 'Envia mensagem de fora do horário';
      }
    } else if (mode === 'dept') {
      modeLabel = 'Menu para escolher departamento';
      badge = 'Modo: departamentos';
      behavior = `Mostra menu com ${filas.length || 0} departamento(s)`;
    }

    const instVal = document.getElementById('sumInstValue');
    const instChip = document.getElementById('sumInstLabel');
    const modeVal = document.getElementById('sumModeValue');
    const modeChip = document.getElementById('sumModeBadge');
    const behaviorVal = document.getElementById('sumBehaviorValue');
    const filaVal = document.getElementById('sumDeptValue');

    if (instVal) instVal.textContent = inst;
    if (instChip) instChip.textContent = `Instância: ${inst}`;
    if (modeVal) modeVal.textContent = modeLabel;
    if (modeChip) modeChip.textContent = badge;
    if (behaviorVal) behaviorVal.textContent = behavior;
    if (filaVal) filaVal.textContent = String(filas.length);
  }

  let _sumRaf = null;

  function scheduleSummaryRefresh() {
    if (_sumRaf) cancelAnimationFrame(_sumRaf);

    _sumRaf = requestAnimationFrame(() => {
      updateSummary();
      updateSimulatorBadge();
      _sumRaf = null;
    });
  }

  function renderWelcomeMessage() {
    const raw = String(msgWelcome?.value || '').trim() || buildAutoWelcomeTemplate();

    return raw.replace(/\{empresa\}/gi, _empresaNome || EMPRESA_NOME() || '[Empresa]');
  }

  function renderOffMessage() {
    const raw = String(msgOff?.value || '').trim() || 'Atendemos de 08:00 às 18:00. Deixe sua mensagem e responderemos no próximo expediente.';

    return raw.replace(/\{empresa\}/gi, _empresaNome || EMPRESA_NOME() || '[Empresa]');
  }

  function renderFilaMessage() {
    const raw = String(msgDeptWelcome?.value || '').trim() || buildFilaTriagemTemplate();
    return renderFilaTemplate(raw);
  }

  function parseChoice(text) {
    const raw = String(text || '').trim();
    const norm = raw.toLowerCase();

    const filas = getSelectedFilas();

    if (!filas.length) return null;

    const num = norm.match(/^(\d{1,2})\b/);

    if (num) {
      const idx = Number(num[1]) - 1;
      if (filas[idx]) return filas[idx];
    }

    const exact = filas.find(f => f.nome.toLowerCase() === norm);
    if (exact) return exact;

    const contains = filas.find(f => norm.includes(f.nome.toLowerCase()));
    if (contains) return contains;

    return null;
  }

  function updateSimulatorBadge() {
    const el = document.getElementById('simModeBadge');
    if (!el) return;

    const mode = activeMode();

    if (mode === 'auto') el.textContent = 'Modo: resposta simples';
    else if (mode === 'dept') el.textContent = 'Modo: menu de departamentos';
    else el.textContent = 'Modo: nenhum ativo';
  }

  function addBubble(text, who = 'bot') {
    const body = document.getElementById('simChatBody');
    if (!body) return;

    const div = document.createElement('div');
    div.className = `sim-bubble ${who}`;
    div.textContent = text;

    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  function clearSim() {
    const body = document.getElementById('simChatBody');
    if (body) body.innerHTML = '';
  }

  function simulateFirstContact(customInput) {
    updateSimulatorBadge();
    clearSim();

    const txt = String(customInput || document.getElementById('simClientInput')?.value || '').trim() || 'Oi';

    addBubble(txt, 'client');

    const mode = activeMode();

    if (mode === 'dept') {
      addBubble(renderFilaMessage(), 'bot');
      return;
    }

    if (mode === 'auto') {
      if (getSwitch(swWelcome)) {
        addBubble(renderWelcomeMessage(), 'bot');
        return;
      }

      if (getSwitch(swOff)) {
        addBubble(renderOffMessage(), 'bot');
        return;
      }

      addBubble('Nenhuma mensagem está ativa neste modo.', 'bot');
      return;
    }

    addBubble('Nenhum modo está ativo nesta instância.', 'bot');
  }

  function simulateInvalidChoice() {
    clearSim();
    updateSimulatorBadge();

    addBubble('tempo', 'client');

    if (activeMode() !== 'dept') {
      addBubble('Essa simulação faz mais sentido quando o menu de departamentos está ativo.', 'bot');
      return;
    }

    addBubble(`Não entendi sua opção.\n\n${renderFilaMessage()}`, 'bot');
  }

  function simulateValidChoice() {
    clearSim();
    updateSimulatorBadge();

    if (activeMode() !== 'dept') {
      addBubble('Essa simulação faz mais sentido quando o menu de departamentos está ativo.', 'bot');
      return;
    }

    const filas = getSelectedFilas();

    if (!filas.length) {
      addBubble('Oi', 'client');
      addBubble('Nenhum departamento foi selecionado para aparecer no menu.', 'bot');
      return;
    }

    const chosen = filas[1] || filas[0];
    const idx = Math.max(1, filas.findIndex(f => f.id === chosen.id) + 1);

    addBubble('Oi', 'client');
    addBubble(renderFilaMessage(), 'bot');
    addBubble(String(idx), 'client');
    addBubble(`Perfeito! Vou te encaminhar para *${chosen.nome}*. Só um instante 🙂`, 'bot');
  }

  function simulateOffHours() {
    clearSim();
    updateSimulatorBadge();

    addBubble('Oi, tudo bem?', 'client');

    if (activeMode() !== 'auto') {
      addBubble('Essa simulação faz mais sentido quando a resposta automática simples está ativa.', 'bot');
      return;
    }

    if (getSwitch(swOff)) {
      addBubble(renderOffMessage(), 'bot');
    } else {
      addBubble('A mensagem de fora do horário não está ativa.', 'bot');
    }
  }

  function bindHelpModal() {
    const helpBtn = document.getElementById('helpChatbotBtn');
    const automationHelpBtn = document.getElementById('automationHelpBtn');

    function openModal(id) {
      const modal = document.getElementById(id);
      if (!modal) return;

      modal.hidden = false;
      requestAnimationFrame(() => modal.classList.add('show'));
      document.body.style.overflow = 'hidden';

      scheduleSummaryRefresh();

      if (id === 'chatbotHelpModal' && !document.getElementById('simChatBody')?.children.length) {
        simulateFirstContact('Oi');
      }
    }

    function closeModal(id) {
      const modal = document.getElementById(id);
      if (!modal) return;

      modal.classList.remove('show');
      document.body.style.overflow = '';

      setTimeout(() => {
        modal.hidden = true;
      }, 180);

      scheduleSummaryRefresh();
    }

    automationHelpBtn?.addEventListener('click', () => openModal('automationHelpModal'));
    helpBtn?.addEventListener('click', () => openModal('chatbotHelpModal'));

    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close-modal')));
    });

    document.querySelectorAll('.help-modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal.id);
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.help-modal.show').forEach(m => closeModal(m.id));
      }
    });

    document.getElementById('simFirstBtn')?.addEventListener('click', () => {
      simulateFirstContact('Oi');
      scheduleSummaryRefresh();
    });

    document.getElementById('simInvalidBtn')?.addEventListener('click', () => {
      simulateInvalidChoice();
      scheduleSummaryRefresh();
    });

    document.getElementById('simValidBtn')?.addEventListener('click', () => {
      simulateValidChoice();
      scheduleSummaryRefresh();
    });

    document.getElementById('simOffBtn')?.addEventListener('click', () => {
      simulateOffHours();
      scheduleSummaryRefresh();
    });

    document.getElementById('simClearBtn')?.addEventListener('click', () => {
      clearSim();
      scheduleSummaryRefresh();
    });

    document.getElementById('simSendBtn')?.addEventListener('click', () => {
      const val = String(document.getElementById('simClientInput')?.value || '').trim();
      if (!val) return;

      const mode = activeMode();

      clearSim();

      if (mode === 'dept') {
        addBubble(val, 'client');

        const chosen = parseChoice(val);

        if (chosen) {
          addBubble(`Perfeito! Vou te encaminhar para *${chosen.nome}*. Só um instante 🙂`, 'bot');
        } else {
          addBubble(`Não entendi sua opção.\n\n${renderFilaMessage()}`, 'bot');
        }

        scheduleSummaryRefresh();
        return;
      }

      simulateFirstContact(val);
      scheduleSummaryRefresh();
    });

    document.getElementById('simClientInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('simSendBtn')?.click();
      }
    });
  }

  async function boot() {
    try {
      bindAccordion(headAuto, bodyAuto);
      bindAccordion(headAutoDept, bodyAutoDept);
      bindHelpModal();
      bindVariableButtons();

      bindSwitch(swAutoHdr, pillAutoHdr, (on) => {
        if (cfg?.features) cfg.features.auto_messages.enabled = on;
        syncSectionState();
      });

      bindSwitch(swDeptHdr, pillDeptHdr, (on) => {
        if (cfg?.features) {
          ensureMasters(cfg);
          cfg.features.auto_messages_departments.enabled = on;
        }
        syncSectionState();
      });

      bindSwitch(swWelcome, pillWelcome, (on) => {
        if (cfg) (cfg.features.auto_messages.welcome ||= {}).enabled = on;
        syncSectionState();
      });

      bindSwitch(swOff, pillOff, (on) => {
        if (cfg) (cfg.features.auto_messages.off_hours ||= {}).enabled = on;
        syncSectionState();
      });

      bindSwitch(swDeptWelcome, pillDeptWelcome, (on) => {
        if (cfg) {
          ensureMasters(cfg);
          (cfg.features.auto_messages_departments.welcome ||= {}).enabled = on;
        }
        syncSectionState();
      });

      msgWelcome?.addEventListener('input', () => {
        if (wcCount) wcCount.textContent = `${msgWelcome.value.length} caracteres`;
        renderWelcomePreview();
        updateSaveButtons();
        schedulePersist(350, { silent: true });
        scheduleSummaryRefresh();
      });

      msgOff?.addEventListener('input', () => {
        if (offCount) offCount.textContent = `${msgOff.value.length} caracteres`;
        renderOffPreview();
        updateSaveButtons();
        schedulePersist(350, { silent: true });
        scheduleSummaryRefresh();
      });

      msgDeptWelcome?.addEventListener('input', () => {
        if (dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
        renderFilaPreview();
        updateSaveButtons();
        schedulePersist(350, { silent: true });
        scheduleSummaryRefresh();
      });

      wStart?.addEventListener('change', () => schedulePersist(200, { silent: true }));
      wEnd?.addEventListener('change', () => schedulePersist(200, { silent: true }));
      oStart?.addEventListener('change', () => schedulePersist(200, { silent: true }));
      oEnd?.addEventListener('change', () => schedulePersist(200, { silent: true }));
      dwStart?.addEventListener('change', () => schedulePersist(200, { silent: true }));
      dwEnd?.addEventListener('change', () => schedulePersist(200, { silent: true }));

      deptSearch?.addEventListener('input', () => renderFilaPicker());

      deptAll?.addEventListener('click', () => {
        if (!cfg) return;

        const items = ensureFilaDraftItems();

        (_filaCache || []).forEach(f => {
          const id = String(f.id);
          const nome = cleanLabel(f.nome);

          items[id] = {
            ...(items[id] || {}),
            enabled: true,
            label: items[id]?.label || nome
          };
        });

        renderFilaPicker();
        refreshFilaTemplateIfDefaultLike();
        renderFilaPreview();
        updateSaveButtons();
        scheduleSummaryRefresh();
      });

      deptNone?.addEventListener('click', () => {
        if (!cfg) return;

        const items = ensureFilaDraftItems();

        (_filaCache || []).forEach(f => {
          const id = String(f.id);
          const nome = cleanLabel(f.nome);

          items[id] = {
            ...(items[id] || {}),
            enabled: false,
            label: items[id]?.label || nome
          };
        });

        renderFilaPicker();
        refreshFilaTemplateIfDefaultLike();
        renderFilaPreview();
        updateSaveButtons();
        scheduleSummaryRefresh();

        // "Nenhuma" também precisa interromper o menu sem aguardar Salvar.
        queueImmediateFilaDisable((_filaCache || []).map(f => String(f.id)));
      });

      saveAuto?.addEventListener('click', saveAutoBlock);
      saveDept?.addEventListener('click', saveFilaBlock);
      saveGlobal?.addEventListener('click', () => {
        if (getSwitch(swDeptHdr)) return saveFilaBlock();
        return saveAutoBlock();
      });

      cancelAuto?.addEventListener('click', () => restoreSnapshot(true));
      cancelDept?.addEventListener('click', () => restoreSnapshot(true));

      initRobotUI();

      await initInstDropdown();

      const key = getActiveInstKey();

      if (!key) {
        lockUI(true, 'Selecione uma instância para configurar o chatbot.');
        return;
      }

      lockUI(false);
      await loadAll();

      setTimeout(scheduleSummaryRefresh, 200);
    } catch (e) {
      const { title, message, details } = friendlyHttpError(0, String(e?.message || e));
      notify({ title, message, details });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();