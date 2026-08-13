// /frontend/js/atendimentos/ui/media-render/audio.js
// Player de áudio estilo WhatsApp Web
// - HTML do player .wa-audio
// - Play/pause
// - Velocidade 1.0x / 1.5x / 2.0x
// - Barra de progresso clicável/arrastável
// - Duração
// - Pausa outros áudios ao tocar um novo
// - Avatar do cliente nos áudios recebidos

(function () {
  'use strict';

  const M = window.ZCMediaRender;

  if (!M || !M.__coreReady) {
    console.warn('[media-render][audio] core.js precisa ser carregado antes.');
    return;
  }

  if (M.__audioReady) return;
  M.__audioReady = true;

  const REQUIRED = [
    'escapeHtml',
    'uniq',
    'playIconSvg',
    'pauseIconSvg',
    'getCurrentChatAvatarUrl',
    'setAudioAvatar',
  ];

  if (!M.require(REQUIRED, 'audio')) {
    return;
  }

  const {
    escapeHtml,
    uniq,
    playIconSvg,
    pauseIconSvg,
    getCurrentChatAvatarUrl,
    setAudioAvatar,
  } = M;

  function fmtAudioTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);

    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  /*
    Compatibilidade com nome antigo do arquivo monolítico.
  */
  function _fmtT(sec) {
    return fmtAudioTime(sec);
  }

  function makeWaAudioHTML(urls, opts) {
    opts = opts || {};

    const dir = opts.dir === 'out' ? 'out' : 'in';
    const list = uniq(urls);

    const avatarHtml = dir === 'in'
      ? `
      <div class="wa-avatar" aria-hidden="true">
        <img alt="">
        <span class="ph">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 12c2.21 0 4-1.79 4-4S14.21 4 12 4 8 5.79 8 8s1.79 4 4 4Z"
              stroke="currentColor"
              stroke-width="2"
            />
            <path
              d="M20 20a8 8 0 1 0-16 0"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </span>
      </div>`
      : '';

    const speedHtml = dir === 'out'
      ? `<button class="wa-speed" type="button">1.0x</button>`
      : '';

    // Forma visual fixa e leve, usada apenas para dar aparência de waveform.
    // O progresso real continua vindo do elemento Audio e de --p.
    const waveform = [
      34, 52, 28, 68, 44, 76, 38, 58, 84, 46, 64, 32,
      72, 50, 88, 40, 62, 30, 78, 54, 36, 70, 48, 82,
      42, 60, 26, 74, 52, 66, 38, 56, 80, 44, 62, 34
    ];
    const waveformBars = waveform
      .map((h) => `<span style="--h:${h}%"></span>`)
      .join('');

    return `
<div class="wa-audio" data-src="${escapeHtml(list.join('|'))}" data-dir="${dir}">
  <div class="wa-left">
    ${avatarHtml}
    ${speedHtml}

    <button class="wa-play" type="button" aria-label="Tocar/Pausar">
      ${playIconSvg()}
    </button>
  </div>

  <div class="wa-main">
    <div class="wa-wave" role="slider" aria-label="Progresso" tabindex="0">
      <div class="dots" aria-hidden="true">${waveformBars}</div>
      <div class="fill" aria-hidden="true">${waveformBars}</div>
      <div class="knob"></div>
    </div>

    <div class="wa-len">0:00</div>
  </div>
</div>`;
  }

  /*
    Compatibilidade com nome antigo.
  */
  function _makeWaAudioHTML(urls, opts) {
    return makeWaAudioHTML(urls, opts);
  }

  function initAudioPlayers(root) {
    (root || document).querySelectorAll('.wa-audio').forEach((el) => {
      if (el._ok) return;
      el._ok = true;

      const srcs = uniq(
        String(el.getAttribute('data-src') || '')
          .split('|')
          .filter(Boolean)
      );

      let idx = 0;

      const dir = String(el.getAttribute('data-dir') || 'in').toLowerCase() === 'out'
        ? 'out'
        : 'in';

      const btnPlay = el.querySelector('.wa-play');
      const btnSpeed = el.querySelector('.wa-speed');
      const wave = el.querySelector('.wa-wave');
      const lenEl = el.querySelector('.wa-len');

      const audio = new Audio(srcs[0] || '');
      audio.preload = 'metadata';

      window.__ZC_AUDIO__ = window.__ZC_AUDIO__ || new Set();
      window.__ZC_AUDIO__.add(audio);

      const pauseOthers = () => {
        try {
          window.__ZC_AUDIO__.forEach((a) => {
            if (a !== audio) {
              a.pause();
            }
          });
        } catch {}
      };

      const setPlayButtonState = (playing) => {
        if (!btnPlay) return;

        btnPlay.innerHTML = playing
          ? pauseIconSvg()
          : playIconSvg();
      };

      const tryNext = () => {
        if (idx < srcs.length - 1) {
          idx += 1;
          audio.src = srcs[idx];

          try {
            audio.load();
          } catch {}

          if (!audio.paused) {
            audio.play().catch(() => {});
          }
        }
      };

      function setProgress(pct) {
        const p = Math.max(0, Math.min(100, Number(pct) || 0));
        el.style.setProperty('--p', `${p}%`);
      }

      function updateFromAudio() {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          const pct = (audio.currentTime / audio.duration) * 100;
          setProgress(pct);
        } else {
          setProgress(0);
        }
      }

      function setFromClientX(clientX) {
        if (!wave) return;

        const rect = wave.getBoundingClientRect();
        const p = rect.width ? (clientX - rect.left) / rect.width : 0;
        const clamped = Math.max(0, Math.min(1, p));

        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = clamped * audio.duration;
          updateFromAudio();
        } else {
          setProgress(clamped * 100);
        }
      }

      if (btnPlay) {
        btnPlay.addEventListener('click', () => {
          if (audio.paused) {
            pauseOthers();
            audio.play().catch(() => {});
          } else {
            audio.pause();
          }
        });
      }

      if (btnSpeed) {
        const cycle = [1.0, 1.5, 2.0];

        btnSpeed.addEventListener('click', () => {
          const cur = Number(audio.playbackRate || 1.0);
          const i = cycle.findIndex((x) => Math.abs(x - cur) < 0.01);
          const next = cycle[(i + 1 + cycle.length) % cycle.length];

          audio.playbackRate = next;
          btnSpeed.textContent = `${next.toFixed(1)}x`;
        });
      }

      let dragging = false;

      if (wave) {
        wave.addEventListener('pointerdown', (e) => {
          dragging = true;

          try {
            wave.setPointerCapture(e.pointerId);
          } catch {}

          setFromClientX(e.clientX);
          e.preventDefault();
        });

        wave.addEventListener('pointermove', (e) => {
          if (!dragging) return;

          setFromClientX(e.clientX);
          e.preventDefault();
        });

        const endDrag = () => {
          dragging = false;
        };

        wave.addEventListener('pointerup', endDrag);
        wave.addEventListener('pointercancel', endDrag);

        wave.addEventListener('keydown', (e) => {
          if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

          e.preventDefault();

          const delta = e.key === 'ArrowRight' ? 2 : -2;

          audio.currentTime = Math.max(
            0,
            Math.min(audio.duration, (audio.currentTime || 0) + delta)
          );

          updateFromAudio();
        });
      }

      audio.addEventListener('play', () => {
        el.setAttribute('data-playing', '1');
        setPlayButtonState(true);
      });

      audio.addEventListener('pause', () => {
        el.removeAttribute('data-playing');
        setPlayButtonState(false);
      });

      audio.addEventListener('loadedmetadata', () => {
        if (lenEl) {
          lenEl.textContent = fmtAudioTime(audio.duration || 0);
        }

        updateFromAudio();
      });

      audio.addEventListener('durationchange', () => {
        if (lenEl && Number.isFinite(audio.duration)) {
          lenEl.textContent = fmtAudioTime(audio.duration || 0);
        }
      });

      audio.addEventListener('timeupdate', updateFromAudio);

      audio.addEventListener('ended', () => {
        el.removeAttribute('data-playing');
        setPlayButtonState(false);
        setProgress(0);
      });

      audio.addEventListener('error', tryNext);

      if (dir === 'in') {
        const u = getCurrentChatAvatarUrl();
        setAudioAvatar(el, u);
      }

      setPlayButtonState(false);
    });
  }

  function pauseAllAudios() {
    try {
      if (!window.__ZC_AUDIO__) return;

      window.__ZC_AUDIO__.forEach((audio) => {
        try {
          audio.pause();
        } catch {}
      });
    } catch {}
  }

  function destroyDetachedAudios() {
    try {
      if (!window.__ZC_AUDIO__) return;

      window.__ZC_AUDIO__.forEach((audio) => {
        try {
          if (!audio || audio.__destroyed) return;
        } catch {}
      });
    } catch {}
  }

  M.extend({
    fmtAudioTime,
    _fmtT,

    makeWaAudioHTML,
    _makeWaAudioHTML,

    initAudioPlayers,
    pauseAllAudios,
    destroyDetachedAudios,
  });

  /*
    Mantém compatibilidade com chamadas externas antigas.
  */
  M.exposeGlobal?.('initAudioPlayers', initAudioPlayers);

  console.log('[media-render] audio carregado');
})();