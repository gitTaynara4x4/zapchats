// /frontend/js/ui-components.js
(function (global) {
  'use strict';

  /* ==============================
     UTILIDADES BÁSICAS
  =============================== */
  const LS = window.localStorage;

  function safeJSONParse(s) {
    try { return JSON.parse(s); } catch { return null; }
  }
  function pickLS(...keys) {
    for (const k of keys) {
      try {
        const v = LS.getItem(k);
        if (!v) continue;
        if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
          const j = safeJSONParse(v);
          if (j) return j;
        }
        return v;
      } catch {}
    }
    return '';
  }

  /* ==============================
     LOGOUT — ATALHO + BINDERS
     (usa ZAuth.logout se existir)
  =============================== */
  function logout(redirect = '/login.html') {
    if (global.ZAuth?.logout) {
      return global.ZAuth.logout({ redirect });
    }
    // fallback defensivo (se ZAuth não carregou)
    try {
      [
        'token','access_token','refresh_token','empresa_id',
        'usuario_id','usuario_nome','usuario_email','usuario_avatar','avatar_url',
        'nome','email','departamento',
        'usuario','user','me','auth_user','profile','auth'
      ].forEach(k => { try { LS.removeItem(k); } catch {} });
      try { sessionStorage.clear(); } catch {}
    } catch {}
    location.href = redirect;
  }

  function bindLogout(selector, redirect) {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el || el.dataset.boundLogout) return;
    el.dataset.boundLogout = '1';
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      logout(redirect || el.getAttribute('href') || '/login.html');
    });
  }

  // data-logout: <a data-logout href="/login.html">Sair</a>
  function autobindLogout(root = document) {
    root.querySelectorAll('[data-logout]:not([data-bound-logout])').forEach(el => {
      el.dataset.boundLogout = '1';
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        const redirect = el.getAttribute('href') || '/login.html';
        logout(redirect);
      });
    });
  }

  /* ==============================
     THEME TOGGLE (claro/escuro)
     — mesmo markup do mobile/desktop
  =============================== */
  function initThemeToggle(btn) {
    if (!btn) return;
    const html = document.documentElement;

    const current = () => html.classList.contains('dark') ? 'dark' : 'light';
    const set = (t) => {
      html.classList.toggle('dark', t === 'dark');
      try { LS.setItem('theme', t); } catch {}
      btn.setAttribute('aria-pressed', String(t === 'dark'));
      // animação opcional (se tiver classe .t-anim no CSS)
      btn.classList.remove('t-anim'); void btn.offsetWidth; btn.classList.add('t-anim');
      setTimeout(() => btn.classList.remove('t-anim'), 580);
      // broadcast leve
      window.dispatchEvent(new CustomEvent('app:theme-change', { detail: { theme: t } }));
    };

    // estado inicial (respeita storage)
    const saved = LS.getItem('theme') || current();
    set(saved);

    btn.addEventListener('click', () => set(current() === 'dark' ? 'light' : 'dark'));
    window.addEventListener('storage', (e) => {
      if (e.key === 'theme' && e.newValue) set(e.newValue);
    });
  }

  /* ==============================
     USER CHIP — preenche avatar/nome
     compatível com seus sidebars
  =============================== */
  function initUserChip(root) {
    if (!root) return;
    const label = root.querySelector('.user-email');
    const img   = root.querySelector('.avatar');
    const icon  = root.querySelector('#userIcon'); // opcional

    function jwtInfo() {
      try {
        const tok = pickLS('access_token','token');
        if (!tok || typeof tok !== 'string' || !tok.includes('.')) return {};
        const b64 = tok.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
        const json = decodeURIComponent(atob(b64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
        return JSON.parse(json) || {};
      } catch { return {}; }
    }

    function getAvatar() {
      let a = LS.getItem('usuario_avatar') || LS.getItem('avatar_url') || '';
      if (!a) { const jwt = jwtInfo(); a = jwt.picture || ''; }
      return a || '';
    }

    function info() {
      const obj  = pickLS('usuario','user','me','auth_user','profile','auth') || {};
      const jwt  = jwtInfo();
      const nome = (LS.getItem('usuario_nome') || LS.getItem('nome') || obj.nome || obj.name || jwt.name || jwt.given_name || '').trim();
      const dept = (LS.getItem('departamento') || obj.departamento || '').trim();
      const email= (LS.getItem('usuario_email') || LS.getItem('email') || obj.email || jwt.email || jwt.preferred_username || '').trim();
      return { nome, dept, email };
    }

    function render() {
      const u = info();
      const txt = [u.nome, u.dept].filter(Boolean).join(' · ') || u.email || 'Usuário';
      if (label) label.textContent = txt;
      const av = getAvatar();
      if (img) {
        if (av) { img.src = av; img.style.display = 'block'; if (icon) icon.style.display = 'none'; }
        else { img.removeAttribute('src'); img.style.display = 'none'; if (icon) icon.style.display = ''; }
      }
    }

    render();

    // re-render quando storage mudar
    window.addEventListener('storage', (e) => {
      if (!e.key) return;
      if ([
        'usuario_nome','nome','displayName',
        'departamento','usuario_departamento',
        'usuario_email','email',
        'usuario_avatar','avatar_url',
        'token','access_token'
      ].includes(e.key)) render();
    });

    // evento de click para abrir modal de perfil (se a página escutar)
    root.addEventListener('click', () => root.dispatchEvent(new CustomEvent('userchip:open')));
    root.setAttribute('role','button');
    root.setAttribute('tabindex','0');
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); root.click(); }
    });
  }

  /* ==============================
     ACTIVE LINK + PREFETCH
  =============================== */
  function initActiveLinks(scope) {
    const cont = typeof scope === 'string' ? document.querySelector(scope) : (scope || document);
    if (!cont) return;
    const now = location.pathname.replace(/\/+$/,'');
    const file= now.split('/').pop();

    cont.querySelectorAll('a[href]').forEach(a => {
      try {
        const p = new URL(a.getAttribute('href'), location.origin).pathname.replace(/\/+$/,'');
        const f = p.split('/').pop();
        if (p === now || f === file) { a.classList.add('active'); a.setAttribute('aria-current','page'); }
      } catch {}

      a.addEventListener('mouseenter', () => {
        try {
          const u = new URL(a.getAttribute('href'), location.origin);
          if (u.origin === location.origin) {
            const l = document.createElement('link');
            l.rel = 'prefetch'; l.href = u.href;
            document.head.appendChild(l);
          }
        } catch {}
      }, { once:true });
    });
  }

  /* ==============================
     EXPORTA NO NAMESPACE GLOBAL
  =============================== */
  global.UI = Object.assign(global.UI || {}, {
    // Logout
    logout, bindLogout, autobindLogout,
    // UI helpers
    initThemeToggle, initUserChip, initActiveLinks
  });

})(window);
