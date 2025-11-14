// ====================================================================
// WebSocket da EMPRESA + da INSTÂNCIA ATIVA (tempo real)
// - Trata: nova mensagem, ACK, reloads segmentados, conv_status, pin/unpin, MESSAGES_DELETE
// - Reconexão com backoff + heartbeat (ping/pong) + medidor de lag
// - Idempotência básica (merge do eco local por texto+tempo)
// - Ajustes: unwrap de payloads aninhados; mapear cliente por telefone
// - Ajustes: força render quando o chat aberto é o alvo (mesmo sem inst)
// ====================================================================

import { tsToMillis } from '../core/time.js';
import { renderHistoricoDoCache } from '../domain/historico.js';
import { _matchInstancia } from '../domain/instances.js';
import { pushOneNew, getHist, primeWith } from '../domain/hist-cache.js';

const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);

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

// ========================= util: caches de clientes =========================
function ensureCaches() {
  if (!Array.isArray(window.clientesCache)) window.clientesCache = [];
  if (window.state && !Array.isArray(window.state.clientesCache)) window.state.clientesCache = [];
}
function bothCaches() {
  ensureCaches();
  return [window.clientesCache, (window.state ? window.state.clientesCache : window.clientesCache)];
}
function upsertIn(arr, obj) {
  const key = Number(obj?.id ?? obj?.cliente_id ?? obj?.conversation_id);
  if (!Number.isFinite(key)) return;
  const idx = arr.findIndex(it => Number(it?.id ?? it?.cliente_id ?? it?.conversation_id) === key);
  if (idx >= 0) Object.assign(arr[idx], obj); else arr.push(obj);
}
function findCliente(id) {
  ensureCaches();
  const key = Number(id);
  return window.clientesCache.find(c => Number(c.id ?? c.cliente_id ?? c.conversation_id) === key)
      || window.state?.clientesCache?.find?.(c => Number(c.id ?? c.cliente_id ?? c.conversation_id) === key)
      || null;
}
function onlyDigits(s){ return String(s||'').replace(/\D+/g,''); }
function findClienteIdByPhone(phone){
  const p = onlyDigits(phone);
  if(!p) return null;
  ensureCaches();
  const all = [...(window.clientesCache||[]), ...(window.state?.clientesCache||[])];
  // compara por "termina com" para lidar com DDI/DDD
  const hit = all.find(c => {
    const t = onlyDigits(c?.telefone || c?.phone || c?.remoteJid || '');
    return t && (t.endsWith(p) || p.endsWith(t));
  });
  return hit ? Number(hit.id ?? hit.cliente_id ?? hit.conversation_id) : null;
}

// ========================= contexto aberto (cliente + instância) =========================
function getOpenContext(){
  try{
    const hist    = document.getElementById('historico');
    const cidDom  = hist?.dataset?.clienteId ?? null;
    const instDom = hist?.dataset?.instanciaId ?? null;
    const cidState  = Number(window.state?.clienteSel?.id ?? window.clienteSel?.id ?? NaN);
    const instState = (window.state?.clienteSel?.instancia_id ?? window.INSTANCIA_ATIVA ?? null);

    return {
      cliente_id: Number.isFinite(Number(cidDom)) ? Number(cidDom) : (Number.isFinite(cidState) ? cidState : null),
      instancia_id: (instDom ?? instState ?? null)
    };
  }catch{
    return { cliente_id:null, instancia_id:null };
  }
}

// Considera "aberto" só pelo cliente
function isOpenChat(cliente_id){
  try{
    const oc = getOpenContext();
    return Number(oc?.cliente_id) === Number(cliente_id);
  }catch{ return false; }
}
function isChatActive(cliente_id){
  try{
    const hist    = document.getElementById('historico');
    const visible = !!hist && hist.style.display !== 'none';
    const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    return isOpenChat(cliente_id) && visible && focused;
  }catch{ return false; }
}

// Sempre carimba/atualiza a instância no DOM do histórico
function ensureDomContextFor(cliente_id, instancia_id){
  try{
    const hist = document.getElementById('historico');
    if (!hist) return false;
    // se #historico não tem cliente ainda, seta
    if (!hist.dataset?.clienteId || hist.dataset.clienteId === '0' || hist.dataset.clienteId === 'null') {
      hist.dataset.clienteId = String(cliente_id);
    }
    if (hist.dataset?.clienteId !== String(cliente_id)) return false; // outra conversa aberta
    const newInst = String(instancia_id ?? '');
    if (newInst && (!hist.dataset.instanciaId || hist.dataset.instanciaId === 'null' || hist.dataset.instanciaId !== newInst)){
      hist.dataset.instanciaId = newInst;
    }
    return true;
  }catch{ return false; }
}

