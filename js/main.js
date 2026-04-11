/**
 * Main — Orchestrator for NES Arcade (Worker Architecture)
 *
 * Main thread responsibilities:
 * - UI (DOM, sliders, toggles, fullscreen, touch controls)
 * - Canvas rendering (receives pre-converted pixels from Worker)
 * - Audio playback (reads from SharedArrayBuffer written by Worker)
 * - Input capture (keyboard, touch, gamepad → postMessage to Worker)
 * - Save state storage (localStorage, receives state JSON from Worker)
 *
 * Worker thread (nes-worker.js) handles:
 * - JSNES emulation (CPU, PPU, APU)
 * - Audio sample generation (writes to SharedArrayBuffer)
 * - All game mods (speed, firepower, lives, dual fighter)
 * - Palette fix, memory hacking
 */

import { WorkerBridge } from './WorkerBridge.js';
import { RendererWorker } from './RendererWorker.js';
import { AudioEngineWorker } from './AudioEngineWorker.js';
import { ROMLoader } from './ROMLoader.js';

// ── DOM References ──────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

const els = {
  romLoader:     $('#rom-loader'),
  romDropzone:   $('#rom-dropzone'),
  romFileInput:  $('#rom-file-input'),
  canvasWrapper: $('#canvas-wrapper'),
  gameCanvas:    $('#game-canvas'),
  gameControls:  $('#game-controls'),
  powerLed:      $('#power-led'),
  crtScreen:     $('.crt-screen'),
  btnPause:      $('#btn-pause'),
  btnReset:      $('#btn-reset'),
  btnSound:      $('#btn-sound'),
  soundIcon:     $('#sound-icon'),
  toast:         $('#toast'),
  toastText:     $('#toast-text'),
};

// ── Core Instances ──────────────────────────────────────────
const bridge = new WorkerBridge('js/nes-worker.js');
const renderer = new RendererWorker(els.gameCanvas);
const audioSAB = AudioEngineWorker.createAudioSAB(0.5); // null if no SharedArrayBuffer
const audio = new AudioEngineWorker();
const romLoader = new ROMLoader();

// Debug globals — only on localhost
if (location.hostname === 'localhost') {
  window._bridge = bridge;
  window._audio = audio;
}

// ── App State ───────────────────────────────────────────────
const state = {
  romLoaded: false,
  paused: false,
  soundOn: true,
  saveSlots: [null, null, null],
};

// ── Toast ───────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, duration = 3000) {
  els.toastText.textContent = msg;
  els.toast.hidden = false;
  void els.toast.offsetWidth;
  els.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('visible');
    setTimeout(() => { els.toast.hidden = true; }, 300);
  }, duration);
}

// ── Slider Fill Sync ────────────────────────────────────────
function syncSliderFill(slider) {
  const fill = document.querySelector(`[data-slider="${slider.id}"]`);
  if (!fill) return;
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const val = parseFloat(slider.value);
  fill.style.width = ((val - min) / (max - min)) * 100 + '%';
}

// ── Initialize Worker + Audio ───────────────────────────────
function initEmulator() {
  // Initialize Worker with SharedArrayBuffer for audio
  bridge.init(audioSAB);

  // Handle incoming frames from Worker
  bridge.onFrame((pixels, fps) => {
    renderer.renderFrame(pixels);
    // Return the buffer to the Worker for reuse (double-buffering)
    bridge.returnBuffer(pixels.buffer);
  });

  // Handle fallback audio (postMessage batches when no SharedArrayBuffer)
  bridge.onAudioBatch((left, right) => {
    audio.receiveBatch(left, right);
  });

  // Handle state events
  bridge.onStateEvent((event, data) => {
    if (event === 'rom-loaded') {
      showToast('ROM LOADED');
    } else if (event === 'error') {
      showToast('ERROR: ' + data);
    }
  });
}

