// /frontend/js/atendimentos/domain/clientes.js
// =====================================================================
// LISTA DE CONVERSAS (render, dedupe, preview, paginação)
// ✅ Reduz requests repetidas da lista
// ✅ Evita render duplicado quando HTML não mudou
// ✅ Evita prefetch pesado de históricos por padrão
// ✅ Evita repetir request de avatar que já deu erro
// ✅ Mantém comportamento tipo WhatsApp: mensagem nova continua aparecendo via WS/eventos
// ✅ CHATKEY: conversation_key canônica = c:<cliente_id>:<instancia_id> / g:<grupo_id>:<instancia_id>
// ✅ IDs string-first: NUNCA Number() no id da conversa
// ✅ NOME OFICIAL: nome > nome_whatsapp > push_name > telefone
// ✅ FIX bolinha verde: entende novas/unread/unread_count e cria badge se não existir
// ✅ Avatar sem foto: cor fixa por conversa baseada no conversation_key
// ✅ FILAS: mostra badge somente quando tiver fila_id + fila_nome real
// =====================================================================

import { EMPRESA_ID } from '../core/env.js';
import { fetchWithCache } from '../core/cache.js';
import { _matchInstancia, _instQuery } from './instances.js';
import {
  state,
  persist,
  getConversationKey,
  getConversationEntityId,
  getConversationKind,
} from '../state/store.js';
import { tsToMillis, formatChatTime } from '../core/time.js';
import { escapeHtml, formatarNumeroBR, badge } from '../core/format.js';
import { primeWith, getHist } from './hist-cache.js';

/* =========================================================
   Ajustes anti-loop / anti-request
   ========================================================= */
const LIST_CACHE_TTL_MS = 8_000;
const LIST_FORCE_MIN_INTERVAL_MS = 2_500;
const LIST_DEBOUNCE_MS = 700;
const LIST_LOCAL_CACHE_VERSION = 'conversas:v5-loading-leve-sem-hist-prefetch';
const LIST_LOADING_TEXT = 'Carregando suas conversas…';
const LIST_EMPTY_TEXT = 'Nenhuma conversa encontrada.';
const LIST_ERROR_TEXT = 'Não foi possível carregar suas conversas.';

let __loadingConversasPromise = null;
let __lastConversasFetchAt = 0;
let __lastConversasKey = '';
let __scheduledLoadTimer = null;
let __loadingMoreConversas = false;
let __lastConversasUsedSafeFallback = false;

if (typeof window !== 'undefined') {
  if (window.PREFETCH_HISTORIES === undefined) {
    window.PREFETCH_HISTORIES = false;
  }
}

/* =========================================================
   ID helpers
   ========================================================= */
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

function normStr(v) {
  return String(v ?? '').trim();
}

function instKey(v) {
  const s = normStr(v);
  if (!s) return null;
  if (['null', 'undefined', 'nan', '0', 'all', '*', '-'].includes(s.toLowerCase())) return null;
  return s;
}

function onlyDigits(s) {
  return String(s ?? '').replace(/\D+/g, '');
}

function statusNorm(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s || null;
}

