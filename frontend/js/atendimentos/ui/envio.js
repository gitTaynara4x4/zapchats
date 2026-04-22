// /frontend/js/atendimentos/ui/envio.js
import { EMPRESA_ID } from '../core/env.js';
import { numeroE164 } from '../core/format.js';
import {
  state,
  getConversationKey,
  getConversationEntityId,
  getConversationKind,
} from '../state/store.js';

/* ====== Fallback pra window.addListener (caso alguém ainda use) ====== */
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
    return raw
      .map((item) => stringifyErr(item))
      .filter(Boolean)
      .join(' | ');
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

function stripUndefined(o) {
  Object.keys(o).forEach((k) => {
    if (o[k] === undefined) delete o[k];
  });
  return o;
}

function toggleSendingUI(disabled) {
  const input = document.getElementById('mensagem');
  const btn = document.getElementById('btn-enviar');

  if (input) input.disabled = !!disabled;
  if (btn) btn.disabled = !!disabled;
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

    const fromStoreHelper = getConversationKey(
      obj.conversation_key ?? obj.conversation_id ?? obj.id ?? obj.cliente_id ?? obj.grupo_id ?? null,
      obj,
      obj.instancia_id ?? obj.instancia ?? obj.instance_name ?? null
    );

    const parsedStore = parseConversationKey(fromStoreHelper);
    if (parsedStore) return parsedStore;

    const directRaw =
      obj.conversation_key ??
      obj.conversation_id ??
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

  const fromStoreHelper = getConversationKey(raw, row || null, row?.instancia_id ?? row?.instancia ?? null);
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

function getSelectedConversationKey() {
  const hist = getHistoricoEl();
  const raw =
    idKey(hist?.dataset?.conversationKey) ||
    idKey(hist?.dataset?.clienteId) ||
    idKey(state?.clienteSel?.conversation_key) ||
    idKey(state?.clienteSel?.conversation_id) ||
    idKey(state?.clienteSel?.id) ||
    null;

  return conversationRefOf(raw, state?.clienteSel || null).key || null;
}

function getConversationById(conversationRef = null) {
  const targetKey = conversationRefOf(
    conversationRef ?? getSelectedConversationKey(),
    state?.clienteSel || null
  ).key;

  if (!targetKey) return null;

  const pools = [
    state?.clienteSel || null,
    ...(Array.isArray(state?.clientesCache) ? state.clientesCache : []),
    ...(Array.isArray(state?.todosContatosCache) ? state.todosContatosCache : []),
  ].filter(Boolean);

  return pools.find((x) => sameConversation(x, targetKey)) || null;
}

function getIdentityPayload(target = null) {
  const cli = typeof target === 'object' && target ? target : getConversationById(target);
  const ref = conversationRefOf(target || cli, cli);

  return stripUndefined({
    conversation_key: ref.key || undefined,
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
    instKey(cli?.instancia) ||
    instKey(cli?.instance_name) ||
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

/* ====== TRAVA: exige instância antes de enviar ====== */
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

function resolveRawTel(cli) {
  if (!cli) return '';
  if (cli.telefone) return cli.telefone;
  if (cli.whatsapp) return cli.whatsapp;
  if (cli.numero) return cli.numero;
  if (cli.number) return cli.number;
  if (cli.remote_jid) return String(cli.remote_jid);
  if (cli.remoteJid) return String(cli.remoteJid);
  if (cli.jid) return String(cli.jid);
  if (cli.telefone_norm) return cli.telefone_norm;

  if (typeof cli.nome === 'string') {
    const digits = cli.nome.replace(/\D/g, '');
    if (digits.length >= 10) return cli.nome;
  }

  return '';
}

function ensureClienteSel() {
  const cli = getConversationById();
  const rawTel = resolveRawTel(cli);

  if (!rawTel) {
    toast('Contato sem telefone válido. Recarregue a tela ou edite o cadastro.', false);
    console.warn('[send] ensureClienteSel: clienteSel sem telefone', cli);
    return false;
  }

  return true;
}

function numberForApi(conversationRef = null) {
  const cli = getConversationById(conversationRef);
  const raw = String(resolveRawTel(cli) || '').trim();
  if (!raw) return '';
  if (isJid(raw)) return raw;
  return numeroE164(raw);
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

function confirmDialog({
  title = 'Confirmar',
  msg = '',
  okText = 'OK',
  cancelText = 'Cancelar',
  destructive = false,
}) {
  return new Promise((res) => {
    const wrap = mountDialog(`
      <div class="zcDlg" role="dialog" aria-label="${title}">
        <div class="h">${title}</div>
        <div class="b"><div class="zcMsg">${msg}</div></div>
        <div class="f">
          <button class="zcBtn ghost">${cancelText}</button>
          <button class="zcBtn ${destructive ? 'danger' : 'ok'}">${okText}</button>
        </div>
      </div>
    `);

    const [btnCancel, btnOk] = wrap.querySelectorAll('.zcBtn');

    const close = (v) => {
      wrap.remove();
      res(v);
    };

    btnCancel.onclick = () => close(false);
    btnOk.onclick = () => close(true);

    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close(false);
    });

    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        btnOk.click();
      }
    });
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
  let recEl = null;
  let recTimer = null;
  let recStartTs = 0;
  let recInstPayload = null;
  let recConversationKey = null;
  let actionMode = 'mic';

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
    actionMode = mode;
    const icon = ensureActionIcon();

    btnAction.classList.remove('is-send', 'is-recording');

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

    icon.className = 'fa-solid fa-microphone';
    btnAction.title = 'Gravar áudio';
    btnAction.setAttribute('aria-label', 'Gravar áudio');
  }

  function syncActionState() {
    if (rec) {
      setActionState('recording');
      return;
    }

    const hasText = String(inputMsg.value || '').trim().length > 0;
    setActionState(hasText ? 'send' : 'mic');
  }

  function openFilePreview(fileList, explicitType = null) {
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

    const cli = getConversationById();
    const convRef = conversationRefOf(cli, cli);
    const dest = numberForApi(convRef.key);

    if (!dest) {
      toast('Destino inválido (telefone ou grupo). Verifique o cadastro.', false);
      console.warn('[send/text] numberForApi retornou vazio', { cli });
      return;
    }

    const inst = requireInstPayloadOrWarn(convRef.key);
    if (!inst) return;

    toggleSendingUI(true);

    try {
      const payload = stripUndefined({
        empresa_id: EMPRESA_ID || undefined,
        ...getIdentityPayload(cli),
        number: dest,
        text,
        ...inst,
      });

      window.__debugLastSendPayload = payload;

      const resp = await fetchJsonOrThrow('/api/atendimento/send/text', payload);
      applyInstanceFromResponse(resp);

      inputMsg.value = '';
      syncActionState();
      try { window.focusComposer?.(); } catch {}
    } catch (e) {
      console.error('[send/text] erro', e);
      toast(e?.message || 'Falha ao enviar.', false);
    } finally {
      toggleSendingUI(false);
      syncActionState();
    }
  }

  async function enviarMediaArquivo(file, explicitType = null, captionOverride = null) {
    if (!ensureClienteSel() || !file) return;

    const cli = getConversationById();
    const convRef = conversationRefOf(cli, cli);
    const inst = requireInstPayloadOrWarn(convRef.key);
    if (!inst) return;

    const caption =
      captionOverride != null
        ? captionOverride
        : (inputMsg.value || '').trim() || undefined;

    const number = numberForApi(convRef.key);
    const mime = file.type || guessMimeFromExt(file.name);
    const mediaType = explicitType || guessMediaType(mime);
    const dataUrl = await toDataUrl(file);
    const base64 = cleanDataUrl(dataUrl);

    try {
      if (mediaType === 'audio') {
        const resp = await fetchJsonOrThrow('/api/atendimento/send/audio', stripUndefined({
          empresa_id: EMPRESA_ID,
          ...getIdentityPayload(cli),
          number,
          audio: base64,
          ...inst,
        }));
        applyInstanceFromResponse(resp);
      } else {
        const body = stripUndefined({
          empresa_id: EMPRESA_ID,
          ...getIdentityPayload(cli),
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

        if (caption && captionOverride != null) {
          inputMsg.value = '';
        }
      }

      toast('Arquivo enviado!', true);
      syncActionState();
      try { window.focusComposer?.(); } catch {}
    } catch (e) {
      console.error('[send/media|audio]', e);
      toast(e?.message || 'Falha ao enviar arquivo.', false);
      syncActionState();
    }
  }

  async function openContactPrompt() {
    if (!ensureClienteSel()) return;

    const cli = getConversationById();
    const convRef = conversationRefOf(cli, cli);
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

    const contact = [{
      fullName: data.fullName || undefined,
      phoneNumber: onlyDigits(data.phone || '') || undefined,
    }];

    try {
      const resp = await fetchJsonOrThrow('/api/atendimento/send/contact', stripUndefined({
        empresa_id: EMPRESA_ID,
        ...getIdentityPayload(cli),
        number: numberForApi(convRef.key),
        contact,
        ...inst,
      }));

      applyInstanceFromResponse(resp);
      toast('Contato enviado!', true);
      try { window.focusComposer?.(); } catch {}
    } catch (e) {
      console.error(e);
      toast(e?.message || 'Falha ao enviar contato.', false);
    }
  }

  async function openStickerPrompt() {
    if (!ensureClienteSel()) return;

    const cli = getConversationById();
    const convRef = conversationRefOf(cli, cli);
    const inst = requireInstPayloadOrWarn(convRef.key);
    if (!inst) return;

    const data = await inputDialog({
      title: 'Enviar figurinha',
      rows: [{ name: 'st', label: 'URL / BASE64', placeholder: 'Cole a URL ou data:...' }],
      okText: 'Enviar',
    });

    if (!data || !data.st) return;

    const s = String(data.st);
    const sticker = s.startsWith('data:') ? cleanDataUrl(s) : s.trim();

    try {
      const resp = await fetchJsonOrThrow('/api/atendimento/send/sticker', stripUndefined({
        empresa_id: EMPRESA_ID,
        ...getIdentityPayload(cli),
        number: numberForApi(convRef.key),
        sticker,
        ...inst,
      }));

      applyInstanceFromResponse(resp);
      toast('Sticker enviado!', true);
      try { window.focusComposer?.(); } catch {}
    } catch (e) {
      console.error(e);
      toast(e?.message || 'Falha ao enviar figurinha.', false);
    }
  }

  function renderRecBubble(recState = 'idle', elapsed = '00:00') {
    if (!recEl) {
      recEl = document.createElement('div');
      recEl.className = 'zc-rec-bubble';
      recEl.innerHTML = `
        <span class="dot"></span>
        <span class="t">gravando… 00:00</span>
        <button class="stop" type="button">Parar</button>
      `;
      (footer.parentElement || footer).appendChild(recEl);

      recEl.querySelector('.stop').addEventListener('click', startStopRecording);
    }

    recEl.querySelector('.t').textContent =
      `${recState === 'rec' ? 'gravando…' : 'processando…'} ${elapsed}`;

    recEl.classList.add('show');
  }

  function hideRecBubble() {
    if (recEl) recEl.classList.remove('show');
  }

  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const m = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${m}:${ss}`;
  }

  async function startStopRecording() {
    if (!rec) {
      if (!ensureClienteSel()) return;

      const cli = getConversationById();
      const convRef = conversationRefOf(cli, cli);
      const inst = requireInstPayloadOrWarn(convRef.key);
      if (!inst) return;

      recInstPayload = inst;
      recConversationKey = convRef.key;

      try {
        recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        rec = new MediaRecorder(recStream);
        recChunks = [];

        setActionState('recording');

        rec.ondataavailable = (e) => {
          if (e.data?.size) recChunks.push(e.data);
        };

        rec.onstop = async () => {
          clearInterval(recTimer);
          renderRecBubble('proc', fmtElapsed(Date.now() - recStartTs));

          try {
            const blob = new Blob(recChunks, { type: rec.mimeType || 'audio/webm' });
            const dataUrl = await toDataUrl(blob);
            const base64 = cleanDataUrl(dataUrl);

            const resp = await fetchJsonOrThrow('/api/atendimento/send/audio', stripUndefined({
              empresa_id: EMPRESA_ID,
              ...getIdentityPayload(recConversationKey),
              number: numberForApi(recConversationKey),
              audio: base64,
              ...(recInstPayload || {}),
            }));

            applyInstanceFromResponse(resp);
          } catch (e) {
            console.error(e);
            toast(e?.message || 'Falha ao enviar áudio.', false);
          } finally {
            hideRecBubble();
            recStream?.getTracks()?.forEach((t) => t.stop());
            recStream = null;
            rec = null;
            recChunks = [];
            recInstPayload = null;
            recConversationKey = null;
            syncActionState();
            try { window.focusComposer?.(); } catch {}
          }
        };

        rec.start();
        recStartTs = Date.now();
        recTimer = setInterval(() => {
          renderRecBubble('rec', fmtElapsed(Date.now() - recStartTs));
        }, 250);

        renderRecBubble('rec', '00:00');
      } catch (e) {
        console.error(e);
        toast('Permissão de microfone negada.', false);
        recInstPayload = null;
        recConversationKey = null;
        syncActionState();
      }
    } else {
      try {
        rec.stop();
      } catch {}
    }
  }

  btnAction.addEventListener('click', async () => {
    if (rec) {
      await startStopRecording();
      return;
    }

    const hasText = (inputMsg.value || '').trim().length > 0;
    if (hasText) {
      await enviarTexto();
    } else {
      await startStopRecording();
    }
  });

  inputMsg.addEventListener('input', syncActionState);

  inputMsg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if ((inputMsg.value || '').trim()) {
        enviarTexto();
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
    (footer.parentElement || footer).appendChild(attachMenu);
  }

  if (!emojiPop) {
    emojiPop = document.createElement('div');
    emojiPop.id = 'emoji-pop';
    emojiPop.className = 'emoji-pop';
    emojiPop.innerHTML = '<div class="emoji-grid"></div>';
    (footer.parentElement || footer).appendChild(emojiPop);

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
        syncActionState();
      });
      grid.appendChild(b);
    });
  }

  btnClip.addEventListener('click', (ev) => {
    ev.stopPropagation();

    attachMenu.classList.toggle('hidden');

    if (!attachMenu.classList.contains('hidden')) {
      const b = btnClip.getBoundingClientRect();
      const p = (attachMenu.parentElement || document.body).getBoundingClientRect();
      attachMenu.style.left = Math.max(12, Math.min(p.width - 260, b.left - p.left - 8)) + 'px';
      attachMenu.classList.add('show');
      requestAnimationFrame(() => attachMenu.classList.add('show'));
    } else {
      attachMenu.classList.remove('show');
    }
  });

  btnEmoji.addEventListener('click', (ev) => {
    ev.stopPropagation();
    emojiPop.classList.toggle('show');

    if (emojiPop.classList.contains('show')) {
      const b = btnEmoji.getBoundingClientRect();
      const p = (emojiPop.parentElement || document.body).getBoundingClientRect();
      emojiPop.style.left = Math.max(8, b.left - p.left) + 'px';
    }
  });

  document.addEventListener('click', (ev) => {
    if (attachMenu && !attachMenu.contains(ev.target) && ev.target !== btnClip) {
      attachMenu.classList.add('hidden');
      attachMenu.classList.remove('show');
    }

    if (emojiPop && !emojiPop.contains(ev.target) && ev.target !== btnEmoji) {
      emojiPop.classList.remove('show');
    }
  });

  attachMenu.addEventListener('click', (ev) => {
    const item = ev.target.closest('.attach-item');
    if (!item) return;

    const act = item.getAttribute('data-act');
    attachMenu.classList.add('hidden');
    attachMenu.classList.remove('show');

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

  fileDoc.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) openFilePreview(files, 'document');
    e.target.value = '';
    inputArquivoLegacy.value = '';
  });

  fileMedia.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) openFilePreview(files, null);
    e.target.value = '';
    inputArquivoLegacy.value = '';
  });

  fileAudio.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) openFilePreview(files, 'audio');
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

    window.addEventListener('drop', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();

      dragging = 0;
      hideOverlay();

      const files = Array.from(ev.dataTransfer.files || []);
      if (!files.length) return;

      openFilePreview(files, null);
    });
  }

  setupDragAndDrop();
  syncActionState();
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
        if (el) reallyFocus(el);
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