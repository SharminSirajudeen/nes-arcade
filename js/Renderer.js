/**
 * Renderer - Converts JSNES frameBuffer to canvas pixels.
 *
 * JSNES onFrame provides a flat array of length 256*240 where each element
 * is a 32-bit RGBA value packed as 0xRRGGBBAA. We unpack into ImageData
 * and blit to a 256x240 canvas, then CSS-scale to fill the container.
 *
 * Performance strategy:
 * - Pre-allocate a single ImageData + Uint32Array view
 * - Write directly via Uint32Array (one write per pixel, no per-channel ops)
 * - Single putImageData call per frame
 */

const NES_WIDTH = 256;
const NES_HEIGHT = 240;

export class Renderer {
  /** @type {HTMLCanvasElement} */
  #canvas = null;
  /** @type {CanvasRenderingContext2D} */
  #ctx = null;
  /** @type {ImageData} */
  #imageData = null;
  /** @type {Uint32Array} */
  #buf32 = null;

  /**
   * @param {HTMLCanvasElement} canvas - The target canvas element
   */
  constructor(canvas) {
    if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error('Renderer requires a valid <canvas> element.');
    }
    this.#canvas = canvas;
    this.#canvas.width = NES_WIDTH;
    this.#canvas.height = NES_HEIGHT;

    // Disable image smoothing for crisp pixel art
    this.#ctx = this.#canvas.getContext('2d', { alpha: false });
    this.#ctx.imageSmoothingEnabled = false;

    // Pre-allocate the ImageData buffer
    this.#imageData = this.#ctx.createImageData(NES_WIDTH, NES_HEIGHT);

    // Create a Uint32Array view over the same ArrayBuffer for fast 32-bit writes
    this.#buf32 = new Uint32Array(this.#imageData.data.buffer);
  }

  /**
   * Render a JSNES frame buffer to the canvas.
   *
   * JSNES frameBuffer format: Array of length 256*240.
   * Each element is 0xRRGGBBAA (red in high byte, alpha in low byte).
   *
   * Canvas ImageData expects bytes in RGBA order in memory, but when
   * accessed as Uint32Array on little-endian (virtually all browsers),
   * the byte order is 0xAABBGGRR. So we need to repack.
   *
   * @param {number[]} frameBuffer - JSNES frame buffer array
   */
  renderFrame(frameBuffer) {
    const buf = this.#buf32;
    const len = buf.length; // 256 * 240 = 61440

    for (let i = 0; i < len; i++) {
      // JSNES gives us 0x00RRGGBB (alpha is always 0 in JSNES v2)
      const pixel = frameBuffer[i];

      // Extract channels
      const r = (pixel >> 16) & 0xFF;
      const g = (pixel >> 8) & 0xFF;
      const b = pixel & 0xFF;

      // Pack as 0xFFBBGGRR for little-endian Uint32Array (ABGR in memory = RGBA bytes)
      buf[i] = 0xFF000000 | (b << 16) | (g << 8) | r;
    }

    this.#ctx.putImageData(this.#imageData, 0, 0);
  }

  /** @returns {HTMLCanvasElement} */
  get canvas() {
    return this.#canvas;
  }

  /** @returns {{ width: number, height: number }} */
  get resolution() {
    return { width: NES_WIDTH, height: NES_HEIGHT };
  }

  /**
   * Fill the canvas with black (used when no ROM is loaded or on pause overlay).
   */
  clear() {
    this.#ctx.fillStyle = '#000';
    this.#ctx.fillRect(0, 0, NES_WIDTH, NES_HEIGHT);
  }

  /**
   * Draw a centered text message over the canvas (e.g., "PAUSED", "DROP ROM").
   * @param {string} text
   * @param {string} [color='#0f0']
   */
  drawOverlay(text, color = '#0f0') {
    this.#ctx.save();
    this.#ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    this.#ctx.fillRect(0, 0, NES_WIDTH, NES_HEIGHT);
    this.#ctx.font = '16px monospace';
    this.#ctx.fillStyle = color;
    this.#ctx.textAlign = 'center';
    this.#ctx.textBaseline = 'middle';
    this.#ctx.fillText(text, NES_WIDTH / 2, NES_HEIGHT / 2);
    this.#ctx.restore();
  }
}
