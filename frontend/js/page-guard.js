// /frontend/js/page-guard.js
(function (global) {
  'use strict';

  /**
   * Page.guarded
   * @param {string|{any?:string[], all?:string[]}} perm  ex.: 'dashboard.ver' ou { any:['a','b'] } ou { all:['a','b'] }
   * @param {Function} initFn     Função que inicializa a página (roda só se tiver permissão)
   * @param {Object}   [opt]
   * @param {string}   [opt.loading='Carregando…']  Texto do loader local (usa PageLoading/Loading se existir)
   * @param {Function} [opt.onDeny]  Callback opcional pra negar (se não passar, usa deny padrão + redirect)
   */
  function guarded(perm, initFn, opt) {
    var options = Object.assign({ loading: 'Carregando…' }, opt || {});
    var ran = false;

    function showLoader(msg){
      try {
        if (global.PageLoading?.show) return PageLoading.show(msg, { scope: '.main' });
        if (global.Loading?.show)     return Loading.show(msg);
      } catch {}
    }
    function hideLoader(){
      try {
        if (global.PageLoading?.hide) return PageLoading.hide();
        if (global.Loading?.hide)     return Loading.hide();
      } catch {}
    }

    // --------- FETCH PERMISSIONS COM FALLBACK ---------
    async function fetchPerms(){
      // 1) Se houver ZAuth.getPerms, usa ele primeiro
      if (global.ZAuth?.getPerms) {
        try {
          const p = await ZAuth.getPerms();
          if (Array.isArray(p)) return p.map(String);
          if (p && Array.isArray(p.permissoes)) return p.permissoes.map(String);
        } catch (e) {
          console.warn('[Page.guard] ZAuth.getPerms falhou, tentando backend direto…', e);
        }
      }

      // 2) Tenta /api/permissoes/minhas
      try {
        const f = (global.ZAuth?.authFetch) ? ZAuth.authFetch : fetch;
        const r = await f('/api/permissoes/minhas', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data)) return data.map(String);
          if (data && Array.isArray(data.permissoes)) return data.permissoes.map(String);
        } else {
          console.warn('[Page.guard] /api/permissoes/minhas -> HTTP', r.status);
        }
      } catch (e) {
        console.warn('[Page.guard] Erro em /api/permissoes/minhas, usando /api/auth/me como fallback…', e);
      }

      // 3) Fallback final: /api/auth/me (que a gente já sabe que está certo)
      try {
        const f2 = (global.ZAuth?.authFetch) ? ZAuth.authFetch : fetch;
        const r2 = await f2('/api/auth/me', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        if (r2.ok) {
          const me = await r2.json();
          const arr =
            (Array.isArray(me.permissoes) ? me.permissoes :
            (Array.isArray(me.permissions) ? me.permissions : []));
          return arr.map(String);
        } else {
          console.warn('[Page.guard] /api/auth/me -> HTTP', r2.status);
        }
      } catch (e) {
        console.warn('[Page.guard] Erro em /api/auth/me, sem conseguir carregar permissões.', e);
      }

      // Se tudo falhar, volta lista vazia
      return [];
    }

    // --------- NORMALIZA REQUISITO ---------
    function normalizeNeed(perm){
      var needAny = [], needAll = [];
      if (typeof perm === 'string') {
        needAll = [perm];
      } else if (perm && typeof perm === 'object') {
        needAny = Array.isArray(perm.any) ? perm.any : [];
        needAll = Array.isArray(perm.all) ? perm.all : [];
      }
      return { needAny, needAll };
    }

    function check(perms, need){
      var needAny = need.needAny;
      var needAll = need.needAll;
      if (needAll.length && !needAll.every(function (p){ return perms.includes(p); })) return false;
      if (needAny.length && !needAny.some(function (p){ return perms.includes(p); }))  return false;
      if (!needAll.length && !needAny.length) return true; // sem requisito
      return true;
    }

    async function ensure() {
      const need = normalizeNeed(perm);

      try {
        showLoader(options.loading);

        // 1ª tentativa: se ZAuth.ensurePerm existir, usa, mas NÃO derruba tudo se falhar
        if (global.ZAuth?.ensurePerm) {
          try {
            await ZAuth.ensurePerm(perm); // deve lançar se negar
            return true;
          } catch (e) {
            console.warn('[Page.guard] ZAuth.ensurePerm negou ou falhou, caindo no fallback manual…', e);
            // cai pro fallback abaixo
          }
        }

        // Fallback: busca permissões e checa na mão
        const perms = await fetchPerms();
        const ok = check(perms, need);
        if (!ok) {
          console.warn('[Page.guard] Permissão negada pelo check manual.', {
            required: need,
            perms: perms
          });
        }
        return ok;
      } catch (e) {
        console.warn('[Page.guard] Erro inesperado em ensure()', e);
        return false;
      } finally {
        hideLoader();
      }
    }

    async function denyDefault(){
      try { global.PageLoading?.show?.('Sem permissão', { scope:'body' }); } catch {}

      async function firstAllowedRoute(){
        try {
          if (global.ZAuth?._internals?._fetchMinhasPerms) {
            const headers = ZAuth.authHeader ? ZAuth.authHeader() : {};
            const list = await ZAuth._internals._fetchMinhasPerms(headers);
            const pick = ZAuth._internals._pickFirstAllowed(list);
            if (pick) return pick;
          }
        } catch (e) {
          console.warn('[Page.guard] Falha ao descobrir primeira rota liberada:', e);
        }
        return '/sem-permissao';
      }

      const dest = await firstAllowedRoute();
      setTimeout(function(){ location.replace(dest); }, 600);
    }

    // run-once
    if (ran) return;
    ran = true;

    (async function(){
      const ok = await ensure();
      if (ok) {
        return void initFn?.();
      }
      if (typeof options.onDeny === 'function') {
        return void options.onDeny();
      }
      return void denyDefault();
    })();
  }

  global.Page = Object.assign(global.Page || {}, { guarded });
})(window);
