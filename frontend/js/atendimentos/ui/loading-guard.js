// /frontend/js/atendimentos/ui/loading-guard.js
// Guarda de estabilidade do atendimento.
// Objetivo: nenhum loading fica infinito e nenhuma mensagem WS derruba a tela.
(function () {
  'use strict';

  if (window.__ZC_LOADING_GUARD_V1__) return;
  window.__ZC_LOADING_GUARD_V1__ = true;

  const START = Date.now();
  const MAX_GLOBAL_LOADING_MS = 9000;
  const MAX_CHAT_LOADING_MS = 180000;
  const MAX_LIST_LOADING_MS = 25000;

  function now() { return Date.now(); }

  function hardHideGlobal(reason) {
    try { window.PageLoading?.reset?.(); } catch {}
    try { window.PageLoading?.hide?.(); } catch {}
    try { window.Splash?.hide?.(); } catch {}

    try {
      const p = document.getElementById('page-loading') || document.getElementById('app-loading');
      if (p) {
        p.classList.remove('show');
        p.style.display = 'none';
        p.style.pointerEvents = 'none';
      }
    } catch {}

    try {
      const s = document.getElementById('splash-screen');
      if (s) s.remove();
    } catch {}

    try {
      document.documentElement.classList.remove('is-loading', 'prepaint');
      document.body.classList.remove('is-loading');
      document.documentElement.style.overflow = '';
      delete document.documentElement.dataset.pageLoadingLock;
    } catch {}

    try { console.debug('[ZC LoadingGuard] hide global:', reason); } catch {}
  }

  function hardHideChatLoading(reason) {
    try {
      const el = document.getElementById('chat-loading');
      if (el) {
        el.classList.add('hidden');
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
      }
    } catch {}

    try {
      const hist = document.getElementById('historico');
      if (hist) {
        hist.removeAttribute('aria-busy');
        delete hist.dataset.loadingConversationKey;
        hist.querySelectorAll('[data-hist-initial-loading="1"]').forEach((n) => n.remove());
      }
    } catch {}

    try { console.debug('[ZC LoadingGuard] hide chat:', reason); } catch {}
  }

  function fixListIfStuck() {
    try {
      const ul = document.getElementById('lista-clientes');
      if (!ul) return;

      const isLoading = ul.dataset.loadingConversas === '1' || !!ul.querySelector('[data-list-state="loading"], .chat-list-loading');
      if (!isLoading) {
        delete ul.dataset.zcLoadingSince;
        return;
      }

      if (!ul.dataset.zcLoadingSince) ul.dataset.zcLoadingSince = String(now());
      const age = now() - Number(ul.dataset.zcLoadingSince || now());
      if (age < MAX_LIST_LOADING_MS) return;

      delete ul.dataset.loadingConversas;
      delete ul.dataset.zcLoadingSince;

      const arr = Array.isArray(window.state?.clientesCache)
        ? window.state.clientesCache
        : (Array.isArray(window.clientesCache) ? window.clientesCache : []);

      if (arr.length && typeof window.renderListaClientes === 'function') {
        window.renderListaClientes(arr);
      } else {
        ul.innerHTML = `
          <li class="chat-list-state chat-list-error" data-list-state="error" role="status" aria-live="polite">
            <div class="chat-list-state-icon" aria-hidden="true"><i class="fa-solid fa-triangle-exclamation"></i></div>
            <div class="chat-list-state-title">Não conseguimos carregar suas conversas.</div>
            <div class="chat-list-state-sub">Verifique sua conexão com a internet e tente novamente.</div>
            <div class="chat-list-state-support">Se o problema continuar, entre em contato com o suporte.</div>
            <button type="button" class="chat-list-retry-btn" data-zc-retry-list="1">
              <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>
              <span>Tentar novamente</span>
            </button>
          </li>`;

        ul.querySelector('[data-zc-retry-list="1"]')?.addEventListener('click', async (event) => {
          const btn = event.currentTarget;
          if (!btn || btn.dataset.loading === '1') return;

          btn.dataset.loading = '1';
          btn.disabled = true;
          const label = btn.querySelector('span');
          if (label) label.textContent = 'Tentando novamente…';

          try {
            if (typeof window.ZCRecarregarListaConversas === 'function') {
              await window.ZCRecarregarListaConversas();
            } else if (typeof window.carregarClientes === 'function') {
              await window.carregarClientes({ force: true, reason: 'loading-guard-retry' });
            } else {
              window.dispatchEvent(new CustomEvent('zc:retry-conversas'));
            }
          } catch (e) {
            btn.dataset.loading = '0';
            btn.disabled = false;
            if (label) label.textContent = 'Tentar novamente';
          }
        });
      }
    } catch {}
  }

  function fixChatIfStuck() {
    try {
      const hist = document.getElementById('historico');
      if (!hist) return;

      const hasLoading = !!hist.querySelector('[data-hist-initial-loading="1"]') || hist.getAttribute('aria-busy') === 'true';
      if (!hasLoading) {
        delete hist.dataset.zcLoadingSince;
        return;
      }

      if (!hist.dataset.zcLoadingSince) hist.dataset.zcLoadingSince = String(now());
      const age = now() - Number(hist.dataset.zcLoadingSince || now());
      if (age < MAX_CHAT_LOADING_MS) return;

      const hasRows = !!hist.querySelector('.msg-row, .bubble, [data-msg-id]');
      if (hasRows) {
        hardHideChatLoading('hist-has-rows');
        return;
      }

      hardHideChatLoading('hist-timeout-soft');
      try {
        const key = hist.dataset.conversationKey || hist.dataset.conversationId || hist.dataset.convKey;
        if (key && typeof window.zcShowConversationSoftRetry === 'function') {
          window.zcShowConversationSoftRetry({ key }, key, 'Carregando conversa…');
          return;
        }
      } catch {}
      hist.style.display = 'flex';
      hist.setAttribute('aria-busy', 'true');
      hist.innerHTML = `
        <div class="hist-initial-loading" data-hist-initial-loading="1">
          <div class="spinner" aria-hidden="true"></div>
          <div class="txt">Carregando conversa…</div>
          <div class="subtxt">O histórico está demorando um pouco mais. Continuamos tentando.</div>
        </div>`;
    } catch {}
  }

  function tick() {
    if (now() - START > MAX_GLOBAL_LOADING_MS) hardHideGlobal('startup-watchdog');
    fixListIfStuck();
    fixChatIfStuck();
  }

  ['zc:atendimentos-ready', 'app:ready', 'historico:rendered', 'zc:conversation-selected', 'zc:message-received', 'zc:new-message', 'atendimento:message'].forEach((evt) => {
    try {
      window.addEventListener(evt, () => {
        setTimeout(() => hardHideGlobal(evt), 30);
        setTimeout(() => hardHideChatLoading(evt), 60);
      });
      document.addEventListener(evt, () => {
        setTimeout(() => hardHideGlobal(evt), 30);
        setTimeout(() => hardHideChatLoading(evt), 60);
      });
    } catch {}
  });

  setInterval(tick, 1000);
  setTimeout(tick, 2500);
  setTimeout(tick, 6000);
})();


