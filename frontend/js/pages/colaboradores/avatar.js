// frontend/js/pages/colaboradores/avatar.js

import { state } from './state.js';
import { authFetch, withEmpresa, apiForm } from './api.js';
import { $, els } from './dom.js';
import { toast } from './feedback.js';
import { initials, hashColor, avatarTone, replaceExt } from './helpers.js';
import { coalesceName, coalesceEmail } from './coalesce.js';

export function revokeBlobURL(u){
  try {
    if (u && String(u).startsWith('blob:')) URL.revokeObjectURL(u);
  } catch {}
}

export function clearAvatarThumbCache(){
  for (const v of state.avatarThumbCache.values()){
    if (typeof v === 'string') revokeBlobURL(v);
  }

  state.avatarThumbCache.clear();
  state.avatarThumbInflight.clear();
}

export function invalidateAvatarThumb(id){
  const n = Number(id || 0) || 0;
  if (!n) return;

  const old = state.avatarThumbCache.get(n);

  if (typeof old === 'string') revokeBlobURL(old);

  state.avatarThumbCache.delete(n);
  state.avatarThumbInflight.delete(n);
}

function shouldFetchAvatarURL(url){
  const s = String(url || '');
  return /\/api\/(colaboradores|usuarios)\/\d+\/avatar/.test(s);
}

function isGeneratedInitialAvatarURL(url){
  const s = String(url || '').trim().toLowerCase();
  if (!s) return false;

  return (
    s.includes('api.dicebear.com/') && s.includes('/initials/')
  ) || s.includes('ui-avatars.com/api/');
}

function realAvatarURL(url){
  const s = String(url || '').trim();
  return s && !isGeneratedInitialAvatarURL(s) ? s : null;
}

async function fetchAvatarAsBlobURL(url){
  try {
    const r = await authFetch(withEmpresa(url));

    if (r.ok && r.status === 200){
      const blob = await r.blob();
      return URL.createObjectURL(blob);
    }
  } catch {}

  return null;
}

export async function fetchAvatarThumbURLFor(colab){
  const id = Number(colab?.id || 0) || 0;
  const directURL = realAvatarURL(colab?.avatar_url);

  if (!id) return directURL;

  if (state.avatarThumbCache.has(id)) {
    return state.avatarThumbCache.get(id);
  }

  if (state.avatarThumbInflight.has(id)) {
    return state.avatarThumbInflight.get(id);
  }

  const p = (async () => {
    let url = null;

    // Se o backend mandou um avatar gerado externo, usa direto.
    // Assim evitamos chamar /avatar para todo colaborador e encher o console com 404.
    if (directURL && !shouldFetchAvatarURL(directURL)) {
      url = directURL;
    }

    // Se o backend mandou /api/.../avatar, aí sim busca como blob autenticado.
    if (!url && directURL && shouldFetchAvatarURL(directURL)) {
      url = await fetchAvatarAsBlobURL(directURL);
    }

    if (!url && colab?.usuario_id){
      url = await fetchAvatarAsBlobURL(`/api/usuarios/${colab.usuario_id}/avatar`);
    }

    state.avatarThumbCache.set(id, url || null);

    return url || null;
  })().finally(() => {
    state.avatarThumbInflight.delete(id);
  });

  state.avatarThumbInflight.set(id, p);

  return p;
}

export function mountMiniAvatarInto(td, colab){
  if (!td) return;

  const name = coalesceName(colab) || coalesceEmail(colab) || `#${colab?.id || ''}`;

  const wrap = document.createElement('div');
  wrap.className = 'avatar-mini';

  const tone = avatarTone(name);
  wrap.style.setProperty('--colab-avatar-bg', tone.bg);
  wrap.style.setProperty('--colab-avatar-fg', tone.fg);
  wrap.style.setProperty('--colab-avatar-ring', tone.ring);
  wrap.style.background = tone.bg;
  wrap.style.color = tone.fg;
  wrap.style.borderColor = tone.ring;

  const span = document.createElement('span');
  span.className = 'avatar-mini-initials';
  span.textContent = initials(name);

  const img = document.createElement('img');
  img.className = 'avatar-mini-img';
  img.alt = name;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.style.display = 'none';

  img.onload = () => {
    wrap.classList.add('has-photo');
  };

  img.onerror = () => {
    wrap.classList.remove('has-photo');
    img.removeAttribute('src');
  };

  wrap.appendChild(span);
  wrap.appendChild(img);

  td.innerHTML = '';
  td.appendChild(wrap);

  fetchAvatarThumbURLFor(colab)
    .then(url => {
      if (!td.isConnected || !url) return;
      img.src = url;
    })
    .catch(() => {});
}

