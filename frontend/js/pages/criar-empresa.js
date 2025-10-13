/* ===== Tema ===== */
(function(){
  var html = document.documentElement;
  try { var saved = localStorage.getItem('theme'); if (saved) html.classList.toggle('dark', saved === 'dark'); } catch {}
  var btn = document.getElementById('themeSwitch');
  if (btn){
    function sync(){ btn.setAttribute('aria-pressed', String(html.classList.contains('dark'))); }
    sync();
    btn.addEventListener('click', function(){
      var willDark = !html.classList.contains('dark');
      html.classList.toggle('dark', willDark);
      try { localStorage.setItem('theme', willDark ? 'dark' : 'light'); } catch {}
      btn.classList.remove('t-anim'); void btn.offsetWidth; btn.classList.add('t-anim');
      setTimeout(function(){ btn.classList.remove('t-anim'); }, 580);
      sync();
    });
  }
})();

/* ===== API endpoints ===== */
const API = "/api";
const CREATE_URL = "/api/auth/criar-empresa"; // teu endpoint atual
const LOGIN_URL  = `${API}/auth/login`;       // ajuste se o teu login for diferente

/* ===== Helpers UI ===== */
function qs(id){ return document.getElementById(id); }
function setErr(wrapperId, errId, message){
  const wrap = qs(wrapperId);
  const p = qs(errId);
  if (!wrap || !p) return;
  if (message){ wrap.classList.add('field-err'); p.textContent = message; }
  else { wrap.classList.remove('field-err'); p.textContent = ''; }
}
function onlyDigits(s){ return String(s||'').replace(/\D/g, ''); }

/* ===== Auth helpers ===== */
function isBadName(v){ return !v || typeof v !== 'string' || /^\d+$/.test(v.trim()); }

/* PATCH: salva nome/email/avatar também e notifica o sidebar */
function setAuthAndGo({ token, empresa_id, nome, email, avatar_url }){
  if (!token) return;
  try{
    localStorage.setItem("Authorization", `Bearer ${token}`);
    localStorage.setItem("access_token", token);
    localStorage.setItem("token", token);
    if (empresa_id) localStorage.setItem("empresa_id", String(empresa_id));

    // limpar qualquer 'name' numérico que possa poluir o chip
    try{ 
      const n = localStorage.getItem('name');
      if (n && /^\d+$/.test(n)) localStorage.removeItem('name');
    }catch{}

    if (!isBadName(nome)){
      localStorage.setItem("usuario_nome", nome);
      localStorage.setItem("nome", nome);
    }
    if (email){
      localStorage.setItem("usuario_email", email);
      localStorage.setItem("email", email);
    }
    if (avatar_url) localStorage.setItem("usuario_avatar", avatar_url);
  }catch{}
  try { window.dispatchEvent(new Event('auth:change')); } catch {}
  location.href = "/inicio.html";
}

async function doLogin(email, senha){
  const resp = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, senha })
  });
  if (!resp.ok) throw new Error(`Falha no login (${resp.status})`);
  const data = await resp.json().catch(()=> ({}));
  const token = data.access_token || data.token;
  const empresa_id = data.empresa_id || data.empresaId || data.company_id;
  if (!token) throw new Error("API não devolveu token no login.");
  setAuthAndGo({
    token,
    empresa_id,
    nome:  data.nome || data.name || data.usuario_nome,
    email: data.email || data.usuario_email,
    avatar_url: data.avatar_url || data.avatar
  });
}

/* ===== Toast ===== */
const toast = qs('toast');
function showToast(message, variant='info'){
  if (!toast) return;
  const styles = {
    info:  'border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:border-amber-800 dark:text-amber-200',
    warn:  'border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:border-amber-800 dark:text-amber-200',
    error: 'border-red-300 bg-red-50 text-red-800 dark:bg-red-900/30 dark:border-red-800 dark:text-red-200',
    ok:    'border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:border-emerald-800 dark:text-emerald-200'
  };
  toast.className = 'mb-4 rounded-lg border px-4 py-3 text-sm ' + (styles[variant]||styles.info);
  toast.textContent = message;
  toast.classList.remove('hidden');
}
function hideToast(){ if (!toast) return; toast.classList.add('hidden'); toast.textContent=''; }

/* ===== Modal de confirmação (custom) ===== */
const confirmOverlay = qs('confirm-overlay');
const confirmMsgEl   = qs('confirm-message');
const confirmOkBtn   = qs('confirm-ok');
const confirmCancelBtn = qs('confirm-cancel');

