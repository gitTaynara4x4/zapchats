/* ZapChats – Criar Empresa (wizard + validação + avatar + seed de sessão) */
(() => {
  'use strict';

  // ===== Shortcuts
  const $  = (sel, el=document) => el.querySelector(sel);
  const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));
  const byId = (id) => document.getElementById(id);

  // ===== Elements (wizard)
  const form       = byId('form-register');
  if (!form) return;

  const steps      = $$('.step', form);
  const dots       = $$('.dot');
  const stepText   = byId('stepText');

  const btnNext    = byId('btn-next');
  const btnBack    = byId('btn-back');
  const btnSubmit  = byId('btn-submit');

  const toast      = byId('toast');

  // ===== Fields Step 0
  const docInput   = byId('doc');
  const nomeEmp    = byId('nome');
  const telefone   = byId('telefone');

  const errDoc     = byId('err-doc');
  const errNome    = byId('err-nome');
  const errTel     = byId('err-telefone');

  // wrappers p/ borda vermelha
  const wrapDoc    = byId('wrap-doc');
  const wrapNome   = byId('wrap-nomeemp');
  const wrapTel    = byId('wrap-telefone');

  // ===== Fields Step 1
  const nomeAdm    = byId('nome_adm');
  const emailAdm   = byId('email_admin');
  const senhaAdm   = byId('senha_admin');
  const senhaConf  = byId('senha_confirm');

  const errNomeAdm = byId('err-nomeadm');
  const errEmail   = byId('err-email');
  const errSenha   = byId('err-senha');
  const errConf    = byId('err-confirma');

  const wrapNomeAdm= byId('wrap-nomeadm');
  const wrapEmail  = byId('wrap-email');
  const wrapSenha  = byId('wrap-senha');
  const wrapConf   = byId('wrap-confirma');

  // ===== Inputs auxiliares (step 2 / avatar)
  const avatarTrigger = byId('avatar-trigger');
  const avatarFile    = byId('avatar-file');
  const avatarPreview = byId('avatar-preview');
  const avatarCta     = byId('avatar-cta');
  const avatarRing    = byId('avatar-ring');
  const avatarStatus  = byId('avatar-status');
  const avatarUrl     = byId('avatar_url');

  // ===== Modal avatar
  const btnOpenAvatars= byId('btn-open-avatars');
  const avatarModal   = byId('avatar-modal');
  const avatarBackdrop= byId('avatar-backdrop');
  const avatarClose   = byId('avatar-close');
  const avatarCancel  = byId('avatar-cancel');
  const avatarApply   = byId('avatar-apply');
  const presetGrid    = byId('preset-grid');

  // ===== Pass helpers
  const btnTogglePass = byId('toggle-pass');
  const btnGenPass    = byId('gen-pass');

  // ===== State
  let stepIndex = Math.max(0, steps.findIndex(s => s.classList.contains('step--active')));
  if (stepIndex === -1) stepIndex = 0;

  // Ensure only one active initially
  steps.forEach((s,i) => s.classList.toggle('step--active', i === stepIndex));

  // ===== Wizard navigation
  function updateStepperUI() {
    dots.forEach((d,i) => d.classList.toggle('active', i <= stepIndex));
    if (stepText) stepText.textContent = `Etapa ${stepIndex+1} de ${steps.length}`;

    // botões
    btnBack.disabled = stepIndex === 0;
    btnBack.classList.toggle('hidden', stepIndex === 0);

    const last = (stepIndex === steps.length - 1);
    btnNext.classList.toggle('hidden', last);
    btnSubmit.classList.toggle('hidden', !last);
  }

  function animateSwap(fromEl, toEl) {
    // sai a atual
    if (fromEl) {
      fromEl.classList.remove('step--active');
      fromEl.classList.add('step--leave');
      fromEl.addEventListener('animationend', () => {
        fromEl.classList.remove('step--leave');
      }, { once: true });
    }
    // entra a próxima
    if (toEl) {
      toEl.classList.add('step--active', 'step--enter');
      toEl.addEventListener('animationend', () => {
        toEl.classList.remove('step--enter');
      }, { once: true });
    }
  }

  function gotoStep(nextIndex, { validate=true } = {}) {
    nextIndex = Math.max(0, Math.min(nextIndex, steps.length - 1));
    if (nextIndex === stepIndex) return;

    if (validate && nextIndex > stepIndex) {
      // indo pra frente, precisa validar a etapa atual
      if (!validateStep(stepIndex)) return;
    }
    const from = steps[stepIndex];
    const to   = steps[nextIndex];
    stepIndex  = nextIndex;
    animateSwap(from, to);
    updateStepperUI();
    // foco no primeiro campo da etapa
    const focusable = to.querySelector('input,button,select,textarea');
    if (focusable) focusable.focus({ preventScroll:true });
  }

  btnNext?.addEventListener('click', () => gotoStep(stepIndex + 1, { validate:true }));
  btnBack?.addEventListener('click', () => gotoStep(stepIndex - 1, { validate:false }));

  updateStepperUI();

  // ===== Validations
  const onlyDigits = (s) => (s||'').replace(/\D+/g,'');
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((s||'').trim());

  function setErr(wrap, helpEl, msg) {
    if (!wrap || !helpEl) return;
    if (msg) {
      wrap.classList.add('field-err');
      helpEl.textContent = msg;
    } else {
      wrap.classList.remove('field-err');
      helpEl.textContent = '';
    }
  }

  // Mask (leve) ao digitar
  docInput?.addEventListener('input', () => {
    const d = onlyDigits(docInput.value);
    setErr(wrapDoc, errDoc, ''); // limpa ao digitar
    // Formata CNPJ/CPF rapidamente (sem dependências)
    if (d.length <= 11) { // CPF
      docInput.value = d
        .replace(/^(\d{3})(\d)/, '$1.$2')
        .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
        .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
    } else { // CNPJ
      docInput.value = d
        .replace(/^(\d{2})(\d)/, '$1.$2')
        .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
        .replace(/\.(\d{3})(\d)/, '.$1/$2')
        .replace(/(\d{4})(\d)/, '$1-$2');
    }
  });

  telefone?.addEventListener('input', () => {
    const d = onlyDigits(telefone.value);
    setErr(wrapTel, errTel, '');
    // máscara brasileira simples
    if (d.length <= 10) {
      telefone.value = d
        .replace(/^(\d{2})(\d)/, '($1) $2')
        .replace(/(\d{4})(\d{1,4})$/, '$1-$2');
    } else {
      telefone.value = d
        .replace(/^(\d{2})(\d)/, '($1) $2')
        .replace(/(\d{5})(\d{1,4})$/, '$1-$2');
    }
  });

  function validateStep(idx) {
    let ok = true;

    if (idx === 0) {
      const rawDoc = onlyDigits(docInput?.value);
      const rawTel = onlyDigits(telefone?.value);
      const nome   = (nomeEmp?.value || '').trim();

      // Doc: aceita CPF (11) ou CNPJ (14)
      if (!(rawDoc && (rawDoc.length === 11 || rawDoc.length === 14))) {
        ok = false;
        setErr(wrapDoc, errDoc, 'Informe um CPF (11) ou CNPJ (14) válido (somente números).');
      } else {
        setErr(wrapDoc, errDoc, '');
      }

      if (!nome || nome.length < 3) {
        ok = false;
        setErr(wrapNome, errNome, 'Informe o nome da empresa (mín. 3 caracteres).');
      } else {
        setErr(wrapNome, errNome, '');
      }

      // Telefone: 10 ou 11 dígitos
      if (!(rawTel && (rawTel.length === 10 || rawTel.length === 11))) {
        ok = false;
        setErr(wrapTel, errTel, 'Informe um telefone válido com DDD.');
      } else {
        setErr(wrapTel, errTel, '');
      }
    }

    if (idx === 1) {
      const nome = (nomeAdm?.value || '').trim();
      const email= (emailAdm?.value || '').trim();
      const s    = (senhaAdm?.value || '');
      const c    = (senhaConf?.value || '');

      if (!nome || nome.length < 3) {
        ok = false;
        setErr(wrapNomeAdm, errNomeAdm, 'Informe o nome do administrador (mín. 3 caracteres).');
      } else setErr(wrapNomeAdm, errNomeAdm, '');

      if (!isEmail(email)) {
        ok = false;
        setErr(wrapEmail, errEmail, 'Digite um e-mail válido.');
      } else setErr(wrapEmail, errEmail, '');

      if (!s || s.length < 6) {
        ok = false;
        setErr(wrapSenha, errSenha, 'Senha mínima de 6 caracteres.');
      } else setErr(wrapSenha, errSenha, '');

      if (c !== s) {
        ok = false;
        setErr(wrapConf, errConf, 'As senhas não conferem.');
      } else setErr(wrapConf, errConf, '');
    }

    // toast de atalho
    if (!ok) {
      showToast('Por favor, corrija os campos destacados antes de continuar.');
    } else {
      hideToast();
    }
    return ok;
  }

  function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg || '';
    toast.classList.remove('hidden');
  }
  function hideToast() {
    toast?.classList.add('hidden');
  }

  // ===== Password helpers
  btnTogglePass?.addEventListener('click', () => {
    if (!senhaAdm) return;
    const now = senhaAdm.type === 'password' ? 'text' : 'password';
    senhaAdm.type = now;
    btnTogglePass.textContent = now === 'password' ? 'Mostrar' : 'Ocultar';
  });

  btnGenPass?.addEventListener('click', () => {
    if (!senhaAdm || !senhaConf) return;
    const p = genStrongPass();
    senhaAdm.value  = p;
    senhaConf.value = p;
    setErr(wrapSenha, errSenha, '');
    setErr(wrapConf, errConf, '');
  });

  function genStrongPass(len=12) {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const b = 'abcdefghijkmnopqrstuvwxyz';
    const c = '23456789';
    const d = '!@#$%&*?';
    const pool = a + b + c + d;
    let out = '';
    out += a[Math.floor(Math.random()*a.length)];
    out += b[Math.floor(Math.random()*b.length)];
    out += c[Math.floor(Math.random()*c.length)];
    out += d[Math.floor(Math.random()*d.length)];
    for (let i=4; i<len; i++) out += pool[Math.floor(Math.random()*pool.length)];
    return out.split('').sort(()=>Math.random()-0.5).join('');
  }

  // ===== Avatar upload
  avatarTrigger?.addEventListener('click', () => avatarFile?.click());
  avatarFile?.addEventListener('change', () => {
    const f = avatarFile.files && avatarFile.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      applyAvatar(reader.result);
    };
    reader.readAsDataURL(f);
  });

  function applyAvatar(dataUrl) {
    if (!dataUrl) return;
    if (avatarPreview) {
      avatarPreview.src = dataUrl;
      avatarPreview.classList.remove('hidden');
    }
    avatarCta?.classList.add('hidden');
    avatarRing?.classList.remove('hidden');
    avatarStatus?.classList.remove('hidden');
    if (avatarUrl) avatarUrl.value = dataUrl;
  }

  // ===== Avatar modal (presets com iniciais)
  let selectedPreset = null;

  function openAvatarModal() {
    if (!avatarModal) return;
    avatarModal.classList.remove('hidden');
    avatarModal.classList.add('is-open');
    buildPresets();
    avatarApply?.setAttribute('disabled','');
  }
  function closeAvatarModal() {
    if (!avatarModal) return;
    avatarModal.classList.add('hidden');
    avatarModal.classList.remove('is-open');
    selectedPreset = null;
  }

  btnOpenAvatars?.addEventListener('click', openAvatarModal);
  avatarBackdrop?.addEventListener('click', closeAvatarModal);
  avatarClose?.addEventListener('click', closeAvatarModal);
  avatarCancel?.addEventListener('click', closeAvatarModal);

  avatarApply?.addEventListener('click', () => {
    if (!selectedPreset) return;
    applyAvatar(selectedPreset);
    closeAvatarModal();
  });

  function buildPresets() {
    if (!presetGrid) return;
    presetGrid.innerHTML = '';
    const baseName = (nomeAdm?.value || nomeEmp?.value || '').trim() || 'Usuário Zap';
    const initials = getInitials(baseName);
    const palettes = [
      ['#111827','#22c55e'], ['#111827','#06b6d4'],
      ['#111827','#6366f1'], ['#111827','#f59e0b'],
      ['#111827','#ef4444'], ['#111827','#84cc16'],
      ['#111827','#10b981'], ['#111827','#0ea5e9'],
      ['#111827','#a78bfa'], ['#111827','#f43f5e'],
      ['#111827','#eab308'], ['#111827','#14b8a6']
    ];
    palettes.forEach((p, i) => {
      const url = drawInitialsAvatar(initials, p[0], p[1]);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.border = '0';
      btn.style.background = 'transparent';
      btn.style.padding = '0';
      btn.style.cursor = 'pointer';
      btn.innerHTML = `<img src="${url}" alt="Avatar ${i+1}">`;
      btn.addEventListener('click', () => {
        // marca seleção
        $$('.preset-grid img', presetGrid).forEach(img => img.style.boxShadow = '');
        btn.firstChild.style.boxShadow = '0 0 0 3px rgba(34,197,94,.6)';
        selectedPreset = url;
        avatarApply?.removeAttribute('disabled');
      });
      presetGrid.appendChild(btn);
    });
  }

  function getInitials(name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] || '';
    const b = parts.length > 1 ? parts[parts.length-1][0] : '';
    return (a + b).toUpperCase();
  }

  function drawInitialsAvatar(text, bg='#111827', fg='#22c55e') {
    const size = 256;
    const cvs = document.createElement('canvas');
    cvs.width = size; cvs.height = size;
    const ctx = cvs.getContext('2d');

    // fundo (circle)
    ctx.fillStyle = bg;
    ctx.fillRect(0,0,size,size);
    ctx.beginPath();
    ctx.arc(size/2, size/2, size/2 - 6, 0, Math.PI*2);
    ctx.fillStyle = fg + 'E6'; // leve transparência
    ctx.fill();

    // texto
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 120px Poppins, Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size/2, size/2 + 8);

    return cvs.toDataURL('image/png');
  }

  // ====== 🔑 Helpers para “seed” de sessão (igual ao login) ======
  async function cacheFromMe() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (!r.ok) return;
      const d = await r.json();
      if (d?.nome)  localStorage.setItem('nome', d.nome);
      if (d?.email) localStorage.setItem('email', d.email);
      if (d?.empresa_id != null) localStorage.setItem('empresa_id', String(d.empresa_id));
      if (d?.role || d?.cargo) {
        const cargoOuRole = d.role || d.cargo;
        localStorage.setItem('usuario_role', cargoOuRole);
        localStorage.setItem('role', cargoOuRole);
      }
      if (d?.avatar_url) localStorage.setItem('usuario_avatar', d.avatar_url);
    } catch {}
  }

  async function cacheAvatarPreferindo(valorDoFormulario) {
    try {
      // Se o usuário selecionou/gerou um avatar (dataURL), usa esse
      if (valorDoFormulario && typeof valorDoFormulario === 'string' && valorDoFormulario.startsWith('data:')) {
        localStorage.setItem('usuario_avatar', valorDoFormulario);
        return;
      }
      // Tenta endpoint dedicado (se existir)
      const r = await fetch('/api/usuarios/me/avatar', { credentials: 'include' });
      if (r.ok) {
        const blob = await r.blob();
        const reader = new FileReader();
        await new Promise(res => { reader.onload = () => res(); reader.readAsDataURL(blob); });
        if (reader.result) localStorage.setItem('usuario_avatar', reader.result);
        return;
      }
      // Fallback: puxa URL do /me
      await cacheFromMe();
    } catch {
      // não quebra o fluxo
    }
  }

  // ===== Submit (última etapa)
  form.addEventListener('submit', async (e) => {
    // valida etapa 2 antes de enviar
    if (!validateStep(1)) {
      e.preventDefault();
      gotoStep(1, { validate:false });
      return;
    }
    // Envio via fetch
    e.preventDefault();

    // >>> payload com as chaves que o backend espera (RegisterIn)
    const payload = {
      doc: (onlyDigits(docInput?.value)),
      nome: (nomeEmp?.value || '').trim(),
      telefone: (onlyDigits(telefone?.value)),

      nome_adm: (nomeAdm?.value || '').trim(),
      email_admin: (emailAdm?.value || '').trim(),
      senha_admin: (senhaAdm?.value || ''),
      avatar_url: (avatarUrl?.value || '')
    };

    try {
      btnSubmit.disabled = true;
      btnSubmit.textContent = 'Cadastrando…';

      // >>> endpoint correto do backend
      const res = await fetch('/api/auth/criar-empresa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        let msg = 'Não foi possível concluir o cadastro.';
        try {
          const j = await res.json();
          if (j?.detail) msg = String(j.detail);
        } catch {}
        showToast(msg);
        btnSubmit.disabled = false;
        btnSubmit.textContent = 'Cadastrar Empresa';
        return;
      }

      // sucesso
      hideToast();

      // ===== Seed do cache para a UI abrir completa (igual ao login)
      await cacheFromMe(); // nome, email, empresa_id, role, avatar_url (se existir)
      const formAvatar = (avatarUrl?.value || '');
      await cacheAvatarPreferindo(formAvatar); // garante usuario_avatar

      // segue para o app
      window.location.replace('/dashboard');

    } catch (err) {
      console.error(err);
      showToast('Erro de conexão. Tente novamente.');
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Cadastrar Empresa';
    }
  });

  // ===== Safety: garanta que modais fechados não bloqueiem clique
  document.querySelectorAll('.modal').forEach(m => {
    const open = m.classList.contains('is-open') || m.hasAttribute('open') || m.dataset.open === 'true';
    if (!open) {
      m.classList.add('hidden');
      m.style.display = 'none';
      m.style.pointerEvents = 'none';
    }
  });

})();

