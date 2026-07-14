
(function(){
  'use strict';

  const HELP_CONFIG = {"html":"conectar.html","script":"help-whatsapp.js","storage":"zaps_help_seen_whatsapp_v1","title":"Entenda a <span>Conexão do WhatsApp</span>","desc":"Conecte, monitore e reconecte os números de WhatsApp da empresa com segurança.","steps":[{"title":"Status geral","desc":"Acompanhe a situação de todos os números conectados.","icon":"chart","selectors":[".zc-smart-summary",".tabs",".box"]},{"title":"Ativos","desc":"Veja quais números estão conectados e funcionando.","icon":"check","selectors":["#zc-summary-active",".zc-smart-card--ok"]},{"title":"QR pendente","desc":"Entenda quais números ainda precisam leitura do QR Code.","icon":"qrcode","selectors":["#zc-summary-qr",".zc-smart-card--pending"]},{"title":"Precisa reconectar","desc":"Identifique números desconectados e quando reconectar.","icon":"refresh","selectors":["#zc-summary-reconnect",".zc-smart-card--danger"]},{"title":"Conectar número","desc":"Conecte seu primeiro WhatsApp para começar a atender no ZapsChat.","icon":"whatsapp","selectors":["#btn-open-modal","[data-open-connect-modal]",".zc-empty-cta"]}],"key":"whatsapp"};
  const ROBOT_SRC = '/frontend/img/zc-robot.png';
  const NS = 'zc-help-' + HELP_CONFIG.key;


  function iconSvg(type){
    const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    const icons = {
      grid:`<svg ${common}><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect></svg>`,
      filter:`<svg ${common}><path d="M3 5h18"></path><path d="M6 12h12"></path><path d="M10 19h4"></path></svg>`,
      chart:`<svg ${common}><path d="M4 19V9"></path><path d="M10 19V5"></path><path d="M16 19v-7"></path><path d="M22 19H2"></path></svg>`,
      line:`<svg ${common}><path d="M3 17l6-6 4 4 8-9"></path><path d="M21 6v6h-6"></path></svg>`,
      list:`<svg ${common}><path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path></svg>`,
      chat:`<svg ${common}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path></svg>`,
      eye:`<svg ${common}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
      send:`<svg ${common}><path d="M22 2L11 13"></path><path d="M22 2l-7 20-4-9-9-4 20-7z"></path></svg>`,
      user:`<svg ${common}><path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="7" r="4"></circle></svg>`,
      search:`<svg ${common}><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path></svg>`,
      plus:`<svg ${common}><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>`,
      file:`<svg ${common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M8 13h8"></path><path d="M8 17h6"></path></svg>`,
      clock:`<svg ${common}><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>`,
      users:`<svg ${common}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
      shield:`<svg ${common}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`,
      settings:`<svg ${common}><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.39 1.08V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.08-.39H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06A2 2 0 1 1 7.03 3.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .39-1.08V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.36.12.7.33 1 .6.3.3.47.67.51 1.08V11a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z"></path></svg>`,
      org:`<svg ${common}><rect x="8" y="3" width="8" height="5" rx="1"></rect><rect x="3" y="16" width="7" height="5" rx="1"></rect><rect x="14" y="16" width="7" height="5" rx="1"></rect><path d="M12 8v4"></path><path d="M6.5 16v-4h11v4"></path></svg>`,
      whatsapp:`<svg ${common}><path d="M20.5 11.5A8.5 8.5 0 0 1 8 19l-4 1 1.1-3.8A8.5 8.5 0 1 1 20.5 11.5z"></path><path d="M8.7 8.6c.2 2 2.3 4.2 4.8 5 .8.2 1.4-.5 1.7-1.1"></path></svg>`,
      qrcode:`<svg ${common}><rect x="3" y="3" width="6" height="6"></rect><rect x="15" y="3" width="6" height="6"></rect><rect x="3" y="15" width="6" height="6"></rect><path d="M15 15h2v2h-2z"></path><path d="M19 19h2v2h-2z"></path><path d="M15 21v-2h2"></path><path d="M21 15h-2v2"></path></svg>`,
      refresh:`<svg ${common}><path d="M21 12a9 9 0 0 1-15.5 6.2"></path><path d="M3 12A9 9 0 0 1 18.5 5.8"></path><path d="M18 2v4h4"></path><path d="M6 22v-4H2"></path></svg>`,
      edit:`<svg ${common}><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>`,
      check:`<svg ${common}><path d="M20 6L9 17l-5-5"></path></svg>`,
      building:`<svg ${common}><path d="M3 21h18"></path><path d="M5 21V5a2 2 0 0 1 2-2h7v18"></path><path d="M14 9h3a2 2 0 0 1 2 2v10"></path><path d="M8 7h2M8 11h2M8 15h2"></path></svg>`,
      robot:`<svg ${common}><rect x="5" y="8" width="14" height="10" rx="3"></rect><path d="M12 8V4"></path><circle cx="9" cy="13" r="1"></circle><circle cx="15" cy="13" r="1"></circle><path d="M9 17h6"></path></svg>`
    };
    return icons[type] || icons.grid;
  }


  function ready(fn){
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once:true });
    else fn();
  }

  function escapeHtml(value){
    return String(value == null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }

  function injectCss(){
    if (document.getElementById(NS + '-style')) return;
    const style = document.createElement('style');
    style.id = NS + '-style';
    style.textContent = `
      :root{
        --zc-help-green:#009b72;
        --zc-help-green-2:#13c58c;
        --zc-help-mint:#dffcef;
        --zc-help-ink:#0f172a;
        --zc-help-muted:#64748b;
        --zc-help-line:#dceee8;
        --zc-help-soft:#f7fbfa;
      }

      .zc-page-help-btn{
        position:fixed;
        right:24px;
        bottom:22px;
        z-index:99970;
        height:52px;
        min-width:118px;
        padding:0 18px;
        border:0;
        border-radius:999px;
        background:linear-gradient(135deg,var(--zc-help-green),var(--zc-help-green-2));
        color:#fff;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:9px;
        font:800 14px/1 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        box-shadow:0 18px 34px rgba(0,139,103,.28), 0 4px 10px rgba(15,23,42,.14);
        cursor:pointer;
        transition:transform .16s ease, box-shadow .16s ease, filter .16s ease;
      }
      .zc-page-help-btn:hover{transform:translateY(-2px);filter:saturate(1.08);box-shadow:0 22px 42px rgba(0,139,103,.34),0 6px 14px rgba(15,23,42,.16)}
      .zc-page-help-btn svg{width:19px;height:19px;}

      .zc-page-help-shell{
        position:fixed;
        inset:0;
        z-index:99980;
        pointer-events:none;
        font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      }
      .zc-page-help-shell.is-open{pointer-events:auto;}

      .zc-page-help-panel{
        position:absolute;
        top:16px;
        right:16px;
        bottom:16px;
        width:min(430px,calc(100vw - 32px));
        border:1px solid rgba(0,153,114,.18);
        border-radius:28px;
        background:
          radial-gradient(circle at 76% 8%, rgba(19,197,140,.28), transparent 33%),
          linear-gradient(145deg,#ecfff7 0%,#f7fffc 42%,#ffffff 100%);
        box-shadow:-20px 0 50px rgba(15,23,42,.13), 0 22px 65px rgba(0,139,103,.14);
        color:var(--zc-help-ink);
        overflow:hidden;
        transform:translateX(calc(100% + 38px));
        opacity:.7;
        transition:transform .22s cubic-bezier(.2,.8,.2,1), opacity .18s ease;
        display:flex;
        flex-direction:column;
      }
      .zc-page-help-shell.is-open .zc-page-help-panel{transform:translateX(0);opacity:1;}

      .zc-page-help-head{
        position:relative;
        min-height:260px;
        padding:28px 26px 16px;
        overflow:hidden;
      }
      .zc-page-help-kicker{
        display:inline-flex;
        align-items:center;
        gap:8px;
        color:#007f63;
        font-weight:900;
        font-size:14px;
        letter-spacing:.01em;
      }
      .zc-page-help-kicker svg{width:18px;height:18px;}
      .zc-page-help-close{
        position:absolute;
        top:18px;
        right:18px;
        width:42px;
        height:42px;
        border-radius:16px;
        border:1px solid rgba(15,23,42,.08);
        background:rgba(255,255,255,.78);
        color:#334155;
        display:grid;
        place-items:center;
        cursor:pointer;
        box-shadow:0 10px 22px rgba(15,23,42,.06);
      }
      .zc-page-help-close svg{width:18px;height:18px;}
      .zc-page-help-title{
        position:relative;
        z-index:2;
        margin:22px 0 12px;
        max-width:250px;
        font-size:28px;
        line-height:1.02;
        letter-spacing:-.045em;
        font-weight:950;
        color:#0f172a;
      }
      .zc-page-help-title span{color:#008b6b;display:inline-block;}
      .zc-page-help-desc{
        position:relative;
        z-index:2;
        max-width:258px;
        margin:0;
        color:#64748b;
        font-size:15px;
        line-height:1.48;
        font-weight:650;
      }
      .zc-page-help-robot-wrap{
        position:absolute;
        right:16px;
        top:64px;
        width:162px;
        height:162px;
        display:grid;
        place-items:center;
        pointer-events:none;
      }
      .zc-page-help-robot-glow{
        position:absolute;
        inset:20px 8px 0;
        border-radius:999px;
        background:radial-gradient(circle,rgba(0,190,145,.25),transparent 68%);
        filter:blur(8px);
      }
      .zc-page-help-robot{
        position:relative;
        width:150px;
        height:150px;
        object-fit:contain;
        filter:drop-shadow(0 18px 20px rgba(0,105,85,.18));
      }
      .zc-page-help-spark{position:absolute;width:10px;height:10px;color:#41d7b0;opacity:.75;}
      .zc-page-help-spark.s1{left:16px;top:82px}.zc-page-help-spark.s2{right:156px;top:128px;transform:scale(.75)}.zc-page-help-spark.s3{right:32px;top:190px;transform:scale(.65)}

      .zc-page-help-progress{
        padding:0 26px 14px;
      }
      .zc-page-help-step-label{
        display:flex;
        align-items:center;
        justify-content:space-between;
        margin-bottom:10px;
        color:#0f172a;
        font-weight:900;
        font-size:14px;
      }
      .zc-page-help-bar{
        height:7px;
        border-radius:999px;
        background:#d8eee7;
        overflow:hidden;
      }
      .zc-page-help-bar span{
        display:block;
        height:100%;
        width:20%;
        border-radius:999px;
        background:linear-gradient(90deg,#008b6b,#15c58d);
        transition:width .2s ease;
      }

      .zc-page-help-body{
        flex:1;
        overflow:auto;
        padding:8px 22px 18px;
        scrollbar-width:thin;
        scrollbar-color:#9eb8b0 transparent;
      }
      .zc-page-help-body::-webkit-scrollbar{width:8px}.zc-page-help-body::-webkit-scrollbar-thumb{background:#9eb8b0;border-radius:99px}.zc-page-help-body::-webkit-scrollbar-track{background:transparent}

      .zc-page-help-card{
        position:relative;
        width:100%;
        min-height:74px;
        border:1px solid rgba(15,23,42,.08);
        border-radius:18px;
        background:rgba(255,255,255,.86);
        box-shadow:0 12px 25px rgba(15,23,42,.05);
        margin:0 0 12px;
        display:grid;
        grid-template-columns:54px 1fr 22px;
        gap:12px;
        align-items:center;
        padding:13px 15px 13px 42px;
        text-align:left;
        cursor:pointer;
        transition:border-color .16s ease, transform .16s ease, box-shadow .16s ease, background .16s ease;
      }
      .zc-page-help-card:hover{transform:translateY(-1px);box-shadow:0 16px 32px rgba(15,23,42,.08)}
      .zc-page-help-card.is-active{border-color:rgba(0,153,114,.42);background:rgba(255,255,255,.96);box-shadow:0 16px 38px rgba(0,139,103,.12)}
      .zc-page-help-number{
        position:absolute;
        left:-13px;
        top:50%;
        transform:translateY(-50%);
        width:31px;
        height:31px;
        border-radius:50%;
        background:linear-gradient(135deg,#009b72,#13c58c);
        color:#fff;
        display:grid;
        place-items:center;
        font-weight:950;
        box-shadow:0 10px 18px rgba(0,139,103,.24);
        font-size:14px;
      }
      .zc-page-help-card-icon{
        width:52px;
        height:52px;
        border-radius:16px;
        background:#e6fff5;
        color:#008b6b;
        display:grid;
        place-items:center;
        border:1px solid rgba(0,153,114,.14);
      }
      .zc-page-help-card-icon svg{width:24px;height:24px;}
      .zc-page-help-card-title{font-size:15px;font-weight:950;color:#0f172a;margin:0 0 4px;line-height:1.18;}
      .zc-page-help-card-desc{font-size:13px;line-height:1.34;font-weight:650;color:#64748b;margin:0;}
      .zc-page-help-arrow{color:#8aa19a;display:grid;place-items:center;}
      .zc-page-help-arrow svg{width:17px;height:17px;}

      .zc-page-help-footer{
        padding:14px 22px 20px;
        background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,.94));
        border-top:1px solid rgba(15,23,42,.06);
      }
      .zc-page-help-primary{
        width:100%;
        height:52px;
        border:0;
        border-radius:16px;
        background:linear-gradient(135deg,#009b72,#13c58c);
        color:#fff;
        font-size:15px;
        font-weight:950;
        display:flex;
        align-items:center;
        justify-content:center;
        gap:10px;
        cursor:pointer;
        box-shadow:0 16px 30px rgba(0,139,103,.18);
      }
      .zc-page-help-secondary-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;}
      .zc-page-help-secondary{
        min-height:46px;
        border-radius:15px;
        border:1px solid rgba(0,139,103,.24);
        background:#fff;
        color:#006f58;
        font-size:14px;
        font-weight:900;
        display:flex;
        align-items:center;
        justify-content:center;
        gap:8px;
        cursor:pointer;
      }
      .zc-page-help-secondary.is-muted{border-color:rgba(15,23,42,.08);color:#0f172a;}
      .zc-page-help-secondary svg,.zc-page-help-primary svg{width:17px;height:17px;}

      .zc-page-help-hotspot{
        position:fixed;
        z-index:99975;
        width:30px;
        height:30px;
        border-radius:50%;
        border:3px solid #fff;
        background:linear-gradient(135deg,#009b72,#13c58c);
        color:#fff;
        font:950 13px/1 Inter,system-ui,sans-serif;
        display:none;
        align-items:center;
        justify-content:center;
        box-shadow:0 12px 24px rgba(0,139,103,.26), 0 0 0 8px rgba(0,153,114,.09);
        cursor:pointer;
        transform:translate(-50%,-50%);
      }
      .zc-page-help-shell.is-open .zc-page-help-hotspot{display:flex;}
      .zc-page-help-hotspot.is-active{box-shadow:0 14px 26px rgba(0,139,103,.34), 0 0 0 11px rgba(0,153,114,.16);}

      .zc-page-help-spotlight{
        position:fixed;
        z-index:99960;
        pointer-events:none;
        border:2px solid rgba(0,153,114,.5);
        border-radius:18px;
        box-shadow:0 0 0 9999px rgba(15,23,42,.025), 0 20px 38px rgba(0,139,103,.09);
        opacity:0;
        transition:opacity .16s ease, top .16s ease, left .16s ease, width .16s ease, height .16s ease;
      }
      .zc-page-help-shell.is-open .zc-page-help-spotlight.is-visible{opacity:1;}

      @media (max-width: 760px){
        .zc-page-help-panel{left:10px;right:10px;top:10px;bottom:10px;width:auto;border-radius:24px;}
        .zc-page-help-head{min-height:250px;padding:24px 22px 14px;}
        .zc-page-help-title{font-size:26px;max-width:230px;}
        .zc-page-help-desc{max-width:230px;font-size:14px;}
        .zc-page-help-robot-wrap{right:4px;top:70px;width:140px;height:140px;opacity:.95;}
        .zc-page-help-robot{width:132px;height:132px;}
        .zc-page-help-btn{right:16px;bottom:16px;min-width:106px;height:48px;}
      }
    `;
    document.head.appendChild(style);
  }

  function build(){
    if (document.getElementById(NS + '-shell')) return;
    injectCss();
    const shell = document.createElement('div');
    shell.id = NS + '-shell';
    shell.className = 'zc-page-help-shell';

    const cards = HELP_CONFIG.steps.map((step, i) => `
      <button type="button" class="zc-page-help-card" data-help-step="${i}">
        <span class="zc-page-help-number">${i+1}</span>
        <span class="zc-page-help-card-icon">${iconSvg(step.icon)}</span>
        <span>
          <strong class="zc-page-help-card-title">${escapeHtml(step.title)}</strong>
          <span class="zc-page-help-card-desc">${escapeHtml(step.desc)}</span>
        </span>
        <span class="zc-page-help-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"></path></svg></span>
      </button>`).join('');

    const hotspots = HELP_CONFIG.steps.map((_,i)=>`<button type="button" class="zc-page-help-hotspot" data-help-hotspot="${i}" aria-label="Ver passo ${i+1}">${i+1}</button>`).join('');

    shell.innerHTML = `
      <div class="zc-page-help-spotlight" aria-hidden="true"></div>
      ${hotspots}
      <aside class="zc-page-help-panel" role="dialog" aria-modal="false" aria-label="Ajuda da página">
        <header class="zc-page-help-head">
          <button type="button" class="zc-page-help-close" data-help-close aria-label="Fechar ajuda"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"></path><path d="M6 6l12 12"></path></svg></button>
          <div class="zc-page-help-kicker">${iconSvg('robot')} Ajuda</div>
          <h2 class="zc-page-help-title">${HELP_CONFIG.title}</h2>
          <p class="zc-page-help-desc">${escapeHtml(HELP_CONFIG.desc)}</p>
          <span class="zc-page-help-spark s1">✦</span><span class="zc-page-help-spark s2">✦</span><span class="zc-page-help-spark s3">✦</span>
          <div class="zc-page-help-robot-wrap" aria-hidden="true">
            <span class="zc-page-help-robot-glow"></span>
            <img class="zc-page-help-robot" src="${ROBOT_SRC}" alt="">
          </div>
        </header>
        <div class="zc-page-help-progress">
          <div class="zc-page-help-step-label"><span data-help-step-label>Passo 1 de ${HELP_CONFIG.steps.length}</span></div>
          <div class="zc-page-help-bar"><span data-help-progress></span></div>
        </div>
        <div class="zc-page-help-body" data-help-body>${cards}</div>
        <footer class="zc-page-help-footer">
          <button type="button" class="zc-page-help-primary" data-help-next>Próximo <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="M13 5l7 7-7 7"></path></svg></button>
          <div class="zc-page-help-secondary-row">
            <button type="button" class="zc-page-help-secondary" data-help-tour>${iconSvg('file')} Ver tour completo</button>
            <button type="button" class="zc-page-help-secondary is-muted" data-help-done>${iconSvg('check')} Entendi</button>
          </div>
        </footer>
      </aside>
    `;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'zc-page-help-btn';
    btn.innerHTML = `${iconSvg('chat')} <span>Ajuda</span>`;
    btn.setAttribute('aria-label', 'Abrir ajuda da página');
    btn.addEventListener('click', openHelp);

    document.body.appendChild(shell);
    document.body.appendChild(btn);

    shell.querySelector('[data-help-close]').addEventListener('click', closeHelp);
    shell.querySelector('[data-help-done]').addEventListener('click', doneHelp);
    shell.querySelector('[data-help-next]').addEventListener('click', nextStep);
    shell.querySelector('[data-help-tour]').addEventListener('click', function(){ setStep(0); openHelp(); });
    shell.querySelectorAll('[data-help-step]').forEach(el => el.addEventListener('click', () => setStep(Number(el.dataset.helpStep))));
    shell.querySelectorAll('[data-help-hotspot]').forEach(el => el.addEventListener('click', () => setStep(Number(el.dataset.helpHotspot))));
    document.querySelectorAll('[data-help-open], .js-help-open').forEach(el => el.addEventListener('click', openHelp));

    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeHelp(); });
    window.addEventListener('resize', schedulePosition);
    window.addEventListener('scroll', schedulePosition, true);
    setStep(0);
    schedulePosition();

    setTimeout(function(){
      if (!localStorage.getItem(HELP_CONFIG.storage)) openHelp();
    }, 900);
  }

  let activeStep = 0;
  let raf = 0;

  function shell(){ return document.getElementById(NS + '-shell'); }

  function openHelp(){
    const s = shell();
    if (!s) return;
    s.classList.add('is-open');
    schedulePosition();
  }

  function closeHelp(){
    const s = shell();
    if (!s) return;
    s.classList.remove('is-open');
  }

  function doneHelp(){
    try { localStorage.setItem(HELP_CONFIG.storage, '1'); } catch(_) {}
    closeHelp();
  }

  function nextStep(){
    if (activeStep >= HELP_CONFIG.steps.length - 1) { doneHelp(); return; }
    setStep(activeStep + 1);
  }

  function setStep(index){
    activeStep = Math.max(0, Math.min(HELP_CONFIG.steps.length - 1, index || 0));
    const s = shell();
    if (!s) return;
    s.querySelectorAll('[data-help-step]').forEach((el,i)=> el.classList.toggle('is-active', i === activeStep));
    s.querySelectorAll('[data-help-hotspot]').forEach((el,i)=> el.classList.toggle('is-active', i === activeStep));
    const label = s.querySelector('[data-help-step-label]');
    const progress = s.querySelector('[data-help-progress]');
    if (label) label.textContent = `Passo ${activeStep + 1} de ${HELP_CONFIG.steps.length}`;
    if (progress) progress.style.width = `${((activeStep + 1) / HELP_CONFIG.steps.length) * 100}%`;
    const currentCard = s.querySelector(`[data-help-step="${activeStep}"]`);
    if (currentCard) currentCard.scrollIntoView({ block:'nearest', behavior:'smooth' });
    schedulePosition();
  }

  function getTarget(step){
    const selectors = step.selectors || [];
    for (const selector of selectors){
      try {
        const el = document.querySelector(selector);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const visible = r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
        if (visible) return el;
      } catch(_) {}
    }
    return null;
  }

  function schedulePosition(){
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(positionHotspots);
  }

  function positionHotspots(){
    const s = shell();
    if (!s) return;
    const panel = s.querySelector('.zc-page-help-panel');
    const panelRect = panel ? panel.getBoundingClientRect() : null;
    HELP_CONFIG.steps.forEach(function(step, i){
      const dot = s.querySelector(`[data-help-hotspot="${i}"]`);
      if (!dot) return;
      const target = getTarget(step);
      if (!target){ dot.style.display = 'none'; return; }
      const r = target.getBoundingClientRect();
      let x = r.left + Math.min(Math.max(r.width * .08, 18), Math.max(18, r.width - 18));
      let y = r.top + Math.min(Math.max(r.height * .28, 18), Math.max(18, r.height - 18));
      if (panelRect && x > panelRect.left - 20 && y > panelRect.top && y < panelRect.bottom) {
        dot.style.display = 'none';
        return;
      }
      dot.style.left = `${Math.round(x)}px`;
      dot.style.top = `${Math.round(y)}px`;
      dot.style.display = s.classList.contains('is-open') ? 'flex' : 'none';
    });
    positionSpotlight();
  }

  function positionSpotlight(){
    const s = shell();
    if (!s) return;
    const light = s.querySelector('.zc-page-help-spotlight');
    if (!light) return;
    const target = getTarget(HELP_CONFIG.steps[activeStep]);
    if (!target){ light.classList.remove('is-visible'); return; }
    const r = target.getBoundingClientRect();
    const pad = 6;
    light.style.left = `${Math.max(6, r.left - pad)}px`;
    light.style.top = `${Math.max(6, r.top - pad)}px`;
    light.style.width = `${Math.max(20, r.width + pad*2)}px`;
    light.style.height = `${Math.max(20, r.height + pad*2)}px`;
    light.classList.add('is-visible');
  }

  ready(build);
})();
