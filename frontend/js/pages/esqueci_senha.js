// /frontend/js/pages/esqueci_senha.js
(function () {
  const $ = (id) => document.getElementById(id);

  const toast = $("toast");

  function hideToast() {
    if (!toast) return;
    toast.classList.add("hidden");
    toast.textContent = "";
  }

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  async function extractApiError(res, fallback = "Não foi possível completar a operação.") {
    try {
      const data = await res.json();
      const detail = data?.detail;

      if (!detail) return fallback;
      if (typeof detail === "string") return detail;

      if (Array.isArray(detail)) {
        return detail
          .map((item) => {
            const message = item?.msg || item?.message || item?.detail;
            if (!message) return JSON.stringify(item);
            return String(message).replace(
              "value is not a valid email address",
              "E-mail inválido"
            );
          })
          .join("<br>");
      }

      if (typeof detail === "object") {
        return detail.message || detail.msg || detail.detail || JSON.stringify(detail);
      }
    } catch {}

    return fallback;
  }

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
      return Boolean(overlay && titleEl && bodyEl && okBtn);
    }

    function close() {
      if (!isReady()) return;
      overlay.classList.add("hidden");
      overlay.style.display = "none";
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

    return { open, close };
  })();

  const formForgot = $("form-forgot");
  const btnForgot = $("btn-forgot");
  const emailInput = $("email");
  const resetSection = $("reset-section");
  const formReset = $("form-reset");
  const btnReset = $("btn-reset");
  const inputTok = $("token");
  const inputPass = $("nova_senha");

  const params = new URLSearchParams(window.location.search || "");
  const isInviteFlow = params.get("convite") === "1";
  const inviteEmail = (params.get("email") || "").trim().toLowerCase();
  const inviteToken = (params.get("token") || "").trim();

  function normalizeToken(value) {
    return String(value || "").replace(/\D/g, "").slice(0, 5);
  }

  function bindTokenInput() {
    if (!inputTok || inputTok.dataset.bound === "1") return;
    inputTok.dataset.bound = "1";

    const apply = () => {
      const normalized = normalizeToken(inputTok.value);
      if (inputTok.value !== normalized) inputTok.value = normalized;
    };

    inputTok.addEventListener("input", apply);
    inputTok.addEventListener("paste", () => setTimeout(apply, 0));
  }

  bindTokenInput();

  function configureInviteScreen() {
    if (!isInviteFlow) return;

    if (inviteEmail && emailInput) {
      emailInput.value = inviteEmail;
    }

    formForgot?.classList.add("hidden");
    resetSection?.classList.remove("hidden");

    if (resetSection) {
      resetSection.style.marginTop = "0";
      resetSection.style.borderTop = "0";
      resetSection.style.paddingTop = "0";
    }

    const tokenField = inputTok?.closest(".field");
    if (tokenField) tokenField.style.display = "none";
    if (inputTok) inputTok.required = false;

    const heroTitle = document.querySelector(".logo-header .title");
    const heroSubtitle = document.querySelector(".logo-header .subtitle");
    const resetTitle = resetSection?.querySelector("h3");
    const resetDescription = resetSection?.querySelector("p");

    if (heroTitle) heroTitle.textContent = "Crie sua senha";
    if (heroSubtitle) {
      heroSubtitle.textContent = "Digite uma senha para concluir seu acesso ao ZapsChat.";
    }
    if (resetTitle) resetTitle.textContent = "Defina sua senha";
    if (resetDescription) {
      resetDescription.textContent = "O e-mail e o token do convite já foram preenchidos pelo link.";
    }
    if (btnReset) btnReset.textContent = "Criar senha";

    if (!inviteEmail || !inviteToken) {
      formReset?.classList.add("hidden");
      if (heroTitle) heroTitle.textContent = "Convite inválido";
      if (heroSubtitle) {
        heroSubtitle.textContent = "Este link está incompleto. Solicite um novo convite ao administrador.";
      }
      return;
    }

    setTimeout(() => inputPass?.focus(), 120);
  }

  configureInviteScreen();

  if (formForgot) {
    formForgot.addEventListener("submit", async (event) => {
      event.preventDefault();
      hideToast();

      const email = (emailInput?.value || "").trim().toLowerCase();

      if (!email || !isValidEmail(email)) {
        modal.open({ title: "Atenção", message: "Informe um <b>e-mail válido</b>." });
        return;
      }

      if (btnForgot) btnForgot.disabled = true;
      const oldText = btnForgot?.textContent || "";
      if (btnForgot) btnForgot.textContent = "Enviando…";

      try {
        const response = await fetch("/api/auth/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });

        if (!response.ok) {
          const message = await extractApiError(response, "Não foi possível enviar agora.");
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

  if (formReset) {
    formReset.addEventListener("submit", async (event) => {
      event.preventDefault();
      hideToast();

      const token = isInviteFlow ? inviteToken : normalizeToken(inputTok?.value || "");
      const email = isInviteFlow
        ? inviteEmail
        : (emailInput?.value || "").trim().toLowerCase();
      const nova_senha = inputPass?.value || "";

      if (isInviteFlow) {
        if (!token || !email) {
          modal.open({
            title: "Convite inválido",
            message: "Solicite um <b>novo convite</b> ao administrador.",
          });
          return;
        }
      } else if (!token || token.length !== 5) {
        modal.open({
          title: "Token inválido",
          message: "Digite o <b>código de 5 dígitos</b>.",
        });
        inputTok?.focus();
        return;
      }

      if (!nova_senha || nova_senha.length < 8) {
        modal.open({
          title: "Senha fraca",
          message: "A senha precisa ter <b>mínimo de 8 caracteres</b>.",
        });
        inputPass?.focus();
        return;
      }

      if (btnReset) btnReset.disabled = true;
      const oldText = btnReset?.textContent || "";
      if (btnReset) {
        btnReset.textContent = isInviteFlow ? "Criando senha…" : "Redefinindo…";
      }

      try {
        const response = await fetch("/api/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, nova_senha, email: isInviteFlow ? email : null }),
        });

        if (!response.ok) {
          const message = await extractApiError(
            response,
            isInviteFlow
              ? "Não foi possível criar a senha."
              : "Não foi possível redefinir a senha."
          );
          modal.open({ title: "Erro", message });
          return;
        }

        modal.open({
          title: "Tudo certo!",
          message: isInviteFlow
            ? "Sua senha foi criada. Agora você já pode entrar no ZapsChat."
            : "Senha redefinida com sucesso. Você já pode entrar.",
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

  // Compatibilidade com links antigos de recuperação: ?token=12345
  if (!isInviteFlow) {
    try {
      const tokenFromUrl = params.get("token");
      if (tokenFromUrl) {
        resetSection?.classList.remove("hidden");
        formForgot?.classList.add("hidden");
        if (inputTok) inputTok.value = normalizeToken(tokenFromUrl);
        inputPass?.focus();

        const heroTitle = document.querySelector(".logo-header .title");
        const heroSubtitle = document.querySelector(".logo-header .subtitle");
        if (heroTitle) heroTitle.textContent = "Defina uma nova senha";
        if (heroSubtitle) heroSubtitle.textContent = "Informe o token e crie sua nova senha.";
      }
    } catch {}
  }
})();
