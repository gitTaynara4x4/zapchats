// Chatbot Config – UX limpa: sem alerts, sem logs no console, toasts/modais bonitos.
(() => {
  'use strict';

  // ===== sessão/fetch =====
  const LS = localStorage;
  const EMPRESA_ID   = () => Number(LS.getItem('empresa_id') || 0);
  const EMPRESA_NOME = () => (LS.getItem('empresa_nome') || '[Empresa]').trim();
  const TOKEN        = () => LS.getItem('token') || LS.getItem('auth_token') || '';
  async function authFetch(input, init = {}) {
    const t = TOKEN();
    const headers = { ...(init.headers||{}), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
    return fetch(input, { ...init, headers, credentials: 'include' });
  }

  // ===== helpers UI =====
  function ce(tag, cls){ const el=document.createElement(tag); if(cls) el.className=cls; return el; }
  function ensureToastHost(){
    let host=document.getElementById('toast-host');
    if(!host){
      host=ce('div','toast-host');
      host.id='toast-host';
      host.style.position='fixed';
      host.style.right='16px';
      host.style.top='16px';
      host.style.zIndex='99999';
      host.style.display='flex';
      host.style.flexDirection='column';
      host.style.gap='8px';
      document.body.appendChild(host);
    }
    return host;
  }
  function toast(msg, kind='success'){
    const host=ensureToastHost();
    const box=ce('div','toast');
    box.style.minWidth='280px';
    box.style.maxWidth='440px';
    box.style.padding='12px 14px';
    box.style.borderRadius='12px';
    box.style.boxShadow='0 8px 28px rgba(0,0,0,.25)';
    box.style.color= (kind==='error'?'#fff':'#0f172a');
    box.style.background = (kind==='error'?'#ef4444':'#c7d2fe');
    box.style.font='14px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    box.textContent = msg;
    host.appendChild(box);
    setTimeout(()=>{ box.style.opacity='0'; box.style.transform='translateY(-6px)'; setTimeout(()=>box.remove(), 260); }, 2600);
  }
  function showErrorModal(title, message){
    let overlay=ce('div'); overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100000;display:flex;align-items:center;justify-content:center';
    const card=ce('div'); card.style.cssText='width:min(560px,92vw);background:#0b0b13;color:#e5e7eb;border:1px solid #1f2937;border-radius:16px;padding:18px 18px 14px;box-shadow:0 10px 40px rgba(0,0,0,.45)';
    const h=ce('div'); h.style.cssText='font-weight:700;font-size:16px;margin-bottom:8px'; h.textContent=title||'Erro';
    const p=ce('pre'); p.style.cssText='white-space:pre-wrap;margin:0;background:#0f172a;border:1px solid #1f2937;border-radius:10px;padding:10px;max-height:38vh;overflow:auto;font-size:12px'; p.textContent=message||'';
    const footer=ce('div'); footer.style.cssText='display:flex;justify-content:flex-end;margin-top:12px';
    const ok=ce('button'); ok.textContent='OK'; ok.style.cssText='padding:8px 14px;border-radius:10px;background:#c7d2fe;color:#111827;border:0;font-weight:600;cursor:pointer';
    ok.addEventListener('click',()=>overlay.remove());
    footer.appendChild(ok);
    card.append(h,p,footer);
    overlay.addEventListener('click', (e)=>{ if(e.target===overlay) overlay.remove(); });
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function humanizeErrorDetail(detail){
    try{
      if(typeof detail === 'string') return detail;
      if(detail && typeof detail === 'object'){
        if(detail.message && detail.db_error) return `${detail.message}\n\n${detail.db_error}`;
        if(detail.message) return detail.message;
        return JSON.stringify(detail, null, 2);
      }
    }catch{}
    return String(detail||'Erro desconhecido');
  }

  // ===== dropdown de instâncias =====
  const instBtn   = document.getElementById('instMenuBtnChat');
  const instLabel = document.getElementById('instMenuLabelChat');
  const instMenu  = document.getElementById('inst-menu-chat');
  const instList  = document.getElementById('instMenuListChat');

  function getActiveInstId(){
    const raw = window.__INST_ID ?? '';
    const id = Number(String(raw).replace(/\D/g,''));
    return Number.isFinite(id) && id > 0 ? id : 0;
  }
  function requireActiveInstId(){
    const id = getActiveInstId();
    if(!id) throw new Error('INST_REQUIRED');
    return id;
  }
  function lockUI(locked,msg){
    const controls = document.querySelectorAll('.tswitch input, textarea, input[type="time"], #saveAuto, #saveDept, button, select');
    controls.forEach(el=>el.disabled=!!locked);
    let banner = document.getElementById('instRequiredBanner');
    if(locked){
      if(!banner){
        banner = document.createElement('div');
        banner.id='instRequiredBanner'; banner.className='alert warn'; banner.style.margin='.75rem 0';
        banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${msg||'Selecione uma instância para configurar o chatbot.'}`;
        document.querySelector('.section-title')?.after(banner);
      } else banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${msg||'Selecione uma instância para configurar o chatbot.'}`;
    } else if(banner){ banner.remove(); }
  }

  // ===== refs =====
  const swAutoHdr   = document.getElementById('swAutoHdr');
  const pillAutoHdr = document.getElementById('pillAutoHdr');
  const swDeptHdr   = document.getElementById('swDeptHdr');
  const pillDeptHdr = document.getElementById('pillDeptHdr');

  const headAuto = document.querySelector('[data-toggle="auto"]');
  const bodyAuto = document.getElementById('body-auto');
  const swWelcome = document.getElementById('swWelcome');
  const pillWelcome = document.getElementById('pillWelcome');
  const msgWelcome = document.getElementById('msgWelcome');
  const wcCount = document.getElementById('wcCount');
  const wStart = document.getElementById('wStart');
  const wEnd   = document.getElementById('wEnd');

  const swOff = document.getElementById('swOff');
  const pillOff = document.getElementById('pillOff');
  const msgOff = document.getElementById('msgOff');
  const offCount = document.getElementById('offCount');
  const oStart = document.getElementById('oStart');
  const oEnd   = document.getElementById('oEnd');

  const prevW = document.getElementById('prevW');
  const prevWText = document.getElementById('prevWText');
  const prevO = document.getElementById('prevO');

  const saveAuto = document.getElementById('saveAuto');
  const cancelAuto = document.getElementById('cancelAuto');

  // Departamentos
  const headAutoDept = document.querySelector('[data-toggle="auto-dept"]');
  const bodyAutoDept = document.getElementById('body-auto-dept');
  const saveDept = document.getElementById('saveDept');
  const cancelDept = document.getElementById('cancelDept');

  const swDeptWelcome   = document.getElementById('swDeptWelcome');
  const pillDeptWelcome = document.getElementById('pillDeptWelcome');
  const msgDeptWelcome  = document.getElementById('msgDeptWelcome');
  const dwCount         = document.getElementById('dwCount');
  const dwStart         = document.getElementById('dwStart');
  const dwEnd           = document.getElementById('dwEnd');
  const schedDeptWelcome= document.getElementById('schedDeptWelcome');

  // ===== estado =====
  let cfg=null, _deptCache=null;

  const LOCAL_DEFAULTS = {
    features:{
      auto_messages:{
        enabled:false,
        welcome:{ enabled:false, text:"Olá! 👋 Como posso ajudar?", start:"08:00", end:"18:00" },
        off_hours:{ enabled:false, text:"Atendemos de 08:00 às 18:00. Deixe sua mensagem e responderemos no próximo expediente.", start:"18:00", end:"08:00" }
      },
      auto_messages_departments:{
        enabled:false,
        welcome:{ enabled:false, text:"", start:"08:00", end:"18:00" }
      }
    }
  };

  // ===== utils =====
  function setSwitch(el,on,pillEl){ if(!el) return; el.dataset.on=on?'true':'false'; const input=el.querySelector('input'); if(input) input.checked=!!on; if(pillEl){ pillEl.textContent=on?'on':'off'; pillEl.classList.toggle('on',!!on); pillEl.classList.toggle('off',!on); } }
  function getSwitch(el){ return !!el?.querySelector('input')?.checked; }
  function setHeaderSwitch(el,pill,on){ setSwitch(el,on,pill); el?.setAttribute('aria-pressed',on?'true':'false'); }
  function deepMerge(base,extra){ if(!extra||typeof extra!=='object') return base; const out=Array.isArray(base)?base.slice():{...base}; for(const k of Object.keys(extra)){ const v=extra[k]; out[k]=(v&&typeof v==='object'&&!Array.isArray(v))?deepMerge(out[k]||{},v):v; } return out; }
  function insertAtCaret(ta,text){ if(!ta) return; const s=ta.selectionStart??ta.value.length, e=ta.selectionEnd??ta.value.length; ta.value=ta.value.slice(0,s)+text+ta.value.slice(e); const pos=s+text.length; ta.focus(); try{ta.setSelectionRange(pos,pos);}catch{} if(ta===msgWelcome&&wcCount) wcCount.textContent=`${ta.value.length} caracteres`; if(ta===msgDeptWelcome&&dwCount) dwCount.textContent=`${ta.value.length} caracteres`; if(ta===msgWelcome) renderWelcomePreview(); }

  // ===== chips/sugestões (somente no bloco Departamentos) =====
  function ensureChipStyles(){
    if(document.getElementById('dept-chip-styles')) return;
    const st=document.createElement('style'); st.id='dept-chip-styles';
    st.textContent = `
      .sug-shelf{display:flex;align-items:center;gap:.35rem;flex-wrap:wrap;margin:.35rem 0}
      .sug-label{font-size:.8rem;color:var(--muted);margin-right:.25rem}
      .chip-btn{border:1px solid var(--border);background:var(--card);color:var(--fg);padding:.25rem .5rem;border-radius:999px;cursor:pointer;font-size:.8rem}
      .chip-btn:hover{background:var(--hover)}
    `;
    document.head.appendChild(st);
  }

  async function getDepartamentos(){
    if(_deptCache) return _deptCache;
    const url = new URL('/api/atendimento/clientes/departamentos', location.origin);
    url.searchParams.set('empresa_id', String(EMPRESA_ID()));
    const r = await authFetch(url.toString());
    if(!r.ok){ _deptCache=[]; return _deptCache; }
    const j = await r.json();
    _deptCache = Array.isArray(j) ? j : (Array.isArray(j?.items) ? j.items : []);
    return _deptCache;
  }

  function buildDeptWelcomeExample(list){
    const empresa = EMPRESA_NOME();
    const header = [
      `Olá. Seja bem-vindo(a) à ${empresa}.`,
      `Em que setor deseja atendimento?`,
      ``,
    ];
    let nomes;
    if(Array.isArray(list)&&list.length){
      nomes = list.map(d => d.nome || d.name || String(d));
    }else{
      nomes = [
        'Comercial',
        'Suporte Técnico',
        'Cobrança/Financeiro',
        'Agendamentos/Instalação',
        'Ouvidoria/Atendimento humano',
      ];
    }
    const linhas = nomes.map((n,i)=> `${i+1} - ${n}`);
    return header.join('\n') + linhas.join('\n');
  }

  async function attachDeptSuggestions(targetTextarea){
    if(!targetTextarea) return;
    ensureChipStyles();
    if(document.getElementById('dept-shelf-welcome')) return;

    const shelf=document.createElement('div');
    shelf.className='sug-shelf';
    shelf.id='dept-shelf-welcome';

    const label=document.createElement('span');
    label.className='sug-label';
    label.textContent='Departamentos:';
    shelf.appendChild(label);

    const list = await getDepartamentos();
    if(!list.length){
      const empty=document.createElement('span'); empty.className='sug-label'; empty.textContent='— nenhum encontrado —';
      shelf.appendChild(empty);
    }else{
      list.forEach(d=>{
        const b=document.createElement('button'); b.type='button'; b.className='chip-btn';
        b.textContent=d.nome || String(d.id);
        b.addEventListener('click', ()=>{
          insertAtCaret(targetTextarea, (targetTextarea.value && !/\s$/.test(targetTextarea.value) ? ' ' : '') + (d.nome||''));
          targetTextarea.dispatchEvent(new Event('input',{bubbles:true}));
        });
        shelf.appendChild(b);
      });
    }

    const gen=document.createElement('button');
    gen.type='button'; gen.className='chip-btn'; gen.textContent='Gerar exemplo';
    gen.title='Preencher com exemplo numerado usando seus departamentos';
    gen.addEventListener('click', async ()=>{
      const depts=await getDepartamentos();
      targetTextarea.value = buildDeptWelcomeExample(depts);
      targetTextarea.dispatchEvent(new Event('input',{bubbles:true}));
    });
    shelf.appendChild(gen);

    targetTextarea.parentElement?.insertBefore(shelf,targetTextarea);
  }

  // ===== acordeões =====
  function setAccordionOpen(head, body, open){
    head?.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.style.height = open ? 'auto' : '0px';
    body.style.opacity = open ? '1' : '0';
    body.style.pointerEvents = open ? 'auto' : 'none';
    body.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  function bindAccordion(head, body){ head?.addEventListener('click',()=>{ const open=head.getAttribute('aria-expanded')==='true'; setAccordionOpen(head,body,!open); }); }

  // ===== visibilidade horários =====
  const schedWelcome = document.getElementById('schedWelcome');
  const schedOff     = document.getElementById('schedOff');
  function updateScheduleVisibility(){
    const masterAutoOn = getSwitch(swAutoHdr);
    const welcomeOn = masterAutoOn && getSwitch(swWelcome);
    const offOn     = masterAutoOn && getSwitch(swOff);
    if(schedWelcome) schedWelcome.classList.toggle('show', welcomeOn);
    if(schedOff)     schedOff.classList.toggle('show', offOn);

    const masterDeptOn = getSwitch(swDeptHdr);
    const deptWOn = masterDeptOn && getSwitch(swDeptWelcome);
    if(schedDeptWelcome) schedDeptWelcome.classList.toggle('show', deptWOn);
  }
  function setAutoChildrenEnabled(enabled){
    swWelcome?.classList.toggle('disabled',!enabled);
    swWelcome?.querySelector('input')&&(swWelcome.querySelector('input').disabled=!enabled);
    msgWelcome && (msgWelcome.disabled=!enabled||!getSwitch(swWelcome));
    if(wStart) wStart.disabled=!enabled; if(wEnd) wEnd.disabled=!enabled;

    swOff?.classList.toggle('disabled',!enabled);
    swOff?.querySelector('input')&&(swOff.querySelector('input').disabled=!enabled);
    msgOff && (msgOff.disabled=!enabled||!getSwitch(swOff));
    if(oStart) oStart.disabled=!enabled; if(oEnd) oEnd.disabled=!enabled;

    updateScheduleVisibility();
  }
  function setDeptChildrenEnabled(enabled){
    swDeptWelcome?.classList.toggle('disabled',!enabled);
    swDeptWelcome?.querySelector('input')&&(swDeptWelcome.querySelector('input').disabled=!enabled);
    msgDeptWelcome && (msgDeptWelcome.disabled=!enabled||!getSwitch(swDeptWelcome));
    if(dwStart) dwStart.disabled=!enabled; if(dwEnd) dwEnd.disabled=!enabled;
    updateScheduleVisibility();
  }
  function ensureMasters(c){
    c.features??={}; c.features.auto_messages??={};
    if(typeof c.features.auto_messages.enabled!=='boolean'){ c.features.auto_messages.enabled=false; }
    c.features.auto_messages_departments??={ enabled:false, welcome:{enabled:false,text:"",start:"08:00",end:"18:00"} };
  }

  // ===== exclusividade =====
  function enforceExclusive(which){
    if(which==='auto'){
      setHeaderSwitch(swAutoHdr,pillAutoHdr,true);
      setHeaderSwitch(swDeptHdr,pillDeptHdr,false);
      cfg.features.auto_messages.enabled=true;
      cfg.features.auto_messages_departments.enabled=false;
      setAccordionOpen(headAutoDept,bodyAutoDept,false);
      setAccordionOpen(headAuto,bodyAuto,true);
      setAutoChildrenEnabled(true); setDeptChildrenEnabled(false);
      renderWelcomePreview(); renderOffPreview(); updateSaveButtons(); updateScheduleVisibility();
    }else if(which==='dept'){
      setHeaderSwitch(swDeptHdr,pillDeptHdr,true);
      setHeaderSwitch(swAutoHdr,pillAutoHdr,false);
      setSwitch(swWelcome,false,pillWelcome); setSwitch(swOff,false,pillOff);
      cfg.features.auto_messages_departments.enabled=true;
      cfg.features.auto_messages.enabled=false;
      (cfg.features.auto_messages.welcome ||= {}).enabled=false;
      (cfg.features.auto_messages.off_hours ||= {}).enabled=false;
      setAccordionOpen(headAuto,bodyAuto,false);
      setAccordionOpen(headAutoDept,bodyAutoDept,true);
      setAutoChildrenEnabled(false); setDeptChildrenEnabled(true);
      renderWelcomePreview(); renderOffPreview(); updateSaveButtons(); updateScheduleVisibility();
    }
  }

  // ===== previews =====
  function renderWelcomePreview(){
    const enabled = getSwitch(swWelcome)&&getSwitch(swAutoHdr);
    if(prevW) prevW.style.display = enabled ? '' : 'none';
    if(prevWText) prevWText.textContent = (msgWelcome?.value || '—').trim() || '—';
  }
  function renderOffPreview(){
    const enabled = getSwitch(swOff)&&getSwitch(swAutoHdr);
    if(prevO){ prevO.style.display = enabled ? '' : 'none'; prevO.textContent = (msgOff?.value || '—').trim() || '—'; }
  }

  // ===== switches =====
  function bindSwitch(labelEl,pillEl,onToggle){
    if(!labelEl) return; const input=labelEl.querySelector('input');
    labelEl.addEventListener('click', (e)=>{
      e.preventDefault(); e.stopPropagation();
      const newVal = !input.checked; setSwitch(labelEl,newVal,pillEl); onToggle?.(newVal);

      if(labelEl===swAutoHdr){
        if(newVal) enforceExclusive('auto'); else { cfg.features.auto_messages.enabled=false; setAutoChildrenEnabled(false); renderWelcomePreview(); renderOffPreview(); updateSaveButtons(); }
        updateScheduleVisibility();
      }
      if(labelEl===swDeptHdr){
        if(newVal) enforceExclusive('dept'); else { cfg.features.auto_messages_departments.enabled=false; setDeptChildrenEnabled(false); updateSaveButtons(); }
      }
      if(labelEl===swWelcome){
        if(newVal && !getSwitch(swAutoHdr)) enforceExclusive('auto');
        msgWelcome && (msgWelcome.disabled = !newVal || !getSwitch(swAutoHdr));
        renderWelcomePreview(); updateScheduleVisibility();
      }
      if(labelEl===swOff){
        if(newVal && !getSwitch(swAutoHdr)) enforceExclusive('auto');
        msgOff && (msgOff.disabled = !newVal || !getSwitch(swAutoHdr));
        renderOffPreview(); updateScheduleVisibility();
      }
      if(labelEl===swDeptWelcome){
        if(newVal && !getSwitch(swDeptHdr)) enforceExclusive('dept');
        msgDeptWelcome && (msgDeptWelcome.disabled = !newVal || !getSwitch(swDeptHdr));
        updateScheduleVisibility();
      }
    });
  }

  function updateSaveButtons(){
    if(saveAuto) saveAuto.disabled = !getSwitch(swAutoHdr);
    if(saveDept) saveDept.disabled = !getSwitch(swDeptHdr);
  }

  // ===== API config =====
  async function getConfig(){
    const url = new URL('/api/chatbot/config', location.origin);
    url.searchParams.set('empresa_id', String(EMPRESA_ID()));
    url.searchParams.set('instancia_id', String(requireActiveInstId()));
    const r = await authFetch(url.toString());
    if(!r.ok) throw new Error(`GET config ${r.status}`);
    const data = await r.json();
    return deepMerge(structuredClone(LOCAL_DEFAULTS), data?.config || {});
  }
  async function putConfig(data){
    const url = new URL('/api/chatbot/config', location.origin);
    url.searchParams.set('empresa_id', String(EMPRESA_ID()));
    url.searchParams.set('instancia_id', String(requireActiveInstId()));
    const r = await authFetch(url.toString(), {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({config:data})
    });
    let body = null;
    try { body = await r.json(); } catch { body = await r.text(); }
    if(!r.ok){
      const detail = typeof body === 'object' && body?.detail ? body.detail : body;
      throw new Error(humanizeErrorDetail(detail));
    }
    return body;
  }

  // ===== render/load =====
  async function loadAll(){
    cfg = await getConfig(); ensureMasters(cfg);

    // masters
    setHeaderSwitch(swAutoHdr, pillAutoHdr, !!cfg.features.auto_messages.enabled);
    setHeaderSwitch(swDeptHdr, pillDeptHdr, !!cfg.features.auto_messages_departments.enabled);

    // bloco 1 — Automáticas
    const w = cfg.features.auto_messages.welcome || {};
    setSwitch(swWelcome, !!w.enabled, pillWelcome);
    if(msgWelcome) msgWelcome.value = w.text ?? 'Olá! 👋 Como posso ajudar?';
    if(wStart) wStart.value = w.start ?? '08:00';
    if(wEnd)   wEnd.value   = w.end   ?? '18:00';
    if(wcCount) wcCount.textContent = `${(msgWelcome?.value||'').length} caracteres`;

    const o = cfg.features.auto_messages.off_hours || {};
    setSwitch(swOff, !!o.enabled, pillOff);
    if(msgOff) msgOff.value = o.text ?? 'Atendemos de 08:00 às 18:00. Deixe sua mensagem e responderemos no próximo expediente.';
    if(oStart) oStart.value = o.start ?? '18:00';
    if(oEnd)   oEnd.value   = o.end   ?? '08:00';
    if(offCount) offCount.textContent = `${(msgOff?.value||'').length} caracteres`;

    setAutoChildrenEnabled(!!cfg.features.auto_messages.enabled);
    renderWelcomePreview(); renderOffPreview();

    // bloco 2 — Departamentos
    const dw = cfg.features.auto_messages_departments.welcome || {};
    setSwitch(swDeptWelcome, !!dw.enabled, pillDeptWelcome);
    if(msgDeptWelcome){
      msgDeptWelcome.value = (dw.text ?? '').trim();
      if(!msgDeptWelcome.value){ msgDeptWelcome.value = buildDeptWelcomeExample(null); }
      if(dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
    }
    if(dwStart) dwStart.value = dw.start ?? '08:00';
    if(dwEnd)   dwEnd.value   = dw.end   ?? '18:00';

    setDeptChildrenEnabled(!!cfg.features.auto_messages_departments.enabled);

    attachDeptSuggestions(msgDeptWelcome).catch(()=>{});
    updateScheduleVisibility(); updateSaveButtons();
  }

  // ===== save =====
  async function saveAutoBlock(){
    enforceExclusive('auto');
    cfg.features.auto_messages.welcome = {
      ...(cfg.features.auto_messages.welcome||{}),
      enabled:getSwitch(swWelcome),
      text:(msgWelcome?.value||'').trim(),
      start:(wStart&&wStart.value)||'08:00',
      end:(wEnd&&wEnd.value)||'18:00'
    };
    cfg.features.auto_messages.off_hours = {
      ...(cfg.features.auto_messages.off_hours||{}),
      enabled:getSwitch(swOff),
      text:(msgOff?.value||'').trim(),
      start:(oStart&&oStart.value)||'18:00',
      end:(oEnd&&oEnd.value)||'08:00'
    };
    try{
      await putConfig(cfg);
      toast('Mensagens automáticas salvas (exclusivas).','success');
    }catch(e){
      showErrorModal('Falha ao salvar', e.message || String(e));
    }
  }

  async function saveDeptBlock(){
    enforceExclusive('dept');
    cfg.features.auto_messages_departments.welcome = {
      ...(cfg.features.auto_messages_departments.welcome||{}),
      enabled:getSwitch(swDeptWelcome),
      text:(msgDeptWelcome?.value||'').trim(),
      start:(dwStart&&dwStart.value)||'08:00',
      end:(dwEnd&&dwEnd.value)||'18:00'
    };
    try{
      await putConfig(cfg);
      toast('Mensagem de boas-vindas por departamento salva (exclusiva).','success');
    }catch(e){
      showErrorModal('Falha ao salvar', e.message || String(e));
    }
  }

  // ===== eventos/boot =====
  function bindUI(){
    bindAccordion(headAuto, bodyAuto);
    bindAccordion(headAutoDept, bodyAutoDept);

    bindSwitch(swAutoHdr, pillAutoHdr, (on)=>{ if(on)enforceExclusive('auto'); else{ cfg.features.auto_messages.enabled=false; setAutoChildrenEnabled(false); updateSaveButtons(); updateScheduleVisibility(); } });
    bindSwitch(swDeptHdr, pillDeptHdr, (on)=>{ if(on)enforceExclusive('dept'); else{ cfg.features.auto_messages_departments.enabled=false; setDeptChildrenEnabled(false); updateSaveButtons(); } });

    bindSwitch(swWelcome, pillWelcome, (on)=>{ (cfg.features.auto_messages.welcome ||= {}).enabled=on; if(on&&!getSwitch(swAutoHdr)) enforceExclusive('auto'); });
    bindSwitch(swOff, pillOff, (on)=>{ (cfg.features.auto_messages.off_hours ||= {}).enabled=on; if(on&&!getSwitch(swAutoHdr)) enforceExclusive('auto'); });
    bindSwitch(swDeptWelcome, pillDeptWelcome, (on)=>{ (cfg.features.auto_messages_departments.welcome ||= {}).enabled=on; if(on&&!getSwitch(swDeptHdr)) enforceExclusive('dept'); });

    msgWelcome?.addEventListener('input',()=>{ if(wcCount) wcCount.textContent = `${msgWelcome.value.length} caracteres`; renderWelcomePreview(); });
    wStart?.addEventListener('change',()=> (cfg.features.auto_messages.welcome.start = wStart.value));
    wEnd?.addEventListener('change',()=> (cfg.features.auto_messages.welcome.end   = wEnd.value));

    msgOff?.addEventListener('input',()=>{ if(offCount) offCount.textContent = `${msgOff.value.length} caracteres`; renderOffPreview(); });
    oStart?.addEventListener('change',()=> (cfg.features.auto_messages.off_hours.start = oStart.value));
    oEnd  ?.addEventListener('change',()=> (cfg.features.auto_messages.off_hours.end   = oEnd.value));

    msgDeptWelcome?.addEventListener('input',()=>{ if(dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`; });
    dwStart?.addEventListener('change',()=> (cfg.features.auto_messages_departments.welcome.start = dwStart.value));
    dwEnd  ?.addEventListener('change',()=> (cfg.features.auto_messages_departments.welcome.end   = dwEnd.value));

    saveAuto?.addEventListener('click',()=> saveAutoBlock());
    cancelAuto?.addEventListener('click',()=> loadAll());
    saveDept?.addEventListener('click',()=> saveDeptBlock());
    cancelDept?.addEventListener('click',()=> loadAll());
  }

  async function initInstDropdown(){
    if(!instBtn||!instMenu||!instList) return;
    if(!window.CSS) window.CSS={}; if(typeof CSS.escape!=='function') CSS.escape=(v)=>String(v??'').replace(/["\\]/g,'\\$&').replace(/\s/g,'\\ ');

    function openMenu(){ instMenu.setAttribute('aria-hidden','false'); instBtn.setAttribute('aria-expanded','true'); (instList.querySelector('.inst-item[aria-selected="true"]')||instList.querySelector('.inst-item'))?.focus(); document.addEventListener('mousedown',onDocClick); document.addEventListener('keydown',onKey); }
    function closeMenu(){ instMenu.setAttribute('aria-hidden','true'); instBtn.setAttribute('aria-expanded','false'); document.removeEventListener('mousedown',onDocClick); document.removeEventListener('keydown',onKey); }
    function toggleMenu(){ (instMenu.getAttribute('aria-hidden')!=='false')?openMenu():closeMenu(); }
    function onDocClick(e){ if(!instMenu.contains(e.target)&&e.target!==instBtn) closeMenu(); }
    function onKey(e){
      if(e.key==='Escape'){ e.preventDefault(); closeMenu(); instBtn.focus(); }
      if(instMenu.getAttribute('aria-hidden')==='true') return;
      const items=Array.from(instList.querySelectorAll('.inst-item')); const i=items.indexOf(document.activeElement);
      if(e.key==='ArrowDown'){ e.preventDefault(); (items[i+1]||items[0])?.focus(); }
      if(e.key==='ArrowUp'){ e.preventDefault(); (items[i-1]||items[items.length-1])?.focus(); }
      if(e.key==='Home'){ e.preventDefault(); items[0]?.focus(); }
      if(e.key==='End'){ e.preventDefault(); items[items.length-1]?.focus(); }
      if(e.key==='Enter'||e.key===' '){ const a=document.activeElement; if(a&&a.classList.contains('inst-item')){ e.preventDefault(); selectValue(a.dataset.value,a.dataset.label); } }
    }
    instBtn.addEventListener('click',toggleMenu);

    const empresaId=EMPRESA_ID();
    const instValue=(i)=> i.instancia_id ?? i.id ?? i.instance_id ?? i.session ?? i.sessionName ?? '';
    const instLabel2=(i,v)=> i.apelido || i.nome || i.instance_name || String(v) || 'Instância';

    function itemTpl(text,value,selected){
      const li=document.createElement('li'); const b=document.createElement('button'); b.type='button'; b.className='inst-item'; b.setAttribute('role','option');
      b.setAttribute('aria-selected',selected?'true':'false'); b.tabIndex=-1; b.dataset.value=String(value??''); b.dataset.label=text;
      b.innerHTML=`<span class="radio" aria-hidden="true"></span><span>${text}</span>`; b.addEventListener('click',()=>selectValue(String(value??''),text));
      li.appendChild(b); return li;
    }

    function setActiveUI(value,text){
      instList.querySelectorAll('.inst-item').forEach(b=>b.setAttribute('aria-selected', b.dataset.value===String(value)?'true':'false'));
      const active=instList.querySelector(`.inst-item[data-value="${CSS.escape(value)}"]`);
      if(active) instMenu.setAttribute('aria-activedescendant', active.id || (active.id='inst-opt-chat-'+String(value||'x')));
      instLabel.textContent = text || (value ? `Instância ${value}` : 'Selecione uma instância');
    }

    function selectValue(value,text){
      window.__INST_ID = value ? Number(String(value).replace(/\D/g,'')) : '';
      setActiveUI(value,text);
      if(window.__INST_ID){ lockUI(false); loadAll().catch(err=>showErrorModal('Erro', String(err?.message||err))); }
      else { lockUI(true,'Selecione uma instância para configurar o chatbot.'); }
      closeMenu(); instBtn.focus();
    }

    async function loadList(){
      instList.innerHTML=''; let items=[];
      if(empresaId){
        try{
          const r=await fetch(`/api/empresas/${empresaId}/whatsapp`,{credentials:'include'}); if(!r.ok) throw 0;
          const j=await r.json(); items = Array.isArray(j.instancias)? j.instancias : [];
        }catch{
          try{
            const r2=await fetch(`/api/instancias/list?empresa_id=${empresaId}`,{credentials:'include'});
            const j2=await r2.json(); items = Array.isArray(j2)? j2 : (Array.isArray(j2?.instancias) ? j2.instancias : []);
          }catch{}
        }
      }

      items.forEach(i=>{ const v=String(instValue(i)??''); const t=instLabel2(i,v); instList.appendChild(itemTpl(t,v,false)); });

      if(window.__INST_ID==null||window.__INST_ID===''){
        const firstConnected = items.find(x=>!!(x.connected||x.conectada||x.status==='CONNECTED'));
        const firstAny = items[0]; const chosen = firstConnected || firstAny;
        window.__INST_ID = chosen ? Number(String(instValue(chosen)||'').replace(/\D/g,'')) : '';
      }

      if(window.__INST_ID){
        const sel=instList.querySelector(`.inst-item[data-value="${CSS.escape(String(window.__INST_ID))}"]`);
        const text=sel?.dataset?.label || `Instância ${window.__INST_ID}`;
        setActiveUI(String(window.__INST_ID),text); lockUI(false);
      }else{
        setActiveUI('','Selecione uma instância'); lockUI(true,'Nenhuma instância disponível. Conecte um WhatsApp primeiro.');
      }
    }

    await loadList();
  }

  function bindUI(){
    bindAccordion(headAuto, bodyAuto);
    bindAccordion(headAutoDept, bodyAutoDept);

    bindSwitch(swAutoHdr, pillAutoHdr, (on)=>{ if(on) enforceExclusive('auto'); else { cfg.features.auto_messages.enabled=false; setAutoChildrenEnabled(false); updateSaveButtons(); updateScheduleVisibility(); } });
    bindSwitch(swDeptHdr, pillDeptHdr, (on)=>{ if(on) enforceExclusive('dept'); else { cfg.features.auto_messages_departments.enabled=false; setDeptChildrenEnabled(false); updateSaveButtons(); } });

    bindSwitch(swWelcome, pillWelcome, (on)=>{ (cfg.features.auto_messages.welcome ||= {}).enabled=on; if(on&&!getSwitch(swAutoHdr)) enforceExclusive('auto'); });
    bindSwitch(swOff, pillOff, (on)=>{ (cfg.features.auto_messages.off_hours ||= {}).enabled=on; if(on&&!getSwitch(swAutoHdr)) enforceExclusive('auto'); });
    bindSwitch(swDeptWelcome, pillDeptWelcome, (on)=>{ (cfg.features.auto_messages_departments.welcome ||= {}).enabled=on; if(on&&!getSwitch(swDeptHdr)) enforceExclusive('dept'); });

    msgWelcome?.addEventListener('input',()=>{ if(wcCount) wcCount.textContent = `${msgWelcome.value.length} caracteres`; renderWelcomePreview(); });
    wStart?.addEventListener('change',()=> (cfg.features.auto_messages.welcome.start = wStart.value));
    wEnd  ?.addEventListener('change',()=> (cfg.features.auto_messages.welcome.end   = wEnd.value));

    msgOff?.addEventListener('input',()=>{ if(offCount) offCount.textContent = `${msgOff.value.length} caracteres`; renderOffPreview(); });
    oStart?.addEventListener('change',()=> (cfg.features.auto_messages.off_hours.start = oStart.value));
    oEnd  ?.addEventListener('change',()=> (cfg.features.auto_messages.off_hours.end   = oEnd.value));

    msgDeptWelcome?.addEventListener('input',()=>{ if(dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`; });
    dwStart?.addEventListener('change',()=> (cfg.features.auto_messages_departments.welcome.start = dwStart.value));
    dwEnd  ?.addEventListener('change',()=> (cfg.features.auto_messages_departments.welcome.end   = dwEnd.value));

    saveAuto?.addEventListener('click',()=> saveAutoBlock());
    cancelAuto?.addEventListener('click',()=> loadAll());
    saveDept?.addEventListener('click',()=> saveDeptBlock());
    cancelDept?.addEventListener('click',()=> loadAll());
  }

  async function boot(){
    try{
      bindUI();
      await initInstDropdown();
      const id=getActiveInstId();
      if(!id){ lockUI(true,'Selecione uma instância para configurar o chatbot.'); return; }
      lockUI(false);
      await loadAll();
    }catch(e){
      if(String(e&&e.message)==='INST_REQUIRED'){ lockUI(true,'Selecione uma instância para configurar o chatbot.'); return; }
      showErrorModal('Falha ao carregar', e?.message || String(e));
    }
  }

  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', boot, {once:true}); } else { boot(); }
})();
