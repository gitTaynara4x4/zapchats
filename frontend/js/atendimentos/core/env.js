// js/atendimentos/core/env.js

// Lê empresa_id do localStorage
const rawEmpresa = localStorage.getItem('empresa_id');
export const EMPRESA_ID = Number.parseInt(rawEmpresa, 10);

// Validação básica e fallback para login
if (!Number.isFinite(EMPRESA_ID) || EMPRESA_ID <= 0) {
  console.error('[ERRO] Empresa não definida. Redirecionando para login.');
  location.href = '/login';
  throw new Error('Sem login, interrompendo execução');
}

// Fuso horário padrão da aplicação
export const APP_TZ = 'America/Sao_Paulo';

/* ============================================================
   Bridge para scripts legados (inline/IIFEs)
   - Publica EMPRESA_ID e APP_TZ no escopo global (window)
   - Não interfere no uso por ES Modules (import/export)
   ============================================================ */
try {
  // Apenas define se ainda não existir, para evitar sobrescrita acidental
  if (typeof window !== 'undefined') {
    if (typeof window.EMPRESA_ID === 'undefined') {
      window.EMPRESA_ID = EMPRESA_ID;
    }
    if (typeof window.APP_TZ === 'undefined') {
      window.APP_TZ = APP_TZ;
    }
  }
} catch (e) {
  // Em ambientes sem window (SSR/tests), ignore
}
