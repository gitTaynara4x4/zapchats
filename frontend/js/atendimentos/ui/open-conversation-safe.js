// /frontend/js/atendimentos/ui/open-conversation-safe.js
// Etapa 9.11
// Clique leve e seguro na lista de conversas.
// Motivo: no modo essencial, a RAM caiu, mas alguns listeners antigos podem não abrir
// a conversa. Este módulo não usa MutationObserver, setInterval nem varredura pesada.

(function () {
  'use strict';

  const VERSION = 'zc-open-conversation-safe-v1';
  if (window.__ZC_OPEN_CONVERSATION_SAFE__ === VERSION) return;
  window.__ZC_OPEN_CONVERSATION_SAFE__ = VERSION;

  let openingKey = '';
  let openingAt = 0;

  function clean(v) {
    return String(v ?? '').trim();
  }

  function valid(v) {
    const s = clean(v);
    if (!s) return '';
    const low = s.toLowerCase();
    if (['null', 'undefined', 'nan', '0', 'all', 'todos', '*', '-'].includes(low)) return '';
    return s;
  }

  function onlyDigits(v) {
    return clean(v).replace(/\D+/g, '');
  }

  function isOpenBlockTarget(target) {
    try {
      return !!target.closest(
        '#lista-load-more, .load-more-btn, button, a, input, textarea, select, ' +
        '[data-no-open], [data-action], .chat-menu, .ctx-menu, .dropdown, .dropdown-menu'
      );
    } catch {
      return false;
    }
  }

  function getItemFromEvent(ev) {
    try {
      const t = ev?.target;
      if (!t || !t.closest) return null;
      return t.closest('#lista-clientes .chat-item.cliente-item, #lista-clientes .cliente-item, #lista-clientes .chat-item');
    } catch {
      return null;
    }
  }

  function buildPayloadFromItem(item) {
    const ds = item?.dataset || {};

    const conversationKey =
      valid(ds.conversationKey) ||
      valid(ds.conversationId) ||
      valid(ds.convKey) ||
      valid(ds.key) ||
      valid(ds.id) ||
      '';

    const entityId =
      onlyDigits(ds.entityId) ||
      onlyDigits(ds.clienteId) ||
      onlyDigits(ds.backendClienteId) ||
      onlyDigits(ds.apiClienteId) ||
      onlyDigits(ds.grupoId) ||
      '';

    const kind =
      clean(ds.kind || ds.conversationKind || ds.tipoConversa || '') ||
      (ds.isGroup === '1' || ds.isGroup === 'true' || ds.grupo === '1' || ds.grupo === 'true' ? 'g' : 'c');

    const instanciaId =
      valid(ds.instanciaId) ||
      valid(ds.instancia) ||
      valid(ds.instanceId) ||
      valid(ds.instanceName) ||
      valid(ds.instance) ||
      valid(window.INSTANCIA_ATIVA) ||
      valid(window.state?.instanciaAtiva) ||
      '';

    let finalKey = conversationKey;
    if (!/^([cg]):\d+:[^:]+$/i.test(finalKey) && entityId && instanciaId) {
      finalKey = `${String(kind).toLowerCase() === 'g' ? 'g' : 'c'}:${entityId}:${instanciaId}`;
    }

    const nameText = clean(item.querySelector?.('.chat-name, .name, [data-role="name"]')?.textContent || '');
    const previewText = clean(item.querySelector?.('.preview-text, .chat-last')?.textContent || '');

    return {
      id: finalKey || conversationKey || entityId,
      conversation_key: finalKey || conversationKey,
      conversation_id: finalKey || conversationKey,
      conv_key: finalKey || conversationKey,
      kind: String(kind || 'c').toLowerCase() === 'g' ? 'g' : 'c',
      entity_id: entityId,
      cliente_id: String(kind || 'c').toLowerCase() === 'g' ? undefined : entityId,
      grupo_id: String(kind || 'c').toLowerCase() === 'g' ? entityId : undefined,
      instancia_id: instanciaId,
      nome: clean(ds.nome) || nameText,
      nome_whatsapp: clean(ds.nome) || nameText,
      push_name: clean(ds.nome) || nameText,
      telefone: clean(ds.telefone),
      avatar_url: window.ZC_DISABLE_REMOTE_AVATARS === true ? '' : clean(ds.avatarUrl),
      preview: previewText,
    };
  }

  function markVisualActive(item) {
    try {
      document.querySelectorAll('#lista-clientes .cliente-item.active, #lista-clientes .cliente-item.is-active, #lista-clientes .cliente-item.chat-active')
        .forEach((el) => {
          if (el === item) return;
          el.classList.remove('active', 'is-active', 'chat-active');
          el.removeAttribute('aria-current');
        });

      item.classList.add('active', 'is-active', 'chat-active');
      item.setAttribute('aria-current', 'true');
    } catch {}
  }

  function waitForSelecionarClienteObj() {
    if (typeof window.selecionarClienteObj === 'function') {
      return Promise.resolve(window.selecionarClienteObj);
    }

    return new Promise((resolve, reject) => {
      let done = false;
      let tries = 0;

      function finish(fn) {
        if (done) return;
        done = true;
        window.removeEventListener('zc:atendimentos-runtime-ready', onReady);
        window.removeEventListener('zc:atendimentos-ready', onReady);
        resolve(fn);
      }

      function onReady() {
        if (typeof window.selecionarClienteObj === 'function') {
          finish(window.selecionarClienteObj);
        }
      }

      function poll() {
        if (typeof window.selecionarClienteObj === 'function') {
          finish(window.selecionarClienteObj);
          return;
        }

        tries += 1;
        if (tries >= 40) {
          if (!done) {
            done = true;
            window.removeEventListener('zc:atendimentos-runtime-ready', onReady);
            window.removeEventListener('zc:atendimentos-ready', onReady);
            reject(new Error('selecionarClienteObj não carregou'));
          }
          return;
        }

        setTimeout(poll, 50);
      }

      window.addEventListener('zc:atendimentos-runtime-ready', onReady, { once: true });
      window.addEventListener('zc:atendimentos-ready', onReady, { once: true });
      setTimeout(poll, 0);
    });
  }

  async function openItem(item, opts = {}) {
    if (!item) return false;

    const payload = buildPayloadFromItem(item);
    const key = payload.conversation_key || payload.id || '';

    if (!key) {
      console.warn('[ZapsChat][open-safe] item sem conversation_key', item);
      return false;
    }

    const now = Date.now();
    if (openingKey === key && now - openingAt < 700) {
      return true;
    }

    openingKey = key;
    openingAt = now;

    markVisualActive(item);

    try {
      const fn = await waitForSelecionarClienteObj();
      await Promise.resolve(fn(payload, { forceReload: Boolean(opts.forceReload) }));
      return true;
    } catch (err) {
      console.error('[ZapsChat][open-safe] erro ao abrir conversa:', err);
      try {
        window.toast?.('Não consegui abrir essa conversa.', false);
      } catch {}
      return false;
    }
  }

  function onClickCapture(ev) {
    const item = getItemFromEvent(ev);
    if (!item) return;
    if (isOpenBlockTarget(ev.target)) return;

    // Usa o fluxo seguro e impede handlers antigos/duplicados de entrarem junto.
    ev.preventDefault();
    ev.stopPropagation();
    if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();

    openItem(item, { forceReload: false });
  }

  document.addEventListener('click', onClickCapture, true);

  window.ZCOpenConversationItemSafe = openItem;

  try {
    console.log('[ZapsChat][open-safe] carregado:', VERSION);
  } catch {}
})();
