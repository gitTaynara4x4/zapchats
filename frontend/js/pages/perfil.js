// /frontend/js/atendimentos/ui/perfil.js
// Drawer “Campos do cliente”
// - sem CSS inline
// - cria o drawer automaticamente
// - máscaras + CEP (BrasilAPI)
// - botão no header (#btn-perfil)
// - exporta abrirPerfilAtual()
// ✅ alinhado com conversation_key canônica:
//    c:<cliente_id>:<instancia_id> e g:<grupo_id>:<instancia_id>
// ✅ só abre para contato individual (kind = c)
// ✅ nunca usa Number(...) no id composto da conversa

const $ = (s, r = document) => r.querySelector(s);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

const EMPRESA_ID = Number(window.EMPRESA_ID || localStorage.getItem('empresa_id') || 0);

/* =========================
   HELPERS DE CONVERSA
   ========================= */

function idKey(v) {
  const s = String(v ?? '').trim();
  if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
  return s;
}

function instKey(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (['null', 'undefined', 'nan', '0', 'all', '*', '-'].includes(s.toLowerCase())) return null;
  return s;
}

function parseConversationKey(raw) {
  const s = idKey(raw);
  if (!s) return null;

  const m = s.match(/^([cg]):(\d+):([^:]+)$/i);
  if (!m) return null;

  return {
    key: `${m[1].toLowerCase()}:${m[2]}:${m[3]}`,
    kind: m[1].toLowerCase(),
    entityId: m[2],
    instId: instKey(m[3]),
  };
}

function buildConversationKey(kind, entityId, instId) {
  const k = String(kind || '').toLowerCase() === 'g' ? 'g' : 'c';
  const eid = idKey(entityId);
  const iid = instKey(instId);
  if (!eid) return null;
  return `${k}:${eid}:${iid ?? '0'}`;
}

function kindFromObject(obj) {
  if (!obj || typeof obj !== 'object') return 'c';

  const explicit =
    obj.kind ??
    obj.conversation_kind ??
    obj.tipo_conversa ??
    null;

  const e = String(explicit || '').trim().toLowerCase();
  if (e === 'g' || e === 'grupo' || e === 'group') return 'g';
  if (e === 'c' || e === 'cliente' || e === 'contato') return 'c';

  if (obj.is_group === true || obj.grupo === true || obj.isGroup === true || obj.grupo_id != null) {
    return 'g';
  }

  return 'c';
}

function entityIdFromAny(raw, row = null) {
  const parsed = parseConversationKey(raw);
  if (parsed?.entityId) return parsed.entityId;

  if (row && typeof row === 'object') {
    const direct =
      row.entity_id ??
      row.backend_id ??
      row.api_id ??
      (kindFromObject(row) === 'g' ? row.grupo_id : row.cliente_id) ??
      row.id_backend ??
      null;

    const d = idKey(direct);
    if (d && /^\d+$/.test(d)) return d;
  }

  const s = idKey(raw);
  if (s && /^\d+$/.test(s)) return s;

  return null;
}

function instIdFromAny(raw, row = null) {
  const parsed = parseConversationKey(raw);
  if (parsed?.instId) return parsed.instId;

  if (row && typeof row === 'object') {
    return (
      instKey(row.instancia_id) ||
      instKey(row.instancia) ||
      instKey(row.instance_name) ||
      instKey(row.instance) ||
      null
    );
  }

  return null;
}