// ZC_LOADING_GUARD_V5
(function zcLoadingGuardV5(){
  if (window.__ZC_LOADING_GUARD_V5__) return;
  window.__ZC_LOADING_GUARD_V5__ = true;

  function hardClear(reason){
    try { window.PageLoading?.reset?.(); } catch {}
    try { window.PageLoading?.hide?.(); } catch {}
    try { window.ready?.(); } catch {}
    try { window.Splash?.hide?.(); } catch {}

    try {
      document.documentElement.classList.remove('is-loading');
      document.body.classList.remove('is-loading');
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
      delete document.documentElement.dataset.pageLoadingLock;
      delete document.body.dataset.pageLoadingLock;
    } catch {}

    try {
      ['page-loading','app-loading','chat-loading','app-splash','splash'].forEach(function(id){
        var el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('show','is-active','active','loading');
        el.setAttribute('aria-hidden','true');
        el.style.pointerEvents = 'none';
        if (id === 'page-loading' || id === 'app-loading' || id === 'chat-loading') {
          el.style.display = 'none';
        }
      });
    } catch {}

    try {
      var hist = document.getElementById('historico');
      if (hist) {
        hist.removeAttribute('aria-busy');
        delete hist.dataset.loadingConversationKey;
        hist.querySelectorAll('[data-hist-initial-loading="1"]').forEach(function(n){ n.remove(); });
      }
    } catch {}

    try { window.dispatchEvent(new CustomEvent('zc:loading-guard-cleared', { detail:{ reason: reason || 'v5' }})); } catch {}
  }

  window.ZCForceClearLoading = hardClear;
  ['zc:atendimentos-ready','zc:ws-message-received','zc:message-received','zc:message-upserted','zc:lista-conversas-loaded'].forEach(function(ev){
    window.addEventListener(ev, function(){ hardClear(ev); });
    document.addEventListener(ev, function(){ hardClear(ev); });
  });

  [250, 800, 1600, 3000, 6000, 12000].forEach(function(ms){ setTimeout(function(){ hardClear('timer-'+ms); }, ms); });
})();
