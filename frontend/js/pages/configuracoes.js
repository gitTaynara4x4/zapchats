(function ConfiguracoesPage() {
  'use strict';

  const THEME_KEY = 'zapschat_theme';

  function showToast(message, isError = false, timeout = 3500) {
    const el = document.getElementById('zapchat-toast');
    const icon = el?.querySelector('.toast-icon');
    const text = el?.querySelector('.toast-text');

    if (!el || !icon || !text) return;

    text.textContent = message || '';
    
    // Reseta classes do toast
    el.classList.remove('is-error', 'is-success', 'show');
    icon.className = 'toast-icon fa-solid';

    if (isError) {
      el.classList.add('is-error');
      icon.classList.add('fa-circle-exclamation');
    } else {
      el.classList.add('is-success');
      icon.classList.add('fa-circle-check');
    }

    // Força reflow para garantir a transição de slideUp
    void el.offsetWidth;
    
    // Aplica animação de exibição
    requestAnimationFrame(() => el.classList.add('show'));

    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      el.classList.remove('show');
    }, timeout);
  }

  function getSavedTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || 'dark';
    } catch (_) {
      return 'dark';
    }
  }

  function applyTheme(theme) {
    const finalTheme = theme === 'light' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', finalTheme);
    document.body.setAttribute('data-theme', finalTheme);

    if (finalTheme === 'dark') {
      document.documentElement.classList.add('dark');
      document.body.classList.add('dark-theme');
    } else {
      document.documentElement.classList.remove('dark');
      document.body.classList.remove('dark-theme');
    }

    const select = document.getElementById('select-tema');
    if (select) select.value = finalTheme;

    try {
      localStorage.setItem(THEME_KEY, finalTheme);
    } catch (_) {}

    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.shadowRoot) {
      try {
        sidebar.shadowRoot.host?.setAttribute?.('data-theme', finalTheme);
      } catch (_) {}
    }
  }

  function bindTheme() {
    const select = document.getElementById('select-tema');
    if (!select) return;

    applyTheme(getSavedTheme());

    select.addEventListener('change', (e) => {
      applyTheme(e.target.value);
      showToast('Tema atualizado com sucesso.');
    });
  }

  function bindBugForm() {
    const form = document.getElementById('form-bug');
    const input = document.getElementById('bug-descricao');
    const btn = document.getElementById('btn-enviar-bug');

    if (!form || !input || !btn) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const descricao = (input.value || '').trim();
      if (!descricao) {
        showToast('Descreva o problema antes de enviar.', true);
        input.focus();
        return;
      }

      if (btn.disabled) return;

      const originalHtml = btn.innerHTML;
      const originalWidth = btn.offsetWidth;

      btn.disabled = true;
      btn.style.width = `${originalWidth}px`;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Enviando...</span>';

      try {
        // Simulando delay da requisição (Mantenha ou integre com sua API)
        await new Promise((resolve) => setTimeout(resolve, 1200));
        form.reset();
        showToast('Relato enviado com sucesso. Obrigado!');
      } catch (error) {
        console.error('Erro ao enviar relato:', error);
        showToast(error?.message || 'Ocorreu um erro ao enviar o relato.', true);
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
        btn.style.width = '';
      }
    });
  }

  function init() {
    bindTheme();
    bindBugForm();
  }

  const run = () => init();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();