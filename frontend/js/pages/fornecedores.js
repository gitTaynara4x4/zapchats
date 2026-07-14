// /frontend/js/pages/fornecedores.js
// Fornecedores | Valora CRM
// Versão completa: filtros, modal, abas, campos personalizados, importação e exportação.

let fornecedores = [];
let fornecedoresPage = { offset: 0, limit: 50, total: 0, hasMore: false };
let camposFornecedores = [];
let fornecedorEditandoId = null;
let campoEditandoId = null;
let formularioFornecedores = null;
let usarFichaPrincipalFornecedores = false;
let fichaFornecedorController = null;
let fornecedorAtualDetalhe = null;
let fornecedorModalSomenteLeitura = false;

const API_FORNECEDORES = '/api/fornecedores';
const API_CAMPOS_PRIMARY = '/api/fornecedores/campos';
const API_CAMPOS_FALLBACK = '/api/campos-fornecedores';

function $(id) {
  return document.getElementById(id);
}

function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

function onlyDigits(value) {
  return String(value || '').replace(/\D+/g, '');
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

function formatTipoCampo(tipo) {
  const map = {
    texto: 'Texto curto',
    textarea: 'Texto longo',
    numero: 'Número',
    data: 'Data',
    select: 'Lista de opções',
    checkbox: 'Caixa de seleção',
    email: 'E-mail',
    telefone: 'Telefone',
    moeda: 'Moeda',
    percentual: 'Percentual',
  };

  return map[tipo] || tipo || '-';
}

function toast(message, type = 'success', ms = 2600) {
  if (typeof window.showToast === 'function') {
    window.showToast(message, type);
    return;
  }

  const el = $('valora-toast');

  if (!el) {
    alert(message);
    return;
  }

  el.textContent = message || '';
  el.classList.remove('is-error');

  if (type === 'error') {
    el.classList.add('is-error');
  }

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

let _confirmResolver = null;

function confirmDialog({
  title = 'Confirmar',
  message = 'Tem certeza?',
  confirmText = 'OK',
  cancelText = 'Cancelar',
} = {}) {
  const backdrop = $('Valora-confirm-backdrop');

  if (!backdrop) {
    return Promise.resolve(window.confirm(message));
  }

  $('Valora-confirm-title').textContent = title;
  $('Valora-confirm-message').textContent = message;
  $('Valora-confirm-ok').textContent = confirmText;
  $('Valora-confirm-cancel').textContent = cancelText;

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

async function apiJson(url, options = {}) {
  const resp = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      Accept: 'application/json',
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

async function apiCampos(path = '', options = {}) {
  const suffix = path ? `/${String(path).replace(/^\/+/, '')}` : '';

  try {
    return await apiJson(`${API_CAMPOS_PRIMARY}${suffix}`, options);
  } catch (err) {
    const msg = String(err.message || '').toLowerCase();
    const deveTentarFallback =
      msg.includes('not found') ||
      msg.includes('404') ||
      msg.includes('não encontrado') ||
      msg.includes('method not allowed') ||
      msg.includes('405');

    if (!deveTentarFallback) {
      throw err;
    }

    return apiJson(`${API_CAMPOS_FALLBACK}${suffix}`, options);
  }
}

function openModal(id) {
  const modal = $(id);
  if (!modal) return;

  modal.hidden = false;

  requestAnimationFrame(() => {
    modal.classList.add('show');
  });
}

function closeModal(id) {
  const modal = $(id);
  if (!modal) return;

  modal.classList.remove('show');

  setTimeout(() => {
    modal.hidden = true;
  }, 180);
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

function getValue(id) {
  const el = $(id);
  if (!el) return '';

  if (el.type === 'checkbox') {
    return !!el.checked;
  }

  return el.value ?? '';
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

function setFornecedorModalReadonly(enabled) {
  fornecedorModalSomenteLeitura = !!enabled;

  const backdrop = $('modal-fornecedor-backdrop');
  const form = $('formFornecedor');
  const cancelBtn = $('btn-cancelar-fornecedor');

  backdrop?.classList.toggle('modal-readonly', fornecedorModalSomenteLeitura);
  form?.classList.toggle('modal-readonly-form', fornecedorModalSomenteLeitura);

  if (form) {
    form.querySelectorAll('input, select, textarea').forEach((el) => {
      if (fornecedorModalSomenteLeitura) applyReadonlyElement(el);
      else restoreReadonlyElement(el);
    });
  }

  [
    'btn-salvar-fornecedor',
  ].forEach((id) => setHiddenByReadonly(id, fornecedorModalSomenteLeitura));

  if (cancelBtn) {
    if (fornecedorModalSomenteLeitura) {
      cancelBtn.dataset.normalText = cancelBtn.dataset.normalText || cancelBtn.textContent || 'Cancelar';
      cancelBtn.textContent = 'Fechar';
    } else if (cancelBtn.dataset.normalText) {
      cancelBtn.textContent = cancelBtn.dataset.normalText;
    }
  }
}

function normalizeSituacao(value) {
  const s = String(value || 'ativo').trim().toLowerCase();

  return ['ativo', 'inativo', 'bloqueado'].includes(s) ? s : 'ativo';
}

function defaultFornecedor() {
  return {
    codigo: '',
    tipo_fornecedor: '',
    tipo: '',
    situacao: 'ativo',
    nome: '',
    nome_fantasia: '',
    cpf_cnpj: '',
    inscricao_estadual: '',
    inscricao_municipal: '',
    ie: '',
    im: '',
    contato: '',
    telefone: '',
    whatsapp: '',
    fax: '',
    email: '',
    site: '',
    cep: '',
    endereco: '',
    numero: '',
    complemento: '',
    bairro: '',
    cidade: '',
    estado: '',
    uf: '',
    pais: 'Brasil',
    codigo_ibge_cidade: '',
    codigo_ibge_uf: '',
    ibge_cidade: '',
    ibge_uf: '',
    limite_compras: '',
    classificacao: '',
    plano_contas: '',
    observacoes: '',
    criado_em: '',
    atualizado_em: '',
    custom_fields: {},
  };
}

function generateNextFornecedorCode() {
  const proximoId = fornecedores.length > 0
    ? Math.max(...fornecedores.map((f) => Number(f.id) || 0)) + 1
    : 1;

  return String(proximoId).padStart(4, '0');
}

async function obterProximoCodigoFornecedorNoServidor() {
  try {
    const data = await apiJson(`${API_FORNECEDORES}/proximo-codigo`);
    const codigo = onlyDigits(data?.codigo || data?.proximo_codigo || '');

    if (codigo) {
      return codigo;
    }
  } catch (err) {
    console.warn('[Valora][Fornecedores] Falha ao buscar próximo código:', err);
  }

  return generateNextFornecedorCode();
}

function setCodigoFornecedorReadonly() {
  ['campo-codigo-fornecedor', 'campo-codigo-ficha-principal-fornecedor'].forEach((id) => {
    const el = $(id);

    if (!el) return;

    el.readOnly = true;
    el.setAttribute('readonly', 'readonly');
    el.classList.add('is-system-code');
    el.title = 'Código único gerado pelo sistema. Não pode ser alterado.';
  });
}

function pick(obj, keys, fallback = '') {
  for (const key of keys) {
    const value = obj?.[key];

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }

  return fallback;
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

function syncFornecedorDataCadastro(dataCadastro, usarHoje = false) {
  const raw = dataCadastro || (usarHoje ? new Date().toISOString() : '');
  setValue('campo-data-cadastro-ficha-principal-fornecedor', formatarDataCadastroSistema(raw));
}

function getTipoFornecedor(fornecedor) {
  return pick(fornecedor, ['tipo_fornecedor', 'tipo'], '');
}

function getDocumentoFornecedor(fornecedor) {
  return pick(fornecedor, ['cpf_cnpj', 'cnpj_cpf', 'documento'], '');
}

function getCidadeUfFornecedor(fornecedor) {
  const cidade = String(pick(fornecedor, ['cidade'], '') || '').trim();
  const uf = String(pick(fornecedor, ['estado', 'uf'], '') || '').trim();

  return [cidade, uf].filter(Boolean).join(' / ') || '-';
}

function getContatoFornecedor(fornecedor) {
  return pick(fornecedor, ['whatsapp', 'telefone', 'email', 'contato'], '-') || '-';
}

function getFiltroFornecedores() {
  return {
    busca: String(getValue('filtro-busca') || '').trim().toLowerCase(),
    tipo: String(getValue('filtro-tipo') || '').trim().toLowerCase(),
    situacao: String(getValue('filtro-situacao') || '').trim().toLowerCase(),
    cidade: String(getValue('filtro-cidade') || '').trim().toLowerCase(),
  };
}

function filtrarFornecedores() {
  // A filtragem principal agora é feita no backend, com paginação.
  // Isso evita carregar milhares de fornecedores no navegador.
  return fornecedores || [];
}

function limparFiltros() {
  setValue('filtro-busca', '');
  setValue('filtro-tipo', '');
  setValue('filtro-situacao', '');
  setValue('filtro-cidade', '');
  window.ValoraLocalizarPersonalizado?.clearFilters?.('localizar-personalizado-fornecedores');
}

function renderBadgeSituacao(situacao) {
  const s = normalizeSituacao(situacao);

  return `<span class="badge-status ${escapeHtml(s)}">${escapeHtml(s)}</span>`;
}

function renderBadgeTipo(tipo) {
  const t = String(tipo || '-').trim() || '-';

  return `<span class="badge-tipo">${escapeHtml(t)}</span>`;
}

function renderNomeFornecedor(fornecedor) {
  const nome = fornecedor?.nome || '-';
  const fantasia = fornecedor?.nome_fantasia || '';
  const id = escapeHtml(fornecedor?.id || '');

  const nomeHtml = !fantasia
    ? `<strong>${escapeHtml(nome)}</strong>`
    : `
      <span style="display:flex; flex-direction:column; gap:2px;">
        <strong>${escapeHtml(nome)}</strong>
        <span class="subtle">${escapeHtml(fantasia)}</span>
      </span>
    `;

  return `
    <button
      type="button"
      class="table-name-link"
      data-action="visualizar"
      data-id="${id}"
      title="Visualizar fornecedor"
    >
      ${nomeHtml}
    </button>
  `;
}

const DEFAULT_NATIVE_COLUMNS_FORNECEDORES = [
  { key: 'codigo', label: 'Código' },
  { key: 'tipo', label: 'Tipo' },
  { key: 'fornecedor', label: 'Fornecedor' },
  { key: 'documento', label: 'Documento' },
  { key: 'cidade', label: 'Cidade / UF' },
  { key: 'contato', label: 'Contato' },
  { key: 'situacao', label: 'Situação' },
  { key: 'acoes', label: 'Ações', fixed: true },
];

function getCamposTabelaFornecedores() {
  return window.ValoraLocalizarPersonalizado?.getTableFields?.('fornecedores') || [];
}

function getColunasNativasFornecedores() {
  const columns = window.ValoraLocalizarPersonalizado?.getNativeColumns?.('fornecedores');
  return Array.isArray(columns) && columns.length ? columns : DEFAULT_NATIVE_COLUMNS_FORNECEDORES;
}

function dividirColunasNativasFornecedores(columns) {
  const beforeDynamic = [];
  const afterDynamic = [];

  columns.forEach((col) => {
    if (col.key === 'situacao' || col.key === 'acoes') {
      afterDynamic.push(col);
    } else {
      beforeDynamic.push(col);
    }
  });

  return { beforeDynamic, afterDynamic };
}

function renderHeadersFornecedores(nativeColumns, fields) {
  const row = document.querySelector('.valora-table thead tr');
  if (!row) return;

  const { beforeDynamic, afterDynamic } = dividirColunasNativasFornecedores(nativeColumns);

  row.innerHTML = `
    ${beforeDynamic.map((col) => `<th>${escapeHtml(col.label || col.key)}</th>`).join('')}
    ${fields.map((field) => `<th>${escapeHtml(field.label || field.key)}</th>`).join('')}
    ${afterDynamic.map((col) => `<th class="${col.key === 'acoes' ? 'text-right' : ''}">${escapeHtml(col.label || col.key)}</th>`).join('')}
  `;
}

function renderCamposTabelaFornecedores(fornecedor, fields) {
  return fields
    .map((field) => `<td>${escapeHtml(window.ValoraLocalizarPersonalizado?.formatValue?.(fornecedor, field) || '-')}</td>`)
    .join('');
}

function renderAcoesFornecedor(f) {
  return `
    <td class="text-right">
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button class="btn-icon" data-action="editar" data-id="${escapeHtml(f.id)}" title="Editar">
          <i class="fa-solid fa-pen"></i>
        </button>

        <button class="btn-icon danger" data-action="excluir" data-id="${escapeHtml(f.id)}" title="Excluir">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </td>
  `;
}

function renderCelulaNativaFornecedor(f, key) {
  switch (key) {
    case 'codigo':
      return `<td><span class="badge-codigo">${escapeHtml(f.codigo || '-')}</span></td>`;
    case 'tipo':
      return `<td>${renderBadgeTipo(getTipoFornecedor(f))}</td>`;
    case 'fornecedor':
      return `<td>${renderNomeFornecedor(f)}</td>`;
    case 'documento':
      return `<td>${escapeHtml(getDocumentoFornecedor(f) || '-')}</td>`;
    case 'cidade':
      return `<td>${escapeHtml(getCidadeUfFornecedor(f))}</td>`;
    case 'contato':
      return `<td>${escapeHtml(getContatoFornecedor(f))}</td>`;
    case 'situacao':
      return `<td>${renderBadgeSituacao(f.situacao)}</td>`;
    case 'acoes':
      return renderAcoesFornecedor(f);
    default:
      return '';
  }
}

function renderTabelaFornecedores() {
  const tbody = $('tbody-fornecedores');
  const spanCount = $('contagem-fornecedores');

  if (!tbody) return;

  const filtrados = filtrarFornecedores();
  const dynamicFields = getCamposTabelaFornecedores();
  const nativeColumns = getColunasNativasFornecedores();
  const { beforeDynamic, afterDynamic } = dividirColunasNativasFornecedores(nativeColumns);
  renderHeadersFornecedores(nativeColumns, dynamicFields);
  const colspan = nativeColumns.length + dynamicFields.length;

  if (!filtrados.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="${colspan}" class="empty-state">
          Nenhum fornecedor encontrado.
        </td>
      </tr>
    `;

    if (spanCount) {
      spanCount.textContent = '0 fornecedores';
    }

    return;
  }

  tbody.innerHTML = filtrados.map((f) => `
    <tr>
      ${beforeDynamic.map((col) => renderCelulaNativaFornecedor(f, col.key)).join('')}
      ${renderCamposTabelaFornecedores(f, dynamicFields)}
      ${afterDynamic.map((col) => renderCelulaNativaFornecedor(f, col.key)).join('')}
    </tr>
  `).join('');

  if (spanCount) {
    const total = Number(fornecedoresPage.total || filtrados.length || 0);
    const ini = total ? Number(fornecedoresPage.offset || 0) + 1 : 0;
    const fim = Math.min(Number(fornecedoresPage.offset || 0) + filtrados.length, total);

    spanCount.textContent = total === filtrados.length
      ? (filtrados.length === 1 ? '1 fornecedor' : `${filtrados.length} fornecedores`)
      : `${ini}-${fim} de ${total} fornecedores`;
  }

  renderPaginacaoFornecedores();
}

function renderPaginacaoFornecedores() {
  const wraps = document.querySelectorAll('[data-pagination="fornecedores"]');
  if (!wraps.length) return;

  const offset = Number(fornecedoresPage.offset || 0);
  const limit = Number(fornecedoresPage.limit || 50);
  const total = Number(fornecedoresPage.total || 0);
  const atual = total ? Math.floor(offset / limit) + 1 : 1;
  const paginas = Math.max(1, Math.ceil(total / limit));

  const html = `
    <button class="btn btn-secondary btn-sm" type="button" data-page-action="prev" ${offset <= 0 ? 'disabled' : ''}>Anterior</button>
    <span class="pagination-info">Página ${atual} de ${paginas}</span>
    <button class="btn btn-secondary btn-sm" type="button" data-page-action="next" ${!fornecedoresPage.hasMore ? 'disabled' : ''}>Próxima</button>
  `;

  wraps.forEach((wrap) => {
    wrap.innerHTML = html;
  });
}

function montarUrlFornecedores({ offset = fornecedoresPage.offset || 0, limit = fornecedoresPage.limit || 50 } = {}) {
  const filtro = getFiltroFornecedores();
  const params = new URLSearchParams();

  params.set('paginated', 'true');
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  if (filtro.busca) params.set('busca', filtro.busca);
  if (filtro.tipo) params.set('tipo_fornecedor', filtro.tipo);
  if (filtro.situacao) params.set('situacao', filtro.situacao);
  if (filtro.cidade) params.set('cidade', filtro.cidade);

  window.ValoraLocalizarPersonalizado?.addParams?.(params, 'localizar-personalizado-fornecedores');

  return `${API_FORNECEDORES}?${params.toString()}`;
}

function setFornecedoresLoading(message = 'Buscando fornecedores no banco...') {
  const tbody = $('tbody-fornecedores');
  if (!tbody) return;
  tbody.innerHTML = `
    <tr>
      <td colspan="${8 + getCamposTabelaFornecedores().length}" class="empty-state" style="border:none; text-align:center;">
        ${escapeHtml(message)}
      </td>
    </tr>
  `;
}

async function carregarFornecedores({ offset = fornecedoresPage.offset || 0, silent = false } = {}) {
  try {
    if (!silent) setFornecedoresLoading();
    const data = await apiJson(montarUrlFornecedores({ offset }));

    if (Array.isArray(data)) {
      fornecedores = data;
      fornecedoresPage = {
        offset: 0,
        limit: data.length || 50,
        total: data.length,
        hasMore: false,
      };
    } else {
      fornecedores = Array.isArray(data?.items) ? data.items : [];
      fornecedoresPage = {
        offset: Number(data?.offset || 0),
        limit: Number(data?.limit || 50),
        total: Number(data?.total || fornecedores.length),
        hasMore: !!data?.has_more,
      };
    }
  } catch (err) {
    fornecedores = [];
    toast(err.message || 'Erro ao carregar fornecedores.', 'error');
  }

  renderTabelaFornecedores();
}

async function carregarCamposFornecedores() {
  try {
    const data = await apiCampos();
    camposFornecedores = Array.isArray(data) ? data : [];

    camposFornecedores.sort((a, b) =>
      Number(a.ordem || 0) - Number(b.ordem || 0) ||
      String(a.nome || '').localeCompare(String(b.nome || ''))
    );
  } catch (err) {
    camposFornecedores = [];
    toast(err.message || 'Erro ao carregar campos personalizados.', 'error');
  }

  renderListaCamposFornecedores();
}

async function carregarFormularioFornecedores({ loadingContainer = null, forceRefresh = false } = {}) {
  try {
    if (!window.ValoraFichaPrincipal) {
      formularioFornecedores = null;
      usarFichaPrincipalFornecedores = false;
      return null;
    }

    const formulario = await window.ValoraFichaPrincipal.carregarFormularioModulo('fornecedores', {
      apiJsonImpl: apiJson,
      ativo: true,
      forceRefresh,
      loadingContainer,
    });

    formularioFornecedores = formulario;
    usarFichaPrincipalFornecedores = !!formulario?.modelo?.usar_como_ficha_principal;
    return formulario;
  } catch (err) {
    formularioFornecedores = null;
    usarFichaPrincipalFornecedores = false;
    toast(err.message || 'Erro ao carregar formulário de fornecedores.', 'error');
    return null;
  }
}

function parseCampoOpcoes(campo) {
  if (!campo || !campo.opcoes_json) return [];

  try {
    const parsed = typeof campo.opcoes_json === 'string'
      ? JSON.parse(campo.opcoes_json)
      : campo.opcoes_json;

    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function renderListaCamposFornecedores() {
  const wrap = $('lista-campos-fornecedores');

  if (!wrap) return;

  if (!camposFornecedores.length) {
    wrap.innerHTML = `
      <div class="empty-state" style="grid-column:1 / -1;">
        Nenhum campo personalizado criado.
      </div>
    `;
    return;
  }

  wrap.innerHTML = camposFornecedores.map((campo) => {
    const bObrig = campo.obrigatorio ? `<span class="badge-tag brand">Obrigatório</span>` : '';
    const bOculto = campo.ativo === false ? `<span class="badge-tag">Oculto</span>` : '';

    return `
      <div class="campo-card">
        <div class="campo-card-header">
          <div>
            <strong>${escapeHtml(campo.nome || '')}</strong>
            <span class="campo-meta">${escapeHtml(formatTipoCampo(campo.tipo))} • Ordem ${Number(campo.ordem || 0)}</span>
          </div>

          <div style="display:flex; gap:6px;">
            <button class="btn-icon" data-campo-action="editar" data-id="${campo.id}" title="Editar campo">
              <i class="fa-solid fa-pen"></i>
            </button>

            <button class="btn-icon danger" data-campo-action="excluir" data-id="${campo.id}" title="Excluir campo">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>

        <div class="campo-badges">${bObrig} ${bOculto}</div>
      </div>
    `;
  }).join('');
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
    // Checa só a versão. Se nada mudou, usa localStorage; se mudou, baixa a ficha nova.
    await carregarFormularioFornecedores({ loadingContainer: container });
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
    formulario: formularioFornecedores,
    camposAvulsos: camposFornecedores,
    values: { ...(values || {}), data_cadastro: values?.data_cadastro || values?.criado_em || values?.created_at || '' },
    usarFichaPrincipal: usarFichaPrincipalFornecedores,
    flatTitle: 'Campos personalizados',
    flatDescription: 'Campos extras do cadastro de fornecedores.',
    emptyMessage: formularioFornecedores?.modelo
      ? 'Nenhum campo ativo neste formulário de fornecedores.'
      : 'Nenhum formulário de fornecedores encontrado. Crie um formulário em Configurações > Formulários.',
  });
}

function normalizeCustomFieldsPayload() {
  if (window.ValoraFichaPrincipal?.collectCustomFieldsValues) {
    return window.ValoraFichaPrincipal.collectCustomFieldsValues(document);
  }

  const out = {};

  $$('[data-custom-field]').forEach((el) => {
    const slug = String(el.getAttribute('data-custom-field') || '').trim();

    if (!slug || el.disabled || el.dataset.customReadonly === 'true') return;

    let value = '';

    if (el.type === 'checkbox') {
      value = el.checked ? 'true' : 'false';
    } else if (el.matches('input.custom-multiselect-hidden[data-custom-multiple="true"]')) {
      value = String(el.value || '').trim();
      if (value) out[slug] = value;
      return;
    } else if (el.matches('select[multiple], [data-custom-multiple="true"]')) {
      const values = Array.from(el.selectedOptions || [])
        .map((opt) => String(opt.value ?? '').trim())
        .filter(Boolean);

      if (values.length) out[slug] = JSON.stringify(values);
      return;
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
      toast,
      switchToCustomTab: () => switchFornecedorTab('tab-fornecedor-campos'),
    });

    if (!ok) return false;

    // Se a tela está usando o construtor de Formulários, a validação global
    // já verificou os campos renderizados, inclusive relações e relações múltiplas.
    if (formularioFornecedores?.modelo) return true;
  }

  for (const campo of camposFornecedores || []) {
    if (!campo.obrigatorio || campo.ativo === false) continue;

    const slug = String(campo.slug || '').trim();

    if (!slug) continue;

    const el = document.querySelector(`[data-custom-field="${CSS.escape(slug)}"]`);

    if (!el) continue;

    if (el.type === 'checkbox') {
      if (!el.checked) {
        toast(`Preencha o campo personalizado: ${campo.nome || slug}.`, 'error');
        switchFornecedorTab('tab-fornecedor-campos');
        el.focus();
        return false;
      }
      continue;
    }

    if (el.matches('select[multiple], [data-custom-multiple="true"]')) {
      const hasValue = Array.from(el.selectedOptions || []).some((opt) => String(opt.value || '').trim());

      if (!hasValue) {
        toast(`Preencha o campo personalizado: ${campo.nome || slug}.`, 'error');
        switchFornecedorTab('tab-fornecedor-campos');
        el.focus();
        return false;
      }

      continue;
    }

    if (!String(el.value || '').trim()) {
      toast(`Preencha o campo personalizado: ${campo.nome || slug}.`, 'error');
      switchFornecedorTab('tab-fornecedor-campos');
      el.focus();
      return false;
    }
  }

  return true;
}

function switchFornecedorTab(targetId) {
  if (usarFichaPrincipalFornecedores) {
    targetId = 'tab-fornecedor-campos';
  }

  $$('.fornecedor-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === targetId);
  });

  $$('.fornecedor-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.id === targetId);
  });
}

function syncFornecedorFichaCode(codigo) {
  const value = onlyDigits(codigo);
  setValue('campo-codigo-fornecedor', value);
  setValue('campo-codigo-ficha-principal-fornecedor', value);
  setCodigoFornecedorReadonly();
}

function ensureFichaFornecedorController() {
  if (fichaFornecedorController || !window.ValoraFichaPrincipal) {
    return fichaFornecedorController;
  }

  fichaFornecedorController = window.ValoraFichaPrincipal.createTabFichaController({
    formSelector: '#formFornecedor',
    tabsSelector: '.fornecedor-tabs',
    tabButtonSelector: '.fornecedor-tab-btn',
    tabPanelSelector: '.fornecedor-tab',
    customTabId: 'tab-fornecedor-campos',
    customContainerSelector: '#custom-fields-container',
    codeCardSelector: '#fornecedor-ficha-principal-code',
    toggleSelector: '#toggle-ficha-principal-fornecedor',
    normalTabId: 'tab-fornecedor-cadastro',
    buttonClass: 'fornecedor-tab-btn',
  });

  fichaFornecedorController.bindSectionClicks();
  return fichaFornecedorController;
}

function aplicarModoFichaFornecedor() {
  ensureFichaFornecedorController()?.setMode(usarFichaPrincipalFornecedores);
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

function buildBaseFromFornecedorFichaPrincipal(customFields, fallback = {}) {
  const custom = customFields || {};

  const nome = getCustomValue(custom, [
    'nome',
    'fornecedor',
    'nome_razao_social',
    'razao_social',
    'nome_completo',
    'nome_fantasia',
  ], fallback.nome || '');

  const telefone = getCustomValue(custom, [
    'telefone',
    'telefone_contato',
    'telefone_principal',
    'telefone_celular',
    'whatsapp',
  ], fallback.telefone || '');

  const email = getCustomValue(custom, [
    'email',
    'e_mail',
    'email_principal',
    'e_mail_principal',
  ], fallback.email || '');

  return {
    codigo:
      onlyDigits(fallback.codigo) ||
      onlyDigits(getValue('campo-codigo-fornecedor')) ||
      onlyDigits(getValue('campo-codigo-ficha-principal-fornecedor')) ||
      '',
    tipo_fornecedor: getCustomValue(custom, ['tipo_fornecedor', 'tipo'], fallback.tipo_fornecedor || fallback.tipo || ''),
    tipo: getCustomValue(custom, ['tipo_fornecedor', 'tipo'], fallback.tipo || fallback.tipo_fornecedor || ''),
    situacao: normalizeSituacao(getCustomValue(custom, ['situacao', 'status'], fallback.situacao || 'ativo')),
    nome,
    nome_fantasia: getCustomValue(custom, ['nome_fantasia'], fallback.nome_fantasia || ''),
    cpf_cnpj: getCustomValue(custom, ['cpf_cnpj', 'cnpj', 'cpf', 'documento'], fallback.cpf_cnpj || ''),
    inscricao_estadual: getCustomValue(custom, ['inscricao_estadual', 'ie'], fallback.inscricao_estadual || fallback.ie || ''),
    inscricao_municipal: getCustomValue(custom, ['inscricao_municipal', 'im'], fallback.inscricao_municipal || fallback.im || ''),
    contato: getCustomValue(custom, ['contato', 'responsavel', 'nome_responsavel'], fallback.contato || ''),
    telefone,
    whatsapp: getCustomValue(custom, ['whatsapp', 'telefone_celular'], fallback.whatsapp || telefone),
    fax: getCustomValue(custom, ['fax'], fallback.fax || ''),
    email,
    site: getCustomValue(custom, ['site', 'home_page'], fallback.site || ''),
    cep: getCustomValue(custom, ['cep'], fallback.cep || ''),
    endereco: getCustomValue(custom, ['endereco', 'logradouro'], fallback.endereco || ''),
    numero: getCustomValue(custom, ['numero'], fallback.numero || ''),
    complemento: getCustomValue(custom, ['complemento'], fallback.complemento || ''),
    bairro: getCustomValue(custom, ['bairro'], fallback.bairro || ''),
    cidade: getCustomValue(custom, ['cidade'], fallback.cidade || ''),
    estado: getCustomValue(custom, ['uf', 'estado'], fallback.estado || fallback.uf || ''),
    uf: getCustomValue(custom, ['uf', 'estado'], fallback.uf || fallback.estado || ''),
    pais: getCustomValue(custom, ['pais'], fallback.pais || 'Brasil'),
    limite_compras: getCustomValue(custom, ['limite_compras', 'limite_de_compras'], fallback.limite_compras || ''),
    classificacao: getCustomValue(custom, ['classificacao'], fallback.classificacao || ''),
    plano_contas: getCustomValue(custom, ['plano_contas', 'plano_de_contas'], fallback.plano_contas || ''),
    observacoes: getCustomValue(custom, ['observacoes', 'observacao'], fallback.observacoes || ''),
  };
}

async function salvarToggleFichaPrincipalFornecedor(event) {
  const checked = !!event.target.checked;

  try {
    if (!formularioFornecedores?.modelo?.id) {
      await carregarFormularioFornecedores();
      await renderCustomFieldsInputs({ ...(fornecedorAtualDetalhe?.custom_fields || {}), ...(fornecedorAtualDetalhe || {}), data_cadastro: fornecedorAtualDetalhe?.data_cadastro || fornecedorAtualDetalhe?.criado_em || fornecedorAtualDetalhe?.created_at || '' });
    }

    const modelo = formularioFornecedores?.modelo;

    if (!modelo?.id) {
      event.target.checked = false;
      toast('Nenhum formulário de Fornecedores encontrado para ativar como ficha principal.', 'error');
      return;
    }

    event.target.disabled = true;
    window.ValoraFichaPrincipal?.showLoading?.(
      '#custom-fields-container',
      checked ? 'Montando ficha principal...' : 'Voltando para o cadastro padrão...'
    );

    const atualizado = await window.ValoraFichaPrincipal.atualizarFichaPrincipalModelo(modelo, checked, {
      apiJsonImpl: apiJson,
      moduloFallback: 'fornecedores',
    });

    usarFichaPrincipalFornecedores = checked;
    formularioFornecedores = {
      ...formularioFornecedores,
      modelo: {
        ...modelo,
        ...(atualizado || {}),
        usar_como_ficha_principal: checked,
      },
    };

    await renderCustomFieldsInputs({ ...(fornecedorAtualDetalhe?.custom_fields || {}), ...(fornecedorAtualDetalhe || {}), data_cadastro: fornecedorAtualDetalhe?.data_cadastro || fornecedorAtualDetalhe?.criado_em || fornecedorAtualDetalhe?.created_at || '' });
    aplicarModoFichaFornecedor();

    toast(
      checked
        ? 'Ficha principal ativada para Fornecedores.'
        : 'Ficha principal desativada para Fornecedores.',
      'success'
    );
  } catch (err) {
    event.target.checked = !checked;
    toast(err.message || 'Erro ao alterar ficha principal.', 'error');
  } finally {
    event.target.disabled = false;
  }
}

async function fillFornecedorForm(fornecedor = {}) {
  const data = { ...defaultFornecedor(), ...(fornecedor || {}) };
  fornecedorAtualDetalhe = data;

  syncFornecedorFichaCode(onlyDigits(data.codigo));
  syncFornecedorDataCadastro(data.criado_em || data.data_cadastro || data.created_at, !data.id);
  setValue('campo-tipo-fornecedor', pick(data, ['tipo_fornecedor', 'tipo'], ''));
  setValue('campo-situacao-fornecedor', normalizeSituacao(data.situacao));

  setValue('campo-nome-fornecedor', data.nome);
  setValue('campo-nome-fantasia-fornecedor', data.nome_fantasia);
  setValue('campo-cpf-cnpj-fornecedor', pick(data, ['cpf_cnpj', 'cnpj_cpf', 'documento'], ''));
  setValue('campo-ie-fornecedor', pick(data, ['inscricao_estadual', 'ie'], ''));
  setValue('campo-im-fornecedor', pick(data, ['inscricao_municipal', 'im'], ''));

  setValue('campo-contato-fornecedor', data.contato);
  setValue('campo-telefone-fornecedor', data.telefone);
  setValue('campo-whatsapp-fornecedor', data.whatsapp);
  setValue('campo-fax-fornecedor', data.fax);
  setValue('campo-email-fornecedor', data.email);
  setValue('campo-site-fornecedor', data.site);

  setValue('campo-cep-fornecedor', data.cep);
  setValue('campo-endereco-fornecedor', data.endereco);
  setValue('campo-numero-fornecedor', data.numero);
  setValue('campo-complemento-fornecedor', data.complemento);
  setValue('campo-bairro-fornecedor', data.bairro);
  setValue('campo-cidade-fornecedor', data.cidade);
  setValue('campo-estado-fornecedor', pick(data, ['estado', 'uf'], ''));
  setValue('campo-pais-fornecedor', data.pais || 'Brasil');
  setValue('campo-ibge-cidade-fornecedor', pick(data, ['codigo_ibge_cidade', 'ibge_cidade'], ''));
  setValue('campo-ibge-uf-fornecedor', pick(data, ['codigo_ibge_uf', 'ibge_uf'], ''));

  setValue('campo-limite-compras-fornecedor', data.limite_compras);
  setValue('campo-classificacao-fornecedor', data.classificacao);
  setValue('campo-plano-contas-fornecedor', data.plano_contas);
  setValue('campo-observacoes-fornecedor', data.observacoes);

  await renderCustomFieldsInputs({ ...(data.custom_fields || {}), ...data, data_cadastro: data.data_cadastro || data.criado_em || data.created_at || '' });
  syncFornecedorFichaCode(onlyDigits(data.codigo) || onlyDigits(getValue('campo-codigo-fornecedor')));
  aplicarModoFichaFornecedor();
  switchFornecedorTab(usarFichaPrincipalFornecedores ? 'tab-fornecedor-campos' : 'tab-fornecedor-cadastro');
}

function buildFornecedorPayload() {
  const customFields = normalizeCustomFieldsPayload();

  const payload = {
    codigo: onlyDigits(getValue('campo-codigo-fornecedor') || getValue('campo-codigo-ficha-principal-fornecedor') || ''),
    tipo_fornecedor: String(getValue('campo-tipo-fornecedor') || '').trim(),
    tipo: String(getValue('campo-tipo-fornecedor') || '').trim(),
    situacao: normalizeSituacao(getValue('campo-situacao-fornecedor')),

    nome: String(getValue('campo-nome-fornecedor') || '').trim(),
    nome_fantasia: String(getValue('campo-nome-fantasia-fornecedor') || '').trim(),
    cpf_cnpj: String(getValue('campo-cpf-cnpj-fornecedor') || '').trim(),

    inscricao_estadual: String(getValue('campo-ie-fornecedor') || '').trim(),
    inscricao_municipal: String(getValue('campo-im-fornecedor') || '').trim(),
    ie: String(getValue('campo-ie-fornecedor') || '').trim(),
    im: String(getValue('campo-im-fornecedor') || '').trim(),

    contato: String(getValue('campo-contato-fornecedor') || '').trim(),
    telefone: String(getValue('campo-telefone-fornecedor') || '').trim(),
    whatsapp: String(getValue('campo-whatsapp-fornecedor') || '').trim(),
    fax: String(getValue('campo-fax-fornecedor') || '').trim(),
    email: String(getValue('campo-email-fornecedor') || '').trim(),
    site: String(getValue('campo-site-fornecedor') || '').trim(),

    cep: String(getValue('campo-cep-fornecedor') || '').trim(),
    endereco: String(getValue('campo-endereco-fornecedor') || '').trim(),
    numero: String(getValue('campo-numero-fornecedor') || '').trim(),
    complemento: String(getValue('campo-complemento-fornecedor') || '').trim(),
    bairro: String(getValue('campo-bairro-fornecedor') || '').trim(),
    cidade: String(getValue('campo-cidade-fornecedor') || '').trim(),
    estado: String(getValue('campo-estado-fornecedor') || '').trim(),
    uf: String(getValue('campo-estado-fornecedor') || '').trim(),
    pais: String(getValue('campo-pais-fornecedor') || '').trim(),

    codigo_ibge_cidade: String(getValue('campo-ibge-cidade-fornecedor') || '').trim(),
    codigo_ibge_uf: String(getValue('campo-ibge-uf-fornecedor') || '').trim(),
    ibge_cidade: String(getValue('campo-ibge-cidade-fornecedor') || '').trim(),
    ibge_uf: String(getValue('campo-ibge-uf-fornecedor') || '').trim(),

    limite_compras: String(getValue('campo-limite-compras-fornecedor') || '').trim(),
    classificacao: String(getValue('campo-classificacao-fornecedor') || '').trim(),
    plano_contas: String(getValue('campo-plano-contas-fornecedor') || '').trim(),
    observacoes: String(getValue('campo-observacoes-fornecedor') || '').trim(),

    custom_fields: customFields,
  };

  if (usarFichaPrincipalFornecedores) {
    Object.assign(payload, buildBaseFromFornecedorFichaPrincipal(customFields, payload));
  }

  payload.codigo = onlyDigits(payload.codigo);

  return payload;
}

async function abrirModalFornecedorNovo() {
  setFornecedorModalReadonly(false);
  fornecedorEditandoId = null;

  $('modal-fornecedor-titulo').textContent = 'Novo fornecedor';
  $('formFornecedor')?.reset();

  const novo = { ...defaultFornecedor(), codigo: '' };
  await fillFornecedorForm(novo);

  const proximoCodigo = await obterProximoCodigoFornecedorNoServidor();
  syncFornecedorFichaCode(proximoCodigo);

  openModal('modal-fornecedor-backdrop');
  setFornecedorModalReadonly(false);
}

function fecharModalFornecedor() {
  setFornecedorModalReadonly(false);
  closeModal('modal-fornecedor-backdrop');
}

async function abrirModalFornecedorEditar(id) {
  setFornecedorModalReadonly(false);
  try {
    const full = await apiJson(`${API_FORNECEDORES}/${id}`);

    fornecedorEditandoId = full.id;

    $('modal-fornecedor-titulo').textContent = 'Editar fornecedor';

    await fillFornecedorForm(full);
    openModal('modal-fornecedor-backdrop');
    setFornecedorModalReadonly(false);
  } catch (err) {
    toast(err.message || 'Erro ao carregar fornecedor.', 'error');
  }
}



async function abrirModalFornecedorVisualizar(id) {
  try {
    const full = await apiJson(`${API_FORNECEDORES}/${id}`);

    fornecedorEditandoId = full.id;
    $('modal-fornecedor-titulo').textContent = 'Visualizar fornecedor';

    await fillFornecedorForm(full);
    openModal('modal-fornecedor-backdrop');
    setFornecedorModalReadonly(true);
  } catch (err) {
    toast(err.message || 'Erro ao carregar fornecedor.', 'error');
  }
}

async function salvarFornecedor(event) {
  event?.preventDefault?.();

  if (fornecedorModalSomenteLeitura) {
    toast('Este fornecedor está aberto apenas para visualização.', 'error');
    return;
  }

  if (!validateRequiredCustomFields()) return;

  const payload = buildFornecedorPayload();

  // Código é único, gerado pelo sistema e imutável.
  // Na criação, o backend decide o código real; na edição, o backend ignora qualquer alteração.
  if (!fornecedorEditandoId) {
    delete payload.codigo;
  }

  if (!payload.nome) {
    toast('Preencha o nome do fornecedor.', 'error');
    switchFornecedorTab(usarFichaPrincipalFornecedores ? 'tab-fornecedor-campos' : 'tab-fornecedor-cadastro');
    const foco = usarFichaPrincipalFornecedores
      ? document.querySelector('[data-custom-field="nome"], [data-custom-field="fornecedor"], [data-custom-field="nome_razao_social"]')
      : $('campo-nome-fornecedor');
    foco?.focus?.();
    return;
  }

  const btn = $('btn-salvar-fornecedor');

  setButtonLoading(btn, true, 'Salvando...');

  try {
    const url = fornecedorEditandoId
      ? `${API_FORNECEDORES}/${fornecedorEditandoId}`
      : API_FORNECEDORES;

    await apiJson(url, {
      method: fornecedorEditandoId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    await carregarFornecedores();

    fecharModalFornecedor();
    toast('Fornecedor salvo com sucesso.', 'success');
  } catch (err) {
    toast(err.message || 'Erro ao salvar fornecedor.', 'error');
  } finally {
    setButtonLoading(
      btn,
      false,
      '',
      '<i class="fa-solid fa-floppy-disk"></i> Salvar fornecedor'
    );
  }
}

async function excluirFornecedor(id) {
  const ok = await confirmDialog({
    title: 'Excluir fornecedor',
    message: 'Deseja realmente excluir este fornecedor?',
    confirmText: 'Excluir',
    cancelText: 'Cancelar',
  });

  if (!ok) return;

  try {
    await apiJson(`${API_FORNECEDORES}/${id}`, { method: 'DELETE' });

    await carregarFornecedores();
    toast('Fornecedor excluído com sucesso.', 'success');
  } catch (err) {
    toast(err.message || 'Erro ao excluir fornecedor.', 'error');
  }
}

function syncCampoTipo() {
  const tipo = getValue('campo-custom-tipo') || 'texto';
  const wrap = $('wrap-custom-opcoes');

  if (wrap) {
    wrap.hidden = tipo !== 'select';
  }
}

function abrirModalCampoNovo() {
  campoEditandoId = null;

  $('modal-campo-titulo').textContent = 'Novo campo';

  setValue('campo-custom-nome', '');
  setValue('campo-custom-tipo', 'texto');
  setValue('campo-custom-ordem', '0');
  setValue('campo-custom-opcoes', '');
  setValue('campo-custom-obrigatorio', false);
  setValue('campo-custom-ativo', true);

  syncCampoTipo();
  openModal('modal-campo-backdrop');
}

function fecharModalCampo() {
  closeModal('modal-campo-backdrop');
}

async function abrirModalCampoEditar(id) {
  try {
    const campo = await apiCampos(id);

    campoEditandoId = campo.id;

    $('modal-campo-titulo').textContent = 'Editar campo';

    setValue('campo-custom-nome', campo.nome || '');
    setValue('campo-custom-tipo', campo.tipo || 'texto');
    setValue('campo-custom-ordem', String(campo.ordem ?? 0));
    setValue('campo-custom-opcoes', parseCampoOpcoes(campo).join('\n'));
    setValue('campo-custom-obrigatorio', !!campo.obrigatorio);
    setValue('campo-custom-ativo', campo.ativo !== false);

    syncCampoTipo();
    openModal('modal-campo-backdrop');
  } catch (err) {
    toast(err.message || 'Erro ao carregar campo.', 'error');
  }
}

async function salvarCampo() {
  const nome = String(getValue('campo-custom-nome') || '').trim();

  if (!nome) {
    toast('Nome do campo é obrigatório.', 'error');
    $('campo-custom-nome')?.focus();
    return;
  }

  const tipo = String(getValue('campo-custom-tipo') || 'texto').trim();
  let opcoes_json = null;

  if (tipo === 'select') {
    const linhas = String(getValue('campo-custom-opcoes') || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!linhas.length) {
      toast('Adicione opções para a lista.', 'error');
      $('campo-custom-opcoes')?.focus();
      return;
    }

    opcoes_json = JSON.stringify(linhas);
  }

  const payload = {
    nome,
    slug: slugify(nome),
    tipo,
    ordem: Number(getValue('campo-custom-ordem') || 0),
    obrigatorio: !!getValue('campo-custom-obrigatorio'),
    ativo: !!getValue('campo-custom-ativo'),
    opcoes_json,
  };

  const btn = $('btn-salvar-campo');

  setButtonLoading(btn, true, 'Salvando...');

  try {
    await apiCampos(campoEditandoId || '', {
      method: campoEditandoId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    await carregarCamposFornecedores();

    if (!campoEditandoId) {
      renderCustomFieldsInputs(normalizeCustomFieldsPayload());
    }

    fecharModalCampo();
    toast('Campo salvo com sucesso.', 'success');
  } catch (err) {
    toast(err.message || 'Erro ao salvar campo.', 'error');
  } finally {
    setButtonLoading(
      btn,
      false,
      '',
      '<i class="fa-solid fa-floppy-disk"></i> Salvar campo'
    );
  }
}

async function excluirCampo(id) {
  const ok = await confirmDialog({
    title: 'Excluir campo',
    message: 'Deseja realmente excluir este campo personalizado?',
    confirmText: 'Excluir',
    cancelText: 'Cancelar',
  });

  if (!ok) return;

  try {
    await apiCampos(id, { method: 'DELETE' });

    await carregarCamposFornecedores();
    renderCustomFieldsInputs(normalizeCustomFieldsPayload());

    toast('Campo excluído com sucesso.', 'success');
  } catch (err) {
    toast(err.message || 'Erro ao excluir campo.', 'error');
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

function csvEscape(value) {
  const s = String(value ?? '');
  const mustQuote = /[;\n\r"]/g.test(s);
  const out = s.replaceAll('"', '""');

  return mustQuote ? `"${out}"` : out;
}

function detectCSVDelimiter(firstLine) {
  const semicolon = (firstLine.match(/;/g) || []).length;
  const comma = (firstLine.match(/,/g) || []).length;

  return semicolon >= comma ? ';' : ',';
}

function parseCSV(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n').filter((line) => line.trim().length);

  if (!lines.length) return [];

  const delim = detectCSVDelimiter(lines[0]);

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

function exportarFornecedoresJSON() {
  const dt = new Date();
  const stamp = dt.toISOString().slice(0, 19).replaceAll(':', '-');

  const payload = {
    exported_at: dt.toISOString(),
    total: fornecedores.length,
    items: fornecedores,
  };

  downloadFile(
    `fornecedores_${stamp}.json`,
    JSON.stringify(payload, null, 2),
    'application/json;charset=utf-8'
  );

  toast('Exportado JSON com sucesso.', 'success');
}

function exportarFornecedoresCSV() {
  const dt = new Date();
  const stamp = dt.toISOString().slice(0, 19).replaceAll(':', '-');

  const baseCols = [
    'codigo',
    'tipo_fornecedor',
    'situacao',
    'nome',
    'nome_fantasia',
    'cpf_cnpj',
    'contato',
    'telefone',
    'whatsapp',
    'email',
    'cidade',
    'estado',
    'classificacao',
  ];

  const customCols = camposFornecedores.map((c) => c.slug).filter(Boolean);
  const cols = [...baseCols, ...customCols];
  const lines = [cols.join(';')];

  fornecedores.forEach((f) => {
    const custom = f.custom_fields || {};

    lines.push(
      cols.map((k) => {
        if (baseCols.includes(k)) {
          return csvEscape(f?.[k] ?? '');
        }

        return csvEscape(custom?.[k] ?? '');
      }).join(';')
    );
  });

  downloadFile(
    `fornecedores_${stamp}.csv`,
    '\ufeff' + lines.join('\n'),
    'text/csv;charset=utf-8'
  );

  toast('Exportado CSV com sucesso.', 'success');
}

function mapImportToPayload(obj) {
  const normalized = {};

  Object.entries(obj || {}).forEach(([key, value]) => {
    normalized[slugify(key)] = value;
  });

  const custom_fields = {};

  for (const campo of camposFornecedores || []) {
    const slug = String(campo.slug || '').trim();

    if (!slug) continue;

    const value = normalized[slug];

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      custom_fields[slug] = value;
    }
  }

  return {
    codigo: onlyDigits(normalized.codigo || ''),
    tipo_fornecedor: String(normalized.tipo_fornecedor || normalized.tipo || '').trim(),
    tipo: String(normalized.tipo_fornecedor || normalized.tipo || '').trim(),
    situacao: normalizeSituacao(normalized.situacao || 'ativo'),

    nome: String(normalized.nome || normalized.razao_social || normalized.fornecedor || '').trim(),
    nome_fantasia: String(normalized.nome_fantasia || '').trim(),
    cpf_cnpj: String(normalized.cpf_cnpj || normalized.cnpj_cpf || normalized.documento || '').trim(),

    contato: String(normalized.contato || normalized.responsavel || '').trim(),
    telefone: String(normalized.telefone || '').trim(),
    whatsapp: String(normalized.whatsapp || '').trim(),
    email: String(normalized.email || normalized.e_mail || '').trim(),

    cidade: String(normalized.cidade || '').trim(),
    estado: String(normalized.estado || normalized.uf || '').trim(),
    classificacao: String(normalized.classificacao || '').trim(),

    custom_fields,
  };
}

function findExistingFornecedorId(payload) {
  const codigo = onlyDigits(payload?.codigo || '').toLowerCase();
  const doc = onlyDigits(payload?.cpf_cnpj || '');
  const whatsapp = onlyDigits(payload?.whatsapp || '');
  const email = String(payload?.email || '').trim().toLowerCase();

  if (codigo) {
    const found = fornecedores.find((f) => String(f.codigo || '').trim().toLowerCase() === codigo);
    if (found?.id) return found.id;
  }

  if (doc) {
    const found = fornecedores.find((f) => onlyDigits(getDocumentoFornecedor(f)) === doc);
    if (found?.id) return found.id;
  }

  if (whatsapp) {
    const found = fornecedores.find((f) => onlyDigits(f.whatsapp || '') === whatsapp);
    if (found?.id) return found.id;
  }

  if (email) {
    const found = fornecedores.find((f) => String(f.email || '').trim().toLowerCase() === email);
    if (found?.id) return found.id;
  }

  return null;
}

async function importarFornecedores(file) {
  if (!file) {
    toast('Selecione um arquivo para importar.', 'error');
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
      toast('Arquivo vazio ou inválido.', 'error');
      return;
    }

    const ok = await confirmDialog({
      title: 'Importar fornecedores',
      message: `Importar ${items.length} fornecedor(es)? O sistema criará ou atualizará por código, documento, WhatsApp ou e-mail.`,
      confirmText: 'Importar',
      cancelText: 'Cancelar',
    });

    if (!ok) return;

    await carregarFornecedores();

    let success = 0;
    let fail = 0;

    for (const raw of items) {
      try {
        const payload = mapImportToPayload(raw);

        if (!payload.nome) {
          fail += 1;
          continue;
        }

        const existingId = findExistingFornecedorId(payload);

        await apiJson(existingId ? `${API_FORNECEDORES}/${existingId}` : API_FORNECEDORES, {
          method: existingId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        success += 1;
      } catch (_) {
        fail += 1;
      }
    }

    await carregarFornecedores();

    toast(
      `Importação concluída: ${success} sucesso(s)${fail ? ` • ${fail} falha(s)` : ''}`,
      fail ? 'error' : 'success',
      3800
    );
  } catch (err) {
    toast(err.message || 'Erro ao importar arquivo.', 'error');
  }
}

function bindTabs() {
  ensureFichaFornecedorController();

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('.fornecedor-tab-btn[data-tab]');
    if (!btn) return;
    switchFornecedorTab(btn.dataset.tab);
  });
}

function bindModalCloseOnBackdrop() {
  $('modal-fornecedor-backdrop')?.addEventListener('click', (event) => {
    if (event.target === $('modal-fornecedor-backdrop')) {
      fecharModalFornecedor();
    }
  });

  $('modal-campo-backdrop')?.addEventListener('click', (event) => {
    if (event.target === $('modal-campo-backdrop')) {
      fecharModalCampo();
    }
  });

  $('Valora-confirm-backdrop')?.addEventListener('click', (event) => {
    if (event.target === $('Valora-confirm-backdrop')) {
      closeConfirm(false);
    }
  });
}

function bindFiltros() {
  let filtroTimer = null;

  const recarregar = (delay = 350) => {
    clearTimeout(filtroTimer);
    filtroTimer = setTimeout(() => {
      carregarFornecedores({ offset: 0, silent: true });
    }, delay);
  };

  $('filtro-busca')?.addEventListener('input', () => recarregar(350));
  $('filtro-tipo')?.addEventListener('input', () => recarregar(350));
  $('filtro-situacao')?.addEventListener('change', () => recarregar(0));
  $('filtro-cidade')?.addEventListener('input', () => recarregar(350));
  window.ValoraLocalizarPersonalizado?.bindFilters?.('localizar-personalizado-fornecedores', () => recarregar(0));

  $('btn-filtrar-fornecedores')?.addEventListener('click', () => carregarFornecedores({ offset: 0 }));

  $('btn-limpar-filtros-fornecedores')?.addEventListener('click', () => {
    limparFiltros();
    carregarFornecedores({ offset: 0 });
  });

  document.querySelectorAll('[data-pagination="fornecedores"]').forEach((wrap) => {
    wrap.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-page-action]');
      if (!btn || btn.disabled) return;

      const limit = Number(fornecedoresPage.limit || 50);
      let offset = Number(fornecedoresPage.offset || 0);

      if (btn.dataset.pageAction === 'prev') offset = Math.max(0, offset - limit);
      if (btn.dataset.pageAction === 'next') offset += limit;

      carregarFornecedores({ offset });
    });
  });
}

function bindTabelaActions() {
  $('tbody-fornecedores')?.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action]');

    if (!btn) return;

    const id = Number(btn.dataset.id);

    if (!id) return;

    if (btn.dataset.action === 'visualizar') {
      await abrirModalFornecedorVisualizar(id);
      return;
    }

    if (btn.dataset.action === 'editar') {
      await abrirModalFornecedorEditar(id);
      return;
    }

    if (btn.dataset.action === 'excluir') {
      await excluirFornecedor(id);
    }
  });
}

function bindCamposActions() {
  $('lista-campos-fornecedores')?.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-campo-action]');

    if (!btn) return;

    const id = Number(btn.dataset.id);

    if (!id) return;

    if (btn.dataset.campoAction === 'editar') {
      await abrirModalCampoEditar(id);
      return;
    }

    if (btn.dataset.campoAction === 'excluir') {
      await excluirCampo(id);
    }
  });
}

function bindTopActions() {
  $('btn-novo-fornecedor')?.addEventListener('click', abrirModalFornecedorNovo);
  $('btn-fechar-modal-fornecedor')?.addEventListener('click', fecharModalFornecedor);
  $('btn-cancelar-fornecedor')?.addEventListener('click', fecharModalFornecedor);
  $('formFornecedor')?.addEventListener('submit', salvarFornecedor);
  $('toggle-ficha-principal-fornecedor')?.addEventListener('change', salvarToggleFichaPrincipalFornecedor);

  $('btn-gerenciar-formulario-fornecedor')?.addEventListener('click', () => {
    window.location.href = '/frontend/formularios.html?modulo=fornecedores';
  });

  $('btn-fechar-modal-campo')?.addEventListener('click', fecharModalCampo);
  $('btn-cancelar-campo')?.addEventListener('click', fecharModalCampo);
  $('btn-salvar-campo')?.addEventListener('click', salvarCampo);
  $('campo-custom-tipo')?.addEventListener('change', syncCampoTipo);

  $('Valora-confirm-cancel')?.addEventListener('click', () => closeConfirm(false));
  $('Valora-confirm-ok')?.addEventListener('click', () => closeConfirm(true));

  $('btn-exportar-fornecedores-json')?.addEventListener('click', exportarFornecedoresJSON);
  $('btn-exportar-fornecedores-csv')?.addEventListener('click', exportarFornecedoresCSV);

  $('btn-importar-fornecedores')?.addEventListener('click', () => {
    $('input-importar-fornecedores')?.click();
  });

  $('input-importar-fornecedores')?.addEventListener('change', async (event) => {
    await importarFornecedores(event.target.files?.[0]);
    event.target.value = '';
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  bindTabs();
  bindModalCloseOnBackdrop();

  try {
    await window.ValoraLocalizarPersonalizado?.setup?.({
      modulo: 'fornecedores',
      filtersContainerId: 'localizar-personalizado-fornecedores',
    });
  } catch (err) {
    console.warn('[Fornecedores] localizar personalizado indisponível:', err);
  }

  bindFiltros();
  bindTabelaActions();
  bindCamposActions();
  bindTopActions();

  await carregarCamposFornecedores();
  await carregarFormularioFornecedores();
  aplicarModoFichaFornecedor();
  await carregarFornecedores();
});