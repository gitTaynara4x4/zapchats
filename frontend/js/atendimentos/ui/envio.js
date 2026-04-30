// /frontend/js/atendimentos/ui/envio.js
import { EMPRESA_ID } from '../core/env.js';
import { numeroE164 } from '../core/format.js';
import {
  state,
  getConversationKey,
  getConversationEntityId,
  getConversationKind,
} from '../state/store.js';

/* ====== Fallback pra window.addListener ====== */
if (typeof window !== 'undefined' && typeof window.addListener !== 'function') {
  window.addListener = function (...args) {
    console.warn('[envio.js] window.addListener fallback chamado', ...args);
  };
}

/* ========= TOAST ========= */
function toast(msg, ok = true) {
  let t = document.getElementById('__app_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '__app_toast';
    document.body.appendChild(t);
  }

  t.textContent = String(msg || '');
  t.classList.toggle('is-error', !ok);
  t.classList.add('on');

  clearTimeout(t.__timer);
  t.__timer = setTimeout(() => {
    t.classList.remove('on');
  }, 1600);
}

function stringifyErr(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();

  if (Array.isArray(raw)) {
    return raw.map((item) => stringifyErr(item)).filter(Boolean).join(' | ');
  }

  if (typeof raw === 'object') {
    if (typeof raw.detail === 'string') return raw.detail.trim();
    if (typeof raw.message === 'string') return raw.message.trim();
    if (typeof raw.error === 'string') return raw.error.trim();

    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }

  return String(raw).trim();
}

/* ========= HELPERS BASE ========= */
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

function parseJwt(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

function getIdentityJwt() {
  const token =
    localStorage.getItem('access_token') ||
    localStorage.getItem('token') ||
    '';
  return parseJwt(token) || {};
}

function getCurrentColabId() {
  const jwt = getIdentityJwt();

  for (const key of ['id_colab', 'colaborador_id', 'id_colaborador', 'colab_id', 'cid']) {
    const val = Number(jwt[key]);
    if (Number.isFinite(val) && val > 0) return val;
  }

  const sub = String(jwt.sub || '').trim().toLowerCase();
  if (sub.startsWith('colab-')) {
    const rest = sub.slice('colab-'.length);
    const val = Number(rest);
    if (Number.isFinite(val) && val > 0) return val;
  }

  return null;
}

function stripUndefined(o) {
  Object.keys(o).forEach((k) => {
    if (o[k] === undefined) delete o[k];
  });
  return o;
}

function onlyDigits(s) {
  return String(s || '').replace(/\D+/g, '');
}

function isJid(s) {
  const v = String(s || '').trim();
  return /@g\.us$/i.test(v) || /@s\.whatsapp\.net$/i.test(v);
}

function getHistoricoEl() {
  return document.getElementById('historico');
}

function getChatHeaderEl() {
  return document.getElementById('chat-header');
}

function getActiveConversationEl() {
  return (
    document.querySelector('[data-conversation-id].active') ||
    document.querySelector('[data-conversation-key].active') ||
    document.querySelector('[data-conv-key].active') ||
    document.querySelector('.cliente-item.active') ||
    document.querySelector('.chat-item.active') ||
    document.querySelector('.conversa-item.active') ||
    document.querySelector('#lista-clientes .active') ||
    null
  );
}

function datasetOf(el) {
  if (!el || !el.dataset) return null;
  return el.dataset;
}

/* ========= CONVERSATION HELPERS ========= */
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
      row.entityId ??
      row.backend_id ??
      row.backendClienteId ??
      row.api_id ??
      row.apiClienteId ??
      (kindFromObject(row) === 'g' ? row.grupo_id : row.cliente_id) ??
      (kindFromObject(row) === 'g' ? row.grupoId : row.clienteId) ??
      row.id_backend ??
      row.id ??
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
      instKey(row.instanciaId) ||
      instKey(row.instancia) ||
      instKey(row.instance_name) ||
      instKey(row.instanceName) ||
      instKey(row.instance_id) ||
      instKey(row.instanceId) ||
      instKey(row.instance) ||
      null
    );
  }

  return null;
}

