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

/* ================= ID helpers (string-first) ================= */
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

/* ================= Helpers (Toast simples) ================= */
function toast(msg, ok = true) {
  let t = document.getElementById('__app_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '__app_toast';
    t.className = 'zc-toast'; // <-- CSS vai pro atendimentos.css
    document.body.appendChild(t);
  }
  t.textContent = String(msg || '');
  t.style.background = ok ? '#1e293b' : '#7f1d1d';
  t.style.opacity = '1';
  t.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(t.__timer);
  t.__timer = setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(4px)';
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
    el.className = 'op-headline'; // <-- CSS vai pro atendimentos.css
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
    const w = window, LS = w.localStorage || {};
    return (w.Auth?.user?.nome) || (w.CURRENT_USER?.nome) || LS.getItem('user_nome') || 'Operadora';
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

  window.OperatorLine = { set: setOpHeadline, clear: clearOpHeadline, getName: getUserName };
})();


/* ================= Utils ================= */

async function markChatAsSeen(clienteId) {
  try {
    const cid = encodeURIComponent(String(clienteId ?? '').trim());
    await fetch(`/api/atendimento/clientes/${cid}/seen?empresa_id=${encodeURIComponent(String(EMPRESA_ID))}`, {
      method: 'POST',
      credentials: 'include',
    });
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
    hist.removeAttribute('data-cliente-id');
    hist.removeAttribute('data-instancia-id');
  }
  if (foot) foot.style.display = 'none';
  if (ws) ws.style.display = 'none';

  document.body.classList.remove('is-chat-open');
}

const onlyDigits = (s) => String(s || '').replace(/\D+/g, '');

/* ===== Helpers de instância ===== */
function getInstanciaForFetch(clienteId) {
  const cid = idKey(clienteId);
  const sel = state?.clienteSel;

  if (sel && idEq(sel.id ?? sel.conversation_id ?? sel.cliente_id, cid)) {
    const cand = sel.instancia_id ?? sel.instancia ?? window.getInstanciaAtiva?.() ?? window.INSTANCIA_ATIVA ?? null;
    return cand == null || String(cand).trim() === '' ? null : String(cand);
  }

  const c = (state.clientesCache || []).find(x => idEq(x?.id ?? x?.conversation_id ?? x?.cliente_id, cid));
  const cand = c?.instancia_id ?? c?.instancia ?? window.getInstanciaAtiva?.() ?? window.INSTANCIA_ATIVA ?? null;
  return (cand == null || String(cand).trim() === '') ? null : String(cand);
}

function syncInstanciaFromCliente(c) {
  const instCand = c?.instancia_id ?? c?.instancia ?? null;
  const active = window.getInstanciaAtiva?.() ?? window.INSTANCIA_ATIVA ?? null;

  if (instCand != null && String(instCand).trim() !== '') {
    try { window.setInstanciaAtiva?.(String(instCand), { reloadList: false }); } catch {}
    return String(instCand);
  }

  if (active != null && String(active).trim() !== '') return String(active);

  return null;
}

