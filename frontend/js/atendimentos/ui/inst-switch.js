// /frontend/js/atendimentos/ui/inst-switch.js

/* =========================================================
   Instância (central + badge “bolinha + nome”)
   - NÃO depende de import
   - usa localStorage (empresa_id) + lista window.INSTANCIAS
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
    if (!raw) return 'Selecione um WhatsApp';

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

    // persiste valor
    try { localStorage.setItem(LS_KEY_INST, v); } catch {}

    // se existir chip, marca
    try { window.setInstanceChip?.(v); } catch {}

    // atualiza badge
    try { zcUpdateInstBadge(); } catch {}

    // evento global
    try {
      document.dispatchEvent(new CustomEvent('inst:change', { detail: { value: window.INSTANCIA_ATIVA } }));
    } catch {}

    // opcional: recarregar lista quando trocar instância
    if (opt && opt.reloadList) {
      try { window.carregarClientes?.({ force: true, reason: 'inst:change' }); } catch {}
    }
  }

  function getInstanciaAtiva() {
    return norm(window.INSTANCIA_ATIVA ?? (function(){ try { return localStorage.getItem(LS_KEY_INST) } catch { return '' } })());
  }

  // expõe globais
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
   Switch (pílulas) — usa a função central acima
========================================================= */
(function () {
  const wrap = document.getElementById('inst-switch');
  if (!wrap) return;

  const EMPRESA_ID = Number(localStorage.getItem('empresa_id') || 0);

  const KEY_VAL   = (id) => `instAtiva:${id}`;              // valor (id/slug)
  const KEY_LABEL = (id) => `instAtivaLabel:${id}`;         // label exibida
  const KEY_MAP   = (id, val) => `instLabel:${id}:${val}`;  // cache por valor

  let LAST = localStorage.getItem(KEY_VAL(EMPRESA_ID)) || '';

  function markActive(val) {
    wrap.querySelectorAll('.inst-pill').forEach(b => {
      const isActive = (b.dataset.value || '') === (val || '');
      b.classList.toggle('is-active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
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

  function pill({ label, value, active }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'inst-pill' + (active ? ' is-active' : '');
    b.textContent = label;
    b.title = `Selecionar ${label}`;
    b.dataset.value = String(value ?? '');
    b.dataset.label = String(label ?? '');
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    b.onclick = () => onPick(String(value ?? ''), String(label ?? ''));
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); }
    });
    return b;
  }

  function render(list) {
    wrap.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'inst-section-label';
    label.innerHTML = `<span class="dot"></span><span>WhatsApps</span><span class="inst-section-count"> (${list.length || 0})</span>`;
    wrap.appendChild(label);

    wrap.appendChild(pill({ label: 'Todos', value: '', active: !LAST }));

    (list || []).forEach(i => {
      const value =
        i.instancia_id ?? i.instancia ?? i.instance_id ??
        i.session ?? i.sessao ?? i.instance_name ?? i.id ?? '';

      const labelTxt =
        (i.apelido || i.nome_exibicao || i.display_name || i.nome || i.name || i.instance_name || String(value) || 'Instância');

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

    try { document.dispatchEvent(new CustomEvent('inst:list', { detail: { instancias: list } })); } catch {}

    // restaura seleção anterior
    const cachedLabel =
      localStorage.getItem(KEY_MAP(EMPRESA_ID, LAST)) ||
      localStorage.getItem(KEY_LABEL(EMPRESA_ID)) ||
      '';

    if (LAST && cachedLabel) saveSelection(LAST, cachedLabel);
    applyInstance(LAST || '');
  }

  if (!EMPRESA_ID) return render([]);

  fetch(`/api/empresas/${EMPRESA_ID}/whatsapp`, { credentials: 'include' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(j => Array.isArray(j.instancias) ? j.instancias : [])
    .then(render)
    .catch(() => render([]));
})();