function confirmModal(message){
  return new Promise((resolve)=>{
    if (!confirmOverlay || !confirmMsgEl || !confirmOkBtn || !confirmCancelBtn) return resolve(true);
    confirmMsgEl.textContent = message;
    confirmOverlay.classList.remove('hidden');

    function cleanup(result){
      confirmOverlay.classList.add('hidden');
      confirmOkBtn.removeEventListener('click', onOk);
      confirmCancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk(){ cleanup(true); }
    function onCancel(){ cleanup(false); }
    function onKey(e){ if(e.key==='Escape') cleanup(false); if(e.key==='Enter') cleanup(true); }

    confirmOkBtn.addEventListener('click', onOk);
    confirmCancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey, { once:false });
  });
}

/* ===== Telefone máscara ===== */
function formatTelefone(value) {
  const digits = value.replace(/\D/g, '');
  if (!digits) return '';
  const ddd = digits.slice(0,2);
  const rest = digits.slice(2);
  if (!ddd) return digits;
  if (rest.length <= 4) return `(${ddd}) ${rest}`;
  if (rest.length <= 8) return `(${ddd}) ${rest.slice(0,4)}-${rest.slice(4)}`;
  if (rest.length <= 9) return `(${ddd}) ${rest.slice(0,5)}-${rest.slice(5)}`;
  return `(${ddd}) ${rest.slice(0,5)}-${rest.slice(5,9)}`;
}
window.formatTelefone = formatTelefone;

