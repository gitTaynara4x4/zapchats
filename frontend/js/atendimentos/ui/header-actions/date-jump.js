// /frontend/js/atendimentos/ui/header-actions/date-jump.js
// Agenda / Ir para uma data da conversa
// - Abre modal com campo de data sem usar seletor nativo do navegador
// - Procura mensagem já renderizada
// - Busca no backend por data
// - Mescla mensagens no cache
// - Renderiza/foca a primeira mensagem encontrada
// - Visual minimalista estilo WhatsApp Web
// - Notificações próprias, discretas e profissionais

(function () {
  'use strict';

  const H = window.ZCHeaderActions;

  if (!H || !H.__coreReady) {
    console.warn('[header-actions][date-jump] core.js precisa ser carregado antes.');
    return;
  }

  if (H.__dateJumpReady) return;
  H.__dateJumpReady = true;

  const REQUIRED = [
    '$',
    '$all',
    'escapeHtml',
    'normalize',
    'sleep',
    'historyEl',
    'instKey',
    'stringifyErr',
    'stripUndefined',
    'injectStyle',
    'resolveCurrentClienteId',
    'getConversationInstancia',
    'getInstanciaAtivaGlobal',
    'getSelectedConversationKey',
    'hasOpenChat',
  ];

  if (!H.require(REQUIRED, 'date-jump')) {
    return;
  }

  const {
    $,
    $all,
    escapeHtml,
    normalize,
    sleep,
    historyEl,
    instKey,
    stringifyErr,
    stripUndefined,
    injectStyle,
    resolveCurrentClienteId,
    getConversationInstancia,
    getInstanciaAtivaGlobal,
    getSelectedConversationKey,
    hasOpenChat,
  } = H;


  const DATE_JUMP_FETCH_TIMEOUT_MS = 9000;
  const DATE_JUMP_LOAD_MORE_TIMEOUT_MS = 4500;
  const DATE_JUMP_RENDER_WAIT_LOOPS = 10;
  const DATE_JUMP_RENDER_WAIT_MS = 80;
  const DATE_JUMP_LOAD_MORE_MAX_PAGES = 2;

  let __dateJumpSerial = 0;
  let __dateJumpAbortController = null;

  function abortActiveDateJump() {
    try {
      if (__dateJumpAbortController) {
        __dateJumpAbortController.abort();
      }
    } catch {}

    __dateJumpAbortController = null;
  }

  function createAbortPack(externalSignal = null, timeoutMs = DATE_JUMP_FETCH_TIMEOUT_MS) {
    if (typeof AbortController === 'undefined') {
      return {
        signal: externalSignal || undefined,
        cleanup() {},
      };
    }

    const controller = new AbortController();
    let done = false;

    const cleanupFns = [];

    function abort() {
      if (done) return;
      done = true;

      try {
        controller.abort();
      } catch {}
    }

    if (externalSignal) {
      if (externalSignal.aborted) {
        abort();
      } else {
        const onAbort = () => abort();
        externalSignal.addEventListener('abort', onAbort, { once:true });
        cleanupFns.push(() => {
          try { externalSignal.removeEventListener('abort', onAbort); } catch {}
        });
      }
    }

    const timer = setTimeout(abort, Number(timeoutMs || DATE_JUMP_FETCH_TIMEOUT_MS));
    cleanupFns.push(() => clearTimeout(timer));

    return {
      signal: controller.signal,
      cleanup() {
        cleanupFns.forEach((fn) => {
          try { fn(); } catch {}
        });
      },
    };
  }

  function isAbortError(err) {
    return Boolean(
      err &&
      (
        err.name === 'AbortError' ||
        String(err.message || '').toLowerCase().includes('abort') ||
        String(err.message || '').toLowerCase().includes('cancel')
      )
    );
  }

  function throwIfDateJumpAborted(signal) {
    if (signal && signal.aborted) {
      throw new Error('Busca cancelada.');
    }
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer = null;

    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message || 'A operação demorou demais.'));
        }, Number(timeoutMs || 4500));
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  function ensureDateJumpStyle() {
    injectStyle('zc-datejump-style', `
      .zc-datejump-backdrop{
        position:fixed;
        inset:0;
        display:none;
        z-index:9998;
        background:rgba(0,0,0,.38);
      }

      .zc-datejump-backdrop.is-open{
        display:block;
      }

      .zc-datejump-modal{
        position:fixed;
        top:72px;
        right:18px;
        width:min(390px,calc(100vw - 32px));
        display:none;
        z-index:9999;
        overflow:hidden;
        border-radius:12px;
        border:1px solid rgba(134,150,160,.18);
        background:#111b21;
        color:#e9edef;
        box-shadow:0 18px 48px rgba(0,0,0,.42);
        font-family:"Segoe UI","Helvetica Neue",Helvetica,"Lucida Grande",Arial,Ubuntu,Cantarell,"Fira Sans",sans-serif;
      }

      .zc-datejump-modal.is-open{
        display:block;
        animation:zcDateJumpIn .14s ease-out;
      }

      @keyframes zcDateJumpIn{
        from{
          opacity:0;
          transform:translateY(-4px);
        }

        to{
          opacity:1;
          transform:translateY(0);
        }
      }

      .zc-datejump-head{
        min-height:58px;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        padding:0 16px;
        border-bottom:1px solid rgba(134,150,160,.16);
        background:#111b21;
      }

      .zc-datejump-title{
        min-width:0;
        display:flex;
        align-items:center;
        gap:10px;
        font-size:15px;
        line-height:1.2;
        font-weight:400;
        color:#e9edef;
      }

      .zc-datejump-title-icon{
        width:24px;
        height:24px;
        flex:0 0 24px;
        display:grid;
        place-items:center;
        color:#aebac1;
        font-size:16px;
      }

      .zc-datejump-title-text{
        min-width:0;
        display:block;
      }

      .zc-datejump-title-text strong{
        display:block;
        font-size:16px;
        line-height:1.25;
        font-weight:400;
        color:#e9edef;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }

      .zc-datejump-title-text small{
        display:none;
      }

      .zc-datejump-close{
        width:34px;
        height:34px;
        flex:0 0 34px;
        border:0;
        border-radius:50%;
        background:transparent;
        color:#aebac1;
        cursor:pointer;
        display:grid;
        place-items:center;
        font-size:16px;
        transition:background .12s ease,color .12s ease;
      }

      .zc-datejump-close:hover{
        background:rgba(134,150,160,.12);
        color:#e9edef;
      }

      .zc-datejump-body{
        display:grid;
        gap:14px;
        padding:18px 16px 16px;
        background:#111b21;
      }

      .zc-datejump-help{
        margin:0;
        font-size:14px;
        line-height:1.45;
        font-weight:400;
        color:#aebac1;
      }

      .zc-datejump-field{
        display:grid;
        gap:7px;
      }

      .zc-datejump-field-label{
        font-size:13px;
        line-height:1.2;
        font-weight:400;
        color:#aebac1;
      }

      .zc-datejump-input-wrap{
        position:relative;
        display:flex;
        align-items:center;
      }

      .zc-datejump-input-icon{
        position:absolute;
        left:13px;
        color:#aebac1;
        pointer-events:none;
        font-size:14px;
      }

      .zc-datejump-input{
        width:100%;
        height:44px;
        border:1px solid transparent;
        border-radius:8px;
        background:#2a3942;
        color:#e9edef;
        padding:0 12px 0 38px;
        outline:none;
        font:inherit;
        font-size:15px;
        font-weight:400;
        color-scheme:dark;
        transition:border-color .12s ease,background .12s ease;
      }

      .zc-datejump-input:hover{
        background:#31434d;
      }

      .zc-datejump-input:focus{
        border-color:#00a884;
        background:#2a3942;
      }

      .zc-datejump-quick{
        display:flex;
        flex-wrap:wrap;
        gap:8px;
      }

      .zc-datejump-chip{
        height:32px;
        border:0;
        border-radius:999px;
        padding:0 12px;
        background:#202c33;
        color:#d1d7db;
        font:inherit;
        font-size:13px;
        font-weight:400;
        cursor:pointer;
        transition:background .12s ease,color .12s ease;
      }

      .zc-datejump-chip:hover{
        background:#2a3942;
        color:#e9edef;
      }

      .zc-datejump-actions{
        display:flex;
        justify-content:flex-end;
        align-items:center;
        gap:8px;
        padding-top:4px;
      }

      .zc-datejump-btn{
        height:38px;
        border:0;
        border-radius:999px;
        padding:0 16px;
        font:inherit;
        font-size:14px;
        font-weight:400;
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:7px;
        transition:background .12s ease,color .12s ease,opacity .12s ease;
      }

      .zc-datejump-btn.secondary{
        background:#202c33;
        color:#d1d7db;
      }

      .zc-datejump-btn.secondary:hover{
        background:#2a3942;
        color:#e9edef;
      }

      .zc-datejump-btn.primary{
        background:#00a884;
        color:#071d18;
      }

      .zc-datejump-btn.primary:hover{
        background:#06cf9c;
      }

      .zc-datejump-btn:disabled{
        opacity:.65;
        cursor:not-allowed;
      }

      .msg-row.date-jump-hit .bubble{
        outline:2px solid rgba(0,168,132,.85);
        box-shadow:0 0 0 4px rgba(0,168,132,.12);
      }

      html[data-theme="light"] .zc-datejump-backdrop{
        background:rgba(17,27,33,.26);
      }

      html[data-theme="light"] .zc-datejump-modal{
        border-color:rgba(17,27,33,.12);
        background:#ffffff;
        color:#111b21;
        box-shadow:0 18px 44px rgba(17,27,33,.16);
      }

      html[data-theme="light"] .zc-datejump-head,
      html[data-theme="light"] .zc-datejump-body{
        background:#ffffff;
      }

      html[data-theme="light"] .zc-datejump-head{
        border-bottom-color:rgba(17,27,33,.10);
      }

      html[data-theme="light"] .zc-datejump-title,
      html[data-theme="light"] .zc-datejump-title-text strong{
        color:#111b21;
      }

      html[data-theme="light"] .zc-datejump-title-icon,
      html[data-theme="light"] .zc-datejump-close,
      html[data-theme="light"] .zc-datejump-help,
      html[data-theme="light"] .zc-datejump-field-label,
      html[data-theme="light"] .zc-datejump-input-icon{
        color:#667781;
      }

      html[data-theme="light"] .zc-datejump-close:hover{
        background:#f0f2f5;
        color:#111b21;
      }

      html[data-theme="light"] .zc-datejump-input{
        background:#f0f2f5;
        color:#111b21;
        color-scheme:light;
      }

      html[data-theme="light"] .zc-datejump-input:hover,
      html[data-theme="light"] .zc-datejump-input:focus{
        background:#f0f2f5;
      }

      html[data-theme="light"] .zc-datejump-chip,
      html[data-theme="light"] .zc-datejump-btn.secondary{
        background:#f0f2f5;
        color:#3b4a54;
      }

      html[data-theme="light"] .zc-datejump-chip:hover,
      html[data-theme="light"] .zc-datejump-btn.secondary:hover{
        background:#e9edef;
        color:#111b21;
      }

      html[data-theme="light"] .zc-datejump-btn.primary{
        background:#00a884;
        color:#ffffff;
      }

      html[data-theme="light"] .zc-datejump-btn.primary:hover{
        background:#008f72;
      }

      @media (max-width:720px){
        .zc-datejump-modal{
          top:auto;
          right:10px;
          left:10px;
          bottom:12px;
          width:auto;
          border-radius:12px;
        }

        .zc-datejump-head{
          min-height:56px;
          padding:0 14px;
        }

        .zc-datejump-body{
          padding:16px 14px 14px;
        }

        .zc-datejump-actions{
          display:grid;
          grid-template-columns:1fr 1fr;
        }

        .zc-datejump-btn{
          width:100%;
        }
      }
    `);
  }

  function ensureDateJumpNotifyStyle() {
    injectStyle('zc-datejump-notify-style', `
      .zc-datejump-toast-host{
        position:fixed;
        right:18px;
        bottom:18px;
        z-index:10060;
        width:min(360px,calc(100vw - 28px));
        display:grid;
        gap:8px;
        pointer-events:none;
        font-family:"Segoe UI","Helvetica Neue",Helvetica,"Lucida Grande",Arial,Ubuntu,Cantarell,"Fira Sans",sans-serif;
      }

      .zc-datejump-toast{
        pointer-events:auto;
        display:grid;
        grid-template-columns:22px minmax(0,1fr) 28px;
        gap:10px;
        align-items:start;
        min-height:58px;
        padding:12px 10px 12px 12px;
        border-radius:10px;
        border:1px solid rgba(134,150,160,.18);
        background:#202c33;
        color:#e9edef;
        box-shadow:0 12px 34px rgba(0,0,0,.34);
        animation:zcDateJumpToastIn .14s ease-out;
      }

      @keyframes zcDateJumpToastIn{
        from{
          opacity:0;
          transform:translateY(6px);
        }

        to{
          opacity:1;
          transform:translateY(0);
        }
      }

      .zc-datejump-toast.is-leaving{
        opacity:0;
        transform:translateY(4px);
        transition:opacity .14s ease,transform .14s ease;
      }

      .zc-datejump-toast-icon{
        width:22px;
        height:22px;
        display:grid;
        place-items:center;
        color:#aebac1;
        font-size:14px;
        margin-top:1px;
      }

      .zc-datejump-toast.ok .zc-datejump-toast-icon{
        color:#00a884;
      }

      .zc-datejump-toast.error .zc-datejump-toast-icon{
        color:#ff6b6b;
      }

      .zc-datejump-toast.info .zc-datejump-toast-icon,
      .zc-datejump-toast.loading .zc-datejump-toast-icon{
        color:#aebac1;
      }

      .zc-datejump-toast-spinner{
        width:15px;
        height:15px;
        border-radius:999px;
        border:2px solid rgba(174,186,193,.28);
        border-top-color:#aebac1;
        animation:zcDateJumpSpin .72s linear infinite;
      }

      @keyframes zcDateJumpSpin{
        to{
          transform:rotate(360deg);
        }
      }

      .zc-datejump-toast-copy{
        min-width:0;
        display:grid;
        gap:3px;
      }

      .zc-datejump-toast-title{
        margin:0;
        color:#e9edef;
        font-size:14px;
        line-height:1.25;
        font-weight:400;
      }

      .zc-datejump-toast-msg{
        margin:0;
        color:#aebac1;
        font-size:13px;
        line-height:1.35;
        font-weight:400;
      }

      .zc-datejump-toast-close{
        width:28px;
        height:28px;
        border:0;
        border-radius:50%;
        background:transparent;
        color:#aebac1;
        cursor:pointer;
        display:grid;
        place-items:center;
        font-size:14px;
      }

      .zc-datejump-toast-close:hover{
        background:rgba(134,150,160,.12);
        color:#e9edef;
      }

      html[data-theme="light"] .zc-datejump-toast{
        border-color:rgba(17,27,33,.10);
        background:#ffffff;
        color:#111b21;
        box-shadow:0 12px 32px rgba(17,27,33,.14);
      }

      html[data-theme="light"] .zc-datejump-toast-title{
        color:#111b21;
      }

      html[data-theme="light"] .zc-datejump-toast-msg,
      html[data-theme="light"] .zc-datejump-toast-icon,
      html[data-theme="light"] .zc-datejump-toast-close{
        color:#667781;
      }

      html[data-theme="light"] .zc-datejump-toast.ok .zc-datejump-toast-icon{
        color:#008f72;
      }

      html[data-theme="light"] .zc-datejump-toast.error .zc-datejump-toast-icon{
        color:#d92d20;
      }

      html[data-theme="light"] .zc-datejump-toast-close:hover{
        background:#f0f2f5;
        color:#111b21;
      }

      @media (max-width:720px){
        .zc-datejump-toast-host{
          right:10px;
          left:10px;
          bottom:12px;
          width:auto;
        }

        .zc-datejump-toast{
          border-radius:10px;
        }
      }
    `);
  }

  function ensureDateJumpDialog() {
    if (document.getElementById('zc-datejump-backdrop')) return;

    ensureDateJumpStyle();

    const backdrop = document.createElement('div');
    backdrop.id = 'zc-datejump-backdrop';
    backdrop.className = 'zc-datejump-backdrop';

    const modal = document.createElement('div');
    modal.id = 'zc-datejump-modal';
    modal.className = 'zc-datejump-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Ir para uma data da conversa');

    modal.innerHTML = `
      <div class="zc-datejump-head">
        <div class="zc-datejump-title">
          <span class="zc-datejump-title-icon">
            <i class="fa-regular fa-calendar-days" aria-hidden="true"></i>
          </span>

          <span class="zc-datejump-title-text">
            <strong>Ir para uma data</strong>
            <small>Encontrar mensagens antigas</small>
          </span>
        </div>

        <button type="button" class="zc-datejump-close" aria-label="Fechar">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <div class="zc-datejump-body">
        <p class="zc-datejump-help">
          Escolha uma data para procurar mensagens desta conversa.
        </p>

        <label class="zc-datejump-field" for="zc-datejump-input">
          <span class="zc-datejump-field-label">Data</span>

          <span class="zc-datejump-input-wrap">
            <i class="fa-regular fa-calendar zc-datejump-input-icon" aria-hidden="true"></i>

            <input
              id="zc-datejump-input"
              class="zc-datejump-input"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              placeholder="dd/mm/aaaa"
              maxlength="10"
              aria-label="Data no formato dia mês ano"
            />
          </span>
        </label>

        <div class="zc-datejump-quick" aria-label="Atalhos de data">
          <button type="button" class="zc-datejump-chip" data-datejump-quick="today">Hoje</button>
          <button type="button" class="zc-datejump-chip" data-datejump-quick="yesterday">Ontem</button>
          <button type="button" class="zc-datejump-chip" data-datejump-quick="seven">7 dias atrás</button>
        </div>

        <div class="zc-datejump-actions">
          <button type="button" class="zc-datejump-btn secondary" id="zc-datejump-cancel">
            Cancelar
          </button>

          <button type="button" class="zc-datejump-btn primary" id="zc-datejump-go">
            <span>Ir para data</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        closeDateJumpDialog();
      }
    });

    modal
      .querySelector('.zc-datejump-close')
      ?.addEventListener('click', closeDateJumpDialog);

    modal
      .querySelector('#zc-datejump-cancel')
      ?.addEventListener('click', closeDateJumpDialog);

    modal
      .querySelectorAll('[data-datejump-quick]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const input = modal.querySelector('#zc-datejump-input');
          if (!input) return;

          const kind = btn.getAttribute('data-datejump-quick');

          if (kind === 'today') {
            setDateJumpInputValue(input, todayISO());
          } else if (kind === 'yesterday') {
            setDateJumpInputValue(input, dateDaysAgoISO(1));
          } else if (kind === 'seven') {
            setDateJumpInputValue(input, dateDaysAgoISO(7));
          }

          input.focus();
        });
      });

    modal
      .querySelector('#zc-datejump-go')
      ?.addEventListener('click', () => {
        const value = modal.querySelector('#zc-datejump-input')?.value || '';
        jumpToConversationDate(value);
      });

    const dateInput = modal.querySelector('#zc-datejump-input');

    dateInput?.addEventListener('input', (e) => {
      const el = e.currentTarget;
      el.value = maskDateInput(el.value);
    });

    dateInput?.addEventListener('blur', (e) => {
      const el = e.currentTarget;
      const iso = isoFromDateLike(el.value || '');

      if (iso) {
        setDateJumpInputValue(el, iso);
      }
    });

    dateInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDateJumpDialog();
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        jumpToConversationDate(e.currentTarget.value || '');
      }
    });
  }

  function ensureDateJumpToastHost() {
    ensureDateJumpNotifyStyle();

    let host = document.getElementById('zc-datejump-toast-host');

    if (!host) {
      host = document.createElement('div');
      host.id = 'zc-datejump-toast-host';
      host.className = 'zc-datejump-toast-host';
      document.body.appendChild(host);
    }

    return host;
  }

  function toastIcon(type, loading) {
    if (loading || type === 'loading') {
      return '<span class="zc-datejump-toast-spinner" aria-hidden="true"></span>';
    }

    if (type === 'ok') {
      return '<i class="fa-solid fa-check" aria-hidden="true"></i>';
    }

    if (type === 'error') {
      return '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>';
    }

    return '<i class="fa-regular fa-circle" aria-hidden="true"></i>';
  }

  function removeDateJumpNotice(el) {
    if (!el) return;

    el.classList.add('is-leaving');

    setTimeout(() => {
      try {
        el.remove();
      } catch {}
    }, 160);
  }

  function notifyDateJump({
    id = 'date-jump-status',
    type = 'info',
    title = '',
    msg = '',
    loading = false,
    timeout = 0,
  } = {}) {
    const host = ensureDateJumpToastHost();

    let el = document.getElementById(`zc-datejump-toast-${id}`);

    if (!el) {
      el = document.createElement('div');
      el.id = `zc-datejump-toast-${id}`;
      host.appendChild(el);
    }

    clearTimeout(el.__zcTimer);

    const safeType = loading ? 'loading' : String(type || 'info');

    el.className = `zc-datejump-toast ${safeType}`;
    el.innerHTML = `
      <div class="zc-datejump-toast-icon">
        ${toastIcon(safeType, loading)}
      </div>

      <div class="zc-datejump-toast-copy">
        <p class="zc-datejump-toast-title">${escapeHtml(title || 'Aviso')}</p>
        ${msg ? `<p class="zc-datejump-toast-msg">${escapeHtml(msg)}</p>` : ''}
      </div>

      <button type="button" class="zc-datejump-toast-close" aria-label="Fechar">
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
    `;

    el.querySelector('.zc-datejump-toast-close')?.addEventListener('click', () => {
      removeDateJumpNotice(el);
    });

    if (timeout) {
      el.__zcTimer = setTimeout(() => {
        removeDateJumpNotice(el);
      }, Math.max(1200, Number(timeout) || 2600));
    }

    return id;
  }

  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');

    return `${y}-${m}-${day}`;
  }

  function dateDaysAgoISO(days) {
    const d = new Date();
    d.setDate(d.getDate() - Number(days || 0));
    return localISODate(d);
  }

  function formatISOToBR(value) {
    const iso = String(value || '').trim();
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (!m) return iso;

    return `${m[3]}/${m[2]}/${m[1]}`;
  }

  function maskDateInput(value) {
    const digits = String(value || '')
      .replace(/\D+/g, '')
      .slice(0, 8);

    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;

    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  }

  function setDateJumpInputValue(input, isoDate) {
    if (!input) return;

    input.value = formatISOToBR(isoDate);
  }

  function setDateJumpScrollLock(active, ttlMs = 6500) {
    try {
      if (active) {
        const until = Date.now() + Number(ttlMs || 6500);

        window.__ZC_DATE_JUMP_ACTIVE = true;
        window.__ZC_DATE_JUMP_ACTIVE_UNTIL = until;
        window.__ZC_SUPPRESS_AUTO_SCROLL_UNTIL = Math.max(
          Number(window.__ZC_SUPPRESS_AUTO_SCROLL_UNTIL || 0),
          until
        );

        clearTimeout(window.__ZC_DATE_JUMP_UNLOCK_TIMER__);
        window.__ZC_DATE_JUMP_UNLOCK_TIMER__ = setTimeout(() => {
          setDateJumpScrollLock(false);
        }, Number(ttlMs || 6500));
      } else {
        window.__ZC_DATE_JUMP_ACTIVE = false;
      }
    } catch {}
  }

  function openDateJumpDialog() {
    ensureDateJumpDialog();

    const backdrop = document.getElementById('zc-datejump-backdrop');
    const modal = document.getElementById('zc-datejump-modal');
    const input = document.getElementById('zc-datejump-input');

    H.state.dateJumpOpen = true;

    backdrop?.classList.add('is-open');
    modal?.classList.add('is-open');

    if (input && !input.value) {
      setDateJumpInputValue(input, todayISO());
    }

    setTimeout(() => {
      input?.focus();
    }, 50);
  }

  function closeDateJumpDialog() {
    const backdrop = document.getElementById('zc-datejump-backdrop');
    const modal = document.getElementById('zc-datejump-modal');

    H.state.dateJumpOpen = false;

    backdrop?.classList.remove('is-open');
    modal?.classList.remove('is-open');
  }

  function localISODate(d) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';

    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');

    return `${y}-${m}-${day}`;
  }

  function isoFromDateLike(value) {
    const raw = String(value || '').trim();

    if (!raw) return '';

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return raw;
    }

    const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);

    if (br) {
      const dd = br[1].padStart(2, '0');
      const mm = br[2].padStart(2, '0');
      let yy = br[3];

      if (yy.length === 2) {
        yy = `20${yy}`;
      }

      return `${yy}-${mm}-${dd}`;
    }

    const n = Number(raw);

    if (Number.isFinite(n) && n > 0) {
      const d = new Date(n > 9999999999 ? n : n * 1000);
      return localISODate(d);
    }

    const parsed = new Date(raw);

    if (!Number.isNaN(parsed.getTime())) {
      return localISODate(parsed);
    }

    return '';
  }

  function dateFromDividerLabel(label) {
    const s = String(label || '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!s) return '';

    const low = normalize(s);

    if (low === 'hoje') {
      return todayISO();
    }

    if (low === 'ontem') {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return localISODate(d);
    }

    return isoFromDateLike(s);
  }

  function getDateLabelForRow(row) {
    let prev = row?.previousElementSibling || null;

    while (prev) {
      if (prev.matches?.('.zc-day-divider')) {
        return prev.textContent.trim();
      }

      if (prev.matches?.('.date-chip')) {
        return prev.textContent.trim();
      }

      prev = prev.previousElementSibling;
    }

    return '';
  }

  function rowDateFromDataset(row) {
    if (!row) return '';

    const bubble = row.querySelector('.bubble');

    const candidates = [
      row.dataset.date,
      row.dataset.data,
      row.dataset.day,
      row.dataset.dia,
      row.dataset.timestamp,
      row.dataset.createdAt,
      row.dataset.created_at,
      row.dataset.datetime,
      row.dataset.time,

      row.getAttribute('data-date'),
      row.getAttribute('data-data'),
      row.getAttribute('data-day'),
      row.getAttribute('data-dia'),
      row.getAttribute('data-timestamp'),
      row.getAttribute('data-created-at'),
      row.getAttribute('data-created_at'),
      row.getAttribute('data-datetime'),
      row.getAttribute('data-time'),

      bubble?.dataset?.date,
      bubble?.dataset?.data,
      bubble?.dataset?.timestamp,
      bubble?.dataset?.createdAt,

      bubble?.getAttribute?.('data-date'),
      bubble?.getAttribute?.('data-timestamp'),
      bubble?.getAttribute?.('data-created-at'),
    ];

    for (const c of candidates) {
      const iso = isoFromDateLike(c);

      if (iso) {
        return iso;
      }
    }

    return '';
  }

  function rowDateFromDivider(row) {
    const label = getDateLabelForRow(row);
    return dateFromDividerLabel(label);
  }

  function rowISODate(row) {
    return rowDateFromDataset(row) || rowDateFromDivider(row);
  }

  function allVisibleMessageRows() {
    const hist = historyEl();

    if (!hist) return [];

    return $all('.msg-row', hist).filter((row) => {
      if (row.getAttribute('data-cluster-hidden') === '1') return false;
      if (!row.querySelector('.bubble')) return false;

      return true;
    });
  }

  function findFirstRowByISODate(isoDate) {
    const wanted = String(isoDate || '').trim();

    if (!wanted) return null;

    return allVisibleMessageRows().find((row) => {
      return rowISODate(row) === wanted;
    }) || null;
  }

  function messageISODateFromCacheItem(item) {
    if (!item || typeof item !== 'object') return '';

    const candidates = [
      item.date,
      item.data_dia,
      item.dia,
      item.day,
      item.created_at,
      item.createdAt,
      item.timestamp,
      item.datetime,
      item.time,
      item.ts,
      item.messageTimestamp,
      item.message_timestamp,
    ];

    for (const c of candidates) {
      const iso = isoFromDateLike(c);

      if (iso) {
        return iso;
      }
    }

    return '';
  }

  function getCachedHistoryCandidates(params = getCurrentDateJumpParams()) {
    const convKey =
      params.conversationKey ||
      getSelectedConversationKey() ||
      historyEl()?.dataset?.conversationKey ||
      historyEl()?.dataset?.conversationId ||
      null;

    const inst =
      params.instanciaId ||
      getConversationInstancia() ||
      getInstanciaAtivaGlobal() ||
      null;

    const out = [];
    const seenArrays = new Set();

    function pushArray(arr) {
      if (!Array.isArray(arr)) return;
      if (seenArrays.has(arr)) return;
      seenArrays.add(arr);
      out.push(...arr);
    }

    try {
      pushArray(window.getHist?.(inst, convKey));
    } catch {}

    try {
      pushArray(window.cacheHistoricos?.[convKey]);
    } catch {}

    try {
      pushArray(window.__ZC_HIST_CACHE__?.[convKey]);
    } catch {}

    try {
      pushArray(window.ZC_HIST_CACHE?.[convKey]);
    } catch {}

    try {
      const byInst = window.cacheHistoricosPorInstancia?.[inst];
      pushArray(byInst?.[convKey]);
    } catch {}

    try {
      const hist = historyEl();
      const raw =
        hist?.dataset?.messages ||
        hist?.dataset?.mensagens ||
        '';

      if (raw && raw.length < 2000000) {
        const parsed = JSON.parse(raw);
        pushArray(parsed);
      }
    } catch {}

    const map = new Map();

    for (const item of out) {
      if (!item || typeof item !== 'object') continue;

      const key = String(
        item?.msg_id ??
        item?.message_id ??
        item?.wa_msg_id ??
        item?.id ??
        `${item?.timestamp || item?.created_at || item?.data || item?.ts || ''}:${item?.conteudo || item?.texto || item?.mensagem || ''}`
      );

      if (!key) continue;
      map.set(key, item);
    }

    return Array.from(map.values());
  }

  function findMessagesByISODateInCache(isoDate) {
    const wanted = String(isoDate || '').trim();

    if (!wanted) return [];

    const params = getCurrentDateJumpParams();
    const convKey = params.conversationKey || getSelectedConversationKey() || null;
    const all = getCachedHistoryCandidates(params);

    const matched = all.filter((item) => {
      const itemConvKey = item?.conversation_key || item?.conversation_id || convKey || null;

      if (convKey && itemConvKey && String(itemConvKey) !== String(convKey)) {
        return false;
      }

      return messageISODateFromCacheItem(item) === wanted;
    });

    return sortMessagesByTime(matched);
  }

  async function tryCacheDateJump(isoDate) {
    const cached = findMessagesByISODateInCache(isoDate);

    if (!cached.length) {
      return false;
    }

    return focusBackendDateMessages(cached, isoDate);
  }

  function focusDateRow(row) {
    if (!row) return;

    setDateJumpScrollLock(true, 7000);

    allVisibleMessageRows().forEach((r) => {
      r.classList.remove('date-jump-hit');
    });

    row.classList.add('date-jump-hit');

    try {
      row.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    } catch {
      row.scrollIntoView();
    }

    setTimeout(() => {
      try {
        row.scrollIntoView({
          behavior: 'auto',
          block: 'center',
        });
      } catch {}
    }, 320);

    setTimeout(() => {
      row.classList.remove('date-jump-hit');
    }, 2600);
  }

  function getCurrentDateJumpParams() {
    const hist = historyEl();
    const sel = window.state?.clienteSel || window.clienteSel || null;
    const clienteId = resolveCurrentClienteId();

    const inst =
      instKey(hist?.dataset?.instanciaId) ||
      instKey(hist?.getAttribute?.('data-instancia-id')) ||
      instKey(sel?.instancia_id) ||
      instKey(sel?.instancia) ||
      instKey(sel?.instance_name) ||
      getConversationInstancia() ||
      getInstanciaAtivaGlobal() ||
      null;

    return {
      empresaId: H.EMPRESA_ID || Number(localStorage.getItem('empresa_id') || 0),
      clienteId,
      instanciaId: inst,
      conversationKey: getSelectedConversationKey(),
    };
  }

  async function fetchMessagesByDateFromBackend(isoDate, options = {}) {
    const params = getCurrentDateJumpParams();

    if (!params.empresaId || !params.clienteId) {
      throw new Error('Conversa atual inválida para buscar por data.');
    }

    const qs = new URLSearchParams();

    qs.set('empresa_id', String(params.empresaId));
    qs.set('data', String(isoDate));
    qs.set('limit', '300');

    if (params.instanciaId) {
      const n = Number(params.instanciaId);

      if (Number.isFinite(n) && String(n) === String(params.instanciaId)) {
        qs.set('instancia_id', String(n));
      } else {
        qs.set('instance', String(params.instanciaId));
      }
    }

    const url =
      `/api/atendimento/conversas/${encodeURIComponent(params.clienteId)}/mensagens/por-data?${qs.toString()}`;

    const abortPack = createAbortPack(options.signal || null, options.timeoutMs || DATE_JUMP_FETCH_TIMEOUT_MS);

    let r;

    try {
      r = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        signal: abortPack.signal,
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error('A busca demorou demais ou foi cancelada. Tente outra data.');
      }

      throw err;
    } finally {
      abortPack.cleanup();
    }

    const txt = await r.text().catch(() => '');

    let json = null;

    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {}

    if (!r.ok) {
      const msg =
        stringifyErr(json?.detail || json?.message || json?.error || txt) ||
        `HTTP ${r.status}`;

      throw new Error(msg);
    }

    return json || {};
  }

  function normalizeBackendDateMessage(item, fallbackConvKey = null) {
    if (!item || typeof item !== 'object') return null;

    const id =
      item.id ??
      item.msg_id ??
      item.message_id ??
      item.wa_msg_id ??
      null;

    const msgId =
      item.msg_id ??
      item.message_id ??
      item.wa_msg_id ??
      item.id ??
      null;

    const tsRaw =
      item.timestamp ??
      item.created_at ??
      item.data ??
      item.ts ??
      null;

    const tsMs = (() => {
      const n = Number(tsRaw);

      if (Number.isFinite(n) && n > 0) {
        return n > 9999999999 ? n : n * 1000;
      }

      const p = Date.parse(String(tsRaw || ''));

      return Number.isFinite(p) ? p : 0;
    })();

    const convKey =
      item.conversation_key ||
      item.conversation_id ||
      fallbackConvKey ||
      getSelectedConversationKey() ||
      null;

    const texto =
      item.texto ??
      item.mensagem ??
      item.conteudo ??
      item.body ??
      item.caption ??
      '';

    const fromMe =
      item.from_me === true ||
      item.origem === 'atendente' ||
      item.tipo === 'saida';

    return stripUndefined({
      ...item,

      id,
      msg_id: msgId,
      message_id: msgId,
      wa_msg_id: msgId,

      conversation_key: convKey,
      conversation_id: convKey,

      conteudo: texto,
      texto,
      mensagem: texto,

      timestamp: tsRaw,
      created_at: tsRaw,
      data: tsRaw,
      ts: tsMs,

      from_me: fromMe,
      origem: fromMe ? 'atendente' : 'cliente',
      tipo: item.tipo || (fromMe ? 'saida' : 'entrada'),
    });
  }

  function sortMessagesByTime(arr) {
    return (Array.isArray(arr) ? arr.slice() : []).sort((a, b) => {
      const ta =
        Number(a?.ts || 0) ||
        Date.parse(a?.timestamp || a?.created_at || a?.data || '') ||
        0;

      const tb =
        Number(b?.ts || 0) ||
        Date.parse(b?.timestamp || b?.created_at || b?.data || '') ||
        0;

      if (ta !== tb) {
        return ta - tb;
      }

      return String(a?.id ?? a?.msg_id ?? '').localeCompare(
        String(b?.id ?? b?.msg_id ?? ''),
        'pt-BR',
        { numeric: true }
      );
    });
  }

  function mergeDateMessagesIntoCache(messages, convKey, inst) {
    const normalized = (Array.isArray(messages) ? messages : [])
      .map((m) => normalizeBackendDateMessage(m, convKey))
      .filter(Boolean);

    if (!normalized.length || !convKey) {
      return normalized;
    }

    let current = [];

    try {
      const arr = window.getHist?.(inst, convKey);

      if (Array.isArray(arr)) {
        current = arr.slice();
      }
    } catch {}

    if (!current.length) {
      try {
        const arr = window.cacheHistoricos?.[convKey];

        if (Array.isArray(arr)) {
          current = arr.slice();
        }
      } catch {}
    }

    const map = new Map();

    [...current, ...normalized].forEach((m) => {
      const key = String(
        m?.msg_id ??
        m?.message_id ??
        m?.wa_msg_id ??
        m?.id ??
        `${m?.timestamp || ''}:${m?.conteudo || ''}`
      );

      if (!key) return;

      map.set(key, m);
    });

    const merged = sortMessagesByTime(Array.from(map.values()));

    try {
      if (typeof window.primeWith === 'function') {
        window.primeWith(inst, convKey, merged, null);
      }
    } catch {}

    try {
      window.cacheHistoricos = window.cacheHistoricos || {};
      window.cacheHistoricos[convKey] = merged;
    } catch {}

    try {
      window.salvarCache?.();
    } catch {}

    return normalized;
  }

  function renderHistoryFromCache(convKey) {
    setDateJumpScrollLock(true, 7000);

    try {
      if (typeof window.renderHistoricoDoCache === 'function') {
        window.renderHistoricoDoCache(convKey, false);
        return true;
      }
    } catch (err) {
      console.warn('[header-actions][date-jump] renderHistoricoDoCache falhou', err);
    }

    try {
      if (typeof window.carregarHistoricoCliente === 'function') {
        window.carregarHistoricoCliente(convKey, {
          force: true,
          reload: true,
          reason: 'date-jump',
          keep_open: true,
          preserveScroll: true,
        });

        return true;
      }
    } catch (err) {
      console.warn('[header-actions][date-jump] carregarHistoricoCliente falhou', err);
    }

    return false;
  }

  function findBubbleByMsgId(msgId) {
    const id = String(msgId || '').trim();

    if (!id) return null;

    const hist = historyEl();

    if (!hist) return null;

    try {
      return hist.querySelector(
        `.msg-row[data-msg-id="${CSS.escape(id)}"] .bubble`
      ) || null;
    } catch {}

    const rows = $all('.msg-row', hist);

    for (const row of rows) {
      const rowId =
        row.getAttribute('data-msg-id') ||
        row.querySelector('.bubble')?.getAttribute('data-msg-id') ||
        row.getAttribute('data-id') ||
        '';

      if (String(rowId) === id) {
        return row.querySelector('.bubble') || null;
      }
    }

    return null;
  }

  async function focusBackendDateMessages(items, isoDate) {
    const arr = Array.isArray(items) ? items : [];

    if (!arr.length) return false;

    const params = getCurrentDateJumpParams();

    const convKey =
      params.conversationKey ||
      arr[0]?.conversation_key ||
      arr[0]?.conversation_id ||
      getSelectedConversationKey();

    const inst =
      params.instanciaId ||
      arr[0]?.instancia_id ||
      arr[0]?.instance_name ||
      null;

    const normalized = mergeDateMessagesIntoCache(arr, convKey, inst);

    renderHistoryFromCache(convKey);

    for (let i = 0; i < DATE_JUMP_RENDER_WAIT_LOOPS; i++) {
      await sleep(DATE_JUMP_RENDER_WAIT_MS);

      for (const msg of normalized) {
        const mid = String(
          msg?.msg_id ??
          msg?.message_id ??
          msg?.wa_msg_id ??
          msg?.id ??
          ''
        ).trim();

        const bubble = findBubbleByMsgId(mid);

        if (bubble) {
          const row = bubble.closest('.msg-row') || bubble;
          focusDateRow(row);
          return true;
        }
      }

      const row = findFirstRowByISODate(isoDate);

      if (row) {
        focusDateRow(row);
        return true;
      }
    }

    return false;
  }

  async function tryBackendDateJump(isoDate, options = {}) {
    const data = await fetchMessagesByDateFromBackend(isoDate, options);

    const items = Array.isArray(data?.items)
      ? data.items
      : (
          Array.isArray(data?.mensagens)
            ? data.mensagens
            : []
        );

    if (!items.length) {
      return false;
    }

    return focusBackendDateMessages(items, isoDate);
  }

  async function tryLoadMoreUntilDate(isoDate, maxPages = DATE_JUMP_LOAD_MORE_MAX_PAGES, options = {}) {
    const cid = resolveCurrentClienteId();
    const signal = options.signal || null;
    const pages = Math.max(0, Math.min(Number(maxPages || 0), DATE_JUMP_LOAD_MORE_MAX_PAGES));

    if (!pages || !cid || typeof window.carregarMaisHistorico !== 'function') {
      return false;
    }

    for (let i = 0; i < pages; i++) {
      throwIfDateJumpAborted(signal);

      let loaded = false;

      try {
        loaded = await withTimeout(
          window.carregarMaisHistorico(cid),
          DATE_JUMP_LOAD_MORE_TIMEOUT_MS,
          'Carregar mensagens antigas demorou demais.'
        );
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }

        console.warn('[header-actions][date-jump] carregarMaisHistorico falhou', err);
        loaded = false;
      }

      throwIfDateJumpAborted(signal);

      if (!loaded) {
        return false;
      }

      const row = findFirstRowByISODate(isoDate);

      if (row) {
        focusDateRow(row);
        return true;
      }

      await sleep(80);
    }

    return false;
  }

  async function jumpToConversationDate(rawDate) {
    const isoDate = isoFromDateLike(rawDate);

    if (!isoDate) {
      notifyDateJump({
        id: 'date-jump-status',
        type: 'error',
        title: 'Data inválida',
        msg: 'Escolha uma data válida para procurar na conversa.',
        timeout: 3600,
      });

      return;
    }

    if (!hasOpenChat()) {
      notifyDateJump({
        id: 'date-jump-status',
        type: 'error',
        title: 'Selecione uma conversa',
        msg: 'Abra uma conversa antes de procurar por data.',
        timeout: 3600,
      });

      return;
    }

    /*
      Antes essa função simplesmente dava return quando H.state.dateJumping era true.
      Resultado: se uma busca demorasse, o modal parecia travado e você não conseguia
      escolher outra data. Agora uma nova tentativa cancela a anterior.
    */
    if (H.state.dateJumping) {
      abortActiveDateJump();
      H.state.dateJumping = false;
    }

    const goBtn = document.getElementById('zc-datejump-go');
    const mySerial = ++__dateJumpSerial;

    let controller = null;

    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      __dateJumpAbortController = controller;
    }

    try {
      H.state.dateJumping = true;

      if (goBtn) {
        goBtn.disabled = true;
        goBtn.innerHTML = '<span>Procurando...</span>';
      }

      let row = findFirstRowByISODate(isoDate);

      if (row) {
        focusDateRow(row);
        closeDateJumpDialog();

        notifyDateJump({
          id: 'date-jump-status',
          type: 'ok',
          title: 'Mensagem encontrada',
          msg: 'Levei você até a primeira mensagem desta data.',
          timeout: 2600,
        });

        return;
      }

      notifyDateJump({
        id: 'date-jump-status',
        type: 'loading',
        title: 'Verificando cache',
        msg: 'Vou procurar primeiro nas mensagens já salvas desta conversa.',
        loading: true,
      });

      let found = false;
      let backendError = null;

      try {
        found = await tryCacheDateJump(isoDate);
      } catch (err) {
        console.warn('[header-actions][date-jump] busca por data no cache falhou', err);
        found = false;
      }

      if (mySerial !== __dateJumpSerial) return;
      throwIfDateJumpAborted(controller?.signal || null);

      if (found) {
        closeDateJumpDialog();

        notifyDateJump({
          id: 'date-jump-status',
          type: 'ok',
          title: 'Mensagem encontrada no cache',
          msg: 'Não precisei buscar novamente no banco.',
          timeout: 2800,
        });

        return;
      }

      notifyDateJump({
        id: 'date-jump-status',
        type: 'loading',
        title: 'Buscando no histórico',
        msg: 'Não achei no cache. Agora vou consultar o banco.',
        loading: true,
      });

      try {
        found = await tryBackendDateJump(isoDate, {
          signal: controller?.signal || null,
          timeoutMs: DATE_JUMP_FETCH_TIMEOUT_MS,
        });
      } catch (err) {
        backendError = err;
        console.warn('[header-actions][date-jump] busca por data no backend falhou', err);
      }

      if (mySerial !== __dateJumpSerial) return;
      throwIfDateJumpAborted(controller?.signal || null);

      if (found) {
        closeDateJumpDialog();

        notifyDateJump({
          id: 'date-jump-status',
          type: 'ok',
          title: 'Mensagem encontrada',
          msg: 'Levei você até a primeira mensagem desta data.',
          timeout: 2600,
        });

        return;
      }

      if (DATE_JUMP_LOAD_MORE_MAX_PAGES > 0) {
        notifyDateJump({
          id: 'date-jump-status',
          type: 'loading',
          title: 'Buscando um pouco mais',
          msg: 'Vou tentar carregar poucas mensagens antigas, sem travar a tela.',
          loading: true,
        });

        try {
          found = await tryLoadMoreUntilDate(isoDate, DATE_JUMP_LOAD_MORE_MAX_PAGES, {
            signal: controller?.signal || null,
          });
        } catch (err) {
          backendError = backendError || err;
          console.warn('[header-actions][date-jump] fallback de páginas antigas falhou', err);
          found = false;
        }
      }

      if (mySerial !== __dateJumpSerial) return;
      throwIfDateJumpAborted(controller?.signal || null);

      if (found) {
        closeDateJumpDialog();

        notifyDateJump({
          id: 'date-jump-status',
          type: 'ok',
          title: 'Mensagem encontrada',
          msg: 'Levei você até a primeira mensagem desta data.',
          timeout: 2600,
        });

        return;
      }

      notifyDateJump({
        id: 'date-jump-status',
        type: 'error',
        title: 'Data não encontrada',
        msg: backendError?.message || 'Não encontrei mensagens nesta conversa para a data selecionada.',
        timeout: 5200,
      });
    } catch (err) {
      if (!isAbortError(err) && String(err?.message || '') !== 'Busca cancelada.') {
        notifyDateJump({
          id: 'date-jump-status',
          type: 'error',
          title: 'Não consegui buscar a data',
          msg: err?.message || 'Tente novamente em alguns segundos.',
          timeout: 5200,
        });
      }
    } finally {
      if (mySerial === __dateJumpSerial) {
        H.state.dateJumping = false;

        if (__dateJumpAbortController === controller) {
          __dateJumpAbortController = null;
        }

        if (goBtn) {
          goBtn.disabled = false;
          goBtn.innerHTML = '<span>Ir para data</span>';
        }
      }
    }
  }

  H.extend({
    ensureDateJumpStyle,
    ensureDateJumpNotifyStyle,
    ensureDateJumpDialog,
    abortActiveDateJump,

    ensureDateJumpToastHost,
    notifyDateJump,
    removeDateJumpNotice,

    todayISO,
    dateDaysAgoISO,
    formatISOToBR,
    maskDateInput,
    setDateJumpInputValue,
    setDateJumpScrollLock,
    openDateJumpDialog,
    closeDateJumpDialog,

    localISODate,
    isoFromDateLike,
    dateFromDividerLabel,

    getDateLabelForRow,
    rowDateFromDataset,
    rowDateFromDivider,
    rowISODate,
    allVisibleMessageRows,
    findFirstRowByISODate,
    messageISODateFromCacheItem,
    getCachedHistoryCandidates,
    findMessagesByISODateInCache,
    tryCacheDateJump,
    focusDateRow,

    getCurrentDateJumpParams,
    fetchMessagesByDateFromBackend,
    normalizeBackendDateMessage,
    sortMessagesByTime,
    mergeDateMessagesIntoCache,
    renderHistoryFromCache,
    findBubbleByMsgId,

    focusBackendDateMessages,
    tryBackendDateJump,
    tryLoadMoreUntilDate,
    jumpToConversationDate,
  });

  console.log('[header-actions] date-jump carregado');
})();