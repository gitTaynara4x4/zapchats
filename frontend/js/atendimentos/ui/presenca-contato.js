/* ====================================================================
 * ZapsChat – presença do contato no cabeçalho
 * Mostra: online, digitando, gravando áudio e visto por último.
 * ==================================================================== */
(function () {
  'use strict';

  if (window.__ZC_CONTACT_PRESENCE_LOADED__) return;
  window.__ZC_CONTACT_PRESENCE_LOADED__ = true;

  const VERSION = 'zc-contact-presence-v1';
  const DEFAULT_TTL_SECONDS = 120;
  const ACTIVITY_TTL_SECONDS = 10;

  let current = null;
  let currentPresence = null;
  let requestSeq = 0;
  let requestController = null;

  function asInt(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  function presenceEl() {
    return document.getElementById('chat-presenca');
  }

  function parseConversationKey(raw) {
    const value = String(raw || '').trim();
    const match = value.match(/^([cg]):(\d+):(\d+)$/i);
    if (!match) return null;
    return {
      key: `${match[1].toLowerCase()}:${Number(match[2])}:${Number(match[3])}`,
      kind: match[1].toLowerCase(),
      entityId: Number(match[2]),
      instanciaId: Number(match[3]),
    };
  }

  function refFromDetail(detail) {
    const d = detail && typeof detail === 'object' ? detail : {};
    const parsed = parseConversationKey(d.conversation_key || d.conversation_id);
    if (parsed) return parsed;

    const kindRaw = String(d.kind || d.tipo || 'c').toLowerCase();
    const kind = kindRaw.startsWith('g') ? 'g' : 'c';
    const entityId = asInt(d.entity_id ?? d.cliente_id ?? d.id);
    const instanciaId = asInt(d.instancia_id ?? d.instance_id);
    if (!entityId || !instanciaId) return null;

    return {
      key: `${kind}:${entityId}:${instanciaId}`,
      kind,
      entityId,
      instanciaId,
    };
  }

  function dateFrom(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function hhmm(date) {
    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }

  function formatLastSeen(value) {
    const seen = dateFrom(value);
    if (!seen) return '';

    const now = new Date();
    const today = startOfLocalDay(now);
    const seenDay = startOfLocalDay(seen);
    const dayDiff = Math.round((today.getTime() - seenDay.getTime()) / 86400000);
    const time = hhmm(seen);

    if (dayDiff === 0) return `visto por último hoje às ${time}`;
    if (dayDiff === 1) return `visto por último ontem às ${time}`;

    const sameYear = seen.getFullYear() === now.getFullYear();
    const dateText = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      ...(sameYear ? {} : { year: 'numeric' }),
    }).format(seen);

    return `visto por último em ${dateText} às ${time}`;
  }

  function normalizedPresence(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const status = String(
      p.presence_status ?? p.status ?? p.presence ?? ''
    ).trim().toLowerCase();

    return {
      status,
      online: Boolean(p.presence_online ?? p.online),
      lastSeen: p.presence_last_seen ?? p.last_seen ?? p.lastSeen ?? null,
      updatedAt: p.presence_updated_at ?? p.updated_at ?? p.updatedAt ?? null,
      ttlSeconds: Math.max(
        30,
        Number(p.presence_ttl_seconds ?? p.ttl_seconds ?? DEFAULT_TTL_SECONDS) || DEFAULT_TTL_SECONDS
      ),
    };
  }

  function effectiveState(presence) {
    const p = normalizedPresence(presence);
    const updated = dateFrom(p.updatedAt);
    const ageSeconds = updated ? Math.max(0, (Date.now() - updated.getTime()) / 1000) : Infinity;
    const online = Boolean(p.online && ageSeconds <= p.ttlSeconds);

    let status = p.status;
    if ((status === 'composing' || status === 'recording') && ageSeconds > ACTIVITY_TTL_SECONDS) {
      status = online ? 'available' : 'unavailable';
    }

    let lastSeen = p.lastSeen;
    if (!online && updated) {
      const official = dateFrom(lastSeen);
      if (!official || updated.getTime() > official.getTime()) {
        lastSeen = updated.toISOString();
      }
    }

    return { ...p, status, online, lastSeen, updated, ageSeconds };
  }

  function hide() {
    const el = presenceEl();
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('is-online', 'is-activity');
    el.removeAttribute('title');
  }

  function render() {
    const el = presenceEl();
    if (!el || !current || current.kind !== 'c') {
      hide();
      return;
    }

    const state = effectiveState(currentPresence);
    let text = '';
    let activity = false;

    if (state.online) {
      if (state.status === 'composing') {
        text = 'digitando...';
        activity = true;
      } else if (state.status === 'recording') {
        text = 'gravando áudio...';
        activity = true;
      } else {
        text = 'online';
      }
    } else {
      text = formatLastSeen(state.lastSeen);
    }

    if (!text) {
      hide();
      return;
    }

    el.textContent = text;
    el.hidden = false;
    el.classList.toggle('is-online', state.online && !activity);
    el.classList.toggle('is-activity', activity);

    const exact = dateFrom(state.lastSeen || state.updatedAt);
    if (exact) {
      el.title = exact.toLocaleString('pt-BR');
    } else {
      el.removeAttribute('title');
    }
  }

  function sameCurrent(detail) {
    if (!current || !detail) return false;
    const key = parseConversationKey(detail.conversation_key || detail.conversation_id);
    if (key?.key) return key.key === current.key;

    const clienteId = asInt(detail.cliente_id ?? detail.entity_id);
    const instanciaId = asInt(detail.instancia_id ?? detail.instance_id);
    return clienteId === current.entityId && instanciaId === current.instanciaId;
  }

  async function fetchCurrentPresence() {
    if (!current || current.kind !== 'c') return;

    const mySeq = ++requestSeq;
    try { requestController?.abort(); } catch (_) {}
    requestController = typeof AbortController !== 'undefined' ? new AbortController() : null;

    const url =
      `/api/atendimento/conversas/${encodeURIComponent(current.entityId)}/meta` +
      `?instancia_id=${encodeURIComponent(current.instanciaId)}`;

    try {
      const response = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: requestController?.signal,
      });

      if (!response.ok) return;
      const payload = await response.json();
      if (mySeq !== requestSeq || !current) return;

      currentPresence = normalizedPresence(payload);
      render();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.debug('[ZapsChat][presenca] meta indisponível', error);
      }
    }
  }

  function onConversationSelected(event) {
    const ref = refFromDetail(event?.detail);
    current = ref;
    currentPresence = null;
    requestSeq += 1;
    try { requestController?.abort(); } catch (_) {}
    requestController = null;
    hide();

    if (current?.kind === 'c') {
      fetchCurrentPresence();
    }
  }

  function onPresenceUpdate(event) {
    const detail = event?.detail && typeof event.detail === 'object'
      ? event.detail
      : event;
    if (!sameCurrent(detail)) return;

    currentPresence = normalizedPresence(detail);
    render();
  }

  window.addEventListener('zc:conversation-selected', onConversationSelected);
  window.addEventListener('zc:presence-update', onPresenceUpdate);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && current?.kind === 'c') {
      fetchCurrentPresence();
    }
  });

  // Atualiza o texto relativo e expira um "online" caso o evento de offline
  // não seja entregue pela Evolution.
  setInterval(render, 15000);

  window.ZCContactPresence = Object.freeze({
    version: VERSION,
    refresh: fetchCurrentPresence,
    render,
    current: () => (current ? { ...current } : null),
    state: () => (currentPresence ? { ...currentPresence } : null),
  });

  console.log(`[ZapsChat][presenca-contato] carregado: ${VERSION}`);
})();
