// /frontend/js/atendimentos/domain/historico.js
// Histórico com carregamento leve + aviso clicável para mensagens antigas
// ✅ Não carrega histórico antigo sozinho ao chegar no topo
// ✅ Mostra aviso estilo WhatsApp Web: "Clique neste aviso para carregar mensagens mais antigas"
// ✅ Mostra loader dentro da conversa ANTES de consultar o banco quando não acha cache
// ✅ Ao carregar mensagens antigas, NÃO volta para o fim da conversa
// ✅ Igual WhatsApp Web: mensagens antigas entram acima sem mexer no que você está vendo
// ✅ Não grava mais cache pesado legado em cacheHistoricos:<empresa>
// ✅ Usa hist-cache.js como cache limitado/leve
// ✅ Render de mídias/áudio fica no media-render.js
// ✅ Divisores de data estilo WhatsApp Web
// ✅ Alinhado com conversation_key canônica:
//    c:<cliente_id>:<instancia_id> e g:<grupo_id>:<instancia_id>
// ✅ Busca backend sempre por entity_id da conversa
// ✅ Resposta/quote renderizada dentro da bolha
// ✅ Trava resposta atrasada para não sobrescrever conversa atual
// ✅ Compat com envio otimista: tmp msg, reloginho, ack, falha, dedupe temp -> real

import { formatChatTime, parseAtendimentoDate } from '../core/time.js';
import { getHist, primeWith, mergeOld } from '../domain/hist-cache.js';
import { EMPRESA_ID } from '../core/env.js';
import { getConversationKey, getConversationEntityId, getConversationKind } from '../state/store.js';

// Media-render dividido
import '../ui/media-render/core.js';
import '../ui/media-render/css.js';
import '../ui/media-render/urls.js';
import '../ui/media-render/avatars.js';
import '../ui/media-render/icons.js';
import '../ui/media-render/audio.js';
import '../ui/media-render/fallbacks.js';
import '../ui/media-render/markers.js';
import '../ui/media-render/gallery.js';
import '../ui/media-render/quoted.js';
import '../ui/media-render/viewer.js';
import '../ui/media-render/render-message.js';
import '../ui/media-render/boot.js';

export const HISTORICO_LIMIT = Number(window.ZC_HIST_PAGE_SIZE || 12);
const HIST_DOM_MAX_ROWS = Number(window.ZC_HIST_DOM_MAX_ROWS || 160);

const H = () => document.getElementById('historico');

const INITIAL_LOADING_TEXT = 'Carregando mensagens do banco…';
const OLD_NOTICE_TEXT = 'Clique neste aviso para carregar mensagens mais antigas.';
const OLD_LOADING_TEXT = 'Carregando mensagens mais antigas…';
const OLD_DONE_TEXT = 'Não há mensagens mais antigas para carregar.';
const OLD_ERROR_TEXT = 'Não foi possível carregar mensagens antigas. Clique para tentar novamente.';

/* =====================
   PAINT HELPER
   ===================== */

function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

/* =====================
   DEBUG
   ===================== */
function isHistDebug() {
  try {
    return window.HIST_DEBUG === true;
  } catch {
    return false;
  }
}

function HLOG(...args) {
  try {
    if (isHistDebug() && console?.log) console.log('[historico]', ...args);
  } catch {}
}

function HERR(...args) {
  try {
    if (isHistDebug() && console?.error) console.error('[historico][ERRO]', ...args);
  } catch {}
}

/* =====================
   Conversation helpers
   ===================== */
const idKey = (v) => {
  const s = String(v ?? '').trim();
  if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
  return s;
};

const idEq = (a, b) => idKey(a) === idKey(b);

function instKey(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (['null', 'undefined', 'nan', '0', 'all', '*', '-'].includes(s.toLowerCase())) return null;
  return s;
}

function parseConversationKey(raw) {
  const s = idKey(raw);
  if (!s) return null;

  const m = s.match(/^([cg]):(\d+):([^:]+)$/i);
  if (!m) return null;

  return {
    key: `${m[1].toLowerCase()}:${m[2]}:${m[3]}`,
    kind: m[1].toLowerCase(),
    entityId: m[2],
    instId: instKey(m[3]),
  };
}

function buildConversationKey(kind, entityId, instId) {
  const k = String(kind || '').toLowerCase() === 'g' ? 'g' : 'c';
  const eid = idKey(entityId);
  const iid = instKey(instId);

  if (!eid) return null;

  return `${k}:${eid}:${iid ?? '0'}`;
}

function currentSelectedRow() {
  try {
    return window.state?.clienteSel || window.clienteSel || null;
  } catch {
    return null;
  }
}

function normalizeRawConversation(raw = null, row = null) {
  if (raw && typeof raw === 'object') {
    const obj = raw;

    const candidate =
      obj.conversation_key ??
      obj.conversationKey ??
      obj.conversation_id ??
      obj.conversationId ??
      obj.convKey ??
      obj.id ??
      obj.cliente_id ??
      obj.clienteId ??
      obj.grupo_id ??
      obj.grupoId ??
      null;

    return {
      raw: candidate,
      row: row || obj,
    };
  }

  return {
    raw,
    row,
  };
}

function getHistConversationRef(raw = null, row = null) {
  const hist = H();
  const norm = normalizeRawConversation(raw, row);
  const selected = norm.row || currentSelectedRow();

  const candidate =
    norm.raw ??
    hist?.dataset?.conversationKey ??
    hist?.dataset?.conversationId ??
    hist?.dataset?.convKey ??
    hist?.dataset?.clienteId ??
    selected?.conversation_key ??
    selected?.conversationKey ??
    selected?.conversation_id ??
    selected?.conversationId ??
    selected?.id ??
    null;

  const instCandidate =
    selected?.instancia_id ??
    selected?.instanciaId ??
    selected?.instancia ??
    selected?.instance_id ??
    selected?.instanceId ??
    selected?.instance_name ??
    selected?.instanceName ??
    hist?.dataset?.instanciaId ??
    null;

  const convKey =
    getConversationKey(candidate, selected, instCandidate) ||
    idKey(candidate);

  const parsed = parseConversationKey(convKey);
  if (parsed) return parsed;

  const entityId =
    getConversationEntityId(candidate, selected) ||
    idKey(hist?.dataset?.entityId) ||
    idKey(hist?.dataset?.apiClienteId) ||
    idKey(hist?.dataset?.backendClienteId) ||
    idKey(selected?.entity_id) ||
    idKey(selected?.entityId) ||
    idKey(selected?.backend_id) ||
    idKey(selected?.api_id) ||
    idKey(selected?.cliente_id) ||
    idKey(selected?.clienteId) ||
    idKey(selected?.grupo_id) ||
    idKey(selected?.grupoId) ||
    null;

  const kindRaw =
    getConversationKind(candidate, selected) ||
    idKey(hist?.dataset?.kind) ||
    selected?.kind ||
    selected?.conversation_kind ||
    selected?.tipo_conversa ||
    (selected?.is_group || selected?.grupo_id || selected?.grupoId ? 'g' : 'c');

  const kind = String(kindRaw || 'c').toLowerCase().startsWith('g') ? 'g' : 'c';

  const instId =
    instKey(hist?.dataset?.instanciaId) ||
    instKey(selected?.instancia_id) ||
    instKey(selected?.instanciaId) ||
    instKey(selected?.instancia) ||
    instKey(selected?.instance_id) ||
    instKey(selected?.instanceId) ||
    instKey(selected?.instance_name) ||
    instKey(selected?.instanceName) ||
    null;

  const built = buildConversationKey(kind, entityId, instId) || convKey || '';

  return parseConversationKey(built) || {
    key: built,
    kind,
    entityId,
    instId,
  };
}

function getConversationEntityIdSafe(raw = null, row = null) {
  const ref = getHistConversationRef(raw, row);
  return ref?.entityId || null;
}

function getConversationKeySafe(raw = null, row = null) {
  const ref = getHistConversationRef(raw, row);
  return ref?.key || null;
}

/* =====================
   Trava contra render atrasado
   ===================== */
function getOpenHistKey(hist = H()) {
  return idKey(
    hist?.dataset?.conversationKey ||
    hist?.dataset?.conversationId ||
    hist?.dataset?.convKey ||
    hist?.dataset?.clienteId ||
    null
  );
}

function isHistoricoStillOpenFor(convKey, hist = H()) {
  const expected = idKey(convKey);
  if (!hist || !expected) return false;

  const current = getOpenHistKey(hist);

  if (current && current !== expected) {
    HLOG('render/fetch ignorado: conversa atual mudou', {
      expected,
      current,
    });
    return false;
  }

  return true;
}

function setOpenHistRef(hist, ref) {
  if (!hist || !ref) return;

  hist.dataset.conversationKey = String(ref.key || '');
  hist.dataset.conversationId = String(ref.key || '');
  hist.dataset.convKey = String(ref.key || '');
  hist.dataset.clienteId = String(ref.key || '');
  hist.dataset.entityId = String(ref.entityId || '');
  hist.dataset.kind = String(ref.kind || 'c');

  if (ref.instId) hist.dataset.instanciaId = String(ref.instId);
  else hist.removeAttribute('data-instancia-id');
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.mensagens)) return payload.mensagens;
  if (Array.isArray(payload?.messages)) return payload.messages;
  return [];
}

function sanitizeLightObject(obj, depth = 0) {
  if (obj == null) return obj;

  if (typeof obj === 'string') {
    if (obj.length > 4000) return '';
    if (/^data:/i.test(obj) && obj.length > 1000) return '';
    return obj;
  }

  if (typeof obj !== 'object') return obj;
  if (depth > 3) return null;

  if (Array.isArray(obj)) {
    return obj.slice(0, 20).map((x) => sanitizeLightObject(x, depth + 1)).filter(Boolean);
  }

  const heavyKeys = new Set([
    'base64', 'b64', 'filebase64', 'file_base64', 'media_base64', 'mediaBase64',
    'bodybase64', 'raw', 'buffer', 'bytes', 'binary', 'stream', 'data'
  ]);

  const out = {};
  Object.entries(obj).forEach(([k, v]) => {
    const key = String(k || '').trim().toLowerCase();
    if (heavyKeys.has(key)) return;
    if (typeof v === 'string' && v.length > 4000) return;
    out[k] = sanitizeLightObject(v, depth + 1);
  });

  return out;
}

function safeSmallString(v, max = 3000) {
  if (v == null) return v;
  const s = String(v);
  if (/^data:/i.test(s) && s.length > 400) return '';
  if (s.length > max) return s.slice(0, max) + '…';
  return s;
}

