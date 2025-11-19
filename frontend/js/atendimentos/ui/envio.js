import { EMPRESA_ID } from '../core/env.js';
import { numeroE164 } from '../core/format.js';
import { state } from '../state/store.js';

/* ====== Fallback pra window.addListener (caso alguém ainda use) ====== */
if (typeof window !== 'undefined' && typeof window.addListener !== 'function') {
  window.addListener = function (...args) {
    console.warn('[envio.js] window.addListener fallback chamado', ...args);
  };
}

/* ========= TOASTZINHO ========= */
function toast(msg, ok = true) {
  let t = document.getElementById('__app_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '__app_toast';
    Object.assign(t.style, {
      position: 'fixed', left: '50%', bottom: '22px',
      transform: 'translateX(-50%)',
      maxWidth: '90vw', padding: '8px 12px',
      color: '#fff', background: '#1e293b',
      borderRadius: '8px', boxShadow: '0 8px 20px rgba(0,0,0,.28)',
      zIndex: 99999, fontSize: '13px', lineHeight: '1.25',
      opacity: '0', transition: 'opacity .15s, transform .15s', pointerEvents: 'none'
    });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.background = ok ? '#1e293b' : '#7f1d1d';
  t.style.opacity = '1';
  t.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(t.__timer);
  t.__timer = setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(4px)';
  }, 1600);
}

