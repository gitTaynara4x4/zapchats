// /frontend/js/atendimentos/ui/apagar.js
// UI de mensagens apagadas
// - Lê flags apagada_cliente / apagada_usuario vindas do backend (via hist-cache)
// - NÃO apaga o conteúdo original: só adiciona um aviso/bandeirinha visual
// - Funciona no carregamento inicial + conforme novas .msg-row aparecem

import { getHist } from '../domain/hist-cache.js';

const SELECTORS_HIST = ['#historico', '.chat-history', '.mensagens', '#mensagens', '#history'];

function findHistoryContainer() {
  for (const s of SELECTORS_HIST) {
    const n = document.querySelector(s);
    if (n) return n;
  }
  return null;
}

function boolFlag(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (!s) return false;
  return ['1', 'true', 't', 'y', 'yes', 'sim'].includes(s);
}

// Decide o texto do aviso que vai aparecer
function getDeleteLabel(msg) {
  const flagCli =
    boolFlag(msg.apagada_cliente ?? msg.apagadaCliente ?? msg.deleted_by_client);
  const flagUsr =
    boolFlag(msg.apagada_usuario ?? msg.apagadaUsuario ?? msg.deleted_by_user);

  if (flagCli && flagUsr) return 'Esta mensagem foi apagada pelo cliente e atendente';
  if (flagCli) return 'Esta mensagem foi apagada pelo cliente';
  if (flagUsr) return 'Esta mensagem foi apagada pelo atendente';

  // Fallback: se o backend já trocou o texto pra "[Mensagem apagada]"
  const raw = (msg.conteudo || msg.texto || msg.mensagem || '').trim().toLowerCase();
  if (!raw) return null;
  if (
    raw === '[mensagem apagada]' ||
    raw === 'mensagem apagada' ||
    raw === 'mensagem apagada pelo cliente' ||
    raw === 'mensagem apagada pelo atendente'
  ) {
    return 'Esta mensagem foi apagada';
  }

  return null;
}

let _lastKey = null;
let _idx = null;

// Índice rápido msg_id -> msg vindo do hist-cache
function ensureIndex() {
  const hist = findHistoryContainer();
  if (!hist) return null;

  const cidDom = hist.dataset.clienteId || hist.getAttribute('data-cliente-id');
  const instDom =
    hist.dataset.instanciaId ||
    hist.getAttribute('data-instancia-id') ||
    window.INSTANCIA_ATIVA ||
    (window.state?.clienteSel?.instancia_id ?? null);

  const cid = Number(
    cidDom || window.state?.clienteSel?.id || window.clienteSel?.id || 0
  );
  if (!cid) return null;

  const key = `${instDom ?? 'all'}::${cid}`;
  if (key === _lastKey && _idx) return _idx;

  const msgs = getHist(instDom ?? null, cid) || [];
  const byId = new Map();
  const byFallback = new Map();

  for (const m of msgs) {
    const id = m.msg_id ?? m.id ?? m.message_id ?? m.messageId ?? null;
    if (id) {
      const k = String(id);
      if (!byId.has(k)) byId.set(k, m);
      continue;
    }

    // fallback por ts+trecho de texto
    const ts =
      m.timestamp || m.ts || m.data || m.created_at || '';
    const txt = (m.conteudo || m.texto || m.mensagem || '').slice(0, 64);
    const fk = `${ts}|${txt}`;
    if (!byFallback.has(fk)) byFallback.set(fk, m);
  }

  _lastKey = key;
  _idx = { inst: instDom ?? null, cid, byId, byFallback };
  return _idx;
}

