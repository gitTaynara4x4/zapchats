// /frontend/js/notif.js
(function PlanNotificationsBootstrap() {
  'use strict';

  if (window.__PLAN_NOTIF_FILE_LOADED__) return;
  window.__PLAN_NOTIF_FILE_LOADED__ = true;

  var utils = window.AppBaseUtils || {};
  var __DEV__ = /(^localhost$|^127\.0\.0\.1$)/.test(location.hostname);
  var __ASSET_VER__ = window.__ASSET_VER__ || 'v1';
  var __PLAN_ALERT_BOOTED__ = false;

  var PLAN_NOTIF_MAX_VISIBLE = 4;
  var PLAN_NOTIF_MAX_HISTORY = 50;

  function bust(u) {
    if (typeof utils.bust === 'function') return utils.bust(u);

    var ver = __DEV__ ? Date.now() : __ASSET_VER__;
    try {
      var x = new URL(u, location.origin);
      x.searchParams.set('_v', ver);
      return x.toString();
    } catch (e) {
      return u + (u.indexOf('?') >= 0 ? '&' : '?') + '_v=' + ver;
    }
  }

  function isPublicLikePage() {
    if (typeof utils.isPublicLikePage === 'function') return utils.isPublicLikePage();

    var p = (location.pathname || '').toLowerCase();
    return (
      p === '/' ||
      p === '/inicio' || p === '/inicio.html' ||
      p === '/login' || p === '/login.html' ||
      p === '/criar-empresa' || p === '/criar-empresa' ||
      p === '/criar-empresa' || p === '/criar-empresa.html' ||
      p === '/esqueci_senha' || p === '/esqueci_senha.html' ||
      p === '/planos' || p === '/planos.html' ||
      p === '/admin-planos' || p === '/admin-planos.html'
    );
  }

  function getCookie(name) {
    if (typeof utils.getCookie === 'function') return utils.getCookie(name);

    try {
      var prefix = name + '=';
      var parts = document.cookie ? document.cookie.split('; ') : [];
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].indexOf(prefix) === 0) {
          return decodeURIComponent(parts[i].slice(prefix.length));
        }
      }
    } catch (e) {}
    return null;
  }

  function escapeHtml(v) {
    if (typeof utils.escapeHtml === 'function') return utils.escapeHtml(v);

    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pluralDia(n) {
    if (typeof utils.pluralDia === 'function') return utils.pluralDia(n);
    return Number(n) === 1 ? 'dia' : 'dias';
  }

  function nowIso() {
    if (typeof utils.nowIso === 'function') return utils.nowIso();
    try { return new Date().toISOString(); } catch (e) { return String(Date.now()); }
  }

  function normalizeActionHref(url) {
    var raw = String(url || '/perfil.html').trim();
    if (!raw) return '/perfil.html';
    if (raw.charAt(0) === '/') return raw;

    try {
      var u = new URL(raw, location.origin);
      if (u.origin === location.origin) return u.pathname + u.search + u.hash;
    } catch (e) {}

    return '/perfil.html';
  }

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  function safeReadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function safeWriteJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  function currentEmpresaId() {
    return getCookie('empresa_id') || getCookie('EMPRESA_ID') || '0';
  }

  function historyKey(empresaId) {
    return 'plan_notif:' + String(empresaId || '0') + ':history';
  }

  function unreadKey(empresaId) {
    return 'plan_notif:' + String(empresaId || '0') + ':unread';
  }

  function shownKey(state) {
    return 'plan_toast_shown:' + String(state && state.key || 'generic');
  }

  function dismissKey(state) {
    var kind = state && state.kind ? state.kind : 'generic';
    var exp = state && state.expiresAt ? state.expiresAt : 'none';
    return 'plan_toast_dismiss:' + kind + ':' + exp;
  }

  function wasShown(state) {
    return safeGet(shownKey(state)) === '1';
  }

  function markShown(state) {
    safeSet(shownKey(state), '1');
  }

  function isDismissed(state) {
    return safeGet(dismissKey(state)) === '1';
  }

  function markDismissed(state) {
    safeSet(dismissKey(state), '1');
  }

  function loadHistory(empresaId) {
    return safeReadJson(historyKey(empresaId), []);
  }

  function saveHistory(empresaId, items) {
    safeWriteJson(historyKey(empresaId), (items || []).slice(0, PLAN_NOTIF_MAX_HISTORY));
  }

  function loadUnread(empresaId) {
    var n = safeReadJson(unreadKey(empresaId), 0);
    return Math.max(0, Number(n || 0));
  }

  function saveUnread(empresaId, count) {
    safeWriteJson(unreadKey(empresaId), Math.max(0, Number(count || 0)));
  }

  function emitNotificationsUpdated(empresaId) {
    try {
      document.dispatchEvent(new CustomEvent('plan-notifications:updated', {
        detail: {
          empresaId: String(empresaId || '0'),
          unread: loadUnread(empresaId),
          items: loadHistory(empresaId)
        }
      }));
    } catch (e) {}
  }

  function getPlanIconSvg(kind) {
    var map = {
      warning:
        '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M12 3.5 21 19a1.8 1.8 0 0 1-1.56 2.7H4.56A1.8 1.8 0 0 1 3 19L12 3.5Z"/>' +
          '<path d="M12 9.2v4.6"/>' +
          '<path d="M12 17.25h.01"/>' +
        '</svg>',

      strong:
        '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M13 2 4 14h6l-1 8 11-14h-6l1-6Z"/>' +
        '</svg>',

      expired:
        '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="12" cy="12" r="9"/>' +
          '<path d="M15.5 8.5 8.5 15.5"/>' +
          '<path d="M8.5 8.5 15.5 15.5"/>' +
        '</svg>',

      trial:
        '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="12" cy="12" r="9"/>' +
          '<path d="M12 7.2v4.8l3 1.9"/>' +
        '</svg>'
    };

    return map[kind] || map.warning;
  }

  function getEyebrow(state) {
    if (!state) return 'Assinatura';
    if (state.variant === 'expired') return 'Crítico';
    if (state.variant === 'strong') return 'Importante';
    if (state.variant === 'trial') return 'Trial';
    return 'Assinatura';
  }

  function ensureStyles() {
    if (document.getElementById('plan-notif-styles')) return;

    var css = `
      :root{
        --plan-toast-bg: rgba(255,255,255,.96);
        --plan-toast-text: #0f172a;
        --plan-toast-muted: #64748b;
        --plan-toast-muted-2: #475569;
        --plan-toast-border: rgba(148,163,184,.18);
        --plan-toast-shadow:
          0 18px 48px rgba(15,23,42,.14),
          0 6px 18px rgba(15,23,42,.07);
      }

      html.dark{
        --plan-toast-bg: rgba(15,23,42,.96);
        --plan-toast-text: #f8fafc;
        --plan-toast-muted: #94a3b8;
        --plan-toast-muted-2: #cbd5e1;
        --plan-toast-border: rgba(148,163,184,.16);
        --plan-toast-shadow:
          0 24px 64px rgba(0,0,0,.42),
          0 10px 28px rgba(0,0,0,.22);
      }

      .plan-toast-stack{
        position: fixed;
        top: 18px;
        right: 18px;
        width: 390px;
        max-width: calc(100vw - 24px);
        display: flex;
        flex-direction: column;
        gap: 12px;
        z-index: 9999;
        pointer-events: none;
      }

      .plan-toast{
        position: relative;
        pointer-events: auto;
        display: grid;
        grid-template-columns: 48px minmax(0,1fr) auto;
        gap: 12px;
        align-items: start;
        padding: 14px;
        border-radius: 20px;
        background: var(--plan-toast-bg);
        border: 1px solid var(--plan-toast-border);
        box-shadow: var(--plan-toast-shadow);
        color: var(--plan-toast-text);
        overflow: hidden;
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        animation: planToastEnter .24s ease;
      }

      .plan-toast.is-leaving{
        animation: planToastLeave .18s ease forwards;
      }

      .plan-toast::before{
        content:"";
        position:absolute;
        left:0;
        top:0;
        bottom:0;
        width:4px;
      }

      .plan-toast--warning::before{ background: linear-gradient(180deg, #f59e0b, #fbbf24); }
      .plan-toast--strong::before{ background: linear-gradient(180deg, #f97316, #fb923c); }
      .plan-toast--expired::before{ background: linear-gradient(180deg, #ef4444, #f87171); }
      .plan-toast--trial::before{ background: linear-gradient(180deg, #3b82f6, #60a5fa); }

      .plan-toast__icon{
        width: 48px;
        height: 48px;
        border-radius: 15px;
        display: grid;
        place-items: center;
        flex: 0 0 auto;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.28);
      }

      .plan-toast__icon svg{
        width: 19px;
        height: 19px;
        stroke: currentColor;
      }

      .plan-toast--warning .plan-toast__icon{
        background: linear-gradient(135deg, #fef3c7, #fde68a);
        color: #b45309;
      }

      .plan-toast--strong .plan-toast__icon{
        background: linear-gradient(135deg, #ffedd5, #fdba74);
        color: #c2410c;
      }

      .plan-toast--expired .plan-toast__icon{
        background: linear-gradient(135deg, #fee2e2, #fca5a5);
        color: #b91c1c;
      }

      .plan-toast--trial .plan-toast__icon{
        background: linear-gradient(135deg, #dbeafe, #93c5fd);
        color: #1d4ed8;
      }

      html.dark .plan-toast--warning .plan-toast__icon{
        background: linear-gradient(135deg, rgba(245,158,11,.22), rgba(251,191,36,.28));
        color: #fbbf24;
      }

      html.dark .plan-toast--strong .plan-toast__icon{
        background: linear-gradient(135deg, rgba(249,115,22,.22), rgba(251,146,60,.28));
        color: #fb923c;
      }

      html.dark .plan-toast--expired .plan-toast__icon{
        background: linear-gradient(135deg, rgba(239,68,68,.22), rgba(248,113,113,.28));
        color: #f87171;
      }

      html.dark .plan-toast--trial .plan-toast__icon{
        background: linear-gradient(135deg, rgba(59,130,246,.22), rgba(96,165,250,.28));
        color: #60a5fa;
      }

      .plan-toast__body{
        min-width: 0;
      }

      .plan-toast__eyebrow{
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 0 9px;
        border-radius: 999px;
        background: rgba(15,23,42,.06);
        color: var(--plan-toast-muted-2);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: .06em;
        text-transform: uppercase;
        margin-bottom: 8px;
      }

      html.dark .plan-toast__eyebrow{
        background: rgba(255,255,255,.08);
      }

      .plan-toast__title{
        margin: 0 0 5px;
        font-size: 14px;
        font-weight: 800;
        line-height: 1.3;
        color: var(--plan-toast-text);
        letter-spacing: -.01em;
      }

      .plan-toast__text{
        margin: 0;
        font-size: 13px;
        line-height: 1.58;
        color: var(--plan-toast-muted-2);
      }

      .plan-toast__actions{
        display:flex;
        align-items:center;
        gap:8px;
        margin-top: 12px;
      }

      .plan-toast__btn,
      .plan-toast__close{
        appearance:none;
        border:0;
        cursor:pointer;
        font:inherit;
        transition: transform .15s ease, background-color .15s ease, color .15s ease, opacity .15s ease;
      }

      .plan-toast__btn{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        min-height: 36px;
        padding: 0 12px;
        border-radius: 12px;
        text-decoration:none;
        background: linear-gradient(135deg, #0f172a, #334155);
        color:#fff;
        font-size: 12px;
        font-weight: 800;
        box-shadow: 0 8px 18px rgba(15,23,42,.15);
      }

      .plan-toast__btn:hover{
        transform: translateY(-1px);
      }

      html.dark .plan-toast__btn{
        background: linear-gradient(135deg, #f8fafc, #e2e8f0);
        color:#0f172a;
      }

      .plan-toast__close{
        width: 32px;
        height: 32px;
        border-radius: 11px;
        background: transparent;
        color: var(--plan-toast-muted);
        display:grid;
        place-items:center;
        margin-top: 2px;
      }

      .plan-toast__close:hover{
        background: rgba(15,23,42,.06);
        color: var(--plan-toast-text);
      }

      html.dark .plan-toast__close:hover{
        background: rgba(255,255,255,.08);
      }

      @keyframes planToastEnter{
        from{ opacity:0; transform: translateY(-8px) scale(.985); }
        to{ opacity:1; transform: translateY(0) scale(1); }
      }

      @keyframes planToastLeave{
        from{ opacity:1; transform: translateY(0) scale(1); }
        to{ opacity:0; transform: translateY(-6px) scale(.985); }
      }

      @media (max-width: 720px){
        .plan-toast-stack{
          left: 12px;
          right: 12px;
          width: auto;
          max-width: none;
        }

        .plan-toast{
          grid-template-columns: 44px minmax(0,1fr) auto;
          border-radius: 18px;
        }

        .plan-toast__icon{
          width:44px;
          height:44px;
          border-radius:14px;
        }
      }

      @media (prefers-reduced-motion: reduce){
        .plan-toast,
        .plan-toast__btn,
        .plan-toast__close{
          animation:none!important;
          transition:none!important;
        }
      }
    `;

    var st = document.createElement('style');
    st.id = 'plan-notif-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function ensureToastStack() {
    var stack = document.getElementById('plan-toast-stack');
    if (stack) return stack;

    stack = document.createElement('div');
    stack.id = 'plan-toast-stack';
    stack.className = 'plan-toast-stack';
    document.body.appendChild(stack);

    return stack;
  }

  function findToastByKey(stack, key) {
    if (!stack || !key) return null;
    var items = stack.querySelectorAll('.plan-toast');
    for (var i = 0; i < items.length; i++) {
      if (items[i].dataset.key === key) return items[i];
    }
    return null;
  }

  function removeToast(el) {
    if (!el || el.dataset.removing === '1') return;
    el.dataset.removing = '1';
    el.classList.add('is-leaving');
    setTimeout(function() {
      try { el.remove(); } catch (e) {}
    }, 180);
  }

  function trimStack(stack) {
    if (!stack) return;
    var items = stack.querySelectorAll('.plan-toast');
    if (items.length <= PLAN_NOTIF_MAX_VISIBLE) return;

    for (var i = 0; i < items.length - PLAN_NOTIF_MAX_VISIBLE; i++) {
      removeToast(items[i]);
    }
  }

  function pushToHistory(state) {
    if (!state || !state.key) return;

    var empresaId = String(state.empresaId || currentEmpresaId() || '0');
    var items = loadHistory(empresaId);
    var exists = false;

    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].key === state.key) {
        exists = true;
        break;
      }
    }

    if (!exists) {
      items.unshift({
        key: state.key,
        title: state.title || 'Notificação',
        message: state.message || '',
        variant: state.variant || 'warning',
        iconKind: state.iconKind || 'warning',
        created_at: nowIso(),
        actionHref: normalizeActionHref(state.actionHref || '/perfil.html'),
        actionText: state.actionText || 'Ver meu plano'
      });

      saveHistory(empresaId, items);
      saveUnread(empresaId, loadUnread(empresaId) + 1);
      emitNotificationsUpdated(empresaId);
    }
  }

  function showPlanToast(state) {
    if (!state || !state.message || !state.key) return;
    if (isDismissed(state)) return;
    if (wasShown(state)) return;

    ensureStyles();

    var stack = ensureToastStack();
    if (findToastByKey(stack, state.key)) return;

    markShown(state);

    var toast = document.createElement('div');
    toast.className = 'plan-toast plan-toast--' + escapeHtml(state.variant || 'warning');
    toast.dataset.key = state.key;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    var actionHref = normalizeActionHref(state.actionHref || '/perfil.html');
    var actionText = state.actionText || 'Ver meu plano';

    toast.innerHTML = ''
      + '<div class="plan-toast__icon" aria-hidden="true">' + getPlanIconSvg(state.iconKind || 'warning') + '</div>'
      + '<div class="plan-toast__body">'
      +   '<div class="plan-toast__eyebrow">' + escapeHtml(getEyebrow(state)) + '</div>'
      +   '<div class="plan-toast__title">' + escapeHtml(state.title || 'Aviso do plano') + '</div>'
      +   '<p class="plan-toast__text">' + escapeHtml(state.message) + '</p>'
      +   '<div class="plan-toast__actions">'
      +     '<a class="plan-toast__btn" href="' + escapeHtml(actionHref) + '">' + escapeHtml(actionText) + '</a>'
      +   '</div>'
      + '</div>'
      + '<button type="button" class="plan-toast__close" aria-label="Fechar aviso">✕</button>';

    var closeBtn = toast.querySelector('.plan-toast__close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        markDismissed(state);
        removeToast(toast);
      });
    }

    stack.appendChild(toast);
    trimStack(stack);

    var timeoutMs = state.variant === 'expired' ? 9500 : 7000;
    setTimeout(function() {
      removeToast(toast);
    }, timeoutMs);
  }

  function dismissAllToasts() {
    var stack = document.getElementById('plan-toast-stack');
    if (!stack) return;
    var items = stack.querySelectorAll('.plan-toast');
    for (var i = 0; i < items.length; i++) {
      removeToast(items[i]);
    }
  }

  function buildPlanAlertState(status, empresaId) {
    if (!status || typeof status !== 'object') return null;

    var paid = status.paid || {};
    var trial = status.trial || {};
    var planName = (
      (paid && paid.plan_name) ||
      status.plan_name ||
      status.plan_code ||
      'plano'
    );

    if (paid.expired) {
      return {
        empresaId: empresaId,
        key: 'paid-expired:' + String(paid.expires_at || 'none'),
        kind: 'paid-expired',
        variant: 'expired',
        iconKind: 'expired',
        title: 'Plano vencido',
        message: 'Seu plano ' + planName + ' venceu. Renove para continuar com todos os recursos.',
        expiresAt: paid.expires_at || null,
        actionHref: '/perfil.html',
        actionText: 'Ver meu plano'
      };
    }

    if (paid.active && Number(paid.days_left || 0) === 1) {
      return {
        empresaId: empresaId,
        key: 'paid-due-1:' + String(paid.expires_at || 'none'),
        kind: 'paid-due-1',
        variant: 'strong',
        iconKind: 'strong',
        title: 'Plano vence amanhã',
        message: 'Seu plano ' + planName + ' vence amanhã. Renove para evitar bloqueio de recursos.',
        expiresAt: paid.expires_at || null,
        actionHref: '/perfil.html',
        actionText: 'Ver meu plano'
      };
    }

    if (paid.active && Number(paid.days_left || 0) === 3) {
      return {
        empresaId: empresaId,
        key: 'paid-due-3:' + String(paid.expires_at || 'none'),
        kind: 'paid-due-3',
        variant: 'strong',
        iconKind: 'strong',
        title: 'Plano vence em 3 dias',
        message: 'Seu plano ' + planName + ' vence em 3 dias.',
        expiresAt: paid.expires_at || null,
        actionHref: '/perfil.html',
        actionText: 'Ver meu plano'
      };
    }

    if (paid.active && Number(paid.days_left || 0) === 5) {
      return {
        empresaId: empresaId,
        key: 'paid-due-5:' + String(paid.expires_at || 'none'),
        kind: 'paid-due-5',
        variant: 'warning',
        iconKind: 'warning',
        title: 'Plano vence em 5 dias',
        message: 'Seu plano ' + planName + ' vence em 5 dias.',
        expiresAt: paid.expires_at || null,
        actionHref: '/perfil.html',
        actionText: 'Ver meu plano'
      };
    }

    if (paid.show_due_alert || paid.expiring_soon) {
      var daysLeft = Number(paid.days_left || 0);
      if (daysLeft > 0) {
        return {
          empresaId: empresaId,
          key: 'paid-due-generic:' + String(daysLeft) + ':' + String(paid.expires_at || 'none'),
          kind: 'paid-warning',
          variant: daysLeft <= 3 ? 'strong' : 'warning',
          iconKind: daysLeft <= 3 ? 'strong' : 'warning',
          title: 'Vencimento próximo',
          message: daysLeft === 1
            ? 'Seu plano ' + planName + ' vence amanhã.'
            : 'Seu plano ' + planName + ' vence em ' + daysLeft + ' ' + pluralDia(daysLeft) + '.',
          expiresAt: paid.expires_at || null,
          actionHref: '/perfil.html',
          actionText: 'Ver meu plano'
        };
      }
    }

    if (trial.active && Number(trial.days_left || 0) === 1) {
      return {
        empresaId: empresaId,
        key: 'trial-due-1:' + String(trial.expires_at || 'none'),
        kind: 'trial-due-1',
        variant: 'trial',
        iconKind: 'trial',
        title: 'Trial termina amanhã',
        message: 'Seu trial ' + String(trial.tier || '') + ' termina amanhã.',
        expiresAt: trial.expires_at || null,
        actionHref: '/perfil.html',
        actionText: 'Ver meu plano'
      };
    }

    if (trial.active && Number(trial.days_left || 0) === 3) {
      return {
        empresaId: empresaId,
        key: 'trial-due-3:' + String(trial.expires_at || 'none'),
        kind: 'trial-due-3',
        variant: 'trial',
        iconKind: 'trial',
        title: 'Trial termina em 3 dias',
        message: 'Seu trial ' + String(trial.tier || '') + ' termina em 3 dias.',
        expiresAt: trial.expires_at || null,
        actionHref: '/perfil.html',
        actionText: 'Ver meu plano'
      };
    }

    return null;
  }

  async function fetchPlanStatusGlobal() {
    if (__PLAN_ALERT_BOOTED__) return;
    __PLAN_ALERT_BOOTED__ = true;

    if (isPublicLikePage()) return;

    var empresaId = currentEmpresaId();
    if (!empresaId) return;

    try {
      var res = await fetch(
        bust('/api/empresas/' + encodeURIComponent(empresaId) + '/whatsapp'),
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-cache',
          headers: { 'Accept': 'application/json' }
        }
      );

      if (!res.ok) {
        if (res.status !== 401 && res.status !== 403) {
          console.warn('[notif] Falha ao buscar status do plano:', res.status);
        }
        emitNotificationsUpdated(empresaId);
        return;
      }

      var data = await res.json();
      var state = buildPlanAlertState(data, empresaId);

      if (state) {
        pushToHistory(state);
        showPlanToast(state);
      } else {
        emitNotificationsUpdated(empresaId);
      }
    } catch (e) {
      emitNotificationsUpdated(empresaId);
      console.warn('[notif] Erro ao buscar alerta global de plano:', e);
    }
  }

  function bootWhenReady() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        fetchPlanStatusGlobal();
      }, { once: true });
    } else {
      fetchPlanStatusGlobal();
    }
  }

  window.PlanNotifications = {
    refresh: function() {
      __PLAN_ALERT_BOOTED__ = false;
      fetchPlanStatusGlobal();
    },

    show: function(state) {
      if (!state) return;
      if (!state.empresaId) state.empresaId = currentEmpresaId();
      pushToHistory(state);
      showPlanToast(state);
    },

    dismissAll: function() {
      dismissAllToasts();
    },

    getHistory: function() {
      return loadHistory(currentEmpresaId());
    },

    getUnreadCount: function() {
      return loadUnread(currentEmpresaId());
    },

    clearUnread: function() {
      var empresaId = currentEmpresaId();
      saveUnread(empresaId, 0);
      emitNotificationsUpdated(empresaId);
    },

    markAllRead: function() {
      var empresaId = currentEmpresaId();
      saveUnread(empresaId, 0);
      emitNotificationsUpdated(empresaId);
    },

    clearAll: function() {
      var empresaId = currentEmpresaId();
      saveHistory(empresaId, []);
      saveUnread(empresaId, 0);
      emitNotificationsUpdated(empresaId);
    }
  };

  bootWhenReady();
})();