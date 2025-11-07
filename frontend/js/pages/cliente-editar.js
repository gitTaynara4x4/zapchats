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
  const novoDeptoList  = $('#novoDeptoList');
  const novoColab      = $('#novoColab');
  const novoSobre      = $('#novoSobre');
  const novoOkOriginal = $('#novoOk');   // botão "Criar" original (novo cliente)
  const novoCancel     = $('#novoCancel');
  const novoClose      = $('#novoClose');
  const toastEl        = $('#toast');

  // Campos adicionais (HTML já preparado no modal)
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
    setores: [],      // {id, nome}
    responsaveis: [], // {id, nome}
    loaded: { setores:false, responsaveis:false },
    instancias: null  // [{id, slug, name, number, connected}] ou null
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
    if (!novoDeptoList) return;
    novoDeptoList.innerHTML = '';
    STATE.setores.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.nome;
      novoDeptoList.appendChild(opt);
    });
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
    const hdr = novoModal?.querySelector('header');
    if (hdr) hdr.textContent = t || 'Cliente';
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
    if (novoDepto) novoDepto.value = (cli.setor_nome || cli.departamento || '').trim();
    if (novoSobre) novoSobre.value = (cli.sobre_cliente || cli.sobre || '').trim();
    if (novoColab) {
      const id = cli.colaborador_id ?? cli.responsavel_id ?? null;
      novoColab.value = (id == null ? '' : String(id));
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
    if (novoDepto) payload.departamento  = (novoDepto.value || '').trim() || null;
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
      payload.data_nascimento = v || null; // backend converte yyyy-mm-dd
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
    if (!novoOkOriginal) return;
    novoOkOriginal.dataset._origDisplay = novoOkOriginal.dataset._origDisplay || novoOkOriginal.style.display || '';
    novoOkOriginal.style.display = 'none';
  }
  function restoreCreateButton(){
    if (!novoOkOriginal) return;
    novoOkOriginal.style.display = novoOkOriginal.dataset._origDisplay || '';
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
  }
  function closeEditorModal(){
    if (!novoModal) return;
    const mode = novoModal.dataset.mode;

    // Se não está em "view"/"edit", deixa o fluxo padrão do clientes.js cuidar
    if (!mode || mode === 'new'){
      novoModal.style.display = 'none';
      return;
    }

    // Limpamos apenas quando estávamos em view/edit
    novoModal.style.display = 'none';
    clienteModalMode = 'new';
    delete novoModal.dataset.mode;
    removeDynamicButtons();
    restoreCreateButton();
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
      fillClienteForm(cli);
      setFormDisabled(true);
      setModalTitle('Detalhes do cliente');

      hideCreateButton();
      removeDynamicButtons();

      const footer = novoModal.querySelector('footer');
      if (footer){
        const btnFechar = document.createElement('button');
        btnFechar.type = 'button';
        btnFechar.className = 'btn ghost cli-dyn-btn';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', closeEditorModal);

        const btnEditar = document.createElement('button');
        btnEditar.type = 'button';
        btnEditar.className = 'btn cli-dyn-btn';
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
      fillClienteForm(cli);
      setFormDisabled(false);
      setModalTitle('Editar cliente');

      hideCreateButton();
      removeDynamicButtons();

      const footer = novoModal.querySelector('footer');
      if (footer){
        const btnCancelar = document.createElement('button');
        btnCancelar.type = 'button';
        btnCancelar.className = 'btn ghost cli-dyn-btn';
        btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', closeEditorModal);

        const btnSalvar = document.createElement('button');
        btnSalvar.type = 'button';
        btnSalvar.className = 'btn cli-dyn-btn';
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
      await apiPatch(`/api/clientes/${id}`, payload).catch(()=>null);

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
    if (!id && !slug) return;
    window.INSTANCIA_ATIVA      = id ?? slug;
    window.INSTANCIA_ATIVA_ID   = id ?? null;
    window.INSTANCIA_ATIVA_SLUG = slug ?? null;
    try{ LS.setItem('INSTANCIA_ATIVA', String(window.INSTANCIA_ATIVA)); }catch{}
    try{ if (id!=null) LS.setItem('INSTANCIA_ATIVA_ID', String(id)); }catch{}
    try{ if (slug)     LS.setItem('INSTANCIA_ATIVA_SLUG', String(slug)); }catch{}
    try{
      document.cookie = `INSTANCIA_ATIVA=${encodeURIComponent(String(window.INSTANCIA_ATIVA))}; path=/; max-age=${60*60*24*30}`;
    }catch{}
  }

  function normInstances(items){
    if (!Array.isArray(items)) return [];
    return items.map(x=>{
      const id   = (x.id!=null) ? Number(x.id)
                : (x.instancia_id!=null ? Number(x.instancia_id) : null);
      const slug = String(x.instance_name ?? x.slug ?? x.nome ?? '').trim();
      const name = String((x.apelido ?? x.name ?? x.nome ?? slug) || "").trim();
      const number = x.numero_instancia ?? x.numero ?? null;
      const connected = !!x.connected || !!x.online || (String(x.status||'').toLowerCase()==='connected');
      return (id || slug) ? { id, slug, name: name || slug, number, connected } : null;
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
        const items = Array.isArray(d?.items) ? d.items : (Array.isArray(d) ? d : []);
        const arr = normInstances(items);
        if (arr.length) return arr;
      }catch{}
    }
    return [];
  }

  function ensureInstanciaModal(){
    let back = document.getElementById('instancia-backdrop');
    if (back) return back;

    back = document.createElement('div');
    back.id = 'instancia-backdrop';
    back.className = 'modal-backdrop';
    back.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="instTitle">
        <button class="modal-close" id="instClose" aria-label="Fechar">×</button>
        <header id="instTitle">Escolher instância</header>
        <div class="body">
          <div class="row">
            <div id="instList" class="inst-list" style="display:grid;gap:.5rem"></div>
            <div class="muted" id="instInfo" style="margin-top:.25rem"></div>
          </div>
        </div>
        <footer>
          <button class="btn ghost" id="instCancel">Cancelar</button>
          <button class="btn" id="instOk">Continuar</button>
        </footer>
      </div>`;
    document.body.appendChild(back);

    back.addEventListener('mousedown', e => { if (e.target === back) back.style.display='none'; });
    back.querySelector('#instClose').addEventListener('click', ()=> back.style.display='none');
    back.querySelector('#instCancel').addEventListener('click', ()=> back.style.display='none');

    document.addEventListener('keydown', e=>{
      if (back.style.display !== 'grid') return;
      if (e.key === 'Escape') back.style.display='none';
      if (e.key === 'Enter'){
        const ok = back.querySelector('#instOk');
        if (ok && !ok.disabled) ok.click();
      }
    });
    return back;
  }

  function renderInstanciasList(back, insts){
    const list = back.querySelector('#instList');
    const info = back.querySelector('#instInfo');
    list.innerHTML = '';

    insts = insts.slice().sort((a,b)=>{
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return String(a.name).localeCompare(String(b.name),'pt-BR');
    });

    const ativa = (LS.getItem('INSTANCIA_ATIVA_ID') || LS.getItem('INSTANCIA_ATIVA') || '').trim();

    insts.forEach((i, idx) => {
      const id = `inst-opt-${i.id ?? i.slug ?? idx}`;
      const label = [
        i.name || i.slug,
        i.number ? ` • ${i.number}` : '',
        i.connected ? '' : ' • offline'
      ].join('');

      const row = document.createElement('label');
      row.setAttribute('for', id);
      row.className = 'chip';
      row.style.display = 'inline-flex';
      row.style.alignItems = 'center';
      row.style.gap = '.5rem';
      row.style.cursor = 'pointer';
      row.style.userSelect = 'none';

      row.innerHTML = `
        <input type="radio" name="instRadio" id="${id}" value="${i.id ?? ''}" data-slug="${i.slug||''}">
        <span>${label}</span>
      `;
      list.appendChild(row);

      const r = row.querySelector('input[type="radio"]');
      if (ativa && (ativa === String(i.id) || ativa === String(i.slug))) {
        r.checked = true;
      }
    });

    if (!list.querySelector('input[type="radio"]:checked')){
      (list.querySelector('input[type="radio"]') || {}).checked = true;
    }

    info.textContent = insts.length ? `Instâncias encontradas: ${insts.length}` : 'Nenhuma instância encontrada.';
  }

  async function chooseInstanceId(){
    if (!STATE.instancias){
      STATE.instancias = await fetchInstances().catch(()=>[]);
    }
    const insts = STATE.instancias || [];

    if (insts.length === 0){
      toast('Nenhuma instância configurada para a empresa.','warn');
      return null;
    }
    if (insts.length === 1){
      const one = insts[0];
      setActiveInstance({ id: one.id, slug: one.slug });
      return one.id ?? null;
    }

    const back = ensureInstanciaModal();
    renderInstanciasList(back, insts);

    return await new Promise(resolve=>{
      back.style.display = 'grid';
      const ok = back.querySelector('#instOk');
      ok.onclick = ()=>{
        const r = back.querySelector('input[name="instRadio"]:checked');
        back.style.display = 'none';
        if (!r){ resolve(null); return; }
        const id = r.value ? Number(r.value) : null;
        const slug = r.dataset.slug || null;
        setActiveInstance({ id, slug });
        resolve(id);
      };
      back.querySelector('#instCancel').onclick = ()=>{ back.style.display='none'; resolve(null); };
      setTimeout(()=> back.querySelector('input[name="instRadio"]:checked')?.focus?.(), 0);
    });
  }

  async function openClienteMensagem(clienteId){
    const instancia_id = await chooseInstanceId();
    if (!instancia_id){
      toast('Nenhuma instância selecionada.','warn');
      return;
    }
    const u = new URL('/frontend/atendimentos.html', location.origin);
    u.searchParams.set('cliente_id', String(clienteId));
    u.searchParams.set('instancia_id', String(instancia_id));
    location.href = u.toString();
  }

  // ==============================
  // Wiring básico do modal (fechar)
  // ==============================
  novoCancel?.addEventListener?.('click', closeEditorModal);
  novoClose?.addEventListener?.('click',  closeEditorModal);

  // ==============================
  // Exports globais (usados em clientes.js)
  // ==============================
  const api = Object.freeze({
    openView:    openClienteView,
    openEdit:    openClienteEdit,
    openMessage: openClienteMensagem
  });

  window.ClienteEditor = api;  // nome usado em clientes.js (ensureClienteEditorLoaded)
  window.ClienteEditar = api;  // alias, caso algum código use esse nome

})();
