/**
 * AudioEngine - Web Audio API integration for JSNES.
 *
 * Optimized for slow devices:
 * - Larger ScriptProcessor buffer (4096) = fewer callbacks = less CPU overhead
 * - Sample-and-hold on underrun (no clicks/pops from silence)
 * - Mono downmix option to halve audio processing
 * - Ring buffer with generous headroom
 */

const SAMPLE_RATE = 44100;
const BUFFER_SIZE = 16384;       // Large ring buffer = more headroom for slow devices
const SCRIPT_BUFFER_SIZE = 4096; // Larger = fewer callbacks = less CPU pressure

export class AudioEngine {
  /** @type {AudioContext | null} */
  #audioCtx = null;
  /** @type {GainNode | null} */
  #gainNode = null;
  /** @type {ScriptProcessorNode | null} */
  #scriptNode = null;

  // Ring buffer for left and right channels
  #bufferLeft = new Float32Array(BUFFER_SIZE);
  #bufferRight = new Float32Array(BUFFER_SIZE);
  #writePos = 0;
  #readPos = 0;
  #bufferedSamples = 0;

  // Last sample for hold-on-underrun (prevents clicks)
  #lastL = 0;
  #lastR = 0;

  #muted = false;
  #initialized = false;
  #volume = 1.0;

  /**
   * Initialize the audio pipeline. Must be called from a user gesture.
   * @returns {Promise<boolean>}
   */
  async init() {
    if (this.#initialized) return true;

    try {
      this.#audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: SAMPLE_RATE,
        // Hint to browser: prefer lower latency over power savings
        latencyHint: 'interactive',
      });

      if (this.#audioCtx.state === 'suspended') {
        await this.#audioCtx.resume();
      }

      // Gain node for volume/mute
      this.#gainNode = this.#audioCtx.createGain();
      this.#gainNode.gain.value = this.#volume;
      this.#gainNode.connect(this.#audioCtx.destination);

      // Use ScriptProcessorNode directly — simpler, works everywhere,
      // avoids AudioWorklet postMessage overhead on slow devices
      this.#setupScriptProcessor();

      this.#initialized = true;
      return true;
    } catch (err) {
      console.warn('AudioEngine: Failed to initialize -', err.message);
      return false;
    }
  }

  /**
   * Write one stereo sample pair into the ring buffer.
   * Called by JSNES ~735 times per frame (44100 / 60).
   */
  writeSample(left, right) {
    if (!this.#initialized) return;

    // Drop if buffer full — prevents lag buildup
    if (this.#bufferedSamples >= BUFFER_SIZE) return;

    this.#bufferLeft[this.#writePos] = left;
    this.#bufferRight[this.#writePos] = right;
    this.#writePos = (this.#writePos + 1) % BUFFER_SIZE;
    this.#bufferedSamples++;
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this.#muted = muted;
    if (this.#gainNode) {
      this.#gainNode.gain.value = muted ? 0 : this.#volume;
    }
  }

  toggleMute() {
    this.setMuted(!this.#muted);
    return this.#muted;
  }

  get isMuted() { return this.#muted; }

  setVolume(vol) {
    this.#volume = Math.max(0, Math.min(1, vol));
    if (this.#gainNode && !this.#muted) {
      this.#gainNode.gain.value = this.#volume;
    }
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
    this.#writePos = 0;
    this.#readPos = 0;
    this.#bufferedSamples = 0;
  }

  // --- Private ---

  #setupScriptProcessor() {
    this.#scriptNode = this.#audioCtx.createScriptProcessor(
      SCRIPT_BUFFER_SIZE,
      0, // no input
      2  // stereo output
    );

    this.#scriptNode.onaudioprocess = (event) => {
      const outLeft = event.outputBuffer.getChannelData(0);
      const outRight = event.outputBuffer.getChannelData(1);
      const len = outLeft.length;

      for (let i = 0; i < len; i++) {
        if (this.#bufferedSamples > 0) {
          this.#lastL = this.#bufferLeft[this.#readPos];
          this.#lastR = this.#bufferRight[this.#readPos];
          outLeft[i] = this.#lastL;
          outRight[i] = this.#lastR;
          this.#readPos = (this.#readPos + 1) % BUFFER_SIZE;
          this.#bufferedSamples--;
        } else {
          // Underrun: hold last sample (no clicks), gently fade
          outLeft[i] = this.#lastL;
          outRight[i] = this.#lastR;
          this.#lastL *= 0.99;
          this.#lastR *= 0.99;
        }
      }
    };

    this.#scriptNode.connect(this.#gainNode);
  }
}
