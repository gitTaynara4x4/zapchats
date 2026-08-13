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

  if (window.ZC_DISABLE_AUDIO_AVATAR === true || window.ZC_DISABLE_REMOTE_AVATARS === true || window.ZC_MODO_ULTRA_LEVE_RAM === true) {
    M.extend({
      getCurrentChatAvatarUrl: () => '',
      setAudioAvatar: () => {},
      refreshAudioAvatars: () => {},
    });
    return;
  }

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

    // Segurança: versões antigas do player podiam deixar um badge de microfone
    // dentro do avatar. Nunca mostramos badge + foto ao mesmo tempo.
    try {
      el.querySelectorAll('.wa-avatar .mic').forEach((node) => node.remove());
    } catch {}

    if (!img) return;

    const u = String(url || '').trim();

    const showFallback = () => {
      // O CSS antigo do player usa display !important tanto na foto quanto no
      // placeholder. Por isso precisamos trocar os estados também com !important.
      img.style.setProperty('display', 'none', 'important');
      img.removeAttribute('src');
      delete img.dataset.cur;
      el.dataset.avatarState = 'fallback';

      if (ph) {
        ph.style.setProperty('display', 'grid', 'important');
      }
    };

    const showPhoto = () => {
      img.style.setProperty('display', 'block', 'important');
      el.dataset.avatarState = 'photo';

      if (ph) {
        ph.style.setProperty('display', 'none', 'important');
      }
    };

    if (!u) {
      showFallback();
      return;
    }

    // Foto e placeholder são estados exclusivos: nunca aparecem juntos.
    // Os handlers precisam ser registrados ANTES de definir src, pois imagens
    // em cache podem concluir o carregamento imediatamente.
    img.onload = showPhoto;
    img.onerror = showFallback;

    if (img.dataset.cur !== u || img.getAttribute('src') !== u) {
      img.dataset.cur = u;
      img.style.setProperty('display', 'none', 'important');
      if (ph) ph.style.setProperty('display', 'grid', 'important');
      img.src = u;
    }

    // Cobre também o caso em que a imagem já estava carregada pelo cache antes
    // de o handler ser associado ou o componente foi reaproveitado no DOM.
    if (img.complete) {
      if (Number(img.naturalWidth || 0) > 0) showPhoto();
      else showFallback();
    }
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