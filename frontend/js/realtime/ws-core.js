/*frontend\js\realtime\ws-core.js*/

/* ws-core.js — gestor único de WebSockets com idempotência forte
   ✅ FIX: não usa localStorage/sessionStorage para cid
   ✅ FIX: estado global compartilhado mesmo se o módulo for importado mais de uma vez
   ✅ FIX: evita reconexão duplicada/stale close
*/

const ROOT = window.__ZC_WS_CORE__ || (window.__ZC_WS_CORE__ = {
  topics: new Map(),
  cid: null,
});

const _topics = ROOT.topics; // topic -> { ws, listeners:Set, wantOpen, lastOpenAt, retries, hbTimer, reopenTimer, openSeq, _opts }

const _baseRetry = 800;    // ms
const _maxRetry  = 10000;  // ms
const _pingEach  = 30000;  // ms (ping app-level)

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
  // IMPORTANTE:
  // Não usar localStorage/sessionStorage.
  // localStorage/sessionStorage mantém o mesmo cid entre páginas/abas e causa briga no backend.
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

function _wsURLForTopic(topic, opts = {}) {
  const proto = (location.protocol === 'https:') ? 'wss' : 'ws';
  const enc = encodeURIComponent(topic);
  const cid = _getCID();
  const want = opts.wantQR ? '&want_qr=1' : '';

  return `${proto}://${location.host}/ws/${enc}?cid=${encodeURIComponent(cid)}${want}`;
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

  ws.addEventListener('open', () => {
    if (st.ws !== ws || st.openSeq !== seq) return;

    st.retries = 0;
    _clearReopen(topic);
    _startHB(topic);
    _emit(topic, { type: 'open' });
  });

  ws.addEventListener('close', () => {
    // close antigo não pode derrubar socket novo
    if (st.ws !== ws || st.openSeq !== seq) return;

    _stopHB(topic);
    _emit(topic, { type: 'close' });

    st.ws = null;

    if (st.wantOpen) {
      _scheduleReopen(topic);
    }
  });

  ws.addEventListener('error', () => {
    if (st.ws !== ws || st.openSeq !== seq) return;

    try {
      ws.close();
    } catch {}

    _emit(topic, { type: 'error' });
  });

  ws.addEventListener('message', (ev) => {
    if (st.ws !== ws || st.openSeq !== seq) return;

    if (
      typeof ev?.data === 'string' &&
      (ev.data === 'pong' || ev.data === 'ping')
    ) {
      _emit(topic, { type: 'heartbeat', data: ev.data });
      return;
    }

    const data = typeof ev?.data === 'string'
      ? _safeJson(ev.data)
      : ev?.data;

    _emit(topic, { type: 'message', data });
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

  // anti-rajada: se acabou de tentar abrir, agenda em vez de abrir na força
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
  if (!empresaId) return;
  _ensure(`emp:${empresaId}`);
}

export function closeEmpresaWS(empresaId) {
  if (!empresaId) return;
  _close(`emp:${empresaId}`);
}

export function onEmpresaMessage(empresaId, handler) {
  if (!empresaId || typeof handler !== 'function') return () => {};
  return _on(`emp:${empresaId}`, handler);
}

export function ensureInstWS(instance, opts = {}) {
  if (!instance) return;
  _ensure(`inst:${instance}`, opts);
}

export function closeInstWS(instance) {
  if (!instance) return;
  _close(`inst:${instance}`);
}

export function onInstMessage(instance, handler) {
  if (!instance || typeof handler !== 'function') return () => {};
  return _on(`inst:${instance}`, handler);
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