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
 *
 * Importante:
 * - Não substitui perfil.js
 * - Não mexe no perfil-instancia.js
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
    if (document.getElementById('zcSettingsInternalPagesStyle')) return;

    const style = document.createElement('style');
    style.id = 'zcSettingsInternalPagesStyle';
    style.textContent = `
      #zcWppSettingsProfilePanel .zcWppSettingsPanel{
        position:relative !important;
        overflow:hidden !important;
      }

      .zc-settings-page{
        position:absolute;
        inset:0;
        z-index:80;
        background:#111b21;
        color:#e9edef;
        display:flex;
        flex-direction:column;
        animation:zcSettingsPageIn .18s ease both;
        font-family:"Inter","Segoe UI",Arial,sans-serif;
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
        background:#111b21;
        border-bottom:1px solid rgba(255,255,255,.06);
      }

      .zc-settings-page-back{
        width:34px;
        height:34px;
        border:0;
        border-radius:999px;
        background:transparent;
        color:#e9edef;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        cursor:pointer;
        font-size:17px;
      }

      .zc-settings-page-back:hover{
        background:rgba(255,255,255,.08);
      }

      .zc-settings-page-title-wrap{
        min-width:0;
        display:flex;
        flex-direction:column;
        gap:2px;
      }

      .zc-settings-page-title{
        color:#e9edef;
        font-size:16px;
        font-weight:700;
        line-height:1.15;
      }

      .zc-settings-page-subtitle{
        color:#aebac1;
        font-size:12px;
        line-height:1.25;
      }

      .zc-settings-page-body{
        flex:1 1 auto;
        min-height:0;
        overflow:auto;
        background:#0b141a;
        padding-bottom:20px;
      }

      .zc-settings-block{
        background:#111b21;
        border-bottom:10px solid #0b141a;
        padding:18px 22px;
      }

      .zc-settings-block-title{
        margin:0 0 12px;
        color:#00a884;
        font-size:13px;
        font-weight:700;
      }

      .zc-settings-desc{
        margin:0;
        color:#aebac1;
        font-size:13px;
        line-height:1.45;
      }

      .zc-settings-list{
        background:#111b21;
        border-bottom:10px solid #0b141a;
      }

      .zc-settings-row{
        width:100%;
        min-height:62px;
        border:0;
        background:transparent;
        color:#e9edef;
        display:flex;
        align-items:center;
        gap:18px;
        padding:13px 22px;
        text-align:left;
        text-decoration:none;
        font:inherit;
      }

      button.zc-settings-row{
        cursor:pointer;
      }

      button.zc-settings-row:hover{
        background:rgba(255,255,255,.055);
      }

      .zc-settings-row-icon{
        width:24px;
        min-width:24px;
        color:#aebac1;
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
        color:#e9edef;
        font-size:14px;
        font-weight:700;
        line-height:1.2;
      }

      .zc-settings-row-main span{
        color:#aebac1;
        font-size:12.5px;
        line-height:1.35;
      }

      .zc-settings-row-side{
        color:#8696a0;
        font-size:12.5px;
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

      .zc-settings-shortcut{
        margin-left:auto;
        color:#aebac1;
        font-size:12px;
        font-weight:700;
        background:#202c33;
        border:1px solid rgba(255,255,255,.08);
        border-radius:6px;
        padding:4px 8px;
      }

      .zc-settings-toast{
        position:absolute;
        left:50%;
        bottom:18px;
        transform:translateX(-50%) translateY(10px);
        background:#202c33;
        color:#e9edef;
        border-radius:999px;
        padding:9px 14px;
        font-size:13px;
        font-weight:700;
        opacity:0;
        pointer-events:none;
        transition:.16s ease;
        box-shadow:0 10px 28px rgba(0,0,0,.32);
        white-space:nowrap;
        z-index:120;
      }

      .zc-settings-toast.show{
        opacity:1;
        transform:translateX(-50%) translateY(0);
      }

      html[data-theme="light"] .zc-settings-page,
      html[data-theme="light"] .zc-settings-page-head,
      html[data-theme="light"] .zc-settings-block,
      html[data-theme="light"] .zc-settings-list{
        background:#ffffff;
        color:#111b21;
      }

      html[data-theme="light"] .zc-settings-page-body{
        background:#f0f2f5;
      }

      html[data-theme="light"] .zc-settings-block,
      html[data-theme="light"] .zc-settings-list{
        border-bottom-color:#f0f2f5;
      }

      html[data-theme="light"] .zc-settings-page-title,
      html[data-theme="light"] .zc-settings-row-main strong,
      html[data-theme="light"] .zc-settings-page-back{
        color:#111b21;
      }

      html[data-theme="light"] .zc-settings-page-subtitle,
      html[data-theme="light"] .zc-settings-row-main span,
      html[data-theme="light"] .zc-settings-row-icon,
      html[data-theme="light"] .zc-settings-desc{
        color:#667781;
      }

      html[data-theme="light"] .zc-settings-shortcut{
        background:#f0f2f5;
        border-color:#d9e0e4;
        color:#667781;
      }
    `;

    document.head.appendChild(style);
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