/* ============ Carregar mensagens (sempre consulta backend) ============ */
async function ensureMensagensCarregadas(conversationId) {
  if (!state.mensagensOffset || typeof state.mensagensOffset !== 'object') {
    state.mensagensOffset = {};
  }

  const convId = String(conversationId ?? '').trim();
  const inst = getInstanciaForFetch(convId);

  // TRAVA: não carrega conversa “no escuro”
  if (window.ZC_REQUIRE_INSTANCE === true && !inst) {
    try { window.zcUpdateInstBadge?.(); window.zcFlashInstBadge?.(); } catch {}
    toast('Selecione um WhatsApp (instância) antes de abrir/enviar.', false);
    throw new Error('Instância não resolvida');
  }

  const qs = new URLSearchParams({ empresa_id: String(EMPRESA_ID), limit: '50' });
  if (inst) {
    const s = String(inst);
    if (/^\d+$/.test(s)) qs.set('instancia_id', s);
    else qs.set('instance', s);
  }

  const cidEnc = encodeURIComponent(convId);
  const url = `/api/atendimento/conversas/${cidEnc}/mensagens?` + qs.toString();

  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('Falha ao carregar mensagens');
  const data = await r.json();

  const items = Array.isArray(data?.items) ? data.items : [];

  const mapped = items.map(m => {
    const tipoMsg = m.tipo || (m.remetente === 'agente' ? 'saida' : 'entrada');
    const isSaida = (tipoMsg === 'saida') || m.from_me === true || m.origem === 'atendente';

    let ackNum = Number(m.ack ?? m.status ?? m.ack_status ?? m.meta?.ack ?? 0);
    if (!Number.isFinite(ackNum)) ackNum = 0;
    ackNum = Math.min(3, Math.max(0, ackNum));

    return {
      msg_id: m.msg_id || m.id || null,
      conteudo: m.texto ?? m.conteudo ?? '',
      tipo: tipoMsg,
      timestamp: m.ts || m.timestamp || new Date().toISOString(),
      ack: isSaida ? ackNum : null,
      midias: Array.isArray(m.midias) ? m.midias : [],
      instancia_id: m.instancia_id ?? (inst || null),
      origem: m.origem ?? (isSaida ? 'atendente' : 'cliente'),
      autor_nome: m.autor_nome ?? m.atendente_nome ?? null,
    };
  });

  try { salvarNoCache(convId, mapped); } catch {}

  const finalHist = getHist(inst, convId) || [];

  state.cacheHistoricos = {
    ...(state.cacheHistoricos || {}),
    [convId]: (window.cacheHistoricos || {})[convId]
  };
  state.mensagensOffset[convId] = finalHist.length;
  persist();

  return finalHist;
}

/* ======= Atualiza banner com a última saída ======= */
function updateOperatorBannerForConversation(convId) {
  if (window.SHOW_TOP_OPERATOR_BANNER === false) return;
  try {
    const id = String(convId ?? '').trim();
    const inst = getInstanciaForFetch(id);
    const arr = getHist(inst, id) || ((window.cacheHistoricos || {})[id] || []);
    const lastOut = [...arr].reverse().find(m =>
      (m?.tipo === 'saida') || (m?.from_me === true) || (m?.origem === 'atendente')
    );
    if (lastOut) {
      const texto = lastOut.conteudo || lastOut.texto || lastOut.mensagem || '';
      const ts = lastOut.timestamp || lastOut.ts || null;
      const meta = {
        origem: (lastOut.origem)
          ? lastOut.origem
          : ((lastOut.tipo === 'saida' || lastOut.from_me === true) ? 'atendente' : 'cliente'),
        autor_nome: lastOut.autor_nome || lastOut.atendente_nome || lastOut.user_nome || null,
      };
      window.OperatorLine?.set(texto, ts, meta);
    } else {
      window.OperatorLine?.clear();
    }
  } catch {}
}

