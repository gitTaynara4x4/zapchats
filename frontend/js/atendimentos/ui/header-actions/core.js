// /frontend/js/atendimentos/ui/header-actions/core.js
// Núcleo compartilhado do header-actions
// - Estado global
// - Helpers de DOM
// - Helpers de texto/IDs
// - Toast
// - Utilitários usados pelos outros módulos

(function () {
  'use strict';

  const ROOT_KEY = 'ZCHeaderActions';

  window[ROOT_KEY] = window[ROOT_KEY] || {};

  const H = window[ROOT_KEY];

  if (H.__coreReady) return;
  H.__coreReady = true;

  H.version = H.version || 'header-actions-split-v1-core';

  const existingState = H.state || {};

  const selectedMsgIds =
    existingState.selectedMsgIds instanceof Set
      ? existingState.selectedMsgIds
      : new Set(
          Array.isArray(existingState.selectedMsgIds)
            ? existingState.selectedMsgIds
            : []
        );

  H.state = {
    searchOpen: false,
    menuOpen: false,
    selectMode: false,
    forwardOpen: false,
    dateJumpOpen: false,
    dateJumping: false,
    searchTimer: 0,
    results: [],
    selectedMsgIds,
    forwarding: false,
    ...existingState,
  };

  if (!(H.state.selectedMsgIds instanceof Set)) {
    H.state.selectedMsgIds = selectedMsgIds;
  }

  H.EMPRESA_ID = Number(
    window.EMPRESA_ID ||
    localStorage.getItem('empresa_id') ||
    0
  );

  H.$ = function $(sel, root = document) {
    return root.querySelector(sel);
  };

  H.$all = function $all(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  };

  H.escapeHtml = function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[ch]));
  };

  H.normalize = function normalize(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  };

  H.sleep = function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };

  H.headerEl = function headerEl() {
    return document.getElementById('chat-header');
  };

  H.historyEl = function historyEl() {
    return document.getElementById('historico');
  };

  H.onlyDigits = function onlyDigits(v) {
    return String(v || '').replace(/\D+/g, '');
  };

  H.isJid = function isJid(v) {
    return /@g\.us$/i.test(String(v || '')) ||
      /@s\.whatsapp\.net$/i.test(String(v || ''));
  };

  H.idKey = function idKey(v) {
    const s = String(v ?? '').trim();

    if (
      !s ||
      s === 'null' ||
      s === 'undefined' ||
      s === 'NaN'
    ) {
      return null;
    }

    return s;
  };

  H.instKey = function instKey(v) {
    const s = String(v ?? '').trim();

    if (!s) return null;

    if (
      [
        'null',
        'undefined',
        'nan',
        '0',
        'all',
        '*',
        '-',
      ].includes(s.toLowerCase())
    ) {
      return null;
    }

    return s;
  };

  H.stripUndefined = function stripUndefined(obj) {
    Object.keys(obj || {}).forEach((k) => {
      if (obj[k] === undefined) delete obj[k];
    });

    return obj;
  };

  H.isMobileHeader = function isMobileHeader() {
    try {
      return window.matchMedia &&
        window.matchMedia('(max-width: 920px)').matches;
    } catch {
      return window.innerWidth <= 920;
    }
  };

  H.cleanText = function cleanText(el) {
    return String(el?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  H.isUsableButton = function isUsableButton(btn) {
    if (!btn) return false;
    if (btn.disabled) return false;
    if (btn.hidden) return false;
    if (btn.getAttribute('aria-hidden') === 'true') return false;

    return true;
  };

  H.escapeRegExp = function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  H.stringifyErr = function stringifyErr(raw) {
    if (raw == null) return '';

    if (typeof raw === 'string') {
      return raw.trim();
    }

    if (Array.isArray(raw)) {
      return raw
        .map((item) => H.stringifyErr(item))
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
  };

  H.injectStyle = function injectStyle(id, cssText) {
    if (!id || document.getElementById(id)) return null;

    const st = document.createElement('style');
    st.id = id;
    st.textContent = String(cssText || '');

    document.head.appendChild(st);

    return st;
  };

  H.onReady = function onReady(fn) {
    if (typeof fn !== 'function') return;

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  };

  H.safeCall = function safeCall(fn, fallback = null) {
    try {
      if (typeof fn === 'function') {
        return fn();
      }
    } catch (err) {
      console.warn('[header-actions][core] safeCall falhou:', err);
    }

    return fallback;
  };

  H.toast = function toast({
    title = 'Pronto',
    msg = '',
    type = 'ok',
    timeout = 2600,
  } = {}) {
    if (typeof window.toast === 'function') {
      try {
        window.toast({ title, msg, type, timeout });
        return;
      } catch {}

      try {
        window.toast(msg || title, type !== 'error');
        return;
      } catch {}
    }

    let host = document.getElementById('zcToastHost');

    if (!host) {
      host = document.createElement('div');
      host.id = 'zcToastHost';
      host.className = 'zcToastHost';
      document.body.appendChild(host);
    }

    const el = document.createElement('div');
    el.className = `zcToast ${type === 'error' ? 'err' : 'ok'}`;

    el.innerHTML = `
      <div>
        <div class="t-title">${H.escapeHtml(title)}</div>
        ${msg ? `<div class="t-msg">${H.escapeHtml(msg)}</div>` : ''}
      </div>
      <button class="t-close" aria-label="Fechar">×</button>
    `;

    host.appendChild(el);

    requestAnimationFrame(() => {
      el.classList.add('on');
    });

    el.querySelector('.t-close')?.addEventListener('click', () => {
      el.remove();
    });

    if (timeout) {
      setTimeout(() => {
        el.remove();
      }, timeout);
    }
  };

  H.extend = function extend(methods = {}) {
    Object.keys(methods || {}).forEach((key) => {
      H[key] = methods[key];
    });

    return H;
  };

  H.require = function require(names = [], moduleName = 'módulo') {
    const missing = [];

    names.forEach((name) => {
      if (typeof H[name] === 'undefined') {
        missing.push(name);
      }
    });

    if (missing.length) {
      console.warn(
        `[header-actions][${moduleName}] dependências ausentes:`,
        missing
      );
      return false;
    }

    return true;
  };

  console.log('[header-actions] core carregado:', H.version);
})();