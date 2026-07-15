// /frontend/js/pages/conectar.js
import {
  ensureEmpresaWS, onEmpresaMessage, ensureInstWS, onInstMessage,
  closeEmpresaWS, closeInstWS
} from '/frontend/js/realtime/ws-core.js';

// ====== Config ======
const PREP_LOTTIE_URL = '/frontend/js/pages/lottie.json';
const PREP_OVERLAY_SECONDS = 20;
const PRESENCE_REFRESH_INTERVAL_MS = 120000;
const PRESENCE_COOLDOWN_MS = 60000;
const PRESENCE_CONCURRENCY = 2;
const CONNECTION_WATCH_INTERVAL_MS = 5000;
const CONNECTION_WATCH_MAX_MS = 180000;

// Tempo mínimo visual para a Saúde do Número.
// A API pode responder rápido, mas seguramos a tela para parecer uma análise real.
const SAUDE_ANALISE_MIN_MS = 10000;
const SAUDE_REANALISE_MIN_MS = 6500;
const SAUDE_ERROR_MIN_MS = 2500;
const SAUDE_FINAL_PAUSE_MS = 650;

const SAUDE_LOADING_MESSAGES = [
  'Buscando mensagens recentes...',
  'Analisando padrão de envio...',
  'Verificando repetição de conteúdo...',
  'Calculando risco do número...',
  'Montando relatório final...'
];

// ====== Estado ======
let wantQR = false;
let currentInstance = null;
let currentConnectMethod = 'qrcode';
let currentReconnectItem = null;
let timerId = null;
let connectionWatchTimer = null;
let connectionWatchStartedAt = 0;
let connectionWatchInstance = null;
let connectedHandledInstance = null;
let lastHistoricoUsed = 'none';

let lastWhatsPayload = null;
let presenceInFlight = false;
let presenceLoadTmr = null;
let presenceIntervalId = null;
const presenceCache = new Map();
const reconnectingInstances = new Set();

let saudeLoadingTmr = null;
let saudeLoadingStepIdx = 0;
let saudeLoadingMsgIdx = 0;
let saudeCurrentItem = null;
let saudeRunToken = 0;
let saudeLoadingStartedAt = 0;
let editApelidoItem = null;

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

function normalizeHistorico(value){
  const v = String(value || '').trim().toLowerCase();

  if (v === 'none') return 'none';
  if (v === '24h') return '24h';
  if (v === '7d') return '7d';
  if (v === '30d') return '30d';

  return '24h';
}

function getHistoricoInfo(value){
  const v = normalizeHistorico(value);

  if (v === 'none') {
    return {
      value: 'none',
      label: 'Não restaurar',
      help: 'Conecta mais rápido, sem trazer mensagens antigas. As novas mensagens passam a chegar normalmente após a conexão.',
      warning: '',
      overlaySeconds: 15,
      heavy: false,
      sequence: [
        'Sincronizando seus contatos...',
        'Organizando sua instância...',
        'Preparando seu atendimento...'
      ]
    };
  }

  if (v === '7d') {
    return {
      value: '7d',
      label: 'Últimos 7 dias',
      help: 'Boa opção para migração. Traz mais contexto das conversas recentes, mas pode demorar um pouco mais.',
      warning: 'A restauração de 7 dias pode levar alguns minutos dependendo do volume de conversas.',
      overlaySeconds: 25,
      heavy: true,
      sequence: [
        'Sincronizando mensagens dos últimos 7 dias...',
        'Sincronizando seus contatos...',
        'Organizando suas conversas...',
        'Preparando seu atendimento...'
      ]
    };
  }

  if (v === '30d') {
    return {
      value: '30d',
      label: 'Últimos 30 dias',
      help: 'Opção avançada para quem precisa trazer bastante histórico na primeira conexão.',
      warning: 'A restauração de 30 dias é mais pesada e pode demorar alguns minutos. O sistema deve continuar funcionando enquanto importa em segundo plano.',
      overlaySeconds: 30,
      heavy: true,
      sequence: [
        'Iniciando restauração avançada...',
        'Sincronizando mensagens dos últimos 30 dias...',
        'Sincronizando seus contatos...',
        'Organizando suas conversas...',
        'Preparando seu atendimento...'
      ]
    };
  }

  return {
    value: '24h',
    label: 'Últimas 24 horas',
    help: 'Recomendado para a maioria dos casos. Traz conversas recentes sem pesar muito a conexão inicial.',
    warning: '',
    overlaySeconds: 20,
    heavy: false,
    sequence: [
      'Sincronizando suas mensagens recentes...',
      'Sincronizando seus contatos...',
      'Organizando suas conversas...',
      'Preparando seu atendimento...'
    ]
  };
}

function updateHistoricoUI(value){
  const info = getHistoricoInfo(value);

  if (els.histHelp) {
    els.histHelp.textContent = info.help;
  }

  if (els.histWarning) {
    if (info.warning) {
      els.histWarning.textContent = info.warning;
      els.histWarning.classList.remove('hidden');
    } else {
      els.histWarning.textContent = '';
      els.histWarning.classList.add('hidden');
    }
  }

  return info;
}

