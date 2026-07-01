// /frontend/js/atendimentos/ui/importar-historico.js
// Importação manual de histórico por WhatsApp/instância.
// Leve: não usa interval, não observa classes, não recarrega tudo em loop.
(function () {
  'use strict';

  if (window.__ZC_IMPORTAR_HISTORICO_LOADED__) return;
  window.__ZC_IMPORTAR_HISTORICO_LOADED__ = true;

  const EMPRESA_ID = Number(localStorage.getItem('empresa_id') || 0);
  const OPTIONS = {
    '24h': 'Últimas 24 horas',
    '7d': 'Últimos 7 dias',
    '30d': 'Últimos 30 dias'
  };

  let modal = null;
  let modalState = {
    instanciaId: '',
    label: ''
  };

  function clean(v) {
    return String(v ?? '').replace(/\s+/g, ' ').trim();
  }

  function toast(msg, type) {
    const text = clean(msg);
    if (!text) return;

    try {
      if (typeof window.showToast === 'function') {
        window.showToast(text, type || 'info');
        return;
      }
    } catch {}

    try { console.log('[ZapsChat][Histórico]', text); } catch {}
  }

  function getInstancesList() {
    return (
      window.ZC_INSTANCIAS ||
      window.INSTANCIAS ||
      window.state?.instancias ||
      []
    );
  }

  function getActiveSourceButton() {
    const source = document.getElementById('inst-switch');
    if (!source) return null;

    const buttons = Array.from(source.querySelectorAll('button, .inst-pill, [role="button"]'));
    return (
      buttons.find((btn) =>
        btn.classList.contains('is-active') ||
        btn.classList.contains('ativo') ||
        btn.classList.contains('active') ||
        btn.getAttribute('aria-pressed') === 'true' ||
        btn.getAttribute('aria-selected') === 'true'
      ) || null
    );
  }

  function getSelectedInstance() {
    const activeVal = clean(
      window.getInstanciaAtiva?.() ||
      window.INSTANCIA_ATIVA ||
      localStorage.getItem(`instAtiva:${EMPRESA_ID}`) ||
      ''
    );

    if (!activeVal) return null;

    const list = getInstancesList();
    const found = (Array.isArray(list) ? list : []).find((i) => {
      const vals = [
        i?.instancia_id,
        i?.id,
        i?.instance_id,
        i?.whatsapp_id,
        i?.instance_name,
        i?.instancia
      ].map(clean).filter(Boolean);
      return vals.includes(activeVal);
    });

    const activeBtn = getActiveSourceButton();
    const label =
      clean(found?.apelido) ||
      clean(found?.nome_exibicao) ||
      clean(found?.display_name) ||
      clean(found?.nome) ||
      clean(found?.name) ||
      clean(activeBtn?.dataset?.label) ||
      clean(activeBtn?.textContent) ||
      clean(document.getElementById('zc-inst-current-label')?.textContent) ||
      activeVal;

    const id = Number(found?.instancia_id ?? found?.id ?? found?.instance_id ?? activeVal);
    if (!Number.isFinite(id) || id <= 0) return null;

    return {
      id,
      value: activeVal,
      label: label || `WhatsApp ${id}`,
      raw: found || null
    };
  }

  function ensureModal() {
    if (modal && document.body.contains(modal)) return modal;

    modal = document.createElement('div');
    modal.className = 'zc-history-modal-backdrop hidden';
    modal.innerHTML = `
      <div class="zc-history-modal" role="dialog" aria-modal="true" aria-labelledby="zc-history-modal-title">
        <button type="button" class="zc-history-close" data-zc-history-close aria-label="Fechar">
          <i class="fa fa-times" aria-hidden="true"></i>
        </button>

        <div class="zc-history-head">
          <div class="zc-history-icon"><i class="fa fa-clock-rotate-left" aria-hidden="true"></i></div>
          <div>
            <h3 id="zc-history-modal-title">Importar histórico</h3>
            <p id="zc-history-instance-label">WhatsApp selecionado</p>
          </div>
        </div>

        <label class="zc-history-label" for="zc-history-period">Período</label>
        <select id="zc-history-period" class="zc-history-select">
          <option value="24h">Últimas 24 horas — recomendado</option>
          <option value="7d">Últimos 7 dias — pode demorar</option>
          <option value="30d">Últimos 30 dias — avançado</option>
        </select>

        <div class="zc-history-tip">
          <i class="fa fa-circle-info" aria-hidden="true"></i>
          <span>Importa somente este WhatsApp. O sistema continua recebendo mensagens novas enquanto importa.</span>
        </div>

        <div class="zc-history-warning">
          <b>Atenção:</b> 7 ou 30 dias pode demorar dependendo do volume. Mídias antigas continuam desativadas para não pesar.
        </div>

        <div class="zc-history-actions">
          <button type="button" class="zc-history-btn zc-history-btn-secondary" data-zc-history-close>Cancelar</button>
          <button type="button" class="zc-history-btn zc-history-btn-primary" id="zc-history-submit">
            Importar agora
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (ev) => {
      if (ev.target === modal || ev.target.closest('[data-zc-history-close]')) {
        closeModal();
      }
    });

    modal.querySelector('#zc-history-submit')?.addEventListener('click', submitImport);

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
        closeModal();
      }
    });

    return modal;
  }

  function openModal() {
    const inst = getSelectedInstance();

    if (!inst) {
      toast('Selecione um WhatsApp específico antes de importar histórico.', 'warning');
      return;
    }

    modalState = {
      instanciaId: String(inst.id),
      label: inst.label
    };

    const el = ensureModal();
    const label = el.querySelector('#zc-history-instance-label');
    if (label) label.textContent = inst.label;

    const select = el.querySelector('#zc-history-period');
    if (select) select.value = '24h';

    el.classList.remove('hidden');
    setTimeout(() => select?.focus?.(), 30);
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.add('hidden');
  }

  async function submitImport() {
    const el = ensureModal();
    const btn = el.querySelector('#zc-history-submit');
    const select = el.querySelector('#zc-history-period');
    const periodo = clean(select?.value || '24h');

    if (!modalState.instanciaId) {
      toast('Instância não identificada.', 'warning');
      return;
    }

    const labelPeriodo = OPTIONS[periodo] || periodo;

    try {
      btn.disabled = true;
      btn.textContent = 'Solicitando...';

      const r = await fetch(`/api/onboarding/empresas/instancias/${encodeURIComponent(modalState.instanciaId)}/historico/importar`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          empresa_id: EMPRESA_ID,
          historico_restaurar: periodo
        })
      });

      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      const js = ct.includes('application/json') ? await r.json() : {};

      if (!r.ok || js?.ok === false) {
        throw new Error(js?.detail || js?.message || `HTTP ${r.status}`);
      }

      closeModal();
      toast(`Importação solicitada: ${labelPeriodo}. Aguarde alguns minutos.`, 'success');

      try {
        window.dispatchEvent(new CustomEvent('sync:start', {
          detail: { text: `Importando histórico de ${modalState.label}...` }
        }));
      } catch {}

      // Safety: se a Evolution não mandar evento de fim, não deixa overlay preso.
      setTimeout(() => {
        try { window.dispatchEvent(new CustomEvent('sync:done')); } catch {}
      }, 18000);

    } catch (err) {
      console.error('[ZapsChat][Histórico] falha ao importar', err);
      toast(err?.message || 'Falha ao solicitar importação.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Importar agora';
      }
    }
  }

  function ensureMenuAction() {
    const menu = document.getElementById('zc-inst-menu');
    if (!menu) return;
    if (menu.querySelector('[data-zc-history-import-option]')) return;

    const divider = document.createElement('div');
    divider.className = 'zc-inst-option-divider';
    divider.dataset.zcHistoryImportOption = '1';

    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'zc-inst-option zc-inst-option-history';
    opt.dataset.zcHistoryImportOption = '1';
    opt.innerHTML = `
      <span class="zc-inst-option-label">
        <i class="fa fa-clock-rotate-left" aria-hidden="true"></i>
        Importar histórico
      </span>
    `;

    opt.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try { document.getElementById('zc-inst-dropdown')?.classList.remove('is-open'); } catch {}
      openModal();
    });

    menu.appendChild(divider);
    menu.appendChild(opt);
  }

  function boot() {
    ensureModal();
    ensureMenuAction();

    const menu = document.getElementById('zc-inst-menu');
    if (menu && !menu.__ZC_HISTORY_OBSERVER__) {
      menu.__ZC_HISTORY_OBSERVER__ = true;
      const mo = new MutationObserver(() => {
        requestAnimationFrame(ensureMenuAction);
      });
      mo.observe(menu, { childList: true });
    }
  }

  document.addEventListener('inst:list', () => requestAnimationFrame(boot));
  document.addEventListener('inst:change', () => requestAnimationFrame(boot));
  window.addEventListener('zc:atendimentos-ready', () => setTimeout(boot, 80));
  window.addEventListener('load', () => setTimeout(boot, 120));

  document.addEventListener('ws:history_sync_done', () => {
    toast('Histórico importado. Atualizando lista...', 'success');
    try { window.carregarClientes?.({ force: true, reason: 'history-import-done' }); } catch {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    setTimeout(boot, 0);
  }
})();
