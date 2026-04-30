// frontend/js/pages/colaboradores/avatar.js

import { state } from './state.js';
import { authFetch, withEmpresa, apiForm } from './api.js';
import { $, els } from './dom.js';
import { toast } from './feedback.js';
import { initials, hashColor, replaceExt } from './helpers.js';
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

export async function fetchAvatarThumbURLFor(colab){
  const id = Number(colab?.id || 0) || 0;

  if (!id) return colab?.avatar_url || null;

  if (state.avatarThumbCache.has(id)) {
    return state.avatarThumbCache.get(id);
  }

  if (state.avatarThumbInflight.has(id)) {
    return state.avatarThumbInflight.get(id);
  }

  const p = (async () => {
    let url = null;

    try {
      const r1 = await authFetch(withEmpresa(`/api/colaboradores/${id}/avatar`));

      if (r1.ok && r1.status === 200){
        const blob = await r1.blob();
        url = URL.createObjectURL(blob);
      }
    } catch {}

    if (!url && colab?.usuario_id){
      try {
        const r2 = await authFetch(withEmpresa(`/api/usuarios/${colab.usuario_id}/avatar`));

        if (r2.ok && r2.status === 200){
          const blob = await r2.blob();
          url = URL.createObjectURL(blob);
        }
      } catch {}
    }

    if (!url && colab?.avatar_url) {
      url = colab.avatar_url;
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
  wrap.style.background = hashColor(String(name));

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
    img.style.display = 'block';
    span.style.display = 'none';
    wrap.style.background = 'transparent';
  };

  img.onerror = () => {
    img.removeAttribute('src');
    img.style.display = 'none';
    span.style.display = 'grid';
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

  if (url){
    if (pAvatar){
      pAvatar.src = url;
      pAvatar.style.display = 'block';
    }

    if (pMono) pMono.style.display = 'none';
    return;
  }

  if (pMono){
    pMono.textContent = initials(nome);
    pMono.style.display = 'grid';

    if (pMono.parentElement) {
      pMono.parentElement.style.background = hashColor(nome || 'ZapsChat');
    }
  }

  if (pAvatar){
    pAvatar.removeAttribute('src');
    pAvatar.style.display = 'none';
  }
}

export async function fetchAvatarURLFor(colab){
  if (!colab || !colab.id) {
    return colab && colab.avatar_url ? colab.avatar_url : null;
  }

  try {
    const r1 = await authFetch(withEmpresa(`/api/colaboradores/${colab.id}/avatar`));

    if (r1.ok && r1.status === 200) {
      const blob = await r1.blob();
      return URL.createObjectURL(blob);
    }
  } catch {}

  if (colab.usuario_id){
    try {
      const r2 = await authFetch(withEmpresa(`/api/usuarios/${colab.usuario_id}/avatar`));

      if (r2.ok && r2.status === 200){
        const blob = await r2.blob();
        return URL.createObjectURL(blob);
      }
    } catch {}
  }

  return colab.avatar_url || null;
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

  const url = URL.createObjectURL(file);

  setPerfilAvatar(
    $('#e-nome')?.value || coalesceName(state.viewing) || 'Novo Colaborador',
    url
  );
}

export function bindAvatarDnDAndPaste(){
  const { pAvatarInput } = els();

  const avatarWrap = $('#avatar-wrap');
  const fileInput = pAvatarInput;

  if (!avatarWrap) return;

  if (fileInput){
    fileInput.setAttribute('accept','image/*,.svg,.webp,.avif,.heic,.heif');

    avatarWrap.onclick = () => {
      fileInput.value = '';
      fileInput.click();
    };

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