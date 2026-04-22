// /frontend/js/atendimentos/ui/splash.js
// Splash full-screen que SÓ aparece quando há sincronização de mensagens.
// Regras:
//  - Abre em 'sync:start' OU 'ws:history_sync_start'
//  - Fecha quando todos os 'sync:done' chegarem OU em 'ws:history_sync_done'
//  - Pode ser usado manualmente com Splash.lock(scope, text)
//
// ✅ SEM CSS inline/inject
// ✅ SEM style.opacity no JS
// ✅ tudo visual fica no splash.css

(function () {
  if (window.__zcSplashLoaded) return;
  window.__zcSplashLoaded = true;

  const LOGO_SRC = "/frontend/img/carregar.png";
  const FALLBACK = "/frontend/img/wpp.png";
  const SAFETY_TIMEOUT_MS = 15000;
  const HIDE_TRANSITION_MS = 180;

  let locks = 0;
  let safetyTimer = null;
  let removeTimer = null;

  function clearTimers() {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    if (removeTimer) {
      clearTimeout(removeTimer);
      removeTimer = null;
    }
  }

  function ensureDom() {
    let el = document.getElementById("splash-screen");

    if (!el) {
      el = document.createElement("div");
      el.id = "splash-screen";
      el.innerHTML = `
        <img id="splash-logo" class="brand" src="${LOGO_SRC}" alt="zapschat">
        <p id="splash-msg" class="msg">Sincronizando…</p>
        <div class="bar-outer" aria-hidden="true">
          <div class="bar-inner"></div>
        </div>
        <p class="crypto">Protegida com a criptografia de ponta a ponta</p>
      `;
      document.body.appendChild(el);

      const img = el.querySelector("#splash-logo");
      if (img) {
        img.onerror = () => {
          img.onerror = null;
          img.src = FALLBACK;
        };
      }
    }

    return el;
  }

  function setMessage(text) {
    const msg = document.getElementById("splash-msg");
    if (msg) msg.textContent = text || "Sincronizando…";
  }

  function applyLoadingState(on) {
    document.documentElement.classList.toggle("is-loading", !!on);
    document.body.classList.toggle("is-loading", !!on);
  }

  function show(text) {
    const el = ensureDom();

    clearTimers();
    setMessage(text);
    applyLoadingState(true);

    el.classList.remove("is-hiding");

    requestAnimationFrame(() => {
      el.classList.add("is-visible");
    });

    safetyTimer = setTimeout(() => {
      hide(true);
    }, SAFETY_TIMEOUT_MS);
  }

  function hide(force) {
    if (!force && locks > 0) return;

    locks = 0;
    clearTimers();

    const el = document.getElementById("splash-screen");
    if (!el) {
      applyLoadingState(false);
      return;
    }

    el.classList.remove("is-visible");
    el.classList.add("is-hiding");

    removeTimer = setTimeout(() => {
      try { el.remove(); } catch {}
      applyLoadingState(false);
      clearTimers();
    }, HIDE_TRANSITION_MS);
  }

  window.addEventListener("sync:start", (e) => {
    locks += 1;
    show(e?.detail?.text || "Sincronizando…");
  });

  window.addEventListener("sync:done", () => {
    locks = Math.max(0, locks - 1);
    if (locks === 0) hide(false);
  });

  document.addEventListener("ws:history_sync_start", () => {
    window.dispatchEvent(
      new CustomEvent("sync:start", {
        detail: { text: "Atualizando mensagens…" },
      })
    );
  });

  document.addEventListener("ws:history_sync_done", () => {
    window.dispatchEvent(new CustomEvent("sync:done"));
  });

  window.Splash = {
    lock(text) {
      window.dispatchEvent(
        new CustomEvent("sync:start", {
          detail: { text },
        })
      );

      let released = false;
      return () => {
        if (released) return;
        released = true;
        window.dispatchEvent(new CustomEvent("sync:done"));
      };
    },

    show(text) {
      locks += 1;
      show(text);
    },

    hide() {
      hide(true);
    },
  };
})();