function unreadFromAny(src) {
  const raw =
    src?.novas ??
    src?.unread_count ??
    src?.unread ??
    src?.nao_lidas ??
    src?.naoLidas ??
    src?.qtd_nao_lidas ??
    src?.qtdNaoLidas ??
    0;

  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/* =========================================================
   Nome oficial
   ========================================================= */
function cleanName(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';

  const low = s.toLowerCase();
  if (['null', 'undefined', 'nan', 'none'].includes(low)) return '';

  return s;
}

function isPlaceholderName(v) {
  const s = cleanName(v).toLowerCase();
  if (!s) return true;

  return [
    'cliente',
    'contato',
    'sem nome',
    'desconhecido',
  ].includes(s);
}

function nomeOficialCliente(c) {
  const nome = cleanName(c?.nome);
  const nomeWhats = cleanName(c?.nome_whatsapp);
  const push = cleanName(c?.push_name || c?.pushName);

  if (nome && !isPlaceholderName(nome)) return nome;
  if (nomeWhats && !isPlaceholderName(nomeWhats)) return nomeWhats;
  if (push && !isPlaceholderName(push)) return push;

  const tel = c?.telefone || c?.telefone_norm || c?.number || c?.numero || '';
  const fmt = formatarNumeroBR(tel);
  return fmt || nome || nomeWhats || push || 'Cliente';
}

function aplicarNomeOficialNoMerge(novo, antigo) {
  if (!novo || !antigo) return novo;

  const antigoNome = cleanName(antigo.nome);
  const antigoNomeWhats = cleanName(antigo.nome_whatsapp);
  const antigoPush = cleanName(antigo.push_name || antigo.pushName);

  if (antigoNome && !isPlaceholderName(antigoNome)) {
    novo.nome = antigoNome;
  } else if (!cleanName(novo.nome) && antigoNome) {
    novo.nome = antigoNome;
  }

  if (antigoNomeWhats && !isPlaceholderName(antigoNomeWhats)) {
    novo.nome_whatsapp = antigoNomeWhats;
  } else if (!cleanName(novo.nome_whatsapp) && antigoNomeWhats) {
    novo.nome_whatsapp = antigoNomeWhats;
  }

  if (!cleanName(novo.push_name) && antigoPush) {
    novo.push_name = antigoPush;
  }

  return novo;
}

/* =========================================================
   FILAS helpers
   ========================================================= */
function hasOwnAny(obj, keys) {
  if (!obj || typeof obj !== 'object') return false;

  return keys.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function filaPayloadPresent(src) {
  if (!src || typeof src !== 'object') return false;

  if (hasOwnAny(src, [
    'fila_id',
    'filaId',
    'queue_id',
    'queueId',
    'fila_nome',
    'filaNome',
    'queue_name',
    'queueName',
    'fila_prioridade',
    'filaPrioridade',
    'fila_sla_minutos',
    'filaSlaMinutos',
    'fila_cor',
    'filaCor',
    'fila_ativa',
    'filaAtiva',
    'fila_exigir_aceite',
    'filaExigirAceite',
    'fila_escolhida_em',
    'filaEscolhidaEm',
  ])) {
    return true;
  }

  return !!(src.fila && typeof src.fila === 'object') || !!(src.queue && typeof src.queue === 'object');
}

function filaIdKey(v) {
  const s = idKey(v);
  if (!s) return null;
  if (s === '0') return null;

  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
  }

  return s;
}

function filaIdFromAny(src) {
  if (!src || typeof src !== 'object') return null;

  return filaIdKey(
    src.fila_id ??
    src.filaId ??
    src.queue_id ??
    src.queueId ??
    src.fila?.id ??
    src.queue?.id ??
    null
  );
}

function filaNomeFromAny(src) {
  if (!src || typeof src !== 'object') return '';

  return cleanName(
    src.fila_nome ??
    src.filaNome ??
    src.queue_name ??
    src.queueName ??
    src.fila?.nome ??
    src.fila?.name ??
    src.queue?.nome ??
    src.queue?.name ??
    ''
  );
}

function filaPrioridadeNorm(v) {
  const s = String(v ?? '').trim().toLowerCase();

  if (s === 'baixa') return 'baixa';
  if (s === 'alta') return 'alta';
  if (s === 'urgente') return 'urgente';
  if (s === 'normal') return 'normal';

  return s || null;
}

function filaPrioridadeFromAny(src) {
  if (!src || typeof src !== 'object') return null;

  return filaPrioridadeNorm(
    src.fila_prioridade ??
    src.filaPrioridade ??
    src.queue_priority ??
    src.queuePriority ??
    src.fila?.prioridade ??
    src.fila?.priority ??
    src.queue?.prioridade ??
    src.queue?.priority ??
    null
  );
}

function filaCorNorm(v) {
  const s = String(v ?? '').trim().toLowerCase();

  if (['verde', 'azul', 'amarelo', 'vermelho', 'roxo'].includes(s)) return s;

  if (s === 'green') return 'verde';
  if (s === 'blue') return 'azul';
  if (s === 'yellow') return 'amarelo';
  if (s === 'red') return 'vermelho';
  if (s === 'purple') return 'roxo';

  return s || null;
}

function filaCorFromAny(src) {
  if (!src || typeof src !== 'object') return null;

  return filaCorNorm(
    src.fila_cor ??
    src.filaCor ??
    src.queue_color ??
    src.queueColor ??
    src.cor_fila ??
    src.fila?.cor ??
    src.fila?.color ??
    src.queue?.cor ??
    src.queue?.color ??
    null
  );
}

function filaSlaFromAny(src) {
  if (!src || typeof src !== 'object') return null;

  const raw =
    src.fila_sla_minutos ??
    src.filaSlaMinutos ??
    src.queue_sla_minutes ??
    src.queueSlaMinutes ??
    src.sla_minutos ??
    src.slaMinutos ??
    src.fila?.sla_minutos ??
    src.fila?.slaMinutos ??
    src.fila?.sla_minutes ??
    src.queue?.sla_minutos ??
    src.queue?.slaMinutos ??
    src.queue?.sla_minutes ??
    null;

  const n = Number(raw);

  if (!Number.isFinite(n) || n <= 0) return null;

  return Math.round(n);
}

function filaBoolFromAny(src, keys, fallback = false) {
  if (!src || typeof src !== 'object') return fallback;

  for (const k of keys) {
    if (src[k] !== undefined) return boolish(src[k]);
  }

  if (src.fila && typeof src.fila === 'object') {
    for (const k of keys) {
      if (src.fila[k] !== undefined) return boolish(src.fila[k]);
    }
  }

  if (src.queue && typeof src.queue === 'object') {
    for (const k of keys) {
      if (src.queue[k] !== undefined) return boolish(src.queue[k]);
    }
  }

  return fallback;
}

function filaDepartamentoIdFromAny(src) {
  if (!src || typeof src !== 'object') return null;

  const raw =
    src.fila_departamento_id ??
    src.filaDepartamentoId ??
    src.queue_department_id ??
    src.queueDepartmentId ??
    src.fila?.departamento_id ??
    src.fila?.departamentoId ??
    src.queue?.departamento_id ??
    src.queue?.departamentoId ??
    null;

  return idKey(raw);
}

function filaEscolhidaEmFromAny(src) {
  if (!src || typeof src !== 'object') return null;

  return (
    src.fila_escolhida_em ??
    src.filaEscolhidaEm ??
    src.queue_selected_at ??
    src.queueSelectedAt ??
    src.fila?.escolhida_em ??
    src.fila?.fila_escolhida_em ??
    src.queue?.selected_at ??
    null
  );
}

function temFilaReal(c) {
  return !!filaIdKey(c?.fila_id) && !!cleanName(c?.fila_nome);
}

function filaPrioridadeLabel(v) {
  const p = filaPrioridadeNorm(v);

  if (p === 'baixa') return 'Baixa';
  if (p === 'alta') return 'Alta';
  if (p === 'urgente') return 'Urgente';
  if (p === 'normal') return 'Normal';

  return p ? (p.charAt(0).toUpperCase() + p.slice(1)) : '';
}

function filaSlaLabel(minutos) {
  const n = Number(minutos);

  if (!Number.isFinite(n) || n <= 0) return '';

  if (n < 60) return `SLA ${Math.round(n)} min`;
  if (n === 60) return 'SLA 1h';

  const h = Math.round(n / 60);
  return `SLA ${h}h`;
}

function normalizeFilaState(raw, normalizedBase = {}) {
  const explicit = filaPayloadPresent(raw);
  const filaId = filaIdFromAny(raw);

  const base = {
    __has_fila_payload: explicit,

    fila_id: null,
    fila_nome: null,
    fila_prioridade: null,
    fila_sla_minutos: null,
    fila_cor: null,
    fila_ativa: false,
    fila_exigir_aceite: false,
    fila_escolhida_em: null,
    fila_departamento_id: null,

    exigir_aceite: false,
    aceite_obrigatorio: false,
    aguardando_aceite: false,
  };

  if (!filaId) return base;

  const filaNome = filaNomeFromAny(raw);
  const filaPrioridade = filaPrioridadeFromAny(raw);
  const filaSla = filaSlaFromAny(raw);
  const filaCor = filaCorFromAny(raw);

  const filaAtiva = filaBoolFromAny(
    raw,
    ['fila_ativa', 'filaAtiva', 'ativa', 'active', 'queue_active'],
    false
  );

  const filaExigirAceite = filaBoolFromAny(
    raw,
    ['fila_exigir_aceite', 'filaExigirAceite', 'exigir_aceite', 'aceite_obrigatorio', 'queue_require_accept'],
    false
  );

  const aguardandoAceite = filaBoolFromAny(
    raw,
    ['aguardando_aceite', 'waiting_accept', 'esperando_aceite'],
    false
  );

  return {
    ...base,
    ...normalizedBase,

    __has_fila_payload: explicit,

    fila_id: filaId,
    fila_nome: filaNome || null,
    fila_prioridade: filaPrioridade,
    fila_sla_minutos: filaSla,
    fila_cor: filaCor,
    fila_ativa: filaAtiva,
    fila_exigir_aceite: filaExigirAceite,
    fila_escolhida_em: filaEscolhidaEmFromAny(raw),
    fila_departamento_id: filaDepartamentoIdFromAny(raw),

    exigir_aceite: filaExigirAceite,
    aceite_obrigatorio: filaExigirAceite,
    aguardando_aceite: aguardandoAceite,
  };
}

function clearFilaState(c) {
  if (!c) return c;

  c.fila_id = null;
  c.fila_nome = null;
  c.fila_prioridade = null;
  c.fila_sla_minutos = null;
  c.fila_cor = null;
  c.fila_ativa = false;
  c.fila_exigir_aceite = false;
  c.fila_escolhida_em = null;
  c.fila_departamento_id = null;
  c.exigir_aceite = false;
  c.aceite_obrigatorio = false;
  c.aguardando_aceite = false;

  return c;
}

function copyFilaState(target, source) {
  if (!target || !source) return target;

  target.fila_id = source.fila_id ?? null;
  target.fila_nome = source.fila_nome ?? null;
  target.fila_prioridade = source.fila_prioridade ?? null;
  target.fila_sla_minutos = source.fila_sla_minutos ?? null;
  target.fila_cor = source.fila_cor ?? null;
  target.fila_ativa = !!source.fila_ativa;
  target.fila_exigir_aceite = !!source.fila_exigir_aceite;
  target.fila_escolhida_em = source.fila_escolhida_em ?? null;
  target.fila_departamento_id = source.fila_departamento_id ?? null;
  target.exigir_aceite = !!source.fila_exigir_aceite;
  target.aceite_obrigatorio = !!source.fila_exigir_aceite;
  target.aguardando_aceite = !!source.aguardando_aceite;

  return target;
}

function mergeFilaState(n, a) {
  if (!n || !a) return n;

  const nExplicit = !!n.__has_fila_payload;
  const nFila = filaIdKey(n.fila_id);
  const aFila = filaIdKey(a.fila_id);

  /*
    Regra importante:
    - Se payload novo veio com campos de fila explícitos, ele manda.
      Se veio fila_id null, limpa a fila.
    - Se payload novo veio parcial sem campos de fila, preserva fila antiga.
      Isso evita perder badge em evento de preview/ack que não sabe fila.
  */
  if (!nExplicit && aFila) {
    copyFilaState(n, a);
    return n;
  }

  if (!nFila) {
    return clearFilaState(n);
  }

  if (nFila && aFila && String(nFila) === String(aFila)) {
    if (!cleanName(n.fila_nome) && cleanName(a.fila_nome)) n.fila_nome = a.fila_nome;
    if (!n.fila_prioridade && a.fila_prioridade) n.fila_prioridade = a.fila_prioridade;
    if (!n.fila_sla_minutos && a.fila_sla_minutos) n.fila_sla_minutos = a.fila_sla_minutos;
    if (!n.fila_cor && a.fila_cor) n.fila_cor = a.fila_cor;
    if (!n.fila_escolhida_em && a.fila_escolhida_em) n.fila_escolhida_em = a.fila_escolhida_em;
    if (!n.fila_departamento_id && a.fila_departamento_id) n.fila_departamento_id = a.fila_departamento_id;

    n.fila_ativa = !!(n.fila_ativa || a.fila_ativa);
    n.fila_exigir_aceite = !!(n.fila_exigir_aceite || a.fila_exigir_aceite);
    n.exigir_aceite = !!n.fila_exigir_aceite;
    n.aceite_obrigatorio = !!n.fila_exigir_aceite;
    n.aguardando_aceite = !!(n.aguardando_aceite || a.aguardando_aceite);
  }

  return n;
}

function applyFilaPayloadToConversation(c, payload = {}) {
  if (!c || !payload || typeof payload !== 'object') return false;

  if (!filaPayloadPresent(payload)) return false;

  const next = normalizeFilaState(payload);

  c.__has_fila_payload = true;

  if (!next.fila_id) {
    clearFilaState(c);
    return true;
  }

  copyFilaState(c, next);

  return true;
}

function filaBadgeHtml(c) {
  if (!temFilaReal(c)) return '';

  const filaId = filaIdKey(c.fila_id);
  const filaNome = cleanName(c.fila_nome);
  const prio = filaPrioridadeNorm(c.fila_prioridade);
  const prioLabel = filaPrioridadeLabel(prio);
  const cor = filaCorNorm(c.fila_cor) || 'verde';
  const sla = filaSlaLabel(c.fila_sla_minutos);

  const titleParts = [`Fila: ${filaNome}`];
  if (prioLabel) titleParts.push(`Prioridade: ${prioLabel}`);
  if (sla) titleParts.push(sla);

  const prioHtml = prioLabel
    ? `<span class="chat-fila-prio chat-fila-prio-${escapeHtml(prio || 'normal')}">${escapeHtml(prioLabel)}</span>`
    : '';

  return `
    <div class="chat-fila-row"
         data-fila-id="${escapeHtml(String(filaId || ''))}"
         title="${escapeHtml(titleParts.join(' • '))}">
      <span class="chat-fila-badge chat-fila-cor-${escapeHtml(cor)}">
        <i class="fa-solid fa-layer-group"></i>
        <span>${escapeHtml(filaNome)}</span>
      </span>
      ${prioHtml}
    </div>`;
}

function updateFilaInline(li, payload = {}) {
  if (!li || !filaPayloadPresent(payload)) return;

  const current = {
    fila_id: li.dataset.filaId || null,
    fila_nome: li.dataset.filaNome || null,
    fila_prioridade: li.dataset.filaPrioridade || null,
    fila_sla_minutos: li.dataset.filaSlaMinutos || null,
    fila_cor: li.dataset.filaCor || null,
    fila_ativa: li.dataset.filaAtiva === '1',
    fila_exigir_aceite: li.dataset.filaExigirAceite === '1',
  };

  const temp = normalizeCliente({
    ...current,
    ...payload,
    id: li.dataset.id || '',
    conversation_key: li.dataset.conversationKey || li.dataset.id || '',
  });

  const filaId = filaIdKey(temp.fila_id);
  const filaNome = cleanName(temp.fila_nome);
  const has = !!filaId && !!filaNome;

  li.classList.toggle('has-fila', has);

  li.dataset.filaId = has ? String(filaId) : '';
  li.dataset.filaNome = has ? filaNome : '';
  li.dataset.filaPrioridade = has ? String(temp.fila_prioridade || '') : '';
  li.dataset.filaSlaMinutos = has ? String(temp.fila_sla_minutos || '') : '';
  li.dataset.filaCor = has ? String(temp.fila_cor || '') : '';
  li.dataset.filaAtiva = has && temp.fila_ativa ? '1' : '0';
  li.dataset.filaExigirAceite = has && temp.fila_exigir_aceite ? '1' : '0';

  let row = li.querySelector('.chat-fila-row');

  if (!has) {
    if (row) row.remove();
    return;
  }

  const html = filaBadgeHtml(temp);

  if (!row) {
    const chatName = li.querySelector('.chat-name');
    if (chatName) {
      chatName.insertAdjacentHTML('afterend', html);
    }
  } else {
    row.outerHTML = html;
  }
}

/* =========================================================
   Conversation key helpers
   ========================================================= */
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

function buildConversationKey(kind, entityId, instanciaId) {
  const k = String(kind || '').toLowerCase() === 'g' ? 'g' : 'c';
  const eid = idKey(entityId);
  const iid = instKey(instanciaId);

  if (!eid) return null;
  return `${k}:${eid}:${iid ?? '0'}`;
}

function convRefOf(itemOrId, row = null) {
  if (typeof itemOrId === 'object' && itemOrId) {
    const item = itemOrId;
    const raw =
      item?.conversation_key ??
      item?.conversation_id ??
      item?.id ??
      item?.cliente_id ??
      item?.grupo_id ??
      null;

    const parsed = parseConversationKey(raw);
    if (parsed) return parsed;

    const kind = getConversationKind(raw, item) || (Boolean(item?.is_group) ? 'g' : 'c');

    const entityId =
      getConversationEntityId(raw, item) ??
      idKey(item?.entity_id) ??
      idKey(kind === 'g' ? item?.grupo_id : item?.cliente_id) ??
      null;

    const instId =
      instKey(item?.instancia_id) ??
      instKey(item?.instancia) ??
      instKey(item?.instance_name) ??
      null;

    const key =
      getConversationKey(raw, item, instId) ||
      buildConversationKey(kind, entityId, instId) ||
      idKey(raw);

    const reparsed = parseConversationKey(key);

    return reparsed || {
      key,
      kind,
      entityId,
      instId,
    };
  }

  const raw = itemOrId;
  const parsed = parseConversationKey(raw);
  if (parsed) return parsed;

  const key = getConversationKey(raw, row || null) || idKey(raw);
  const reparsed = parseConversationKey(key);

  if (reparsed) return reparsed;

  return {
    key,
    kind: row ? (getConversationKind(raw, row) || (Boolean(row?.is_group) ? 'g' : 'c')) : null,
    entityId: row ? (getConversationEntityId(raw, row) || null) : (/^\d+$/.test(String(key || '')) ? String(key) : null),
    instId: row
      ? (instKey(row?.instancia_id) ?? instKey(row?.instancia) ?? instKey(row?.instance_name) ?? null)
      : null,
  };
}

function convKeyOf(itemOrId, row = null) {
  return convRefOf(itemOrId, row).key || null;
}

function convEntityIdOf(itemOrId, row = null) {
  return convRefOf(itemOrId, row).entityId || null;
}

function convKindOf(itemOrId, row = null) {
  return convRefOf(itemOrId, row).kind || 'c';
}

function sameConversation(a, b) {
  const A = convKeyOf(a, typeof a === 'object' ? a : null);
  const B = convKeyOf(b, typeof b === 'object' ? b : null);

  if (A && B) return A === B;

  const ra = convRefOf(a, typeof a === 'object' ? a : null);
  const rb = convRefOf(b, typeof b === 'object' ? b : null);

  return !!ra.entityId && !!rb.entityId &&
    ra.entityId === rb.entityId &&
    (ra.kind || 'c') === (rb.kind || 'c') &&
    (ra.instId || '') === (rb.instId || '');
}

/* =========================================================
   Avatar color fixo por conversa
   ========================================================= */
function avatarColorClassForConversation(seed) {
  const s = String(seed || '').trim();

  if (!s) return 'avatar-color-1';

  let hash = 0;

  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }

  const n = Math.abs(hash) % 6;
  return `avatar-color-${n + 1}`;
}

