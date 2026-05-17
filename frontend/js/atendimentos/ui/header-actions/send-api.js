// /frontend/js/atendimentos/ui/header-actions/send-api.js
// API de envio usada pelo header-actions
// - fetchJsonOrThrow()
// - sendTextToConversation()
// - sendBlobToConversation()

(function () {
  'use strict';

  const H = window.ZCHeaderActions;

  if (!H || !H.__coreReady) {
    console.warn('[header-actions][send-api] core.js precisa ser carregado antes.');
    return;
  }

  if (H.__sendApiReady) return;
  H.__sendApiReady = true;

  const REQUIRED = [
    'stripUndefined',
    'stringifyErr',
    'numberForApi',
    'getInstPayload',
    'getIdentityPayload',
    'guessMimeFromExt',
    'guessMediaType',
    'blobToDataUrl',
    'cleanDataUrl',
  ];

  if (!H.require(REQUIRED, 'send-api')) {
    return;
  }

  const {
    stripUndefined,
    stringifyErr,
    numberForApi,
    getInstPayload,
    getIdentityPayload,
    guessMimeFromExt,
    guessMediaType,
    blobToDataUrl,
    cleanDataUrl,
  } = H;

  async function fetchJsonOrThrow(url, payload) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(payload),
    });

    const respText = await r.text().catch(() => '');

    let respJson = null;

    try {
      respJson = respText ? JSON.parse(respText) : null;
    } catch {}

    if (!r.ok) {
      const rawMsg =
        (respJson && (respJson.detail ?? respJson.message ?? respJson.error)) ||
        respText ||
        null;

      const msg =
        stringifyErr(rawMsg) ||
        (
          r.status === 400
            ? 'Dados inválidos (destino ou instância).'
            : 'Falha ao enviar.'
        );

      throw new Error(msg);
    }

    return respJson || {};
  }

  async function sendTextToConversation(targetConversation, text) {
    const dest = numberForApi(targetConversation);
    const inst = getInstPayload(targetConversation);

    if (!dest) {
      throw new Error('Destino inválido para encaminhar.');
    }

    if (!inst.instancia_id && !inst.instance) {
      throw new Error('Instância não selecionada para a conversa destino.');
    }

    const payload = stripUndefined({
      empresa_id: H.EMPRESA_ID || undefined,
      ...getIdentityPayload(targetConversation),
      number: dest,
      text,
      ...inst,
    });

    return fetchJsonOrThrow('/api/atendimento/send/text', payload);
  }

  async function sendBlobToConversation(
    targetConversation,
    blob,
    {
      fileName,
      mimeType,
      mediaType,
      caption,
    } = {}
  ) {
    const dest = numberForApi(targetConversation);
    const inst = getInstPayload(targetConversation);

    if (!dest) {
      throw new Error('Destino inválido para encaminhar.');
    }

    if (!inst.instancia_id && !inst.instance) {
      throw new Error('Instância não selecionada para a conversa destino.');
    }

    if (!blob) {
      throw new Error('Arquivo inválido para encaminhar.');
    }

    const finalMime =
      mimeType ||
      blob.type ||
      guessMimeFromExt(fileName || '');

    const finalType =
      mediaType ||
      guessMediaType(finalMime);

    const dataUrl = await blobToDataUrl(blob);
    const base64 = cleanDataUrl(dataUrl);

    if (!base64) {
      throw new Error('Não foi possível preparar a mídia para envio.');
    }

    if (finalType === 'audio') {
      const payload = stripUndefined({
        empresa_id: H.EMPRESA_ID || undefined,
        ...getIdentityPayload(targetConversation),
        number: dest,
        audio: base64,
        ...inst,
      });

      return fetchJsonOrThrow('/api/atendimento/send/audio', payload);
    }

    const payload = stripUndefined({
      empresa_id: H.EMPRESA_ID || undefined,
      ...getIdentityPayload(targetConversation),
      number: dest,
      media: base64,
      mediatype: finalType,
      mimetype: finalMime,
      fileName: fileName || undefined,
      caption: caption || undefined,
      ...inst,
    });

    return fetchJsonOrThrow('/api/atendimento/send/media', payload);
  }

  H.extend({
    fetchJsonOrThrow,
    sendTextToConversation,
    sendBlobToConversation,
  });

  console.log('[header-actions] send-api carregado');
})();