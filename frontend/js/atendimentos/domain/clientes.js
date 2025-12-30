// /frontend/js/atendimentos/domain/clientes.js
// =====================================================================
// LISTA DE CONVERSAS (render, dedupe, preview, paginação)
// ✅ Falhou imagem => placeholder (SEM refresh)
// ✅ Daily refresh 1x/dia: só sem foto, top 50, conc 2, localStorage
// =====================================================================

import { EMPRESA_ID } from '../core/env.js';
import { fetchWithCache } from '../core/cache.js';
import { _matchInstancia, _instQuery } from './instances.js';
import { state, persist } from '../state/store.js';
import { tsToMillis, formatChatTime } from '../core/time.js';
import { escapeHtml, formatarNumeroBR, badge } from '../core/format.js';

// >>> HISTÓRICO LOCAL (nova base de cache)
import { hasHistory, primeWith, getHist } from '../domain/hist-cache.js';

/* =========================================================
   Toggle global: prefetch leve de mensagens (ligado por padrão)
   ========================================================= */
if (typeof window !== 'undefined') {
  if (window.PREFETCH_HISTORIES === undefined) {
    window.PREFETCH_HISTORIES = true;
  }
}

/* =========================================================
   AVATAR: handlers globais (placeholder-only, sem refresh onerror)
   ========================================================= */
function _ensureAvatarPlaceholder(span){
  try{
    if (!span) return;
    span.classList.add('placeholder');
    span.innerHTML = '<i class="fa fa-user-circle"></i>';
  }catch{}
}

if (typeof window !== 'undefined') {
  // ✅ LISTA: só placeholder
  window.handleListAvatarError = function(imgEl, clienteId){
    try{
      if (!imgEl) return;
      try { imgEl.onerror = null; } catch {}
      const span = imgEl.closest?.('.avatar') || imgEl.parentElement;
      try { imgEl.remove(); } catch {}
      _ensureAvatarPlaceholder(span);
    }catch{}
  };

  // ✅ HEADER (caso alguém use aqui): só placeholder
  window.handleAvatarError = function(imgEl){
    try{
      if (!imgEl) return;
      try { imgEl.onerror = null; } catch {}
      const span = imgEl.closest?.('.avatar') || imgEl.parentElement;
      try { imgEl.remove(); } catch {}
      if (span) {
        span.classList.add('avatar-default');
        span.innerHTML = '<i class="fa fa-user-circle"></i>';
      }
    }catch{}
  };
}

/* =========================================================
   Daily refresh (1x/dia) - só quem tá sem foto, top 50, conc 2
   ========================================================= */
let __dailyKickScheduled = false;
let __dailyRunning = false;