/* =========================================================
   Compat refs
   ========================================================= */
function syncLegacyRefs() {
  try { window.clientesCache = Array.isArray(state.clientesCache) ? state.clientesCache : []; } catch {}
  try { window.todosContatosCache = Array.isArray(state.todosContatosCache) ? state.todosContatosCache : []; } catch {}
  try { window.cacheHistoricos = window.cacheHistoricos || Object.create(null); } catch {}
}

function getActiveInstKey() {
  try {
    const emp = Number(localStorage.getItem('empresa_id') || EMPRESA_ID || 0);
    const lsKey = emp ? `instAtiva:${emp}` : null;
    const w = instKey(window.INSTANCIA_ATIVA);
    const ls = lsKey ? instKey(localStorage.getItem(lsKey) || '') : null;
    return (w || ls || 'all');
  } catch {
    return 'all';
  }
}

function syncActiveConvs(list, nextCursor = null) {
  const items = Array.isArray(list) ? list.slice() : [];
  const instKeyNow = getActiveInstKey();

  state.convsByInst = state.convsByInst || {};
  state.convsByInst[instKeyNow] = {
    items,
    nextCursor: nextCursor ?? null,
    ts: Date.now(),
  };

  state.clientesCache = items;
  state.nextCursor = nextCursor ?? null;

  try { window.__zcListaConversas = items.slice(); } catch {}
  try { window.__zcListaConversasNextCursor = nextCursor ?? null; } catch {}

  syncLegacyRefs();
  persist();
}

/* =========================================================
   Avatar
   ========================================================= */
const __brokenAvatarUrls = new Set();

function cleanAvatarUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^(null|undefined|about:blank)$/i.test(s)) return '';
  return s;
}

function markBrokenAvatar(url) {
  const s = cleanAvatarUrl(url);
  if (s) __brokenAvatarUrls.add(s);
}

function isBrokenAvatarUrl(url) {
  const s = cleanAvatarUrl(url);
  if (!s) return false;
  return __brokenAvatarUrls.has(s);
}

function _ensureAvatarPlaceholder(span) {
  try {
    if (!span) return;
    span.classList.add('placeholder');
    span.innerHTML = '<i class="fa fa-user-circle"></i>';
  } catch {}
}

if (typeof window !== 'undefined') {
  window.handleListAvatarError = function (imgEl) {
    try {
      if (!imgEl) return;

      const src = imgEl.getAttribute('src') || '';
      markBrokenAvatar(src);

      try { imgEl.onerror = null; } catch {}

      const span = imgEl.closest?.('.avatar') || imgEl.parentElement;
      try { imgEl.remove(); } catch {}

      _ensureAvatarPlaceholder(span);
    } catch {}
  };

  window.handleAvatarError = function (imgEl) {
    try {
      if (!imgEl) return;

      const src = imgEl.getAttribute('src') || '';
      markBrokenAvatar(src);

      try { imgEl.onerror = null; } catch {}

      const span = imgEl.closest?.('.avatar') || imgEl.parentElement;
      try { imgEl.remove(); } catch {}

      if (span) {
        span.classList.add('avatar-default');
        span.innerHTML = '<i class="fa fa-user-circle text-2xl text-gray-400"></i>';
      }
    } catch {}
  };

  window.zcAvatarBroken = window.zcAvatarBroken || isBrokenAvatarUrl;
}

/* =========================================================
   Daily refresh avatar
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

    const limit = Math.max(1, Math.min(80, Number(window.AVATAR_DAILY_LIMIT || 30)));
    const conc = Math.max(1, Math.min(3, Number(window.AVATAR_DAILY_CONCURRENCY || 1)));

    const base = Array.isArray(state.clientesCache) ? state.clientesCache.slice() : [];
    if (!base.length) {
      _markDaily();
      return;
    }

    const topRecent = ordenarConversasDesc(base).slice(0, limit);
    const targets = topRecent.filter((c) => {
      if (c?.avatar_url) return false;
      if (convKindOf(c) !== 'c') return false;
      return true;
    });

    _markDaily();
    if (!targets.length) return;

    const queue = targets.slice();

    const workers = Array.from(
      { length: Math.min(conc, queue.length) },
      async () => {
        while (queue.length) {
          const c = queue.shift();
          const entityId = convEntityIdOf(c);
          if (!entityId || !/^\d+$/.test(String(entityId))) continue;

          const cidNum = Number(entityId);
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

  setTimeout(() => {
    try { runDailyAvatarRefresh(); } catch {}
  }, 1200);
}

if (typeof window !== 'undefined') {
  window.runDailyAvatarRefresh = window.runDailyAvatarRefresh || runDailyAvatarRefresh;
}

/* =========================================================
   Helpers
   ========================================================= */
function isGroupJid(s) {
  const v = String(s || '');
  return /@g\.us$/i.test(v);
}

function looksLikeNumericGroupId(digits) {
  const d = String(digits || '');
  return d.startsWith('120') && d.length >= 15;
}

function normalizeJidOrPhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { is_group: false, jid: '', tel_norm: '' };

  if (s.includes('@')) {
    const jid = s;
    return { is_group: isGroupJid(jid), jid, tel_norm: '' };
  }

  const d = onlyDigits(s);

  if (looksLikeNumericGroupId(d)) {
    return { is_group: true, jid: `${d}@g.us`, tel_norm: '' };
  }

  const sem55 = (d.startsWith('55') && d.length > 11) ? d.slice(2) : d;
  const tel_norm = (sem55.length === 10 || sem55.length === 11) ? sem55 : '';

  return { is_group: false, jid: '', tel_norm };
}

