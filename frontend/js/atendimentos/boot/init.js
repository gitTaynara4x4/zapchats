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

/* ================= Helpers (Toast simples) ================= */
function toast(msg, ok = true) {
  let t = document.getElementById('__app_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '__app_toast';
    Object.assign(t.style, {
      position: 'fixed',
      left: '50%',
      bottom: '22px',
      transform: 'translateX(-50%)',
      maxWidth: '90vw',
      padding: '8px 12px',
      color: '#fff',
      background: '#1e293b',
      borderRadius: '10px',
      boxShadow: '0 10px 26px rgba(0,0,0,.30)',
      zIndex: 99999,
      fontSize: '13px',
      lineHeight: '1.25',
      opacity: '0',
      transition: 'opacity .15s, transform .15s',
      pointerEvents: 'none',
    });
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
  const fmtTime   = (iso)=> {
    try{
      const d = iso ? new Date(iso) : new Date();
      return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    }catch{
      return '';
    }
  };

  function deriveName(meta){
    if (meta && meta.origem === 'whatsapp_fisico') return 'WhatsApp físico';
    if (meta && meta.autor_nome) return meta.autor_nome;
    return getUserName();
  }

  function setOpHeadline(text, whenISO, meta){
    if (window.SHOW_TOP_OPERATOR_BANNER === false) return;
    const box = ensureHeadline();
    const preview = normalize(text);
    if (!preview){
      box.hidden = true;
      box.textContent = '';
      return;
    }
    const nome = deriveName(meta || {});
    const time = whenISO ? `<small>${fmtTime(whenISO)}</small>` : '';
    box.innerHTML = `${nome}: ${preview} ${time}`;
    box.hidden = false;
  }
  function clearOpHeadline(){
    const box = document.getElementById('op-headline');
    if (box){
      box.hidden = true;
      box.textContent = '';
    }
  }

  if (window.SHOW_TOP_OPERATOR_BANNER === false) {
    const s = document.createElement('style');
    s.textContent = `#op-headline{display:none!important}`;
    document.head.appendChild(s);
  }

  window.OperatorLine = { set: setOpHeadline, clear: clearOpHeadline, getName: getUserName };
})();

