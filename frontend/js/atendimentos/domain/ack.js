// js/atendimentos/core/env.js

// ===============================
// Identidade da empresa (frontend)
// ===============================
const rawEmpresa = (typeof localStorage !== 'undefined')
  ? localStorage.getItem('empresa_id')
  : null;

export const EMPRESA_ID = Number.parseInt(rawEmpresa, 10);

// Validação básica e fallback para login
if (!Number.isFinite(EMPRESA_ID) || EMPRESA_ID <= 0) {
  console.error('[ERRO] Empresa não definida. Redirecionando para login.');
  if (typeof window !== 'undefined' && typeof location !== 'undefined') {
    location.href = '/login';
  }
  throw new Error('Sem login, interrompendo execução');
}

// Fuso horário padrão da aplicação
export const APP_TZ = 'America/Sao_Paulo';

// ===============================
// Evolution (config do frontend)
// Lida de meta tags / window / localStorage
// ===============================
function readMeta(name) {
  try {
    if (typeof document === 'undefined') return '';
    const el = document.querySelector(`meta[name="${name}"]`);
    return (el?.getAttribute('content') || '').trim();
  } catch {
    return '';
  }
}

const fromWinENV = (p) =>
  (typeof window !== 'undefined' && window.ENV && window.ENV.EVOLUTION && window.ENV.EVOLUTION[p]) || '';

const fromWinEVO = (p) =>
  (typeof window !== 'undefined' && window.EVOLUTION && window.EVOLUTION[p]) || '';

const EVO_URL = (
  readMeta('evo-api-url') ||
  fromWinENV('apiUrl') ||
  fromWinEVO('apiUrl') ||
  ''
).replace(/\/+$/, '');

const EVO_KEY = (
  readMeta('evo-api-key') ||
  fromWinENV('apiKey') ||
  fromWinEVO('apiKey') ||
  (typeof localStorage !== 'undefined' ? localStorage.getItem('evo_api_key') : '') ||
  ''
);

const EVO_INSTANCE = (
  readMeta('evo-default-instance') ||
  fromWinENV('defaultInstance') ||
  fromWinEVO('defaultInstance') ||
  (typeof localStorage !== 'undefined' ? localStorage.getItem('evo_default_instance') : '') ||
  ''
);

// Objeto consolidado
export const EVOLUTION = Object.freeze({
  apiUrl: EVO_URL,
  apiKey: EVO_KEY,
  defaultInstance: EVO_INSTANCE,
});

// ===============================
// Bridge para scripts legados (inline/IIFEs)
// Publica EMPRESA_ID, APP_TZ e EVOLUTION no window
// ===============================
try {
  if (typeof window !== 'undefined') {
    // Garante o namespace
    window.ENV = window.ENV || {};
    window.ENV.EVOLUTION = Object.assign({}, window.ENV.EVOLUTION, EVOLUTION);

    if (typeof window.EMPRESA_ID === 'undefined') window.EMPRESA_ID = EMPRESA_ID;
    if (typeof window.APP_TZ === 'undefined') window.APP_TZ = APP_TZ;

    // Compat opcional: também expõe em window.EVOLUTION sem sobrescrever se já existir
    if (typeof window.EVOLUTION === 'undefined') {
      window.EVOLUTION = { ...EVOLUTION };
    } else {
      // Só preenche o que estiver faltando
      window.EVOLUTION.apiUrl = window.EVOLUTION.apiUrl || EVOLUTION.apiUrl;
      window.EVOLUTION.apiKey = window.EVOLUTION.apiKey || EVOLUTION.apiKey;
      window.EVOLUTION.defaultInstance = window.EVOLUTION.defaultInstance || EVOLUTION.defaultInstance;
    }
  }
} catch {
  // Ambientes sem window (SSR/tests): ignore
}
