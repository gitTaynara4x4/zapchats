// /frontend/js/pages/login.js

// === Guard: se já está logado (pelos COOKIES), não mostra /login ===
(function alreadyLoggedGuard(){
  function hasCookie(name){
    try {
      var re = new RegExp('(?:^|;\\s*)' + name.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&') + '=');
      return re.test(document.cookie || '');
    } catch (e) { return false; }
  }
  function hasSessionCookie() {
    // backend grava 'empresa_id' (legível). 'access_token' é httpOnly.
    return hasCookie('empresa_id');
  }
  function redirectHome(){
    var params = new URLSearchParams(location.search || '');
    var next = params.get('next');
    var target = (next && /^\/[^\s]*$/.test(next)) ? next : '/dashboard';
    window.location.replace(target);
  }

  if (hasSessionCookie()) redirectHome();

  window.addEventListener('pageshow', function (e) {
    var nav = (performance && performance.getEntriesByType) ? performance.getEntriesByType('navigation') : null;
    var backForward = !!(nav && nav[0] && nav[0].type === 'back_forward');
    if (e.persisted || backForward) {
      if (hasSessionCookie()) redirectHome();
    }
  });
})();

// === Toggle de tema ===
(function(){
  var html = document.documentElement;
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'dark') html.classList.add('dark');
    if (saved === 'light') html.classList.remove('dark');
  } catch (e) {}

  function setPressed(btn){
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(html.classList.contains('dark')));
  }
  function setTheme(mode){
    var willDark = (mode === 'dark');
    html.classList.toggle('dark', willDark);
    try { localStorage.setItem('theme', willDark ? 'dark' : 'light'); } catch (e) {}
  }

  window.addEventListener('storage', function(e){
    if (e && e.key === 'theme') {
      var v = (e.newValue || '').toLowerCase();
      setTheme(v === 'dark' ? 'dark' : 'light');
      setPressed(document.getElementById('themeSwitch'));
    }
  });

  var btn = document.getElementById('themeSwitch');
  if (btn){
    setPressed(btn);
    btn.addEventListener('click', function(){
      var willDark = !html.classList.contains('dark');
      setTheme(willDark ? 'dark' : 'light');
      btn.classList.remove('t-anim'); void btn.offsetWidth; btn.classList.add('t-anim');
      setTimeout(function(){ btn.classList.remove('t-anim'); }, 580);
      setPressed(btn);
    });
  }
})();

// === Mostrar/Ocultar senha ===
(function(){
  var btn = document.getElementById('togglePassBtn');
  var input = document.getElementById('senha');
  var eyeOpen = document.getElementById('eye-open');
  var eyeOff  = document.getElementById('eye-off');

  function updateIcon(){
    var isPassword = input && input.type === 'password';
    if (eyeOpen) eyeOpen.classList.toggle('hidden', !isPassword);
    if (eyeOff)  eyeOff.classList.toggle('hidden', isPassword);
    if (btn) btn.setAttribute('aria-label', isPassword ? 'Mostrar senha' : 'Ocultar senha');
  }

  if (btn && input) {
    btn.addEventListener('click', function(){
      input.type = input.type === 'password' ? 'text' : 'password';
      updateIcon();
    });
    updateIcon();
  }
})();

// === util: extrai picture do JWT se existir ===
function jwtPictureFrom(token) {
  try {
    var base = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    var json = atob(base);
    var payload = JSON.parse(json);
    return (payload && payload.picture) ? String(payload.picture) : '';
  } catch (e) { return ''; }
}

// === baixa/salva avatar ===
async function cacheAvatar(d) {
  if (d && d.avatar_url) { try { localStorage.setItem('usuario_avatar', d.avatar_url); } catch (e) {} return; }
  var token = localStorage.getItem('access_token') || localStorage.getItem('token') || '';
  var pic = token ? jwtPictureFrom(token) : '';
  if (pic) { try { localStorage.setItem('usuario_avatar', pic); } catch (e) {} return; }
  try {
    var res = await fetch('/api/usuarios/me/avatar', {
      credentials: 'include',
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    });
    if (!res.ok) return;
    var blob = await res.blob();
    await new Promise(function(resolve){
      var reader = new FileReader();
      reader.onloadend = function(){ try { localStorage.setItem('usuario_avatar', reader.result); } catch (e) {} resolve(); };
      reader.readAsDataURL(blob);
    });
  } catch (e) {}
}