function compactMessageForMemory(m) {
  if (!m || typeof m !== 'object') return m;

  const timestamp =
    m.timestamp ??
    m.data ??
    m.created_at ??
    m.createdAt ??
    m.ts ??
    m.hora ??
    null;

  const msgId =
    m.msg_id ??
    m.msgId ??
    m.message_id ??
    m.messageId ??
    m.wa_msg_id ??
    m.waMsgId ??
    m.id ??
    null;

  const dbId =
    m.db_id ??
    m.mensagem_id ??
    m.message_db_id ??
    m.messageDbId ??
    (m.msg_id ? m.id : null) ??
    null;

  const content =
    m.conteudo ??
    m.mensagem ??
    m.texto ??
    m.body ??
    m.caption ??
    '';

  const out = {
    id: m.id ?? msgId ?? null,
    msg_id: msgId ?? null,
    message_id: msgId ?? null,
    wa_msg_id: m.wa_msg_id ?? m.waMsgId ?? msgId ?? null,

    db_id: dbId ?? null,
    mensagem_id: dbId ?? null,
    message_db_id: dbId ?? null,
    messageDbId: dbId ?? null,

    conteudo: safeSmallString(content, 3500) || '',
    mensagem: safeSmallString(content, 3500) || '',
    texto: safeSmallString(content, 3500) || '',

    tipo: zcIsSystemEventMessage(m, content, msgId) ? 'sistema' : (m.tipo ?? (m.from_me === true || m.fromMe === true || m.origem === 'atendente' ? 'saida' : 'entrada')),
    from_me: zcIsSystemEventMessage(m, content, msgId) ? false : (m.from_me ?? m.fromMe ?? null),
    origem: zcIsSystemEventMessage(m, content, msgId) ? 'sistema' : (m.origem ?? null),
    message_type: zcIsSystemEventMessage(m, content, msgId) ? 'system' : (m.message_type ?? m.messageType ?? null),
    system_event: zcIsSystemEventMessage(m, content, msgId),
    autor_nome: safeSmallString(m.autor_nome ?? m.atendente_nome ?? m.user_nome ?? '', 120) || null,

    timestamp,
    data: timestamp,
    created_at: timestamp,
    ts: m.ts ?? timestamp ?? null,

    ack: m.ack ?? m.delivery_ack ?? m.status_ack ?? 0,
    pending: m.pending === true,
    optimistic: m.optimistic === true,
    __optimistic: m.__optimistic === true,
    temp: m.temp === true,
    failed: m.failed === true,

    instancia_id: m.instancia_id ?? m.instanciaId ?? m.instance_id ?? null,
    instance_name: safeSmallString(m.instance_name ?? m.instanceName ?? '', 120) || null,
    conversation_key: m.conversation_key ?? m.conversationKey ?? null,
    conversation_id: m.conversation_id ?? m.conversationId ?? null,
    kind: m.kind ?? null,
    entity_id: m.entity_id ?? m.entityId ?? null,
    cliente_id: m.cliente_id ?? m.clienteId ?? null,
    grupo_id: m.grupo_id ?? m.grupoId ?? null,

    apagada_cliente: Boolean(m.apagada_cliente),
    apagada_usuario: Boolean(m.apagada_usuario),
  };

  if (Array.isArray(m.midias)) {
    out.midias = m.midias.slice(0, 8).map((x) => sanitizeLightObject(x)).filter(Boolean);
  } else {
    out.midias = [];
  }

  if (m.midia && typeof m.midia === 'object') out.midia = sanitizeLightObject(m.midia);
  if (Array.isArray(m.anexos)) out.anexos = m.anexos.slice(0, 8).map((x) => sanitizeLightObject(x)).filter(Boolean);

  const quoted = m.quoted ?? m.quote ?? m.quotedMessage ?? m.quoted_message ?? null;
  const quotedPreview = m.quoted_preview ?? m.quotedPreview ?? m.reply_preview ?? m.replyPreview ?? null;

  if (quoted && typeof quoted === 'object') out.quoted = sanitizeLightObject(quoted);
  if (quotedPreview && typeof quotedPreview === 'object') out.quoted_preview = sanitizeLightObject(quotedPreview);

  return out;
}

function sanitizeIncomingMessage(m) {
  return compactMessageForMemory(m);
}

function sanitizeIncomingMessages(items) {
  return ensureArray(items).map(sanitizeIncomingMessage).filter(Boolean);
}

/* =====================
   Scroll guard
   ===================== */
const HIST_SCROLL_GUARD_MS = 450;

function armHistoricoScrollGuard(ms = HIST_SCROLL_GUARD_MS) {
  const hist = H();
  if (!hist) return;
  hist.__zcScrollGuardUntil = Date.now() + Number(ms || HIST_SCROLL_GUARD_MS);
}

function historicoScrollGuardActive(hist = H()) {
  if (!hist) return false;
  return Number(hist.__zcScrollGuardUntil || 0) > Date.now();
}

function isPreservingOldScroll(hist = H()) {
  try {
    return Number(hist?.__zcPreserveOldScrollUntil || 0) > Date.now();
  } catch {
    return false;
  }
}

/* =====================
   Âncora estilo WhatsApp Web
   ===================== */
function getFirstVisibleMsgRow(hist = H()) {
  try {
    if (!hist) return null;

    const histBox = hist.getBoundingClientRect();
    const topLimit = histBox.top + 8;
    const bottomLimit = histBox.bottom - 8;

    const rows = Array.from(hist.querySelectorAll('.msg-row'));
    if (!rows.length) return null;

    for (const row of rows) {
      const box = row.getBoundingClientRect();

      if (box.bottom >= topLimit && box.top <= bottomLimit) {
        return row;
      }
    }

    return rows[0] || null;
  } catch {
    return null;
  }
}

function restoreAnchorPosition(hist, anchor, oldTop) {
  try {
    if (!hist || !anchor || !anchor.isConnected) return;

    const newTop = anchor.getBoundingClientRect().top;
    const delta = newTop - oldTop;

    if (Math.abs(delta) > 0.5) {
      hist.scrollTop += delta;
    }
  } catch {}
}

function prependOldMessagesSemMexerTela(convKey, items) {
  const hist = H();
  if (!hist || !convKey) return false;

  const incoming = ensureArray(items)
    .map(normalizeMessageState)
    .filter(Boolean);

  if (!incoming.length) return false;

  const anchor = getFirstVisibleMsgRow(hist);
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;

  const existingIds = new Set(
    Array.from(hist.querySelectorAll('.msg-row')).map((row) => (
      row.getAttribute('data-msg-id') ||
      row.getAttribute('data-id') ||
      row.getAttribute('data-message-id') ||
      row.getAttribute('data-wa-msg-id') ||
      ''
    )).filter(Boolean)
  );

  const msgs = ordenarMensagens(incoming).filter((m) => {
    const k = msgKey(m);
    if (k && existingIds.has(k)) return false;
    return true;
  });

  if (!msgs.length) return false;

  hist.__zcPreserveOldScrollUntil = Date.now() + 2200;

  const { html } = renderMsgsWithDividers(msgs, null);
  if (!html) return false;

  const notice = ensureTopNotice();

  if (notice && notice.parentElement === hist) {
    notice.insertAdjacentHTML('afterend', html);
  } else {
    hist.insertAdjacentHTML('afterbegin', html);
  }

  try {
    const inst = getInstanciaForFetch(convKey);
    const all = ensureArray(getHist(inst, convKey)).map(normalizeMessageState);
    updateExistingRowsFromCache(hist, all);
  } catch {}

  const restore = () => {
    if (!isHistoricoStillOpenFor(convKey, hist)) return;

    hist.__zcPreserveOldScrollUntil = Date.now() + 1200;

    if (anchor && anchorTop !== null) {
      restoreAnchorPosition(hist, anchor, anchorTop);
    }

    armHistoricoScrollGuard();
  };

  restore();

  requestAnimationFrame(() => {
    restore();
  });

  setTimeout(() => {
    restore();
  }, 80);

  try { window.ensureMsgMediaCss?.(); } catch {}
  try { window.zcMediaRenderScheduleEnhance?.(hist); } catch {}
  try { window.initAudioPlayers?.(hist); } catch {}
  try { window.initMediaFallbacks?.(hist); } catch {}

  pruneHistoricoDom(hist, { keep: 'oldest', convKey });

  try {
    window.dispatchEvent(new CustomEvent('historico:rendered', {
      detail: {
        conversation_key: convKey,
        conversation_id: convKey,
        prepend_old: true,
      },
    }));
  } catch {}

  return true;
}

/* =====================
   Aviso estilo WhatsApp Web
   ===================== */
function getTopNotice(hist = H()) {
  if (!hist) return null;
  return hist.querySelector('.hist-old-notice');
}

function ensureTopNotice() {
  const hist = H();
  if (!hist) return null;

  let notice = getTopNotice(hist);

  if (!notice) {
    notice = document.createElement('button');
    notice.type = 'button';
    notice.className = 'hist-old-notice';
    notice.setAttribute('data-state', 'idle');
    notice.setAttribute('aria-label', OLD_NOTICE_TEXT);
    notice.innerHTML = `
      <span class="hist-old-notice-icon" aria-hidden="true">
        <i class="fa-solid fa-clock-rotate-left"></i>
      </span>
      <span class="hist-old-notice-text">${escapeHtml(OLD_NOTICE_TEXT)}</span>
    `;

    notice.addEventListener('click', () => {
      const convKey = getConversationKeySafe(
        hist.dataset.conversationKey ||
        hist.dataset.conversationId ||
        hist.dataset.convKey ||
        hist.dataset.clienteId
      );

      if (!convKey) return;
      if (notice.dataset.state === 'loading') return;
      if (hist.dataset.noMore === '1') return;

      carregarMaisHistorico(convKey);
    });

    hist.insertAdjacentElement('afterbegin', notice);
  }

  return notice;
}

function setTopNoticeState(state = 'idle') {
  const hist = H();
  if (!hist) return;

  const notice = ensureTopNotice();
  if (!notice) return;

  const textEl = notice.querySelector('.hist-old-notice-text');
  const iconEl = notice.querySelector('.hist-old-notice-icon');

  notice.dataset.state = state;

  if (state === 'loading') {
    notice.disabled = true;
    if (textEl) textEl.textContent = OLD_LOADING_TEXT;
    if (iconEl) {
      iconEl.innerHTML = `<span class="spinner" aria-hidden="true"></span>`;
    }
    return;
  }

  if (state === 'done') {
    notice.disabled = true;
    if (textEl) textEl.textContent = OLD_DONE_TEXT;
    if (iconEl) {
      iconEl.innerHTML = `<i class="fa-solid fa-check"></i>`;
    }
    return;
  }

  if (state === 'error') {
    notice.disabled = false;
    if (textEl) textEl.textContent = OLD_ERROR_TEXT;
    if (iconEl) {
      iconEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>`;
    }
    return;
  }

  notice.disabled = false;
  if (textEl) textEl.textContent = OLD_NOTICE_TEXT;
  if (iconEl) {
    iconEl.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i>`;
  }
}

function showTopLoader() {
  const hist = H();
  if (!hist) return;

  hist.style.display = 'flex';
  ensureTopNotice();
  hist.setAttribute('data-loading-old', '1');
  setTopNoticeState('loading');
}

function hideTopLoader() {
  const hist = H();
  if (!hist) return;
  hist.removeAttribute('data-loading-old');

  if (hist.dataset.noMore === '1') {
    setTopNoticeState('done');
  } else {
    setTopNoticeState('idle');
  }
}

function showInitialLoading(convKey = null) {
  const hist = H();
  if (!hist) return;

  hist.style.display = 'flex';

  hist.innerHTML = `
    <div class="hist-initial-loading" data-hist-initial-loading="1">
      <div class="spinner" aria-hidden="true"></div>
      <div class="txt">${escapeHtml(INITIAL_LOADING_TEXT)}</div>
    </div>
  `;

  if (convKey) {
    try {
      hist.dataset.loadingConversationKey = String(convKey);
    } catch {}
  }
}

function clearInitialLoading() {
  const hist = H();
  if (!hist) return;

  try {
    hist.querySelectorAll('[data-hist-initial-loading="1"]').forEach((n) => n.remove());
  } catch {}

  try {
    delete hist.dataset.loadingConversationKey;
  } catch {}
}

function showEmptyMessage() {
  const hist = H();
  if (!hist) return;

  hist.style.display = 'flex';

  hist.innerHTML = `
    <div class="hist-empty-state">
      <div class="hist-empty-icon"><i class="fa-regular fa-comments"></i></div>
      <div class="hist-empty-title">Nenhuma mensagem encontrada</div>
      <div class="hist-empty-sub">Quando houver mensagens, elas aparecerão aqui.</div>
    </div>
  `;
}

/* =====================
   HTML helpers
   ===================== */
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

/* =====================
   Datas / divisores
   ===================== */
function dayKeyFromDate(d) {
  try {
    const dd = new Date(d);
    dd.setHours(0, 0, 0, 0);
    const y = dd.getFullYear();
    const m = String(dd.getMonth() + 1).padStart(2, '0');
    const a = String(dd.getDate()).padStart(2, '0');
    return `${y}-${m}-${a}`;
  } catch {
    return null;
  }
}

function dayLabelFromDate(d) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dd = new Date(d);
    dd.setHours(0, 0, 0, 0);

    const diff = Math.round((today - dd) / 86400000);
    if (diff === 0) return 'Hoje';
    if (diff === 1) return 'Ontem';

    return dd.toLocaleDateString('pt-BR');
  } catch {
    return '';
  }
}

