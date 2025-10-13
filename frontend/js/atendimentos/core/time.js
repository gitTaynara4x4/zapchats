// frontend/js/atendimentos/core/time.js
// Utilidades de tempo/datas – ES Module

export const APP_TZ = 'America/Sao_Paulo';

// Converte timestamp “flexível” para Date
export function parseAtendimentoDate(raw) {
  const s = (raw ?? '').toString().trim();
  if (!s) return null;

  // epoch (s ou ms)
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return new Date(s.length <= 10 ? n * 1000 : n);
  }

  // normaliza " " -> "T" e corta fração > 3 dígitos
  let txt = s.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');

  // Se vier com Z/offset válido, respeita — mas trata o caso "local + Z"
  if (/[zZ]$/.test(txt)) {
    const m = txt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,3})?[zZ]$/);
    if (m) {
      const asUtc = new Date(txt);
      const asBr  = new Date(`${m[1]}T${m[2]}-03:00`);
      const now   = Date.now();
      return Math.abs(now - asBr.getTime()) < Math.abs(now - asUtc.getTime()) ? asBr : asUtc;
    }
    return new Date(txt);
  }
  if (/([+\-]\d{2}:\d{2})$/.test(txt)) return new Date(txt);

  // Sem offset → assume Brasília/SP
  return new Date(`${txt}-03:00`);
}

// Date/ISO/epoch -> millis seguro (ou null)
export function tsToMillis(ts) {
  const d = parseAtendimentoDate(ts);
  if (!d) return null;
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

// Data relativa no padrão do chat (sempre TZ Brasília)
export function formatChatTime(ts) {
  try {
    const d = parseAtendimentoDate(ts);
    if (!d || isNaN(d)) return '';

    const tz = APP_TZ;
    const fmtTime = new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz
    });
    const fmtYMD = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz
    }); // YYYY-MM-DD

    const ymdNow = fmtYMD.format(new Date());
    const ymdD   = fmtYMD.format(d);

    const toUtcMid = (ymd) => {
      const [y, m, dd] = ymd.split('-').map(Number);
      return Date.UTC(y, m - 1, dd);
    };
    const diffDays = Math.round((toUtcMid(ymdNow) - toUtcMid(ymdD)) / 86400000);

    if (diffDays === 0) return fmtTime.format(d);
    if (diffDays === 1) return 'ontem';
    if (diffDays < 7) {
      const weekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: tz }).format(d);
      return `${weekday} ${fmtTime.format(d)}`;
    }
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz
    }).format(d);
  } catch {
    return '';
  }
}
