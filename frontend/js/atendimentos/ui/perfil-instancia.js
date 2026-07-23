/* ====================================================================
 * ZapsChat – Perfil / Instância
 * /frontend/js/atendimentos/ui/perfil-instancia.js
 *
 * Ajustado:
 * - Perfil da instância agora usa o mesmo padrão visual do conta.js.
 * - Não cria mais overlay/tela cheia para o meu perfil.
 * - Não cobre o sidebar.
 * - Visual mais clean: menos negrito, badges suaves e linhas leves.
 * - Mantém cache em memória + localStorage.
 * - Mantém regra do topo em "Todos": não chama backend/Evolution.
 * - Cache fresco no navegador não chama backend/BD.
 * - Cache velho mostra imediato e revalida em segundo plano.
 * - Botão Atualizar força Evolution.
 * - Atualizar não apaga cache bom antes de saber se deu certo.
 * - Perfil da conversa continua funcionando em drawer próprio.
 * - Ícones dos badges usam SVG inline e não dependem do Font Awesome.
 * ==================================================================== */

(function () {
  'use strict';

  const VERSION = 'zc-perfil-instancia-v13-inline-badge-icons';
  const LS_PREFIX = 'zc:perfil-instancia:v2:';
  const PERFIL_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

  if (window.__ZC_PERFIL_INSTANCIA_VERSION__ === VERSION) return;

  window.__ZC_PERFIL_INSTANCIA_VERSION__ = VERSION;
  window.__ZC_PERFIL_INSTANCIA_LOADED__ = true;

  let perfilUsuarioCache = null;
  let conversaCache = null;
  let abortCtrl = null;
  let meuPerfilLoading = false;
  let meuPerfilPageEl = null;
  let meuPerfilHelper = null;
  let meuPerfilLastUser = null;
  let settingsRegistered = false;

  const meuPerfilCachePorInstancia = new Map();

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function qs(selector, root = document) {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }

  function qsa(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function clean(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function onlyDigits(value) {
    return clean(value).replace(/\D+/g, '');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function firstValue() {
    for (let i = 0; i < arguments.length; i++) {
      const value = arguments[i];

      if (value === null || value === undefined) continue;

      if (typeof value === 'string') {
        const s = clean(value);
        if (s) return s;
        continue;
      }

      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
    }

    return '';
  }

  function hasValue(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return clean(value).length > 0;
    return true;
  }

  function mergeObjects() {
    const out = {};

    for (let i = 0; i < arguments.length; i++) {
      const obj = arguments[i];
      if (!obj || typeof obj !== 'object') continue;

      Object.entries(obj).forEach(([key, value]) => {
        if (!hasValue(value)) return;
        if (!hasValue(out[key])) out[key] = value;
      });
    }

    return out;
  }

  function datasetToObject(el) {
    if (!el || !el.dataset) return {};

    const out = {};

    Object.entries(el.dataset).forEach(([key, value]) => {
      if (hasValue(value)) out[key] = value;
    });

    return out;
  }

  function getDeep(obj, path) {
    try {
      return String(path)
        .split('.')
        .reduce((acc, key) => {
          if (!acc || typeof acc !== 'object') return undefined;
          return acc[key];
        }, obj);
    } catch {
      return undefined;
    }
  }

  function getInitials(name, fallback) {
    const safe = clean(name);
    if (!safe) return fallback || 'U';

    const parts = safe.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();

    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  function normalizeAvatarUrl(value) {
    const s = clean(value);
    if (!s) return '';
    if (s.startsWith('data:')) return s;
    if (/^https?:\/\//i.test(s)) return s;
    if (s.charAt(0) === '/') return s;
    return '/' + s.replace(/^\/+/, '');
  }

  function formatPhone(value) {
    const raw = clean(value);
    if (!raw) return '';

    const digits = onlyDigits(raw);
    if (!digits) return raw;

    if (digits.length === 13 && digits.startsWith('55')) {
      return '+55 ' + digits.slice(2, 4) + ' ' + digits.slice(4, 9) + '-' + digits.slice(9);
    }

    if (digits.length === 12 && digits.startsWith('55')) {
      return '+55 ' + digits.slice(2, 4) + ' ' + digits.slice(4, 8) + '-' + digits.slice(8);
    }

    if (digits.length === 11) {
      return '+55 ' + digits.slice(0, 2) + ' ' + digits.slice(2, 7) + '-' + digits.slice(7);
    }

    if (digits.length === 10) {
      return '+55 ' + digits.slice(0, 2) + ' ' + digits.slice(2, 6) + '-' + digits.slice(6);
    }

    if (raw.startsWith('+')) return raw;

    return digits;
  }

  function formatDateTime(value) {
    const raw = clean(value);
    if (!raw) return '';

    try {
      const dt = new Date(raw);
      if (Number.isNaN(dt.getTime())) return raw;

      return dt.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return raw;
    }
  }

  function lockPage(lock) {
    try {
      document.documentElement.style.overflow = lock ? 'hidden' : '';
      document.body.style.overflow = lock ? 'hidden' : '';
    } catch {}
  }

  function setAvatarImage(img, initials, urls, options) {
    if (!img) return;

    options = options || {};
    const forceReload = !!options.forceReload;

    const list = (Array.isArray(urls) ? urls : [urls])
      .map(normalizeAvatarUrl)
      .filter(Boolean);

    let index = 0;

    function fallback() {
      img.removeAttribute('src');
      img.style.display = 'none';
      if (initials) initials.style.display = '';
    }

    function next() {
      if (index >= list.length) {
        fallback();
        return;
      }

      let src = clean(list[index++]);

      if (!src) {
        next();
        return;
      }

      if (forceReload && !src.startsWith('data:')) {
        src += (src.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(Date.now());
      }

      img.onerror = next;
      img.onload = function () {
        img.style.display = 'block';
        if (initials) initials.style.display = 'none';
      };

      img.src = src;
    }

    next();
  }

  function showToast(message) {
    const msg = message || 'Pronto';

    if (meuPerfilHelper && typeof meuPerfilHelper.showToast === 'function') {
      try {
        meuPerfilHelper.showToast(msg);
        return;
      } catch {}
    }

    if (typeof window.toast === 'function') {
      try {
        window.toast({ title: msg, msg: '', type: 'ok' });
        return;
      } catch {}

      try {
        window.toast(msg, true);
        return;
      } catch {}
    }

    const toast = qs('#zcMeuPerfilToast') || qs('#zcPerfilConversaToast');
    if (!toast) return;

    toast.textContent = msg;
    toast.classList.add('is-on');
    toast.classList.add('show');

    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => {
      toast.classList.remove('is-on');
      toast.classList.remove('show');
    }, 1700);
  }

  async function copyText(text, successMessage) {
    const value = clean(text);
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      showToast(successMessage || 'Copiado');
      return;
    } catch {}

    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      showToast(successMessage || 'Copiado');
    } catch {
      showToast('Não foi possível copiar');
    }
  }

  function buildQuery(params) {
    const q = new URLSearchParams();

    Object.entries(params || {}).forEach(([key, value]) => {
      if (!hasValue(value)) return;
      q.set(key, clean(value));
    });

    const str = q.toString();
    return str ? '?' + str : '';
  }

  async function fetchJson(url, signal) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal
      });

      if (!res.ok) return null;

      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) return null;

      return await res.json();
    } catch {
      return null;
    }
  }

  /* ==================================================================
   * INSTÂNCIA SELECIONADA NO TOPO
   * ================================================================== */

  function getSelectedInstanceLabel() {
    const labelEl = qs('#zc-inst-current-label');
    const label = clean(labelEl?.textContent || '');

    if (label) return label;

    const active = getSelectedInstanceButton();
    return clean(active?.dataset?.label || active?.textContent || '');
  }

  function isTodosLabel(value) {
    const s = clean(value).toLowerCase();

    return (
      !s ||
      s === 'todos' ||
      s === 'todas' ||
      s === 'all' ||
      s === '*' ||
      s === 'todas as instâncias' ||
      s === 'todas instâncias' ||
      s === 'todos os atendimentos'
    );
  }

  function getInstSwitchRoot() {
    return (
      qs('#inst-switch') ||
      qs('#zc-inst-menu') ||
      qs('[data-zc-inst-menu]') ||
      qs('.zc-inst-menu')
    );
  }

  function getSelectedInstanceButtons() {
    const root = getInstSwitchRoot();
    if (!root) return [];

    return qsa(
      [
        'button',
        '[role="button"]',
        '.inst-pill',
        '.wpp-header-filtro',
        '[data-value]',
        '[data-instancia-id]',
        '[data-instancia_id]',
        '[data-id]',
        '[data-instance-id]',
        '[data-instance_id]'
      ].join(','),
      root
    ).filter((el) => clean(el.textContent || el.dataset?.label || el.dataset?.value || ''));
  }

  function getSelectedInstanceButton() {
    const buttons = getSelectedInstanceButtons();
    const label = clean(qs('#zc-inst-current-label')?.textContent || '');

    return (
      buttons.find((btn) => {
        return (
          btn.classList.contains('is-active') ||
          btn.classList.contains('ativo') ||
          btn.classList.contains('active') ||
          btn.classList.contains('selected') ||
          btn.getAttribute('aria-pressed') === 'true' ||
          btn.getAttribute('aria-current') === 'true' ||
          btn.getAttribute('aria-selected') === 'true'
        );
      }) ||
      buttons.find((btn) => clean(btn.textContent) === label) ||
      buttons.find((btn) => clean(btn.dataset?.label) === label) ||
      null
    );
  }

  function getGlobalInstanciasList() {
    const candidates = [
      window.ZC_INSTANCIAS,
      window.INSTANCIAS,
      window.instancias,
      window.state && window.state.instancias,
      window.ZC_STATE && window.ZC_STATE.instancias,
      window.ZCAtendimento && window.ZCAtendimento.instancias,
      getDeep(window, 'ZCStore.state.instancias'),
      getDeep(window, 'AtendimentoStore.state.instancias')
    ];

    for (const item of candidates) {
      if (Array.isArray(item)) return item;
    }

    return [];
  }

  function matchInstanciaInGlobalList(label, button) {
    const ds = datasetToObject(button);
    const list = getGlobalInstanciasList();

    const possibleValues = [
      label,
      ds.label,
      ds.nome,
      ds.name,
      ds.apelido,
      ds.instancia,
      ds.instance,
      ds.instanceName,
      ds.instance_name,
      ds.slug,
      ds.value
    ].map(clean).filter(Boolean);

    for (const row of list) {
      if (!row || typeof row !== 'object') continue;

      const rowId = firstValue(
        row.id,
        row.instancia_id,
        row.instanciaId,
        row.instance_id,
        row.instanceId,
        row.value
      );

      const rowValues = [
        row.apelido,
        row.nome,
        row.name,
        row.label,
        row.instance_name,
        row.instanceName,
        row.instance,
        row.instancia,
        row.slug
      ].map(clean).filter(Boolean);

      const found = possibleValues.some((v) => rowValues.includes(v));

      if (found && rowId) {
        return onlyDigits(rowId);
      }
    }

    return '';
  }

  function getSelectedInstanciaId() {
    const button = getSelectedInstanceButton();
    const label = getSelectedInstanceLabel();
    const ds = datasetToObject(button);

    const candidates = [
      ds.instanciaId,
      ds.instancia_id,
      ds.value,
      ds.id,
      ds.instanceId,
      ds.instance_id,
      button && button.getAttribute('data-value'),
      button && button.getAttribute('data-instancia-id'),
      button && button.getAttribute('data-instancia_id'),
      button && button.getAttribute('data-id'),
      button && button.getAttribute('data-instance-id'),
      button && button.getAttribute('data-instance_id'),
      button && button.value
    ];

    for (const raw of candidates) {
      const digits = onlyDigits(raw);
      if (digits && digits !== '0') return digits;
    }

    const matched = matchInstanciaInGlobalList(label, button);
    if (matched && matched !== '0') return matched;

    return '';
  }

  function getSelectedInstanceDebugInfo() {
    const button = getSelectedInstanceButton();
    const label = getSelectedInstanceLabel();

    return {
      label,
      isTodos: isTodosLabel(label),
      button,
      dataset: datasetToObject(button),
      instanciaId: getSelectedInstanciaId(),
      instanciasGlobal: getGlobalInstanciasList()
    };
  }

  /* ==================================================================
   * CACHE VISUAL + LOCALSTORAGE
   * ================================================================== */

  function getPerfilCacheKey(instanciaId) {
    const id = onlyDigits(instanciaId);
    return id || '';
  }

  function getPerfilLocalStorageKey(instanciaId) {
    const key = getPerfilCacheKey(instanciaId);
    if (!key) return '';
    return LS_PREFIX + key;
  }

  function isCacheablePerfil(user) {
    if (!user || typeof user !== 'object') return false;

    if (
      user.kind === 'todos' ||
      user.kind === 'erro' ||
      user.source === 'fetch_error' ||
      user.source === 'http_error' ||
      user.source === 'invalid_response' ||
      user.source === 'missing_selected_id'
    ) {
      return false;
    }

    return true;
  }

  function getPerfilFingerprint(user) {
    if (!user || typeof user !== 'object') return '';

    return clean(
      firstValue(
        user.wuid,
        user.telefone_e164,
        user.numero,
        user.numero_instancia,
        user.telefone,
        user.raw?.wuid,
        user.raw?.telefone_e164,
        user.raw?.numero,
        user.raw?.numero_instancia
      )
    );
  }

  function savePerfilLocalStorage(instanciaId, user) {
    if (!isCacheablePerfil(user)) return;

    const key = getPerfilLocalStorageKey(instanciaId || user.instancia_id || user.id);
    if (!key) return;

    try {
      const now = new Date().toISOString();

      const payload = {
        version: 2,
        saved_at: now,
        instancia_id: String(instanciaId || user.instancia_id || user.id || ''),
        fingerprint: getPerfilFingerprint(user),
        user: {
          ...user,
          __fromLocalStorage: false,
          __localStorageSavedAt: '',
          __cacheAgeMs: 0,
          __cacheFresh: true
        }
      };

      localStorage.setItem(key, JSON.stringify(payload));
    } catch (err) {
      try {
        console.warn('[ZapsChat][perfil-instancia] não salvou localStorage:', err);
      } catch {}
    }
  }

  function loadPerfilLocalStorage(instanciaId) {
    const key = getPerfilLocalStorageKey(instanciaId);
    if (!key) return null;

    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const user = parsed && parsed.user && typeof parsed.user === 'object'
        ? parsed.user
        : null;

      if (!isCacheablePerfil(user)) return null;

      const savedAt = parsed.saved_at || '';
      const savedTime = savedAt ? new Date(savedAt).getTime() : 0;
      const ageMs = savedTime ? Date.now() - savedTime : Number.MAX_SAFE_INTEGER;
      const fresh = ageMs >= 0 && ageMs <= PERFIL_CACHE_MAX_AGE_MS;

      return {
        ...user,
        __fromLocalStorage: true,
        __localStorageSavedAt: savedAt,
        __cacheAgeMs: ageMs,
        __cacheFresh: fresh,
        __cacheFingerprint: parsed.fingerprint || ''
      };
    } catch {
      try {
        localStorage.removeItem(key);
      } catch {}
      return null;
    }
  }

  function isPerfilCacheFresh(user) {
    if (!user || typeof user !== 'object') return false;

    if (user.__fromLocalStorage) {
      return !!user.__cacheFresh;
    }

    if (user.__memorySavedAt) {
      const ageMs = Date.now() - Number(user.__memorySavedAt || 0);
      return ageMs >= 0 && ageMs <= PERFIL_CACHE_MAX_AGE_MS;
    }

    return false;
  }

  function getPerfilVisualCache(instanciaId) {
    const key = getPerfilCacheKey(instanciaId);
    if (!key) return null;

    const mem = meuPerfilCachePorInstancia.get(key);
    if (mem && isCacheablePerfil(mem)) {
      perfilUsuarioCache = mem;
      return mem;
    }

    const stored = loadPerfilLocalStorage(key);
    if (stored) {
      const memUser = {
        ...stored,
        __memorySavedAt: Date.now()
      };

      meuPerfilCachePorInstancia.set(key, memUser);
      perfilUsuarioCache = memUser;
      return memUser;
    }

    return null;
  }

  function setPerfilVisualCache(instanciaId, user) {
    const key = getPerfilCacheKey(instanciaId || user?.instancia_id || user?.id);
    if (!key || !isCacheablePerfil(user)) return;

    const cleanUser = {
      ...user,
      __fromLocalStorage: false,
      __localStorageSavedAt: '',
      __cacheAgeMs: 0,
      __cacheFresh: true,
      __memorySavedAt: Date.now()
    };

    meuPerfilCachePorInstancia.set(key, cleanUser);
    perfilUsuarioCache = cleanUser;

    savePerfilLocalStorage(key, cleanUser);

    try {
      window.dispatchEvent(new CustomEvent('zc:perfil-instancia-updated', {
        detail: {
          instancia_id: key,
          user: cleanUser,
          source: cleanUser.source || cleanUser.profile_source || 'cache'
        }
      }));
    } catch {}
  }

  function removePerfilLocalStorage(instanciaId) {
    const key = getPerfilCacheKey(instanciaId);
    if (!key) return;

    try {
      localStorage.removeItem(getPerfilLocalStorageKey(key));
    } catch {}
  }

  /* ==================================================================
   * MEU PERFIL / PERFIL DA INSTÂNCIA
   * ================================================================== */

  function makeTodosPerfilPayload() {
    return {
      kind: 'todos',
      source: 'todos',
      profile_source: 'todos',
      ok: false,
      selected_all: true,
      connected: false,
      nome: 'Nenhuma instância selecionada',
      apelido: '',
      about: 'Escolha uma instância específica no topo para visualizar o perfil do WhatsApp conectado.',
      telefone: '',
      telefone_fmt: '',
      avatar_url: '',
      message: 'Quando estiver em “Todos”, o ZapsChat não carrega perfil de uma instância específica.'
    };
  }

  function normalizeMeuPerfilFromApi(data) {
    data = data && typeof data === 'object' ? data : {};

    const nome = firstValue(
      data.nome_whatsapp,
      data.nome_real,
      data.nome,
      data.name,
      data.push_name,
      data.pushName,
      data.apelido,
      data.nome_instancia,
      data.instance_name,
      'Instância'
    );

    const about = firstValue(
      data.about,
      data.recado,
      data.status_text,
      data.description,
      data.business_info && data.business_info.description,
      data.message,
      ''
    );

    const telefoneRaw = firstValue(
      data.telefone_fmt,
      data.telefone_e164,
      data.numero,
      data.numero_instancia,
      data.telefone,
      data.wuid
    );

    const avatar = firstValue(
      data.avatar_url,
      data.avatar_remote_url,
      data.profilePictureUrl,
      data.picture,
      data.avatar
    );

    return {
      raw: data,
      kind: 'instancia',
      ok: data.ok !== false,
      source: data.source || data.profile_source || 'db',
      profile_source: data.profile_source || data.source || 'db',
      refresh_source: data.refresh_source || '',
      id: firstValue(data.instancia_id, data.id),
      instancia_id: firstValue(data.instancia_id, data.id),
      empresa_id: data.empresa_id,
      instance_name: data.instance_name || data.instanceName || '',
      apelido: data.apelido || '',
      connected: !!data.connected,
      last_seen: data.last_seen || '',
      perfil_atualizado_em: data.perfil_atualizado_em || data.profile_updated_at || data.atualizado_em || '',
      nome: clean(nome || 'Instância'),
      about: clean(about || ''),
      telefone: clean(firstValue(data.telefone_e164, data.numero, data.numero_instancia, data.telefone, data.wuid)),
      telefone_fmt: clean(data.telefone_fmt || formatPhone(telefoneRaw)),
      avatar: normalizeAvatarUrl(avatar),
      is_business: !!data.is_business,
      business_info: data.business_info || null,
      message: data.message || '',
      evolution_error: data.evolution_error || '',
      wuid: data.wuid || ''
    };
  }

  function buildMeuPerfilUrl(instanciaId, refresh) {
    let url = '/api/atendimento/instancias/' + encodeURIComponent(instanciaId) + '/perfil';

    if (refresh) {
      url += '?refresh=1';
    }

    return url;
  }

  async function fetchMeuPerfil(options) {
    options = options || {};

    const debug = getSelectedInstanceDebugInfo();
    const refresh = !!options.refresh;

    if (debug.isTodos) {
      perfilUsuarioCache = makeTodosPerfilPayload();
      return perfilUsuarioCache;
    }

    if (!debug.instanciaId) {
      perfilUsuarioCache = {
        kind: 'erro',
        source: 'missing_selected_id',
        profile_source: 'missing_selected_id',
        ok: false,
        connected: false,
        nome: 'Instância não identificada',
        about: 'Não consegui identificar o ID da instância selecionada. O botão precisa ter data-value com o ID.',
        telefone: '',
        telefone_fmt: '',
        avatar_url: '',
        debug
      };

      return perfilUsuarioCache;
    }

    const url = buildMeuPerfilUrl(debug.instanciaId, refresh);

    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });

      const contentType = String(res.headers.get('content-type') || '').toLowerCase();

      if (!contentType.includes('application/json')) {
        perfilUsuarioCache = {
          kind: 'erro',
          source: 'invalid_response',
          profile_source: 'invalid_response',
          ok: false,
          connected: false,
          nome: 'Erro ao carregar perfil',
          about: 'O servidor respondeu em formato inesperado.',
          telefone: '',
          telefone_fmt: '',
          avatar_url: ''
        };

        return perfilUsuarioCache;
      }

      const data = await res.json();

      if (!res.ok) {
        perfilUsuarioCache = {
          kind: 'erro',
          source: 'http_error',
          profile_source: 'http_error',
          ok: false,
          connected: false,
          nome: 'Erro ao carregar perfil',
          about: clean(data?.detail || data?.message || 'Não foi possível carregar o perfil da instância.'),
          telefone: '',
          telefone_fmt: '',
          avatar_url: '',
          raw: data
        };

        return perfilUsuarioCache;
      }

      perfilUsuarioCache = normalizeMeuPerfilFromApi(data);
      setPerfilVisualCache(debug.instanciaId, perfilUsuarioCache);

      return perfilUsuarioCache;
    } catch (err) {
      const stored = getPerfilVisualCache(debug.instanciaId);

      if (stored && !refresh) {
        return stored;
      }

      perfilUsuarioCache = {
        kind: 'erro',
        source: 'fetch_error',
        profile_source: 'fetch_error',
        ok: false,
        connected: false,
        nome: 'Erro de conexão',
        about: 'Não foi possível consultar o perfil da instância agora.',
        telefone: '',
        telefone_fmt: '',
        avatar_url: '',
        error: String(err || '')
      };

      return perfilUsuarioCache;
    }
  }

  function getSourceText(user) {
    const src = clean(user?.profile_source || user?.source || '').toLowerCase();

    if (user?.__fromLocalStorage) {
      if (isPerfilCacheFresh(user)) return 'Dados salvos no navegador';
      return 'Dados salvos no navegador. Atualizando em segundo plano';
    }

    if (src === 'evolution') return 'Atualizado agora pela Evolution';
    if (src === 'cache') return 'Dados carregados do cache';
    if (src === 'db_cache') return 'Dados salvos no banco';
    if (src === 'db') return 'Dados salvos no banco';
    if (src === 'disconnected') return 'Instância desconectada';
    if (src.includes('evolution')) return 'Dados consultados na Evolution';
    if (src.includes('db')) return 'Dados carregados do banco';

    return 'Dados da instância';
  }

  function ensureMeuPerfilInlineStyle() {
    let style = document.getElementById('zcMeuPerfilSettingsStyle');

    if (!style) {
      style = document.createElement('style');
      style.id = 'zcMeuPerfilSettingsStyle';
      document.head.appendChild(style);
    }

    style.textContent = `
      .zc-meu-perfil-inline-card{
        display:flex;
        align-items:center;
        gap:16px;
        min-width:0;
      }

      .zc-meu-perfil-inline-avatar{
        width:72px;
        height:72px;
        min-width:72px;
        border-radius:999px;
        overflow:hidden;
        background:#202c33;
        color:#00a884;
        display:flex;
        align-items:center;
        justify-content:center;
        font-size:23px;
        font-weight:500;
        box-shadow:0 6px 16px rgba(0,0,0,.16);
      }

      .zc-meu-perfil-inline-avatar img{
        width:100%;
        height:100%;
        object-fit:cover;
        display:none;
      }

      .zc-meu-perfil-inline-main{
        min-width:0;
        flex:1 1 auto;
      }

      .zc-meu-perfil-inline-name{
        color:var(--zc-settings-title, #e9edef);
        font-size:15.5px;
        font-weight:500;
        line-height:1.25;
        word-break:break-word;
        letter-spacing:-.01em;
      }

      .zc-meu-perfil-inline-desc{
        margin-top:5px;
        color:var(--zc-settings-muted, #aebac1);
        font-size:13px;
        font-weight:400;
        line-height:1.4;
        word-break:break-word;
      }

      .zc-meu-perfil-inline-badges{
        margin-top:10px;
        display:flex;
        align-items:center;
        gap:8px;
        flex-wrap:wrap;
      }

      .zc-meu-perfil-badge{
        display:inline-flex;
        align-items:center;
        gap:6px;
        min-height:23px;
        border-radius:999px;
        padding:4px 9px;
        background:rgba(37,211,102,.10);
        color:#25d366;
        font-size:11.5px;
        font-weight:500;
        line-height:1;
      }

      .zc-meu-perfil-badge-icon{
        display:block;
        flex:0 0 auto;
        width:11px;
        height:11px;
        overflow:visible;
      }

      .zc-meu-perfil-badge-icon.is-status{
        width:7px;
        height:7px;
      }

      .zc-meu-perfil-badge.is-off{
        background:rgba(255,255,255,.07);
        color:#aebac1;
      }

      .zc-meu-perfil-badge.is-muted{
        background:rgba(255,255,255,.055);
        color:#aebac1;
      }

      .zc-meu-perfil-loading-inline{
        display:flex;
        align-items:center;
        gap:10px;
        color:var(--zc-settings-muted, #aebac1);
        font-size:14px;
        font-weight:400;
        padding:4px 0;
      }

      .zc-meu-perfil-spinner{
        width:17px;
        height:17px;
        border-radius:999px;
        border:2px solid rgba(255,255,255,.16);
        border-top-color:#25d366;
        animation:zcMeuPerfilSpin .8s linear infinite;
      }

      @keyframes zcMeuPerfilSpin{
        to{ transform:rotate(360deg); }
      }

      .zc-meu-perfil-action-btn.is-loading i,
      .zc-meu-perfil-refresh-row.is-loading i{
        animation:zcMeuPerfilSpin .8s linear infinite;
      }

      .zc-meu-perfil-empty-inline{
        display:flex;
        align-items:flex-start;
        gap:14px;
        min-width:0;
      }

      .zc-meu-perfil-empty-icon{
        width:46px;
        height:46px;
        min-width:46px;
        border-radius:999px;
        background:rgba(37,211,102,.10);
        color:#25d366;
        display:flex;
        align-items:center;
        justify-content:center;
        font-size:20px;
      }

      #zcMeuPerfilContent .zc-settings-row strong,
      #zcMeuPerfilContent .zc-settings-row-title,
      #zcMeuPerfilContent .zc-settings-row-main strong{
        font-weight:500 !important;
        letter-spacing:-.01em;
      }

      #zcMeuPerfilContent .zc-settings-row small,
      #zcMeuPerfilContent .zc-settings-row-desc,
      #zcMeuPerfilContent .zc-settings-row-main small{
        font-weight:400 !important;
        color:var(--zc-settings-muted, #aebac1);
      }

      #zcMeuPerfilContent .zc-settings-row,
      #zcMeuPerfilContent button.zc-settings-row{
        font-weight:400 !important;
      }

      #zcMeuPerfilContent .zc-settings-row [class*="side"],
      #zcMeuPerfilContent .zc-settings-row-side{
        font-weight:500 !important;
      }

      .zc-meu-perfil-toast{
        position:fixed;
        left:50%;
        bottom:28px;
        transform:translateX(-50%);
        z-index:1000000;
        border-radius:999px;
        padding:10px 16px;
        background:#202c33;
        color:#e9edef;
        font-size:13px;
        font-weight:400;
        opacity:0;
        pointer-events:none;
        transition:opacity .16s ease;
      }

      .zc-meu-perfil-toast.is-on,
      .zc-meu-perfil-toast.show{
        opacity:1;
      }
    `;
  }

  function getMeuPerfilContentEl() {
    return qs('#zcMeuPerfilContent', meuPerfilPageEl || document);
  }

  function helperBlock(title, body) {
    const H = meuPerfilHelper || window.ZCSettingsPage;

    if (H && typeof H.block === 'function') {
      return H.block(title, body);
    }

    return `
      <section class="zc-settings-block">
        <h3>${escapeHtml(title)}</h3>
        ${body}
      </section>
    `;
  }

  function helperList(body) {
    const H = meuPerfilHelper || window.ZCSettingsPage;

    if (H && typeof H.list === 'function') {
      return H.list(body);
    }

    return `<div class="zc-settings-list">${body}</div>`;
  }

  function helperRow(config) {
    const H = meuPerfilHelper || window.ZCSettingsPage;

    if (H && typeof H.row === 'function') {
      return H.row(config);
    }

    const action = config.action ? ` data-action="${escapeHtml(config.action)}"` : '';
    const side = config.side ? `<span>${escapeHtml(config.side)}</span>` : '';

    return `
      <button type="button" class="zc-settings-row"${action}>
        <span class="zc-settings-row-icon"><i class="${escapeHtml(config.icon || 'fa-regular fa-circle')}"></i></span>
        <span class="zc-settings-row-main">
          <strong>${escapeHtml(config.title || '')}</strong>
          <small>${escapeHtml(config.desc || '')}</small>
        </span>
        ${side}
      </button>
    `;
  }

  function renderMeuPerfilShell() {
    return `
      <div id="zcMeuPerfilContent">
        ${helperBlock('Perfil do WhatsApp conectado', `
          <div class="zc-meu-perfil-loading-inline">
            <span class="zc-meu-perfil-spinner"></span>
            <span>Carregando perfil…</span>
          </div>
        `)}
      </div>

      <div class="zc-meu-perfil-toast" id="zcMeuPerfilToast">Copiado</div>
    `;
  }

  function renderMeuPerfilLoading(message) {
    const content = getMeuPerfilContentEl();
    if (!content) return;

    content.innerHTML = helperBlock('Perfil do WhatsApp conectado', `
      <div class="zc-meu-perfil-loading-inline">
        <span class="zc-meu-perfil-spinner"></span>
        <span>${escapeHtml(message || 'Carregando perfil…')}</span>
      </div>
    `);
  }

  function renderMeuPerfilEmpty(user) {
    const content = getMeuPerfilContentEl();
    if (!content) return;

    const isTodos = user && user.kind === 'todos';
    const title = user?.nome || 'Nenhuma instância selecionada';
    const desc = user?.about || user?.message || 'Escolha uma instância específica no topo para visualizar o perfil do WhatsApp conectado.';

    content.innerHTML = `
      ${helperBlock('Perfil do WhatsApp conectado', `
        <div class="zc-meu-perfil-empty-inline">
          <div class="zc-meu-perfil-empty-icon">
            <i class="fa-brands fa-whatsapp"></i>
          </div>

          <div class="zc-meu-perfil-inline-main">
            <div class="zc-meu-perfil-inline-name">${escapeHtml(title)}</div>
            <div class="zc-meu-perfil-inline-desc">${escapeHtml(desc)}</div>
          </div>
        </div>
      `)}

      ${helperList(`
        ${helperRow({
          icon: isTodos ? 'fa-solid fa-layer-group' : 'fa-solid fa-triangle-exclamation',
          title: isTodos ? 'Selecionar uma instância' : 'Tentar carregar novamente',
          desc: isTodos
            ? 'No topo do atendimento, escolha uma instância específica para ver o perfil.'
            : 'Tenta buscar o perfil da instância selecionada novamente.',
          side: isTodos ? 'Escolher' : 'Tentar',
          action: isTodos ? 'choose-instance' : 'refresh-meu-perfil'
        })}
      `)}
    `;
  }

  function setMeuPerfilRefreshingState(isLoading) {
    const root = meuPerfilPageEl || document;

    const buttons = qsa(
      '[data-action="refresh-meu-perfil"], [data-action="reload-meu-perfil"], .zc-meu-perfil-action-btn',
      root
    );

    buttons.forEach((btn) => {
      btn.disabled = !!isLoading;
      btn.classList.toggle('is-loading', !!isLoading);
      btn.classList.toggle('zc-meu-perfil-refresh-row', !!isLoading);
    });
  }

  function renderMeuPerfil(user, options) {
    options = options || {};
    user = user || perfilUsuarioCache || makeTodosPerfilPayload();
    meuPerfilLastUser = user;

    const content = getMeuPerfilContentEl();
    if (!content) return;

    if (
      user.kind === 'todos' ||
      user.source === 'missing_selected_id' ||
      user.source === 'fetch_error' ||
      user.source === 'http_error' ||
      user.source === 'invalid_response'
    ) {
      renderMeuPerfilEmpty(user);
      return;
    }

    const about = user.about || user.message || 'Sem recado/status disponível.';
    const nome = user.nome || user.apelido || user.instance_name || 'Instância';
    const phone = user.telefone_fmt || formatPhone(user.telefone) || 'Telefone não informado';
    const statusClass = user.connected ? '' : ' is-off';
    const statusText = user.connected ? 'Conectado' : 'Desconectado';
    const instanceText = user.apelido || user.instance_name || 'Instância não identificada';
    const sourceText = getSourceText(user);
    const atualizadoEm = formatDateTime(user.perfil_atualizado_em || user.raw?.perfil_atualizado_em || '');
    const salvoNavegadorEm = formatDateTime(user.__localStorageSavedAt || '');
    const lastSeen = formatDateTime(user.last_seen || '');

    content.innerHTML = `
      ${helperBlock('Perfil do WhatsApp conectado', `
        <div class="zc-meu-perfil-inline-card">
          <div class="zc-meu-perfil-inline-avatar">
            <img id="zcMeuPerfilAvatarImg" alt="Foto do WhatsApp">
            <span id="zcMeuPerfilInitials">${escapeHtml(getInitials(nome, 'W'))}</span>
          </div>

          <div class="zc-meu-perfil-inline-main">
            <div class="zc-meu-perfil-inline-name">${escapeHtml(nome)}</div>
            <div class="zc-meu-perfil-inline-desc">${escapeHtml(phone)}</div>

            <div class="zc-meu-perfil-inline-badges">
              <span class="zc-meu-perfil-badge${statusClass}">
                <svg class="zc-meu-perfil-badge-icon is-status" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
                  <circle cx="4" cy="4" r="3.25" fill="currentColor"></circle>
                </svg>
                ${escapeHtml(statusText)}
              </span>

              <span class="zc-meu-perfil-badge is-muted">
                <svg class="zc-meu-perfil-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
                  <ellipse cx="12" cy="5" rx="8" ry="3"></ellipse>
                  <path d="M4 5v7c0 1.66 3.58 3 8 3s8-1.34 8-3V5"></path>
                  <path d="M4 12v7c0 1.66 3.58 3 8 3s8-1.34 8-3v-7"></path>
                </svg>
                ${escapeHtml(sourceText)}
              </span>
            </div>
          </div>
        </div>
      `)}

      ${helperList(`
        ${helperRow({
          icon: 'fa-solid fa-rotate-right',
          title: 'Atualizar pela Evolution',
          desc: 'Busca novamente foto, nome, telefone, status e recado do WhatsApp conectado.',
          side: 'Atualizar',
          action: 'refresh-meu-perfil'
        })}

        ${helperRow({
          icon: 'fa-regular fa-comment-dots',
          title: 'Recado',
          desc: about,
          side: 'Atualizar',
          action: 'refresh-meu-perfil'
        })}

        ${helperRow({
          icon: 'fa-solid fa-phone',
          title: 'Telefone',
          desc: phone,
          side: 'Copiar',
          action: 'copy-phone'
        })}

        ${helperRow({
          icon: 'fa-solid fa-mobile-screen',
          title: 'Instância',
          desc: instanceText,
          side: 'Ver',
          action: 'noop'
        })}

        ${helperRow({
          icon: 'fa-solid fa-shield-halved',
          title: 'Status da conexão',
          desc: lastSeen ? `${statusText} · Último status: ${lastSeen}` : statusText,
          side: user.connected ? 'Online' : 'Off',
          action: 'noop'
        })}

        ${helperRow({
          icon: 'fa-solid fa-database',
          title: 'Origem dos dados',
          desc: [sourceText, atualizadoEm ? `Atualizado em ${atualizadoEm}` : '', salvoNavegadorEm ? `Salvo no navegador em ${salvoNavegadorEm}` : ''].filter(Boolean).join(' · '),
          side: 'Cache',
          action: 'noop'
        })}
      `)}

      ${user.is_business && user.business_info ? helperList(`
        ${helperRow({
          icon: 'fa-solid fa-briefcase',
          title: 'Conta comercial',
          desc: firstValue(user.business_info.email, user.business_info.website, 'WhatsApp Business'),
          side: 'Business',
          action: 'noop'
        })}
      `) : ''}
    `;

    const initials = qs('#zcMeuPerfilInitials', content);
    const avatar = qs('#zcMeuPerfilAvatarImg', content);

    if (initials) {
      initials.textContent = getInitials(nome, 'W');
      initials.style.display = '';
    }

    setAvatarImage(
      avatar,
      initials,
      user.avatar ? [user.avatar] : [],
      { forceReload: !!options.forceAvatarReload }
    );
  }

  async function loadMeuPerfilIntoPage(options) {
    options = options || {};

    const debug = getSelectedInstanceDebugInfo();
    const refresh = !!options.refresh;

    if (debug.isTodos) {
      renderMeuPerfil(makeTodosPerfilPayload());
      return;
    }

    const visualCache = getPerfilVisualCache(debug.instanciaId);

    if (visualCache && !refresh) {
      renderMeuPerfil(visualCache, { forceAvatarReload: false });

      if (isPerfilCacheFresh(visualCache)) {
        return;
      }

      fetchMeuPerfil({ refresh: false })
        .then((user) => {
          if (user && isCacheablePerfil(user)) {
            renderMeuPerfil(user, { forceAvatarReload: false });
          }
        })
        .catch(() => {});

      return;
    }

    renderMeuPerfilLoading(refresh ? 'Atualizando pela Evolution…' : 'Carregando perfil…');

    const user = await fetchMeuPerfil({ refresh });
    renderMeuPerfil(user, { forceAvatarReload: refresh });
  }

  async function refreshMeuPerfilAtual() {
    if (meuPerfilLoading) return;

    const debug = getSelectedInstanceDebugInfo();

    if (debug.isTodos) {
      renderMeuPerfil(makeTodosPerfilPayload());
      showToast('Selecione uma instância primeiro');
      return;
    }

    if (!debug.instanciaId) {
      showToast('Instância não identificada');
      return;
    }

    const previousCache = getPerfilVisualCache(debug.instanciaId);

    meuPerfilLoading = true;
    setMeuPerfilRefreshingState(true);

    try {
      if (!previousCache && getMeuPerfilContentEl()) {
        renderMeuPerfilLoading('Atualizando pela Evolution…');
      } else {
        showToast('Atualizando pela Evolution…');
      }

      const user = await fetchMeuPerfil({ refresh: true });

      if (user && isCacheablePerfil(user) && user.ok !== false) {
        setPerfilVisualCache(debug.instanciaId, user);
        renderMeuPerfil(user, { forceAvatarReload: true });
        showToast('Perfil atualizado');
        return;
      }

      if (previousCache) {
        renderMeuPerfil(previousCache, { forceAvatarReload: false });
        showToast('Falhou. Mantive o perfil salvo');
        return;
      }

      renderMeuPerfil(user);
      showToast('Não foi possível atualizar');
    } finally {
      meuPerfilLoading = false;
      setMeuPerfilRefreshingState(false);
    }
  }

  function closeMeuPerfil() {
    lockPage(false);
  }

  function escolherInstanciaNoTopo() {
    const trigger =
      qs('#zc-inst-trigger') ||
      qs('[data-zc-inst-trigger]') ||
      qs('#inst-switch button') ||
      qs('#inst-switch');

    try {
      trigger?.click?.();
    } catch {}

    showToast('Selecione uma instância no topo');
  }

  function bindMeuPerfilPageEvents(page) {
    if (!page || page.__ZC_MEU_PERFIL_EVENTS__) return;

    page.__ZC_MEU_PERFIL_EVENTS__ = true;

    page.addEventListener('click', function (event) {
      const btn = event.target.closest('[data-action]');
      if (!btn) return;

      const action = clean(btn.dataset.action || '');

      if (action === 'refresh-meu-perfil' || action === 'reload-meu-perfil') {
        event.preventDefault();
        refreshMeuPerfilAtual();
        return;
      }

      if (action === 'copy-phone') {
        event.preventDefault();

        const user = meuPerfilLastUser || perfilUsuarioCache;
        const phoneToCopy = user?.telefone_fmt || user?.telefone || user?.raw?.telefone_e164 || user?.raw?.numero || '';

        if (!phoneToCopy) {
          showToast('Telefone não informado');
          return;
        }

        copyText(phoneToCopy, 'Telefone copiado');
        return;
      }

      if (action === 'choose-instance') {
        event.preventDefault();
        escolherInstanciaNoTopo();
      }
    });
  }

  function registerMeuPerfilSettingsPage() {
    const H = window.ZCSettingsPage;

    if (!H || typeof H.register !== 'function') return false;
    if (settingsRegistered) return true;

    ensureMeuPerfilInlineStyle();

    const config = {
      match: 'Perfil',
      title: 'Perfil',
      subtitle: 'Nome, foto e informações do WhatsApp conectado',
      render() {
        return renderMeuPerfilShell();
      },
      onOpen(page, helper) {
        meuPerfilPageEl = page;
        meuPerfilHelper = helper || H;

        ensureMeuPerfilInlineStyle();
        bindMeuPerfilPageEvents(page);
        loadMeuPerfilIntoPage({ refresh: false });
      }
    };

    H.register(config);

    try {
      H.register({ ...config, match: 'Perfil da instância', title: 'Perfil da instância' });
      H.register({ ...config, match: 'Meu perfil', title: 'Meu perfil' });
    } catch {}

    settingsRegistered = true;
    return true;
  }

  function findSettingsProfileButton() {
    const candidates = qsa('button, a, [role="button"], [data-settings-page], [data-page], [data-action], [data-go]');

    return candidates.find((el) => {
      const text = clean(el.textContent || '').toLowerCase();

      const attrs = [
        el.getAttribute('data-settings-page'),
        el.getAttribute('data-page'),
        el.getAttribute('data-action'),
        el.getAttribute('data-go'),
        el.getAttribute('href'),
        el.getAttribute('aria-label'),
        el.getAttribute('title')
      ].map((v) => clean(v).toLowerCase()).filter(Boolean);

      if (attrs.some((v) => v === 'perfil' || v === 'perfil da instância' || v === 'meu perfil')) return true;
      if (attrs.some((v) => v === '/perfil' || v === '/perfil.html')) return true;

      return text === 'perfil' || text.includes('perfil da instância') || text.includes('nome, foto');
    }) || null;
  }

  function tryOpenSettingsProfilePage() {
    const H = window.ZCSettingsPage;

    if (H) {
      const methods = ['open', 'openPage', 'show', 'showPage', 'setPage', 'navigate', 'go'];

      for (const name of methods) {
        if (typeof H[name] !== 'function') continue;

        try {
          H[name]('Perfil');
          return true;
        } catch {}
      }
    }

    const btn = findSettingsProfileButton();

    if (btn && !btn.__ZC_OPENING_BY_PERFIL_INSTANCIA__) {
      try {
        btn.__ZC_OPENING_BY_PERFIL_INSTANCIA__ = true;
        btn.click();

        setTimeout(() => {
          btn.__ZC_OPENING_BY_PERFIL_INSTANCIA__ = false;
        }, 100);

        return true;
      } catch {
        btn.__ZC_OPENING_BY_PERFIL_INSTANCIA__ = false;
      }
    }

    return false;
  }

  async function openMeuPerfil(options) {
    options = options || {};

    try {
      const userMenu = qs('#wppUserMenu');
      const userBtn = qs('#wppUserMenuBtn');

      if (userMenu) userMenu.classList.remove('show');

      if (userBtn) {
        userBtn.classList.remove('active');
        userBtn.setAttribute('aria-expanded', 'false');
      }
    } catch {}

    registerMeuPerfilSettingsPage();

    if (!meuPerfilPageEl) {
      tryOpenSettingsProfilePage();
    }

    setTimeout(() => {
      if (meuPerfilPageEl) {
        loadMeuPerfilIntoPage({ refresh: !!options.refresh });
      }
    }, 0);
  }

  /* ==================================================================
   * PERFIL DA CONVERSA
   * ================================================================== */

  function normalizeRemoteJid(value) {
    return clean(value).replace(/\s+/g, '').replace(/^["']|["']$/g, '');
  }

  function numberFromRemoteJid(remoteJid) {
    const jid = normalizeRemoteJid(remoteJid);
    if (!jid) return '';

    const beforeAt = jid.split('@')[0] || '';
    const digits = onlyDigits(beforeAt);

    if (digits.length >= 8) return digits;

    return '';
  }

  function normalizeKind(data) {
    const tipo = clean(firstValue(
      data?.kind,
      data?.tipo,
      data?.type,
      data?.chat_type,
      data?.chatType,
      data?.conversa_tipo,
      data?.conversation_type
    )).toLowerCase();

    const jid = normalizeRemoteJid(firstValue(
      data?.remoteJid,
      data?.remote_jid,
      data?.jid,
      data?.chat_jid,
      data?.chatJid,
      data?.whatsapp_jid,
      data?.whatsappJid
    )).toLowerCase();

    if (
      tipo === 'grupo' ||
      tipo === 'group' ||
      tipo === 'g' ||
      jid.includes('@g.us')
    ) {
      return 'grupo';
    }

    return 'cliente';
  }

  function normalizeId(data) {
    return firstValue(
      data?.cliente_id,
      data?.clienteId,
      data?.client_id,
      data?.clientId,
      data?.contato_id,
      data?.contatoId,
      data?.contact_id,
      data?.contactId,
      data?.grupo_id,
      data?.grupoId,
      data?.group_id,
      data?.groupId,
      data?.conversa_id,
      data?.conversaId,
      data?.chat_id,
      data?.chatId,
      data?.entity_id,
      data?.entityId,
      data?.id
    );
  }

  function normalizeInstanceId(data) {
    return firstValue(
      data?.instancia_id,
      data?.instanciaId,
      data?.instance_id,
      data?.instanceId,
      data?.api_id,
      data?.apiId,
      data?.evolution_instance_id,
      data?.evolutionInstanceId
    );
  }

  function normalizeInstanceName(data) {
    return firstValue(
      data?.instancia_nome,
      data?.instanciaNome,
      data?.instance_name,
      data?.instanceName,
      data?.instancia,
      data?.instance,
      data?.instance_slug,
      data?.instanceSlug,
      data?.evolution_instance,
      data?.evolutionInstance
    );
  }

  function normalizeRemote(data) {
    return normalizeRemoteJid(firstValue(
      data?.remoteJid,
      data?.remote_jid,
      data?.jid,
      data?.chat_jid,
      data?.chatJid,
      data?.whatsapp_jid,
      data?.whatsappJid,
      data?.wa_id,
      data?.waId
    ));
  }

  function normalizePhone(data) {
    const direct = firstValue(
      data?.telefone,
      data?.phone,
      data?.numero,
      data?.number,
      data?.celular,
      data?.whatsapp,
      data?.whatsapp_number,
      data?.whatsappNumber,
      data?.cliente_telefone,
      data?.clienteTelefone
    );

    if (direct) return direct;

    return numberFromRemoteJid(normalizeRemote(data));
  }

  function normalizeName(data) {
    const headerTitle = clean(qs('#chat-title')?.textContent || '');

    return firstValue(
      data?.pushName,
      data?.push_name,
      data?.displayName,
      data?.display_name,
      data?.nome_contato,
      data?.nomeContato,
      data?.nome,
      data?.name,
      data?.title,
      data?.cliente_nome,
      data?.clienteNome,
      data?.grupo_nome,
      data?.grupoNome,
      data?.notifyName,
      data?.notify_name,
      headerTitle
    );
  }

  function normalizeAbout(data) {
    return firstValue(
      data?.about,
      data?.recado,
      data?.bio,
      data?.status,
      data?.status_text,
      data?.statusText,
      data?.status_mensagem,
      data?.statusMensagem,
      data?.profile_status,
      data?.profileStatus,
      data?.whatsapp_status,
      data?.whatsappStatus,
      data?.description,
      data?.descricao,
      data?.profile?.about,
      data?.profile?.recado,
      data?.profile?.bio,
      data?.profile?.status,
      data?.profile?.status_text,
      data?.profile?.statusText
    );
  }

  function normalizeAvatar(data) {
    return firstValue(
      data?.avatar_url,
      data?.avatarUrl,
      data?.foto_url,
      data?.fotoUrl,
      data?.foto_perfil,
      data?.fotoPerfil,
      data?.profile_pic_url,
      data?.profilePicUrl,
      data?.profilePictureUrl,
      data?.picture,
      data?.photo,
      data?.image,
      data?.profile?.avatar_url,
      data?.profile?.avatarUrl,
      data?.profile?.profilePicUrl,
      data?.profile?.profilePictureUrl
    );
  }

  function normalizeProfile(data) {
    const kind = normalizeKind(data);
    const id = normalizeId(data);
    const instanceId = normalizeInstanceId(data);
    const instanceName = normalizeInstanceName(data);
    const remoteJid = normalizeRemote(data);
    const phone = normalizePhone(data);
    const name = normalizeName(data) || (kind === 'grupo' ? 'Grupo' : 'Contato');
    const about = normalizeAbout(data);
    const avatar = normalizeAvatar(data);

    return {
      raw: data || {},
      kind,
      id,
      instanceId,
      instanceName,
      remoteJid,
      phone,
      phoneFormatted: formatPhone(phone),
      name,
      about,
      avatar
    };
  }

  function objectFromHeader() {
    const title = clean(qs('#chat-title')?.textContent || '');
    const avatarBox = qs('#chat-avatar');
    const img = avatarBox?.querySelector?.('img');

    let headerAvatar = '';

    if (img) {
      headerAvatar = img.currentSrc || img.src || '';
    }

    if (!headerAvatar && avatarBox) {
      try {
        const style = window.getComputedStyle(avatarBox);
        const bg = style.backgroundImage || '';
        const match = bg.match(/url\(["']?(.+?)["']?\)/i);

        if (match) headerAvatar = match[1];
      } catch {}
    }

    return {
      nome: title,
      avatar_url: headerAvatar,
      ...datasetToObject(qs('#chat-header')),
      ...datasetToObject(qs('#historico')),
      ...datasetToObject(avatarBox)
    };
  }

  function activeListItemData() {
    const selectors = [
      '#lista-clientes li.is-active',
      '#lista-clientes li.active',
      '#lista-clientes li.ativo',
      '#lista-clientes li.selected',
      '#lista-clientes li[aria-selected="true"]',
      '#lista-clientes .chat-item.is-active',
      '#lista-clientes .cliente-item.is-active',
      '#lista-clientes .chat-item.active',
      '#lista-clientes .cliente-item.active'
    ];

    let el = null;

    for (const selector of selectors) {
      el = qs(selector);
      if (el) break;
    }

    if (!el) return {};

    const data = datasetToObject(el);

    const nameEl =
      qs('.nome', el) ||
      qs('.cliente-nome', el) ||
      qs('.chat-name', el) ||
      qs('.name', el) ||
      qs('.title', el);

    const phoneEl =
      qs('.telefone', el) ||
      qs('.phone', el) ||
      qs('.numero', el);

    const avatarImg = qs('img', el);

    if (nameEl && !data.nome) data.nome = clean(nameEl.textContent);
    if (phoneEl && !data.telefone) data.telefone = clean(phoneEl.textContent);
    if (avatarImg && !data.avatar_url) data.avatar_url = avatarImg.currentSrc || avatarImg.src || '';

    return data;
  }

  function getCurrentConversationData() {
    const globals = [
      window.__ZC_CONVERSA_ATUAL,
      window.__zcConversaAtual,
      window.__zcSelectedConversation,
      window.__ZC_SELECTED_CONVERSATION,
      window.__clienteSelecionado,
      window.clienteSelecionado,
      window.clienteSel,
      window.currentCliente,
      window.currentConversation,
      window.conversaAtual,
      getDeep(window, 'state.clienteSel'),
      getDeep(window, 'state.conversaAtual'),
      getDeep(window, 'ZC_STATE.clienteSel'),
      getDeep(window, 'ZC_STATE.conversaAtual'),
      getDeep(window, 'ZCStore.state.clienteSel'),
      getDeep(window, 'ZCStore.state.conversaAtual'),
      getDeep(window, 'AtendimentoStore.state.clienteSel'),
      getDeep(window, 'AtendimentoStore.state.conversaAtual'),
      getDeep(window, 'ZCAtendimento.conversaAtual'),
      getDeep(window, 'ZCAtendimento.currentConversation'),
      conversaCache
    ].filter(Boolean).filter((item) => typeof item === 'object');

    return mergeObjects(...globals, activeListItemData(), objectFromHeader());
  }

  function buildProfileUrls(profile, force) {
    const id = profile.id;
    const kind = profile.kind || 'cliente';

    const params = {
      kind,
      tipo: kind,
      cliente_id: id,
      id,
      instancia_id: profile.instanceId,
      instancia: profile.instanceName,
      instance_id: profile.instanceId,
      instance: profile.instanceName,
      api_id: profile.instanceId,
      remote_jid: profile.remoteJid,
      jid: profile.remoteJid,
      telefone: profile.phone,
      number: profile.phone,
      force: force ? '1' : ''
    };

    const urls = [];

    if (id) {
      if (kind === 'grupo') {
        urls.push('/api/atendimento/grupos/' + encodeURIComponent(id) + '/profile' + buildQuery(params));
        urls.push('/api/atendimento/grupos/' + encodeURIComponent(id) + '/perfil' + buildQuery(params));
      } else {
        urls.push('/api/atendimento/clientes/' + encodeURIComponent(id) + '/profile' + buildQuery(params));
        urls.push('/api/atendimento/clientes/' + encodeURIComponent(id) + '/perfil' + buildQuery(params));
        urls.push('/api/atendimento/clientes/' + encodeURIComponent(id) + buildQuery(params));
      }
    }

    urls.push('/api/atendimento/profile' + buildQuery(params));
    urls.push('/api/atendimento/perfil' + buildQuery(params));

    if (id && kind !== 'grupo') {
      urls.push('/api/clientes/' + encodeURIComponent(id) + buildQuery(params));
    }

    return Array.from(new Set(urls));
  }

  function buildAvatarUrls(profile, force) {
    const id = profile.id;
    const kind = profile.kind || 'cliente';

    const params = {
      kind,
      tipo: kind,
      cliente_id: id,
      id,
      instancia_id: profile.instanceId,
      instancia: profile.instanceName,
      instance_id: profile.instanceId,
      instance: profile.instanceName,
      api_id: profile.instanceId,
      remote_jid: profile.remoteJid,
      jid: profile.remoteJid,
      telefone: profile.phone,
      number: profile.phone,
      force: force ? '1' : ''
    };

    const urls = [];

    if (id) {
      urls.push('/api/atendimento/avatar/' + encodeURIComponent(id) + buildQuery(params));

      if (kind === 'grupo') {
        urls.push('/api/atendimento/grupos/' + encodeURIComponent(id) + '/avatar' + buildQuery(params));
      } else {
        urls.push('/api/atendimento/clientes/' + encodeURIComponent(id) + '/avatar' + buildQuery(params));
      }
    }

    urls.push('/api/atendimento/avatar' + buildQuery(params));

    if (profile.avatar) urls.push(profile.avatar);

    const headerAvatar = objectFromHeader().avatar_url;
    if (headerAvatar) urls.push(headerAvatar);

    return Array.from(new Set(urls.filter(Boolean)));
  }

  async function loadConversaProfile(baseData, force) {
    const profile = normalizeProfile(baseData);

    if (abortCtrl) {
      try { abortCtrl.abort(); } catch {}
    }

    abortCtrl = new AbortController();

    const urls = buildProfileUrls(profile, force);

    for (const url of urls) {
      const data = await fetchJson(url, abortCtrl.signal);

      if (!data || typeof data !== 'object') continue;

      const payload =
        data.data ||
        data.profile ||
        data.perfil ||
        data.cliente ||
        data.contato ||
        data.grupo ||
        data.result ||
        data;

      if (payload && typeof payload === 'object') {
        return mergeObjects(payload, data);
      }
    }

    return {};
  }

  function ensureConversaStyle() {
    let style = document.getElementById('zcPerfilConversaStyle');

    if (!style) {
      style = document.createElement('style');
      style.id = 'zcPerfilConversaStyle';
      document.head.appendChild(style);
    }

    style.textContent = `
      .zc-perfil-conv-overlay{
        position:fixed;
        inset:0;
        z-index:99990;
        display:none;
        background:rgba(0,0,0,.28);
        font-family:"Inter","Segoe UI",Arial,sans-serif;
        font-weight:400;
      }

      .zc-perfil-conv-overlay.is-open{
        display:block;
      }

      .zc-perfil-conv-drawer{
        position:absolute;
        top:0;
        right:0;
        width:min(430px, 100vw);
        height:100vh;
        background:#111b21;
        color:#e9edef;
        border-left:1px solid rgba(255,255,255,.10);
        box-shadow:-20px 0 45px rgba(0,0,0,.30);
        transform:translateX(102%);
        transition:transform .20s ease;
        display:flex;
        flex-direction:column;
        overflow:hidden;
      }

      .zc-perfil-conv-overlay.is-open .zc-perfil-conv-drawer{
        transform:translateX(0);
      }

      .zc-perfil-conv-head{
        height:64px;
        min-height:64px;
        background:#202c33;
        display:flex;
        align-items:center;
        gap:12px;
        padding:0 16px;
        border-bottom:1px solid rgba(255,255,255,.08);
      }

      .zc-perfil-conv-back{
        width:38px;
        height:38px;
        border:0;
        border-radius:999px;
        background:transparent;
        color:#e9edef;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        cursor:pointer;
        font-size:18px;
      }

      .zc-perfil-conv-back:hover{
        background:rgba(255,255,255,.08);
      }

      .zc-perfil-conv-title{
        min-width:0;
        display:flex;
        flex-direction:column;
        gap:2px;
      }

      .zc-perfil-conv-title strong{
        color:#e9edef;
        font-size:16px;
        font-weight:500;
        line-height:1.1;
      }

      .zc-perfil-conv-title span{
        color:#aebac1;
        font-size:12px;
        font-weight:400;
      }

      .zc-perfil-conv-body{
        flex:1 1 auto;
        min-height:0;
        overflow:auto;
        background:#0b141a;
      }

      .zc-perfil-conv-loading{
        padding:28px 22px;
        display:flex;
        align-items:center;
        gap:12px;
        color:#aebac1;
        font-size:14px;
        font-weight:400;
      }

      .zc-perfil-conv-spinner{
        width:18px;
        height:18px;
        border-radius:999px;
        border:2px solid rgba(255,255,255,.18);
        border-top-color:#25d366;
        animation:zcPerfilConvSpin .8s linear infinite;
      }

      @keyframes zcPerfilConvSpin{
        to{ transform:rotate(360deg); }
      }

      .zc-perfil-conv-hero{
        background:#111b21;
        border-bottom:10px solid #0b141a;
        padding:30px 20px 24px;
        display:flex;
        flex-direction:column;
        align-items:center;
        text-align:center;
      }

      .zc-perfil-conv-avatar{
        width:156px;
        height:156px;
        border-radius:999px;
        background:#202c33;
        color:#25d366;
        overflow:hidden;
        display:flex;
        align-items:center;
        justify-content:center;
        font-size:46px;
        font-weight:500;
        margin-bottom:18px;
        box-shadow:0 10px 28px rgba(0,0,0,.25);
      }

      .zc-perfil-conv-avatar img{
        width:100%;
        height:100%;
        object-fit:cover;
        display:none;
      }

      .zc-perfil-conv-name{
        max-width:100%;
        color:#e9edef;
        font-size:20px;
        font-weight:500;
        line-height:1.25;
        word-break:break-word;
      }

      .zc-perfil-conv-kind{
        margin-top:6px;
        color:#aebac1;
        font-size:13px;
        font-weight:400;
      }

      .zc-perfil-conv-section{
        background:#111b21;
        border-bottom:10px solid #0b141a;
        padding:18px 22px;
      }

      .zc-perfil-conv-label{
        margin:0 0 12px;
        color:#00a884;
        font-size:13px;
        font-weight:500;
      }

      .zc-perfil-conv-row{
        min-height:34px;
        display:flex;
        align-items:center;
        gap:12px;
      }

      .zc-perfil-conv-value{
        flex:1 1 auto;
        min-width:0;
        color:#e9edef;
        font-size:15px;
        font-weight:400;
        line-height:1.45;
        word-break:break-word;
      }

      .zc-perfil-conv-icon-btn{
        width:34px;
        height:34px;
        border:0;
        border-radius:999px;
        background:transparent;
        color:#aebac1;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        cursor:pointer;
        flex:0 0 auto;
      }

      .zc-perfil-conv-icon-btn:hover{
        background:rgba(255,255,255,.08);
        color:#e9edef;
      }

      .zc-perfil-conv-list{
        background:#111b21;
        border-bottom:10px solid #0b141a;
      }

      .zc-perfil-conv-item{
        width:100%;
        border:0;
        background:transparent;
        color:#e9edef;
        display:flex;
        align-items:center;
        gap:18px;
        padding:15px 22px;
        text-align:left;
        text-decoration:none;
        font:inherit;
      }

      button.zc-perfil-conv-item{
        cursor:pointer;
      }

      button.zc-perfil-conv-item:hover{
        background:rgba(255,255,255,.055);
      }

      .zc-perfil-conv-item-icon{
        width:24px;
        min-width:24px;
        display:flex;
        align-items:center;
        justify-content:center;
        color:#aebac1;
        font-size:17px;
      }

      .zc-perfil-conv-item-main{
        flex:1 1 auto;
        min-width:0;
        display:flex;
        flex-direction:column;
        gap:3px;
      }

      .zc-perfil-conv-item-main strong{
        color:#e9edef;
        font-size:14px;
        font-weight:500;
      }

      .zc-perfil-conv-item-main span{
        color:#aebac1;
        font-size:12.5px;
        font-weight:400;
        line-height:1.35;
        word-break:break-word;
      }

      .zc-perfil-conv-toast{
        position:absolute;
        left:50%;
        bottom:22px;
        transform:translateX(-50%);
        border-radius:999px;
        padding:10px 16px;
        background:#202c33;
        color:#e9edef;
        font-size:13px;
        font-weight:500;
        opacity:0;
        pointer-events:none;
        transition:opacity .16s ease;
      }

      .zc-perfil-conv-toast.is-on,
      .zc-perfil-conv-toast.show{
        opacity:1;
      }
    `;
  }

  function ensureConversaDrawer() {
    ensureConversaStyle();

    const existing = document.getElementById('zcPerfilConversaOverlay');
    if (existing) return existing;

    const overlay = document.createElement('div');
    overlay.id = 'zcPerfilConversaOverlay';
    overlay.className = 'zc-perfil-conv-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    overlay.innerHTML = `
      <aside class="zc-perfil-conv-drawer" role="dialog" aria-modal="true" aria-label="Perfil WhatsApp">
        <header class="zc-perfil-conv-head">
          <button type="button" class="zc-perfil-conv-back" id="zcPerfilConversaClose" aria-label="Voltar">
            <i class="fa-solid fa-arrow-left"></i>
          </button>

          <div class="zc-perfil-conv-title">
            <strong id="zcPerfilConversaHeaderTitle">Perfil WhatsApp</strong>
            <span id="zcPerfilConversaHeaderSub">Dados da conversa</span>
          </div>
        </header>

        <div class="zc-perfil-conv-body" id="zcPerfilConversaBody">
          <div class="zc-perfil-conv-loading">
            <span class="zc-perfil-conv-spinner"></span>
            <span>Carregando perfil…</span>
          </div>
        </div>

        <div class="zc-perfil-conv-toast" id="zcPerfilConversaToast">Copiado</div>
      </aside>
    `;

    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) closePerfilConversa();
    });

    qs('#zcPerfilConversaClose', overlay)?.addEventListener('click', closePerfilConversa);

    return overlay;
  }

  function renderConversaLoading() {
    const body = qs('#zcPerfilConversaBody');
    if (!body) return;

    body.innerHTML = `
      <div class="zc-perfil-conv-loading">
        <span class="zc-perfil-conv-spinner"></span>
        <span>Carregando perfil…</span>
      </div>
    `;
  }

  function renderConversaProfile(profile, forceAvatar) {
    const body = qs('#zcPerfilConversaBody');
    if (!body) return;

    const kindText = profile.kind === 'grupo' ? 'Grupo do WhatsApp' : 'Contato do WhatsApp';
    const titleText = profile.kind === 'grupo' ? 'Dados do grupo' : 'Dados do contato';
    const about = profile.about || 'Sem recado/status disponível.';
    const phone = profile.phoneFormatted || profile.phone || 'Telefone não disponível';
    const instance = profile.instanceName || profile.instanceId || 'Instância não identificada';
    const jid = profile.remoteJid || 'JID não disponível';

    const headerTitle = qs('#zcPerfilConversaHeaderTitle');
    const headerSub = qs('#zcPerfilConversaHeaderSub');

    if (headerTitle) headerTitle.textContent = titleText;
    if (headerSub) headerSub.textContent = kindText;

    body.innerHTML = `
      <section class="zc-perfil-conv-hero">
        <div class="zc-perfil-conv-avatar">
          <img id="zcPerfilConversaAvatarImg" alt="Foto do WhatsApp">
          <span id="zcPerfilConversaInitials">${escapeHtml(getInitials(profile.name, 'C'))}</span>
        </div>

        <div class="zc-perfil-conv-name">${escapeHtml(profile.name || 'Contato')}</div>
        <div class="zc-perfil-conv-kind">${escapeHtml(kindText)}</div>
      </section>

      <section class="zc-perfil-conv-section">
        <p class="zc-perfil-conv-label">Recado</p>

        <div class="zc-perfil-conv-row">
          <div class="zc-perfil-conv-value">${escapeHtml(about)}</div>
        </div>
      </section>

      <section class="zc-perfil-conv-section">
        <p class="zc-perfil-conv-label">Telefone</p>

        <div class="zc-perfil-conv-row">
          <div class="zc-perfil-conv-value">${escapeHtml(phone)}</div>

          <button type="button" class="zc-perfil-conv-icon-btn" id="zcPerfilConversaCopyPhone" title="Copiar telefone" aria-label="Copiar telefone">
            <i class="fa-regular fa-copy"></i>
          </button>
        </div>
      </section>

      <div class="zc-perfil-conv-list">
        <button type="button" class="zc-perfil-conv-item" id="zcPerfilConversaRefresh">
          <span class="zc-perfil-conv-item-icon">
            <i class="fa-solid fa-rotate-right"></i>
          </span>

          <span class="zc-perfil-conv-item-main">
            <strong>Atualizar dados do WhatsApp</strong>
            <span>Busca novamente foto, nome e recado usando a instância desta conversa.</span>
          </span>
        </button>

        <div class="zc-perfil-conv-item">
          <span class="zc-perfil-conv-item-icon">
            <i class="fa-solid fa-mobile-screen"></i>
          </span>

          <span class="zc-perfil-conv-item-main">
            <strong>Instância</strong>
            <span>${escapeHtml(instance)}</span>
          </span>
        </div>

        <div class="zc-perfil-conv-item">
          <span class="zc-perfil-conv-item-icon">
            <i class="fa-solid fa-fingerprint"></i>
          </span>

          <span class="zc-perfil-conv-item-main">
            <strong>Identificador WhatsApp</strong>
            <span>${escapeHtml(jid)}</span>
          </span>
        </div>
      </div>
    `;

    const img = qs('#zcPerfilConversaAvatarImg', body);
    const initials = qs('#zcPerfilConversaInitials', body);

    setAvatarImage(
      img,
      initials,
      buildAvatarUrls(profile, forceAvatar),
      { forceReload: !!forceAvatar }
    );

    qs('#zcPerfilConversaCopyPhone', body)?.addEventListener('click', function () {
      copyText(profile.phone || profile.phoneFormatted || '', 'Copiado');
    });

    qs('#zcPerfilConversaRefresh', body)?.addEventListener('click', function () {
      openPerfilConversa({ force: true });
    });
  }

  async function openPerfilConversa(options) {
    options = options || {};

    ensureConversaDrawer();

    const overlay = qs('#zcPerfilConversaOverlay');
    if (!overlay) return;

    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');

    lockPage(true);
    renderConversaLoading();

    const baseData = getCurrentConversationData();

    let apiData = {};

    try {
      apiData = await loadConversaProfile(baseData, !!options.force);
    } catch {
      apiData = {};
    }

    const merged = mergeObjects(apiData, baseData);
    const profile = normalizeProfile(merged);

    renderConversaProfile(profile, !!options.force);
  }

  function closePerfilConversa() {
    const overlay = qs('#zcPerfilConversaOverlay');

    if (overlay) {
      overlay.classList.remove('is-open');
      overlay.setAttribute('aria-hidden', 'true');
    }

    if (abortCtrl) {
      try { abortCtrl.abort(); } catch {}
      abortCtrl = null;
    }

    lockPage(false);
  }

  /* ==================================================================
   * BINDS
   * ================================================================== */

  function rememberConversation(data) {
    if (!data || typeof data !== 'object') return;
    conversaCache = mergeObjects(data, conversaCache || {});
  }

  function isVisible(el) {
    if (!el) return false;

    try {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      );
    } catch {
      return false;
    }
  }

  function shouldOpenMeuPerfilFromClick(target) {
    if (!target) return false;

    return !!(
      target.closest('#wppOpenProfileBtn') ||
      target.closest('[data-zc-open-settings="perfil"]') ||
      target.closest('[data-open-meu-perfil]') ||
      target.closest('.js-open-meu-perfil')
    );
  }

  function shouldOpenConversaFromClick(target) {
    if (!target) return false;

    /*
      IMPORTANTE:
      Foto/nome do header (#chat-avatar / #chat-title) pertencem ao perfil.js
      através do perfil_quick.js, que chama window.abrirPerfilAtual().

      Este arquivo (perfil-instancia.js) NÃO pode capturar esse clique,
      senão abre o perfil da instância/conversa e bloqueia o perfil.js.

      Aqui só abrimos perfil-instancia quando algum elemento pedir
      explicitamente com data-open-perfil-instancia ou .js-open-perfil-instancia.
    */
    if (target.closest('#chat-avatar')) return false;
    if (target.closest('#chat-title')) return false;
    if (target.closest('[data-open-contact-drawer="1"]')) return false;

    if (target.closest('#btn-sobre')) return false;
    if (target.closest('#btnTransferirDepartamento')) return false;
    if (target.closest('.chat-header-actions')) return false;
    if (target.closest('.zc-chat-actions')) return false;
    if (target.closest('.zc-transfer-top-btn')) return false;
    if (target.closest('.zc-chat-icon-btn')) return false;

    return !!(
      target.closest('[data-open-perfil-instancia]') ||
      target.closest('.js-open-perfil-instancia')
    );
  }

  function bindOpenEvents() {
    document.addEventListener('click', function (ev) {
      const targetEl = ev.target && ev.target.closest
        ? ev.target.closest('[data-go], a[href], button[data-href], [data-zc-open-settings], [data-open-meu-perfil], .js-open-meu-perfil, #wppOpenProfileBtn')
        : null;

      if (!targetEl) return;

      const raw = clean(
        targetEl.getAttribute('data-go') ||
        targetEl.getAttribute('href') ||
        targetEl.getAttribute('data-href') ||
        targetEl.getAttribute('data-zc-open-settings') ||
        ''
      ).toLowerCase();

      const isPerfilLink = raw === '/perfil' || raw === '/perfil.html' || raw === 'perfil';

      if (!isPerfilLink && !shouldOpenMeuPerfilFromClick(ev.target)) return;
      if (targetEl.__ZC_OPENING_BY_PERFIL_INSTANCIA__) return;

      ev.preventDefault();
      ev.stopPropagation();

      if (typeof ev.stopImmediatePropagation === 'function') {
        ev.stopImmediatePropagation();
      }

      openMeuPerfil();
    }, true);

    document.addEventListener('click', function (ev) {
      if (!shouldOpenConversaFromClick(ev.target)) return;

      const header = qs('#chat-header');
      if (header && !isVisible(header)) return;

      ev.preventDefault();
      ev.stopPropagation();

      if (typeof ev.stopImmediatePropagation === 'function') {
        ev.stopImmediatePropagation();
      }

      openPerfilConversa();
    }, true);
  }

  function bindConversationMemory() {
    const events = [
      'zc:conversation-opened',
      'zc:conversation-changed',
      'zc:conversa-aberta',
      'zc:conversa-atualizada',
      'zc:cliente-selecionado',
      'zc:historico-rendered'
    ];

    events.forEach(function (eventName) {
      window.addEventListener(eventName, function (ev) {
        if (ev && ev.detail && typeof ev.detail === 'object') {
          rememberConversation(ev.detail);
        }
      });
    });

    document.addEventListener('click', function (ev) {
      const item = ev.target.closest('#lista-clientes li, #lista-clientes .chat-item, #lista-clientes .cliente-item');
      if (!item) return;

      rememberConversation(datasetToObject(item));
    }, true);
  }

  function init() {
    if (window.__ZC_PERFIL_INSTANCIA_INIT__ === VERSION) return;
    window.__ZC_PERFIL_INSTANCIA_INIT__ = VERSION;

    ensureMeuPerfilInlineStyle();
    registerMeuPerfilSettingsPage();
    bindConversationMemory();
    bindOpenEvents();

    if (!window.ZCSettingsPage) {
      window.addEventListener('zc:settings-page-helper-ready', function () {
        registerMeuPerfilSettingsPage();
      }, { once: true });
    }

    window.ZCPerfilInstancia = {
      open: openPerfilConversa,
      close: closePerfilConversa,
      openConversa: openPerfilConversa,
      closeConversa: closePerfilConversa,
      openMeuPerfil,
      closeMeuPerfil,
      refreshMeuPerfil: refreshMeuPerfilAtual,
      getCurrent: getCurrentConversationData,
      getSelectedInstanceDebugInfo,
      removePerfilLocalStorage,
      version: VERSION
    };

    window.abrirPerfilInstanciaUsuario = openMeuPerfil;
    window.zcAbrirMeuPerfilAtendimento = openMeuPerfil;
    window.zcAtualizarPerfilInstanciaUsuario = refreshMeuPerfilAtual;

    try {
      console.info('[ZapsChat][perfil-instancia] carregado:', VERSION);
    } catch {}
  }

  ready(init);
})();