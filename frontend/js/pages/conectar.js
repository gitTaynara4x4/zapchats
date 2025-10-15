/* frontend/js/pages/conectar.js */
(function () {
  'use strict';

  // ===== Estado global mínimo =====
  let wantQR = false;
  let currentInstance = null;
  let timerId = null;

  // ===== Helpers =====
  const $  = (sel, ctx=document) => ctx.querySelector(sel);
  const $$ = (sel, ctx=document) => Array.from(ctx.querySelectorAll(sel));
  const onlyDigits = (s) => String(s||'').replace(/\D/g,'');

  function htmlEscape(s){
    return String(s ?? '').replace(/[&<>"']/g, c => (
      {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
    ));
  }
  function dot(color='#22c55e'){ return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};"></span>`; }
  function formatPhoneBR(num) {
    const d = onlyDigits(num);
    if (!d) return '—';
    if (d.length === 13) return `+${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,9)}-${d.slice(9)}`;
    if (d.length === 12) return `+${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,8)}-${d.slice(8)}`;
    return `+${d}`;
  }
  function isConnectedPayload(m){
    if (m?.inst_status && typeof m.inst_status.connected !== 'undefined') {
      return !!m.inst_status.connected;
    }
    return m?.connected === true
        || String(m?.status || m?.state || '').toUpperCase() === 'CONNECTED'
        || String(m?.type || '').toLowerCase() === 'connected';
  }

  // ===== Fail-safe do "prepaint" =====
  window.addEventListener('load', () => {
    const html = document.documentElement;
    if (html.classList.contains('prepaint')
        && !(html.hasAttribute('data-head-ready') && html.hasAttribute('data-loader-ready'))) {
      html.classList.remove('prepaint');
    }
  });

  // ===== Auth/contexto =====
  const empresaId = Number(localStorage.getItem('empresa_id') || localStorage.getItem('empresaId') || 0);
  const token     = localStorage.getItem('token') || localStorage.getItem('auth_token') || '';
  const authHeaders = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(empresaId ? { 'X-Empresa-Id': String(empresaId) } : {}),
  };

  async function apiGet(url){
    const r = await fetch(url, { headers: { ...authHeaders }, credentials:'include' });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
      const t = await r.text(); throw new Error(`GET ${url} → ${r.status}: ${t.slice(0,150)}`);
    }
    if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
    return r.json();
  }
  async function apiPost(url, body){
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(body || {}),
      credentials: 'include'
    });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const js = ct.includes('application/json') ? await r.json() : {};
    if (!r.ok || js?.ok === false) throw new Error(js?.detail || js?.message || `POST ${url} → ${r.status}`);
    return js;
  }
  async function apiDelete(url){
    const extra = 'cascade=0&force=1&delete_remote=1';
    const sep1 = url.includes('?') ? '&' : '?';
    const withParams = `${url}${sep1}${extra}`;
    const withEmp = (empresaId)
      ? `${withParams}&empresa_id=${encodeURIComponent(String(empresaId))}`
      : withParams;

    const r = await fetch(withEmp, { method: 'DELETE', headers: { ...authHeaders }, credentials:'include' });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    let js = null;
    if (ct.includes('application/json')) { try { js = await r.json(); } catch {} }
    const ok = r.ok && (js?.ok !== false);
    return { ok, status: r.status, data: js };
  }

  // ===== Elementos =====
  const els = {
    headerBadgeInner: $('#count-pro'),
    headerBadgeWrap:  $('#count-pro')?.parentElement,

    tabAtivos:   $('button[data-tab="ativos"]'),
    tabInativos: $('button[data-tab="inativos"]'),
    loader:      $('#zap-loader'),
    placeholder: $('#placeholder-zap'),
    table:       $('#lista-zap'),
    tbody:       $('#lista-zap tbody'),

    btnAdd:      $('#btn-open-modal'),

    modal:       $('#modal'),
    btnCloseMd:  $('#btn-close-modal'),
    form:        $('#form-conectar'),
    inApelido:   $('#form-conectar input[name="apelido"]'),
    inNumero:    $('#numero'),
    selPais:     $('#pais-select'),
    selHist:     $('#historico-select'),
    chkPairing:  $('#use-pairing'),
    btnGerarQR:  $('#btn-gerar-qr'),
    btnCancel:   $('#btn-cancel'),
    btnRefresh:  $('#btn-refresh'),

    qrCanvas:    $('#qr-canvas'),
    qrImg:       $('#qr-img'),
    qrLoader:    $('#qr-loader'),
    qrTimerWrap: $('#qr-timer'),
    qrTimerCnt:  $('#qr-timer-count'),
    qrInstru:    $('#qr-instru'),
    qrErro:      $('#qr-erro'),
    qrIllustration: $('#qr-illustration'),

    modalRem:      $('#modal-remover-numero'),
    btnRemYes:     $('#btn-confirmar-remover'),
    btnRemNo:      $('#btn-cancelar-remover'),
    remConsent:    $('#rem-consent'),
  };

  // ===== Modal helpers =====
  els.modalPanel = $('#modal .modal-panel, #modal .modal-card, #modal .card, #modal > div');
  els.modalTitle = $('#modal [data-modal-title], #modal .modal-title, #modal h3, #modal h2');

  function fieldRowOf(el){
    if (!el) return null;
    return el.closest?.('.form-row, .field, .mb-4, .mb-3, .grid, div') || el.parentElement || null;
  }
  function setModalTitle(txt){ if (els.modalTitle) els.modalTitle.textContent = txt; }

  function showModal(){
    if (!els.modal) return;
    els.modal.classList.remove('hidden');
    const p = els.modalPanel;
    if (p){
      p.classList.remove('anim-out');
      void p.offsetWidth;
      p.classList.add('anim-in');
      setTimeout(()=>p.classList.remove('anim-in'), 180);
    }
  }
  function hideModal(){
    if (!els.modal) return;
    const p = els.modalPanel;
    if (p){
      p.classList.remove('anim-in');
      p.classList.add('anim-out');
      setTimeout(()=>{
        els.modal.classList.add('hidden');
        p.classList.remove('anim-out');
      }, 160);
    } else {
      els.modal.classList.add('hidden');
    }
  }

  // ===== Overlay de 1 minuto (somente após conectar) =====
  const PREP_LOTTIE_DATA = {"v":"4.6.8","fr":29.97,"ip":0,"op":40,"w":256,"h":256,"nm":"Comp 1","ddd":0,"assets":[],"layers":[{"ddd":0,"ind":1,"ty":4,"nm":"Shape Layer 3","ks":{"o":{"a":0,"k":100},"r":{"a":0,"k":0},"p":{"a":1,"k":[{"i":{"x":0.667,"y":1},"o":{"x":0.333,"y":0},"n":"0p667_1_0p333_0","t":20,"s":[208.6,127.969,0],"e":[208.6,88,0],"to":[0,-6.66145849227905,0],"ti":[0,-0.00520833348855,0]},{"i":{"x":0.667,"y":1},"o":{"x":0.333,"y":0},"n":"0p667_1_0p333_0","t":30,"s":[208.6,88,0],"e":[208.6,128,0],"to":[0,0.00520833348855,0],"ti":[0,-6.66666650772095,0]},{"t":40}]},"a":{"a":0,"k":[-70,-0.5,0]},"s":{"a":0,"k":[75,75,100]}},"ao":0,"shapes":[{"ty":"gr","it":[{"d":1,"ty":"el","s":{"a":0,"k":[33.75,34.5]},"p":{"a":0,"k":[0,0]},"nm":"Ellipse Path 1"},{"ty":"fl","c":{"a":0,"k":[0.9843137,0.5490196,0,1]},"o":{"a":0,"k":100},"r":1,"nm":"Fill 1"},{"ty":"tr","p":{"a":0,"k":[-70.125,-0.5]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100},"sk":{"a":0,"k":0},"sa":{"a":0,"k":0},"nm":"Transform"}],"nm":"Ellipse 1","np":3,"cix":2,"ix":1}],"ip":0,"op":300,"st":0,"bm":0,"sr":1},{"ddd":0,"ind":2,"ty":4,"nm":"Shape Layer 2","ks":{"o":{"a":0,"k":100},"r":{"a":0,"k":0},"p":{"a":1,"k":[{"i":{"x":0.667,"y":1},"o":{"x":0.333,"y":0},"n":"0p667_1_0p333_0","t":15,"s":[168.6,128,0],"e":[168.6,88,0],"to":[0,-6.66666650772095,0],"ti":[0,0,0]},{"i":{"x":0.667,"y":1},"o":{"x":0.333,"y":0},"n":"0p667_1_0p333_0","t":25,"s":[168.6,88,0],"e":[168.6,128,0],"to":[0,0,0],"ti":[0,-6.66666650772095,0]},{"t":35}]},"a":{"a":0,"k":[-70,-0.5,0]},"s":{"a":0,"k":[75,75,100]}},"ao":0,"shapes":[{"ty":"gr","it":[{"d":1,"ty":"el","s":{"a":0,"k":[33.75,34.5]},"p":{"a":0,"k":[0,0]},"nm":"Ellipse Path 1"},{"ty":"fl","c":{"a":0,"k":[0.9921569,0.8470588,0.2078431,1]},"o":{"a":0,"k":100},"r":1,"nm":"Fill 1"},{"ty":"tr","p":{"a":0,"k":[-70.125,-0.5]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100},"sk":{"a":0,"k":0},"sa":{"a":0,"k":0},"nm":"Transform"}],"nm":"Ellipse 1","np":3,"cix":2,"ix":1}],"ip":0,"op":300,"st":0,"bm":0,"sr":1},{"ddd":0,"ind":3,"ty":4,"nm":"Shape Layer 1","ks":{"o":{"a":0,"k":100},"r":{"a":0,"k":0},"p":{"a":1,"k":[{"i":{"x":0.667,"y":1},"o":{"x":0.333,"y":0},"n":"0p667_1_0p333_0","t":10,"s":[128.594,127.969,0],"e":[128.594,88,0],"to":[0,-6.66145849227905,0],"ti":[0,-0.00520833348855,0]},{"i":{"x":0.667,"y":1},"o":{"x":0.333,"y":0},"n":"0p667_1_0p333_0","t":20,"s":[128.594,88,0],"e":[128.594,128,0],"to":[0,0.00520833348855,0],"ti":[0,-6.66666650772095,0]},{"t":30}]},"a":{"a":0,"k":[-70,-0.5,0]},"s":{"a":0,"k":[75,75,100]}},"ao":0,"shapes":[{"ty":"gr","it":[{"d":1,"ty":"el","s":{"a":0,"k":[33.75,34.5]},"p":{"a":0,"k":[0,0]},"nm":"Ellipse Path 1"},{"ty":"fl","c":{"a":0,"k":[0.2627451,0.627451,0.2784314,1]},"o":{"a":0,"k":100},"r":1,"nm":"Fill 1"},{"ty":"tr","p":{"a":0,"k":[-70.125,-0.5]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100},"sk":{"a":0,"k":0},"sa":{"a":0,"k":0},"nm":"Transform"}],"nm":"Ellipse 1","np":3,"cix":2,"ix":1}],"ip":0,"op":300,"st":0,"bm":0,"sr":1},{"ddd":0,"ind":4,"ty":4,"nm":"Shape Layer 4","ks":{"o":{"a":0,"k":100},"r":{"a":0,"k":0},"p":{"a":1,"k":[{"i":{"x":0.667,"y":1},"o":{"x":0.333,"y":0},"n":"0p667_1_0p333_0","t":5,"s":[88.6,127.969,0],"e":[88.6,88,0],"to":[0,-6.66145849227905,0],"ti":[0,-0.00520833348855,0]},{"i":{"x":0.667,"y":1},"o":{"x":0.333,"y":0},"n":"0p667_1_0p333_0","t":15,"s":[88.6,88,0],"e":[88.6,128,0],"to":[0,0.00520833348855,0],"ti":[0,-6.66666650772095,0]},{"t":25}]},"a":{"a":0,"k":[-70,-0.5,0]},"s":{"a":0,"k":[75,75,100]}},"ao":0,"shapes":[{"ty":"gr","it":[{"d":1,"ty":"el","s":{"a":0,"k":[33.75,34.5]},"p":{"a":0,"k":[0,0]},"nm":"Ellipse Path 1"},{"ty":"fl","c":{"a":0,"k":[0.1176471,0.5333334,0.8980392,1]},"o":{"a":0,"k":100},"r":1,"nm":"Fill 1"},{"ty":"tr","p":{"a":0,"k":[-70.125,-0.5]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100},"sk":{"a":0,"k":0},"sa":{"a":0,"k":0},"nm":"Transform"}],"nm":"Ellipse 1","np":3,"cix":2,"ix":1}],"ip":0,"op":300,"st":0,"bm":0,"sr":1},{"ddd":0,"ind":5,"ty":4,"nm":"Shape Layer 5","ks":{"o":{"a":0,"k":100},"r":{"a":0,"k":0},"p":{"a":1,"k":[{"i":{"x":0.667,"y":1},"o":{"x":0.333,"y":0},"n":"0p667_1_0p333_0","t":0,"s":[48.6,127.969,0],"e":[48.6,88,0],"to":[0,-6.66145849227905,0],"ti":[0,-0.00520833348855,0]},{"i":{"x":0.667,"y":1},"o":{"x":0.333,"y":0},"n":"0p667_1_0p333_0","t":10,"s":[48.6,88,0],"e":[48.6,128,0],"to":[0,0.00520833348855,0],"ti":[0,-6.66666650772095,0]},{"t":20}]},"a":{"a":0,"k":[-70,-0.5,0]},"s":{"a":0,"k":[75,75,100]}},"ao":0,"shapes":[{"ty":"gr","it":[{"d":1,"ty":"el","s":{"a":0,"k":[33.75,34.5]},"p":{"a":0,"k":[0,0]},"nm":"Ellipse Path 1"},{"ty":"fl","c":{"a":0,"k":[0.8980392,0.2235294,0.2078431,1]},"o":{"a":0,"k":100},"r":1,"nm":"Fill 1"},{"ty":"tr","p":{"a":0,"k":[-70.125,-0.5]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100},"sk":{"a":0,"k":0},"sa":{"a":0,"k":0},"nm":"Transform"}],"nm":"ADBE Vector Group"}],"ip":0,"op":300,"st":0,"bm":0,"sr":1}]} ;

  function loadLottie(){
    return new Promise((resolve) => {
      if (window.lottie && window.lottie.loadAnimation) return resolve(window.lottie);
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js';
      sc.onload = () => resolve(window.lottie);
      sc.onerror = () => resolve(null);
      document.head.appendChild(sc);
    });
  }

  const prepBlock = {
    active: false,
    left: 0,
    tmr: null,
    anim: null,
  };

  function ensureOverlay(){
    let ovl = document.getElementById('sync-overlay'); // reaproveita id
    if (ovl) return ovl;
    ovl = document.createElement('div');
    ovl.id = 'sync-overlay';
    ovl.className = 'hidden';
    ovl.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:9999;color:#fff';
    document.body.appendChild(ovl);
    return ovl;
  }

  function setOverlayToPrep(){
    const ovl = ensureOverlay();
    ovl.innerHTML = `
      <div class="sync-card" style="position:relative;z-index:1;width:min(560px,92vw);border-radius:16px;padding:22px;border:1px solid rgba(255,255,255,.16);box-shadow:0 22px 64px rgba(0,0,0,.45);background:#0f172a;color:#e5e7eb;text-align:center">
        <div style="font-weight:800;font-size:1.05rem;margin-bottom:.25rem">Estamos preparando tudo para você…</div>
        <div id="prep-ovl-time" style="opacity:.85;margin-bottom:.65rem">~ 01:00</div>
        <div id="prep-ovl-lottie" style="width:120px;height:120px;margin:6px auto 2px"></div>
        <div style="opacity:.8;font-size:.9rem;margin-top:.5rem">Segure um instante — já liberamos o app.</div>
      </div>
    `;
  }
  function paintPrepTime(){
    const mm = String(Math.floor(prepBlock.left/60)).padStart(2,'0');
    const ss = String(prepBlock.left%60).padStart(2,'0');
    const el = $('#prep-ovl-time', document);
    if (el) el.textContent = `~ ${mm}:${ss}`;
  }
  async function showPrepOverlayOneMinute(){
    if (prepBlock.active) return; // não reinicia
    prepBlock.active = true;
    prepBlock.left = 60;
    setOverlayToPrep();
    const ovl = ensureOverlay();
    ovl.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    const slot = $('#prep-ovl-lottie', ovl);
    const lottie = await loadLottie();
    if (lottie && slot) {
      prepBlock.anim = lottie.loadAnimation({ container: slot, renderer:'svg', loop:true, autoplay:true, animationData: PREP_LOTTIE_DATA });
    }
    paintPrepTime();
    clearInterval(prepBlock.tmr);
    prepBlock.tmr = setInterval(() => {
      prepBlock.left -= 1;
      if (prepBlock.left <= 0){
        hidePrepOverlay();
      } else {
        paintPrepTime();
      }
    }, 1000);
  }
  function hidePrepOverlay(){
    const ovl = ensureOverlay();
    prepBlock.active = false;
    clearInterval(prepBlock.tmr);
    prepBlock.tmr = null;
    try { prepBlock.anim?.destroy?.(); } catch {}
    prepBlock.anim = null;
    ovl.classList.add('hidden');
    document.body.style.overflow = '';
  }

  // ===== CSS rápido =====
  (function injectCSS(){
    const css = `
      #zap-loader{ display:none !important; }
      .plan-pill{display:inline-flex;align-items:center;justify-content:center;min-width:48px;padding:2px 8px;border-radius:999px;font-size:12px;line-height:1;letter-spacing:.02em;background:#f4f4f5;color:#111827;border:1px solid #e5e7eb;}
      html.dark .plan-pill{ background:#1f2937; color:#e5e7eb; border-color:#374151; }
      .kebab-btn{ border:1px solid #e5e7eb; border-radius:8px; padding:6px 10px; background:#fff; display:inline-flex; align-items:center; justify-content:center; }
      html.dark .kebab-btn{ background:#161617; border-color:#27272a; color:#e5e7eb; }
      .kebab-menu{ position:absolute; right:0; margin-top:8px; background:#fff; border:1px solid #e5e7eb; border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,.15); min-width:180px; z-index:50; display:none; }
      .kebab-menu.show{ display:block; }
      html.dark .kebab-menu{ background:#161617; border-color:#27272a; }
      .kebab-item{ display:block; width:100%; text-align:left; padding:10px 12px; background:transparent; border:0; font-size:14px; }
      .kebab-item:hover{ background:rgba(0,0,0,.04); }
      html.dark .kebab-item:hover{ background:rgba(255,255,255,.06); }
      html.dark #lista-zap tbody tr{ background:#161617; }
      html.dark #lista-zap tbody tr:nth-child(even){ background:#121214; }
      .hidden{ display:none !important; }
      #btn-open-modal:hover:not([disabled]){ background: rgba(34,197,94,.06); box-shadow:0 4px 18px rgba(34,197,94,.12); }
      #btn-open-modal:focus-visible{ outline:3px solid rgba(79,131,255,.5); outline-offset:2px; }
      #btn-open-modal[disabled]{ cursor:not-allowed; box-shadow:none; }
      button[data-tab]{ cursor:pointer; }
      button[data-tab]:hover{ filter:brightness(1.05); }
    `;
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  })();

  // ===== Tabela =====
  function rowHTML(item, planLabel){
    const apelido = htmlEscape(item.apelido || item.instance_name || '');
    const numero  = formatPhoneBR(item.numero_instancia);
    const status  = item.connected ? dot('#22c55e') : dot('#9ca3af');

    const menuItems = [];
    if (!item.connected) menuItems.push('<button class="kebab-item js-reconnect">Reconectar</button>');
    menuItems.push('<button class="kebab-item js-remove">Remover número</button>');

    return `
      <tr class="border-b last:border-0 relative" data-id="${htmlEscape(String(item.id))}" data-instance="${htmlEscape(item.instance_name)}">
        <td class="py-2">${apelido || '—'}</td>
        <td class="py-2">${numero}</td>
        <td class="py-2"><span class="plan-pill">${htmlEscape(planLabel)}</span></td>
        <td class="py-2">${status}</td>
        <td class="py-2 text-right">
          <button class="kebab-btn" aria-haspopup="true" aria-expanded="false" aria-label="Ações">
            <i class="fa-solid fa-ellipsis-vertical"></i>
          </button>
          <div class="kebab-menu">
            ${menuItems.join('')}
          </div>
        </td>
      </tr>
    `;
  }
  function bindRowEvents(tr, item){
    const btn  = $('.kebab-btn', tr);
    const menu = $('.kebab-menu', tr);
    if (btn && menu){
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        $$('.kebab-menu').forEach(m => { if (m!==menu) m.classList.remove('show'); });
        menu.classList.toggle('show');
        btn.setAttribute('aria-expanded', menu.classList.contains('show') ? 'true' : 'false');
      });
    }
    const btnRem = $('.js-remove', tr);
    if (btnRem){
      btnRem.addEventListener('click', () => {
        menu.classList.remove('show');
        openRemoveModal(item);
      });
    }
    const btnRec = $('.js-reconnect', tr);
    if (btnRec){
      btnRec.addEventListener('click', async () => {
        menu.classList.remove('show');
        await openReconnect(item);
      });
    }
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.kebab-btn') && !e.target.closest('.kebab-menu')) {
      $$('.kebab-menu').forEach(m => m.classList.remove('show'));
    }
  });

  function renderList(items, planLabel){
    if (!els.tbody) return;
    els.tbody.innerHTML = '';
    if (!Array.isArray(items) || items.length === 0){
      els.table?.classList.add('hidden');
      els.placeholder?.classList.remove('hidden');
      return;
    }
    els.placeholder?.classList.add('hidden');
    els.table?.classList.remove('hidden');

    const tpl = document.createElement('template');
    const frag = document.createDocumentFragment();
    for (const it of items){
      tpl.innerHTML = rowHTML(it, planLabel).trim();
      const tr = tpl.content.firstElementChild;
      frag.appendChild(tr);
      bindRowEvents(tr, it);
    }
    els.tbody.appendChild(frag);
  }

  function setBadge(tier, used, limit){
    const label = `${tier} ${used}/${limit}`;
    if (els.headerBadgeWrap){
      els.headerBadgeWrap.innerHTML = `<span id="count-pro">${label}</span>`;
    } else if (els.headerBadgeInner){
      els.headerBadgeInner.textContent = label;
    }
  }
  function setTabs(ativos, inativos){
    if (els.tabAtivos)  els.tabAtivos.textContent  = `Ativos (${ativos})`;
    if (els.tabInativos)els.tabInativos.textContent= `Inativos (${inativos})`;
  }

  // ===== QR helpers =====
  function secondsFromLimit(raw){
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 60;
    if (n > 300) return Math.round(n / 1000);
    if (n <= 5)  return Math.round(n * 60);
    return Math.round(n);
  }
  function hideIllustration(){ els.qrIllustration?.classList.add('hidden'); }
  function showIllustration(){ els.qrIllustration?.classList.remove('hidden'); }

  function hideQR(){
    els.qrImg?.classList.add('hidden');
    els.qrCanvas?.classList.add('hidden');
    const ctx = els.qrCanvas?.getContext?.('2d');
    if (ctx) ctx.clearRect(0,0,els.qrCanvas.width, els.qrCanvas.height);
    els.qrTimerWrap?.classList.add('hidden');
    els.qrInstru?.classList.add('hidden');
    els.qrLoader?.classList.add('hidden');
  }

  function showQRError(msg){
    if (!els.qrErro) return;
    if (msg) { els.qrErro.textContent = msg; els.qrErro.classList.remove('hidden'); }
    else { els.qrErro.textContent = ''; els.qrErro.classList.add('hidden'); }
  }
  function startTimer(sec){
    clearInterval(timerId);
    if (!Number.isFinite(sec) || sec<=0 || !els.qrTimerWrap || !els.qrTimerCnt) return;
    let left = Math.floor(sec);
    els.qrTimerCnt.textContent = String(left);
    els.qrTimerWrap.classList.remove('hidden');
    if (els.btnRefresh) { els.btnRefresh.disabled = true; els.btnRefresh.classList.add('opacity-60','cursor-not-allowed'); }
    timerId = setInterval(() => {
      left -= 1;
      if (left <= 0){
        clearInterval(timerId); timerId=null;
        els.qrTimerCnt.textContent = '0';
        if (els.btnRefresh) {
          els.btnRefresh.disabled = false;
          els.btnRefresh.classList.remove('opacity-60','cursor-not-allowed');
          els.btnRefresh.focus?.();
        }
      } else {
        els.qrTimerCnt.textContent = String(left);
      }
    }, 1000);
  }

  function renderQRFromBase64(b64, limit){
    if (!b64 || !els.qrImg) return;
    const src = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
    els.qrLoader?.classList.add('hidden');
    hideIllustration();
    els.qrCanvas?.classList.add('hidden');
    els.qrImg.src = src;
    els.qrImg.classList.remove('hidden');
    els.qrInstru?.classList.remove('hidden');
    if (limit) startTimer(secondsFromLimit(limit));
    els.btnGerarQR?.classList.add('hidden');
    els.btnRefresh?.classList.remove('hidden');
  }
  function renderQRFromText(text, limit){
    if (!els.qrCanvas) return;
    els.qrLoader?.classList.add('hidden');
    hideIllustration();
    try{
      const qr = new QRious({ element: els.qrCanvas, value: String(text), size: 208, level: 'M' });
      void qr;
      els.qrCanvas.classList.remove('hidden');
      els.qrImg?.classList.add('hidden');
      els.qrInstru?.classList.remove('hidden');
      if (limit) startTimer(secondsFromLimit(limit));
      els.btnGerarQR?.classList.add('hidden');
      els.btnRefresh?.classList.remove('hidden');
    }catch(e){
      showQRError('Falha ao gerar QR. Tente novamente.');
    }
  }
  function renderQRFromResponse(qr){
    if (!qr || typeof qr !== 'object') return false;
    if (qr.base64) { renderQRFromBase64(qr.base64, qr.limit); return true; }
    if (qr.pairingCode) { renderQRFromText(qr.pairingCode, qr.limit); return true; }
    return false;
  }

  // ===== Conectado → fecha modal e abre overlay de 1 min =====
  function handleConnected(instanceFromMsg){
    if (currentInstance && instanceFromMsg && instanceFromMsg !== currentInstance) return;
    clearInterval(timerId);
    hideQR();
    try { hideModal(); } catch {}
    wantQR = false;
    showPrepOverlayOneMinute(); // 🚀 bloqueia 1 minuto, SEM “sincronizando”
  }

  // ===== Tabs =====
  let allItems = [];
  let currentTab = 'ativos';
  let lastPlanLabel = '—';

  function filterItemsByTab(list){
    return currentTab === 'ativos' ? list.filter(i => !!i.connected)
                                   : list.filter(i => !i.connected);
  }
  function activateTab(tab){
    currentTab = tab;
    renderList(filterItemsByTab(allItems), lastPlanLabel);
  }
  els.tabAtivos?.addEventListener('click', () => activateTab('ativos'));
  els.tabInativos?.addEventListener('click', () => activateTab('inativos'));

  // ===== WebSockets (somente QR/connected; ignora TODO resto) =====
  let empWS = null;
  const instWS = new Map();

  let empHb = null;
  const instHb = new Map();

  const startEmpHb = () => { clearInterval(empHb); empHb = setInterval(() => { try{ empWS?.send('ping'); }catch{} }, 30_000); };
  const stopEmpHb  = () => { clearInterval(empHb); };

  function startInstHb(instance, ws){
    clearInterval(instHb.get(instance));
    const id = setInterval(() => { try{ ws?.send('ping'); }catch{} }, 30_000);
    instHb.set(instance, id);
  }
  function stopInstHb(instance){
    clearInterval(instHb.get(instance));
    instHb.delete(instance);
  }

  let loadTmr = null;
  let inFlight = false;
  let pendingReload = false;

  function scheduleLoad(ms=500){
    pendingReload = true;
    clearTimeout(loadTmr);
    loadTmr = setTimeout(() => {
      if (inFlight) return;
      void loadWhatsAppStatus();
    }, ms);
  }

  function ensureEmpWS(){
    if (!empresaId) return;
    if (empWS && empWS.readyState === WebSocket.OPEN) return empWS;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/emp:${empresaId}`;
    empWS = new WebSocket(url);

    empWS.onopen = () => { startEmpHb(); };
    empWS.onclose = () => { stopEmpHb(); setTimeout(() => ensureEmpWS(), 800); };
    empWS.onerror = () => { try { empWS?.close(); } catch {} };

    empWS.onmessage = (ev) => {
      let m = null; try{ m = JSON.parse(ev.data); }catch{ m = { raw: ev.data }; }

      // Somente o que interessa:
      if (m?.reload_whatsapp || m?.type === 'reload_whatsapp') {
        scheduleLoad();
        return;
      }
      if (m?.type === 'qrcode' && wantQR){
        const ttl = m.qr_limit ?? m.expires_in ?? m.ttl ?? 60;
        if (m.base64)           renderQRFromBase64(m.base64, ttl);
        else if (m.pairingCode) renderQRFromText(m.pairingCode, ttl);
        return;
      }
      if (m?.type === 'connection' || m?.type === 'connected' || m?.status || m?.state || m?.inst_status){
        if (isConnectedPayload(m)) {
          const instName = (m.inst_status?.instance) || m.instance || m.instance_name || m.instancia || null;
          handleConnected(instName);
          scheduleLoad(200);
        }
        return;
      }

      // qualquer outro evento é ignorado (nada de sync!)
    };

    window.wsEmpresa = empWS;
    return empWS;
  }

  function ensureInstanceWS(instance){
    if (!instance) return;
    const existing = instWS.get(instance);
    if (existing && existing.readyState === WebSocket.OPEN) return existing;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/inst:${encodeURIComponent(instance)}`;
    const ws = new WebSocket(url);
    instWS.set(instance, ws);

    ws.onopen  = () => { startInstHb(instance, ws); };
    ws.onclose = () => { stopInstHb(instance); setTimeout(() => ensureInstanceWS(instance), 1200); };
    ws.onerror = () => { try { ws.close(); } catch {} };

    ws.onmessage = (ev) => {
      let m = null; try{ m = JSON.parse(ev.data); }catch{ m = { raw: ev.data }; }

      if (m?.type === 'qrcode' && wantQR){
        const ttl = m.qr_limit ?? m.expires_in ?? m.ttl ?? 60;
        if (m.base64)           renderQRFromBase64(m.base64, ttl);
        else if (m.pairingCode) renderQRFromText(m.pairingCode, ttl);
      }
      if (m?.type === 'connection' || m?.type === 'connected' || m?.status || m?.state){
        if (isConnectedPayload(m)) {
          handleConnected(m.instance || m.instance_name || m.instancia || null);
          scheduleLoad(200);
        }
      }

      // demais eventos: ignorar
    };
    return ws;
  }

  // ===== Carga principal (sem overlay de "carregando") =====
  async function loadWhatsAppStatus(){
    if (!empresaId) return;
    if (inFlight) { pendingReload = true; return; }
    inFlight = true;
    pendingReload = false;

    try{
      const js = await apiGet(`/api/empresas/${empresaId}/whatsapp`);

      const tier   = String(js?.effective_tier || js?.assinatura || 'FREE').toUpperCase();
      const used   = Number(js?.quantidade_instancias || 0);
      const limit  = Number(js?.limite_instancias || 0);

      const list = Array.isArray(js?.instancias) ? js.instancias.map(i => ({
        id: i.id,
        instance_name: i.instance_name,
        apelido: i.apelido || '',
        numero_instancia: i.numero_instancia || '',
        connected: !!i.connected,
        last_seen: i.last_seen || null
      })) : [];

      allItems = list;
      lastPlanLabel = tier;

      const ativos = list.filter(i => i.connected).length;
      const inat   = list.length - ativos;
      setBadge(tier, used, limit);
      setTabs(ativos, inat);

      const canAdd = (limit === 0) ? false : (used < limit);

      if (els.btnAdd) {
        els.btnAdd.disabled = !canAdd;
        els.btnAdd.classList.toggle('btn--ok', canAdd);
        els.btnAdd.classList.toggle('opacity-60', !canAdd);
        els.btnAdd.classList.toggle('cursor-not-allowed', !canAdd);
        els.btnAdd.title = canAdd ? '' : 'Você atingiu o limite do seu plano';
        els.btnAdd.setAttribute('aria-disabled', String(!canAdd));
      }

      renderList(filterItemsByTab(allItems), tier);
    }catch(e){
      console.error(e);
    }finally{
      inFlight = false;
      if (pendingReload) {
        pendingReload = false;
        scheduleLoad(200);
      }
    }
  }

  // ===== Submit (novo) – mantém sua ilustração/loader =====
  async function handleConnectSubmit(ev){
    ev.preventDefault?.();

    showQRError('');
    hideQR();
    els.qrLoader?.classList.remove('hidden');
    showIllustration();

    const apelido   = els.inApelido?.value?.trim() || '';
    const numero    = onlyDigits(els.inNumero?.value);
    const ddi       = onlyDigits(els.selPais?.value) || '55';
    const historico = els.selHist?.value || 'none';
    const usePairing = !!els.chkPairing?.checked;

    if (!numero){
      els.qrLoader?.classList.add('hidden');
      showQRError('Informe um número de telefone válido.');
      return;
    }
    const e164 = `+${ddi}${numero}`;

    try{
      const js = await apiPost('/api/onboarding/empresas/conectar', {
        empresa_id: empresaId,
        whatsapp_numero: e164,
        historico_restaurar: historico,
        instance_name: null,
        use_pairing: usePairing,
        apelido: apelido || null
      });

      currentInstance = js?.instance || null;
      window.currentInstance = currentInstance;

      if (currentInstance) ensureInstanceWS(currentInstance);

      wantQR = true;

      const rendered = renderQRFromResponse(js?.qrcode || {});
      els.qrLoader?.classList.add('hidden');

      await loadWhatsAppStatus();

      if (rendered){
        els.btnGerarQR?.classList.add('hidden');
        els.btnRefresh?.classList.remove('hidden');
        els.qrInstru?.classList.remove('hidden');
      } else {
        els.btnGerarQR?.classList.remove('hidden');
        els.btnRefresh?.classList.add('hidden');
        els.qrInstru?.classList.remove('hidden');
      }

    } catch (e){
      els.qrLoader?.classList.add('hidden');
      showQRError(e?.message || 'Falha ao iniciar conexão.');
    }
  }

  // ===== Reconectar existente =====
  async function openReconnect(item){
    if (!item?.instance_name) return;
    currentInstance = item.instance_name;
    window.currentInstance = currentInstance;

    setModalTitle('Reconecte seu número de WhatsApp');
    const histRow = fieldRowOf(els.selHist);
    if (histRow) histRow.classList.add('hidden');

    if (els.inApelido) els.inApelido.value = item.apelido || '';
    if (els.selPais) els.selPais.value = '55';
    if (els.inNumero) els.inNumero.value = onlyDigits(item.numero_instancia || '').slice(-11);

    showModal();
    showIllustration(); showQRError(''); hideQR();

    ensureInstanceWS(currentInstance);

    els.qrLoader?.classList.remove('hidden');
    try {
      const res = await apiPost(`/api/onboarding/empresas/qr/refresh/${encodeURIComponent(currentInstance)}`, {});
      els.qrLoader?.classList.add('hidden');
      const ok = renderQRFromResponse(res?.qrcode || {});
      wantQR = true;
      if (!ok) showIllustration();
    } catch {
      els.qrLoader?.classList.add('hidden');
      showIllustration();
    }

    els.btnGerarQR?.classList.add('hidden');
    els.btnRefresh?.classList.remove('hidden');
    els.qrInstru?.classList.remove('hidden');
  }

  async function refreshQR(){
    if (!window.currentInstance) return;
    try{
      hideQR();
      els.qrLoader?.classList.remove('hidden');
      showIllustration();
      const res = await apiPost(`/api/onboarding/empresas/qr/refresh/${encodeURIComponent(window.currentInstance)}`, {});
      els.qrLoader?.classList.add('hidden');
      const ok = renderQRFromResponse(res?.qrcode || {});
      wantQR = true;
      if (!ok) showIllustration();
    }catch(e){
      els.qrLoader?.classList.add('hidden');
      showQRError('Não foi possível atualizar o QR.');
    }
  }
  async function gerarPrimeiroQR(){ await refreshQR(); }

  // ===== Listeners =====
  els.btnAdd?.addEventListener('click', () => {
    if (els.btnAdd.disabled) {
      alert('Você atingiu o limite do seu plano. Remova um número ou faça upgrade.');
      return;
    }
    showModal();
    showIllustration();
    showQRError('');
    hideQR();
    wantQR = false;
    currentInstance = null;
    window.currentInstance = null;
  });
  els.btnCloseMd?.addEventListener('click', hideModal);
  els.btnCancel?.addEventListener('click', hideModal);
  els.form?.addEventListener('submit', handleConnectSubmit);
  els.btnRefresh?.addEventListener('click', refreshQR);
  els.btnGerarQR?.addEventListener('click', gerarPrimeiroQR);

  // Fechar clicando fora/ESC
  els.modal?.addEventListener('click', (e) => { if (e.target === els.modal) hideModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modal?.classList.contains('hidden')) hideModal();
  });

  // ===== Remoção com aceite =====
  let toRemove = null;
  function openRemoveModal(item){
    toRemove = item || null;
    if (!els.modalRem) return;
    if (els.remConsent) els.remConsent.checked = false;
    if (els.btnRemYes){
      els.btnRemYes.disabled = true;
      els.btnRemYes.classList.add('opacity-60','cursor-not-allowed');
    }
    els.modalRem.classList.remove('hidden');
  }
  function closeRemoveModal(){
    toRemove = null;
    els.modalRem?.classList.add('hidden');
  }
  els.remConsent?.addEventListener('change', () => {
    const allowed = !!els.remConsent?.checked;
    if (!els.btnRemYes) return;
    els.btnRemYes.disabled = !allowed;
    els.btnRemYes.classList.toggle('opacity-60', !allowed);
    els.btnRemYes.classList.toggle('cursor-not-allowed', !allowed);
  });
  els.btnRemNo?.addEventListener('click', closeRemoveModal);
  els.btnRemYes?.addEventListener('click', async () => {
    if (!toRemove) return;
    if (!els.remConsent?.checked){
      alert('Para remover definitivamente, confirme que está ciente de que TODOS os dados desta instância serão apagados.');
      return;
    }
    els.btnRemYes.disabled = true;
    els.btnRemNo.disabled  = true;
    try{
      const tries = [
        `/api/empresas/instancias/${encodeURIComponent(toRemove.id)}`,
        `/api/empresas/whatsapp/${encodeURIComponent(toRemove.instance_name)}`
      ];
      let success = false;
      let lastErr = '';
      for (const u of tries){
        try{
          const res = await apiDelete(u);
          if (res.ok === true && (res.status === 200 || res.status === 204)) { success = true; break; }
          else { lastErr = `DELETE ${u} → ${res.status}`; }
        }catch(e){ lastErr = String(e?.message || e); }
      }
      if (!success) { alert(`Não foi possível remover este número agora.\n${lastErr || ''}`.trim()); return; }
      closeRemoveModal();
      toast('Instância e todos os dados vinculados foram removidos.');
      await loadWhatsAppStatus();
    } finally {
      els.btnRemYes.disabled = false;
      els.btnRemNo.disabled  = false;
    }
  });

  // Toast
  let toastTimer = null;
  function toast(msg){
    const box = $('#global-msg');
    if (!box) return;
    box.textContent = msg;
    box.classList.remove('hidden');
    box.style.display = 'block';
    box.style.background = '#16a34a';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.add('hidden'), 3200);
  }

  // ===== Init =====
  if (!empresaId){
    console.warn('empresa_id ausente no localStorage; não foi possível carregar a lista.');
  } else {
    ensureEmpWS();
    loadWhatsAppStatus();
  }

  // encerramento
  window.addEventListener('beforeunload', () => {
    try { clearInterval(empHb); empWS?.close(); } catch {}
    instWS.forEach((ws, key) => { try{ stopInstHb(key); ws?.close(); }catch{} });
    try { prepBlock.anim?.destroy?.(); } catch {}
  });
})();
