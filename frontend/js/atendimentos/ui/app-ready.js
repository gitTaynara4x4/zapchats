// /frontend/js/atendimentos/ui/app-ready.js
// Agregador de prontidão. Controle central para saber quando o app está 100% pronto.
//
// Como usar em outros módulos:
//   AppReady.mark('boot')
//   AppReady.mark('clientes')
//   AppReady.mark('instancias')
//   AppReady.mark('ws')
//   AppReady.mark('ui')
//
// Você também pode emitir eventos genéricos (sem importar nada):
//   window.dispatchEvent(new CustomEvent('ready:part', { detail: 'clientes' }));

(function () {
  if (window.AppReady) return;

  const REQUIRED_DEFAULT = ['boot', 'clientes', 'instancias', 'ws', 'ui'];

  const state = {
    required: new Set(REQUIRED_DEFAULT),
    done: new Set(),
    firedReady: false,
  };

  function setRequired(keys) {
    const arr = Array.isArray(keys) ? keys : REQUIRED_DEFAULT;
    state.required = new Set(arr);
    // reset de estado (opcional)
    state.done.forEach(k => { if (!state.required.has(k)) state.done.delete(k); });
    _emitProgress();
    _checkReady();
  }

  function mark(key) {
    if (!key) return;
    state.done.add(String(key));
    _emitProgress();
    _checkReady();
  }

  function isReady() {
    for (const k of state.required) if (!state.done.has(k)) return false;
    return true;
  }

  function progress() {
    const missing = [...state.required].filter(k => !state.done.has(k));
    return {
      total: state.required.size,
      done: state.done.size,
      missing,
      ready: isReady(),
    };
  }

  function _emitProgress() {
    window.dispatchEvent(new CustomEvent('ready:progress', { detail: progress() }));
  }

  function _checkReady() {
    if (!state.firedReady && isReady()) {
      state.firedReady = true;
      window.dispatchEvent(new Event('app:ready'));
    }
  }

  // Atalho: também aceita eventos prontos via window
  window.addEventListener('ready:part', (e) => {
    if (!e || !e.detail) return;
    mark(String(e.detail));
  });

  window.AppReady = { setRequired, mark, isReady, progress };
})();
