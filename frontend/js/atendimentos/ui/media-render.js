// /frontend/js/atendimentos/ui/media-render.js
// Render de mídias/docs/áudio (player estilo WPP Web)
// + fallback por marcador [Imagem] / [Figurinha] / [Áudio] / [Vídeo] / [Documento]
// + auto-init MutationObserver
// + galeria/mosaico de imagens estilo WhatsApp Web
// + viewer/lightbox escuro
// + suporte a quoted / quoted_preview dentro da bolha

(function () {
  const MEDIA_RENDER_VERSION = 'zc-media-render-viewer-v6-fixed-marker-render';
  if (window.__zcMediaRenderVersion === MEDIA_RENDER_VERSION) return;
  window.__zcMediaRenderVersion = MEDIA_RENDER_VERSION;

  try { if (window.__zcMediaEnsureInterval) clearInterval(window.__zcMediaEnsureInterval); } catch {}
  try { if (window.__zcMediaAvatarInterval) clearInterval(window.__zcMediaAvatarInterval); } catch {}

  try { delete document.__zcMediaViewerBound; } catch {}
  try { delete document.__mediaRenderChatEvt; } catch {}

  document.querySelectorAll('.zc-media-viewer').forEach((el) => el.remove());

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;'
    }[ch]));
  }

  function cleanOneLine(s, fallback = '') {
    const out = String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    return out || fallback;
  }

  function jsonAttr(obj) {
    try {
      if (!obj || typeof obj !== 'object') return '';
      return escapeHtml(JSON.stringify(obj));
    } catch {
      return '';
    }
  }

  function uniq(arr) {
    const out = [];
    const seen = new Set();

    (arr || []).forEach((x) => {
      const v = String(x || '').trim();
      if (!v || seen.has(v)) return;
      seen.add(v);
      out.push(v);
    });

    return out;
  }

  function H() {
    return document.getElementById('historico');
  }

  function ensureMsgMediaCss() {
    if (document.getElementById('zc-media-render-css')) return;

    const st = document.createElement('style');
    st.id = 'zc-media-render-css';
    st.textContent = `
      .zc-quoted-bubble{
        position:relative;
        display:flex;
        gap:8px;
        min-width:0;
        max-width:100%;
        margin:0 0 6px;
        padding:7px 9px 7px 8px;
        border-radius:8px;
        overflow:hidden;
        background:rgba(255,255,255,.08);
        cursor:pointer;
      }

      .bubble-in .zc-quoted-bubble{
        background:rgba(255,255,255,.07);
      }

      .bubble-out .zc-quoted-bubble{
        background:rgba(0,0,0,.16);
      }

      html[data-theme="light"] .zc-quoted-bubble{
        background:rgba(0,0,0,.06);
      }

      html[data-theme="light"] .bubble-out .zc-quoted-bubble{
        background:rgba(0,0,0,.10);
      }

      .zc-quoted-bar{
        width:3px;
        flex:0 0 3px;
        border-radius:8px;
        background:#53bdeb;
      }

      .bubble-out .zc-quoted-bar{
        background:#06cf9c;
      }

      .zc-quoted-content{
        min-width:0;
        flex:1 1 auto;
        overflow:hidden;
      }

      .zc-quoted-author{
        font-size:12px;
        line-height:1.2;
        font-weight:700;
        color:#53bdeb;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
        margin-bottom:2px;
      }

      .bubble-out .zc-quoted-author{
        color:#06cf9c;
      }

      .zc-quoted-text{
        font-size:12.5px;
        line-height:1.25;
        color:rgba(255,255,255,.82);
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }

      html[data-theme="light"] .zc-quoted-text{
        color:rgba(17,24,39,.76);
      }

      .msg-media-img,
      .msg-media-cell{
        display:block;
        position:relative;
        overflow:hidden;
        border-radius:8px;
        max-width:100%;
        text-decoration:none;
        background:rgba(0,0,0,.12);
      }

      .msg-media-img img,
      .msg-media-cell img{
        display:block;
        width:100%;
        max-width:320px;
        max-height:420px;
        object-fit:cover;
        border-radius:8px;
      }

      .bubble.has-media-single{
        padding:4px 4px 6px;
      }

      .bubble.has-media-single .msg-media-img img{
        max-width:330px;
      }

      .msg-sticker{
        display:block;
        max-width:170px;
        max-height:170px;
        object-fit:contain;
        background:transparent;
      }

      .msg-media-video{
        display:block;
        width:100%;
        max-width:330px;
        max-height:420px;
        border-radius:8px;
        background:#000;
      }

      .msg-media-group{
        display:grid;
        gap:2px;
        overflow:hidden;
        border-radius:8px;
        max-width:330px;
        background:rgba(0,0,0,.18);
      }

      .msg-media-group[data-count="1"]{
        grid-template-columns:1fr;
      }

      .msg-media-group[data-count="2"]{
        grid-template-columns:1fr 1fr;
      }

      .msg-media-group[data-count="3"]{
        grid-template-columns:1fr 1fr;
      }

      .msg-media-group[data-count="3"] .cell-1{
        grid-row:span 2;
      }

      .msg-media-group[data-count="4"]{
        grid-template-columns:1fr 1fr;
      }

      .msg-media-cell img{
        width:100%;
        height:160px;
        max-width:none;
        max-height:none;
        object-fit:cover;
      }

      .msg-media-group[data-count="2"] .msg-media-cell img{
        height:190px;
      }

      .msg-media-group[data-count="3"] .cell-1 img{
        height:322px;
      }

      .msg-media-more{
        position:absolute;
        inset:0;
        display:flex;
        align-items:center;
        justify-content:center;
        background:rgba(0,0,0,.45);
        color:#fff;
        font-size:30px;
        font-weight:700;
      }

      .doc-card{
        display:flex;
        align-items:center;
        gap:10px;
        min-width:240px;
        max-width:330px;
        padding:10px;
        border-radius:9px;
        background:rgba(0,0,0,.18);
      }

      html[data-theme="light"] .doc-card{
        background:rgba(0,0,0,.06);
      }

      .doc-ico{
        width:42px;
        height:48px;
        border-radius:8px;
        display:flex;
        align-items:center;
        justify-content:center;
        background:rgba(255,255,255,.12);
        flex:0 0 auto;
      }

      html[data-theme="light"] .doc-ico{
        background:rgba(0,0,0,.08);
      }

      .doc-ico .ext{
        font-size:10px;
        font-weight:800;
        letter-spacing:.4px;
      }

      .doc-body{
        min-width:0;
        flex:1 1 auto;
      }

      .doc-name{
        display:block;
        color:inherit;
        font-size:13px;
        font-weight:600;
        text-decoration:none;
        overflow:hidden;
        white-space:nowrap;
        text-overflow:ellipsis;
      }

      .doc-meta{
        margin-top:3px;
        font-size:11px;
        opacity:.68;
      }

      .doc-actions{
        display:flex;
        flex-direction:column;
        gap:4px;
        flex:0 0 auto;
      }

      .doc-btn{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        min-width:48px;
        height:24px;
        padding:0 8px;
        border-radius:999px;
        font-size:11px;
        color:inherit;
        text-decoration:none;
        background:rgba(255,255,255,.10);
      }

      html[data-theme="light"] .doc-btn{
        background:rgba(0,0,0,.07);
      }

      .wa-audio{
        --p:0%;
        display:flex;
        align-items:center;
        gap:10px;
        min-width:250px;
        max-width:330px;
        padding:8px 8px;
        border-radius:9px;
      }

      .wa-left{
        display:flex;
        align-items:center;
        gap:8px;
        flex:0 0 auto;
      }

      .wa-avatar{
        width:38px;
        height:38px;
        border-radius:50%;
        position:relative;
        overflow:hidden;
        background:rgba(255,255,255,.14);
        flex:0 0 38px;
      }

      .wa-avatar img,
      .wa-avatar .ph{
        position:absolute;
        inset:0;
        width:100%;
        height:100%;
      }

      .wa-avatar img{
        object-fit:cover;
      }

      .wa-avatar .ph{
        display:flex;
        align-items:center;
        justify-content:center;
        color:rgba(255,255,255,.68);
      }

      .wa-avatar .ph svg{
        width:23px;
        height:23px;
      }

      .wa-avatar .mic{
        position:absolute;
        right:-1px;
        bottom:-1px;
        width:16px;
        height:16px;
        border-radius:50%;
        display:flex;
        align-items:center;
        justify-content:center;
        background:#06cf9c;
        color:#071b14;
      }

      .wa-avatar .mic svg{
        width:11px;
        height:11px;
      }

      .wa-play{
        width:34px;
        height:34px;
        border:0;
        border-radius:50%;
        display:flex;
        align-items:center;
        justify-content:center;
        cursor:pointer;
        color:inherit;
        background:rgba(255,255,255,.12);
      }

      html[data-theme="light"] .wa-play{
        background:rgba(0,0,0,.08);
      }

      .wa-play svg{
        width:20px;
        height:20px;
      }

      .wa-speed{
        border:0;
        height:25px;
        min-width:42px;
        border-radius:999px;
        cursor:pointer;
        font-size:11px;
        font-weight:700;
        color:inherit;
        background:rgba(255,255,255,.12);
      }

      html[data-theme="light"] .wa-speed{
        background:rgba(0,0,0,.08);
      }

      .wa-main{
        min-width:0;
        flex:1 1 auto;
      }

      .wa-wave{
        position:relative;
        height:24px;
        cursor:pointer;
        outline:none;
      }

      .wa-wave .dots{
        position:absolute;
        left:0;
        right:0;
        top:50%;
        height:4px;
        transform:translateY(-50%);
        border-radius:999px;
        background:rgba(255,255,255,.26);
      }

      html[data-theme="light"] .wa-wave .dots{
        background:rgba(0,0,0,.18);
      }

      .wa-wave .fill{
        position:absolute;
        left:0;
        top:50%;
        width:var(--p);
        height:4px;
        transform:translateY(-50%);
        border-radius:999px;
        background:#06cf9c;
      }

      .wa-wave .knob{
        position:absolute;
        left:var(--p);
        top:50%;
        width:10px;
        height:10px;
        border-radius:50%;
        transform:translate(-50%,-50%);
        background:#06cf9c;
        box-shadow:0 1px 4px rgba(0,0,0,.25);
      }

      .wa-len{
        margin-top:1px;
        font-size:11px;
        opacity:.68;
      }

      .zc-media-viewer{
        position:fixed;
        inset:0;
        z-index:99999;
        display:none;
        color:#e9edef;
      }

      .zc-media-viewer.is-open{
        display:block;
      }

      .zc-media-viewer__backdrop{
        position:absolute;
        inset:0;
        background:rgba(11,20,26,.96);
      }

      .zc-media-viewer__top{
        position:absolute;
        z-index:2;
        top:0;
        left:0;
        right:0;
        height:58px;
        display:flex;
        align-items:center;
        justify-content:space-between;
        padding:0 18px;
        box-sizing:border-box;
        background:linear-gradient(to bottom, rgba(0,0,0,.38), rgba(0,0,0,0));
      }

      .zc-media-viewer__count{
        font-size:12px;
        opacity:.75;
      }

      .zc-media-viewer__name{
        font-size:14px;
        font-weight:600;
        max-width:65vw;
        overflow:hidden;
        white-space:nowrap;
        text-overflow:ellipsis;
      }

      .zc-media-viewer__icon-btn,
      .zc-media-viewer__nav{
        border:0;
        color:#e9edef;
        background:rgba(255,255,255,.08);
        cursor:pointer;
      }

      .zc-media-viewer__icon-btn{
        width:38px;
        height:38px;
        border-radius:50%;
        display:flex;
        align-items:center;
        justify-content:center;
      }

      .zc-media-viewer__icon-btn svg{
        width:22px;
        height:22px;
      }

      .zc-media-viewer__stage{
        position:absolute;
        inset:58px 72px 88px;
        z-index:1;
        display:flex;
        align-items:center;
        justify-content:center;
      }

      .zc-media-viewer__frame{
        width:100%;
        height:100%;
        display:flex;
        align-items:center;
        justify-content:center;
      }

      .zc-media-viewer__media-wrap{
        width:100%;
        height:100%;
        display:flex;
        align-items:center;
        justify-content:center;
      }

      .zc-media-viewer__img,
      .zc-media-viewer__video{
        max-width:100%;
        max-height:100%;
        object-fit:contain;
        border-radius:4px;
      }

      .zc-media-viewer__nav{
        position:absolute;
        z-index:2;
        top:50%;
        width:46px;
        height:46px;
        border-radius:50%;
        display:flex;
        align-items:center;
        justify-content:center;
        transform:translateY(-50%);
      }

      .zc-media-viewer__nav svg{
        width:25px;
        height:25px;
      }

      .zc-media-viewer__nav--prev{
        left:16px;
      }

      .zc-media-viewer__nav--next{
        right:16px;
      }

      .zc-media-viewer__thumbs{
        position:absolute;
        z-index:2;
        left:0;
        right:0;
        bottom:0;
        min-height:74px;
        display:flex;
        align-items:center;
        justify-content:center;
        gap:8px;
        padding:10px 16px;
        box-sizing:border-box;
        background:linear-gradient(to top, rgba(0,0,0,.45), rgba(0,0,0,0));
      }

      .zc-media-viewer__thumb{
        width:52px;
        height:52px;
        border:2px solid transparent;
        border-radius:8px;
        overflow:hidden;
        padding:0;
        cursor:pointer;
        background:rgba(255,255,255,.08);
      }

      .zc-media-viewer__thumb.is-active{
        border-color:#06cf9c;
      }

      .zc-media-viewer__thumb img{
        width:100%;
        height:100%;
        object-fit:cover;
        display:block;
      }

      .zc-media-viewer__empty{
        opacity:.75;
      }

      body.zc-media-viewer-open{
        overflow:hidden;
      }

      @media (max-width:720px){
        .zc-media-viewer__stage{
          inset:58px 10px 88px;
        }

        .zc-media-viewer__nav{
          display:none !important;
        }

        .msg-media-img img,
        .bubble.has-media-single .msg-media-img img,
        .msg-media-video{
          max-width:76vw;
        }

        .doc-card,
        .wa-audio{
          max-width:76vw;
          min-width:220px;
        }
      }
    `;
    document.head.appendChild(st);
  }

  function _humanSize(bytes) {
    const b = Number(bytes || 0);
    if (!b) return '';

    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return `${(b / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function _basenameFromUrl(u) {
    try {
      const p = new URL(u, location.origin).pathname;
      const b = p.split('/').pop() || '';
      return decodeURIComponent(b);
    } catch {
      return '';
    }
  }

  function _guessExt({ mimetype = '', filename = '', url = '' } = {}) {
    const fromName =
      (filename || '').split('.').pop()?.toLowerCase() ||
      _basenameFromUrl(url).split('.').pop()?.toLowerCase() ||
      '';

    const map = {
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.ms-powerpoint': 'ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'text/plain': 'txt',
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/webp': 'webp',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'video/mp4': 'mp4'
    };

    return (map[String(mimetype || '').toLowerCase()] || fromName || 'bin').toLowerCase();
  }

  function _sanitizeBase(name) {
    const n = (name || '').toString().trim() || 'arquivo';
    return n
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\-.]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
  }

  function deriveFileName(a = {}) {
    const url = a.url || a.link || a.path || '';
    const baseRaw =
      a.filename ||
      a.name ||
      a.nome_original ||
      a.fileName ||
      _basenameFromUrl(url) ||
      'arquivo';

    const base = _sanitizeBase(String(baseRaw).replace(/\.[a-z0-9]{1,8}$/i, ''));
    const ext = _guessExt({
      mimetype: a.mimetype || a.mime || '',
      filename: a.filename || a.name || a.fileName || '',
      url
    });

    return {
      fileName: `${base}.${ext}`,
      extUp: ext.toUpperCase(),
      extLower: ext.toLowerCase()
    };
  }

  function _empId() {
    return window.EMPRESA_ID ?? window.empresa_id ?? window.state?.empresa_id ?? localStorage.getItem('empresa_id') ?? null;
  }

  function _instQ() {
    try {
      if (typeof window._instQuery === 'function') return window._instQuery() || '';

      const inst =
        window.INSTANCIA_ATIVA ??
        window.state?.clienteSel?.instancia_id ??
        window.clienteSel?.instancia_id ??
        document.getElementById('historico')?.dataset?.instanciaId ??
        null;

      if (!inst) return '';
      const s = String(inst).trim();
      if (!s) return '';
      return /^\d+$/.test(s) ? `&instancia_id=${encodeURIComponent(s)}` : `&instance=${encodeURIComponent(s)}`;
    } catch {
      return '';
    }
  }

  function _applyInstToQS(qs, instQ) {
    const raw = String(instQ || '').trim();
    if (!raw) return;

    const s = raw.replace(/^\?/, '').replace(/^\&/, '');
    s.split('&')
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((pair) => {
        const i = pair.indexOf('=');
        const k = i >= 0 ? pair.slice(0, i) : pair;
        const v = i >= 0 ? pair.slice(i + 1) : '';
        if (k) qs.set(k, v);
      });
  }

  function buildCanonUrlByMsgId(msg_id) {
    const base = `/api/atendimento/midias/msg/${encodeURIComponent(String(msg_id))}`;
    const qs = new URLSearchParams();

    const eid = _empId();
    if (eid) qs.set('empresa_id', String(eid));
    _applyInstToQS(qs, _instQ());

    const q = qs.toString();
    return q ? `${base}?${q}` : base;
  }

  function resolveUrlsForMedia(m, a) {
    const MSG_CANON = m?.msg_id ? buildCanonUrlByMsgId(m.msg_id) : null;

    const qs = new URLSearchParams();
    const eid = _empId();
    if (eid) qs.set('empresa_id', String(eid));
    _applyInstToQS(qs, _instQ());
    const q = qs.toString();

    const idUrl = a?.id
      ? `/api/atendimento/midias/${encodeURIComponent(String(a.id))}${q ? `?${q}` : ''}`
      : '';

    const primary = MSG_CANON || a?.url_api || a?.url || a?.link || a?.path || idUrl;
    const alts = [];

    if (MSG_CANON) {
      [a?.url_api, a?.url, a?.link, a?.path, idUrl].forEach((u) => u && alts.push(u));
    }

    const seen = new Set();
    return [primary, ...alts].filter((u) => u && !seen.has(u) && seen.add(u));
  }

  const AVATAR_SELS = [
    '#chat-avatar img[data-cliente-id]',
    '#chat-avatar img',
    '#chat-header #chat-avatar img'
  ];

  function _qAny(sels) {
    for (let i = 0; i < sels.length; i += 1) {
      const el = document.querySelector(sels[i]);
      if (el) return el;
    }
    return null;
  }

  function _currentClienteId() {
    const s = window.state?.clienteSel || window.clienteSel || {};
    const cid = s.id ?? s.cliente_id ?? s.entity_id ?? s.backend_id ?? null;
    return cid == null ? '' : String(cid);
  }

  function getCurrentChatAvatarUrl() {
    const sel = window.state?.clienteSel || window.clienteSel || {};
    const u1 = sel.avatar_url;
    if (u1) return String(u1);

    const img = _qAny(AVATAR_SELS);
    const src = img?.getAttribute('src') || img?.src || '';
    if (!src || /^data:\s*$/i.test(src)) return '';

    const curCid = _currentClienteId();
    const imgCid = img?.getAttribute('data-cliente-id') || img?.dataset?.clienteId || '';
    if (curCid && imgCid && String(imgCid) !== curCid) return '';

    return String(src);
  }

  function setAudioAvatar(el, url) {
    if (!el) return;

    const img = el.querySelector('.wa-avatar img');
    const ph = el.querySelector('.wa-avatar .ph');
    if (!img) return;

    const u = String(url || '').trim();
    if (!u) {
      img.removeAttribute('src');
      if (ph) ph.style.display = '';
      return;
    }

    if (img.dataset.cur === u) return;
    img.dataset.cur = u;
    img.src = u;

    img.onload = () => {
      if (ph) ph.style.display = 'none';
    };

    img.onerror = () => {
      img.removeAttribute('src');
      if (ph) ph.style.display = '';
    };
  }

  function _fmtT(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function _playIconSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M8 5v14l12-7-12-7Z"></path>
      </svg>
    `;
  }

  function _pauseIconSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M7 5h4v14H7zM13 5h4v14h-4z"></path>
      </svg>
    `;
  }

  function _closeIconSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
      </svg>
    `;
  }

  function _chevronLeftSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M15 18 9 12l6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  function _chevronRightSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m9 18 6-6-6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  function _makeWaAudioHTML(urls, opts) {
    opts = opts || {};
    const dir = opts.dir === 'out' ? 'out' : 'in';
    const list = uniq(urls);

    const avatarHtml = dir === 'in'
      ? `
      <div class="wa-avatar" aria-hidden="true">
        <img alt="">
        <span class="ph">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 12c2.21 0 4-1.79 4-4S14.21 4 12 4 8 5.79 8 8s1.79 4 4 4Z" stroke="currentColor" stroke-width="2"/>
            <path d="M20 20a8 8 0 1 0-16 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </span>
        <span class="mic" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v4a3 3 0 0 0 3 3Z" stroke="currentColor" stroke-width="2"/>
            <path d="M19 11a7 7 0 0 1-14 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </span>
      </div>`
      : '';

    const speedHtml = dir === 'out'
      ? `<button class="wa-speed" type="button">1.0x</button>`
      : '';

    return `
<div class="wa-audio" data-src="${escapeHtml(list.join('|'))}" data-dir="${dir}">
  <div class="wa-left">
    ${avatarHtml}
    ${speedHtml}
    <button class="wa-play" type="button" aria-label="Tocar/Pausar">
      ${_playIconSvg()}
    </button>
  </div>

  <div class="wa-main">
    <div class="wa-wave" role="slider" aria-label="Progresso" tabindex="0">
      <div class="dots"></div>
      <div class="fill"></div>
      <div class="knob"></div>
    </div>
    <div class="wa-len">0:00</div>
  </div>
</div>`;
  }

  function initAudioPlayers(root) {
    (root || document).querySelectorAll('.wa-audio').forEach((el) => {
      if (el._ok) return;
      el._ok = true;

      const srcs = uniq((el.getAttribute('data-src') || '').split('|'));
      let idx = 0;

      const dir = (el.getAttribute('data-dir') || 'in').toLowerCase() === 'out' ? 'out' : 'in';
      const btnPlay = el.querySelector('.wa-play');
      const btnSpeed = el.querySelector('.wa-speed');
      const wave = el.querySelector('.wa-wave');
      const lenEl = el.querySelector('.wa-len');

      const audio = new Audio(srcs[0] || '');
      audio.preload = 'metadata';

      window.__ZC_AUDIO__ = window.__ZC_AUDIO__ || new Set();
      window.__ZC_AUDIO__.add(audio);

      const pauseOthers = () => {
        try {
          window.__ZC_AUDIO__.forEach((a) => {
            if (a !== audio) a.pause();
          });
        } catch {}
      };

      const setPlayButtonState = (playing) => {
        if (!btnPlay) return;
        btnPlay.innerHTML = playing ? _pauseIconSvg() : _playIconSvg();
      };

      const tryNext = () => {
        if (idx < srcs.length - 1) {
          idx += 1;
          audio.src = srcs[idx];
          try { audio.load(); } catch {}
          if (!audio.paused) audio.play().catch(() => {});
        }
      };

      function setProgress(pct) {
        const p = Math.max(0, Math.min(100, Number(pct) || 0));
        el.style.setProperty('--p', p + '%');
      }

      function updateFromAudio() {
        if (isFinite(audio.duration) && audio.duration > 0) {
          const pct = (audio.currentTime / audio.duration) * 100;
          setProgress(pct);
        } else {
          setProgress(0);
        }
      }

      function setFromClientX(clientX) {
        if (!wave) return;
        const rect = wave.getBoundingClientRect();
        const p = rect.width ? (clientX - rect.left) / rect.width : 0;
        const clamped = Math.max(0, Math.min(1, p));

        if (isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = clamped * audio.duration;
          updateFromAudio();
        } else {
          setProgress(clamped * 100);
        }
      }

      btnPlay && btnPlay.addEventListener('click', () => {
        if (audio.paused) {
          pauseOthers();
          audio.play().catch(() => {});
        } else {
          audio.pause();
        }
      });

      if (btnSpeed) {
        const cycle = [1.0, 1.5, 2.0];
        btnSpeed.addEventListener('click', () => {
          const cur = Number(audio.playbackRate || 1.0);
          const i = cycle.findIndex((x) => Math.abs(x - cur) < 0.01);
          const next = cycle[(i + 1 + cycle.length) % cycle.length];
          audio.playbackRate = next;
          btnSpeed.textContent = `${next.toFixed(1)}x`;
        });
      }

      let dragging = false;
      if (wave) {
        wave.addEventListener('pointerdown', (e) => {
          dragging = true;
          try { wave.setPointerCapture(e.pointerId); } catch {}
          setFromClientX(e.clientX);
          e.preventDefault();
        });

        wave.addEventListener('pointermove', (e) => {
          if (!dragging) return;
          setFromClientX(e.clientX);
          e.preventDefault();
        });

        const endDrag = () => { dragging = false; };
        wave.addEventListener('pointerup', endDrag);
        wave.addEventListener('pointercancel', endDrag);

        wave.addEventListener('keydown', (e) => {
          if (!isFinite(audio.duration) || audio.duration <= 0) return;
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

          e.preventDefault();
          const delta = e.key === 'ArrowRight' ? 2 : -2;
          audio.currentTime = Math.max(0, Math.min(audio.duration, (audio.currentTime || 0) + delta));
          updateFromAudio();
        });
      }

      audio.addEventListener('play', () => {
        el.setAttribute('data-playing', '1');
        setPlayButtonState(true);
      });

      audio.addEventListener('pause', () => {
        el.removeAttribute('data-playing');
        setPlayButtonState(false);
      });

      audio.addEventListener('loadedmetadata', () => {
        if (lenEl) lenEl.textContent = _fmtT(audio.duration || 0);
        updateFromAudio();
      });

      audio.addEventListener('durationchange', () => {
        if (lenEl && isFinite(audio.duration)) lenEl.textContent = _fmtT(audio.duration || 0);
      });

      audio.addEventListener('timeupdate', updateFromAudio);

      audio.addEventListener('ended', () => {
        el.removeAttribute('data-playing');
        setPlayButtonState(false);
        setProgress(0);
      });

      audio.addEventListener('error', tryNext);

      if (dir === 'in') {
        const u = getCurrentChatAvatarUrl();
        setAudioAvatar(el, u);
      }

      setPlayButtonState(false);
    });
  }

  function refreshAudioAvatars(root) {
    const url = getCurrentChatAvatarUrl();
    if (!url) return;

    (root || document).querySelectorAll('.wa-audio[data-dir="in"]').forEach((el) => {
      setAudioAvatar(el, url);
    });
  }

  function initMediaFallbacks(root) {
    root = root || document;

    root.querySelectorAll('img[data-alt]').forEach((img) => {
      if (img._fb) return;
      img._fb = true;

      img.addEventListener('error', () => {
        const list = (img.dataset.alt || '').split('|').filter(Boolean);
        if (!list.length) return;
        img.src = list.shift();
        img.dataset.alt = list.join('|');
      });
    });

    root.querySelectorAll('video[data-alt]').forEach((v) => {
      if (v._fb) return;
      v._fb = true;

      v.addEventListener('error', () => {
        const list = (v.dataset.alt || '').split('|').filter(Boolean);
        if (!list.length) return;
        v.src = list.shift();
        v.dataset.alt = list.join('|');
        try { v.load(); } catch {}
      }, { passive: true });
    });
  }

  const MARKER_RE = /^\[(Imagem|Vídeo|Video|Áudio\/ptt|Áudio|Audio|Documento|Figurinha|Localização|Contatos?|M[íi]dia)\]/i;

  function markerKind(txt) {
    return String(txt || '')
      .replace(/^\[/, '')
      .replace(/\].*$/g, '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function upgradeNativeAudios(root) {
    root = root || document;

    root.querySelectorAll('audio[controls]:not([data-up-wa="1"])').forEach((a) => {
      a.setAttribute('data-up-wa', '1');

      const srcs = [];
      const s1 = a.getAttribute('src') || a.currentSrc || a.src || '';
      if (s1) srcs.push(s1);

      a.querySelectorAll('source').forEach((s) => {
        const u = s.getAttribute('src') || s.src || '';
        if (u) srcs.push(u);
      });

      const alt = a.dataset?.alt ? String(a.dataset.alt) : '';
      if (alt) alt.split('|').forEach((u) => srcs.push(u));

      const urls = uniq(srcs);
      if (!urls.length) return;

      const bubble = a.closest('.bubble');
      const dir = bubble?.classList.contains('bubble-out') ? 'out' : 'in';

      const wrap = document.createElement('div');
      wrap.innerHTML = _makeWaAudioHTML(urls, { dir });
      const node = wrap.firstElementChild;
      if (!node) return;

      a.replaceWith(node);
    });
  }

  function injectMarkerMedias(root) {
    root = root || document;

    root.querySelectorAll('.msg-row').forEach((row) => {
      const bubble = row.querySelector('.bubble');
      if (!bubble) return;

      if (bubble.querySelector('.wa-audio, audio[controls], .msg-media-img, .msg-media-video, .msg-sticker, .doc-card, .msg-media-group')) {
        return;
      }

      const txtEl = bubble.querySelector('.msg-text');
      const txt = (txtEl?.textContent || '').trim();
      if (!MARKER_RE.test(txt)) return;

      const msgId =
        row.getAttribute('data-msg-id') ||
        bubble.getAttribute('data-msg-id') ||
        row.getAttribute('data-id') ||
        '';

      if (!msgId) return;

      const src = buildCanonUrlByMsgId(msgId);
      const kind = markerKind(txt);
      const dir = bubble.classList.contains('bubble-out') ? 'out' : 'in';

      let html = '';

      if (kind.startsWith('imagem') || kind.startsWith('midia')) {
        html = `<a
          class="msg-media-img msg-media-img--single"
          href="${escapeHtml(src)}"
          data-media-view="1"
          data-zc-media-open="1"
          data-media-kind="image"
          data-media-src="${escapeHtml(src)}"
          data-media-thumb="${escapeHtml(src)}"
          data-media-name="imagem"
          data-name="imagem"
        >
          <img src="${escapeHtml(src)}" alt="imagem" loading="lazy">
        </a>`;
        bubble.classList.add('has-media-single');
      } else if (kind.startsWith('figurinha')) {
        html = `<img class="msg-sticker" src="${escapeHtml(src)}" alt="figurinha" loading="lazy">`;
      } else if (kind.startsWith('video')) {
        html = `<video class="msg-media-video" controls preload="metadata" src="${escapeHtml(src)}"></video>`;
      } else if (kind.startsWith('audio')) {
        html = _makeWaAudioHTML([src], { dir });
      } else if (kind.startsWith('documento')) {
        const fname = 'arquivo.bin';
        html = `<div class="doc-card">
          <div class="doc-ico" data-ext="bin"><span class="ext">FILE</span></div>
          <div class="doc-body">
            <a class="doc-name" href="${escapeHtml(src)}" target="_blank" rel="noopener" download="${fname}" title="${fname}">${fname}</a>
            <div class="doc-meta">arquivo</div>
          </div>
          <div class="doc-actions">
            <a class="doc-btn" href="${escapeHtml(src)}" target="_blank" rel="noopener">Abrir</a>
            <a class="doc-btn" href="${escapeHtml(src)}" download="${fname}">Salvar</a>
          </div>
        </div>`;
      }

      if (!html) return;

      bubble.insertAdjacentHTML('afterbegin', html);

      if (txtEl && /^\[[^\]]+\]$/i.test(txt)) {
        txtEl.style.display = 'none';
      }
    });
  }

  function isImageAttachment(a) {
    const mime = String(a?.mimetype || a?.mime || '').toLowerCase();
    const tipo = String(a?.tipo || a?.tipo_midia || '').toLowerCase();

    return (
      tipo.includes('imagem') ||
      tipo.includes('image') ||
      tipo.includes('figurinha') ||
      tipo.includes('sticker') ||
      mime.startsWith('image/')
    );
  }

  function isGalleryImageAttachment(a) {
    const mime = String(a?.mimetype || a?.mime || '').toLowerCase();
    const tipo = String(a?.tipo || a?.tipo_midia || '').toLowerCase();
    const isSticker = tipo.includes('figurinha') || tipo.includes('sticker');

    return mime.startsWith('image/') && !isSticker;
  }

  function buildViewerItemsFromAttachments(m, list) {
    return (list || []).map((a) => {
      const urls = resolveUrlsForMedia(m, a);
      const src = urls[0] || '';
      const name = a.filename || a.name || 'imagem';
      return {
        type: 'image',
        src,
        thumb: src,
        name
      };
    }).filter((x) => x.src);
  }

  function encodeViewerItems(items) {
    try {
      return encodeURIComponent(JSON.stringify(items || []));
    } catch {
      return '';
    }
  }

  function decodeViewerItems(raw) {
    try {
      const arr = JSON.parse(decodeURIComponent(String(raw || '')));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function renderImageCell(m, a, idx, extraClass = '', overlay = '') {
    const urls = resolveUrlsForMedia(m, a);
    const [url, ...alts] = urls;
    const name = a.filename || a.name || 'imagem';

    return `
      <a
        class="msg-media-cell ${extraClass}"
        href="${escapeHtml(url)}"
        target="_blank"
        rel="noopener"
        data-zc-media-open="1"
        data-viewer-index="${idx}"
        data-kind="image"
        data-name="${escapeHtml(name)}"
      >
        <img src="${escapeHtml(url)}" data-alt="${escapeHtml(alts.join('|'))}" alt="${escapeHtml(name)}" loading="lazy">
        ${overlay ? `<span class="msg-media-more">+${escapeHtml(overlay)}</span>` : ''}
      </a>
    `;
  }

  function renderImageGroup(m, list) {
    const total = list.length;
    const visible = list.slice(0, Math.min(total, 4));
    const viewerItems = buildViewerItemsFromAttachments(m, list);

    return `
      <div
        class="msg-media-group"
        data-count="${visible.length}"
        data-total="${total}"
        data-viewer-items="${escapeHtml(encodeViewerItems(viewerItems))}"
      >
        ${visible.map((a, idx) => {
          const overlay = idx === 3 && total > 4 ? String(total - 4) : '';
          return renderImageCell(m, a, idx, `cell-${idx + 1}`, overlay);
        }).join('')}
      </div>
    `;
  }

  function buildImageGroupFromExisting(items) {
    const total = items.length;
    const visible = items.slice(0, Math.min(total, 4));

    return `
      <div
        class="msg-media-group"
        data-front-grouped="1"
        data-count="${visible.length}"
        data-total="${total}"
        data-viewer-items="${escapeHtml(encodeViewerItems(items))}"
      >
        ${visible.map((item, idx) => {
          const overlay = idx === 3 && total > 4 ? String(total - 4) : '';
          return `
            <a
              class="msg-media-cell cell-${idx + 1}"
              href="${escapeHtml(item.src)}"
              target="_blank"
              rel="noopener"
              data-zc-media-open="1"
              data-viewer-index="${idx}"
              data-kind="image"
              data-name="${escapeHtml(item.name)}"
            >
              <img
                src="${escapeHtml(item.thumb || item.src)}"
                data-alt="${escapeHtml(item.altList || '')}"
                alt="${escapeHtml(item.name)}"
                loading="lazy"
              >
              ${overlay ? `<span class="msg-media-more">+${escapeHtml(overlay)}</span>` : ''}
            </a>
          `;
        }).join('')}
      </div>
    `;
  }

  function getStandaloneImageRowInfo(row) {
    if (!row || row.dataset.frontGroupHidden === '1') return null;

    const bubble = row.querySelector('.bubble');
    if (!bubble) return null;
    if (bubble.dataset.frontGroupMaster === '1') return null;
    if (bubble.querySelector('.msg-media-group')) return null;

    const medias = bubble.querySelectorAll('.msg-media-img');
    if (medias.length !== 1) return null;

    if (bubble.querySelector('.msg-media-video, .msg-sticker, .doc-card, .wa-audio')) return null;

    const anchor = medias[0];
    const img = anchor.querySelector('img');
    if (!img) return null;

    const txtEl = bubble.querySelector('.msg-text');
    const txt = (txtEl?.textContent || '').trim();

    if (txt && !/^\[[^\]]+\]$/i.test(txt)) return null;

    return {
      row,
      bubble,
      anchor,
      img,
      dir: bubble.classList.contains('bubble-out') ? 'out' : 'in',
      metaHtml: bubble.querySelector('.meta')?.innerHTML || '',
      href: anchor.getAttribute('href') || img.getAttribute('src') || '',
      src: img.getAttribute('src') || '',
      altList: img.dataset.alt || '',
      name: img.getAttribute('alt') || 'imagem'
    };
  }

  function restoreFrontGroupedRows(root) {
    const scope = root || document;

    scope.querySelectorAll('.msg-row[data-front-group-hidden="1"]').forEach((row) => {
      row.style.display = '';
      delete row.dataset.frontGroupHidden;
    });

    scope.querySelectorAll('.bubble[data-front-group-master="1"]').forEach((bubble) => {
      const grouped = bubble.querySelector('.msg-media-group[data-front-grouped="1"]');
      if (grouped) grouped.remove();

      if (bubble.dataset.frontGroupOriginalMediaHtml) {
        bubble.insertAdjacentHTML('afterbegin', bubble.dataset.frontGroupOriginalMediaHtml);
      }

      const meta = bubble.querySelector('.meta');
      if (meta && bubble.dataset.frontGroupOriginalMetaHtml) {
        meta.innerHTML = bubble.dataset.frontGroupOriginalMetaHtml;
      }

      bubble.classList.remove('has-media-group');

      delete bubble.dataset.frontGroupMaster;
      delete bubble.dataset.frontGroupOriginalMediaHtml;
      delete bubble.dataset.frontGroupOriginalMetaHtml;
    });
  }

  function groupConsecutiveImageRows(root) {
    const hist =
      root?.id === 'historico'
        ? root
        : root?.querySelector?.('#historico') || H();

    if (!hist) return;

    restoreFrontGroupedRows(hist);

    const rows = [...hist.querySelectorAll('.msg-row')];
    let i = 0;

    while (i < rows.length) {
      const first = getStandaloneImageRowInfo(rows[i]);

      if (!first) {
        i += 1;
        continue;
      }

      const group = [first];
      let j = i + 1;

      while (j < rows.length) {
        const next = getStandaloneImageRowInfo(rows[j]);
        if (!next) break;
        if (next.dir !== first.dir) break;
        group.push(next);
        j += 1;
      }

      if (group.length > 1) {
        const items = group.map((x) => ({
          type: 'image',
          src: x.href || x.src,
          thumb: x.src,
          altList: x.altList,
          name: x.name
        }));

        first.bubble.dataset.frontGroupMaster = '1';
        first.bubble.dataset.frontGroupOriginalMediaHtml = first.anchor.outerHTML;
        first.bubble.dataset.frontGroupOriginalMetaHtml = first.metaHtml;

        first.anchor.remove();
        first.bubble.insertAdjacentHTML('afterbegin', buildImageGroupFromExisting(items));
        first.bubble.classList.add('has-media-group');

        const meta = first.bubble.querySelector('.meta');
        if (meta) {
          meta.innerHTML = group[group.length - 1].metaHtml;
        }

        for (let k = 1; k < group.length; k += 1) {
          group[k].row.dataset.frontGroupHidden = '1';
          group[k].row.style.display = 'none';
        }
      }

      i = j;
    }
  }

  function firstTextFromQuotedMessageObject(message) {
    if (!message || typeof message !== 'object') return '';

    return cleanOneLine(
      message.conversation ||
      message?.extendedTextMessage?.text ||
      message?.imageMessage?.caption ||
      message?.videoMessage?.caption ||
      message?.documentMessage?.caption ||
      ''
    );
  }

  function mediaLabelFromQuotedMessageObject(message) {
    if (!message || typeof message !== 'object') return '';

    if (message.imageMessage) return '[imagem]';
    if (message.videoMessage) return '[vídeo]';
    if (message.audioMessage) return '[áudio]';
    if (message.documentMessage) return '[documento]';
    if (message.stickerMessage) return '[figurinha]';
    if (message.locationMessage) return '[localização]';
    if (message.contactMessage || message.contactsArrayMessage) return '[contato]';

    return '';
  }

  function normalizeQuotedPreviewFromMsg(m) {
    const direct =
      m?.quoted_preview ||
      m?.quotedPreview ||
      m?.reply_preview ||
      m?.replyPreview ||
      null;

    if (direct && typeof direct === 'object') {
      const direction = String(direct.direction || '').toLowerCase().trim();

      return {
        msg_id: String(
          direct.msg_id ||
          direct.id ||
          direct.message_id ||
          direct.wa_msg_id ||
          ''
        ).trim(),
        text: cleanOneLine(
          direct.text ||
          direct.conversation ||
          direct.caption ||
          '',
          '[mensagem]'
        ),
        author: cleanOneLine(
          direct.author ||
          direct.nome ||
          direct.push_name ||
          '',
          direction === 'out' ? 'Você' : 'Contato'
        ),
        direction: direction === 'out' ? 'out' : 'in',
      };
    }

    const quoted = m?.quoted || m?.quote || m?.quotedMessage || m?.quoted_message || null;
    if (!quoted || typeof quoted !== 'object') return null;

    const key = quoted.key || quoted.messageKey || {};
    const message = quoted.message || quoted.quotedMessage || quoted;

    const text =
      firstTextFromQuotedMessageObject(message) ||
      mediaLabelFromQuotedMessageObject(message) ||
      cleanOneLine(
        quoted.text ||
        quoted.conteudo ||
        quoted.caption ||
        '',
        '[mensagem]'
      );

    const fromMe = Boolean(key?.fromMe);

    return {
      msg_id: String(
        key?.id ||
        quoted.msg_id ||
        quoted.id ||
        quoted.message_id ||
        ''
      ).trim(),
      text,
      author: fromMe ? 'Você' : 'Contato',
      direction: fromMe ? 'out' : 'in',
    };
  }

  function renderQuotedPreviewHtml(q) {
    if (!q || typeof q !== 'object') return '';

    const msgId = escapeHtml(q.msg_id || q.id || '');
    const author = escapeHtml(
      q.author || (q.direction === 'out' ? 'Você' : 'Contato')
    );
    const text = escapeHtml(
      q.text || q.conversation || '[mensagem]'
    );

    return `
      <div class="zc-quoted-bubble" data-quoted-msg-id="${msgId}" title="Mensagem respondida">
        <div class="zc-quoted-bar" aria-hidden="true"></div>
        <div class="zc-quoted-content">
          <div class="zc-quoted-author">${author}</div>
          <div class="zc-quoted-text">${text}</div>
        </div>
      </div>
    `;
  }

  let viewerRef = null;

  function itemFromMediaAnchor(anchor) {
    if (!anchor) return null;

    const img = anchor.querySelector('img');
    const href = anchor.getAttribute('href') || img?.getAttribute('src') || '';
    const src = img?.getAttribute('src') || href;
    const name = anchor.dataset.name || img?.getAttribute('alt') || 'imagem';

    if (!href && !src) return null;

    return {
      type: 'image',
      src: href || src,
      thumb: src || href,
      name
    };
  }

  function itemFromSticker(img) {
    if (!img) return null;
    const src = img.getAttribute('src') || '';
    if (!src) return null;

    return {
      type: 'image',
      src,
      thumb: src,
      name: img.getAttribute('alt') || 'figurinha'
    };
  }

  function itemFromLooseImage(img) {
    if (!img) return null;

    const src = img.getAttribute('src') || '';
    if (!src) return null;

    return {
      type: 'image',
      src,
      thumb: src,
      name: img.dataset.name || img.getAttribute('alt') || 'imagem'
    };
  }

  function ensureViewer() {
    if (viewerRef) return viewerRef;

    const el = document.createElement('div');
    el.className = 'zc-media-viewer';
    el.setAttribute('aria-hidden', 'true');

    el.innerHTML = `
      <div class="zc-media-viewer__backdrop"></div>

      <div class="zc-media-viewer__top">
        <div class="zc-media-viewer__meta">
          <div class="zc-media-viewer__count">1 de 1</div>
          <div class="zc-media-viewer__name">Mídia</div>
        </div>

        <div class="zc-media-viewer__top-actions">
          <button class="zc-media-viewer__icon-btn zc-media-viewer__close" type="button" aria-label="Fechar">
            ${_closeIconSvg()}
          </button>
        </div>
      </div>

      <button class="zc-media-viewer__nav zc-media-viewer__nav--prev" type="button" aria-label="Anterior">
        ${_chevronLeftSvg()}
      </button>

      <div class="zc-media-viewer__stage">
        <div class="zc-media-viewer__frame">
          <div class="zc-media-viewer__media-wrap">
            <div class="zc-media-viewer__empty">Sem mídia</div>
          </div>
        </div>
      </div>

      <button class="zc-media-viewer__nav zc-media-viewer__nav--next" type="button" aria-label="Próxima">
        ${_chevronRightSvg()}
      </button>

      <div class="zc-media-viewer__thumbs"></div>
    `;

    document.body.appendChild(el);

    const ref = {
      el,
      count: el.querySelector('.zc-media-viewer__count'),
      name: el.querySelector('.zc-media-viewer__name'),
      closeBtn: el.querySelector('.zc-media-viewer__close'),
      prevBtn: el.querySelector('.zc-media-viewer__nav--prev'),
      nextBtn: el.querySelector('.zc-media-viewer__nav--next'),
      mediaWrap: el.querySelector('.zc-media-viewer__media-wrap'),
      thumbs: el.querySelector('.zc-media-viewer__thumbs'),
      state: {
        items: [],
        index: 0
      }
    };

    function normalizeItems(items) {
      return (items || [])
        .map((item) => ({
          type: item?.type || 'image',
          src: String(item?.src || '').trim(),
          thumb: String(item?.thumb || item?.src || '').trim(),
          name: String(item?.name || 'imagem').trim() || 'imagem'
        }))
        .filter((item) => item.src);
    }

    function pauseStageMedia() {
      ref.mediaWrap.querySelectorAll('video').forEach((v) => {
        try { v.pause(); } catch {}
      });
    }

    function renderThumbs() {
      const { items, index } = ref.state;

      ref.thumbs.innerHTML = items.map((item, idx) => `
        <button
          class="zc-media-viewer__thumb ${idx === index ? 'is-active' : ''}"
          type="button"
          data-index="${idx}"
          aria-label="Abrir mídia ${idx + 1}"
        >
          <img src="${escapeHtml(item.thumb || item.src)}" alt="${escapeHtml(item.name)}">
        </button>
      `).join('');
    }

    function renderCurrent() {
      const { items, index } = ref.state;
      const item = items[index];

      if (!item) {
        ref.mediaWrap.innerHTML = `<div class="zc-media-viewer__empty">Sem mídia</div>`;
        ref.count.textContent = '0 de 0';
        ref.name.textContent = 'Mídia';
        ref.prevBtn.style.display = 'none';
        ref.nextBtn.style.display = 'none';
        ref.thumbs.innerHTML = '';
        return;
      }

      ref.count.textContent = `${index + 1} de ${items.length}`;
      ref.name.textContent = item.name || 'Mídia';

      ref.prevBtn.style.display = items.length > 1 ? '' : 'none';
      ref.nextBtn.style.display = items.length > 1 ? '' : 'none';
      ref.thumbs.style.display = items.length > 1 ? '' : 'none';

      pauseStageMedia();

      if (item.type === 'video') {
        ref.mediaWrap.innerHTML = `
          <video class="zc-media-viewer__video" src="${escapeHtml(item.src)}" controls autoplay></video>
        `;
      } else {
        ref.mediaWrap.innerHTML = `
          <img class="zc-media-viewer__img" src="${escapeHtml(item.src)}" alt="${escapeHtml(item.name || 'imagem')}">
        `;
      }

      renderThumbs();
    }

    function open(items, index = 0) {
      const normalized = normalizeItems(items);
      if (!normalized.length) return;

      ref.state.items = normalized;
      ref.state.index = Math.max(0, Math.min(normalized.length - 1, Number(index) || 0));

      renderCurrent();

      ref.el.classList.add('is-open');
      ref.el.setAttribute('aria-hidden', 'false');
      document.body.classList.add('zc-media-viewer-open');
    }

    function close() {
      pauseStageMedia();
      ref.el.classList.remove('is-open');
      ref.el.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('zc-media-viewer-open');
    }

    function go(delta) {
      const items = ref.state.items || [];
      if (!items.length) return;

      const next = (ref.state.index + delta + items.length) % items.length;
      ref.state.index = next;
      renderCurrent();
    }

    ref.closeBtn.addEventListener('click', close);
    ref.el.querySelector('.zc-media-viewer__backdrop')?.addEventListener('click', close);
    ref.prevBtn.addEventListener('click', () => go(-1));
    ref.nextBtn.addEventListener('click', () => go(1));

    ref.thumbs.addEventListener('click', (e) => {
      const btn = e.target.closest('.zc-media-viewer__thumb');
      if (!btn) return;
      const idx = Number(btn.dataset.index);
      if (!Number.isFinite(idx)) return;
      ref.state.index = idx;
      renderCurrent();
    });

    document.addEventListener('keydown', (e) => {
      if (!ref.el.classList.contains('is-open')) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(1);
      }
    });

    ref.open = open;
    ref.close = close;
    ref.go = go;

    viewerRef = ref;
    return ref;
  }

  function collectViewerItemsFromClick(target) {
    const group = target.closest('.msg-media-group');
    if (group) {
      const items = decodeViewerItems(group.dataset.viewerItems || '');
      const idx = Number(target.closest('[data-viewer-index]')?.dataset.viewerIndex || 0);
      return { items, index: Number.isFinite(idx) ? idx : 0 };
    }

    const mediaAnchor =
      target.closest('.msg-media-cell') ||
      target.closest('.msg-media-img') ||
      target.closest('[data-media-view="1"]');

    if (mediaAnchor) {
      const item = itemFromMediaAnchor(mediaAnchor);
      return item ? { items: [item], index: 0 } : null;
    }

    const sticker = target.closest('.msg-sticker');
    if (sticker) {
      const item = itemFromSticker(sticker);
      return item ? { items: [item], index: 0 } : null;
    }

    const looseImg = target.closest('.bubble img');
    if (looseImg && !looseImg.closest('.wa-avatar')) {
      const item = itemFromLooseImage(looseImg);
      return item ? { items: [item], index: 0 } : null;
    }

    return null;
  }

  function bindViewerClicks() {
    if (document.__zcMediaViewerBound) return;
    document.__zcMediaViewerBound = true;

    document.addEventListener('click', (e) => {
      const hit = collectViewerItemsFromClick(e.target);
      if (!hit || !hit.items || !hit.items.length) return;

      const isMedia =
        e.target.closest('.msg-media-cell') ||
        e.target.closest('.msg-media-img') ||
        e.target.closest('[data-media-view="1"]') ||
        e.target.closest('.msg-sticker') ||
        e.target.closest('.bubble img');

      if (!isMedia) return;

      e.preventDefault();
      e.stopPropagation();

      ensureViewer().open(hit.items, hit.index);
    }, true);
  }

  function formatOnlyTime(raw) {
    try {
      if (!raw) return '';
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function criarHTMLDaMensagem(m) {
    ensureMsgMediaCss();

    const isSaida =
      m?.tipo === 'saida' ||
      m?.from_me === true ||
      m?.fromMe === true ||
      m?.origem === 'atendente';

    const dir = isSaida ? 'out' : 'in';

    const hora = formatOnlyTime(
      m?.timestamp || m?.data || m?.created_at || m?.createdAt || m?.ts || ''
    );

    const texto = String(m?.conteudo ?? m?.mensagem ?? m?.texto ?? '').trim();
    const msgId = String(m?.msg_id || m?.msgId || m?.message_id || m?.messageId || m?.id || '').trim();
    const msgIdEsc = escapeHtml(msgId);

    let ackHtml = '';
    if (isSaida && typeof window.getAckIcon === 'function') {
      try {
        ackHtml = String(window.getAckIcon(m?.ack ?? 0) || '');
        if (ackHtml.includes('<span class="msg-ack"') && msgIdEsc) {
          ackHtml = ackHtml.replace(
            '<span class="msg-ack"',
            `<span class="msg-ack" data-msg-id="${msgIdEsc}"`
          );
        }
      } catch {}
    }

    const quotedPreview = normalizeQuotedPreviewFromMsg(m);
    const quotedPreviewAttr = quotedPreview ? jsonAttr(quotedPreview) : '';
    const quotedAttr = m?.quoted && typeof m.quoted === 'object' ? jsonAttr(m.quoted) : '';

    const quotedPreviewData = quotedPreviewAttr
      ? ` data-quoted-preview="${quotedPreviewAttr}"`
      : '';

    const quotedData = quotedAttr
      ? ` data-quoted="${quotedAttr}"`
      : '';

    const quoteHtml = renderQuotedPreviewHtml(quotedPreview);

    let anexos = [];
    if (Array.isArray(m?.midias) && m.midias.length) {
      anexos.push(...m.midias.filter(Boolean));
    } else if (Array.isArray(m?.anexos) && m.anexos.length) {
      anexos.push(...m.anexos.filter(Boolean));
    } else if (m?.midia && typeof m.midia === 'object') {
      anexos.push(m.midia);
    }

    const seen = new Set();
    anexos = anexos.filter((a) => {
      if (!a) return false;

      const k = [
        a.id ?? '',
        a.url || a.url_api || a.link || a.path || '',
        a.tipo || a.tipo_midia || '',
        a.mimetype || a.mime || '',
        a.filename || a.name || ''
      ].join('|');

      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const onlyGalleryImages = anexos.length > 1 && anexos.every(isGalleryImageAttachment);
    const hasSingleImagePreview = anexos.length === 1 && anexos.every(isGalleryImageAttachment);

    const renderAnexo = (a) => {
      const urls = resolveUrlsForMedia(m, a);
      const [url, ...alts] = urls;

      const mime = String(a.mimetype || a.mime || '').toLowerCase();
      const tipo = String(a.tipo || a.tipo_midia || '').toLowerCase();
      const name = a.filename || a.name || a.fileName || 'arquivo';

      if (isImageAttachment(a)) {
        if (tipo.includes('figurinha') || tipo.includes('sticker')) {
          return `<img class="msg-sticker" src="${escapeHtml(url)}" data-alt="${escapeHtml(alts.join('|'))}" alt="${escapeHtml(name)}" loading="lazy">`;
        }

        const { fileName } = deriveFileName({
          mimetype: mime,
          filename: name,
          url
        });

        return `<a
                  class="msg-media-img msg-media-img--single"
                  href="${escapeHtml(url)}"
                  data-media-view="1"
                  data-zc-media-open="1"
                  data-media-kind="image"
                  data-media-src="${escapeHtml(url)}"
                  data-media-thumb="${escapeHtml(url)}"
                  data-media-alt="${escapeHtml(alts.join('|'))}"
                  data-media-name="${escapeHtml(fileName)}"
                  data-name="${escapeHtml(fileName)}"
                  aria-label="${escapeHtml(fileName)}"
                >
                  <img src="${escapeHtml(url)}" data-alt="${escapeHtml(alts.join('|'))}" alt="${escapeHtml(name)}" loading="lazy">
                </a>`;
      }

      if (tipo.includes('vídeo') || tipo.includes('video') || mime.startsWith('video/')) {
        return `<video class="msg-media-video" controls preload="metadata" src="${escapeHtml(url)}" data-alt="${escapeHtml(alts.join('|'))}"></video>`;
      }

      if (tipo.includes('áudio') || tipo.includes('audio') || tipo.includes('ptt') || mime.startsWith('audio/')) {
        return _makeWaAudioHTML(urls, { dir });
      }

      const { fileName, extUp, extLower } = deriveFileName({
        mimetype: mime,
        filename: name,
        url
      });

      const sizeTxt = _humanSize(a.size || a.bytes || a.length) || '';

      return `<div class="doc-card">
                <div class="doc-ico" data-ext="${escapeHtml(extLower)}"><span class="ext">${escapeHtml(extUp)}</span></div>
                <div class="doc-body">
                  <a class="doc-name" href="${escapeHtml(url)}" target="_blank" rel="noopener" download="${escapeHtml(fileName)}" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</a>
                  <div class="doc-meta">${escapeHtml(sizeTxt || 'arquivo')}</div>
                </div>
                <div class="doc-actions">
                  <a class="doc-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">Abrir</a>
                  <a class="doc-btn" href="${escapeHtml(url)}" download="${escapeHtml(fileName)}">Salvar</a>
                </div>
              </div>`;
    };

    let mediaHtml = onlyGalleryImages
      ? renderImageGroup(m, anexos)
      : anexos.map(renderAnexo).join('');

    if (!mediaHtml && m?.msg_id && MARKER_RE.test(texto)) {
      const src = buildCanonUrlByMsgId(m.msg_id);
      const kind = markerKind(texto);

      if (kind.startsWith('imagem') || kind.startsWith('midia')) {
        mediaHtml = `<a
                       class="msg-media-img msg-media-img--single"
                       href="${escapeHtml(src)}"
                       data-media-view="1"
                       data-zc-media-open="1"
                       data-media-kind="image"
                       data-media-src="${escapeHtml(src)}"
                       data-media-thumb="${escapeHtml(src)}"
                       data-media-name="imagem"
                       data-name="imagem"
                     >
                       <img src="${escapeHtml(src)}" alt="imagem" loading="lazy">
                     </a>`;
      } else if (kind.startsWith('video')) {
        mediaHtml = `<video class="msg-media-video" controls preload="metadata" src="${escapeHtml(src)}"></video>`;
      } else if (kind.startsWith('audio')) {
        mediaHtml = _makeWaAudioHTML([src], { dir });
      } else if (kind.startsWith('figurinha')) {
        mediaHtml = `<img class="msg-sticker" src="${escapeHtml(src)}" alt="figurinha" loading="lazy">`;
      } else {
        const fname = 'arquivo.bin';
        mediaHtml = `<div class="doc-card">
                      <div class="doc-ico" data-ext="bin"><span class="ext">FILE</span></div>
                      <div class="doc-body">
                        <a class="doc-name" href="${escapeHtml(src)}" target="_blank" rel="noopener" download="${fname}" title="${fname}">${fname}</a>
                        <div class="doc-meta">arquivo</div>
                      </div>
                      <div class="doc-actions">
                        <a class="doc-btn" href="${escapeHtml(src)}" target="_blank" rel="noopener">Abrir</a>
                        <a class="doc-btn" href="${escapeHtml(src)}" download="${fname}">Salvar</a>
                      </div>
                    </div>`;
      }
    }

    const hasMedia = mediaHtml.trim().length > 0;
    const shouldHidePureMarkerText = hasMedia && /^\[[^\]]+\]$/i.test(texto);

    const textHtml = texto && !shouldHidePureMarkerText
      ? `<div class="msg-text">${escapeHtml(texto)}</div>`
      : !hasMedia
        ? `<div class="msg-text">&nbsp;</div>`
        : '';

    return `<div class="msg-row ${isSaida ? 'msg-sent' : 'msg-received'}${quotedPreview ? ' has-quoted' : ''}"
        data-id="${msgIdEsc}"
        data-msg-id="${msgIdEsc}"
        data-message-id="${msgIdEsc}"
        data-wa-msg-id="${msgIdEsc}"
        data-from-me="${isSaida ? '1' : '0'}"${quotedPreviewData}${quotedData}>
      <div class="bubble ${isSaida ? 'bubble-out' : 'bubble-in'}${onlyGalleryImages ? ' has-media-group' : ''}${hasSingleImagePreview ? ' has-media-single' : ''}${quotedPreview ? ' has-quoted' : ''}"
          data-msg-id="${msgIdEsc}"
          data-message-id="${msgIdEsc}"
          data-wa-msg-id="${msgIdEsc}"
          data-from-me="${isSaida ? '1' : '0'}"${quotedPreviewData}${quotedData}>
        ${quoteHtml}
        ${mediaHtml}
        ${textHtml}
        <div class="meta">
          ${ackHtml}
          <span class="msg-time">${escapeHtml(hora)}</span>
        </div>
      </div>
    </div>`;
  }

  function enhance(root) {
    root = root || document;

    try { ensureMsgMediaCss(); } catch {}
    try { upgradeNativeAudios(root); } catch {}
    try { injectMarkerMedias(root); } catch {}
    try { initMediaFallbacks(root); } catch {}
    try { initAudioPlayers(root); } catch {}
    try { refreshAudioAvatars(root); } catch {}
    try { bindViewerClicks(root); } catch {}
    try { groupConsecutiveImageRows(root); } catch {}
  }

  function bootObserver() {
    const hist = H();

    if (hist && !hist.__zcMediaRenderObs) {
      const obs = new MutationObserver(() => {
        clearTimeout(hist.__zcMediaRenderTimer);
        hist.__zcMediaRenderTimer = setTimeout(() => enhance(hist), 80);
      });

      obs.observe(hist, {
        childList: true,
        subtree: true
      });

      hist.__zcMediaRenderObs = obs;
    }

    enhance(hist || document);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootObserver);
  } else {
    bootObserver();
  }

  document.addEventListener('historico:ready', () => enhance(H() || document));
  document.addEventListener('historico:rendered', () => enhance(H() || document));
  document.addEventListener('cliente:selecionado', () => {
    setTimeout(() => enhance(H() || document), 120);
  });
  document.addEventListener('cliente:selecionar', () => {
    setTimeout(() => enhance(H() || document), 120);
  });
  document.addEventListener('zc:cliente_sel', () => {
    setTimeout(() => enhance(H() || document), 120);
  });

  window.addEventListener('resize', () => {
    try { groupConsecutiveImageRows(H() || document); } catch {}
  }, { passive: true });

  window.__zcMediaEnsureInterval = setInterval(() => {
    try { enhance(H() || document); } catch {}
  }, 2500);

  window.__zcMediaAvatarInterval = setInterval(() => {
    try { refreshAudioAvatars(H() || document); } catch {}
  }, 3000);

  window.initMediaFallbacks = initMediaFallbacks;
  window.initAudioPlayers = initAudioPlayers;
  window.refreshAudioAvatars = refreshAudioAvatars;
  window.groupConsecutiveImageRows = groupConsecutiveImageRows;
  window.criarHTMLDaMensagem = criarHTMLDaMensagem;
  window.ensureMsgMediaCss = ensureMsgMediaCss;
  window.zcMediaRenderEnhance = enhance;
})();