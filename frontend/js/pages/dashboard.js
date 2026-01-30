(function DashboardPage(){
  'use strict';

  // ======== CONFIG: Evolution direto (VISÍVEL NO FRONT!) ========
  const EVOLUTION_URL    = ""; // ex: "https://evolution.seu-dominio.com"
  const EVOLUTION_APIKEY = ""; // ex: "xxxxx"
  // ===============================================================

  // ===== helpers base =====
  const $  = (s, r=document)=> r.querySelector(s);
  const LS = localStorage;
  const onlyDigits = (s) => String(s ?? '').replace(/\D/g, '');

  // EMPRESA
  const EMPRESA_ID = Number(LS.getItem('empresa_id') || 0) || '';

  function getInstAtiva(){
    if (typeof window.__INST_ID !== 'undefined' && window.__INST_ID !== null && window.__INST_ID !== '')
      return Number(String(window.__INST_ID).replace(/\D/g,''));
    return '';
  }
  function getInstName(){
    const n = (window.__INST_NAME || '').trim();
    return n || '';
  }

  // cache local do mapa id -> instance_name
  let INST_MAP = null;

  async function ensureInstMap(){
    if (INST_MAP) return INST_MAP;
    try{
      // usa guardFetch/authFetch para respeitar 401/403
      const F = (window.ZAuth?.guardFetch || window.ZAuth?.authFetch || fetch);
      const r = await F(`/api/empresas/${EMPRESA_ID}/whatsapp`, { credentials:'include' });
      const j = await r.json();
      const arr = Array.isArray(j.instancias) ? j.instancias : [];
      INST_MAP = {};
      for (const it of arr){
        const id  = Number(onlyDigits(it.instancia_id ?? it.id ?? it.instance_id ?? it.session ?? it.sessionName ?? ''));
        const nm  = String(it.instance_name ?? it.instancia_slug ?? it.session ?? it.sessionName ?? it.apelido ?? it.nome ?? '').trim();
        INST_MAP[id||0] = { instance_name: nm, raw: it };
      }
    }catch{ INST_MAP = {}; }
    return INST_MAP;
  }

  // chamado pelo dropdown ao selecionar manualmente
  window.setInstanciaAtivaDashboard = function(idOuSlug, instanceName){
    window.__INST_ID = idOuSlug ? Number(String(idOuSlug).replace(/\D/g,'')) : '';
    window.__INST_NAME = (instanceName || '').trim();
    const elDate = document.getElementById('filtroData');
    const iso = (elDate?.value) || todayISO;
    loadAll(iso);
  };

  const hasChart = () => typeof window.Chart === 'function';

  // ===== regra esperta de "mobile" =====
  function isMobileLayout(){
    if (!window.matchMedia) return false;

    // Sempre mobile se for BEM estreito (≤900px)
    const narrow = window.matchMedia('(max-width: 900px)').matches;

    // Ou se for até 1024px E com pointer "coarse" (touch: celular/tablet)
    const narrowTouch = window.matchMedia('(max-width: 1024px) and (pointer: coarse)').matches;

    return narrow || narrowTouch;
  }

  const IS_MOBILE = isMobileLayout();

  const Loader = {
    show(text){
      if (window.PageLoading?.show) return PageLoading.show(text, { scope: '.main' });
      if (window.Loading?.show)     return Loading.show(text);
      if (typeof window.wait === 'function') return wait(text);
    },
    hide(){
      if (window.PageLoading?.hide) return PageLoading.hide();
      if (window.Loading?.hide)     return Loading.hide();
      if (typeof window.ready === 'function') return ready();
    }
  };

  // Paleta Moderna
  const PALETTE = ['#6366f1','#ec4899','#10b981','#f59e0b','#8b5cf6','#f43f5e','#06b6d4','#14b8a6'];

  const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const fmtDateISO = (d)=>{ const x = (d instanceof Date)? d : new Date(d);
    const m = String(x.getMonth()+1).padStart(2,'0'); const dd= String(x.getDate()).padStart(2,'0');
    return `${x.getFullYear()}-${m}-${dd}`; };
  const todayISO = fmtDateISO(new Date());

  function withParams(url, params){
    try{
      const u = new URL(url, location.origin);
      Object.entries(params||{}).forEach(([k,v])=>{ if (v!==undefined && v!==null && v!=='') u.searchParams.set(k, String(v)); });
      return u.toString();
    }catch{
      const qs = Object.entries(params||{}).filter(([,v])=>v!==undefined&&v!==null&&v!=='')
        .map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
      return url + (qs ? (url.includes('?')?'&':'?') + qs : '' );
    }
  }

  // >>> jfetch COM guard 401/403
  async function jfetch(url, opt={}){
    const F = (window.ZAuth?.guardFetch)
      ? ZAuth.guardFetch          // 401/403: redireciona para login/sem-permissao
      : (window.ZAuth?.authFetch) // 401: redireciona para login
        ? ZAuth.authFetch
        : fetch;

    const res = await F(url, { ...opt, headers: { 'Accept':'application/json', ...(opt.headers||{}) }, credentials:'include' });
    if (!res.ok) throw new Error(`${res.status}`);
    const ct = res.headers.get('content-type')||'';
    return /json/i.test(ct) ? res.json() : res.text();
  }

  // ===== elementos da UI =====
  const elCount       = $('#qtdAtendimentos');
  const elCardMsgs    = document.querySelector('.card-mensagens');
  const elCardAbert   = document.querySelector('.card-abertos');
  const elCardClient  = document.querySelector('.card-clientes');
  const elTableBody   = document.querySelector('#tabelaAtendimentos tbody');

  const elWppCard = document.querySelector('.card-wpp-status');
  const elWppTxt  = elWppCard?.querySelector('.status-text') || null;
  const elWppDot  = elWppCard?.querySelector('.status-dot')  || null;

  const lastBox    = document.getElementById('lastBox');
  const lastEmpty  = document.getElementById('lastEmpty');

  let chartPizza = null, chartFunil = null, DEMO_ACTIVE = false;

  // ===== modo demonstração =====
  function randInt(min, max){ return Math.floor(Math.random()*(max-min+1))+min; }
  function makeDemoCharts(seedStr=''){
    const seed = Array.from(String(seedStr||Date.now())).reduce((a,c)=> (a*31 + c.charCodeAt(0))>>>0, 7);
    function r(min,max){ return randInt(min + (seed%3), max + (seed%5)); }
    const pizzaLabels = ['Novos','Em atendimento','Concluídos','Sem resposta'];
    const pizzaData   = [r(8,16), r(10,22), r(6,14), r(1,5)];
    const funilLabels = ['Recebidas','Qualificadas','Em Progresso','Resolvidas'];
    const funilData   = [pizzaData.reduce((a,b)=>a+b,0), r(12,20), r(8,16), r(6,14)];
    return { distrib:{ labels:pizzaLabels, data:pizzaData }, funil:{ labels:funilLabels, data:funilData } };
  }

  function setDemoBadge(active){
    document.querySelectorAll('.charts .box .demo-badge').forEach(n=>n.remove());
    if(!active) return;
    const targets = [
      document.getElementById('pizzaAtendimento'),
      document.getElementById('funilAtendimento')
    ].filter(Boolean).map(c => c.closest('.box')).filter(Boolean);
    for (const box of targets){
      const b = document.createElement('div');
      b.className = 'demo-badge';
      b.textContent = 'Modo Demonstração';
      box.appendChild(b);
    }
  }

  // ===== render =====
  const setCount = (n)=>{ if (elCount) elCount.textContent = String(toNum(n) ?? 0); };
  const setText  = (el, v)=>{ if (el) el.textContent = String(toNum(v) ?? 0); };

  function renderCards(cards){
    setText(elCardMsgs,   cards?.mensagens_hoje);
    setText(elCardAbert,  cards?.abertos);
    setText(elCardClient, cards?.clientes_online);
  }

  function renderTable(list){
    if (!elTableBody) return;
    if (DEMO_ACTIVE) { elTableBody.innerHTML = ''; toggleEmptyState(true); return; }

    const optsTime = { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'America/Sao_Paulo' };
    const optsDate = { day:'2-digit', month:'2-digit', year:'numeric', timeZone:'America/Sao_Paulo' };

    const rows = (Array.isArray(list) ? list : []).map(item=>{
      const cliente = item.cliente || item.nome || item.cliente_nome || '-';
      const tel     = item.telefone || item.celular || item.whatsapp || '-';
      const status  = item.status || item.situacao || '-';

      const dt = item.created_at ? new Date(item.created_at) : null;
      const horario = dt ? dt.toLocaleTimeString('pt-BR', optsTime) : (item.hora || item.horario || '-');
      const data    = dt ? dt.toLocaleDateString('pt-BR', optsDate) : (item.data || '-');

      return `<tr><td>${cliente}</td><td>${tel}</td><td>${status}</td><td>${horario}</td><td>${data}</td></tr>`;
    }).join('');

    elTableBody.innerHTML = rows || '';
    toggleEmptyState(!(rows && rows.length));
  }

  function toggleEmptyState(empty){
    if (!lastBox || !lastEmpty) return;
    lastBox.classList.toggle('is-empty', !!empty);
    lastEmpty.hidden = !empty;

    if (empty) {
      const elDate = document.getElementById('filtroData');
      const muted = lastEmpty.querySelector('.muted');
      if (muted) {
        const val = elDate?.value?.trim();
        if (val) {
          muted.textContent = `Escolha outra data ou selecione outra instância. (Período: ${val})`;
        } else {
          muted.textContent = 'Escolha outra data ou selecione outra instância.';
        }
      }
    }
  }

  function upsertChart(ctx, prev, cfg){
    if (!hasChart() || !ctx) return null;
    if (prev) prev.destroy();
    return new Chart(ctx, cfg);
  }

  function renderPizza(distrib){
    const ctx = document.getElementById('pizzaAtendimento'); if (!hasChart() || !ctx) return;
    const labels = (distrib?.labels) || Object.keys(distrib?.data||{});
    const data   = Array.isArray(distrib?.data) ? distrib.data : labels.map(k => toNum(distrib?.data?.[k]) ?? 0);
    
    chartPizza = upsertChart(ctx, chartPizza, {
      type:'doughnut',
      data:{ 
        labels, 
        datasets:[{ 
          data, 
          backgroundColor: PALETTE.slice(0, data.length), 
          borderWidth:0,
          hoverOffset:10,
          borderRadius: 4,
          spacing: 2
        }] 
      },
      options:{
        responsive:true,
        cutout:'78%', // Anel mais fino e moderno
        plugins:{ 
          legend:{ 
            position:'right', 
            labels:{ 
              boxWidth:8, 
              boxHeight:8, 
              usePointStyle:true, 
              padding: 15,
              font: { size: 11, family: "'Plus Jakarta Sans', sans-serif" } 
            } 
          }, 
          tooltip:{ 
            mode:'index', 
            intersect:false,
            backgroundColor: 'rgba(9, 9, 11, 0.95)',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            padding: 10,
            cornerRadius: 8
          } 
        },
        layout: { padding: 10 }
      }
    });
  }

  function shortenFunnelLabel(label){
    if (!IS_MOBILE) return label;
    const map = { 'Recebidas':'Rec.','Qualificadas':'Quali.','Em Progresso':'Prog.','Resolvidas':'Res.' };
    if (map[label]) return map[label];
    const w = String(label).split(/\s+/);
    if (w.length === 1) return (w[0].slice(0,4) + (w[0].length>4?'.':'')); 
    return (w[0].slice(0,3) + '.'); 
  }

  function renderFunil(funil){
    const ctx = document.getElementById('funilAtendimento'); if (!hasChart() || !ctx) return;
    const labelsFull = (funil?.labels) || Object.keys(funil?.data||{});
    const labels     = labelsFull.map(shortenFunnelLabel);
    const data       = Array.isArray(funil?.data) ? funil.data : labelsFull.map(k => toNum(funil?.data?.[k]) ?? 0);

    chartFunil = upsertChart(ctx, chartFunil, {
      type:'bar',
      data:{ 
        labels, 
        datasets:[{ 
          data, 
          backgroundColor: PALETTE.slice(0, data.length), 
          borderWidth:0, 
          borderRadius: 6, // Barras arredondadas
          barThickness: 28, 
          maxBarThickness: 40 
        }] 
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ 
          legend:{ display:false },
          tooltip:{ 
            mode:'index', intersect:false,
            backgroundColor: 'rgba(9, 9, 11, 0.95)',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            cornerRadius: 8,
            padding: 10,
            callbacks:{ title: (items)=> { if (!items?.length) return ''; const i = items[0].dataIndex; return IS_MOBILE ? labelsFull[i] : items[0].label; } } 
          } 
        },
        scales:{ 
          y:{ 
            beginAtZero:true, 
            ticks:{ precision:0, color: '#71717a', font: {size: 10} }, 
            grid:{ color: '#27272a', drawBorder: false, tickLength: 0 } // Grade muito sutil
          }, 
          x:{ 
            grid:{ display:false, drawBorder: false }, // Sem grade vertical
            ticks:{ maxRotation:0, minRotation:0, autoSkip:true, maxTicksLimit: Math.min(5, labels.length), color: '#a1a1aa', font: {size: 11} } 
          } 
        }
      }
    });
  }

  // ===== dados =====
  async function fetchConsolidado(params){ return jfetch(withParams('/api/dashboard', params)); }
  async function fetchSeparado(params){
    const q = { ...params };
    const [cards, distrib, funil, ultimos] = await Promise.all([
      jfetch(withParams('/api/dashboard/cards', q)).catch(()=>null),
      jfetch(withParams('/api/dashboard/distribuicao', q)).catch(()=>null),
      jfetch(withParams('/api/dashboard/funil', q)).catch(()=>null),
      jfetch(withParams('/api/atendimentos/ultimos', q)).catch(()=>[])
    ]);
    return { cards, distrib, funil, ultimos };
  }
  function realTotalFrom(data, cards){
    const a = toNum(cards?.total_atendimentos); if (a !== null) return a;
    const b = toNum(data?.total_atendimentos); if (b !== null) return b;
    const c = Array.isArray(data?.ultimos) ? data.ultimos.length : null; if (c !== null) return c;
    return 0;
  }

  function instParams(){
    const inst = getInstAtiva();
    if (!inst) return {};
    return { instancia_id: inst };
  }

  // ===== Evolution direto (JS) =====
  function canUseEvolutionDirect(){
    return !!(EVOLUTION_URL && EVOLUTION_APIKEY);
  }

  async function fetchEvolutionState(instanceName){
    if (!canUseEvolutionDirect() || !instanceName) return null;
    try{
      const base = EVOLUTION_URL.replace(/\/$/,'');
      const url  = `${base}/instance/connectionState/${encodeURIComponent(instanceName)}`;
      const r = await fetch(url, { headers:{ 'apikey': EVOLUTION_APIKEY }});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const data  = j.instance || j;
      const state = String(data?.state || '').toLowerCase();
      const connected = ['open','connected','online'].includes(state);
      return { connected, state };
    }catch(e){
      console.warn('Evolution direct failed:', e);
      return null;
    }
  }

  // ===== status WhatsApp (via BACKEND) =====
  async function fetchWppStatus(params){
    try { return await jfetch(withParams('/api/whatsapp/status', params)); }
    catch { return null; }
  }
  function renderWppStatus(statusObj){
    if (!elWppCard || !elWppTxt || !elWppDot) return;
    let connected = !!statusObj?.online;
    const instId = getInstAtiva();
    if (instId && Array.isArray(statusObj?.detalhes)){
      const d = statusObj.detalhes.find(x => Number(x.id) === Number(instId));
      if (d && typeof d.connected !== 'undefined') connected = !!d.connected;
    }
    elWppTxt.textContent = connected ? 'Online' : 'Offline';
    elWppCard.classList.remove('ok','warn','bad');
    elWppDot.classList.remove('ok','warn','bad');
    if (connected){ elWppCard.classList.add('ok'); elWppDot.classList.add('ok'); }
    else { elWppCard.classList.add('bad'); elWppDot.classList.add('bad'); }
  }

  async function updateWhatsappCard(){
    let instName = getInstName();
    if (!instName){
      const map = await ensureInstMap();
      const id = getInstAtiva();
      if (id && map[id]?.instance_name) instName = map[id].instance_name;
    }
    let used = false;
    if (instName){
      const direct = await fetchEvolutionState(instName);
      if (direct){
        used = true;
        renderWppStatus({ online: !!direct.connected, detalhes:[{ id:getInstAtiva(), connected: !!direct.connected }]});
      }
    }
    if (!used){
      const status = await fetchWppStatus({ empresa_id: EMPRESA_ID, ...instParams() });
      if (status) renderWppStatus(status);
    }
  }

  async function loadAll(dateISO){
    const params = { empresa_id: EMPRESA_ID || undefined, date: dateISO || undefined, ...instParams() };
    Loader.show?.('Carregando…');
    try{
      let data;
      try { data = await fetchConsolidado(params); }
      catch { data = await fetchSeparado(params); }

      const cards   = data?.cards ?? {
        mensagens_hoje: data?.mensagens_hoje,
        abertos: data?.abertos,
        clientes_online: data?.clientes_online,
        total_atendimentos: data?.total_atendimentos
      };
      let distrib = data?.distrib ?? data?.distribuicao ?? { labels: data?.pizza_labels, data: data?.pizza_data };
      let funil   = data?.funil ?? { labels: data?.funil_labels, data: data?.funil_data };
      let ultimos = data?.ultimos ?? data?.atendimentos ?? [];

      DEMO_ACTIVE = (
        Number(cards?.total_atendimentos ?? 0)===0 &&
        Number(cards?.mensagens_hoje ?? 0)===0 &&
        Number(cards?.abertos ?? 0)===0 &&
        Number(cards?.clientes_online ?? 0)===0 &&
        (!Array.isArray(ultimos) || ultimos.length===0)
      );

      if (DEMO_ACTIVE) {
        const demo = makeDemoCharts((params.date||'') + '|' + (getInstAtiva()||'all'));
        distrib = demo.distrib; funil = demo.funil; setDemoBadge(true);
      } else {
        setDemoBadge(false);
      }

      renderCards(cards);
      renderPizza(distrib);
      renderFunil(funil);
      renderTable(ultimos);
      setCount( realTotalFrom(data, cards) );

      await updateWhatsappCard();

    }catch(e){
      console.warn('Dashboard load error:', e);
      setDemoBadge(false);
      renderCards({});
      renderPizza({labels:['Sem dados'], data:[1]});
      renderFunil({labels:['Sem dados'], data:[0]});
      renderTable([]);
      setCount(0);
      try{ await updateWhatsappCard(); }catch{}
    }finally{
      Loader.hide?.();
    }
  }

  // ===== util: setar data do flatpickr e disparar change =====
  function setDateISO(el, iso){
    if (!el) return;
    try{
      if (el._flatpickr) {
        el._flatpickr.setDate(iso || null, true); // true => dispara onChange
      } else {
        el.value = iso || '';
        el.dispatchEvent(new Event('change', { bubbles:true }));
      }
    }catch{
      el.value = iso || '';
      el.dispatchEvent(new Event('change', { bubbles:true }));
    }
  }

  // ===== bootstrap =====
  async function init(){
    const elDate = document.getElementById('filtroData');
    if (elDate && !elDate.value) elDate.value = todayISO;
    elDate && elDate.addEventListener('change', ()=> loadAll(elDate.value || todayISO));

    // Botões rápidos
    const btnHoje   = document.getElementById('btnHoje');
    const btnOntem  = document.getElementById('btnOntem');
    const btnLimpar = document.getElementById('btnLimpar');

    btnHoje?.addEventListener('click', ()=> setDateISO(elDate, todayISO));
    btnOntem?.addEventListener('click', ()=>{
      const d = new Date(); d.setDate(d.getDate() - 1);
      setDateISO(elDate, fmtDateISO(d));
    });
    btnLimpar?.addEventListener('click', ()=> setDateISO(elDate, ''));

    const doLoad = ()=> loadAll(elDate?.value || todayISO);
    if (window.ZAuth?.softEnsureAuth) ZAuth.softEnsureAuth().finally(doLoad);
    else doLoad();
  }

  const run = ()=> window.Page?.guarded?.('dashboard.ver', init, { msg: 'Sem permissão para o Dashboard' }) ?? init();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once:true });
  else run();
})();