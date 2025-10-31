/* EmailPage – UI de Caixas e Mensagens
   Depende de: app-base.js (PageLoading, jfetch, ZAuth, sidebar loader).
*/
(function EmailPage() {
  'use strict';

  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

  // ====== Safe wrappers (usa jfetch do app-base se existir) ======
  const _jf = (method, url, body) => {
    if (typeof window.jfetch === 'function') {
      return window.jfetch(url, { method, body: body ? JSON.stringify(body) : undefined });
    }
    const opts = { method, headers: { 'Content-Type':'application/json' }, credentials:'include' };
    if (body) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(async r=>{
      if (!r.ok) throw new Error(await r.text().catch(()=>r.statusText));
      const ct = r.headers.get('content-type')||'';
      return ct.includes('application/json') ? r.json() : r.text();
    });
  };
  const jget   = (u)      => _jf('GET',    u);
  const jpost  = (u, b)   => _jf('POST',   u, b);
  const jpatch = (u, b)   => _jf('PATCH',  u, b);
  const jdel   = (u)      => _jf('DELETE', u);

  // ====== Helpers ======
  const fmtBR = new Intl.DateTimeFormat('pt-BR', {
    dateStyle:'short', timeStyle:'short', timeZone:'America/Sao_Paulo'
  });
  const formatDate = (isoOrEpoch) => {
    try {
      const d = (typeof isoOrEpoch === 'number')
        ? new Date(isoOrEpoch)
        : new Date(isoOrEpoch);
      return fmtBR.format(d);
    } catch { return '—'; }
  };
  const bytes = (n) => {
    if (n == null) return '—';
    const u = ['B','KB','MB','GB','TB'];
    let i=0, v = Number(n);
    while (v>=1024 && i<u.length-1){ v/=1024; i++; }
    return `${v.toFixed(1)} ${u[i]}`;
  };
  const toast = (msg, ok=true) => {
    try {
      if (window.AppToast) return AppToast(msg, ok);
    } catch {}
    alert(msg);
  };
  const loading = {
    show(){ try{ PageLoading && PageLoading.show(); }catch{} },
    hide(){ try{ PageLoading && PageLoading.hide(); }catch{} },
  };

  // ====== State ======
  let state = {
    quota: null,
    accounts: [],
    accountFilter: '',
    statusFilter: '',
    searchQ: '',
    page: 0,
    limit: 50
  };

  // ====== DOM refs ======
  const quotaTag = $('#quotaTag');
  const kpiAllowed = $('#kpiAllowed');
  const kpiUsed = $('#kpiUsed');
  const kpiRemaining = $('#kpiRemaining');
  const kpiOverrides = $('#kpiOverrides');
  const quotaBar = $('#quotaBar');

  const accountsList = $('#accountsList');
  const accountsEmpty = $('#accountsEmpty');
  const filterStatus = $('#filterStatus');

  const addAccountCard = $('#addAccountCard');
  const btnAddAccount = $('#btnAddAccount');
  const btnRefreshAll = $('#btnRefreshAll');
  const formAdd = $('#formAddAccount');
  const btnCancelAdd = $('#btnCancelAdd');

  const filterAccount = $('#filterAccount');
  const searchQ = $('#searchQ');
  const btnSearch = $('#btnSearch');
  const messagesList = $('#messagesList');
  const messagesEmpty = $('#messagesEmpty');
  const btnPrev = $('#btnPrev');
  const btnNext = $('#btnNext');
  const pageInfo = $('#pageInfo');

  const msgModal = $('#msgModal');
  const msgModalTitle = $('#msgModalTitle');
  const msgModalClose = $('#msgModalClose');
  const msgMeta = $('#msgMeta');
  const msgSnippet = $('#msgSnippet');
  const msgAttachments = $('#msgAttachments');

  // ====== Init ======
  document.addEventListener('DOMContentLoaded', init, { once:true });

  async function init(){
    loading.show();
    try {
      await loadQuota();
      await loadAccounts();
      fillAccountsFilter();
      await loadMessages();
      bindUI();
    } catch (e){
      console.error(e);
      toast('Falha ao carregar módulo de e-mail.', false);
    } finally {
      loading.hide();
    }
  }

  // ====== Bind events ======
  function bindUI(){
    btnAddAccount.addEventListener('click', () => {
      addAccountCard.classList.toggle('hidden');
      if (!addAccountCard.classList.contains('hidden')) {
        addAccountCard.scrollIntoView({ behavior:'smooth', block:'center' });
      }
    });
    btnCancelAdd.addEventListener('click', () => {
      addAccountCard.classList.add('hidden');
      formAdd.reset();
    });
    formAdd.addEventListener('submit', onCreateAccount);

    filterStatus.addEventListener('change', async ()=>{
      state.statusFilter = filterStatus.value;
      await loadAccounts();
      fillAccountsFilter();
    });

    filterAccount.addEventListener('change', async ()=>{
      state.accountFilter = filterAccount.value;
      state.page = 0;
      await loadMessages();
    });
    btnSearch.addEventListener('click', onSearch);
    searchQ.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ onSearch(); } });

    btnPrev.addEventListener('click', async ()=>{
      if (state.page>0){ state.page--; await loadMessages(); }
    });
    btnNext.addEventListener('click', async ()=>{
      state.page++; await loadMessages();
    });

    msgModalClose.addEventListener('click', closeModal);
    msgModal.addEventListener('click', (e)=>{ if(e.target===msgModal) closeModal(); });
    $('#btnRefreshAll').addEventListener('click', async ()=>{
      loading.show();
      try{
        await Promise.all([loadQuota(), loadAccounts()]);
        fillAccountsFilter();
        await loadMessages();
      } finally{ loading.hide(); }
    });
  }

  async function onSearch(){
    state.searchQ = (searchQ.value||'').trim();
    state.page = 0;
    await loadMessages();
  }

  // ====== Quota ======
  async function loadQuota(){
    const q = await jget('/api/email/quota');
    state.quota = q;
    renderQuota(q);
  }
  function renderQuota(q){
    kpiAllowed.textContent = q.allowed_accounts;
    kpiUsed.textContent = q.used_accounts;
    kpiRemaining.textContent = q.remaining_accounts;
    kpiOverrides.textContent = q.account_storage_overrides;

    const pct = q.allowed_accounts>0 ? Math.min(100, Math.round((q.used_accounts/q.allowed_accounts)*100)) : 0;
    quotaBar.style.width = pct + '%';
    quotaTag.textContent = q.allowed_accounts>0 ? `${pct}% usado` : 'sem plano';
  }

  // ====== Accounts ======
  async function loadAccounts(){
    let url = '/api/email/accounts';
    if (state.statusFilter) url += `?status=${encodeURIComponent(state.statusFilter)}`;
    const list = await jget(url);
    state.accounts = list||[];
    renderAccounts();
  }
  function renderAccounts(){
    accountsList.innerHTML = '';
    accountsEmpty.classList.toggle('hidden', state.accounts.length>0);

    state.accounts.forEach(acc=>{
      const row = document.createElement('div');
      row.className = 'row';

      const left = document.createElement('div');
      left.innerHTML = `
        <div class="font-semibold">${acc.email_address}</div>
        <div class="muted text-sm">${acc.provider} • criada em ${formatDate(acc.created_at)}</div>
      `;

      const right = document.createElement('div');
      right.className = 'flex items-center gap-2';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = acc.status || '—';

      const btnToggle = document.createElement('button');
      btnToggle.className = 'btn btn-ghost';
      btnToggle.textContent = (acc.status==='active'?'Desativar':'Ativar');
      btnToggle.addEventListener('click', ()=> toggleAccount(acc));

      const btnDel = document.createElement('button');
      btnDel.className = 'btn btn-ghost';
      btnDel.textContent = 'Excluir';
      btnDel.addEventListener('click', ()=> deleteAccount(acc));

      right.append(tag, btnToggle, btnDel);
      row.append(left, right);
      accountsList.appendChild(row);
    });
  }
  async function toggleAccount(acc){
    const next = (acc.status==='active') ? 'disabled' : 'active';
    try{
      loading.show();
      const updated = await jpatch(`/api/email/accounts/${acc.id}`, { status: next });
      toast(`Conta ${updated.email_address} ${next==='active'?'ativada':'desativada'}.`);
      await Promise.all([loadQuota(), loadAccounts()]);
      fillAccountsFilter();
      await loadMessages();
    } catch(e){
      console.error(e);
      toast(typeof e==='string'?e:'Não foi possível alterar o status.', false);
    } finally{ loading.hide(); }
  }
  async function deleteAccount(acc){
    if (!confirm(`Excluir a conta ${acc.email_address}?`)) return;
    try{
      loading.show();
      await jdel(`/api/email/accounts/${acc.id}`);
      toast('Conta excluída.');
      await Promise.all([loadQuota(), loadAccounts()]);
      fillAccountsFilter();
      if (String(state.accountFilter) === String(acc.id)) {
        state.accountFilter = '';
      }
      await loadMessages();
    } catch(e){
      console.error(e);
      toast('Não foi possível excluir.', false);
    } finally{ loading.hide(); }
  }
  async function onCreateAccount(ev){
    ev.preventDefault();
    const fd = new FormData(formAdd);
    const payload = {
      provider: fd.get('provider') || 'gmail',
      email_address: (fd.get('email_address')||'').toString().trim(),
      refresh_token_enc: (fd.get('refresh_token_enc')||'').toString().trim(),
      access_token: (fd.get('access_token')||'') || null,
      token_expiry: (fd.get('token_expiry')||'') || null,
      status: fd.get('status') || 'active',
      storage_override_bytes: fd.get('storage_override_bytes') ? Number(fd.get('storage_override_bytes')) : null
    };
    try{
      loading.show();
      const acc = await jpost('/api/email/accounts', payload);
      toast(`Conta ${acc.email_address} criada!`);
      formAdd.reset();
      addAccountCard.classList.add('hidden');
      await Promise.all([loadQuota(), loadAccounts()]);
      fillAccountsFilter();
    } catch(e){
      console.error(e);
      const msg = (e && e.message) ? e.message : String(e);
      if (msg.includes('Limite de contas')) {
        toast('Sua cota de contas de e-mail já está completa.', false);
      } else if (msg.includes('Já existe')) {
        toast('Já existe uma conta com este e-mail/provedor na empresa.', false);
      } else {
        toast('Não foi possível criar a conta.', false);
      }
    } finally { loading.hide(); }
  }
  function fillAccountsFilter(){
    const curr = state.accountFilter;
    filterAccount.innerHTML = `<option value="">Conta: todas</option>`;
    state.accounts.forEach(a=>{
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.email_address} (${a.provider})`;
      filterAccount.appendChild(opt);
    });
    if (curr) filterAccount.value = curr;
  }

  // ====== Messages ======
  async function loadMessages(){
    const p = new URLSearchParams();
    p.set('limit', state.limit);
    p.set('offset', state.page * state.limit);
    if (state.accountFilter) p.set('account_id', state.accountFilter);
    if (state.searchQ) p.set('q', state.searchQ);

    const list = await jget(`/api/email/messages?` + p.toString());
    renderMessages(list||[]);
    const showing = list.length;
    pageInfo.textContent = `Página ${state.page+1} • mostrando ${showing} itens`;
    btnPrev.disabled = (state.page===0);
    btnNext.disabled = (showing < state.limit);
  }
  function renderMessages(items){
    messagesList.innerHTML = '';
    messagesEmpty.classList.toggle('hidden', items.length>0);
    items.forEach(m=>{
      const row = document.createElement('div');
      row.className = 'row';
      row.style.cursor = 'pointer';
      row.addEventListener('click', ()=> openMessage(m.id));

      const left = document.createElement('div');
      left.innerHTML = `
        <div class="font-semibold">${escapeHtml(m.subject||'(sem assunto)')}</div>
        <div class="muted text-sm">${escapeHtml(m.from_addr||'—')} • ${formatDate(m.received_at)}</div>
      `;
      const right = document.createElement('div');
      right.className = 'flex items-center gap-2';
      if (m.has_attachments) {
        const chip = document.createElement('span');
        chip.className = 'pill';
        chip.textContent = 'Anexos';
        right.appendChild(chip);
      }
      const size = document.createElement('span');
      size.className = 'muted text-sm';
      size.textContent = bytes(m.size_bytes);
      right.appendChild(size);

      row.append(left, right);
      messagesList.appendChild(row);
    });
  }
  async function openMessage(id){
    loading.show();
    try{
      const m = await jget(`/api/email/messages/${id}`);
      const atts = await jget(`/api/email/messages/${id}/attachments`);

      msgModalTitle.textContent = m.subject || '(sem assunto)';
      msgMeta.textContent = [
        m.from_addr ? `De: ${m.from_addr}` : null,
        m.to_addrs ? `Para: ${m.to_addrs}` : null,
        m.cc_addrs ? `Cc: ${m.cc_addrs}` : null,
        `Recebida: ${formatDate(m.received_at)}`,
        `Tamanho: ${bytes(m.size_bytes)}`
      ].filter(Boolean).join(' • ');

      msgSnippet.textContent = m.snippet || '—';
      msgAttachments.innerHTML = '';

      if (atts.length){
        const title = document.createElement('div');
        title.innerHTML = `<div class="font-semibold mb-1">Anexos</div>`;
        msgAttachments.appendChild(title);
      }
      atts.forEach(a=>{
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `
          <div>
            <div class="font-semibold">${escapeHtml(a.filename||'(sem nome)')}</div>
            <div class="muted text-sm">${a.mimetype||'—'} • ${bytes(a.size_bytes)}</div>
          </div>
          <div class="flex items-center">
            <a class="btn btn-ghost" href="/api/email/attachments/${a.id}/download" target="_blank" rel="noopener">Baixar</a>
          </div>
        `;
        msgAttachments.appendChild(row);
      });

      msgModal.classList.remove('hidden');
    } catch(e){
      console.error(e);
      toast('Não foi possível abrir a mensagem.', false);
    } finally {
      loading.hide();
    }
  }
  function closeModal(){ msgModal.classList.add('hidden'); }

  // ====== Utils ======
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
})();
