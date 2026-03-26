const API = "/api/admin-saas";
const STORAGE_KEY = "admin_saas_token";

const state = {
  token: sessionStorage.getItem(STORAGE_KEY) || "",
  companies: [],
  selectedId: null,
  selectedCompany: null,
  selectedBulkIds: new Set(),
  chartInstance: null
};

const els = {
  // Autenticação
  loginModal: document.getElementById("loginModal"),
  openLoginBtn: document.getElementById("openLoginBtn"),
  closeLoginModal: document.getElementById("closeLoginModal"),
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  adminPasswordInput: document.getElementById("adminPasswordInput"),
  loginError: document.getElementById("loginError"),
  sessionState: document.getElementById("sessionState"),
  themeToggleBtn: document.getElementById("themeToggleBtn"),

  // Filtros e Listas
  searchInput: document.getElementById("searchInput"),
  planFilter: document.getElementById("planFilter"),
  statusFilter: document.getElementById("statusFilter"),
  nearLimitFilter: document.getElementById("nearLimitFilter"),
  refreshBtn: document.getElementById("refreshBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  btnHome: document.getElementById("btnHome"),
  companyList: document.getElementById("companyList"),

  // Bulk Actions
  bulkActionBar: document.getElementById("bulkActionBar"),
  bulkCount: document.getElementById("bulkCount"),
  bulkPlanSelect: document.getElementById("bulkPlanSelect"),
  bulkApplyPlanBtn: document.getElementById("bulkApplyPlanBtn"),
  bulkAddTrialBtn: document.getElementById("bulkAddTrialBtn"),

  // Dashboard Metrics
  metricEmpresas: document.getElementById("metricEmpresas"),
  metricMrr: document.getElementById("metricMrr"),
  dashMrr: document.getElementById("dashMrr"),
  dashAtivos: document.getElementById("dashAtivos"),
  dashTrial: document.getElementById("dashTrial"),
  dashRecentCompanies: document.getElementById("dashRecentCompanies"),
  dashPlanDistribution: document.getElementById("dashPlanDistribution"),

  // Paineis
  dashboardPane: document.getElementById("dashboardPane"),
  detailContent: document.getElementById("detailContent"),

  // Detalhes Cliente
  detailCompanyName: document.getElementById("detailCompanyName"),
  detailCompanyInfo: document.getElementById("detailCompanyInfo"),
  detailPlanPill: document.getElementById("detailPlanPill"),
  detailStats: document.getElementById("detailStats"),
  
  planSelect: document.getElementById("planSelect"),
  expiresAtInput: document.getElementById("expiresAtInput"),
  applyPlanBtn: document.getElementById("applyPlanBtn"),
  trialPlanSelect: document.getElementById("trialPlanSelect"),
  trialDaysInput: document.getElementById("trialDaysInput"),
  startTrialBtn: document.getElementById("startTrialBtn"),
  cancelTrialBtn: document.getElementById("cancelTrialBtn"),
  
  ovWhatsappInstances: document.getElementById("ovWhatsappInstances"),
  ovUsersMax: document.getElementById("ovUsersMax"),
  ovDepartmentsMax: document.getElementById("ovDepartmentsMax"),
  ovContactsMax: document.getElementById("ovContactsMax"),
  ovBroadcastsMax: document.getElementById("ovBroadcastsMax"),
  ovCampaignsMax: document.getElementById("ovCampaignsMax"),
  saveOverridesBtn: document.getElementById("saveOverridesBtn"),
  
  requerTokenLogin: document.getElementById("requerTokenLogin"),
  saveLoginConfigBtn: document.getElementById("saveLoginConfigBtn"),
  
  instancesList: document.getElementById("instancesList"),
  recentBroadcasts: document.getElementById("recentBroadcasts"),
  logsTimeline: document.getElementById("logsTimeline"),

  // Super Tools
  internalNotes: document.getElementById("internalNotes"),
  saveNotesBtn: document.getElementById("saveNotesBtn"),
  magicLoginBtn: document.getElementById("magicLoginBtn"),
  killSwitchBtn: document.getElementById("killSwitchBtn"),
  killSwitchText: document.getElementById("killSwitchText"),

  toast: document.getElementById("toast"),
  toastMsg: document.getElementById("toastMsg"),
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabPanes: document.querySelectorAll('.tab-pane')
};

// ==========================================
// Abas e Tema
// ==========================================
if(els.tabBtns) {
  els.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      els.tabBtns.forEach(b => b.classList.remove('active'));
      els.tabPanes.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.target).classList.add('active');
    });
  });
}

