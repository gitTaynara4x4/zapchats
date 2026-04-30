// /frontend/js/atendimentos/boot/init.js

import { state, persist, setClienteSel } from '../state/store.js';
import { EMPRESA_ID } from '../core/env.js';
import { carregarClientes } from '../domain/clientes.js';
import { salvarNoCache, renderHistoricoDoCache } from '../domain/historico.js';

// Base unificada de histórico local
import { getHist } from '../domain/hist-cache.js';
import { abrirPerfilAtual } from '../ui/perfil.js';

// ====== Flag global: esconder banner do topo (Operadora: …) ======
window.SHOW_TOP_OPERATOR_BANNER = false;

// ====== TRAVA: exige instância resolvida para operar (abrir/enviar) ======
window.ZC_REQUIRE_INSTANCE = true;

/*
  Otimizações deste arquivo:
  - não reabre/recarrega a mesma conversa em loop;
  - não faz GET de mensagens duplicado se já tem uma chamada em andamento;
  - não faz POST seen repetido;
  - mantém comportamento tipo WhatsApp: mensagem nova continua chegando por WS/eventos;
  - não bloqueia atualização em tempo real, só corta repetição inútil.

  REGRA CRÍTICA:
  - conversation_key NUNCA pode ser c:<id>:0 ou g:<id>:0.
  - conversa só é a mesma se bater tipo + entidade + instância.
  - mesmo telefone/cliente em outra instância é OUTRA conversa.
*/
const ZC_SELECT_SAME_CONV_COOLDOWN_MS = 900;
const ZC_MESSAGE_LOAD_TTL_MS = 1800;
const ZC_SEEN_TTL_MS = 6000;
const ZC_SEEN_DEBOUNCE_MS = 900;

const __msgLoadState = new Map(); // key -> { at, promise }
const __seenState = new Map(); // key -> { at, promise, timer }
const __selectState = {
  lastKey: '',
  lastAt: 0,
};

/* ================= ID / REF helpers (string-first) ================= */
function normStr(v) {
  return String(v ?? '').trim();
}

function idKey(v) {
  const s = normStr(v);
  if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
  return s;
}

function instKey(v) {
  const s = normStr(v);
  if (!s) return null;

  const low = s.toLowerCase();
  if (
    low === 'null' ||
    low === 'undefined' ||
    low === 'nan' ||
    low === '0' ||
    low === 'all' ||
    low === '*' ||
    low === '-'
  ) {
    return null;
  }

  return s;
}

function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}

function mergeDefined(base = {}, override = {}) {
  const out = { ...(base || {}) };

  Object.entries(override || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'string' && v.trim() === '') return;
    out[k] = v;
  });

  return out;
}

function getInstanciasList() {
  try {
    const candidates = [
      window.ZC_INSTANCIAS,
      window.INSTANCIAS,
      window.instancias,
      window.state?.instancias,
      state?.instancias,
    ];

    for (const c of candidates) {
      if (Array.isArray(c)) return c;
    }
  } catch {}

  return [];
}

function instanciaValues(row) {
  if (!row || typeof row !== 'object') return [];

  return [
    row.id,
    row.instancia_id,
    row.instanciaId,
    row.instance_id,
    row.instanceId,
    row.instancia,
    row.instance,
    row.instance_name,
    row.instanceName,
    row.nome,
    row.slug,
  ]
    .map(instKey)
    .filter(Boolean);
}

/*
  Comparação de instância com segurança:
  - aceita igual literal;
  - aceita id/nome se estiverem na mesma linha de instância conhecida;
  - nunca aceita quando um dos lados está vazio.
*/
function sameInstStrict(a, b) {
  const A = instKey(a);
  const B = instKey(b);

  if (!A || !B) return false;
  if (A === B) return true;

  const list = getInstanciasList();

  for (const row of list) {
    const vals = instanciaValues(row);
    if (vals.includes(A) && vals.includes(B)) return true;
  }

  return false;
}

function inferKindFromRow(row = null) {
  const explicit =
    row?.kind ??
    row?.conversation_kind ??
    row?.tipo_conversa ??
    row?.tipo_ref ??
    row?.tipo ??
    null;

  const exp = normStr(explicit).toLowerCase();
  if (exp === 'c' || exp === 'contato' || exp === 'cliente') return 'c';
  if (exp === 'g' || exp === 'grupo' || exp === 'group') return 'g';

  if (
    row?.grupo_id != null ||
    row?.grupoId != null ||
    row?.group_id != null ||
    row?.groupId != null ||
    row?.is_group === true ||
    row?.isGroup === true ||
    row?.grupo === true
  ) {
    return 'g';
  }

  return 'c';
}

function inferEntityIdFromRow(row = null) {
  const kind = inferKindFromRow(row);

  const raw =
    row?.entity_id ??
    row?.entityId ??
    row?.backend_id ??
    row?.backendClienteId ??
    row?.id_backend ??
    row?.conversation_entity_id ??
    row?.conversationEntityId ??
    (kind === 'g'
      ? (
          row?.grupo_id ??
          row?.grupoId ??
          row?.group_id ??
          row?.groupId ??
          null
        )
      : (
          row?.cliente_id ??
          row?.clienteId ??
          row?.id_cliente ??
          row?.idCliente ??
          row?.cid ??
          null
        ));

  const s = idKey(raw);
  if (s && /^\d+$/.test(s)) return s;

  const fallbackRaw =
    row?.api_id ??
    row?.apiClienteId ??
    row?.id_api ??
    row?.id ??
    null;

  const f = idKey(fallbackRaw);
  if (f && /^\d+$/.test(f)) return f;

  return null;
}