function conversationRefOf(raw, row = null) {
  if (raw && typeof raw === 'object') {
    const obj = raw;

    const fromStoreHelper = getConversationKey(
      obj.conversation_key ?? obj.conversationKey ?? obj.conversation_id ?? obj.conversationId ?? obj.id ?? obj.cliente_id ?? obj.clienteId ?? obj.grupo_id ?? obj.grupoId ?? null,
      obj,
      obj.instancia_id ?? obj.instanciaId ?? obj.instancia ?? obj.instance_name ?? obj.instanceName ?? null
    );

    const parsedStore = parseConversationKey(fromStoreHelper);
    if (parsedStore) return parsedStore;

    const directRaw =
      obj.conversation_key ??
      obj.conversationKey ??
      obj.conversation_id ??
      obj.conversationId ??
      obj.id ??
      null;

    const parsedDirect = parseConversationKey(directRaw);
    if (parsedDirect) return parsedDirect;

    const kind = getConversationKind(directRaw, obj) || kindFromObject(obj);
    const entityId = getConversationEntityId(directRaw, obj) || entityIdFromAny(directRaw, obj);
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

  const fromStoreHelper = getConversationKey(
    raw,
    row || null,
    row?.instancia_id ?? row?.instanciaId ?? row?.instancia ?? row?.instance_name ?? row?.instanceName ?? null
  );

  const parsedStore = parseConversationKey(fromStoreHelper);
  if (parsedStore) return parsedStore;

  const parsed = parseConversationKey(raw);
  if (parsed) return parsed;

  const kind = getConversationKind(raw, row || null) || kindFromObject(row || null) || 'c';
  const entityId = getConversationEntityId(raw, row || null) || entityIdFromAny(raw, row || null);
  const instId = instIdFromAny(raw, row || null);

  const built = buildConversationKey(kind, entityId, instId) || idKey(raw);

  return parseConversationKey(built) || {
    key: built,
    kind,
    entityId,
    instId,
  };
}

function sameConversation(a, b) {
  const A = conversationRefOf(a, typeof a === 'object' ? a : null);
  const B = conversationRefOf(b, typeof b === 'object' ? b : null);

  if (A?.key && B?.key) return A.key === B.key;
  if (!A?.entityId || !B?.entityId) return false;

  return (
    (A.kind || 'c') === (B.kind || 'c') &&
    A.entityId === B.entityId &&
    String(A.instId || '') === String(B.instId || '')
  );
}

function getCurrentSelectedObject() {
  return (
    state?.clienteSel ||
    window.state?.clienteSel ||
    window.clienteSel ||
    null
  );
}

function makeFallbackConversationFromDom(targetKey = null) {
  const hist = getHistoricoEl();
  const head = getChatHeaderEl();
  const active = getActiveConversationEl();

  const hds = datasetOf(hist) || {};
  const dhead = datasetOf(head) || {};
  const ads = datasetOf(active) || {};
  const selected = getCurrentSelectedObject();

  const rawKey =
    idKey(targetKey) ||
    idKey(hds.conversationKey) ||
    idKey(dhead.conversationKey) ||
    idKey(ads.conversationKey) ||
    idKey(hds.conversationId) ||
    idKey(dhead.conversationId) ||
    idKey(ads.conversationId) ||
    idKey(hds.convKey) ||
    idKey(dhead.convKey) ||
    idKey(ads.convKey) ||
    idKey(hds.clienteId) ||
    idKey(dhead.clienteId) ||
    idKey(ads.clienteId) ||
    idKey(ads.id) ||
    null;

  const rawKind =
    hds.kind ||
    dhead.kind ||
    ads.kind ||
    ads.tipoConversa ||
    selected?.kind ||
    selected?.tipo_conversa ||
    'c';

  const rawEntity =
    idKey(hds.entityId) ||
    idKey(dhead.entityId) ||
    idKey(ads.entityId) ||
    idKey(hds.apiClienteId) ||
    idKey(dhead.apiClienteId) ||
    idKey(ads.apiClienteId) ||
    idKey(hds.backendClienteId) ||
    idKey(dhead.backendClienteId) ||
    idKey(ads.backendClienteId) ||
    idKey(ads.clienteId) ||
    idKey(ads.grupoId) ||
    null;

  const rawInst =
    instKey(hds.instanciaId) ||
    instKey(dhead.instanciaId) ||
    instKey(ads.instanciaId) ||
    instKey(hds.instancia) ||
    instKey(dhead.instancia) ||
    instKey(ads.instancia) ||
    instKey(window.INSTANCIA_ATIVA) ||
    null;

  const refFromKey = conversationRefOf(rawKey, {
    kind: rawKind,
    entity_id: rawEntity,
    instancia_id: rawInst,
  });

  const finalKind =
    refFromKey?.kind ||
    (String(rawKind).toLowerCase() === 'g' || String(rawKind).toLowerCase() === 'grupo' ? 'g' : 'c');

  const finalEntity =
    refFromKey?.entityId ||
    rawEntity ||
    null;

  const finalInst =
    refFromKey?.instId ||
    rawInst ||
    null;

  const finalKey =
    refFromKey?.key ||
    buildConversationKey(finalKind, finalEntity, finalInst) ||
    rawKey ||
    null;

  if (!finalKey && !finalEntity) return null;

  return {
    id: finalKey || finalEntity,
    conversation_key: finalKey || finalEntity,
    conversation_id: finalKey || finalEntity,
    entity_id: finalEntity || finalKey,
    cliente_id: finalKind === 'c' ? (finalEntity || finalKey) : null,
    grupo_id: finalKind === 'g' ? (finalEntity || finalKey) : null,
    instancia_id: finalInst,
    instancia: finalInst,
    kind: finalKind,
    is_group: finalKind === 'g',

    telefone:
      selected?.telefone ||
      selected?.telefone_norm ||
      selected?.whatsapp ||
      selected?.numero ||
      selected?.number ||
      ads.telefone ||
      ads.telefoneNorm ||
      ads.whatsapp ||
      ads.numero ||
      ads.number ||
      '',

    telefone_norm:
      selected?.telefone_norm ||
      selected?.telefone ||
      ads.telefoneNorm ||
      ads.telefone ||
      '',

    remote_jid:
      selected?.remote_jid ||
      selected?.remoteJid ||
      selected?.jid ||
      ads.remoteJid ||
      ads.remote_jid ||
      ads.jid ||
      '',

    jid:
      selected?.jid ||
      selected?.remote_jid ||
      selected?.remoteJid ||
      ads.jid ||
      ads.remoteJid ||
      '',

    nome:
      selected?.nome ||
      selected?.nome_whatsapp ||
      ads.nome ||
      ads.name ||
      'Cliente',
  };
}

function getAllConversationPools(extra = null) {
  const pools = [];
  const push = (x) => {
    if (!x) return;
    if (Array.isArray(x)) {
      x.forEach(push);
      return;
    }
    if (typeof x === 'object') pools.push(x);
  };

  const active = getActiveConversationEl();
  const fallback = makeFallbackConversationFromDom(extra);
  const selected = getCurrentSelectedObject();

  push(extra && typeof extra === 'object' ? extra : null);
  push(selected);
  push(state?.clienteSel);
  push(window.state?.clienteSel);
  push(window.clienteSel);
  push(fallback);
  push(datasetOf(active));

  push(state?.clientesCache);
  push(window.state?.clientesCache);
  push(window.clientesCache);

  push(state?.todosContatosCache);
  push(window.state?.todosContatosCache);
  push(window.todosContatosCache);

  try {
    const boxes = window.state?.convsByInst || state?.convsByInst || {};
    Object.values(boxes).forEach((box) => {
      if (Array.isArray(box?.items)) push(box.items);
    });
  } catch {}

  try {
    const lista = window.__zcListaConversas;
    if (Array.isArray(lista)) push(lista);
  } catch {}

  return pools.filter(Boolean);
}

function getSelectedConversationKey() {
  const hist = getHistoricoEl();
  const head = getChatHeaderEl();
  const active = getActiveConversationEl();
  const sel = getCurrentSelectedObject();

  const raw =
    idKey(hist?.dataset?.conversationKey) ||
    idKey(head?.dataset?.conversationKey) ||
    idKey(active?.dataset?.conversationKey) ||
    idKey(hist?.dataset?.conversationId) ||
    idKey(head?.dataset?.conversationId) ||
    idKey(active?.dataset?.conversationId) ||
    idKey(hist?.dataset?.convKey) ||
    idKey(head?.dataset?.convKey) ||
    idKey(active?.dataset?.convKey) ||
    idKey(hist?.dataset?.clienteId) ||
    idKey(head?.dataset?.clienteId) ||
    idKey(active?.dataset?.clienteId) ||
    idKey(sel?.conversation_key) ||
    idKey(sel?.conversationKey) ||
    idKey(sel?.conversation_id) ||
    idKey(sel?.conversationId) ||
    idKey(sel?.id) ||
    idKey(active?.dataset?.id) ||
    null;

  const row =
    sel ||
    datasetOf(active) ||
    makeFallbackConversationFromDom(raw) ||
    null;

  const ref = conversationRefOf(raw, row);
  if (ref?.key) return ref.key;

  const fallback = makeFallbackConversationFromDom(raw);
  return conversationRefOf(fallback, fallback).key || null;
}

function getConversationById(conversationRef = null) {
  const selected = getCurrentSelectedObject();

  const targetKey = conversationRefOf(
    conversationRef ?? getSelectedConversationKey(),
    selected || null
  ).key;

  if (!targetKey) return null;

  const pools = getAllConversationPools(conversationRef);

  return pools.find((x) => sameConversation(x, targetKey)) || makeFallbackConversationFromDom(targetKey) || null;
}

function getIdentityPayload(target = null) {
  const cli = typeof target === 'object' && target ? target : getConversationById(target);
  const ref = conversationRefOf(target || cli, cli);

  return stripUndefined({
    conversation_key: ref.key || undefined,
    conversation_id: ref.key || undefined,
    cliente_id: ref.kind === 'c' ? ref.entityId : undefined,
    grupo_id: ref.kind === 'g' ? ref.entityId : undefined,
  });
}

function freezeHistoricoInstancia(inst) {
  const hist = getHistoricoEl();
  const ik = instKey(inst);
  if (!hist) return;

  if (ik) hist.dataset.instanciaId = String(ik);
  else hist.removeAttribute('data-instancia-id');
}

function getFrozenHistoricoInstancia() {
  const hist = getHistoricoEl();
  return instKey(hist?.dataset?.instanciaId);
}

function getConversationInstancia(conversationRef = null) {
  const cli = getConversationById(conversationRef);
  const ref = conversationRefOf(cli || conversationRef, cli || null);

  return (
    instKey(cli?.instancia_id) ||
    instKey(cli?.instanciaId) ||
    instKey(cli?.instancia) ||
    instKey(cli?.instance_name) ||
    instKey(cli?.instanceName) ||
    ref.instId ||
    null
  );
}

function getInstanciaAtivaGlobal() {
  return instKey(
    window.getInstanciaAtiva?.() ??
    window.INSTANCIA_ATIVA ??
    null
  );
}

function getInstanciaForSend(conversationRef = null) {
  return (
    getFrozenHistoricoInstancia() ||
    getConversationInstancia(conversationRef) ||
    getInstanciaAtivaGlobal() ||
    null
  );
}

function getInstPayload(conversationRef = null) {
  const inst = getInstanciaForSend(conversationRef);
  if (!inst) return {};

  const n = Number(inst);
  if (Number.isFinite(n) && String(n) === String(inst)) {
    return { instancia_id: n };
  }
  return { instance: String(inst) };
}

function requireInstPayloadOrWarn(conversationRef = null) {
  const p = getInstPayload(conversationRef);
  const ok = p && (p.instancia_id != null || p.instance != null);

  if (!ok) {
    toast('Selecione o WhatsApp (instância) antes de enviar.', false);
    try { window.zcUpdateInstBadge?.(); } catch {}
    try { window.zcFlashInstBadge?.(); } catch {}
    return null;
  }

  return p;
}

/* =========================================================
   TRAVA PRINCIPAL: impede envio para conversa errada
   ========================================================= */

function getOpenConversationKeyFromDom() {
  const hist = getHistoricoEl();
  const head = getChatHeaderEl();

  return (
    idKey(hist?.dataset?.conversationKey) ||
    idKey(hist?.dataset?.conversationId) ||
    idKey(hist?.dataset?.convKey) ||
    idKey(head?.dataset?.conversationKey) ||
    idKey(head?.dataset?.conversationId) ||
    idKey(head?.dataset?.convKey) ||
    null
  );
}

function getOpenConversationRefFromDom() {
  const raw = getOpenConversationKeyFromDom();
  if (!raw) return null;

  const hist = getHistoricoEl();
  const head = getChatHeaderEl();
  const selected = getCurrentSelectedObject();

  const row = {
    ...(selected || {}),
    kind:
      hist?.dataset?.kind ||
      head?.dataset?.kind ||
      selected?.kind ||
      selected?.conversation_kind ||
      null,
    entity_id:
      hist?.dataset?.entityId ||
      head?.dataset?.entityId ||
      selected?.entity_id ||
      selected?.cliente_id ||
      selected?.grupo_id ||
      null,
    instancia_id:
      hist?.dataset?.instanciaId ||
      head?.dataset?.instanciaId ||
      selected?.instancia_id ||
      selected?.instancia ||
      null,
  };

  return conversationRefOf(raw, row);
}

function assertSendTargetStillOpen(conversationRef = null, { silent = false } = {}) {
  const selected = getCurrentSelectedObject();
  const cli = getConversationById(conversationRef || getSelectedConversationKey());
  const targetRef = conversationRefOf(conversationRef || cli || getSelectedConversationKey(), cli || selected || null);

  if (!targetRef?.key) {
    if (!silent) toast('Selecione uma conversa.', false);
    console.warn('[send/guard] sem targetRef', { conversationRef, cli, selected });
    return null;
  }

  const domRef = getOpenConversationRefFromDom();

  if (!domRef?.key) {
    if (!silent) toast('Conversa ainda não está pronta. Clique novamente no contato.', false);
    console.warn('[send/guard] sem domRef', { targetRef });
    return null;
  }

  if (domRef.key !== targetRef.key) {
    if (!silent) toast('Conversa mudou. Clique novamente no contato antes de enviar.', false);

    console.warn('[send/guard] BLOQUEADO: conversa aberta diferente da conversa do envio', {
      aberta: domRef,
      envio: targetRef,
      selected,
      cli,
      histDataset: getHistoricoEl()?.dataset,
      headDataset: getChatHeaderEl()?.dataset,
    });

    try {
      window.dispatchEvent(new CustomEvent('zc:send-blocked-wrong-conversation', {
        detail: {
          open_key: domRef.key,
          target_key: targetRef.key,
          open_ref: domRef,
          target_ref: targetRef,
        },
      }));
    } catch {}

    return null;
  }

  const histInst = getFrozenHistoricoInstancia();
  const targetInst = targetRef.instId || getConversationInstancia(targetRef.key);

  if (histInst && targetInst && String(histInst) !== String(targetInst)) {
    if (!silent) toast('Instância da conversa mudou. Clique novamente no contato antes de enviar.', false);

    console.warn('[send/guard] BLOQUEADO: instância aberta diferente da instância do envio', {
      histInst,
      targetInst,
      aberta: domRef,
      envio: targetRef,
    });

    return null;
  }

  if (window.ZC_REQUIRE_INSTANCE === true && !getInstanciaForSend(targetRef.key)) {
    if (!silent) toast('Selecione o WhatsApp (instância) antes de enviar.', false);
    try { window.zcUpdateInstBadge?.(); } catch {}
    try { window.zcFlashInstBadge?.(); } catch {}
    return null;
  }

  return targetRef;
}

function resolveRawTel(cli) {
  if (!cli) return '';
  if (cli.remote_jid) return String(cli.remote_jid);
  if (cli.remoteJid) return String(cli.remoteJid);
  if (cli.jid) return String(cli.jid);
  if (cli.telefone) return cli.telefone;
  if (cli.whatsapp) return cli.whatsapp;
  if (cli.numero) return cli.numero;
  if (cli.number) return cli.number;
  if (cli.telefone_norm) return cli.telefone_norm;
  if (cli.telefoneNorm) return cli.telefoneNorm;
  if (cli.grupo_jid) return String(cli.grupo_jid);
  if (cli.grupoJid) return String(cli.grupoJid);

  if (typeof cli.nome === 'string') {
    const digits = cli.nome.replace(/\D/g, '');
    if (digits.length >= 10) return cli.nome;
  }

  return '';
}

function ensureClienteSel() {
  const safeRef = assertSendTargetStillOpen(null, { silent: true });
  const cli = getConversationById(safeRef?.key || getSelectedConversationKey());
  const ref = conversationRefOf(cli || safeRef?.key || getSelectedConversationKey(), cli || null);
  const rawTel = resolveRawTel(cli);

  if (!ref?.key) {
    toast('Selecione uma conversa.', false);
    console.warn('[send] ensureClienteSel: sem conversation_key', { cli, ref });
    return false;
  }

  if (!safeRef) {
    toast('Conversa mudou. Clique novamente no contato antes de enviar.', false);
    return false;
  }

  if (ref.kind === 'g') {
    if (!rawTel && !ref.entityId) {
      toast('Grupo sem destino válido. Recarregue a tela.', false);
      console.warn('[send] ensureClienteSel: grupo sem destino', { cli, ref });
      return false;
    }
    return true;
  }

  if (!rawTel) {
    toast('Contato sem telefone válido. Recarregue a tela ou edite o cadastro.', false);
    console.warn('[send] ensureClienteSel: clienteSel sem telefone', cli);
    return false;
  }

  return true;
}

function numberForApi(conversationRef = null) {
  const cli = getConversationById(conversationRef);
  const ref = conversationRefOf(cli || conversationRef, cli || null);
  const raw = String(resolveRawTel(cli) || '').trim();

  if (raw) {
    if (isJid(raw)) return raw;
    return numeroE164(raw);
  }

  if (ref.kind === 'g') {
    const maybeJid =
      cli?.remote_jid ||
      cli?.remoteJid ||
      cli?.jid ||
      cli?.grupo_jid ||
      cli?.grupoJid ||
      '';

    if (maybeJid && isJid(maybeJid)) return maybeJid;
  }

  return '';
}

function insertAtCursor(el, text) {
  if (!el) return;

  const start = el.selectionStart ?? (el.value || '').length;
  const end = el.selectionEnd ?? (el.value || '').length;
  const v = el.value || '';

  el.value = v.slice(0, start) + text + v.slice(end);

  const pos = start + text.length;
  if (typeof el.setSelectionRange === 'function') {
    el.setSelectionRange(pos, pos);
  }

  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
}

const humanFileSize = (bytes) => {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let u = 0;
  let v = bytes;

  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }

  const fixed = v >= 10 || u === 0 ? v.toFixed(0) : v.toFixed(1);
  return `${fixed} ${units[u]}`;
};