export function setPerfilAvatar(nome, url){
  const { pAvatar, pMono } = els();
  const preview = pMono?.parentElement || pAvatar?.parentElement || null;
  const realURL = realAvatarURL(url);

  if (pMono){
    pMono.textContent = initials(nome);

    if (pMono.parentElement) {
      const tone = avatarTone(nome || 'ZapsChat');
      pMono.parentElement.style.setProperty('--colab-avatar-bg', tone.bg);
      pMono.parentElement.style.setProperty('--colab-avatar-fg', tone.fg);
      pMono.parentElement.style.setProperty('--colab-avatar-ring', tone.ring);
      pMono.parentElement.style.background = tone.bg;
      pMono.parentElement.style.color = tone.fg;
      pMono.parentElement.style.borderColor = tone.ring;
    }
  }

  if (!pAvatar){
    preview?.classList.remove('has-photo');
    return;
  }

  pAvatar.onload = () => {
    preview?.classList.add('has-photo');
  };

  pAvatar.onerror = () => {
    preview?.classList.remove('has-photo');
    pAvatar.removeAttribute('src');
  };

  if (realURL){
    preview?.classList.remove('has-photo');
    pAvatar.src = realURL;
  } else {
    preview?.classList.remove('has-photo');
    pAvatar.removeAttribute('src');
  }
}

export async function fetchAvatarURLFor(colab){
  if (!colab || !colab.id) {
    return colab ? realAvatarURL(colab.avatar_url) : null;
  }

  const directURL = realAvatarURL(colab.avatar_url);

  if (directURL && !shouldFetchAvatarURL(directURL)) {
    return directURL;
  }

  if (directURL && shouldFetchAvatarURL(directURL)) {
    const got = await fetchAvatarAsBlobURL(directURL);
    if (got) return got;
  }

  if (colab.usuario_id){
    const got = await fetchAvatarAsBlobURL(`/api/usuarios/${colab.usuario_id}/avatar`);
    if (got) return got;
  }

  return directURL || null;
}

function convertToPng(file){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        canvas.toBlob(blob => {
          if (!blob) return reject(new Error('toBlob falhou'));

          const out = new File([blob], replaceExt(file.name, '.png'), {
            type: 'image/png'
          });

          URL.revokeObjectURL(url);
          resolve(out);
        }, 'image/png', 0.92);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };

    img.onerror = e => {
      URL.revokeObjectURL(url);
      reject(e);
    };

    img.src = url;
  });
}

export async function uploadAvatarTo(url, file){
  const fieldNames = ['avatar', 'file', 'upload'];

  for (const name of fieldNames){
    const fd = new FormData();
    fd.append(name, file);

    try {
      await apiForm(url, 'PUT', fd);
      return true;
    } catch {}
  }

  return false;
}

