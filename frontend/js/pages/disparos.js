// /frontend/js/pages/disparos.js
(function () {
  'use strict';

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const msgEl          = $('#msgDisparo');
  const numsEl         = $('#numsDisparos');
  const dedupEl        = $('#optDedup');
  const delayEl        = $('#delaySegundos');
  const fileEl         = $('#fileNumeros');
  const importStatusEl = $('#importStatus');
  const resTotalEl     = $('#resTotal');
  const resValidosEl   = $('#resValidos');
  const resInvalidosEl = $('#resInvalidos');
  const resDelayEl     = $('#resDelay');
  const btnDisparar    = $('#btnDisparar');
  const statusEl       = $('#statusDisparos');
  const tbodyHist      = $('#tbodyDisparos');
  const emptyHist      = $('#emptyDisparos');
  const topMetaEl      = $('#topMetaDisparos');

  const btnAddFromClientes  = $('#btnAddFromClientes');
  const clientesModal       = $('#clientesModal');
  const clientesListEl      = $('#clientesList');
  const clientesSearchEl    = $('#clientesSearch');
  const clientesEmptyEl     = $('#clientesEmpty');
  const clientesApplyBtn    = $('#btnClientesApply');
  const clientesCloseBtn    = $('#btnClientesClose');
  const clientesLoadMoreBtn = $('#btnClientesLoadMore');
  const cliCheckAllEl       = $('#cliCheckAll');

  const iaBtnOpen     = $('#btnIaMelhorar');
  const iaModal       = $('#iaModal');
  const iaOriginalEl  = $('#iaOriginal');
  const iaSugestaoEl  = $('#iaSugestao');
  const iaApplyBtn    = $('#btnIaAplicar');
  const iaRegerarBtn  = $('#btnIaRegerar');
  const iaCloseBtn    = $('#btnIaClose');
  const iaStatusEl    = $('#iaStatus');

  const chkIaVariar   = $('#chkIaVariar');

  const API_BASE        = '/api/disparos';
  const API_CREATE      = `${API_BASE}/simples`;
  const API_LIST        = `${API_BASE}?limit=50`;
  const API_CLIENTES    = '/api/clientes';
  const API_IA_MELHORAR = `${API_BASE}/ia-melhorar`;

  const F = (window.ZAuth?.guardFetch || window.ZAuth?.authFetch || fetch);

  const clientesState = {
    q: '',
    items: [],
    has_more: false,
    next_offset: 0,
    loading: false,
  };

  function escapeHTML(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function getEmpresaId() {
    try {
      const raw = localStorage.getItem('empresa_id');
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    if (!text) statusEl.removeAttribute('data-kind');
    else if (kind) statusEl.dataset.kind = kind;
  }

  function setImportStatus(text, kind) {
    if (!importStatusEl) return;
    importStatusEl.textContent = text || '';
    if (!text) importStatusEl.removeAttribute('data-kind');
    else if (kind) importStatusEl.dataset.kind = kind;
  }

  function setIaStatus(text, kind) {
    if (!iaStatusEl) return;
    iaStatusEl.textContent = text || '';
    if (!text) iaStatusEl.removeAttribute('data-kind');
    else if (kind) iaStatusEl.dataset.kind = kind;
  }

  function openIaModal(original, sugestao) {
    if (!iaModal) return;
    iaModal.setAttribute('aria-hidden', 'false');
    iaModal.classList.add('is-open');
    document.body.classList.add('has-modal');
    if (iaOriginalEl) iaOriginalEl.value = original || '';
    if (iaSugestaoEl) iaSugestaoEl.value = sugestao || '';
    setIaStatus('', null);
    setTimeout(() => iaSugestaoEl?.focus(), 30);
  }

  function closeIaModal() {
    if (!iaModal) return;
    iaModal.setAttribute('aria-hidden', 'true');
    iaModal.classList.remove('is-open');
    document.body.classList.remove('has-modal');
  }

  function applyIaVersion() {
    if (!iaSugestaoEl || !msgEl) return closeIaModal();
    const texto = (iaSugestaoEl.value || '').trim();
    if (!texto) {
      alert('A versão da IA está vazia. Ajuste ou feche o modal.');
      return;
    }
    msgEl.value = texto;
    closeIaModal();
    msgEl.focus();
  }

  async function chamarIaMelhorar(ev) {
    ev?.preventDefault?.();

    const draft = (msgEl?.value || '').trim();
    if (!draft) {
      alert('Digite a mensagem primeiro para a IA melhorar.');
      msgEl?.focus();
      return;
    }

    openIaModal(draft, '');
    setIaStatus('Chamando IA para melhorar sua mensagem…', 'info');

    if (iaApplyBtn) iaApplyBtn.disabled = true;
    if (iaRegerarBtn) iaRegerarBtn.disabled = true;

    try {
      const res = await F(API_IA_MELHORAR, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mensagem: draft })
      });

      const txt = await res.text();
      let data;
      try { data = txt ? JSON.parse(txt) : {}; }
      catch { data = { raw: txt }; }

      if (!res.ok) {
        const msg = (data && (data.detail || data.message)) || `Erro HTTP ${res.status}`;
        console.error('[IA-DISPARO] Erro HTTP', res.status, data);
        setIaStatus(msg, 'error');
        alert('Erro ao chamar IA: ' + msg);
        return;
      }

      const original = data.original ?? draft;
      const melhorada = data.melhorada ?? data.mensagem ?? data.text ?? txt ?? draft;

      if (iaOriginalEl) iaOriginalEl.value = original;
      if (iaSugestaoEl) iaSugestaoEl.value = melhorada;

      if (melhorada === '__EMPTY__') {
        setIaStatus('A IA entendeu que o rascunho está vazio. Revise o texto e tente novamente.', 'error');
      } else {
        setIaStatus('Revise, ajuste se quiser e clique em “Usar esta versão”.', 'success');
      }
    } catch (e) {
      console.error('[IA-DISPARO] Erro ao chamar IA', e);
      setIaStatus('Erro ao chamar IA. Tente novamente em instantes.', 'error');
      alert('Erro ao chamar IA. Veja o console do navegador para detalhes.');
    } finally {
      if (iaApplyBtn) iaApplyBtn.disabled = false;
      if (iaRegerarBtn) iaRegerarBtn.disabled = false;
    }
  }

  async function regerarIa(ev) {
    ev?.preventDefault?.();

    const draft = (iaOriginalEl?.value || msgEl?.value || '').trim();
    if (!draft) {
      alert('Não há texto base para gerar outra variação.');
      return;
    }

    setIaStatus('Gerando outra variação…', 'info');
    if (iaApplyBtn) iaApplyBtn.disabled = true;
    if (iaRegerarBtn) iaRegerarBtn.disabled = true;

    try {
      const res = await F(API_IA_MELHORAR, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mensagem: draft })
      });

      const txt = await res.text();
      let data;
      try { data = txt ? JSON.parse(txt) : {}; }
      catch { data = { raw: txt }; }

      if (!res.ok) {
        const msg = (data && (data.detail || data.message)) || `Erro HTTP ${res.status}`;
        console.error('[IA-DISPARO] Erro HTTP (regerar)', res.status, data);
        setIaStatus(msg, 'error');
        alert('Erro ao chamar IA: ' + msg);
        return;
      }

      const original = data.original ?? draft;
      const melhorada = data.melhorada ?? data.mensagem ?? data.text ?? txt ?? draft;

      if (iaOriginalEl) iaOriginalEl.value = original;
      if (iaSugestaoEl) iaSugestaoEl.value = melhorada;

      if (melhorada === '__EMPTY__') {
        setIaStatus('A IA entendeu que o rascunho está vazio. Revise o texto e tente novamente.', 'error');
      } else {
        setIaStatus('Nova variação gerada. Revise e clique em “Usar esta versão”.', 'success');
      }
    } catch (e) {
      console.error('[IA-DISPARO] Erro ao chamar IA (regerar)', e);
      setIaStatus('Erro ao chamar IA. Tente novamente em instantes.', 'error');
      alert('Erro ao chamar IA. Veja o console do navegador para detalhes.');
    } finally {
      if (iaApplyBtn) iaApplyBtn.disabled = false;
      if (iaRegerarBtn) iaRegerarBtn.disabled = false;
    }
  }

  function syncDelayResumo() {
    if (!resDelayEl) return;

    let v = 20;
    if (delayEl) {
      const n = Number.parseInt(delayEl.value || '20', 10);
      if (Number.isFinite(n)) v = Math.max(5, Math.min(3600, n));
    }

    if (v >= 60) {
      const min = Math.round(v / 60);
      resDelayEl.textContent = min + (min === 1 ? ' min' : ' mins');
    } else {
      resDelayEl.textContent = v + 's';
    }
  }

  function parseNumeros() {
    const raw = (numsEl?.value || '');
    const parts = raw.split(/[\n,;]+/);
    const seen = new Set();
    const valid = [];
    const invalid = [];

    for (const part of parts) {
      const s = part.trim();
      if (!s) continue;

      const digits = s.replace(/\D+/g, '');
      if (!digits) continue;

      if (dedupEl?.checked) {
        if (seen.has(digits)) continue;
        seen.add(digits);
      }

      const obj = { raw: s, digits };
      if (digits.length >= 10) valid.push(obj);
      else invalid.push(obj);
    }

    if (resTotalEl) resTotalEl.textContent = String(valid.length + invalid.length);
    if (resValidosEl) resValidosEl.textContent = String(valid.length);
    if (resInvalidosEl) resInvalidosEl.textContent = String(invalid.length);

    return { valid, invalid };
  }

  function handleFileChange(ev) {
    const input = ev.target;
    const file = input?.files?.[0];
    if (!file) return;

    setImportStatus(`Lendo arquivo "${file.name}"…`, 'info');

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        if (!text.trim()) {
          setImportStatus('Arquivo vazio ou sem conteúdo legível.', 'error');
          input.value = '';
          return;
        }

        const atual = numsEl?.value || '';
        const combined = atual ? (atual.trimEnd() + '\n' + text.trim()) : text.trim();

        if (numsEl) numsEl.value = combined;
        parseNumeros();
        setImportStatus(`Importado: ${file.name} (${file.size} bytes).`, 'success');
      } catch (e) {
        console.error('Erro ao importar arquivo de números', e);
        setImportStatus('Erro ao processar o arquivo.', 'error');
      } finally {
        input.value = '';
      }
    };

    reader.onerror = () => {
      console.error('Erro ao ler arquivo de números', reader.error);
      setImportStatus('Erro ao ler arquivo. Tente novamente.', 'error');
      input.value = '';
    };

    reader.readAsText(file, 'utf-8');
  }

  function buildClientesUrl(q, offset) {
    const empresaId = getEmpresaId();
    const params = new URLSearchParams();
    if (empresaId) params.set('empresa_id', String(empresaId));
    params.set('limit', '50');
    params.set('offset', String(offset || 0));
    if (q) params.set('q', q);
    return `${API_CLIENTES}?${params.toString()}`;
  }

  function updateRowFromCheckbox(checkbox) {
    const tr = checkbox.closest('tr');
    if (!tr) return;
    tr.classList.toggle('is-selected', !!checkbox.checked);
  }

  function syncCliCheckAllState() {
    if (!cliCheckAllEl || !clientesListEl) return;
    const allChecks = $$('.cli-check', clientesListEl);
    if (!allChecks.length) {
      cliCheckAllEl.checked = false;
      cliCheckAllEl.indeterminate = false;
      return;
    }
    const totalChecked = allChecks.filter(ch => ch.checked).length;
    cliCheckAllEl.checked = totalChecked === allChecks.length;
    cliCheckAllEl.indeterminate = totalChecked > 0 && totalChecked < allChecks.length;
  }

  function renderClientesList(items, append) {
    if (!clientesListEl) return;
    if (!append) clientesListEl.innerHTML = '';

    if ((!items || !items.length) && !append) {
      if (clientesEmptyEl) clientesEmptyEl.style.display = '';
      return;
    }

    if (clientesEmptyEl) clientesEmptyEl.style.display = 'none';

    items.forEach((item) => {
      const tr = document.createElement('tr');
      tr.classList.add('cli-row');

      const nome = (item.nome_whatsapp || item.nome || 'Cliente').toString();
      const telefone = (item.telefone || '').toString();
      const depto = (item.departamento || '').toString();
      const digits = telefone.replace(/\D+/g, '');

      const safeNome = nome.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safeTel  = telefone.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safeDep  = depto.replace(/</g, '&lt;').replace(/>/g, '&gt;');

      tr.innerHTML = `
        <td>
          <input type="checkbox"
                 class="cli-check"
                 data-phone="${safeTel}"
                 data-digits="${digits}"
                 data-nome="${safeNome}">
        </td>
        <td>${safeNome}</td>
        <td>${safeTel || '—'}</td>
        <td>${safeDep || '—'}</td>
      `;
      clientesListEl.appendChild(tr);
    });

    $$('.cli-check', clientesListEl).forEach(updateRowFromCheckbox);
    syncCliCheckAllState();
  }

  async function loadClientes(opts) {
    if (!clientesModal || !clientesListEl) return;

    opts = opts || {};
    const q = typeof opts.q === 'string' ? opts.q.trim() : clientesState.q;
    const append = !!opts.append;

    if (clientesState.loading) return;
    if (append && !clientesState.has_more) return;

    const offset = append ? (clientesState.next_offset || 0) : 0;
    clientesState.loading = true;

    if (!append) {
      if (clientesEmptyEl) clientesEmptyEl.style.display = 'none';
      clientesListEl.innerHTML = '';
    }

    try {
      const url = buildClientesUrl(q, offset);
      const res = await F(url, { credentials: 'include' });
      const txt = await res.text();

      let data;
      try { data = txt ? JSON.parse(txt) : {}; }
      catch { data = { raw: txt }; }

      const items = Array.isArray(data?.items) ? data.items : [];

      if (!append) clientesState.items = items.slice();
      else clientesState.items = clientesState.items.concat(items);

      clientesState.q = q;
      clientesState.has_more = !!data?.has_more;
      clientesState.next_offset = data?.next_offset || 0;

      renderClientesList(items, append);
      if (clientesLoadMoreBtn) clientesLoadMoreBtn.style.display = clientesState.has_more ? '' : 'none';
    } catch (e) {
      console.error('Erro ao carregar clientes para o disparo', e);
      if (!append) renderClientesList([], false);
      if (clientesLoadMoreBtn) clientesLoadMoreBtn.style.display = 'none';
    } finally {
      clientesState.loading = false;
    }
  }

  function openClientesModal() {
    if (!clientesModal) return;

    clientesState.q = '';
    clientesState.items = [];
    clientesState.has_more = false;
    clientesState.next_offset = 0;

    if (clientesSearchEl) clientesSearchEl.value = '';
    if (clientesListEl) clientesListEl.innerHTML = '';
    if (clientesEmptyEl) clientesEmptyEl.style.display = 'none';

    if (cliCheckAllEl) {
      cliCheckAllEl.checked = false;
      cliCheckAllEl.indeterminate = false;
    }

    clientesModal.setAttribute('aria-hidden', 'false');
    clientesModal.classList.add('is-open');
    document.body.classList.add('has-modal');

    loadClientes({ q: '', append: false });
    setTimeout(() => clientesSearchEl?.focus(), 50);
  }

  function closeClientesModal() {
    if (!clientesModal) return;
    clientesModal.setAttribute('aria-hidden', 'true');
    clientesModal.classList.remove('is-open');
    document.body.classList.remove('has-modal');
  }

  function applyClientesSelection() {
    if (!clientesListEl || !numsEl) return closeClientesModal();

    const checks = $$('.cli-check:checked', clientesListEl);
    if (!checks.length) {
      alert('Selecione pelo menos um cliente para adicionar.');
      return;
    }

    const { valid, invalid } = parseNumeros();
    const seenDigits = new Set();
    valid.forEach(v => seenDigits.add(v.digits));
    invalid.forEach(v => seenDigits.add(v.digits));

    const toAdd = [];

    checks.forEach(ch => {
      const phone = ch.dataset.phone || '';
      const digits = (ch.dataset.digits || '').replace(/\D+/g, '');
      if (!digits) return;

      if (dedupEl?.checked && seenDigits.has(digits)) return;
      seenDigits.add(digits);
      toAdd.push(phone || digits);
    });

    if (!toAdd.length) {
      alert('Nenhum número novo para adicionar (todos já estavam na lista).');
      closeClientesModal();
      return;
    }

    let base = (numsEl.value || '').trimEnd();
    if (base && !base.endsWith('\n')) base += '\n';
    numsEl.value = base + toAdd.join('\n');

    parseNumeros();
    closeClientesModal();
  }

  let clientesSearchTimer = null;
  function handleClientesSearchInput() {
    if (!clientesSearchEl) return;
    const term = clientesSearchEl.value.trim();
    if (clientesSearchTimer) clearTimeout(clientesSearchTimer);
    clientesSearchTimer = setTimeout(() => loadClientes({ q: term, append: false }), 300);
  }

  function handleClientesListClick(e) {
    if (!clientesListEl) return;
    const row = e.target.closest('tr');
    if (!row || !clientesListEl.contains(row)) return;

    const checkbox = row.querySelector('.cli-check');
    if (!checkbox) return;

    if (e.target === checkbox) {
      updateRowFromCheckbox(checkbox);
      syncCliCheckAllState();
      return;
    }

    checkbox.checked = !checkbox.checked;
    updateRowFromCheckbox(checkbox);
    syncCliCheckAllState();
  }

  function getPayload() {
    const mensagem = (msgEl?.value || '').trim();
    const { valid } = parseNumeros();

    if (!mensagem) {
      alert('Digite a mensagem do disparo.');
      msgEl?.focus();
      return null;
    }

    if (!valid.length) {
      alert('Informe ao menos um número válido.');
      numsEl?.focus();
      return null;
    }

    let delaySegundos = 20;
    if (delayEl) {
      const n = Number.parseInt(delayEl.value || '20', 10);
      if (Number.isFinite(n)) delaySegundos = Math.max(5, Math.min(3600, n));
    }

    const instId = window.__INST_ID
      ? Number(String(window.__INST_ID).replace(/\D/g, ''))
      : null;

    if (!instId) {
      alert('Selecione uma instância de WhatsApp no topo antes de disparar.');
      return null;
    }

    return {
      mensagem,
      numeros: valid.map(v => v.raw),
      instancia_id: instId,
      delay_segundos: delaySegundos,
      tipo_conteudo: 'text',
      midia_id: null
    };
  }

  async function enviarDisparo(ev) {
    ev?.preventDefault?.();

    const payload = getPayload();
    if (!payload) return;

    setStatus('Enviando disparo…', 'info');
    if (btnDisparar) {
      btnDisparar.disabled = true;
      btnDisparar.classList.add('loading');
    }

    try {
      const res = await F(API_CREATE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      const txt = await res.text();
      let data;
      try { data = txt ? JSON.parse(txt) : {}; }
      catch { data = { raw: txt }; }

      if (!res.ok || data?.ok === false) {
        let msg = '';
        const detail = data?.detail;

        if (typeof detail === 'string') msg = detail;
        else if (Array.isArray(detail)) msg = detail.map(d => d.msg || d.message || JSON.stringify(d)).join(' | ');
        else if (detail && typeof detail === 'object') msg = detail.msg || detail.message || JSON.stringify(detail);
        else if (data?.message) msg = data.message;
        else msg = `Erro HTTP ${res.status}`;

        const err = new Error(msg);
        err.data = data;
        err.status = res.status;
        throw err;
      }

      setStatus('Disparo criado com sucesso.', 'success');
      carregarHistorico();
    } catch (e) {
      console.error('Erro ao enviar disparo', e);
      const msg = (e && typeof e.message === 'string' && e.message) || 'Erro ao enviar disparo.';
      setStatus(msg, 'error');
      alert('Erro ao enviar disparo: ' + msg);
    } finally {
      if (btnDisparar) {
        btnDisparar.disabled = false;
        btnDisparar.classList.remove('loading');
      }
    }
  }

  function fmtDate(s) {
    if (!s) return '—';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return String(s);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  }

  function resolveAutor(item) {
    const label =
      item?.criado_por ||
      item?.criado_por_nome ||
      item?.criado_por_label ||
      item?.autor_nome ||
      item?.colaborador_nome ||
      item?.usuario_nome;

    if (label) return String(label);

    const cid = item?.colaborador_id ?? item?.colab_id ?? null;
    const uid = item?.usuario_id ?? item?.user_id ?? null;

    if (cid) return `Colab #${cid}`;
    if (uid) return `Usuário #${uid}`;
    return '—';
  }

  function tdCell(label, value, extraStyle) {
    return `<td data-label="${escapeHTML(label)}"${extraStyle ? ` style="${extraStyle}"` : ''}>${value}</td>`;
  }

  function renderHistorico(itens) {
    if (!tbodyHist) return;

    tbodyHist.innerHTML = '';

    if (!Array.isArray(itens) || !itens.length) {
      if (emptyHist) emptyHist.style.display = '';
      if (topMetaEl) topMetaEl.textContent = '0';
      return;
    }

    if (emptyHist) emptyHist.style.display = 'none';
    if (topMetaEl) topMetaEl.textContent = String(itens.length);

    itens.forEach(item => {
      const tr = document.createElement('tr');

      const msg = (item.mensagem || '').toString();
      const preview = msg.length > 80 ? msg.slice(0, 80) + '…' : msg;
      const qtd = item.qtd_numeros ?? item.total_numeros ?? (item.numeros?.length || 0);
      const inst = item.instancia_nome || item.instance_name || item.instancia_id || '—';
      const por = resolveAutor(item);
      const status = (item.status || 'pendente').toString();
      const criado = fmtDate(item.criado_em || item.created_at || item.created);

      tr.innerHTML = [
        tdCell('Mensagem', escapeHTML(preview || '—')),
        tdCell('Qtd. números', escapeHTML(qtd), 'text-align:center'),
        tdCell('Instância', escapeHTML(inst)),
        tdCell('Por', escapeHTML(por)),
        tdCell('Status', escapeHTML(status)),
        tdCell('Criado em', escapeHTML(criado))
      ].join('');

      tbodyHist.appendChild(tr);
    });
  }

  async function carregarHistorico() {
    if (!tbodyHist) return;

    let url = API_LIST;
    const empresaId = getEmpresaId();
    const params = [];
    if (empresaId) params.push(`empresa_id=${encodeURIComponent(String(empresaId))}`);
    if (window.__INST_ID) params.push(`instancia_id=${encodeURIComponent(String(window.__INST_ID))}`);
    if (params.length) url += (url.includes('?') ? '&' : '?') + params.join('&');

    try {
      const res = await F(url, { credentials: 'include' });
      const txt = await res.text();

      let data;
      try { data = txt ? JSON.parse(txt) : {}; }
      catch { data = { raw: txt }; }

      const itens = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
      renderHistorico(itens);
    } catch (e) {
      console.error('Erro ao carregar histórico de disparos', e);
      renderHistorico([]);
    }
  }

  function ensureCSSEscape() {
    if (!window.CSS) window.CSS = {};
    if (typeof window.CSS.escape !== 'function') {
      window.CSS.escape = function (val) {
        return String(val ?? '').replace(/["\\]/g, '\\$&').replace(/\s/g, '\\ ');
      };
    }
  }

  function initInstDropdown() {
    const btn = $('#instMenuBtn');
    const label = $('#instMenuLabel');
    const menu = $('#inst-menu');
    const listEl = $('#instMenuList');

    if (!btn || !menu || !listEl) return;

    ensureCSSEscape();
    const empresaId = getEmpresaId();

    function openMenu() {
      menu.setAttribute('aria-hidden', 'false');
      btn.setAttribute('aria-expanded', 'true');
      const first = listEl.querySelector('.inst-item[aria-selected="true"]') || listEl.querySelector('.inst-item');
      first?.focus();
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('keydown', onKey);
    }

    function closeMenu() {
      menu.setAttribute('aria-hidden', 'true');
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    }

    function toggleMenu() {
      const isHidden = menu.getAttribute('aria-hidden') !== 'false';
      isHidden ? openMenu() : closeMenu();
    }

    function onDocClick(e) {
      if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeMenu();
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        btn.focus();
        return;
      }

      if (menu.getAttribute('aria-hidden') === 'true') return;

      const items = Array.from(listEl.querySelectorAll('.inst-item'));
      const i = items.indexOf(document.activeElement);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        (items[i + 1] || items[0])?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        (items[i - 1] || items[items.length - 1])?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1]?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        const a = document.activeElement;
        if (a && a.classList.contains('inst-item')) {
          e.preventDefault();
          selectValue(a.dataset.value, a.dataset.label);
        }
      }
    }

    btn.addEventListener('click', toggleMenu);

    const instValue = i => i.instancia_id ?? i.id ?? i.instance_id ?? i.session ?? i.sessionName ?? '';
    const instLabel = (i, v) => i.apelido || i.nome || i.instance_name || String(v) || 'Instância';

    function makeItem(text, value, selected) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'inst-item';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', selected ? 'true' : 'false');
      b.tabIndex = -1;
      b.dataset.value = String(value ?? '');
      b.dataset.label = text;
      b.innerHTML = `
        <span class="radio" aria-hidden="true"></span>
        <span>${escapeHTML(text)}</span>
      `;
      b.addEventListener('click', () => selectValue(String(value ?? ''), text));
      li.appendChild(b);
      return li;
    }

    function setActiveUI(value, text) {
      $$('.inst-item', listEl).forEach(b => {
        b.setAttribute('aria-selected', b.dataset.value === String(value) ? 'true' : 'false');
      });

      const active = listEl.querySelector(`.inst-item[data-value="${window.CSS.escape(String(value))}"]`);
      if (active) {
        if (!active.id) active.id = 'inst-opt-' + String(value || 'all');
        menu.setAttribute('aria-activedescendant', active.id);
      }

      if (label) label.textContent = text || (value ? `Instância ${value}` : 'Todas as instâncias');
    }

    function applyInstancia(value, text) {
      window.__INST_ID = value ? Number(String(value).replace(/\D/g, '')) : '';
      window.__INST_NAME = (text || '').trim();
      setActiveUI(value, text);
      if (typeof window.onInstanciaChange === 'function') window.onInstanciaChange(value, text);
    }

    function selectValue(value, text) {
      applyInstancia(value, text);
      closeMenu();
      btn.focus();
    }

    async function loadList() {
      listEl.innerHTML = '';
      listEl.appendChild(makeItem('Todas as instâncias', '', false));

      let items = [];

      if (empresaId) {
        try {
          const r = await F(`/api/empresas/${empresaId}/whatsapp`, { credentials: 'include' });
          if (r.ok) {
            const j = await r.json();
            items = Array.isArray(j.instancias) ? j.instancias : [];
          }
        } catch {}

        if (!items.length) {
          try {
            const r2 = await F(`/api/instancias/list?empresa_id=${empresaId}`, { credentials: 'include' });
            if (r2.ok) {
              const j2 = await r2.json();
              items = Array.isArray(j2) ? j2 : (Array.isArray(j2?.instancias) ? j2.instancias : []);
            }
          } catch {}
        }
      }

      items.forEach(i => {
        const v = String(instValue(i) ?? '');
        const t = instLabel(i, v);
        listEl.appendChild(makeItem(t, v, false));
      });

      if (window.__INST_ID == null || window.__INST_ID === '') {
        const firstConnected = items.find(x => !!(x.connected || x.conectada || x.status === 'CONNECTED'));
        const firstAny = items[0];
        const chosen = firstConnected || firstAny;
        window.__INST_ID = chosen ? Number(String(instValue(chosen) || '').replace(/\D/g, '')) : '';
      }

      if (window.__INST_ID) {
        const val = String(window.__INST_ID);
        const sel = listEl.querySelector(`.inst-item[data-value="${window.CSS.escape(val)}"]`);
        const text = sel?.dataset?.label || `Instância ${val}`;
        applyInstancia(val, text);
      } else {
        applyInstancia('', 'Todas as instâncias');
      }
    }

    loadList();
  }

  window.onInstanciaChange = function () {
    carregarHistorico();
  };

  function init() {
    if (chkIaVariar) {
      chkIaVariar.checked = false;
      chkIaVariar.disabled = true;
      chkIaVariar.title = 'Em breve: variações por número ainda não estão implementadas no backend.';
    }

    if (numsEl) {
      ['input', 'blur'].forEach(ev => numsEl.addEventListener(ev, parseNumeros));
      parseNumeros();
    }

    dedupEl?.addEventListener('change', parseNumeros);

    if (delayEl) {
      delayEl.addEventListener('change', syncDelayResumo);
      syncDelayResumo();
    } else if (resDelayEl) {
      resDelayEl.textContent = '20s';
    }

    fileEl?.addEventListener('change', handleFileChange);
    btnDisparar?.addEventListener('click', enviarDisparo);

    iaBtnOpen?.addEventListener('click', chamarIaMelhorar);
    iaApplyBtn?.addEventListener('click', applyIaVersion);
    iaRegerarBtn?.addEventListener('click', regerarIa);
    iaCloseBtn?.addEventListener('click', closeIaModal);

    if (iaModal) {
      iaModal.addEventListener('click', (e) => {
        if (e.target === iaModal) closeIaModal();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && iaModal.classList.contains('is-open')) closeIaModal();
      });
    }

    if (btnAddFromClientes && clientesModal) btnAddFromClientes.addEventListener('click', openClientesModal);
    clientesCloseBtn?.addEventListener('click', closeClientesModal);
    clientesApplyBtn?.addEventListener('click', applyClientesSelection);
    clientesLoadMoreBtn?.addEventListener('click', () => loadClientes({ append: true }));
    clientesSearchEl?.addEventListener('input', handleClientesSearchInput);

    if (cliCheckAllEl && clientesListEl) {
      cliCheckAllEl.addEventListener('change', () => {
        const checked = cliCheckAllEl.checked;
        $$('.cli-check', clientesListEl).forEach(ch => {
          ch.checked = checked;
          updateRowFromCheckbox(ch);
        });
        syncCliCheckAllState();
      });
    }

    clientesListEl?.addEventListener('click', handleClientesListClick);

    if (clientesModal) {
      clientesModal.addEventListener('click', (e) => {
        if (e.target === clientesModal) closeClientesModal();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && clientesModal.classList.contains('is-open')) closeClientesModal();
      });
    }

    initInstDropdown();

    const doLoad = () => carregarHistorico();

    if (window.Page && typeof window.Page.guarded === 'function') {
      window.Page.guarded('disparos.ver', doLoad);
    } else {
      doLoad();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();