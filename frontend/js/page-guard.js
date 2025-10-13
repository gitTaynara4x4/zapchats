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

    async function ensure() {
      // normaliza permissão
      var needAny = [], needAll = [];
      if (typeof perm === 'string') needAll = [perm];
      else if (perm && typeof perm === 'object') {
        needAny = Array.isArray(perm.any) ? perm.any : [];
        needAll = Array.isArray(perm.all) ? perm.all : [];
      }

      // usa ZAuth.ensurePerm se existir; senão faz checagem manual
      async function fetchPerms(){
        if (global.ZAuth?.getPerms) {
          return await ZAuth.getPerms();
        }
        const f = (global.ZAuth?.authFetch) ? ZAuth.authFetch : fetch;
        const r = await f('/api/permissoes/minhas', { credentials:'include' });
        if (!r.ok) throw new Error(String(r.status));
        const data = await r.json();
        return Array.isArray(data) ? data : (Array.isArray(data?.permissoes) ? data.permissoes : []);
      }

      function check(perms){
        if (needAll.length && !needAll.every(p => perms.includes(p))) return false;
        if (needAny.length && !needAny.some(p => perms.includes(p)))  return false;
        if (!needAll.length && !needAny.length) return true; // sem requisito
        return true;
      }

      try {
        showLoader(options.loading);
        // ZAuth.ensurePerm já resolve isso? então delega:
        if (global.ZAuth?.ensurePerm) {
          await ZAuth.ensurePerm(perm); // lança se negar
          return true;
        }
        // fallback: busca e checa
        const perms = await fetchPerms();
        return check(perms);
      } catch {
        return false;
      } finally {
        hideLoader();
      }
    }

    async function denyDefault(){
      try { global.PageLoading?.show?.('Sem permissão', { scope:'body' }); } catch {}
      // descobre 1ª rota liberada (você já tem isso em algumas páginas)
      async function firstAllowedRoute(){
        try {
          if (global.ZAuth?._internals?._fetchMinhasPerms) {
            const headers = ZAuth.authHeader ? ZAuth.authHeader() : {};
            const list = await ZAuth._internals._fetchMinhasPerms(headers);
            const pick = ZAuth._internals._pickFirstAllowed(list);
            if (pick) return pick;
          }
        } catch {}
        return '/sem-permissao';
      }
      const dest = await firstAllowedRoute();
      setTimeout(()=> location.replace(dest), 600);
    }

    // run-once
    if (ran) return;
    ran = true;

    (async function(){
      const ok = await ensure();
      if (ok) return void initFn?.();
      if (typeof options.onDeny === 'function') return void options.onDeny();
      return void denyDefault();
    })();
  }

  global.Page = Object.assign(global.Page || {}, { guarded });
})(window);
