(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const byId = (id) => document.getElementById(id);

  const form = byId('form-register');
  if (!form) return;

  const steps = $$('.step', form);
  const dots = $$('.dot');
  const stepText = byId('stepText');

  const btnNext = byId('btn-next');
  const btnBack = byId('btn-back');
  const btnSubmit = byId('btn-submit');
  const toast = byId('toast');

  const docInput = byId('doc');
  const nomeEmp = byId('nome');
  const telefone = byId('telefone');

  const errDoc = byId('err-doc');
  const errNome = byId('err-nome');
  const errTel = byId('err-telefone');

  const wrapDoc = byId('wrap-doc') || docInput?.closest('.field');
  const wrapNome = byId('wrap-nomeemp') || nomeEmp?.closest('.field');
  const wrapTel = byId('wrap-telefone') || telefone?.closest('.field');

  const nomeAdm = byId('nome_adm');
  const emailAdm = byId('email_admin');
  const senhaAdm = byId('senha_admin');
  const senhaConf = byId('senha_confirm');

  const errNomeAdm = byId('err-nomeadm');
  const errEmail = byId('err-email');
  const errSenha = byId('err-senha');
  const errConf = byId('err-confirma');

  const wrapNomeAdm = byId('wrap-nomeadm') || nomeAdm?.closest('.field');
  const wrapEmail = byId('wrap-email') || emailAdm?.closest('.field');
  const wrapSenha = byId('wrap-senha') || senhaAdm?.closest('.field');
  const wrapConf = byId('wrap-confirma') || senhaConf?.closest('.field');

  const togglePass = byId('toggle-pass');

  const avatarTrigger = byId('avatar-trigger');
  const avatarFile = byId('avatar-file');
  const avatarPreview = byId('avatar-preview');
  const avatarPlaceholder = byId('avatar-placeholder');
  const avatarStatus = byId('avatar-status');
  const avatarUrl = byId('avatar_url');
  const avatarErro = byId('avatar-erro');

  const btnOpenAvatars = byId('btn-open-avatars');
  const avatarModal = byId('avatar-modal');
  const avatarBackdrop = byId('avatar-backdrop');
  const avatarClose = byId('avatar-close');
  const avatarCancel = byId('avatar-cancel');
  const avatarApply = byId('avatar-apply');
  const presetGrid = byId('preset-grid');

  const onlyDigits = (value) => String(value || '').replace(/\D+/g, '');
  const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());

  let stepIndex = Math.max(0, steps.findIndex(step => step.classList.contains('step--active')));
  if (stepIndex < 0) stepIndex = 0;

  let selectedAvatarDataUrl = '';

  const AVATAR_COLORS = [
    '#047857', '#0f766e', '#0369a1', '#1d4ed8', '#6d28d9',
    '#7c3aed', '#be185d', '#e11d48', '#ea580c', '#ca8a04'
  ];

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message || '';
    toast.classList.remove('hidden');
  }

  function hideToast() {
    if (!toast) return;
    toast.classList.add('hidden');
    toast.textContent = '';
  }

  function setErr(wrap, helpEl, message) {
    if (wrap) wrap.classList.toggle('field-err', !!message);
    if (helpEl) helpEl.textContent = message || '';
  }

  function clearAvatarError() {
    if (!avatarErro) return;
    avatarErro.textContent = '';
    avatarErro.classList.add('hidden');
  }

  function setAvatarError(message) {
    if (!avatarErro) return;
    avatarErro.textContent = message || '';
    avatarErro.classList.toggle('hidden', !message);
  }

  function focusFirst(root) {
    const el = root?.querySelector('input, button, select, textarea');
    if (el && typeof el.focus === 'function') {
      el.focus({ preventScroll: true });
    }
  }

  function updateStepperUI() {
    dots.forEach((dot, index) => {
      dot.classList.toggle('active', index === stepIndex);
      dot.classList.toggle('completed', index < stepIndex);
    });

    if (stepText) {
      stepText.textContent = `Etapa ${stepIndex + 1} de ${steps.length}`;
    }

    const isFirst = stepIndex === 0;
    const isLast = stepIndex === steps.length - 1;

    btnBack?.classList.toggle('hidden', isFirst);
    btnNext?.classList.toggle('hidden', isLast);
    btnSubmit?.classList.toggle('hidden', !isLast);
  }

  function showStep(index) {
    steps.forEach((step, i) => {
      step.classList.toggle('step--active', i === index);
    });
    stepIndex = index;
    updateStepperUI();
    focusFirst(steps[stepIndex]);
  }

  function gotoStep(nextIndex, options = {}) {
    const { validate = true } = options;
    const clamped = Math.max(0, Math.min(nextIndex, steps.length - 1));

    if (clamped === stepIndex) return;

    if (validate && clamped > stepIndex) {
      if (!validateStep(stepIndex)) return;
    }

    hideToast();
    showStep(clamped);
  }

  function initialsFromName() {
    const source =
      (nomeAdm?.value || '').trim() ||
      (nomeEmp?.value || '').trim() ||
      'ZA';

    const parts = source
      .split(/\s+/)
      .map(part => part.trim())
      .filter(Boolean);

    if (!parts.length) return 'ZA';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function buildAvatarDataUrl(bgColor, text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;

    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 96px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    return canvas.toDataURL('image/png');
  }

  function applyAvatar(dataUrl) {
    if (!dataUrl) return;

    if (avatarPreview) {
      avatarPreview.src = dataUrl;
      avatarPreview.classList.remove('hidden');
    }
    if (avatarPlaceholder) {
      avatarPlaceholder.classList.add('hidden');
    }
    if (avatarStatus) {
      avatarStatus.classList.remove('hidden');
    }
    if (avatarUrl) {
      avatarUrl.value = dataUrl;
    }

    clearAvatarError();
  }

  function resetAvatarSelectionUI() {
    $$('.preset-avatar', presetGrid).forEach(node => {
      node.classList.remove('selected');
    });
    if (avatarApply) avatarApply.disabled = true;
    selectedAvatarDataUrl = '';
  }

  function openAvatarModal() {
    if (!avatarModal) return;
    resetAvatarSelectionUI();
    avatarModal.classList.remove('hidden');
    avatarModal.setAttribute('aria-hidden', 'false');
  }

  function closeAvatarModal() {
    if (!avatarModal) return;
    avatarModal.classList.add('hidden');
    avatarModal.setAttribute('aria-hidden', 'true');
  }

  function buildPresetAvatars() {
    if (!presetGrid) return;

    presetGrid.innerHTML = '';

    const initials = initialsFromName();

    AVATAR_COLORS.forEach((color) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-avatar';
      btn.style.background = color;
      btn.textContent = initials;
      btn.setAttribute('aria-label', `Escolher avatar ${initials}`);

      btn.addEventListener('click', () => {
        $$('.preset-avatar', presetGrid).forEach(node => node.classList.remove('selected'));
        btn.classList.add('selected');
        selectedAvatarDataUrl = buildAvatarDataUrl(color, initials);
        if (avatarApply) avatarApply.disabled = !selectedAvatarDataUrl;
      });

      presetGrid.appendChild(btn);
    });
  }

  function validateStep(index) {
    let ok = true;
    let firstInvalid = null;

    const fail = (wrap, help, message, input) => {
      ok = false;
      setErr(wrap, help, message);
      if (!firstInvalid) firstInvalid = input;
    };

    if (index === 0) {
      const rawDoc = onlyDigits(docInput?.value);
      const rawTel = onlyDigits(telefone?.value);
      const nome = String(nomeEmp?.value || '').trim();

      if (!(rawDoc && (rawDoc.length === 11 || rawDoc.length === 14))) {
        fail(wrapDoc, errDoc, 'Informe um CPF (11) ou CNPJ (14) válido.', docInput);
      } else {
        setErr(wrapDoc, errDoc, '');
      }

      if (!nome || nome.length < 3) {
        fail(wrapNome, errNome, 'Informe o nome da empresa com no mínimo 3 caracteres.', nomeEmp);
      } else {
        setErr(wrapNome, errNome, '');
      }

      if (!(rawTel && (rawTel.length === 10 || rawTel.length === 11))) {
        fail(wrapTel, errTel, 'Informe um telefone válido com DDD.', telefone);
      } else {
        setErr(wrapTel, errTel, '');
      }
    }

    if (index === 1) {
      const nome = String(nomeAdm?.value || '').trim();
      const email = String(emailAdm?.value || '').trim();
      const senha = String(senhaAdm?.value || '');
      const confirmacao = String(senhaConf?.value || '');

      if (!nome || nome.length < 3) {
        fail(wrapNomeAdm, errNomeAdm, 'Informe o nome do administrador.', nomeAdm);
      } else {
        setErr(wrapNomeAdm, errNomeAdm, '');
      }

      if (!isEmail(email)) {
        fail(wrapEmail, errEmail, 'Digite um e-mail válido.', emailAdm);
      } else {
        setErr(wrapEmail, errEmail, '');
      }

      if (!senha || senha.length < 6) {
        fail(wrapSenha, errSenha, 'A senha deve ter no mínimo 6 caracteres.', senhaAdm);
      } else {
        setErr(wrapSenha, errSenha, '');
      }

      if (confirmacao !== senha) {
        fail(wrapConf, errConf, 'As senhas não conferem.', senhaConf);
      } else {
        setErr(wrapConf, errConf, '');
      }
    }

    if (!ok) {
      showToast('Por favor, corrija os campos destacados antes de continuar.');
      firstInvalid?.focus();
    } else {
      hideToast();
    }

    return ok;
  }

  async function cacheFromMe() {
    try {
      const res = await fetch('/api/auth/me', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });

      if (!res.ok) return;

      const data = await res.json().catch(() => null);
      if (!data) return;

      if (data.nome) localStorage.setItem('usuario_nome', String(data.nome));
      if (data.email) localStorage.setItem('usuario_email', String(data.email));
      if (data.empresa_id != null) localStorage.setItem('empresa_id', String(data.empresa_id));
      if (data.role || data.cargo) {
        const role = String(data.role || data.cargo);
        localStorage.setItem('usuario_role', role);
        localStorage.setItem('role', role);
      }
      if (data.avatar_url) localStorage.setItem('usuario_avatar', String(data.avatar_url));
    } catch (_) {
      // não quebra fluxo
    }
  }

  function bindMasks() {
    docInput?.addEventListener('input', () => {
      const digits = onlyDigits(docInput.value).slice(0, 14);
      setErr(wrapDoc, errDoc, '');

      if (digits.length <= 11) {
        docInput.value = digits
          .replace(/^(\d{3})(\d)/, '$1.$2')
          .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
          .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
      } else {
        docInput.value = digits
          .replace(/^(\d{2})(\d)/, '$1.$2')
          .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
          .replace(/\.(\d{3})(\d)/, '.$1/$2')
          .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
      }
    });

    telefone?.addEventListener('input', () => {
      const digits = onlyDigits(telefone.value).slice(0, 11);
      setErr(wrapTel, errTel, '');

      if (digits.length <= 10) {
        telefone.value = digits
          .replace(/^(\d{2})(\d)/, '($1) $2')
          .replace(/(\d{4})(\d{1,4})$/, '$1-$2');
      } else {
        telefone.value = digits
          .replace(/^(\d{2})(\d)/, '($1) $2')
          .replace(/(\d{5})(\d{1,4})$/, '$1-$2');
      }
    });

    nomeEmp?.addEventListener('input', () => setErr(wrapNome, errNome, ''));
    nomeAdm?.addEventListener('input', () => setErr(wrapNomeAdm, errNomeAdm, ''));
    emailAdm?.addEventListener('input', () => setErr(wrapEmail, errEmail, ''));
    senhaAdm?.addEventListener('input', () => setErr(wrapSenha, errSenha, ''));
    senhaConf?.addEventListener('input', () => setErr(wrapConf, errConf, ''));
  }

  function bindPasswordToggle() {
    togglePass?.addEventListener('click', () => {
      const isPassword = senhaAdm?.getAttribute('type') === 'password';
      if (!senhaAdm) return;

      senhaAdm.setAttribute('type', isPassword ? 'text' : 'password');
      togglePass.textContent = isPassword ? 'Ocultar' : 'Mostrar';
    });
  }

  function bindAvatarUpload() {
    avatarTrigger?.addEventListener('click', () => {
      avatarFile?.click();
    });

    avatarFile?.addEventListener('change', () => {
      const file = avatarFile.files?.[0];
      if (!file) return;

      clearAvatarError();

      if (!file.type.startsWith('image/')) {
        setAvatarError('Selecione um arquivo de imagem válido.');
        avatarFile.value = '';
        return;
      }

      if (file.size > 4 * 1024 * 1024) {
        setAvatarError('A imagem deve ter no máximo 4 MB.');
        avatarFile.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        if (!result) {
          setAvatarError('Não foi possível ler a imagem selecionada.');
          return;
        }
        applyAvatar(result);
      };
      reader.onerror = () => {
        setAvatarError('Erro ao ler a imagem selecionada.');
      };
      reader.readAsDataURL(file);
    });

    btnOpenAvatars?.addEventListener('click', () => {
      buildPresetAvatars();
      openAvatarModal();
    });

    avatarBackdrop?.addEventListener('click', closeAvatarModal);
    avatarClose?.addEventListener('click', closeAvatarModal);
    avatarCancel?.addEventListener('click', closeAvatarModal);

    avatarApply?.addEventListener('click', () => {
      if (!selectedAvatarDataUrl) return;
      applyAvatar(selectedAvatarDataUrl);
      closeAvatarModal();
    });
  }

  btnNext?.addEventListener('click', () => gotoStep(stepIndex + 1, { validate: true }));
  btnBack?.addEventListener('click', () => gotoStep(stepIndex - 1, { validate: false }));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const step0Ok = validateStep(0);
    if (!step0Ok) {
      showStep(0);
      return;
    }

    const step1Ok = validateStep(1);
    if (!step1Ok) {
      showStep(1);
      return;
    }

    hideToast();

    const payload = {
      doc: onlyDigits(docInput?.value),
      nome: String(nomeEmp?.value || '').trim(),
      telefone: onlyDigits(telefone?.value),
      nome_adm: String(nomeAdm?.value || '').trim(),
      email_admin: String(emailAdm?.value || '').trim(),
      senha_admin: String(senhaAdm?.value || ''),
      avatar_url: String(avatarUrl?.value || '')
    };

    try {
      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.textContent = 'Concluindo...';
      }

      const res = await fetch('/api/auth/criar-empresa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        let message = 'Não foi possível concluir o cadastro.';
        try {
          const data = await res.json();
          if (data?.detail) message = String(data.detail);
        } catch (_) {}
        showToast(message);
        return;
      }

      await cacheFromMe();
      if (avatarUrl?.value) {
        localStorage.setItem('usuario_avatar', avatarUrl.value);
      }

      window.location.replace('/dashboard');
    } catch (error) {
      console.error(error);
      showToast('Erro de conexão. Tente novamente.');
    } finally {
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.textContent = 'Concluir Cadastro';
      }
    }
  });

  bindMasks();
  bindPasswordToggle();
  bindAvatarUpload();
  showStep(stepIndex);
})();