function conversationRefOf(raw, row = null) {
  if (raw && typeof raw === 'object') {
    const obj = raw;

    const fromStoreHelper = typeof window.getConversationKey === 'function'
      ? window.getConversationKey(
          obj.conversation_key ?? obj.conversation_id ?? obj.id ?? obj.cliente_id ?? obj.grupo_id ?? null,
          obj,
          obj.instancia_id ?? obj.instancia ?? obj.instance_name ?? null
        )
      : null;

    const parsedStore = parseConversationKey(fromStoreHelper);
    if (parsedStore) return parsedStore;

    const directRaw =
      obj.conversation_key ??
      obj.conversation_id ??
      obj.id ??
      null;

    const parsedDirect = parseConversationKey(directRaw);
    if (parsedDirect) return parsedDirect;

    const kind = kindFromObject(obj);
    const entityId = entityIdFromAny(directRaw, obj);
    const instId = instIdFromAny(directRaw, obj);

    const built = buildConversationKey(kind, entityId, instId) || idKey(directRaw);
    const parsedBuilt = parseConversationKey(built);

    return parsedBuilt || {
      key: built,
      kind,
      entityId,
      instId,
    };
  }

  const fromStoreHelper = typeof window.getConversationKey === 'function'
    ? window.getConversationKey(raw, row || null, row?.instancia_id ?? row?.instancia ?? null)
    : null;

  const parsedStore = parseConversationKey(fromStoreHelper);
  if (parsedStore) return parsedStore;

  const parsed = parseConversationKey(raw);
  if (parsed) return parsed;

  const kind = row && typeof row === 'object' ? kindFromObject(row) : 'c';
  const entityId = entityIdFromAny(raw, row);
  const instId = instIdFromAny(raw, row);

  const built = buildConversationKey(kind, entityId, instId) || idKey(raw);

  return parseConversationKey(built) || {
    key: built,
    kind,
    entityId,
    instId,
  };
}

function getSelectedConversationRef() {
  const hist = $('#historico');
  const head = $('#chat-header');
  const row = window.state?.clienteSel || window.clienteSel || null;

  const raw =
    idKey(hist?.dataset?.conversationKey) ||
    idKey(hist?.dataset?.clienteId) ||
    idKey(head?.dataset?.conversationKey) ||
    idKey(row?.conversation_key) ||
    idKey(row?.conversation_id) ||
    idKey(row?.id) ||
    null;

  return conversationRefOf(raw, row);
}

function getSelectedKind() {
  const hist = $('#historico');
  const head = $('#chat-header');
  const row = window.state?.clienteSel || window.clienteSel || null;

  const direct =
    idKey(hist?.dataset?.kind) ||
    idKey(head?.dataset?.kind) ||
    idKey(row?.kind) ||
    null;

  if (direct && /^(c|g)$/i.test(direct)) return direct.toLowerCase();

  return getSelectedConversationRef().kind || 'c';
}

function getClienteId() {
  const hist = $('#historico');
  const head = $('#chat-header');
  const row = window.state?.clienteSel || window.clienteSel || null;

  const direct =
    idKey(hist?.dataset?.entityId) ||
    idKey(head?.dataset?.entityId) ||
    idKey(row?.entity_id) ||
    idKey(row?.backend_id) ||
    idKey(row?.api_id) ||
    null;

  if (direct && /^\d+$/.test(direct)) {
    return getSelectedKind() === 'c' ? direct : null;
  }

  const ref = getSelectedConversationRef();
  if (ref.kind !== 'c') return null;

  return ref.entityId || null;
}

/* =========================
   TEMA / ÍCONES
   ========================= */

