// /frontend/js/atendimentos/ui/media-render.js
// Render de mídias/docs/áudio (player estilo WPP Web: avatar no IN, speed no OUT, waveform pontilhado)
// + fallback por marcador [Áudio/ptt] + auto-init (MutationObserver) + upgrade de <audio controls> -> .wa-audio
// + galeria/mosaico de imagens estilo WhatsApp Web
// + agrupamento de mensagens consecutivas só de imagem em um bloco único
// + viewer/modal de mídia por clique (imagem/vídeo) com miniaturas embaixo
// ✅ SEM CSS inline/inject — usa /frontend/css/atendimentos/media.css

(function () {
  if (window.__zcMediaRenderLoaded) return;
  window.__zcMediaRenderLoaded = true;

  // ========= helpers =========
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;'
    }[ch]));
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
    return;
  }

  function getGroupVisibleCount(total) {
    const n = Number(total || 0);
    if (!n) return 0;
    return Math.min(n, 4);
  }

  function getOverlayCount(total, visibleCount, idx) {
    const n = Number(total || 0);
    const v = Number(visibleCount || 0);
    const i = Number(idx || 0);

    if (n <= 4) return '';
    if (i !== v - 1) return '';
    return String(Math.max(1, n - 4));
  }

  function dedupeViewerItems(items) {
    const out = [];
    const seen = new Set();

    (items || []).forEach((item) => {
      const src = String(item?.src || '').trim();
      if (!src) return;
      if (seen.has(src)) return;
      seen.add(src);
      out.push({
        type: item.type || 'image',
        src,
        name: item.name || 'imagem',
        alt: item.alt || '',
        thumb: item.thumb || src
      });
    });

    return out;
  }

  // ========= docs utils =========
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
      'image/webp': 'webp',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'video/mp4': 'mp4'
    };

    return (map[mimetype] || fromName || 'bin').toLowerCase();
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

  function deriveFileName(a) {
    const url = a.url || a.link || a.path || '';
    const baseRaw = a.filename || a.name || a.nome_original || _basenameFromUrl(url) || 'arquivo';
    const base = _sanitizeBase(baseRaw.replace(/\.[a-z0-9]{1,6}$/i, ''));
    const ext = _guessExt({
      mimetype: a.mimetype || a.mime || '',
      filename: a.filename || a.name || '',
      url
    });

    return {
      fileName: `${base}.${ext}`,
      extUp: ext.toUpperCase(),
      extLower: ext.toLowerCase()
    };
  }

  // ========= inst/empresa =========
  function _empId() {
    return window.EMPRESA_ID ?? window.empresa_id ?? window.state?.empresa_id ?? null;
  }

  function _instQ() {
    try {
      return typeof window._instQuery === 'function' ? (window._instQuery() || '') : '';
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

  function resolveUrlsForMedia(m, a, opts) {
    opts = opts || {};
    const preferAttachmentUrl = opts.preferAttachmentUrl !== false;

    const MSG_CANON = m?.msg_id ? buildCanonUrlByMsgId(m.msg_id) : null;

    const qs = new URLSearchParams();
    const eid = _empId();
    if (eid) qs.set('empresa_id', String(eid));
    _applyInstToQS(qs, _instQ());
    const q = qs.toString();

    const idUrl = a?.id
      ? `/api/atendimento/midias/${encodeURIComponent(String(a.id))}${q ? `?${q}` : ''}`
      : '';

    const attachmentUrl = a?.url_api || a?.url || a?.link || a?.path || idUrl || '';
    const primary = preferAttachmentUrl
      ? (attachmentUrl || MSG_CANON || '')
      : (MSG_CANON || attachmentUrl || '');

    const alts = [];
    [attachmentUrl, MSG_CANON, idUrl, a?.url, a?.link, a?.path].forEach((u) => {
      if (u && u !== primary) alts.push(u);
    });

    const seen = new Set();
    return [primary, ...alts].filter((u) => u && !seen.has(u) && seen.add(u));
  }

  // ========= avatar do cliente (pra áudio IN) =========
  const AVATAR_SELS = [
    '#chat-avatar img[data-cliente-id]',
    '#chat-avatar img',
    '#chat-header #chat-avatar img'
  ];

  function _qAny(sels) {
    for (let i = 0; i < sels.length; i++) {
      const el = document.querySelector(sels[i]);
      if (el) return el;
    }
    return null;
  }

  function _currentClienteId() {
    const s = window.state?.clienteSel || window.clienteSel || {};
    const cid = s.id ?? s.conversation_id ?? s.cliente_id ?? null;
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

  // ========= player áudio =========
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
          idx++;
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
          btnSpeed.textContent = next.toFixed(1) + 'x';
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

  // ========= fallbacks =========
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

  // ========= fallback por marcador =========
  const MARKER_RE = /^\[(Imagem|Vídeo|Video|Áudio\/ptt|Áudio|Audio|Documento|Figurinha|Localização|Contatos?|M[íi]dia)\]/i;

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

  function injectMarkerAudios(root) {
    root = root || document;

    root.querySelectorAll('.msg-row').forEach((row) => {
      const bubble = row.querySelector('.bubble');
      if (!bubble) return;

      if (bubble.querySelector('.wa-audio, audio[controls]')) return;

      const txtEl = bubble.querySelector('.msg-text');
      const txt = (txtEl?.textContent || '').trim();
      if (!MARKER_RE.test(txt)) return;

      const kind = txt.replace(/^\[|\].*$/g, '').toLowerCase();
      if (!(kind.startsWith('áudio') || kind.startsWith('audio'))) return;

      const msgId =
        row.getAttribute('data-msg-id') ||
        bubble.getAttribute('data-msg-id') ||
        row.getAttribute('data-id') ||
        '';

      if (!msgId) return;

      const src = buildCanonUrlByMsgId(msgId);
      const dir = bubble.classList.contains('bubble-out') ? 'out' : 'in';
      const html = _makeWaAudioHTML([src], { dir });

      bubble.insertAdjacentHTML('afterbegin', html);

      if (txtEl && /^\[[^\]]+\]$/i.test(txt)) {
        txtEl.style.display = 'none';
      }
    });
  }

  // ========= imagens / galeria =========
  function isImageAttachment(a) {
    const mime = String(a?.mimetype || a?.mime || '').toLowerCase();
    const tipo = String(a?.tipo || a?.tipo_midia || '').toLowerCase();

    return (
      tipo.includes('imagem') ||
      tipo.includes('image') ||
      tipo.includes('foto') ||
      tipo.includes('picture') ||
      tipo.includes('figura') ||
      tipo.includes('figurinha') ||
      mime.startsWith('image/')
    );
  }

  function isGalleryImageAttachment(a) {
    const mime = String(a?.mimetype || a?.mime || '').toLowerCase();
    const tipo = String(a?.tipo || a?.tipo_midia || '').toLowerCase();
    const isSticker = tipo.includes('figurinha');

    return mime.startsWith('image/') && !isSticker;
  }

  function normalizeSingleImageThumbs(root) {
    (root || document).querySelectorAll('.msg-media-img--single').forEach((link) => {
      const img = link.querySelector('img');
      if (!img) return;

      const apply = () => {
        const w = Number(img.naturalWidth || img.width || 0);
        const h = Number(img.naturalHeight || img.height || 0);
        if (!w || !h) return;

        const ratio = w / h;
        link.classList.remove('is-landscape', 'is-square', 'is-portrait', 'is-super-portrait');

        if (ratio <= 0.62) {
          link.classList.add('is-portrait', 'is-super-portrait');
        } else if (ratio < 0.9) {
          link.classList.add('is-portrait');
        } else if (ratio > 1.18) {
          link.classList.add('is-landscape');
        } else {
          link.classList.add('is-square');
        }
      };

      if (!img.__zcThumbBound) {
        img.__zcThumbBound = true;
        img.addEventListener('load', apply);
      }

      if (img.complete && (img.naturalWidth || img.width) && (img.naturalHeight || img.height)) {
        apply();
      }
    });
  }

  function renderImageCell(m, a, extraClass = '', overlay = '', idx = 0, hidden = false) {
    const urls = resolveUrlsForMedia(m, a, { preferAttachmentUrl: true });
    const [url, ...alts] = urls;
    const name = a.filename || a.name || `imagem-${idx + 1}.jpg`;
    const { fileName } = deriveFileName({
      mimetype: a.mimetype || a.mime || '',
      filename: name,
      url
    });

    return `
      <a
        class="msg-media-cell ${extraClass}"
        href="${escapeHtml(url)}"
        data-media-view="1"
        data-media-kind="image"
        data-media-src="${escapeHtml(url)}"
        data-media-thumb="${escapeHtml(url)}"
        data-media-alt="${escapeHtml(alts.join('|'))}"
        data-media-name="${escapeHtml(fileName)}"
        data-media-idx="${Number(idx) || 0}"
        aria-label="${escapeHtml(fileName)}"
        ${hidden ? 'hidden' : ''}
      >
        <img src="${escapeHtml(url)}" data-alt="${escapeHtml(alts.join('|'))}" alt="${escapeHtml(name)}" loading="lazy">
        ${overlay ? `<span class="msg-media-more">+${escapeHtml(overlay)}</span>` : ''}
      </a>
    `;
  }

  function renderImageGroup(m, list) {
    const total = list.length;
    const visibleCount = getGroupVisibleCount(total);
    const visible = list.slice(0, visibleCount);
    const hidden = list.slice(visibleCount);

    return `
      <div class="msg-media-group" data-count="${visible.length}" data-total="${total}">
        ${visible.map((a, idx) => {
          const overlay = getOverlayCount(total, visibleCount, idx);
          return renderImageCell(m, a, `cell-${idx + 1}`, overlay, idx, false);
        }).join('')}
        ${hidden.map((a, idx) => {
          const realIdx = idx + visibleCount;
          return renderImageCell(m, a, 'is-extra-hidden', '', realIdx, true);
        }).join('')}
      </div>
    `;
  }

  function collectInlineImagesFromBubble(bubble) {
    if (!bubble) return [];
    const links = [...bubble.querySelectorAll('[data-media-view="1"][data-media-kind="image"]')];

    return dedupeViewerItems(
      links.map((a) => ({
        type: 'image',
        src: a.getAttribute('data-media-src') || a.getAttribute('href') || '',
        name: a.getAttribute('data-media-name') || a.querySelector('img')?.getAttribute('alt') || 'imagem',
        alt: a.getAttribute('data-media-alt') || '',
        thumb: a.getAttribute('data-media-thumb') || a.getAttribute('data-media-src') || a.getAttribute('href') || ''
      }))
    );
  }

  // ========= viewer/modal =========
  let __viewerState = {
    items: [],
    index: 0,
    zoomed: false
  };

  function _iconClose() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
  }

  function _iconArrowLeft() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  function _iconArrowRight() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  function _iconOpen() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M14 5h5v5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M10 14L19 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
  }

  function _iconDownload() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 4v10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
  }

  function ensureMediaViewer() {
    let el = document.getElementById('zc-media-viewer');
    if (el) return el;

    el = document.createElement('div');
    el.id = 'zc-media-viewer';
    el.className = 'zc-media-viewer';
    el.setAttribute('aria-hidden', 'true');

    el.innerHTML = `
      <div class="zc-media-viewer__backdrop" data-zc-close="1"></div>

      <div class="zc-media-viewer__shell">
        <div class="zc-media-viewer__top">
          <div class="zc-media-viewer__meta">
            <div class="zc-media-viewer__count">1 / 1</div>
            <div class="zc-media-viewer__name"></div>
          </div>

          <div class="zc-media-viewer__actions">
            <a class="zc-media-viewer__action zc-open" target="_blank" rel="noopener" title="Abrir">
              ${_iconOpen()}
              <span>Abrir</span>
            </a>
            <a class="zc-media-viewer__action zc-download" download title="Salvar">
              ${_iconDownload()}
              <span>Salvar</span>
            </a>
            <button class="zc-media-viewer__close" type="button" aria-label="Fechar">
              ${_iconClose()}
            </button>
          </div>
        </div>

        <button class="zc-media-viewer__nav is-prev" type="button" aria-label="Anterior">
          ${_iconArrowLeft()}
        </button>

        <div class="zc-media-viewer__stage-wrap">
          <div class="zc-media-viewer__stage"></div>
        </div>

        <button class="zc-media-viewer__nav is-next" type="button" aria-label="Próxima">
          ${_iconArrowRight()}
        </button>

        <div class="zc-media-viewer__bottom">
          <div class="zc-media-viewer__thumbs"></div>
        </div>
      </div>
    `;

    document.body.appendChild(el);

    const closeBtn = el.querySelector('.zc-media-viewer__close');
    const prevBtn = el.querySelector('.zc-media-viewer__nav.is-prev');
    const nextBtn = el.querySelector('.zc-media-viewer__nav.is-next');
    const backdrop = el.querySelector('.zc-media-viewer__backdrop');
    const stageWrap = el.querySelector('.zc-media-viewer__stage-wrap');
    const thumbs = el.querySelector('.zc-media-viewer__thumbs');

    closeBtn?.addEventListener('click', closeMediaViewer);
    prevBtn?.addEventListener('click', () => stepMediaViewer(-1));
    nextBtn?.addEventListener('click', () => stepMediaViewer(1));
    backdrop?.addEventListener('click', closeMediaViewer);

    stageWrap?.addEventListener('click', (e) => {
      const media = e.target.closest('.zc-media-viewer__media.is-image');
      if (!media) return;
      toggleMediaZoom();
    });

    thumbs?.addEventListener('click', (e) => {
      const btn = e.target.closest('.zc-media-viewer__thumb');
      if (!btn) return;
      const idx = Number(btn.getAttribute('data-idx'));
      if (!Number.isFinite(idx)) return;
      __viewerState.index = idx;
      __viewerState.zoomed = false;
      renderMediaViewer();
    });

    document.addEventListener('keydown', (e) => {
      if (!isMediaViewerOpen()) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        closeMediaViewer();
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepMediaViewer(-1);
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepMediaViewer(1);
      }
    });

    return el;
  }

  function isMediaViewerOpen() {
    const el = document.getElementById('zc-media-viewer');
    return !!(el && el.classList.contains('is-open'));
  }

  function collectViewerItemsFromTrigger(trigger) {
    if (!trigger) return [];

    const realTrigger = trigger.closest?.('[data-media-view="1"], .msg-media-video, .msg-sticker') || trigger;
    const group = realTrigger.closest?.('.msg-media-group');

    if (group) {
      const anchors = [...group.querySelectorAll('[data-media-view="1"][data-media-kind="image"]')];
      return dedupeViewerItems(
        anchors.map((a) => ({
          type: 'image',
          src: a.getAttribute('data-media-src') || a.getAttribute('href') || '',
          name: a.getAttribute('data-media-name') || a.querySelector('img')?.getAttribute('alt') || 'imagem',
          alt: a.getAttribute('data-media-alt') || '',
          thumb: a.getAttribute('data-media-thumb') || a.getAttribute('data-media-src') || a.getAttribute('href') || ''
        }))
      );
    }

    if (realTrigger.matches?.('[data-media-view="1"][data-media-kind="image"]')) {
      return dedupeViewerItems([{
        type: 'image',
        src: realTrigger.getAttribute('data-media-src') || realTrigger.getAttribute('href') || '',
        name: realTrigger.getAttribute('data-media-name') || realTrigger.querySelector('img')?.getAttribute('alt') || 'imagem',
        alt: realTrigger.getAttribute('data-media-alt') || '',
        thumb: realTrigger.getAttribute('data-media-thumb') || realTrigger.getAttribute('data-media-src') || realTrigger.getAttribute('href') || ''
      }]);
    }

    if (realTrigger.matches?.('.msg-media-video')) {
      return dedupeViewerItems([{
        type: 'video',
        src: realTrigger.currentSrc || realTrigger.getAttribute('src') || '',
        name: 'video.mp4',
        alt: realTrigger.getAttribute('data-alt') || '',
        thumb: realTrigger.getAttribute('poster') || realTrigger.currentSrc || realTrigger.getAttribute('src') || ''
      }]);
    }

    if (realTrigger.matches?.('.msg-sticker')) {
      return dedupeViewerItems([{
        type: 'image',
        src: realTrigger.getAttribute('src') || '',
        name: 'figurinha.webp',
        alt: realTrigger.getAttribute('data-alt') || '',
        thumb: realTrigger.getAttribute('src') || ''
      }]);
    }

    return [];
  }

  function openMediaViewer(items, startIndex = 0) {
    const list = dedupeViewerItems(items || []);
    if (!list.length) return;

    const el = ensureMediaViewer();
    __viewerState.items = list;
    __viewerState.index = Math.max(0, Math.min(startIndex, list.length - 1));
    __viewerState.zoomed = false;

    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('zc-no-scroll');
    document.body.classList.add('zc-no-scroll');

    renderMediaViewer();
  }

  function closeMediaViewer() {
    const el = document.getElementById('zc-media-viewer');
    if (!el) return;

    const stage = el.querySelector('.zc-media-viewer__stage');
    const thumbs = el.querySelector('.zc-media-viewer__thumbs');

    if (stage) stage.innerHTML = '';
    if (thumbs) thumbs.innerHTML = '';

    __viewerState.items = [];
    __viewerState.index = 0;
    __viewerState.zoomed = false;

    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('zc-no-scroll');
    document.body.classList.remove('zc-no-scroll');
  }

  function stepMediaViewer(delta) {
    const total = __viewerState.items.length || 0;
    if (!total) return;

    __viewerState.index = (__viewerState.index + delta + total) % total;
    __viewerState.zoomed = false;
    renderMediaViewer();
  }

  function toggleMediaZoom() {
    __viewerState.zoomed = !__viewerState.zoomed;
    const el = document.getElementById('zc-media-viewer');
    if (!el) return;
    el.classList.toggle('is-zoomed', __viewerState.zoomed);
  }

  function renderMediaViewerThumbs(el, items, activeIdx) {
    const wrap = el.querySelector('.zc-media-viewer__thumbs');
    if (!wrap) return;

    wrap.innerHTML = items.map((item, idx) => {
      const isActive = idx === activeIdx ? ' is-active' : '';
      const thumbSrc = item.thumb || item.src;

      if (item.type === 'video') {
        return `
          <button class="zc-media-viewer__thumb${isActive}" type="button" data-idx="${idx}" aria-label="Ir para item ${idx + 1}">
            <span class="zc-media-viewer__thumb-video">VIDEO</span>
          </button>
        `;
      }

      return `
        <button class="zc-media-viewer__thumb${isActive}" type="button" data-idx="${idx}" aria-label="Ir para item ${idx + 1}">
          <img src="${escapeHtml(thumbSrc)}" alt="${escapeHtml(item.name || 'imagem')}">
        </button>
      `;
    }).join('');

    const active = wrap.querySelector('.zc-media-viewer__thumb.is-active');
    if (active) {
      try {
        active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      } catch {}
    }
  }

  function renderMediaViewer() {
    const el = ensureMediaViewer();
    const stage = el.querySelector('.zc-media-viewer__stage');
    const count = el.querySelector('.zc-media-viewer__count');
    const name = el.querySelector('.zc-media-viewer__name');
    const openA = el.querySelector('.zc-open');
    const downA = el.querySelector('.zc-download');
    const prevBtn = el.querySelector('.zc-media-viewer__nav.is-prev');
    const nextBtn = el.querySelector('.zc-media-viewer__nav.is-next');

    const items = __viewerState.items || [];
    const total = items.length;
    const idx = __viewerState.index;
    const item = items[idx];

    if (!item || !stage) return;

    el.classList.toggle('is-zoomed', !!__viewerState.zoomed);

    count.textContent = `${idx + 1} / ${total}`;
    name.textContent = item.name || '';
    openA.href = item.src;
    downA.href = item.src;
    downA.setAttribute('download', item.name || 'midia');

    prevBtn.style.display = total > 1 ? '' : 'none';
    nextBtn.style.display = total > 1 ? '' : 'none';

    if (item.type === 'video') {
      stage.innerHTML = `
        <video class="zc-media-viewer__media is-video" controls autoplay preload="metadata" src="${escapeHtml(item.src)}"></video>
      `;
    } else {
      stage.innerHTML = `
        <img
          class="zc-media-viewer__media is-image"
          src="${escapeHtml(item.src)}"
          alt="${escapeHtml(item.name || 'imagem')}"
          draggable="false"
        >
      `;
    }

    renderMediaViewerThumbs(el, items, idx);

    try {
      const prev = items[(idx - 1 + total) % total];
      const next = items[(idx + 1) % total];
      [prev, next].forEach((it) => {
        if (it?.type === 'image' && it?.src) {
          const pre = new Image();
          pre.src = it.src;
        }
      });
    } catch {}
  }

  function _resolveViewerStartIndex(trigger) {
    const realTrigger = trigger.closest?.('[data-media-view="1"]') || trigger;
    const src = realTrigger?.getAttribute?.('data-media-src') || realTrigger?.getAttribute?.('href') || '';

    const group = realTrigger?.closest?.('.msg-media-group');
    if (group) {
      const arr = dedupeViewerItems(
        [...group.querySelectorAll('[data-media-view="1"][data-media-kind="image"]')].map((a) => ({
          type: 'image',
          src: a.getAttribute('data-media-src') || a.getAttribute('href') || '',
          name: a.getAttribute('data-media-name') || a.querySelector('img')?.getAttribute('alt') || 'imagem',
          alt: a.getAttribute('data-media-alt') || '',
          thumb: a.getAttribute('data-media-thumb') || a.getAttribute('data-media-src') || a.getAttribute('href') || ''
        }))
      );

      const pos = arr.findIndex((x) => x.src === src);
      if (pos >= 0) return pos;
    }

    const idxAttr = Number(realTrigger?.getAttribute?.('data-media-idx'));
    if (Number.isFinite(idxAttr) && idxAttr >= 0) return idxAttr;

    return 0;
  }

  function _handleViewerTrigger(trigger, e) {
    if (!trigger) return false;

    const realTrigger = trigger.closest?.('[data-media-view="1"], .msg-media-video, .msg-sticker') || trigger;

    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    const items = collectViewerItemsFromTrigger(realTrigger);
    if (!items.length) return false;

    let startIndex = 0;
    if (realTrigger.matches?.('[data-media-view="1"]')) {
      startIndex = _resolveViewerStartIndex(realTrigger);
    }

    openMediaViewer(items, startIndex);
    return true;
  }

  function bindMediaViewerOnce() {
    if (document.__zcMediaViewerBound) return;
    document.__zcMediaViewerBound = true;

    const delegatedHandler = (e) => {
      const trigger = e.target?.closest?.('[data-media-view="1"], .msg-media-video, .msg-sticker');
      if (!trigger) return;
      _handleViewerTrigger(trigger, e);
    };

    document.addEventListener('click', delegatedHandler, true);
  }

  function bindDirectViewerTargets(root) {
    (root || document)
      .querySelectorAll('[data-media-view="1"], .msg-media-video, .msg-sticker')
      .forEach((el) => {
        if (el.__zcViewerBound) return;
        el.__zcViewerBound = true;

        el.addEventListener('click', function (e) {
          _handleViewerTrigger(this, e);
        }, true);
      });
  }

  // ========= agrupamento de mensagens consecutivas de imagem =========
  function _bubbleDir(bubble) {
    return bubble?.classList.contains('bubble-out') ? 'out' : 'in';
  }

  function _trimMsgText(bubble) {
    const txtEl = bubble?.querySelector('.msg-text');
    const txt = String(txtEl?.textContent || '').replace(/\u00A0/g, ' ').trim();
    return txt;
  }

  function _rowClusterInfo(row) {
    if (!row || !row.classList?.contains('msg-row')) return null;
    if (row.classList.contains('zc-media-cluster-row')) return null;

    const bubble = row.querySelector('.bubble');
    if (!bubble) return null;

    const txt = _trimMsgText(bubble);
    if (txt) return null;

    if (bubble.querySelector('.wa-audio, audio[controls], .msg-media-video, video.msg-media-video, .doc-card, .msg-sticker')) {
      return null;
    }

    const items = collectInlineImagesFromBubble(bubble);
    if (!items.length) return null;

    const metaHtml = bubble.querySelector('.meta')?.innerHTML || '<span class="msg-time"></span>';

    return {
      dir: _bubbleDir(bubble),
      items,
      metaHtml
    };
  }

  function _renderClusterCell(item, idx, extraClass = '', overlay = '', hidden = false) {
    return `
      <a
        class="msg-media-cell ${extraClass}"
        href="${escapeHtml(item.src)}"
        data-media-view="1"
        data-media-kind="image"
        data-media-src="${escapeHtml(item.src)}"
        data-media-thumb="${escapeHtml(item.thumb || item.src)}"
        data-media-alt="${escapeHtml(item.alt || '')}"
        data-media-name="${escapeHtml(item.name || 'imagem')}"
        data-media-idx="${Number(idx) || 0}"
        aria-label="${escapeHtml(item.name || 'imagem')}"
        ${hidden ? 'hidden' : ''}
      >
        <img src="${escapeHtml(item.thumb || item.src)}" alt="${escapeHtml(item.name || 'imagem')}" loading="lazy">
        ${overlay ? `<span class="msg-media-more">+${escapeHtml(overlay)}</span>` : ''}
      </a>
    `;
  }

  function _renderClusterGroup(items) {
    const total = items.length;
    const visibleCount = getGroupVisibleCount(total);
    const visible = items.slice(0, visibleCount);
    const hidden = items.slice(visibleCount);

    return `
      <div class="msg-media-group zc-media-cluster-group" data-count="${visible.length}" data-total="${total}">
        ${visible.map((item, idx) => {
          const overlay = getOverlayCount(total, visibleCount, idx);
          return _renderClusterCell(item, idx, `cell-${idx + 1}`, overlay, false);
        }).join('')}
        ${hidden.map((item, idx) => {
          const realIdx = idx + visibleCount;
          return _renderClusterCell(item, realIdx, 'is-extra-hidden', '', true);
        }).join('')}
      </div>
    `;
  }

  function groupConsecutiveImageRows(root) {
    root = root || H();
    if (!root) return;

    root.querySelectorAll('.zc-media-cluster-row').forEach((el) => el.remove());
    root.querySelectorAll('.msg-row[data-cluster-hidden="1"]').forEach((row) => {
      row.style.display = '';
      row.removeAttribute('data-cluster-hidden');
    });

    const children = [...root.children];
    let i = 0;

    while (i < children.length) {
      const node = children[i];

      if (!node?.classList?.contains('msg-row')) {
        i++;
        continue;
      }

      const firstInfo = _rowClusterInfo(node);
      if (!firstInfo) {
        i++;
        continue;
      }

      const groupRows = [node];
      const allItems = [...firstInfo.items];
      const dir = firstInfo.dir;
      let metaHtml = firstInfo.metaHtml;

      let j = i + 1;
      while (j < children.length) {
        const nextNode = children[j];

        if (!nextNode?.classList?.contains('msg-row')) break;

        const info = _rowClusterInfo(nextNode);
        if (!info) break;
        if (info.dir !== dir) break;

        groupRows.push(nextNode);
        allItems.push(...info.items);
        metaHtml = info.metaHtml || metaHtml;
        j++;
      }

      if (groupRows.length >= 2 && allItems.length >= 2) {
        const clusterRow = document.createElement('div');
        clusterRow.className = `msg-row ${dir === 'out' ? 'msg-sent' : 'msg-received'} zc-media-cluster-row`;

        clusterRow.innerHTML = `
          <div class="bubble ${dir === 'out' ? 'bubble-out' : 'bubble-in'} has-media-group zc-media-cluster-bubble">
            ${_renderClusterGroup(dedupeViewerItems(allItems))}
            <div class="meta">
              ${metaHtml}
            </div>
          </div>
        `;

        groupRows[0].before(clusterRow);
        groupRows.forEach((row) => {
          row.setAttribute('data-cluster-hidden', '1');
          row.style.display = 'none';
        });
      }

      i = j;
    }
  }

  // ========= render mensagem =========
  function criarHTMLDaMensagem(m) {
    ensureMsgMediaCss();

    const isSaida = m.tipo === 'saida' || m.from_me === true || m.origem === 'atendente';
    const dir = isSaida ? 'out' : 'in';

    const hora = (window.formatChatTime || ((x) => new Date(x).toLocaleString('pt-BR')))(
      m.timestamp || m.data || m.created_at || ''
    );

    const texto = String(m.conteudo ?? m.mensagem ?? m.texto ?? '').trim();
    const ackHtml = isSaida && typeof window.getAckIcon === 'function'
      ? window.getAckIcon(m.ack ?? 0)
      : '';

    let anexos = [];
    if (Array.isArray(m.midias) && m.midias.length) {
      anexos.push(...m.midias.filter(Boolean));
    } else if (Array.isArray(m.anexos) && m.anexos.length) {
      anexos.push(...m.anexos.filter(Boolean));
    } else if (m.midia && typeof m.midia === 'object') {
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
      const urls = resolveUrlsForMedia(m, a, { preferAttachmentUrl: true });
      const [url, ...alts] = urls;

      const mime = (a.mimetype || a.mime || '').toLowerCase();
      const tipo = (a.tipo || a.tipo_midia || '').toLowerCase();
      const name = a.filename || a.name || 'arquivo';

      if (isImageAttachment(a)) {
        if (tipo.includes('figurinha')) {
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
                  data-media-kind="image"
                  data-media-src="${escapeHtml(url)}"
                  data-media-thumb="${escapeHtml(url)}"
                  data-media-alt="${escapeHtml(alts.join('|'))}"
                  data-media-name="${escapeHtml(fileName)}"
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

    if (!mediaHtml && m.msg_id && MARKER_RE.test(texto)) {
      const src = buildCanonUrlByMsgId(m.msg_id);
      const kind = texto.replace(/^\[|\].*$/g, '').toLowerCase();

      if (kind.startsWith('imagem')) {
        mediaHtml = `<a
                       class="msg-media-img msg-media-img--single"
                       href="${escapeHtml(src)}"
                       data-media-view="1"
                       data-media-kind="image"
                       data-media-src="${escapeHtml(src)}"
                       data-media-thumb="${escapeHtml(src)}"
                       data-media-name="imagem"
                     >
                       <img src="${escapeHtml(src)}" alt="imagem" loading="lazy">
                     </a>`;
      } else if (kind.startsWith('vídeo') || kind.startsWith('video')) {
        mediaHtml = `<video class="msg-media-video" controls preload="metadata" src="${escapeHtml(src)}"></video>`;
      } else if (kind.startsWith('áudio') || kind.startsWith('audio')) {
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

    return `<div class="msg-row ${isSaida ? 'msg-sent' : 'msg-received'}" data-id="${m.msg_id || ''}" data-msg-id="${m.msg_id || ''}">
      <div class="bubble ${isSaida ? 'bubble-out' : 'bubble-in'}${onlyGalleryImages ? ' has-media-group' : ''}${hasSingleImagePreview ? ' has-media-single' : ''}" data-msg-id="${m.msg_id || ''}">
        ${mediaHtml}${textHtml}
        <div class="meta">
          ${ackHtml}
          <span class="msg-time">${hora}</span>
        </div>
      </div>
    </div>`;
  }

  // ========= auto-run =========
  function enhance(root) {
    try { ensureMsgMediaCss(); } catch {}
    try { initMediaFallbacks(root); } catch {}
    try { upgradeNativeAudios(root); } catch {}
    try { injectMarkerAudios(root); } catch {}
    try { initAudioPlayers(root); } catch {}
    try { refreshAudioAvatars(root); } catch {}
    try { ensureMediaViewer(); } catch {}
    try { normalizeSingleImageThumbs(root); } catch {}
    try { groupConsecutiveImageRows(root); } catch {}
    try { bindDirectViewerTargets(root); } catch {}
  }

  function bindObserver(hist) {
    if (!hist || hist.__mediaObs) return;
    hist.__mediaObs = true;

    let raf = 0;
    const mo = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        enhance(hist);
      });
    });

    mo.observe(hist, { childList: true, subtree: true });
  }

  function ensureBound() {
    const hist = H();
    if (hist) {
      bindObserver(hist);
      enhance(hist);
    }
  }

  function bindChatEventsOnce() {
    if (document.__mediaRenderChatEvt) return;
    document.__mediaRenderChatEvt = true;

    const tick = () => {
      const hist = H() || document;
      refreshAudioAvatars(hist);
      groupConsecutiveImageRows(hist);
      bindDirectViewerTargets(hist);
    };

    document.addEventListener('cliente:selecionar', tick);
    document.addEventListener('zc:open_chat', tick);
    document.addEventListener('chat:open', tick);

    if (!window.__zcMediaAvatarInterval) {
      window.__zcMediaAvatarInterval = setInterval(() => {
        const hist = H();
        if (!hist) return;
        refreshAudioAvatars(hist);
      }, 1200);
    }
  }

  // ========= exports =========
  window.ensureMsgMediaCss = ensureMsgMediaCss;
  window.initAudioPlayers = initAudioPlayers;
  window.initMediaFallbacks = initMediaFallbacks;
  window.buildCanonUrlByMsgId = buildCanonUrlByMsgId;
  window.criarHTMLDaMensagem = criarHTMLDaMensagem;
  window.openMediaViewer = openMediaViewer;
  window.closeMediaViewer = closeMediaViewer;
  window.groupConsecutiveImageRows = groupConsecutiveImageRows;

  window.MediaRender = window.MediaRender || {};
  window.MediaRender.enhance = () => enhance(H() || document);
  window.MediaRender.openViewer = openMediaViewer;
  window.MediaRender.closeViewer = closeMediaViewer;
  window.MediaRender.groupClusters = () => groupConsecutiveImageRows(H() || document);

  try { ensureMsgMediaCss(); } catch {}
  bindChatEventsOnce();
  bindMediaViewerOnce();

  const start = () => {
    ensureBound();

    if (!window.__zcMediaEnsureInterval) {
      window.__zcMediaEnsureInterval = setInterval(ensureBound, 900);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();