function dayDividerHtml(label) {
  return `<div class="zc-day-divider" data-day-divider="1"><span>${escapeHtml(label || '')}</span></div>`;
}

function parseMsgDate(m) {
  const raw = m?.timestamp || m?.data || m?.created_at || m?.ts || null;
  if (!raw) return null;

  let d = null;

  try {
    d = parseAtendimentoDate(raw);
  } catch {
    d = null;
  }

  if (!d || Number.isNaN(d.getTime())) {
    try {
      d = new Date(raw);
    } catch {
      d = null;
    }
  }

  if (!d || Number.isNaN(d.getTime())) return null;

  return d;
}

/* =====================
   Reply / quote preview
   ===================== */
function firstTextFromMessageObject(message) {
  if (!message || typeof message !== 'object') return '';

  return cleanOneLine(
    message.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    ''
  );
}

function mediaLabelFromMessageObject(message) {
  if (!message || typeof message !== 'object') return '';

  if (message.imageMessage) return '[imagem]';
  if (message.videoMessage) return '[vídeo]';
  if (message.audioMessage) return '[áudio]';
  if (message.documentMessage) return '[documento]';
  if (message.stickerMessage) return '[figurinha]';
  if (message.locationMessage) return '[localização]';
  if (message.contactMessage || message.contactsArrayMessage) return '[contato]';

  return '';
}

function normalizeQuotedPreview(m) {
  const direct =
    m?.quoted_preview ||
    m?.quotedPreview ||
    m?.reply_preview ||
    m?.replyPreview ||
    null;

  if (direct && typeof direct === 'object') {
    const direction = String(direct.direction || '').toLowerCase().trim();

    return {
      msg_id: idKey(direct.msg_id || direct.id || direct.message_id || direct.wa_msg_id || ''),
      text: cleanOneLine(direct.text || direct.conversation || direct.caption || '', '[mensagem]'),
      author: cleanOneLine(
        direct.author || direct.nome || direct.push_name || '',
        direction === 'out' ? 'Você' : 'Contato'
      ),
      direction: direction === 'out' ? 'out' : 'in',
    };
  }

  const quoted = m?.quoted || m?.quote || null;
  if (!quoted || typeof quoted !== 'object') return null;

  const key = quoted.key || quoted.messageKey || {};
  const message = quoted.message || quoted.quotedMessage || quoted;

  const text =
    firstTextFromMessageObject(message) ||
    mediaLabelFromMessageObject(message) ||
    cleanOneLine(quoted.text || quoted.conteudo || quoted.caption || '', '[mensagem]');

  const fromMe = Boolean(key?.fromMe);

  return {
    msg_id: idKey(key?.id || quoted.msg_id || quoted.id || quoted.message_id || ''),
    text,
    author: fromMe ? 'Você' : 'Contato',
    direction: fromMe ? 'out' : 'in',
  };
}

function renderQuotedPreview(q) {
  if (!q || typeof q !== 'object') return '';

  const msgId = escapeHtml(q.msg_id || q.id || '');
  const author = escapeHtml(
    q.author || (q.direction === 'out' ? 'Você' : 'Contato')
  );
  const text = escapeHtml(
    q.text || q.conversation || '[mensagem]'
  );

  return `
    <div class="zc-quoted-bubble" data-quoted-msg-id="${msgId}" title="Mensagem respondida">
      <div class="zc-quoted-bar" aria-hidden="true"></div>
      <div class="zc-quoted-content">
        <div class="zc-quoted-author">${author}</div>
        <div class="zc-quoted-text">${text}</div>
      </div>
    </div>
  `;
}

/* =====================
   Mensagem helpers
   ===================== */
function msgKey(m) {
  return String(m?.msg_id || m?.message_id || m?.wa_msg_id || m?.id || '').trim();
}

function msgDbId(m) {
  return String(
    m?.db_id ??
    m?.mensagem_id ??
    m?.message_db_id ??
    m?.messageDbId ??
    (m?.msg_id ? m?.id : '') ??
    ''
  ).trim();
}

