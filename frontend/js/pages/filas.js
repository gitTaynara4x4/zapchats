// /frontend/js/pages/filas.js
// Filas – ZapsChat
// Visual alinhado com Chatbot + modal "Como funciona" em slides
// API real:
// GET    /api/filas
// POST   /api/filas
// PUT    /api/filas/{id}
// DELETE /api/filas/{id}

(function FilasPage() {
  'use strict';

  const PAGE_VERSION = 'zc-filas-chatbot-visual-v2';

  if (window.__ZC_FILAS_PAGE_VERSION__ === PAGE_VERSION) return;
  window.__ZC_FILAS_PAGE_VERSION__ = PAGE_VERSION;

  const state = {
    filas: [],
    filtradas: [],
    loading: false,
    editingId: null,
    helpSlide: 0,
    helpTotal: 4,
    context: { chatbot_ativo: false, instances: [], departments: [] },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const els = {
    totalFilas: $('#totalFilas'),

    buscaFila: $('#buscaFila'),
    filtroStatus: $('#filtroStatus'),
    filtroPrioridade: $('#filtroPrioridade'),

    btnRestaurarFilas: $('#btnRestaurarFilas'),
    btnNovaFila: $('#btnNovaFila'),
    btnNovaFilaEmpty: $('#btnNovaFilaEmpty'),
    btnComoFuncionaFilas: $('#btnComoFuncionaFilas'),
    chatbotFilasGate: $('#chatbotFilasGate'),
    queueContent: $$('.queue-requires-chatbot'),

    metricTotal: $('#metricTotal'),
    metricAtivas: $('#metricAtivas'),
    metricAlta: $('#metricAlta'),
    metricSla: $('#metricSla'),

    tabelaFilas: $('#tabelaFilas'),
    emptyFilas: $('#emptyFilas'),

    modalFila: $('#modalFila'),
    modalFilaTitulo: $('#modalFilaTitulo'),
    btnFecharModalFila: $('#btnFecharModalFila'),
    btnCancelarFila: $('#btnCancelarFila'),
    btnExcluirFila: $('#btnExcluirFila'),

    formFila: $('#formFila'),
    filaId: $('#filaId'),
    filaNome: $('#filaNome'),
    filaPrioridade: $('#filaPrioridade'),
    filaSla: $('#filaSla'),
    filaCor: $('#filaCor'),
    filaDescricao: $('#filaDescricao'),
    filaMensagem: $('#filaMensagem'),
    filaAtiva: $('#filaAtiva'),
    swFilaAtiva: $('#swFilaAtiva'),
    filaRetornoAtivo: $('#filaRetornoAtivo'),
    swFilaRetorno: $('#swFilaRetorno'),
    filaRetornoCustomWrap: $('#filaRetornoCustomWrap'),
    filaRetornoCustom: $('#filaRetornoCustom'),
    filaPreviewText: $('#filaPreviewText'),

    filasHelpModal: $('#filasHelpModal'),
    filasHelpSlides: $('#filasHelpSlides'),
    filasSlideDots: $('#filasSlideDots'),
    filasSlidePrev: $('#filasSlidePrev'),
    filasSlideNext: $('#filasSlideNext'),
    filasHelpCounter: $('#filasHelpCounter'),
    filasHelpBack: $('#filasHelpBack'),
    filasHelpNext: $('#filasHelpNext'),
    filasHelpDone: $('#filasHelpDone'),

    filaDepartamento: $('#filaDepartamento'),
    filaInstancias: $('#filaInstancias'),

    filasContextPill: $('#filasContextPill'),
    filasSummaryInstances: $('#filasSummaryInstances'),
    filasSummaryDepartments: $('#filasSummaryDepartments'),
    filasSummaryTotal: $('#filasSummaryTotal'),
    filasSummaryActive: $('#filasSummaryActive'),
    filasSummaryStatus: $('#filasSummaryStatus'),
    filasReadyNote: $('#filasReadyNote'),
  };

  function markReady() {
    try {
      document.documentElement.setAttribute('data-head-ready', '1');
      document.documentElement.setAttribute('data-loader-ready', '1');
      document.documentElement.classList.remove('prepaint');
    } catch {}
  }

  function getCookie(name) {
    try {
      const prefix = name + '=';
      const parts = document.cookie ? document.cookie.split('; ') : [];
      for (const p of parts) {
        if (p.indexOf(prefix) === 0) return decodeURIComponent(p.slice(prefix.length));
      }
    } catch {}
    return '';
  }

  function getEmpresaId() {
    const keys = [
      'empresa_id',
      'EMPRESA_ID',
      'empresaId',
      'zc:empresa_id',
    ];

    for (const k of keys) {
      try {
        const v = localStorage.getItem(k);
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
      } catch {}
    }

    const c1 = Number(getCookie('empresa_id'));
    if (Number.isFinite(c1) && c1 > 0) return c1;

    const c2 = Number(getCookie('EMPRESA_ID'));
    if (Number.isFinite(c2) && c2 > 0) return c2;

    return 0;
  }

  function authFetch(url, options = {}) {
    const opts = Object.assign({}, options || {});
    opts.credentials = opts.credentials || 'include';
    opts.headers = Object.assign(
      { Accept: 'application/json' },
      opts.headers || {}
    );

    if (window.ZAuth && typeof window.ZAuth.authFetch === 'function') {
      return window.ZAuth.authFetch(url, opts);
    }

    return fetch(url, opts);
  }

  async function apiJson(url, options = {}) {
    const res = await authFetch(url, options);
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();

    let data = null;

    if (contentType.includes('application/json')) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    } else {
      const text = await res.text().catch(() => '');
      data = { detail: text || res.statusText };
    }

    if (!res.ok) {
      const detail =
        data?.detail?.message ||
        data?.detail ||
        data?.message ||
        data?.error ||
        `Erro HTTP ${res.status}`;

      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }

    return data;
  }

  function toast(message, type = 'info') {
    const msg = String(message || '').trim();
    if (!msg) return;

    let root = $('#zc-toast-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'zc-toast-root';
      root.style.cssText = [
        'position:fixed',
        'right:18px',
        'bottom:18px',
        'z-index:999999',
        'display:flex',
        'flex-direction:column',
        'gap:10px',
        'pointer-events:none',
      ].join(';');
      document.body.appendChild(root);
    }

    const item = document.createElement('div');
    item.className = 'zc-toast zc-toast--' + type;
    item.textContent = msg;

    root.appendChild(item);

    requestAnimationFrame(() => {
      item.style.opacity = '1';
      item.style.transform = 'translateY(0)';
    });

    setTimeout(() => {
      item.style.opacity = '0';
      item.style.transform = 'translateY(8px)';
      setTimeout(() => item.remove(), 220);
    }, 3200);
  }

  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeText(v) {
    return String(v == null ? '' : v)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function prioridadeLabel(v) {
    const p = String(v || 'normal').toLowerCase();
    if (p === 'baixa') return 'Baixa';
    if (p === 'alta') return 'Alta';
    if (p === 'urgente') return 'Urgente';
    return 'Normal';
  }

  function prioridadeClass(v) {
    const p = String(v || 'normal').toLowerCase();
    if (p === 'baixa') return 'prio-baixa';
    if (p === 'alta') return 'prio-alta';
    if (p === 'urgente') return 'prio-urgente';
    return 'prio-normal';
  }

  function corClass(v) {
    const c = String(v || 'verde').toLowerCase();
    if (['verde', 'azul', 'amarelo', 'vermelho', 'roxo'].includes(c)) return c;
    return 'verde';
  }

  function slaText(min) {
    const n = Number(min);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n < 60) return `Até ${n} min`;
    if (n === 60) return 'Até 1 hora';
    return `Até ${Math.round(n / 60)} horas`;
  }

  function setLoading(on) {
    state.loading = !!on;

    const chatbotOff = !state.context?.chatbot_ativo;
    [
      els.btnNovaFila,
      els.btnNovaFilaEmpty,
      els.btnRestaurarFilas,
      els.formFila?.querySelector('button[type="submit"]'),
    ].forEach((btn) => {
      if (!btn) return;
      const requiresChatbot = btn === els.btnNovaFila || btn === els.btnNovaFilaEmpty || btn.closest?.('#formFila');
      btn.disabled = !!on || (requiresChatbot && chatbotOff);
      btn.classList.toggle('is-loading', !!on);
    });
  }

  function getFilters() {
    return {
      q: normalizeText(els.buscaFila?.value || ''),
      status: String(els.filtroStatus?.value || '').trim(),
      prioridade: String(els.filtroPrioridade?.value || '').trim(),
    };
  }

  function applyFilters() {
    const f = getFilters();

    state.filtradas = state.filas.filter((fila) => {
      if (f.status === 'ativa' && !fila.ativa) return false;
      if (f.status === 'inativa' && fila.ativa) return false;

      if (f.prioridade && String(fila.prioridade || '').toLowerCase() !== f.prioridade) {
        return false;
      }

      if (f.q) {
        const hay = normalizeText([
          fila.nome,
          fila.descricao,
          fila.mensagem_padrao,
          fila.departamento_nome,
          fila.prioridade,
        ].filter(Boolean).join(' '));

        if (!hay.includes(f.q)) return false;
      }

      return true;
    });

    render();
  }

  function renderSideSummary() {
    const chatbotAtivo = !!state.context?.chatbot_ativo;
    const instances = Array.isArray(state.context?.instances) ? state.context.instances.length : 0;
    const departments = Array.isArray(state.context?.departments) ? state.context.departments.length : 0;
    const total = state.filas.length;
    const ativas = state.filas.filter((f) => !!f.ativa).length;

    if (els.filasSummaryInstances) els.filasSummaryInstances.textContent = String(instances);
    if (els.filasSummaryDepartments) els.filasSummaryDepartments.textContent = String(departments);
    if (els.filasSummaryTotal) els.filasSummaryTotal.textContent = String(total);
    if (els.filasSummaryActive) els.filasSummaryActive.textContent = String(ativas);

    if (els.filasContextPill) {
      els.filasContextPill.textContent = chatbotAtivo ? 'Ativo' : 'Aguardando';
      els.filasContextPill.classList.toggle('is-ready', chatbotAtivo);
      els.filasContextPill.classList.toggle('is-waiting', !chatbotAtivo);
    }

    if (els.filasSummaryStatus) {
      els.filasSummaryStatus.innerHTML = chatbotAtivo
        ? '<i></i>Pronto para filas'
        : '<i></i>Aguardando Chatbot';
      els.filasSummaryStatus.classList.toggle('is-ready', chatbotAtivo);
      els.filasSummaryStatus.classList.toggle('is-waiting', !chatbotAtivo);
    }

    if (els.filasReadyNote) {
      els.filasReadyNote.classList.toggle('is-ready', chatbotAtivo);
      els.filasReadyNote.classList.toggle('is-waiting', !chatbotAtivo);
      els.filasReadyNote.innerHTML = chatbotAtivo
        ? '<i class="fa-solid fa-circle-check"></i><span>Chatbot configurado. As filas já podem receber conversas.</span>'
        : '<i class="fa-solid fa-circle-info"></i><span>Configure o Chatbot para liberar as filas.</span>';
    }
  }

  function renderMetrics() {
    const total = state.filas.length;
    const ativas = state.filas.filter((f) => !!f.ativa).length;
    const alta = state.filas.filter((f) => {
      const p = String(f.prioridade || '').toLowerCase();
      return p === 'alta' || p === 'urgente';
    }).length;

    const tempos = state.filas
      .filter((f) => !!f.retorno_inatividade_ativo)
      .map((f) => Number(f.retorno_inatividade_minutos))
      .filter((n) => Number.isFinite(n) && n > 0);

    const media = tempos.length
      ? Math.round(tempos.reduce((a, b) => a + b, 0) / tempos.length)
      : null;

    if (els.totalFilas) els.totalFilas.textContent = String(total);
    if (els.metricTotal) els.metricTotal.textContent = String(total);
    if (els.metricAtivas) els.metricAtivas.textContent = String(ativas);
    if (els.metricAlta) els.metricAlta.textContent = String(alta);
    if (els.metricSla) els.metricSla.textContent = media ? `${media} min` : '--';

    renderSideSummary();
  }

  function renderCards() {
    if (!els.tabelaFilas) return;

    const rows = state.filtradas;

    if (els.emptyFilas) {
      els.emptyFilas.classList.toggle('is-visible', !rows.length);
    }

    if (!rows.length) {
      els.tabelaFilas.innerHTML = '';
      return;
    }

    els.tabelaFilas.innerHTML = rows.map((fila, idx) => {
      const id = Number(fila.id);
      const nome = escapeHtml(fila.nome || 'Fila');
      const desc = escapeHtml(fila.descricao || 'Conversa aguardando atendimento dentro do departamento.');
      const msgRaw = String(fila.mensagem_padrao || '').trim();
      const msg = escapeHtml(msgRaw || 'Nenhuma mensagem padrão configurada.');
      const prioridade = escapeHtml(prioridadeLabel(fila.prioridade));
      const prioClass = prioridadeClass(fila.prioridade);
      const cClass = corClass(fila.cor);
      const status = fila.ativa ? 'Ativa' : 'Inativa';
      const statusClass = fila.ativa ? 'is-active' : 'is-inactive';
      const dep = fila.departamento_nome ? escapeHtml(fila.departamento_nome) : 'Sem departamento fixo';
      const retorno = fila.retorno_inatividade_ativo ? escapeHtml(slaText(fila.retorno_inatividade_minutos)) : 'Retorno desativado';
      const openClass = idx === 0 ? ' open' : '';
      const ariaExpanded = idx === 0 ? 'true' : 'false';

      return `
        <article class="item fila-card${openClass}" data-id="${id}">
          <header class="head js-toggle-fila" role="button" tabindex="0" aria-expanded="${ariaExpanded}">
            <div class="ico">
              <span class="fila-dot fila-dot--${cClass}"></span>
            </div>

            <div>
              <div class="title">
                ${nome}
                <span class="status-pill ${statusClass}">${status}</span>
              </div>
              <div class="desc">${desc}</div>
            </div>

            <div class="right">
              <span class="prio-pill ${prioClass}">${prioridade}</span>
              <span class="prio-pill">${retorno}</span>
              <i class="fa-solid fa-chevron-down chev"></i>
            </div>
          </header>

          <div class="body">
            <div class="body-inner">
              <div class="fila-info-grid">
                <div class="fila-info-box">
                  <div class="k">Prioridade</div>
                  <div class="v">${prioridade}</div>
                </div>

                <div class="fila-info-box">
                  <div class="k">Volta sem resposta</div>
                  <div class="v">${retorno}</div>
                </div>

                <div class="fila-info-box">
                  <div class="k">Departamento</div>
                  <div class="v">${dep}</div>
                </div>

                <div class="fila-info-box">
                  <div class="k">Status</div>
                  <div class="v">${status}</div>
                </div>
              </div>

              <div class="fila-message-preview">
                <div class="preview-title">
                  <i class="fa-regular fa-message"></i>
                  Mensagem padrão
                </div>
                <pre>${msg}</pre>
              </div>

              <div class="fila-actions">
                <button class="btn js-edit-fila" type="button">
                  <i class="fa-solid fa-pen"></i>
                  Editar fila
                </button>

                <button class="btn danger outline js-delete-fila" type="button">
                  <i class="fa-solid fa-trash"></i>
                  Excluir
                </button>
              </div>
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  function render() {
    renderMetrics();
    renderCards();
  }

  function selectedInstanceIds() {
    if (!els.filaInstancias) return [];
    return $$('input[type="checkbox"]', els.filaInstancias)
      .filter((input) => input.checked)
      .map((input) => Number(input.value))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  function renderContextGate() {
    const active = !!state.context?.chatbot_ativo;
    if (els.chatbotFilasGate) els.chatbotFilasGate.hidden = active;
    (els.queueContent || []).forEach((node) => { node.hidden = !active; });
    if (els.btnNovaFila) {
      els.btnNovaFila.hidden = !active;
      els.btnNovaFila.disabled = state.loading || !active;
    }
    if (els.btnRestaurarFilas) els.btnRestaurarFilas.hidden = !active;
    if (els.btnNovaFilaEmpty) els.btnNovaFilaEmpty.disabled = state.loading || !active;
    renderSideSummary();
  }

  function renderInstanceOptions(selectedIds = []) {
    if (!els.filaInstancias) return;
    const selected = new Set((selectedIds || []).map(Number));
    const rows = Array.isArray(state.context?.instances) ? state.context.instances : [];
    els.filaInstancias.innerHTML = rows.map((inst) => {
      const id = Number(inst.id);
      const checked = selected.has(id) || (!selected.size && rows.length === 1);
      return `
        <label class="queue-check-option">
          <input type="checkbox" value="${id}" ${checked ? 'checked' : ''}>
          <span><i class="fa-brands fa-whatsapp"></i>${escapeHtml(inst.nome || `WhatsApp ${id}`)}</span>
        </label>
      `;
    }).join('');
  }

  function renderDepartmentOptions(preferredId = null) {
    if (!els.filaDepartamento) return;
    const selectedIds = selectedInstanceIds();
    const deps = Array.isArray(state.context?.departments) ? state.context.departments : [];
    const allowed = deps.filter((dep) => {
      const ids = new Set((dep.instancia_ids || []).map(Number));
      return selectedIds.length > 0 && selectedIds.every((id) => ids.has(Number(id)));
    });

    const current = preferredId != null ? String(preferredId) : String(els.filaDepartamento.value || '');
    const placeholder = selectedIds.length
      ? (allowed.length ? 'Selecione o departamento' : 'Nenhum departamento disponível nesses WhatsApps')
      : 'Selecione primeiro o WhatsApp';
    els.filaDepartamento.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + allowed.map((dep) => (
      `<option value="${Number(dep.id)}">${escapeHtml(dep.nome || 'Departamento')}</option>`
    )).join('');

    if (current && allowed.some((dep) => String(dep.id) === current)) {
      els.filaDepartamento.value = current;
    }
  }

  async function loadContext() {
    const empresaId = getEmpresaId();
    if (!empresaId) return;
    const params = new URLSearchParams({ empresa_id: String(empresaId) });
    try {
      const data = await apiJson('/api/filas/contexto?' + params.toString());
      state.context = {
        chatbot_ativo: !!data?.chatbot_ativo,
        instances: Array.isArray(data?.instances) ? data.instances : [],
        departments: Array.isArray(data?.departments) ? data.departments : [],
      };
    } catch (err) {
      console.error('[filas] erro ao carregar contexto do chatbot', err);
      state.context = { chatbot_ativo: false, instances: [], departments: [] };
    }
    renderContextGate();
    renderInstanceOptions([]);
    renderDepartmentOptions();
  }

  function retornoMinutosAtual() {
    if (!els.filaRetornoAtivo?.checked) return null;
    const raw = String(els.filaSla?.value || '5');
    const value = raw === 'custom'
      ? Number(els.filaRetornoCustom?.value || 0)
      : Number(raw);
    if (!Number.isFinite(value) || value < 1 || value > 1440) {
      throw new Error('Informe um tempo de retorno entre 1 minuto e 24 horas.');
    }
    return Math.round(value);
  }

  function syncRetornoUi() {
    setSwitch(els.swFilaRetorno, !!els.filaRetornoAtivo?.checked);
    const custom = els.filaSla?.value === 'custom' && !!els.filaRetornoAtivo?.checked;
    if (els.filaRetornoCustomWrap) els.filaRetornoCustomWrap.hidden = !custom;
    if (els.filaSla) els.filaSla.disabled = !els.filaRetornoAtivo?.checked;
    if (els.filaRetornoCustom) els.filaRetornoCustom.disabled = !custom;
  }

  async function loadFilas() {
    const empresaId = getEmpresaId();

    if (!empresaId) {
      toast('Empresa não encontrada na sessão. Faça login novamente.', 'error');
      markReady();
      return;
    }

    setLoading(true);

    try {
      const params = new URLSearchParams();
      params.set('empresa_id', String(empresaId));

      const data = await apiJson('/api/filas?' + params.toString());
      state.filas = Array.isArray(data?.items) ? data.items : [];

      applyFilters();
    } catch (err) {
      console.error('[filas] erro ao carregar', err);
      toast(err.message || 'Erro ao carregar filas.', 'error');
      state.filas = [];
      applyFilters();
    } finally {
      setLoading(false);
      markReady();
    }
  }

  function setSwitch(node, on) {
    if (!node) return;

    node.dataset.on = on ? 'true' : 'false';
    node.setAttribute('aria-pressed', on ? 'true' : 'false');

    const input = node.querySelector('input');
    if (input) input.checked = !!on;
  }

  function syncAtivaSwitch() {
    setSwitch(els.swFilaAtiva, !!els.filaAtiva?.checked);
  }

  function renderFormPreview() {
    if (!els.filaPreviewText) return;

    const nome = String(els.filaNome?.value || '').trim() || 'Nome da fila';
    const msg = String(els.filaMensagem?.value || '').trim();

    els.filaPreviewText.textContent = msg || `Olá! Você entrou na fila ${nome}. Em instantes nossa equipe irá te atender.`;
  }

  function openModal(fila = null) {
    if (!state.context?.chatbot_ativo) {
      toast('Ative e configure o Chatbot de departamentos antes de criar uma fila.', 'info');
      return;
    }

    const isEdit = !!fila;
    state.editingId = isEdit ? Number(fila.id) : null;

    if (els.modalFilaTitulo) els.modalFilaTitulo.textContent = isEdit ? 'Editar fila' : 'Nova fila';
    if (els.filaId) els.filaId.value = isEdit ? String(fila.id) : '';
    if (els.filaNome) els.filaNome.value = isEdit ? String(fila.nome || '') : '';
    if (els.filaPrioridade) els.filaPrioridade.value = isEdit ? String(fila.prioridade || 'normal') : 'normal';
    if (els.filaCor) els.filaCor.value = isEdit ? String(fila.cor || 'verde') : 'verde';
    if (els.filaDescricao) els.filaDescricao.value = isEdit ? String(fila.descricao || '') : '';
    if (els.filaMensagem) els.filaMensagem.value = isEdit ? String(fila.mensagem_padrao || '') : '';
    if (els.filaAtiva) els.filaAtiva.checked = isEdit ? !!fila.ativa : true;

    const returnEnabled = isEdit ? !!fila.retorno_inatividade_ativo : true;
    const returnMinutes = Number(isEdit ? fila.retorno_inatividade_minutos : 5) || 5;
    if (els.filaRetornoAtivo) els.filaRetornoAtivo.checked = returnEnabled;
    const presets = [5, 10, 15, 30, 60];
    if (els.filaSla) els.filaSla.value = presets.includes(returnMinutes) ? String(returnMinutes) : 'custom';
    if (els.filaRetornoCustom) els.filaRetornoCustom.value = String(returnMinutes);

    const ids = isEdit && Array.isArray(fila?.instancia_ids) ? fila.instancia_ids.map(Number) : [];
    renderInstanceOptions(ids);
    renderDepartmentOptions(isEdit ? fila.departamento_id : null);

    if (els.btnExcluirFila) els.btnExcluirFila.hidden = !isEdit;

    syncAtivaSwitch();
    syncRetornoUi();
    renderFormPreview();

    if (els.modalFila) {
      els.modalFila.setAttribute('aria-hidden', 'false');
      els.modalFila.classList.add('show', 'is-open');
      document.body.classList.add('modal-open');
    }

    setTimeout(() => {
      try { els.filaNome?.focus(); els.filaNome?.select?.(); } catch {}
    }, 80);
  }

  function closeModal() {
    state.editingId = null;

    if (els.formFila) {
      try { els.formFila.reset(); } catch {}
    }

    if (els.modalFila) {
      els.modalFila.setAttribute('aria-hidden', 'true');
      els.modalFila.classList.remove('show', 'is-open');
      document.body.classList.remove('modal-open');
    }

    if (els.btnExcluirFila) {
      els.btnExcluirFila.hidden = true;
    }

    syncAtivaSwitch();
    renderFormPreview();
  }

  function collectFormPayload() {
    const empresaId = getEmpresaId();
    const nome = String(els.filaNome?.value || '').trim();
    if (!empresaId) throw new Error('Empresa não encontrada na sessão.');
    if (!state.context?.chatbot_ativo) throw new Error('Configure o Chatbot de departamentos antes de usar filas.');
    if (!nome) throw new Error('Informe o nome da fila.');

    const instanciaIds = selectedInstanceIds();
    if (!instanciaIds.length) throw new Error('Selecione ao menos um WhatsApp com Chatbot ativo.');

    const departamentoIdRaw = String(els.filaDepartamento?.value || '').trim();
    const departamentoId = departamentoIdRaw ? Number(departamentoIdRaw) : null;
    if (!departamentoId) throw new Error('Selecione um departamento configurado no Chatbot.');

    const retornoAtivo = !!els.filaRetornoAtivo?.checked;
    const retornoMinutos = retornoAtivo ? retornoMinutosAtual() : null;

    return {
      empresa_id: empresaId,
      nome,
      departamento_id: departamentoId,
      instancia_ids: instanciaIds,
      prioridade: String(els.filaPrioridade?.value || 'normal').trim() || 'normal',
      sla_minutos: retornoMinutos,
      retorno_inatividade_ativo: retornoAtivo,
      retorno_inatividade_minutos: retornoMinutos,
      cor: String(els.filaCor?.value || 'verde').trim() || 'verde',
      descricao: String(els.filaDescricao?.value || '').trim() || null,
      mensagem_padrao: String(els.filaMensagem?.value || '').trim() || null,
      ativa: !!els.filaAtiva?.checked,
      ordem: 0,
      exigir_aceite: true,
      retorno_ao_liberar: true,
      auto_distribuir: false,
    };
  }

  async function saveFila(ev) {
    ev?.preventDefault?.();

    if (state.loading) return;

    let payload;

    try {
      payload = collectFormPayload();
    } catch (err) {
      toast(err.message || 'Verifique os dados da fila.', 'error');
      return;
    }

    const id = Number(els.filaId?.value || state.editingId || 0);
    const isEdit = Number.isFinite(id) && id > 0;

    setLoading(true);

    try {
      const url = isEdit ? `/api/filas/${encodeURIComponent(id)}` : '/api/filas';
      const method = isEdit ? 'PUT' : 'POST';

      const data = await apiJson(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const item = data?.item;

      if (item && item.id) {
        const idx = state.filas.findIndex((f) => Number(f.id) === Number(item.id));
        if (idx >= 0) state.filas[idx] = item;
        else state.filas.unshift(item);
      } else {
        await loadFilas();
      }

      closeModal();
      applyFilters();
      toast(isEdit ? 'Fila atualizada com sucesso.' : 'Fila criada com sucesso.', 'success');
    } catch (err) {
      console.error('[filas] erro ao salvar', err);
      toast(err.message || 'Erro ao salvar fila.', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function deleteFila(id, opts = {}) {
    const filaId = Number(id);
    if (!Number.isFinite(filaId) || filaId <= 0) return;

    const fila = state.filas.find((f) => Number(f.id) === filaId);
    const nome = fila?.nome || 'esta fila';

    if (!opts.skipConfirm) {
      const ok = window.confirm(
        `Deseja excluir/desativar "${nome}"?\n\nSe ela já tiver atendimentos vinculados, o sistema vai apenas desativar.`
      );
      if (!ok) return;
    }

    const empresaId = getEmpresaId();
    const params = new URLSearchParams();
    if (empresaId) params.set('empresa_id', String(empresaId));

    setLoading(true);

    try {
      const data = await apiJson(`/api/filas/${encodeURIComponent(filaId)}?${params.toString()}`, {
        method: 'DELETE',
      });

      if (data?.deleted) {
        state.filas = state.filas.filter((f) => Number(f.id) !== filaId);
      } else if (data?.disabled) {
        const idx = state.filas.findIndex((f) => Number(f.id) === filaId);
        if (idx >= 0) {
          state.filas[idx] = Object.assign({}, state.filas[idx], { ativa: false });
        } else {
          await loadFilas();
        }
      } else {
        await loadFilas();
      }

      closeModal();
      applyFilters();
      toast(data?.message || 'Fila removida/desativada.', 'success');
    } catch (err) {
      console.error('[filas] erro ao excluir', err);
      toast(err.message || 'Erro ao excluir fila.', 'error');
    } finally {
      setLoading(false);
    }
  }

  function resetFilters() {
    if (els.buscaFila) els.buscaFila.value = '';
    if (els.filtroStatus) els.filtroStatus.value = '';
    if (els.filtroPrioridade) els.filtroPrioridade.value = '';
    applyFilters();
    loadFilas();
  }

  function setHelpSlide(index) {
    const slides = $$('.help-slide', els.filasHelpSlides || document);
    const dots = $$('[data-slide-dot]', els.filasSlideDots || document);
    const total = slides.length || state.helpTotal || 4;

    let next = Number(index);
    if (!Number.isFinite(next)) next = 0;
    if (next < 0) next = 0;
    if (next > total - 1) next = total - 1;

    state.helpSlide = next;
    state.helpTotal = total;

    slides.forEach((slide, i) => {
      slide.classList.toggle('is-active', i === next);
    });

    dots.forEach((dot) => {
      const i = Number(dot.dataset.slideDot || 0);
      dot.classList.toggle('is-active', i === next);
    });

    if (els.filasHelpCounter) {
      els.filasHelpCounter.textContent = `${next + 1} de ${total}`;
    }

    if (els.filasSlidePrev) {
      els.filasSlidePrev.disabled = next <= 0;
    }

    if (els.filasSlideNext) {
      els.filasSlideNext.disabled = next >= total - 1;
    }

    if (els.filasHelpBack) {
      els.filasHelpBack.disabled = next <= 0;
    }

    if (els.filasHelpNext) {
      els.filasHelpNext.hidden = next >= total - 1;
    }

    if (els.filasHelpDone) {
      els.filasHelpDone.hidden = next < total - 1;
    }
  }

  function openHelpModal() {
    if (!els.filasHelpModal) return;

    els.filasHelpModal.setAttribute('aria-hidden', 'false');
    els.filasHelpModal.classList.add('show');
    setHelpSlide(0);
  }

  function closeHelpModal() {
    if (!els.filasHelpModal) return;
    els.filasHelpModal.setAttribute('aria-hidden', 'true');
    els.filasHelpModal.classList.remove('show');
  }

  function nextHelpSlide() {
    setHelpSlide(state.helpSlide + 1);
  }

  function prevHelpSlide() {
    setHelpSlide(state.helpSlide - 1);
  }

  function toggleCard(card, force) {
    if (!card) return;

    const shouldOpen = typeof force === 'boolean'
      ? force
      : !card.classList.contains('open');

    card.classList.toggle('open', shouldOpen);

    const head = card.querySelector('.head');
    if (head) head.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }

  function bindEvents() {
    els.btnNovaFila?.addEventListener('click', () => openModal());
    els.btnNovaFilaEmpty?.addEventListener('click', () => openModal());

    els.btnComoFuncionaFilas?.addEventListener('click', openHelpModal);

    els.filasSlidePrev?.addEventListener('click', prevHelpSlide);
    els.filasSlideNext?.addEventListener('click', nextHelpSlide);
    els.filasHelpBack?.addEventListener('click', prevHelpSlide);
    els.filasHelpNext?.addEventListener('click', nextHelpSlide);

    els.filasSlideDots?.addEventListener('click', (ev) => {
      const dot = ev.target.closest('[data-slide-dot]');
      if (!dot) return;
      setHelpSlide(Number(dot.dataset.slideDot || 0));
    });

    document.addEventListener('click', (ev) => {
      const closeBtn = ev.target.closest('[data-close-modal="filasHelpModal"]');
      if (closeBtn) closeHelpModal();
    });

    els.filasHelpModal?.addEventListener('click', (ev) => {
      if (ev.target === els.filasHelpModal) closeHelpModal();
    });

    els.btnFecharModalFila?.addEventListener('click', closeModal);
    els.btnCancelarFila?.addEventListener('click', (ev) => {
      ev.preventDefault();
      closeModal();
    });

    els.modalFila?.addEventListener('click', (ev) => {
      if (ev.target === els.modalFila) closeModal();
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        if (els.modalFila?.classList.contains('show')) closeModal();
        if (els.filasHelpModal?.classList.contains('show')) closeHelpModal();
      }

      if (els.filasHelpModal?.classList.contains('show')) {
        if (ev.key === 'ArrowRight') nextHelpSlide();
        if (ev.key === 'ArrowLeft') prevHelpSlide();
      }
    });

    els.formFila?.addEventListener('submit', saveFila);

    els.btnExcluirFila?.addEventListener('click', () => {
      const id = Number(els.filaId?.value || state.editingId || 0);
      if (id > 0) deleteFila(id);
    });

    els.buscaFila?.addEventListener('input', applyFilters);
    els.filtroStatus?.addEventListener('change', applyFilters);
    els.filtroPrioridade?.addEventListener('change', applyFilters);
    els.btnRestaurarFilas?.addEventListener('click', resetFilters);

    [
      els.filaNome,
      els.filaMensagem,
      els.filaPrioridade,
      els.filaSla,
      els.filaCor,
      els.filaDescricao,
    ].forEach((el) => {
      el?.addEventListener('input', renderFormPreview);
      el?.addEventListener('change', renderFormPreview);
    });

    els.filaAtiva?.addEventListener('change', syncAtivaSwitch);
    els.filaRetornoAtivo?.addEventListener('change', syncRetornoUi);
    els.filaSla?.addEventListener('change', syncRetornoUi);
    els.filaInstancias?.addEventListener('change', () => renderDepartmentOptions());

    els.swFilaAtiva?.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();

      if (els.filaAtiva) {
        els.filaAtiva.checked = !els.filaAtiva.checked;
        els.filaAtiva.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    els.swFilaRetorno?.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      if (els.filaRetornoAtivo) {
        els.filaRetornoAtivo.checked = !els.filaRetornoAtivo.checked;
        els.filaRetornoAtivo.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    els.tabelaFilas?.addEventListener('click', (ev) => {
      const card = ev.target.closest('.fila-card[data-id]');
      if (!card) return;

      const id = Number(card.dataset.id);
      const fila = state.filas.find((f) => Number(f.id) === id);
      if (!fila) return;

      if (ev.target.closest('.js-edit-fila')) {
        ev.preventDefault();
        ev.stopPropagation();
        openModal(fila);
        return;
      }

      if (ev.target.closest('.js-delete-fila')) {
        ev.preventDefault();
        ev.stopPropagation();
        deleteFila(id);
        return;
      }

      const head = ev.target.closest('.js-toggle-fila');
      if (head) {
        toggleCard(card);
      }
    });

    els.tabelaFilas?.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;

      const head = ev.target.closest('.js-toggle-fila');
      if (!head) return;

      ev.preventDefault();
      const card = head.closest('.fila-card[data-id]');
      toggleCard(card);
    });
  }

  async function init() {
    bindEvents();
    syncAtivaSwitch();
    syncRetornoUi();
    renderFormPreview();
    setHelpSlide(0);

    try {
      await loadContext();
      if (state.context?.chatbot_ativo) {
        await loadFilas();
      } else {
        state.filas = [];
        state.filtradas = [];
        render();
        setLoading(false);
        markReady();
      }
    } catch {
      markReady();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.ZCFilasPage = {
    reload: loadFilas,
    openModal,
    closeModal,
    openHelpModal,
    closeHelpModal,
    setHelpSlide,
    version: PAGE_VERSION,
  };
})();