// ── ROM Loading ─────────────────────────────────────────────
function onRomLoaded(romInfo) {
  bridge.loadROM(romInfo.romData);
  state.romLoaded = true;

  // Audio requires a user gesture — guard against double-init race
  let audioStarted = false;
  function startAudioOnGesture() {
    if (audioStarted) return;
    audioStarted = true;
    document.removeEventListener('click', startAudioOnGesture);
    document.removeEventListener('keydown', startAudioOnGesture);
    audio.init(audioSAB).then(() => {
      if (!state.soundOn) audio.setMuted(true);
    });
  }
  document.addEventListener('click', startAudioOnGesture);
  document.addEventListener('keydown', startAudioOnGesture);

  // Transition UI
  els.romLoader.hidden = true;
  els.canvasWrapper.hidden = false;
  const powerControls = document.querySelector('.power-controls');
  if (powerControls) powerControls.hidden = false;
  els.canvasWrapper.classList.add('entering');

  showToast('ROM LOADED: ' + romInfo.name.toUpperCase());

  // Start the emulation loop in the Worker
  bridge.start();
}

function initRomLoader() {
  romLoader.init({
    dropTarget: els.romDropzone,
    fileInput: els.romFileInput,
    onROMLoaded: onRomLoaded,
    onError: (msg) => showToast('ERROR: ' + msg),
  });

  els.romDropzone.addEventListener('click', (e) => {
    if (e.target.closest('.rom-browse-btn') || e.target === els.romFileInput) return;
    els.romFileInput.click();
  });

  els.romDropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.romFileInput.click();
    }
  });

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
}

// ── Game Controls ───────────────────────────────────────────
function initGameControls() {
  // Pause
  els.btnPause.addEventListener('click', () => {
    if (!state.romLoaded) return;
    state.paused = !state.paused;
    if (state.paused) {
      bridge.pause();
      els.btnPause.innerHTML = '&#x25B6;';
      els.crtScreen.classList.add('paused');
      showToast('PAUSED');
    } else {
      bridge.resume();
      els.btnPause.innerHTML = '&#x23F8;';
      els.crtScreen.classList.remove('paused');
    }
  });

  // Reset
  els.btnReset.addEventListener('click', () => {
    if (!state.romLoaded) return;
    bridge.reset();
    state.paused = false;
    els.crtScreen.classList.remove('paused');
    els.btnPause.innerHTML = '&#x23F8;';
    showToast('GAME RESET');
  });

  // Sound toggle
  els.btnSound.addEventListener('click', () => {
    state.soundOn = !state.soundOn;
    els.btnSound.setAttribute('aria-pressed', String(state.soundOn));
    els.soundIcon.innerHTML = state.soundOn ? '&#9835;' : '&#9834;';
    audio.setMuted(!state.soundOn);
    showToast(state.soundOn ? 'SOUND ON' : 'SOUND OFF');
  });

  // Volume slider
  const volSlider = $('#vol-slider');
  if (volSlider) {
    volSlider.addEventListener('input', () => {
      audio.setVolume(parseInt(volSlider.value, 10) / 100);
    });
  }

  // Fullscreen (with Safari/webkit/iOS support)
  function goFullscreen(el) {
    if (el.requestFullscreen) return el.requestFullscreen();
    if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
    if (el.msRequestFullscreen) return el.msRequestFullscreen();
    document.body.classList.add('ios-fullscreen');
    return Promise.resolve();
  }
  function exitFullscreen() {
    if (document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
    if (document.msExitFullscreen) return document.msExitFullscreen();
  }
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
  }

  const btnFullscreen = $('#btn-fullscreen');
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', () => {
      if (document.body.classList.contains('ios-fullscreen')) {
        document.body.classList.remove('ios-fullscreen');
        return;
      }
      document.body.classList.remove('ios-fullscreen');
      if (!isFullscreen()) {
        const isMobile = window.matchMedia('(pointer: coarse), (max-width: 768px)').matches;
        if (isMobile) {
          goFullscreen(document.documentElement);
        } else {
          const screen = document.querySelector('.crt-screen');
          goFullscreen(screen || els.gameCanvas);
        }
      } else {
        exitFullscreen();
      }
    });
  }

  // Fullscreen state management
  function onFullscreenChange() {
    const overlay = $('#touch-overlay');
    const toggle = $('#joystick-toggle');
    const closePill = $('#touch-close');
    const isMobile = window.matchMedia('(pointer: coarse), (max-width: 768px)').matches;

    if (isFullscreen() && isMobile) {
      document.body.classList.add('mobile-fullscreen');
      if (overlay) overlay.classList.remove('hidden');
      if (toggle) toggle.style.display = 'none';
      if (closePill) closePill.style.display = 'none';
    } else {
      document.body.classList.remove('mobile-fullscreen');
      if (overlay) overlay.classList.add('hidden');
      if (toggle) { toggle.style.display = ''; toggle.classList.remove('active'); }
      if (closePill) closePill.style.display = '';
    }
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // iOS exit fullscreen button
  const iosExitBtn = $('#ios-exit-btn');
  if (iosExitBtn) {
    iosExitBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.body.classList.remove('ios-fullscreen');
    }, { passive: false });
    iosExitBtn.addEventListener('click', () => {
      document.body.classList.remove('ios-fullscreen');
    });
  }
}

