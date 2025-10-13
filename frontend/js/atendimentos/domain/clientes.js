// /frontend/js/atendimentos/domain/clientes.js
import { EMPRESA_ID } from '../core/env.js';
import { fetchWithCache } from '../core/cache.js';
import { _matchInstancia, _instQuery } from './instances.js';
import { state, persist } from '../state/store.js';
import { tsToMillis, formatChatTime } from '../core/time.js';
import { escapeHtml, formatarNumeroBR, badge } from '../core/format.js';

// >>> HISTÓRICO LOCAL (nova base de cache)
import {
  hasHistory,
  primeWith,
  getHist,
} from '../domain/hist-cache.js';

/* =========================================================
   Helpers
   ========================================================= */
function normalizaTelefoneBR(s){
  const raw = String(s ?? '');
  if (raw.includes('@')) return '';
  const d = raw.replace(/\D/g, '');
  if (!d) return '';
  const sem55 = (d.startsWith('55') && d.length > 11) ? d.slice(2) : d;
  return (sem55.length === 10 || sem55.length === 11) ? sem55 : '';
}

function normalizeName(s){
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

function temValor(v){ return v !== undefined && v !== null; }

function scoreRecencia(c){
  const ts  = tsToMillis(c.hora || c.last_ts) || 0;
  const mid = Number(c.ultima_msg_id || 0);
  const ack = Number(c.last_ack || 0);
  const ava = c.avatar_url ? 1 : 0;
  return ts * 1_000_000 + mid * 1_000 + ack * 10 + ava;
}

function ordenarConversasDesc(arr){
  const A = Array.isArray(arr) ? arr.slice() : [];
  return A.sort((a,b)=>{
    const sb = scoreRecencia(b);
    const sa = scoreRecencia(a);
    if (sb !== sa) return sb - sa;
    const ib = Number(b.id ?? b.conversation_id ?? b.cliente_id ?? 0);
    const ia = Number(a.id ?? a.conversation_id ?? a.cliente_id ?? 0);
    return ib - ia;
  });
}

/**
 * Dedupe em 3 fases:
 * 1) chave canônica (instância, preferredId = conversation_id || cliente_id || id)
 * 2) telefone válido (instância + tel_norm)
 * 3) nome (instância + nomeNorm) **apenas** se um lado não tem telefone — preserva SEMPRE o que tem telefone
 */
function dedupeConversas(arr){
  if (!Array.isArray(arr)) return [];

  const base = ordenarConversasDesc(arr);

  const byKey = new Map();
  for (const c of base){
    const inst = String(c.instancia_id ?? c.instancia ?? 'all');
    const pref = temValor(c.conversation_id) ? c.conversation_id
               : temValor(c.cliente_id)      ? c.cliente_id
               : temValor(c.id)              ? c.id
               : `noid:${Math.random()}`;
    const key = `${inst}:${pref}`;
    const cur = byKey.get(key);
    if (!cur || scoreRecencia(c) > scoreRecencia(cur)) byKey.set(key, c);
  }

  const byFone = new Map();
  const semFone = [];
  for (const c of byKey.values()){
    const inst = String(c.instancia_id ?? c.instancia ?? 'all');
    const telNorm = normalizaTelefoneBR(c.telefone);
    if (!telNorm) { semFone.push(c); continue; }
    const fkey = `${inst}:${telNorm}`;
    const cur = byFone.get(fkey);
    if (!cur || scoreRecencia(c) > scoreRecencia(cur)) byFone.set(fkey, c);
  }

  const byInstNomeComFone = new Map();
  for (const [key, val] of byFone.entries()){
    const instKey = String(key).split(':')[0];
    const inst = instKey || String(val.instancia_id ?? val.instancia ?? 'all');
    const nomeNorm = normalizeName(val.nome_whatsapp || val.nome || val.push_name);
    if (!nomeNorm) continue;
    const nmMap = byInstNomeComFone.get(inst) || new Map();
    const cur = nmMap.get(nomeNorm);
    if (!cur || scoreRecencia(val) > scoreRecencia(cur)) nmMap.set(nomeNorm, val);
    byInstNomeComFone.set(inst, nmMap);
  }

  const byInstNomeOnly = new Map();
  for (const c of semFone){
    const inst = String(c.instancia_id ?? c.instancia ?? 'all');
    const nomeNorm = normalizeName(c.nome_whatsapp || c.nome || c.push_name);

    if (!nomeNorm){
      const key = `${inst}:__no_phone__:${c.id ?? c.conversation_id ?? Math.random()}`;
      const cur = byFone.get(key);
      if (!cur || scoreRecencia(c) > scoreRecencia(cur)) byFone.set(key, c);
      continue;
    }

    const nmMap = byInstNomeComFone.get(inst);
    const comFone = nmMap?.get(nomeNorm);

    if (comFone){
      const cScore = scoreRecencia(c);
      const fScore = scoreRecencia(comFone);

      if (cScore > fScore){
        if (temValor(c.hora) && (!temValor(comFone.hora) || tsToMillis(c.hora) > tsToMillis(comFone.hora))) {
          comFone.hora = c.hora;
        }
        if (temValor(c.ultima_mensagem) && String(c.ultima_mensagem).trim()) {
          comFone.ultima_mensagem = c.ultima_mensagem;
        }
        if (temValor(c.last_ack)) {
          comFone.last_ack = Math.max(Number(comFone.last_ack||0), Number(c.last_ack||0));
        }
      }
    } else {
      const onlyMap = byInstNomeOnly.get(inst) || new Map();
      const cur = onlyMap.get(nomeNorm);
      if (!cur || scoreRecencia(c) > scoreRecencia(cur)) onlyMap.set(nomeNorm, c);
      byInstNomeOnly.set(inst, onlyMap);
    }
  }

  for (const [inst, onlyMap] of byInstNomeOnly.entries()){
    for (const [nomeNorm, item] of onlyMap.entries()){
      const key = `${inst}:__name_only__:${nomeNorm}`;
      const cur = byFone.get(key);
      if (!cur || scoreRecencia(item) > scoreRecencia(cur)) byFone.set(key, item);
    }
  }

  return ordenarConversasDesc([...byFone.values()]);
}

/* =========================================================
   Normalização (suporta /conversas e legado /clientes)
   ========================================================= */
export function normalizeCliente(c){
  const inst =
    c.instancia_id ?? c.instancia ?? c.instancia_slug ??
    c.instance_id  ?? c.instance  ?? c.session ?? c.sessionName ?? c.sessao ?? c.inst_slug ?? null;

  const id = Number(c.conversation_id ?? c.cliente_id ?? c.id ?? c.cid ?? 0) || null;

  const rawHora =
    c.ultima_ts ?? c.hora ?? c.last_ts ?? c.updated_at ?? c.last_message_at ?? c.timestamp ?? null;

  const preview =
    c.ultima_texto ?? c.ultima_mensagem ?? c.ultima ?? c.last_text ?? '';

  return {
    id,
    conversation_id: temValor(c.conversation_id) ? c.conversation_id : id,
    cliente_id:      temValor(c.cliente_id) ? c.cliente_id : id,

    nome_whatsapp: c.nome_whatsapp ?? null,
    nome: c.nome ?? null,
    push_name: c.push_name ?? null,

    telefone: c.telefone ?? c.number ?? c.wuid ?? c.numero ?? null,
    telefone_norm: normalizaTelefoneBR(c.telefone ?? c.number ?? c.wuid ?? c.numero ?? null),

    avatar_url: c.avatar_url ?? c.foto ?? null,

    ultima_msg_id: c.ultima_msg_id ?? c.last_msg_id ?? null,
    ultima_mensagem: preview,
    hora: rawHora,
    last_ts: c.last_ts ?? null,

    novas: Number(c.novas ?? 0),
    last_tipo: c.ultima_tipo ?? c.last_tipo ?? c.tipo ?? null,
    last_ack:  c.ultima_ack  ?? c.last_ack  ?? c.ack  ?? null,

    instancia_id: inst,
    instancia: inst
  };
}

/* =========================================================
   PRIME: baixar últimas 50 msgs por conversa (1ª vez)
   ========================================================= */
function buildMsgsUrl(convId, instanciaId) {
  const qs = new URLSearchParams({
    empresa_id: String(EMPRESA_ID),
    limit: '50'
  });
  if (instanciaId != null && instanciaId !== '' && instanciaId !== 'all') {
    qs.set('instancia_id', String(instanciaId));
  }
  return `/api/atendimento/conversas/${convId}/mensagens?` + qs.toString();
}

async function fetchConv50(convId, instanciaId){
  const url = buildMsgsUrl(convId, instanciaId);
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('Falha ao carregar mensagens da conversa ' + convId);
  const data = await r.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  // opcional: se backend devolver cursores, poderia usar aqui:
  const cursors = {
    oldest: data?.prev_cursor ?? null,
    newest: data?.next_cursor ?? null
  };
  return { items, cursors };
}

// controla concorrência de fetch de 50 msgs
async function primeHistories(convs, { concurrency = 6 } = {}){
  const queue = [...convs];
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length){
      const c = queue.shift();
      const inst = c.instancia_id ?? c.instancia ?? null;
      try{
        if (hasHistory(inst, c.id)) {
          // já tem histórico local → só garantir preview a partir do cache
          try { window.syncPreviewFromCache?.(c.id); } catch {}
          continue;
        }
        const { items, cursors } = await fetchConv50(c.id, inst);
        primeWith(inst, c.id, items, cursors);
        // atualiza preview/time a partir do cache (evita “piscar”)
        try { window.syncPreviewFromCache?.(c.id); } catch {}
      }catch(e){
        // se der erro, não trava o restante
        try { console.debug('[primeHistories] erro conv', c.id, e); } catch {}
      }
    }
  });
  await Promise.all(runners);
}

