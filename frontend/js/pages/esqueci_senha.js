// /frontend/js/pages/esqueci_senha.js
(function () {
  const $ = (id) => document.getElementById(id);

  // =========================
  // Toast (mantido)
  // =========================
  const toast = $("toast");

  function showToast(msg) {
    if (!toast) return;
    toast.classList.remove("hidden");
    toast.innerHTML = msg;
  }

  function hideToast() {
    if (!toast) return;
    toast.classList.add("hidden");
    toast.textContent = "";
  }

  // =========================
  // Helpers
  // =========================
  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  async function extractApiError(res, fallback = "Não foi possível completar a operação.") {
    try {
      const data = await res.json();
      const d = data?.detail;

      if (!d) return fallback;
      if (typeof d === "string") return d;

      if (Array.isArray(d)) {
        return d
          .map((it) => {
            const m = it?.msg || it?.message || it?.detail;
            if (!m) return JSON.stringify(it);
            return String(m).replace("value is not a valid email address", "E-mail inválido");
          })
          .join("<br>");
      }

      if (typeof d === "object") {
        return (d.message || d.msg || d.detail) ?? JSON.stringify(d);
      }
    } catch {}
    return fallback;
  }

  // =========================
  // Modal (usa seu HTML)
  // =========================
  const modal = (function () {
    const overlay = $("notifyModal");
    const titleEl = $("notify-title");
    const bodyEl = $("notify-body");
    const okBtn = $("notify-ok");

    function fallbackAlert(title, message) {
      const plain = String(message || "").replace(/<[^>]*>/g, "");
      alert((title ? title + "\n\n" : "") + plain);
    }

    function isReady() {
      return !!(overlay && titleEl && bodyEl && okBtn);
    }

    function open({ title = "Aviso", message = "", okText = "Ok", onOk = null } = {}) {
      if (!isReady()) {
        fallbackAlert(title, message);
        if (typeof onOk === "function") onOk();
        return;
      }

      titleEl.textContent = title;
      bodyEl.innerHTML = message;
      okBtn.textContent = okText;

      overlay.classList.remove("hidden");
      overlay.style.display = "flex";

      const handler = () => {
        okBtn.removeEventListener("click", handler);
        close();
        if (typeof onOk === "function") onOk();
      };
      okBtn.addEventListener("click", handler);

      setTimeout(() => okBtn.focus(), 0);
    }

    function close() {
      if (!isReady()) return;
      overlay.classList.add("hidden");
      overlay.style.display = "none";
    }

    return { open, close };
  })();

  // =========================
  // DOM refs
  // =========================
  const formForgot = $("form-forgot");
  const btnForgot = $("btn-forgot");
  const emailInput = $("email");

  const resetSection = $("reset-section");
  const formReset = $("form-reset");
  const btnReset = $("btn-reset");
  const inputTok = $("token");
  const inputPass = $("nova_senha");

  // =========================
  // Token: só números e 5 dígitos (sem mudar layout)
  // =========================
  function normalizeToken(v) {
    return String(v || "").replace(/\D/g, "").slice(0, 5);
  }

  function bindTokenInput() {
    if (!inputTok) return;

    // evita bind duplicado
    if (inputTok.dataset.bound === "1") return;
    inputTok.dataset.bound = "1";

    const apply = () => {
      const newV = normalizeToken(inputTok.value);
      if (inputTok.value !== newV) inputTok.value = newV;
    };

    inputTok.addEventListener("input", apply);
    inputTok.addEventListener("paste", () => setTimeout(apply, 0));
  }
  bindTokenInput();

  // =========================
  // Passo 1: solicitar token
  // =========================
  if (formForgot) {
    formForgot.addEventListener("submit", async (e) => {
      e.preventDefault();
      hideToast();

      const email = (emailInput?.value || "").trim().toLowerCase();

      if (!email || !isValidEmail(email)) {
        modal.open({ title: "Atenção", message: "Informe um <b>e-mail válido</b>." });
        return;
      }

      if (btnForgot) btnForgot.disabled = true;
      const oldText = btnForgot ? btnForgot.textContent : "";
      if (btnForgot) btnForgot.textContent = "Enviando…";

      try {
        const res = await fetch("/api/auth/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });

        if (!res.ok) {
          const message = await extractApiError(res, "Não foi possível enviar agora.");
          modal.open({ title: "Erro", message });
          return;
        }

        modal.open({
          title: "Verifique seu e-mail",
          message: "Enviamos um <b>código de 5 dígitos</b>. Confira Caixa de Entrada, Spam e Promoções.",
          okText: "Continuar",
          onOk: () => {
            resetSection?.classList.remove("hidden");
            inputTok?.focus();
          },
        });
      } catch {
        modal.open({ title: "Conexão falhou", message: "Tente novamente em instantes." });
      } finally {
        if (btnForgot) btnForgot.disabled = false;
        if (btnForgot) btnForgot.textContent = oldText;
      }
    });
  }

  // =========================
  // Passo 2: redefinir senha
  // =========================
  if (formReset) {
    formReset.addEventListener("submit", async (e) => {
      e.preventDefault();
      hideToast();

      const token = normalizeToken(inputTok?.value || "");
      const nova_senha = (inputPass?.value || "").trim();

      if (!token || token.length !== 5) {
        modal.open({ title: "Token inválido", message: "Digite o <b>código de 5 dígitos</b>." });
        inputTok?.focus();
        return;
      }

      if (!nova_senha || nova_senha.length < 8) {
        modal.open({ title: "Senha fraca", message: "A senha precisa ter <b>mínimo de 8 caracteres</b>." });
        inputPass?.focus();
        return;
      }

      if (btnReset) btnReset.disabled = true;
      const oldText = btnReset ? btnReset.textContent : "";
      if (btnReset) btnReset.textContent = "Redefinindo…";

      try {
        const res = await fetch("/api/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, nova_senha }),
        });

        if (!res.ok) {
          const msg = await extractApiError(res, "Não foi possível redefinir a senha.");
          modal.open({ title: "Erro", message: msg });
          return;
        }

        modal.open({
          title: "Tudo certo!",
          message: "Senha redefinida com sucesso. Você já pode entrar.",
          okText: "Ir para login",
          onOk: () => (window.location.href = "/login.html"),
        });
      } catch {
        modal.open({ title: "Conexão falhou", message: "Tente novamente." });
      } finally {
        if (btnReset) btnReset.disabled = false;
        if (btnReset) btnReset.textContent = oldText;
      }
    });
  }

  // =========================
  // Pré-preenche token via ?token=12345 (opcional)
  // =========================
  (function () {
    try {
      const u = new URL(location.href);
      const t = u.searchParams.get("token");
      if (!t) return;

      resetSection?.classList.remove("hidden");
      formForgot?.classList.add("hidden");

      if (inputTok) inputTok.value = normalizeToken(t);
      inputPass?.focus();

      const heroTitle = document.querySelector(".logo-header .title");
      const heroSubtitle = document.querySelector(".logo-header .subtitle");
      if (heroTitle) heroTitle.textContent = "Defina uma nova senha";
      if (heroSubtitle) heroSubtitle.textContent = "Informe o token e crie sua nova senha.";
    } catch {}
  })();
})();
