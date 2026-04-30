// /frontend/js/atendimentos/ui/context-menu.js
// Menu de contexto: Etiquetar, Fixar/Desafixar, Apagar.
// Fixar agora é por usuário + instância:
// empresa_id + user_id + conversa_id + instancia_id
// ✅ SEM injetar CSS. O visual fica no atendimentos.css.

(function () {
  if (window.__ATD_CTXMENU_INIT__) return;
  window.__ATD_CTXMENU_INIT__ = true;

  const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);
  if (!EMPRESA_ID) return;

  let CAN_DELETE_CONVERSA = false;

  const authFetch = (url, opt = {}) => {
    const f = (window.ZAuth && ZAuth.authFetch) ? ZAuth.authFetch : fetch;
    const headers = Object.assign(
      { Accept: 'application/json', 'Content-Type': 'application/json' },
      opt.headers || {}
    );

    const t = localStorage.getItem('token');
    if (t && !headers.Authorization) headers.Authorization = `Bearer ${t}`;

    return f(url, {
      credentials: 'include',
      ...opt,
      headers
    });
  };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  }

  function ensureToastHost() {
    if (document.getElementById('zcToastHost')) return;

    const host = document.createElement('div');
    host.id = 'zcToastHost';
    document.body.appendChild(host);
  }

  function notify({ title = 'Pronto', msg = '', type = 'ok', timeout = 2800 } = {}) {
    if (typeof window.toast === 'function') {
      try {
        window.toast({ title, msg, type, timeout });
        return;
      } catch {}

      try {
        window.toast(msg || title, type !== 'error');
        return;
      } catch {}
    }

    ensureToastHost();

    const el = document.createElement('div');
    el.className = `zcToast ${type}`;
    el.innerHTML = `<strong>${escapeHtml(title)}</strong>${msg ? `<div class="m">${escapeHtml(msg)}</div>` : ''}`;

    document.getElementById('zcToastHost').appendChild(el);

    requestAnimationFrame(() => el.classList.add('on'));

    setTimeout(() => el.classList.remove('on'), timeout);
    setTimeout(() => el.remove(), timeout + 320);
  }

  function readErrorText(res) {
    return res.text()
      .then((txt) => {
        try {
          const j = JSON.parse(txt);
          return j.detail || j.message || txt;
        } catch {
          return txt;
        }
      })
      .catch(() => '');
  }

  function confirmDialog({
    title = 'Confirmação',
    msg = '',
    okText = 'OK',
    cancelText = 'Cancelar',
    destructive = false
  } = {}) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'zcConfirmBackdrop';

      wrap.innerHTML = `
        <div class="zcConfirm" role="dialog" aria-modal="true">
          <div class="zcConfirm-title">${escapeHtml(title)}</div>
          <div class="zcConfirm-body">${escapeHtml(msg)}</div>
          <div class="zcConfirm-footer">
            <button class="zcConfirm-btn ghost" type="button">${escapeHtml(cancelText)}</button>
            <button class="zcConfirm-btn ${destructive ? 'danger' : 'primary'}" type="button">${escapeHtml(okText)}</button>
          </div>
        </div>
      `;

      document.body.appendChild(wrap);

      const btns = wrap.querySelectorAll('.zcConfirm-btn');
      const btnCancel = btns[0];
      const btnOk = btns[1];

      const close = (v) => {
        window.removeEventListener('keydown', onKey, true);
        wrap.remove();
        resolve(v);
      };

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          close(false);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          close(true);
        }
      }

      window.addEventListener('keydown', onKey, true);

      btnCancel.onclick = () => close(false);
      btnOk.onclick = () => close(true);

      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) close(false);
      });

      try {
        btnOk.focus();
      } catch {}
    });
  }

  function deleteChoiceDialog() {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'zcConfirmBackdrop';

      wrap.innerHTML = `
        <div class="zcConfirm" role="dialog" aria-modal="true">
          <div class="zcConfirm-title">Apagar conversa</div>
          <div class="zcConfirm-body">
O que você deseja fazer com esta conversa?

• Apagar apenas da lista: a conversa some da lista, mas o cliente e o histórico continuam no sistema.
• Apagar permanentemente: remove o cliente e TODO o histórico desta conversa do sistema.
          </div>
          <div class="zcConfirm-footer">
            <button class="zcConfirm-btn ghost" type="button" data-val="cancel">Cancelar</button>
            <button class="zcConfirm-btn" type="button" data-val="lista">Apagar só da lista</button>
            <button class="zcConfirm-btn danger" type="button" data-val="permanente">Apagar permanentemente</button>
          </div>
        </div>
      `;

      document.body.appendChild(wrap);

      const [btnCancel, btnLista, btnPerma] = wrap.querySelectorAll('.zcConfirm-btn');

      const close = (val) => {
        window.removeEventListener('keydown', onKey, true);
        wrap.remove();
        resolve(val);
      };

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          close(null);
        }
      }

      window.addEventListener('keydown', onKey, true);

      btnCancel.onclick = () => close(null);
      btnLista.onclick = () => close('lista');
      btnPerma.onclick = () => close('permanente');

      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) close(null);
      });

      try {
        btnLista.focus();
      } catch {}
    });
  }

  function defaultPalette() {
    return [
      { name: 'Cinza', hex: '#6b7280' },
      { name: 'Azul', hex: '#3b82f6' },
      { name: 'Ciano', hex: '#06b6d4' },
      { name: 'Verde', hex: '#10b981' },
      { name: 'Lima', hex: '#84cc16' },
      { name: 'Amarelo', hex: '#eab308' },
      { name: 'Laranja', hex: '#f59e0b' },
      { name: 'Vermelho', hex: '#ef4444' },
      { name: 'Rosa', hex: '#ec4899' },
      { name: 'Roxo', hex: '#8b5cf6' }
    ];
  }

  function labelDialog({
    title = 'Etiquetar conversa',
    placeholder = 'Ex.: VIP, Financeiro, Suporte',
    submitText = 'Aplicar',
    cancelText = 'Cancelar',
    value = '',
    help = 'Clique no gradiente para abrir o seletor avançado.',
    maxLength = 48,
    palette = defaultPalette()
  } = {}) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'zcDlgBackdrop';

      const chips = palette.map((p) => `
        <label class="chip" data-color="${p.hex}" title="${escapeHtml(p.name)}">
          <input type="radio" name="lblcolor" value="${p.hex}">
          <span class="swatch" style="--c:${p.hex}"></span>
        </label>
      `).join('');

      wrap.innerHTML = `
        <div class="zcDlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
          <div class="h" id="dlg-title">${escapeHtml(title)}</div>

          <div class="b">
            <label class="fld">
              <span class="lbl">Nome da etiqueta</span>
              <input
                type="text"
                class="in"
                placeholder="${escapeHtml(placeholder)}"
                maxlength="${Number(maxLength) || 48}"
                value="${escapeHtml(value)}"
                autocomplete="off"
                spellcheck="false"
              />
              ${help ? `<small class="hint">${escapeHtml(help)}</small>` : ''}
            </label>

            <div class="fld">
              <span class="lbl">Cor</span>

              <div class="chipgrid">
                <label class="chip custom" data-color="" title="Selecionar qualquer cor">
                  <input type="radio" name="lblcolor" value="">
                  <span class="swatch swatch-custom" aria-label="Abrir seletor">✦</span>
                </label>

                <label class="chip none selected" data-color="">
                  <input type="radio" name="lblcolor" value="">
                  <span class="swatch swatch-none" title="Sem cor">–</span>
                </label>

                ${chips}
              </div>
            </div>
          </div>

          <div class="f">
            <button class="btn ghost" type="button">${escapeHtml(cancelText)}</button>
            <button class="btn primary" type="button" disabled>${escapeHtml(submitText)}</button>
          </div>

          <div class="color-popover" hidden>
            <div class="cp-head">
              <span>Cor personalizada</span>
              <button class="cp-close" type="button" aria-label="Fechar">×</button>
            </div>

            <div class="cp-body">
              <div class="cp-sv"><div class="cp-sv-cursor"></div></div>
              <input class="cp-hue" type="range" min="0" max="360" value="210"/>

              <div class="cp-row">
                <div class="cp-preview"></div>
                <input class="cp-hex" type="text" value="#3b82f6" maxlength="7" spellcheck="false">
                <button class="cp-use" type="button">Usar cor</button>
              </div>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(wrap);

      requestAnimationFrame(() => {
        const dlg = wrap.querySelector('.zcDlg');
        if (dlg) dlg.classList.add('show');
      });

      const dlg = wrap.querySelector('.zcDlg');
      const inp = wrap.querySelector('.in');
      const [btnCancel, btnOk] = wrap.querySelectorAll('.f .btn');
      const grid = wrap.querySelector('.chipgrid');
      const customChip = grid.querySelector('.chip.custom');
      const customSwatch = customChip.querySelector('.swatch-custom') || customChip.querySelector('.swatch');
      const pop = wrap.querySelector('.color-popover');
      const sv = pop.querySelector('.cp-sv');
      const svCur = pop.querySelector('.cp-sv-cursor');
      const hue = pop.querySelector('.cp-hue');
      const hexIn = pop.querySelector('.cp-hex');
      const prev = pop.querySelector('.cp-preview');

      let picked = '';
      let H = 210;
      let S = 0.7;
      let V = 0.9;

      const getVal = () => (inp.value || '').trim();
      const updateState = () => {
        btnOk.disabled = getVal().length === 0;
      };

      function setSVBackground() {
        sv.style.background = `
          linear-gradient(to right, rgba(255,255,255,1), rgba(255,255,255,0)),
          linear-gradient(to top, rgba(0,0,0,1), rgba(0,0,0,0)),
          hsl(${H}, 100%, 50%)
        `;
      }

      function hsvToHex(h, s, v) {
        s = Math.max(0, Math.min(1, s));
        v = Math.max(0, Math.min(1, v));

        const c = v * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = v - c;

        let r = 0;
        let g = 0;
        let b = 0;

        if (0 <= h && h < 60) {
          r = c; g = x; b = 0;
        } else if (60 <= h && h < 120) {
          r = x; g = c; b = 0;
        } else if (120 <= h && h < 180) {
          r = 0; g = c; b = x;
        } else if (180 <= h && h < 240) {
          r = 0; g = x; b = c;
        } else if (240 <= h && h < 300) {
          r = x; g = 0; b = c;
        } else {
          r = c; g = 0; b = x;
        }

        const R = Math.round((r + m) * 255);
        const G = Math.round((g + m) * 255);
        const B = Math.round((b + m) * 255);

        return '#' + [R, G, B].map((n) => n.toString(16).padStart(2, '0')).join('');
      }

      function normHex(v) {
        const s = String(v || '').trim().toLowerCase();

        if (/^#([0-9a-f]{6})$/.test(s)) return s;

        if (/^#([0-9a-f]{3})$/.test(s)) {
          const r = s[1];
          const g = s[2];
          const b = s[3];

          return `#${r}${r}${g}${g}${b}${b}`;
        }

        return null;
      }

      function hexToRgb(hex) {
        const h = normHex(hex);
        if (!h) return null;

        const i = parseInt(h.slice(1), 16);

        return {
          r: (i >> 16) & 255,
          g: (i >> 8) & 255,
          b: i & 255
        };
      }

      function hexToHsv(hex) {
        const rgb = hexToRgb(hex);
        if (!rgb) return { h: 0, s: 0, v: 0 };

        const r = rgb.r / 255;
        const g = rgb.g / 255;
        const b = rgb.b / 255;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;

        let h = 0;

        if (d === 0) h = 0;
        else if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * (((b - r) / d) + 2);
        else h = 60 * (((r - g) / d) + 4);

        if (h < 0) h += 360;

        const s = max === 0 ? 0 : d / max;
        const v = max;

        return { h, s, v };
      }

      function selectChip(chip) {
        grid.querySelectorAll('.chip').forEach((x) => x.classList.remove('selected'));
        chip.classList.add('selected');
      }

      function updatePreview() {
        const hex = hsvToHex(H, S, V);

        prev.style.background = hex;
        hexIn.value = hex.toLowerCase();

        customChip.dataset.color = hex;
        customSwatch.style.setProperty('--c', hex);
        customSwatch.classList.add('has-color');

        picked = hex;
        selectChip(customChip);
      }

      const GAP = 10;
      const PAD = 12;
      const POP_MIN_W = 220;
      const POP_MAX_W = 260;
      const SV_MIN = 120;
      const SV_MAX = 200;

      function placePopover() {
        const dlgW = dlg.clientWidth;
        const dlgH = dlg.clientHeight;
        const gridRect = grid.getBoundingClientRect();
        const dlgRect = dlg.getBoundingClientRect();

        const desiredW = Math.min(
          Math.max(POP_MIN_W, Math.min(grid.clientWidth, POP_MAX_W)),
          Math.max(POP_MIN_W, dlgW - PAD * 2)
        );

        pop.style.width = desiredW + 'px';

        const svSize = Math.max(SV_MIN, Math.min(SV_MAX, desiredW));
        sv.style.height = svSize + 'px';

        const wasHidden = pop.hidden;

        if (wasHidden) {
          pop.hidden = false;
          pop.style.visibility = 'hidden';
        }

        const popW = pop.offsetWidth;
        const popH = pop.offsetHeight;

        if (wasHidden) {
          pop.hidden = true;
          pop.style.visibility = '';
        }

        const right = {
          left: (gridRect.right - dlgRect.left) + GAP,
          top: (gridRect.top - dlgRect.top)
        };

        const left = {
          left: (gridRect.left - dlgRect.left) - popW - GAP,
          top: (gridRect.top - dlgRect.top)
        };

        const below = {
          left: (gridRect.left - dlgRect.left),
          top: (gridRect.bottom - dlgRect.top) + GAP
        };

        const above = {
          left: (gridRect.left - dlgRect.left),
          top: (gridRect.top - dlgRect.top) - popH - GAP
        };

        let pos =
          (right.left >= PAD && right.left + popW <= dlgW - PAD) ? right :
          (left.left >= PAD && left.left + popW <= dlgW - PAD) ? left :
          (below.left >= PAD && below.left + popW <= dlgW - PAD) ? below :
          above;

        pos.top = Math.min(Math.max(PAD, pos.top), Math.max(PAD, dlgH - popH - PAD));

        pop.style.left = Math.round(Math.max(PAD, Math.min(pos.left, dlgW - popW - PAD))) + 'px';
        pop.style.top = Math.round(pos.top) + 'px';
      }

      const openPopover = () => {
        setSVBackground();
        updatePreview();

        pop.hidden = false;
        pop.style.visibility = 'hidden';

        placePopover();

        pop.style.visibility = '';
      };

      const closePopover = () => {
        pop.hidden = true;
      };

      function svSetFromEvent(e) {
        const r = sv.getBoundingClientRect();
        const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
        const y = Math.min(Math.max(e.clientY - r.top, 0), r.height);

        S = (x / r.width);
        V = 1 - (y / r.height);

        svCur.style.left = (S * 100) + '%';
        svCur.style.top = ((1 - V) * 100) + '%';

        updatePreview();
      }

      sv.addEventListener('mousedown', (e) => {
        e.preventDefault();
        svSetFromEvent(e);

        const move = (ev) => svSetFromEvent(ev);
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };

        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });

      hue.addEventListener('input', () => {
        H = Number(hue.value) || 0;
        setSVBackground();
        updatePreview();
      });

      hexIn.addEventListener('input', () => {
        const hex = normHex(hexIn.value);
        if (!hex) return;

        const hsv = hexToHsv(hex);

        H = hsv.h;
        S = hsv.s;
        V = hsv.v;

        hue.value = String(Math.round(H));

        setSVBackground();

        svCur.style.left = (S * 100) + '%';
        svCur.style.top = ((1 - V) * 100) + '%';

        updatePreview();
      });

      wrap.querySelector('.cp-use').addEventListener('click', () => {
        closePopover();
      });

      wrap.querySelector('.cp-close').addEventListener('click', closePopover);

      function close(v) {
        document.removeEventListener('keydown', onKey, true);
        wrap.remove();
        resolve(v);
      }

      function onKey(e) {
        if (e.key === 'Enter' && !btnOk.disabled) {
          e.preventDefault();
          btnOk.click();
        } else if (e.key === 'Escape') {
          if (!pop.hidden) {
            closePopover();
            return;
          }

          e.preventDefault();
          close(null);
        }
      }

      btnCancel.onclick = () => close(null);
      btnOk.onclick = () => close({ name: getVal(), color: picked || null });

      wrap.addEventListener('click', (e) => {
        if (!pop.hidden && !pop.contains(e.target) && !customChip.contains(e.target)) {
          closePopover();
        }

        if (e.target === wrap) close(null);
      });

      document.addEventListener('keydown', onKey, true);

      setTimeout(() => {
        try {
          inp.focus();
        } catch {}
      }, 10);

      inp.addEventListener('input', updateState);
      updateState();

      grid.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;

        if (chip.classList.contains('custom')) {
          e.preventDefault();
          openPopover();
          return;
        }

        selectChip(chip);
        picked = chip.dataset.color || '';

        const input = chip.querySelector('input');
        if (input) input.checked = true;
      });

      customSwatch.addEventListener('click', (e) => {
        e.preventDefault();
        openPopover();
      });
    });
  }

  function ensurePlaceholder(node) {
    if (!node) return null;
    if (node.__pinRestore) return node.__pinRestore;

    node.__pinRestore = {
      parent: node.parentNode,
      next: node.nextSibling
    };

    return node.__pinRestore;
  }

  function restoreToPlaceholder(node) {
    if (!node || !node.__pinRestore) return;

    const { parent, next } = node.__pinRestore;

    if (parent) parent.insertBefore(node, next || null);

    node.__pinRestore = null;
  }

  function markPinned(node, flag) {
    if (!node) return;

    node.classList.toggle('is-pinned', !!flag);

    if (flag) node.style.order = '-1';
    else node.style.removeProperty('order');
  }

  function reorderByPinned(container) {
    if (!container) return;

    const sel = 'li, .cliente-item, .chat-item, .list-item';
    const children = Array.from(container.children).filter((n) => n.matches && n.matches(sel));

    if (!children.length) return;

    const pinned = children.filter((n) => n.classList && n.classList.contains('is-pinned'));
    if (!pinned.length) return;

    const firstNonPinned = children.find((n) => !(n.classList && n.classList.contains('is-pinned'))) || null;

    for (const n of pinned) {
      container.insertBefore(n, firstNonPinned);
    }
  }

  function tsFromNode(node) {
    if (!node) return Number.NaN;

    const ds = node.dataset || {};
    const keys = [
      'ts',
      'time',
      'timestamp',
      'last',
      'lastAt',
      'updated',
      'updatedAt',
      'horario',
      'hora',
      'ordem',
      'ordemInt',
      'order',
      'sort',
      'ultima',
      'ult'
    ];

    for (const k of keys) {
      if (k in ds) {
        const v = String(ds[k] || '').trim();
        const n = parseFloat(v);

        if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;

        const d = Date.parse(v);
        if (!Number.isNaN(d)) return d;
      }
    }

    if (node.getAttributeNames) {
      for (const a of node.getAttributeNames()) {
        if (!a.startsWith('data-')) continue;

        const v = node.getAttribute(a);
        if (!v) continue;

        const n = parseFloat(v);
        if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;

        const d = Date.parse(v);
        if (!Number.isNaN(d)) return d;
      }
    }

    const t = node.querySelector && node.querySelector('time[datetime]');
    if (t && t.getAttribute) {
      const d = Date.parse(t.getAttribute('datetime'));
      if (!Number.isNaN(d)) return d;
    }

    return Number.NaN;
  }

  function resortByTime(container) {
    if (!container) return;

    const sel = 'li, .cliente-item, .chat-item, .list-item';
    const kids = Array.from(container.children).filter((n) => n.matches && n.matches(sel));

    if (!kids.length) return;

    const pinned = [];
    const others = [];
    let idx = 0;

    for (const n of kids) {
      if (n.classList && n.classList.contains('is-pinned')) {
        pinned.push(n);
      } else {
        const ts = tsFromNode(n);
        others.push({
          node: n,
          ts: Number.isFinite(ts) ? ts : -Infinity,
          _i: idx++
        });
      }
    }

    others.sort((a, b) => (b.ts - a.ts) || (a._i - b._i));

    const fragTop = document.createDocumentFragment();
    const fragRest = document.createDocumentFragment();

    for (const n of pinned) fragTop.appendChild(n);
    for (const o of others) fragRest.appendChild(o.node);

    container.appendChild(fragTop);
    container.appendChild(fragRest);
  }

  function extractNumericId(v) {
    const s = String(v || '').trim();
    if (!s) return null;

    if (/^\d+$/.test(s)) return Number(s);

    const conv = s.match(/^c:(\d+)(?::|$)/i);
    if (conv) return Number(conv[1]);

    return null;
  }

  function extractInstFromConversationKey(v) {
    const s = String(v || '').trim();
    if (!s) return '';

    const m = s.match(/^[cg]:(.+):([^:]+)$/i);
    if (!m) return '';

    return String(m[2] || '').trim();
  }

  function getHistoricoInst() {
    const h = document.getElementById('historico');
    return String(
      h?.dataset?.instanciaId ||
      h?.dataset?.instancia ||
      h?.dataset?.instance ||
      ''
    ).trim();
  }

  function getActiveInstanceFallback() {
    const stateSel = window.state?.clienteSel || window.clienteSel || {};

    return String(
      stateSel.instancia_id ||
      stateSel.instanciaId ||
      stateSel.instance_id ||
      stateSel.instance ||
      stateSel.instance_name ||
      window.INSTANCIA_ATIVA ||
      getHistoricoInst() ||
      ''
    ).trim();
  }

  function resolveConversationInfo(li) {
    const ds = li?.dataset || {};

    const rawKey =
      ds.conversationKey ||
      ds.chatKey ||
      ds.key ||
      ds.id ||
      li?.getAttribute?.('data-conversation-key') ||
      li?.getAttribute?.('data-chat-key') ||
      li?.getAttribute?.('data-id') ||
      '';

    const rawGroup =
      ds.grupoId ||
      ds.groupId ||
      ds.grupoBaseId ||
      ds.groupBaseId ||
      li?.getAttribute?.('data-grupo-id') ||
      li?.getAttribute?.('data-group-id') ||
      '';

    const isGroup =
      !!rawGroup ||
      /^g:/i.test(String(rawKey || '')) ||
      String(ds.isGroup || '').toLowerCase() === 'true' ||
      String(ds.kind || '').toLowerCase() === 'group';

    const idCandidates = [
      ds.clienteId,
      ds.apiClienteId,
      ds.apiId,
      ds.conversaId,
      ds.conversationId,
      ds.id,
      li?.getAttribute?.('data-cliente-id'),
      li?.getAttribute?.('data-api-cliente-id'),
      li?.getAttribute?.('data-api-id'),
      li?.getAttribute?.('data-conversa-id'),
      li?.getAttribute?.('data-conversation-id'),
      li?.getAttribute?.('data-id'),
      rawKey
    ];

    let clienteId = null;

    for (const c of idCandidates) {
      const n = extractNumericId(c);
      if (n) {
        clienteId = n;
        break;
      }
    }

    const instCandidates = [
      ds.instanciaId,
      ds.instancia,
      ds.instanceId,
      ds.instance,
      ds.instanceName,
      li?.getAttribute?.('data-instancia-id'),
      li?.getAttribute?.('data-instancia'),
      li?.getAttribute?.('data-instance-id'),
      li?.getAttribute?.('data-instance'),
      li?.getAttribute?.('data-instance-name'),
      extractInstFromConversationKey(rawKey),
      getActiveInstanceFallback()
    ];

    let instancia = '';

    for (const c of instCandidates) {
      const s = String(c || '').trim();
      if (!s || s === 'all' || s === '*') continue;

      instancia = s;
      break;
    }

    return {
      isGroup,
      clienteId,
      instancia,
      rawKey
    };
  }

  function appendInstanceToPinRequest(qs, body, instancia) {
    const inst = String(instancia || '').trim();
    if (!inst || inst === 'all' || inst === '*') return false;

    if (/^\d+$/.test(inst)) {
      qs.set('instancia_id', inst);
      body.instancia_id = Number(inst);
      return true;
    }

    qs.set('instance', inst);
    body.instance = inst;
    return true;
  }

  function findListaClientes() {
    return document.getElementById('lista-clientes')
      || document.querySelector('.lista-clientes')
      || document.querySelector('[data-role="lista-clientes"]')
      || null;
  }

  const menu = document.createElement('div');
  menu.className = 'zc-ctxmenu';

  menu.innerHTML = `
    <button class="item" type="button" data-action="label">
      <span class="ico" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 256 256">
          <path fill="currentColor" d="M184,32H72A16,16,0,0,0,56,48V224a8,8,0,0,0,12.24,6.78L128,193.43l59.77,37.35A8,8,0,0,0,200,224V48A16,16,0,0,0,184,32Zm0,177.57-51.77-32.35a8,8,0,0,0-8.48,0L72,209.57V48H184Z"/>
        </svg>
      </span>
      Etiquetar conversa
    </button>

    <button class="item" type="button" data-action="pin">
      <span class="ico" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 256 256">
          <path fill="currentColor" d="M235.32,81.37,174.63,20.69a16,16,0,0,0-22.63,0L98.37,74.49c-10.66-3.34-35-7.37-60.4,13.14a16,16,0,0,0-1.29,23.78L85,159.71,42.34,202.34a8,8,0,0,0,11.32,11.32L96.29,171l48.29,48.29A16,16,0,0,0,155.9,224c.38,0,.75,0,1.13,0a15.93,15.93,0,0,0,11.64-6.33c19.64-26.1,17.75-47.32,13.19-60L235.33,104A16,16,0,0,0,235.32,81.37ZM224,92.69h0l-57.27,57.46a8,8,0,0,0-1.49,9.22c9.46,18.93-1.8,38.59-9.34,48.62L48,100.08c12.08-9.74,23.64-12.31,32.48-12.31A40.13,40.13,0,0,1,96.81,91a8,8,0,0,0,9.25-1.51L163.32,32,224,92.68Z"/>
        </svg>
      </span>
      <span data-pin-label>Fixar conversa</span>
    </button>

    <div class="sep"></div>

    <button class="item danger" type="button" data-action="delete">
      <span class="ico" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 256 256">
          <path fill="currentColor" d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/>
        </svg>
      </span>
      Apagar conversa
    </button>
  `;

  document.body.appendChild(menu);

  const btnDelete = menu.querySelector('[data-action="delete"]');

  function updateDeleteVisibility() {
    if (!btnDelete) return;
    btnDelete.classList.toggle('is-hidden', !CAN_DELETE_CONVERSA);
  }

  updateDeleteVisibility();

  (async () => {
    try {
      const res = await authFetch('/api/usuarios/me', { method: 'GET' });
      if (!res.ok) throw new Error('não conseguiu /me');

      const me = await res.json();

      const permsRaw = me.permissoes || me.permissions || me.perms || [];
      const perms = Array.isArray(permsRaw) ? permsRaw : [];

      const cargo = String(me.cargo || me.role || '').toLowerCase();
      const isAdmin = !!(
        me.is_admin ||
        me.isAdmin ||
        me.admin ||
        cargo === 'admin' ||
        cargo === 'administrador' ||
        cargo === 'owner'
      );

      const hasDelPerm =
        perms.includes('atendimento.apagar_conversas') ||
        perms.includes('atendimento.apagar') ||
        perms.includes('conversas.apagar');

      CAN_DELETE_CONVERSA = !!(isAdmin || hasDelPerm);
    } catch {
      CAN_DELETE_CONVERSA = false;
    }

    updateDeleteVisibility();
  })();

  let targetLi = null;

  const closeMenu = () => {
    menu.classList.remove('open');
    targetLi = null;
  };

  const openMenuAt = (x, y) => {
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.classList.add('open');

    requestAnimationFrame(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const r = menu.getBoundingClientRect();

      const left = Math.min(x, vw - r.width - 8);
      const top = Math.min(y, vh - r.height - 8);

      menu.style.left = Math.max(8, left) + 'px';
      menu.style.top = Math.max(8, top) + 'px';
    });
  };

  const updatePinLabel = (li) => {
    const el = menu.querySelector('[data-pin-label]');
    const pinned = li && li.classList && li.classList.contains('is-pinned');

    if (el) el.textContent = pinned ? 'Desafixar conversa' : 'Fixar conversa';
  };

  async function doLabel(clienteId) {
    const picked = await labelDialog({
      title: 'Etiquetar conversa',
      placeholder: 'Ex.: VIP, Financeiro, Suporte',
      submitText: 'Aplicar'
    });

    if (!picked || !picked.name) return;

    const bodies = [
      { add: { name: picked.name, color: picked.color } },
      { add: picked.name, color: picked.color || null }
    ];

    for (let i = 0; i < bodies.length; i += 1) {
      try {
        const res = await authFetch(`/api/atendimento/conversas/${encodeURIComponent(String(clienteId))}/labels?empresa_id=${EMPRESA_ID}`, {
          method: 'POST',
          body: JSON.stringify(bodies[i])
        });

        if (res.status === 403) {
          notify({
            title: 'Sem permissão',
            msg: 'Apenas administradores podem etiquetar.',
            type: 'error'
          });
          return;
        }

        if (!res.ok) {
          throw new Error(await readErrorText(res));
        }

        notify({
          title: 'Etiqueta aplicada',
          msg: picked.color && i === 0 ? `${picked.name} • ${picked.color}` : `${picked.name}`,
          type: 'ok'
        });

        return;
      } catch (e) {
        if (i === bodies.length - 1) {
          notify({
            title: 'Falha ao etiquetar',
            msg: String((e && e.message) || e),
            type: 'error'
          });
        }
      }
    }
  }

  async function doPin(clienteId, li) {
    if (!li || !li.classList) {
      li = document.querySelector(
        `[data-id="${clienteId}"], .cliente-item[data-id="${clienteId}"], .chat-item[data-id="${clienteId}"], .list-item[data-id="${clienteId}"]`
      );
    }

    if (!li) {
      notify({
        title: 'Falha',
        msg: 'Não encontrei o item da conversa na lista.',
        type: 'error'
      });
      return;
    }

    const info = resolveConversationInfo(li);

    if (info.isGroup) {
      notify({
        title: 'Ação indisponível',
        msg: 'Este menu ainda não está preparado para grupos. Use em conversas individuais.',
        type: 'warn'
      });
      return;
    }

    if (!info.clienteId) {
      notify({
        title: 'Falha',
        msg: 'Item sem data-id de conversa individual.',
        type: 'error'
      });
      return;
    }

    if (!info.instancia) {
      notify({
        title: 'Instância não identificada',
        msg: 'Não consegui descobrir a instância desta conversa para fixar corretamente.',
        type: 'error'
      });
      return;
    }

    clienteId = Number(info.clienteId);

    const willPin = !li.classList.contains('is-pinned');
    const container = li.closest('#lista-clientes, .lista-clientes, [role="list"], .list, ul, ol') || li.parentElement;

    if (willPin) {
      ensurePlaceholder(li);
      markPinned(li, true);
      updatePinLabel(li);

      requestAnimationFrame(() => reorderByPinned(container));
    } else {
      restoreToPlaceholder(li);
      markPinned(li, false);
      updatePinLabel(li);

      requestAnimationFrame(() => resortByTime(container));
    }

    const qs = new URLSearchParams();
    qs.set('empresa_id', String(EMPRESA_ID));

    const body = { pin: willPin };
    const hasInst = appendInstanceToPinRequest(qs, body, info.instancia);

    if (!hasInst) {
      if (willPin) {
        markPinned(li, false);
        restoreToPlaceholder(li);
        requestAnimationFrame(() => resortByTime(container));
      } else {
        ensurePlaceholder(li);
        markPinned(li, true);
        requestAnimationFrame(() => reorderByPinned(container));
      }

      notify({
        title: 'Instância obrigatória',
        msg: 'Não foi possível fixar sem instancia_id.',
        type: 'error'
      });
      return;
    }

    try {
      const res = await authFetch(`/api/atendimento/conversas/${encodeURIComponent(String(clienteId))}/pin?${qs.toString()}`, {
        method: 'POST',
        body: JSON.stringify(body)
      });

      if (res.status === 403) {
        notify({
          title: 'Sem permissão',
          msg: 'Você não tem permissão para fixar esta conversa.',
          type: 'error'
        });
        return;
      }

      if (!res.ok) {
        throw new Error(await readErrorText(res));
      }

      const data = await res.json().catch(() => ({}));
      const serverClienteId = Number(data.cliente_id || clienteId);

      try {
        if (serverClienteId && li.dataset) {
          li.dataset.clienteId = String(serverClienteId);
          li.dataset.id = String(serverClienteId);
        }
      } catch {}

      try {
        if (window.Lista && typeof window.Lista.setPinned === 'function') {
          window.Lista.setPinned(serverClienteId || clienteId, willPin);
        }
      } catch {}

      try {
        sessionStorage.setItem('convForceReload', '1');
      } catch {}

      try {
        if (typeof window.carregarClientes === 'function') {
          await window.carregarClientes({ force: true });
        }
      } catch {}

      notify({
        title: willPin ? 'Conversa fixada' : 'Conversa desafixada',
        type: 'ok'
      });
    } catch (e) {
      if (willPin) {
        markPinned(li, false);
        restoreToPlaceholder(li);
        updatePinLabel(li);
        requestAnimationFrame(() => resortByTime(container));
      } else {
        ensurePlaceholder(li);
        markPinned(li, true);
        updatePinLabel(li);
        requestAnimationFrame(() => reorderByPinned(container));
      }

      notify({
        title: 'Falha ao fixar/desafixar',
        msg: String((e && e.message) || e),
        type: 'error'
      });
    }
  }

  async function doDelete(clienteId, li) {
    if (!CAN_DELETE_CONVERSA) {
      notify({
        title: 'Sem permissão',
        msg: 'Apenas administradores podem apagar conversas.',
        type: 'error'
      });
      return;
    }

    const choice = await deleteChoiceDialog();
    if (!choice) return;

    const removeFromUI = () => {
      if (li && li.remove) li.remove();

      try {
        if (window.cacheHistoricos) delete window.cacheHistoricos[String(clienteId)];
        if (window.state?.cacheHistoricos) delete window.state.cacheHistoricos[String(clienteId)];

        const key = `cacheHistoricos:${EMPRESA_ID}`;
        const raw = localStorage.getItem(key);

        if (raw) {
          const obj = JSON.parse(raw);
          delete obj[String(clienteId)];
          localStorage.setItem(key, JSON.stringify(obj));
        }
      } catch {}
    };

    if (choice === 'lista') {
      try {
        const res = await authFetch(`/api/atendimento/conversas/${encodeURIComponent(String(clienteId))}?empresa_id=${EMPRESA_ID}`, {
          method: 'DELETE'
        });

        if (res.status === 403) {
          notify({
            title: 'Sem permissão',
            msg: 'Apenas administradores podem apagar.',
            type: 'error'
          });
          return;
        }

        if (!res.ok) {
          throw new Error(await readErrorText(res));
        }

        removeFromUI();

        notify({
          title: 'Conversa removida da lista',
          type: 'ok'
        });
      } catch (e) {
        notify({
          title: 'Falha ao apagar da lista',
          msg: String((e && e.message) || e),
          type: 'error'
        });
      }

      return;
    }

    if (choice === 'permanente') {
      const ok = await confirmDialog({
        title: 'Apagar permanentemente',
        msg: 'Tem certeza que deseja apagar PERMANENTEMENTE esta conversa?\n\nIsso vai remover o cliente e TODO o histórico desta conversa do sistema. Esta ação não poderá ser desfeita.',
        okText: 'Apagar permanentemente',
        cancelText: 'Cancelar',
        destructive: true
      });

      if (!ok) return;

      try {
        const res = await authFetch(`/api/atendimento/conversas/${encodeURIComponent(String(clienteId))}/permanente?empresa_id=${EMPRESA_ID}`, {
          method: 'DELETE'
        });

        if (res.status === 403) {
          notify({
            title: 'Sem permissão',
            msg: 'Apenas administradores podem apagar permanentemente.',
            type: 'error'
          });
          return;
        }

        if (!res.ok) {
          throw new Error(await readErrorText(res));
        }

        removeFromUI();

        notify({
          title: 'Conversa apagada permanentemente',
          type: 'ok'
        });
      } catch (e) {
        notify({
          title: 'Falha ao apagar permanentemente',
          msg: String((e && e.message) || e),
          type: 'error'
        });
      }
    }
  }

  menu.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.item');
    if (!btn || !targetLi) return;

    const liCtx = targetLi;
    const action = btn.dataset.action;
    const info = resolveConversationInfo(liCtx);

    closeMenu();

    if (info.isGroup) {
      notify({
        title: 'Ação indisponível',
        msg: 'Este menu ainda não está preparado para grupos. Use em conversas individuais.',
        type: 'warn'
      });
      return;
    }

    const clienteId = Number(info.clienteId);

    if (!Number.isFinite(clienteId) || clienteId <= 0) {
      notify({
        title: 'Falha',
        msg: 'Item sem data-id.',
        type: 'error'
      });
      return;
    }

    if (action === 'label') {
      doLabel(clienteId);
      return;
    }

    if (action === 'pin') {
      doPin(clienteId, liCtx);
      return;
    }

    if (action === 'delete') {
      doDelete(clienteId, liCtx);
    }
  });

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) closeMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  window.addEventListener('scroll', closeMenu, true);

  document.addEventListener('contextmenu', (ev) => {
    const list = findListaClientes();
    if (!list || !list.contains(ev.target)) return;

    const li = ev.target.closest('[data-id], [data-cliente-id], [data-conversation-id], [data-conversation-key], .chat-item, .cliente-item, .list-item, li');
    if (!li) return;

    const info = resolveConversationInfo(li);

    if (info.isGroup) {
      ev.preventDefault();
      notify({
        title: 'Ação indisponível',
        msg: 'Este menu ainda não está preparado para grupos. Use em conversas individuais.',
        type: 'warn'
      });
      return;
    }

    if (!info.clienteId) return;

    ev.preventDefault();

    targetLi = li;

    updatePinLabel(li);
    openMenuAt(ev.clientX, ev.clientY);
  });
})();