function toDataUrl(fileOrBlob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(fileOrBlob);
  });
}

function cleanDataUrl(s) {
  if (!s) return '';
  const i = s.indexOf(',');
  return i >= 0 ? s.slice(i + 1).trim() : s.trim();
}

function guessMediaType(mime) {
  if (!mime) return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

function guessMimeFromExt(name) {
  const ext = (name || '').split('.').pop()?.toLowerCase() || '';

  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'doc': return 'application/msword';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xls': return 'application/vnd.ms-excel';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'ppt': return 'application/vnd.ms-powerpoint';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'png': return 'image/png';
    case 'jpg': return 'image/jpeg';
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'mp4': return 'video/mp4';
    case 'mp3': return 'audio/mpeg';
    case 'ogg': return 'audio/ogg';
    case 'wav': return 'audio/wav';
    default: return 'application/octet-stream';
  }
}

/* ========= MODAIS ========= */
function mountDialog(html) {
  const wrap = document.createElement('div');
  wrap.className = 'zcDlgBackdrop';
  wrap.innerHTML = html;
  document.body.appendChild(wrap);

  requestAnimationFrame(() => {
    wrap.querySelector('.zcDlg')?.classList.add('show');
  });

  return wrap;
}

function inputDialog({ title, rows, okText = 'OK', cancelText = 'Cancelar' }) {
  return new Promise((res) => {
    const wrap = mountDialog(`
      <div class="zcDlg" role="dialog" aria-label="${title || 'Entrada'}">
        <div class="h">${title || ''}</div>
        <div class="b">
          ${rows.map((r) => `
            <div class="row">
              <label>${r.label || ''}</label>
              <input
                class="in"
                name="${r.name}"
                type="${r.type || 'text'}"
                placeholder="${r.placeholder || ''}"
                value="${r.value || ''}"
              >
            </div>
          `).join('')}
        </div>
        <div class="f">
          <button class="zcBtn ghost">${cancelText}</button>
          <button class="zcBtn ok">${okText}</button>
        </div>
      </div>
    `);

    const [btnCancel, btnOk] = wrap.querySelectorAll('.zcBtn');
    const inputs = [...wrap.querySelectorAll('.in')];

    const close = (val) => {
      wrap.remove();
      res(val);
    };

    btnCancel.onclick = () => close(null);
    btnOk.onclick = () => {
      const out = {};
      inputs.forEach((i) => {
        out[i.name] = i.value.trim();
      });
      close(out);
    };

    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close(null);
    });

    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        btnOk.click();
      }
    });

    setTimeout(() => inputs[0]?.focus(), 30);
  });
}

function applyInstanceFromResponse(resp) {
  const instName = resp?.instance_name ?? resp?.db?.instance_name ?? null;
  const instId = resp?.db?.instancia_id ?? resp?.instancia_id ?? null;
  const instFinal = instKey(instId ?? instName);

  if (!instFinal) return;

  freezeHistoricoInstancia(instFinal);

  if (!window.INSTANCIA_ATIVA) {
    window.INSTANCIA_ATIVA = instFinal;
  }

  try { window.setInstanceChip?.(instName ?? String(instId ?? '')); } catch {}
  try { window.zcUpdateInstBadge?.(); } catch {}
}

async function fetchJsonOrThrow(url, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  const respText = await r.text().catch(() => '');
  let respJson = null;
  try {
    respJson = respText ? JSON.parse(respText) : null;
  } catch {}

  if (!r.ok) {
    const rawMsg =
      (respJson && (respJson.detail ?? respJson.message ?? respJson.error)) ||
      respText ||
      null;

    const msg =
      stringifyErr(rawMsg) ||
      (r.status === 400 ? 'Dados inválidos (destino ou instância).' : 'Falha ao enviar.');

    throw new Error(msg);
  }

  return respJson || {};
}

/* =========================================================
   ACK: evita bolha ficar presa no reloginho depois do send ok
   ========================================================= */
function normalizeAck(v, fallback = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return fallback;
  return Math.min(4, Math.max(1, n));
}

function getAckFromSendResponse(resp, fallback = 1) {
  const candidates = [
    resp?.db?.ack,
    resp?.db?.ack_now,
    resp?.db?.ultima_ack,
    resp?.ack,
    resp?.ack_now,
    resp?.ultima_ack,
    resp?.message?.ack,
    resp?.mensagem?.ack,
    resp?.data?.ack,
  ];

  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') {
      return normalizeAck(c, fallback);
    }
  }

  return fallback;
}

function getMsgIdFromSendResponse(resp) {
  return (
    resp?.db?.msg_id ||
    resp?.db?.id ||
    resp?.db?.mensagem_id ||
    resp?.msg_id ||
    resp?.id ||
    resp?.mensagem_id ||
    resp?.message?.id ||
    resp?.message?.msg_id ||
    null
  );
}

function getTimestampFromSendResponse(resp) {
  return (
    resp?.db?.timestamp ||
    resp?.db?.hora ||
    resp?.timestamp ||
    resp?.hora ||
    resp?.created_at ||
    new Date().toISOString()
  );
}

function setAckHtmlOnElement(el, ack) {
  if (!el) return false;

  let ackEl =
    el.querySelector?.('.msg-ack') ||
    el.querySelector?.('.preview-ack') ||
    el.querySelector?.('[data-ack]') ||
    null;

  if (!ackEl) {
    const meta =
      el.querySelector?.('.msg-meta') ||
      el.querySelector?.('.message-meta') ||
      el.querySelector?.('.bubble-meta') ||
      el.querySelector?.('.hora') ||
      null;

    if (!meta) return false;

    ackEl = document.createElement('span');
    ackEl.className = 'msg-ack';
    meta.appendChild(ackEl);
  }

  ackEl.dataset.ack = String(ack);
  ackEl.setAttribute('data-ack', String(ack));

  if (typeof window.getAckIcon === 'function') {
    ackEl.innerHTML = window.getAckIcon(ack);
  } else {
    ackEl.textContent = ack >= 2 ? '✓✓' : '✓';
  }

  return true;
}

function updateLastOutgoingAckInDom({ conversationKey, msgId, ack }) {
  try {
    const hist = getHistoricoEl();
    if (!hist) return;

    const openKey =
      idKey(hist?.dataset?.conversationKey) ||
      idKey(hist?.dataset?.conversationId) ||
      idKey(hist?.dataset?.convKey) ||
      null;

    if (conversationKey && openKey && String(openKey) !== String(conversationKey)) return;

    const mid = idKey(msgId);
    let target = null;

    if (mid) {
      const safe = CSS.escape(String(mid));
      target =
        hist.querySelector(`[data-msg-id="${safe}"]`) ||
        hist.querySelector(`[data-message-id="${safe}"]`) ||
        hist.querySelector(`[data-id="${safe}"]`) ||
        hist.querySelector(`#msg-${safe}`) ||
        null;
    }

    if (!target) {
      const candidates = [
        ...hist.querySelectorAll(
          [
            '.msg.saida',
            '.mensagem.saida',
            '.message.saida',
            '.message.out',
            '.message.outgoing',
            '.bubble.saida',
            '.bubble.out',
            '.bubble-out',
            '.msg-out',
            '[data-tipo="saida"]',
            '[data-dir="out"]',
            '[data-from-me="true"]',
          ].join(',')
        )
      ];

      target = candidates[candidates.length - 1] || null;
    }

    if (target) {
      setAckHtmlOnElement(target, ack);
      target.dataset.ack = String(ack);
    }

    const pendingAckEls = [
      ...hist.querySelectorAll('.msg-ack[data-ack="0"], .preview-ack[data-ack="0"], [data-ack="0"]')
    ];

    const lastPending = pendingAckEls[pendingAckEls.length - 1] || null;
    if (lastPending) {
      lastPending.dataset.ack = String(ack);
      lastPending.setAttribute('data-ack', String(ack));

      if (typeof window.getAckIcon === 'function') {
        lastPending.innerHTML = window.getAckIcon(ack);
      } else {
        lastPending.textContent = ack >= 2 ? '✓✓' : '✓';
      }
    }
  } catch (e) {
    console.warn('[envio][ack-dom] falha ao atualizar ack visual', e);
  }
}

function previewLabelForMedia(mediaType, mime, caption = '') {
  const cap = String(caption || '').trim();
  if (cap) return cap;

  const mt = String(mediaType || '').toLowerCase();
  const mm = String(mime || '').toLowerCase();

  if (mt === 'audio' || mm.startsWith('audio/')) return '[Áudio]';
  if (mt === 'image' || mm.startsWith('image/')) return '[Foto]';
  if (mt === 'video' || mm.startsWith('video/')) return '[Vídeo]';
  if (mm.includes('pdf')) return '[PDF]';
  return '[Arquivo]';
}

function notifySuccessfulOutgoing({ convRef, resp, text }) {
  const ref = conversationRefOf(convRef?.key || convRef, convRef || null);
  if (!ref?.key) return 1;

  const ack = getAckFromSendResponse(resp, 1);
  const msgId = getMsgIdFromSendResponse(resp);
  const ts = getTimestampFromSendResponse(resp);
  const preview = String(text || '').trim();

  updateLastOutgoingAckInDom({
    conversationKey: ref.key,
    msgId,
    ack,
  });

  try {
    window.Lista?.updatePreview?.(ref.key, {
      texto: preview,
      ack,
      ts,
      timestamp: ts,
      last_ts: ts,
      instancia_id: ref.instId,
    });
  } catch {}

  try {
    window.dispatchEvent(new CustomEvent('zc:outgoing-ack', {
      detail: {
        conversation_key: ref.key,
        conversation_id: ref.key,
        kind: ref.kind,
        entity_id: ref.entityId,
        instancia_id: ref.instId,
        msg_id: msgId,
        ack,
        timestamp: ts,
      },
    }));
  } catch {}

  try {
    window.dispatchEvent(new CustomEvent('zc:message-sent', {
      detail: {
        conversation_key: ref.key,
        conversation_id: ref.key,
        kind: ref.kind,
        entity_id: ref.entityId,
        cliente_id: ref.kind === 'c' ? ref.entityId : undefined,
        grupo_id: ref.kind === 'g' ? ref.entityId : undefined,
        instancia_id: ref.instId,
        msg_id: msgId,
        ack,
        tipo: 'saida',
        direction: 'out',
        from_me: true,
        texto: preview,
        mensagem: preview,
        conteudo: preview,
        timestamp: ts,
        resp,
      },
    }));
  } catch {}

  return ack;
}