function ackNum(m) {
  const n = Number(m?.ack ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isSaidaMsg(m) {
  return m?.tipo === 'saida' || m?.from_me === true || m?.origem === 'atendente';
}

function zcLooksLikeSystemEventText(value) {
  try {
    const txt = String(value || '').trim().toLowerCase();
    if (!txt) return false;
    return (
      txt.includes('assumiu este atendimento') ||
      txt.includes('liberou este atendimento') ||
      txt.includes('transferiu este atendimento') ||
      txt.includes('atendimento liberado automaticamente') ||
      (txt.includes('voltou para') && txt.includes('expediente'))
    );
  } catch {
    return false;
  }
}

function zcIsSystemEventMessage(m, content, msgId) {
  try {
    const tipo = String(m?.tipo || m?.message_type || m?.messageType || '').trim().toLowerCase();
    const origem = String(m?.origem || m?.origin || m?.source || '').trim().toLowerCase();
    const id = String(msgId || m?.msg_id || m?.msgId || '').trim().toLowerCase();

    return (
      tipo === 'sistema' ||
      tipo === 'system' ||
      tipo === 'evento' ||
      origem === 'sistema' ||
      origem === 'system' ||
      id.startsWith('sys:') ||
      zcLooksLikeSystemEventText(content)
    );
  } catch {
    return false;
  }
}

function normalizeMessageState(m) {
  if (!m || typeof m !== 'object') return m;

  const out = compactMessageForMemory(m);
  const ack = ackNum(out);

  if (isSaidaMsg(out) && ack > 0) {
    out.ack = ack;
    out.pending = false;
    out.optimistic = false;
    out.__optimistic = false;
    out.temp = false;
    out.failed = false;
  }

  return out;
}

function isTempMsg(m) {
  const k = msgKey(m);
  const ack = ackNum(m);

  if (k.startsWith('tmp:')) return true;

  if (ack > 0 && k) return false;

  return (
    m?.temp === true ||
    m?.optimistic === true ||
    m?.__optimistic === true ||
    (m?.pending === true && ack <= 0)
  );
}

function msgText(m) {
  return String(m?.conteudo ?? m?.mensagem ?? m?.texto ?? '').trim();
}

function msgTimeMs(m) {
  try {
    const raw = m?.timestamp || m?.data || m?.created_at || m?.hora || null;

    if (raw) {
      let d = null;

      try {
        d = parseAtendimentoDate(raw);
      } catch {
        d = null;
      }

      if (!d || Number.isNaN(d.getTime())) d = new Date(raw);
      if (d && !Number.isNaN(d.getTime())) return d.getTime();
    }

    const ts = Number(m?.ts || 0);
    if (Number.isFinite(ts) && ts > 0) return ts;
  } catch {}

  return 0;
}

function removeOptimisticDuplicates(arr) {
  const list = Array.isArray(arr) ? arr.slice() : [];
  const realSent = list.filter((m) => isSaidaMsg(m) && !isTempMsg(m) && msgText(m));

  if (!realSent.length) return list;

  return list.filter((m) => {
    if (!isTempMsg(m) || !isSaidaMsg(m)) return true;

    const t = msgText(m);
    if (!t) return true;

    const mt = msgTimeMs(m);

    const hasRealEquivalent = realSent.some((r) => {
      if (msgText(r) !== t) return false;

      const rt = msgTimeMs(r);
      if (!mt || !rt) return true;

      return Math.abs(rt - mt) <= 2 * 60 * 1000;
    });

    return !hasRealEquivalent;
  });
}

/* =====================
   Render helpers
   ===================== */
function renderMsgsWithDividers(msgs, lastDayKey = null) {
  let html = '';
  let last = lastDayKey || null;

  for (const m of (Array.isArray(msgs) ? msgs : [])) {
    const d = parseMsgDate(m);

    if (d) {
      const k = dayKeyFromDate(d);

      if (k && k !== last) {
        html += dayDividerHtml(dayLabelFromDate(d));
        last = k;
      }
    }

    html += criarHTMLDaMensagem(m);
  }

  return {
    html,
    lastDayKey: last,
  };
}

function getLastRenderedMsgId(hist) {
  try {
    const rows = hist?.querySelectorAll?.('.msg-row');
    if (!rows || !rows.length) return '';

    const lastRow = rows[rows.length - 1];

    return lastRow.getAttribute('data-msg-id') || lastRow.getAttribute('data-id') || '';
  } catch {
    return '';
  }
}

function setHistLastDayKey(hist, key) {
  try {
    if (!hist) return;
    if (key) hist.dataset.lastDayKey = String(key);
    else delete hist.dataset.lastDayKey;
  } catch {}
}

function getHistLastDayKey(hist) {
  try {
    const k = hist?.dataset?.lastDayKey || '';
    return k ? String(k) : null;
  } catch {
    return null;
  }
}

function renderAckHtml(m) {
  const isSaida = isSaidaMsg(m);
  if (!isSaida) return '';

  const ackVal = Number(m.ack ?? 0);
  const mid = escapeHtml(msgKey(m));

  if (m.failed === true || ackVal < 0) {
    return `
      <span class="msg-ack msg-ack-failed" data-msg-id="${mid}" title="Falha ao enviar">
        <i class="fa-solid fa-circle-exclamation"></i>
      </span>
    `;
  }

  if (typeof window.getAckIcon === 'function') {
    return window.getAckIcon(ackVal).replace(
      '<span class="msg-ack"',
      `<span class="msg-ack" data-msg-id="${mid}"`
    );
  }

  if (ackVal <= 0) {
    return `
      <span class="msg-ack msg-ack-pending" data-msg-id="${mid}" title="Enviando">
        <i class="fa-regular fa-clock"></i>
      </span>
    `;
  }

  return `
    <span class="msg-ack msg-ack-sent" data-msg-id="${mid}" title="Enviado">
      <i class="fa-solid fa-check"></i>
    </span>
  `;
}

function updateExistingRowsFromCache(hist, msgs) {
  if (!hist || !Array.isArray(msgs) || !msgs.length) return;

  const byId = new Map();

  for (const m of msgs) {
    const k = msgKey(m);
    if (k) byId.set(k, m);
  }

  if (!byId.size) return;

  hist.querySelectorAll('.msg-row').forEach((row) => {
    const k =
      row.getAttribute('data-msg-id') ||
      row.getAttribute('data-id') ||
      row.getAttribute('data-message-id') ||
      row.getAttribute('data-wa-msg-id') ||
      '';

    if (!k || !byId.has(k)) return;

    const m = normalizeMessageState(byId.get(k));
    const bubble = row.querySelector('.bubble');
    const ackVal = ackNum(m);
    const failed = m.failed === true || ackVal < 0;
    const pending = isSaidaMsg(m) && !failed && ackVal <= 0;

    row.dataset.pending = pending ? '1' : '0';
    row.dataset.failed = failed ? '1' : '0';
    row.classList.toggle('is-pending', pending);
    row.classList.toggle('is-failed', failed);
    row.classList.toggle('is-sent', isSaidaMsg(m) && !pending && !failed);

    if (bubble) {
      bubble.dataset.pending = pending ? '1' : '0';
      bubble.dataset.failed = failed ? '1' : '0';
      bubble.classList.toggle('is-pending', pending);
      bubble.classList.toggle('is-failed', failed);
      bubble.classList.toggle('is-sent', isSaidaMsg(m) && !pending && !failed);
    }

    if (isSaidaMsg(m)) {
      const meta = row.querySelector('.meta');
      const oldAck = row.querySelector('.msg-ack');
      const newAck = renderAckHtml(m);

      if (oldAck && newAck) {
        oldAck.outerHTML = newAck;
      } else if (!oldAck && meta && newAck) {
        meta.insertAdjacentHTML('afterbegin', newAck);
      }
    }
  });
}

/* =====================
   Cache leve
   ===================== */
if (!window.cacheHistoricos) window.cacheHistoricos = Object.create(null);

window.salvarCache = function salvarCacheLeve() {
  try {
    if (isHistDebug()) {
      HLOG('salvarCache: ignorado no historico.js; persistência é do hist-cache.js');
    }
  } catch {}
};

function ensureArray(a) {
  return Array.isArray(a) ? a : [];
}

function ordenarMensagens(arr) {
  return ensureArray(arr).sort((a, b) => {
    const aD = parseAtendimentoDate(a.timestamp || a.data || a.created_at || '') || new Date(a.ts || 0);
    const bD = parseAtendimentoDate(b.timestamp || b.data || b.created_at || '') || new Date(b.ts || 0);

    return (aD ? aD.getTime() : 0) - (bD ? bD.getTime() : 0);
  });
}

/* =====================
   Instância ativa
   ===================== */
function getInstanciaForFetch(rawConversation = null) {
  try {
    const hist = H();
    const ref = getHistConversationRef(rawConversation);

    const inst =
      instKey(hist?.dataset?.instanciaId) ||
      ref?.instId ||
      instKey(window.state?.clienteSel?.instancia_id) ||
      instKey(window.state?.clienteSel?.instanciaId) ||
      instKey(window.state?.clienteSel?.instancia) ||
      instKey(window.state?.clienteSel?.instance_id) ||
      instKey(window.state?.clienteSel?.instanceId) ||
      instKey(window.state?.clienteSel?.instance_name) ||
      instKey(window.state?.clienteSel?.instanceName) ||
      instKey(window.INSTANCIA_ATIVA) ||
      null;

    HLOG('getInstanciaForFetch', {
      instRaw: inst,
      inst,
    });

    return inst;
  } catch (e) {
    HERR('getInstanciaForFetch: erro', e);
    return null;
  }
}

/* =====================
   Query de instância
   ===================== */
function getInstQuery(rawConversation = null) {
  const inst = getInstanciaForFetch(rawConversation);

  if (!inst) {
    HLOG('getInstQuery: sem inst');
    return '';
  }

  const n = Number(inst);

  const q = Number.isFinite(n) && String(n) === String(inst)
    ? `&instancia_id=${n}`
    : `&instance=${encodeURIComponent(String(inst))}`;

  HLOG('getInstQuery', {
    inst,
    query: q,
  });

  return q;
}

window._instQuery = getInstQuery;

/* =====================
   salvar cache unificado
   ===================== */
export function salvarNoCache(clienteId, novos) {
  const convKey = getConversationKeySafe(clienteId) || idKey(clienteId);
  if (!convKey) return;

  const inst =
    getInstanciaForFetch(convKey) ||
    (
      Array.isArray(novos)
        ? (
            novos[0]?.instancia_id ??
            novos[0]?.instancia ??
            parseConversationKey(convKey)?.instId ??
            null
          )
        : null
    ) ||
    parseConversationKey(convKey)?.instId ||
    null;

  HLOG('salvarNoCache IN', {
    convKey,
    inst,
    novosCount: Array.isArray(novos) ? novos.length : 0,
  });

  const cur = ensureArray(getHist(inst, convKey)).map(normalizeMessageState);
  const incoming = ensureArray(novos).map(normalizeMessageState);
  const merged = [...cur, ...incoming];

  const byId = new Map();
  const noId = [];

  for (const m of merged) {
    const k = msgKey(m);

    if (k) {
      const prev = byId.get(k);

      if (!prev) {
        byId.set(k, m);
      } else {
        const ack = Math.max(ackNum(prev), ackNum(m));

        const prevTs = parseAtendimentoDate(prev.timestamp || prev.data || prev.created_at || '')?.getTime() || 0;
        const curTs = parseAtendimentoDate(m.timestamp || m.data || m.created_at || '')?.getTime() || 0;

        const ts =
          curTs > prevTs
            ? (m.timestamp || m.data || m.created_at)
            : (prev.timestamp || prev.data || prev.created_at);

        byId.set(k, normalizeMessageState({
          ...prev,
          ...m,
          msg_id:
            m.msg_id ||
            prev.msg_id ||
            m.message_id ||
            prev.message_id ||
            m.wa_msg_id ||
            prev.wa_msg_id ||
            m.id ||
            prev.id,
          ack,
          timestamp: ts,
          quoted: m.quoted ?? prev.quoted,
          quoted_preview: m.quoted_preview ?? prev.quoted_preview,
        }));
      }
    } else {
      noId.push(m);
    }
  }

  const deduped = removeOptimisticDuplicates(
    [...byId.values(), ...noId].map(normalizeMessageState)
  );

  const finalArr = ordenarMensagens(deduped.map(normalizeMessageState));

  HLOG('salvarNoCache OUT', {
    convKey,
    inst,
    total: finalArr.length,
  });

  primeWith(inst, convKey, finalArr, null);

  try {
    window.cacheHistoricos[convKey] = ensureArray(getHist(inst, convKey)).map(normalizeMessageState);
  } catch {}
}

/* =====================
   render de 1 mensagem
   ===================== */
export function criarHTMLDaMensagem(m) {
  const msg = normalizeMessageState(m);

  if (typeof window.criarHTMLDaMensagem === 'function') {
    return window.criarHTMLDaMensagem(msg);
  }

  const isSaida = isSaidaMsg(msg);
  const textoRaw = String(msg.conteudo ?? msg.mensagem ?? msg.texto ?? '').trim();
  const isReactionFallback = /^\[\s*Rea[cç][aã]o\s*\]/i.test(textoRaw);
  const texto = isReactionFallback ? normalizeReactionChatText(textoRaw) : textoRaw;
  const ackVal = ackNum(msg);
  const msgIdAttr = msgKey(msg);
  const msgIdEsc = escapeHtml(msgIdAttr);
  const dbIdAttr = msgDbId(msg);
  const dbIdEsc = escapeHtml(dbIdAttr);

  const pending = isSaida && !msg.failed && ackVal <= 0;
  const failed = isSaida && (msg.failed === true || ackVal < 0);

  const quotedPreview = normalizeQuotedPreview(msg);
  const quotedPreviewAttr = quotedPreview ? jsonAttr(quotedPreview) : '';
  const quotedAttr = msg?.quoted && typeof msg.quoted === 'object' ? jsonAttr(msg.quoted) : '';

  const ackHtml = renderAckHtml(msg);
  const quoteHtml = renderQuotedPreview(quotedPreview);

  const textHtml = texto
    ? `<div class="msg-text${isReactionFallback ? ' msg-reaction-text' : ''}">${escapeHtml(texto)}</div>`
    : `<div class="msg-text">&nbsp;</div>`;

  const quotedPreviewData = quotedPreviewAttr
    ? ` data-quoted-preview="${quotedPreviewAttr}"`
    : '';

  const quotedData = quotedAttr
    ? ` data-quoted="${quotedAttr}"`
    : '';

  return `<div class="msg-row ${isSaida ? 'msg-sent' : 'msg-received'}${isReactionFallback ? ' msg-reaction-row' : ''}${pending ? ' is-pending' : ''}${failed ? ' is-failed' : ''}${isSaida && !pending && !failed ? ' is-sent' : ''}"
      data-id="${msgIdEsc}"
      data-msg-id="${msgIdEsc}"
      data-message-id="${msgIdEsc}"
      data-wa-msg-id="${msgIdEsc}"
      data-db-id="${dbIdEsc}"
      data-message-db-id="${dbIdEsc}"
      data-from-me="${isSaida ? '1' : '0'}"
      data-pending="${pending ? '1' : '0'}"
      data-failed="${failed ? '1' : '0'}"${quotedPreviewData}${quotedData}>
    <div class="bubble ${isSaida ? 'bubble-out' : 'bubble-in'}${isReactionFallback ? ' bubble-reaction' : ''}${pending ? ' is-pending' : ''}${failed ? ' is-failed' : ''}${isSaida && !pending && !failed ? ' is-sent' : ''}"
        data-msg-id="${msgIdEsc}"
        data-message-id="${msgIdEsc}"
        data-wa-msg-id="${msgIdEsc}"
        data-db-id="${dbIdEsc}"
        data-message-db-id="${dbIdEsc}"
        data-from-me="${isSaida ? '1' : '0'}"
        data-pending="${pending ? '1' : '0'}"
        data-failed="${failed ? '1' : '0'}"${quotedPreviewData}${quotedData}>
      ${quoteHtml}
      ${textHtml}
      <div class="meta">
        ${ackHtml}
        <span class="msg-time">${formatChatTime(msg.timestamp || msg.data || msg.created_at || '')}</span>
      </div>
    </div>
  </div>`;
}


function normalizeReactionChatText(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const m = raw.match(/^\[\s*Rea[cç][aã]o\s*\]\s*(.*)$/i);
  if (!m) return raw;
  let rest = String(m[1] || '').trim();
  rest = rest.replace(/\s*(?:[→⇢➜➡]|-{1,2}>|=>)\s*[A-Za-z0-9._:@-]+.*$/u, '').trim();
  return rest || '[Reação]';
}

function isDateJumpScrollLocked() {
  try {
    const now = Date.now();

    const candidates = [
      window.__ZC_SUPPRESS_AUTO_SCROLL_UNTIL,
      window.__ZC_DATE_JUMP_ACTIVE_UNTIL,
      window.__ZC_DATE_JUMP_LOCK_UNTIL,
    ]
      .map((v) => Number(v || 0))
      .filter((v) => Number.isFinite(v) && v > 0);

    const maxUntil = candidates.length ? Math.max(...candidates) : 0;

    if (maxUntil && now < maxUntil) {
      return true;
    }

    if (window.__ZC_DATE_JUMP_ACTIVE === true) {
      const startedAt = Number(window.__ZC_DATE_JUMP_ACTIVE_STARTED_AT || 0);

      if (startedAt && now - startedAt < 8000) {
        return true;
      }
    }
  } catch {}

  return false;
}

function scrollToBottomIfAllowed(hist, convKey, reason = '') {
  if (!hist) return;

  if (isPreservingOldScroll(hist)) {
    HLOG('auto-scroll para o fim bloqueado: carregando mensagens antigas', {
      convKey,
      reason,
    });
    return;
  }

  if (isDateJumpScrollLocked()) {
    HLOG('auto-scroll para o fim bloqueado pelo calendário', {
      convKey,
      reason,
    });
    return;
  }

  try {
    hist.scrollTop = hist.scrollHeight;
  } catch {}
}

function scrollToBottomNextFrameIfAllowed(hist, convKey, reason = '') {
  requestAnimationFrame(() => {
    if (!isHistoricoStillOpenFor(convKey, hist)) return;

    scrollToBottomIfAllowed(hist, convKey, reason);
    armHistoricoScrollGuard();
  });
}


/* =====================
   Limite de DOM (igual app grande: não deixa milhares de bolhas no Chrome)
   ===================== */
function getMsgRows(hist = H()) {
  try {
    return Array.from(hist?.querySelectorAll?.('.msg-row') || []);
  } catch {
    return [];
  }
}

function cleanupOrphanDayDividers(hist = H()) {
  try {
    if (!hist) return;

    const nodes = Array.from(hist.children || []);
    let lastWasDivider = false;

    for (const node of nodes) {
      const isDivider = node?.matches?.('.zc-day-divider');
      if (!isDivider) {
        lastWasDivider = false;
        continue;
      }

      const next = node.nextElementSibling;
      const prev = node.previousElementSibling;
      const nextIsDivider = next?.matches?.('.zc-day-divider, .hist-old-notice, .hist-latest-notice');

      if (lastWasDivider || nextIsDivider || !next) {
        node.remove();
      } else {
        lastWasDivider = true;
      }
    }
  } catch {}
}

function getOldestRenderedDbId(hist = H()) {
  try {
    const rows = getMsgRows(hist);
    for (const row of rows) {
      const dbId = String(
        row.getAttribute('data-db-id') ||
        row.getAttribute('data-message-db-id') ||
        ''
      ).trim();
      if (/^\d+$/.test(dbId)) return dbId;
    }
  } catch {}
  return '';
}

function removeLatestNotice(hist = H()) {
  try { hist?.querySelectorAll?.('.hist-latest-notice')?.forEach((n) => n.remove()); } catch {}
}

function ensureLatestNotice(convKey) {
  const hist = H();
  if (!hist || !convKey) return null;

  let notice = hist.querySelector('.hist-latest-notice');
  if (!notice) {
    notice = document.createElement('button');
    notice.type = 'button';
    notice.className = 'hist-latest-notice';
    notice.innerHTML = `
      <span class="hist-latest-notice-icon" aria-hidden="true"><i class="fa-solid fa-arrow-down"></i></span>
      <span class="hist-latest-notice-text">Voltar para mensagens recentes</span>
    `;
    notice.addEventListener('click', async () => {
      removeLatestNotice(hist);
      hist.dataset.noMore = '0';
      try {
        showInitialLoading(convKey);
        await abrirHistorico(convKey);
      } catch {}
    });
  }

  if (notice.parentElement !== hist) hist.appendChild(notice);
  return notice;
}

function pruneHistoricoDom(hist = H(), { keep = 'latest', convKey = '' } = {}) {
  try {
    if (!hist) return;

    const maxRows = Math.max(80, Math.min(320, Number(HIST_DOM_MAX_ROWS || 160)));
    let rows = getMsgRows(hist);
    if (rows.length <= maxRows) {
      cleanupOrphanDayDividers(hist);
      return;
    }

    const extra = rows.length - maxRows;

    if (keep === 'oldest') {
      // O usuário está vendo mensagens antigas. Para não explodir RAM, removemos
      // as mais recentes do DOM e deixamos um botão para voltar ao final.
      rows.slice(-extra).forEach((row) => row.remove());
      ensureLatestNotice(convKey || getOpenHistKey(hist));
    } else {
      // Fluxo normal/tempo real: mantém o final da conversa e remove antigas do DOM.
      rows.slice(0, extra).forEach((row) => row.remove());
      removeLatestNotice(hist);
    }

    cleanupOrphanDayDividers(hist);
  } catch {}
}

/* =====================
   render histórico
   ===================== */
export function renderHistoricoDoCache(clienteId, append = false) {
  const hist = H();
  if (!hist) return;

  const convKey = getConversationKeySafe(clienteId) || idKey(clienteId);
  if (!convKey) return;

  if (!isHistoricoStillOpenFor(convKey, hist)) return;

  const inst =
    hist?.dataset?.instanciaId && hist.dataset.instanciaId !== 'null'
      ? hist.dataset.instanciaId
      : getInstanciaForFetch(convKey);

  const msgs = ordenarMensagens(
    removeOptimisticDuplicates(
      ensureArray(getHist(inst, convKey)).map(normalizeMessageState)
    ).map(normalizeMessageState)
  );

  HLOG('renderHistoricoDoCache', {
    convKey,
    inst,
    append,
    msgsCount: msgs.length,
  });

  const stripAckReceived = () => {
    try {
      hist
        .querySelectorAll('.msg-row.msg-received .msg-ack, .bubble-in .msg-ack')
        .forEach((n) => n.remove());
    } catch {}
  };

  armHistoricoScrollGuard();

  if (!append) {
    if (!isHistoricoStillOpenFor(convKey, hist)) return;

    hist.innerHTML = '';
    ensureTopNotice();

    if (hist.dataset.noMore === '1') setTopNoticeState('done');
    else setTopNoticeState('idle');

    const { html, lastDayKey } = renderMsgsWithDividers(msgs, null);

    if (!isHistoricoStillOpenFor(convKey, hist)) return;

    hist.insertAdjacentHTML('beforeend', html);

    stripAckReceived();
    updateExistingRowsFromCache(hist, msgs);
    setHistLastDayKey(hist, lastDayKey);

    scrollToBottomIfAllowed(hist, convKey, 'render-total');
    scrollToBottomNextFrameIfAllowed(hist, convKey, 'render-total-raf');
    setTimeout(() => armHistoricoScrollGuard(), 60);
  } else {
    if (!isHistoricoStillOpenFor(convKey, hist)) return;

    ensureTopNotice();

    const existingIds = new Set(
      Array.from(hist.querySelectorAll('.msg-row')).map(
        (n) => n.getAttribute('data-msg-id') || n.getAttribute('data-id') || ''
      )
    );

    const hasNoIdInDom = existingIds.has('');
    const hasNoIdInList = msgs.some((m) => !msgKey(m));

    if (hasNoIdInDom || hasNoIdInList) {
      HLOG('renderHistoricoDoCache: rebuild total (mensagem sem msg_id)', {
        hasNoIdInDom,
        hasNoIdInList,
      });

      hist.innerHTML = '';
      ensureTopNotice();

      const { html, lastDayKey } = renderMsgsWithDividers(msgs, null);

      if (!isHistoricoStillOpenFor(convKey, hist)) return;

      hist.insertAdjacentHTML('beforeend', html);

      stripAckReceived();
      updateExistingRowsFromCache(hist, msgs);
      setHistLastDayKey(hist, lastDayKey);

      scrollToBottomIfAllowed(hist, convKey, 'append-rebuild');
      scrollToBottomNextFrameIfAllowed(hist, convKey, 'append-rebuild-raf');

      setTimeout(() => armHistoricoScrollGuard(), 60);
    } else {
      updateExistingRowsFromCache(hist, msgs);

      const lastRenderedId = getLastRenderedMsgId(hist);
      let startIdx = -1;
      let lastRenderedTs = 0;

      if (lastRenderedId) {
        startIdx = msgs.findIndex((m) => msgKey(m) === String(lastRenderedId));
        if (startIdx >= 0) {
          lastRenderedTs = msgTimeMs(msgs[startIdx]) || 0;
        }
      }

      let novas = [];

      if (startIdx >= 0) {
        novas = msgs.slice(startIdx + 1).filter((m) => {
          const mid = msgKey(m);
          return mid && !existingIds.has(mid);
        });

        /*
          Correção ZapsChat v6:
          Quando o cliente manda várias mensagens rápidas, principalmente textos
          iguais como "1", "1", "1" e depois "11", várias podem chegar com o
          mesmo segundo de timestamp. O cache ordena por tempo e, nesses empates,
          uma mensagem nova pode ficar ANTES do último data-msg-id que está no DOM.

          A lógica antiga fazia só msgs.slice(startIdx + 1), então essa mensagem
          nova ficava no cache/lista lateral, mas nunca entrava no bate-papo.

          Aqui pegamos também mensagens ausentes no DOM que estejam no mesmo
          bloco temporal do último renderizado. Assim não jogamos histórico antigo
          no final, mas não perdemos rajadas de tempo real.
        */
        const SAME_BURST_WINDOW_MS = Number(window.ZC_HIST_APPEND_BURST_WINDOW_MS || 5000);
        const burstMissing = msgs.filter((m) => {
          const mid = msgKey(m);
          if (!mid || existingIds.has(mid)) return false;

          const mt = msgTimeMs(m) || 0;
          if (!lastRenderedTs || !mt) return true;

          return mt >= (lastRenderedTs - SAME_BURST_WINDOW_MS);
        });

        if (burstMissing.length) {
          const byMid = new Map();
          [...novas, ...burstMissing].forEach((m) => {
            const mid = msgKey(m);
            if (mid && !byMid.has(mid)) byMid.set(mid, m);
          });
          novas = Array.from(byMid.values());
          novas = ordenarMensagens(novas.map(normalizeMessageState));
        }
      } else {
        novas = msgs.filter((m) => {
          const mid = msgKey(m);
          return mid && !existingIds.has(mid);
        });
      }

      HLOG('renderHistoricoDoCache: append novas', {
        novasCount: novas.length,
        lastRenderedId,
        startIdx,
        lastRenderedTs,
      });

      if (novas.length) {
        const lastDayKey = getHistLastDayKey(hist);
        const out = renderMsgsWithDividers(novas, lastDayKey);

        if (!isHistoricoStillOpenFor(convKey, hist)) return;

        const lastRow = hist.querySelector('.msg-row:last-of-type');

        if (lastRow) lastRow.insertAdjacentHTML('afterend', out.html);
        else hist.insertAdjacentHTML('beforeend', out.html);

        setHistLastDayKey(hist, out.lastDayKey);
        updateExistingRowsFromCache(hist, msgs);
      } else {
        updateExistingRowsFromCache(hist, msgs);
      }

      stripAckReceived();
      scrollToBottomIfAllowed(hist, convKey, 'append-rebuild');
      scrollToBottomNextFrameIfAllowed(hist, convKey, 'append-rebuild-raf');

      setTimeout(() => armHistoricoScrollGuard(), 60);
    }
  }

  pruneHistoricoDom(hist, { keep: 'latest', convKey });

  try { window.ensureMsgMediaCss?.(); } catch {}
  try { window.zcMediaRenderScheduleEnhance?.(hist); } catch {}
  try { window.initAudioPlayers?.(hist); } catch {}
  try { window.initMediaFallbacks?.(hist); } catch {}

  try {
    window.reconcilePendingAcks?.();
  } catch (e) {
    HERR('renderHistoricoDoCache: reconcilePendingAcks erro', e);
  }

  try {
    window.dispatchEvent(new CustomEvent('historico:rendered', {
      detail: {
        conversation_key: convKey,
        conversation_id: convKey,
        instancia_id: inst,
      },
    }));
  } catch {}
}

/* =====================
   append util
   ===================== */
export function appendToHistory(clienteId, msg) {
  const convKey = getConversationKeySafe(clienteId) || idKey(clienteId);

  HLOG('appendToHistory', {
    convKey,
    msgId: msgKey(msg) || null,
  });

  salvarNoCache(convKey, [msg]);
}

/* =====================
   offset helpers
   ===================== */
function getOffsetsObj() {
  return window.state && typeof window.state === 'object'
    ? (window.state.mensagensOffset = window.state.mensagensOffset || {})
    : (window.mensagensOffset = window.mensagensOffset || {});
}

function getOffset(id) {
  const convKey = getConversationKeySafe(id) || idKey(id);
  const table = getOffsetsObj();
  const v = convKey && typeof table[convKey] === 'number' ? table[convKey] : HISTORICO_LIMIT;

  HLOG('getOffset', {
    convKey,
    offset: v,
  });

  return v;
}

function setOffset(id, val) {
  const convKey = getConversationKeySafe(id) || idKey(id);
  if (!convKey) return;

  const table = getOffsetsObj();
  table[convKey] = Number(val) || 0;

  HLOG('setOffset', {
    convKey,
    offset: table[convKey],
  });

  try {
    window.persist?.();
  } catch {}
}

/* =====================
   abrir histórico
   ===================== */
export async function abrirHistorico(id) {
  const hist = H();

  if (!hist) {
    HERR('abrirHistorico: sem #historico', { id });
    return false;
  }

  const ref = getHistConversationRef(id);
  const convKey = ref?.key || getConversationKeySafe(id) || idKey(id);
  const entityId = ref?.entityId || getConversationEntityIdSafe(id);

  if (!convKey || !entityId) {
    HERR('abrirHistorico: conversa inválida', {
      id,
      convKey,
      entityId,
    });
    return false;
  }

  try {
    const header = document.getElementById('chat-header');
    const footer = document.getElementById('chat-footer');
    const welcome = document.getElementById('welcome-screen');

    if (header) header.style.display = '';
    if (footer) footer.style.display = '';
    hist.style.display = 'flex';

    if (welcome) welcome.style.display = 'none';

    document.body.dataset.chatOpen = '1';
  } catch (e) {
    HERR('abrirHistorico: erro ao exibir UI', e);
  }

  setOpenHistRef(hist, ref);
  hist.dataset.noMore = '0';

  const inst = getInstanciaForFetch(convKey);
  const cached = ensureArray(getHist(inst, convKey));

  if (cached.length) {
    renderHistoricoDoCache(convKey, false);
  } else {
    showInitialLoading(convKey);
  }

  await nextPaint();

  try {
    const url =
      `/api/atendimento/conversas/${encodeURIComponent(entityId)}/mensagens` +
      `?empresa_id=${EMPRESA_ID}` +
      `&limit=${HISTORICO_LIMIT}` +
      `&light=1` +
      getInstQuery(convKey) +
      `&__ts=${Date.now()}`;

    HLOG('abrirHistorico: fetch', {
      url,
      convKey,
      entityId,
    });

    const r = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
      },
    });

    HLOG('abrirHistorico: resposta HTTP', {
      status: r.status,
    });

    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const data = await r.json();

    if (!isHistoricoStillOpenFor(convKey, hist)) {
      HLOG('abrirHistorico: resposta ignorada, conversa mudou', { convKey });
      return false;
    }

    const items = sanitizeIncomingMessages(extractItems(data));

    HLOG('abrirHistorico: itens recebidos', {
      convKey,
      count: items.length,
    });

    clearInitialLoading();

    if (items.length) {
      salvarNoCache(convKey, items);
    }

    if (!isHistoricoStillOpenFor(convKey, hist)) {
      HLOG('abrirHistorico: cache salvo, mas conversa mudou antes de render', { convKey });
      return false;
    }

    try {
      const instNow = getInstanciaForFetch(convKey);
      const total = ensureArray(getHist(instNow, convKey)).length;

      HLOG('abrirHistorico: setOffset total', {
        convKey,
        total,
        inst: instNow,
      });

      setOffset(convKey, total);
    } catch (e) {
      HERR('abrirHistorico: erro ao calcular offset', e);
    }

    const finalInst = getInstanciaForFetch(convKey);
    const finalMsgs = ensureArray(getHist(finalInst, convKey));

    if (!finalMsgs.length) {
      showEmptyMessage();
    } else {
      renderHistoricoDoCache(convKey, false);
    }

    try {
      window.syncPreviewFromCache?.(convKey);
    } catch (e) {
      HERR('abrirHistorico: erro syncPreviewFromCache', e);
    }

    return true;
  } catch (e) {
    HERR('abrirHistorico erro', e);

    if (isHistoricoStillOpenFor(convKey, hist) && !cached.length) {
      hist.style.display = 'flex';
      hist.innerHTML = `
        <div class="hist-empty-state hist-empty-error">
          <div class="hist-empty-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
          <div class="hist-empty-title">Não foi possível carregar as mensagens</div>
          <button type="button" class="hist-retry-btn">Tentar novamente</button>
        </div>
      `;

      try {
        hist.querySelector('.hist-retry-btn')?.addEventListener('click', () => {
          abrirHistorico(convKey);
        });
      } catch {}
    }

    try {
      console.error('[historico] abrirHistorico', e);
    } catch {}

    return false;
  }
}

