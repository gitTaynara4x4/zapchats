/* guard-devtools.js — best-effort: bloqueia atalhos e avisa. Não é segurança real. */
(function(){
  const MSG = 'Ação bloqueada por segurança. Inspecionar/desenvolvedor não é permitido.';

  // exibe aviso: usa showToast se disponível; senão cria um banner; senão alert.
  function notify(msg){
    if (typeof window.showToast === 'function') {
      try { showToast(msg, 'warn'); return; } catch {}
    }
    let bar = document.getElementById('__guard_bar__');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__guard_bar__';
      bar.setAttribute('role', 'status');
      bar.style.position = 'fixed';
      bar.style.zIndex = '999999';
      bar.style.left = '50%';
      bar.style.top = '12px';
      bar.style.transform = 'translateX(-50%)';
      bar.style.maxWidth = '92vw';
      bar.style.background = 'rgba(234,179,8,0.95)'; // âmbar
      bar.style.color = '#111827';
      bar.style.border = '1px solid rgba(180,120,8,0.9)';
      bar.style.borderRadius = '10px';
      bar.style.padding = '10px 14px';
      bar.style.boxShadow = '0 10px 25px rgba(0,0,0,.15)';
      bar.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Arial';
      bar.style.fontSize = '14px';
      bar.style.lineHeight = '1.3';
      bar.style.pointerEvents = 'none';
      document.body.appendChild(bar);
    }
    bar.textContent = msg;
    bar.style.opacity = '1';
    clearTimeout(bar.__t);
    bar.__t = setTimeout(()=>{ bar.style.opacity = '0'; }, 3000);
  }

  const warn = () => notify(MSG);

  // 1) Bloquear clique direito (menu de contexto)
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    warn();
  }, { capture: true });

  // 2) Bloquear atalhos comuns (F12, Ctrl+Shift+I/J/C/K, Meta+Alt+I, Ctrl+U/S/P)
  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const alt  = e.altKey;
    const shift= e.shiftKey;

    if (k === 'f12') { e.preventDefault(); e.stopPropagation(); return warn(); }
    if ((ctrl && shift && ['i','j','c','k'].includes(k)) || (e.metaKey && alt && k === 'i')) {
      e.preventDefault(); e.stopPropagation(); return warn();
    }
    if (ctrl && ['u','s','p'].includes(k)) {
      e.preventDefault(); e.stopPropagation(); return warn();
    }
  }, { capture: true });

  // 3) Sondagem simples de DevTools (diferença entre outer e inner window)
  let lastWarn = 0;
  setInterval(() => {
    const vwGap = Math.abs((window.outerWidth  || 0) - (window.innerWidth  || 0));
    const vhGap = Math.abs((window.outerHeight || 0) - (window.innerHeight || 0));
    const suspicious = vwGap > 160 || vhGap > 160;
    const now = Date.now();
    if (suspicious && now - lastWarn > 4000) {
      lastWarn = now;
      warn();
    }
  }, 1200);

  // 4) Opcional: desabilitar arrastar/selecionar (cuidado com UX; deixe comentado se atrapalhar)
  // document.addEventListener('dragstart', e => { e.preventDefault(); }, { capture: true });
  // document.addEventListener('selectstart', e => { e.preventDefault(); }, { capture: true });
})();
