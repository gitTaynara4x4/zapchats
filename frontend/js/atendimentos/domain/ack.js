// frontend/js/atendimentos/domain/ack.js
// Estilo WhatsApp Web + ACK SEMPRE DEPOIS DO HORÁRIO + persistência no LS

'use strict';

/* ============================ Helpers ============================ */
export function normalizeAck(v){
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 0;
}

const HistAPI = {
  get(inst, id){
    try{
      if (typeof window.getHist === 'function') return window.getHist(inst, id) || [];
      if (window.HistCache?.get) return window.HistCache.get(inst, id) || [];
      if (window.cacheHistoricos && window.cacheHistoricos[id]) return window.cacheHistoricos[id] || [];
    }catch{}
    return [];
  },
  set(inst, id, arr){
    try{
      if (typeof window.setHist === 'function') return window.setHist(inst, id, arr);
      if (window.HistCache?.set) return window.HistCache.set(inst, id, arr);
      // fallback: primeWith funciona como "set"
      if (typeof window.primeWith === 'function') return window.primeWith(inst, id, arr, null);
    }catch{}
  }
};

function ensureAckCss(){
  if (document.getElementById('ack-css')) return;
  const s = document.createElement('style');
  s.id = 'ack-css';
  s.textContent = `
    :root{ --ack-grey:#8696a0; --ack-blue:#53bdeb; }
    .msg-ack{ display:inline-flex; align-items:center; gap:0; vertical-align:-0.15em; line-height:1; height:1em; user-select:none }
    .msg-ack svg{ width:14px; height:14px; display:block }
    .msg-ack .tick{ fill:currentColor }
    .msg-ack .tick.second{ margin-left:-6px }
    .msg-ack[data-ack="0"]{ color:var(--ack-grey); opacity:.95 }
    .msg-ack[data-ack="1"]{ color:var(--ack-grey); opacity:.95 }
    .msg-ack[data-ack="2"]{ color:var(--ack-blue);  opacity:1 }
    .msg-ack .clock{ stroke:currentColor; fill:none; stroke-width:1.6 }
    .msg-ack .clock-hand{ stroke:currentColor; stroke-width:1.6; stroke-linecap:round }

    /* layout da meta: hora + ack (ack sempre depois da hora) */
    .bubble .meta{ display:flex; align-items:center; gap:.35rem; white-space:nowrap }
    .bubble-out .meta{ justify-content:flex-end }
    .bubble .meta .time, .bubble .meta .msg-time{ order:1 }
    .bubble .meta .msg-ack{ order:2 }
    .bubble-in  .msg-ack{ display:none !important } /* ACK só em saída */
  `;
  document.head.appendChild(s);
}

/* ============================ SVGs ============================ */
function svgClock(){ return `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle class="clock" cx="12" cy="12" r="8.75"></circle>
    <path class="clock-hand" d="M12 7.5v4.6l3 1.8"></path>
  </svg>`; }
function svgSingleCheck(cls=''){ return `
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path class="tick ${cls}" d="M6.7 10.9l-2.4-2.4a1 1 0 0 1 1.4-1.4l1.7 1.7 6-6a1 1 0 1 1 1.4 1.4l-6.7 6.7a1 1 0 0 1-1.4 0z"/>
  </svg>`; }
function svgDoubleCheck(){ return svgSingleCheck('first') + svgSingleCheck('second'); }

/* ============================ Render ============================ */
function labelFor(a){ return a===2?'lida':(a===1?'entregue':'enviando'); }
function iconMarkup(ack){
  ensureAckCss();
  const a = normalizeAck(ack);
  return a === 0 ? svgClock() : svgDoubleCheck();
}

export function renderAckSpan(ack, msgId){
  const a = normalizeAck(ack);
  const idAttr = msgId ? ` data-msg-id="${String(msgId)}"` : '';
  const title = a===2?'Mensagem lida':(a===1?'Mensagem entregue':'Enviando…');
  return `<span class="msg-ack" data-ack="${a}"${idAttr} aria-label="${labelFor(a)}" title="${title}">${iconMarkup(a)}</span>`;
}
export function getAckIcon(v){ return renderAckSpan(v); }