/* =====================
   refresh forçado do histórico aberto
   ===================== */
let forceRefreshSeq = 0;
let forceRefreshTimer = null;
let forceRefreshInFlight = null;

function eventDetailToConversation(detail = null) {
  const d = detail && typeof detail === 'object' ? detail : {};

  const raw =
    d.conversation_key ??
    d.conversationKey ??
    d.conversation_id ??
    d.conversationId ??
    d.convKey ??
    d.id ??
    null;

  if (raw) {
    return {
      ...d,
      conversation_key: raw,
      conversation_id: raw,
      id: raw,
    };
  }

  const kind =
    String(d.kind || d.conversation_kind || d.tipo_conversa || '').toLowerCase().startsWith('g') ||
    d.is_group === true ||
    d.grupo_id != null
      ? 'g'
      : 'c';

  const entityId =
    d.entity_id ??
    d.entityId ??
    (
      kind === 'g'
        ? (d.grupo_id ?? d.grupoId)
        : (d.cliente_id ?? d.clienteId)
    ) ??
    null;

  const inst =
    d.instancia_id ??
    d.instanciaId ??
    d.instancia ??
    d.instance_id ??
    d.instanceId ??
    d.instance_name ??
    d.instanceName ??
    H()?.dataset?.instanciaId ??
    null;

  const built = buildConversationKey(kind, entityId, inst);

  return {
    ...d,
    kind,
    is_group: kind === 'g',
    entity_id: entityId,
    cliente_id: kind === 'c' ? entityId : d.cliente_id,
    grupo_id: kind === 'g' ? entityId : d.grupo_id,
    instancia_id: inst,
    conversation_key: built,
    conversation_id: built,
    id: built,
  };
}

