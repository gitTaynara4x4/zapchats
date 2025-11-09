// /frontend/js/atendimentos/ui/new-chat.js
// Nova conversa – via proxy backend + bloqueio quando filtro estiver em "Todos"
// Regras:
// - Achou cliente no BD → abre conversa direto. Header usa nome/avatar do BD (se tiver).
// - Achou cliente no BD mas não tem conversa → idem.
// - Não achou cliente → cria com o nome digitado; abre; depois tenta buscar foto no Evolution
//   via backend e só ATUALIZA A FOTO (não mexe no nome).
// - Quando filtro de instância está em "Todos" (sem instância selecionada), bloqueia “+” e submit.

import { EMPRESA_ID } from '../core/env.js';
import { numeroE164 } from '../core/format.js';

(function () {
  // ---------------- helpers ----------------
  const $  = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
  const ensure55 = (d) => (String(d || '').startsWith('55') ? String(d) : '55' + String(d || ''));
  const insert9IfNeeded = (d) => {
    if (!/^55\d{2}\d+$/.test(d)) return d;
    const ddd = d.slice(2, 4), rest = d.slice(4);
    return rest.length === 8 ? `55${ddd}9${rest}` : d;
  };
  const formatTelBR = (d) =>
    String(onlyDigits(d)).replace(/^(\+?55)?(\d{2})(\d{4,5})(\d{4})$/, '+55 ($2) $3-$4');

  // Toast simples
  function toast(msg, ok = true, ms = 2200) {
    let t = $('#__app_toast');
    if (!t) {
      t = document.createElement('div');
      t.id = '__app_toast';
      Object.assign(t.style, {
        position: 'fixed',
        left: '50%',
        bottom: '20px',
        transform: 'translateX(-50%)',
        padding: '8px 12px',
        borderRadius: '10px',
        background: ok ? '#1f2937' : '#7f1d1d',
        color: '#fff',
        fontSize: '13px',
        lineHeight: '1.2',
        boxShadow: '0 10px 30px rgba(0,0,0,.35)',
        zIndex: 99999,
        opacity: '0',
        transition: 'opacity .18s, transform .18s',
        pointerEvents: 'none',
        maxWidth: '92vw',
        textAlign: 'center',
      });
      document.body.appendChild(t);
    }
    t.textContent = String(msg || '');
    t.style.background = ok ? '#1f2937' : '#7f1d1d';
    t.style.opacity = '1';
    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => {
      t.style.opacity = '0';
    }, Math.max(1200, Number(ms) || 2200));
  }

  // Helpers de parsing de erro
  const pick = (o, keys) => keys.map((k) => o && o[k]).find(Boolean);
  function extractMessage(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj)) return extractMessage(obj[0]);
    return (
      pick(obj, ['message', 'msg', 'detail', 'error', 'erro', 'status', 'reason', 'descricao']) ||
      (obj.error && (obj.error.message || obj.error.msg)) ||
      (Array.isArray(obj.detail) && obj.detail[0] && (obj.detail[0].msg || obj.detail[0].message)) ||
      ''
    );
  }

  // ---------------- Checagem de instância selecionada (“Todos” bloqueia) ----------------
  function hasSelectedInstance() {
    const v = (window.INSTANCIA_ATIVA ?? '').toString().trim();
    if (!v) return false;
    const bad = new Set(['todos', 'all', '*', '0', '-', '']);
    return !bad.has(v.toLowerCase());
  }

  // ---------------- Evolution via backend (SEM whatsappNumbers) ----------------
  // Usa /api/evolution/fetchProfile com payload { number, empresa_id, instancia_id|instance }
  async function evoFetchProfileByNumber(numberDigits) {
    if (!hasSelectedInstance()) return null; // em "Todos" nem tenta
    const digits = onlyDigits(numberDigits);
    if (!digits) throw new Error('number vazio');

    const instRaw = (window.INSTANCIA_ATIVA && String(window.INSTANCIA_ATIVA).trim()) || '';
    const body = {
      number: digits,
      empresa_id: Number(window.EMPRESA_ID || 0) || undefined,
      instancia_id: /^\d+$/.test(instRaw) ? Number(instRaw) : undefined,
      instance: /^\d+$/.test(instRaw) ? undefined : instRaw || undefined,
    };

    const r = await fetch('/api/evolution/fetchProfile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    let p = null;
    try {
      p = txt ? JSON.parse(txt) : null;
    } catch {}

    if (!r.ok) {
      const err = new Error(`fetchProfile proxy ${r.status}`);
      err.status = r.status;
      err.body = p || txt;
      throw err;
    }
    return {
      name: String(p?.name || '').trim() || null,
      picture: String(p?.picture || '').trim() || null,
      statusTxt:
        (p?.status && (p.status.status || p.status.text)) ||
        p?.description ||
        null,
      raw: p,
    };
  }

  // ---------------- backend utils ----------------
  async function getClienteDetalhe(id) {
    const r = await fetch(
      `/api/clientes/${id}?empresa_id=${encodeURIComponent(String(EMPRESA_ID))}`,
      { credentials: 'include' }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }

  async function findClienteByTelefone(e164Digits) {
    const qs = new URLSearchParams({
      empresa_id: String(EMPRESA_ID),
      q: e164Digits,
      limit: '5',
      offset: '0',
    });
    const r = await fetch(`/api/clientes?${qs.toString()}`, {
      credentials: 'include',
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = await r.json().catch(() => ({}));
    const items = Array.isArray(list?.items) ? list.items : [];
    const onlyD = (s) => String(s || '').replace(/\D/g, '');
    const without55 = e164Digits.startsWith('55') ? e164Digits.slice(2) : e164Digits;
    return (
      items.find((i) => {
        const tel = onlyD(i?.telefone || '');
        return tel === e164Digits || tel === without55;
      }) || null
    );
  }

  // ---------------- header (sem placeholder) ----------------
  const TITLE_SELS = [
    '#chat-header .title',
    '.chat-title',
    '[data-role="chat-title"]',
    '#chatTitle',
    'header .title',
  ];
  const SUB_SELS = [
    '#chat-header .subtitle',
    '.chat-subtitle',
    '[data-role="chat-subtitle"]',
    '#chatSubtitle',
    'header .subtitle',
  ];
  const AVATAR_SELS = [
    '#chat-header .avatar img',
    '.chat-avatar img',
    'img.avatar',
    'img[alt="avatar"]',
  ];

  function qAny(sels) {
    for (const s of sels) {
      const el = $(s);
      if (el) return el;
    }
    return null;
  }

  function setHeaderFromDB(cliente) {
    const tel = onlyDigits(cliente?.telefone || cliente?.whatsapp || '');
    const name = cliente?.nome || (tel ? formatTelBR(tel) : 'Cliente');

    const titleEl = qAny(TITLE_SELS);
    const subEl = qAny(SUB_SELS);
    const imgEl = qAny(AVATAR_SELS);

    if (titleEl) titleEl.textContent = name;
    if (subEl) subEl.textContent = '';
    if (imgEl && cliente?.avatar_url) {
      imgEl.src = cliente.avatar_url;
      imgEl.removeAttribute('srcset');
    }

    try {
      window.__HEADER_LOCKED_NAME = name;
    } catch {}
  }

  function updateHeaderPicture(url) {
    if (!url) return;
    const imgEl = qAny(AVATAR_SELS);
    if (imgEl) {
      imgEl.src = url;
      imgEl.removeAttribute('srcset');
    }
  }

  // Tenta pegar foto via Evolution (proxy) apenas se faltar avatar_url no BD
  async function tryEvolutionPictureIfMissing(cliente) {
    if (!hasSelectedInstance()) return;
    if (cliente?.avatar_url) return;

    const telRaw = onlyDigits(cliente?.telefone || cliente?.whatsapp || '');
    if (!telRaw) return;

    // tenta com o número "como veio"
    try {
      const prof = await evoFetchProfileByNumber(ensure55(telRaw));
      if (prof?.picture) updateHeaderPicture(prof.picture);
      return;
    } catch {}

    // tenta inserir o 9 se tiver 8 dígitos locais (BR)
    try {
      const d = ensure55(telRaw);
      if (/^55\d{2}\d{8}$/.test(d)) {
        const ddd = d.slice(2, 4);
        const rest = d.slice(4);
        const with9 = `55${ddd}9${rest}`;
        const prof2 = await evoFetchProfileByNumber(with9);
        if (prof2?.picture) updateHeaderPicture(prof2.picture);
      }
    } catch {}
  }

  // ---------------- abrir chat (sem placeholders) ----------------
  function openById(id) {
    id = Number(id);
    if (!Number.isFinite(id)) return false;
    let ok = false;
    try {
      window.__CURRENT_CHAT_ID = id;
    } catch {}

    try {
      if (typeof window.selecionarClienteObj === 'function') {
        window.selecionarClienteObj(id);
        ok = true;
      }
    } catch {}
    try {
      if (typeof window.selecionarClienteId === 'function') {
        window.selecionarClienteId(id);
        ok = true;
      }
    } catch {}
    try {
      document.dispatchEvent(
        new CustomEvent('cliente:selecionar', { detail: { id } })
      );
      ok = true;
    } catch {}
    try {
      document.dispatchEvent(
        new CustomEvent('zc:open_chat', { detail: { id } })
      );
      ok = true;
    } catch {}
    try {
      document.dispatchEvent(
        new CustomEvent('chat:open', { detail: { id } })
      );
      ok = true;
    } catch {}
    try {
      location.hash = `#cliente-${id}`;
      ok = true;
    } catch {}

    getClienteDetalhe(id)
      .then((c) => {
        if (Number(window.__CURRENT_CHAT_ID) !== Number(id)) return;
        setHeaderFromDB(c);
        return tryEvolutionPictureIfMissing(c);
      })
      .catch(() => {});

    return ok;
  }

  // --------- Validações de entrada (erros de cliente) ---------
  function validatePhoneOrExplain(rawDigits) {
    const digits = onlyDigits(String(rawDigits || ''));
    if (!digits) {
      toast(
        'Informe um telefone com DDI+DDD+Número. Ex.: 55 11 9 8888-7777',
        false,
        3200
      );
      return null;
    }

    // Normaliza para E.164 BR
    let e164 = (numeroE164(digits) || digits).replace(/\D/g, '');
    if (!e164.startsWith('55')) e164 = '55' + e164;

    // 55 + DDD (2) + número (8 ou 9)
    if (e164.length < 12) {
      toast(
        'Telefone incompleto. Use DDI(55)+DDD(2)+Número (8 ou 9 dígitos).',
        false,
        3200
      );
      return null;
    }
    if (e164.length > 13) {
      toast(
        'Telefone muito longo. Remova caracteres extras e tente novamente.',
        false,
        3000
      );
      return null;
    }

    const ddd = e164.slice(2, 4);
    if (!/^\d{2}$/.test(ddd) || ddd === '00') {
      toast('DDD inválido. Verifique os 2 dígitos do DDD.', false, 3000);
      return null;
    }
    // se tiver 8 dígitos, depois tentamos adicionar o 9
    return e164;
  }

  function explainCreateError(err) {
    const status = Number(err?.status || 0);
    const b = err?.body;
    const msg = extractMessage(b);

    if (status === 400) {
      toast(
        msg || 'Dados inválidos (nome/telefone). Corrija e tente novamente.',
        false,
        3200
      );
      return;
    }
    if (status === 401) {
      toast('Sessão expirada. Faça login novamente.', false, 2800);
      return;
    }
    if (status === 403) {
      toast('Você não tem permissão para criar contatos.', false, 2800);
      return;
    }
    if (status === 409) {
      toast('Já existe um contato com este telefone.', false, 2800);
      return;
    }
    if (status === 422) {
      toast(
        msg || 'Campos obrigatórios ausentes ou inválidos.',
        false,
        3000
      );
      return;
    }
    if (status === 429) {
      toast(
        'Limite de criação atingido no seu plano. Tente mais tarde ou atualize o plano.',
        false,
        3200
      );
      return;
    }

    toast('Falha ao criar contato. Tente novamente.', false, 2600);
  }

  // ---------------- Drawer "Nova conversa" ----------------
  function buildUI() {
    if ($('#ncBackdrop')) return;
    const back = document.createElement('div');
    back.id = 'ncBackdrop';
    Object.assign(back.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,.35)',
      backdropFilter: 'saturate(140%) blur(2px)',
      opacity: '0',
      pointerEvents: 'none',
      transition: 'opacity .18s',
      zIndex: '60',
    });
    const dr = document.createElement('aside');
    dr.id = 'ncDrawer';
    Object.assign(dr.style, {
      position: 'fixed',
      top: 0,
      right: '-380px',
      width: '360px',
      maxWidth: '95vw',
      height: '100%',
      background: '#111b21',
      color: '#e9edef',
      borderLeft: '1px solid #223038',
      boxShadow: '-20px 0 50px rgba(0,0,0,.35)',
      transition: 'right .22s',
      zIndex: '61',
      display: 'flex',
      flexDirection: 'column',
    });

    dr.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #223038">
        <div style="font-weight:600">Nova conversa</div>
        <button id="ncClose" style="background:transparent;border:0;color:#aebac1;cursor:pointer;padding:6px;border-radius:8px">✕</button>
      </div>
      <div style="padding:8px" id="ncBody">
        <ul style="list-style:none;margin:6px 0;padding:0;display:flex;flex-direction:column;gap:6px">
          <li id="ncNewContact" style="display:flex;gap:12px;align-items:center;padding:10px;border-radius:12px;border:1px solid #223038;background:#0b141a;cursor:pointer">
            <div style="width:38px;height:38px;border-radius:999px;background:#00a884;display:grid;place-items:center;color:#0b141a;font-weight:700">+</div>
            <div>
              <div style="font-weight:600">Novo contato</div>
              <div style="font-size:12px;color:#9aaeb5">Criar contato manualmente</div>
            </div>
          </li>
        </ul>
        <div style="border-top:1px solid #223038;margin:8px 0"></div>
        <div style="padding:8px 10px;color:#9aaeb5;font-size:12px">Dica: pesquise um nome/telefone na barra superior.</div>
      </div>
    `;

    document.body.append(back, dr);
    const close = () => {
      back.style.opacity = '0';
      back.style.pointerEvents = 'none';
      dr.style.right = '-380px';
    };
    const open = () => {
      back.style.opacity = '1';
      back.style.pointerEvents = 'auto';
      dr.style.right = '0';
    };
    $('#ncClose')?.addEventListener('click', close);
    back.addEventListener('click', (e) => {
      if (e.target === back) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    window.__NewChat = {
      open,
      close,
      setBody(html) {
        $('#ncBody').innerHTML = html;
      },
    };
    $('#ncNewContact')?.addEventListener('click', renderNewContactForm);
  }

  function renderNewContactForm() {
    const body = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #223038">
        <div style="font-weight:600">Novo contato</div>
        <button id="ncBack" style="background:transparent;border:0;color:#aebac1;cursor:pointer;padding:6px;border-radius:8px">←</button>
      </div>
      <form id="ncForm" style="display:flex;flex-direction:column;gap:10px;padding:8px">
        <input class="nc-input" id="ncName" placeholder="Nome completo" autocomplete="off"
          style="background:#0b141a;border:1px solid #223038;border-radius:10px;color:#e9edef;padding:10px 12px;outline:none"/>
        <input class="nc-input" id="ncPhone" placeholder="Telefone (DDI+DDD+Número, só dígitos)"
          style="background:#0b141a;border:1px solid #223038;border-radius:10px;color:#e9edef;padding:10px 12px;outline:none"/>
        <div style="display:flex;gap:8px">
          <button class="nc-btn" id="ncSave" type="submit"
            style="background:#00a884;border:0;color:#0b141a;font-weight:700;padding:10px 12px;border-radius:10px;cursor:pointer">
            Salvar contato
          </button>
          <button type="button" id="ncCancel"
            style="background:transparent;border:0;color:#9aaeb5;cursor:pointer">
            Cancelar
          </button>
        </div>
      </form>`;
    window.__NewChat.setBody(body);
    $('#ncCancel')?.addEventListener('click', () => window.__NewChat.close());
    $('#ncBack')?.addEventListener('click', buildRoot);
    $('#ncForm')?.addEventListener('submit', onSaveContact);
    $('#ncName')?.focus();
  }

  function buildRoot() {
    window.__NewChat.close();
    setTimeout(() => window.__NewChat.open(), 10);
    const b = `
      <ul style="list-style:none;margin:6px 0;padding:0;display:flex;flex-direction:column;gap:6px">
        <li id="ncNewContact" style="display:flex;gap:12px;align-items:center;padding:10px;border-radius:12px;border:1px solid #223038;background:#0b141a;cursor:pointer">
          <div style="width:38px;height:38px;border-radius:999px;background:#00a884;display:grid;place-items:center;color:#0b141a;font-weight:700">+</div>
          <div>
            <div style="font-weight:600">Novo contato</div>
            <div style="font-size:12px;color:#9aaeb5">Criar contato manualmente</div>
          </div>
        </li>
      </ul>
      <div style="border-top:1px solid #223038;margin:8px 0"></div>
      <div style="padding:8px 10px;color:#9aaeb5;font-size:12px">Dica: pesquise um nome/telefone na barra superior.</div>`;
    window.__NewChat.setBody(b);
    $('#ncNewContact')?.addEventListener('click', renderNewContactForm);
  }

  // ---------------- criar/abrir contato ----------------
  async function onSaveContact(ev) {
    ev.preventDefault();

    // Bloqueia envio quando em "Todos"/sem instância
    if (!hasSelectedInstance()) {
      toast('Selecione o WhatsApp para enviar mensagens.', false, 3000);
      return;
    }

    const nomeManual = String($('#ncName')?.value || '').trim();
    const raw = onlyDigits($('#ncPhone')?.value || '');

    const e164 = validatePhoneOrExplain(raw);
    if (!e164) return;

    $('#ncSave')?.setAttribute('disabled', 'disabled');

    try {
      // Já existe (qualquer variante)?
      const found1 = await findClienteByTelefone(e164);
      if (found1?.id) {
        window.__NewChat.close();
        setTimeout(() => openById(found1.id), 0);
        return;
      }

      const with9 = insert9IfNeeded(e164);
      if (with9 !== e164) {
        const found2 = await findClienteByTelefone(with9);
        if (found2?.id) {
          window.__NewChat.close();
          setTimeout(() => openById(found2.id), 0);
          return;
        }
      }

      const canonical = with9 || e164;

      // Cria no backend com o NOME DIGITADO (sem esperar Evolution)
      const url = '/api/clientes/novo';
      const rCreate = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Empresa-Id': String(EMPRESA_ID),
        },
        credentials: 'include',
        body: JSON.stringify({
          nome: nomeManual || 'Cliente',
          telefone: canonical,
        }),
      });

      const text = await rCreate.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {}

      if (!rCreate.ok) {
        const err = new Error(`HTTP ${rCreate.status}`);
        err.status = rCreate.status;
        err.body = data || text;
        err.endpoint = url;
        throw err;
      }

      const newId = Number(data?.id) || null;
      if (newId) {
        window.__NewChat.close();
        openById(newId);
        // tenta pegar foto pelo backend (number, não jid)
        try {
          const prof = await evoFetchProfileByNumber(canonical);
          if (prof?.picture) updateHeaderPicture(prof.picture);
        } catch {}
        return;
      }

      toast('Não foi possível criar/abrir o contato.', false, 2600);
    } catch (e) {
      console.error('[new-chat] create failed', e);
      if (e?.status) return explainCreateError(e);
      toast('Falha ao criar contato.', false, 2400);
    } finally {
      $('#ncSave')?.removeAttribute('disabled');
    }
  }

  // ---------------- botão "+" ----------------
  function ensurePlusButtonMounted() {
    const candidates = [
      '#chat-header .actions',
      '.chat-actions',
      '#header-actions',
      '.topbar .actions',
      '#chat-actions',
      '#navbar-actions',
    ];
    let host = null;
    for (const sel of candidates) {
      host = document.querySelector(sel);
      if (host) break;
    }
    if (!host) host = document.querySelector('#chat-header, .topbar, header');
    if (!host) return;

    let btn = document.getElementById('btn-sidemodal-nova-conversa');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btn-sidemodal-nova-conversa';
      btn.type = 'button';
      btn.title = 'Nova conversa';
      btn.setAttribute('aria-label', 'Nova conversa');
      Object.assign(btn.style, {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '32px',
        height: '32px',
        marginLeft: '8px',
        borderRadius: '8px',
        background: 'transparent',
        border: '1px solid #223038',
        color: '#aebac1',
        cursor: 'pointer',
      });
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style="width:18px;height:18px">' +
        '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '</svg>';
      host.appendChild(btn);
    }

    if (!btn.dataset.boundNewChat) {
      btn.dataset.boundNewChat = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!hasSelectedInstance()) {
          toast('Selecione o WhatsApp para enviar mensagens.', false, 2800);
          return;
        }
        try {
          window.__NewChat?.open();
        } catch {}
      });
    }
  }

  function wire() {
    buildUI();
    ensurePlusButtonMounted();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  try {
    new MutationObserver(() => ensurePlusButtonMounted()).observe(document.body, {
      childList: true,
      subtree: true,
    });
  } catch {}
})();
