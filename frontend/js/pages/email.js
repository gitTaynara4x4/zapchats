(function EmailPage(){
  'use strict';

  // ========= Helpers =========
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => r.querySelectorAll(s);

  // Pequeno helper para fetch com cookies e erro claro
  async function jfetch(url, opts={}){
    const res = await fetch(url, { credentials:'include', ...opts });
    if (!res.ok){
      const txt = await res.text().catch(()=> '');
      throw new Error(`HTTP ${res.status} – ${txt.slice(0,240)}`);
    }
    return res.json();
  }

  // Data/hora local (São Paulo) curta
  const tz = 'America/Sao_Paulo';
  function fmtWhen(iso){
    if (!iso) return '—';
    try{
      const d = new Date(iso);
      return d.toLocaleString('pt-BR', { timeZone: tz, day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    }catch{ return iso; }
  }

  // ========= Estado =========
  let accounts = [];
  let currentAccountId = null;
  let q = '', status = '';
  let limit = 50, offset = 0, loading = false, total = 0;

  // ========= UI Elements =========
  const accTrigger  = $('#accTrigger');
  const accLabel    = $('#accLabel');
  const accMenu     = $('#accMenu');
  const accList     = $('#accList');
  const topMeta     = $('#topMeta');

  const qInput      = $('#q');
  const statusSel   = $('#status');
  const btnReload   = $('#btnReload');
  const btnClear    = $('#btnClear');
  const countInfo   = $('#countInfo');

  const tbody       = $('#tbodyEmails');
  const btnLoadMore = $('#btnLoadMore');

  const dlg         = $('#dlgEmail');
  const dlgSubject  = $('#dlgSubject');
  const dlgMeta     = $('#dlgMeta');
  const dlgBody     = $('#dlgBody');

  // ========= Loader global (PageLoading) se existir =========
  const PageLoading = window.PageLoading || { show(){}, hide(){} };

  // ========= Acc Menu toggle =========
  function toggleAccMenu(show){
    const visible = show ?? (accMenu.getAttribute('aria-hidden') === 'true');
    accMenu.setAttribute('aria-hidden', visible ? 'false' : 'true');
    accTrigger.setAttribute('aria-expanded', visible ? 'true' : 'false');
  }
  accTrigger.addEventListener('click', () => toggleAccMenu());
  document.addEventListener('click', (e)=>{
    if (!accMenu.contains(e.target) && !accTrigger.contains(e.target)){
      accMenu.setAttribute('aria-hidden','true');
      accTrigger.setAttribute('aria-expanded','false');
    }
  });

  // ========= Render contas =========
  function renderAccounts(){
    accList.innerHTML = '';
    if (!accounts.length){
      accList.innerHTML = `<li style="padding:.5rem .6rem;color:var(--muted)">Nenhuma conta conectada</li>`;
      accLabel.textContent = 'Sem caixa';
      topMeta.textContent = '—';
      return;
    }
    accounts.forEach(acc=>{
      const li = document.createElement('li');
      li.innerHTML = `
        <button class="inst-item" role="option"
                data-id="${acc.id}"
                aria-selected="${acc.id === currentAccountId}">
          <span class="radio" aria-hidden="true"></span>
          <div style="display:flex;flex-direction:column;gap:.1rem">
            <strong>${acc.email_address}</strong>
            <span style="color:var(--muted);font-size:.85rem">${acc.provider} • ${acc.status}</span>
          </div>
        </button>
      `;
      li.querySelector('button').addEventListener('click', ()=>{
        currentAccountId = acc.id;
        accLabel.textContent = acc.email_address;
        // atualizar seleção visual
        $$('.inst-item', accList).forEach(b=>b.setAttribute('aria-selected','false'));
        li.querySelector('button').setAttribute('aria-selected','true');
        // reset e carregar
        offset = 0; total = 0;
        tbody.innerHTML = '';
        toggleAccMenu(false);
        loadMessages(true);
      });
      accList.appendChild(li);
    });

    // Se ainda não há seleção, pegar a primeira ativa
    if (!currentAccountId && accounts[0]){
      currentAccountId = accounts[0].id;
      accLabel.textContent = accounts[0].email_address;
      loadMessages(true);
    }
  }

  // ========= Render tabela =========
  function renderRows(items){
    const frag = document.createDocumentFragment();
    for (const m of items){
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${m.has_attachments ? '📎' : ''}</td>
        <td style="max-width:520px">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m.subject||'(sem assunto)'}</div>
          <div style="color:var(--muted);font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m.snippet||''}</div>
        </td>
        <td style="white-space:nowrap">${m.from_addr||'—'}</td>
        <td style="white-space:nowrap">${Array.isArray(m.to_addrs)? m.to_addrs.join(', ') : (m.to_addrs||'—')}</td>
        <td style="white-space:nowrap">${fmtWhen(m.received_at)}</td>
        <td style="white-space:nowrap;text-align:center">${m.has_attachments ? 'Sim' : 'Não'}</td>
      `;
      tr.addEventListener('click', ()=> openMessage(m.id));
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
  }

  // ========= Abrir modal =========
  async function openMessage(id){
    try{
      PageLoading.show?.();
      const data = await jfetch(`/api/email/messages/${id}`);
      dlgSubject.textContent = data.subject || '(sem assunto)';
      dlgMeta.textContent = `${data.from_addr||'—'} → ${Array.isArray(data.to_addrs)? data.to_addrs.join(', ') : (data.to_addrs||'—')} • ${fmtWhen(data.received_at)}`;
      // Mostra HTML se tiver; senão texto
      dlgBody.innerHTML = data.body_html || `<pre style="white-space:pre-wrap">${(data.body_text||'').replace(/[<>&]/g,s=>({ '<':'&lt;','>':'&gt;','&':'&amp;' }[s]))}</pre>`;
      dlg.showModal();
    }catch(err){
      console.error(err);
      alert('Falha ao abrir a mensagem.');
    }finally{
      PageLoading.hide?.();
    }
  }

  // ========= Buscar mensagens =========
  async function loadMessages(reset=false){
    if (loading || !currentAccountId) return;
    loading = true;
    try{
      if (reset){ offset = 0; total = 0; tbody.innerHTML = ''; }
      PageLoading.show?.();
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        q: q || '',
        status: status || '',
        account_id: String(currentAccountId)
      });
      const resp = await jfetch(`/api/email/messages?${params.toString()}`);
      const { items=[], total_count=0 } = resp || {};
      total = total_count;
      renderRows(items);
      offset += items.length;
      countInfo.textContent = `${offset} / ${total}`;
      topMeta.textContent = `${total} mensagens`;
      btnLoadMore.disabled = offset >= total;
    }catch(err){
      console.error(err);
      alert('Falha ao carregar mensagens.');
    }finally{
      loading = false;
      PageLoading.hide?.();
      document.documentElement.setAttribute('data-loader-ready','');
      setTimeout(()=>document.documentElement.removeAttribute('prepaint'), 0);
    }
  }

  // ========= Eventos de filtro =========
  qInput.addEventListener('keydown', (e)=> {
    if (e.key === 'Enter'){
      q = qInput.value.trim(); offset = 0; loadMessages(true);
    }
  });
  statusSel.addEventListener('change', ()=>{
    status = statusSel.value; offset = 0; loadMessages(true);
  });
  btnReload.addEventListener('click', ()=> loadMessages(true));
  btnClear.addEventListener('click', ()=>{
    q = ''; status = '';
    qInput.value=''; statusSel.value='';
    offset = 0; loadMessages(true);
  });
  btnLoadMore.addEventListener('click', ()=> loadMessages(false));

  // ========= Boot =========
  (async function init(){
    try{
      PageLoading.show?.();
      // 1) Carrega contas conectadas
      const resp = await jfetch('/api/email/accounts');
      accounts = resp?.items || [];
      renderAccounts();
      // 2) Se nenhuma contou, deixa a UI informativa
      if (!accounts.length){
        btnLoadMore.disabled = true;
        countInfo.textContent = '0 itens';
        topMeta.textContent = 'Nenhuma conta';
      }
    }catch(err){
      console.error(err);
      alert('Falha ao carregar contas de e-mail.');
    }finally{
      PageLoading.hide?.();
      document.documentElement.setAttribute('data-head-ready','');
      document.documentElement.setAttribute('data-loader-ready','');
      setTimeout(()=>document.documentElement.classList.remove('prepaint'), 0);
    }
  })();
})();