// ── Mod Controls (Sliders → Worker) ─────────────────────────
function initModControls() {
  const sliders = document.querySelectorAll('.mod-slider');
  sliders.forEach((slider) => {
    syncSliderFill(slider);

    slider.addEventListener('input', () => {
      const output = $(`#${slider.id}-val`);
      if (output) output.textContent = slider.value;
      syncSliderFill(slider);

      if (!state.romLoaded) return;

      const val = parseInt(slider.value, 10);
      switch (slider.id) {
        case 'mod-speed':
          bridge.setMod('speed', val);
          showToast(`SPEED: ${val}x`);
          break;
        case 'mod-firepower':
          bridge.setMod('firepower', val);
          if (val === 1) showToast('FIREPOWER: NORMAL');
          else if (val < 4) showToast(`FIREPOWER: ${val} (dual shot)`);
          else showToast(`FIREPOWER: ${val} (dual shot + fast bullets)`);
          break;
      }
    });
  });
}

// ── Toggle Buttons ──────────────────────────────────────────
function initToggleMods() {
  const btnInfiniteLives = $('#btn-infinite-lives');
  if (btnInfiniteLives) {
    btnInfiniteLives.addEventListener('click', () => {
      const enabled = btnInfiniteLives.getAttribute('aria-pressed') !== 'true';
      bridge.setInfiniteLives(enabled);
      btnInfiniteLives.setAttribute('aria-pressed', String(enabled));
      btnInfiniteLives.classList.toggle('active', enabled);
      showToast(enabled ? 'INFINITE LIVES: ON' : 'INFINITE LIVES: OFF');
    });
  }

  const btnDualFighter = $('#btn-dual-fighter');
  if (btnDualFighter) {
    btnDualFighter.addEventListener('click', () => {
      const enabled = btnDualFighter.getAttribute('aria-pressed') !== 'true';
      bridge.setDualFighter(enabled);
      btnDualFighter.setAttribute('aria-pressed', String(enabled));
      btnDualFighter.classList.toggle('active', enabled);
      showToast(enabled ? 'DUAL FIGHTER: ON' : 'DUAL FIGHTER: OFF');
    });
  }
}

