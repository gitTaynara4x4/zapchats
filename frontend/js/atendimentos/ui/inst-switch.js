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
    if (!raw) return 'Todos os WhatsApps';

    // 1) label persistida (rápido)
    try {
      const savedLabel = localStorage.getItem(LS_KEY_LABEL);
      const savedInst  = localStorage.getItem(LS_KEY_INST);
      if (savedLabel && savedInst && String(savedInst) === raw) return savedLabel;
    } catch {}

    // 2) procurar na lista
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
    if (el) return el;

    el = document.createElement('div');
    el.id = 'inst-badge';
    el.className = 'inst-badge';
    el.innerHTML = `<span class="dot"></span><span id="inst-badge-text">WhatsApp: —</span>`;

    const title = document.getElementById('chat-title');
    if (title && title.parentNode) title.parentNode.appendChild(el);
    else head.appendChild(el);

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
      (function(){ try { return localStorage.getItem(LS_KEY_INST) } catch { return '' } })()
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

  // ✅ Função central (envio.js e init.js usam)
  function setInstanciaAtiva(value, opt = {}) {
    const v = norm(value);
    window.INSTANCIA_ATIVA = v ? v : null;

    try { localStorage.setItem(LS_KEY_INST, v); } catch {}

    try { window.setInstanceChip?.(v); } catch {}

    try { zcUpdateInstBadge(); } catch {}

    try {
      document.dispatchEvent(new CustomEvent('inst:change', {
        detail: { value: window.INSTANCIA_ATIVA }
      }));
    } catch {}

    if (opt && opt.reloadList) {
      try { window.carregarClientes?.({ force: true, reason: 'inst:change' }); } catch {}
    }
  }

  function getInstanciaAtiva() {
    return norm(
      window.INSTANCIA_ATIVA ??
      (function(){ try { return localStorage.getItem(LS_KEY_INST) } catch { return '' } })()
    );
  }

  window.zcResolveInstLabel = resolveInstLabel;
  window.zcUpdateInstBadge  = zcUpdateInstBadge;
  window.zcFlashInstBadge   = zcFlashInstBadge;
  window.setInstanciaAtiva  = setInstanciaAtiva;
  window.getInstanciaAtiva  = getInstanciaAtiva;

  document.addEventListener('inst:change', () => { try { zcUpdateInstBadge(); } catch {} });
  document.addEventListener('inst:list',   () => { try { zcUpdateInstBadge(); } catch {} });

  setTimeout(() => { try { zcUpdateInstBadge(); } catch {} }, 0);
})();

