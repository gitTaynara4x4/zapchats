// frontend/js/pages/colaboradores/api.js

import { EMPRESA_ID } from './state.js';

export function withEmpresa(url){
  try {
    const u = new URL(url, location.origin);

    if (EMPRESA_ID && !u.searchParams.has('empresa_id')) {
      u.searchParams.set('empresa_id', EMPRESA_ID);
    }

    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';

    return EMPRESA_ID && !/(\?|&)empresa_id=/.test(url)
      ? url + sep + 'empresa_id=' + EMPRESA_ID
      : url;
  }
}

export function authFetch(url, opt = {}){
  const f = (window.ZAuth && ZAuth.authFetch) ? ZAuth.authFetch : fetch;

  const headers = Object.assign(
    { Accept: 'application/json' },
    opt.headers || {},
    EMPRESA_ID ? { 'X-Empresa-Id': String(EMPRESA_ID) } : {}
  );

  return f(url, {
    credentials: 'include',
    ...opt,
    headers
  });
}

export async function parseMaybeJSON(res){
  const txt = await res.text().catch(() => '');

  try {
    return txt ? JSON.parse(txt) : null;
  } catch {
    return txt || null;
  }
}

export function throwHTTP(res, data){
  const err = new Error(
    (data && (data.detail || data.message)) ||
    res.statusText ||
    'Erro'
  );

  err.status = res.status;
  err.data = data;

  throw err;
}

export async function apiGet(path){
  const r = await authFetch(withEmpresa(path));
  const data = await parseMaybeJSON(r);

  if (!r.ok) throwHTTP(r, data);

  return data;
}

export async function apiJSON(path, method, body){
  const r = await authFetch(withEmpresa(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await parseMaybeJSON(r);

  if (!r.ok) throwHTTP(r, data);

  return data;
}

export async function apiForm(path, method, fd){
  const r = await authFetch(withEmpresa(path), {
    method,
    body: fd
  });

  const data = await parseMaybeJSON(r);

  if (!r.ok) throwHTTP(r, data);

  return data;
}