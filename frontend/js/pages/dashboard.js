(function DashboardPage(){
  'use strict';

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

  // Paleta e tema do dashboard (lê as variáveis do CSS para bater com claro/escuro)
  const PALETTE = ['#008169','#39a98f','#E6FFDA','#14b86a','#f59e0b','#ef4444','#06b6d4','#94d3bf'];

  function cssVar(name, fallback){
    try{
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    }catch{
      return fallback;
    }
  }

  function chartTheme(){
    return {
      grid: cssVar('--chart-grid', '#edf0f5'),
      text: cssVar('--chart-text', '#7a8293'),
      line: cssVar('--chart-line', '#008169'),
      line2: cssVar('--chart-line-2', '#39a98f'),
      fill: cssVar('--chart-fill', 'rgba(0,129,105,.10)'),
      bar: cssVar('--chart-bar', '#008169'),
      bar2: cssVar('--chart-bar-2', '#E6FFDA'),
      tooltipBg: cssVar('--dash-title', '#111827'),
      tooltipText: cssVar('--dash-card', '#ffffff')
    };
  }

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
    document.querySelectorAll('.charts .box.is-demo').forEach(n=>n.classList.remove('is-demo'));
    if(!active) return;

    const targets = [
      document.getElementById('pizzaAtendimento'),
      document.getElementById('funilAtendimento')
    ].filter(Boolean).map(c => c.closest('.box')).filter(Boolean);

    for (const box of targets){
      box.classList.add('is-demo');

      const title = box.querySelector('.chart-title');
      const legend = box.querySelector('.chart-legend');
      let side = title?.querySelector('.chart-title-side') || null;

      // O badge não pode ficar absoluto em cima da legenda.
      // Então a lateral do título vira um grupo flex: [Modo demonstração] [Legenda].
      if (title && !side) {
        side = document.createElement('div');
        side.className = 'chart-title-side';

        if (legend) {
          title.insertBefore(side, legend);
          side.appendChild(legend);
        } else {
          title.appendChild(side);
        }
      }

      const b = document.createElement('span');
      b.className = 'demo-badge';
      b.textContent = 'Modo Demonstração';

      if (side) {
        side.insertBefore(b, side.firstChild);
      } else {
        box.appendChild(b);
      }
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
    const ctx = document.getElementById('pizzaAtendimento');
    if (!hasChart() || !ctx) return;

    const labels = (distrib?.labels) || Object.keys(distrib?.data||{});
    const data = Array.isArray(distrib?.data)
      ? distrib.data.map(v => toNum(v) ?? 0)
      : labels.map(k => toNum(distrib?.data?.[k]) ?? 0);

    const t = chartTheme();

    chartPizza = upsertChart(ctx, chartPizza, {
      type:'line',
      data:{
        labels,
        datasets:[
          {
            label:'Volume',
            data,
            tension:.42,
            borderColor:t.line,
            backgroundColor:t.fill,
            pointBackgroundColor:t.line,
            pointBorderColor:t.line,
            pointRadius:3,
            pointHoverRadius:5,
            fill:true,
            borderWidth:2.4
          },
          {
            label:'Tendência',
            data:data.map((v,i,arr)=>{
              const prev = arr[i-1] ?? v;
              const next = arr[i+1] ?? v;
              return Math.round((prev + v + next) / 3);
            }),
            tension:.42,
            borderColor:t.line2,
            backgroundColor:'transparent',
            pointRadius:0,
            pointHoverRadius:0,
            fill:false,
            borderWidth:1.8
          }
        ]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        interaction:{ mode:'index', intersect:false },
        plugins:{
          legend:{
            display:false
          },
          tooltip:{
            mode:'index',
            intersect:false,
            backgroundColor:t.tooltipBg,
            titleColor:t.tooltipText,
            bodyColor:t.tooltipText,
            borderColor:cssVar('--dash-border', '#edf2ee'),
            borderWidth:1,
            padding:11,
            cornerRadius:10,
            displayColors:false
          }
        },
        scales:{
          y:{
            beginAtZero:true,
            ticks:{ precision:0, color:t.text, font:{ size:11, weight:'500' } },
            grid:{ color:t.grid, drawBorder:false, tickLength:0 }
          },
          x:{
            grid:{ display:false, drawBorder:false },
            ticks:{ color:t.text, maxRotation:0, minRotation:0, autoSkip:true, font:{ size:11, weight:'500' } }
          }
        }
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
    const ctx = document.getElementById('funilAtendimento');
    if (!hasChart() || !ctx) return;

    const labelsFull = (funil?.labels) || Object.keys(funil?.data||{});
    const labels = labelsFull.map(shortenFunnelLabel);
    const data = Array.isArray(funil?.data)
      ? funil.data.map(v => toNum(v) ?? 0)
      : labelsFull.map(k => toNum(funil?.data?.[k]) ?? 0);

    const t = chartTheme();

    chartFunil = upsertChart(ctx, chartFunil, {
      type:'bar',
      data:{
        labels,
        datasets:[
          {
            label:'Conversas',
            data,
            backgroundColor:data.map((_,i)=> i % 2 === 0 ? t.bar : t.bar2),
            borderWidth:0,
            borderRadius:8,
            barThickness:IS_MOBILE ? 22 : 34,
            maxBarThickness:42
          }
        ]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        interaction:{ mode:'index', intersect:false },
        plugins:{
          legend:{ display:false },
          tooltip:{
            mode:'index',
            intersect:false,
            backgroundColor:t.tooltipBg,
            titleColor:t.tooltipText,
            bodyColor:t.tooltipText,
            borderColor:cssVar('--dash-border', '#edf2ee'),
            borderWidth:1,
            cornerRadius:10,
            padding:11,
            displayColors:false,
            callbacks:{
              title:(items)=>{
                if (!items?.length) return '';
                const i = items[0].dataIndex;
                return IS_MOBILE ? labelsFull[i] : items[0].label;
              }
            }
          }
        },
        scales:{
          y:{
            beginAtZero:true,
            ticks:{ precision:0, color:t.text, font:{ size:11, weight:'500' } },
            grid:{ color:t.grid, drawBorder:false, tickLength:0 }
          },
          x:{
            grid:{ display:false, drawBorder:false },
            ticks:{
              maxRotation:0,
              minRotation:0,
              autoSkip:true,
              maxTicksLimit:Math.min(5, labels.length),
              color:t.text,
              font:{ size:11, weight:'500' }
            }
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
    // O navegador consulta somente o backend autenticado.
    // A URL e a chave da Evolution nunca são entregues ao frontend.
    const status = await fetchWppStatus({ empresa_id: EMPRESA_ID, ...instParams() });
    if (status) renderWppStatus(status);
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

    window.addEventListener('zapschat-theme-changed', function(){
      const iso = elDate?.value || todayISO;
      loadAll(iso);
    });
    if (window.ZAuth?.softEnsureAuth) ZAuth.softEnsureAuth().finally(doLoad);
    else doLoad();
  }

  const run = ()=> window.Page?.guarded?.('dashboard.ver', init, { msg: 'Sem permissão para o Dashboard' }) ?? init();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once:true });
  else run();
})();