if(els.themeToggleBtn) {
  els.themeToggleBtn.addEventListener('click', () => {
    document.body.classList.toggle('light-theme');
    document.body.classList.toggle('dark-theme');
    const isLight = document.body.classList.contains('light-theme');
    els.themeToggleBtn.innerHTML = isLight ? '<i class="ph ph-sun"></i>' : '<i class="ph ph-moon"></i>';
  });
}

// ==========================================
// Utilitários
// ==========================================
function money(v) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v || 0)); }
function formatDate(iso) { return !iso || Number.isNaN(new Date(iso).getTime()) ? "-" : new Date(iso).toLocaleDateString("pt-BR"); }
function formatDateTime(iso) { return !iso || Number.isNaN(new Date(iso).getTime()) ? "-" : new Date(iso).toLocaleString("pt-BR"); }
function toDatetimeLocalValue(iso) {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function showToast(message, isError = false) {
  if(!els.toast) return;
  els.toastMsg.textContent = message;
  els.toast.classList.remove("hidden");
  els.toast.style.borderLeft = isError ? "4px solid var(--danger)" : "4px solid var(--brand-color)";
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => els.toast.classList.add("hidden"), 3000);
}
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function nullableInput(value) { return value === null || value === undefined ? "" : String(value); }

// ==========================================
// Auth & API
// ==========================================
function setSession(token) {
  state.token = token || "";
  if (state.token) {
    sessionStorage.setItem(STORAGE_KEY, state.token);
    if(els.sessionState) els.sessionState.innerHTML = `<i class="ph ph-shield-check" style="color:var(--success)"></i> Autenticado`;
    if(els.openLoginBtn) els.openLoginBtn.classList.add("hidden");
    if(els.logoutBtn) els.logoutBtn.classList.remove("hidden");
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
    if(els.sessionState) els.sessionState.innerHTML = `<i class="ph ph-shield-warning"></i> Sem sessão`;
    if(els.openLoginBtn) els.openLoginBtn.classList.remove("hidden");
    if(els.logoutBtn) els.logoutBtn.classList.add("hidden");
  }
}

function openLoginModal() { if(els.loginModal) els.loginModal.classList.remove("hidden"); if(els.adminPasswordInput) els.adminPasswordInput.focus(); }
function closeLoginModal() { if(els.loginModal) els.loginModal.classList.add("hidden"); if(els.loginError) els.loginError.textContent = ""; if(els.adminPasswordInput) els.adminPasswordInput.value = ""; }

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const resp = await fetch(`${API}${path}`, { ...options, headers });
  let data = null;
  try { data = await resp.json(); } catch (_) {}
  if (!resp.ok) throw new Error(data?.detail || `Erro ${resp.status}`);
  return data;
}

// ==========================================
// Controle Visual (Dash / Detail / Bulk)
// ==========================================
function showDashboard() {
  state.selectedId = null;
  document.querySelectorAll('.company-card').forEach(c => c.classList.remove('selected'));
  if(els.detailContent) els.detailContent.classList.add("hidden");
  
  if (state.token) {
    if(els.dashboardPane) els.dashboardPane.classList.remove("hidden");
    renderDashboardView();
  } else {
    if(els.dashboardPane) els.dashboardPane.classList.add("hidden");
  }
}

function updateBulkBar() {
  if(!els.bulkActionBar) return;
  const size = state.selectedBulkIds.size;
  if(els.bulkCount) els.bulkCount.textContent = size;
  
  if (size > 0) {
    els.bulkActionBar.classList.remove("hidden");
    setTimeout(() => els.bulkActionBar.classList.add("visible"), 10);
  } else {
    els.bulkActionBar.classList.remove("visible");
    setTimeout(() => els.bulkActionBar.classList.add("hidden"), 400);
  }
}

