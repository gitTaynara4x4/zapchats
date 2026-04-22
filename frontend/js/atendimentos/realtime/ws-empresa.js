// /frontend/js/atendimentos/ws/ws-empresa.js
// ====================================================================
// WebSocket da EMPRESA + da INSTÂNCIA ATIVA (tempo real)
// - Trata: nova mensagem, ACK, reloads segmentados, conv_status, pin/unpin
// - Trata: messages_delete (apagada pelo cliente/usuário)
// - Reconexão com backoff + heartbeat (ping/pong) + medidor de lag
// - Idempotência básica (merge do eco local por texto+tempo)
// - Ajustes: unwrap de payloads aninhados; mapear cliente por telefone
// - Ajustes: força render quando o chat aberto é o alvo (mesmo sem inst)
// ✅ FIX GRUPOS: cliente_id SEM Number() (BigInteger vira string)
// ✅ STORE: usa base nova do state/store.js
// ✅ FIX HORÁRIO: não usa Date.now() para sobrescrever preview antigo
// ====================================================================

import { tsToMillis } from '../core/time.js';
import { renderHistoricoDoCache } from '../domain/historico.js';
import { _matchInstancia } from '../domain/instances.js';
import { pushOneNew, getHist, primeWith } from '../domain/hist-cache.js';

import {
  state,
  mergeIncomingMessage,
  updateAck,
  moveConversaToTopKeyed,
  replaceOrInsertConversa,
  marcarLidas
} from '../state/store.js';

import { EMPRESA_ID as EMPRESA_ID_ENV } from '../core/env.js';

const EMPRESA_ID = Number(
  EMPRESA_ID_ENV ||
  window.EMPRESA_ID ||
  localStorage.getItem('empresa_id') ||
  0
);

// Ative/desative logs rápidos no console
const DEBUG_WS = (window.DEBUG_WS ?? true);

// ========================= CID estável por aba =========================
const WS_CID = (() => {
  try {
    const KEY = 'ws_cid';
    let v = sessionStorage.getItem(KEY);
    if (!v) {
      v = (crypto?.randomUUID?.() || `cid-${Math.random().toString(16).slice(2)}-${Date.now()}`);
      sessionStorage.setItem(KEY, v);
    }
    return v;
  } catch {
    return `cid-${Date.now()}`;
  }
})();

// ========================= helpers: ids (string-first) =========================
function idKey(v) {
  const s = String(v ?? '').trim();
  if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
  return s;
}

function idEq(a, b) {
  const A = idKey(a);
  const B = idKey(b);
  if (!A || !B) return false;
  return A === B;
}

function onlyDigits(s) {
  return String(s || '').replace(/\D+/g, '');
}

// ========================= helpers: conversa no store =========================
function getAllConversations() {
  const out = [];
  const seen = new Set();

  try {
    if (Array.isArray(state?.clientesCache)) {
      for (const c of state.clientesCache) {
        const k = idKey(c?.conversation_id ?? c?.id ?? c?.cliente_id);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(c);
      }
    }

    const convsByInst = state?.convsByInst || {};
    for (const box of Object.values(convsByInst)) {
      const items = Array.isArray(box?.items) ? box.items : [];
      for (const c of items) {
        const k = idKey(c?.conversation_id ?? c?.id ?? c?.cliente_id);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(c);
      }
    }

    if (Array.isArray(state?.todosContatosCache)) {
      for (const c of state.todosContatosCache) {
        const k = idKey(c?.conversation_id ?? c?.id ?? c?.cliente_id);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(c);
      }
    }
  } catch {}

  return out;
}

function getConversaById(cid, preferredInst = null) {
  const key = idKey(cid);
  if (!key) return null;

  const all = getAllConversations();

  if (preferredInst != null) {
    const preferred = all.find(c => {
      const ck = idKey(c?.conversation_id ?? c?.id ?? c?.cliente_id);
      const ik = idKey(c?.instancia_id ?? c?.instancia ?? null);
      return ck === key && (!preferredInst || ik === idKey(preferredInst));
    });
    if (preferred) return preferred;
  }

  return all.find(c => idKey(c?.conversation_id ?? c?.id ?? c?.cliente_id) === key) || null;
}

function getConversaIdByPhone(phone, preferredInst = null) {
  const p = onlyDigits(phone);
  if (!p) return null;

  const all = getAllConversations();

  const sameInst = preferredInst != null
    ? all.find(c => {
        const t = onlyDigits(c?.telefone || c?.phone || c?.remoteJid || c?.jid || '');
        const ik = idKey(c?.instancia_id ?? c?.instancia ?? null);
        return t && (t.endsWith(p) || p.endsWith(t)) && ik === idKey(preferredInst);
      })
    : null;

  if (sameInst) {
    return idKey(sameInst.conversation_id ?? sameInst.id ?? sameInst.cliente_id);
  }

  const hit = all.find(c => {
    const t = onlyDigits(c?.telefone || c?.phone || c?.remoteJid || c?.jid || '');
    return t && (t.endsWith(p) || p.endsWith(t));
  });

  return hit ? idKey(hit.conversation_id ?? hit.id ?? hit.cliente_id) : null;
}