/* ========= MODAIS PRÓPRIOS SLIM + CSS DO COMPOSER ========= */
function ensureDialogCSS() {
  if (document.getElementById('zcDlgCSS')) return;
  const st = document.createElement('style');
  st.id = 'zcDlgCSS';
  st.textContent = `
    .zcDlgBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);
      display:flex;align-items:center;justify-content:center;z-index:10000}
    .zcDlg{width:min(420px,92vw);background:#0b141a;color:#d1d5db;
      border:1px solid #23323a;border-radius:10px;
      box-shadow:0 12px 32px rgba(0,0,0,.35);
      transform:translateY(6px);opacity:0;transition:opacity .12s ease, transform .12s ease}
    .zcDlg.show{opacity:1;transform:none}
    .zcDlg .h{padding:10px 12px 8px;font-weight:600;font-size:14px;letter-spacing:.2px}
    .zcDlg .b{padding:6px 12px 8px}
    .zcDlg .row{display:flex;gap:8px;margin:6px 0;align-items:center}
    .zcDlg .row label{min-width:74px;font-size:12.5px;opacity:.8}
    .zcDlg .in{flex:1;height:34px;padding:6px 10px;border-radius:8px;background:#0a1015;
      border:1px solid #25343c;color:#e5e7eb;font:inherit;outline:none}
    .zcDlg .in:focus{border-color:#00a884;box-shadow:0 0 0 2px rgba(0,168,132,.15)}
    .zcDlg .f{display:flex;gap:8px;justify-content:flex-end;padding:8px 12px 10px}
    .zcBtn{padding:7px 12px;border-radius:8px;border:1px solid #2a3942;
      background:#0e1720;color:#e5e7eb;font-size:13px;cursor:pointer}
    .zcBtn:hover{background:#0f1c26}
    .zcBtn.ghost{background:transparent}
    .zcBtn.ghost:hover{background:rgba(255,255,255,.04)}
    .zcBtn.ok{border-color:#00a884;background:#0b251f}
    .zcBtn.ok:hover{background:#0d2b24}
    .zcBtn.danger{border-color:#ef4444;background:#2a1111;color:#fca5a5}
    .zcMsg{font-size:13px;line-height:1.35;opacity:.95;padding:2px 0}

    /* ===== preview de arquivos (tipo WPP) ===== */
    .zcDlg.zcDlg-filePreview{
      width:min(640px,96vw);
      max-height:90vh;
      display:flex;
      flex-direction:column;
    }
    .zcDlg.zcDlg-filePreview .b{
      max-height:calc(90vh - 92px);
      overflow:auto;
    }
    .zpPrev{display:flex;flex-direction:column;gap:10px;}
    .zpPrev-main{display:flex;gap:10px;align-items:flex-start;}
    .zpPrev-thumb{
      flex:0 0 120px;height:120px;border-radius:8px;overflow:hidden;
      background:#020617;display:flex;align-items:center;justify-content:center;
      font-size:32px;color:#64748b;
    }
    .zpPrev-thumb img{max-width:100%;max-height:100%;object-fit:contain;display:block;}
    .zpPrev-meta{font-size:12px;color:#9ca3af;}
    .zpPrev-name{font-size:13px;color:#e5e7eb;margin-bottom:2px;word-break:break-all;}
    .zpPrev-caption-row{margin-top:8px;}
    .zpPrev-caption-row textarea{
      width:100%;min-height:64px;resize:vertical;border-radius:8px;
      border:1px solid #25343c;background:#020617;color:#e5e7eb;
      font:inherit;padding:6px 8px;outline:none;
    }
    .zpPrev-caption-row textarea:focus{
      border-color:#00a884;box-shadow:0 0 0 2px rgba(0,168,132,.15);
    }
    .zpPrev-list{font-size:12px;color:#9ca3af;margin-top:6px;max-height:120px;overflow:auto;}
    .zpPrev-list ul{margin:0;padding-left:16px;}

    /* ===== chat footer estilo WhatsApp Web ===== */
    #chat-footer{
      display:flex;
      align-items:center;
      gap:8px;
      padding:8px 10px 10px;
      background:transparent;
    }
    #chat-footer .clip-btn,
    #chat-footer .mic-btn,
    #chat-footer .send-btn{
      width:40px;
      height:40px;
      border-radius:999px;
      border:0;
      display:flex;
      align-items:center;
      justify-content:center;
      background:#202c33;
      color:#aebac1;
      cursor:pointer;
      flex-shrink:0;
    }
    #chat-footer .clip-btn i,
    #chat-footer .mic-btn i{
      font-size:18px;
    }
    #chat-footer .send-btn svg{
      width:18px;height:18px;
    }
    #chat-footer .composer-wrap{
      flex:1;
      display:flex;
      align-items:center;
      background:#202c33;
      border-radius:24px;
      padding:0 12px;
      border:1px solid #202c33;
      height:40px;
    }
    #chat-footer .emoji-btn{
      width:32px;
      height:32px;
      border-radius:999px;
      border:0;
      background:transparent;
      color:#aebac1;
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      margin-right:6px;
      flex-shrink:0;
    }
    #chat-footer #mensagem{
      flex:1;
      background:transparent;
      border:0;
      color:#e9edef;
      font-size:14px;
      padding:0;
      height:36px;
      line-height:36px; /* centraliza o texto/placeholder */
    }
    #chat-footer #mensagem::placeholder{
      color:#8696a0;
    }

    /* ===== emoji picker ===== */
    .emoji-pop{
      position:absolute;
      bottom:64px;
      left:64px;
      background:#202c33;
      border-radius:16px;
      border:1px solid #202c33;
      box-shadow:0 12px 28px rgba(0,0,0,.35);
      padding:8px;
      z-index:60;
      display:none;
      max-width:320px;
      max-height:260px;
      overflow:auto;
    }
    .emoji-pop.show{display:block;}
    .emoji-grid{
      display:grid;
      grid-template-columns:repeat(8,1fr);
      gap:4px;
    }
    .emoji-btn-item{
      width:32px;height:32px;
      border-radius:8px;
      border:0;
      background:transparent;
      font-size:20px;
      cursor:pointer;
    }
    .emoji-btn-item:hover{
      background:rgba(255,255,255,.12);
    }
  `;
  document.head.appendChild(st);
}
function mountDialog(html) {
  ensureDialogCSS();
  const wrap = document.createElement('div');
  wrap.className = 'zcDlgBackdrop';
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  requestAnimationFrame(()=> wrap.querySelector('.zcDlg')?.classList.add('show'));
  return wrap;
}
function inputDialog({ title, rows, okText='OK', cancelText='Cancelar' }) {
  // rows: [{name,label,placeholder,value='',type='text'}]
  return new Promise(res => {
    const wrap = mountDialog(`
      <div class="zcDlg" role="dialog" aria-label="${title||'Entrada'}">
        <div class="h">${title||''}</div>
        <div class="b">
          ${rows.map(r => `
            <div class="row">
              <label>${r.label||''}</label>
              <input class="in" name="${r.name}" type="${r.type||'text'}"
                     placeholder="${r.placeholder||''}" value="${r.value||''}">
            </div>`).join('')}
        </div>
        <div class="f">
          <button class="zcBtn ghost">${cancelText}</button>
          <button class="zcBtn ok">${okText}</button>
        </div>
      </div>`);
    const [btnCancel, btnOk] = wrap.querySelectorAll('.zcBtn');
    const inputs = [...wrap.querySelectorAll('.in')];
    const close = (val) => { wrap.remove(); res(val); };
    btnCancel.onclick = () => close(null);
    btnOk.onclick = () => { const out = {}; inputs.forEach(i => out[i.name] = i.value.trim()); close(out); };
    wrap.addEventListener('click', e => { if (e.target === wrap) close(null); });
    wrap.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      if (e.key === 'Enter')  { e.preventDefault(); btnOk.click(); }
    });
    setTimeout(()=> inputs[0]?.focus(), 30);
  });
}
function confirmDialog({ title='Confirmar', msg='', okText='OK', cancelText='Cancelar', destructive=false }) {
  return new Promise(res=>{
    const wrap = mountDialog(`
      <div class="zcDlg" role="dialog" aria-label="${title}">
        <div class="h">${title}</div>
        <div class="b"><div class="zcMsg">${msg}</div></div>
        <div class="f">
          <button class="zcBtn ghost">${cancelText}</button>
          <button class="zcBtn ${destructive?'danger':'ok'}">${okText}</button>
        </div>
      </div>`);
    const [btnCancel, btnOk] = wrap.querySelectorAll('.zcBtn');
    const close = v => { wrap.remove(); res(v); };
    btnCancel.onclick = () => close(false);
    btnOk.onclick = () => close(true);
    wrap.addEventListener('click', e=>{ if(e.target===wrap) close(false); });
    wrap.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Enter')  { e.preventDefault(); btnOk.click();  }
    });
  });
}

