// /frontend/js/atendimentos/ui/header-actions/forward.js
// Drawer de encaminhamento de mensagens
// - Lista conversas disponíveis
// - Pesquisa conversa destino
// - Encaminha texto/mídia selecionada
// - Fecha seleção após concluir

(function () {
  'use strict';

  const H = window.ZCHeaderActions;

  if (!H || !H.__coreReady) {
    console.warn('[header-actions][forward] core.js precisa ser carregado antes.');
    return;
  }

  if (H.__forwardReady) return;
  H.__forwardReady = true;

  const REQUIRED = [
    '$',
    '$all',
    'escapeHtml',
    'normalize',
    'sleep',
    'toast',

    'getSelectedConversationKey',
    'getConversationPools',
    'conversationRefOf',
    'sameConversation',
    'getConversationByRef',
    'numberForApi',
    'getInstPayload',

    'collectForwardItemsFromSelection',
    'syncSelectBar',

    'fetchBlobFromUrl',
    'sendTextToConversation',
    'sendBlobToConversation',
  ];

  if (!H.require(REQUIRED, 'forward')) {
    return;
  }

  const {
    $,
    $all,
    escapeHtml,
    normalize,
    sleep,
    toast,

    getSelectedConversationKey,
    getConversationPools,
    conversationRefOf,
    sameConversation,
    getConversationByRef,
    numberForApi,
    getInstPayload,

    collectForwardItemsFromSelection,
    syncSelectBar,

    fetchBlobFromUrl,
    sendTextToConversation,
    sendBlobToConversation,
  } = H;

  function ensureForwardDrawer() {
    if (document.getElementById('zc-forward-backdrop')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'zc-forward-backdrop';
    backdrop.className = 'zc-forward-backdrop';

    const drawer = document.createElement('aside');
    drawer.id = 'zc-forward-drawer';
    drawer.className = 'zc-forward-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Encaminhar mensagens');

    drawer.innerHTML = `
      <div class="zc-forward-head">
        <button class="zc-forward-close" type="button" aria-label="Fechar">
          <i class="fa-solid fa-arrow-left"></i>
        </button>

        <div class="zc-forward-title-wrap">
          <div class="zc-forward-title">
            Encaminhar para
          </div>

          <div class="zc-forward-sub" id="zc-forward-sub">
            0 mensagens
          </div>
        </div>
      </div>

      <div class="zc-forward-toolbar">
        <div class="zc-forward-input-wrap">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>

          <input
            id="zc-forward-input"
            class="zc-forward-input"
            type="text"
            placeholder="Pesquisar conversa"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
      </div>

      <div class="zc-forward-body">
        <div id="zc-forward-list" class="zc-forward-list"></div>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    $('.zc-forward-close', drawer)?.addEventListener('click', closeForwardDrawer);

    $('#zc-forward-input', drawer)?.addEventListener('input', () => {
      renderForwardList();
    });

    $('#zc-forward-input', drawer)?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeForwardDrawer();
      }
    });

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        closeForwardDrawer();
      }
    });
  }

  function closeForwardDrawer() {
    H.state.forwardOpen = false;

    $('#zc-forward-backdrop')?.classList.remove('is-open');
    $('#zc-forward-drawer')?.classList.remove('is-open');
  }

  function openForwardDrawer() {
    ensureForwardDrawer();

    const count = H.state.selectedMsgIds.size;
    const sub = $('#zc-forward-sub');

    if (sub) {
      sub.textContent = count === 1
        ? '1 mensagem'
        : `${count} mensagens`;
    }

    H.state.forwardOpen = true;

    $('#zc-forward-backdrop')?.classList.add('is-open');
    $('#zc-forward-drawer')?.classList.add('is-open');

    const input = $('#zc-forward-input');

    if (input) {
      input.value = '';
    }

    renderForwardList();

    setTimeout(() => {
      input?.focus();
    }, 40);
  }

  function getConversationDisplayName(item) {
    return String(
      item?.nome_whatsapp ||
      item?.nome ||
      item?.title ||
      item?.subject ||
      item?.telefone_fmt ||
      item?.telefone ||
      item?.numero ||
      ''
    ).trim();
  }

  function getConversationPhone(item) {
    return String(
      item?.telefone_fmt ||
      item?.telefone ||
      item?.numero ||
      item?.number ||
      ''
    ).trim();
  }

  function getConversationSubtitle(item, phone = '') {
    return String(
      item?.ultima_mensagem ||
      item?.last_message ||
      item?.last ||
      item?.mensagem ||
      phone ||
      ''
    ).trim();
  }

  function getConversationCandidates() {
    const currentKey = getSelectedConversationKey();
    const pools = getConversationPools();
    const map = new Map();

    pools.forEach((item) => {
      const ref = conversationRefOf(item, item);

      if (!ref?.key || !ref.entityId) return;

      const name = getConversationDisplayName(item);
      const phone = getConversationPhone(item);
      const subtitle = getConversationSubtitle(item, phone);

      map.set(ref.key, {
        refKey: ref.key,
        kind: ref.kind,
        entityId: ref.entityId,
        instId: ref.instId,
        raw: item,
        name: name || phone || 'Conversa',
        phone,
        subtitle,
        isCurrent: currentKey ? sameConversation(ref.key, currentKey) : false,
      });
    });

    return Array.from(map.values()).sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;

      return a.name.localeCompare(b.name, 'pt-BR', {
        sensitivity: 'base',
      });
    });
  }

  function renderForwardList() {
    const list = $('#zc-forward-list');
    const input = $('#zc-forward-input');
    const query = normalize(input?.value || '');

    if (!list) return;

    const items = getConversationCandidates().filter((item) => {
      if (!query) return true;

      return (
        normalize(item.name).includes(query) ||
        normalize(item.phone).includes(query) ||
        normalize(item.subtitle).includes(query)
      );
    });

    if (!items.length) {
      list.innerHTML = `
        <div class="zc-forward-empty">
          Nenhuma conversa encontrada.
        </div>
      `;
      return;
    }

    list.innerHTML = items.map((item) => `
      <button
        type="button"
        class="zc-forward-item${item.isCurrent ? ' is-current' : ''}"
        data-conversation-key="${escapeHtml(item.refKey)}"
      >
        <span class="zc-forward-avatar">
          <i class="fa-regular fa-user"></i>
        </span>

        <span class="zc-forward-main">
          <span class="zc-forward-name">
            ${escapeHtml(item.name)}
          </span>

          <span class="zc-forward-subtitle">
            ${escapeHtml(item.subtitle || item.phone || '')}
          </span>
        </span>

        ${
          item.isCurrent
            ? `<span class="zc-forward-badge">atual</span>`
            : ''
        }
      </button>
    `).join('');

    $all('.zc-forward-item', list).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const refKey = btn.getAttribute('data-conversation-key');

        if (!refKey) return;

        await handleForwardToConversation(refKey, btn);
      });
    });
  }

  function setForwardButtonsDisabled(disabled) {
    const list = $('#zc-forward-list');
    const buttons = $all('.zc-forward-item', list || document);

    buttons.forEach((btn) => {
      btn.disabled = !!disabled;
    });

    return buttons;
  }

  async function handleForwardToConversation(targetConversationKey, clickedBtn) {
    if (H.state.forwarding) return;

    const items = collectForwardItemsFromSelection();

    if (!items.length) {
      toast({
        title: 'Nada para encaminhar',
        msg: 'As mensagens selecionadas não têm conteúdo encaminhável.',
        type: 'error',
      });
      return;
    }

    const target = getConversationByRef(targetConversationKey);

    if (!target) {
      toast({
        title: 'Destino inválido',
        type: 'error',
      });
      return;
    }

    const dest = numberForApi(targetConversationKey);
    const inst = getInstPayload(targetConversationKey);

    if (!dest) {
      toast({
        title: 'Destino sem telefone válido',
        type: 'error',
      });
      return;
    }

    if (!inst.instancia_id && !inst.instance) {
      toast({
        title: 'A conversa destino não tem instância definida',
        type: 'error',
      });
      return;
    }

    H.state.forwarding = true;
    syncSelectBar();

    const buttons = setForwardButtonsDisabled(true);

    if (clickedBtn) {
      clickedBtn.classList.add('is-loading');
    }

    toast({
      title: 'Encaminhando.',
      msg: `${items.length} item(ns)`,
      type: 'ok',
      timeout: 1600,
    });

    try {
      for (const item of items) {
        if (item.type === 'text') {
          await sendTextToConversation(targetConversationKey, item.text);
          await sleep(120);
          continue;
        }

        if (item.type === 'media') {
          const blob = await fetchBlobFromUrl(item.url);

          await sendBlobToConversation(targetConversationKey, blob, {
            fileName: item.fileName,
            mimeType: item.mimeType || blob.type,
            mediaType: item.mediaType,
            caption: item.caption,
          });

          await sleep(120);
          continue;
        }
      }

      toast({
        title: 'Encaminhado',
        msg: items.length === 1
          ? '1 item encaminhado.'
          : `${items.length} itens encaminhados.`,
        type: 'ok',
      });

      closeForwardDrawer();

      if (typeof H.stopSelectionMode === 'function') {
        H.stopSelectionMode();
      }
    } catch (err) {
      console.error('[header-actions][forward] erro', err);

      toast({
        title: 'Erro ao encaminhar',
        msg: err?.message || 'Falha ao encaminhar mensagens.',
        type: 'error',
        timeout: 3600,
      });
    } finally {
      H.state.forwarding = false;
      syncSelectBar();

      buttons.forEach((btn) => {
        btn.disabled = false;
      });

      clickedBtn?.classList.remove('is-loading');
    }
  }

  H.extend({
    ensureForwardDrawer,
    closeForwardDrawer,
    openForwardDrawer,

    getConversationDisplayName,
    getConversationPhone,
    getConversationSubtitle,
    getConversationCandidates,
    renderForwardList,

    setForwardButtonsDisabled,
    handleForwardToConversation,
  });

  console.log('[header-actions] forward carregado');
})();