function findMsgForRow(row) {
  const idx = ensureIndex();
  if (!idx) return null;

  const idAttr =
    row.dataset.msgId ||
    row.getAttribute('data-msg-id') ||
    row.dataset.id ||
    row.getAttribute('data-id') ||
    null;

  if (idAttr && idx.byId.has(String(idAttr))) {
    return idx.byId.get(String(idAttr));
  }

  // fallback por timestamp + texto da bolha
  const tsEl =
    row.querySelector('.msg-time, time[data-ts], [data-timestamp]') || null;
  const textEl =
    row.querySelector('.msg-text') ||
    row.querySelector('.bubble-text') ||
    row.querySelector('.text') ||
    null;

  const ts =
    tsEl?.getAttribute?.('data-timestamp') ||
    tsEl?.dateTime ||
    tsEl?.getAttribute?.('datetime') ||
    tsEl?.textContent ||
    '';
  const txt = (textEl?.textContent || '').slice(0, 64);
  const fk = `${ts}|${txt}`;

  return idx.byFallback.get(fk) || null;
}

function decorateRow(row) {
  if (!(row instanceof HTMLElement)) return;
  if (row.dataset.deletedDecorated === '1') return;

  const msg = findMsgForRow(row);
  if (!msg) return;

  const label = getDeleteLabel(msg);
  if (!label) return;

  // bolha principal
  const bubble =
    row.querySelector('.bubble') ||
    row.querySelector('.msg-bubble') ||
    row;

  if (!bubble) return;

  // 👉 NÃO escondemos mídias nem trocamos o texto.
  // Vamos criar um "banner" em cima do conteúdo da bolha.

  let banner = bubble.querySelector('.msg-delete-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'msg-delete-banner';
    bubble.insertBefore(banner, bubble.firstChild);
  }
  banner.textContent = label;

  row.classList.add('msg-deleted');
  row.dataset.deletedDecorated = '1';

  // logzinho pra debug
  try {
    const who =
      boolFlag(msg.apagada_cliente) && boolFlag(msg.apagada_usuario)
        ? 'cliente+atendente'
        : boolFlag(msg.apagada_cliente)
        ? 'cliente'
        : boolFlag(msg.apagada_usuario)
        ? 'atendente'
        : 'desconhecido';

    console.log('[apagar.js] mensagem marcada como apagada', {
      conv: ensureIndex()?.cid,
      msg_id: msg.msg_id ?? null,
      quem: who,
      label,
    });
  } catch {}
}

function decorateAll() {
  const hist = findHistoryContainer();
  if (!hist) return;
  const rows = hist.querySelectorAll(
    '.msg-row, li.msg-row, .message-row'
  );
  rows.forEach(decorateRow);
}

function ensureCss() {
  if (document.getElementById('msg-delete-style')) return;
  const style = document.createElement('style');
  style.id = 'msg-delete-style';
  style.textContent = `
  #historico .msg-row.msg-deleted .bubble,
  #historico .msg-row.msg-deleted {
    opacity: .97;
  }
  #historico .msg-row.msg-deleted .msg-delete-banner {
    display: block;
    font-size: .70rem;
    font-style: italic;
    margin-bottom: .15rem;
    color: var(--muted, #aebac1);
  }
  #historico .msg-row.msg-deleted .msg-time,
  #historico .msg-row.msg-deleted time {
    opacity: .9;
  }
  `;
  document.head.appendChild(style);
}

function setupObserver() {
  const hist = findHistoryContainer();
  if (!hist) {
    // espera o histórico existir no DOM
    const mo = new MutationObserver((_muts, obs) => {
      const h = findHistoryContainer();
      if (h) {
        obs.disconnect();
        setupObserver();
        decorateAll();
      }
    });
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    return;
  }

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.('.msg-row, li.msg-row, .message-row')) {
          decorateRow(node);
        } else {
          node
            .querySelectorAll?.(
              '.msg-row, li.msg-row, .message-row'
            )
            .forEach(decorateRow);
        }
      }
    }
  });

  obs.observe(hist, { childList: true, subtree: true });
}

function init() {
  try {
    ensureCss();
    decorateAll();
    setupObserver();
    console.log('[apagar.js] inicializado (UI de mensagens apagadas)');
  } catch (e) {
    console.error('[apagar.js] falha ao inicializar', e);
  }
}

// boot do módulo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// APIzinha opcional pra forçar refresh manual (se precisar)
export const ApagarUI = {
  refresh() {
    _lastKey = null;
    _idx = null;
    decorateAll();
  },
};
