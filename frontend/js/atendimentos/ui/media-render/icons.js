// /frontend/js/atendimentos/ui/media-render/icons.js
// Ícones SVG usados pelo media-render
// - play/pause do áudio
// - fechar viewer
// - setas do viewer/lightbox

(function () {
  'use strict';

  const M = window.ZCMediaRender;

  if (!M || !M.__coreReady) {
    console.warn('[media-render][icons] core.js precisa ser carregado antes.');
    return;
  }

  if (M.__iconsReady) return;
  M.__iconsReady = true;

  function playIconSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M8 5v14l12-7-12-7Z"></path>
      </svg>
    `;
  }

  function pauseIconSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M7 5h4v14H7zM13 5h4v14h-4z"></path>
      </svg>
    `;
  }

  function closeIconSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M6 6l12 12M18 6 6 18"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
        />
      </svg>
    `;
  }

  function chevronLeftSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M15 18 9 12l6-6"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  function chevronRightSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="m9 18 6-6-6-6"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  /*
    Compatibilidade com os nomes antigos do arquivo monolítico.
  */
  function _playIconSvg() {
    return playIconSvg();
  }

  function _pauseIconSvg() {
    return pauseIconSvg();
  }

  function _closeIconSvg() {
    return closeIconSvg();
  }

  function _chevronLeftSvg() {
    return chevronLeftSvg();
  }

  function _chevronRightSvg() {
    return chevronRightSvg();
  }

  M.extend({
    playIconSvg,
    pauseIconSvg,
    closeIconSvg,
    chevronLeftSvg,
    chevronRightSvg,

    _playIconSvg,
    _pauseIconSvg,
    _closeIconSvg,
    _chevronLeftSvg,
    _chevronRightSvg,
  });

  console.log('[media-render] icons carregado');
})();