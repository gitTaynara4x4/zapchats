// /frontend/js/atendimentos/ui/perfil.js
// Drawer “Campos do cliente” com máscaras, CEP (BrasilAPI), toasts,
// banner com borda roxa e ícone SVG (sem emoji), layout em coluna,
// pares compactos (CEP+UF, Número+Complemento, Data+Gênero),
// UF/CEP/Data menores e limites de caracteres.

/* ----------------- helpers ----------------- */
const $  = (s, r=document)=> r.querySelector(s);
const on = (el, ev, fn)=> el && el.addEventListener(ev, fn);
function getClienteId(){ return Number($('#historico')?.dataset?.clienteId || 0); }
const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);

function getTheme(){
  try{ const t = document.documentElement.getAttribute('data-theme'); if (t) return t; }catch{}
  try{ return (matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; }catch{}
  return 'dark';
}

/* Ícone do botão (24px) */
function iconSvg(theme){
  const fill = theme === 'light' ? '#080808' : '#ffffff';
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"
         class="perfil-ico" fill="${fill}" viewBox="0 0 256 256" aria-hidden="true">
      <path d="M154,80a6,6,0,0,1,6-6h88a6,6,0,0,1,0,12H160A6,6,0,0,1,154,80Zm94,42H160a6,6,0,0,0,0,12h88a6,6,0,0,0,0-12Zm0,48H184a6,6,0,0,0,0,12h64a6,6,0,0,0,0-12Zm-98.19,20.5a6,6,0,1,1-11.62,3C131.7,168.29,107.23,150,80,150s-51.7,18.29-58.19,43.49a6,6,0,1,1-11.62-3c5.74-22.28,23-40.07,44.67-48a46,46,0,1,1,50.28,0C126.79,150.43,144.08,168.22,149.81,190.5ZM80,138a34,34,0,1,0-34-34A34,34,0,0,0,80,138Z"></path>
    </svg>
  `;
}

/* Ícone do banner (SVG pedido) – adapta a cor pelo tema */
function bannerSvg(theme){
  const fill = theme === 'light' ? '#080808' : '#ffffff';
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="${fill}" viewBox="0 0 256 256" aria-hidden="true">
      <path d="M222,114.56a54,54,0,0,0-58.67-74.73,54,54,0,0,0-94,13.46A54,54,0,0,0,34,141.44a54,54,0,0,0,35.56,73.65A54.54,54.54,0,0,0,83.59,217a52.86,52.86,0,0,0,9.06-.78,54,54,0,0,0,94-13.46A54,54,0,0,0,222,114.56ZM183.37,52.5a42,42,0,0,1,29.21,53.14,54.84,54.84,0,0,0-5.08-3.33L163,76.62a6,6,0,0,0-6,0l-47,27.13V80.66l41.5-24A41.73,41.73,0,0,1,183.37,52.5ZM146,138.39l-18,10.39-18-10.39V117.61l18-10.39,18,10.39ZM78,72a42,42,0,0,1,72.92-28.43,56.18,56.18,0,0,0-5.42,2.74L101,72a6,6,0,0,0-3,5.19v54.27L78,119.92ZM39.13,85.93a41.75,41.75,0,0,1,27.22-20A55.09,55.09,0,0,0,66,72v51.38a6,6,0,0,0,3,5.2l47,27.13L96,167.26l-41.5-24A42,42,0,0,1,39.13,85.93ZM72.63,203.5a42,42,0,0,1-29.21-53.14,54.84,54.84,0,0,0,5.08,3.33L93,179.38a6,6,0,0,0,6,0l47-27.13v23.09l-41.5,24A41.73,41.73,0,0,1,72.63,203.5ZM178,184a42,42,0,0,1-72.92,28.43,56.18,56.18,0,0,0,5.42-2.74L155,184a6,6,0,0,0,3-5.19V124.54l20,11.54Zm38.87-13.93a41.75,41.75,0,0,1-27.22,20A55.09,55.09,0,0,0,190,184V132.62a6,6,0,0,0-3-5.2l-47-27.13,20-11.55,41.5,24A42,42,0,0,1,216.87,170.07Z"></path>
    </svg>
  `;
}

/* ----------------- CSS (idempotente) ----------------- */
(function injectCSS(){
  if (document.getElementById('zcPerfil-style')) return;
  const st = document.createElement('style');
  st.id = 'zcPerfil-style';
  st.textContent = `
    /* Botão no header */
    #btn-perfil{
      display:inline-grid; place-items:center; width:24px; height:24px;
      line-height:0; padding:0; margin-left:6px; background:transparent; border:0;
      border-radius:8px; cursor:pointer; transition:background .15s, transform .08s; color:inherit;
    }
    #btn-perfil:hover{ background:rgba(255,255,255,.06); }
    html[data-theme="light"] #btn-perfil:hover{ background:rgba(0,0,0,.06); }
    #btn-perfil:active{ transform:translateY(1px); }
    #btn-perfil .perfil-ico{ width:24px; height:24px; transform:translateY(1px); filter:drop-shadow(0 0 5px rgba(168,85,247,.5)); }

    /* Drawer fallback */
    .zcPerfil-backdrop{ position:fixed; inset:0; background:rgba(0,0,0,.42); opacity:0; pointer-events:none; transition:opacity .18s; z-index:9998; }
    .zcPerfil-backdrop.is-open{ opacity:1; pointer-events:auto; }
    .zcPerfil-drawer{
      position:fixed; top:0; right:0; height:100vh; width:min(480px,94vw);
      background:var(--panel-2,#1f2c33); color:var(--text,#e9edef);
      border-left:1px solid var(--border,#26343a);
      transform:translateX(100%); transition:transform .18s ease; z-index:9999;
      display:flex; flex-direction:column; pointer-events:none; box-sizing:border-box; overflow:hidden;
    }
    .zcPerfil-drawer.is-open{ transform:translateX(0); pointer-events:auto; }
    .zcPerfil-head{ display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--border,#26343a); }
    .zcPerfil-title{ font-weight:600; font-size:16px; display:flex; align-items:center; gap:8px; }
    .zcPerfil-close{ background:transparent; border:0; color:#aebac1; cursor:pointer; padding:6px; border-radius:8px; }
    .zcPerfil-close:hover{ color:#fff; background:#233238; }
    .zcPerfil-body{ flex:1; display:flex; flex-direction:column; gap:12px; padding:16px; overflow:auto; box-sizing:border-box; }

    /* AVISO fino – borda roxa MUITO fina + borda esquerda verde */
    .zcPerfil-banner{
      font-size:12.5px; line-height:1.35; color:var(--text-2,#aebac1);
      display:flex; gap:8px; align-items:flex-start;
      border-left:2px solid var(--accent,#25d366);
      border:1px solid rgba(168,85,247,.38);
      padding:8px 10px; border-radius:10px;
      background:color-mix(in oklab, var(--panel-2,#1f2c33) 88%, transparent);
    }
    .zcPerfil-banner .b-ico{ flex:0 0 auto; display:grid; place-items:center; transform:translateY(1px) }
    .zcPerfil-banner .b-msg{ font-weight:500 }
    .zcPerfil-banner .b-tip{ margin-top:4px; font-size:12px; opacity:.95 }

    /* Layout em coluna + linhas compactas para pares */
    .zcPerfil-stack{ display:flex; flex-direction:column; gap:10px; }
    .zcPerfil-row{ display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; }

    .zcPerfil-field{ display:flex; flex-direction:column; gap:6px; min-width:0; }
    .zcPerfil-field label{ font-size:12px; color:var(--text-2,#aebac1); }

    .zcPerfil-field input,
    .zcPerfil-field select{
      width:100%; box-sizing:border-box; background:var(--input-bg,#0b141a);
      color:var(--text,#e9edef); border:1px solid var(--border,#2a3942);
      border-radius:10px; padding:10px 12px; outline:none;
      transition:border-color .14s, box-shadow .14s;
    }
    html[data-theme="light"] .zcPerfil-field input,
    html[data-theme="light"] .zcPerfil-field select{
      background:#ffffff; color:#080808;
    }
    .zcPerfil-field input:focus, .zcPerfil-field select:focus{
      border-color:var(--accent,#25d366);
      box-shadow:0 0 0 2px color-mix(in oklab, var(--accent,#25d366) 25%, transparent);
    }
    .zcPerfil-field input.is-invalid{
      border-color:#ef4444 !important;
      box-shadow:0 0 0 2px color-mix(in oklab, #ef4444 25%, transparent);
    }

    /* ---- Selects compactos + seta centralizada ---- */
    .zcPerfil-selectWrap{ position:relative; }
    .zcPerfil-selectWrap select{
      appearance:none; -webkit-appearance:none; -moz-appearance:none;
      height:36px; line-height:20px;
      padding:8px 28px 8px 12px;      /* espaço p/ seta */
      text-transform:none;
      color-scheme: dark;             /* menu legível no dark */
    }
    html[data-theme="light"] .zcPerfil-selectWrap select{ color-scheme: light; }
    .zcPerfil-selectWrap::after{
      content:""; position:absolute; right:10px; top:50%; transform:translateY(-50%);
      pointer-events:none;
      width:0; height:0; border-left:5px solid transparent; border-right:5px solid transparent;
      border-top:6px solid #aebac1;
    }
    .zcPerfil-selectWrap select option{ background:#0b141a; color:#e9edef; }
    html[data-theme="light"] .zcPerfil-selectWrap select option{ background:#ffffff; color:#080808; }

    /* Larguras compactas */
    .field--cep{ width:160px; }
    .field--uf{ width:84px; min-width:72px; }
    .field--numero{ width:120px; }
    .field--complemento{ flex:1 1 220px; }
    .field--dob{ width:160px; min-width:140px; } /* Data de nascimento */
    .field--genero{ flex:1 1 180px; }

    .zcPerfil-actions{ display:flex; gap:10px; margin-top:6px; }
    .zcPerfil-btnPrimary{ flex:1; background:#25d366; border:1px solid #1fb05a; color:#061a0e; padding:10px 12px; border-radius:10px; cursor:pointer; font-weight:600; }
    .zcPerfil-btnPrimary:hover{ filter:brightness(1.05); }
    .zcPerfil-btnGhost{ flex:1; background:transparent; border:1px solid var(--border,#2a3942); color:var(--text,#e9edef); padding:10px 12px; border-radius:10px; cursor:pointer; }
    .zcPerfil-btnGhost:hover{ background:color-mix(in oklab, var(--panel-2,#1f2c33) 85%, transparent); }
    @media (max-width:520px){ .zcPerfil-actions{ flex-direction:column; } }

    /* Toasts */
    .zcToastHost{ position:fixed; right:14px; bottom:14px; z-index:10000; display:flex; flex-direction:column; gap:8px; }
    .zcToast{
      display:flex; align-items:flex-start; gap:10px;
      background:#0b141a; color:#e9edef; border:1px solid #2a3942; border-left-width:3px;
      border-radius:12px; padding:10px 12px; max-width:min(86vw,420px); box-shadow:0 6px 28px rgba(0,0,0,.35);
      animation:zc-toast-in .18s ease;
    }
    html[data-theme="light"] .zcToast{ background:#fff; color:#080808; border-color:#dadde0; }
    .zcToast.ok{ border-left-color:#22c55e }
    .zcToast.err{ border-left-color:#ef4444 }
    .zcToast .t-title{ font-weight:600; font-size:13px }
    .zcToast .t-msg{ font-size:12.5px; color:#aebac1 }
    html[data-theme="light"] .zcToast .t-msg{ color:#4b5563 }
    .zcToast .t-close{ margin-left:auto; color:#99aab3; background:transparent; border:0; cursor:pointer }
    @keyframes zc-toast-in{ from{ transform:translateY(6px); opacity:0 } to{ transform:translateY(0); opacity:1 } }
  `;
  document.head.appendChild(st);
})();

/* ----------------- Toasts ----------------- */
function ensureToastHost(){
  let h = document.getElementById('zcToastHost');
  if (!h){ h = document.createElement('div'); h.id='zcToastHost'; h.className='zcToastHost'; document.body.appendChild(h); }
  return h;
}
function toast({ title='Pronto', msg='', type='ok', timeout=2800 }){
  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = `zcToast ${type==='error'?'err':'ok'}`;
  el.innerHTML = `
    <div>
      <div class="t-title">${title}</div>
      ${msg?`<div class="t-msg">${msg}</div>`:''}
    </div>
    <button class="t-close" aria-label="Fechar"><i class="fa-solid fa-xmark"></i></button>
  `;
  host.appendChild(el);
  el.querySelector('.t-close')?.addEventListener('click', ()=> el.remove());
  if (timeout) setTimeout(()=> el.remove(), timeout);
}

/* ----------------- MÁSCARAS / validações ----------------- */
const UF_LIST = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];
const UF_SET = new Set(UF_LIST);