function inferInstIdFromRow(row = null) {
  return (
    instKey(row?.instancia_id) ||
    instKey(row?.instanciaId) ||
    instKey(row?.instancia) ||
    instKey(row?.instance_id) ||
    instKey(row?.instanceId) ||
    instKey(row?.instance) ||
    instKey(row?.instance_name) ||
    instKey(row?.instanceName) ||
    instKey(row?.session) ||
    instKey(row?.sessionName) ||
    null
  );
}

/*
  CRÍTICO:
  Nunca monta c:<id>:0.
  Sem instância, retorna null.
*/
function buildConversationKey(kind, entityId, instId) {
  const k = String(kind || '').toLowerCase() === 'g' ? 'g' : 'c';
  const eid = idKey(entityId);
  const iid = instKey(instId);

  if (!eid || !iid) return null;

  return `${k}:${eid}:${iid}`;
}

function rawConversationCandidate(input) {
  if (input && typeof input === 'object') {
    return (
      input.conversation_key ??
      input.conversationKey ??
      input.conversation_id ??
      input.conversationId ??
      input.conv_key ??
      input.convKey ??
      input.id ??
      input.cliente_id ??
      input.clienteId ??
      input.grupo_id ??
      input.grupoId ??
      null
    );
  }

  return input;
}

function parseConversationRef(raw, row = null) {
  if (raw && typeof raw === 'object' && !row) {
    row = raw;
    raw = rawConversationCandidate(raw);
  }

  const rawStr = normStr(raw);

  const fromRowKey =
    idKey(row?.conversation_key) ||
    idKey(row?.conversationKey) ||
    idKey(row?.conversation_id) ||
    idKey(row?.conversationId) ||
    idKey(row?.conv_key) ||
    idKey(row?.convKey) ||
    (idKey(row?.id) && /^[cg]:\d+:[^:]+$/i.test(String(row.id)) ? idKey(row.id) : null) ||
    null;

  const source = rawStr || fromRowKey || '';

  const composed = source.match(/^([cg]):(\d+):([^:]+)$/i);
  if (composed) {
    return {
      key: `${composed[1].toLowerCase()}:${composed[2]}:${composed[3]}`,
      kind: composed[1].toLowerCase(),
      entityId: composed[2],
      instId: instKey(composed[3]),
    };
  }

  const rowKind = inferKindFromRow(row);
  const rowEntityId = inferEntityIdFromRow(row);
  const rowInstId = inferInstIdFromRow(row);

  if (rowEntityId) {
    const key = buildConversationKey(rowKind, rowEntityId, rowInstId);

    return {
      key,
      kind: rowKind,
      entityId: rowEntityId,
      instId: rowInstId,
    };
  }

  if (/^\d+$/.test(source)) {
    const key = buildConversationKey(rowKind || 'c', source, rowInstId);

    return {
      key,
      kind: rowKind || 'c',
      entityId: source,
      instId: rowInstId,
    };
  }

  return {
    key: null,
    kind: rowKind || null,
    entityId: rowEntityId || null,
    instId: rowInstId || null,
  };
}

function convKeyOf(row) {
  return parseConversationRef(
    row?.conversation_key ??
    row?.conversationKey ??
    row?.conversation_id ??
    row?.conversationId ??
    row?.conv_key ??
    row?.convKey ??
    row?.id ??
    row?.cliente_id ??
    row?.clienteId ??
    row?.grupo_id ??
    row?.grupoId ??
    null,
    row
  ).key;
}

function entityIdOf(row) {
  return parseConversationRef(
    row?.conversation_key ??
    row?.conversationKey ??
    row?.conversation_id ??
    row?.conversationId ??
    row?.conv_key ??
    row?.convKey ??
    row?.id ??
    row?.cliente_id ??
    row?.clienteId ??
    row?.grupo_id ??
    row?.grupoId ??
    null,
    row
  ).entityId;
}

function kindOf(row) {
  return parseConversationRef(
    row?.conversation_key ??
    row?.conversationKey ??
    row?.conversation_id ??
    row?.conversationId ??
    row?.conv_key ??
    row?.convKey ??
    row?.id ??
    row?.cliente_id ??
    row?.clienteId ??
    row?.grupo_id ??
    row?.grupoId ??
    null,
    row
  ).kind;
}

function sameConversation(a, b) {
  const A = parseConversationRef(a, typeof a === 'object' ? a : null);
  const B = parseConversationRef(b, typeof b === 'object' ? b : null);

  if (!A?.kind || !A?.entityId || !A?.instId) return false;
  if (!B?.kind || !B?.entityId || !B?.instId) return false;

  if (String(A.kind) !== String(B.kind)) return false;
  if (String(A.entityId) !== String(B.entityId)) return false;

  return sameInstStrict(A.instId, B.instId);
}

function allConversationPools() {
  const out = [];

  try {
    if (Array.isArray(state?.clientesCache)) out.push(...state.clientesCache);
  } catch {}

  try {
    if (Array.isArray(state?.todosContatosCache)) out.push(...state.todosContatosCache);
  } catch {}

  try {
    const byInst = state?.convsByInst || {};
    Object.values(byInst).forEach((box) => {
      const items = Array.isArray(box?.items) ? box.items : [];
      out.push(...items);
    });
  } catch {}

  try {
    if (Array.isArray(window.__zcListaConversas)) out.push(...window.__zcListaConversas);
  } catch {}

  return out.filter(Boolean);
}