/* ====== RESOLVE INSTÂNCIA ====== */
function getInstPayload(){
  const cli = state?.clienteSel || {};
  const idFromCliente = cli.instancia_id ?? cli.instancia ?? null;
  if (idFromCliente != null && idFromCliente !== '') {
    const n = Number(idFromCliente);
    if (Number.isFinite(n)) return { instancia_id: n };
    return { instance: String(idFromCliente) };
  }
  const act = (typeof window !== 'undefined') ? window.INSTANCIA_ATIVA : null;
  if (act != null && act !== '') {
    const n = Number(act);
    if (Number.isFinite(n)) return { instancia_id: n };
    return { instance: String(act) };
  }
  return {};
}

/* ====== Helpers mínimos (SEM OTIMISMO) ====== */
function toggleSendingUI(disabled){
  const input = document.getElementById('mensagem');
  const btn   = document.getElementById('btn-enviar');
  if (input) input.disabled = !!disabled;
  if (btn)   btn.disabled   = !!disabled;
}

/* ====== Resolve telefone a partir do cliente ======
   - tenta telefone / whatsapp / numero
   - se não tiver, e nome parecer telefone (caso do cliente vindo só com nome "+55 31 ..."),
     usa nome como fonte do número
==================================================== */
function resolveRawTel(cli){
  if (!cli) return '';
  if (cli.telefone) return cli.telefone;
  if (cli.whatsapp) return cli.whatsapp;
  if (cli.numero)   return cli.numero;

  if (typeof cli.nome === 'string') {
    const digits = cli.nome.replace(/\D/g,'');
    if (digits.length >= 10) return cli.nome;
  }
  return '';
}

// garante que existe ALGUM telefone resolvível
function ensureClienteSel(){
  const cli = state?.clienteSel || {};
  const rawTel = resolveRawTel(cli);
  if (!rawTel){
    toast('Selecione um contato.', false);
    console.warn('[send] ensureClienteSel: clienteSel sem telefone', cli);
    return false;
  }
  return true;
}

function insertAtCursor(el, text){
  if (!el) return;
  const start = el.selectionStart ?? (el.value || '').length;
  const end   = el.selectionEnd ?? (el.value || '').length;
  const v     = el.value || '';
  el.value    = v.slice(0, start) + text + v.slice(end);
  const pos   = start + text.length;
  if (typeof el.setSelectionRange === 'function') {
    el.setSelectionRange(pos, pos);
  }
  try { el.focus({ preventScroll:true }); } catch{ el.focus(); }
}

