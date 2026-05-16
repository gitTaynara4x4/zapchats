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
 * Funciona com o sidebar novo:
 *   #zcWaSettingsOverlay
 *   .zc-wa-settings-panel
 *   .zc-wa-settings-item
 *
 * Compatível também com painel antigo:
 *   #zcWppSettingsProfilePanel
 *   .zcWppSettingsPanel
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
        --zc-settings-bg:#111b21;
        --zc-settings-panel-bg:#111b21;
        --zc-settings-surface:#111b21;
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
        --zc-settings-bg:#111b21;
        --zc-settings-panel-bg:#111b21;
        --zc-settings-surface:#111b21;
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

      /*
        IMPORTANTE:
        A página interna agora abre dentro do painel esquerdo,
        não dentro da .zc-wa-settings-content da direita.
      */
      #zcWaSettingsOverlay .zc-wa-settings-panel,
      #zcWppSettingsProfilePanel .zcWppSettingsPanel{
        position:relative !important;
        overflow:hidden !important;
      }

      /*
        Proteção: versões antigas do CSS escondiam o painel esquerdo
        no mobile quando .zc-settings-page-open estava ativo.
        Agora NÃO pode esconder, porque a página abre nele.
      */
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

      .zc-settings-page-back i{
        font-size:16px;
        line-height:1;
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
        font-size:16px;
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
          <i class="${escapeHtml(item.icon || 'fa-regular fa-circle')}"></i>
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
          <i class="fa-solid fa-arrow-left"></i>
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