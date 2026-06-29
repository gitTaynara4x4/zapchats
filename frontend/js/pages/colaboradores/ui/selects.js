// frontend/js/pages/colaboradores/ui/selects.js
// Select customizado da página Colaboradores.
// Corrige o <select> nativo abrindo por cima do modal e deixando a tela bagunçada.

export function initColaboradoresSelects(){
  'use strict';

  if (window.__zcColaboradoresSelectsLoaded) return;
  window.__zcColaboradoresSelectsLoaded = true;

  if (document.body.dataset.page !== 'colaboradores') return;

  const CLOSE_EVENTS = ['pointerdown', 'keydown'];

  function isVisible(el){
    return !!(el && el.offsetParent !== null);
  }

  function getText(sel){
    const opt = sel?.options?.[sel.selectedIndex];
    return String(opt?.text || 'Selecione…').trim() || 'Selecione…';
  }

  function setOpen(wrap, open){
    if (!wrap) return;

    const btn = wrap.querySelector('.x-sel-btn');
    const list = wrap.querySelector('.x-sel-list');

    wrap.classList.toggle('open', !!open);
    btn?.setAttribute('aria-expanded', open ? 'true' : 'false');

    if (!open) return;

    // Abre para cima quando estiver perto do rodapé do modal.
    try {
      const rect = wrap.getBoundingClientRect();
      const modalBody = wrap.closest('.modal-body');
      const area = modalBody?.getBoundingClientRect();
      const bottomLimit = area?.bottom || window.innerHeight;
      const spaceBelow = bottomLimit - rect.bottom;
      wrap.classList.toggle('drop-up', spaceBelow < 210 && rect.top > 240);
    } catch {}

    const current = list?.querySelector('[aria-selected="true"]');
    current?.scrollIntoView({ block:'nearest' });
  }

  function closeAll(except){
    document.querySelectorAll('.x-select.open').forEach(wrap => {
      if (except && wrap === except) return;
      setOpen(wrap, false);
    });
  }

  function syncOne(sel){
    const wrap = sel.closest('.x-select');
    if (!wrap) return;

    const btn = wrap.querySelector('.x-sel-btn');
    const list = wrap.querySelector('.x-sel-list');
    if (!btn || !list) return;

    btn.textContent = getText(sel);
    btn.disabled = !!sel.disabled;

    const currentValue = String(sel.value || '');
    list.innerHTML = '';

    Array.from(sel.options || []).forEach((opt, idx) => {
      const value = String(opt.value || '');
      const selected = value === currentValue;

      const li = document.createElement('li');
      li.className = 'x-sel-opt';
      li.type = 'button';
      li.setAttribute('role','option');
      li.setAttribute('tabindex','-1');
      li.dataset.value = value;
      li.dataset.index = String(idx);
      li.textContent = opt.text || '—';

      if (selected) li.setAttribute('aria-selected','true');

      li.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();

        sel.value = value;
        sel.dispatchEvent(new Event('change', { bubbles:true }));
        syncOne(sel);
        setOpen(wrap, false);
        btn.focus({ preventScroll:true });
      });

      list.appendChild(li);
    });
  }

  function enhanceSelect(sel){
    if (!sel || sel.dataset.enhanced === '1') return;

    // Só troca selects do modal. O filtro da tela continua nativo e leve.
    if (!sel.closest('#modal-perfil')) return;

    sel.dataset.enhanced = '1';
    sel.classList.add('select--replaced');
    sel.setAttribute('tabindex','-1');
    sel.setAttribute('aria-hidden','true');

    const wrap = document.createElement('div');
    wrap.className = 'x-select';

    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'x-sel-btn';
    btn.setAttribute('aria-haspopup','listbox');
    btn.setAttribute('aria-expanded','false');

    const list = document.createElement('ul');
    list.className = 'x-sel-list';
    list.setAttribute('role','listbox');

    wrap.appendChild(btn);
    wrap.appendChild(list);

    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();

      const willOpen = !wrap.classList.contains('open');
      closeAll(wrap);
      syncOne(sel);
      setOpen(wrap, willOpen);
    });

    btn.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        closeAll(wrap);
        syncOne(sel);
        setOpen(wrap, true);
        list.querySelector('[aria-selected="true"], .x-sel-opt')?.focus({ preventScroll:true });
        return;
      }

      if (ev.key === 'Escape') {
        ev.preventDefault();
        setOpen(wrap, false);
      }
    });

    list.addEventListener('keydown', ev => {
      const opts = Array.from(list.querySelectorAll('.x-sel-opt'));
      const current = document.activeElement;
      const idx = Math.max(0, opts.indexOf(current));

      if (ev.key === 'Escape') {
        ev.preventDefault();
        setOpen(wrap, false);
        btn.focus({ preventScroll:true });
        return;
      }

      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const dir = ev.key === 'ArrowDown' ? 1 : -1;
        const next = opts[(idx + dir + opts.length) % opts.length];
        next?.focus({ preventScroll:true });
        return;
      }

      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        current?.click?.();
      }
    });

    sel.addEventListener('change', () => syncOne(sel));

    const optObs = new MutationObserver(() => syncOne(sel));
    optObs.observe(sel, { childList:true, subtree:true, attributes:true, attributeFilter:['disabled', 'selected', 'value'] });

    syncOne(sel);
  }

  function scan(){
    document
      .querySelectorAll('#modal-perfil select.select:not([data-enhanced])')
      .forEach(enhanceSelect);
  }

  function onGlobalEvent(ev){
    if (ev.type === 'keydown') {
      if (ev.key === 'Escape') closeAll();
      return;
    }

    const target = ev.target;
    if (target?.closest?.('.x-select')) return;
    closeAll();
  }

  CLOSE_EVENTS.forEach(name => {
    document.addEventListener(name, onGlobalEvent, true);
  });

  scan();

  const rootObs = new MutationObserver(scan);
  rootObs.observe(document.body, { childList:true, subtree:true });

  window.addEventListener('resize', () => closeAll(), { passive:true });
  window.addEventListener('scroll', () => closeAll(), true);
}