function formatPhoneBR(num) {
  const d = onlyDigits(num);
  if (!d) return '—';
  if (d.length === 13) return `+${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.length === 12) return `+${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,8)}-${d.slice(8)}`;
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return `+${d}`;
}

function normalizePairingNumber(value){
  let d = onlyDigits(value);
  if (!d) return '';

  // Usuário costuma digitar só DDD + número. Neste caso assumimos Brasil.
  if (d.length === 10 || d.length === 11) {
    d = `55${d}`;
  }

  return d;
}

function maskPhoneInput(value){
  const d = onlyDigits(value).slice(0, 13);
  if (!d) return '';

  if (d.startsWith('55')) {
    const rest = d.slice(2);
    if (rest.length <= 2) return `+55 ${rest}`;
    const ddd = rest.slice(0, 2);
    const num = rest.slice(2);
    if (num.length <= 4) return `+55 ${ddd} ${num}`;
    if (num.length <= 8) return `+55 ${ddd} ${num.slice(0, 4)}-${num.slice(4)}`;
    return `+55 ${ddd} ${num.slice(0, 5)}-${num.slice(5)}`;
  }

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
  if (s === 'boa') return 'saude-badge--boa';
  return 'saude-badge--na';
}

function chipClassByStatus(status){
  const s = String(status || '').toLowerCase();
  if (s === 'critico') return 'saude-chip-sm--critico';
  if (s === 'alto_risco') return 'saude-chip-sm--alto';
  if (s === 'atencao') return 'saude-chip-sm--atencao';
  if (s === 'boa') return 'saude-chip-sm--boa';
  return 'saude-chip-sm--na';
}

function getSaudeVisual(item){
  const hasSavedAnalysis =
    !!item?.score_atualizado_em ||
    !!item?.score_status ||
    !!item?.saude_status ||
    !!item?.score_label ||
    !!item?.saude_label ||
    item?.score === 0 ||
    typeof item?.score === 'number';

  if (!hasSavedAnalysis) {
    return {
      label: 'Não analisado',
      status: 'na'
    };
  }

  const status = String(
    item?.score_status ||
    item?.saude_status ||
    ''
  ).toLowerCase();

  const label =
    item?.score_label ||
    item?.saude_label ||
    (
      status === 'critico' ? 'Crítico' :
      status === 'alto_risco' ? 'Alto risco' :
      status === 'atencao' ? 'Atenção' :
      status === 'boa' ? 'Boa' :
      'Não analisado'
    );

  return {
    label,
    status: status || 'na'
  };
}

function formatMetricValue(v){
  if (v === null || typeof v === 'undefined' || v === '') return '—';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return String(v);
}

function formatDateTimeBR(value){
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';

  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(d);
}

function formatRelativeTimeBR(value){
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';

  const diffMs = d.getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

  const minutes = Math.round(diffMs / (1000 * 60));
  const hours = Math.round(diffMs / (1000 * 60 * 60));
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(days, 'day');
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

// ✅ Base do Status: consulta real.
// Antes o front considerava 200 OK do setPresence como "conectado".
// Isso era falso em reconexão: a Evolution pode responder HTTP 200 mesmo com state=close/disconnected.
async function pingSetPresence(instanceName, { force=false } = {}){
  if (!instanceName) return false;

  const now = Date.now();
  const cache = presenceCache.get(instanceName);
  if (!force && cache && (now - cache.ts) < PRESENCE_COOLDOWN_MS) {
    return !!cache.ok;
  }

  let ok = false;
  try {
    const js = await apiPost(`/instance/setPresence/${encodeURIComponent(instanceName)}`, {});
    ok = isConnectedPayload(js);
  } catch {
    ok = false;
  }

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
      updateSummaryCards(allItems);

      // Atualiza também pill/menu, não só a bolinha.
      // Sem isso a tela podia ficar com "Conectado agora" visualmente atrasado.
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
  tabEmpty:    $('#tab-empty-zap'),
  actions:     $('.actions'),
  table:       $('#lista-zap'),
  tbody:       $('#lista-zap tbody'),
  btnAdd:      $('#btn-open-modal'),
  btnHelp:     $('#btn-open-help'),
  countPro:    $('#count-pro'),
  summaryActive: $('#zc-summary-active'),
  summaryQr: $('#zc-summary-qr'),
  summaryReconnect: $('#zc-summary-reconnect'),
  tableFoot: $('#zc-table-foot'),
  wizardSteps: $$('.zc-wizard-step'),
  wizardHint: $('#zc-wizard-hint'),
  wizardSubtitle: $('#zc-wizard-subtitle'),

  modal:       $('#modal'),
  modalHelp:   $('#modal-ajuda-conectar'),
  btnCloseMd:  $('#btn-close-modal'),
  form:        $('#form-conectar'),
  inApelido:   $('#form-conectar input[name="apelido"]'),
  inNumero:    $('#zc-whatsapp-numero'),
  phoneField:  $('#zc-phone-field'),
  methodRadios: $$('input[name="connect_method"]'),
  methodOptions: $$('.zc-method-option'),
  scanHelpTitle: $('#zc-scan-help-title'),
  scanHelpLast: $('#zc-scan-help-last'),
  selHist:     $('#historico-select'),
  histHelp:    $('#historico-help'),
  histWarning: $('#historico-warning'),
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
  pairingBox:  $('#pairing-code-box'),
  pairingCodeValue: $('#pairing-code-value'),

  modalRem:      $('#modal-remover-numero'),
  btnRemYes:     $('#btn-confirmar-remover'),
  btnRemNo:      $('#btn-cancelar-remover'),
  remConsent:    $('#rem-consent'),

  modalEditApelido: $('#modal-editar-apelido'),
  btnCloseEditApelido: $('#btn-close-editar-apelido'),
  btnCancelEditApelido: $('#btn-cancelar-editar-apelido'),
  btnSaveEditApelido: $('#btn-salvar-editar-apelido'),
  editApelidoInput: $('#editar-apelido-input'),
  editApelidoErro: $('#editar-apelido-erro'),
  editApelidoSubtitle: $('#editar-apelido-subtitle'),

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
  saudeConsultadoPill: $('#saude-consultado-pill'),
  saudeScoreProgress: $('#saude-score-progress'),
  saudeRiskLabel: $('#saude-risk-label'),
  saudeStatusTitle: $('#saude-status-title'),
  saudeStabilityLabel: $('#saude-stability-label'),
  saudeLoadingProgress: $('#saude-loading-progress-bar'),
};

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

function getConnectMethod(){
  const checked = els.methodRadios?.find?.(r => r.checked);
  const method = checked?.value || currentConnectMethod || 'qrcode';
  return method === 'pairing' ? 'pairing' : 'qrcode';
}

function setConnectWizardStep(step){
  const n = Number(step) || 1;
  const method = getConnectMethod();

  els.wizardSteps?.forEach?.((el) => {
    const current = Number(el.dataset.step || 0);
    el.classList.toggle('is-active', current === n);
    el.classList.toggle('is-done', current < n);
  });

  if (els.wizardHint) {
    els.wizardHint.textContent =
      n === 4 ? 'Conexão confirmada. Estamos preparando sua instância.' :
      n === 3 && method === 'pairing' ? 'Digite o código no WhatsApp do celular.' :
      n === 3 ? 'Escaneie o QR Code com o WhatsApp do celular.' :
      n === 2 ? 'Escolha quanto histórico deseja restaurar.' :
      'Configure o apelido, escolha o histórico e escolha como deseja conectar.';
  }

  if (els.wizardSubtitle) {
    els.wizardSubtitle.textContent =
      method === 'pairing'
        ? 'Gere um código e digite no WhatsApp pelo caminho “Conectar com número de telefone”.'
        : 'Escaneie o QR Code com o WhatsApp do celular para conectar.';
  }
}

function updateConnectMethodUI(methodRaw){
  const method = methodRaw === 'pairing' ? 'pairing' : 'qrcode';
  currentConnectMethod = method;

  els.methodRadios?.forEach?.((r) => { r.checked = r.value === method; });
  els.methodOptions?.forEach?.((opt) => {
    opt.classList.toggle('is-selected', opt.dataset.methodOption === method);
  });

  const isPairing = method === 'pairing';
  els.phoneField?.classList.toggle('hidden', !isPairing);

  if (els.qrLoader) {
    const label = els.qrLoader.querySelector('span');
    if (label) label.textContent = isPairing ? 'Gerando código...' : 'Gerando QR Code...';
  }

  if (els.btnGerarQR) {
    const label = isPairing ? 'Gerar código' : 'Gerar QR Code';
    els.btnGerarQR.innerHTML = `<i class="fa-solid ${isPairing ? 'fa-key' : 'fa-qrcode'}"></i><span>${label}</span>`;
  }

  if (els.btnRefresh) {
    const label = isPairing ? 'Gerar novo código' : 'Atualizar QR Code';
    els.btnRefresh.innerHTML = `<i class="fa-solid fa-rotate-right"></i><span>${label}</span>`;
  }

  if (els.scanHelpTitle) {
    els.scanHelpTitle.textContent = isPairing ? 'Como conectar com código' : 'Como escanear';
  }

  if (els.scanHelpLast) {
    els.scanHelpLast.textContent = isPairing
      ? 'Toque em “Conectar com número de telefone” e digite o código exibido aqui.'
      : 'Aponte a câmera para este QR Code.';
  }

  setConnectWizardStep(1);
}

function setConnectMethod(methodRaw, { focusPhone=false } = {}){
  updateConnectMethodUI(methodRaw);
  hideQR();
  showQRError('');

  if (focusPhone && currentConnectMethod === 'pairing') {
    setTimeout(() => els.inNumero?.focus?.(), 40);
  }
}

function openHelpModal(){
  if (!els.modalHelp) return;
  els.modalHelp.classList.remove('hidden');
  els.modalHelp.setAttribute('aria-hidden', 'false');
}

function closeHelpModal(){
  if (!els.modalHelp) return;
  els.modalHelp.classList.add('hidden');
  els.modalHelp.setAttribute('aria-hidden', 'true');
}

// ===== Modal Editar Apelido =====
function openEditApelidoModal(item){
  if (!item?.id) return;

  editApelidoItem = item;

  if (els.editApelidoInput) {
    els.editApelidoInput.value = item.apelido || item.instance_name || '';
  }

  if (els.editApelidoSubtitle) {
    const numero = formatPhoneBR(item.numero_instancia || '');
    els.editApelidoSubtitle.textContent = `${numero} • Nome técnico: ${item.instance_name || '—'}`;
  }

  if (els.editApelidoErro) {
    els.editApelidoErro.textContent = '';
    els.editApelidoErro.classList.add('hidden');
  }

  els.modalEditApelido?.classList.remove('hidden');

  setTimeout(() => {
    els.editApelidoInput?.focus?.();
    els.editApelidoInput?.select?.();
  }, 50);
}

function closeEditApelidoModal(){
  editApelidoItem = null;

  if (els.editApelidoErro) {
    els.editApelidoErro.textContent = '';
    els.editApelidoErro.classList.add('hidden');
  }

  els.modalEditApelido?.classList.add('hidden');
}

function showEditApelidoError(msg){
  if (!els.editApelidoErro) return;
  els.editApelidoErro.textContent = msg || 'Não foi possível atualizar o apelido.';
  els.editApelidoErro.classList.remove('hidden');
}

async function salvarApelidoInstancia(){
  if (!editApelidoItem?.id) return;

  const novoApelido = String(els.editApelidoInput?.value || '').trim().replace(/\s+/g, ' ');

  if (!novoApelido) {
    showEditApelidoError('Informe um apelido para a instância.');
    return;
  }

  if (novoApelido.length > 80) {
    showEditApelidoError('O apelido pode ter no máximo 80 caracteres.');
    return;
  }

  if (els.btnSaveEditApelido) els.btnSaveEditApelido.disabled = true;

  try {
    const js = await apiPost(
      `/api/onboarding/empresas/instancias/${encodeURIComponent(editApelidoItem.id)}/apelido`,
      {
        empresa_id: empresaId,
        apelido: novoApelido,
      }
    );

    const apelidoSalvo = js?.apelido || novoApelido;
    const instanciaId = String(editApelidoItem.id);

    editApelidoItem.apelido = apelidoSalvo;

    allItems = allItems.map((it) => {
      if (String(it.id) === instanciaId) {
        return {
          ...it,
          apelido: apelidoSalvo,
        };
      }
      return it;
    });

    closeEditApelidoModal();
    renderList(filterItemsByTab(allItems), lastPlanLabel);
    toast('Apelido da instância atualizado com sucesso.');
  } catch (e) {
    const detail = e?.message || 'Não foi possível atualizar o apelido.';
    showEditApelidoError(detail);
  } finally {
    if (els.btnSaveEditApelido) els.btnSaveEditApelido.disabled = false;
  }
}

// ===== Modal Saúde =====
function openSaudeModal(){
  els.modalSaude?.classList.remove('hidden');
}

function closeSaudeModal(){
  saudeRunToken += 1;
  clearInterval(saudeLoadingTmr);
  saudeLoadingTmr = null;
  saudeCurrentItem = null;
  els.modalSaude?.classList.add('hidden');
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));

function setSaudeLoadingStep(activeIdx, { completeAll=false, progress=null } = {}){
  const steps = $$('#saude-loading .saude-step');

  steps.forEach((el, idx) => {
    const done = completeAll || idx < activeIdx;
    const active = !completeAll && idx === activeIdx;

    el.classList.toggle('done', done);
    el.classList.toggle('active', active);
  });

  if (els.saudeLoadingProgress && typeof progress === 'number') {
    els.saudeLoadingProgress.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
}

function resetSaudeModal(){
  clearInterval(saudeLoadingTmr);
  saudeLoadingTmr = null;
  saudeLoadingStepIdx = 0;
  saudeLoadingMsgIdx = 0;
  saudeLoadingStartedAt = 0;

  els.saudeError?.classList.add('hidden');
  if (els.saudeError) els.saudeError.textContent = '';

  els.saudeResult?.classList.add('hidden');
  els.saudeLoading?.classList.remove('hidden');
  els.btnReanalisarSaude?.classList.add('hidden');

  if (els.saudeLoadingText) els.saudeLoadingText.textContent = SAUDE_LOADING_MESSAGES[0];
  if (els.saudeLoadingProgress) els.saudeLoadingProgress.style.width = '0%';

  setSaudeLoadingStep(0, { progress:0 });
}

function startSaudeLoadingAnimation(minMs=SAUDE_ANALISE_MIN_MS){
  const steps = $$('#saude-loading .saude-step');
  const totalSteps = Math.max(steps.length, 1);
  const minDuration = Math.max(2500, Number(minMs) || SAUDE_ANALISE_MIN_MS);

  clearInterval(saudeLoadingTmr);
  saudeLoadingStartedAt = Date.now();

  const tick = () => {
    const elapsed = Date.now() - saudeLoadingStartedAt;
    const ratio = Math.min(1, elapsed / minDuration);
    const idx = Math.min(totalSteps - 1, Math.floor(ratio * totalSteps));
    const progress = Math.min(94, Math.max(6, ratio * 94));

    saudeLoadingStepIdx = idx;
    saudeLoadingMsgIdx = Math.min(SAUDE_LOADING_MESSAGES.length - 1, idx);

    if (els.saudeLoadingText) {
      els.saudeLoadingText.textContent = SAUDE_LOADING_MESSAGES[saudeLoadingMsgIdx] || 'Analisando dados do número...';
    }

    setSaudeLoadingStep(idx, { progress });
  };

  tick();
  saudeLoadingTmr = setInterval(tick, 220);
}

async function finishSaudeLoadingBeforeResult(runToken){
  if (runToken !== saudeRunToken) return false;

  clearInterval(saudeLoadingTmr);
  saudeLoadingTmr = null;

  if (els.saudeLoadingText) {
    els.saudeLoadingText.textContent = 'Relatório concluído. Preparando resultado...';
  }

  setSaudeLoadingStep(999, { completeAll:true, progress:100 });
  await delay(SAUDE_FINAL_PAUSE_MS);

  return runToken === saudeRunToken;
}

async function waitSaudeMinimumTime(startedAt, minMs){
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, Number(minMs || 0) - elapsed);
  if (remaining > 0) await delay(remaining);
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

function getSaudeStatusMeta(status, score){
  const s = String(status || '').toLowerCase();
  const n = Number(score);

  if (s === 'critico') {
    return {
      key: 'critico',
      risk: 'Risco crítico',
      title: 'Ação necessária agora',
      stability: 'Crítico',
      icon: 'fa-triangle-exclamation'
    };
  }

  if (s === 'alto_risco') {
    return {
      key: 'alto',
      risk: 'Alto risco',
      title: 'Revise o padrão de envio',
      stability: 'Instável',
      icon: 'fa-circle-exclamation'
    };
  }

  if (s === 'atencao') {
    return {
      key: 'atencao',
      risk: 'Atenção',
      title: 'Atenção ao padrão recente',
      stability: 'Em observação',
      icon: 'fa-clock'
    };
  }

  if (s === 'boa' || (Number.isFinite(n) && n <= 20)) {
    return {
      key: 'boa',
      risk: 'Risco muito baixo',
      title: 'Tudo certo por aqui!',
      stability: 'Estável',
      icon: 'fa-shield-halved'
    };
  }

  return {
    key: 'na',
    risk: 'Risco não calculado',
    title: 'Análise ainda não disponível',
    stability: 'Sem análise',
    icon: 'fa-shield-halved'
  };
}

function renderSaudeMetricas(metricas){
  if (!els.saudeMetricas) return;
  const m = metricas || {};
  const rows = [
    ['Mensagens analisadas', formatMetricValue(m.mensagens_analisadas), 'fa-regular fa-comments', ''],
    ['Mensagens de saída', formatMetricValue(m.saidas), 'fa-regular fa-paper-plane', 'saude-metrica-icon--blue'],
    ['Mensagens de entrada', formatMetricValue(m.entradas), 'fa-solid fa-arrow-down', ''],
    ['Repetição', `${formatMetricValue(m.repeticao_pct)}%`, 'fa-solid fa-arrows-rotate', 'saude-metrica-icon--warn'],
    ['Intervalo médio', m.intervalo_medio_seg == null ? '—' : `${formatMetricValue(m.intervalo_medio_seg)} s`, 'fa-regular fa-clock', ''],
    ['Sem resposta', `${formatMetricValue(m.taxa_sem_resposta_pct)}%`, 'fa-solid fa-ban', 'saude-metrica-icon--muted'],
  ];

  els.saudeMetricas.innerHTML = rows.map(([k, v, icon, extra]) => `
    <div class="saude-metrica-item">
      <div class="saude-metrica-icon ${extra || ''}" aria-hidden="true">
        <i class="${icon}"></i>
      </div>
      <div>
        <span class="saude-metrica-label">${htmlEscape(k)}</span>
        <strong class="saude-metrica-value">${htmlEscape(v)}</strong>
      </div>
    </div>
  `).join('');
}

function renderSaudeResult(item, payload){
  clearInterval(saudeLoadingTmr);
  saudeLoadingTmr = null;

  const saude = payload?.saude || {};
  const scoreRaw = Number(saude.score ?? payload?.score ?? 0);
  const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, scoreRaw)) : null;
  const label = saude.label || payload?.score_label || 'Não analisado';
  const status = saude.status || payload?.score_status || 'na';
  const meta = getSaudeStatusMeta(status, score);
  const consultadoEm = saude.consultado_em || payload?.score_atualizado_em;

  els.saudeLoading?.classList.add('hidden');
  els.saudeResult?.classList.remove('hidden');
  els.btnReanalisarSaude?.classList.remove('hidden');
  els.saudeError?.classList.add('hidden');

  if (els.saudeResult) {
    els.saudeResult.classList.remove(
      'saude-state--boa',
      'saude-state--atencao',
      'saude-state--alto',
      'saude-state--critico',
      'saude-state--na'
    );
    els.saudeResult.classList.add(`saude-state--${meta.key}`);
  }

  if (els.saudeSubtitle) {
    const nome = item?.apelido || item?.instance_name || 'Instância';
    const numero = formatPhoneBR(item?.numero_instancia || '');
    els.saudeSubtitle.textContent = `${nome} • ${numero}`;
  }

  if (els.saudeLabelBadge) {
    els.saudeLabelBadge.className = `saude-badge ${badgeClassByStatus(status)}`;
    els.saudeLabelBadge.textContent = label;
  }

  if (els.saudeRiskLabel) {
    els.saudeRiskLabel.textContent = meta.risk;
  }

  if (els.saudeStatusTitle) {
    els.saudeStatusTitle.textContent = meta.title;
  }

  if (els.saudeStabilityLabel) {
    els.saudeStabilityLabel.textContent = meta.stability;
  }

  if (els.saudeScoreNumber) {
    els.saudeScoreNumber.textContent = score == null ? '—' : String(score);
  }

  if (els.saudeScoreLine) {
    els.saudeScoreLine.textContent = score == null ? 'Score: —' : `Score: ${score}/100`;
  }

  if (els.saudeScoreProgress) {
    els.saudeScoreProgress.style.width = `${score == null ? 0 : score}%`;
  }

  if (els.saudeResumo) {
    els.saudeResumo.textContent = saude.resumo || payload?.score_resumo || 'Sem resumo disponível.';
  }

  fillSaudeList(
    els.saudeMotivos,
    saude.motivos || payload?.score_motivos,
    'Nenhum sinal forte de risco foi encontrado nesta análise.'
  );

  fillSaudeList(
    els.saudeRecomendacoes,
    saude.recomendacoes || payload?.score_recomendacoes,
    'Continue mantendo uma comunicação natural e variada.'
  );

  renderSaudeMetricas(saude.metricas || payload?.score_metricas || {});

  if (els.saudeConsultadoEm) {
    if (consultadoEm) {
      const absoluto = formatDateTimeBR(consultadoEm);
      const relativo = formatRelativeTimeBR(consultadoEm);

      els.saudeConsultadoEm.textContent = absoluto;
      els.saudeConsultadoEm.title = relativo ? `${relativo} • ${absoluto}` : absoluto;

      if (els.saudeConsultadoPill) {
        els.saudeConsultadoPill.textContent = relativo || '';
        els.saudeConsultadoPill.classList.toggle('hidden', !relativo);
      }
    } else {
      els.saudeConsultadoEm.textContent = 'Ainda não há data da última análise.';
      els.saudeConsultadoEm.removeAttribute('title');
      els.saudeConsultadoPill?.classList.add('hidden');
      if (els.saudeConsultadoPill) els.saudeConsultadoPill.textContent = '';
    }
  }

  if (item) {
    item.score = score == null ? scoreRaw : score;
    item.score_status = status;
    item.score_label = label;
    item.score_resumo = saude.resumo || payload?.score_resumo || null;
    item.score_motivos = saude.motivos || payload?.score_motivos || [];
    item.score_metricas = saude.metricas || payload?.score_metricas || {};
    item.score_recomendacoes = saude.recomendacoes || payload?.score_recomendacoes || [];
    item.score_atualizado_em = consultadoEm || null;
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

async function consultarSaudeNumero(item, { force=true, reanalise=false } = {}){
  if (!item?.id) return;

  const runToken = ++saudeRunToken;
  const startedAt = Date.now();
  const minMs = reanalise ? SAUDE_REANALISE_MIN_MS : SAUDE_ANALISE_MIN_MS;

  saudeCurrentItem = item;
  openSaudeModal();
  resetSaudeModal();
  startSaudeLoadingAnimation(minMs);

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

    await waitSaudeMinimumTime(startedAt, minMs);
    const canRender = await finishSaudeLoadingBeforeResult(runToken);
    if (!canRender) return;

    renderSaudeResult(item, res);
    toast('Saúde do Número consultada com sucesso.');
  } catch (e) {
    await waitSaudeMinimumTime(startedAt, SAUDE_ERROR_MIN_MS);
    if (runToken !== saudeRunToken) return;
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
const prep = { active:false, left:0, tmr:null, anim:null, seq:[], seqIdx:0, seqTmr:null, historico:'24h' };

function ensureOverlay(){
  let ovl = document.getElementById('sync-overlay');
  if (ovl) return ovl;
  ovl = document.createElement('div');
  ovl.id = 'sync-overlay';
  ovl.innerHTML = `
    <div class="sync-wrap" role="dialog" aria-live="polite">
      <div id="prep-ovl-lottie"></div>
      <div id="prep-ovl-status" class="think">
        Sincronizando suas mensagens recentes<span class="typing" aria-hidden="true"><span></span><span></span><span></span></span>
      </div>
      <div id="prep-ovl-title">Estamos organizando tudo para você.</div>
      <div id="prep-ovl-sub">Você poderá usar o sistema enquanto a importação termina.</div>
      <div id="prep-ovl-time"><span class="time-pill">00:20</span></div>
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
  return getHistoricoInfo(historico).sequence;
}

