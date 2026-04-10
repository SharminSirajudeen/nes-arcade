/**
 * Main — Wires the JSNES engine modules to the arcade UI.
 *
 * This file bridges:
 * - The retro arcade UI (index.html + styles.css)
 * - The emulator engine (EmulatorCore, Renderer, AudioEngine, etc.)
 *
 * Flow: User drops ROM -> engine loads it -> game renders on canvas
 *       with full NES audio, input, memory hacking, and save states.
 */

import { EmulatorCore } from './EmulatorCore.js';
import { Renderer } from './Renderer.js';
import { AudioEngine } from './AudioEngine.js';
import { InputHandler } from './InputHandler.js';
import { MemoryHacker } from './MemoryHacker.js';
import { ROMLoader } from './ROMLoader.js';
import { StateManager } from './StateManager.js';
import { applyAccuratePalette } from './PaletteFix.js';

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

// ── Module Instances ────────────────────────────────────────
const emulator = new EmulatorCore();
const renderer = new Renderer(els.gameCanvas);
const audio = new AudioEngine();
const input = new InputHandler(emulator);
const hacker = new MemoryHacker(emulator);
const stateManager = new StateManager(emulator, hacker);
const romLoader = new ROMLoader();

// Expose for debugging and memory scanning via browser console
window._emu = emulator;
window._hacker = hacker;
window._audio = audio;

// ── App State ───────────────────────────────────────────────
const state = {
  romLoaded: false,
  paused: false,
  soundOn: true,
  saveSlots: [null, null, null],
  highScore: 0,
  lastRomData: null, // saved for reset
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

// ── Initialize Emulator ─────────────────────────────────────
function initEmulator() {
  emulator.init({
    onFrame: (frameBuffer) => renderer.renderFrame(frameBuffer),
    onAudioSample: (left, right) => audio.writeSample(left, right),
  });
}

// ── ROM Loading ─────────────────────────────────────────────
function onRomLoaded(romInfo) {
  try {
    emulator.loadROM(romInfo.romData);
  } catch (err) {
    showToast('ERROR: ' + err.message);
    els.romLoader.classList.remove('loading');
    return;
  }

  state.romLoaded = true;
  state.lastRomData = romInfo.romData;
  stateManager.setROMName(romInfo.name);

  // Initialize subsystems
  hacker.init();
  input.bind();
  initSpeedHack();
  applyAccuratePalette(emulator);

  // Audio requires a user gesture to start (browser autoplay policy).
  // Init on the first click or keypress after ROM loads.
  function startAudioOnGesture() {
    audio.init().then(() => {
      if (!state.soundOn) audio.setMuted(true);
      showToast('SOUND ON');
    });
    document.removeEventListener('click', startAudioOnGesture);
    document.removeEventListener('keydown', startAudioOnGesture);
  }
  document.addEventListener('click', startAudioOnGesture);
  document.addEventListener('keydown', startAudioOnGesture);

  // Start auto-save
  stateManager.startAutoSave(30000);

  // Transition UI: hide loader, show game
  els.romLoader.hidden = true;
  els.canvasWrapper.hidden = false;
  const powerControls = document.querySelector('.power-controls');
  if (powerControls) powerControls.hidden = false;
  els.canvasWrapper.classList.add('entering');

  showToast('ROM LOADED: ' + romInfo.name.toUpperCase());

  // Start the emulator
  emulator.start();
}

function initRomLoader() {
  // ROMLoader handles drag-drop on the dropzone and file input change events.
  // It calls onRomLoaded with parsed ROM info when a valid .nes file is provided.
  romLoader.init({
    dropTarget: els.romDropzone,
    fileInput: els.romFileInput,
    onROMLoaded: onRomLoaded,
    onError: (msg) => showToast('ERROR: ' + msg),
  });

  // Click anywhere on the dropzone (except the browse label) opens file picker
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

  // Prevent default drag behavior on the whole page
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
      emulator.pause();
      els.btnPause.innerHTML = '&#x25B6;';
      els.crtScreen.classList.add('paused');
      showToast('PAUSED');
    } else {
      emulator.resume();
      els.btnPause.innerHTML = '&#x23F8;';
      els.crtScreen.classList.remove('paused');
    }
  });

  // Reset — reload the ROM for a clean restart
  els.btnReset.addEventListener('click', () => {
    if (!state.romLoaded || !state.lastRomData) return;
    emulator.pause();
    emulator.loadROM(state.lastRomData);
    applyAccuratePalette(emulator);
    lastPlayerX = -1;
    state.paused = false;
    els.crtScreen.classList.remove('paused');
    els.btnPause.innerHTML = '&#x23F8;';
    emulator.start();
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

  // Fullscreen
  const btnFullscreen = $('#btn-fullscreen');
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        const isMobile = window.matchMedia('(pointer: coarse), (max-width: 768px)').matches;
        if (isMobile) {
          // Mobile: fullscreen the whole page so joystick is visible
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          // Desktop: fullscreen just the game canvas
          const screen = document.querySelector('.crt-screen');
          (screen || els.gameCanvas).requestFullscreen().catch(() => {});
        }
      } else {
        document.exitFullscreen();
      }
    });
  }

  // Fullscreen state management
  document.addEventListener('fullscreenchange', () => {
    const overlay = $('#touch-overlay');
    const toggle = $('#joystick-toggle');
    const closePill = $('#touch-close');
    const isMobile = window.matchMedia('(pointer: coarse), (max-width: 768px)').matches;

    if (document.fullscreenElement && isMobile) {
      // Entering mobile fullscreen: show joystick, hide toggle + close
      document.body.classList.add('mobile-fullscreen');
      if (overlay) overlay.classList.remove('hidden');
      if (toggle) toggle.style.display = 'none';
      if (closePill) closePill.style.display = 'none';
    } else {
      // Exiting fullscreen: restore normal state
      document.body.classList.remove('mobile-fullscreen');
      if (overlay) overlay.classList.add('hidden');
      if (toggle) { toggle.style.display = ''; toggle.classList.remove('active'); }
      if (closePill) closePill.style.display = '';
    }
  });
}

