// /frontend/js/atendimentos/domain/historico.js
// Histórico com paginação “puxar pra cima” + ACK único + persistência LS + merge de ACK
// ✅ #historico buscado dinamicamente (H()) em todas as funções
// ✅ Render de mídias/áudio fica no media-render.js (player WPP), historico só delega
// ✅ Divisores de data (Hoje / Ontem / dd/mm/aaaa) estilo WhatsApp Web
// ✅ FIX: evita auto-paginação logo após abrir/renderizar conversa
// ✅ FIX: syncPreviewFromCache silencioso quando não existe cache
// ✅ FIX: logs controlados por window.HIST_DEBUG === true
// ✅ Alinhado com conversation_key canônica:
//    c:<cliente_id>:<instancia_id> e g:<grupo_id>:<instancia_id>
// ✅ Busca backend sempre por entity_id da conversa, mantendo cache por conversation_key
// ✅ Resposta/quote renderizada dentro da bolha, igual WhatsApp
// ✅ TRAVA: resposta atrasada não sobrescreve conversa atual
// ✅ Aceita payload array, {items}, {data}, {results}, {mensagens}, {messages}
// ✅ Escuta eventos de refresh após envio/WS e busca mensagens novas do backend
// ✅ Compat com envio otimista: tmp msg, reloginho, ack, falha, dedupe temp -> real
// ✅ Exports compat: window.carregarHistoricoCliente / window.forcarAtualizacaoHistorico

import { formatChatTime, parseAtendimentoDate } from '../core/time.js';
import { getHist, primeWith, mergeOld } from '../domain/hist-cache.js';
import { EMPRESA_ID } from '../core/env.js';
import { getConversationKey, getConversationEntityId, getConversationKind } from '../state/store.js';

// ✅ IMPORT CORRETO: media-render é UI
import '../ui/media-render.js';

export const HISTORICO_LIMIT = 20;
const H = () => document.getElementById('historico');

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

  // Se ainda não tem chave setada, não bloqueia.
  // Mas quando já tem, precisa bater 100%.
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

/* =====================
   Loader “puxar pra cima”
   ===================== */
function ensureTopLoader() {
  const hist = H();
  if (!hist) return null;

  let l = hist.querySelector('.hist-loader');
  if (!l) {
    l = document.createElement('div');
    l.className = 'hist-loader';
    l.innerHTML = `<div class="spinner" aria-hidden="true"></div><div class="txt">Carregando mensagens…</div>`;
    hist.insertAdjacentElement('afterbegin', l);
  }
  return l;
}

function showTopLoader() {
  const hist = H();
  if (!hist) return;
  ensureTopLoader();
  hist.setAttribute('data-loading-old', '1');
}

