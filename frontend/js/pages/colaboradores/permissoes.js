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
  'Conta e e-mail',
  'Outros'
];

const QUICK_PROFILES = [
  {
    id: 'atendente',
    label: 'Atendente',
    icon: 'fa-headset',
    hint: 'Atende e responde conversas liberadas para ele.',
    description: 'Atendimento do dia a dia',
    details: [
      'Visualizar e responder atendimentos',
      'Enviar mensagens, mídias e arquivos',
      'Assumir e transferir conversas permitidas',
      'Consultar clientes e o próprio perfil'
    ],
    note: 'O acesso continua limitado aos departamentos e números de WhatsApp selecionados para o colaborador.'
  },
  {
    id: 'supervisor',
    label: 'Supervisor',
    icon: 'fa-user-check',
    hint: 'Acompanha a equipe e controla a operação de atendimento.',
    description: 'Equipe e operação',
    details: [
      'Tudo o que o Atendente pode fazer',
      'Acompanhar e assumir conversas da equipe',
      'Transferir atendimentos e organizar responsáveis',
      'Consultar relatórios e dados operacionais'
    ],
    note: 'Não libera configurações críticas da empresa, integrações, planos ou gerenciamento geral de permissões.'
  },
  {
    id: 'comercial',
    label: 'Comercial',
    icon: 'fa-chart-line',
    hint: 'Trabalha clientes, contatos, campanhas e atendimento comercial.',
    description: 'Vendas e clientes',
    details: [
      'Visualizar e atender contatos comerciais',
      'Consultar e atualizar clientes',
      'Acessar campanhas e automações comerciais',
      'Consultar relatórios ligados à operação comercial'
    ],
    note: 'Não libera configurações administrativas ou permissões sensíveis da empresa.'
  },
  {
    id: 'financeiro',
    label: 'Financeiro',
    icon: 'fa-coins',
    hint: 'Cuida de cobranças, pagamentos e consultas financeiras.',
    description: 'Cobrança e consulta',
    details: [
      'Acessar os recursos financeiros liberados',
      'Consultar clientes para cobrança',
      'Acompanhar pagamentos e informações financeiras',
      'Consultar relatórios financeiros permitidos'
    ],
    note: 'O perfil evita permissões administrativas perigosas e ações fora da rotina financeira.'
  },
  {
    id: 'admin',
    label: 'Administrador',
    icon: 'fa-crown',
    hint: 'Acesso completo à empresa e a todas as configurações.',
    description: 'Acesso completo',
    details: [
      'Acesso a todos os módulos e atendimentos',
      'Gerenciar colaboradores e permissões',
      'Configurar WhatsApp, integrações e automações',
      'Alterar configurações gerais da empresa'
    ],
    note: 'Use apenas para pessoas de confiança. Este perfil marca todas as permissões disponíveis.',
    dangerous: true
  },
  {
    id: 'custom',
    label: 'Personalizado',
    icon: 'fa-sliders',
    hint: 'Escolha manualmente cada permissão.',
    description: 'Ajuste manual',
    details: [
      'Escolher permissão por permissão',
      'Combinar acessos de diferentes áreas',
      'Pesquisar e ajustar grupos específicos',
      'Criar um acesso sob medida para o colaborador'
    ],
    note: 'Ao alterar qualquer permissão manualmente, o perfil passa a ser considerado Personalizado.',
    custom: true
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
    'assumir atendimento',
    'midia',
    'mídia',
    'arquivo',
    'arquivos'
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
    'perfil',
    'email',
    'e-mail',
    'conta',
    'minha conta',
    'usuario logado',
    'usuário logado'
  ])) {
    return 'Conta e e-mail';
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
    if (dangerous) return false;

    if (group === 'Atendimento') {
      return !hasAny(text, [
        'apagar',
        'excluir',
        'gerenciar integração',
        'gerenciar integracao',
        'configurar chatbot',
        'configurar disparo'
      ]);
    }

    if (group === 'CRM / Clientes' && view) return true;
    if (group === 'Conta e e-mail' && view) return true;

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
      'Equipe e acessos',
      'Conta e e-mail'
    ].includes(group);
  }

  if (profile === 'comercial'){
    if (dangerous) return false;

    if ([
      'Atendimento',
      'CRM / Clientes',
      'Campanhas e automações',
      'Relatórios',
      'Conta e e-mail'
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
    if (group === 'Relatórios' && view) return true;
    if (group === 'Conta e e-mail' && view) return true;

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
    group,
    dangerous: isDangerousPermission(search)
  };
}

function createEl(tag, className, text){
  const el = document.createElement(tag);

  if (className) el.className = className;
  if (text != null) el.textContent = text;

  return el;
}

function getQuickProfile(profileId){
  return QUICK_PROFILES.find(profile => profile.id === profileId) || null;
}

function createProfileTooltip(profile){
  return null;
}

function getPermissionDataFromInput(input){
  const item = input?.closest('.perm-item');
  return {
    name: item?.querySelector('.perm-item-name')?.textContent?.trim() || item?.dataset.name || String(input?.value || '').trim(),
    group: item?.closest('.perm-group')?.dataset.group || item?.dataset.group || 'Outros',
    description: item?.querySelector('.perm-item-desc')?.textContent?.trim() || ''
  };
}

function getSelectedPermissionRows(){
  return [...document.querySelectorAll('#e-perms input[name="perm-edit"]:checked')]
    .map(getPermissionDataFromInput)
    .filter(item => item.name);
}

function buildProfilePermissionGroups(list, rows){
  list.innerHTML = '';

  const grouped = new Map();
  rows.forEach(row => {
    const group = row.group || 'Outros';
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(row);
  });

  [...grouped.entries()]
    .sort(([a], [b]) => {
      const ia = GROUP_ORDER.indexOf(a);
      const ib = GROUP_ORDER.indexOf(b);
      const oa = ia === -1 ? 999 : ia;
      const ob = ib === -1 ? 999 : ib;
      return oa - ob || a.localeCompare(b, 'pt-BR');
    })
    .forEach(([groupName, items]) => {
      const section = createEl('section', 'perm-profile-permission-group');
      const head = createEl('div', 'perm-profile-permission-group-head');
      const groupTitle = createEl('strong', 'perm-profile-permission-group-title', groupName);
      const groupCount = createEl('span', 'perm-profile-permission-group-count', `${items.length}`);
      head.appendChild(groupTitle);
      head.appendChild(groupCount);

      const ul = createEl('ul', 'perm-profile-permission-list');
      items.forEach(row => {
        const li = createEl('li', 'perm-profile-permission-item');
        const mark = createEl('span', 'perm-profile-permission-mark');
        mark.setAttribute('aria-hidden', 'true');
        const copy = createEl('div', 'perm-profile-permission-copy');
        const name = createEl('span', 'perm-profile-permission-name', row.name);
        copy.appendChild(name);
        if (row.description && normalizeText(row.description) !== normalizeText(row.name)) {
          const desc = createEl('small', 'perm-profile-permission-desc', row.description);
          copy.appendChild(desc);
        }
        li.appendChild(mark);
        li.appendChild(copy);
        ul.appendChild(li);
      });

      section.appendChild(head);
      section.appendChild(ul);
      list.appendChild(section);
    });
}

function closeProfileAccordions(exceptProfileId = null){
  document.querySelectorAll('.perm-profile-entry').forEach(entry => {
    const profileId = entry.dataset.profile;
    const open = !!exceptProfileId && profileId === exceptProfileId;
    entry.classList.toggle('is-open', open);
    const btn = entry.querySelector('.perm-profile-btn');
    const details = entry.querySelector('.perm-profile-details');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (details) details.hidden = !open;
  });
}

function renderProfileAccordion(profileId, { forceOpen = true } = {}){
  const profile = getQuickProfile(profileId);
  const entry = document.querySelector(`.perm-profile-entry[data-profile="${profileId}"]`);
  if (!profile || !entry) return;

  const details = entry.querySelector('.perm-profile-details');
  const list = entry.querySelector('.perm-profile-details-groups');
  const title = entry.querySelector('.perm-profile-details-title');
  const count = entry.querySelector('.perm-profile-details-count');
  const note = entry.querySelector('.perm-profile-details-note');
  const rows = getSelectedPermissionRows();

  if (title) {
    title.textContent = profile.custom
      ? 'Permissões selecionadas manualmente'
      : `Permissões incluídas no perfil ${profile.label}`;
  }
  if (count) {
    count.textContent = `${rows.length} de ${totalCount()} selecionadas`;
  }
  if (note) {
    note.textContent = profile.note || '';
    note.hidden = !profile.note;
  }
  if (list) {
    if (rows.length) {
      buildProfilePermissionGroups(list, rows);
    } else {
      list.innerHTML = '<div class="perm-profile-details-empty">Nenhuma permissão está selecionada neste perfil.</div>';
    }
  }

  if (forceOpen) closeProfileAccordions(profileId);
}

function updateProfileExplanation(profileId){
  const legacy = document.getElementById('perm-profile-selected');
  if (legacy) legacy.hidden = true;
}

function expandGroupsWithSelectedPermissions(){
  document.querySelectorAll('.perm-group').forEach(group => {
    const hasSelected = !!group.querySelector('input[name="perm-edit"]:checked');
    group.classList.toggle('is-collapsed', !hasSelected);
  });
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
    'Conta e e-mail': 'fa-solid fa-user-shield',
    'Outros': 'fa-solid fa-layer-group'
  };

  return map[groupName] || 'fa-solid fa-layer-group';
}