/* === Toggle de tema (igual ao Login: sol/lua + deslize + persistência) === */
(() => {
  const html = document.documentElement;
  const btn  = document.getElementById('themeSwitch');

  function applyTheme(mode) {
    const isDark = (mode === 'dark');
    html.classList.toggle('dark', isDark);
    try { localStorage.setItem('theme', isDark ? 'dark' : 'light'); } catch {}
    btn?.setAttribute('aria-pressed', String(isDark));
  }

  // Inicializa respeitando o preload do <head>
  try {
    const saved = (localStorage.getItem('theme') || 'dark').toLowerCase();
    applyTheme(saved === 'light' ? 'light' : 'dark');
  } catch {
    applyTheme('dark');
  }

  // Clique: alterna e dispara animação do brilho (.t-anim)
  btn?.addEventListener('click', () => {
    const willDark = !html.classList.contains('dark');
    applyTheme(willDark ? 'dark' : 'light');

    btn.classList.remove('t-anim');
    void btn.offsetWidth; // reflow
    btn.classList.add('t-anim');
    setTimeout(() => btn.classList.remove('t-anim'), 580);
  });

  // Sincroniza entre abas/janelas
  window.addEventListener('storage', (e) => {
    if (e.key === 'theme') {
      const v = (e.newValue || 'dark').toLowerCase();
      applyTheme(v === 'dark' ? 'dark' : 'light');
    }
  });
})();