export async function forcarAtualizacaoHistorico(rawConversation = null, opts = {}) {
  const hist = H();
  if (!hist) return false;

  const ref = getHistConversationRef(rawConversation || getOpenHistKey(hist));
  const convKey = ref?.key || null;
  const entityId = ref?.entityId || null;

  if (!convKey || !entityId) {
    HLOG('forcarAtualizacaoHistorico: sem convKey/entityId', {
      rawConversation,
      ref,
    });
    return false;
  }

  if (!isHistoricoStillOpenFor(convKey, hist)) {
    HLOG('forcarAtualizacaoHistorico: ignorado, conversa não está aberta', {
      convKey,
      open: getOpenHistKey(hist),
    });
    return false;
  }

  const mySeq = ++forceRefreshSeq;
  const limit = Number(opts.limit || HISTORICO_LIMIT) || HISTORICO_LIMIT;
  const append = opts.append !== false;
  const reason = opts.reason || 'force-refresh';

  const url =
    `/api/atendimento/conversas/${encodeURIComponent(entityId)}/mensagens` +
    `?empresa_id=${EMPRESA_ID}` +
    `&limit=${Math.min(Number(limit || HISTORICO_LIMIT) || HISTORICO_LIMIT, Number(window.ZC_HIST_OPEN_LIMIT || 12))}` +
    `&light=1` +
    getInstQuery(convKey) +
    `&__ts=${Date.now()}`;

  HLOG('forcarAtualizacaoHistorico: fetch', {
    url,
    convKey,
    entityId,
    append,
    reason,
    seq: mySeq,
  });

  try {
    const r = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
      },
    });

    HLOG('forcarAtualizacaoHistorico: resposta HTTP', {
      status: r.status,
      seq: mySeq,
    });

    if (!r.ok) return false;

    const data = await r.json();

    if (!isHistoricoStillOpenFor(convKey, hist)) {
      HLOG('forcarAtualizacaoHistorico: resposta ignorada, conversa mudou', { convKey });
      return false;
    }

    const items = sanitizeIncomingMessages(extractItems(data));

    HLOG('forcarAtualizacaoHistorico: itens', {
      convKey,
      count: items.length,
      seq: mySeq,
    });

    if (items.length) {
      salvarNoCache(convKey, items);
    }

    if (!isHistoricoStillOpenFor(convKey, hist)) return false;

    try {
      const inst = getInstanciaForFetch(convKey);
      const total = ensureArray(getHist(inst, convKey)).length;
      setOffset(convKey, total);
    } catch {}

    renderHistoricoDoCache(convKey, append);

    try {
      window.syncPreviewFromCache?.(convKey);
    } catch {}

    return true;
  } catch (e) {
    HERR('forcarAtualizacaoHistorico erro', e);
    return false;
  }
}

function zcMakeSystemEventMessage(raw = {}) {
  const now = new Date().toISOString();
  const msgId = String(
    raw.msg_id ||
    raw.msgId ||
    raw.message_id ||
    raw.messageId ||
    `sys:front:${Date.now()}:${Math.random().toString(16).slice(2)}`
  );

  const texto = String(
    raw.conteudo ??
    raw.texto ??
    raw.mensagem ??
    raw.body ??
    ''
  ).trim();

  if (!texto) return null;

  return normalizeMessageState({
    ...raw,
    id: raw.id || msgId,
    msg_id: msgId,
    message_id: msgId,
    conteudo: texto,
    texto,
    mensagem: texto,
    tipo: 'sistema',
    origem: 'sistema',
    message_type: 'system',
    messageType: 'system',
    system_event: true,
    lida: true,
    ack: Number(raw.ack ?? 3),
    timestamp: raw.timestamp || raw.created_at || raw.createdAt || now,
    created_at: raw.created_at || raw.createdAt || raw.timestamp || now,
  });
}

