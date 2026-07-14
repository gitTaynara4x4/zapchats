(function () {
  'use strict';

  const CFG = {
    "key": "configuracoes",
    "page": "Configurações",
    "title": "Entenda as Configurações",
    "intro": "Vou te mostrar onde alterar aparência, enviar relatos e entender os módulos em preparação.",
    "robotName": "Zappy",
    "robotSrc": "/frontend/img/help/zc-robot-floating.png",
    "storageKey": "zaps_help_configuracoes_robot_tour_seen_v1",
    "steps": [
        {
            "title": "Resumo da página",
            "say": "Aqui ficam as preferências gerais do sistema.",
            "desc": "A página de configurações concentra ajustes visuais, envio de relatos e módulos que ainda serão liberados.",
            "icon": "grid",
            "selectors": [
                ".section-title",
                ".settings-container",
                "main.main"
            ]
        },
        {
            "title": "Aparência",
            "say": "Esse card controla como o sistema aparece para o usuário.",
            "desc": "Use esta área para ajustar o tema visual do ZapsChat conforme a preferência do usuário ou dispositivo.",
            "icon": "filter",
            "selectors": [
                ".settings-grid .settings-col:nth-child(1) article.box:nth-child(1)",
                "#select-tema",
                ".select-wrap"
            ]
        },
        {
            "title": "Tema do sistema",
            "say": "Aqui você troca entre tema escuro e claro.",
            "desc": "A escolha do tema muda a aparência do sistema e ajuda a deixar a operação mais confortável no dia a dia.",
            "icon": "check",
            "selectors": [
                "#select-tema",
                ".select-wrap",
                ".form-group.field--full"
            ]
        },
        {
            "title": "Relatar bug ou sugestão",
            "say": "Use esse formulário quando encontrar erro ou tiver uma melhoria para enviar.",
            "desc": "Descreva o problema com clareza e envie para análise. Isso ajuda a registrar ajustes importantes do sistema.",
            "icon": "file",
            "selectors": [
                "#form-bug",
                "#bug-descricao",
                "#btn-enviar-bug"
            ]
        },
        {
            "title": "Empresa",
            "say": "Esse módulo está reservado para dados corporativos e identidade visual.",
            "desc": "Quando liberado, aqui ficarão configurações como empresa, logotipo, nome exibido e preferências globais.",
            "icon": "users",
            "selectors": [
                ".settings-grid .settings-col:nth-child(2) article.box:nth-child(1)",
                ".box.is-disabled",
                ".empty-config"
            ]
        },
        {
            "title": "Atendimento e automações",
            "say": "Esse espaço vai concentrar regras gerais de atendimento.",
            "desc": "A ideia é reunir preferências de fila, roteamento, horários, notificações e comportamento automático do sistema.",
            "icon": "chat",
            "selectors": [
                ".settings-grid .settings-col:nth-child(2) article.box:nth-child(2)",
                "article.box.is-disabled:nth-of-type(2)",
                ".settings-grid"
            ]
        }
    ]
};

  const NS = 'zc-robot-tour-configuracoes';
  let stepIndex = 0;
  let raf = 0;
  let scrollTimer = 0;

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function icon(name) {
    const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    const icons = {
      help: `<svg ${common}><circle cx="12" cy="12" r="9"></circle><path d="M9.5 9a2.6 2.6 0 0 1 5 1.1c0 1.8-2.5 2.1-2.5 4"></path><path d="M12 17h.01"></path></svg>`,
      chat: `<svg ${common}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path></svg>`,
      close: `<svg ${common}><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`,
      grid: `<svg ${common}><rect x="3" y="3" width="7" height="7" rx="1.4"></rect><rect x="14" y="3" width="7" height="7" rx="1.4"></rect><rect x="3" y="14" width="7" height="7" rx="1.4"></rect><rect x="14" y="14" width="7" height="7" rx="1.4"></rect></svg>`,
      filter: `<svg ${common}><path d="M4 5h16"></path><path d="M7 12h10"></path><path d="M10 19h4"></path></svg>`,
      chart: `<svg ${common}><path d="M4 19V9"></path><path d="M10 19V5"></path><path d="M16 19v-7"></path><path d="M22 19H2"></path></svg>`,
      line: `<svg ${common}><path d="M3 17l6-6 4 4 8-9"></path><path d="M21 6v6h-6"></path></svg>`,
      list: `<svg ${common}><path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path></svg>`,
      users: `<svg ${common}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
      userPlus: `<svg ${common}><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><path d="M20 8v6"></path><path d="M23 11h-6"></path></svg>`,
      file: `<svg ${common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M8 13h8"></path><path d="M8 17h6"></path></svg>`,
      check: `<svg ${common}><path d="M20 6 9 17l-5-5"></path></svg>`,
      left: `<svg ${common}><path d="M19 12H5"></path><path d="m11 19-7-7 7-7"></path></svg>`,
      right: `<svg ${common}><path d="M5 12h14"></path><path d="m13 5 7 7-7 7"></path></svg>`
    };
    return icons[name] || icons.help;
  }



  function helpWidgetIcon(name) {
    if (name === 'whatsapp') {
      return `<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M16.04 3.2A12.67 12.67 0 0 0 5.23 22.46L3.6 28.8l6.5-1.55A12.67 12.67 0 1 0 16.04 3.2Zm0 2.3a10.37 10.37 0 1 1 0 20.74c-1.74 0-3.44-.43-4.96-1.26l-.39-.22-3.78.9.95-3.66-.25-.4A10.37 10.37 0 0 1 16.04 5.5Zm-4.35 5.35c-.23-.52-.48-.53-.7-.54h-.6c-.2 0-.53.08-.8.38-.28.3-1.05 1.03-1.05 2.51s1.08 2.91 1.23 3.11c.15.2 2.08 3.34 5.16 4.55 2.56 1.01 3.08.81 3.64.76.56-.05 1.8-.74 2.05-1.45.25-.72.25-1.33.18-1.46-.08-.13-.28-.2-.58-.35-.3-.15-1.8-.89-2.08-.99-.28-.1-.48-.15-.68.15-.2.3-.78.99-.96 1.19-.18.2-.35.22-.65.07-.3-.15-1.27-.47-2.42-1.5-.9-.8-1.5-1.78-1.67-2.08-.18-.3-.02-.46.13-.61.13-.13.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.38-.03-.53-.07-.15-.67-1.65-.94-2.25Z"/></svg>`;
    }
    if (name === 'chevron') {
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>`;
    }
    return icon('help');
  }

  function createHelpWidget() {
    const widget = document.createElement('div');
    widget.className = 'zc-help-widget';
    widget.innerHTML = `
      <button type="button" class="zc-help-widget-bubble" aria-label="Abrir menu de ajuda">Precisa de ajuda?</button>
      <div class="zc-help-widget-menu" id="${NS}-widget-menu" role="menu" aria-label="Ajuda e suporte" hidden>
        <button type="button" class="zc-help-widget-item" data-zc-help-start role="menuitem">
          <span class="zc-help-widget-item-icon">${icon('help')}</span>
          <span class="zc-help-widget-copy"><strong>Ajuda</strong><small>Iniciar guia da página</small></span>
          <span class="zc-help-widget-chevron">${helpWidgetIcon('chevron')}</span>
        </button>
        <button type="button" class="zc-help-widget-item" data-zc-help-whatsapp role="menuitem">
          <span class="zc-help-widget-item-icon is-whatsapp">${helpWidgetIcon('whatsapp')}</span>
          <span class="zc-help-widget-copy"><strong>WhatsApp</strong><small>Falar com suporte</small></span>
          <span class="zc-help-widget-chevron">${helpWidgetIcon('chevron')}</span>
        </button>
      </div>
      <button type="button" class="zc-help-widget-toggle" aria-label="Abrir ajuda" aria-haspopup="menu" aria-expanded="false" aria-controls="${NS}-widget-menu">${icon('help')}</button>
    `;
    return widget;
  }

  function bindHelpWidget(widget) {
    if (!widget) return;
    const toggle = widget.querySelector('.zc-help-widget-toggle');
    const bubble = widget.querySelector('.zc-help-widget-bubble');
    const menu = widget.querySelector('.zc-help-widget-menu');
    const start = widget.querySelector('[data-zc-help-start]');
    const whatsapp = widget.querySelector('[data-zc-help-whatsapp]');
    let lastTouchAt = 0;

    function setOpen(open) {
      widget.classList.toggle('is-menu-open', !!open);
      if (menu) menu.hidden = !open;
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (bubble) bubble.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function toggleMenu(ev) {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      setOpen(!widget.classList.contains('is-menu-open'));
    }

    function bindWidgetActivator(el) {
      if (!el) return;
      el.addEventListener('touchend', function (ev) {
        lastTouchAt = Date.now();
        toggleMenu(ev);
      }, { passive: false });
      el.addEventListener('click', function (ev) {
        if (Date.now() - lastTouchAt < 450) {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        toggleMenu(ev);
      });
    }

    bindWidgetActivator(toggle);
    bindWidgetActivator(bubble);
    start?.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); setOpen(false); openTour(0); });
    whatsapp?.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); setOpen(false); openSupportWhatsApp(); });
    document.addEventListener('click', function (ev) { if (widget.classList.contains('is-menu-open') && !widget.contains(ev.target)) setOpen(false); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') setOpen(false); });
  }

  function closeHelpWidgetMenu() {
    const widget = document.querySelector('.zc-help-widget');
    if (!widget) return;
    widget.classList.remove('is-menu-open');
    const menu = widget.querySelector('.zc-help-widget-menu');
    const toggle = widget.querySelector('.zc-help-widget-toggle');
    if (menu) menu.hidden = true;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  function openSupportWhatsApp() {
    const phone = String(window.ZAPSCHAT_SUPPORT_WHATSAPP || '5512991865418').replace(/\D/g, '');
    const page = CFG.page || document.title || 'ZapsChat';
    const text = encodeURIComponent(`Olá! Preciso de ajuda no ZapsChat. Estou na página: ${page}.`);
    window.open(`https://wa.me/${phone}?text=${text}`, '_blank', 'noopener,noreferrer');
  }


  function cleanOldHelp() {
    [
      '.zc-page-help-shell',
      '.zc-page-help-btn',
      '.zc-guided-help-shell',
      '.zc-guided-help-btn',
      '.zc-help-dashboard-shell',
      '.zc-help-dashboard-btn',
      '.zc-robot-tour-shell',
      '.zc-robot-tour-open-btn',
      '.zc-help-dot',
      '.zc-page-help-dot',
      '.zc-help-widget'
    ].forEach(function (selector) {
      document.querySelectorAll(selector).forEach(function (el) { el.remove(); });
    });
  }

  function injectCss() {
    if (document.getElementById(NS + '-style')) return;

    const style = document.createElement('style');
    style.id = NS + '-style';
    style.textContent = `
      :root{
        --zc-tour-green:#008b6b;
        --zc-tour-green-dark:#00785d;
        --zc-tour-green-soft:#e9f8f3;
        --zc-tour-ink:#0f172a;
        --zc-tour-muted:#64748b;
        --zc-tour-line:#dbe5e2;
      }

      .zc-robot-tour-open-btn{
        position:fixed;
        right:24px;
        bottom:22px;
        z-index:99960;
        height:52px;
        min-width:118px;
        border:0;
        border-radius:999px;
        padding:0 18px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:9px;
        background:var(--zc-tour-green);
        color:#fff;
        font:800 14px/1 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        box-shadow:0 16px 32px rgba(0,139,103,.24),0 4px 12px rgba(15,23,42,.14);
        cursor:pointer;
        transition:transform .16s ease,box-shadow .16s ease,background .16s ease,opacity .16s ease;
      }
      .zc-robot-tour-open-btn:hover{
        transform:translateY(-2px);
        background:var(--zc-tour-green-dark);
        box-shadow:0 20px 40px rgba(0,139,103,.30),0 6px 16px rgba(15,23,42,.16);
      }
      .zc-robot-tour-open-btn.is-hidden{
        opacity:0;
        pointer-events:none;
        transform:translateY(8px);
      }
      .zc-robot-tour-open-btn svg{width:19px;height:19px;}

      .zc-robot-tour-shell{
        position:fixed;
        inset:0;
        z-index:99980;
        display:none;
        pointer-events:none;
        font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      }
      .zc-robot-tour-shell.is-open{display:block;pointer-events:none;}

      .zc-robot-tour-spotlight{
        position:fixed;
        z-index:99981;
        border:2px solid rgba(0,139,103,.76);
        border-radius:20px;
        pointer-events:none;
        opacity:0;
        box-shadow:
          0 0 0 9999px rgba(15,23,42,.55),
          0 24px 60px rgba(0,139,103,.18),
          inset 0 0 0 1px rgba(255,255,255,.88);
        transition:opacity .16s ease,top .18s ease,left .18s ease,width .18s ease,height .18s ease,border-radius .18s ease;
      }
      .zc-robot-tour-shell.is-open .zc-robot-tour-spotlight.is-visible{opacity:1;}

      .zc-robot-tour-stage{
        position:fixed;
        z-index:99990;
        left:var(--zc-tour-stage-left, 50%);
        top:var(--zc-tour-stage-top, 50%);
        transform:scale(.985);
        transform-origin:top left;
        display:grid;
        grid-template-columns:150px minmax(360px,460px);
        grid-template-areas:"robot card";
        align-items:end;
        gap:0;
        width:min(620px,calc(100vw - 32px));
        opacity:0;
        pointer-events:none;
        transition:opacity .18s ease,transform .18s ease,left .18s ease,top .18s ease;
      }
      .zc-robot-tour-shell.is-open .zc-robot-tour-stage{
        opacity:1;
        transform:scale(1);
      }
      .zc-robot-tour-stage[data-position="left"]{
        grid-template-columns:minmax(360px,460px) 150px;
        grid-template-areas:"card robot";
      }

      .zc-robot-tour-robot-wrap{
        grid-area:robot;
        position:relative;
        z-index:2;
        display:flex;
        align-items:flex-end;
        justify-content:flex-end;
        pointer-events:none;
      }
      .zc-robot-tour-stage[data-position="left"] .zc-robot-tour-robot-wrap{
        justify-content:flex-start;
      }
      .zc-robot-tour-robot{
        width:136px;
        max-width:20vw;
        height:auto;
        pointer-events:none;
        user-select:none;
        margin-right:-12px;
        filter:drop-shadow(0 20px 24px rgba(0,139,103,.22)) drop-shadow(0 12px 18px rgba(15,23,42,.18));
        animation:zcRobotTourFloat 3.4s ease-in-out infinite;
      }
      .zc-robot-tour-stage[data-position="left"] .zc-robot-tour-robot{
        margin-right:0;
        margin-left:-12px;
      }
      @keyframes zcRobotTourFloat{
        0%,100%{transform:translateY(0);}
        50%{transform:translateY(-9px);}
      }

      .zc-robot-tour-card{
        grid-area:card;
        position:relative;
        background:#fff;
        border:1px solid rgba(15,23,42,.10);
        border-radius:26px;
        color:var(--zc-tour-ink);
        overflow:visible;
        box-shadow:0 28px 78px rgba(15,23,42,.27),0 10px 24px rgba(15,23,42,.13);
        pointer-events:auto;
      }
      .zc-robot-tour-card::before{
        content:"";
        position:absolute;
        left:-16px;
        top:78px;
        width:22px;
        height:28px;
        background:#fff;
        clip-path:polygon(100% 0, 0 50%, 100% 100%);
        filter:drop-shadow(-1px 0 0 rgba(15,23,42,.10));
      }
      .zc-robot-tour-stage[data-position="left"] .zc-robot-tour-card::before{
        left:auto;
        right:-16px;
        clip-path:polygon(0 0, 100% 50%, 0 100%);
        filter:drop-shadow(1px 0 0 rgba(15,23,42,.10));
      }

      .zc-robot-tour-head{
        position:relative;
        padding:24px 24px 18px;
        border-bottom:1px solid rgba(15,23,42,.075);
      }
      .zc-robot-tour-kicker{
        display:inline-flex;
        align-items:center;
        gap:8px;
        margin:0 48px 8px 0;
        color:var(--zc-tour-green);
        font-size:13px;
        font-weight:850;
      }
      .zc-robot-tour-kicker svg{width:17px;height:17px;}
      .zc-robot-tour-title{
        margin:0;
        color:#0f172a;
        font-size:25px;
        line-height:1.12;
        letter-spacing:-.04em;
        font-weight:900;
      }
      .zc-robot-tour-intro{
        margin:10px 22px 0 0;
        color:var(--zc-tour-muted);
        font-size:14.5px;
        line-height:1.55;
        font-weight:560;
      }
      .zc-robot-tour-voice{
        display:flex;
        align-items:flex-start;
        gap:10px;
        margin-top:14px;
        padding:12px 14px;
        border-radius:18px;
        background:linear-gradient(180deg,#f2fbf7 0%, #e8f8f1 100%);
        border:1px solid rgba(0,139,103,.12);
      }
      .zc-robot-tour-voice-badge{
        flex:0 0 auto;
        width:34px;
        height:34px;
        border-radius:12px;
        display:grid;
        place-items:center;
        background:#fff;
        border:1px solid rgba(0,139,103,.14);
        color:var(--zc-tour-green);
        box-shadow:0 8px 16px rgba(0,139,103,.08);
      }
      .zc-robot-tour-voice-badge svg{width:18px;height:18px;}
      .zc-robot-tour-voice-meta{display:flex;flex-direction:column;gap:4px;min-width:0;}
      .zc-robot-tour-voice-label{
        color:var(--zc-tour-green);
        font-size:12px;
        font-weight:900;
        letter-spacing:.02em;
      }
      .zc-robot-tour-voice-text{
        margin:0;
        color:#0f172a;
        font-size:13.5px;
        line-height:1.5;
        font-weight:700;
      }
      .zc-robot-tour-close{
        position:absolute;
        top:18px;
        right:18px;
        width:40px;
        height:40px;
        border-radius:15px;
        border:1px solid rgba(15,23,42,.10);
        background:#fff;
        color:#334155;
        display:grid;
        place-items:center;
        cursor:pointer;
        transition:background .16s ease,color .16s ease,transform .16s ease;
      }
      .zc-robot-tour-close:hover{background:#f8fafc;color:#0f172a;transform:translateY(-1px);}
      .zc-robot-tour-close svg{width:18px;height:18px;}

      .zc-robot-tour-content{padding:22px 24px 20px;}
      .zc-robot-tour-body{
        display:grid;
        grid-template-columns:54px 1fr;
        gap:16px;
        align-items:flex-start;
      }
      .zc-robot-tour-icon{
        width:52px;
        height:52px;
        border-radius:18px;
        display:grid;
        place-items:center;
        background:var(--zc-tour-green-soft);
        border:1px solid rgba(0,139,103,.14);
        color:var(--zc-tour-green);
      }
      .zc-robot-tour-icon svg{width:25px;height:25px;}
      .zc-robot-tour-step-title{
        margin:0 0 8px;
        font-size:19px;
        line-height:1.2;
        font-weight:900;
        letter-spacing:-.025em;
        color:#0f172a;
      }
      .zc-robot-tour-step-desc{
        margin:0;
        color:var(--zc-tour-muted);
        font-size:14px;
        line-height:1.55;
        font-weight:560;
      }
      .zc-robot-tour-progress-area{margin-top:20px;}
      .zc-robot-tour-meta{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        margin-bottom:8px;
        color:#334155;
        font-size:12px;
        font-weight:850;
        text-transform:uppercase;
        letter-spacing:.055em;
      }
      .zc-robot-tour-bar{
        height:6px;
        border-radius:999px;
        background:#edf2f1;
        overflow:hidden;
      }
      .zc-robot-tour-bar span{
        display:block;
        height:100%;
        width:20%;
        background:var(--zc-tour-green);
        border-radius:999px;
        transition:width .18s ease;
      }
      .zc-robot-tour-actions{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        padding:16px 24px 22px;
        border-top:1px solid rgba(15,23,42,.075);
        background:#fbfdfc;
        border-radius:0 0 26px 26px;
      }
      .zc-robot-tour-actions-left,
      .zc-robot-tour-actions-right{
        display:flex;
        align-items:center;
        gap:10px;
      }
      .zc-robot-tour-ghost,
      .zc-robot-tour-primary{
        height:44px;
        border-radius:15px;
        padding:0 15px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:8px;
        cursor:pointer;
        font:850 13px/1 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        transition:transform .15s ease,box-shadow .15s ease,background .15s ease,border-color .15s ease;
      }
      .zc-robot-tour-ghost{
        border:1px solid rgba(15,23,42,.11);
        background:#fff;
        color:#334155;
      }
      .zc-robot-tour-ghost:hover{background:#f8fafc;border-color:rgba(15,23,42,.17);}
      .zc-robot-tour-ghost:disabled{opacity:.44;cursor:not-allowed;}
      .zc-robot-tour-primary{
        min-width:118px;
        border:1px solid var(--zc-tour-green);
        background:var(--zc-tour-green);
        color:#fff;
        box-shadow:0 12px 24px rgba(0,139,103,.20);
      }
      .zc-robot-tour-primary:hover{
        transform:translateY(-1px);
        background:var(--zc-tour-green-dark);
        border-color:var(--zc-tour-green-dark);
        box-shadow:0 16px 30px rgba(0,139,103,.25);
      }
      .zc-robot-tour-ghost svg,
      .zc-robot-tour-primary svg{width:16px;height:16px;}

      .zc-help-widget{
        position:fixed;right:24px;bottom:22px;z-index:99960;
        display:flex;flex-direction:column;align-items:flex-end;gap:12px;
        font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        opacity:1;transform:translateY(0);transition:opacity .16s ease,transform .16s ease;
        touch-action:manipulation;
      }
      .zc-help-widget.is-hidden{opacity:0;pointer-events:none;transform:translateY(10px);}
      .zc-help-widget-bubble{
        position:relative;display:inline-flex;align-items:center;justify-content:center;min-height:34px;
        padding:9px 12px;border:1px solid rgba(15,23,42,.08);border-radius:14px;
        background:rgba(255,255,255,.96);color:#008169;font-size:12px;line-height:1;font-weight:850;
        box-shadow:0 10px 26px rgba(15,23,42,.12);user-select:none;cursor:pointer;
        font-family:inherit;-webkit-appearance:none;appearance:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;
        transition:opacity .14s ease,transform .14s ease,visibility .14s ease,box-shadow .14s ease,border-color .14s ease;
      }
      .zc-help-widget-bubble:hover{border-color:rgba(0,129,105,.22);box-shadow:0 14px 30px rgba(15,23,42,.14);}
      .zc-help-widget-bubble:active{transform:translateY(1px);}
      .zc-help-widget-bubble::after{content:"";position:absolute;right:18px;bottom:-6px;width:12px;height:12px;background:rgba(255,255,255,.96);border-right:1px solid rgba(15,23,42,.08);border-bottom:1px solid rgba(15,23,42,.08);transform:rotate(45deg);}
      .zc-help-widget.is-menu-open .zc-help-widget-bubble{opacity:0;visibility:hidden;transform:translateY(6px) scale(.96);pointer-events:none;}
      .zc-help-widget-menu{
        position:relative;width:min(304px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 116px));overflow:auto;
        padding:8px;border:1px solid rgba(15,23,42,.10);
        border-radius:22px;background:#fff;color:#0f172a;box-shadow:0 24px 64px rgba(15,23,42,.18),0 10px 26px rgba(0,129,105,.14);
        transform-origin:bottom right;animation:zcHelpWidgetMenuIn .16s ease both;-webkit-overflow-scrolling:touch;
      }
      .zc-help-widget-menu[hidden]{display:none;}
      .zc-help-widget-menu::after{content:"";position:absolute;right:24px;bottom:-8px;width:16px;height:16px;background:#fff;border-right:1px solid rgba(15,23,42,.10);border-bottom:1px solid rgba(15,23,42,.10);transform:rotate(45deg);}
      @keyframes zcHelpWidgetMenuIn{from{opacity:0;transform:translateY(8px) scale(.97);}to{opacity:1;transform:translateY(0) scale(1);}}
      .zc-help-widget-item{position:relative;z-index:1;width:100%;min-height:70px;padding:12px 10px;border:0;border-radius:16px;background:transparent;color:#0f172a;display:grid;grid-template-columns:44px 1fr 20px;align-items:center;gap:12px;text-align:left;cursor:pointer;font-family:inherit;transition:background .14s ease,transform .14s ease;}
      .zc-help-widget-item + .zc-help-widget-item{margin-top:4px;}
      .zc-help-widget-item + .zc-help-widget-item::before{content:"";position:absolute;left:12px;right:12px;top:-2px;height:1px;background:rgba(15,23,42,.08);}
      .zc-help-widget-item:hover{background:#f6fbf9;transform:translateY(-1px);}
      .zc-help-widget-item-icon{width:42px;height:42px;border-radius:15px;display:grid;place-items:center;color:#008169;background:#e9f8f3;border:1px solid rgba(0,129,105,.12);}
      .zc-help-widget-item-icon.is-whatsapp{color:#fff;background:#18b944;border-color:#18b944;box-shadow:0 10px 20px rgba(24,185,68,.22);}
      .zc-help-widget-item-icon svg{width:22px;height:22px;}
      .zc-help-widget-copy{min-width:0;display:flex;flex-direction:column;gap:4px;}
      .zc-help-widget-copy strong{color:#0f172a;font-size:14px;line-height:1.1;font-weight:900;letter-spacing:-.02em;}
      .zc-help-widget-copy small{color:#64748b;font-size:12.5px;line-height:1.25;font-weight:600;}
      .zc-help-widget-chevron{color:#64748b;display:grid;place-items:center;}.zc-help-widget-chevron svg{width:18px;height:18px;}
      .zc-help-widget-toggle{width:60px;height:60px;border:0;border-radius:999px;display:grid;place-items:center;background:linear-gradient(145deg,#009b72 0%,#008169 62%,#006f5a 100%);color:#fff;box-shadow:0 18px 34px rgba(0,129,105,.30),0 6px 16px rgba(15,23,42,.18);cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .16s ease,box-shadow .16s ease,filter .16s ease;}
      .zc-help-widget-toggle:hover{transform:translateY(-2px);filter:saturate(1.08);box-shadow:0 22px 42px rgba(0,129,105,.36),0 8px 18px rgba(15,23,42,.20);}
      .zc-help-widget-toggle:active{transform:translateY(0) scale(.98);}.zc-help-widget-toggle svg{width:29px;height:29px;}
      @media (max-width:760px){.zc-help-widget{right:14px;bottom:max(14px,env(safe-area-inset-bottom,0px));gap:10px}.zc-help-widget-toggle{width:56px;height:56px}.zc-help-widget-toggle svg{width:26px;height:26px}.zc-help-widget-menu{width:min(292px,calc(100vw - 28px));max-height:min(340px,calc(100vh - 108px));border-radius:20px}.zc-help-widget-item{min-height:64px;grid-template-columns:40px 1fr 18px;gap:10px}.zc-help-widget-item-icon{width:40px;height:40px;border-radius:14px}.zc-help-widget-bubble{font-size:11.5px;min-height:32px;padding:8px 10px}}
      @media (max-width:480px){.zc-help-widget{right:12px;bottom:max(12px,env(safe-area-inset-bottom,0px))}.zc-help-widget-menu{width:min(286px,calc(100vw - 24px));padding:7px}.zc-help-widget-copy strong{font-size:13.5px}.zc-help-widget-copy small{font-size:12px}}


      @media (max-width:1020px){
        .zc-robot-tour-stage{
          grid-template-columns:126px minmax(328px,420px);
          width:min(560px,calc(100vw - 28px));
        }
        .zc-robot-tour-stage[data-position="left"]{
          grid-template-columns:minmax(328px,420px) 126px;
        }
        .zc-robot-tour-robot{width:114px;max-width:114px;}
      }

      @media (max-width:760px){
        .zc-robot-tour-open-btn{
          right:14px;
          bottom:14px;
          height:46px;
          min-width:0;
          padding:0 16px;
          gap:8px;
          font-size:13px;
        }
        .zc-robot-tour-stage{
          left:10px !important;
          right:10px;
          bottom:max(10px, env(safe-area-inset-bottom, 0px));
          top:auto !important;
          width:auto;
          max-width:none;
          transform:translateY(10px) scale(.985);
          transform-origin:bottom center;
          display:block;
        }
        .zc-robot-tour-shell.is-open .zc-robot-tour-stage{transform:translateY(0) scale(1);}
        .zc-robot-tour-robot-wrap,
        .zc-robot-tour-robot{display:none !important;}
        .zc-robot-tour-card{
          max-height:min(62vh, calc(100vh - 24px));
          overflow:auto;
          border-radius:22px;
        }
        .zc-robot-tour-card::before{display:none;}
        .zc-robot-tour-head{padding:18px 18px 14px;}
        .zc-robot-tour-kicker{margin-right:42px;}
        .zc-robot-tour-title{font-size:21px;}
        .zc-robot-tour-intro{margin-right:0;font-size:13.5px;line-height:1.5;}
        .zc-robot-tour-voice{padding:11px 12px;border-radius:16px;margin-top:12px;}
        .zc-robot-tour-voice-badge{width:30px;height:30px;border-radius:10px;}
        .zc-robot-tour-voice-text{font-size:13px;}
        .zc-robot-tour-content{padding:18px;}
        .zc-robot-tour-body{grid-template-columns:44px 1fr;gap:12px;}
        .zc-robot-tour-icon{width:44px;height:44px;border-radius:15px;}
        .zc-robot-tour-icon svg{width:22px;height:22px;}
        .zc-robot-tour-step-title{font-size:18px;}
        .zc-robot-tour-step-desc{font-size:13.5px;line-height:1.5;}
        .zc-robot-tour-progress-area{margin-top:16px;}
        .zc-robot-tour-actions{
          display:grid;
          grid-template-columns:1fr 1fr;
          gap:10px;
          padding:14px 18px 18px;
          border-radius:0 0 22px 22px;
        }
        .zc-robot-tour-actions-left,.zc-robot-tour-actions-right{display:contents;}
        .zc-robot-tour-ghost,.zc-robot-tour-primary{width:100%;min-width:0;height:42px;}
      }

      @media (max-width:480px){
        .zc-robot-tour-open-btn{
          left:12px;
          right:12px;
          bottom:12px;
          justify-content:center;
        }
        .zc-robot-tour-stage{
          left:8px !important;
          right:8px;
          bottom:8px;
        }
        .zc-robot-tour-card{
          max-height:min(66vh, calc(100vh - 16px));
          border-radius:20px;
        }
        .zc-robot-tour-head{padding:16px 16px 13px;}
        .zc-robot-tour-title{font-size:19px;}
        .zc-robot-tour-content{padding:16px;}
        .zc-robot-tour-actions{
          grid-template-columns:1fr;
          padding:12px 16px 16px;
          border-radius:0 0 20px 20px;
        }
        .zc-robot-tour-meta{flex-wrap:wrap;}
      }

    `;
    document.head.appendChild(style);
  }

  function build() {
    cleanOldHelp();
    injectCss();

    const shell = document.createElement('div');
    shell.id = NS + '-shell';
    shell.className = 'zc-robot-tour-shell';
    shell.innerHTML = `
      <div class="zc-robot-tour-spotlight" aria-hidden="true"></div>
      <div class="zc-robot-tour-stage" aria-live="polite" data-position="right">
        <div class="zc-robot-tour-robot-wrap">
          <img class="zc-robot-tour-robot" src="${CFG.robotSrc}" alt="" aria-hidden="true">
        </div>
        <section class="zc-robot-tour-card" role="dialog" aria-modal="false" aria-label="Ajuda guiada de Configurações">
          <div class="zc-robot-tour-head">
            <div class="zc-robot-tour-kicker">${icon('help')} <span>Ajuda guiada</span></div>
            <h2 class="zc-robot-tour-title">${CFG.title}</h2>
            <p class="zc-robot-tour-intro">${CFG.intro}</p>
            <div class="zc-robot-tour-voice">
              <div class="zc-robot-tour-voice-badge">${icon('chat')}</div>
              <div class="zc-robot-tour-voice-meta">
                <span class="zc-robot-tour-voice-label">${CFG.robotName} diz</span>
                <p class="zc-robot-tour-voice-text" data-zc-tour-say>${CFG.steps[0].say || CFG.intro}</p>
              </div>
            </div>
            <button type="button" class="zc-robot-tour-close" data-zc-tour-close aria-label="Fechar ajuda">${icon('close')}</button>
          </div>
          <div class="zc-robot-tour-content">
            <div class="zc-robot-tour-body">
              <div class="zc-robot-tour-icon" data-zc-tour-icon>${icon(CFG.steps[0].icon)}</div>
              <div>
                <h3 class="zc-robot-tour-step-title" data-zc-tour-title>${CFG.steps[0].title}</h3>
                <p class="zc-robot-tour-step-desc" data-zc-tour-desc>${CFG.steps[0].desc}</p>
              </div>
            </div>
            <div class="zc-robot-tour-progress-area">
              <div class="zc-robot-tour-meta">
                <span data-zc-tour-step>Passo 1 de ${CFG.steps.length}</span>
                <span>${CFG.page}</span>
              </div>
              <div class="zc-robot-tour-bar"><span data-zc-tour-progress></span></div>
            </div>
          </div>
          <div class="zc-robot-tour-actions">
            <div class="zc-robot-tour-actions-left">
              <button type="button" class="zc-robot-tour-ghost" data-zc-tour-prev>${icon('left')} <span>Voltar</span></button>
            </div>
            <div class="zc-robot-tour-actions-right">
              <button type="button" class="zc-robot-tour-ghost" data-zc-tour-done>${icon('check')} <span>Entendi</span></button>
              <button type="button" class="zc-robot-tour-primary" data-zc-tour-next><span>Próximo</span> ${icon('right')}</button>
            </div>
          </div>
        </section>
      </div>
    `;

    const helpWidget = createHelpWidget();

    document.body.appendChild(shell);
    document.body.appendChild(helpWidget);

    bindHelpWidget(helpWidget);
    shell.querySelector('[data-zc-tour-close]').addEventListener('click', closeTour);
    shell.querySelector('[data-zc-tour-done]').addEventListener('click', finishTour);
    shell.querySelector('[data-zc-tour-prev]').addEventListener('click', prevStep);
    shell.querySelector('[data-zc-tour-next]').addEventListener('click', nextStep);

    document.querySelectorAll('[data-help-open], .js-help-open').forEach(function (el) {
      el.addEventListener('click', function () { openTour(0); });
    });

    // Permite navegar pelo sidebar mesmo com a ajuda aberta.
    // O clique passa para o menu e o tour é fechado antes da troca de página.
    document.addEventListener('click', function (ev) {
      if (!isOpen()) return;
      const link = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!link) return;
      if (link.closest('aside, nav, .sidebar, .app-sidebar, .main-sidebar, #sidebar, #app-sidebar')) {
        closeTour();
      }
    }, true);

    document.addEventListener('keydown', function (ev) {
      if (!isOpen()) return;
      if (ev.key === 'Escape') closeTour();
      if (ev.key === 'ArrowRight') nextStep();
      if (ev.key === 'ArrowLeft') prevStep();
    });

    window.addEventListener('resize', scheduleSpotlight);
    window.addEventListener('scroll', scheduleSpotlight, true);

    updateStep(0, false);
  }

  function getShell() { return document.getElementById(NS + '-shell'); }
  function getOpenBtn() { return document.querySelector('.zc-help-widget'); }
  function isOpen() { const s = getShell(); return !!(s && s.classList.contains('is-open')); }

  function isCompactViewport() {
    return window.innerWidth <= 760;
  }

  function openTour(index) {
    const s = getShell();
    if (!s) return;

    const light = s.querySelector('.zc-robot-tour-spotlight');
    const stage = s.querySelector('.zc-robot-tour-stage');
    s.style.display = 'block';
    s.style.pointerEvents = 'none';
    s.removeAttribute('aria-hidden');
    if (light) light.style.display = '';
    if (stage) {
      stage.style.display = '';
      stage.style.removeProperty('left');
      stage.style.removeProperty('top');
      stage.style.removeProperty('right');
      stage.style.removeProperty('bottom');
    }

    updateStep(Number.isFinite(index) ? index : 0, false);
    s.classList.add('is-open');
    getOpenBtn()?.classList.add('is-hidden');
    scrollToCurrentTarget();
    scheduleSpotlight();
  }

  function closeTour() {
    const s = getShell();
    if (!s) return;

    s.classList.remove('is-open');
    s.style.pointerEvents = 'none';
    s.setAttribute('aria-hidden', 'true');
    getOpenBtn()?.classList.remove('is-hidden');

    const light = s.querySelector('.zc-robot-tour-spotlight');
    const stage = s.querySelector('.zc-robot-tour-stage');
    if (light) {
      light.classList.remove('is-visible');
      light.style.left = '-9999px';
      light.style.top = '-9999px';
      light.style.width = '0px';
      light.style.height = '0px';
    }

    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    clearTimeout(scrollTimer);

    // Fecha de verdade a camada depois da transição.
    // Isso evita que qualquer overlay antigo continue acima do sidebar após clicar em Finalizar.
    window.setTimeout(function () {
      if (s.classList.contains('is-open')) return;
      s.style.display = 'none';
      s.style.pointerEvents = 'none';
      if (light) light.style.display = 'none';
      if (stage) stage.style.display = 'none';
    }, 220);
  }

  function finishTour() {
    try { localStorage.setItem(CFG.storageKey, '1'); } catch (_) {}
    closeTour();
  }

  function prevStep() {
    if (stepIndex <= 0) return;
    updateStep(stepIndex - 1, true);
  }

  function nextStep() {
    if (stepIndex >= CFG.steps.length - 1) {
      finishTour();
      return;
    }
    updateStep(stepIndex + 1, true);
  }

  function updateStep(index, shouldScroll) {
    stepIndex = Math.max(0, Math.min(CFG.steps.length - 1, index || 0));
    const step = CFG.steps[stepIndex];
    const s = getShell();
    if (!s) return;

    const iconBox = s.querySelector('[data-zc-tour-icon]');
    const title = s.querySelector('[data-zc-tour-title]');
    const desc = s.querySelector('[data-zc-tour-desc]');
    const say = s.querySelector('[data-zc-tour-say]');
    const label = s.querySelector('[data-zc-tour-step]');
    const progress = s.querySelector('[data-zc-tour-progress]');
    const prev = s.querySelector('[data-zc-tour-prev]');
    const next = s.querySelector('[data-zc-tour-next]');

    if (iconBox) iconBox.innerHTML = icon(step.icon);
    if (title) title.textContent = step.title;
    if (desc) desc.textContent = step.desc;
    if (say) say.textContent = step.say || CFG.intro;
    if (label) label.textContent = `Passo ${stepIndex + 1} de ${CFG.steps.length}`;
    if (progress) progress.style.width = `${((stepIndex + 1) / CFG.steps.length) * 100}%`;
    if (prev) prev.disabled = stepIndex === 0;
    if (next) next.innerHTML = stepIndex === CFG.steps.length - 1
      ? `<span>Finalizar</span> ${icon('check')}`
      : `<span>Próximo</span> ${icon('right')}`;

    if (shouldScroll) scrollToCurrentTarget();
    scheduleSpotlight();
  }

  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    return rect.width > 6 && rect.height > 6 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth && (!style || (style.display !== 'none' && style.visibility !== 'hidden'));
  }

  function resolveTarget(preferVisible) {
    const step = CFG.steps[stepIndex] || CFG.steps[0];
    let fallback = null;

    for (const selector of step.selectors) {
      try {
        const el = document.querySelector(selector);
        if (!el) continue;
        if (!fallback) fallback = el;
        if (!preferVisible || isElementVisible(el)) return el;
      } catch (_) {}
    }

    return fallback;
  }

  function currentTarget() {
    return resolveTarget(false);
  }

  function scrollToCurrentTarget() {
    const target = currentTarget();
    if (!target) return;

    try {
      if (isCompactViewport()) {
        const rect = target.getBoundingClientRect();
        const top = window.pageYOffset + rect.top - Math.max(88, Math.round(window.innerHeight * 0.12));
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      } else {
        target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      }
    } catch (_) {
      try {
        target.scrollIntoView(true);
      } catch (_e) {}
    }

    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(scheduleSpotlight, isCompactViewport() ? 420 : 320);
  }

  function scheduleSpotlight() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(positionSpotlight);
  }

  function positionSpotlight() {
    const s = getShell();
    const light = s?.querySelector('.zc-robot-tour-spotlight');
    if (!s || !light || !isOpen()) {
      if (light) light.classList.remove('is-visible');
      return;
    }

    const target = resolveTarget(true) || currentTarget();
    if (!target) {
      light.classList.remove('is-visible');
      return;
    }

    const rect = target.getBoundingClientRect();
    if (!isElementVisible(target)) {
      light.classList.remove('is-visible');
      return;
    }

    positionStage(rect);

    const compact = isCompactViewport();
    const pad = compact ? 8 : (rect.height < 70 ? 10 : 12);
    const left = clamp(rect.left - pad, 8, window.innerWidth - 32);
    const top = clamp(rect.top - pad, 8, window.innerHeight - 32);
    const width = clamp(rect.width + pad * 2, 40, window.innerWidth - left - 8);
    const height = clamp(rect.height + pad * 2, 40, window.innerHeight - top - 8);

    light.style.left = Math.round(left) + 'px';
    light.style.top = Math.round(top) + 'px';
    light.style.width = Math.round(width) + 'px';
    light.style.height = Math.round(height) + 'px';
    light.style.borderRadius = (compact ? 14 : (rect.height < 74 ? 16 : 22)) + 'px';
    if (compact) {
      light.style.boxShadow = '0 0 0 9999px rgba(15,23,42,.36), 0 14px 28px rgba(0,139,103,.12), inset 0 0 0 1px rgba(255,255,255,.92)';
    } else {
      light.style.removeProperty('box-shadow');
    }
    light.classList.add('is-visible');
  }

  function positionStage(targetRect) {
    const s = getShell();
    const stage = s?.querySelector('.zc-robot-tour-stage');
    if (!stage || !targetRect || isCompactViewport()) return;

    const margin = 18;
    const gap = 24;
    const targetPad = 18;

    // Mede o bloco completo: robô + balão.
    const box = stage.getBoundingClientRect();
    const stageWidth = Math.min(box.width || 750, window.innerWidth - margin * 2);
    const stageHeight = Math.min(box.height || 420, window.innerHeight - margin * 2);

    const safeTarget = {
      left: targetRect.left - targetPad,
      top: targetRect.top - targetPad,
      right: targetRect.right + targetPad,
      bottom: targetRect.bottom + targetPad
    };

    const viewport = {
      left: margin,
      top: margin,
      right: window.innerWidth - margin,
      bottom: window.innerHeight - margin
    };

    function makeCandidate(side) {
      let left = 0;
      let top = 0;

      if (side === 'right') {
        left = safeTarget.right + gap;
        top = targetRect.top + targetRect.height / 2 - stageHeight / 2;
      } else if (side === 'left') {
        left = safeTarget.left - gap - stageWidth;
        top = targetRect.top + targetRect.height / 2 - stageHeight / 2;
      } else if (side === 'below') {
        left = targetRect.left + targetRect.width / 2 - stageWidth / 2;
        top = safeTarget.bottom + gap;
      } else {
        left = targetRect.left + targetRect.width / 2 - stageWidth / 2;
        top = safeTarget.top - gap - stageHeight;
      }

      left = clamp(left, viewport.left, viewport.right - stageWidth);
      top = clamp(top, viewport.top, viewport.bottom - stageHeight);

      const rect = {
        left,
        top,
        right: left + stageWidth,
        bottom: top + stageHeight
      };

      return {
        side,
        left,
        top,
        rect,
        overlap: overlapArea(rect, safeTarget),
        inView:
          rect.left >= viewport.left &&
          rect.top >= viewport.top &&
          rect.right <= viewport.right &&
          rect.bottom <= viewport.bottom
      };
    }

    // Regra principal:
    // - se o alvo for largo, nunca coloca o balão por cima dele; prefere acima/abaixo.
    // - se o alvo tiver espaço lateral, coloca ao lado sem invadir a área destacada.
    const targetIsWide = targetRect.width > window.innerWidth * 0.52;
    const targetCenterX = targetRect.left + targetRect.width / 2;
    const targetCenterY = targetRect.top + targetRect.height / 2;

    let order;
    if (targetIsWide) {
      order = targetCenterY < window.innerHeight * 0.52
        ? ['below', 'above', 'right', 'left']
        : ['above', 'below', 'right', 'left'];
    } else if (targetCenterX < window.innerWidth / 2) {
      order = ['right', 'below', 'above', 'left'];
    } else {
      order = ['left', 'below', 'above', 'right'];
    }

    const candidates = order.map(makeCandidate);

    // Primeiro tenta uma posição que não encoste no destaque.
    let chosen = candidates.find(function (c) {
      return c.inView && c.overlap === 0;
    });

    // Se não existir posição perfeita, escolhe a que menos cobre o destaque.
    if (!chosen) {
      chosen = candidates
        .slice()
        .sort(function (a, b) {
          if (a.overlap !== b.overlap) return a.overlap - b.overlap;
          const aDist = Math.abs((a.rect.left + a.rect.right) / 2 - targetCenterX) + Math.abs((a.rect.top + a.rect.bottom) / 2 - targetCenterY);
          const bDist = Math.abs((b.rect.left + b.rect.right) / 2 - targetCenterX) + Math.abs((b.rect.top + b.rect.bottom) / 2 - targetCenterY);
          return aDist - bDist;
        })[0];
    }

    stage.dataset.position = chosen.side;
    stage.style.setProperty('--zc-tour-stage-left', Math.round(chosen.left) + 'px');
    stage.style.setProperty('--zc-tour-stage-top', Math.round(chosen.top) + 'px');
  }

  function overlapArea(a, b) {
    const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return x * y;
  }

  function clamp(value, min, max) {
    if (max < min) return min;
    return Math.max(min, Math.min(max, value));
  }

  onReady(build);
})();