/* ===================== MAIN INIT ENVIO ===================== */
(function initEnvio() {
  const footer = document.getElementById('chat-footer') || document.body;
  const form = footer.closest('form');
  if (form) form.addEventListener('submit', (e) => e.preventDefault());

  let composer = document.getElementById('wa-composer');
  if (!composer) {
    composer = document.createElement('div');
    composer.id = 'wa-composer';
    composer.className = 'wa-composer';
    footer.appendChild(composer);
  }

  const btnClip = document.getElementById('btn-clipe') || (() => {
    const b = document.createElement('button');
    b.id = 'btn-clipe';
    b.type = 'button';
    b.className = 'wa-composer-btn wa-attach-btn';
    b.innerHTML = '<i class="fa fa-plus"></i>';
    composer.appendChild(b);
    return b;
  })();

  const btnEmoji = document.getElementById('btn-emoji') || (() => {
    const b = document.createElement('button');
    b.id = 'btn-emoji';
    b.type = 'button';
    b.className = 'wa-composer-btn wa-emoji-btn';
    b.innerHTML = '<i class="fa-regular fa-face-smile"></i>';
    composer.appendChild(b);
    return b;
  })();

  const inputMsg = document.getElementById('mensagem') || (() => {
    const i = document.createElement('input');
    i.id = 'mensagem';
    i.className = 'wa-composer-input';
    i.placeholder = 'Digite uma mensagem';
    composer.appendChild(i);
    return i;
  })();

  const btnAction = document.getElementById('btn-enviar') || (() => {
    const b = document.createElement('button');
    b.id = 'btn-enviar';
    b.type = 'button';
    b.className = 'wa-composer-btn wa-action-btn';
    b.innerHTML = '<i class="fa-solid fa-microphone"></i>';
    composer.appendChild(b);
    return b;
  })();

  if (btnClip.parentElement !== composer) composer.appendChild(btnClip);
  if (btnEmoji.parentElement !== composer) composer.appendChild(btnEmoji);
  if (inputMsg.parentElement !== composer) composer.appendChild(inputMsg);
  if (btnAction.parentElement !== composer) composer.appendChild(btnAction);

  const inputArquivoLegacy = document.getElementById('input-arquivo') || (() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.id = 'input-arquivo';
    i.style.display = 'none';
    footer.appendChild(i);
    return i;
  })();

  const fileDoc = document.getElementById('file-doc') || (() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.id = 'file-doc';
    i.style.display = 'none';
    i.accept = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,application/*';
    footer.appendChild(i);
    return i;
  })();

  const fileMedia = document.getElementById('file-media') || (() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.id = 'file-media';
    i.style.display = 'none';
    i.accept = 'image/*,video/*';
    footer.appendChild(i);
    return i;
  })();

  const fileAudio = document.getElementById('file-audio') || (() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.id = 'file-audio';
    i.style.display = 'none';
    i.accept = 'audio/*';
    footer.appendChild(i);
    return i;
  })();

  let attachMenu = null;
  let emojiPop = null;
  let rec = null;
  let recStream = null;
  let recChunks = [];
  let recTimer = null;
  let recInstPayload = null;
  let recConversationKey = null;
  let recShouldSend = false;
  let recShouldDiscard = false;
  let recElapsedBaseMs = 0;
  let recResumeStartedAt = 0;

  let recBar = null;
  let recTimeEl = null;
  let recPauseBtn = null;
  let recCancelBtn = null;
  let recSendBtn = null;

  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let timeData = null;
  let waveBars = [];
  let waveAnimId = 0;

  let sendingBusy = false;
  let accessLocked = false;
  let accessReason = '';
  const defaultInputPlaceholder = inputMsg.getAttribute('placeholder') || 'Digite uma mensagem';

  function getSelectedConversationRef() {
    const cli = getConversationById();
    return conversationRefOf(cli || getSelectedConversationKey(), cli || null);
  }

  function getAcceptBtn() {
    return document.getElementById('btnAceitarConversa');
  }

  function getReleaseBtn() {
    return document.getElementById('btnLiberarConversa');
  }

  function getTransferBtn() {
    return document.getElementById('btnTransferirColaborador');
  }

  function isHidden(el) {
    if (!el) return true;
    if (el.hidden) return true;
    const style = window.getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  }

  function btnText(el) {
    if (!el) return '';
    return String(el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function getForceUnlockedKey() {
    return idKey(window.__zcComposerForceUnlockedFor || null);
  }

  function setForceUnlockedKey(key) {
    const k = idKey(key);
    if (k) window.__zcComposerForceUnlockedFor = k;
    else delete window.__zcComposerForceUnlockedFor;
  }

  function unlockComposerOptimistically(conversationKey = null) {
    const ref = conversationRefOf(conversationKey || getSelectedConversationKey(), getCurrentSelectedObject());
    if (!ref?.key) return;
    setForceUnlockedKey(ref.key);
    if (getSelectedConversationRef()?.key === ref.key) {
      setComposerLocked(false, '');
    }
  }

  function clearComposerOptimisticUnlock(conversationKey = null) {
    const ref = conversationRefOf(conversationKey || getSelectedConversationKey(), getCurrentSelectedObject());
    const forced = getForceUnlockedKey();
    if (!forced) return;
    if (!ref?.key || forced === ref.key) {
      setForceUnlockedKey(null);
    }
  }

  function isUiAcceptedForConversation(conversationRef = null) {
    const ref = conversationRefOf(conversationRef || getSelectedConversationKey(), getCurrentSelectedObject());
    if (!ref?.key) return false;
    if (ref.kind === 'g') return true;

    const btnAceitar = getAcceptBtn();
    const btnLiberar = getReleaseBtn();

    if (!btnAceitar && !btnLiberar) return false;

    const aceitarVisible = !isHidden(btnAceitar);
    const liberarVisible = !isHidden(btnLiberar);

    if (liberarVisible) return true;
    if (btnAceitar?.classList.contains('is-accepted')) return true;

    const txt = btnText(btnAceitar);
    if (txt.includes('aceita')) return true;

    return false;
  }

  function ensureActionIcon() {
    let icon = btnAction.querySelector('i');
    if (!icon) {
      icon = document.createElement('i');
      btnAction.innerHTML = '';
      btnAction.appendChild(icon);
    }
    return icon;
  }

  function setActionState(mode) {
    const icon = ensureActionIcon();

    btnAction.classList.remove('is-send', 'is-recording', 'is-locked');

    if (mode === 'recording') {
      btnAction.classList.add('is-recording');
      icon.className = 'fa-solid fa-stop';
      btnAction.title = 'Parar gravação';
      btnAction.setAttribute('aria-label', 'Parar gravação');
      return;
    }

    if (mode === 'send') {
      btnAction.classList.add('is-send');
      icon.className = 'fa-solid fa-paper-plane';
      btnAction.title = 'Enviar';
      btnAction.setAttribute('aria-label', 'Enviar');
      return;
    }

    if (mode === 'locked') {
      btnAction.classList.add('is-locked');
      icon.className = 'fa-solid fa-lock';
      btnAction.title = accessReason || 'Aceite a conversa para responder';
      btnAction.setAttribute('aria-label', accessReason || 'Aceite a conversa para responder');
      return;
    }

    icon.className = 'fa-solid fa-microphone';
    btnAction.title = 'Gravar áudio';
    btnAction.setAttribute('aria-label', 'Gravar áudio');
  }

  function applyComposerInteractiveState() {
    const disabledMain = !!sendingBusy || (!!accessLocked && !rec);

    composer.classList.toggle('is-locked', !!accessLocked);
    composer.dataset.locked = accessLocked ? '1' : '0';

    inputMsg.disabled = !!disabledMain;
    btnAction.disabled = !!disabledMain && !rec;
    btnClip.disabled = !!disabledMain || !!rec;
    btnEmoji.disabled = !!disabledMain || !!rec;

    fileDoc.disabled = !!disabledMain || !!rec;
    fileMedia.disabled = !!disabledMain || !!rec;
    fileAudio.disabled = !!disabledMain || !!rec;
    inputArquivoLegacy.disabled = !!disabledMain || !!rec;

    if (accessLocked) {
      inputMsg.placeholder = accessReason || 'Aceite a conversa para responder';
    } else {
      inputMsg.placeholder = defaultInputPlaceholder;
    }

    if (rec) {
      setActionState('recording');
      return;
    }

    if (accessLocked) {
      setActionState('locked');
      return;
    }

    const hasText = String(inputMsg.value || '').trim().length > 0;
    setActionState(hasText ? 'send' : 'mic');
  }

  function setSendingBusy(flag) {
    sendingBusy = !!flag;
    applyComposerInteractiveState();
  }

  function setComposerLocked(flag, reason = '') {
    accessLocked = !!flag;
    accessReason = flag ? String(reason || 'Aceite a conversa para responder').trim() : '';
    applyComposerInteractiveState();
  }

  function getMetaGetter() {
    return typeof window.getConversationMeta === 'function'
      ? window.getConversationMeta
      : null;
  }

  function getMetaRefresher() {
    return typeof window.refreshConversationMeta === 'function'
      ? window.refreshConversationMeta
      : null;
  }

  function normalizeMetaForUi(meta, conversationRef = null) {
    const ref = conversationRefOf(conversationRef || getSelectedConversationRef(), getCurrentSelectedObject());
    const isGroup = meta?.is_group === true || ref.kind === 'g';

    if (isGroup) {
      return {
        can_send: true,
        can_accept: false,
        accepted_by_me: true,
        accepted_by_anyone: false,
        is_group: true,
        operador_nome: null,
        participation_count: 0,
        conversation_key: ref.key,
      };
    }

    const acceptedByMe = Boolean(
      meta?.accepted_by_me ??
      meta?.ja_aceita_por_mim ??
      meta?.acceptedByMe ??
      meta?.aceita_por_mim ??
      false
    );

    const acceptedByAnyone = Boolean(
      meta?.accepted_by_anyone ??
      meta?.ja_aceita_por_alguem ??
      meta?.acceptedByAnyone ??
      meta?.tem_participantes ??
      (Array.isArray(meta?.participantes) && meta.participantes.length > 0)
    );

    const canSendRaw =
      meta?.can_send ??
      meta?.pode_enviar ??
      meta?.pode_responder ??
      meta?.canReply;

    const canAcceptRaw =
      meta?.can_accept ??
      meta?.pode_aceitar ??
      meta?.canAccept;

    const canSend = canSendRaw != null
      ? Boolean(canSendRaw)
      : acceptedByMe;

    const canAccept = canAcceptRaw != null
      ? Boolean(canAcceptRaw)
      : !acceptedByMe;

    return {
      can_send: canSend,
      can_accept: canAccept,
      accepted_by_me: acceptedByMe,
      accepted_by_anyone: acceptedByAnyone,
      is_group: false,
      operador_nome: meta?.operador_nome ?? meta?.owner_nome ?? null,
      participation_count: Number(meta?.participation_count ?? meta?.participant_count ?? 0),
      conversation_key: meta?.conversation_key ?? ref.key,
      raw: meta || {},
    };
  }

  function lockReasonFromMeta(meta) {
    const m = normalizeMetaForUi(meta);
    if (m.is_group) return '';

    if (m.accepted_by_me) return '';
    if (m.accepted_by_anyone) return 'Aceite a conversa para também responder';
    return 'Aceite a conversa para responder';
  }

  function applyMetaToComposer(meta, conversationRef = null) {
    const selectedRef = getSelectedConversationRef();
    const targetRef = conversationRefOf(conversationRef || meta?.conversation_key || selectedRef, getCurrentSelectedObject());

    if (!selectedRef?.key || !targetRef?.key || selectedRef.key !== targetRef.key) {
      return;
    }

    const normalized = normalizeMetaForUi(meta, targetRef.key);

    if (normalized.is_group) {
      clearComposerOptimisticUnlock(targetRef.key);
      setComposerLocked(false, '');
      return;
    }

    if (normalized.accepted_by_me || normalized.can_send === true) {
      unlockComposerOptimistically(targetRef.key);
      setComposerLocked(false, '');
      return;
    }

    clearComposerOptimisticUnlock(targetRef.key);
    setComposerLocked(true, lockReasonFromMeta(normalized));
  }

  async function refreshComposerAccess(conversationRef = null, { silent = false, force = false } = {}) {
    const ref = conversationRefOf(conversationRef || getSelectedConversationKey(), getCurrentSelectedObject());
    if (!ref?.key) {
      setComposerLocked(false, '');
      return null;
    }

    if (ref.kind === 'g') {
      clearComposerOptimisticUnlock(ref.key);
      setComposerLocked(false, '');
      return {
        is_group: true,
        can_send: true,
        can_accept: false,
        accepted_by_me: true,
        accepted_by_anyone: false,
        conversation_key: ref.key,
      };
    }

    const forced = getForceUnlockedKey();
    if (forced && forced === ref.key) {
      setComposerLocked(false, '');
      return {
        is_group: false,
        can_send: true,
        can_accept: false,
        accepted_by_me: true,
        accepted_by_anyone: true,
        conversation_key: ref.key,
        optimistic: true,
      };
    }

    if (isUiAcceptedForConversation(ref.key)) {
      unlockComposerOptimistically(ref.key);
      setComposerLocked(false, '');
      return {
        is_group: false,
        can_send: true,
        can_accept: false,
        accepted_by_me: true,
        accepted_by_anyone: true,
        conversation_key: ref.key,
        from_ui: true,
      };
    }

    const getter = getMetaGetter();
    const refresher = getMetaRefresher();

    let meta = !force && getter ? getter(ref.key) : null;

    if ((!meta || force) && refresher) {
      try {
        meta = await refresher(ref.key);
      } catch (e) {
        if (!silent) {
          console.warn('[envio] refreshComposerAccess: falha ao buscar meta', e);
        }
      }
    }

    if (meta) {
      const normalized = normalizeMetaForUi(meta, ref.key);

      if (normalized.accepted_by_me || normalized.can_send === true) {
        unlockComposerOptimistically(ref.key);
        setComposerLocked(false, '');
      } else {
        clearComposerOptimisticUnlock(ref.key);
        setComposerLocked(true, lockReasonFromMeta(normalized));
      }

      return normalized;
    }

    if (isUiAcceptedForConversation(ref.key)) {
      unlockComposerOptimistically(ref.key);
      setComposerLocked(false, '');
      return {
        is_group: false,
        can_send: true,
        can_accept: false,
        accepted_by_me: true,
        accepted_by_anyone: true,
        conversation_key: ref.key,
        from_ui_fallback: true,
      };
    }

    if (!silent) {
      setComposerLocked(true, 'Aceite a conversa para responder');
    }

    return null;
  }

  async function ensureCanSendConversation(conversationRef = null, { silentToast = false } = {}) {
    const safeRef = assertSendTargetStillOpen(conversationRef, { silent: silentToast });
    if (!safeRef) return false;

    const ref = conversationRefOf(safeRef.key, getCurrentSelectedObject());

    if (!ref?.key) {
      if (!silentToast) toast('Selecione uma conversa.', false);
      return false;
    }

    if (ref.kind === 'g') {
      clearComposerOptimisticUnlock(ref.key);
      setComposerLocked(false, '');
      return true;
    }

    const forced = getForceUnlockedKey();
    if (forced && forced === ref.key) {
      setComposerLocked(false, '');
      return true;
    }

    if (isUiAcceptedForConversation(ref.key)) {
      unlockComposerOptimistically(ref.key);
      setComposerLocked(false, '');
      return true;
    }

    const meta = await refreshComposerAccess(ref.key, { silent: true });

    if (!meta) {
      if (isUiAcceptedForConversation(ref.key)) {
        unlockComposerOptimistically(ref.key);
        setComposerLocked(false, '');
        return true;
      }

      setComposerLocked(true, 'Aceite a conversa para responder');
      if (!silentToast) toast('Aceite a conversa para responder', false);
      return false;
    }

    if (meta.can_send === false && !meta.accepted_by_me) {
      const reason = lockReasonFromMeta(meta);
      setComposerLocked(true, reason);

      if (!silentToast) {
        toast(reason, false);
      }

      try {
        window.dispatchEvent(new CustomEvent('atendimento:need-accept', {
          detail: {
            conversation_key: ref.key,
            entity_id: ref.entityId,
            kind: ref.kind,
            meta,
          }
        }));
      } catch {}

      return false;
    }

    setComposerLocked(false, '');
    return true;
  }

  function closeAttachMenu() {
    if (!attachMenu) return;
    attachMenu.classList.add('hidden');
    attachMenu.classList.remove('show');
    attachMenu.style.display = '';
    attachMenu.style.visibility = '';
  }

  function closeEmojiPop() {
    if (!emojiPop) return;
    emojiPop.classList.remove('show');
    emojiPop.style.display = '';
    emojiPop.style.visibility = '';
  }

  function hideAllPopups(except = null) {
    if (except !== 'attach') closeAttachMenu();
    if (except !== 'emoji') closeEmojiPop();
  }

  function placePopupFixed(popup, anchor, { gap = 8, minLeft = 12 } = {}) {
    if (!popup || !anchor) return;

    popup.style.position = 'fixed';
    popup.style.right = 'auto';
    popup.style.bottom = 'auto';
    popup.style.zIndex = popup.id === 'emoji-pop' ? '9999' : '9998';

    const prevVisibility = popup.style.visibility;
    const prevDisplay = popup.style.display;

    popup.style.visibility = 'hidden';
    popup.style.display = 'block';

    const rect = anchor.getBoundingClientRect();
    const popupWidth = Math.max(popup.offsetWidth || 260, 180);
    const popupHeight = Math.max(popup.offsetHeight || 100, 80);

    let left = rect.left;
    if (left + popupWidth > window.innerWidth - 12) {
      left = window.innerWidth - popupWidth - 12;
    }
    if (left < minLeft) left = minLeft;

    let top = rect.top - popupHeight - gap;
    if (top < 12) top = rect.bottom + gap;
    if (top + popupHeight > window.innerHeight - 12) {
      top = Math.max(12, window.innerHeight - popupHeight - 12);
    }

    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;

    popup.style.visibility = prevVisibility || '';
    popup.style.display = prevDisplay || '';
  }

  function openAttachMenu() {
    if (!attachMenu || accessLocked || sendingBusy || rec) return;
    hideAllPopups('attach');
    attachMenu.classList.remove('hidden');
    attachMenu.classList.add('show');
    placePopupFixed(attachMenu, btnClip);
  }

  function openEmojiPop() {
    if (!emojiPop || accessLocked || sendingBusy || rec) return;
    hideAllPopups('emoji');
    emojiPop.classList.add('show');
    placePopupFixed(emojiPop, btnEmoji);
  }

  function fmtElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function ensureRecorderUI() {
    if (recBar) return;

    recBar = document.createElement('div');
    recBar.className = 'wa-recorder';
    recBar.innerHTML = `
      <button
        type="button"
        class="wa-recorder-btn wa-recorder-cancel"
        title="Cancelar áudio"
        aria-label="Cancelar áudio">
        <i class="fa-regular fa-trash-can"></i>
      </button>

      <span class="wa-recorder-dot" aria-hidden="true"></span>
      <span class="wa-recorder-time">0:00</span>
      <div class="wa-recorder-wave" aria-hidden="true"></div>

      <button
        type="button"
        class="wa-recorder-btn wa-recorder-pause"
        title="Pausar gravação"
        aria-label="Pausar gravação">
        <i class="fa-solid fa-pause"></i>
      </button>

      <button
        type="button"
        class="wa-recorder-btn wa-recorder-send"
        title="Enviar áudio"
        aria-label="Enviar áudio">
        <i class="fa-solid fa-paper-plane"></i>
      </button>
    `;

    composer.appendChild(recBar);

    recTimeEl = recBar.querySelector('.wa-recorder-time');
    recPauseBtn = recBar.querySelector('.wa-recorder-pause');
    recCancelBtn = recBar.querySelector('.wa-recorder-cancel');
    recSendBtn = recBar.querySelector('.wa-recorder-send');

    recPauseBtn.addEventListener('click', () => {
      togglePauseRecordingAudio();
    });

    recCancelBtn.addEventListener('click', () => {
      cancelRecordingAudio();
    });

    recSendBtn.addEventListener('click', () => {
      sendRecordingAudio();
    });
  }

  function ensureWaveBars() {
    if (!recBar) return;

    const wave = recBar.querySelector('.wa-recorder-wave');
    if (!wave) return;

    if (wave.dataset.ready === '1') {
      waveBars = Array.from(wave.querySelectorAll('.wa-recorder-wave-bar'));
      return;
    }

    wave.innerHTML = '';
    for (let i = 0; i < 34; i++) {
      const bar = document.createElement('span');
      bar.className = 'wa-recorder-wave-bar';
      wave.appendChild(bar);
    }

    wave.dataset.ready = '1';
    waveBars = Array.from(wave.querySelectorAll('.wa-recorder-wave-bar'));
    resetWaveBars();
  }

  function resetWaveBars() {
    if (!waveBars.length) return;

    waveBars.forEach((bar, i) => {
      const base = 6 + (i % 4 === 0 ? 2 : 0);
      bar.style.height = `${base}px`;
      bar.style.opacity = '0.40';
      bar.style.transform = 'scaleY(1)';
    });
  }

  async function initRecorderVisualizer(stream) {
    destroyRecorderVisualizer();

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    ensureWaveBars();

    audioCtx = new AudioCtx();
    sourceNode = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.82;

    sourceNode.connect(analyser);
    timeData = new Uint8Array(analyser.fftSize);

    startRecorderVisualizer();
  }

  function startRecorderVisualizer() {
    if (!analyser || !timeData || !waveBars.length) return;

    cancelAnimationFrame(waveAnimId);

    const loop = () => {
      if (!analyser || !timeData) return;

      analyser.getByteTimeDomainData(timeData);

      let sum = 0;
      for (let i = 0; i < timeData.length; i++) {
        const v = (timeData[i] - 128) / 128;
        sum += v * v;
      }

      const rms = Math.sqrt(sum / timeData.length);
      const level = Math.max(0, Math.min(1, (rms - 0.01) * 12));
      const now = Date.now();

      waveBars.forEach((bar, i) => {
        const motionA = (Math.sin(now / 120 + i * 0.55) + 1) / 2;
        const motionB = (Math.sin(now / 180 + i * 0.25) + 1) / 2;
        const motion = (motionA * 0.65) + (motionB * 0.35);

        const minH = 5;
        const maxExtra = 18 + (level * 16);
        const h = minH + Math.round(maxExtra * motion * Math.max(0.18, level));

        bar.style.height = `${h}px`;
        bar.style.opacity = `${0.30 + Math.min(0.70, level * 0.95 + motion * 0.12)}`;
        bar.style.transform = `scaleY(${1 + level * 0.08})`;
      });

      waveAnimId = requestAnimationFrame(loop);
    };

    loop();
  }

  function pauseRecorderVisualizer() {
    cancelAnimationFrame(waveAnimId);
    waveAnimId = 0;
    resetWaveBars();
  }

  function destroyRecorderVisualizer() {
    cancelAnimationFrame(waveAnimId);
    waveAnimId = 0;

    try { sourceNode?.disconnect?.(); } catch {}
    try { analyser?.disconnect?.(); } catch {}

    sourceNode = null;
    analyser = null;
    timeData = null;

    if (audioCtx && typeof audioCtx.close === 'function') {
      audioCtx.close().catch(() => {});
    }
    audioCtx = null;

    resetWaveBars();
  }

  function showRecorderUI() {
    ensureRecorderUI();
    ensureWaveBars();
    composer.classList.add('is-recording-mode');
    updateRecorderTimer();
    syncRecorderPauseButton();
  }

  function hideRecorderUI() {
    composer.classList.remove('is-recording-mode');
  }

  function getRecorderElapsedMs() {
    return recElapsedBaseMs + (
      rec && rec.state === 'recording' && recResumeStartedAt
        ? (Date.now() - recResumeStartedAt)
        : 0
    );
  }

  function updateRecorderTimer() {
    if (!recTimeEl) return;
    recTimeEl.textContent = fmtElapsed(getRecorderElapsedMs());
  }

  function startRecorderTick() {
    stopRecorderTick();
    recTimer = setInterval(updateRecorderTimer, 250);
    updateRecorderTimer();
  }

  function stopRecorderTick() {
    clearInterval(recTimer);
    recTimer = null;
  }

  function syncRecorderPauseButton() {
    if (!recPauseBtn) return;
    const paused = !!rec && rec.state === 'paused';
    const icon = recPauseBtn.querySelector('i');

    if (icon) icon.className = paused ? 'fa-solid fa-play' : 'fa-solid fa-pause';

    recPauseBtn.title = paused ? 'Continuar gravação' : 'Pausar gravação';
    recPauseBtn.setAttribute(
      'aria-label',
      paused ? 'Continuar gravação' : 'Pausar gravação'
    );
  }

  function teardownRecorderStream() {
    recStream?.getTracks()?.forEach((t) => t.stop());
    recStream = null;
  }

  function resetRecorderState() {
    stopRecorderTick();
    destroyRecorderVisualizer();
    rec = null;
    recChunks = [];
    recInstPayload = null;
    recConversationKey = null;
    recShouldSend = false;
    recShouldDiscard = false;
    recElapsedBaseMs = 0;
    recResumeStartedAt = 0;
    hideRecorderUI();
    applyComposerInteractiveState();
    try { window.focusComposer?.(); } catch {}
  }

  function cancelRecordingAudio() {
    if (!rec) {
      resetRecorderState();
      return;
    }

    recShouldDiscard = true;
    recShouldSend = false;

    try {
      if (rec.state !== 'inactive') rec.stop();
      else resetRecorderState();
    } catch (e) {
      console.error('[audio/cancel] erro', e);
      resetRecorderState();
    }
  }

  function sendRecordingAudio() {
    if (!rec) return;

    recShouldSend = true;
    recShouldDiscard = false;

    try {
      if (rec.state !== 'inactive') rec.stop();
    } catch (e) {
      console.error('[audio/send] erro ao parar', e);
      resetRecorderState();
    }
  }

  function togglePauseRecordingAudio() {
    if (!rec) return;

    try {
      if (rec.state === 'recording') {
        rec.pause();
      } else if (rec.state === 'paused') {
        rec.resume();
      }
    } catch (e) {
      console.error('[audio] erro ao pausar/continuar', e);
    }
  }

  async function openFilePreview(fileList, explicitType = null) {
    const safeRef = assertSendTargetStillOpen();
    if (!safeRef) return;
    if (!(await ensureCanSendConversation(safeRef.key))) return;

    const files = Array.from(fileList || []).filter((f) => f && f.size >= 0);
    if (!files.length) return;

    const wrap = mountDialog(`
      <div class="zcDlg zcDlg-filePreview" role="dialog" aria-label="Enviar arquivo">
        <div class="h">Enviar ${files.length > 1 ? 'arquivos' : 'arquivo'}</div>
        <div class="b">
          <div class="zpPrev">
            <div class="zpPrev-main">
              <div class="zpPrev-thumb"></div>
              <div class="zpPrev-meta">
                <div class="zpPrev-name"></div>
                <div class="zpPrev-info"></div>
              </div>
            </div>
            <div class="zpPrev-caption-row">
              <textarea class="zpPrev-caption" placeholder="Digite uma legenda (opcional)…"></textarea>
            </div>
            ${files.length > 1 ? `
              <div class="zpPrev-list">
                <div>${files.length} arquivos selecionados:</div>
                <ul class="zpPrev-ul"></ul>
              </div>
            ` : ''}
          </div>
        </div>
        <div class="f">
          <button class="zcBtn ghost zpPrev-cancel">Cancelar</button>
          <button class="zcBtn ok zpPrev-send">Enviar</button>
        </div>
      </div>
    `);

    const thumb = wrap.querySelector('.zpPrev-thumb');
    const nameEl = wrap.querySelector('.zpPrev-name');
    const infoEl = wrap.querySelector('.zpPrev-info');
    const capEl = wrap.querySelector('.zpPrev-caption');
    const listUl = wrap.querySelector('.zpPrev-ul');
    const btnCanc = wrap.querySelector('.zpPrev-cancel');
    const btnSendPrev = wrap.querySelector('.zpPrev-send');

    const first = files[0];
    const mime = first.type || guessMimeFromExt(first.name);
    const typeLabel = mime || 'arquivo';

    nameEl.textContent = first.name || 'Arquivo';
    infoEl.textContent = [humanFileSize(first.size), typeLabel].filter(Boolean).join(' • ');

    thumb.innerHTML = '';
    if (mime && mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.alt = first.name || 'imagem';
      const fr = new FileReader();
      fr.onload = () => { img.src = fr.result; };
      fr.readAsDataURL(first);
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '<i class="fa-regular fa-file-lines"></i>';
      thumb.style.fontSize = '28px';
    }

    if (listUl) {
      files.forEach((f) => {
        const li = document.createElement('li');
        li.textContent = `${f.name || 'Arquivo'} (${humanFileSize(f.size)})`;
        listUl.appendChild(li);
      });
    }

    const close = () => wrap.remove();

    btnCanc.addEventListener('click', close);

    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close();
    });

    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });

    btnSendPrev.addEventListener('click', async () => {
      const safeBeforeSend = assertSendTargetStillOpen(safeRef.key);
      if (!safeBeforeSend) return;

      const caption = capEl.value.trim() || undefined;
      btnSendPrev.disabled = true;
      btnSendPrev.textContent = 'Enviando…';

      try {
        for (const f of files) {
          await enviarMediaArquivo(f, explicitType, caption);
        }
        close();
      } finally {
        btnSendPrev.disabled = false;
        btnSendPrev.textContent = 'Enviar';
      }
    });

    setTimeout(() => capEl?.focus(), 30);
  }

  async function enviarTexto() {
    const text = (inputMsg.value || '').trim();
    if (!text) return;
    if (!ensureClienteSel()) return;

    const safeRef = assertSendTargetStillOpen();
    if (!safeRef) return;

    if (!(await ensureCanSendConversation(safeRef.key))) return;

    const cli = getConversationById(safeRef.key);
    const convRef = conversationRefOf(cli || safeRef.key, cli || null);
    const dest = numberForApi(convRef.key);

    if (!dest) {
      toast('Destino inválido (telefone ou grupo). Verifique o cadastro.', false);
      console.warn('[send/text] numberForApi retornou vazio', { cli });
      return;
    }

    const inst = requireInstPayloadOrWarn(convRef.key);
    if (!inst) return;

    setSendingBusy(true);

    try {
      const payload = stripUndefined({
        empresa_id: EMPRESA_ID || undefined,
        ...getIdentityPayload(cli || convRef.key),
        number: dest,
        text,
        ...inst,
      });

      window.__debugLastSendPayload = payload;

      const resp = await fetchJsonOrThrow('/api/atendimento/send/text', payload);
      applyInstanceFromResponse(resp);

      /*
        FIX PRINCIPAL:
        Se a API respondeu OK, a mensagem não deve continuar com relógio.
        ack mínimo visual = 1.
        Depois os eventos da Evolution atualizam para entregue/lida.
      */
      notifySuccessfulOutgoing({
        convRef,
        resp,
        text,
      });

      inputMsg.value = '';

      try {
        window.dispatchEvent(new CustomEvent('atendimento:refresh-meta', {
          detail: { conversation_key: convRef.key }
        }));
      } catch {}

      try { window.focusComposer?.(); } catch {}
    } catch (e) {
      console.error('[send/text] erro', e);
      toast(e?.message || 'Falha ao enviar.', false);
    } finally {
      setSendingBusy(false);
      applyComposerInteractiveState();
    }
  }

  async function enviarMediaArquivo(file, explicitType = null, captionOverride = null) {
    if (!ensureClienteSel() || !file) return;

    const safeRef = assertSendTargetStillOpen();
    if (!safeRef) return;

    if (!(await ensureCanSendConversation(safeRef.key))) return;

    const cli = getConversationById(safeRef.key);
    const convRef = conversationRefOf(cli || safeRef.key, cli || null);
    const inst = requireInstPayloadOrWarn(convRef.key);
    if (!inst) return;

    const caption =
      captionOverride != null
        ? captionOverride
        : (inputMsg.value || '').trim() || undefined;

    const number = numberForApi(convRef.key);
    if (!number) {
      toast('Destino inválido (telefone ou grupo). Verifique o cadastro.', false);
      return;
    }

    const mime = file.type || guessMimeFromExt(file.name);
    const mediaType = explicitType || guessMediaType(mime);
    const dataUrl = await toDataUrl(file);
    const base64 = cleanDataUrl(dataUrl);

    try {
      setSendingBusy(true);

      if (mediaType === 'audio') {
        const resp = await fetchJsonOrThrow('/api/atendimento/send/audio', stripUndefined({
          empresa_id: EMPRESA_ID,
          ...getIdentityPayload(cli || convRef.key),
          number,
          audio: base64,
          ...inst,
        }));

        applyInstanceFromResponse(resp);

        notifySuccessfulOutgoing({
          convRef,
          resp,
          text: '[Áudio]',
        });
      } else {
        const body = stripUndefined({
          empresa_id: EMPRESA_ID,
          ...getIdentityPayload(cli || convRef.key),
          number,
          media: base64,
          mediatype: mediaType,
          mimetype: mime,
          fileName: file.name || undefined,
          caption,
          ...inst,
        });

        const resp = await fetchJsonOrThrow('/api/atendimento/send/media', body);
        applyInstanceFromResponse(resp);

        notifySuccessfulOutgoing({
          convRef,
          resp,
          text: previewLabelForMedia(mediaType, mime, caption),
        });

        if (caption && captionOverride != null) {
          inputMsg.value = '';
        }
      }

      try {
        window.dispatchEvent(new CustomEvent('atendimento:refresh-meta', {
          detail: { conversation_key: convRef.key }
        }));
      } catch {}

      toast('Arquivo enviado!', true);
      try { window.focusComposer?.(); } catch {}
    } catch (e) {
      console.error('[send/media|audio]', e);
      toast(e?.message || 'Falha ao enviar arquivo.', false);
    } finally {
      setSendingBusy(false);
      applyComposerInteractiveState();
    }
  }

  async function openContactPrompt() {
    if (!ensureClienteSel()) return;

    const safeRef = assertSendTargetStillOpen();
    if (!safeRef) return;

    if (!(await ensureCanSendConversation(safeRef.key))) return;

    const cli = getConversationById(safeRef.key);
    const convRef = conversationRefOf(cli || safeRef.key, cli || null);
    const inst = requireInstPayloadOrWarn(convRef.key);
    if (!inst) return;

    const data = await inputDialog({
      title: 'Enviar contato',
      rows: [
        { name: 'fullName', label: 'Nome', placeholder: 'Ex.: Maria Silva' },
        { name: 'phone', label: 'Telefone', placeholder: 'DDI+DDD+Número (só dígitos)' },
      ],
      okText: 'Enviar',
    });

    if (!data) return;

    const stillOpen = assertSendTargetStillOpen(convRef.key);
    if (!stillOpen) return;

    const contact = [{
      fullName: data.fullName || undefined,
      phoneNumber: onlyDigits(data.phone || '') || undefined,
    }];

    try {
      setSendingBusy(true);

      const resp = await fetchJsonOrThrow('/api/atendimento/send/contact', stripUndefined({
        empresa_id: EMPRESA_ID,
        ...getIdentityPayload(cli || convRef.key),
        number: numberForApi(convRef.key),
        contact,
        ...inst,
      }));

      applyInstanceFromResponse(resp);

      notifySuccessfulOutgoing({
        convRef,
        resp,
        text: '[Contato]',
      });

      toast('Contato enviado!', true);
      try { window.focusComposer?.(); } catch {}
    } catch (e) {
      console.error(e);
      toast(e?.message || 'Falha ao enviar contato.', false);
    } finally {
      setSendingBusy(false);
      applyComposerInteractiveState();
    }
  }

  async function openStickerPrompt() {
    if (!ensureClienteSel()) return;

    const safeRef = assertSendTargetStillOpen();
    if (!safeRef) return;

    if (!(await ensureCanSendConversation(safeRef.key))) return;

    const cli = getConversationById(safeRef.key);
    const convRef = conversationRefOf(cli || safeRef.key, cli || null);
    const inst = requireInstPayloadOrWarn(convRef.key);
    if (!inst) return;

    const data = await inputDialog({
      title: 'Enviar figurinha',
      rows: [{ name: 'st', label: 'URL / BASE64', placeholder: 'Cole a URL ou data:...' }],
      okText: 'Enviar',
    });

    if (!data || !data.st) return;

    const stillOpen = assertSendTargetStillOpen(convRef.key);
    if (!stillOpen) return;

    const s = String(data.st);
    const sticker = s.startsWith('data:') ? cleanDataUrl(s) : s.trim();

    try {
      setSendingBusy(true);

      const resp = await fetchJsonOrThrow('/api/atendimento/send/sticker', stripUndefined({
        empresa_id: EMPRESA_ID,
        ...getIdentityPayload(cli || convRef.key),
        number: numberForApi(convRef.key),
        sticker,
        ...inst,
      }));

      applyInstanceFromResponse(resp);

      notifySuccessfulOutgoing({
        convRef,
        resp,
        text: '[Figurinha]',
      });

      toast('Sticker enviado!', true);
      try { window.focusComposer?.(); } catch {}
    } catch (e) {
      console.error(e);
      toast(e?.message || 'Falha ao enviar figurinha.', false);
    } finally {
      setSendingBusy(false);
      applyComposerInteractiveState();
    }
  }

  async function startStopRecording() {
    if (rec) return;

    if (!ensureClienteSel()) return;

    const safeRef = assertSendTargetStillOpen();
    if (!safeRef) return;

    if (!(await ensureCanSendConversation(safeRef.key))) return;

    const cli = getConversationById(safeRef.key);
    const convRef = conversationRefOf(cli || safeRef.key, cli || null);
    const inst = requireInstPayloadOrWarn(convRef.key);
    if (!inst) return;

    recInstPayload = inst;
    recConversationKey = convRef.key;
    recShouldSend = false;
    recShouldDiscard = false;
    recElapsedBaseMs = 0;
    recResumeStartedAt = 0;

    try {
      hideAllPopups();
      ensureRecorderUI();

      try { inputMsg.blur(); } catch {}

      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await initRecorderVisualizer(recStream);

      rec = new MediaRecorder(recStream);
      recChunks = [];

      showRecorderUI();
      applyComposerInteractiveState();

      rec.ondataavailable = (e) => {
        if (e.data?.size) recChunks.push(e.data);
      };

      rec.onpause = () => {
        if (recResumeStartedAt) {
          recElapsedBaseMs += (Date.now() - recResumeStartedAt);
          recResumeStartedAt = 0;
        }

        pauseRecorderVisualizer();

        if (audioCtx?.state === 'running') {
          audioCtx.suspend().catch(() => {});
        }

        stopRecorderTick();
        updateRecorderTimer();
        syncRecorderPauseButton();
      };

      rec.onresume = () => {
        recResumeStartedAt = Date.now();

        if (audioCtx?.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }

        startRecorderVisualizer();
        startRecorderTick();
        syncRecorderPauseButton();
      };

      rec.onstop = async () => {
        const shouldSend = recShouldSend && !recShouldDiscard;
        const mimeType = rec?.mimeType || 'audio/webm';
        const chunks = recChunks.slice();

        if (recResumeStartedAt) {
          recElapsedBaseMs += (Date.now() - recResumeStartedAt);
          recResumeStartedAt = 0;
        }

        stopRecorderTick();
        updateRecorderTimer();
        teardownRecorderStream();

        try {
          if (shouldSend) {
            if (!chunks.length) {
              toast('Áudio vazio.', false);
            } else {
              const stillOpen = assertSendTargetStillOpen(recConversationKey, { silent: true });
              if (!stillOpen) {
                toast('Conversa mudou. Clique novamente no contato antes de enviar.', false);
              } else {
                const canSendNow = await ensureCanSendConversation(recConversationKey, { silentToast: true });
                if (!canSendNow) {
                  toast('Aceite a conversa para responder.', false);
                } else {
                  const blob = new Blob(chunks, { type: mimeType });
                  const dataUrl = await toDataUrl(blob);
                  const base64 = cleanDataUrl(dataUrl);

                  const number = numberForApi(recConversationKey);
                  if (!number) {
                    toast('Destino inválido (telefone ou grupo). Verifique o cadastro.', false);
                  } else {
                    const resp = await fetchJsonOrThrow('/api/atendimento/send/audio', stripUndefined({
                      empresa_id: EMPRESA_ID,
                      ...getIdentityPayload(recConversationKey),
                      number,
                      audio: base64,
                      ...(recInstPayload || {}),
                    }));

                    applyInstanceFromResponse(resp);

                    notifySuccessfulOutgoing({
                      convRef: conversationRefOf(recConversationKey, getCurrentSelectedObject()),
                      resp,
                      text: '[Áudio]',
                    });

                    toast('Áudio enviado!', true);
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error('[audio/send] erro', e);
          toast(e?.message || 'Falha ao enviar áudio.', false);
        } finally {
          resetRecorderState();
        }
      };

      rec.start();
      recResumeStartedAt = Date.now();
      startRecorderTick();
      updateRecorderTimer();
      syncRecorderPauseButton();
    } catch (e) {
      console.error('[audio/start] erro', e);
      destroyRecorderVisualizer();
      teardownRecorderStream();
      rec = null;
      recChunks = [];
      recShouldSend = false;
      recShouldDiscard = false;
      recInstPayload = null;
      recConversationKey = null;
      recElapsedBaseMs = 0;
      recResumeStartedAt = 0;
      hideRecorderUI();
      applyComposerInteractiveState();
      toast('Permissão de microfone negada.', false);
    }
  }

  btnAction.addEventListener('click', async () => {
    if (accessLocked && !rec) {
      await ensureCanSendConversation();
      return;
    }

    if (rec) return;

    const hasText = (inputMsg.value || '').trim().length > 0;
    if (hasText) {
      await enviarTexto();
    } else {
      await startStopRecording();
    }
  });

  inputMsg.addEventListener('input', applyComposerInteractiveState);

  inputMsg.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if ((inputMsg.value || '').trim()) {
        await enviarTexto();
      }
    }
  });

  if (!attachMenu) {
    attachMenu = document.createElement('div');
    attachMenu.id = 'attach-menu';
    attachMenu.className = 'attach-pop hidden';
    attachMenu.innerHTML = `
      <div class="attach-item" data-act="doc">
        <span class="attach-ico"><i class="fa-regular fa-file-lines"></i></span>
        <span class="attach-lab">Documento</span>
      </div>
      <div class="attach-item" data-act="media">
        <span class="attach-ico"><i class="fa-regular fa-image"></i></span>
        <span class="attach-lab">Fotos e vídeos</span>
      </div>
      <div class="attach-item" data-act="camera">
        <span class="attach-ico"><i class="fa-solid fa-camera"></i></span>
        <span class="attach-lab">Câmera</span>
      </div>
      <div class="attach-sep"></div>
      <div class="attach-item" data-act="audio-file">
        <span class="attach-ico"><i class="fa-solid fa-file-audio"></i></span>
        <span class="attach-lab">Áudio (arquivo)</span>
      </div>
      <div class="attach-item" data-act="audio-record">
        <span class="attach-ico"><i class="fa-solid fa-microphone"></i></span>
        <span class="attach-lab">Gravar áudio</span>
      </div>
      <div class="attach-sep"></div>
      <div class="attach-item" data-act="contact">
        <span class="attach-ico"><i class="fa-regular fa-address-card"></i></span>
        <span class="attach-lab">Contato</span>
      </div>
      <div class="attach-item" data-act="sticker">
        <span class="attach-ico"><i class="fa-regular fa-face-laugh"></i></span>
        <span class="attach-lab">Sticker</span>
      </div>
    `;
    document.body.appendChild(attachMenu);
  }

  if (!emojiPop) {
    emojiPop = document.createElement('div');
    emojiPop.id = 'emoji-pop';
    emojiPop.className = 'emoji-pop';
    emojiPop.innerHTML = '<div class="emoji-grid"></div>';
    document.body.appendChild(emojiPop);

    emojiPop.addEventListener('wheel', (ev) => {
      ev.stopPropagation();
    }, { passive: true });

    emojiPop.addEventListener('touchmove', (ev) => {
      ev.stopPropagation();
    }, { passive: true });

    emojiPop.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
    });

    emojiPop.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
    });

    emojiPop.addEventListener('click', (ev) => {
      ev.stopPropagation();
    });

    const grid = emojiPop.querySelector('.emoji-grid');
    const EMOJIS = '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 🤡 👋 🤚 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏';

    EMOJIS.split(/\s+/).forEach((ch) => {
      if (!ch) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emoji-btn-item';
      b.textContent = ch;
      b.addEventListener('click', () => {
        insertAtCursor(inputMsg, ch);
        inputMsg.dispatchEvent(new Event('input', { bubbles: true }));
        applyComposerInteractiveState();
      });
      grid.appendChild(b);
    });
  }

  btnClip.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();

    const safeRef = assertSendTargetStillOpen();
    if (!safeRef) return;
    if (!(await ensureCanSendConversation(safeRef.key))) return;

    const wasOpen =
      !!attachMenu &&
      attachMenu.classList.contains('show') &&
      !attachMenu.classList.contains('hidden');

    hideAllPopups();

    if (!wasOpen) openAttachMenu();
  });

  btnEmoji.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();

    const safeRef = assertSendTargetStillOpen();
    if (!safeRef) return;
    if (!(await ensureCanSendConversation(safeRef.key))) return;

    const wasOpen = !!emojiPop && emojiPop.classList.contains('show');
    hideAllPopups();

    if (!wasOpen) openEmojiPop();
  });

  document.addEventListener('click', (ev) => {
    const clickedAttachBtn = btnClip.contains(ev.target);
    const clickedEmojiBtn = btnEmoji.contains(ev.target);
    const insideAttach = attachMenu?.contains(ev.target);
    const insideEmoji = emojiPop?.contains(ev.target);

    if (!clickedAttachBtn && !clickedEmojiBtn && !insideAttach && !insideEmoji) {
      hideAllPopups();
    }
  });

  window.addEventListener('resize', () => hideAllPopups(), { passive: true });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') hideAllPopups();
  });

  attachMenu.addEventListener('click', async (ev) => {
    ev.stopPropagation();

    const safeRef = assertSendTargetStillOpen();
    if (!safeRef) return;
    if (!(await ensureCanSendConversation(safeRef.key))) return;

    const item = ev.target.closest('.attach-item');
    if (!item) return;

    const act = item.getAttribute('data-act');
    hideAllPopups();

    switch (act) {
      case 'doc':
        fileDoc.click();
        break;

      case 'media':
        fileMedia.click();
        break;

      case 'camera': {
        const prevAccept = fileMedia.accept;
        const hadCapture = fileMedia.hasAttribute('capture');

        try {
          fileMedia.accept = 'image/*';
          fileMedia.setAttribute('capture', 'environment');
          fileMedia.click();
        } finally {
          setTimeout(() => {
            fileMedia.accept = prevAccept;
            if (!hadCapture) fileMedia.removeAttribute('capture');
          }, 0);
        }
        break;
      }

      case 'audio-file':
        fileAudio.click();
        break;

      case 'audio-record':
        startStopRecording();
        break;

      case 'contact':
        openContactPrompt();
        break;

      case 'sticker':
        openStickerPrompt();
        break;
    }
  });

  fileDoc.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files && files.length) await openFilePreview(files, 'document');
    e.target.value = '';
    inputArquivoLegacy.value = '';
  });

  fileMedia.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files && files.length) await openFilePreview(files, null);
    e.target.value = '';
    inputArquivoLegacy.value = '';
  });

  fileAudio.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files && files.length) await openFilePreview(files, 'audio');
    e.target.value = '';
    inputArquivoLegacy.value = '';
  });

  function ensureDropOverlay() {
    let ov = document.getElementById('zc-drop-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'zc-drop-overlay';
      ov.innerHTML = '<div class="zc-drop-box">Solte o arquivo aqui para enviar ao cliente</div>';
      document.body.appendChild(ov);
    }
    return ov;
  }

  function setupDragAndDrop() {
    const hist = document.getElementById('historico');
    if (!hist) return;

    let dragging = 0;
    let overlay = null;

    const hasFiles = (ev) => {
      try {
        const dt = ev.dataTransfer;
        if (!dt || !dt.types) return false;
        return Array.from(dt.types).includes('Files');
      } catch {
        return false;
      }
    };

    const showOverlay = () => {
      if (!overlay) overlay = ensureDropOverlay();
      overlay.classList.add('on');
    };

    const hideOverlay = () => {
      if (!overlay) return;
      overlay.classList.remove('on');
    };

    window.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return;
      dragging++;
      showOverlay();
      ev.preventDefault();
    });

    window.addEventListener('dragover', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
    });

    window.addEventListener('dragleave', (ev) => {
      if (!hasFiles(ev)) return;
      dragging = Math.max(0, dragging - 1);
      if (!dragging) hideOverlay();
    });

    window.addEventListener('drop', async (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();

      dragging = 0;
      hideOverlay();

      const files = Array.from(ev.dataTransfer.files || []);
      if (!files.length) return;

      const safeRef = assertSendTargetStillOpen();
      if (!safeRef) return;
      if (!(await ensureCanSendConversation(safeRef.key))) return;

      await openFilePreview(files, null);
    });
  }

  function handleConversationContextChange(rawConversation = null) {
    const ref = conversationRefOf(rawConversation || getSelectedConversationKey(), getCurrentSelectedObject());

    if (!ref?.key) {
      setComposerLocked(false, '');
      return;
    }

    if (ref.kind === 'g') {
      clearComposerOptimisticUnlock(ref.key);
      setComposerLocked(false, '');
      return;
    }

    if (isUiAcceptedForConversation(ref.key)) {
      unlockComposerOptimistically(ref.key);
      setComposerLocked(false, '');
      return;
    }

    refreshComposerAccess(ref.key, { silent: true }).catch(() => {});
  }

  function bindMetaEvents() {
    if (window.__envioMetaBound) return;
    window.__envioMetaBound = true;

    window.addEventListener('historico:rendered', (ev) => {
      const key = ev?.detail?.conversation_key || getSelectedConversationKey();
      handleConversationContextChange(key);
    });

    window.addEventListener('atendimento:conversation-selected', (ev) => {
      const key =
        ev?.detail?.conversation_key ||
        ev?.detail?.conversation_id ||
        ev?.detail?.id ||
        getSelectedConversationKey();

      handleConversationContextChange(key);
    });

    window.addEventListener('zc:conversation-selected', (ev) => {
      const key =
        ev?.detail?.conversation_key ||
        ev?.detail?.conversation_id ||
        ev?.detail?.id ||
        getSelectedConversationKey();

      handleConversationContextChange(key);
    });

    window.addEventListener('agenda:conversation-opened', (ev) => {
      const key =
        ev?.detail?.conversation_key ||
        ev?.detail?.conversation_id ||
        ev?.detail?.id ||
        getSelectedConversationKey();

      handleConversationContextChange(key);
    });

    window.addEventListener('atendimento:meta', (ev) => {
      const meta = ev?.detail || null;
      if (!meta) return;
      applyMetaToComposer(meta, meta.conversation_key || getSelectedConversationKey());
    });

    window.addEventListener('atendimento:meta-updated', (ev) => {
      const meta = ev?.detail || null;
      if (!meta) return;
      applyMetaToComposer(meta, meta.conversation_key || getSelectedConversationKey());
    });

    window.addEventListener('atendimento:refresh-meta', (ev) => {
      const key =
        ev?.detail?.conversation_key ||
        ev?.detail?.conversation_id ||
        ev?.detail?.id ||
        getSelectedConversationKey();

      handleConversationContextChange(key);
    });

    window.addEventListener('zc:conversation-accepted', (ev) => {
      const detail = ev?.detail || null;
      const ref = conversationRefOf(
        detail?.conversation_key ||
        detail?.conversation_id ||
        getSelectedConversationKey(),
        getCurrentSelectedObject()
      );

      if (ref?.key) {
        unlockComposerOptimistically(ref.key);
        setComposerLocked(false, '');
      }
    });

    window.addEventListener('zc:conversation-released', (ev) => {
      const detail = ev?.detail || null;
      const ref = conversationRefOf(
        detail?.conversation_key ||
        detail?.conversation_id ||
        getSelectedConversationKey(),
        getCurrentSelectedObject()
      );

      if (ref?.key) {
        clearComposerOptimisticUnlock(ref.key);
        if (getSelectedConversationRef()?.key === ref.key) {
          setComposerLocked(true, 'Aceite a conversa para responder');
        }
      }
    });

    window.addEventListener('zc:conversation-assigned', () => {
      clearComposerOptimisticUnlock(getSelectedConversationKey());
      handleConversationContextChange(getSelectedConversationKey());
    });

    window.addEventListener('zc:conversation-opened', () => {
      handleConversationContextChange(getSelectedConversationKey());
    });

    window.addEventListener('zc:conversation-changed', () => {
      handleConversationContextChange(getSelectedConversationKey());
    });

    document.addEventListener('click', (e) => {
      const li = e.target.closest?.('#lista-clientes .cliente-item, .cliente-item, .chat-item');
      if (li) {
        setTimeout(() => {
          clearComposerOptimisticUnlock(null);
          handleConversationContextChange(getSelectedConversationKey());
        }, 80);
      }
    }, true);
  }

  setupDragAndDrop();
  bindMetaEvents();
  applyComposerInteractiveState();
  handleConversationContextChange(getSelectedConversationKey());
})();

