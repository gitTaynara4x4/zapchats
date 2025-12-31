// /frontend/js/pages/chatbot.js
// Chatbot Config – Notificações amigáveis + validação (complementar opcional) + placeholders {empresa}/{setor}
(() => {
  'use strict';

  /* ================= sessão/fetch ================= */
  const LS = localStorage;
  const EMPRESA_ID   = () => Number(LS.getItem('empresa_id') || 0);
  const EMPRESA_NOME = () => (LS.getItem('empresa_nome') || '[Empresa]').trim();
  const TOKEN        = () => LS.getItem('token') || LS.getItem('auth_token') || '';

  // Fuso padrão (alinha com horário de Brasília)
  const FALLBACK_TZ = 'America/Sao_Paulo';

  async function authFetch(input, init = {}) {
    const t = TOKEN();
    const headers = { ...(init.headers||{}), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
    return fetch(input, { ...init, headers, credentials: 'include' });
  }

  /* ================= UI helpers: toast + notice ================= */
  function el(tag, cls){ const e=document.createElement(tag); if(cls) e.className=cls; return e; }

  function ensureToastHost(){
    let host=document.getElementById('toast-host');
    if(!host){
      host=el('div','toast-host');
      host.id='toast-host';
      host.style.cssText='position:fixed;right:16px;top:16px;display:flex;flex-direction:column;gap:10px;z-index:9999';
      document.body.appendChild(host);
    }
    return host;
  }

  function toast(message, kind='ok', ms=2400){
    const host=ensureToastHost();
    const t=el('div','toast');
    t.style.cssText='padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--card);box-shadow:0 10px 40px rgba(0,0,0,.25);font-weight:800;min-width:220px';
    if(kind==='warn') t.style.borderColor='rgba(245,158,11,.45)';
    if(kind==='bad')  t.style.borderColor='rgba(244,63,94,.40)';
    if(kind==='ok')   t.style.borderColor='rgba(34,197,94,.40)';
    t.textContent=message;
    host.appendChild(t);
    setTimeout(()=>{ t.style.opacity='0'; t.style.transform='translateY(-6px)'; t.style.transition='all .18s ease'; }, ms);
    setTimeout(()=>t.remove(), ms+220);
  }

  function notify({title='Atenção', message='', details='', kind='warn', actions=[]}){
    const overlay=el('div','notice-ov');
    overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px';
    const card=el('div','notice');
    card.style.cssText='width:min(640px,96vw);background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:0 22px 80px rgba(0,0,0,.35);padding:14px 14px 12px';
    const head=el('div'); head.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px';
    const h=el('div'); h.style.cssText='font-size:1.05rem;font-weight:900';
    h.textContent=title;
    const x=el('button'); x.className='btn'; x.textContent='Fechar';
    x.addEventListener('click',()=>overlay.remove());
    head.append(h,x);

    const p=el('div');
    p.style.cssText='white-space:pre-wrap;color:var(--fg);line-height:1.4;font-weight:650;padding:6px 2px 8px';
    p.textContent=message;

    let detWrap=null;
    if(details){
      detWrap=el('details');
      detWrap.style.cssText='margin-top:10px;border:1px dashed var(--border);border-radius:12px;padding:10px;background:color-mix(in oklab, var(--card) 92%, transparent)';
      const sum=el('summary'); sum.textContent='Detalhes técnicos';
      sum.style.cssText='cursor:pointer;font-weight:800;color:var(--muted)';
      const pre=el('pre');
      pre.style.cssText='white-space:pre-wrap;margin:10px 0 0;font-size:.86rem;color:var(--muted)';
      pre.textContent=details;
      detWrap.append(sum,pre);
    }

    const footer=el('div');
    footer.style.cssText='display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap';
    const ok=el('button','btn primary'); ok.textContent='OK';
    ok.addEventListener('click',()=>overlay.remove());
    footer.append(...actions, ok);

    card.append(head,p,detWrap,footer); overlay.appendChild(card);
    overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  /* ================= DOM ================= */
  const instBtn   = document.getElementById('instMenuBtnChat');
  const instMenu  = document.getElementById('inst-menu-chat');
  const instList  = document.getElementById('instMenuListChat');
  const instLabel = document.getElementById('instMenuLabelChat');
  const instRequiredBanner = document.getElementById('instRequiredBanner');

  const swAutoHdr = document.getElementById('swAutoHdr');
  const pillAutoHdr = document.getElementById('pillAutoHdr');
  const swDeptHdr = document.getElementById('swDeptHdr');
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
  const prevOText = document.getElementById('prevOText');

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

  // seletor de departamentos (modo 2)
  const deptSearch = document.getElementById('deptSearch');
  const deptAll    = document.getElementById('deptAll');
  const deptNone   = document.getElementById('deptNone');
  const deptList   = document.getElementById('deptList');
  const deptCount  = document.getElementById('deptCount');

  const schedWelcome = document.getElementById('schedWelcome');
  const schedOff     = document.getElementById('schedOff');
  const schedDeptWelcomeEl = document.getElementById('schedDeptWelcome');

  /* ================= estado ================= */
  let cfg=null, _lastLoadedSnapshot=null;

  // cache/ctx
  let _deptCache = null; // [{id,nome}]
  let _empresaNome = (LS.getItem('empresa_nome') || '').trim();

  /* ================= util ================= */
  function safeJsonParse(s){ try{ return JSON.parse(s); }catch{ return null; } }

  function getActiveInstKey(){
    return String(window.__INST_ID || LS.getItem('instancia_id') || '').trim();
  }
  function requireActiveInstKey(){
    const k=getActiveInstKey();
    if(!k) throw new Error('Selecione uma instância.');
    return k;
  }
  function normalizeInstValue(v){ return String(v||'').trim(); }

  function setSwitch(sw,on,pill){
    if(!sw) return;
    const input=sw.querySelector('input');
    if(input) input.checked=!!on;
    sw.setAttribute('data-on', on ? 'true' : 'false');
    if(pill){
      pill.classList.toggle('on', !!on);
      pill.classList.toggle('off', !on);
      pill.textContent = on ? 'on' : 'off';
    }
  }
  function getSwitch(el){ return !!el?.querySelector('input')?.checked; }
  function setHeaderSwitch(el,pill,on){ setSwitch(el,on,pill); el?.setAttribute('aria-pressed',on?'true':'false'); }
  function deepMerge(base,extra){
    if(!extra||typeof extra!=='object') return base;
    const out=Array.isArray(base)?base.slice():{...base};
    for(const k of Object.keys(extra)){
      const v=extra[k];
      out[k]=(v&&typeof v==='object'&&!Array.isArray(v))?deepMerge(out[k]||{},v):v;
    }
    return out;
  }
  function insertAtCaret(ta,text){
    if(!ta) return;
    const s=ta.selectionStart??ta.value.length, e=ta.selectionEnd??ta.value.length;
    ta.value=ta.value.slice(0,s)+text+ta.value.slice(e);
    ta.selectionStart=ta.selectionEnd=s+text.length;
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    ta.focus();
  }

  /* ================= defaults locais ================= */
  const LOCAL_DEFAULTS = {
    timezone: FALLBACK_TZ,
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

  /* ================= templates ================= */
  function expandTemplate(text, {empresa,setor}={}){
    const e = (empresa||_empresaNome||EMPRESA_NOME()).trim() || '[Empresa]';
    const s = (setor||'').trim() || '{setor}';
    return String(text||'')
      .replaceAll('{empresa}', e)
      .replaceAll('{setor}', s);
  }

  function buildWelcomeListaEmpresaDept(){
    const empresa = (_empresaNome||EMPRESA_NOME()||'[Empresa]').trim();
    return `Olá! 👋 Você está falando com a ${empresa}. Como posso ajudar?`;
  }

  function buildDeptWelcomeExample(setor){
    const empresa = (_empresaNome||EMPRESA_NOME()||'[Empresa]').trim();
    const start = (dwStart&&dwStart.value)||'08:00';
    const end   = (dwEnd&&dwEnd.value)||'18:00';
    return expandTemplate(
      `Olá! 👋 Você está falando com o setor ${setor||'{setor}'} da ${empresa}. ` +
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
    // acrescenta chips com nomes de departamentos (se houver)
    if (Array.isArray(_deptCache)) {
      _deptCache.slice(0, 12).forEach(d => {
        const nome = d?.nome || d?.name || d?.titulo || d?.title;
        if (nome) chips.push({ label: `# ${nome}`, insert: nome });
      });
    }
    chips.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = c.label;
      b.addEventListener('click', () => insertAtCaret(textarea, (c.insert || c.label) + ' '));
      wrap.appendChild(b);
    });
  }

  /* ================= dept picker (lista de departamentos) ================= */
  function ensureDeptItems(c){
    const ad = c?.features?.auto_messages_departments || (c.features.auto_messages_departments = {enabled:false, welcome:{enabled:false,text:"",start:"08:00",end:"18:00"}});
    if(!ad.items || typeof ad.items !== 'object' || Array.isArray(ad.items)) ad.items = {};
    return ad.items;
  }

  function seedDeptItemsFromCache(c){
    // Se não houver "items" no config, inicializa com TODOS os departamentos marcados
    // (pra bater com sua expectativa: mostra tudo e já vem selecionado).
    if(!Array.isArray(_deptCache) || !_deptCache.length) return;
    const items = ensureDeptItems(c);
    const hasAny = Object.keys(items).length > 0;
    if(!hasAny){
      _deptCache.forEach(d=>{
        const id = String(d.id);
        items[id] = { enabled:true, label: String(d.nome||'').trim() };
      });
    } else {
      // garante label se faltar
      _deptCache.forEach(d=>{
        const id = String(d.id);
        if(items[id] && (!items[id].label || !String(items[id].label).trim())){
          items[id].label = String(d.nome||'').trim();
        }
      });
    }
  }

  function setDeptPickerEnabled(enabled){
    if(deptSearch) deptSearch.disabled = !enabled;
    if(deptAll)    deptAll.disabled    = !enabled;
    if(deptNone)   deptNone.disabled   = !enabled;
    if(deptList){
      deptList.classList.toggle('disabled', !enabled);
      deptList.querySelectorAll('input[type="checkbox"]').forEach(ch => (ch.disabled = !enabled));
    }
  }

  function countSelectedDeptItems(c){
    const items = ensureDeptItems(c);
    return Object.values(items).reduce((acc,it)=> acc + (it?.enabled ? 1 : 0), 0);
  }

  function renderDeptPicker(){
    if(!deptList) return;
    const items = ensureDeptItems(cfg || {});
    const q = String(deptSearch?.value || '').trim().toLowerCase();
    deptList.innerHTML = '';

    if(!Array.isArray(_deptCache) || !_deptCache.length){
      const empty = document.createElement('div');
      empty.className = 'dept-empty';
      empty.textContent = 'Nenhum departamento encontrado. Cadastre/ative departamentos para usar o modo 2.';
      deptList.appendChild(empty);
      deptCount && (deptCount.textContent = '0 selecionados');
      return;
    }

    // render
    const list = _deptCache
      .map(d => ({ id:String(d.id), nome:String(d.nome||'').trim() }))
      .filter(d => d.nome)
      .filter(d => !q || d.nome.toLowerCase().includes(q));

    list.forEach(d=>{
      const row = document.createElement('label');
      row.className = 'dept-row';
      row.setAttribute('data-id', d.id);

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!items[d.id]?.enabled;
      chk.addEventListener('change', ()=>{
        items[d.id] = { ...(items[d.id]||{}), enabled: !!chk.checked, label: items[d.id]?.label || d.nome };
        // mantém config sincronizado
        cfg.features.auto_messages_departments.items = items;
        deptCount && (deptCount.textContent = `${countSelectedDeptItems(cfg)} selecionados`);
        updateSaveButtons();
      });

      const name = document.createElement('span');
      name.className = 'dept-name';
      name.textContent = d.nome;

      row.appendChild(chk);
      row.appendChild(name);
      deptList.appendChild(row);
    });

    deptCount && (deptCount.textContent = `${countSelectedDeptItems(cfg||{})} selecionados`);
    setDeptPickerEnabled(!!cfg?.features?.auto_messages_departments?.enabled);
  }

  /* ================= acordeões & UI ================= */
  function setAccordionOpen(head, body, open){
    head?.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.style.height = open ? 'auto' : '0px';
    body.style.opacity = open ? '1' : '0';
    body.style.pointerEvents = open ? 'auto' : 'none';
    body.setAttribute('aria-hidden', open ? 'false' : 'true');
    head?.closest('.card')?.querySelector('.chev')?.classList.toggle('open', open);
  }
  function bindAccordion(head, body){
    if(!head||!body) return;
    head.addEventListener('click', (e)=>{
      if(e.target?.closest?.('.tswitch')) return;
      const open = head.getAttribute('aria-expanded')!=='true';
      setAccordionOpen(head, body, open);
    });
  }

  function bindSwitch(sw, pill, onChange){
    if(!sw) return;
    const input = sw.querySelector('input');
    const toggle = ()=>{
      if(input && input.disabled) return;
      const on = !getSwitch(sw);
      setSwitch(sw,on,pill);
      sw.setAttribute('aria-pressed',on?'true':'false');
      onChange?.(on);
    };
    sw.addEventListener('click', (e)=>{ if(e.target===input) return; toggle(); });
    input?.addEventListener('change', ()=>{ setSwitch(sw, input.checked, pill); onChange?.(!!input.checked); });
    sw.addEventListener('keydown', (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); }});
  }

  function lockUI(locked, msg=''){
    instRequiredBanner?.classList.toggle('show', !!locked);
    if(instRequiredBanner) instRequiredBanner.textContent = msg || 'Selecione uma instância para configurar o chatbot.';
    document.querySelectorAll('button, textarea, input[type="time"]').forEach(el=>{
      if(el===instBtn) return;
      el.disabled = !!locked;
    });
  }

  function setAutoChildrenEnabled(enabled){
    swWelcome?.classList.toggle('disabled',!enabled);
    swOff?.classList.toggle('disabled',!enabled);
    swWelcome?.querySelector('input')&&(swWelcome.querySelector('input').disabled=!enabled);
    swOff?.querySelector('input')&&(swOff.querySelector('input').disabled=!enabled);
    msgWelcome && (msgWelcome.disabled=!enabled||!getSwitch(swWelcome));
    msgOff && (msgOff.disabled=!enabled||!getSwitch(swOff));
    if(wStart) wStart.disabled=!enabled; if(wEnd) wEnd.disabled=!enabled;
    if(oStart) oStart.disabled=!enabled; if(oEnd) oEnd.disabled=!enabled;
    updateScheduleVisibility();
  }
  function setDeptChildrenEnabled(enabled){
    swDeptWelcome?.classList.toggle('disabled',!enabled);
    swDeptWelcome?.querySelector('input')&&(swDeptWelcome.querySelector('input').disabled=!enabled);
    msgDeptWelcome && (msgDeptWelcome.disabled=!enabled||!getSwitch(swDeptWelcome));
    if(dwStart) dwStart.disabled=!enabled; if(dwEnd) dwEnd.disabled=!enabled;
    setDeptPickerEnabled(enabled);
    updateScheduleVisibility();
  }
  function ensureMasters(c){
    c.features??={}; c.features.auto_messages??={};
    if(typeof c.features.auto_messages.enabled!=='boolean'){ c.features.auto_messages.enabled=false; }
    c.features.auto_messages_departments??={ enabled:false, welcome:{enabled:false,text:"",start:"08:00",end:"18:00"}, items:{} };
    c.timezone = (c.timezone||'').trim() || FALLBACK_TZ;
  }

  function enforceExclusive(which){
    if(which==='auto'){
      setHeaderSwitch(swAutoHdr,pillAutoHdr,true);
      setHeaderSwitch(swDeptHdr,pillDeptHdr,false);
      cfg.features.auto_messages.enabled=true;
      cfg.features.auto_messages_departments.enabled=false;
      setAccordionOpen(headAutoDept,bodyAutoDept,false);
      setAccordionOpen(headAuto,bodyAuto,true);
      setAutoChildrenEnabled(true); setDeptChildrenEnabled(false);
    }
    if(which==='dept'){
      setHeaderSwitch(swDeptHdr,pillDeptHdr,true);
      setHeaderSwitch(swAutoHdr,pillAutoHdr,false);
      cfg.features.auto_messages_departments.enabled=true;
      cfg.features.auto_messages.enabled=false;
      setAccordionOpen(headAuto,bodyAuto,false);
      setAccordionOpen(headAutoDept,bodyAutoDept,true);
      setDeptChildrenEnabled(true); setAutoChildrenEnabled(false);
    }
  }

  function updateScheduleVisibility(){
    const wOn = getSwitch(swWelcome) && getSwitch(swAutoHdr);
    const oOn = getSwitch(swOff) && getSwitch(swAutoHdr);
    const dwOn = getSwitch(swDeptWelcome) && getSwitch(swDeptHdr);

    schedWelcome?.classList.toggle('show', !!wOn);
    schedOff?.classList.toggle('show', !!oOn);
    schedDeptWelcomeEl?.classList.toggle('show', !!dwOn);
  }

  function updateSaveButtons(){
    if(saveAuto) saveAuto.disabled=!getSwitch(swAutoHdr);
    if(saveDept) saveDept.disabled=!getSwitch(swDeptHdr);
  }

  /* ================= API ================= */
  async function getConfig(){
    const url = new URL('/api/chatbot/config', location.origin);
    url.searchParams.set('empresa_id', String(EMPRESA_ID()));
    url.searchParams.set('instancia_id', requireActiveInstKey());
    const r = await authFetch(url.toString());
    if(!r.ok) throw new Error(`GET config ${r.status}`);
    const data = await r.json();

    // 👇 novo: capturar nome da empresa e departamentos
    if (data?.empresa_nome) {
      _empresaNome = String(data.empresa_nome).trim();
      try { LS.setItem('empresa_nome', _empresaNome); } catch {}
    }
    if (Array.isArray(data?.departamentos)) {
      _deptCache = data.departamentos.map(d => ({ id: d.id, nome: d.nome })).filter(Boolean);
    }

    const merged = deepMerge(structuredClone(LOCAL_DEFAULTS), data?.config || {});
    merged.timezone = (merged.timezone||'').trim() || FALLBACK_TZ;
    return merged;
  }

  async function putConfig(data){
    data.timezone = (data.timezone||'').trim() || FALLBACK_TZ;

    const url = new URL('/api/chatbot/config', location.origin);
    url.searchParams.set('empresa_id', String(EMPRESA_ID()));
    url.searchParams.set('instancia_id', requireActiveInstKey());

    const r = await authFetch(url.toString(), {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(data)
    });
    if(!r.ok){
      const t = await r.text().catch(()=> '');
      throw new Error(`PUT config ${r.status}\n${t}`);
    }
    return r.json().catch(()=> ({}));
  }

  /* ================= validação ================= */
  function markInvalid(el,on=true){
    if(!el) return;
    el.style.borderColor = on ? 'rgba(244,63,94,.55)' : '';
    el.style.boxShadow   = on ? '0 0 0 3px rgba(244,63,94,.15)' : '';
  }
  function timeValid(v){ return /^\d{2}:\d{2}$/.test(String(v||'')); }
  function hhmmToMin(v){ const [h,m]=String(v).split(':').map(Number); return (h*60+m)%1440; }
  function m2hhmm(m){ const h=Math.floor(m/60)%24; const mm=m%60; return String(h).padStart(2,'0')+':'+String(mm).padStart(2,'0'); }
  function overlap(aS,aE,bS,bE){
    const norm=(s,e)=> (e>s)?[[s,e]]:[[s,1440],[0,e]];
    const A=norm(aS,aE), B=norm(bS,bE);
    for(const [as,ae] of A) for(const [bs,be] of B){
      const s=Math.max(as,bs), e=Math.min(ae,be);
      if(e>s) return [s,e];
    }
    return null;
  }
  function isComplement(ws,we,os,oe){
    const W = overlap(ws,we,os,oe)===null;
    if(!W) return false;
    const covers = (ws<we && os>oe) || (ws>we && os<oe) || (ws===oe && we===os);
    return covers;
  }

  function validateBeforeSave(kind='auto'){
    [wStart,wEnd,oStart,oEnd,dwStart,dwEnd,msgWelcome,msgOff,msgDeptWelcome].forEach(x=>markInvalid(x,false));
    const errors=[]; const fixes=[];

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
      if(!getSwitch(swWelcome) && !getSwitch(swOff)){ errors.push('Ative ao menos uma mensagem (Boas-vindas ou Fora do horário).'); }

      const both = getSwitch(swWelcome)&&getSwitch(swOff)
        && timeValid(wStart?.value||'')&&timeValid(wEnd?.value||'')
        && timeValid(oStart?.value||'')&&timeValid(oEnd?.value||'');
      if(both){
        const ws=hhmmToMin(wStart.value), we=hhmmToMin(wEnd.value);
        const os=hhmmToMin(oStart.value), oe=hhmmToMin(oEnd.value);
        const ov = overlap(ws,we,os,oe);
        if(ov){
          const [s,e]=ov;
          errors.push(`Os horários se sobrepõem entre ${m2hhmm(s)} e ${m2hhmm(e)}.`);
          markInvalid(oStart,true); markInvalid(wEnd,true);
          const fix=document.createElement('button');
          fix.type='button'; fix.textContent=`Ajustar “Fora do horário → Início” para ${wEnd.value}`;
          fix.style.cssText='padding:8px 12px;border-radius:10px;background:#10b981;color:#111827;border:0;font-weight:700;cursor:pointer';
          fix.addEventListener('click',()=>{ oStart.value=wEnd.value; markInvalid(oStart,false); markInvalid(wEnd,false); toast('Corrigido: sem sobreposição.'); });
          fixes.push(fix);
        } else if (!isComplement(ws,we,os,oe)){
          const fix=document.createElement('button');
          fix.type='button'
          fix.textContent='Ajustar para complementar (recomendado)';
          fix.style.cssText='padding:8px 12px;border-radius:10px;background:#93c5fd;color:#111827;border:0;font-weight:800;cursor:pointer';
          fix.addEventListener('click',()=>{ oStart.value=wEnd.value; oEnd.value=wStart.value; toast('Boas-vindas e “Fora do horário” complementada.'); });
          errors.push('Os intervalos não são complementares (pode sobrar horário sem mensagem).');
          fixes.push(fix);
        }
      }
    }

    if(kind==='dept' && getSwitch(swDeptHdr)){
      if(getSwitch(swDeptWelcome)){
        if(!msgDeptWelcome?.value?.trim()) { errors.push('Mensagem de departamentos não pode ficar vazia.'); markInvalid(msgDeptWelcome,true); }
        if(dwStart && !timeValid(dwStart.value)) { errors.push('Horário inicial (departamentos) inválido.'); markInvalid(dwStart,true); }
        if(dwEnd && !timeValid(dwEnd.value))   { errors.push('Horário final (departamentos) inválido.'); markInvalid(dwEnd,true); }
      } else {
        errors.push('Ative a mensagem de departamentos para salvar este bloco.');
      }

      // precisa ter pelo menos 1 departamento selecionado
      if (Array.isArray(_deptCache) && _deptCache.length){
        const sel = countSelectedDeptItems(cfg||{});
        if(sel <= 0){
          errors.push('Selecione ao menos 1 departamento para a triagem.');
        }
      }
    }

    if(errors.length){
      const msg='Por favor, revise os pontos abaixo:\n\n• '+errors.join('\n• ');
      notify({title:'Não conseguimos salvar', message:msg, kind:'warn', actions:fixes});
      return false;
    }
    return true;
  }

  /* ================= render previews ================= */
  function renderWelcomePreview(){
    if(!prevWText) return;
    const txt = expandTemplate(msgWelcome?.value||buildWelcomeListaEmpresaDept(), {empresa:_empresaNome});
    prevWText.textContent = txt;
  }
  function renderOffPreview(){
    if(!prevOText) return;
    const txt = expandTemplate(msgOff?.value||'', {empresa:_empresaNome});
    prevOText.textContent = txt;
  }

  function maybeFillWelcome(){
    if(!msgWelcome) return;
    if(!msgWelcome.value.trim()){
      msgWelcome.value = buildWelcomeListaEmpresaDept();
      wcCount && (wcCount.textContent = `${msgWelcome.value.length} caracteres`);
      renderWelcomePreview();
    }
  }

  function maybeFillDeptWelcomeExample(setor){
    if(!msgDeptWelcome) return;
    if(!msgDeptWelcome.value.trim()){
      msgDeptWelcome.value = buildDeptWelcomeExample(setor);
      dwCount && (dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`);
    }
    // sempre expande tokens
    msgDeptWelcome.value = expandTemplate(msgDeptWelcome.value);
    if(dwCount) dwCount.textContent = `${msgDeptWelcome.value.length} caracteres`;
  }

  /* ================= load/render ================= */
  async function loadAll(){
    cfg = await getConfig(); ensureMasters(cfg);

    // inicializa seleção padrão (todos os deps marcados) quando ainda não existe "items"
    seedDeptItemsFromCache(cfg);

    // Snapshot p/ botão Cancelar
    _lastLoadedSnapshot = JSON.stringify(cfg);

    setHeaderSwitch(swAutoHdr, pillAutoHdr, !!cfg.features.auto_messages.enabled);
    setHeaderSwitch(swDeptHdr, pillDeptHdr, !!cfg.features.auto_messages_departments.enabled);

    const w = cfg.features.auto_messages.welcome || {};
    setSwitch(swWelcome, !!w.enabled, pillWelcome);
    if(msgWelcome) msgWelcome.value = w.text ?? buildWelcomeListaEmpresaDept();
    if(wStart) wStart.value = w.start ?? '08:00';
    if(wEnd)   wEnd.value   = w.end   ?? '18:00';
    if(wcCount) wcCount.textContent = `${(msgWelcome?.value||'').length} caracteres`;
    // garante placeholders
    maybeFillWelcome();

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

    // chips + dept list
    attachDeptSuggestions(msgDeptWelcome);
    renderDeptPicker();

    updateScheduleVisibility(); updateSaveButtons();
  }

  /* ================= salvar ================= */
  async function saveAutoBlock(){
    if(!validateBeforeSave('auto')) return;
    cfg.timezone = (cfg.timezone||'').trim() || FALLBACK_TZ;

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
    try{ await putConfig(cfg); toast('Mensagem automática salva.'); _lastLoadedSnapshot = JSON.stringify(cfg); }catch(_e){}
  }

  async function saveDeptBlock(){
    if(!validateBeforeSave('dept')) return;
    cfg.timezone = (cfg.timezone||'').trim() || FALLBACK_TZ;

    enforceExclusive('dept');
    cfg.features.auto_messages_departments.welcome = {
      ...(cfg.features.auto_messages_departments.welcome||{}),
      enabled:getSwitch(swDeptWelcome),
      text:(msgDeptWelcome?.value||'').trim(),
      start:(dwStart&&dwStart.value)||'08:00',
      end:(dwEnd&&dwEnd.value)||'18:00'
    };
    try{ await putConfig(cfg); toast('Mensagem por departamento salva.'); _lastLoadedSnapshot = JSON.stringify(cfg); }catch(_e){}
  }

  function restoreSnapshot(){
    try{
      if(!_lastLoadedSnapshot) return;
      cfg = JSON.parse(_lastLoadedSnapshot);
      ensureMasters(cfg);

      setHeaderSwitch(swAutoHdr, pillAutoHdr, !!cfg.features.auto_messages.enabled);
      setHeaderSwitch(swDeptHdr, pillDeptHdr, !!cfg.features.auto_messages_departments.enabled);

      const w = cfg.features.auto_messages.welcome || {};
      setSwitch(swWelcome, !!w.enabled, pillWelcome);
      if(msgWelcome) msgWelcome.value = w.text ?? buildWelcomeListaEmpresaDept();
      if(wStart) wStart.value = w.start ?? '08:00';
      if(wEnd)   wEnd.value   = w.end   ?? '18:00';
      if(wcCount) wcCount.textContent = `${(msgWelcome?.value||'').length} caracteres`;

      const o = cfg.features.auto_messages.off_hours || {};
      setSwitch(swOff, !!o.enabled, pillOff);
      if(msgOff) msgOff.value = o.text ?? '';
      if(oStart) oStart.value = o.start ?? '18:00';
      if(oEnd)   oEnd.value   = o.end   ?? '08:00';
      if(offCount) offCount.textContent = `${(msgOff?.value||'').length} caracteres`;

      const dw = cfg.features.auto_messages_departments.welcome || {};
      setSwitch(swDeptWelcome, !!dw.enabled, pillDeptWelcome);
      if(msgDeptWelcome) msgDeptWelcome.value = (dw.text ?? '').trim() || buildDeptWelcomeExample(null);
      if(dwCount) dwCount.textContent = `${(msgDeptWelcome?.value||'').length} caracteres`;
      if(dwStart) dwStart.value = dw.start ?? '08:00';
      if(dwEnd)   dwEnd.value   = dw.end   ?? '18:00';

      setAutoChildrenEnabled(!!cfg.features.auto_messages.enabled);
      setDeptChildrenEnabled(!!cfg.features.auto_messages_departments.enabled);
      renderWelcomePreview(); renderOffPreview();
      attachDeptSuggestions(msgDeptWelcome);
      renderDeptPicker();
      updateScheduleVisibility(); updateSaveButtons();
    }catch(e){}
  }

  /* ================= inst dropdown ================= */
  async function initInstDropdown(){
    if(!instBtn||!instMenu||!instList) return;
    if(!window.CSS) window.CSS={}; if(typeof CSS.escape!=='function') CSS.escape=(v)=>String(v??'').replace(/["\\]/g,'\\$&').replace(/\s/g,'\\ ');

    function openMenu(){
      instMenu.setAttribute('aria-hidden','false');
      instBtn.setAttribute('aria-expanded','true');
      (instList.querySelector('.inst-item[aria-selected="true"]')||instList.querySelector('.inst-item'))?.focus();
      document.addEventListener('mousedown',onDocClick);
      document.addEventListener('keydown',onKey);
    }
    function closeMenu(){
      instMenu.setAttribute('aria-hidden','true');
      instBtn.setAttribute('aria-expanded','false');
      document.removeEventListener('mousedown',onDocClick);
      document.removeEventListener('keydown',onKey);
    }
    function toggleMenu(){ (instMenu.getAttribute('aria-hidden')!=='false')?openMenu():closeMenu(); }
    function onDocClick(e){ if(!instMenu.contains(e.target)&&e.target!==instBtn) closeMenu(); }
    function onKey(e){
      if(e.key==='Escape'){ closeMenu(); instBtn.focus(); }
    }

    function setActiveUI(value,text){
      instList.querySelectorAll('.inst-item').forEach(x=>x.setAttribute('aria-selected','false'));
      const active = value ? instList.querySelector(`[data-value="${CSS.escape(String(value))}"]`) : null;
      active?.setAttribute('aria-selected','true');
      if(instList) instList.setAttribute('aria-activedescendant', active?.id || '');
      if(instLabel) instLabel.textContent = text || (value ? `Instância ${value}` : 'Selecione uma instância');
    }

    function selectValue(value,text){
      window.__INST_ID = value ? normalizeInstValue(value) : '';
      setActiveUI(value,text);
      if(window.__INST_ID){
        lockUI(false);
        loadAll().catch(e=>{
          notify({title:'Erro', message:String(e?.message||e), details:String(e?.stack||'')});
        });
      } else {
        lockUI(true,'Selecione uma instância para configurar o chatbot.');
      }
      closeMenu(); instBtn.focus();
    }

    async function loadList(){
      instList.innerHTML='';
      let items=[];
      const empresaId=EMPRESA_ID();
      if(empresaId){
        try{
          const r=await authFetch(`/api/empresas/${empresaId}/whatsapp`,{credentials:'include'});
          if(r.ok){
            const data=await r.json();
            items = Array.isArray(data)?data:(data?.items||[]);
          }
        }catch{}
      }

      items = (items||[]).map(x=>({
        id: x?.id ?? x?.instancia_id ?? x?.instanciaId,
        name: x?.instance_name ?? x?.nome ?? x?.name ?? x?.titulo ?? `Instância ${x?.id}`
      })).filter(x=>x.id);

      if(!items.length){
        const it=el('div','inst-item'); it.textContent='Nenhuma instância encontrada.'; it.style.color='var(--muted)';
        instList.appendChild(it);
        return;
      }

      items.forEach((it,idx)=>{
        const b=el('div','inst-item');
        b.id='inst-opt-chat-'+String(it.id);
        b.tabIndex=0;
        b.setAttribute('role','option');
        b.setAttribute('data-value', String(it.id));
        b.setAttribute('aria-selected','false');

        const left=el('div');
        left.innerHTML = `<div style="font-weight:900">${it.name}</div><div class="inst-badge">ID ${it.id}</div>`;
        const right=el('div'); right.innerHTML='<i class="fa-solid fa-check" style="opacity:.65"></i>';
        b.append(left,right);

        b.addEventListener('click', ()=>selectValue(it.id,it.name));
        b.addEventListener('keydown', (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); selectValue(it.id,it.name); }});
        instList.appendChild(b);
      });

      const current=getActiveInstKey();
      if(current){
        const found=items.find(x=>String(x.id)===String(current));
        if(found) setActiveUI(found.id, found.name);
      }
    }

    instBtn.addEventListener('click', toggleMenu);
    await loadList();
  }

  /* ================= boot ================= */
  async function boot(){
    try{
      bindAccordion(headAuto, bodyAuto);
      bindAccordion(headAutoDept, bodyAutoDept);

      bindSwitch(swAutoHdr, pillAutoHdr, (on)=>{ if(on)enforceExclusive('auto'); else { cfg.features.auto_messages.enabled=false; setAutoChildrenEnabled(false); } updateSaveButtons(); updateScheduleVisibility(); });
      bindSwitch(swDeptHdr, pillDeptHdr, (on)=>{ if(on)enforceExclusive('dept'); else { cfg.features.auto_messages_departments.enabled=false; setDeptChildrenEnabled(false); } updateSaveButtons(); });

      bindSwitch(swWelcome, pillWelcome, (on)=>{ if(cfg){ (cfg.features.auto_messages.welcome||{}).enabled=on; } if(on&&!getSwitch(swAutoHdr)) enforceExclusive('auto'); });
      bindSwitch(swOff, pillOff, (on)=>{ if(cfg){ (cfg.features.auto_messages.off_hours||{}).enabled=on; } if(on&&!getSwitch(swAutoHdr)) enforceExclusive('auto'); });
      bindSwitch(swDeptWelcome, pillDeptWelcome, (on)=>{ if(cfg){ (cfg.features.auto_messages_departments.welcome||{}).enabled=on; } if(on&&!getSwitch(swDeptHdr)) enforceExclusive('dept'); });

      msgWelcome?.addEventListener('input',()=>{ msgWelcome.value = expandTemplate(msgWelcome.value); wcCount&&(wcCount.textContent=`${msgWelcome.value.length} caracteres`); renderWelcomePreview(); });
      wStart?.addEventListener('change',()=> { if(cfg?.features?.auto_messages?.welcome) cfg.features.auto_messages.welcome.start = wStart.value; });
      wEnd  ?.addEventListener('change',()=> { if(cfg?.features?.auto_messages?.welcome) cfg.features.auto_messages.welcome.end   = wEnd.value; });
      msgOff?.addEventListener('input',()=>{ offCount&&(offCount.textContent=`${msgOff.value.length} caracteres`); renderOffPreview(); });
      oStart?.addEventListener('change',()=> { if(cfg?.features?.auto_messages?.off_hours) cfg.features.auto_messages.off_hours.start = oStart.value; });
      oEnd  ?.addEventListener('change',()=> { if(cfg?.features?.auto_messages?.off_hours) cfg.features.auto_messages.off_hours.end   = oEnd.value; });
      msgDeptWelcome?.addEventListener('input',()=>{ msgDeptWelcome.value = expandTemplate(msgDeptWelcome.value); dwCount&&(dwCount.textContent=`${msgDeptWelcome.value.length} caracteres`); });
      dwStart?.addEventListener('change',()=> { if(cfg?.features?.auto_messages_departments?.welcome) cfg.features.auto_messages_departments.welcome.start = dwStart.value; });
      dwEnd  ?.addEventListener('change',()=> { if(cfg?.features?.auto_messages_departments?.welcome) cfg.features.auto_messages_departments.welcome.end   = dwEnd.value; });

      // dept picker
      deptSearch?.addEventListener('input', ()=>{ renderDeptPicker(); });

      deptAll?.addEventListener('click', ()=>{
        if(!cfg) return;
        const items = ensureDeptItems(cfg);
        (_deptCache||[]).forEach(d=>{
          const id = String(d.id);
          const nome = String(d.nome||'').trim();
          items[id] = { ...(items[id]||{}), enabled:true, label: items[id]?.label || nome };
        });
        cfg.features.auto_messages_departments.items = items;
        renderDeptPicker();
        updateSaveButtons();
      });

      deptNone?.addEventListener('click', ()=>{
        if(!cfg) return;
        const items = ensureDeptItems(cfg);
        (_deptCache||[]).forEach(d=>{
          const id = String(d.id);
          const nome = String(d.nome||'').trim();
          items[id] = { ...(items[id]||{}), enabled:false, label: items[id]?.label || nome };
        });
        cfg.features.auto_messages_departments.items = items;
        renderDeptPicker();
        updateSaveButtons();
      });

      saveAuto?.addEventListener('click', saveAutoBlock);
      saveDept?.addEventListener('click', saveDeptBlock);
      cancelAuto?.addEventListener('click', restoreSnapshot);
      cancelDept?.addEventListener('click', restoreSnapshot);

      await initInstDropdown();
      const key=getActiveInstKey();
      if(!key){ lockUI(true,'Selecione uma instância para configurar o chatbot.'); return; }
      lockUI(false);
      await loadAll();
    }catch(e){
      notify({title:'Erro', message:String(e?.message||e), details:String(e?.stack||'')});
    }
  }

  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', boot, {once:true}); } else { boot(); }
})();
