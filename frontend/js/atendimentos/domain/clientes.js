// /frontend/js/atendimentos/domain/clientes.js
// =====================================================================
// LISTA DE CONVERSAS (render, dedupe, preview, paginação)
// ✅ Falhou imagem => placeholder (SEM refresh)
// ✅ Daily refresh 1x/dia: só sem foto, top 50, conc 2, localStorage
// ✅ FIX GRUPOS: detecta JID @g.us, preserva jid/remoteJid, is_group, normaliza tel
// ✅ Dedupe seguro: conversa de grupo NÃO entra no dedupe por telefone
// ✅ Dedupe seguro: grupo também NÃO entra no merge por NOME
// ✅ Click/merge: mantém instância + dados canônicos (jid/tel_norm)
// ✅ FIX BIGINT/GRUPOS: IDs string-first (NUNCA Number() no id)
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
   ID helpers (string-first)
   ========================================================= */
function idKey(v) {
  const s = String(v ?? '').trim();
  if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
  return s;
}
function idEq(a, b) {
  const A = idKey(a), B = idKey(b);
  if (!A || !B) return false;
  return A === B;
}
function idToBig(v) {
  const s = idKey(v);
  if (!s) return 0n;
  if (/^\d+$/.test(s)) {
    try { return BigInt(s); } catch { return 0n; }
  }
  return 0n;
}

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
function _ensureAvatarPlaceholder(span) {
  try {
    if (!span) return;
    span.classList.add('placeholder');
    span.innerHTML = '<i class="fa fa-user-circle"></i>';
  } catch {}
}

if (typeof window !== 'undefined') {
  window.handleListAvatarError = function (imgEl, clienteId) {
    try {
      if (!imgEl) return;
      try { imgEl.onerror = null; } catch {}
      const span = imgEl.closest?.('.avatar') || imgEl.parentElement;
      try { imgEl.remove(); } catch {}
      _ensureAvatarPlaceholder(span);
    } catch {}
  };

  window.handleAvatarError = function (imgEl) {
    try {
      if (!imgEl) return;
      try { imgEl.onerror = null; } catch {}
      const span = imgEl.closest?.('.avatar') || imgEl.parentElement;
      try { imgEl.remove(); } catch {}
      if (span) {
        span.classList.add('avatar-default');
        span.innerHTML = '<i class="fa fa-user-circle"></i>';
      }
    } catch {}
  };
}

/* =========================================================
   Daily refresh (1x/dia) - só quem tá sem foto, top 50, conc 2
   ========================================================= */
let __dailyKickScheduled = false;
let __dailyRunning = false;

function _ymdLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}
function _dailyKey() {
  return `av_daily:v1:e${Number(EMPRESA_ID || 0)}:d${_ymdLocal()}`;
}
function _shouldRunDaily() {
  try {
    if (window.AVATAR_DAILY_REFRESH === false) return false;
    const k = _dailyKey();
    return !localStorage.getItem(k);
  } catch {
    return true;
  }
}
function _markDaily() {
  try { localStorage.setItem(_dailyKey(), String(Date.now())); } catch {}
}

async function runDailyAvatarRefresh() {
  try {
    if (__dailyRunning) return;
    if (!_shouldRunDaily()) return;
    if (typeof window.refreshAvatarFromEvolution !== 'function') return;

    __dailyRunning = true;

    const limit = Math.max(1, Math.min(200, Number(window.AVATAR_DAILY_LIMIT || 50)));
    const conc  = Math.max(1, Math.min(6, Number(window.AVATAR_DAILY_CONCURRENCY || 2)));

    const base = Array.isArray(state.clientesCache) ? state.clientesCache.slice() : [];
    if (!base.length) { _markDaily(); return; }

    const topRecent = ordenarConversasDesc(base).slice(0, limit);
    const targets = topRecent.filter(c => !c?.avatar_url);

    _markDaily();
    if (!targets.length) return;

    const queue = targets.slice();

    const workers = Array.from(
      { length: Math.min(conc, queue.length) },
      async () => {
        while (queue.length) {
          const c = queue.shift();
          const cid = idKey(c?.id ?? c?.conversation_id ?? c?.cliente_id ?? null);
          if (!cid) continue;

          // refreshAvatarFromEvolution normalmente espera id numérico do DB.
          if (!/^\d+$/.test(cid)) continue;
          const cidNum = Number(cid);
          if (!Number.isFinite(cidNum) || cidNum <= 0) continue;

          const number = (c?.telefone_norm || c?.telefone || c?.number || '');
          const instRaw = (c?.instancia_id ?? c?.instancia ?? null);

          const opt = { trigger: 'daily', number, instancia_raw: instRaw };
          try { await window.refreshAvatarFromEvolution(cidNum, opt); } catch {}
        }
      }
    );

    await Promise.all(workers);
  } finally {
    __dailyRunning = false;
  }
}

