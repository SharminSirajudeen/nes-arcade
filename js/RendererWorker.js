/**
 * RendererWorker — Renders pre-converted Uint32Array pixels from the NES Worker.
 *
 * Unlike the original Renderer which converts JSNES pixel format,
 * this receives pixels already in canvas-ready ABGR format from the Worker.
 */

const NES_WIDTH = 256;
const NES_HEIGHT = 240;

export class RendererWorker {
  #canvas = null;
  #ctx = null;
  #imageData = null;

  constructor(canvas) {
    if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error('RendererWorker requires a valid <canvas> element.');
    }
    this.#canvas = canvas;
    this.#canvas.width = NES_WIDTH;
    this.#canvas.height = NES_HEIGHT;
    this.#ctx = this.#canvas.getContext('2d', { alpha: false });
    this.#ctx.imageSmoothingEnabled = false;
    this.#imageData = this.#ctx.createImageData(NES_WIDTH, NES_HEIGHT);
  }

  /**
   * Render pre-converted pixels from the Worker.
   * @param {Uint32Array} pixels - Already in 0xFFBBGGRR format (canvas-ready)
   */
  renderFrame(pixels) {
    // Copy Uint32Array into ImageData's buffer
    new Uint32Array(this.#imageData.data.buffer).set(pixels);
    this.#ctx.putImageData(this.#imageData, 0, 0);
  }

  clear() {
    this.#ctx.fillStyle = '#000';
    this.#ctx.fillRect(0, 0, NES_WIDTH, NES_HEIGHT);
  }

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