/* ===== CPF/CNPJ: máscara + validação ===== */
const docInput = qs('doc');
function formatDoc(d){
  if (d.length <= 11){
    return d
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4')
      .slice(0,14);
  } else {
    return d
      .replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/^(\d{2})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3/$4')
      .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})(\d)/, '$1.$2.$3/$4-$5')
      .slice(0,18);
  }
}
function isCPF(cpf){
  cpf = onlyDigits(cpf);
  if (!cpf || cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  let sum=0, rest;
  for (let i=1;i<=9;i++) sum += parseInt(cpf.substring(i-1,i))*(11-i);
  rest = (sum*10)%11; if (rest === 10 || rest === 11) rest = 0;
  if (rest !== parseInt(cpf.substring(9,10))) return false;
  sum=0;
  for (let i=1;i<=10;i++) sum += parseInt(cpf.substring(i-1,i))*(12-i);
  rest = (sum*10)%11; if (rest === 10 || rest === 11) rest = 0;
  return rest === parseInt(cpf.substring(10,11));
}
function isCNPJ(cnpj){
  cnpj = onlyDigits(cnpj);
  if (!cnpj || cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;
  const base1 = cnpj.substring(0,12);
  let sum=0, pos=5;
  for (let i=0;i<12;i++){ sum += parseInt(base1[i]) * pos; pos = (pos===2)?9:pos-1; }
  let dig1 = (sum % 11 < 2) ? 0 : 11 - (sum % 11);

  const base2 = cnpj.substring(0,13);
  sum=0; pos=6;
  for (let i=0;i<13;i++){ sum += parseInt(base2[i]) * pos; pos = (pos===2)?9:pos-1; }
  let dig2 = (sum % 11 < 2) ? 0 : 11 - (sum % 11);

  return (String(dig1) === cnpj.substring(12,13)) && (String(dig2) === cnpj.substring(13,14));
}
function vDoc(){
  const d = onlyDigits(docInput?.value);
  if (!d) return 'Informe 11 dígitos (CPF) ou 14 dígitos (CNPJ).';
  if (d.length === 11) return isCPF(d) ? '' : 'CPF inválido.';
  if (d.length === 14) return isCNPJ(d) ? '' : 'CNPJ inválido.';
  return 'Informe 11 dígitos (CPF) ou 14 dígitos (CNPJ).';
}
if (docInput){
  docInput.addEventListener('input', ()=>{
    const d = onlyDigits(docInput.value);
    docInput.value = formatDoc(d);
    validateField('doc');
  });
}

/* ===== Demais campos ===== */
const nomeAdm = qs('nome_adm');
const nomeEmp = qs('nome');
const tel     = qs('telefone');
const email   = qs('email_admin');
const senha   = qs('senha_admin');
const confirma= qs('senha_confirm');

function vNomeEmp(){ const v=(nomeEmp?.value||'').trim(); return v.length<2 ? 'Informe o nome da empresa.' : ''; }
function vNomeAdm(){ const v=(nomeAdm?.value||'').trim(); return v.length<3 ? 'Informe o nome completo.' : ''; }
function vTelefone(){ const d=onlyDigits(tel?.value); return (d.length===10||d.length===11)? '' : 'Telefone deve ter DDD + número (10 ou 11 dígitos).'; }
function vEmail(){ const v=(email?.value||'').trim(); return /.+@.+\..+/.test(v)? '' : 'Digite um e-mail válido (ex.: nome@dominio.com).'; }
function vSenha(){ const v=senha?.value||''; if(v.length<8) return 'A senha precisa ter pelo menos 8 caracteres.'; if(!/[a-z]/.test(v)||!/[A-Z]/.test(v)||!/[0-9]/.test(v)) return 'Use maiúsculas, minúsculas e números.'; return ''; }
function vConfirma(){ if(!confirma?.value) return 'Repita a senha.'; return (confirma.value===senha.value)? '' : 'As senhas não coincidem.'; }

function validateField(which){
  switch(which){
    case 'doc':     setErr('wrap-doc','err-doc', vDoc()); break;
    case 'nome':    setErr('wrap-nomeemp','err-nome', vNomeEmp()); break;
    case 'nomeadm': setErr('wrap-nomeadm','err-nomeadm', vNomeAdm()); break;
    case 'tel':     setErr('wrap-telefone','err-telefone', vTelefone()); break;
    case 'email':   setErr('wrap-email','err-email', vEmail()); break;
    case 'senha':   setErr('wrap-senha','err-senha', vSenha()); break;
    case 'conf':    setErr('wrap-confirma','err-confirma', vConfirma()); break;
  }
}

// Validação em tempo real
['input','blur'].forEach(evt=>{
  [docInput,nomeEmp,nomeAdm,tel,email,senha,confirma].forEach(el=>{
    if (!el) return;
    el.addEventListener(evt, ()=>{
      switch(el){
        case docInput: validateField('doc'); break;
        case nomeEmp:  validateField('nome'); break;
        case nomeAdm:  validateField('nomeadm'); break;
        case tel:      validateField('tel'); break;
        case email:    validateField('email'); break;
        case senha:    validateField('senha'); validateField('conf'); break;
        case confirma: validateField('conf'); break;
      }
    });
  });
});

/* ===== Dicas/Geração de senha ===== */
const dicas = [
  'Dica: combine 3 palavras + número, ex: CaféRoxo!Trilho27',
  'Dica: use frase curta e símbolos, ex: Sol&Chuva=Outono9',
  'Dica: inicie com maiúscula, inclua hífen e @, ex: Plano-B@2025',
  'Dica: troque letras por símbolos, ex: P@oDeQue!jo12',
  'Dica: junte hobby + ano + símbolo, ex: Surf2024#Vibe'
];
const dicaEl = qs('dica-senha');
function randTip(){ return dicas[Math.floor(Math.random()*dicas.length)]; }
function showNewTip(){ if (dicaEl) dicaEl.textContent = randTip(); }
showNewTip();
qs('btn-sugestao')?.addEventListener('click', showNewTip);

function generatePassword(len=12){
  const lowers='abcdefghijkmnopqrstuvwxyz';
  const uppers='ABCDEFGHJKLMNPQRSTUVWXYZ';
  const nums='23456789';
  const syms='!@#$%^&*_-+=?';
  const all = lowers+uppers+nums+syms;
  let out = [
    lowers[Math.floor(Math.random()*lowers.length)],
    uppers[Math.floor(Math.random()*uppers.length)],
    nums[Math.floor(Math.random()*nums.length)],
    syms[Math.floor(Math.random()*syms.length)]
  ];
  while(out.length < len) out.push(all[Math.floor(Math.random()*all.length)]);
  out = out.sort(()=>Math.random()-0.5).join('');
  return out;
}
qs('gen-pass')?.addEventListener('click', ()=>{
  if (!senha) return;
  const p = generatePassword(12);
  senha.value = p;
  validateField('senha');
  if (confirma){ confirma.value = ''; validateField('conf'); }
});

// Mostrar/ocultar senha
qs('toggle-pass')?.addEventListener('click', () => {
  if (!senha) return;
  const btn = qs('toggle-pass');
  const showing = senha.type === 'text';
  senha.type = showing ? 'password' : 'text';
  if (btn) btn.textContent = showing ? 'Mostrar' : 'Ocultar';
});

/* ===== AVATAR: upload + presets ===== */
function fileToDataURL(file){ return new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(file); }); }
function scaleToFit(w, h, maxSide) { if (w <= maxSide && h <= maxSide) return { width: w, height: h }; const r = w > h ? maxSide / w : maxSide / h; return { width: Math.round(w*r), height: Math.round(h*r) }; }
async function compressImageFileToDataURL(file, maxSide=512, quality=0.9){
  const src = await fileToDataURL(file);
  const img = document.createElement('img');
  return new Promise((resolve, reject) => {
    img.onload = () => {
      const { width, height } = scaleToFit(img.naturalWidth, img.naturalHeight, maxSide);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,width,height);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,width,height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/webp', quality));
    };
    img.onerror = reject;
    img.src = src;
  });
}