// ========================= contexto aberto (cliente + instância) =========================
function getOpenContext() {
  try {
    const hist = document.getElementById('historico');
    const cidDom = hist?.dataset?.clienteId ?? null;
    const instDom = hist?.dataset?.instanciaId ?? null;

    const cidState = idKey(
      state?.clienteSel?.id ??
      state?.clienteSel?.conversation_id ??
      state?.clienteSel?.cliente_id ??
      null
    );

    const instState = (
      state?.clienteSel?.instancia_id ??
      state?.clienteSel?.instancia ??
      window.INSTANCIA_ATIVA ??
      null
    );

    return {
      cliente_id: idKey(cidDom) || cidState || null,
      instancia_id: (instDom ?? instState ?? null)
    };
  } catch {
    return { cliente_id: null, instancia_id: null };
  }
}

function isOpenChat(cliente_id) {
  try {
    const oc = getOpenContext();
    return idEq(oc?.cliente_id, cliente_id);
  } catch {
    return false;
  }
}

function isChatActive(cliente_id) {
  try {
    const hist = document.getElementById('historico');
    const visible = !!hist && hist.style.display !== 'none';
    const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    return isOpenChat(cliente_id) && visible && focused;
  } catch {
    return false;
  }
}

// Sempre carimba/atualiza a instância no DOM do histórico
function ensureDomContextFor(cliente_id, instancia_id) {
  try {
    const hist = document.getElementById('historico');
    if (!hist) return false;

    const cid = idKey(cliente_id);
    if (!cid) return false;

    if (!hist.dataset?.clienteId || hist.dataset.clienteId === '0' || hist.dataset.clienteId === 'null') {
      hist.dataset.clienteId = String(cid);
    }

    if (hist.dataset?.clienteId !== String(cid)) return false;

    const newInst = String(instancia_id ?? '');
    if (
      newInst &&
      (
        !hist.dataset.instanciaId ||
        hist.dataset.instanciaId === 'null' ||
        hist.dataset.instanciaId !== newInst
      )
    ) {
      hist.dataset.instanciaId = newInst;
    }

    return true;
  } catch {
    return false;
  }
}

// ========================= WS infra =========================
function wsUrlEmpresa(id) {
  const proto = (location.protocol === 'https:') ? 'wss' : 'ws';
  const qs = new URLSearchParams({ cid: WS_CID });
  return `${proto}://${location.host}/ws/emp:${id}?${qs.toString()}`;
}

function wsUrlInst(instanceKey, { wantQR = false } = {}) {
  const proto = (location.protocol === 'https:') ? 'wss' : 'ws';
  const qs = new URLSearchParams({ cid: WS_CID, want_qr: wantQR ? '1' : '0' });
  return `${proto}://${location.host}/ws/inst:${encodeURIComponent(instanceKey)}?${qs.toString()}`;
}

function resolveInstTopic() {
  const sel = window.state?.instanciaSelecionada ?? window.INSTANCIA_ATIVA ?? null;
  if (!sel) return null;

  const s = String(sel);
  if (/\D/.test(s)) return s;

  try {
    const arr = window.state?.instancias || window.INSTANCIAS || [];
    const it = arr.find(x => String(x?.instancia_id ?? x?.id) === s || String(x?.id) === s);
    const name = it?.instance_name || it?.instancia || it?.nome || null;
    return name || s;
  } catch {
    return s;
  }
}

function resolveInstanceName(instKey) {
  const raw = String(instKey ?? '').trim();
  if (!raw) return null;

  try {
    const arr = window.state?.instancias || window.INSTANCIAS || [];

    const byId =
      arr.find(x => String(x?.instancia_id ?? x?.id ?? x?.instance_id ?? '') === raw) ||
      arr.find(x => String(x?.id ?? '') === raw);
    if (byId) return (byId.apelido || byId.nome || byId.instance_name || byId.instancia || null);

    const q = raw.toLowerCase();
    const byName =
      arr.find(x => String(x?.instance_name || '').toLowerCase() === q) ||
      arr.find(x => String(x?.instancia || '').toLowerCase() === q) ||
      arr.find(x => String(x?.nome || '').toLowerCase() === q);
    if (byName) return (byName.apelido || byName.nome || byName.instance_name || byName.instancia || null);

    return null;
  } catch {
    return null;
  }
}

let sockEmp = null;
let sockInst = null;
let hbEmpTimer = null;
let hbInstTimer = null;
let lagTimer = null;
let retryBaseEmp = 800;
let retryBaseInst = 800;
let closedEmpByMe = false;
let closedInstByMe = false;
let lastServerTs = 0;

function heartbeat(ws) {
  try { ws?.send?.('ping'); } catch {}
}

function scheduleHeartbeat(ws, which = 'emp') {
  clearInterval(which === 'inst' ? hbInstTimer : hbEmpTimer);
  const id = setInterval(() => heartbeat(ws), 30000);
  if (which === 'inst') hbInstTimer = id;
  else hbEmpTimer = id;
}

function jitter(ms) {
  const delta = Math.round(ms * 0.2);
  return ms + Math.round((Math.random() * 2 - 1) * delta);
}