// ── Mod State ───────────────────────────────────────────────
const mods = {
  speed: 1,        // 1x = normal, up to 10x
  firepower: 1,    // 1 = normal, 2+ = dual shot + faster bullets
  infiniteLives: false,
  _frozenLives: null,
  dualFighter: false,
};

// Speed multiplier: track player X each frame, amplify movement
let lastPlayerX = -1;
// Fire rate: on Z press, force both bullet slots active (dual shot from one tap)
let fireKeyHeld = false;

function initSpeedHack() {
  // Track Z key for dual-shot spawning
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyZ' || !state.romLoaded || mods.firepower < 2) return;
    if (fireKeyHeld) return;
    fireKeyHeld = true;

    const speedIdx = emulator.readMemory(0x0201) & 0x1F || 0x01;
    const playerY = emulator.readMemory(0x0202);
    const playerX = emulator.readMemory(0x0203);

    if (emulator.readMemory(0x02E0) & 0x80) {
      emulator.writeMemory(0x02E0, speedIdx);
      emulator.writeMemory(0x02E1, playerY);
      emulator.writeMemory(0x02E2, playerX);
      emulator.writeMemory(0x02E3, 0);
      emulator.writeMemory(0x02E4, 0);
    }
    if (emulator.readMemory(0x02E8) & 0x80) {
      emulator.writeMemory(0x02E8, speedIdx);
      emulator.writeMemory(0x02E9, playerY);
      emulator.writeMemory(0x02EA, playerX);
      emulator.writeMemory(0x02EB, 0);
      emulator.writeMemory(0x02EC, 0);
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyZ') fireKeyHeld = false;
  });

  // No pre-frame hook needed — slow enemies uses frame skipping, not RAM hacking

  // POST-FRAME: player hacks (speed, bullets, lives, invincibility)
  emulator.addPostFrameHook(() => {
    const currentX = emulator.readMemory(0x0203);

    // Speed multiplier
    if (mods.speed > 1 && lastPlayerX >= 0) {
      const delta = currentX - lastPlayerX;
      if (delta !== 0 && Math.abs(delta) >= 1 && Math.abs(delta) <= 2) {
        const extra = delta * (mods.speed - 1);
        let newX = currentX + extra;
        newX = Math.max(16, Math.min(223, newX));
        emulator.writeMemory(0x0203, newX & 0xFF);
      }
    }
    lastPlayerX = emulator.readMemory(0x0203);

    // Firepower: dual shot + faster bullets + instant re-fire
    if (mods.firepower > 1) {
      // Zero cooldowns for instant re-fire
      emulator.writeMemory(0x60, 0x14);
      emulator.writeMemory(0xC9, 0x00);

      // Faster bullets — capped at 4 extra px/frame.
      // Enemy sprites are 8px tall, normal bullet speed ~3px/frame.
      // Total must stay under 8px/frame or collision detection fails.
      const extraUp = Math.min((mods.firepower - 1) + 1, 5);
      const b1Flag = emulator.readMemory(0x02E0);
      if ((b1Flag & 0x80) === 0) {
        const y = emulator.readMemory(0x02E1);
        if (y > 8) emulator.writeMemory(0x02E1, (y - extraUp) & 0xFF);
      }
      const b2Flag = emulator.readMemory(0x02E8);
      if ((b2Flag & 0x80) === 0) {
        const y = emulator.readMemory(0x02E9);
        if (y > 8) emulator.writeMemory(0x02E9, (y - extraUp) & 0xFF);
      }
    }

    // Infinite lives: freeze lives counter at captured value
    if (mods.infiniteLives && mods._frozenLives !== null) {
      emulator.writeMemory(0x0487, mods._frozenLives);
    }

    // Dual fighter: force dual ship mode ($79 = 1) + keep 2nd ship alive at $0210
    if (mods.dualFighter) {
      emulator.writeMemory(0x79, 0x01);

      // Ensure 2nd ship entity is active
      const ship2State = emulator.readMemory(0x0210);
      if (ship2State === 0 || (ship2State & 0x80) !== 0) {
        // Copy entire player entity ($0200-$020F) to 2nd ship ($0210-$021F)
        for (let i = 0; i < 16; i++) {
          emulator.writeMemory(0x0210 + i, emulator.readMemory(0x0200 + i));
        }
      }
      // Sync 2nd ship position: same Y, X + 16
      emulator.writeMemory(0x0212, emulator.readMemory(0x0202));
      emulator.writeMemory(0x0213, emulator.readMemory(0x0203) + 16);
    }


  });
}

