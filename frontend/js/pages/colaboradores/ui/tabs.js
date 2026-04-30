// frontend/js/pages/colaboradores/ui/tabs.js
// Abas do modal Colaboradores - versão leve, sem loop de MutationObserver.

export function initColaboradoresTabs(){
  'use strict';

  if (window.__zcColaboradoresTabsLoaded) return;
  window.__zcColaboradoresTabsLoaded = true;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  let rafSync = 0;
  let lastPreview = {
    name: '',
    role: '',
    company: '',
    dept: ''
  };

  function getModal(){
    return $('#modal-perfil');
  }

  function setText(el, value){
    if (!el) return;
    const next = String(value || '');
    if (el.textContent !== next) {
      el.textContent = next;
    }
  }

  function activateTab(name){
    const modal = getModal();
    if (!modal) return;

    const wanted = name || 'perfil';

    $$('.colab-tab', modal).forEach(btn => {
      const active = btn.dataset.tab === wanted;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.tabIndex = active ? 0 : -1;
    });

    $$('.colab-panel', modal).forEach(panel => {
      const active = panel.dataset.panel === wanted;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    });
  }

  function textValue(sel, fallback = ''){
    const el = $(sel);
    const text = String(el?.textContent || '').trim();
    if (!text || text === '—') return fallback;
    return text;
  }

  function inputValue(sel, fallback = ''){
    const el = $(sel);
    const value = String(el?.value || '').trim();
    return value || fallback;
  }

  function selectedText(sel, fallback = ''){
    const el = $(sel);
    if (!el) return fallback;

    const opt = el.options?.[el.selectedIndex];
    const text = String(opt?.text || '').trim();

    if (!text || text === 'Selecione…' || text === 'Selecione...') {
      return fallback;
    }

    return text;
  }

  function syncSidePreviewNow(){
    const modal = getModal();
    if (!modal) return;

    const next = {
      name: inputValue('#e-nome', textValue('#v-nome', 'Novo colaborador')),
      role: inputValue('#e-cargo', textValue('#v-cargo', '')) || inputValue('#e-email', textValue('#v-email', '')),
      company: textValue('#v-empresa', 'Empresa atual'),
      dept: selectedText('#e-setor', textValue('#v-depto', 'Não definido'))
    };

    if (!next.name) next.name = 'Novo colaborador';
    if (!next.role) next.role = 'Configure perfil, acesso e permissões';
    if (!next.company) next.company = 'Empresa atual';
    if (!next.dept) next.dept = 'Não definido';

    if (
      next.name === lastPreview.name &&
      next.role === lastPreview.role &&
      next.company === lastPreview.company &&
      next.dept === lastPreview.dept
    ) {
      return;
    }

    lastPreview = next;

    setText($('#side-preview-name'), next.name);
    setText($('#side-preview-role'), next.role);
    setText($('#side-preview-company'), next.company);
    setText($('#side-preview-dept'), next.dept);
  }

  function scheduleSyncSidePreview(){
    if (rafSync) return;

    rafSync = requestAnimationFrame(() => {
      rafSync = 0;
      syncSidePreviewNow();
    });
  }

  function bind(){
    const modal = getModal();
    if (!modal || modal.dataset.tabsBound === '1') return;

    modal.dataset.tabsBound = '1';

    modal.addEventListener('click', ev => {
      const btn = ev.target.closest('.colab-tab');
      if (!btn) return;

      ev.preventDefault();
      activateTab(btn.dataset.tab || 'perfil');
      scheduleSyncSidePreview();
    });

    modal.addEventListener('input', ev => {
      if (
        ev.target.matches('#e-nome') ||
        ev.target.matches('#e-cargo') ||
        ev.target.matches('#e-email')
      ) {
        scheduleSyncSidePreview();
      }
    });

    modal.addEventListener('change', ev => {
      if (ev.target.matches('#e-setor')) {
        scheduleSyncSidePreview();
      }
    });

    document.addEventListener('keydown', ev => {
      if (modal.getAttribute('aria-hidden') === 'true') return;
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;

      const tabs = $$('.colab-tab', modal);
      if (!tabs.length) return;

      const current = Math.max(0, tabs.findIndex(t => t.classList.contains('active')));
      const dir = ev.key === 'ArrowRight' ? 1 : -1;
      const nextIndex = (current + dir + tabs.length) % tabs.length;
      const next = tabs[nextIndex];

      if (next) {
        ev.preventDefault();
        next.focus();
        activateTab(next.dataset.tab || 'perfil');
        scheduleSyncSidePreview();
      }
    });

    // Observer leve: observa só abrir/fechar modal.
    // NÃO observa subtree nem characterData para não travar a tela.
    const observer = new MutationObserver(() => {
      if (modal.getAttribute('aria-hidden') === 'false') {
        activateTab('perfil');
        scheduleSyncSidePreview();
        setTimeout(scheduleSyncSidePreview, 80);
      }
    });

    observer.observe(modal, {
      attributes: true,
      attributeFilter: ['aria-hidden']
    });
  }

  bind();
  activateTab('perfil');
  scheduleSyncSidePreview();
}