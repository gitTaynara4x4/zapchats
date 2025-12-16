// /frontend/js/atendimentos/ui/filtros.js
import { getConversas } from '../state/store.js';

(function FiltrosLista() {
  const row = document.querySelector('.wpp-header-filtros-row');
  const ul  = document.getElementById('lista-clientes');
  if (!row || !ul) return;

  // ----------------- helpers texto -----------------
  function normLabel(s){
    return String(s || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  const LABEL_ALL    = 'Tudo';
  const LABEL_UNREAD = 'Não lidas';
  const LABEL_GROUPS = 'Grupos';
  const LABEL_BOT    = 'No bot';

  function mapLegacyLabel(txt){
    const n = normLabel(txt);
    if (n === 'em atendimento') return LABEL_ALL;
    if (n === 'aguardando')     return LABEL_UNREAD;
    if (n === 'nao lidas' || n === 'nao lida' || n === 'nao lidos') return LABEL_UNREAD;
    if (n === 'grupo' || n === 'grupos') return LABEL_GROUPS;
    if (n === 'no bot' || n === 'bot') return LABEL_BOT;
    if (n === 'tudo' || n === 'todas') return LABEL_ALL;
    return String(txt || '').trim();
  }

  // ----------------- garante botões estilo WPP -----------------
  function ensureButton(label, prepend = false){
    const exists = [...row.querySelectorAll('.wpp-header-filtro')].some(b => normLabel(b.textContent) === normLabel(label));
    if (exists) return;

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wpp-header-filtro';
    b.textContent = label;

    if (prepend) row.prepend(b);
    else row.appendChild(b);
  }

  // Renomeia botões legacy existentes
  [...row.querySelectorAll('.wpp-header-filtro')].forEach(btn => {
    const mapped = mapLegacyLabel(btn.textContent);
    if (mapped) btn.textContent = mapped;
  });

  // Garante os chips principais (estilo WhatsApp)
  ensureButton(LABEL_ALL, true);
  ensureButton(LABEL_UNREAD, false);
  ensureButton(LABEL_GROUPS, false);
  // Mantém “No bot” (se você usa), mas se não quiser é só apagar essa linha:
  ensureButton(LABEL_BOT, false);

  // pega novamente depois de criar/renomear
  const btns = [...row.querySelectorAll('.wpp-header-filtro')];
  if (!btns.length) return;

  const ALLOWED = new Set(btns.map(b => mapLegacyLabel(b.textContent)));

  // ----------------- estado do filtro (global p/ outros módulos chamarem) -----------------
  const Filtros = (window.Filtros = window.Filtros || {});
  let current = mapLegacyLabel(sessionStorage.getItem('filtroAtend') || LABEL_ALL);

  if (!ALLOWED.has(current)) current = LABEL_ALL;
  sessionStorage.setItem('filtroAtend', current);

  Filtros.get = () => current;
  Filtros.set = (kind) => {
    if (!kind) return;
    kind = mapLegacyLabel(kind);
    if (!ALLOWED.has(kind)) kind = LABEL_ALL;

    current = String(kind);
    sessionStorage.setItem('filtroAtend', current);
    marcarBotaoAtivo();
    refilterList();
  };
  Filtros.refilterList = () => refilterList();

  // ----------------- index/tags -----------------
  const byId = new Map(); // id -> tags

  function isGroupByTel(tel) {
    const t = String(tel || '');
    return /@g\.us$/i.test(t) || /\bgrupo\b/i.test(t);
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

      // sem instância ativa = mostra tudo
      if (!ativa) return true;

      // conversa sem instância (ou não veio) = não bloqueia
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

    const BOT = ['bot', 'automático', 'automatico', 'auto', 'automatizado'];
    if (BOT.includes(raw)) return 'bot';
    return 'no_bot';
  }

  function makeIndex() {
    byId.clear();
    const convs = typeof getConversas === 'function' ? (getConversas() || []) : [];

    for (const c of convs) {
      const id = Number(c.conversation_id ?? c.cliente_id ?? c.id ?? 0) || 0;
      if (!id) continue;

      const unread  = Number(c.novas ?? c.unread ?? 0) > 0;
      const grupo   = Boolean(c.is_group) || isGroupByTel(c.telefone);
      const statusN = normalizarStatus(c);
      const isBot   = statusN === 'bot';

      const instId = c.instancia_id ?? c.instancia ?? c.instance_id ?? c.inst ?? null;

      byId.set(id, {
        unread,
        isGroup: grupo,
        isBot,
        instId,
      });
    }
  }

  // ----------------- regra de exibição -----------------
  function shouldShow(id, tags) {
    // chat aberto nunca some
    if (id && id === openClienteId()) return true;

    // respeita instância ativa (se houver)
    if (!matchInstancia(tags?.instId ?? null)) return false;

    const kind = mapLegacyLabel(current);
    const k = normLabel(kind);

    // ✅ WPP: "Tudo" = não filtra nada
    if (k === normLabel(LABEL_ALL)) return true;

    if (k === normLabel(LABEL_UNREAD)) return !!tags?.unread;
    if (k === normLabel(LABEL_GROUPS)) return !!tags?.isGroup;
    if (k === normLabel(LABEL_BOT))    return !!tags?.isBot;

    // fallback
    return true;
  }

  function refilterList() {
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
    const cur = normLabel(mapLegacyLabel(current));
    for (const b of btns) {
      const lab = normLabel(mapLegacyLabel(b.textContent));
      const on = lab === cur;
      b.classList.toggle('ativo', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // ----------------- eventos da UI -----------------
  btns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const kind = mapLegacyLabel(btn.textContent.trim());
      if (!kind) return;
      if (normLabel(kind) === normLabel(current)) return;
      Filtros.set(kind);
    });
  });

  // ----------------- observar mudanças na UL -----------------
  const mo = new MutationObserver(() => refilterList());
  mo.observe(ul, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-status', 'data-instancia-id', 'class', 'data-id'],
  });

  // ----------------- reagir a eventos globais -----------------
  document.addEventListener('ws:conv_status', () => refilterList());
  document.addEventListener('ws:reload_clientes', () => refilterList());
  document.addEventListener('inst:change', () => refilterList());

  // ----------------- boot -----------------
  marcarBotaoAtivo();
  refilterList();

  try { window.Filtros = Filtros; } catch {}
})();
