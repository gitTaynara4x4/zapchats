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

function statusFallback(status){
  const code = Number(status) || 0;

  if (code === 401) return 'Sua sessão expirou. Entre novamente para continuar.';
  if (code === 403) return 'Você não possui permissão para realizar esta ação.';
  if (code === 404) return 'O recurso solicitado não foi encontrado.';
  if (code === 409) return 'Já existe um cadastro com estes dados.';
  if (code === 422) return 'Confira os dados informados.';
  if (code === 429) return 'Muitas tentativas em pouco tempo. Aguarde e tente novamente.';
  if ([502, 503, 504].includes(code)) {
    return 'O servidor está temporariamente indisponível. Tente novamente em alguns instantes.';
  }
  if (code >= 500) return 'O servidor encontrou um erro e não concluiu a operação.';

  return 'Não foi possível concluir a operação.';
}

function looksLikeHTML(text, contentType = ''){
  const value = String(text || '').trim().toLowerCase();
  const type = String(contentType || '').toLowerCase();

  return type.includes('text/html')
    || value.startsWith('<!doctype html')
    || value.startsWith('<html')
    || /<(html|head|body|style|script|svg)\b/.test(value);
}

function cleanPlainError(text){
  const cleaned = String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned.length > 320) return '';
  return cleaned;
}

export async function parseMaybeJSON(res){
  const txt = await res.text().catch(() => '');
  const contentType = res.headers?.get?.('content-type') || '';

  if (!txt) return null;

  try {
    return JSON.parse(txt);
  } catch {
    // Respostas de erro do proxy (por exemplo, a página HTML do EasyPanel)
    // nunca devem ser despejadas dentro do modal.
    if (!res.ok) {
      if (looksLikeHTML(txt, contentType)) {
        return {
          detail: statusFallback(res.status),
          code: 'upstream_html_error'
        };
      }

      return {
        detail: cleanPlainError(txt) || statusFallback(res.status),
        code: 'non_json_error'
      };
    }

    return txt;
  }
}

export function throwHTTP(res, data){
  const detail = data && typeof data === 'object'
    ? (data.detail || data.message)
    : null;

  const err = new Error(detail || statusFallback(res.status) || res.statusText || 'Erro');
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
