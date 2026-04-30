// frontend/js/pages/colaboradores/permissoes.js

import { apiGet, apiJSON } from './api.js';
import { state } from './state.js';
import { els } from './dom.js';

const GROUP_ORDER = [
  'Atendimento',
  'CRM / Clientes',
  'Campanhas e automações',
  'Financeiro',
  'Relatórios',
  'Equipe e acessos',
  'Configurações',
  'Outros'
];

const QUICK_PROFILES = [
  {
    id: 'atendente',
    label: 'Atendente',
    icon: 'fa-headset',
    hint: 'Básico para responder clientes.'
  },
  {
    id: 'supervisor',
    label: 'Supervisor',
    icon: 'fa-user-check',
    hint: 'Atendimento, equipe e relatórios.'
  },
  {
    id: 'comercial',
    label: 'Comercial',
    icon: 'fa-chart-line',
    hint: 'Clientes, leads e funil.'
  },
  {
    id: 'financeiro',
    label: 'Financeiro',
    icon: 'fa-coins',
    hint: 'Clientes e cobrança.'
  },
  {
    id: 'admin',
    label: 'Administrador',
    icon: 'fa-crown',
    hint: 'Marca todas as permissões.'
  }
];

function normalizeText(value){
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function hasAny(text, words){
  const h = normalizeText(text);
  return words.some(w => h.includes(normalizeText(w)));
}

function getPermissionId(p){
  return (
    p?.id ??
    p?.value ??
    p?.key ??
    p?.codigo ??
    p?.slug ??
    p?.chave ??
    p?.nome ??
    p
  );
}

function getPermissionName(p){
  return String(
    p?.nome ??
    p?.name ??
    p?.label ??
    p?.titulo ??
    p?.title ??
    p?.descricao ??
    p?.description ??
    getPermissionId(p) ??
    'Permissão'
  );
}

function getPermissionDescription(p){
  return String(
    p?.descricao ??
    p?.description ??
    p?.detalhe ??
    p?.help ??
    ''
  );
}

function getPermissionSearchText(p){
  return [
    getPermissionId(p),
    getPermissionName(p),
    getPermissionDescription(p),
    p?.modulo,
    p?.module,
    p?.grupo,
    p?.group,
    p?.categoria,
    p?.category
  ].filter(Boolean).join(' ');
}

function currentPermissionSet(){
  const out = new Set();

  const arr = Array.isArray(state.viewing?.permissoes)
    ? state.viewing.permissoes
    : [];

  arr.forEach(x => {
    if (x && typeof x === 'object'){
      [
        x.id,
        x.value,
        x.key,
        x.codigo,
        x.slug,
        x.chave,
        x.nome,
        x.name,
        x.label
      ].forEach(v => {
        if (v != null) out.add(String(v));
      });
    } else if (x != null) {
      out.add(String(x));
    }
  });

  return out;
}

function inferGroup(p){
  const text = getPermissionSearchText(p);

  if (hasAny(text, [
    'atendimento',
    'conversa',
    'mensagem',
    'whatsapp',
    'fila',
    'chat',
    'chatbot',
    'status atendimento',
    'responsavel atendimento',
    'transferir atendimento',
    'assumir atendimento'
  ])) {
    return 'Atendimento';
  }

  if (hasAny(text, [
    'cliente',
    'clientes',
    'crm',
    'lead',
    'leads',
    'funil',
    'contato',
    'contatos',
    'pipeline',
    'negocio',
    'negocios',
    'comercial',
    'venda',
    'vendas'
  ])) {
    return 'CRM / Clientes';
  }

  if (hasAny(text, [
    'disparo',
    'disparos',
    'campanha',
    'campanhas',
    'automacao',
    'automacoes',
    'broadcast',
    'sequencia',
    'modelo mensagem',
    'template'
  ])) {
    return 'Campanhas e automações';
  }

  if (hasAny(text, [
    'financeiro',
    'cobranca',
    'cobrança',
    'pagamento',
    'fatura',
    'plano',
    'assinatura',
    'boleto',
    'pix',
    'receita'
  ])) {
    return 'Financeiro';
  }

  if (hasAny(text, [
    'relatorio',
    'relatorios',
    'dashboard',
    'metricas',
    'métricas',
    'grafico',
    'gráfico',
    'analytics',
    'produtividade'
  ])) {
    return 'Relatórios';
  }

  if (hasAny(text, [
    'colaborador',
    'colaboradores',
    'usuario',
    'usuarios',
    'usuário',
    'usuários',
    'permissao',
    'permissões',
    'equipe',
    'departamento',
    'setor',
    'cargo'
  ])) {
    return 'Equipe e acessos';
  }

  if (hasAny(text, [
    'empresa',
    'config',
    'configuracao',
    'configuração',
    'integracao',
    'integração',
    'instancia',
    'instância',
    'token',
    'seguranca',
    'segurança',
    'sistema',
    'admin'
  ])) {
    return 'Configurações';
  }

  return 'Outros';
}

function isDangerousPermission(text){
  return hasAny(text, [
    'admin',
    'administrador',
    'permissao',
    'permissões',
    'empresa',
    'config',
    'configuracao',
    'configuração',
    'integracao',
    'integração',
    'token',
    'seguranca',
    'segurança',
    'excluir',
    'deletar',
    'remover',
    'apagar',
    'delete',
    'destroy',
    'gerenciar colaboradores',
    'colaboradores.gerenciar',
    'usuarios.gerenciar',
    'usuários.gerenciar',
    'permissoes.gerenciar',
    'permissões.gerenciar'
  ]);
}

function isWriteDanger(text){
  return hasAny(text, [
    'excluir',
    'deletar',
    'remover',
    'apagar',
    'delete',
    'destroy',
    'gerenciar',
    'administrar',
    'configurar'
  ]);
}

function isViewPermission(text){
  return hasAny(text, [
    'ver',
    'visualizar',
    'listar',
    'consultar',
    'ler',
    'view',
    'read'
  ]);
}

function shouldSelectForProfile(profile, p){
  const text = getPermissionSearchText(p);

  if (profile === 'admin') return true;

  const group = inferGroup(p);
  const dangerous = isDangerousPermission(text);
  const writeDanger = isWriteDanger(text);
  const view = isViewPermission(text);

  if (profile === 'atendente'){
    if (dangerous || writeDanger) return false;

    if (group === 'Atendimento') return true;
    if (group === 'CRM / Clientes' && view) return true;

    return hasAny(text, [
      'mensagem.enviar',
      'mensagens.enviar',
      'responder',
      'assumir',
      'transferir',
      'status',
      'responsavel',
      'responsável'
    ]);
  }

  if (profile === 'supervisor'){
    if (hasAny(text, [
      'empresa',
      'config',
      'configuracao',
      'configuração',
      'integracao',
      'integração',
      'token',
      'permissao',
      'permissões',
      'admin',
      'assinatura',
      'plano',
      'fatura'
    ])) {
      return false;
    }

    return [
      'Atendimento',
      'CRM / Clientes',
      'Relatórios',
      'Equipe e acessos'
    ].includes(group);
  }

  if (profile === 'comercial'){
    if (dangerous) return false;

    if ([
      'Atendimento',
      'CRM / Clientes',
      'Campanhas e automações',
      'Relatórios'
    ].includes(group)) {
      return true;
    }

    return hasAny(text, [
      'lead',
      'leads',
      'funil',
      'crm',
      'cliente',
      'clientes',
      'proposta',
      'venda',
      'vendas',
      'comercial'
    ]);
  }

  if (profile === 'financeiro'){
    if (dangerous) return false;

    if (group === 'Financeiro') return true;
    if (group === 'CRM / Clientes' && view) return true;
    if (group === 'Atendimento' && !writeDanger) return true;

    return hasAny(text, [
      'cobranca',
      'cobrança',
      'pagamento',
      'financeiro'
    ]);
  }

  return false;
}

function normalizePermissionItem(p){
  const id = getPermissionId(p);
  const name = getPermissionName(p);
  const description = getPermissionDescription(p);
  const search = getPermissionSearchText(p);
  const group = inferGroup(p);

  return {
    original: p,
    id,
    value: String(id),
    name,
    description,
    search: normalizeText(search),
    group
  };
}

function createEl(tag, className, text){
  const el = document.createElement(tag);

  if (className) el.className = className;
  if (text != null) el.textContent = text;

  return el;
}

function groupIconClass(groupName){
  const map = {
    'Atendimento': 'fa-solid fa-headset',
    'CRM / Clientes': 'fa-solid fa-address-book',
    'Campanhas e automações': 'fa-solid fa-bolt',
    'Financeiro': 'fa-solid fa-coins',
    'Relatórios': 'fa-solid fa-chart-simple',
    'Equipe e acessos': 'fa-solid fa-users-gear',
    'Configurações': 'fa-solid fa-gear',
    'Outros': 'fa-solid fa-layer-group'
  };

  return map[groupName] || 'fa-solid fa-layer-group';
}

function renderToolbar(container){
  const old = document.getElementById('perm-toolbar');
  if (old) old.remove();

  const toolbar = createEl('div', 'perm-toolbar');
  toolbar.id = 'perm-toolbar';

  const top = createEl('div', 'perm-toolbar-top');

  const titleWrap = createEl('div', 'perm-toolbar-title');
  const title = createEl('strong', '', 'Perfil rápido');
  const subtitle = createEl('span', '', 'Escolha um modelo e ajuste apenas o que precisar.');

  titleWrap.appendChild(title);
  titleWrap.appendChild(subtitle);

  const summary = createEl('div', 'perm-summary');
  summary.id = 'perm-summary';
  summary.textContent = '0 selecionadas';

  top.appendChild(titleWrap);
  top.appendChild(summary);

  const profiles = createEl('div', 'perm-profile-list');

  QUICK_PROFILES.forEach(profile => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'perm-profile-btn';
    btn.dataset.profile = profile.id;
    btn.title = profile.hint;

    const icon = document.createElement('i');
    icon.className = `fa-solid ${profile.icon}`;

    const text = document.createElement('span');
    text.textContent = profile.label;

    btn.appendChild(icon);
    btn.appendChild(text);

    profiles.appendChild(btn);
  });

  const actions = createEl('div', 'perm-actions');

  const searchWrap = createEl('label', 'perm-search');
  const searchIcon = document.createElement('i');
  searchIcon.className = 'fa-solid fa-magnifying-glass';

  const search = document.createElement('input');
  search.id = 'perm-search-input';
  search.type = 'search';
  search.placeholder = 'Buscar permissão…';
  search.autocomplete = 'off';

  searchWrap.appendChild(searchIcon);
  searchWrap.appendChild(search);

  const selectAll = document.createElement('button');
  selectAll.type = 'button';
  selectAll.id = 'perm-select-all';
  selectAll.className = 'btn btn-ghost';
  selectAll.textContent = 'Marcar tudo';

  const clearAll = document.createElement('button');
  clearAll.type = 'button';
  clearAll.id = 'perm-clear-all';
  clearAll.className = 'btn btn-ghost';
  clearAll.textContent = 'Limpar tudo';

  actions.appendChild(searchWrap);
  actions.appendChild(selectAll);
  actions.appendChild(clearAll);

  toolbar.appendChild(top);
  toolbar.appendChild(profiles);
  toolbar.appendChild(actions);

  container.insertBefore(toolbar, container.firstChild);

  return toolbar;
}

