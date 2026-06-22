// js/atendimentos/core/cache.js
import { EMPRESA_ID } from './env.js';

const CACHE_NS = `atend:${EMPRESA_ID}`;
const nowMs = () => Date.now();
const cacheKey = (key) => `${CACHE_NS}:${key}`;

export function cacheGet(key) {
  try {
    const raw = localStorage.getItem(cacheKey(key));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj.exp && obj.exp < nowMs()) {
      localStorage.removeItem(cacheKey(key));
      return null;
    }
    return obj.val;
  } catch {
    return null;
  }
}

export function cacheSet(key, val, ttlMs = null) {
  try {
    const exp = ttlMs ? nowMs() + ttlMs : 0;
    const fullKey = cacheKey(key);
    const raw = JSON.stringify({ exp, val });

    // Proteção de RAM: localStorage gigante trava o Chrome ao abrir o app.
    // Histórico/cache pesado deve ficar no banco; no navegador só cache leve.
    const maxBytes = Number(window.ZC_LOCALSTORAGE_MAX_BYTES || 900000);
    const isHistoryLike = String(key || '').includes('hist:') || String(key || '').includes('cursor:');

    if (isHistoryLike && raw.length > maxBytes) {
      try { localStorage.removeItem(fullKey); } catch {}
      return;
    }

    localStorage.setItem(fullKey, raw);
  } catch {}
}

export function cacheDel(key) {
  try { localStorage.removeItem(cacheKey(key)); } catch {}
}

export async function fetchWithCache(url, { ttlMs = 60000, key = url, bust = false } = {}) {
  if (!bust) {
    const hit = cacheGet(key);
    if (hit !== null) return hit;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  let data;
  if (ct.includes('application/json')) data = await r.json();
  else {
    const txt = await r.text();
    try { data = JSON.parse(txt); } catch { data = txt; }
  }
  cacheSet(key, data, ttlMs);
  return data;
}

// integração com o store (persist do estado em um único lugar)
export function attachSalvarCache(fn) { window.__salvarCache = fn; }
export function salvarCache() { try { window.__salvarCache?.(); } catch {} }
