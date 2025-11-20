// /frontend/js/atendimentos/ui/filtros.js
import { getConversas } from '../state/store.js';

(function FiltrosLista() {
  const row = document.querySelector('.wpp-header-filtros-row');
  const ul  = document.getElementById('lista-clientes');
  if (!row || !ul) return;

  const btns = [...row.querySelectorAll('.wpp-header-filtro')];
  if (!btns.length) return;

  // ----------------- estado do filtro (global p/ outros módulos chamarem) -----------------
  const Filtros = (window.Filtros = window.Filtros || {});
  let current = sessionStorage.getItem('filtroAtend') || 'Em atendimento';

  Filtros.get = () => current;
  Filtros.set = (kind) => {
    if (!kind) return;
    current = String(kind);
    sessionStorage.setItem('filtroAtend', current);
    marcarBotaoAtivo();
    refilterList();
  };
  Filtros.refilterList = () => refilterList();

  // ----------------- helpers -----------------
  const byId = new Map(); // id -> tags calculadas

  function isGroupByTel(tel) {
    const t = String(tel || '');
    return /@g\.us$/i.test(t) || /\bgrupo\b/i.test(t);
  }

  function matchInstancia(tagInstId) {
    try {
      // preferir helper global, se existir
      if (typeof window._matchInstancia === 'function') {
        return window._matchInstancia(tagInstId);
      }
      const ativa =
        window.INSTANCIA_ATIVA == null || window.INSTANCIA_ATIVA === ''
          ? null
          : String(window.INSTANCIA_ATIVA);
      if (!ativa) return true;
      if (!tagInstId) return true;
      return String(tagInstId).toLowerCase() === String(ativa).toLowerCase();
    } catch {
      return true;
    }
  }

  function openClienteId() {
    const hist = document.getElementById('historico');
    const v = hist?.dataset?.clienteId;
    return v ? Number(v) || 0 : 0;
  }

  function idFromLi(li) {
    const d = li.dataset?.id;
    if (d) return Number(d) || 0;
    const m = /chat-(\d+)/.exec(li.id || '');
    return m ? Number(m[1]) || 0 : 0;
  }

  function normalizarStatus(c) {
    const raw = String(c.statusatendimento ?? c.status ?? '')
      .trim()
      .toLowerCase();
    // Rótulos comuns
    const BOT = ['bot', 'automático', 'automatico', 'auto', 'automatizado'];
    if (BOT.includes(raw)) return 'bot';
    // qualquer outro vira humano / no_bot
    return 'no_bot';
  }

  // ----------------- indexador (lê o store) -----------------
  function makeIndex() {
    byId.clear();
    const convs =
      typeof getConversas === 'function' ? getConversas() || [] : [];

    for (const c of convs) {
      const id = Number(c.conversation_id ?? c.cliente_id ?? c.id ?? 0) || 0;
      if (!id) continue;

      const unread  = Number(c.novas ?? c.unread ?? 0) > 0;
      const grupo   = Boolean(c.is_group) || isGroupByTel(c.telefone);
      const statusN = normalizarStatus(c);
      const isBot   = statusN === 'bot';
      const isNoBot = !isBot;

      const instId =
        c.instancia_id ?? c.instancia ?? c.instance_id ?? c.inst ?? null;

      // Regras dos filtros:
      // - Em atendimento: humano (no_bot) e NÃO grupo (NÃO depende de unread!)
      // - Aguardando: tem não lidas
      // - No bot: status bot
      // - Grupos: é grupo (qualquer estado)
      const tags = {
        unread,
        isGroup: grupo,
        isBot,
        isNoBot,
        instId,

        emAtend: isNoBot && !grupo,
        aguardando: unread,
        noBot: isBot,
        grupos: grupo,
      };

      byId.set(id, tags);
    }
  }

  // ----------------- aplicar filtro na UL -----------------
  function shouldShow(id, tags) {
    // manter o chat aberto sempre visível
    if (id && id === openClienteId()) return true;

    // respeitar instância ativa (se houver)
    if (!matchInstancia(tags?.instId ?? null)) return false;

    const kind = current;

    if (kind === 'Em atendimento') return !!tags?.emAtend;
    if (kind === 'Aguardando')     return !!tags?.aguardando;
    if (kind === 'No bot')         return !!tags?.noBot;
    // filtro só pra grupos
    if (kind === 'Grupos' || kind === 'Grupo') return !!tags?.grupos;

    // fallback (se aparecer um rótulo diferente)
    return true;
  }

  function refilterList() {
    // sempre reconstrói o índice (novas chegam pelo WS)
    makeIndex();

    const lis = ul.querySelectorAll('li');
    for (const li of lis) {
      const id   = idFromLi(li);
      const tags = byId.get(id) || null;
      const show = id && tags ? shouldShow(id, tags) : true;
      li.style.display = show ? '' : 'none';
      li.classList.toggle('hidden-by-filter', !show);
    }
  }

  function marcarBotaoAtivo() {
    for (const b of btns) {
      const on = b.textContent.trim() === current;
      b.classList.toggle('ativo', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // ----------------- eventos da UI -----------------
  btns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const kind = btn.textContent.trim();
      if (!kind || kind === current) return;
      Filtros.set(kind);
    });
  });

  // ----------------- observar mudanças na UL (itens, classes, badges) -----------------
  const mo = new MutationObserver(() => {
    refilterList();
  });

  mo.observe(ul, {
    childList: true,
    subtree: true,
    characterData: true, // pega mudança de preview/badge
    attributes: true,
    attributeFilter: ['data-status', 'data-instancia-id', 'class', 'data-id'],
  });

  // ----------------- reagir a eventos globais -----------------
  document.addEventListener('ws:conv_status', () => refilterList());
  document.addEventListener('ws:reload_clientes', () => refilterList());
  document.addEventListener('inst:change', () => refilterList());

  // ----------------- boot -----------------
  // garante botão ativo conforme sessionStorage
  marcarBotaoAtivo();
  // aplica filtro inicial
  refilterList();

  // expõe no window (opcional)
  try {
    window.Filtros = Filtros;
  } catch {}
})();