function findConversation(raw) {
  const rawObj = raw && typeof raw === 'object' ? raw : null;
  const ref = parseConversationRef(rawObj || raw, rawObj);
  const pools = allConversationPools();

  if (ref.key) {
    const byKey = pools.find((x) => convKeyOf(x) === ref.key);
    if (byKey) return byKey;
  }

  /*
    CRÍTICO:
    Só casa por entityId quando a instância também está resolvida.
    Nunca aceita "mesmo cliente" sem instância.
  */
  if (ref.entityId && ref.instId) {
    const byEntityInst = pools.find((x) => {
      const xr = parseConversationRef(convKeyOf(x), x);

      if (!xr.entityId || !xr.instId) return false;
      if (String(xr.entityId) !== String(ref.entityId)) return false;
      if ((xr.kind || 'c') !== (ref.kind || 'c')) return false;

      return sameInstStrict(xr.instId, ref.instId);
    });

    if (byEntityInst) return byEntityInst;
  }

  return null;
}

function setConversationDatasets(target, ref) {
  if (!target || !ref) return;

  target.dataset.conversationKey = String(ref.key || '');
  target.dataset.conversationId = String(ref.key || '');
  target.dataset.convKey = String(ref.key || '');
  target.dataset.kind = String(ref.kind || '');
  target.dataset.entityId = String(ref.entityId || '');
  target.dataset.isGroup = ref.kind === 'g' ? 'true' : 'false';

  if (ref.instId) target.dataset.instanciaId = String(ref.instId);
  else target.removeAttribute('data-instancia-id');

  // compat legado:
  // - data-conversation-key guarda c:<id>:<instância> / g:<id>:<instância>
  // - data-cliente-id continua numérico para módulos antigos (IA, perfil, notas etc.)
  target.dataset.clienteId = String(ref.entityId || '');
  target.dataset.apiClienteId = String(ref.entityId || '');

  if (ref.kind === 'c' && ref.entityId) {
    target.dataset.backendClienteId = String(ref.entityId);
    target.removeAttribute('data-grupo-id');
  } else if (ref.kind === 'g' && ref.entityId) {
    target.dataset.grupoId = String(ref.entityId);
    target.removeAttribute('data-backend-cliente-id');
  } else {
    target.removeAttribute('data-backend-cliente-id');
    target.removeAttribute('data-grupo-id');
  }
}

function clearConversationDatasets(target) {
  if (!target) return;
  target.removeAttribute('data-conversation-key');
  target.removeAttribute('data-conversation-id');
  target.removeAttribute('data-conv-key');
  target.removeAttribute('data-kind');
  target.removeAttribute('data-entity-id');
  target.removeAttribute('data-is-group');
  target.removeAttribute('data-grupo-id');
  target.removeAttribute('data-instancia-id');

  // compat legado
  target.removeAttribute('data-cliente-id');
  target.removeAttribute('data-api-cliente-id');
  target.removeAttribute('data-backend-cliente-id');
}

function getOpenConversationKey() {
  const hist = document.getElementById('historico');

  return (
    hist?.dataset?.conversationKey ||
    hist?.dataset?.conversationId ||
    hist?.dataset?.convKey ||
    ''
  );
}

function isConversationOpen(convKey) {
  if (!convKey) return false;

  const hist = document.getElementById('historico');
  const head = document.getElementById('chat-header');

  const openKey = getOpenConversationKey();

  return (
    openKey === convKey &&
    hist &&
    hist.style.display !== 'none' &&
    head &&
    head.style.display !== 'none'
  );
}

/* ================= Helpers (Toast simples) ================= */
function toast(msg, ok = true) {
  let t = document.getElementById('__app_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '__app_toast';
    document.body.appendChild(t);
  }

  t.textContent = String(msg || '');
  t.classList.remove('is-error');
  if (!ok) t.classList.add('is-error');

  t.classList.add('on');
  clearTimeout(t.__timer);
  t.__timer = setTimeout(() => {
    t.classList.remove('on');
  }, 1700);
}

/* ================= Helpers de prontidão (Splash) ================= */
function readyPart(key) {
  if (window.AppReady && typeof window.AppReady.mark === 'function') {
    window.AppReady.mark(key);
  } else {
    window.dispatchEvent(new CustomEvent('ready:part', { detail: key }));
  }
}