export async function handleAvatarFile(file){
  if (!file) return;

  const maxBytes = 5 * 1024 * 1024;
  if (Number(file.size || 0) > maxBytes) {
    toast('A foto deve ter no máximo 5 MB.', 'warn');
    return;
  }

  const okByMime = /^image\//i.test(file.type || '');
  const okByExt = /\.(png|jpe?g|webp|gif|bmp|svg|avif|heic|heif)$/i.test(file.name || '');

  if (!okByMime && !okByExt){
    toast('Envie uma imagem (PNG, JPG, WEBP, GIF, SVG, AVIF, HEIC).', 'warn');
    return;
  }

  const needConvert =
    /image\/(webp|avif|heic|heif)/i.test(file.type || '') ||
    /\.(webp|avif|heic|heif)$/i.test(file.name || '');

  if (needConvert){
    try {
      file = await convertToPng(file);
    } catch {}
  }

  state.newAvatarFile = file;

  const actionLabel = document.querySelector('#btn-add-avatar strong');
  if (actionLabel) actionLabel.textContent = 'Alterar foto';

  const url = URL.createObjectURL(file);

  setPerfilAvatar(
    $('#e-nome')?.value || coalesceName(state.viewing) || 'Novo Colaborador',
    url
  );
}

export function bindAvatarDnDAndPaste(){
  const { pAvatarInput } = els();

  const avatarWrap = $('#avatar-wrap');
  const addButton = $('#btn-add-avatar');
  const fileInput = pAvatarInput;

  if (!avatarWrap) return;

  const openPicker = () => {
    if (!fileInput) return;
    fileInput.value = '';
    fileInput.click();
  };

  if (fileInput){
    fileInput.setAttribute('accept','image/*,.svg,.webp,.avif,.heic,.heif');

    avatarWrap.onclick = () => {
      const modal = document.querySelector('#modal-perfil');
      const isViewMode = modal?.dataset?.mode === 'view' && !modal.classList.contains('editing');

      // Se está apenas visualizando o perfil, o clique no avatar já entra em edição.
      // Assim a pessoa consegue escolher a foto e o botão de salvar fica disponível.
      if (isViewMode) {
        document.querySelector('#perfil-editar')?.click();
      }

      window.setTimeout(openPicker, isViewMode ? 80 : 0);
    };

    if (addButton && addButton.dataset.avatarBound !== '1') {
      addButton.dataset.avatarBound = '1';
      addButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openPicker();
      });
    }

    fileInput.onchange = () => {
      handleAvatarFile(fileInput.files?.[0] || null);
    };
  }

  if (avatarWrap.dataset.dndBound !== '1'){
    avatarWrap.dataset.dndBound = '1';

    const onDragOver = e => {
      e.preventDefault();
      e.stopPropagation();
      avatarWrap.classList.add('drag-over');
    };

    const onDragLeave = e => {
      e.preventDefault();
      e.stopPropagation();
      avatarWrap.classList.remove('drag-over');
    };

    const onDrop = e => {
      e.preventDefault();
      e.stopPropagation();
      avatarWrap.classList.remove('drag-over');

      const f = e.dataTransfer?.files?.[0];
      if (f) handleAvatarFile(f);
    };

    ['dragenter','dragover'].forEach(ev => {
      avatarWrap.addEventListener(ev, onDragOver);
    });

    ['dragleave','dragend'].forEach(ev => {
      avatarWrap.addEventListener(ev, onDragLeave);
    });

    avatarWrap.addEventListener('drop', onDrop);
  }

  if (!window.__avatarPasteBound){
    window.__avatarPasteBound = true;

    window.addEventListener('paste', async e => {
      const files = e.clipboardData?.files;

      if (files && files.length){
        handleAvatarFile(files[0]);
        return;
      }

      const items = e.clipboardData?.items || [];

      for (const it of items){
        if (it.type && it.type.indexOf('image') === 0){
          const blob = it.getAsFile();

          if (blob) {
            handleAvatarFile(new File([blob], 'clipboard.png', {
              type: blob.type || 'image/png'
            }));
            return;
          }
        }

        if (it.type === 'text/plain'){
          const url = await new Promise(r => it.getAsString(r));

          if (/^https?:\/\/.+\.(png|jpe?g|webp|gif|svg|avif|heic|heif)(\?.*)?$/i.test(url)){
            try {
              const res = await fetch(url);
              const b = await res.blob();
              const name = url.split('/').pop()?.split('?')[0] || 'image';

              handleAvatarFile(new File([b], name, {
                type: b.type || 'image/png'
              }));
            } catch {}
          }
        }
      }
    });
  }
}