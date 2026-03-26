const API = "/api/admin-saas";
const STORAGE_KEY = "admin_saas_token";

const state = {
  token: sessionStorage.getItem(STORAGE_KEY) || "",
  companies: [],
  selectedId: null,
  selectedCompany: null,
};

const els = {
  loginModal: document.getElementById("loginModal"),
  openLoginBtn: document.getElementById("openLoginBtn"),
  closeLoginModal: document.getElementById("closeLoginModal"),
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  adminPasswordInput: document.getElementById("adminPasswordInput"),
  loginError: document.getElementById("loginError"),
  sessionState: document.getElementById("sessionState"),

  searchInput: document.getElementById("searchInput"),
  planFilter: document.getElementById("planFilter"),
  statusFilter: document.getElementById("statusFilter"),
  refreshBtn: document.getElementById("refreshBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),

  companyList: document.getElementById("companyList"),

  metricEmpresas: document.getElementById("metricEmpresas"),
  metricAtivas: document.getElementById("metricAtivas"),
  metricTrial: document.getElementById("metricTrial"),
  metricMrr: document.getElementById("metricMrr"),

  detailEmpty: document.getElementById("detailEmpty"),
  detailContent: document.getElementById("detailContent"),
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

  toast: document.getElementById("toast"),
  toastMsg: document.getElementById("toastMsg"),
  
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabPanes: document.querySelectorAll('.tab-pane')
};

// ==========================================
// Gerenciamento de Abas
// ==========================================
els.tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    els.tabBtns.forEach(b => b.classList.remove('active'));
    els.tabPanes.forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.target).classList.add('active');
  });
});

// ==========================================
// Utilitários
// ==========================================
function money(v) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v || 0));
}

function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("pt-BR");
}

function toDatetimeLocalValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function showToast(message, isError = false) {
  els.toastMsg.textContent = message;
  els.toast.classList.remove("hidden");
  els.toast.style.borderLeft = isError ? "4px solid var(--danger)" : "4px solid var(--brand-color)";
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => els.toast.classList.add("hidden"), 3000);
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function nullableInput(value) {
  return value === null || value === undefined ? "" : String(value);
}

// ==========================================
// Auth & API
// ==========================================
function setSession(token) {
  state.token = token || "";
  if (state.token) {
    sessionStorage.setItem(STORAGE_KEY, state.token);
    els.sessionState.innerHTML = `<i class="ph ph-shield-check" style="color:var(--success)"></i> Autenticado`;
    els.openLoginBtn.classList.add("hidden");
    els.logoutBtn.classList.remove("hidden");
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
    els.sessionState.innerHTML = `<i class="ph ph-shield-warning"></i> Sem sessão`;
    els.openLoginBtn.classList.remove("hidden");
    els.logoutBtn.classList.add("hidden");
  }
}

function openLoginModal() { els.loginModal.classList.remove("hidden"); els.adminPasswordInput.focus(); }
function closeLoginModal() { els.loginModal.classList.add("hidden"); els.loginError.textContent = ""; els.adminPasswordInput.value = ""; }

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  
  const resp = await fetch(`${API}${path}`, { ...options, headers });
  let data = null;
  try { data = await resp.json(); } catch (_) { data = null; }
  
  if (!resp.ok) throw new Error(data?.detail || `Erro ${resp.status}`);
  return data;
}

// ==========================================
// Renderização Principal (Listas e Dashboards)
// ==========================================
function statusPillClass(status) {
  if (status === "active") return "badge active";
  if (status === "trial") return "badge trial";
  if (status === "past_due") return "badge past_due";
  return "badge free";
}

function renderMetrics(rows, mrrVisible) {
  els.metricEmpresas.textContent = String(rows.length);
  els.metricAtivas.textContent = String(rows.filter((r) => r.subscription_status === "active").length);
  els.metricTrial.textContent = String(rows.filter((r) => r.subscription_status === "trial").length);
  els.metricMrr.textContent = money(mrrVisible || 0);
}