function hideTopLoader() {
  const hist = H();
  if (!hist) return;
  hist.removeAttribute('data-loading-old');
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

function isTempMsg(m) {
  const k = msgKey(m);
  return (
    k.startsWith('tmp:') ||
    m?.temp === true ||
    m?.pending === true ||
    m?.optimistic === true ||
    m?.__optimistic === true
  );
}

function isSaidaMsg(m) {
  return m?.tipo === 'saida' || m?.from_me === true || m?.origem === 'atendente';
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

  return { html, lastDayKey: last };
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

    const m = byId.get(k);
    const bubble = row.querySelector('.bubble');
    const failed = m.failed === true || Number(m.ack ?? 0) < 0;
    const pending = !failed && (m.pending === true || Number(m.ack ?? 0) <= 0) && isSaidaMsg(m);

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
   Persistência LS
   ===================== */
if (!window.cacheHistoricos) window.cacheHistoricos = {};

if (!window.salvarCache) {
  window.salvarCache = () => {
    try {
      const LS_HIST = `cacheHistoricos:${EMPRESA_ID}`;
      localStorage.setItem(LS_HIST, JSON.stringify(window.cacheHistoricos || {}));
      HLOG('salvarCache: gravado no LS', LS_HIST);
    } catch (e) {
      HERR('salvarCache: erro ao gravar no LS', e);
    }
  };
}

/* ====== Hidrata cache do LS pra sobreviver ao F5 ====== */
(function hydrateHistFromLocalStorage() {
  try {
    const LS_HIST = `cacheHistoricos:${EMPRESA_ID}`;
    const raw = localStorage.getItem(LS_HIST);
    if (!raw) {
      HLOG('hydrate: sem cache para', LS_HIST);
      return;
    }

    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return;

    HLOG('hydrate: carregando cache', { key: LS_HIST, convs: Object.keys(data).length });
    window.cacheHistoricos = data;

    Object.keys(data).forEach((storedKey) => {
      const cid = getConversationKeySafe(storedKey) || idKey(storedKey);
      if (!cid) return;

      const arr = Array.isArray(data[storedKey]) ? data[storedKey] : [];
      const groups = new Map();

      for (const m of arr) {
        const inst = (m && (m.instancia_id ?? m.instancia)) ?? parseConversationKey(cid)?.instId ?? null;
        const key = `${inst}::${cid}`;
        if (!groups.has(key)) groups.set(key, { inst, items: [] });
        groups.get(key).items.push(m);
      }

      groups.forEach(({ inst, items }) => {
        try {
          primeWith(inst, cid, items, null);
          HLOG('hydrate: primeWith', { inst, cid, count: items.length });
        } catch (e) {
          HERR('hydrate: erro no primeWith', { inst, cid, e });
        }
      });

      if (storedKey !== cid) {
        try {
          window.cacheHistoricos[cid] = arr;
        } catch {}
      }
    });
  } catch (e) {
    HERR('hydrate: erro geral', e);
  }
})();

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

    HLOG('getInstanciaForFetch', { instRaw: inst, inst });
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

  HLOG('getInstQuery', { inst, query: q });
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
    (Array.isArray(novos) ? (novos[0]?.instancia_id ?? novos[0]?.instancia ?? parseConversationKey(convKey)?.instId ?? null) : null) ||
    parseConversationKey(convKey)?.instId ||
    null;

  HLOG('salvarNoCache IN', { convKey, inst, novosCount: Array.isArray(novos) ? novos.length : 0 });

  const cur = ensureArray(getHist(inst, convKey));
  const merged = [...cur, ...ensureArray(novos)];

  const byId = new Map();
  const noId = [];

  for (const m of merged) {
    const k = msgKey(m);

    if (k) {
      const prev = byId.get(k);

      if (!prev) {
        byId.set(k, m);
      } else {
        const ack = Math.max(Number(prev.ack || 0), Number(m.ack || 0));

        const prevTs = parseAtendimentoDate(prev.timestamp || prev.data || prev.created_at || '')?.getTime() || 0;
        const curTs = parseAtendimentoDate(m.timestamp || m.data || m.created_at || '')?.getTime() || 0;

        const ts =
          curTs > prevTs
            ? (m.timestamp || m.data || m.created_at)
            : (prev.timestamp || prev.data || prev.created_at);

        byId.set(k, {
          ...prev,
          ...m,
          msg_id: m.msg_id || prev.msg_id || m.message_id || prev.message_id || m.wa_msg_id || prev.wa_msg_id || m.id || prev.id,
          ack,
          timestamp: ts,
          quoted: m.quoted ?? prev.quoted,
          quoted_preview: m.quoted_preview ?? prev.quoted_preview,
        });
      }
    } else {
      noId.push(m);
    }
  }

  const deduped = removeOptimisticDuplicates([...byId.values(), ...noId]);
  const finalArr = ordenarMensagens(deduped);

  HLOG('salvarNoCache OUT', { convKey, inst, total: finalArr.length });

  primeWith(inst, convKey, finalArr, null);
  window.cacheHistoricos[convKey] = finalArr;
  window.salvarCache?.();
}

/* =====================
   render de 1 mensagem
   ===================== */
export function criarHTMLDaMensagem(m) {
  if (typeof window.criarHTMLDaMensagem === 'function') {
    return window.criarHTMLDaMensagem(m);
  }

  const isSaida = isSaidaMsg(m);
  const texto = String(m.conteudo ?? m.mensagem ?? m.texto ?? '').trim();
  const ackVal = Number(m.ack ?? 0);
  const msgIdAttr = msgKey(m);
  const msgIdEsc = escapeHtml(msgIdAttr);

  const pending = isSaida && !m.failed && ackVal <= 0;
  const failed = isSaida && (m.failed === true || ackVal < 0);

  const quotedPreview = normalizeQuotedPreview(m);
  const quotedPreviewAttr = quotedPreview ? jsonAttr(quotedPreview) : '';
  const quotedAttr = m?.quoted && typeof m.quoted === 'object' ? jsonAttr(m.quoted) : '';

  const ackHtml = renderAckHtml(m);
  const quoteHtml = renderQuotedPreview(quotedPreview);

  const textHtml = texto
    ? `<div class="msg-text">${escapeHtml(texto)}</div>`
    : `<div class="msg-text">&nbsp;</div>`;

  const quotedPreviewData = quotedPreviewAttr
    ? ` data-quoted-preview="${quotedPreviewAttr}"`
    : '';

  const quotedData = quotedAttr
    ? ` data-quoted="${quotedAttr}"`
    : '';

  return `<div class="msg-row ${isSaida ? 'msg-sent' : 'msg-received'}${pending ? ' is-pending' : ''}${failed ? ' is-failed' : ''}${isSaida && !pending && !failed ? ' is-sent' : ''}"
      data-id="${msgIdEsc}"
      data-msg-id="${msgIdEsc}"
      data-message-id="${msgIdEsc}"
      data-wa-msg-id="${msgIdEsc}"
      data-from-me="${isSaida ? '1' : '0'}"
      data-pending="${pending ? '1' : '0'}"
      data-failed="${failed ? '1' : '0'}"${quotedPreviewData}${quotedData}>
    <div class="bubble ${isSaida ? 'bubble-out' : 'bubble-in'}${pending ? ' is-pending' : ''}${failed ? ' is-failed' : ''}${isSaida && !pending && !failed ? ' is-sent' : ''}"
        data-msg-id="${msgIdEsc}"
        data-message-id="${msgIdEsc}"
        data-wa-msg-id="${msgIdEsc}"
        data-from-me="${isSaida ? '1' : '0'}"
        data-pending="${pending ? '1' : '0'}"
        data-failed="${failed ? '1' : '0'}"${quotedPreviewData}${quotedData}>
      ${quoteHtml}
      ${textHtml}
      <div class="meta">
        ${ackHtml}
        <span class="msg-time">${formatChatTime(m.timestamp || m.data || m.created_at || '')}</span>
      </div>
    </div>
  </div>`;
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

  const msgs = ordenarMensagens(removeOptimisticDuplicates(ensureArray(getHist(inst, convKey))));

  HLOG('renderHistoricoDoCache', { convKey, inst, append, msgsCount: msgs.length });

  ensureTopLoader();

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
    ensureTopLoader();

    const { html, lastDayKey } = renderMsgsWithDividers(msgs, null);

    if (!isHistoricoStillOpenFor(convKey, hist)) return;

    hist.insertAdjacentHTML('beforeend', html);

    stripAckReceived();
    updateExistingRowsFromCache(hist, msgs);
    setHistLastDayKey(hist, lastDayKey);

    hist.scrollTop = hist.scrollHeight;
    requestAnimationFrame(() => {
      if (!isHistoricoStillOpenFor(convKey, hist)) return;
      try { hist.scrollTop = hist.scrollHeight; } catch {}
      armHistoricoScrollGuard();
    });
    setTimeout(() => armHistoricoScrollGuard(), 60);
  } else {
    if (!isHistoricoStillOpenFor(convKey, hist)) return;

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
      ensureTopLoader();

      const { html, lastDayKey } = renderMsgsWithDividers(msgs, null);

      if (!isHistoricoStillOpenFor(convKey, hist)) return;

      hist.insertAdjacentHTML('beforeend', html);

      stripAckReceived();
      updateExistingRowsFromCache(hist, msgs);
      setHistLastDayKey(hist, lastDayKey);
      hist.scrollTop = hist.scrollHeight;

      requestAnimationFrame(() => {
        if (!isHistoricoStillOpenFor(convKey, hist)) return;
        try { hist.scrollTop = hist.scrollHeight; } catch {}
        armHistoricoScrollGuard();
      });

      setTimeout(() => armHistoricoScrollGuard(), 60);
    } else {
      updateExistingRowsFromCache(hist, msgs);

      const lastRenderedId = getLastRenderedMsgId(hist);
      let startIdx = -1;

      if (lastRenderedId) {
        startIdx = msgs.findIndex((m) => msgKey(m) === String(lastRenderedId));
      }

      let novas = [];
      if (startIdx >= 0) {
        novas = msgs.slice(startIdx + 1);
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
        // Mesmo sem mensagem nova, pode ter ACK novo / pending -> sent.
        updateExistingRowsFromCache(hist, msgs);
      }

      stripAckReceived();
      hist.scrollTop = hist.scrollHeight;

      requestAnimationFrame(() => {
        if (!isHistoricoStillOpenFor(convKey, hist)) return;
        try { hist.scrollTop = hist.scrollHeight; } catch {}
        armHistoricoScrollGuard();
      });

      setTimeout(() => armHistoricoScrollGuard(), 60);
    }
  }

  try { window.ensureMsgMediaCss?.(); } catch {}
  try { window.initAudioPlayers?.(hist); } catch {}
  try { window.initMediaFallbacks?.(hist); } catch {}

  try {
    window.reconcilePendingAcks?.();
  } catch (e) {
    HERR('renderHistoricoDoCache: reconcilePendingAcks erro', e);
  }

  try {
    window.dispatchEvent(new CustomEvent('historico:rendered', {
      detail: { conversation_key: convKey, conversation_id: convKey, instancia_id: inst }
    }));
  } catch {}
}

