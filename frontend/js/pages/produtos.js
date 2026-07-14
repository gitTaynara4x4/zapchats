// /frontend/js/pages/produtos.js
// Produtos | Valora CRM
// Modal padrão Clientes + campos nativos + campos vindos do construtor de Formulários.

(() => {
  'use strict';

  const API_PRODUTOS = '/api/produtos';
  const MODULO_FORMULARIO = 'produtos';

  const SYSTEM_FIELD_SLUGS = new Set([
    'codigo',
    'cod_ref_id',
    'cod_ref',
    'codigo_referencia',
    'codigo_barras',
    'nome',
    'produto',
    'nome_produto',
    'nome_do_produto',
    'identificacao_do_produto',
    'identificacao_produto',
    'nome_generico',
    'descricao',
    'descricao_do_produto',
    'descricao_produto',
    'descricao_curta',
    'observacoes',
    'observacao',
    'categoria',
    'categorias',
    'classe',
    'grupo',
    'familia',
    'unidade',
    'unidade_medida',
    'preco_venda',
    'valor_de_venda',
    'custo',
    'valor_de_custo',
    'custo_efetivo',
    'estoque_atual',
    'quantidade_atual',
    'qtd_atual',
    'estoque',
    'ativo',
    'status',
    'status_atual',
    'situacao',
    'data_cadastro',
  ]);

  let produtos = [];
  let produtosPage = { offset: 0, limit: 50, total: 0, hasMore: false };
  let produtoEditandoId = null;
  let formularioProdutos = null;
  let usarFichaPrincipalProdutos = false;
  let fichaProdutoController = null;
  let produtoAtualDetalhe = null;
  let produtoModalSomenteLeitura = false;

  function $(id) {
    return document.getElementById(id);
  }

  function $$(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
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

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
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

  function setProdutoDataCadastro(dataCadastro, usarHoje = false) {
    const raw = dataCadastro || (usarHoje ? new Date().toISOString() : '');
    setValue('campo-data-cadastro-ficha-principal-produto', formatarDataCadastroSistema(raw));
  }

  function toast(message, options = {}) {
    const error = typeof options === 'boolean' ? options : !!options.error;
    const ms = typeof options === 'object' && options.ms ? Number(options.ms) : 2600;

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
    el.classList.toggle('is-error', error);
    el.classList.add('show');

    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      el.classList.remove('show');
    }, ms);
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

    const text = await resp.text();

    if (!resp.ok) {
      let message = text || 'Erro na requisição.';

      try {
        const parsed = JSON.parse(text);
        message = parsed.detail || parsed.message || message;
      } catch (_) {}

      throw new Error(typeof message === 'string' ? message : 'Erro na requisição.');
    }

    if (!text || resp.status === 204) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  async function carregarProximoCodigoProduto() {
    try {
      const data = await apiJson(`${API_PRODUTOS}/proximo-codigo`);
      return onlyDigits(data?.codigo || '');
    } catch (err) {
      console.warn('[Produtos] não foi possível carregar próximo código:', err);
      return '';
    }
  }

  function openModal(id) {
    if (window.ValoraModal) {
      return window.ValoraModal.open(id);
    }

    const modal = $(id);
    if (!modal) return;

    modal.hidden = false;
    modal.style.display = 'flex';

    requestAnimationFrame(() => {
      modal.classList.add('show');
    });
  }

  function closeModal(id) {
    if (window.ValoraModal) {
      return window.ValoraModal.close(id);
    }

    const modal = $(id);
    if (!modal) return;

    modal.classList.remove('show');

    setTimeout(() => {
      modal.hidden = true;
      modal.style.display = 'none';
    }, 160);
  }

  function normalizeCustomFields(value) {
    if (!value) return {};

    if (typeof value === 'object' && !Array.isArray(value)) {
      return { ...value };
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (_) {
        return {};
      }
    }

    return {};
  }

  function filtrarCustomFieldsSistema(customFields = {}, options = {}) {
    const clean = {};
    const preservarCamposFormulario = !!options.preservarCamposFormulario;

    Object.entries(customFields || {}).forEach(([key, value]) => {
      const slug = String(key || '').trim();
      if (!slug) return;

      // Quando o valor veio do formulário/ficha principal, ele precisa ser salvo
      // exatamente no slug do campo, mesmo que o slug tenha nome parecido com
      // campo nativo do sistema, como classe, categoria, grupo, marca, unidade,
      // situação, preço, custo etc.
      // O filtro antigo removia esses slugs e fazia o campo voltar para
      // "Selecione" ao reabrir o cadastro.
      if (!preservarCamposFormulario && SYSTEM_FIELD_SLUGS.has(slug)) return;

      clean[slug] = value;
    });

    return clean;
  }

  function limparDestaquesObrigatorios() {
    document
      .querySelectorAll('.campo-obrigatorio-pendente, .is-required-missing')
      .forEach((el) => el.classList.remove('campo-obrigatorio-pendente', 'is-required-missing'));
  }

  function marcarCampoObrigatorio(el) {
    if (!el) return;

    const group = el.closest('.form-group, .custom-field-item, .custom-checkbox, .section-card, .custom-section-card');

    el.classList.add('campo-obrigatorio-pendente', 'is-required-missing', 'valora-field-invalid');
    el.setAttribute('aria-invalid', 'true');
    if (group) group.classList.add('campo-obrigatorio-pendente', 'is-required-missing', 'is-invalid');

    setTimeout(() => {
      const target = group || el;
      try {
        target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      } catch (_) {
        target.scrollIntoView?.();
      }

      try {
        el.focus?.({ preventScroll: true });
      } catch (_) {
        el.focus?.();
      }
    }, 140);
  }

  function desativarValidacaoGlobalProduto() {
    // A validação global insere o resumo como primeiro filho do FORM.
    // Como este modal usa grid (sidebar + conteúdo), isso quebrava o layout
    // e deixava os campos obrigatórios espremidos no canto esquerdo.
    const form = $('formProduto');
    const btn = $('btn-salvar-produto');

    form?.setAttribute('data-skip-valora-validation', 'true');
    btn?.setAttribute('data-skip-valora-validation', 'true');
    btn?.removeAttribute('data-valora-submit');

    form
      ?.querySelectorAll(':scope > .valora-validation-summary')
      .forEach((el) => el.remove());
  }

  function isCampoCustomVazio(el) {
    if (!el) return false;

    const type = String(el.type || '').toLowerCase();

    if (type === 'checkbox') return !el.checked;
    if (type === 'radio' && el.name) {
      const form = el.form || document;
      return !form.querySelector(`input[type="radio"][name="${CSS.escape(el.name)}"]:checked`);
    }

    return String(el.value ?? '').trim() === '';
  }

  function abrirAbaDoCampoProduto(el) {
    if (!el) return;

    if (el.matches('[data-custom-field]') || el.closest('#tab-produto-ficha')) {
      switchProdutoTab('tab-produto-ficha');

      const card = el.closest('.custom-section-card');
      const container = $('custom-fields-container');

      if (usarFichaPrincipalProdutos && card && container && fichaProdutoController?.activateSection) {
        const cards = Array.from(container.querySelectorAll('.custom-section-card'));
        const index = Math.max(0, cards.indexOf(card));
        fichaProdutoController.activateSection(index);
      }

      return;
    }

    switchProdutoTab('tab-produto-dados');
  }

  function getCustomValue(custom, keys, fallback = '') {
    const data = normalizeCustomFields(custom);

    for (const key of keys) {
      const value = data?.[key];

      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }

    return fallback;
  }

  function firstUsefulCustomValue(custom) {
    const data = normalizeCustomFields(custom);
    const blocked = new Set([
      'data_cadastro',
      'status_atual',
      'ativo',
      'codigo',
      'cod_ref_id',
      'codigo_barras',
      'quantidade_atual',
      'estoque_atual',
      'preco_venda',
      'valor_de_custo',
      'custo',
    ]);

    for (const [key, value] of Object.entries(data)) {
      if (blocked.has(String(key))) continue;
      const text = String(value ?? '').trim();
      if (text && !/^true|false$/i.test(text) && text.length >= 2) return text;
    }

    return '';
  }

  function buildProdutoBaseFromCustom(customFields, fallback = {}) {
    const custom = normalizeCustomFields(customFields);

    const nome = getCustomValue(custom, [
      'nome',
      'produto',
      'nome_produto',
      'nome_do_produto',
      'identificacao_do_produto',
      'identificacao_produto',
      'nome_generico',
      'descricao_curta',
      'titulo',
    ], fallback.nome || '') || firstUsefulCustomValue(custom);

    const descricao = getCustomValue(custom, [
      'descricao',
      'descricao_do_produto',
      'descricao_produto',
      'observacoes',
      'observacao',
      'detalhes',
    ], fallback.descricao || '');

    const categoria = getCustomValue(custom, [
      'categoria',
      'categorias',
      'classe',
      'grupo',
      'familia',
    ], fallback.categoria || '');

    const unidade = getCustomValue(custom, [
      'unidade',
      'tipo_medida',
      'medida',
      'unidade_medida',
    ], fallback.unidade || '');

    const precoVenda = getCustomValue(custom, [
      'preco_venda',
      'preco_final_venda_tabela_01',
      'preco_final',
      'valor_venda',
      'venda',
    ], fallback.preco_venda || '');

    const custo = getCustomValue(custom, [
      'custo',
      'valor_de_custo',
      'custo_efetivo',
      'preco_custo',
    ], fallback.custo || '');

    const estoqueAtual = getCustomValue(custom, [
      'estoque_atual',
      'quantidade_atual',
      'qtd_atual',
      'estoque',
    ], fallback.estoque_atual || '');

    const statusAtual = String(getCustomValue(custom, [
      'status_atual',
      'situacao',
      'status',
    ], fallback.ativo === false ? 'inativo' : '')).toLowerCase();

    const ativo = !['inativo', 'bloqueado', 'descontinuado', 'fora de linha', 'fora_de_linha'].includes(statusAtual);

    return {
      codigo: onlyDigits(fallback.codigo || $('campo-codigo-ficha-principal-produto')?.value || ''),
      nome,
      descricao,
      categoria,
      unidade,
      preco_venda: precoVenda,
      custo,
      estoque_atual: estoqueAtual,
      ativo,
    };
  }

  function preencherAliasesCustomProduto(custom, aliases = [], value = '') {
    const text = String(value ?? '').trim();
    if (!text) return;

    aliases.forEach((slug) => {
      if (!slug) return;
      if (custom[slug] === undefined || custom[slug] === null || String(custom[slug]).trim() === '') {
        custom[slug] = text;
      }
    });
  }

  function buildCustomValuesFromProduto(produto = {}) {
    const custom = normalizeCustomFields(produto.custom_fields);
    custom.data_cadastro = produto.data_cadastro || produto.criado_em || produto.created_at || custom.data_cadastro || '';

    preencherAliasesCustomProduto(custom, [
      'nome',
      'produto',
      'nome_produto',
      'nome_do_produto',
      'identificacao_do_produto',
      'identificacao_produto',
      'nome_generico',
      'descricao_curta',
      'titulo',
    ], produto.nome);

    preencherAliasesCustomProduto(custom, [
      'descricao',
      'descricao_do_produto',
      'descricao_produto',
      'observacoes',
      'observacao',
      'detalhes',
    ], produto.descricao);

    preencherAliasesCustomProduto(custom, [
      'categoria',
      'categorias',
      'classe',
      'grupo',
      'familia',
    ], produto.categoria);

    preencherAliasesCustomProduto(custom, [
      'unidade',
      'tipo_medida',
      'medida',
      'unidade_medida',
    ], produto.unidade);

    preencherAliasesCustomProduto(custom, [
      'preco_venda',
      'preco_final_venda_tabela_01',
      'preco_final',
      'valor_venda',
      'valor_de_venda',
      'venda',
    ], produto.preco_venda);

    preencherAliasesCustomProduto(custom, [
      'custo',
      'valor_de_custo',
      'custo_efetivo',
      'preco_custo',
    ], produto.custo);

    preencherAliasesCustomProduto(custom, [
      'estoque_atual',
      'quantidade_atual',
      'qtd_atual',
      'estoque',
    ], produto.estoque_atual);

    const statusFallback = produto.ativo === false ? 'inativo' : produto.ativo === true ? 'ativo' : '';
    preencherAliasesCustomProduto(custom, [
      'status',
      'status_atual',
      'situacao',
    ], statusFallback);

    return custom;
  }

  function buildCustomValuesNovoProduto() {
    return {
      data_cadastro: todayISO(),
    };
  }

  function setProdutoFichaCode(codigo) {
    const value = onlyDigits(codigo);

    const fichaEl = $('campo-codigo-ficha-principal-produto');
    const nativeEl = $('campo-codigo-produto');

    if (fichaEl) fichaEl.value = value;
    if (nativeEl) nativeEl.value = value;

    return value;
  }

  function setValue(id, value = '') {
    const el = $(id);
    if (!el) return;
    el.value = value ?? '';
  }

  function getValue(id) {
    return String($(id)?.value ?? '').trim();
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
      }
      el.hidden = true;
      el.style.display = 'none';
      return;
    }

    if (el.dataset.readonlyTouchedHidden === 'true') {
      el.hidden = el.dataset.readonlyWasHidden === 'true';
      el.style.display = '';
      delete el.dataset.readonlyTouchedHidden;
      delete el.dataset.readonlyWasHidden;
    }
  }

  function setProdutoModalReadonly(enabled) {
    produtoModalSomenteLeitura = !!enabled;

    const backdrop = $('modal-produto-backdrop');
    const form = $('formProduto');
    const cancelBtn = $('btn-cancelar-produto');

    backdrop?.classList.toggle('modal-readonly', produtoModalSomenteLeitura);
    form?.classList.toggle('modal-readonly-form', produtoModalSomenteLeitura);

    if (form) {
      form.querySelectorAll('input, select, textarea').forEach((el) => {
        if (produtoModalSomenteLeitura) applyReadonlyElement(el);
        else restoreReadonlyElement(el);
      });
    }

    [
      'btn-salvar-produto',
      'btn-atualizar-formulario-produto',
    ].forEach((id) => setHiddenByReadonly(id, produtoModalSomenteLeitura));

    if (cancelBtn) {
      if (produtoModalSomenteLeitura) {
        cancelBtn.dataset.normalText = cancelBtn.dataset.normalText || cancelBtn.textContent || 'Cancelar';
        cancelBtn.textContent = 'Fechar';
      } else if (cancelBtn.dataset.normalText) {
        cancelBtn.textContent = cancelBtn.dataset.normalText;
      }
    }
  }

  function getProdutoNativeValues() {
    return {
      codigo: onlyDigits(getValue('campo-codigo-produto') || getValue('campo-codigo-ficha-principal-produto')),
      nome: getValue('campo-nome-produto'),
      descricao: getValue('campo-descricao-produto'),
      categoria: getValue('campo-categoria-produto'),
      unidade: getValue('campo-unidade-produto'),
      preco_venda: getValue('campo-preco-venda-produto'),
      custo: getValue('campo-custo-produto'),
      estoque_atual: getValue('campo-estoque-atual-produto'),
      ativo: getValue('campo-ativo-produto') !== 'false',
    };
  }

  function fillProdutoNativeFields(produto = {}) {
    const codigo = setProdutoFichaCode(produto.codigo || '');
    setProdutoDataCadastro(produto.criado_em || produto.data_cadastro || produto.created_at, !produto.id);

    setValue('campo-codigo-produto', codigo);
    setValue('campo-nome-produto', produto.nome || '');
    setValue('campo-descricao-produto', produto.descricao || '');
    setValue('campo-categoria-produto', produto.categoria || '');
    setValue('campo-unidade-produto', produto.unidade || '');
    setValue('campo-preco-venda-produto', produto.preco_venda || '');
    setValue('campo-custo-produto', produto.custo || '');
    setValue('campo-estoque-atual-produto', produto.estoque_atual || '');
    setValue('campo-ativo-produto', produto.ativo === false ? 'false' : 'true');
  }

  function focusProdutoNativeNome() {
    if (usarFichaPrincipalProdutos) {
      switchProdutoTab('tab-produto-ficha');
      setTimeout(() => focusFirstCustomField(), 80);
      return;
    }

    const el = $('campo-nome-produto');
    if (!el) return;

    switchProdutoTab('tab-produto-dados');

    setTimeout(() => {
      el.focus?.();
      el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, 80);
  }

  function switchProdutoTab(targetId) {
    if (!targetId) return;

    if (usarFichaPrincipalProdutos) {
      targetId = 'tab-produto-ficha';
    }

    $$('.produto-tab-btn[data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === targetId);
    });

    $$('.produto-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.id === targetId);
    });
  }

  function ensureFichaProdutoController() {
    if (fichaProdutoController || !window.ValoraFichaPrincipal?.createTabFichaController) {
      return fichaProdutoController;
    }

    fichaProdutoController = window.ValoraFichaPrincipal.createTabFichaController({
      formSelector: '#formProduto',
      tabsSelector: '.produto-tabs',
      tabButtonSelector: '.produto-tab-btn',
      tabPanelSelector: '.produto-tab',
      customTabId: 'tab-produto-ficha',
      customContainerSelector: '#custom-fields-container',
      codeCardSelector: '#produto-ficha-principal-code',
      toggleSelector: '#toggle-ficha-principal-produto',
      normalTabId: 'tab-produto-dados',
      buttonClass: 'produto-tab-btn',
    });

    fichaProdutoController.bindSectionClicks();
    return fichaProdutoController;
  }

  function aplicarModoFichaProduto() {
    const controller = ensureFichaProdutoController();

    if (controller) {
      controller.setMode(usarFichaPrincipalProdutos);
      return;
    }

    const form = $('formProduto');
    const toggle = $('toggle-ficha-principal-produto');
    const codeCard = $('produto-ficha-principal-code');

    if (form) form.classList.toggle('is-ficha-principal', !!usarFichaPrincipalProdutos);
    if (toggle) toggle.checked = !!usarFichaPrincipalProdutos;
    if (codeCard) codeCard.hidden = !usarFichaPrincipalProdutos;

    if (usarFichaPrincipalProdutos) {
      switchProdutoTab('tab-produto-ficha');
    }
  }

  function renderFormularioCabecalho() {
    const nomeEl = $('produto-formulario-nome');
    const descEl = $('produto-formulario-descricao');
    const descTopEl = $('produto-formulario-descricao-topo');
    const modelo = formularioProdutos?.modelo || null;

    const nome = modelo?.nome || 'Ficha do produto';
    const descricao = modelo?.descricao || 'Cadastro completo do produto organizado por seções.';

    if (nomeEl) nomeEl.textContent = nome;
    if (descEl) descEl.textContent = modelo ? descricao : 'Nenhum formulário de produtos carregado.';
    if (descTopEl) descTopEl.textContent = modelo ? descricao : 'Crie um formulário para Produtos em Configurações > Formulários.';
  }

  async function carregarFormularioProdutos({ loadingContainer = null, forceRefresh = false } = {}) {
    const container = loadingContainer || '#custom-fields-container';

    try {
      if (!window.ValoraFichaPrincipal) {
        throw new Error('Componente de ficha principal não carregado.');
      }

      window.ValoraFichaPrincipal.showLoading?.(
        container,
        'Carregando formulário de Produtos...',
        'Buscando seções e campos configurados no construtor de formulários.'
      );

      const formulario = await window.ValoraFichaPrincipal.carregarFormularioModulo(MODULO_FORMULARIO, {
        apiJsonImpl: apiJson,
        ativo: true,
        forceRefresh,
        loadingContainer: container,
      });

      formularioProdutos = formulario;
      usarFichaPrincipalProdutos = !!formulario?.modelo?.usar_como_ficha_principal;

      renderFormularioCabecalho();
      return formulario;
    } catch (err) {
      console.error('[Produtos] erro ao carregar formulário:', err);
      formularioProdutos = null;
      usarFichaPrincipalProdutos = false;
      renderFormularioCabecalho();
      throw err;
    }
  }

  async function renderCustomFieldsInputs(values = {}, { forceRefresh = false } = {}) {
    const container = $('custom-fields-container');
    if (!container) return;

    if (!window.ValoraFichaPrincipal) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1 / -1;">
          Não foi possível carregar o componente de ficha principal.
        </div>
      `;
      return;
    }

    if (!formularioProdutos?.modelo || forceRefresh) {
      await carregarFormularioProdutos({
        loadingContainer: container,
        forceRefresh,
      });
    }

    window.ValoraFichaPrincipal.renderCustomFormSections({
      container,
      formulario: formularioProdutos,
      camposAvulsos: [],
      values,
      usarFichaPrincipal: usarFichaPrincipalProdutos,
      flatTitle: 'Ficha do produto',
      flatDescription: 'Campos extras do cadastro de produtos.',
      emptyMessage: formularioProdutos?.modelo
        ? 'Nenhum campo ativo neste formulário de produtos.'
        : 'Nenhum formulário de Produtos encontrado. Crie um formulário em Configurações > Formulários.',
    });

    aplicarModoFichaProduto();

    if (!usarFichaPrincipalProdutos) {
      const activeTab = $('formProduto')?.querySelector('.produto-tab.active');
      if (!activeTab) {
        switchProdutoTab('tab-produto-dados');
      }
    }

    if (window.ValoraRequired?.refresh) {
      window.ValoraRequired.refresh(container);
    }
  }

  function collectCustomFieldsValues() {
    if (window.ValoraFichaPrincipal?.collectCustomFieldsValues) {
      return window.ValoraFichaPrincipal.collectCustomFieldsValues($('formProduto') || document);
    }

    const values = {};

    $$('[data-custom-field]', $('formProduto') || document).forEach((el) => {
      const key = el.getAttribute('data-custom-field');
      if (!key) return;

      if (el.type === 'checkbox') {
        values[key] = el.checked ? 'true' : 'false';
        return;
      }

      const value = String(el.value ?? '').trim();
      if (value !== '') values[key] = value;
    });

    return values;
  }

  function focusFirstCustomField() {
    const first = $('formProduto')?.querySelector('[data-custom-field]:not([disabled])');
    first?.focus?.();
    first?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }

  function validarCamposFormulario() {
    desativarValidacaoGlobalProduto();

    const form = $('formProduto') || document;
    const obrigatorios = Array.from(
      form.querySelectorAll('[data-custom-field][data-required="true"]')
    ).filter((el) => !el.disabled && !el.readOnly);

    const primeiroVazio = obrigatorios.find(isCampoCustomVazio);

    if (!primeiroVazio) return true;

    const label =
      primeiroVazio.dataset.customLabel ||
      primeiroVazio.getAttribute('aria-label') ||
      primeiroVazio.getAttribute('data-custom-field') ||
      'campo obrigatório';

    toast(`Preencha o campo obrigatório: ${label}`, { error: true, ms: 5200 });
    abrirAbaDoCampoProduto(primeiroVazio);
    marcarCampoObrigatorio(primeiroVazio);

    return false;
  }

  async function salvarToggleFichaPrincipalProduto(event) {
    const checked = !!event.target.checked;

    try {
      if (!window.ValoraFichaPrincipal) {
        throw new Error('Componente de ficha principal não carregado.');
      }

      if (!formularioProdutos?.modelo?.id) {
        await carregarFormularioProdutos({ loadingContainer: '#custom-fields-container' });
      }

      const modelo = formularioProdutos?.modelo;

      if (!modelo?.id) {
        event.target.checked = false;
        toast('Nenhum formulário de Produtos encontrado para ativar como ficha principal.', {
          error: true,
          ms: 4200,
        });
        return;
      }

      event.target.disabled = true;

      const valoresAtuais = collectCustomFieldsValues();

      window.ValoraFichaPrincipal.showLoading?.(
        '#custom-fields-container',
        checked ? 'Montando ficha principal...' : 'Voltando para o cadastro padrão...'
      );

      const atualizado = await window.ValoraFichaPrincipal.atualizarFichaPrincipalModelo(modelo, checked, {
        apiJsonImpl: apiJson,
        moduloFallback: MODULO_FORMULARIO,
      });

      usarFichaPrincipalProdutos = checked;
      formularioProdutos = {
        ...formularioProdutos,
        modelo: {
          ...modelo,
          ...(atualizado || {}),
          usar_como_ficha_principal: checked,
        },
      };

      await renderCustomFieldsInputs(valoresAtuais);
      aplicarModoFichaProduto();

      toast(
        checked
          ? 'Ficha principal ativada para Produtos.'
          : 'Ficha principal desativada para Produtos.',
        { ms: 2200 }
      );
    } catch (err) {
      event.target.checked = !checked;
      toast(err.message || 'Erro ao alterar ficha principal.', {
        error: true,
        ms: 4500,
      });
    } finally {
      event.target.disabled = false;
    }
  }

  function montarUrlProdutos({ offset = produtosPage.offset || 0, limit = produtosPage.limit || 50 } = {}) {
    const params = new URLSearchParams();
    const busca = String($('busca-produtos')?.value || '').trim();
    const categoria = String($('filtro-categoria-produtos')?.value || '').trim();
    const ativo = String($('filtro-ativo-produtos')?.value || '').trim();

    params.set('paginated', 'true');
    params.set('limit', String(limit));
    params.set('offset', String(offset));

    if (busca) params.set('busca', busca);
    if (categoria) params.set('categoria', categoria);
    if (ativo) params.set('ativo', ativo);

    window.ValoraLocalizarPersonalizado?.addParams?.(params, 'localizar-personalizado-produtos');

    return `${API_PRODUTOS}?${params.toString()}`;
  }

  function setProdutosLoading(message = 'Buscando produtos no banco...') {
    const tbody = $('tbody-produtos');
    if (!tbody) return;

    tbody.innerHTML = `
      <tr>
        <td colspan="${6 + getCamposTabelaProdutos().length}" class="empty-state" style="border:none; text-align:center;">
          ${escapeHtml(message)}
        </td>
      </tr>
    `;
  }

  async function carregarProdutos({ offset = produtosPage.offset || 0, silent = false } = {}) {
    try {
      if (!silent) setProdutosLoading();

      const data = await apiJson(montarUrlProdutos({ offset }));

      if (Array.isArray(data)) {
        produtos = data;
        produtosPage = {
          offset: 0,
          limit: data.length || 50,
          total: data.length,
          hasMore: false,
        };
      } else {
        produtos = Array.isArray(data?.items) ? data.items : [];
        produtosPage = {
          offset: Number(data?.offset || 0),
          limit: Number(data?.limit || 50),
          total: Number(data?.total || produtos.length),
          hasMore: !!data?.has_more,
        };
      }
    } catch (err) {
      produtos = [];
      toast(err.message || 'Erro ao carregar produtos.', { error: true, ms: 4200 });
    }

    renderTabelaProdutos();
  }

  async function obterProdutoNoServidor(id) {
    return apiJson(`${API_PRODUTOS}/${id}`);
  }

  async function salvarProdutoNoServidor(payload, editandoId) {
    const url = editandoId == null ? API_PRODUTOS : `${API_PRODUTOS}/${editandoId}`;
    const method = editandoId == null ? 'POST' : 'PUT';

    const cleanPayload = {
      ...(payload || {}),
      custom_fields: normalizeCustomFields(payload?.custom_fields || {}),
    };

    // Código é do sistema: aparece na tela, mas não é editável nem confiável no payload.
    delete cleanPayload.codigo;

    return apiJson(url, {
      method,
      body: JSON.stringify(cleanPayload),
    });
  }

  async function excluirProdutoNoServidor(id) {
    return apiJson(`${API_PRODUTOS}/${id}`, {
      method: 'DELETE',
    });
  }

  function formatCurrency(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '-';
    const normalized = raw.replace(/R\$/gi, '').replace(/\./g, '').replace(',', '.').trim();
    const n = Number(normalized);
    if (!Number.isFinite(n)) return raw;
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  const DEFAULT_NATIVE_COLUMNS_PRODUTOS = [
    { key: 'codigo', label: 'Código' },
    { key: 'produto', label: 'Produto' },
    { key: 'categoria', label: 'Categoria' },
    { key: 'preco', label: 'Preço' },
    { key: 'estoque', label: 'Estoque' },
    { key: 'acoes', label: 'Ações', fixed: true },
  ];

  function getCamposTabelaProdutos() {
    return window.ValoraLocalizarPersonalizado?.getTableFields?.('produtos') || [];
  }

  function getColunasNativasProdutos() {
    const columns = window.ValoraLocalizarPersonalizado?.getNativeColumns?.('produtos');
    return Array.isArray(columns) && columns.length ? columns : DEFAULT_NATIVE_COLUMNS_PRODUTOS;
  }

  function dividirColunasNativasProdutos(columns) {
    const beforeDynamic = [];
    const afterDynamic = [];

    columns.forEach((col) => {
      if (col.key === 'acoes') {
        afterDynamic.push(col);
      } else {
        beforeDynamic.push(col);
      }
    });

    return { beforeDynamic, afterDynamic };
  }

  function renderHeadersProdutos(nativeColumns, fields) {
    const row = document.querySelector('.valora-table thead tr');
    if (!row) return;

    const { beforeDynamic, afterDynamic } = dividirColunasNativasProdutos(nativeColumns);

    row.innerHTML = `
      ${beforeDynamic.map((col) => `<th>${escapeHtml(col.label || col.key)}</th>`).join('')}
      ${fields.map((field) => `<th>${escapeHtml(field.label || field.key)}</th>`).join('')}
      ${afterDynamic.map((col) => `<th class="${col.key === 'acoes' ? 'text-right' : ''}">${escapeHtml(col.label || col.key)}</th>`).join('')}
    `;
  }

  function renderCamposTabelaProdutos(produto, fields) {
    return fields
      .map((field) => `<td>${escapeHtml(window.ValoraLocalizarPersonalizado?.formatValue?.(produto, field) || '-')}</td>`)
      .join('');
  }

  function renderAcoesProduto(produto) {
    return `
      <td class="text-right">
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button class="btn-icon" data-action="editar" data-id="${escapeHtml(produto.id)}" title="Editar produto">
            <i class="fa-solid fa-pen"></i>
          </button>

          <button class="btn-icon danger" data-action="excluir" data-id="${escapeHtml(produto.id)}" title="Excluir produto">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </td>
    `;
  }

  function renderCelulaNativaProduto(produto, key) {
    switch (key) {
      case 'codigo':
        return `<td><span class="badge-codigo">${escapeHtml(produto.codigo || '-')}</span></td>`;
      case 'produto':
        return `
          <td>
            <button
              type="button"
              class="table-name-link produto-main"
              data-action="visualizar"
              data-id="${escapeHtml(produto.id)}"
              title="Visualizar produto"
            >
              <strong>${escapeHtml(produto.nome || '-')}</strong>
              ${produto.descricao ? `<span>${escapeHtml(produto.descricao)}</span>` : ''}
            </button>
          </td>
        `;
      case 'categoria':
        return `<td>${escapeHtml(produto.categoria || '-')}</td>`;
      case 'preco':
        return `<td>${escapeHtml(formatCurrency(produto.preco_venda || ''))}</td>`;
      case 'estoque':
        return `<td>${escapeHtml(produto.estoque_atual || '-')}</td>`;
      case 'acoes':
        return renderAcoesProduto(produto);
      default:
        return '';
    }
  }

  function renderTabelaProdutos() {
    const tbody = $('tbody-produtos');
    const spanCount = $('contagem-produtos');

    if (!tbody) return;

    const dynamicFields = getCamposTabelaProdutos();
    const nativeColumns = getColunasNativasProdutos();
    const { beforeDynamic, afterDynamic } = dividirColunasNativasProdutos(nativeColumns);
    renderHeadersProdutos(nativeColumns, dynamicFields);
    const colspan = nativeColumns.length + dynamicFields.length;

    if (!produtos.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="${colspan}" class="empty-state">Nenhum produto encontrado.</td>
        </tr>
      `;

      if (spanCount) spanCount.textContent = '0 produtos';
      renderPaginacaoProdutos();
      return;
    }

    tbody.innerHTML = produtos.map((produto) => `
      <tr>
        ${beforeDynamic.map((col) => renderCelulaNativaProduto(produto, col.key)).join('')}
        ${renderCamposTabelaProdutos(produto, dynamicFields)}
        ${afterDynamic.map((col) => renderCelulaNativaProduto(produto, col.key)).join('')}
      </tr>
    `).join('');

    if (spanCount) {
      const total = Number(produtosPage.total || produtos.length || 0);
      const ini = total ? Number(produtosPage.offset || 0) + 1 : 0;
      const fim = Math.min(Number(produtosPage.offset || 0) + produtos.length, total);

      spanCount.textContent = total === produtos.length
        ? (produtos.length === 1 ? '1 produto' : `${produtos.length} produtos`)
        : `${ini}-${fim} de ${total} produtos`;
    }

    renderPaginacaoProdutos();
  }

  function renderPaginacaoProdutos() {
    const wraps = document.querySelectorAll('[data-pagination="produtos"]');
    if (!wraps.length) return;

    const offset = Number(produtosPage.offset || 0);
    const limit = Number(produtosPage.limit || 50);
    const total = Number(produtosPage.total || 0);
    const atual = total ? Math.floor(offset / limit) + 1 : 1;
    const paginas = Math.max(1, Math.ceil(total / limit));

    const html = `
      <button class="btn btn-secondary btn-sm" type="button" data-page-action="prev" ${offset <= 0 ? 'disabled' : ''}>Anterior</button>
      <span class="pagination-info">Página ${atual} de ${paginas}</span>
      <button class="btn btn-secondary btn-sm" type="button" data-page-action="next" ${!produtosPage.hasMore ? 'disabled' : ''}>Próxima</button>
    `;

    wraps.forEach((wrap) => {
      wrap.innerHTML = html;
    });
  }

  function abrirModalProduto() {
    openModal('modal-produto-backdrop');
  }

  function fecharModalProduto() {
    setProdutoModalReadonly(false);
    closeModal('modal-produto-backdrop');
    produtoEditandoId = null;
    produtoAtualDetalhe = null;
  }

  async function abrirModalProdutoNovo() {
    setProdutoModalReadonly(false);
    desativarValidacaoGlobalProduto();
    const titulo = $('modal-produto-titulo');
    if (titulo) titulo.textContent = 'Novo produto';

    produtoEditandoId = null;
    produtoAtualDetalhe = null;

    const proximoCodigo = await carregarProximoCodigoProduto();
    fillProdutoNativeFields({ codigo: proximoCodigo, ativo: true });

    const values = buildCustomValuesNovoProduto();
    await renderCustomFieldsInputs(values);
    aplicarModoFichaProduto();

    abrirModalProduto();
    setProdutoModalReadonly(false);

    setTimeout(() => {
      if (usarFichaPrincipalProdutos) {
        switchProdutoTab('tab-produto-ficha');
        focusFirstCustomField();
      } else {
        switchProdutoTab('tab-produto-dados');
        focusProdutoNativeNome();
      }
    }, 120);
  }

  async function abrirModalProdutoEditar(produto) {
    desativarValidacaoGlobalProduto();
    const titulo = $('modal-produto-titulo');
    if (titulo) titulo.textContent = 'Editar produto';

    produtoEditandoId = produto.id;
    produtoAtualDetalhe = produto;

    fillProdutoNativeFields(produto);

    const values = buildCustomValuesFromProduto(produto);
    await renderCustomFieldsInputs(values);
    aplicarModoFichaProduto();

    abrirModalProduto();
    setProdutoModalReadonly(false);

    setTimeout(() => {
      switchProdutoTab(usarFichaPrincipalProdutos ? 'tab-produto-ficha' : 'tab-produto-dados');
    }, 80);
  }


  async function abrirModalProdutoVisualizar(produto) {
    try {
      desativarValidacaoGlobalProduto();
      const titulo = $('modal-produto-titulo');
      if (titulo) titulo.textContent = 'Visualizar produto';

      produtoEditandoId = produto.id;
      produtoAtualDetalhe = produto;

      fillProdutoNativeFields(produto);

      const values = buildCustomValuesFromProduto(produto);
      await renderCustomFieldsInputs(values);
      aplicarModoFichaProduto();

      abrirModalProduto();
      setProdutoModalReadonly(true);

      setTimeout(() => {
        switchProdutoTab(usarFichaPrincipalProdutos ? 'tab-produto-ficha' : 'tab-produto-dados');
      }, 80);
    } catch (err) {
      console.error('[Produtos] erro ao visualizar produto:', err);
      toast(err.message || 'Não foi possível visualizar o produto.', { error: true, ms: 5000 });
    }
  }

  function buildPayloadProduto() {
    const customFields = collectCustomFieldsValues();
    const nativeFields = getProdutoNativeValues();
    const customFallback = buildProdutoBaseFromCustom(customFields, produtoAtualDetalhe || {});

    const base = usarFichaPrincipalProdutos
      ? {
          ...customFallback,
          codigo: onlyDigits(customFallback.codigo || nativeFields.codigo || ''),
        }
      : {
          ...customFallback,
          ...nativeFields,
          nome: nativeFields.nome || customFallback.nome || '',
          descricao: nativeFields.descricao || customFallback.descricao || '',
          categoria: nativeFields.categoria || customFallback.categoria || '',
          unidade: nativeFields.unidade || customFallback.unidade || '',
          preco_venda: nativeFields.preco_venda || customFallback.preco_venda || '',
          custo: nativeFields.custo || customFallback.custo || '',
          estoque_atual: nativeFields.estoque_atual || customFallback.estoque_atual || '',
        };

    return {
      ...base,
      codigo: onlyDigits(base.codigo),
      custom_fields: filtrarCustomFieldsSistema(customFields, { preservarCamposFormulario: true }),
    };
  }

  async function salvarProduto() {
    if (produtoModalSomenteLeitura) {
      toast('Este produto está aberto apenas para visualização.', { error: true, ms: 3000 });
      return;
    }

    desativarValidacaoGlobalProduto();
    limparDestaquesObrigatorios();

    const payload = buildPayloadProduto();

    if (!payload.nome) {
      toast(
        usarFichaPrincipalProdutos
          ? 'Preencha no formulário um campo de identificação/nome do produto.'
          : 'Preencha o nome do produto.',
        { error: true, ms: 4200 }
      );

      if (usarFichaPrincipalProdutos) {
        switchProdutoTab('tab-produto-ficha');
        setTimeout(() => {
          const first = $('formProduto')?.querySelector('[data-custom-field]:not([disabled])');
          if (first) marcarCampoObrigatorio(first);
          else focusFirstCustomField();
        }, 80);
      } else {
        const nomeEl = $('campo-nome-produto');
        if (nomeEl) marcarCampoObrigatorio(nomeEl);
        focusProdutoNativeNome();
      }

      return;
    }

    const requiredOk = validarCamposFormulario();
    if (!requiredOk) return;

    const btn = $('btn-salvar-produto');
    const original = btn ? btn.innerHTML : '';

    try {
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Salvando...';
      }

      await salvarProdutoNoServidor(payload, produtoEditandoId);
      await carregarProdutos();

      fecharModalProduto();
      toast('Produto salvo com sucesso.', { ms: 1800 });
    } catch (err) {
      console.error('[Produtos] erro ao salvar:', err);
      toast(err.message || 'Erro ao salvar produto.', { error: true, ms: 5200 });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = original || '<i class="fa-solid fa-floppy-disk"></i> Salvar produto';
      }
    }
  }

  let _confirmResolver = null;

  function confirmDialog({
    title = 'Confirmar',
    message = 'Tem certeza?',
    confirmText = 'OK',
    cancelText = 'Cancelar',
    danger = false,
  } = {}) {
    const backdrop = $('Valora-confirm-backdrop');
    const titleEl = $('Valora-confirm-title');
    const msgEl = $('Valora-confirm-message');
    const okBtn = $('Valora-confirm-ok');
    const cancelBtn = $('Valora-confirm-cancel');

    if (!backdrop || !okBtn || !cancelBtn) {
      return Promise.resolve(window.confirm(message));
    }

    titleEl.textContent = title || 'Confirmar';
    msgEl.textContent = message || 'Tem certeza?';
    okBtn.textContent = confirmText || 'OK';
    cancelBtn.textContent = cancelText || 'Cancelar';

    okBtn.classList.toggle('danger-action', !!danger);

    openModal('Valora-confirm-backdrop');

    return new Promise((resolve) => {
      _confirmResolver = resolve;
    });
  }

  function closeConfirm(result = false) {
    closeModal('Valora-confirm-backdrop');

    if (typeof _confirmResolver === 'function') {
      const fn = _confirmResolver;
      _confirmResolver = null;
      fn(!!result);
    }
  }

  function downloadFile(filename, content, mime = 'application/octet-stream') {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = filename;

    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function pickProdutosForExport() {
    return (produtos || []).map((p) => ({
      id: p.id ?? null,
      codigo: p.codigo ?? '',
      nome: p.nome ?? '',
      descricao: p.descricao ?? '',
      categoria: p.categoria ?? '',
      unidade: p.unidade ?? '',
      preco_venda: p.preco_venda ?? '',
      custo: p.custo ?? '',
      estoque_atual: p.estoque_atual ?? '',
      ativo: p.ativo ?? true,
      custom_fields: normalizeCustomFields(p.custom_fields),
    }));
  }

  function exportarProdutosJSON() {
    const dt = new Date();
    const stamp = dt.toISOString().slice(0, 19).replaceAll(':', '-');

    const payload = {
      exported_at: dt.toISOString(),
      formulario: formularioProdutos?.modelo || null,
      total: (produtos || []).length,
      items: pickProdutosForExport(),
    };

    downloadFile(
      `produtos_${stamp}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8'
    );

    toast('Exportado JSON.', { ms: 1800 });
  }

  function csvEscape(value) {
    const s = String(value ?? '');
    const must = /[;\n\r"]/g.test(s);
    const out = s.replaceAll('"', '""');
    return must ? `"${out}"` : out;
  }

  function flattenCustomKeys(items = []) {
    const out = new Set();
    items.forEach((item) => {
      Object.keys(normalizeCustomFields(item.custom_fields)).forEach((key) => out.add(key));
    });
    return Array.from(out);
  }

  function exportarProdutosCSV() {
    const dt = new Date();
    const stamp = dt.toISOString().slice(0, 19).replaceAll(':', '-');
    const items = pickProdutosForExport();
    const baseCols = ['codigo', 'nome', 'descricao', 'categoria', 'unidade', 'preco_venda', 'custo', 'estoque_atual', 'ativo'];
    const customCols = flattenCustomKeys(items);
    const cols = [...baseCols, ...customCols];
    const lines = [cols.join(';')];

    items.forEach((produto) => {
      const custom = normalizeCustomFields(produto.custom_fields);
      lines.push(cols.map((key) => {
        if (baseCols.includes(key)) return csvEscape(produto?.[key] ?? '');
        return csvEscape(custom?.[key] ?? '');
      }).join(';'));
    });

    downloadFile(
      `produtos_${stamp}.csv`,
      '\ufeff' + lines.join('\n'),
      'text/csv;charset=utf-8'
    );

    toast('Exportado CSV.', { ms: 1800 });
  }

  function parseCSV(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = raw.split('\n').filter((line) => line.trim().length);

    if (!lines.length) return [];

    const firstLine = lines[0];
    const semicolon = (firstLine.match(/;/g) || []).length;
    const comma = (firstLine.match(/,/g) || []).length;
    const delim = semicolon >= comma ? ';' : ',';

    function parseLine(line) {
      const out = [];
      let cur = '';
      let inQuotes = false;

      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];

        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else {
            inQuotes = !inQuotes;
          }
          continue;
        }

        if (!inQuotes && ch === delim) {
          out.push(cur);
          cur = '';
          continue;
        }

        cur += ch;
      }

      out.push(cur);
      return out.map((v) => v.trim());
    }

    const headers = parseLine(lines[0]).map((h) => slugify(h));

    return lines.slice(1).map((line) => {
      const vals = parseLine(line);
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = vals[idx] ?? '';
      });
      return obj;
    });
  }

  function parseXLSX(arrayBuffer) {
    if (!window.XLSX) {
      throw new Error('Biblioteca XLSX não carregada.');
    }

    const workbook = window.XLSX.read(arrayBuffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    return window.XLSX.utils.sheet_to_json(sheet, { defval: '' });
  }

  async function importarProdutosArquivo(file) {
    if (!file) {
      toast('Selecione um arquivo para importar.', { error: true });
      return;
    }

    try {
      const lower = String(file.name || '').toLowerCase();
      let items = [];

      if (lower.endsWith('.json')) {
        const text = await file.text();
        const data = JSON.parse(text || '{}');
        items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
      } else if (lower.endsWith('.xlsx')) {
        const buffer = await file.arrayBuffer();
        items = parseXLSX(buffer);
      } else {
        const text = await file.text();
        items = parseCSV(text);
      }

      if (!Array.isArray(items) || !items.length) {
        toast('Arquivo vazio ou inválido.', { error: true });
        return;
      }

      const ok = await confirmDialog({
        title: 'Importar produtos',
        message: `Importar ${items.length} produto(s)?`,
        confirmText: 'Importar',
        cancelText: 'Cancelar',
      });

      if (!ok) return;

      let success = 0;
      let fail = 0;

      for (const raw of items) {
        try {
          const normalized = {};
          Object.entries(raw || {}).forEach(([key, value]) => {
            normalized[slugify(key)] = value;
          });

          const base = buildProdutoBaseFromCustom(normalized, normalized);
          const payload = {
            ...base,
            custom_fields: filtrarCustomFieldsSistema(normalized),
          };

          if (!payload.nome) {
            fail += 1;
            continue;
          }

          await salvarProdutoNoServidor(payload, null);
          success += 1;
        } catch (_) {
          fail += 1;
        }
      }

      await carregarProdutos({ offset: 0 });

      toast(
        `Importação concluída: ${success} sucesso(s)${fail ? ` • ${fail} falha(s)` : ''}`,
        { error: !!fail, ms: 3800 }
      );
    } catch (err) {
      console.error('[Produtos] erro ao importar:', err);
      toast(err.message || 'Erro ao importar arquivo.', { error: true, ms: 5000 });
    }
  }

  function abrirGerenciadorFormulario() {
    window.location.href = '/frontend/formularios.html?modulo=produtos';
  }

  async function atualizarFormularioProduto() {
    const valoresAtuais = collectCustomFieldsValues();
    await carregarFormularioProdutos({ loadingContainer: '#custom-fields-container', forceRefresh: true });
    await renderCustomFieldsInputs(valoresAtuais);
    toast('Ficha de Produtos atualizada.', { ms: 1800 });
  }

  function bindEventos() {
    desativarValidacaoGlobalProduto();
    const modalProdutoBackdrop = $('modal-produto-backdrop');
    const confirmBackdrop = $('Valora-confirm-backdrop');

    ensureFichaProdutoController();

    document.addEventListener('click', (event) => {
      const tabBtn = event.target.closest('.produto-tab-btn[data-tab]');
      if (!tabBtn) return;
      switchProdutoTab(tabBtn.dataset.tab);
    });

    $('Valora-confirm-cancel')?.addEventListener('click', () => closeConfirm(false));
    $('Valora-confirm-ok')?.addEventListener('click', () => closeConfirm(true));

    confirmBackdrop?.addEventListener('click', (event) => {
      if (event.target === confirmBackdrop) closeConfirm(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;

      if (confirmBackdrop?.classList.contains('show')) {
        closeConfirm(false);
        return;
      }

      if (modalProdutoBackdrop?.classList.contains('show')) {
        fecharModalProduto();
      }
    });

    let produtosBuscaTimer = null;

    const recarregarProdutosFiltro = (delay = 350) => {
      clearTimeout(produtosBuscaTimer);
      produtosBuscaTimer = setTimeout(() => {
        carregarProdutos({ offset: 0, silent: true });
      }, delay);
    };

    $('busca-produtos')?.addEventListener('input', () => recarregarProdutosFiltro(350));
    $('filtro-categoria-produtos')?.addEventListener('input', () => recarregarProdutosFiltro(350));
    $('filtro-ativo-produtos')?.addEventListener('change', () => recarregarProdutosFiltro(0));
    window.ValoraLocalizarPersonalizado?.bindFilters?.('localizar-personalizado-produtos', () => recarregarProdutosFiltro(0));

    $('btn-filtrar-produtos')?.addEventListener('click', () => carregarProdutos({ offset: 0 }));
    $('btn-limpar-filtros-produtos')?.addEventListener('click', () => {
      if ($('busca-produtos')) $('busca-produtos').value = '';
      if ($('filtro-categoria-produtos')) $('filtro-categoria-produtos').value = '';
      if ($('filtro-ativo-produtos')) $('filtro-ativo-produtos').value = '';
      window.ValoraLocalizarPersonalizado?.clearFilters?.('localizar-personalizado-produtos');
      carregarProdutos({ offset: 0 });
    });

    document.querySelectorAll('[data-pagination="produtos"]').forEach((wrap) => {
      wrap.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-page-action]');
        if (!btn || btn.disabled) return;

        const limit = Number(produtosPage.limit || 50);
        let offset = Number(produtosPage.offset || 0);

        if (btn.dataset.pageAction === 'prev') offset = Math.max(0, offset - limit);
        if (btn.dataset.pageAction === 'next') offset += limit;

        carregarProdutos({ offset });
      });
    });

    $('btn-novo-produto')?.addEventListener('click', abrirModalProdutoNovo);
    $('btn-fechar-modal-produto')?.addEventListener('click', fecharModalProduto);
    $('btn-cancelar-produto')?.addEventListener('click', fecharModalProduto);
    $('btn-salvar-produto')?.addEventListener('click', salvarProduto);
    $('toggle-ficha-principal-produto')?.addEventListener('change', salvarToggleFichaPrincipalProduto);
    $('btn-atualizar-formulario-produto')?.addEventListener('click', atualizarFormularioProduto);
    $('btn-gerenciar-formulario-produto')?.addEventListener('click', abrirGerenciadorFormulario);

    $('formProduto')?.addEventListener('submit', (event) => {
      event.preventDefault();
      salvarProduto();
    });

    modalProdutoBackdrop?.addEventListener('click', (event) => {
      if (event.target === modalProdutoBackdrop) fecharModalProduto();
    });

    $('btn-exportar-produtos-json')?.addEventListener('click', exportarProdutosJSON);
    $('btn-exportar-produtos-csv')?.addEventListener('click', exportarProdutosCSV);

    const inputImport = $('input-importar-produtos');

    $('btn-importar-produtos')?.addEventListener('click', () => {
      if (inputImport) inputImport.click();
      else toast('Faltou o input de importação.', { error: true, ms: 4200 });
    });

    inputImport?.addEventListener('change', async () => {
      const file = inputImport.files && inputImport.files[0] ? inputImport.files[0] : null;
      await importarProdutosArquivo(file);
      inputImport.value = '';
    });

    $('tbody-produtos')?.addEventListener('click', async (event) => {
      const btn = event.target.closest('[data-action][data-id]');
      if (!btn) return;

      const action = btn.dataset.action;
      const id = Number(btn.dataset.id);
      if (!id) return;

      if (action === 'visualizar') {
        try {
          const full = await obterProdutoNoServidor(id);
          await abrirModalProdutoVisualizar(full);
        } catch (err) {
          console.error('[Produtos] erro ao abrir produto:', err);
          toast(err.message || 'Não foi possível abrir o produto.', { error: true, ms: 5000 });
        }
        return;
      }

      if (action === 'editar') {
        try {
          const full = await obterProdutoNoServidor(id);
          await abrirModalProdutoEditar(full);
        } catch (err) {
          console.error('[Produtos] erro ao abrir produto:', err);
          toast(err.message || 'Não foi possível abrir o produto.', { error: true, ms: 5000 });
        }
        return;
      }

      if (action === 'excluir') {
        const ok = await confirmDialog({
          title: 'Excluir produto',
          message: 'Deseja realmente excluir este produto?',
          confirmText: 'Excluir',
          cancelText: 'Cancelar',
          danger: true,
        });

        if (!ok) return;

        try {
          await excluirProdutoNoServidor(id);
          await carregarProdutos();
          toast('Produto excluído.', { ms: 1800 });
        } catch (err) {
          console.error('[Produtos] erro ao excluir:', err);
          toast(err.message || 'Erro ao excluir produto.', { error: true, ms: 5000 });
        }
      }
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEventos();

    try {
      await carregarFormularioProdutos({ loadingContainer: '#custom-fields-container' });
      await window.ValoraLocalizarPersonalizado?.setup?.({
        modulo: 'produtos',
        filtersContainerId: 'localizar-personalizado-produtos',
      });
      await renderCustomFieldsInputs({});
      await carregarProdutos();
    } catch (err) {
      console.error('[Produtos] erro ao iniciar:', err);
      await carregarProdutos();
      toast(err.message || 'Erro ao carregar ficha de produtos.', { error: true, ms: 5000 });
    }
  });
})();
