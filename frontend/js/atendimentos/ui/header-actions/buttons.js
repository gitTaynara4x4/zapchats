// /frontend/js/atendimentos/ui/header-actions/buttons.js
// Botões do header do chat
// - Lupa
// - Calendário / Ir para data
// - 3 pontinhos
// - Esconde visualmente os atalhos antigos: IA, Notas e Transferir departamento

(function () {
  'use strict';

  const H = window.ZCHeaderActions;

  if (!H || !H.__coreReady) {
    console.warn('[header-actions][buttons] core.js precisa ser carregado antes.');
    return;
  }

  if (H.__buttonsReady) return;
  H.__buttonsReady = true;

  const REQUIRED = [
    '$',
    'headerEl',
    'toast',
    'hasOpenChat',
    'injectStyle',
  ];

  if (!H.require(REQUIRED, 'buttons')) {
    return;
  }

  const {
    headerEl,
    toast,
    hasOpenChat,
    injectStyle,
  } = H;

  /*
    Esses botões precisam continuar existindo no DOM porque os módulos originais
    escutam clique neles. Aqui a gente só tira do topo visualmente e chama pelo
    menu dos 3 pontinhos.
  */
  function ensureHeaderShortcutStyle() {
    injectStyle('zc-header-shortcuts-hidden-style', `
      #chat-header #btn-sobre,
      #chat-header #btnTransferirDepartamento,
      #chat-header #btn-ia{
        display:none !important;
      }
    `);
  }

  function ensureActionsHost() {
    const hdr = headerEl();
    if (!hdr) return null;

    let host = hdr.querySelector('.zc-chat-actions');

    if (host) {
      return host;
    }

    host = document.createElement('div');
    host.className = 'zc-chat-actions';
    hdr.appendChild(host);

    return host;
  }

  function iconBtn({
    id,
    title,
    iconHtml,
    onClick,
  }) {
    const btn = document.createElement('button');

    btn.type = 'button';
    btn.id = id;
    btn.className = 'zc-chat-icon-btn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = iconHtml;

    if (typeof onClick === 'function') {
      btn.addEventListener('click', onClick);
    }

    return btn;
  }

  function searchIcon() {
    return `<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>`;
  }

  function calendarIcon() {
    return `<i class="fa-regular fa-calendar-days" aria-hidden="true"></i>`;
  }

  function dotsIcon() {
    return `<i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i>`;
  }

  function callIfExists(fnName, fallbackMsg = '') {
    const fn = H[fnName];

    if (typeof fn === 'function') {
      return fn();
    }

    console.warn(`[header-actions][buttons] função ainda não carregada: ${fnName}`);

    if (fallbackMsg) {
      toast({
        title: 'Ação indisponível',
        msg: fallbackMsg,
        type: 'error',
      });
    }

    return null;
  }

  function closeMenuSafe() {
    if (typeof H.closeMenu === 'function') {
      H.closeMenu();
    }
  }

  function ensurePanelsIfAvailable() {
    /*
      Quando todos os módulos já estiverem carregados, isso mantém o mesmo
      comportamento do header-actions antigo: cria os drawers/modais/menus
      junto com os botões.
    */

    if (typeof H.ensureSearchDrawer === 'function') {
      H.ensureSearchDrawer();
    }

    if (typeof H.ensureDateJumpDialog === 'function') {
      H.ensureDateJumpDialog();
    }

    if (typeof H.ensureMenu === 'function') {
      H.ensureMenu();
    }

    if (typeof H.ensureSelectBar === 'function') {
      H.ensureSelectBar();
    }

    if (typeof H.ensureForwardDrawer === 'function') {
      H.ensureForwardDrawer();
    }
  }

  function ensureButtons() {
    ensureHeaderShortcutStyle();

    const host = ensureActionsHost();
    if (!host) return;

    if (!document.getElementById('btn-chat-search')) {
      const btnSearch = iconBtn({
        id: 'btn-chat-search',
        title: 'Pesquisar',
        iconHtml: searchIcon(),
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();

          if (!hasOpenChat()) {
            toast({
              title: 'Selecione uma conversa',
              type: 'error',
            });
            return;
          }

          callIfExists(
            'openSearchDrawer',
            'O módulo de pesquisa ainda não foi carregado.'
          );

          closeMenuSafe();
        },
      });

      host.appendChild(btnSearch);
    }

    if (!document.getElementById('btn-chat-date-jump')) {
      const btnDateJump = iconBtn({
        id: 'btn-chat-date-jump',
        title: 'Ir para uma data',
        iconHtml: calendarIcon(),
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();

          if (!hasOpenChat()) {
            toast({
              title: 'Selecione uma conversa',
              type: 'error',
            });
            return;
          }

          callIfExists(
            'openDateJumpDialog',
            'O módulo de agenda ainda não foi carregado.'
          );

          closeMenuSafe();
        },
      });

      host.appendChild(btnDateJump);
    }

    if (!document.getElementById('btn-chat-more')) {
      const btnMore = iconBtn({
        id: 'btn-chat-more',
        title: 'Mais opções',
        iconHtml: dotsIcon(),
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();

          if (!hasOpenChat()) {
            toast({
              title: 'Selecione uma conversa',
              type: 'error',
            });
            return;
          }

          callIfExists(
            'toggleMenu',
            'O menu de opções ainda não foi carregado.'
          );
        },
      });

      host.appendChild(btnMore);
    }

    ensurePanelsIfAvailable();
  }

  H.extend({
    ensureHeaderShortcutStyle,
    ensureActionsHost,
    iconBtn,
    searchIcon,
    calendarIcon,
    dotsIcon,
    ensureButtons,
  });

  console.log('[header-actions] buttons carregado');
})();