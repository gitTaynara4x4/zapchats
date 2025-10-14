// /frontend/js/atendimentos/domain/historico.js
// Histórico com paginação “puxar pra cima”, loader no topo e clamp de texto tipo WPP.

import { formatChatTime, parseAtendimentoDate } from '../core/time.js';
import { getHist, primeWith, mergeOld } from '../domain/hist-cache.js';
import { EMPRESA_ID } from '../core/env.js';

export const HISTORICO_LIMIT = 50;
const hist = document.getElementById('historico');

/* ========== Loader + ReadMore + Call CSS ========== */
(function injectCSS(){
  const id = 'hist-misc-css';
  if (document.getElementById(id)) return;
  const css = `
  #historico { position: relative; }

  /* Loader topo (quando carrega mensagens antigas) */
  #historico .hist-loader {
    position: sticky; top: 0; z-index: 2;
    display: none; align-items: center; justify-content: center;
    gap: 10px; padding: 8px 0;
    background: linear-gradient(to bottom, var(--bg, #0b141a), transparent);
  }
  #historico[data-loading-old="1"] .hist-loader { display: flex; }
  #historico .hist-loader .spinner {
    width: 16px; height: 16px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,.25);
    border-top-color: rgba(255,255,255,.85);
    animation: histSpin .8s linear infinite;
  }
  #historico .hist-loader .txt {
    color: var(--muted, #aebac1); font-size: .9em;
    user-select: none;
  }
  @keyframes histSpin { to { transform: rotate(360deg); } }

  /* ======= Ler mais (estilo WPP) ======= */
  .bubble .msg-text-wrap { position: relative; }
  .bubble .msg-text { white-space: pre-wrap; word-wrap: break-word; }

  /* estado colapsado */
  .bubble .msg-text.clamped {
    overflow: hidden;
    max-height: var(--rm-max-h, 260px); /* ajustável via CSS var */
  }
  .bubble .msg-text.clamped::after{
    content:"";
    position:absolute; left:0; right:0; bottom:0; height:48px;
    background: linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,.18));
    pointer-events:none;
  }

  /* botão */
  .bubble .rm-toggle{
    position:absolute; right:8px; bottom:4px;
    border:0; background:transparent; color:#c7d0d5;
    font-size:.92em; font-weight:600; cursor:pointer;
    text-decoration: none;
  }
  .bubble .rm-toggle:hover{ text-decoration: underline; }

  /* ======= Ligação badge ======= */
  .bubble .msg-call {
    display:flex; align-items:center; gap:8px;
    font-weight:600; margin-bottom:6px;
    color: var(--call-fg, #d1e2ff);
  }
  .bubble .msg-call .ico{
    line-height:1; font-size:1.06em;
    filter: drop-shadow(0 1px 0 rgba(0,0,0,.15));
  }
  .bubble .msg-call .kind{ opacity:.95; text-transform:capitalize; }
  .bubble .msg-call .sep{ opacity:.55; }
  .bubble .msg-call .dir{ opacity:.9; }
  .bubble .msg-call .st{ opacity:.7; font-weight:500; }

  /* ======= Byline (responsável acima da bolha) ======= */
  .msg-row .byline{
    font-size:.72rem; color: var(--muted,#aebac1);
    margin:0 6px 3px; opacity:.95; user-select:none;
  }
  .msg-row.msg-sent .byline{ text-align:right; }
  .msg-row.msg-received .byline{ display:none; }
  .msg-row .byline small{ margin-left:.5rem; opacity:.8; }
  `;
  const s = document.createElement('style');
  s.id = id; s.textContent = css;
  (document.head || document.documentElement).appendChild(s);
})();

/* ========== Loader helpers ========== */
function ensureTopLoader(){
  if (!hist) return null;
  let l = hist.querySelector('.hist-loader');
  if (!l){
    l = document.createElement('div');
    l.className = 'hist-loader';
    l.innerHTML = `<div class="spinner" aria-hidden="true"></div><div class="txt">Carregando mensagens…</div>`;
    hist.insertAdjacentElement('afterbegin', l);
  }
  return l;
}
function showTopLoader(){ ensureTopLoader(); if (hist) hist.setAttribute('data-loading-old','1'); }
function hideTopLoader(){ if (hist) hist.removeAttribute('data-loading-old'); }

