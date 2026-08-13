// /frontend/js/atendimentos/ui/inst-switch.js

/* =========================================================
   Instância (central + badge “bolinha + nome”)
   - NÃO depende de import
   - usa localStorage (empresa_id) + lista window.INSTANCIAS
   - Modelo 2:
     Colaborador só enxerga no seletor as instâncias permitidas.
========================================================= */
(function () {
  const EMPRESA_ID_LOCAL = Number(localStorage.getItem('empresa_id') || 0);

  const LS_KEY_INST  = `instAtiva:${String(EMPRESA_ID_LOCAL || '')}`;
  const LS_KEY_LABEL = `instAtivaLabel:${String(EMPRESA_ID_LOCAL || '')}`;

  function norm(v) {
    const s = (v == null ? '' : String(v)).trim();
    return s === '' ? '' : s;
  }

  function getInstanciasList() {
    return (
      window.ZC_INSTANCIAS ||
      window.INSTANCIAS ||
      window.state?.instancias ||
      []
    );
  }

  function pickLabelFromItem(i, fallbackRaw) {
    if (!i) return fallbackRaw;

    const cand =
      i.apelido ||
      i.nome_exibicao ||
      i.display_name ||
      i.nome ||
      i.name ||
      i.titulo ||
      i.title ||
      null;

    if (cand && String(cand).trim()) return String(cand).trim();

    const tel = i.telefone || i.numero || i.phone || i.whatsapp || null;
    if (tel) {
      const d = String(tel).replace(/\D+/g, '');
      if (d.length >= 8) return `WhatsApp • ${d.slice(-4)}`;
    }

    const raw2 = i.instance_name || i.instancia || i.slug || null;
    if (raw2 && String(raw2).trim()) return String(raw2).trim();

    return fallbackRaw;
  }

  function resolveInstLabel(val) {
    const raw = norm(val);
    if (!raw) {
      return window.__ZC_SEM_INSTANCIAS_PERMITIDAS__
        ? 'Nenhum WhatsApp liberado'
        : 'Todos os WhatsApps';
    }

    try {
      const savedLabel = localStorage.getItem(LS_KEY_LABEL);
      const savedInst  = localStorage.getItem(LS_KEY_INST);
      if (savedLabel && savedInst && String(savedInst) === raw) return savedLabel;
    } catch {}

    const list = getInstanciasList();

    const byId = (x) => String(x?.instancia_id ?? x?.id ?? x?.instance_id ?? '') === raw;
    const bySlug = (x) => String(x?.instance_name ?? x?.instancia ?? '').toLowerCase() === raw.toLowerCase();

    const it = list.find(byId) || list.find(bySlug);
    const label = pickLabelFromItem(it, raw);

    if (/^wa\.\d+$/i.test(label)) {
      const n = label.split('.').pop();
      return `WhatsApp ${n}`;
    }

    return label;
  }

  function ensureInstBadge() {
    const head = document.getElementById('chat-header');
    if (!head) return null;

    let el = document.getElementById('inst-badge');
    if (el) {
      const title = document.getElementById('chat-title');
      const row = title?.parentNode;
      const participants = document.getElementById('zc-chat-participants');
      if (row && el.parentElement === row && participants?.parentElement === row && el.nextElementSibling !== participants) {
        row.insertBefore(el, participants);
      }
      return el;
    }

    el = document.createElement('div');
    el.id = 'inst-badge';
    el.className = 'inst-badge';
    el.innerHTML = `<span class="dot"></span><span id="inst-badge-text">WhatsApp: —</span>`;

    const title = document.getElementById('chat-title');
    if (title && title.parentNode) {
      const row = title.parentNode;
      const participants = document.getElementById('zc-chat-participants');
      if (participants && participants.parentElement === row) row.insertBefore(el, participants);
      else row.appendChild(el);
    } else head.appendChild(el);

    return el;
  }

  function zcUpdateInstBadge() {
    const el = ensureInstBadge();
    if (!el) return;

    const c = window.state?.clienteSel || {};

    const v = norm(
      c.instancia_id ??
      c.instancia ??
      window.INSTANCIA_ATIVA ??
      (function () {
        try { return localStorage.getItem(LS_KEY_INST); } catch { return ''; }
      })()
    );

    const txt = document.getElementById('inst-badge-text');
    if (txt) txt.textContent = `WhatsApp: ${resolveInstLabel(v)}`;

    el.classList.toggle('is-none', !v);
  }

  function zcFlashInstBadge() {
    try {
      const b = ensureInstBadge();
      if (!b) return;

      b.classList.add('shake');
      setTimeout(() => b.classList.remove('shake'), 420);
    } catch {}
  }

  function setInstanciaAtiva(value, opt = {}) {
    const v = norm(value);

    window.INSTANCIA_ATIVA = v ? v : null;

    try {
      localStorage.setItem(LS_KEY_INST, v);
    } catch {}

    try {
      window.setInstanceChip?.(v);
    } catch {}

    try {
      zcUpdateInstBadge();
    } catch {}

    try {
      document.dispatchEvent(new CustomEvent('inst:change', {
        detail: {
          value: window.INSTANCIA_ATIVA
        }
      }));
    } catch {}

    if (opt && opt.reloadList) {
      try {
        window.carregarClientes?.({
          force: true,
          reason: 'inst:change'
        });
      } catch {}
    }
  }

  function getInstanciaAtiva() {
    return norm(
      window.INSTANCIA_ATIVA ??
      (function () {
        try { return localStorage.getItem(LS_KEY_INST); } catch { return ''; }
      })()
    );
  }

  window.zcResolveInstLabel = resolveInstLabel;
  window.zcUpdateInstBadge  = zcUpdateInstBadge;
  window.zcFlashInstBadge   = zcFlashInstBadge;
  window.setInstanciaAtiva  = setInstanciaAtiva;
  window.getInstanciaAtiva  = getInstanciaAtiva;

  document.addEventListener('inst:change', () => {
    try { zcUpdateInstBadge(); } catch {}
  });

  document.addEventListener('inst:list', () => {
    try { zcUpdateInstBadge(); } catch {}
  });

  setTimeout(() => {
    try { zcUpdateInstBadge(); } catch {}
  }, 0);
})();

