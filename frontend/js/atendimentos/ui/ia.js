/* ====================================================================
 * ZapChats – Atendimento: IA (JS-only) — logos 24px + responsivo
 * - Botão #btn-ia no header (sempre 24×24)
 * - Modal montado via JS (sem HTML extra)
 * - Logos por tema:
 *    dark  -> /frontend/img/open-ai-logo-white.svg
 *    light -> /frontend/img/open-ai-logo-back.svg
 * - Endpoints:
 *    POST /api/atendimento/ia/resumo
 *    POST /api/atendimento/ia/melhorar
 * - Depende do DOM:
 *    #historico[data-cliente-id], #mensagem, #chat-header
 * - Fonte do diálogo: **sempre BD** (janela_dias=3). Não envia dialogo_override.
 * ==================================================================== */

(function () {
  'use strict';

  const $  = (s, r=document)=> r.querySelector(s);
  const on = (el, ev, fn)=> el && el.addEventListener(ev, fn);

  // ---------- Tema / Logos ----------
  function getTheme() {
    try {
      const t = document.documentElement.getAttribute('data-theme');
      if (t === 'dark' || t === 'light') return t;
    } catch {}
    try {
      return (matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    } catch {}
    return 'dark';
  }
  function getLogoSrc() {
    return getTheme() === 'dark'
      ? '/frontend/img/open-ai-logo-white.svg'
      : '/frontend/img/open-ai-logo-back.svg';
  }
  function updateAllLogos() {
    const src = getLogoSrc();
    $('#btn-ia .ia-logo')?.setAttribute('src', src);
    document.querySelectorAll('.ia-badge').forEach(img => img.setAttribute('src', src));
  }
  new MutationObserver(updateAllLogos).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
  try {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    (mq.addEventListener ? mq.addEventListener('change', updateAllLogos) : mq.addListener(updateAllLogos));
  } catch {}

  // ---------- Helpers ----------
  function getEmpresaId(){ return Number(localStorage.getItem('empresa_id') || 0); }
  function getClienteId(){ return Number($('#historico')?.dataset?.clienteId || 0); }

  async function asJsonOrText(res) {
    const txt = await res.text();
    try { return JSON.parse(txt); } catch { return txt; }
  }

  // ---------- Montagem do modal (uma única vez) ----------
  let mounted = false;
  let refs = {};
  function mountOnce(){
    if (mounted) return;
    mounted = true;

    if (!document.getElementById('ia-modal-css')) {
      const style = document.createElement('style');
      style.id = 'ia-modal-css';
      style.textContent = `
        /* Botão 24×24 fixo + glow roxo suave */
        #btn-ia{
          display:inline-grid;place-items:center;
          width:24px;height:24px;margin-left:6px;
          background:transparent;border:0;line-height:0;cursor:pointer
        }
        #btn-ia .ia-logo{
          width:24px;height:24px; /* fixa 24×24 */
          object-fit:contain;object-position:center;
          filter: drop-shadow(0 0 5px rgba(168,85,247,.50));
        }

        /* Modal */
        #ia-modal-backdrop.hidden, #ia-modal.hidden { display:none; }
        #ia-modal{
          border-radius:12px; border:1px solid #26343a;
          background:#1f2c33; color:#e9edef;
          max-width:780px; width:94vw;
        }
        #ia-modal-body{ max-height:70vh; overflow:auto; }
        .ia-section-title{ display:flex; align-items:center; gap:8px; font-weight:600; }
        .ia-chip{
          font-size:11px; padding:2px 8px; border-radius:9999px;
          background:#233238; border:1px solid #2b424a; color:#aebac1;
        }
        .ia-sec-actions{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }

        .btn-soft{
          display:inline-flex; align-items:center; gap:8px; padding:8px 10px;
          border-radius:8px; border:1px solid #2a3942; background:#0b141a; color:#e9edef;
        }
        .btn-soft:hover{ background:#0f171c; border-color:#6b21a8; }

        .ia-spinner{
          width:16px; height:16px; border:2px solid #9fb2bb66;
          border-top-color:#a855f7; border-radius:9999px; animation:ia-spin .9s linear infinite;
        }
        @keyframes ia-spin{ to{ transform:rotate(360deg) } }

        /* Badges 24×24 */
        .ia-badge{
          width:24px;height:24px;display:block;object-fit:contain;
          filter: drop-shadow(0 0 5px rgba(168,85,247,.50));
        }

        /* ---------- Mobile tweaks ---------- */
        @media (max-width: 640px){
          #ia-modal{ width:100vw; max-width:100vw; left:50%; transform:translateX(-50%) translateY(-50%); }
          #ia-modal-body{ max-height:65vh; padding-left:12px; padding-right:12px; }
          .btn-soft{ padding:8px 10px; }
          #ia-draft{ min-height:112px; }
        }
      `;
      document.head.appendChild(style);
    }

    const wrap = document.createElement('div');
    wrap.id = 'ia-modal-mount';
    wrap.innerHTML = `
      <div id="ia-modal-backdrop" class="fixed inset-0 bg-black/50 z-[9998] hidden"></div>
      <div id="ia-modal" class="fixed z-[9999] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#1f2c33] text-[#e9edef] border border-[#26343a] rounded-xl shadow-xl hidden" role="dialog" aria-modal="true" aria-label="Ferramentas de IA">
        <div class="flex items-center justify-between px-4 py-3 border-b border-[#26343a]">
          <div class="flex items-center gap-2">
            <img src="" class="ia-badge" alt="IA">
            <h3 class="font-semibold">Ferramentas de IA</h3>
            <span class="ia-chip">Beta</span>
          </div>
          <button id="ia-fechar" class="text-gray-400 hover:text-white" aria-label="Fechar"><i class="fa-solid fa-xmark"></i></button>
        </div>

        <div id="ia-modal-body" class="px-5 py-4 text-sm leading-6 space-y-6">
          <!-- Resumo -->
          <section>
            <div class="flex items-center justify-between mb-2">
              <div class="ia-section-title">
                <img src="" class="ia-badge" alt="IA">
                <span>Resumo IA</span>
              </div>
              <div class="ia-sec-actions">
                <button id="ia-resumo-gerar" class="btn-soft"><i class="fa-solid fa-wand-magic-sparkles"></i> Gerar resumo</button>
                <button id="ia-resumo-copiar" class="btn-soft hidden"><i class="fa-regular fa-copy"></i> Copiar</button>
                <span id="ia-resumo-loading" class="hidden ia-spinner"></span>
              </div>
            </div>
            <div id="ia-resumo-content" class="hidden">
              <p id="ia-resumo-texto" class="mb-3"></p>
              <ul id="ia-resumo-bullets" class="list-disc pl-5 space-y-1"></ul>
              <div class="mt-3 text-xs text-[#aebac1]" id="ia-resumo-meta"></div>
            </div>
          </section>

          <hr class="border-[#26343a]">

          <!-- Resposta melhorada -->
          <section>
            <div class="flex items-center justify-between mb-2">
              <div class="ia-section-title">
                <img src="" class="ia-badge" alt="IA">
                <span>Resposta melhorada com IA</span>
              </div>
              <div class="ia-sec-actions">
                <button id="ia-gerar-resposta" class="btn-soft"><i class="fa-solid fa-wand-magic-sparkles"></i> Gerar resposta</button>
                <button id="ia-copiar-resposta" class="btn-soft hidden"><i class="fa-regular fa-copy"></i> Copiar</button>
                <button id="ia-colar-no-chat" class="btn-soft hidden"><i class="fa-regular fa-paper-plane"></i> Colar no chat</button>
                <span id="ia-resposta-loading" class="hidden ia-spinner"></span>
              </div>
            </div>

            <div class="grid gap-2">
              <textarea id="ia-draft" rows="4" class="w-full p-3 rounded bg-[#0b141a] text-[#e9edef] border border-[#2a3942] outline-none" placeholder="Escreva sua resposta ou deixe em branco para a IA sugerir com base no diálogo recente…"></textarea>

              <div id="ia-resposta-box" class="hidden">
                <div class="text-xs text-[#aebac1] mb-1">Sugestão da IA</div>
                <div id="ia-resposta-texto" class="p-3 rounded bg-[#0b141a] border border-[#2a3942] whitespace-pre-wrap"></div>
              </div>
            </div>
          </section>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    refs = {
      backdrop:  $('#ia-modal-backdrop'),
      modal:     $('#ia-modal'),
      close:     $('#ia-fechar'),
      resumoGerar:   $('#ia-resumo-gerar'),
      resumoCopiar:  $('#ia-resumo-copiar'),
      resumoLoad:    $('#ia-resumo-loading'),
      resumoBox:     $('#ia-resumo-content'),
      resumoTxt:     $('#ia-resumo-texto'),
      resumoBullets: $('#ia-resumo-bullets'),
      resumoMeta:    $('#ia-resumo-meta'),
      gerarResp:     $('#ia-gerar-resposta'),
      respLoad:      $('#ia-resposta-loading'),
      respBox:       $('#ia-resposta-box'),
      respTxt:       $('#ia-resposta-texto'),
      colar:         $('#ia-colar-no-chat'),
      copiar:        $('#ia-copiar-resposta'),
      draft:         $('#ia-draft'),
    };

    updateAllLogos();

    on(refs.close,   'click', closeIA);
    on(refs.backdrop,'click', closeIA);
    on(document, 'keydown', e=>{ if (e.key==='Escape') closeIA(); });

    on(refs.resumoGerar, 'click', gerarResumo);
    on(refs.resumoCopiar,'click', copiarResumo);
    on(refs.gerarResp,   'click', gerarResposta);
    on(refs.colar,       'click', colarNoChat);
    on(refs.copiar,      'click', copiarResposta);
  }

  // ---------- Botão no header ----------
  function ensureHeaderButton(){
    // tenta achar o container do header
    const hdr = $('#chat-header .flex.items-center.gap-2.relative')
            || $('#chat-header .flex.items-center.gap-2')
            || $('#chat-header');
    if (!hdr) return;

    // pode já existir #btn-ia no HTML
    let btn = document.getElementById('btn-ia');

    // se não existir, cria
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btn-ia';
      btn.className = 'hdr-icon-btn';
      btn.title = 'Ferramentas de IA';
      btn.setAttribute('aria-label', 'Ferramentas de IA');
      btn.innerHTML = `<img class="ia-logo" alt="IA">`; // src setado por updateAllLogos()
      hdr.appendChild(btn);
    }

    updateAllLogos();
  }

  const hdrEl = document.getElementById('chat-header');
  if (hdrEl) {
    const mo = new MutationObserver(()=> ensureHeaderButton());
    mo.observe(hdrEl, { attributes:true, attributeFilter:['style','class'] });
  }
  ensureHeaderButton();

  // ---------- Open/Close ----------
  function openIA(){
    mountOnce();
    refs.draft.value = $('#mensagem')?.value || '';
    refs.resumoTxt.textContent = '';
    refs.resumoBullets.innerHTML = '';
    refs.resumoMeta.textContent = '';
    refs.resumoBox.classList.add('hidden');
    refs.resumoCopiar.classList.add('hidden');
    refs.resumoLoad.classList.add('hidden');

    refs.respTxt.textContent = '';
    refs.respBox.classList.add('hidden');
    refs.copiar.classList.add('hidden');
    refs.colar.classList.add('hidden');
    refs.respLoad.classList.add('hidden');

    refs.backdrop.classList.remove('hidden');
    refs.modal.classList.remove('hidden');
  }
  function closeIA(){
    if (!mounted) return;
    refs.backdrop.classList.add('hidden');
    refs.modal.classList.add('hidden');
  }

  // ---------- Normalizadores ----------
  function normalizeResumoResponse(j){
    function fromText(t){
      return {
        resumo_curto: String(t || 'Sem conteúdo.'),
        pontos_chave: [],
        topico: null,
        urgencia: 'baixa',
        confianca: 0,
        amostra: null
      };
    }

    try{
      if (Array.isArray(j)) {
        const first = j[0]?.json ?? j[0] ?? null;
        return normalizeResumoResponse(first);
      }

      if (typeof j === 'string') {
        try { return normalizeResumoResponse(JSON.parse(j)); }
        catch { return fromText(j); }
      }

      if (j && typeof j === 'object') {
        if (j.resumo && typeof j.resumo === 'object') return j.resumo;
        if ('resumo_curto' in j || 'pontos_chave' in j) return j;

        if (j.json && typeof j.json === 'object') {
          return normalizeResumoResponse(j.json);
        }
        if (typeof j.text === 'string') {
          try { return normalizeResumoResponse(JSON.parse(j.text)); }
          catch { return fromText(j.text); }
        }

        if (typeof j.body === 'string') {
          try { return normalizeResumoResponse(JSON.parse(j.body)); }
          catch { return fromText(j.body); }
        }
        if (typeof j.data === 'string') {
          try { return normalizeResumoResponse(JSON.parse(j.data)); }
          catch { return fromText(j.data); }
        }

        return fromText(JSON.stringify(j));
      }
    }catch(_e){}

    return fromText('Sem conteúdo.');
  }

  function normalizeMelhorarResponse(out){
    try{
      if (Array.isArray(out)) {
        const first = out[0]?.json ?? out[0] ?? null;
        return normalizeMelhorarResponse(first);
      }

      if (typeof out === 'string') {
        try { const j = JSON.parse(out); return normalizeMelhorarResponse(j); }
        catch { return out; }
      }

      if (out && typeof out === 'object') {
        if (typeof out.text === 'string') {
          try {
            const j = JSON.parse(out.text);
            return j.texto || j.melhorado || j.resposta || j.sugestao || out.text;
          } catch {
            return out.text;
          }
        }
        if (out.json && typeof out.json === 'object') {
          return normalizeMelhorarResponse(out.json);
        }
        return out.texto || out.melhorado || out.resposta || out.sugestao || out.text || out.raw || JSON.stringify(out);
      }
    }catch(_e){}

    return '';
  }

  // ---------- IA: Resumo (do BD) ----------
  async function gerarResumo(){
    const emp = getEmpresaId(), cid = getClienteId();
    if (!emp || !cid){ alert('Selecione um cliente.'); return; }

    refs.resumoLoad.classList.remove('hidden');
    refs.resumoBox.classList.add('hidden');
    refs.resumoTxt.textContent = '';
    refs.resumoBullets.innerHTML = '';
    refs.resumoMeta.textContent = '';
    refs.resumoCopiar.classList.add('hidden');

    try{
      const url = `/api/atendimento/ia/resumo?empresa_id=${emp}&cliente_id=${cid}&full=false&janela_dias=3&limit=800&include_dialogo=true&redact=true&max_chars=8000`;

      const r = await fetch(url, { method:'POST', credentials:'include' });
      const j = await asJsonOrText(r);

      if (!r.ok) {
        const msg = (typeof j === 'string') ? j : (j?.detail?.message || JSON.stringify(j));
        throw new Error(msg || `HTTP ${r.status}`);
      }

      const res = normalizeResumoResponse(j);
      const resumoCurto = res?.resumo_curto || 'Sem conteúdo.';

      refs.resumoTxt.textContent = resumoCurto;

      const bullets = Array.isArray(res.pontos_chave) ? res.pontos_chave : [];
      bullets.forEach(t=>{
        const li=document.createElement('li'); li.textContent=String(t); refs.resumoBullets.appendChild(li);
      });

      const meta=[];
      if (res.topico)   meta.push(`Tópico: ${res.topico}`);
      if (res.urgencia) meta.push(`Urgência: ${res.urgencia}`);
      if (res.confianca!=null) meta.push(`Confiança: ${Math.round((Number(res.confianca)||0)*100)}%`);
      if (res.amostra)  meta.push('—', `Amostra: ${String(res.amostra).slice(0,240)}${String(res.amostra).length>240?'…':''}`);
      refs.resumoMeta.textContent = meta.join('  |  ');

      refs.resumoBox.classList.remove('hidden');
      refs.resumoCopiar.classList.remove('hidden');
    }catch(e){
      console.error('[IA RESUMO]', e);
      refs.resumoTxt.textContent = 'Não foi possível gerar o resumo agora.';
      refs.resumoBox.classList.remove('hidden');
    }finally{
      refs.resumoLoad.classList.add('hidden');
    }
  }

  // ---------- IA: Resposta (do BD) ----------
  async function gerarResposta(){
    const emp = getEmpresaId(), cid = getClienteId();
    if (!emp || !cid){ alert('Selecione um cliente.'); return; }

    refs.respLoad.classList.remove('hidden');
    refs.respBox.classList.add('hidden');
    refs.respTxt.textContent = '';
    refs.copiar.classList.add('hidden');
    refs.colar.classList.add('hidden');

    try{
      const draft = refs.draft?.value || null;
      const url  = `/api/atendimento/ia/melhorar?empresa_id=${emp}&cliente_id=${cid}&janela_dias=3&include_dialogo=true&limit=800&redact=true&max_chars=8000`;

      const r = await fetch(url, {
        method:'POST',
        credentials:'include',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ draft })
      });

      const out = await asJsonOrText(r);
      if (!r.ok) {
        const msg = (typeof out === 'string') ? out : (out?.detail?.message || JSON.stringify(out));
        throw new Error(msg || `HTTP ${r.status}`);
      }

      const texto = normalizeMelhorarResponse(out);

      refs.respTxt.textContent = texto || 'Não foi possível gerar agora.';
      refs.respBox.classList.remove('hidden');
      refs.copiar.classList.remove('hidden');
      refs.colar.classList.remove('hidden');
    }catch(e){
      console.error('[IA RESPOSTA]', e);
      refs.respTxt.textContent = 'Não foi possível gerar agora.';
      refs.respBox.classList.remove('hidden');
    }finally{
      refs.respLoad.classList.add('hidden');
    }
  }

  // ---------- Copiar/Colar ----------
  async function copiarResumo(){
    const bullets = [...refs.resumoBullets.querySelectorAll('li')].map(li=>'- '+li.textContent).join('\n');
    const txt = `${refs.resumoTxt.textContent||''}${bullets?'\n'+bullets:''}${refs.resumoMeta.textContent?'\n'+refs.resumoMeta.textContent:''}`.trim();
    try{
      await navigator.clipboard.writeText(txt);
      refs.resumoCopiar.innerHTML = '<i class="fa-regular fa-clipboard-check"></i> Copiado';
      setTimeout(()=> refs.resumoCopiar.innerHTML = '<i class="fa-regular fa-copy"></i> Copiar', 1500);
    }catch{}
  }
  async function copiarResposta(){
    if (!refs.respTxt.textContent) return;
    try{
      await navigator.clipboard.writeText(refs.respTxt.textContent);
      refs.copiar.innerHTML = '<i class="fa-regular fa-clipboard-check"></i> Copiado';
      setTimeout(()=> refs.copiar.innerHTML = '<i class="fa-regular fa-copy"></i> Copiar', 1500);
    }catch{}
  }
  function colarNoChat(){
    if (!refs.respTxt.textContent) return;
    const input = $('#mensagem');
    if (input) input.value = refs.respTxt.textContent;
    closeIA(); input?.focus();
  }

  // ---------- API pública ----------
  window.IA = { open: openIA, close: closeIA };

  // Delegação global de clique no #btn-ia (pega click no <img> também)
  document.addEventListener('click', function(ev){
    const el = ev.target.closest('#btn-ia');
    if (!el) return;
    ev.preventDefault();
    console.debug('[IA] clique em #btn-ia, abrindo modal');
    openIA();
  });

  // Se o header já estiver visível, injeta o botão agora
  if ($('#chat-header') && getComputedStyle($('#chat-header')).display !== 'none') {
    ensureHeaderButton();
  }

  console.debug('[IA] módulo injetado — 24px + responsivo (BD, janela=3d)');
})();
