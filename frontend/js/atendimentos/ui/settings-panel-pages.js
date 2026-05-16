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
 * Objetivo:
 * - O sidebar NÃO monta telas fake com setDetail().
 * - O sidebar só chama páginas registradas com H.register(...).
 * - As páginas abrem IGUAL WhatsApp Web:
 *   dentro do próprio painel esquerdo de Configurações,
 *   substituindo a lista, com botão Voltar.
 *
 * Correção desta versão:
 * - Ícones internos NÃO dependem mais do FontAwesome.
 * - H.row({ icon:'fa-solid ...' }) converte para SVG inline.
 * - Fundo ajustado:
 *   dark  -> #161717
 *   light -> #FFFFFF
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

  function svg(path, extra) {
    return `
      <svg class="zc-settings-svg-icon ${extra || ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        ${path}
      </svg>
    `;
  }

  function iconSvg(iconName) {
    const n = normalize(iconName || '');

    if (n.includes('arrow-left')) {
      return svg('<path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.42-1.41L7.83 13H20v-2Z"></path>');
    }

    if (n.includes('shield')) {
      return svg('<path d="M12 2 4 5.5V11c0 5.05 3.41 9.76 8 11 4.59-1.24 8-5.95 8-11V5.5L12 2Zm0 2.18 6 2.62V11c0 3.95-2.51 7.68-6 8.9-3.49-1.22-6-4.95-6-8.9V6.8l6-2.62Zm3.54 5.28L11 14l-2.04-2.04-1.42 1.42L11 16.83l5.96-5.96-1.42-1.41Z"></path>');
    }

    if (n.includes('key')) {
      return svg('<path d="M7.5 14A5.5 5.5 0 1 1 12.76 7H22v4h-3v3h-4v2.24A5.48 5.48 0 0 1 7.5 14Zm0-9A3.5 3.5 0 1 0 11 8.5V7h3v5h3V9h3V7h-8.76A3.5 3.5 0 0 0 7.5 5Zm0 2A1.5 1.5 0 1 1 6 8.5 1.5 1.5 0 0 1 7.5 7Z"></path>');
    }

    if (n.includes('id-card')) {
      return svg('<path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm0 2v10h16V7H4Zm3 2.5A2.5 2.5 0 1 1 9.5 12 2.5 2.5 0 0 1 7 9.5ZM5.5 16a4 4 0 0 1 8 0h-8ZM14 10h4V8h-4v2Zm0 4h5v-2h-5v2Z"></path>');
    }

    if (n.includes('download')) {
      return svg('<path d="M11 3h2v9.17l3.59-3.58L18 10l-6 6-6-6 1.41-1.41L11 12.17V3Zm-7 14h2v2h12v-2h2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2Z"></path>');
    }

    if (n.includes('right-from-bracket') || n.includes('logout')) {
      return svg('<path d="M4 3h8a2 2 0 0 1 2 2v3h-2V5H4v14h8v-3h2v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm12.59 5.59L21 13l-4.41 4.41L15.17 16l2-2H8v-2h9.17l-2-2 1.42-1.41Z"></path>');
    }

    if (n.includes('clock')) {
      return svg('<path d="M12 2a10 10 0 1 1-10 10A10.01 10.01 0 0 1 12 2Zm0 2a8 8 0 1 0 8 8 8.01 8.01 0 0 0-8-8Zm1 3v4.59l3.2 3.2-1.4 1.42L11 12.41V7h2Z"></path>');
    }

    if (n.includes('image')) {
      return svg('<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v12h16V6H4Zm3 3.5A1.5 1.5 0 1 1 8.5 11 1.5 1.5 0 0 1 7 9.5ZM5 17l4.5-5 3.2 3.56L15 13l4 4H5Z"></path>');
    }

    if (n.includes('message') || n.includes('comment')) {
      return svg('<path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v10h2v1.17L7.17 16H20V6H4Zm3 3h10v2H7V9Zm0 4h7v2H7v-2Z"></path>');
    }

    if (n.includes('users')) {
      return svg('<path d="M9 11a4 4 0 1 1 4-4 4 4 0 0 1-4 4Zm0-6a2 2 0 1 0 2 2 2 2 0 0 0-2-2Zm0 8c-3.31 0-6 2.02-6 4.5V19h12v-1.5C15 15.02 12.31 13 9 13Zm-3.6 4c.52-1.06 1.95-2 3.6-2s3.08.94 3.6 2H5.4ZM17 11a3 3 0 1 1 3-3 3 3 0 0 1-3 3Zm0 2c2.76 0 5 1.79 5 4v2h-5v-2h2.8c-.45-1.12-1.6-2-2.8-2v-2Z"></path>');
    }

    if (n.includes('ban')) {
      return svg('<path d="M12 2a10 10 0 1 1-10 10A10.01 10.01 0 0 1 12 2Zm0 2a8 8 0 0 0-6.32 12.9L16.9 5.68A7.96 7.96 0 0 0 12 4Zm0 16a8 8 0 0 0 6.32-12.9L7.1 18.32A7.96 7.96 0 0 0 12 20Z"></path>');
    }

    if (n.includes('hourglass')) {
      return svg('<path d="M6 2h12v6a5.99 5.99 0 0 1-3 5.2A5.99 5.99 0 0 1 18 18v4H6v-4a5.99 5.99 0 0 1 3-5.2A5.99 5.99 0 0 1 6 8V2Zm2 2v4a4 4 0 0 0 8 0V4H8Zm4 10a4 4 0 0 0-4 4v2h8v-2a4 4 0 0 0-4-4Z"></path>');
    }

    if (n.includes('bell')) {
      return svg('<path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm8-6h-1V10a7 7 0 0 0-5-6.71V2h-4v1.29A7 7 0 0 0 5 10v6H4v2h16v-2Zm-3 0H7v-6a5 5 0 0 1 10 0v6Z"></path>');
    }

    if (n.includes('volume')) {
      return svg('<path d="M4 9v6h4l5 4V5L8 9H4Zm7 .17v5.66L8.7 13H6v-2h2.7L11 9.17Zm5.5-1.67-1.42 1.42A4.99 4.99 0 0 1 16.5 12a4.99 4.99 0 0 1-1.42 3.08l1.42 1.42A7 7 0 0 0 18.5 12a7 7 0 0 0-2-4.5Zm2.83-2.83-1.42 1.42A9 9 0 0 1 20.5 12a9 9 0 0 1-2.59 5.91l1.42 1.42A11 11 0 0 0 22.5 12a11 11 0 0 0-3.17-7.33Z"></path>');
    }

    if (n.includes('at')) {
      return svg('<path d="M12 2a10 10 0 0 0 0 20h5v-2h-5a8 8 0 1 1 8-8v1.5a1.5 1.5 0 0 1-3 0V7h-2v.9A4.5 4.5 0 1 0 15 15a3.5 3.5 0 0 0 7-1.5V12A10 10 0 0 0 12 2Zm0 12.5A2.5 2.5 0 1 1 14.5 12 2.5 2.5 0 0 1 12 14.5Z"></path>');
    }

    if (n.includes('magnifying')) {
      return svg('<path d="M10 3a7 7 0 0 1 5.6 11.2l4.1 4.1-1.4 1.4-4.1-4.1A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 5 5 5 5 0 0 0-5-5Z"></path>');
    }

    if (n.includes('plus')) {
      return svg('<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"></path>');
    }

    if (n.includes('paper-plane')) {
      return svg('<path d="M21.5 3.5 2.5 11l7.1 3.4 3.4 7.1 8.5-18ZM6.9 11.2l9.8-3.9-6.4 6.4-3.4-2.5Zm5.9 5.9-1.5-2 6.4-6.4-3.9 9.8-1-1.4Z"></path>');
    }

    if (n.includes('arrow-turn-down')) {
      return svg('<path d="M5 5h9a5 5 0 0 1 5 5v4h2l-4 5-4-5h2v-4a1 1 0 0 0-1-1H5V5Z"></path>');
    }

    if (n.includes('xmark')) {
      return svg('<path d="M18.3 5.71 12 12l6.3 6.29-1.42 1.42L10.59 13.4 4.29 19.7 2.87 18.3 9.17 12l-6.3-6.29L4.29 4.3l6.3 6.3 6.29-6.3 1.42 1.41Z"></path>');
    }

    if (n.includes('paperclip')) {
      return svg('<path d="M17.5 6.5 8.4 15.6a3 3 0 0 0 4.24 4.24l8.49-8.49a5 5 0 0 0-7.08-7.07L5.56 12.76a7 7 0 0 0 9.9 9.9l7.78-7.78-1.42-1.41-7.78 7.77a5 5 0 1 1-7.07-7.07l8.49-8.49a3 3 0 0 1 4.24 4.25l-8.49 8.48a1 1 0 1 1-1.41-1.41l9.1-9.1-1.4-1.4Z"></path>');
    }

    if (n.includes('flag')) {
      return svg('<path d="M5 3h13l-1.5 4L18 11H7v10H5V3Zm2 2v4h8.1l-.7-2 .7-2H7Z"></path>');
    }

    if (n.includes('circle-question') || n.includes('question')) {
      return svg('<path d="M12 2a10 10 0 1 1-10 10A10.01 10.01 0 0 1 12 2Zm0 2a8 8 0 1 0 8 8 8.01 8.01 0 0 0-8-8Zm0 12.75a1.25 1.25 0 1 0 1.25 1.25A1.25 1.25 0 0 0 12 16.75ZM12 6.5a3.5 3.5 0 0 0-3.5 3.5h2a1.5 1.5 0 1 1 2.54 1.08l-.94.9A3.4 3.4 0 0 0 11 14.5v.5h2v-.5a1.45 1.45 0 0 1 .45-1.05l.94-.9A3.5 3.5 0 0 0 12 6.5Z"></path>');
    }

    if (n.includes('circle-info') || n.includes('info')) {
      return svg('<path d="M11 10h2v8h-2v-8Zm0-4h2v2h-2V6Zm1-4a10 10 0 1 1-10 10A10.01 10.01 0 0 1 12 2Zm0 2a8 8 0 1 0 8 8 8.01 8.01 0 0 0-8-8Z"></path>');
    }

    if (n.includes('phone')) {
      return svg('<path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24 11.36 11.36 0 0 0 3.58.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.58 1 1 0 0 1-.24 1.01l-2.21 2.2Z"></path>');
    }

    if (n.includes('mobile')) {
      return svg('<path d="M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm0 2v16h8V4H8Zm3 13h2v2h-2v-2Z"></path>');
    }

    if (n.includes('database')) {
      return svg('<path d="M12 3c4.42 0 8 1.57 8 3.5v11c0 1.93-3.58 3.5-8 3.5s-8-1.57-8-3.5v-11C4 4.57 7.58 3 12 3Zm0 2c-3.31 0-5.5.9-5.93 1.5C6.5 7.1 8.69 8 12 8s5.5-.9 5.93-1.5C17.5 5.9 15.31 5 12 5ZM6 9v2.5C6.43 12.1 8.64 13 12 13s5.57-.9 6-1.5V9c-1.43.64-3.55 1-6 1s-4.57-.36-6-1Zm0 5v3.5c.43.6 2.64 1.5 6 1.5s5.57-.9 6-1.5V14c-1.43.64-3.55 1-6 1s-4.57-.36-6-1Z"></path>');
    }

    if (n.includes('briefcase')) {
      return svg('<path d="M9 4h6a2 2 0 0 1 2 2v2h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h3V6a2 2 0 0 1 2-2Zm0 4h6V6H9v2Zm-5 2v8h16v-8H4Zm6 3h4v2h-4v-2Z"></path>');
    }

    if (n.includes('triangle-exclamation')) {
      return svg('<path d="M12 3 1.8 21h20.4L12 3Zm0 4.04L18.77 19H5.23L12 7.04ZM11 10h2v5h-2v-5Zm0 6h2v2h-2v-2Z"></path>');
    }

    if (n.includes('rotate')) {
      return svg('<path d="M17.65 6.35A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h8V3l-3.35 3.35Z"></path>');
    }

    if (n.includes('whatsapp')) {
      return svg('<path d="M12.04 2A9.9 9.9 0 0 0 2.1 11.89a9.78 9.78 0 0 0 1.33 4.93L2 22l5.32-1.39a9.97 9.97 0 0 0 4.72 1.2h.01A9.9 9.9 0 0 0 22 11.93 9.95 9.95 0 0 0 12.04 2Zm0 17.8a7.92 7.92 0 0 1-4.04-1.1l-.29-.17-3.16.83.84-3.08-.19-.31a7.8 7.8 0 1 1 6.84 3.83Zm4.35-5.93c-.24-.12-1.42-.7-1.64-.78-.22-.08-.38-.12-.54.12-.16.24-.62.78-.76.94-.14.16-.28.18-.52.06-.24-.12-1.01-.37-1.93-1.18-.71-.63-1.2-1.42-1.34-1.66-.14-.24-.01-.37.11-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.54-1.3-.74-1.78-.19-.46-.39-.4-.54-.41h-.46c-.16 0-.42.06-.64.3-.22.24-.84.82-.84 2s.86 2.32.98 2.48c.12.16 1.69 2.58 4.1 3.62.57.25 1.02.4 1.37.51.58.18 1.1.16 1.52.1.46-.07 1.42-.58 1.62-1.14.2-.56.2-1.04.14-1.14-.06-.1-.22-.16-.46-.28Z"></path>');
    }

    if (n.includes('circle')) {
      return svg('<circle cx="12" cy="12" r="6"></circle>');
    }

    return svg('<path d="M12 2a10 10 0 1 1-10 10A10.01 10.01 0 0 1 12 2Zm0 2a8 8 0 1 0 8 8 8.01 8.01 0 0 0-8-8Z"></path>');
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
        --zc-settings-bg:#161717;
        --zc-settings-panel-bg:#161717;
        --zc-settings-surface:#161717;
        --zc-settings-surface-2:#161717;
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
        --zc-settings-surface-2:#161717;
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

      #zcWaSettingsOverlay .zc-wa-settings-panel,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel{
        position:relative !important;
        overflow:hidden !important;
      }

      #zcWaSettingsOverlay.zc-settings-page-open .zc-wa-settings-panel{
        display:flex !important;
      }

      @media (max-width:920px){
        #zcWaSettingsOverlay.zc-settings-page-open .zc-wa-settings-panel{
          display:flex !important;
          width:100vw !important;
          min-width:100vw !important;
          max-width:100vw !important;
          height:100vh !important;
          min-height:100vh !important;
        }

        #zcWaSettingsOverlay.zc-settings-page-open .zc-wa-settings-content{
          display:none !important;
        }
      }

      .zc-settings-page{
        position:absolute;
        inset:0;
        z-index:500;
        display:flex;
        flex-direction:column;
        width:100%;
        height:100%;
        min-height:0;
        background:var(--zc-settings-bg);
        color:var(--zc-settings-title);
        overflow:hidden;
        font-family:Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      }

      .zc-settings-page *,
      .zc-settings-page *::before,
      .zc-settings-page *::after{
        box-sizing:border-box;
      }

      .zc-settings-page-head{
        height:58px;
        min-height:58px;
        display:flex;
        align-items:center;
        gap:14px;
        padding:0 18px;
        border-bottom:1px solid var(--zc-settings-border);
        background:var(--zc-settings-panel-bg);
      }

      .zc-settings-page-back{
        width:36px;
        height:36px;
        min-width:36px;
        border:0;
        border-radius:999px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        background:transparent;
        color:var(--zc-settings-title);
        cursor:pointer;
        transition:background .15s ease, color .15s ease;
      }

      .zc-settings-page-back:hover{
        background:var(--zc-settings-hover);
      }

      .zc-settings-page-back svg{
        width:21px;
        height:21px;
        display:block;
        fill:currentColor;
      }

      .zc-settings-page-title-wrap{
        min-width:0;
        display:flex;
        flex-direction:column;
        gap:2px;
      }

      .zc-settings-page-title{
        color:var(--zc-settings-title);
        font-size:19px;
        font-weight:650;
        line-height:1.15;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }

      .zc-settings-page-subtitle{
        color:var(--zc-settings-muted);
        font-size:12px;
        font-weight:400;
        line-height:1.2;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }

      .zc-settings-page-body{
        flex:1 1 auto;
        min-height:0;
        overflow-y:auto;
        overflow-x:hidden;
        padding:18px 20px 28px;
        background:var(--zc-settings-bg);
        scrollbar-width:thin;
        scrollbar-color:rgba(134,150,160,.35) transparent;
      }

      .zc-settings-page-body::-webkit-scrollbar{
        width:8px;
      }

      .zc-settings-page-body::-webkit-scrollbar-track{
        background:transparent;
      }

      .zc-settings-page-body::-webkit-scrollbar-thumb{
        background:rgba(134,150,160,.35);
        border-radius:999px;
      }

      .zc-settings-block{
        margin:0 0 18px;
      }

      .zc-settings-block-title{
        margin:0 0 8px;
        color:var(--zc-settings-muted);
        font-size:12px;
        font-weight:500;
        line-height:1.3;
      }

      .zc-settings-desc{
        margin:0;
        color:var(--zc-settings-muted);
        font-size:13px;
        font-weight:400;
        line-height:1.45;
      }

      .zc-settings-list{
        display:flex;
        flex-direction:column;
        border-top:1px solid var(--zc-settings-border);
      }

      .zc-settings-row{
        width:100%;
        min-height:62px;
        display:flex;
        align-items:center;
        gap:14px;
        padding:12px 0;
        border:0;
        border-bottom:1px solid var(--zc-settings-border);
        background:transparent;
        color:var(--zc-settings-title);
        text-align:left;
        text-decoration:none;
        font-family:inherit;
      }

      button.zc-settings-row{
        cursor:pointer;
      }

      button.zc-settings-row:hover{
        background:var(--zc-settings-hover);
      }

      .zc-settings-row-icon{
        width:34px;
        min-width:34px;
        height:34px;
        display:flex;
        align-items:center;
        justify-content:center;
        color:var(--zc-settings-muted);
      }

      .zc-settings-svg-icon{
        width:21px;
        height:21px;
        display:block;
        fill:currentColor;
        color:currentColor;
        flex:0 0 auto;
      }

      .zc-settings-row-main{
        min-width:0;
        flex:1 1 auto;
        display:flex;
        flex-direction:column;
        gap:3px;
      }

      .zc-settings-row-main strong{
        display:block;
        color:var(--zc-settings-title);
        font-size:14px;
        font-weight:500;
        line-height:1.25;
      }

      .zc-settings-row-main span{
        display:block;
        color:var(--zc-settings-muted);
        font-size:12px;
        font-weight:400;
        line-height:1.35;
      }

      .zc-settings-row-side{
        color:var(--zc-settings-muted);
        font-size:12px;
        white-space:nowrap;
      }

      .zc-settings-shortcut{
        min-width:0;
        padding:5px 8px;
        border-radius:8px;
        background:var(--zc-settings-shortcut-bg);
        color:var(--zc-settings-muted);
        font-size:11px;
        font-weight:500;
        white-space:nowrap;
      }

      .zc-settings-switch{
        width:40px;
        height:22px;
        min-width:40px;
        border-radius:999px;
        background:rgba(134,150,160,.28);
        position:relative;
        transition:background .15s ease;
      }

      .zc-settings-switch::after{
        content:"";
        position:absolute;
        top:3px;
        left:3px;
        width:16px;
        height:16px;
        border-radius:999px;
        background:#fff;
        box-shadow:0 1px 2px rgba(0,0,0,.25);
        transition:transform .15s ease;
      }

      .zc-settings-switch.is-on{
        background:var(--zc-settings-accent);
      }

      .zc-settings-switch.is-on::after{
        transform:translateX(18px);
      }

      .zc-settings-toast{
        position:absolute;
        left:50%;
        bottom:22px;
        z-index:800;
        max-width:calc(100% - 40px);
        transform:translateX(-50%) translateY(12px);
        opacity:0;
        pointer-events:none;
        padding:10px 14px;
        border-radius:999px;
        background:var(--zc-settings-toast-bg);
        color:var(--zc-settings-toast-text);
        border:1px solid var(--zc-settings-border);
        box-shadow:0 10px 26px rgba(0,0,0,.22);
        font-size:13px;
        font-weight:500;
        white-space:nowrap;
        transition:opacity .18s ease, transform .18s ease;
      }

      .zc-settings-toast.show{
        opacity:1;
        transform:translateX(-50%) translateY(0);
      }

      @media (max-width:920px){
        .zc-settings-page{
          position:absolute;
          inset:0;
          min-height:100vh;
          height:100vh;
        }

        .zc-settings-page-head{
          height:58px;
          min-height:58px;
          padding:0 14px;
        }

        .zc-settings-page-body{
          padding:16px 16px 26px;
        }
      }
    `;
  }

  function findOverlay() {
    return qs('#zcWaSettingsOverlay') || qs('#zcWppSettingsProfilePanel');
  }

  function isOverlayOpen(overlay) {
    if (!overlay) return false;

    return (
      overlay.classList.contains('is-open') ||
      overlay.classList.contains('show') ||
      overlay.getAttribute('aria-hidden') === 'false'
    );
  }

  function findPageHost() {
    const newPanel = qs('#zcWaSettingsOverlay .zc-wa-settings-panel');

    if (newPanel) {
      newPanel.style.position = 'relative';
      newPanel.style.overflow = 'hidden';
      return newPanel;
    }

    const oldPanel = qs('#zcWppSettingsProfilePanel .zcWppSettingsPanel');

    if (oldPanel) {
      oldPanel.style.position = 'relative';
      oldPanel.style.overflow = 'hidden';
      return oldPanel;
    }

    const fallback = qs('#zcWaSettingsOverlay .zc-wa-settings-content');

    if (fallback) {
      fallback.style.position = 'relative';
      fallback.style.overflow = 'hidden';
    }

    return fallback;
  }

  function getClickedTitle(btn) {
    if (!btn) return '';

    const strong = qs('strong', btn);
    const title =
      btn.getAttribute('data-title') ||
      btn.getAttribute('aria-label') ||
      btn.getAttribute('title') ||
      (strong ? strong.textContent : '') ||
      btn.textContent ||
      '';

    return normalize(title);
  }

  function getConfigMatches(config) {
    if (!config) return [];

    const matches = Array.isArray(config.match) ? config.match : [config.match];

    return matches
      .concat(config.title || '')
      .map(normalize)
      .filter(Boolean);
  }

  function findConfigByTitle(title) {
    const normalizedTitle = normalize(title);

    if (!normalizedTitle) return null;

    return REGISTRY.find((config) => {
      const matches = getConfigMatches(config);
      return matches.some((m) => m === normalizedTitle);
    }) || null;
  }

  function setSettingsPageOpen(open) {
    const overlay = qs('#zcWaSettingsOverlay') || qs('#zcWppSettingsProfilePanel');

    if (overlay) {
      overlay.classList.toggle('zc-settings-page-open', !!open);
    }
  }

  function setMenuActiveByTitle(title) {
    const overlay = findOverlay();
    if (!overlay) return;

    const normalizedTitle = normalize(title);

    qsa('[data-zc-settings-tab]', overlay).forEach((item) => {
      const itemTitle = getClickedTitle(item);
      item.classList.toggle('is-active', itemTitle === normalizedTitle);
    });
  }

  function closePage(options) {
    const opts = options || {};

    qsa('.zc-settings-page').forEach((old) => {
      try {
        old.remove();
      } catch {}
    });

    if (!opts.keepClass) {
      setSettingsPageOpen(false);
    }

    if (opts.activateSettings) {
      const overlay = findOverlay();
      const settingsItem =
        qs('[data-zc-settings-tab="settings"]', overlay || document) ||
        qs('[data-title="Configurações"]', overlay || document);

      if (settingsItem) {
        qsa('[data-zc-settings-tab]', overlay || document).forEach((item) => {
          item.classList.toggle('is-active', item === settingsItem);
        });
      }
    }
  }

  function showToast(message) {
    const panel = findPageHost();
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

  async function copyText(text, successMessage) {
    const value = clean(text);
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      showToast(successMessage || 'Copiado');
      return;
    } catch {}

    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      showToast(successMessage || 'Copiado');
    } catch {
      showToast('Não foi possível copiar');
    }
  }

  function row(config) {
    const item = config || {};
    const tag = item.action ? 'button' : 'div';
    const typeAttr = tag === 'button' ? ' type="button"' : '';
    const actionAttr = item.action ? ` data-action="${escapeHtml(item.action)}"` : '';

    let sideHtml = '';

    if (item.shortcut) {
      sideHtml = `<span class="zc-settings-shortcut">${escapeHtml(item.shortcut)}</span>`;
    } else if (typeof item.switchOn === 'boolean') {
      sideHtml = `<span class="zc-settings-switch ${item.switchOn ? 'is-on' : ''}" aria-hidden="true"></span>`;
    } else if (item.side !== undefined && item.side !== null && clean(item.side) !== '') {
      sideHtml = `<span class="zc-settings-row-side">${escapeHtml(item.side)}</span>`;
    }

    return `
      <${tag}${typeAttr} class="zc-settings-row"${actionAttr}>
        <span class="zc-settings-row-icon">
          ${iconSvg(item.icon || '')}
        </span>

        <span class="zc-settings-row-main">
          <strong>${escapeHtml(item.title || '')}</strong>
          ${item.desc ? `<span>${escapeHtml(item.desc)}</span>` : ''}
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

  function openPage(configOrTitle) {
    const config = typeof configOrTitle === 'string'
      ? findConfigByTitle(configOrTitle)
      : configOrTitle;

    const panel = findPageHost();

    if (!panel || !config) {
      return false;
    }

    ensureStyle();

    closePage({ keepClass: true });

    setSettingsPageOpen(true);
    setMenuActiveByTitle(config.title || config.match || '');

    const page = document.createElement('section');
    page.className = 'zc-settings-page';

    const bodyHtml = typeof config.render === 'function'
      ? config.render(api)
      : '';

    page.innerHTML = `
      <header class="zc-settings-page-head">
        <button type="button" class="zc-settings-page-back" aria-label="Voltar">
          ${iconSvg('fa-solid fa-arrow-left')}
        </button>

        <div class="zc-settings-page-title-wrap">
          <div class="zc-settings-page-title">${escapeHtml(config.title || 'Configurações')}</div>
          ${config.subtitle ? `<div class="zc-settings-page-subtitle">${escapeHtml(config.subtitle)}</div>` : ''}
        </div>
      </header>

      <div class="zc-settings-page-body">
        ${bodyHtml}
      </div>
    `;

    panel.appendChild(page);

    const back = qs('.zc-settings-page-back', page);

    if (back) {
      back.addEventListener('click', () => {
        closePage({ activateSettings: true });
      });
    }

    if (typeof config.onOpen === 'function') {
      try {
        config.onOpen(page, api);
      } catch (e) {
        console.error('[ZCSettingsPage] erro no onOpen:', e);
      }
    }

    return true;
  }

  function openByTitle(title) {
    return openPage(title);
  }

  function register(config) {
    if (!config || !config.match) return false;

    const newMatches = getConfigMatches(config);

    const exists = REGISTRY.some((oldConfig) => {
      const oldMatches = getConfigMatches(oldConfig);
      return newMatches.some((m) => oldMatches.includes(m));
    });

    if (exists) return true;

    REGISTRY.push(config);
    return true;
  }

  function handleClick(event) {
    const overlay = findOverlay();

    if (!isOverlayOpen(overlay)) return;

    const btn = event.target.closest('.zc-wa-settings-item, .zcWppSettingsItem');

    if (!btn || !overlay.contains(btn)) return;

    const tab = clean(btn.getAttribute('data-zc-settings-tab'));

    if (
      tab === 'profile' ||
      tab === 'settings' ||
      tab === 'theme' ||
      tab === 'logout' ||
      btn.id === 'zcWaSettingsLogout' ||
      btn.classList.contains('zc-wa-settings-logout')
    ) {
      return;
    }

    const title = getClickedTitle(btn);
    const config = findConfigByTitle(title);

    if (!config) return;

    event.preventDefault();
    event.stopPropagation();

    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }

    qsa('[data-zc-settings-tab]', overlay).forEach((item) => {
      item.classList.toggle('is-active', item === btn);
    });

    openPage(config);
  }

  const api = {
    register,
    openPage,
    openByTitle,

    open: openByTitle,
    show: openByTitle,
    showPage: openByTitle,
    setPage: openByTitle,
    navigate: openByTitle,
    go: openByTitle,

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

    try {
      window.dispatchEvent(new CustomEvent('zc:settings-page-helper-ready'));
    } catch {
      const event = document.createEvent('Event');
      event.initEvent('zc:settings-page-helper-ready', true, true);
      window.dispatchEvent(event);
    }
  });
})();