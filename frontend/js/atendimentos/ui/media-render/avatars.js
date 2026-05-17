// /frontend/js/atendimentos/ui/media-render/avatars.js
// Avatar usado no player de áudio estilo WhatsApp
// - Busca avatar do cliente/conversa atual
// - Evita usar avatar de outro cliente
// - Aplica avatar nos players .wa-audio[data-dir="in"]

(function () {
  'use strict';

  const M = window.ZCMediaRender;

  if (!M || !M.__coreReady) {
    console.warn('[media-render][avatars] core.js precisa ser carregado antes.');
    return;
  }

  if (M.__avatarsReady) return;
  M.__avatarsReady = true;

  const AVATAR_SELS = [
    '#chat-avatar img[data-cliente-id]',
    '#chat-avatar img',
    '#chat-header #chat-avatar img',
  ];

  function qAny(sels) {
    for (let i = 0; i < sels.length; i += 1) {
      const el = document.querySelector(sels[i]);

      if (el) {
        return el;
      }
    }

    return null;
  }

  /*
    Mantém compatibilidade com o nome antigo.
  */
  function _qAny(sels) {
    return qAny(sels);
  }

  function currentClienteId() {
    const s = window.state?.clienteSel || window.clienteSel || {};

    const cid =
      s.id ??
      s.cliente_id ??
      s.entity_id ??
      s.backend_id ??
      null;

    return cid == null ? '' : String(cid);
  }

  /*
    Mantém compatibilidade com o nome antigo.
  */
  function _currentClienteId() {
    return currentClienteId();
  }

  function getCurrentChatAvatarUrl() {
    const sel = window.state?.clienteSel || window.clienteSel || {};

    const u1 =
      sel.avatar_url ||
      sel.avatarUrl ||
      sel.foto_url ||
      sel.fotoUrl ||
      sel.profile_pic_url ||
      sel.profilePicUrl ||
      '';

    if (u1) {
      return String(u1);
    }

    const img = qAny(AVATAR_SELS);
    const src = img?.getAttribute('src') || img?.src || '';

    if (!src || /^data:\s*$/i.test(src)) {
      return '';
    }

    /*
      Proteção importante:
      Se a imagem do header ainda estiver com data-cliente-id de outro cliente,
      não usa essa foto no áudio atual.
    */
    const curCid = currentClienteId();

    const imgCid =
      img?.getAttribute('data-cliente-id') ||
      img?.dataset?.clienteId ||
      '';

    if (curCid && imgCid && String(imgCid) !== String(curCid)) {
      return '';
    }

    return String(src);
  }

  function setAudioAvatar(el, url) {
    if (!el) return;

    const img = el.querySelector('.wa-avatar img');
    const ph = el.querySelector('.wa-avatar .ph');

    if (!img) return;

    const u = String(url || '').trim();

    if (!u) {
      img.removeAttribute('src');
      delete img.dataset.cur;

      if (ph) {
        ph.style.display = '';
      }

      return;
    }

    if (img.dataset.cur === u) {
      return;
    }

    img.dataset.cur = u;
    img.src = u;

    img.onload = () => {
      if (ph) {
        ph.style.display = 'none';
      }
    };

    img.onerror = () => {
      img.removeAttribute('src');
      delete img.dataset.cur;

      if (ph) {
        ph.style.display = '';
      }
    };
  }

  function refreshAudioAvatars(root) {
    const url = getCurrentChatAvatarUrl();

    if (!url) return;

    (root || document)
      .querySelectorAll('.wa-audio[data-dir="in"]')
      .forEach((el) => {
        setAudioAvatar(el, url);
      });
  }

  M.extend({
    AVATAR_SELS,

    qAny,
    _qAny,

    currentClienteId,
    _currentClienteId,

    getCurrentChatAvatarUrl,
    setAudioAvatar,
    refreshAudioAvatars,
  });

  console.log('[media-render] avatars carregado');
})();