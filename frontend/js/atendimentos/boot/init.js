//frontend\js\atendimentos\boot\init.js

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

/* ================= ID / REF helpers (string-first) ================= */
function normStr(v) {
  return String(v ?? '').trim();
}

function idKey(v) {
  const s = normStr(v);
  if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
  return s;
}

function idEq(a, b) {
  const A = idKey(a);
  const B = idKey(b);
  if (!A || !B) return false;
  return A === B;
}

function instKey(v) {
  const s = normStr(v);
  if (!s) return null;
  if (['null', 'undefined', 'nan', '0', 'all', '*', '-'].includes(s.toLowerCase())) return null;
  return s;
}

function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}

function inferKindFromRow(row = null) {
  const explicit =
    row?.kind ??
    row?.conversation_kind ??
    row?.tipo_conversa ??
    null;

  const exp = normStr(explicit).toLowerCase();
  if (exp === 'c' || exp === 'contato' || exp === 'cliente') return 'c';
  if (exp === 'g' || exp === 'grupo' || exp === 'group') return 'g';

  if (row?.grupo_id != null || row?.is_group === true) return 'g';
  return 'c';
}

function inferEntityIdFromRow(row = null) {
  const kind = inferKindFromRow(row);

  const raw =
    row?.entity_id ??
    row?.backend_id ??
    row?.id_backend ??
    (kind === 'g'
      ? (row?.grupo_id ?? row?.conversation_entity_id ?? null)
      : (row?.cliente_id ?? row?.conversation_entity_id ?? null));

  const s = idKey(raw);
  if (s && /^\d+$/.test(s)) return s;

  const fallbackRaw =
    row?.api_id ??
    row?.id_api ??
    null;

  const f = idKey(fallbackRaw);
  if (f && /^\d+$/.test(f)) return f;

  return null;
}

function inferInstIdFromRow(row = null) {
  return (
    instKey(row?.instancia_id) ||
    instKey(row?.instancia) ||
    instKey(row?.instance_id) ||
    instKey(row?.instance) ||
    instKey(row?.instance_name) ||
    null
  );
}

function buildConversationKey(kind, entityId, instId) {
  const k = String(kind || '').toLowerCase() === 'g' ? 'g' : 'c';
  const eid = idKey(entityId);
  const iid = instKey(instId);
  if (!eid) return null;
  return `${k}:${eid}:${iid ?? '0'}`;
}

function parseConversationRef(raw, row = null) {
  const rawStr = normStr(raw);
  const fromRowKey =
    idKey(row?.conversation_key) ||
    idKey(row?.conversation_id) ||
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
    return {
      key: buildConversationKey(rowKind, rowEntityId, rowInstId) || source || '',
      kind: rowKind,
      entityId: rowEntityId,
      instId: rowInstId,
    };
  }

  if (/^\d+$/.test(source)) {
    return {
      key: source,
      kind: rowKind || null,
      entityId: source,
      instId: rowInstId,
    };
  }

  return {
    key: source || '',
    kind: rowKind || null,
    entityId: rowEntityId || null,
    instId: rowInstId || null,
  };
}

function convKeyOf(row) {
  return parseConversationRef(
    row?.conversation_key ??
    row?.conversation_id ??
    row?.id ??
    row?.cliente_id ??
    row?.grupo_id ??
    null,
    row
  ).key;
}

function entityIdOf(row) {
  return parseConversationRef(
    row?.conversation_key ??
    row?.conversation_id ??
    row?.id ??
    row?.cliente_id ??
    row?.grupo_id ??
    null,
    row
  ).entityId;
}

function kindOf(row) {
  return parseConversationRef(
    row?.conversation_key ??
    row?.conversation_id ??
    row?.id ??
    row?.cliente_id ??
    row?.grupo_id ??
    null,
    row
  ).kind;
}

function sameConversation(a, b) {
  const A = convKeyOf(a);
  const B = parseConversationRef(b, typeof b === 'object' ? b : null).key;
  return !!A && !!B && A === B;
}

function findConversation(raw) {
  const ref = parseConversationRef(raw);
  const pools = [
    ...(Array.isArray(state?.clientesCache) ? state.clientesCache : []),
    ...(Array.isArray(state?.todosContatosCache) ? state.todosContatosCache : []),
  ];

  const byKey = pools.find((x) => convKeyOf(x) === ref.key);
  if (byKey) return byKey;

  if (ref.entityId) {
    const byEntityInst = pools.find((x) => {
      const xr = parseConversationRef(convKeyOf(x), x);
      if (!xr.entityId || xr.entityId !== ref.entityId) return false;
      if (ref.kind && xr.kind && xr.kind !== ref.kind) return false;
      if (ref.instId && xr.instId && xr.instId !== ref.instId) return false;
      return true;
    });
    if (byEntityInst) return byEntityInst;
  }

  return null;
}