/* ===================== MAIN INIT ENVIO ===================== */
(function initEnvio(){
  const footer = document.getElementById('chat-footer') || document.body;
  const form = footer.closest('form');
  if (form) form.addEventListener('submit', e => e.preventDefault());

  ensureDialogCSS();

  const btnClip = document.getElementById('btn-clipe') || (() => {
    const b = document.createElement('button');
    b.id = 'btn-clipe'; b.className = 'clip-btn'; b.type = 'button';
    b.innerHTML = '<i class="fa-solid fa-plus"></i>';
    footer.appendChild(b); return b;
  })();

  const btnSend = document.getElementById('btn-enviar') || (() => {
    const b = document.createElement('button');
    b.id = 'btn-enviar'; b.className = 'send-btn'; b.style.display = 'none'; b.type='button';
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>';
    footer.appendChild(b); return b;
  })();

  const btnMic = document.getElementById('btn-mic') || (() => {
    const b = document.createElement('button');
    b.id = 'btn-mic'; b.className = 'mic-btn'; b.title = 'Gravar áudio'; b.type='button';
    b.innerHTML = '<i class="fa-solid fa-microphone" aria-hidden="true"></i>';
    footer.appendChild(b); return b;
  })();

  const inputMsg = document.getElementById('mensagem') || (() => {
    const i = document.createElement('input');
    i.id = 'mensagem'; i.placeholder = 'Digite sua resposta…';
    i.className = '';
    footer.insertBefore(i, btnSend);
    return i;
  })();

  // inputs ocultos
  const fileDoc   = document.getElementById('file-doc')   || (() => { const i=document.createElement('input'); i.type='file'; i.id='file-doc';   i.style.display='none'; i.accept='.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,application/*'; footer.appendChild(i); return i; })();
  const fileMedia = document.getElementById('file-media') || (() => { const i=document.createElement('input'); i.type='file'; i.id='file-media'; i.style.display='none'; i.accept='image/*,video/*'; footer.appendChild(i); return i; })();
  const fileAudio = document.getElementById('file-audio') || (() => { const i=document.createElement('input'); i.type='file'; i.id='file-audio'; i.style.display='none'; i.accept='audio/*'; footer.appendChild(i); return i; })();

  // === layout tipo WPP: composer-wrap com emoji + input ===
  let composerWrap = document.getElementById('composer-wrap');
  if (!composerWrap){
    composerWrap = document.createElement('div');
    composerWrap.id = 'composer-wrap';
    composerWrap.className = 'composer-wrap';
    footer.insertBefore(composerWrap, btnMic);
  }
  composerWrap.appendChild(inputMsg);
  footer.appendChild(btnSend);
  footer.appendChild(btnMic);

  const btnEmoji = document.getElementById('btn-emoji') || (() => {
    const b = document.createElement('button');
    b.id = 'btn-emoji';
    b.className = 'emoji-btn';
    b.type = 'button';
    b.innerHTML = '<i class="fa-regular fa-face-smile"></i>';
    composerWrap.insertBefore(b, inputMsg);
    return b;
  })();

  function toggleSendMic(){
    const hasText = (inputMsg.value || '').trim().length > 0;
    btnSend.style.display = hasText ? 'inline-flex' : 'none';
    btnMic.style.display  = hasText ? 'none'       : 'inline-flex';
  }
  inputMsg.addEventListener('input', toggleSendMic);
  toggleSendMic();

  function toDataUrl(fileOrBlob){
    return new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(fileOrBlob); });
  }
  function cleanDataUrl(s){ if (!s) return ''; const i = s.indexOf(','); return i >= 0 ? s.slice(i+1).trim() : s.trim(); }
  function guessMediaType(mime){
    if (!mime) return 'document';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'document';
  }
  function guessMimeFromExt(name){
    const ext = (name||'').split('.').pop()?.toLowerCase() || '';
    switch(ext){
      case 'pdf':  return 'application/pdf';
      case 'doc':  return 'application/msword';
      case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'xls':  return 'application/vnd.ms-excel';
      case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      case 'ppt':  return 'application/vnd.ms-powerpoint';
      case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      case 'png':  return 'image/png';
      case 'jpg':  return 'image/jpeg';
      case 'jpeg': return 'image/jpeg';
      case 'webp': return 'image/webp';
      case 'mp4':  return 'video/mp4';
      case 'mp3':  return 'audio/mpeg';
      case 'ogg':  return 'audio/ogg';
      case 'wav':  return 'audio/wav';
      default:     return 'application/octet-stream';
    }
  }
  function stripUndefined(o){ Object.keys(o).forEach(k=> o[k]===undefined && delete o[k]); return o; }

  const humanFileSize = (bytes) => {
    if (bytes == null) return '';
    const units = ['B','KB','MB','GB'];
    let u = 0, v = bytes;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    const fixed = v >= 10 || u === 0 ? v.toFixed(0) : v.toFixed(1);
    return `${fixed} ${units[u]}`;
  };

  function openFilePreview(fileList, explicitType = null) {
    const files = Array.from(fileList || []).filter(f => f && f.size >= 0);
    if (!files.length) return;

    const wrap = mountDialog(`
      <div class="zcDlg zcDlg-filePreview" role="dialog" aria-label="Enviar arquivo">
        <div class="h">Enviar ${files.length > 1 ? 'arquivos' : 'arquivo'}</div>
        <div class="b">
          <div class="zpPrev">
            <div class="zpPrev-main">
              <div class="zpPrev-thumb"></div>
              <div class="zpPrev-meta">
                <div class="zpPrev-name"></div>
                <div class="zpPrev-info"></div>
              </div>
            </div>
            <div class="zpPrev-caption-row">
              <textarea class="zpPrev-caption" placeholder="Digite uma legenda (opcional)…"></textarea>
            </div>
            ${files.length > 1 ? `
            <div class="zpPrev-list">
              <div>${files.length} arquivos selecionados:</div>
              <ul class="zpPrev-ul"></ul>
            </div>` : ''}
          </div>
        </div>
        <div class="f">
          <button class="zcBtn ghost zpPrev-cancel">Cancelar</button>
          <button class="zcBtn ok zpPrev-send">Enviar</button>
        </div>
      </div>
    `);

    const thumb   = wrap.querySelector('.zpPrev-thumb');
    const nameEl  = wrap.querySelector('.zpPrev-name');
    const infoEl  = wrap.querySelector('.zpPrev-info');
    const capEl   = wrap.querySelector('.zpPrev-caption');
    const listUl  = wrap.querySelector('.zpPrev-ul');
    const btnCanc = wrap.querySelector('.zpPrev-cancel');
    const btnSendPrev = wrap.querySelector('.zpPrev-send');

    const first = files[0];
    const mime  = first.type || guessMimeFromExt(first.name);
    const typeLabel = mime || 'arquivo';

    nameEl.textContent = first.name || 'Arquivo';
    infoEl.textContent = [humanFileSize(first.size), typeLabel].filter(Boolean).join(' • ');

    thumb.innerHTML = '';
    if (mime && mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.alt = first.name || 'imagem';
      const fr = new FileReader();
      fr.onload = () => { img.src = fr.result; };
      fr.readAsDataURL(first);
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '<i class="fa-regular fa-file-lines"></i>';
      thumb.style.fontSize = '28px';
    }

    if (listUl) {
      files.forEach(f => {
        const li = document.createElement('li');
        li.textContent = `${f.name || 'Arquivo'} (${humanFileSize(f.size)})`;
        listUl.appendChild(li);
      });
    }

    const close = () => wrap.remove();

    btnCanc.addEventListener('click', () => close());
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close();
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    btnSendPrev.addEventListener('click', async () => {
      const caption = capEl.value.trim() || undefined;
      btnSendPrev.disabled = true;
      btnSendPrev.textContent = 'Enviando…';
      try {
        for (const f of files) {
          await enviarMediaArquivo(f, explicitType, caption);
        }
        close();
      } finally {
        btnSendPrev.disabled = false;
      }
    });

    setTimeout(() => capEl?.focus(), 30);
  }

  // usa resolveRawTel + numeroE164
  const numberForApi = () => {
    const cli = state?.clienteSel || {};
    const raw = resolveRawTel(cli);
    return numeroE164(raw || '');
  };

  /* ===================== ENVIO TEXTO (SEM OTIMISMO) ===================== */
  async function enviarTexto(){
    const text = (inputMsg.value||'').trim();
    if (!text) return;

    const cli = state?.clienteSel || {};
    const rawTel = resolveRawTel(cli);
    if (!rawTel){
      toast('Contato sem telefone válido. Recarregue a tela ou edite o cadastro.', false);
      console.warn('[send/text] clienteSel sem telefone', cli);
      return;
    }

    const numE164 = numeroE164(rawTel);
    if (!numE164){
      toast('Telefone do contato inválido. Verifique o cadastro.', false);
      console.warn('[send/text] numeroE164 retornou vazio', { rawTel, cli });
      return;
    }

    toggleSendingUI(true);

    try{
      const payload = {
        empresa_id: EMPRESA_ID || undefined,
        number: numE164,
        text,
        ...getInstPayload(),
      };

      // ajuda pra debugar se der pau
      window.__debugLastSendPayload = payload;

      const r = await fetch('/api/atendimento/send/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      const respText = await r.text().catch(() => '');
      let respJson = null;
      try { respJson = respText ? JSON.parse(respText) : null; } catch {}

      if (!r.ok) {
        console.error('[send/text] HTTP', r.status, respText || respJson);
        const msg =
          (respJson && (respJson.detail || respJson.message || respJson.error)) ||
          (r.status === 400 ? 'Dados inválidos (número ou instância).' : 'Falha ao enviar.');
        toast(msg, false);
        return;
      }

      const resp = respJson;

      const instName = resp?.instance_name ?? resp?.db?.instance_name ?? null;
      const instId   = resp?.db?.instancia_id ?? resp?.instancia_id ?? null;
      if (instName || instId){
        if (!window.INSTANCIA_ATIVA){ window.INSTANCIA_ATIVA = instId ?? instName; }
        try { window.setInstanceChip?.(instName ?? String(instId ?? '')); } catch {}
      }

      inputMsg.value = '';
      toggleSendMic();
    }catch(e){
      console.error('[send/text] erro inesperado', e);
      toast('Falha ao enviar.', false);
    }finally{
      toggleSendingUI(false);
    }
  }

  btnSend.addEventListener('click', enviarTexto);
  inputMsg.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); enviarTexto(); } });

  /* ===================== MENU DE ANEXOS (estilo WPP) ===================== */
  (function ensureAttachCss(){
    if (document.getElementById('attach-css')) return;
    const s = document.createElement('style');
    s.id = 'attach-css';
    s.textContent = `
      .attach-pop{position:absolute;bottom:64px;min-width:240px;max-width:260px;
        background:#111b21;border:1px solid #2a3942;border-radius:12px;
        padding:6px;box-shadow:0 12px 28px rgba(0,0,0,.35);z-index:50;
        opacity:0; transform: translateY(6px); transition: opacity .15s, transform .15s}
      .attach-pop.show{opacity:1; transform:none}
      .attach-pop.hidden{display:none}
      .attach-item{display:flex;align-items:center;gap:10px;width:100%;
        padding:10px 12px;border:0;border-radius:10px;background:transparent;
        color:#e9edef;cursor:pointer;user-select:none}
      .attach-item:hover{background:rgba(255,255,255,.06)}
      .attach-ico{width:28px;height:28px;border-radius:9999px;display:grid;place-items:center;color:#fff}
      .attach-lab{font-size:14px}
      .attach-item[data-act="doc"]        .attach-ico{background:#7b83eb}
      .attach-item[data-act="media"]      .attach-ico{background:#00a884}
      .attach-item[data-act="camera"]     .attach-ico{background:#ea4c89}
      .attach-item[data-act="audio-file"] .attach-ico{background:#53bdeb}
      .attach-item[data-act="audio-record"] .attach-ico{background:#25d366}
      .attach-item[data-act="contact"]    .attach-ico{background:#ffbe0b}
      .attach-item[data-act="sticker"]    .attach-ico{background:#7f66ff}
      .attach-sep{height:1px;margin:6px 4px;background:#2a3942;border-radius:1px}
    `;
    document.head.appendChild(s);
  })();

  let attachMenu = document.getElementById('attach-menu');
  if (!attachMenu){
    attachMenu = document.createElement('div');
    attachMenu.id = 'attach-menu';
    attachMenu.className = 'attach-pop hidden';
    attachMenu.innerHTML = `
      <div class="attach-item" data-act="doc">
        <span class="attach-ico"><i class="fa-regular fa-file-lines"></i></span>
        <span class="attach-lab">Documento</span>
      </div>
      <div class="attach-item" data-act="media">
        <span class="attach-ico"><i class="fa-regular fa-image"></i></span>
        <span class="attach-lab">Fotos e vídeos</span>
      </div>
      <div class="attach-item" data-act="camera">
        <span class="attach-ico"><i class="fa-solid fa-camera"></i></span>
        <span class="attach-lab">Câmera</span>
      </div>
      <div class="attach-sep"></div>
      <div class="attach-item" data-act="audio-file">
        <span class="attach-ico"><i class="fa-solid fa-file-audio"></i></span>
        <span class="attach-lab">Áudio (arquivo)</span>
      </div>
      <div class="attach-item" data-act="audio-record">
        <span class="attach-ico"><i class="fa-solid fa-microphone"></i></span>
        <span class="attach-lab">Gravar áudio</span>
      </div>
      <div class="attach-sep"></div>
      <div class="attach-item" data-act="contact">
        <span class="attach-ico"><i class="fa-regular fa-address-card"></i></span>
        <span class="attach-lab">Contato</span>
      </div>
      <div class="attach-item" data-act="sticker">
        <span class="attach-ico"><i class="fa-regular fa-face-laugh"></i></span>
        <span class="attach-lab">Sticker</span>
      </div>
    `;
    (footer.parentElement||footer).appendChild(attachMenu);
  }

  // ===== Emoji picker =====
  let emojiPop = document.getElementById('emoji-pop');
  if (!emojiPop){
    emojiPop = document.createElement('div');
    emojiPop.id = 'emoji-pop';
    emojiPop.className = 'emoji-pop';
    emojiPop.innerHTML = '<div class="emoji-grid"></div>';
    (footer.parentElement || footer).appendChild(emojiPop);

    const grid = emojiPop.querySelector('.emoji-grid');
    const EMOJIS = '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 🤡 👋 🤚 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏';
    EMOJIS.split(/\s+/).forEach(ch => {
      if (!ch) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emoji-btn-item';
      b.textContent = ch;
      b.addEventListener('click', () => {
        insertAtCursor(inputMsg, ch);
        inputMsg.dispatchEvent(new Event('input', { bubbles:true }));
      });
      grid.appendChild(b);
    });
  }

  // abre/fecha menus e ancora perto do clipe / emoji
  btnClip?.addEventListener('click', (ev)=>{
    ev.stopPropagation();
    attachMenu.classList.toggle('hidden');
    if (!attachMenu.classList.contains('hidden')) {
      const b = btnClip.getBoundingClientRect();
      const p = (attachMenu.parentElement||document.body).getBoundingClientRect();
      attachMenu.style.left = Math.max(12, Math.min(p.width-260, b.left - p.left - 8)) + 'px';
      attachMenu.classList.add('show');
      requestAnimationFrame(()=>attachMenu.classList.add('show'));
    } else {
      attachMenu.classList.remove('show');
    }
  });

  btnEmoji.addEventListener('click', (ev)=>{
    ev.stopPropagation();
    emojiPop.classList.toggle('show');
    if (emojiPop.classList.contains('show')) {
      const b = btnEmoji.getBoundingClientRect();
      const p = (emojiPop.parentElement || document.body).getBoundingClientRect();
      emojiPop.style.left = Math.max(8, b.left - p.left) + 'px';
    }
  });

  document.addEventListener('click', (ev)=>{
    if (!attachMenu.contains(ev.target) && ev.target!==btnClip){
      attachMenu.classList.add('hidden');
      attachMenu.classList.remove('show');
    }
    if (emojiPop && !emojiPop.contains(ev.target) && ev.target !== btnEmoji){
      emojiPop.classList.remove('show');
    }
  });

  /* ===================== ENVIO DE ARQUIVOS / MÍDIA ===================== */
  async function enviarMediaArquivo(file, explicitType = null, captionOverride = null){
    if (!ensureClienteSel() || !file) return;
    const caption = captionOverride != null
      ? captionOverride
      : (inputMsg.value||'').trim() || undefined;
    const number    = numberForApi();
    const mime      = file.type || guessMimeFromExt(file.name);
    const mediaType = explicitType || guessMediaType(mime);
    const dataUrl   = await toDataUrl(file);
    const base64    = cleanDataUrl(dataUrl);

    try{
      if (mediaType === 'audio') {
        const r = await fetch('/api/atendimento/send/audio', {
          method:'POST', headers:{'Content-Type':'application/json'},
          credentials: 'include',
          body: JSON.stringify(stripUndefined({ empresa_id: EMPRESA_ID, number, audio: base64, ...getInstPayload() }))
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } else {
        const body = stripUndefined({
          empresa_id: EMPRESA_ID, number, media: base64,
          mediatype: mediaType, mimetype: mime, fileName: file.name || undefined, caption,
          ...getInstPayload()
        });
        const r = await fetch('/api/atendimento/send/media', {
          method:'POST', headers:{'Content-Type':'application/json'}, credentials: 'include', body: JSON.stringify(body)
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (caption && captionOverride != null) { // legenda veio do preview
          inputMsg.value='';
          toggleSendMic();
        }
      }
      toast('Arquivo enviado!', true);
    }catch(e){
      console.error('[send/media|audio]', e);
      toast('Falha ao enviar arquivo.', false);
    }
  }

  fileDoc.addEventListener('change', (e)=>{
    const files = e.target.files;
    if (files && files.length) openFilePreview(files, 'document');
    e.target.value = '';
  });
  fileMedia.addEventListener('change', (e)=>{
    const files = e.target.files;
    if (files && files.length) openFilePreview(files, null);
    e.target.value = '';
  });
  fileAudio.addEventListener('change', (e)=>{
    const files = e.target.files;
    if (files && files.length) openFilePreview(files, 'audio');
    e.target.value = '';
  });

  /* ====== Modais slim para Contato e Sticker ====== */
  async function openContactPrompt(){
    if (!ensureClienteSel()) return;
    const data = await inputDialog({
      title: 'Enviar contato',
      rows: [
        { name:'fullName',  label:'Nome',       placeholder:'Ex.: Maria Silva' },
        { name:'phone',     label:'Telefone',   placeholder:'DDI+DDD+Número (só dígitos)' }
      ],
      okText:'Enviar'
    });
    if (!data) return;
    const contact  = [{
      fullName: data.fullName || undefined,
      phoneNumber: (data.phone||'').replace(/\D/g,'') || undefined
    }];
    try{
      const r = await fetch('/api/atendimento/send/contact', {
        method:'POST', headers:{'Content-Type':'application/json'}, credentials: 'include',
        body: JSON.stringify({ empresa_id: EMPRESA_ID, number: numberForApi(), contact, ...getInstPayload() })
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast('Contato enviado!', true);
    }catch(e){ console.error(e); toast('Falha ao enviar contato.', false); }
  }

  async function openStickerPrompt(){
    if (!ensureClienteSel()) return;
    const data = await inputDialog({
      title: 'Enviar figurinha',
      rows: [{ name:'st', label:'URL / BASE64', placeholder:'Cole a URL ou data:...' }],
      okText:'Enviar'
    });
    if (!data || !data.st) return;
    const s = String(data.st);
    const sticker = s.startsWith('data:') ? cleanDataUrl(s) : s.trim();
    try{
      const r = await fetch('/api/atendimento/send/sticker', {
        method:'POST', headers:{'Content-Type':'application/json'}, credentials: 'include',
        body: JSON.stringify({ empresa_id: EMPRESA_ID, number: numberForApi(), sticker, ...getInstPayload() })
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast('Sticker enviado!', true);
    }catch(e){ console.error(e); toast('Falha ao enviar figurinha.', false); }
  }

  attachMenu.addEventListener('click', (ev)=>{
    const item = ev.target.closest('.attach-item'); if(!item) return;
    const act = item.getAttribute('data-act');
    attachMenu.classList.add('hidden');
    attachMenu.classList.remove('show');
    switch(act){
      case 'doc':         fileDoc.click(); break;
      case 'media':       fileMedia.click(); break;

      case 'camera': {
        const prevAccept = fileMedia.accept;
        const hadCapture = fileMedia.hasAttribute('capture');
        try {
          fileMedia.accept = 'image/*';
          fileMedia.setAttribute('capture', 'environment');
          fileMedia.click();
        } finally {
          setTimeout(()=>{
            fileMedia.accept = prevAccept;
            if (!hadCapture) fileMedia.removeAttribute('capture');
          }, 0);
        }
        break;
      }

      case 'audio-file':  fileAudio.click(); break;
      case 'audio-record':startStopRecording(); break;
      case 'contact':     openContactPrompt(); break;
      case 'sticker':     openStickerPrompt(); break;
    }
  });

  // gravação de áudio (sem otimista)
  let rec = null, recStream = null, recChunks = [], recEl = null, recTimer=null, recStartTs=0;
  function renderRecBubble(state='idle', elapsed='00:00'){
    if (!recEl){
      recEl=document.createElement('div');
      Object.assign(recEl.style,{position:'absolute',right:'14px',bottom:'58px',background:'#0f1a1f',color:'#e9edef',
        border:'1px solid #2a3942',borderRadius:'10px',padding:'8px 10px',display:'flex',gap:'8px',alignItems:'center',zIndex:70,fontSize:'13px'});
      recEl.innerHTML=`<span class="dot" style="width:8px;height:8px;border-radius:9999px;background:#ef4444"></span>
                       <span class="t">gravando… 00:00</span>
                       <button class="stop" style="background:#ef4444;border:0;color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:12.5px">Parar</button>`;
      (footer.parentElement||footer).appendChild(recEl);
      recEl.querySelector('.stop').addEventListener('click', startStopRecording);
    }
    recEl.querySelector('.t').textContent = `${state==='rec'?'gravando…':'processando…'} ${elapsed}`;
    recEl.style.display='flex';
  }
  function hideRecBubble(){ if(recEl) recEl.style.display='none'; }
  function fmtElapsed(ms){ const s=Math.floor(ms/1000), m=String(Math.floor(s/60)).padStart(2,'0'), ss=String(s%60).padStart(2,'0'); return `${m}:${ss}`; }

  async function startStopRecording(){
    if (!rec){ // START
      if (!ensureClienteSel()) return;
      try{
        recStream = await navigator.mediaDevices.getUserMedia({audio:true});
        rec = new MediaRecorder(recStream);
        recChunks = [];
        rec.ondataavailable = e => { if (e.data?.size) recChunks.push(e.data); };
        rec.onstop = async () => {
          clearInterval(recTimer);
          renderRecBubble('proc', fmtElapsed(Date.now()-recStartTs));
          try{
            const blob = new Blob(recChunks, { type: rec.mimeType || 'audio/webm' });
            const dataUrl = await toDataUrl(blob);
            const base64  = cleanDataUrl(dataUrl);
            const r = await fetch('/api/atendimento/send/audio', {
              method:'POST', headers:{'Content-Type':'application/json'}, credentials: 'include',
              body: JSON.stringify({ empresa_id: EMPRESA_ID, number: numberForApi(), audio: base64, ...getInstPayload() })
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
          }catch(e){ console.error(e); toast('Falha ao enviar áudio.', false); }
          finally{
            hideRecBubble();
            recStream?.getTracks()?.forEach(t=>t.stop());
            recStream=null; rec=null; recChunks=[];
          }
        };
        rec.start();
        recStartTs = Date.now();
        recTimer=setInterval(()=> renderRecBubble('rec', fmtElapsed(Date.now()-recStartTs)), 250);
        renderRecBubble('rec','00:00');
      }catch(e){ console.error(e); toast('Permissão de microfone negada.', false); }
    }else{ // STOP
      try{ rec.stop(); }catch{}
    }
  }
  btnMic.addEventListener('click', startStopRecording);

  /* ===================== DRAG & DROP (arquivos / imagens) ===================== */
  function ensureDropOverlay() {
    let ov = document.getElementById('zc-drop-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'zc-drop-overlay';
      Object.assign(ov.style, {
        position: 'fixed',
        inset: '0',
        background: 'rgba(15,23,42,.80)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9998,
        opacity: '0',
        pointerEvents: 'none',
        transition: 'opacity .15s ease',
      });
      ov.innerHTML = `
        <div style="
          border:1px dashed #38bdf8;
          border-radius:16px;
          padding:16px 24px;
          background:rgba(15,23,42,.95);
          color:#e5e7eb;
          font-size:14px;
        ">
          Solte o arquivo aqui para enviar ao cliente
        </div>
      `;
      document.body.appendChild(ov);
    }
    return ov;
  }

  function setupDragAndDrop() {
    const hist = document.getElementById('historico');
    if (!hist) return;

    let dragging = 0;
    let overlay = null;

    const hasFiles = (ev) => {
      try {
        const dt = ev.dataTransfer;
        if (!dt || !dt.types) return false;
        return Array.from(dt.types).includes('Files');
      } catch {
        return false;
      }
    };

    const showOverlay = () => {
      if (!overlay) overlay = ensureDropOverlay();
      overlay.style.opacity = '1';
      overlay.style.pointerEvents = 'auto';
    };

    const hideOverlay = () => {
      if (!overlay) return;
      overlay.style.opacity = '0';
      overlay.style.pointerEvents = 'none';
    };

    window.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return;
      dragging++;
      showOverlay();
      ev.preventDefault();
    });

    window.addEventListener('dragover', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
    });

    window.addEventListener('dragleave', (ev) => {
      if (!hasFiles(ev)) return;
      dragging = Math.max(0, dragging - 1);
      if (!dragging) hideOverlay();
    });

    window.addEventListener('drop', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      dragging = 0;
      hideOverlay();

      const files = Array.from(ev.dataTransfer.files || []);
      if (!files.length) return;

      openFilePreview(files, null);
    });
  }

  setupDragAndDrop();
})();

/* ====== FOCUS MANAGER (foco automático em TODAS as conversas) ====== */
(function(){
  function findComposer(){
    return document.querySelector('[data-chat-input]') ||
           document.querySelector('#mensagem') ||
           document.querySelector('#chat-input') ||
           document.querySelector('#composer') ||
           document.querySelector('.chat-composer textarea, .chat-composer input[type="text"]') ||
           document.querySelector('textarea[name="mensagem"], input[name="mensagem"]');
  }

  function reallyFocus(el){
    if (!el) return;
    try {
      el.removeAttribute('disabled');
      el.focus({ preventScroll: true });
      if (typeof el.setSelectionRange === 'function') {
        const v = el.value || '';
        el.setSelectionRange(v.length, v.length);
      }
    } catch {}
  }

  function scheduleFocus() {
    const tries = [0, 60, 180, 400];
    tries.forEach(ms => {
      const fn = () => {
        const el = findComposer();
        if (el) reallyFocus(el);
      };
      if (ms === 0) requestAnimationFrame(fn);
      else setTimeout(fn, ms);
    });
  }

  window.focusComposer = scheduleFocus;

  document.addEventListener('click', (e) => {
    const li = e.target.closest?.('#lista-clientes .cliente-item, .cliente-item');
    if (li) scheduleFocus();
  }, true);

  document.addEventListener('historico:ready', scheduleFocus);
  document.addEventListener('cliente:selecionado', scheduleFocus);
  document.addEventListener('zc:cliente_sel', scheduleFocus);

  window.addEventListener('hashchange', scheduleFocus);
  window.addEventListener('popstate', scheduleFocus);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleFocus();
  });

  const obs = new MutationObserver(() => scheduleFocus());
  const mount = () => {
    const root = document.getElementById('chat-footer') || document.body;
    if (root) obs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
