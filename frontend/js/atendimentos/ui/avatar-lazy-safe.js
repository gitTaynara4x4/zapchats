// /frontend/js/atendimentos/ui/avatar-lazy-safe.js
// Etapa 9.14
// Avatar equilibrado estilo WhatsApp Web:
// - carrega foto só das conversas visíveis
// - baixa no máximo poucas fotos por vez
// - usa cache do navegador + memória/localStorage leve
// - não usa MutationObserver nem observa mudança de class
// - não reativa o loop que fazia o Chrome ir para GB de RAM

import { EMPRESA_ID } from '../core/env.js';

(function () {
  'use strict';

  const VERSION = 'zc-avatar-lazy-safe-v1';
  if (window.__ZC_AVATAR_LAZY_SAFE__ === VERSION) return;
  window.__ZC_AVATAR_LAZY_SAFE__ = VERSION;

  const MAX_CONCURRENT = Math.max(1, Math.min(3, Number(window.ZC_AVATAR_LAZY_CONCURRENCY || 2)));
  const FIRST_BATCH_LIMIT = Math.max(6, Math.min(30, Number(window.ZC_AVATAR_LAZY_FIRST_BATCH || 14)));
  const FAIL_TTL_MS = Math.max(5 * 60_000, Number(window.ZC_AVATAR_FAIL_TTL_MS || 24 * 60 * 60_000));
  const CACHE_TTL_MS = Math.max(5 * 60_000, Number(window.ZC_AVATAR_CACHE_TTL_MS || 12 * 60 * 60_000));

  let running = 0;
  const queue = [];
  const queuedKeys = new Set();
  const loadedUrls = new Map();
  let io = null;
  let scrollTimer = 0;

  function clean(v) {
    return String(v ?? '').trim();
  }

  function onlyDigits(v) {
    return clean(v).replace(/\D+/g, '');
  }

  function valid(v) {
    const s = clean(v);
    if (!s) return '';
    const low = s.toLowerCase();
    if (['null', 'undefined', 'nan', '0', 'all', 'todos', '*', '-'].includes(low)) return '';
    return s;
  }

  function disabled() {
    return window.ZC_DISABLE_REMOTE_AVATARS === true || window.ZC_MODO_ULTRA_LEVE_RAM === true;
  }

  function kindNorm(v) {
    const s = clean(v).toLowerCase();
    if (['g', 'grupo', 'group'].includes(s)) return 'grupo';
    return 'cliente';
  }

  function cacheKey(kind, id, inst) {
    return `zc:avatar:${kind}:${id}:${inst || '0'}`;
  }

  function failKey(kind, id, inst) {
    return `zc:avatar_fail:${kind}:${id}:${inst || '0'}`;
  }

  function getCachedUrl(key) {
    try {
      const raw = sessionStorage.getItem(key) || localStorage.getItem(key);
      if (!raw) return '';
      const obj = JSON.parse(raw);
      if (!obj || !obj.url) return '';
      if (Date.now() - Number(obj.ts || 0) > CACHE_TTL_MS) return '';
      return clean(obj.url);
    } catch {
      return '';
    }
  }

  function setCachedUrl(key, url) {
    try {
      const raw = JSON.stringify({ url, ts: Date.now() });
      sessionStorage.setItem(key, raw);
    } catch {}
  }

  function recentlyFailed(key) {
    try {
      const ts = Number(localStorage.getItem(key) || 0);
      return ts > 0 && Date.now() - ts < FAIL_TTL_MS;
    } catch {
      return false;
    }
  }

  function markFailed(key) {
    try { localStorage.setItem(key, String(Date.now())); } catch {}
  }

  function getEmpresaId() {
    const raw = Number(window.EMPRESA_ID || EMPRESA_ID || localStorage.getItem('empresa_id') || 0);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  function currentInstancia() {
    return (
      valid(window.INSTANCIA_ATIVA) ||
      valid(window.state?.instanciaAtiva) ||
      valid(window.instanciaSelecionada) ||
      valid(document.querySelector('#historico')?.dataset?.instanciaId) ||
      valid(document.querySelector('#chat-header')?.dataset?.instanciaId) ||
      ''
    );
  }

  function avatarUrlFromItem(item) {
    const ds = item?.dataset || {};
    const direct = valid(ds.avatarUrl);
    if (direct && !/^data:/i.test(direct) && direct.length < 1500) return direct;
    return '';
  }

  function itemRef(item) {
    const ds = item?.dataset || {};
    const kind = kindNorm(ds.kind || ds.conversationKind || ds.tipoConversa || (ds.isGroup === '1' ? 'grupo' : 'cliente'));
    const id = onlyDigits(ds.entityId || ds.clienteId || ds.grupoId || ds.id || '');
    const inst = valid(ds.instanciaId || ds.instancia || currentInstancia());
    if (!id) return null;
    return { kind, id, inst };
  }

  function urlForRef(ref) {
    if (!ref || !ref.id) return '';
    const qs = new URLSearchParams();
    qs.set('kind', ref.kind || 'cliente');
    const emp = getEmpresaId();
    if (emp) qs.set('empresa_id', String(emp));
    if (ref.inst) qs.set('instancia_id', String(ref.inst));
    return `/api/atendimento/avatar/${encodeURIComponent(ref.id)}?${qs.toString()}`;
  }

  function itemKey(item) {
    const ds = item?.dataset || {};
    const ck = valid(ds.conversationKey || ds.conversationId || ds.id);
    const ref = itemRef(item);
    return ck || (ref ? `${ref.kind}:${ref.id}:${ref.inst || '0'}` : '');
  }

  function ensurePlaceholder(span) {
    if (!span) return;
    if (!span.querySelector('img, i')) {
      span.classList.add('placeholder');
      span.innerHTML = '<i class="fa fa-user-circle"></i>';
    }
  }

  function setSpanImage(span, url, ref, item) {
    if (!span || !url) return;

    const current = span.querySelector('img');
    if (current && current.getAttribute('src') === url) return;

    const img = new Image();
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.dataset.entityId = String(ref?.id || '');
    img.dataset.kind = ref?.kind || 'cliente';

    img.onload = function () {
      try {
        span.classList.remove('placeholder', 'avatar-default');
        item?.classList?.add('has-avatar-loaded');
        if (item?.dataset) {
          item.dataset.avatarUrl = url;
          item.dataset.avatarLoaded = '1';
        }
      } catch {}
      syncHeaderIfActive(item, url, ref);
    };

    img.onerror = function () {
      try {
        const fk = failKey(ref?.kind || 'cliente', ref?.id || '', ref?.inst || '');
        if (ref?.id) markFailed(fk);
      } catch {}
      try {
        span.classList.add('placeholder');
        span.innerHTML = '<i class="fa fa-user-circle"></i>';
        if (item?.dataset) item.dataset.avatarLoaded = '0';
      } catch {}
    };

    span.classList.add('avatar-loading');
    img.src = url;
    span.innerHTML = '';
    span.appendChild(img);
  }

  function currentConversationKey() {
    const hist = document.querySelector('#historico');
    const head = document.querySelector('#chat-header');
    return (
      valid(hist?.dataset?.conversationKey) ||
      valid(hist?.dataset?.conversationId) ||
      valid(head?.dataset?.conversationKey) ||
      valid(head?.dataset?.conversationId) ||
      ''
    );
  }

  function syncHeaderIfActive(item, url, ref) {
    try {
      if (!item || !url) return;
      const ck = itemKey(item);
      if (!ck || ck !== currentConversationKey()) return;
      if (typeof window.zcSetHeaderAvatarSafe === 'function') {
        window.zcSetHeaderAvatarSafe({
          key: ck,
          conversation_key: ck,
          kind: ref?.kind === 'grupo' ? 'g' : 'c',
          entity_id: ref?.id,
          cliente_id: ref?.kind === 'cliente' ? ref?.id : undefined,
          grupo_id: ref?.kind === 'grupo' ? ref?.id : undefined,
          instancia_id: ref?.inst || currentInstancia(),
        }, url, item);
      }
    } catch {}
  }

  function enqueue(item, reason = 'visible') {
    try {
      if (disabled() || !item || item.dataset?.avatarLoading === '1' || item.dataset?.avatarLoaded === '1') return;

      const ref = itemRef(item);
      if (!ref) return;

      const key = itemKey(item) || `${ref.kind}:${ref.id}:${ref.inst || '0'}`;
      if (queuedKeys.has(key)) return;

      const fk = failKey(ref.kind, ref.id, ref.inst);
      if (recentlyFailed(fk)) return;

      queuedKeys.add(key);
      queue.push({ item, ref, key, reason });
      pumpQueue();
    } catch {}
  }

  function pumpQueue() {
    if (disabled()) return;
    while (running < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();
      running += 1;
      Promise.resolve(loadAvatarJob(job))
        .catch(() => {})
        .finally(() => {
          running -= 1;
          setTimeout(pumpQueue, 80);
        });
    }
  }

  async function loadAvatarJob(job) {
    const { item, ref, key } = job || {};
    if (!item || !ref || !key) return;
    queuedKeys.delete(key);

    const span = item.querySelector?.('.avatar');
    if (!span) return;

    const existingImg = span.querySelector('img');
    if (existingImg?.getAttribute('src') && !existingImg.complete) return;
    if (existingImg?.complete && existingImg.naturalWidth > 0) {
      if (item.dataset) item.dataset.avatarLoaded = '1';
      return;
    }

    item.dataset.avatarLoading = '1';

    const ck = cacheKey(ref.kind, ref.id, ref.inst);
    const direct = avatarUrlFromItem(item);
    const cached = getCachedUrl(ck);
    const url = direct || cached || urlForRef(ref);

    if (!url) {
      item.dataset.avatarLoading = '0';
      ensurePlaceholder(span);
      return;
    }

    try {
      item.dataset.avatarUrl = url;
      setCachedUrl(ck, url);
      setSpanImage(span, url, ref, item);
      loadedUrls.set(key, url);
    } finally {
      item.dataset.avatarLoading = '0';
    }
  }

  function isVisibleEnough(item) {
    try {
      const r = item.getBoundingClientRect();
      const h = window.innerHeight || document.documentElement.clientHeight || 800;
      const w = window.innerWidth || document.documentElement.clientWidth || 1200;
      return r.bottom >= -80 && r.top <= h + 160 && r.right >= 0 && r.left <= w;
    } catch {
      return true;
    }
  }

  function scanVisible(limit = FIRST_BATCH_LIMIT) {
    if (disabled()) return;
    const items = Array.from(document.querySelectorAll('#lista-clientes .cliente-item, #lista-clientes .chat-item'))
      .filter((item) => !item.matches('#lista-load-more, .load-more-item'))
      .filter((item) => item.querySelector('.avatar.placeholder, .avatar.avatar-default, .avatar:not(:has(img))'))
      .filter(isVisibleEnough)
      .slice(0, limit);

    items.forEach((item) => enqueue(item, 'scan'));
  }

  function observeList() {
    if (disabled()) return;

    const items = Array.from(document.querySelectorAll('#lista-clientes .cliente-item, #lista-clientes .chat-item'))
      .filter((item) => !item.matches('#lista-load-more, .load-more-item'));

    if ('IntersectionObserver' in window) {
      if (!io) {
        io = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              enqueue(entry.target, 'io');
              try { io.unobserve(entry.target); } catch {}
            }
          }
        }, {
          root: document.querySelector('#lista-clientes')?.parentElement || null,
          rootMargin: '180px 0px',
          threshold: 0.01,
        });
      }

      items.forEach((item) => {
        if (item.dataset?.avatarObserved === '1' || item.dataset?.avatarLoaded === '1') return;
        item.dataset.avatarObserved = '1';
        try { io.observe(item); } catch {}
      });
    }

    scanVisible(FIRST_BATCH_LIMIT);
  }

  function scheduleVisibleScan() {
    if (disabled()) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => scanVisible(16), 160);
  }

  function refFromSelectionDetail(detail) {
    const kind = kindNorm(detail?.kind || detail?.conversation_kind || detail?.cliente?.kind || detail?.cliente?.tipo_conversa || 'cliente');
    const id = onlyDigits(detail?.entity_id || detail?.cliente_id || detail?.grupo_id || detail?.cliente?.entity_id || detail?.cliente?.cliente_id || detail?.cliente?.grupo_id || detail?.cliente?.id || '');
    const inst = valid(detail?.instancia_id || detail?.cliente?.instancia_id || currentInstancia());
    if (!id) return null;
    return { kind, id, inst };
  }

  function onConversationSelected(ev) {
    if (disabled()) return;
    const detail = ev?.detail || {};
    const ref = refFromSelectionDetail(detail);
    if (!ref) return;

    const key = detail.conversation_key || detail.conversation_id || `${ref.kind === 'grupo' ? 'g' : 'c'}:${ref.id}:${ref.inst || '0'}`;
    const item = document.querySelector(`#lista-clientes [data-conversation-key="${CSS.escape(String(key))}"], #lista-clientes [data-id="${CSS.escape(String(key))}"]`);

    if (item) {
      const img = item.querySelector('.avatar img');
      const loadedUrl = img?.getAttribute('src') || item.dataset.avatarUrl || loadedUrls.get(key) || '';
      if (loadedUrl) syncHeaderIfActive(item, loadedUrl, ref);
      enqueue(item, 'selected');
      return;
    }

    const url = urlForRef(ref);
    if (url && typeof window.zcSetHeaderAvatarSafe === 'function') {
      window.zcSetHeaderAvatarSafe({
        key,
        conversation_key: key,
        kind: ref.kind === 'grupo' ? 'g' : 'c',
        entity_id: ref.id,
        cliente_id: ref.kind === 'cliente' ? ref.id : undefined,
        grupo_id: ref.kind === 'grupo' ? ref.id : undefined,
        instancia_id: ref.inst,
      }, url, null);
    }
  }

  document.addEventListener('lista:rendered', () => {
    setTimeout(observeList, 0);
  });

  window.addEventListener('zc:lista-conversas-atualizada', () => {
    setTimeout(observeList, 0);
  });

  window.addEventListener('zc:conversation-selected', onConversationSelected);

  document.addEventListener('DOMContentLoaded', () => {
    const list = document.querySelector('#lista-clientes') || document;
    try { list.addEventListener('scroll', scheduleVisibleScan, { passive: true }); } catch {}
    setTimeout(observeList, 250);
  });

  // Se o módulo entrar depois da lista já estar na tela.
  setTimeout(observeList, 300);

  window.ZCAvatarLazySafeScan = observeList;

  try {
    console.log('[ZapsChat][avatar-lazy-safe] carregado:', VERSION);
  } catch {}
})();
