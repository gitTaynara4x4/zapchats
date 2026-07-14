/* ====================================================================
 * ZapsChat – Painel de Atendimento
 * /frontend/js/atendimentos/boot/main.js
 *
 * Ponto de entrada ES Module.
 *
 * Objetivo desta versão:
 * - carregar módulos uma única vez
 * - evitar boot duplicado
 * - reduzir imports duplicados entre sidebar-atendimentos.html e main.js
 * - manter IA / Notas / Transferir funcionando no menu dos 3 pontinhos
 * - reduzir risco de loops/requisições duplicadas
 * - manter comportamento tipo WhatsApp: mensagem nova continua chegando via realtime
 * - manter media-render dividido
 * - manter header-actions dividido
 * - manter conversa aberta marcada na lista lateral
 * ==================================================================== */

(function () {
  'use strict';

  const MAIN_VERSION = 'zc-atendimentos-main-v15-hard-leave-fetch-abort';

  // v14:
  // A versão anterior gravava zc:atendimentos:leaving_to no sessionStorage e,
  // ao abrir /atendimentos de novo, o boot redirecionava sozinho para a última tela
  // de destino (/departamentos, /dashboard etc.). Isso causava loop:
  // /atendimentos -> main.js -> /departamentos -> /atendimentos -> main.js...
  // Ao entrar de verdade no Atendimento, limpamos qualquer marca antiga.
  function clearStaleHardLeaveMarks() {
    try {
      delete window.__ZC_ATENDIMENTOS_FORCE_NEXT_URL__;
      window.__ZC_ATENDIMENTOS_NAVIGATING_AWAY__ = false;
      window.__ZC_ATENDIMENTOS_HARD_NAV_STARTED__ = false;
      sessionStorage.removeItem('zc:atendimentos:leaving_until');
      sessionStorage.removeItem('zc:atendimentos:leaving_to');
      sessionStorage.removeItem('zc:atendimentos:leaving_reason');
    } catch (_) {}
  }

  clearStaleHardLeaveMarks();

  // v15:
  // Quando o atendimento está aberto, chegam vários GETs leves/pesados
  // (/conversas, /mensagens, /avatar, /usuarios/me). Se o usuário clica no
  // menu durante uma rajada de mensagens, esses fetches podem ocupar conexões
  // do navegador e atrasar a navegação para Dashboard/Departamentos.
  // Este guard só injeta AbortController em GETs do Atendimento e aborta todos
  // imediatamente quando começa uma navegação para fora da tela.
  (function installAtendimentoFetchGuardEarly() {
    if (window.__ZC_ATENDIMENTO_FETCH_GUARD_INSTALLED__) return;
    window.__ZC_ATENDIMENTO_FETCH_GUARD_INSTALLED__ = true;

    const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
    if (!nativeFetch || typeof AbortController === 'undefined') return;

    const pending = new Set();

    function isAtendimentoGet(input, init) {
      try {
        const method = String((init && init.method) || 'GET').toUpperCase();
        if (method !== 'GET') return false;

        const raw = typeof input === 'string'
          ? input
          : (input && (input.url || input.href)) || '';
        if (!raw) return false;

        const u = new URL(raw, location.origin);
        if (u.origin !== location.origin) return false;

        const p = u.pathname || '';
        return (
          p.startsWith('/api/atendimento/') ||
          p.startsWith('/api/empresas/') ||
          p === '/api/usuarios/me'
        );
      } catch (_) {
        return false;
      }
    }

    function abortAll(reason) {
      try {
        for (const ctrl of Array.from(pending)) {
          try { ctrl.abort(reason || 'zc:navigate-away'); } catch (_) {}
        }
        pending.clear();
      } catch (_) {}
    }

    window.__ZC_ATENDIMENTO_FETCH_GUARD__ = {
      abortAll,
      count: () => pending.size,
    };

    window.fetch = function zcAtendimentoFetchGuard(input, init) {
      try {
        if (
          String(location.pathname || '').includes('/atendimentos') &&
          !window.__ZC_ATENDIMENTOS_NAVIGATING_AWAY__ &&
          isAtendimentoGet(input, init)
        ) {
          const originalSignal = init && init.signal;
          if (!originalSignal) {
            const ctrl = new AbortController();
            pending.add(ctrl);
            const nextInit = Object.assign({}, init || {}, { signal: ctrl.signal });
            return nativeFetch(input, nextInit).finally(() => {
              try { pending.delete(ctrl); } catch (_) {}
            });
          }
        }
      } catch (_) {}

      return nativeFetch(input, init);
    };

    window.addEventListener('zc:navigate-away', () => abortAll('zc:navigate-away'), true);
    window.addEventListener('pagehide', () => abortAll('pagehide'), true);
    window.addEventListener('beforeunload', () => abortAll('beforeunload'), true);
  })();

  // v9: app-base.js não é carregado dentro do /atendimentos.
  // Então a navegação forte precisa existir aqui também, no boot da própria tela.
  // Sem isso, clique em Arquivos/Mídias podia ficar na fila atrás de render/WS.
  (function bindAtendimentoHardNavEarly() {
    if (window.__ZC_ATENDIMENTOS_HARD_NAV_EARLY_BOUND__) return;
    window.__ZC_ATENDIMENTOS_HARD_NAV_EARLY_BOUND__ = true;

    function norm(p) {
      return String(p || '').split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
    }

    function isInternalLink(a) {
      if (!a) return null;
      try {
        const href = a.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#') return null;
        if (a.target && a.target !== '_self') return null;
        const u = new URL(href, location.origin);
        if (u.origin !== location.origin) return null;
        return u;
      } catch (_) {
        return null;
      }
    }

    function markLeaving(u, reason) {
      try {
        const until = String(Date.now() + 15000);
        window.__ZC_ATENDIMENTOS_NAVIGATING_AWAY__ = true;
        window.__ZC_ATENDIMENTOS_FORCE_NEXT_URL__ = u.href;
        sessionStorage.setItem('zc:atendimentos:leaving_until', until);
        sessionStorage.setItem('zc:atendimentos:leaving_to', u.href);
        sessionStorage.setItem('zc:atendimentos:leaving_reason', reason || 'atendimento-main-nav');
      } catch (_) {}

      try { window.dispatchEvent(new CustomEvent('zc:navigate-away', { detail: { from: location.pathname, to: u.pathname, reason: reason || 'atendimento-main-nav', hard: true } })); } catch (_) {}
      try { window.zcAtendimentoWsMarkNavigatingAway && window.zcAtendimentoWsMarkNavigatingAway(reason || 'atendimento-main-nav'); } catch (_) {}
      try { window.zcAtendimentoWsClearPendingWork && window.zcAtendimentoWsClearPendingWork(reason || 'atendimento-main-nav'); } catch (_) {}
      try { window.__ZC_ATENDIMENTO_FETCH_GUARD__?.abortAll?.(reason || 'atendimento-main-nav'); } catch (_) {}
      try { window.ZC_CLOSE_ALL_WS && window.ZC_CLOSE_ALL_WS(); } catch (_) {}
      try { window.zcHistoricoClearOpenRealtimeWork && window.zcHistoricoClearOpenRealtimeWork(reason || 'atendimento-main-nav'); } catch (_) {}
      try { window.ZCForceClearLoading && window.ZCForceClearLoading(reason || 'atendimento-main-nav'); } catch (_) {}
      try { window.PageLoading && window.PageLoading.hide && window.PageLoading.hide(); } catch (_) {}
      try { window.PageLoading && window.PageLoading.reset && window.PageLoading.reset(); } catch (_) {}
      try { window.Splash && window.Splash.hide && window.Splash.hide(); } catch (_) {}
    }

    let __zcHardNavStarted = false;

    function hardGo(u, ev, reason) {
      try { ev && ev.preventDefault && ev.preventDefault(); } catch (_) {}
      try { ev && ev.stopPropagation && ev.stopPropagation(); } catch (_) {}
      try { ev && ev.stopImmediatePropagation && ev.stopImmediatePropagation(); } catch (_) {}

      // Navegação de saída tem que acontecer UMA vez só.
      // Repetir location.replace/assign cancela a própria navegação no Chrome
      // e aparece no Network como vários '/departamentos (canceled)'.
      if (__zcHardNavStarted || window.__ZC_ATENDIMENTOS_HARD_NAV_STARTED__) return;
      __zcHardNavStarted = true;
      window.__ZC_ATENDIMENTOS_HARD_NAV_STARTED__ = true;

      markLeaving(u, reason);

      // Prioridade absoluta: primeiro inicia a navegação do documento.
      // Em versões anteriores o window.stop() vinha antes do location.assign();
      // em alguns Chromes isso podia cancelar/atrasar a própria troca de página.
      try {
        location.assign(u.href);
      } catch (_) {
        try { location.href = u.href; } catch (__) {}
      }

      // Fallback sem bloquear: se algum listener/loader antigo tentar segurar a tela,
      // reforça a troca poucos ms depois. Não usa window.stop() aqui.
      try {
        setTimeout(() => {
          try {
            if (String(location.pathname || '') === '/atendimentos') {
              location.replace(u.href);
            }
          } catch (__) {}
        }, 120);
      } catch (_) {}
    }

    function onNavIntent(ev) {
      try {
        const a = ev.target && ev.target.closest && ev.target.closest('a[href]');
        const u = isInternalLink(a);
        if (!u) return;

        const cur = norm(location.pathname);
        const dst = norm(u.pathname);
        if (cur !== '/atendimentos' || dst === '/atendimentos' || cur === dst) return;

        hardGo(u, ev, ev.type || 'atendimento-main-nav');
      } catch (_) {}
    }

    document.addEventListener('pointerdown', onNavIntent, { capture: true });
    document.addEventListener('mousedown', onNavIntent, { capture: true });
    document.addEventListener('click', onNavIntent, { capture: true });
    try { document.addEventListener('touchstart', onNavIntent, { capture: true, passive: false }); } catch (_) {}
  })();


  /*
    Se este arquivo for carregado duas vezes por engano
    ou com cache/versionamento diferente, não deixa reinicializar tudo.
  */
  if (window.__ZC_ATENDIMENTOS_MAIN_PROMISE__) {
    return;
  }

  window.__ZC_ATENDIMENTOS_MAIN_VERSION__ = MAIN_VERSION;

  /*
    Flags globais ANTES dos imports dinâmicos.
    Importante: em import estático isso chegaria tarde demais.
  */

  // Não fazer prefetch de histórico de várias conversas automaticamente.
  // A conversa aberta continua carregando normal, e mensagem nova continua chegando via WS.
  if (window.PREFETCH_HISTORIES === undefined) {
    window.PREFETCH_HISTORIES = false;
  }

  // Evita banner superior antigo.
  window.SHOW_TOP_OPERATOR_BANNER = false;

  // Exige instância resolvida antes de abrir/enviar.
  window.ZC_REQUIRE_INSTANCE = true;

  // v7: WebSocket só liga depois que lista/módulos/boot terminarem.
  // Isso evita mensagem/replay chegando no meio do carregamento.
  window.ZC_WS_DELAY_BOOT_UNTIL_READY = true;

  // RAM: ao abrir conversa, busca primeiro uma janela pequena.
  window.ZC_HIST_OPEN_LIMIT = window.ZC_HIST_OPEN_LIMIT || 12;
  window.ZC_HIST_PAGE_SIZE = window.ZC_HIST_PAGE_SIZE || 12;
  window.ZC_HIST_DOM_MAX_ROWS = window.ZC_HIST_DOM_MAX_ROWS || 80;
  window.ZC_HIST_MAX_MESSAGES = window.ZC_HIST_MAX_MESSAGES || 60;


  /*
    Limpeza emergencial ANTES de importar o store.
    Versões antigas gravavam histórico/base64/listas gigantes no localStorage.
    Se o store importar antes de limpar, o JSON gigante é parseado e o Chrome pode ir para vários GB de RAM.
  */
  function cleanupZapsChatHeavyStorageEarly() {
    try {
      const BIG_LIST_BYTES = Number(window.ZC_BIG_LIST_CACHE_BYTES || 900000); // ~0.9 MB
      const HUGE_ANY_BYTES = Number(window.ZC_HUGE_LOCALSTORAGE_BYTES || 1800000); // ~1.8 MB
      const prefixes = [
        'cacheHistoricos:',
        'zc:hist:v2:',
      ];

      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) keys.push(k);
      }

      let removed = 0;

      for (const k of keys) {
        let raw = null;
        try { raw = localStorage.getItem(k); } catch { raw = null; }
        const len = raw ? raw.length : 0;
        const low = String(k).toLowerCase();

        const isHistory =
          prefixes.some((p) => String(k).startsWith(p)) ||
          low.includes(':hist:') ||
          low.includes(':cursor:') ||
          low.includes('cachehistoricos');

        const isBigConversationList =
          (String(k).startsWith('clientesCache:') || String(k).startsWith('zc:convs:v2:')) &&
          len > BIG_LIST_BYTES;

        const isHugeZapsKey =
          len > HUGE_ANY_BYTES &&
          (
            String(k).startsWith('zc:') ||
            String(k).startsWith('atend:') ||
            String(k).startsWith('clientesCache:') ||
            low.includes('historico') ||
            low.includes('conversa')
          );

        if (isHistory || isBigConversationList || isHugeZapsKey) {
          try {
            localStorage.removeItem(k);
            removed += 1;
          } catch {}
        }
      }

      if (removed) {
        try { console.warn('[ZapsChat] cache pesado removido antes do boot:', removed); } catch {}
        try { sessionStorage.setItem('convForceReload', '1'); } catch {}
      }
    } catch {}
  }

  cleanupZapsChatHeavyStorageEarly();

  // Guardas de request/reload.
  window.ZC_DISABLE_BOOT_DUPLICADO = true;
  window.ZC_CONVERSAS_RELOAD_DEBOUNCE_MS = window.ZC_CONVERSAS_RELOAD_DEBOUNCE_MS || 700;
  window.ZC_CONVERSAS_CACHE_TTL_MS = window.ZC_CONVERSAS_CACHE_TTL_MS || 8000;

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  /*
    Import seguro:
    - Se o módulo já foi carregado pelo sidebar-atendimentos.html, não importa de novo.
    - Se não foi carregado, o main.js carrega normalmente.
    - Isso reduz duplicação sem quebrar o funcionamento atual.
  */
  async function importIfMissing(flagName, modulePath) {
    try {
      if (flagName && window[flagName]) {
        return null;
      }

      return await import(modulePath);
    } catch (err) {
      console.error('[ZapsChat][main] erro ao importar módulo:', modulePath, err);
      throw err;
    }
  }

  async function importarModulosEssencial() {
    // Modo essencial: carrega só o necessário para lista, abrir conversa, enviar, atender/liberar.
    // Remove módulos com observers/menus/recursos extras para isolar consumo de CPU/RAM.
    await import('../core/env.js');
    await import('../core/format.js');
    await import('../core/time.js');
    await import('../core/cache.js');
    await import('../core/dom.js');

    await import('../state/store.js');

    await import('../domain/ack.js');
    await import('../domain/clientes.js');
    await import('../domain/instances.js');
    await import('../domain/historico.js');

    await import('../ui/splash.js');
    await import('../ui/envio.js');
    await import('../ui/notif.js');

    // Abre conversa e mantém RAM baixa.
    await import('../ui/conversas.js');
    await import('../ui/open-conversation-safe.js');

    await import('../ui/search.js');
    await import('../ui/inst-switch.js?v=zc-inst-acl-v2-20260710');
    await import('../ui/filtros.js');

    // Recursos que voltaram: perfil, fotos, notas/IA e menu dos 3 pontinhos.
    // Mantemos fora apenas observers pesados/duplicados da lista.
    await import('../ui/perfil.js');
    await import('../ui/perfil_quick.js');
    await importIfMissing('__ZC_PERFIL_INSTANCIA_LOADED__', '../ui/perfil-instancia.js');
    await import('../ui/notes-drawer.js');
    await import('../ui/ia.js');
    await import('../ui/new-chat.js');
    await import('../ui/context-menu.js');
    await import('../ui/apagar.js');

    // A lista ativa fica com a versão corrigida, sem observer de class.
    await import('../ui/lista-active-sync.js');
    await import('../ui/avatar-lazy-safe.js');

    await import('../ui/transferir-departamento.js');

    // Header actions dividido: volta lupa/calendário/3 pontinhos sem reativar o loop.
    await import('../ui/header-actions/core.js');
    await import('../ui/header-actions/conversation.js');
    await import('../ui/header-actions/media.js');
    await import('../ui/header-actions/send-api.js');
    await import('../ui/header-actions/buttons.js');
    await import('../ui/header-actions/date-jump.js');
    await import('../ui/header-actions/search.js');
    await import('../ui/header-actions/select-mode.js');
    await import('../ui/header-actions/forward.js');
    await import('../ui/header-actions/menu.js');
    await import('../ui/header-actions/boot.js');

    // Editar nome do cliente: isolado, sem desligar 3 pontinhos/menu.
    await import('../ui/editar-nome-cliente.js');

    await import('../ui/message-actions.js');
    await import('../ui/aceitar-conversa.js');
    await import('../ui/message-selection.js');
    await import('../ui/forward-picker.js');
    await import('../ui/loading-guard.js');

    return import('./init.js');
  }

  async function importarModulos() {
    if (window.ZC_ESSENTIAL_CHAT_MODE === true || window.ZC_DISABLE_OPTIONAL_CHAT_MODULES === true) {
      return importarModulosEssencial();
    }

    // -------- CORE ----------------------------------------------------
    await import('../core/env.js');
    await import('../core/format.js');
    await import('../core/time.js');
    await import('../core/cache.js');
    await import('../core/dom.js');

    // -------- STATE ---------------------------------------------------
    await import('../state/store.js');

    // -------- DOMAIN --------------------------------------------------
    await import('../domain/ack.js');
    await import('../domain/clientes.js');
    await import('../domain/historico.js');
    await import('../domain/instances.js');

    // -------- MEDIA RENDER DIVIDIDO ----------------------------------
    /*
      Mantido por segurança.
      Alguns módulos também são dependência do historico.js.
      O navegador reaproveita módulos ES já carregados pela mesma URL.
    */
    await import('../ui/media-render/core.js');
    await import('../ui/media-render/css.js');
    await import('../ui/media-render/urls.js');
    await import('../ui/media-render/avatars.js');
    await import('../ui/media-render/icons.js');
    await import('../ui/media-render/audio.js');
    await import('../ui/media-render/fallbacks.js');
    await import('../ui/media-render/markers.js');
    await import('../ui/media-render/gallery.js');
    await import('../ui/media-render/quoted.js');
    await import('../ui/media-render/viewer.js');
    await import('../ui/media-render/render-message.js');
    await import('../ui/media-render/boot.js');

    // -------- UI BASE -------------------------------------------------
    await import('../ui/splash.js');
    await import('../ui/envio.js');
    await import('../ui/notif.js');

    /*
      Perfil da conversa / perfil rápido continuam no main.
    */
    await import('../ui/perfil.js');
    await import('../ui/perfil_quick.js');

    /*
      Esses abaixo eram os principais duplicados no log:
      - sidebar-atendimentos.html carregava primeiro
      - main.js carregava de novo depois

      Agora:
      - se o sidebar já carregou, main.js pula
      - se o sidebar não carregou, main.js carrega
    */
    await importIfMissing('__ZC_SETTINGS_PANEL_PAGES_HELPER__', '../ui/settings-panel-pages.js');
    await importIfMissing('__ZC_PERFIL_INSTANCIA_LOADED__', '../ui/perfil-instancia.js');
    await importIfMissing('__ZC_SETTINGS_CONTA__', '../ui/conta.js');
    await importIfMissing('__ZC_SETTINGS_PRIVACIDADE__', '../ui/privacidade.js');
    await importIfMissing('__ZC_SETTINGS_CONVERSAS__', '../ui/conversas.js');
    await importIfMissing('__ZC_SETTINGS_NOTIFICACAO__', '../ui/notificacao.js');
    await importIfMissing('__ZC_SETTINGS_ATALHOS__', '../ui/atalhos-teclado.js');
    await importIfMissing('__ZC_SETTINGS_AJUDA__', '../ui/ajuda-feedback.js');

    // -------- UI DO ATENDIMENTO --------------------------------------
    await import('../ui/search.js');
    await import('../ui/inst-switch.js?v=zc-inst-acl-v2-20260710');

    /*
      IMPORTANTE:
      Esses 3 voltaram para o carregamento inicial porque eles criam/registram
      ações usadas pelo menu dos 3 pontinhos.
      Sem eles, IA / Notas / alguns atalhos do menu podem parar.
    */
    await import('../ui/notes-drawer.js');
    await import('../ui/ia.js');
    await import('../ui/filtros.js');

    await import('../ui/context-menu.js');
    await import('../ui/new-chat.js');

    /*
      Mantém a conversa aberta marcada na lista lateral.
      Isso não mexe em backend, não recarrega lista e não altera cache.
      Só sincroniza classes visuais:
      active / is-active / chat-active.
    */
    await import('../ui/lista-active-sync.js');
    await import('../ui/avatar-lazy-safe.js');

    await import('../ui/apagar.js');

    /*
      Transferência precisa vir ANTES do menu dos 3 pontinhos,
      porque o menu chama o botão original #btnTransferirDepartamento.
    */
    await import('../ui/transferir-departamento.js');

    /*
      Header actions dividido.
      IMPORTANTE:
      - Não carregar mais ../ui/header-actions.js antigo junto.
      - A ordem abaixo precisa ser mantida.
    */
    await import('../ui/header-actions/core.js');
    await import('../ui/header-actions/conversation.js');
    await import('../ui/header-actions/media.js');
    await import('../ui/header-actions/send-api.js');
    await import('../ui/header-actions/buttons.js');
    await import('../ui/header-actions/date-jump.js');
    await import('../ui/header-actions/search.js');
    await import('../ui/header-actions/select-mode.js');
    await import('../ui/header-actions/forward.js');
    await import('../ui/header-actions/menu.js');
    await import('../ui/header-actions/boot.js');

    // Editar nome do cliente: isolado, sem desligar 3 pontinhos/menu.
    await import('../ui/editar-nome-cliente.js');

    await import('../ui/message-actions.js');
    await import('../ui/aceitar-conversa.js');
    await import('../ui/message-selection.js');
    await import('../ui/forward-picker.js');

    // -------- BOOT ----------------------------------------------------
    return import('./init.js');
  }

  async function start() {
    if (window.__ZC_ATENDIMENTOS_MAIN_STARTED__) {
      return;
    }

    window.__ZC_ATENDIMENTOS_MAIN_STARTED__ = true;

    try {
      const initModule = await importarModulos();
      const boot = initModule && initModule.boot;

      if (typeof boot !== 'function') {
        throw new Error('boot() não encontrado em /frontend/js/atendimentos/boot/init.js');
      }

      ready(() => {
        try {
          /*
            O init.js também tem guarda própria:
            window.__ZC_ATENDIMENTOS_BOOTED__
            Aqui reforçamos para evitar chamada duplicada.
          */
          if (window.__ZC_ATENDIMENTOS_BOOT_CALLING__) {
            return;
          }

          window.__ZC_ATENDIMENTOS_BOOT_CALLING__ = true;

          Promise.resolve(boot())
            .then(async () => {
              try {
                window.__ZC_ATENDIMENTOS_RUNTIME_READY = true;
                window.dispatchEvent(new CustomEvent('zc:atendimentos-runtime-ready'));

                // Importa e liga o WS somente agora, depois de carregar a lista inicial.
                await import('../realtime/ws-empresa.js');
                try {
                  window.dispatchEvent(new CustomEvent('zc:start-empresa-ws'));
                } catch (_) {}
                try {
                  window.ZCStartEmpresaWS && window.ZCStartEmpresaWS();
                } catch (_) {}
              } catch (wsErr) {
                console.error('[ZapsChat][main] erro ao iniciar WS após boot:', wsErr);
              }
            })
            .catch((err) => {
              console.error('[ZapsChat][main] erro no boot:', err);
            })
            .finally(() => {
              window.__ZC_ATENDIMENTOS_BOOT_CALLING__ = false;
            });
        } catch (err) {
          window.__ZC_ATENDIMENTOS_BOOT_CALLING__ = false;
          console.error('[ZapsChat][main] falha ao iniciar boot:', err);
        }
      });
    } catch (err) {
      console.error('[ZapsChat][main] erro ao carregar módulos:', err);

      try {
        const splash = document.getElementById('app-splash') || document.getElementById('splash');

        if (splash) {
          splash.innerHTML = `
            <div style="padding:18px;text-align:center;color:#fff">
              <strong>Não foi possível carregar o atendimento.</strong><br>
              <small>Atualize a página e tente novamente.</small>
            </div>
          `;
        }
      } catch {}
    }
  }

  window.__ZC_ATENDIMENTOS_MAIN_PROMISE__ = start();
})();