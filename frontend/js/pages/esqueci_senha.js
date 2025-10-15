// ===== Tema (idêntico ao login; com animação t-anim) =====
(() => {
  const html = document.documentElement;

  function apply(mode) {
    const dark = mode === 'dark';
    html.classList.toggle('dark', dark);
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch {}
    const btn = document.getElementById('themeSwitch');
    if (btn) btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }

  // Estado inicial (saved ou prefers-color-scheme)
  (function initEarly(){
    try{
      let saved = localStorage.getItem('theme');
      if (!saved) {
        saved = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
      }
      apply(saved === 'dark' ? 'dark' : 'light');
    }catch{}
  })();

  function wire(){
    const btn = document.getElementById('themeSwitch');
    if (!btn) return;
    btn.setAttribute('aria-pressed', html.classList.contains('dark') ? 'true' : 'false');
    btn.addEventListener('click', () => {
      // animação do brilho
      btn.classList.remove('t-anim'); void btn.offsetWidth; btn.classList.add('t-anim');
      setTimeout(() => btn.classList.remove('t-anim'), 580);

      const next = html.classList.contains('dark') ? 'light' : 'dark';
      apply(next);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  // Sync entre abas
  window.addEventListener('storage', (e) => {
    if (e.key === 'theme') {
      const v = (e.newValue || '').toLowerCase();
      apply(v === 'dark' ? 'dark' : 'light');
    }
  });
})();

/* ================= Toast ================= */
const toast = document.getElementById('toast');
function showToast(msg, variant='error'){
  const styles = {
    error:'border-red-300 bg-red-50 text-red-800 dark:bg-red-900/25 dark:border-red-800 dark:text-red-200',
    warn :'border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:border-amber-800 dark:text-amber-200',
    ok   :'border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-900/25 dark:border-emerald-800 dark:text-emerald-200'
  };
  toast.className = 'mb-4 rounded-lg border px-4 py-3 text-sm ' + (styles[variant]||styles.error);
  toast.textContent = msg; toast.classList.remove('hidden');
}
function hideToast(){ toast.classList.add('hidden'); toast.textContent=''; }

/* ============== Modal ============== */
const modal = (function(){
  const overlay   = document.getElementById('notifyModal');
  const titleEl   = document.getElementById('notify-title');
  const bodyEl    = document.getElementById('notify-body');
  const okBtn     = document.getElementById('notify-ok');
  const cancelBtn = document.getElementById('notify-cancel');
  const iconEl    = document.getElementById('notify-icon');

  let lastFocus = null;
  let okHandler = null;

  const icons = {
    ok:   '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>',
    warn: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>',
    error:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>'
  };

  function open({title='Notificação', message='', variant='ok', okText='Ok', cancelText='Fechar', onOk=null}={}){
    lastFocus = document.activeElement;
    if (titleEl) titleEl.textContent = title;
    if (bodyEl)  bodyEl.innerHTML = message;
    if (iconEl)  iconEl.innerHTML = icons[variant] || icons.ok;
    if (okBtn)   okBtn.textContent = okText;
    if (cancelBtn) cancelBtn.textContent = cancelText;
    okHandler = onOk;

    if (overlay){
      overlay.dataset.open = 'true';
      setTimeout(()=> okBtn?.focus(), 0);
      window.addEventListener('keydown', onKey);
      overlay.addEventListener('keydown', trap);
    }
  }

  function close(){
    if (overlay) overlay.dataset.open = 'false';
    window.removeEventListener('keydown', onKey);
    overlay?.removeEventListener('keydown', trap);
    if (lastFocus && lastFocus.focus) setTimeout(()=> lastFocus.focus(), 0);
  }

  function onKey(e){ if (e.key === 'Escape'){ e.preventDefault(); close(); } }
  function trap(e){
    if (e.key !== 'Tab') return;
    const focusables = overlay.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
    const list = Array.from(focusables).filter(el => !el.hasAttribute('disabled'));
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first){ last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last){ first.focus(); e.preventDefault(); }
  }

  okBtn?.addEventListener('click', ()=>{ const cb = okHandler; okHandler = null; close(); if (typeof cb === 'function') cb(); });
  cancelBtn?.addEventListener('click', ()=> close());
  overlay?.addEventListener('click', (e)=>{ if (e.target === overlay) close(); });

  return { open, close };
})();

/* ===== Helpers de progresso ===== */
function setBtnProg(btn,pct){ btn.style.setProperty('--prog',Math.max(0,Math.min(100,pct))+'%'); }
function startProgress(btn){
  let pct=0, t0=performance.now(), raf=0;
  const tick=(now)=>{
    const dt=(now-t0)/1000;
    const target=Math.min(0.98, dt/6.0);
    const wobble=0.012*Math.sin(now/500);
    pct=Math.max(pct,Math.min(0.985,target+wobble));
    setBtnProg(btn,Math.floor(pct*100));
    raf=requestAnimationFrame(tick);
  };
  raf=requestAnimationFrame(tick);
  return ()=>cancelAnimationFrame(raf);
}
function finishProgress(btn){ setBtnProg(btn,100); setTimeout(()=>setBtnProg(btn,0),900); }
const minDelay=(ms)=>new Promise(r=>setTimeout(r,ms));

/* ===== Limite local ===== */
const LS_KEY = (email)=>`fp:tries:${(email||'').toLowerCase()}`;
function getTries(email){
  try{ const raw=localStorage.getItem(LS_KEY(email)); if(!raw) return {n:0,ts:Date.now()};
    const obj=JSON.parse(raw); return {n:obj.n|0, ts:obj.ts|0}; }catch{ return {n:0,ts:Date.now()}; }
}
function setTries(email,n){ try{ localStorage.setItem(LS_KEY(email), JSON.stringify({n,ts:Date.now()})); }catch{} }
function incTries(email){ const t=getTries(email); setTries(email, t.n+1); return t.n+1; }
function resetTries(email){ try{ localStorage.removeItem(LS_KEY(email)); }catch{} }

/* ===== PASSO 1 ===== */
const formForgot = document.getElementById('form-forgot');
const btnForgot  = document.getElementById('btn-forgot');
const btnText    = btnForgot.querySelector('.btn-text');
const emailInput = document.getElementById('email');

formForgot.addEventListener('submit', async (e)=>{
  e.preventDefault(); hideToast();
  const email=(emailInput.value||'').trim().toLowerCase();
  if(!email){ modal.open({title:'Atenção', message:'Informe um e-mail válido.', variant:'warn'}); return; }

  if(incTries(email) > 5){
    modal.open({title:'Muitas tentativas', message:'Tente novamente mais tarde.', variant:'warn'});
    return;
  }

  btnForgot.disabled=true;
  const oldText=btnText.textContent; btnText.textContent='Enviando…';
  const stop = startProgress(btnForgot);

  try{
    const res = await fetch('/api/auth/forgot-password',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email})
    });

    await minDelay(1200);

    if(res.status===429){
      stop(); finishProgress(btnForgot); await minDelay(600);
      modal.open({title:'Muitas tentativas', message:'Tente novamente mais tarde.', variant:'warn'});
      return;
    }
    if(res.status===404){
      stop(); finishProgress(btnForgot); await minDelay(600);
      modal.open({title:'E-mail não cadastrado', message:'Confira o endereço e tente novamente.', variant:'error'});
      return;
    }
    if(!res.ok){
      stop(); finishProgress(btnForgot); await minDelay(600);
      let msg='Não foi possível enviar agora.'; try{ const j=await res.json(); msg=j.detail||msg; }catch{}
      modal.open({title:'Erro', message:msg, variant:'error'});
      return;
    }

    stop(); finishProgress(btnForgot); await minDelay(400);
    modal.open({
      title:'Verifique seu e-mail',
      message:'Se o endereço existir, enviamos o <b>token</b> agora. Confira Caixa de Entrada, Spam e Promoções.',
      variant:'ok',
      okText:'Continuar',
      onOk:()=>{
        document.getElementById('reset-section').classList.remove('hidden');
        document.getElementById('token').focus();
      }
    });

  }catch{
    stop(); setBtnProg(btnForgot,0);
    modal.open({title:'Conexão falhou', message:'Tente novamente em instantes.', variant:'error'});
  }finally{
    btnForgot.disabled=false; btnText.textContent=oldText;
  }
});