/* ============================ Posicionamento (sempre após a hora) ============================ */
function findMetaContainer(bubble){
  return bubble.querySelector('.meta, .msg-meta, .bubble-meta, .footer, .tail') || bubble;
}
function findTimeEl(scope){
  let t = scope.querySelector('.msg-time, .time, time[datetime], time[data-role="msg-time"], [data-time]');
  if (t) return t;
  // fallback: procura HH:MM
  let last=null;
  scope.querySelectorAll('*').forEach(el=>{
    if (el.children.length===0){
      const txt=(el.textContent||'').trim();
      if (/\b\d{1,2}:\d{2}\b/.test(txt)) last=el;
    }
  });
  return last;
}
function isOutgoingBubble(bubble){
  if (!bubble) return false;
  if (bubble.classList.contains('bubble-out')) return true;
  const row = bubble.closest('.msg-row');
  return row?.classList.contains('msg-sent') || false;
}
function ensureAfterTime(ackEl){
  try{
    const bubble = ackEl.closest('.bubble');
    if (!bubble || !isOutgoingBubble(bubble)) return; // só em saída
    const meta = findMetaContainer(bubble);
    const timeEl = findTimeEl(meta);
    if (!timeEl) { // sem .time: joga no fim da meta
      if (ackEl.parentElement!==meta) meta.appendChild(ackEl);
      return;
    }
    if (timeEl.nextSibling!==ackEl){ timeEl.after(ackEl); }
  }catch{}
}
function scheduleEnsure(el){
  ensureAfterTime(el);
  try{ requestAnimationFrame(()=>ensureAfterTime(el)); }catch{ setTimeout(()=>ensureAfterTime(el),0); }
}

/* ============================ Apply (DOM + cache + lista + persist) ============================ */
export function applyAckUpdate(p = {}){
  const clienteId = Number(p.cliente_id || p.conversation_id || p.id || 0);
  const inst = (p.instancia_id==null || p.instancia_id==='') ? null : String(p.instancia_id);
  const msgId = (p.msg_id ?? p.message_id ?? p.id ?? '').toString();
  const ack = normalizeAck(p.ack);
  if (!clienteId || !msgId) return false;

  // ===== cache
  let touched = false;
  try{
    const arr = HistAPI.get(inst, clienteId) || [];
    const idx = arr.findIndex(m => String(m?.msg_id||'') === msgId);
    if (idx >= 0){
      const prevAck = Number(arr[idx].ack||0);
      arr[idx].ack = Math.max(prevAck, ack);
      HistAPI.set(inst, clienteId, arr);
      touched = true;
    }
  }catch{}

  // ===== DOM
  try{
    const sel = `.msg-ack[data-msg-id="${CSS.escape(msgId)}"]`;
    document.querySelectorAll(sel).forEach(el=>{
      el.setAttribute('data-ack', String(ack));
      el.setAttribute('aria-label', labelFor(ack));
      el.setAttribute('title', ack===2?'Mensagem lida':(ack===1?'Mensagem entregue':'Enviando…'));
      el.innerHTML = iconMarkup(ack);
      scheduleEnsure(el);
    });
  }catch{}

  // ===== espelha no mirror + salva em LS (sobrevive ao F5)
  try{
    const mirror = (window.cacheHistoricos ||= {});
    mirror[clienteId] = HistAPI.get(inst, clienteId) || mirror[clienteId] || [];
    window.salvarCache?.();
  }catch{}

  // ===== lista (preview/ícone)
  try{
    window.Lista?.updatePreview?.(clienteId, { ack, texto: undefined });
    window.Lista?.setAck?.(clienteId, ack);
  }catch{}

  return touched;
}

/* ============================ Observer ============================ */
const _ackObserver = new MutationObserver(muts=>{
  for(const m of muts){
    for(const n of m.addedNodes){
      if(!(n instanceof Element)) continue;
      if (n.matches?.('.msg-ack')) scheduleEnsure(n);
      n.querySelectorAll?.('.msg-ack').forEach(scheduleEnsure);
      if (n.matches?.('.bubble-out')) n.querySelectorAll?.('.msg-ack').forEach(scheduleEnsure);
    }
  }
});
try{ _ackObserver.observe(document.documentElement, { childList:true, subtree:true }); }catch{}

/* ============================ Globais ============================ */
try{
  window.normalizeAck = normalizeAck;
  window.getAckIcon = getAckIcon;
  window.renderAckSpan = renderAckSpan;
  window.applyAckUpdate = applyAckUpdate;
}catch{}
