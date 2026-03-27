(function MeuPlanoPage() {
  "use strict";

  const els = {
    alertArea: document.getElementById("alertArea"),
    planName: document.getElementById("planName"),
    planPrice: document.getElementById("planPrice"),
    planBadges: document.getElementById("planBadges"),
    heroMeta: document.getElementById("heroMeta"),

    statContacts: document.getElementById("statContacts"),
    statTeam: document.getElementById("statTeam"),
    statDepartments: document.getElementById("statDepartments"),
    statInstances: document.getElementById("statInstances"),
    statBroadcasts: document.getElementById("statBroadcasts"),
    statCampaigns: document.getElementById("statCampaigns"),

    featuresList: document.getElementById("featuresList"),
    usageList: document.getElementById("usageList"),
    instancesList: document.getElementById("instancesList"),
    broadcastList: document.getElementById("broadcastList"),
    planCompare: document.getElementById("planCompare"),

    btnReload: document.getElementById("btnReload"),
    btnScrollCompare: document.getElementById("btnScrollCompare"),
    compareSection: document.getElementById("compareSection"),

    toast: document.getElementById("meuPlanoToast"),
    toastIcon: document.querySelector("#meuPlanoToast .toast-icon"),
    toastText: document.querySelector("#meuPlanoToast .toast-text"),
  };

  const FEATURE_META = {
    feature_automation: { label: "Automações", desc: "Crie fluxos e ações automáticas." },
    feature_advanced_automation: { label: "Automações avançadas", desc: "Regras mais poderosas e cenários." },
    feature_reports_basic: { label: "Relatórios básicos", desc: "Métricas essenciais de uso e operação." },
    feature_reports_advanced: { label: "Relatórios avançados", desc: "Análises mais profundas e visões." },
    feature_api_webhooks: { label: "API e webhooks", desc: "Integrações externas e eventos." },
    feature_audit_log: { label: "Log de auditoria", desc: "Rastreamento de histórico de ações." },
    feature_import: { label: "Importação", desc: "Importe contatos e dados em lote." },
    feature_export: { label: "Exportação", desc: "Exporte dados e relatórios." },
    feature_broadcasts: { label: "Disparos", desc: "Envio em massa para campanhas." },
  };

  const USAGE_ITEMS = [
    { key: "whatsapp_instances", limitKey: "whatsapp_instances_max", label: "Números WhatsApp" },
    { key: "team_members", limitKey: "users_max", label: "Membros da equipe" },
    { key: "departments", limitKey: "departments_max", label: "Departamentos" },
    { key: "contacts", limitKey: "contacts_max", label: "Contatos" },
    { key: "broadcasts_month", limitKey: "broadcasts_per_month_max", label: "Disparos no mês" },
    { key: "active_campaigns", limitKey: "active_campaigns_max", label: "Campanhas ativas" },
  ];

  let toastTimer = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function intVal(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  function money(value) {
    const n = intVal(value, 0);
    if (n <= 0) return "Gratuito";
    return n.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
      maximumFractionDigits: 0
    }) + "/mês";
  }

  function numberBr(value) {
    return intVal(value, 0).toLocaleString("pt-BR");
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function formatDateOnly(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("pt-BR");
  }

  function showToast(message, isError) {
    if (!els.toast || !els.toastText || !els.toastIcon) return;

    els.toastText.textContent = message || "";
    els.toast.classList.remove("is-error", "is-success", "show");
    els.toastIcon.className = "toast-icon fa-solid";

    if (isError) {
      els.toast.classList.add("is-error");
      els.toastIcon.classList.add("fa-triangle-exclamation");
    } else {
      els.toast.classList.add("is-success");
      els.toastIcon.classList.add("fa-circle-check");
    }

    void els.toast.offsetWidth;
    els.toast.classList.add("show");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("show");
    }, 3200);
  }

  async function apiJson(url, options = {}) {
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        "Accept": "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });

    if (res.status === 401) {
      window.location.href = "/login.html?next=/meu-plano";
      throw new Error("Sessão expirada.");
    }

    let data = null;
    try {
      data = await res.json();
    } catch (_) {}

    if (!res.ok) {
      throw new Error(data?.detail || data?.message || "Erro ao carregar dados do plano.");
    }

    return data;
  }

  function badge(label, type = "default", icon = "fa-circle") {
    return `
      <span class="badge badge--${type}">
        <i class="fa-solid ${icon}"></i>
        ${escapeHtml(label)}
      </span>
    `;
  }

  function renderAlerts(payload) {
    if (!els.alertArea) return;

    const plan = payload?.plan || {};
    const paid = plan.paid || {};
    const trial = plan.trial || {};
    const blocks = [];

    if (payload?.custom_limits) {
      blocks.push(`
        <div class="alert alert--info">
          <i class="fa-solid fa-sliders"></i>
          <div>
            <strong>Limites personalizados</strong>
            <p>Sua empresa possui limites ajustados especificamente para sua conta.</p>
          </div>
        </div>
      `);
    }

    if (payload.subscription_status === "suspended") {
      blocks.push(`
        <div class="alert alert--danger">
          <i class="fa-solid fa-ban"></i>
          <div>
            <strong>Conta suspensa</strong>
            <p>Sua conta está marcada como suspensa. Entre em contato para regularização.</p>
          </div>
        </div>
      `);
    }

    if (trial.active) {
      blocks.push(`
        <div class="alert alert--info">
          <i class="fa-solid fa-flask-vial"></i>
          <div>
            <strong>Trial ativo</strong>
            <p>Você está testando o plano ${escapeHtml(plan.plan_name || trial.tier || "—")} até ${escapeHtml(formatDateOnly(trial.expires_at))}. Restam ${escapeHtml(String(intVal(trial.days_left, 0)))} dia(s).</p>
          </div>
        </div>
      `);
    }

    if (paid.expired) {
      blocks.push(`
        <div class="alert alert--danger">
          <i class="fa-solid fa-circle-exclamation"></i>
          <div>
            <strong>Plano vencido</strong>
            <p>O ciclo do seu plano venceu. Atualize ou renove para manter o acesso completo.</p>
          </div>
        </div>
      `);
    } else if (paid.expiring_soon) {
      blocks.push(`
        <div class="alert alert--warning">
          <i class="fa-solid fa-clock"></i>
          <div>
            <strong>Plano perto do vencimento</strong>
            <p>Seu plano vence em ${escapeHtml(String(intVal(paid.days_left, 0)))} dia(s), em ${escapeHtml(formatDateOnly(paid.expires_at))}.</p>
          </div>
        </div>
      `);
    }

    if (!blocks.length) {
      blocks.push(`
        <div class="alert alert--success">
          <i class="fa-solid fa-circle-check"></i>
          <div>
            <strong>Situação da assinatura em dia</strong>
            <p>Seu acesso está regular e os recursos do plano estão disponíveis normalmente.</p>
          </div>
        </div>
      `);
    }

    els.alertArea.innerHTML = blocks.join("");
  }

  function renderHero(payload) {
    const company = payload?.company || {};
    const plan = payload?.plan || {};
    const paid = plan.paid || {};
    const trial = plan.trial || {};
    const status = payload?.subscription_status || "free";

    els.planName.textContent = plan.plan_name || "Plano não identificado";
    els.planPrice.textContent = money(plan.price_monthly || 0);

    const badges = [];
    badges.push(badge(plan.plan_name || "Plano", "primary", "fa-crown"));

    if (status === "active") badges.push(badge("Ativo", "success", "fa-circle-check"));
    if (status === "trial") badges.push(badge("Trial", "info", "fa-flask-vial"));
    if (status === "free") badges.push(badge("Free", "default", "fa-gem"));
    if (status === "past_due") badges.push(badge("Vencido", "danger", "fa-triangle-exclamation"));
    if (status === "suspended") badges.push(badge("Suspenso", "danger", "fa-ban"));

    if (trial.active) {
      badges.push(badge(`${intVal(trial.days_left, 0)} dia(s) de trial`, "warning", "fa-hourglass-half"));
    }

    if (paid.expiring_soon) {
      badges.push(badge(`Vence em ${intVal(paid.days_left, 0)} dia(s)`, "warning", "fa-clock"));
    }

    els.planBadges.innerHTML = badges.join("");

    const meta = [
      { label: "Empresa", value: company.nome || "—" },
      { label: "Responsável", value: company.nome_adm || "—" },
      { label: "Vencimento", value: paid.expires_at ? formatDateOnly(paid.expires_at) : (trial.expires_at ? formatDateOnly(trial.expires_at) : "—") },
      { label: "Telefone", value: company.telefone || "—" },
      { label: "CNPJ / CPF", value: company.cnpj_cpf || "—" },
      { label: "2FA", value: company.requer_token_login ? "Ativado" : "Desativado" },
    ];

    els.heroMeta.innerHTML = meta.map(item => `
      <div class="meta-item">
        <span>${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.value)}</strong>
      </div>
    `).join("");

    els.statContacts.textContent = numberBr(payload?.counts?.contacts);
    els.statTeam.textContent = numberBr(payload?.counts?.team_members);
    els.statDepartments.textContent = numberBr(payload?.counts?.departments);
    els.statInstances.textContent = numberBr(payload?.counts?.whatsapp_instances);
    els.statBroadcasts.textContent = numberBr(payload?.counts?.broadcasts_month);
    els.statCampaigns.textContent = numberBr(payload?.counts?.active_campaigns);
  }

  function renderFeatures(payload) {
    const plan = payload?.plan || {};
    const features = plan.features || {};

    const html = Object.keys(FEATURE_META).map((key) => {
      const meta = FEATURE_META[key];
      const on = !!features[key];

      return `
        <div class="feature-item ${on ? "feature-item--on" : "feature-item--off"}">
          <i class="fa-solid ${on ? "fa-check" : "fa-xmark"}"></i>
          <div>
            <strong>${escapeHtml(meta.label)}</strong>
            <p>${escapeHtml(on ? meta.desc : "Não incluído no plano atual.")}</p>
          </div>
        </div>
      `;
    }).join("");

    els.featuresList.innerHTML = html || `<div class="empty-state"><p>Nenhum recurso disponível.</p></div>`;
  }

  function renderUsage(payload) {
    const usage = payload?.plan?.usage || {};
    const limits = payload?.limits_effective || payload?.plan?.limits || {};

    const html = USAGE_ITEMS.map(item => {
      const current = intVal(usage[item.key], 0);
      const max = intVal(limits[item.limitKey], 0);

      let percent = 0;
      if (max > 0) percent = (current / max) * 100;
      else if (current > 0) percent = 100;

      const visual = Math.max(0, Math.min(percent, 100));
      const progressClass = percent >= 100 ? "danger" : (percent >= 80 ? "warning" : "");

      return `
        <div class="usage-item">
          <div class="usage-top">
            <span>${escapeHtml(item.label)}</span>
            <strong>${escapeHtml(numberBr(current))} / ${max > 0 ? escapeHtml(numberBr(max)) : "Ilimitado"}</strong>
          </div>

          <div class="progress ${progressClass}">
            <div style="width:${visual}%;"></div>
          </div>

          <div class="usage-foot">
            ${max > 0 ? `${visual.toFixed(0)}% do limite utilizado` : "Sem limite fixo configurado"}
          </div>
        </div>
      `;
    }).join("");

    els.usageList.innerHTML = html || `<div class="empty-state"><p>Nenhum dado de uso disponível.</p></div>`;
  }

  function renderInstances(payload) {
    const rows = payload?.instancias || [];

    if (!rows.length) {
      els.instancesList.innerHTML = `<div class="empty-state"><p>Nenhuma instância cadastrada.</p></div>`;
      return;
    }

    els.instancesList.innerHTML = rows.map(item => `
      <div class="data-item">
        <div class="data-item-main">
          <strong>${escapeHtml(item.apelido || item.instance_name || `Instância #${item.id}`)}</strong>
          <p>${escapeHtml(item.numero_instancia || "Sem número informado")}</p>
        </div>
        <div class="data-item-side">
          ${item.connected ? badge("Conectada", "success", "fa-link") : badge("Desconectada", "danger", "fa-link-slash")}
          <small>Sinal: ${escapeHtml(formatDate(item.last_seen))}</small>
        </div>
      </div>
    `).join("");
  }

  function renderBroadcasts(payload) {
    const rows = payload?.recent_disparos || [];

    if (!rows.length) {
      els.broadcastList.innerHTML = `<div class="empty-state"><p>Sem disparos recentes.</p></div>`;
      return;
    }

    els.broadcastList.innerHTML = rows.map(item => `
      <div class="data-item">
        <div class="data-item-main">
          <strong>${escapeHtml((item.mensagem || "Sem conteúdo").slice(0, 80))}</strong>
          <p>Data: ${escapeHtml(formatDate(item.criado_em))}</p>
        </div>
        <div class="data-item-side">
          ${badge(item.status || "—", item.status === "processando" ? "warning" : "default", "fa-paper-plane")}
          <small>${escapeHtml(numberBr(item.total_destinatarios || 0))} destinatários</small>
        </div>
      </div>
    `).join("");
  }

  function renderCompare(payload) {
    const plans = payload?.available_plans || [];
    const currentTier = payload?.effective_tier || "";

    if (!plans.length) {
      els.planCompare.innerHTML = `<div class="empty-state"><p>Nenhum plano para comparação.</p></div>`;
      return;
    }

    const cards = plans.map((plan) => {
      const limits = plan.limits || {};
      const features = plan.features || {};
      const isCurrent = String(plan.code || "").toUpperCase() === String(currentTier || "").toUpperCase();

      return `
        <article class="compare-card ${isCurrent ? "is-current" : ""}">
          <div class="compare-top">
            <div>
              <h4>${escapeHtml(plan.name || plan.code || "Plano")}</h4>
              ${isCurrent ? badge("Seu plano atual", "primary", "fa-star") : ""}
            </div>
            <div class="compare-price">${escapeHtml(money(plan.price_monthly || 0))}</div>
          </div>

          <div class="compare-section-title">Limites</div>
          <div class="compare-list">
            <div class="compare-list-item"><i class="fa-solid fa-hashtag"></i> ${escapeHtml(numberBr(limits.whatsapp_instances_max || 0))} número(s) WhatsApp</div>
            <div class="compare-list-item"><i class="fa-solid fa-users"></i> ${escapeHtml(numberBr(limits.users_max || 0))} membro(s)</div>
            <div class="compare-list-item"><i class="fa-solid fa-sitemap"></i> ${escapeHtml(numberBr(limits.departments_max || 0))} departamento(s)</div>
            <div class="compare-list-item"><i class="fa-solid fa-address-book"></i> ${escapeHtml(numberBr(limits.contacts_max || 0))} contato(s)</div>
            <div class="compare-list-item"><i class="fa-solid fa-bullhorn"></i> ${escapeHtml(numberBr(limits.broadcasts_per_month_max || 0))} disparos/mês</div>
            <div class="compare-list-item"><i class="fa-solid fa-rocket"></i> ${escapeHtml(numberBr(limits.active_campaigns_max || 0))} campanha(s) ativa(s)</div>
          </div>

          <div class="compare-section-title">Recursos</div>
          <div class="compare-list">
            ${Object.keys(FEATURE_META).map((key) => `
              <div class="compare-list-item ${features[key] ? "is-on" : "is-off"}">
                <i class="fa-solid ${features[key] ? "fa-check" : "fa-xmark"}"></i>
                <span>${escapeHtml(FEATURE_META[key].label)}</span>
              </div>
            `).join("")}
          </div>
        </article>
      `;
    }).join("");

    els.planCompare.innerHTML = cards;
  }

  function renderLoadingState() {
    if (els.planName) els.planName.textContent = "Carregando...";
    if (els.planPrice) els.planPrice.textContent = "—";
    if (els.alertArea) {
      els.alertArea.innerHTML = `
        <div class="alert alert--info">
          <i class="fa-solid fa-spinner fa-spin"></i>
          <div>
            <strong>Carregando seu plano</strong>
            <p>Aguarde um instante enquanto buscamos os dados da sua assinatura.</p>
          </div>
        </div>
      `;
    }
  }

  async function loadPage(showSuccessToast) {
    renderLoadingState();

    try {
      const data = await apiJson("/api/meu-plano");
      renderAlerts(data);
      renderHero(data);
      renderFeatures(data);
      renderUsage(data);
      renderInstances(data);
      renderBroadcasts(data);
      renderCompare(data);

      if (showSuccessToast) showToast("Dados do plano atualizados.");
    } catch (err) {
      if (els.alertArea) {
        els.alertArea.innerHTML = `
          <div class="alert alert--danger">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <div>
              <strong>Não foi possível carregar seu plano</strong>
              <p>${escapeHtml(err?.message || "Erro inesperado.")}</p>
            </div>
          </div>
        `;
      }
      showToast(err?.message || "Erro ao carregar plano.", true);
    }
  }

  if (els.btnReload) {
    els.btnReload.addEventListener("click", () => loadPage(true));
  }

  if (els.btnScrollCompare && els.compareSection) {
    els.btnScrollCompare.addEventListener("click", () => {
      els.compareSection.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    loadPage(false);
  });
})();