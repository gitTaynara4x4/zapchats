// /frontend/js/pages/cliente-editar.js
(function ClienteEditorModule(){
  'use strict';

  // ==============================
  // Config / Helpers de API
  // ==============================
  const LS = localStorage;
  const EMPRESA_ID = Number(LS.getItem('empresa_id') || '') || null;
  const $  = (s, r=document) => r.querySelector(s);

  const authFetch = (url, opt={}) => {
    const f = (window.ZAuth && ZAuth.authFetch) ? ZAuth.authFetch : fetch;
    const headers = Object.assign(
      { 'Accept':'application/json' },
      opt.headers || {},
      EMPRESA_ID ? { 'X-Empresa-Id': String(EMPRESA_ID) } : {}
    );
    return f(url, { credentials:'include', ...opt, headers });
  };
  function withEmpresaIdQuery(path){
    try{
      const u = new URL(path, location.origin);
      if (EMPRESA_ID && !u.searchParams.has('empresa_id')) u.searchParams.set('empresa_id', String(EMPRESA_ID));
      return u.toString();
    }catch{
      const sep = path.includes('?') ? '&' : '?';
      return (EMPRESA_ID && !/(\?|&)empresa_id=/.test(path)) ? path+sep+'empresa_id='+EMPRESA_ID : path;
    }
  }
  async function parseMaybeJSON(res){
    const txt = await res.text().catch(()=> '');
    try { return txt ? JSON.parse(txt) : null; } catch { return txt || null; }
  }
  function throwHTTP(res, data){
    const err = new Error((data && (data.detail || data.message)) || res.statusText || 'Erro');
    err.status = res.status; err.data = data; throw err;
  }
  async function apiGet(path){
    const r = await authFetch(withEmpresaIdQuery(path));
    const data = await parseMaybeJSON(r);
    if (!r.ok) throwHTTP(r, data);
    return data;
  }
  async function apiPatch(path, body){
    const r = await authFetch(withEmpresaIdQuery(path), {
      method:'PATCH',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(body||{})
    });
    const data = await parseMaybeJSON(r);
    if (!r.ok) throwHTTP(r, data);
    return data;
  }

  // ==============================
  // DOM refs (reuso do modal de "Novo")
  // ==============================
  const novoModal      = $('#novo-backdrop');
  const novoNome       = $('#novoNome');
  const novoTel        = $('#novoTel');
  const novoDepto      = $('#novoDepto');
  const novoColab      = $('#novoColab');
  const novoSobre      = $('#novoSobre');
  const novoOkOriginal = $('#novoOk');
  const novoCancel     = $('#novoCancel');
  const novoClose      = $('#novoClose');
  const toastEl        = $('#toast');

  const cliId           = $('#cliId');
  const cliDataCadastro = $('#cliDataCadastro');

  const extraFields = {
    cpf_cnpj:        $('#cliCpfCnpj'),
    rg:              $('#cliRg'),
    email:           $('#cliEmail'),
    nome_whatsapp:   $('#cliNomeWhatsapp'),
    status_whatsapp: $('#cliStatusWhatsapp'),
    descricao:       $('#cliDescricao'),
    website:         $('#cliWebsite'),
    nome_completo:   $('#cliNomeCompleto'),
    cep:             $('#cliCep'),
    endereco:        $('#cliEndereco'),
    numero:          $('#cliNumero'),
    complemento:     $('#cliComplemento'),
    bairro:          $('#cliBairro'),
    cidade:          $('#cliCidade'),
    estado:          $('#cliEstado'),
    genero:          $('#cliGenero'),
    data_nascimento: $('#cliDataNascimento'),
    is_business:     $('#cliIsBusiness')
  };

  // ==============================
  // Estado local do módulo
  // ==============================
  let clienteModalMode = 'new'; // 'new' | 'view' | 'edit'
  let clienteModalId   = null;

  const STATE = {
    setores: [],
    responsaveis: [],
    loaded: { setores:false, responsaveis:false },
    instancias: null
  };

  // ==============================
  // Utils
  // ==============================
  function toast(msg, type='ok'){
    if (!toastEl){ alert(msg); return; }
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    toastEl.style.background = type==='err' ? '#7f1d1d'
                         : type==='warn'? '#78350f'
                         : '#065f46';
    clearTimeout(toast._t);
    toast._t = setTimeout(()=>{ toastEl.style.display='none'; }, 2400);
  }
  function safeFocus(el){ try{ el && typeof el.focus === 'function' && el.focus(); }catch{} }

  function digits(s){ return String(s||'').replace(/\D+/g,''); }
  function pad2(n){ return String(n).padStart(2,'0'); }

  function formatTelBR(v){
    const d = digits(v);
    if (!d) return '';
    if (d.length >= 11){
      const dd=d.slice(-11,-9), n=d.slice(-9);
      return `(${dd}) ${n[0]} ${n.slice(1,5)}-${n.slice(5)}`;
    }
    if (d.length >= 10){
      const dd=d.slice(-10,-8), n=d.slice(-8);
      return `(${dd}) ${n.slice(0,4)}-${n.slice(4)}`;
    }
    return d;
  }
  function isoToInputDate(iso){
    if (!iso) return '';
    const raw = String(iso);
    const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (direct) return direct[1];
    const d = new Date(iso);
    if (Number.isNaN(+d)) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  }
  function formatDateBR(iso){
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(+d)) return '';
    return `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()}`;
  }

  // ==============================
  // Acordeon das seções do cliente
  // ==============================
  function resetSectionsCollapsed(openIndex = 0){
    if (!novoModal) return;
    const secs = [...novoModal.querySelectorAll('.cli-section')];
    secs.forEach((sec, index) => {
      const isOpen = index === openIndex;
      sec.classList.toggle('is-open', isOpen);
      sec.querySelector('.cli-section-toggle')?.setAttribute('aria-expanded', String(isOpen));
    });
  }

  function bindCliSectionsAccordion(){
    if (!novoModal || novoModal.dataset.accordionBound === '1') return;
    novoModal.dataset.accordionBound = '1';

    novoModal.addEventListener('click', (e) => {
      const btn = e.target.closest('.cli-section-toggle');
      if (!btn) return;
      const sec = btn.closest('.cli-section');
      if (!sec) return;

      const isOpen = sec.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', String(isOpen));
    });
  }

  // ==============================
  // Carregamento de Setores/Responsáveis
  // ==============================
  async function loadSetores(){
    if (STATE.loaded.setores) return;
    const tries = ['/api/atendimento/clientes/departamentos','/api/departamentos'];
    for (const url of tries){
      try{
        const data = await apiGet(url);
        const arr = Array.isArray(data) ? data : (data?.items || data?.data || []);
        if (arr?.length){
          STATE.setores = arr.map(s => ({
            id:   Number(s.id ?? s.dep_id ?? s.depto_id ?? s.value ?? s.ID),
            nome: s.nome ?? s.name ?? s.titulo ?? s.label ?? '—'
          })).filter(s => s.id!=null && s.nome);
          STATE.loaded.setores = true;
          break;
        }
      }catch{}
    }
    renderSetores();
  }
  async function loadResponsaveis(){
    if (STATE.loaded.responsaveis) return;
    try{
      const data = await apiGet('/api/clientes/colaboradores');
      const items = Array.isArray(data) ? data : (data?.items || []);
      STATE.responsaveis = items.map(x => ({ id: Number(x.id), nome: x.nome || '(sem nome)' }));
      STATE.loaded.responsaveis = true;
    }catch(e){
      console.warn('Falha ao carregar colaboradores', e);
      STATE.responsaveis = [];
      STATE.loaded.responsaveis = true;
    }
    renderResponsaveis();
  }
  function renderSetores(){
    if (!novoDepto) return;
    const current = String(novoDepto.value || '');
    novoDepto.innerHTML = '';
    novoDepto.appendChild(new Option('— Sem departamento —', ''));
    STATE.setores.forEach(s => novoDepto.appendChild(new Option(s.nome, String(s.id))));
    novoDepto.value = current;
  }
  function renderResponsaveis(){
    if (!novoColab) return;
    const current = novoColab.value;
    novoColab.innerHTML = '';
    novoColab.appendChild(new Option('— Sem responsável —', ''));
    STATE.responsaveis.forEach(r => novoColab.appendChild(new Option(r.nome, String(r.id))));
    if (current !== undefined) novoColab.value = current;
  }

  // ==============================
  // Form helpers
  // ==============================
  function resetClienteForm(){
    if (novoNome)  novoNome.value  = '';
    if (novoTel)   novoTel.value   = '';
    if (novoDepto) novoDepto.value = '';
    if (novoSobre) novoSobre.value = '';
    if (novoColab) novoColab.value = '';

    Object.values(extraFields).forEach(el => {
      if (!el) return;
      if (el.type === 'checkbox') el.checked = false;
      else el.value = '';
    });

    if (cliId)           cliId.value = '';
    if (cliDataCadastro) cliDataCadastro.value = '';
  }
  function setFormDisabled(disabled){
    [novoNome, novoTel, novoDepto, novoSobre, novoColab]
      .filter(Boolean).forEach(el => el.disabled = !!disabled);
    Object.values(extraFields).forEach(el => { if (el) el.disabled = !!disabled; });
  }
  function setModalTitle(t){
    const title = novoModal?.querySelector('#novo-title, .modal-head h2');
    if (title) title.textContent = t || 'Cliente';
  }

  function normalizeCliente(cli){
    if (!cli) return cli;
    const out = { ...cli };
    if (out.sobre == null && out.sobre_cliente != null) out.sobre = out.sobre_cliente;
    if (out.sobre_cliente == null && out.sobre != null) out.sobre_cliente = out.sobre;
    return out;
  }

  function fillClienteForm(cliRaw){
    const cli = normalizeCliente(cliRaw);
    if (!cli) return;

    if (novoNome)  novoNome.value  = (cli.nome || '').trim();
    if (novoTel)   novoTel.value   = formatTelBR(cli.telefone || '');
    if (novoDepto){
      const depId = cli.departamento_id ?? cli.depto_id ?? cli.setor_id ?? null;
      if (depId != null){
        const value = String(depId);
        if (![...novoDepto.options].some(opt => opt.value === value)){
          novoDepto.appendChild(new Option(cli.departamento || `Departamento #${value}`, value));
        }
        novoDepto.value = value;
      } else {
        const depNome = String(cli.setor_nome || cli.departamento || '').trim().toLowerCase();
        const found = STATE.setores.find(s => String(s.nome || '').trim().toLowerCase() === depNome);
        novoDepto.value = found ? String(found.id) : '';
      }
    }
    if (novoSobre) novoSobre.value = (cli.sobre_cliente || cli.sobre || '').trim();
    if (novoColab) {
      const id = cli.colaborador_id ?? cli.responsavel_id ?? null;
      const value = id == null ? '' : String(id);
      if (value && ![...novoColab.options].some(opt => opt.value === value)){
        novoColab.appendChild(new Option(cli.colaborador_nome || cli.responsavel_nome || `Responsável #${value}`, value));
      }
      novoColab.value = value;
    }

    if (extraFields.cpf_cnpj)        extraFields.cpf_cnpj.value        = cli.cpf_cnpj || '';
    if (extraFields.rg)              extraFields.rg.value              = cli.rg || '';
    if (extraFields.email)           extraFields.email.value           = cli.email || '';
    if (extraFields.nome_whatsapp)   extraFields.nome_whatsapp.value   = cli.nome_whatsapp || '';
    if (extraFields.status_whatsapp) extraFields.status_whatsapp.value = cli.status_whatsapp || '';
    if (extraFields.descricao)       extraFields.descricao.value       = cli.descricao || '';
    if (extraFields.website)         extraFields.website.value         = cli.website || '';
    if (extraFields.nome_completo)   extraFields.nome_completo.value   = cli.nome_completo || '';

    if (extraFields.cep)             extraFields.cep.value             = cli.cep || '';
    if (extraFields.endereco)        extraFields.endereco.value        = cli.endereco || '';
    if (extraFields.numero)          extraFields.numero.value          = cli.numero || '';
    if (extraFields.complemento)     extraFields.complemento.value     = cli.complemento || '';
    if (extraFields.bairro)          extraFields.bairro.value          = cli.bairro || '';
    if (extraFields.cidade)          extraFields.cidade.value          = cli.cidade || '';
    if (extraFields.estado)          extraFields.estado.value          = cli.estado || '';
    if (extraFields.genero)          extraFields.genero.value          = cli.genero || '';

    if (extraFields.data_nascimento){
      extraFields.data_nascimento.value = isoToInputDate(cli.data_nascimento);
    }
    if (extraFields.is_business){
      extraFields.is_business.checked = !!cli.is_business;
    }

    if (cliId)           cliId.value           = cli.id != null ? String(cli.id) : '';
    if (cliDataCadastro) cliDataCadastro.value = formatDateBR(cli.data_cadastro || cli.created_at || cli.dt_cadastro || cli.timestamp);
  }

  function buildPayloadFromForm(){
    const payload = {};

    if (novoNome)  payload.nome          = (novoNome.value || '').trim() || null;
    if (novoTel)   payload.telefone      = digits(novoTel.value || '') || null;
    if (novoDepto){
      const depRaw = String(novoDepto.value || '');
      const depId = depRaw === '' ? null : Number(depRaw);
      payload.departamento_id = depId;
      payload.departamento = depId == null
        ? null
        : (STATE.setores.find(s => Number(s.id) === depId)?.nome || null);
    }
    if (novoSobre) payload.sobre_cliente = (novoSobre.value || '').trim() || null;
    if (novoColab){
      payload.colaborador_id =
        (novoColab.value === '' ? null : Number(novoColab.value));
    }

    if (extraFields.cpf_cnpj)        payload.cpf_cnpj        = (extraFields.cpf_cnpj.value || '').trim() || null;
    if (extraFields.rg)              payload.rg              = (extraFields.rg.value || '').trim() || null;
    if (extraFields.email)           payload.email           = (extraFields.email.value || '').trim() || null;
    if (extraFields.nome_whatsapp)   payload.nome_whatsapp   = (extraFields.nome_whatsapp.value || '').trim() || null;
    if (extraFields.status_whatsapp) payload.status_whatsapp = (extraFields.status_whatsapp.value || '').trim() || null;
    if (extraFields.descricao)       payload.descricao       = (extraFields.descricao.value || '').trim() || null;
    if (extraFields.website)         payload.website         = (extraFields.website.value || '').trim() || null;
    if (extraFields.nome_completo)   payload.nome_completo   = (extraFields.nome_completo.value || '').trim() || null;

    if (extraFields.cep)         payload.cep         = (extraFields.cep.value || '').trim() || null;
    if (extraFields.endereco)    payload.endereco    = (extraFields.endereco.value || '').trim() || null;
    if (extraFields.numero)      payload.numero      = (extraFields.numero.value || '').trim() || null;
    if (extraFields.complemento) payload.complemento = (extraFields.complemento.value || '').trim() || null;
    if (extraFields.bairro)      payload.bairro      = (extraFields.bairro.value || '').trim() || null;
    if (extraFields.cidade)      payload.cidade      = (extraFields.cidade.value || '').trim() || null;
    if (extraFields.estado)      payload.estado      = (extraFields.estado.value || '').trim() || null;
    if (extraFields.genero)      payload.genero      = (extraFields.genero.value || '').trim() || null;

    if (extraFields.data_nascimento){
      const v = (extraFields.data_nascimento.value || '').trim();
      payload.data_nascimento = v || null;
    }
    if (extraFields.is_business){
      payload.is_business = !!extraFields.is_business.checked;
    }

    return payload;
  }

  // ==============================
  // Atualização da linha (DOM) + evento global
  // ==============================
  function updateRowDOM(cli){
    if (!cli || cli.id == null) return;
    const row = document.querySelector(`tr.cliente-row[data-id="${cli.id}"]`);
    if (!row) return;
    const tel = formatTelBR(cli.telefone);
    const dep = cli.setor_nome || cli.departamento || '';
    const resp = cli.colaborador_nome || cli.responsavel_nome || '-';

    const cells = {
      nome: row.querySelector('td:nth-child(2)'),
      tel:  row.querySelector('td:nth-child(3)'),
      dep:  row.querySelector('.td-depto'),
      col:  row.querySelector('.td-colab')
    };
    if (cells.nome) cells.nome.textContent = (cli.nome || '-');
    if (cells.tel)  cells.tel.textContent  = (tel || '-');
    if (cells.dep)  cells.dep.textContent  = (dep || '-');
    if (cells.col)  cells.col.textContent  = (resp || '-');
  }
  function emitUpdated(cli){
    try{ window.dispatchEvent(new CustomEvent('cliente:updated', { detail: cli })); }catch{}
  }

  // ==============================
  // Helpers de modal p/ reaproveitar o botão "Criar"
  // ==============================
  function hideCreateButton(){
    if (novoOkOriginal){
      novoOkOriginal.dataset._origDisplay = novoOkOriginal.dataset._origDisplay || novoOkOriginal.style.display || '';
      novoOkOriginal.style.display = 'none';
    }
    if (novoCancel){
      novoCancel.dataset._origDisplay = novoCancel.dataset._origDisplay || novoCancel.style.display || '';
      novoCancel.style.display = 'none';
    }
  }
  function restoreCreateButton(){
    if (novoOkOriginal){
      novoOkOriginal.style.display = novoOkOriginal.dataset._origDisplay || '';
    }
    if (novoCancel){
      novoCancel.style.display = novoCancel.dataset._origDisplay || '';
    }
  }
  function removeDynamicButtons(){
    if (!novoModal) return;
    novoModal.querySelectorAll('.cli-dyn-btn').forEach(b => b.remove());
  }

  function openModalFor(mode){
    if (!novoModal) return;
    clienteModalMode = mode || 'new';
    novoModal.dataset.mode = clienteModalMode;
    novoModal.style.display = 'grid';
    novoModal.classList.add('show');
    novoModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('has-modal');
  }
  function closeEditorModal(){
    if (!novoModal) return;
    const mode = novoModal.dataset.mode;

    novoModal.style.display = 'none';
    novoModal.classList.remove('show');
    novoModal.setAttribute('aria-hidden', 'true');

    if (!document.querySelector('.modal-backdrop.show')){
      document.body.classList.remove('has-modal');
    }

    if (!mode || mode === 'new') return;

    clienteModalMode = 'new';
    delete novoModal.dataset.mode;
    removeDynamicButtons();
    restoreCreateButton();
    setFormDisabled(false);
    resetSectionsCollapsed();
    setModalTitle('Novo cliente');
  }

  // ==============================
  // VER / EDITAR
  // ==============================
  async function fetchCliente(id){
    const cli = await apiGet(`/api/clientes/${id}`);
    return cli;
  }

  async function openClienteView(id){
    if (!novoModal){ toast('Modal não encontrado.', 'err'); return; }
    try{
      await Promise.all([loadSetores(), loadResponsaveis()]);
      const cli = await fetchCliente(id);

      clienteModalId = Number(id);
      resetClienteForm();
      resetSectionsCollapsed();
      fillClienteForm(cli);
      setFormDisabled(true);
      setModalTitle('Detalhes do cliente');

      hideCreateButton();
      removeDynamicButtons();

      const footer = novoModal.querySelector('footer');
      if (footer){
        const btnFechar = document.createElement('button');
        btnFechar.type = 'button';
        btnFechar.className = 'btn btn-secondary cli-dyn-btn';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', closeEditorModal);

        const btnEditar = document.createElement('button');
        btnEditar.type = 'button';
        btnEditar.className = 'btn btn-primary cli-dyn-btn';
        btnEditar.textContent = 'Editar';
        btnEditar.addEventListener('click', ()=> openClienteEdit(id));

        footer.appendChild(btnFechar);
        footer.appendChild(btnEditar);
      }

      openModalFor('view');
    }catch(e){
      console.error(e);
      toast('Não foi possível abrir o cliente.','err');
    }
  }

  async function openClienteEdit(id){
    if (!novoModal){ toast('Modal não encontrado.', 'err'); return; }
    try{
      await Promise.all([loadSetores(), loadResponsaveis()]);
      const cli = await fetchCliente(id);

      clienteModalId = Number(id);
      resetClienteForm();
      resetSectionsCollapsed();
      fillClienteForm(cli);
      setFormDisabled(false);
      setModalTitle('Editar cliente');

      hideCreateButton();
      removeDynamicButtons();

      const footer = novoModal.querySelector('footer');
      if (footer){
        const btnCancelar = document.createElement('button');
        btnCancelar.type = 'button';
        btnCancelar.className = 'btn btn-secondary cli-dyn-btn';
        btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', closeEditorModal);

        const btnSalvar = document.createElement('button');
        btnSalvar.type = 'button';
        btnSalvar.className = 'btn btn-primary cli-dyn-btn';
        btnSalvar.textContent = 'Salvar';
        btnSalvar.addEventListener('click', handleEditSave);

        footer.appendChild(btnCancelar);
        footer.appendChild(btnSalvar);
      }

      openModalFor('edit');
    }catch(e){
      console.error(e);
      toast('Não foi possível abrir para edição.','err');
    }
  }

  // ====== CAMPOS PERSONALIZADOS (atalho) ======
  async function openClienteCustomFields(id){
    if (!novoModal){ toast('Modal não encontrado.', 'err'); return; }

    await openClienteEdit(id);

    setModalTitle('Editar ficha do cliente');

    resetSectionsCollapsed(1);

    const headers = novoModal.querySelectorAll('.cli-section-header');
    if (headers[1]) safeFocus(headers[1]);
    else if (headers[0]) safeFocus(headers[0]);
  }

  // ==============================
  // Salvar Edição
  // ==============================
  async function handleEditSave(){
    const id = clienteModalId;
    if (!id){
      toast('Cliente inválido.','err');
      return;
    }

    const telDigits = digits(novoTel?.value || '');
    if (!telDigits || telDigits.length < 8){
      toast('Informe um telefone válido (mín. 8 dígitos).','warn');
      safeFocus(novoTel);
      return;
    }

    const payload = buildPayloadFromForm();
    payload.telefone = telDigits;

    const btnSalvar = novoModal?.querySelector('footer .cli-dyn-btn:last-child');
    const oldLabel = btnSalvar?.textContent;
    if (btnSalvar){ btnSalvar.disabled = true; btnSalvar.textContent = 'Salvando…'; }

    try{
      await apiPatch(`/api/clientes/${id}/profile`, payload);

      let cli = null;
      try{ cli = await apiGet(`/api/clientes/${id}`); }catch{}
      cli = normalizeCliente(cli || { id, ...payload });

      if (cli.colaborador_id != null){
        const r = STATE.responsaveis.find(x => x.id === Number(cli.colaborador_id));
        if (r) cli.colaborador_nome = r.nome;
      }
      if (!cli.setor_nome && cli.departamento) cli.setor_nome = cli.departamento;

      updateRowDOM(cli);
      emitUpdated(cli);

      closeEditorModal();
      toast('Cliente atualizado!');
    }catch(e){
      console.error(e);
      toast(e?.data?.detail || 'Falha ao salvar alterações.','err');
      if (btnSalvar){ btnSalvar.disabled = false; btnSalvar.textContent = oldLabel || 'Salvar'; }
    }
  }

  // ==============================
  // ======== INSTÂNCIA =========== (para botão "Mensagem")
  // ==============================
  function setActiveInstance({ id, slug }){
    const normalizedId = normalizeInstanceId(id);
    const normalizedSlug = String(slug || '').trim() || null;
    if (normalizedId == null && !normalizedSlug) return;

    const activeValue = normalizedId ?? normalizedSlug;
    window.INSTANCIA_ATIVA      = activeValue;
    window.INSTANCIA_ATIVA_ID   = normalizedId;
    window.INSTANCIA_ATIVA_SLUG = normalizedSlug;

    try{ LS.setItem('INSTANCIA_ATIVA', String(activeValue)); }catch{}
    try{
      if (normalizedId != null) LS.setItem('INSTANCIA_ATIVA_ID', String(normalizedId));
      else LS.removeItem('INSTANCIA_ATIVA_ID');
    }catch{}
    try{
      if (normalizedSlug) LS.setItem('INSTANCIA_ATIVA_SLUG', normalizedSlug);
      else LS.removeItem('INSTANCIA_ATIVA_SLUG');
    }catch{}
    try{
      document.cookie = `INSTANCIA_ATIVA=${encodeURIComponent(String(activeValue))}; path=/; max-age=${60*60*24*30}`;
    }catch{}
  }

  function normalizeInstanceId(value){
    if (value == null || value === '') return null;
    const raw = String(value).trim();
    if (!/^\d+$/.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  function normInstances(items){
    if (!Array.isArray(items)) return [];

    return items.map((x, index)=>{
      const rawId = x?.id ?? x?.instancia_id ?? x?.instance_id ?? null;
      const id = normalizeInstanceId(rawId);
      const slug = String(
        x?.instance_name ??
        x?.instanceName ??
        x?.slug ??
        x?.instancia ??
        x?.nome_instancia ??
        ''
      ).trim();
      const name = String(
        x?.apelido ??
        x?.name ??
        x?.nome ??
        x?.display_name ??
        slug
      ).trim();
      const number = x?.numero_instancia ?? x?.numero ?? x?.telefone ?? null;
      const status = String(x?.status ?? x?.connectionStatus ?? '').toLowerCase();
      const connected = x?.connected === true || x?.online === true || ['connected', 'open', 'online'].includes(status);
      const key = id != null ? `id:${id}` : (slug ? `slug:${slug}` : `idx:${index}`);

      return (id != null || slug)
        ? { id, slug, key, name: name || slug || `Instância ${index + 1}`, number, connected }
        : null;
    }).filter(Boolean);
  }

  async function fetchInstances(){
    if (!EMPRESA_ID) return [];
    try{
      const data = await apiGet(`/api/empresas/${EMPRESA_ID}/whatsapp`);
      const arr = normInstances(Array.isArray(data?.instancias) ? data.instancias : (Array.isArray(data) ? data : []));
      if (arr.length) return arr;
    }catch(e){ console.warn('instancias whatsapp', e); }

    const fallbacks = ['/api/atendimento/instances','/api/instances'];
    for (const url of fallbacks){
      try{
        const d = await apiGet(url);
        const items = Array.isArray(d?.items)
          ? d.items
          : (Array.isArray(d?.instancias) ? d.instancias : (Array.isArray(d) ? d : []));
        const arr = normInstances(items);
        if (arr.length) return arr;
      }catch{}
    }
    return [];
  }

  function showInstanciaModal(back){
    if (!back) return;
    back.style.display = 'grid';
    back.classList.add('show');
    back.setAttribute('aria-hidden', 'false');
    document.body.classList.add('has-modal');
  }

  function hideInstanciaModal(back){
    if (!back) return;
    back.style.display = 'none';
    back.classList.remove('show');
    back.setAttribute('aria-hidden', 'true');
    if (!document.querySelector('.modal-backdrop.show')){
      document.body.classList.remove('has-modal');
    }
  }

  function ensureInstanciaModal(){
    let back = document.getElementById('instancia-backdrop');
    if (back) return back;

    back = document.createElement('div');
    back.id = 'instancia-backdrop';
    back.className = 'modal-backdrop';
    back.setAttribute('aria-hidden', 'true');
    back.innerHTML = `
      <section class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="instTitle">
        <header class="modal-head">
          <div>
            <span class="modal-kicker">Atendimento</span>
            <h2 id="instTitle">Escolher instância</h2>
            <p>Clique no número do WhatsApp que será usado para abrir a conversa.</p>
          </div>
          <button class="modal-close" id="instClose" type="button" aria-label="Fechar">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </header>
        <div class="modal-body">
          <div id="instList" class="inst-list"></div>
          <div class="modal-helper" id="instInfo"></div>
        </div>
        <footer class="modal-foot">
          <button class="btn btn-secondary" id="instCancel" type="button">Cancelar</button>
          <button class="btn btn-primary" id="instOk" type="button">Abrir conversa</button>
        </footer>
      </section>`;
    document.body.appendChild(back);

    const cancel = () => back.__cancel?.();
    back.addEventListener('mousedown', e => { if (e.target === back) cancel(); });
    back.querySelector('#instClose').addEventListener('click', cancel);
    back.querySelector('#instCancel').addEventListener('click', cancel);

    document.addEventListener('keydown', e=>{
      if (!back.classList.contains('show')) return;
      if (e.key === 'Escape') cancel();
      if (e.key === 'Enter'){
        const ok = back.querySelector('#instOk');
        if (ok && !ok.disabled) ok.click();
      }
    });
    return back;
  }

  function getSelectedInstance(back){
    const radio = back?.querySelector('input[name="instRadio"]:checked');
    if (!radio) return null;
    const id = normalizeInstanceId(radio.dataset.id || radio.value);
    const slug = String(radio.dataset.slug || '').trim() || null;
    return (id != null || slug) ? { id, slug } : null;
  }

  function renderInstanciasList(back, insts, onChoose){
    const list = back.querySelector('#instList');
    const info = back.querySelector('#instInfo');
    list.innerHTML = '';

    insts = insts.slice().sort((a,b)=>{
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return String(a.name).localeCompare(String(b.name),'pt-BR');
    });

    const ativaId = String(LS.getItem('INSTANCIA_ATIVA_ID') || '').trim();
    const ativaSlug = String(LS.getItem('INSTANCIA_ATIVA_SLUG') || LS.getItem('INSTANCIA_ATIVA') || '').trim();

    insts.forEach((inst, idx) => {
      const domId = `inst-opt-${idx}`;
      const label = [
        inst.name || inst.slug,
        inst.number ? ` • ${inst.number}` : '',
        inst.connected ? '' : ' • offline'
      ].join('');

      const row = document.createElement('label');
      row.setAttribute('for', domId);
      row.className = 'chip inst-option';
      row.dataset.instanceKey = inst.key;

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'instRadio';
      radio.id = domId;
      radio.value = inst.id == null ? '' : String(inst.id);
      radio.dataset.id = inst.id == null ? '' : String(inst.id);
      radio.dataset.slug = inst.slug || '';

      const text = document.createElement('span');
      text.textContent = label;

      row.append(radio, text);
      list.appendChild(row);
      if ((ativaId && ativaId === String(inst.id)) || (ativaSlug && ativaSlug === String(inst.slug))) {
        radio.checked = true;
      }

      row.addEventListener('click', (event)=>{
        event.preventDefault();
        radio.checked = true;
        info.textContent = `Instância selecionada: ${inst.name || inst.slug}. Abrindo conversa…`;
        onChoose?.({ id: inst.id, slug: inst.slug });
      });
    });

    if (!list.querySelector('input[type="radio"]:checked')){
      const first = list.querySelector('input[type="radio"]');
      if (first) first.checked = true;
    }

    info.textContent = insts.length
      ? `Instâncias encontradas: ${insts.length}. Clique em uma opção para abrir.`
      : 'Nenhuma instância encontrada.';
  }

  async function chooseInstance(){
    // Atualiza a lista a cada abertura para não manter instâncias antigas em cache.
    STATE.instancias = await fetchInstances().catch(()=>[]);
    const insts = STATE.instancias || [];

    if (insts.length === 0){
      toast('Nenhuma instância configurada para a empresa.','warn');
      return null;
    }
    if (insts.length === 1){
      const one = insts[0];
      setActiveInstance({ id: one.id, slug: one.slug });
      return { id: one.id, slug: one.slug };
    }

    const back = ensureInstanciaModal();

    return await new Promise(resolve=>{
      let settled = false;
      let autoOpenTimer = null;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (autoOpenTimer) clearTimeout(autoOpenTimer);
        back.__cancel = null;
        hideInstanciaModal(back);
        resolve(value);
      };

      const choose = (selected) => {
        if (!selected || (selected.id == null && !selected.slug)) return;
        setActiveInstance(selected);
        // Pequeno atraso para o clique marcar visualmente antes da navegação.
        if (autoOpenTimer) clearTimeout(autoOpenTimer);
        autoOpenTimer = setTimeout(()=> finish(selected), 80);
      };

      back.__cancel = () => finish(null);
      renderInstanciasList(back, insts, choose);
      showInstanciaModal(back);

      const ok = back.querySelector('#instOk');
      ok.onclick = ()=>{
        const selected = getSelectedInstance(back);
        if (!selected){
          toast('Selecione uma instância.','warn');
          return;
        }
        choose(selected);
      };

      setTimeout(()=> back.querySelector('input[name="instRadio"]:checked')?.focus?.(), 0);
    });
  }

  async function openClienteMensagem(clienteId){
    const selected = await chooseInstance();
    if (!selected || (selected.id == null && !selected.slug)){
      return false;
    }

    const u = new URL('/atendimentos', location.origin);
    u.searchParams.set('cliente_id', String(clienteId));

    if (selected.id != null){
      u.searchParams.set('instancia_id', String(selected.id));
    } else {
      u.searchParams.set('instancia', String(selected.slug));
    }

    location.assign(u.toString());
    return true;
  }

  // ==============================
  // Wiring básico do modal (fechar) + acordeon
  // ==============================
  novoCancel?.addEventListener?.('click', closeEditorModal);
  novoClose?.addEventListener?.('click',  closeEditorModal);
  bindCliSectionsAccordion();

  // ==============================
  // Exports globais (usados em clientes.js)
  // ==============================
  const api = Object.freeze({
    openView:         openClienteView,
    openEdit:         openClienteEdit,
    openMessage:      openClienteMensagem,
    openCustomFields: openClienteCustomFields,
    close:            closeEditorModal
  });

  window.ClienteEditor = api;
  window.ClienteEditar = api;

})();
