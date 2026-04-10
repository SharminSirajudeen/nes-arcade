/**
 * AudioEngine - Web Audio API integration for JSNES.
 *
 * JSNES calls onAudioSample(left, right) at 44100 Hz (~735 times per frame).
 * We buffer these samples and play them via an AudioWorklet (preferred) or
 * ScriptProcessorNode (fallback).
 *
 * Architecture:
 * - Ring buffer collects samples from JSNES callbacks
 * - Audio processing node pulls from the ring buffer at the output rate
 * - Mute toggle just sets gain to 0 without stopping the pipeline
 */

const SAMPLE_RATE = 44100;
const BUFFER_SIZE = 8192;
const SCRIPT_BUFFER_SIZE = 2048; // ScriptProcessorNode buffer size

export class AudioEngine {
  /** @type {AudioContext | null} */
  #audioCtx = null;
  /** @type {GainNode | null} */
  #gainNode = null;
  /** @type {ScriptProcessorNode | null} */
  #scriptNode = null;
  /** @type {AudioWorkletNode | null} */
  #workletNode = null;

  // Ring buffer for left and right channels
  #bufferLeft = new Float32Array(BUFFER_SIZE);
  #bufferRight = new Float32Array(BUFFER_SIZE);
  #writePos = 0;
  #readPos = 0;
  #bufferedSamples = 0;

  #muted = false;
  #initialized = false;
  #volume = 1.0;
  #useWorklet = false;