// ── Save / Load State ───────────────────────────────────────
function initSaveLoad() {
  // Restore previous saves from localStorage
  const STORAGE_PREFIX = 'nes_galaga_state_';
  const STORAGE_INDEX = 'nes_galaga_state_index';

  function listSlots() {
    try {
      const raw = localStorage.getItem(STORAGE_INDEX);
      if (!raw) return [];
      return Object.entries(JSON.parse(raw)).map(([id, meta]) => ({ id, ...meta }));
    } catch { return []; }
  }

  for (let slot = 1; slot <= 3; slot++) {
    const saveBtn = $(`#btn-save-${slot}`);
    const loadBtn = $(`#btn-load-${slot}`);
    const slotId = `slot_${slot}`;

    saveBtn.addEventListener('click', async () => {
      if (!state.romLoaded) return;
      const wasPaused = state.paused;
      if (!wasPaused) bridge.pause();

      try {
        const { state: nesState } = await bridge.saveState(slotId);
        const saveData = { id: slotId, label: `Slot ${slot}`, timestamp: Date.now(), state: nesState };
        localStorage.setItem(STORAGE_PREFIX + slotId, JSON.stringify(saveData));

        // Update index
        const indexRaw = localStorage.getItem(STORAGE_INDEX);
        const index = indexRaw ? JSON.parse(indexRaw) : {};
        index[slotId] = { label: saveData.label, timestamp: saveData.timestamp };
        localStorage.setItem(STORAGE_INDEX, JSON.stringify(index));

        state.saveSlots[slot - 1] = true;
        const slotEl = $(`#slot-${slot}`);
        if (slotEl) {
          slotEl.classList.add('has-save');
          const status = slotEl.querySelector('.slot-status');
          if (status) status.textContent = 'SAVED';
        }
        loadBtn.disabled = false;
        showToast(`STATE SAVED TO SLOT ${slot}`);
      } catch (err) {
        showToast('ERROR: SAVE FAILED');
      }

      if (!wasPaused) bridge.resume();
    });

    loadBtn.addEventListener('click', async () => {
      if (!state.romLoaded || !state.saveSlots[slot - 1]) return;
      try {
        const raw = localStorage.getItem(STORAGE_PREFIX + slotId);
        if (!raw) return;
        const saveData = JSON.parse(raw);
        if (!saveData || typeof saveData !== 'object' || !saveData.state) {
          showToast('ERROR: CORRUPT SAVE DATA');
          return;
        }
        await bridge.loadState(saveData.state);
        showToast(`STATE LOADED FROM SLOT ${slot}`);
        if (state.paused) {
          state.paused = false;
          bridge.resume();
          els.crtScreen.classList.remove('paused');
          els.btnPause.innerHTML = '&#x23F8;';
        }
      } catch (err) {
        showToast('ERROR: LOAD FAILED');
      }
    });

    // Restore existing saves on init
    const existing = listSlots();
    const found = existing.find((s) => s.id === slotId);
    if (found) {
      state.saveSlots[slot - 1] = true;
      const slotEl = $(`#slot-${slot}`);
      if (slotEl) {
        slotEl.classList.add('has-save');
        const status = slotEl.querySelector('.slot-status');
        if (status) status.textContent = 'SAVED';
      }
      loadBtn.disabled = false;
    }
  }
}

// ── Input: Keyboard → Worker ────────────────────────────────
function initKeyboardInput() {
  const keyMap = {
    'ArrowUp': 4, 'ArrowDown': 5, 'ArrowLeft': 6, 'ArrowRight': 7,
    'KeyZ': 0, 'KeyX': 1, 'ShiftRight': 2, 'ShiftLeft': 2, 'Enter': 3,
  };
  const pressed = new Set();

  document.addEventListener('keydown', (e) => {
    const button = keyMap[e.code];
    if (button !== undefined && state.romLoaded) {
      e.preventDefault();
      if (!pressed.has(e.code)) {
        pressed.add(e.code);
        bridge.buttonDown(1, button);
        // Dual shot on Z press
        if (e.code === 'KeyZ') bridge.dualShotFire();
      }
    }

    // Keyboard shortcuts
    if (e.key === 'p' || e.key === 'P') els.btnPause.click();
    if (e.key === 'm' || e.key === 'M') els.btnSound.click();
  });

  document.addEventListener('keyup', (e) => {
    const button = keyMap[e.code];
    if (button !== undefined && state.romLoaded) {
      pressed.delete(e.code);
      bridge.buttonUp(1, button);
    }
  });
}

