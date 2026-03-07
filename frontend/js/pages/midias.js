(() => {
  'use strict';

  const PERM_REQUIRED = 'arquivos.ver';
  const GUARD_TIMEOUT_MS = 3500;

  const LS = localStorage;
  const STATE_KEY = 'midiasState:v1';
  const getEmpresaId = () => LS.getItem('empresa_id') || '';
  const getToken     = () => LS.getItem('token') || LS.getItem('auth_token') || '';
  const KEY_INST     = (empresa) => `instAtiva:${empresa || ''}`;

  function clearAuthScopedState(){
    try{ LS.removeItem(STATE_KEY); }catch{}
    try{ LS.removeItem(KEY_INST(getEmpresaId())); }catch{}
  }

  function gotoLogin(){
    if (window.ZAuth?.goLogin) { try{ ZAuth.goLogin(); return; }catch{} }
    location.replace('/login');
  }
  function gotoSemPermissao(){ location.replace('/sem-permissao'); }

  function handleAuthStatus(res){
    if (!res) return false;
    if (res.status === 401){
      clearAuthScopedState();
      gotoLogin();
      return true;
    }
    if (res.status === 403){
      gotoSemPermissao();
      return true;
    }
    return false;
  }

  async function authFetch(input, init = {}) {
    const useGuard = !!(window.ZAuth?.guardFetch);
    const useAuth  = !!(window.ZAuth?.authFetch);
    const F        = useGuard ? ZAuth.guardFetch : (useAuth ? ZAuth.authFetch : fetch);

    const useNative = !(useGuard || useAuth);
    const t = getToken();
    const baseHeaders = init.headers || {};
    const headers = useNative && t ? { ...baseHeaders, Authorization: `Bearer ${t}` } : baseHeaders;

    try {
      const res = await F(input, { ...init, headers: { 'Accept':'application/json', ...headers }, credentials: 'include' });
      if (useNative && (res.status === 401 || res.status === 403)) handleAuthStatus(res);
      return res;
    } catch (err) {
      const e = err || {};
      e.__authRedirect = true;
      throw e;
    }
  }

  function showLoading(show){
    if (window.PageLoading?.show && window.PageLoading?.hide){
      return show ? PageLoading.show('Carregando…', { scope: '.main' }) : PageLoading.hide();
    }
    let el = document.getElementById('__midias_loading__');
    if (!el){
      el = document.createElement('div'); el.id='__midias_loading__';
      el.style.cssText='position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.25);z-index:9999;';
      el.innerHTML = '<div style="background:#111827;color:#e5e7eb;padding:.8rem 1rem;border:1px solid #374151;border-radius:.6rem;display:flex;gap:.6rem;align-items:center;"><i class="fa fa-spinner fa-spin"></i> Carregando…</div>';
      document.body.appendChild(el);
    }
    el.style.display = show ? 'flex' : 'none';
  }

  function toast(msg){
    const t = document.getElementById('toast');
    if (!t) return alert(msg);
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(()=> t.classList.remove('show'), 2200);
  }

  const els = {
    grid: document.getElementById('midias-list'),
    empty: document.getElementById('empty'),
    meta: document.getElementById('midias-meta'),
    q: document.getElementById('q'),
    ordenar: document.getElementById('ordenar'),
    tabs: Array.from(document.querySelectorAll('.tab[data-type]')),
    btnUpload: document.getElementById('btn-upload'),
    btnLimpar: document.getElementById('btn-limpar'),
    btnMeus: document.getElementById('btn-meus-arquivos'),
    instBtn:   document.getElementById('instMenuBtn'),
    instMenu:  document.getElementById('inst-menu'),
    instList:  document.getElementById('instMenuList'),
    instLabel: document.getElementById('instMenuLabel'),
    box: document.querySelector('.box'),
    btnMore: null,
    moreWrap: null,
  };

  const IMGS=['PNG','JPG','JPEG','WEBP','GIF','BMP','SVG','AVIF','HEIC','HEIF'];
  const VIDS=['MP4','WEBM','OGG','MOV','M4V','MKV','AVI'];
  const AUDS=['MP3','WAV','M4A','AAC','OGG','FLAC','OPUS'];
  const DOC_GROUPS={ all:null, pdf:['PDF'], word:['DOC','DOCX'], excel:['XLS','XLSX','CSV'], ppt:['PPT','PPTX'], text:['TXT','LOG'], code:['JSON','XML','HTML','HTM','MD'], zip:['ZIP','RAR','7Z'] };

  const extFromName = (n='') => { const p=(n||'').split('.'); return p.length<2?'':(p.pop()||'').toUpperCase(); };
  const kindFromNameOrMime = (name,mime='')=>{
    const e = extFromName(name);
    if (IMGS.includes(e)) return 'imagem';
    if (VIDS.includes(e)) return 'video';
    if (AUDS.includes(e)) return 'audio';
    if (['PDF','DOC','DOCX','XLS','XLSX','CSV','PPT','PPTX','TXT','LOG','JSON','XML','HTML','HTM','MD','ZIP','RAR','7Z'].includes(e)) return 'documento';
    if (mime?.startsWith?.('image/')) return 'imagem';
    if (mime?.startsWith?.('video/')) return 'video';
    if (mime?.startsWith?.('audio/')) return 'audio';
    return 'documento';
  };
  const formatDateTime = (ts)=> new Date(ts||Date.now()).toLocaleString('pt-BR',{hour12:false});

  const UGLY_HASH_RE = /^[A-F0-9]{16,}$/i;
  const GENERIC_RE   = /^(?:IMG|VID|PXL|PTT|FILE|IMAGE|VIDEO|AUDIO)[-_ ]?\d{4,}$/i;

  function isUglyName(name=''){
    if(!name) return true;
    const base = String(name).replace(/\.[^.]+$/, '');
    return UGLY_HASH_RE.test(base) || GENERIC_RE.test(base);
  }

  function labelByKind(kind){
    switch((kind||'').toLowerCase()){
      case 'imagem': return 'Imagem';
      case 'video': return 'Vídeo';
      case 'audio': return 'Áudio';
      case 'documento': return 'Documento';
      default: return 'Arquivo';
    }
  }

  function guessExtByMime(mime=''){
    const mt = mime.toLowerCase();
    if (mt.startsWith('image/jpeg')) return '.jpg';
    if (mt.startsWith('image/png')) return '.png';
    if (mt.startsWith('image/webp')) return '.webp';
    if (mt.startsWith('image/gif')) return '.gif';
    if (mt.startsWith('video/mp4')) return '.mp4';
    if (mt.startsWith('video/webm')) return '.webm';
    if (mt.startsWith('audio/ogg')) return '.ogg';
    if (mt.startsWith('audio/mpeg')) return '.mp3';
    if (mt === 'application/pdf') return '.pdf';
    return '';
  }

  function guessExt(item){
    const raw = (item?.nome || '').trim();
    const dot = raw.lastIndexOf('.');
    if (dot > -1 && raw.length - dot <= 5) return raw.slice(dot).toLowerCase();
    return guessExtByMime(item?.tipo || '');
  }

  function extOf(it){
    const ex = extFromName(it?.nome||'');
    return ex || (guessExtByMime(it?.tipo||'').replace('.','').toUpperCase()) || 'ARQ';
  }

  function formatDateBR(ts){
    const d = new Date(ts || Date.now());
    const dStr = d.toLocaleDateString('pt-BR', { timeZone:'America/Sao_Paulo' });
    const tStr = d.toLocaleTimeString('pt-BR', { timeZone:'America/Sao_Paulo', hour12:false, hour:'2-digit', minute:'2-digit' });
    return `${dStr} ${tStr}`;
  }

  function friendlyName(item){
    const raw = (item?.nome || '').trim();
    if (!raw || isUglyName(raw)) {
      const kind = kindFromNameOrMime(item?.nome||'', item?.tipo||'');
      const label = labelByKind(kind);
      const ext = guessExt(item);
      return `${label} ${formatDateBR(item?.timestamp)}${ext}`;
    }
    return raw;
  }

  function escapeHtml(s=''){
    return String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }

  const idOf = (it={}) => it.id ?? it._id ?? it.midias_id ?? it.media_id ?? it.uuid ?? it.key ?? it.chave ?? it.arquivo_id ?? it.file_id ?? it.ID ?? (it.url ? `url:${it.url}` : Math.random().toString(36).slice(2));

  function mediaContextLabel(it){
    if (it?.is_group || it?.grupo_id){
      return it?.grupo_nome || `Grupo #${it.grupo_id}`;
    }
    return 'Conversa';
  }

  function mediaGroupMeta(it){
    if (!(it?.is_group || it?.grupo_id)) return '';
    const nome = it?.grupo_nome ? escapeHtml(it.grupo_nome) : 'Grupo';
    const gid  = it?.grupo_id ? `#${escapeHtml(String(it.grupo_id))}` : '';
    return `${nome}${gid ? ` (${gid})` : ''}`;
  }

  const PAGE_LIMIT = 5;
  let lastItems = [];
  const byId = new Map();
  const selected = new Set();
  let lastClickedIndex = -1;

  const paging = { limit: PAGE_LIMIT, offset: 0, loading: false, more: true };

  let scope = { type:'inst', clienteId:null };
  let currentType = 'all';
  let currentDocGroup = 'all';
  let selectedInst = '';
  const isScopeMeus = () => scope.type === 'meus';

  function makeQueryKeyObj(){
    const emp = getEmpresaId();
    return {
      emp,
      scopeType: scope.type,
      selectedInst: selectedInst || '',
      semCliente: isScopeMeus() ? true : false,
      q: (els.q?.value||'').trim(),
      ordenar: els.ordenar?.value || 'recent',
      currentType,
      currentDocGroup,
    };
  }

  const queryKeyToStr = obj => { try{ return JSON.stringify(obj); }catch{ return ''; } };

  function saveState(extra = {}){
    const keyObj = makeQueryKeyObj();
    const state = {
      key: queryKeyToStr(keyObj),
      ...keyObj,
      loadedCount: lastItems.length,
      scrollY: window.scrollY || 0,
      ts: Date.now(),
      ...extra
    };
    try { LS.setItem(STATE_KEY, JSON.stringify(state)); } catch {}
    return state;
  }

  function loadState(){
    try{
      const raw = LS.getItem(STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch{ return null; }
  }

  function restoreFiltersFromState(st){
    if (!st) return;
    scope.type = st.scopeType === 'meus' ? 'meus' : 'inst';
    if (els.ordenar && st.ordenar) els.ordenar.value = st.ordenar;
    if (els.q) els.q.value = st.q || '';
    currentType = st.currentType || 'all';
    currentDocGroup = st.currentDocGroup || 'all';
    setTabSelected(currentType);
  }

  async function restoreFromStateIfSameQuery(){
    const saved = loadState();
    if (!saved) return false;

    const currentKeyObj = makeQueryKeyObj();
    const savedComparable = { ...saved };
    delete savedComparable.key;
    delete savedComparable.ts;
    delete savedComparable.loadedCount;
    delete savedComparable.scrollY;

    if (queryKeyToStr(savedComparable) !== queryKeyToStr(currentKeyObj)) {
      restoreFiltersFromState(saved);
    }
    if (saved.key !== queryKeyToStr(makeQueryKeyObj())) return false;

    const want = Math.max(0, parseInt(saved.loadedCount || 0, 10));
    if (want <= 0) return false;

    await fetchPage({ reset:true });
    while (lastItems.length < want && paging.more) {
      const before = lastItems.length;
      await fetchPage({ reset:false });
      if (lastItems.length <= before) break;
    }
    setTimeout(()=> window.scrollTo(0, Number(saved.scrollY || 0)), 0);
    return true;
  }

  const toggleEmpty = show => els.empty?.classList.toggle('show', !!show);

  function buildQuery({forUpload=false} = {}){
    const qs = new URLSearchParams({ limit: String(paging.limit), offset: String(paging.offset) });
    const emp = getEmpresaId();
    if (emp) qs.set('empresa_id', String(emp));

    if (isScopeMeus()){
      qs.set('sem_cliente','true');
    } else {
      qs.set('sem_cliente','false');
      if (selectedInst) qs.set('instancia_id', String(selectedInst));
    }

    if (!forUpload){
      const q=(els.q?.value||'').trim(); if(q) qs.set('q', q);
      const ord=els.ordenar?.value; if(ord) qs.set('ordenar', ord);
      if (currentType && currentType!=='all') qs.set('tipo', currentType);
      if (currentType==='documento' && currentDocGroup!=='all') qs.set('doc', currentDocGroup);
    }

    return qs.toString();
  }

  const dig = (obj, pathArr)=> pathArr.reduce((acc,k)=> (acc && acc[k] != null) ? acc[k] : undefined, obj);

  function normalizeItems(raw){
    const list =
      Array.isArray(raw) ? raw :
      Array.isArray(raw?.items) ? raw.items :
      Array.isArray(raw?.data) ? raw.data :
      Array.isArray(dig(raw, ['data','items'])) ? raw.data.items :
      Array.isArray(dig(raw, ['data','data'])) ? raw.data.data :
      Array.isArray(raw?.rows) ? raw.rows :
      Array.isArray(raw?.midias) ? raw.midias :
      [];

    return list.map(it => {
      const nome = it.nome ?? it.name ?? it.filename ?? it.titulo ?? it.title ?? '-';
      const url  = it.url ?? it.arquivo_url ?? it.file_url ?? it.public_url ?? it.signed_url ?? it.link ?? it.href ?? it.path ?? it.arquivo ?? '';
      const tipo = it.tipo ?? it.mime ?? it.mimetype ?? it.content_type ?? '';
      const ts   = it.timestamp ?? it.created_at ?? it.createdAt ?? it.criado_em ?? it.dataCriacao ?? it.updated_at ?? Date.now();
      const id   = idOf(it);

      const grupoId   = it.grupo_id ?? it.group_id ?? it.grupoId ?? null;
      const grupoNome = it.grupo_nome ?? it.group_name ?? it.nome_grupo ?? it.groupName ?? null;
      const isGroup   = Boolean(it.is_group ?? grupoId);

      return {
        ...it,
        id,
        nome,
        url,
        tipo,
        timestamp: ts,
        grupo_id: grupoId,
        grupo_nome: grupoNome,
        is_group: isGroup,
      };
    }).filter(it => it.nome);
  }

  function iconForDoc(ext){
    if (ext === 'PDF') return '/frontend/img/file-pdf.svg';
    if (ext === 'DOC' || ext === 'DOCX') return '/frontend/img/file-word.svg';
    if (ext === 'XLS' || ext === 'XLSX' || ext === 'CSV') return '/frontend/img/file-excel.svg';
    return null;
  }

  function audioMimeByExt(ext){
    const e = (ext||'').toLowerCase();
    if (e === 'mp3') return 'audio/mpeg';
    if (e === 'wav') return 'audio/wav';
    if (e === 'm4a') return 'audio/mp4';
    if (e === 'aac') return 'audio/aac';
    if (e === 'flac') return 'audio/flac';
    if (e === 'opus') return 'audio/opus';
    if (e === 'ogg' || e === 'oga') return 'audio/ogg';
    return '';
  }

  function withTimeFragment(u){
    if (!u) return u;
    if (u.includes('#')) return /(?:^|[#&])t=/.test(u) ? u : `${u}&t=0`;
    return `${u}#t=0`;
  }

  function wireAudioEl(a){
    a.preload = 'metadata';
    const toZero = () => { try { a.currentTime = 0.000001; } catch(_){} };
    const nearEnd = () => {
      const d = Number.isFinite(a.duration) ? a.duration : 0;
      return d && (a.currentTime >= d - 0.05);
    };
    a.addEventListener('loadedmetadata', toZero, { once:true });
    a.addEventListener('loadeddata', toZero, { once:true });
    a.addEventListener('canplay', () => { if (nearEnd() || a.ended) toZero(); });
    a.addEventListener('play', () => { if (nearEnd() || a.ended) toZero(); });
    a.addEventListener('ended', () => { toZero(); a.pause(); });
  }

  function infoBlock(it){
    const div = document.createElement('div');
    div.className = 'mm-info';

    const name = friendlyName(it);
    const ext  = extOf(it);
    const when = formatDateTime(it.timestamp);
    const grupoMeta = mediaGroupMeta(it);

    div.innerHTML = `
      <div class="mm-name" title="${escapeHtml(it.nome || name)}">${escapeHtml(name)}</div>
      ${
        grupoMeta
          ? `<div class="mm-group" style="margin-top:.35rem;opacity:.85;font-size:.92rem">
               <i class="fa fa-users"></i> ${grupoMeta}
             </div>`
          : ''
      }
      <div class="mm-meta"><span>${ext}</span> <span>•</span> <span>${when}</span></div>
    `;
    return div;
  }

  function injectRenameCSS(){
    if (document.getElementById('__mm_rename_css__')) return;
    const css = `
      .mm-title-edit{display:flex;align-items:center;gap:.4rem;max-width:60vw}
      .mm-title-edit input{
        background:var(--card2, #1f2937);border:1px solid var(--border, #374151);
        color:var(--fg, #e5e7eb);padding:.3rem .45rem;border-radius:.4rem;
        font-weight:700;width:100%;min-width:16ch;outline:none
      }
      .mm-title-edit input:focus{box-shadow:0 0 0 3px var(--ring, rgba(99,102,241,.35));border-color:transparent}
      .mm-title-ext{opacity:.7;font-weight:700;white-space:nowrap}
    `;
    const style = document.createElement('style');
    style.id = '__mm_rename_css__';
    style.textContent = css;
    document.head.appendChild(style);
  }

  let modal=null, modalTitle=null, modalBody=null, modalOpen=null, modalDownload=null, modalClose=null, modalRename=null;
  let _renameUI = null;

  function updateCardTitle(item){
    const card = els.grid.querySelector(`.media-card[data-id="${CSS.escape(String(item.id))}"]`);
    const ui = friendlyName(item);
    if (card){
      const title = card.querySelector('.media-title');
      const cap   = card.querySelector('.thumb-cap');
      if (title) title.textContent = ui;
      if (cap){ cap.textContent = ui; cap.title = item.nome; }
      card.title = item.nome;
    }
    if (modalTitle) modalTitle.textContent = ui;
  }

  function stopInlineRename(){
    if (_renameUI?.wrap) _renameUI.wrap.remove();
    if (modalTitle) modalTitle.style.display = '';
    _renameUI = null;
  }

  function originalExtLower(it){
    const raw = (it?.nome || '').trim();
    const i = raw.lastIndexOf('.');
    if (i > 0 && raw.length - i <= 5) return raw.slice(i).toLowerCase();
    const byMime = guessExtByMime(it?.tipo || '');
    return byMime || '';
  }

  function normalizeRenameInput(item, input){
    let base = String(input || '').trim();
    const i = base.lastIndexOf('.');
    if (i > 0 && base.length - i <= 5) base = base.slice(0, i);
    if (!base) base = 'arquivo';
    return base + (originalExtLower(item) || '');
  }

  async function apiRename(item, newName){
    const emp = getEmpresaId();
    if (!emp) { toast('empresa_id não definido'); return false; }

    const url = `/api/midias/${encodeURIComponent(item.id)}?empresa_id=${encodeURIComponent(emp)}`;
    try{
      const r = await authFetch(url, {
        method:'PATCH',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ nome: newName })
      });
      if (r.status === 401 || r.status === 403) return false;
      if (!r.ok) return false;
      const updated = await r.json().catch(()=>null);
      if (updated?.nome) item.nome = updated.nome; else item.nome = newName;
      if (updated?.timestamp) item.timestamp = updated.timestamp;
      if (updated?.url) item.url = updated.url;
      return true;
    }catch(e){
      if (e?.__authRedirect || e?.name === 'AbortError') return false;
      return false;
    }
  }

  function startInlineRename(item){
    stopInlineRename();
    injectRenameCSS();

    const cur  = item.nome || friendlyName(item);
    const base = cur.includes('.') ? cur.slice(0, cur.lastIndexOf('.')) : cur;
    const ext  = originalExtLower(item) || '';

    const wrap  = document.createElement('div');
    wrap.className = 'mm-title-edit';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = base;
    input.placeholder = 'Novo nome';
    wrap.appendChild(input);

    const extSpan = document.createElement('span');
    extSpan.className = 'mm-title-ext';
    extSpan.textContent = ext;
    wrap.appendChild(extSpan);

    modalTitle.style.display = 'none';
    modalTitle.insertAdjacentElement('afterend', wrap);

    const save = async () => {
      const finalName = normalizeRenameInput(item, input.value);
      if (!finalName || finalName === item.nome){ stopInlineRename(); return; }

      showLoading(true);
      const ok = await apiRename(item, finalName);
      showLoading(false);

      if (!ok){ toast('Não foi possível renomear.'); input.focus(); return; }

      item.nome = finalName;
      byId.set(item.id, item);
      updateCardTitle(item);
      stopInlineRename();
      toast('Nome atualizado.');
    };

    const cancel = () => stopInlineRename();

    input.addEventListener('keydown', (e)=>{
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') cancel();
    });
    input.addEventListener('blur', save);

    input.focus();
    input.select();

    _renameUI = { wrap };
  }

  function ensureModal(){
    if (modal) return;
    modal=document.createElement('div');
    modal.className='midias-modal';
    modal.id='midias-modal';
    modal.setAttribute('role','dialog');
    modal.setAttribute('aria-modal','true');
    modal.setAttribute('aria-labelledby','mm-title');
    modal.innerHTML=`
      <div class="midias-modal__panel">
        <div class="midias-modal__header">
          <strong id="mm-title"></strong>
          <button id="mm-rename" class="btn" title="Renomear"><i class="fa fa-pen"></i></button>
          <button id="mm-open" class="btn ghost" title="Abrir em nova aba"><i class="fa fa-up-right-from-square"></i></button>
          <button id="mm-download" class="btn" title="Baixar"><i class="fa fa-download"></i></button>
          <button id="mm-close" class="btn" title="Fechar"><i class="fa fa-xmark"></i></button>
        </div>
        <div id="mm-body" class="midias-modal__body"></div>
      </div>`;
    document.body.appendChild(modal);
    modalTitle=modal.querySelector('#mm-title');
    modalBody =modal.querySelector('#mm-body');
    modalOpen =modal.querySelector('#mm-open');
    modalDownload=modal.querySelector('#mm-download');
    modalClose=modal.querySelector('#mm-close');
    modalRename=modal.querySelector('#mm-rename');

    function close(){
      modalBody.querySelectorAll('video, audio').forEach(m => { try { m.pause(); m.currentTime = 0; } catch(_){}} );
      if (modal._onKey) document.removeEventListener('keydown', modal._onKey);
      stopInlineRename();
      modal.classList.remove('open');
    }
    modalClose.addEventListener('click', close);
    modal.addEventListener('click',(e)=>{ if(e.target===modal) close(); });
    modal._close = close;
  }

  function clearModal(){
    ensureModal();
    stopInlineRename();
    modalTitle.textContent='Pré-visualização';
    modalBody.innerHTML='';
    modalOpen.onclick=null;
    modalDownload.onclick=null;
    modalRename.onclick=null;
  }

  function downloadUrl(url, filename){
    const a=document.createElement('a');
    a.href=url;
    a.download=filename||'';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function openModal(it){
    clearModal();
    const nomeUi  = friendlyName(it);
    const nomeRaw = it.nome || nomeUi;

    modalTitle.textContent = nomeUi;

    const kind = kindFromNameOrMime(it.nome||'', it.tipo||'');
    const ext  = extFromName(it.nome||'');

    if (kind==='imagem'){
      const img=new Image();
      img.src=it.url;
      img.alt=nomeUi;
      img.style.maxHeight='78vh';
      img.style.objectFit='contain';
      img.style.display='block';
      img.style.margin='0 auto';
      modalBody.appendChild(img);
    } else if (kind==='video'){
      const v=document.createElement('video');
      v.src=it.url;
      v.controls=true;
      v.preload='metadata';
      v.style.width='100%';
      v.style.maxHeight='78vh';
      modalBody.appendChild(v);
    } else if (kind==='audio'){
      const a=document.createElement('audio');
      a.controls=true;
      a.preload='metadata';
      const s = document.createElement('source');
      const e = (extFromName(it.nome || '').toLowerCase());
      s.src  = withTimeFragment(it.url || '');
      s.type = it.tipo || audioMimeByExt(e) || '';
      a.appendChild(s);
      wireAudioEl(a);
      modalBody.appendChild(a);
    } else {
      const icon = iconForDoc(ext);
      if (icon){
        const img=new Image();
        img.src=icon;
        img.alt=ext;
        img.style.width='120px';
        img.style.height='120px';
        img.style.display='block';
        img.style.margin='0 auto';
        modalBody.appendChild(img);
      } else {
        const div=document.createElement('div');
        div.textContent=ext || 'ARQ';
        div.style.fontWeight='900';
        div.style.textAlign='center';
        div.style.opacity='.85';
        modalBody.appendChild(div);
      }
    }

    modalBody.appendChild(infoBlock(it));

    modalOpen.onclick = ()=>window.open(it.url,'_blank');
    modalDownload.onclick = ()=>downloadUrl(it.url, nomeRaw);
    modalRename.onclick = () => startInlineRename(it);

    modal.classList.add('open');
    document.addEventListener('keydown', (modal._onKey = (e)=>{ if(e.key==='Escape') modal._close(); }));
  }

  function appendCards(items){
    if (!els.grid || !Array.isArray(items) || items.length === 0) return;

    const frag = document.createDocumentFragment();

    items.forEach((it)=>{
      const id = idOf(it);
      byId.set(id, it);

      const ext  = extOf(it);
      const kind = kindFromNameOrMime(it.nome||'', it.tipo||'');
      const nomeUi = friendlyName(it);
      const nomeRaw = it.nome || nomeUi;
      const grupoMeta = mediaGroupMeta(it);

      const card = document.createElement('div');
      card.className = 'media-card';
      card.dataset.id = String(id);

      const prev = document.createElement('div');
      prev.className = 'media-thumb';

      const badge = document.createElement('div');
      badge.textContent = ext;
      badge.style.cssText='position:absolute;top:8px;left:8px;z-index:2;background:#0fa27c;color:#fff;font-weight:800;font-size:.75rem;padding:.2rem .45rem;border-radius:.45rem;letter-spacing:.02em;border:1px solid rgba(255,255,255,.15)';
      prev.appendChild(badge);

      if (it.is_group || it.grupo_id){
        const gBadge = document.createElement('div');
        gBadge.textContent = 'Grupo';
        gBadge.style.cssText='position:absolute;top:8px;right:8px;z-index:2;background:#2563eb;color:#fff;font-weight:800;font-size:.72rem;padding:.2rem .45rem;border-radius:.45rem;letter-spacing:.02em;border:1px solid rgba(255,255,255,.15)';
        prev.appendChild(gBadge);
      }

      const pick = document.createElement('button');
      pick.type='button';
      pick.className='media-pick';
      pick.setAttribute('aria-pressed','false');
      pick.innerHTML='✓';
      pick.addEventListener('click', (e)=>{
        e.stopPropagation();
        toggleSelect(card, !card.classList.contains('selected'), { index: cardsIndex(card), shiftKey: e.shiftKey });
      });
      prev.appendChild(pick);

      if (kind==='imagem'){
        const img=new Image();
        img.loading='lazy';
        img.src=it.url;
        img.alt=nomeUi;
        img.style.maxWidth='100%';
        img.style.maxHeight='100%';
        img.style.objectFit='cover';
        prev.appendChild(img);
        prev.classList.add('image');
      } else if (kind==='video'){
        const ic=document.createElement('i');
        ic.className='fa fa-video';
        ic.style.fontSize='2rem';
        ic.style.opacity='.85';
        prev.appendChild(ic);
      } else if (kind==='audio'){
        const ic=document.createElement('i');
        ic.className='fa fa-microphone';
        ic.style.fontSize='2rem';
        ic.style.opacity='.85';
        prev.appendChild(ic);
      } else {
        const icon = iconForDoc(ext);
        if (icon){
          const img = new Image();
          img.src = icon;
          img.alt = ext;
          img.style.width='72px';
          img.style.height='72px';
          prev.appendChild(img);
        } else {
          const t = document.createElement('div');
          t.textContent = ext;
          t.style.fontWeight='900';
          t.style.opacity='.8';
          prev.appendChild(t);
        }
      }

      const cap = document.createElement('div');
      cap.className='thumb-cap';
      cap.textContent = nomeUi;
      cap.title = nomeRaw;
      prev.appendChild(cap);

      const body=document.createElement('div');
      body.className='media-body';
      body.innerHTML = `
        <div class="media-title" title="${escapeHtml(nomeRaw)}">${escapeHtml(nomeUi)}</div>
        ${
          grupoMeta
            ? `<div class="media-group-meta" title="${grupoMeta}">
                 <i class="fa fa-users"></i> ${grupoMeta}
               </div>`
            : ''
        }
        <div class="media-meta">
          <span>${ext}</span>
          <span>•</span>
          <span>${formatDateTime(it.timestamp)}</span>
        </div>
      `;

      card.addEventListener('click',()=>{ if (!card.classList.contains('selected')) openModal(it); });

      card.title = nomeRaw;
      card.appendChild(prev);
      card.appendChild(body);
      frag.appendChild(card);
    });

    els.grid.appendChild(frag);
  }

  function cardsIndex(card){
    const arr = Array.from(els.grid.querySelectorAll('.media-card'));
    return arr.indexOf(card);
  }

  function applyTypeFilter(items){
    let list = Array.isArray(items) ? items.slice() : [];

    if (currentType === 'all') {
      list = list.filter(it => (it.tipo_db || '').toLowerCase() !== 'sticker');
    }

    if (currentType !== 'all')
      list = list.filter(it => kindFromNameOrMime(it.nome||'', it.tipo||'') === currentType);

    if (currentType==='documento' && currentDocGroup!=='all'){
      const wanted = DOC_GROUPS[currentDocGroup] || null;
      if (wanted) list = list.filter(it => wanted.includes(extFromName(it.nome||'')));
    }
    return list;
  }

  function ensureLoadMore(){
    if (!els.box || els.btnMore) return;
    const wrap = document.createElement('div');
    wrap.className = 'load-more-wrap';
    wrap.style.cssText = 'display:flex;justify-content:center;padding:.6rem .25rem;';
    wrap.innerHTML = `
      <button id="btn-load-more" type="button" class="btn" aria-label="Mostrar mais">
        <i class="fa fa-arrow-down"></i> <span>Mostrar mais</span>
      </button>`;
    els.box.appendChild(wrap);
    els.moreWrap = wrap;
    els.btnMore = wrap.querySelector('#btn-load-more');
    els.btnMore.addEventListener('click', ()=> fetchPage({ reset:false }).then(()=>saveState()));
  }

  const setMoreVisibility = show => { if (els.moreWrap) els.moreWrap.style.display = show ? 'flex' : 'none'; };

  function setMoreBusy(busy){
    if (!els.btnMore) return;
    els.btnMore.disabled = !!busy;
    const span = els.btnMore.querySelector('span');
    const ico = els.btnMore.querySelector('i');
    if (busy){ span.textContent = 'Carregando...'; ico.className = 'fa fa-spinner fa-spin'; }
    else { span.textContent = 'Mostrar mais'; ico.className = 'fa fa-arrow-down'; }
  }

  const setTabSelected = type => els.tabs.forEach(b=>b.setAttribute('aria-selected', b.dataset.type===type ? 'true':'false'));

  function bindFilterEvents(){
    els.tabs.forEach(btn=>{
      btn.addEventListener('click',()=>{
        const t=btn.dataset.type;
        if(!t) return;
        currentType=t;
        setTabSelected(t);
        if (t === 'documento') currentDocGroup = 'all';
        fetchPage({ reset:true }).then(()=>saveState());
      });
    });

    els.ordenar?.addEventListener('change', ()=>{ fetchPage({ reset:true }).then(()=>saveState()); });
    els.q?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ fetchPage({ reset:true }).then(()=>saveState()); }});

    els.btnLimpar?.addEventListener('click', ()=>{
      if (selected.size === 0){ toast('Selecione arquivos no ✓ para limpar.'); return; }
      openConfirm();
    });

    els.btnUpload?.addEventListener('click', async ()=>{
      if (els.btnUpload.disabled) return;
      const tmp = document.createElement('input');
      tmp.type = 'file';
      tmp.multiple = true;
      tmp.hidden = true;
      document.body.appendChild(tmp);
      tmp.addEventListener('change', async e=>{
        const files = e.target.files || [];
        if (files.length){ await uploadFiles(files); }
        tmp.remove();
      });
      tmp.click();
    });

    els.btnMeus?.addEventListener('click', ()=>{
      scope.type = 'meus';
      selectedInst = '';
      updateUploadState();
      fetchPage({ reset:true }).then(()=>saveState());
      toast('Você está vendo apenas Meus Arquivos.');
    });

    els.grid?.addEventListener('click', e=>{
      const card = e.target.closest?.('.media-card');
      if (!card) return;
      if (e.shiftKey){
        e.preventDefault();
        toggleSelect(card, true, { index: cardsIndex(card), shiftKey:true });
      }
    });

    window.addEventListener('beforeunload', ()=> saveState());
  }

  function updateUploadState(){
    if (!els.btnUpload) return;
    els.btnUpload.disabled = !isScopeMeus();
  }

  const KEY = id => `instAtiva:${id}`;
  function getSavedInst(empresa){ return empresa ? (localStorage.getItem(KEY(empresa)) || '') : ''; }
  function setSavedInst(empresa, v){ try{ if (empresa) localStorage.setItem(KEY(empresa), v || ''); }catch{} }

  function ensureCSSEscape(){
    if (typeof window.CSS === 'undefined') window.CSS = {};
    if (typeof window.CSS.escape !== 'function') {
      window.CSS.escape = s => String(s).replace(/["\\]/g,'\\$&').replace(/\s/g,'\\ ');
    }
  }

  function instValue(i){
    return i.instancia_id ?? i.instancia ?? i.instancia_slug ??
           i.instance_id  ?? i.instance  ?? i.session ??
           i.sessionName  ?? i.sessao    ?? i.inst_slug ??
           i.id ?? '';
  }

  function instLabel(i, v){ return i.apelido || i.nome || i.instance_name || String(v) || 'Instância'; }

  function itemTpl(text, value, selected, onSelect){
    const li = document.createElement('li');
    const b  = document.createElement('button');
    b.type = 'button';
    b.className = 'inst-item';
    b.setAttribute('role','option');
    b.setAttribute('aria-selected', selected ? 'true' : 'false');
    b.tabIndex = -1;
    b.dataset.value = String(value ?? '');
    b.dataset.label = text;
    b.innerHTML = `<span class="radio" aria-hidden="true"></span><span>${text}</span>`;
    b.addEventListener('click', () => onSelect(String(value ?? ''), text));
    li.appendChild(b);
    return li;
  }

  function wireInstDropdown(){
    const btn=els.instBtn, menu=els.instMenu, listEl=els.instList, label=els.instLabel;
    if (!btn || !menu || !listEl || !label) return;

    ensureCSSEscape();
    const empresaId = getEmpresaId();

    function setActiveUI(value, text){
      listEl.querySelectorAll('.inst-item').forEach(b=>{
        const isSel = (b.dataset.value === String(value));
        b.setAttribute('aria-selected', isSel ? 'true' : 'false');
      });
      label.textContent = text || (value ? `Instância ${value}` : 'Todas as instâncias');
    }

    function selectValue(value, text){
      selectedInst = value || '';
      scope.type = 'inst';
      setActiveUI(value, text);
      setSavedInst(empresaId, value);
      updateUploadState();
      document.dispatchEvent(new CustomEvent('midias:instancia-set', { detail:{ value } }));
      closeMenu();
      btn.focus();
    }

    function openMenu(){
      menu.setAttribute('aria-hidden','false');
      btn.setAttribute('aria-expanded','true');
      const active = listEl.querySelector('.inst-item[aria-selected="true"]') || listEl.querySelector('.inst-item');
      active?.focus();
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('keydown', onKey);
    }

    function closeMenu(){
      menu.setAttribute('aria-hidden','true');
      btn.setAttribute('aria-expanded','false');
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    }

    function toggleMenu(){ (menu.getAttribute('aria-hidden')!=='false') ? openMenu() : closeMenu(); }
    function onDocClick(e){ if (!menu.contains(e.target) && e.target !== btn) closeMenu(); }

    function onKey(e){
      if (e.key === 'Escape'){ e.preventDefault(); closeMenu(); btn.focus(); }
      if (menu.getAttribute('aria-hidden') === 'true') return;
      const items = Array.from(listEl.querySelectorAll('.inst-item'));
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown'){ e.preventDefault(); (items[i+1]||items[0])?.focus(); }
      if (e.key === 'ArrowUp'){ e.preventDefault(); (items[i-1]||items[items.length-1])?.focus(); }
      if (e.key === 'Home'){ e.preventDefault(); items[0]?.focus(); }
      if (e.key === 'End'){ e.preventDefault(); items[items.length-1]?.focus(); }
      if (e.key === 'Enter' || e.key === ' '){
        const a = document.activeElement;
        if (a && a.classList.contains('inst-item')) {
          e.preventDefault();
          selectValue(a.dataset.value, a.dataset.label);
        }
      }
    }

    btn.addEventListener('click', toggleMenu);

    async function loadList(){
      listEl.innerHTML = '';
      const saved = getSavedInst(empresaId);
      selectedInst = saved || '';
      scope.type = 'inst';

      listEl.appendChild(itemTpl('Todas as instâncias','', saved === '' , selectValue));

      let items = [];
      if (empresaId){
        try{
          const r = await authFetch(`/api/empresas/${empresaId}/whatsapp`, { credentials:'include' });
          if (r.status === 401 || r.status === 403) return;
          const j = await r.json().catch(()=>({}));
          items = Array.isArray(j.instancias) ? j.instancias : (Array.isArray(j) ? j : []);
        }catch{}
      }

      items.forEach(i=>{
        const v = String(instValue(i) ?? '');
        const t = instLabel(i, v);
        listEl.appendChild(itemTpl(t, v, saved !== '' && saved === v, selectValue));
      });

      if (saved){
        const sel = listEl.querySelector(`.inst-item[data-value="${CSS.escape(saved)}"]`);
        setActiveUI(saved, sel?.dataset?.label || `Instância ${saved}`);
      }else{
        setActiveUI('', 'Todas as instâncias');
      }
    }

    loadList();
  }

  document.addEventListener('midias:instancia-set', () => { fetchPage({ reset:true }).then(()=>saveState()); });

  async function uploadFiles(files){
    if(!files||!files.length) return;
    const fd=new FormData();
    Array.from(files).forEach(f=>fd.append('files', f));
    fd.append('sem_cliente','true');

    showLoading(true);
    try{
      const qs = buildQuery({forUpload:true});
      const r = await authFetch(`/api/midias/upload?${qs}`, { method:'POST', body:fd });
      if (r.status === 401 || r.status === 403) return;
      if(!r.ok) toast('Falha no upload.');
      else {
        await r.json().catch(()=>null);
        await fetchPage({ reset:true });
        toast('Upload concluído.');
        saveState();
      }
    }catch(e){
      if (!e?.__authRedirect) toast('Erro no upload.');
    }finally{
      showLoading(false);
    }
  }

  async function fetchPage({ reset = false } = {}) {
    if (paging.loading) return;
    if (!paging.more && !reset) return;

    if (reset) {
      paging.offset = 0;
      paging.more = true;
      lastItems = [];
      byId.clear();
      selected.clear();
      lastClickedIndex = -1;
      if (els.grid) els.grid.innerHTML = '';
      if (els.meta) els.meta.textContent = '0';
      toggleEmpty(true);
      ensureLoadMore();
      setMoreVisibility(true);
      updateUploadState();
      updateBulkUI();
    }

    paging.loading = true;
    els.grid?.setAttribute('aria-busy', 'true');
    if (reset) showLoading(true);
    setMoreBusy(true);

    try {
      const r = await authFetch(`/api/midias?${buildQuery()}`);
      if (r.status === 401 || r.status === 403) return;
      if (!r.ok) {
        toast(`Erro ${r.status} ao buscar mídias.`);
        paging.more = false;
        toggleEmpty(true);
        setMoreVisibility(false);
        return;
      }

      const raw = await r.json().catch(()=>[]);
      const pageAll = normalizeItems(raw);
      const pageFiltered = applyTypeFilter(pageAll);

      appendCards(pageFiltered);
      lastItems = lastItems.concat(pageFiltered);

      if (els.meta) els.meta.textContent = String(lastItems.length);
      toggleEmpty(lastItems.length === 0);

      if (pageAll.length < paging.limit) {
        paging.more = false;
        setMoreVisibility(false);
      } else {
        paging.more = true;
        paging.offset += paging.limit;
        setMoreVisibility(true);
      }

    } catch (e) {
      if (e?.__authRedirect || e?.name === 'AbortError' || /aborted|cancel/i.test(e?.message||'')) return;
      console.warn('[Mídias] erro fetch', e);
      toast('Erro ao carregar mídias.');
    } finally {
      paging.loading = false;
      els.grid?.setAttribute('aria-busy', 'false');
      if (reset) showLoading(false);
      setMoreBusy(false);
    }
  }

  function toggleSelect(card, on=true, { index, shiftKey } = {}){
    const cards = Array.from(els.grid.querySelectorAll('.media-card'));
    const i = (index ?? cards.indexOf(card));

    if (shiftKey && lastClickedIndex >= 0){
      const [a,b] = [Math.min(lastClickedIndex,i), Math.max(lastClickedIndex,i)];
      for (let k=a;k<=b;k++){
        const c = cards[k];
        if(!c) continue;
        setCardSelected(c, true);
      }
    }else{
      setCardSelected(card, !!on);
      lastClickedIndex = i;
    }
    updateBulkUI();
  }

  function setCardSelected(card, on){
    const id = card.dataset.id;
    card.classList.toggle('selected', !!on);
    if (on) selected.add(id); else selected.delete(id);
  }

  function updateBulkUI(){
    const n = selected.size;
    if (els.btnLimpar){
      els.btnLimpar.classList.toggle('danger', n>0);
      els.btnLimpar.innerHTML = n>0 ? `<i class="fa fa-trash"></i> Limpar (${n})` : `<i class="fa fa-trash"></i> Limpar`;
      els.btnLimpar.disabled = n===0;
    }
  }

  let confirmModal=null, cmBody=null, cmOk=null, cmCancel=null;

  function ensureConfirm(){
    if (confirmModal) return;
    confirmModal = document.createElement('div');
    confirmModal.className='confirm-modal';
    confirmModal.innerHTML = `
      <div class="confirm-panel" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h3 class="confirm-title" id="confirm-title">Limpar arquivos</h3>
        <div class="confirm-body" id="confirm-body"></div>
        <div class="confirm-actions">
          <button type="button" class="btn" id="cm-cancel">Cancelar</button>
          <button type="button" class="btn primary" id="cm-ok"><i class="fa fa-trash"></i> Apagar</button>
        </div>
      </div>`;
    document.body.appendChild(confirmModal);
    cmBody = confirmModal.querySelector('#confirm-body');
    cmOk = confirmModal.querySelector('#cm-ok');
    cmCancel = confirmModal.querySelector('#cm-cancel');

    cmCancel.addEventListener('click', ()=>confirmModal.classList.remove('open'));
  }

  function openConfirm(){
    ensureConfirm();
    const nSel = selected.size;
    const total = els.grid?.querySelectorAll('.media-card').length || 0;
    cmBody.innerHTML = `Você selecionou <strong>${nSel}</strong> ${nSel===1?'arquivo':'arquivos'} de <strong>${total}</strong> exibidos.<br>Essa ação não pode ser desfeita. Deseja realmente apagar?`;
    cmOk.onclick = async ()=>{
      const ids = Array.from(selected);
      confirmModal.classList.remove('open');
      showLoading(true);
      const ok = await apiDeleteMany(ids);
      showLoading(false);
      if (!ok) return toast('Falha ao limpar arquivos.');

      ids.forEach(id=>{
        const el = els.grid.querySelector(`.media-card[data-id="${CSS.escape(String(id))}"]`);
        el?.remove();
        byId.delete(id);
      });
      ids.forEach(id=> selected.delete(id));
      updateBulkUI();
      if (els.meta) els.meta.textContent = String(els.grid.querySelectorAll('.media-card').length);
      toggleEmpty(els.grid.querySelectorAll('.media-card').length===0);
      toast('Arquivos removidos.');
    };
    confirmModal.classList.add('open');
  }

  async function apiDeleteMany(ids=[]){
    const emp = getEmpresaId();
    if (!emp) { toast('empresa_id não definido'); return false; }

    for (const id of ids){
      try{
        const url = `/api/midias/${encodeURIComponent(id)}?empresa_id=${encodeURIComponent(emp)}`;
        const r = await authFetch(url, { method:'DELETE' });
        if (r.status === 401 || r.status === 403) return false;
        if (!r.ok) return false;
      }catch(e){
        if (e?.__authRedirect || e?.name === 'AbortError') return false;
        return false;
      }
    }
    return true;
  }

  async function ensurePermission(){
    try {
      const r = await authFetch('/api/permissoes/minhas', { headers:{ 'Accept':'application/json' } });
      if (r.status === 401 || r.status === 403) return false;
      if (!r.ok) return false;
      const data = await r.json().catch(()=>[]);
      const list = Array.isArray(data) ? data : (Array.isArray(data?.permissoes) ? data.permissoes : []);
      return list.includes(PERM_REQUIRED);
    } catch { return false; }
  }

  function bindPageEvents(){
    bindFilterEvents();
    wireInstDropdown();
    ensureLoadMore();
  }

  async function boot(){
    if (window.ZAuth?.softEnsureAuth) await ZAuth.softEnsureAuth();
    bindPageEvents();
    updateUploadState();

    const empresaId = getEmpresaId();
    const saved = (empresaId ? (localStorage.getItem(`instAtiva:${empresaId}`) || '') : '');
    if (saved) {
      selectedInst = saved;
      scope.type = 'inst';
    }

    const restored = await restoreFromStateIfSameQuery();
    if (!restored) {
      scope = { type:'inst', clienteId:null };
      await fetchPage({ reset:true });
      saveState();
    }
  }

  async function legacyRun(){
    const ok = await ensurePermission();
    if (!ok) return;
    await boot();
  }

  const run = () => {
    const guard = window.Page?.guarded;
    if (typeof guard !== 'function') return legacyRun();

    let resolved = false;
    const timer = setTimeout(() => { if (!resolved) legacyRun(); }, GUARD_TIMEOUT_MS);

    try{
      guard(PERM_REQUIRED, async () => {
        resolved = true;
        clearTimeout(timer);
        await boot();
      }, {
        loading: 'Carregando…',
        onDeny(){ resolved = true; clearTimeout(timer); gotoSemPermissao(); }
      });
    }catch{
      resolved = true;
      clearTimeout(timer);
      legacyRun();
    }
  };

  window.MidiasDebug = {
    state: () => ({
      empresa_id: getEmpresaId(),
      scope,
      selectedInst,
      q: (els.q?.value||'').trim(),
      ordenar: els.ordenar?.value || 'recent',
      currentType,
      currentDocGroup,
      query: buildQuery(),
    }),
    query: () => buildQuery(),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once:true });
  else run();
})();