  /**
   * Initialize the audio pipeline. Must be called from a user gesture
   * context to satisfy browser autoplay policy.
   * @returns {Promise<boolean>} true if audio started successfully
   */
  async init() {
    if (this.#initialized) return true;

    try {
      this.#audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: SAMPLE_RATE,
      });

      // Resume if suspended (autoplay policy)
      if (this.#audioCtx.state === 'suspended') {
        await this.#audioCtx.resume();
      }

      // Gain node for volume/mute control
      this.#gainNode = this.#audioCtx.createGain();
      this.#gainNode.gain.value = this.#volume;
      this.#gainNode.connect(this.#audioCtx.destination);

      // Try AudioWorklet first, fall back to ScriptProcessorNode
      const workletStarted = await this.#tryAudioWorklet();
      if (!workletStarted) {
        this.#setupScriptProcessor();
      }

      this.#initialized = true;
      return true;
    } catch (err) {
      console.warn('AudioEngine: Failed to initialize -', err.message);
      return false;
    }
  }

  /**
   * Called by JSNES onAudioSample callback. Writes one stereo sample pair
   * into the ring buffer.
   * @param {number} left  - Left channel sample (-1.0 to 1.0)
   * @param {number} right - Right channel sample (-1.0 to 1.0)
   */
  writeSample(left, right) {
    if (!this.#initialized) return;

    // Drop if buffer full (prevents runaway lag)
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

  /** Toggle mute state and return the new state */
  toggleMute() {
    this.setMuted(!this.#muted);
    return this.#muted;
  }

  /** @returns {boolean} */
  get isMuted() {
    return this.#muted;
  }

  /**
   * Set volume (0.0 - 1.0).
   * @param {number} vol
   */
  setVolume(vol) {
    this.#volume = Math.max(0, Math.min(1, vol));
    if (this.#gainNode && !this.#muted) {
      this.#gainNode.gain.value = this.#volume;
    }
  }

  /** @returns {number} */
  get volume() {
    return this.#volume;
  }

  /** @returns {boolean} */
  get isInitialized() {
    return this.#initialized;
  }

  /**
   * Attempt to resume audio context (call on user interaction).
   */
  async resume() {
    if (this.#audioCtx && this.#audioCtx.state === 'suspended') {
      await this.#audioCtx.resume();
    }
  }

  /** Stop and clean up audio resources */
  destroy() {
    if (this.#scriptNode) {
      this.#scriptNode.disconnect();
      this.#scriptNode = null;
    }
    if (this.#workletNode) {
      this.#workletNode.disconnect();
      this.#workletNode = null;
    }
    if (this.#gainNode) {
      this.#gainNode.disconnect();
      this.#gainNode = null;
    }
    if (this.#audioCtx) {
      this.#audioCtx.close().catch(() => {});
      this.#audioCtx = null;
    }
    this.#initialized = false;
    this.#writePos = 0;
    this.#readPos = 0;
    this.#bufferedSamples = 0;
  }

  // --- Private ---

  /**
   * Try to set up an AudioWorklet for low-latency, off-main-thread audio.
   * @returns {Promise<boolean>}
   */
  async #tryAudioWorklet() {
    if (!this.#audioCtx.audioWorklet) return false;

    try {
      // Create worklet processor inline via Blob URL to avoid extra file
      const processorCode = `
        class NESAudioProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this._buffer = { left: new Float32Array(${BUFFER_SIZE}), right: new Float32Array(${BUFFER_SIZE}) };
            this._writePos = 0;
            this._readPos = 0;
            this._buffered = 0;
            this.port.onmessage = (e) => {
              const { left, right } = e.data;
              for (let i = 0; i < left.length; i++) {
                if (this._buffered >= ${BUFFER_SIZE}) break;
                this._buffer.left[this._writePos] = left[i];
                this._buffer.right[this._writePos] = right[i];
                this._writePos = (this._writePos + 1) % ${BUFFER_SIZE};
                this._buffered++;
              }
            };
          }
          process(inputs, outputs) {
            const outL = outputs[0][0];
            const outR = outputs[0][1];
            if (!outL) return true;
            for (let i = 0; i < outL.length; i++) {
              if (this._buffered > 0) {
                outL[i] = this._buffer.left[this._readPos];
                if (outR) outR[i] = this._buffer.right[this._readPos];
                this._readPos = (this._readPos + 1) % ${BUFFER_SIZE};
                this._buffered--;
              } else {
                outL[i] = 0;
                if (outR) outR[i] = 0;
              }
            }
            return true;
          }
        }
        registerProcessor('nes-audio-processor', NESAudioProcessor);
      `;

      const blob = new Blob([processorCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);

      await this.#audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      this.#workletNode = new AudioWorkletNode(this.#audioCtx, 'nes-audio-processor', {
        outputChannelCount: [2],
      });
      this.#workletNode.connect(this.#gainNode);
      this.#useWorklet = true;

      // Override writeSample to post to the worklet in batches
      this.#startWorkletBatching();

      return true;
    } catch (err) {
      console.warn('AudioEngine: AudioWorklet unavailable, falling back -', err.message);
      return false;
    }
  }

  /**
   * For worklet mode, we batch samples and post them periodically
   * instead of one-at-a-time messaging.
   */
  #startWorkletBatching() {
    // Batch buffer: accumulate samples, send in chunks
    let batchLeft = [];
    let batchRight = [];
    const BATCH_THRESHOLD = 512;

    // Replace the public writeSample with a batching version
    const originalWrite = this.writeSample.bind(this);
    this.writeSample = (left, right) => {
      batchLeft.push(left);
      batchRight.push(right);
      if (batchLeft.length >= BATCH_THRESHOLD) {
        this.#workletNode.port.postMessage({
          left: new Float32Array(batchLeft),
          right: new Float32Array(batchRight),
        });
        batchLeft = [];
        batchRight = [];
      }
    };

    // Flush remaining samples each frame
    const flush = () => {
      if (batchLeft.length > 0 && this.#workletNode) {
        this.#workletNode.port.postMessage({
          left: new Float32Array(batchLeft),
          right: new Float32Array(batchRight),
        });
        batchLeft = [];
        batchRight = [];
      }
      if (this.#initialized) {
        requestAnimationFrame(flush);
      }
    };
    requestAnimationFrame(flush);
  }

  /**
   * Fallback: ScriptProcessorNode (deprecated but widely supported).
   */
  #setupScriptProcessor() {
    this.#scriptNode = this.#audioCtx.createScriptProcessor(
      SCRIPT_BUFFER_SIZE,
      0, // no input channels
      2  // stereo output
    );

    this.#scriptNode.onaudioprocess = (event) => {
      const outLeft = event.outputBuffer.getChannelData(0);
      const outRight = event.outputBuffer.getChannelData(1);

      for (let i = 0; i < outLeft.length; i++) {
        if (this.#bufferedSamples > 0) {
          outLeft[i] = this.#bufferLeft[this.#readPos];
          outRight[i] = this.#bufferRight[this.#readPos];
          this.#readPos = (this.#readPos + 1) % BUFFER_SIZE;
          this.#bufferedSamples--;
        } else {
          outLeft[i] = 0;
          outRight[i] = 0;
        }
      }
    };

    this.#scriptNode.connect(this.#gainNode);
  }
}