function renderCompanies(rows) {
  state.companies = rows;

  if (!rows.length) {
    els.companyList.innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><p>Nenhum resultado.</p></div>`;
    return;
  }

  els.companyList.innerHTML = rows.map((item) => {
    const isSelected = item.id === state.selectedId ? "selected" : "";
    return `
      <div class="company-card ${isSelected}" data-view-company="${item.id}">
        <div class="card-top">
          <span class="card-title">${escapeHtml(item.nome || "Sem nome")}</span>
          <span class="card-sub">${money(item.price_monthly || 0)}/mês</span>
        </div>
        <div class="card-sub">ID: #${item.id} • ${escapeHtml(item.telefone || "Sem telefone")}</div>
        <div class="card-badges">
          <span class="${statusPillClass(item.subscription_status)}">${escapeHtml(item.subscription_status)}</span>
          <span class="badge free">${escapeHtml(item.plan_name || item.effective_tier || "-")}</span>
        </div>
      </div>
    `;
  }).join("");
}

// Sparklines component function
function statItem(label, current, max) {
  const val = Number(current) || 0;
  const limit = Number(max) || 0;
  let percent = 0;
  
  if (limit > 0) {
    percent = (val / limit) * 100;
  } else if (limit === 0 && val > 0) {
    percent = 100; // Estourou plano ilimitado visualmente
  }
  
  const visualPercent = Math.min(percent, 100);
  
  let colorClass = "";
  if (percent >= 100) colorClass = "danger";
  else if (percent >= 80) colorClass = "warning";

  return `
    <div class="stat-item">
      <div class="stat-header">
        <span>${escapeHtml(label)}</span>
        <strong>${val} <small class="muted">/ ${limit === 0 ? "∞" : limit}</small></strong>
      </div>
      <div class="progress-track">
        <div class="progress-fill ${colorClass}" style="width: ${visualPercent}%"></div>
      </div>
    </div>
  `;
}

function renderDetail(item) {
  if (!item) return;

  state.selectedCompany = item;
  state.selectedId = item.empresa.id;

  // Marca visualmente na lista lateral
  document.querySelectorAll('.company-card').forEach(c => c.classList.remove('selected'));
  const activeCard = document.querySelector(`.company-card[data-view-company="${state.selectedId}"]`);
  if (activeCard) activeCard.classList.add('selected');

  els.detailEmpty.classList.add("hidden");
  els.detailContent.classList.remove("hidden");

  const empresa = item.empresa;
  const counts = empresa.counts || {};
  const limits = empresa.limits || {};
  const overrides = empresa.overrides || {};

  els.detailCompanyName.textContent = empresa.nome || "Sem nome";
  els.detailCompanyInfo.textContent = `ID: #${empresa.id} • ${empresa.nome_adm || "Sem admin"} • ${empresa.telefone || "-"} • CNPJ: ${empresa.cnpj_cpf || "N/A"}`;
  els.detailPlanPill.className = statusPillClass(empresa.subscription_status);
  els.detailPlanPill.textContent = `${empresa.plan_name || empresa.effective_tier} • ${empresa.subscription_status}`;

  // Injeta as Sparklines
  els.detailStats.innerHTML = [
    statItem("Números Conectados", counts.whatsapp_instances_connected, limits.whatsapp_instances_max),
    statItem("Membros da Equipe", counts.team_members, limits.users_max),
    statItem("Departamentos/Filas", counts.departments, limits.departments_max),
    statItem("Base de Contatos", counts.contacts, limits.contacts_max),
    statItem("Disparos no Mês", counts.broadcasts_month, limits.broadcasts_per_month_max),
    statItem("Campanhas Ativas", counts.active_campaigns, limits.active_campaigns_max),
  ].join("");

  // Formulários
  els.planSelect.value = empresa.assinatura || "FREE";
  els.expiresAtInput.value = toDatetimeLocalValue(empresa.plano_expira_em);
  els.trialPlanSelect.value = empresa.trial?.tier || "START";
  els.trialDaysInput.value = empresa.trial?.days_left || 7;

  els.ovWhatsappInstances.value = nullableInput(overrides.whatsapp_instances_max);
  els.ovUsersMax.value = nullableInput(overrides.users_max);
  els.ovDepartmentsMax.value = nullableInput(overrides.departments_max);
  els.ovContactsMax.value = nullableInput(overrides.contacts_max);
  els.ovBroadcastsMax.value = nullableInput(overrides.broadcasts_per_month_max);
  els.ovCampaignsMax.value = nullableInput(overrides.active_campaigns_max);

  els.requerTokenLogin.checked = !!empresa.requer_token_login;

  // Renderiza sub-listas
  renderInstances(item.instancias || []);
  renderRecentBroadcasts(item.recent_disparos || []);
  renderLogs(item.logs || []);
}

function renderInstances(list) {
  if (!list.length) {
    els.instancesList.innerHTML = `<div class="data-list-item"><span>Nenhuma instância conectada.</span></div>`;
    return;
  }
  els.instancesList.innerHTML = list.map((item) => `
    <div class="data-list-item">
      <strong>${escapeHtml(item.apelido || item.instance_name || `Instância ${item.id}`)}</strong>
      <span>${escapeHtml(item.numero_instancia || "-")} • ${item.connected ? "🟢 Online" : "🔴 Offline"}</span>
    </div>
  `).join("");
}

function renderRecentBroadcasts(list) {
  if (!list.length) {
    els.recentBroadcasts.innerHTML = `<div class="data-list-item"><span>Nenhum disparo recente.</span></div>`;
    return;
  }
  els.recentBroadcasts.innerHTML = list.map((item) => `
    <div class="data-list-item">
      <strong>#${item.id} • ${escapeHtml(item.status || "-")}</strong>
      <span>${item.total_destinatarios || 0} destinos • ${formatDate(item.criado_em)}</span>
    </div>
  `).join("");
}

function renderLogs(logs) {
  if (!logs || !logs.length) {
    els.logsTimeline.innerHTML = `<div class="empty-state"><i class="ph ph-mask-happy"></i><p>Nenhum histórico de ações do admin para esta empresa.</p></div>`;
    return;
  }
  els.logsTimeline.innerHTML = logs.map(log => `
    <div class="timeline-item">
      <div class="log-date">${formatDate(log.criado_em)}</div>
      <div class="log-action">${escapeHtml(log.acao)}</div>
    </div>
  `).join("");
}

// ==========================================
// Ações de Comunicação API
// ==========================================
async function loadCompanies() {
  const qs = new URLSearchParams();
  if (els.searchInput.value.trim()) qs.set("q", els.searchInput.value.trim());
  if (els.planFilter.value) qs.set("plan", els.planFilter.value);
  if (els.statusFilter.value) qs.set("status", els.statusFilter.value);
  qs.set("page", "1");
  qs.set("limit", "100"); // Aumentado o limit base

  try {
    const data = await api(`/empresas?${qs.toString()}`);
    const rows = data.items || [];
    renderMetrics(rows, data.mrr_visible || 0);
    renderCompanies(rows);

    if (state.selectedId) {
      const found = rows.find((x) => x.id === state.selectedId);
      if (found) await loadCompany(found.id);
    }
  } catch(err) {
    showToast(err.message || "Erro ao carregar empresas.", true);
  }
}

async function loadCompany(id) {
  try {
    const data = await api(`/empresas/${id}`);
    renderDetail(data);
  } catch(err) {
    showToast(err.message, true);
  }
}

async function doLogin() {
  els.loginError.textContent = "";
  setSession("");
  try {
    const data = await api(`/auth/login`, { method: "POST", body: JSON.stringify({ password: (els.adminPasswordInput.value || "").trim() }) });
    setSession(data.token);
    closeLoginModal();
    await loadCompanies();
    showToast("Acesso liberado com sucesso.");
  } catch (err) { els.loginError.textContent = err.message || "Senha inválida."; }
}

async function applyPlan() {
  if (!state.selectedId) return;
  try {
    const expiresAt = els.expiresAtInput.value ? new Date(els.expiresAtInput.value).toISOString() : null;
    await api(`/empresas/${state.selectedId}/apply-plan`, { method: "POST", body: JSON.stringify({ assinatura: els.planSelect.value, expires_at: expiresAt, duration_days: 30 }) });
    showToast("Assinatura atualizada!");
    await loadCompany(state.selectedId);
    await loadCompanies(); // Recarrega lateral
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

// ==========================================
// Exportação CSV
// ==========================================
function exportToCSV() {
  if (!state.companies || state.companies.length === 0) {
    showToast("Nenhum dado para exportar.", true);
    return;
  }
  
  const headers = ["ID", "Empresa", "Admin", "Telefone", "CNPJ", "Plano Efetivo", "Status", "MRR Estimado", "Data Cadastro"];
  
  const rows = state.companies.map(emp => {
    return [
      emp.id,
      `"${emp.nome || ""}"`,
      `"${emp.nome_adm || ""}"`,
      emp.telefone || "",
      emp.cnpj_cpf || "",
      emp.effective_tier || "",
      emp.subscription_status || "",
      emp.price_monthly || 0,
      formatDate(emp.created_at)
    ].join(",");
  });

  const csvContent = [headers.join(","), ...rows].join("\n");
  
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `SaaS_Clientes_${new Date().toISOString().split('T')[0]}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  showToast("Planilha CSV gerada e baixada com sucesso!");
}

// ==========================================
// Boot & Listeners
// ==========================================
function bindEvents() {
  els.openLoginBtn.addEventListener("click", openLoginModal);
  els.closeLoginModal.addEventListener("click", closeLoginModal);
  els.loginBtn.addEventListener("click", doLogin);

  els.logoutBtn.addEventListener("click", () => {
    setSession("");
    state.selectedId = null;
    els.detailContent.classList.add("hidden");
    els.detailEmpty.classList.remove("hidden");
    els.companyList.innerHTML = `<div class="empty-state"><i class="ph ph-folder-lock"></i><p>Faça login para carregar os clientes.</p></div>`;
    showToast("Sessão encerrada.");
  });

  els.adminPasswordInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  els.refreshBtn.addEventListener("click", loadCompanies);
  els.exportCsvBtn.addEventListener("click", exportToCSV);
  
  [els.searchInput, els.planFilter, els.statusFilter].forEach((el) => {
    el.addEventListener("change", loadCompanies);
  });
  els.searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadCompanies(); });

  // Clique nos cards da master-list (Delegação)
  els.companyList.addEventListener("click", async (e) => {
    const card = e.target.closest(".company-card");
    if (!card) return;
    const id = Number(card.getAttribute("data-view-company"));
    if (id) await loadCompany(id);
  });

  els.applyPlanBtn.addEventListener("click", applyPlan);
  els.startTrialBtn.addEventListener("click", startTrial);
  els.cancelTrialBtn.addEventListener("click", cancelTrial);
  els.saveOverridesBtn.addEventListener("click", saveOverrides);
  els.saveLoginConfigBtn.addEventListener("click", saveLoginConfig);
}

async function boot() {
  bindEvents();
  if (!state.token) { openLoginModal(); return; }
  try {
    await api(`/session`);
    setSession(state.token);
    await loadCompanies();
  } catch (_) {
    setSession("");
    openLoginModal();
  }
}

// Iniciar Aplicação
boot();