// === UI helpers ===
function notifyWarn(msg){
  var box = document.getElementById('erro');
  if (box){ box.textContent = msg; box.classList.remove('hidden'); }
}
function clearNotify(){
  var box = document.getElementById('erro');
  if (box){ box.textContent = ''; box.classList.add('hidden'); }
}

// === Lock local por e-mail ===
var LS_LOCK_KEY = function(email){ return 'login:lock:' + ((email||'').toLowerCase()); };
function setLocalLock(email, seconds){
  var until = Math.floor(Date.now()/1000) + Math.max(1, seconds|0);
  try { localStorage.setItem(LS_LOCK_KEY(email), String(until)); } catch (e) {}
}
function isLocked(email){
  try {
    var raw = localStorage.getItem(LS_LOCK_KEY(email));
    if (!raw) return false;
    var until = parseInt(raw, 10) || 0;
    var now = Math.floor(Date.now()/1000);
    return now < until;
  } catch (e) { return false; }
}
function clearLocalLock(email){ try { localStorage.removeItem(LS_LOCK_KEY(email)); } catch (e) {} }

// === Validação detalhada do e-mail (mensagens amigáveis) ===
function emailValidationMessage(raw){
  var s = (raw || '').trim();
  if (!s) return 'Digite seu e-mail.';
  if (/\s/.test(s)) return 'E-mail não pode conter espaços.';
  var atCount = (s.match(/@/g)||[]).length;
  if (atCount === 0) return 'Falta o "@" no e-mail.';
  if (atCount > 1) return 'Só pode haver um "@".';

  var parts = s.split('@');
  var local = parts[0], domain = parts[1];
  if (!local) return 'Antes do "@" precisa ter algo.';
  if (!domain) return 'Depois do "@" precisa ter o domínio.';
  if (domain.indexOf('.') === -1) return 'O domínio precisa ter ponto (ex.: gmail.com).';

  var tld = domain.split('.').pop();
  if (!tld || tld.length < 2) return 'TLD muito curto (ex.: ".com", ".br").';

  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return 'Domínio contém caracteres inválidos.';
  if (domain.charAt(0) === '-' || domain.slice(-1) === '-') return 'Domínio não pode começar/terminar com "-".';

  return '';
}

function showEmailHelp(msg){
  var help  = document.getElementById('email-help');
  var input = document.getElementById('email');
  if (!help || !input) return;

  help.textContent = msg;
  help.style.color = msg ? '#ef4444' : '';
  input.classList.toggle('is-invalid', !!msg);

  try { input.setCustomValidity(''); } catch (e) {}
}

// Wire da validação do e-mail
(function wireEmailValidation(){
  var input = document.getElementById('email');
  if (!input) return;

  input.type = 'email';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.inputMode = 'email';
  input.autocomplete = input.autocomplete || 'username';

  var handler = function () {
    var msg = emailValidationMessage(input.value);
    showEmailHelp(msg);
  };

  input.addEventListener('input', handler);
  input.addEventListener('blur', handler);
  handler();
})();

