(function NotificacoesPage() {
  'use strict';

  var listEl = null;
  var totalEl = null;
  var unreadEl = null;
  var refreshBtn = null;
  var markReadBtn = null;
  var clearBtn = null;

  function qs(sel) {
    return document.querySelector(sel);
  }

  function getCookie(name) {
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

  function empresaId() {
    return getCookie('empresa_id') || getCookie('EMPRESA_ID') || '0';
  }

  function historyKey() {
    return 'plan_notif:' + String(empresaId()) + ':history';
  }

  function unreadKey() {
    return 'plan_notif:' + String(empresaId()) + ':unread';
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

  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function iconSvg(kind) {
    var map = {
      warning:
        '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>' +
          '<line x1="12" y1="9" x2="12" y2="13"></line>' +
          '<line x1="12" y1="17" x2="12.01" y2="17"></line>' +
        '</svg>',

      strong:
        '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M13 2L3 14h9l-1 8 10-14h-9l1-8z"></path>' +
        '</svg>',

      expired:
        '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="12" cy="12" r="10"></circle>' +
          '<line x1="15" y1="9" x2="9" y2="15"></line>' +
          '<line x1="9" y1="9" x2="15" y2="15"></line>' +
        '</svg>',

      trial:
        '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="12" cy="12" r="10"></circle>' +
          '<polyline points="12 6 12 12 16 14"></polyline>' +
        '</svg>'
    };

    return map[kind] || map.warning;
  }

  function labelVariant(variant) {
    if (variant === 'expired') return 'Crítico';
    if (variant === 'strong') return 'Importante';
    if (variant === 'trial') return 'Trial';
    return 'Aviso';
  }

  function readHistory() {
    if (window.PlanNotifications && typeof window.PlanNotifications.getHistory === 'function') {
      return window.PlanNotifications.getHistory() || [];
    }
    return safeReadJson(historyKey(), []);
  }

  function readUnread() {
    if (window.PlanNotifications && typeof window.PlanNotifications.getUnreadCount === 'function') {
      return Number(window.PlanNotifications.getUnreadCount() || 0);
    }
    return Number(safeReadJson(unreadKey(), 0) || 0);
  }

  function writeUnread(count) {
    safeWriteJson(unreadKey(), Math.max(0, Number(count || 0)));
  }

  function writeHistory(items) {
    safeWriteJson(historyKey(), items || []);
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      return '';
    }
  }

  function renderEmpty() {
    listEl.innerHTML = ''
      + '<article class="notif-empty">'
      +   '<div class="notif-empty__icon" aria-hidden="true">'
      +     '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      +       '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>'
      +       '<line x1="16" y1="2" x2="16" y2="6"></line>'
      +       '<line x1="8" y1="2" x2="8" y2="6"></line>'
      +       '<line x1="3" y1="10" x2="21" y2="10"></line>'
      +     '</svg>'
      +   '</div>'
      +   '<h2>Nenhuma notificação ainda</h2>'
      +   '<p>Quando surgir um aviso importante, ele vai aparecer aqui.</p>'
      + '</article>';
  }

  function render() {
    if (!listEl) return;

    var items = readHistory();
    var unread = readUnread();

    if (totalEl) totalEl.textContent = String(items.length);
    if (unreadEl) unreadEl.textContent = String(unread);

    if (!items.length) {
      renderEmpty();
      return;
    }

    listEl.innerHTML = items.map(function(it) {
      var variant = it.variant || 'warning';
      var href = it.actionHref || '/meu-plano.html';
      var text = it.actionText || 'Ver meu plano';

      return ''
        + '<article class="notif-card notif-card--' + escapeHtml(variant) + '">'
        +   '<div class="notif-card__top">'
        +     '<div class="notif-card__icon" aria-hidden="true">' + iconSvg(it.iconKind || variant) + '</div>'
        +     '<div class="notif-card__meta">'
        +       '<h3 class="notif-card__title">' + escapeHtml(it.title || 'Notificação') + '</h3>'
        +       '<div class="notif-card__sub">'
        +         '<span class="notif-chip notif-chip--' + escapeHtml(variant) + '">' + escapeHtml(labelVariant(variant)) + '</span>'
        +         '<span class="notif-card__date">' + escapeHtml(formatDate(it.created_at || '')) + '</span>'
        +       '</div>'
        +     '</div>'
        +   '</div>'
        +   '<p class="notif-card__text">' + escapeHtml(it.message || '') + '</p>'
        +   '<div class="notif-card__actions">'
        +     '<a class="notif-card__btn" href="' + escapeHtml(href) + '">' + escapeHtml(text) + '</a>'
        +   '</div>'
        + '</article>';
    }).join('');
  }

  function markAllRead() {
    if (window.PlanNotifications && typeof window.PlanNotifications.markAllRead === 'function') {
      window.PlanNotifications.markAllRead();
    } else if (window.PlanNotifications && typeof window.PlanNotifications.clearUnread === 'function') {
      window.PlanNotifications.clearUnread();
    } else {
      writeUnread(0);
    }
    render();
  }

  function clearAll() {
    if (window.PlanNotifications && typeof window.PlanNotifications.clearAll === 'function') {
      window.PlanNotifications.clearAll();
    } else {
      writeHistory([]);
      writeUnread(0);
    }
    render();
  }

  function refreshAll() {
    if (window.PlanNotifications && typeof window.PlanNotifications.refresh === 'function') {
      window.PlanNotifications.refresh();
    }
    setTimeout(render, 250);
    setTimeout(render, 900);
  }

  function bind() {
    if (refreshBtn) {
      refreshBtn.addEventListener('click', refreshAll);
    }

    if (markReadBtn) {
      markReadBtn.addEventListener('click', markAllRead);
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', clearAll);
    }

    document.addEventListener('plan-notifications:updated', function() {
      render();
    });

    window.addEventListener('storage', function(e) {
      if (!e.key) return;
      if (e.key.indexOf('plan_notif:') === 0) {
        render();
      }
    });
  }

  function init() {
    listEl = qs('#notifList');
    totalEl = qs('#notifTotalCount');
    unreadEl = qs('#notifUnreadCount');
    refreshBtn = qs('#notifRefreshBtn');
    markReadBtn = qs('#notifMarkReadBtn');
    clearBtn = qs('#notifClearBtn');

    bind();
    render();

    setTimeout(render, 400);
    setTimeout(render, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();