window.zcAppendSystemEventToOpenHistory = function zcAppendSystemEventToOpenHistory(raw = {}) {
  try {
    const hist = H();
    if (!hist) return false;

    const convObj = eventDetailToConversation(raw || {});
    const ref = getHistConversationRef(convObj);
    const convKey = ref?.key || convObj.conversation_key || getOpenHistKey(hist);

    if (!convKey || !isHistoricoStillOpenFor(convKey, hist)) {
      return false;
    }

    const msg = zcMakeSystemEventMessage(raw);
    if (!msg) return false;

    salvarNoCache(convKey, [msg]);
    renderHistoricoDoCache(convKey, true);

    try {
      window.syncPreviewFromCache?.(convKey);
    } catch {}

    return true;
  } catch (e) {
    HERR('zcAppendSystemEventToOpenHistory erro', e);
    return false;
  }
};

function agendarRefreshHistorico(rawConversation = null, opts = {}) {
  const hist = H();
  if (!hist) return;

  const convObj = eventDetailToConversation(rawConversation || {});
  const ref = getHistConversationRef(convObj);
  const convKey = ref?.key || getOpenHistKey(hist);

  if (!convKey) return;

  if (!isHistoricoStillOpenFor(convKey, hist)) {
    HLOG('agendarRefreshHistorico: ignorado, conversa diferente', {
      convKey,
      open: getOpenHistKey(hist),
    });
    return;
  }

  clearTimeout(forceRefreshTimer);

  const reason = String(opts.reason || convObj.reason || 'event-refresh');

  const delay =
    reason.includes('send') ||
    reason.includes('envio') ||
    reason.includes('message') ||
    reason.includes('mensagem')
      ? 420
      : 180;

  const eventLimit = Number(opts.limit || convObj.limit || 0) || undefined;

  forceRefreshTimer = setTimeout(() => {
    forceRefreshTimer = null;

    if (forceRefreshInFlight) {
      HLOG('agendarRefreshHistorico: já existe fetch em andamento, aguardando');

      forceRefreshInFlight.finally(() => {
        forcarAtualizacaoHistorico(convObj, {
          append: true,
          reason: `${reason}:after-inflight`,
          limit: eventLimit,
        }).catch(() => {});
      });

      return;
    }

    forceRefreshInFlight = forcarAtualizacaoHistorico(convObj, {
      append: true,
      reason,
      limit: eventLimit,
    });

    forceRefreshInFlight
      .then((ok) => {
        if (!ok && isHistoricoStillOpenFor(convKey, H())) {
          setTimeout(() => {
            forcarAtualizacaoHistorico(convObj, {
              append: true,
              reason: `${reason}:retry`,
              limit: eventLimit,
            }).catch(() => {});
          }, 900);
        }
      })
      .finally(() => {
        forceRefreshInFlight = null;
      });
  }, delay);
}

(function bindForceRefreshEvents() {
  if (window.__ZC_HIST_FORCE_REFRESH_BOUND__) return;
  window.__ZC_HIST_FORCE_REFRESH_BOUND__ = true;

  const names = [
    'zc:history-force-refresh',
    'atendimento:history-force-refresh',
    'historico:force-refresh',
    'zc:send-success-refresh',
    'atendimento:send-success',
    'atendimento:mensagem-enviada',
  ];

  const handler = (ev) => {
    const detail = ev?.detail || {};

    if (ev?.type === 'zc:optimistic-message-created') return;

    const convObj = eventDetailToConversation(detail);

    HLOG('evento refresh histórico recebido', {
      type: ev?.type,
      detail,
      convObj,
    });

    agendarRefreshHistorico(convObj, {
      reason: detail.reason || ev?.type || 'event',
    });
  };

  for (const name of names) {
    try { window.addEventListener(name, handler, true); } catch {}
    try { document.addEventListener(name, handler, true); } catch {}
  }
})();



/* =====================
   render aberto via eventos de tempo real
   ===================== */

function zcIsAtendimentoNavigatingAway() {
  try {
    if (window.__ZC_ATENDIMENTOS_NAVIGATING_AWAY__) return true;
    const until = Number(sessionStorage.getItem('zc:atendimentos:leaving_until') || '0');
    const to = String(sessionStorage.getItem('zc:atendimentos:leaving_to') || '');
    return until > Date.now() && !!to && !to.includes('/atendimentos');
  } catch {
    return false;
  }
}

function zcClearOpenRealtimeWork(reason = 'clear') {
  try {
    for (const arr of zcOpenRealtimeTimers.values()) {
      try { (arr || []).forEach((t) => clearTimeout(t)); } catch {}
    }
    zcOpenRealtimeTimers.clear();
  } catch {}
  try { zcOpenRealtimePendingIds.clear(); } catch {}
  try { zcOpenRealtimeHandledEvents.clear(); } catch {}
  try { HLOG('realtime aberto: timers limpos', { reason }); } catch {}
}

function zcRealtimeMsgId(detail = {}) {
  return String(
    detail?.msg_id ??
    detail?.msgId ??
    detail?.message_id ??
    detail?.messageId ??
    detail?.wa_msg_id ??
    detail?.id ??
    ''
  ).trim();
}

function zcDomHasMsgId(hist, msgId) {
  if (!hist || !msgId) return false;

  const id = String(msgId);
  const esc = (() => {
    try { return CSS.escape(id); }
    catch { return id.replace(/["\\]/g, '\\$&'); }
  })();

  try {
    return !!hist.querySelector(
      `[data-msg-id="${esc}"],` +
      `[data-message-id="${esc}"],` +
      `[data-wa-msg-id="${esc}"],` +
      `[data-id="${esc}"]`
    );
  } catch {
    return false;
  }
}

function zcDetailMatchesOpenHistory(detail = {}) {
  const hist = H();
  if (!hist) return null;

  const openKey = getOpenHistKey(hist);
  if (!openKey) return null;

  const convObj = eventDetailToConversation(detail || {});
  const ref = getHistConversationRef(convObj || detail || openKey);
  const convKey = ref?.key || convObj?.conversation_key || null;

  if (!convKey || String(convKey) !== String(openKey)) {
    HLOG('realtime aberto ignorado: conversa diferente', {
      openKey,
      convKey,
      detail,
    });
    return null;
  }

  if (!isHistoricoStillOpenFor(openKey, hist)) return null;

  return { hist, convKey: openKey, ref, convObj };
}

const zcOpenRealtimePendingIds = new Map();
const zcOpenRealtimeTimers = new Map();
const zcOpenRealtimeHandledEvents = new Map();

function zcCleanupHandledRealtimeEvents(now = Date.now()) {
  try {
    if (zcOpenRealtimeHandledEvents.size < 250) return;
    for (const [key, ts] of zcOpenRealtimeHandledEvents.entries()) {
      if (now - Number(ts || 0) > 5000) zcOpenRealtimeHandledEvents.delete(key);
    }
    if (zcOpenRealtimeHandledEvents.size > 500) zcOpenRealtimeHandledEvents.clear();
  } catch {}
}

function zcQueueOpenRealtimeRender(detail = {}, reason = 'realtime-open') {
  if (zcIsAtendimentoNavigatingAway()) return;
  const match = zcDetailMatchesOpenHistory(detail);
  if (!match || zcIsAtendimentoNavigatingAway()) return;

  const { hist, convKey, convObj } = match;
  const msgId = zcRealtimeMsgId(detail);

  // v9: o ws-empresa dispara vários nomes de evento para a mesma mensagem
  // (atendimento:mensagem-recebida, zc:message-upsert, ws:nova_mensagem etc.)
  // e historico.js também escutava document + window. Isso fazia uma mensagem
  // virar muitas renderizações imediatas; em rajada, o clique em Arquivos ficava
  // preso atrás da fila de render. Processa cada msg_id uma vez por janela curta.
  if (msgId) {
    const eventKey = `${convKey}:${msgId}`;
    const now = Date.now();
    const last = Number(zcOpenRealtimeHandledEvents.get(eventKey) || 0);
    if (last && now - last < 2500) return;
    zcOpenRealtimeHandledEvents.set(eventKey, now);
    zcCleanupHandledRealtimeEvents(now);
  }

  /*
    Correção ZapsChat v7:
    O ws-empresa.js atualiza lista/cache, mas em alguns caminhos `openNow`
    fica falso e ele não chama o render do histórico aberto. O sintoma é:
    lista lateral atualiza, cache tem a mensagem, mas a bolha não aparece.

    Aqui o historico.js fica dono do render da conversa que já está aberta:
    qualquer evento de mensagem recebido para a mesma conversation_key renderiza
    o cache aberto. Se a mensagem ainda não entrou no DOM, faz um refresh leve
    só desta conversa.
  */
  try {
    if (msgId) {
      const pending = zcOpenRealtimePendingIds.get(convKey) || new Map();
      pending.set(msgId, Date.now());
      zcOpenRealtimePendingIds.set(convKey, pending);
    }
  } catch {}

  try {
    // Garante que o payload do próprio evento também esteja no cache aberto.
    // Se o WS já colocou, salvarNoCache apenas mescla por msg_id.
    if (msgId || detail?.texto || detail?.mensagem || detail?.conteudo) {
      salvarNoCache(convKey, [{
        ...detail,
        conversation_key: convKey,
        conversation_id: convKey,
        msg_id: msgId || detail?.msg_id || detail?.id,
        id: msgId || detail?.id || detail?.msg_id,
        instancia_id: convObj?.instancia_id || detail?.instancia_id || detail?.instanciaId || hist?.dataset?.instanciaId,
      }]);
    }
  } catch (e) {
    HLOG('realtime aberto: salvarNoCache falhou', e);
  }

  const runRender = (stage) => {
    try {
      if (zcIsAtendimentoNavigatingAway()) return;
      if (!isHistoricoStillOpenFor(convKey, H())) return;
      renderHistoricoDoCache(convKey, true);
    } catch (e) {
      HERR('realtime aberto: render falhou', { stage, e });
    }
  };

  runRender('immediate');

  const timerKey = String(convKey);
  const prev = zcOpenRealtimeTimers.get(timerKey) || [];
  prev.forEach((t) => clearTimeout(t));

  const timers = [];

  [80, 220, 520].forEach((delay) => {
    timers.push(setTimeout(() => runRender(`delay-${delay}`), delay));
  });

  timers.push(setTimeout(async () => {
    if (zcIsAtendimentoNavigatingAway()) return;
    const h = H();
    if (!h || !isHistoricoStillOpenFor(convKey, h)) return;

    const pending = zcOpenRealtimePendingIds.get(convKey) || new Map();
    const now = Date.now();

    // Remove ids antigos para não crescer memória.
    for (const [id, ts] of pending.entries()) {
      if (now - Number(ts || 0) > 15000 || zcDomHasMsgId(h, id)) {
        pending.delete(id);
      }
    }

    const missing = [...pending.keys()].filter((id) => !zcDomHasMsgId(h, id));

    if (!missing.length) {
      runRender('verify-ok');
      return;
    }

    HLOG('realtime aberto: mensagens ainda fora do DOM, refresh leve', {
      convKey,
      reason,
      missingCount: missing.length,
      missing: missing.slice(0, 5),
    });

    try {
      await forcarAtualizacaoHistorico(convKey, {
        append: true,
        limit: 20,
        reason: `open-realtime:${reason}`,
      });
    } catch (e) {
      HERR('realtime aberto: refresh leve falhou', e);
    }

    runRender('after-refresh');

    try {
      for (const id of [...pending.keys()]) {
        if (zcDomHasMsgId(H(), id)) pending.delete(id);
      }
    } catch {}
  }, 900));

  zcOpenRealtimeTimers.set(timerKey, timers);
}

(function bindOpenRealtimeRenderEvents() {
  if (window.__ZC_HIST_OPEN_REALTIME_RENDER_BOUND__) return;
  window.__ZC_HIST_OPEN_REALTIME_RENDER_BOUND__ = true;

  const names = [
    'atendimento:mensagem-recebida',
    'zc:message-upsert',
    'zc:message-created',
    'zc:message-received',
    'zc:new-message',
    'atendimento:message',
    'atendimento:message-received',
    'ws:nova_mensagem',
  ];

  const handler = (ev) => {
    const detail = ev?.detail || {};
    zcQueueOpenRealtimeRender(detail, ev?.type || 'realtime-open');
  };

  for (const name of names) {
    try { document.addEventListener(name, handler, true); } catch {}
    try { window.addEventListener(name, handler, true); } catch {}
  }

  try { window.zcHistoricoClearOpenRealtimeWork = zcClearOpenRealtimeWork; } catch {}
  try { window.addEventListener('zc:navigate-away', (ev) => zcClearOpenRealtimeWork(ev?.detail?.reason || 'navigate-away'), true); } catch {}
  try { window.addEventListener('pagehide', () => zcClearOpenRealtimeWork('pagehide'), true); } catch {}
  try { window.addEventListener('beforeunload', () => zcClearOpenRealtimeWork('beforeunload'), true); } catch {}
})();

/* =====================
   paginação por clique
   ===================== */
let loadingOld = false;

export async function carregarMaisHistorico(id) {
  const hist = H();
  const convKey = getConversationKeySafe(id) || idKey(id);

  if (loadingOld) {
    HLOG('carregarMaisHistorico: já carregando');
    return false;
  }

  if (!convKey) {
    HERR('carregarMaisHistorico: id inválido', { id });
    return false;
  }

  if (!isHistoricoStillOpenFor(convKey, hist)) {
    HLOG('carregarMaisHistorico: hist não bate', {
      convKey,
      histCid: getOpenHistKey(hist),
    });
    return false;
  }

  if (hist.dataset.noMore === '1') {
    HLOG('carregarMaisHistorico: noMore=1', { convKey });
    setTopNoticeState('done');
    return false;
  }

  const entityId =
    idKey(hist?.dataset?.entityId) ||
    getConversationEntityIdSafe(convKey) ||
    null;

  if (!entityId) {
    HERR('carregarMaisHistorico: sem entityId', { convKey });
    return false;
  }

  loadingOld = true;
  showTopLoader();

  await nextPaint();

  const limit = HISTORICO_LIMIT;
  const off = getOffset(convKey);
  const beforeId = getOldestRenderedDbId(hist);

  try {
    const cursorPart = beforeId ? `&before_id=${encodeURIComponent(beforeId)}` : `&offset=${off}`;
    const url =
      `/api/atendimento/conversas/${encodeURIComponent(entityId)}/mensagens?empresa_id=${EMPRESA_ID}` +
      `&limit=${limit}${cursorPart}` +
      `&light=1` +
      `${getInstQuery(convKey)}` +
      `&__ts=${Date.now()}`;

    HLOG('carregarMaisHistorico: fetch', {
      url,
      convKey,
      entityId,
      limit,
      offset: off,
      before_id: beforeId || null,
    });

    const r = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
      },
    });

    HLOG('carregarMaisHistorico: resposta HTTP', {
      status: r.status,
    });

    if (!isHistoricoStillOpenFor(convKey, hist)) {
      HLOG('carregarMaisHistorico: resposta HTTP chegou, mas conversa mudou', { convKey });
      return false;
    }

    if (!r.ok) {
      setTopNoticeState('error');
      HLOG('carregarMaisHistorico: !ok', {
        convKey,
        status: r.status,
      });
      return false;
    }

    const data = await r.json();

    if (!isHistoricoStillOpenFor(convKey, hist)) {
      HLOG('carregarMaisHistorico: payload chegou, mas conversa mudou', { convKey });
      return false;
    }

    const items = sanitizeIncomingMessages(extractItems(data));
    const n = items.length;

    HLOG('carregarMaisHistorico: itens', {
      convKey,
      n,
      offset: off,
    });

    if (!n) {
      hist.dataset.noMore = '1';
      setTopNoticeState('done');
      HLOG('carregarMaisHistorico: n=0, noMore=1', { convKey });
      return false;
    }

    hist.__zcPreserveOldScrollUntil = Date.now() + 2200;

    mergeOld(getInstanciaForFetch(convKey), convKey, items);

    try {
      const inst = getInstanciaForFetch(convKey);
      window.cacheHistoricos[convKey] = ensureArray(getHist(inst, convKey));

      HLOG('carregarMaisHistorico: cacheHistoricos atualizado', {
        convKey,
        inst,
        total: window.cacheHistoricos[convKey]?.length || 0,
      });
    } catch (e) {
      HERR('carregarMaisHistorico: erro cache', e);
    }

    if (!isHistoricoStillOpenFor(convKey, hist)) {
      HLOG('carregarMaisHistorico: cache salvo, mas conversa mudou antes de inserir no DOM', { convKey });
      return false;
    }

    prependOldMessagesSemMexerTela(convKey, items);

    setOffset(convKey, off + n);

    try {
      window.syncPreviewFromCache?.(convKey);
    } catch (e) {
      HERR('carregarMaisHistorico: erro syncPreviewFromCache', e);
    }

    return true;
  } catch (e) {
    HERR('carregarMaisHistorico erro', e);

    try {
      console.error('[historico] carregarMaisHistorico', e);
    } catch {}

    setTopNoticeState('error');

    return false;
  } finally {
    loadingOld = false;

    if (hist?.dataset?.noMore === '1') {
      setTopNoticeState('done');
      hist.removeAttribute('data-loading-old');
    } else {
      hideTopLoader();
    }
  }
}

