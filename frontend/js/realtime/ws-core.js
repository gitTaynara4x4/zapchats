/*frontend/js/realtime/ws-core.js*/

/* ws-core.js — gestor único de WebSockets com idempotência forte
   ✅ singleton global mesmo com import ?_v=
   ✅ não usa localStorage/sessionStorage para cid
   ✅ evita reconexão duplicada/stale close
   ✅ envia empresa_id/token na query como fallback
   ✅ garante cookie empresa_id quando existir em window/localStorage
   ✅ logs opcionais com window.DEBUG_WS_CORE = true
*/

const ROOT = window.__ZC_WS_CORE__ || (window.__ZC_WS_CORE__ = {
  topics: new Map(),
  cid: null,
});

const _topics = ROOT.topics;

const _baseRetry = 800;
const _maxRetry = 10000;
const _pingEach = 30000;

function _debug(...args) {
  try {
    if (window.DEBUG_WS_CORE === true || window.DEBUG_WS === true) {
      console.debug('[ws-core]', ...args);
    }
  } catch {}
}

function _warn(...args) {
  try {
    if (window.DEBUG_WS_CORE === true || window.DEBUG_WS === true) {
      console.warn('[ws-core]', ...args);
    }
  } catch {}
}

function _newCID() {
  try {
    return (
      crypto?.randomUUID?.() ||
      `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
    );
  } catch {
    return `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }
}

function _getCID() {
  try {
    if (ROOT.cid) return ROOT.cid;

    if (window.__ZC_WS_CID__) {
      ROOT.cid = window.__ZC_WS_CID__;
      return ROOT.cid;
    }

    const cid = _newCID();
    ROOT.cid = cid;
    window.__ZC_WS_CID__ = cid;
    return cid;
  } catch {
    return `cid-${_newCID()}`;
  }
}

function _topicState(topic) {
  let st = _topics.get(topic);

  if (!st) {
    st = {
      ws: null,
      listeners: new Set(),
      wantOpen: false,
      lastOpenAt: 0,
      retries: 0,
      hbTimer: null,
      reopenTimer: null,
      openSeq: 0,
      _opts: {},
    };

    _topics.set(topic, st);
  }

  return st;
}

function _jitter(ms) {
  const delta = Math.round(ms * 0.2);
  return ms + Math.round((Math.random() * 2 - 1) * delta);
}

function _clearReopen(topic) {
  const st = _topicState(topic);

  if (st.reopenTimer) {
    clearTimeout(st.reopenTimer);
    st.reopenTimer = null;
  }
}

function _scheduleReopen(topic) {
  const st = _topicState(topic);
  if (!st.wantOpen) return;
  if (st.reopenTimer) return;

  const wait = Math.min(
    _baseRetry * Math.max(1, Math.pow(1.6, st.retries || 0)),
    _maxRetry
  );

  const withJitter = Math.max(250, _jitter(wait));

  st.reopenTimer = setTimeout(() => {
    st.reopenTimer = null;

    if (!st.wantOpen) return;

    const current = st.ws;
    if (
      current &&
      (
        current.readyState === WebSocket.CONNECTING ||
        current.readyState === WebSocket.OPEN
      )
    ) {
      return;
    }

    _open(topic, st._opts || {});
  }, withJitter);

  st.retries = Math.min((st.retries || 0) + 1, 20);
}

function _safeGetLS(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function _readCookie(name) {
  try {
    const parts = String(document.cookie || '').split(';');
    const prefix = `${name}=`;

    for (const part of parts) {
      const p = part.trim();
      if (p.startsWith(prefix)) {
        return decodeURIComponent(p.slice(prefix.length));
      }
    }
  } catch {}

  return '';
}

function _setCookie(name, value) {
  try {
    const v = String(value || '').trim();
    if (!v) return;

    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(v)}; Path=/; SameSite=Lax${secure}`;
  } catch {}
}

function _empresaIdFromTopic(topic) {
  try {
    const s = String(topic || '').trim();
    const m = s.match(/^emp:(\d+)$/i);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function _getEmpresaId(topic = '') {
  const fromTopic = _empresaIdFromTopic(topic);
  if (fromTopic) return fromTopic;

  const candidates = [
    window.EMPRESA_ID,
    window.APP_EMPRESA_ID,
    window.empresa_id,
    _safeGetLS('empresa_id'),
    _safeGetLS('EMPRESA_ID'),
  ];

  for (const c of candidates) {
    const s = String(c ?? '').trim();
    if (/^\d+$/.test(s) && Number(s) > 0) return s;
  }

  return '';
}

function _getToken() {
  const cookieToken = _readCookie('access_token');
  if (cookieToken) return cookieToken;

  const candidates = [
    _safeGetLS('access_token'),
    _safeGetLS('token'),
    window.access_token,
    window.ACCESS_TOKEN,
  ];

  for (const c of candidates) {
    const s = String(c ?? '').trim();
    if (s) return s;
  }

  return '';
}

function _ensureEmpresaCookie(topic) {
  const empresaId = _getEmpresaId(topic);
  if (!empresaId) return;

  const current = _readCookie('empresa_id') || _readCookie('EMPRESA_ID');

  if (!current || String(current) !== String(empresaId)) {
    _setCookie('empresa_id', empresaId);
  }
}

function _wsURLForTopic(topic, opts = {}) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const enc = encodeURIComponent(topic);
  const cid = _getCID();

  _ensureEmpresaCookie(topic);

  const qs = new URLSearchParams();
  qs.set('cid', cid);

  const empresaId = _getEmpresaId(topic);
  if (empresaId) qs.set('empresa_id', empresaId);

  const token = _getToken();
  if (token) qs.set('token', token);

  if (opts.wantQR) qs.set('want_qr', '1');

  return `${proto}://${location.host}/ws/${enc}?${qs.toString()}`;
}

function _safeJson(x) {
  try {
    return JSON.parse(x);
  } catch {
    return null;
  }
}

function _emit(topic, payload) {
  const st = _topicState(topic);

  st.listeners.forEach((fn) => {
    try {
      fn(payload);
    } catch {}
  });

  try {
    window.dispatchEvent(new CustomEvent('zc:ws-core', {
      detail: {
        topic,
        payload,
      },
    }));
  } catch {}
}

function _startHB(topic) {
  const st = _topicState(topic);

  clearInterval(st.hbTimer);

  st.hbTimer = setInterval(() => {
    try {
      if (st.ws && st.ws.readyState === WebSocket.OPEN) {
        st.ws.send('ping');
      }
    } catch {}
  }, _pingEach);
}

function _stopHB(topic) {
  const st = _topicState(topic);

  clearInterval(st.hbTimer);
  st.hbTimer = null;
}

function _open(topic, opts = {}) {
  const st = _topicState(topic);

  if (!st.wantOpen) {
    st.wantOpen = true;
  }

  if (
    st.ws &&
    (
      st.ws.readyState === WebSocket.CONNECTING ||
      st.ws.readyState === WebSocket.OPEN
    )
  ) {
    st._opts = opts;
    return;
  }

  _clearReopen(topic);

  try {
    st.ws?.close?.();
  } catch {}

  const seq = (st.openSeq || 0) + 1;
  st.openSeq = seq;

  const url = _wsURLForTopic(topic, opts);
  const ws = new WebSocket(url);

  st.ws = ws;
  st.lastOpenAt = Date.now();
  st._opts = opts;

  _debug('abrindo', {
    topic,
    url: url.replace(/token=([^&]+)/, 'token=***'),
    seq,
  });

  ws.addEventListener('open', () => {
    if (st.ws !== ws || st.openSeq !== seq) return;

    st.retries = 0;
    _clearReopen(topic);
    _startHB(topic);

    _debug('open', { topic, seq });

    _emit(topic, {
      type: 'open',
      topic,
      readyState: ws.readyState,
    });
  });

  ws.addEventListener('close', (ev) => {
    if (st.ws !== ws || st.openSeq !== seq) return;

    _stopHB(topic);

    _warn('close', {
      topic,
      code: ev?.code,
      reason: ev?.reason,
      wasClean: ev?.wasClean,
      seq,
    });

    _emit(topic, {
      type: 'close',
      topic,
      code: ev?.code,
      reason: ev?.reason,
      wasClean: ev?.wasClean,
    });

    st.ws = null;

    if (st.wantOpen) {
      _scheduleReopen(topic);
    }
  });

  ws.addEventListener('error', (ev) => {
    if (st.ws !== ws || st.openSeq !== seq) return;

    _warn('error', {
      topic,
      seq,
      ev,
    });

    try {
      ws.close();
    } catch {}

    _emit(topic, {
      type: 'error',
      topic,
      ev,
    });
  });

  ws.addEventListener('message', (ev) => {
    if (st.ws !== ws || st.openSeq !== seq) return;

    if (
      typeof ev?.data === 'string' &&
      (ev.data === 'pong' || ev.data === 'ping')
    ) {
      _emit(topic, {
        type: 'heartbeat',
        topic,
        data: ev.data,
      });
      return;
    }

    const data = typeof ev?.data === 'string'
      ? _safeJson(ev.data)
      : ev?.data;

    _debug('message', {
      topic,
      data,
    });

    _emit(topic, {
      type: 'message',
      topic,
      data,
    });
  });
}

function _ensure(topic, opts = {}) {
  const st = _topicState(topic);

  st.wantOpen = true;
  st._opts = opts;

  if (
    st.ws &&
    (
      st.ws.readyState === WebSocket.CONNECTING ||
      st.ws.readyState === WebSocket.OPEN
    )
  ) {
    return;
  }

  if (st.reopenTimer) {
    return;
  }

  const now = Date.now();

  if (st.lastOpenAt && (now - st.lastOpenAt) < 1200) {
    _scheduleReopen(topic);
    return;
  }

  _open(topic, opts);
}

function _close(topic) {
  const st = _topicState(topic);

  st.wantOpen = false;
  _clearReopen(topic);
  _stopHB(topic);

  try {
    st.ws?.close?.();
  } catch {}

  st.ws = null;

  _emit(topic, {
    type: 'closed-by-client',
    topic,
  });
}

function _on(topic, fn) {
  const st = _topicState(topic);

  st.listeners.add(fn);

  return () => {
    try {
      st.listeners.delete(fn);
    } catch {}
  };
}

/* ====== API pública ====== */

export function ensureEmpresaWS(empresaId) {
  const id = String(empresaId || '').trim();
  if (!id) return;

  try {
    window.APP_EMPRESA_ID = id;
    window.EMPRESA_ID = window.EMPRESA_ID || id;
    _setCookie('empresa_id', id);
  } catch {}

  _ensure(`emp:${id}`);
}

export function closeEmpresaWS(empresaId) {
  const id = String(empresaId || '').trim();
  if (!id) return;

  _close(`emp:${id}`);
}

export function onEmpresaMessage(empresaId, handler) {
  const id = String(empresaId || '').trim();
  if (!id || typeof handler !== 'function') return () => {};

  return _on(`emp:${id}`, handler);
}

export function ensureInstWS(instance, opts = {}) {
  const inst = String(instance || '').trim();
  if (!inst) return;

  _ensure(`inst:${inst}`, opts);
}

export function closeInstWS(instance) {
  const inst = String(instance || '').trim();
  if (!inst) return;

  _close(`inst:${inst}`);
}

export function onInstMessage(instance, handler) {
  const inst = String(instance || '').trim();
  if (!inst || typeof handler !== 'function') return () => {};

  return _on(`inst:${inst}`, handler);
}

export function getWSStatus() {
  const out = {};

  _topics.forEach((st, topic) => {
    out[topic] = {
      open: !!(st.ws && st.ws.readyState === WebSocket.OPEN),
      connecting: !!(st.ws && st.ws.readyState === WebSocket.CONNECTING),
      readyState: st.ws ? st.ws.readyState : -1,
      wantOpen: !!st.wantOpen,
      listeners: st.listeners.size,
      lastOpenAt: st.lastOpenAt,
      retries: st.retries || 0,
      hasReopenTimer: !!st.reopenTimer,
      cid: ROOT.cid || window.__ZC_WS_CID__ || null,
    };
  });

  return out;
}

export function closeAllWS() {
  Array.from(_topics.keys()).forEach((topic) => {
    try {
      _close(topic);
    } catch {}
  });
}

// Fecha sockets imediatamente quando uma página do app sinaliza saída.
// Isso evita conexão WS/fila de retry viva competindo com a próxima navegação.
try {
  if (!window.__ZC_WS_CORE_LIFECYCLE_CLOSE_BOUND__) {
    window.__ZC_WS_CORE_LIFECYCLE_CLOSE_BOUND__ = true;
    const closeBecauseLeaving = () => {
      try { closeAllWS(); } catch {}
    };
    window.addEventListener('zc:navigate-away', closeBecauseLeaving, true);
    window.addEventListener('pagehide', closeBecauseLeaving, true);
    window.addEventListener('beforeunload', closeBecauseLeaving, true);
  }
} catch {}

/* Debug manual no console:
   window.ZC_WS_CORE_STATUS()
*/
try {
  window.ZC_WS_CORE_STATUS = getWSStatus;
  window.ZC_CLOSE_ALL_WS = closeAllWS;
} catch {}