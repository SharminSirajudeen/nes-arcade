/**
 * NES Worker — Runs JSNES emulation in a dedicated thread.
 *
 * This Worker owns:
 * - The JSNES NES instance (CPU, PPU, APU emulation)
 * - The frame loop (setInterval at 60fps — NOT rAF)
 * - Audio sample generation (writes to SharedArrayBuffer ring buffer)
 * - Memory hacking (speed, firepower, lives, dual fighter)
 * - Palette fix (Nestopia-accurate colors)
 *
 * Communicates with main thread via:
 * - postMessage for frames (Transferable Uint32Array), commands, state
 * - SharedArrayBuffer for audio samples (zero-copy, zero-latency)
 */

importScripts('./vendor/jsnes.min.js');

// ── Constants ───────────────────────────────────────────────
const NES_WIDTH = 256;
const NES_HEIGHT = 240;
const FRAME_RATE = 60.098; // NTSC
const FRAME_INTERVAL = 1000 / FRAME_RATE;
const PIXEL_COUNT = NES_WIDTH * NES_HEIGHT;

// ── State ───────────────────────────────────────────────────
let nes = null;
let running = false;
let frameTimer = null;

// Double-buffer for frame pixels (avoids allocation per frame)
let pixelBufA = new Uint32Array(PIXEL_COUNT);
let pixelBufB = new Uint32Array(PIXEL_COUNT);
let currentBuf = pixelBufA;

// Audio ring buffer (SharedArrayBuffer)
let audioSAB = null;
let audioWriteIdx = null;  // Int32Array view for write index
let audioReadIdx = null;   // Int32Array view for read index
let audioBuffer = null;    // Float32Array view for sample data
let audioCapacity = 0;
let audioBatchL = new Float32Array(1024);
let audioBatchR = new Float32Array(1024);
let audioBatchPos = 0;

// Fallback: postMessage audio batching (pre-allocated to avoid GC pressure)
let useSharedAudio = false;
let fallbackBatchL = new Float32Array(2048);
let fallbackBatchR = new Float32Array(2048);
let fallbackBatchPos = 0;

// Mods
const mods = {
  speed: 1,
  firepower: 1,
  infiniteLives: false,
  frozenLives: null,
  dualFighter: false,
};
let lastPlayerX = -1;
let fireKeyHeld = false;

// FPS tracking
let frameCount = 0;
let fpsTimestamp = performance.now();
let currentFps = 60;

// ── Nestopia Palette ────────────────────────────────────────
const NESTOPIA_PALETTE = [
  0x636363, 0x00298c, 0x1010a5, 0x3a00a5, 0x5a007b, 0x6b0042, 0x6b0800, 0x522100,
  0x313100, 0x084a00, 0x005200, 0x005208, 0x00424a, 0x000000, 0x000000, 0x000000,
  0xadadad, 0x1963d6, 0x4242ff, 0x7329ff, 0x9c19ce, 0xb5217b, 0xb53121, 0x9c4a00,
  0x6b6b00, 0x3a8400, 0x109400, 0x008c31, 0x007b8c, 0x000000, 0x000000, 0x000000,
  0xffffff, 0x63adff, 0x9494ff, 0xc573ff, 0xef6bff, 0xff6bce, 0xff8473, 0xe69c21,
  0xbdbd00, 0x8cd600, 0x5ae631, 0x42de84, 0x4acede, 0x525252, 0x000000, 0x000000,
  0xffffff, 0xbddeff, 0xd6d6ff, 0xe6c5ff, 0xf7c5ff, 0xffc5e6, 0xffcec5, 0xf7d6a5,
  0xe6e694, 0xceef94, 0xbdf7ad, 0xb5f7ce, 0xb5efef, 0xb5b5b5, 0x000000, 0x000000,
];

