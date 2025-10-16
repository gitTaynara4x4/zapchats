/* /frontend/js/version.js  —  único ponto de versão do app */
(function () {
  // Troque a cada deploy (timestamp, hash do commit, etc.)
  var APP_VERSION = '2025.10.16-01';
  window.APP_VERSION = APP_VERSION;

  // Helper: adiciona/atualiza ?_v= na URL (seguro p/ relativas/absolutas)
  function withV(url) {
    try {
      var u = new URL(url, location.origin);
      u.searchParams.set('_v', APP_VERSION);
      return u.pathname + u.search + u.hash;
    } catch (e) {
      // fallback p/ URLs bem relativas
      var hashIdx = url.indexOf('#');
      var hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
      var base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
      var qIdx = base.indexOf('?');
      var path = qIdx >= 0 ? base.slice(0, qIdx) : base;
      var qs = qIdx >= 0 ? base.slice(qIdx + 1) : '';
      var params = new URLSearchParams(qs);
      params.set('_v', APP_VERSION);
      return path + '?' + params.toString() + hash;
    }
  }
  window.withV = withV;

  // ---- Auto-versionar elementos estáticos do DOM ----
  // Regras: só mexe em assets estáticos (partials .html, css, fontes, imgs).
  var SELECTORS = [
    // Partials que você carrega com data-src / data-src-mobile
    '[data-src]',
    '[data-src-mobile]',
    // CSS estático
    'link[rel="stylesheet"][href]',
    // Imagens com data-src (ex: avatares em parciais)
    'img[data-src]',
    // Scripts opcionais marcados (adicione data-versioned se quiser)
    'script[data-versioned][src]'
  ];

  function versionizeEl(el) {
    // data-src / data-src-mobile
    if (el.hasAttribute('data-src')) {
      var s = el.getAttribute('data-src');
      if (s) el.setAttribute('data-src', withV(s));
    }
    if (el.hasAttribute('data-src-mobile')) {
      var sm = el.getAttribute('data-src-mobile');
      if (sm) el.setAttribute('data-src-mobile', withV(sm));
    }
    // link rel=stylesheet
    if (el.tagName === 'LINK' && el.rel === 'stylesheet' && el.href) {
      // Evita reler infinitamente (checa se já tem _v igual)
      if (!/([?&])_v=/.test(el.href) || !el.href.includes(APP_VERSION)) {
        el.href = withV(el.href);
      }
    }
    // imagens com data-src → mover para src (se seu loader não fizer)
    if (el.tagName === 'IMG' && el.hasAttribute('data-src')) {
      var ds = el.getAttribute('data-src');
      if (ds && (!el.getAttribute('src') || !el.getAttribute('src').includes('_v='))) {
        el.setAttribute('src', withV(ds));
      }
    }
    // scripts opcionais marcados
    if (el.tagName === 'SCRIPT' && el.hasAttribute('data-versioned') && el.src) {
      if (!/([?&])_v=/.test(el.src) || !el.src.includes(APP_VERSION)) {
        // Para scripts já carregados, trocar src força novo download (ok se for pequeno)
        el.src = withV(el.src);
      }
    }
  }

  // Varre inicial (elementos já presentes)
  function initialSweep() {
    try {
      document.querySelectorAll(SELECTORS.join(',')).forEach(versionizeEl);
    } catch {}
  }

  // Observa novos nós/atributos — cobre casos em que app-base injeta depois
  var mo = new MutationObserver(function (muts) {
    for (var m of muts) {
      if (m.type === 'childList') {
        m.addedNodes && m.addedNodes.forEach(function (n) {
          if (n.nodeType === 1) {
            // o próprio nó
            if (n.matches) {
              try { if (n.matches(SELECTORS.join(','))) versionizeEl(n); } catch {}
            }
            // e seus filhos
            try { n.querySelectorAll && n.querySelectorAll(SELECTORS.join(',')).forEach(versionizeEl); } catch {}
          }
        });
      } else if (m.type === 'attributes') {
        if (m.target && m.target.nodeType === 1) versionizeEl(m.target);
      }
    }
  });

  // Inicia quando o DOM já existir minimamente
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initialSweep();
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'src', 'data-src', 'data-src-mobile'] });
    });
  } else {
    initialSweep();
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'src', 'data-src', 'data-src-mobile'] });
  }

  // ---- (Opcional) Watcher de nova versão ----
  // Se você criar /frontend/version.json com {"version":"..."},
  // isto detecta atualização e dá reload automaticamente.
  async function checkLatest() {
    try {
      var res = await fetch('/frontend/version.json?_t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      var j = await res.json();
      var latest = (j && j.version) ? String(j.version) : '';
      var cur = localStorage.getItem('APP_VERSION') || '';
      if (!cur) localStorage.setItem('APP_VERSION', APP_VERSION);
      // Se o arquivo remoto mudou (deploy novo), força reload limpo
      if (latest && latest !== APP_VERSION) location.reload();
    } catch {}
  }
  // rode de vez em quando (comente se não usar version.json)
  setInterval(checkLatest, 5 * 60 * 1000);
})();