/* =========================================================
   Carregar primeira página (20 conversas) — usa /conversas
   ========================================================= */
export async function carregarClientes({ force=false } = {}){
  // chave de cache leva o filtro de instância atual
  const instKey = (_instQuery() || '').replace(/^[?&]+/, '') || 'all';
  const key = `conversas:v1:${EMPRESA_ID}:${instKey}`;
  const url = `/api/atendimento/conversas?empresa_id=${EMPRESA_ID}&limit=20${_instQuery()}`;

  const raw = await fetchWithCache(url, { ttlMs: 30_000, key, bust: force });
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const next  = raw?.next_cursor ?? null;

  let cs = items.map(normalizeCliente).filter(_matchInstancia);

  // preserva campos do cache anterior (ack/preview/hora) e canônica de hora
  const antigo = Array.isArray(state.clientesCache)?state.clientesCache:[];
  cs.forEach(n=>{
    const a = antigo.find(x=> (x.id??x.conversation_id) === n.id);

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
        n.last_ack = Math.max(Number(n.last_ack||0), Number(a.last_ack)||0);
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
      else n.last_ack = Math.max(Number(n.last_ack)||0, Number(a.last_ack)||0);
    }
  });

  // DEDUPE FORTE
  cs = dedupeConversas(cs);

  state.clientesCache = cs;
  state.nextCursor    = next;
  persist();

  // Render inicial (ainda sem piscar, pq já vamos sincronizar do histórico)
  renderListaClientes(cs);
  try { window.Lista?.render(cs); } catch {}

  // Sempre tentar sincronizar preview pelo histórico local, se já existir
  try { (state.clientesCache || []).forEach(c => window.syncPreviewFromCache?.(c.id)); } catch {}

  // PRIME: baixar 50 mensagens para cada conversa que ainda não tem histórico local
  try { await primeHistories(state.clientesCache, { concurrency: 6 }); } catch {}

  return cs;
}