/* =====================
   Scroll binding dinâmico
   Agora NÃO busca automaticamente.
   Só garante que o aviso fique visível no topo.
   ===================== */
(function bindScroll() {
  const tryBind = () => {
    const hist = H();
    if (!hist || hist.__boundScroll) return;

    HLOG('bindScroll: bind em #historico');

    hist.addEventListener(
      'scroll',
      () => {
        if (!hist) return;
        if (historicoScrollGuardActive(hist)) return;

        const convKey = getConversationKeySafe(
          hist.dataset.conversationKey ||
          hist.dataset.conversationId ||
          hist.dataset.convKey ||
          hist.dataset.clienteId
        );

        if (!convKey) return;

        if (hist.scrollTop <= 80 && hist.dataset.noMore !== '1') {
          ensureTopNotice();
          setTopNoticeState(loadingOld ? 'loading' : 'idle');
        }
      },
      { passive: true }
    );

    hist.__boundScroll = true;
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryBind);
  else tryBind();

  const mo = new MutationObserver(tryBind);
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();

/* =====================
   Sync preview da lista
   ===================== */
window.syncPreviewFromCache = function syncPreviewFromCache(clienteId) {
  try {
    const convKey = getConversationKeySafe(clienteId) || idKey(clienteId);
    if (!convKey) return;

    let convTsMs = 0;
    let convObj = null;

    try {
      const lista = window.state?.clientesCache || window.clientesCache || [];

      convObj =
        lista.find((x) => {
          const k = getConversationKeySafe(
            x?.conversation_key ??
            x?.conversation_id ??
            x?.id ??
            x?.cliente_id ??
            x?.grupo_id ??
            null,
            x
          );

          return idEq(k, convKey);
        }) || null;

      if (convObj) {
        const rawTs =
          convObj.hora ??
          convObj.last_ts ??
          convObj.ultima_ts ??
          convObj.updated_at ??
          convObj.last_message_at ??
          convObj.timestamp ??
          null;

        if (rawTs) {
          let d = null;

          try {
            d = parseAtendimentoDate(rawTs);
          } catch {
            d = null;
          }

          if (!d || Number.isNaN(d.getTime())) d = new Date(rawTs);
          if (d && !Number.isNaN(d.getTime())) convTsMs = d.getTime();
        }
      }
    } catch (e) {
      HERR('syncPreviewFromCache: erro ao ler lista', e);
    }

    let arr = Array.isArray(window.cacheHistoricos?.[convKey])
      ? window.cacheHistoricos[convKey]
      : null;

    if (!arr || !arr.length) {
      let inst = null;

      try {
        const lista = window.state?.clientesCache || window.clientesCache || [];
        const c = convObj || lista.find((x) => {
          const k = getConversationKeySafe(
            x?.conversation_key ??
            x?.conversation_id ??
            x?.id ??
            x?.cliente_id ??
            x?.grupo_id ??
            null,
            x
          );

          return idEq(k, convKey);
        });

        inst =
          c?.instancia_id ??
          c?.instancia ??
          parseConversationKey(convKey)?.instId ??
          window.INSTANCIA_ATIVA ??
          null;
      } catch (e) {
        HERR('syncPreviewFromCache: erro ao inferir inst', e);
      }

      arr = getHist(inst, convKey) || [];
    }

    if (!arr || !arr.length) {
      return;
    }

    arr = removeOptimisticDuplicates(arr.map(normalizeMessageState)).map(normalizeMessageState);

    const last = arr[arr.length - 1];

    let tsIso =
      last.timestamp ||
      last.data ||
      last.created_at ||
      last.hora ||
      null;

    if (!tsIso && last.ts) {
      const d = new Date(last.ts);
      if (!Number.isNaN(d.getTime())) tsIso = d.toISOString();
    }

    if (!tsIso) {
      if (window.Lista?.updatePreview && last?.ack != null) {
        window.Lista.updatePreview(convKey, {
          ack: Number(last.ack || 0),
        });
      }
      return;
    }

    let histTsMs = 0;

    try {
      let d = parseAtendimentoDate(tsIso);
      if (!d || Number.isNaN(d.getTime())) d = new Date(tsIso);
      if (d && !Number.isNaN(d.getTime())) histTsMs = d.getTime();
    } catch (e) {
      HERR('syncPreviewFromCache: erro parse tsIso', {
        tsIso,
        e,
      });
    }

    const textoRaw = msgText(last);
    const outbound = isSaidaMsg(last);
    const ackVal = outbound ? (Number(last.ack ?? 0) || 0) : undefined;

    if (convTsMs && histTsMs && histTsMs <= convTsMs) {
      if (window.Lista?.updatePreview && ackVal != null) {
        window.Lista.updatePreview(convKey, {
          ack: ackVal,
        });
      }
      return;
    }

    if (window.Lista?.updatePreview) {
      window.Lista.updatePreview(convKey, {
        texto: textoRaw,
        ts: tsIso,
        ack: ackVal,
      });
    }
  } catch (e) {
    HERR('syncPreviewFromCache erro', e);
  }
};

/* =====================
   globais/compat
   ===================== */
window.renderHistoricoDoCache = renderHistoricoDoCache;
window.salvarNoCache = salvarNoCache;
window.abrirHistorico = abrirHistorico;
window.carregarHistoricoCliente = abrirHistorico;

window.forcarAtualizacaoHistorico = forcarAtualizacaoHistorico;
window.zcForceHistoryRefresh = forcarAtualizacaoHistorico;

window.carregarMaisHistorico = carregarMaisHistorico;

try {
  window.getHist = getHist;
  window.primeWith = primeWith;
  window.mergeOld = mergeOld;
} catch {}