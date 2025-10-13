// /frontend/js/pages/atendimentos-autoopen.js
(function AutoOpenFromURL(){
  'use strict';

  const LS = localStorage;
  const $  = (s, r=document) => r.querySelector(s);

  function getQuery(){
    const u = new URL(location.href);
    const clienteId   = Number(u.searchParams.get('cliente_id') || u.searchParams.get('id') || 0);
    const instanciaId = (u.searchParams.get('instancia_id') || '').trim();
    const instancia   = (u.searchParams.get('instancia') || '').trim(); // slug opcional
    return { clienteId, inst: instanciaId || instancia || '' };
  }

  function setInstContext(inst){
    if (!inst) return;
    // state global usado por historico.js
    window.state = window.state || {};
    window.state.clienteSel = Object.assign(window.state.clienteSel || {}, { instancia_id: inst });

    // atributo no DOM (usado por outros módulos e para debug)
    const hist = $('#historico');
    if (hist) hist.dataset.instanciaId = String(inst);

    // “instância ativa” global e persistida
    window.INSTANCIA_ATIVA = inst;
    try { LS.setItem('INSTANCIA_ATIVA', String(inst)); } catch {}
  }

  function waitUntil(cond, onOk, { timeout=6000, step=60 }={}){
    const t0 = Date.now();
    (function loop(){
      if (cond()) { try { onOk(); } catch(e){ console.error(e); } return; }
      if (Date.now()-t0 > timeout) return;
      setTimeout(loop, step);
    })();
  }

  function highlightInList(id){
    const li = document.querySelector(`#lista-clientes [data-id="${id}"]`)
           || document.querySelector(`#lista-clientes [data-cliente-id="${id}"]`);
    if (!li) return;
    li.classList.add('is-active');
    try { li.scrollIntoView({ block:'nearest' }); } catch {}
  }

  document.addEventListener('DOMContentLoaded', () => {
    const { clienteId, inst } = getQuery();
    if (!clienteId) return;

    // instancia: da URL, ou do storage/cookie como fallback
    const fallbackInst = inst || LS.getItem('INSTANCIA_ATIVA') || window.INSTANCIA_ATIVA || '';
    if (fallbackInst) setInstContext(fallbackInst);

    // quando o historico estiver exposto, abre
    waitUntil(
      () => typeof window.abrirHistorico === 'function',
      () => {
        // garante que o #historico saiba qual cliente está aberto
        const hist = $('#historico');
        if (hist) hist.dataset.clienteId = String(clienteId);

        window.abrirHistorico(clienteId).then(ok => {
          if (!ok) {
            console.warn('[autoopen] abrirHistorico falhou; verifique se a API exige instancia_id.');
          } else {
            highlightInList(clienteId);
          }
        });
      }
    );
  });
})();