/* =====================
   append util
   ===================== */
export function appendToHistory(clienteId, msg) {
  const convKey = getConversationKeySafe(clienteId) || idKey(clienteId);
  HLOG('appendToHistory', { convKey, msgId: msgKey(msg) || null });
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
  HLOG('getOffset', { convKey, offset: v });
  return v;
}

function setOffset(id, val) {
  const convKey = getConversationKeySafe(id) || idKey(id);
  if (!convKey) return;
  const table = getOffsetsObj();
  table[convKey] = Number(val) || 0;
  HLOG('setOffset', { convKey, offset: table[convKey] });
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
    HERR('abrirHistorico: conversa inválida', { id, convKey, entityId });
    return false;
  }

  try {
    const header = document.getElementById('chat-header');
    const footer = document.getElementById('chat-footer');
    const welcome = document.getElementById('welcome-screen');

    if (header) header.style.display = '';
    if (footer) footer.style.display = '';
    hist.style.display = '';

    if (welcome) welcome.style.display = 'none';
    document.body.dataset.chatOpen = '1';
  } catch (e) {
    HERR('abrirHistorico: erro ao exibir UI', e);
  }

  setOpenHistRef(hist, ref);
  hist.dataset.noMore = '0';

  try {
    const url =
      `/api/atendimento/conversas/${encodeURIComponent(entityId)}/mensagens` +
      `?empresa_id=${EMPRESA_ID}` +
      `&limit=${HISTORICO_LIMIT}` +
      getInstQuery(convKey) +
      `&__ts=${Date.now()}`;

    HLOG('abrirHistorico: fetch', { url, convKey, entityId });

    const r = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });

    HLOG('abrirHistorico: resposta HTTP', { status: r.status });

    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const data = await r.json();

    if (!isHistoricoStillOpenFor(convKey, hist)) {
      HLOG('abrirHistorico: resposta ignorada, conversa mudou', { convKey });
      return false;
    }

    const items = extractItems(data);

    HLOG('abrirHistorico: itens recebidos', { convKey, count: items.length });

    if (items.length) salvarNoCache(convKey, items);

    if (!isHistoricoStillOpenFor(convKey, hist)) {
      HLOG('abrirHistorico: cache salvo, mas conversa mudou antes de render', { convKey });
      return false;
    }

    try {
      const inst = getInstanciaForFetch(convKey);
      const total = ensureArray(getHist(inst, convKey)).length;
      HLOG('abrirHistorico: setOffset total', { convKey, total, inst });
      setOffset(convKey, total);
    } catch (e) {
      HERR('abrirHistorico: erro ao calcular offset', e);
    }

    renderHistoricoDoCache(convKey, false);

    try {
      window.syncPreviewFromCache?.(convKey);
    } catch (e) {
      HERR('abrirHistorico: erro syncPreviewFromCache', e);
    }

    return true;
  } catch (e) {
    HERR('abrirHistorico erro', e);
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
    (kind === 'g' ? (d.grupo_id ?? d.grupoId) : (d.cliente_id ?? d.clienteId)) ??
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
    HLOG('forcarAtualizacaoHistorico: sem convKey/entityId', { rawConversation, ref });
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
    `&limit=${limit}` +
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
      headers: { 'Cache-Control': 'no-cache' },
    });

    HLOG('forcarAtualizacaoHistorico: resposta HTTP', { status: r.status, seq: mySeq });

    if (!r.ok) return false;

    const data = await r.json();

    if (!isHistoricoStillOpenFor(convKey, hist)) {
      HLOG('forcarAtualizacaoHistorico: resposta ignorada, conversa mudou', { convKey });
      return false;
    }

    const items = extractItems(data);

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

  forceRefreshTimer = setTimeout(() => {
    forceRefreshTimer = null;

    if (forceRefreshInFlight) {
      HLOG('agendarRefreshHistorico: já existe fetch em andamento, aguardando');
      forceRefreshInFlight.finally(() => {
        forcarAtualizacaoHistorico(convObj, {
          append: true,
          reason: `${reason}:after-inflight`,
        }).catch(() => {});
      });
      return;
    }

    forceRefreshInFlight = forcarAtualizacaoHistorico(convObj, {
      append: true,
      reason,
    });

    forceRefreshInFlight
      .then((ok) => {
        // Retry leve: se o evento chegou antes do backend terminar de salvar,
        // tenta de novo sem piscar e sem rebuild total.
        if (!ok && isHistoricoStillOpenFor(convKey, H())) {
          setTimeout(() => {
            forcarAtualizacaoHistorico(convObj, {
              append: true,
              reason: `${reason}:retry`,
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
    'atendimento:mensagem-recebida',
    'zc:message-upsert',
    'zc:message-created',
  ];

  const handler = (ev) => {
    const detail = ev?.detail || {};

    // Não força fetch no evento de criação otimista,
    // porque essa mensagem já entrou no cache local e renderizou na hora.
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
   paginação scroll up
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
    HLOG('carregarMaisHistorico: hist não bate', { convKey, histCid: getOpenHistKey(hist) });
    return false;
  }

  if (hist.dataset.noMore === '1') {
    HLOG('carregarMaisHistorico: noMore=1', { convKey });
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

  const limit = HISTORICO_LIMIT;
  const off = getOffset(convKey);

  try {
    const url =
      `/api/atendimento/conversas/${encodeURIComponent(entityId)}/mensagens?empresa_id=${EMPRESA_ID}` +
      `&limit=${limit}&offset=${off}` +
      `${getInstQuery(convKey)}` +
      `&__ts=${Date.now()}`;

    HLOG('carregarMaisHistorico: fetch', { url, convKey, entityId, limit, offset: off });

    const r = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });

    HLOG('carregarMaisHistorico: resposta HTTP', { status: r.status });

    if (!isHistoricoStillOpenFor(convKey, hist)) {
      HLOG('carregarMaisHistorico: resposta HTTP chegou, mas conversa mudou', { convKey });
      return false;
    }

    if (!r.ok) {
      hist.dataset.noMore = '1';
      HLOG('carregarMaisHistorico: !ok, noMore=1', { convKey, status: r.status });
      return false;
    }

    const data = await r.json();

    if (!isHistoricoStillOpenFor(convKey, hist)) {
      HLOG('carregarMaisHistorico: payload chegou, mas conversa mudou', { convKey });
      return false;
    }

    const items = extractItems(data);
    const n = items.length;

    HLOG('carregarMaisHistorico: itens', { convKey, n, offset: off });

    if (!n) {
      hist.dataset.noMore = '1';
      HLOG('carregarMaisHistorico: n=0, noMore=1', { convKey });
      return false;
    }

    const beforeHeight = hist.scrollHeight;

    mergeOld(getInstanciaForFetch(convKey), convKey, items);

    try {
      const inst = getInstanciaForFetch(convKey);
      window.cacheHistoricos[convKey] = ensureArray(getHist(inst, convKey));
      HLOG('carregarMaisHistorico: cacheHistoricos atualizado', {
        convKey,
        inst,
        total: window.cacheHistoricos[convKey]?.length || 0,
      });
      window.salvarCache?.();
    } catch (e) {
      HERR('carregarMaisHistorico: erro cache/salvar', e);
    }

    if (!isHistoricoStillOpenFor(convKey, hist)) {
      HLOG('carregarMaisHistorico: cache salvo, mas conversa mudou antes de render', { convKey });
      return false;
    }

    const prevBottom = beforeHeight - hist.scrollTop;
    renderHistoricoDoCache(convKey, false);

    if (!isHistoricoStillOpenFor(convKey, hist)) return false;

    hist.scrollTop = hist.scrollHeight - prevBottom;
    armHistoricoScrollGuard();

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
    return false;
  } finally {
    hideTopLoader();
    loadingOld = false;
  }
}

/* =====================
   Scroll binding dinâmico
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
        if (loadingOld) return;
        if (hist.dataset.noMore === '1') return;

        const convKey = getConversationKeySafe(hist.dataset.conversationKey || hist.dataset.conversationId || hist.dataset.convKey || hist.dataset.clienteId);
        if (!convKey) return;

        if (hist.scrollTop <= 60) {
          HLOG('bindScroll: topo => carregarMaisHistorico', { convKey });
          carregarMaisHistorico(convKey);
        }
      },
      { passive: true }
    );

    hist.__boundScroll = true;
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryBind);
  else tryBind();

  const mo = new MutationObserver(tryBind);
  mo.observe(document.documentElement, { childList: true, subtree: true });
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
            x?.conversation_key ?? x?.conversation_id ?? x?.id ?? x?.cliente_id ?? x?.grupo_id ?? null,
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

    let arr = Array.isArray(window.cacheHistoricos?.[convKey]) ? window.cacheHistoricos[convKey] : null;

    if (!arr || !arr.length) {
      let inst = null;

      try {
        const lista = window.state?.clientesCache || window.clientesCache || [];
        const c = convObj || lista.find((x) => {
          const k = getConversationKeySafe(
            x?.conversation_key ?? x?.conversation_id ?? x?.id ?? x?.cliente_id ?? x?.grupo_id ?? null,
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

    arr = removeOptimisticDuplicates(arr);

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
        window.Lista.updatePreview(convKey, { ack: Number(last.ack || 0) });
      }
      return;
    }

    let histTsMs = 0;
    try {
      let d = parseAtendimentoDate(tsIso);
      if (!d || Number.isNaN(d.getTime())) d = new Date(tsIso);
      if (d && !Number.isNaN(d.getTime())) histTsMs = d.getTime();
    } catch (e) {
      HERR('syncPreviewFromCache: erro parse tsIso', { tsIso, e });
    }

    const textoRaw = msgText(last);
    const outbound = isSaidaMsg(last);
    const ackVal = outbound ? (Number(last.ack ?? 0) || 0) : undefined;

    if (convTsMs && histTsMs && histTsMs <= convTsMs) {
      if (window.Lista?.updatePreview && ackVal != null) {
        window.Lista.updatePreview(convKey, { ack: ackVal });
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

// ✅ Compat com códigos antigos que procuram essa função
window.carregarHistoricoCliente = abrirHistorico;

// ✅ Função para testar no console
window.forcarAtualizacaoHistorico = forcarAtualizacaoHistorico;
window.zcForceHistoryRefresh = forcarAtualizacaoHistorico;

try {
  window.getHist = getHist;
  window.primeWith = primeWith;
  window.mergeOld = mergeOld;
} catch {}