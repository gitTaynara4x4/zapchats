// frontend/js/pages/colaboradores/ui/selects.js
// Select customizado da página Colaboradores.

export function initColaboradoresSelects(){
  'use strict';

  if (window.__zcColaboradoresSelectsLoaded) return;
  window.__zcColaboradoresSelectsLoaded = true;

  if (document.body.dataset.page !== 'colaboradores') return;

  function getSurfaceColor(el){
    let n = el;

    while (n && n !== document.documentElement){
      const bg = getComputedStyle(n).backgroundColor;

      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
        return bg;
      }

      n = n.parentElement;
    }

    return getComputedStyle(document.body).backgroundColor;
  }

  function enhanceSelect(sel){
    if (!sel || sel.dataset.enhanced) return;

    sel.dataset.enhanced = '1';
    sel.classList.add('select--replaced');

    const wrap = document.createElement('div');
    wrap.className = 'x-select';

    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    wrap.style.setProperty('--x-surface', getSurfaceColor(wrap));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'x-sel-btn';
    btn.setAttribute('aria-haspopup','listbox');
    btn.setAttribute('aria-expanded','false');

    wrap.appendChild(btn);

    const list = document.createElement('ul');
    list.className = 'x-sel-list';
    list.setAttribute('role','listbox');

    wrap.appendChild(list);

    function render(){
      btn.textContent = sel.options[sel.selectedIndex]?.text || 'Selecione…';
      list.innerHTML = '';

      Array.from(sel.options).forEach(opt => {
        const li = document.createElement('li');
        li.className = 'x-sel-opt';
        li.setAttribute('role','option');
        li.dataset.value = opt.value;
        li.textContent = opt.text;

        if (opt.selected) {
          li.setAttribute('aria-selected','true');
        }

        li.addEventListener('click', () => {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles:true } ));
          btn.textContent = opt.text;
          close();
        });

        list.appendChild(li);
      });
    }

    function open(){
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded','true');

      const cur = list.querySelector('[aria-selected="true"]');
      if (cur) cur.scrollIntoView({ block:'nearest' });

      window.addEventListener('click', onDocClick, { once:true });
    }

    function close(){
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded','false');
    }

    function onDocClick(e){
      if (!wrap.contains(e.target)) close();
    }

    btn.addEventListener('click', () => {
      if (wrap.classList.contains('open')) close();
      else open();
    });

    sel.addEventListener('change', render);

    btn.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      } else if (e.key === 'Escape') {
        close();
      }
    });

    const syncDisabled = () => {
      btn.disabled = sel.disabled;
    };

    const mo = new MutationObserver(syncDisabled);
    mo.observe(sel, { attributes:true, attributeFilter:['disabled'] });

    syncDisabled();
    render();
  }

  function scan(){
    document
      .querySelectorAll('#modal-perfil .select:not([data-enhanced]), .details-grid .select:not([data-enhanced])')
      .forEach(enhanceSelect);
  }

  scan();

  const rootObs = new MutationObserver(scan);
  rootObs.observe(document.body, { childList:true, subtree:true });
}