/* ========== ReadMore helpers ========== */
const MAX_TEXT_HEIGHT_PX = 260; // << ajuste aqui para mudar o limite

function buildReadMoreWrap(html){
  // envolve o texto em um contêiner com botão; botão inicia oculto e aparece se necessário
  return `
    <div class="msg-text-wrap" data-has-rm="1">
      ${html}
      <button class="rm-toggle" type="button" hidden>Ler mais</button>
    </div>
  `;
}

function clampIfNeeded(wrap){
  if (!wrap) return;
  const textEl = wrap.querySelector('.msg-text');
  const btn = wrap.querySelector('.rm-toggle');
  if (!textEl || !btn) return;

  // Reseta antes de medir
  textEl.classList.remove('clamped');
  wrap.removeAttribute('data-expanded');
  btn.hidden = true;

  // Mede usando scrollHeight
  // (max-height via CSS só aplica quando 'clamped'; medimos o conteúdo real)
  const needClamp = textEl.scrollHeight > MAX_TEXT_HEIGHT_PX + 8; // folga
  if (needClamp){
    textEl.style.setProperty('--rm-max-h', MAX_TEXT_HEIGHT_PX+'px');
    textEl.classList.add('clamped');
    btn.textContent = 'Ler mais';
    btn.hidden = false;
  }
}

function toggleClamp(btn){
  const wrap = btn.closest('.msg-text-wrap');
  const textEl = wrap?.querySelector('.msg-text');
  if (!wrap || !textEl) return;
  const expanded = wrap.getAttribute('data-expanded') === '1';
  if (expanded){
    // voltar a colapsar
    textEl.classList.add('clamped');
    wrap.setAttribute('data-expanded','0');
    btn.textContent = 'Ler mais';
  } else {
    textEl.classList.remove('clamped');
    wrap.setAttribute('data-expanded','1');
    btn.textContent = 'Ver menos';
  }
}

function clampAllIn(container){
  if (!container) return;
  container.querySelectorAll('.msg-text-wrap[data-has-rm="1"]').forEach(clampIfNeeded);
}

/* ========== Cache + utils ========== */
if (!window.cacheHistoricos) window.cacheHistoricos = {};
if (!window.salvarCache) {
  window.salvarCache = () => {
    try {
      const LS_HIST = `cacheHistoricos:${EMPRESA_ID}`;
      localStorage.setItem(LS_HIST, JSON.stringify(window.cacheHistoricos || {}));
    } catch {}
  };
}

function ensureArray(a){ return Array.isArray(a) ? a : []; }
function ordenarMensagens(arr){
  return ensureArray(arr).sort((a,b)=>{
    const aD = parseAtendimentoDate(a.timestamp || a.data || a.created_at || '');
    const bD = parseAtendimentoDate(b.timestamp || b.data || b.created_at || '');
    return (aD?aD.getTime():0) - (bD?bD.getTime():0);
  });
}
function escapeHtml(s){
  return (s||'').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}
function _humanSize(bytes){
  const b=Number(bytes||0); if(!b) return ''; const u=['B','KB','MB','GB']; const i=Math.floor(Math.log(b)/Math.log(1024));
  return `${(b/Math.pow(1024,i)).toFixed(i?1:0)} ${u[i]}`;
}
function _basenameFromUrl(u){
  try{ const p = new URL(u, location.origin).pathname; const b = p.split('/').pop() || ''; return decodeURIComponent(b); }
  catch{ return ''; }
}
function _guessExt({ mimetype='', filename='', url='' }={}){
  const fromName = (filename||'').split('.').pop()?.toLowerCase()
    || _basenameFromUrl(url).split('.').pop()?.toLowerCase() || '';
  const map = { 'application/pdf':'pdf','application/msword':'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
    'application/vnd.ms-excel':'xls','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
    'application/vnd.ms-powerpoint':'ppt','application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx',
    'text/plain':'txt','image/png':'png','image/jpeg':'jpg','image/webp':'webp',
    'audio/mpeg':'mp3','audio/ogg':'ogg','audio/wav':'wav','video/mp4':'mp4' };
  return (map[mimetype] || fromName || 'bin').toLowerCase();
}
function _sanitizeBase(name){
  const n = (name||'').toString().trim() || 'arquivo';
  return n.normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\w\-.]+/g,'_').replace(/_+/g,'_')
    .replace(/^_+|_+$/g,'').slice(0,80);
}
function deriveFileName(a){
  const url = a.url || a.link || a.path || '';
  const baseRaw = a.filename || a.name || a.nome_original || _basenameFromUrl(url) || 'arquivo';
  const base = _sanitizeBase(baseRaw.replace(/\.[a-z0-9]{1,6}$/i,'')); 
  const ext  = _guessExt({ mimetype:(a.mimetype||a.mime||''), filename:(a.filename||a.name||''), url });
  return { fileName: `${base}.${ext}`, extUp: ext.toUpperCase(), extLower: String(ext).toLowerCase() };
}
function buildCanonUrlByMsgId(msg_id){
  return `/api/atendimento/midias/msg/${encodeURIComponent(msg_id)}?empresa_id=${EMPRESA_ID}`;
}