function normalizaTelefoneBR(s) {
  const raw = String(s ?? '');
  if (raw.includes('@')) return '';

  const d = raw.replace(/\D/g, '');
  if (looksLikeNumericGroupId(d)) return '';

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

function temValor(v) {
  return v !== undefined && v !== null;
}

function boolish(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return ['1', 'true', 'sim', 'yes', 'on'].includes(s);
}

function scoreRecencia(c) {
  const ts = tsToMillis(c.hora || c.last_ts) || 0;
  const mid = Number(c.ultima_msg_id || 0);
  const ack = Number(c.last_ack || 0);
  const ava = c.avatar_url ? 1 : 0;
  return ts * 1_000_000 + mid * 1_000 + ack * 10 + ava;
}

function ordenarConversasDesc(arr) {
  const A = Array.isArray(arr) ? arr.slice() : [];

  return A.sort((a, b) => {
    const pinCmp = Number(b?.pinned ? 1 : 0) - Number(a?.pinned ? 1 : 0);
    if (pinCmp !== 0) return pinCmp;

    const recCmp = scoreRecencia(b) - scoreRecencia(a);
    if (recCmp !== 0) return recCmp;

    const kb = convKeyOf(b) || '';
    const ka = convKeyOf(a) || '';
    return kb.localeCompare(ka, 'pt-BR', { numeric: true, sensitivity: 'base' });
  });
}

function getHistoryForConversation(convOrId) {
  const convKey = typeof convOrId === 'object'
    ? convKeyOf(convOrId)
    : convKeyOf(convOrId);

  if (!convKey) return [];

  const inst = typeof convOrId === 'object'
    ? (convOrId?.instancia_id ?? convOrId?.instancia ?? parseConversationKey(convKey)?.instId ?? null)
    : (parseConversationKey(convKey)?.instId ?? null);

  const keyed = getHist(inst, convKey);
  if (Array.isArray(keyed) && keyed.length) return keyed;

  const legacy = window.cacheHistoricos?.[convKey];
  if (Array.isArray(legacy) && legacy.length) return legacy;

  return [];
}

function syncPreviewIfCached(convOrId) {
  try {
    const convKey = typeof convOrId === 'object'
      ? convKeyOf(convOrId)
      : convKeyOf(convOrId);

    if (!convKey) return false;

    const hist = getHistoryForConversation(convOrId);
    if (!hist.length) return false;

    window.syncPreviewFromCache?.(convKey);
    return true;
  } catch {
    return false;
  }
}

/* =========================================================
   Dedupe
   ========================================================= */
function dedupeConversas(arr) {
  if (!Array.isArray(arr)) return [];

  const base = ordenarConversasDesc(arr.map(normalizeCliente));
  const exact = new Map();

  for (const c of base) {
    const convKey = convKeyOf(c);
    const ref = convRefOf(c);

    const dedupeKey =
      convKey ||
      (ref.entityId ? `${ref.kind || 'c'}:${ref.entityId}:${ref.instId || '0'}` : null) ||
      null;

    if (!dedupeKey) continue;

    const cur = exact.get(dedupeKey);

    if (!cur || scoreRecencia(c) > scoreRecencia(cur)) {
      exact.set(dedupeKey, mergeConversaCanonica(c, cur));
    } else if (cur) {
      cur.pinned = Boolean(cur.pinned || c.pinned);
    }
  }

  const noEntity = [];

  for (const c of exact.values()) {
    const ref = convRefOf(c);
    if (!ref.entityId) noEntity.push(c);
  }

  const already = new Map();

  for (const c of exact.values()) {
    const ref = convRefOf(c);
    if (ref.entityId) already.set(convKeyOf(c), c);
  }

  const legacyMap = new Map();

  for (const c of noEntity) {
    const ref = convRefOf(c);
    const inst = ref.instId || instKey(c.instancia_id ?? c.instancia) || 'all';
    const isGrp = Boolean(c.is_group) || ref.kind === 'g' || isGroupJid(c.jid || c.remoteJid || c.telefone || '');

    if (isGrp) {
      const gid =
        idKey(c.jid) ||
        idKey(c.remoteJid) ||
        (String(c.telefone || '').includes('@') ? idKey(c.telefone) : null) ||
        convKeyOf(c) ||
        `g:${Math.random()}`;

      const key = `${inst}:__group__:${gid}`;
      const cur = legacyMap.get(key);

      if (!cur || scoreRecencia(c) > scoreRecencia(cur)) legacyMap.set(key, mergeConversaCanonica(c, cur));
      else if (cur) cur.pinned = Boolean(cur.pinned || c.pinned);

      continue;
    }

    const telNorm = normalizaTelefoneBR(c.telefone);

    if (telNorm) {
      const key = `${inst}:__fone__:${telNorm}`;
      const cur = legacyMap.get(key);

      if (!cur || scoreRecencia(c) > scoreRecencia(cur)) legacyMap.set(key, mergeConversaCanonica(c, cur));
      else if (cur) cur.pinned = Boolean(cur.pinned || c.pinned);

      continue;
    }

    const nomeNorm = normalizeName(c.nome || c.nome_whatsapp || c.push_name);

    if (nomeNorm) {
      const key = `${inst}:__nome__:${nomeNorm}`;
      const cur = legacyMap.get(key);

      if (!cur || scoreRecencia(c) > scoreRecencia(cur)) legacyMap.set(key, mergeConversaCanonica(c, cur));
      else if (cur) cur.pinned = Boolean(cur.pinned || c.pinned);

      continue;
    }

    const uniq = convKeyOf(c) || `__uniq__:${Math.random()}`;
    legacyMap.set(uniq, c);
  }

  const merged = [...already.values(), ...legacyMap.values()].map(normalizeCliente);
  return ordenarConversasDesc(merged);
}

/* =========================================================
   Normalização
   ========================================================= */
export function normalizeCliente(c) {
  const kind = convKindOf(c, c) || (Boolean(c?.is_group || c?.grupo || c?.isGroup) ? 'g' : 'c');

  const inst =
    instKey(c.instancia_id) ??
    instKey(c.instancia) ??
    instKey(c.instancia_slug) ??
    instKey(c.instance_id) ??
    instKey(c.instance) ??
    instKey(c.session) ??
    instKey(c.sessionName) ??
    instKey(c.sessao) ??
    instKey(c.inst_slug) ??
    parseConversationKey(c?.conversation_key || c?.conversation_id || c?.id || '')?.instId ??
    null;

  const entityId =
    convEntityIdOf(c, c) ??
    idKey(c.entity_id) ??
    idKey(kind === 'g' ? (c.grupo_id ?? c.group_id) : c.cliente_id) ??
    null;

  let conversation_key =
    convKeyOf(c, c) ??
    buildConversationKey(kind, entityId, inst) ??
    null;

  if (conversation_key && !parseConversationKey(conversation_key)) {
    const parsed = parseConversationKey(getConversationKey(conversation_key, c, inst));
    if (parsed?.key) conversation_key = parsed.key;
  }

  const rawHora =
    c.ultima_ts ??
    c.hora ??
    c.last_ts ??
    c.updated_at ??
    c.last_message_at ??
    c.timestamp ??
    null;

  const preview =
    c.ultima_texto ??
    c.ultima_mensagem ??
    c.ultima ??
    c.last_text ??
    c.preview ??
    '';

  const fotoRaw =
    c.avatar_url ||
    c.foto_url ||
    c.foto ||
    c.avatar ||
    c.profile_pic_url ||
    '';

  const fotoStr = cleanAvatarUrl(fotoRaw);
  const foto = fotoStr && !isBrokenAvatarUrl(fotoStr) ? fotoStr : '';

  const remote =
    c.remoteJid ??
    c.remote_jid ??
    c.jid ??
    c.chat_jid ??
    c.key_remoteJid ??
    c.telefone ??
    c.number ??
    c.wuid ??
    c.numero ??
    null;

  const parsed = normalizeJidOrPhone(remote);

  const hintedGroup =
    Boolean(c.is_group) ||
    Boolean(c.grupo) ||
    Boolean(c.isGroup) ||
    kind === 'g';

  let jid = parsed.jid || (isGroupJid(remote) ? String(remote) : '');

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
    : telRaw;

  const unreadCount = unreadFromAny(c);

  const statusValue = statusNorm(c.status ?? c.statusatendimento ?? c.status_atendimento ?? null);

  const operadorId = idKey(c.operador_id ?? c.owner_id ?? c.responsavel_id ?? c.assigned_to ?? null);
  const departamentoId = idKey(c.departamento_id ?? c.depto_id ?? c.setor_id ?? null);
  const operadorNome = c.operador_nome ?? c.owner_name ?? c.responsavel_nome ?? c.assigned_name ?? null;

  const participantesCount = Number(c.participantes_count ?? c.participants_count ?? 0) || 0;

  const minhaParticipacao = boolish(
    c.minha_participacao ??
    c.me_participating ??
    c.meu_acesso ??
    c.participando ??
    false
  );

  const nomeOfficial = cleanName(c.nome);
  const nomeWhats = cleanName(c.nome_whatsapp);
  const pushName = cleanName(c.push_name || c.pushName);

  const filaState = normalizeFilaState(c);

  return {
    ...c,

    id: conversation_key ?? idKey(c.id) ?? null,
    conversation_key,
    conversation_id: conversation_key,
    kind: is_group ? 'g' : (kind || 'c'),
    entity_id: entityId,
    backend_id: entityId,
    api_id: entityId,

    cliente_id: (is_group ? idKey(c.cliente_id) : (entityId ?? idKey(c.cliente_id))) ?? null,
    grupo_id: (is_group ? (entityId ?? idKey(c.grupo_id) ?? idKey(c.group_id)) : (idKey(c.grupo_id) ?? idKey(c.group_id))) ?? null,

    nome_whatsapp: nomeWhats || null,
    nome: nomeOfficial || null,
    push_name: pushName || null,

    telefone: telForUi,
    telefone_norm: tel_norm,

    jid: jid || null,
    remoteJid: jid || null,
    is_group,

    avatar_url: foto ? foto : null,

    ultima_msg_id: c.ultima_msg_id ?? c.last_msg_id ?? null,
    ultima_mensagem: preview,
    preview,
    last_message: preview,
    last_msg: preview,
    hora: rawHora,
    last_ts: c.last_ts ?? rawHora ?? null,

    novas: unreadCount,
    unread: unreadCount,
    unread_count: unreadCount,
    nao_lidas: unreadCount,

    last_tipo: c.ultima_tipo ?? c.last_tipo ?? c.tipo ?? null,
    last_ack: c.ultima_ack ?? c.last_ack ?? c.ack ?? null,

    instancia_id: inst,
    instancia: inst,

    pinned: Boolean(c.pinned || c.fixado || c.pin || false),

    instance_name: c.instance_name ?? c.instancia_nome ?? c.inst_name ?? inst ?? null,

    status: statusValue,
    statusatendimento: statusValue,

    operador_id: operadorId,
    operador_nome: operadorNome,

    departamento_id: departamentoId,

    participantes_count: participantesCount,
    minha_participacao: minhaParticipacao,

    ...filaState,

    is_new: statusValue === 'novo',
    is_waiting: statusValue === 'aguardando',
    is_in_service: statusValue === 'em_atendimento',
    is_paused: statusValue === 'pausado',
    is_resolved: statusValue === 'resolvido',
    is_transferred: statusValue === 'transferido',
    is_accepted: !!operadorId,
  };
}

/* =========================================================
   Merge canônico
   ========================================================= */
function mergeConversaCanonica(novo, antigo) {
  let n = normalizeCliente(novo || {});
  const a = antigo ? normalizeCliente(antigo) : null;

  if (!a) return n;
  if (!sameConversation(n, a)) return n;

  n = aplicarNomeOficialNoMerge(n, a);
  n = mergeFilaState(n, a);

  if (!n.jid && a.jid) n.jid = a.jid;
  if (!n.remoteJid && a.remoteJid) n.remoteJid = a.remoteJid;

  n.is_group = Boolean(
    n.is_group ||
    a.is_group ||
    isGroupJid(n.telefone) ||
    isGroupJid(a.telefone) ||
    isGroupJid(n.jid) ||
    isGroupJid(a.jid)
  );

  if (n.is_group) {
    const keep =
      n.jid ||
      n.remoteJid ||
      a.jid ||
      a.remoteJid ||
      n.telefone ||
      a.telefone ||
      '';

    if (keep) n.telefone = keep;
    n.telefone_norm = '';
  } else {
    if (!n.telefone_norm && a.telefone_norm) n.telefone_norm = a.telefone_norm;
    if (!n.telefone && a.telefone) n.telefone = a.telefone;
  }

  if (!n.avatar_url && a.avatar_url && !isBrokenAvatarUrl(a.avatar_url)) n.avatar_url = a.avatar_url;

  const oldTs = tsToMillis(a?.hora || a?.last_ts);
  const newTs = tsToMillis(n.hora || n.last_ts);

  if (a && oldTs && newTs && oldTs > newTs) {
    if (a.ultima_mensagem && String(a.ultima_mensagem).trim()) n.ultima_mensagem = a.ultima_mensagem;
    if (a.preview && String(a.preview).trim()) n.preview = a.preview;
    if (a.last_message && String(a.last_message).trim()) n.last_message = a.last_message;
    if (a.last_msg && String(a.last_msg).trim()) n.last_msg = a.last_msg;

    if (a.last_tipo) n.last_tipo = a.last_tipo;

    if (a.last_tipo === 'saida' && temValor(a.last_ack)) {
      n.last_ack = Math.max(Number(n.last_ack || 0), Number(a.last_ack || 0));
    }

    if (temValor(a.novas) && (Number(n.novas) || 0) === 0) {
      const u = unreadFromAny(a);
      n.novas = u;
      n.unread = u;
      n.unread_count = u;
      n.nao_lidas = u;
    }

    if (temValor(a.hora)) n.hora = a.hora;
    if (temValor(a.last_ts) && !temValor(n.last_ts)) n.last_ts = a.last_ts;
  } else {
    if ((!n.ultima_mensagem || !String(n.ultima_mensagem).trim()) && a?.ultima_mensagem) {
      n.ultima_mensagem = a.ultima_mensagem;
      n.preview = a.ultima_mensagem;
      n.last_message = a.ultima_mensagem;
      n.last_msg = a.ultima_mensagem;
    }

    if (temValor(a?.novas) && (Number(n.novas) || 0) === 0) {
      const u = unreadFromAny(a);
      n.novas = u;
      n.unread = u;
      n.unread_count = u;
      n.nao_lidas = u;
    }
  }

  if (temValor(a?.last_ack)) {
    if (!temValor(n.last_ack)) n.last_ack = a.last_ack;
    else n.last_ack = Math.max(Number(n.last_ack || 0), Number(a.last_ack || 0));
  }

  n.pinned = Boolean(n.pinned || a?.pinned);

  if (!n.instance_name && a?.instance_name) n.instance_name = a.instance_name;
  if (!n.instancia_id && a?.instancia_id) n.instancia_id = a.instancia_id;
  if (!n.instancia && a?.instancia) n.instancia = a.instancia;

  if (!n.status && a?.status) n.status = a.status;
  if (!n.statusatendimento && a?.statusatendimento) n.statusatendimento = a.statusatendimento;

  if (!n.operador_id && a?.operador_id) n.operador_id = a.operador_id;
  if (!n.operador_nome && a?.operador_nome) n.operador_nome = a.operador_nome;
  if (!n.departamento_id && a?.departamento_id) n.departamento_id = a.departamento_id;

  if (!temValor(n.participantes_count) && temValor(a?.participantes_count)) {
    n.participantes_count = a.participantes_count;
  }

  if (!n.minha_participacao && a?.minha_participacao) {
    n.minha_participacao = a.minha_participacao;
  }

  if (!n.entity_id && a?.entity_id) n.entity_id = a.entity_id;
  if (!n.conversation_key && a?.conversation_key) n.conversation_key = a.conversation_key;
  if (!n.conversation_id && a?.conversation_id) n.conversation_id = a.conversation_id;

  n.status = statusNorm(n.status ?? n.statusatendimento);
  n.statusatendimento = n.status;

  n.is_new = n.status === 'novo';
  n.is_waiting = n.status === 'aguardando';
  n.is_in_service = n.status === 'em_atendimento';
  n.is_paused = n.status === 'pausado';
  n.is_resolved = n.status === 'resolvido';
  n.is_transferred = n.status === 'transferido';
  n.is_accepted = !!n.operador_id;

  return n;
}

/* =========================================================
   Prefetch opcional
   ========================================================= */
function buildMsgsUrl(convKeyOrItem, instanciaId, extra = {}) {
  const entityId = typeof convKeyOrItem === 'object'
    ? convEntityIdOf(convKeyOrItem)
    : convEntityIdOf(convKeyOrItem);

  if (!entityId) return null;

  const qs = new URLSearchParams({
    empresa_id: String(EMPRESA_ID),
    limit: String(extra.limit || 30),
  });

  const parsed = parseConversationKey(typeof convKeyOrItem === 'object' ? convKeyOf(convKeyOrItem) : convKeyOrItem);
  const instFinal = instanciaId ?? parsed?.instId ?? null;

  if (instFinal != null && instFinal !== '' && instFinal !== 'all') {
    qs.set('instancia_id', String(instFinal));
  }

  if (extra.since_ts) qs.set('since_ts', String(extra.since_ts));
  if (extra.since_id) qs.set('since_id', String(extra.since_id));

  return `/api/atendimento/conversas/${encodeURIComponent(String(entityId))}/mensagens?` + qs.toString();
}

async function fetchConv30(convOrItem, instanciaId) {
  const url = buildMsgsUrl(convOrItem, instanciaId);
  if (!url) throw new Error('Conversa inválida para prefetch');

  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('Falha ao carregar mensagens da conversa');

  const data = await r.json();
  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);

  const cursors = {
    oldest: data?.prev_cursor ?? null,
    newest: data?.next_cursor ?? null,
  };

  return { items, cursors };
}

