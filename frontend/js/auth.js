// /frontend/js/auth.js
(() => {
  const LS = window.localStorage;

  // ======= URLs (ajuste se necessário) =======
  const LOGIN_URL  = '/login.html';
  const INICIO_URL = '/inicio.html';
  const ME_URL     = '/api/auth/me';
  const LOGOUT_URL = '/api/auth/logout';

  // ======= Utils =======
  const T = (v) => v !== undefined && v !== null && v !== '';

  function _jwtPayload(token) {
    try {
      if (!token || typeof token !== 'string' || !token.includes('.')) return {};
      const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(b64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return JSON.parse(json) || {};
    } catch { return {}; }
  }

  // ======= Persistência compatível com o sidebar =======
  function saveAuth({ access_token, refresh_token, empresa_id, usuario } = {}) {
    // tokens & empresa
    if (T(access_token))  LS.setItem('token', access_token);
    if (T(refresh_token)) LS.setItem('refresh_token', refresh_token);
    if (T(empresa_id))    LS.setItem('empresa_id', String(empresa_id));

    // bloco compatível com teu sidebar
    if (usuario && typeof usuario === 'object') {
      try { LS.setItem('usuario', JSON.stringify(usuario)); } catch {}
      if (T(usuario.nome))         LS.setItem('usuario_nome', usuario.nome);
      if (T(usuario.email))        LS.setItem('usuario_email', usuario.email);
      if (T(usuario.avatar_url))   LS.setItem('avatar_url', usuario.avatar_url);
      if (T(usuario.departamento)) LS.setItem('departamento', usuario.departamento);
    }

    // fallback: extrai nome/email do JWT (se vier só o token)
    const tok = access_token || LS.getItem('token');
    if (tok) {
      const p = _jwtPayload(tok);
      if (!LS.getItem('usuario_email') && T(p.email))   LS.setItem('usuario_email', p.email);
      if (!LS.getItem('usuario_nome')  && T(p.name))    LS.setItem('usuario_nome',  p.name);
      if (!LS.getItem('avatar_url')    && T(p.picture)) LS.setItem('avatar_url',    p.picture);
    }

    _dispatchAuthChange();
  }

  function clearAuth() {
    [
      'token','access_token','refresh_token','empresa_id',
      'usuario_id','usuario_nome','usuario_email','usuario_avatar','avatar_url',
      'nome','email','departamento',
      'usuario','user','me','auth_user','profile','auth'
    ].forEach(k => { try { LS.removeItem(k); } catch {} });
    _dispatchAuthChange();
  }

  function getToken()     { return LS.getItem('token') || LS.getItem('access_token'); }
  function getEmpresaId() { return LS.getItem('empresa_id'); }
  function getUserName()  { return LS.getItem('usuario_nome') || LS.getItem('nome'); }
  function authHeader()   { const t = getToken(); return t ? { Authorization: `Bearer ${t}` } : {}; }

  async function fetchMeWithCookie() {
    try {
      const r = await fetch(ME_URL, { credentials: 'include' });
      if (!r.ok) return null;
      const me = await r.json().catch(() => null);
      if (!me) return null;

      // guarda info mínima para o sidebar renderizar
      if (T(me.empresa_id) && !getEmpresaId()) LS.setItem('empresa_id', String(me.empresa_id));
      if (T(me.nome) && !getUserName())        LS.setItem('usuario_nome', me.nome);
      if (T(me.email) && !LS.getItem('usuario_email')) LS.setItem('usuario_email', me.email);
      try { LS.setItem('usuario', JSON.stringify(me)); } catch {}
      _dispatchAuthChange();
      return me;
    } catch { return null; }
  }

  // ======= Guards =======
  async function requireAuth({ redirect = LOGIN_URL } = {}) {
    // modo localStorage
    if (getToken() && getEmpresaId()) return true;

    // modo cookie httpOnly
    const me = await fetchMeWithCookie();
    if (me?.id) return true;

    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `${redirect}?next=${next}`;
    return false;
  }

  // tenta restaurar via cookie sem redirecionar
  async function softEnsureAuth() {
    if (getToken() && getEmpresaId()) return true;
    const me = await fetchMeWithCookie();
    return !!me?.id;
  }

  // ======= Fetch autenticado =======
  async function authFetch(input, init = {}) {
    const headers = { ...(init.headers || {}), ...authHeader() };
    const r = await fetch(input, { ...init, headers, credentials: 'include' });
    if (r.status === 401) {
      clearAuth();
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `${LOGIN_URL}?next=${next}`;
      return r;
    }
    return r;
  }

  // ======= Avatar helper (opcional) =======
  async function tryFetchAndCacheAvatar() {
    // se já existe dataURL cacheado, não busca
    if (LS.getItem('usuario_avatar')) return;
    const token = getToken();
    if (!token) return;

    try {
      const res = await fetch('/api/usuarios/me/avatar', {
        credentials: 'include',
        headers: { ...authHeader() }
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const reader = new FileReader();
      await new Promise((resolve) => {
        reader.onloadend = resolve;
        reader.readAsDataURL(blob);
      });
      const dataURL = reader.result;
      if (typeof dataURL === 'string') {
        try { LS.setItem('usuario_avatar', dataURL); } catch {}
        _dispatchAuthChange();
      }
    } catch {}
  }

  // ======= Logout =======
  async function logout({ redirect = LOGIN_URL } = {}) {
    try { await fetch(LOGOUT_URL, { method: 'POST', credentials: 'include' }); } catch {}
    clearAuth();
    location.href = redirect;
  }

  // ======= EventBus simples =======
  function _dispatchAuthChange() {
    window.dispatchEvent(new CustomEvent('auth:change', {
      detail: {
        token: getToken(),
        empresa_id: getEmpresaId(),
        usuario_nome: getUserName()
      }
    }));
  }

  // sync multi-abas
  window.addEventListener('storage', (e) => {
    if (!e.key) return;
    if ([
      'token','access_token','refresh_token','empresa_id',
      'usuario','usuario_nome','usuario_email','usuario_avatar','avatar_url',
      'nome','email','departamento'
    ].includes(e.key)) {
      _dispatchAuthChange();
    }
  });

  // ======= Permissões & Rotas (centralizado no ZAuth) =======
  const ROUTES_BY_PERM = [
    ['dashboard.ver',          '/dashboard'],
    ['atendimento.ver',        '/atendimentos'],
    ['clientes.ver',           '/clientes'],
    ['chatinterno.ver',        '/chat-interno'],
    ['usuarios.gerenciar',     '/usuarios'],
    ['colaboradores.gerenciar','/colaboradores'],
    ['config.editar',          '/config'],
    ['integracoes.whatsapp',   '/integracoes/whatsapp'],
  ];

  async function _fetchMinhasPerms(authHeaders = {}) {
    const res = await fetch('/api/permissoes/minhas', {
      credentials: 'include',
      headers: { 'Accept': 'application/json', ...authHeaders }
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json().catch(() => []);
    return Array.isArray(data) ? data : (Array.isArray(data?.permissoes) ? data.permissoes : []);
  }

  function _pickFirstAllowed(perms) {
    for (const [need, route] of ROUTES_BY_PERM) {
      if (perms.includes(need)) return route;
    }
    return null;
  }

  async function firstAllowedRoute() {
    try {
      const token = getToken();
      const empresa = getEmpresaId();
      const headers = {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(empresa ? { 'X-Empresa-Id': String(empresa) } : {}),
      };
      const perms = await _fetchMinhasPerms(headers);
      const dest = _pickFirstAllowed(perms);
      return dest || '/frontend/sem-permissao.html';
    } catch {
      return '/sem-permissao';
    }
  }

  // Overlay + saída segura (volta se tiver histórico; senão vai pra rota permitida)
  async function denyAndExit(msg='Sem permissão', { scope='body', delay=900 } = {}) {
    try { window.PageLoading?.show?.(msg, { scope }); } catch {}
    const dest = await firstAllowedRoute();
    setTimeout(() => {
      if (document.referrer &&
          new URL(document.referrer).origin === location.origin &&
          history.length > 1) {
        history.back();
      } else {
        location.replace(dest);
      }
    }, delay);
  }

  // Garante uma permissão; se negar, redireciona automaticamente
  async function ensurePerm(permRequired, { autoHandle=true, msg='Sem permissão' } = {}) {
    try {
      const token = getToken();
      const empresa = getEmpresaId();
      const headers = {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(empresa ? { 'X-Empresa-Id': String(empresa) } : {}),
      };
      const list = await _fetchMinhasPerms(headers);
      const ok = list.includes(permRequired);
      if (!ok && autoHandle) await denyAndExit(msg);
      return ok;
    } catch {
      if (autoHandle) await denyAndExit(msg);
      return false;
    }
  }

  // Fetch guardado que, em 401/403, dispara negação
  async function guardFetch(input, init={}) {
    const r = await authFetch(input, init);
    if (r.status === 401 || r.status === 403) {
      await denyAndExit('Sem permissão');
      throw new Error(String(r.status));
    }
    return r;
  }

  // Pós-login: respeita ?next= se seguro; senão manda para a 1ª rota permitida
  async function routeAfterLogin() {
    const params = new URLSearchParams(location.search);
    const next = params.get('next');
    if (next && /^\/[^\s]*$/.test(next)) {
      location.replace(next);
      return;
    }
    const dest = await firstAllowedRoute();
    location.replace(dest);
  }

  // ======= Expor global =======
  window.ZAuth = {
    // persistência
    saveAuth, clearAuth,
    // guards
    requireAuth, softEnsureAuth,
    // fetch
    authFetch, authHeader,
    // getters
    getToken, getEmpresaId, getUserName,
    // sessão
    logout, fetchMeWithCookie, tryFetchAndCacheAvatar,
    // permissões / rotas
    ensurePerm, guardFetch, denyAndExit, firstAllowedRoute, routeAfterLogin,
    // consts
    consts: { LOGIN_URL, INICIO_URL, ME_URL, LOGOUT_URL },
    // internals úteis (opcional)
    _internals: { _fetchMinhasPerms, _pickFirstAllowed, ROUTES_BY_PERM }
  };

  // Alias de compatibilidade (se algum ponto chama `Auth.*`)
  window.Auth = window.ZAuth;
})();