function _ymdLocal(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}${mm}${dd}`;
}

function _dailyKey(){
  return `av_daily:v1:e${Number(EMPRESA_ID||0)}:d${_ymdLocal()}`;
}

function _shouldRunDaily(){
  try{
    if (window.AVATAR_DAILY_REFRESH === false) return false;
    const k = _dailyKey();
    return !localStorage.getItem(k);
  }catch{
    return true;
  }
}

function _markDaily(){
  try{
    localStorage.setItem(_dailyKey(), String(Date.now()));
  }catch{}
}

async function runDailyAvatarRefresh(){
  try{
    if (__dailyRunning) return;
    if (!_shouldRunDaily()) return;

    // só roda se o refresh existir (perfil_quick.js)
    if (typeof window.refreshAvatarFromEvolution !== 'function') return;

    __dailyRunning = true;

    const limit = Math.max(1, Math.min(200, Number(window.AVATAR_DAILY_LIMIT || 50)));
    const conc  = Math.max(1, Math.min(6, Number(window.AVATAR_DAILY_CONCURRENCY || 2)));

    const base = Array.isArray(state.clientesCache) ? state.clientesCache.slice() : [];
    if (!base.length) { _markDaily(); return; }

    // top 50 mais recentes (com pin primeiro, igual UI)
    const topRecent = ordenarConversasDesc(base).slice(0, limit);

    // só quem está sem foto
    const targets = topRecent.filter(c => !c?.avatar_url);

    // marca no começo (não repete no mesmo dia)
    _markDaily();

    if (!targets.length) return;

    const queue = targets.slice();

    const workers = Array.from(
      { length: Math.min(conc, queue.length) },
      async () => {
        while (queue.length) {
          const c = queue.shift();
          const cid = Number(c?.id ?? c?.conversation_id ?? 0);
          if (!cid) continue;

          const number = (c?.telefone_norm || c?.telefone || c?.number || '');
          const instRaw = (c?.instancia_id ?? c?.instancia ?? null);

          // monta opt com instância do PRÓPRIO contato
          const opt = {
            trigger: 'daily',
            number,
            instancia_raw: instRaw
          };

          try{
            await window.refreshAvatarFromEvolution(cid, opt);
          }catch{}
        }
      }
    );

    await Promise.all(workers);
  } finally {
    __dailyRunning = false;
  }
}

function kickDailyAvatarRefreshSoon(){
  if (__dailyKickScheduled) return;
  __dailyKickScheduled = true;
  setTimeout(() => { try { runDailyAvatarRefresh(); } catch {} }, 350);
}

// expõe global (init.js também pode chamar)
if (typeof window !== 'undefined') {
  window.runDailyAvatarRefresh = window.runDailyAvatarRefresh || runDailyAvatarRefresh;
}

/* =========================================================
   Helpers
   ========================================================= */
function normalizaTelefoneBR(s) {
  const raw = String(s ?? '');
  if (raw.includes('@')) return '';
  const d = raw.replace(/\D/g, '');
  const sem55 = (d.startsWith('55') && d.length > 11) ? d.slice(2) : d;
  return (sem55.length === 10 || sem55.length === 11) ? sem55 : '';
}

function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

function temValor(v) { return v !== undefined && v !== null; }

function scoreRecencia(c) {
  const ts = tsToMillis(c.hora || c.last_ts) || 0;
  const mid = Number(c.ultima_msg_id || 0);
  const ack = Number(c.last_ack || 0);
  const ava = c.avatar_url ? 1 : 0;
  return ts * 1_000_000 + mid * 1_000 + ack * 10 + ava;
}

// 🔼 PINS primeiro, depois recência
function ordenarConversasDesc(arr) {
  const A = Array.isArray(arr) ? arr.slice() : [];
  return A.sort((a, b) => {
    const pinCmp = Number(b?.pinned ? 1 : 0) - Number(a?.pinned ? 1 : 0);
    if (pinCmp !== 0) return pinCmp;

    const recCmp = scoreRecencia(b) - scoreRecencia(a);
    if (recCmp !== 0) return recCmp;

    const ib = Number(b.id ?? b.conversation_id ?? b.cliente_id ?? 0);
    const ia = Number(a.id ?? a.conversation_id ?? a.cliente_id ?? 0);
    return ib - ia;
  });
}

/**
 * Dedupe em 3 fases (preserva .pinned)
 */
function dedupeConversas(arr) {
  if (!Array.isArray(arr)) return [];

  const base = ordenarConversasDesc(arr);

  const byKey = new Map();
  for (const c of base) {
    const inst = String(c.instancia_id ?? c.instancia ?? 'all');
    const pref = temValor(c.conversation_id) ? c.conversation_id
      : temValor(c.cliente_id) ? c.cliente_id
        : temValor(c.id) ? c.id
          : `noid:${Math.random()}`;
    const key = `${inst}:${pref}`;
    const cur = byKey.get(key);

    if (!cur || scoreRecencia(c) > scoreRecencia(cur)) {
      byKey.set(key, { ...c, pinned: Boolean(c.pinned || cur?.pinned) });
    } else if (cur) {
      cur.pinned = Boolean(cur.pinned || c.pinned);
    }
  }

  const byFone = new Map();
  const semFone = [];
  for (const c of byKey.values()) {
    const inst = String(c.instancia_id ?? c.instancia ?? 'all');
    const telNorm = normalizaTelefoneBR(c.telefone);
    if (!telNorm) { semFone.push(c); continue; }
    const fkey = `${inst}:${telNorm}`;
    const cur = byFone.get(fkey);

    if (!cur || scoreRecencia(c) > scoreRecencia(cur)) {
      byFone.set(fkey, { ...c, pinned: Boolean(c.pinned || cur?.pinned) });
    } else if (cur) {
      cur.pinned = Boolean(cur.pinned || c.pinned);
    }
  }

  const byInstNomeComFone = new Map();
  for (const [key, val] of byFone.entries()) {
    const instKey = String(key).split(':')[0];
    const inst = instKey || String(val.instancia_id ?? val.instancia ?? 'all');
    const nomeNorm = normalizeName(val.nome_whatsapp || val.nome || val.push_name);
    if (!nomeNorm) continue;

    const nmMap = byInstNomeComFone.get(inst) || new Map();
    const cur = nmMap.get(nomeNorm);

    if (!cur || scoreRecencia(val) > scoreRecencia(cur)) {
      nmMap.set(nomeNorm, { ...val, pinned: Boolean(val.pinned || cur?.pinned) });
    } else if (cur) {
      cur.pinned = Boolean(cur.pinned || val.pinned);
    }
    byInstNomeComFone.set(inst, nmMap);
  }

  const byInstNomeOnly = new Map();
  for (const c of semFone) {
    const inst = String(c.instancia_id ?? c.instancia ?? 'all');
    const nomeNorm = normalizeName(c.nome_whatsapp || c.nome || c.push_name);

    if (!nomeNorm) {
      const key = `${inst}:__no_phone__:${c.id ?? c.conversation_id ?? Math.random()}`;
      const cur = byFone.get(key);
      if (!cur || scoreRecencia(c) > scoreRecencia(cur)) {
        byFone.set(key, { ...c, pinned: Boolean(c.pinned || cur?.pinned) });
      } else if (cur) {
        cur.pinned = Boolean(cur.pinned || c.pinned);
      }
      continue;
    }

    const nmMap = byInstNomeComFone.get(inst);
    const comFone = nmMap?.get(nomeNorm);

    if (comFone) {
      const cScore = scoreRecencia(c);
      const fScore = scoreRecencia(comFone);

      if (cScore > fScore) {
        if (temValor(c.hora) && (!temValor(comFone.hora) || tsToMillis(c.hora) > tsToMillis(comFone.hora))) {
          comFone.hora = c.hora;
        }
        if (temValor(c.ultima_mensagem) && String(c.ultima_mensagem).trim()) {
          comFone.ultima_mensagem = c.ultima_mensagem;
        }
        if (temValor(c.last_ack)) {
          comFone.last_ack = Math.max(Number(comFone.last_ack || 0), Number(c.last_ack || 0));
        }
      }
      comFone.pinned = Boolean(comFone.pinned || c.pinned);
    } else {
      const onlyMap = byInstNomeOnly.get(inst) || new Map();
      const cur = onlyMap.get(nomeNorm);
      if (!cur || scoreRecencia(c) > scoreRecencia(cur)) {
        onlyMap.set(nomeNorm, { ...c, pinned: Boolean(c.pinned || cur?.pinned) });
      } else if (cur) {
        cur.pinned = Boolean(cur.pinned || c.pinned);
      }
      byInstNomeOnly.set(inst, onlyMap);
    }
  }

  for (const [inst, onlyMap] of byInstNomeOnly.entries()) {
    for (const [nomeNorm, item] of onlyMap.entries()) {
      const key = `${inst}:__name_only__:${nomeNorm}`;
      const cur = byFone.get(key);
      if (!cur || scoreRecencia(item) > scoreRecencia(cur)) {
        byFone.set(key, { ...item, pinned: Boolean(item.pinned || cur?.pinned) });
      } else if (cur) {
        cur.pinned = Boolean(cur.pinned || item.pinned);
      }
    }
  }

  return ordenarConversasDesc([...byFone.values()]);
}

/* =========================================================
   Normalização (suporta /conversas e legado /clientes)
   ========================================================= */
export function normalizeCliente(c) {
  const inst =
    c.instancia_id ?? c.instancia ?? c.instancia_slug ??
    c.instance_id ?? c.instance ?? c.session ?? c.sessionName ?? c.sessao ?? c.inst_slug ?? null;

  const id = Number(c.conversation_id ?? c.cliente_id ?? c.id ?? c.cid ?? 0) || null;

  const rawHora =
    c.ultima_ts ?? c.hora ?? c.last_ts ?? c.updated_at ?? c.last_message_at ?? c.timestamp ?? null;

  const preview =
    c.ultima_texto ?? c.ultima_mensagem ?? c.ultima ?? c.last_text ?? '';

  const fotoRaw =
    c.avatar_url || c.foto_url || c.foto || c.avatar || c.profile_pic_url || '';
  const fotoStr = String(fotoRaw || '').trim();
  const fotoOk = fotoStr && !/^(null|undefined|about:blank)$/i.test(fotoStr);
  const foto = fotoOk ? fotoStr : '';

  return {
    id,
    conversation_id: temValor(c.conversation_id) ? c.conversation_id : id,
    cliente_id: temValor(c.cliente_id) ? c.cliente_id : id,

    nome_whatsapp: c.nome_whatsapp ?? null,
    nome: c.nome ?? null,
    push_name: c.push_name ?? null,

    telefone: c.telefone ?? c.number ?? c.wuid ?? c.numero ?? null,
    telefone_norm: normalizaTelefoneBR(c.telefone ?? c.number ?? c.wuid ?? c.numero ?? null),

    avatar_url: foto ? foto : null,

    ultima_msg_id: c.ultima_msg_id ?? c.last_msg_id ?? null,
    ultima_mensagem: preview,
    hora: rawHora,
    last_ts: c.last_ts ?? null,

    novas: Number(c.novas ?? 0),
    last_tipo: c.ultima_tipo ?? c.last_tipo ?? c.tipo ?? null,
    last_ack: c.ultima_ack ?? c.last_ack ?? c.ack ?? null,

    instancia_id: inst,
    instancia: inst,

    pinned: Boolean(c.pinned || c.fixado || c.pin || false),
  };
}

/* =========================================================
   PRIME: baixar últimas 30 msgs por conversa (prefetch leve)
   ========================================================= */
function buildMsgsUrl(convId, instanciaId, extra = {}) {
  const qs = new URLSearchParams({
    empresa_id: String(EMPRESA_ID),
    limit: String(extra.limit || 30),
  });

  if (instanciaId != null && instanciaId !== '' && instanciaId !== 'all') {
    qs.set('instancia_id', String(instanciaId));
  }
  if (extra.since_ts) qs.set('since_ts', String(extra.since_ts));
  if (extra.since_id) qs.set('since_id', String(extra.since_id));

  return `/api/atendimento/conversas/${convId}/mensagens?` + qs.toString();
}

async function fetchConv30(convId, instanciaId) {
  const url = buildMsgsUrl(convId, instanciaId);
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('Falha ao carregar mensagens da conversa ' + convId);
  const data = await r.json();
  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
  const cursors = {
    oldest: data?.prev_cursor ?? null,
    newest: data?.next_cursor ?? null
  };
  return { items, cursors };
}

const PREFETCH_LIMIT = 10;

async function primeHistories(convs, { concurrency = 2 } = {}) {
  if (!window.PREFETCH_HISTORIES) return;

  const lista = Array.isArray(convs) ? convs.slice() : [];

  const unread = lista
    .filter(c => Number(c.novas || 0) > 0)
    .slice(0, PREFETCH_LIMIT);

  if (!unread.length) return;

  const queue = unread.slice();

  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, queue.length)) },
    async () => {
      while (queue.length) {
        const c = queue.shift();
        const inst = c.instancia_id ?? c.instancia ?? null;

        try {
          const { items, cursors } = await fetchConv30(c.id, inst);
          primeWith(inst, c.id, items, cursors);
          try { window.syncPreviewFromCache?.(c.id); } catch {}
        } catch (e) {
          try { console.debug('[primeHistories] erro conv', c.id, e); } catch {}
        }
      }
    }
  );

  await Promise.all(runners);
}

/* =========================================================
   Carregar primeira página (20 conversas)
   ========================================================= */
let _isWired = false;
let _isLoadingMore = false;
let __loadingConversas = false;

export async function carregarClientes({ force = false } = {}) {
  if (__loadingConversas) return state.clientesCache || [];
  __loadingConversas = true;

  try {
    const instKey = (_instQuery() || '').replace(/^[?&]+/, '') || 'all';
    const key = `conversas:v1:${EMPRESA_ID}:${instKey}`;
    const url = `/api/atendimento/conversas?empresa_id=${EMPRESA_ID}&limit=20${_instQuery()}`;

    const forceFlag = force || (sessionStorage.getItem('convForceReload') === '1');
    if (forceFlag) { try { sessionStorage.removeItem('convForceReload'); } catch {} }

    const raw = await fetchWithCache(
      url,
      { ttlMs: forceFlag ? 0 : 30_000, key, bust: forceFlag }
    );

    const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : []);
    const next = raw?.next_cursor ?? null;

    let cs = items.map(normalizeCliente).filter(_matchInstancia);

    const antigo = Array.isArray(state.clientesCache) ? state.clientesCache : [];

    cs.forEach(n => {
      const a = antigo.find(x => (x.id ?? x.conversation_id) === n.id);

      const oldTs = tsToMillis(a?.hora || a?.last_ts);
      const newTs = tsToMillis(n.hora || n.last_ts);
      const tsCanon = tsToMillis(n.hora || n.last_ts || a?.hora || a?.last_ts);
      if (tsCanon) n.hora = tsCanon;

      if (a && oldTs && newTs && oldTs > newTs) {
        if (a.ultima_mensagem && String(a.ultima_mensagem).trim()) {
          n.ultima_mensagem = a.ultima_mensagem;
        }
        if (a.last_tipo) n.last_tipo = a.last_tipo;
        if (a.last_tipo === 'saida' && temValor(a.last_ack)) {
          n.last_ack = Math.max(Number(n.last_ack || 0), Number(a.last_ack || 0));
        }
        if (temValor(a.novas) && (Number(n.novas) || 0) === 0) {
          n.novas = Number(a.novas) || 0;
        }
      } else {
        if (a && (!n.ultima_mensagem || !String(n.ultima_mensagem).trim()) && a?.ultima_mensagem) {
          n.ultima_mensagem = a.ultima_mensagem;
        }
        if (temValor(a?.novas) && (Number(n.novas) || 0) === 0) {
          n.novas = Number(a.novas) || 0;
        }
      }

      if (temValor(a?.last_ack)) {
        if (!temValor(n.last_ack)) n.last_ack = a.last_ack;
        else n.last_ack = Math.max(Number(n.last_ack || 0), Number(a.last_ack || 0));
      }

      n.pinned = Boolean(n.pinned || a?.pinned);
    });

    const setNovos = new Set(cs.map(x => String(x.id ?? x.conversation_id)));
    const extrasAntigos = antigo.filter(a => !setNovos.has(String(a.id ?? a.conversation_id)));

    let all = [...cs, ...extrasAntigos];
    all = dedupeConversas(all);

    state.clientesCache = all;
    state.nextCursor = next;
    persist();

    renderListaClientes(all);
    try { window.Lista?.render(all); } catch {}

    try { (state.clientesCache || []).forEach(c => window.syncPreviewFromCache?.(c.id)); } catch {}

    if (window.PREFETCH_HISTORIES) {
      try {
        await primeHistories(state.clientesCache, { concurrency: 2 });
      } catch (e) {
        try { console.debug('[carregarClientes] primeHistories erro', e); } catch {}
      }
    }

    // ✅ agenda o refresh diário (não trava UI)
    kickDailyAvatarRefreshSoon();

    return all;
  } finally {
    __loadingConversas = false;
  }
}

/* =========================================================
   Carregar mais conversas (botão)
   ========================================================= */
export function wireListaInfiniteScroll() {
  if (_isWired) return;
  _isWired = true;
}

export async function loadMoreConversas() {
  const cursor = state.nextCursor;
  if (!cursor) return;

  const url = `/api/atendimento/conversas?empresa_id=${EMPRESA_ID}&limit=20&cursor_last_msg_id=${encodeURIComponent(cursor)}${_instQuery()}`;
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) return;
  const data = await r.json();

  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
  const next = data?.next_cursor ?? null;

  const mais = items.map(normalizeCliente).filter(_matchInstancia);

  const map = new Map(state.clientesCache.map(c => [String((c.conversation_id ?? c.id)), c]));
  for (const it of mais) {
    const key = String(it.conversation_id ?? it.id);
    const prev = map.get(key) || {};
    const merged = { ...prev, ...it };
    merged.pinned = Boolean((prev && prev.pinned) || it.pinned);
    map.set(key, merged);
  }

  const arr = dedupeConversas([...map.values()]);

  state.clientesCache = arr;
  state.nextCursor = next;
  persist();

  renderListaClientes(arr);
  try { window.Lista?.render(arr); } catch {}

  try { (state.clientesCache || []).forEach(c => window.syncPreviewFromCache?.(c.id)); } catch {}
}

/* =========================================================
   Render da lista
   ========================================================= */
export function renderListaClientes(data) {
  const arr = dedupeConversas(
    (Array.isArray(data) ? data : []).map(normalizeCliente).filter(_matchInstancia)
  );
  const ul = document.getElementById('lista-clientes');
  if (!ul) return;

  const ordenado = ordenarConversasDesc(arr);

  let html = ordenado.map(c => {
    const nome = (c.nome_whatsapp && c.nome_whatsapp.trim())
      ? c.nome_whatsapp.trim()
      : (c.nome && c.nome.trim() && c.nome !== 'Cliente')
        ? c.nome.trim()
        : (c.push_name?.trim() || formatarNumeroBR(c.telefone));

    const serverMs = tsToMillis(c.hora || c.last_ts) || 0;
    let when = serverMs ? formatChatTime(serverMs) : '';
    let preview = (c.ultima_mensagem || '').trim();
    let outboundFlag = (c.last_tipo === 'saida');
    let ackValForIcon = Number(c.last_ack ?? 0) || 0;

    try {
      const instCanon = (c.instancia_id ?? c.instancia ?? null) || null;
      const arrHist = window.cacheHistoricos?.[c.id] || getHist(instCanon, c.id);
      if (Array.isArray(arrHist) && arrHist.length) {
        const last = arrHist[arrHist.length - 1];
        const histMs = Number(last?.ts || 0) || Date.parse(last?.timestamp || '') || 0;
        const rawHistText = (last?.texto || last?.text || last?.conteudo || last?.mensagem || '').trim();

        const useHist =
          (!serverMs && histMs) ||
          (histMs && serverMs && histMs > serverMs + 999) ||
          (!preview && rawHistText);

        if (useHist) {
          outboundFlag = (last?.tipo === 'saida') || !!last?.from_me || (last?.origem === 'atendente');
          ackValForIcon = outboundFlag ? (Number(last?.ack || 0) || 0) : 0;

          if (histMs) when = formatChatTime(histMs);

          if (rawHistText) {
            preview = rawHistText;
          } else {
            const a = Array.isArray(last?.midias) ? last.midias : [];
            const mime = String(a[0]?.mimetype || a[0]?.mime || '').toLowerCase();
            const hasAny = a.length > 0;
            preview = hasAny
              ? (mime.includes('image') ? '[Foto]'
                : mime.includes('video') ? '[Vídeo]'
                  : mime.includes('audio') ? '[Áudio]'
                    : mime.includes('pdf') ? '[PDF]'
                      : '[Arquivo]')
              : '';
          }
        } else {
          const histAck = Number(last?.ack || 0) || 0;
          if (histAck > ackValForIcon) {
            ackValForIcon = histAck;
          }
        }

        if (!when && serverMs) {
          when = formatChatTime(serverMs);
        }
      }
    } catch {}

    const outbound = outboundFlag;
    const dirStr = outbound ? 'out' : 'in';
    const ackVal = ackValForIcon;

    const ackHtml = outbound && typeof window.getAckIcon === 'function'
      ? `<span class="preview-ack" data-ack="${ackVal}">${window.getAckIcon(ackVal)}</span> `
      : '';

    const avatarUrl = c.avatar_url ? String(c.avatar_url).replace(/"/g, '&quot;') : '';
    const av = avatarUrl
      ? `<span class="avatar"><img src="${avatarUrl}" alt="" data-cliente-id="${c.id}"
                onerror="window.handleListAvatarError && window.handleListAvatarError(this, ${Number(c.id)})" /></span>`
      : `<span class="avatar placeholder"><i class="fa fa-user-circle"></i></span>`;

    const pinClass = c.pinned ? ' is-pinned' : '';

    return `
      <li class="chat-item cliente-item${pinClass}"
          id="chat-${c.id}"
          data-id="${c.id}"
          data-last-outbound="${outbound ? '1' : '0'}"
          data-last-dir="${dirStr}">
        ${av}
        <div class="chat-text">
          <div class="chat-name">${escapeHtml(nome || '')}</div>
          <div class="chat-last">
            ${ackHtml}<span class="preview-text">${escapeHtml(preview)}</span>
          </div>
        </div>
        <div class="chat-meta" style="text-align:right;">
          <div class="chat-time" style="color:#96a3aa;font-size:.86em;">${when}</div>
          ${badge(c.novas)}
        </div>
      </li>`;
  }).join('');

  const hasMore = Boolean(state.nextCursor);
  if (hasMore) {
    html += `
      <li class="chat-item load-more-item" id="lista-load-more">
        <button type="button" class="load-more-btn">
          Carregar mais conversas
        </button>
      </li>`;
  }

  ul.innerHTML = html;
  document.dispatchEvent(new CustomEvent('lista:rendered'));

  // ✅ FIX: avatares “vazios” (img existe mas quebrou / src ruim / erro antes do handler existir)
  (function fixBrokenAvatars() {
    ul.querySelectorAll('.avatar img').forEach(img => {
      const src = String(img.getAttribute('src') || '').trim();
      const isBadSrc = !src || /^(null|undefined|about:blank)$/i.test(src);

      const fix = () => {
        try{
          const li = img.closest('li.chat-item, li.cliente-item');
          const cidAttr = img.dataset.clienteId || li?.dataset?.id;
          const cid = cidAttr ? Number(cidAttr) : null;
          window.handleListAvatarError?.(img, cid || 0);
        }catch{}
      };

      try { img.addEventListener('error', fix, { once: true }); } catch {}
      if (isBadSrc) return fix();
      if (img.complete && img.naturalWidth === 0) return fix();
    });

    ul.querySelectorAll('.avatar').forEach(span => {
      if (!span.querySelector('img, i')) {
        span.classList.add('placeholder');
        span.innerHTML = '<i class="fa fa-user-circle"></i>';
      }
    });
  })();

  ul.querySelectorAll('.chat-item.cliente-item').forEach(el => {
    el.addEventListener('click', () => window.selecionarClienteObj?.(Number(el.dataset.id)));
  });

  if (hasMore) {
    const btn = ul.querySelector('#lista-load-more .load-more-btn');
    if (btn) {
      btn.addEventListener('click', async () => {
        if (!state.nextCursor) return;
        btn.disabled = true;
        btn.textContent = 'Carregando...';
        try {
          await loadMoreConversas();
        } finally {
          // renderListaClientes será chamado dentro de loadMoreConversas
        }
      });
    }
  }
}

/* =========================================================
   SHIM opcional de UI
   ========================================================= */
function _findClienteIndex(id) {
  const arr = Array.isArray(state.clientesCache) ? state.clientesCache : [];
  return arr.findIndex(c => (c.id ?? c.conversation_id) === Number(id));
}
function _reRender() {
  const arr = dedupeConversas(state.clientesCache || []);
  renderListaClientes(arr);
  persist();
}
function _touchHora(c, tsISO) {
  c.hora = tsISO || new Date().toISOString();
}

if (!window.Lista) {
  window.Lista = {
    render(data) {
      renderListaClientes(Array.isArray(data) ? data : (state.clientesCache || []));
    },
    updatePreview(clienteId, { texto, ts, ack, unreadDelta } = {}) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;
      const c = state.clientesCache[idx];
      if (typeof texto === 'string') c.ultima_mensagem = texto;
      if (temValor(ack)) {
        c.last_ack = Number(ack);
        c.last_tipo = 'saida';
      }
      if (unreadDelta) c.novas = Math.max(0, Number(c.novas || 0) + Number(unreadDelta || 0));
      _touchHora(c, ts);
      _reRender();
    },
    setAck(clienteId, ack) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;
      const c = state.clientesCache[idx];
      c.last_tipo = 'saida';
      const novo = Math.max(Number(c.last_ack || 0), Number(ack || 0));
      c.last_ack = novo;
      persist();
      _reRender();
    },
    bumpToTop(clienteId) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;
      const c = state.clientesCache[idx];
      _touchHora(c);
      _reRender();
    },
    resetUnread(clienteId) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;
      state.clientesCache[idx].novas = 0;
      _reRender();
    },
    setPinned(clienteId, isPinned) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;
      state.clientesCache[idx].pinned = !!isPinned;
      _reRender();
    }
  };
}

/* === Exports globais úteis === */
try {
  window.renderListaClientes?.(window.state?.clientesCache || []);
  window.carregarClientes = carregarClientes;
} catch {}

/* ====== LISTA: booster de preview + ACK + CSS ====== */
(function () {
  'use strict';

  function updatePreviewInline(clienteId, { texto, ack, ts, unreadDelta } = {}) {
    const li = document.querySelector(`li.chat-item[data-id="${clienteId}"]`);
    if (!li) return;

    if (typeof texto === 'string') {
      const preview = li.querySelector('.preview-text');
      if (preview) preview.textContent = texto;
    }

    try {
      if (typeof window.getAckIcon === 'function' && (ack ?? null) !== null) {
        let wrap = li.querySelector('.preview-ack');
        if (!wrap) {
          const last = li.querySelector('.chat-last') || li.querySelector('.last-line') || li;
          wrap = document.createElement('span');
          wrap.className = 'preview-ack';
          last.prepend(wrap);
          last.insertBefore(document.createTextNode(' '), wrap.nextSibling);
        }
        wrap.setAttribute('data-ack', String(ack));
        wrap.innerHTML = window.getAckIcon(ack);
      }
    } catch {}

    if (ts) {
      const el = li.querySelector('.chat-time, time');
      if (el) el.textContent = ts;
    }

    if (unreadDelta) {
      const badgeEl = li.querySelector('.badge, .unread');
      if (badgeEl) {
        const cur = Number(badgeEl.textContent || '0') || 0;
        const val = Math.max(0, cur + Number(unreadDelta || 0));
        badgeEl.textContent = String(val);
        badgeEl.hidden = val <= 0;
      }
    }
  }

  function setAckInline(clienteId, ack) {
    updatePreviewInline(clienteId, { ack });
  }

  const L = (window.Lista = window.Lista || {});
  const prevUpdate = typeof L.updatePreview === 'function' ? L.updatePreview.bind(L) : null;
  const prevSetAck = typeof L.setAck === 'function' ? L.setAck.bind(L) : null;

  L.updatePreview = function (cid, payload) {
    try { updatePreviewInline(cid, payload || {}); } catch {}
    return prevUpdate ? prevUpdate(cid, payload) : undefined;
  };
  L.setAck = function (cid, ack) {
    try { setAckInline(cid, ack); } catch {}
    return prevSetAck ? prevSetAck(cid, ack) : undefined;
  };

  (function ensureListaAckCss() {
    const id = 'lista-ack-css';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `
      .chat-last .preview-ack { margin-right: .25rem; display: inline-flex; }
      .preview-ack .msg-ack svg { width: 12px; height: 12px; }
      .preview-ack .msg-ack { vertical-align: -0.1em; }
    `;
    document.head.appendChild(s);
  })();

  (function ensureListaLoadMoreCss() {
    const id = 'lista-load-more-css';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `
      #lista-clientes .load-more-item {
        padding: 6px 0;
        display: flex;
        justify-content: center;
      }
      #lista-clientes .load-more-item .load-more-btn {
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--border, #2a2f32);
        background: transparent;
        color: var(--muted, #aebac1);
        font-size: .8rem;
        cursor: pointer;
      }
      #lista-clientes .load-more-item .load-more-btn:hover:not(:disabled) {
        background: rgba(255,255,255,0.06);
      }
      #lista-clientes .load-more-item .load-more-btn:disabled {
        opacity: .6;
        cursor: default;
      }
    `;
    document.head.appendChild(s);
  })();
})();