/* =========================================================
   Switch (pílulas)
   - Busca todas as instâncias da empresa
   - Se for admin/usuário master: mostra todas
   - Se for colaborador: valida cada instância no backend
   - NÃO usa cache de permissão
   - Limpa instância antiga salva quando login é colaborador
========================================================= */
(function () {
  const wrap = document.getElementById('inst-switch');
  if (!wrap) return;

  const EMPRESA_ID = Number(localStorage.getItem('empresa_id') || 0);

  const KEY_VAL   = (id) => `instAtiva:${id}`;
  const KEY_LABEL = (id) => `instAtivaLabel:${id}`;
  const KEY_MAP   = (id, val) => `instLabel:${id}:${val}`;

  function norm(v) {
    const s = (v == null ? '' : String(v)).trim();
    return s === '' ? '' : s;
  }

  function parseJSONSafe(raw) {
    try {
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function parseJwt(token) {
    try {
      const p = String(token || '').split('.')[1];
      if (!p) return {};
      return JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      return {};
    }
  }

  function getToken() {
    return (
      localStorage.getItem('access_token') ||
      localStorage.getItem('token') ||
      sessionStorage.getItem('access_token') ||
      sessionStorage.getItem('token') ||
      ''
    );
  }

  function getIdentity() {
    const jwt = parseJwt(getToken());

    const storageCandidates = [
      localStorage.getItem('usuario'),
      localStorage.getItem('user'),
      localStorage.getItem('identity'),
      localStorage.getItem('current_user'),
      sessionStorage.getItem('usuario'),
      sessionStorage.getItem('user'),
      sessionStorage.getItem('identity'),
      sessionStorage.getItem('current_user')
    ]
      .map(parseJSONSafe)
      .filter(Boolean);

    return Object.assign({}, ...storageCandidates, jwt);
  }

  function getColaboradorId(identity) {
    const keys = [
      'id_colab',
      'colaborador_id',
      'id_colaborador',
      'colab_id',
      'cid'
    ];

    for (const k of keys) {
      const n = Number(identity?.[k]);
      if (Number.isFinite(n) && n > 0) return n;
    }

    const sub = String(identity?.sub || '').trim().toLowerCase();

    if (sub.startsWith('colab-')) {
      const n = Number(sub.split('-', 2)[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }

    if (String(identity?.kind || identity?.tipo || '').toLowerCase() === 'colaborador') {
      const n = Number(identity?.id);
      if (Number.isFinite(n) && n > 0) return n;
    }

    return null;
  }

  function isAdminIdentity(identity) {
    if (!identity || typeof identity !== 'object') return false;

    if (identity.is_admin === true || identity.admin === true) return true;

    const kind = String(identity.kind || identity.tipo || '').trim().toLowerCase();
    if (kind === 'usuario') return true;

    const role = String(identity.role || '').trim().toLowerCase();
    if (
      role === 'admin' ||
      role === 'administrador' ||
      role === 'owner' ||
      role === 'dono' ||
      role === 'root'
    ) {
      return true;
    }

    const sub = String(identity.sub || '').trim().toLowerCase();

    if (sub && !sub.startsWith('colab-') && Number.isFinite(Number(sub))) {
      return true;
    }

    return false;
  }

  function isColaboradorIdentity(identity) {
    if (!identity || typeof identity !== 'object') return false;

    if (isAdminIdentity(identity)) return false;

    const kind = String(identity.kind || identity.tipo || '').trim().toLowerCase();

    if (kind === 'colaborador') return true;

    if (getColaboradorId(identity)) return true;

    const sub = String(identity.sub || '').trim().toLowerCase();
    if (sub.startsWith('colab-')) return true;

    return false;
  }

  const identityAtBoot = getIdentity();
  const isColaboradorAtBoot = isColaboradorIdentity(identityAtBoot);

  let LAST = localStorage.getItem(KEY_VAL(EMPRESA_ID)) || '';

  /*
   * Importante:
   * Se ficou salva uma instância antiga no navegador, o boot pode tentar
   * carregar conversas dela antes do seletor terminar de filtrar.
   *
   * Para colaborador, limpamos a seleção antiga já no começo.
   * O seletor vai escolher uma permitida depois:
   * - se tiver uma só, seleciona automaticamente
   * - se tiver várias, deixa em "Todos permitidos"
   */
  if (isColaboradorAtBoot) {
    try {
      localStorage.setItem(KEY_VAL(EMPRESA_ID), '');
      localStorage.removeItem(KEY_LABEL(EMPRESA_ID));
    } catch {}

    LAST = '';
    window.INSTANCIA_ATIVA = null;

    try {
      document.dispatchEvent(new CustomEvent('inst:change', {
        detail: {
          value: null,
          reason: 'clear-old-saved-instance-for-colaborador'
        }
      }));
    } catch {}
  }

  function getInstValue(i) {
    return norm(
      i?.instancia_id ??
      i?.instancia ??
      i?.instance_id ??
      i?.session ??
      i?.sessao ??
      i?.id ??
      i?.instance_name ??
      ''
    );
  }

  function getInstNumericId(i) {
    const n = Number(
      i?.instancia_id ??
      i?.id ??
      i?.instance_id ??
      i?.whatsapp_id ??
      ''
    );

    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function getInstLabel(i, value) {
    return String(
      i?.apelido ||
      i?.nome_exibicao ||
      i?.display_name ||
      i?.nome ||
      i?.name ||
      i?.instance_name ||
      value ||
      'Instância'
    ).trim();
  }

  function uniqueInstances(list) {
    const out = [];
    const seen = new Set();

    (Array.isArray(list) ? list : []).forEach(i => {
      const value = getInstValue(i);
      if (!value) return;

      const key = String(value);
      if (seen.has(key)) return;

      seen.add(key);
      out.push(i);
    });

    return out;
  }

  async function backendAllowsInstance(instanciaId) {
    if (!EMPRESA_ID || !instanciaId) return false;

    // Esta rota aplica o ACL da instância antes de devolver o perfil.
    // Não usamos /conversas para testar permissão porque essa rota pode
    // responder 200 com lista vazia quando o colaborador não tem acesso.
    const url =
      `/api/atendimento/instancias/${encodeURIComponent(instanciaId)}/perfil` +
      `?empresa_id=${encodeURIComponent(EMPRESA_ID)}` +
      `&refresh=0` +
      `&__inst_acl_ts=${Date.now()}`;

    try {
      const r = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache'
        }
      });

      if (r.status === 401 || r.status === 403 || r.status === 404) return false;
      return r.ok;
    } catch {
      return false;
    }
  }

  async function filterInstancesByPermission(rawList) {
    const list = uniqueInstances(rawList);
    const identity = getIdentity();

    const isColaborador = isColaboradorIdentity(identity);

    if (!isColaborador) {
      return {
        list,
        identity,
        isColaborador: false,
        filtered: false
      };
    }

    const allowed = [];

    for (const inst of list) {
      const id = getInstNumericId(inst);

      if (!id) continue;

      const ok = await backendAllowsInstance(id);

      if (ok) {
        allowed.push(inst);
      }
    }

    return {
      list: allowed,
      identity,
      isColaborador: true,
      filtered: true
    };
  }

  function markActive(val) {
    wrap.querySelectorAll('.inst-pill').forEach(b => {
      const isActive = (b.dataset.value || '') === (val || '');

      b.classList.toggle('is-active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      b.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  window.setInstanceChip = function (val) {
    markActive(String(val ?? ''));
  };

  function applyInstance(value) {
    window.setInstanciaAtiva?.(value === '' ? null : String(value), {
      reloadList: true
    });

    markActive(value || '');

    try {
      window.zcUpdateInstBadge?.();
    } catch {}
  }

  function saveSelection(value, label) {
    const v = String(value || '');
    const lab = String(label || '').trim();

    localStorage.setItem(KEY_VAL(EMPRESA_ID), v);

    if (v) {
      if (lab) {
        localStorage.setItem(KEY_LABEL(EMPRESA_ID), lab);
        localStorage.setItem(KEY_MAP(EMPRESA_ID, v), lab);
      }
    } else {
      localStorage.removeItem(KEY_LABEL(EMPRESA_ID));
    }

    LAST = v;
  }

  function onPick(value, label) {
    saveSelection(value, label);
    applyInstance(value || '');
  }

  function pill({ label, value, active, muted }) {
    const b = document.createElement('button');

    b.type = 'button';
    b.className = 'inst-pill' + (active ? ' is-active' : '') + (muted ? ' is-muted' : '');
    b.textContent = label;
    b.title = `Selecionar ${label}`;

    b.dataset.value = String(value ?? '');
    b.dataset.label = String(label ?? '');
    b.dataset.instanciaId = String(value ?? '');

    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    b.setAttribute('aria-selected', active ? 'true' : 'false');

    b.onclick = () => onPick(String(value ?? ''), String(label ?? ''));

    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        b.click();
      }
    });

    return b;
  }

  function renderEmpty(message) {
    wrap.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'inst-section-label';
    label.innerHTML = `
      <span class="dot"></span>
      <span>WhatsApps</span>
      <span class="inst-section-count"> (0)</span>
    `;
    wrap.appendChild(label);

    const empty = document.createElement('div');
    empty.className = 'inst-empty';
    empty.textContent = message || 'Nenhum WhatsApp liberado para este colaborador.';
    empty.style.cssText = 'font-size:.85rem;opacity:.75;padding:.35rem .5rem;';
    wrap.appendChild(empty);

    window.state = window.state || {};
    window.state.instancias = [];
    window.INSTANCIAS = [];
    window.ZC_INSTANCIAS = [];

    try {
      localStorage.removeItem(KEY_LABEL(EMPRESA_ID));
      localStorage.setItem(KEY_VAL(EMPRESA_ID), '');
    } catch {}

    LAST = '';
    applyInstance('');
  }

  function normalizeLastForList(list, isColaborador) {
    const values = new Set(
      (list || [])
        .map(i => String(getInstValue(i)))
        .filter(Boolean)
    );

    if (LAST && !values.has(String(LAST))) {
      LAST = '';

      try {
        localStorage.setItem(KEY_VAL(EMPRESA_ID), '');
        localStorage.removeItem(KEY_LABEL(EMPRESA_ID));
      } catch {}
    }

    if (isColaborador && list.length === 1) {
      const only = list[0];
      const value = getInstValue(only);
      const label = getInstLabel(only, value);

      LAST = String(value || '');

      try {
        localStorage.setItem(KEY_VAL(EMPRESA_ID), LAST);
        localStorage.setItem(KEY_LABEL(EMPRESA_ID), label);
        localStorage.setItem(KEY_MAP(EMPRESA_ID, LAST), label);
      } catch {}
    }
  }

  function renderFiltered(list, meta) {
    const isColaborador = !!meta?.isColaborador;

    wrap.innerHTML = '';

    normalizeLastForList(list, isColaborador);

    const label = document.createElement('div');
    label.className = 'inst-section-label';
    label.innerHTML = `
      <span class="dot"></span>
      <span>WhatsApps</span>
      <span class="inst-section-count"> (${list.length || 0})</span>
    `;
    wrap.appendChild(label);

    if (!list.length) {
      window.__ZC_SEM_INSTANCIAS_PERMITIDAS__ = isColaborador;

      return renderEmpty(
        isColaborador
          ? 'Nenhum WhatsApp liberado para este colaborador.'
          : 'Nenhum WhatsApp disponível para esta empresa.'
      );
    }

    window.__ZC_SEM_INSTANCIAS_PERMITIDAS__ = false;

    const showTodos = !isColaborador || list.length > 1;

    if (showTodos) {
      wrap.appendChild(pill({
        label: isColaborador ? 'Todos permitidos' : 'Todos',
        value: '',
        active: !LAST,
        muted: isColaborador
      }));
    }

    (list || []).forEach(i => {
      const value = getInstValue(i);
      const labelTxt = getInstLabel(i, value);

      if (!value) return;

      wrap.appendChild(pill({
        label: labelTxt,
        value: String(value),
        active: String(LAST) === String(value)
      }));
    });

    window.state = window.state || {};
    window.state.instancias = list;
    window.INSTANCIAS = list;
    window.ZC_INSTANCIAS = list;

    try {
      document.dispatchEvent(new CustomEvent('inst:list', {
        detail: {
          instancias: list,
          filtrado_por_permissao: isColaborador
        }
      }));
    } catch {}

    const cachedLabel =
      localStorage.getItem(KEY_MAP(EMPRESA_ID, LAST)) ||
      localStorage.getItem(KEY_LABEL(EMPRESA_ID)) ||
      '';

    if (LAST && cachedLabel) {
      saveSelection(LAST, cachedLabel);
    }

    applyInstance(LAST || '');
  }

  function renderLoading() {
    wrap.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'inst-section-label';
    label.innerHTML = `
      <span class="dot"></span>
      <span>WhatsApps</span>
      <span class="inst-section-count"> (...)</span>
    `;
    wrap.appendChild(label);

    const loading = document.createElement('div');
    loading.className = 'inst-empty inst-loading-state';
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-live', 'polite');
    loading.innerHTML = `
      <span class="inst-loading-spinner" aria-hidden="true"></span>
      <span>Carregando WhatsApps...</span>
    `;
    wrap.appendChild(loading);
  }

  async function render(rawList) {
    renderLoading();

    const result = await filterInstancesByPermission(rawList);

    renderFiltered(result.list, result);
  }

  async function boot() {
    if (!EMPRESA_ID) {
      return render([]);
    }

    try {
      const r = await fetch(`/api/empresas/${EMPRESA_ID}/whatsapp?__ts=${Date.now()}`, {
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache'
        }
      });

      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const j = await r.json();

      const list = Array.isArray(j?.instancias)
        ? j.instancias
        : (Array.isArray(j) ? j : []);

      await render(list);
    } catch (e) {
      console.warn('[inst-switch] falha ao carregar instâncias', e);
      await render([]);
    }
  }

  boot();
})();