// ── Input: Touch → Worker ───────────────────────────────────
function initTouchControls() {
  const btnMap = {
    up: 4, down: 5, left: 6, right: 7,
    a: 0, b: 0, select: 2, start: 3,
  };

  document.querySelectorAll('[data-btn]').forEach((btn) => {
    const nesBtn = btnMap[btn.dataset.btn];
    if (nesBtn === undefined) return;
    const isA = btn.dataset.btn === 'a';

    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      btn.classList.add('active');
      if (!state.romLoaded) return;
      if (isA) bridge.dualShotFire();
      bridge.buttonDown(1, nesBtn);
    }, { passive: false });

    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      btn.classList.remove('active');
      if (state.romLoaded) bridge.buttonUp(1, nesBtn);
    }, { passive: false });

    btn.addEventListener('touchcancel', () => {
      btn.classList.remove('active');
      if (state.romLoaded) bridge.buttonUp(1, nesBtn);
    });
  });
}

// ── Keyboard Highlights ─────────────────────────────────────
function initKeyboardHighlight() {
  const keyCaps = document.querySelectorAll('.key-cap');
  const keyMap = {
    'ArrowUp': 0, 'ArrowDown': 1, 'ArrowLeft': 2, 'ArrowRight': 3,
    'z': 4, 'Z': 4, 'x': 5, 'X': 5, 'c': 6, 'C': 6, 'Enter': 7,
  };

  document.addEventListener('keydown', (e) => {
    const idx = keyMap[e.key];
    if (idx !== undefined && keyCaps[idx]) keyCaps[idx].classList.add('active');
  });

  document.addEventListener('keyup', (e) => {
    const idx = keyMap[e.key];
    if (idx !== undefined && keyCaps[idx]) keyCaps[idx].classList.remove('active');
  });
}

// ── Joystick Toggle ─────────────────────────────────────────
function initJoystickToggle() {
  const btn = $('#joystick-toggle');
  const overlay = $('#touch-overlay');
  const closeBtn = $('#touch-close');
  if (!btn || !overlay) return;

  overlay.classList.add('hidden');

  btn.addEventListener('click', () => {
    overlay.classList.remove('hidden');
    btn.classList.add('active');
  });

  if (closeBtn) {
    function handleClose(e) {
      if (e) e.preventDefault();
      if (document.body.classList.contains('ios-fullscreen')) {
        document.body.classList.remove('ios-fullscreen');
      }
      overlay.classList.add('hidden');
      btn.classList.remove('active');
    }
    closeBtn.addEventListener('touchstart', handleClose, { passive: false });
    closeBtn.addEventListener('click', handleClose);
  }
}

// ── Initialize Everything ───────────────────────────────────
function init() {
  initEmulator();
  initRomLoader();
  initGameControls();
  initModControls();
  initToggleMods();
  initSaveLoad();
  initKeyboardInput();
  initKeyboardHighlight();
  initTouchControls();
  initJoystickToggle();

  // Pause when app goes to background, resume when back
  document.addEventListener('visibilitychange', () => {
    if (!state.romLoaded || state.paused) return;
    if (document.hidden) {
      bridge.pause();
    } else {
      bridge.resume();
    }
  });

  setTimeout(() => showToast('INSERT CARTRIDGE TO BEGIN', 4000), 500);

  // Try auto-load if ROM exists locally (gitignored, not in repo)
  fetch('galaga.nes').then(r => {
    if (!r.ok) return;
    return r.arrayBuffer();
  }).then(buf => {
    if (!buf) return;
    const bytes = new Uint8Array(buf);
    if (!ROMLoader.isValidNES(bytes)) return;
    const header = ROMLoader.parseHeader(bytes);
    const romData = ROMLoader.bytesToBinaryString(bytes);
    onRomLoaded({ name: 'galaga.nes', size: bytes.length, ...header, romData });
  }).catch(() => {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