function selectedCount(){
  return document.querySelectorAll('#e-perms input[name="perm-edit"]:checked').length;
}

function totalCount(){
  return document.querySelectorAll('#e-perms input[name="perm-edit"]').length;
}

function setAdvancedOpen(open, opts = {}){
  const ePerms = document.getElementById('e-perms');
  const toolbar = document.getElementById('perm-toolbar');
  const actions = document.getElementById('perm-actions-panel');
  const editor = document.getElementById('perm-inline-editor');
  const editorTitle = document.getElementById('perm-inline-editor-title');
  const editorHint = document.getElementById('perm-inline-editor-hint');

  const isOpen = !!open;
  let targetProfile = opts.profileId || null;

  if (opts.activateCustom) {
    document.querySelectorAll('.perm-profile-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.profile === 'custom');
    });
    updateProfileExplanation('custom');
  }

  if (!targetProfile && editor?.parentElement?.classList?.contains('perm-profile-entry')) {
    targetProfile = editor.parentElement.dataset.profile || null;
  }

  if (!targetProfile) {
    targetProfile = document.querySelector('.perm-profile-btn.active')?.dataset.profile || null;
  }

  if (isOpen && editor && targetProfile) {
    const entry = document.querySelector(`.perm-profile-entry[data-profile="${targetProfile}"]`);
    const profile = getQuickProfile(opts.activateCustom ? 'custom' : targetProfile);

    if (entry && editor.parentElement !== entry) {
      entry.appendChild(editor);
    }

    editor.hidden = false;

    if (editorTitle) {
      editorTitle.textContent = profile?.custom
        ? 'Escolha as permissões manualmente'
        : `Permissões do perfil ${profile?.label || ''}`.trim();
    }
    if (editorHint) {
      editorHint.textContent = profile?.custom
        ? 'Marque somente os acessos que este colaborador realmente precisa.'
        : 'As opções marcadas abaixo fazem parte deste perfil e podem ser ajustadas se necessário.';
    }

    closeProfileAccordions(targetProfile);
  } else {
    if (editor) editor.hidden = true;
    closeProfileAccordions(null);
  }

  if (ePerms) {
    ePerms.hidden = !isOpen;
    ePerms.style.display = isOpen ? 'grid' : 'none';
  }

  if (actions) actions.hidden = !isOpen;
  if (toolbar) toolbar.classList.toggle('advanced-open', isOpen);
}

