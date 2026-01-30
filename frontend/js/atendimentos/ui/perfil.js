// /frontend/js/atendimentos/ui/perfil.js
// Drawer “Campos do cliente” com máscaras, CEP (BrasilAPI), toasts,
// banner com borda roxa e ícone SVG (sem emoji), layout em coluna,
// pares compactos (CEP+UF, Número+Complemento, Data+Gênero),
// UF/CEP/Data menores e limites de caracteres.

// ✅ SEM CSS inline/inject — tudo vai para /frontend/css/atendimentos.css

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

/* ----------------- Toasts ----------------- */
function ensureToastHost(){
  let h = document.getElementById('zcToastHost');
  if (!h){
    h = document.createElement('div');
    h.id='zcToastHost';
    h.className='zcToastHost';
    document.body.appendChild(h);
  }
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
function fmtRG(v){
  let s=keepRGChars(v).slice(0,10), body=s, dv='';
  if(s.length===10){ body=s.slice(0,9); dv=s.slice(9); }
  body=body.replace(/^(\d{2})(\d)/,"$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/,"$1.$2.$3");
  return dv ? `${body}-${dv}` : body;
}
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
function toISOFromDataBR(v){
  if (!isValidDataBR(v)) return '';
  const [dd,mm,yyyy] = v.split('/');
  return `${yyyy}-${mm}-${dd}`;
}
function toDataBRFromAny(x){
  if (!x) return '';
  const s = String(x);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
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
  const calc=b=>{
    const seq=[5,4,3,2,9,8,7,6,5,4,3,2].slice(12-b.length);
    const sum=b.split('').reduce((s,ch,i)=>s+(+ch)*seq[i],0);
    const r=sum%11; return r<2?0:11-r;
  };
  const b1=c.substring(0,12), d1=calc(b1), d2=calc(b1+String(d1));
  return c===(b1+String(d1)+String(d2));
}
function validCPForCNPJ(v){
  const d=onlyDigits(v);
  if(!d.length) return true;
  return d.length<=11?isValidCPF(d):isValidCNPJ(d);
}

function maskInput(el, formatter, validator){
  if (!el) return;
  const apply=()=>{
    el.value=formatter(el.value);
    if(validator){
      const ok=validator(el.value);
      el.classList.toggle('is-invalid',!ok);
      el.title=ok?'':'Valor inválido';
    }
  };
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
function setBannerTip(tip){
  const t=$('#zcPerfilBanner .b-tip');
  if(t){
    t.textContent=tip||'';
    try{ t.animate([{opacity:.2},{opacity:1}],{duration:160,fill:'forwards'}); }catch{}
  }
}

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

  const refreshIcon = ()=>{
    const t=drawer.querySelector('.zcPerfil-title');
    if(t) t.innerHTML=`${iconSvg(getTheme())} Campos do cliente`;
    refreshBannerIcon(drawer);
  };
  try{ const mq=matchMedia('(prefers-color-scheme: dark)'); (mq.addEventListener?mq.addEventListener('change',refreshIcon):mq.addListener(refreshIcon)); }catch{}
  new MutationObserver(refreshIcon).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  addEventListener('storage', e=>{ if(e && e.key==='zc:theme') refreshIcon(); });

  const open = ()=>{
    backdrop.classList.add('is-open');
    drawer.classList.add('is-open');
    setTimeout(()=> $('#pf_nome_completo')?.focus(), 0);
  };
  const close = ()=>{
    backdrop.classList.remove('is-open');
    drawer.classList.remove('is-open');
  };

  on($('#zcPerfilClose'),'click',close);
  on($('#zcPerfilCancel'),'click',close);
  on(backdrop,'click',e=>{ if(e.target===backdrop) close(); });
  on(document,'keydown',e=>{ if(e.key==='Escape') close(); });

  function bindMasks(){
    maskInput($('#pf_cpf_cnpj'), fmtCPForCNPJ, validCPForCNPJ);
    maskInput($('#pf_rg'),       fmtRG, null);
    maskInput($('#pf_cep'),      fmtCEP, v=>isValidCEP(v)||v==='');
    maskInput($('#pf_numero'),   fmtNumero, null);
    maskInput($('#pf_complemento'), fmtComplemento, null);
    maskInput($('#pf_cidade'),   fmtCidade, null);
    maskInput($('#pf_data_nasc'), fmtDataBR, v => isValidDataBR(v) || v==='');

    const emailEl=$('#pf_email');
    if(emailEl){
      const apply=()=>{
        emailEl.value=(emailEl.value||'').trim().toLowerCase();
        const ok=isValidEmail(emailEl.value);
        emailEl.classList.toggle('is-invalid',!ok);
        emailEl.title=ok?'':'E-mail inválido';
      };
      on(emailEl,'blur',apply); apply();
    }
  }

  on($('#pf_cep'),'blur',async()=>{
    const ok=await preencherPorCEP($('#pf_cep').value);
    if(!ok) setBannerTip('Não foi possível sugerir o endereço para este CEP.');
  });

  async function carregar(){
    const cid=getClienteId();
    if(!cid){ toast({title:'Selecione um cliente', type:'error'}); return; }
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
      const uf=fmtUF(j.estado||'');
      if(UF_SET.has(uf)) $('#pf_estado').value=uf;

      bindMasks();
      setBanner('Usamos inteligência artificial para montar o endereço a partir do CEP e para validar CPF/CNPJ. Confira os dados antes de salvar.','');
    }catch(err){
      console.error('[perfil] carregar()',err);
      bindMasks();
    }
  }

  on($('#zcPerfilSave'),'click',async()=>{
    const cid=getClienteId();
    if(!cid){ toast({title:'Selecione um cliente', type:'error'}); return; }

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

    if(invalids.length){
      toast({title:'Verifique os campos', msg:invalids.join(' · '), type:'error'});
      return;
    }

    const payload={
      nome_completo: ($('#pf_nome_completo').value||'').trim() || undefined,
      cpf_cnpj:      onlyDigits(cpfcnpj) || undefined,
      rg:            ($('#pf_rg').value||'').replace(/\./g,'').toUpperCase() || undefined,
      email:         email || undefined,
      data_nascimento: dnBr ? toISOFromDataBR(dnBr) : undefined,
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

  window.__zcPerfilFallback = { open, close, carregar };
  refreshIcon();
}

/* ----------------- EXPORT: abrirPerfilAtual ----------------- */
export async function abrirPerfilAtual() {
  const cid=getClienteId();
  if(!cid){ toast({title:'Selecione um cliente', type:'error'}); return; }

  const perfilDrawer   = document.getElementById('perfil-drawer');
  const perfilBackdrop = document.getElementById('perfil-backdrop');

  if (perfilDrawer && perfilBackdrop){
    perfilDrawer.classList.remove('hidden');
    perfilBackdrop.classList.remove('hidden');
    requestAnimationFrame(()=> perfilDrawer.classList.add('open'));

    const close = ()=>{
      perfilDrawer.classList.remove('open');
      setTimeout(()=>{
        perfilDrawer.classList.add('hidden');
        perfilBackdrop.classList.add('hidden');
      },180);
    };
    $('#perfil-close')?.addEventListener('click', close, { once:true });
    perfilBackdrop?.addEventListener('click', e=>{ if(e.target===perfilBackdrop) close(); }, { once:true });

    if (!perfilDrawer.querySelector('#zcPerfilBanner')){
      const banner=document.createElement('div');
      banner.className='zcPerfil-banner';
      banner.id='zcPerfilBanner';
      banner.setAttribute('aria-live','polite');
      banner.innerHTML=`<span class="b-ico"></span><div><div class="b-msg">Usamos inteligência artificial para <strong>montar o endereço</strong> a partir do CEP e para <strong>validar CPF/CNPJ</strong>. Confira os dados antes de salvar.</div><div class="b-tip"></div></div>`;
      perfilDrawer.insertBefore(banner, perfilDrawer.firstChild);
      refreshBannerIcon(perfilDrawer);
    }

    const maybe = $('#pf_cpf_cnpj') || $('#pf_rg') || $('#pf_cep') || $('#pf_data_nasc') || $('#pf_genero');
    if (maybe){
      maskInput($('#pf_cpf_cnpj'), fmtCPForCNPJ, validCPForCNPJ);
      maskInput($('#pf_rg'), fmtRG, null);
      maskInput($('#pf_cep'), fmtCEP, v=>isValidCEP(v)||v==='');
      maskInput($('#pf_numero'), fmtNumero, null);
      maskInput($('#pf_complemento'), fmtComplemento, null);
      maskInput($('#pf_cidade'), fmtCidade, null);
      maskInput($('#pf_data_nasc'), fmtDataBR, v=>isValidDataBR(v) || v==='');

      const emailEl=$('#pf_email');
      if(emailEl){
        const apply=()=>{
          emailEl.value=(emailEl.value||'').trim().toLowerCase();
          const ok=isValidEmail(emailEl.value);
          emailEl.classList.toggle('is-invalid',!ok);
          emailEl.title=ok?'':'E-mail inválido';
        };
        on(emailEl,'blur',apply); apply();
      }

      on($('#pf_cep'),'blur', async()=>{
        const ok=await preencherPorCEP($('#pf_cep').value);
        if(!ok) setBannerTip('Não foi possível sugerir o endereço para este CEP.');
      });
    }
    return;
  }

  ensureFallbackDrawer();
  if (window.__zcPerfilFallback){
    await window.__zcPerfilFallback.carregar();
    window.__zcPerfilFallback.open();
    return;
  }
  console.debug('[perfil] Nenhum drawer encontrado.');
}
window.abrirPerfilAtual = abrirPerfilAtual;

/* ----------------- botão no header ----------------- */
function ensureHeaderButton(){
  if (document.getElementById('btn-perfil')) return;

  const hdr = $('#chat-header .flex.items-center.gap-2.relative')
           || $('#chat-header .flex.items-center.gap-2')
           || $('#chat-header');
  if (!hdr) return;

  const btn=document.createElement('button');
  btn.id='btn-perfil';
  btn.className='hdr-icon-btn';
  btn.title='Campos do cliente';
  btn.setAttribute('aria-label','Campos do cliente');
  btn.innerHTML=iconSvg(getTheme());

  on(btn,'click',e=>{ e.preventDefault(); abrirPerfilAtual(); });
  hdr.appendChild(btn);

  const refresh=()=>{
    const h=document.getElementById('btn-perfil');
    if(h) h.innerHTML=iconSvg(getTheme());
  };
  try{ const mq=matchMedia('(prefers-color-scheme: dark)'); (mq.addEventListener?mq.addEventListener('change',refresh):mq.addListener(refresh)); }catch{}
  new MutationObserver(refresh).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  addEventListener('storage', e=>{ if(e && e.key==='zc:theme') refresh(); });
}
(function watchHeader(){
  const hdrEl=document.getElementById('chat-header');
  if (hdrEl){
    const mo=new MutationObserver(()=> ensureHeaderButton());
    mo.observe(hdrEl,{attributes:true,attributeFilter:['style','class']});
  }
  ensureHeaderButton();
})();