// ========================= WS infra =========================
function wsUrlEmpresa(id){
  const proto = (location.protocol === 'https:') ? 'wss' : 'ws';
  const qs = new URLSearchParams({ cid: WS_CID });
  return `${proto}://${location.host}/ws/emp:${id}?${qs.toString()}`;
}
function wsUrlInst(instanceKey, { wantQR=false } = {}){
  const proto = (location.protocol === 'https:') ? 'wss' : 'ws';
  const qs = new URLSearchParams({ cid: WS_CID, want_qr: wantQR ? '1' : '0' });
  return `${proto}://${location.host}/ws/inst:${encodeURIComponent(instanceKey)}?${qs.toString()}`;
}

// ajuda a resolver "instância ativa" para tópico 'inst:{nome}' (ou id string)
function resolveInstTopic(){
  const sel = window.state?.instanciaSelecionada ?? window.INSTANCIA_ATIVA ?? null;
  if (!sel) return null;
  const s = String(sel);
  if (/\D/.test(s)) return s; // já é nome/slug
  try{
    const arr = window.state?.instancias || window.INSTANCIAS || [];
    const it = arr.find(x => String(x?.instancia_id ?? x?.id) === s || String(x?.id) === s);
    const name = it?.instance_name || it?.instancia || it?.nome || null;
    return name || s;
  }catch{ return s; }
}

let sockEmp = null;
let sockInst = null;
let hbEmpTimer = null;
let hbInstTimer = null;
let lagTimer = null;
let retryBaseEmp = 800; // ms
let retryBaseInst = 800;
let closedEmpByMe = false;
let closedInstByMe = false;
let lastServerTs = 0; // ms epoch (heartbeat ou qualquer evento)

function heartbeat(ws){ try { ws?.send?.('ping'); } catch {} }
function scheduleHeartbeat(ws, which='emp'){
  const ref = (which === 'inst') ? 'hbInstTimer' : 'hbEmpTimer';
  clearInterval(which === 'inst' ? hbInstTimer : hbEmpTimer);
  const id = setInterval(() => heartbeat(ws), 30_000);
  if (which === 'inst') hbInstTimer = id; else hbEmpTimer = id;
}
function jitter(ms){ const delta = Math.round(ms * 0.2); return ms + Math.round((Math.random()*2 - 1) * delta); }
function backoff(fn, baseRef){
  const wait = Math.min(baseRef.val, 10_000);
  const withJitter = Math.max(250, jitter(wait));
  setTimeout(fn, withJitter);
  baseRef.val = Math.min(baseRef.val * 1.6, 10_000);
}
function safeJson(d){ try { return JSON.parse(d); } catch { return null; } }

function badge(text, cls){
  try{
    const el = document.getElementById('realtime-badge');
    if (!el) return;
    if (text != null) el.textContent = text;
    if (cls){
      el.classList.remove('ok','warn','crit','loading');
      el.classList.add(cls);
    }
  }catch{}
}
function startLagTimer(){
  clearInterval(lagTimer);
  lagTimer = setInterval(() => {
    if (!lastServerTs) return;
    const lag = Date.now() - lastServerTs;
    if (lag < 5_000) badge("Tempo real", "ok");
    else if (lag < 15_000) badge(`Atraso ${Math.round(lag/1000)}s`, "warn");
    else badge(`Atraso ${Math.round(lag/1000)}s`, "crit");
  }, 1000);
}