function renderToolbar(container){
  const ePerms = document.getElementById('e-perms');
  const old = document.getElementById('perm-toolbar');

  // O editor real (#e-perms) é movido para dentro do perfil aberto. Antes de
  // recriar a toolbar, devolvemos o elemento ao <dd> para não removê-lo junto.
  if (old && ePerms && old.contains(ePerms)) {
    container.appendChild(ePerms);
  }
  if (old) old.remove();

  const toolbar = createEl('div', 'perm-toolbar perm-toolbar-profile-first perm-toolbar-real-editor perm-toolbar-accordion');
  toolbar.id = 'perm-toolbar';

  const top = createEl('div', 'perm-toolbar-top');
  const titleWrap = createEl('div', 'perm-toolbar-title');
  const title = createEl('strong', '', 'Perfil de acesso');
  const subtitle = createEl('span', '', 'Selecione um perfil para marcar as permissões automaticamente. Clique nele para ver as opções logo abaixo.');
  titleWrap.appendChild(title);
  titleWrap.appendChild(subtitle);

  const summary = createEl('div', 'perm-summary');
  summary.id = 'perm-summary';
  summary.textContent = '0 selecionadas';
  top.appendChild(titleWrap);
  top.appendChild(summary);

  const profiles = createEl('div', 'perm-profile-list perm-profile-list-main perm-profile-list-real perm-profile-list-accordion');

  QUICK_PROFILES.forEach(profile => {
    const entry = createEl('div', 'perm-profile-entry');
    entry.dataset.profile = profile.id;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `perm-profile-btn perm-profile-row-real${profile.custom ? ' perm-profile-custom' : ''}${profile.dangerous ? ' perm-profile-danger' : ''}`;
    btn.dataset.profile = profile.id;
    btn.setAttribute('aria-label', `${profile.label}: ${profile.description || profile.hint}`);
    btn.setAttribute('aria-expanded', 'false');

    const radio = createEl('span', 'perm-profile-radio-real');
    radio.setAttribute('aria-hidden', 'true');

    const label = createEl('strong', 'perm-profile-row-real-title', profile.label);
    const desc = createEl('span', 'perm-profile-row-real-desc', profile.description || profile.hint || '');
    const arrow = createEl('span', 'perm-profile-row-real-arrow');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';

    btn.appendChild(radio);
    btn.appendChild(label);
    btn.appendChild(desc);
    btn.appendChild(arrow);
    entry.appendChild(btn);
    profiles.appendChild(entry);
  });

  // Um único editor real é reutilizado e movido para dentro da linha clicada.
  // Assim não duplicamos inputs nem alteramos o formato salvo no backend.
  const inlineEditor = createEl('div', 'perm-inline-editor');
  inlineEditor.id = 'perm-inline-editor';
  inlineEditor.hidden = true;

  const editorHead = createEl('div', 'perm-inline-editor-head');
  const editorCopy = createEl('div', 'perm-inline-editor-copy');
  const editorTitle = createEl('strong', '', 'Permissões do perfil');
  editorTitle.id = 'perm-inline-editor-title';
  const editorHint = createEl('span', '', 'Confira e ajuste as permissões deste perfil.');
  editorHint.id = 'perm-inline-editor-hint';
  editorCopy.appendChild(editorTitle);
  editorCopy.appendChild(editorHint);
  editorHead.appendChild(editorCopy);

  const actions = createEl('div', 'perm-actions perm-inline-actions');
  actions.id = 'perm-actions-panel';
  actions.hidden = true;

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

  inlineEditor.appendChild(editorHead);
  inlineEditor.appendChild(actions);
  if (ePerms) inlineEditor.appendChild(ePerms);

  toolbar.appendChild(top);
  toolbar.appendChild(profiles);
  // Fica oculto aqui até o primeiro clique; setAdvancedOpen o move para a
  // .perm-profile-entry correspondente.
  toolbar.appendChild(inlineEditor);
  container.insertBefore(toolbar, container.firstChild);
  return toolbar;
}

