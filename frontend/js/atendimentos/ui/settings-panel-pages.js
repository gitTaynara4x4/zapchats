/* ====================================================================
 * ZapsChat – Helper das páginas internas do painel estilo WhatsApp
 * /frontend/js/atendimentos/ui/settings-panel-pages.js
 *
 * Usado por:
 * - conta.js
 * - privacidade.js
 * - conversas.js
 * - notificacao.js
 * - atalhos-teclado.js
 * - ajuda-feedback.js
 * - perfil-instancia.js
 *
 * Ajustado:
 * - Fundo dark geral: #161717
 * - Fundo light geral: #FFFFFF
 * - Corrige também a tela raiz do painel no tema claro
 * - Corrige textos apagados no light
 * - Corrige search escuro no light
 * - Visual mais clean, menos pesado/negrito
 * - Mantém o padrão H.register / H.block / H.list / H.row
 * - Não mexe no fundo/papel de parede do chat
 * ==================================================================== */

'use strict';

(function () {
  if (window.__ZC_SETTINGS_PANEL_PAGES_HELPER__) return;
  window.__ZC_SETTINGS_PANEL_PAGES_HELPER__ = true;

  const REGISTRY = [];

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function clean(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function normalize(value) {
    return clean(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function qs(selector, root = document) {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }

  function qsa(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function ensureStyle() {
    let style = document.getElementById('zcSettingsInternalPagesStyle');

    if (!style) {
      style = document.createElement('style');
      style.id = 'zcSettingsInternalPagesStyle';
      document.head.appendChild(style);
    }

    style.textContent = `
      :root{
        --zc-settings-bg-dark:#161717;
        --zc-settings-bg-light:#ffffff;

        --zc-settings-bg:#161717;
        --zc-settings-panel-bg:#161717;
        --zc-settings-surface:#161717;
        --zc-settings-surface-2:#111b21;
        --zc-settings-input:#0b141a;
        --zc-settings-hover:rgba(255,255,255,.055);
        --zc-settings-border:rgba(255,255,255,.075);

        --zc-settings-title:#e9edef;
        --zc-settings-text:#d9dee1;
        --zc-settings-muted:#aebac1;
        --zc-settings-soft:#8696a0;
        --zc-settings-accent:#00a884;
        --zc-settings-accent-2:#25d366;
        --zc-settings-accent-soft:rgba(0,168,132,.12);

        --zc-settings-shortcut-bg:rgba(255,255,255,.055);
        --zc-settings-toast-bg:#202c33;
        --zc-settings-toast-text:#e9edef;
      }

      html[data-theme="dark"],
      html[data-bs-theme="dark"],
      html.dark,
      html.theme-dark,
      body.dark,
      body.theme-dark,
      body.dark-mode,
      body[data-theme="dark"],
      body[data-bs-theme="dark"]{
        --zc-settings-bg:#161717;
        --zc-settings-panel-bg:#161717;
        --zc-settings-surface:#161717;
        --zc-settings-surface-2:#111b21;
        --zc-settings-input:#0b141a;
        --zc-settings-hover:rgba(255,255,255,.055);
        --zc-settings-border:rgba(255,255,255,.075);

        --zc-settings-title:#e9edef;
        --zc-settings-text:#d9dee1;
        --zc-settings-muted:#aebac1;
        --zc-settings-soft:#8696a0;
        --zc-settings-accent:#00a884;
        --zc-settings-accent-2:#25d366;
        --zc-settings-accent-soft:rgba(0,168,132,.12);

        --zc-settings-shortcut-bg:rgba(255,255,255,.055);
        --zc-settings-toast-bg:#202c33;
        --zc-settings-toast-text:#e9edef;
      }

      html[data-theme="light"],
      html[data-bs-theme="light"],
      html.light,
      html.theme-light,
      body.light,
      body.theme-light,
      body.light-mode,
      body[data-theme="light"],
      body[data-bs-theme="light"]{
        --zc-settings-bg:#ffffff;
        --zc-settings-panel-bg:#ffffff;
        --zc-settings-surface:#ffffff;
        --zc-settings-surface-2:#ffffff;
        --zc-settings-input:#f6f7f8;
        --zc-settings-hover:rgba(17,27,33,.045);
        --zc-settings-border:rgba(17,27,33,.085);

        --zc-settings-title:#111b21;
        --zc-settings-text:#1f2c33;
        --zc-settings-muted:#667781;
        --zc-settings-soft:#667781;
        --zc-settings-accent:#008069;
        --zc-settings-accent-2:#00a884;
        --zc-settings-accent-soft:rgba(0,128,105,.10);

        --zc-settings-shortcut-bg:#f7f8fa;
        --zc-settings-toast-bg:#ffffff;
        --zc-settings-toast-text:#111b21;
      }

      /* ===============================================================
       * PAINEL RAIZ DE CONFIGURAÇÕES
       * Corrige a tela do print: título apagado, itens apagados e search escuro.
       * =============================================================== */

      #zcWppSettingsProfilePanel{
        color:var(--zc-settings-title) !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsPanel{
        position:relative !important;
        overflow:hidden !important;
        background:var(--zc-settings-panel-bg) !important;
        color:var(--zc-settings-title) !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsPanel *,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel *::before,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel *::after{
        box-sizing:border-box;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsPanel h1,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel h2,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel h3,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel strong,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel b,
      #zcWppSettingsProfilePanel .zcWppSettingsTitle,
      #zcWppSettingsProfilePanel .zcWppSettingsHeaderTitle,
      #zcWppSettingsProfilePanel .zcWppSettingsName,
      #zcWppSettingsProfilePanel .zcWppSettingsProfileTitle,
      #zcWppSettingsProfilePanel .zcWppSettingsProfileName,
      #zcWppSettingsProfilePanel .zcWppSettingsItem strong{
        color:var(--zc-settings-title) !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsPanel p,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel small,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel span,
      #zcWppSettingsProfilePanel .zcWppSettingsSubtitle,
      #zcWppSettingsProfilePanel .zcWppSettingsHeaderSub,
      #zcWppSettingsProfilePanel .zcWppSettingsProfileSub,
      #zcWppSettingsProfilePanel .zcWppSettingsItem span,
      #zcWppSettingsProfilePanel .zcWppSettingsItem small{
        color:var(--zc-settings-muted) !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsBack,
      #zcWppSettingsProfilePanel .zcWppSettingsBackBtn,
      #zcWppSettingsProfilePanel .zcWppSettingsClose,
      #zcWppSettingsProfilePanel .zcWppSettingsCloseBtn,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel button[aria-label="Voltar"],
      #zcWppSettingsProfilePanel .zcWppSettingsPanel button[aria-label="Fechar"]{
        color:var(--zc-settings-title) !important;
        background:transparent !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsBack:hover,
      #zcWppSettingsProfilePanel .zcWppSettingsBackBtn:hover,
      #zcWppSettingsProfilePanel .zcWppSettingsClose:hover,
      #zcWppSettingsProfilePanel .zcWppSettingsCloseBtn:hover,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel button[aria-label="Voltar"]:hover,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel button[aria-label="Fechar"]:hover{
        background:var(--zc-settings-hover) !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsSearch,
      #zcWppSettingsProfilePanel .zcWppSettingsSearchBox,
      #zcWppSettingsProfilePanel .zcWppSettingsSearchWrap,
      #zcWppSettingsProfilePanel .zcWppSettingsSearchBar{
        background:var(--zc-settings-input) !important;
        border:1px solid var(--zc-settings-border) !important;
        color:var(--zc-settings-title) !important;
      }

      #zcWppSettingsProfilePanel input,
      #zcWppSettingsProfilePanel input[type="text"],
      #zcWppSettingsProfilePanel input[type="search"],
      #zcWppSettingsProfilePanel input[placeholder]{
        background:var(--zc-settings-input) !important;
        color:var(--zc-settings-title) !important;
        border-color:var(--zc-settings-border) !important;
        caret-color:var(--zc-settings-accent) !important;
      }

      #zcWppSettingsProfilePanel input::placeholder{
        color:var(--zc-settings-muted) !important;
        opacity:1 !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsSearch i,
      #zcWppSettingsProfilePanel .zcWppSettingsSearchBox i,
      #zcWppSettingsProfilePanel .zcWppSettingsSearchWrap i,
      #zcWppSettingsProfilePanel .zcWppSettingsSearchBar i{
        color:var(--zc-settings-muted) !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsNotice,
      #zcWppSettingsProfilePanel .zcWppSettingsBanner,
      #zcWppSettingsProfilePanel .zcWppSettingsAlert,
      #zcWppSettingsProfilePanel .zcWppSettingsNotification,
      #zcWppSettingsProfilePanel .zcWppSettingsNotificationCard,
      #zcWppSettingsProfilePanel .zcWppSettingsNotify,
      #zcWppSettingsProfilePanel .zcWppSettingsNotifyBox,
      #zcWppSettingsProfilePanel .zcWppSettingsPermission,
      #zcWppSettingsProfilePanel .zcWppSettingsPermissionBox{
        background:var(--zc-settings-input) !important;
        border:1px solid var(--zc-settings-border) !important;
        color:var(--zc-settings-title) !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsNotice strong,
      #zcWppSettingsProfilePanel .zcWppSettingsBanner strong,
      #zcWppSettingsProfilePanel .zcWppSettingsAlert strong,
      #zcWppSettingsProfilePanel .zcWppSettingsNotification strong,
      #zcWppSettingsProfilePanel .zcWppSettingsNotificationCard strong,
      #zcWppSettingsProfilePanel .zcWppSettingsNotify strong,
      #zcWppSettingsProfilePanel .zcWppSettingsNotifyBox strong,
      #zcWppSettingsProfilePanel .zcWppSettingsPermission strong,
      #zcWppSettingsProfilePanel .zcWppSettingsPermissionBox strong{
        color:var(--zc-settings-title) !important;
        font-weight:500 !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsNotice span,
      #zcWppSettingsProfilePanel .zcWppSettingsNotice p,
      #zcWppSettingsProfilePanel .zcWppSettingsBanner span,
      #zcWppSettingsProfilePanel .zcWppSettingsBanner p,
      #zcWppSettingsProfilePanel .zcWppSettingsAlert span,
      #zcWppSettingsProfilePanel .zcWppSettingsAlert p,
      #zcWppSettingsProfilePanel .zcWppSettingsNotification span,
      #zcWppSettingsProfilePanel .zcWppSettingsNotification p,
      #zcWppSettingsProfilePanel .zcWppSettingsNotificationCard span,
      #zcWppSettingsProfilePanel .zcWppSettingsNotificationCard p,
      #zcWppSettingsProfilePanel .zcWppSettingsNotify span,
      #zcWppSettingsProfilePanel .zcWppSettingsNotify p,
      #zcWppSettingsProfilePanel .zcWppSettingsNotifyBox span,
      #zcWppSettingsProfilePanel .zcWppSettingsNotifyBox p,
      #zcWppSettingsProfilePanel .zcWppSettingsPermission span,
      #zcWppSettingsProfilePanel .zcWppSettingsPermission p,
      #zcWppSettingsProfilePanel .zcWppSettingsPermissionBox span,
      #zcWppSettingsProfilePanel .zcWppSettingsPermissionBox p{
        color:var(--zc-settings-text) !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsNotice a,
      #zcWppSettingsProfilePanel .zcWppSettingsBanner a,
      #zcWppSettingsProfilePanel .zcWppSettingsAlert a,
      #zcWppSettingsProfilePanel .zcWppSettingsNotification a,
      #zcWppSettingsProfilePanel .zcWppSettingsNotificationCard a,
      #zcWppSettingsProfilePanel .zcWppSettingsNotify a,
      #zcWppSettingsProfilePanel .zcWppSettingsNotifyBox a,
      #zcWppSettingsProfilePanel .zcWppSettingsPermission a,
      #zcWppSettingsProfilePanel .zcWppSettingsPermissionBox a{
        color:var(--zc-settings-accent-2) !important;
        font-weight:500 !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsItem{
        color:var(--zc-settings-title) !important;
        background:transparent !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsItem:hover{
        background:var(--zc-settings-hover) !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsItem i,
      #zcWppSettingsProfilePanel .zcWppSettingsItemIcon,
      #zcWppSettingsProfilePanel .zcWppSettingsIcon{
        color:var(--zc-settings-muted) !important;
      }

      #zcWppSettingsProfilePanel .zcWppSettingsProfileName,
      #zcWppSettingsProfilePanel .zcWppSettingsNamePill,
      #zcWppSettingsProfilePanel .zcWppSettingsProfilePill{
        background:var(--zc-settings-input) !important;
        color:var(--zc-settings-title) !important;
        border:1px solid var(--zc-settings-border) !important;
        box-shadow:none !important;
        font-weight:500 !important;
      }

      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsProfileName,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsProfileName,
      html.light #zcWppSettingsProfilePanel .zcWppSettingsProfileName,
      html.theme-light #zcWppSettingsProfilePanel .zcWppSettingsProfileName,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsProfileName,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsProfileName,
      body.light-mode #zcWppSettingsProfilePanel .zcWppSettingsProfileName,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsProfileName,
      body[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsProfileName,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsNamePill,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsNamePill,
      html.light #zcWppSettingsProfilePanel .zcWppSettingsNamePill,
      html.theme-light #zcWppSettingsProfilePanel .zcWppSettingsNamePill,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsNamePill,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsNamePill,
      body.light-mode #zcWppSettingsProfilePanel .zcWppSettingsNamePill,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsNamePill,
      body[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsNamePill{
        background:#f6f7f8 !important;
        color:#111b21 !important;
        border-color:rgba(17,27,33,.085) !important;
      }

      html[data-theme="light"] #zcWppSettingsProfilePanel,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel,
      html.light #zcWppSettingsProfilePanel,
      html.light #zcWppSettingsProfilePanel .zcWppSettingsPanel,
      html.theme-light #zcWppSettingsProfilePanel,
      html.theme-light #zcWppSettingsProfilePanel .zcWppSettingsPanel,
      body.light #zcWppSettingsProfilePanel,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsPanel,
      body.theme-light #zcWppSettingsProfilePanel,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsPanel,
      body.light-mode #zcWppSettingsProfilePanel,
      body.light-mode #zcWppSettingsProfilePanel .zcWppSettingsPanel,
      body[data-theme="light"] #zcWppSettingsProfilePanel,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel,
      body[data-bs-theme="light"] #zcWppSettingsProfilePanel,
      body[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel{
        background:#ffffff !important;
        color:#111b21 !important;
      }

      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel h1,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel h2,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel h3,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel strong,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel b,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsTitle,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsHeaderTitle,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsName,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsProfileTitle,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsItem strong,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel h1,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel h2,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel h3,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel strong,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel b,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsTitle,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsHeaderTitle,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsName,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsProfileTitle,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsItem strong,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsPanel h1,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsPanel h2,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsPanel h3,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsPanel strong,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsPanel b,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsTitle,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsHeaderTitle,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsName,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsProfileTitle,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsItem strong,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsPanel h1,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsPanel h2,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsPanel h3,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsPanel strong,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsPanel b,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsTitle,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsHeaderTitle,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsName,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsProfileTitle,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsItem strong,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel h1,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel h2,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel h3,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel strong,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel b,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsTitle,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsHeaderTitle,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsName,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsProfileTitle,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsItem strong{
        color:#111b21 !important;
      }

      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel p,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel small,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel span,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSubtitle,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsHeaderSub,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsProfileSub,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsItem span,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsItem small,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel p,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel small,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel span,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSubtitle,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsHeaderSub,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsProfileSub,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsItem span,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsItem small,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsPanel p,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsPanel small,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsPanel span,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsSubtitle,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsHeaderSub,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsProfileSub,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsItem span,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsItem small,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsPanel p,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsPanel small,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsPanel span,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsSubtitle,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsHeaderSub,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsProfileSub,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsItem span,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsItem small,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel p,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel small,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsPanel span,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSubtitle,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsHeaderSub,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsProfileSub,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsItem span,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsItem small{
        color:#667781 !important;
      }

      html[data-theme="light"] #zcWppSettingsProfilePanel input,
      html[data-theme="light"] #zcWppSettingsProfilePanel input[type="text"],
      html[data-theme="light"] #zcWppSettingsProfilePanel input[type="search"],
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel input,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel input[type="text"],
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel input[type="search"],
      body.light #zcWppSettingsProfilePanel input,
      body.light #zcWppSettingsProfilePanel input[type="text"],
      body.light #zcWppSettingsProfilePanel input[type="search"],
      body.theme-light #zcWppSettingsProfilePanel input,
      body.theme-light #zcWppSettingsProfilePanel input[type="text"],
      body.theme-light #zcWppSettingsProfilePanel input[type="search"],
      body[data-theme="light"] #zcWppSettingsProfilePanel input,
      body[data-theme="light"] #zcWppSettingsProfilePanel input[type="text"],
      body[data-theme="light"] #zcWppSettingsProfilePanel input[type="search"]{
        background:#f6f7f8 !important;
        color:#111b21 !important;
        border-color:rgba(17,27,33,.085) !important;
      }

      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSearch,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSearchBox,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSearchWrap,
      html[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSearchBar,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSearch,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSearchBox,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSearchWrap,
      html[data-bs-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSearchBar,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsSearch,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsSearchBox,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsSearchWrap,
      body.light #zcWppSettingsProfilePanel .zcWppSettingsSearchBar,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsSearch,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsSearchBox,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsSearchWrap,
      body.theme-light #zcWppSettingsProfilePanel .zcWppSettingsSearchBar,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSearch,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSearchBox,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSearchWrap,
      body[data-theme="light"] #zcWppSettingsProfilePanel .zcWppSettingsSearchBar{
        background:#f6f7f8 !important;
        color:#111b21 !important;
        border-color:rgba(17,27,33,.085) !important;
      }

      /* ===============================================================
       * PÁGINAS INTERNAS
       * =============================================================== */

      .zc-settings-page{
        position:absolute;
        inset:0;
        z-index:80;
        background:var(--zc-settings-bg) !important;
        color:var(--zc-settings-title);
        display:flex;
        flex-direction:column;
        animation:zcSettingsPageIn .18s ease both;
        font-family:"Inter","Segoe UI",Arial,sans-serif;
        font-weight:400;
      }

      @keyframes zcSettingsPageIn{
        from{
          transform:translateX(18px);
          opacity:.92;
        }
        to{
          transform:translateX(0);
          opacity:1;
        }
      }

      .zc-settings-page-head{
        height:58px;
        min-height:58px;
        padding:0 14px;
        display:flex;
        align-items:center;
        gap:14px;
        background:var(--zc-settings-bg) !important;
        border-bottom:1px solid var(--zc-settings-border);
      }

      .zc-settings-page-back{
        width:34px;
        height:34px;
        border:0;
        border-radius:999px;
        background:transparent;
        color:var(--zc-settings-title);
        display:inline-flex;
        align-items:center;
        justify-content:center;
        cursor:pointer;
        font-size:17px;
      }

      .zc-settings-page-back:hover{
        background:var(--zc-settings-hover);
      }

      .zc-settings-page-title-wrap{
        min-width:0;
        display:flex;
        flex-direction:column;
        gap:2px;
      }

      .zc-settings-page-title{
        color:var(--zc-settings-title);
        font-size:16px;
        font-weight:500;
        line-height:1.15;
        letter-spacing:-.01em;
      }

      .zc-settings-page-subtitle{
        color:var(--zc-settings-muted);
        font-size:12px;
        font-weight:400;
        line-height:1.25;
      }

      .zc-settings-page-body{
        flex:1 1 auto;
        min-height:0;
        overflow:auto;
        background:var(--zc-settings-bg) !important;
        padding-bottom:20px;
      }

      .zc-settings-block{
        background:var(--zc-settings-surface) !important;
        border-bottom:1px solid var(--zc-settings-border);
        padding:18px 22px;
      }

      .zc-settings-block-title{
        margin:0 0 12px;
        color:var(--zc-settings-accent);
        font-size:13px;
        font-weight:500;
        line-height:1.25;
        letter-spacing:-.01em;
      }

      .zc-settings-desc{
        margin:0;
        color:var(--zc-settings-muted);
        font-size:13px;
        font-weight:400;
        line-height:1.45;
      }

      .zc-settings-list{
        background:var(--zc-settings-surface) !important;
        border-bottom:1px solid var(--zc-settings-border);
      }

      .zc-settings-row{
        width:100%;
        min-height:62px;
        border:0;
        background:transparent;
        color:var(--zc-settings-title);
        display:flex;
        align-items:center;
        gap:18px;
        padding:13px 22px;
        text-align:left;
        text-decoration:none;
        font:inherit;
        font-weight:400;
      }

      button.zc-settings-row{
        cursor:pointer;
      }

      button.zc-settings-row:hover{
        background:var(--zc-settings-hover);
      }

      .zc-settings-row-icon{
        width:24px;
        min-width:24px;
        color:var(--zc-settings-muted);
        display:flex;
        align-items:center;
        justify-content:center;
        font-size:17px;
      }

      .zc-settings-row-main{
        flex:1 1 auto;
        min-width:0;
        display:flex;
        flex-direction:column;
        gap:3px;
      }

      .zc-settings-row-main strong{
        color:var(--zc-settings-title);
        font-size:14px;
        font-weight:500;
        line-height:1.2;
        letter-spacing:-.01em;
      }

      .zc-settings-row-main span{
        color:var(--zc-settings-muted);
        font-size:12.5px;
        font-weight:400;
        line-height:1.35;
      }

      .zc-settings-row-side{
        color:var(--zc-settings-soft);
        font-size:12.5px;
        font-weight:400;
        white-space:nowrap;
      }

      .zc-settings-switch{
        width:42px;
        height:24px;
        border-radius:999px;
        background:#3b4a54;
        position:relative;
        flex:0 0 auto;
      }

      .zc-settings-switch::before{
        content:"";
        position:absolute;
        width:20px;
        height:20px;
        top:2px;
        left:2px;
        border-radius:999px;
        background:#8696a0;
        transition:.18s ease;
      }

      .zc-settings-switch.is-on{
        background:#005c4b;
      }

      .zc-settings-switch.is-on::before{
        left:20px;
        background:#00a884;
      }

      html[data-theme="light"] .zc-settings-switch,
      html[data-bs-theme="light"] .zc-settings-switch,
      html.light .zc-settings-switch,
      html.theme-light .zc-settings-switch,
      body.light .zc-settings-switch,
      body.theme-light .zc-settings-switch,
      body.light-mode .zc-settings-switch,
      body[data-theme="light"] .zc-settings-switch,
      body[data-bs-theme="light"] .zc-settings-switch{
        background:#d9e0e4;
      }

      html[data-theme="light"] .zc-settings-switch::before,
      html[data-bs-theme="light"] .zc-settings-switch::before,
      html.light .zc-settings-switch::before,
      html.theme-light .zc-settings-switch::before,
      body.light .zc-settings-switch::before,
      body.theme-light .zc-settings-switch::before,
      body.light-mode .zc-settings-switch::before,
      body[data-theme="light"] .zc-settings-switch::before,
      body[data-bs-theme="light"] .zc-settings-switch::before{
        background:#ffffff;
        box-shadow:0 1px 3px rgba(0,0,0,.18);
      }

      html[data-theme="light"] .zc-settings-switch.is-on,
      html[data-bs-theme="light"] .zc-settings-switch.is-on,
      html.light .zc-settings-switch.is-on,
      html.theme-light .zc-settings-switch.is-on,
      body.light .zc-settings-switch.is-on,
      body.theme-light .zc-settings-switch.is-on,
      body.light-mode .zc-settings-switch.is-on,
      body[data-theme="light"] .zc-settings-switch.is-on,
      body[data-bs-theme="light"] .zc-settings-switch.is-on{
        background:#d8f3ea;
      }

      html[data-theme="light"] .zc-settings-switch.is-on::before,
      html[data-bs-theme="light"] .zc-settings-switch.is-on::before,
      html.light .zc-settings-switch.is-on::before,
      html.theme-light .zc-settings-switch.is-on::before,
      body.light .zc-settings-switch.is-on::before,
      body.theme-light .zc-settings-switch.is-on::before,
      body.light-mode .zc-settings-switch.is-on::before,
      body[data-theme="light"] .zc-settings-switch.is-on::before,
      body[data-bs-theme="light"] .zc-settings-switch.is-on::before{
        background:#008069;
      }

      .zc-settings-shortcut{
        margin-left:auto;
        color:var(--zc-settings-muted);
        font-size:12px;
        font-weight:500;
        background:var(--zc-settings-shortcut-bg);
        border:1px solid var(--zc-settings-border);
        border-radius:6px;
        padding:4px 8px;
      }

      .zc-settings-toast{
        position:absolute;
        left:50%;
        bottom:18px;
        transform:translateX(-50%) translateY(10px);
        background:var(--zc-settings-toast-bg);
        color:var(--zc-settings-toast-text);
        border:1px solid var(--zc-settings-border);
        border-radius:999px;
        padding:9px 14px;
        font-size:13px;
        font-weight:400;
        opacity:0;
        pointer-events:none;
        transition:.16s ease;
        box-shadow:0 10px 28px rgba(0,0,0,.22);
        white-space:nowrap;
        z-index:120;
      }

      .zc-settings-toast.show{
        opacity:1;
        transform:translateX(-50%) translateY(0);
      }

      html[data-theme="light"] .zc-settings-page,
      html[data-theme="light"] .zc-settings-page-head,
      html[data-theme="light"] .zc-settings-page-body,
      html[data-theme="light"] .zc-settings-block,
      html[data-theme="light"] .zc-settings-list,
      html[data-bs-theme="light"] .zc-settings-page,
      html[data-bs-theme="light"] .zc-settings-page-head,
      html[data-bs-theme="light"] .zc-settings-page-body,
      html[data-bs-theme="light"] .zc-settings-block,
      html[data-bs-theme="light"] .zc-settings-list,
      html.light .zc-settings-page,
      html.light .zc-settings-page-head,
      html.light .zc-settings-page-body,
      html.light .zc-settings-block,
      html.light .zc-settings-list,
      html.theme-light .zc-settings-page,
      html.theme-light .zc-settings-page-head,
      html.theme-light .zc-settings-page-body,
      html.theme-light .zc-settings-block,
      html.theme-light .zc-settings-list,
      body.light .zc-settings-page,
      body.light .zc-settings-page-head,
      body.light .zc-settings-page-body,
      body.light .zc-settings-block,
      body.light .zc-settings-list,
      body.theme-light .zc-settings-page,
      body.theme-light .zc-settings-page-head,
      body.theme-light .zc-settings-page-body,
      body.theme-light .zc-settings-block,
      body.theme-light .zc-settings-list,
      body.light-mode .zc-settings-page,
      body.light-mode .zc-settings-page-head,
      body.light-mode .zc-settings-page-body,
      body.light-mode .zc-settings-block,
      body.light-mode .zc-settings-list,
      body[data-theme="light"] .zc-settings-page,
      body[data-theme="light"] .zc-settings-page-head,
      body[data-theme="light"] .zc-settings-page-body,
      body[data-theme="light"] .zc-settings-block,
      body[data-theme="light"] .zc-settings-list,
      body[data-bs-theme="light"] .zc-settings-page,
      body[data-bs-theme="light"] .zc-settings-page-head,
      body[data-bs-theme="light"] .zc-settings-page-body,
      body[data-bs-theme="light"] .zc-settings-block,
      body[data-bs-theme="light"] .zc-settings-list{
        background:#ffffff !important;
      }

      html[data-theme="dark"] .zc-settings-page,
      html[data-theme="dark"] .zc-settings-page-head,
      html[data-theme="dark"] .zc-settings-page-body,
      html[data-theme="dark"] .zc-settings-block,
      html[data-theme="dark"] .zc-settings-list,
      html[data-bs-theme="dark"] .zc-settings-page,
      html[data-bs-theme="dark"] .zc-settings-page-head,
      html[data-bs-theme="dark"] .zc-settings-page-body,
      html[data-bs-theme="dark"] .zc-settings-block,
      html[data-bs-theme="dark"] .zc-settings-list,
      html.dark .zc-settings-page,
      html.dark .zc-settings-page-head,
      html.dark .zc-settings-page-body,
      html.dark .zc-settings-block,
      html.dark .zc-settings-list,
      html.theme-dark .zc-settings-page,
      html.theme-dark .zc-settings-page-head,
      html.theme-dark .zc-settings-page-body,
      html.theme-dark .zc-settings-block,
      html.theme-dark .zc-settings-list,
      body.dark .zc-settings-page,
      body.dark .zc-settings-page-head,
      body.dark .zc-settings-page-body,
      body.dark .zc-settings-block,
      body.dark .zc-settings-list,
      body.theme-dark .zc-settings-page,
      body.theme-dark .zc-settings-page-head,
      body.theme-dark .zc-settings-page-body,
      body.theme-dark .zc-settings-block,
      body.theme-dark .zc-settings-list,
      body.dark-mode .zc-settings-page,
      body.dark-mode .zc-settings-page-head,
      body.dark-mode .zc-settings-page-body,
      body.dark-mode .zc-settings-block,
      body.dark-mode .zc-settings-list,
      body[data-theme="dark"] .zc-settings-page,
      body[data-theme="dark"] .zc-settings-page-head,
      body[data-theme="dark"] .zc-settings-page-body,
      body[data-theme="dark"] .zc-settings-block,
      body[data-theme="dark"] .zc-settings-list,
      body[data-bs-theme="dark"] .zc-settings-page,
      body[data-bs-theme="dark"] .zc-settings-page-head,
      body[data-bs-theme="dark"] .zc-settings-page-body,
      body[data-bs-theme="dark"] .zc-settings-block,
      body[data-bs-theme="dark"] .zc-settings-list{
        background:#161717 !important;
      }

      html[data-theme="light"] .zc-settings-page-title,
      html[data-theme="light"] .zc-settings-row-main strong,
      html[data-theme="light"] .zc-settings-page-back,
      html[data-bs-theme="light"] .zc-settings-page-title,
      html[data-bs-theme="light"] .zc-settings-row-main strong,
      html[data-bs-theme="light"] .zc-settings-page-back,
      html.light .zc-settings-page-title,
      html.light .zc-settings-row-main strong,
      html.light .zc-settings-page-back,
      html.theme-light .zc-settings-page-title,
      html.theme-light .zc-settings-row-main strong,
      html.theme-light .zc-settings-page-back,
      body.light .zc-settings-page-title,
      body.light .zc-settings-row-main strong,
      body.light .zc-settings-page-back,
      body.theme-light .zc-settings-page-title,
      body.theme-light .zc-settings-row-main strong,
      body.theme-light .zc-settings-page-back,
      body.light-mode .zc-settings-page-title,
      body.light-mode .zc-settings-row-main strong,
      body.light-mode .zc-settings-page-back,
      body[data-theme="light"] .zc-settings-page-title,
      body[data-theme="light"] .zc-settings-row-main strong,
      body[data-theme="light"] .zc-settings-page-back,
      body[data-bs-theme="light"] .zc-settings-page-title,
      body[data-bs-theme="light"] .zc-settings-row-main strong,
      body[data-bs-theme="light"] .zc-settings-page-back{
        color:#111b21 !important;
      }

      html[data-theme="light"] .zc-settings-page-subtitle,
      html[data-theme="light"] .zc-settings-row-main span,
      html[data-theme="light"] .zc-settings-row-icon,
      html[data-theme="light"] .zc-settings-desc,
      html[data-theme="light"] .zc-settings-row-side,
      html[data-bs-theme="light"] .zc-settings-page-subtitle,
      html[data-bs-theme="light"] .zc-settings-row-main span,
      html[data-bs-theme="light"] .zc-settings-row-icon,
      html[data-bs-theme="light"] .zc-settings-desc,
      html[data-bs-theme="light"] .zc-settings-row-side,
      html.light .zc-settings-page-subtitle,
      html.light .zc-settings-row-main span,
      html.light .zc-settings-row-icon,
      html.light .zc-settings-desc,
      html.light .zc-settings-row-side,
      html.theme-light .zc-settings-page-subtitle,
      html.theme-light .zc-settings-row-main span,
      html.theme-light .zc-settings-row-icon,
      html.theme-light .zc-settings-desc,
      html.theme-light .zc-settings-row-side,
      body.light .zc-settings-page-subtitle,
      body.light .zc-settings-row-main span,
      body.light .zc-settings-row-icon,
      body.light .zc-settings-desc,
      body.light .zc-settings-row-side,
      body.theme-light .zc-settings-page-subtitle,
      body.theme-light .zc-settings-row-main span,
      body.theme-light .zc-settings-row-icon,
      body.theme-light .zc-settings-desc,
      body.theme-light .zc-settings-row-side,
      body.light-mode .zc-settings-page-subtitle,
      body.light-mode .zc-settings-row-main span,
      body.light-mode .zc-settings-row-icon,
      body.light-mode .zc-settings-desc,
      body.light-mode .zc-settings-row-side,
      body[data-theme="light"] .zc-settings-page-subtitle,
      body[data-theme="light"] .zc-settings-row-main span,
      body[data-theme="light"] .zc-settings-row-icon,
      body[data-theme="light"] .zc-settings-desc,
      body[data-theme="light"] .zc-settings-row-side,
      body[data-bs-theme="light"] .zc-settings-page-subtitle,
      body[data-bs-theme="light"] .zc-settings-row-main span,
      body[data-bs-theme="light"] .zc-settings-row-icon,
      body[data-bs-theme="light"] .zc-settings-desc,
      body[data-bs-theme="light"] .zc-settings-row-side{
        color:#667781 !important;
      }
    `;
  }

  function findMainPanel() {
    return qs('#zcWppSettingsProfilePanel .zcWppSettingsPanel');
  }

  function getClickedTitle(btn) {
    const strong = qs('strong', btn);
    return normalize(strong ? strong.textContent : btn.textContent);
  }

  function closePage() {
    const old = qs('.zc-settings-page');
    if (old) old.remove();
  }

  function showToast(message) {
    const panel = findMainPanel();
    if (!panel) return;

    let toast = qs('.zc-settings-toast', panel);

    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'zc-settings-toast';
      panel.appendChild(toast);
    }

    toast.textContent = message || 'Pronto';
    toast.classList.add('show');

    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.classList.remove('show');
    }, 1500);
  }

  async function copyText(text) {
    const value = clean(text);
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      showToast('Copiado');
      return;
    } catch {}

    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('Copiado');
    } catch {
      showToast('Não foi possível copiar');
    }
  }

  function row({ icon, title, desc, side, action, switchOn, shortcut }) {
    const tag = action ? 'button' : 'div';
    const actionAttr = action ? ` data-action="${escapeHtml(action)}"` : '';

    let sideHtml = '';

    if (shortcut) {
      sideHtml = `<span class="zc-settings-shortcut">${escapeHtml(shortcut)}</span>`;
    } else if (typeof switchOn === 'boolean') {
      sideHtml = `<span class="zc-settings-switch ${switchOn ? 'is-on' : ''}" aria-hidden="true"></span>`;
    } else if (side) {
      sideHtml = `<span class="zc-settings-row-side">${escapeHtml(side)}</span>`;
    }

    return `
      <${tag} ${tag === 'button' ? 'type="button"' : ''} class="zc-settings-row"${actionAttr}>
        <span class="zc-settings-row-icon">
          <i class="${escapeHtml(icon || 'fa-regular fa-circle')}"></i>
        </span>

        <span class="zc-settings-row-main">
          <strong>${escapeHtml(title || '')}</strong>
          ${desc ? `<span>${escapeHtml(desc)}</span>` : ''}
        </span>

        ${sideHtml}
      </${tag}>
    `;
  }

  function block(title, html) {
    return `
      <section class="zc-settings-block">
        ${title ? `<p class="zc-settings-block-title">${escapeHtml(title)}</p>` : ''}
        ${html || ''}
      </section>
    `;
  }

  function list(html) {
    return `<div class="zc-settings-list">${html || ''}</div>`;
  }

  function openPage(config) {
    const panel = findMainPanel();

    if (!panel || !config) return;

    ensureStyle();
    closePage();

    const page = document.createElement('section');
    page.className = 'zc-settings-page';

    page.innerHTML = `
      <header class="zc-settings-page-head">
        <button type="button" class="zc-settings-page-back" aria-label="Voltar">
          <i class="fa-solid fa-arrow-left"></i>
        </button>

        <div class="zc-settings-page-title-wrap">
          <div class="zc-settings-page-title">${escapeHtml(config.title || 'Configurações')}</div>
          ${config.subtitle ? `<div class="zc-settings-page-subtitle">${escapeHtml(config.subtitle)}</div>` : ''}
        </div>
      </header>

      <div class="zc-settings-page-body">
        ${typeof config.render === 'function' ? config.render(api) : ''}
      </div>
    `;

    panel.appendChild(page);

    qs('.zc-settings-page-back', page)?.addEventListener('click', closePage);

    if (typeof config.onOpen === 'function') {
      config.onOpen(page, api);
    }
  }

  function register(config) {
    if (!config || !config.match) return;
    REGISTRY.push(config);
  }

  function handleClick(event) {
    const panel = qs('#zcWppSettingsProfilePanel');
    if (!panel || !panel.classList.contains('is-open')) return;

    const btn = event.target.closest('.zcWppSettingsItem');
    if (!btn || !panel.contains(btn)) return;

    const title = getClickedTitle(btn);

    const config = REGISTRY.find((item) => {
      const matches = Array.isArray(item.match) ? item.match : [item.match];
      return matches.some((m) => normalize(m) === title);
    });

    if (!config) return;

    event.preventDefault();
    event.stopPropagation();

    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }

    openPage(config);
  }

  const api = {
    register,
    openPage,
    closePage,
    showToast,
    copyText,
    row,
    block,
    list,
    escapeHtml,
    clean,
    normalize,
    qs,
    qsa
  };

  window.ZCSettingsPage = api;

  ready(() => {
    ensureStyle();
    document.addEventListener('click', handleClick, true);
    window.dispatchEvent(new CustomEvent('zc:settings-page-helper-ready'));
  });
})();