/* ===== PASSO 2 ===== */
const formReset = document.getElementById('form-reset');
const btnReset  = document.getElementById('btn-reset');
const inputPass = document.getElementById('nova_senha');
const inputTok  = document.getElementById('token');

// Toggle olho
(function(){
  const btn = document.getElementById('toggle-pass');
  const eyeOpen = document.getElementById('eye-open');
  const eyeOff  = document.getElementById('eye-off');
  function sync(){
    const isPassword = inputPass.type === 'password';
    eyeOpen?.classList.toggle('hidden', !isPassword);
    eyeOff ?.classList.toggle('hidden',  isPassword);
    btn?.setAttribute('aria-label', isPassword ? 'Mostrar senha' : 'Ocultar senha');
  }
  btn?.addEventListener('click', ()=>{ inputPass.type = inputPass.type === 'password' ? 'text' : 'password'; sync(); });
  sync();
})();

// Pré-preenche token via URL
(function(){
  try{
    const u=new URL(location.href); const t=u.searchParams.get('token');
    if(t){ document.getElementById('reset-section').classList.remove('hidden'); inputTok.value=t; inputPass.focus(); }
  }catch{}
})();

formReset.addEventListener('submit', async (e)=>{
  e.preventDefault(); hideToast();
  const token=inputTok.value.trim(), nova_senha=inputPass.value.trim();
  if (!token || !nova_senha){
    modal.open({title:'Campos obrigatórios', message:'Preencha token e nova senha.', variant:'warn'}); return;
  }
  if (nova_senha.length < 8){
    modal.open({title:'Senha fraca', message:'A senha precisa ter pelo menos 8 caracteres.', variant:'warn'}); return;
  }

  btnReset.disabled=true; const t=btnReset.querySelector('.btn-text')||btnReset; const old=t.textContent; t.textContent='Atualizando…';
  try{
    const res=await fetch('/api/auth/reset-password',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token,nova_senha})
    });
    if(!res.ok){
      let msg='Não foi possível redefinir a senha.'; try{const j=await res.json(); msg=j.detail||msg;}catch{}
      modal.open({title:'Erro', message:msg, variant:'error'}); return;
    }
    resetTries((emailInput.value||'').trim().toLowerCase());
    modal.open({
      title:'Tudo certo!',
      message:'Senha redefinida com sucesso. Você já pode entrar.',
      variant:'ok',
      okText:'Ir para login',
      onOk:()=>{ window.location.href='/login'; }
    });
  }catch{
    modal.open({title:'Conexão falhou', message:'Tente novamente.', variant:'error'});
  }finally{
    btnReset.disabled=false; t.textContent=old;
  }
});