function updateSummary(){
  const total = totalCount();
  const selected = selectedCount();
  const summary = document.getElementById('perm-summary');

  if (summary) {
    summary.textContent = total
      ? `${selected} de ${total} selecionadas`
      : 'Nenhuma permissão';
  }

  updateGroupStates();

  const activeProfile = document.querySelector('.perm-profile-btn.active')?.dataset.profile;
  if (activeProfile) updateProfileExplanation(activeProfile);
}

function updateGroupStates(){
  document.querySelectorAll('.perm-group').forEach(group => {
    const inputs = [...group.querySelectorAll('input[name="perm-edit"]')];
    const groupToggle = group.querySelector('.perm-group-toggle-input');
    const selectedCountGroup = inputs.filter(i => i.checked).length;
    const totalGroup = inputs.length;

    const countEl = group.querySelector('.perm-group-selected-count');
    if (countEl) {
      countEl.textContent = `${selectedCountGroup}/${totalGroup}`;
    }

    if (groupToggle) {
      groupToggle.checked = totalGroup > 0 && selectedCountGroup === totalGroup;
      groupToggle.indeterminate = selectedCountGroup > 0 && selectedCountGroup < totalGroup;
    }

    group.classList.toggle('has-selection', selectedCountGroup > 0);
    group.classList.toggle('all-selected', totalGroup > 0 && selectedCountGroup === totalGroup);
  });
}

function setAllPermissions(checked){
  document.querySelectorAll('#e-perms input[name="perm-edit"]').forEach(input => {
    input.checked = !!checked;
  });

  document.querySelectorAll('.perm-profile-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  setAdvancedOpen(true, { activateCustom: true });
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

  setAdvancedOpen(true, { activateCustom: true });
  updateSummary();
}

function applyQuickProfile(profile){
  if (profile === 'custom') {
    document.querySelectorAll('.perm-profile-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.profile === 'custom');
    });
    setAdvancedOpen(true, { profileId: 'custom' });
    expandGroupsWithSelectedPermissions();
    updateSummary();
    return;
  }

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
  setAdvancedOpen(true, { profileId: profile });
  expandGroupsWithSelectedPermissions();
}

