// /frontend/js/pages/disparos.js
(function () {
  'use strict';

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const msgEl            = $('#msgDisparo');
  const numsEl           = $('#numsDisparos');
  const dedupEl          = $('#optDedup');
  const delayEl          = $('#delaySegundos');
  const fileEl           = $('#fileNumeros');
  const importStatusEl   = $('#importStatus');
  const resInstanciaEl   = $('#resInstancia');
  const resTotalEl       = $('#resTotal');
  const resValidosEl     = $('#resValidos');
  const resInvalidosEl   = $('#resInvalidos');
  const resDelayEl       = $('#resDelay');
  const resEstimativaEl  = $('#resEstimativa');
  const resumeStateEl    = $('#resumeState');
  const summaryAdviceEl  = $('#summaryAdvice');
  const btnDisparar      = $('#btnDisparar');
  const statusEl         = $('#statusDisparos');
  const delayRiskBadgeEl = $('#delayRiskBadge');
  const topMetaEl        = $('#topMetaDisparos');
  const heroInstHelpEl   = $('#heroInstHelp');
  const connectionTitleEl= $('#connectionTitle');
  const connectionChipEl = $('#connectionChip');
  const instMenuBtnEl     = $('#instMenuBtn');
  const messageCounterEl  = $('#messageCounter');
  const metricAtivasEl    = $('#metricAtivas');
  const metricPendentesEl = $('#metricPendentes');
  const metricEnviadosEl  = $('#metricEnviados');
  const metricErrosEl     = $('#metricErros');
  const btnAtualizarHist = $('#btnAtualizarHistorico');

  const tbodyHist        = $('#tbodyDisparos');
  const emptyHist        = $('#emptyDisparos');

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
  const toastEl       = $('#toast');

  const btnPreencherExemplo = $('#btnPreencherExemplo');
  const btnLimparRascunho   = $('#btnLimparRascunho');
  const templateButtons     = $$('.tpl-chip');

  const API_BASE        = '/api/disparos';
  const API_CREATE      = `${API_BASE}/simples`;
  const API_LIST        = `${API_BASE}?limit=50`;
  const API_CLIENTES    = '/api/clientes';
  const API_IA_MELHORAR = `${API_BASE}/ia-melhorar`;
  const MAX_CONTACTS = 5000;

  const F = (window.ZAuth?.guardFetch || window.ZAuth?.authFetch || fetch);

  const clientesState = {
    q: '',
    items: [],
    has_more: false,
    next_offset: 0,
    loading: false,
  };

  const DRAFT_KEY = 'zc:disparos:draft:v3';
  let toastTimer = null;
  let autoRefreshTimer = null;
  let pendingRequestId = null;
  let pendingRequestFingerprint = null;

  const TEMPLATES = {
    cobranca: 'Olá! Tudo bem? Passando para lembrar sobre sua pendência em aberto. Se quiser, posso te enviar os detalhes e as formas de pagamento por aqui.',
    pos_venda: 'Olá! Passando para saber se ficou tudo certo com seu atendimento. Se precisar de qualquer ajuste ou suporte, estou à disposição.',
    reativacao: 'Olá! Tudo bem? Faz um tempo que não falamos. Estamos com condições especiais e queria saber se você ainda tem interesse.',
    promocao: 'Olá! Tudo bem? Estamos com uma condição especial por tempo limitado. Se quiser, posso te passar os detalhes por aqui.',
    lembrete: 'Olá! Tudo bem? Estou passando para te lembrar sobre nosso contato anterior. Se quiser continuar, me responde por aqui.'
  };

  const EXAMPLE_MESSAGE = 'Olá! Tudo bem? Passando para falar com você rapidamente. Se quiser, posso te mandar mais detalhes por aqui.';
  const EXAMPLE_NUMBERS = ['11999999999', '11988888888', '11977777777'];

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

  function showToast(text, kind = 'info') {
    if (!toastEl) return;
    toastEl.textContent = text || '';
    toastEl.className = 'show';
    toastEl.dataset.kind = kind;

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
      toastEl.textContent = '';
      toastEl.removeAttribute('data-kind');
    }, 3200);
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

  function normalizeStatusHuman(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'pendente') return { label: 'Na fila', cls: 'pending' };
    if (s === 'processando') return { label: 'Enviando', cls: 'processing' };
    if (s === 'concluido') return { label: 'Finalizado', cls: 'success' };
    if (s === 'parcial') return { label: 'Finalizado com falhas', cls: 'partial' };
    if (s === 'erro') return { label: 'Falhou', cls: 'error' };
    if (s === 'cancelado') return { label: 'Cancelado', cls: 'muted' };
    return { label: status || '—', cls: 'muted' };
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

  function formatTempo(seg) {
    const n = Number(seg || 0);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n < 60) return `${n}s`;
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = n % 60;
    const parts = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}min`);
    if (!h && !m && s) parts.push(`${s}s`);
    return parts.join(' ');
  }

  function getDelayValue() {
    let v = 20;
    if (delayEl) {
      const n = Number.parseInt(delayEl.value || '20', 10);
      if (Number.isFinite(n)) v = Math.max(5, Math.min(3600, n));
    }
    return v;
  }

  function getDelayLabel(v) {
    const n = Number(v || getDelayValue());
    if (n >= 60) {
      const min = Math.round(n / 60);
      return min === 1 ? '1 min' : `${min} mins`;
    }
    return `${n}s`;
  }

  function updateDelayRisk() {
    if (!delayRiskBadgeEl) return;
    const v = getDelayValue();
    if (v <= 10) {
      delayRiskBadgeEl.textContent = 'Mais arriscado';
      delayRiskBadgeEl.dataset.kind = 'warn';
    } else if (v <= 30) {
      delayRiskBadgeEl.textContent = 'Seguro';
      delayRiskBadgeEl.dataset.kind = 'ok';
    } else {
      delayRiskBadgeEl.textContent = 'Mais conservador';
      delayRiskBadgeEl.dataset.kind = 'soft';
    }
  }

  function normalizeBrazilPhone(value) {
    let digits = String(value || '').replace(/\D+/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    let local = digits;
    if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) local = digits.slice(2);
    else if (digits.length !== 10 && digits.length !== 11) return null;

    const ddd = local.slice(0, 2);
    const number = local.slice(2);
    if (ddd.length !== 2 || ddd.includes('0')) return null;
    if (number.length === 9 && number[0] !== '9') return null;
    if (number.length === 8 && !'2345'.includes(number[0])) return null;
    return '55' + local;
  }

  function parseNumeros() {
    const raw = (numsEl?.value || '');
    const parts = raw.split(/[\n,;]+/);
    const seen = new Set();
    const valid = [];
    const invalid = [];

    for (const part of parts) {
      const value = part.trim();
      if (!value) continue;
      const normalized = normalizeBrazilPhone(value);
      if (!normalized) { invalid.push({ raw: value, digits: value.replace(/\D+/g, '') }); continue; }
      if (dedupEl?.checked && seen.has(normalized)) continue;
      seen.add(normalized);
      valid.push({ raw: value, digits: normalized });
    }

    if (resTotalEl) resTotalEl.textContent = String(valid.length + invalid.length);
    if (resValidosEl) resValidosEl.textContent = String(valid.length);
    if (resInvalidosEl) resInvalidosEl.textContent = String(invalid.length);
    return { valid, invalid };
  }

  function saveDraft() {
    try {
      const payload = {
        mensagem: msgEl?.value || '',
        numeros: numsEl?.value || '',
        delay: delayEl?.value || '20',
        dedup: !!dedupEl?.checked,
        saved_at: Date.now()
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
    } catch {}
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return false;
      const draft = JSON.parse(raw);

      if (msgEl && typeof draft?.mensagem === 'string' && !msgEl.value.trim()) {
        msgEl.value = draft.mensagem;
      }
      if (numsEl && typeof draft?.numeros === 'string' && !numsEl.value.trim()) {
        numsEl.value = draft.numeros;
      }
      if (delayEl && draft?.delay) {
        delayEl.value = String(draft.delay);
      }
      if (dedupEl && typeof draft?.dedup === 'boolean') {
        dedupEl.checked = draft.dedup;
      }
      return true;
    } catch {
      return false;
    }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
  }

  function updateResumo() {
    const { valid, invalid } = parseNumeros();
    const instName = (window.__INST_NAME || '').trim();
    const delay = getDelayValue();
    const totalSeg = valid.length > 0 ? Math.max(0, (valid.length - 1) * delay) : 0;

    if (resInstanciaEl) {
      resInstanciaEl.textContent = instName || 'Não selecionada';
      resInstanciaEl.dataset.empty = instName ? '0' : '1';
    }

    if (resDelayEl) resDelayEl.textContent = getDelayLabel(delay);
    if (resEstimativaEl) resEstimativaEl.textContent = valid.length ? formatTempo(totalSeg) : '—';

    const messageLength = (msgEl?.value || '').length;
    if (messageCounterEl) messageCounterEl.textContent = `${messageLength} / 4096`;
    const hasMsg = !!(msgEl?.value || '').trim();
    const hasInst = !!window.__INST_ID;
    const isConnected = window.__INST_CONNECTED !== false;
    const hasValid = valid.length > 0;

    if (!hasInst) {
      resumeStateEl.textContent = 'Falta escolher instância';
      resumeStateEl.dataset.kind = 'warn';
      summaryAdviceEl.textContent = 'Escolha primeiro o WhatsApp de envio. Sem isso o disparo não pode começar.';
    } else if (!isConnected) {
      resumeStateEl.textContent = 'WhatsApp desconectado';
      resumeStateEl.dataset.kind = 'warn';
      summaryAdviceEl.textContent = 'Reconecte esta instância antes de iniciar a campanha.';
    } else if (!hasMsg) {
      resumeStateEl.textContent = 'Falta escrever a mensagem';
      resumeStateEl.dataset.kind = 'warn';
      summaryAdviceEl.textContent = 'Digite a mensagem que será enviada para os contatos.';
    } else if (!hasValid) {
      resumeStateEl.textContent = 'Faltam contatos válidos';
      resumeStateEl.dataset.kind = 'warn';
      summaryAdviceEl.textContent = 'Adicione pelo menos um número válido para iniciar o disparo.';
    } else if (valid.length > MAX_CONTACTS) {
      resumeStateEl.textContent = 'Muitos contatos';
      resumeStateEl.dataset.kind = 'warn';
      summaryAdviceEl.textContent = `O limite por campanha é de ${MAX_CONTACTS.toLocaleString('pt-BR')} contatos.`;
    } else if (invalid.length > 0) {
      resumeStateEl.textContent = 'Revisão recomendada';
      resumeStateEl.dataset.kind = 'soft';
      summaryAdviceEl.textContent = 'Há números suspeitos ou curtos na lista. Revise antes de enviar.';
    } else {
      resumeStateEl.textContent = 'Pronto para disparar';
      resumeStateEl.dataset.kind = 'ok';
      summaryAdviceEl.textContent = `Tudo certo. O envio será feito em fila usando ${instName} com intervalo de ${getDelayLabel(delay)}.`;
    }

    if (heroInstHelpEl) {
      heroInstHelpEl.textContent = !hasInst
        ? 'Escolha uma instância conectada para liberar a criação da campanha.'
        : (isConnected ? 'A fila está pronta e continuará após reinícios do servidor.' : 'Esta instância está desconectada e não pode iniciar campanhas.');
    }
    if (connectionTitleEl) connectionTitleEl.textContent = hasInst ? instName : 'Selecione o WhatsApp de envio';
    if (connectionChipEl) {
      connectionChipEl.textContent = !hasInst ? 'Aguardando seleção' : (isConnected ? 'Conectado' : 'Desconectado');
      connectionChipEl.dataset.kind = !hasInst ? '' : (isConnected ? 'ok' : 'error');
    }
    if (instMenuBtnEl) {
      instMenuBtnEl.classList.toggle('is-connected', hasInst && isConnected);
      instMenuBtnEl.classList.toggle('is-disconnected', hasInst && !isConnected);
    }
    if (btnDisparar) btnDisparar.disabled = !(hasInst && isConnected && hasMsg && hasValid && valid.length <= MAX_CONTACTS);

    updateDelayRisk();
    saveDraft();
  }

  function useTemplate(key) {
    const text = TEMPLATES[key];
    if (!text || !msgEl) return;
    msgEl.value = text;
    updateResumo();
    msgEl.focus();
    showToast('Modelo aplicado na mensagem.', 'success');
  }

  function fillExample() {
    if (msgEl) msgEl.value = EXAMPLE_MESSAGE;
    if (numsEl) numsEl.value = EXAMPLE_NUMBERS.join('\n');
    if (delayEl) delayEl.value = '20';
    if (dedupEl) dedupEl.checked = true;
    updateResumo();
    showToast('Exemplo preenchido.', 'success');
  }

  function clearDraftUI() {
    if (msgEl) msgEl.value = '';
    if (numsEl) numsEl.value = '';
    if (delayEl) delayEl.value = '20';
    if (dedupEl) dedupEl.checked = true;
    clearDraft();
    updateResumo();
    setStatus('', null);
    setImportStatus('', null);
    showToast('Rascunho limpo.', 'success');
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
      setIaStatus('A sugestão está vazia. Ajuste o texto antes de aplicar.', 'error');
      showToast('A sugestão da IA está vazia.', 'error');
      return;
    }
    msgEl.value = texto;
    closeIaModal();
    updateResumo();
    msgEl.focus();
    showToast('Mensagem atualizada com a versão da IA.', 'success');
  }

  async function chamarIaMelhorar(ev) {
    ev?.preventDefault?.();
    const draft = (msgEl?.value || '').trim();
    if (!draft) {
      showToast('Digite a mensagem primeiro para a IA melhorar.', 'error');
      msgEl?.focus();
      return;
    }

    openIaModal(draft, '');
    setIaStatus('Chamando IA para melhorar sua mensagem...', 'info');

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
        setIaStatus(msg, 'error');
        showToast(`Erro ao chamar IA: ${msg}`, 'error');
        return;
      }

      const original = data.original ?? draft;
      const melhorada = data.melhorada ?? data.mensagem ?? data.text ?? txt ?? draft;

      if (iaOriginalEl) iaOriginalEl.value = original;
      if (iaSugestaoEl) iaSugestaoEl.value = melhorada;
      setIaStatus('Revise a sugestão e clique em “Usar esta versão”.', 'success');
    } catch (e) {
      console.error('[IA-DISPARO] Erro', e);
      setIaStatus('Erro ao chamar IA. Tente novamente.', 'error');
      showToast('Erro ao chamar IA.', 'error');
    } finally {
      if (iaApplyBtn) iaApplyBtn.disabled = false;
      if (iaRegerarBtn) iaRegerarBtn.disabled = false;
    }
  }

  async function regerarIa(ev) {
    ev?.preventDefault?.();
    const draft = (iaOriginalEl?.value || msgEl?.value || '').trim();
    if (!draft) {
      showToast('Não há texto base para gerar outra variação.', 'error');
      return;
    }

    setIaStatus('Gerando outra variação...', 'info');
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
        setIaStatus(msg, 'error');
        showToast(`Erro ao chamar IA: ${msg}`, 'error');
        return;
      }

      const original = data.original ?? draft;
      const melhorada = data.melhorada ?? data.mensagem ?? data.text ?? txt ?? draft;

      if (iaOriginalEl) iaOriginalEl.value = original;
      if (iaSugestaoEl) iaSugestaoEl.value = melhorada;
      setIaStatus('Nova variação gerada. Revise e aplique se quiser.', 'success');
    } catch (e) {
      console.error('[IA-DISPARO] Erro ao regerar', e);
      setIaStatus('Erro ao chamar IA. Tente novamente.', 'error');
      showToast('Erro ao chamar IA.', 'error');
    } finally {
      if (iaApplyBtn) iaApplyBtn.disabled = false;
      if (iaRegerarBtn) iaRegerarBtn.disabled = false;
    }
  }

  async function handleFileChange(ev) {
    const input = ev.target;
    const file = input?.files?.[0];
    if (!file) return;
    setImportStatus(`Lendo arquivo "${file.name}"...`, 'info');

    try {
      const ext = String(file.name || '').split('.').pop().toLowerCase();
      let text = '';
      if (ext === 'xlsx') {
        if (!window.XLSX) throw new Error('Leitor XLSX não carregado. Tente novamente.');
        const buffer = await file.arrayBuffer();
        const workbook = window.XLSX.read(buffer, { type: 'array' });
        const rows = [];
        workbook.SheetNames.forEach((name) => {
          const sheet = workbook.Sheets[name];
          const data = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
          data.forEach((row) => row.forEach((cell) => { if (String(cell).trim()) rows.push(String(cell).trim()); }));
        });
        text = rows.join('\n');
      } else if (ext === 'txt' || ext === 'csv') {
        text = await file.text();
      } else {
        throw new Error('Formato não suportado. Use TXT, CSV ou XLSX.');
      }

      if (!text.trim()) throw new Error('Arquivo vazio ou sem números legíveis.');
      const atual = numsEl?.value || '';
      if (numsEl) numsEl.value = atual ? `${atual.trimEnd()}\n${text.trim()}` : text.trim();
      updateResumo();
      const { valid, invalid } = parseNumeros();
      setImportStatus(`${valid.length} válido(s) importado(s)${invalid.length ? `; ${invalid.length} inválido(s)` : ''}.`, invalid.length ? 'info' : 'success');
      showToast('Arquivo importado.', 'success');
    } catch (e) {
      const message = e?.message || 'Erro ao processar o arquivo.';
      setImportStatus(message, 'error');
      showToast(message, 'error');
    } finally {
      input.value = '';
    }
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
      if (!res.ok) throw new Error(`Erro HTTP ${res.status}`);

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
      console.error('Erro ao carregar clientes', e);
      if (!append) renderClientesList([], false);
      if (clientesLoadMoreBtn) clientesLoadMoreBtn.style.display = 'none';
      showToast('Erro ao carregar clientes.', 'error');
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
      showToast('Selecione pelo menos um cliente para adicionar.', 'error');
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
      showToast('Nenhum número novo para adicionar.', 'info');
      closeClientesModal();
      return;
    }

    let base = (numsEl.value || '').trimEnd();
    if (base && !base.endsWith('\n')) base += '\n';
    numsEl.value = base + toAdd.join('\n');

    closeClientesModal();
    updateResumo();
    showToast(`${toAdd.length} contato(s) adicionados.`, 'success');
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

    if (!window.__INST_ID) {
      showToast('Selecione uma instância de WhatsApp antes de disparar.', 'error');
      setStatus('Selecione uma instância de WhatsApp antes de disparar.', 'error');
      return null;
    }

    if (window.__INST_CONNECTED === false) {
      showToast('O WhatsApp selecionado está desconectado.', 'error');
      return null;
    }

    if (!mensagem) {
      showToast('Digite a mensagem do disparo.', 'error');
      msgEl?.focus();
      return null;
    }

    if (!valid.length) {
      showToast('Informe ao menos um número válido.', 'error');
      numsEl?.focus();
      return null;
    }

    if (valid.length > MAX_CONTACTS) {
      showToast(`O limite por campanha é de ${MAX_CONTACTS.toLocaleString('pt-BR')} contatos.`, 'error');
      return null;
    }

    const delaySegundos = getDelayValue();
    const instId = Number(String(window.__INST_ID).replace(/\D/g, ''));

    if (!instId) {
      showToast('Instância inválida.', 'error');
      return null;
    }

    const numeros = valid.map(v => v.raw);
    const fingerprint = JSON.stringify([instId, delaySegundos, mensagem, numeros]);
    if (!pendingRequestId || pendingRequestFingerprint !== fingerprint) {
      pendingRequestId = window.crypto?.randomUUID?.() || `disp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      pendingRequestFingerprint = fingerprint;
    }

    return {
      mensagem,
      numeros,
      instancia_id: instId,
      delay_segundos: delaySegundos,
      tipo_conteudo: 'text',
      midia_id: null,
      request_id: pendingRequestId
    };
  }

  async function enviarDisparo(ev) {
    ev?.preventDefault?.();

    const payload = getPayload();
    if (!payload) return;

    setStatus('Criando disparo e enviando para a fila...', 'info');
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

      if (!res.ok) {
        let msg = '';
        const detail = data?.detail;

        if (typeof detail === 'string') msg = detail;
        else if (Array.isArray(detail)) msg = detail.map(d => d.msg || d.message || JSON.stringify(d)).join(' | ');
        else if (detail && typeof detail === 'object') msg = detail.msg || detail.message || JSON.stringify(detail);
        else if (data?.message) msg = data.message;
        else msg = `Erro HTTP ${res.status}`;

        throw new Error(msg);
      }

      const qtd = Array.isArray(payload.numeros) ? payload.numeros.length : 0;
      const inst = window.__INST_NAME || `Instância ${payload.instancia_id}`;

      setStatus(`Campanha criada. ${qtd} contato(s) entraram na fila segura de ${inst}.`, 'success');
      showToast('Campanha adicionada à fila.', 'success');
      pendingRequestId = null;
      pendingRequestFingerprint = null;
      if (numsEl) numsEl.value = '';
      clearDraft();
      updateResumo();
      carregarHistorico();
    } catch (e) {
      console.error('Erro ao enviar disparo', e);
      const msg = (e && typeof e.message === 'string' && e.message) || 'Erro ao enviar disparo.';
      setStatus(msg, 'error');
      showToast(`Erro ao enviar disparo: ${msg}`, 'error');
    } finally {
      if (btnDisparar) btnDisparar.classList.remove('loading');
      updateResumo();
    }
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

  function buildProgressCell(item) {
    const total = Number(item?.qtd_numeros ?? item?.total_destinatarios ?? 0) || 0;
    const sent = Number(item?.enviados_sucesso ?? 0) || 0;
    const errors = Number(item?.enviados_erro ?? 0) || 0;
    const processed = Math.min(total, sent + errors);
    const pct = Number.isFinite(Number(item?.progresso_pct)) ? Number(item.progresso_pct) : (total ? Math.round((processed / total) * 100) : 0);
    return `
      <div class="progress-cell">
        <div class="progress-row"><strong>${escapeHTML(processed)} de ${escapeHTML(total)}</strong><span>${escapeHTML(pct)}%</span></div>
        <div class="progress-track"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>
        <div class="progress-meta"><span class="ok">${escapeHTML(sent)} enviados</span><span class="bad">${escapeHTML(errors)} falhas</span></div>
      </div>`;
  }

  function reuseHistorico(item) {
    if (!item) return;
    const mensagem = String(item.mensagem || '').trim();
    const delay = item.delay_segundos ?? item.delay ?? item.intervalo_segundos ?? null;
    if (msgEl && mensagem) msgEl.value = mensagem;
    if (delayEl && delay != null) delayEl.value = String(delay);
    updateResumo();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast('Mensagem e intervalo reaproveitados.', 'success');
  }

  async function cancelarHistorico(item, button) {
    if (!item?.id) return;
    if (!window.confirm('Cancelar esta campanha? As mensagens já enviadas não serão desfeitas.')) return;
    if (button) button.disabled = true;
    try {
      const res = await F(`${API_BASE}/${encodeURIComponent(item.id)}/cancelar`, { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || 'Não foi possível cancelar a campanha.');
      showToast('Campanha cancelada.', 'success');
      carregarHistorico();
    } catch (e) {
      showToast(e?.message || 'Erro ao cancelar campanha.', 'error');
      if (button) button.disabled = false;
    }
  }

  function updateMetrics(items) {
    const list = Array.isArray(items) ? items : [];
    const active = list.filter((it) => ['pendente','processando'].includes(String(it?.status || '').toLowerCase())).length;
    const pending = list.reduce((sum,it) => sum + (Number(it?.pendentes) || 0), 0);
    const sent = list.reduce((sum,it) => sum + (Number(it?.enviados_sucesso) || 0), 0);
    const errors = list.reduce((sum,it) => sum + (Number(it?.enviados_erro) || 0), 0);
    if (metricAtivasEl) metricAtivasEl.textContent = active.toLocaleString('pt-BR');
    if (metricPendentesEl) metricPendentesEl.textContent = pending.toLocaleString('pt-BR');
    if (metricEnviadosEl) metricEnviadosEl.textContent = sent.toLocaleString('pt-BR');
    if (metricErrosEl) metricErrosEl.textContent = errors.toLocaleString('pt-BR');
  }

  function renderHistorico(itens, options = {}) {
    if (!tbodyHist) return;
    tbodyHist.innerHTML = '';
    const list = Array.isArray(itens) ? itens : [];
    updateMetrics(list);

    if (!list.length) {
      if (emptyHist) {
        emptyHist.style.display = 'flex';
        const strong = emptyHist.querySelector('strong');
        const small = emptyHist.querySelector('small');
        if (options.error) {
          if (strong) strong.textContent = 'Não foi possível carregar o histórico';
          if (small) small.textContent = 'Verifique a conexão e clique em Atualizar.';
        } else {
          if (strong) strong.textContent = 'Nenhuma campanha encontrada';
          if (small) small.textContent = 'Crie sua primeira campanha usando o formulário acima.';
        }
      }
      if (topMetaEl) topMetaEl.textContent = '0';
      tbodyHist.__items = [];
      return;
    }

    if (emptyHist) emptyHist.style.display = 'none';
    if (topMetaEl) topMetaEl.textContent = String(list.length);

    list.forEach((item, idx) => {
      const tr = document.createElement('tr');
      const msg = String(item.mensagem || '');
      const preview = msg.length > 92 ? msg.slice(0, 92) + '…' : msg;
      const inst = item.instancia_nome || item.instance_name || item.instancia_id || '—';
      const por = resolveAutor(item);
      const statusObj = normalizeStatusHuman(item.status || 'pendente');
      const criado = fmtDate(item.criado_em || item.created_at || item.created);
      const total = Number(item.qtd_numeros || 0);
      const canCancel = item.pode_cancelar === true || ['pendente','processando'].includes(String(item.status || '').toLowerCase());
      const actions = `
        <div class="action-group">
          <button type="button" class="btn btn-soft btn-icon" title="Reusar mensagem" data-action="reusar" data-index="${idx}"><i class="fa-regular fa-copy"></i></button>
          ${canCancel ? `<button type="button" class="btn btn-danger btn-icon" title="Cancelar campanha" data-action="cancelar" data-index="${idx}"><i class="fa-solid fa-xmark"></i></button>` : ''}
        </div>`;
      tr.innerHTML = [
        tdCell('Campanha', `<div class="hist-msg"><strong>${escapeHTML(preview || '—')}</strong><small>${escapeHTML(total)} contato(s) · intervalo ${escapeHTML(getDelayLabel(item.delay_segundos || 20))}</small></div>`),
        tdCell('Progresso', buildProgressCell(item)),
        tdCell('WhatsApp', `<span class="hist-inst">${escapeHTML(inst)}</span>`),
        tdCell('Criado por', escapeHTML(por)),
        tdCell('Status', `<span class="status-pill ${escapeHTML(statusObj.cls)}">${escapeHTML(statusObj.label)}</span>`),
        tdCell('Criado em', escapeHTML(criado)),
        tdCell('Ações', actions)
      ].join('');
      tbodyHist.appendChild(tr);
    });
    tbodyHist.__items = list;
  }

  function bindHistoricoActions() {
    if (!tbodyHist) return;
    tbodyHist.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const idx = Number(btn.dataset.index);
      const items = Array.isArray(tbodyHist.__items) ? tbodyHist.__items : [];
      const item = items[idx];
      if (!item) return;
      if (btn.dataset.action === 'reusar') reuseHistorico(item);
      if (btn.dataset.action === 'cancelar') cancelarHistorico(item, btn);
    });
  }

  function startAutoRefreshIfNeeded(items) {
    if (autoRefreshTimer) {
      clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
    }

    const hasRunning = Array.isArray(items) && items.some(it => {
      const s = String(it?.status || '').toLowerCase();
      return s === 'pendente' || s === 'processando';
    });

    if (hasRunning) {
      autoRefreshTimer = setTimeout(() => {
        carregarHistorico();
      }, 8000);
    }
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
      if (!res.ok) throw new Error(`Erro HTTP ${res.status}`);
      let data;
      try { data = txt ? JSON.parse(txt) : []; }
      catch { throw new Error('Resposta inválida do servidor.'); }
      const itens = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
      renderHistorico(itens);
      startAutoRefreshIfNeeded(itens);
    } catch (e) {
      console.error('Erro ao carregar histórico', e);
      renderHistorico([], { error: true });
      showToast('Erro ao carregar histórico.', 'error');
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
          selectValue(a.dataset.value, a.dataset.label, a.dataset.connected !== 'false');
        }
      }
    }

    btn.addEventListener('click', toggleMenu);

    const instValue = i => i.instancia_id ?? i.id ?? i.instance_id ?? i.session ?? i.sessionName ?? '';
    const instLabel = (i, v) => i.apelido || i.nome || i.instance_name || String(v) || 'Instância';
    const instConnected = (i) => {
      if (!i || !Object.keys(i).length) return true;
      if (i.connected === false || i.conectado === false || i.is_connected === false) return false;
      const state = String(i.status || i.state || i.connectionStatus || '').toLowerCase();
      if (['close','closed','disconnected','desconectado','offline'].includes(state)) return false;
      return true;
    };

    function makeItem(text, value, selected, connected = true) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'inst-item';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', selected ? 'true' : 'false');
      b.tabIndex = -1;
      b.dataset.value = String(value ?? '');
      b.dataset.label = text;
      b.dataset.connected = connected ? 'true' : 'false';
      b.disabled = !!value && !connected;
      b.innerHTML = `
        <span class="radio" aria-hidden="true"></span>
        <span class="inst-copy"><span>${escapeHTML(text)}</span><small>${value ? (connected ? 'Conectado' : 'Desconectado') : 'Escolha um WhatsApp'}</small></span>
      `;
      b.addEventListener('click', () => selectValue(String(value ?? ''), text, connected));
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

      if (label) label.textContent = text || (value ? `Instância ${value}` : 'Selecione uma instância');
      updateResumo();
    }

    function applyInstancia(value, text, connected = true) {
      window.__INST_ID = value ? Number(String(value).replace(/\D/g, '')) : '';
      window.__INST_NAME = (text || '').trim();
      window.__INST_CONNECTED = value ? connected !== false : undefined;
      setActiveUI(value, text);
      if (typeof window.onInstanciaChange === 'function') window.onInstanciaChange(value, text);
    }

    function selectValue(value, text, connected = true) {
      if (value && connected === false) { showToast('Este WhatsApp está desconectado.', 'error'); return; }
      applyInstancia(value, text, connected);
      closeMenu();
      btn.focus();
      showToast(text ? `Instância selecionada: ${text}` : 'Filtro de instância limpo.', 'success');
    }

    async function loadList() {
      listEl.innerHTML = '';
      listEl.appendChild(makeItem('Selecione uma instância', '', false, true));

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
        const connected = instConnected(i);
        listEl.appendChild(makeItem(t, v, false, connected));
      });

      applyInstancia('', 'Selecione uma instância', true);
    }

    loadList();
  }

  window.onInstanciaChange = function () {
    carregarHistorico();
    updateResumo();
  };

  function init() {
    if (chkIaVariar) {
      chkIaVariar.checked = false;
      chkIaVariar.disabled = true;
      chkIaVariar.title = 'Em breve: variações por número ainda não estão implementadas no backend.';
    }

    const hadDraft = loadDraft();

    msgEl?.addEventListener('input', updateResumo);
    numsEl?.addEventListener('input', updateResumo);
    numsEl?.addEventListener('blur', updateResumo);
    dedupEl?.addEventListener('change', updateResumo);
    delayEl?.addEventListener('change', updateResumo);
    delayEl?.addEventListener('input', updateResumo);

    fileEl?.addEventListener('change', handleFileChange);
    btnDisparar?.addEventListener('click', enviarDisparo);
    btnAtualizarHist?.addEventListener('click', carregarHistorico);

    btnPreencherExemplo?.addEventListener('click', fillExample);
    btnLimparRascunho?.addEventListener('click', clearDraftUI);

    templateButtons.forEach(btn => {
      btn.addEventListener('click', () => useTemplate(btn.dataset.template));
    });

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

    bindHistoricoActions();
    initInstDropdown();
    updateResumo();

    if (hadDraft) {
      showToast('Rascunho restaurado automaticamente.', 'info');
    }

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