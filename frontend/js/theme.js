// /frontend/js/theme.js
// Gerenciador único de tema do ZapsChat.
(function (global) {
  'use strict';

  var STORAGE_KEY = 'zapschat_theme';
  var LEGACY_KEYS = ['theme', 'zc:theme', 'valora_theme'];
  var root = document.documentElement;
  var subscribers = [];

  function normalize(value) {
    return String(value || '').toLowerCase() === 'dark' ? 'dark' :
      (String(value || '').toLowerCase() === 'light' ? 'light' : '');
  }

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  function safeRemove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  function readStored() {
    var current = normalize(safeGet(STORAGE_KEY));
    if (current) return current;

    for (var i = 0; i < LEGACY_KEYS.length; i += 1) {
      var migrated = normalize(safeGet(LEGACY_KEYS[i]));
      if (migrated) return migrated;
    }

    var fromMarkup = normalize(root.getAttribute('data-theme'));
    if (fromMarkup) return fromMarkup;

    return 'light';
  }

  function cleanLegacyKeys() {
    for (var i = 0; i < LEGACY_KEYS.length; i += 1) {
      safeRemove(LEGACY_KEYS[i]);
    }
  }

  function emit(theme, source) {
    var detail = { theme: theme, source: source || 'api' };
    var eventNames = [
      'zapschat-theme-changed',
      'app:theme-change',
      'zc:theme-changed',
      'theme:changed'
    ];

    for (var i = 0; i < eventNames.length; i += 1) {
      try { global.dispatchEvent(new CustomEvent(eventNames[i], { detail: detail })); } catch (e) {}
    }

    subscribers.slice().forEach(function (handler) {
      try { handler(theme, detail); } catch (e) {}
    });
  }

  function apply(theme, options) {
    options = options || {};
    var normalized = normalize(theme) || 'light';
    var dark = normalized === 'dark';
    var changed = current() !== normalized;

    root.classList.toggle('dark', dark);
    root.setAttribute('data-theme', normalized);
    root.style.colorScheme = normalized;

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#212121' : '#ffffff');

    if (options.persist !== false) {
      safeSet(STORAGE_KEY, normalized);
      cleanLegacyKeys();
    }

    if (options.emit !== false && (changed || options.forceEmit)) {
      emit(normalized, options.source || 'api');
    }

    return normalized;
  }

  function current() {
    var attr = normalize(root.getAttribute('data-theme'));
    if (attr) return attr;
    return root.classList.contains('dark') ? 'dark' : 'light';
  }

  function get() {
    return normalize(safeGet(STORAGE_KEY)) || current() || 'light';
  }

  function set(theme) {
    return apply(theme, { persist: true, emit: true, source: 'set' });
  }

  function toggle() {
    return set(current() === 'dark' ? 'light' : 'dark');
  }

  function subscribe(handler) {
    if (typeof handler !== 'function') return function () {};
    subscribers.push(handler);
    return function () {
      subscribers = subscribers.filter(function (item) { return item !== handler; });
    };
  }

  var api = {
    key: STORAGE_KEY,
    get: get,
    current: current,
    set: set,
    toggle: toggle,
    apply: apply,
    subscribe: subscribe
  };

  global.AppTheme = api;

  // Aplica antes da pintura e migra preferências antigas para a chave oficial.
  apply(readStored(), { persist: true, emit: false, source: 'preload' });

  global.addEventListener('storage', function (event) {
    if (!event || event.key !== STORAGE_KEY) return;
    var next = normalize(event.newValue) || 'light';
    apply(next, { persist: false, emit: true, source: 'storage' });
  });
})(window);
