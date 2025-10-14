// WebSocket da EMPRESA: nova mensagem, ACK (formatos variados), reload, backoff + heartbeat

import { tsToMillis } from '../core/time.js';
import { renderHistoricoDoCache } from '../domain/historico.js';
import { _matchInstancia } from '../domain/instances.js';
import { pushOneNew, getHist, primeWith } from '../domain/hist-cache.js';

const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);

// Aceita tudo; a UI filtra por instância
const ALWAYS_ACCEPT_WS = true;
const DEBUG_WS = (window.DEBUG_WS ?? true);

/* ========================= caches de lista ========================= */
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

/* ========================= contexto aberto (cliente + instância) ========================= */
function getOpenContext(){
  try{
    const hist    = document.getElementById('historico');
    const cidDom  = hist?.dataset?.clienteId ?? hist?.getAttribute?.('data-cliente-id') ?? null;
    const instDom = hist?.dataset?.instanciaId ?? hist?.getAttribute?.('data-instancia-id') ?? null;
    const cidState  = Number(window.state?.clienteSel?.id ?? window.clienteSel?.id ?? NaN);
    const instState = (window.state?.clienteSel?.instancia_id ?? window.INSTANCIA_ATIVA ?? null);
    return {
      cliente_id: Number.isFinite(Number(cidDom)) ? Number(cidDom) : (Number.isFinite(cidState) ? cidState : null),
      instancia_id: (instDom ?? instState ?? null)
    };
  }catch{ return { cliente_id:null, instancia_id:null }; }
}
function isOpenChat(cliente_id, instancia_id){
  const oc = getOpenContext();
  return Number(oc.cliente_id) === Number(cliente_id)
      && String(oc.instancia_id ?? '') === String(instancia_id ?? '');
}
function isChatActive(cliente_id, instancia_id){
  try{
    const hist    = document.getElementById('historico');
    const visible = !!hist && hist.style.display !== 'none';
    const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    return isOpenChat(cliente_id, instancia_id) && visible && focused;
  }catch{ return false; }
}

/* — se o DOM ainda não setou instancia_id, seta aqui p/ não perder render — */
function ensureDomContextFor(cliente_id, instancia_id){
  try{
    const hist = document.getElementById('historico');
    if (!hist) return false;
    if (hist.dataset?.clienteId !== String(cliente_id)) return false; // outra conversa
    if (!hist.dataset.instanciaId || hist.dataset.instanciaId === 'null' || hist.dataset.instanciaId === ''){
      hist.dataset.instanciaId = String(instancia_id ?? '');
    }
    return true;
  }catch{ return false; }
}