// presets por iniciais
const PALETTES = [["#22c55e","#0ea5a3"],["#3b82f6","#6366f1"],["#f97316","#f59e0b"],["#06b6d4","#0ea5e9"],["#8b5cf6","#d946ef"],["#ef4444","#f59e0b"],["#0ea5a3","#14b8a6"],["#64748b","#334155"],["#16a34a","#065f46"],["#2563eb","#1e3a8a"],["#f43f5e","#a21caf"],["#f59e0b","#92400e"]];
function getInitials(fullname){
  const s = String(fullname || '').trim();
  if (!s) return 'AA';
  const norm = s.normalize('NFD').replace(/\p{M}/gu, '');
  const parts = norm.split(/\s+/).filter(Boolean);
  const ignore = new Set(['da','de','do','das','dos','e','di','du']);
  const words = parts.filter(w => !ignore.has(w.toLowerCase()));
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  const first = words[0] || parts[0];
  return (first.slice(0,2)).toUpperCase();
}
function initialsAvatarDataURL(initials, c1, c2){
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><defs><linearGradient id='bg' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='${c1}'/><stop offset='100%' stop-color='${c2}'/></linearGradient></defs><rect width='100%' height='100%' rx='64' ry='64' fill='url(#bg)'/><text x='50%' y='56%' text-anchor='middle' font-family='Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial' font-size='96' font-weight='700' fill='white' letter-spacing='2'>${initials}</text></svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}
function buildInitialPresets(name){ const initials = getInitials(name); return PALETTES.map(([a,b]) => initialsAvatarDataURL(initials, a, b)); }

// elementos
const avatarTrigger     = qs('avatar-trigger');
const avatarPlaceholder = qs('avatar-placeholder');
const avatarPreview     = qs('avatar-preview');
const avatarCta         = qs('avatar-cta');
const avatarRing        = qs('avatar-ring');
const avatarFile        = qs('avatar-file');
const avatarUrlOut      = qs('avatar_url');
const avatarStatus      = qs('avatar-status');
const avatarErro        = qs('avatar-erro');
const nomeAdmInput      = qs('nome_adm');

// estado inicial
if (avatarPreview) avatarPreview.classList.add('hidden');
if (avatarPlaceholder) avatarPlaceholder.classList.remove('hidden');
if (avatarUrlOut) avatarUrlOut.value = '';

// click abre file picker
avatarTrigger?.addEventListener('click', () => avatarFile?.click());

// drag & drop
['dragover','dragenter'].forEach(evt => {
  avatarTrigger?.addEventListener(evt, e => { e.preventDefault(); avatarTrigger.classList.add('border-green-400'); });
});
['dragleave','drop'].forEach(evt => {
  avatarTrigger?.addEventListener(evt, e => { e.preventDefault(); avatarTrigger.classList.remove('border-green-400'); });
});
avatarTrigger?.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (!f || !avatarFile) return;
  avatarFile.files = e.dataTransfer.files;
  avatarFile.dispatchEvent(new Event('change'));
});