function kickDailyAvatarRefreshSoon() {
  if (__dailyKickScheduled) return;
  __dailyKickScheduled = true;
  setTimeout(() => { try { runDailyAvatarRefresh(); } catch {} }, 350);
}

if (typeof window !== 'undefined') {
  window.runDailyAvatarRefresh = window.runDailyAvatarRefresh || runDailyAvatarRefresh;
}

/* =========================================================
   Helpers
   ========================================================= */
function onlyDigits(s) { return String(s ?? '').replace(/\D+/g, ''); }
function isGroupJid(s) {
  const v = String(s || '');
  return /@g\.us$/i.test(v);
}

// ✅ Heurística: alguns bridges retornam grupo como número "1203...." (sem @g.us)
// Se começar com 120 e for bem longo, tratamos como grupo.
function looksLikeNumericGroupId(digits) {
  const d = String(digits || '');
  return d.startsWith('120') && d.length >= 15;
}

// Para grupos: mantém o JID (não tenta virar telefone)
function normalizeJidOrPhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { is_group: false, jid: '', tel_norm: '' };

  // Já veio como JID
  if (s.includes('@')) {
    const jid = s;
    return { is_group: isGroupJid(jid), jid, tel_norm: '' };
  }

  const d = onlyDigits(s);

  // ✅ grupo numérico sem sufixo
  if (looksLikeNumericGroupId(d)) {
    return { is_group: true, jid: `${d}@g.us`, tel_norm: '' };
  }

  // Tel (BR) normalizado
  const sem55 = (d.startsWith('55') && d.length > 11) ? d.slice(2) : d;
  const tel_norm = (sem55.length === 10 || sem55.length === 11) ? sem55 : '';
  return { is_group: false, jid: '', tel_norm };
}

function normalizaTelefoneBR(s) {
  const raw = String(s ?? '');
  if (raw.includes('@')) return '';
  const d = raw.replace(/\D/g, '');
  if (looksLikeNumericGroupId(d)) return ''; // ✅ não trata como telefone
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

    // tie-breaker estável com BigInt (quando for numérico)
    const ib = idToBig(b?.id ?? b?.conversation_id ?? b?.cliente_id ?? 0);
    const ia = idToBig(a?.id ?? a?.conversation_id ?? a?.cliente_id ?? 0);
    if (ib > ia) return 1;
    if (ib < ia) return -1;
    return 0;
  });
}

/* =========================================================
   Dedupe em 3 fases (preserva .pinned)
   ✅ FIX: grupos NÃO entram na fase por telefone
   ✅ FIX: grupos também NÃO entram no merge por nome
   ✅ FIX: ids string-first
   ========================================================= */
