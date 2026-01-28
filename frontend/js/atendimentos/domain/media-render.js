// /frontend/js/atendimentos/ui/media-render.js
// Render de mídias/docs/áudio (player estilo WPP Web: avatar no IN, speed no OUT, waveform pontilhado)
// + fallback por marcador [Áudio/ptt] + auto-init (MutationObserver) + upgrade de <audio controls> -> .wa-audio
(function () {
  // ========= helpers =========
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }
  function uniq(arr) {
    const out = [];
    const s = new Set();
    (arr || []).forEach((x) => {
      const v = String(x || '').trim();
      if (!v) return;
      if (s.has(v)) return;
      s.add(v);
      out.push(v);
    });
    return out;
  }

  function H() {
    return document.getElementById('historico');
  }

  // ========= CSS =========
  // ✅ CSS foi movido para /frontend/css/atendimentos.css
  function ensureMsgMediaCss() {
    return;
  }

  // ========= docs utils =========
  function _humanSize(bytes) {
    const b = Number(bytes || 0);
    if (!b) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return `${(b / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
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
      (filename || '').split('.').pop()?.toLowerCase() || _basenameFromUrl(url).split('.').pop()?.toLowerCase() || '';
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
      'video/mp4': 'mp4',
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
    const ext = _guessExt({ mimetype: a.mimetype || a.mime || '', filename: a.filename || a.name || '', url });
    return { fileName: `${base}.${ext}`, extUp: ext.toUpperCase(), extLower: ext.toLowerCase() };
  }
  function _extColor(ext) {
    const e = (ext || '').toLowerCase();
    if (['pdf'].includes(e)) return '#ffb1b1';
    if (['doc', 'docx'].includes(e)) return '#b1c9ff';
    if (['xls', 'xlsx', 'csv'].includes(e)) return '#b1ffd1';
    if (['ppt', 'pptx'].includes(e)) return '#ffd9b1';
    if (['zip', 'rar', '7z'].includes(e)) return '#ffe3a1';
    return '#d9e0e3';
  }

  // ========= inst/empresa =========
  function _empId() {
    return window.EMPRESA_ID ?? window.empresa_id ?? window.state?.empresa_id ?? null;
  }
  function _instQ() {
    try {
      return typeof window._instQuery === 'function' ? window._instQuery() || '' : '';
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
    const idUrl = a?.id ? `/api/atendimento/midias/${encodeURIComponent(String(a.id))}${q ? `?${q}` : ''}` : '';

    const primary = MSG_CANON || a?.url_api || a?.url || a?.link || a?.path || idUrl;
    const alts = [];
    if (MSG_CANON) [a?.url_api, a?.url, a?.link, a?.path, idUrl].forEach((u) => u && alts.push(u));

    const seen = new Set();
    return [primary, ...alts].filter((u) => u && !seen.has(u) && seen.add(u));
  }

  // ========= avatar do cliente (pra áudio IN) =========
  // ✅ FIX: só mira o avatar do CLIENTE no header (#chat-avatar), evita pegar sua foto do topo/sidebar.
  const AVATAR_SELS = [
    '#chat-avatar img[data-cliente-id]',
    '#chat-avatar img',
    '#chat-header #chat-avatar img',
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
    // prioridade: state / cache
    const sel = window.state?.clienteSel || window.clienteSel || {};
    const u1 = sel.avatar_url;
    if (u1) return String(u1);

    // fallback: imagem do header do cliente (bem específica)
    const img = _qAny(AVATAR_SELS);
    const src = img?.getAttribute('src') || img?.src || '';
    if (!src || /^data:\s*$/i.test(src)) return '';

    // ✅ garante que é do cliente atual (se o atributo existir)
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

    if (img.dataset._cur === u) return;
    img.dataset._cur = u;
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

  function _makeWaAudioHTML(urls, opts) {
    opts = opts || {};
    const dir = opts.dir === 'out' ? 'out' : 'in';
    const list = uniq(urls);

    // IN: avatar com mic
    const avatarHtml =
      dir === 'in'
        ? `
      <div class="wa-avatar" aria-hidden="true">
        <img alt="" />
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

    // OUT: speed (WhatsApp)
    const speedHtml = dir === 'out' ? `<button class="wa-speed" type="button">1.0x</button>` : '';

    return `
<div class="wa-audio" data-src="${escapeHtml(list.join('|'))}" data-dir="${dir}">
  <div class="wa-left">
    ${avatarHtml}
    ${speedHtml}
    <button class="wa-play" type="button" aria-label="Tocar/Pausar">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M8 5v14l12-7-12-7Z"></path>
      </svg>
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

      // pausa outros tocando
      window.__ZC_AUDIO__ = window.__ZC_AUDIO__ || new Set();
      window.__ZC_AUDIO__.add(audio);

      const pauseOthers = () => {
        try {
          window.__ZC_AUDIO__.forEach((a) => {
            if (a !== audio) a.pause();
          });
        } catch {}
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

      // play/pause
      btnPlay && btnPlay.addEventListener('click', () => {
        if (audio.paused) { pauseOthers(); audio.play().catch(() => {}); }
        else { audio.pause(); }
      });

      // speed (só OUT)
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

      // seeking (wave)
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
        const endDrag = () => (dragging = false);
        wave.addEventListener('pointerup', endDrag);
        wave.addEventListener('pointercancel', endDrag);

        // teclado (← →)
        wave.addEventListener('keydown', (e) => {
          if (!isFinite(audio.duration) || audio.duration <= 0) return;
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          const delta = e.key === 'ArrowRight' ? 2 : -2;
          audio.currentTime = Math.max(0, Math.min(audio.duration, (audio.currentTime || 0) + delta));
          updateFromAudio();
        });
      }

      // events
      audio.addEventListener('play', () => el.setAttribute('data-playing', '1'));
      audio.addEventListener('pause', () => el.removeAttribute('data-playing'));
      audio.addEventListener('loadedmetadata', () => { if (lenEl) lenEl.textContent = _fmtT(audio.duration || 0); updateFromAudio(); });
      audio.addEventListener('durationchange', () => { if (lenEl && isFinite(audio.duration)) lenEl.textContent = _fmtT(audio.duration || 0); });
      audio.addEventListener('timeupdate', updateFromAudio);
      audio.addEventListener('ended', () => { el.removeAttribute('data-playing'); setProgress(0); });
      audio.addEventListener('error', tryNext);

      // IN: seta avatar do cliente
      if (dir === 'in') {
        const u = getCurrentChatAvatarUrl();
        setAudioAvatar(el, u);
      }
    });
  }

  function refreshAudioAvatars(root) {
    const url = getCurrentChatAvatarUrl();
    if (!url) return;
    (root || document).querySelectorAll('.wa-audio[data-dir="in"]').forEach((el) => setAudioAvatar(el, url));
  }

  // ========= fallbacks =========
  function initMediaFallbacks(root) {
    root = root || document;

    // img fallback
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

    // video fallback
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

  // ✅ upgrade: se historico.js renderizar <audio controls>, troca por .wa-audio
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

      // tenta inferir direção pelo bubble
      const bubble = a.closest('.bubble');
      const dir = bubble?.classList.contains('bubble-out') ? 'out' : 'in';

      const wrap = document.createElement('div');
      wrap.innerHTML = _makeWaAudioHTML(urls, { dir });
      const node = wrap.firstElementChild;
      if (!node) return;
      a.replaceWith(node);
    });
  }

  // ✅ fallback DOM: se tiver só "[Áudio/ptt]" no texto e sem mídia, injeta player pelo msg_id do dataset
  function injectMarkerAudios(root) {
    root = root || document;
    root.querySelectorAll('.msg-row').forEach((row) => {
      const bubble = row.querySelector('.bubble');
      if (!bubble) return;

      // já tem player?
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

      // se for só o marcador, some o texto
      if (txtEl && /^\[[^\]]+\]$/i.test(txt)) {
        txtEl.style.display = 'none';
      }
    });
  }

  // ========= render mensagem (compat) =========
  function criarHTMLDaMensagem(m) {
    ensureMsgMediaCss();

    const isSaida = m.tipo === 'saida' || m.from_me === true || m.origem === 'atendente';
    const dir = isSaida ? 'out' : 'in';

    const hora = (window.formatChatTime || ((x) => new Date(x).toLocaleString('pt-BR')))(m.timestamp || m.data || m.created_at || '');
    const texto = String(m.conteudo ?? m.mensagem ?? m.texto ?? '').trim();
    const ackHtml = isSaida && typeof window.getAckIcon === 'function' ? window.getAckIcon(m.ack ?? 0) : '';

    // anexos (dedup)
    let anexos = [];
    if (Array.isArray(m.midias) && m.midias.length) anexos.push(...m.midias.filter(Boolean));
    else if (m.midia && typeof m.midia === 'object') anexos.push(m.midia);

    const seen = new Set();
    anexos = anexos.filter((a) => {
      if (!a) return false;
      const k = [a.id ?? '', a.url || a.url_api || a.link || a.path || '', a.tipo || '', a.mimetype || a.mime || '', a.filename || a.name || ''].join('|');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const renderAnexo = (a) => {
      const urls = resolveUrlsForMedia(m, a);
      const [url, ...alts] = urls;

      const mime = (a.mimetype || a.mime || '').toLowerCase();
      const tipo = (a.tipo || '').toLowerCase();
      const name = a.filename || a.name || 'arquivo';

      if (tipo.includes('imagem') || tipo.includes('image') || tipo.includes('figurinha') || mime.startsWith('image/')) {
        return `<a class="msg-media-img" href="${url}" target="_blank" rel="noopener">
                  <img src="${url}" data-alt="${alts.join('|')}" alt="${escapeHtml(name)}" loading="lazy">
                </a>`;
      }

      if (tipo.includes('vídeo') || tipo.includes('video') || mime.startsWith('video/')) {
        return `<video class="msg-media-video" controls preload="metadata" src="${url}" data-alt="${alts.join('|')}"></video>`;
      }

      if (tipo.includes('áudio') || tipo.includes('audio') || tipo.includes('ptt') || mime.startsWith('audio/')) {
        return _makeWaAudioHTML(urls, { dir });
      }

      const { fileName, extUp, extLower } = deriveFileName({ mimetype: mime, filename: name, url });
      const sizeTxt = _humanSize(a.size || a.bytes || a.length) || '';
      return `<div class="doc-card">
                <div class="doc-ico" style="background:${_extColor(extLower)}"><span class="ext">${extUp}</span></div>
                <div class="doc-body">
                  <a class="doc-name" href="${url}" target="_blank" rel="noopener" download="${fileName}" title="${fileName}">${escapeHtml(fileName)}</a>
                  <div class="doc-meta">${sizeTxt || 'arquivo'}</div>
                </div>
                <div class="doc-actions">
                  <a class="doc-btn" href="${url}" target="_blank" rel="noopener">Abrir</a>
                  <a class="doc-btn" href="${url}" download="${fileName}">Salvar</a>
                </div>
              </div>`;
    };

    let mediaHtml = anexos.map(renderAnexo).join('');

    // ✅ fallback por marcador (resolve "[Áudio/ptt]" sem anexo)
    if (!mediaHtml && m.msg_id && MARKER_RE.test(texto)) {
      const src = buildCanonUrlByMsgId(m.msg_id);
      const kind = texto.replace(/^\[|\].*$/g, '').toLowerCase();

      if (kind.startsWith('imagem')) {
        mediaHtml = `<a class="msg-media-img" href="${src}" target="_blank" rel="noopener">
                       <img src="${src}" alt="imagem" loading="lazy">
                     </a>`;
      } else if (kind.startsWith('vídeo') || kind.startsWith('video')) {
        mediaHtml = `<video class="msg-media-video" controls preload="metadata" src="${src}"></video>`;
      } else if (kind.startsWith('áudio') || kind.startsWith('audio')) {
        mediaHtml = _makeWaAudioHTML([src], { dir });
      } else if (kind.startsWith('figurinha')) {
        mediaHtml = `<img class="msg-sticker" src="${src}" alt="figurinha" loading="lazy">`;
      } else {
        const fname = 'arquivo.bin';
        mediaHtml = `<div class="doc-card">
                      <div class="doc-ico" style="background:#d9e0e3"><span class="ext">FILE</span></div>
                      <div class="doc-body">
                        <a class="doc-name" href="${src}" target="_blank" rel="noopener" download="${fname}" title="${fname}">${fname}</a>
                        <div class="doc-meta">arquivo</div>
                      </div>
                      <div class="doc-actions">
                        <a class="doc-btn" href="${src}" target="_blank" rel="noopener">Abrir</a>
                        <a class="doc-btn" href="${src}" download="${fname}">Salvar</a>
                      </div>
                    </div>`;
      }
    }

    const hasMedia = mediaHtml.trim().length > 0;
    const textHtml = texto
      ? `<div class="msg-text">${escapeHtml(texto)}</div>`
      : !hasMedia
      ? `<div class="msg-text">&nbsp;</div>`
      : '';

    return `<div class="msg-row ${isSaida ? 'msg-sent' : 'msg-received'}" data-id="${m.msg_id || ''}" data-msg-id="${m.msg_id || ''}">
      <div class="bubble ${isSaida ? 'bubble-out' : 'bubble-in'}" data-msg-id="${m.msg_id || ''}">
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

  // garante observer mesmo se #historico for recriado
  function ensureBound() {
    const hist = H();
    if (hist) {
      bindObserver(hist);
      enhance(hist);
    }
  }

  // listeners: quando troca de chat, atualiza avatar do áudio
  function bindChatEventsOnce() {
    if (document.__mediaRenderChatEvt) return;
    document.__mediaRenderChatEvt = true;

    const tick = () => {
      const hist = H() || document;
      refreshAudioAvatars(hist);
    };

    document.addEventListener('cliente:selecionar', tick);
    document.addEventListener('zc:open_chat', tick);
    document.addEventListener('chat:open', tick);

    // fallback (quando header atualiza foto depois via Evolution)
    setInterval(() => {
      const hist = H();
      if (!hist) return;
      refreshAudioAvatars(hist);
    }, 1200);
  }

  // ========= exports =========
  window.ensureMsgMediaCss = ensureMsgMediaCss;
  window.initAudioPlayers = initAudioPlayers;
  window.initMediaFallbacks = initMediaFallbacks;
  window.buildCanonUrlByMsgId = buildCanonUrlByMsgId;
  window.criarHTMLDaMensagem = criarHTMLDaMensagem;
  window.MediaRender = window.MediaRender || {};
  window.MediaRender.enhance = () => enhance(H() || document);

  // boot
  try { ensureMsgMediaCss(); } catch {}
  bindChatEventsOnce();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      ensureBound();
      // se #historico aparecer depois
      setInterval(ensureBound, 900);
    });
  } else {
    ensureBound();
    setInterval(ensureBound, 900);
  }
})();
