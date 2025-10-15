import { state, persist, setClienteSel } from '../state/store.js';
import { EMPRESA_ID } from '../core/env.js';
import { carregarClientes } from '../domain/clientes.js';
import { salvarNoCache, renderHistoricoDoCache } from '../domain/historico.js';
import { abrirPerfilAtual } from '../ui/perfil.js';

// Base unificada de histórico local
import { hasHistory, primeWith, getHist } from '../domain/hist-cache.js';

// ====== Flag global: esconder banner do topo (Operadora: …) ======
window.SHOW_TOP_OPERATOR_BANNER = false;

/* ================= Helpers de prontidão (Splash) ================= */
function readyPart(key){
  if (window.AppReady && typeof window.AppReady.mark === 'function') {
    window.AppReady.mark(key);
  } else {
    window.dispatchEvent(new CustomEvent('ready:part', { detail: key }));
  }
}

/* ================= OperatorLine (banner “Operadora: …”) ================= */
(function(){
  const SELECTORS = ['#historico', '.chat-history', '.mensagens', '#mensagens', '#history'];

  function ensureStyle(){
    if (document.getElementById('op-headline-style')) return;
    const style = document.createElement('style');
    style.id = 'op-headline-style';
    style.textContent =
      `.op-headline{position:sticky;top:0;z-index:6;background:var(--card);color:var(--fg);`+
      `border-bottom:1px dashed var(--border);padding:.5rem .75rem;font-weight:600;font-size:.95rem}`+
      `.op-headline small{color:var(--muted);font-weight:500;margin-left:.5rem}`;
    document.head.appendChild(style);
  }
  function findHistoryContainer(){
    for (const s of SELECTORS){
      const n = document.querySelector(s);
      if (n) return n;
    }
    return null;
  }
  function ensureHeadline(){
    let el = document.getElementById('op-headline');
    if (el) return el;
    ensureStyle();
    el = document.createElement('div');
    el.id = 'op-headline';
    el.className = 'op-headline';
    el.hidden = true;

    const hist = findHistoryContainer();
    if (hist && hist.parentNode){
      hist.parentNode.insertBefore(el, hist);
    }else{
      document.body.prepend(el);
      const mo = new MutationObserver(()=> {
        const h = findHistoryContainer();
        const cur = document.getElementById('op-headline');
        if (h && h.parentNode && cur && cur.parentNode !== h.parentNode){
          h.parentNode.insertBefore(cur, h);
          mo.disconnect();
        }
      });
      mo.observe(document.documentElement, { childList:true, subtree:true });
    }
    return el;
  }
  function getUserName(){
    const w = window, LS = w.localStorage || {};
    return (w.Auth?.user?.nome) || (w.CURRENT_USER?.nome) || LS.getItem('user_nome') || 'Operadora';
  }
  const normalize = (s)=> String(s||'').replace(/\s+/g,' ').trim().slice(0,180);
  const fmtTime   = (iso)=> { try{ const d = iso?new Date(iso):new Date(); return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}catch{return '';} };

  function deriveName(meta){
    if (meta && meta.origem === 'whatsapp_fisico') return 'WhatsApp físico';
    if (meta && meta.autor_nome) return meta.autor_nome;
    return getUserName();
  }

  function setOpHeadline(text, whenISO, meta){
    if (window.SHOW_TOP_OPERATOR_BANNER === false) return;
    const box = ensureHeadline();
    const preview = normalize(text);
    if (!preview){ box.hidden = true; box.textContent = ''; return; }
    const nome = deriveName(meta || {});
    const time = whenISO ? `<small>${fmtTime(whenISO)}</small>` : '';
    box.innerHTML = `${nome}: ${preview} ${time}`;
    box.hidden = false;
  }
  function clearOpHeadline(){
    const box = document.getElementById('op-headline');
    if (box){ box.hidden = true; box.textContent = ''; }
  }

  if (window.SHOW_TOP_OPERATOR_BANNER === false) {
    const s = document.createElement('style');
    s.textContent = `#op-headline{display:none!important}`;
    document.head.appendChild(s);
  }

  window.OperatorLine = { set: setOpHeadline, clear: clearOpHeadline, getName: getUserName };
})();

/* ================= Utils ================= */

