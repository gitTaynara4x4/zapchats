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

  const MAIN_VERSION = 'zc-atendimentos-main-v8-menu-seguro';

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

  async function importarModulos() {
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

    // -------- REALTIME -----------------------------------------------
    await import('../realtime/ws-empresa.js');

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
    await import('../ui/inst-switch.js');

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