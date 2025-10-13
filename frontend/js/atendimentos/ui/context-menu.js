// /frontend/js/atendimentos/ui/context-menu.js
// Menu de contexto: Etiquetar, Fixar/Desafixar, Apagar (admin-only).
// Fix/Desfixa com UI otimista + placeholder (comentário) pra restaurar.
// Desfixar reordena os não fixados pelo HORÁRIO (desc). Fixar agora vai pro TOPO.

(function () {
  if (window.__ATD_CTXMENU_INIT__) return;
  window.__ATD_CTXMENU_INIT__ = true;

  const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);
  if (!EMPRESA_ID) return;

  // ================== Fetch com credenciais ==================
  const authFetch = (url, opt = {}) => {
    const f = (window.ZAuth && ZAuth.authFetch) ? ZAuth.authFetch : fetch;
    const headers = Object.assign(
      { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      opt.headers || {}
    );
    const t = localStorage.getItem('token');
    if (t && !headers.Authorization) headers.Authorization = `Bearer ${t}`;
    return f(url, { credentials: 'include', ...opt, headers });
  };

  // ================== Toast ==================
  function notify({ title = 'Pronto', msg = '', type = 'ok', timeout = 2800 } = {}) {
    if (typeof window.toast === 'function') {
      try { window.toast({ title, msg, type, timeout }); return; } catch {}
      try { window.toast(msg || title, type !== 'error'); return; } catch {}
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
  function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
  function ensureToastHost() {
    if (document.getElementById('zcToastHost')) return;
    const host = document.createElement('div');
    host.id = 'zcToastHost';
    document.body.appendChild(host);
    const st = document.createElement('style');
    st.textContent = `
      #zcToastHost{position:fixed;right:14px;bottom:14px;z-index:10000;display:flex;flex-direction:column;gap:8px}
      .zcToast{opacity:0;transform:translateY(8px);transition:all .18s ease;max-width:min(360px,90vw);
        background:var(--card,#111827);color:var(--text,#e5e7eb);border:1px solid var(--border,rgba(255,255,255,.12));
        border-radius:12px;padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.35);font:14px/1.35 system-ui, -apple-system, Segoe UI, Roboto}
      .zcToast.on{opacity:1;transform:none}
      .zcToast strong{display:block;font-weight:600;margin-bottom:2px}
      .zcToast .m{opacity:.9}
      .zcToast.ok{border-color:rgba(16,185,129,.35)}
      .zcToast.error{border-color:rgba(239,68,68,.45)}
      .zcToast.warn{border-color:rgba(245,158,11,.45)}
    `;
    document.head.appendChild(st);
  }

  // ================== Diálogos ==================
  function confirmDialog({ title = 'Confirmação', msg = '', okText = 'OK', cancelText = 'Cancelar', destructive = false } = {}) {
    return new Promise(resolve => {
      ensureDialogCSS();
      const wrap = document.createElement('div');
      wrap.className = 'zcDlgBackdrop';
      wrap.innerHTML = `
        <div class="zcDlg" role="dialog" aria-label="${escapeHtml(title)}">
          <div class="h">${escapeHtml(title)}</div>
          <div class="b">${escapeHtml(msg)}</div>
          <div class="f">
            <button class="btn ghost">${escapeHtml(cancelText)}</button>
            <button class="btn ${destructive ? 'danger' : ''}">${escapeHtml(okText)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(wrap);
      const [btnCancel, btnOk] = wrap.querySelectorAll('.f .btn');
      const close = (v) => { wrap.remove(); resolve(v); };
      btnCancel.onclick = () => close(false);
      btnOk.onclick = () => close(true);
      wrap.addEventListener('click', e => { if (e.target === wrap) close(false); });
      document.addEventListener('keydown', function esc(e){ if(e.key==='Escape'){ document.removeEventListener('keydown', esc); close(false);} });
      try { btnOk.focus(); } catch {}
    });
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
    return new Promise(resolve => {
      ensureDialogCSS();
      const wrap = document.createElement('div');
      wrap.className = 'zcDlgBackdrop';

      const chips = palette.map(p => `
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
              <input type="text" class="in" placeholder="${escapeHtml(placeholder)}"
                     maxlength="${Number(maxLength)||48}" value="${escapeHtml(value)}"
                     autocomplete="off" spellcheck="false"/>
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
            <button class="btn ghost">${escapeHtml(cancelText)}</button>
            <button class="btn primary" disabled>${escapeHtml(submitText)}</button>
          </div>

          <div class="color-popover" hidden>
            <div class="cp-head">
              <span>Cor personalizada</span>
              <button class="cp-close" aria-label="Fechar">×</button>
            </div>
            <div class="cp-body">
              <div class="cp-sv"><div class="cp-sv-cursor"></div></div>
              <input class="cp-hue" type="range" min="0" max="360" value="210"/>
              <div class="cp-row">
                <div class="cp-preview"></div>
                <input class="cp-hex" type="text" value="#3b82f6" maxlength="7" spellcheck="false">
                <button class="cp-use">Usar cor</button>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(wrap);

      const dlg   = wrap.querySelector('.zcDlg');
      const inp   = wrap.querySelector('.in');
      const [btnCancel, btnOk] = wrap.querySelectorAll('.f .btn');
      const grid  = wrap.querySelector('.chipgrid');
      const customChip   = grid.querySelector('.chip.custom');
      const customSwatch = customChip.querySelector('.swatch-custom') || customChip.querySelector('.swatch');
      const pop   = wrap.querySelector('.color-popover');
      const sv    = pop.querySelector('.cp-sv');
      const svCur = pop.querySelector('.cp-sv-cursor');
      const hue   = pop.querySelector('.cp-hue');
      const hexIn = pop.querySelector('.cp-hex');
      const prev  = pop.querySelector('.cp-preview');

      let picked = '';
      let H = 210, S = 0.7, V = 0.9;

      const getVal = () => (inp.value || '').trim();
      const updateState = () => { btnOk.disabled = getVal().length === 0; };

      function setSVBackground(){
        sv.style.background = `
          linear-gradient(to right, rgba(255,255,255,1), rgba(255,255,255,0)),
          linear-gradient(to top, rgba(0,0,0,1), rgba(0,0,0,0)),
          hsl(${H}, 100%, 50%)
        `;
      }
      function hsvToHex(h, s, v){
        s = Math.max(0, Math.min(1, s));
        v = Math.max(0, Math.min(1, v));
        const c = v * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = v - c;
        let r=0, g=0, b=0;
        if (0 <= h && h < 60)   { r=c; g=x; b=0; }
        else if (60 <= h && h < 120) { r=x; g=c; b=0; }
        else if (120 <= h && h < 180){ r=0; g=c; b=x; }
        else if (180 <= h && h < 240){ r=0; g=x; b=c; }
        else if (240 <= h && h < 300){ r=x; g=0; b=c; }
        else { r=c; g=0; b=x; }
        const R = Math.round((r + m) * 255);
        const G = Math.round((g + m) * 255);
        const B = Math.round((b + m) * 255);
        return '#' + [R,G,B].map(n => n.toString(16).padStart(2,'0')).join('');
      }
      function normHex(v){
        const s = String(v || '').trim().toLowerCase();
        if (/^#([0-9a-f]{6})$/.test(s)) return s;
        if (/^#([0-9a-f]{3})$/.test(s)) {
          const r=s[1], g=s[2], b=s[3];
          return `#${r}${r}${g}${g}${b}${b}`;
        }
        return null;
      }
      function hexToRgb(hex){
        const h = normHex(hex); if (!h) return null;
        const i = parseInt(h.slice(1), 16);
        return { r:(i>>16)&255, g:(i>>8)&255, b:i&255 };
      }
      function hexToHsv(hex){
        const rgb = hexToRgb(hex); if (!rgb) return {h:0,s:0,v:0};
        const r = rgb.r/255, g = rgb.g/255, b = rgb.b/255;
        const max = Math.max(r,g,b), min = Math.min(r,g,b);
        const d = max - min;
        let h=0;
        if (d === 0) h = 0;
        else if (max === r) h = 60 * (((g-b)/d) % 6);
        else if (max === g) h = 60 * (((b-r)/d) + 2);
        else h = 60 * (((r-g)/d) + 4);
        if (h < 0) h += 360;
        const s = max === 0 ? 0 : d / max;
        const v = max;
        return {h,s,v};
      }

      function updatePreview(){
        const hex = hsvToHex(H, S, V);
        prev.style.background = hex;
        hexIn.value = hex.toLowerCase();
        customChip.dataset.color = hex;
        customSwatch.style.setProperty('--c', hex);
        customSwatch.classList.add('has-color');
        picked = hex;
        selectChip(customChip);
      }

      const GAP = 10, PAD = 12, POP_MIN_W = 220, POP_MAX_W = 260, SV_MIN = 120, SV_MAX = 200;
      function placePopover(){
        const dlgW = dlg.clientWidth, dlgH = dlg.clientHeight;
        const gridRect = grid.getBoundingClientRect();
        const dlgRect  = dlg.getBoundingClientRect();
        let desiredW = Math.min(
          Math.max(POP_MIN_W, Math.min(grid.clientWidth, POP_MAX_W)),
          Math.max(POP_MIN_W, dlgW - PAD*2)
        );
        const popEl = wrap.querySelector('.color-popover');
        popEl.style.width = desiredW + 'px';
        const svSize = Math.max(SV_MIN, Math.min(SV_MAX, desiredW));
        sv.style.height = svSize + 'px';

        const wasHidden = popEl.hidden;
        if (wasHidden) { popEl.hidden = false; popEl.style.visibility = 'hidden'; }
        const popW = popEl.offsetWidth, popH = popEl.offsetHeight;
        if (wasHidden) { popEl.hidden = true; popEl.style.visibility = ''; }

        const right = { left: (gridRect.right - dlgRect.left) + GAP, top : (gridRect.top   - dlgRect.top) };
        const left  = { left: (gridRect.left  - dlgRect.left) - popW - GAP, top : (gridRect.top   - dlgRect.top) };
        const below = { left: (gridRect.left  - dlgRect.left), top : (gridRect.bottom- dlgRect.top) + GAP };
        const above = { left: (gridRect.left  - dlgRect.left), top : (gridRect.top   - dlgRect.top) - popH - GAP };
        let pos =
            (right.left >= PAD && right.left + popW <= dlgW - PAD) ? right :
            (left.left  >= PAD && left.left  + popW <= dlgW - PAD) ? left  :
            (below.left >= PAD && below.left + popW <= dlgW - PAD) ? below :
            above;
        pos.top = Math.min(Math.max(PAD, pos.top), Math.max(PAD, dlgH - popH - PAD));
        popEl.style.left = Math.round(Math.max(PAD, Math.min(pos.left, dlgW - popW - PAD))) + 'px';
        popEl.style.top  = Math.round(pos.top) + 'px';
      }
      const openPopover  = () => { const pop = wrap.querySelector('.color-popover'); setSVBackground(); updatePreview(); pop.hidden = false; pop.style.visibility = 'hidden'; placePopover(); pop.style.visibility = ''; };
      const closePopover = () => { wrap.querySelector('.color-popover').hidden = true; };

      function selectChip(chip){
        grid.querySelectorAll('.chip').forEach(x => x.classList.remove('selected'));
        chip.classList.add('selected');
      }
      function svSetFromEvent(e){
        const r = sv.getBoundingClientRect();
        const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
        const y = Math.min(Math.max(e.clientY - r.top , 0), r.height);
        S = (x / r.width);
        V = 1 - (y / r.height);
        svCur.style.left = (S * 100) + '%';
        svCur.style.top  = ((1 - V) * 100) + '%';
        updatePreview();
      }
      sv.addEventListener('mousedown', (e) => {
        e.preventDefault();
        svSetFromEvent(e);
        const move = (ev) => svSetFromEvent(ev);
        const up   = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
      hue.addEventListener('input', () => { H = Number(hue.value)||0; setSVBackground(); updatePreview(); });
      hexIn.addEventListener('input', () => {
        const hex = normHex(hexIn.value); if (!hex) return;
        const {h,s,v} = hexToHsv(hex);
        H=h;S=s;V=v;
        hue.value = String(Math.round(H));
        setSVBackground();
        svCur.style.left = (S * 100) + '%';
        svCur.style.top  = ((1 - V) * 100) + '%';
        updatePreview();
      });
      wrap.querySelector('.cp-use').addEventListener('click', () => { closePopover(); });
      wrap.querySelector('.cp-close').addEventListener('click', closePopover);

      function close(v){ wrap.remove(); resolve(v); }
      function onKey(e){
        if(e.key === 'Enter' && !btnOk.disabled){ e.preventDefault(); btnOk.click(); }
        else if(e.key === 'Escape'){
          const pop = wrap.querySelector('.color-popover');
          if (!pop.hidden) { closePopover(); return; }
          e.preventDefault(); close(null);
        }
      }
      btnCancel.onclick = () => close(null);
      btnOk.onclick     = () => close({ name: getVal(), color: picked || null });
      wrap.addEventListener('click', e => {
        const pop = wrap.querySelector('.color-popover');
        const customChipEl = customChip;
        if (!pop.hidden && !pop.contains(e.target) && !customChipEl.contains(e.target)) closePopover();
        if (e.target === wrap) close(null);
      });
      document.addEventListener('keydown', onKey, { capture:true });
      setTimeout(() => { try{ inp.focus(); }catch{} }, 10);
      inp.addEventListener('input', updateState);
      updateState();
    });
  }

  function defaultPalette(){
    return [
      { name:'Cinza',    hex:'#6b7280' }, { name:'Azul',     hex:'#3b82f6' },
      { name:'Ciano',    hex:'#06b6d4' }, { name:'Verde',    hex:'#10b981' },
      { name:'Lima',     hex:'#84cc16' }, { name:'Amarelo',  hex:'#eab308' },
      { name:'Laranja',  hex:'#f59e0b' }, { name:'Vermelho', hex:'#ef4444' },
      { name:'Rosa',     hex:'#ec4899' }, { name:'Roxo',     hex:'#8b5cf6' }
    ];
  }

  function ensureDialogCSS() {
    if (document.getElementById('zcDlgCSS')) return;
    const st = document.createElement('style');
    st.id = 'zcDlgCSS';
    st.textContent = `
      .zcDlgBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:10000}
      .zcDlg{position:relative;width:min(520px,92vw);background:var(--card,#111827);color:var(--text,#e5e7eb);
        border:1px solid var(--border,rgba(255,255,255,.12));border-radius:14px;box-shadow:0 12px 36px rgba(0,0,0,.4);overflow:visible}
      .zcDlg .h{padding:14px 16px 2px;font-weight:600;font-size:15px}
      .zcDlg .b{padding:12px 16px;opacity:.95;display:grid;gap:12px}
      .zcDlg .b .in{width:100%;padding:10px 12px;border-radius:10px;background:#0b1220;
        border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;outline:2px solid transparent;outline-offset:2px}
      .zcDlg .b .in:focus{border-color:var(--ring,#4f83ff);box-shadow:0 0 0 3px rgba(79,131,255,.18)}
      .zcDlg .f{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px 14px}
      .zcDlg .btn{padding:9px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:#0f172a;color:inherit;cursor:pointer}
      .zcDlg .btn.ghost{background:transparent}
      .zcDlg .btn.primary{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:#fff}
      .zcDlg .btn[disabled]{opacity:.55;cursor:not-allowed}
      .zcDlg .btn.danger{background:#1f0b0b;border-color:#ef4444;color:#ef8a8a}
      .zcDlg .fld .lbl{display:block;font-weight:600;font-size:.92rem;margin:4px 0 6px}
      .zcDlg .hint{display:block;margin-top:6px;font-size:.8rem;color:var(--muted,#9ca3af)}
      .zcDlg .chipgrid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:10px;align-items:center}
      .zcDlg .chip{display:grid;place-items:center;cursor:pointer;position:relative}
      .zcDlg .chip input{display:none}
      .zcDlg .chip .swatch{width:22px;height:22px;border-radius:999px;background:var(--c);
        border:1px solid rgba(0,0,0,.25);box-shadow:inset 0 0 0 1px rgba(255,255,255,.15);transition:transform .08s,box-shadow .12s,filter .12s}
      .zcDlg .chip .swatch:hover{transform:translateY(1px)}
      .zcDlg .chip.selected .swatch{box-shadow:0 0 0 3px rgba(79,131,255,.28), inset 0 0 0 1px rgba(255,255,255,.18)}
      .zcDlg .chip .swatch-none{display:grid;place-items:center;font-weight:700;font-size:.9rem;color:var(--muted,#9ca3af);
        background:transparent;border:1px dashed var(--border,rgba(255,255,255,.22))}
      .zcDlg .chip .swatch-custom{
        display:grid;place-items:center;font-weight:900;color:#111;
        background:
          radial-gradient( circle at 30% 30%, rgba(255,255,255,.35), transparent 40% ),
          conic-gradient(from 0deg,#f43f5e,#f59e0b,#fbbf24,#22c55e,#06b6d4,#3b82f6,#a78bfa,#f472b6,#f43f5e);
        text-shadow:0 1px 0 rgba(255,255,255,.3);
      }
      .zcDlg .chip .swatch-custom.has-color{ color:transparent; }
      .color-popover{position:absolute;z-index:10001;padding:10px;background:#0d1220;color:#e5e7eb;
        border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.5);max-width:calc(100% - 24px)}
      .color-popover[hidden]{display:none}
      .color-popover .cp-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
      .color-popover .cp-close{cursor:pointer;border:1px solid rgba(255,255,255,.12);background:#111827;color:#e5e7eb;border-radius:8px;width:26px;height:26px}
      .color-popover .cp-body{display:grid;gap:10px}
      .cp-sv{position:relative;aspect-ratio:1/1;min-height:120px;max-height:200px;border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,.12)}
      .cp-sv-cursor{position:absolute;width:14px;height:14px;border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.5);transform:translate(-50%,-50%)}
      .cp-hue{width:100%;height:10px;border-radius:999px;cursor:pointer;-webkit-appearance:none;appearance:none;outline:none;
        border:1px solid rgba(255,255,255,.12);
        background:linear-gradient(to right,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000)}
      .cp-row{display:flex;gap:8px;align-items:center}
      .cp-preview{width:28px;height:28px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:var(--c,#3b82f6)}
      .cp-hex{flex:1;min-width:0;background:#0b1220;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 10px;color:#e5e7eb;font:inherit}
      .cp-use{border:1px solid rgba(255,255,255,.14);background:#0f172a;color:#e5e7eb;border-radius:10px;padding:8px 10px;cursor:pointer}
    `;
    document.head.appendChild(st);
  }

  // ================== CSS do menu ==================
  (function injectMenuCSS() {
    if (document.getElementById('zc-ctxmenu-css')) return;
    const css = `
      .zc-ctxmenu{ position:fixed; z-index:9999; min-width:230px; padding:6px;
        background:var(--card, #111827); color:var(--text,#e5e7eb);
        border:1px solid var(--border, rgba(255,255,255,.12));
        border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,.35); display:none }
      .zc-ctxmenu.open{ display:block }
      .zc-ctxmenu .item{ display:flex; align-items:center; gap:10px;
        width:100%; padding:10px 12px; background:transparent; border:0;
        font:inherit; color:inherit; text-align:left; border-radius:8px; cursor:pointer }
      .zc-ctxmenu .item:hover{ background:rgba(255,255,255,.06) }
      .zc-ctxmenu .item .ico{ width:18px; display:inline-flex; align-items:center; justify-content:center; }
      .zc-ctxmenu .sep{ height:1px; margin:6px 4px; background:var(--border, rgba(255,255,255,.12)); border-radius:1px }
      .zc-ctxmenu .danger{ color:#ef4444 }

      /* Visual de fixado */
      .is-pinned{ border:1px solid rgba(250,204,21,.35); border-radius:10px }
      .chat-item.is-pinned{ order:-1; }
      .chat-item.is-pinned .chat-title::after{ content:'📌'; margin-left:6px; opacity:.95; font-size:.95em }
    `;
    const style = document.createElement('style');
    style.id = 'zc-ctxmenu-css';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ================== Helpers: placeholder + reorder ==================
  function ensurePlaceholder(node){
    if (!node) return null;
    if (node.__pinPh) return node.__pinPh;
    const ph = document.createComment('pin-ph');
    node.__pinPh = ph;
    if (node.parentNode) node.parentNode.insertBefore(ph, node);
    return ph;
  }
  function restoreToPlaceholder(node){
    if (!node) return;
    const ph = node.__pinPh;
    if (ph && ph.parentNode){
      ph.parentNode.insertBefore(node, ph);
      ph.remove();
    }
    node.__pinPh = null;
  }
  function markPinned(node, flag){
    if (!node) return;
    node.classList.toggle('is-pinned', !!flag);
    if (flag) node.style.order = '-1';
    else node.style.removeProperty('order');
  }

  // Empurra TODOS os fixados pro TOPO (listas não-flex)
  function reorderByPinned(container){
    if (!container) return;
    const sel = 'li, .cliente-item, .chat-item, .list-item';
    const children = Array.from(container.children).filter(n => n.matches?.(sel));
    if (!children.length) return;

    const pinned = children.filter(n => n.classList?.contains('is-pinned'));
    if (!pinned.length) return;

    // âncora = primeiro NÃO fixado
    const firstNonPinned = children.find(n => !n.classList?.contains('is-pinned')) || null;

    // insere os fixados antes do primeiro não-fixado, preservando a ordem entre eles
    for (const n of pinned) {
      container.insertBefore(n, firstNonPinned);
    }
  }

  // ---------- resort por horário (desc) só para não fixados ----------
  function tsFromNode(node){
    if (!node) return Number.NaN;
    const ds = node.dataset || {};
    const keys = [
      'ts','time','timestamp','last','lastAt','updated','updatedAt',
      'horario','hora','ordem','ordemInt','order','sort','ultima','ult'
    ];
    for (const k of keys){
      if (k in ds){
        const v = String(ds[k] || '').trim();
        const n = parseFloat(v);
        if (Number.isFinite(n)) return n < 1e12 ? n*1000 : n;
        const d = Date.parse(v);
        if (!Number.isNaN(d)) return d;
      }
    }
    for (const a of node.getAttributeNames?.() || []){
      if (a.startsWith('data-')){
        const v = node.getAttribute(a);
        if (!v) continue;
        const n = parseFloat(v);
        if (Number.isFinite(n)) return n < 1e12 ? n*1000 : n;
        const d = Date.parse(v);
        if (!Number.isNaN(d)) return d;
      }
    }
    const t = node.querySelector?.('time[datetime]');
    if (t && t.getAttribute){
      const d = Date.parse(t.getAttribute('datetime'));
      if (!Number.isNaN(d)) return d;
    }
    return Number.NaN;
  }

  function resortByTime(container){
    if (!container) return;
    const sel = 'li, .cliente-item, .chat-item, .list-item';
    const kids = Array.from(container.children).filter(n => n.matches?.(sel));
    if (!kids.length) return;
    const pinned = [];
    const others = [];
    let idx = 0;
    for (const n of kids){
      if (n.classList?.contains('is-pinned')) pinned.push(n);
      else {
        const ts = tsFromNode(n);
        others.push({ node:n, ts: Number.isFinite(ts) ? ts : -Infinity, _i: idx++ });
      }
    }
    others.sort((a,b) => (b.ts - a.ts) || (a._i - b._i));

    const fragTop = document.createDocumentFragment();
    const fragRest = document.createDocumentFragment();
    for (const n of pinned) fragTop.appendChild(n);
    for (const o of others) fragRest.appendChild(o.node);
    container.appendChild(fragTop);
    container.appendChild(fragRest);
  }

  // ================== DOM do menu ==================
  const menu = document.createElement('div');
  menu.className = 'zc-ctxmenu';
  menu.innerHTML = `
    <button class="item" data-action="label">
      <span class="ico" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 256 256"><path fill="currentColor" d="M184,32H72A16,16,0,0,0,56,48V224a8,8,0,0,0,12.24,6.78L128,193.43l59.77,37.35A8,8,0,0,0,200,224V48A16,16,0,0,0,184,32Zm0,177.57-51.77-32.35a8,8,0,0,0-8.48,0L72,209.57V48H184Z"/></svg>
      </span>
      Etiquetar conversa
    </button>
    <button class="item" data-action="pin">
      <span class="ico" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 256 256"><path fill="currentColor" d="M235.32,81.37,174.63,20.69a16,16,0,0,0-22.63,0L98.37,74.49c-10.66-3.34-35-7.37-60.4,13.14a16,16,0,0,0-1.29,23.78L85,159.71,42.34,202.34a8,8,0,0,0,11.32,11.32L96.29,171l48.29,48.29A16,16,0,0,0,155.9,224c.38,0,.75,0,1.13,0a15.93,15.93,0,0,0,11.64-6.33c19.64-26.1,17.75-47.32,13.19-60L235.33,104A16,16,0,0,0,235.32,81.37ZM224,92.69h0l-57.27,57.46a8,8,0,0,0-1.49,9.22c9.46,18.93-1.8,38.59-9.34,48.62L48,100.08c12.08-9.74,23.64-12.31,32.48-12.31A40.13,40.13,0,0,1,96.81,91a8,8,0,0,0,9.25-1.51L163.32,32,224,92.68Z"/></svg>
      </span>
      <span data-pin-label>Fixar conversa</span>
    </button>
    <div class="sep"></div>
    <button class="item danger" data-action="delete">
      <span class="ico" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 256 256"><path fill="currentColor" d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/></svg>
      </span>
      Apagar conversa
    </button>
  `;
  document.body.appendChild(menu);

  let targetLi = null;
  const closeMenu = () => { menu.classList.remove('open'); targetLi = null; };
  const openMenuAt = (x, y) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const rect = { w: 240, h: 150 };
    const left = Math.min(x, vw - rect.w - 8);
    const top  = Math.min(y, vh - rect.h - 8);
    menu.style.left = left + 'px';
    menu.style.top  = top  + 'px';
    menu.classList.add('open');
  };
  const updatePinLabel = (li) => {
    const el = menu.querySelector('[data-pin-label]');
    const pinned = li?.classList?.contains('is-pinned');
    if (el) el.textContent = pinned ? 'Desafixar conversa' : 'Fixar conversa';
  };

  // ================== Ações ==================
  async function doLabel(clienteId){
    const picked = await labelDialog({ title:'Etiquetar conversa', placeholder:'Ex.: VIP, Financeiro, Suporte', submitText:'Aplicar' });
    if (!picked || !picked.name) return;

    const bodies = [{ add:{ name:picked.name, color:picked.color } }, { add:picked.name }];
    for (let i=0;i<bodies.length;i++){
      try{
        const res = await authFetch(`/api/atendimento/conversas/${clienteId}/labels?empresa_id=${EMPRESA_ID}`, {
          method:'POST', body: JSON.stringify(bodies[i])
        });
        if (res.status === 403) { notify({title:'Sem permissão', msg:'Apenas administradores podem etiquetar.', type:'error'}); return; }
        if (!res.ok) throw new Error(await res.text());
        notify({ title:'Etiqueta aplicada', msg: picked.color && i===0 ? `${picked.name} • ${picked.color}` : `${picked.name}`, type:'ok' });
        return;
      }catch(e){
        if (i === bodies.length-1) notify({title:'Falha ao etiquetar', msg:String(e?.message||e), type:'error'});
      }
    }
  }

  async function doPin(clienteId, li){
    // Se o li foi limpo ao fechar o menu, tenta reencontrar
    if (!li || !li.classList) {
      li = document.querySelector(
        `[data-id="${clienteId}"], .cliente-item[data-id="${clienteId}"], .chat-item[data-id="${clienteId}"], .list-item[data-id="${clienteId}"]`
      );
      if (!li) { notify({ title:'Falha', msg:'Não encontrei o item da conversa na lista.', type:'error' }); return; }
    }

    const willPin = !li.classList.contains('is-pinned');
    const container = li.closest('#lista-clientes, .lista-clientes, [role="list"], .list, ul, ol') || li.parentElement;

    // UI otimista
    if (willPin) {
      ensurePlaceholder(li);          // guarda posição antiga
      markPinned(li, true);           // visual + order:-1 (se flex)
      updatePinLabel(li);
      requestAnimationFrame(() => {   // listas não-flex: sobe pro topo
        reorderByPinned(container);
      });
    } else {
      restoreToPlaceholder(li);       // volta antes do placeholder e remove-o
      markPinned(li, false);          // remove visual
      updatePinLabel(li);
      // reordena os não fixados pelo HORÁRIO (desc)
      requestAnimationFrame(() => {
        resortByTime(container);
      });
    }

    try{
      const res = await authFetch(`/api/atendimento/conversas/${clienteId}/pin?empresa_id=${EMPRESA_ID}`, {
        method: 'POST',
        body: JSON.stringify({ pin: willPin })
      });
      if (res.status === 403) { notify({title:'Sem permissão', msg:'Apenas administradores podem fixar.', type:'error'}); return; }
      if (!res.ok) throw new Error(await res.text().catch(()=> ''));
      notify({title: willPin ? 'Conversa fixada' : 'Conversa desafixada', type:'ok'});
    }catch(e){
      // rollback
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
      notify({title:'Falha ao fixar/desafixar', msg:String(e?.message||e), type:'error'});
    }
  }

  async function doDelete(clienteId, li){
    const ok = await confirmDialog({
      title: 'Apagar conversa',
      msg: 'Apagar da lista? (não remove o cliente nem mensagens do banco)',
      okText: 'Apagar',
      destructive: true
    });
    if (!ok) return;

    try{
      const res = await authFetch(`/api/atendimento/conversas/${clienteId}?empresa_id=${EMPRESA_ID}`, { method: 'DELETE' });
      if (res.status === 403) { notify({title:'Sem permissão', msg:'Apenas administradores podem apagar.', type:'error'}); return; }
      if (!res.ok) throw new Error(await res.text());
      li?.remove();
      try{ if (window.state?.cacheHistoricos) delete window.state.cacheHistoricos[String(clienteId)]; }catch{}
      notify({title:'Conversa apagada da lista', type:'ok'});
    }catch(e){
      notify({title:'Falha ao apagar conversa', msg:String(e?.message||e), type:'error'});
    }
  }

  // Clique nas opções do menu
  menu.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.item');
    if (!btn || !targetLi) return;

    const liCtx = targetLi; // snapshot antes de fechar
    const action = btn.dataset.action;
    const clienteId = Number(liCtx.dataset?.id || liCtx.getAttribute?.('data-id'));
    closeMenu();

    if (!Number.isFinite(clienteId)) {
      notify({ title:'Falha', msg:'Item sem data-id.', type:'error' });
      return;
    }
    if (action === 'label')  return void doLabel(clienteId);
    if (action === 'pin')    return void doPin(clienteId, liCtx);
    if (action === 'delete') return void doDelete(clienteId, liCtx);
  });

  // Fecha menu
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('scroll', closeMenu, true);

  // Abre com botão direito na lista
  const list = document.getElementById('lista-clientes');
  if (!list) return;
  list.addEventListener('contextmenu', (ev) => {
    const li = ev.target.closest('[data-id], .chat-item, .cliente-item, .list-item, li');
    if (!li) return;
    if (!li.dataset.id && !li.getAttribute('data-id')) return;
    ev.preventDefault();
    targetLi = li;
    updatePinLabel(li);
    openMenuAt(ev.clientX, ev.clientY);
  });
})();