/* =========================================================
   Carregar mais conversas (infinite scroll)
   ========================================================= */
let _isWired = false;
let _isLoadingMore = false;

export function wireListaInfiniteScroll(){
  if (_isWired) return;
  _isWired = true;

  const ul = document.getElementById('lista-clientes');
  if (!ul) return;

  ul.addEventListener('scroll', async () => {
    const nearBottom = ul.scrollTop + ul.clientHeight >= (ul.scrollHeight - 80);
    if (!nearBottom) return;
    if (_isLoadingMore) return;
    if (!state.nextCursor) return;

    try{
      _isLoadingMore = true;
      await loadMoreConversas();
    } finally {
      _isLoadingMore = false;
    }
  }, { passive: true });
}

export async function loadMoreConversas(){
  const cursor = state.nextCursor;
  if (!cursor) return;

  const url = `/api/atendimento/conversas?empresa_id=${EMPRESA_ID}&limit=20&cursor_last_msg_id=${encodeURIComponent(cursor)}${_instQuery()}`;
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) return;
  const data = await r.json();

  const items = Array.isArray(data?.items) ? data.items : [];
  const next  = data?.next_cursor ?? null;

  const mais = items.map(normalizeCliente).filter(_matchInstancia);

  const map = new Map(state.clientesCache.map(c => [String((c.conversation_id ?? c.id)), c]));
  for (const it of mais){
    const key = String(it.conversation_id ?? it.id);
    map.set(key, { ...(map.get(key)||{}), ...it });
  }

  const arr = dedupeConversas([...map.values()]);

  state.clientesCache = arr;
  state.nextCursor = next;
  persist();

  renderListaClientes(arr);
  try { window.Lista?.render(arr); } catch {}

  // sincroniza previews pelo histórico, se já houver
  try { (state.clientesCache || []).forEach(c => window.syncPreviewFromCache?.(c.id)); } catch {}

  // PRIME dos recém-carregados (vamos pegar só os últimos 10 pra segurar carga)
  try {
    const novosIds = mais.map(m => m.id);
    const novos = (state.clientesCache || []).filter(c => novosIds.includes(c.id));
    await primeHistories(novos.slice(0, 10), { concurrency: 4 });
  } catch {}
}