// on change -> valida e comprime
avatarFile?.addEventListener('change', async () => {
  if (!avatarFile || !avatarPreview || !avatarPlaceholder || !avatarTrigger || !avatarRing || !avatarCta || !avatarStatus || !avatarUrlOut || !avatarErro) return;
  avatarErro.classList.add('hidden');
  const file = avatarFile.files?.[0]; if (!file) return;
  const valid = ['image/jpeg','image/png','image/webp','image/jpg'];
  const maxBytes = 4 * 1024 * 1024;
  if (!valid.includes(file.type)) { avatarErro.textContent = 'Use JPG, PNG ou WEBP.'; avatarErro.classList.remove('hidden'); avatarFile.value=''; return; }
  if (file.size > maxBytes) { avatarErro.textContent = 'Imagem muito grande. Tente outra até 4MB.'; avatarErro.classList.remove('hidden'); avatarFile.value=''; return; }
  try{
    const dataUrl = await compressImageFileToDataURL(file, 512, 0.9);
    avatarPreview.src = dataUrl;
    avatarPreview.classList.remove('hidden');
    avatarPlaceholder.classList.add('hidden');
    avatarTrigger.classList.add('border-green-500','ring-2','ring-green-500','border-solid');
    avatarRing.classList.remove('hidden');
    avatarCta.textContent = 'Trocar foto';
    avatarStatus.classList.remove('hidden');
    avatarUrlOut.value = dataUrl;
  }catch(e){
    avatarErro.textContent = 'Falha ao processar a imagem. Tente outra.';
    avatarErro.classList.remove('hidden');
  }
});

// modal presets
const modal     = qs('avatar-modal');
const backdrop  = qs('avatar-backdrop');
const btnOpen   = qs('btn-open-avatars');
const btnClose  = qs('avatar-close');
const btnCancel = qs('avatar-cancel');
const btnApply  = qs('avatar-apply');
const presetGrid= qs('preset-grid');
let selectedTmp = null; let modalOpen = false;

function buildAndRenderPresets(){
  if (!presetGrid) return;
  const name = (nomeAdmInput?.value || '').trim() || 'Usuário Admin';
  const PRESETS = buildInitialPresets(name);
  presetGrid.innerHTML=''; selectedTmp=null; if (btnApply) btnApply.disabled = true;
  PRESETS.forEach((src) => {
    const item = document.createElement('button');
    item.type='button';
    item.className='relative';
    item.innerHTML = `<img src="${src}" class="h-16 w-16 rounded-full object-cover border hover:ring-2 hover:ring-green-400 transition">`;
    item.addEventListener('click', () => {
      [...presetGrid.children].forEach(c => c.firstElementChild?.classList.remove('ring-2','ring-green-500'));
      item.firstElementChild.classList.add('ring-2','ring-green-500');
      selectedTmp = src; if (btnApply) btnApply.disabled = false;
    });
    presetGrid.appendChild(item);
  });
}
function openModal(){ if (!modal) return; buildAndRenderPresets(); modal.classList.remove('hidden'); modalOpen=true; document.addEventListener('keydown', onEsc); }
function closeModal(){ if (!modal) return; modal.classList.add('hidden'); modalOpen=false; document.removeEventListener('keydown', onEsc); }
function onEsc(e){ if (e.key === 'Escape') closeModal(); }

btnOpen   ?.addEventListener('click', openModal);
btnClose  ?.addEventListener('click', closeModal);
btnCancel ?.addEventListener('click', closeModal);
backdrop  ?.addEventListener('click', closeModal);
nomeAdmInput?.addEventListener('input', () => { if (modalOpen) buildAndRenderPresets(); });

btnApply?.addEventListener('click', () => {
  if (!selectedTmp || !avatarPreview || !avatarPlaceholder || !avatarTrigger || !avatarRing || !avatarCta || !avatarStatus || !avatarUrlOut || !avatarFile) return;
  avatarPreview.src = selectedTmp;
  avatarPreview.classList.remove('hidden');
  avatarPlaceholder.classList.add('hidden');
  avatarTrigger.classList.add('border-green-500','ring-2','ring-green-500','border-solid');
  avatarRing.classList.remove('hidden');
  avatarCta.textContent = 'Trocar avatar';
  avatarStatus.classList.remove('hidden');
  avatarUrlOut.value = selectedTmp;
  avatarFile.value = '';
  closeModal();
});