function updateSummary(){
  const total = document.querySelectorAll('#e-perms input[name="perm-edit"]').length;
  const selected = document.querySelectorAll('#e-perms input[name="perm-edit"]:checked').length;
  const summary = document.getElementById('perm-summary');

  if (summary) {
    summary.textContent = `${selected} de ${total} selecionadas`;
  }

  updateGroupStates();
}

function updateGroupStates(){
  document.querySelectorAll('.perm-group').forEach(group => {
    const inputs = [...group.querySelectorAll('input[name="perm-edit"]')];
    const groupToggle = group.querySelector('.perm-group-toggle-input');
    const selectedCount = inputs.filter(i => i.checked).length;
    const total = inputs.length;

    const countEl = group.querySelector('.perm-group-selected-count');
    if (countEl) {
      countEl.textContent = `${selectedCount}/${total}`;
    }

    if (groupToggle) {
      groupToggle.checked = total > 0 && selectedCount === total;
      groupToggle.indeterminate = selectedCount > 0 && selectedCount < total;
    }

    group.classList.toggle('has-selection', selectedCount > 0);
    group.classList.toggle('all-selected', total > 0 && selectedCount === total);
  });
}

function setAllPermissions(checked){
  document.querySelectorAll('#e-perms input[name="perm-edit"]').forEach(input => {
    input.checked = !!checked;
  });

  document.querySelectorAll('.perm-profile-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  updateSummary();
}

function setGroupPermissions(groupEl, checked){
  if (!groupEl) return;

  groupEl.querySelectorAll('input[name="perm-edit"]').forEach(input => {
    input.checked = !!checked;
  });

  document.querySelectorAll('.perm-profile-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  updateSummary();
}

function applyQuickProfile(profile){
  const inputs = document.querySelectorAll('#e-perms input[name="perm-edit"]');

  inputs.forEach(input => {
    const item = input.closest('.perm-item');
    const raw = item?.dataset.raw || '';
    const name = item?.dataset.name || '';
    const group = item?.dataset.group || '';

    const fakePermission = {
      id: input.value,
      nome: name,
      descricao: raw,
      grupo: group
    };

    input.checked = shouldSelectForProfile(profile, fakePermission);
  });

  document.querySelectorAll('.perm-profile-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.profile === profile);
  });

  updateSummary();
}

function filterPermissions(query){
  const q = normalizeText(query);
  const groups = document.querySelectorAll('.perm-group');
  const empty = document.getElementById('perm-empty-filter');

  let visibleCount = 0;

  groups.forEach(group => {
    let groupVisible = 0;

    group.querySelectorAll('.perm-item').forEach(item => {
      const haystack = item.dataset.search || '';
      const visible = !q || haystack.includes(q);

      item.style.display = visible ? '' : 'none';

      if (visible) {
        groupVisible++;
        visibleCount++;
      }
    });

    group.style.display = groupVisible ? '' : 'none';

    const countEl = group.querySelector('.perm-group-visible-count');
    if (countEl) {
      countEl.textContent = `${groupVisible}`;
    }
  });

  if (empty) {
    empty.style.display = visibleCount ? 'none' : 'block';
  }
}

function bindToolbarEvents(){
  document.querySelectorAll('.perm-profile-btn').forEach(btn => {
    btn.onclick = () => {
      applyQuickProfile(btn.dataset.profile);
    };
  });

  const selectAll = document.getElementById('perm-select-all');
  const clearAll = document.getElementById('perm-clear-all');
  const search = document.getElementById('perm-search-input');

  if (selectAll) {
    selectAll.onclick = () => {
      setAllPermissions(true);
    };
  }

  if (clearAll) {
    clearAll.onclick = () => {
      setAllPermissions(false);
    };
  }

  if (search) {
    search.oninput = () => {
      filterPermissions(search.value);
    };
  }

  document.querySelectorAll('.perm-group-toggle-input').forEach(input => {
    input.addEventListener('change', () => {
      const group = input.closest('.perm-group');
      setGroupPermissions(group, input.checked);
    });
  });

  document.querySelectorAll('.perm-group-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.perm-group');
      setGroupPermissions(group, false);
    });
  });

  document.querySelectorAll('#e-perms input[name="perm-edit"]').forEach(input => {
    input.addEventListener('change', () => {
      document.querySelectorAll('.perm-profile-btn').forEach(btn => btn.classList.remove('active'));
      updateSummary();
    });
  });

  updateSummary();
}

