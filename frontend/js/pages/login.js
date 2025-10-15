// === Guard: se já está logado, não mostra /login ===
(function alreadyLoggedGuard(){
  function hasSessionCookie() {
<<<<<<< HEAD
=======
    // ajuste o nome do cookie se o backend usar outro
>>>>>>> cc1c9ef3faf532d258ae883f638e5fa6d47dd4f1
    return /(?:^|;\s*)session=/.test(document.cookie);
  }
  function redirectHome(){
    const params = new URLSearchParams(location.search);
    const next = params.get('next');
    const target = next && /^\/[^\s]*$/.test(next) ? next : '/dashboard';
    window.location.replace(target);
  }
  const hasToken = !!(localStorage.getItem('access_token') || localStorage.getItem('token'));
  if (hasToken || hasSessionCookie()) redirectHome();
  window.addEventListener('pageshow', function (e) {
    if (e.persisted || performance.getEntriesByType('navigation')[0]?.type === 'back_forward') {
      const againHasToken = !!(localStorage.getItem('access_token') || localStorage.getItem('token')) || hasSessionCookie();
      if (againHasToken) redirectHome();
    }
  });
})();

<<<<<<< HEAD
// ===== Tema (robusto, sem Tailwind) =====
(() => {
  const html = document.documentElement;
=======
// === Toggle de tema ===
(function(){
  const html = document.documentElement;

  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') html.classList.add('dark');
    if (saved === 'light') html.classList.remove('dark');
  } catch {}
>>>>>>> cc1c9ef3faf532d258ae883f638e5fa6d47dd4f1

  function apply(mode) {
    const dark = mode === 'dark';
    html.classList.toggle('dark', dark);
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch {}
    const btn = document.getElementById('themeSwitch');
    if (btn) btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }

  // Estado inicial (salvo ou prefers-color-scheme)
  (function initEarly() {
    try {
      let saved = localStorage.getItem('theme');
      if (!saved) {
        saved = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches)
          ? 'dark' : 'light';
      }
      apply(saved === 'dark' ? 'dark' : 'light');
    } catch {}
  })();

  function wire() {
    const btn = document.getElementById('themeSwitch');
    if (!btn) return;
<<<<<<< HEAD
    btn.setAttribute('aria-pressed', html.classList.contains('dark') ? 'true' : 'false');
    btn.addEventListener('click', () => {
      const next = html.classList.contains('dark') ? 'light' : 'dark';
=======
    btn.setAttribute('aria-pressed', String(html.classList.contains('dark')));
  }
  function setTheme(mode){
    const willDark = (mode === 'dark');
    html.classList.toggle('dark', willDark);
    try { localStorage.setItem('theme', willDark ? 'dark' : 'light'); } catch {}
  }

  window.addEventListener('storage', function(e){
    if (e.key === 'theme') {
      const v = (e.newValue || '').toLowerCase();
      setTheme(v === 'dark' ? 'dark' : 'light');
      setPressed(document.getElementById('themeSwitch'));
    }
  });

  const btn = document.getElementById('themeSwitch');
  if (btn){
    setPressed(btn);
    btn.addEventListener('click', function(){
      const willDark = !html.classList.contains('dark');
      setTheme(willDark ? 'dark' : 'light');
>>>>>>> cc1c9ef3faf532d258ae883f638e5fa6d47dd4f1
      btn.classList.remove('t-anim'); void btn.offsetWidth; btn.classList.add('t-anim');
      setTimeout(() => btn.classList.remove('t-anim'), 580);
      apply(next);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  window.addEventListener('storage', (e) => {
    if (e.key === 'theme') {
      const v = (e.newValue || '').toLowerCase();
      apply(v === 'dark' ? 'dark' : 'light');
    }
  });
})();

// === Mostrar/Ocultar senha (sincroniza ícones) ===
(function(){
  const btn = document.getElementById('togglePassBtn');
  const input = document.getElementById('senha');
  const eyeOpen = document.getElementById('eye-open');
  const eyeOff  = document.getElementById('eye-off');

  function updateIcon(){
    const isPassword = input.type === 'password';
    eyeOpen?.classList.toggle('hidden', !isPassword);
    eyeOff?.classList.toggle('hidden', isPassword);
    btn?.setAttribute('aria-label', isPassword ? 'Mostrar senha' : 'Ocultar senha');
  }

  if (btn && input) {
    btn.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      updateIcon();
    });
    updateIcon();
  }
})();

// === util: extrai picture do JWT se existir ===
function jwtPictureFrom(token) {
  try {
    const base = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base);
    const payload = JSON.parse(json);
    return payload && payload.picture ? String(payload.picture) : '';
  } catch { return ''; }
}

// === baixa/salva avatar ===
async function cacheAvatar(d) {
  if (d && d.avatar_url) { try { localStorage.setItem('usuario_avatar', d.avatar_url); } catch {} return; }
  const token = localStorage.getItem('access_token') || localStorage.getItem('token') || '';
  const pic = token ? jwtPictureFrom(token) : '';
  if (pic) { try { localStorage.setItem('usuario_avatar', pic); } catch {} return; }
  try {
    const res = await fetch('/api/usuarios/me/avatar', {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) return;
    const blob = await res.blob();
    await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => { try { localStorage.setItem('usuario_avatar', reader.result); } catch {} resolve(); };
      reader.readAsDataURL(blob);
    });
  } catch {}
}

// === UI helpers ===
function notifyWarn(msg){
  if (typeof window.showToast === 'function') { try { showToast(msg, 'warn'); return; } catch {} }
  const box = document.getElementById('erro');
  if (box){ box.textContent = msg; box.classList.add('show'); }
}
function clearNotify(){
  if (typeof window.hideToast === 'function') { try { hideToast(); return; } catch {} }
  const box = document.getElementById('erro');
  if (box){ box.textContent = ''; box.classList.remove('show'); }
}

// === Lock local por e-mail ===
const LS_LOCK_KEY = (email) => `login:lock:${(email||'').toLowerCase()}`;
function setLocalLock(email, seconds){
  const until = Math.floor(Date.now()/1000) + Math.max(1, seconds|0);
  try { localStorage.setItem(LS_LOCK_KEY(email), String(until)); } catch {}
}
function isLocked(email){
  try {
    const raw = localStorage.getItem(LS_LOCK_KEY(email));
    if (!raw) return false;
    const until = parseInt(raw, 10) || 0;
    const now = Math.floor(Date.now()/1000);
    return now < until;
  } catch { return false; }
}
function clearLocalLock(email){ try { localStorage.removeItem(LS_LOCK_KEY(email)); } catch {} }

// === Submit ===
(function(){
  const form = document.getElementById('form-login');
  const erro = document.getElementById('erro');
  const btn  = document.getElementById('btn-login');
  const emailInput = document.getElementById('email');
  const senhaInput = document.getElementById('senha');
  const rememberInput = document.getElementById('remember');

  if (!form) return;

  (function prefillRemember(){
    try {
      const remembered = localStorage.getItem('remember_login') === '1';
      if (rememberInput) rememberInput.checked = remembered;
      const rememberedEmail = localStorage.getItem('remember_email') || '';
      if (remembered && rememberedEmail && emailInput && !emailInput.value) {
        emailInput.value = rememberedEmail;
      }
    } catch {}
  })();

  function disable(){ if(btn){ btn.disabled = true; btn.classList.add('cursor-not-allowed'); } }
  function enable(){ if(btn){ btn.disabled = false; btn.textContent = 'Entrar'; } }

  function applyLockState(){
    const email = (emailInput?.value || '').trim().toLowerCase();
    if (!email){ enable(); clearNotify(); return; }
    if (isLocked(email)){
      notifyWarn('Muitas tentativas. Tente novamente mais tarde.');
      disable();
    } else {
      clearNotify();
      enable();
    }
  }
  emailInput?.addEventListener('input', applyLockState);
  applyLockState();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearNotify();

    const email = (emailInput?.value || '').trim().replace(/\s/g,'').toLowerCase();
    const senha = (senhaInput?.value || '').trim();
    const remember = !!(rememberInput && rememberInput.checked);

    if (!email || !senha){
      notifyWarn('Preencha e-mail e senha.');
      return;
    }

    if (isLocked(email)){
      notifyWarn('Muitas tentativas. Tente novamente mais tarde.');
      disable();
      return;
    }

    disable();
    if (btn) btn.textContent = 'Entrando…';

    try {
      const res = await fetch('/api/auth/login', {
        method : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ email, senha, remember })
      });

      if (!res.ok) {
        if (res.status === 429){
          let retry = 60;
          try {
            const ra = parseInt(res.headers.get('Retry-After') || '60', 10);
            if (Number.isFinite(ra) && ra > 0) retry = ra;
          } catch {}
          setLocalLock(email, retry);
          notifyWarn('Muitas tentativas. Tente novamente mais tarde.');
          disable();
          return;
        }

        if (res.status === 404){
          notifyWarn('E-mail não cadastrado.');
          enable();
          return;
        }

        let msg = 'Credenciais inválidas';
        try { const err = await res.json(); msg = err.detail || msg; } catch {}
        if (erro) { erro.textContent = msg; erro.classList.add('show'); }
        enable();
        return;
      }

      const d = await res.json();
      const token = d.access_token || d.token || '';
      if (token) {
        localStorage.setItem('access_token', token);
        localStorage.setItem('token', token);
      }

      const empresaId = (d.empresaId ?? d.empresa_id);
      if (empresaId != null) localStorage.setItem('empresa_id', String(empresaId));

      try { localStorage.setItem('email', email); } catch {}
      if (d.nome) localStorage.setItem('nome', d.nome);

      const cargoOuRole = d.cargo || d.role;
      if (cargoOuRole) {
        localStorage.setItem('usuario_role', cargoOuRole);
        localStorage.setItem('role', cargoOuRole);
      }

      if (d.avatar_url) localStorage.setItem('usuario_avatar', d.avatar_url);
      await cacheAvatar(d);

      if (d.instance_name) {
        localStorage.setItem('instance_name', d.instance_name);
      } else if (empresaId != null) {
        try {
          const instRes = await fetch(`/api/evolution/instancia?empresa_id=${empresaId}`, {
            credentials: 'include',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
          });
          if (instRes.ok) {
<<<<<<< HEAD
            const instData = await instRes.json(); // (fix: era res.json)
=======
            // BUG corrigido: era res.json() (variável errada)
            const instData = await instRes.json();
>>>>>>> cc1c9ef3faf532d258ae883f638e5fa6d47dd4f1
            if (instData?.nome) localStorage.setItem('instance_name', instData.nome);
          }
        } catch (instErr) {
          console.error('[ERRO] Buscar instance_name', instErr);
        }
      }

      clearLocalLock(email);

      try {
        if (remember) {
          localStorage.setItem('remember_login', '1');
          localStorage.setItem('remember_email', email);
        } else {
          localStorage.removeItem('remember_login');
          localStorage.removeItem('remember_email');
        }
      } catch {}

      if (window.ZAuth?.routeAfterLogin) {
        return void window.ZAuth.routeAfterLogin();
      }
      const params = new URLSearchParams(window.location.search);
      const next = params.get('next');
      const target = next && /^\/[^\s]*$/.test(next) ? next : '/dashboard';
      window.location.replace(target);

    } catch (err) {
      console.error(err);
      notifyWarn('Erro de conexão com o servidor');
      enable();
    }
  });
})();
