// /frontend/assets/guard-devtools.js
(function () {
  try {
    // se já mostramos nesse tab, não faz mais nada
    if (sessionStorage.getItem('DEVGUARD_SHOWN') === '1') return;

    var shown = false;
    var THRESH = 160; // heurística pra DevTools dockado

    var timer = setInterval(checkOpen, 1000);

    function checkOpen() {
      if (shown) {
        clearInterval(timer);
        return;
      }

      var w = (window.outerWidth - window.innerWidth) > THRESH;
      var h = (window.outerHeight - window.innerHeight) > THRESH;

      // se nada indica DevTools, não faz nada
      if (!w && !h) return;

      shown = true;
      sessionStorage.setItem('DEVGUARD_SHOWN', '1');

      var msg = [
        "ATENÇÃO!",
        "Não cole códigos que você não entende no Console do navegador.",
        "Isso pode comprometer sua conta e dados.",
        "Se precisar, revise antes de executar."
      ].join(" ");

      try {
        console.warn("%c" + msg, "font-size:14px;color:#f59e0b");
      } catch {}

      // Banner leve (sem reload)
      try {
        var div = document.createElement('div');
        div.style.position = 'fixed';
        div.style.zIndex = '2147483647';
        div.style.left = '50%';
        div.style.top = '16px';
        div.style.transform = 'translateX(-50%)';
        div.style.background = '#111827';
        div.style.color = '#fde68a';
        div.style.border = '1px solid #374151';
        div.style.borderRadius = '10px';
        div.style.padding = '10px 14px';
        div.style.boxShadow = '0 6px 24px rgba(0,0,0,.35)';
        div.style.fontFamily = 'system-ui,Segoe UI,Roboto,Arial,sans-serif';
        div.textContent = "Aviso: cuidado ao colar comandos no Console do navegador.";
        document.body.appendChild(div);
        setTimeout(function(){ div.remove(); }, 8000);
      } catch {}

      // já detectou e avisou, não precisa ficar checando pra sempre
      clearInterval(timer);
    }
  } catch {}
})();
