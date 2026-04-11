/**
 * WorkerBridge — Main-thread proxy for the NES Worker.
 *
 * Presents a similar API to EmulatorCore so existing code
 * (InputHandler, main.js, touch controls) works with minimal changes.
 * All calls are forwarded to the Worker via postMessage.
 */

export class WorkerBridge {
  #worker = null;
  #onFrameCallback = null;
  #onStateCallback = null;
  #romData = null; // saved for reset
  #running = false;

  // Pending promise resolvers for request/response patterns
  #pendingSave = null;
  #pendingLoad = null;
  #onAudioBatch = null;

  constructor(workerPath) {
    this.#worker = new Worker(workerPath);
    this.#worker.onmessage = (e) => this.#handleMessage(e.data);
    this.#worker.onerror = (err) => console.error('Worker error:', err);
  }

  /** Initialize the NES instance inside the Worker */
  init(audioSAB) {
    this.#worker.postMessage({ type: 'init', audioSAB });
  }

  /** Load a ROM into the Worker's JSNES instance */
  loadROM(romData) {
    this.#romData = romData;
    this.#worker.postMessage({ type: 'load-rom', romData });
  }

  /** Start the emulation loop */
  start() {
    this.#running = true;
    this.#worker.postMessage({ type: 'start' });
  }

  /** Pause emulation */
  pause() {
    this.#running = false;
    this.#worker.postMessage({ type: 'pause' });
  }

  /** Resume emulation */
  resume() {
    this.#running = true;
    this.#worker.postMessage({ type: 'resume' });
  }

  /** Reset by reloading the ROM */
  reset() {
    this.#worker.postMessage({ type: 'reset', romData: this.#romData });
  }

  /** Controller button press */
  buttonDown(player, button) {
    this.#worker.postMessage({ type: 'button-down', player, button });
  }

  /** Controller button release */
  buttonUp(player, button) {
    this.#worker.postMessage({ type: 'button-up', player, button });
  }

  /** Set a mod value (speed, firepower) */
  setMod(mod, value) {
    this.#worker.postMessage({ type: 'set-mod', mod, value });
  }

  /** Toggle infinite lives */
  setInfiniteLives(enabled) {
    this.#worker.postMessage({ type: 'infinite-lives', enabled });
  }

  /** Toggle dual fighter */
  setDualFighter(enabled) {
    this.#worker.postMessage({ type: 'dual-fighter', enabled });
  }

  /** Fire dual shot (touch A button) */
  dualShotFire() {
    this.#worker.postMessage({ type: 'dual-shot-fire' });
  }

  /** Save state — returns Promise that resolves with {state, slotId} */
  saveState(slotId) {
    return new Promise((resolve) => {
      this.#pendingSave = { resolve, slotId };
      this.#worker.postMessage({ type: 'save-state', slotId });
    });
  }

  /** Load a previously saved state */
  loadState(state) {
    return new Promise((resolve) => {
      this.#pendingLoad = resolve;
      this.#worker.postMessage({ type: 'load-state', state });
    });
  }

  /** Register callback for incoming frame data */
  onFrame(callback) {
    this.#onFrameCallback = callback;
  }

  /** Register callback for fallback audio batches */
  onAudioBatch(callback) {
    this.#onAudioBatch = callback;
  }

  /** Register callback for state events */
  onStateEvent(callback) {
    this.#onStateCallback = callback;
  }

  /** Return a used pixel buffer to the Worker for reuse */
  returnBuffer(buffer) {
    if (buffer && buffer.byteLength > 0) {
      this.#worker.postMessage({ type: 'return-buffer', buffer }, [buffer]);
    }
  }

  get isRunning() { return this.#running; }
  get lastRomData() { return this.#romData; }

  // ── Private ──────────────────────────────────────────────
  #handleMessage(msg) {
    switch (msg.type) {
      case 'ready':
        break;

      case 'rom-loaded':
        if (this.#onStateCallback) this.#onStateCallback('rom-loaded');
        break;

      case 'frame':
        if (this.#onFrameCallback) {
          this.#onFrameCallback(msg.pixels, msg.fps);
        }
        break;

      case 'audio':
        if (this.#onAudioBatch) this.#onAudioBatch(msg.l, msg.r);
        break;

      case 'state-saved':
        if (this.#pendingSave) {
          this.#pendingSave.resolve({ state: msg.state, slotId: msg.slotId });
          this.#pendingSave = null;
        }
        break;

      case 'state-loaded':
        if (this.#pendingLoad) {
          this.#pendingLoad(true);
          this.#pendingLoad = null;
        }
        if (this.#onStateCallback) this.#onStateCallback('state-loaded');
        break;

      case 'error':
        console.error('Worker error:', msg.message);
        if (this.#pendingSave) {
          this.#pendingSave.resolve({ error: msg.message });
          this.#pendingSave = null;
        }
        if (this.#pendingLoad) {
          this.#pendingLoad(false);
          this.#pendingLoad = null;
        }
        if (this.#onStateCallback) this.#onStateCallback('error', msg.message);
        break;
    }
  }
}