/* ===== Submit ===== */
const btn = document.getElementById('btn-submit');
const form = document.getElementById('form-register');

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideToast();

  // valida tudo
  validateField('doc'); validateField('nome'); validateField('nomeadm');
  validateField('tel'); validateField('email'); validateField('senha'); validateField('conf');

  const anyErr = document.querySelector('.field-err');
  if (anyErr){
    showToast('Preencha todos os campos para continuar.', 'warn');
    const firstErrInput = anyErr.querySelector('input,select,textarea');
    if (firstErrInput) firstErrInput.focus();
    return;
  }

  // documento inválido → confirma
  const d = onlyDigits(docInput?.value);
  const docErr = vDoc();
  if (d && (d.length===11 || d.length===14) && docErr){
    const tipo = (d.length===11) ? 'CPF' : 'CNPJ';
    const pretty = docInput?.value;
    const proceed = await confirmModal(`${tipo} informado não parece válido (${pretty}).\n\nTem certeza que deseja cadastrar assim mesmo?`);
    if (!proceed) return;
    setErr('wrap-doc','err-doc','');
  } else if (!d || (d.length!==11 && d.length!==14)){
    showToast('Documento incompleto. Verifique o CPF/CNPJ.', 'warn');
    docInput?.focus();
    return;
  }

  const stillErr = Array.from(document.querySelectorAll('.field-err'))
    .some(w => !w.id || (w.id && w.id !== 'wrap-doc'));
  if (stillErr) return;

  const f = e.target;
  const payload = {
    doc: onlyDigits(f.doc.value),
    nome: f.nome.value.trim(),
    telefone: onlyDigits(f.telefone.value),
    email_admin: f.email_admin.value.trim(),
    senha_admin: f.senha_admin.value,
    nome_adm: (f.nome_adm?.value || '').trim(),
    avatar_url: (document.getElementById('avatar_url')?.value || null)
  };

  const original = btn?.textContent;
  if (btn){ btn.disabled = true; btn.classList.add('cursor-wait'); btn.textContent = 'Cadastrando...'; }

  try {
    const res = await fetch(CREATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });

    const text = await res.text(); 
    let data = null; try { data = JSON.parse(text); } catch {}

    if (!res.ok) {
      if (res.status === 404){
        showToast('Não conseguimos concluir agora. Verifique se o servidor está disponível e tente novamente.', 'error');
      } else if (res.status >= 500){
        showToast('Estamos com instabilidade no momento. Tente novamente em instantes.', 'error');
      } else if (res.status === 400 || res.status === 422){
        const msg = (data && (data.detail || data.message)) || 'Dados inválidos. Revise as informações do formulário.';
        showToast(msg, 'warn');
      } else {
        const msg = (data && (data.detail || data.message)) || 'Não foi possível concluir o cadastro.';
        showToast(msg, 'error');
      }
      return;
    }

    // Tenta pegar token direto da resposta de criação
    const token = data?.access_token || data?.token;
    const empresa_id = data?.empresa_id || data?.empresaId || data?.company_id;

    if (token) {
      showToast('Empresa criada com sucesso! Entrando…', 'ok');
      // PATCH: passar nome/email/avatar para já preencher o chip
      setAuthAndGo({
        token,
        empresa_id,
        nome:  data?.nome_adm || payload.nome_adm || data?.nome || data?.name,
        email: data?.email_admin || payload.email_admin || data?.email,
        avatar_url: data?.avatar_url || payload.avatar_url
      });
      return;
    }

    // Se a API de criação não retorna token, faz login automático
    showToast('Empresa criada com sucesso! Entrando…', 'ok');
    await doLogin(payload.email_admin, payload.senha_admin); // redireciona em setAuthAndGo
  } catch (err) {
    console.error(err);
    showToast('Falha de conexão. Verifique sua internet ou o servidor e tente novamente.', 'error');
  } finally {
    if (btn){ btn.disabled = false; btn.classList.remove('cursor-wait'); btn.textContent = original || 'Cadastrar'; }
  }
});

/* ===== Anti-DevTools (best-effort) ===== */
(function(){
  const MSG = 'Ação bloqueada por segurança. Inspecionar/desenvolvedor não é permitido.';
  const warn = () => { try { showToast(MSG, 'warn'); } catch { alert(MSG); } };
  document.addEventListener('contextmenu', (e) => { e.preventDefault(); warn(); }, { capture: true });
  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const alt  = e.altKey;
    const shift= e.shiftKey;
    if (k === 'f12') { e.preventDefault(); e.stopPropagation(); warn(); return; }
    if ((ctrl && shift && ['i','j','c','k'].includes(k)) || (e.metaKey && alt && k === 'i')) { e.preventDefault(); e.stopPropagation(); warn(); return; }
    if (ctrl && ['u','s','p'].includes(k)) { e.preventDefault(); e.stopPropagation(); warn(); return; }
  }, { capture: true });
  let lastWarn = 0;
  setInterval(() => {
    const vwGap = Math.abs((window.outerWidth  || 0) - (window.innerWidth  || 0));
    const vhGap = Math.abs((window.outerHeight || 0) - (window.innerHeight || 0));
    const suspicious = vwGap > 160 || vhGap > 160;
    const now = Date.now();
    if (suspicious && now - lastWarn > 4000) { lastWarn = now; warn(); }
  }, 1200);
})();
