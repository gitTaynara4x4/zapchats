// /frontend/js/atendimentos/ui/media-render/urls.js
// URLs e nomes de arquivo do media-render
// - empresa_id
// - instância ativa em query string
// - URL canônica por msg_id
// - resolução de URLs alternativas da mídia
// - extensão/nome final para documentos e mídias

(function () {
  'use strict';

  const M = window.ZCMediaRender;

  if (!M || !M.__coreReady) {
    console.warn('[media-render][urls] core.js precisa ser carregado antes.');
    return;
  }

  if (M.__urlsReady) return;
  M.__urlsReady = true;

  const REQUIRED = [
    'basenameFromUrl',
    'sanitizeBase',
    'currentEmpresaId',
  ];

  if (!M.require(REQUIRED, 'urls')) {
    return;
  }

  const {
    basenameFromUrl,
    sanitizeBase,
    currentEmpresaId,
  } = M;

  function empId() {
    return currentEmpresaId();
  }

  /*
    Mantém compatibilidade com o nome antigo.
  */
  function _empId() {
    return empId();
  }

  function instQ() {
    try {
      if (typeof window._instQuery === 'function') {
        return window._instQuery() || '';
      }

      const inst =
        window.INSTANCIA_ATIVA ??
        window.state?.clienteSel?.instancia_id ??
        window.clienteSel?.instancia_id ??
        document.getElementById('historico')?.dataset?.instanciaId ??
        null;

      if (!inst) return '';

      const s = String(inst).trim();

      if (!s) return '';

      return /^\d+$/.test(s)
        ? `&instancia_id=${encodeURIComponent(s)}`
        : `&instance=${encodeURIComponent(s)}`;
    } catch {
      return '';
    }
  }

  /*
    Mantém compatibilidade com o nome antigo.
  */
  function _instQ() {
    return instQ();
  }

  function applyInstToQS(qs, instQuery) {
    if (!qs) return;

    const raw = String(instQuery || '').trim();

    if (!raw) return;

    const s = raw
      .replace(/^\?/, '')
      .replace(/^\&/, '');

    s.split('&')
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((pair) => {
        const i = pair.indexOf('=');
        const k = i >= 0 ? pair.slice(0, i) : pair;
        const v = i >= 0 ? pair.slice(i + 1) : '';

        if (k) {
          qs.set(k, v);
        }
      });
  }

  /*
    Mantém compatibilidade com o nome antigo.
  */
  function _applyInstToQS(qs, instQuery) {
    return applyInstToQS(qs, instQuery);
  }

  function buildCanonUrlByMsgId(msgId) {
    const id = String(msgId || '').trim();

    if (!id) return '';

    const base = `/api/atendimento/midias/msg/${encodeURIComponent(id)}`;
    const qs = new URLSearchParams();

    const eid = empId();

    if (eid) {
      qs.set('empresa_id', String(eid));
    }

    applyInstToQS(qs, instQ());

    const q = qs.toString();

    return q ? `${base}?${q}` : base;
  }

  function resolveUrlsForMedia(m, a) {
    const msgId = m?.msg_id || m?.msgId || m?.message_id || m?.messageId || '';
    const msgCanon = msgId ? buildCanonUrlByMsgId(msgId) : null;

    const qs = new URLSearchParams();
    const eid = empId();

    if (eid) {
      qs.set('empresa_id', String(eid));
    }

    applyInstToQS(qs, instQ());

    const q = qs.toString();

    const idUrl = a?.id
      ? `/api/atendimento/midias/${encodeURIComponent(String(a.id))}${q ? `?${q}` : ''}`
      : '';

    const primary =
      msgCanon ||
      a?.url_api ||
      a?.url ||
      a?.link ||
      a?.path ||
      idUrl ||
      '';

    const alts = [];

    if (msgCanon) {
      [
        a?.url_api,
        a?.url,
        a?.link,
        a?.path,
        idUrl,
      ].forEach((u) => {
        if (u) alts.push(u);
      });
    }

    const seen = new Set();

    return [primary, ...alts].filter((u) => {
      const s = String(u || '').trim();

      if (!s || seen.has(s)) return false;

      seen.add(s);
      return true;
    });
  }

  function guessExt({
    mimetype = '',
    filename = '',
    url = '',
  } = {}) {
    const fromName =
      String(filename || '')
        .split('.')
        .pop()
        ?.toLowerCase() ||
      basenameFromUrl(url)
        .split('.')
        .pop()
        ?.toLowerCase() ||
      '';

    const map = {
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.ms-powerpoint': 'ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'text/plain': 'txt',

      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',

      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'audio/webm': 'webm',
      'audio/mp4': 'm4a',

      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
    };

    const mime = String(mimetype || '').toLowerCase();

    return (map[mime] || fromName || 'bin').toLowerCase();
  }

  /*
    Mantém compatibilidade com o nome antigo.
  */
  function _guessExt(opts = {}) {
    return guessExt(opts);
  }

  function deriveFileName(a = {}) {
    const url =
      a.url ||
      a.link ||
      a.path ||
      a.url_api ||
      '';

    const baseRaw =
      a.filename ||
      a.name ||
      a.nome_original ||
      a.fileName ||
      basenameFromUrl(url) ||
      'arquivo';

    const base = sanitizeBase(
      String(baseRaw).replace(/\.[a-z0-9]{1,8}$/i, '')
    );

    const ext = guessExt({
      mimetype: a.mimetype || a.mime || '',
      filename: a.filename || a.name || a.fileName || '',
      url,
    });

    return {
      fileName: `${base}.${ext}`,
      extUp: ext.toUpperCase(),
      extLower: ext.toLowerCase(),
    };
  }

  M.extend({
    empId,
    _empId,

    instQ,
    _instQ,

    applyInstToQS,
    _applyInstToQS,

    buildCanonUrlByMsgId,
    resolveUrlsForMedia,

    guessExt,
    _guessExt,

    deriveFileName,
  });

  console.log('[media-render] urls carregado');
})();