// /frontend/js/atendimentos/ui/media-render/gallery.js
// Galeria/mosaico de imagens estilo WhatsApp Web
// - Detecta anexos de imagem
// - Renderiza grupo de imagens na mesma bolha
// - Codifica/decodifica itens do viewer
// - Agrupa imagens consecutivas já renderizadas no front
// - Restaura agrupamentos quando o histórico muda

(function () {
  'use strict';

  const M = window.ZCMediaRender;

  if (!M || !M.__coreReady) {
    console.warn('[media-render][gallery] core.js precisa ser carregado antes.');
    return;
  }

  if (M.__galleryReady) return;
  M.__galleryReady = true;

  const REQUIRED = [
    'escapeHtml',
    'H',
    'resolveUrlsForMedia',
  ];

  if (!M.require(REQUIRED, 'gallery')) {
    return;
  }

  const {
    escapeHtml,
    H,
    resolveUrlsForMedia,
  } = M;

  function isImageAttachment(a) {
    const mime = String(a?.mimetype || a?.mime || '').toLowerCase();
    const tipo = String(a?.tipo || a?.tipo_midia || '').toLowerCase();

    return (
      tipo.includes('imagem') ||
      tipo.includes('image') ||
      tipo.includes('figurinha') ||
      tipo.includes('sticker') ||
      mime.startsWith('image/')
    );
  }

  function isGalleryImageAttachment(a) {
    const mime = String(a?.mimetype || a?.mime || '').toLowerCase();
    const tipo = String(a?.tipo || a?.tipo_midia || '').toLowerCase();

    const isSticker =
      tipo.includes('figurinha') ||
      tipo.includes('sticker');

    return mime.startsWith('image/') && !isSticker;
  }

  function buildViewerItemsFromAttachments(m, list) {
    return (list || [])
      .map((a) => {
        const urls = resolveUrlsForMedia(m, a);
        const src = urls[0] || '';
        const name =
          a?.filename ||
          a?.name ||
          a?.fileName ||
          'imagem';

        return {
          type: 'image',
          src,
          thumb: src,
          name,
        };
      })
      .filter((x) => x.src);
  }

  function encodeViewerItems(items) {
    try {
      return encodeURIComponent(JSON.stringify(items || []));
    } catch {
      return '';
    }
  }

  function decodeViewerItems(raw) {
    try {
      const arr = JSON.parse(decodeURIComponent(String(raw || '')));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function renderImageCell(m, a, idx, extraClass = '', overlay = '') {
    const urls = resolveUrlsForMedia(m, a);
    const [url, ...alts] = urls;

    const name =
      a?.filename ||
      a?.name ||
      a?.fileName ||
      'imagem';

    return `
      <a
        class="msg-media-cell ${escapeHtml(extraClass)}"
        href="${escapeHtml(url)}"
        target="_blank"
        rel="noopener"
        data-zc-media-open="1"
        data-viewer-index="${idx}"
        data-kind="image"
        data-name="${escapeHtml(name)}"
      >
        <img
          src="${escapeHtml(url)}"
          data-alt="${escapeHtml(alts.join('|'))}"
          alt="${escapeHtml(name)}"
          loading="lazy"
        >
        ${overlay ? `<span class="msg-media-more">+${escapeHtml(overlay)}</span>` : ''}
      </a>
    `;
  }

  function renderImageGroup(m, list) {
    const total = list.length;
    const visible = list.slice(0, Math.min(total, 4));
    const viewerItems = buildViewerItemsFromAttachments(m, list);

    return `
      <div
        class="msg-media-group"
        data-count="${visible.length}"
        data-total="${total}"
        data-viewer-items="${escapeHtml(encodeViewerItems(viewerItems))}"
      >
        ${visible.map((a, idx) => {
          const overlay = idx === 3 && total > 4
            ? String(total - 4)
            : '';

          return renderImageCell(
            m,
            a,
            idx,
            `cell-${idx + 1}`,
            overlay
          );
        }).join('')}
      </div>
    `;
  }

  function buildImageGroupFromExisting(items) {
    const total = items.length;
    const visible = items.slice(0, Math.min(total, 4));

    return `
      <div
        class="msg-media-group"
        data-front-grouped="1"
        data-count="${visible.length}"
        data-total="${total}"
        data-viewer-items="${escapeHtml(encodeViewerItems(items))}"
      >
        ${visible.map((item, idx) => {
          const overlay = idx === 3 && total > 4
            ? String(total - 4)
            : '';

          return `
            <a
              class="msg-media-cell cell-${idx + 1}"
              href="${escapeHtml(item.src)}"
              target="_blank"
              rel="noopener"
              data-zc-media-open="1"
              data-viewer-index="${idx}"
              data-kind="image"
              data-name="${escapeHtml(item.name)}"
            >
              <img
                src="${escapeHtml(item.thumb || item.src)}"
                data-alt="${escapeHtml(item.altList || '')}"
                alt="${escapeHtml(item.name)}"
                loading="lazy"
              >
              ${overlay ? `<span class="msg-media-more">+${escapeHtml(overlay)}</span>` : ''}
            </a>
          `;
        }).join('')}
      </div>
    `;
  }

  function getStandaloneImageRowInfo(row) {
    if (!row || row.dataset.frontGroupHidden === '1') {
      return null;
    }

    const bubble = row.querySelector('.bubble');

    if (!bubble) return null;
    if (bubble.dataset.frontGroupMaster === '1') return null;
    if (bubble.querySelector('.msg-media-group')) return null;

    const medias = bubble.querySelectorAll('.msg-media-img');

    if (medias.length !== 1) return null;

    if (
      bubble.querySelector(
        '.msg-media-video, .msg-sticker, .doc-card, .wa-audio'
      )
    ) {
      return null;
    }

    const anchor = medias[0];
    const img = anchor.querySelector('img');

    if (!img) return null;

    const txtEl = bubble.querySelector('.msg-text');
    const txt = String(txtEl?.textContent || '').trim();

    /*
      Só agrupa imagens puras.
      Se a imagem tem legenda real, deixa separada para não perder contexto.
    */
    if (txt && !/^\[[^\]]+\]$/i.test(txt)) {
      return null;
    }

    return {
      row,
      bubble,
      anchor,
      img,
      dir: bubble.classList.contains('bubble-out') ? 'out' : 'in',
      metaHtml: bubble.querySelector('.meta')?.innerHTML || '',
      href: anchor.getAttribute('href') || img.getAttribute('src') || '',
      src: img.getAttribute('src') || '',
      altList: img.dataset.alt || '',
      name:
        anchor.dataset?.name ||
        anchor.getAttribute('data-name') ||
        img.getAttribute('alt') ||
        'imagem',
    };
  }

  function restoreFrontGroupedRows(root) {
    const scope = root || document;

    scope
      .querySelectorAll('.msg-row[data-front-group-hidden="1"]')
      .forEach((row) => {
        row.style.display = '';
        delete row.dataset.frontGroupHidden;
      });

    scope
      .querySelectorAll('.bubble[data-front-group-master="1"]')
      .forEach((bubble) => {
        const grouped = bubble.querySelector(
          '.msg-media-group[data-front-grouped="1"]'
        );

        if (grouped) {
          grouped.remove();
        }

        if (bubble.dataset.frontGroupOriginalMediaHtml) {
          bubble.insertAdjacentHTML(
            'afterbegin',
            bubble.dataset.frontGroupOriginalMediaHtml
          );
        }

        const meta = bubble.querySelector('.meta');

        if (meta && bubble.dataset.frontGroupOriginalMetaHtml) {
          meta.innerHTML = bubble.dataset.frontGroupOriginalMetaHtml;
        }

        bubble.classList.remove('has-media-group');

        delete bubble.dataset.frontGroupMaster;
        delete bubble.dataset.frontGroupOriginalMediaHtml;
        delete bubble.dataset.frontGroupOriginalMetaHtml;
      });
  }

  function groupConsecutiveImageRows(root) {
    const hist =
      root?.id === 'historico'
        ? root
        : root?.querySelector?.('#historico') || H();

    if (!hist) return;

    restoreFrontGroupedRows(hist);

    const rows = Array.from(hist.querySelectorAll('.msg-row'));
    let i = 0;

    while (i < rows.length) {
      const first = getStandaloneImageRowInfo(rows[i]);

      if (!first) {
        i += 1;
        continue;
      }

      const group = [first];
      let j = i + 1;

      while (j < rows.length) {
        const next = getStandaloneImageRowInfo(rows[j]);

        if (!next) break;
        if (next.dir !== first.dir) break;

        group.push(next);
        j += 1;
      }

      if (group.length > 1) {
        const items = group.map((x) => ({
          type: 'image',
          src: x.href || x.src,
          thumb: x.src,
          altList: x.altList,
          name: x.name,
        }));

        first.bubble.dataset.frontGroupMaster = '1';
        first.bubble.dataset.frontGroupOriginalMediaHtml = first.anchor.outerHTML;
        first.bubble.dataset.frontGroupOriginalMetaHtml = first.metaHtml;

        first.anchor.remove();

        first.bubble.insertAdjacentHTML(
          'afterbegin',
          buildImageGroupFromExisting(items)
        );

        first.bubble.classList.add('has-media-group');

        const meta = first.bubble.querySelector('.meta');

        if (meta) {
          meta.innerHTML = group[group.length - 1].metaHtml;
        }

        for (let k = 1; k < group.length; k += 1) {
          group[k].row.dataset.frontGroupHidden = '1';
          group[k].row.style.display = 'none';
        }
      }

      i = j;
    }
  }

  M.extend({
    isImageAttachment,
    isGalleryImageAttachment,

    buildViewerItemsFromAttachments,
    encodeViewerItems,
    decodeViewerItems,

    renderImageCell,
    renderImageGroup,
    buildImageGroupFromExisting,

    getStandaloneImageRowInfo,
    restoreFrontGroupedRows,
    groupConsecutiveImageRows,
  });

  console.log('[media-render] gallery carregado');
})();