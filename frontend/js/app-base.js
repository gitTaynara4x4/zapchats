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
    } catch {
      return u + (u.includes('?') ? '&' : '?') + '_v=' + ver;
    }
  }

  // =========================================================
  // Pequena animação de entrada da página (fade + up)
  // =========================================================
  function playEnterAnimation() {
    var el = document.querySelector('main, .main, [data-route-container]');
    if (!el) return;
    el.classList.remove('route-enter'); // reset se for navegação rápida
    // força reflow para reiniciar a animação
    // eslint-disable-next-line no-unused-expressions
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
    try { document.documentElement.classList.remove('prepaint'); } catch {}
    playEnterAnimation(); // toca a entradinha no container principal
    document.dispatchEvent(new Event('shell:ready'));
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
      // Se já existe sentinela (tokens), não reinjeta
      try {
        var cs = getComputedStyle(document.documentElement);
        if (cs.getPropertyValue('--shadow') && cs.getPropertyValue('--radius')) {
          // Mesmo assim, marque data-head-ready para liberar o paint anti-flash
          document.documentElement.setAttribute('data-head-ready', '1');
          return;
        }
      } catch {}

      try {
        var res  = await fetch(bust('/frontend/partials/head-base.html'), { cache:'no-cache', credentials:'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var html = await res.text();

        var wrap = document.createElement('div');
        wrap.innerHTML = html;

        // 1) <style> (tokens/base)
        Array.from(wrap.querySelectorAll('style')).forEach(function(st){
          var s = document.createElement('style');
          s.textContent = st.textContent || '';
          document.head.appendChild(s);
        });

        // 2) <link> (tw.css/FA/Google Fonts) sem duplicar
        Array.from(wrap.querySelectorAll('link[rel="stylesheet"], link[rel="preload"]')).forEach(function(l){
          var href = l.getAttribute('href'); if (!href) return;
          var exists = Array.from(document.head.querySelectorAll('link[rel="stylesheet"], link[rel="preload"]'))
            .some(function(e){ return e.getAttribute('href') === href; });
          if (!exists) document.head.appendChild(l.cloneNode(true));
        });

        // 3) <script> inline do head-base (aplica tema cedo)
        Array.from(wrap.querySelectorAll('script')).forEach(function(o){
          var s = document.createElement('script');
          if (o.type) s.type = o.type;
          s.textContent = o.textContent || '';
          document.head.appendChild(s);
        });

        wrap.remove();
        // libera anti-flash ligado em html.prepaint body{visibility:hidden}
        document.documentElement.setAttribute('data-head-ready', '1');
      } catch (e) {
        console.warn('[app-base] Falha ao injetar head-base.html:', e);
        // Mesmo com erro, libera o paint para não travar a tela
        document.documentElement.setAttribute('data-head-ready', '1');
      }
    })();

    return HEAD_READY;
  }

  // Dispara head-base imediatamente
  ensureHeadBase();

  // =========================================================
  // 1) Tema (API simples para páginas/toggles)
  // =========================================================
  try {
    var saved = localStorage.getItem('theme'); // 'dark'|'light'|null
    if (saved) {
      document.documentElement.classList.toggle('dark', saved === 'dark');
    } else {
      var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('dark', prefersDark);
    }
    window.AppTheme = {
      set: function(mode){
        try { localStorage.setItem('theme', mode); } catch {}
        document.documentElement.classList.toggle('dark', mode === 'dark');
      },
      current: function(){
        return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
      }
    };
  } catch {}

  // =========================================================
  // 2) Loader GLOBAL (injeta /frontend/partials/loading.html)
  // =========================================================
  var __LOADER_BOOTED__ = false;
  var LOADER_READY = null;

  async function ensureGlobalLoader() {
    if (__LOADER_BOOTED__) return LOADER_READY;
    __LOADER_BOOTED__ = true;

    LOADER_READY = (async function(){
      var existing = document.getElementById('page-loading') || document.getElementById('app-loading');
      if (!existing) {
        try {
          var res  = await fetch('/frontend/partials/loading.html', { cache:'no-cache', credentials:'include' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var html = await res.text();

          var wrap = document.createElement('div');
          wrap.innerHTML = html;

          // remove overlays antigos
          document.getElementById('page-loading')?.remove();
          document.getElementById('app-loading')?.remove();

          // injeta overlay
          var overlay = wrap.querySelector('#page-loading, #app-loading');
          if (overlay) {
            document.body.appendChild(overlay);
            if (!overlay.style.position) overlay.style.position = 'fixed';
            if (!overlay.style.zIndex)    overlay.style.zIndex = '9999';
          }

          // estilos do loading
          Array.from(wrap.querySelectorAll('style')).forEach(function(st){
            var s = document.createElement('style');
            s.textContent = st.textContent || '';
            document.head.appendChild(s);
          });

          // scripts do loading (PageLoading global)
          var scripts = Array.from(wrap.querySelectorAll('script'));
          for (var i=0; i<scripts.length; i++) {
            var o = scripts[i];
            var s = document.createElement('script');
            if (o.type) s.type = o.type;
            ['crossorigin','referrerpolicy','integrity','nomodule'].forEach(function(a){
              var v = o.getAttribute && o.getAttribute(a);
              if (v) s.setAttribute(a, v);
            });
            if (o.src) {
              s.src = o.src;
              document.body.appendChild(s);
              await new Promise(function(r){ s.onload = s.onerror = r; });
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

      // Shims convenientes
      window.wait  = function (txt) {
        if (window.PageLoading?.show) return PageLoading.show(txt || 'Carregando…');
        if (window.Loading?.show)     return Loading.show(txt || 'Carregando…');
      };
      window.ready = function () {
        if (window.PageLoading?.hide) return PageLoading.hide();
        if (window.Loading?.hide)     return Loading.hide();
      };

      document.documentElement.setAttribute('data-loader-ready', '1');
    })();

    return LOADER_READY;
  }

  // Inicia loader assim que possível
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureGlobalLoader, { once:true });
  } else {
    ensureGlobalLoader();
  }

  // =========================================================
  // 3) Sidebar (partial) — desktop x mobile padronizado
  // =========================================================
  var SIDEBAR_READY = null;

  async function ensureSidebar() {
    var host = document.getElementById('sidebar');
    if (!host || host.dataset.loaded) return;
    host.dataset.loaded = '1';

    SIDEBAR_READY = (async function(){
      var mq = window.matchMedia('(max-width:1024px)');
      var desktopSrc = host.getAttribute('data-src') || '/frontend/partials/sidebar.html';
      var mobileSrc  = host.getAttribute('data-src-mobile') || '/frontend/partials/sidebar-mobile.html';
      var src        = mq.matches ? mobileSrc : desktopSrc;

      try {
        var res  = await fetch(bust(src), { cache:'no-cache', credentials:'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var html = await res.text();

        var wrap = document.createElement('div');
        wrap.innerHTML = html;

        // separa scripts
        var scripts = Array.from(wrap.querySelectorAll('script'));
        scripts.forEach(function(sc){ sc.parentNode && sc.parentNode.removeChild(sc); });

        // injeta DOM após placeholder
        while (wrap.firstChild) {
          host.parentNode.insertBefore(wrap.firstChild, host.nextSibling);
        }
        host.remove();

        // marca link ativo se parcial não marcou
        try {
          var aside = document.querySelector('.app-sidebar');
          if (aside && !aside.querySelector('nav a[aria-current="page"]')) {
            var nowFull = location.pathname.replace(/\/+$/, '');
            var nowFile = nowFull.split('/').pop();
            aside.querySelectorAll('nav a[href]').forEach(function(a){
              try {
                var pFull = new URL(a.getAttribute('href'), location.origin).pathname.replace(/\/+$/, '');
                var pFile = pFull.split('/').pop();
                var eq = (pFull === nowFull) || (pFile === nowFile) ||
                         (pFull + '.html' === nowFull) || (pFull === nowFull + '.html');
                if (eq) { a.classList.add('active'); a.setAttribute('aria-current','page'); }
              } catch {}
            });
          }
        } catch (e) { console.warn('active-link mark skipped:', e); }

        // executa scripts do parcial
        (function runSeq(i){
          if (i >= scripts.length) return;
          var old = scripts[i];
          var s = document.createElement('script');
          if (old.type) s.type = old.type;
          if (old.noModule) s.noModule = true;
          ['crossorigin','referrerpolicy','integrity'].forEach(function(a){
            var v = old.getAttribute && old.getAttribute(a);
            if (v) s.setAttribute(a, v);
          });
          if (old.src) {
            s.src = old.src;
            s.onload = s.onerror = function(){ runSeq(i+1); };
            document.body.appendChild(s);
          } else {
            s.textContent = old.textContent || '';
            document.body.appendChild(s);
            runSeq(i+1);
          }
        })(0);

      } catch (e) {
        console.error('[app-base] sidebar load fail', e);
      }
    })();

    return SIDEBAR_READY;
  }

  // Boot da sidebar e release do shell ao final
  function bootSidebar() {
    var p = ensureSidebar();
    if (p && typeof p.then === 'function') {
      p.finally(function(){
        Promise.allSettled([HEAD_READY, LOADER_READY]).finally(markShellReady);
      });
    } else {
      Promise.allSettled([HEAD_READY, LOADER_READY]).finally(markShellReady);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootSidebar, { once:true });
  } else {
    bootSidebar();
  }

  // =========================================================
  // 4) Gancho de navegação — mostra overlay ANTES da troca
  // =========================================================
  (function navOverlayHook(){
    function shouldIntercept(a){
      if (!a) return false;
      // Apenas links internos, mesma origem, sem target especial
      try{
        var href = a.getAttribute('href') || '';
        if (!href) return false;
        if (href[0] === '#') return false; // âncora
        if (a.target && a.target !== '_self') return false;

        var u = new URL(href, location.origin);
        if (u.origin !== location.origin) return false;
        return true;
      }catch{ return false; }
    }

    document.addEventListener('click', function(e){
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;

      // Links do menu (sidebar/nav) OU com atributo data-wait
      var inMenu = a.closest('.app-sidebar, nav');
      var wantsWait = a.hasAttribute('data-wait');
      if (!inMenu && !wantsWait) return;
      if (!shouldIntercept(a)) return;

      // Mostra overlay otimista (fullscreen)
      try { window.PageLoading?.show?.('Carregando…', { scope:'body' }); } catch {}
      // Navegação segue naturalmente; o overlay some na próxima página (ready()).
    }, { capture:true });
  })();

  // =========================================================
  // 5) Fallback duro: se algo travar, libera após 2.5s
  // =========================================================
  setTimeout(markShellReady, 2500);

})();

// === Guard DevTools (carregar só fora do /login) ============================
(function(){
  try {
    var p = (location.pathname || '').toLowerCase();
    if (p === '/login' || p === '/login.html') return;

    // Evita múltiplas injeções
    if (document.getElementById('__guard_devtools_js')) return;

    var v = window.APP_BUILD || localStorage.getItem('APP_BUILD') || 'dev';
    var s = document.createElement('script');
    s.id = '__guard_devtools_js';
    s.src = '/frontend/assets/guard-devtools.js?_v=' + encodeURIComponent(v);
    s.defer = true;
    document.head.appendChild(s);
  } catch {}
})();
