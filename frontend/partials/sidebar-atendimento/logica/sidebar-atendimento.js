(function () {
  if (window.__ZC_SIDEBAR_ATENDIMENTOS_PROFILE_FIX_20260516__) return;
  window.__ZC_SIDEBAR_ATENDIMENTOS_PROFILE_FIX_20260516__ = true;

  var JS_BASE = '/frontend/js/atendimentos/ui/';

  var SETTINGS_JS = [
    'settings-panel-pages.js',
    'perfil-instancia.js',
    'conta.js',
    'privacidade.js',
    'notificacao.js',
    'atalhos-teclado.js',
    'ajuda-feedback.js'
  ];

  var sidebar = document.getElementById('wppAtendSidebar');
  var mobileToggle = document.getElementById('wppMobileToggle');
  var mobileClose = document.getElementById('wppMobileClose');
  var mobileOverlay = document.getElementById('wppMobileOverlay');

  var userBtn = document.getElementById('wppUserMenuBtn');
  var avatarImg = document.getElementById('wppUserAvatarImg');
  var initialsEl = document.getElementById('wppUserInitials');
  var userNameEl = document.getElementById('wppUserName');
  var userEmailEl = document.getElementById('wppUserEmail');
  var settingsAvatarImg = document.getElementById('zcWaSettingsAvatarImg');
  var settingsAvatarInitials = document.getElementById('zcWaSettingsAvatarInitials');

  var overlay = document.getElementById('zcWaSettingsOverlay');
  var closeBtn = document.getElementById('zcWaSettingsClose');
  var search = document.getElementById('zcWaSettingsSearch');
  var notice = document.getElementById('zcWaNotice');
  var noticeClose = document.getElementById('zcWaNoticeClose');
  var logoutBtn = document.getElementById('zcWaSettingsLogout');

  if (!overlay) return;

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalize(value) {
    return cleanText(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function isMobile() {
    try {
      return window.matchMedia('(max-width: 920px)').matches;
    } catch (e) {
      return window.innerWidth <= 920;
    }
  }


  function syncSettingsSectionVisibility() {
    if (!overlay) return;
    overlay.querySelectorAll('[data-zc-settings-section]').forEach(function (label) {
      var group = label.getAttribute('data-zc-settings-section');
      var visible = Array.from(overlay.querySelectorAll('[data-zc-settings-group="' + group + '"]'))
        .some(function (item) { return !item.classList.contains('is-hidden-search'); });
      label.classList.toggle('is-hidden-search', !visible);
    });
  }

  function scriptId(src) {
    return 'zc-sidebar-script-' + String(src || '')
      .replace(/^https?:\/\//i, '')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '');
  }

  function scriptAlreadyLoaded(src) {
    try {
      var target = new URL(src, location.origin).href;

      return Array.from(document.scripts || []).some(function (script) {
        var current = script.getAttribute('src') || script.src || '';
        if (!current) return false;
        return new URL(current, location.origin).href === target;
      });
    } catch (e) {
      return false;
    }
  }

  function loadScriptOnce(src) {
    return new Promise(function (resolve) {
      try {
        var finalSrc = src.charAt(0) === '/' ? src : JS_BASE + src;

        if (scriptAlreadyLoaded(finalSrc)) {
          resolve(true);
          return;
        }

        var script = document.createElement('script');
        script.id = scriptId(finalSrc);
        script.src = finalSrc;
        script.async = false;

        script.onload = function () {
          resolve(true);
        };

        script.onerror = function () {
          console.warn('[ZapsChat][sidebar] Não carregou:', finalSrc);
          resolve(false);
        };

        document.body.appendChild(script);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function ensureSettingsJs() {
    for (var i = 0; i < SETTINGS_JS.length; i++) {
      await loadScriptOnce(SETTINGS_JS[i]);
    }

    return true;
  }

  function readJson(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function jwtInfo() {
    try {
      var token =
        localStorage.getItem('access_token') ||
        localStorage.getItem('token') ||
        localStorage.getItem('jwt') ||
        '';

      if (!token || token.split('.').length < 2) return {};

      var payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var json = decodeURIComponent(
        atob(payload)
          .split('')
          .map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          })
          .join('')
      );

      return JSON.parse(json) || {};
    } catch (e) {
      return {};
    }
  }

  function getUser() {
    var obj =
      readJson('usuario') ||
      readJson('user') ||
      readJson('zc:user') ||
      readJson('auth_user') ||
      {};

    var jwt = jwtInfo();

    var nome =
      obj.nome ||
      obj.name ||
      obj.nome_completo ||
      obj.full_name ||
      jwt.name ||
      jwt.given_name ||
      jwt.nickname ||
      localStorage.getItem('usuario_nome') ||
      localStorage.getItem('nome') ||
      '';

    var email =
      obj.email ||
      jwt.email ||
      localStorage.getItem('usuario_email') ||
      localStorage.getItem('email') ||
      jwt.preferred_username ||
      '';

    // O claim `sub` do JWT é o ID interno do usuário (ex.: 20), não um e-mail.
    // Também evita que outro identificador puramente numérico apareça como contato.
    if (/^\d+$/.test(cleanText(email))) email = '';

    var departamento =
      obj.departamento ||
      obj.setor ||
      (obj.user && (obj.user.departamento || obj.user.setor)) ||
      '';

    var avatar =
      obj.avatar_url ||
      obj.avatar ||
      obj.foto ||
      jwt.picture ||
      localStorage.getItem('usuario_avatar') ||
      localStorage.getItem('avatar_url') ||
      '';

    return {
      nome: cleanText(nome) || 'Usuário',
      email: cleanText(email) || cleanText(departamento) || 'Sem e-mail',
      avatar: cleanText(avatar)
    };
  }

  function initials(name) {
    name = cleanText(name);
    if (!name) return 'U';

    var parts = name.split(' ').filter(Boolean);

    if (parts.length === 1) {
      return parts[0].charAt(0).toUpperCase();
    }

    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  function setAvatar(img, initialsSpan, avatarUrl, ini, options) {
    options = options || {};

    if (initialsSpan) {
      initialsSpan.textContent = ini || 'U';
      initialsSpan.style.display = '';
    }

    if (!img) return;

    img.dataset.avatarKind = cleanText(options.kind || '');
    img.dataset.instanciaId = cleanText(options.instanciaId || '');

    if (options.alt) {
      img.alt = cleanText(options.alt);
    }

    if (!avatarUrl) {
      img.removeAttribute('src');
      img.style.display = 'none';
      return;
    }

    var src = avatarUrl;

    if (src.indexOf('data:') !== 0) {
      src += (src.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(Date.now());
    }

    img.onerror = function () {
      img.removeAttribute('src');
      img.style.display = 'none';
      if (initialsSpan) initialsSpan.style.display = '';

      if (typeof options.onError === 'function') {
        try {
          options.onError(avatarUrl);
        } catch (e) {}
      }
    };

    img.onload = function () {
      img.style.display = 'block';
      if (initialsSpan) initialsSpan.style.display = 'none';
    };

    img.src = src;
  }

  var settingsInstanceRequestSeq = 0;
  var sidebarAvatarRequestSeq = 0;
  var sidebarAvatarRefreshInFlight = {};
  var sidebarAvatarRefreshTriedAt = {};

  function onlyDigits(value) {
    return cleanText(value).replace(/\D+/g, '');
  }

  function formatWhatsappNumber(value) {
    var raw = cleanText(value);
    var digits = onlyDigits(raw);

    if (!digits) return '';

    if (digits.length === 13 && digits.indexOf('55') === 0) {
      return '+55 ' + digits.slice(2, 4) + ' ' + digits.slice(4, 9) + '-' + digits.slice(9);
    }

    if (digits.length === 12 && digits.indexOf('55') === 0) {
      return '+55 ' + digits.slice(2, 4) + ' ' + digits.slice(4, 8) + '-' + digits.slice(8);
    }

    if (digits.length === 11) {
      return '+55 ' + digits.slice(0, 2) + ' ' + digits.slice(2, 7) + '-' + digits.slice(7);
    }

    if (digits.length === 10) {
      return '+55 ' + digits.slice(0, 2) + ' ' + digits.slice(2, 6) + '-' + digits.slice(6);
    }

    return raw.charAt(0) === '+' ? raw : digits;
  }

  function getSelectedInstanceValue() {
    try {
      if (typeof window.getInstanciaAtiva === 'function') {
        var active = cleanText(window.getInstanciaAtiva());
        if (active) return active;
      }
    } catch (e) {}

    var globalActive = cleanText(window.INSTANCIA_ATIVA);
    if (globalActive) return globalActive;

    var activeButton = document.querySelector('#inst-switch .inst-pill.is-active, #inst-switch .inst-pill[aria-selected="true"], #inst-switch .inst-pill[aria-pressed="true"]');
    return cleanText(activeButton && activeButton.getAttribute('data-value'));
  }

  function getSelectedInstanceRow(value) {
    var wanted = cleanText(value);
    if (!wanted) return null;

    var lists = [
      window.ZC_INSTANCIAS,
      window.INSTANCIAS,
      window.state && window.state.instancias
    ];

    for (var i = 0; i < lists.length; i++) {
      var list = lists[i];
      if (!Array.isArray(list)) continue;

      for (var j = 0; j < list.length; j++) {
        var row = list[j] || {};
        var rowValue = cleanText(
          row.instancia_id != null ? row.instancia_id :
          row.id != null ? row.id :
          row.instance_id != null ? row.instance_id :
          row.instancia != null ? row.instancia :
          row.instance_name
        );

        if (rowValue === wanted) return row;
      }
    }

    return null;
  }

  function getInstancePhoneFromObject(obj) {
    obj = obj && typeof obj === 'object' ? obj : {};

    return formatWhatsappNumber(
      obj.telefone_fmt ||
      obj.telefone_e164 ||
      obj.numero_instancia ||
      obj.numero ||
      obj.telefone ||
      obj.phone ||
      obj.whatsapp_number ||
      obj.whatsapp ||
      obj.wuid ||
      ''
    );
  }

  function getInstanceId(value, row) {
    row = row && typeof row === 'object' ? row : {};

    var candidates = [
      row.instancia_id,
      row.id,
      row.instance_id,
      row.whatsapp_id,
      value
    ];

    for (var i = 0; i < candidates.length; i++) {
      var candidate = cleanText(candidates[i]);
      if (/^\d+$/.test(candidate) && Number(candidate) > 0) {
        return candidate;
      }
    }

    try {
      var debug = window.ZCPerfilInstancia &&
        typeof window.ZCPerfilInstancia.getSelectedInstanceDebugInfo === 'function'
        ? window.ZCPerfilInstancia.getSelectedInstanceDebugInfo()
        : null;

      var debugId = cleanText(debug && debug.instanciaId);
      if (/^\d+$/.test(debugId) && Number(debugId) > 0) return debugId;
    } catch (e) {}

    return '';
  }

  function getInstanceLabel(value, row) {
    row = row && typeof row === 'object' ? row : {};

    return cleanText(
      row.apelido ||
      row.nome_exibicao ||
      row.display_name ||
      row.nome ||
      row.name ||
      row.instance_name ||
      value ||
      'WhatsApp'
    );
  }

  function getInstanceAvatarFromObject(obj) {
    obj = obj && typeof obj === 'object' ? obj : {};

    var profile = obj.profile && typeof obj.profile === 'object' ? obj.profile : {};
    var perfil = obj.perfil && typeof obj.perfil === 'object' ? obj.perfil : {};
    var raw = obj.raw && typeof obj.raw === 'object' ? obj.raw : {};

    var avatar = cleanText(
      obj.perfil_avatar_url ||
      obj.avatar_url ||
      obj.avatar ||
      obj.avatar_remote_url ||
      obj.profilePictureUrl ||
      obj.profile_picture_url ||
      obj.picture ||
      profile.perfil_avatar_url ||
      profile.avatar_url ||
      profile.avatar ||
      profile.profilePictureUrl ||
      perfil.perfil_avatar_url ||
      perfil.avatar_url ||
      perfil.avatar ||
      raw.perfil_avatar_url ||
      raw.avatar_url ||
      raw.avatar ||
      raw.profilePictureUrl ||
      ''
    );

    if (!avatar || avatar === 'null' || avatar === 'undefined') return '';
    return avatar;
  }

  function readInstanceProfileCache(instanciaId) {
    var id = cleanText(instanciaId);
    if (!/^\d+$/.test(id)) return null;

    try {
      var payload = readJson('zc:perfil-instancia:v2:' + id);
      if (!payload || typeof payload !== 'object') return null;

      if (payload.user && typeof payload.user === 'object') {
        return payload.user;
      }

      return payload;
    } catch (e) {
      return null;
    }
  }

  function getSelectedInstanceMeta() {
    var value = getSelectedInstanceValue();
    if (!value) return null;

    var row = getSelectedInstanceRow(value);
    var id = getInstanceId(value, row);
    if (!id) return null;

    return {
      value: value,
      id: id,
      row: row || {},
      label: getInstanceLabel(value, row)
    };
  }

  function renderSidebarUserAvatar(user) {
    user = user && typeof user === 'object' ? user : getUser();
    var label = initials(user.nome || user.email);

    setAvatar(
      avatarImg,
      initialsEl,
      user.avatar,
      label,
      {
        kind: 'user',
        instanciaId: '',
        alt: 'Avatar do usuário'
      }
    );

    setAvatar(
      settingsAvatarImg,
      settingsAvatarInitials,
      user.avatar,
      label,
      {
        kind: 'user',
        instanciaId: '',
        alt: 'Avatar do usuário'
      }
    );
  }

  function renderSidebarInstanceAvatar(meta, avatarUrl, onError) {
    if (!meta) return;
    var label = initials(meta.label || 'WhatsApp');
    var opts = {
      kind: 'instance',
      instanciaId: meta.id,
      alt: 'Foto do WhatsApp ' + (meta.label || 'selecionado'),
      onError: onError
    };

    setAvatar(avatarImg, initialsEl, avatarUrl, label, opts);
    setAvatar(settingsAvatarImg, settingsAvatarInitials, avatarUrl, label, opts);
  }

  async function refreshSidebarInstanceAvatarAfterError(meta, requestSeq, brokenAvatar) {
    if (!meta || !meta.id) return;
    if (requestSeq !== sidebarAvatarRequestSeq) return;

    var current = getSelectedInstanceMeta();
    if (!current || current.id !== meta.id) return;

    var now = Date.now();
    var lastTry = Number(sidebarAvatarRefreshTriedAt[meta.id] || 0);

    if (sidebarAvatarRefreshInFlight[meta.id]) return;
    if (lastTry && now - lastTry < 60000) return;

    sidebarAvatarRefreshTriedAt[meta.id] = now;
    sidebarAvatarRefreshInFlight[meta.id] = true;

    try {
      var response = await fetch(
        '/api/atendimento/instancias/' + encodeURIComponent(meta.id) + '/perfil?refresh=1',
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            'Cache-Control': 'no-cache'
          }
        }
      );

      if (!response.ok) return;

      var data = await response.json();
      var freshAvatar = getInstanceAvatarFromObject(data);

      current = getSelectedInstanceMeta();
      if (requestSeq !== sidebarAvatarRequestSeq || !current || current.id !== meta.id) return;
      if (!freshAvatar || freshAvatar === brokenAvatar) return;

      renderSidebarInstanceAvatar(meta, freshAvatar, null);
    } catch (e) {
      // Mantém as iniciais da instância. Nunca volta para a foto da empresa.
    } finally {
      delete sidebarAvatarRefreshInFlight[meta.id];
    }
  }

  async function syncSidebarAvatar(options) {
    options = options || {};

    var requestSeq = ++sidebarAvatarRequestSeq;
    var user = options.user && typeof options.user === 'object'
      ? options.user
      : getUser();
    var meta = getSelectedInstanceMeta();

    if (!meta) {
      renderSidebarUserAvatar(user);
      return;
    }

    // Com uma instância específica selecionada, nunca exibe a foto da empresa/usuário.
    // Enquanto carrega ou se a instância não tiver foto, mostra apenas as iniciais dela.
    renderSidebarInstanceAvatar(meta, '', null);

    var eventData = options.profile && typeof options.profile === 'object'
      ? options.profile
      : null;
    var eventAvatar = getInstanceAvatarFromObject(eventData);

    if (eventAvatar) {
      renderSidebarInstanceAvatar(meta, eventAvatar, function (brokenAvatar) {
        refreshSidebarInstanceAvatarAfterError(meta, requestSeq, brokenAvatar);
      });
      return;
    }

    var rowAvatar = getInstanceAvatarFromObject(meta.row);
    if (rowAvatar) {
      renderSidebarInstanceAvatar(meta, rowAvatar, function (brokenAvatar) {
        refreshSidebarInstanceAvatarAfterError(meta, requestSeq, brokenAvatar);
      });
    }

    var cached = readInstanceProfileCache(meta.id);
    var cachedAvatar = getInstanceAvatarFromObject(cached);

    if (cachedAvatar) {
      renderSidebarInstanceAvatar(meta, cachedAvatar, function (brokenAvatar) {
        refreshSidebarInstanceAvatarAfterError(meta, requestSeq, brokenAvatar);
      });
    }

    try {
      var response = await fetch(
        '/api/atendimento/instancias/' + encodeURIComponent(meta.id) + '/perfil?refresh=0',
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        }
      );

      if (!response.ok) throw new Error('HTTP ' + response.status);

      var data = await response.json();
      var avatar = getInstanceAvatarFromObject(data);
      var current = getSelectedInstanceMeta();

      if (requestSeq !== sidebarAvatarRequestSeq || !current || current.id !== meta.id) return;

      if (avatar) {
        renderSidebarInstanceAvatar(meta, avatar, function (brokenAvatar) {
          refreshSidebarInstanceAvatarAfterError(meta, requestSeq, brokenAvatar);
        });
      }
    } catch (e) {
      // Mantém a foto já encontrada no cache ou as iniciais da instância.
    }
  }

  function setSettingsInstanceText(text, stateClass) {
    var el = document.getElementById('zcWaSettingsInstanceNumber');
    if (!el) return;

    el.textContent = text;
    el.classList.remove('is-instance-required', 'is-loading');

    if (stateClass) el.classList.add(stateClass);
  }

  function setSidebarInstanceText(text) {
    if (!userEmailEl) return;

    var value = cleanText(text) || 'Selecione uma instância própria no topo';
    userEmailEl.textContent = value;
    userEmailEl.title = value;
  }

  function setInstanceNumberTexts(text, stateClass) {
    setSettingsInstanceText(text, stateClass);
    setSidebarInstanceText(text);
  }

  async function syncSettingsInstanceNumber() {
    var requestSeq = ++settingsInstanceRequestSeq;
    var selected = getSelectedInstanceValue();

    if (!selected) {
      setInstanceNumberTexts('Selecione uma instância própria no topo', 'is-instance-required');
      refreshSettingsHome();
      return;
    }

    var row = getSelectedInstanceRow(selected);
    var instanceId = getInstanceId(selected, row);
    var directPhone = getInstancePhoneFromObject(row);

    if (directPhone) {
      setInstanceNumberTexts(directPhone, '');
      refreshSettingsHome();
      return;
    }

    if (!instanceId) {
      setInstanceNumberTexts('Número do WhatsApp não disponível', '');
      refreshSettingsHome();
      refreshSettingsHome();
      return;
    }

    setInstanceNumberTexts('Carregando número do WhatsApp…', 'is-loading');

    try {
      var response = await fetch(
        '/api/atendimento/instancias/' + encodeURIComponent(instanceId) + '/perfil?refresh=0',
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        }
      );

      if (requestSeq !== settingsInstanceRequestSeq) return;
      if (!response.ok) throw new Error('HTTP ' + response.status);

      var data = await response.json();
      var phone = getInstancePhoneFromObject(data);

      setInstanceNumberTexts(phone || 'Número do WhatsApp não informado', '');
      refreshSettingsHome();
    } catch (e) {
      if (requestSeq !== settingsInstanceRequestSeq) return;
      setInstanceNumberTexts('Número do WhatsApp não disponível', '');
    }
  }

  function syncUser() {
    var user = getUser();

    if (userNameEl) userNameEl.textContent = user.nome;

    var panelName = document.getElementById('zcWaSettingsName');
    if (panelName) panelName.textContent = user.nome;

    syncSidebarAvatar({ user: user });
    syncSettingsInstanceNumber();
    setTimeout(refreshSettingsHome, 20);
  }

  function currentMenu() {
    var p = String(location.pathname || '').toLowerCase().trim();
    p = p.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';

    if (p === '/' || p === '/dashboard' || p === '/dashboard.html' || p === '/inicio') return 'dashboard';
    if (p.indexOf('/atendimentos') === 0 || p === '/atendimentos.html') return 'atendimentos';
    if (p.indexOf('/midias') === 0 || p === '/midias.html') return 'midias';
    if (p.indexOf('/chat-interno') === 0 || p === '/chat-interno.html') return 'chat-interno';
    if (p.indexOf('/clientes') === 0 || p === '/clientes.html') return 'clientes';
    if (p.indexOf('/colaboradores') === 0 || p === '/colaboradores.html') return 'colaboradores';
    if (p.indexOf('/departamentos') === 0 || p === '/departamentos.html') return 'departamentos';
    if (p.indexOf('/chatbot') === 0 || p === '/chatbot.html') return 'chatbot';
    if (p.indexOf('/disparos') === 0 || p === '/disparos.html') return 'disparos';
    if (p.indexOf('/conectar') === 0 || p === '/conectar.html') return 'conectar';
    if (p.indexOf('/filas') === 0 || p === '/filas.html') return 'filas';

    return '';
  }

  function markActive() {
    var cur = currentMenu();

    document.querySelectorAll('.wpp-leftbar-icon[data-menu]').forEach(function (el) {
      var on = el.getAttribute('data-menu') === cur;
      el.classList.toggle('is-active', on);

      if (on) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
  }

  function openSidebar() {
    if (!sidebar) return;

    sidebar.classList.add('show');

    if (mobileOverlay) {
      mobileOverlay.classList.add('show');
    }

    if (mobileToggle) {
      mobileToggle.setAttribute('aria-expanded', 'true');
    }

    if (isMobile()) {
      try {
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
      } catch (e) {}
    }
  }

  function closeSidebar() {
    if (sidebar) {
      sidebar.classList.remove('show');
    }

    if (mobileOverlay) {
      mobileOverlay.classList.remove('show');
    }

    if (mobileToggle) {
      mobileToggle.setAttribute('aria-expanded', 'false');
    }

    try {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    } catch (e) {}
  }

  function setActiveSettingsItem(item) {
    overlay.querySelectorAll('[data-zc-settings-tab]').forEach(function (btn) {
      btn.classList.toggle('is-active', btn === item);
    });
  }

  function closeSettingsPage() {
    try {
      if (window.ZCSettingsPage && typeof window.ZCSettingsPage.closePage === 'function') {
        window.ZCSettingsPage.closePage();
      }
    } catch (e) {}
  }

  function resetSettingsHome() {
    var home = document.getElementById('zcWaSettingsHomeCard');
    var detail = document.getElementById('zcWaSettingsDetail');

    closeSettingsPage();

    overlay.classList.remove('zc-settings-page-open');

    if (home) home.style.display = '';
    if (detail) {
      detail.style.display = 'none';
      detail.classList.remove('is-open');
      detail.setAttribute('aria-hidden', 'true');
    }

    if (search) search.value = '';

    overlay.querySelectorAll('.zc-wa-settings-item[data-search]').forEach(function (item) {
      item.classList.remove('is-hidden-search');
    });
    syncSettingsSectionVisibility();

    var settingsItem = overlay.querySelector('[data-zc-settings-tab="settings"]');
    if (settingsItem) setActiveSettingsItem(settingsItem);
    refreshSettingsHome();
  }

  function openPanel(tab) {
    syncUser();
    closeSidebar();

    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');

    if (userBtn) {
      userBtn.classList.add('active');
      userBtn.setAttribute('aria-expanded', 'true');
    }

    try {
      document.body.style.overflow = 'hidden';
    } catch (e) {}

    ensureSettingsJs().then(function () {
      if (tab) {
        openSettingsTab(tab);
      } else {
        resetSettingsHome();
      }

      refreshSettingsHome();

      setTimeout(function () {
        try {
          if (search) search.focus();
        } catch (e) {}
      }, 60);
    });
  }

  function closePanel() {
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');

    if (userBtn) {
      userBtn.classList.remove('active');
      userBtn.setAttribute('aria-expanded', 'false');
    }

    try {
      document.body.style.overflow = '';
    } catch (e) {}
  }

  function setPreferredTheme(mode) {
    var root = document.documentElement;
    var resolved = mode;
    if (mode === 'system') {
      var prefersDark = false;
      try {
        prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      } catch (e) {}
      resolved = prefersDark ? 'dark' : 'light';
    }

    root.setAttribute('data-theme', resolved);
    root.classList.toggle('dark', resolved === 'dark');

    try {
      localStorage.setItem('zapschat_theme', resolved);
      localStorage.setItem('zc:theme', mode);
      localStorage.setItem('theme', resolved);
      localStorage.setItem('valora_theme', resolved);
    } catch (e) {}

    try {
      window.dispatchEvent(new CustomEvent('zc:theme-changed', { detail: { theme: mode, resolvedTheme: resolved } }));
    } catch (e) {}

    refreshSettingsHome();
  }

  function getSavedThemeMode() {
    try {
      var canonical = localStorage.getItem('zapschat_theme');
      var preferred = localStorage.getItem('zc:theme');

      if (preferred === 'system') {
        var prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        var systemResolved = prefersDark ? 'dark' : 'light';
        if (!canonical || canonical === systemResolved) return 'system';
      }

      if (canonical === 'dark' || canonical === 'light') return canonical;
      if (preferred === 'dark' || preferred === 'light') return preferred;

      var legacy = localStorage.getItem('theme') || localStorage.getItem('valora_theme');
      return legacy === 'dark' || legacy === 'light' ? legacy : '';
    } catch (e) {
      return '';
    }
  }

  function refreshSettingsHome() {
    var user = getUser();
    var selected = getSelectedInstanceValue();
    var row = getSelectedInstanceRow(selected);
    var meta = getSelectedInstanceMeta();
    var instanceName = '';
    if (meta && meta.nome) instanceName = meta.nome;
    if (!instanceName && row) instanceName = cleanText(row.getAttribute('data-label') || row.textContent);
    if (!instanceName) instanceName = 'Instância não selecionada';

    var userNameHome = document.getElementById('zcWaHomeUserName');
    if (userNameHome) userNameHome.textContent = user.nome || 'Usuário';

    var userPhoneHome = document.getElementById('zcWaHomeUserPhone');
    if (userPhoneHome) {
      var settingsText = document.getElementById('zcWaSettingsInstanceNumber');
      var phoneText = settingsText ? cleanText(settingsText.textContent) : '';
      userPhoneHome.textContent = phoneText || 'Selecione uma instância própria no topo';
    }

    var homeAvatarImg = document.getElementById('zcWaHomeAvatarImg');
    var homeAvatarInitials = document.getElementById('zcWaHomeAvatarInitials');
    var avatarSrc = '';
    try { avatarSrc = avatarImg && avatarImg.getAttribute('src') ? avatarImg.getAttribute('src') : ''; } catch (e) {}
    if (homeAvatarInitials) homeAvatarInitials.textContent = getInitials((user && user.nome) || 'Usuário');
    if (homeAvatarImg) {
      if (avatarSrc) {
        homeAvatarImg.src = avatarSrc;
        homeAvatarImg.style.display = '';
        if (homeAvatarInitials) homeAvatarInitials.style.display = 'none';
      } else {
        homeAvatarImg.removeAttribute('src');
        homeAvatarImg.style.display = 'none';
        if (homeAvatarInitials) homeAvatarInitials.style.display = '';
      }
    }

    var instanceNameEl = document.getElementById('zcWaHomeInstanceName');
    if (instanceNameEl) instanceNameEl.textContent = instanceName;
    var instancePhoneEl = document.getElementById('zcWaHomeInstancePhone');
    if (instancePhoneEl) {
      var settingsText2 = document.getElementById('zcWaSettingsInstanceNumber');
      instancePhoneEl.textContent = settingsText2 ? cleanText(settingsText2.textContent) : 'Selecione uma instância própria no topo';
    }
    var instanceStatus = document.getElementById('zcWaHomeInstanceStatus');
    if (instanceStatus) instanceStatus.textContent = selected ? 'Conectado' : 'Aguardando seleção';

    var headline = document.getElementById('zcWaSettingsHomeHeadline');
    var subline = document.getElementById('zcWaSettingsHomeSubline');
    var badge = document.getElementById('zcWaSettingsHomeBadge');
    if (selected) {
      if (headline) headline.textContent = 'Tudo pronto para uso';
      if (subline) subline.textContent = 'Seu painel está configurado e funcionando normalmente.';
      if (badge) badge.innerHTML = '<i></i><span>Ajustes rápidos</span>';
    } else {
      if (headline) headline.textContent = 'Falta selecionar um WhatsApp';
      if (subline) subline.textContent = 'Escolha uma instância própria no topo para liberar recursos ligados ao atendimento.';
      if (badge) badge.innerHTML = '<i></i><span>Configuração inicial</span>';
    }

    var notifStatus = document.getElementById('zcWaSettingsNotifStatus');
    if (notifStatus) {
      var enabled = false;
      try { enabled = 'Notification' in window && Notification.permission === 'granted'; } catch (e) {}
      notifStatus.textContent = enabled ? 'Ativadas' : 'Configuração pendente';
      notifStatus.style.color = enabled ? '' : 'var(--zc-wa-muted)';
    }

    var savedMode = getSavedThemeMode() || ((document.documentElement.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark') ? 'dark' : 'light');
    overlay.querySelectorAll('[data-zc-theme-option]').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-zc-theme-option') === savedMode);
    });
  }

  function openSettingsItemByTab(tab) {
    var item = overlay.querySelector('[data-zc-settings-tab="' + tab + '"]');
    if (item) item.click();
  }

  function titleFromTab(tab) {
    var map = {
      profile: 'Perfil',
      perfil: 'Perfil',
      account: 'Conta',
      conta: 'Conta',
      privacy: 'Privacidade',
      privacidade: 'Privacidade',
      notifications: 'Notificações',
      notificacoes: 'Notificações',
      notificações: 'Notificações',
      shortcuts: 'Atalhos do teclado',
      atalhos: 'Atalhos do teclado',
      help: 'Ajuda e feedback',
      ajuda: 'Ajuda e feedback'
    };

    return map[normalize(tab)] || cleanText(tab);
  }

  function openByTitle(title) {
    var H = window.ZCSettingsPage;

    if (!H) return false;

    var methods = ['openByTitle', 'openPage', 'open', 'show', 'showPage', 'setPage', 'navigate', 'go'];

    for (var i = 0; i < methods.length; i++) {
      var name = methods[i];

      if (typeof H[name] !== 'function') continue;

      try {
        if (H[name](title)) return true;
      } catch (e) {}
    }

    return false;
  }

  function openRegisteredTitle(title) {
    if (!title) return false;

    function attempt() {
      return openByTitle(title);
    }

    if (attempt()) return true;

    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;

      if (attempt() || tries >= 15) {
        clearInterval(timer);
      }
    }, 120);

    return true;
  }

  function openProfilePage() {
    ensureSettingsJs().then(function () {
      /*
        Perfil agora abre pelo mesmo fluxo das outras páginas:
        ZCSettingsPage -> página dentro do painel esquerdo -> botão voltar limpa corretamente.
        Isso evita travar o segundo clique depois de voltar.
      */
      if (openRegisteredTitle('Perfil')) {
        return;
      }

      /*
        Fallback antigo, só se o registro do Perfil ainda não existir.
        Não deve ser o caminho principal.
      */
      var fn = window.abrirPerfilInstanciaUsuario || window.zcAbrirMeuPerfilAtendimento;

      if (typeof fn === 'function') {
        try {
          fn();
        } catch (e) {}
      }
    });
  }

  function toggleTheme() {
    var root = document.documentElement;
    var current = root.getAttribute('data-theme') || (root.classList.contains('dark') ? 'dark' : 'light');
    var next = current === 'dark' ? 'light' : 'dark';

    root.setAttribute('data-theme', next);
    root.classList.toggle('dark', next === 'dark');

    try {
      localStorage.setItem('zapschat_theme', next);
      localStorage.setItem('zc:theme', next);
      localStorage.setItem('theme', next);
      localStorage.setItem('valora_theme', next);
    } catch (e) {}

    try {
      window.dispatchEvent(new CustomEvent('zc:theme-changed', { detail: { theme: next } }));
    } catch (e) {}
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      });
    } catch (e) {}

    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {}

    window.location.replace('/login');
  }

  function openSettingsTab(tab, clickedItem) {
    var normalized = normalize(tab);

    if (clickedItem) {
      setActiveSettingsItem(clickedItem);
    }

    if (normalized === 'settings' || normalized === 'configuracoes' || normalized === 'configurações') {
      resetSettingsHome();
      return;
    }

    if (normalized === 'theme') {
      toggleTheme();
      return;
    }

    if (normalized === 'logout') {
      logout();
      return;
    }

    if (normalized === 'profile' || normalized === 'perfil') {
      openProfilePage();
      return;
    }

    ensureSettingsJs().then(function () {
      openRegisteredTitle(titleFromTab(tab));
    });
  }

  if (mobileToggle) {
    mobileToggle.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();

      if (sidebar && sidebar.classList.contains('show')) {
        closeSidebar();
      } else {
        openSidebar();
      }
    });
  }

  if (mobileClose) {
    mobileClose.addEventListener('click', function (event) {
      event.preventDefault();
      closeSidebar();
    });
  }

  if (mobileOverlay) {
    mobileOverlay.addEventListener('click', closeSidebar);
  }

  if (userBtn) {
    userBtn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();

      if (event.stopImmediatePropagation) {
        event.stopImmediatePropagation();
      }

      openPanel();
    }, true);
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', function (event) {
      event.preventDefault();
      closePanel();
    });
  }

  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) {
      closePanel();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && overlay.classList.contains('is-open')) {
      closePanel();
    }
  });

  window.addEventListener('zc:theme-changed', refreshSettingsHome);

  overlay.querySelectorAll('.zc-wa-settings-item[data-zc-settings-tab]').forEach(function (item) {
    item.addEventListener('click', function (event) {
      var tab = item.getAttribute('data-zc-settings-tab') || '';
      var title = item.getAttribute('data-title') || titleFromTab(tab);

      event.preventDefault();
      event.stopPropagation();

      if (event.stopImmediatePropagation) {
        event.stopImmediatePropagation();
      }

      if (tab === 'settings') {
        resetSettingsHome();
        return;
      }

      if (tab === 'theme') {
        toggleTheme();
        return;
      }

      if (tab === 'logout') {
        logout();
        return;
      }

      setActiveSettingsItem(item);

      if (tab === 'profile') {
        openProfilePage();
        return;
      }

      ensureSettingsJs().then(function () {
        openRegisteredTitle(title);
      });
    }, true);
  });

  if (search) {
    search.addEventListener('input', function () {
      var q = normalize(search.value);

      overlay.querySelectorAll('.zc-wa-settings-item[data-search]').forEach(function (item) {
        var hay = normalize(
          item.getAttribute('data-search') + ' ' +
          item.getAttribute('data-title') + ' ' +
          item.textContent
        );

        item.classList.toggle('is-hidden-search', !!q && hay.indexOf(q) < 0);
      });
      syncSettingsSectionVisibility();
    });
  }

  if (noticeClose && notice) {
    noticeClose.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      notice.classList.add('is-hidden');

      try {
        localStorage.setItem('zc:settings_notice_hidden', '1');
      } catch (e) {}
    });

    try {
      if (localStorage.getItem('zc:settings_notice_hidden') === '1') {
        notice.classList.add('is-hidden');
      }
    } catch (e) {}
  }

  if (notice) {
    var openNoticeSettings = function (event) {
      if (event && event.target && event.target.closest && event.target.closest('#zcWaNoticeClose')) return;
      var item = overlay.querySelector('[data-zc-settings-tab="notifications"]');
      if (item) item.click();
    };

    notice.addEventListener('click', openNoticeSettings);
    notice.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openNoticeSettings(event);
    });
  }

  overlay.querySelectorAll('[data-home-open-tab]').forEach(function (btn) {
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      openSettingsItemByTab(btn.getAttribute('data-home-open-tab') || '');
    });
  });

  overlay.querySelectorAll('[data-zc-theme-option]').forEach(function (btn) {
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      setPreferredTheme(btn.getAttribute('data-zc-theme-option') || 'light');
    });
  });

  if (logoutBtn) {
    logoutBtn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      logout();
    }, true);
  }

  window.ZCOpenWppSettingsPanel = openPanel;
  window.ZCCloseWppSettingsPanel = closePanel;
  window.ZCOpenSettingsTab = openSettingsTab;
  window.ZCOpenPerfilInstanciaFromSidebar = openProfilePage;

  window.addEventListener('storage', syncUser);

  document.addEventListener('inst:change', function () {
    syncSettingsInstanceNumber();
    syncSidebarAvatar();
  });

  document.addEventListener('inst:list', function () {
    syncSettingsInstanceNumber();
    syncSidebarAvatar();
  });

  window.addEventListener('zc:perfil-instancia-updated', function (event) {
    var detail = event && event.detail && typeof event.detail === 'object'
      ? event.detail
      : {};
    var selected = getSelectedInstanceMeta();
    var updatedId = cleanText(detail.instancia_id || detail.id || '');

    if (!selected || (updatedId && selected.id !== updatedId)) return;

    syncSidebarAvatar({
      profile: detail.user || detail.profile || detail.data || detail
    });
  });

  window.addEventListener('zc:settings-page-helper-ready', function () {
    try {
      if (overlay.classList.contains('is-open')) {
        ensureSettingsJs();
      }
    } catch (e) {}
  });

  markActive();
  syncUser();
  ensureSettingsJs();
})();