/* ====== FOCUS MANAGER ====== */
(function () {
  function findComposer() {
    return (
      document.querySelector('[data-chat-input]') ||
      document.querySelector('#mensagem') ||
      document.querySelector('#chat-input') ||
      document.querySelector('#composer') ||
      document.querySelector('.chat-composer textarea, .chat-composer input[type="text"]') ||
      document.querySelector('textarea[name="mensagem"], input[name="mensagem"]')
    );
  }

  function reallyFocus(el) {
    if (!el) return;

    try {
      el.removeAttribute('disabled');
      el.focus({ preventScroll: true });

      if (typeof el.setSelectionRange === 'function') {
        const v = el.value || '';
        el.setSelectionRange(v.length, v.length);
      }
    } catch {}
  }

  function scheduleFocus() {
    const tries = [0, 60, 180, 400];

    tries.forEach((ms) => {
      const fn = () => {
        const el = findComposer();
        if (el && !el.disabled) reallyFocus(el);
      };

      if (ms === 0) requestAnimationFrame(fn);
      else setTimeout(fn, ms);
    });
  }

  window.focusComposer = scheduleFocus;

  document.addEventListener('click', (e) => {
    const li = e.target.closest?.('#lista-clientes .cliente-item, .cliente-item');
    if (li) scheduleFocus();
  }, true);

  document.addEventListener('historico:ready', scheduleFocus);
  document.addEventListener('cliente:selecionado', scheduleFocus);
  document.addEventListener('zc:cliente_sel', scheduleFocus);
  document.addEventListener('zc:conversation-selected', scheduleFocus);
  document.addEventListener('agenda:conversation-opened', scheduleFocus);

  window.addEventListener('hashchange', scheduleFocus);
  window.addEventListener('popstate', scheduleFocus);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleFocus();
  });

  const obs = new MutationObserver(() => scheduleFocus());

  const mount = () => {
    const root = document.getElementById('chat-footer') || document.body;
    if (root) {
      obs.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled'],
      });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();