function applyPalette() {
  if (!nes || !nes.ppu || !nes.ppu.palTable) return;
  const palTable = nes.ppu.palTable;
  for (let i = 0; i < 64; i++) palTable.curTable[i] = NESTOPIA_PALETTE[i];
  if (palTable.emphTable) {
    for (let emph = 0; emph < 8; emph++) {
      if (!palTable.emphTable[emph]) continue;
      const rA = (emph & 1) ? 0.75 : 1.0;
      const gA = (emph & 2) ? 0.75 : 1.0;
      const bA = (emph & 4) ? 0.75 : 1.0;
      for (let i = 0; i < 64; i++) {
        const base = NESTOPIA_PALETTE[i];
        const r = Math.round(((base >> 16) & 0xFF) * gA * bA);
        const g = Math.round(((base >> 8) & 0xFF) * rA * bA);
        const b = Math.round((base & 0xFF) * rA * gA);
        palTable.emphTable[emph][i] = (r << 16) | (g << 8) | b;
      }
    }
  }
}

// ── Audio: SharedArrayBuffer ring buffer ────────────────────
// Simple SPSC ring buffer using SharedArrayBuffer:
// Layout: [writeIdx (Int32), readIdx (Int32), ...samples (Float32)]

let audioIndices = null; // Int32Array [0]=writeIdx, [1]=readIdx

function initSharedAudio(sab) {
  audioSAB = sab;
  audioIndices = new Int32Array(sab, 0, 2);
  audioBuffer = new Float32Array(sab, 8);
  audioCapacity = audioBuffer.length;
  Atomics.store(audioIndices, 0, 0);
  Atomics.store(audioIndices, 1, 0);
  useSharedAudio = true;
}

function writeAudioSample(left, right) {
  if (useSharedAudio) {
    audioBatchL[audioBatchPos] = left;
    audioBatchR[audioBatchPos] = right;
    audioBatchPos++;
    // Flush batch when full or at frame end
    if (audioBatchPos >= 1024) flushAudioBatch();
  } else {
    // Fallback: collect in pre-allocated arrays
    if (fallbackBatchPos < 2048) {
      fallbackBatchL[fallbackBatchPos] = left;
      fallbackBatchR[fallbackBatchPos] = right;
      fallbackBatchPos++;
    }
  }
}

function flushAudioBatch() {
  if (!useSharedAudio || audioBatchPos === 0) return;

  const writePos = Atomics.load(audioIndices, 0);
  const readPos = Atomics.load(audioIndices, 1);

  // Available space in ring buffer
  let available;
  if (writePos >= readPos) {
    available = audioCapacity - (writePos - readPos) - 1;
  } else {
    available = readPos - writePos - 1;
  }

  // Force even to maintain L/R interleave alignment
  const samplesToWrite = Math.min(audioBatchPos * 2, available) & ~1;
  let wp = writePos;
  const pairsToWrite = samplesToWrite >> 1;

  for (let i = 0; i < pairsToWrite; i++) {
    audioBuffer[wp] = audioBatchL[i];
    wp = (wp + 1) % audioCapacity;
    audioBuffer[wp] = audioBatchR[i];
    wp = (wp + 1) % audioCapacity;
  }

  Atomics.store(audioIndices, 0, wp);
  audioBatchPos = 0;
}

// ── Frame rendering ─────────────────────────────────────────
function onFrame(frameBuffer) {
  const buf = currentBuf;
  for (let i = 0; i < PIXEL_COUNT; i++) {
    const p = frameBuffer[i];
    const r = (p >> 16) & 0xFF;
    const g = (p >> 8) & 0xFF;
    const b = p & 0xFF;
    buf[i] = 0xFF000000 | (b << 16) | (g << 8) | r;
  }
}

function onAudioSample(left, right) {
  writeAudioSample(left, right);
}

// ── Mod logic (runs per frame) ──────────────────────────────
function applyPreFrameMods() {
  // Firepower: zero fire cooldowns for instant re-fire
  if (mods.firepower > 1) {
    nes.cpu.mem[0x60] = 0x14;
    nes.cpu.mem[0xC9] = 0x00;
  }
}

