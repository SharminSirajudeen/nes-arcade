/**
 * EmulatorCore - Wraps JSNES, manages the frame loop, ROM loading, and lifecycle.
 *
 * Responsibilities:
 * - Initialize JSNES instance with onFrame / onAudioSample callbacks
 * - Run the main loop at 60 fps via requestAnimationFrame
 * - Expose hooks so other modules can inject per-frame logic (memory hacks)
 * - Pause / resume / reset
 */

const FRAME_RATE = 60;
const FRAME_INTERVAL_MS = 1000 / FRAME_RATE;

export class EmulatorCore {
  /** @type {jsnes.NES | null} */
  #nes = null;
  #running = false;
  #rafId = null;
  #lastFrameTime = 0;
  #romLoaded = false;

  // Callbacks registered by other modules
  #onFrameRender = null;   // (frameBuffer: Uint8Array) => void
  #onAudioSample = null;   // (left: number, right: number) => void
  #preFrameHooks = [];     // Array<() => void>  -- run before each nes.frame()
  #postFrameHooks = [];    // Array<() => void>  -- run after each nes.frame()

  // Performance telemetry
  #frameCount = 0;
  #fpsTimestamp = 0;
  #currentFps = 0;

  constructor() {
    // JSNES must be loaded globally via <script> tag (jsnes.min.js)
    if (typeof jsnes === 'undefined') {
      throw new Error('JSNES library not found. Include jsnes.min.js before this module.');
    }
  }

