//frontend\js\atendimentos\boot\main.js

/* ====================================================================
 * zapschat – Painel de Atendimento
 * /frontend/js/atendimentos/boot/main.js
 *
 * Ponto de entrada ES Module. Carrega todos os módulos em ordem e
 * dá o boot da aplicação quando o DOM estiver pronto.
 * ==================================================================== */

// -------- CORE (infra/úteis) -----------------------------------------
import '../core/env.js';        // valida EMPRESA_ID e expõe helpers de ambiente
import '../core/format.js';     // normalize/escape/formatadores (número BR, etc.)
import '../core/time.js';       // parse/format de datas (APP_TZ, tsToMillis, formatChatTime)
import '../core/cache.js';      // cache TTL em localStorage + fetchWithCache
import '../core/dom.js';        // helpers de DOM, estilos de mídia, etc.

// -------- STATE (estado global/caches) -------------------------------
import '../state/store.js';     // state/clientesCache/cacheHistoricos/salvarCache...

// -------- DOMAIN (regras de negócio) --------------------------------
import '../domain/ack.js';          // normalização/aplicação de ACK (getAckIcon, applyAckUpdate)
import '../domain/clientes.js';     // carregarClientes, renderListaClientes, contatos
import '../domain/historico.js';    // salvarNoCache, renderHistoricoDoCache, paginação
import '../domain/instances.js';    // INSTÂNCIA_ATIVA + setInstanciaAtiva / filtros
import '../ui/media-render.js'; // criação de HTML de mídias, players, fallbacks

// -------- REALTIME (websocket) --------------------------------------
import '../realtime/ws-empresa.js'; // connectEmpresaWS + eventos (ack, reload, nova msg)

// -------- UI (componentes/controles) --------------------------------
import '../ui/splash.js';           // splash “Protegida com a criptografia…”
import '../ui/envio.js';            // barra de envio: texto, anexos, gravação de áudio
import '../ui/notif.js';            // áudio/desktop notifications + contador de não lidas
import '../ui/perfil.js';           // shim de perfil: abrirPerfilAtual()
import '../ui/perfil_quick.js';     // painel rápido (Evolution) ao clicar no nome/foto
import '../ui/search.js';           // busca global e dentro do chat (F3/Ctrl+G)
import '../ui/inst-switch.js';      // seletor de instâncias "WhatsApps (N)"
import '../ui/notes-drawer.js';     // drawer lateral “Sobre o cliente”
import '../ui/ia.js';               // modal/ferramentas de IA
import '../ui/context-menu.js';
import '../ui/new-chat.js';
import '../ui/filtros.js';
import '../ui/apagar.js';

// -------- BOOT (liga tudo ao carregar a página) ---------------------
import { boot } from './init.js';

// Garante que o boot só execute após o DOM estar pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot());
} else {
  boot();
}
