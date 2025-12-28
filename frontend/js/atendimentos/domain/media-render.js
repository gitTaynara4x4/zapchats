// /frontend/js/atendimentos/ui/media-render.js
// Render de mídias/docs/áudio (player estilo WPP) + fallbacks por marcador [Áudio/ptt]
// + auto-init (MutationObserver) + upgrade de <audio controls> -> .wa-audio

(function(){
  // ========= helpers =========
  function escapeHtml(s){
    return (s||'').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
  }
  function uniq(arr){
    const out=[]; const s=new Set();
    (arr||[]).forEach(x=>{
      const v=String(x||'').trim();
      if(!v) return;
      if(s.has(v)) return;
      s.add(v); out.push(v);
    });
    return out;
  }

  // ========= CSS (áudio bonito fica aqui) =========
  function ensureMsgMediaCss(){
    if (document.getElementById('msg-media-css')) return;
    const s=document.createElement('style'); s.id='msg-media-css'; s.textContent = `
    .msg-media-img{display:block;max-width:min(420px,70vw);border-radius:10px;overflow:hidden}
    .msg-media-img img{display:block;max-width:100%;height:auto;border-radius:10px}
    .msg-media-video{display:block;max-width:min(420px,70vw);border-radius:10px;overflow:hidden}
    .msg-sticker{display:block;max-width:220px;height:auto}

    .doc-card{display:flex;gap:10px;align-items:center;background:#1f2c33;border:1px solid #2a3942;
              border-radius:12px;padding:10px;min-width:min(320px,70vw);max-width:min(420px,70vw)}
    .doc-ico{width:42px;height:42px;border-radius:10px;display:grid;place-items:center;font-weight:700;color:#111}
    .doc-ico .ext{font-size:11px;letter-spacing:.5px}
    .doc-body{flex:1;min-width:0}
    .doc-name{display:block;color:#e9edef;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .doc-meta{font-size:12px;color:#aebac1;margin-top:2px}
    .doc-actions{display:flex;gap:6px}
    .doc-btn{background:#0b141a;border:1px solid #2a3942;color:#d1d7db;padding:6px 10px;border-radius:10px;font-size:12px;text-decoration:none}

    /* ✅ PLAYER ÁUDIO (mais bonito) */
    .wa-audio{
      display:flex;align-items:center;gap:12px;
      background:rgba(0,0,0,.22);
      border:1px solid rgba(255,255,255,.14);
      border-radius:16px;
      padding:10px 12px;
      max-width:min(520px,78vw);
      box-shadow:0 10px 24px rgba(0,0,0,.18);
      backdrop-filter: blur(6px);
    }
    .bubble-out .wa-audio{
      background: rgba(37,211,102,.10);
      border-color: rgba(37,211,102,.22);
    }

    .wa-audio .play{
      width:42px;height:42px;border:0;border-radius:9999px;
      background:#25d366;
      display:grid;place-items:center;cursor:pointer;
      box-shadow:0 10px 20px rgba(0,0,0,.22);
      flex:0 0 auto;
    }
    .wa-audio .play:active{transform:translateY(1px)}
    .wa-audio .play::before{
      content:"";
      border-left:12px solid #0b141a;
      border-top:8px solid transparent;
      border-bottom:8px solid transparent;
      margin-left:2px;
    }
    .wa-audio .play.playing::before{
      content:"";
      width:12px;height:14px;
      background:linear-gradient(90deg,#0b141a 0 40%,transparent 40% 60%,#0b141a 60% 100%);
      margin-left:0;
    }

    .wa-audio .bar{
      flex:1;
      display:flex;
      align-items:center;
      gap:8px;
      min-width:180px;
    }

    /* ✅ range alinhado (thumb no meio) */
    .wa-audio input[type="range"]{
      -webkit-appearance:none;
      appearance:none;
      width:100%;
      height:18px;                 /* dá “altura” pro controle */
      background:transparent;      /* track fica nos pseudo-elements */
      outline:none;
      margin:0;
      padding:0;
      vertical-align:middle;
    }
    .wa-audio input[type="range"]::-webkit-slider-runnable-track{
      height:4px;
      background:rgba(255,255,255,.18);
      border-radius:9999px;
    }
    .wa-audio input[type="range"]::-webkit-slider-thumb{
      -webkit-appearance:none;
      appearance:none;
      width:12px;height:12px;border-radius:9999px;
      background:#25d366;
      margin-top:-4px;             /* centraliza no track (12-4)/2 */
      box-shadow:0 6px 14px rgba(0,0,0,.25);
    }
    .wa-audio input[type="range"]::-moz-range-track{
      height:4px;
      background:rgba(255,255,255,.18);
      border-radius:9999px;
    }
    .wa-audio input[type="range"]::-moz-range-thumb{
      width:12px;height:12px;border-radius:9999px;border:0;
      background:#25d366;
      box-shadow:0 6px 14px rgba(0,0,0,.25);
    }

    .wa-audio .t{
      color:rgba(255,255,255,.70);
      font-size:12px;
      min-width:92px;
      text-align:right;
      user-select:none;
    }
    .wa-audio .t .sep{opacity:.6;margin:0 4px}
    `;
    document.head.appendChild(s);
  }

  // ========= docs utils =========
  function _humanSize(bytes){
    const b=Number(bytes||0); if(!b) return '';
    const u=['B','KB','MB','GB']; const i=Math.floor(Math.log(b)/Math.log(1024));
    return `${(b/Math.pow(1024,i)).toFixed(i?1:0)} ${u[i]}`;
  }
  function _basenameFromUrl(u){
    try{ const p = new URL(u, location.origin).pathname; const b = p.split('/').pop() || ''; return decodeURIComponent(b); }
    catch{ return ''; }
  }
  function _guessExt({ mimetype='', filename='', url='' }={}){
    const fromName = (filename||'').split('.').pop()?.toLowerCase()
      || _basenameFromUrl(url).split('.').pop()?.toLowerCase() || '';
    const map = {
      'application/pdf':'pdf',
      'application/msword':'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
      'application/vnd.ms-excel':'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
      'application/vnd.ms-powerpoint':'ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx',
      'text/plain':'txt',
      'image/png':'png','image/jpeg':'jpg','image/webp':'webp',
      'audio/mpeg':'mp3','audio/ogg':'ogg','audio/wav':'wav',
      'video/mp4':'mp4'
    };
    return (map[mimetype] || fromName || 'bin').toLowerCase();
  }
  function _sanitizeBase(name){
    const n = (name||'').toString().trim() || 'arquivo';
    return n.normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^\w\-.]+/g,'_').replace(/_+/g,'_')
      .replace(/^_+|_+$/g,'').slice(0,80);
  }
  function deriveFileName(a){
    const url = a.url || a.link || a.path || '';
    const baseRaw = a.filename || a.name || a.nome_original || _basenameFromUrl(url) || 'arquivo';
    const base = _sanitizeBase(baseRaw.replace(/\.[a-z0-9]{1,6}$/i,''));
    const ext  = _guessExt({ mimetype:(a.mimetype||a.mime||''), filename:(a.filename||a.name||''), url });
    return { fileName: `${base}.${ext}`, extUp: ext.toUpperCase(), extLower: ext.toLowerCase() };
  }
  function _extColor(ext){
    const e=(ext||'').toLowerCase();
    if (['pdf'].includes(e)) return '#ffb1b1';
    if (['doc','docx'].includes(e)) return '#b1c9ff';
    if (['xls','xlsx','csv'].includes(e)) return '#b1ffd1';
    if (['ppt','pptx'].includes(e)) return '#ffd9b1';
    if (['zip','rar','7z'].includes(e)) return '#ffe3a1';
    return '#d9e0e3';
  }

  // ========= inst/empresa =========
  function _instQ(){
    try{ return (typeof window._instQuery === 'function') ? (window._instQuery() || '') : ''; }
    catch{ return ''; }
  }
  function buildCanonUrlByMsgId(msg_id){
    // ✅ NÃO precisa empresa_id: backend usa empresa do token quando empresa_id=None
    const base = `/api/atendimento/midias/msg/${encodeURIComponent(msg_id)}`;
    const iq = String(_instQ() || '').replace(/^\&/,''); // vem como "&instancia_id=3"
    return iq ? `${base}?${iq}` : base;
  }

  function resolveUrlsForMedia(m, a){
    const MSG_CANON = m?.msg_id ? buildCanonUrlByMsgId(m.msg_id) : null;
    const iq = String(_instQ() || '');
    const idUrl = a?.id ? `/api/atendimento/midias/${encodeURIComponent(a.id)}${iq ? `?${iq.replace(/^\&/,'')}` : ''}` : '';
    const primary = MSG_CANON || a?.url_api || a?.url || a?.link || a?.path || idUrl;

    const alts = [];
    if (MSG_CANON) [a?.url_api, a?.url, a?.link, a?.path, idUrl].forEach(u=>u && alts.push(u));

    const seen=new Set();
    return [primary, ...alts].filter(u=>u && !seen.has(u) && seen.add(u));
  }

  // ========= player áudio =========
  function _fmtT(sec){
    const s=Math.max(0, Math.floor(sec||0));
    const m=Math.floor(s/60);
    return `${m}:${String(s%60).padStart(2,'0')}`;
  }

  function initAudioPlayers(root=document){
    root.querySelectorAll('.wa-audio').forEach(el=>{
      if (el._ok) return; el._ok = true;

      const srcs  = uniq((el.getAttribute('data-src')||'').split('|'));
      let idx     = 0;

      const btn   = el.querySelector('.play');
      const range = el.querySelector('input[type="range"]');
      const curEl = el.querySelector('.t .cur');
      const durEl = el.querySelector('.t .dur');

      const audio = new Audio(srcs[0]||'');
      audio.preload = 'metadata';

      // pausa outros tocando
      window.__ZC_AUDIO__ = window.__ZC_AUDIO__ || new Set();
      window.__ZC_AUDIO__.add(audio);

      const pauseOthers = ()=>{
        try{ window.__ZC_AUDIO__.forEach(a=>{ if(a!==audio) a.pause(); }); }catch{}
      };

      const tryNext = ()=>{
        if (idx < srcs.length-1){
          idx++;
          audio.src = srcs[idx];
          try{ audio.load(); }catch{}
          if (!audio.paused) audio.play().catch(()=>{});
        }
      };

      let seeking=false;

      const updateProgress = ()=>{
        if (seeking) return;
        if (isFinite(audio.duration) && audio.duration>0){
          if (range) range.value = Math.max(0, Math.min(100, (audio.currentTime/audio.duration)*100));
          if (curEl) curEl.textContent = _fmtT(audio.currentTime||0);
        }else{
          if (range) range.value = 0;
          if (curEl) curEl.textContent = '0:00';
        }
      };

      btn?.addEventListener('click', ()=>{
        if (audio.paused){
          pauseOthers();
          audio.play().catch(()=>{});
        } else {
          audio.pause();
        }
      });

      audio.addEventListener('play',  ()=> btn?.classList.add('playing'));
      audio.addEventListener('pause', ()=> btn?.classList.remove('playing'));
      audio.addEventListener('loadedmetadata', ()=>{
        if (durEl) durEl.textContent = _fmtT(audio.duration||0);
        if (curEl) curEl.textContent = _fmtT(audio.currentTime||0);
        if (range) range.value = 0;
      });
      audio.addEventListener('durationchange', ()=>{
        if (isFinite(audio.duration) && durEl) durEl.textContent = _fmtT(audio.duration);
      });
      audio.addEventListener('timeupdate', updateProgress);
      audio.addEventListener('ended', ()=>{
        btn?.classList.remove('playing');
        if (range) range.value=0;
        if (curEl) curEl.textContent='0:00';
      });
      audio.addEventListener('error', tryNext);

      range?.addEventListener('input', ()=>{
        seeking=true;
        if (isFinite(audio.duration) && audio.duration>0){
          audio.currentTime = (Number(range.value||0)/100)*audio.duration;
          if (curEl) curEl.textContent = _fmtT(audio.currentTime||0);
        }
        seeking=false;
      });
    });
  }

  function initMediaFallbacks(root=document){
    // img fallback
    root.querySelectorAll('img[data-alt]').forEach(img=>{
      if (img._fb) return; img._fb = true;
      img.addEventListener('error', ()=>{
        const list = (img.dataset.alt||'').split('|').filter(Boolean);
        if (!list.length) return;
        img.src = list.shift();
        img.dataset.alt = list.join('|');
      });
    });

    // video fallback
    root.querySelectorAll('video[data-alt]').forEach(v=>{
      if (v._fb) return; v._fb = true;
      v.addEventListener('error', ()=>{
        const list = (v.dataset.alt||'').split('|').filter(Boolean);
        if (!list.length) return;
        v.src = list.shift();
        v.dataset.alt = list.join('|');
        try{ v.load(); }catch{}
      }, { passive:true });
    });
  }

  // ========= fallback por marcador =========
  const MARKER_RE = /^\[(Imagem|Vídeo|Video|Áudio\/ptt|Áudio|Audio|Documento|Figurinha|Localização|Contatos?|M[íi]dia)\]/i;

  function _makeWaAudioHTML(urls){
    const list = uniq(urls);
    // ⚠️ não escapar URL aqui, senão quebra ("/api/..&inst=.." vira entidade)
    return `<div class="wa-audio" data-src="${list.join('|')}">
              <button class="play" aria-label="Tocar/Pausar"></button>
              <div class="bar"><input type="range" min="0" max="100" value="0" aria-label="Progresso"></div>
              <span class="t"><span class="cur">0:00</span><span class="sep">/</span><span class="dur">0:00</span></span>
            </div>`;
  }

  // ✅ upgrade: se historico.js renderizar <audio controls>, troca por .wa-audio
  function upgradeNativeAudios(root=document){
    root.querySelectorAll('audio[controls]:not([data-up-wa="1"])').forEach(a=>{
      a.setAttribute('data-up-wa','1');

      const srcs = [];
      const s1 = a.getAttribute('src') || a.currentSrc || a.src || '';
      if (s1) srcs.push(s1);

      // <source>
      a.querySelectorAll('source').forEach(s=>{
        const u = s.getAttribute('src') || s.src || '';
        if (u) srcs.push(u);
      });

      // data-alt
      const alt = a.dataset?.alt ? String(a.dataset.alt) : '';
      if (alt) alt.split('|').forEach(u=>srcs.push(u));

      const urls = uniq(srcs);
      if (!urls.length) return;

      const wrap = document.createElement('div');
      wrap.innerHTML = _makeWaAudioHTML(urls);
      const node = wrap.firstElementChild;
      if (!node) return;

      a.replaceWith(node);
    });
  }

  // ✅ fallback DOM: se tiver só "[Áudio/ptt]" no texto e sem mídia, injeta player usando msg_id do dataset
  function injectMarkerAudios(root=document){
    root.querySelectorAll('.msg-row').forEach(row=>{
      const bubble = row.querySelector('.bubble');
      if (!bubble) return;

      // já tem player ou audio?
      if (bubble.querySelector('.wa-audio, audio[controls]')) return;

      const txtEl = bubble.querySelector('.msg-text');
      const txt = (txtEl?.textContent || '').trim();
      if (!MARKER_RE.test(txt)) return;

      const kind = txt.replace(/^\[|\].*$/g,'').toLowerCase();
      if (!(kind.startsWith('áudio') || kind.startsWith('audio'))) return;

      const msgId =
        row.getAttribute('data-msg-id')
        || bubble.getAttribute('data-msg-id')
        || row.getAttribute('data-id')
        || '';

      if (!msgId) return;

      const src = buildCanonUrlByMsgId(msgId);
      const html = _makeWaAudioHTML([src]);

      // injeta antes do texto
      bubble.insertAdjacentHTML('afterbegin', html);

      // se o texto for SÓ o marcador, esconde (fica só o player bonito)
      if (txtEl && /^\[[^\]]+\]$/i.test(txt)) {
        txtEl.style.display = 'none';
      }
    });
  }

  // ========= (compat) criarHTMLDaMensagem — se algum lugar usar window.criarHTMLDaMensagem =========
  function criarHTMLDaMensagem(m){
    ensureMsgMediaCss();

    const isSaida = (m.tipo === "saida") || (m.from_me === true) || (m.origem === 'atendente');
    const hora = (window.formatChatTime || ((x)=>new Date(x).toLocaleString('pt-BR')))(m.timestamp || m.data || m.created_at || "");
    const texto = String(m.conteudo ?? m.mensagem ?? m.texto ?? "").trim();

    const ackHtml = (isSaida && typeof window.getAckIcon === 'function')
      ? window.getAckIcon(m.ack ?? 0)
      : "";

    // anexos (dedup)
    let anexos = [];
    if (Array.isArray(m.midias) && m.midias.length) anexos.push(...m.midias.filter(Boolean));
    else if (m.midia && typeof m.midia === "object") anexos.push(m.midia);

    const seen = new Set();
    anexos = anexos.filter(a=>{
      if (!a) return false;
      const k = [
        a.id ?? "",
        a.url || a.url_api || a.link || a.path || "",
        a.tipo || "",
        a.mimetype || a.mime || "",
        a.filename || a.name || ""
      ].join("|");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const renderAnexo = (a)=>{
      const urls = resolveUrlsForMedia(m, a);
      const [url, ...alts] = urls;

      const mime = (a.mimetype || a.mime || "").toLowerCase();
      const tipo = (a.tipo || "").toLowerCase();
      const name = a.filename || a.name || "arquivo";

      if (tipo.includes("imagem") || tipo.includes("image") || tipo.includes("figurinha") || mime.startsWith("image/")){
        return `<a class="msg-media-img" href="${url}" target="_blank" rel="noopener">
                  <img src="${url}" data-alt="${alts.join('|')}" alt="${escapeHtml(name)}" loading="lazy">
                </a>`;
      }

      if (tipo.includes("vídeo") || tipo.includes("video") || mime.startsWith("video/")){
        return `<video class="msg-media-video" controls preload="metadata" src="${url}" data-alt="${alts.join('|')}"></video>`;
      }

      if (tipo.includes("áudio") || tipo.includes("audio") || tipo.includes("ptt") || mime.startsWith("audio/")){
        return _makeWaAudioHTML(urls);
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

    let mediaHtml = anexos.map(renderAnexo).join("");

    // ✅ FALLBACK POR MARCADOR (resolve PTT que vem como "[Áudio/ptt]" sem anexo)
    if (!mediaHtml && m.msg_id && MARKER_RE.test(texto)) {
      const src  = buildCanonUrlByMsgId(m.msg_id);
      const kind = texto.replace(/^\[|\].*$/g,'').toLowerCase();

      if (kind.startsWith('imagem')) {
        mediaHtml = `<a class="msg-media-img" href="${src}" target="_blank" rel="noopener">
                       <img src="${src}" alt="imagem" loading="lazy">
                     </a>`;
      } else if (kind.startsWith('vídeo') || kind.startsWith('video')) {
        mediaHtml = `<video class="msg-media-video" controls preload="metadata" src="${src}"></video>`;
      } else if (kind.startsWith('áudio') || kind.startsWith('audio')) {
        mediaHtml = _makeWaAudioHTML([src]);
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
    const textHtml = texto ? `<div class="msg-text">${escapeHtml(texto)}</div>` : (!hasMedia ? `<div class="msg-text">&nbsp;</div>` : '');

    return `<div class="msg-row ${isSaida ? "msg-sent" : "msg-received"}" data-id="${m.msg_id || ""}" data-msg-id="${m.msg_id || ""}">
      <div class="bubble ${isSaida ? "bubble-out" : "bubble-in"}" data-msg-id="${m.msg_id || ""}">
        ${mediaHtml}${textHtml}
        <div class="meta">
          ${ackHtml}
          <span class="msg-time">${hora}</span>
        </div>
      </div>
    </div>`;
  }

  // ========= auto-run no histórico =========
  function enhance(root){
    try { ensureMsgMediaCss(); } catch {}
    try { initMediaFallbacks(root); } catch {}
    try { upgradeNativeAudios(root); } catch {}
    try { injectMarkerAudios(root); } catch {}
    try { initAudioPlayers(root); } catch {}
  }

  function bindObserver(){
    const hist = document.getElementById('historico');
    if (!hist || hist.__mediaObs) return;
    hist.__mediaObs = true;

    let raf = 0;
    const mo = new MutationObserver(()=>{
      if (raf) return;
      raf = requestAnimationFrame(()=>{
        raf = 0;
        enhance(hist);
      });
    });
    mo.observe(hist, { childList:true, subtree:true });
  }

  // ========= exports =========
  window.ensureMsgMediaCss    = ensureMsgMediaCss;
  window.initAudioPlayers     = initAudioPlayers;
  window.initMediaFallbacks   = initMediaFallbacks;
  window.buildCanonUrlByMsgId = buildCanonUrlByMsgId;
  window.criarHTMLDaMensagem  = criarHTMLDaMensagem;
  window.MediaRender = window.MediaRender || {};
  window.MediaRender.enhance = ()=> enhance(document.getElementById('historico') || document);

  // boot
  try { ensureMsgMediaCss(); } catch {}
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ()=>{
      const hist = document.getElementById('historico') || document;
      enhance(hist);
      bindObserver();
    });
  } else {
    const hist = document.getElementById('historico') || document;
    enhance(hist);
    bindObserver();
  }
})();