function startStatusLoop(){
  clearInterval(prep.seqTmr);
  const items = prep.seq;
  if (!items.length) return;
  prep.seqIdx = 0;
  setStatus(items[0], true);
  prep.seqTmr = setInterval(() => {
    prep.seqIdx = (prep.seqIdx + 1) % prep.seq.length;
    setStatus(prep.seq[prep.seqIdx], true);
  }, 4000);
}

function paintTime(){
  const pill = $('#prep-ovl-time .time-pill');
  if (pill) pill.textContent = formatClock(prep.left);
}

async function showPrepOverlayOneMinute(seconds=PREP_OVERLAY_SECONDS, opts={}){
  if (prep.active) return;

  const historico = normalizeHistorico(opts?.historico || '24h');
  const info = getHistoricoInfo(historico);

  prep.active = true;
  prep.left = Math.max(1, Math.floor(seconds || info.overlaySeconds || PREP_OVERLAY_SECONDS));
  prep.historico = historico;

  const ovl = ensureOverlay();
  ovl.classList.add('show');
  document.body.style.overflow = 'hidden';

  const title = $('#prep-ovl-title', ovl);
  const sub = $('#prep-ovl-sub', ovl);

  if (title) title.textContent = info.heavy ? 'A importação começou em segundo plano.' : 'Estamos organizando tudo para você.';
  if (sub) sub.textContent = info.heavy
    ? 'Você pode continuar usando o ZapsChat enquanto o histórico termina de importar.'
    : 'Você poderá usar o sistema enquanto a importação termina.';

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
  clearInterval(prep.tmr); prep.tmr = null;
  clearInterval(prep.seqTmr); prep.seqTmr = null;
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
  .saude-chip-sm--na{
    background:rgba(148,163,184,.12);
    color:#64748b;
    border-color:rgba(148,163,184,.24);
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
  html.dark .saude-chip-sm--na{ color:#cbd5e1; }
  html.dark .saude-chip-sm--boa{ color:#86efac; }
  html.dark .saude-chip-sm--atencao{ color:#fcd34d; }
  html.dark .saude-chip-sm--alto{ color:#fca5a5; }
  html.dark .saude-chip-sm--critico{ color:#fecaca; }

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
function getConnectionStatusVisual(item){
  const connected = !!item?.connected;
  const lastSeen = item?.last_seen || item?.updated_at || item?.ultimo_status_em || null;
  const relative = lastSeen ? formatRelativeTimeBR(lastSeen) : '';

  if (connected) {
    return {
      pill: 'Conectado agora',
      klass: 'zc-status-pill--online',
      dot: 'st-dot--on',
      title: 'Ativo',
      sub: relative ? `Última atividade ${relative}` : 'Presença verificada agora'
    };
  }

  return {
    pill: 'Precisa reconectar',
    klass: 'zc-status-pill--offline',
    dot: 'st-dot--off',
    title: 'Inativo',
    sub: relative ? `Última atividade ${relative}` : 'Clique em ações para reconectar'
  };
}

function rowHTML(item, planLabel){
  const apelido = htmlEscape(item.apelido || item.instance_name || '');
  const numero  = formatPhoneBR(item.numero_instancia);
  const inst    = htmlEscape(String(item.instance_name || ''));
  const st      = getConnectionStatusVisual(item);

  const status = `<span class="st-dot ${st.dot} js-status-dot" data-inst="${inst}" title="${htmlEscape(st.title)}"></span>`;

  const menuItems = [];
  menuItems.push('<button class="kebab-item js-edit-apelido">Alterar apelido</button>');
  menuItems.push('<button class="kebab-item js-saude">Saúde do Número</button>');
  if (!item.connected) menuItems.push('<button class="kebab-item js-reconnect">Reconectar</button>');
  menuItems.push('<button class="kebab-item js-remove">Remover número</button>');

  return `
    <tr class="zc-number-row border-b last:border-0 relative" data-id="${htmlEscape(String(item.id))}" data-instance="${inst}">
      <td class="py-2"><span class="zc-number-name">${apelido || '—'}</span></td>
      <td class="py-2"><span class="zc-number-phone">${numero}</span></td>
      <td class="py-2"><span class="plan-pill">${htmlEscape(planLabel)}</span></td>
      <td class="py-2">
        <div class="zc-status-smart">
          <div class="zc-status-main">
            ${status}
            <span class="zc-status-pill ${st.klass}">${htmlEscape(st.pill)}</span>
          </div>
          <small>${htmlEscape(st.sub)}</small>
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

  const btnEditApelido = $('.js-edit-apelido', tr);
  if (btnEditApelido){
    btnEditApelido.addEventListener('click', () => {
      menu.classList.remove('show');
      openEditApelidoModal(item);
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

  const hasItemsInTab = Array.isArray(items) && items.length > 0;
  const totalItems = Array.isArray(allItems) ? allItems.length : 0;

  els.placeholder?.classList.add('hidden');
  els.tabEmpty?.classList.add('hidden');
  els.tableFoot?.classList.add('hidden');

  if (!hasItemsInTab){
    els.table?.classList.add('hidden');

    if (totalItems === 0) {
      els.actions?.classList.add('hidden');
      els.placeholder?.classList.remove('hidden');
    } else {
      els.actions?.classList.remove('hidden');

      if (els.tabEmpty) {
        const title = els.tabEmpty.querySelector('strong');
        const desc = els.tabEmpty.querySelector('span');

        if (currentTab === 'ativos') {
          if (title) title.textContent = 'Nenhum número ativo agora';
          if (desc) desc.textContent = 'Os números desconectados aparecem na aba Inativos.';
        } else {
          if (title) title.textContent = 'Nenhum número inativo agora';
          if (desc) desc.textContent = 'Todos os seus números cadastrados estão ativos.';
        }

        els.tabEmpty.classList.remove('hidden');
      }
    }

    return;
  }

  els.actions?.classList.remove('hidden');
  els.table?.classList.remove('hidden');

  if (els.tableFoot) {
    const suffix = totalItems === 1 ? 'número' : 'números';
    els.tableFoot.textContent = `Mostrando ${items.length} de ${totalItems} ${suffix}`;
    els.tableFoot.classList.remove('hidden');
  }

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
function updateSummaryCards(list){
  const arr = Array.isArray(list) ? list : [];
  const active = arr.filter(it => !!it.connected).length;
  const reconnect = arr.filter(it => !it.connected).length;
  const qrPending = wantQR && currentInstance ? 1 : 0;

  if (els.summaryActive) els.summaryActive.textContent = String(active);
  if (els.summaryQr) els.summaryQr.textContent = String(qrPending);
  if (els.summaryReconnect) els.summaryReconnect.textContent = String(reconnect);
}

function updateTabCounts(totalAtivos, totalInativos){
  if (els.tabAtivos)   els.tabAtivos.textContent   = `Ativos (${totalAtivos})`;
  if (els.tabInativos) els.tabInativos.textContent = `Inativos (${totalInativos})`;
  updateSummaryCards(allItems);
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
    els.btnAdd.title = 'Adicionar novo número ZapsChat';
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
          connected: reconnectingInstances.has(String(i.instance_name || '')) ? false : isConnectedPayload(i),
          last_seen: i.last_seen || null,

          score: (i.score === null || typeof i.score === 'undefined') ? null : Number(i.score),
          score_status: i.score_status || null,
          score_label: i.score_label || null,
          score_resumo: i.score_resumo || null,
          score_motivos: i.score_motivos || [],
          score_metricas: i.score_metricas || {},
          score_recomendacoes: i.score_recomendacoes || [],
          score_atualizado_em: i.score_atualizado_em || null
        }))
      : [];

    allItems = list;
    lastPlanLabel = tier;

    const totalAtivos   = list.filter(it => it.connected).length;
    const totalInativos = list.length - totalAtivos;

    updateTabCounts(totalAtivos, totalInativos);
    updateTopTotal(tier, js, list);
    updateAddButton(js, list);
    updateSummaryCards(list);

    renderList(filterItemsByTab(allItems), tier);

    // Durante reconexão, não confia só no connected vindo da lista/BD.
    // A lista pode estar atrasada enquanto o QR ainda não foi lido.
    if (wantQR && currentInstance) {
      try {
        const reallyConnected = await checkInstanceConnected(currentInstance);
        if (reallyConnected) {
          reconnectingInstances.delete(String(currentInstance));
          handleConnected(currentInstance);
          return;
        }
      } catch {}
    }

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
  els.pairingBox?.classList.add('hidden');
  if (els.pairingCodeValue) els.pairingCodeValue.textContent = '--------';
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
  setConnectWizardStep(3);
  const src = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
  els.qrLoader?.classList.add('hidden');
  hideIllustration();
  els.qrCanvas?.classList.add('hidden');
  els.qrImg.src = src;
  els.qrImg.classList.remove('hidden');
  if (els.qrInstru) {
    els.qrInstru.innerHTML = '<span></span>Aguardando leitura do QR Code';
    els.qrInstru.classList.remove('hidden');
  }
  if (limit) startTimer(secondsFromLimit(limit));
  els.btnGerarQR?.classList.add('hidden');
  els.btnRefresh?.classList.remove('hidden');
}

function renderQRFromText(text, limit){
  if (!els.qrCanvas) return;
  setConnectWizardStep(3);
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
    els.pairingBox?.classList.add('hidden');
    if (els.qrInstru) {
      els.qrInstru.innerHTML = '<span></span>Aguardando leitura do QR Code';
      els.qrInstru.classList.remove('hidden');
    }
    if (limit) startTimer(secondsFromLimit(limit));
    els.btnGerarQR?.classList.add('hidden');
    els.btnRefresh?.classList.remove('hidden');
  }catch(e){
    showQRError('Falha ao gerar QR. Tente novamente.');
  }
}

function formatPairingCode(code){
  const raw = String(code || '').trim().replace(/\s+/g, '').toUpperCase();
  if (!raw) return '';
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

function renderPairingCode(code, limit){
  const formatted = formatPairingCode(code);
  if (!formatted) return false;

  setConnectWizardStep(3);
  els.qrLoader?.classList.add('hidden');
  hideIllustration();
  els.qrImg?.classList.add('hidden');
  els.qrCanvas?.classList.add('hidden');

  if (els.pairingCodeValue) els.pairingCodeValue.textContent = formatted;
  els.pairingBox?.classList.remove('hidden');

  if (els.qrInstru) {
    els.qrInstru.innerHTML = '<span></span>Digite este código no WhatsApp do celular';
    els.qrInstru.classList.remove('hidden');
  }

  if (limit) startTimer(secondsFromLimit(limit));
  els.btnGerarQR?.classList.add('hidden');
  els.btnRefresh?.classList.remove('hidden');
  return true;
}

function isShortPairingCandidate(value){
  const raw = String(value || '').trim().replace(/[\s-]+/g, '');
  return /^[A-Z0-9]{6,12}$/i.test(raw);
}

function firstNonEmpty(...values){
  for (const v of values){
    if (v === null || typeof v === 'undefined') continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

function renderQRWaiting(){
  hideQR();
  showIllustration();
  els.qrLoader?.classList.remove('hidden');
  if (els.qrInstru) {
    els.qrInstru.innerHTML = '<span></span>Aguardando QR Code da Evolution...';
    els.qrInstru.classList.remove('hidden');
  }
}

function renderQRFromResponse(qr){
  if (!qr) return false;

  const obj = (typeof qr === 'object') ? qr : { code: qr };
  const nested = (obj.qrcode && typeof obj.qrcode === 'object') ? obj.qrcode : obj;

  const limit = nested.limit ?? nested.timeout ?? nested.count ?? nested.qr_limit ?? obj.limit ?? obj.timeout ?? obj.qr_limit;

  const b64 = firstNonEmpty(
    nested.base64,
    nested.image,
    nested.codeBase64,
    nested.qrBase64,
    obj.base64,
    obj.image,
    obj.codeBase64,
    obj.qrBase64
  );

  if (b64) {
    renderQRFromBase64(b64, limit);
    return true;
  }

  const explicitPairing = firstNonEmpty(
    nested.pairingCode,
    nested.pairing_code,
    nested.pairing,
    obj.pairingCode,
    obj.pairing_code,
    obj.pairing
  );

  if (explicitPairing) {
    renderPairingCode(explicitPairing, limit);
    return true;
  }

  const code = firstNonEmpty(
    nested.qrText,
    nested.qr_text,
    nested.qrCode,
    nested.qr_code,
    nested.qr,
    nested.code,
    obj.qrText,
    obj.qr_text,
    obj.qrCode,
    obj.qr_code,
    obj.qr,
    obj.code
  );

  if (code) {
    if (currentConnectMethod === 'pairing' && isShortPairingCandidate(code)) {
      renderPairingCode(code, limit);
    } else {
      renderQRFromText(code, limit);
    }
    return true;
  }

  return false;
}

function stopConnectionWatch(){
  if (connectionWatchTimer) {
    clearTimeout(connectionWatchTimer);
    connectionWatchTimer = null;
  }
  connectionWatchStartedAt = 0;
  connectionWatchInstance = null;
}

async function checkInstanceConnected(instance){
  if (!instance) return false;

  // 1) Primeiro tenta o endpoint novo, que consulta DB e também a Evolution.
  try {
    const st = await apiGet(`/api/onboarding/empresas/connection/status/${encodeURIComponent(instance)}?force_evolution=1`);
    if (st?.connected === true || isConnectedPayload(st)) return true;
  } catch {}

  // 2) Fallback: usa a lista normal do cliente.
  try {
    const js = await apiGet(`/api/empresas/${empresaId}/whatsapp`);
    const list = Array.isArray(js?.instancias) ? js.instancias : [];
    const row = list.find(i => String(i?.instance_name || '') === String(instance));
    if (row && isConnectedPayload(row)) return true;
  } catch {}

  return false;
}

function startConnectionWatch(instance){
  if (!instance) return;
  stopConnectionWatch();

  connectionWatchInstance = instance;
  connectionWatchStartedAt = Date.now();

  const tick = async () => {
    if (!wantQR || !connectionWatchInstance || connectionWatchInstance !== instance) {
      stopConnectionWatch();
      return;
    }

    if (Date.now() - connectionWatchStartedAt > CONNECTION_WATCH_MAX_MS) {
      stopConnectionWatch();
      return;
    }

    const ok = await checkInstanceConnected(instance);
    if (ok) {
      handleConnected(instance);
      return;
    }

    connectionWatchTimer = setTimeout(tick, CONNECTION_WATCH_INTERVAL_MS);
  };

  connectionWatchTimer = setTimeout(tick, 1000);
}

// ===== Conectado → overlay =====
function handleConnected(instanceFromMsg){
  if (currentInstance && instanceFromMsg && instanceFromMsg !== currentInstance) return;

  const handledKey = instanceFromMsg || currentInstance || window.currentInstance || '__connected__';
  if (connectedHandledInstance === handledKey) return;
  connectedHandledInstance = handledKey;

  reconnectingInstances.delete(String(handledKey));
  stopConnectionWatch();
  setConnectWizardStep(4);
  clearInterval(timerId);
  hideQR();
  try { hideModal(); } catch {}
  wantQR = false;
  updateSummaryCards(allItems);

  const info = getHistoricoInfo(lastHistoricoUsed);
  showPrepOverlayOneMinute(info.overlaySeconds, { historico: lastHistoricoUsed });

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
        renderQRWaiting();
        return;
      }
      const rendered = renderQRFromResponse(m);
      if (!rendered) renderQRWaiting();
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
  ensureInstWS(instance, { wantQR: true });
  offInst = onInstMessage(instance, (evt) => {
    if (evt.type !== 'message') return;
    const m = evt.data || {};
    if (m?.type === 'qrcode' && wantQR) {
      if (m.waiting) {
        renderQRWaiting();
        return;
      }
      const rendered = renderQRFromResponse(m);
      if (!rendered) renderQRWaiting();
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
  setConnectWizardStep(3);
  showQRError('');
  hideQR();
  els.qrLoader?.classList.remove('hidden');
  showIllustration();

  const apelido = els.inApelido?.value?.trim() || '';
  const historico = normalizeHistorico(els.selHist?.value || 'none');
  const method = getConnectMethod();
  const usePairing = method === 'pairing';
  const numeroPairing = normalizePairingNumber(els.inNumero?.value || '');

  if (!apelido) {
    setConnectWizardStep(1);
    els.qrLoader?.classList.add('hidden');
    showQRError('Informe um apelido para identificar esta instância.');
    return;
  }

  if (usePairing && !numeroPairing) {
    setConnectWizardStep(1);
    els.qrLoader?.classList.add('hidden');
    showQRError('Informe o número do WhatsApp com DDI/DDD para gerar o código.');
    els.inNumero?.focus?.();
    return;
  }

  try{
    lastHistoricoUsed = historico || '24h';
    currentConnectMethod = method;
    wantQR = true;

    const js = await apiPost('/api/onboarding/empresas/conectar', {
      empresa_id: empresaId,
      whatsapp_numero: usePairing ? numeroPairing : '',
      historico_restaurar: historico,
      instance_name: null,
      use_pairing: usePairing,
      apelido: apelido || null
    });

    currentInstance = js?.instance || null;
    window.currentInstance = currentInstance;
    connectedHandledInstance = null;

    if (currentInstance) attachInstWS(currentInstance);
    wantQR = true;
    updateSummaryCards(allItems);

    const rendered = renderQRFromResponse(js?.qrcode || {});
    if (!rendered) renderQRWaiting();

    await loadWhatsAppStatus();

    if (currentInstance) {
      schedulePresenceRefresh(150, { force:true, onlyInstances:[currentInstance] });
      startConnectionWatch(currentInstance);
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


async function requestConnectionRefresh(instance, { method=null, phone=null } = {}){
  const usePairing = (method || getConnectMethod()) === 'pairing';
  const numeroPairing = normalizePairingNumber(
    phone ||
    els.inNumero?.value ||
    currentReconnectItem?.numero_instancia ||
    ''
  );

  if (usePairing && !numeroPairing) {
    showQRError('Informe o número do WhatsApp com DDI/DDD para gerar o código.');
    els.inNumero?.focus?.();
    return null;
  }

  return apiPost(
    `/api/onboarding/empresas/qr/refresh/${encodeURIComponent(instance)}`,
    {
      use_pairing: usePairing,
      whatsapp_numero: usePairing ? numeroPairing : ''
    }
  );
}

async function openReconnect(item){
  if (!item?.instance_name) return;
  currentReconnectItem = item;
  currentInstance = item.instance_name;
  window.currentInstance = currentInstance;
  connectedHandledInstance = null;

  lastHistoricoUsed = 'none';
  reconnectingInstances.add(String(currentInstance));
  presenceCache.delete(String(currentInstance));
  try {
    const local = allItems.find(it => String(it?.instance_name || '') === String(currentInstance));
    if (local) local.connected = false;
    updateSummaryCards(allItems);
    renderList(filterItemsByTab(allItems), lastPlanLabel);
  } catch {}

  setModalTitle('Reconecte seu WhatsApp');
  const histRow = els.selHist?.closest('.form-row, .field, .mb-4, .mb-3, .grid, div') || null;
  if (histRow) histRow.classList.add('hidden');

  if (els.inApelido) els.inApelido.value = item.apelido || '';
  if (els.inNumero) els.inNumero.value = maskPhoneInput(item.numero_instancia || '');

  setConnectMethod(item.numero_instancia ? 'pairing' : 'qrcode');

  showModal();
  showIllustration();
  showQRError('');
  hideQR();

  wantQR = true;
  attachInstWS(currentInstance);

  els.qrLoader?.classList.remove('hidden');
  try {
    const res = await requestConnectionRefresh(
      currentInstance,
      {
        method: getConnectMethod(),
        phone: item.numero_instancia || els.inNumero?.value || ''
      }
    );
    if (!res) {
      els.qrLoader?.classList.add('hidden');
      showIllustration();
      return;
    }
    const ok = renderQRFromResponse(res?.qrcode || {});
    wantQR = true;
    if (!ok) renderQRWaiting();
  } catch {
    els.qrLoader?.classList.add('hidden');
    showIllustration();
  }

  schedulePresenceRefresh(150, { force:true, onlyInstances:[currentInstance] });
  startConnectionWatch(currentInstance);

  els.btnGerarQR?.classList.add('hidden');
  els.btnRefresh?.classList.remove('hidden');
  els.qrInstru?.classList.remove('hidden');
}

async function refreshQR(){
  if (!window.currentInstance) return;
  reconnectingInstances.add(String(window.currentInstance));
  presenceCache.delete(String(window.currentInstance));
  try {
    const local = allItems.find(it => String(it?.instance_name || '') === String(window.currentInstance));
    if (local) local.connected = false;
    renderList(filterItemsByTab(allItems), lastPlanLabel);
  } catch {}
  setConnectWizardStep(3);
  wantQR = true;
  try{
    hideQR();
    els.qrLoader?.classList.remove('hidden');
    showIllustration();
    const res = await requestConnectionRefresh(
      window.currentInstance,
      {
        method: getConnectMethod(),
        phone: els.inNumero?.value || currentReconnectItem?.numero_instancia || ''
      }
    );
    if (!res) {
      els.qrLoader?.classList.add('hidden');
      showIllustration();
      return;
    }
    const ok = renderQRFromResponse(res?.qrcode || {});
    wantQR = true;
    if (!ok) renderQRWaiting();

    schedulePresenceRefresh(200, { force:true, onlyInstances:[window.currentInstance] });
    startConnectionWatch(window.currentInstance);

  }catch(e){
    els.qrLoader?.classList.add('hidden');
    showQRError('Não foi possível atualizar a conexão.');
  }
}

// ===== Listeners de UI =====
function openConnectModal(){
  stopConnectionWatch();
  connectedHandledInstance = null;
  setConnectWizardStep(1);
  showModal();
  showIllustration();
  showQRError('');
  hideQR();
  wantQR = false;
  currentInstance = null;
  currentReconnectItem = null;
  window.currentInstance = null;

  setModalTitle('Conectar novo número');

  if (els.inApelido) els.inApelido.value = '';
  if (els.inNumero) els.inNumero.value = '';
  setConnectMethod('qrcode');

  if (els.selHist) {
    els.selHist.value = 'none';
    updateHistoricoUI('none');
  }

  const histRow = els.selHist?.closest('.form-row, .field, .mb-4, .mb-3, .grid, div') || null;
  if (histRow) histRow.classList.remove('hidden');

  els.btnGerarQR?.classList.remove('hidden');
  els.btnRefresh?.classList.add('hidden');
}

els.btnAdd?.addEventListener('click', openConnectModal);
els.btnHelp?.addEventListener('click', openHelpModal);

$$('[data-open-connect-modal]').forEach((btn) => {
  btn.addEventListener('click', openConnectModal);
});

$$('[data-help-open], [data-empty-help]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    openHelpModal();
  });
});

$$('[data-help-close]').forEach((btn) => {
  btn.addEventListener('click', closeHelpModal);
});

$$('[data-help-video]').forEach((btn) => {
  btn.addEventListener('click', () => {
    toast('Tutorial em vídeo em breve.');
  });
});

$$('[data-help-support]').forEach((btn) => {
  btn.addEventListener('click', () => {
    toast('Chame o suporte para ajudar na conexão.');
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHelpModal();
});

els.methodRadios?.forEach?.((radio) => {
  radio.addEventListener('change', () => setConnectMethod(radio.value, { focusPhone: radio.value === 'pairing' }));
});

els.methodOptions?.forEach?.((option) => {
  option.addEventListener('click', () => {
    const method = option.dataset.methodOption || 'qrcode';
    setConnectMethod(method, { focusPhone: method === 'pairing' });
  });
});

els.inNumero?.addEventListener('input', () => {
  const before = els.inNumero.value;
  const masked = maskPhoneInput(before);
  if (masked !== before) els.inNumero.value = masked;
});

els.selHist?.addEventListener('change', () => {
  updateHistoricoUI(els.selHist?.value || '24h');
});

els.btnCloseMd?.addEventListener('click', () => { stopConnectionWatch(); hideModal(); });
els.btnCancel?.addEventListener('click', () => { stopConnectionWatch(); hideModal(); });
els.form?.addEventListener('submit', handleConnectSubmit);
els.btnRefresh?.addEventListener('click', refreshQR);

els.btnCloseEditApelido?.addEventListener('click', closeEditApelidoModal);
els.btnCancelEditApelido?.addEventListener('click', closeEditApelidoModal);
els.btnSaveEditApelido?.addEventListener('click', salvarApelidoInstancia);
els.editApelidoInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    salvarApelidoInstancia();
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    closeEditApelidoModal();
  }
});

els.btnCloseSaude?.addEventListener('click', closeSaudeModal);
els.btnFecharSaude?.addEventListener('click', closeSaudeModal);
els.btnReanalisarSaude?.addEventListener('click', async () => {
  if (!saudeCurrentItem) return;
  await consultarSaudeNumero(saudeCurrentItem, { force:true, reanalise:true });
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

  if (els.selHist) {
    els.selHist.value = normalizeHistorico(els.selHist.value || 'none');
    updateHistoricoUI(els.selHist.value);
  }

  loadWhatsAppStatus();

  presenceIntervalId = setInterval(() => {
    if (document.hidden) return;
    void refreshPresenceStatuses({ force:false });
  }, PRESENCE_REFRESH_INTERVAL_MS);
}

// ===== Teardown SPA =====
function teardownConectar() {
  stopConnectionWatch();
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

// ===== Correção: widget flutuante de ajuda não pode cobrir os três pontinhos =====
(function initHelpWidgetSafePosition(){
  if (window.__ZC_CONNECT_HELP_WIDGET_SAFE__) return;
  window.__ZC_CONNECT_HELP_WIDGET_SAFE__ = true;

  const KNOWN_WIDGET_SELECTORS = [
    '#zc-help-widget',
    '#help-widget',
    '#help-fab',
    '#ajuda-widget',
    '[data-help-widget]',
    '.zc-help-widget',
    '.help-widget',
    '.help-fab',
    '.floating-help',
    '.floating-help-widget',
    '.ajuda-widget'
  ];

  let widgetRoot = null;
  let rafId = 0;
  let observer = null;

  function normalizeText(value){
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isVisible(el){
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function fixedAncestor(el){
    let current = el;
    while (current && current !== document.body && current !== document.documentElement){
      if (current instanceof HTMLElement && getComputedStyle(current).position === 'fixed') {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function findWidgetByKnownSelector(){
    for (const selector of KNOWN_WIDGET_SELECTORS){
      const candidates = Array.from(document.querySelectorAll(selector));
      for (const candidate of candidates){
        const root = getComputedStyle(candidate).position === 'fixed'
          ? candidate
          : fixedAncestor(candidate);
        if (root && isVisible(root)) return root;
      }
    }
    return null;
  }

  function findWidgetByContent(){
    const candidates = Array.from(document.querySelectorAll(
      'button, [role="button"], span, strong, p, div'
    ));

    for (const candidate of candidates){
      const text = normalizeText(candidate.textContent);
      if (!text.includes('precisa de ajuda')) continue;

      const root = fixedAncestor(candidate);
      if (!root || !isVisible(root)) continue;

      // Não confundir com o modal de ajuda da própria página.
      if (root.closest('#modal-ajuda-conectar') || root.id === 'modal-ajuda-conectar') continue;
      return root;
    }

    return null;
  }

  function findWidget(){
    if (widgetRoot && document.contains(widgetRoot)) return widgetRoot;
    widgetRoot = findWidgetByKnownSelector() || findWidgetByContent();
    return widgetRoot;
  }

  function rectsOverlap(a, b, gap = 8){
    return !(
      a.right + gap <= b.left ||
      a.left >= b.right + gap ||
      a.bottom + gap <= b.top ||
      a.top >= b.bottom + gap
    );
  }

  function visibleActionButtons(){
    return Array.from(document.querySelectorAll('.kebab-btn'))
      .filter(isVisible)
      .map((el) => el.getBoundingClientRect())
      .filter((rect) => (
        rect.bottom >= 0 &&
        rect.top <= window.innerHeight &&
        rect.right >= 0 &&
        rect.left <= window.innerWidth
      ));
  }

  function applyBottom(root, bottom){
    root.style.setProperty('--zc-help-safe-bottom', `${Math.max(10, Math.round(bottom))}px`);
    root.style.bottom = `${Math.max(10, Math.round(bottom))}px`;
    root.style.top = 'auto';
  }

  function placeWidget(){
    rafId = 0;
    const root = findWidget();
    if (!root) return;

    root.classList.add('zc-help-widget-safe', 'is-positioning');

    const mobile = window.matchMedia('(max-width: 720px)').matches;
    if (mobile){
      root.style.removeProperty('bottom');
      root.style.setProperty('--zc-help-safe-bottom-mobile', '82px');
      root.classList.remove('is-positioning');
      return;
    }

    root.style.setProperty('--zc-help-safe-right', '16px');

    // Primeiro tenta deixar o widget realmente no canto inferior.
    const baseBottom = 14;
    applyBottom(root, baseBottom);

    const actionRects = visibleActionButtons();
    if (!actionRects.length){
      root.classList.remove('is-positioning');
      return;
    }

    const rootHeight = Math.max(56, root.getBoundingClientRect().height);
    const maxBottom = Math.max(baseBottom, window.innerHeight - rootHeight - 12);
    let selectedBottom = baseBottom;

    // Procura a posição livre mais próxima do canto inferior.
    for (let bottom = baseBottom; bottom <= maxBottom; bottom += 24){
      applyBottom(root, bottom);
      const widgetRect = root.getBoundingClientRect();
      const collides = actionRects.some((actionRect) => rectsOverlap(widgetRect, actionRect, 10));
      if (!collides){
        selectedBottom = bottom;
        break;
      }
    }

    applyBottom(root, selectedBottom);
    root.classList.remove('is-positioning');
  }

  function schedulePlace(){
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => requestAnimationFrame(placeWidget));
  }

  function start(){
    schedulePlace();
    window.addEventListener('load', schedulePlace, { once: true });
    window.addEventListener('resize', schedulePlace, { passive: true });
    window.addEventListener('scroll', schedulePlace, { passive: true });

    observer = new MutationObserver((mutations) => {
      const hasAddedNodes = mutations.some((mutation) => mutation.addedNodes.length > 0);
      if (hasAddedNodes) schedulePlace();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // O help-conectar.js é carregado depois do módulo desta página.
    // Estas novas tentativas cobrem a criação assíncrona do widget.
    setTimeout(schedulePlace, 150);
    setTimeout(schedulePlace, 500);
    setTimeout(schedulePlace, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