function statusPillClass(status) {
  if (status === "active") return "badge active";
  if (status === "trial") return "badge trial";
  if (status === "suspended") return "badge past_due";
  if (status === "past_due") return "badge past_due";
  return "badge free";
}

// ==========================================
// Renders
// ==========================================
function renderDashboardView() {
  if (!state.companies.length || !els.dashAtivos) return;
  const rows = state.companies;
  const ativas = rows.filter(r => r.subscription_status === "active").length;
  const trial = rows.filter(r => r.subscription_status === "trial").length;
  
  let mrr = 0;
  rows.forEach(r => {
    if ((r.subscription_status === "active" || r.subscription_status === "trial") && r.price_monthly) mrr += Number(r.price_monthly);
  });

  if(els.metricEmpresas) els.metricEmpresas.textContent = String(rows.length);
  if(els.metricMrr) els.metricMrr.textContent = money(mrr);
  els.dashMrr.textContent = money(mrr);
  els.dashAtivos.textContent = String(ativas);
  els.dashTrial.textContent = String(trial);

  const recentes = rows.slice(0, 5);
  if(els.dashRecentCompanies) {
    els.dashRecentCompanies.innerHTML = recentes.length ? recentes.map(emp => `
      <div class="data-list-item" style="cursor:pointer" onclick="loadCompany(${emp.id})">
        <div class="data-col">
          <strong>${escapeHtml(emp.nome || "Sem nome")}</strong>
          <span>Cadastrado em: ${formatDate(emp.created_at)}</span>
        </div>
        <span class="${statusPillClass(emp.subscription_status)}">${escapeHtml(emp.subscription_status)}</span>
      </div>
    `).join("") : `<div class="empty-state" style="padding:10px"><p>Nenhuma empresa recente.</p></div>`;
  }

  const planos = {};
  rows.forEach(r => { const p = r.effective_tier || "FREE"; planos[p] = (planos[p] || 0) + 1; });
  if(els.dashPlanDistribution) {
    els.dashPlanDistribution.innerHTML = Object.keys(planos).map(plan => `
      <div class="data-list-item"><strong>Plano ${plan}</strong><span>${planos[plan]} cliente(s)</span></div>
    `).join("") || `<div class="empty-state" style="padding:10px"><p>Sem dados.</p></div>`;
  }
}

