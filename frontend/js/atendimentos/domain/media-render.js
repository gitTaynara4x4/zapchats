// media-render.js — render de bolha (mídias, docs, áudio estilo WPP + fallbacks)

(function(){
  // helpers
  function escapeHtml(s){ return (s||'').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
  function ensureArray(a){ return Array.isArray(a) ? a : []; }

  // CSS único para mídias/documentos/áudio
  (function ensureMsgMediaCss(){
    if (document.getElementById('msg-media-css')) return;
    const s=document.createElement('style'); s.id='msg-media-css'; s.textContent = `
    .msg-media-img{display:block;max-width:min(420px,70vw);border-radius:8px;overflow:hidden}
    .msg-media-img img{display:block;max-width:100%;height:auto;border-radius:8px}
    .msg-media-video{display:block;max-width:min(420px,70vw);border-radius:8px;overflow:hidden}
    .msg-sticker{display:block;max-width:220px;height:auto}
    .doc-card{display:flex;gap:10px;align-items:center;background:#1f2c33;border:1px solid #2a3942;
              border-radius:10px;padding:10px;min-width:min(320px,70vw);max-width:min(420px,70vw)}
    .doc-ico{width:42px;height:42px;border-radius:8px;display:grid;place-items:center;font-weight:700;color:#111}
    .doc-ico .ext{font-size:11px;letter-spacing:.5px}
    .doc-body{flex:1;min-width:0}
    .doc-name{display:block;color:#e9edef;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .doc-meta{font-size:12px;color:#aebac1;margin-top:2px}
    .doc-actions{display:flex;gap:6px}
    .doc-btn{background:#0b141a;border:1px solid #2a3942;color:#d1d7db;padding:6px 10px;border-radius:8px;font-size:12px;text-decoration:none}
    .wa-audio{display:flex;align-items:center;gap:12px;background:#0b141a;border:1px solid #2a3942;border-radius:14px;padding:10px 12px;max-width:min(420px,70vw)}
    .wa-audio .play{width:38px;height:38px;border:0;border-radius:9999px;background:#25d366;display:grid;place-items:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35)}
    .wa-audio .play::before{content:"";border-left:12px solid #111b21;border-top:8px solid transparent;border-bottom:8px solid transparent;margin-left:2px}
    .wa-audio .play.playing::before{content:"";width:12px;height:14px;background:linear-gradient(90deg,#111b21 0 40%,transparent 40% 60%,#111b21 60% 100%)}
    .wa-audio .bar{flex:1;display:flex;align-items:center;gap:8px}
    .wa-audio input[type="range"]{-webkit-appearance:none;appearance:none;width:100%;height:3px;background:#37545f;border-radius:9999px;outline:none}
    .wa-audio input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:9999px;background:#25d366;margin-top:-5px}
    .wa-audio .t{color:#aebac1;font-size:12px;min-width:84px;text-align:right}
    .wa-audio .t .sep{opacity:.6;margin:0 2px}
    .ack-mini{display:inline-block;margin-right:4px;vertical-align:middle}
    .ack-mini i{font-size:12px;line-height:1}
    `;
    document.head.appendChild(s);
  })();

  // utils docs
  function _humanSize(bytes){
    const b=Number(bytes||0); if(!b) return ''; const u=['B','KB','MB','GB']; const i=Math.floor(Math.log(b)/Math.log(1024));
    return `${(b/Math.pow(1024,i)).toFixed(i?1:0)} ${u[i]}`;
  }
  function _basenameFromUrl(u){
    try{
      const p = new URL(u, location.origin).pathname;
      const b = p.split('/').pop() || '';
      return decodeURIComponent(b);
    }catch{ return ''; }
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
    const base = _sanitizeBase(baseRaw.replace(/\.[a-z0-9]{1,6}$/i,'')); // sem duplicar extensão
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

  // player de áudio WPP
  function _fmtT(sec){ const s=Math.max(0, Math.floor(sec||0)); const m=Math.floor(s/60); return `${m}:${String(s%60).padStart(2,'0')}`; }
  function initAudioPlayers(root=document){
    root.querySelectorAll('.wa-audio').forEach(el=>{
      if (el._ok) return; el._ok = true;
      const srcs  = (el.getAttribute('data-src')||'').split('|').filter(Boolean);
      let idx     = 0;
      const btn   = el.querySelector('.play');
      const range = el.querySelector('input[type="range"]');
      const curEl = el.querySelector('.t .cur') || (function(){ const s=document.createElement('span'); s.className='cur'; el.querySelector('.t')?.prepend(s); return s; })();
      const durEl = el.querySelector('.t .dur') || (function(){ const s=document.createElement('span'); s.className='dur'; el.querySelector('.t')?.appendChild(s); return s; })();
      const audio = new Audio(srcs[0]||''); audio.preload='metadata';

      const tryNext = ()=>{
        if (idx < srcs.length-1){
          idx++;
          audio.src = srcs[idx];
          audio.load();
          if (!audio.paused) audio.play().catch(()=>{});
        }
      };

      let seeking=false;

      const updateProgress = ()=>{
        if (seeking) return;
        if (isFinite(audio.duration) && audio.duration>0){
          range.value = Math.max(0, Math.min(100, (audio.currentTime/audio.duration)*100));
          curEl.textContent = _fmtT(audio.currentTime||0);
        }else{
          range.value = 0; curEl.textContent = '0:00';
        }
      };

      btn?.addEventListener('click', ()=> audio.paused ? audio.play() : audio.pause());
      audio.addEventListener('play',  ()=> btn?.classList.add('playing'));
      audio.addEventListener('pause', ()=> btn?.classList.remove('playing'));
      audio.addEventListener('loadedmetadata', ()=>{
        durEl.textContent = _fmtT(audio.duration||0);
        curEl.textContent = _fmtT(audio.currentTime||0);
        range.value = 0;
      });
      audio.addEventListener('durationchange', ()=>{ if (isFinite(audio.duration)) durEl.textContent = _fmtT(audio.duration); });
      audio.addEventListener('timeupdate', updateProgress);
      audio.addEventListener('ended', ()=>{ btn?.classList.remove('playing'); range.value=0; curEl.textContent='0:00'; });
      audio.addEventListener('error', tryNext);

      range.addEventListener('input', ()=>{
        seeking=true;
        if (isFinite(audio.duration) && audio.duration>0){
          audio.currentTime = (range.value/100)*audio.duration;
          curEl.textContent = _fmtT(audio.currentTime||0);
        }
        seeking=false;
      });
    });
  }
  function initMediaFallbacks(root=document){
    root.querySelectorAll('img[data-alt]').forEach(img=>{
      if (img._fb) return; img._fb = true;
      img.addEventListener('error', ()=>{
        const list = (img.dataset.alt||'').split('|').filter(Boolean);
        if (!list.length) return;
        img.src = list.shift();
        img.dataset.alt = list.join('|');
      });
    });
  }

  // url canônica por msg_id
  function buildCanonUrlByMsgId(msg_id){
    return `/api/atendimento/midias/msg/${encodeURIComponent(msg_id)}?empresa_id=${EMPRESA_ID}`;
  }
  function resolveUrlsForMedia(m, a){
    const MSG_CANON = m?.msg_id ? buildCanonUrlByMsgId(m.msg_id) : null;
    const idUrl     = a?.id ? `/api/atendimento/midias/${encodeURIComponent(a.id)}?empresa_id=${EMPRESA_ID}` : '';
    const primary   = MSG_CANON || a?.url_api || a?.url || a?.link || a?.path || idUrl;
    const alts      = [];
    if (MSG_CANON) [a?.url_api, a?.url, a?.link, a?.path, idUrl].forEach(u=>u && alts.push(u));
    const seen=new Set();
    return [primary, ...alts].filter(u=>u && !seen.has(u) && seen.add(u));
  }

  const MARKER_RE = /^\[(Imagem|Vídeo|Video|Áudio\/ptt|Áudio|Audio|Documento|Figurinha|Localização|Contatos?|M[íi]dia)\](?:\s.*)?$/i;

  function criarHTMLDaMensagem(m){
    const isSaida = (m.tipo === "saida");
    const hora = (window.formatChatTime||((x)=>new Date(x).toLocaleString('pt-BR')))(m.timestamp || m.data || m.created_at || "");
    const texto = String(m.conteudo ?? m.mensagem ?? m.texto ?? "").trim();
    const ackHtml = isSaida ? `<span class="msg-ack" title="ack=${(window.normalizeAck||((a)=>a))(m.ack ?? 0)}">${(window.getAckIcon||(()=>''))(m.ack)}</span>` : "";

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
      if (!a) return "";
      const urls = resolveUrlsForMedia(m, a);
      const [url, ...alts] = urls;
      const mime = (a.mimetype || a.mime || "").toLowerCase();
      const tipo = (a.tipo || "").toLowerCase();
      const name = a.filename || a.name || "arquivo";

      // Imagem / Figurinha
      if (tipo.includes("imagem") || tipo.includes("image") || tipo.includes("figurinha") || mime.startsWith("image/")){
        return `<a class="msg-media-img" href="${url}" target="_blank" rel="noopener">
                  <img src="${url}" data-alt="${alts.join('|')}" alt="${escapeHtml(name)}" loading="lazy">
                </a>`;
      }

      // Vídeo
      if (tipo.includes("vídeo") || tipo.includes("video") || mime.startsWith("video/")){
        return `<video class="msg-media-video" controls preload="metadata">
                  ${urls.map(u=>`<source src="${u}">`).join('')}
                </video>`;
      }

      // Áudio (inclui PTT)
      if (tipo.includes("áudio") || tipo.includes("audio") || tipo.includes("ptt") || mime.startsWith("audio/")){
        return `<div class="wa-audio" data-src="${urls.join('|')}">
                  <button class="play" aria-label="Tocar/Pausar"></button>
                  <div class="bar"><input type="range" min="0" max="100" value="0" aria-label="Progresso"></div>
                  <span class="t"><span class="cur">0:00</span><span class="sep">/</span><span class="dur">0:00</span></span>
                </div>`;
      }

      // Documento
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

    // Fallback por marcador + msg_id
    if (!mediaHtml && m.msg_id) {
      const mMatch = String(texto || m.mensagem || '').match(/^\[(Imagem|Vídeo|Video|Áudio(?:\/ptt)?|Audio(?:\/ptt)?|Documento|Figurinha|M[íi]dia)\]/i);
      if (mMatch) {
        const src  = buildCanonUrlByMsgId(m.msg_id);
        const kind = (mMatch[1] || "").toLowerCase();

        if (kind.startsWith("imagem")) {
          mediaHtml = `<a class="msg-media-img" href="${src}" target="_blank" rel="noopener">
                         <img src="${src}" alt="imagem" loading="lazy">
                       </a>`;
        } else if (kind.startsWith("vídeo") || kind.startsWith("video")) {
          mediaHtml = `<video class="msg-media-video" controls preload="metadata"><source src="${src}"></video>`;
        } else if (kind.startsWith("áudio") || kind.startsWith("audio")) {
          mediaHtml = `<div class="wa-audio" data-src="${src}">
                         <button class="play" aria-label="Tocar/Pausar"></button>
                         <div class="bar"><input type="range" min="0" max="100" value="0" aria-label="Progresso"></div>
                         <span class="t"><span class="cur">0:00</span><span class="sep">/</span><span class="dur">0:00</span></span>
                       </div>`;
        } else if (kind.startsWith("figurinha")) {
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
    }

    const hasMedia = mediaHtml.trim().length > 0;
    const textHtml = (!hasMedia && texto) ? `<div class="msg-text">${escapeHtml(texto)}</div>` : "";

    return `<div class="msg-row ${isSaida ? "msg-sent" : "msg-received"}" data-id="${m.msg_id || ""}">
      <div class="bubble ${isSaida ? "bubble-out" : "bubble-in"}">
        ${mediaHtml}${textHtml}
        <span class="msg-time">${hora}${ackHtml}</span>
      </div>
    </div>`;
  }

  // exporta
  window.initAudioPlayers    = initAudioPlayers;
  window.initMediaFallbacks  = initMediaFallbacks;
  window.buildCanonUrlByMsgId= buildCanonUrlByMsgId;
  window.criarHTMLDaMensagem = criarHTMLDaMensagem;
})();