// ── Mod Sliders → Memory Hacker ─────────────────────────────
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
          mods.speed = val;
          showToast(`SPEED: ${val}x`);
          break;
        case 'mod-firepower':
          mods.firepower = val;
          if (val === 1) showToast('FIREPOWER: NORMAL');
          else if (val < 4) showToast(`FIREPOWER: ${val} (dual shot)`);
          else showToast(`FIREPOWER: ${val} (dual shot + fast bullets)`);
          break;
      }
    });
  });
}

// ── Toggle Buttons (Invincible, Enemy Freeze) ──────────────
function initToggleMods() {
  const btnInfiniteLives = $('#btn-infinite-lives');
  if (btnInfiniteLives) {
    btnInfiniteLives.addEventListener('click', () => {
      mods.infiniteLives = !mods.infiniteLives;
      if (mods.infiniteLives) {
        mods._frozenLives = emulator.readMemory(0x0487);
        showToast(`INFINITE LIVES: ON (locked at ${mods._frozenLives})`);
      } else {
        mods._frozenLives = null;
        showToast('INFINITE LIVES: OFF');
      }
      btnInfiniteLives.setAttribute('aria-pressed', String(mods.infiniteLives));
      btnInfiniteLives.classList.toggle('active', mods.infiniteLives);
    });
  }

  const btnDualFighter = $('#btn-dual-fighter');
  if (btnDualFighter) {
    btnDualFighter.addEventListener('click', () => {
      mods.dualFighter = !mods.dualFighter;
      btnDualFighter.setAttribute('aria-pressed', String(mods.dualFighter));
      btnDualFighter.classList.toggle('active', mods.dualFighter);
      if (mods.dualFighter) {
        emulator.writeMemory(0x79, 0x01);
        showToast('DUAL FIGHTER: ON');
      } else {
        emulator.writeMemory(0x79, 0x00);
        showToast('DUAL FIGHTER: OFF');
      }
    });
  }
}