// === Submit (2 etapas: senha → token opcional) ===
(function(){
  var form = document.getElementById('form-login');
  var erro = document.getElementById('erro');
  var btn  = document.getElementById('btn-login');
  var emailInput = document.getElementById('email');
  var senhaInput = document.getElementById('senha');
  var rememberInput = document.getElementById('remember');

  var step1 = document.getElementById('step1-fields');
  var step2 = document.getElementById('step2-fields');
  var tokenInput = document.getElementById('login-token');

  var currentStep = 1;
  var tokenEmail = null;
  var tokenRemember = false;

  if (!form) return;

  try { form.setAttribute('novalidate',''); } catch (e) {}

  (function prefillRemember(){
    try {
      var remembered = localStorage.getItem('remember_login') === '1';
      if (rememberInput) rememberInput.checked = remembered;
      var rememberedEmail = localStorage.getItem('remember_email') || '';
      if (remembered && rememberedEmail && emailInput && !emailInput.value) {
        emailInput.value = rememberedEmail;
        showEmailHelp(emailValidationMessage(emailInput.value));
      }
    } catch (e) {}
  })();

  function disable(){ if(btn){ btn.disabled = true; } }
  function enable(){ if(btn){ btn.disabled = false; btn.textContent = (currentStep === 1 ? 'Entrar' : 'Confirmar código'); } }

  function applyLockState(){
    var vEmail = (emailInput && emailInput.value) ? emailInput.value : '';
    var email = vEmail.trim().toLowerCase();
    if (!email){ enable(); clearNotify(); return; }
    if (isLocked(email)){
      notifyWarn('Muitas tentativas. Tente novamente mais tarde.');
      disable();
    } else {
      clearNotify();
      enable();
    }
  }
  if (emailInput) emailInput.addEventListener('input', applyLockState);
  applyLockState();

  function goToStep(step){
    currentStep = step;
    if (step1) step1.classList.toggle('hidden', step !== 1);
    if (step2) step2.classList.toggle('hidden', step !== 2);
    if (btn){
      btn.textContent = (step === 1 ? 'Entrar' : 'Confirmar código');
    }
    if (step === 2 && tokenInput){
      tokenInput.value = '';
      try { tokenInput.focus(); } catch (e) {}
    }
  }

  var btnBack = document.getElementById('btn-token-back');
  if (btnBack){
    btnBack.addEventListener('click', function(){
      tokenEmail = null;
      tokenRemember = false;
      goToStep(1);
      applyLockState();
    });
  }

  async function finalizeLoginSuccess(d, email, remember){
    var token = d.access_token || d.token || '';
    if (token) {
      try {
        localStorage.setItem('access_token', token);
        localStorage.setItem('token', token);
      } catch (e) {}
    }
    var empresaId = (d.hasOwnProperty('empresaId') && d.empresaId !== null) ? d.empresaId : d.empresa_id;
    if (empresaId !== undefined && empresaId !== null) {
      try { localStorage.setItem('empresa_id', String(empresaId)); } catch (e) {}
    }

    try { localStorage.setItem('email', email); } catch (e) {}
    if (d && d.nome) {
      try { localStorage.setItem('nome', d.nome); } catch (e) {}
    }

    var cargoOuRole = d ? (d.cargo || d.role) : null;
    if (cargoOuRole) {
      try {
        localStorage.setItem('usuario_role', cargoOuRole);
        localStorage.setItem('role', cargoOuRole);
      } catch (e) {}
    }

    if (d && d.avatar_url) {
      try { localStorage.setItem('usuario_avatar', d.avatar_url); } catch (e) {}
    }
    await cacheAvatar(d);

    clearLocalLock(email);

    try {
      if (remember) {
        localStorage.setItem('remember_login', '1');
        localStorage.setItem('remember_email', email);
      } else {
        localStorage.removeItem('remember_login');
        localStorage.removeItem('remember_email');
      }
    } catch (e) {}

    if (window.ZAuth && typeof window.ZAuth.routeAfterLogin === 'function') {
      window.ZAuth.routeAfterLogin();
      return;
    }
    var params = new URLSearchParams(window.location.search || '');
    var next = params.get('next');
    var target = (next && /^\/[^\s]*$/.test(next)) ? next : '/dashboard';
    window.location.replace(target);
  }

  form.addEventListener('submit', async function(e){
    e.preventDefault();
    clearNotify();

    // === PASSO 1: e-mail + senha ===
    if (currentStep === 1){
      var vEmail = (emailInput && emailInput.value) ? emailInput.value : '';
      var emailMsg = emailValidationMessage(vEmail);
      if (emailMsg){
        showEmailHelp(emailMsg);
        enable();
        if (emailInput) emailInput.focus();
        return;
      }

      var email = vEmail.trim().replace(/\s/g,'').toLowerCase();
      var senha = (senhaInput && senhaInput.value) ? senhaInput.value.trim() : '';
      var remember = !!(rememberInput && !!rememberInput.checked);

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
        var res = await fetch('/api/auth/login', {
          method : 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body   : JSON.stringify({ email: email, senha: senha, remember: remember })
        });

        if (res.status === 422) {
          var msg = 'Dados inválidos.';
          var emailErrText = 'E-mail inválido.';
          try {
            var err = await res.json();
            var arr = Array.isArray(err && err.detail) ? err.detail : [];
            var emailErr = null;
            for (var i=0;i<arr.length;i++){
              if (arr[i] && arr[i].loc && arr[i].loc.indexOf && arr[i].loc.indexOf('email') !== -1) { emailErr = arr[i]; break; }
            }
            if (emailErr && emailErr.msg) {
              emailErrText = 'E-mail inválido: ' + emailErr.msg;
              msg = emailErrText;
            } else if (arr.length) {
              var parts = [];
              for (var j=0;j<arr.length;j++){ if (arr[j] && arr[j].msg) parts.push(arr[j].msg); }
              msg = parts.join('\n') || msg;
            } else if (err && typeof err.detail === 'string') {
              msg = err.detail;
            }
          } catch (e) {}
          showEmailHelp(emailErrText);
          notifyWarn(msg);
          enable();
          return;
        }

        if (res.status === 401) {
          var msg401 = 'E-mail e/ou senha incorretos.';
          try { var err401 = await res.json(); if (err401 && typeof err401.detail === 'string') msg401 = err401.detail; } catch (e) {}
          notifyWarn(msg401);
          enable();
          return;
        }

        if (res.status === 404){
          notifyWarn('E-mail não cadastrado.');
          enable();
          return;
        }

        if (res.status === 429){
          var retry = 60;
          try {
            var ra = parseInt(res.headers.get('Retry-After') || '60', 10);
            if (isFinite(ra) && ra > 0) retry = ra;
          } catch (e) {}
          setLocalLock(email, retry);
          notifyWarn('Muitas tentativas. Tente novamente mais tarde.');
          disable();
          return;
        }

        if (!res.ok) {
          var msgGen = 'Credenciais inválidas';
          try {
            var errGen = await res.json();
            if (errGen && typeof errGen.detail === 'string') msgGen = errGen.detail;
            else if (errGen && Array.isArray(errGen.detail)) {
              var parts2 = [];
              for (var k=0;k<errGen.detail.length;k++){ if (errGen.detail[k] && errGen.detail[k].msg) parts2.push(errGen.detail[k].msg); }
              msgGen = parts2.join('\n') || msgGen;
            }
          } catch (e) {}
          notifyWarn(msgGen);
          enable();
          return;
        }

        // ====== SUCESSO ======
        var d = await res.json().catch(function(){ return {}; });

        // Se a empresa exigir token de login, servidor responde require_token=true
        if (d && d.require_token){
          tokenEmail = email;
          tokenRemember = remember;
          var info = d.mensagem || 'Enviamos um código de acesso para o seu e-mail.';
          var infoEl = document.getElementById('token-info');
          if (infoEl) infoEl.textContent = info;
          notifyWarn('Digite o código enviado para o seu e-mail para concluir o acesso.');
          goToStep(2);
          enable();
          return;
        }

        // Caso normal (sem segundo fator)
        await finalizeLoginSuccess(d, email, remember);

      } catch (err) {
        console.error(err);
        if (erro) { erro.textContent = 'Erro de conexão com o servidor'; erro.classList.remove('hidden'); }
        enable();
      }
      return;
    }

    // === PASSO 2: confirmação do código ===
    var email2 = tokenEmail || ((emailInput && emailInput.value) ? emailInput.value.trim().toLowerCase() : '');
    if (!email2){
      notifyWarn('E-mail inválido. Volte e tente novamente.');
      goToStep(1);
      return;
    }

    var codigo = (tokenInput && tokenInput.value) ? tokenInput.value.trim() : '';
    if (!codigo){
      notifyWarn('Digite o código de acesso enviado para o seu e-mail.');
      return;
    }

    disable();
    if (btn) btn.textContent = 'Confirmando…';

    try {
      var res2 = await fetch('/api/auth/login/token', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email2, token: codigo, remember: !!tokenRemember })
      });

      if (res2.status === 400 || res2.status === 401){
        var msgBad = 'Código inválido ou expirado.';
        try {
          var errBad = await res2.json();
          if (errBad && typeof errBad.detail === 'string') msgBad = errBad.detail;
        } catch (e) {}
        notifyWarn(msgBad);
        enable();
        return;
      }

      if (!res2.ok){
        var msgGen2 = 'Não foi possível validar o código.';
        try {
          var errGen2 = await res2.json();
          if (errGen2 && typeof errGen2.detail === 'string') msgGen2 = errGen2.detail;
        } catch (e) {}
        notifyWarn(msgGen2);
        enable();
        return;
      }

      var d2 = await res2.json().catch(function(){ return {}; });
      await finalizeLoginSuccess(d2, email2, !!tokenRemember);

    } catch (err2){
      console.error(err2);
      if (erro) { erro.textContent = 'Erro de conexão com o servidor'; erro.classList.remove('hidden'); }
      enable();
    }
  });
})();