function getTheme() {
  try {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
  } catch {}
  try {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {}
  return 'dark';
}

function iconSvg(theme) {
  const fill = theme === 'light' ? '#080808' : '#ffffff';
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"
         class="perfil-ico" fill="${fill}" viewBox="0 0 256 256" aria-hidden="true">
      <path d="M154,80a6,6,0,0,1,6-6h88a6,6,0,0,1,0,12H160A6,6,0,0,1,154,80Zm94,42H160a6,6,0,0,0,0,12h88a6,6,0,0,0,0-12Zm0,48H184a6,6,0,0,0,0,12h64a6,6,0,0,0,0-12Zm-98.19,20.5a6,6,0,1,1-11.62,3C131.7,168.29,107.23,150,80,150s-51.7,18.29-58.19,43.49a6,6,0,1,1-11.62-3c5.74-22.28,23-40.07,44.67-48a46,46,0,1,1,50.28,0C126.79,150.43,144.08,168.22,149.81,190.5ZM80,138a34,34,0,1,0-34-34A34,34,0,0,0,80,138Z"></path>
    </svg>
  `;
}

function bannerSvg(theme) {
  const fill = theme === 'light' ? '#080808' : '#ffffff';
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="${fill}" viewBox="0 0 256 256" aria-hidden="true">
      <path d="M222,114.56a54,54,0,0,0-58.67-74.73,54,54,0,0,0-94,13.46A54,54,0,0,0,34,141.44a54,54,0,0,0,35.56,73.65A54.54,54.54,0,0,0,83.59,217a52.86,52.86,0,0,0,9.06-.78,54,54,0,0,0,94-13.46A54,54,0,0,0,222,114.56ZM183.37,52.5a42,42,0,0,1,29.21,53.14,54.84,54.84,0,0,0-5.08-3.33L163,76.62a6,6,0,0,0-6,0l-47,27.13V80.66l41.5-24A41.73,41.73,0,0,1,183.37,52.5ZM78,72a42,42,0,0,1,72.92-28.43,56.18,56.18,0,0,0-5.42,2.74L101,72a6,6,0,0,0-3,5.19v54.27L78,119.92ZM39.13,85.93a41.75,41.75,0,0,1,27.22-20A55.09,55.09,0,0,0,66,72v51.38a6,6,0,0,0,3,5.2l47,27.13L96,167.26l-41.5-24A42,42,0,0,1,39.13,85.93ZM72.63,203.5a42,42,0,0,1-29.21-53.14,54.84,54.84,0,0,0,5.08,3.33L93,179.38a6,6,0,0,0,6,0l47-27.13v23.09l-41.5,24A41.73,41.73,0,0,1,72.63,203.5ZM178,184a42,42,0,0,1-72.92,28.43,56.18,56.18,0,0,0,5.42-2.74L155,184a6,6,0,0,0,3-5.19V124.54l20,11.54Zm38.87-13.93a41.75,41.75,0,0,1-27.22,20A55.09,55.09,0,0,0,190,184V132.62a6,6,0,0,0-3-5.2l-47-27.13,20-11.55,41.5,24A42,42,0,0,1,216.87,170.07Z"></path>
    </svg>
  `;
}

/* =========================
   TOAST
   ========================= */

function ensureToastHost() {
  let host = document.getElementById('zcToastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'zcToastHost';
    host.className = 'zcToastHost';
    document.body.appendChild(host);
  }
  return host;
}

function toast({ title = 'Pronto', msg = '', type = 'ok', timeout = 2800 } = {}) {
  if (typeof window.toast === 'function') {
    try {
      window.toast({ title, msg, type, timeout });
      return;
    } catch {}
  }

  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = `zcToast ${type === 'error' ? 'err' : 'ok'}`;
  el.innerHTML = `
    <div>
      <div class="t-title">${title}</div>
      ${msg ? `<div class="t-msg">${msg}</div>` : ''}
    </div>
    <button class="t-close" aria-label="Fechar"><i class="fa-solid fa-xmark"></i></button>
  `;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  el.querySelector('.t-close')?.addEventListener('click', () => el.remove());
  if (timeout) setTimeout(() => el.remove(), timeout);
}

/* =========================
   MÁSCARAS / VALIDAÇÃO
   ========================= */

const UF_LIST = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
const UF_SET = new Set(UF_LIST);

const onlyDigits = s => String(s || '').replace(/\D+/g, '');
const keepRGChars = s => String(s || '').replace(/[^0-9xX]/g, '').toUpperCase();

function fmtCPF(d) {
  d = onlyDigits(d).slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
}

function fmtCNPJ(d) {
  d = onlyDigits(d).slice(0, 14);
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3/$4')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})(\d)/, '$1.$2.$3/$4-$5');
}

function fmtCPForCNPJ(v) {
  const d = onlyDigits(v);
  return d.length <= 11 ? fmtCPF(d) : fmtCNPJ(d);
}

function fmtRG(v) {
  let s = keepRGChars(v).slice(0, 10);
  let body = s;
  let dv = '';
  if (s.length === 10) {
    body = s.slice(0, 9);
    dv = s.slice(9);
  }
  body = body
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3');
  return dv ? `${body}-${dv}` : body;
}

function fmtCEP(v) {
  let d = onlyDigits(v).slice(0, 8);
  if (d.length > 5) d = d.replace(/^(\d{5})(\d{1,3})$/, '$1-$2');
  return d;
}

function fmtNumero(v) {
  return onlyDigits(v).slice(0, 8);
}

function fmtComplemento(v) {
  return String(v || '')
    .replace(/[^0-9A-Za-zÀ-ÿ\s#\/\-\.\º°]/g, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 40);
}

function fmtCidade(v) {
  return String(v || '')
    .replace(/[^A-Za-zÀ-ÿ\s\-']/g, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 50);
}

function fmtUF(v) {
  return String(v || '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .slice(0, 2);
}

function fmtDataBR(v) {
  const d = onlyDigits(v).slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return d.replace(/^(\d{2})(\d{0,2})$/, '$1/$2');
  return d.replace(/^(\d{2})(\d{2})(\d{0,4}).*$/, '$1/$2/$3');
}

function isValidDataBR(v) {
  const m = String(v || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return false;

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);

  if (yyyy < 1900) return false;
  if (mm < 1 || mm > 12) return false;

  const dt = new Date(yyyy, mm - 1, dd);
  if (
    dt.getFullYear() !== yyyy ||
    dt.getMonth() + 1 !== mm ||
    dt.getDate() !== dd
  ) return false;

  if (dt.getTime() > Date.now()) return false;
  return true;
}

function toISOFromDataBR(v) {
  if (!isValidDataBR(v)) return '';
  const [dd, mm, yyyy] = v.split('/');
  return `${yyyy}-${mm}-${dd}`;
}

function toDataBRFromAny(x) {
  if (!x) return '';
  const s = String(x);

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return s;

  return '';
}

function isValidEmail(v) {
  if (!v) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

function isValidCEP(v) {
  return onlyDigits(v).length === 8;
}

function isValidCPF(d) {
  d = onlyDigits(d);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;

  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(d[i]) * (10 - i);
  let dg = (s * 10) % 11;
  if (dg === 10) dg = 0;
  if (dg !== Number(d[9])) return false;

  s = 0;
  for (let i = 0; i < 10; i++) s += Number(d[i]) * (11 - i);
  dg = (s * 10) % 11;
  if (dg === 10) dg = 0;

  return dg === Number(d[10]);
}

function isValidCNPJ(c) {
  c = onlyDigits(c);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;

  const calc = (base) => {
    const seq = [5,4,3,2,9,8,7,6,5,4,3,2].slice(12 - base.length);
    const sum = base.split('').reduce((acc, ch, i) => acc + Number(ch) * seq[i], 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };

  const b1 = c.substring(0, 12);
  const d1 = calc(b1);
  const d2 = calc(b1 + String(d1));
  return c === b1 + String(d1) + String(d2);
}

function validCPForCNPJ(v) {
  const d = onlyDigits(v);
  if (!d.length) return true;
  return d.length <= 11 ? isValidCPF(d) : isValidCNPJ(d);
}

function maskInput(el, formatter, validator) {
  if (!el) return;

  const apply = () => {
    el.value = formatter(el.value);
    if (validator) {
      const ok = validator(el.value);
      el.classList.toggle('is-invalid', !ok);
      el.title = ok ? '' : 'Valor inválido';
    }
  };

  on(el, 'input', apply);
  on(el, 'blur', apply);
  apply();
}

/* =========================
   BRASILAPI
   ========================= */

async function preencherPorCEP(cep) {
  const d = onlyDigits(cep);
  if (d.length !== 8) return false;

  try {
    const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${d}`);
    if (!r.ok) return false;

    const j = await r.json();
    const est = String(j.state || '').toUpperCase();

    if ($('#pf_estado') && UF_SET.has(est)) $('#pf_estado').value = est;
    if ($('#pf_cidade')) $('#pf_cidade').value = j.city || '';
    if ($('#pf_bairro')) $('#pf_bairro').value = j.neighborhood || '';
    if ($('#pf_endereco')) $('#pf_endereco').value = j.street || '';

    setBannerTip('Endereço sugerido a partir do CEP. Confira antes de salvar.');
    return true;
  } catch (e) {
    console.warn('[CEP] BrasilAPI erro', e);
    return false;
  }
}

/* =========================
   DRAWER
   ========================= */

let drawerRefs = null;
let drawerBound = false;

function refreshBannerIcon(container) {
  const slot = container?.querySelector('.b-ico');
  if (slot) slot.innerHTML = bannerSvg(getTheme());
}

function setBanner(msg, tip = '') {
  const banner = $('#zcPerfilBanner');
  if (!banner) return;

  const msgEl = banner.querySelector('.b-msg');
  const tipEl = banner.querySelector('.b-tip');

  if (msgEl) msgEl.innerHTML = msg || '';
  if (tipEl) tipEl.textContent = tip;

  refreshBannerIcon(banner);
}

function setBannerTip(tip) {
  const tipEl = $('#zcPerfilBanner .b-tip');
  if (!tipEl) return;
  tipEl.textContent = tip || '';
  try {
    tipEl.animate([{ opacity: .25 }, { opacity: 1 }], { duration: 160, fill: 'forwards' });
  } catch {}
}

function ensureDrawer() {
  if (drawerRefs) return drawerRefs;

  const UF_OPTIONS = UF_LIST.map((uf) => `<option value="${uf}">${uf}</option>`).join('');

  const backdrop = document.createElement('div');
  backdrop.id = 'zcPerfilBackdrop';
  backdrop.className = 'zcPerfil-backdrop';

  const drawer = document.createElement('aside');
  drawer.id = 'zcPerfilDrawer';
  drawer.className = 'zcPerfil-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');

  drawer.innerHTML = `
    <div class="zcPerfil-head">
      <div class="zcPerfil-title" id="zcPerfilTitle">
        ${iconSvg(getTheme())}
        <span>Campos do cliente</span>
      </div>
      <button class="zcPerfil-close" id="zcPerfilClose" title="Fechar" aria-label="Fechar">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 256 256" aria-hidden="true">
          <path fill="currentColor" d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66A8 8 0 0 1 61.66 50.34L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128z"/>
        </svg>
      </button>
    </div>

    <div class="zcPerfil-body">
      <div class="zcPerfil-banner" id="zcPerfilBanner" aria-live="polite">
        <span class="b-ico"></span>
        <div>
          <div class="b-msg"></div>
          <div class="b-tip"></div>
        </div>
      </div>

      <div class="zcPerfil-stack">
        <div class="zcPerfil-field">
          <label>Nome completo</label>
          <input id="pf_nome_completo" autocomplete="off" maxlength="120">
        </div>

        <div class="zcPerfil-field">
          <label>CPF/CNPJ</label>
          <input id="pf_cpf_cnpj" autocomplete="off" inputmode="numeric" maxlength="18" placeholder="CPF ou CNPJ">
        </div>

        <div class="zcPerfil-field">
          <label>RG</label>
          <input id="pf_rg" autocomplete="off" maxlength="12" placeholder="00.000.000-X">
        </div>

        <div class="zcPerfil-field">
          <label>E-mail</label>
          <input id="pf_email" type="email" autocomplete="off" maxlength="120" placeholder="email@dominio.com">
        </div>

        <div class="zcPerfil-row zcPerfil-row--datagen">
          <div class="zcPerfil-field field--dob">
            <label>Data de nascimento</label>
            <input id="pf_data_nasc" autocomplete="off" inputmode="numeric" maxlength="10" placeholder="DD/MM/AAAA">
          </div>

          <div class="zcPerfil-field field--genero">
            <label>Gênero</label>
            <div class="zcPerfil-selectWrap">
              <select id="pf_genero">
                <option value="">Selecione…</option>
                <option value="Masculino">Masculino</option>
                <option value="Feminino">Feminino</option>
                <option value="Outro">Outro</option>
                <option value="Prefiro não dizer">Prefiro não dizer</option>
              </select>
            </div>
          </div>
        </div>

        <div class="zcPerfil-row zcPerfil-row--cepuf">
          <div class="zcPerfil-field field--cep">
            <label>CEP</label>
            <input id="pf_cep" autocomplete="off" inputmode="numeric" maxlength="9" placeholder="00000-000">
          </div>

          <div class="zcPerfil-field field--uf">
            <label>Estado (UF)</label>
            <div class="zcPerfil-selectWrap">
              <select id="pf_estado">
                <option value="">UF</option>
                ${UF_OPTIONS}
              </select>
            </div>
          </div>
        </div>

        <div class="zcPerfil-field">
          <label>Endereço</label>
          <input id="pf_endereco" autocomplete="off" maxlength="80" placeholder="Rua, Av., Travessa…">
        </div>

        <div class="zcPerfil-row zcPerfil-row--numcomp">
          <div class="zcPerfil-field field--numero">
            <label>Número</label>
            <input id="pf_numero" autocomplete="off" inputmode="numeric" maxlength="8">
          </div>

          <div class="zcPerfil-field field--complemento">
            <label>Complemento</label>
            <input id="pf_complemento" autocomplete="off" maxlength="40" placeholder="Apto, Bloco, Casa, Sala…">
          </div>
        </div>

        <div class="zcPerfil-field">
          <label>Bairro</label>
          <input id="pf_bairro" autocomplete="off" maxlength="50">
        </div>

        <div class="zcPerfil-field">
          <label>Cidade</label>
          <input id="pf_cidade" autocomplete="off" maxlength="50">
        </div>
      </div>

      <div class="zcPerfil-actions">
        <button class="zcPerfil-btnPrimary" id="zcPerfilSave" type="button">Salvar</button>
        <button class="zcPerfil-btnGhost" id="zcPerfilCancel" type="button">Cancelar</button>
      </div>
    </div>
  `;

  document.body.append(backdrop, drawer);

  drawerRefs = {
    backdrop,
    drawer,
    title: $('#zcPerfilTitle', drawer),
    banner: $('#zcPerfilBanner', drawer),
    save: $('#zcPerfilSave', drawer),
    cancel: $('#zcPerfilCancel', drawer),
    close: $('#zcPerfilClose', drawer),
    nome: $('#pf_nome_completo', drawer),
    cpfCnpj: $('#pf_cpf_cnpj', drawer),
    rg: $('#pf_rg', drawer),
    email: $('#pf_email', drawer),
    dataNasc: $('#pf_data_nasc', drawer),
    genero: $('#pf_genero', drawer),
    cep: $('#pf_cep', drawer),
    endereco: $('#pf_endereco', drawer),
    numero: $('#pf_numero', drawer),
    complemento: $('#pf_complemento', drawer),
    bairro: $('#pf_bairro', drawer),
    cidade: $('#pf_cidade', drawer),
    estado: $('#pf_estado', drawer),
  };

  bindDrawer();
  refreshDrawerIcons();

  return drawerRefs;
}

function refreshDrawerIcons() {
  if (!drawerRefs) return;
  if (drawerRefs.title) {
    drawerRefs.title.innerHTML = `${iconSvg(getTheme())}<span>Campos do cliente</span>`;
  }
  refreshBannerIcon(drawerRefs.drawer);
}

function bindDrawer() {
  if (!drawerRefs || drawerBound) return;
  drawerBound = true;

  const r = drawerRefs;

  const close = () => {
    r.backdrop.classList.remove('is-open');
    r.drawer.classList.remove('is-open');
  };

  on(r.close, 'click', close);
  on(r.cancel, 'click', close);
  on(r.backdrop, 'click', (e) => {
    if (e.target === r.backdrop) close();
  });

  on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && r.drawer.classList.contains('is-open')) close();
  });

  maskInput(r.cpfCnpj, fmtCPForCNPJ, validCPForCNPJ);
  maskInput(r.rg, fmtRG, null);
  maskInput(r.cep, fmtCEP, (v) => isValidCEP(v) || v === '');
  maskInput(r.numero, fmtNumero, null);
  maskInput(r.complemento, fmtComplemento, null);
  maskInput(r.cidade, fmtCidade, null);
  maskInput(r.dataNasc, fmtDataBR, (v) => isValidDataBR(v) || v === '');

  if (r.email) {
    const applyEmail = () => {
      r.email.value = String(r.email.value || '').trim().toLowerCase();
      const ok = isValidEmail(r.email.value);
      r.email.classList.toggle('is-invalid', !ok);
      r.email.title = ok ? '' : 'E-mail inválido';
    };
    on(r.email, 'blur', applyEmail);
    applyEmail();
  }

  on(r.cep, 'blur', async () => {
    const ok = await preencherPorCEP(r.cep.value);
    if (!ok && onlyDigits(r.cep.value).length === 8) {
      setBannerTip('Não foi possível sugerir o endereço para este CEP.');
    }
  });

  on(r.save, 'click', salvarPerfil);
}

function openDrawer() {
  const r = ensureDrawer();
  r.backdrop.classList.add('is-open');
  r.drawer.classList.add('is-open');
  setTimeout(() => r.nome?.focus(), 0);
}

function resetForm() {
  const r = ensureDrawer();
  [
    r.nome, r.cpfCnpj, r.rg, r.email, r.dataNasc, r.cep, r.endereco,
    r.numero, r.complemento, r.bairro, r.cidade
  ].forEach((el) => { if (el) el.value = ''; });

  if (r.estado) r.estado.value = '';
  if (r.genero) r.genero.value = '';

  [r.cpfCnpj, r.email, r.dataNasc].forEach((el) => {
    el?.classList.remove('is-invalid');
    if (el) el.title = '';
  });

  setBanner(
    'Usamos inteligência artificial para <strong>montar o endereço</strong> a partir do CEP e para <strong>validar CPF/CNPJ</strong>. Confira os dados antes de salvar.',
    ''
  );
}

async function carregarPerfil() {
  const cid = getClienteId();
  if (!cid || !EMPRESA_ID) {
    toast({ title: 'Selecione um cliente', type: 'error' });
    return;
  }

  const r = ensureDrawer();
  resetForm();

  try {
    const resp = await fetch(
      `/api/atendimento/clientes/${encodeURIComponent(cid)}/profile?empresa_id=${EMPRESA_ID}`,
      { credentials: 'include' }
    );

    if (!resp.ok) throw new Error('Falha ao buscar perfil');

    const j = await resp.json();

    r.nome.value = j.nome_completo || '';
    r.cpfCnpj.value = fmtCPForCNPJ(j.cpf_cnpj || '');
    r.rg.value = fmtRG(j.rg || '');
    r.email.value = String(j.email || '').trim().toLowerCase();

    const nascRaw = j.data_nascimento || j.nascimento || j.dataNascimento || '';
    r.dataNasc.value = toDataBRFromAny(nascRaw);

    r.genero.value = j.genero || j.sexo || '';
    r.cep.value = fmtCEP(j.cep || '');
    r.endereco.value = j.endereco || '';
    r.numero.value = fmtNumero(j.numero || '');
    r.complemento.value = fmtComplemento(j.complemento || '');
    r.bairro.value = j.bairro || '';
    r.cidade.value = fmtCidade(j.cidade || '');

    const uf = fmtUF(j.estado || '');
    if (UF_SET.has(uf)) r.estado.value = uf;
  } catch (err) {
    console.error('[perfil] carregar()', err);
    toast({ title: 'Não foi possível carregar o perfil', type: 'error' });
  }
}

async function salvarPerfil() {
  const cid = getClienteId();
  if (!cid || !EMPRESA_ID) {
    toast({ title: 'Selecione um cliente', type: 'error' });
    return;
  }

  const r = ensureDrawer();

  const email = String(r.email.value || '').trim().toLowerCase();
  const cpfcnpj = r.cpfCnpj.value || '';
  const cep = r.cep.value || '';
  const ufSel = r.estado.value || '';
  const dnBr = r.dataNasc.value || '';
  const generoSel = String(r.genero.value || '').trim();

  const invalids = [];
  if (!isValidEmail(email)) invalids.push('E-mail inválido');
  if (!validCPForCNPJ(cpfcnpj)) invalids.push('CPF/CNPJ inválido');
  if (cep && !isValidCEP(cep)) invalids.push('CEP inválido');
  if (ufSel && !UF_SET.has(ufSel)) invalids.push('UF inválida');
  if (dnBr && !isValidDataBR(dnBr)) invalids.push('Data de nascimento inválida');

  if (invalids.length) {
    toast({
      title: 'Verifique os campos',
      msg: invalids.join(' · '),
      type: 'error',
    });
    return;
  }

  const payload = {
    nome_completo: String(r.nome.value || '').trim() || undefined,
    cpf_cnpj: onlyDigits(cpfcnpj) || undefined,
    rg: String(r.rg.value || '').replace(/\./g, '').toUpperCase() || undefined,
    email: email || undefined,
    data_nascimento: dnBr ? toISOFromDataBR(dnBr) : undefined,
    genero: generoSel || undefined,
    cep: onlyDigits(cep) || undefined,
    endereco: String(r.endereco.value || '').trim() || undefined,
    numero: onlyDigits(r.numero.value || '') || undefined,
    complemento: String(r.complemento.value || '').trim() || undefined,
    bairro: String(r.bairro.value || '').trim() || undefined,
    cidade: String(r.cidade.value || '').trim() || undefined,
    estado: String(ufSel || '').toUpperCase() || undefined,
  };

  r.save.disabled = true;
  r.save.textContent = 'Salvando…';

  try {
    const resp = await fetch(
      `/api/atendimento/clientes/${encodeURIComponent(cid)}/profile?empresa_id=${EMPRESA_ID}`,
      {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    if (!resp.ok) throw new Error('Falha ao salvar');

    setBannerTip('Dados salvos com sucesso.');
    toast({
      title: 'Salvo',
      msg: 'Informações do cliente atualizadas.',
      type: 'ok',
    });
  } catch (err) {
    console.error('[perfil] salvar()', err);
    toast({
      title: 'Erro ao salvar',
      msg: 'Não foi possível atualizar o cliente.',
      type: 'error',
    });
  } finally {
    r.save.disabled = false;
    r.save.textContent = 'Salvar';
  }
}

/* =========================
   API
   ========================= */

export async function abrirPerfilAtual() {
  const kind = getSelectedKind();
  if (kind !== 'c') {
    toast({
      title: 'Perfil indisponível',
      msg: 'Os campos do cliente estão disponíveis apenas para conversas individuais.',
      type: 'error',
    });
    return;
  }

  const cid = getClienteId();
  if (!cid) {
    toast({ title: 'Selecione um cliente', type: 'error' });
    return;
  }

  ensureDrawer();
  openDrawer();
  await carregarPerfil();
}

window.abrirPerfilAtual = abrirPerfilAtual;

/* =========================
   BOTÃO NO HEADER
   ========================= */

function ensureHeaderButton() {
  if (document.getElementById('btn-perfil')) return;

  const hdr =
    $('#chat-header .flex.items-center.gap-2.relative') ||
    $('#chat-header .flex.items-center.gap-2') ||
    $('#chat-header');

  if (!hdr) return;

  const btn = document.createElement('button');
  btn.id = 'btn-perfil';
  btn.className = 'hdr-icon-btn';
  btn.type = 'button';
  btn.title = 'Campos do cliente';
  btn.setAttribute('aria-label', 'Campos do cliente');
  btn.innerHTML = iconSvg(getTheme());

  on(btn, 'click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    abrirPerfilAtual();
  });

  hdr.appendChild(btn);

  const refresh = () => {
    const el = document.getElementById('btn-perfil');
    if (el) el.innerHTML = iconSvg(getTheme());
    refreshDrawerIcons();
  };

  try {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener ? mq.addEventListener('change', refresh) : mq.addListener(refresh);
  } catch {}

  new MutationObserver(refresh).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  addEventListener('storage', (e) => {
    if (e && e.key === 'zc:theme') refresh();
  });
}

(function watchHeader() {
  const hdrEl = document.getElementById('chat-header');
  if (hdrEl) {
    const mo = new MutationObserver(() => ensureHeaderButton());
    mo.observe(hdrEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  }
  ensureHeaderButton();
})();