  /**
   * Initialize the NES instance. Must be called before loadROM.
   * @param {{ onFrame: Function, onAudioSample: Function }} callbacks
   */
  init({ onFrame, onAudioSample }) {
    this.#onFrameRender = onFrame;
    this.#onAudioSample = onAudioSample;

    this.#nes = new jsnes.NES({
      onFrame: (frameBuffer) => {
        if (this.#onFrameRender) {
          this.#onFrameRender(frameBuffer);
        }
      },
      onAudioSample: (left, right) => {
        if (this.#onAudioSample) {
          this.#onAudioSample(left, right);
        }
      },
      sampleRate: 44100,
    });
  }

  /** @returns {object} Raw JSNES NES instance for direct access */
  get nes() {
    return this.#nes;
  }

  /** @returns {boolean} */
  get isRunning() {
    return this.#running;
  }

  /** @returns {boolean} */
  get isRomLoaded() {
    return this.#romLoaded;
  }

  /** @returns {number} Current measured FPS */
  get fps() {
    return this.#currentFps;
  }

  /**
   * Load a ROM into the emulator.
   * @param {string} romData - ROM data as a binary string (JSNES expects this format)
   */
  loadROM(romData) {
    if (!this.#nes) {
      throw new Error('EmulatorCore not initialized. Call init() first.');
    }
    try {
      this.#nes.loadROM(romData);
      this.#romLoaded = true;
    } catch (err) {
      this.#romLoaded = false;
      throw new Error(`Failed to load ROM: ${err.message}`);
    }
  }

  /**
   * Register a hook to run before each nes.frame() call.
   * Use this for memory writes (hacks) so they take effect before the CPU runs.
   * @param {Function} fn
   * @returns {Function} Unsubscribe function
   */
  addPreFrameHook(fn) {
    this.#preFrameHooks.push(fn);
    return () => {
      const idx = this.#preFrameHooks.indexOf(fn);
      if (idx !== -1) this.#preFrameHooks.splice(idx, 1);
    };
  }

  /**
   * Register a hook to run after each nes.frame() call.
   * Use this for memory reads / telemetry.
   * @param {Function} fn
   * @returns {Function} Unsubscribe function
   */
  addPostFrameHook(fn) {
    this.#postFrameHooks.push(fn);
    return () => {
      const idx = this.#postFrameHooks.indexOf(fn);
      if (idx !== -1) this.#postFrameHooks.splice(idx, 1);
    };
  }

  /** Start the emulation loop */
  start() {
    if (!this.#romLoaded) {
      throw new Error('No ROM loaded.');
    }
    if (this.#running) return;

    this.#running = true;
    this.#lastFrameTime = performance.now();
    this.#fpsTimestamp = this.#lastFrameTime;
    this.#frameCount = 0;
    this.#tick(this.#lastFrameTime);
  }

  /** Pause emulation */
  pause() {
    this.#running = false;
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
  }

  /** Resume from pause */
  resume() {
    if (this.#running) return;
    this.start();
  }

  /** Toggle pause/resume */
  toggle() {
    if (this.#running) {
      this.pause();
    } else {
      this.resume();
    }
  }

  /** Hard reset the NES CPU + PPU */
  reset() {
    if (!this.#nes) return;
    this.pause();
    // JSNES reset is done by reloading -- no explicit reset method in v2
    // We re-init from saved ROM if needed. For now, reset CPU regs.
    if (this.#nes.cpu) {
      this.#nes.cpu.reset();
    }
    if (this.#nes.ppu) {
      this.#nes.ppu.reset();
    }
  }

  /** Save complete emulator state */
  saveState() {
    if (!this.#nes) return null;
    try {
      return this.#nes.toJSON();
    } catch (err) {
      console.error('Failed to save state:', err);
      return null;
    }
  }

  /** Load a previously saved emulator state */
  loadState(state) {
    if (!this.#nes || !state) return false;
    try {
      this.#nes.fromJSON(state);
      return true;
    } catch (err) {
      console.error('Failed to load state:', err);
      return false;
    }
  }

  /**
   * Direct CPU memory read.
   * @param {number} address
   * @returns {number} byte value (0-255)
   */
  readMemory(address) {
    if (!this.#nes) return 0;
    return this.#nes.cpu.mem[address] & 0xFF;
  }

  /**
   * Direct CPU memory write.
   * @param {number} address
   * @param {number} value (0-255)
   */
  writeMemory(address, value) {
    if (!this.#nes) return;
    this.#nes.cpu.mem[address] = value & 0xFF;
  }

  /**
   * Controller button press.
   * @param {number} player - 1 or 2
   * @param {number} button - jsnes.Controller.BUTTON_* constant
   */
  buttonDown(player, button) {
    if (!this.#nes) return;
    this.#nes.buttonDown(player, button);
  }

  /**
   * Controller button release.
   * @param {number} player
   * @param {number} button
   */
  buttonUp(player, button) {
    if (!this.#nes) return;
    this.#nes.buttonUp(player, button);
  }

  // --- Private ---

  /** @param {number} timestamp - from requestAnimationFrame */
  #tick(timestamp) {
    if (!this.#running) return;

    // FPS counter
    this.#frameCount++;
    const fpsDelta = timestamp - this.#fpsTimestamp;
    if (fpsDelta >= 1000) {
      this.#currentFps = Math.round((this.#frameCount * 1000) / fpsDelta);
      this.#frameCount = 0;
      this.#fpsTimestamp = timestamp;
    }

    // Frame timing -- run one NES frame per rAF.
    // The browser's rAF typically fires at 60Hz on 60Hz displays.
    // On higher-refresh displays we throttle to ~60fps.
    const elapsed = timestamp - this.#lastFrameTime;
    if (elapsed >= FRAME_INTERVAL_MS - 1) {
      // Pre-frame hooks (memory writes for hacks)
      for (let i = 0; i < this.#preFrameHooks.length; i++) {
        this.#preFrameHooks[i]();
      }

      // Run one NES frame -- this triggers onFrame and onAudioSample callbacks
      this.#nes.frame();

      // Post-frame hooks (memory reads for display)
      for (let i = 0; i < this.#postFrameHooks.length; i++) {
        this.#postFrameHooks[i]();
      }

      this.#lastFrameTime = timestamp;
    }

    this.#rafId = requestAnimationFrame((ts) => this.#tick(ts));
  }
}
