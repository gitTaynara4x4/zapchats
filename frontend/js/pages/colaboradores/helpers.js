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
  const text = String(name || '').trim();
  const firstValid = Array.from(text).find(char => /[A-Za-zÀ-ÖØ-öø-ÿ0-9]/.test(char));

  return firstValid ? firstValid.toUpperCase() : '?';
}

export function avatarTone(seed){
  const palette = [
    '#1A73E8',
    '#188038',
    '#9334E6',
    '#D93025',
    '#E37400',
    '#007B83',
    '#5F6368',
    '#C5221F',
    '#3F51B5',
    '#00897B',
    '#8E24AA',
    '#F4511E'
  ];

  seed = String(seed || 'ZapsChat');

  let hash = 0;

  for (let i = 0; i < seed.length; i++){
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }

  const bg = palette[Math.abs(hash) % palette.length];

  return {
    bg,
    fg: '#FFFFFF',
    ring: bg
  };
}

export function hashColor(seed){
  return avatarTone(seed).bg;
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