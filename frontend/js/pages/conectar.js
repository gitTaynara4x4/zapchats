// /frontend/js/pages/conectar.js
import {
  ensureEmpresaWS, onEmpresaMessage, ensureInstWS, onInstMessage,
  closeEmpresaWS, closeInstWS
} from '/frontend/js/realtime/ws-core.js';

// ====== Config ======
const PREP_LOTTIE_URL = '/frontend/js/pages/lottie.json';
const PRESENCE_REFRESH_INTERVAL_MS = 30000;
const PRESENCE_COOLDOWN_MS = 15000;
const PRESENCE_CONCURRENCY = 4;

// ====== Estado ======
let wantQR = false;
let currentInstance = null;
let timerId = null;
let lastHistoricoUsed = 'none';

let lastWhatsPayload = null;
let presenceInFlight = false;
let presenceLoadTmr = null;
let presenceIntervalId = null;
const presenceCache = new Map();

let saudeLoadingTmr = null;
let saudeLoadingStepIdx = 0;
let saudeLoadingMsgIdx = 0;
let saudeCurrentItem = null;

// ===== Helpers =====
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const htmlEscape = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
));
const cssEscape = (s) => {
  try { return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g,'\\$&'); }
  catch { return String(s).replace(/["\\]/g,'\\$&'); }
};

function formatPhoneBR(num) {
  const d = onlyDigits(num);
  if (!d) return '—';
  if (d.length === 13) return `+${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.length === 12) return `+${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,8)}-${d.slice(8)}`;
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return `+${d}`;
}

function isConnectedPayload(m){
  if (m?.inst_status && typeof m.inst_status.connected !== 'undefined') {
    return !!m.inst_status.connected;
  }
  return m?.connected === true
      || String(m?.status || m?.state || '').toUpperCase() === 'CONNECTED'
      || String(m?.type || '').toLowerCase() === 'connected';
}

function badgeClassByStatus(status){
  const s = String(status || '').toLowerCase();
  if (s === 'critico') return 'saude-badge--critico';
  if (s === 'alto_risco') return 'saude-badge--alto';
  if (s === 'atencao') return 'saude-badge--atencao';
  return 'saude-badge--boa';
}

function scoreText(score){
  const n = Number(score || 0);
  if (n >= 80) return 'Crítico';
  if (n >= 60) return 'Alto risco';
  if (n >= 30) return 'Atenção';
  return 'Boa';
}

function formatMetricValue(v){
  if (v === null || typeof v === 'undefined' || v === '') return '—';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return String(v);
}

function formatDateTimeBR(iso){
  try{
    if (!iso) return '—';
    return new Date(iso).toLocaleString('pt-BR');
  }catch{
    return String(iso || '—');
  }
}

// Fail-safe do "prepaint"
window.addEventListener('load', () => {
  const html = document.documentElement;
  if (
    html.classList.contains('prepaint') &&
    !(html.hasAttribute('data-head-ready') && html.hasAttribute('data-loader-ready'))
  ) {
    html.classList.remove('prepaint');
  }
});

// ===== Auth/contexto =====
const empresaId = Number(localStorage.getItem('empresa_id') || localStorage.getItem('empresaId') || 0);
const token     = localStorage.getItem('token') || localStorage.getItem('auth_token') || '';
const authHeaders = {
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...(empresaId ? { 'X-Empresa-Id': String(empresaId) } : {}),
};

async function apiGet(url){
  const r = await fetch(url, { headers: { ...authHeaders }, credentials:'include' });
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    const t = await r.text();
    throw new Error(`GET ${url} → ${r.status}: ${t.slice(0,150)}`);
  }
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

async function apiPost(url, body){
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(body || {}),
    credentials: 'include'
  });
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const js = ct.includes('application/json') ? await r.json() : {};
  if (!r.ok || js?.ok === false) {
    throw new Error(js?.detail || js?.message || `POST ${url} → ${r.status}`);
  }
  return js;
}

async function apiPostSoft(url, body){
  try{
    await apiPost(url, body || {});
    return true;
  } catch {
    return false;
  }
}

async function apiDelete(url){
  const extra = 'cascade=0&force=1&delete_remote=1';
  const sep1 = url.includes('?') ? '&' : '?';
  const withParams = `${url}${sep1}${extra}`;
  const withEmp = (empresaId)
    ? `${withParams}&empresa_id=${encodeURIComponent(String(empresaId))}`
    : withParams;
  const r = await fetch(withEmp, { method: 'DELETE', headers: { ...authHeaders }, credentials:'include' });
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  let js = null;
  if (ct.includes('application/json')) { try { js = await r.json(); } catch {} }
  const ok = r.ok && (js?.ok !== false);
  return { ok, status: r.status, data: js };
}

// ✅ Base do Status: ping setPresence
async function pingSetPresence(instanceName, { force=false } = {}){
  if (!instanceName) return false;

  const now = Date.now();
  const cache = presenceCache.get(instanceName);
  if (!force && cache && (now - cache.ts) < PRESENCE_COOLDOWN_MS) {
    return !!cache.ok;
  }

  const ok = await apiPostSoft(`/instance/setPresence/${encodeURIComponent(instanceName)}`, {});
  presenceCache.set(instanceName, { ok: !!ok, ts: now });
  return !!ok;
}

function setDotStateByInstance(instanceName, { ok=null, loading=false } = {}){
  const sel = `.js-status-dot[data-inst="${cssEscape(instanceName)}"]`;
  const el = document.querySelector(sel);
  if (!el) return;

  el.classList.toggle('st-dot--loading', !!loading);

  if (ok === null) {
    el.classList.remove('st-dot--on','st-dot--off');
    return;
  }
  el.classList.toggle('st-dot--on',  !!ok);
  el.classList.toggle('st-dot--off', !ok);
  el.title = ok ? 'Ativo' : 'Inativo';
}

function schedulePresenceRefresh(ms=250, opts={}){
  clearTimeout(presenceLoadTmr);
  presenceLoadTmr = setTimeout(() => {
    if (document.hidden) return;
    void refreshPresenceStatuses(opts);
  }, ms);
}

async function refreshPresenceStatuses({ force=false, onlyInstances=null } = {}){
  if (!empresaId) return;
  if (presenceInFlight) return;
  if (!Array.isArray(allItems) || allItems.length === 0) return;

  presenceInFlight = true;
  try{
    const list = Array.isArray(onlyInstances) && onlyInstances.length
      ? allItems.filter(it => onlyInstances.includes(it.instance_name))
      : allItems.slice();

    if (!list.length) return;

    for (const it of list) setDotStateByInstance(it.instance_name, { loading:true });

    let idx = 0;
    let changedAny = false;

    async function worker(){
      while (idx < list.length){
        const it = list[idx++];
        const inst = it?.instance_name;
        if (!inst) continue;

        let ok = false;
        try { ok = await pingSetPresence(inst, { force }); } catch { ok = false; }

        setDotStateByInstance(inst, { ok, loading:false });

        const prev = !!it.connected;
        it.connected = !!ok;
        if (prev !== !!ok) changedAny = true;
      }
    }

    await Promise.all(Array.from({ length: PRESENCE_CONCURRENCY }, () => worker()));

    if (changedAny) {
      const totalAtivos   = allItems.filter(it => !!it.connected).length;
      const totalInativos = allItems.length - totalAtivos;

      updateTabCounts(totalAtivos, totalInativos);

      if (lastWhatsPayload) {
        updateTopTotal(lastPlanLabel, lastWhatsPayload, allItems);
        updateAddButton(lastWhatsPayload, allItems);
      }

      renderList(filterItemsByTab(allItems), lastPlanLabel);
    }
  } finally {
    presenceInFlight = false;
  }
}

// ===== Elementos =====
const els = {
  tabAtivos:   $('button[data-tab="ativos"]'),
  tabInativos: $('button[data-tab="inativos"]'),
  placeholder: $('#placeholder-zap'),
  table:       $('#lista-zap'),
  tbody:       $('#lista-zap tbody'),
  btnAdd:      $('#btn-open-modal'),
  countPro:    $('#count-pro'),

  modal:       $('#modal'),
  btnCloseMd:  $('#btn-close-modal'),
  form:        $('#form-conectar'),
  inApelido:   $('#form-conectar input[name="apelido"]'),
  inNumero:    $('#numero'),
  selPais:     $('#pais-select'),
  selHist:     $('#historico-select'),
  chkPairing:  $('#use-pairing'),
  btnGerarQR:  $('#btn-gerar-qr'),
  btnCancel:   $('#btn-cancel'),
  btnRefresh:  $('#btn-refresh'),

  qrCanvas:    $('#qr-canvas'),
  qrImg:       $('#qr-img'),
  qrLoader:    $('#qr-loader'),
  qrTimerWrap: $('#qr-timer'),
  qrTimerCnt:  $('#qr-timer-count'),
  qrInstru:    $('#qr-instru'),
  qrErro:      $('#qr-erro'),
  qrIllustration: $('#qr-illustration'),

  modalRem:      $('#modal-remover-numero'),
  btnRemYes:     $('#btn-confirmar-remover'),
  btnRemNo:      $('#btn-cancelar-remover'),
  remConsent:    $('#rem-consent'),

  modalSaude: $('#modal-saude-numero'),
  btnCloseSaude: $('#btn-close-saude'),
  btnFecharSaude: $('#btn-fechar-saude'),
  btnReanalisarSaude: $('#btn-reanalisar-saude'),
  saudeSubtitle: $('#saude-modal-subtitle'),
  saudeLoading: $('#saude-loading'),
  saudeLoadingText: $('#saude-loading-text'),
  saudeResult: $('#saude-result'),
  saudeError: $('#saude-error'),
  saudeLabelBadge: $('#saude-label-badge'),
  saudeScoreLine: $('#saude-score-line'),
  saudeScoreNumber: $('#saude-score-number'),
  saudeResumo: $('#saude-resumo'),
  saudeMotivos: $('#saude-motivos'),
  saudeRecomendacoes: $('#saude-recomendacoes'),
  saudeMetricas: $('#saude-metricas'),
  saudeConsultadoEm: $('#saude-consultado-em'),
};

const modalPanel = $('#modal .modal-panel, #modal .modal-card, #modal .card, #modal > div');
const modalTitle = $('#modal [data-modal-title], #modal .modal-title, #modal h3, #modal h2');

const setModalTitle = (t) => { if (modalTitle) modalTitle.textContent = t; };

function showModal(){
  if (!els.modal) return;
  els.modal.classList.remove('hidden');
}

function hideModal(){
  if (!els.modal) return;
  els.modal.classList.add('hidden');
}

// ===== Modal Saúde =====
function openSaudeModal(){
  els.modalSaude?.classList.remove('hidden');
}

function closeSaudeModal(){
  clearInterval(saudeLoadingTmr);
  saudeLoadingTmr = null;
  saudeCurrentItem = null;
  els.modalSaude?.classList.add('hidden');
}

function resetSaudeModal(){
  clearInterval(saudeLoadingTmr);
  saudeLoadingTmr = null;
  saudeLoadingStepIdx = 0;
  saudeLoadingMsgIdx = 0;

  els.saudeError?.classList.add('hidden');
  if (els.saudeError) els.saudeError.textContent = '';

  els.saudeResult?.classList.add('hidden');
  els.saudeLoading?.classList.remove('hidden');
  els.btnReanalisarSaude?.classList.add('hidden');

  const msg = 'Analisando padrão das últimas mensagens...';
  if (els.saudeLoadingText) els.saudeLoadingText.textContent = msg;

  const steps = $$('#saude-loading .saude-step');
  steps.forEach((el, idx) => el.classList.toggle('active', idx === 0));
}

function startSaudeLoadingAnimation(){
  const msgs = [
    'Analisando padrão das últimas mensagens...',
    'Verificando repetição de conteúdo...',
    'Calculando velocidade de envio...',
    'Medindo taxa de resposta...',
    'Montando diagnóstico do número...'
  ];

  const steps = $$('#saude-loading .saude-step');
  clearInterval(saudeLoadingTmr);

  saudeLoadingTmr = setInterval(() => {
    saudeLoadingMsgIdx = (saudeLoadingMsgIdx + 1) % msgs.length;
    saudeLoadingStepIdx = (saudeLoadingStepIdx + 1) % Math.max(steps.length, 1);

    if (els.saudeLoadingText) els.saudeLoadingText.textContent = msgs[saudeLoadingMsgIdx];
    steps.forEach((el, idx) => el.classList.toggle('active', idx === saudeLoadingStepIdx));
  }, 1200);
}

function fillSaudeList(container, items, fallback){
  if (!container) return;
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  container.innerHTML = '';
  if (!arr.length){
    const li = document.createElement('li');
    li.textContent = fallback;
    container.appendChild(li);
    return;
  }
  arr.forEach(txt => {
    const li = document.createElement('li');
    li.textContent = txt;
    container.appendChild(li);
  });
}

function renderSaudeMetricas(metricas){
  if (!els.saudeMetricas) return;
  const m = metricas || {};
  const rows = [
    ['Mensagens analisadas', formatMetricValue(m.mensagens_analisadas)],
    ['Mensagens de saída', formatMetricValue(m.saidas)],
    ['Mensagens de entrada', formatMetricValue(m.entradas)],
    ['Repetição', `${formatMetricValue(m.repeticao_pct)}%`],
    ['Intervalo médio', m.intervalo_medio_seg == null ? '—' : `${formatMetricValue(m.intervalo_medio_seg)} s`],
    ['Sem resposta', `${formatMetricValue(m.taxa_sem_resposta_pct)}%`],
  ];

  els.saudeMetricas.innerHTML = rows.map(([k, v]) => `
    <div class="saude-metrica-item">
      <span class="saude-metrica-label">${htmlEscape(k)}</span>
      <strong class="saude-metrica-value">${htmlEscape(v)}</strong>
    </div>
  `).join('');
}

function renderSaudeResult(item, payload){
  clearInterval(saudeLoadingTmr);
  saudeLoadingTmr = null;

  const saude = payload?.saude || {};
  const score = Number(saude.score || payload?.score || 0);
  const label = saude.label || scoreText(score);
  const status = saude.status || 'boa';

  els.saudeLoading?.classList.add('hidden');
  els.saudeResult?.classList.remove('hidden');
  els.btnReanalisarSaude?.classList.remove('hidden');

  if (els.saudeSubtitle) {
    const nome = item?.apelido || item?.instance_name || 'Instância';
    const numero = formatPhoneBR(item?.numero_instancia || '');
    els.saudeSubtitle.textContent = `${nome} • ${numero}`;
  }

  if (els.saudeLabelBadge) {
    els.saudeLabelBadge.className = `saude-badge ${badgeClassByStatus(status)}`;
    els.saudeLabelBadge.textContent = label;
  }

  if (els.saudeScoreNumber) els.saudeScoreNumber.textContent = String(score);
  if (els.saudeScoreLine) els.saudeScoreLine.textContent = `Score: ${score}/100`;
  if (els.saudeResumo) els.saudeResumo.textContent = saude.resumo || 'Sem resumo disponível.';

  fillSaudeList(
    els.saudeMotivos,
    saude.motivos,
    'Nenhum sinal forte de risco foi encontrado nesta análise.'
  );

  fillSaudeList(
    els.saudeRecomendacoes,
    saude.recomendacoes,
    'Continue mantendo uma comunicação natural e variada.'
  );

  renderSaudeMetricas(saude.metricas || {});

  if (els.saudeConsultadoEm) {
    els.saudeConsultadoEm.textContent = `Consultado em: ${formatDateTimeBR(saude.consultado_em)}`;
  }

  if (item) {
    item.score = score;
    item.saude_status = status;
    item.saude_label = label;
  }
}

function showSaudeError(msg){
  clearInterval(saudeLoadingTmr);
  saudeLoadingTmr = null;
  els.saudeLoading?.classList.add('hidden');
  els.saudeResult?.classList.add('hidden');
  if (els.saudeError) {
    els.saudeError.textContent = msg || 'Não foi possível consultar a saúde do número.';
    els.saudeError.classList.remove('hidden');
  }
  els.btnReanalisarSaude?.classList.remove('hidden');
}

async function consultarSaudeNumero(item, { force=true } = {}){
  if (!item?.id) return;

  saudeCurrentItem = item;
  openSaudeModal();
  resetSaudeModal();
  startSaudeLoadingAnimation();

  try{
    const res = await apiPost(
      `/api/onboarding/empresas/instancias/${encodeURIComponent(item.id)}/saude`,
      {
        empresa_id: empresaId,
        limite_mensagens: 200,
        janela_horas: 24,
        forcar_recalculo: !!force
      }
    );

    renderSaudeResult(item, res);
    toast('Saúde do Número consultada com sucesso.');
  } catch (e) {
    showSaudeError(e?.message || 'Não foi possível consultar a saúde do número.');
  }
}

// ===== Lottie =====
function loadLottie(){
  return new Promise((resolve) => {
    if (window.lottie && window.lottie.loadAnimation) {
      return resolve(window.lottie);
    }
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js';
    sc.async = true;
    sc.onload = () => resolve(window.lottie);
    sc.onerror = () => resolve(null);
    document.head.appendChild(sc);
  });
}

// ===== Overlay =====
const prep = { active:false, left:0, tmr:null, anim:null, seq:[], seqIdx:0, seqTmr:null, historico:'none' };

function ensureOverlay(){
  let ovl = document.getElementById('sync-overlay');
  if (ovl) return ovl;
  ovl = document.createElement('div');
  ovl.id = 'sync-overlay';
  ovl.innerHTML = `
    <div class="sync-wrap" role="dialog" aria-live="polite">
      <div id="prep-ovl-lottie"></div>
      <div id="prep-ovl-status" class="think">
        Sincronizando seus contatos<span class="typing" aria-hidden="true"><span></span><span></span><span></span></span>
      </div>
      <div id="prep-ovl-title">Estamos organizando tudo para você.</div>
      <div id="prep-ovl-sub">Esta ação pode demorar um pouco.</div>
      <div id="prep-ovl-time"><span class="time-pill">01:00</span></div>
    </div>
  `;
  document.body.appendChild(ovl);
  return ovl;
}

function formatClock(s){
  const mm = String(Math.floor(s/60)).padStart(2,'0');
  const ss = String(s%60).padStart(2,'0');
  return `${mm}:${ss}`;
}

function statusHTML(txt){
  return `${htmlEscape(txt)}<span class="typing" aria-hidden="true"><span></span><span></span><span></span></span>`;
}

function setStatus(txt, fade=true){
  const el = $('#prep-ovl-status');
  if (!el) return;
  el.innerHTML = statusHTML(txt);
  el.classList.remove('fade');
  void el.offsetWidth;
  if (fade) el.classList.add('fade');
}

function pickSequence(historico){
  if ((historico||'none') === 'none') return ['Sincronizando seus contatos...'];
  return [
    'Sincronizando suas mensagens...',
    'Sincronizando seus contatos...',
    'Sincronizando suas imagens...',
    'Sincronizando seus vídeos...',
    'Sincronizando seus documentos...',
    'Sincronizando seus áudios...',
  ];
}

function startStatusLoop(){
  clearInterval(prep.seqTmr);
  const items = prep.seq;
  if (!items.length) return;
  prep.seqIdx = 0;
  setStatus(items[0], true);
  prep.seqTmr = setInterval(() => {
    prep.seqIdx = (prep.seqIdx + 1) % items.length;
    setStatus(items[prep.seqIdx], true);
  }, 4000);
}

function paintTime(){
  const pill = $('#prep-ovl-time .time-pill');
  if (pill) pill.textContent = formatClock(prep.left);
}

async function showPrepOverlayOneMinute(seconds=60, opts={}){
  if (prep.active) return;
  prep.active = true;
  prep.left = Math.max(1, Math.floor(seconds));
  prep.historico = String(opts?.historico || 'none');

  const ovl = ensureOverlay();
  ovl.classList.add('show');
  document.body.style.overflow = 'hidden';

  try {
    const lottie = await loadLottie();
    const slot = $('#prep-ovl-lottie', ovl);
    if (lottie && slot) {
      const data = await fetch(PREP_LOTTIE_URL, { cache:'no-store' }).then(r => r.json());
      prep.anim = lottie.loadAnimation({
        container: slot,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        animationData: data
      });
    }
  } catch {}

  prep.seq = pickSequence(prep.historico);
  startStatusLoop();

  paintTime();
  clearInterval(prep.tmr);
  prep.tmr = setInterval(() => {
    prep.left -= 1;
    if (prep.left <= 0) {
      hidePrepOverlay();
    } else {
      paintTime();
    }
  }, 1000);
}

function hidePrepOverlay(){
  const ovl = ensureOverlay();
  prep.active = false;
  clearInterval(prep.tmr);     prep.tmr = null;
  clearInterval(prep.seqTmr);  prep.seqTmr = null;
  try { prep.anim?.destroy?.(); } catch {}
  prep.anim = null;
  ovl.classList.remove('show');
  document.body.style.overflow = '';
}

// ===== CSS injetado =====
(function injectCSS(){
  const css = `
  .hidden{ display:none !important; }

  .kebab-btn{
    border:1px solid #e5e7eb;
    border-radius:8px;
    padding:6px 10px;
    background:#fff;
    display:inline-flex;
    align-items:center;
    justify-content:center;
  }
  html.dark .kebab-btn{
    background:#161617;
    border-color:#27272a;
    color:#e5e7eb;
  }
  .kebab-menu{
    position:absolute;
    right:0;
    margin-top:8px;
    background:#fff;
    border:1px solid #e5e7eb;
    border-radius:10px;
    box-shadow:0 10px 30px rgba(0,0,0,.15);
    min-width:220px;
    z-index:50;
    display:none;
  }
  .kebab-menu.show{ display:block; }
  html.dark .kebab-menu{
    background:#161617;
    border-color:#27272a;
  }
  .kebab-item{
    display:block;
    width:100%;
    text-align:left;
    padding:10px 12px;
    background:transparent;
    border:0;
    font-size:14px;
  }
  .kebab-item:hover{ background:rgba(0,0,0,.04); }
  html.dark .kebab-item:hover{ background:rgba(255,255,255,.06); }

  .st-dot{
    display:inline-block;
    width:10px;
    height:10px;
    border-radius:999px;
    background:#9ca3af;
    vertical-align:middle;
  }
  .st-dot--on{  background:#22c55e; }
  .st-dot--off{ background:#9ca3af; }
  .st-dot--loading{ opacity:.55; filter:saturate(.2); }

  .saude-inline{
    display:flex;
    align-items:center;
    gap:.55rem;
    flex-wrap:wrap;
  }
  .saude-chip-sm{
    display:inline-flex;
    align-items:center;
    padding:.24rem .55rem;
    border-radius:999px;
    font-size:.74rem;
    font-weight:800;
    letter-spacing:.01em;
    border:1px solid transparent;
  }
  .saude-chip-sm--boa{
    background:rgba(34,197,94,.12);
    color:#15803d;
    border-color:rgba(34,197,94,.22);
  }
  .saude-chip-sm--atencao{
    background:rgba(245,158,11,.14);
    color:#b45309;
    border-color:rgba(245,158,11,.26);
  }
  .saude-chip-sm--alto{
    background:rgba(239,68,68,.12);
    color:#dc2626;
    border-color:rgba(239,68,68,.22);
  }
  .saude-chip-sm--critico{
    background:rgba(127,29,29,.12);
    color:#991b1b;
    border-color:rgba(127,29,29,.22);
  }
  html.dark .saude-chip-sm--boa{ color:#86efac; }
  html.dark .saude-chip-sm--atencao{ color:#fcd34d; }
  html.dark .saude-chip-sm--alto{ color:#fca5a5; }
  html.dark .saude-chip-sm--critico{ color:#fca5a5; }

  #sync-overlay{
    position:fixed;
    inset:0;
    display:none;
    align-items:center;
    justify-content:center;
    z-index:9999;
    background: radial-gradient(1000px 420px at 50% 30%, rgba(23,23,23,.88), rgba(0,0,0,.92));
    backdrop-filter: blur(2px);
  }
  #sync-overlay.show{ display:flex; }
  #sync-overlay .sync-wrap{
    text-align:center;
    color:#e5e7eb;
    user-select:none;
    background: transparent;
    border: 0;
    padding: clamp(6px,1.4vw,10px) 8px 14px;
    border-radius: 28px;
    max-width: min(680px, 92vw);
    width: 100%;
    margin: 0 auto;
  }
  #prep-ovl-lottie{
    width:  clamp(180px, 26vw, 320px);
    height: clamp(180px, 26vw, 320px);
    margin: 0 auto 6px;
  }

  #prep-ovl-status{
    font-weight:400;
    letter-spacing:.02em;
    margin:.2rem 0 .35rem;
    font-size:clamp(12px,1.1vw,13px);
    opacity:.96;
  }
  #prep-ovl-status.fade{animation:prepFade .55s ease}
  @keyframes prepFade{
    from{opacity:0;transform:translateY(4px)}
    to{opacity:1;transform:none}
  }

  .typing{
    display:inline-flex;
    align-items:center;
    gap:4px;
    margin-left:6px;
  }
  .typing span{
    width:6px;
    height:6px;
    border-radius:50%;
    background: currentColor;
    opacity:.35;
    transform: translateY(0) scale(.9);
    animation: typingBlink 1.2s infinite ease-in-out;
  }
  .typing span:nth-child(2){ animation-delay: .2s; }
  .typing span:nth-child(3){ animation-delay: .4s; }
  @keyframes typingBlink{
    0%,20%   { opacity:.25; transform: translateY(0)    scale(.9); }
    50%      { opacity:1;    transform: translateY(-2px) scale(1); }
    80%,100% { opacity:.25; transform: translateY(0)    scale(.9); }
  }
  @media (prefers-reduced-motion: reduce){
    .typing span{ animation:none !important; }
    #prep-ovl-status.fade{ animation:none !important; }
  }

  #prep-ovl-title{
    font-weight:800;
    letter-spacing:.01em;
    font-size:clamp(16px,1.6vw,20px);
    margin:.1rem 0 .1rem;
  }
  #prep-ovl-sub{
    opacity:.85;
    font-size:clamp(12px,1.2vw,13px);
    margin-bottom:.35rem;
  }
  #prep-ovl-time{
    font-variant-numeric: tabular-nums;
    letter-spacing:.02em;
    font-size:clamp(12px,1.2vw,13px);
    opacity:.95;
  }
  .time-pill{
    display:inline-flex;
    align-items:center;
    justify-content:center;
    min-width:70px;
    padding:.18rem .5rem;
    border-radius:999px;
    background:rgba(255,255,255,.06);
  }
  `;
  const s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
})();

// ===== Lista de instâncias =====
function rowHTML(item, planLabel){
  const apelido = htmlEscape(item.apelido || item.instance_name || '');
  const numero  = formatPhoneBR(item.numero_instancia);
  const inst    = htmlEscape(String(item.instance_name || ''));

  const statusCls = item.connected ? 'st-dot--on' : 'st-dot--off';
  const status = `<span class="st-dot ${statusCls} js-status-dot" data-inst="${inst}" title="${item.connected ? 'Ativo' : 'Inativo'}"></span>`;

  const saudeClass = (() => {
    const s = String(item.saude_status || '').toLowerCase();
    if (s === 'critico') return 'saude-chip-sm--critico';
    if (s === 'alto_risco') return 'saude-chip-sm--alto';
    if (s === 'atencao') return 'saude-chip-sm--atencao';
    return 'saude-chip-sm--boa';
  })();

  const saudeLabel = htmlEscape(item.saude_label || scoreText(item.score || 0));

  const menuItems = [];
  menuItems.push('<button class="kebab-item js-saude">Saúde do Número</button>');
  if (!item.connected) menuItems.push('<button class="kebab-item js-reconnect">Reconectar</button>');
  menuItems.push('<button class="kebab-item js-remove">Remover número</button>');

  return `
    <tr class="border-b last:border-0 relative" data-id="${htmlEscape(String(item.id))}" data-instance="${inst}">
      <td class="py-2">${apelido || '—'}</td>
      <td class="py-2">${numero}</td>
      <td class="py-2"><span class="plan-pill">${htmlEscape(planLabel)}</span></td>
      <td class="py-2">
        <div class="saude-inline">
          ${status}
          <span class="saude-chip-sm ${saudeClass}">${saudeLabel}</span>
        </div>
      </td>
      <td class="py-2 text-right">
        <button class="kebab-btn" aria-haspopup="true" aria-expanded="false" aria-label="Ações">
          <i class="fa-solid fa-ellipsis-vertical"></i>
        </button>
        <div class="kebab-menu">${menuItems.join('')}</div>
      </td>
    </tr>
  `;
}

function bindRowEvents(tr, item){
  const btn  = $('.kebab-btn', tr);
  const menu = $('.kebab-menu', tr);

  if (btn && menu){
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      $$('.kebab-menu').forEach(m => { if (m!==menu) m.classList.remove('show'); });
      menu.classList.toggle('show');
      btn.setAttribute('aria-expanded', menu.classList.contains('show') ? 'true' : 'false');
    });
  }

  const btnSaude = $('.js-saude', tr);
  if (btnSaude){
    btnSaude.addEventListener('click', async () => {
      menu.classList.remove('show');
      await consultarSaudeNumero(item, { force:true });
      renderList(filterItemsByTab(allItems), lastPlanLabel);
    });
  }

  const btnRem = $('.js-remove', tr);
  if (btnRem){
    btnRem.addEventListener('click', () => {
      menu.classList.remove('show');
      openRemoveModal(item);
    });
  }

  const btnRec = $('.js-reconnect', tr);
  if (btnRec){
    btnRec.addEventListener('click', async () => {
      menu.classList.remove('show');
      await openReconnect(item);
    });
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.kebab-btn') && !e.target.closest('.kebab-menu')) {
    $$('.kebab-menu').forEach(m => m.classList.remove('show'));
  }
});

function renderList(items, planLabel){
  if (!els.tbody) return;
  els.tbody.innerHTML = '';

  if (!Array.isArray(items) || items.length === 0){
    els.table?.classList.add('hidden');
    els.placeholder?.classList.remove('hidden');
    return;
  }

  els.placeholder?.classList.add('hidden');
  els.table?.classList.remove('hidden');

  const tpl = document.createElement('template');
  const frag = document.createDocumentFragment();

  for (const it of items){
    tpl.innerHTML = rowHTML(it, planLabel).trim();
    const tr = tpl.content.firstElementChild;
    frag.appendChild(tr);
    bindRowEvents(tr, it);
  }
  els.tbody.appendChild(frag);
}

// ===== Tabs =====
let allItems = [];
let currentTab = 'ativos';
let lastPlanLabel = '—';

function filterItemsByTab(list){
  return currentTab === 'ativos'
    ? list.filter(i => !!i.connected)
    : list.filter(i => !i.connected);
}

function activateTab(tab){
  currentTab = tab;
  renderList(filterItemsByTab(allItems), lastPlanLabel);
}

els.tabAtivos?.addEventListener('click', () => activateTab('ativos'));
els.tabInativos?.addEventListener('click', () => activateTab('inativos'));

// ===== Contadores / limite / botão adicionar =====
function updateTabCounts(totalAtivos, totalInativos){
  if (els.tabAtivos)   els.tabAtivos.textContent   = `Ativos (${totalAtivos})`;
  if (els.tabInativos) els.tabInativos.textContent = `Inativos (${totalInativos})`;
}

function getInstanceLimit(payload){
  const raw =
    payload?.limite_instancias ??
    payload?.max_instancias ??
    payload?.limite;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function updateTopTotal(tier, payload, list){
  if (!els.countPro) return;
  const t = String(tier || 'FREE').toUpperCase();
  const total = Array.isArray(list) ? list.length : 0;
  const limit = getInstanceLimit(payload);

  if (limit !== null) {
    els.countPro.textContent = `${t} ${total}/${limit}`;
  } else {
    els.countPro.textContent = `${t} ${total}`;
  }
}

function updateAddButton(payload, list){
  if (!els.btnAdd) return;

  const total = Array.isArray(list) ? list.length : 0;
  const limit = getInstanceLimit(payload);
  const hasLimit = (limit !== null);
  const canAdd = !hasLimit || total < limit;

  els.btnAdd.disabled = !canAdd;
  els.btnAdd.setAttribute('aria-disabled', canAdd ? 'false' : 'true');
  els.btnAdd.classList.toggle('btn--ok', canAdd);

  if (canAdd) {
    els.btnAdd.title = 'Adicionar novo número ZapChats';
  } else {
    els.btnAdd.title = 'Limite de números de WhatsApp atingido para o seu plano';
  }
}

// ===== Loader de status =====
let loadTmr = null, inFlight = false, pendingReload = false;

function scheduleLoad(ms=500){
  pendingReload = true;
  clearTimeout(loadTmr);
  loadTmr = setTimeout(() => {
    if (!inFlight) void loadWhatsAppStatus();
  }, ms);
}

async function loadWhatsAppStatus(){
  if (!empresaId) return;
  if (inFlight) { pendingReload = true; return; }
  inFlight = true;
  pendingReload = false;

  try{
    const js = await apiGet(`/api/empresas/${empresaId}/whatsapp`);
    lastWhatsPayload = js;

    const tier = String(js?.effective_tier || js?.assinatura || 'FREE').toUpperCase();

    const list = Array.isArray(js?.instancias)
      ? js.instancias.map(i => ({
          id: i.id,
          instance_name: i.instance_name,
          apelido: i.apelido || '',
          numero_instancia: i.numero_instancia || '',
          connected: isConnectedPayload(i),
          last_seen: i.last_seen || null,
          score: Number(i.score || 0),
          saude_status: i.saude_status || '',
          saude_label: i.saude_label || ''
        }))
      : [];

    allItems = list;
    lastPlanLabel = tier;

    const totalAtivos   = list.filter(it => it.connected).length;
    const totalInativos = list.length - totalAtivos;

    updateTabCounts(totalAtivos, totalInativos);
    updateTopTotal(tier, js, list);
    updateAddButton(js, list);

    renderList(filterItemsByTab(allItems), tier);
    schedulePresenceRefresh(150, { force:false });

  }catch(e){
    console.error(e);
  } finally{
    inFlight = false;
    if (pendingReload) {
      pendingReload = false;
      scheduleLoad(200);
    }
  }
}

// ===== QR helpers =====
function secondsFromLimit(raw){
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 60;
  if (n > 300) return Math.round(n / 1000);
  if (n <= 5)  return Math.round(n * 60);
  return Math.round(n);
}

function hideIllustration(){ els.qrIllustration?.classList.add('hidden'); }
function showIllustration(){ els.qrIllustration?.classList.remove('hidden'); }

function hideQR(){
  els.qrImg?.classList.add('hidden');
  els.qrCanvas?.classList.add('hidden');
  const ctx = els.qrCanvas?.getContext?.('2d');
  if (ctx) ctx.clearRect(0,0,els.qrCanvas.width, els.qrCanvas.height);
  els.qrTimerWrap?.classList.add('hidden');
  els.qrInstru?.classList.add('hidden');
  els.qrLoader?.classList.add('hidden');
}

function showQRError(msg){
  if (!els.qrErro) return;
  if (msg) {
    els.qrErro.textContent = msg;
    els.qrErro.classList.remove('hidden');
  } else {
    els.qrErro.textContent = '';
    els.qrErro.classList.add('hidden');
  }
}

function startTimer(sec){
  clearInterval(timerId);
  if (!Number.isFinite(sec) || sec<=0 || !els.qrTimerWrap || !els.qrTimerCnt) return;
  let left = Math.floor(sec);
  els.qrTimerCnt.textContent = String(left);
  els.qrTimerWrap.classList.remove('hidden');
  if (els.btnRefresh) {
    els.btnRefresh.disabled = true;
    els.btnRefresh.classList.add('opacity-60','cursor-not-allowed');
  }
  timerId = setInterval(() => {
    left -= 1;
    if (left <= 0){
      clearInterval(timerId);
      timerId=null;
      els.qrTimerCnt.textContent = '0';
      if (els.btnRefresh) {
        els.btnRefresh.disabled = false;
        els.btnRefresh.classList.remove('opacity-60','cursor-not-allowed');
        els.btnRefresh.focus?.();
      }
    } else {
      els.qrTimerCnt.textContent = String(left);
    }
  }, 1000);
}

function renderQRFromBase64(b64, limit){
  if (!b64 || !els.qrImg) return;
  const src = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
  els.qrLoader?.classList.add('hidden');
  hideIllustration();
  els.qrCanvas?.classList.add('hidden');
  els.qrImg.src = src;
  els.qrImg.classList.remove('hidden');
  els.qrInstru?.classList.remove('hidden');
  if (limit) startTimer(secondsFromLimit(limit));
  els.btnGerarQR?.classList.add('hidden');
  els.btnRefresh?.classList.remove('hidden');
}

function renderQRFromText(text, limit){
  if (!els.qrCanvas) return;
  els.qrLoader?.classList.add('hidden');
  hideIllustration();
  try{
    new QRious({
      element: els.qrCanvas,
      value: String(text),
      size: 208,
      level: 'M'
    });
    els.qrCanvas.classList.remove('hidden');
    els.qrImg?.classList.add('hidden');
    els.qrInstru?.classList.remove('hidden');
    if (limit) startTimer(secondsFromLimit(limit));
    els.btnGerarQR?.classList.add('hidden');
    els.btnRefresh?.classList.remove('hidden');
  }catch(e){
    showQRError('Falha ao gerar QR. Tente novamente.');
  }
}

function renderQRFromResponse(qr){
  if (!qr || typeof qr !== 'object') return false;
  if (qr.base64) {
    renderQRFromBase64(qr.base64, qr.limit);
    return true;
  }
  if (qr.pairingCode) {
    renderQRFromText(qr.pairingCode, qr.limit);
    return true;
  }
  return false;
}

// ===== Conectado → overlay =====
function handleConnected(instanceFromMsg){
  if (currentInstance && instanceFromMsg && instanceFromMsg !== currentInstance) return;
  clearInterval(timerId);
  hideQR();
  try { hideModal(); } catch {}
  wantQR = false;
  showPrepOverlayOneMinute(60, { historico: lastHistoricoUsed });
  scheduleLoad(200);

  if (instanceFromMsg) schedulePresenceRefresh(200, { force:true, onlyInstances:[instanceFromMsg] });
}

// ===== WebSockets =====
let offEmp = null, offInst = null;

function attachEmpresaWS() {
  if (!empresaId) return;
  ensureEmpresaWS(empresaId);
  if (offEmp) { try { offEmp(); } catch {} offEmp = null; }
  offEmp = onEmpresaMessage(empresaId, (evt) => {
    if (evt.type !== 'message') return;
    const m = evt.data || {};
    if (m?.reload_whatsapp || m?.type === 'reload_whatsapp') {
      scheduleLoad(200);
      return;
    }
    if (m?.type === 'qrcode' && wantQR) {
      if (m.waiting) {
        els.qrLoader?.classList.remove('hidden');
        showIllustration();
        hideQR();
        return;
      }
      const ttl = m.qr_limit ?? m.expires_in ?? m.ttl ?? 60;
      if (m.base64)           renderQRFromBase64(m.base64, ttl);
      else if (m.pairingCode) renderQRFromText(m.pairingCode, ttl);
      return;
    }
    if (m?.type === 'connection' || m?.type === 'connected' || m?.status || m?.state || m?.inst_status){
      if (isConnectedPayload(m)) {
        const instName =
          (m.inst_status?.instance) ||
          m.instance ||
          m.instance_name ||
          m.instancia ||
          null;
        handleConnected(instName);
        scheduleLoad(200);
      }
    }
  });
}

function attachInstWS(instance) {
  if (offInst) { try { offInst(); } catch {} offInst = null; }
  if (!instance) return;
  ensureInstWS(instance);
  offInst = onInstMessage(instance, (evt) => {
    if (evt.type !== 'message') return;
    const m = evt.data || {};
    if (m?.type === 'qrcode' && wantQR) {
      if (m.waiting) {
        els.qrLoader?.classList.remove('hidden');
        showIllustration();
        hideQR();
        return;
      }
      const ttl = m.qr_limit ?? m.expires_in ?? m.ttl ?? 60;
      if (m.base64)           renderQRFromBase64(m.base64, ttl);
      else if (m.pairingCode) renderQRFromText(m.pairingCode, ttl);
      return;
    }
    if (m?.type === 'connection' || m?.type === 'connected' || m?.status || m?.state) {
      if (isConnectedPayload(m)) {
        const instName = m.instance || m.instance_name || m.instancia || null;
        handleConnected(instName);
        scheduleLoad(200);
      }
    }
  });
}

// ===== Carga principal / submit =====
async function handleConnectSubmit(ev){
  ev.preventDefault?.();
  showQRError('');
  hideQR();
  els.qrLoader?.classList.remove('hidden');
  showIllustration();

  const apelido   = els.inApelido?.value?.trim() || '';
  const numero    = onlyDigits(els.inNumero?.value);
  const ddi       = onlyDigits(els.selPais?.value) || '55';
  const historico = els.selHist?.value || 'none';
  const usePairing = !!els.chkPairing?.checked;

  if (!numero){
    els.qrLoader?.classList.add('hidden');
    showQRError('Informe um número de telefone válido.');
    return;
  }

  const e164 = `+${ddi}${numero}`;

  try{
    const js = await apiPost('/api/onboarding/empresas/conectar', {
      empresa_id: empresaId,
      whatsapp_numero: e164,
      historico_restaurar: historico,
      instance_name: null,
      use_pairing: usePairing,
      apelido: apelido || null
    });

    lastHistoricoUsed = historico || 'none';

    currentInstance = js?.instance || null;
    window.currentInstance = currentInstance;

    if (currentInstance) attachInstWS(currentInstance);
    wantQR = true;

    const rendered = renderQRFromResponse(js?.qrcode || {});
    els.qrLoader?.classList.add('hidden');

    await loadWhatsAppStatus();

    if (currentInstance) {
      schedulePresenceRefresh(150, { force:true, onlyInstances:[currentInstance] });
    }

    if (rendered){
      els.btnGerarQR?.classList.add('hidden');
      els.btnRefresh?.classList.remove('hidden');
      els.qrInstru?.classList.remove('hidden');
    } else {
      els.btnGerarQR?.classList.remove('hidden');
      els.btnRefresh?.classList.add('hidden');
      els.qrInstru?.classList.remove('hidden');
    }

  } catch (e){
    els.qrLoader?.classList.add('hidden');
    showQRError(e?.message || 'Falha ao iniciar conexão.');
  }
}

async function openReconnect(item){
  if (!item?.instance_name) return;
  currentInstance = item.instance_name;
  window.currentInstance = currentInstance;

  lastHistoricoUsed = 'none';

  setModalTitle('Reconecte seu número de WhatsApp');
  const histRow = els.selHist?.closest('.form-row, .field, .mb-4, .mb-3, .grid, div') || null;
  if (histRow) histRow.classList.add('hidden');

  if (els.inApelido) els.inApelido.value = item.apelido || '';
  if (els.selPais)   els.selPais.value = '55';
  if (els.inNumero)  els.inNumero.value = onlyDigits(item.numero_instancia || '').slice(-11);

  showModal();
  showIllustration();
  showQRError('');
  hideQR();

  attachInstWS(currentInstance);

  els.qrLoader?.classList.remove('hidden');
  try {
    const res = await apiPost(
      `/api/onboarding/empresas/qr/refresh/${encodeURIComponent(currentInstance)}`,
      {}
    );
    els.qrLoader?.classList.add('hidden');
    const ok = renderQRFromResponse(res?.qrcode || {});
    wantQR = true;
    if (!ok) showIllustration();
  } catch {
    els.qrLoader?.classList.add('hidden');
    showIllustration();
  }

  schedulePresenceRefresh(150, { force:true, onlyInstances:[currentInstance] });

  els.btnGerarQR?.classList.add('hidden');
  els.btnRefresh?.classList.remove('hidden');
  els.qrInstru?.classList.remove('hidden');
}

async function refreshQR(){
  if (!window.currentInstance) return;
  try{
    hideQR();
    els.qrLoader?.classList.remove('hidden');
    showIllustration();
    const res = await apiPost(
      `/api/onboarding/empresas/qr/refresh/${encodeURIComponent(window.currentInstance)}`,
      {}
    );
    els.qrLoader?.classList.add('hidden');
    const ok = renderQRFromResponse(res?.qrcode || {});
    wantQR = true;
    if (!ok) showIllustration();

    schedulePresenceRefresh(200, { force:true, onlyInstances:[window.currentInstance] });

  }catch(e){
    els.qrLoader?.classList.add('hidden');
    showQRError('Não foi possível atualizar o QR.');
  }
}

async function gerarPrimeiroQR(){
  await refreshQR();
}

// ===== Listeners de UI =====
els.btnAdd?.addEventListener('click', () => {
  showModal();
  showIllustration();
  showQRError('');
  hideQR();
  wantQR = false;
  currentInstance = null;
  window.currentInstance = null;

  const histRow = els.selHist?.closest('.form-row, .field, .mb-4, .mb-3, .grid, div') || null;
  if (histRow) histRow.classList.remove('hidden');
});

els.btnCloseMd?.addEventListener('click', hideModal);
els.btnCancel?.addEventListener('click', hideModal);
els.form?.addEventListener('submit', handleConnectSubmit);
els.btnRefresh?.addEventListener('click', refreshQR);
els.btnGerarQR?.addEventListener('click', gerarPrimeiroQR);

els.btnCloseSaude?.addEventListener('click', closeSaudeModal);
els.btnFecharSaude?.addEventListener('click', closeSaudeModal);
els.btnReanalisarSaude?.addEventListener('click', async () => {
  if (!saudeCurrentItem) return;
  await consultarSaudeNumero(saudeCurrentItem, { force:true });
  renderList(filterItemsByTab(allItems), lastPlanLabel);
});

// ===== Remoção =====
let toRemove = null;

function openRemoveModal(item){
  toRemove = item || null;
  if (!els.modalRem) return;
  if (els.remConsent) els.remConsent.checked = false;
  if (els.btnRemYes){
    els.btnRemYes.disabled = true;
    els.btnRemYes.classList.add('opacity-60','cursor-not-allowed');
  }
  els.modalRem.classList.remove('hidden');
}

function closeRemoveModal(){
  toRemove = null;
  els.modalRem?.classList.add('hidden');
}

els.remConsent?.addEventListener('change', () => {
  const allowed = !!els.remConsent?.checked;
  if (!els.btnRemYes) return;
  els.btnRemYes.disabled = !allowed;
  els.btnRemYes.classList.toggle('opacity-60', !allowed);
  els.btnRemYes.classList.toggle('cursor-not-allowed', !allowed);
});

els.btnRemNo?.addEventListener('click', closeRemoveModal);

els.btnRemYes?.addEventListener('click', async () => {
  if (!toRemove) return;
  if (!els.remConsent?.checked){
    alert('Para remover definitivamente, confirme que está ciente de que TODOS os dados desta instância serão apagados.');
    return;
  }
  els.btnRemYes.disabled = true;
  els.btnRemNo.disabled  = true;
  try{
    const tries = [
      `/api/empresas/instancias/${encodeURIComponent(toRemove.id)}`,
      `/api/empresas/whatsapp/${encodeURIComponent(toRemove.instance_name)}`
    ];
    let success = false;
    let lastErr = '';
    for (const u of tries){
      try{
        const res = await apiDelete(u);
        if (res.ok === true && (res.status === 200 || res.status === 204)) {
          success = true;
          break;
        } else {
          lastErr = `DELETE ${u} → ${res.status}`;
        }
      }catch(e){
        lastErr = String(e?.message || e);
      }
    }
    if (!success) {
      alert(`Não foi possível remover este número agora.\n${lastErr || ''}`.trim());
      return;
    }
    closeRemoveModal();
    toast('Instância e todos os dados vinculados foram removidos.');
    await loadWhatsAppStatus();
  } finally {
    els.btnRemYes.disabled = false;
    els.btnRemNo.disabled  = false;
  }
});

let toastTimer = null;
function toast(msg){
  const box = $('#global-msg');
  if (!box) return;
  box.textContent = msg;
  box.classList.remove('hidden');
  box.style.display = 'block';
  box.style.background = '#16a34a';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.classList.add('hidden');
    box.style.display = 'none';
  }, 3200);
}

// ===== Init =====
if (!empresaId){
  console.warn('empresa_id ausente no localStorage; não foi possível carregar a lista.');
} else {
  attachEmpresaWS();
  loadWhatsAppStatus();

  presenceIntervalId = setInterval(() => {
    if (document.hidden) return;
    void refreshPresenceStatuses({ force:false });
  }, PRESENCE_REFRESH_INTERVAL_MS);
}

// ===== Teardown SPA =====
function teardownConectar() {
  try { offEmp?.(); offEmp = null; } catch {}
  try { offInst?.(); offInst = null; } catch {}
  try { if (empresaId) closeEmpresaWS(empresaId); } catch {}
  try { if (currentInstance) closeInstWS(currentInstance); } catch {}
  clearTimeout(loadTmr);
  loadTmr = null;
  inFlight = false;
  pendingReload = false;

  clearTimeout(presenceLoadTmr);
  presenceLoadTmr = null;
  try { if (presenceIntervalId) clearInterval(presenceIntervalId); } catch {}
  presenceIntervalId = null;

  clearInterval(saudeLoadingTmr);
  saudeLoadingTmr = null;

  try { hidePrepOverlay(); } catch {}
  document.body.style.overflow = '';
}

(function watchLeave(){
  const isHere = () =>
    !!document.getElementById('form-conectar') ||
    location.pathname.includes('/conectar');

  const stopIfGone = () => {
    if (!isHere()) {
      teardownConectar();
      obs?.disconnect?.();
      document.removeEventListener('visibilitychange', stopIfGone);
    }
  };

  const obs = new MutationObserver(stopIfGone);
  obs.observe(document.body, { childList:true, subtree:true });
  document.addEventListener('visibilitychange', stopIfGone);
})();

window.addEventListener('beforeunload', () => {
  teardownConectar();
});