function setConversationDatasets(target, ref) {
  if (!target || !ref) return;

  target.dataset.conversationKey = String(ref.key || '');
  target.dataset.kind = String(ref.kind || '');
  target.dataset.entityId = String(ref.entityId || '');

  if (ref.instId) target.dataset.instanciaId = String(ref.instId);
  else target.removeAttribute('data-instancia-id');

  // compat legado
  target.dataset.clienteId = String(ref.key || '');
  target.dataset.apiClienteId = String(ref.entityId || '');

  if (ref.kind === 'c' && ref.entityId) {
    target.dataset.backendClienteId = String(ref.entityId);
  } else {
    target.removeAttribute('data-backend-cliente-id');
  }
}

function clearConversationDatasets(target) {
  if (!target) return;
  target.removeAttribute('data-conversation-key');
  target.removeAttribute('data-kind');
  target.removeAttribute('data-entity-id');
  target.removeAttribute('data-instancia-id');

  // compat legado
  target.removeAttribute('data-cliente-id');
  target.removeAttribute('data-api-cliente-id');
  target.removeAttribute('data-backend-cliente-id');
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

async function markChatAsSeen(conversationRef, row = null) {
  try {
    const ref = parseConversationRef(conversationRef, row);

    // endpoint é de CLIENTE, então grupo não entra aqui
    if (ref.kind !== 'c' || !ref.entityId) return;

    await fetch(
      `/api/atendimento/clientes/${encodeURIComponent(ref.entityId)}/seen?empresa_id=${encodeURIComponent(String(EMPRESA_ID))}`,
      {
        method: 'POST',
        credentials: 'include',
      }
    );
  } catch {}
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
    head.removeAttribute('data-phone');
    head.removeAttribute('data-conversation-key');
    head.removeAttribute('data-kind');
    head.removeAttribute('data-entity-id');
  }
  if (foot) foot.style.display = 'none';
  if (ws) ws.style.display = 'none';

  document.body.classList.remove('is-chat-open');
}

const onlyDigits = (s) => String(s || '').replace(/\D+/g, '');

/* ===== Helpers de instância ===== */
function getInstanciaForFetch(conversationRef) {
  const ref = parseConversationRef(conversationRef);
  const sel = state?.clienteSel;

  if (sel && convKeyOf(sel) === ref.key) {
    const cand =
      instKey(sel.instancia_id) ||
      instKey(sel.instancia) ||
      ref.instId ||
      instKey(window.getInstanciaAtiva?.()) ||
      instKey(window.INSTANCIA_ATIVA) ||
      null;
    return cand;
  }

  const c = findConversation(ref.key);
  const cand =
    instKey(c?.instancia_id) ||
    instKey(c?.instancia) ||
    ref.instId ||
    instKey(window.getInstanciaAtiva?.()) ||
    instKey(window.INSTANCIA_ATIVA) ||
    null;

  return cand;
}

function syncInstanciaFromCliente(c) {
  const instCand = instKey(c?.instancia_id) || instKey(c?.instancia) || null;
  const active = instKey(window.getInstanciaAtiva?.()) || instKey(window.INSTANCIA_ATIVA) || null;

  if (instCand) {
    try {
      window.setInstanciaAtiva?.(String(instCand), { reloadList: false });
    } catch {}
    return String(instCand);
  }

  if (active) return String(active);

  return null;
}

