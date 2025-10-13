// cliente-editar.js
(function ClienteEditarModule(){
  'use strict';

  // ==============================
  // Config / Helpers de API
  // ==============================
  const LS = localStorage;
  const EMPRESA_ID = Number(LS.getItem('empresa_id') || '') || null;

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
  const $  = (s, r=document) => r.querySelector(s);
  const novoModal     = $('#novo-backdrop');
  const novoNome      = $('#novoNome');
  const novoTel       = $('#novoTel');
  const novoDepto     = $('#novoDepto');
  const novoDeptoList = $('#novoDeptoList');
  const novoColab     = $('#novoColab');
  const novoSobre     = $('#novoSobre');
  const novoOkStatic  = $('#novoOk'); // manter referência inicial
  const novoCancel    = $('#novoCancel');
  const novoClose     = $('#novoClose');
  const toastEl       = $('#toast');

  function getNovoOk(){ return document.getElementById('novoOk') || novoOkStatic; }

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
  function openModal(el){ if (el) el.style.display='grid'; }
  function closeModal(el){ if (el) el.style.display='none'; }
  function safeFocus(el){ try{ el && typeof el.focus === 'function' && el.focus(); }catch{} }

  function digits(s){ return String(s||'').replace(/\D+/g,''); }
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

  // ==============================
  // Carregamento de Setores/Responsáveis p/ selects do modal
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
  // Preenchimento / modos do modal
  // ==============================
  function setClienteForm(cli){
    if (!cli) return;
    if (novoNome)  novoNome.value  = (cli.nome || '').trim();
    if (novoTel)   novoTel.value   = formatTelBR(cli.telefone || '');
    if (novoDepto) novoDepto.value = (cli.setor_nome || cli.departamento || '').trim();
    if (novoSobre) novoSobre.value = (cli.sobre || cli.sobre_cliente || '').trim();
    if (novoColab) {
      const id = cli.colaborador_id ?? cli.responsavel_id ?? null;
      novoColab.value = (id == null ? '' : String(id));
    }
  }
  function resetClienteForm(){
    if (novoNome)  novoNome.value  = '';
    if (novoTel)   novoTel.value   = '';
    if (novoDepto) novoDepto.value = '';
    if (novoSobre) novoSobre.value = '';
    if (novoColab) novoColab.value = '';
  }
  function setFormDisabled(disabled){
    [novoNome, novoTel, novoDepto, novoSobre, novoColab]
      .filter(Boolean).forEach(el => el.disabled = !!disabled);
  }
  function setModalTitle(t){
    const hdr = novoModal?.querySelector('header');
    if (hdr) hdr.textContent = t || 'Cliente';
  }

  // Busca completo do cliente
  async function fetchCliente(id){
    const cli = await apiGet(`/api/clientes/${id}`);
    return cli;
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
  // VER / EDITAR
  // ==============================
  async function openClienteView(id){
    if (!novoModal){ toast('Modal não encontrado.', 'err'); return; }
    try{
      await Promise.all([loadSetores(), loadResponsaveis()]);
      const cli = await fetchCliente(id);

      clienteModalMode = 'view';
      clienteModalId = Number(id);
      resetClienteForm();
      setClienteForm(cli);
      setFormDisabled(true);
      setModalTitle('Detalhes do cliente');

      const ok = getNovoOk();
      if (ok){ ok.textContent = 'Fechar'; ok.onclick = ()=> closeModal(novoModal); }
      const footer = ok?.parentElement || novoModal?.querySelector('footer');
      if (footer && !footer.querySelector('#viewEditBtn')){
        const b = document.createElement('button');
        b.id = 'viewEditBtn';
        b.className = 'btn';
        b.textContent = 'Editar';
        b.onclick = ()=> openClienteEdit(id);
        footer.insertBefore(b, ok);
      }
      openModal(novoModal);
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

      clienteModalMode = 'edit';
      clienteModalId = Number(id);
      resetClienteForm();
      setClienteForm(cli);
      setFormDisabled(false);
      setModalTitle('Editar cliente');

      const footer = novoModal?.querySelector('footer') || getNovoOk()?.parentElement;
      footer?.querySelector?.('#viewEditBtn')?.remove?.();

      const ok = getNovoOk();
      if (ok){ ok.textContent = 'Salvar'; ok.onclick = handleEditSave; }

      openModal(novoModal);
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
    if (!id){ toast('Cliente inválido.','err'); return; }

    const telDigits = digits(novoTel?.value || '');
    if (!telDigits || telDigits.length < 8){
      toast('Informe um telefone válido (mín. 8 dígitos).','warn');
      safeFocus(novoTel); return;
    }

    const payload = {
      nome: (novoNome?.value || '').trim() || null,
      telefone: telDigits,
      departamento: (novoDepto?.value || '').trim() || null,
      sobre_cliente: (novoSobre?.value || '').trim() || null,
      colaborador_id: (novoColab?.value === '' ? null : Number(novoColab?.value))
    };

    const ok = getNovoOk();
    const old = ok?.textContent;
    if (ok){ ok.disabled = true; ok.textContent = 'Salvando…'; }

    try{
      await apiPatch(`/api/clientes/${id}`, payload).catch(()=>null);
      let cli = null;
      try{ cli = await apiGet(`/api/clientes/${id}`); }catch{}
      cli = cli || { id, ...payload };

      if (cli.colaborador_id != null){
        const r = STATE.responsaveis.find(x => x.id === Number(cli.colaborador_id));
        if (r) cli.colaborador_nome = r.nome;
      }
      if (!cli.setor_nome && cli.departamento) cli.setor_nome = cli.departamento;

      updateRowDOM(cli);
      emitUpdated(cli);

      closeModal(novoModal);
      toast('Cliente atualizado!');
    }catch(e){
      console.error(e);
      toast(e?.data?.detail || 'Falha ao salvar alterações.','err');
    }finally{
      if (ok){ ok.disabled = false; ok.textContent = old || 'Salvar'; }
    }
  }

  // ==============================
  // ======== INSTÂNCIA ===========
  // ==============================

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

    // fechar
    back.addEventListener('mousedown', e => { if (e.target === back) back.style.display='none'; });
    back.querySelector('#instClose').addEventListener('click', ()=> back.style.display='none');
    back.querySelector('#instCancel').addEventListener('click', ()=> back.style.display='none');

    // teclado
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

  function setActiveInstance({ id, slug }){
    if (!id && !slug) return;
    window.INSTANCIA_ATIVA      = id ?? slug; // vários códigos usam isso
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

  // Busca do BD: /api/empresas/{EMPRESA_ID}/whatsapp
  async function fetchInstances(){
    if (!EMPRESA_ID) return [];
    try{
      const data = await apiGet(`/api/empresas/${EMPRESA_ID}/whatsapp`);
      const arr = normInstances(Array.isArray(data?.instancias) ? data.instancias : (Array.isArray(data) ? data : []));
      if (arr.length) return arr;
    }catch(e){ console.warn('instancias whatsapp', e); }

    // (fallbacks opcionais — se existirem em outra versão do seu back)
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

  function renderInstanciasList(back, insts){
    const list = back.querySelector('#instList');
    const info = back.querySelector('#instInfo');
    list.innerHTML = '';

    // ordena: conectadas primeiro, depois nome
    insts = insts.slice().sort((a,b)=>{
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return String(a.name).localeCompare(String(b.name),'pt-BR');
    });

    const ativa = (LS.getItem('INSTANCIA_ATIVA_ID') || LS.getItem('INSTANCIA_ATIVA') || '').trim();
    const ativaStr = String(ativa || '').trim();

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
        <input type="radio" name="instRadio" id="${id}" value="${i.id ?? ''}" data-slug="${i.slug||''}" style="accent-color:var(--accent)">
        <span>${label}</span>
      `;
      list.appendChild(row);

      // marca ativa se casar por id ou slug
      const r = row.querySelector('input[type="radio"]');
      if (ativaStr && (ativaStr === String(i.id) || ativaStr === String(i.slug))) {
        r.checked = true;
      }
    });

    if (!list.querySelector('input[type="radio"]:checked')){
      // se nenhuma marcada, marca a primeira conectada ou a primeira da lista
      (list.querySelector('input[type="radio"]') || {}).checked = true;
      const firstOnline = [...list.querySelectorAll('input[type="radio"]')].find(r => {
        const slug = r.dataset.slug;
        const obj = insts.find(x => String(x.slug)===String(slug) || String(x.id)===String(r.value));
        return obj?.connected;
      });
      if (firstOnline) firstOnline.checked = true;
    }

    info.textContent = insts.length ? `Instâncias encontradas: ${insts.length}` : 'Nenhuma instância encontrada.';
  }

  async function chooseInstanceId(clienteId){
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

    // várias → modal
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
    const instancia_id = await chooseInstanceId(clienteId);
    if (!instancia_id){
      toast('Nenhuma instância selecionada.','warn');
      return;
    }
    // redireciona incluindo instancia_id (front do chat usa esse ID)
    const u = new URL('/frontend/atendimentos.html', location.origin);
    u.searchParams.set('cliente_id', String(clienteId));
    u.searchParams.set('instancia_id', String(instancia_id));
    location.href = u.toString();
  }

  // ==============================
  // Ações da tabela (intercepta em CAPTURA)
  // ==============================
  document.addEventListener('click', async (e)=>{
    const b = e.target?.closest?.('[data-action]');
    if (!b) return;

    const action = b.dataset.action;
    if (!action) return;

    const id = Number(b.dataset.id);
    if (!id) return;

    if (action === 'view'){
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.();
      openClienteView(id);
      return;
    }
    if (action === 'edit'){
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.();
      openClienteEdit(id);
      return;
    }
    if (action === 'msg'){
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.();
      openClienteMensagem(id);
      return;
    }
  }, true /* capture */);

  // ==============================
  // Wiring básico do modal
  // ==============================
  novoCancel?.addEventListener?.('click', ()=> closeModal(novoModal));
  novoClose?.addEventListener?.('click',  ()=> closeModal(novoModal));

  // ==============================
  // Exports globais úteis
  // ==============================
  window.ClienteEditar = Object.freeze({
    ver: openClienteView,
    editar: openClienteEdit,
    mensagem: openClienteMensagem
  });

})();
