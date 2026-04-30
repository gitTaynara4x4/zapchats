// /frontend/js/atendimentos/ui/message-selection.js
// Seleção de mensagens estilo WhatsApp Web
// - só aparece quando clicar em "Selecionar mensagens"
// - header normal continua intacto fora do modo seleção
// - contador + ações em lote
// - marcar/desmarcar mensagens

(function () {
  if (window.__ZC_MESSAGE_SELECTION__) return;
  window.__ZC_MESSAGE_SELECTION__ = true;

  const state = {
    active: false,
    selected: new Map(),
    uid: 0,
  };

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function $all(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function H() {
    return document.getElementById('historico');
  }

  function headerEl() {
    return document.getElementById('chat-header');
  }

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[m]));
  }

  function notify({ title = 'Pronto', msg = '', type = 'ok', timeout = 2600 } = {}) {
    if (typeof window.toast === 'function') {
      try {
        window.toast({ title, msg, type, timeout });
        return;
      } catch {}
      try {
        window.toast(msg || title, type !== 'error');
        return;
      } catch {}
    }

    let host = document.getElementById('zcToastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'zcToastHost';
      host.className = 'zcToastHost';
      document.body.appendChild(host);
    }

    const el = document.createElement('div');
    el.className = `zcToast ${type === 'error' ? 'err' : 'ok'}`;
    el.innerHTML = `
      <div>
        <div class="t-title">${esc(title)}</div>
        ${msg ? `<div class="t-msg">${esc(msg)}</div>` : ''}
      </div>
      <button class="t-close" aria-label="Fechar"><i class="fa-solid fa-xmark"></i></button>
    `;
    host.appendChild(el);

    requestAnimationFrame(() => el.classList.add('on'));
    el.querySelector('.t-close')?.addEventListener('click', () => el.remove());
    if (timeout) setTimeout(() => el.remove(), timeout);
  }

  function ensureSelectionBar() {
    const hdr = headerEl();
    if (!hdr) return null;

    let bar = hdr.querySelector('.zc-selectbar');
    if (bar) return bar;

    bar = document.createElement('div');
    bar.className = 'zc-selectbar';

    bar.innerHTML = `
      <div class="zc-selectbar-left">
        <button type="button" class="zc-selectbar-btn is-close" data-action="cancel" aria-label="Cancelar seleção" title="Cancelar">
          <i class="fa-solid fa-xmark"></i>
        </button>

        <div class="zc-selectbar-count">
          <strong id="zcSelectCount">0</strong>
          <span id="zcSelectLabel">mensagens selecionadas</span>
        </div>
      </div>

      <div class="zc-selectbar-actions">
        <button type="button" class="zc-selectbar-btn" data-action="forward" aria-label="Encaminhar" title="Encaminhar">
          <i class="fa-solid fa-share"></i>
        </button>

        <button type="button" class="zc-selectbar-btn" data-action="favorite" aria-label="Favoritar" title="Favoritar">
          <i class="fa-regular fa-star"></i>
        </button>

        <button type="button" class="zc-selectbar-btn is-danger" data-action="delete" aria-label="Apagar" title="Apagar">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      </div>
    `;

    hdr.appendChild(bar);

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      const action = btn.getAttribute('data-action');
      if (action === 'cancel') {
        exitSelectionMode();
        return;
      }

      if (action === 'forward') {
        handleForward();
        return;
      }

      if (action === 'favorite') {
        handleFavorite();
        return;
      }

      if (action === 'delete') {
        handleDelete();
      }
    });

    return bar;
  }

  function getRowId(row) {
    if (!row) return null;

    const direct =
      row.getAttribute('data-msg-id') ||
      row.getAttribute('data-id') ||
      row.dataset.msgId ||
      row.dataset.id ||
      null;

    if (direct) return String(direct);

    if (!row.dataset.zcSelUid) {
      state.uid += 1;
      row.dataset.zcSelUid = `tmp-${Date.now()}-${state.uid}`;
    }

    return row.dataset.zcSelUid;
  }

  function getRowText(row) {
    return (
      row?.querySelector('.msg-text')?.textContent?.trim() ||
      row?.textContent?.trim() ||
      ''
    );
  }

  function getRowTime(row) {
    return (
      row?.querySelector('.msg-time')?.textContent?.trim() ||
      row?.querySelector('.time')?.textContent?.trim() ||
      ''
    );
  }

  function collectSelectedPayload() {
    return Array.from(state.selected.values());
  }

  function ensureRowCheck(row) {
    if (!row || !row.classList?.contains('msg-row')) return;

    let check = row.querySelector(':scope > .zc-msg-check');
    if (check) return check;

    check = document.createElement('span');
    check.className = 'zc-msg-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = `<i class="fa-solid fa-check"></i>`;

    row.insertBefore(check, row.firstChild);
    return check;
  }

  function refreshBar() {
    const bar = ensureSelectionBar();
    if (!bar) return;

    const count = state.selected.size;
    const countEl = $('#zcSelectCount', bar);
    const labelEl = $('#zcSelectLabel', bar);

    if (countEl) countEl.textContent = String(count);
    if (labelEl) {
      labelEl.textContent = count === 1
        ? 'mensagem selecionada'
        : 'mensagens selecionadas';
    }

    const disabled = count <= 0;
    $all('.zc-selectbar-btn[data-action="forward"], .zc-selectbar-btn[data-action="favorite"], .zc-selectbar-btn[data-action="delete"]', bar)
      .forEach((btn) => {
        btn.disabled = disabled;
      });
  }

  function refreshRowVisual(row) {
    if (!row) return;
    ensureRowCheck(row);

    const id = getRowId(row);
    const selected = !!id && state.selected.has(id);
    row.classList.toggle('is-selected', selected);
  }

  function refreshAllRows() {
    const hist = H();
    if (!hist) return;

    $all('.msg-row', hist).forEach((row) => {
      if (row.getAttribute('data-cluster-hidden') === '1') return;
      ensureRowCheck(row);
      refreshRowVisual(row);
    });
  }

  function enterSelectionMode() {
    const hist = H();
    if (!hist) {
      notify({ title: 'Selecione uma conversa', type: 'error' });
      return;
    }

    state.active = true;
    state.selected.clear();

    hist.classList.add('zc-select-mode');

    const bar = ensureSelectionBar();
    if (bar) {
      bar.classList.add('is-open');
    }

    refreshAllRows();
    refreshBar();
  }

  function exitSelectionMode() {
    const hist = H();
    const bar = ensureSelectionBar();

    state.active = false;
    state.selected.clear();

    if (hist) {
      hist.classList.remove('zc-select-mode');
      $all('.msg-row.is-selected', hist).forEach((row) => {
        row.classList.remove('is-selected');
      });
    }

    if (bar) {
      bar.classList.remove('is-open');
    }

    refreshBar();
  }

  function toggleRow(row) {
    if (!state.active || !row) return;

    const id = getRowId(row);
    if (!id) return;

    if (state.selected.has(id)) {
      state.selected.delete(id);
    } else {
      state.selected.set(id, {
        id,
        msg_id: row.getAttribute('data-msg-id') || row.dataset.msgId || null,
        dom_id: row.getAttribute('data-id') || row.dataset.id || null,
        text: getRowText(row),
        time: getRowTime(row),
        outgoing: row.classList.contains('msg-sent'),
      });
    }

    refreshRowVisual(row);
    refreshBar();

    if (state.selected.size <= 0) {
      exitSelectionMode();
    }
  }

  function emitSelectionAction(fnName, eventName, emptyTitle) {
    const items = collectSelectedPayload();

    if (!items.length) {
      notify({ title: emptyTitle, msg: 'Nenhuma mensagem selecionada.', type: 'error' });
      return false;
    }

    const payload = {
      items,
      count: items.length,
    };

    if (typeof window[fnName] === 'function') {
      try {
        window[fnName](payload);
        return true;
      } catch (e) {
        console.warn(`[message-selection] erro em ${fnName}:`, e);
      }
    }

    try {
      document.dispatchEvent(new CustomEvent(eventName, { detail: payload }));
      return true;
    } catch (e) {
      console.warn(`[message-selection] erro ao disparar ${eventName}:`, e);
    }

    return false;
  }

  function handleForward() {
    const ok = emitSelectionAction(
      'encaminharMensagensSelecionadas',
      'zc:forward-selected-messages',
      'Encaminhar'
    );

    if (ok) {
      notify({
        title: 'Encaminhar',
        msg: `${state.selected.size} mensagem(ns) pronta(s) para encaminhar.`,
        type: 'ok',
      });
    }
  }

  function handleFavorite() {
    const ok = emitSelectionAction(
      'favoritarMensagensSelecionadas',
      'zc:favorite-selected-messages',
      'Favoritar'
    );

    if (ok) {
      notify({
        title: 'Favoritar',
        msg: `${state.selected.size} mensagem(ns) enviada(s) para favoritos.`,
        type: 'ok',
      });
    }
  }

  function handleDelete() {
    const items = collectSelectedPayload();
    if (!items.length) {
      notify({ title: 'Apagar', msg: 'Nenhuma mensagem selecionada.', type: 'error' });
      return;
    }

    const okConfirm = window.confirm(
      items.length === 1
        ? 'Apagar a mensagem selecionada?'
        : `Apagar as ${items.length} mensagens selecionadas?`
    );

    if (!okConfirm) return;

    const ok = emitSelectionAction(
      'apagarMensagensSelecionadas',
      'zc:delete-selected-messages',
      'Apagar'
    );

    if (ok) {
      notify({
        title: 'Apagar',
        msg: `${items.length} mensagem(ns) enviada(s) para exclusão.`,
        type: 'ok',
      });
    }
  }

  function onHistoryClickCapture(e) {
    if (!state.active) return;

    const hist = H();
    if (!hist) return;

    const row = e.target.closest('.msg-row');
    if (!row || !hist.contains(row)) return;
    if (row.getAttribute('data-cluster-hidden') === '1') return;

    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }

    toggleRow(row);
  }

  function bindHistory() {
    const hist = H();
    if (!hist || hist.__zcSelectBound) return;

    hist.__zcSelectBound = true;
    hist.addEventListener('click', onHistoryClickCapture, true);

    const mo = new MutationObserver(() => {
      if (!state.active) return;
      refreshAllRows();
      refreshBar();
    });

    mo.observe(hist, { childList: true, subtree: true });
  }

  function bindGlobal() {
    if (document.__zcSelectionGlobalBound) return;
    document.__zcSelectionGlobalBound = true;

    document.addEventListener('zc:select-messages', () => {
      if (state.active) return;
      enterSelectionMode();
    });

    document.addEventListener('cliente:selecionar', () => {
      exitSelectionMode();
    });

    document.addEventListener('zc:open_chat', () => {
      exitSelectionMode();
    });

    document.addEventListener('chat:open', () => {
      exitSelectionMode();
    });

    document.addEventListener('keydown', (e) => {
      if (!state.active) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        exitSelectionMode();
      }
    });
  }

  function start() {
    ensureSelectionBar();
    bindHistory();
    bindGlobal();

    if (!window.__zcSelectionEnsureInterval) {
      window.__zcSelectionEnsureInterval = setInterval(() => {
        ensureSelectionBar();
        bindHistory();
      }, 1200);
    }
  }

  window.ativarSelecaoMensagens = enterSelectionMode;
  window.cancelarSelecaoMensagens = exitSelectionMode;
  window.getMensagensSelecionadas = collectSelectedPayload;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();