/* ================= Instância (central + badge com NOME) ================= */
(function(){
  const LS_KEY = `instAtiva:${String(EMPRESA_ID || '')}`;

  function norm(v){
    const s = (v == null ? '' : String(v)).trim();
    return s === '' ? '' : s;
  }

  function getInstanciasList(){
    return (
      window.ZC_INSTANCIAS ||
      window.INSTANCIAS ||
      window.state?.instancias ||
      []
    );
  }

  function pickLabelFromItem(i, fallbackRaw){
    if (!i) return fallbackRaw;

    // prioridade: apelido/nome “humano”
    const cand =
      i.apelido ||
      i.nome_exibicao ||
      i.display_name ||
      i.nome ||
      i.name ||
      i.titulo ||
      i.title ||
      null;

    if (cand && String(cand).trim()) return String(cand).trim();

    // se tiver número/telefone, usa isso
    const tel = i.telefone || i.numero || i.phone || i.whatsapp || null;
    if (tel) {
      const d = String(tel).replace(/\D+/g,'');
      if (d.length >= 8) return `WhatsApp • ${d.slice(-4)}`;
    }

    // fallback: instance_name/instancia
    const raw2 = i.instance_name || i.instancia || i.slug || null;
    if (raw2 && String(raw2).trim()) return String(raw2).trim();

    return fallbackRaw;
  }

  function resolveInstLabel(val){
    const raw = norm(val);
    if (!raw) return 'Selecione um WhatsApp';

    const list = getInstanciasList();
    const byId = (x) => String(x?.instancia_id ?? x?.id ?? x?.instance_id ?? '') === raw;
    const bySlug = (x) => String(x?.instance_name ?? x?.instancia ?? '').toLowerCase() === raw.toLowerCase();

    const it = list.find(byId) || list.find(bySlug);
    const label = pickLabelFromItem(it, raw);

    // evita mostrar “wa.4” feio: tenta humanizar se for padrão “wa.X”
    if (/^wa\.\d+$/i.test(label)) {
      const n = label.split('.').pop();
      return `WhatsApp ${n}`;
    }
    return label;
  }

  async function ensureInstanciasLoaded(){
    try{
      // se já tem lista, não refaz
      const list = getInstanciasList();
      if (Array.isArray(list) && list.length) return list;

      const id = Number(EMPRESA_ID || 0);
      if (!id) return [];

      const r = await fetch(`/api/empresas/${id}/whatsapp`, { credentials:'include' });
      if (!r.ok) return [];

      const j = await r.json().catch(()=>null);
      const arr = Array.isArray(j?.instancias) ? j.instancias : [];

      window.ZC_INSTANCIAS = arr;
      window.INSTANCIAS = window.INSTANCIAS || arr;

      window.state = window.state || {};
      window.state.instancias = arr;

      try { document.dispatchEvent(new CustomEvent('inst:list', { detail: { instancias: arr } })); } catch {}
      return arr;
    }catch{
      return [];
    }
  }

  function ensureInstBadgeStyle(){
    if (document.getElementById('inst-badge-style')) return;
    const s = document.createElement('style');
    s.id = 'inst-badge-style';
    s.textContent = `
      #inst-badge{
        margin-left:10px;
        padding:2px 10px;
        border:1px solid var(--border);
        border-radius:999px;
        font-size:12px;
        line-height:18px;
        color:var(--fg);
        background:var(--card);
        display:inline-flex;
        align-items:center;
        gap:6px;
        white-space:nowrap;
        opacity:.95;
        user-select:none;
      }
      #inst-badge .dot{width:8px;height:8px;border-radius:50%;background:var(--muted);}
      #inst-badge.is-none{border-color:rgba(239,68,68,.55); background:rgba(239,68,68,.08);}
      #inst-badge.is-none .dot{background:#ef4444;}
      #inst-badge.shake{animation:instShake .35s linear 1;}
      @keyframes instShake{
        0%{transform:translateX(0)} 25%{transform:translateX(-4px)}
        50%{transform:translateX(4px)} 75%{transform:translateX(-3px)}
        100%{transform:translateX(0)}
      }
    `;
    document.head.appendChild(s);
  }

  function ensureInstBadge(){
    const head = document.getElementById('chat-header');
    if (!head) return null;

    let el = document.getElementById('inst-badge');
    if (el) return el;

    ensureInstBadgeStyle();

    el = document.createElement('div');
    el.id = 'inst-badge';
    el.innerHTML = `<span class="dot"></span><span id="inst-badge-text">WhatsApp: —</span>`;

    const title = document.getElementById('chat-title');
    if (title && title.parentNode) title.parentNode.appendChild(el);
    else head.appendChild(el);

    return el;
  }

  function zcUpdateInstBadge(){
    const el = ensureInstBadge();
    if (!el) return;

    const c = window.state?.clienteSel || state?.clienteSel || {};
    const v = norm(c.instancia_id ?? c.instancia ?? window.INSTANCIA_ATIVA ?? localStorage.getItem(LS_KEY) ?? '');
    const ok = !!v;

    const txt = document.getElementById('inst-badge-text');
    if (txt) txt.textContent = `WhatsApp: ${resolveInstLabel(v)}`;

    el.classList.toggle('is-none', !ok);
  }

  function zcFlashInstBadge(){
    try{
      const b = ensureInstBadge();
      if (!b) return;
      b.classList.add('shake');
      setTimeout(()=> b.classList.remove('shake'), 420);
    }catch{}
  }

  // Central: define instância ativa (persiste + emite evento)
  function setInstanciaAtiva(value, opt = {}){
    const v = norm(value);
    try { localStorage.setItem(LS_KEY, v); } catch {}
    window.INSTANCIA_ATIVA = v ? v : null;

    try { window.setInstanceChip?.(v); } catch {}
    try { zcUpdateInstBadge(); } catch {}

    try {
      document.dispatchEvent(new CustomEvent('inst:change', { detail: { value: window.INSTANCIA_ATIVA }}));
    } catch {}

    // por padrão, NÃO forçamos reload aqui (inst-switch já faz)
    if (opt && opt.reloadList) {
      try { carregarClientes?.({ force:true, reason:'inst:change' }); } catch {}
    }
  }

  function getInstanciaAtiva(){
    return norm(window.INSTANCIA_ATIVA ?? localStorage.getItem(LS_KEY) ?? '');
  }

  // exports globais
  window.zcEnsureInstanciasLoaded = ensureInstanciasLoaded;
  window.zcResolveInstLabel       = resolveInstLabel;
  window.zcUpdateInstBadge        = zcUpdateInstBadge;
  window.zcFlashInstBadge         = zcFlashInstBadge;
  window.setInstanciaAtiva        = setInstanciaAtiva;
  window.getInstanciaAtiva        = getInstanciaAtiva;

  // reações
  document.addEventListener('inst:change', () => { try { zcUpdateInstBadge(); } catch {} });
  document.addEventListener('inst:list', () => { try { zcUpdateInstBadge(); } catch {} });

  // tenta carregar lista cedo (pra ter nome “humano” no badge)
  ensureInstanciasLoaded().finally(() => { try { zcUpdateInstBadge(); } catch {} });
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
  if (hist) {
    hist.style.display = 'none';
    hist.innerHTML = '';
    hist.removeAttribute('data-cliente-id');
    hist.removeAttribute('data-instancia-id');
  }
  if (foot) foot.style.display = 'none';
  if (ws)   ws.style.display   = 'none';

  document.body.classList.remove('is-chat-open');
}

const onlyDigits = (s) => String(s||'').replace(/\D+/g,'');

/* ===== Helpers de instância ===== */
function getInstanciaForFetch(clienteId) {
  const sel = state?.clienteSel;

  if (sel && (sel.id === clienteId || sel.conversation_id === clienteId || sel.cliente_id === clienteId)) {
    const cand = sel.instancia_id ?? sel.instancia ?? window.getInstanciaAtiva?.() ?? window.INSTANCIA_ATIVA ?? null;
    return cand == null || cand === '' ? null : String(cand);
  }

  const c = (state.clientesCache || []).find(x => (x.id ?? x.conversation_id ?? x.cliente_id) === Number(clienteId));
  const cand = c?.instancia_id ?? c?.instancia ?? window.getInstanciaAtiva?.() ?? window.INSTANCIA_ATIVA ?? null;
  return (cand == null || cand === '') ? null : String(cand);
}

function syncInstanciaFromCliente(c){
  const instCand = c?.instancia_id ?? c?.instancia ?? null;
  const active = window.getInstanciaAtiva?.() ?? window.INSTANCIA_ATIVA ?? null;

  // se o cliente tem instância, sincroniza tudo (sem reload imediato)
  if (instCand != null && String(instCand).trim() !== '') {
    try { window.setInstanciaAtiva?.(String(instCand), { reloadList:false }); } catch {}
    return String(instCand);
  }

  // se não tem instância e existe ativa, usa a ativa
  if (active != null && String(active).trim() !== '') return String(active);

  return null;
}

/* ============ Carregar mensagens (sempre consulta backend) ============ */
async function ensureMensagensCarregadas(conversationId) {
  if (!state.mensagensOffset || typeof state.mensagensOffset !== 'object') {
    state.mensagensOffset = {};
  }

  const inst = getInstanciaForFetch(conversationId);

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
  const url = `/api/atendimento/conversas/${conversationId}/mensagens?` + qs.toString();

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
      msg_id:    m.msg_id || m.id || null,
      conteudo:  m.texto ?? m.conteudo ?? '',
      tipo:      tipoMsg,
      timestamp: m.ts || m.timestamp || new Date().toISOString(),
      ack:       isSaida ? ackNum : null,
      midias:    Array.isArray(m.midias) ? m.midias : [],
      instancia_id: m.instancia_id ?? (inst || null),
      origem:    m.origem ?? (isSaida ? 'atendente' : 'cliente'),
      autor_nome: m.autor_nome ?? m.atendente_nome ?? null,
    };
  });

  try { salvarNoCache(conversationId, mapped); } catch {}

  const finalHist = getHist(inst, conversationId) || [];

  state.cacheHistoricos = {
    ...(state.cacheHistoricos || {}),
    [conversationId]: (window.cacheHistoricos || {})[conversationId]
  };
  state.mensagensOffset[conversationId] = finalHist.length;
  persist();

  return finalHist;
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

  if (!c) {
    // se veio de agenda/search e não está no cache, ainda assim deixa quem chamou setar clienteSel antes
    // (agenda.js faz fallback). Aqui só garantimos badge atualizado.
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
      const cid = c.cliente_id ?? c.id ?? c.conversation_id ?? null;
      if (cid != null) head.dataset.clienteId = String(cid);
    }
  } catch {}

  // expor telefone pro perfil_quick.js
  try {
    const phone =
      c.telefone ?? c.tel ?? c.phone ?? c.whatsapp ?? c.telefone_norm ?? c.numero ?? c.number ?? null;

    const digits = String(phone || '').replace(/\D+/g,'');
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
    if (c.avatar_url) {
      const safeUrl = String(c.avatar_url).replace(/"/g,'&quot;');
      av.innerHTML = `<span class="avatar"><img src="${safeUrl}" alt="" data-cliente-id="${c.id}"
           onerror="window.handleAvatarError && window.handleAvatarError(this)"></span>`;
    } else {
      av.innerHTML =
        `<span class="avatar avatar-default"><i class="fa fa-user-circle text-2xl text-gray-400"></i></span>`;
    }
  }

  // click abre perfil
  try {
    const openPerfil = () => abrirPerfilAtual && abrirPerfilAtual(false);
    if (t)  { t.style.cursor = 'pointer';  t.onclick  = openPerfil; }
    if (av) { av.style.cursor = 'pointer'; av.onclick = openPerfil; }
  } catch {}

  // badge sempre atualizado
  try { window.zcUpdateInstBadge?.(); } catch {}

  try {
    await ensureMensagensCarregadas(id);
    renderHistoricoDoCache(id);
  } catch (e) {
    console.warn('[selecionarClienteObj] carregar mensagens falhou:', e?.message || e);
    // não limpa a tela aqui — só evita “pisca some”
    return;
  }

  if (!state.mensagensOffset || typeof state.mensagensOffset !== 'object') {
    state.mensagensOffset = {};
  }
  const inst = getInstanciaForFetch(id);
  state.mensagensOffset[id] = (getHist(inst, id) || []).length;

  updateOperatorBannerForConversation(id);

  try { window.syncPreviewFromCache?.(id); } catch {}
  await markChatAsSeen(id);

  // zera “unread” local
  try {
    window.Lista?.resetUnread?.(id);
    window.recomputeUnread?.();
  } catch {
    try {
      const arr = window.state?.clientesCache || window.clientesCache || [];
      const idx = arr.findIndex(x => Number(x.id ?? x.conversation_id ?? x.cliente_id) === Number(id));
      if (idx >= 0) {
        arr[idx].novas = 0;
        window.renderListaClientes?.(arr);
        window.recomputeUnread?.();
      }
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

    // tenta atualizar badge cedo (se header já existir)
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