/* ================= OperatorLine (banner “Operadora: …”) ================= */
(function () {
  const SELECTORS = ['#historico', '.chat-history', '.mensagens', '#mensagens', '#history'];

  function findHistoryContainer() {
    for (const s of SELECTORS) {
      const n = document.querySelector(s);
      if (n) return n;
    }
    return null;
  }

  function ensureHeadline() {
    let el = document.getElementById('op-headline');
    if (el) return el;

    el = document.createElement('div');
    el.id = 'op-headline';
    el.className = 'op-headline';
    el.hidden = true;

    const hist = findHistoryContainer();
    if (hist && hist.parentNode) {
      hist.parentNode.insertBefore(el, hist);
    } else {
      document.body.prepend(el);
      const mo = new MutationObserver(() => {
        const h = findHistoryContainer();
        const cur = document.getElementById('op-headline');
        if (h && h.parentNode && cur && cur.parentNode !== h.parentNode) {
          h.parentNode.insertBefore(cur, h);
          mo.disconnect();
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
    return el;
  }

  function getUserName() {
    const w = window;
    const LS = w.localStorage || {};
    return (
      w.Auth?.user?.nome ||
      w.CURRENT_USER?.nome ||
      LS.getItem('user_nome') ||
      'Operadora'
    );
  }

  const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 180);

  const fmtTime = (iso) => {
    try {
      const d = iso ? new Date(iso) : new Date();
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  function deriveName(meta) {
    if (meta && meta.origem === 'whatsapp_fisico') return 'WhatsApp físico';
    if (meta && meta.autor_nome) return meta.autor_nome;
    return getUserName();
  }

  function setOpHeadline(text, whenISO, meta) {
    if (window.SHOW_TOP_OPERATOR_BANNER === false) return;
    const box = ensureHeadline();
    const preview = normalize(text);
    if (!preview) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    const nome = deriveName(meta || {});
    const time = whenISO ? `<small>${fmtTime(whenISO)}</small>` : '';
    box.innerHTML = `${nome}: ${preview} ${time}`;
    box.hidden = false;
  }

  function clearOpHeadline() {
    const box = document.getElementById('op-headline');
    if (box) {
      box.hidden = true;
      box.textContent = '';
    }
  }

  window.OperatorLine = {
    set: setOpHeadline,
    clear: clearOpHeadline,
    getName: getUserName,
  };
})();

/* ================= Utils ================= */

async function markChatAsSeenNow(conversationRef, row = null, { force = false } = {}) {
  try {
    const ref = parseConversationRef(conversationRef, row);

    // endpoint é de CLIENTE, então grupo não entra aqui
    if (ref.kind !== 'c' || !ref.entityId || !ref.instId) return;

    const convKey = ref.key || buildConversationKey('c', ref.entityId, ref.instId);
    if (!convKey) return;

    // Só marca visto se a conversa ainda estiver aberta.
    // Isso evita seen em conversa que já foi trocada.
    if (!isConversationOpen(convKey)) return;

    const now = Date.now();
    const old = __seenState.get(convKey);

    if (!force && old?.at && now - old.at < ZC_SEEN_TTL_MS) {
      return old.promise || null;
    }

    if (!force && old?.promise) {
      return old.promise;
    }

    const url =
      `/api/atendimento/clientes/${encodeURIComponent(ref.entityId)}/seen` +
      `?empresa_id=${encodeURIComponent(String(EMPRESA_ID))}`;

    const promise = fetch(url, {
      method: 'POST',
      credentials: 'include',
    })
      .catch(() => null)
      .finally(() => {
        const cur = __seenState.get(convKey);
        if (cur) {
          cur.at = Date.now();
          cur.promise = null;
          __seenState.set(convKey, cur);
        }
      });

    __seenState.set(convKey, {
      ...(old || {}),
      at: now,
      promise,
      timer: old?.timer || null,
    });

    return promise;
  } catch {
    return null;
  }
}

function scheduleMarkChatAsSeen(conversationRef, row = null, { delay = ZC_SEEN_DEBOUNCE_MS, force = false } = {}) {
  try {
    const ref = parseConversationRef(conversationRef, row);
    if (ref.kind !== 'c' || !ref.entityId || !ref.instId) return;

    const convKey = ref.key || buildConversationKey('c', ref.entityId, ref.instId);
    if (!convKey) return;

    const old = __seenState.get(convKey) || {};
    if (old.timer) clearTimeout(old.timer);

    const timer = setTimeout(() => {
      const cur = __seenState.get(convKey) || {};
      cur.timer = null;
      __seenState.set(convKey, cur);
      markChatAsSeenNow(convKey, row, { force });
    }, delay);

    __seenState.set(convKey, {
      ...old,
      timer,
    });
  } catch {}
}

// Compat: mantém nome antigo para outros arquivos que possam chamar
async function markChatAsSeen(conversationRef, row = null) {
  return markChatAsSeenNow(conversationRef, row);
}

function closeChatMobile() {
  if (!window.matchMedia('(max-width: 920px)').matches) return;

  const ws = document.getElementById('welcome-screen');
  const head = document.getElementById('chat-header');
  const hist = document.getElementById('historico');
  const foot = document.getElementById('chat-footer');

  if (head) head.style.display = 'none';
  if (hist) {
    hist.style.display = 'none';
    hist.innerHTML = '';
    clearConversationDatasets(hist);
    hist.removeAttribute('data-telefone');
  }
  if (head) {
    clearConversationDatasets(head);
    head.removeAttribute('data-phone');
  }
  if (foot) foot.style.display = 'none';
  if (ws) ws.style.display = 'none';

  document.body.classList.remove('is-chat-open');
}

/* ===== Helpers de instância ===== */
function getInstanciaForFetch(conversationRef) {
  const ref = parseConversationRef(conversationRef);
  const sel = state?.clienteSel;

  if (sel && convKeyOf(sel) === ref.key) {
    const cand =
      instKey(sel.instancia_id) ||
      instKey(sel.instanciaId) ||
      instKey(sel.instancia) ||
      instKey(sel.instance_id) ||
      instKey(sel.instanceId) ||
      instKey(sel.instance) ||
      instKey(sel.instance_name) ||
      instKey(sel.instanceName) ||
      ref.instId ||
      null;

    return cand;
  }

  const c = findConversation(ref.key || conversationRef);
  const cand =
    instKey(c?.instancia_id) ||
    instKey(c?.instanciaId) ||
    instKey(c?.instancia) ||
    instKey(c?.instance_id) ||
    instKey(c?.instanceId) ||
    instKey(c?.instance) ||
    instKey(c?.instance_name) ||
    instKey(c?.instanceName) ||
    ref.instId ||
    null;

  return cand;
}

function syncInstanciaFromCliente(c) {
  const ref = parseConversationRef(c);

  const instCand =
    instKey(c?.instancia_id) ||
    instKey(c?.instanciaId) ||
    instKey(c?.instancia) ||
    instKey(c?.instance_id) ||
    instKey(c?.instanceId) ||
    instKey(c?.instance) ||
    instKey(c?.instance_name) ||
    instKey(c?.instanceName) ||
    ref.instId ||
    null;

  if (instCand) {
    try {
      window.setInstanciaAtiva?.(String(instCand), { reloadList: false });
    } catch {}
    return String(instCand);
  }

  return null;
}

/* ============ Carregar mensagens com trava anti-duplicação ============ */
async function ensureMensagensCarregadas(conversationRef, opts = {}) {
  const force = Boolean(opts.force);

  if (!state.mensagensOffset || typeof state.mensagensOffset !== 'object') {
    state.mensagensOffset = {};
  }

  const row = state?.clienteSel || findConversation(conversationRef) || null;
  const ref = parseConversationRef(conversationRef, row);
  const convKey = ref.key;
  const entityId = ref.entityId;

  if (!entityId) {
    throw new Error('Conversa inválida');
  }

  const inst = getInstanciaForFetch(convKey) || ref.instId;

  // TRAVA: não carrega conversa “no escuro”
  if (window.ZC_REQUIRE_INSTANCE === true && !inst) {
    try {
      window.zcUpdateInstBadge?.();
      window.zcFlashInstBadge?.();
    } catch {}
    toast('Selecione um WhatsApp (instância) antes de abrir/enviar.', false);
    throw new Error('Instância não resolvida');
  }

  const finalConvKey = convKey || buildConversationKey(ref.kind, entityId, inst);
  if (!finalConvKey) {
    toast('Conversa sem instância válida.', false);
    throw new Error('conversation_key inválida');
  }

  const loadKey = `${finalConvKey}|${inst || ''}`;
  const now = Date.now();
  const previous = __msgLoadState.get(loadKey);

  if (!force && previous?.promise) {
    return previous.promise;
  }

  if (!force && previous?.at && now - previous.at < ZC_MESSAGE_LOAD_TTL_MS) {
    const cachedHist = getHist(inst, finalConvKey) || [];
    if (cachedHist.length) return cachedHist;
  }

  const promise = (async () => {
    const qs = new URLSearchParams({
      empresa_id: String(EMPRESA_ID),
      limit: '50',
    });

    if (inst) {
      const s = String(inst);
      if (/^\d+$/.test(s)) qs.set('instancia_id', s);
      else qs.set('instance', s);
    }

    const url = `/api/atendimento/conversas/${encodeURIComponent(entityId)}/mensagens?${qs.toString()}`;

    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`Falha ao carregar mensagens (${r.status})`);
    const data = await r.json();

    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.results)
            ? data.results
            : [];

    const mapped = items.map((m) => {
      const tipoMsg = m.tipo || (m.remetente === 'agente' ? 'saida' : 'entrada');
      const isSaida = tipoMsg === 'saida' || m.from_me === true || m.origem === 'atendente';

      let ackNum = Number(m.ack ?? m.status ?? m.ack_status ?? m.meta?.ack ?? 0);
      if (!Number.isFinite(ackNum)) ackNum = 0;
      ackNum = Math.min(3, Math.max(0, ackNum));

      const rawTs =
        m.ts ??
        m.timestamp ??
        m.data ??
        m.created_at ??
        m.hora ??
        null;

      const out = {
        msg_id: m.msg_id || m.id || null,
        conteudo: m.texto ?? m.conteudo ?? m.mensagem ?? '',
        tipo: tipoMsg,
        timestamp: rawTs || null,
        ack: isSaida ? ackNum : null,
        midias: Array.isArray(m.midias) ? m.midias : [],
        instancia_id: m.instancia_id ?? (inst || null),
        origem: m.origem ?? (isSaida ? 'atendente' : 'cliente'),
        autor_nome: m.autor_nome ?? m.atendente_nome ?? m.user_nome ?? null,
        apagada_cliente: Boolean(m.apagada_cliente ?? m.apagadaCliente ?? false),
        apagada_usuario: Boolean(m.apagada_usuario ?? m.apagadaUsuario ?? false),
      };

      const quoted =
        m.quoted ??
        m.quote ??
        m.quotedMessage ??
        m.quoted_message ??
        null;

      const quotedPreview =
        m.quoted_preview ??
        m.quotedPreview ??
        m.reply_preview ??
        m.replyPreview ??
        null;

      if (quoted && typeof quoted === 'object') out.quoted = quoted;
      if (quotedPreview && typeof quotedPreview === 'object') out.quoted_preview = quotedPreview;

      return out;
    });

    try {
      salvarNoCache(finalConvKey, mapped);
    } catch {}

    const finalHist = getHist(inst, finalConvKey) || [];

    state.cacheHistoricos = {
      ...(state.cacheHistoricos || {}),
      [finalConvKey]: (window.cacheHistoricos || {})[finalConvKey],
    };

    state.mensagensOffset[finalConvKey] = finalHist.length;
    persist();

    return finalHist;
  })();

  __msgLoadState.set(loadKey, {
    at: now,
    promise,
  });

  try {
    const result = await promise;
    __msgLoadState.set(loadKey, {
      at: Date.now(),
      promise: null,
    });
    return result;
  } catch (e) {
    __msgLoadState.delete(loadKey);
    throw e;
  }
}

/* ======= Atualiza banner com a última saída ======= */
function updateOperatorBannerForConversation(conversationRef) {
  if (window.SHOW_TOP_OPERATOR_BANNER === false) return;

  try {
    const ref = parseConversationRef(conversationRef);
    const convKey = ref.key;
    const inst = getInstanciaForFetch(convKey);
    const arr = getHist(inst, convKey) || ((window.cacheHistoricos || {})[convKey] || []);

    const lastOut = [...arr].reverse().find(
      (m) => m?.tipo === 'saida' || m?.from_me === true || m?.origem === 'atendente'
    );

    if (lastOut) {
      const texto = lastOut.conteudo || lastOut.texto || lastOut.mensagem || '';
      const ts = lastOut.timestamp || lastOut.ts || null;
      const meta = {
        origem: lastOut.origem
          ? lastOut.origem
          : lastOut.tipo === 'saida' || lastOut.from_me === true
            ? 'atendente'
            : 'cliente',
        autor_nome:
          lastOut.autor_nome || lastOut.atendente_nome || lastOut.user_nome || null,
      };
      window.OperatorLine?.set(texto, ts, meta);
    } else {
      window.OperatorLine?.clear();
    }
  } catch {}
}

/* ================= Avatar fallback anti-404 ================= */
(function ensureAvatar404Guard() {
  if (window.__ZC_AVATAR_404_GUARD__) return;
  window.__ZC_AVATAR_404_GUARD__ = true;

  const broken = new Set();

  window.handleAvatarError = function handleAvatarError(img) {
    try {
      if (!img) return;

      const src = img.getAttribute('src') || '';
      if (src) broken.add(src);

      const wrap = img.closest('.avatar') || img.parentElement;
      if (wrap) {
        wrap.classList.add('avatar-default');
        wrap.innerHTML = '<i class="fa fa-user-circle text-2xl text-gray-400"></i>';
      } else {
        img.removeAttribute('src');
        img.style.display = 'none';
      }
    } catch {}
  };

  window.zcAvatarBroken = function zcAvatarBroken(url) {
    if (!url) return false;
    return broken.has(String(url));
  };
})();

/* ================= Seleção de cliente + preparo da UI ================= */
let selecionarClienteSeq = 0;

async function selecionarClienteObj(id, opts = {}) {
  const mySeq = ++selecionarClienteSeq;
  const forceReload = Boolean(opts?.forceReload || opts?.force || opts?.reload);

  const inputObj = id && typeof id === 'object' ? id : null;
  const rawInput =
    rawConversationCandidate(inputObj || id) ??
    idKey(id) ??
    String(id ?? '').trim();

  const found = findConversation(inputObj || rawInput);
  const c = inputObj
    ? mergeDefined(found || {}, inputObj)
    : found;

  if (!c) {
    try {
      window.zcUpdateInstBadge?.();
    } catch {}
    toast('Não consegui localizar essa conversa.', false);
    return;
  }

  let ref = parseConversationRef(rawInput, c);

  let instFinal =
    inferInstIdFromRow(c) ||
    ref.instId ||
    null;

  if (!instFinal) {
    try {
      window.zcUpdateInstBadge?.();
      window.zcFlashInstBadge?.();
    } catch {}
    toast('Conversa sem instância válida.', false);
    return;
  }

  const fixedKey = buildConversationKey(ref.kind, ref.entityId, instFinal);

  ref = {
    ...ref,
    key: fixedKey,
    instId: instFinal,
  };

  const convKey = ref.key;

  if (!ref.entityId || !convKey) {
    toast('Conversa inválida.', false);
    return;
  }

  const now = Date.now();
  const alreadyOpen = isConversationOpen(convKey);
  const repeatedSameSelection =
    alreadyOpen &&
    __selectState.lastKey === convKey &&
    now - __selectState.lastAt < ZC_SELECT_SAME_CONV_COOLDOWN_MS;

  __selectState.lastKey = convKey;
  __selectState.lastAt = now;

  const isMobile = window.matchMedia('(max-width: 920px)').matches;
  const hist = document.getElementById('historico');
  const ws = document.getElementById('welcome-screen');
  const head = document.getElementById('chat-header');
  const foot = document.getElementById('chat-footer');

  if (repeatedSameSelection && !forceReload) {
    scheduleMarkChatAsSeen(convKey, c);

    try {
      window.dispatchEvent(
        new CustomEvent('zc:conversation-selected', {
          detail: {
            conversation_key: convKey,
            conversation_id: convKey,
            kind: ref.kind,
            entity_id: ref.entityId,
            instancia_id: ref.instId,
            cliente: c,
            repeated: true,
          },
        })
      );
    } catch {}

    return;
  }

  if (hist) {
    if (!alreadyOpen || forceReload) {
      hist.innerHTML = '';
      hist.dataset.noMore = '0';
    }

    hist.style.display = 'block';
    setConversationDatasets(hist, ref);
  }

  if (ws) ws.style.display = 'none';

  if (head) {
    head.style.display = 'flex';
    setConversationDatasets(head, ref);
  }

  if (foot) foot.style.display = 'flex';

  readyPart('ui');

  c.conversation_key = convKey;
  c.conversation_id = convKey;

  if (ref.kind === 'c' && ref.entityId) {
    if (!c.cliente_id) c.cliente_id = ref.entityId;
    if (!c.id) c.id = ref.entityId;
  }

  if (ref.kind === 'g' && ref.entityId) {
    if (!c.grupo_id) c.grupo_id = ref.entityId;
    if (!c.id) c.id = ref.entityId;
  }

  if (ref.instId) {
    if (!c.instancia_id && /^\d+$/.test(String(ref.instId))) c.instancia_id = Number(ref.instId);
    if (!c.instancia && !/^\d+$/.test(String(ref.instId))) c.instancia = String(ref.instId);
  }

  setClienteSel(c);

  // TRAVA/SYNC de instância antes de qualquer fetch/render
  instFinal = syncInstanciaFromCliente(c) || ref.instId;

  if (hist) {
    if (instFinal) hist.dataset.instanciaId = String(instFinal);
    else hist.removeAttribute('data-instancia-id');
  }

  if (head) {
    if (instFinal) head.dataset.instanciaId = String(instFinal);
    else head.removeAttribute('data-instancia-id');
  }

  if (window.ZC_REQUIRE_INSTANCE === true && !instFinal) {
    try {
      window.zcUpdateInstBadge?.();
      window.zcFlashInstBadge?.();
    } catch {}
    toast('Selecione um WhatsApp (instância) antes de abrir/enviar.', false);
    return;
  }

  try {
    if (window.zcNotesSetContextFromCliente) {
      window.zcNotesSetContextFromCliente(c);
    } else if (head) {
      head.dataset.conversationKey = String(convKey);
      head.dataset.conversationId = String(convKey);
      head.dataset.convKey = String(convKey);

      if (ref.kind === 'c' && ref.entityId) head.dataset.clienteId = String(ref.entityId);
      else head.removeAttribute('data-cliente-id');
    }
  } catch {}

  try {
    const phone =
      c.telefone ??
      c.tel ??
      c.phone ??
      c.whatsapp ??
      c.telefone_norm ??
      c.numero ??
      c.number ??
      null;

    const digits = String(phone || '').replace(/\D+/g, '');
    if (digits) {
      if (hist) hist.dataset.telefone = digits;
      if (head) head.setAttribute('data-phone', digits);
    } else {
      if (hist) delete hist.dataset.telefone;
      if (head) head.removeAttribute('data-phone');
    }
  } catch {}

  const t = document.getElementById('chat-title');
  const av = document.getElementById('chat-avatar');

  if (t) {
    t.textContent =
      c.nome ||
      c.nome_whatsapp ||
      c.push_name ||
      c.pushName ||
      c.telefone ||
      c.phone ||
      '';
  }

  if (av) {
    const avatarUrl = c.avatar_url ? String(c.avatar_url) : '';

    if (avatarUrl && !(window.zcAvatarBroken && window.zcAvatarBroken(avatarUrl))) {
      const safeUrl = avatarUrl.replace(/"/g, '&quot;');
      av.innerHTML = `<span class="avatar"><img src="${safeUrl}" alt="" data-cliente-id="${String(ref.entityId || '')}"
           onerror="window.handleAvatarError && window.handleAvatarError(this)"></span>`;
    } else {
      av.innerHTML =
        `<span class="avatar avatar-default"><i class="fa fa-user-circle text-2xl text-gray-400"></i></span>`;
    }
  }

  try {
    const openPerfil = () => abrirPerfilAtual && abrirPerfilAtual(false);
    if (t) {
      t.style.cursor = 'pointer';
      t.onclick = openPerfil;
    }
    if (av) {
      av.style.cursor = 'pointer';
      av.onclick = openPerfil;
    }
  } catch {}

  try {
    window.zcUpdateInstBadge?.();
  } catch {}

  try {
    const cached = getHist(instFinal, convKey) || [];
    if (cached.length && !forceReload) {
      renderHistoricoDoCache(convKey);
      updateOperatorBannerForConversation(convKey);
    }
  } catch {}

  try {
    await ensureMensagensCarregadas(convKey, { force: forceReload });

    if (mySeq !== selecionarClienteSeq) return;

    const currentHistKey =
      hist?.dataset?.conversationKey ||
      hist?.dataset?.conversationId ||
      hist?.dataset?.convKey ||
      '';

    if (currentHistKey && currentHistKey !== convKey) {
      console.warn('[selecionarClienteObj] resposta antiga ignorada', {
        esperado: convKey,
        atual: currentHistKey,
      });
      return;
    }

    renderHistoricoDoCache(convKey);
  } catch (e) {
    console.warn('[selecionarClienteObj] carregar mensagens falhou:', e?.message || e);
    return;
  }

  if (!state.mensagensOffset || typeof state.mensagensOffset !== 'object') {
    state.mensagensOffset = {};
  }

  const inst = getInstanciaForFetch(convKey);
  state.mensagensOffset[convKey] = (getHist(inst, convKey) || []).length;

  updateOperatorBannerForConversation(convKey);

  try {
    window.syncPreviewFromCache?.(convKey);
  } catch {}

  scheduleMarkChatAsSeen(convKey, c);

  try {
    window.Lista?.resetUnread?.(convKey);
    window.recomputeUnread?.();
  } catch {
    try {
      const arr = window.state?.clientesCache || window.clientesCache || [];
      const idx = arr.findIndex((x) => convKeyOf(x) === convKey);
      if (idx >= 0) {
        arr[idx].novas = 0;
        arr[idx].unread_count = 0;
        arr[idx].unread = 0;
        arr[idx].nao_lidas = 0;
        arr[idx].naoLidas = 0;
        window.renderListaClientes?.(arr);
        window.recomputeUnread?.();
      }
    } catch {}
  }

  try {
    window.dispatchEvent(
      new CustomEvent('zc:conversation-selected', {
        detail: {
          conversation_key: convKey,
          conversation_id: convKey,
          kind: ref.kind,
          entity_id: ref.entityId,
          instancia_id: instFinal || ref.instId || null,
          cliente: c,
        },
      })
    );
  } catch {}

  if (isMobile) {
    document.body.classList.add('is-chat-open');
    try {
      history.pushState({ chatOpen: true, id: convKey }, '', location.href);
    } catch {}
  }
}

/* ================= Realtime: mantém seen leve sem quebrar mensagem nova ================= */
function eventDetailToConversationKey(detail = {}) {
  const raw =
    detail.conversation_key ??
    detail.conversationKey ??
    detail.conversation_id ??
    detail.conversationId ??
    detail.conv_key ??
    detail.convKey ??
    null;

  const parsed = parseConversationRef(raw, detail);
  if (parsed?.key) return parsed.key;

  const kind =
    detail.kind ??
    detail.tipo_conversa ??
    (detail.is_group ? 'g' : 'c');

  const entity =
    detail.entity_id ??
    detail.entityId ??
    detail.cliente_id ??
    detail.clienteId ??
    detail.grupo_id ??
    detail.grupoId ??
    detail.id ??
    null;

  const inst =
    detail.instancia_id ??
    detail.instanciaId ??
    detail.instance_id ??
    detail.instanceId ??
    detail.instance ??
    detail.instance_name ??
    detail.instanceName ??
    null;

  return buildConversationKey(kind, entity, inst);
}

function bindRealtimeSeenGuard() {
  if (window.__ZC_INIT_REALTIME_SEEN_BOUND__) return;
  window.__ZC_INIT_REALTIME_SEEN_BOUND__ = true;

  const handler = (ev) => {
    try {
      const detail = ev?.detail || {};
      const key = eventDetailToConversationKey(detail);
      if (!key) return;

      if (!isConversationOpen(key)) return;

      const parsed = parseConversationRef(key, detail);
      if (parsed.kind !== 'c') return;

      const tipo =
        detail.tipo ??
        detail.direction ??
        detail.origem ??
        '';

      const fromMe =
        detail.from_me === true ||
        detail.fromMe === true ||
        tipo === 'saida' ||
        tipo === 'out' ||
        tipo === 'atendente';

      if (!fromMe) {
        scheduleMarkChatAsSeen(key, detail, { delay: 1400 });
      }
    } catch {}
  };

  [
    'zc:message-received',
    'zc:message',
    'zc:new-message',
    'atendimento:message',
    'atendimento:message-received',
    'message',
  ].forEach((evt) => {
    window.addEventListener(evt, handler);
  });
}

/* ================= Exports globais ================= */
window.selecionarClienteObj = selecionarClienteObj;
window.closeChatMobile = closeChatMobile;
window.zcMarkChatAsSeen = markChatAsSeenNow;
window.zcScheduleMarkChatAsSeen = scheduleMarkChatAsSeen;

/* ================= Chips de instância (opcional) ================= */
export function wireInstanciaChips() {
  document.querySelectorAll('[data-inst],[data-inst-id],[data-instancia]').forEach((el) => {
    el.addEventListener('click', () => {});
  });
}

/* ================= BOOT ================= */
export async function boot() {
  if (window.__ZC_ATENDIMENTOS_BOOTED__) {
    console.warn('[boot] ignorado: atendimento já inicializado');
    return;
  }

  window.__ZC_ATENDIMENTOS_BOOTED__ = true;

  bindRealtimeSeenGuard();

  try {
    if (window.AppReady?.setRequired) {
      window.AppReady.setRequired(['ui', 'clientes', 'boot']);
    }

    readyPart('ui');

    try {
      await carregarClientes({ force: true, reason: 'boot' });
      readyPart('clientes');
    } catch (e) {
      console.error('[boot] carregarClientes falhou:', e);
      readyPart('clientes');
    }

    try {
      window.zcUpdateInstBadge?.();
    } catch {}

    readyPart('boot');
  } catch (e) {
    console.error('[boot]', e);
    readyPart('boot');
    readyPart('clientes');
  }

  if (!window.__ZC_ATENDIMENTOS_POPSTATE_BOUND__) {
    window.__ZC_ATENDIMENTOS_POPSTATE_BOUND__ = true;

    window.addEventListener(
      'popstate',
      (e) => {
        const isMobile = window.matchMedia('(max-width: 920px)').matches;
        if (!isMobile) return;
        const hasChat = document.body.classList.contains('is-chat-open');
        const st = e.state || {};
        if (hasChat && !st.chatOpen) closeChatMobile();
      },
      { passive: true }
    );
  }
}