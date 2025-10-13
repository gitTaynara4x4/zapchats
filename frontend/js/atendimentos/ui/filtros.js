// /frontend/js/atendimentos/ui/filtros.js
import { getConversas } from '../state/store.js'; // ajuste para '../../store.js' se necessário

(function FiltrosLista(){
  const row = document.querySelector('.wpp-header-filtros-row');
  const ul  = document.getElementById('lista-clientes');
  if (!row || !ul) return;

  const btns = [...row.querySelectorAll('.wpp-header-filtro')];
  if (!btns.length) return;

  // índice a partir do estado (store)
  function makeIndex(){
    const byId = new Map();
    for (const c of (getConversas?.() || [])){
      const id = Number(c.conversation_id ?? c.cliente_id ?? c.id ?? 0) || 0;
      const aguardando = Number(c.novas || 0) > 0;
      const isGroup    = !!c.is_group || /@g\.us$/i.test(String(c.telefone || ''));
      const status     = String(c.statusatendimento || c.status || '').toLowerCase();
      const botNow     = ['bot','no_bot','automatico','automático'].includes(status);
      const emAtend    = !aguardando && !botNow && !isGroup;
      byId.set(id, { aguardando, isGroup, botNow, emAtend });
    }
    return byId;
  }

  function applyFilter(kind){
    // visual: ativo
    btns.forEach(b => b.classList.toggle('ativo', b.textContent.trim() === kind));

    const idx = makeIndex();

    // aplica no DOM (com fallback via data-*)
    ul.querySelectorAll('li.chat-item').forEach(li => {
      const id  = Number(li.dataset.id || 0) || 0;

      const fallbackAguard = Number(li.querySelector('.badge, .unread-badge')?.textContent || 0) > 0;
      const fallbackGroup  = li.dataset.isGroup === '1' || /@g\.us$/i.test(String(li.dataset.tel || ''));
      const fallbackBot    = ['bot','no_bot','automatico','automático'].includes((li.dataset.status||'').toLowerCase());

      const tag = idx.get(id) || {
        aguardando: fallbackAguard,
        isGroup: fallbackGroup,
        botNow: fallbackBot,
        emAtend: !(fallbackAguard || fallbackGroup || fallbackBot),
      };

      let show = true;
      if (kind === 'Aguardando') show = tag.aguardando;
      else if (kind === 'Grupos') show = tag.isGroup;
      else if (kind === 'No bot') show = tag.botNow;
      else show = tag.emAtend; // 'Em atendimento'

      li.style.display = show ? '' : 'none';
    });
  }

  // clique nos botões
  btns.forEach(btn => {
    btn.addEventListener('click', () => applyFilter(btn.textContent.trim()));
  });

  // estado inicial
  applyFilter('Em atendimento');

  // reaplicar quando a lista mudar (re-render)
  const mo = new MutationObserver(() => {
    const active = (btns.find(b => b.classList.contains('ativo')) || btns[0]).textContent.trim();
    applyFilter(active);
  });
  mo.observe(ul, { childList: true, subtree: true });
})();