const PREFETCH_LIMIT = 4;

async function primeHistories(convs, { concurrency = 1 } = {}) {
  if (!window.PREFETCH_HISTORIES) return;

  const lista = Array.isArray(convs) ? convs.slice() : [];
  const unread = lista.filter((c) => Number(c.novas || 0) > 0).slice(0, PREFETCH_LIMIT);
  if (!unread.length) return;

  const queue = unread.slice();

  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, queue.length)) },
    async () => {
      while (queue.length) {
        const c = queue.shift();
        const convKey = convKeyOf(c);
        if (!convKey) continue;

        const inst = c.instancia_id ?? c.instancia ?? parseConversationKey(convKey)?.instId ?? null;

        try {
          const { items, cursors } = await fetchConv30(c, inst);
          primeWith(inst, convKey, items, cursors);
          syncPreviewIfCached(c);
        } catch (e) {
          try { console.debug('[primeHistories] erro conv', convKey, e); } catch {}
        }
      }
    }
  );

  await Promise.all(runners);
}


/* =========================================================
   UI leve de carregamento da lista
   ========================================================= */
function getListaEl() {
  return document.getElementById('lista-clientes');
}

function renderListaLoading(reason = '') {
  const ul = getListaEl();
  if (!ul) return;

  if (ul.dataset.loadingConversas === '1') return;

  ul.dataset.loadingConversas = '1';
  ul.__zcLastRenderedHtml = '';

  ul.innerHTML = `
    <li class="chat-list-state chat-list-loading" data-list-state="loading">
      <div class="chat-list-state-spinner" aria-hidden="true"></div>
      <div class="chat-list-state-text">${escapeHtml(LIST_LOADING_TEXT)}</div>
    </li>
  `;

  try {
    window.dispatchEvent(new CustomEvent('zc:lista-conversas-loading', {
      detail: { reason: reason || '' }
    }));
  } catch {}
}

function clearListaLoading() {
  const ul = getListaEl();
  if (!ul) return;
  delete ul.dataset.loadingConversas;
}

function renderListaEmpty() {
  const ul = getListaEl();
  if (!ul) return;

  clearListaLoading();
  ul.__zcLastRenderedHtml = '';
  ul.innerHTML = `
    <li class="chat-list-state chat-list-empty" data-list-state="empty">
      <div class="chat-list-state-icon"><i class="fa-regular fa-comments"></i></div>
      <div class="chat-list-state-title">${escapeHtml(LIST_EMPTY_TEXT)}</div>
      <div class="chat-list-state-sub">Quando chegarem mensagens, elas aparecerão aqui.</div>
    </li>
  `;
}

function renderListaError(onRetry = null) {
  const ul = getListaEl();
  if (!ul) return;

  clearListaLoading();
  ul.__zcLastRenderedHtml = '';
  ul.innerHTML = `
    <li class="chat-list-state chat-list-error" data-list-state="error">
      <div class="chat-list-state-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
      <div class="chat-list-state-title">${escapeHtml(LIST_ERROR_TEXT)}</div>
      <button type="button" class="chat-list-retry-btn">Tentar novamente</button>
    </li>
  `;

  try {
    const btn = ul.querySelector('.chat-list-retry-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        if (typeof onRetry === 'function') onRetry();
        else carregarClientes({ force: true, reason: 'retry-list-error' }).catch(() => {});
      });
    }
  } catch {}
}

/* =========================================================
   Carregar conversas
   ========================================================= */

/*
  Correção defensiva da lista:
  - A API atual retorna { items, next_cursor }.
  - Alguns estados antigos de empresa/instância no localStorage podem fazer o front
    montar query errada ou _matchInstancia zerar tudo.
  - Se a API trouxe conversas, o front não deve transformar isso em lista vazia.
*/
let __warnedMatchInstancia = false;

function empresaIdForQuery() {
  const s = String(EMPRESA_ID ?? '').trim();
  if (!s || ['null', 'undefined', 'nan', '0'].includes(s.toLowerCase())) return null;

  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;

  return String(Math.trunc(n));
}

function safeInstQueryString() {
  try {
    const raw = String((typeof _instQuery === 'function' ? _instQuery() : '') || '').trim();
    if (!raw) return '';

    const cleaned = raw.replace(/^[?&]+/, '');
    if (!cleaned) return '';

    const inParams = new URLSearchParams(cleaned);
    const out = new URLSearchParams();

    for (const [key, value] of inParams.entries()) {
      const k = String(key || '').trim();
      const v = String(value ?? '').trim();

      if (!k || !v) continue;
      if (['empresa_id', 'limit', 'cursor_last_msg_id'].includes(k)) continue;

      // Evita mandar instancia=all/0/null e depois o próprio front filtrar tudo.
      if (/inst/i.test(k)) {
        if (!instKey(v)) continue;
      }

      out.append(k, v);
    }

    const qs = out.toString();
    return qs ? `&${qs}` : '';
  } catch {
    try {
      const raw = String((typeof _instQuery === 'function' ? _instQuery() : '') || '').trim();
      if (!raw) return '';
      return raw.startsWith('&') ? raw : `&${raw.replace(/^[?&]+/, '')}`;
    } catch {
      return '';
    }
  }
}

function currentInstQueryKey() {
  return (safeInstQueryString() || '').replace(/^[?&]+/, '') || 'all';
}

function instQueryValues() {
  try {
    const qs = safeInstQueryString().replace(/^[?&]+/, '');
    if (!qs) return [];

    const params = new URLSearchParams(qs);
    const vals = [];

    for (const [key, value] of params.entries()) {
      if (!/inst/i.test(String(key || ''))) continue;

      const v = instKey(value);
      if (v) vals.push(String(v));
    }

    return vals;
  } catch {
    return [];
  }
}

function hasSpecificInstQuery() {
  return instQueryValues().length > 0;
}

function buildConversasListUrl({
  limit = 20,
  cursor = null,
  includeEmpresa = true,
  includeInst = true,
} = {}) {
  const qs = new URLSearchParams();

  const empresaId = empresaIdForQuery();
  if (includeEmpresa && empresaId) {
    qs.set('empresa_id', empresaId);
  }

  qs.set('limit', String(limit || 20));

  if (cursor !== null && cursor !== undefined && String(cursor).trim() !== '') {
    qs.set('cursor_last_msg_id', String(cursor));
  }

  let url = `/api/atendimento/conversas?${qs.toString()}`;

  if (includeInst) {
    url += safeInstQueryString();
  }

  return url;
}

function extractConversasPayload(payload) {
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.conversas)
        ? payload.conversas
        : Array.isArray(payload?.data)
          ? payload.data
          : [];

  const next =
    payload?.next_cursor ??
    payload?.nextCursor ??
    payload?.cursor_next ??
    payload?.cursor ??
    null;

  return { items, next };
}

function itemInstValues(c) {
  const parsed = parseConversationKey(c?.conversation_key || c?.conversation_id || c?.id || '');

  return [
    c?.instancia_id,
    c?.instancia,
    c?.instancia_slug,
    c?.instance_id,
    c?.instance,
    c?.instance_name,
    c?.session,
    c?.sessionName,
    parsed?.instId,
  ]
    .map((v) => instKey(v))
    .filter(Boolean)
    .map(String);
}

function manualMatchInstancia(c) {
  const queryVals = instQueryValues();

  // Modo "Todos": não filtra no front.
  if (!queryVals.length) return true;

  const vals = itemInstValues(c);
  if (!vals.length) return true;

  return vals.some((v) => queryVals.includes(String(v)));
}

function matchInstanciaSafe(c) {
  try {
    return _matchInstancia(c) !== false;
  } catch (e) {
    if (!__warnedMatchInstancia) {
      __warnedMatchInstancia = true;
      try { console.warn('[clientes] _matchInstancia falhou; usando filtro seguro.', e); } catch {}
    }
    return manualMatchInstancia(c);
  }
}

