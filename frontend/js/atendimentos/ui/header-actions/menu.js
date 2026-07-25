// /frontend/js/atendimentos/ui/header-actions/menu.js
// Menu dos 3 pontinhos do header do chat
// - IA
// - Notas do cliente
// - Transferir departamento
// - Ações mobile: aceitar/liberar/transferir atendente/trocar WhatsApp
// - Dados do contato
// - Pesquisar
// - Selecionar mensagens
// - Ações futuras: silenciar, favoritos, bloquear, limpar, apagar etc.

(function () {
  'use strict';

  const H = window.ZCHeaderActions;

  if (!H || !H.__coreReady) {
    console.warn('[header-actions][menu] core.js precisa ser carregado antes.');
    return;
  }

  if (H.__menuReady) return;
  H.__menuReady = true;

  const REQUIRED = [
    '$',
    '$all',
    'escapeHtml',
    'toast',
    'isMobileHeader',
    'isUsableButton',
    'resolveCurrentClienteId',
    'getCurrentInstanceText',
  ];

  if (!H.require(REQUIRED, 'menu')) {
    return;
  }

  const {
    $,
    $all,
    escapeHtml,
    toast,
    isMobileHeader,
    isUsableButton,
    resolveCurrentClienteId,
    getCurrentInstanceText,
  } = H;

  let menuMetaRefreshSerial = 0;

  function clickExistingButton(selector, fallbackTitle = 'Ação não encontrada') {
    const btn = $(selector);

    if (!btn) {
      toast({
        title: fallbackTitle,
        msg: 'Não encontrei o botão original dessa ação.',
        type: 'error',
      });
      return false;
    }

    closeMenu();

    setTimeout(() => {
      try {
        btn.click();
      } catch (err) {
        console.error('[header-actions][menu] erro ao clicar botão original:', selector, err);
      }
    }, 40);

    return true;
  }

  function openInstanceSelectorFromMenu() {
    closeMenu();

    /*
      No mobile o aside fica escondido quando body.is-chat-open.
      Para trocar WhatsApp, volta para a lista e abre o seletor da instância.
    */
    if (isMobileHeader()) {
      document.body.classList.remove('is-chat-open');
    }

    setTimeout(() => {
      const trigger = $('#zc-inst-trigger');

      if (trigger) {
        try {
          trigger.click();
        } catch (err) {
          console.warn('[header-actions][menu] erro ao abrir seletor de instância:', err);
        }
      } else {
        toast({
          title: 'Seletor não encontrado',
          msg: 'Não encontrei o botão de trocar WhatsApp.',
          type: 'error',
        });
      }
    }, 160);
  }

  function openNotesFromMenu() {
    /*
      O botão original de notas é #btn-sobre.
      Ele fica escondido visualmente, mas o click programático continua abrindo o drawer.
    */
    if (clickExistingButton('#btn-sobre', 'Notas não encontrada')) return;

    try {
      if (typeof window.abrirNotasClienteAtual === 'function') {
        closeMenu();
        window.abrirNotasClienteAtual();
        return;
      }
    } catch (err) {
      console.warn('[header-actions][menu] abrirNotasClienteAtual falhou:', err);
    }

    toast({
      title: 'Notas não disponível',
      msg: 'Não encontrei a função original para abrir as notas.',
      type: 'error',
    });
  }

  function openIaFromMenu() {
    /*
      O botão original da IA é #btn-ia, criado pelo ia.js.
      Ele fica escondido visualmente, mas o click programático continua abrindo o modal.
    */
    if (clickExistingButton('#btn-ia', 'IA não encontrada')) return;

    try {
      if (typeof window.abrirIaClienteAtual === 'function') {
        closeMenu();
        window.abrirIaClienteAtual();
        return;
      }
    } catch (err) {
      console.warn('[header-actions][menu] abrirIaClienteAtual falhou:', err);
    }

    toast({
      title: 'IA não disponível',
      msg: 'Não encontrei a função original para abrir a IA.',
      type: 'error',
    });
  }

  function openNotesOrIaFromMenu() {
    /*
      Compatibilidade com a versão antiga que tinha um item só:
      "IA / Notas do cliente".
      Nesta versão nova, mantemos a função, mas ela abre Notas.
    */
    openNotesFromMenu();
  }

  function transferirDepartamentoFromMenu() {
    clickExistingButton(
      '#btnTransferirDepartamento',
      'Transferência não encontrada'
    );
  }

  function openSearchFromMenu() {
    if (typeof H.openSearchDrawer === 'function') {
      H.openSearchDrawer();
      return;
    }

    toast({
      title: 'Pesquisa indisponível',
      msg: 'O módulo search.js ainda não foi carregado.',
      type: 'error',
    });
  }

  function startSelectionFromMenu() {
    if (typeof H.startSelectionMode === 'function') {
      H.startSelectionMode();
      return;
    }

    toast({
      title: 'Seleção indisponível',
      msg: 'O módulo select-mode.js ainda não foi carregado.',
      type: 'error',
    });
  }

  function notImplemented() {
    toast({
      title: 'Ainda não implementado',
      msg: 'Essa ação ainda não foi ligada no backend.',
      type: 'error',
    });
  }

  function openContactData() {
    const clienteId = resolveCurrentClienteId();

    if (!clienteId) {
      toast({
        title: 'Selecione uma conversa',
        type: 'error',
      });
      return;
    }

    if (typeof window.abrirPerfilAtual === 'function') {
      window.abrirPerfilAtual({
        cliente_id: clienteId,
      });
      return;
    }

    toast({
      title: 'Função abrirPerfilAtual não encontrada',
      type: 'error',
    });
  }

  function closeCurrentChat() {
    if (typeof window.fecharChatAtual === 'function') {
      window.fecharChatAtual();
      return;
    }

    toast({
      title: 'Ainda não implementado',
      msg: 'Função fecharChatAtual não encontrada.',
      type: 'error',
    });
  }

  function trueFlag(value) {
    if (value === true) return true;
    if (value === 1) return true;

    const s = String(value ?? '').trim().toLowerCase();
    return ['1', 'true', 'sim', 'yes', 'on'].includes(s);
  }

  function getCurrentConversationMetaForMenu() {
    const keys = [];

    try {
      const selectedKey = H.getSelectedConversationKey?.();
      if (selectedKey) keys.push(String(selectedKey));
    } catch {}

    try {
      const ref = H.resolveCurrentConversationRef?.();
      if (ref?.key) keys.push(String(ref.key));
    } catch {}

    try {
      const conv = window.state?.clienteSel || window.clienteSel || window.__zcCurrentConversation || null;
      const convKey = conv?.conversation_key || conv?.conversation_id || conv?.id || null;
      if (convKey) keys.push(String(convKey));

      const ref = H.conversationRefOf?.(conv, conv);
      if (ref?.key) keys.push(String(ref.key));
    } catch {}

    const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));

    for (const key of uniqueKeys) {
      try {
        if (typeof window.getConversationMeta === 'function') {
          const meta = window.getConversationMeta(key);
          if (meta) return meta;
        }
      } catch {}

      try {
        const meta = window.__zcConversationMetaCache?.[key];
        if (meta) return meta;
      } catch {}
    }

    return null;
  }

  function readMetaValue(meta, keys) {
    const sources = [meta, meta?.raw].filter(Boolean);

    for (const source of sources) {
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          return source[key];
        }
      }
    }

    return undefined;
  }

  function metaFlag(meta, keys) {
    const value = readMetaValue(meta, keys);
    return value === undefined ? undefined : trueFlag(value);
  }

  function currentConversationKeyForMenu() {
    try {
      const selectedKey = H.getSelectedConversationKey?.();
      if (selectedKey) return String(selectedKey);
    } catch {}

    try {
      const ref = H.resolveCurrentConversationRef?.();
      if (ref?.key) return String(ref.key);
    } catch {}

    return '';
  }

  async function refreshCurrentConversationMetaForMenu() {
    const key = currentConversationKeyForMenu();
    if (!key) return null;

    try {
      if (typeof window.refreshConversationMeta === 'function') {
        return await window.refreshConversationMeta(key);
      }
    } catch (err) {
      console.warn('[header-actions][menu] refreshConversationMeta falhou:', err);
    }

    try {
      if (typeof window.zcRefreshResponsavelButtons === 'function') {
        await window.zcRefreshResponsavelButtons({ force: true });
        return getCurrentConversationMetaForMenu();
      }
    } catch (err) {
      console.warn('[header-actions][menu] refresh de atendimento falhou:', err);
    }

    return getCurrentConversationMetaForMenu();
  }

  function metaRequiresAttendanceFlow(meta) {
    if (!meta) return false;

    return Boolean(
      metaFlag(meta, ['exigir_aceite']) ||
      metaFlag(meta, ['aceite_obrigatorio']) ||
      metaFlag(meta, ['fila_exigir_aceite']) ||
      metaFlag(meta, ['aguardando_aceite']) ||
      metaFlag(meta, ['departamento_claim']) ||
      String(readMetaValue(meta, ['claim_mode']) || '').trim().toLowerCase() === 'departamento'
    );
  }

  function metaIsDepartmentChatbotFlow(meta) {
    if (!meta) return false;

    return Boolean(
      metaFlag(meta, ['departamento_claim']) ||
      String(readMetaValue(meta, ['claim_mode']) || '').trim().toLowerCase() === 'departamento'
    );
  }

  function canCloseAttendanceFromMenu() {
    const meta = getCurrentConversationMetaForMenu();

    if (!metaRequiresAttendanceFlow(meta)) {
      return false;
    }

    return Boolean(
      metaFlag(meta, ['pode_liberar', 'can_release']) ||
      metaFlag(meta, ['aceita_por_mim', 'accepted_by_me'])
    );
  }

  function canTransferAttendanceFromMenu() {
    const meta = getCurrentConversationMetaForMenu();

    // Esta ação é exclusiva do menu de departamentos do chatbot. Conversa
    // comum, departamento apenas cadastral e fila sem chatbot não exibem.
    if (!metaIsDepartmentChatbotFlow(meta)) {
      return false;
    }

    // O backend atual manda uma permissão própria para departamento. Quando a
    // flag existe, ela é a verdade (inclusive quando for false).
    const explicitDepartmentPermission = metaFlag(meta, [
      'pode_transferir_departamento',
      'can_transfer_department',
    ]);

    if (explicitDepartmentPermission !== undefined) {
      return explicitDepartmentPermission;
    }

    // Compatibilidade com metadados antigos: permite trocar de departamento
    // enquanto aguarda Atender e também depois que foi assumido por mim.
    return Boolean(
      metaFlag(meta, ['pode_aceitar', 'can_accept']) ||
      metaFlag(meta, ['aceita_por_mim', 'accepted_by_me']) ||
      metaFlag(meta, ['assumido_por_mim', 'claimed_by_me']) ||
      metaFlag(meta, ['admin_intervening'])
    );
  }

  function menuItems() {
    const items = [];

    /*
      Menu limpo/profissional para atendimento.
      Não trazemos opções "copiadas" do WhatsApp que ainda não têm função real
      ou que poluem a operação do atendente.
    */
    items.push(
      {
        label: 'IA',
        icon: 'fa-solid fa-wand-magic-sparkles',
        action() {
          openIaFromMenu();
        },
      },
      {
        label: 'Notas do cliente',
        icon: 'fa-regular fa-note-sticky',
        action() {
          openNotesFromMenu();
        },
      }
    );

    if (canTransferAttendanceFromMenu()) {
      items.push({
        label: 'Transferir departamento',
        icon: 'fa-solid fa-arrow-right-arrow-left',
        action() {
          transferirDepartamentoFromMenu();
        },
      });
    }

    items.push({
      divider: true,
    });

    /*
      No mobile, também colocamos aqui ações que ficam apertadas no topo.
      No desktop elas continuam no fluxo normal quando existirem.
    */
    if (isMobileHeader()) {
      const btnAccept = $('#btnAceitarConversa');
      const btnRelease = $('#btnLiberarConversa');
      const btnTransfer = $('#btnTransferirColaborador');

      if (isUsableButton(btnAccept)) {
        items.push({
          label: 'Atender conversa',
          icon: 'fa-solid fa-check',
          action() {
            clickExistingButton('#btnAceitarConversa', 'Atendimento não encontrado');
          },
        });
      }

      if (isUsableButton(btnRelease)) {
        items.push({
          label: 'Liberar atendimento',
          icon: 'fa-solid fa-unlock',
          action() {
            clickExistingButton('#btnLiberarConversa', 'Liberação não encontrada');
          },
        });
      }

      if (isUsableButton(btnTransfer) && canTransferAttendanceFromMenu()) {
        items.push({
          label: 'Transferir atendente',
          icon: 'fa-solid fa-user-plus',
          action() {
            clickExistingButton('#btnTransferirColaborador', 'Transferência não encontrada');
          },
        });
      }

      items.push(
        {
          divider: true,
        },
        {
          label: getCurrentInstanceText(),
          icon: 'fa-brands fa-whatsapp',
          disabled: true,
          action() {},
        },
        {
          label: 'Trocar WhatsApp',
          icon: 'fa-solid fa-repeat',
          action() {
            openInstanceSelectorFromMenu();
          },
        },
        {
          divider: true,
        }
      );
    }

    items.push(
      {
        label: 'Dados do contato',
        icon: 'fa-regular fa-circle-user',
        action() {
          openContactData();
        },
      },
      {
        label: 'Pesquisar na conversa',
        icon: 'fa-solid fa-magnifying-glass',
        action() {
          openSearchFromMenu();
        },
      },
      {
        label: 'Selecionar mensagens',
        icon: 'fa-regular fa-square-check',
        action() {
          startSelectionFromMenu();
        },
      },
      {
        divider: true,
      }
    );

    if (canCloseAttendanceFromMenu()) {
      items.push({
        label: 'Encerrar atendimento',
        icon: 'fa-regular fa-circle-xmark',
        action() {
          closeCurrentChat();
        },
      });
    }

    return items;
  }

  function ensureMenu() {
    let menu = document.getElementById('zc-chat-more-menu');

    if (menu) {
      return menu;
    }

    menu = document.createElement('div');
    menu.id = 'zc-chat-more-menu';
    menu.className = 'zc-chat-more-menu';
    menu.hidden = true;

    document.body.appendChild(menu);

    window.addEventListener('resize', positionMenu, {
      passive: true,
    });

    window.addEventListener('scroll', positionMenu, {
      passive: true,
    });

    return menu;
  }

  function renderMenu() {
    const menu = ensureMenu();

    if (!menu) return null;

    const defsAll = menuItems();

    menu.innerHTML = defsAll.map((item) => {
      if (item.divider) {
        return `<div class="zc-chat-menu-divider"></div>`;
      }

      return `
        <button
          type="button"
          class="zc-chat-menu-item${item.danger ? ' is-danger' : ''}${item.disabled ? ' is-disabled' : ''}"
          data-label="${escapeHtml(item.label)}"
          ${item.disabled ? 'disabled aria-disabled="true"' : ''}
        >
          <span class="zc-chat-menu-icon">
            <i class="${escapeHtml(item.icon)}"></i>
          </span>

          <span class="zc-chat-menu-text">
            ${escapeHtml(item.label)}
          </span>
        </button>
      `;
    }).join('');

    const allItems = $all('.zc-chat-menu-item', menu);
    const defs = defsAll.filter((x) => !x.divider);

    allItems.forEach((btn, idx) => {
      const def = defs[idx];

      if (!def || def.disabled) return;

      btn.addEventListener('click', () => {
        closeMenu();
        def.action?.();
      });
    });

    return menu;
  }

  function positionMenu() {
    const menu = document.getElementById('zc-chat-more-menu');
    const btn = document.getElementById('btn-chat-more');

    if (!menu || !btn || menu.hidden) return;

    const rect = btn.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 24);

    menu.style.width = `${width}px`;

    requestAnimationFrame(() => {
      const mw = menu.offsetWidth || width;

      let left = rect.right - mw;

      left = Math.max(
        12,
        Math.min(left, window.innerWidth - mw - 12)
      );

      menu.style.left = `${left}px`;
      menu.style.top = `${rect.bottom + 8}px`;
    });
  }

  function openMenu() {
    const menu = renderMenu();

    if (!menu) return;

    H.state.menuOpen = true;
    menu.hidden = false;
    positionMenu();

    // O menu abre imediatamente com o cache atual e, em seguida, força /meta.
    // Assim ações do chatbot aparecem sem F5 e sem depender do tempo do cache.
    const serial = ++menuMetaRefreshSerial;
    Promise.resolve(refreshCurrentConversationMetaForMenu())
      .then(() => {
        if (!H.state.menuOpen || serial !== menuMetaRefreshSerial) return;
        renderMenu();
        positionMenu();
      })
      .catch(() => {});
  }

  function closeMenu() {
    const menu = document.getElementById('zc-chat-more-menu');

    H.state.menuOpen = false;
    menuMetaRefreshSerial += 1;

    if (!menu) return;

    menu.hidden = true;
  }

  function toggleMenu() {
    if (H.state.menuOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  H.extend({
    clickExistingButton,

    openInstanceSelectorFromMenu,
    openNotesFromMenu,
    openIaFromMenu,
    openNotesOrIaFromMenu,
    transferirDepartamentoFromMenu,

    refreshCurrentConversationMetaForMenu,
    canTransferAttendanceFromMenu,
    menuItems,
    ensureMenu,
    renderMenu,
    positionMenu,
    openMenu,
    closeMenu,
    toggleMenu,
  });

  console.log('[header-actions] menu carregado: zc-menu-v11-chatbot-department-only');
})();