/* =========================================================
   Switch (pílulas) — filtra instâncias permitidas
========================================================= */
(function () {
  const wrap = document.getElementById('inst-switch');
  if (!wrap) return;

  const EMPRESA_ID = Number(localStorage.getItem('empresa_id') || 0);

  const KEY_VAL   = (id) => `instAtiva:${id}`;
  const KEY_LABEL = (id) => `instAtivaLabel:${id}`;
  const KEY_MAP   = (id, val) => `instLabel:${id}:${val}`;

  let LAST = localStorage.getItem(KEY_VAL(EMPRESA_ID)) || '';

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
      sessionStorage.getItem('current_user'),
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
      'cid',
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

    const role = String(identity.role || identity.cargo || '').trim().toLowerCase();
    if (role === 'admin' || role === 'administrador' || role === 'owner' || role === 'dono') {
      return true;
    }

    const sub = String(identity.sub || '').trim().toLowerCase();
    if (sub && !sub.startsWith('colab-') && Number.isFinite(Number(sub))) {
      return true;
    }

    const perms = identity.permissoes || identity.permissions || [];
    const arr = Array.isArray(perms)
      ? perms
      : Object.keys(perms || {}).filter(k => perms[k]);

    const set = new Set(arr.map(x => String(x).toLowerCase()));

    return (
      set.has('admin') ||
      set.has('root') ||
      set.has('atendimento.gerenciar') ||
      set.has('colaboradores.gerenciar')
    );
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

  function normalizeIdList(raw) {
    if (raw == null) return null;

    if (Array.isArray(raw)) {
      const out = raw
        .map(x => {
          if (x && typeof x === 'object') {
            return Number(
              x.id ??
              x.instancia_id ??
              x.instance_id ??
              x.value ??
              x.whatsapp_id
            );
          }

          return Number(x);
        })
        .filter(n => Number.isFinite(n) && n > 0);

      return out.length ? Array.from(new Set(out)) : [];
    }

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return [];

      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) return normalizeIdList(arr);
      } catch {}

      const out = trimmed
        .split(',')
        .map(x => Number(String(x).trim()))
        .filter(n => Number.isFinite(n) && n > 0);

      return out.length ? Array.from(new Set(out)) : [];
    }

    if (typeof raw === 'object') {
      return normalizeIdList(Object.values(raw).filter(Boolean));
    }

    return null;
  }

  function getAllowedIdsFromIdentity(identity) {
    const keys = [
      'instancias_ver',
      'instancias_ids',
      'instancia_ids',
      'instances_ids',
      'whatsapp_instancias_ids',
      'whatsapp_ids',
      'whatsapps_ids',
      'instancias',
      'instances',
    ];

    for (const key of keys) {
      const ids = normalizeIdList(identity?.[key]);
      if (Array.isArray(ids)) return ids;
    }

    const storageKeys = [
      'instancias_ver',
      'instancias_ids',
      'whatsapp_instancias_ids',
      'whatsapp_ids',
      `instancias_ver:${EMPRESA_ID}`,
      `instancias_ids:${EMPRESA_ID}`,
    ];

    for (const key of storageKeys) {
      const ids = normalizeIdList(localStorage.getItem(key));
      if (Array.isArray(ids)) return ids;
    }

    return null;
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

    const url = `/api/atendimento/conversas?empresa_id=${encodeURIComponent(EMPRESA_ID)}&limit=1&instancia_id=${encodeURIComponent(instanciaId)}`;

    try {
      const r = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });

      if (r.status === 403 || r.status === 401) return false;
      if (r.ok) return true;

      // Se a rota responder outro erro não relacionado à permissão,
      // não libera para evitar mostrar instância indevida.
      return false;
    } catch {
      return false;
    }
  }

  function cacheKeyForProbe(identity, list) {
    const colabId = getColaboradorId(identity) || 'user';
    const ids = uniqueInstances(list)
      .map(i => getInstNumericId(i) || getInstValue(i))
      .join(',');

    return `instSwitchAllowedProbe:${EMPRESA_ID}:${colabId}:${ids}`;
  }

  function readProbeCache(identity, list) {
    try {
      const key = cacheKeyForProbe(identity, list);
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.ids)) return null;

      const ts = Number(parsed.ts || 0);
      const age = Date.now() - ts;

      // 5 minutos
      if (age > 5 * 60 * 1000) return null;

      return parsed.ids.map(Number).filter(n => Number.isFinite(n) && n > 0);
    } catch {
      return null;
    }
  }

  function writeProbeCache(identity, list, ids) {
    try {
      const key = cacheKeyForProbe(identity, list);
      sessionStorage.setItem(key, JSON.stringify({
        ts: Date.now(),
        ids: Array.from(new Set((ids || []).map(Number).filter(n => Number.isFinite(n) && n > 0))),
      }));
    } catch {}
  }

  async function filterInstancesByPermission(rawList) {
    const list = uniqueInstances(rawList);
    const identity = getIdentity();

    // Admin/usuário master vê todas.
    if (!isColaboradorIdentity(identity)) {
      return {
        list,
        identity,
        isColaborador: false,
        filtered: false,
      };
    }

    // Primeiro tenta usar lista explícita do token/localStorage.
    const explicitAllowedIds = getAllowedIdsFromIdentity(identity);

    if (Array.isArray(explicitAllowedIds)) {
      const allowedSet = new Set(explicitAllowedIds.map(Number));

      const filtered = list.filter(i => {
        const id = getInstNumericId(i);
        if (!id) return false;
        return allowedSet.has(Number(id));
      });

      return {
        list: filtered,
        identity,
        isColaborador: true,
        filtered: true,
      };
    }

    // Se o token não trouxe instancias_ver, usa o backend como fonte da verdade:
    // testa a listagem com instancia_id. Se der 200, mostra. Se der 403, esconde.
    const cachedIds = readProbeCache(identity, list);

    if (Array.isArray(cachedIds)) {
      const allowedSet = new Set(cachedIds.map(Number));

      return {
        list: list.filter(i => {
          const id = getInstNumericId(i);
          return id && allowedSet.has(Number(id));
        }),
        identity,
        isColaborador: true,
        filtered: true,
      };
    }

    const allowedIds = [];

    for (const inst of list) {
      const id = getInstNumericId(inst);

      if (!id) continue;

      const ok = await backendAllowsInstance(id);

      if (ok) allowedIds.push(Number(id));
    }

    writeProbeCache(identity, list, allowedIds);

    const allowedSet = new Set(allowedIds.map(Number));

    return {
      list: list.filter(i => {
        const id = getInstNumericId(i);
        return id && allowedSet.has(Number(id));
      }),
      identity,
      isColaborador: true,
      filtered: true,
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
    window.setInstanciaAtiva?.(value === '' ? null : String(value), { reloadList: true });
    markActive(value || '');
    try { window.zcUpdateInstBadge?.(); } catch {}
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
    label.innerHTML = `<span class="dot"></span><span>WhatsApps</span><span class="inst-section-count"> (0)</span>`;
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

    // Se LAST aponta para uma instância que o colaborador não pode mais ver, limpa.
    if (LAST && !values.has(String(LAST))) {
      LAST = '';
      try {
        localStorage.setItem(KEY_VAL(EMPRESA_ID), '');
        localStorage.removeItem(KEY_LABEL(EMPRESA_ID));
      } catch {}
    }

    // Colaborador com uma única instância: seleciona automaticamente.
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
    label.innerHTML = `<span class="dot"></span><span>WhatsApps</span><span class="inst-section-count"> (${list.length || 0})</span>`;
    wrap.appendChild(label);

    if (!list.length) {
      return renderEmpty('Nenhum WhatsApp liberado para este colaborador.');
    }

    const showTodos = !isColaborador || list.length > 1;

    if (showTodos) {
      wrap.appendChild(pill({
        label: isColaborador ? 'Todos permitidos' : 'Todos',
        value: '',
        active: !LAST,
        muted: isColaborador,
      }));
    }

    (list || []).forEach(i => {
      const value = getInstValue(i);
      const labelTxt = getInstLabel(i, value);

      if (!value) return;

      wrap.appendChild(pill({
        label: labelTxt,
        value: String(value),
        active: String(LAST) === String(value),
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
          filtrado_por_permissao: isColaborador,
        }
      }));
    } catch {}

    const cachedLabel =
      localStorage.getItem(KEY_MAP(EMPRESA_ID, LAST)) ||
      localStorage.getItem(KEY_LABEL(EMPRESA_ID)) ||
      '';

    if (LAST && cachedLabel) saveSelection(LAST, cachedLabel);

    applyInstance(LAST || '');
  }

  function renderLoading() {
    wrap.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'inst-section-label';
    label.innerHTML = `<span class="dot"></span><span>WhatsApps</span><span class="inst-section-count"> (...)</span>`;
    wrap.appendChild(label);

    const loading = document.createElement('div');
    loading.className = 'inst-empty';
    loading.textContent = 'Carregando WhatsApps...';
    loading.style.cssText = 'font-size:.85rem;opacity:.75;padding:.35rem .5rem;';
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
      const r = await fetch(`/api/empresas/${EMPRESA_ID}/whatsapp`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
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