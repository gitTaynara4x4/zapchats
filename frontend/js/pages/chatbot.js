// /frontend/js/pages/chatbot.js
// Chatbot Config – Notificações amigáveis + validação + placeholders {empresa}/{menu_departamentos}
(() => {
  'use strict';

  const LS = localStorage;
  const EMPRESA_ID   = () => Number(LS.getItem('empresa_id') || 0);
  const EMPRESA_NOME = () => (LS.getItem('empresa_nome') || '[Empresa]').trim();
  const TOKEN        = () => LS.getItem('token') || LS.getItem('auth_token') || '';
  const FALLBACK_TZ  = 'America/Sao_Paulo';

  async function authFetch(input, init = {}) {
    const t = TOKEN();
    const headers = { ...(init.headers || {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
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
    box.style.cssText = 'min-width:280px;max-width:520px;padding:12px 14px;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.25);font:14px/1.35 system-ui;transition:.25s';
    const color = kind === 'error' ? '#fee2e2' : kind === 'warn' ? '#fef3c7' : '#dbeafe';
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

  function notify({ title = 'Atenção', message = '', kind = 'warn', details = null, actions = [] } = {}) {
    let overlay = el('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px';

    const card = el('div');
    card.style.cssText = 'width:min(680px,96vw);background:#0b0b13;color:#e5e7eb;border:1px solid #1f2937;border-radius:16px;padding:18px 18px 14px;box-shadow:0 10px 40px rgba(0,0,0,.45);font:14px/1.5 system-ui';

    const head = el('div');
    head.style.cssText = 'font-weight:700;font-size:16px;margin-bottom:8px;display:flex;gap:8px;align-items:center';

    const dot = el('span');
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%';
    dot.style.background = kind === 'error' ? '#ef4444' : (kind === 'warn' ? '#f59e0b' : '#60a5fa');

    const h = el('span');
    h.textContent = title;
    head.append(dot, h);

    const p = el('div');
    p.innerHTML = String(message || '').replace(/\n/g, '<br>');
    p.style.marginBottom = '8px';

    const detWrap = el('div');
    detWrap.style.display = details ? '' : 'none';

    const toggle = el('button');
    toggle.type = 'button';
    toggle.textContent = 'Ver detalhes técnicos';
    toggle.style.cssText = 'background:none;border:0;color:#93c5fd;text-decoration:underline;cursor:pointer;padding:0;margin:6px 0';

    const pre = el('pre');
    pre.textContent = details || '';
    pre.style.cssText = 'white-space:pre-wrap;margin:8px 0 0;background:#0f172a;border:1px solid #1f2937;border-radius:10px;padding:10px;max-height:38vh;overflow:auto;font-size:12px;display:none';

    toggle.addEventListener('click', () => {
      pre.style.display = pre.style.display === 'none' ? 'block' : 'none';
    });

    detWrap.append(toggle, pre);

    const footer = el('div');
    footer.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:12px';

    const ok = el('button');
    ok.type = 'button';
    ok.textContent = 'OK';
    ok.style.cssText = 'padding:8px 14px;border-radius:10px;background:#c7d2fe;color:#111827;border:0;font-weight:600;cursor:pointer';
    ok.addEventListener('click', () => overlay.remove());

    footer.append(...actions, ok);
    card.append(head, p, detWrap, footer);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function confirmAction({
    title = 'Confirmar ação',
    message = 'Tem certeza que deseja continuar?',
    confirmText = 'Sim, desligar',
    cancelText = 'Cancelar',
    kind = 'warn'
  } = {}) {
    return new Promise((resolve) => {
      let overlay = el('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:100001;display:flex;align-items:center;justify-content:center;padding:20px';

      const card = el('div');
      card.style.cssText = 'width:min(520px,96vw);background:#0b0b13;color:#e5e7eb;border:1px solid #1f2937;border-radius:16px;padding:18px 18px 14px;box-shadow:0 10px 40px rgba(0,0,0,.45);font:14px/1.5 system-ui';

      const head = el('div');
      head.style.cssText = 'font-weight:700;font-size:16px;margin-bottom:8px;display:flex;gap:8px;align-items:center';

      const dot = el('span');
      dot.style.cssText = 'width:10px;height:10px;border-radius:50%';
      dot.style.background = kind === 'error' ? '#ef4444' : (kind === 'warn' ? '#f59e0b' : '#60a5fa');

      const h = el('span');
      h.textContent = title;
      head.append(dot, h);

      const p = el('div');
      p.innerHTML = String(message || '').replace(/\n/g, '<br>');

      const footer = el('div');
      footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px';

      const cancel = el('button');
      cancel.type = 'button';
      cancel.textContent = cancelText;
      cancel.style.cssText = 'padding:8px 14px;border-radius:10px;background:#111827;color:#e5e7eb;border:1px solid #374151;font-weight:600;cursor:pointer';

      const confirm = el('button');
      confirm.type = 'button';
      confirm.textContent = confirmText;
      confirm.style.cssText = 'padding:8px 14px;border-radius:10px;background:#ef4444;color:#fff;border:0;font-weight:700;cursor:pointer';

      function close(v) {
        overlay.remove();
        resolve(v);
      }

      cancel.addEventListener('click', () => close(false));
      confirm.addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

      footer.append(cancel, confirm);
      card.append(head, p, footer);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
    });
  }

  function friendlyHttpError(status, detailText = '') {
    const msgs = {
      0:   ['Sem conexão', 'Não conseguimos falar com o servidor.'],
      400: ['Não foi possível salvar', 'Revise os horários (HH:MM) e os textos das mensagens.'],
      401: ['Sessão expirada', 'Faça login novamente para continuar.'],
      403: ['Permissão negada', 'Você não pode alterar esta instância.'],
      404: ['Instância não encontrada', 'Selecione outra instância e tente novamente.'],
      409: ['Conflito', 'As configurações mudaram enquanto você editava. Recarregamos os dados.'],
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
      'button:not(#instMenuBtnChat):not(.inst-item), select'
    );
    controls.forEach(el => el.disabled = !!locked);

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
  let _deptCache = null;
  let _empresaNome = (LS.getItem('empresa_nome') || '').trim() || null;

  let __persisting = false;
  let __persistTimer = null;

  function buildAutoWelcomeTemplate() {
    return (
`Olá! 👋 Você fala com {empresa}.

Como podemos te ajudar hoje?`
    );
  }

  function cleanDeptLabel(value) {
    return String(value || '')
      .trim()
      .replace(/^\s*\d+\s*[-–—.)]\s*/, '')
      .trim();
  }

  const LOCAL_DEFAULTS = {
    timezone: FALLBACK_TZ,
    features: {
      auto_messages: {
        enabled: false,
        welcome: { enabled: false, text: buildAutoWelcomeTemplate(), start: '08:00', end: '18:00' },
        off_hours: { enabled: false, text: 'Atendemos de 08:00 às 18:00. Deixe sua mensagem e responderemos no próximo expediente.', start: '18:00', end: '08:00' }
      },
      auto_messages_departments: {
        enabled: false,
        welcome: { enabled: false, text: '', start: '08:00', end: '18:00' },
        items: {}
      }
    }
  };

  function setSwitch(el, on, pillEl) {
    if (!el) return;
    el.dataset.on = on ? 'true' : 'false';
    const input = el.querySelector('input');
    if (input) input.checked = !!on;
    if (pillEl) {
      pillEl.textContent = on ? 'on' : 'off';
      pillEl.classList.toggle('on', !!on);
      pillEl.classList.toggle('off', !on);
    }
  }

  function getSwitch(el) {
    return !!el?.querySelector('input')?.checked;
  }

  function setHeaderSwitch(el, pill, on) {
    setSwitch(el, on, pill);
    el?.setAttribute('aria-pressed', on ? 'true' : 'false');
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

  function insertAtCaret(ta, text) {
    if (!ta) return;
    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    const pos = s + text.length;
    ta.focus();
    try { ta.setSelectionRange(pos, pos); } catch {}
    if (ta === msgWelcome && wcCount) wcCount.textContent = `${ta.value.length} caracteres`;
    if (ta === msgDeptWelcome && dwCount) dwCount.textContent = `${ta.value.length} caracteres`;
    if (ta === msgWelcome) renderWelcomePreview();
    if (ta === msgDeptWelcome) renderDeptPreview();
  }

  function timeValid(v) {
    if (typeof v !== 'string' || !/^\d{2}:\d{2}$/.test(v)) return false;
    const [h, m] = v.split(':').map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  }

  function markInvalid(el, on = true) {
    if (!el) return;
    el.setAttribute('aria-invalid', on ? 'true' : 'false');
    el.style.outline = on ? '2px solid #ef4444' : '';
    el.style.outlineOffset = on ? '2px' : '';
  }

  const DAY = 24 * 60;
  const pad2 = n => String(n).padStart(2, '0');
  const m2hhmm = m => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
  const hhmmToMin = s => {
    if (!timeValid(s)) return NaN;
    const [h, m] = s.split(':').map(Number);
    return (h * 60 + m) % DAY;
  };
  const segs = (a, b) => a === b ? [] : (a < b ? [[a, b]] : [[a, DAY], [0, b]]);
  const overlap = (a1, a2, b1, b2) => {
    for (const [x, y] of segs(a1, a2)) {
      for (const [u, v] of segs(b1, b2)) {
        if (Math.min(y, v) > Math.max(x, u)) return [Math.max(x, u), Math.min(y, v)];
      }
    }
    return null;
  };
  const isComplement = (wS, wE, oS, oE) => oS === wE && oE === wS;

  function getSelectedDepartments() {
    if (!cfg) return [];
    const items = ensureDeptItems();
    const selectedIds = new Set(
      Object.entries(items)
        .filter(([, it]) => !!it?.enabled)
        .map(([id]) => String(id))
    );

    return (_deptCache || [])
      .filter(d => selectedIds.has(String(d.id)))
      .map(d => ({
        id: String(d.id),
        nome: cleanDeptLabel(d.nome)
      }))
      .filter(d => d.nome);
  }

  function buildMenuDepartamentosText() {
    const selected = getSelectedDepartments();
    if (!selected.length) return '1 - Comercial';
    return selected.map((d, i) => `${i + 1} - ${cleanDeptLabel(d.nome)}`).join('\n');
  }

  function buildDeptTriagemTemplate() {
    return (
`Olá! 👋
Bem-vindo(a) à {empresa}.

Para direcionar seu atendimento, escolha uma opção abaixo:

{menu_departamentos}

Digite apenas o número da opção desejada.`
    );
  }

  function renderDeptTemplate(text) {
    const empresa = _empresaNome || EMPRESA_NOME() || '[Empresa]';
    const menu = buildMenuDepartamentosText();
    return String(text || '')
      .replace(/\{empresa\}/gi, empresa)
      .replace(/\{menu_departamentos\}/gi, menu);
  }

  function expandTemplate(text) {
    let out = String(text || '');

    if (_empresaNome && _empresaNome !== '[Empresa]') {
      out = out.replace(/\{empresa\}|\[empresa\]|\[Empresa\]/gi, _empresaNome);
    }

    if (/\{setor\}|\[setor\]/i.test(out)) {
      const lista = (Array.isArray(_deptCache) && _deptCache.length)
        ? _deptCache.slice(0, 12).map((d, i) => `${i + 1} - ${cleanDeptLabel(d.nome)}`).join('\n')
        : '1 - {setor}';

      out = out.split('\n').map(
        ln => (/(\{setor\}|\[setor\])/i.test(ln) ? lista : ln)
      ).join('\n');
    }

    return out;
  }

  function buildDeptWelcomeExample() {
    return buildDeptTriagemTemplate();
  }

  function attachDeptSuggestions(textarea) {
    const wrap = document.getElementById('deptChips');
    if (!wrap || !textarea) return;

    wrap.innerHTML = '';

    const chips = [
      { label: '{empresa}', insert: '{empresa}' },
      { label: '{menu_departamentos}', insert: '{menu_departamentos}' },
      { label: '👋 Saudação', insert: 'Olá! 👋\nBem-vindo(a) à {empresa}.\n\n' },
      { label: '📋 Direcionar', insert: 'Para direcionar seu atendimento, escolha uma opção abaixo:\n\n{menu_departamentos}\n\n' },
      { label: '🔢 Instrução final', insert: 'Digite apenas o número da opção desejada.' },
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

  function ensureDeptItems() {
    cfg.features.auto_messages_departments ||= {
      enabled: false,
      welcome: { enabled: false, text: '', start: '08:00', end: '18:00' },
      items: {}
    };
    let items = cfg.features.auto_messages_departments.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      cfg.features.auto_messages_departments.items = {};
      items = cfg.features.auto_messages_departments.items;
    }
    return items;
  }

  function seedDeptItemsDefault() {
    if (!cfg) return;
    if (!Array.isArray(_deptCache) || !_deptCache.length) return;

    const items = ensureDeptItems();

    if (Object.keys(items).length === 0) {
      _deptCache.forEach(d => {
        const id = String(d.id);
        const nome = cleanDeptLabel(d.nome);
        items[id] = { enabled: true, label: nome };
      });
      return;
    }

    _deptCache.forEach(d => {
      const id = String(d.id);
      const nome = cleanDeptLabel(d.nome);
      if (!items[id]) {
        items[id] = { enabled: true, label: nome };
      } else if (!String(items[id].label || '').trim()) {
        items[id].label = nome;
      }
    });
  }

  function countSelectedDeps() {
    if (!cfg) return 0;
    const items = ensureDeptItems();
    return Object.values(items).reduce((acc, it) => acc + (it?.enabled ? 1 : 0), 0);
  }

  function setDeptPickerEnabled(enabled) {
    if (deptSearch) deptSearch.disabled = !enabled;
    if (deptAll) deptAll.disabled = !enabled;
    if (deptNone) deptNone.disabled = !enabled;

    if (deptList) {
      deptList.classList.toggle('disabled', !enabled);
      deptList.querySelectorAll('input[type="checkbox"]').forEach(ch => (ch.disabled = !enabled));
    }
  }

  function refreshDeptTemplateIfDefaultLike() {
    const current = (msgDeptWelcome?.value || '').trim();
    const isDefaultLike =
      !current ||
      current.includes('{menu_departamentos}') ||
      current.includes('Digite apenas o número da opção desejada.') ||
      current.includes('Você está falando com o setor');

    if (msgDeptWelcome && isDefaultLike) {
      msgDeptWelcome.value = buildDeptTriagemTemplate();
      if (dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
    }
  }

  function renderDeptPreview() {
    if (!prevDept || !prevDeptText) return;
    const on = getSwitch(swDeptWelcome) && getSwitch(swDeptHdr);
    prevDept.style.display = on ? '' : 'none';
    prevDeptText.textContent = renderDeptTemplate(msgDeptWelcome?.value || '');
  }

  function renderDeptPicker() {
    if (!deptList) return;
    if (!cfg) {
      deptList.innerHTML = '';
      return;
    }

    const items = ensureDeptItems();
    const q = String(deptSearch?.value || '').trim().toLowerCase();
    deptList.innerHTML = '';

    if (!Array.isArray(_deptCache) || !_deptCache.length) {
      const empty = document.createElement('div');
      empty.className = 'dept-empty';
      empty.textContent = 'Nenhum departamento encontrado. Cadastre/ative departamentos para usar o modo 2.';
      deptList.appendChild(empty);
      if (deptCount) deptCount.textContent = '0 selecionados';
      setDeptPickerEnabled(false);
      return;
    }

    const list = _deptCache
      .map(d => ({ id: String(d.id), nome: cleanDeptLabel(d.nome) }))
      .filter(d => d.nome)
      .filter(d => !q || d.nome.toLowerCase().includes(q));

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'dept-empty';
      empty.textContent = 'Nada encontrado.';
      deptList.appendChild(empty);
      if (deptCount) deptCount.textContent = `${countSelectedDeps()} selecionados`;
      return;
    }

    const enabledHdr = getSwitch(swDeptHdr);

    list.forEach(d => {
      if (!items[d.id]) items[d.id] = { enabled: true, label: d.nome };

      const row = document.createElement('label');
      row.className = 'dept-row';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!items[d.id]?.enabled;
      chk.disabled = !enabledHdr;

      chk.addEventListener('change', () => {
        items[d.id] = {
          ...(items[d.id] || {}),
          enabled: !!chk.checked,
          label: items[d.id]?.label || d.nome
        };
        if (deptCount) deptCount.textContent = `${countSelectedDeps()} selecionados`;
        refreshDeptTemplateIfDefaultLike();
        renderDeptPreview();
        updateSaveButtons();
        schedulePersist(250, { silent: false });
      });

      const name = document.createElement('span');
      name.className = 'dept-name';
      name.textContent = d.nome;

      row.appendChild(chk);
      row.appendChild(name);
      deptList.appendChild(row);
    });

    if (deptCount) deptCount.textContent = `${countSelectedDeps()} selecionados`;
    setDeptPickerEnabled(enabledHdr);
  }

  function setAccordionOpen(head, body, open) {
    head?.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.style.height = open ? 'auto' : '0px';
    body.style.opacity = open ? '1' : '0';
    body.style.pointerEvents = open ? 'auto' : 'none';
    body.setAttribute('aria-hidden', open ? 'false' : 'true');
    head?.closest('.item')?.classList.toggle('open', !!open);
  }

  function bindAccordion(head, body) {
    head?.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') === 'true';
      setAccordionOpen(head, body, !open);
    });
  }

  function updateScheduleVisibility() {
    const onA = getSwitch(swAutoHdr);
    const wOn = onA && getSwitch(swWelcome);
    const oOn = onA && getSwitch(swOff);
    schedWelcome?.classList.toggle('show', wOn);
    schedOff?.classList.toggle('show', oOn);

    const onD = getSwitch(swDeptHdr);
    const dOn = onD && getSwitch(swDeptWelcome);
    schedDeptWelcomeEl?.classList.toggle('show', dOn);
  }

  function updateModeNotices() {
    const autoOn = !!cfg?.features?.auto_messages?.enabled;
    const deptOn = !!cfg?.features?.auto_messages_departments?.enabled;

    if (autoModeNotice) autoModeNotice.hidden = !deptOn;
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

  function setDeptChildrenEnabled(enabled) {
    swDeptWelcome?.classList.toggle('disabled', !enabled);
    if (swDeptWelcome?.querySelector('input')) swDeptWelcome.querySelector('input').disabled = !enabled;
    if (msgDeptWelcome) msgDeptWelcome.disabled = !enabled || !getSwitch(swDeptWelcome);
    if (dwStart) dwStart.disabled = !enabled;
    if (dwEnd) dwEnd.disabled = !enabled;
    updateScheduleVisibility();
    setDeptPickerEnabled(!!enabled);
    renderDeptPreview();
  }

  function ensureMasters(c) {
    c.features ??= {};
    c.features.auto_messages ??= {};
    if (typeof c.features.auto_messages.enabled !== 'boolean') c.features.auto_messages.enabled = false;
    c.features.auto_messages_departments ??= {
      enabled: false,
      welcome: { enabled: false, text: '', start: '08:00', end: '18:00' },
      items: {}
    };
    c.timezone = (c.timezone || '').trim() || FALLBACK_TZ;
  }

  function syncSectionState() {
    if (!cfg?.features) return;

    cfg.features.auto_messages.enabled = !!getSwitch(swAutoHdr);
    cfg.features.auto_messages_departments.enabled = !!getSwitch(swDeptHdr);
    (cfg.features.auto_messages.welcome ||= {}).enabled = !!getSwitch(swWelcome);
    (cfg.features.auto_messages.off_hours ||= {}).enabled = !!getSwitch(swOff);
    (cfg.features.auto_messages_departments.welcome ||= {}).enabled = !!getSwitch(swDeptWelcome);

    setAutoChildrenEnabled(!!cfg.features.auto_messages.enabled);
    setDeptChildrenEnabled(!!cfg.features.auto_messages_departments.enabled);

    renderWelcomePreview();
    renderOffPreview();
    renderDeptPreview();
    updateSaveButtons();
    updateScheduleVisibility();
    updateModeNotices();
  }

  function renderWelcomePreview() {
    const on = getSwitch(swWelcome) && getSwitch(swAutoHdr);
    if (prevW) prevW.style.display = on ? '' : 'none';
    if (prevWText) prevWText.textContent = (msgWelcome?.value || '—').trim() || '—';
  }

  function renderOffPreview() {
    const on = getSwitch(swOff) && getSwitch(swAutoHdr);
    if (prevO) prevO.style.display = on ? '' : 'none';
    if (prevO) prevO.textContent = (msgOff?.value || '—').trim() || '—';
  }

  function syncCfgFromUI() {
    if (!cfg?.features) return;

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

    ensureDeptItems();
  }

  async function persistUI({ silent = true } = {}) {
    if (!cfg || __persisting) return;

    syncCfgFromUI();

    const autoOn = getSwitch(swAutoHdr);
    const deptOn = getSwitch(swDeptHdr);

    if (autoOn && !validateBeforeSave('auto')) return;
    if (deptOn && !validateBeforeSave('dept')) return;

    __persisting = true;
    updateSaveButtons();

    try {
      await putConfig(cfg);
      _lastLoadedSnapshot = JSON.stringify(cfg);
      if (!silent) toast('Configurações salvas com sucesso.');
    } catch (e) {
      // putConfig já mostra notify
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
    if (labelEl === swDeptHdr) return 'Tem certeza que deseja desligar o menu de triagem por departamento?';
    if (labelEl === swWelcome) return 'Tem certeza que deseja desligar a mensagem de boas-vindas?';
    if (labelEl === swOff) return 'Tem certeza que deseja desligar a mensagem de fora do horário?';
    if (labelEl === swDeptWelcome) return 'Tem certeza que deseja desligar a mensagem inicial da triagem?';
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
          message: 'O menu de triagem por departamento será desligado, porque os dois modos não podem ficar ativos ao mesmo tempo.',
          confirmText: 'Ativar e desligar triagem',
          cancelText: 'Cancelar',
          kind: 'warn'
        });
        if (!ok) return;

        setHeaderSwitch(swDeptHdr, pillDeptHdr, false);
        setSwitch(swDeptWelcome, false, pillDeptWelcome);
        cfg.features.auto_messages_departments.enabled = false;
        (cfg.features.auto_messages_departments.welcome ||= {}).enabled = false;
      }

      if (labelEl === swDeptHdr && newVal && getSwitch(swAutoHdr)) {
        const ok = await confirmAction({
          title: 'Ativar triagem por departamento?',
          message: 'As mensagens automáticas serão desligadas, porque os dois modos não podem ficar ativos ao mesmo tempo.',
          confirmText: 'Ativar triagem e desligar automático',
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
          message: 'Desligue primeiro o menu de triagem por departamento para ativar a mensagem de boas-vindas.',
          kind: 'warn'
        });
        return;
      }

      if (labelEl === swOff && newVal && getSwitch(swDeptHdr)) {
        notify({
          title: 'Modo incompatível',
          message: 'Desligue primeiro o menu de triagem por departamento para ativar a mensagem de fora do horário.',
          kind: 'warn'
        });
        return;
      }

      if (labelEl === swDeptWelcome && newVal && getSwitch(swAutoHdr)) {
        notify({
          title: 'Modo incompatível',
          message: 'Desligue primeiro as mensagens automáticas para ativar a triagem por departamento.',
          kind: 'warn'
        });
        return;
      }

      setSwitch(labelEl, newVal, pillEl);
      onToggle?.(newVal);

      if (!cfg?.features) return;

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
    if (saveAuto) saveAuto.disabled = __persisting;
    if (saveDept) saveDept.disabled = __persisting;
  }

  async function getConfig() {
    const url = new URL('/api/chatbot/config', location.origin);
    url.searchParams.set('empresa_id', String(EMPRESA_ID()));
    url.searchParams.set('instancia_id', requireActiveInstKey());

    const r = await authFetch(url.toString());
    if (!r.ok) throw new Error(`GET config ${r.status}`);
    const data = await r.json();

    if (data?.empresa_nome) {
      _empresaNome = String(data.empresa_nome).trim();
      try { LS.setItem('empresa_nome', _empresaNome); } catch {}
    }

    if (Array.isArray(data?.departamentos)) {
      _deptCache = data.departamentos.map(d => ({ id: d.id, nome: d.nome })).filter(Boolean);
    }

    const merged = deepMerge(structuredClone(LOCAL_DEFAULTS), data?.config || {});
    merged.timezone = (merged.timezone || '').trim() || FALLBACK_TZ;
    return merged;
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
        if (!msgWelcome?.value?.trim()) { errors.push('Mensagem de boas-vindas não pode ficar vazia.'); markInvalid(msgWelcome, true); }
        if (wStart && !timeValid(wStart.value)) { errors.push('Horário inicial da Boas-vindas inválido.'); markInvalid(wStart, true); }
        if (wEnd && !timeValid(wEnd.value)) { errors.push('Horário final da Boas-vindas inválido.'); markInvalid(wEnd, true); }
      }

      if (getSwitch(swOff)) {
        if (!msgOff?.value?.trim()) { errors.push('Mensagem de fora do horário não pode ficar vazia.'); markInvalid(msgOff, true); }
        if (oStart && !timeValid(oStart.value)) { errors.push('Horário inicial de Fora do horário inválido.'); markInvalid(oStart, true); }
        if (oEnd && !timeValid(oEnd.value)) { errors.push('Horário final de Fora do horário inválido.'); markInvalid(oEnd, true); }
      }

      if (!getSwitch(swWelcome) && !getSwitch(swOff)) {
        errors.push('Ative ao menos uma mensagem (Boas-vindas ou Fora do horário).');
      }

      const both = getSwitch(swWelcome) && getSwitch(swOff)
        && timeValid(wStart?.value || '') && timeValid(wEnd?.value || '')
        && timeValid(oStart?.value || '') && timeValid(oEnd?.value || '');

      if (both) {
        const ws = hhmmToMin(wStart.value), we = hhmmToMin(wEnd.value);
        const os = hhmmToMin(oStart.value), oe = hhmmToMin(oEnd.value);
        const ov = overlap(ws, we, os, oe);

        if (ov) {
          const [s, e] = ov;
          errors.push(`Os horários se sobrepõem entre ${m2hhmm(s)} e ${m2hhmm(e)}.`);
          markInvalid(oStart, true);
          markInvalid(wEnd, true);

          const fix = document.createElement('button');
          fix.type = 'button';
          fix.textContent = `Ajustar “Fora do horário → Início” para ${wEnd.value}`;
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
            toast('Faixa de “Fora do horário” complementada.');
          });
          errors.push('Os intervalos não são complementares (pode sobrar horário sem mensagem).');
          fixes.push(fix);
        }
      }
    }

    if (kind === 'dept' && getSwitch(swDeptHdr)) {
      if (getSwitch(swDeptWelcome)) {
        if (!msgDeptWelcome?.value?.trim()) { errors.push('Mensagem da triagem não pode ficar vazia.'); markInvalid(msgDeptWelcome, true); }
        if (dwStart && !timeValid(dwStart.value)) { errors.push('Horário inicial (departamentos) inválido.'); markInvalid(dwStart, true); }
        if (dwEnd && !timeValid(dwEnd.value)) { errors.push('Horário final (departamentos) inválido.'); markInvalid(dwEnd, true); }
      } else {
        errors.push('Ative a mensagem de triagem para salvar este bloco.');
      }

      if (Array.isArray(_deptCache) && _deptCache.length) {
        if (countSelectedDeps() <= 0) {
          errors.push('Selecione ao menos 1 departamento para a triagem.');
        }
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

  function maybeFillDeptWelcome() {
    if (!msgDeptWelcome) return;

    const v = (msgDeptWelcome.value || '').trim();
    if (
      !v ||
      /\{empresa\}/i.test(v) ||
      /\{menu_departamentos\}/i.test(v) ||
      v.includes('Você está falando com o setor')
    ) {
      msgDeptWelcome.value = buildDeptTriagemTemplate();
    }

    if (dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
    renderDeptPreview();
  }

  async function loadAll() {
    cfg = await getConfig();
    ensureMasters(cfg);

    seedDeptItemsDefault();
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

    const dw = cfg.features.auto_messages_departments.welcome || {};
    setSwitch(swDeptWelcome, !!dw.enabled, pillDeptWelcome);
    if (msgDeptWelcome) {
      msgDeptWelcome.value = (dw.text ?? '').trim() || buildDeptWelcomeExample();
      if (dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
    }
    maybeFillDeptWelcome();

    if (dwStart) dwStart.value = dw.start ?? '08:00';
    if (dwEnd) dwEnd.value = dw.end ?? '18:00';

    attachDeptSuggestions(msgDeptWelcome);
    renderDeptPicker();
    syncSectionState();
  }

  async function saveAutoBlock() {
    await persistUI({ silent: false });
  }

  async function saveDeptBlock() {
    await persistUI({ silent: false });
  }

  function restoreSnapshot(showToast = true) {
    try {
      if (!_lastLoadedSnapshot) return;

      cfg = JSON.parse(_lastLoadedSnapshot);
      ensureMasters(cfg);

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

      const dw = cfg.features.auto_messages_departments.welcome || {};
      setSwitch(swDeptWelcome, !!dw.enabled, pillDeptWelcome);
      if (msgDeptWelcome) {
        msgDeptWelcome.value = (dw.text ?? '').trim() || buildDeptWelcomeExample();
        if (dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
      }
      maybeFillDeptWelcome();

      if (dwStart) dwStart.value = dw.start ?? '08:00';
      if (dwEnd) dwEnd.value = dw.end ?? '18:00';

      renderDeptPicker();
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

      if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0])?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1])?.focus(); }
      if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
      if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }

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
      instList.querySelectorAll('.inst-item').forEach(b => b.setAttribute('aria-selected', b.dataset.value === String(value) ? 'true' : 'false'));
      const active = instList.querySelector(`.inst-item[data-value="${CSS.escape(value)}"]`);
      if (active) instMenu.setAttribute('aria-activedescendant', active.id || (active.id = 'inst-opt-chat-' + String(value || 'x')));
      if (instLabel) instLabel.textContent = text || (value ? `Instância ${value}` : 'Selecione uma instância');
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
          const r = await authFetch(`/api/empresas/${empresaId}/whatsapp`, { credentials: 'include' });
          if (!r.ok) throw 0;
          const j = await r.json();
          items = Array.isArray(j.instancias) ? j.instancias : [];
        } catch {
          try {
            const r2 = await authFetch(`/api/instancias/list?empresa_id=${empresaId}`, { credentials: 'include' });
            const j2 = await r2.json();
            items = Array.isArray(j2) ? j2 : (Array.isArray(j2?.instancias) ? j2.instancias : []);
          } catch {}
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

  async function boot() {
    try {
      bindAccordion(headAuto, bodyAuto);
      bindAccordion(headAutoDept, bodyAutoDept);

      bindSwitch(swAutoHdr, pillAutoHdr, (on) => {
        if (cfg?.features) cfg.features.auto_messages.enabled = on;
        syncSectionState();
      });

      bindSwitch(swDeptHdr, pillDeptHdr, (on) => {
        if (cfg?.features) cfg.features.auto_messages_departments.enabled = on;
        syncSectionState();
      });

      bindSwitch(swWelcome, pillWelcome, (on) => {
        if (cfg) (cfg.features.auto_messages.welcome ||= {}).enabled = on;
        if (on && !getSwitch(swAutoHdr)) {
          setHeaderSwitch(swAutoHdr, pillAutoHdr, true);
          cfg.features.auto_messages.enabled = true;
        }
        syncSectionState();
      });

      bindSwitch(swOff, pillOff, (on) => {
        if (cfg) (cfg.features.auto_messages.off_hours ||= {}).enabled = on;
        if (on && !getSwitch(swAutoHdr)) {
          setHeaderSwitch(swAutoHdr, pillAutoHdr, true);
          cfg.features.auto_messages.enabled = true;
        }
        syncSectionState();
      });

      bindSwitch(swDeptWelcome, pillDeptWelcome, (on) => {
        if (cfg) (cfg.features.auto_messages_departments.welcome ||= {}).enabled = on;
        if (on && !getSwitch(swDeptHdr)) {
          setHeaderSwitch(swDeptHdr, pillDeptHdr, true);
          cfg.features.auto_messages_departments.enabled = true;
        }
        syncSectionState();
      });

      msgWelcome?.addEventListener('input', () => {
        msgWelcome.value = expandTemplate(msgWelcome.value);
        if (wcCount) wcCount.textContent = `${msgWelcome.value.length} caracteres`;
        renderWelcomePreview();
        schedulePersist(700);
      });

      msgWelcome?.addEventListener('blur', () => persistUI({ silent: false }));

      wStart?.addEventListener('change', () => {
        if (cfg?.features?.auto_messages?.welcome) cfg.features.auto_messages.welcome.start = wStart.value;
        schedulePersist(200, { silent: false });
      });

      wEnd?.addEventListener('change', () => {
        if (cfg?.features?.auto_messages?.welcome) cfg.features.auto_messages.welcome.end = wEnd.value;
        schedulePersist(200, { silent: false });
      });

      msgOff?.addEventListener('input', () => {
        if (offCount) offCount.textContent = `${msgOff.value.length} caracteres`;
        renderOffPreview();
        schedulePersist(700);
      });

      msgOff?.addEventListener('blur', () => persistUI({ silent: false }));

      oStart?.addEventListener('change', () => {
        if (cfg?.features?.auto_messages?.off_hours) cfg.features.auto_messages.off_hours.start = oStart.value;
        schedulePersist(200, { silent: false });
      });

      oEnd?.addEventListener('change', () => {
        if (cfg?.features?.auto_messages?.off_hours) cfg.features.auto_messages.off_hours.end = oEnd.value;
        schedulePersist(200, { silent: false });
      });

      msgDeptWelcome?.addEventListener('input', () => {
        if (dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
        renderDeptPreview();
        schedulePersist(700);
      });

      msgDeptWelcome?.addEventListener('blur', () => persistUI({ silent: false }));

      deptSearch?.addEventListener('input', () => renderDeptPicker());

      deptAll?.addEventListener('click', () => {
        if (!cfg) return;
        const items = ensureDeptItems();
        (_deptCache || []).forEach(d => {
          const id = String(d.id);
          const nome = cleanDeptLabel(d.nome);
          items[id] = { ...(items[id] || {}), enabled: true, label: items[id]?.label || nome };
        });
        renderDeptPicker();
        if (msgDeptWelcome) {
          msgDeptWelcome.value = buildDeptTriagemTemplate();
          if (dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
        }
        renderDeptPreview();
        updateSaveButtons();
        schedulePersist(250, { silent: false });
      });

      deptNone?.addEventListener('click', () => {
        if (!cfg) return;
        const items = ensureDeptItems();
        (_deptCache || []).forEach(d => {
          const id = String(d.id);
          const nome = cleanDeptLabel(d.nome);
          items[id] = { ...(items[id] || {}), enabled: false, label: items[id]?.label || nome };
        });
        renderDeptPicker();
        if (msgDeptWelcome) {
          msgDeptWelcome.value = buildDeptTriagemTemplate();
          if (dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
        }
        renderDeptPreview();
        updateSaveButtons();
        schedulePersist(250, { silent: false });
      });

      dwStart?.addEventListener('change', () => {
        if (cfg?.features?.auto_messages_departments?.welcome) cfg.features.auto_messages_departments.welcome.start = dwStart.value;
        schedulePersist(200, { silent: false });
      });

      dwEnd?.addEventListener('change', () => {
        if (cfg?.features?.auto_messages_departments?.welcome) cfg.features.auto_messages_departments.welcome.end = dwEnd.value;
        schedulePersist(200, { silent: false });
      });

      saveAuto?.addEventListener('click', saveAutoBlock);
      saveDept?.addEventListener('click', saveDeptBlock);
      cancelAuto?.addEventListener('click', () => restoreSnapshot(true));
      cancelDept?.addEventListener('click', () => restoreSnapshot(true));

      await initInstDropdown();

      const key = getActiveInstKey();
      if (!key) {
        lockUI(true, 'Selecione uma instância para configurar o chatbot.');
        return;
      }

      lockUI(false);
      await loadAll();
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