function renderCompanies(rows) {
  state.companies = rows;
  if(!els.companyList) return;

  if (!rows.length) {
    els.companyList.innerHTML = `<div class="empty-state"><p>Nenhum resultado.</p></div>`;
    return;
  }

  els.companyList.innerHTML = rows.map((item) => {
    const isChecked = state.selectedBulkIds.has(item.id) ? "checked" : "";
    const isSelected = item.id === state.selectedId ? "selected" : "";
    return `
      <div class="company-card ${isSelected}" data-view-company="${item.id}">
        <input type="checkbox" class="card-checkbox" value="${item.id}" ${isChecked}>
        <div class="company-card-content">
          <div class="card-top">
            <span class="card-title">${escapeHtml(item.nome || "Sem nome")}</span>
            <span class="card-sub">${money(item.price_monthly || 0)}</span>
          </div>
          <div class="card-sub">ID: #${item.id}</div>
          <div class="card-badges">
            <span class="${statusPillClass(item.subscription_status)}">${item.subscription_status}</span>
            <span class="badge free">${item.effective_tier || "-"}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");

  document.querySelectorAll('.card-checkbox').forEach(chk => {
    chk.addEventListener('change', (e) => {
      e.stopPropagation();
      const val = Number(e.target.value);
      if (e.target.checked) state.selectedBulkIds.add(val);
      else state.selectedBulkIds.delete(val);
      updateBulkBar();
    });
  });
}

function statItem(label, current, max) {
  const val = Number(current) || 0;
  const limit = Number(max) || 0;
  let percent = limit > 0 ? (val / limit) * 100 : (val > 0 ? 100 : 0);
  const visualPercent = Math.min(percent, 100);
  let colorClass = percent >= 100 ? "danger" : (percent >= 80 ? "warning" : "");

  return `
    <div class="stat-item">
      <div class="stat-header"><span>${escapeHtml(label)}</span><strong>${val} <small class="muted">/ ${limit === 0 ? "∞" : limit}</small></strong></div>
      <div class="progress-track"><div class="progress-fill ${colorClass}" style="width: ${visualPercent}%"></div></div>
    </div>
  `;
}

async function renderChart(empresaId) {
  try {
    const res = await api(`/empresas/${empresaId}/chart`);
    const labels = res.chart.map(d => d.date.split("-").reverse().slice(0,2).join("/"));
    const data = res.chart.map(d => d.count);
    
    if (state.chartInstance) state.chartInstance.destroy();
    
    const canvas = document.getElementById('usageChart');
    if(!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const isLight = document.body.classList.contains('light-theme');
    const gridColor = isLight ? '#e4e4e7' : '#27272a';
    const textColor = isLight ? '#71717a' : '#a1a1aa';

    state.chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{ label: 'Disparos', data, borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.15)', fill: true, tension: 0.3 }]
      },
      options: { 
        responsive: true, maintainAspectRatio: false, 
        plugins: { legend: {display: false} },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: textColor } },
          y: { grid: { color: gridColor }, ticks: { color: textColor, precision: 0 } }
        }
      }
    });
  } catch (e) { console.error(e); }
}

function renderDetail(item) {
  if (!item) return;

  state.selectedCompany = item;
  state.selectedId = item.empresa.id;

  if(els.dashboardPane) els.dashboardPane.classList.add("hidden");
  if(els.detailContent) els.detailContent.classList.remove("hidden");
  
  document.querySelectorAll('.company-card').forEach(c => c.classList.remove('selected'));
  const activeCard = document.querySelector(`.company-card[data-view-company="${state.selectedId}"]`);
  if (activeCard) activeCard.classList.add('selected');

  const emp = item.empresa;
  const counts = emp.counts || {};
  const limits = emp.limits || {};
  const overrides = emp.overrides || {};

  if(els.detailCompanyName) els.detailCompanyName.textContent = emp.nome || "Sem nome";
  if(els.detailCompanyInfo) els.detailCompanyInfo.textContent = `ID: #${emp.id} • ${emp.nome_adm || "Sem admin"} • ${emp.telefone || "-"} • CNPJ: ${emp.cnpj_cpf || "N/A"}`;
  
  // Proteção para o elemento que causou crash:
  if(els.detailPlanPill) {
    els.detailPlanPill.className = statusPillClass(emp.subscription_status);
    els.detailPlanPill.textContent = `${emp.plan_name || emp.effective_tier} • ${emp.subscription_status}`;
  }

  // Super Tools
  if(els.internalNotes) els.internalNotes.value = overrides.internal_notes || "";
  
  const susp = overrides.is_suspended;
  if(els.killSwitchBtn) els.killSwitchBtn.className = susp ? "btn primary ml-sm" : "btn ghost danger ml-sm";
  if(els.killSwitchText) els.killSwitchText.textContent = susp ? "Reativar Acesso" : "Suspender";

  if(els.detailStats) {
    els.detailStats.innerHTML = [
      statItem("Números Conectados", counts.whatsapp_instances_connected, limits.whatsapp_instances_max),
      statItem("Membros da Equipe", counts.team_members, limits.users_max),
      statItem("Departamentos/Filas", counts.departments, limits.departments_max),
      statItem("Base de Contatos", counts.contacts, limits.contacts_max),
      statItem("Disparos no Mês", counts.broadcasts_month, limits.broadcasts_per_month_max),
      statItem("Campanhas Ativas", counts.active_campaigns, limits.active_campaigns_max),
    ].join("");
  }

  renderChart(emp.id);

  if(els.planSelect) els.planSelect.value = emp.assinatura || "FREE";
  if(els.expiresAtInput) els.expiresAtInput.value = toDatetimeLocalValue(emp.plano_expira_em);
  if(els.trialPlanSelect) els.trialPlanSelect.value = emp.trial?.tier || "START";
  if(els.trialDaysInput) els.trialDaysInput.value = emp.trial?.days_left || 7;

  if(els.ovWhatsappInstances) els.ovWhatsappInstances.value = nullableInput(overrides.whatsapp_instances_max);
  if(els.ovUsersMax) els.ovUsersMax.value = nullableInput(overrides.users_max);
  if(els.ovDepartmentsMax) els.ovDepartmentsMax.value = nullableInput(overrides.departments_max);
  if(els.ovContactsMax) els.ovContactsMax.value = nullableInput(overrides.contacts_max);
  if(els.ovBroadcastsMax) els.ovBroadcastsMax.value = nullableInput(overrides.broadcasts_per_month_max);
  if(els.ovCampaignsMax) els.ovCampaignsMax.value = nullableInput(overrides.active_campaigns_max);

  if(els.requerTokenLogin) els.requerTokenLogin.checked = !!emp.requer_token_login;

  renderInstances(item.instancias || []);
  renderRecentBroadcasts(item.recent_disparos || []);
  renderLogs(item.logs || []);
}

function renderInstances(list) {
  if(!els.instancesList) return;
  els.instancesList.innerHTML = list.length ? list.map((item) => `
    <div class="data-list-item">
      <div class="data-col">
        <strong>${escapeHtml(item.apelido || item.instance_name || `Instância ${item.id}`)}</strong>
        <span>Número: ${escapeHtml(item.numero_instancia || "-")}</span>
      </div>
      <span class="badge ${item.connected ? 'active' : 'past_due'}">${item.connected ? "🟢 Online" : "🔴 Offline"}</span>
    </div>
  `).join("") : `<div class="data-list-item"><span>Nenhuma instância conectada.</span></div>`;
}

function renderRecentBroadcasts(list) {
  if(!els.recentBroadcasts) return;
  els.recentBroadcasts.innerHTML = list.length ? list.map((item) => `
    <div class="data-list-item">
      <div class="data-col">
        <strong>#${item.id} • ${escapeHtml(item.status || "-")}</strong>
        <span>Criado em: ${formatDateTime(item.criado_em)}</span>
      </div>
      <span class="badge free">${item.total_destinatarios || 0} envios</span>
    </div>
  `).join("") : `<div class="data-list-item"><span>Nenhum disparo recente.</span></div>`;
}

function renderLogs(logs) {
  if(!els.logsTimeline) return;
  els.logsTimeline.innerHTML = logs.length ? logs.map(log => `
    <div class="timeline-item">
      <div class="log-date">${formatDateTime(log.criado_em)}</div>
      <div class="log-action">${escapeHtml(log.acao)}</div>
    </div>
  `).join("") : `<div class="empty-state"><p>Nenhum histórico recente para esta empresa.</p></div>`;
}

// ==========================================
// Integração API
// ==========================================
async function loadCompanies() {
  const qs = new URLSearchParams({ page: 1, limit: 100 });
  if (els.searchInput && els.searchInput.value.trim()) qs.set("q", els.searchInput.value.trim());
  if (els.planFilter && els.planFilter.value) qs.set("plan", els.planFilter.value);
  if (els.statusFilter && els.statusFilter.value) qs.set("status", els.statusFilter.value);
  if (els.nearLimitFilter && els.nearLimitFilter.checked) qs.set("near_limit", "true");

  try {
    const data = await api(`/empresas?${qs.toString()}`);
    renderCompanies(data.items || []);
    if (!state.selectedId) renderDashboardView();
    else {
      const found = data.items.find(x => x.id === state.selectedId);
      if (found) await loadCompany(found.id);
    }
  } catch(err) { showToast(err.message, true); }
}

async function loadCompany(id) {
  try {
    const data = await api(`/empresas/${id}`);
    renderDetail(data);
  } catch(err) { showToast(err.message, true); }
}

async function doLogin() {
  if(els.loginError) els.loginError.textContent = "";
  setSession("");
  try {
    const data = await api(`/auth/login`, { method: "POST", body: JSON.stringify({ password: (els.adminPasswordInput.value || "").trim() }) });
    setSession(data.token);
    closeLoginModal();
    await loadCompanies();
    showDashboard();
    showToast("Acesso liberado.");
  } catch (err) { if(els.loginError) els.loginError.textContent = err.message || "Senha inválida."; }
}

// Super Tools (CRM, Impersonation, Kill Switch)
if(els.saveNotesBtn) {
  els.saveNotesBtn.addEventListener('click', async () => {
    if (!state.selectedId) return;
    try {
      await api(`/empresas/${state.selectedId}/notes`, { method: "PUT", body: JSON.stringify({ internal_notes: els.internalNotes.value }) });
      showToast("Anotações do CRM salvas.");
    } catch(e) { showToast(e.message, true); }
  });
}

if(els.magicLoginBtn) {
  els.magicLoginBtn.addEventListener('click', async () => {
    if (!state.selectedId) return;
    try {
      const res = await api(`/empresas/${state.selectedId}/impersonate`, { method: "POST" });
      window.open(`/painel?magic_token=${res.magic_token}`, '_blank');
    } catch(e) { showToast("Falha no acesso mágico.", true); }
  });
}

if(els.killSwitchBtn) {
  els.killSwitchBtn.addEventListener('click', async () => {
    if (!state.selectedId) return;
    if(!confirm("Tem certeza que deseja alterar a suspensão dessa conta? O bloqueio é imediato.")) return;
    try {
      await api(`/empresas/${state.selectedId}/toggle-suspension`, { method: "POST" });
      showToast("Status atualizado!");
      await loadCompany(state.selectedId);
      await loadCompanies();
    } catch(e) { showToast(e.message, true); }
  });
}

// Ações Individuais Clássicas
async function applyPlan() {
  if (!state.selectedId) return;
  try {
    const expiresAt = els.expiresAtInput.value ? new Date(els.expiresAtInput.value).toISOString() : null;
    await api(`/empresas/${state.selectedId}/apply-plan`, { method: "POST", body: JSON.stringify({ assinatura: els.planSelect.value, expires_at: expiresAt, duration_days: 30 }) });
    showToast("Assinatura atualizada!");
    await loadCompany(state.selectedId);
    await loadCompanies();
  } catch (err) { showToast(err.message, true); }
}

async function startTrial() {
  if (!state.selectedId) return;
  try {
    await api(`/empresas/${state.selectedId}/start-trial`, { method: "POST", body: JSON.stringify({ tier: els.trialPlanSelect.value, days: Number(els.trialDaysInput.value || 7) }) });
    showToast("Trial iniciado.");
    await loadCompany(state.selectedId);
    await loadCompanies();
  } catch (err) { showToast(err.message, true); }
}

async function cancelTrial() {
  if (!state.selectedId) return;
  try {
    await api(`/empresas/${state.selectedId}/cancel-trial`, { method: "POST" });
    showToast("Trial cancelado.");
    await loadCompany(state.selectedId);
    await loadCompanies();
  } catch (err) { showToast(err.message, true); }
}

async function saveOverrides() {
  if (!state.selectedId) return;
  const parse = (v) => v ? Math.max(0, Math.trunc(Number(v))) : null;
  try {
    await api(`/empresas/${state.selectedId}/overrides`, { method: "POST", body: JSON.stringify({
      whatsapp_instances_max: parse(els.ovWhatsappInstances.value),
      users_max: parse(els.ovUsersMax.value),
      departments_max: parse(els.ovDepartmentsMax.value),
      contacts_max: parse(els.ovContactsMax.value),
      broadcasts_per_month_max: parse(els.ovBroadcastsMax.value),
      active_campaigns_max: parse(els.ovCampaignsMax.value),
    })});
    showToast("Limites manuais salvos.");
    await loadCompany(state.selectedId);
  } catch (err) { showToast(err.message, true); }
}

async function saveLoginConfig() {
  if (!state.selectedId) return;
  try {
    await api(`/empresas/${state.selectedId}/login-config`, { method: "PUT", body: JSON.stringify({ requer_token_login: !!els.requerTokenLogin.checked }) });
    showToast("Segurança salva.");
    await loadCompany(state.selectedId);
  } catch (err) { showToast(err.message, true); }
}

// Bulk Actions
if(els.bulkApplyPlanBtn) {
  els.bulkApplyPlanBtn.addEventListener('click', async () => {
    const plan = els.bulkPlanSelect.value;
    if (!plan) return showToast("Selecione um plano na lista", true);
    try {
      await api(`/empresas/bulk-action`, { method: "POST", body: JSON.stringify({ empresa_ids: Array.from(state.selectedBulkIds), action: "apply_plan", plan }) });
      state.selectedBulkIds.clear(); updateBulkBar(); await loadCompanies();
      showToast("Planos alterados em massa!");
    } catch(e) { showToast(e.message, true); }
  });
}

if(els.bulkAddTrialBtn) {
  els.bulkAddTrialBtn.addEventListener('click', async () => {
    try {
      await api(`/empresas/bulk-action`, { method: "POST", body: JSON.stringify({ empresa_ids: Array.from(state.selectedBulkIds), action: "add_trial", days: 7 }) });
      state.selectedBulkIds.clear(); updateBulkBar(); await loadCompanies();
      showToast("+7 dias de trial adicionados em massa!");
    } catch(e) { showToast(e.message, true); }
  });
}

function exportToCSV() {
  if (!state.companies || !state.companies.length) return showToast("Nenhum dado.", true);
  const headers = ["ID", "Empresa", "Admin", "Telefone", "CNPJ", "Plano Efetivo", "Status", "MRR Estimado", "Data Cadastro"];
  const rows = state.companies.map(emp => [
    emp.id, `"${emp.nome || ""}"`, `"${emp.nome_adm || ""}"`, emp.telefone || "", emp.cnpj_cpf || "",
    emp.effective_tier || "", emp.subscription_status || "", emp.price_monthly || 0, formatDate(emp.created_at)
  ].join(","));

  const blob = new Blob([[headers.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `SaaS_Clientes_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast("Planilha baixada.");
}

// ==========================================
// Listeners e Inicialização
// ==========================================
function bindEvents() {
  if(els.openLoginBtn) els.openLoginBtn.addEventListener("click", openLoginModal);
  if(els.closeLoginModal) els.closeLoginModal.addEventListener("click", closeLoginModal);
  if(els.loginBtn) els.loginBtn.addEventListener("click", doLogin);

  if(els.logoutBtn) {
    els.logoutBtn.addEventListener("click", () => {
      setSession(""); showDashboard();
      if(els.companyList) els.companyList.innerHTML = `<div class="empty-state"><p>Faça login para carregar os clientes.</p></div>`;
      showToast("Sessão encerrada.");
    });
  }

  if(els.btnHome) els.btnHome.addEventListener("click", showDashboard);
  if(els.adminPasswordInput) els.adminPasswordInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  if(els.refreshBtn) els.refreshBtn.addEventListener("click", loadCompanies);
  if(els.exportCsvBtn) els.exportCsvBtn.addEventListener("click", exportToCSV);
  
  [els.searchInput, els.planFilter, els.statusFilter, els.nearLimitFilter].forEach((el) => {
    if(el) el.addEventListener("change", loadCompanies);
  });
  if(els.searchInput) els.searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadCompanies(); });

  if(els.companyList) {
    els.companyList.addEventListener("click", async (e) => {
      if (e.target.classList.contains('card-checkbox')) return;
      const card = e.target.closest(".company-card");
      if (!card) return;
      await loadCompany(Number(card.getAttribute("data-view-company")));
    });
  }

  if(els.applyPlanBtn) els.applyPlanBtn.addEventListener("click", applyPlan);
  if(els.startTrialBtn) els.startTrialBtn.addEventListener("click", startTrial);
  if(els.cancelTrialBtn) els.cancelTrialBtn.addEventListener("click", cancelTrial);
  if(els.saveOverridesBtn) els.saveOverridesBtn.addEventListener("click", saveOverrides);
  if(els.saveLoginConfigBtn) els.saveLoginConfigBtn.addEventListener("click", saveLoginConfig);
}

async function boot() {
  bindEvents();
  
  if (!state.token) return openLoginModal();
  try {
    await api(`/session`);
    setSession(state.token);
    await loadCompanies();
    showDashboard();
  } catch (_) {
    setSession("");
    openLoginModal();
  }
}

boot();