function normalizeAndFilterConversas(items, reason = '') {
  const normalized = (Array.isArray(items) ? items : [])
    .map(normalizeCliente)
    .filter(Boolean);

  if (!normalized.length) return [];

  const filtered = normalized.filter(matchInstanciaSafe);
  if (filtered.length) return filtered;

  const manual = normalized.filter(manualMatchInstancia);
  if (manual.length) {
    try {
      console.warn('[clientes] _matchInstancia zerou a lista; usando filtro manual.', {
        reason,
        total: normalized.length,
        manual: manual.length,
        instQuery: safeInstQueryString() || 'all',
      });
    } catch {}

    return manual;
  }

  /*
    Última defesa:
    Se chegou até aqui, a API trouxe conversas, mas o estado local do front
    filtrou todas. Preferimos renderizar o retorno real da API em vez de mostrar
    "Nenhuma conversa encontrada" indevidamente.
  */
  try {
    console.warn('[clientes] filtro de instância zerou retorno da API; renderizando retorno original.', {
      reason,
      total: normalized.length,
      activeInst: getActiveInstKey(),
      instQuery: safeInstQueryString() || 'all',
    });
  } catch {}

  return normalized;
}

async function fetchConversasSemFiltroFallback(limit = 20) {
  const url = buildConversasListUrl({
    limit,
    includeEmpresa: false,
    includeInst: false,
  });

  const r = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
  });

  if (!r.ok) return null;

  return r.json();
}

function currentConversasLoadKey() {
  const instQuery = currentInstQueryKey();
  return `${LIST_LOCAL_CACHE_VERSION}:${empresaIdForQuery() || 'sessao'}:${instQuery}`;
}

function scheduleCarregarClientes(opts = {}, delay = LIST_DEBOUNCE_MS) {
  clearTimeout(__scheduledLoadTimer);

  __scheduledLoadTimer = setTimeout(() => {
    __scheduledLoadTimer = null;
    carregarClientes(opts).catch(() => {});
  }, Math.max(80, Number(delay) || LIST_DEBOUNCE_MS));
}

export async function carregarClientes({ force = false, reason = '' } = {}) {
  const loadKey = currentConversasLoadKey();
  const now = Date.now();
  const hasCache = Array.isArray(state.clientesCache) && state.clientesCache.length > 0;
  const sameKey = __lastConversasKey === loadKey;
  const elapsed = now - __lastConversasFetchAt;

  if (__loadingConversasPromise) {
    if (!hasCache) renderListaLoading(reason || 'in-flight');
    return __loadingConversasPromise;
  }

  if (!force && hasCache && sameKey && elapsed < LIST_CACHE_TTL_MS) {
    renderListaClientes(state.clientesCache);
    return state.clientesCache;
  }

  if (force && hasCache && sameKey && elapsed < LIST_FORCE_MIN_INTERVAL_MS) {
    scheduleCarregarClientes(
      { force: true, reason: reason ? `debounced:${reason}` : 'debounced' },
      LIST_FORCE_MIN_INTERVAL_MS - elapsed + 80
    );

    renderListaClientes(state.clientesCache);
    return state.clientesCache;
  }

  if (!hasCache) {
    renderListaLoading(reason || 'initial-load');
  }

  __lastConversasKey = loadKey;
  __lastConversasFetchAt = now;

  __loadingConversasPromise = (async () => {
    const instQuery = currentInstQueryKey();
    const cacheKey = `${LIST_LOCAL_CACHE_VERSION}:${empresaIdForQuery() || 'sessao'}:${instQuery}`;
    const url = buildConversasListUrl({ limit: 20 });

    const forceSession = sessionStorage.getItem('convForceReload') === '1';

    if (forceSession) {
      try { sessionStorage.removeItem('convForceReload'); } catch {}
    }

    const forceFlag = Boolean(force || forceSession);

    try {
      const raw = await fetchWithCache(
        url,
        {
          ttlMs: forceFlag ? 0 : LIST_CACHE_TTL_MS,
          key: cacheKey,
          bust: forceFlag,
        }
      );

      let { items, next } = extractConversasPayload(raw);
      let usedFallback = false;

      /*
        Se empresa_id/instância salvos no front estiverem errados, a chamada
        com query pode voltar vazia, enquanto a sessão real ainda tem conversas.
        Foi exatamente o sintoma visto no console: /api/atendimento/conversas
        sem query retornou 20 conversas.
      */
      if (!items.length && (empresaIdForQuery() || safeInstQueryString())) {
        try {
          const fallbackRaw = await fetchConversasSemFiltroFallback(20);
          const fallbackPayload = extractConversasPayload(fallbackRaw);

          if (fallbackPayload.items.length) {
            items = fallbackPayload.items;
            next = fallbackPayload.next;
            usedFallback = true;

            try {
              console.warn('[clientes] query com empresa/instância voltou vazia; usando sessão como fallback.', {
                url,
                fallback_items: items.length,
              });
            } catch {}
          }
        } catch (e) {
          try { console.warn('[clientes] fallback sem filtros falhou:', e); } catch {}
        }
      }

      __lastConversasUsedSafeFallback = usedFallback;

      let cs = normalizeAndFilterConversas(items, 'carregarClientes');

      const antigo = Array.isArray(state.clientesCache)
        ? state.clientesCache.map(normalizeCliente)
        : [];

      const antigoMap = new Map();

      for (const a of antigo) {
        const k = convKeyOf(a);
        if (k) antigoMap.set(k, a);
      }

      cs = cs.map((n) => {
        const k = convKeyOf(n);
        return mergeConversaCanonica(n, k ? antigoMap.get(k) : null);
      });

      let all = dedupeConversas(cs);

      const selKey = convKeyOf(state?.clienteSel);

      if (selKey && !all.some((x) => convKeyOf(x) === selKey)) {
        const sel = antigoMap.get(selKey) || state?.clienteSel || null;

        if (sel) {
          const normSel = normalizeCliente(sel);
          all = dedupeConversas([...all, normSel]);
        }
      }

      syncActiveConvs(all, next);

      if (all.length) {
        renderListaClientes(all);
      } else {
        renderListaEmpty();
      }

      /*
        Importante para performance:
        - Não varrer histórico de todas as conversas só para montar preview.
        - O backend já entrega a última mensagem da lista.
        - Histórico completo só carrega quando abrir a conversa.
      */

      if (window.PREFETCH_HISTORIES === true) {
        try { await primeHistories(state.clientesCache, { concurrency: 1 }); } catch {}
      }

      kickDailyAvatarRefreshSoon();

      return all;
    } catch (e) {
      try { console.error('[clientes] carregarClientes erro:', e); } catch {}

      if (hasCache) {
        renderListaClientes(state.clientesCache);
        return state.clientesCache;
      }

      renderListaError(() => {
        carregarClientes({ force: true, reason: 'retry-after-error' }).catch(() => {});
      });

      return [];
    }
  })();

  try {
    return await __loadingConversasPromise;
  } finally {
    __loadingConversasPromise = null;
    clearListaLoading();
  }
}

/* =========================================================
   Carregar mais
   ========================================================= */
export function wireListaInfiniteScroll() {}

export async function loadMoreConversas() {
  if (__loadingMoreConversas) return;

  const cursor = state.nextCursor;
  if (!cursor) return;

  __loadingMoreConversas = true;

  try {
    const url = buildConversasListUrl({
      limit: 20,
      cursor,
      includeEmpresa: !__lastConversasUsedSafeFallback,
      includeInst: !__lastConversasUsedSafeFallback,
    });

    const r = await fetch(url, { credentials: 'include' });

    if (!r.ok) return;

    const data = await r.json();

    const { items, next } = extractConversasPayload(data);
    const mais = normalizeAndFilterConversas(items, 'loadMoreConversas');

    const map = new Map(
      (state.clientesCache || []).map((c) => [String(convKeyOf(c) || ''), normalizeCliente(c)])
    );

    for (const it of mais) {
      const key = String(convKeyOf(it) || '');
      if (!key) continue;

      const prev = map.get(key) || {};
      const merged = mergeConversaCanonica({ ...prev, ...it }, prev);

      merged.pinned = Boolean((prev && prev.pinned) || it.pinned);

      merged.is_group = Boolean(
        merged.is_group ||
        prev?.is_group ||
        it?.is_group ||
        convKindOf(merged) === 'g' ||
        isGroupJid(merged.telefone) ||
        isGroupJid(merged.jid) ||
        isGroupJid(merged.remoteJid)
      );

      if (merged.is_group) {
        const keep =
          merged.jid ||
          merged.remoteJid ||
          prev?.jid ||
          prev?.remoteJid ||
          it?.jid ||
          it?.remoteJid ||
          merged.telefone ||
          prev?.telefone ||
          it?.telefone ||
          '';

        if (keep) merged.telefone = keep;
        merged.telefone_norm = '';
      } else {
        if (!merged.telefone_norm) {
          merged.telefone_norm =
            prev?.telefone_norm ||
            it?.telefone_norm ||
            normalizaTelefoneBR(merged.telefone);
        }
      }

      map.set(key, normalizeCliente(merged));
    }

    const arr = dedupeConversas([...map.values()]);
    syncActiveConvs(arr, next);

    renderListaClientes(arr);

    // Preview da lista vem do backend; histórico só é lido quando abrir a conversa.
  } finally {
    __loadingMoreConversas = false;
  }
}

/* =========================================================
   Render da lista
   ========================================================= */
function wireListaClicks(ul) {
  if (!ul || ul.__zcListaClickBound) return;

  ul.__zcListaClickBound = true;

  ul.addEventListener('click', async (ev) => {
    const loadBtn = ev.target.closest('#lista-load-more .load-more-btn');

    if (loadBtn) {
      ev.preventDefault();
      ev.stopPropagation();

      if (!state.nextCursor) return;

      loadBtn.disabled = true;
      loadBtn.textContent = 'Carregando...';

      try {
        await loadMoreConversas();
      } finally {
        loadBtn.disabled = false;
        loadBtn.textContent = 'Carregar mais conversas';
      }

      return;
    }

    const item = ev.target.closest('.chat-item.cliente-item');
    if (!item || !ul.contains(item)) return;

    const id = String(item.dataset.id || '');
    if (!id) return;

    window.selecionarClienteObj?.(id);
  });
}