/* ========= instancia ativa ========= */
function getInstanciaForFetch() {
  try {
    return (
      window.state?.clienteSel?.instancia_id ??
      window.state?.clienteSel?.instancia ??
      window.INSTANCIA_ATIVA ?? null
    )?.toString() || null;
  } catch { return null; }
}

/* ========= salvar cache unificado ========= */
export function salvarNoCache(clienteId, novos){
  const cid = Number(clienteId);
  const inst = getInstanciaForFetch() || (Array.isArray(novos) ? (novos[0]?.instancia_id ?? null) : null) || null;

  const cur = ensureArray(getHist(inst, cid));
  const merged = [...cur, ...ensureArray(novos)];

  const byId = new Map();
  const noId = [];
  for (const m of merged){
    const k = (m && m.msg_id) ? String(m.msg_id) : '';
    if (k) {
      const prev = byId.get(k);
      if (!prev) byId.set(k, m);
      else {
        const ack = Math.max(Number(prev.ack||0), Number(m.ack||0));
        const ts  = (parseAtendimentoDate(m.timestamp||m.data||m.created_at||'')?.getTime()||0) >
                    (parseAtendimentoDate(prev.timestamp||prev.data||prev.created_at||'')?.getTime()||0)
                    ? (m.timestamp||m.data||m.created_at)
                    : (prev.timestamp||prev.data||prev.created_at);
        byId.set(k, { ...prev, ...m, ack, timestamp: ts });
      }
    } else noId.push(m);
  }
  const finalArr = ordenarMensagens([ ...byId.values(), ...noId ]);

  primeWith(inst, cid, finalArr, null);
  window.cacheHistoricos[cid] = finalArr;
  window.salvarCache?.();
}

/* ========= helpers de detecção ========= */
const MARKER_RE = /^\[(Imagem|Vídeo|Video|Áudio\/ptt|Áudio|Audio|Documento|Figurinha|Localização|Contatos?|M[íi]dia)\]/i;
const CALL_RE = /^\s*\[Ligação\]\s*(.+?)\s*[–-]\s*(enviada|recebida)\s*\(([^)]+)\)\s*$/i;

/* ======= Byline helpers (responsável acima da bolha) ======= */
function _autorDaMensagem(m){
  // Preferência: whatsapp físico (quando vier marcado) → 'WhatsApp físico'
  const origem = String(m?.origem || '').toLowerCase();
  const fisico = origem === 'whatsapp_fisico' || !!m?.from_phone ||
                 /f[ií]sico/i.test(String(m?.instance_name||''));
  if (fisico) return 'WhatsApp físico';

  // Nome do atendente, se existir; senão, o usuário logado
  const nome = m?.atendente_nome || m?.autor_nome ||
               (window.OperatorLine?.getName?.() || 'Operador(a)');
  return nome;
}