function backoff(fn, baseRef) {
  const wait = Math.min(baseRef.val, 10000);
  const withJitter = Math.max(250, jitter(wait));
  setTimeout(fn, withJitter);
  baseRef.val = Math.min(baseRef.val * 1.6, 10000);
}

function safeJson(d) {
  try { return JSON.parse(d); } catch { return null; }
}

function badge(text, cls) {
  try {
    const el = document.getElementById('realtime-badge');
    if (!el) return;
    if (text != null) el.textContent = text;
    if (cls) {
      el.classList.remove('ok', 'warn', 'crit', 'loading');
      el.classList.add(cls);
    }
  } catch {}
}

function startLagTimer() {
  clearInterval(lagTimer);
  lagTimer = setInterval(() => {
    if (!lastServerTs) return;
    const lag = Date.now() - lastServerTs;
    if (lag < 5000) badge('Tempo real', 'ok');
    else if (lag < 15000) badge(`Atraso ${Math.round(lag / 1000)}s`, 'warn');
    else badge(`Atraso ${Math.round(lag / 1000)}s`, 'crit');
  }, 1000);
}

// ========================= normalizadores =========================
function pickMsgId(p) {
  return (p?.msg_id ?? p?.msgId ?? p?.message_id ?? p?.messageId ?? p?.id ?? null);
}

function mapStatusToAck(status) {
  if (!status) return null;
  const s = String(status).toUpperCase();
  if (s.includes('READ')) return 2;
  if (s.includes('DELIVER')) return 1;
  if (s.includes('SERVER') || s.includes('SENT')) return 0;
  return null;
}

function mapEventToAck(ev) {
  if (!ev) return null;
  const e = String(ev).toUpperCase();
  if (e.includes('READ')) return 2;
  if (e.includes('DELIVERY')) return 1;
  return null;
}

function pickAck(p) {
  if (p?.ack != null) return Number(p.ack);
  if (p?.delivery_ack != null) return Number(p.delivery_ack);
  if (p?.status_ack != null) return Number(p.status_ack);

  const fromStatus = mapStatusToAck(p?.status || p?.state);
  if (fromStatus != null) return fromStatus;

  const fromEvent = mapEventToAck(p?.event || p?.type);
  if (fromEvent != null) return fromEvent;

  return null;
}

