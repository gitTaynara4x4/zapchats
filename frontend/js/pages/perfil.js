(function PerfilPage() {
  "use strict";

  const LOGIN_URL = "/frontend/login.html";

  function $(id) {
    return document.getElementById(id);
  }

  function getInitials(nome) {
    if (!nome || typeof nome !== "string") return "Z";
    const partes = nome.trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return "Z";
    if (partes.length === 1) return partes[0].charAt(0).toUpperCase();
    return (partes[0].charAt(0) + partes[partes.length - 1].charAt(0)).toUpperCase();
  }

  function normalizarAvatarUrl(valor) {
    if (!valor || typeof valor !== "string") return "";

    const v = valor.trim();
    if (!v) return "";

    const dataImageRegex =
      /^data:image\/(?:png|jpeg|jpg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=\r\n]+$/i;

    if (dataImageRegex.test(v)) {
      return v.replace(/\s+/g, "");
    }

    if (/^https?:\/\//i.test(v)) return v;
    if (v.startsWith("/")) return v;

    return "";
  }

  function renderAvatar(nome, avatarUrl) {
    const box = $("avatarPreviewBox");
    if (!box) return;

    const url = normalizarAvatarUrl(avatarUrl);
    
    // Salva o overlay para recolocá-mo depois da imagem
    const overlayHtml = `<div class="avatar-overlay"><i class="fa-solid fa-camera"></i></div>`;
    
    box.innerHTML = "";

    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "Avatar do usuário";
      img.onerror = function () {
        box.innerHTML = `<span id="avatarInitials">${getInitials(nome)}</span>` + overlayHtml;
      };
      box.appendChild(img);
      box.insertAdjacentHTML("beforeend", overlayHtml);
      return;
    }

    box.innerHTML = `<span id="avatarInitials">${getInitials(nome)}</span>` + overlayHtml;
  }

  function showToast(message, type) {
    if (typeof window.showToast === "function") {
      window.showToast(message, type);
      return;
    }

    const box = $("global-msg");
    if (!box) {
      alert(message);
      return;
    }

    box.textContent = message;
    box.style.display = "block";
    box.classList.remove("is-success", "is-error");
    box.classList.add(type === "error" ? "is-error" : "is-success");

    clearTimeout(window.__perfilToastTimer);
    window.__perfilToastTimer = setTimeout(function () {
      box.style.display = "none";
    }, 3200);
  }

  async function apiJson(url, options) {
    const res = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      ...options
    });

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }

    return { res, data };
  }

  function tratar401(res, data) {
    if (res.status === 401) {
      showToast((data && data.detail) || "Sua sessão expirou. Faça login novamente.", "error");
      setTimeout(function () {
        window.location.href = LOGIN_URL;
      }, 900);
      return true;
    }
    return false;
  }

  function atualizarNomeSidebar(nome) {
    try {
      document.cookie =
        "user_nome=" + encodeURIComponent(nome || "") + "; path=/; samesite=lax";
    } catch (_) {}
  }

  function atualizarAvatarSidebar(nome, avatarUrl) {
    try {
      const avatarEl =
        document.querySelector(".ZapChats-user-avatar") ||
        document.querySelector(".z-user-avatar") ||
        document.querySelector(".Valora-user-avatar") ||
        document.querySelector(".user-avatar");

      if (!avatarEl) return;

      const url = normalizarAvatarUrl(avatarUrl);
      avatarEl.innerHTML = "";

      if (url) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "Avatar";
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.borderRadius = "50%";
        img.style.objectFit = "cover";
        img.style.display = "block";
        img.onerror = function () {
          avatarEl.textContent = getInitials(nome);
        };
        avatarEl.appendChild(img);
      } else {
        avatarEl.textContent = getInitials(nome);
      }
    } catch (_) {}
  }

  function init() {
    const formPerfil = $("formPerfil");
    const formSenha = $("formSenha");

    const nome = $("nome");
    const email = $("email");
    const telefone = $("telefone");
    const cargo = $("cargo");

    const senhaAtual = $("senha_atual");
    const novaSenha = $("nova_senha");
    const confirmaSenha = $("confirma_senha");

    const avatarInput = $("avatarInput");
    const btnUploadAvatar = $("btnUploadAvatar");
    const btnRemoveAvatar = $("btnRemoveAvatar");
    const btnSalvarPerfil = $("btnSalvarPerfil");
    const btnSalvarSenha = $("btnSalvarSenha");
    const avatarPreviewBox = $("avatarPreviewBox"); // Adicionado para clique na foto

    let currentUser = {
      nome: "",
      email: "",
      telefone: "",
      cargo: "",
      avatar_url: ""
    };

    async function carregarPerfil() {
      try {
        const { res, data } = await apiJson("/api/perfil", {
          method: "GET"
        });

        if (tratar401(res, data)) return;

        if (!res.ok || !data) {
          throw new Error((data && data.detail) || "Não foi possível carregar o perfil.");
        }

        currentUser = {
          nome: data.nome || "",
          email: data.email || "",
          telefone: data.telefone || "",
          cargo: data.cargo || "",
          avatar_url: normalizarAvatarUrl(data.avatar_url || "")
        };

        if (nome) nome.value = currentUser.nome;
        if (email) email.value = currentUser.email;
        if (telefone) telefone.value = currentUser.telefone;
        if (cargo) cargo.value = currentUser.cargo;

        renderAvatar(currentUser.nome || "ZapChats", currentUser.avatar_url);
        atualizarNomeSidebar(currentUser.nome);
        atualizarAvatarSidebar(currentUser.nome, currentUser.avatar_url);
      } catch (err) {
        console.error("Erro ao carregar perfil:", err);
        renderAvatar("ZapChats", "");
        showToast(err.message || "Erro ao carregar perfil.", "error");
      }
    }

    if (avatarInput) {
      // Permite clicar tanto no botão quanto na própria imagem para fazer o upload
      const triggerUpload = function () { avatarInput.click(); };
      
      if (btnUploadAvatar) btnUploadAvatar.addEventListener("click", triggerUpload);
      if (avatarPreviewBox) avatarPreviewBox.addEventListener("click", triggerUpload);

      avatarInput.addEventListener("change", async function (e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
          showToast("Formato inválido. Use PNG, JPG, WEBP ou GIF.", "error");
          avatarInput.value = "";
          return;
        }

        if (file.size > 4 * 1024 * 1024) {
          showToast("A imagem deve ter no máximo 4 MB.", "error");
          avatarInput.value = "";
          return;
        }

        const reader = new FileReader();
        reader.onload = function (ev) {
          renderAvatar(nome && nome.value ? nome.value : currentUser.nome, ev.target.result);
        };
        reader.readAsDataURL(file);

        const formData = new FormData();
        formData.append("file", file);

        let originalText = "";
        if (btnUploadAvatar) {
          originalText = btnUploadAvatar.innerHTML;
          btnUploadAvatar.innerHTML = "Salvando...";
          btnUploadAvatar.disabled = true;
        }

        try {
          const res = await fetch("/api/perfil/avatar", {
            method: "POST",
            body: formData,
            credentials: "include"
          });

          const data = await res.json().catch(function () {
            return {};
          });

          if (tratar401(res, data)) return;

          if (!res.ok) {
            throw new Error(data.detail || "Erro ao salvar foto.");
          }

          currentUser.avatar_url = normalizarAvatarUrl(data.avatar_url || "");
          renderAvatar(nome && nome.value ? nome.value : currentUser.nome, currentUser.avatar_url);
          atualizarAvatarSidebar(nome && nome.value ? nome.value : currentUser.nome, currentUser.avatar_url);
          showToast("Foto de perfil atualizada com sucesso!", "success");
        } catch (err) {
          console.error("Erro ao enviar avatar:", err);
          renderAvatar(nome && nome.value ? nome.value : currentUser.nome, currentUser.avatar_url);
          showToast(err.message || "Erro ao atualizar foto de perfil.", "error");
        } finally {
          if (btnUploadAvatar) {
            btnUploadAvatar.innerHTML = originalText;
            btnUploadAvatar.disabled = false;
          }
          avatarInput.value = "";
        }
      });
    }

    if (btnRemoveAvatar) {
      btnRemoveAvatar.addEventListener("click", async function () {
        const originalText = btnRemoveAvatar.textContent;
        btnRemoveAvatar.textContent = "Removendo...";
        btnRemoveAvatar.disabled = true;

        try {
          const { res, data } = await apiJson("/api/perfil/avatar", {
            method: "DELETE"
          });

          if (tratar401(res, data)) return;

          if (!res.ok) {
            throw new Error((data && data.detail) || "Erro ao remover foto.");
          }

          currentUser.avatar_url = "";
          renderAvatar(nome && nome.value ? nome.value : currentUser.nome, "");
          atualizarAvatarSidebar(nome && nome.value ? nome.value : currentUser.nome, "");
          showToast("Foto removida com sucesso!", "success");
        } catch (err) {
          console.error("Erro ao remover avatar:", err);
          showToast(err.message || "Erro ao remover foto de perfil.", "error");
        } finally {
          btnRemoveAvatar.textContent = originalText;
          btnRemoveAvatar.disabled = false;
        }
      });
    }

    if (formPerfil) {
      formPerfil.addEventListener("submit", async function (e) {
        e.preventDefault();

        const payload = {
          nome: nome ? nome.value.trim() : "",
          email: email ? email.value.trim() : "",
          telefone: telefone && telefone.value ? telefone.value.trim() : "",
          cargo: cargo && cargo.value ? cargo.value.trim() : ""
        };

        const originalText = btnSalvarPerfil ? btnSalvarPerfil.textContent : "Salvar alterações";
        if (btnSalvarPerfil) {
          btnSalvarPerfil.textContent = "Salvando...";
          btnSalvarPerfil.disabled = true;
        }

        try {
          const { res, data } = await apiJson("/api/perfil", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          });

          if (tratar401(res, data)) return;

          if (!res.ok) {
            throw new Error((data && data.detail) || "Erro ao atualizar perfil.");
          }

          currentUser = {
            ...currentUser,
            nome: data.nome || payload.nome,
            email: data.email || payload.email,
            telefone: data.telefone || payload.telefone,
            cargo: data.cargo || payload.cargo,
            avatar_url: normalizarAvatarUrl((data && data.avatar_url) || currentUser.avatar_url || "")
          };

          atualizarNomeSidebar(currentUser.nome);
          atualizarAvatarSidebar(currentUser.nome, currentUser.avatar_url);
          renderAvatar(currentUser.nome, currentUser.avatar_url);

          showToast("Perfil atualizado com sucesso!", "success");
        } catch (err) {
          console.error("Erro ao salvar perfil:", err);
          showToast(err.message || "Erro ao atualizar perfil.", "error");
        } finally {
          if (btnSalvarPerfil) {
            btnSalvarPerfil.textContent = originalText;
            btnSalvarPerfil.disabled = false;
          }
        }
      });
    }

    if (formSenha) {
      formSenha.addEventListener("submit", async function (e) {
        e.preventDefault();

        const payload = {
          senha_atual: senhaAtual ? senhaAtual.value : "",
          nova_senha: novaSenha ? novaSenha.value : "",
          confirma_senha: confirmaSenha ? confirmaSenha.value : ""
        };

        if (payload.nova_senha !== payload.confirma_senha) {
          showToast("A confirmação da nova senha não confere.", "error");
          return;
        }

        const originalText = btnSalvarSenha ? btnSalvarSenha.textContent : "Atualizar senha";
        if (btnSalvarSenha) {
          btnSalvarSenha.textContent = "Atualizando...";
          btnSalvarSenha.disabled = true;
        }

        try {
          const { res, data } = await apiJson("/api/perfil/senha", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          });

          if (tratar401(res, data)) return;

          if (!res.ok) {
            throw new Error((data && data.detail) || "Erro ao atualizar senha.");
          }

          formSenha.reset();
          showToast((data && data.mensagem) || "Senha atualizada com sucesso!", "success");
        } catch (err) {
          console.error("Erro ao atualizar senha:", err);
          showToast(err.message || "Erro ao atualizar senha.", "error");
        } finally {
          if (btnSalvarSenha) {
            btnSalvarSenha.textContent = originalText;
            btnSalvarSenha.disabled = false;
          }
        }
      });
    }

    carregarPerfil();
  }

  const run = () => init();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();