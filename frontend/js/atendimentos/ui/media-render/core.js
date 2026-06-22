// /frontend/js/atendimentos/ui/media-render/core.js
// Núcleo compartilhado do media-render
// - Global window.ZCMediaRender
// - Versão/guardas
// - Limpeza de intervalos antigos
// - Helpers gerais de texto, HTML, JSON e arquivos
// - Helper do histórico
// - Infra para os próximos módulos

(function () {
  'use strict';

  const ROOT_KEY = 'ZCMediaRender';
  const MEDIA_RENDER_VERSION = 'zc-media-render-v17-wpp-like-core';

  window[ROOT_KEY] = window[ROOT_KEY] || {};

  const M = window[ROOT_KEY];

  if (M.__coreReady && window.__zcMediaRenderVersion === MEDIA_RENDER_VERSION) {
    return;
  }

  M.__coreReady = true;
  M.version = MEDIA_RENDER_VERSION;

  /*
    Compatibilidade com a versão antiga.
    O media-render.js monolítico usava essa flag global.
  */
  window.__zcMediaRenderVersion = MEDIA_RENDER_VERSION;

  /*
    Evita duplicar rotinas antigas caso o arquivo tenha sido recarregado
    por cache, troca de build ou hot reload.
  */
  try {
    if (window.__zcMediaEnsureInterval) {
      clearInterval(window.__zcMediaEnsureInterval);
      window.__zcMediaEnsureInterval = null;
    }
  } catch {}

  try {
    if (window.__zcMediaAvatarInterval) {
      clearInterval(window.__zcMediaAvatarInterval);
      window.__zcMediaAvatarInterval = null;
    }
  } catch {}

  try {
    delete document.__zcMediaViewerBound;
  } catch {}

  try {
    delete document.__mediaRenderChatEvt;
  } catch {}

  /*
    Remove viewer antigo para evitar dois lightbox na tela.
    O viewer.js criará de novo quando necessário.
  */
  try {
    document.querySelectorAll('.zc-media-viewer').forEach((el) => {
      el.remove();
    });
  } catch {}

  M.state = M.state || {
    viewerRef: null,
    observer: null,
    booted: false,
    enhancing: false,
  };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[ch]));
  }

  function cleanOneLine(s, fallback = '') {
    const out = String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    return out || fallback;
  }

  function jsonAttr(obj) {
    try {
      if (!obj || typeof obj !== 'object') return '';
      return escapeHtml(JSON.stringify(obj));
    } catch {
      return '';
    }
  }

  function uniq(arr) {
    const out = [];
    const seen = new Set();

    (arr || []).forEach((x) => {
      const v = String(x || '').trim();

      if (!v || seen.has(v)) return;

      seen.add(v);
      out.push(v);
    });

    return out;
  }

  function historyEl() {
    return document.getElementById('historico');
  }

  /*
    Mantém compatibilidade com o helper antigo H().
    Nos próximos arquivos podemos usar M.H() ou M.historyEl().
  */
  function H() {
    return historyEl();
  }

  function humanSize(bytes) {
    const b = Number(bytes || 0);

    if (!b) return '';

    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(
      units.length - 1,
      Math.floor(Math.log(b) / Math.log(1024))
    );

    return `${(b / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function basenameFromUrl(u) {
    try {
      const p = new URL(u, location.origin).pathname;
      const b = p.split('/').pop() || '';

      return decodeURIComponent(b);
    } catch {
      return '';
    }
  }

  function sanitizeBase(name) {
    const n = String(name || '').trim() || 'arquivo';

    return n
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\-.]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
  }

  function formatOnlyTime(raw) {
    try {
      if (!raw) return '';

      const d = new Date(raw);

      if (Number.isNaN(d.getTime())) {
        return '';
      }

      return d.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  function normalizeText(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function injectStyle(id, cssText) {
    if (!id) return null;

    const old = document.getElementById(id);

    if (old) {
      return old;
    }

    const st = document.createElement('style');
    st.id = id;
    st.textContent = String(cssText || '');

    document.head.appendChild(st);

    return st;
  }

  function onReady(fn) {
    if (typeof fn !== 'function') return;

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, {
        once: true,
      });
    } else {
      fn();
    }
  }

  function safeCall(fn, fallback = null, label = 'safeCall') {
    try {
      if (typeof fn === 'function') {
        return fn();
      }
    } catch (err) {
      console.warn(`[media-render][core] ${label} falhou:`, err);
    }

    return fallback;
  }

  function stringifyErr(raw) {
    if (raw == null) return '';

    if (typeof raw === 'string') {
      return raw.trim();
    }

    if (Array.isArray(raw)) {
      return raw
        .map((item) => stringifyErr(item))
        .filter(Boolean)
        .join(' | ');
    }

    if (typeof raw === 'object') {
      if (typeof raw.detail === 'string') return raw.detail.trim();
      if (typeof raw.message === 'string') return raw.message.trim();
      if (typeof raw.error === 'string') return raw.error.trim();

      try {
        return JSON.stringify(raw);
      } catch {
        return String(raw);
      }
    }

    return String(raw).trim();
  }



  /* =====================================================================
     Mídia preguiçosa / controle de RAM
     ===================================================================== */

  const LAZY_MEDIA_PLACEHOLDER = window.ZC_LAZY_MEDIA_PLACEHOLDER || (
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220" viewBox="0 0 320 220">' +
      '<rect width="320" height="220" rx="14" fill="#eef2f1"/>' +
      '<circle cx="160" cy="102" r="26" fill="#d5dedb"/>' +
      '<path d="M70 174l58-60 38 38 26-26 58 48z" fill="#d5dedb"/>' +
      '</svg>'
    )
  );

  function eagerImgAttrs(src, altList = '') {
    const safe = escapeHtml(src || '');
    return [
      `src="${safe}"`,
      'data-zc-eager-media="img"',
      `data-alt="${escapeHtml(altList || '')}"`,
      'loading="eager"',
      'decoding="async"',
      'fetchpriority="low"'
    ].join(' ');
  }

  function lazyImgAttrs(src, altList = '') {
    const safe = escapeHtml(src || '');
    return [
      `src="${escapeHtml(LAZY_MEDIA_PLACEHOLDER)}"`,
      'data-zc-lazy-media="img"',
      `data-zc-lazy-src="${safe}"`,
      `data-alt="${escapeHtml(altList || '')}"`,
      'loading="lazy"',
      'decoding="async"',
      'fetchpriority="low"'
    ].join(' ');
  }

  function lazyVideoAttrs(src, altList = '') {
    const safe = escapeHtml(src || '');
    return [
      'preload="none"',
      'data-zc-lazy-media="video"',
      `data-zc-lazy-src="${safe}"`,
      `data-alt="${escapeHtml(altList || '')}"`
    ].join(' ');
  }

  function extend(methods = {}) {
    Object.keys(methods || {}).forEach((key) => {
      M[key] = methods[key];
    });

    return M;
  }

  function requireDeps(names = [], moduleName = 'módulo') {
    const missing = [];

    names.forEach((name) => {
      if (typeof M[name] === 'undefined') {
        missing.push(name);
      }
    });

    if (missing.length) {
      console.warn(
        `[media-render][${moduleName}] dependências ausentes:`,
        missing
      );
      return false;
    }

    return true;
  }

  function exposeGlobal(name, value) {
    if (!name) return;

    try {
      window[name] = value;
    } catch (err) {
      console.warn(`[media-render][core] não foi possível expor window.${name}:`, err);
    }
  }

  function currentEmpresaId() {
    return (
      window.EMPRESA_ID ??
      window.empresa_id ??
      window.state?.empresa_id ??
      localStorage.getItem('empresa_id') ??
      null
    );
  }

  extend({
    MEDIA_RENDER_VERSION,

    escapeHtml,
    cleanOneLine,
    jsonAttr,
    uniq,

    historyEl,
    H,

    humanSize,
    basenameFromUrl,
    sanitizeBase,
    formatOnlyTime,
    normalizeText,
    isPlainObject,

    injectStyle,
    onReady,
    safeCall,
    stringifyErr,

    extend,
    require: requireDeps,
    exposeGlobal,

    currentEmpresaId,

    LAZY_MEDIA_PLACEHOLDER,
    eagerImgAttrs,
    lazyImgAttrs,
    lazyVideoAttrs,
  });

  console.log('[media-render] core carregado:', MEDIA_RENDER_VERSION);
})();