/* ============ Carregar mensagens (sempre consulta backend) ============ */
async function ensureMensagensCarregadas(conversationRef) {
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

  const items = Array.isArray(data?.items) ? data.items : [];

  const mapped = items.map((m) => {
    const tipoMsg = m.tipo || (m.remetente === 'agente' ? 'saida' : 'entrada');
    const isSaida = tipoMsg === 'saida' || m.from_me === true || m.origem === 'atendente';

    let ackNum = Number(m.ack ?? m.status ?? m.ack_status ?? m.meta?.ack ?? 0);
    if (!Number.isFinite(ackNum)) ackNum = 0;
    ackNum = Math.min(3, Math.max(0, ackNum));

    // ✅ NUNCA inventar "agora" em mensagem antiga sem timestamp claro
    const rawTs =
      m.ts ??
      m.timestamp ??
      m.data ??
      m.created_at ??
      m.hora ??
      null;

    return {
      msg_id: m.msg_id || m.id || null,
      conteudo: m.texto ?? m.conteudo ?? '',
      tipo: tipoMsg,
      timestamp: rawTs || null,
      ack: isSaida ? ackNum : null,
      midias: Array.isArray(m.midias) ? m.midias : [],
      instancia_id: m.instancia_id ?? (inst || null),
      origem: m.origem ?? (isSaida ? 'atendente' : 'cliente'),
      autor_nome: m.autor_nome ?? m.atendente_nome ?? null,
    };
  });

  try {
    salvarNoCache(convKey, mapped);
  } catch {}

  const finalHist = getHist(inst, convKey) || [];

  state.cacheHistoricos = {
    ...(state.cacheHistoricos || {}),
    [convKey]: (window.cacheHistoricos || {})[convKey],
  };
  state.mensagensOffset[convKey] = finalHist.length;
  persist();

  return finalHist;
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

/* ================= Seleção de cliente + preparo da UI ================= */
async function selecionarClienteObj(id) {
  const rawInput = idKey(id) ?? String(id ?? '').trim();
  const isMobile = window.matchMedia('(max-width: 920px)').matches;
  const hist = document.getElementById('historico');
  const ws = document.getElementById('welcome-screen');
  const head = document.getElementById('chat-header');
  const foot = document.getElementById('chat-footer');

  if (hist) {
    hist.innerHTML = '';
    hist.dataset.noMore = '0';
    hist.style.display = 'block';
  }
  if (ws) ws.style.display = 'none';
  if (head) head.style.display = 'flex';
  if (foot) foot.style.display = 'flex';

  readyPart('ui');

  const c = findConversation(rawInput);

  if (!c) {
    try {
      window.zcUpdateInstBadge?.();
    } catch {}
    return;
  }

  const ref = parseConversationRef(rawInput, c);
  const convKey = ref.key;

  if (!ref.entityId) {
    toast('Conversa inválida.', false);
    return;
  }

  if (hist) setConversationDatasets(hist, ref);
  if (head) setConversationDatasets(head, ref);

  setClienteSel(c);

  // TRAVA/SYNC de instância antes de qualquer fetch/render
  let instFinal = syncInstanciaFromCliente(c);
  if (!instFinal && ref.instId) {
    instFinal = String(ref.instId);
    try {
      window.setInstanciaAtiva?.(String(instFinal), { reloadList: false });
    } catch {}
  }

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

  // 🔗 integra com o drawer de Notas — informa qual cliente está aberto
  try {
    if (window.zcNotesSetContextFromCliente) {
      window.zcNotesSetContextFromCliente(c);
    } else if (head) {
      head.dataset.conversationKey = String(convKey);
      if (ref.kind === 'c' && ref.entityId) head.dataset.clienteId = String(ref.entityId);
      else head.removeAttribute('data-cliente-id');
    }
  } catch {}

  // expor telefone pro perfil_quick.js
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
      '';
  }

  if (av) {
    if (c.avatar_url) {
      const safeUrl = String(c.avatar_url).replace(/"/g, '&quot;');
      av.innerHTML = `<span class="avatar"><img src="${safeUrl}" alt="" data-cliente-id="${String(ref.entityId || '')}"
           onerror="window.handleAvatarError && window.handleAvatarError(this)"></span>`;
    } else {
      av.innerHTML =
        `<span class="avatar avatar-default"><i class="fa fa-user-circle text-2xl text-gray-400"></i></span>`;
    }
  }

  // click abre perfil
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

  // badge sempre atualizado
  try {
    window.zcUpdateInstBadge?.();
  } catch {}

  try {
    await ensureMensagensCarregadas(convKey);
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

  await markChatAsSeen(convKey, c);

  // zera “unread” local
  try {
    window.Lista?.resetUnread?.(convKey);
    window.recomputeUnread?.();
  } catch {
    try {
      const arr = window.state?.clientesCache || window.clientesCache || [];
      const idx = arr.findIndex((x) => convKeyOf(x) === convKey);
      if (idx >= 0) {
        arr[idx].novas = 0;
        window.renderListaClientes?.(arr);
        window.recomputeUnread?.();
      }
    } catch {}
  }

  if (isMobile) {
    document.body.classList.add('is-chat-open');
    try {
      history.pushState({ chatOpen: true, id: convKey }, '', location.href);
    } catch {}
  }
}

/* ================= Exports globais ================= */
window.selecionarClienteObj = selecionarClienteObj;
window.closeChatMobile = closeChatMobile;

/* ================= Chips de instância (opcional) ================= */
export function wireInstanciaChips() {
  document.querySelectorAll('[data-inst],[data-inst-id],[data-instancia]').forEach((el) => {
    el.addEventListener('click', () => {});
  });
}

/* ================= BOOT ================= */
export async function boot() {
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