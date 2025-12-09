// /frontend/js/pages/disparos.js
(function () {
  'use strict';

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const msgEl          = $('#msgDisparo');
  const numsEl         = $('#numsDisparos');
  const dedupEl        = $('#optDedup');
  const resTotalEl     = $('#resTotal');
  const resValidosEl   = $('#resValidos');
  const resInvalidosEl = $('#resInvalidos');
  const btnDisparar    = $('#btnDisparar');
  const statusEl       = $('#statusDisparos');
  const tbodyHist      = $('#tbodyDisparos');
  const emptyHist      = $('#emptyDisparos');
  const topMetaEl      = $('#topMetaDisparos');

  const API_BASE   = '/api/disparos';        // ajuste pro backend
  const API_CREATE = `${API_BASE}/simples`;  // POST para criar disparo
  const API_LIST   = `${API_BASE}?limit=50`; // GET histórico

  const F = (window.ZAuth?.guardFetch || window.ZAuth?.authFetch || fetch);

  // ---------------------------
  // Helpers
  // ---------------------------
  function getEmpresaId () {
    try {
      const raw = localStorage.getItem('empresa_id');
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  function setStatus (text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    if (!text) {
      statusEl.removeAttribute('data-kind');
    } else if (kind) {
      statusEl.dataset.kind = kind;
    }
  }

  // ---------------------------
  // Parse de números
  // ---------------------------
  function parseNumeros () {
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

      const key = digits;
      if (dedupEl && dedupEl.checked) {
        if (seen.has(key)) continue;
        seen.add(key);
      }

      // Regra simples: 10+ dígitos é "válido"
      const isValid = digits.length >= 10;
      const obj = { raw: s, digits };

      if (isValid) valid.push(obj);
      else invalid.push(obj);
    }

    if (resTotalEl)     resTotalEl.textContent     = String(valid.length + invalid.length);
    if (resValidosEl)   resValidosEl.textContent   = String(valid.length);
    if (resInvalidosEl) resInvalidosEl.textContent = String(invalid.length);

    return { valid, invalid };
  }

  function getPayload () {
    const mensagem = (msgEl?.value || '').trim();
    const { valid } = parseNumeros();

    if (!mensagem) {
      alert('Digite a mensagem do disparo.');
      msgEl && msgEl.focus();
      return null;
    }
    if (!valid.length) {
      alert('Informe ao menos um número válido.');
      numsEl && numsEl.focus();
      return null;
    }

    const numeros = valid.map(v => v.raw);

    return {
      mensagem,
      numeros,
      instancia_id: window.__INST_ID || null,
      empresa_id: getEmpresaId() || undefined
    };
  }

  // ---------------------------
  // Envio
  // ---------------------------
  async function enviarDisparo (ev) {
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
      try {
        data = txt ? JSON.parse(txt) : {};
      } catch {
        data = { raw: txt };
      }

      if (!res.ok || data?.ok === false) {
        throw new Error(data?.detail || `Erro HTTP ${res.status}`);
      }

      setStatus('Disparo criado com sucesso.', 'success');
      carregarHistorico();
    } catch (e) {
      console.error(e);
      const msg = e?.message || 'Erro ao enviar disparo.';
      setStatus(msg, 'error');
      alert('Erro ao enviar disparo: ' + msg);
    } finally {
      if (btnDisparar) {
        btnDisparar.disabled = false;
        btnDisparar.classList.remove('loading');
      }
    }
  }

  // ---------------------------
  // Histórico
  // ---------------------------
  function fmtDate (s) {
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

  function renderHistorico (itens) {
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
      const status = (item.status || 'pendente').toString();
      const criado = fmtDate(item.criado_em || item.created_at || item.created);

      tr.innerHTML = `
        <td>${preview || '—'}</td>
        <td style="text-align:center">${qtd}</td>
        <td>${inst}</td>
        <td>${status}</td>
        <td>${criado}</td>
      `;
      tbodyHist.appendChild(tr);
    });
  }

  async function carregarHistorico () {
    if (!tbodyHist) return;

    let url = API_LIST;
    const empresaId = getEmpresaId();
    const params = [];
    if (empresaId) params.push(`empresa_id=${encodeURIComponent(String(empresaId))}`);
    if (window.__INST_ID) params.push(`instancia_id=${encodeURIComponent(String(window.__INST_ID))}`);
    if (params.length) {
      url += (url.includes('?') ? '&' : '?') + params.join('&');
    }

    try {
      const res = await F(url, { credentials: 'include' });
      const txt = await res.text();
      let data;
      try {
        data = txt ? JSON.parse(txt) : {};
      } catch {
        data = { raw: txt };
      }

      const itens = Array.isArray(data?.items) ? data.items
                  : Array.isArray(data)        ? data
                  : [];

      renderHistorico(itens);
    } catch (e) {
      console.error('Erro ao carregar histórico de disparos', e);
      renderHistorico([]);
    }
  }

  // =====================================================
  // Dropdown de instâncias (igual conceito Dashboard/Mídias)
  // =====================================================
  function ensureCSSEscape () {
    if (!window.CSS) window.CSS = {};
    if (typeof window.CSS.escape !== 'function') {
      window.CSS.escape = function (val) {
        return String(val ?? '').replace(/["\\]/g, '\\$&').replace(/\s/g, '\\ ');
      };
    }
  }

  function initInstDropdown () {
    const btn    = $('#instMenuBtn');
    const label  = $('#instMenuLabel');
    const menu   = $('#inst-menu');
    const listEl = $('#instMenuList');

    if (!btn || !menu || !listEl) return;

    ensureCSSEscape();

    const empresaId = getEmpresaId();

    function openMenu () {
      menu.setAttribute('aria-hidden', 'false');
      btn.setAttribute('aria-expanded', 'true');
      const first = listEl.querySelector('.inst-item[aria-selected="true"]') || listEl.querySelector('.inst-item');
      first?.focus();
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('keydown', onKey);
    }

    function closeMenu () {
      menu.setAttribute('aria-hidden', 'true');
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    }

    function toggleMenu () {
      const isHidden = menu.getAttribute('aria-hidden') !== 'false';
      if (isHidden) openMenu();
      else closeMenu();
    }

    function onDocClick (e) {
      if (!menu.contains(e.target) && e.target !== btn) {
        closeMenu();
      }
    }

    function onKey (e) {
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

    const instValue = i =>
      i.instancia_id ?? i.id ?? i.instance_id ?? i.session ?? i.sessionName ?? '';
    const instLabel = (i, v) =>
      i.apelido || i.nome || i.instance_name || String(v) || 'Instância';

    function makeItem (text, value, selected) {
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
        <span>${text}</span>
      `;
      b.addEventListener('click', () => selectValue(String(value ?? ''), text));
      li.appendChild(b);
      return li;
    }

    function setActiveUI (value, text) {
      $$('.inst-item', listEl).forEach(b => {
        b.setAttribute('aria-selected', b.dataset.value === String(value) ? 'true' : 'false');
      });
      const active = listEl.querySelector(
        `.inst-item[data-value="${window.CSS.escape(String(value))}"]`
      );
      if (active) {
        if (!active.id) active.id = 'inst-opt-' + String(value || 'all');
        menu.setAttribute('aria-activedescendant', active.id);
      }
      if (label) {
        label.textContent = text || (value ? `Instância ${value}` : 'Todas as instâncias');
      }
    }

    function applyInstancia (value, text) {
      window.__INST_ID   = value ? Number(String(value).replace(/\D/g, '')) : '';
      window.__INST_NAME = (text || '').trim();
      setActiveUI(value, text);
      if (typeof window.onInstanciaChange === 'function') {
        window.onInstanciaChange(value, text);
      }
    }

    function selectValue (value, text) {
      applyInstancia(value, text);
      closeMenu();
      btn.focus();
    }

    async function loadList () {
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
        } catch {
          // ignora, tenta fallback
        }

        if (!items.length) {
          try {
            const r2 = await F(`/api/instancias/list?empresa_id=${empresaId}`, {
              credentials: 'include'
            });
            if (r2.ok) {
              const j2 = await r2.json();
              items = Array.isArray(j2)
                ? j2
                : (Array.isArray(j2?.instancias) ? j2.instancias : []);
            }
          } catch {
            // ignora
          }
        }
      }

      items.forEach(i => {
        const v = String(instValue(i) ?? '');
        const t = instLabel(i, v);
        listEl.appendChild(makeItem(t, v, false));
      });

      if (window.__INST_ID == null || window.__INST_ID === '') {
        const firstConnected = items.find(
          x => !!(x.connected || x.conectada || x.status === 'CONNECTED')
        );
        const firstAny = items[0];
        const chosen = firstConnected || firstAny;
        window.__INST_ID = chosen
          ? Number(String(instValue(chosen) || '').replace(/\D/g, ''))
          : '';
      }

      if (window.__INST_ID) {
        const val = String(window.__INST_ID);
        const sel = listEl.querySelector(
          `.inst-item[data-value="${window.CSS.escape(val)}"]`
        );
        const text = sel?.dataset?.label || `Instância ${val}`;
        applyInstancia(val, text);
      } else {
        applyInstancia('', 'Todas as instâncias');
      }
    }

    loadList();
  }

  // Toda vez que trocar instância, recarrega histórico
  window.onInstanciaChange = function () {
    carregarHistorico();
  };

  // ---------------------------
  // Init
  // ---------------------------
  function init () {
    if (numsEl) {
      ['input', 'blur'].forEach(ev => numsEl.addEventListener(ev, parseNumeros));
      parseNumeros();
    }
    if (dedupEl) {
      dedupEl.addEventListener('change', parseNumeros);
    }
    if (btnDisparar) {
      btnDisparar.addEventListener('click', enviarDisparo);
    }

    initInstDropdown();

    const doLoad = () => {
      carregarHistorico();
    };

    if (window.Page && typeof window.Page.guarded === 'function') {
      window.Page.guarded(doLoad);
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