function renderPermissionGroups(ePerms, rawItems){
  const current = currentPermissionSet();

  const items = rawItems
    .map(normalizePermissionItem)
    .filter(item => item.id != null && item.value !== '');

  items.sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.group);
    const gb = GROUP_ORDER.indexOf(b.group);

    const oa = ga === -1 ? 999 : ga;
    const ob = gb === -1 ? 999 : gb;

    if (oa !== ob) return oa - ob;

    return a.name.localeCompare(b.name, 'pt-BR');
  });

  const grouped = new Map();

  items.forEach(item => {
    if (!grouped.has(item.group)) grouped.set(item.group, []);
    grouped.get(item.group).push(item);
  });

  ePerms.innerHTML = '';
  ePerms.classList.add('perms-enhanced');
  ePerms.style.display = 'block';

  const frag = document.createDocumentFragment();

  GROUP_ORDER.forEach(groupName => {
    const groupItems = grouped.get(groupName);
    if (!groupItems || !groupItems.length) return;

    const group = createEl('section', 'perm-group');
    group.dataset.group = groupName;

    const head = createEl('div', 'perm-group-head');

    const title = createEl('div', 'perm-group-title');

    const icon = document.createElement('i');
    icon.className = groupIconClass(groupName);

    const label = createEl('span', '', groupName);

    title.appendChild(icon);
    title.appendChild(label);

    const controls = createEl('div', 'perm-group-controls');

    const selectedCount = createEl('span', 'perm-group-selected-count', `0/${groupItems.length}`);

    const toggleLabel = createEl('label', 'perm-group-toggle');

    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.className = 'perm-group-toggle-input';

    const toggleText = createEl('span', '', 'Marcar grupo');

    toggleLabel.appendChild(toggleInput);
    toggleLabel.appendChild(toggleText);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'perm-group-clear';
    clearBtn.textContent = 'Limpar';

    controls.appendChild(selectedCount);
    controls.appendChild(toggleLabel);
    controls.appendChild(clearBtn);

    head.appendChild(title);
    head.appendChild(controls);

    const body = createEl('div', 'perm-group-body');

    groupItems.forEach(item => {
      const lab = createEl('label', 'perm-item chk-line');
      lab.dataset.search = item.search;
      lab.dataset.raw = item.search;
      lab.dataset.name = item.name;
      lab.dataset.group = item.group;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'perm-edit';
      input.value = item.value;

      if (
        current.has(String(item.id)) ||
        current.has(String(item.value)) ||
        current.has(String(item.name))
      ) {
        input.checked = true;
      }

      const main = createEl('span', 'perm-item-main');

      const name = createEl('span', 'perm-item-name', item.name);
      main.appendChild(name);

      if (item.description && normalizeText(item.description) !== normalizeText(item.name)){
        const desc = createEl('small', 'perm-item-desc', item.description);
        main.appendChild(desc);
      }

      lab.appendChild(input);
      lab.appendChild(main);

      body.appendChild(lab);
    });

    group.appendChild(head);
    group.appendChild(body);

    frag.appendChild(group);
  });

  const emptyFilter = createEl('div', 'perm-empty-filter');
  emptyFilter.id = 'perm-empty-filter';
  emptyFilter.style.display = 'none';
  emptyFilter.textContent = 'Nenhuma permissão encontrada nessa busca.';

  frag.appendChild(emptyFilter);

  ePerms.appendChild(frag);

  bindToolbarEvents();
}

