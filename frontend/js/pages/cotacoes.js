// /frontend/js/pages/cotacoes.js
// Cotações | Valora CRM
// Versão completa: modal padrão Clientes + campos personalizados vindos de Formulários.

(() => {
  'use strict';

  const API_COTACOES = '/api/cotacoes';
  const API_FORNECEDORES = '/api/fornecedores';

  const SYSTEM_FIELD_SLUGS = new Set([
    'codigo',
    'cod',
    'cotacao_codigo',
    'status',
    'situacao',
    'urgencia',
    'prioridade',
    'item',
    'item_nome',
    'nome_item',
    'item_desejado',
    'produto',
    'produto_nome',
    'quantidade',
    'qtd',
    'unidade',
    'categoria',
    'descricao',
    'descricao_item',
    'observacoes',
    'observacao',
    'observacoes_internas',
  ]);

  const state = {
    cotacoes: [],
    fornecedores: [],
    fornecedorRows: [],
    editandoId: null,
    page: { offset: 0, limit: 50, total: 0, hasMore: false },
    loading: false,
    formularioCotacoes: null,
    usarFichaPrincipalCotacoes: false,
    fichaCotacaoController: null,
    cotacaoAtualDetalhe: null,
    modalSomenteLeitura: false,
  };

  const STATUS_LABELS = {
    rascunho: 'Rascunho',
    em_cotacao: 'Em cotação',
    respondida: 'Respondida',
    em_analise: 'Em análise',
    aprovada: 'Aprovada',
    convertida: 'Convertida',
    recusada: 'Recusada',
    cancelada: 'Cancelada',
  };

  const URGENCIA_LABELS = {
    baixa: 'Baixa',
    media: 'Média',
    alta: 'Alta',
    critica: 'Crítica',
  };

  function $(id) {
    return document.getElementById(id);
  }

  function $$(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function onlyDigits(value) {
    return String(value ?? '').replace(/\D+/g, '').trim();
  }

  function normalizeText(value) {
    return String(value || '').trim();
  }

  function slugify(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120);
  }

  function parseNumber(value) {
    if (value === null || value === undefined || value === '') return 0;

    let text = String(value)
      .replace(/R\$/gi, '')
      .replace(/\s+/g, '')
      .trim();

    if (!text) return 0;

    if (text.includes(',')) {
      text = text.replace(/\./g, '').replace(',', '.');
    }

    const n = Number(text);
    return Number.isFinite(n) ? n : 0;
  }

  function formatMoney(value) {
    const n = parseNumber(value);

    if (!n) return '--';

    return n.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
  }

  function calcTotalRow(row) {
    const quantidade = parseNumber($('cotacao-quantidade')?.value || 1) || 1;
    const unit = parseNumber(row.valor_unitario);
    const frete = parseNumber(row.frete);

    return ((quantidade * unit) + frete).toFixed(2);
  }

  function statusBadge(status) {
    const key = String(status || 'rascunho').trim().toLowerCase();

    return `
      <span class="status-badge-cotacao ${escapeHtml(key)}">
        ${escapeHtml(STATUS_LABELS[key] || key || 'Rascunho')}
      </span>
    `;
  }

  function urgenciaBadge(urgencia) {
    const key = String(urgencia || '').trim().toLowerCase();

    if (!key) return '';

    return `
      <span class="urgencia-badge ${escapeHtml(key)}">
        ${escapeHtml(URGENCIA_LABELS[key] || key)}
      </span>
    `;
  }

  function toast(message, error = false, ms = 2800) {
    if (typeof window.showToast === 'function') {
      window.showToast(message, error ? 'error' : 'success');
      return;
    }

    const el = $('valora-toast');

    if (!el) {
      alert(message);
      return;
    }

    el.textContent = message || '';
    el.classList.toggle('is-error', !!error);
    el.classList.add('show');

    clearTimeout(toast._timer);

    toast._timer = setTimeout(() => {
      el.classList.remove('show');
    }, ms);
  }

  function setButtonLoading(btn, loading, textWhenLoading = 'Salvando...', textWhenNormal = '') {
    if (!btn) return;

    if (loading) {
      btn.dataset.originalHtml = btn.innerHTML;
      btn.innerHTML = textWhenLoading;
      btn.disabled = true;
      return;
    }

    btn.disabled = false;
    btn.innerHTML = textWhenNormal || btn.dataset.originalHtml || btn.innerHTML;
  }

  function restoreReadonlyElement(el) {
    if (!el || el.dataset.readonlyTouched !== 'true') return;

    el.disabled = el.dataset.readonlyWasDisabled === 'true';
    el.readOnly = el.dataset.readonlyWasReadonly === 'true';
    el.removeAttribute('aria-readonly');
    el.classList.remove('is-readonly-field');

    delete el.dataset.readonlyTouched;
    delete el.dataset.readonlyWasDisabled;
    delete el.dataset.readonlyWasReadonly;
  }

  function applyReadonlyElement(el) {
    if (!el || el.dataset.readonlyTouched === 'true') return;

    el.dataset.readonlyTouched = 'true';
    el.dataset.readonlyWasDisabled = el.disabled ? 'true' : 'false';
    el.dataset.readonlyWasReadonly = el.readOnly ? 'true' : 'false';

    const tag = String(el.tagName || '').toLowerCase();
    const type = String(el.type || '').toLowerCase();

    if (tag === 'select' || type === 'checkbox' || type === 'radio' || type === 'file' || type === 'button') {
      el.disabled = true;
    } else {
      el.readOnly = true;
    }

    el.setAttribute('aria-readonly', 'true');
    el.classList.add('is-readonly-field');
  }

  function setHiddenByReadonly(id, enabled) {
    const el = $(id);
    if (!el) return;

    if (enabled) {
      if (el.dataset.readonlyTouchedHidden !== 'true') {
        el.dataset.readonlyTouchedHidden = 'true';
        el.dataset.readonlyWasHidden = el.hidden ? 'true' : 'false';
        el.dataset.readonlyWasDisplay = el.style.display || '';
      }
      el.hidden = true;
      el.style.display = 'none';
      return;
    }

    if (el.dataset.readonlyTouchedHidden === 'true') {
      el.hidden = el.dataset.readonlyWasHidden === 'true';
      el.style.display = el.dataset.readonlyWasDisplay || '';
      delete el.dataset.readonlyTouchedHidden;
      delete el.dataset.readonlyWasHidden;
      delete el.dataset.readonlyWasDisplay;
    }
  }

  function setCotacaoModalReadonly(enabled) {
    state.modalSomenteLeitura = !!enabled;

    const backdrop = $('modal-cotacao-backdrop');
    const form = $('formCotacao');
    const cancelBtn = $('btn-cancelar-cotacao');
    const title = $('modal-cotacao-titulo');

    backdrop?.classList.toggle('modal-readonly', state.modalSomenteLeitura);
    form?.classList.toggle('modal-readonly-form', state.modalSomenteLeitura);

    if (form) {
      form.querySelectorAll('input, select, textarea').forEach((el) => {
        if (state.modalSomenteLeitura) applyReadonlyElement(el);
        else restoreReadonlyElement(el);
      });
    }

    [
      'btn-salvar-cotacao',
      'btn-adicionar-fornecedor-cotacao',
      'btn-aprovar-cotacao',
      'btn-converter-cotacao-produto',
    ].forEach((id) => setHiddenByReadonly(id, state.modalSomenteLeitura));

    document
      .querySelectorAll('#modal-cotacao-backdrop [data-remove-row]')
      .forEach((btn) => {
        if (state.modalSomenteLeitura) {
          if (btn.dataset.readonlyTouchedHidden !== 'true') {
            btn.dataset.readonlyTouchedHidden = 'true';
            btn.dataset.readonlyWasHidden = btn.hidden ? 'true' : 'false';
            btn.dataset.readonlyWasDisplay = btn.style.display || '';
          }
          btn.hidden = true;
          btn.style.display = 'none';
        } else if (btn.dataset.readonlyTouchedHidden === 'true') {
          btn.hidden = btn.dataset.readonlyWasHidden === 'true';
          btn.style.display = btn.dataset.readonlyWasDisplay || '';
          delete btn.dataset.readonlyTouchedHidden;
          delete btn.dataset.readonlyWasHidden;
          delete btn.dataset.readonlyWasDisplay;
        }
      });

    if (cancelBtn) {
      if (state.modalSomenteLeitura) {
        cancelBtn.dataset.normalText = cancelBtn.dataset.normalText || cancelBtn.textContent || 'Cancelar';
        cancelBtn.textContent = 'Fechar';
      } else if (cancelBtn.dataset.normalText) {
        cancelBtn.textContent = cancelBtn.dataset.normalText;
      }
    }

    if (title && !state.modalSomenteLeitura) {
      title.removeAttribute('data-readonly-title');
    }
  }

  async function apiJson(url, options = {}) {
    const resp = await fetch(url, {
      credentials: 'include',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });

    if (resp.status === 204) {
      return null;
    }

    const text = await resp.text();

    if (!resp.ok) {
      let message = text || 'Erro na requisição.';

      try {
        const parsed = JSON.parse(text);
        message = parsed.detail || parsed.message || message;
      } catch (_) {}

      throw new Error(typeof message === 'string' ? message : 'Erro na requisição.');
    }

    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  async function carregarProximoCodigoCotacao() {
    const data = await apiJson(`${API_COTACOES}/proximo-codigo`);
    return onlyDigits(data?.codigo || data?.proximo_codigo || '');
  }

  async function preencherProximoCodigoCotacao() {
    try {
      const codigo = await carregarProximoCodigoCotacao();
      syncCotacaoFichaCode(codigo);
      return codigo;
    } catch (err) {
      console.warn('Não foi possível carregar o próximo código da cotação.', err);
      syncCotacaoFichaCode('');
      return '';
    }
  }

  function removerCodigoDoPayload(payload) {
    const clean = { ...(payload || {}) };
    delete clean.codigo;
    return clean;
  }

  function openModal() {
    if (window.ValoraModal) {
      return window.ValoraModal.open('modal-cotacao-backdrop');
    }

    const modal = $('modal-cotacao-backdrop');

    if (!modal) return;

    modal.hidden = false;
    modal.style.display = 'flex';

    requestAnimationFrame(() => {
      modal.classList.add('show');
    });
  }

  function closeModal() {
    if (window.ValoraModal) {
      return window.ValoraModal.close('modal-cotacao-backdrop');
    }

    const modal = $('modal-cotacao-backdrop');

    if (!modal) return;

    modal.classList.remove('show');

    setTimeout(() => {
      modal.hidden = true;
      modal.style.display = 'none';
    }, 160);
  }

  function switchCotacaoTab(targetId) {
    if (!targetId) return;

    if (state.usarFichaPrincipalCotacoes) {
      targetId = 'tab-cotacao-campos';
    }

    $$('.cotacao-tab-btn[data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === targetId);
    });

    $$('.cotacao-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.id === targetId);
    });
  }

  function bindCotacaoTabs() {
    document.addEventListener('click', (event) => {
      const btn = event.target.closest('.cotacao-tab-btn[data-tab]');

      if (!btn) return;

      switchCotacaoTab(btn.dataset.tab);
    });
  }

  function syncCotacaoFichaCode(codigo) {
    const value = onlyDigits(codigo) || '';

    const normal = $('cotacao-codigo');
    const ficha = $('cotacao-codigo-ficha-principal');

    if (normal) {
      normal.value = value;
      normal.readOnly = true;
      normal.setAttribute('readonly', 'readonly');
    }

    if (ficha) {
      ficha.value = value;
      ficha.readOnly = true;
      ficha.setAttribute('readonly', 'readonly');
    }
  }


  function formatarDataCadastroSistema(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
    }

    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[3]}/${match[2]}/${match[1]}`;

    return raw;
  }

  function setCotacaoDataCadastro(dataCadastro, usarHoje = false) {
    const raw = dataCadastro || (usarHoje ? new Date().toISOString() : '');
    setValue('cotacao-data-cadastro-ficha-principal', formatarDataCadastroSistema(raw));
  }

  function ensureFichaCotacaoController() {
    if (state.fichaCotacaoController || !window.ValoraFichaPrincipal?.createTabFichaController) {
      return state.fichaCotacaoController;
    }

    state.fichaCotacaoController = window.ValoraFichaPrincipal.createTabFichaController({
      formSelector: '#formCotacao',
      tabsSelector: '.cotacao-tabs',
      tabButtonSelector: '.cotacao-tab-btn',
      tabPanelSelector: '.cotacao-tab',
      customTabId: 'tab-cotacao-campos',
      customContainerSelector: '#custom-fields-container',
      codeCardSelector: '#cotacao-ficha-principal-code',
      toggleSelector: '#toggle-ficha-principal-cotacao',
      normalTabId: 'tab-cotacao-identificacao',
      buttonClass: 'cotacao-tab-btn',
    });

    state.fichaCotacaoController.bindSectionClicks();
    return state.fichaCotacaoController;
  }

  function aplicarModoFichaCotacao() {
    ensureFichaCotacaoController()?.setMode(state.usarFichaPrincipalCotacoes);
  }

  function getCustomValue(custom, keys, fallback = '') {
    for (const key of keys) {
      const value = custom?.[key];

      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }

    return fallback;
  }

  function buildCustomValuesForRender(data = {}) {
    return {
      ...(data.custom_fields || {}),
      ...data,
      data_cadastro: data.data_cadastro || data.criado_em || data.created_at || '',
      codigo: data.codigo || '',
      cotacao_codigo: data.codigo || '',
      status: data.status || 'rascunho',
      situacao: data.status || 'rascunho',
      urgencia: data.urgencia || '',
      prioridade: data.urgencia || '',
      item: data.item_nome || '',
      item_nome: data.item_nome || '',
      item_desejado: data.item_nome || '',
      nome_item: data.item_nome || '',
      produto: data.item_nome || '',
      produto_nome: data.item_nome || '',
      quantidade: data.quantidade || '',
      qtd: data.quantidade || '',
      unidade: data.unidade || '',
      categoria: data.categoria || '',
      descricao: data.descricao || '',
      descricao_item: data.descricao || '',
      observacoes: data.observacoes || '',
      observacao: data.observacoes || '',
      observacoes_internas: data.observacoes || '',
    };
  }

  function buildBaseFromCotacaoFichaPrincipal(customFields, fallback = {}) {
    const custom = customFields || {};
    const itemNome = getCustomValue(custom, [
      'item_nome',
      'item',
      'item_desejado',
      'nome_item',
      'produto',
      'produto_nome',
    ], fallback.item_nome || '');

    return {
      // Código não vem do formulário/ficha principal.
      // Ele é gerado e travado pelo backend.
      status: normalizeStatus(getCustomValue(custom, ['status', 'situacao'], fallback.status || 'rascunho')),
      urgencia: normalizeUrgencia(getCustomValue(custom, ['urgencia', 'prioridade'], fallback.urgencia || '')),
      item_nome: itemNome,
      quantidade: getCustomValue(custom, ['quantidade', 'qtd'], fallback.quantidade || '1'),
      unidade: getCustomValue(custom, ['unidade'], fallback.unidade || ''),
      categoria: getCustomValue(custom, ['categoria'], fallback.categoria || ''),
      descricao: getCustomValue(custom, ['descricao', 'descricao_item'], fallback.descricao || ''),
      observacoes: getCustomValue(custom, ['observacoes', 'observacao', 'observacoes_internas'], fallback.observacoes || ''),
    };
  }

  function cleanCustomFieldsForSave(customFields, options = {}) {
    const out = {};
    const preservarCamposFormulario = !!options.preservarCamposFormulario;

    Object.entries(customFields || {}).forEach(([key, value]) => {
      const slug = slugify(key);

      // Campos vindos da ficha principal precisam ser salvos no próprio slug,
      // mesmo quando o nome parece nativo do sistema: status, situação,
      // urgência, item, produto, quantidade, unidade, categoria etc.
      // O filtro antigo removia esses campos antes do PUT/POST.
      if (!slug || (!preservarCamposFormulario && SYSTEM_FIELD_SLUGS.has(slug))) return;

      if (value !== undefined && value !== null && String(value).trim() !== '') {
        out[slug] = value;
      }
    });

    return out;
  }

  async function carregarFormularioCotacoes({ loadingContainer = null, forceRefresh = false } = {}) {
    try {
      if (!window.ValoraFichaPrincipal) {
        state.formularioCotacoes = null;
        state.usarFichaPrincipalCotacoes = false;
        return null;
      }

      const formulario = await window.ValoraFichaPrincipal.carregarFormularioModulo('cotacoes', {
        apiJsonImpl: apiJson,
        ativo: true,
        forceRefresh,
        loadingContainer,
      });

      state.formularioCotacoes = formulario;
      state.usarFichaPrincipalCotacoes = !!formulario?.modelo?.usar_como_ficha_principal;
      return formulario;
    } catch (err) {
      state.formularioCotacoes = null;
      state.usarFichaPrincipalCotacoes = false;
      toast(err.message || 'Erro ao carregar formulário de cotações.', true);
      return null;
    }
  }

  async function renderCustomFieldsInputs(values = {}) {
    const container = $('custom-fields-container');

    if (!container) return;

    if (window.ValoraFichaPrincipal) {
      window.ValoraFichaPrincipal.showLoading(
        container,
        'Verificando ficha principal...',
        'Conferindo cache e banco de dados antes de montar os campos.'
      );

      await carregarFormularioCotacoes({ loadingContainer: container });
    }

    if (!window.ValoraFichaPrincipal) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1 / -1;">
          Não foi possível carregar o componente de ficha principal.
        </div>
      `;
      return;
    }

    window.ValoraFichaPrincipal.renderCustomFormSections({
      container,
      formulario: state.formularioCotacoes,
      camposAvulsos: [],
      values,
      usarFichaPrincipal: state.usarFichaPrincipalCotacoes,
      flatTitle: 'Campos personalizados',
      flatDescription: 'Campos extras da cotação.',
      emptyMessage: state.formularioCotacoes?.modelo
        ? 'Nenhum campo ativo neste formulário de cotações.'
        : 'Nenhum formulário de Cotações encontrado. Crie um formulário em Configurações > Formulários.',
    });
  }

  function normalizeCustomFieldsPayloadRaw() {
    if (window.ValoraFichaPrincipal?.collectCustomFieldsValues) {
      return window.ValoraFichaPrincipal.collectCustomFieldsValues(document);
    }

    const out = {};

    $$('[data-custom-field]').forEach((el) => {
      const slug = String(el.getAttribute('data-custom-field') || '').trim();

      if (!slug) return;

      let value = '';

      if (el.type === 'checkbox') {
        value = el.checked ? 'true' : 'false';
      } else {
        value = String(el.value || '').trim();
      }

      if (value !== '') {
        out[slug] = value;
      }
    });

    return out;
  }

  function validateRequiredCustomFields() {
    if (window.ValoraFichaPrincipal) {
      const ok = window.ValoraFichaPrincipal.validateRequiredRenderedFields({
        root: document,
        toast: (message) => toast(message, true),
        switchToCustomTab: () => switchCotacaoTab('tab-cotacao-campos'),
      });

      if (!ok) return false;
    }

    return true;
  }

  async function salvarToggleFichaPrincipalCotacao(event) {
    const checked = !!event.target.checked;

    try {
      if (!state.formularioCotacoes?.modelo?.id) {
        await carregarFormularioCotacoes();
        await renderCustomFieldsInputs(buildCustomValuesForRender(state.cotacaoAtualDetalhe || {}));
      }

      const modelo = state.formularioCotacoes?.modelo;

      if (!modelo?.id) {
        event.target.checked = false;
        toast('Nenhum formulário de Cotações encontrado para ativar como ficha principal.', true);
        return;
      }

      event.target.disabled = true;

      window.ValoraFichaPrincipal?.showLoading?.(
        '#custom-fields-container',
        checked ? 'Montando ficha principal...' : 'Voltando para o cadastro padrão...'
      );

      const atualizado = await window.ValoraFichaPrincipal.atualizarFichaPrincipalModelo(modelo, checked, {
        apiJsonImpl: apiJson,
        moduloFallback: 'cotacoes',
      });

      state.usarFichaPrincipalCotacoes = checked;
      state.formularioCotacoes = {
        ...state.formularioCotacoes,
        modelo: {
          ...modelo,
          ...(atualizado || {}),
          usar_como_ficha_principal: checked,
        },
      };

      await renderCustomFieldsInputs(buildCustomValuesForRender(state.cotacaoAtualDetalhe || {}));
      aplicarModoFichaCotacao();

      toast(
        checked
          ? 'Ficha principal ativada para Cotações.'
          : 'Ficha principal desativada para Cotações.'
      );
    } catch (err) {
      event.target.checked = !checked;
      toast(err.message || 'Erro ao alterar ficha principal.', true);
    } finally {
      event.target.disabled = false;
    }
  }

  function getValue(id) {
    const el = $(id);
    if (!el) return '';
    if (el.type === 'checkbox') return !!el.checked;
    return el.value ?? '';
  }

  function setValue(id, value) {
    const el = $(id);
    if (!el) return;
    if (el.type === 'checkbox') {
      el.checked = !!value;
      return;
    }
    el.value = value ?? '';
  }

  function normalizeStatus(value) {
    const s = String(value || 'rascunho').trim().toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
    return Object.prototype.hasOwnProperty.call(STATUS_LABELS, s) ? s : 'rascunho';
  }

  function normalizeUrgencia(value) {
    const s = String(value || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(URGENCIA_LABELS, s) ? s : '';
  }

  function limparCamposObrigatoriosPendentes() {
    document
      .querySelectorAll('.campo-obrigatorio-pendente, .is-required-missing')
      .forEach((el) => {
        el.classList.remove('campo-obrigatorio-pendente', 'is-required-missing');
      });
  }

  function abrirAbaDoCampoCotacao(el) {
    if (!el) return;

    const tab = el.closest('.cotacao-tab');
    if (tab?.id) {
      switchCotacaoTab(tab.id);
    }

    const sectionCard = el.closest('.custom-section-card');

    if (sectionCard) {
      const cards = Array.from(document.querySelectorAll('#custom-fields-container .custom-section-card'));
      const index = cards.indexOf(sectionCard);

      if (index >= 0) {
        const controller = ensureFichaCotacaoController();

        if (controller?.activateSection) {
          controller.activateSection(index);
        } else {
          const buttons = Array.from(document.querySelectorAll('.cotacao-tab-btn[data-ficha-section]'));
          cards.forEach((card, cardIndex) => {
            card.style.display = cardIndex === Number(index) ? 'block' : 'none';
          });
          buttons.forEach((btn) => {
            btn.classList.toggle('active', Number(btn.dataset.fichaSection) === Number(index));
          });
        }
      }
    }
  }

  function scrollCampoDentroModalCotacao(el) {
    if (!el) return;

    const scrollEl =
      el.closest('.cotacao-modal-scroll') ||
      document.querySelector('#modal-cotacao-backdrop .cotacao-modal-scroll') ||
      document.querySelector('#modal-cotacao-backdrop .cotacao-modal-main') ||
      document.querySelector('#modal-cotacao-backdrop .cotacao-modal-content');

    if (!scrollEl) {
      el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      return;
    }

    const elRect = el.getBoundingClientRect();
    const scrollRect = scrollEl.getBoundingClientRect();
    const targetTop = scrollEl.scrollTop + (elRect.top - scrollRect.top) - 120;

    scrollEl.scrollTo({
      top: Math.max(0, targetTop),
      behavior: 'smooth',
    });
  }

  function focarCampoCotacao(el) {
    if (!el) return;

    abrirAbaDoCampoCotacao(el);

    setTimeout(() => {
      const grupo = el.closest('.form-group, .custom-field-item, .custom-checkbox, .custom-section-card');
      el.classList.add('campo-obrigatorio-pendente', 'is-required-missing');
      grupo?.classList.add('campo-obrigatorio-pendente', 'is-required-missing');

      scrollCampoDentroModalCotacao(el);

      setTimeout(() => {
        try {
          el.focus?.({ preventScroll: true });
        } catch (_) {
          el.focus?.();
        }
      }, 220);
    }, 120);
  }

  function focusInvalidFieldInsideModal() {
    const form = $('formCotacao');

    if (!form) return;

    const invalid =
      form.querySelector('.campo-obrigatorio-pendente input, .campo-obrigatorio-pendente select, .campo-obrigatorio-pendente textarea') ||
      form.querySelector('input:invalid, select:invalid, textarea:invalid');

    if (!invalid) return;

    focarCampoCotacao(invalid);
  }

  function setLoadingTable() {
    const tbody = $('tbody-cotacoes');

    if (!tbody) return;

    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state">Carregando cotações...</td>
      </tr>
    `;
  }

  function renderCotacoes() {
    const tbody = $('tbody-cotacoes');

    if (!tbody) return;

    if (!state.cotacoes.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="empty-state">Nenhuma cotação encontrada.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = state.cotacoes.map((c) => {
      const fornecedor = c.fornecedor_vencedor_nome || '--';
      const qtd = [c.quantidade, c.unidade].filter(Boolean).join(' ') || '--';
      const urgencia = urgenciaBadge(c.urgencia);

      return `
        <tr>
          <td><strong>${escapeHtml(c.codigo || '')}</strong></td>

          <td>
            <button
              class="table-name-link cotacao-main"
              type="button"
              data-action="view"
              data-id="${c.id}"
              title="Visualizar cotação"
            >
              <strong>${escapeHtml(c.item_nome || '')}</strong>
              <span class="muted-line">${escapeHtml(c.categoria || '')}</span>
              ${urgencia ? `<span class="row-badges">${urgencia}</span>` : ''}
            </button>
          </td>

          <td>${escapeHtml(qtd)}</td>
          <td>${statusBadge(c.status)}</td>
          <td>${escapeHtml(fornecedor)}</td>

          <td><strong>${formatMoney(c.valor_aprovado)}</strong></td>

          <td class="text-right">
            <div class="cotacao-actions">
              <button class="cotacao-icon-btn" type="button" data-action="edit" data-id="${c.id}" title="Abrir cotação">
                <i class="fa-solid fa-pen-to-square"></i>
              </button>

              <button class="cotacao-icon-btn danger" type="button" data-action="delete" data-id="${c.id}" title="Excluir cotação">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderPagination() {
    const wraps = document.querySelectorAll('[data-pagination="cotacoes"]');

    if (!wraps.length) return;

    const start = state.page.total ? state.page.offset + 1 : 0;
    const end = Math.min(state.page.offset + state.cotacoes.length, state.page.total);
    const atual = state.page.total ? Math.floor(state.page.offset / state.page.limit) + 1 : 1;
    const paginas = Math.max(1, Math.ceil(state.page.total / state.page.limit));

    const html = `
      <span class="counter-text">${start}-${end} de ${state.page.total}</span>

      <div class="pagination-actions">
        <button class="btn btn-secondary" type="button" data-page-action="prev" ${state.page.offset <= 0 ? 'disabled' : ''}>
          Anterior
        </button>

        <span class="pagination-info">Página ${atual} de ${paginas}</span>

        <button class="btn btn-secondary" type="button" data-page-action="next" ${!state.page.hasMore ? 'disabled' : ''}>
          Próxima
        </button>
      </div>
    `;

    wraps.forEach((wrap) => {
      wrap.innerHTML = html;

      wrap.onclick = (event) => {
        const btn = event.target.closest('[data-page-action]');
        if (!btn || btn.disabled) return;

        if (btn.dataset.pageAction === 'prev') {
          state.page.offset = Math.max(0, state.page.offset - state.page.limit);
        }

        if (btn.dataset.pageAction === 'next') {
          if (!state.page.hasMore) return;
          state.page.offset += state.page.limit;
        }

        carregarCotacoes();
      };
    });
  }

  async function carregarCotacoes({ reset = false } = {}) {
    if (state.loading) return;

    state.loading = true;

    if (reset) {
      state.page.offset = 0;
    }

    setLoadingTable();

    try {
      const busca = normalizeText($('busca-cotacoes')?.value);
      const status = normalizeText($('filtro-status-cotacoes')?.value);

      const params = new URLSearchParams({
        paginated: 'true',
        limit: String(state.page.limit),
        offset: String(state.page.offset),
      });

      if (busca) params.set('busca', busca);
      if (status) params.set('status', status);

      const data = await apiJson(`${API_COTACOES}?${params.toString()}`);

      state.cotacoes = Array.isArray(data?.items) ? data.items : [];
      state.page.total = Number(data?.total || state.cotacoes.length || 0);
      state.page.hasMore = !!data?.has_more;

      const counter = $('contagem-cotacoes');
      if (counter) counter.textContent = `${state.page.total} cotação${state.page.total === 1 ? '' : 'es'}`;

      renderCotacoes();
      renderPagination();
    } catch (err) {
      console.error(err);
      const tbody = $('tbody-cotacoes');
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7" class="empty-state">${escapeHtml(err.message || 'Erro ao carregar cotações.')}</td>
          </tr>
        `;
      }
      toast(err.message || 'Erro ao carregar cotações.', true);
    } finally {
      state.loading = false;
    }
  }

  async function carregarFornecedores() {
    try {
      const data = await apiJson(`${API_FORNECEDORES}?paginated=true&limit=200&offset=0`);

      state.fornecedores = Array.isArray(data?.items)
        ? data.items
        : (Array.isArray(data) ? data : []);

      renderFornecedorSelects();
    } catch (err) {
      console.warn('Não foi possível carregar fornecedores:', err);
      state.fornecedores = [];
      renderFornecedorSelects();
    }
  }

  function fornecedorOptions(selectedId = '') {
    return ['<option value="">Fornecedor livre</option>'].concat(
      state.fornecedores.map((f) => `
        <option value="${escapeHtml(f.id)}" ${String(selectedId || '') === String(f.id) ? 'selected' : ''}>
          ${escapeHtml(f.nome || f.nome_fantasia || `Fornecedor #${f.id}`)}
        </option>
      `)
    ).join('');
  }

  function renderFornecedorSelects() {
    const select = $('cotacao-fornecedor-id');

    if (select) {
      select.innerHTML = ['<option value="">Selecione ou digite o nome ao lado</option>'].concat(
        state.fornecedores.map((f) => `
          <option value="${escapeHtml(f.id)}">
            ${escapeHtml(f.nome || f.nome_fantasia || `Fornecedor #${f.id}`)}
          </option>
        `)
      ).join('');
    }

    renderFornecedorRows();
  }

  function limparFornecedorInputs() {
    [
      'cotacao-fornecedor-id',
      'cotacao-fornecedor-nome',
      'cotacao-valor-unitario',
      'cotacao-frete',
      'cotacao-prazo',
      'cotacao-condicao',
      'cotacao-fornecedor-observacoes',
    ].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.value = '';
    });
  }

  function addFornecedorFromInputs() {
    const fornecedorId = normalizeText($('cotacao-fornecedor-id')?.value);
    const fornecedorNome = normalizeText($('cotacao-fornecedor-nome')?.value);
    const fornecedorSelecionado = state.fornecedores.find((f) => String(f.id) === String(fornecedorId));

    if (!fornecedorId && !fornecedorNome) {
      switchCotacaoTab('tab-cotacao-fornecedores');

      setTimeout(() => $('cotacao-fornecedor-id')?.focus(), 80);

      toast('Informe um fornecedor para adicionar na cotação.', true);
      return;
    }

    const row = {
      _tempId: `tmp_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      fornecedor_id: fornecedorId || null,
      fornecedor_nome: fornecedorNome || fornecedorSelecionado?.nome || '',
      valor_unitario: normalizeText($('cotacao-valor-unitario')?.value),
      frete: normalizeText($('cotacao-frete')?.value),
      prazo_entrega: normalizeText($('cotacao-prazo')?.value),
      condicao_pagamento: normalizeText($('cotacao-condicao')?.value),
      observacoes: normalizeText($('cotacao-fornecedor-observacoes')?.value),
      vencedor: !state.fornecedorRows.length,
    };

    row.valor_total = calcTotalRow(row);

    state.fornecedorRows.push(row);
    limparFornecedorInputs();
    renderFornecedorRows();
    switchCotacaoTab('tab-cotacao-fornecedores');
  }

  function collectFornecedorRowsFromDOM() {
    const rows = $$('#tbody-cotacao-fornecedores tr[data-row-key]');

    return rows.map((tr) => {
      const row = {
        id: tr.dataset.id ? Number(tr.dataset.id) : null,
        _tempId: tr.dataset.tempId || null,
        fornecedor_id: normalizeText(tr.querySelector('[data-field="fornecedor_id"]')?.value) || null,
        fornecedor_nome: normalizeText(tr.querySelector('[data-field="fornecedor_nome"]')?.value),
        valor_unitario: normalizeText(tr.querySelector('[data-field="valor_unitario"]')?.value),
        frete: normalizeText(tr.querySelector('[data-field="frete"]')?.value),
        prazo_entrega: normalizeText(tr.querySelector('[data-field="prazo_entrega"]')?.value),
        condicao_pagamento: normalizeText(tr.querySelector('[data-field="condicao_pagamento"]')?.value),
        observacoes: normalizeText(tr.querySelector('[data-field="observacoes"]')?.value),
        vencedor: !!tr.querySelector('[data-field="vencedor"]')?.checked,
      };

      row.valor_total = calcTotalRow(row);
      return row;
    });
  }

  function setFornecedorRowsFromDOM() {
    state.fornecedorRows = collectFornecedorRowsFromDOM();
  }

  function nomeFornecedorById(id) {
    if (!id) return '';

    const f = state.fornecedores.find((item) => String(item.id) === String(id));

    return f?.nome || f?.nome_fantasia || '';
  }

  function renderComparativo() {
    const box = $('cotacao-comparativo');
    const menorTotalEl = $('cotacao-menor-total');
    const fornecedorEl = $('cotacao-fornecedor-indicado');

    if (!box || !menorTotalEl || !fornecedorEl) return;

    if (!state.fornecedorRows.length) {
      box.hidden = true;
      return;
    }

    const rowsComTotal = state.fornecedorRows
      .map((row) => ({ ...row, totalNumber: parseNumber(row.valor_total || calcTotalRow(row)) }))
      .filter((row) => row.totalNumber > 0);

    if (!rowsComTotal.length) {
      box.hidden = true;
      return;
    }

    rowsComTotal.sort((a, b) => a.totalNumber - b.totalNumber);

    const menor = rowsComTotal[0];

    box.hidden = false;

    menorTotalEl.textContent = menor.totalNumber.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });

    fornecedorEl.textContent = menor.fornecedor_nome || nomeFornecedorById(menor.fornecedor_id) || '--';
  }

  function renderFornecedorRows() {
    const tbody = $('tbody-cotacao-fornecedores');

    if (!tbody) return;

    if (!state.fornecedorRows.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="empty-state">Nenhum fornecedor adicionado.</td>
        </tr>
      `;
      renderComparativo();
      return;
    }

    const totals = state.fornecedorRows
      .map((row) => parseNumber(row.valor_total || calcTotalRow(row)))
      .filter((n) => n > 0);

    const menorTotal = totals.length ? Math.min(...totals) : null;

    tbody.innerHTML = state.fornecedorRows.map((row, index) => {
      const key = row.id ? `id_${row.id}` : (row._tempId || `tmp_${index}`);
      const total = row.valor_total || calcTotalRow(row);
      const isBest = menorTotal !== null && parseNumber(total) === menorTotal;
      const isWinner = !!row.vencedor;

      return `
        <tr
          data-row-key="${escapeHtml(key)}"
          data-id="${row.id || ''}"
          data-temp-id="${escapeHtml(row._tempId || '')}"
          class="${isWinner ? 'cotacao-row-vencedor' : ''}">

          <td>
            <input
              class="fornecedor-vencedor-radio"
              type="radio"
              name="cotacao-vencedor"
              data-field="vencedor"
              ${isWinner ? 'checked' : ''}
            />
          </td>

          <td>
            <select data-field="fornecedor_id">${fornecedorOptions(row.fornecedor_id)}</select>
            <input
              data-field="fornecedor_nome"
              type="text"
              value="${escapeHtml(row.fornecedor_nome || '')}"
              placeholder="Nome livre"
            />
          </td>

          <td>
            <input
              data-field="valor_unitario"
              type="text"
              inputmode="decimal"
              value="${escapeHtml(row.valor_unitario || '')}"
              placeholder="0,00"
            />
          </td>

          <td>
            <input
              data-field="frete"
              type="text"
              inputmode="decimal"
              value="${escapeHtml(row.frete || '')}"
              placeholder="0,00"
            />
          </td>

          <td>
            <strong>${formatMoney(total)}</strong>
            ${isBest ? '<div><span class="cotacao-best-badge"><i class="fa-solid fa-arrow-trend-down"></i> Menor total</span></div>' : ''}
          </td>

          <td>
            <input
              data-field="prazo_entrega"
              type="text"
              value="${escapeHtml(row.prazo_entrega || '')}"
              placeholder="Prazo"
            />
          </td>

          <td>
            <input
              data-field="condicao_pagamento"
              type="text"
              value="${escapeHtml(row.condicao_pagamento || '')}"
              placeholder="Pagamento"
            />
          </td>

          <td class="text-right">
            <button
              class="cotacao-icon-btn danger"
              type="button"
              data-remove-row="${escapeHtml(key)}"
              title="Remover fornecedor">
              <i class="fa-solid fa-trash"></i>
            </button>

            <input data-field="observacoes" type="hidden" value="${escapeHtml(row.observacoes || '')}" />
          </td>
        </tr>
      `;
    }).join('');

    renderComparativo();

    if (window.ValoraLongFields?.refresh) {
      window.ValoraLongFields.refresh(tbody);
    }

    if (window.ValoraCamposLongos?.enhance) {
      window.ValoraCamposLongos.enhance(tbody);
    }

    if (state.modalSomenteLeitura) {
      setCotacaoModalReadonly(true);
    }
  }

  async function fillCotacaoForm(cotacao = {}) {
    const data = {
      codigo: '',
      status: 'rascunho',
      urgencia: '',
      item_nome: '',
      quantidade: '1',
      unidade: '',
      categoria: '',
      descricao: '',
      observacoes: '',
      fornecedores: [],
      custom_fields: {},
      ...(cotacao || {}),
    };

    state.cotacaoAtualDetalhe = data;

    setValue('cotacao-codigo', onlyDigits(data.codigo || ''));
    setValue('cotacao-codigo-ficha-principal', onlyDigits(data.codigo || ''));
    setCotacaoDataCadastro(data.criado_em || data.data_cadastro || data.created_at, !data.id);
    setValue('cotacao-status', normalizeStatus(data.status));
    setValue('cotacao-urgencia', normalizeUrgencia(data.urgencia));
    setValue('cotacao-item-nome', data.item_nome || '');
    setValue('cotacao-quantidade', data.quantidade || '1');
    setValue('cotacao-unidade', data.unidade || '');
    setValue('cotacao-categoria', data.categoria || '');
    setValue('cotacao-descricao', data.descricao || '');
    setValue('cotacao-observacoes', data.observacoes || '');

    state.fornecedorRows = Array.isArray(data.fornecedores)
      ? data.fornecedores.map((row) => ({ ...row }))
      : [];

    renderFornecedorRows();
    await renderCustomFieldsInputs(buildCustomValuesForRender(data));
    syncCotacaoFichaCode(data.codigo || getValue('cotacao-codigo'));
    aplicarModoFichaCotacao();
    switchCotacaoTab(state.usarFichaPrincipalCotacoes ? 'tab-cotacao-campos' : 'tab-cotacao-identificacao');
  }

  async function limparForm() {
    setCotacaoModalReadonly(false);
    state.editandoId = null;
    state.fornecedorRows = [];
    state.cotacaoAtualDetalhe = null;

    const form = $('formCotacao');
    form?.reset();

    setValue('cotacao-codigo', '');
    setValue('cotacao-codigo-ficha-principal', '');
    setCotacaoDataCadastro('', true);
    setValue('cotacao-status', 'rascunho');
    setValue('cotacao-urgencia', '');
    setValue('cotacao-item-nome', '');
    setValue('cotacao-quantidade', '1');
    setValue('cotacao-unidade', '');
    setValue('cotacao-categoria', '');
    setValue('cotacao-descricao', '');
    setValue('cotacao-observacoes', '');

    if ($('modal-cotacao-titulo')) $('modal-cotacao-titulo').textContent = 'Nova cotação';
    if ($('btn-aprovar-cotacao')) $('btn-aprovar-cotacao').hidden = true;
    if ($('btn-converter-cotacao-produto')) $('btn-converter-cotacao-produto').hidden = true;

    renderFornecedorRows();
    await renderCustomFieldsInputs(buildCustomValuesForRender({ quantidade: '1', status: 'rascunho' }));
    aplicarModoFichaCotacao();
    switchCotacaoTab(state.usarFichaPrincipalCotacoes ? 'tab-cotacao-campos' : 'tab-cotacao-identificacao');

    window.ValoraRequired?.refresh?.(document);
  }

  async function novaCotacao() {
    await limparForm();
    await carregarFornecedores();
    await preencherProximoCodigoCotacao();
    openModal();

    setTimeout(() => {
      switchCotacaoTab(state.usarFichaPrincipalCotacoes ? 'tab-cotacao-campos' : 'tab-cotacao-identificacao');
      if (!state.usarFichaPrincipalCotacoes) $('cotacao-item-nome')?.focus();
    }, 120);
  }

  async function abrirCotacao(id) {
    await limparForm();
    openModal();

    if ($('modal-cotacao-titulo')) $('modal-cotacao-titulo').textContent = 'Carregando cotação...';

    try {
      await carregarFornecedores();
      const data = await apiJson(`${API_COTACOES}/${id}`);

      state.editandoId = Number(data.id);
      $('modal-cotacao-titulo').textContent = `Cotação ${data.codigo || ''}`;

      await fillCotacaoForm(data);

      $('btn-aprovar-cotacao').hidden = !state.editandoId || data.status === 'convertida';
      $('btn-converter-cotacao-produto').hidden = !state.editandoId || data.status === 'convertida';

      window.ValoraRequired?.refresh?.(document);
      window.ValoraCamposLongos?.enhance?.(document);
    } catch (err) {
      console.error(err);
      toast(err.message || 'Erro ao abrir cotação.', true);
      closeModal();
    }
  }

  async function visualizarCotacao(id) {
    await abrirCotacao(id);

    if (!$('modal-cotacao-backdrop')?.hidden) {
      setCotacaoModalReadonly(true);
      if ($('modal-cotacao-titulo')) {
        const codigo = getValue('cotacao-codigo') || getValue('cotacao-codigo-ficha-principal') || '';
        $('modal-cotacao-titulo').textContent = `Visualizando cotação ${codigo}`.trim();
        $('modal-cotacao-titulo').setAttribute('data-readonly-title', 'true');
      }
    }
  }

  function payloadCotacao() {
    const customRaw = normalizeCustomFieldsPayloadRaw();

    const payload = {
      codigo: onlyDigits($('cotacao-codigo')?.value || $('cotacao-codigo-ficha-principal')?.value),
      status: $('cotacao-status')?.value || 'rascunho',
      urgencia: $('cotacao-urgencia')?.value || null,
      item_nome: normalizeText($('cotacao-item-nome')?.value),
      quantidade: normalizeText($('cotacao-quantidade')?.value),
      unidade: normalizeText($('cotacao-unidade')?.value),
      categoria: normalizeText($('cotacao-categoria')?.value),
      descricao: normalizeText($('cotacao-descricao')?.value),
      observacoes: normalizeText($('cotacao-observacoes')?.value),
      custom_fields: cleanCustomFieldsForSave(customRaw, { preservarCamposFormulario: true }),
    };

    if (state.usarFichaPrincipalCotacoes) {
      Object.assign(payload, buildBaseFromCotacaoFichaPrincipal(customRaw, payload));
      payload.custom_fields = cleanCustomFieldsForSave(customRaw);
    }

    payload.codigo = onlyDigits(payload.codigo || '');
    payload.status = normalizeStatus(payload.status);
    payload.urgencia = payload.urgencia ? normalizeUrgencia(payload.urgencia) : null;

    return payload;
  }

  async function syncFornecedores(cotacaoId) {
    setFornecedorRowsFromDOM();

    let winnerId = null;

    for (const row of state.fornecedorRows) {
      const payload = {
        fornecedor_id: row.fornecedor_id ? Number(row.fornecedor_id) : null,
        fornecedor_nome: row.fornecedor_nome || nomeFornecedorById(row.fornecedor_id) || null,
        valor_unitario: row.valor_unitario || null,
        frete: row.frete || null,
        valor_total: row.valor_total || null,
        prazo_entrega: row.prazo_entrega || null,
        condicao_pagamento: row.condicao_pagamento || null,
        observacoes: row.observacoes || null,
        vencedor: !!row.vencedor,
      };

      if (!payload.fornecedor_id && !payload.fornecedor_nome) continue;

      let saved;

      if (row.id) {
        saved = await apiJson(`${API_COTACOES}/${cotacaoId}/fornecedores/${row.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        saved = await apiJson(`${API_COTACOES}/${cotacaoId}/fornecedores`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }

      if (row.vencedor && saved?.id) winnerId = saved.id;
    }

    if (winnerId) {
      await apiJson(`${API_COTACOES}/${cotacaoId}/fornecedores/${winnerId}/vencedor`, {
        method: 'POST',
      });
    }
  }

  async function salvarCotacao() {
    if (state.modalSomenteLeitura) {
      toast('Esta cotação está aberta apenas para visualização.', true);
      return;
    }

    limparCamposObrigatoriosPendentes();

    if (!validateRequiredCustomFields()) {
      focusInvalidFieldInsideModal();
      return;
    }

    const payload = payloadCotacao();

    if (!payload.item_nome) {
      switchCotacaoTab(state.usarFichaPrincipalCotacoes ? 'tab-cotacao-campos' : 'tab-cotacao-identificacao');
      setTimeout(() => {
        const foco = state.usarFichaPrincipalCotacoes
          ? document.querySelector('[data-custom-field="item_nome"], [data-custom-field="item"], [data-custom-field="item_desejado"], [data-custom-field="produto"]')
          : $('cotacao-item-nome');
        focarCampoCotacao(foco);
      }, 80);
      toast('Informe o item desejado.', true);
      return;
    }

    if (!payload.quantidade) {
      switchCotacaoTab(state.usarFichaPrincipalCotacoes ? 'tab-cotacao-campos' : 'tab-cotacao-identificacao');
      setTimeout(() => {
        const foco = state.usarFichaPrincipalCotacoes
          ? document.querySelector('[data-custom-field="quantidade"], [data-custom-field="qtd"]')
          : $('cotacao-quantidade');
        focarCampoCotacao(foco);
      }, 80);
      toast('Informe a quantidade.', true);
      return;
    }

    const form = $('formCotacao');

    if (window.ValoraRequired?.validateContainer && form) {
      const result = window.ValoraRequired.validateContainer(form);

      if (!result.ok) {
        focusInvalidFieldInsideModal();
        return;
      }
    }

    const btn = $('btn-salvar-cotacao');
    setButtonLoading(btn, true, 'Salvando...');

    try {
      const wasNew = !state.editandoId;

      const payloadToSend = removerCodigoDoPayload(payload);

      const saved = state.editandoId
        ? await apiJson(`${API_COTACOES}/${state.editandoId}`, {
            method: 'PUT',
            body: JSON.stringify(payloadToSend),
          })
        : await apiJson(API_COTACOES, {
            method: 'POST',
            body: JSON.stringify(payloadToSend),
          });

      state.editandoId = Number(saved.id);
      await syncFornecedores(state.editandoId);

      toast('Cotação salva com sucesso.');
      closeModal();

      await carregarCotacoes({ reset: wasNew });
    } catch (err) {
      console.error(err);
      toast(err.message || 'Erro ao salvar cotação.', true);
    } finally {
      setButtonLoading(btn, false, '', '<i class="fa-solid fa-floppy-disk"></i> Salvar cotação');
    }
  }

  async function excluirCotacao(id) {
    if (!confirm('Excluir esta cotação?')) return;

    try {
      await apiJson(`${API_COTACOES}/${id}`, { method: 'DELETE' });
      toast('Cotação excluída.');
      await carregarCotacoes();
    } catch (err) {
      console.error(err);
      toast(err.message || 'Erro ao excluir cotação.', true);
    }
  }

  async function removerFornecedorRow(key) {
    const tr = $$('#tbody-cotacao-fornecedores tr[data-row-key]').find((rowEl) => rowEl.dataset.rowKey === key);
    if (!tr) return;

    const id = tr.dataset.id;

    if (id && state.editandoId) {
      if (!confirm('Remover este fornecedor da cotação?')) return;

      try {
        await apiJson(`${API_COTACOES}/${state.editandoId}/fornecedores/${id}`, { method: 'DELETE' });
      } catch (err) {
        toast(err.message || 'Erro ao remover fornecedor.', true);
        return;
      }
    }

    setFornecedorRowsFromDOM();

    state.fornecedorRows = state.fornecedorRows.filter((row) => {
      const rowKey = row.id ? `id_${row.id}` : row._tempId;
      return rowKey !== key;
    });

    if (state.fornecedorRows.length && !state.fornecedorRows.some((row) => row.vencedor)) {
      state.fornecedorRows[0].vencedor = true;
    }

    renderFornecedorRows();
  }

  async function salvarCotacaoSemFechar() {
    if (state.modalSomenteLeitura) {
      toast('Esta cotação está aberta apenas para visualização.', true);
      return null;
    }

    limparCamposObrigatoriosPendentes();

    if (!validateRequiredCustomFields()) {
      focusInvalidFieldInsideModal();
      throw new Error('Preencha os campos obrigatórios.');
    }

    const payload = payloadCotacao();

    if (!payload.item_nome) {
      switchCotacaoTab(state.usarFichaPrincipalCotacoes ? 'tab-cotacao-campos' : 'tab-cotacao-identificacao');
      throw new Error('Informe o item desejado.');
    }

    const payloadToSend = removerCodigoDoPayload(payload);

    const saved = state.editandoId
      ? await apiJson(`${API_COTACOES}/${state.editandoId}`, {
          method: 'PUT',
          body: JSON.stringify(payloadToSend),
        })
      : await apiJson(API_COTACOES, {
          method: 'POST',
          body: JSON.stringify(payloadToSend),
        });

    state.editandoId = Number(saved.id);
    await syncFornecedores(state.editandoId);
    return saved;
  }

  async function aprovarCotacao() {
    if (!state.editandoId) return;

    try {
      await salvarCotacaoSemFechar();

      const data = await apiJson(`${API_COTACOES}/${state.editandoId}/aprovar`, { method: 'POST' });

      toast('Cotação aprovada.');
      await abrirCotacao(data.id);
      await carregarCotacoes();
    } catch (err) {
      console.error(err);
      toast(err.message || 'Erro ao aprovar cotação.', true);
    }
  }

  async function converterCotacaoProduto() {
    if (!state.editandoId) return;
    if (!confirm('Converter esta cotação em produto?')) return;

    try {
      await salvarCotacaoSemFechar();

      const data = await apiJson(`${API_COTACOES}/${state.editandoId}/converter-produto`, {
        method: 'POST',
      });

      toast(data?.message || 'Cotação convertida em produto.');
      closeModal();
      await carregarCotacoes();
    } catch (err) {
      console.error(err);
      toast(err.message || 'Erro ao converter em produto.', true);
    }
  }

  function abrirGerenciarFormularioCotacoes() {
    window.location.href = '/frontend/formularios.html?modulo=cotacoes';
  }

  function debounce(fn, wait = 350) {
    let timer;

    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function bindModalBackdropClose() {
    $('modal-cotacao-backdrop')?.addEventListener('click', (event) => {
      if (event.target === $('modal-cotacao-backdrop')) closeModal();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;

      const modal = $('modal-cotacao-backdrop');
      if (!modal || modal.hidden) return;

      closeModal();
    });
  }

  function bindEvents() {
    ensureFichaCotacaoController();
    bindCotacaoTabs();
    bindModalBackdropClose();

    $('btn-nova-cotacao')?.addEventListener('click', novaCotacao);
    $('btn-atualizar-cotacoes')?.addEventListener('click', () => carregarCotacoes({ reset: true }));
    $('btn-fechar-modal-cotacao')?.addEventListener('click', closeModal);
    $('btn-cancelar-cotacao')?.addEventListener('click', closeModal);
    $('btn-salvar-cotacao')?.addEventListener('click', salvarCotacao);
    $('btn-adicionar-fornecedor-cotacao')?.addEventListener('click', addFornecedorFromInputs);
    $('btn-aprovar-cotacao')?.addEventListener('click', aprovarCotacao);
    $('btn-converter-cotacao-produto')?.addEventListener('click', converterCotacaoProduto);
    $('toggle-ficha-principal-cotacao')?.addEventListener('change', salvarToggleFichaPrincipalCotacao);
    $('btn-gerenciar-formulario-cotacao')?.addEventListener('click', abrirGerenciarFormularioCotacoes);
    $('btn-gerenciar-formulario-cotacoes-topo')?.addEventListener('click', abrirGerenciarFormularioCotacoes);

    $('busca-cotacoes')?.addEventListener('input', debounce(() => carregarCotacoes({ reset: true }), 350));
    $('filtro-status-cotacoes')?.addEventListener('change', () => carregarCotacoes({ reset: true }));

    $('cotacao-quantidade')?.addEventListener('input', () => {
      setFornecedorRowsFromDOM();
      state.fornecedorRows = state.fornecedorRows.map((row) => ({ ...row, valor_total: calcTotalRow(row) }));
      renderFornecedorRows();
    });

    document.addEventListener('click', (event) => {
      const actionBtn = event.target.closest('[data-action][data-id]');

      if (actionBtn) {
        const id = Number(actionBtn.dataset.id);
        const action = actionBtn.dataset.action;

        if (action === 'view') visualizarCotacao(id);
        if (action === 'edit') abrirCotacao(id);
        if (action === 'delete') excluirCotacao(id);
        return;
      }

      const removeBtn = event.target.closest('[data-remove-row]');
      if (removeBtn) removerFornecedorRow(removeBtn.dataset.removeRow);
    });

    document.addEventListener('input', (event) => {
      if (!event.target.closest('#tbody-cotacao-fornecedores')) return;

      setFornecedorRowsFromDOM();
      state.fornecedorRows = state.fornecedorRows.map((row) => ({ ...row, valor_total: calcTotalRow(row) }));
      renderComparativo();
    });

    document.addEventListener('change', (event) => {
      if (!event.target.closest('#tbody-cotacao-fornecedores')) return;

      setFornecedorRowsFromDOM();

      if (event.target.matches('[data-field="vencedor"]')) {
        const tr = event.target.closest('tr[data-row-key]');
        const key = tr?.dataset.rowKey;

        state.fornecedorRows = state.fornecedorRows.map((row) => {
          const rowKey = row.id ? `id_${row.id}` : row._tempId;
          return { ...row, vencedor: rowKey === key };
        });

        renderFornecedorRows();
      } else {
        renderComparativo();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();

    await Promise.all([
      carregarFornecedores(),
      carregarFormularioCotacoes(),
      carregarCotacoes({ reset: true }),
    ]);

    aplicarModoFichaCotacao();
  });
})();
