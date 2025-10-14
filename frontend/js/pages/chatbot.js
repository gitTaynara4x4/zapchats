// Chatbot Config – Notificações amigáveis + validação antes do PUT (sem logs no console)
(() => {
  'use strict';

  /* ================= sessão/fetch ================= */
  const LS = localStorage;
  const EMPRESA_ID   = () => Number(LS.getItem('empresa_id') || 0);
  const EMPRESA_NOME = () => (LS.getItem('empresa_nome') || '[Empresa]').trim();
  const TOKEN        = () => LS.getItem('token') || LS.getItem('auth_token') || '';
  async function authFetch(input, init = {}) {
    const t = TOKEN();
    const headers = { ...(init.headers||{}), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
    return fetch(input, { ...init, headers, credentials: 'include' });
  }

  /* ================= UI helpers: toast + notice ================= */
  function el(tag, cls){ const e=document.createElement(tag); if(cls) e.className=cls; return e; }

  // host dos toasts, topo-direito
  function ensureToastHost(){
    let host=document.getElementById('toast-host');
    if(!host){
      host=el('div','toast-host');
      host.id='toast-host';
      host.style.cssText='position:fixed;right:16px;top:16px;z-index:99999;display:flex;flex-direction:column;gap:8px';
      document.body.appendChild(host);
    }
    return host;
  }
  function toast(msg, kind='success'){
    const host=ensureToastHost();
    const box=el('div','toast');
    box.style.cssText='min-width:280px;max-width:520px;padding:12px 14px;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.25);font:14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;transition:.25s';
    const color = kind==='error' ? '#fee2e2' : kind==='warn' ? '#fef3c7' : '#dbeafe';
    const fg    = '#0f172a';
    box.style.background = color; box.style.color = fg;
    box.textContent = msg;
    ensureToastHost().appendChild(box);
    setTimeout(()=>{ box.style.opacity='0'; box.style.transform='translateY(-6px)'; setTimeout(()=>box.remove(), 240); }, 2800);
  }

  // cartão de notificação (amigável) com “ver detalhes”
  function notify({title='Atenção', message='', kind='warn', details=null, actions=[]}={}){
    let overlay=el('div');
    overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px';
    const card=el('div');
    card.style.cssText='width:min(620px,96vw);background:#0b0b13;color:#e5e7eb;border:1px solid #1f2937;border-radius:16px;padding:18px 18px 14px;box-shadow:0 10px 40px rgba(0,0,0,.45);font:14px/1.5 system-ui';
    const head=el('div'); head.style.cssText='font-weight:700;font-size:16px;margin-bottom:8px;display:flex;gap:8px;align-items:center';
    const dot=el('span'); dot.style.cssText='width:10px;height:10px;border-radius:50%'; dot.style.background = kind==='error'?'#ef4444':(kind==='warn'?'#f59e0b':'#60a5fa');
    const h=el('span'); h.textContent=title;
    head.append(dot,h);

    const p=el('div'); p.textContent=message; p.style.marginBottom='8px';

    const detWrap=el('div'); detWrap.style.display = details ? '' : 'none';
    const toggle=el('button'); toggle.type='button'; toggle.textContent='Ver detalhes técnicos';
    toggle.style.cssText='background:none;border:0;color:#93c5fd;text-decoration:underline;cursor:pointer;padding:0;margin:6px 0';
    const pre=el('pre');
    pre.textContent=details || '';
    pre.style.cssText='white-space:pre-wrap;margin:8px 0 0;background:#0f172a;border:1px solid #1f2937;border-radius:10px;padding:10px;max-height:38vh;overflow:auto;font-size:12px;display:none';
    toggle.addEventListener('click',()=>{ pre.style.display = pre.style.display==='none' ? 'block' : 'none'; });
    detWrap.append(toggle,pre);

    const footer=el('div'); footer.style.cssText='display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    const ok=el('button'); ok.type='button'; ok.textContent='OK';
    ok.style.cssText='padding:8px 14px;border-radius:10px;background:#c7d2fe;color:#111827;border:0;font-weight:600;cursor:pointer';
    ok.addEventListener('click',()=>overlay.remove());
    footer.append(...actions, ok);

    card.append(head,p,detWrap,footer);
    overlay.addEventListener('click', (e)=>{ if(e.target===overlay) overlay.remove(); });
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // mensagens simples por status
  function friendlyHttpError(status, detailText=''){
    const msgs = {
      0:   ['Sem conexão', 'Não conseguimos falar com o servidor. Confira sua internet e tente novamente.'],
      400: ['Não foi possível salvar', 'Revise os horários (HH:MM) e os textos das mensagens.'],
      401: ['Sessão expirada', 'Faça login novamente para continuar.'],
      403: ['Permissão negada', 'Você não pode alterar esta instância.'],
      404: ['Instância não encontrada', 'Selecione outra instância e tente novamente.'],
      409: ['Conflito', 'As configurações mudaram enquanto você editava. Recarregamos os dados.'],
      422: ['Dados incompletos', 'Preencha os campos obrigatórios e salve de novo.'],
      429: ['Muitas tentativas', 'Aguarde alguns segundos e tente novamente.'],
      500: ['Ops! Algo deu errado', 'Falha no servidor. Tente novamente em instantes.']
    };
    const key = (status>=500) ? 500 : (msgs[status] ? status : 0);
    const [title, message] = msgs[key];
    return { title, message, details: detailText || '' };
  }

  /* ================= dropdown de instâncias ================= */
  const instBtn   = document.getElementById('instMenuBtnChat');
  const instLabel = document.getElementById('instMenuLabelChat');
  const instMenu  = document.getElementById('inst-menu-chat');
  const instList  = document.getElementById('instMenuListChat');

  function getActiveInstId(){ const raw = window.__INST_ID ?? ''; const id = Number(String(raw).replace(/\D/g,'')); return Number.isFinite(id)&&id>0? id:0; }
  function requireActiveInstId(){ const id = getActiveInstId(); if(!id) throw new Error('INST_REQUIRED'); return id; }
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

  /* ================= refs DOM ================= */
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

  const schedWelcome = document.getElementById('schedWelcome');
  const schedOff     = document.getElementById('schedOff');
  const schedDeptWelcomeEl = document.getElementById('schedDeptWelcome'); // ✅ evitar duplicidade

  /* ================= estado ================= */
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

  /* ================= utils ================= */
  function setSwitch(el,on,pillEl){ if(!el) return; el.dataset.on=on?'true':'false'; const input=el.querySelector('input'); if(input) input.checked=!!on; if(pillEl){ pillEl.textContent=on?'on':'off'; pillEl.classList.toggle('on',!!on); pillEl.classList.toggle('off',!on); } }
  function getSwitch(el){ return !!el?.querySelector('input')?.checked; }
  function setHeaderSwitch(el,pill,on){ setSwitch(el,on,pill); el?.setAttribute('aria-pressed',on?'true':'false'); }
  function deepMerge(base,extra){ if(!extra||typeof extra!=='object') return base; const out=Array.isArray(base)?base.slice():{...base}; for(const k of Object.keys(extra)){ const v=extra[k]; out[k]=(v&&typeof v==='object'&&!Array.isArray(v))?deepMerge(out[k]||{},v):v; } return out; }
  function insertAtCaret(ta,text){ if(!ta) return; const s=ta.selectionStart??ta.value.length, e=ta.selectionEnd??ta.value.length; ta.value=ta.value.slice(0,s)+text+ta.value.slice(e); const pos=s+text.length; ta.focus(); try{ta.setSelectionRange(pos,pos);}catch{} if(ta===msgWelcome&&wcCount) wcCount.textContent=`${ta.value.length} caracteres`; if(ta===msgDeptWelcome&&dwCount) dwCount.textContent=`${ta.value.length} caracteres`; if(ta===msgWelcome) renderWelcomePreview(); }

  function timeValid(v){
    if(typeof v!=='string' || !/^\d{2}:\d{2}$/.test(v)) return false;
    const [h,m] = v.split(':').map(n=>Number(n));
    return h>=0 && h<=23 && m>=0 && m<=59;
  }

  function markInvalid(el, on=true){
    if(!el) return;
    el.setAttribute('aria-invalid', on ? 'true' : 'false');
    el.style.outline = on ? '2px solid #ef4444' : '';
    el.style.outlineOffset = on ? '2px' : '';
  }

  /* ======= helpers DEPARTAMENTO que faltavam ======= */
  function buildDeptWelcomeExample(dep) {
    const setor   = (dep && (dep.nome || dep.name || dep.titulo || dep.title)) || '{setor}';
    const empresa = EMPRESA_NOME() || '{empresa}';
    const start   = (dwStart && dwStart.value) || '08:00';
    const end     = (dwEnd   && dwEnd.value)   || '18:00';
    return (
      `Olá! 👋 Você está falando com o setor ${setor} da ${empresa}. ` +
      `Estamos aqui para ajudar. ` +
      `Atendemos de ${start} às ${end}. ` +
      `Para agilizar, por favor diga seu nome e bairro.`
    );
  }

  function attachDeptSuggestions(textarea) {
    const wrap = document.getElementById('deptChips');
    if (!wrap || !textarea) return;

    wrap.innerHTML = '';

    const chips = [
      { label: '{setor}',   insert: '{setor}' },
      { label: '{empresa}', insert: '{empresa}' },
      { label: '⏰ Horário', insert: `Atendemos de ${(dwStart&&dwStart.value)||'08:00'} às ${(dwEnd&&dwEnd.value)||'18:00'}.` },
      { label: '🙋 Nome + Bairro', insert: 'Por favor, informe seu nome e bairro.' },
      { label: '🎯 Direcionar', insert: 'Vou direcionar sua solicitação ao responsável do setor.' },
    ];

    (async () => {
      try {
        if (!_deptCache) {
          const empId = Number(localStorage.getItem('empresa_id') || '') || null;
          if (empId) {
            const urls = [
              `/api/departamentos?empresa_id=${empId}`,
              `/api/departamentos/list?empresa_id=${empId}`,
              `/api/departamentos/all?empresa_id=${empId}`,
            ];
            for (const u of urls) {
              const r = await fetch(u, { credentials: 'include' });
              if (r.ok) {
                const j = await r.json();
                const arr = Array.isArray(j)
                  ? j
                  : (Array.isArray(j?.items) ? j.items
                  : (Array.isArray(j?.departamentos) ? j.departamentos : []));
                if (arr.length) { _deptCache = arr; break; }
              }
            }
          }
        }
        if (Array.isArray(_deptCache)) {
          _deptCache.slice(0, 12).forEach(d => {
            const nome = d?.nome || d?.name || d?.titulo || d?.title;
            if (nome) chips.push({ label: `# ${nome}`, insert: nome });
          });
        }
      } catch {}

      chips.forEach(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = c.label;
        b.addEventListener('click', () => insertAtCaret(textarea, (c.insert || c.label) + ' '));
        wrap.appendChild(b);
      });
    })();
  }

  /* ================= acordeões ================= */
  function setAccordionOpen(head, body, open){
    head?.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.style.height = open ? 'auto' : '0px';
    body.style.opacity = open ? '1' : '0';
    body.style.pointerEvents = open ? 'auto' : 'none';
    body.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  function bindAccordion(head, body){ head?.addEventListener('click',()=>{ const open=head.getAttribute('aria-expanded')==='true'; setAccordionOpen(head,body,!open); }); }

  /* ================= visibilidade horários ================= */
  function updateScheduleVisibility(){
    const masterAutoOn = getSwitch(swAutoHdr);
    const welcomeOn = masterAutoOn && getSwitch(swWelcome);
    const offOn     = masterAutoOn && getSwitch(swOff);
    if(schedWelcome) schedWelcome.classList.toggle('show', welcomeOn);
    if(schedOff)     schedOff.classList.toggle('show', offOn);

    const masterDeptOn = getSwitch(swDeptHdr);
    const deptWOn = masterDeptOn && getSwitch(swDeptWelcome);
    if(schedDeptWelcomeEl) schedDeptWelcomeEl.classList.toggle('show', deptWOn);
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

  /* ================= exclusividade ================= */
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

  /* ================= previews ================= */
  function renderWelcomePreview(){
    const enabled = getSwitch(swWelcome)&&getSwitch(swAutoHdr);
    if(prevW) prevW.style.display = enabled ? '' : 'none';
    if(prevWText) prevWText.textContent = (msgWelcome?.value || '—').trim() || '—';
  }
  function renderOffPreview(){
    const enabled = getSwitch(swOff)&&getSwitch(swAutoHdr);
    if(prevO){ prevO.style.display = enabled ? '' : 'none'; prevO.textContent = (msgOff?.value || '—').trim() || '—'; }
  }

  /* ================= switches ================= */
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

  /* ================= API ================= */
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

    let body=''; let text=''; let detail='';
    try { body = await r.json(); text = ''; detail = body?.detail ? (typeof body.detail==='string'? body.detail : JSON.stringify(body.detail)) : ''; }
    catch { text = await r.text(); detail = text; }

    if(!r.ok){
      const {title, message, details} = friendlyHttpError(r.status, detail);
      notify({ title, message, kind: (r.status>=400?'error':'warn'), details });
      throw new Error(message);
    }
    return body || {};
  }

  /* ================= validação (evita 400) ================= */
  function validateBeforeSave(kind='auto'){
    // limpa marcas
    [wStart,wEnd,oStart,oEnd,dwStart,dwEnd,msgWelcome,msgOff,msgDeptWelcome].forEach(x=>markInvalid(x,false));

    const errors=[];

    if(kind==='auto' && getSwitch(swAutoHdr)){
      if(getSwitch(swWelcome)){
        if(!msgWelcome?.value?.trim()) { errors.push('Mensagem de boas-vindas não pode ficar vazia.'); markInvalid(msgWelcome,true); }
        if(wStart && !timeValid(wStart.value)) { errors.push('Horário inicial da Boas-vindas inválido.'); markInvalid(wStart,true); }
        if(wEnd && !timeValid(wEnd.value))   { errors.push('Horário final da Boas-vindas inválido.'); markInvalid(wEnd,true); }
      }
      if(getSwitch(swOff)){
        if(!msgOff?.value?.trim()) { errors.push('Mensagem de fora do horário não pode ficar vazia.'); markInvalid(msgOff,true); }
        if(oStart && !timeValid(oStart.value)) { errors.push('Horário inicial de Fora do horário inválido.'); markInvalid(oStart,true); }
        if(oEnd && !timeValid(oEnd.value))   { errors.push('Horário final de Fora do horário inválido.'); markInvalid(oEnd,true); }
      }
      if(!getSwitch(swWelcome) && !getSwitch(swOff)){
        errors.push('Ative ao menos uma mensagem (Boas-vindas ou Fora do horário).');
      }
    }

    if(kind==='dept' && getSwitch(swDeptHdr)){
      if(getSwitch(swDeptWelcome)){
        if(!msgDeptWelcome?.value?.trim()) { errors.push('Mensagem por departamento não pode ficar vazia.'); markInvalid(msgDeptWelcome,true); }
        if(dwStart && !timeValid(dwStart.value)) { errors.push('Horário inicial (departamentos) inválido.'); markInvalid(dwStart,true); }
        if(dwEnd && !timeValid(dwEnd.value))   { errors.push('Horário final (departamentos) inválido.'); markInvalid(dwEnd,true); }
      } else {
        errors.push('Ative a mensagem de departamentos para salvar este bloco.');
      }
    }

    if(errors.length){
      const msg = 'Por favor, revise os pontos abaixo:\n\n• ' + errors.join('\n• ');
      notify({ title:'Não conseguimos salvar', message: msg, kind:'warn' });
      return false;
    }
    return true;
  }

  /* ================= load/render ================= */
  async function loadAll(){
    cfg = await getConfig(); ensureMasters(cfg);

    setHeaderSwitch(swAutoHdr, pillAutoHdr, !!cfg.features.auto_messages.enabled);
    setHeaderSwitch(swDeptHdr, pillDeptHdr, !!cfg.features.auto_messages_departments.enabled);

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

    const dw = cfg.features.auto_messages_departments.welcome || {};
    setSwitch(swDeptWelcome, !!dw.enabled, pillDeptWelcome);
    if(msgDeptWelcome){
      msgDeptWelcome.value = (dw.text ?? '').trim() || buildDeptWelcomeExample(null);
      if(dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
    }
    if(dwStart) dwStart.value = dw.start ?? '08:00';
    if(dwEnd)   dwEnd.value   = dw.end   ?? '18:00';
    setDeptChildrenEnabled(!!cfg.features.auto_messages_departments.enabled);

    attachDeptSuggestions(msgDeptWelcome);
    updateScheduleVisibility(); updateSaveButtons();
  }

  /* ================= save handlers ================= */
  async function saveAutoBlock(){
    if(!validateBeforeSave('auto')) return;

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
      toast('Configurações salvas com sucesso.','success');
    }catch(_e){/* notify já exibido no putConfig */ }
  }

  async function saveDeptBlock(){
    if(!validateBeforeSave('dept')) return;

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
      toast('Mensagem por departamento salva.','success');
    }catch(_e){/* notify já exibido */ }
  }

  /* ================= boot ================= */
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
      if(instLabel) instLabel.textContent = text || (value ? `Instância ${value}` : 'Selecione uma instância');
    }
    function selectValue(value,text){
      window.__INST_ID = value ? Number(String(value).replace(/\D/g,'')) : '';
      setActiveUI(value,text);
      if(window.__INST_ID){ lockUI(false); loadAll().catch(e=>{ const {title,message,details}=friendlyHttpError(0,String(e?.message||e)); notify({title,message,details}); }); }
      else { lockUI(true,'Selecione uma instância para configurar o chatbot.'); }
      closeMenu(); instBtn.focus();
    }

    async function loadList(){
      instList.innerHTML='';
      let items=[];
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

  async function boot(){
    try{
      bindUI();
      await initInstDropdown();
      const id=getActiveInstId();
      if(!id){ lockUI(true,'Selecione uma instância para configurar o chatbot.'); return; }
      lockUI(false);
      await loadAll();
    }catch(e){
      notify(friendlyHttpError(0, String(e?.message||e)));
    }
  }

  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', boot, {once:true}); } else { boot(); }
})();
