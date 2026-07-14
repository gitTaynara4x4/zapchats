// /frontend/js/app-base.js
(function AppBase() {
  'use strict';

  // =========================================================
  // Ambiente: cache-busting estável (DEV agressivo, PROD fixo)
  // =========================================================
  var __DEV__ = /(^localhost$|^127\.0\.0\.1$)/.test(location.hostname);
  var __ASSET_VER__ = (window.__ASSET_VER__ || 'v1'); // mude no deploy

  function bust(u) {
    var ver = __DEV__ ? Date.now() : __ASSET_VER__;
    try {
      var x = new URL(u, location.origin);
      x.searchParams.set('_v', ver);
      return x.toString();
    } catch (e) {
      return u + (u.indexOf('?') >= 0 ? '&' : '?') + '_v=' + ver;
    }
  }

  // =========================================================
  // Helper: detecção padronizada de "layout mobile"
  // =========================================================
  function isMobileLayout() {
    if (!window.matchMedia) return false;

    var narrow = window.matchMedia('(max-width: 900px)').matches;
    var tabletTouch = window.matchMedia('(max-width: 1024px) and (pointer: coarse)').matches;

    return narrow || tabletTouch;
  }

  var IS_MOBILE = isMobileLayout();

  // =========================================================
  // Pequena animação de entrada da página (fade + up)
  // =========================================================
  function playEnterAnimation() {
    var el = document.querySelector('main, .main, [data-route-container]');
    if (!el) return;
    el.classList.remove('route-enter');
    void el.offsetWidth;
    el.classList.add('route-enter');
  }

  // =========================================================
  // Marca o shell como pronto (libera antiflash + animação)
  // =========================================================
  var __SHELL_DONE__ = false;
  function markShellReady() {
    if (__SHELL_DONE__) return;
    __SHELL_DONE__ = true;
    try { document.documentElement.classList.remove('prepaint'); } catch (e) {}
    playEnterAnimation();
    document.dispatchEvent(new Event('shell:ready'));
  }

  // =========================================================
  // Helpers gerais
  // =========================================================
  function isPublicLikePage() {
    var p = (location.pathname || '').toLowerCase();
    return (
      p === '/' ||
      p === '/inicio' || p === '/inicio.html' ||
      p === '/login' || p === '/login.html' ||
      p === '/criar-empresa' || p === '/criar-empresa' ||
      p === '/criar-empresa' || p === '/criar-empresa.html' ||
      p === '/esqueci_senha' || p === '/esqueci_senha.html' ||
      p === '/planos' || p === '/planos.html' ||
      p === '/admin-planos' || p === '/admin-planos.html'
    );
  }

  function getCookie(name) {
    try {
      var prefix = name + '=';
      var parts = document.cookie ? document.cookie.split('; ') : [];
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].indexOf(prefix) === 0) {
          return decodeURIComponent(parts[i].slice(prefix.length));
        }
      }
    } catch (e) {}
    return null;
  }

  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pluralDia(n) {
    return Number(n) === 1 ? 'dia' : 'dias';
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return String(Date.now()); }
  }

  // =========================================================
  // 0) HEAD-BASE (tokens + fontes + FA) — fonte única de tema
  // =========================================================
  var __HEAD_BASE_BOOTED__ = false;
  var HEAD_READY = null;

  async function ensureHeadBase() {
    if (__HEAD_BASE_BOOTED__) return HEAD_READY;
    __HEAD_BASE_BOOTED__ = true;

    HEAD_READY = (async function() {
      try {
        var cs = getComputedStyle(document.documentElement);
        if (cs.getPropertyValue('--shadow') && cs.getPropertyValue('--radius')) {
          document.documentElement.setAttribute('data-head-ready', '1');
          return;
        }
      } catch (e) {}

      try {
        var res = await fetch(bust('/frontend/partials/head-base.html'), {
          cache: 'no-cache',
          credentials: 'include'
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);

        var html = await res.text();
        var wrap = document.createElement('div');
        wrap.innerHTML = html;

        Array.from(wrap.querySelectorAll('style')).forEach(function(st) {
          var s = document.createElement('style');
          s.textContent = st.textContent || '';
          document.head.appendChild(s);
        });

        Array.from(wrap.querySelectorAll('link[rel="stylesheet"], link[rel="preload"]')).forEach(function(l) {
          var href = l.getAttribute('href');
          if (!href) return;

          var exists = Array.from(
            document.head.querySelectorAll('link[rel="stylesheet"], link[rel="preload"]')
          ).some(function(e) {
            return e.getAttribute('href') === href;
          });

          if (!exists) document.head.appendChild(l.cloneNode(true));
        });

        Array.from(wrap.querySelectorAll('script')).forEach(function(o) {
          var s = document.createElement('script');
          if (o.type) s.type = o.type;
          s.textContent = o.textContent || '';
          document.head.appendChild(s);
        });

        wrap.remove();
        document.documentElement.setAttribute('data-head-ready', '1');
      } catch (e) {
        console.warn('[app-base] Falha ao injetar head-base.html:', e);
        document.documentElement.setAttribute('data-head-ready', '1');
      }
    })();

    return HEAD_READY;
  }

  ensureHeadBase();

  // =========================================================
  // 1) Tema (API simples para páginas/toggles)
  // =========================================================
  try {
    var saved = localStorage.getItem('theme');
    if (saved) {
      document.documentElement.classList.toggle('dark', saved === 'dark');
    } else {
      var prefersDark = window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('dark', prefersDark);
    }

    window.AppTheme = {
      set: function(mode) {
        try { localStorage.setItem('theme', mode); } catch (e) {}
        document.documentElement.classList.toggle('dark', mode === 'dark');
      },
      current: function() {
        return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
      }
    };
  } catch (e) {}

  // =========================================================
  // Exposição opcional de helpers globais
  // =========================================================
  window.AppBaseUtils = window.AppBaseUtils || {
    bust: bust,
    isMobileLayout: isMobileLayout,
    isPublicLikePage: isPublicLikePage,
    getCookie: getCookie,
    escapeHtml: escapeHtml,
    pluralDia: pluralDia,
    nowIso: nowIso
  };

  // =========================================================
  // 2) Loader GLOBAL (injeta /frontend/partials/loading.html)
  // =========================================================
  var __LOADER_BOOTED__ = false;
  var LOADER_READY = null;

  async function ensureGlobalLoader() {
    if (__LOADER_BOOTED__) return LOADER_READY;
    __LOADER_BOOTED__ = true;

    LOADER_READY = (async function() {
      var existing = document.getElementById('page-loading') || document.getElementById('app-loading');

      if (!existing) {
        try {
          var res = await fetch('/frontend/partials/loading.html', {
            cache: 'no-cache',
            credentials: 'include'
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);

          var html = await res.text();
          var wrap = document.createElement('div');
          wrap.innerHTML = html;

          var oldPageLoading = document.getElementById('page-loading');
          var oldAppLoading = document.getElementById('app-loading');
          if (oldPageLoading) oldPageLoading.remove();
          if (oldAppLoading) oldAppLoading.remove();

          var overlay = wrap.querySelector('#page-loading, #app-loading');
          if (overlay) {
            document.body.appendChild(overlay);
            if (!overlay.style.position) overlay.style.position = 'fixed';
            if (!overlay.style.zIndex) overlay.style.zIndex = '9999';
          }

          Array.from(wrap.querySelectorAll('style')).forEach(function(st) {
            var s = document.createElement('style');
            s.textContent = st.textContent || '';
            document.head.appendChild(s);
          });

          var scripts = Array.from(wrap.querySelectorAll('script'));
          for (var i = 0; i < scripts.length; i++) {
            var o = scripts[i];
            var s = document.createElement('script');

            if (o.type) s.type = o.type;

            ['crossorigin', 'referrerpolicy', 'integrity', 'nomodule'].forEach(function(a) {
              var v = o.getAttribute && o.getAttribute(a);
              if (v) s.setAttribute(a, v);
            });

            if (o.src) {
              s.src = o.src;
              document.body.appendChild(s);
              await new Promise(function(r) { s.onload = s.onerror = r; });
            } else {
              s.textContent = o.textContent || '';
              document.body.appendChild(s);
            }
          }

          wrap.remove();
        } catch (e) {
          console.warn('[app-base] Falha ao injetar loading.html:', e);
        }
      }

      window.wait = function(txt) {
        if (window.PageLoading && typeof window.PageLoading.show === 'function') {
          return window.PageLoading.show(txt || 'Carregando…');
        }
        if (window.Loading && typeof window.Loading.show === 'function') {
          return window.Loading.show(txt || 'Carregando…');
        }
      };

      window.ready = function() {
        if (window.PageLoading && typeof window.PageLoading.hide === 'function') {
          return window.PageLoading.hide();
        }
        if (window.Loading && typeof window.Loading.hide === 'function') {
          return window.Loading.hide();
        }
      };

      window.forceReady = function() {
        try { window.PageLoading && window.PageLoading.reset && window.PageLoading.reset(); } catch (e) {}
        try { window.PageLoading && window.PageLoading.hide && window.PageLoading.hide(); } catch (e) {}
        try {
          var overlay = document.getElementById('page-loading') || document.getElementById('app-loading');
          if (overlay) {
            overlay.classList.remove('show');
            overlay.style.display = 'none';
            overlay.style.pointerEvents = 'none';
          }
          document.documentElement.style.overflow = '';
          delete document.documentElement.dataset.pageLoadingLock;
        } catch (e) {}
      };

      window.addEventListener('load', function(){ setTimeout(window.forceReady, 400); }, { once: true });
      window.addEventListener('zc:atendimentos-ready', function(){ setTimeout(window.forceReady, 100); });

      // Correção v5: na tela de atendimentos, nunca deixa o PageLoading global
      // travado por cima do chat. O atendimento possui loaders internos próprios.
      if ((location.pathname || '').replace(/\/+$/, '') === '/atendimentos') {
        [200, 800, 1600, 3000, 6000].forEach(function(ms){
          setTimeout(function(){ try { window.forceReady && window.forceReady(); } catch(e){} }, ms);
        });
      }

      setTimeout(window.forceReady, 9000);

      document.documentElement.setAttribute('data-loader-ready', '1');
    })();

    return LOADER_READY;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureGlobalLoader, { once: true });
  } else {
    ensureGlobalLoader();
  }

  // =========================================================
  // 3) Sidebar (partial) — usa só sidebar.html
  // =========================================================
  var SIDEBAR_READY = null;

  async function ensureSidebar() {
    var host = document.getElementById('sidebar');
    if (!host || host.dataset.loaded) return;
    host.dataset.loaded = '1';

    SIDEBAR_READY = (async function() {
      var src = host.getAttribute('data-src') || '/frontend/partials/sidebar.html';

      try {
        var res = await fetch(bust(src), {
          cache: 'no-cache',
          credentials: 'include'
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);

        var html = await res.text();
        var wrap = document.createElement('div');
        wrap.innerHTML = html;

        var scripts = Array.from(wrap.querySelectorAll('script'));
        scripts.forEach(function(sc) {
          if (sc.parentNode) sc.parentNode.removeChild(sc);
        });

        while (wrap.firstChild) {
          host.parentNode.insertBefore(wrap.firstChild, host.nextSibling);
        }
        host.remove();

        try {
          var aside = document.querySelector('.app-sidebar');
          if (aside && !aside.querySelector('nav a[aria-current="page"]')) {
            var nowFull = location.pathname.replace(/\/+$/, '');
            var nowFile = nowFull.split('/').pop();

            aside.querySelectorAll('nav a[href]').forEach(function(a) {
              try {
                var pFull = new URL(a.getAttribute('href'), location.origin).pathname.replace(/\/+$/, '');
                var pFile = pFull.split('/').pop();

                var eq =
                  (pFull === nowFull) ||
                  (pFile === nowFile) ||
                  (pFull + '.html' === nowFull) ||
                  (pFull === nowFull + '.html');

                if (eq) {
                  a.classList.add('active');
                  a.setAttribute('aria-current', 'page');
                }
              } catch (e) {}
            });
          }
        } catch (e) {
          console.warn('active-link mark skipped:', e);
        }

        (function runSeq(i) {
          if (i >= scripts.length) return;

          var old = scripts[i];
          var s = document.createElement('script');

          if (old.type) s.type = old.type;
          if (old.noModule) s.noModule = true;

          ['crossorigin', 'referrerpolicy', 'integrity'].forEach(function(a) {
            var v = old.getAttribute && old.getAttribute(a);
            if (v) s.setAttribute(a, v);
          });

          if (old.src) {
            s.src = old.src;
            s.onload = s.onerror = function() { runSeq(i + 1); };
            document.body.appendChild(s);
          } else {
            s.textContent = old.textContent || '';
            document.body.appendChild(s);
            runSeq(i + 1);
          }
        })(0);

      } catch (e) {
        console.error('[app-base] sidebar load fail', e);
      }
    })();

    return SIDEBAR_READY;
  }

  function bootSidebar() {
    var p = ensureSidebar();

    if (p && typeof p.then === 'function') {
      p.finally(function() {
        Promise.allSettled([HEAD_READY, LOADER_READY]).finally(markShellReady);
      });
    } else {
      Promise.allSettled([HEAD_READY, LOADER_READY]).finally(markShellReady);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootSidebar, { once: true });
  } else {
    bootSidebar();
  }

  // =========================================================
  // 4) Gancho de navegação — mostra overlay ANTES da troca
  // =========================================================
  (function navOverlayHook() {
    function shouldIntercept(a) {
      if (!a) return false;

      try {
        var href = a.getAttribute('href') || '';
        if (!href) return false;
        if (href.charAt(0) === '#') return false;
        if (a.target && a.target !== '_self') return false;

        var u = new URL(href, location.origin);
        if (u.origin !== location.origin) return false;

        return true;
      } catch (e) {
        return false;
      }
    }

    function markHardAtendimentoLeave(u, reason) {
      try {
        var until = String(Date.now() + 15000);
        window.__ZC_ATENDIMENTOS_NAVIGATING_AWAY__ = true;
        window.__ZC_ATENDIMENTOS_FORCE_NEXT_URL__ = u.href;
        sessionStorage.setItem('zc:atendimentos:leaving_until', until);
        sessionStorage.setItem('zc:atendimentos:leaving_to', u.href);
        sessionStorage.setItem('zc:atendimentos:leaving_reason', reason || 'nav');
      } catch (ee) {}

      try { window.dispatchEvent(new CustomEvent('zc:navigate-away', { detail: { from: location.pathname, to: u.pathname, reason: reason || 'nav', hard: true } })); } catch (ee) {}
      try { window.zcAtendimentoWsMarkNavigatingAway && window.zcAtendimentoWsMarkNavigatingAway(reason || 'hard-nav'); } catch (ee) {}
      try { window.zcAtendimentoWsClearPendingWork && window.zcAtendimentoWsClearPendingWork(reason || 'hard-nav'); } catch (ee) {}
      try { window.zcHistoricoClearOpenRealtimeWork && window.zcHistoricoClearOpenRealtimeWork(reason || 'hard-nav'); } catch (ee) {}
      try { window.ZCForceClearLoading && window.ZCForceClearLoading(reason || 'hard-nav'); } catch (ee) {}
      try { window.PageLoading && window.PageLoading.hide && window.PageLoading.hide(); } catch (ee) {}
      try { window.PageLoading && window.PageLoading.reset && window.PageLoading.reset(); } catch (ee) {}
      try { window.Splash && window.Splash.hide && window.Splash.hide(); } catch (ee) {}
    }

    var __zcAppBaseHardNavStarted = false;

    function hardNavigateNow(u, reason) {
      if (__zcAppBaseHardNavStarted || window.__ZC_ATENDIMENTOS_HARD_NAV_STARTED__) return;
      __zcAppBaseHardNavStarted = true;
      try { window.__ZC_ATENDIMENTOS_HARD_NAV_STARTED__ = true; } catch (ee) {}
      try { markHardAtendimentoLeave(u, reason); } catch (ee) {}

      // NÃO usar window.stop() aqui.
      // Quando o Atendimento recebe mensagem/WS/fetch ao mesmo tempo em que o usuário
      // troca de tela, window.stop() pode cancelar ou atrasar o próprio document navigation.
      // A saída correta é iniciar a navegação primeiro e só reforçar com fallback leve.
      try { window.location.assign(u.href); } catch (ee) {
        try { window.location.href = u.href; } catch (eee) {}
      }

      try {
        setTimeout(function() {
          try {
            var cur = (location.pathname || '').replace(/\/+$/, '') || '/';
            var dst = (u.pathname || '').replace(/\/+$/, '') || '/';
            if (cur !== dst && cur === '/atendimentos') {
              location.replace(u.href);
            }
          } catch (eee) {}
        }, 120);
      } catch (ee) {}
    }

    function forceImmediateLeaveAtendimentos(e) {
      try {
        var a = e.target && e.target.closest && e.target.closest('a[href]');
        if (!a) return;

        if (!shouldIntercept(a)) return;

        var u = new URL(a.getAttribute('href') || '', location.origin);
        var cur = (location.pathname || '').replace(/\/+$/, '') || '/';
        var dst = (u.pathname || '').replace(/\/+$/, '') || '/';

        // v8: dentro de /atendimentos, QUALQUER link interno para outra tela
        // precisa ganhar prioridade. O menu "Arquivos/Mídias" pode estar fora
        // de .app-sidebar/nav; antes ele caía no click normal e ficava preso
        // atrás dos timers de histórico/WS.
        if (cur !== '/atendimentos' || dst === '/atendimentos' || cur === dst) return;

        // v12/teste: usa pointerdown/touchstart, antes do click. Em rajada de WS,
        // o click podia ficar para trás; aqui a intenção de navegação ganha prioridade.
        try { e.preventDefault(); } catch (ee) {}
        try { e.stopPropagation(); } catch (ee) {}
        try { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch (ee) {}

        try { window.__ZC_ATENDIMENTOS_NAVIGATING_AWAY__ = true; } catch (ee) {}
        try { window.dispatchEvent(new CustomEvent('zc:navigate-away', { detail: { from: cur, to: dst, early: true } })); } catch (ee) {}
        hardNavigateNow(u, 'app-base-pointer-nav');
      } catch (err) {}
    }

    document.addEventListener('pointerdown', forceImmediateLeaveAtendimentos, { capture: true });
    document.addEventListener('mousedown', forceImmediateLeaveAtendimentos, { capture: true });
    try { document.addEventListener('touchstart', forceImmediateLeaveAtendimentos, { capture: true, passive: false }); } catch (e) {}

    document.addEventListener('click', function(e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;

      if (!shouldIntercept(a)) return;
      var inMenu = a.closest('.app-sidebar, nav');
      var wantsWait = a.hasAttribute('data-wait');

      try {
        var u2 = new URL(a.getAttribute('href') || '', location.origin);
        var cur2 = (location.pathname || '').replace(/\/+$/, '') || '/';
        var dst2 = (u2.pathname || '').replace(/\/+$/, '') || '/';
        if (!(cur2 === '/atendimentos' && dst2 !== '/atendimentos') && !inMenu && !wantsWait) return;
        if (cur2 === dst2) {
          // v6: clicar no item ativo da sidebar não pode recarregar a mesma página.
          // Esse reload fechava o WebSocket com CLOSE 1001 e parecia que o atendimento caía.
          try { e.preventDefault(); } catch (ee) {}
          try { e.stopPropagation(); } catch (ee) {}
          try { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch (ee) {}
          try { window.forceReady && window.forceReady(); } catch (ee) {}
          try { window.ZCForceClearLoading && window.ZCForceClearLoading('same-page-nav-app-base'); } catch (ee) {}
          return;
        }

        // Correção v5:
        // A tela de atendimentos tem boot próprio e muitos módulos ES.
        // O overlay global do app-base ficava por cima enquanto o atendimento
        // ainda estava inicializando, e parecia que a página "caiu".
        // Para /atendimentos, não mostramos o PageLoading global; o próprio
        // atendimento controla seus loaders internos.
        if (dst2 === '/atendimentos') {
          setTimeout(function(){ try { window.forceReady && window.forceReady(); } catch(e){} }, 50);
          setTimeout(function(){ try { window.forceReady && window.forceReady(); } catch(e){} }, 500);
          setTimeout(function(){ try { window.forceReady && window.forceReady(); } catch(e){} }, 1500);
          return;
        }

        // v11/teste Atendimento WS:
        // Se o usuário está saindo de /atendimentos para outra página,
        // a navegação precisa ganhar prioridade sobre renderizações/timers do WS.
        // Sem isso, mensagem chegando ao vivo podia deixar o clique no menu
        // parecendo preso até terminar o ciclo visual do atendimento.
        if (cur2 === '/atendimentos' && dst2 !== '/atendimentos') {
          try { e.preventDefault(); } catch (ee) {}
          try { e.stopPropagation(); } catch (ee) {}
          try { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch (ee) {}
          try { window.__ZC_ATENDIMENTOS_NAVIGATING_AWAY__ = true; } catch (ee) {}
          try { window.dispatchEvent(new CustomEvent('zc:navigate-away', { detail: { from: cur2, to: dst2 } })); } catch (ee) {}
          hardNavigateNow(u2, 'app-base-nav-away');
          return;
        }
      } catch (err0) {}

      try {
        if (window.PageLoading && typeof window.PageLoading.show === 'function') {
          window.PageLoading.show('Carregando…', { scope: 'body' });
          setTimeout(function(){ try { window.forceReady && window.forceReady(); } catch(e){} }, 2500);
          setTimeout(function(){ try { window.forceReady && window.forceReady(); } catch(e){} }, 9000);
        }
      } catch (err) {}
    }, { capture: true });
  })();

  // =========================================================
  // 5) Boot do módulo de notificações top-right
  // =========================================================
  (function bootNotifModule() {
    if (isPublicLikePage()) return;

    function loadScriptOnce(src, id) {
      return new Promise(function(resolve, reject) {
        var existing = document.getElementById(id);

        if (existing) {
          if (existing.dataset.loaded === '1') {
            resolve();
            return;
          }

          existing.addEventListener('load', function() { resolve(); }, { once: true });
          existing.addEventListener('error', function() { reject(new Error('Falha ao carregar ' + src)); }, { once: true });
          return;
        }

        var s = document.createElement('script');
        s.id = id;
        s.src = bust(src);
        s.defer = true;
        s.setAttribute('data-notif-module', '1');

        s.onload = function() {
          s.dataset.loaded = '1';
          resolve();
        };

        s.onerror = function() {
          reject(new Error('Falha ao carregar ' + src));
        };

        document.head.appendChild(s);
      });
    }

    function startNotif() {
      loadScriptOnce('/frontend/js/notif.js', 'plan-notif-script').catch(function(err) {
        console.warn('[app-base] Falha ao carregar notif.js', err);
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startNotif, { once: true });
    } else {
      startNotif();
    }
  })();

  // =========================================================
  // 6) Fallback duro: se algo travar, libera após 2.5s
  // =========================================================
  setTimeout(markShellReady, 2500);

})();

// === Guard DevTools (carregar só fora do /login) ============================
(function() {
  try {
    var p = (location.pathname || '').toLowerCase();
    if (p === '/login' || p === '/login.html') return;

    if (document.getElementById('__guard_devtools_js')) return;

    var v = window.APP_BUILD || localStorage.getItem('APP_BUILD') || 'dev';
    var s = document.createElement('script');
    s.id = '__guard_devtools_js';
    s.src = '/frontend/assets/guard-devtools.js?_v=' + encodeURIComponent(v);
    s.defer = true;
    document.head.appendChild(s);
  } catch (e) {}
})();