/* ========================= WS infra ========================= */
function wsUrlEmpresa(id){
  const proto = (location.protocol === 'https:') ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/emp:${id}`;
}
let sock=null, hbTimer=null, retryMs=800, closedByMe=false;
function heartbeat(){ try { sock?.send?.('ping'); } catch {} }
function scheduleHeartbeat(){ clearInterval(hbTimer); hbTimer = setInterval(heartbeat, 30_000); }
function backoff(fn){ const wait = Math.min(retryMs, 10_000); setTimeout(fn, wait); retryMs = Math.min(retryMs * 1.6, 10_000); }
function safeJson(d){ try { return JSON.parse(d); } catch { return null; } }

/* ========================= preview/lista ========================= */
function upsertClientePreview({ cliente_id, texto, ts, tipo='entrada', ack=null, instancia_id=null, instance_name=null }) {
  let c = findCliente(cliente_id);

  const instSel  = window.INSTANCIA_ATIVA || window.state?.instanciaSelecionada || window.clienteSel?.instancia_id || null;
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

/* ========================= normalizadores ========================= */
function pickMsgId(p){ return (p?.msg_id ?? p?.msgId ?? p?.message_id ?? p?.messageId ?? p?.id ?? null); }
function mapStatusToAck(status){ if (!status) return null; const s=String(status).toUpperCase(); if (s.includes('READ')) return 2; if (s.includes('DELIVER')) return 1; if (s.includes('SERVER')||s.includes('SENT')) return 0; return null; }
function mapEventToAck(ev){ if (!ev) return null; const e=String(ev).toUpperCase(); if (e.includes('READ')) return 2; if (e.includes('DELIVERY')) return 1; return null; }
function pickAck(p){
  if (p?.ack != null) return Number(p.ack);
  if (p?.delivery_ack != null) return Number(p.delivery_ack);
  if (p?.status_ack != null) return Number(p.status_ack);
  const fromStatus = mapStatusToAck(p?.status || p?.state); if (fromStatus != null) return fromStatus;
  const fromEvent = mapEventToAck(p?.event || p?.type);     if (fromEvent != null) return fromEvent;
  return null;
}
function pickInstanciaId(payload){
  const direct = payload?.instancia_id ?? payload?.instancia ?? null;
  if (direct != null) return String(direct);
  const cid = Number(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? NaN);
  const oc = getOpenContext();
  if (Number.isFinite(cid) && Number(oc.cliente_id) === cid && oc.instancia_id) return String(oc.instancia_id);
  if (window.INSTANCIA_ATIVA) return String(window.INSTANCIA_ATIVA);
  return null;
}
function pickClienteId(payload){
  const fromPayload = Number(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id ?? NaN);
  if (Number.isFinite(fromPayload)) return fromPayload;
  const oc = getOpenContext();
  return Number.isFinite(Number(oc.cliente_id)) ? Number(oc.cliente_id) : null;
}

/* ========================= Funde o "eco local" com a mensagem WS ========================= */
function mirrorLegacyF5(instKey, cid){
  try{
    const arr = getHist(instKey, cid) || [];
    if (!window.cacheHistoricos) window.cacheHistoricos = {};
    window.cacheHistoricos[cid] = arr;
    const EMP = Number(localStorage.getItem('empresa_id') || 0);
    localStorage.setItem(`cacheHistoricos:${EMP}`, JSON.stringify(window.cacheHistoricos));
  }catch{}
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

/* ========================= hist-cache append + espelho F5-safe ========================= */
function appendToHistCache(inst, cliente_id, msg){
  const instKey = inst ?? pickInstanciaId({ cliente_id }) ?? window.INSTANCIA_ATIVA ?? null;
  try {
    pushOneNew(instKey, Number(cliente_id), msg);
    mirrorLegacyF5(instKey, Number(cliente_id));
  } catch (e) {
    if (DEBUG_WS) console.warn('[HIST APPEND] falha; cli=', cliente_id, 'inst=', instKey, e);
  }
}

/* ========================= handlers ========================= */
function handleAckGeneric(payload){
  const inst = pickInstanciaId(payload);
  const cliente_id = pickClienteId(payload);
  if (!cliente_id) return;

  const passesInst = _matchInstancia({ instancia_id: inst });
  const openNow = isOpenChat(cliente_id, inst);
  const canFixDom = ensureDomContextFor(cliente_id, inst);
  if (!ALWAYS_ACCEPT_WS && !passesInst && !(openNow || canFixDom)) return;

  const msg_id = pickMsgId(payload) || null;
  const ackVal = pickAck(payload);
  if (ackVal == null) return;

  const applied = window.applyAckUpdate?.({ instancia_id: inst ?? null, cliente_id, msg_id, ack: ackVal });
  if (!applied && (openNow || canFixDom)) {
    window.reconcilePendingAcks?.();
    setTimeout(()=>window.reconcilePendingAcks?.(), 120);
  }

  try { window.Lista?.setAck?.(cliente_id, ackVal, inst ?? null); } catch {}
  if (DEBUG_WS) console.debug('[WS ACK]', { cliente_id, msg_id, ackVal, inst, openNow, canFixDom });
}

function handleNovaMensagem(payload){
  const inst = pickInstanciaId(payload);
  const cliente_id = Number(payload?.cliente_id ?? payload?.client_id ?? payload?.conversation_id);
  if (!cliente_id) return;

  const passesInst = _matchInstancia({ instancia_id: inst });
  const openNow = isOpenChat(cliente_id, inst);
  if (!ALWAYS_ACCEPT_WS && !passesInst && !openNow) return;

  const textoRaw = payload.mensagem ?? payload.texto ?? payload.message ?? payload.body ?? '';
  const tipo = (payload.tipo === 'saida' || payload.from_me === true) ? 'saida' : 'entrada';
  const tsIso = payload.timestamp || payload.ts_iso || new Date().toISOString();

  const msgId = pickMsgId(payload) || null;
  const ackV  = (tipo === 'saida') ? (pickAck(payload) ?? 0) : null;

  const msg = {
    id: msgId, msg_id: msgId,
    texto: textoRaw, conteudo: textoRaw,
    tipo, timestamp: tsIso, ts: tsToMillis(tsIso) || Date.now(),
    ack: ackV, midias: Array.isArray(payload.midias) ? payload.midias : undefined,
    instancia_id: inst
  };

  // Se for saída com id, tenta fundir com bubble temporário (eco local)
  let merged = false;
  if (tipo === 'saida' && msg.msg_id) {
    merged = squashPendingLocalEcho(inst, cliente_id, msg);
  }
  if (!merged){
    appendToHistCache(inst, cliente_id, msg);
  }

  try { window._applyPreviewTimeAndAck?.(cliente_id, msg, msg.conteudo); } catch {}

  const canFixDom = ensureDomContextFor(cliente_id, inst);
  if (openNow || canFixDom){
    if (DEBUG_WS) console.debug('[WS MSG][RENDER]', { cliente_id, inst, append: !merged, openNow, canFixDom });
    renderHistoricoDoCache(cliente_id, /*append*/!merged ? true : false);
    if (msg.ack != null) window.applyAckUpdate?.({ instancia_id: inst ?? null, cliente_id, msg_id: msg.msg_id, ack: msg.ack });
  } else if (DEBUG_WS) {
    const oc = getOpenContext();
    console.debug('[WS MSG][SKIP RENDER]', { cliente_id, inst, open_ctx: oc });
  }

  const tsMs = tsToMillis(tsIso) || Date.now();
  upsertClientePreview({ cliente_id, texto: msg.conteudo, ts: tsMs, tipo, ack: msg.ack, instancia_id: inst, instance_name: payload.instance_name ?? null });

  const ativa = isChatActive(cliente_id, inst);
  try {
    if (tipo === 'entrada' && !ativa) {
      window.Lista?.updatePreview?.(cliente_id, { unreadDelta: 1, ts: tsMs, texto: msg.conteudo, instancia_id: inst ?? null });
    }
  } catch {}

  try { window.syncPreviewFromCache?.(cliente_id); } catch {}
  if (DEBUG_WS) console.debug('[WS MSG]', { cliente_id, inst, merged, passesInst, openNow, texto: msg.conteudo });
}

/* === NOVO: status da conversa vindo do backend (bot/no_bot/automático etc.) === */
function normalizeConvStatus(s){
  const v = String(s || '').toLowerCase();
  if (['bot','no_bot','automatico','automático'].includes(v)) return 'bot';
  return v || 'bot';
}
function handleConvStatus(payload){
  const inst = pickInstanciaId(payload);
  const cliente_id = pickClienteId(payload);
  if (!cliente_id) return;
  const status = normalizeConvStatus(payload?.status);

  const passesInst = _matchInstancia({ instancia_id: inst });
  const openNow = isOpenChat(cliente_id, inst);
  if (!ALWAYS_ACCEPT_WS && !passesInst && !openNow) return;

  // atualiza caches de lista
  let c = findCliente(cliente_id) || { id: Number(cliente_id), cliente_id: Number(cliente_id), conversation_id: Number(cliente_id) };
  c.status = status;
  c.statusatendimento = status;
  const [g, s] = bothCaches(); upsertIn(g, c); upsertIn(s, c);

  // seta no DOM para o fallback dos filtros
  try{
    const li = document.querySelector(`li.chat-item[data-id="${cliente_id}"]`);
    if (li) li.dataset.status = status;
  }catch{}

  // avisa a lista / UI
  try { window.Lista?.updatePreview?.(cliente_id, { status, statusatendimento: status }); } catch {}
  try { document.dispatchEvent(new CustomEvent('ws:conv_status', { detail: { cliente_id, instancia_id: inst, status }})); } catch {}

  if (DEBUG_WS) console.debug('[WS CONV_STATUS]', { cliente_id, inst, status });
}

/* ========================= dispatcher ========================= */
function handleMessage(ev){
  if (typeof ev?.data === 'string' && (ev.data === 'pong' || ev.data === 'ping')) return;
  const data = (typeof ev?.data === 'string') ? safeJson(ev.data) : ev?.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'history_sync_start'){ document.dispatchEvent(new CustomEvent('ws:history_sync_start')); return; }
  if (data.type === 'history_sync_done'){ document.dispatchEvent(new CustomEvent('ws:history_sync_done')); return; }
  if (data.type === 'reload_clientes' || data.type === 'reload_grupos'){
    document.dispatchEvent(new CustomEvent('ws:reload_clientes', { detail: data })); return;
  }

  // ⚠️ NÃO recarrega a página em reload genérico (evita loop)
  if (data.reload || data.action === 'reload'){
    console.warn('[WS] reload genérico ignorado');
    document.dispatchEvent(new CustomEvent('ws:generic_reload', { detail: data }));
    return;
  }

  // Reload específico de WhatsApp/instâncias (recarrega só as instâncias)
  if (data.reload_whatsapp || data.type === 'reload_whatsapp'){
    document.dispatchEvent(new CustomEvent('ws:reload_whatsapp', { detail: data }));
    try { window.loadInstances?.(EMPRESA_ID); } catch {}
    return;
  }

  // === NOVO: status de conversa
  if (data.type === 'conv_status'){ handleConvStatus(data); return; }

  // processa ACK (mesmo se vier junto com texto)
  const maybeAck = pickAck(data);
  if (data.type === 'ack' || maybeAck != null) handleAckGeneric(data);

  // nova mensagem (texto/mídias)
  const hasText   = (data.mensagem != null) || (data.texto != null) || (data.message != null) || (data.body != null);
  const hasMidias = Array.isArray(data.midias) && data.midias.length > 0;
  const hasCliente = (data.cliente_id != null) || (data.client_id != null) || (data.conversation_id != null);

  if (hasCliente && (hasText || hasMidias)){ handleNovaMensagem(data); return; }

  if (DEBUG_WS) console.debug('[WS IGNORADO]', data);
}

/* ========================= lifecycle ========================= */
function connectEmpresaWS(){
  if (!EMPRESA_ID) return;
  try { sock?.close(); } catch {}
  closedByMe = false;

  const url = wsUrlEmpresa(EMPRESA_ID);
  sock = new WebSocket(url);

  sock.addEventListener('open', () => { retryMs = 800; scheduleHeartbeat(); if (DEBUG_WS) console.debug('[WS OPEN]', url); });
  sock.addEventListener('message', handleMessage);
  sock.addEventListener('close', () => { clearInterval(hbTimer); if (!closedByMe){ if (DEBUG_WS) console.debug('[WS CLOSE] retry'); backoff(connectEmpresaWS); } });
  sock.addEventListener('error', () => { try { sock.close(); } catch {} });
}
function disconnectEmpresaWS(){ closedByMe = true; clearInterval(hbTimer); try { sock?.close(); } catch {}; sock = null; }

try {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => connectEmpresaWS());
  else connectEmpresaWS();
} catch {}

export { connectEmpresaWS, disconnectEmpresaWS };