// ========================= preview/lista =========================
function upsertClientePreview({ cliente_id, texto, ts, tipo='entrada', ack=null, instancia_id=null, instance_name=null }) {
  let c = findCliente(cliente_id);

  const instSel   = window.INSTANCIA_ATIVA || window.state?.instanciaSelecionada || window.clienteSel?.instancia_id || null;
  const instToUse = (instancia_id != null) ? instancia_id : (c?.instancia_id ?? instSel);
  const nameToUse = (instance_name) ? instance_name : (c?.instance_name ?? window.state?.instanciaSelecionadaNome ?? null);

  if (!c) {
    c = {
      id: Number(cliente_id), conversation_id: Number(cliente_id), cliente_id: Number(cliente_id),
      nome: null, push_name: null, telefone: null, avatar_url: null,
      ultima_msg_id: null, ultima_mensagem: '', hora: ts, novas: 0,
      last_tipo: null, last_ack: null, instancia_id: instToUse ?? null, instancia: instToUse ?? null,
      instance_name: nameToUse ?? null,
    };
  } else { if (ts) c.hora = ts; }

  if (typeof texto === 'string') c.ultima_mensagem = texto;
  c.last_tipo = (tipo === 'saida') ? 'saida' : 'entrada';
  if (tipo === 'saida' && ack != null) {
    c.last_ack = (typeof window.normalizeAck === 'function') ? window.normalizeAck(ack) : Number(ack) || 0;
  } else if (tipo !== 'saida') {
    c.last_ack = null;
  }
  if (instToUse != null) { c.instancia_id = instToUse; c.instancia = instToUse; }
  if (nameToUse) c.instance_name = nameToUse;

  const [g, s] = bothCaches(); upsertIn(g, c); upsertIn(s, c);

  try {
    window.Lista?.updatePreview?.(cliente_id, {
      texto: (typeof texto === 'string') ? texto : undefined,
      ts, ack: (tipo === 'saida' ? ack : null),
      instancia_id: instToUse ?? null
    });
  } catch {}
  if (DEBUG_WS) console.debug('[LISTA] preview', { cliente_id, texto, ts, tipo, ack, instancia_id: instToUse });
}

// ========================= normalizadores =========================
function pickMsgId(p){ return (p?.msg_id ?? p?.msgId ?? p?.message_id ?? p?.messageId ?? p?.id ?? null); }
function mapStatusToAck(status){ if (!status) return null; const s=String(status).toUpperCase(); if (s.includes('READ')) return 2; if (s.includes('DELIVER')) return 1; if (s.includes('SERVER')||s.includes('SENT')) return 0; return null; }
function mapEventToAck(ev){ if (!ev) return null; const e=String(ev).toUpperCase(); if (e.includes('READ')) return 2; if (e.includes('DELIVERY')) return 1; return null; }
function pickAck(p){
  if (p?.ack != null) return Number(p.ack);
  if (p?.delivery_ack != null) return Number(p.delivery_ack);
  if (p?.status_ack != null) return Number(p.status_ack);
  const fromStatus = mapStatusToAck(p?.status || p?.state); if (fromStatus != null) return fromStatus;
  const fromEvent  = mapEventToAck(p?.event || p?.type);    if (fromEvent  != null) return fromEvent;
  return null;
}