const onlyDigits = s => (s||"").replace(/\D+/g,'');
const keepRGChars = s => (s||"").replace(/[^0-9xX]/g,'').toUpperCase();

/* CPF/CNPJ/RG/CEP/CIDADE/UF já existiam */
function fmtCPF(d){ d=onlyDigits(d).slice(0,11);
  return d.replace(/^(\d{3})(\d)/,"$1.$2")
          .replace(/^(\d{3})\.(\d{3})(\d)/,"$1.$2.$3")
          .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/,"$1.$2.$3-$4"); }
function fmtCNPJ(d){ d=onlyDigits(d).slice(0,14);
  return d.replace(/^(\d{2})(\d)/,"$1.$2")
          .replace(/^(\d{2})\.(\d{3})(\d)/,"$1.$2.$3")
          .replace(/^(\d{2})\.(\d{3})\.(\d{3})(\d)/,"$1.$2.$3/$4")
          .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})(\d)/,"$1.$2.$3/$4-$5"); }
function fmtCPForCNPJ(v){ const d=onlyDigits(v); return d.length<=11 ? fmtCPF(d) : fmtCNPJ(d); }
function fmtRG(v){ let s=keepRGChars(v).slice(0,10), body=s, dv=''; if(s.length===10){ body=s.slice(0,9); dv=s.slice(9); }
  body=body.replace(/^(\d{2})(\d)/,"$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/,"$1.$2.$3"); return dv ? `${body}-${dv}` : body; }
function fmtCEP(v){ let d=onlyDigits(v).slice(0,8); if(d.length>5) d=d.replace(/^(\d{5})(\d{1,3})$/,"$1-$2"); return d; }
function fmtNumero(v){ return onlyDigits(v).slice(0,8); }
function fmtComplemento(v){ return (v||"").replace(/[^0-9A-Za-zÀ-ÿ\s#\/\-\.\º°]/g,'').replace(/\s{2,}/g,' '); }
function fmtCidade(v){ return (v||"").replace(/[^A-Za-zÀ-ÿ\s\-']/g,'').replace(/\s{2,}/g,' '); }
function fmtUF(v){ return (v||"").replace(/[^A-Za-z]/g,'').toUpperCase().slice(0,2); }

/* Data de nascimento */
function fmtDataBR(v){
  const d = onlyDigits(v).slice(0,8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return d.replace(/^(\d{2})(\d{0,2})$/, "$1/$2");
  return d.replace(/^(\d{2})(\d{2})(\d{0,4}).*$/, "$1/$2/$3");
}
function isValidDataBR(v){
  const m = String(v||'').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return false;
  const dd = +m[1], mm = +m[2], yyyy = +m[3];
  if (yyyy < 1900) return false;
  if (mm < 1 || mm > 12) return false;
  const dt = new Date(yyyy, mm-1, dd);
  if (dt.getFullYear() !== yyyy || (dt.getMonth()+1) !== mm || dt.getDate() !== dd) return false;
  const now = new Date();
  if (dt.getTime() > now.getTime()) return false;
  return true;
}
function toISOFromDataBR(v){ // DD/MM/AAAA -> AAAA-MM-DD
  if (!isValidDataBR(v)) return '';
  const [dd,mm,yyyy] = v.split('/');
  return `${yyyy}-${mm}-${dd}`;
}
function toDataBRFromAny(x){
  if (!x) return '';
  const s = String(x);
  // ISO
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  // yyyymmdd
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  // já está BR?
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return s;
  return '';
}

function isValidEmail(v){ if(!v) return true; return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }
function isValidCEP(v){ return onlyDigits(v).length===8; }
function isValidCPF(d){
  d=onlyDigits(d); if(d.length!==11||/^(\d)\1+$/.test(d)) return false;
  let s=0; for(let i=0;i<9;i++) s+= +d[i]*(10-i);
  let dg=(s*10)%11; if(dg===10) dg=0; if(dg!== +d[9]) return false;
  s=0; for(let i=0;i<10;i++) s+= +d[i]*(11-i);
  dg=(s*10)%11; if(dg===10) dg=0; return dg=== +d[10];
}
function isValidCNPJ(c){
  c=onlyDigits(c); if(c.length!==14||/^(\d)\1+$/.test(c)) return false;
  const calc=b=>{ const seq=[5,4,3,2,9,8,7,6,5,4,3,2].slice(12-b.length);
    const sum=b.split('').reduce((s,ch,i)=>s+(+ch)*seq[i],0); const r=sum%11; return r<2?0:11-r; };
  const b1=c.substring(0,12), d1=calc(b1), d2=calc(b1+String(d1)); return c===(b1+String(d1)+String(d2));
}
function validCPForCNPJ(v){ const d=onlyDigits(v); if(!d.length) return true; return d.length<=11?isValidCPF(d):isValidCNPJ(d); }

function maskInput(el, formatter, validator){
  if (!el) return;
  const apply=()=>{ el.value=formatter(el.value); if(validator){ const ok=validator(el.value); el.classList.toggle('is-invalid',!ok); el.title=ok?'':'Valor inválido'; } };
  on(el,'input',apply); on(el,'blur',apply); apply();
}

/* ----------------- BrasilAPI CEP ----------------- */
async function preencherPorCEP(cep){
  const d=onlyDigits(cep); if(d.length!==8) return false;
  try{
    const r=await fetch(`https://brasilapi.com.br/api/cep/v2/${d}`);
    if(!r.ok) return false;
    const j=await r.json();
    const est=(j.state||'').toUpperCase();
    if ($('#pf_estado')) { const sel=$('#pf_estado'); if (UF_SET.has(est)) sel.value=est; }
    $('#pf_cidade') && ($('#pf_cidade').value = j.city || '');
    $('#pf_bairro') && ($('#pf_bairro').value = j.neighborhood || '');
    $('#pf_endereco') && ($('#pf_endereco').value = j.street || '');
    setBannerTip('Endereço sugerido a partir do CEP. Confira antes de salvar.');
    return true;
  }catch(e){ console.warn('[CEP] BrasilAPI erro', e); return false; }
}

/* ----------------- Banner helpers ----------------- */
function refreshBannerIcon(container){
  const slot = container?.querySelector('.b-ico');
  if (slot) slot.innerHTML = bannerSvg(getTheme());
}
function setBanner(msg, tip){
  const b = $('#zcPerfilBanner'); if(!b) return;
  const m = b.querySelector('.b-msg'); const t = b.querySelector('.b-tip');
  if (m) m.textContent = msg || '';
  if (t) t.textContent = tip || '';
  refreshBannerIcon(b);
}
function setBannerTip(tip){ const t=$('#zcPerfilBanner .b-tip'); if(t){ t.textContent=tip||''; t.animate([{opacity:.2},{opacity:1}],{duration:160,fill:'forwards'}); } }

/* ----------------- Drawer fallback (injetado se necessário) ----------------- */
function ensureFallbackDrawer(){
  if (document.getElementById('perfil-drawer') || document.getElementById('zcPerfilDrawer')) return;

  const backdrop = document.createElement('div');
  backdrop.id = 'zcPerfilBackdrop';
  backdrop.className = 'zcPerfil-backdrop';

  const drawer = document.createElement('aside');
  drawer.id = 'zcPerfilDrawer';
  drawer.className = 'zcPerfil-drawer';
  drawer.setAttribute('role','dialog'); drawer.setAttribute('aria-modal','true');

  const UF_OPTIONS = UF_LIST.map(uf=>`<option value="${uf}">${uf}</option>`).join('');
  drawer.innerHTML = `
    <div class="zcPerfil-head">
      <div class="zcPerfil-title">${iconSvg(getTheme())} Campos do cliente</div>
      <button class="zcPerfil-close" id="zcPerfilClose" title="Fechar" aria-label="Fechar">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66A8 8 0 0 1 61.66 50.34L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128z"/></svg>
      </button>
    </div>
    <div class="zcPerfil-body">
      <div class="zcPerfil-banner" id="zcPerfilBanner" aria-live="polite">
        <span class="b-ico"></span>
        <div>
          <div class="b-msg">Usamos inteligência artificial para <strong>montar o endereço</strong> a partir do CEP e para <strong>validar CPF/CNPJ</strong>. Confira os dados antes de salvar.</div>
          <div class="b-tip"></div>
        </div>
      </div>

      <div class="zcPerfil-stack">
        <div class="zcPerfil-field"><label>Nome completo</label><input id="pf_nome_completo" autocomplete="off" maxlength="120"></div>
        <div class="zcPerfil-field"><label>CPF/CNPJ</label><input id="pf_cpf_cnpj" autocomplete="off" inputmode="numeric" maxlength="18" placeholder="CPF ou CNPJ"></div>
        <div class="zcPerfil-field"><label>RG</label><input id="pf_rg" autocomplete="off" maxlength="12" placeholder="00.000.000-X"></div>
        <div class="zcPerfil-field"><label>E-mail</label><input id="pf_email" type="email" autocomplete="off" maxlength="120" placeholder="email@dominio.com"></div>

        <div class="zcPerfil-row zcPerfil-row--datagen">
          <div class="zcPerfil-field field--dob"><label>Data de nascimento</label><input id="pf_data_nasc" autocomplete="off" inputmode="numeric" maxlength="10" placeholder="DD/MM/AAAA"></div>
          <div class="zcPerfil-field field--genero">
            <label>Gênero</label>
            <div class="zcPerfil-selectWrap">
              <select id="pf_genero">
                <option value="">Selecione…</option>
                <option value="Masculino">Masculino</option>
                <option value="Feminino">Feminino</option>
                <option value="Outro">Outro</option>
                <option value="Prefiro não dizer">Prefiro não dizer</option>
              </select>
            </div>
          </div>
        </div>

        <div class="zcPerfil-row zcPerfil-row--cepuf">
          <div class="zcPerfil-field field--cep"><label>CEP</label><input id="pf_cep" autocomplete="off" inputmode="numeric" maxlength="9" placeholder="00000-000"></div>
          <div class="zcPerfil-field field--uf">
            <label>Estado (UF)</label>
            <div class="zcPerfil-selectWrap">
              <select id="pf_estado">
                <option value="">UF</option>
                ${UF_OPTIONS}
              </select>
            </div>
          </div>
        </div>

        <div class="zcPerfil-field"><label>Endereço</label><input id="pf_endereco" autocomplete="off" maxlength="80" placeholder="Rua, Av., Travessa…"></div>

        <div class="zcPerfil-row zcPerfil-row--numcomp">
          <div class="zcPerfil-field field--numero"><label>Número</label><input id="pf_numero" autocomplete="off" inputmode="numeric" maxlength="8"></div>
          <div class="zcPerfil-field field--complemento"><label>Complemento</label><input id="pf_complemento" autocomplete="off" maxlength="40" placeholder="Apto, Bloco, Casa, Sala…"></div>
        </div>

        <div class="zcPerfil-field"><label>Bairro</label><input id="pf_bairro" autocomplete="off" maxlength="50"></div>
        <div class="zcPerfil-field"><label>Cidade</label><input id="pf_cidade" autocomplete="off" maxlength="50"></div>
      </div>

      <div class="zcPerfil-actions">
        <button class="zcPerfil-btnPrimary" id="zcPerfilSave">Salvar</button>
        <button class="zcPerfil-btnGhost" id="zcPerfilCancel">Cancelar</button>
      </div>
    </div>
  `;
  document.body.append(backdrop, drawer);

  // tema: atualizar ícones
  const refreshIcon = ()=>{
    const t=drawer.querySelector('.zcPerfil-title');
    if(t) t.innerHTML=`${iconSvg(getTheme())} Campos do cliente`;
    refreshBannerIcon(drawer);
  };
  try{ const mq=matchMedia('(prefers-color-scheme: dark)'); (mq.addEventListener?mq.addEventListener('change',refreshIcon):mq.addListener(refreshIcon)); }catch{}
  new MutationObserver(refreshIcon).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  addEventListener('storage', e=>{ if(e && e.key==='zc:theme') refreshIcon(); });

  const open = ()=>{ backdrop.classList.add('is-open'); drawer.classList.add('is-open'); setTimeout(()=> $('#pf_nome_completo')?.focus(), 0); };
  const close = ()=>{ backdrop.classList.remove('is-open'); drawer.classList.remove('is-open'); };

  on($('#zcPerfilClose'),'click',close);
  on($('#zcPerfilCancel'),'click',close);
  on(backdrop,'click',e=>{ if(e.target===backdrop) close(); });
  on(document,'keydown',e=>{ if(e.key==='Escape') close(); });

  // máscaras
  function bindMasks(){
    maskInput($('#pf_cpf_cnpj'), fmtCPForCNPJ, validCPForCNPJ);
    maskInput($('#pf_rg'),       fmtRG, null);
    maskInput($('#pf_cep'),      fmtCEP, v=>isValidCEP(v)||v==='');
    maskInput($('#pf_numero'),   fmtNumero, null);
    maskInput($('#pf_complemento'), fmtComplemento, null);
    maskInput($('#pf_cidade'),   fmtCidade, null);
    maskInput($('#pf_data_nasc'), fmtDataBR, v => isValidDataBR(v) || v==='');

    const emailEl=$('#pf_email'); if(emailEl){
      const apply=()=>{ emailEl.value=(emailEl.value||'').trim().toLowerCase(); const ok=isValidEmail(emailEl.value); emailEl.classList.toggle('is-invalid',!ok); emailEl.title=ok?'':'E-mail inválido'; };
      on(emailEl,'blur',apply); apply();
    }
  }

  on($('#pf_cep'),'blur',async()=>{ const ok=await preencherPorCEP($('#pf_cep').value); if(!ok) setBannerTip('Não foi possível sugerir o endereço para este CEP.'); });

  async function carregar(){
    const cid=getClienteId(); if(!cid){ toast({title:'Selecione um cliente', type:'error'}); return; }
    try{
      const r=await fetch(`/api/atendimento/clientes/${cid}/profile?empresa_id=${EMPRESA_ID}`, { credentials:'include' });
      if(!r.ok) throw new Error('Falha ao buscar perfil');
      const j=await r.json();

      $('#pf_nome_completo').value=j.nome_completo||'';
      $('#pf_cpf_cnpj').value=fmtCPForCNPJ(j.cpf_cnpj||'');
      $('#pf_rg').value=fmtRG(j.rg||'');
      $('#pf_email').value=(j.email||'').trim().toLowerCase();

      const nascRaw = j.data_nascimento || j.nascimento || j.dataNascimento || '';
      $('#pf_data_nasc').value = toDataBRFromAny(nascRaw);

      const genRaw = j.genero || j.sexo || '';
      if ($('#pf_genero')) $('#pf_genero').value = genRaw || '';

      $('#pf_cep').value=fmtCEP(j.cep||'');
      $('#pf_endereco').value=j.endereco||'';
      $('#pf_numero').value=fmtNumero(j.numero||'');
      $('#pf_complemento').value=fmtComplemento(j.complemento||'');
      $('#pf_bairro').value=j.bairro||'';
      $('#pf_cidade').value=fmtCidade(j.cidade||'');
      const uf=fmtUF(j.estado||''); if(UF_SET.has(uf)) $('#pf_estado').value=uf;

      bindMasks();
      setBanner('Usamos inteligência artificial para montar o endereço a partir do CEP e para validar CPF/CNPJ. Confira os dados antes de salvar.','');
    }catch(err){ console.error('[perfil] carregar()',err); bindMasks(); }
  }

  on($('#zcPerfilSave'),'click',async()=>{
    const cid=getClienteId(); if(!cid){ toast({title:'Selecione um cliente', type:'error'}); return; }
    const email=($('#pf_email').value||'').trim().toLowerCase();
    const cpfcnpj=$('#pf_cpf_cnpj').value||'';
    const cep=$('#pf_cep').value||'';
    const ufSel=$('#pf_estado')?.value||'';
    const dnBr=$('#pf_data_nasc')?.value||'';
    const generoSel = ($('#pf_genero')?.value || '').trim();

    const invalids=[];
    if(!isValidEmail(email)) invalids.push('E-mail inválido');
    if(!validCPForCNPJ(cpfcnpj)) invalids.push('CPF/CNPJ inválido');
    if(cep && !isValidCEP(cep)) invalids.push('CEP inválido');
    if(ufSel && !UF_SET.has(ufSel)) invalids.push('UF inválida');
    if(dnBr && !isValidDataBR(dnBr)) invalids.push('Data de nascimento inválida');

    if(invalids.length){ toast({title:'Verifique os campos', msg:invalids.join(' · '), type:'error'}); return; }

    const payload={
      nome_completo: ($('#pf_nome_completo').value||'').trim() || undefined,
      cpf_cnpj:      onlyDigits(cpfcnpj) || undefined,
      rg:            ($('#pf_rg').value||'').replace(/\./g,'').toUpperCase() || undefined,
      email:         email || undefined,
      data_nascimento: dnBr ? toISOFromDataBR(dnBr) : undefined, // AAAA-MM-DD
      genero:        generoSel || undefined,
      cep:           onlyDigits(cep) || undefined,
      endereco:      ($('#pf_endereco').value||'').trim() || undefined,
      numero:        onlyDigits($('#pf_numero').value||'') || undefined,
      complemento:   ($('#pf_complemento').value||'').trim() || undefined,
      bairro:        ($('#pf_bairro').value||'').trim() || undefined,
      cidade:        ($('#pf_cidade').value||'').trim() || undefined,
      estado:        (ufSel||'').toUpperCase() || undefined,
    };

    try{
      const r=await fetch(`/api/atendimento/clientes/${cid}/profile?empresa_id=${EMPRESA_ID}`, {
        method:'PUT',
        credentials:'include',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload)
      });
      if(!r.ok) throw new Error('Falha ao salvar');
      setBannerTip('Dados salvos com sucesso.');
      toast({ title:'Salvo', msg:'Informações do cliente atualizadas.' });
    }catch(err){
      console.error('[perfil] salvar()', err);
      toast({ title:'Erro ao salvar', type:'error' });
    }
  });

  window.__zcPerfilFallback = {
    open: ()=>{refreshIcon(); backdrop.classList.add('is-open'); drawer.classList.add('is-open');},
    close: ()=>{backdrop.classList.remove('is-open'); drawer.classList.remove('is-open');},
    carregar
  };
  refreshIcon(); // inicial
}

/* ----------------- EXPORT: abrirPerfilAtual ----------------- */
export async function abrirPerfilAtual() {
  const cid=getClienteId();
  if(!cid){ toast({title:'Selecione um cliente', type:'error'}); return; }

  const perfilDrawer   = document.getElementById('perfil-drawer');
  const perfilBackdrop = document.getElementById('perfil-backdrop');
  if (perfilDrawer && perfilBackdrop){
    // abre
    perfilDrawer.classList.remove('hidden'); perfilBackdrop.classList.remove('hidden');
    requestAnimationFrame(()=> perfilDrawer.classList.add('open'));
    // close
    const close = ()=>{ perfilDrawer.classList.remove('open'); setTimeout(()=>{ perfilDrawer.classList.add('hidden'); perfilBackdrop.classList.add('hidden'); },180); };
    $('#perfil-close')?.addEventListener('click', close, { once:true });
    perfilBackdrop?.addEventListener('click', e=>{ if(e.target===perfilBackdrop) close(); }, { once:true });

    // injeta banner (com SVG)
    if (!perfilDrawer.querySelector('#zcPerfilBanner')){
      const banner=document.createElement('div');
      banner.className='zcPerfil-banner'; banner.id='zcPerfilBanner'; banner.setAttribute('aria-live','polite');
      banner.innerHTML=`<span class="b-ico"></span><div><div class="b-msg">Usamos inteligência artificial para <strong>montar o endereço</strong> a partir do CEP e para <strong>validar CPF/CNPJ</strong>. Confira os dados antes de salvar.</div><div class="b-tip"></div></div>`;
      perfilDrawer.insertBefore(banner, perfilDrawer.firstChild);
      refreshBannerIcon(perfilDrawer);
    }
    // máscaras se IDs existirem (modo nativo)
    const maybe = $('#pf_cpf_cnpj') || $('#pf_rg') || $('#pf_cep') || $('#pf_data_nasc') || $('#pf_genero');
    if (maybe){
      maskInput($('#pf_cpf_cnpj'), fmtCPForCNPJ, validCPForCNPJ);
      maskInput($('#pf_rg'), fmtRG, null);
      maskInput($('#pf_cep'), fmtCEP, v=>isValidCEP(v)||v==='');
      maskInput($('#pf_numero'), fmtNumero, null);
      maskInput($('#pf_complemento'), fmtComplemento, null);
      maskInput($('#pf_cidade'), fmtCidade, null);
      maskInput($('#pf_data_nasc'), fmtDataBR, v=>isValidDataBR(v) || v==='');

      const emailEl=$('#pf_email'); if(emailEl){ const apply=()=>{ emailEl.value=(emailEl.value||'').trim().toLowerCase(); const ok=isValidEmail(emailEl.value); emailEl.classList.toggle('is-invalid',!ok); emailEl.title=ok?'':'E-mail inválido'; }; on(emailEl,'blur',apply); apply(); }
      on($('#pf_cep'),'blur', async()=>{ const ok=await preencherPorCEP($('#pf_cep').value); if(!ok) setBannerTip('Não foi possível sugerir o endereço para este CEP.'); });
    }
    return;
  }

  ensureFallbackDrawer();
  if (window.__zcPerfilFallback){ await window.__zcPerfilFallback.carregar(); window.__zcPerfilFallback.open(); return; }
  console.debug('[perfil] Nenhum drawer encontrado.');
}
window.abrirPerfilAtual = abrirPerfilAtual;

/* ----------------- botão no header ----------------- */
function ensureHeaderButton(){
  if (document.getElementById('btn-perfil')) return;
  const hdr = $('#chat-header .flex.items-center.gap-2.relative') || $('#chat-header .flex.items-center.gap-2') || $('#chat-header');
  if (!hdr) return;
  const btn=document.createElement('button');
  btn.id='btn-perfil'; btn.className='hdr-icon-btn'; btn.title='Campos do cliente'; btn.setAttribute('aria-label','Campos do cliente'); btn.innerHTML=iconSvg(getTheme());
  on(btn,'click',e=>{ e.preventDefault(); abrirPerfilAtual(); });
  hdr.appendChild(btn);
  const refresh=()=>{ const h=document.getElementById('btn-perfil'); if(h) h.innerHTML=iconSvg(getTheme()); };
  try{ const mq=matchMedia('(prefers-color-scheme: dark)'); (mq.addEventListener?mq.addEventListener('change',refresh):mq.addListener(refresh)); }catch{}
  new MutationObserver(refresh).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  addEventListener('storage', e=>{ if(e && e.key==='zc:theme') refresh(); });
}
(function watchHeader(){
  const hdrEl=document.getElementById('chat-header');
  if (hdrEl){ const mo=new MutationObserver(()=> ensureHeaderButton()); mo.observe(hdrEl,{attributes:true,attributeFilter:['style','class']}); }
  ensureHeaderButton();
})();