async function markChatAsSeen(clienteId) {
  try {
    await fetch(`/api/atendimento/clientes/${Number(clienteId)}/seen?empresa_id=${EMPRESA_ID}`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {}
}

function closeChatMobile() {
  if (!window.matchMedia('(max-width: 920px)').matches) return;
  const ws   = document.getElementById('welcome-screen');
  const head = document.getElementById('chat-header');
  const hist = document.getElementById('historico');
  const foot = document.getElementById('chat-footer');

  if (head) head.style.display = 'none';
  if (hist) { hist.style.display = 'none'; hist.innerHTML = ''; hist.removeAttribute('data-cliente-id'); }
  if (foot) foot.style.display = 'none';
  if (ws)   ws.style.display   = 'none';

  document.body.classList.remove('is-chat-open');
}

const onlyDigits = (s) => String(s||'').replace(/\D+/g,'');

/* ===== Helpers de instância ===== */
function getInstanciaForFetch(clienteId) {
  const sel = state?.clienteSel;
  if (sel && (sel.id === clienteId || sel.conversation_id === clienteId)) {
    const cand = sel.instancia_id ?? sel.instancia ?? window.INSTANCIA_ATIVA ?? null;
    return cand == null || cand === '' ? null : String(cand);
  }
  const c = (state.clientesCache || []).find(x => (x.id ?? x.conversation_id) === Number(clienteId));
  const cand = c?.instancia_id ?? c?.instancia ?? window.INSTANCIA_ATIVA ?? null;
  return (cand == null || cand === '') ? null : String(cand);
}

/* ============ Carregar mensagens (prime 50 se não houver cache) ============ */

async function ensureMensagensCarregadas(conversationId) {
  if (!state.mensagensOffset || typeof state.mensagensOffset !== 'object') {
    state.mensagensOffset = {};
  }

  const inst = getInstanciaForFetch(conversationId);

  if (hasHistory(inst, conversationId)) {
    state.mensagensOffset[conversationId] = (getHist(inst, conversationId) || []).length;
    persist();
    return getHist(inst, conversationId) || [];
  }

  const qs = new URLSearchParams({ empresa_id: String(EMPRESA_ID), limit: '50' });
  if (inst) qs.set('instancia_id', inst);
  const url = `/api/atendimento/conversas/${conversationId}/mensagens?` + qs.toString();

  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('Falha ao carregar mensagens');
  const data = await r.json();

  const items = Array.isArray(data?.items) ? data.items : [];
  const mapped = items.map(m => {
    const tipoMsg = m.tipo || (m.remetente === 'agente' ? 'saida' : 'entrada');
    const origem = (m.origem)
      ? m.origem
      : (tipoMsg === 'saida' ? 'atendente' : 'cliente');

    return {
      msg_id:    m.msg_id || m.id || null,
      conteudo:  m.texto ?? m.conteudo ?? '',
      tipo:      tipoMsg,
      timestamp: m.ts || m.timestamp || new Date().toISOString(),
      ack:       (tipoMsg === 'saida') ? (typeof m.ack === 'number' ? m.ack : 0) : null,
      midias:    Array.isArray(m.midias) ? m.midias : [],
      instancia_id: m.instancia_id ?? (inst || null),
      origem,
      autor_nome: m.autor_nome ?? m.atendente_nome ?? null,
    };
  });

  try { salvarNoCache(conversationId, mapped); } catch {}
  primeWith(inst, conversationId, mapped, {
    oldest: data?.prev_cursor ?? null,
    newest: data?.next_cursor ?? null
  });

  state.cacheHistoricos = {
    ...(state.cacheHistoricos || {}),
    [conversationId]: (window.cacheHistoricos || {})[conversationId]
  };
  state.mensagensOffset[conversationId] = (getHist(inst, conversationId) || []).length;
  persist();

  try { console.debug('[ensureMensagensCarregadas][prime50]', conversationId, getHist(inst, conversationId)); } catch {}

  return getHist(inst, conversationId) || [];
}

/* ======= Atualiza banner com a última saída ======= */
function updateOperatorBannerForConversation(convId){
  if (window.SHOW_TOP_OPERATOR_BANNER === false) return;
  try{
    const inst = getInstanciaForFetch(convId);
    const arr  = getHist(inst, convId) || ((window.cacheHistoricos || {})[convId] || []);
    const lastOut = [...arr].reverse().find(m =>
      (m?.tipo === 'saida') || (m?.from_me === true) || (m?.origem === 'atendente')
    );
    if (lastOut) {
      const texto = lastOut.conteudo || lastOut.texto || lastOut.mensagem || '';
      const ts    = lastOut.timestamp || lastOut.ts || null;
      const meta  = {
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
  const isMobile = window.matchMedia('(max-width: 920px)').matches;
  const hist = document.getElementById('historico');
  const ws   = document.getElementById('welcome-screen');
  const head = document.getElementById('chat-header');
  const foot = document.getElementById('chat-footer');

  if (hist) {
    hist.innerHTML = '';
    hist.dataset.clienteId = String(id);
    hist.dataset.noMore = '0';
    hist.style.display = 'block';
  }
  if (ws)   ws.style.display   = 'none';
  if (head) head.style.display = 'flex';
  if (foot) foot.style.display = 'flex';

  readyPart('ui');

  const byId = (x) => x?.conversation_id === id || x?.id === id || x?.cliente_id === id;
  const c =
    (state.clientesCache || []).find(byId) ||
    (state.todosContatosCache || []).find(byId);

  if (!c) return;
  setClienteSel(c);

  try{
    const instCand = c.instancia_id ?? c.instancia ?? null;
    if (instCand != null && instCand !== '') {
      window.INSTANCIA_ATIVA = String(instCand);
      window.setInstanceChip?.(String(instCand));
    }
  }catch{}

  // expor telefone pro perfil_quick.js
  try {
    const phone =
      c.telefone ?? c.tel ?? c.phone ?? c.whatsapp ?? c.telefone_norm ?? c.numero ?? c.number ?? null;

    const digits = onlyDigits(phone);
    if (digits) {
      if (hist) hist.dataset.telefone = digits;
      if (head) head.setAttribute('data-phone', digits);
    } else {
      if (hist) delete hist.dataset.telefone;
      if (head) head.removeAttribute('data-phone');
    }
  } catch {}

  const t  = document.getElementById('chat-title');
  const av = document.getElementById('chat-avatar');
  if (t)  t.textContent = c.nome || c.push_name || '';
  if (av) {
    av.innerHTML = c.avatar_url
      ? `<span class="avatar"><img src="${c.avatar_url}" alt=""
           onerror="this.onerror=null;this.parentElement.classList.add('avatar-default');this.remove();"></span>`
      : `<span class="avatar avatar-default"><i class="fa fa-user-circle text-2xl text-gray-400"></i></span>`;
  }

  try {
    const openPerfil = () => abrirPerfilAtual && abrirPerfilAtual(false);
    if (t)  { t.style.cursor = 'pointer';  t.onclick  = openPerfil; }
    if (av) { av.style.cursor = 'pointer'; av.onclick = openPerfil; }
  } catch {}

  await ensureMensagensCarregadas(id);
  renderHistoricoDoCache(id);

  if (!state.mensagensOffset || typeof state.mensagensOffset !== 'object') {
    state.mensagensOffset = {};
  }
  const inst = getInstanciaForFetch(id);
  state.mensagensOffset[id] = (getHist(inst, id) || []).length;

  updateOperatorBannerForConversation(id);

  try { window.syncPreviewFromCache?.(id); } catch {}

  await markChatAsSeen(id);

  // 🆕 Zera “bolinha” (unread) local imediatamente ao abrir
  try {
    window.Lista?.resetUnread?.(id);
    window.recomputeUnread?.();
  } catch {
    // fallback: ajusta direto no cache e re-render
    try {
      const arr = window.state?.clientesCache || window.clientesCache || [];
      const idx = arr.findIndex(x => Number(x.id ?? x.conversation_id ?? x.cliente_id) === Number(id));
      if (idx >= 0) { arr[idx].novas = 0; window.renderListaClientes?.(arr); window.recomputeUnread?.(); }
    } catch {}
  }

  if (isMobile) {
    document.body.classList.add('is-chat-open');
    try { history.pushState({ chatOpen: true, id }, '', location.href); } catch {}
  }
}

/* ================= Exports globais ================= */
window.selecionarClienteObj = selecionarClienteObj;
window.closeChatMobile      = closeChatMobile;

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
      window.AppReady.setRequired(['ui','clientes','boot']);
    }

    readyPart('ui');

    try {
      await carregarClientes({ force: true, reason: 'boot' });
      readyPart('clientes');
    } catch (e) {
      console.error('[boot] carregarClientes falhou:', e);
      readyPart('clientes');
    }

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
