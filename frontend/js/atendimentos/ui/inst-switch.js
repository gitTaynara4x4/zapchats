// /frontend/js/atendimentos/ui/inst-switch.js
(function(){
  const wrap = document.getElementById('inst-switch');
  if (!wrap) return;

  const EMPRESA_ID = Number(localStorage.getItem('empresa_id') || 0);

  const KEY_VAL   = (id)=> `instAtiva:${id}`;              // valor (id/slug)
  const KEY_LABEL = (id)=> `instAtivaLabel:${id}`;         // label exibida
  const KEY_MAP   = (id, val)=> `instLabel:${id}:${val}`;  // cache por valor

  const LAST = localStorage.getItem(KEY_VAL(EMPRESA_ID)) || '';

  function markActive(val){
    wrap.querySelectorAll('.inst-pill').forEach(b=>{
      const isActive = (b.dataset.value || '') === (val || '');
      b.classList.toggle('is-active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  // Permite que outros módulos apenas atualizem o “chip” visualmente
  window.setInstanceChip = function(val){
    markActive(String(val ?? ''));
  };

  function applyInstance(value){
    // Preferir função central (se existir)
    if (typeof window.setInstanciaAtiva === 'function') {
      window.setInstanciaAtiva(value === '' ? null : String(value));
    } else {
      // Fallback: define um global e emite evento
      window.INSTANCIA_ATIVA = (value === '' ? null : String(value));
      try {
        document.dispatchEvent(new CustomEvent('inst:change', { detail: { value: window.INSTANCIA_ATIVA }}));
      } catch {}
    }

    // Atualiza a lista imediatamente
    try { window.carregarClientes?.({ force: true }); } catch {}

    // Atualiza o chip visual
    markActive(value || '');

    // Atualiza badge do topo
    try { window.zcUpdateInstBadge?.(); } catch {}
  }

  function saveSelection(value, label){
    const v = String(value || '');
    const lab = String(label || '').trim();

    localStorage.setItem(KEY_VAL(EMPRESA_ID), v);

    if (v) {
      if (lab) {
        localStorage.setItem(KEY_LABEL(EMPRESA_ID), lab);
        localStorage.setItem(KEY_MAP(EMPRESA_ID, v), lab);
      }
    } else {
      // "Todos" / nenhum
      localStorage.removeItem(KEY_LABEL(EMPRESA_ID));
    }
  }

  function onPick(value, label){
    saveSelection(value, label);
    applyInstance(value || '');
  }

  function pill({ label, value, active }){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'inst-pill' + (active ? ' is-active' : '');
    b.textContent = label;
    b.title = `Selecionar ${label}`;
    b.dataset.value = String(value ?? '');
    b.dataset.label = String(label ?? '');
    b.setAttribute('role', 'button');
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    b.onclick = ()=> onPick(String(value ?? ''), String(label ?? ''));
    b.addEventListener('keydown', (e)=>{
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); }
    });
    return b;
  }

  function render(list){
    wrap.innerHTML = '';

    // título + contagem
    const label = document.createElement('div');
    label.className = 'inst-section-label';
    label.innerHTML = `<span class="dot"></span><span>WhatsApps</span><span class="inst-section-count"> (${list.length||0})</span>`;
    wrap.appendChild(label);

    // botão "Todos"
    wrap.appendChild(pill({ label:'Todos', value:'', active:!LAST }));

    // instâncias
    (list || []).forEach(i=>{
      const value =
        i.instancia_id ?? i.instancia ?? i.instance_id ??
        i.session ?? i.sessao ?? i.instance_name ?? i.id ?? '';

      const labelTxt = i.apelido || i.nome || i.instance_name || String(value) || 'Instância';
      wrap.appendChild(pill({
        label: labelTxt,
        value: String(value),
        active: String(LAST) === String(value)
      }));
    });

    // salva globais pra outros módulos (badge)
    window.state = window.state || {};
    window.state.instancias = list;
    window.INSTANCIAS = list;

    // restaura seleção anterior
    if (LAST !== null) {
      // tenta pegar label cacheada (pra não ficar “4”)
      const cachedLabel = localStorage.getItem(KEY_MAP(EMPRESA_ID, LAST)) || localStorage.getItem(KEY_LABEL(EMPRESA_ID)) || '';
      if (LAST && cachedLabel) saveSelection(LAST, cachedLabel);
      applyInstance(LAST);
    }
  }

  if (!EMPRESA_ID) return render([]);

  fetch(`/api/empresas/${EMPRESA_ID}/whatsapp`, { credentials: 'include' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(j => Array.isArray(j.instancias) ? j.instancias : [])
    .then(render)
    .catch(() => render([]));
})();
