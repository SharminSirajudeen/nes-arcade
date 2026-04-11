/**
 * AudioEngineWorker — Reads audio from SharedArrayBuffer ring buffer
 * written by the NES Worker. Falls back to postMessage batches.
 *
 * Ring buffer layout in SharedArrayBuffer:
 * [0-3]   Int32: write index (Worker writes)
 * [4-7]   Int32: read index (this reads)
 * [8+]    Float32: interleaved L/R audio samples
 */

const SAMPLE_RATE = 44100;
const SCRIPT_BUFFER_SIZE = 4096;

export class AudioEngineWorker {
  #audioCtx = null;
  #gainNode = null;
  #scriptNode = null;
  #muted = false;
  #volume = 1.0;
  #initialized = false;

  // SharedArrayBuffer views
  #indices = null;    // Int32Array [writeIdx, readIdx]
  #samples = null;    // Float32Array (interleaved L/R)
  #capacity = 0;

  // Fallback ring buffer (for postMessage audio)
  #fallbackBufL = new Float32Array(16384);
  #fallbackBufR = new Float32Array(16384);
  #fbWritePos = 0;
  #fbReadPos = 0;
  #fbCount = 0;
  #useShared = false;

  // Last sample for hold-on-underrun
  #lastL = 0;
  #lastR = 0;

  /**
   * Create the SharedArrayBuffer for audio.
   * Call this before initializing the Worker — pass the SAB to the Worker.
   * @param {number} durationSeconds - buffer duration in seconds
   * @returns {SharedArrayBuffer|null} - null if SharedArrayBuffer unavailable
   */
  static createAudioSAB(durationSeconds = 0.5) {
    if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated) {
      return null;
    }
    // Header: 2 x Int32 (8 bytes) + samples: interleaved L/R Float32
    const sampleCount = Math.ceil(SAMPLE_RATE * durationSeconds * 2); // *2 for stereo interleaved
    const byteLength = 8 + sampleCount * 4; // 8 byte header + Float32 samples
    const sab = new SharedArrayBuffer(byteLength);
    // Initialize indices to 0
    const indices = new Int32Array(sab, 0, 2);
    indices[0] = 0; // writeIdx
    indices[1] = 0; // readIdx
    return sab;
  }

  /**
   * Initialize with a SharedArrayBuffer (or null for fallback mode).
   * Must be called from a user gesture context.
   */
  async init(audioSAB) {
    if (this.#initialized) return true;

    try {
      this.#audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: SAMPLE_RATE,
        latencyHint: 'interactive',
      });

      if (this.#audioCtx.state === 'suspended') {
        await this.#audioCtx.resume();
      }

      this.#gainNode = this.#audioCtx.createGain();
      this.#gainNode.gain.value = this.#volume;
      this.#gainNode.connect(this.#audioCtx.destination);

      if (audioSAB) {
        this.#indices = new Int32Array(audioSAB, 0, 2);
        this.#samples = new Float32Array(audioSAB, 8);
        this.#capacity = this.#samples.length;
        this.#useShared = true;
      }

      this.#setupScriptProcessor();
      this.#initialized = true;
      return true;
    } catch (err) {
      console.warn('AudioEngineWorker: Failed to initialize -', err.message);
      return false;
    }
  }

  /** Receive a batch of audio samples via postMessage (fallback mode) */
  receiveBatch(left, right) {
    if (!this.#initialized) return;
    for (let i = 0; i < left.length; i++) {
      if (this.#fbCount >= 16384) break;
      this.#fallbackBufL[this.#fbWritePos] = left[i];
      this.#fallbackBufR[this.#fbWritePos] = right[i];
      this.#fbWritePos = (this.#fbWritePos + 1) & 16383;
      this.#fbCount++;
    }
  }

  setMuted(muted) {
    this.#muted = muted;
    if (this.#gainNode) this.#gainNode.gain.value = muted ? 0 : this.#volume;
  }

  toggleMute() { this.setMuted(!this.#muted); return this.#muted; }
  get isMuted() { return this.#muted; }

  setVolume(vol) {
    this.#volume = Math.max(0, Math.min(1, vol));
    if (this.#gainNode && !this.#muted) this.#gainNode.gain.value = this.#volume;
  }

  get volume() { return this.#volume; }
  get isInitialized() { return this.#initialized; }

  async resume() {
    if (this.#audioCtx && this.#audioCtx.state === 'suspended') {
      await this.#audioCtx.resume();
    }
  }

  destroy() {
    if (this.#scriptNode) { this.#scriptNode.disconnect(); this.#scriptNode = null; }
    if (this.#gainNode) { this.#gainNode.disconnect(); this.#gainNode = null; }
    if (this.#audioCtx) { this.#audioCtx.close().catch(() => {}); this.#audioCtx = null; }
    this.#initialized = false;
  }

  // ── Private ──────────────────────────────────────────────

  #setupScriptProcessor() {
    this.#scriptNode = this.#audioCtx.createScriptProcessor(SCRIPT_BUFFER_SIZE, 0, 2);

    this.#scriptNode.onaudioprocess = (event) => {
      const outL = event.outputBuffer.getChannelData(0);
      const outR = event.outputBuffer.getChannelData(1);
      const len = outL.length;

      if (this.#useShared) {
        this.#readShared(outL, outR, len);
      } else {
        this.#readFallback(outL, outR, len);
      }
    };

    this.#scriptNode.connect(this.#gainNode);
  }

  /** Read interleaved samples from SharedArrayBuffer ring buffer */
  #readShared(outL, outR, len) {
    let readPos = Atomics.load(this.#indices, 1);
    const writePos = Atomics.load(this.#indices, 0);

    // Calculate available samples
    let available;
    if (writePos >= readPos) {
      available = writePos - readPos;
    } else {
      available = this.#capacity - readPos + writePos;
    }
    // available is count of interleaved floats, divide by 2 for stereo pairs
    const pairs = Math.floor(available / 2);

    for (let i = 0; i < len; i++) {
      if (i < pairs) {
        this.#lastL = this.#samples[readPos];
        readPos = (readPos + 1) % this.#capacity;
        this.#lastR = this.#samples[readPos];
        readPos = (readPos + 1) % this.#capacity;
        outL[i] = this.#lastL;
        outR[i] = this.#lastR;
      } else {
        // Underrun: hold last sample, gently fade
        outL[i] = this.#lastL;
        outR[i] = this.#lastR;
        this.#lastL *= 0.99;
        this.#lastR *= 0.99;
      }
    }

    Atomics.store(this.#indices, 1, readPos);
  }

  /** Read from fallback postMessage ring buffer */
  #readFallback(outL, outR, len) {
    for (let i = 0; i < len; i++) {
      if (this.#fbCount > 0) {
        this.#lastL = this.#fallbackBufL[this.#fbReadPos];
        this.#lastR = this.#fallbackBufR[this.#fbReadPos];
        outL[i] = this.#lastL;
        outR[i] = this.#lastR;
        this.#fbReadPos = (this.#fbReadPos + 1) & 16383;
        this.#fbCount--;
      } else {
        outL[i] = this.#lastL;
        outR[i] = this.#lastR;
        this.#lastL *= 0.99;
        this.#lastR *= 0.99;
      }
    }
  }
}
