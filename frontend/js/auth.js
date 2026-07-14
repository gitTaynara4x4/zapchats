// /frontend/js/auth.js
(function(){
  var LS = window.localStorage;

  // ======= URLs =======
  var LOGIN_URL  = '/login';
  var INICIO_URL = '/dashboard';
  var ME_URL     = '/api/auth/me';
  var LOGOUT_URL = '/api/auth/logout';

  // ======= Utils =======
  function T(v){ return v !== undefined && v !== null && v !== ''; }

  function _jwtPayload(token) {
    try {
      if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return {};
      var b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var json = decodeURIComponent(atob(b64).split('').map(function(c){ return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join(''));
      return JSON.parse(json) || {};
    } catch (e) { return {}; }
  }

  // ======= Persistência compatível com o sidebar =======
  function saveAuth(obj) {
    obj = obj || {};
    var access_token  = obj.access_token;
    var refresh_token = obj.refresh_token;
    var empresa_id    = obj.empresa_id;
    var usuario       = obj.usuario;

    if (T(access_token))  LS.setItem('token', access_token);
    if (T(refresh_token)) LS.setItem('refresh_token', refresh_token);
    if (T(empresa_id))    LS.setItem('empresa_id', String(empresa_id));

    if (usuario && typeof usuario === 'object') {
      try { LS.setItem('usuario', JSON.stringify(usuario)); } catch (e) {}
      if (T(usuario.nome))         LS.setItem('usuario_nome', usuario.nome);
      if (T(usuario.email))        LS.setItem('usuario_email', usuario.email);
      if (T(usuario.avatar_url))   LS.setItem('avatar_url', usuario.avatar_url);
      if (T(usuario.departamento)) LS.setItem('departamento', usuario.departamento);
    }

    var tok = access_token || LS.getItem('token');
    if (tok) {
      var p = _jwtPayload(tok);
      if (!LS.getItem('usuario_email') && T(p.email))   LS.setItem('usuario_email', p.email);
      if (!LS.getItem('usuario_nome')  && T(p.name))    LS.setItem('usuario_nome',  p.name);
      if (!LS.getItem('avatar_url')    && T(p.picture)) LS.setItem('avatar_url',    p.picture);
    }

    _dispatchAuthChange();
  }

  function clearAuth() {
    var keys = [
      'token','access_token','refresh_token','empresa_id',
      'usuario_id','usuario_nome','usuario_email','usuario_avatar','avatar_url',
      'nome','email','departamento',
      'usuario','user','me','auth_user','profile','auth'
    ];
    for (var i=0;i<keys.length;i++){ try { LS.removeItem(keys[i]); } catch (e) {} }
    _dispatchAuthChange();
  }

  function getToken()     { return LS.getItem('token') || LS.getItem('access_token'); }
  function getEmpresaId() { return LS.getItem('empresa_id'); }
  function getUserName()  { return LS.getItem('usuario_nome') || LS.getItem('nome'); }
  function authHeader()   { var t = getToken(); return t ? { Authorization: 'Bearer ' + t } : {}; }

  async function fetchMeWithCookie() {
    try {
      var r = await fetch(ME_URL, { credentials: 'include' });
      if (!r.ok) return null;
      var me = await r.json().catch(function(){ return null; });
      if (!me) return null;

      if (T(me.empresa_id) && !getEmpresaId()) LS.setItem('empresa_id', String(me.empresa_id));
      if (T(me.nome) && !getUserName())        LS.setItem('usuario_nome', me.nome);
      if (T(me.email) && !LS.getItem('usuario_email')) LS.setItem('usuario_email', me.email);
      try { LS.setItem('usuario', JSON.stringify(me)); } catch (e) {}
      _dispatchAuthChange();
      return me;
    } catch (e) { return null; }
  }

  // ======= Guards =======
  async function requireAuth(opts) {
    opts = opts || {};
    var redirect = opts.redirect || LOGIN_URL;

    if (getToken() && getEmpresaId()) return true;

    var me = await fetchMeWithCookie();
    if (me && me.id) return true;

    var next = encodeURIComponent(location.pathname + location.search);
    location.href = redirect + '?next=' + next;
    return false;
  }

  async function softEnsureAuth() {
    if (getToken() && getEmpresaId()) return true;
    var me = await fetchMeWithCookie();
    return !!(me && me.id);
  }

  // ======= Fetch autenticado =======
  async function authFetch(input, init) {
    init = init || {};
    var headers = {};
    var base = init.headers || {};
    for (var k in base){ if (Object.prototype.hasOwnProperty.call(base,k)) headers[k]=base[k]; }
    var ah = authHeader();
    for (var k2 in ah){ headers[k2]=ah[k2]; }

    var r = await fetch(input, { method: init.method, body: init.body, headers: headers, credentials: 'include' });
    if (r.status === 401) {
      clearAuth();
      var next = encodeURIComponent(location.pathname + location.search);
      location.href = LOGIN_URL + '?next=' + next;
      return r;
    }
    return r;
  }

  // ======= Avatar helper (opcional) =======
  async function tryFetchAndCacheAvatar() {
    if (LS.getItem('usuario_avatar')) return;
    var token = getToken();
    if (!token) return;

    try {
      var res = await fetch('/api/usuarios/me/avatar', {
        credentials: 'include',
        headers: authHeader()
      });
      if (!res.ok) return;
      var blob = await res.blob();
      var reader = new FileReader();
      await new Promise(function(resolve){
        reader.onloadend = resolve;
        reader.readAsDataURL(blob);
      });
      var dataURL = reader.result;
      if (typeof dataURL === 'string') {
        try { LS.setItem('usuario_avatar', dataURL); } catch (e) {}
        _dispatchAuthChange();
      }
    } catch (e) {}
  }

  // ======= logout =======
  async function logout(opts) {
    opts = opts || {};
    var redirect = opts.redirect || LOGIN_URL;
    try { await fetch(LOGOUT_URL, { method: 'POST', credentials: 'include' }); } catch (e) {}
    clearAuth();
    location.href = redirect;
  }

  // ======= EventBus simples =======
  function _dispatchAuthChange() {
    try {
      var ev = new CustomEvent('auth:change', {
        detail: { token: getToken(), empresa_id: getEmpresaId(), usuario_nome: getUserName() }
      });
      window.dispatchEvent(ev);
    } catch (e) {}
  }

  // sync multi-abas
  window.addEventListener('storage', function(e){
    if (!e || !e.key) return;
    var watched = {
      token:1, access_token:1, refresh_token:1, empresa_id:1,
      usuario:1, usuario_nome:1, usuario_email:1, usuario_avatar:1, avatar_url:1,
      nome:1, email:1, departamento:1
    };
    if (watched[e.key]) _dispatchAuthChange();
  });

  // ======= Permissões & Rotas =======
  var ROUTES_BY_PERM = [
    ['dashboard.ver',          '/dashboard'],
    ['atendimento.ver',        '/atendimentos'],
    ['clientes.ver',           '/clientes'],
    ['chatinterno.ver',        '/chat-interno'],
    ['usuarios.gerenciar',     '/usuarios'],
    ['colaboradores.gerenciar','/colaboradores'],
    ['departamentos.gerenciar','/departamentos'],
    ['configuracoes.editar',   '/configuracoes'],
    ['integracoes.whatsapp',   '/integracoes/whatsapp']
  ];

  async function _fetchMinhasPerms(authHeaders) {
    authHeaders = authHeaders || {};
    var headers = { 'Accept': 'application/json' };
    for (var k in authHeaders){ headers[k]=authHeaders[k]; }
    var res = await fetch('/api/permissoes/minhas', { credentials: 'include', headers: headers });
    if (!res.ok) throw new Error(String(res.status));
    var data = await res.json().catch(function(){ return []; });
    return Array.isArray(data) ? data : (Array.isArray(data && data.permissoes) ? data.permissoes : []);
  }

  function _pickFirstAllowed(perms) {
    for (var i=0;i<ROUTES_BY_PERM.length;i++){
      var need = ROUTES_BY_PERM[i][0], route = ROUTES_BY_PERM[i][1];
      if (perms.indexOf(need) !== -1) return route;
    }
    return null;
  }

  async function firstAllowedRoute() {
    try {
      var token = getToken();
      var empresa = getEmpresaId();
      var headers = {};
      if (token) headers.Authorization = 'Bearer ' + token;
      if (empresa) headers['X-Empresa-Id'] = String(empresa);
      var perms = await _fetchMinhasPerms(headers);
      var dest = _pickFirstAllowed(perms);
      return dest || '/frontend/sem-permissao.html';
    } catch (e) {
      return '/sem-permissao';
    }
  }

  async function denyAndExit(msg, opts) {
    msg = msg || 'Sem permissão';
    opts = opts || {};
    var scope = opts.scope || 'body';
    var delay = (opts.delay || 900);

    try {
      if (window.PageLoading && typeof window.PageLoading.show === 'function') {
        window.PageLoading.show(msg, { scope: scope });
      }
    } catch (e) {}

    var dest = await firstAllowedRoute();
    setTimeout(function(){
      try {
        var ref = document.referrer || '';
        var sameOrigin = false;
        try { sameOrigin = (ref && new URL(ref).origin === location.origin); } catch (e) {}
        if (sameOrigin && history.length > 1) {
          history.back();
        } else {
          location.replace(dest);
        }
      } catch (e) {
        location.replace(dest);
      }
    }, delay);
  }

  async function ensurePerm(permRequired, opts) {
    opts = opts || {};
    var autoHandle = (opts.autoHandle !== false);
    var msg = opts.msg || 'Sem permissão';
    try {
      var token = getToken();
      var empresa = getEmpresaId();
      var headers = {};
      if (token) headers.Authorization = 'Bearer ' + token;
      if (empresa) headers['X-Empresa-Id'] = String(empresa);
      var list = await _fetchMinhasPerms(headers);
      var ok = list.indexOf(permRequired) !== -1;
      if (!ok && autoHandle) await denyAndExit(msg);
      return ok;
    } catch (e) {
      if (autoHandle) await denyAndExit(msg);
      return false;
    }
  }

  async function guardFetch(input, init){
    var r = await authFetch(input, init || {});
    if (r.status === 401 || r.status === 403) {
      await denyAndExit('Sem permissão');
      throw new Error(String(r.status));
    }
    return r;
  }

  async function routeAfterLogin() {
    var params = new URLSearchParams(location.search || '');
    var next = params.get('next');
    if (next && /^\/[^\s]*$/.test(next)) {
      location.replace(next);
      return;
    }
    var dest = await firstAllowedRoute();
    location.replace(dest);
  }

  // ======= Expor global =======
  window.ZAuth = {
    saveAuth: saveAuth, clearAuth: clearAuth,
    requireAuth: requireAuth, softEnsureAuth: softEnsureAuth,
    authFetch: authFetch, authHeader: authHeader,
    getToken: getToken, getEmpresaId: getEmpresaId, getUserName: getUserName,
    logout: logout, fetchMeWithCookie: fetchMeWithCookie, tryFetchAndCacheAvatar: tryFetchAndCacheAvatar,
    ensurePerm: ensurePerm, guardFetch: guardFetch, denyAndExit: denyAndExit, firstAllowedRoute: firstAllowedRoute, routeAfterLogin: routeAfterLogin,
    consts: { LOGIN_URL: LOGIN_URL, INICIO_URL: INICIO_URL, ME_URL: ME_URL, LOGOUT_URL: LOGOUT_URL },
    _internals: { _fetchMinhasPerms: _fetchMinhasPerms, _pickFirstAllowed: _pickFirstAllowed, ROUTES_BY_PERM: ROUTES_BY_PERM }
  };

  // Alias compatível
  window.Auth = window.ZAuth;
})();