/* ========================= Instância: sempre ID numérico se possível ========================= */
function _toIdKey(key){
  const s = String(key ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  try {
    const arr = window.state?.instancias || window.INSTANCIAS || [];
    const q = s.toLowerCase();
    const it = arr.find(x => {
      const names = [x?.instance_name, x?.instancia, x?.nome].map(v => String(v||'').toLowerCase());
      return names.includes(q) || String(x?.instancia_id ?? x?.id) === s;
    });
    return it ? String(it.instancia_id ?? it.id ?? s) : s;
  } catch { return s; }
}

function pickInstanciaFromAny(payload){
  const direct = payload?.instancia_id ?? payload?.instancia ?? payload?.instance_id ?? payload?.instanceId ?? null;
  if (direct != null && String(direct).trim() !== '') return _toIdKey(direct);
  const name = payload?.instance ?? payload?.instance_name ?? payload?.instanceName ?? null;
  if (name && String(name).trim() !== '') return _toIdKey(name);

  const cid = Number(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? NaN);
  if (Number.isFinite(cid)) {
    const c = findCliente(cid);
    const cached = c?.instancia_id ?? c?.instancia ?? null;
    if (cached != null) return _toIdKey(cached);
  }

  const oc = getOpenContext();
  if (Number.isFinite(cid) && Number(oc?.cliente_id) === cid && oc?.instancia_id) {
    return _toIdKey(oc.instancia_id);
  }

  if (window.state?.instanciaSelecionada) return _toIdKey(window.state.instanciaSelecionada);
  if (window.INSTANCIA_ATIVA) return _toIdKey(window.INSTANCIA_ATIVA);
  return null;
}

// ========================= eco local (merge) =========================
function mirrorLegacyF5(instKey, cid){
  try{
    const arr = getHist(instKey, cid) || [];
    if (!window.cacheHistoricos) window.cacheHistoricos = {};
    window.cacheHistoricos[cid] = arr;

    // ⚠ Usa a MESMA chave de empresa que o historico.js
    const empWindow = Number(window.EMPRESA_ID || 0);
    const empLs     = Number(localStorage.getItem('empresa_id') || 0);
    const EMP       = empWindow || empLs || 0;
    if (!EMP) return;

    const key = `cacheHistoricos:${EMP}`;
    localStorage.setItem(key, JSON.stringify(window.cacheHistoricos || {}));

    // compat: se window.EMPRESA_ID e empresa_id do LS forem diferentes, grava nas duas
    if (empWindow && empLs && empWindow !== empLs) {
      localStorage.setItem(`cacheHistoricos:${empWindow}`, JSON.stringify(window.cacheHistoricos || {}));
      localStorage.setItem(`cacheHistoricos:${empLs}`,     JSON.stringify(window.cacheHistoricos || {}));
    }
  }catch(e){
    if (DEBUG_WS) console.warn('[HIST APPEND] mirrorLegacyF5 falhou', e);
  }
}

function squashPendingLocalEcho(inst, cliente_id, msg){
  try{
    const instKey = inst ?? window.INSTANCIA_ATIVA ?? null;
    const cid = Number(cliente_id);
    const arr = getHist(instKey, cid) || [];
    if (!arr.length) return false;

    const tsWs  = Number(msg.ts || 0) || (new Date(msg.timestamp || Date.now()).getTime());
    const txtWs = String(msg.conteudo || msg.texto || '').trim();

    for (let i = arr.length - 1, seen = 0; i >= 0 && seen < 12; i--, seen++){
      const m = arr[i];
      if (!(m && (m.tipo === 'saida' || m.from_me === true))) continue;
      const noId = !m.msg_id && !m.id;
      if (!noId) continue;

      const tsLoc = Number(m.ts || 0) || (new Date(m.timestamp || Date.now()).getTime());
      const txtLoc = String(m.conteudo || m.texto || '').trim();

      const sameTxt = (txtLoc === txtWs);
      const closeTs = Math.abs(tsWs - tsLoc) <= 15000;

      if (sameTxt && closeTs){
        arr[i] = { ...m, ...msg };
        try { primeWith(instKey, cid, arr, null); } catch {}
        mirrorLegacyF5(instKey, cid);
        return true;
      }
    }
    return false;
  }catch{ return false; }
}

function appendToHistCache(inst, cliente_id, msg){
  let instKey = inst ?? pickInstanciaFromAny({ cliente_id }) ?? window.INSTANCIA_ATIVA ?? resolveInstTopic() ?? null;
  try {
    pushOneNew(instKey, Number(cliente_id), msg);
    mirrorLegacyF5(instKey, Number(cliente_id));
  } catch (e) {
    if (DEBUG_WS) console.warn('[HIST APPEND] falha; cli=', cliente_id, 'inst=', instKey, e);
  }
}

// ========================= helpers: unwrap de payload =========================
function unwrap(any){
  if (!any || typeof any !== 'object') return any;
  // Sobe os campos de data|payload|message|event|body para o topo (sem perder os existentes)
  const pick = (k)=> (any[k] && typeof any[k]==='object') ? any[k] : null;
  const layers = [pick('data'), pick('payload'), pick('message'), pick('event'), pick('body')].filter(Boolean);
  if (!layers.length) return any;
  // merge superficial (camadas internas ganham prioridade nos campos de mensagem)
  return Object.assign({}, any, ...layers);
}

// ========================= handlers: ACK & MSG =========================
function handleAckGeneric(payload){
  const inst = pickInstanciaFromAny(payload);
  const cliente_id = Number(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? NaN)
                  || findClienteIdByPhone(payload?.telefone || payload?.phone || payload?.remoteJid || payload?.jid || '') || 0;
  if (!cliente_id) return;

  const msg_id = pickMsgId(payload) || null;
  const ackVal = pickAck(payload);
  if (ackVal == null) return;

  const openByCliente = isOpenChat(cliente_id);
  const canFixDom = ensureDomContextFor(cliente_id, inst);

  const applied = window.applyAckUpdate?.({ instancia_id: inst ?? null, cliente_id, msg_id, ack: ackVal });
  if (!applied && (openByCliente || canFixDom)) {
    window.reconcilePendingAcks?.();
    setTimeout(()=>window.reconcilePendingAcks?.(), 120);
  }

  try { window.Lista?.setAck?.(cliente_id, ackVal, inst ?? null); } catch {}
  if (DEBUG_WS) console.debug('[WS ACK]', { cliente_id, msg_id, ackVal, inst, openByCliente, canFixDom });
}

function handleNovaMensagem(payload){
  const inst = pickInstanciaFromAny(payload);

  let cliente_id = Number(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id);
  if (!cliente_id) {
    // tenta por telefone
    const byPhone = findClienteIdByPhone(payload?.telefone || payload?.phone || payload?.remoteJid || payload?.jid || '');
    if (byPhone) cliente_id = byPhone;
  }
  if (!cliente_id) return;

  const textoRaw = payload.mensagem ?? payload.texto ?? payload.message ?? payload.body ?? payload.content ?? '';
  const tipo = (payload.tipo === 'saida' || payload.from_me === true || payload.origem === 'atendente') ? 'saida' : 'entrada';
  const tsIso = payload.timestamp || payload.ts_iso || payload.ts || new Date().toISOString();

  // ID sintético quando faltar msg_id
  let msgId = pickMsgId(payload) || null;
  if (!msgId || String(msgId).trim() === '') {
    const baseTs = tsToMillis(tsIso) || Date.now();
    const sigTxt = String(textoRaw).slice(0,32);
    const slug = sigTxt.replace(/[^\w]/g,'').slice(0,16) || 'noTxt';
    msgId = `tmp:${cliente_id || 0}:${baseTs}:${sigTxt.length}:${slug}`;
  }

  const ackV  = (tipo === 'saida') ? (pickAck(payload) ?? 0) : null;

  const origem = payload.origem
    || (payload.from_phone ? 'whatsapp_fisico' : (tipo === 'saida' ? 'atendente' : 'cliente'));
  const autor_nome = payload.atendente_nome
    || payload.user_nome
    || payload.operador_nome
    || payload.autor_nome
    || null;

  const msg = {
    id: msgId, msg_id: msgId,
    texto: textoRaw, conteudo: textoRaw,
    tipo, timestamp: tsIso, ts: tsToMillis(tsIso) || Date.now(),
    ack: ackV, midias: Array.isArray(payload.midias) ? payload.midias : undefined,
    instancia_id: inst,
    origem,
    autor_nome
  };

  let merged = false;
  if (tipo === 'saida' && msg.msg_id) {
    merged = squashPendingLocalEcho(inst, cliente_id, msg);
  }
  if (!merged){
    appendToHistCache(inst, cliente_id, msg);
  }

  try { window._applyPreviewTimeAndAck?.(cliente_id, msg, msg.conteudo); } catch {}

  const openByCliente = isOpenChat(cliente_id);
  const canFixDom = ensureDomContextFor(cliente_id, inst);

  if (openByCliente || canFixDom){
    if (DEBUG_WS) console.debug('[WS MSG][RENDER]', { cliente_id, inst, append: !merged, openByCliente, canFixDom });
    // força render mesmo quando inst difere — o dom foi carimbado em ensureDomContextFor
    renderHistoricoDoCache(cliente_id, /*append*/!merged ? true : false);
    if (msg.ack != null) window.applyAckUpdate?.({ instancia_id: inst ?? null, cliente_id, msg_id: msg.msg_id, ack: msg.ack });
    if (tipo === 'saida') {
      try { window.OperatorLine?.set(msg.conteudo, tsIso, { origem, autor_nome }); } catch {}
    }
  } else if (DEBUG_WS) {
    const oc = getOpenContext();
    console.debug('[WS MSG][SKIP RENDER]', { cliente_id, inst, open_ctx: oc });
  }

  const tsMs = tsToMillis(tsIso) || Date.now();
  upsertClientePreview({ cliente_id, texto: msg.conteudo, ts: tsMs, tipo, ack: msg.ack, instancia_id: inst, instance_name: payload.instance_name ?? payload.instance ?? null });

  const ativa = isChatActive(cliente_id);
  try {
    if (tipo === 'entrada' && !ativa) {
      window.Lista?.updatePreview?.(cliente_id, { unreadDelta: 1, ts: tsMs, texto: msg.conteudo, instancia_id: inst ?? null });
    }
  } catch {}

  try { window.syncPreviewFromCache?.(cliente_id); } catch {}
  if (DEBUG_WS) console.debug('[WS MSG]', { cliente_id, inst, merged, openByCliente, texto: msg.conteudo, origem, autor_nome });
}

// ========================= conv_status & pin =========================
function normalizeConvStatus(s){
  const v = String(s || '').toLowerCase();
  if (['bot','no_bot','automatico','automático'].includes(v)) return 'bot';
  return v || 'bot';
}
function handleConvStatus(payload){
  const inst = pickInstanciaFromAny(payload);
  let cliente_id = Number(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? NaN);
  if (!cliente_id) cliente_id = findClienteIdByPhone(payload?.telefone || payload?.phone || payload?.remoteJid || '') || 0;
  if (!cliente_id) return;
  const status = normalizeConvStatus(payload?.status);

  const passesInst = _matchInstancia({ instancia_id: inst });
  const openNow = isOpenChat(cliente_id);
  if (!passesInst && !openNow) return;

  let c = findCliente(cliente_id) || { id: Number(cliente_id), cliente_id: Number(cliente_id), conversation_id: Number(cliente_id) };
  c.status = status;
  c.statusatendimento = status;
  const [g, s] = bothCaches(); upsertIn(g, c); upsertIn(s, c);

  try{
    const li = document.querySelector(`li.chat-item[data-id="${cliente_id}"]`);
    if (li) li.dataset.status = status;
  }catch{}

  try { window.Lista?.updatePreview?.(cliente_id, { status, statusatendimento: status }); } catch {}
  try { document.dispatchEvent(new CustomEvent('ws:conv_status', { detail: { cliente_id, instancia_id: inst, status }})); } catch {}

  if (DEBUG_WS) console.debug('[WS CONV_STATUS]', { cliente_id, inst, status });
}

function inferPinFlag(p){
  if (typeof p.pin === 'boolean') return p.pin;
  if (typeof p.pinned === 'boolean') return p.pinned;
  if (p.fixado != null) return !!p.fixado;
  const a = String(p.action || p.act || p.event || p.type || '').toLowerCase();
  if (a.includes('unpin') || a.includes('desfix') || a.includes('desafix')) return false;
  if (a.includes('pin') || a.includes('fix')) return true;
  return null;
}
function handleConvPin(payload){
  const inst = pickInstanciaFromAny(payload);
  let cliente_id = Number(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? NaN);
  if (!cliente_id) cliente_id = findClienteIdByPhone(payload?.telefone || payload?.phone || payload?.remoteJid || '') || 0;
  if (!cliente_id) return;

  const flag = inferPinFlag(payload);
  if (flag == null) return;

  let c = findCliente(cliente_id) || { id: Number(cliente_id), cliente_id: Number(cliente_id), conversation_id: Number(cliente_id) };
  c.pinned = !!flag;
  const [g, s] = bothCaches(); upsertIn(g, c); upsertIn(s, c);

  try { window.Lista?.setPinned?.(cliente_id, !!flag); } catch {}
  try {
    const li = document.querySelector(`li.chat-item[data-id="${cliente_id}"]`);
    if (li) li.classList.toggle('is-pinned', !!flag);
  } catch {}

  try { sessionStorage.setItem('convForceReload', '1'); } catch {}

  if (DEBUG_WS) console.debug('[WS CONV_PIN]', { cliente_id, inst, pinned: !!flag, raw: payload });
}

// ========================= MESSAGES_DELETE =========================
function handleMessagesDelete(payload){
  const inst = pickInstanciaFromAny(payload);

  let cliente_id = Number(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? NaN);
  if (!cliente_id) {
    cliente_id = findClienteIdByPhone(payload?.telefone || payload?.phone || payload?.remoteJid || payload?.jid || '') || 0;
  }
  if (!cliente_id) return;

  const instKey = inst ?? pickInstanciaFromAny({ cliente_id }) ?? window.INSTANCIA_ATIVA ?? resolveInstTopic() ?? null;
  const cid = Number(cliente_id);
  const hist = getHist(instKey, cid) || [];
  if (!hist.length) {
    try { window.MESSAGES_DELETE?.({ cliente_id: cid, instancia_id: instKey, msg_ids: [], payload }); } catch {}
    return;
  }

  const ids = new Set();
  const addId = (v) => {
    if (v == null) return;
    const s = String(v).trim();
    if (!s) return;
    ids.add(s);
  };

  // Arrays diretas de ids
  if (Array.isArray(payload.msg_ids))       payload.msg_ids.forEach(addId);
  if (Array.isArray(payload.message_ids))   payload.message_ids.forEach(addId);
  if (Array.isArray(payload.ids))          payload.ids.forEach(addId);

  // messages[] com objetos
  if (Array.isArray(payload.messages)) {
    payload.messages.forEach(m => addId(pickMsgId(m)));
  }

  // id único no topo
  addId(pickMsgId(payload));

  const deleteAll = !!payload.delete_all || !!payload.all || !!payload.clear || !!payload.clear_history;
  const hasIds = ids.size > 0;

  if (!deleteAll && !hasIds) {
    try { window.MESSAGES_DELETE?.({ cliente_id: cid, instancia_id: instKey, msg_ids: [], payload }); } catch {}
    return;
  }

  let changed = false;
  const filtered = hist.filter(m => {
    const mid = pickMsgId(m);
    if (deleteAll) {
      changed = true;
      return false;
    }
    if (!mid) return true;
    if (hasIds && ids.has(String(mid))) {
      changed = true;
      return false;
    }
    return true;
  });

  if (!changed) {
    try { window.MESSAGES_DELETE?.({ cliente_id: cid, instancia_id: instKey, msg_ids: [], payload }); } catch {}
    return;
  }

  try { primeWith(instKey, cid, filtered, null); } catch {}
  mirrorLegacyF5(instKey, cid);

  const openByCliente = isOpenChat(cid);
  const canFixDom = ensureDomContextFor(cid, instKey);

  if (openByCliente || canFixDom) {
    if (DEBUG_WS) console.debug('[WS MSG_DELETE][RENDER]', {
      cliente_id: cid,
      inst: instKey,
      removed: hist.length - filtered.length
    });
    renderHistoricoDoCache(cid, /*append*/ false);
  }

  // Atualiza preview
  try {
    if (filtered.length) {
      const last = filtered[filtered.length - 1];
      const lastTxt  = String(last.conteudo || last.texto || '').trim();
      const lastTs   = Number(last.ts || tsToMillis(last.timestamp) || Date.now());
      const lastTipo = (last.tipo === 'saida') ? 'saida' : 'entrada';
      const lastAck  = (lastTipo === 'saida') ? (last.ack ?? pickAck(last)) : null;

      upsertClientePreview({
        cliente_id: cid,
        texto: lastTxt,
        ts: lastTs,
        tipo: lastTipo,
        ack: lastAck,
        instancia_id: instKey
      });
    } else {
      // Sem mensagens restantes: zera preview
      upsertClientePreview({
        cliente_id: cid,
        texto: '',
        ts: Date.now(),
        tipo: 'entrada',
        ack: null,
        instancia_id: instKey
      });
    }
  } catch {}

  // Eventos para outros módulos
  try {
    document.dispatchEvent(new CustomEvent('ws:messages_delete', {
      detail: {
        cliente_id: cid,
        instancia_id: instKey,
        msg_ids: Array.from(ids),
        delete_all: deleteAll,
        payload
      }
    }));
  } catch {}

  try {
    window.MESSAGES_DELETE?.({
      cliente_id: cid,
      instancia_id: instKey,
      msg_ids: Array.from(ids),
      delete_all: deleteAll,
      payload
    });
  } catch {}

  if (DEBUG_WS) console.debug('[WS MSG_DELETE]', {
    cliente_id: cid,
    inst: instKey,
    deleted: hist.length - filtered.length,
    delete_all: deleteAll,
    msg_ids: Array.from(ids)
  });
}

// ========================= dispatcher =========================
function handleMessage(ev){
  if (typeof ev?.data === 'string' && (ev.data === 'pong' || ev.data === 'ping')) return;

  const raw = (typeof ev?.data === 'string') ? safeJson(ev.data) : ev?.data;
  const data = unwrap(raw);
  if (!data || typeof data !== 'object') return;

  // serverTimestamp (lag)
  const sTs = Number(data.serverTimestamp ?? 0);
  if (Number.isFinite(sTs) && sTs > 0) lastServerTs = sTs;

  if (data.type === 'history_sync_start'){ document.dispatchEvent(new CustomEvent('ws:history_sync_start')); return; }
  if (data.type === 'history_sync_done'){ document.dispatchEvent(new CustomEvent('ws:history_sync_done')); return; }

  if (data.type === 'reload_clientes' || data.type === 'reload_grupos'){
    document.dispatchEvent(new CustomEvent('ws:reload_clientes', { detail: data }));
    try { sessionStorage.setItem('convForceReload', '1'); window.carregarClientes?.({ force:true }); } catch {}
    return;
  }

  if (data.reload || data.action === 'reload'){
    console.warn('[WS] reload genérico ignorado');
    document.dispatchEvent(new CustomEvent('ws:generic_reload', { detail: data })); return;
  }

  if (data.reload_whatsapp || data.type === 'reload_whatsapp'){
    document.dispatchEvent(new CustomEvent('ws:reload_whatsapp', { detail: data }));
    try { window.loadInstances?.(EMPRESA_ID); } catch {}
    return;
  }

  if (data.type === 'conv_status'){ handleConvStatus(data); return; }

  const t = String(data.type || '').toLowerCase();

  if (t === 'messages_delete' || t === 'messages.deleted' || t === 'message_delete' || t === 'message.deleted') {
    handleMessagesDelete(data);
    return;
  }

  if (t === 'conv.pin' || t === 'conv_unpin' || t === 'conv.unpin' || t === 'convfix' || t === 'conv_unfix' || t === 'conv.unfix'
      || t === 'pin' || t === 'unpin' || (t === 'conv' && (String(data.action||'').toLowerCase().includes('pin')))) {
    handleConvPin(data); return;
  }

  // processa ACK (mesmo se vier junto com texto)
  const maybeAck = pickAck(data);
  if (data.type === 'ack' || maybeAck != null) handleAckGeneric(data);

  // nova mensagem (texto/mídias)
  const hasText    = (data.mensagem != null) || (data.texto != null) || (data.message != null) || (data.body != null) || (data.content != null);
  const hasMidias  = Array.isArray(data.midias) && data.midias.length > 0;
  const hasCliente = (data.cliente_id != null) || (data.client_id != null) || (data.conversation_id != null) || (data.telefone != null) || (data.phone != null) || (data.remoteJid != null);

  if ((hasCliente) && (hasText || hasMidias)){ handleNovaMensagem(data); return; }

  if (DEBUG_WS) console.debug('[WS IGNORADO]', data);
}

// ========================= helpers de página =========================
function isAtendimentosPage() {
  try {
    if (location.pathname.includes('/atendimentos')) return true;
    return !!document.getElementById('historico');
  } catch { return false; }
}

// ========================= lifecycle: EMPRESA =========================
function connectEmpresaWS(){
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
    badge("Tempo real", "ok");
    if (DEBUG_WS) console.debug('[WS OPEN EMP]', url);
  });

  sockEmp.addEventListener('message', (ev) => {
    if (typeof ev?.data === 'string') {
      try {
        const parsed = JSON.parse(ev.data);
        const ts = Number(parsed?.serverTimestamp
          ?? parsed?.ts
          ?? (parsed?.timestamp ? tsToMillis(parsed.timestamp) : 0));
        if (Number.isFinite(ts) && ts > 0) lastServerTs = Math.max(lastServerTs || 0, ts);
      } catch {}
    }
    handleMessage(ev);
  });

  sockEmp.addEventListener('close', () => {
    clearInterval(hbEmpTimer);
    badge("Reconectando…", "loading");
    if (!closedEmpByMe){
      if (DEBUG_WS) console.debug('[WS CLOSE EMP] retry');
      backoff(connectEmpresaWS, { get val(){return retryBaseEmp}, set val(v){ retryBaseEmp = v; } });
    }
  });

  sockEmp.addEventListener('error', () => {
    try { sockEmp.close(); } catch {}
  });
}