/* ========================= Instância: sempre ID numérico se possível ========================= */
function _toIdKey(key) {
  const s = String(key ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;

  try {
    const arr = window.state?.instancias || window.INSTANCIAS || [];
    const q = s.toLowerCase();
    const it = arr.find(x => {
      const names = [x?.instance_name, x?.instancia, x?.nome].map(v => String(v || '').toLowerCase());
      return names.includes(q) || String(x?.instancia_id ?? x?.id) === s;
    });
    return it ? String(it.instancia_id ?? it.id ?? s) : s;
  } catch {
    return s;
  }
}

function pickInstanciaFromAny(payload) {
  const direct =
    payload?.instancia_id ??
    payload?.instancia ??
    payload?.instance_id ??
    payload?.instanceId ??
    null;
  if (direct != null && String(direct).trim() !== '') return _toIdKey(direct);

  const name = payload?.instance ?? payload?.instance_name ?? payload?.instanceName ?? null;
  if (name && String(name).trim() !== '') return _toIdKey(name);

  const cid = idKey(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? null);
  if (cid) {
    const c = getConversaById(cid);
    const cached = c?.instancia_id ?? c?.instancia ?? null;
    if (cached != null) return _toIdKey(cached);
  }

  const oc = getOpenContext();
  if (cid && idEq(oc?.cliente_id, cid) && oc?.instancia_id) {
    return _toIdKey(oc.instancia_id);
  }

  if (window.state?.instanciaSelecionada) return _toIdKey(window.state.instanciaSelecionada);
  if (window.INSTANCIA_ATIVA) return _toIdKey(window.INSTANCIA_ATIVA);
  return null;
}

// ========================= time helpers seguros =========================
function firstValidTsMs(...values) {
  for (const v of values) {
    const ms = tsToMillis(v);
    if (ms && Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

function resolveSafePreviewTsMs(rawTs, cid, inst = null) {
  const parsed = firstValidTsMs(rawTs);
  if (parsed) return parsed;

  const cur = getConversaById(cid, inst);
  const curParsed = firstValidTsMs(cur?.hora, cur?.last_ts);
  if (curParsed) return curParsed;

  return null;
}

function resolveMessageTime(payload, cid, inst = null) {
  const directRaw =
    payload?.timestamp ??
    payload?.ts_iso ??
    payload?.ts ??
    payload?.created_at ??
    payload?.data ??
    null;

  let ms = firstValidTsMs(directRaw);

  if (!ms) {
    ms = firstValidTsMs(payload?.serverTimestamp, payload?.server_ts);
  }

  if (ms) {
    const raw = directRaw ?? new Date(ms).toISOString();
    return { raw, ms };
  }

  const keepMs = resolveSafePreviewTsMs(null, cid, inst);
  return {
    raw: null,
    ms: keepMs ?? null
  };
}

// ========================= eco local (merge) =========================
function squashPendingLocalEcho(inst, cliente_id, msg) {
  try {
    const instKey = inst ?? window.INSTANCIA_ATIVA ?? null;
    const cid = idKey(cliente_id);
    if (!cid) return false;

    const arr = getHist(instKey, cid) || [];
    if (!arr.length) return false;

    const tsWs = Number(msg.ts || 0) || (new Date(msg.timestamp || Date.now()).getTime());
    const txtWs = String(msg.conteudo || msg.texto || '').trim();

    for (let i = arr.length - 1, seen = 0; i >= 0 && seen < 12; i--, seen++) {
      const m = arr[i];
      if (!(m && (m.tipo === 'saida' || m.from_me === true))) continue;

      const noId = !m.msg_id && !m.id;
      if (!noId) continue;

      const tsLoc = Number(m.ts || 0) || (new Date(m.timestamp || Date.now()).getTime());
      const txtLoc = String(m.conteudo || m.texto || '').trim();

      const sameTxt = (txtLoc === txtWs);
      const closeTs = Math.abs(tsWs - tsLoc) <= 15000;

      if (sameTxt && closeTs) {
        arr[i] = { ...m, ...msg };
        try { primeWith(instKey, cid, arr, null); } catch {}
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

function appendToHistCache(inst, cliente_id, msg) {
  const instKey = inst ?? pickInstanciaFromAny({ cliente_id }) ?? window.INSTANCIA_ATIVA ?? resolveInstTopic() ?? null;
  const cid = idKey(cliente_id);
  if (!cid) return;

  try {
    pushOneNew(instKey, cid, msg);
  } catch (e) {
    if (DEBUG_WS) console.warn('[HIST APPEND] falha; cli=', cid, 'inst=', instKey, e);
  }
}

// ========================= delete no histórico =========================
function applyDeleteToHist(inst, cliente_id, msg_id, flags = {}) {
  try {
    const instKey = inst ?? pickInstanciaFromAny({ cliente_id }) ?? window.INSTANCIA_ATIVA ?? resolveInstTopic() ?? null;
    const cid = idKey(cliente_id);
    if (!instKey || !cid || !msg_id) return false;

    const arr = getHist(instKey, cid) || [];
    if (!arr.length) return false;

    const idStr = String(msg_id);
    let changed = false;

    for (let i = 0; i < arr.length; i++) {
      const m = arr[i];
      if (!m) continue;

      const mid = String(m.msg_id || m.id || '');
      if (!mid || mid !== idStr) continue;

      if ('apagada_cliente' in flags) m.apagada_cliente = !!flags.apagada_cliente;
      if ('apagada_usuario' in flags) m.apagada_usuario = !!flags.apagada_usuario;

      changed = true;
      break;
    }

    if (changed) {
      try { primeWith(instKey, cid, arr, null); } catch {}
    }

    return changed;
  } catch {
    return false;
  }
}

// ========================= helpers: unwrap de payload =========================
function unwrap(any) {
  if (!any || typeof any !== 'object') return any;

  const pick = (k) => (any[k] && typeof any[k] === 'object') ? any[k] : null;
  const layers = [pick('data'), pick('payload'), pick('message'), pick('event'), pick('body')].filter(Boolean);

  if (!layers.length) return any;
  return Object.assign({}, any, ...layers);
}

// ========================= STORE: upsert/preview/unread/pin =========================
function storeUpsertConversation(cid, patch = {}, instanciaKey = null) {
  const id = idKey(cid);
  if (!id) return;

  const inst = instanciaKey ?? patch?.instancia_id ?? patch?.instancia ?? null;
  const prev = getConversaById(id, inst);
  const keepPinned = Boolean(prev?.pinned);

  const base = {
    conversation_id: id,
    cliente_id: id,
    id: id,
  };

  const finalObj = {
    ...base,
    ...(prev || {}),
    ...patch,
    pinned: Boolean(patch?.pinned ?? keepPinned),
  };

  try {
    replaceOrInsertConversa(finalObj, inst ?? null);
  } catch {
    const arr = Array.isArray(state.clientesCache) ? state.clientesCache.slice() : [];
    const idx = arr.findIndex(c => idEq(c?.conversation_id ?? c?.id ?? c?.cliente_id, id));
    if (idx >= 0) arr[idx] = { ...(arr[idx] || {}), ...finalObj };
    else arr.push(finalObj);
    state.clientesCache = arr;
  }
}

function bumpPreview(cid, { texto, tsMs, tipo, ack, instancia_id, instance_name, unreadDelta = 0 } = {}) {
  const id = idKey(cid);
  if (!id) return;

  const inst = instancia_id ?? null;
  const patch = {};

  if (typeof texto === 'string') patch.ultima_mensagem = texto;

  // ✅ só sobrescreve a hora se houver timestamp válido
  if (tsMs != null && Number.isFinite(Number(tsMs)) && Number(tsMs) > 0) {
    patch.hora = Number(tsMs);
  }

  if (tipo) patch.last_tipo = (tipo === 'saida') ? 'saida' : 'entrada';

  if (tipo === 'saida') {
    patch.last_ack = (ack == null) ? 0 : Number(ack) || 0;
  } else {
    patch.last_ack = null;
  }

  if (inst != null) {
    patch.instancia_id = inst;
    patch.instancia = inst;
  }
  if (instance_name) patch.instance_name = instance_name;

  if (unreadDelta) {
    const cur = getConversaById(id, inst);
    const curN = Number(cur?.novas || 0) || 0;
    patch.novas = Math.max(0, curN + Number(unreadDelta || 0));
  }

  try {
    moveConversaToTopKeyed(id, {
      ultima_mensagem: patch.ultima_mensagem,
      hora: patch.hora,
      last_tipo: patch.last_tipo,
      last_ack: patch.last_ack,
      novas: patch.novas,
      instancia_id: patch.instancia_id,
      instancia: patch.instancia,
      instance_name: patch.instance_name
    }, inst ?? null);
  } catch {
    storeUpsertConversation(id, patch, inst);
  }

  try {
    window.Lista?.updatePreview?.(id, {
      texto: (typeof texto === 'string') ? texto : undefined,
      ts: patch.hora ?? undefined,
      ack: (tipo === 'saida') ? ack : null,
      unreadDelta: unreadDelta || 0,
      instancia_id: inst ?? null,
      instance_name: instance_name ?? undefined,
    });
  } catch {}

  try {
    window.recomputeUnread?.();
  } catch {}
}

// ========================= handlers: ACK & MSG & DELETE =========================
function handleAckGeneric(payload) {
  const inst = pickInstanciaFromAny(payload);

  const cid =
    idKey(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? null) ||
    getConversaIdByPhone(payload?.telefone || payload?.phone || payload?.remoteJid || payload?.jid || '', inst) ||
    null;

  if (!cid) return;

  const msg_id = pickMsgId(payload) || null;
  const ackVal = pickAck(payload);
  if (ackVal == null) return;

  try {
    updateAck(cid, msg_id, ackVal, inst ?? null);
  } catch {}

  const openByCliente = isOpenChat(cid);
  const canFixDom = ensureDomContextFor(cid, inst);

  const applied = window.applyAckUpdate?.({
    instancia_id: inst ?? null,
    cliente_id: cid,
    msg_id,
    ack: ackVal
  });

  if (!applied && (openByCliente || canFixDom)) {
    window.reconcilePendingAcks?.();
    setTimeout(() => window.reconcilePendingAcks?.(), 120);
  }

  try {
    const cur = getConversaById(cid, inst);
    const tipo = (cur?.last_tipo === 'saida') ? 'saida' : null;

    if (tipo === 'saida') {
      const instFinal = inst ?? (cur?.instancia_id ?? null);

      bumpPreview(cid, {
        tipo: 'saida',
        ack: ackVal,
        tsMs: resolveSafePreviewTsMs(cur?.hora ?? cur?.last_ts ?? null, cid, instFinal),
        instancia_id: instFinal,
        instance_name: resolveInstanceName(instFinal) ?? cur?.instance_name ?? null
      });
    }
  } catch {}

  try { window.Lista?.setAck?.(cid, ackVal, inst ?? null); } catch {}

  if (DEBUG_WS) {
    console.debug('[WS ACK]', {
      cliente_id: cid,
      msg_id,
      ackVal,
      inst,
      openByCliente,
      canFixDom
    });
  }
}

function handleNovaMensagem(payload) {
  const inst = pickInstanciaFromAny(payload);

  let cid = idKey(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? null);
  if (!cid) {
    const byPhone = getConversaIdByPhone(
      payload?.telefone || payload?.phone || payload?.remoteJid || payload?.jid || '',
      inst
    );
    if (byPhone) cid = byPhone;
  }
  if (!cid) return;

  const textoRaw =
    payload.mensagem ??
    payload.texto ??
    payload.message ??
    payload.body ??
    payload.content ??
    '';

  const tipo = (
    payload.tipo === 'saida' ||
    payload.from_me === true ||
    payload.origem === 'atendente'
  ) ? 'saida' : 'entrada';

  const timeInfo = resolveMessageTime(payload, cid, inst);
  const tsIso = timeInfo.raw;
  const tsMsReal = timeInfo.ms;

  let msgId = pickMsgId(payload) || null;
  if (!msgId || String(msgId).trim() === '') {
    const baseTs = tsMsReal || Date.now();
    const sigTxt = String(textoRaw).slice(0, 32);
    const slug = sigTxt.replace(/[^\w]/g, '').slice(0, 16) || 'noTxt';
    msgId = `tmp:${cid}:${baseTs}:${sigTxt.length}:${slug}`;
  }

  const ackV = (tipo === 'saida') ? (pickAck(payload) ?? 0) : null;

  const origem = payload.origem
    || (payload.from_phone ? 'whatsapp_fisico' : (tipo === 'saida' ? 'atendente' : 'cliente'));

  const autor_nome =
    payload.atendente_nome ||
    payload.user_nome ||
    payload.operador_nome ||
    payload.autor_nome ||
    null;

  const msg = {
    id: msgId,
    msg_id: msgId,
    texto: textoRaw,
    conteudo: textoRaw,
    tipo,
    timestamp: tsIso || null,
    ts: tsMsReal || 0,
    ack: ackV,
    midias: Array.isArray(payload.midias) ? payload.midias : undefined,
    instancia_id: inst,
    origem,
    autor_nome
  };

  let merged = false;
  if (tipo === 'saida' && msg.msg_id) {
    merged = squashPendingLocalEcho(inst, cid, msg);
  }

  if (!merged) {
    appendToHistCache(inst, cid, msg);
  }

  try {
    mergeIncomingMessage(cid, {
      id: msgId,
      msg_id: msgId,
      texto: msg.conteudo,
      conteudo: msg.conteudo,
      tipo: msg.tipo,
      ack: msg.ack,
      ts: msg.ts,
      timestamp: msg.timestamp,
      instancia_id: inst ?? null
    }, inst ?? null);
  } catch {}

  const openByCliente = isOpenChat(cid);
  const canFixDom = ensureDomContextFor(cid, inst);

  if (openByCliente || canFixDom) {
    if (DEBUG_WS) {
      console.debug('[WS MSG][RENDER]', {
        cliente_id: cid,
        inst,
        append: !merged,
        openByCliente,
        canFixDom
      });
    }

    renderHistoricoDoCache(cid, !merged);
    if (msg.ack != null) {
      window.applyAckUpdate?.({
        instancia_id: inst ?? null,
        cliente_id: cid,
        msg_id: msg.msg_id,
        ack: msg.ack
      });
    }

    if (tipo === 'saida') {
      try { window.OperatorLine?.set(msg.conteudo, tsIso, { origem, autor_nome }); } catch {}
    }

    if (tipo === 'entrada' && isChatActive(cid)) {
      try { marcarLidas(cid, inst ?? null); } catch {}
      try { window.recomputeUnread?.(); } catch {}
    }
  } else if (DEBUG_WS) {
    const oc = getOpenContext();
    console.debug('[WS MSG][SKIP RENDER]', { cliente_id: cid, inst, open_ctx: oc });
  }

  const safePreviewTsMs = resolveSafePreviewTsMs(tsMsReal ?? tsIso, cid, inst);
  const instName = payload.instance_name ?? payload.instance ?? resolveInstanceName(inst) ?? null;
  const active = isChatActive(cid);
  const unreadDelta = (tipo === 'entrada' && !active) ? 1 : 0;

  bumpPreview(cid, {
    texto: msg.conteudo,
    tsMs: safePreviewTsMs,
    tipo,
    ack: msg.ack,
    instancia_id: inst,
    instance_name: instName,
    unreadDelta
  });

  try { window.syncPreviewFromCache?.(cid); } catch {}

  if (DEBUG_WS) {
    console.debug('[WS MSG]', {
      cliente_id: cid,
      inst,
      merged,
      openByCliente,
      texto: msg.conteudo,
      origem,
      autor_nome
    });
  }
}

function handleDeleteMensagem(payload) {
  const inst = pickInstanciaFromAny(payload);

  const cid =
    idKey(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? null) ||
    getConversaIdByPhone(payload?.telefone || payload?.phone || payload?.remoteJid || payload?.jid || '', inst) ||
    null;

  const msg_id = pickMsgId(payload);
  if (!cid || !msg_id) return;

  const flags = {
    apagada_cliente: payload.apagada_cliente,
    apagada_usuario: payload.apagada_usuario,
  };

  const changed = applyDeleteToHist(inst, cid, msg_id, flags);

  const openByCliente = isOpenChat(cid);
  const canFixDom = ensureDomContextFor(cid, inst);

  if (changed && (openByCliente || canFixDom)) {
    renderHistoricoDoCache(cid, false);
  }

  try {
    window.syncPreviewFromCache?.(cid);
  } catch {}

  if (DEBUG_WS) {
    console.debug('[WS MSG_DELETE]', {
      cliente_id: cid,
      inst,
      msg_id,
      flags,
      changed
    });
  }
}

// ========================= conv_status & pin =========================
function normalizeConvStatus(s) {
  const v = String(s || '').trim().toLowerCase();
  if (!v) return 'no_bot';

  const BOT = ['bot', 'automatico', 'automático', 'auto', 'automatizado'];
  const HUMAN = ['no_bot', 'humano', 'manual', 'atendente', 'agente', 'agent', 'operador', 'operadora'];

  if (BOT.includes(v)) return 'bot';
  if (HUMAN.includes(v)) return 'no_bot';
  return v;
}

function handleConvStatus(payload) {
  const inst = pickInstanciaFromAny(payload);

  const cid =
    idKey(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? null) ||
    getConversaIdByPhone(payload?.telefone || payload?.phone || payload?.remoteJid || '', inst) ||
    null;

  if (!cid) return;

  const rawStatus = payload?.statusatendimento ?? payload?.status ?? payload?.state ?? payload?.modo ?? '';
  const status = normalizeConvStatus(rawStatus);

  const passesInst = _matchInstancia({ instancia_id: inst });
  const openNow = isOpenChat(cid);
  if (!passesInst && !openNow) return;

  storeUpsertConversation(cid, {
    status,
    statusatendimento: status,
    instancia_id: inst ?? (getConversaById(cid)?.instancia_id ?? null),
    instancia: inst ?? (getConversaById(cid)?.instancia_id ?? null),
    instance_name:
      getConversaById(cid)?.instance_name ||
      payload?.instance_name ||
      payload?.instance ||
      resolveInstanceName(inst) ||
      null,
  }, inst ?? null);

  try {
    const li = document.querySelector(`li.chat-item[data-id="${CSS.escape(String(cid))}"]`);
    if (li) li.dataset.status = status;
  } catch {}

  try { window.Lista?.updatePreview?.(cid, { status, statusatendimento: status }); } catch {}
  try {
    document.dispatchEvent(new CustomEvent('ws:conv_status', {
      detail: { cliente_id: cid, instancia_id: inst, status }
    }));
  } catch {}

  if (DEBUG_WS) {
    console.debug('[WS CONV_STATUS]', { cliente_id: cid, inst, status, rawStatus });
  }
}

function inferPinFlag(p) {
  if (typeof p.pin === 'boolean') return p.pin;
  if (typeof p.pinned === 'boolean') return p.pinned;
  if (p.fixado != null) return !!p.fixado;

  const a = String(p.action || p.act || p.event || p.type || '').toLowerCase();
  if (a.includes('unpin') || a.includes('desfix') || a.includes('desafix')) return false;
  if (a.includes('pin') || a.includes('fix')) return true;
  return null;
}

function handleConvPin(payload) {
  const inst = pickInstanciaFromAny(payload);

  const cid =
    idKey(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? null) ||
    getConversaIdByPhone(payload?.telefone || payload?.phone || payload?.remoteJid || '', inst) ||
    null;

  if (!cid) return;

  const flag = inferPinFlag(payload);
  if (flag == null) return;

  storeUpsertConversation(cid, { pinned: !!flag }, inst ?? null);

  try { window.Lista?.setPinned?.(cid, !!flag); } catch {}
  try {
    const li = document.querySelector(`li.chat-item[data-id="${CSS.escape(String(cid))}"]`);
    if (li) li.classList.toggle('is-pinned', !!flag);
  } catch {}

  try { sessionStorage.setItem('convForceReload', '1'); } catch {}

  if (DEBUG_WS) {
    console.debug('[WS CONV_PIN]', {
      cliente_id: cid,
      inst,
      pinned: !!flag,
      raw: payload
    });
  }
}

// ========================= dispatcher =========================
function handleMessage(ev) {
  if (typeof ev?.data === 'string' && (ev.data === 'pong' || ev.data === 'ping')) return;

  const raw = (typeof ev?.data === 'string') ? safeJson(ev.data) : ev?.data;
  const data = unwrap(raw);
  if (!data || typeof data !== 'object') return;

  const sTs = Number(data.serverTimestamp ?? 0);
  if (Number.isFinite(sTs) && sTs > 0) lastServerTs = sTs;

  if (data.type === 'history_sync_start') {
    document.dispatchEvent(new CustomEvent('ws:history_sync_start'));
    return;
  }

  if (data.type === 'history_sync_done') {
    document.dispatchEvent(new CustomEvent('ws:history_sync_done'));
    return;
  }

  if (data.type === 'reload_clientes' || data.type === 'reload_grupos') {
    document.dispatchEvent(new CustomEvent('ws:reload_clientes', { detail: data }));
    try {
      sessionStorage.setItem('convForceReload', '1');
      window.carregarClientes?.({ force: true });
    } catch {}
    return;
  }

  if (data.reload || data.action === 'reload') {
    console.warn('[WS] reload genérico ignorado');
    document.dispatchEvent(new CustomEvent('ws:generic_reload', { detail: data }));
    return;
  }

  if (data.reload_whatsapp || data.type === 'reload_whatsapp') {
    document.dispatchEvent(new CustomEvent('ws:reload_whatsapp', { detail: data }));
    try { window.loadInstances?.(EMPRESA_ID); } catch {}
    return;
  }

  if (data.type === 'conv_status') {
    handleConvStatus(data);
    return;
  }

  const t = String(data.type || data.event || '').toLowerCase();

  if (
    t === 'conv.pin' ||
    t === 'conv_unpin' ||
    t === 'conv.unpin' ||
    t === 'convfix' ||
    t === 'conv_unfix' ||
    t === 'conv.unfix' ||
    t === 'pin' ||
    t === 'unpin' ||
    (t === 'conv' && String(data.action || '').toLowerCase().includes('pin'))
  ) {
    handleConvPin(data);
    return;
  }

  if (
    t === 'msg_deleted' ||
    t === 'messages_delete' ||
    t === 'message_delete' ||
    t === 'messages.delete' ||
    t === 'messagedelete'
  ) {
    handleDeleteMensagem(data);
    return;
  }

  const maybeAck = pickAck(data);
  if (data.type === 'ack' || maybeAck != null) {
    handleAckGeneric(data);
  }

  const hasText =
    (data.mensagem != null) ||
    (data.texto != null) ||
    (data.message != null) ||
    (data.body != null) ||
    (data.content != null);

  const hasMidias = Array.isArray(data.midias) && data.midias.length > 0;

  const hasCliente =
    (data.cliente_id != null) ||
    (data.client_id != null) ||
    (data.conversation_id != null) ||
    (data.telefone != null) ||
    (data.phone != null) ||
    (data.remoteJid != null);

  if (hasCliente && (hasText || hasMidias)) {
    handleNovaMensagem(data);
    return;
  }

  if (DEBUG_WS) console.debug('[WS IGNORADO]', data);
}

// ========================= helpers de página =========================
function isAtendimentosPage() {
  try {
    if (location.pathname.includes('/atendimentos')) return true;
    return !!document.getElementById('historico');
  } catch {
    return false;
  }
}

// ========================= lifecycle: EMPRESA =========================
function connectEmpresaWS() {
  if (!EMPRESA_ID) return;
  if (sockEmp && (sockEmp.readyState === WebSocket.OPEN || sockEmp.readyState === WebSocket.CONNECTING)) return;

  try { sockEmp?.close(); } catch {}
  closedEmpByMe = false;

  const url = wsUrlEmpresa(EMPRESA_ID);
  sockEmp = new WebSocket(url);

  sockEmp.addEventListener('open', () => {
    retryBaseEmp = 800;
    scheduleHeartbeat(sockEmp, 'emp');
    startLagTimer();
    lastServerTs = Date.now();
    badge('Tempo real', 'ok');
    if (DEBUG_WS) console.debug('[WS OPEN EMP]', url);
  });

  sockEmp.addEventListener('message', (ev) => {
    if (typeof ev?.data === 'string') {
      try {
        const parsed = JSON.parse(ev.data);
        const ts = Number(
          parsed?.serverTimestamp ??
          parsed?.ts ??
          (parsed?.timestamp ? tsToMillis(parsed.timestamp) : 0)
        );
        if (Number.isFinite(ts) && ts > 0) {
          lastServerTs = Math.max(lastServerTs || 0, ts);
        }
      } catch {}
    }
    handleMessage(ev);
  });

  sockEmp.addEventListener('close', () => {
    clearInterval(hbEmpTimer);
    badge('Reconectando…', 'loading');

    if (!closedEmpByMe) {
      if (DEBUG_WS) console.debug('[WS CLOSE EMP] retry');
      backoff(connectEmpresaWS, {
        get val() { return retryBaseEmp; },
        set val(v) { retryBaseEmp = v; }
      });
    }
  });

  sockEmp.addEventListener('error', () => {
    try { sockEmp.close(); } catch {}
  });
}

function disconnectEmpresaWS() {
  closedEmpByMe = true;
  clearInterval(hbEmpTimer);
  try { sockEmp?.close(); } catch {}
  sockEmp = null;
  badge('Desconectado', 'crit');
}

// ========================= lifecycle: INSTÂNCIA =========================
function connectInstWS({ wantQR = false } = {}) {
  const topic = resolveInstTopic();
  if (!topic) return;

  if (sockInst && (sockInst.readyState === WebSocket.OPEN || sockInst.readyState === WebSocket.CONNECTING)) return;

  try { sockInst?.close(); } catch {}
  closedInstByMe = false;

  const url = wsUrlInst(topic, { wantQR });
  sockInst = new WebSocket(url);

  sockInst.addEventListener('open', () => {
    retryBaseInst = 800;
    scheduleHeartbeat(sockInst, 'inst');
    startLagTimer();
    lastServerTs = Date.now();
    if (DEBUG_WS) console.debug('[WS OPEN INST]', url);
  });

  sockInst.addEventListener('message', (ev) => {
    if (typeof ev?.data === 'string') {
      try {
        const parsed = JSON.parse(ev.data);
        const ts = Number(
          parsed?.serverTimestamp ??
          parsed?.ts ??
          (parsed?.timestamp ? tsToMillis(parsed.timestamp) : 0)
        );
        if (Number.isFinite(ts) && ts > 0) {
          lastServerTs = Math.max(lastServerTs || 0, ts);
        }
      } catch {}
    }
    handleMessage(ev);
  });

  sockInst.addEventListener('close', () => {
    clearInterval(hbInstTimer);

    if (!closedInstByMe) {
      if (DEBUG_WS) console.debug('[WS CLOSE INST] retry');
      backoff(() => connectInstWS({ wantQR: false }), {
        get val() { return retryBaseInst; },
        set val(v) { retryBaseInst = v; }
      });
    }
  });

  sockInst.addEventListener('error', () => {
    try { sockInst.close(); } catch {}
  });
}

function disconnectInstWS() {
  closedInstByMe = true;
  clearInterval(hbInstTimer);
  try { sockInst?.close(); } catch {}
  sockInst = null;
}

// ========================= boot/teardown =========================
try {
  const boot = () => {
    connectEmpresaWS();
    if (isAtendimentosPage()) {
      connectInstWS({ wantQR: false });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  document.addEventListener('inst:change', () => {
    if (DEBUG_WS) console.debug('[WS] inst:change → reconnect inst');
    disconnectInstWS();
    connectInstWS({ wantQR: false });
  });

  window.addEventListener('beforeunload', () => {
    try { disconnectInstWS(); } catch {}
    try { disconnectEmpresaWS(); } catch {}
  });
} catch {}

export {
  connectEmpresaWS,
  disconnectEmpresaWS,
  connectInstWS,
  disconnectInstWS
};