/* ========= render de 1 mensagem ========= */
export function criarHTMLDaMensagem(m){
  const isSaida = (m.tipo === 'saida') || (m.from_me === true) || (m.origem === 'atendente');
  const texto = String(m.conteudo ?? m.mensagem ?? m.texto ?? '').trim();
  const ackVal = Number(m.ack ?? 0);
  const msgIdAttr = m.msg_id || '';
  let mediaHtml = '';

  // anexos…
  let anexos = [];
  if (Array.isArray(m.midias) && m.midias.length) anexos.push(...m.midias.filter(Boolean));
  else if (m.midia && typeof m.midia === 'object') anexos.push(m.midia);
  const seen = new Set();
  anexos = anexos.filter(a=>{
    const k = [a?.id ?? '', a?.url || a?.url_api || a?.link || a?.path || '', a?.tipo || '', a?.mimetype || a?.mime || '', a?.filename || a?.name || ''].join('|');
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  function resolveUrlsForMedia(m, a){
    const MSG_CANON = m?.msg_id ? buildCanonUrlByMsgId(m.msg_id) : null;
    const idUrl     = a?.id ? `/api/atendimento/midias/${encodeURIComponent(a.id)}?empresa_id=${EMPRESA_ID}` : '';
    const primary   = MSG_CANON || a?.url_api || a?.url || a?.link || a?.path || idUrl;
    const alts      = [];
    if (MSG_CANON) [a?.url_api, a?.url, a?.link, a?.path, idUrl].forEach(u=>u && alts.push(u));
    const s=new Set();
    return [primary, ...alts].filter(u=>u && !s.has(u) && s.add(u));
  }

  const renderAnexo = (a)=>{
    if (!a) return '';
    const urls = resolveUrlsForMedia(m, a);
    const [url, ...alts] = urls;
    const mime = (a.mimetype || a.mime || '').toLowerCase();
    const tipo = (a.tipo || '').toLowerCase();
    const name = a.filename || a.name || 'arquivo';

    if (tipo.includes('imagem') || tipo.includes('image') || tipo.includes('figurinha') || mime.startsWith('image/')){
      return `<a class="msg-media-img" href="${url}" target="_blank" rel="noopener">
                <img src="${url}" data-alt="${alts.join('|')}" alt="${escapeHtml(name)}" loading="lazy">
              </a>`;
    }
    if (tipo.includes('vídeo') || tipo.includes('video') || mime.startsWith('video/')){
      return `<video class="msg-media-video" controls preload="metadata">
                ${urls.map(u=>`<source src="${u}">`).join('')}
              </video>`;
    }
    if (tipo.includes('áudio') || tipo.includes('audio') || tipo.includes('ptt') || mime.startsWith('audio/')){
      return `<audio controls preload="metadata" style="max-width:min(420px,70vw)">
                ${urls.map(u=>`<source src="${u}">`).join('')}
              </audio>`;
    }
    const { fileName, extUp } = deriveFileName({ mimetype: mime, filename: name, url });
    const sizeTxt = _humanSize(a.size || a.bytes || a.length) || '';
    return `<div class="doc-card">
      <div class="doc-ico" style="background:#d9e0e3"><span class="ext">${extUp}</span></div>
      <div class="doc-body">
        <a class="doc-name" href="${url}" target="_blank" rel="noopener" download="${fileName}" title="${fileName}">${escapeHtml(fileName)}</a>
        <div class="doc-meta">${sizeTxt || 'arquivo'}</div>
      </div>
      <div class="doc-actions">
        <a class="doc-btn" href="${url}" target="_blank" rel="noopener">Abrir</a>
        <a class="doc-btn" href="${url}" download="${fileName}">Salvar</a>
      </div>
    </div>`;
  };

  mediaHtml = anexos.map(renderAnexo).join('');

  if (!mediaHtml && m.msg_id && MARKER_RE.test(texto)) {
    const src = buildCanonUrlByMsgId(m.msg_id);
    const kind = texto.replace(/^\[|\].*$/g,'').toLowerCase();
    if (kind.startsWith('imagem')) {
      mediaHtml = `<a class="msg-media-img" href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="imagem" loading="lazy"></a>`;
    } else if (kind.startsWith('vídeo') || kind.startsWith('video')) {
      mediaHtml = `<video class="msg-media-video" controls preload="metadata"><source src="${src}"></video>`;
    } else if (kind.startsWith('áudio') || kind.startsWith('audio')) {
      mediaHtml = `<audio controls preload="metadata" style="max-width:min(420px,70vw)"><source src="${src}"></audio>`;
    } else if (kind.startsWith('figurinha')) {
      mediaHtml = `<img class="msg-sticker" src="${src}" alt="figurinha" loading="lazy">`;
    } else {
      const fname = 'arquivo.bin';
      mediaHtml = `<div class="doc-card">
        <div class="doc-ico" style="background:#d9e0e3"><span class="ext">FILE</span></div>
        <div class="doc-body">
          <a class="doc-name" href="${src}" target="_blank" rel="noopener" download="${fname}" title="${fname}">${fname}</a>
          <div class="doc-meta">arquivo</div>
        </div>
        <div class="doc-actions">
          <a class="doc-btn" href="${src}" target="_blank" rel="noopener">Abrir</a>
          <a class="doc-btn" href="${src}" download="${fname}">Salvar</a>
        </div>
      </div>`;
    }
  }

  // ======= Cabeçalho especial de ligação =======
  let callHeader = '';
  let callIsMatch = false;
  let bodyText = texto; // texto que será exibido (podemos limpar o marcador)

  const mCall = CALL_RE.exec(texto);
  if (mCall) {
    callIsMatch = true;
    const kind = (mCall[1] || '').trim();      // vídeo/voz/etc
    const dir  = (mCall[2] || '').trim();      // enviada/recebida
    const st   = (mCall[3] || '').trim();      // finalizada/perdida/…
    // Remove do corpo para evitar duplicar com o cabeçalho
    bodyText = texto.replace(CALL_RE, '').trim();
    callHeader = `
      <div class="msg-call" title="Ligação">
        <span class="ico" aria-hidden="true">📞</span>
        <span class="kind">${escapeHtml(kind)}</span>
        <span class="sep">—</span>
        <span class="dir">${escapeHtml(dir)}</span>
        <span class="st">(${escapeHtml(st)})</span>
      </div>
    `;
  }

  const hasMedia = mediaHtml.trim().length > 0;
  const hasText  = !!bodyText;

  // <<< texto: envolve para suportar "Ler mais" (não aplica clamp no cabeçalho de ligação)
  const textHtmlRaw = hasText
    ? `<div class="msg-text">${escapeHtml(bodyText)}</div>`
    : (!hasMedia && !callIsMatch ? `<div class="msg-text">&nbsp;</div>` : '');
  const textHtml = hasText ? buildReadMoreWrap(textHtmlRaw) : textHtmlRaw;

  const ackHtml = isSaida
    ? `<span class="msg-ack" data-ack="${ackVal}" data-msg-id="${msgIdAttr}">${
        (typeof window.getAckIcon === 'function') ? window.getAckIcon(ackVal) : ''
      }</span>`
    : '';

  // ======= Byline (acima da bolha, só em saídas) =======
  const bylineTxt = isSaida ? _autorDaMensagem(m) : '';
  const timeTxt   = formatChatTime(m.timestamp || m.data || m.created_at || '');

  return `<div class="msg-row ${isSaida ? 'msg-sent' : 'msg-received'}" data-id="${msgIdAttr}" data-msg-id="${msgIdAttr}">
    ${isSaida ? `<div class="byline">${escapeHtml(bylineTxt)} <small>${escapeHtml(timeTxt)}</small></div>` : ''}
    <div class="bubble ${isSaida ? 'bubble-out' : 'bubble-in'}" data-msg-id="${msgIdAttr}">
      ${callHeader}${mediaHtml}${textHtml}
      <div class="meta">
        ${ackHtml}
        <span class="msg-time">${timeTxt}</span>
      </div>
    </div>
  </div>`;
}

/* ========= render ========= */
export function renderHistoricoDoCache(clienteId, append=false){
  if (!hist || hist.dataset.clienteId !== String(clienteId)) return;

  const inst = getInstanciaForFetch();
  const msgs = ordenarMensagens(ensureArray(getHist(inst, Number(clienteId))));

  ensureTopLoader(); // garante loader existente

  if (!append){
    hist.innerHTML='';
    ensureTopLoader(); // re-adiciona pós-clean
    msgs.forEach(m=> hist.insertAdjacentHTML('beforeend', criarHTMLDaMensagem(m)));
    hist.querySelectorAll('.msg-row.msg-received .msg-ack, .bubble-in .msg-ack').forEach(n=>n.remove());
    hist.scrollTop = hist.scrollHeight;
  } else {
    const seenSel = (m) => `.msg-row[data-msg-id="${m.msg_id}"], .msg-row[data-id="${m.msg_id}"]`;
    const novas = msgs.filter(m => !hist.querySelector(seenSel(m)));

    const lastRow = hist.querySelector('.msg-row:last-of-type');
    novas.forEach(m=>{
      if (lastRow) lastRow.insertAdjacentHTML('afterend', criarHTMLDaMensagem(m));
      else hist.insertAdjacentHTML('beforeend', criarHTMLDaMensagem(m));
    });

    hist.querySelectorAll('.msg-row.msg-received .msg-ack, .bubble-in .msg-ack').forEach(n=>n.remove());
    hist.scrollTop = hist.scrollHeight;
  }

  // aplica "ler mais" nas que precisarem
  clampAllIn(hist);

  // pinta acks que já existam
  try{ window.reconcilePendingAcks?.(); }catch{}
}

/* ========= append util ========= */
export function appendToHistory(clienteId, msg){
  salvarNoCache(clienteId, [msg]);
}

/* ========= offset helpers ========= */
function getOffsetsObj(){
  return (window.state && typeof window.state === 'object')
    ? (window.state.mensagensOffset = (window.state.mensagensOffset || {}))
    : (window.mensagensOffset = (window.mensagensOffset || {}));
}
function getOffset(id){
  const table = getOffsetsObj();
  return (typeof table[id] === 'number') ? table[id] : HISTORICO_LIMIT;
}
function setOffset(id, val){
  const table = getOffsetsObj();
  table[id] = Number(val)||0;
  try { window.persist?.(); } catch {}
}

/* ========= FETCH helpers ========= */
function getInstQuery(){
  const inst = getInstanciaForFetch();
  if (!inst) return '';
  const n = Number(inst);
  return Number.isFinite(n) ? `&instancia_id=${n}` : `&instance=${encodeURIComponent(String(inst))}`;
}

/* ========= abrir primeira página do histórico ========= */
export async function abrirHistorico(id){
  if (!hist) return false;
  hist.dataset.clienteId = String(id);
  hist.dataset.noMore = '0';
  setOffset(id, 0);

  try{
    const url = `/api/atendimento/conversas/${id}/mensagens?empresa_id=${EMPRESA_ID}&limit=${HISTORICO_LIMIT}${getInstQuery()}`;
    const r = await fetch(url, { credentials:'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);

    primeWith(getInstanciaForFetch(), Number(id), items, null);
    window.cacheHistoricos[id] = ordenarMensagens(items);
    window.salvarCache?.();

    renderHistoricoDoCache(id, false);
    setOffset(id, items.length);
    return true;
  }catch(e){
    console.error('[historico] abrirHistorico', e);
    return false;
  }
}

/* ========= paginação (scroll up) ========= */
let loadingOld = false;
export async function carregarMaisHistorico(id){
  if (loadingOld) return false;
  if (!id) return false;
  if (!hist || hist.dataset.clienteId !== String(id)) return false;
  if (hist.dataset.noMore === '1') return false;

  loadingOld = true;
  showTopLoader();

  const limit = HISTORICO_LIMIT;
  const off   = getOffset(id);

  try{
    const url = `/api/atendimento/conversas/${id}/mensagens?empresa_id=${EMPRESA_ID}&limit=${limit}&offset=${off}${getInstQuery()}`;
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) { hist.dataset.noMore='1'; return false; }
    const data = await r.json();
    const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
    const n = items.length;
    if (!n){ hist.dataset.noMore='1'; return false; }

    const beforeHeight = hist.scrollHeight;
    mergeOld(getInstanciaForFetch(), Number(id), items);

    // re-render preservando posição
    const prevBottom = beforeHeight - hist.scrollTop;
    renderHistoricoDoCache(id, false);
    hist.scrollTop = hist.scrollHeight - prevBottom;

    setOffset(id, off + n);
    return true;
  }catch(e){
    console.error('[historico] carregarMaisHistorico', e);
    return false;
  }finally{
    hideTopLoader();
    loadingOld = false;
  }
}

/* ========= Scroll & events ========= */
(function bindScrollAndClicks(){
  if (!hist) return;
  if (!hist.__boundScroll){
    hist.addEventListener('scroll', ()=> {
      if (hist.scrollTop <= 60){
        carregarMaisHistorico(Number(hist.dataset.clienteId || 0));
      }
    }, { passive:true });
    hist.__boundScroll = true;
  }
  if (!hist.__boundReadMore){
    hist.addEventListener('click', (ev)=>{
      const btn = ev.target.closest('.rm-toggle');
      if (btn) toggleClamp(btn);
    });
    hist.__boundReadMore = true;
  }
})();

/* ========= debug globals ========= */
window.renderHistoricoDoCache = renderHistoricoDoCache;
window.salvarNoCache = salvarNoCache;
window.abrirHistorico = abrirHistorico;
window.clampAllIn = clampAllIn; // opcional para debugar/reaplicar manualmente
