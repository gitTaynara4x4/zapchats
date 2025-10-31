// ===== Guarda de sessão =====
(function sessionGuard() {
  const token = localStorage.getItem('token') || localStorage.getItem('access_token');
  const empresaId = localStorage.getItem('empresa_id');
  if (!token || !empresaId) location.href = '/login.html';
})();

const html = document.documentElement;

// ===== Toggle de tema =====
(function(){
  var btn = document.getElementById('themeSwitch');
  if (btn && !btn.dataset.bound){
    btn.dataset.bound = '1';
    function syncPressed(){ btn.setAttribute('aria-pressed', String(html.classList.contains('dark'))); }
    syncPressed();
    btn.addEventListener('click', function(){
      var willDark = !html.classList.contains('dark');
      html.classList.toggle('dark', willDark);
      try { localStorage.setItem('theme', willDark ? 'dark' : 'light'); } catch {}
      btn.classList.remove('t-anim'); void btn.offsetWidth; btn.classList.add('t-anim');
      setTimeout(function(){ btn.classList.remove('t-anim'); }, 580);
      syncPressed();

      // Ajuste de cor de texto do <body> no dark
      const body = document.body;
      if (willDark) {
        body.classList.add('text-gray-100');
      } else {
        body.classList.remove('text-gray-100');
      }
    });
  }
})();

// ===== Ano no rodapé =====
(function(){ try { document.getElementById('year').textContent = new Date().getFullYear(); } catch {} })();

// ===== Finalizar início =====
document.getElementById('btn-finalizar')?.addEventListener('click', () => {
  try {
    localStorage.setItem('inicio_done', '1');
    const btn = document.getElementById('btn-finalizar');
    btn.disabled = true;
    btn.textContent = 'Concluído! Redirecionando...';
    setTimeout(() => { location.href = '/dashboard.html'; }, 1000);
  } catch (e) {
    console.error(e);
    alert('Não foi possível concluir agora. Tente novamente.');
  }
});
