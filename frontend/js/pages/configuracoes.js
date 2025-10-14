// /frontend/js/pages/configuracoes.js
(function ConfiguracoesPage(){
  'use strict';

  // ================== Helpers base ==================
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const LS = localStorage;

  const EMPRESA_ID = (()=> {
    const v = Number(LS.getItem('empresa_id') || '');
    return Number.isFinite(v) && v > 0 ? v : null;
  })();

  // fetch autenticado (usa ZAuth se existir)
  const authFetch = (url, opt={}) => {
    const f = (window.ZAuth && ZAuth.authFetch) ? ZAuth.authFetch : fetch;
    const headers = Object.assign(
      { 'Accept': 'application/json' },
      opt.headers || {},
      EMPRESA_ID ? { 'X-Empresa-Id': String(EMPRESA_ID) } : {}
    );
    return f(url, { credentials:'include', ...opt, headers });
  };

  // Loader unificado
  const Loader = {
    show(t='Carregando…', scope='.main'){
      if (window.PageLoading?.show) return PageLoading.show(t, { scope });
      if (window.Loading?.show)    return Loading.show(t);
    },
    hide(){
      if (window.PageLoading?.hide) return PageLoading.hide();
      if (window.Loading?.hide)     return Loading.hide();
    }
  };

  // Toast simples (sem console)
  let toastTimer;
  function toast(message, type='ok', ms=3000){
    const el = $('#toast');
    if (!el) return; // sem toast no HTML
    el.textContent = String(message || '');
    el.className = `toast ${type}`; // defina .toast.ok / .toast.err no CSS
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>{ el.style.display='none'; }, ms);
  }

  // Pequeno logger visual (se existir <pre id="cfg_logs">). Não usa console.
  function vLog(msg){
    const log = $('#cfg_logs');
    if (!log) return;
    const time = new Date().toLocaleTimeString();
    log.textContent += `[${time}] ${msg}\n`;
    log.scrollTop = log.scrollHeight;
  }

  // Fallback: se a página não ganhar "ready" por causa do partial, garante visibilidade
  setTimeout(()=>{
    if (!document.documentElement.classList.contains('ready')){
      document.documentElement.classList.add('ready');
    }
  }, 1200);

  // ================== Endpoints ==================
  // Mantive rotas prováveis + fallbacks. Ajuste aqui caso seu backend use nomes diferentes.
  const API = {
    getConfigCandidates: () => (EMPRESA_ID ? [
      `/api/empresas/${EMPRESA_ID}/configuracoes`,
      `/api/configuracoes?empresa_id=${EMPRESA_ID}`,
      `/api/empresas/${EMPRESA_ID}/settings`,             // fallback comum
      `/api/settings?empresa_id=${EMPRESA_ID}`
    ] : [
      `/api/configuracoes`,
      `/api/settings`
    ]),
    saveConfigCandidates: () => (EMPRESA_ID ? [
      `/api/empresas/${EMPRESA_ID}/configuracoes`,
      `/api/configuracoes?empresa_id=${EMPRESA_ID}`,
      `/api/empresas/${EMPRESA_ID}/settings`,
      `/api/settings?empresa_id=${EMPRESA_ID}`
    ] : [
      `/api/configuracoes`,
      `/api/settings`
    ]),
    getDepartmentsCandidates: () => (EMPRESA_ID ? [
      `/api/atendimento/clientes/departamentos?empresa_id=${EMPRESA_ID}`,
      `/api/departamentos?empresa_id=${EMPRESA_ID}`,
      `/api/atendimento/departamentos?empresa_id=${EMPRESA_ID}`,
      `/api/departamentos`
    ] : [
      `/api/departamentos`
    ]),
    uploadLogoCandidates: () => (EMPRESA_ID ? [
      `/api/empresas/${EMPRESA_ID}/logo`,
      `/api/logo?empresa_id=${EMPRESA_ID}`
    ] : [
      `/api/logo`
    ])
  };

  async function smartFetchJSON(candidates, init){
    for (const url of candidates){
      const res = await authFetch(url, init);
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) return await res.json();
        // Para endpoints de upload logo (podem retornar 204)
        if (res.status === 204) return { ok:true, status:204 };
        try { return await res.json(); } catch { return { ok: true }; }
      }
      if (res.status === 404) continue; // tenta próxima
      // outro erro → repassa mensagem
      let text = '';
      try { text = await res.text(); } catch {}
      throw new Error(text || `HTTP ${res.status}`);
    }
    // nenhum ok/!404 respondeu → 404 geral
    throw new Error('Endpoint de configuração não encontrado (404). Ajuste as rotas em API.*Candidates().');
  }

  async function smartSendJSON(candidates, payload, method='PUT'){
    const body = JSON.stringify(payload);
    for (const url of candidates){
      const res = await authFetch(url, {
        method, body,
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (res.status === 204) return { ok:true, status:204 };
        if (ct.includes('application/json')) return await res.json();
        try { return await res.json(); } catch { return { ok: true }; }
      }
      if (res.status === 404) continue; // tenta próxima
      let text='';
      try { text = await res.text(); } catch {}
      throw new Error(text || `HTTP ${res.status}`);
    }
    throw new Error('Endpoint de salvar configuração não encontrado (404). Ajuste as rotas em API.*Candidates().');
  }

  async function smartUploadLogo(file){
    const fd = new FormData();
    fd.append('file', file, file.name);
    const candidates = API.uploadLogoCandidates();
    for (const url of candidates){
      const res = await authFetch(url, { method:'POST', body: fd });
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) return await res.json();
        return { ok:true };
      }
      if (res.status === 404) continue;
      let text=''; try { text = await res.text(); } catch {}
      throw new Error(text || `HTTP ${res.status}`);
    }
    throw new Error('Endpoint de upload de logo não encontrado (404).');
  }

  // ================== Abas ==================
  function initTabs(){
    const tabs = $$('#tabbar [data-tab]');
    const panels = $$('[data-panel]');
    if (!tabs.length || !panels.length) return;

    function showTab(name){
      tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
      panels.forEach(p => p.hidden = (p.getAttribute('data-panel') !== name));
      LS.setItem('cfg:tab', name);
      // deep-link por hash
      const url = new URL(location.href);
      url.hash = `#${name}`;
      history.replaceState(null, '', url.toString());
    }

    // click
    tabs.forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

    // restaura
    let initial = (location.hash || '').replace('#','').trim();
    if (!initial) initial = LS.getItem('cfg:tab') || tabs[0].dataset.tab;
    if (!tabs.some(b => b.dataset.tab === initial)) initial = tabs[0].dataset.tab;
    showTab(initial);
  }

  // ================== Logo preview ==================
  function initLogoUpload(){
    const input   = $('#logo_file');
    const preview = $('#logo_preview');
    const img     = $('#logo_img');
    const meta    = $('#logo_meta');
    const reset   = $('#logo_reset');

    if (!input || !img || !meta) return;

    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f){
        if (preview) preview.hidden = true;
        return;
      }
      const url = URL.createObjectURL(f);
      img.src = url;
      meta.textContent = `${f.name} • ${(f.size/1024|0)} KB`;
      if (preview) preview.hidden = false;
    });

    if (reset){
      reset.addEventListener('click', (e)=>{
        e.preventDefault();
        if (input) input.value = '';
        if (preview) preview.hidden = true;
        if (img) img.removeAttribute('src');
        if (meta) meta.textContent = '';
        toast('Logo removida (não esqueça de salvar).', 'ok');
      });
    }
  }

  // ================== Departamentos ==================
  async function loadDepartments(){
    const sel = $('#default_department');
    if (!sel) return;

    try{
      const data = await smartFetchJSON(API.getDepartmentsCandidates(), { method:'GET' });
      // Aceita formatos variados: array direto ou {items:[...]}
      const arr = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
      if (!arr.length){
        sel.innerHTML = `<option value="">(nenhum departamento encontrado)</option>`;
        return;
      }
      sel.innerHTML = `<option value="">Selecione…</option>` +
        arr.map(d => `<option value="${d.id}">${d.nome || d.name || d.titulo || d.label || ('#'+d.id)}</option>`).join('');
    }catch(err){
      vLog(`Departamentos: falha ao carregar: ${err.message || err}`);
      sel.innerHTML = `<option value="">(falha ao carregar)</option>`;
    }
  }

  // ================== Config: ler/escrever UI ==================
  // Lê valores dos campos que existirem (defensivo)
  function readUI(){
    const val = (sel) => {
      const el = $(sel); if (!el) return null;
      if (el.type === 'checkbox') return !!el.checked;
      if (el.type === 'time')     return el.value || null;
      return (el.value ?? '').trim();
    };
    const bool = (sel) => !!($(sel)?.checked);

    // Semana
    const wd = {
      dom: bool('#wd_dom'),
      seg: bool('#wd_seg'),
      ter: bool('#wd_ter'),
      qua: bool('#wd_qua'),
      qui: bool('#wd_qui'),
      sex: bool('#wd_sex'),
      sab: bool('#wd_sab'),
    };

    // Mensagens
    const msgs = {
      saudacao:     val('#msg_greeting'),
      ausencia:     val('#msg_absence'),
      boas_vindas:  val('#msg_welcome'),
      fora_horario: val('#msg_offhours')
    };

    // Notificações
    const noti = {
      email: bool('#notify_email'),
      push:  bool('#notify_push'),
      som:   bool('#notify_sound'),
    };

    // Privacidade
    const priv = {
      recibo_leitura: bool('#privacy_read_receipts'),
      status_online:  bool('#privacy_online_status'),
    };

    const payload = {
      empresa: {
        nome:                 val('#empresa_nome'),
        departamento_padrao:  (()=>{
          const v = $('#default_department')?.value;
          return v ? Number(v) : null;
        })(),
      },
      horario: {
        ativo:  bool('#workhours_enabled'),
        dias:   wd,
        inicio: val('#work_start'),
        fim:    val('#work_end'),
      },
      mensagens: msgs,
      notificacoes: noti,
      privacidade:  priv,
    };

    return payload;
  }

  // Preenche UI a partir de um objeto de configuração (campos opcionais)
  function writeUI(cfg){
    if (!cfg || typeof cfg !== 'object') return;

    function setValue(sel, value){
      const el = $(sel); if (!el || value === undefined || value === null) return;
      if (el.type === 'checkbox') { el.checked = !!value; return; }
      el.value = String(value ?? '');
    }

    // Empresa
    setValue('#empresa_nome', cfg.empresa?.nome);
    if ($('#default_department') && cfg.empresa?.departamento_padrao){
      $('#default_department').value = String(cfg.empresa.departamento_padrao);
    }

    // Horário
    setValue('#workhours_enabled', cfg.horario?.ativo);
    setValue('#work_start', cfg.horario?.inicio);
    setValue('#work_end',   cfg.horario?.fim);

    const wd = cfg.horario?.dias || {};
    setValue('#wd_dom', wd.dom);
    setValue('#wd_seg', wd.seg);
    setValue('#wd_ter', wd.ter);
    setValue('#wd_qua', wd.qua);
    setValue('#wd_qui', wd.qui);
    setValue('#wd_sex', wd.sex);
    setValue('#wd_sab', wd.sab);

    // Mensagens
    setValue('#msg_greeting',  cfg.mensagens?.saudacao);
    setValue('#msg_absence',   cfg.mensagens?.ausencia);
    setValue('#msg_welcome',   cfg.mensagens?.boas_vindas);
    setValue('#msg_offhours',  cfg.mensagens?.fora_horario);

    // Notificações
    setValue('#notify_email', cfg.notificacoes?.email);
    setValue('#notify_push',  cfg.notificacoes?.push);
    setValue('#notify_sound', cfg.notificacoes?.som);

    // Privacidade
    setValue('#privacy_read_receipts', cfg.privacidade?.recibo_leitura);
    setValue('#privacy_online_status', cfg.privacidade?.status_online);

    // Logo: se vier URL, mostra na preview
    const logoURL = cfg.empresa?.logo_url || cfg.logo_url || null;
    const img  = $('#logo_img');
    const prev = $('#logo_preview');
    const meta = $('#logo_meta');
    if (img && prev){
      if (logoURL){
        img.src = logoURL;
        if (meta) meta.textContent = '';
        prev.hidden = false;
      }else{
        img.removeAttribute('src');
        if (meta) meta.textContent = '';
        prev.hidden = true;
      }
    }
  }

  // ================== Carregar / Salvar ==================
  async function loadConfig(){
    Loader.show('Carregando configurações…');
    try{
      // cache local como fallback
      const cacheKey = EMPRESA_ID ? `cfg:empresa:${EMPRESA_ID}` : 'cfg:empresa';
      const cached = (()=>{ try{ return JSON.parse(LS.getItem(cacheKey)||''); }catch{return null;} })();
      if (cached) {
        writeUI(cached);
        vLog('Config (cache) aplicada.');
      }

      // remoto
      const data = await smartFetchJSON(API.getConfigCandidates(), { method:'GET' });
      if (data && typeof data === 'object'){
        writeUI(data);
        try{ LS.setItem(cacheKey, JSON.stringify(data)); }catch{}
        vLog('Config (remota) aplicada.');
      } else {
        vLog('Config: resposta vazia/inesperada.');
      }
      toast('Configurações carregadas.', 'ok', 1800);
    }catch(err){
      vLog(`Erro ao carregar config: ${err.message || err}`);
      toast('Não foi possível carregar as configurações.', 'err');
    }finally{
      Loader.hide();
    }
  }

  async function saveConfig(){
    // se tiver arquivo de logo selecionado, primeiro faz upload, depois salva JSON
    const inputLogo = $('#logo_file');
    const file = inputLogo?.files && inputLogo.files[0];

    const payload = readUI();

    Loader.show('Salvando…');
    try{
      if (file){
        await smartUploadLogo(file);
        vLog('Logo enviada.');
      }
      const saved = await smartSendJSON(API.saveConfigCandidates(), payload, 'PUT');
      vLog('Config salva com sucesso.');
      toast('Configurações salvas!', 'ok');
      // atualiza cache
      const cacheKey = EMPRESA_ID ? `cfg:empresa:${EMPRESA_ID}` : 'cfg:empresa';
      try{ LS.setItem(cacheKey, JSON.stringify(saved || payload)); }catch{}
    }catch(err){
      vLog(`Erro ao salvar: ${err.message || err}`);
      toast('Falha ao salvar. Verifique os campos e tente novamente.', 'err');
    }finally{
      Loader.hide();
    }
  }

  // ================== Vínculos de UI ==================
  function bindUI(){
    // Botão salvar
    const btn = $('#btn_save');
    if (btn){
      btn.addEventListener('click', (e)=>{
        e.preventDefault();
        saveConfig();
      });
    }

    // Habilitar/desabilitar campos de horário conforme toggle
    const chk = $('#workhours_enabled');
    const grp = $('#workhours_group');
    const updateWH = ()=>{
      if (!chk || !grp) return;
      grp.classList.toggle('disabled', !chk.checked);
      const inputs = $$('input, textarea, select', grp);
      inputs.forEach(i => {
        if (i === chk) return;
        i.disabled = !chk.checked;
      });
    };
    if (chk && grp){
      chk.addEventListener('change', updateWH);
      updateWH();
    }

    // Troca de abas
    initTabs();

    // Logo
    initLogoUpload();
  }

  // ================== Boot ==================
  document.addEventListener('DOMContentLoaded', async ()=>{
    bindUI();
    await loadDepartments();
    await loadConfig();
  });

})();
