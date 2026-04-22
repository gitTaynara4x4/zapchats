// /frontend/js/atendimentos/ui/filtros.js
// ==========================================================
// Filtros estilo WhatsApp (Tudo / Não lidas / Grupos / No bot)
// ✅ Indexa por conversation_key canônica
// ✅ Respeita instância ativa
// ✅ Grupos: detecta por kind/is_group/JID @g.us/data-is-group
// ✅ “chat aberto” nunca some
// ✅ Sem CSS inline
// ✅ Nunca usa Number() em conversation_id composto
// ==========================================================

import { getConversas, getConversationKey, getConversationKind } from '../state/store.js';

(function initFiltrosLista() {
  if (window.__ATD_FILTROS_INIT__) return;
  window.__ATD_FILTROS_INIT__ = true;

  const LABEL_ALL = 'Tudo';
  const LABEL_UNREAD = 'Não lidas';
  const LABEL_GROUPS = 'Grupos';
  const LABEL_BOT = 'No bot';

  function idKey(v) {
    const s = String(v ?? '').trim();
    if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
    return s;
  }

  function instKey(v) {
    const s = String(v ?? '').trim();
    if (!s) return null;
    if (['null', 'undefined', 'nan', '0', 'all', '*', '-'].includes(s.toLowerCase())) return null;
    return s;
  }

  function parseConversationKey(raw) {
    const s = idKey(raw);
    if (!s) return null;

    const m = s.match(/^([cg]):(\d+):([^:]+)$/i);
    if (!m) return null;

    return {
      key: `${m[1].toLowerCase()}:${m[2]}:${m[3]}`,
      kind: m[1].toLowerCase(),
      entityId: m[2],
      instId: instKey(m[3]),
    };
  }

  function normLabel(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function mapLegacyLabel(txt) {
    const n = normLabel(txt);

    if (n === 'em atendimento') return LABEL_ALL;
    if (n === 'aguardando') return LABEL_UNREAD;
    if (n === 'nao lidas' || n === 'nao lida' || n === 'nao lidos') return LABEL_UNREAD;
    if (n === 'grupo' || n === 'grupos') return LABEL_GROUPS;
    if (n === 'no bot' || n === 'bot') return LABEL_BOT;
    if (n === 'tudo' || n === 'todas') return LABEL_ALL;

    return String(txt || '').trim();
  }

  function isGroupByTel(tel) {
    const t = String(tel || '');
    return /@g\.us$/i.test(t) || /\bgrupo\b/i.test(t);
  }

  function getOpenConversationKey() {
    const hist = document.getElementById('historico');
    const raw =
      idKey(hist?.dataset?.conversationKey) ||
      idKey(hist?.dataset?.clienteId) ||
      idKey(window.state?.clienteSel?.conversation_key) ||
      idKey(window.state?.clienteSel?.conversation_id) ||
      idKey(window.state?.clienteSel?.id) ||
      idKey(window.clienteSel?.conversation_key) ||
      idKey(window.clienteSel?.conversation_id) ||
      idKey(window.clienteSel?.id) ||
      null;

    return raw ? (getConversationKey(raw, window.state?.clienteSel || window.clienteSel || null) || raw) : null;
  }

  function normalizarStatus(conversa) {
    const raw = String(conversa?.statusatendimento ?? conversa?.status ?? '')
      .trim()
      .toLowerCase();

    const BOT = ['bot', 'automático', 'automatico', 'auto', 'automatizado'];
    if (BOT.includes(raw)) return 'bot';

    return 'no_bot';
  }

  function matchInstancia(tagInstId) {
    try {
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

  function isGroupByDOM(li) {
    try {
      if (!li) return false;

      const byFlag = String(li.dataset?.isGroup || '').trim();
      if (byFlag === '1' || byFlag === 'true') return true;

      const byKind = String(li.dataset?.kind || '').trim().toLowerCase();
      if (byKind === 'g') return true;

      const tel = String(li.dataset?.telefone || '').trim();
      if (tel && /@g\.us$/i.test(tel)) return true;

      const jid = String(li.dataset?.jid || '').trim();
      if (jid && /@g\.us$/i.test(jid)) return true;

      return false;
    } catch {
      return false;
    }
  }

  function convKeyFromLi(li) {
    const raw =
      idKey(li?.dataset?.conversationKey) ||
      idKey(li?.dataset?.id) ||
      null;

    return raw ? (getConversationKey(raw, null, li?.dataset?.instanciaId || null) || raw) : null;
  }

  function debounce(fn, wait = 80) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  function convKeyOfConversa(conversa) {
    const raw =
      conversa?.conversation_key ??
      conversa?.conversation_id ??
      conversa?.id ??
      conversa?.cliente_id ??
      conversa?.grupo_id ??
      null;

    return raw
      ? (getConversationKey(raw, conversa, conversa?.instancia_id ?? conversa?.instancia ?? null) || raw)
      : null;
  }

  function convKindOfConversa(conversa) {
    const raw =
      conversa?.conversation_key ??
      conversa?.conversation_id ??
      conversa?.id ??
      conversa?.cliente_id ??
      conversa?.grupo_id ??
      null;

    return getConversationKind(raw, conversa) || (conversa?.is_group ? 'g' : 'c');
  }

  function boot() {
    const row = document.querySelector('.wpp-header-filtros-row');
    const ul = document.getElementById('lista-clientes');

    if (!row || !ul) {
      window.__ATD_FILTROS_INIT__ = false;
      return;
    }

    function ensureButton(label, prepend = false) {
      const exists = [...row.querySelectorAll('.wpp-header-filtro')].some(
        (btn) => normLabel(btn.textContent) === normLabel(label)
      );

      if (exists) return;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wpp-header-filtro';
      button.textContent = label;

      if (prepend) row.prepend(button);
      else row.appendChild(button);
    }

    [...row.querySelectorAll('.wpp-header-filtro')].forEach((btn) => {
      const mapped = mapLegacyLabel(btn.textContent);
      if (mapped) btn.textContent = mapped;
    });

    ensureButton(LABEL_ALL, true);
    ensureButton(LABEL_UNREAD);
    ensureButton(LABEL_GROUPS);
    ensureButton(LABEL_BOT);

    const btns = [...row.querySelectorAll('.wpp-header-filtro')];
    if (!btns.length) return;

    const ALLOWED = new Set(btns.map((btn) => mapLegacyLabel(btn.textContent)));
    const byKey = new Map();

    const Filtros = (window.Filtros = window.Filtros || {});
    let current = mapLegacyLabel(sessionStorage.getItem('filtroAtend') || LABEL_ALL);

    if (!ALLOWED.has(current)) current = LABEL_ALL;
    sessionStorage.setItem('filtroAtend', current);

    function makeIndex() {
      byKey.clear();

      const conversas =
        typeof getConversas === 'function'
          ? (getConversas() || [])
          : [];

      for (const conversa of conversas) {
        const convKey = convKeyOfConversa(conversa);
        if (!convKey) continue;

        const unread = Number(conversa?.novas ?? conversa?.unread ?? 0) > 0;

        const telLike =
          conversa?.telefone ??
          conversa?.number ??
          conversa?.remoteJid ??
          conversa?.jid ??
          '';

        const kind = convKindOfConversa(conversa);
        const parsed = parseConversationKey(convKey);

        const isGroup =
          kind === 'g' ||
          Boolean(conversa?.is_group) ||
          isGroupByTel(telLike) ||
          isGroupByTel(conversa?.jid) ||
          isGroupByTel(conversa?.remoteJid);

        const statusN = normalizarStatus(conversa);
        const isBot = statusN === 'bot';

        const instId =
          conversa?.instancia_id ??
          conversa?.instancia ??
          conversa?.instance_id ??
          conversa?.inst ??
          parsed?.instId ??
          null;

        byKey.set(convKey, {
          unread,
          isGroup,
          isBot,
          instId,
          kind,
        });
      }
    }

    function shouldShow(convKey, tags, li) {
      const openKey = getOpenConversationKey();
      if (convKey && openKey && convKey === openKey) return true;
      if (!matchInstancia(tags?.instId ?? li?.dataset?.instanciaId ?? null)) return false;

      const kind = mapLegacyLabel(current);
      const normalized = normLabel(kind);

      if (normalized === normLabel(LABEL_ALL)) return true;
      if (normalized === normLabel(LABEL_UNREAD)) return !!tags?.unread;

      if (normalized === normLabel(LABEL_GROUPS)) {
        return !!(tags?.isGroup || isGroupByDOM(li));
      }

      if (normalized === normLabel(LABEL_BOT)) {
        return !!tags?.isBot;
      }

      return true;
    }

    function refilterList() {
      makeIndex();

      const items = ul.querySelectorAll('li');
      for (const li of items) {
        if (li.id === 'lista-load-more' || li.classList.contains('load-more-item')) {
          li.style.display = '';
          li.classList.remove('hidden-by-filter');
          continue;
        }

        const convKey = convKeyFromLi(li);
        const tags = convKey ? (byKey.get(convKey) || null) : null;
        const show = convKey ? shouldShow(convKey, tags || {}, li) : true;

        li.style.display = show ? '' : 'none';
        li.classList.toggle('hidden-by-filter', !show);
      }
    }

    const scheduleRefilter = debounce(refilterList, 60);

    function marcarBotaoAtivo() {
      const cur = normLabel(mapLegacyLabel(current));

      for (const btn of btns) {
        const lab = normLabel(mapLegacyLabel(btn.textContent));
        const active = lab === cur;

        btn.classList.toggle('ativo', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }

    Filtros.get = () => current;

    Filtros.set = (kind) => {
      if (!kind) return;

      let next = mapLegacyLabel(kind);
      if (!ALLOWED.has(next)) next = LABEL_ALL;

      current = String(next);
      sessionStorage.setItem('filtroAtend', current);

      marcarBotaoAtivo();
      refilterList();
    };

    Filtros.refilterList = () => refilterList();

    btns.forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();

        const kind = mapLegacyLabel(btn.textContent.trim());
        if (!kind) return;
        if (normLabel(kind) === normLabel(current)) return;

        Filtros.set(kind);
      });
    });

    const observer = new MutationObserver(() => {
      scheduleRefilter();
    });

    observer.observe(ul, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'data-status',
        'data-instancia-id',
        'class',
        'data-id',
        'data-conversation-key',
        'data-kind',
        'data-is-group',
        'data-telefone',
        'data-jid',
      ],
    });

    document.addEventListener('ws:conv_status', scheduleRefilter);
    document.addEventListener('ws:reload_clientes', scheduleRefilter);
    document.addEventListener('inst:change', scheduleRefilter);

    marcarBotaoAtivo();
    refilterList();

    try {
      window.Filtros = Filtros;
    } catch {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();