(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const state = {
    profile: null,
    initialForm: '',
    avatarObjectUrl: '',
    loading: false,
  };

  const els = {};

  function cacheElements() {
    [
      'profileMain', 'profileLoading', 'profileContent', 'btnAtualizarPagina',
      'avatarPreviewBox', 'avatarImage', 'avatarInitials', 'avatarInput',
      'btnUploadAvatar', 'btnEscolherFoto', 'btnRemoveAvatar',
      'profileDisplayName', 'profileDisplayEmail', 'accountBadge',
      'presenceBadge', 'presenceDot', 'presenceText', 'lastAccessText',
      'infoEmpresa', 'infoTipoConta', 'infoDepartamento', 'infoHorario',
      'infoPermissoes', 'infoIdentificacao', 'sessionBrowser', 'sessionSystem',
      'btnLogoutCurrent', 'formPerfil', 'nome', 'email', 'telefone', 'cargo',
      'btnSalvarPerfil', 'btnCancelarPerfil', 'profileSaveState',
      'companyDocumentCard', 'formCompanyDocument', 'companyDocument',
      'companyDocumentError', 'btnSaveCompanyDocument',
      'formSenha', 'senha_atual', 'nova_senha', 'confirma_senha',
      'btnSalvarSenha', 'passwordStrengthBar', 'passwordStrengthText',
      'passwordRules', 'profileToastHost',
    ].forEach((id) => { els[id] = document.getElementById(id); });
  }

  function clean(value) {
    return String(value ?? '').trim();
  }

  function initials(name) {
    const parts = clean(name).replace(/[@._-]+/g, ' ').split(/\s+/).filter(Boolean);
    if (!parts.length) return 'US';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'include',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {}),
      },
    });

    let data = null;
    const contentType = response.headers.get('content-type') || '';
    try {
      data = contentType.includes('application/json') ? await response.json() : await response.text();
    } catch {
      data = null;
    }

    if (!response.ok) {
      if (response.status === 401) {
        setTimeout(() => { window.location.href = '/login.html?next=/perfil.html'; }, 700);
      }
      const detail = typeof data === 'object' && data ? data.detail : null;
      const message = typeof detail === 'object' && detail
        ? (detail.message || detail.erro || detail.code)
        : (typeof data === 'object' && data ? (detail || data.message || data.erro) : data);
      const error = new Error(clean(message) || `Erro ${response.status} ao processar a solicitação.`);
      error.data = data;
      throw error;
    }
    return data;
  }

  function toast(title, message = '', type = 'success') {
    const host = els.profileToastHost || document.body;
    const node = document.createElement('div');
    node.className = `profile-toast${type === 'error' ? ' is-error' : ''}`;
    node.innerHTML = `
      <div class="profile-toast-icon"><i class="fa-solid ${type === 'error' ? 'fa-triangle-exclamation' : 'fa-check'}"></i></div>
      <div><strong></strong><span></span></div>
      <button type="button" class="profile-toast-close" aria-label="Fechar"><i class="fa-solid fa-xmark"></i></button>
    `;
    $('strong', node).textContent = title;
    $('span', node).textContent = message;
    const close = () => {
      node.classList.remove('is-visible');
      setTimeout(() => node.remove(), 180);
    };
    $('.profile-toast-close', node).addEventListener('click', close);
    host.appendChild(node);
    requestAnimationFrame(() => node.classList.add('is-visible'));
    setTimeout(close, type === 'error' ? 5200 : 3400);
  }

  function setBusy(button, busy, busyText = 'Salvando...') {
    if (!button) return;
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.disabled = Boolean(busy);
    button.classList.toggle('is-loading', Boolean(busy));
    button.innerHTML = busy
      ? `<i class="fa-solid fa-spinner"></i><span>${busyText}</span>`
      : button.dataset.originalHtml;
  }

  function formatPhone(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 11);
    if (!digits) return '';
    if (digits.length <= 2) return `(${digits}`;
    if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
    if (digits.length <= 10) {
      return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
    }
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }

  function onlyDigits(value) {
    return String(value || '').replace(/\D+/g, '');
  }

  function formatCpfCnpj(value) {
    const digits = onlyDigits(value).slice(0, 14);
    if (digits.length <= 11) {
      return digits
        .replace(/^(\d{3})(\d)/, '$1.$2')
        .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
        .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    }
    return digits
      .replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2')
      .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
  }

  function isValidCPF(value) {
    const digits = onlyDigits(value);
    if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
    const calc = (len) => {
      let total = 0;
      for (let i = 0; i < len; i += 1) total += Number(digits[i]) * ((len + 1) - i);
      let check = (total * 10) % 11;
      if (check === 10) check = 0;
      return check;
    };
    return calc(9) === Number(digits[9]) && calc(10) === Number(digits[10]);
  }

  function isValidCNPJ(value) {
    const digits = onlyDigits(value);
    if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;
    const digit = (base, weights) => {
      const total = base.split('').reduce((sum, n, index) => sum + Number(n) * weights[index], 0);
      const remainder = total % 11;
      return remainder < 2 ? 0 : 11 - remainder;
    };
    const first = digit(digits.slice(0, 12), [5,4,3,2,9,8,7,6,5,4,3,2]);
    if (first !== Number(digits[12])) return false;
    const second = digit(digits.slice(0, 13), [6,5,4,3,2,9,8,7,6,5,4,3,2]);
    return second === Number(digits[13]);
  }

  function isValidCpfCnpj(value) {
    const digits = onlyDigits(value);
    return digits.length === 11 ? isValidCPF(digits) : digits.length === 14 ? isValidCNPJ(digits) : false;
  }

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function sameLocalDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  function formatLastAccess(value) {
    const date = parseDate(value);
    if (!date) return 'Último acesso ainda não registrado';
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
    if (sameLocalDay(date, now)) return `Último acesso hoje às ${time}`;
    if (sameLocalDay(date, yesterday)) return `Último acesso ontem às ${time}`;
    const day = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
    return `Último acesso em ${day} às ${time}`;
  }

  function formatAccessSchedule(profile) {
    const start = clean(profile.hora_login_inicio);
    const end = clean(profile.hora_login_fim);
    const mode = clean(profile.horario_modo).toLowerCase();
    if (mode === 'livre' || mode === 'sem_restricao' || (!start && !end)) return 'Sem restrição cadastrada';
    if (start && end) return `${start} às ${end}`;
    if (start) return `A partir das ${start}`;
    if (end) return `Até ${end}`;
    return 'Sem restrição cadastrada';
  }

  function avatarSource(profile) {
    return clean(profile?.avatar_url) || `/api/perfil/avatar?v=${Date.now()}`;
  }

  function renderAvatar(profile, forcedUrl = '') {
    const name = clean(profile?.nome) || 'Usuário';
    els.avatarInitials.textContent = initials(name);
    const url = clean(forcedUrl) || avatarSource(profile);

    els.avatarImage.hidden = true;
    els.avatarInitials.hidden = false;
    els.avatarImage.onload = () => {
      els.avatarImage.hidden = false;
      els.avatarInitials.hidden = true;
    };
    els.avatarImage.onerror = () => {
      els.avatarImage.removeAttribute('src');
      els.avatarImage.hidden = true;
      els.avatarInitials.hidden = false;
    };
    els.avatarImage.src = url;
    els.btnRemoveAvatar.disabled = !clean(profile?.avatar_url);
  }

  function normalizePresence(status) {
    const value = clean(status).toLowerCase();
    return ['online', 'away', 'offline'].includes(value) ? value : 'offline';
  }

  function renderPresence(status, payload = {}) {
    const value = normalizePresence(status);
    const labels = { online: 'Online agora', away: 'Ausente', offline: 'Offline' };
    [els.presenceBadge, els.presenceDot].forEach((node) => {
      if (!node) return;
      node.classList.remove('is-online', 'is-away', 'is-offline');
      node.classList.add(`is-${value}`);
    });
    els.presenceText.textContent = labels[value];

    if (value === 'online') {
      const sessions = Number(payload.presence_session_count || state.profile?.presence_session_count || 0);
      els.lastAccessText.textContent = sessions > 1
        ? `Online em ${sessions} sessões do ZapsChat`
        : 'Você está usando o ZapsChat agora';
    } else if (value === 'away') {
      els.lastAccessText.textContent = 'Ausente por inatividade ou página em segundo plano';
    } else {
      els.lastAccessText.textContent = formatLastAccess(payload.last_access_at || state.profile?.last_access_at);
    }
  }

  function serializeProfileForm() {
    return JSON.stringify({
      nome: clean(els.nome.value),
      email: clean(els.email.value).toLowerCase(),
      telefone: clean(els.telefone.value),
      cargo: clean(els.cargo.value),
    });
  }

  function updateDirtyState() {
    const dirty = Boolean(state.initialForm) && serializeProfileForm() !== state.initialForm;
    els.profileSaveState.hidden = !dirty;
    els.btnCancelarPerfil.disabled = !dirty;
    return dirty;
  }

  function renderProfile(profile) {
    state.profile = profile;

    els.profileDisplayName.textContent = clean(profile.nome) || 'Usuário';
    els.profileDisplayEmail.textContent = clean(profile.email) || 'Sem e-mail';
    els.accountBadge.innerHTML = `<i class="fa-solid ${profile.is_admin ? 'fa-user-shield' : 'fa-headset'}" aria-hidden="true"></i><span></span>`;
    $('span', els.accountBadge).textContent = clean(profile.account_label) || (profile.is_admin ? 'Administrador' : 'Colaborador');

    els.nome.value = clean(profile.nome);
    els.email.value = clean(profile.email);
    els.telefone.value = formatPhone(profile.telefone);
    els.cargo.value = clean(profile.cargo);

    els.infoEmpresa.textContent = clean(profile.empresa_nome) || 'Empresa não informada';
    els.infoTipoConta.textContent = clean(profile.account_label) || 'Colaborador';
    els.infoDepartamento.textContent = clean(profile.departamento || profile.setor) || 'Não informado';
    els.infoHorario.textContent = formatAccessSchedule(profile);
    els.infoPermissoes.textContent = profile.is_admin
      ? 'Acesso administrativo completo'
      : `${Number(profile.permissoes_count || 0)} permissões liberadas`;
    els.infoIdentificacao.textContent = profile.colaborador_id
      ? `Conta #${profile.id} · Colaborador #${profile.colaborador_id}`
      : `Conta #${profile.id}`;

    renderAvatar(profile);
    renderPresence(profile.presence_status, profile);

    state.initialForm = serializeProfileForm();
    updateDirtyState();
    syncLocalProfile(profile);
  }

  function syncLocalProfile(profile) {
    try {
      localStorage.setItem('usuario_nome', clean(profile.nome));
      localStorage.setItem('usuario_email', clean(profile.email));
      if (profile.avatar_url) {
        localStorage.setItem('usuario_avatar', profile.avatar_url);
        localStorage.setItem('avatar_url', profile.avatar_url);
      } else {
        localStorage.removeItem('usuario_avatar');
        localStorage.removeItem('avatar_url');
      }
      localStorage.setItem('usuario_avatar_v', String(Date.now()));
    } catch {}

    try {
      window.dispatchEvent(new CustomEvent('zapschat-profile-updated', { detail: profile }));
      window.dispatchEvent(new CustomEvent('usuario-atualizado', { detail: profile }));
    } catch {}
  }

  async function loadCompanyDocument() {
    if (!els.companyDocumentCard || !els.companyDocument) return;
    if (!state.profile?.is_admin) {
      els.companyDocumentCard.hidden = true;
      return;
    }

    try {
      const data = await api('/api/billing/asaas/company-document');
      const company = data?.company || {};
      els.companyDocument.value = formatCpfCnpj(company.cnpj_cpf || '');
      els.companyDocumentError.textContent = company.cnpj_cpf_valid === false && company.cnpj_cpf
        ? 'O documento atual é inválido. Corrija para evitar falhas na assinatura.'
        : '';
      els.companyDocumentCard.hidden = false;

      if (new URLSearchParams(window.location.search).get('empresa') === '1') {
        requestAnimationFrame(() => {
          els.companyDocumentCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => els.companyDocument.focus(), 350);
        });
      }
    } catch (error) {
      els.companyDocumentCard.hidden = false;
      els.companyDocumentError.textContent = error.message || 'Não foi possível carregar o CPF/CNPJ da empresa.';
    }
  }

  async function saveCompanyDocument(event) {
    event.preventDefault();
    if (!state.profile?.is_admin) return;

    const digits = onlyDigits(els.companyDocument.value);
    els.companyDocumentError.textContent = '';
    els.companyDocument.classList.remove('is-invalid');

    if (!isValidCpfCnpj(digits)) {
      els.companyDocument.classList.add('is-invalid');
      els.companyDocumentError.textContent = 'Informe um CPF ou CNPJ válido.';
      els.companyDocument.focus();
      return;
    }

    setBusy(els.btnSaveCompanyDocument, true, 'Salvando...');
    try {
      const data = await api('/api/billing/asaas/company-document', {
        method: 'PUT',
        body: JSON.stringify({ cpf_cnpj: digits }),
      });
      els.companyDocument.value = formatCpfCnpj(data?.company?.cnpj_cpf || digits);
      els.companyDocument.classList.remove('is-invalid');
      els.companyDocumentError.textContent = '';
      toast('Dados da empresa atualizados', 'O CPF/CNPJ já será usado nas próximas cobranças.');
    } catch (error) {
      els.companyDocument.classList.add('is-invalid');
      els.companyDocumentError.textContent = error.message || 'Não foi possível salvar o CPF/CNPJ.';
      toast('Não foi possível salvar', error.message, 'error');
    } finally {
      setBusy(els.btnSaveCompanyDocument, false);
    }
  }

  async function loadProfile({ silent = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    els.profileMain.setAttribute('aria-busy', 'true');
    if (!silent) {
      els.profileLoading.hidden = false;
      els.profileContent.hidden = true;
    }
    els.btnAtualizarPagina.classList.add('is-loading');
    els.btnAtualizarPagina.disabled = true;

    try {
      const profile = await api('/api/perfil');
      renderProfile(profile);
      await loadCompanyDocument();
      els.profileLoading.hidden = true;
      els.profileContent.hidden = false;
      ensureProfilePresence();
      if (silent) toast('Perfil atualizado', 'Os dados foram recarregados.');
    } catch (error) {
      els.profileLoading.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><span>${error.message}</span>`;
      toast('Não foi possível carregar o perfil', error.message, 'error');
    } finally {
      state.loading = false;
      els.profileMain.setAttribute('aria-busy', 'false');
      els.btnAtualizarPagina.classList.remove('is-loading');
      els.btnAtualizarPagina.disabled = false;
    }
  }

  function validateProfileForm() {
    $$('[data-error-for]').forEach((node) => { node.textContent = ''; });
    $$('#formPerfil input').forEach((node) => node.classList.remove('is-invalid'));

    const name = clean(els.nome.value);
    const email = clean(els.email.value);
    let valid = true;

    if (name.length < 2) {
      els.nome.classList.add('is-invalid');
      $('[data-error-for="nome"]').textContent = 'Informe seu nome completo.';
      valid = false;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      els.email.classList.add('is-invalid');
      $('[data-error-for="email"]').textContent = 'Informe um e-mail válido.';
      valid = false;
    }
    return valid;
  }

  async function saveProfile(event) {
    event.preventDefault();
    if (!validateProfileForm()) return;

    setBusy(els.btnSalvarPerfil, true);
    try {
      const payload = JSON.parse(serializeProfileForm());
      const profile = await api('/api/perfil', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      renderProfile(profile);
      toast('Perfil salvo', 'Seus dados foram atualizados com sucesso.');
    } catch (error) {
      toast('Não foi possível salvar', error.message, 'error');
    } finally {
      setBusy(els.btnSalvarPerfil, false);
    }
  }

  function discardProfileChanges() {
    if (!state.profile) return;
    els.nome.value = clean(state.profile.nome);
    els.email.value = clean(state.profile.email);
    els.telefone.value = formatPhone(state.profile.telefone);
    els.cargo.value = clean(state.profile.cargo);
    updateDirtyState();
  }

  async function uploadAvatar(file) {
    if (!file) return;
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.type)) {
      toast('Imagem inválida', 'Use um arquivo JPG, PNG, WEBP ou GIF.', 'error');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      toast('Imagem muito grande', 'A foto deve ter no máximo 4 MB.', 'error');
      return;
    }

    if (state.avatarObjectUrl) URL.revokeObjectURL(state.avatarObjectUrl);
    state.avatarObjectUrl = URL.createObjectURL(file);
    renderAvatar(state.profile, state.avatarObjectUrl);
    els.avatarPreviewBox.classList.add('is-loading');
    els.btnEscolherFoto.disabled = true;
    els.btnUploadAvatar.disabled = true;

    const form = new FormData();
    form.append('file', file, file.name);

    try {
      const result = await api('/api/perfil/avatar', { method: 'POST', body: form });
      const profile = { ...state.profile, avatar_url: result.avatar_url || '' };
      state.profile = profile;
      renderAvatar(profile, result.avatar_url || `/api/perfil/avatar?v=${Date.now()}`);
      syncLocalProfile(profile);
      toast('Foto atualizada', 'Sua nova foto já está sendo usada no ZapsChat.');
    } catch (error) {
      renderAvatar(state.profile);
      toast('Não foi possível alterar a foto', error.message, 'error');
    } finally {
      els.avatarPreviewBox.classList.remove('is-loading');
      els.btnEscolherFoto.disabled = false;
      els.btnUploadAvatar.disabled = false;
      els.avatarInput.value = '';
      if (state.avatarObjectUrl) {
        URL.revokeObjectURL(state.avatarObjectUrl);
        state.avatarObjectUrl = '';
      }
    }
  }

  async function removeAvatar() {
    if (!state.profile?.avatar_url) return;
    const ok = window.confirm('Remover sua foto de perfil? O ZapsChat passará a mostrar suas iniciais.');
    if (!ok) return;

    els.avatarPreviewBox.classList.add('is-loading');
    els.btnRemoveAvatar.disabled = true;
    try {
      await api('/api/perfil/avatar', { method: 'DELETE' });
      state.profile = { ...state.profile, avatar_url: null };
      renderAvatar(state.profile, `/api/perfil/avatar?v=${Date.now()}`);
      syncLocalProfile(state.profile);
      toast('Foto removida', 'Agora suas iniciais serão exibidas no perfil.');
    } catch (error) {
      toast('Não foi possível remover a foto', error.message, 'error');
    } finally {
      els.avatarPreviewBox.classList.remove('is-loading');
      els.btnRemoveAvatar.disabled = !state.profile?.avatar_url;
    }
  }

  function passwordChecks() {
    const password = els.nova_senha.value || '';
    const confirmation = els.confirma_senha.value || '';
    return {
      length: password.length >= 8,
      letter: /[A-Za-zÀ-ÿ]/.test(password),
      number: /\d/.test(password),
      match: Boolean(password) && password === confirmation,
    };
  }

  function renderPasswordStrength() {
    const checks = passwordChecks();
    const password = els.nova_senha.value || '';
    Object.entries(checks).forEach(([rule, ok]) => {
      const node = $(`[data-rule="${rule}"]`, els.passwordRules);
      if (!node) return;
      node.classList.toggle('is-ok', ok);
      const icon = $('i', node);
      icon.className = `fa-solid ${ok ? 'fa-check' : 'fa-circle'}`;
    });

    let score = Object.values(checks).filter(Boolean).length;
    if (password.length >= 12) score += 1;
    if (/[^A-Za-zÀ-ÿ0-9]/.test(password)) score += 1;

    let width = 0;
    let text = 'Digite uma nova senha';
    let color = 'var(--pf-danger)';
    if (password) {
      width = Math.min(100, Math.max(18, score * 18));
      if (score <= 2) text = 'Senha fraca';
      else if (score <= 4) { text = 'Senha razoável'; color = 'var(--pf-warning)'; }
      else { text = 'Senha forte'; color = 'var(--pf-success)'; }
    }
    els.passwordStrengthBar.style.width = `${width}%`;
    els.passwordStrengthBar.style.background = color;
    els.passwordStrengthText.textContent = text;
    return checks;
  }

  async function savePassword(event) {
    event.preventDefault();
    const checks = renderPasswordStrength();
    if (!els.senha_atual.value) {
      toast('Informe a senha atual', 'Digite sua senha atual antes de continuar.', 'error');
      els.senha_atual.focus();
      return;
    }
    if (!checks.length || !checks.letter || !checks.number || !checks.match) {
      toast('Revise a nova senha', 'Ela precisa atender a todos os requisitos exibidos.', 'error');
      return;
    }

    setBusy(els.btnSalvarSenha, true, 'Atualizando...');
    try {
      await api('/api/perfil/senha', {
        method: 'PUT',
        body: JSON.stringify({
          senha_atual: els.senha_atual.value,
          nova_senha: els.nova_senha.value,
          confirma_senha: els.confirma_senha.value,
        }),
      });
      els.formSenha.reset();
      renderPasswordStrength();
      toast('Senha atualizada', 'Sua nova senha já está ativa.');
    } catch (error) {
      toast('Não foi possível alterar a senha', error.message, 'error');
    } finally {
      setBusy(els.btnSalvarSenha, false);
    }
  }

  function togglePassword(button) {
    const id = button.dataset.togglePassword;
    const input = document.getElementById(id);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.setAttribute('aria-label', showing ? 'Mostrar senha' : 'Ocultar senha');
    const icon = $('i', button);
    icon.className = `fa-regular ${showing ? 'fa-eye' : 'fa-eye-slash'}`;
  }

  function detectSession() {
    const ua = navigator.userAgent || '';
    let browser = 'Navegador atual';
    if (/Edg\//.test(ua)) browser = 'Microsoft Edge';
    else if (/OPR\//.test(ua)) browser = 'Opera';
    else if (/Firefox\//.test(ua)) browser = 'Mozilla Firefox';
    else if (/Chrome\//.test(ua)) browser = 'Google Chrome';
    else if (/Safari\//.test(ua)) browser = 'Safari';

    let system = 'Dispositivo atual';
    if (/Windows NT 10/.test(ua)) system = 'Windows 10 ou 11';
    else if (/Windows/.test(ua)) system = 'Windows';
    else if (/Android/.test(ua)) system = 'Android';
    else if (/iPhone|iPad/.test(ua)) system = 'iPhone ou iPad';
    else if (/Mac OS X/.test(ua)) system = 'macOS';
    else if (/Linux/.test(ua)) system = 'Linux';

    els.sessionBrowser.textContent = browser;
    els.sessionSystem.textContent = `${system} · sessão atual`;
  }

  async function logoutCurrent() {
    els.btnLogoutCurrent.disabled = true;
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {}
    try {
      ['access_token', 'token', 'auth_token'].forEach((key) => localStorage.removeItem(key));
      sessionStorage.clear();
    } catch {}
    window.location.replace('/login.html');
  }

  function handlePresenceEvent(event) {
    const detail = event?.detail || {};
    const envelope = detail.payload || detail;
    const payload = clean(envelope?.type).toLowerCase() === 'message'
      ? envelope?.data
      : envelope;
    if (!payload || typeof payload !== 'object' || !state.profile?.colaborador_id) return;

    const type = clean(payload.type).toUpperCase();
    if (type === 'ZAPSCHAT_PRESENCE') {
      if (Number(payload.colaborador_id) !== Number(state.profile.colaborador_id)) return;
      state.profile = { ...state.profile, ...payload };
      renderPresence(payload.presence_status, state.profile);
      return;
    }

    if (type === 'ZAPSCHAT_PRESENCE_SNAPSHOT' && Array.isArray(payload.items)) {
      const item = payload.items.find((row) => Number(row.colaborador_id) === Number(state.profile.colaborador_id));
      if (!item) return;
      state.profile = { ...state.profile, ...item };
      renderPresence(item.presence_status, state.profile);
    }
  }

  async function ensureProfilePresence() {
    const empresaId = Number(
      state.profile?.empresa_id
      || window.APP_EMPRESA_ID
      || window.EMPRESA_ID
      || localStorage.getItem('empresa_id')
      || 0
    );
    if (!empresaId || !state.profile?.colaborador_id) return;

    try {
      const core = await import('/frontend/js/realtime/ws-core.js?v=profile-presence-20260726-2');
      if (typeof core.ensureEmpresaWS === 'function') {
        core.ensureEmpresaWS(empresaId, { presenceSnapshot: true });
      }
    } catch (error) {
      console.warn('[perfil] presença em tempo real indisponível', error);
    }
  }

  function bindEvents() {
    els.btnAtualizarPagina.addEventListener('click', () => loadProfile({ silent: true }));
    els.formPerfil.addEventListener('submit', saveProfile);
    els.formPerfil.addEventListener('input', updateDirtyState);
    els.btnCancelarPerfil.addEventListener('click', discardProfileChanges);

    els.telefone.addEventListener('input', () => {
      const cursorAtEnd = els.telefone.selectionStart === els.telefone.value.length;
      els.telefone.value = formatPhone(els.telefone.value);
      if (cursorAtEnd) els.telefone.setSelectionRange(els.telefone.value.length, els.telefone.value.length);
      updateDirtyState();
    });

    [els.btnUploadAvatar, els.btnEscolherFoto].forEach((button) => {
      button.addEventListener('click', () => els.avatarInput.click());
    });
    els.avatarInput.addEventListener('change', () => uploadAvatar(els.avatarInput.files?.[0]));
    els.btnRemoveAvatar.addEventListener('click', removeAvatar);

    if (els.formCompanyDocument) {
      els.formCompanyDocument.addEventListener('submit', saveCompanyDocument);
      els.companyDocument.addEventListener('input', () => {
        els.companyDocument.value = formatCpfCnpj(els.companyDocument.value);
        els.companyDocument.classList.remove('is-invalid');
        els.companyDocumentError.textContent = '';
      });
    }

    els.formSenha.addEventListener('submit', savePassword);
    [els.nova_senha, els.confirma_senha].forEach((input) => input.addEventListener('input', renderPasswordStrength));
    $$('[data-toggle-password]').forEach((button) => button.addEventListener('click', () => togglePassword(button)));

    els.btnLogoutCurrent.addEventListener('click', logoutCurrent);
    window.addEventListener('zc:ws-core', handlePresenceEvent);

    window.addEventListener('beforeunload', (event) => {
      if (!updateDirtyState()) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  function init() {
    cacheElements();
    detectSession();
    bindEvents();
    renderPasswordStrength();
    loadProfile();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
