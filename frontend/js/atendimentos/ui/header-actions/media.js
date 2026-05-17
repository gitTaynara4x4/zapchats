// /frontend/js/atendimentos/ui/header-actions/media.js
// Helpers de mídia do header-actions
// - Descobrir mimetype por extensão
// - Descobrir tipo de mídia para Evolution/API
// - Extrair nome de arquivo pela URL
// - Converter Blob/File para DataURL
// - Limpar DataURL para base64 puro
// - Buscar Blob de uma mídia já renderizada

(function () {
  'use strict';

  const H = window.ZCHeaderActions;

  if (!H || !H.__coreReady) {
    console.warn('[header-actions][media] core.js precisa ser carregado antes.');
    return;
  }

  if (H.__mediaReady) return;
  H.__mediaReady = true;

  function guessMimeFromExt(name) {
    const ext = String(name || '')
      .split('.')
      .pop()
      ?.toLowerCase() || '';

    switch (ext) {
      case 'pdf':
        return 'application/pdf';

      case 'doc':
        return 'application/msword';

      case 'docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

      case 'xls':
        return 'application/vnd.ms-excel';

      case 'xlsx':
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

      case 'ppt':
        return 'application/vnd.ms-powerpoint';

      case 'pptx':
        return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

      case 'png':
        return 'image/png';

      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';

      case 'webp':
        return 'image/webp';

      case 'gif':
        return 'image/gif';

      case 'mp4':
        return 'video/mp4';

      case 'mp3':
        return 'audio/mpeg';

      case 'ogg':
        return 'audio/ogg';

      case 'wav':
        return 'audio/wav';

      case 'txt':
        return 'text/plain';

      default:
        return 'application/octet-stream';
    }
  }

  function guessMediaType(mime) {
    const value = String(mime || '').toLowerCase();

    if (!value) return 'document';
    if (value.startsWith('image/')) return 'image';
    if (value.startsWith('video/')) return 'video';
    if (value.startsWith('audio/')) return 'audio';

    return 'document';
  }

  function nameFromUrl(url) {
    try {
      const u = new URL(url, window.location.origin);
      const last = decodeURIComponent(
        String(u.pathname || '')
          .split('/')
          .pop() || ''
      ).trim();

      return last || 'arquivo';
    } catch {
      return 'arquivo';
    }
  }

  function blobToDataUrl(fileOrBlob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();

      fr.onload = () => {
        resolve(fr.result);
      };

      fr.onerror = () => {
        reject(fr.error || new Error('Não foi possível ler o arquivo.'));
      };

      fr.readAsDataURL(fileOrBlob);
    });
  }

  function cleanDataUrl(s) {
    if (!s) return '';

    const raw = String(s || '');
    const i = raw.indexOf(',');

    return i >= 0
      ? raw.slice(i + 1).trim()
      : raw.trim();
  }

  async function fetchBlobFromUrl(url) {
    const finalUrl = String(url || '').trim();

    if (!finalUrl) {
      throw new Error('URL da mídia inválida para encaminhar.');
    }

    const resp = await fetch(finalUrl, {
      credentials: 'include',
    });

    if (!resp.ok) {
      throw new Error('Não foi possível ler a mídia original para encaminhar.');
    }

    return resp.blob();
  }

  H.extend({
    guessMimeFromExt,
    guessMediaType,
    nameFromUrl,
    blobToDataUrl,
    cleanDataUrl,
    fetchBlobFromUrl,
  });

  console.log('[header-actions] media carregado');
})();