export async function ensurePermsEdit(){
  const { ePerms } = els();

  if (!ePerms) return;

  const dd = ePerms.closest('dd') || ePerms.parentElement;

  if (dd) {
    renderToolbar(dd);
  }

  ePerms.innerHTML = '';
  ePerms.style.display = 'block';
  ePerms.classList.add('perms-enhanced');

  const loading = document.createElement('div');
  loading.className = 'perm-loading';
  loading.textContent = 'Carregando permissões…';
  ePerms.appendChild(loading);

  try {
    const list = await apiGet('/api/permissoes');
    const items = Array.isArray(list) ? list : (list?.items || list?.data || []);

    if (!items.length){
      ePerms.innerHTML = '<div class="perm-empty">Nenhuma permissão cadastrada.</div>';
      updateSummary();
      return;
    }

    renderPermissionGroups(ePerms, items);
  } catch (e) {
    console.warn('[colaboradores] falha ao carregar permissões', e);
    ePerms.innerHTML = '<div class="perm-empty">Permissões indisponíveis.</div>';
    updateSummary();
  }
}

export function getPermsSelecionadasEdit(){
  return [...document.querySelectorAll('#e-perms input[name="perm-edit"]:checked')]
    .map(i => i.value);
}

export async function savePerms(id, arr){
  const payload = {
    permissoes: arr
  };

  const tries = [
    { path: `/api/permissoes/colaboradores/${id}`, method: 'PUT' },
    { path: `/api/colaboradores/${id}/permissoes`, method: 'PUT' },
    { path: `/api/colaboradores/${id}/permissoes`, method: 'POST' },
    { path: `/api/colaboradores/${id}`, method: 'PUT' }
  ];

  let lastError = null;

  for (const t of tries){
    try {
      await apiJSON(t.path, t.method, payload);
      return true;
    } catch (e) {
      lastError = e;
    }
  }

  console.warn('[colaboradores] falha ao salvar permissões', id, lastError);
  return false;
}