function detectMatchingQuickProfile(){
  const inputs = [...document.querySelectorAll('#e-perms input[name="perm-edit"]')];
  if (!inputs.length) return null;

  for (const profile of QUICK_PROFILES.filter(p => !p.custom)) {
    let matches = true;
    for (const input of inputs) {
      const item = input.closest('.perm-item');
      const fakePermission = {
        id: input.value,
        nome: item?.dataset.name || '',
        descricao: item?.dataset.raw || '',
        grupo: item?.dataset.group || ''
      };
      if (input.checked !== shouldSelectForProfile(profile.id, fakePermission)) {
        matches = false;
        break;
      }
    }
    if (matches) return profile.id;
  }
  return 'custom';
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

    if (q && groupVisible) {
      group.classList.remove('is-collapsed');
    }

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
      const profileId = btn.dataset.profile;
      const entry = btn.closest('.perm-profile-entry');
      const editor = document.getElementById('perm-inline-editor');
      const isAlreadyOpen = !!entry && !!editor && !editor.hidden && editor.parentElement === entry;

      // Segundo clique no mesmo perfil apenas recolhe as opções. O primeiro
      // clique (ou a troca de perfil) aplica o perfil e abre logo abaixo dele.
      if (isAlreadyOpen && btn.classList.contains('active')) {
        setAdvancedOpen(false);
        return;
      }

      applyQuickProfile(profileId);
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

  document.querySelectorAll('.perm-group-head').forEach(head => {
    head.addEventListener('click', ev => {
      if (ev.target.closest('button, label, input, .perm-group-controls')) return;
      const group = head.closest('.perm-group');
      group?.classList.toggle('is-collapsed');
    });

    head.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      if (ev.target.closest('button, label, input, .perm-group-controls')) return;
      ev.preventDefault();
      const group = head.closest('.perm-group');
      group?.classList.toggle('is-collapsed');
    });
  });

  document.querySelectorAll('#e-perms input[name="perm-edit"]').forEach(input => {
    input.addEventListener('change', () => {
      // Alterou manualmente: o conjunto passa a ser personalizado, mas o
      // editor permanece exatamente sob o perfil que a pessoa está ajustando.
      document.querySelectorAll('.perm-profile-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.profile === 'custom');
      });
      setAdvancedOpen(true, { activateCustom: true });
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
  ePerms.style.display = 'grid';

  const frag = document.createDocumentFragment();

  GROUP_ORDER.forEach(groupName => {
    const groupItems = grouped.get(groupName);
    if (!groupItems || !groupItems.length) return;

    const group = createEl('section', 'perm-group is-collapsed');
    group.dataset.group = groupName;

    const head = createEl('div', 'perm-group-head');
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-label', `Abrir permissões de ${groupName}`);

    const title = createEl('div', 'perm-group-title');

    const chevron = document.createElement('i');
    chevron.className = 'fa-solid fa-chevron-right perm-group-chevron';
    chevron.setAttribute('aria-hidden', 'true');

    const icon = document.createElement('i');
    icon.className = groupIconClass(groupName);

    const label = createEl('span', '', groupName);

    title.appendChild(chevron);
    title.appendChild(icon);
    title.appendChild(label);

    const controls = createEl('div', 'perm-group-controls');

    const selectedCountEl = createEl('span', 'perm-group-selected-count', `0/${groupItems.length}`);

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

    controls.appendChild(selectedCountEl);
    controls.appendChild(toggleLabel);
    controls.appendChild(clearBtn);

    head.appendChild(title);
    head.appendChild(controls);

    const body = createEl('div', 'perm-group-body');

    groupItems.forEach(item => {
      const lab = createEl('label', `perm-item chk-line${item.dangerous ? ' perm-item-danger' : ''}`);
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

      if (item.dangerous) {
        const warn = createEl('small', 'perm-item-warn', 'Permissão sensível');
        main.appendChild(warn);
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
  setAdvancedOpen(false);

  const detectedProfile = detectMatchingQuickProfile();
  if (detectedProfile) {
    document.querySelectorAll('.perm-profile-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.profile === detectedProfile);
    });
  }
}

export async function ensurePermsEdit(){
  const { ePerms } = els();

  if (!ePerms) return;

  const dd = ePerms.closest('dd') || ePerms.parentElement;

  if (dd) {
    renderToolbar(dd);
  }

  ePerms.innerHTML = '';
  ePerms.style.display = 'none';
  ePerms.hidden = true;
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
      setAdvancedOpen(false);
      return;
    }

    renderPermissionGroups(ePerms, items);
  } catch (e) {
    console.warn('[colaboradores] falha ao carregar permissões', e);
    ePerms.innerHTML = '<div class="perm-empty">Permissões indisponíveis.</div>';
    updateSummary();
    setAdvancedOpen(false);
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
