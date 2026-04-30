// frontend/js/pages/colaboradores/helpers.js

export function releasePageLoader(){
  try { window.ready?.(); } catch {}
  try { window.Page?.ready?.(); } catch {}

  try {
    document.documentElement.classList.remove('prepaint');
    document.documentElement.setAttribute('data-head-ready', '1');
    document.documentElement.setAttribute('data-loader-ready', '1');
  } catch {}
}

export function debounce(fn, ms = 160){
  let t;

  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function normStr(s){
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function digits(s){
  return String(s || '').replace(/\D+/g, '');
}

export function maskPhoneBR(v){
  let d = digits(v).slice(0, 11);
  const dd = d.slice(0, 2);
  const n = d.slice(2);

  if (!d.length) return '';

  if (d.length <= 10){
    if (n.length > 4) return `(${dd}) ${n.slice(0,4)}-${n.slice(4)}`;
    if (n.length) return `(${dd}) ${n}`;
    return dd ? `(${dd}` : '';
  }

  return `(${dd}) ${n[0]} ${n.slice(1,5)}-${n.slice(5)}`;
}

export function telE164(v){
  const d = digits(v || '');
  if (!d) return '';
  if (d.startsWith('55')) return `+${d}`;
  return `+55${d}`;
}

export function maskPhoneDisplay(v){
  const d = digits(v || '');
  if (!d) return '—';

  const dd = d.slice(0, 2);
  const n = d.slice(2);

  return n.length <= 8
    ? `(${dd}) ${n.slice(0,4)}-${n.slice(4)}`
    : `(${dd}) ${n[0]} ${n.slice(1,5)}-${n.slice(5)}`;
}

export function maskTimeInput(el){
  if (!el) return;

  let v = String(el.value || '').replace(/[^\d]/g, '');

  if (v.length > 4) v = v.slice(0, 4);
  if (v.length >= 3) v = v.slice(0, 2) + ':' + v.slice(2);

  el.value = v;
}

export function isValidTimeHHMM(str){
  if (!str) return false;

  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str).trim());
  if (!m) return false;

  const h = Number(m[1]);
  const mm = Number(m[2]);

  return h >= 0 && h <= 23 && mm >= 0 && mm <= 59;
}

export function timeToMinutes(str){
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str).trim());
  if (!m) return null;

  const h = Number(m[1]);
  const mm = Number(m[2]);

  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;

  return h * 60 + mm;
}

export function initials(name){
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);

  if (!parts.length) return 'AZ';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function hashColor(seed){
  seed = String(seed || '');

  let h = 0;

  for (let i = 0; i < seed.length; i++){
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }

  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 35% 40%)`;
}

export function chip(text){
  const s = document.createElement('span');
  s.className = 'chip';
  s.textContent = text;
  return s;
}

export function replaceExt(name, ext){
  return (name || 'avatar').replace(/\.[^.]+$/, '') + ext;
}