/* ================= Seleção de cliente + preparo da UI ================= */
async function selecionarClienteObj(id) {
  const cid = idKey(id) ?? String(id ?? '').trim();
  const isMobile = window.matchMedia('(max-width: 920px)').matches;
  const hist = document.getElementById('historico');
  const ws = document.getElementById('welcome-screen');
  const head = document.getElementById('chat-header');
  const foot = document.getElementById('chat-footer');

  if (hist) {
    hist.innerHTML = '';
    hist.dataset.clienteId = String(cid || '');
    hist.dataset.noMore = '0';
    hist.style.display = 'block';
  }
  if (ws) ws.style.display = 'none';
  if (head) head.style.display = 'flex';
  if (foot) foot.style.display = 'flex';

  readyPart('ui');

  const byId = (x) => idEq(x?.conversation_id ?? x?.id ?? x?.cliente_id, cid);
  const c =
    (state.clientesCache || []).find(byId) ||
    (state.todosContatosCache || []).find(byId);

  if (!c) {
    try { window.zcUpdateInstBadge?.(); } catch {}
    return;
  }

  setClienteSel(c);

  // TRAVA/SYNC de instância antes de qualquer fetch/render
  const instFinal = syncInstanciaFromCliente(c);
  if (hist && instFinal) hist.dataset.instanciaId = String(instFinal);
  if (window.ZC_REQUIRE_INSTANCE === true && !instFinal) {
    try { window.zcUpdateInstBadge?.(); window.zcFlashInstBadge?.(); } catch {}
    toast('Selecione um WhatsApp (instância) antes de abrir/enviar.', false);
    return;
  }

  // 🔗 integra com o drawer de Notas — informa qual cliente está aberto
  try {
    if (window.zcNotesSetContextFromCliente) {
      window.zcNotesSetContextFromCliente(c);
    } else if (head) {
      const cidx = c.cliente_id ?? c.id ?? c.conversation_id ?? null;
      if (cidx != null) head.dataset.clienteId = String(cidx);
    }
  } catch {}

  // expor telefone pro perfil_quick.js
  try {
    const phone =
      c.telefone ?? c.tel ?? c.phone ?? c.whatsapp ?? c.telefone_norm ?? c.numero ?? c.number ?? null;

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
  if (t) t.textContent = c.nome || c.push_name || '';
  if (av) {
    if (c.avatar_url) {
      const safeUrl = String(c.avatar_url).replace(/"/g, '&quot;');
      av.innerHTML = `<span class="avatar"><img src="${safeUrl}" alt="" data-cliente-id="${String(c.id ?? cid ?? '')}"
           onerror="window.handleAvatarError && window.handleAvatarError(this)"></span>`;
    } else {
      av.innerHTML =
        `<span class="avatar avatar-default"><i class="fa fa-user-circle text-2xl text-gray-400"></i></span>`;
    }
  }

  // click abre perfil
  try {
    const openPerfil = () => abrirPerfilAtual && abrirPerfilAtual(false);
    if (t) { t.style.cursor = 'pointer'; t.onclick = openPerfil; }
    if (av) { av.style.cursor = 'pointer'; av.onclick = openPerfil; }
  } catch {}

  // badge sempre atualizado
  try { window.zcUpdateInstBadge?.(); } catch {}

  try {
    await ensureMensagensCarregadas(cid);
    renderHistoricoDoCache(cid);
  } catch (e) {
    console.warn('[selecionarClienteObj] carregar mensagens falhou:', e?.message || e);
    return;
  }

  if (!state.mensagensOffset || typeof state.mensagensOffset !== 'object') {
    state.mensagensOffset = {};
  }
  const inst = getInstanciaForFetch(cid);
  state.mensagensOffset[cid] = (getHist(inst, cid) || []).length;

  updateOperatorBannerForConversation(cid);

  try { window.syncPreviewFromCache?.(cid); } catch {}
  await markChatAsSeen(cid);

  // zera “unread” local
  try {
    window.Lista?.resetUnread?.(cid);
    window.recomputeUnread?.();
  } catch {
    try {
      const arr = window.state?.clientesCache || window.clientesCache || [];
      const idx = arr.findIndex(x => idEq(x?.id ?? x?.conversation_id ?? x?.cliente_id, cid));
      if (idx >= 0) {
        arr[idx].novas = 0;
        window.renderListaClientes?.(arr);
        window.recomputeUnread?.();
      }
    } catch {}
  }

  if (isMobile) {
    document.body.classList.add('is-chat-open');
    try { history.pushState({ chatOpen: true, id: cid }, '', location.href); } catch {}
  }
}

/* ================= Exports globais ================= */
window.selecionarClienteObj = selecionarClienteObj;
window.closeChatMobile = closeChatMobile;

/* ================= Chips de instância (opcional) ================= */
export function wireInstanciaChips() {
  document.querySelectorAll('[data-inst],[data-inst-id],[data-instancia]').forEach(el => {
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

    try { window.zcUpdateInstBadge?.(); } catch {}

    readyPart('boot');
  } catch (e) {
    console.error('[boot]', e);
    readyPart('boot');
    readyPart('clientes');
  }

  window.addEventListener('popstate', (e) => {
    const isMobile = window.matchMedia('(max-width: 920px)').matches;
    if (!isMobile) return;
    const hasChat = document.body.classList.contains('is-chat-open');
    const st = e.state || {};
    if (hasChat && !st.chatOpen) closeChatMobile();
  }, { passive: true });
}
