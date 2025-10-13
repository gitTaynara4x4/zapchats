// js/atendimentos/core/format.js
export function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[ch]));
}

export function onlyDigits(s) { return (s || '').replace(/\D/g, ''); }

export function numeroE164(n) {
  if (!n) return '';
  let d = onlyDigits(n);
  if (!d.startsWith('55')) d = '55' + d;
  return d;
}

export function formatarNumeroBR(numero) {
  if (!numero) return '';
  let n = onlyDigits(numero);
  if (!n.startsWith('55')) n = '55' + n;
  n = n.slice(0, 14);
  const ddd = n.slice(2, 4), resto = n.slice(4);
  if (resto.length === 9 && resto[0] === '9') return `+55 ${ddd} ${resto.slice(0, 5)}-${resto.slice(5)}`;
  if (resto.length === 8) return `+55 ${ddd} ${resto.slice(0, 4)}-${resto.slice(4)}`;
  return `+55 ${ddd} ${resto}`;
}

export function badge(q) {
  const n = Number(q);
  return n > 0 ? `<span class="badge">${n}</span>` : '';
}

// marcador do preview para mensagens de mídia
export const MARKER_RE =
  /^\[(Imagem|Vídeo|Video|Áudio\/ptt|Áudio|Audio|Documento|Figurinha|Localização|Contatos?|M[íi]dia)\](?:\s.*)?$/i;