function applyPostFrameMods() {
  const currentX = nes.cpu.mem[0x0203];

  // Speed multiplier
  if (mods.speed > 1 && lastPlayerX >= 0) {
    const delta = currentX - lastPlayerX;
    if (delta !== 0 && Math.abs(delta) >= 1 && Math.abs(delta) <= 2) {
      const extra = delta * (mods.speed - 1);
      let newX = currentX + extra;
      newX = Math.max(16, Math.min(223, newX));
      nes.cpu.mem[0x0203] = newX & 0xFF;
    }
  }
  lastPlayerX = nes.cpu.mem[0x0203];

  // Firepower: faster bullets
  if (mods.firepower > 1) {
    const extraUp = Math.min((mods.firepower - 1) + 1, 5);
    const b1Flag = nes.cpu.mem[0x02E0];
    if ((b1Flag & 0x80) === 0) {
      const y = nes.cpu.mem[0x02E1];
      if (y > 8) nes.cpu.mem[0x02E1] = (y - extraUp) & 0xFF;
    }
    const b2Flag = nes.cpu.mem[0x02E8];
    if ((b2Flag & 0x80) === 0) {
      const y = nes.cpu.mem[0x02E9];
      if (y > 8) nes.cpu.mem[0x02E9] = (y - extraUp) & 0xFF;
    }
  }

  // Infinite lives
  if (mods.infiniteLives && mods.frozenLives !== null) {
    nes.cpu.mem[0x0487] = mods.frozenLives;
  }

  // Dual fighter
  if (mods.dualFighter) {
    nes.cpu.mem[0x79] = 0x01;
    const ship2State = nes.cpu.mem[0x0210];
    if (ship2State === 0 || (ship2State & 0x80) !== 0) {
      for (let i = 0; i < 16; i++) {
        nes.cpu.mem[0x0210 + i] = nes.cpu.mem[0x0200 + i];
      }
    }
    nes.cpu.mem[0x0212] = nes.cpu.mem[0x0202];
    nes.cpu.mem[0x0213] = nes.cpu.mem[0x0203] + 16;
  }
}

// ── Frame loop ──────────────────────────────────────────────
function tick() {
  if (!running || !nes) return;

  // FPS tracking
  frameCount++;
  const now = performance.now();
  if (now - fpsTimestamp >= 1000) {
    currentFps = Math.round((frameCount * 1000) / (now - fpsTimestamp));
    frameCount = 0;
    fpsTimestamp = now;
  }

  // Pre-frame mods
  applyPreFrameMods();

  // Run one NES frame
  nes.frame();

  // Post-frame mods
  applyPostFrameMods();

  // Send frame pixels to main thread FIRST
  const pixels = currentBuf;
  postMessage({ type: 'frame', pixels, fps: currentFps }, [pixels.buffer]);

  // THEN flush audio — so video postMessage and audio buffer update
  // arrive at approximately the same time on the main thread
  flushAudioBatch();

  // The sent buffer is now neutered. Reallocate it immediately.
  if (pixels === pixelBufA) {
    pixelBufA = new Uint32Array(PIXEL_COUNT);
    currentBuf = pixelBufB;
  } else {
    pixelBufB = new Uint32Array(PIXEL_COUNT);
    currentBuf = pixelBufA;
  }
  // If the alternate buffer was also neutered (no return-buffer arrived), reallocate
  if (currentBuf.length === 0) {
    currentBuf = new Uint32Array(PIXEL_COUNT);
  }

  // Send fallback audio if not using SharedArrayBuffer
  if (!useSharedAudio && fallbackBatchPos > 0) {
    const l = fallbackBatchL.slice(0, fallbackBatchPos);
    const r = fallbackBatchR.slice(0, fallbackBatchPos);
    postMessage({ type: 'audio', l, r }, [l.buffer, r.buffer]);
    fallbackBatchPos = 0;
  }
}

