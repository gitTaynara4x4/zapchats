// /frontend/js/atendimentos/ui/media-render/css.js
// CSS do media-render
// - quoted/reply preview
// - imagens
// - galeria/mosaico
// - documentos
// - áudio estilo WhatsApp
// - viewer/lightbox

(function () {
  'use strict';

  const M = window.ZCMediaRender;

  if (!M || !M.__coreReady) {
    console.warn('[media-render][css] core.js precisa ser carregado antes.');
    return;
  }

  if (M.__cssReady) return;
  M.__cssReady = true;

  if (!M.require(['injectStyle'], 'css')) {
    return;
  }

  function ensureMsgMediaCss() {
    M.injectStyle('zc-media-render-css', `
      .zc-quoted-bubble{
        position:relative;
        display:flex;
        gap:8px;
        min-width:0;
        max-width:100%;
        margin:0 0 6px;
        padding:7px 9px 7px 8px;
        border-radius:8px;
        overflow:hidden;
        background:rgba(255,255,255,.08);
        cursor:pointer;
      }

      .bubble-in .zc-quoted-bubble{
        background:rgba(255,255,255,.07);
      }

      .bubble-out .zc-quoted-bubble{
        background:rgba(0,0,0,.16);
      }

      html[data-theme="light"] .zc-quoted-bubble{
        background:rgba(0,0,0,.06);
      }

      html[data-theme="light"] .bubble-out .zc-quoted-bubble{
        background:rgba(0,0,0,.10);
      }

      .zc-quoted-bar{
        width:3px;
        flex:0 0 3px;
        border-radius:8px;
        background:#53bdeb;
      }

      .bubble-out .zc-quoted-bar{
        background:#06cf9c;
      }

      .zc-quoted-content{
        min-width:0;
        flex:1 1 auto;
        overflow:hidden;
      }

      .zc-quoted-author{
        font-size:12px;
        line-height:1.2;
        font-weight:700;
        color:#53bdeb;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
        margin-bottom:2px;
      }

      .bubble-out .zc-quoted-author{
        color:#06cf9c;
      }

      .zc-quoted-text{
        font-size:12.5px;
        line-height:1.25;
        color:rgba(255,255,255,.82);
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }

      html[data-theme="light"] .zc-quoted-text{
        color:rgba(17,24,39,.76);
      }

      .msg-media-img,
      .msg-media-cell{
        display:block;
        position:relative;
        overflow:hidden;
        border-radius:8px;
        max-width:100%;
        text-decoration:none;
        background:rgba(0,0,0,.12);
      }

      .msg-media-img img,
      .msg-media-cell img{
        display:block;
        width:100%;
        max-width:320px;
        max-height:420px;
        object-fit:cover;
        border-radius:8px;
      }

      .bubble.has-media-single{
        padding:4px 4px 6px;
      }

      .bubble.has-media-single .msg-media-img img{
        max-width:330px;
      }

      .msg-sticker{
        display:block;
        max-width:170px;
        max-height:170px;
        object-fit:contain;
        background:transparent;
      }

      .msg-media-video{
        display:block;
        width:100%;
        max-width:330px;
        max-height:420px;
        border-radius:8px;
        background:#000;
      }

      .msg-media-group{
        display:grid;
        gap:2px;
        overflow:hidden;
        border-radius:8px;
        max-width:330px;
        background:rgba(0,0,0,.18);
      }

      .msg-media-group[data-count="1"]{
        grid-template-columns:1fr;
      }

      .msg-media-group[data-count="2"]{
        grid-template-columns:1fr 1fr;
      }

      .msg-media-group[data-count="3"]{
        grid-template-columns:1fr 1fr;
      }

      .msg-media-group[data-count="3"] .cell-1{
        grid-row:span 2;
      }

      .msg-media-group[data-count="4"]{
        grid-template-columns:1fr 1fr;
      }

      .msg-media-cell img{
        width:100%;
        height:160px;
        max-width:none;
        max-height:none;
        object-fit:cover;
      }

      .msg-media-group[data-count="2"] .msg-media-cell img{
        height:190px;
      }

      .msg-media-group[data-count="3"] .cell-1 img{
        height:322px;
      }

      .msg-media-more{
        position:absolute;
        inset:0;
        display:flex;
        align-items:center;
        justify-content:center;
        background:rgba(0,0,0,.45);
        color:#fff;
        font-size:30px;
        font-weight:700;
      }

      .doc-card{
        display:flex;
        align-items:center;
        gap:10px;
        min-width:240px;
        max-width:330px;
        padding:10px;
        border-radius:9px;
        background:rgba(0,0,0,.18);
      }

      html[data-theme="light"] .doc-card{
        background:rgba(0,0,0,.06);
      }

      .doc-ico{
        width:42px;
        height:48px;
        border-radius:8px;
        display:flex;
        align-items:center;
        justify-content:center;
        background:rgba(255,255,255,.12);
        flex:0 0 auto;
      }

      html[data-theme="light"] .doc-ico{
        background:rgba(0,0,0,.08);
      }

      .doc-ico .ext{
        font-size:10px;
        font-weight:800;
        letter-spacing:.4px;
      }

      .doc-body{
        min-width:0;
        flex:1 1 auto;
      }

      .doc-name{
        display:block;
        color:inherit;
        font-size:13px;
        font-weight:600;
        text-decoration:none;
        overflow:hidden;
        white-space:nowrap;
        text-overflow:ellipsis;
      }

      .doc-meta{
        margin-top:3px;
        font-size:11px;
        opacity:.68;
      }

      .doc-actions{
        display:flex;
        flex-direction:column;
        gap:4px;
        flex:0 0 auto;
      }

      .doc-btn{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        min-width:48px;
        height:24px;
        padding:0 8px;
        border-radius:999px;
        font-size:11px;
        color:inherit;
        text-decoration:none;
        background:rgba(255,255,255,.10);
      }

      html[data-theme="light"] .doc-btn{
        background:rgba(0,0,0,.07);
      }

      .wa-audio{
        --p:0%;
        display:flex;
        align-items:center;
        gap:10px;
        min-width:250px;
        max-width:330px;
        padding:8px 8px;
        border-radius:9px;
      }

      .wa-left{
        display:flex;
        align-items:center;
        gap:8px;
        flex:0 0 auto;
      }

      .wa-avatar{
        width:38px;
        height:38px;
        border-radius:50%;
        position:relative;
        overflow:hidden;
        background:rgba(255,255,255,.14);
        flex:0 0 38px;
      }

      .wa-avatar img,
      .wa-avatar .ph{
        position:absolute;
        inset:0;
        width:100%;
        height:100%;
      }

      .wa-avatar img{
        object-fit:cover;
      }

      .wa-avatar .ph{
        display:flex;
        align-items:center;
        justify-content:center;
        color:rgba(255,255,255,.68);
      }

      .wa-avatar .ph svg{
        width:23px;
        height:23px;
      }

      .wa-avatar .mic{
        position:absolute;
        right:-1px;
        bottom:-1px;
        width:16px;
        height:16px;
        border-radius:50%;
        display:flex;
        align-items:center;
        justify-content:center;
        background:#06cf9c;
        color:#071b14;
      }

      .wa-avatar .mic svg{
        width:11px;
        height:11px;
      }

      .wa-play{
        width:34px;
        height:34px;
        border:0;
        border-radius:50%;
        display:flex;
        align-items:center;
        justify-content:center;
        cursor:pointer;
        color:inherit;
        background:rgba(255,255,255,.12);
      }

      html[data-theme="light"] .wa-play{
        background:rgba(0,0,0,.08);
      }

      .wa-play svg{
        width:20px;
        height:20px;
      }

      .wa-speed{
        border:0;
        height:25px;
        min-width:42px;
        border-radius:999px;
        cursor:pointer;
        font-size:11px;
        font-weight:700;
        color:inherit;
        background:rgba(255,255,255,.12);
      }

      html[data-theme="light"] .wa-speed{
        background:rgba(0,0,0,.08);
      }

      .wa-main{
        min-width:0;
        flex:1 1 auto;
      }

      .wa-wave{
        position:relative;
        height:24px;
        cursor:pointer;
        outline:none;
      }

      .wa-wave .dots{
        position:absolute;
        left:0;
        right:0;
        top:50%;
        height:4px;
        transform:translateY(-50%);
        border-radius:999px;
        background:rgba(255,255,255,.26);
      }

      html[data-theme="light"] .wa-wave .dots{
        background:rgba(0,0,0,.18);
      }

      .wa-wave .fill{
        position:absolute;
        left:0;
        top:50%;
        width:var(--p);
        height:4px;
        transform:translateY(-50%);
        border-radius:999px;
        background:#06cf9c;
      }

      .wa-wave .knob{
        position:absolute;
        left:var(--p);
        top:50%;
        width:10px;
        height:10px;
        border-radius:50%;
        transform:translate(-50%,-50%);
        background:#06cf9c;
        box-shadow:0 1px 4px rgba(0,0,0,.25);
      }

      .wa-len{
        margin-top:1px;
        font-size:11px;
        opacity:.68;
      }

      .zc-media-viewer{
        position:fixed;
        inset:0;
        z-index:99999;
        display:none;
        color:#e9edef;
      }

      .zc-media-viewer.is-open{
        display:block;
      }

      .zc-media-viewer__backdrop{
        position:absolute;
        inset:0;
        background:rgba(11,20,26,.96);
      }

      .zc-media-viewer__top{
        position:absolute;
        z-index:2;
        top:0;
        left:0;
        right:0;
        height:58px;
        display:flex;
        align-items:center;
        justify-content:space-between;
        padding:0 18px;
        box-sizing:border-box;
        background:linear-gradient(to bottom, rgba(0,0,0,.38), rgba(0,0,0,0));
      }

      .zc-media-viewer__count{
        font-size:12px;
        opacity:.75;
      }

      .zc-media-viewer__name{
        font-size:14px;
        font-weight:600;
        max-width:65vw;
        overflow:hidden;
        white-space:nowrap;
        text-overflow:ellipsis;
      }

      .zc-media-viewer__icon-btn,
      .zc-media-viewer__nav{
        border:0;
        color:#e9edef;
        background:rgba(255,255,255,.08);
        cursor:pointer;
      }

      .zc-media-viewer__icon-btn{
        width:38px;
        height:38px;
        border-radius:50%;
        display:flex;
        align-items:center;
        justify-content:center;
      }

      .zc-media-viewer__icon-btn svg{
        width:22px;
        height:22px;
      }

      .zc-media-viewer__stage{
        position:absolute;
        inset:58px 72px 88px;
        z-index:1;
        display:flex;
        align-items:center;
        justify-content:center;
      }

      .zc-media-viewer__frame{
        width:100%;
        height:100%;
        display:flex;
        align-items:center;
        justify-content:center;
      }

      .zc-media-viewer__media-wrap{
        width:100%;
        height:100%;
        display:flex;
        align-items:center;
        justify-content:center;
      }

      .zc-media-viewer__img,
      .zc-media-viewer__video{
        max-width:100%;
        max-height:100%;
        object-fit:contain;
        border-radius:4px;
      }

      .zc-media-viewer__nav{
        position:absolute;
        z-index:2;
        top:50%;
        width:46px;
        height:46px;
        border-radius:50%;
        display:flex;
        align-items:center;
        justify-content:center;
        transform:translateY(-50%);
      }

      .zc-media-viewer__nav svg{
        width:25px;
        height:25px;
      }

      .zc-media-viewer__nav--prev{
        left:16px;
      }

      .zc-media-viewer__nav--next{
        right:16px;
      }

      .zc-media-viewer__thumbs{
        position:absolute;
        z-index:2;
        left:0;
        right:0;
        bottom:0;
        min-height:74px;
        display:flex;
        align-items:center;
        justify-content:center;
        gap:8px;
        padding:10px 16px;
        box-sizing:border-box;
        background:linear-gradient(to top, rgba(0,0,0,.45), rgba(0,0,0,0));
      }

      .zc-media-viewer__thumb{
        width:52px;
        height:52px;
        border:2px solid transparent;
        border-radius:8px;
        overflow:hidden;
        padding:0;
        cursor:pointer;
        background:rgba(255,255,255,.08);
      }

      .zc-media-viewer__thumb.is-active{
        border-color:#06cf9c;
      }

      .zc-media-viewer__thumb img{
        width:100%;
        height:100%;
        object-fit:cover;
        display:block;
      }

      .zc-media-viewer__empty{
        opacity:.75;
      }

      body.zc-media-viewer-open{
        overflow:hidden;
      }

      img[data-zc-lazy-media],
      video[data-zc-lazy-media]{
        background:#eef2f1;
      }

      img[data-zc-lazy-media]:not(.zc-lazy-loaded){
        min-height:120px;
        object-fit:cover;
      }

      .msg-sticker[data-zc-lazy-media]:not(.zc-lazy-loaded){
        width:120px;
        height:120px;
        background:#eef2f1;
        border-radius:12px;
      }

      .zc-lazy-media-host{
        position:relative;
        overflow:hidden;
      }

      .msg-media-img.zc-lazy-media-host,
      .msg-media-cell.zc-lazy-media-host{
        display:block;
        background:#eef2f1;
      }

      .zc-lazy-media-host.zc-media-loading::before,
      .zc-lazy-media-host.zc-media-failed::before{
        content:'';
        position:absolute;
        left:50%;
        top:50%;
        width:34px;
        height:34px;
        margin-left:-17px;
        margin-top:-31px;
        border-radius:999px;
        background:rgba(255,255,255,.92);
        box-shadow:0 6px 18px rgba(31,41,55,.12);
        z-index:4;
        pointer-events:none;
      }

      .zc-lazy-media-host.zc-media-loading::before{
        background:
          linear-gradient(rgba(255,255,255,.92), rgba(255,255,255,.92)) padding-box,
          conic-gradient(from 0deg, #22c55e, #d1fae5, #22c55e) border-box;
        border:3px solid transparent;
        animation:zcMediaSpin .9s linear infinite;
      }

      .zc-lazy-media-host.zc-media-failed::before{
        background:rgba(254,242,242,.96);
      }

      .zc-lazy-media-host.zc-media-loading::after,
      .zc-lazy-media-host.zc-media-failed::after{
        content:attr(data-zc-media-loading-label);
        position:absolute;
        left:50%;
        top:50%;
        transform:translate(-50%, 10px);
        max-width:82%;
        padding:6px 10px;
        border-radius:999px;
        background:rgba(255,255,255,.94);
        color:#4b5563;
        font-size:12px;
        font-weight:600;
        line-height:1.2;
        text-align:center;
        white-space:nowrap;
        box-shadow:0 6px 18px rgba(31,41,55,.10);
        z-index:4;
        pointer-events:none;
      }

      .zc-lazy-media-host.zc-media-failed::after{
        color:#b91c1c;
      }

      .zc-lazy-media-host.zc-media-loaded::before,
      .zc-lazy-media-host.zc-media-loaded::after{
        display:none;
      }

      @keyframes zcMediaSpin{
        to{ transform:rotate(360deg); }
      }

      @media (max-width:720px){
        .zc-media-viewer__stage{
          inset:58px 10px 88px;
        }

        .zc-media-viewer__nav{
          display:none !important;
        }

        .msg-media-img img,
        .bubble.has-media-single .msg-media-img img,
        .msg-media-video{
          max-width:76vw;
        }

        .doc-card,
        .wa-audio{
          max-width:76vw;
          min-width:220px;
        }
      }
    `);
  }

  M.extend({
    ensureMsgMediaCss,
  });

  console.log('[media-render] css carregado');
})();