function disconnectEmpresaWS(){
  closedEmpByMe = true;
  clearInterval(hbEmpTimer);
  try { sockEmp?.close(); } catch {};
  sockEmp = null;
  badge("Desconectado", "crit");
}

// ========================= lifecycle: INSTÂNCIA =========================
function connectInstWS({ wantQR = false } = {}){
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
        const ts = Number(parsed?.serverTimestamp
          ?? parsed?.ts
          ?? (parsed?.timestamp ? tsToMillis(parsed.timestamp) : 0));
        if (Number.isFinite(ts) && ts > 0) lastServerTs = Math.max(lastServerTs || 0, ts);
      } catch {}
    }
    handleMessage(ev);
  });

  sockInst.addEventListener('close', () => {
    clearInterval(hbInstTimer);
    if (!closedInstByMe){
      if (DEBUG_WS) console.debug('[WS CLOSE INST] retry');
      backoff(() => connectInstWS({ wantQR: false }), { get val(){return retryBaseInst}, set val(v){ retryBaseInst = v; } });
    }
  });

  sockInst.addEventListener('error', () => {
    try { sockInst.close(); } catch {}
  });
}

function disconnectInstWS(){
  closedInstByMe = true;
  clearInterval(hbInstTimer);
  try { sockInst?.close(); } catch {};
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

export { connectEmpresaWS, disconnectEmpresaWS, connectInstWS, disconnectInstWS };