// ── Dual shot helper ────────────────────────────────────────
function dualShotFire() {
  if (!nes || mods.firepower < 2) return;
  const speedIdx = nes.cpu.mem[0x0201] & 0x1F || 0x01;
  const playerY = nes.cpu.mem[0x0202];
  const playerX = nes.cpu.mem[0x0203];
  if (nes.cpu.mem[0x02E0] & 0x80) {
    nes.cpu.mem[0x02E0] = speedIdx;
    nes.cpu.mem[0x02E1] = playerY;
    nes.cpu.mem[0x02E2] = playerX;
    nes.cpu.mem[0x02E3] = 0;
    nes.cpu.mem[0x02E4] = 0;
  }
  if (nes.cpu.mem[0x02E8] & 0x80) {
    nes.cpu.mem[0x02E8] = speedIdx;
    nes.cpu.mem[0x02E9] = playerY;
    nes.cpu.mem[0x02EA] = playerX;
    nes.cpu.mem[0x02EB] = 0;
    nes.cpu.mem[0x02EC] = 0;
  }
}

// ── Message handler ─────────────────────────────────────────
onmessage = function(e) {
  const msg = e.data;

  switch (msg.type) {
    case 'init':
      nes = new jsnes.NES({
        onFrame: onFrame,
        onAudioSample: onAudioSample,
        sampleRate: 44100,
      });
      if (msg.audioSAB) {
        initSharedAudio(msg.audioSAB);
      }
      postMessage({ type: 'ready' });
      break;

    case 'load-rom':
      if (!nes) break;
      try {
        nes.loadROM(msg.romData);
        applyPalette();
        lastPlayerX = -1;
        postMessage({ type: 'rom-loaded' });
      } catch (err) {
        postMessage({ type: 'error', message: err.message });
      }
      break;

    case 'start':
      if (!nes) break;
      running = true;
      fpsTimestamp = performance.now();
      frameCount = 0;
      if (frameTimer) clearInterval(frameTimer);
      frameTimer = setInterval(tick, 1000 / FRAME_RATE);
      break;

    case 'pause':
      running = false;
      if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
      break;

    case 'resume':
      if (!nes) break;
      running = true;
      fpsTimestamp = performance.now();
      frameCount = 0;
      if (frameTimer) clearInterval(frameTimer);
      frameTimer = setInterval(tick, 1000 / FRAME_RATE);
      break;

    case 'reset':
      if (!nes || !msg.romData) break;
      running = false;
      if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
      nes.loadROM(msg.romData);
      applyPalette();
      lastPlayerX = -1;
      running = true;
      frameTimer = setInterval(tick, 1000 / FRAME_RATE);
      break;

    case 'button-down':
      if (nes) {
        nes.buttonDown(msg.player, msg.button);
        if (msg.button === 0 && mods.firepower >= 2) dualShotFire();
      }
      break;

    case 'button-up':
      if (nes) nes.buttonUp(msg.player, msg.button);
      break;

    case 'set-mod':
      if (msg.mod === 'speed') mods.speed = msg.value;
      else if (msg.mod === 'firepower') mods.firepower = msg.value;
      break;

    case 'infinite-lives':
      mods.infiniteLives = msg.enabled;
      if (msg.enabled && nes) {
        mods.frozenLives = nes.cpu.mem[0x0487];
      } else {
        mods.frozenLives = null;
      }
      break;

    case 'dual-fighter':
      mods.dualFighter = msg.enabled;
      if (!msg.enabled && nes) nes.cpu.mem[0x79] = 0x00;
      break;

    case 'dual-shot-fire':
      dualShotFire();
      break;

    case 'save-state':
      if (!nes) break;
      try {
        const state = nes.toJSON();
        postMessage({ type: 'state-saved', state, slotId: msg.slotId });
      } catch (err) {
        postMessage({ type: 'error', message: 'Save failed: ' + err.message });
      }
      break;

    case 'load-state':
      if (!nes) break;
      try {
        nes.fromJSON(msg.state);
        applyPalette();
        postMessage({ type: 'state-loaded' });
      } catch (err) {
        postMessage({ type: 'error', message: 'Load failed: ' + err.message });
      }
      break;

    // Return a pixel buffer to the Worker for reuse (double-buffering)
    case 'return-buffer':
      if (msg.buffer) {
        const returned = new Uint32Array(msg.buffer);
        if (returned.length === PIXEL_COUNT) {
          if (pixelBufA.length === 0) pixelBufA = returned;
          else if (pixelBufB.length === 0) pixelBufB = returned;
        }
      }
      break;
  }
};