// ── Save / Load State ───────────────────────────────────────
function initSaveLoad() {
  for (let slot = 1; slot <= 3; slot++) {
    const saveBtn = $(`#btn-save-${slot}`);
    const loadBtn = $(`#btn-load-${slot}`);
    const slotId = `slot_${slot}`;

    saveBtn.addEventListener('click', () => {
      if (!state.romLoaded) return;
      const wasPaused = state.paused;
      if (!wasPaused) emulator.pause();

      const ok = stateManager.saveToSlot(slotId, `Slot ${slot}`);
      if (ok) {
        state.saveSlots[slot - 1] = true;
        const slotEl = $(`#slot-${slot}`);
        if (slotEl) {
          slotEl.classList.add('has-save');
          const status = slotEl.querySelector('.slot-status');
          if (status) status.textContent = 'SAVED';
        }
        loadBtn.disabled = false;
        showToast(`STATE SAVED TO SLOT ${slot}`);
      } else {
        showToast('ERROR: SAVE FAILED');
      }

      if (!wasPaused) emulator.resume();
    });

    loadBtn.addEventListener('click', () => {
      if (!state.romLoaded || !state.saveSlots[slot - 1]) return;
      const ok = stateManager.loadFromSlot(slotId);
      if (ok) {
        applyAccuratePalette(emulator); // re-apply after state restore
        showToast(`STATE LOADED FROM SLOT ${slot}`);
        if (state.paused) {
          state.paused = false;
          emulator.resume();
          els.crtScreen.classList.remove('paused');
          els.btnPause.innerHTML = '&#x23F8;';
          els.btnPause.innerHTML = '&#x23F8;';
        }
      } else {
        showToast('ERROR: LOAD FAILED');
      }
    });

    // Restore previous saves from localStorage
    const existing = stateManager.listSlots();
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

// ── Mobile Touch Controls ───────────────────────────────────
function initTouchControls() {
  const btnMap = {
    up: 4, down: 5, left: 6, right: 7,
    a: 0,      // A = fire (dual shot when firepower > 1)
    b: 0,      // B = fire (always single shot)
    select: 2,
    start: 3,
  };

  document.querySelectorAll('[data-btn]').forEach((btn) => {
    const nesBtn = btnMap[btn.dataset.btn];
    if (nesBtn === undefined) return;
    const isA = btn.dataset.btn === 'a';
    const isB = btn.dataset.btn === 'b';

    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      btn.classList.add('active');
      if (!state.romLoaded) return;
      // A = dual shot mode, B = always single
      if (isA && mods.firepower >= 2) {
        // Force both bullet slots (same as keyboard dual shot)
        const speedIdx = emulator.readMemory(0x0201) & 0x1F || 0x01;
        const playerY = emulator.readMemory(0x0202);
        const playerX = emulator.readMemory(0x0203);
        if (emulator.readMemory(0x02E0) & 0x80) {
          emulator.writeMemory(0x02E0, speedIdx);
          emulator.writeMemory(0x02E1, playerY);
          emulator.writeMemory(0x02E2, playerX);
          emulator.writeMemory(0x02E3, 0);
          emulator.writeMemory(0x02E4, 0);
        }
        if (emulator.readMemory(0x02E8) & 0x80) {
          emulator.writeMemory(0x02E8, speedIdx);
          emulator.writeMemory(0x02E9, playerY);
          emulator.writeMemory(0x02EA, playerX);
          emulator.writeMemory(0x02EB, 0);
          emulator.writeMemory(0x02EC, 0);
        }
      }
      emulator.buttonDown(1, nesBtn);
    }, { passive: false });

    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      btn.classList.remove('active');
      if (state.romLoaded) emulator.buttonUp(1, nesBtn);
    }, { passive: false });

    btn.addEventListener('touchcancel', () => {
      btn.classList.remove('active');
      if (state.romLoaded) emulator.buttonUp(1, nesBtn);
    });
  });
}

// ── Joystick Toggle ────────────────────────────────────────
function initJoystickToggle() {
  const btn = $('#joystick-toggle');
  const overlay = $('#touch-overlay');
  const closeBtn = $('#touch-close');
  if (!btn || !overlay) return;

  // Start hidden
  overlay.classList.add('hidden');

  // Open joystick
  btn.addEventListener('click', () => {
    overlay.classList.remove('hidden');
    btn.classList.add('active');
  });

  // Close joystick (pill inside overlay)
  if (closeBtn) {
    closeBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      overlay.classList.add('hidden');
      btn.classList.remove('active');
    }, { passive: false });
    closeBtn.addEventListener('click', () => {
      overlay.classList.add('hidden');
      btn.classList.remove('active');
    });
  }
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

    // Keyboard shortcuts
    if (e.key === 'p' || e.key === 'P') els.btnPause.click();
    if (e.key === 'm' || e.key === 'M') els.btnSound.click();
    if (e.key === 'F5') { e.preventDefault(); stateManager.quickSave(); showToast('QUICK SAVE'); }
    if (e.key === 'F8') { e.preventDefault(); stateManager.quickLoad(); applyAccuratePalette(emulator); showToast('QUICK LOAD'); }
  });

  document.addEventListener('keyup', (e) => {
    const idx = keyMap[e.key];
    if (idx !== undefined && keyCaps[idx]) keyCaps[idx].classList.remove('active');
  });
}

// ── Initialize Everything ───────────────────────────────────
function init() {
  initEmulator();
  initRomLoader();
  initGameControls();
  initModControls();
  initToggleMods();
  initSaveLoad();
  initKeyboardHighlight();
  initTouchControls();
  initJoystickToggle();

  setTimeout(() => showToast('INSERT CARTRIDGE TO BEGIN', 4000), 500);

}


if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