export function renderListaClientes(data) {
  const arr = dedupeConversas(
    normalizeAndFilterConversas(Array.isArray(data) ? data : [], 'renderListaClientes')
  );

  const ul = getListaEl();
  if (!ul) return;

  clearListaLoading();
  wireListaClicks(ul);

  const ordenado = ordenarConversasDesc(arr);

  if (!ordenado.length) {
    renderListaEmpty();
    return;
  }

  let html = ordenado.map((c) => {
    const convKey = convKeyOf(c) ?? '';
    const entityId = convEntityIdOf(c) ?? '';
    const kind = convKindOf(c) || 'c';

    const avatarColorClass = avatarColorClassForConversation(
      convKey || `${kind}:${entityId}:${c.instancia_id ?? c.instancia ?? ''}`
    );

    const nome = nomeOficialCliente(c);

    const serverMs = tsToMillis(c.hora || c.last_ts) || 0;
    let when = serverMs ? formatChatTime(serverMs) : '';
    let preview = (c.ultima_mensagem || '').trim();
    let outboundFlag = (c.last_tipo === 'saida');
    let ackValForIcon = Number(c.last_ack ?? 0) || 0;

    try {
      const instCanon = (c.instancia_id ?? c.instancia ?? parseConversationKey(convKey)?.instId ?? null) || null;

      // Performance: não chamar getHist() aqui, porque ele pode ler localStorage
      // para cada conversa da lista. Usamos somente cache em memória da conversa aberta.
      const arrHistLegacy = window.cacheHistoricos?.[convKey];
      const arrHist = Array.isArray(arrHistLegacy) ? arrHistLegacy : [];

      if (Array.isArray(arrHist) && arrHist.length) {
        const last = arrHist[arrHist.length - 1];

        const histMs =
          Number(last?.ts || 0) ||
          Date.parse(last?.timestamp || '') ||
          0;

        const rawHistText = (
          last?.texto ||
          last?.text ||
          last?.conteudo ||
          last?.mensagem ||
          ''
        ).trim();

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
      ? `<span class="preview-ack" data-ack="${ackVal}">${window.getAckIcon(ackVal)}</span>`
      : '';

    const avatarUrlRaw = c.avatar_url ? String(c.avatar_url) : '';
    const avatarUrl = cleanAvatarUrl(avatarUrlRaw);

    const av = avatarUrl && !isBrokenAvatarUrl(avatarUrl)
      ? `<span class="avatar"><img src="${escapeHtml(avatarUrl)}" alt="" data-entity-id="${escapeHtml(String(entityId))}" referrerpolicy="no-referrer"
                onerror="window.handleListAvatarError && window.handleListAvatarError(this)" /></span>`
      : `<span class="avatar placeholder"><i class="fa fa-user-circle"></i></span>`;

    const statusValue = statusNorm(c.status || c.statusatendimento || '');
    const safeStatusClass = statusValue ? ` status-${statusValue.replace(/[^a-z0-9_-]+/gi, '-')}` : '';

    const pinClass = c.pinned ? ' is-pinned' : '';
    const acceptedClass = c.operador_id ? ' is-accepted' : '';
    const unreadNumber = Number(c.novas || c.unread_count || c.unread || c.nao_lidas || 0) || 0;
    const unreadClass = unreadNumber > 0 ? ' has-unread' : '';
    const newClass = statusValue === 'novo' ? ' is-new' : '';

    const isGrp =
      Boolean(c.is_group) ||
      kind === 'g' ||
      isGroupJid(c.telefone || '') ||
      isGroupJid(c.jid || '') ||
      isGroupJid(c.remoteJid || '');

    const filaId = filaIdKey(c.fila_id);
    const filaNome = cleanName(c.fila_nome);
    const temFila = !!filaId && !!filaNome;

    const filaClass = temFila ? ' has-fila' : '';
    const filaHtml = filaBadgeHtml(c);

    const grpAttr = isGrp ? '1' : '0';
    const jidAttr = escapeHtml(String(c.jid || c.remoteJid || (isGrp ? c.telefone : '') || ''));
    const instAttr = escapeHtml(String(c.instancia_id ?? c.instancia ?? ''));
    const unreadAttr = String(unreadNumber);
    const operadorIdAttr = escapeHtml(String(c.operador_id || ''));
    const operadorNomeAttr = escapeHtml(String(c.operador_nome || ''));
    const departamentoIdAttr = escapeHtml(String(c.departamento_id || ''));
    const participantesCountAttr = String(Number(c.participantes_count || 0) || 0);
    const minhaParticipacaoAttr = c.minha_participacao ? '1' : '0';
    const acceptedAttr = c.operador_id ? '1' : '0';
    const isNewAttr = statusValue === 'novo' ? '1' : '0';

    const filaIdAttr = escapeHtml(String(filaId || ''));
    const filaNomeAttr = escapeHtml(String(filaNome || ''));
    const filaPrioridadeAttr = escapeHtml(String(c.fila_prioridade || ''));
    const filaSlaAttr = escapeHtml(String(c.fila_sla_minutos || ''));
    const filaCorAttr = escapeHtml(String(c.fila_cor || ''));
    const filaAtivaAttr = temFila && c.fila_ativa ? '1' : '0';
    const filaExigirAceiteAttr = temFila && c.fila_exigir_aceite ? '1' : '0';

    return `
      <li class="chat-item cliente-item ${avatarColorClass}${pinClass}${isGrp ? ' is-group' : ''}${acceptedClass}${unreadClass}${newClass}${safeStatusClass}${filaClass}"
          id="chat-${escapeHtml(convKey)}"
          data-id="${escapeHtml(convKey)}"
          data-conversation-key="${escapeHtml(convKey)}"
          data-kind="${escapeHtml(kind)}"
          data-entity-id="${escapeHtml(String(entityId))}"
          data-instancia-id="${instAttr}"
          data-is-group="${grpAttr}"
          data-jid="${jidAttr}"
          data-telefone="${escapeHtml(String(c.telefone || ''))}"
          data-last-outbound="${outbound ? '1' : '0'}"
          data-last-dir="${dirStr}"
          data-status="${escapeHtml(String(statusValue || ''))}"
          data-statusatendimento="${escapeHtml(String(statusValue || ''))}"
          data-novas="${unreadAttr}"
          data-unread="${unreadAttr}"
          data-pinned="${c.pinned ? 'true' : 'false'}"
          data-fixado="${c.pinned ? 'true' : 'false'}"
          data-is-new="${isNewAttr}"
          data-is-accepted="${acceptedAttr}"
          data-operador-id="${operadorIdAttr}"
          data-operador-nome="${operadorNomeAttr}"
          data-departamento-id="${departamentoIdAttr}"
          data-participantes-count="${participantesCountAttr}"
          data-minha-participacao="${minhaParticipacaoAttr}"
          data-fila-id="${filaIdAttr}"
          data-fila-nome="${filaNomeAttr}"
          data-fila-prioridade="${filaPrioridadeAttr}"
          data-fila-sla-minutos="${filaSlaAttr}"
          data-fila-cor="${filaCorAttr}"
          data-fila-ativa="${filaAtivaAttr}"
          data-fila-exigir-aceite="${filaExigirAceiteAttr}">
        ${av}
        <div class="chat-text">
          <div class="chat-name">${escapeHtml(nome || '')}</div>
          ${filaHtml}
          <div class="chat-last">
            ${ackHtml}
            <span class="preview-text">${escapeHtml(preview)}</span>
          </div>
        </div>
        <div class="chat-meta">
          <div class="chat-time">${when}</div>
          ${badge(unreadNumber)}
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

  if (ul.__zcLastRenderedHtml === html) {
    return;
  }

  ul.__zcLastRenderedHtml = html;
  ul.innerHTML = html;

  document.dispatchEvent(new CustomEvent('lista:rendered'));

  window.dispatchEvent(new CustomEvent('zc:lista-conversas-atualizada', {
    detail: {
      items: ordenado.slice(),
      nextCursor: state.nextCursor ?? null,
    }
  }));

  (function fixBrokenAvatars() {
    ul.querySelectorAll('.avatar img').forEach((img) => {
      const src = cleanAvatarUrl(img.getAttribute('src') || '');
      const isBadSrc = !src || isBrokenAvatarUrl(src);

      const fix = () => {
        try {
          window.handleListAvatarError?.(img);
        } catch {}
      };

      try { img.addEventListener('error', fix, { once: true }); } catch {}

      if (isBadSrc) return fix();
      if (img.complete && img.naturalWidth === 0) return fix();
    });

    ul.querySelectorAll('.avatar').forEach((span) => {
      if (!span.querySelector('img, i')) {
        span.classList.add('placeholder');
        span.innerHTML = '<i class="fa fa-user-circle"></i>';
      }
    });
  })();
}

/* =========================================================
   Lista API
   ========================================================= */
function _findClienteIndex(id) {
  const wantedRaw = idKey(id);
  const wantedKey = convKeyOf(id);
  const wantedRef = convRefOf(id, null);
  const wantedEntity = wantedRef?.entityId || (/^\d+$/.test(String(wantedRaw || '')) ? String(wantedRaw) : null);
  const wantedKind = wantedRef?.kind || null;
  const wantedInst = wantedRef?.instId || null;

  const arr = Array.isArray(state.clientesCache) ? state.clientesCache : [];

  return arr.findIndex((c) => {
    const cKey = convKeyOf(c);
    if (wantedKey && idEq(cKey, wantedKey)) return true;

    const cRef = convRefOf(c, c);
    if (!wantedEntity || !cRef?.entityId) return false;
    if (String(cRef.entityId) !== String(wantedEntity)) return false;

    if (wantedKind && cRef.kind && String(cRef.kind) !== String(wantedKind)) return false;
    if (wantedInst && cRef.instId && String(cRef.instId) !== String(wantedInst)) return false;

    return true;
  });
}

function _reRender() {
  const arr = dedupeConversas(state.clientesCache || []);
  syncActiveConvs(arr, state.nextCursor ?? null);
  renderListaClientes(arr);
}

function _touchHora(c, tsLike) {
  if (!c) return false;

  const ms = tsToMillis(tsLike);
  if (!ms || !Number.isFinite(ms) || ms <= 0) return false;

  c.hora = ms;
  c.last_ts = c.last_ts ?? ms;
  return true;
}

function _touchHoraNow(c) {
  if (!c) return;
  const now = Date.now();
  c.hora = now;
  c.last_ts = now;
}

if (!window.Lista) {
  window.Lista = {
    render(data) {
      renderListaClientes(Array.isArray(data) ? data : (state.clientesCache || []));
    },

    updatePreview(clienteId, payload = {}) {
      const {
        texto,
        mensagem,
        conteudo,
        preview,
        ultima_mensagem,
        last_message,
        last_msg,

        ts,
        timestamp,
        ultima_mensagem_ts,
        last_ts,
        updated_at,

        ack,
        unreadDelta,

        novas,
        unread,
        unread_count,
        nao_lidas,
        naoLidas,
        qtd_nao_lidas,
        qtdNaoLidas,

        instancia_id,
        instance_name,
        status,
        operador_id,
        operador_nome,
        departamento_id
      } = payload || {};

      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;

      const c = state.clientesCache[idx];

      const textoFinal =
        typeof texto === 'string' ? texto :
        typeof mensagem === 'string' ? mensagem :
        typeof conteudo === 'string' ? conteudo :
        typeof preview === 'string' ? preview :
        typeof ultima_mensagem === 'string' ? ultima_mensagem :
        typeof last_message === 'string' ? last_message :
        typeof last_msg === 'string' ? last_msg :
        null;

      if (textoFinal !== null) {
        c.ultima_mensagem = textoFinal;
        c.preview = textoFinal;
        c.last_message = textoFinal;
        c.last_msg = textoFinal;
      }

      if (temValor(instancia_id)) {
        c.instancia_id = instancia_id;
        c.instancia = instancia_id;
      }

      if (instance_name) c.instance_name = instance_name;

      if (status !== undefined) {
        const st = statusNorm(status);
        c.status = st;
        c.statusatendimento = st;
        c.is_new = st === 'novo';
        c.is_waiting = st === 'aguardando';
        c.is_in_service = st === 'em_atendimento';
        c.is_paused = st === 'pausado';
        c.is_resolved = st === 'resolvido';
        c.is_transferred = st === 'transferido';
      }

      if (operador_id !== undefined) {
        c.operador_id = idKey(operador_id);
        c.is_accepted = !!c.operador_id;
      }

      if (operador_nome !== undefined) c.operador_nome = operador_nome || null;
      if (departamento_id !== undefined) c.departamento_id = idKey(departamento_id);

      applyFilaPayloadToConversation(c, payload);

      if (temValor(ack)) {
        c.last_ack = Number(ack);
        c.last_tipo = 'saida';
      }

      const unreadExplicit =
        temValor(novas) ? novas :
        temValor(unread_count) ? unread_count :
        temValor(unread) ? unread :
        temValor(nao_lidas) ? nao_lidas :
        temValor(naoLidas) ? naoLidas :
        temValor(qtd_nao_lidas) ? qtd_nao_lidas :
        temValor(qtdNaoLidas) ? qtdNaoLidas :
        null;

      if (temValor(unreadExplicit)) {
        const n = Math.max(0, Number(unreadExplicit) || 0);
        c.novas = n;
        c.unread = n;
        c.unread_count = n;
        c.nao_lidas = n;
      } else if (unreadDelta) {
        const n = Math.max(0, Number(c.novas || 0) + Number(unreadDelta || 0));
        c.novas = n;
        c.unread = n;
        c.unread_count = n;
        c.nao_lidas = n;
      }

      _touchHora(
        c,
        ts ??
        timestamp ??
        ultima_mensagem_ts ??
        last_ts ??
        updated_at
      );

      _reRender();
    },

    setAck(clienteId, ack) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;

      const c = state.clientesCache[idx];
      c.last_tipo = 'saida';

      const novo = Math.max(Number(c.last_ack || 0), Number(ack || 0));
      c.last_ack = novo;

      syncActiveConvs(state.clientesCache, state.nextCursor ?? null);
      _reRender();
    },

    setMeta(clienteId, meta = {}) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;

      const c = state.clientesCache[idx];

      if (meta.instancia_id !== undefined) {
        c.instancia_id = instKey(meta.instancia_id);
        c.instancia = c.instancia_id;
      }

      if (meta.instance_name !== undefined) {
        c.instance_name = meta.instance_name || null;
      }

      if (meta.status !== undefined) {
        const st = statusNorm(meta.status);
        c.status = st;
        c.statusatendimento = st;
        c.is_new = st === 'novo';
        c.is_waiting = st === 'aguardando';
        c.is_in_service = st === 'em_atendimento';
        c.is_paused = st === 'pausado';
        c.is_resolved = st === 'resolvido';
        c.is_transferred = st === 'transferido';
      }

      if (meta.operador_id !== undefined) {
        c.operador_id = idKey(meta.operador_id);
        c.is_accepted = !!c.operador_id;
      }

      if (meta.operador_nome !== undefined) c.operador_nome = meta.operador_nome || null;
      if (meta.departamento_id !== undefined) c.departamento_id = idKey(meta.departamento_id);
      if (meta.participantes_count !== undefined) c.participantes_count = Number(meta.participantes_count || 0) || 0;
      if (meta.minha_participacao !== undefined) c.minha_participacao = !!meta.minha_participacao;

      applyFilaPayloadToConversation(c, meta);

      _reRender();
    },

    bumpToTop(clienteId) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;

      const c = state.clientesCache[idx];
      _touchHoraNow(c);
      _reRender();
    },

    resetUnread(clienteId) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;

      const c = state.clientesCache[idx];

      c.novas = 0;
      c.unread = 0;
      c.unread_count = 0;
      c.nao_lidas = 0;

      _reRender();
    },

    setPinned(clienteId, isPinned) {
      const idx = _findClienteIndex(clienteId);
      if (idx < 0) return;

      const flag = !!isPinned;
      const alvo = state.clientesCache[idx];
      const alvoRef = convRefOf(alvo, alvo);
      const alvoKey = convKeyOf(alvo);
      const alvoEntity = alvoRef?.entityId || null;
      const alvoKind = alvoRef?.kind || null;
      const alvoInst = alvoRef?.instId || null;

      state.clientesCache = (Array.isArray(state.clientesCache) ? state.clientesCache : []).map((c) => {
        const cRef = convRefOf(c, c);

        const sameKey = alvoKey && idEq(convKeyOf(c), alvoKey);

        const sameEntity = alvoEntity && cRef?.entityId &&
          String(cRef.entityId) === String(alvoEntity) &&
          (!alvoKind || !cRef.kind || String(cRef.kind) === String(alvoKind)) &&
          (!alvoInst || !cRef.instId || String(cRef.instId) === String(alvoInst));

        if (!sameKey && !sameEntity) return c;

        return normalizeCliente({
          ...c,
          pinned: flag,
          fixado: flag,
          pin: flag,
        });
      });

      syncActiveConvs(state.clientesCache, state.nextCursor ?? null);
      _reRender();

      try {
        const safeKey = CSS.escape(String(alvoKey || ''));
        if (safeKey) {
          const li = document.querySelector(`li.chat-item[data-id="${safeKey}"]`);
          if (li) {
            li.classList.toggle('is-pinned', flag);
            li.classList.toggle('pinned', flag);
            li.dataset.pinned = flag ? 'true' : 'false';
            li.dataset.fixado = flag ? 'true' : 'false';
          }
        }
      } catch {}
    }
  };
}

/* =========================================================
   Booster leve de preview + ACK
   ========================================================= */
(function () {
  'use strict';

  function updatePreviewInline(clienteId, payload = {}) {
    const {
      texto,
      mensagem,
      conteudo,
      preview,
      ultima_mensagem,
      last_message,
      last_msg,

      ack,

      ts,
      timestamp,
      ultima_mensagem_ts,
      last_ts,
      updated_at,

      unreadDelta,

      novas,
      unread,
      unread_count,
      nao_lidas,
      naoLidas,
      qtd_nao_lidas,
      qtdNaoLidas,

      status,
      operador_id,
      operador_nome,
      departamento_id
    } = payload || {};

    const id = String(convKeyOf(clienteId) || '');
    if (!id) return;

    const li = document.querySelector(`li.chat-item[data-id="${CSS.escape(id)}"]`);
    if (!li) return;

    const textoFinal =
      typeof texto === 'string' ? texto :
      typeof mensagem === 'string' ? mensagem :
      typeof conteudo === 'string' ? conteudo :
      typeof preview === 'string' ? preview :
      typeof ultima_mensagem === 'string' ? ultima_mensagem :
      typeof last_message === 'string' ? last_message :
      typeof last_msg === 'string' ? last_msg :
      null;

    if (textoFinal !== null) {
      const previewEl = li.querySelector('.preview-text');
      if (previewEl) previewEl.textContent = textoFinal;
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

    const tsFinal =
      ts ??
      timestamp ??
      ultima_mensagem_ts ??
      last_ts ??
      updated_at;

    if (tsFinal !== undefined && tsFinal !== null && tsFinal !== '') {
      const el = li.querySelector('.chat-time, time');
      if (el) {
        const txt = formatChatTime(tsFinal);
        if (txt) el.textContent = txt;
      }
    }

    const unreadExplicit =
      temValor(novas) ? novas :
      temValor(unread_count) ? unread_count :
      temValor(unread) ? unread :
      temValor(nao_lidas) ? nao_lidas :
      temValor(naoLidas) ? naoLidas :
      temValor(qtd_nao_lidas) ? qtd_nao_lidas :
      temValor(qtdNaoLidas) ? qtdNaoLidas :
      null;

    let finalUnread = null;

    if (temValor(unreadExplicit)) {
      finalUnread = Math.max(0, Number(unreadExplicit) || 0);
    } else if (unreadDelta) {
      finalUnread = Math.max(0, Number(li.dataset.novas || 0) + Number(unreadDelta || 0));
    }

    if (finalUnread !== null) {
      let badgeEl = li.querySelector('.badge, .unread, .unread-badge, .conv-badge, .wpp-badge');

      if (finalUnread > 0 && !badgeEl) {
        const meta = li.querySelector('.chat-meta') || li;
        badgeEl = document.createElement('span');
        badgeEl.className = 'badge';
        meta.appendChild(badgeEl);
      }

      if (badgeEl) {
        badgeEl.textContent = String(finalUnread);
        badgeEl.hidden = finalUnread <= 0;
        badgeEl.style.display = finalUnread > 0 ? '' : 'none';
      }

      li.dataset.novas = String(finalUnread);
      li.dataset.unread = String(finalUnread);
      li.dataset.isUnread = finalUnread > 0 ? '1' : '0';
      li.classList.toggle('has-unread', finalUnread > 0);
    }

    if (status !== undefined) {
      const st = statusNorm(status) || '';
      li.dataset.status = st;
      li.dataset.statusatendimento = st;
      li.dataset.isNew = st === 'novo' ? '1' : '0';
      li.classList.toggle('is-new', st === 'novo');
    }

    if (operador_id !== undefined) {
      const opId = idKey(operador_id) || '';
      li.dataset.operadorId = opId;
      li.dataset.isAccepted = opId ? '1' : '0';
      li.classList.toggle('is-accepted', !!opId);
    }

    if (operador_nome !== undefined) {
      li.dataset.operadorNome = String(operador_nome || '');
    }

    if (departamento_id !== undefined) {
      li.dataset.departamentoId = String(departamento_id || '');
    }

    updateFilaInline(li, payload || {});
  }

  function setAckInline(clienteId, ack) {
    updatePreviewInline(clienteId, { ack });
  }

  const L = (window.Lista = window.Lista || {});
  const prevUpdate = typeof L.updatePreview === 'function' ? L.updatePreview.bind(L) : null;
  const prevSetAck = typeof L.setAck === 'function' ? L.setAck.bind(L) : null;
  const prevSetMeta = typeof L.setMeta === 'function' ? L.setMeta.bind(L) : null;

  L.updatePreview = function (cid, payload) {
    try { updatePreviewInline(cid, payload || {}); } catch {}
    return prevUpdate ? prevUpdate(cid, payload) : undefined;
  };

  L.setAck = function (cid, ack) {
    try { setAckInline(cid, ack); } catch {}
    return prevSetAck ? prevSetAck(cid, ack) : undefined;
  };

  L.setMeta = function (cid, meta) {
    try { updatePreviewInline(cid, meta || {}); } catch {}
    return prevSetMeta ? prevSetMeta(cid, meta) : undefined;
  };
})();

/* =========================================================
   Exports / globals
   ========================================================= */
syncLegacyRefs();

try {
  window.renderListaClientes = renderListaClientes;
  window.carregarClientes = carregarClientes;
  window.loadMoreConversas = loadMoreConversas;
  window.scheduleCarregarClientes = scheduleCarregarClientes;
} catch {}