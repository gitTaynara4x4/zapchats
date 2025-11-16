// /frontend/js/atendimentos/ui/flyout.js
(function () {
  'use strict';

  console.log('[flyout.js] inicializado');

  // =====================================================
  // 1) CSS do flyout (overlay + animação)
  // =====================================================
  (function injectCss() {
    if (document.getElementById('zc-flyout-style')) return;

    var css = `
    html.zc-flyout-open,
    body.zc-flyout-open {
      overflow: hidden;
    }

    .zc-flyout {
      position: fixed;
      inset: 0;
      z-index: 10020;
      display: none;
      align-items: stretch;
      justify-content: flex-start;
    }

    .zc-flyout.is-open {
      display: flex;
    }

    .zc-flyout__panel {
      position: relative;
      width: min(340px, 88vw);
      max-width: 380px;
      height: 100%;
      background: var(--card, #111827);
      transform: translateX(-100%);
      transition: transform .25s ease-out;
      box-shadow: 4px 0 24px rgba(0,0,0,.45);
      overflow: hidden;
    }

    .zc-flyout.is-open .zc-flyout__panel {
      transform: translateX(0);
    }

    .zc-flyout__backdrop {
      flex: 1 1 auto;
      border: 0;
      margin: 0;
      padding: 0;
      background: rgba(0,0,0,.45);
      cursor: default;
    }

    .zc-flyout__backdrop:focus {
      outline: none;
    }

    @media (max-width: 768px) {
      .zc-flyout__panel {
        width: min(100vw, 420px);
      }
    }
    `;

    var style = document.createElement('style');
    style.id = 'zc-flyout-style';
    style.type = 'text/css';
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  })();

  // =====================================================
  // 2) Cria / normaliza o host do flyout
  // =====================================================
  function buildFlyoutShell() {
    var host = document.getElementById('zcSidebarHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'zcSidebarHost';
      document.body.appendChild(host);
    }

    host.classList.add('zc-flyout');
    host.removeAttribute('aria-hidden'); // evita warning de acessibilidade

    // limpa conteúdo antigo
    host.innerHTML = '';

    var panel = document.createElement('div');
    panel.className = 'zc-flyout__panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Menu lateral');
    panel.tabIndex = -1;
    host.appendChild(panel);

    var backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'zc-flyout__backdrop';
    backdrop.tabIndex = -1;
    host.appendChild(backdrop);

    return { host: host, panel: panel, backdrop: backdrop };
  }

  var shell = buildFlyoutShell();
  var host = shell.host;
  var panel = shell.panel;
  var backdrop = shell.backdrop;

  var isOpen = false;
  var sidebarLoaded = false;
  var sidebarLoading = null;

  // =====================================================
  // 3) Abertura / fechamento
  // =====================================================
  function openFlyout() {
    if (isOpen) return;
    isOpen = true;
    host.classList.add('is-open');
    document.documentElement.classList.add('zc-flyout-open');
    document.body.classList.add('zc-flyout-open');
    try {
      panel.focus();
    } catch (e) {}
  }

  function closeFlyout() {
    if (!isOpen) return;
    isOpen = false;
    host.classList.remove('is-open');
    document.documentElement.classList.remove('zc-flyout-open');
    document.body.classList.remove('zc-flyout-open');
  }

  backdrop.addEventListener('click', function (ev) {
    ev.preventDefault();
    closeFlyout();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && isOpen) {
      closeFlyout();
    }
  });

  // =====================================================
  // 4) Carrega a parcial da sidebar + injeta CSS/HTML
  // =====================================================
  function loadSidebar() {
    if (sidebarLoaded) return Promise.resolve();
    if (sidebarLoading) return sidebarLoading;

    console.log('[flyout.js] carregando /frontend/partials/sidebar-atendimentos.html ...');

    sidebarLoading = fetch('/frontend/partials/sidebar-atendimentos.html', {
      credentials: 'include'
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status + ' ao carregar sidebar-atendimentos');
        }
        return res.text();
      })
      .then(function (html) {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;

        // Move <link> da parcial pro <head>
        tmp.querySelectorAll('link[rel="preload"],link[rel="stylesheet"]').forEach(function (el) {
          document.head.appendChild(el);
        });

        // Move <style> da parcial pro <head>
        tmp.querySelectorAll('style').forEach(function (el) {
          document.head.appendChild(el);
        });

        // Pega a sidebar
        var aside = tmp.querySelector('.app-sidebar');
        if (!aside) {
          console.error('[flyout.js] Sidebar (.app-sidebar) não encontrada na parcial.');
          return;
        }

        // Modal de perfil (se existir)
        var modal = tmp.querySelector('#pfModalAtt');
        if (modal && !document.getElementById('pfModalAtt')) {
          document.body.appendChild(modal);
        }

        // Injeta a sidebar dentro do painel
        panel.innerHTML = '';
        panel.appendChild(aside);

        // Inicializa lógica interna
        initSidebarLogic(aside);

        sidebarLoaded = true;
        console.log('[flyout.js] Sidebar carregada e pronta.');
      })
      .catch(function (err) {
        console.error('[flyout.js] Erro ao carregar sidebar-atendimentos:', err);
      })
      .finally(function () {
        sidebarLoading = null;
      });

    return sidebarLoading;
  }

  // =====================================================
  // 5) Lógica interna da sidebar (tema, usuário, modal, logout)
  // =====================================================
  function initSidebarLogic(root) {
    if (!root || root.dataset.zcSidebarInited === '1') return;
    root.dataset.zcSidebarInited = '1';

    // ===== THEME ENGINE =====
    (function ThemeEngine() {
      var html = document.documentElement;
      var label = document.getElementById('themeSwitchAtt');
      var cb = document.getElementById('themeCheckboxAtt');

      function updateSwitch(isDark) {
        if (cb) cb.checked = isDark;
        if (label) label.classList.toggle('is-dark', isDark);
      }
      function applyTheme(mode) {
        var isDark = mode === 'dark';
        html.classList.toggle('dark', isDark);
        html.setAttribute('data-theme', mode);
        try {
          localStorage.setItem('zc:theme', mode);
          localStorage.setItem('theme', mode);
        } catch (e) {}
        updateSwitch(isDark);
      }
      function currentPreference() {
        var saved = localStorage.getItem('zc:theme') || localStorage.getItem('theme');
        if (saved) return saved;
        return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
          ? 'dark'
          : 'light';
      }
      applyTheme(currentPreference());
      if (cb) cb.addEventListener('change', function () {
        applyTheme(cb.checked ? 'dark' : 'light');
      });
      window.addEventListener('storage', function (e) {
        if (e.key === 'zc:theme' || e.key === 'theme') {
          applyTheme((e.newValue === 'dark') ? 'dark' : 'light');
        }
      });
      window.__ThemeApply = applyTheme;
    })();

    // ===== Chip de usuário =====
    (function () {
      function pick() {
        for (var i = 0; i < arguments.length; i++) {
          var k = arguments[i];
          try {
            var v = localStorage.getItem(k);
            if (!v) continue;
            if (
              (v.startsWith('{') && v.endsWith('}')) ||
              (v.startsWith('[') && v.endsWith(']'))
            ) {
              try { return JSON.parse(v); } catch (e) {}
            }
            return v;
          } catch (e) {}
        }
        return '';
      }
      function jwt() {
        try {
          var tok = pick('access_token', 'token');
          if (!tok || !tok.includes('.')) return {};
          return JSON.parse(
            atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
          ) || {};
        } catch (e) {
          return {};
        }
      }
      function info() {
        var nome = pick('nome', 'name', 'displayName', 'usuario_nome');
        if (typeof nome === 'object') {
          nome = nome.nome || nome.name || nome.displayName || '';
        }
        var dept = pick('departamento', 'usuario_departamento');
        if (typeof dept === 'object') {
          dept = dept.departamento || '';
        }
        var email = pick('email', 'userEmail', 'loginEmail');
        var obj = pick('usuario', 'user', 'me', 'auth_user', 'profile', 'auth');
        if (obj && typeof obj === 'object') {
          email = email || obj.email || (obj.user && obj.user.email) || '';
          nome = nome || obj.nome || obj.name || (obj.user && (obj.user.nome || obj.user.name)) || '';
          dept = dept || obj.departamento || (obj.user && obj.user.departamento) || '';
        }
        var j = jwt();
        email = email || j.email || j.preferred_username || j.sub || '';
        nome = nome || j.name || j.given_name || j.nickname || '';
        return {
          nome: (nome || '').trim(),
          dept: (dept || '').trim(),
          email: (email || '').trim()
        };
      }
      function avatar() {
        var a = localStorage.getItem('usuario_avatar') || localStorage.getItem('avatar_url') || '';
        if (!a) {
          var j = jwt();
          a = (j && j.picture) || '';
        }
        return a;
      }
      function render() {
        var label = document.getElementById('userEmailLabelAtt');
        var img = document.getElementById('userAvatarAtt');
        var icn = document.getElementById('userIconAtt');
        var chip = document.getElementById('userChipAtt');
        if (!label || !img || !icn || !chip) return;
        var u = info();
        var txt = [u.nome, u.dept].filter(Boolean).join(' · ') || u.email || 'Usuário';
        label.textContent = txt;
        chip.title = u.email || u.nome || '';
        var av = avatar();
        if (av) {
          img.src = av;
          img.style.display = 'block';
          icn.style.display = 'none';
        } else {
          img.removeAttribute('src');
          img.style.display = 'none';
          icn.style.display = '';
        }
      }
      render();
      window.addEventListener('auth:change', render);
      window.addEventListener('storage', function (ev) {
        if (
          [
            'usuario_nome', 'nome', 'name', 'displayName',
            'usuario_departamento', 'departamento',
            'email', 'userEmail', 'loginEmail',
            'usuario_avatar', 'avatar_url',
            'usuario', 'user', 'me', 'auth_user', 'profile', 'auth',
            'access_token', 'token'
          ].includes(ev.key)
        ) {
          render();
        }
      });
    })();

    // ===== Pré-carrega avatar do servidor =====
    (async function AvatarPrefetch() {
      if (localStorage.getItem('usuario_avatar')) return;
      var token = localStorage.getItem('access_token') || localStorage.getItem('token');
      if (!token) return;
      try {
        var res = await fetch('/api/usuarios/me/avatar', {
          credentials: 'include',
          headers: { Authorization: 'Bearer ' + token }
        });
        if (!res.ok) return;
        var blob = await res.blob();
        var r = new FileReader();
        r.onloadend = function () {
          try {
            localStorage.setItem('usuario_avatar', r.result);
          } catch (e) {}
          var img = document.getElementById('userAvatarAtt');
          var icn = document.getElementById('userIconAtt');
          if (img) {
            img.src = r.result;
            img.style.display = 'block';
          }
          if (icn) icn.style.display = 'none';
        };
        r.readAsDataURL(blob);
      } catch (e) {}
    })();

    // ===== Modal Perfil =====
    (function () {
      var modal = document.getElementById('pfModalAtt');
      var fileInput = document.getElementById('pfFileAtt');
      var preview = document.getElementById('pfPreviewAtt');
      var nomeInput = document.getElementById('pfNomeAtt');
      var emailInput = document.getElementById('pfEmailAtt');
      var deptInput = document.getElementById('pfDeptAtt');
      var msg = document.getElementById('pfMsgAtt');

      if (modal && modal.parentElement !== document.body) {
        document.body.appendChild(modal);
      }

      function jwt() {
        try {
          var t = localStorage.getItem('access_token') || localStorage.getItem('token') || '';
          if (!t || !t.includes('.')) return {};
          return JSON.parse(
            atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
          ) || {};
        } catch (e) {
          return {};
        }
      }
      function me() {
        var n = localStorage.getItem('nome') || '';
        var e = localStorage.getItem('email') || '';
        var d = localStorage.getItem('departamento') || localStorage.getItem('usuario_departamento') || '';
        var j = jwt();
        if (!n) n = j.name || j.given_name || '';
        if (!e) e = j.email || j.preferred_username || '';
        return { nome: n, email: e, dept: d };
      }

      function openPf() {
        if (!modal) return;
        var u = me();
        if (nomeInput) nomeInput.value = u.nome || '';
        if (emailInput) emailInput.value = u.email || '';
        if (deptInput) deptInput.value = u.dept || '';
        if (msg) msg.textContent = '';
        var av = localStorage.getItem('usuario_avatar') || '';
        if (preview) {
          if (av) preview.src = av;
          else preview.removeAttribute('src');
        }
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        try { nomeInput && nomeInput.focus(); } catch (e) {}
      }
      function closePf() {
        if (!modal) return;
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
      }

      window.PfModal = { open: openPf, close: closePf };

      var btnClose = document.getElementById('pfCloseAtt');
      var btnCancel = document.getElementById('pfCancelAtt');
      var btnSave = document.getElementById('pfSaveAtt');

      btnClose && btnClose.addEventListener('click', function (e) {
        e.preventDefault();
        closePf();
      });
      btnCancel && btnCancel.addEventListener('click', function (e) {
        e.preventDefault();
        closePf();
      });
      btnSave && btnSave.addEventListener('click', function (e) {
        e.preventDefault();
        save();
      });

      fileInput && fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () {
          if (preview) preview.src = fr.result;
        };
        fr.readAsDataURL(f);
      });

      async function uploadAvatarIfNeeded() {
        var f = fileInput && fileInput.files && fileInput.files[0];
        if (!f) return true;
        if (msg) msg.textContent = 'Enviando foto...';
        var token = localStorage.getItem('access_token') || localStorage.getItem('token') || '';
        var fd = new FormData();
        fd.append('file', f, f.name);
        try {
          var res = await fetch('/api/usuarios/me/avatar', {
            method: 'POST',
            credentials: 'include',
            headers: token ? { Authorization: 'Bearer ' + token } : {},
            body: fd
          });
          if (!res.ok) {
            if (msg) msg.textContent = 'Não foi possível enviar a foto (' + res.status + ').';
            return false;
          }
          await new Promise(function (resolve) {
            var r = new FileReader();
            r.onloadend = function () {
              try {
                localStorage.setItem('usuario_avatar', r.result);
              } catch (e) {}
              var img = document.getElementById('userAvatarAtt');
              var icn = document.getElementById('userIconAtt');
              if (img) {
                img.src = r.result;
                img.style.display = 'block';
              }
              if (icn) icn.style.display = 'none';
              resolve();
            };
            r.readAsDataURL(f);
          });
          if (msg) msg.textContent = 'Foto atualizada.';
          return true;
        } catch (e) {
          if (msg) msg.textContent = 'Erro ao enviar foto.';
          return false;
        }
      }

      async function save() {
        if (msg) msg.textContent = 'Salvando...';
        try {
          var n = (nomeInput && nomeInput.value || '').trim();
          var d = (deptInput && deptInput.value || '').trim();
          if (n) localStorage.setItem('nome', n);
          if (d) localStorage.setItem('departamento', d);
        } catch (e) {}
        var token = localStorage.getItem('access_token') || localStorage.getItem('token') || '';
        if (token) {
          try {
            var payload = {
              nome: (nomeInput && nomeInput.value || '').trim(),
              departamento: (deptInput && deptInput.value || '').trim()
            };
            await fetch('/api/usuarios/me', {
              method: 'PATCH',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + token
              },
              body: JSON.stringify(payload)
            });
          } catch (e) {}
        }
        var ok = await uploadAvatarIfNeeded();
        if (!ok) return;
        var label = document.getElementById('userEmailLabelAtt');
        var n2 = (nomeInput && nomeInput.value || '').trim();
        var d2 = (deptInput && deptInput.value || '').trim();
        var e2 = (emailInput && emailInput.value || '').trim();
        if (label) {
          label.textContent = [n2 || null, d2 || null].filter(Boolean).join(' · ') || e2 || 'Usuário';
        }
        if (msg) msg.textContent = 'Informações salvas.';
        setTimeout(closePf, 600);
      }

      // Abrir modal pelo chip
      document.addEventListener('click', function (e) {
        var chip = e.target.closest && e.target.closest('#userChipAtt');
        if (chip) {
          e.preventDefault();
          window.PfModal && window.PfModal.open();
        }
      });
      document.addEventListener('click', function (e) {
        if (!modal || modal.style.display === 'none') return;
        if (e.target === modal) {
          e.preventDefault();
          window.PfModal && window.PfModal.close();
        }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          window.PfModal && window.PfModal.close();
        }
      });
    })();

    // ===== Logout =====
    (function () {
      var out = document.getElementById('sidebarLogoutAtt');
      if (!out || out.dataset.bound) return;
      out.dataset.bound = '1';
      out.addEventListener('click', function (ev) {
        ev.preventDefault();
        try {
          [
            'token', 'access_token', 'refresh_token',
            'email', 'role', 'empresa_id', 'user_id',
            'nome', 'departamento',
            'usuario', 'user', 'me', 'auth_user', 'profile', 'auth',
            'usuario_avatar', 'avatar_url'
          ].forEach(function (k) {
            localStorage.removeItem(k);
          });
          sessionStorage.clear();
        } catch (e) {}
        location.href = '/frontend/login';
      });
    })();
  }

  // =====================================================
  // 6) Liga botões que abrem o flyout
  // =====================================================
  function bindTriggers() {
    var ids = ['btnSidebarFlyout', 'btnKebabHeader'];
    var count = 0;
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el || el.dataset.zcFlyoutBound) return;
      el.dataset.zcFlyoutBound = '1';
      count++;
      console.log('[flyout.js] trigger ligado -> #' + id);
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        console.log('[flyout.js] click em #' + id);
        loadSidebar().then(openFlyout);
      });
    });
    return count;
  }

  // tenta ligar os triggers algumas vezes
  (function ensureTriggers() {
    var tentativas = 0;
    function tryBind() {
      var bound = bindTriggers();
      if (bound === 0 && tentativas < 10) {
        tentativas++;
        setTimeout(tryBind, 300);
      }
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      tryBind();
    } else {
      document.addEventListener('DOMContentLoaded', tryBind);
    }
  })();

  // =====================================================
  // 7) API global (se quiser abrir via JS: ZC_FLYOUT.open())
  // =====================================================
  window.ZC_FLYOUT = {
    open: function () {
      return loadSidebar().then(openFlyout);
    },
    close: closeFlyout,
    toggle: function () {
      if (isOpen) {
        closeFlyout();
      } else {
        return loadSidebar().then(openFlyout);
      }
    }
  };
})();