function dedupeConversas(arr) {
  if (!Array.isArray(arr)) return [];

  const base = ordenarConversasDesc(arr);

  // 1) por inst + id (sempre)
  const byKey = new Map();
  for (const c of base) {
    const inst = String(c.instancia_id ?? c.instancia ?? 'all');

    const pref =
      idKey(c.conversation_id) ??
      idKey(c.cliente_id) ??
      idKey(c.id) ??
      `noid:${Math.random()}`;

    const key = `${inst}:${pref}`;
    const cur = byKey.get(key);

    if (!cur || scoreRecencia(c) > scoreRecencia(cur)) {
      byKey.set(key, { ...c, pinned: Boolean(c.pinned || cur?.pinned) });
    } else if (cur) {
      cur.pinned = Boolean(cur.pinned || c.pinned);
    }
  }

  // 2) por inst + telefone (SÓ NÃO-GRUPO)
  // ✅ e já grava grupos como itens únicos (inst + jid)
  const byFone = new Map();
  const semFone = [];

  for (const c of byKey.values()) {
    const inst = String(c.instancia_id ?? c.instancia ?? 'all');

    const isGrp = Boolean(c.is_group) || isGroupJid(c.jid || c.remoteJid || c.telefone || '');

    if (isGrp) {
      // ✅ grupo sempre vira chave própria (NUNCA vai pra merge por nome)
      const gid =
        idKey(c.jid) ||
        idKey(c.remoteJid) ||
        (String(c.telefone || '').includes('@') ? idKey(c.telefone) : null) ||
        idKey(c.id ?? c.conversation_id ?? c.cliente_id) ||
        `g:${Math.random()}`;

      const gkey = `${inst}:__group__:${gid}`;
      const cur = byFone.get(gkey);
      if (!cur || scoreRecencia(c) > scoreRecencia(cur)) {
        byFone.set(gkey, { ...c, pinned: Boolean(c.pinned || cur?.pinned) });
      } else if (cur) {
        cur.pinned = Boolean(cur.pinned || c.pinned);
      }
      continue;
    }

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

  // 3) merge por nome dentro da inst (SÓ para itens sem telefone e NÃO-GRUPO)
  const byInstNomeComFone = new Map();
  for (const [key, val] of byFone.entries()) {
    // ignora grupos nos índices por nome
    if (String(key).includes(':__group__:')) continue;

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

    // ✅ garante: se virou grupo por algum motivo, não mergeia por nome
    const isGrp = Boolean(c.is_group) || isGroupJid(c.jid || c.remoteJid || c.telefone || '');
    if (isGrp) {
      const gid =
        idKey(c.jid) ||
        idKey(c.remoteJid) ||
        (String(c.telefone || '').includes('@') ? idKey(c.telefone) : null) ||
        idKey(c.id ?? c.conversation_id ?? c.cliente_id) ||
        `g:${Math.random()}`;

      const gkey = `${inst}:__group__:${gid}`;
      const cur = byFone.get(gkey);
      if (!cur || scoreRecencia(c) > scoreRecencia(cur)) {
        byFone.set(gkey, { ...c, pinned: Boolean(c.pinned || cur?.pinned) });
      } else if (cur) {
        cur.pinned = Boolean(cur.pinned || c.pinned);
      }
      continue;
    }

    const nomeNorm = normalizeName(c.nome_whatsapp || c.nome || c.push_name);

    if (!nomeNorm) {
      const uniq = idKey(c.id ?? c.conversation_id) ?? String(Math.random());
      const key = `${inst}:__no_name__:${uniq}`;
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
   ✅ FIX GRUPOS: detecta JID @g.us e marca is_group + jid
   ✅ FIX BIGINT: id string-first
   ========================================================= */
export function normalizeCliente(c) {
  const inst =
    c.instancia_id ?? c.instancia ?? c.instancia_slug ??
    c.instance_id ?? c.instance ?? c.session ?? c.sessionName ?? c.sessao ?? c.inst_slug ?? null;

  const id = idKey(c.conversation_id ?? c.cliente_id ?? c.id ?? c.cid ?? null);

  const rawHora =
    c.ultima_ts ?? c.hora ?? c.last_ts ?? c.updated_at ?? c.last_message_at ?? c.timestamp ?? null;

  const preview =
    c.ultima_texto ?? c.ultima_mensagem ?? c.ultima ?? c.last_text ?? '';

  const fotoRaw =
    c.avatar_url || c.foto_url || c.foto || c.avatar || c.profile_pic_url || '';
  const fotoStr = String(fotoRaw || '').trim();
  const fotoOk = fotoStr && !/^(null|undefined|about:blank)$/i.test(fotoStr);
  const foto = fotoOk ? fotoStr : '';

  const remote =
    c.remoteJid ?? c.remote_jid ?? c.jid ?? c.chat_jid ?? c.key_remoteJid ??
    c.telefone ?? c.number ?? c.wuid ?? c.numero ?? null;

  const parsed = normalizeJidOrPhone(remote);

  const hintedGroup =
    Boolean(c.is_group) || Boolean(c.grupo) || Boolean(c.isGroup);

  let jid = parsed.jid || (isGroupJid(remote) ? String(remote) : '');

  // ✅ se o backend disse que é grupo, mas veio sem @g.us, força
  if (!jid && hintedGroup) {
    const d = onlyDigits(remote);
    if (d && looksLikeNumericGroupId(d)) jid = `${d}@g.us`;
  }

  const is_group =
    hintedGroup ||
    Boolean(parsed.is_group) ||
    isGroupJid(remote) ||
    isGroupJid(jid);

  const telRaw = c.telefone ?? c.number ?? c.wuid ?? c.numero ?? null;
  const tel_norm = is_group ? '' : (parsed.tel_norm || normalizaTelefoneBR(telRaw));

  const telForUi = is_group
    ? (jid || String(remote || ''))
    : (telRaw);

  return {
    id,
    conversation_id: idKey(c.conversation_id) ?? id,
    cliente_id: idKey(c.cliente_id) ?? id,

    nome_whatsapp: c.nome_whatsapp ?? null,
    nome: c.nome ?? null,
    push_name: c.push_name ?? null,

    telefone: telForUi,
    telefone_norm: tel_norm,

    jid: jid || null,
    remoteJid: jid || null,
    is_group,

    avatar_url: foto ? foto : null,

    ultima_msg_id: c.ultima_msg_id ?? c.last_msg_id ?? null,
    ultima_mensagem: preview,
    hora: rawHora,
    last_ts: c.last_ts ?? null,

    novas: Number(c.novas ?? c.unread ?? 0),
    last_tipo: c.ultima_tipo ?? c.last_tipo ?? c.tipo ?? null,
    last_ack: c.ultima_ack ?? c.last_ack ?? c.ack ?? null,

    instancia_id: inst,
    instancia: inst,

    pinned: Boolean(c.pinned || c.fixado || c.pin || false),

    instance_name: c.instance_name ?? c.instancia_nome ?? c.inst_name ?? null,
    status: c.status ?? c.statusatendimento ?? null,
    statusatendimento: c.statusatendimento ?? c.status ?? null,
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

  return `/api/atendimento/conversas/${encodeURIComponent(String(convId))}/mensagens?` + qs.toString();
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
  const unread = lista.filter(c => Number(c.novas || 0) > 0).slice(0, PREFETCH_LIMIT);
  if (!unread.length) return;

  const queue = unread.slice();

  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, queue.length)) },
    async () => {
      while (queue.length) {
        const c = queue.shift();
        const convId = idKey(c.id ?? c.conversation_id ?? c.cliente_id ?? null);
        if (!convId) continue;

        const inst = c.instancia_id ?? c.instancia ?? null;

        try {
          const { items, cursors } = await fetchConv30(convId, inst);
          primeWith(inst, convId, items, cursors);
          try { window.syncPreviewFromCache?.(convId); } catch {}
        } catch (e) {
          try { console.debug('[primeHistories] erro conv', convId, e); } catch {}
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
      const nid = idKey(n?.id ?? n?.conversation_id ?? n?.cliente_id ?? null);
      if (!nid) return;

      const a = antigo.find(x => idEq(x?.id ?? x?.conversation_id ?? x?.cliente_id, nid));

      const oldTs = tsToMillis(a?.hora || a?.last_ts);
      const newTs = tsToMillis(n.hora || n.last_ts);
      const tsCanon = tsToMillis(n.hora || n.last_ts || a?.hora || a?.last_ts);
      if (tsCanon) n.hora = tsCanon;

      // ✅ preserva campos canônicos (grupo/jid/tel)
      if (a) {
        if (!n.jid && a.jid) n.jid = a.jid;
        if (!n.remoteJid && a.remoteJid) n.remoteJid = a.remoteJid;
        n.is_group = Boolean(n.is_group || a.is_group || isGroupJid(n.telefone) || isGroupJid(a.telefone));
        if (n.is_group) {
          const keep = n.jid || n.remoteJid || a.jid || a.remoteJid || n.telefone || a.telefone || '';
          if (keep) n.telefone = keep;
          n.telefone_norm = '';
        } else {
          if (!n.telefone_norm && a.telefone_norm) n.telefone_norm = a.telefone_norm;
          if (!n.telefone && a.telefone) n.telefone = a.telefone;
        }
      }

      if (a && oldTs && newTs && oldTs > newTs) {
        if (a.ultima_mensagem && String(a.ultima_mensagem).trim()) n.ultima_mensagem = a.ultima_mensagem;
        if (a.last_tipo) n.last_tipo = a.last_tipo;
        if (a.last_tipo === 'saida' && temValor(a.last_ack)) {
          n.last_ack = Math.max(Number(n.last_ack || 0), Number(a.last_ack || 0));
        }
        if (temValor(a.novas) && (Number(n.novas) || 0) === 0) n.novas = Number(a.novas) || 0;
      } else {
        if (a && (!n.ultima_mensagem || !String(n.ultima_mensagem).trim()) && a?.ultima_mensagem) {
          n.ultima_mensagem = a.ultima_mensagem;
        }
        if (temValor(a?.novas) && (Number(n.novas) || 0) === 0) n.novas = Number(a.novas) || 0;
      }

      if (temValor(a?.last_ack)) {
        if (!temValor(n.last_ack)) n.last_ack = a.last_ack;
        else n.last_ack = Math.max(Number(n.last_ack || 0), Number(a.last_ack || 0));
      }

      n.pinned = Boolean(n.pinned || a?.pinned);
      if (!n.instance_name && a?.instance_name) n.instance_name = a.instance_name;
      if (!n.status && a?.status) n.status = a.status;
      if (!n.statusatendimento && a?.statusatendimento) n.statusatendimento = a.statusatendimento;
    });

    const setNovos = new Set(cs.map(x => String(idKey(x.id ?? x.conversation_id) ?? '')));
    const extrasAntigos = antigo.filter(a => !setNovos.has(String(idKey(a.id ?? a.conversation_id) ?? '')));

    let all = [...cs, ...extrasAntigos];
    all = dedupeConversas(all);

    state.clientesCache = all;
    state.nextCursor = next;
    persist();

    renderListaClientes(all);
    try { window.Lista?.render(all); } catch {}

    try { (state.clientesCache || []).forEach(c => window.syncPreviewFromCache?.(idKey(c.id) ?? c.id)); } catch {}

    if (window.PREFETCH_HISTORIES) {
      try { await primeHistories(state.clientesCache, { concurrency: 2 }); } catch {}
    }

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

  const map = new Map(state.clientesCache.map(c => [String(idKey(c.conversation_id ?? c.id) ?? ''), c]));
  for (const it of mais) {
    const key = String(idKey(it.conversation_id ?? it.id) ?? '');
    if (!key) continue;
    const prev = map.get(key) || {};

    const merged = { ...prev, ...it };
    merged.pinned = Boolean((prev && prev.pinned) || it.pinned);

    merged.is_group = Boolean(merged.is_group || prev?.is_group || it?.is_group || isGroupJid(merged.telefone));
    if (merged.is_group) {
      const keep = merged.jid || merged.remoteJid || prev?.jid || prev?.remoteJid || it?.jid || it?.remoteJid || merged.telefone || prev?.telefone || it?.telefone || '';
      if (keep) merged.telefone = keep;
      merged.telefone_norm = '';
    } else {
      if (!merged.telefone_norm) merged.telefone_norm = prev?.telefone_norm || it?.telefone_norm || normalizaTelefoneBR(merged.telefone);
    }

    map.set(key, merged);
  }

  const arr = dedupeConversas([...map.values()]);

  state.clientesCache = arr;
  state.nextCursor = next;
  persist();

  renderListaClientes(arr);
  try { window.Lista?.render(arr); } catch {}

  try { (state.clientesCache || []).forEach(c => window.syncPreviewFromCache?.(idKey(c.id) ?? c.id)); } catch {}
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
    const cid = idKey(c.id ?? c.conversation_id ?? c.cliente_id ?? null) ?? '';

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
      const arrHist = window.cacheHistoricos?.[cid] || getHist(instCanon, cid);
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
          if (histAck > ackValForIcon) ackValForIcon = histAck;
        }

        if (!when && serverMs) when = formatChatTime(serverMs);
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
      ? `<span class="avatar"><img src="${avatarUrl}" alt="" data-cliente-id="${escapeHtml(cid)}"
                onerror="window.handleListAvatarError && window.handleListAvatarError(this, '${String(cid).replace(/'/g, "\\'")}')" /></span>`
      : `<span class="avatar placeholder"><i class="fa fa-user-circle"></i></span>`;

    const pinClass = c.pinned ? ' is-pinned' : '';

    const isGrp = Boolean(c.is_group) || isGroupJid(c.telefone || '') || isGroupJid(c.jid || '') || isGroupJid(c.remoteJid || '');
    const grpAttr = isGrp ? '1' : '0';

    const jidAttr = escapeHtml(String(c.jid || c.remoteJid || (isGrp ? c.telefone : '') || ''));

    return `
      <li class="chat-item cliente-item${pinClass}${isGrp ? ' is-group' : ''}"
          id="chat-${escapeHtml(cid)}"
          data-id="${escapeHtml(cid)}"
          data-is-group="${grpAttr}"
          data-jid="${jidAttr}"
          data-telefone="${escapeHtml(String(c.telefone || ''))}"
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
        <button type="button" class="load-more-btn">Carregar mais conversas</button>
      </li>`;
  }

  ul.innerHTML = html;
  document.dispatchEvent(new CustomEvent('lista:rendered'));

  (function fixBrokenAvatars() {
    ul.querySelectorAll('.avatar img').forEach(img => {
      const src = String(img.getAttribute('src') || '').trim();
      const isBadSrc = !src || /^(null|undefined|about:blank)$/i.test(src);

      const fix = () => {
        try {
          const li = img.closest('li.chat-item, li.cliente-item');
          const cidAttr = img.dataset.clienteId || li?.dataset?.id;
          const cid = idKey(cidAttr);
          window.handleListAvatarError?.(img, cid || '');
        } catch {}
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
    el.addEventListener('click', () => window.selecionarClienteObj?.(String(el.dataset.id || '')));
  });

  if (hasMore) {
    const btn = ul.querySelector('#lista-load-more .load-more-btn');
    if (btn) {
      btn.addEventListener('click', async () => {
        if (!state.nextCursor) return;
        btn.disabled = true;
        btn.textContent = 'Carregando...';
        try { await loadMoreConversas(); } catch {}
      });
    }
  }
}

/* =========================================================
   SHIM opcional de UI
   ========================================================= */
function _findClienteIndex(id) {
  const k = idKey(id);
  const arr = Array.isArray(state.clientesCache) ? state.clientesCache : [];
  return arr.findIndex(c => idEq(c?.id ?? c?.conversation_id ?? c?.cliente_id, k));
}
function _reRender() {
  const arr = dedupeConversas(state.clientesCache || []);
  renderListaClientes(arr);
  persist();
}
function _touchHora(c, tsISO) { c.hora = tsISO || new Date().toISOString(); }

if (!window.Lista) {
  window.Lista = {
    render(data) {
      renderListaClientes(Array.isArray(data) ? data : (state.clientesCache || []));
    },
    updatePreview(clienteId, { texto, ts, ack, unreadDelta, instancia_id, instance_name, status } = {}) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;
      const c = state.clientesCache[idx];

      if (typeof texto === 'string') c.ultima_mensagem = texto;
      if (temValor(instancia_id)) c.instancia_id = instancia_id, c.instancia = instancia_id;
      if (instance_name) c.instance_name = instance_name;
      if (status) c.status = status, c.statusatendimento = status;

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

/* ====== LISTA: booster de preview + ACK (SEM CSS AQUI) ====== */
(function () {
  'use strict';

  function updatePreviewInline(clienteId, { texto, ack, ts, unreadDelta } = {}) {
    const id = String(clienteId || '');
    const li = document.querySelector(`li.chat-item[data-id="${CSS.escape(id)}"]`);
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
})();