/* =========================================================
   Render da lista (usa histórico local quando disponível)
   ========================================================= */
export function renderListaClientes(data){
  const arr = dedupeConversas(
    (Array.isArray(data)?data:[]).map(normalizeCliente).filter(_matchInstancia)
  );
  const ul = document.getElementById('lista-clientes');
  if (!ul) return;

  const ordenado = ordenarConversasDesc(arr);

  const html = ordenado.map(c=>{
    const nome = (c.nome_whatsapp && c.nome_whatsapp.trim())
      ? c.nome_whatsapp.trim()
      : (c.nome && c.nome.trim() && c.nome !== 'Cliente')
        ? c.nome.trim()
        : (c.push_name?.trim() || formatarNumeroBR(c.telefone));

    // Fonte da verdade: histórico local (se existir)
    let when = formatChatTime(c.hora || c.last_ts) || '';
    let preview = (c.ultima_mensagem || '').trim();
    let outboundFlag = (c.last_tipo === 'saida');
    let ackValForIcon = Number(c.last_ack ?? 0);

    try {
      const instCanon = (c.instancia_id ?? c.instancia ?? null) || null;
      const arrHist = window.cacheHistoricos?.[c.id] || getHist(instCanon, c.id);
      if (Array.isArray(arrHist) && arrHist.length) {
        // arrHist já vem asc; última é a mais recente
        const last = arrHist[arrHist.length - 1];
        outboundFlag = (last?.tipo === 'saida') || !!last?.from_me || (last?.origem === 'atendente');
        ackValForIcon = outboundFlag ? Number(last?.ack||0) : 0;

        const ms = Number(last?.ts || 0) || Date.parse(last?.timestamp || '') || Date.now();
        when = formatChatTime(ms);

        const raw = (last?.texto || last?.text || last?.conteudo || last?.mensagem || '').trim();
        if (raw) {
          preview = raw;
        } else {
          const a = Array.isArray(last?.midias) ? last.midias : [];
          const mime = String(a[0]?.mimetype || a[0]?.mime || '').toLowerCase();
          const hasAny = a.length > 0;
          preview = hasAny
            ? (mime.includes('image') ? '[Foto]'
               : mime.includes('video') ? '[Vídeo]'
               : mime.includes('audio') ? '[Áudio]'
               : mime.includes('pdf')   ? '[PDF]'
               : '[Arquivo]')
            : '';
        }
      }
    } catch {}

    const outbound = outboundFlag;
    const dirStr   = outbound ? 'out' : 'in';
    const ackVal   = ackValForIcon;

    const ackHtml = outbound && typeof window.getAckIcon === 'function'
      ? `<span class="preview-ack" data-ack="${ackVal}">${window.getAckIcon(ackVal)}</span> `
      : '';

    const av = c.avatar_url
      ? `<span class="avatar"><img src="${c.avatar_url}" alt="" onerror="this.onerror=null;this.parentElement.classList.add('placeholder');this.remove();" /></span>`
      : `<span class="avatar placeholder"><i class="fa fa-user-circle"></i></span>`;

    return `
      <li class="chat-item cliente-item"
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

  ul.innerHTML = html;
  document.dispatchEvent(new CustomEvent('lista:rendered'));
  ul.querySelectorAll('.chat-item').forEach(el=>{
    el.addEventListener('click',()=> window.selecionarClienteObj?.(Number(el.dataset.id)));
  });
}

/* =========================================================
   SHIM opcional de UI de lista
   ========================================================= */
function _findClienteIndex(id){
  const arr = Array.isArray(state.clientesCache) ? state.clientesCache : [];
  return arr.findIndex(c => (c.id ?? c.conversation_id) === Number(id));
}
function _reRender(){
  const arr = dedupeConversas(state.clientesCache || []);
  renderListaClientes(arr);
  persist();
}
function _touchHora(c, tsISO){
  c.hora = tsISO || new Date().toISOString();
}

if (!window.Lista) {
  window.Lista = {
    render(data){
      renderListaClientes(Array.isArray(data) ? data : (state.clientesCache || []));
    },
    updatePreview(clienteId, { texto, ts, ack, unreadDelta } = {}){
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;
      const c = state.clientesCache[idx];
      if (typeof texto === 'string') c.ultima_mensagem = texto;
      if (temValor(ack)) {
        c.last_ack = Number(ack);
        c.last_tipo = 'saida';
      }
      if (unreadDelta) c.novas = Math.max(0, Number(c.novas||0) + Number(unreadDelta||0));
      _touchHora(c, ts);
      _reRender();
    },
    setAck(clienteId, ack){
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;
      const c = state.clientesCache[idx];
      if (c.last_tipo !== 'saida') return;
      const novo = Math.max(Number(c.last_ack||0), Number(ack||0));
      c.last_ack = novo;
      _reRender();
    },
    bumpToTop(clienteId){
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;
      const c = state.clientesCache[idx];
      _touchHora(c);
      _reRender();
    },
    resetUnread(clienteId){
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;
      state.clientesCache[idx].novas = 0;
      _reRender();
    }
  };
}

/* === Exports globais úteis (alguns módulos chamam via window) === */
try {
  window.renderListaClientes = renderListaClientes;
  window.carregarClientes = carregarClientes;
} catch {}
