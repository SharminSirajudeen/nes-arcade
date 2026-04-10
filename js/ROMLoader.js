/**
 * ROMLoader - Handles ROM file loading via drag-and-drop and file picker.
 *
 * Validates NES ROM files by checking for the "NES\x1a" magic header bytes
 * (iNES format), then converts the data into the binary string format
 * that JSNES expects.
 *
 * Supports: drag-and-drop onto a target element, file <input> picker,
 * and programmatic loading from ArrayBuffer/Uint8Array.
 */

const NES_MAGIC = [0x4E, 0x45, 0x53, 0x1A]; // "NES" + MS-DOS EOF
const INES_HEADER_SIZE = 16;

/**
 * @typedef {Object} ROMInfo
 * @property {string}  name         - Original filename
 * @property {number}  size         - File size in bytes
 * @property {number}  prgBanks     - Number of 16KB PRG-ROM banks
 * @property {number}  chrBanks     - Number of 8KB CHR-ROM banks
 * @property {number}  mapper       - Mapper number
 * @property {boolean} mirroring    - true = vertical, false = horizontal
 * @property {boolean} battery      - Has battery-backed RAM
 * @property {string}  romData      - Binary string for JSNES
 */

export class ROMLoader {
  /** @type {HTMLElement|null} */
  #dropTarget = null;
  /** @type {HTMLInputElement|null} */
  #fileInput = null;
  /** @type {((info: ROMInfo) => void)|null} */
  #onROMLoaded = null;
  /** @type {((error: string) => void)|null} */
  #onError = null;

  // Bound handlers for cleanup
  #boundDragOver = null;
  #boundDragLeave = null;
  #boundDrop = null;
  #boundInputChange = null;

  /**
   * Initialize the ROM loader.
   * @param {Object} params
   * @param {HTMLElement}   params.dropTarget  - Element to accept drag-and-drop
   * @param {HTMLInputElement} [params.fileInput] - Optional file input element
   * @param {(info: ROMInfo) => void} params.onROMLoaded - Callback with parsed ROM data
   * @param {(error: string) => void} [params.onError]   - Error callback
   */
  init({ dropTarget, fileInput, onROMLoaded, onError }) {
    this.#dropTarget = dropTarget;
    this.#fileInput = fileInput || null;
    this.#onROMLoaded = onROMLoaded;
    this.#onError = onError || ((msg) => console.error('ROMLoader:', msg));

    this.#bindDragDrop();
    if (this.#fileInput) {
      this.#bindFileInput();
    }
  }

  /** Clean up event listeners */
  destroy() {
    if (this.#dropTarget) {
      this.#dropTarget.removeEventListener('dragover', this.#boundDragOver);
      this.#dropTarget.removeEventListener('dragleave', this.#boundDragLeave);
      this.#dropTarget.removeEventListener('drop', this.#boundDrop);
    }
    if (this.#fileInput) {
      this.#fileInput.removeEventListener('change', this.#boundInputChange);
    }
  }

  /**
   * Programmatically load a ROM from an ArrayBuffer or Uint8Array.
   * @param {ArrayBuffer|Uint8Array} data
   * @param {string} [filename='rom.nes']
   */
  loadFromBuffer(data, filename = 'rom.nes') {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.#processROM(bytes, filename);
  }

  /**
   * Programmatically load a ROM from a URL (fetch).
   * @param {string} url
   */
  async loadFromURL(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        this.#onError(`Failed to fetch ROM: HTTP ${response.status}`);
        return;
      }
      const buffer = await response.arrayBuffer();
      const filename = url.split('/').pop() || 'rom.nes';
      this.loadFromBuffer(buffer, filename);
    } catch (err) {
      this.#onError(`Failed to fetch ROM: ${err.message}`);
    }
  }

  // --- Static utilities ---

  /**
   * Validate iNES header bytes.
   * @param {Uint8Array} bytes
   * @returns {boolean}
   */
  static isValidNES(bytes) {
    if (bytes.length < INES_HEADER_SIZE) return false;
    for (let i = 0; i < NES_MAGIC.length; i++) {
      if (bytes[i] !== NES_MAGIC[i]) return false;
    }
    return true;
  }

  /**
   * Parse iNES header and extract ROM metadata.
   * @param {Uint8Array} bytes
   * @returns {Object} Parsed header info
   */
  static parseHeader(bytes) {
    const prgBanks = bytes[4];     // Number of 16KB PRG-ROM banks
    const chrBanks = bytes[5];     // Number of 8KB CHR-ROM banks
    const flags6 = bytes[6];
    const flags7 = bytes[7];

    const mapperLo = (flags6 >> 4) & 0x0F;
    const mapperHi = (flags7 >> 4) & 0x0F;
    const mapper = (mapperHi << 4) | mapperLo;

    return {
      prgBanks,
      chrBanks,
      mapper,
      mirroring: !!(flags6 & 0x01),    // 0 = horizontal, 1 = vertical
      battery: !!(flags6 & 0x02),       // Battery-backed PRG RAM
      trainer: !!(flags6 & 0x04),       // 512-byte trainer present
      fourScreen: !!(flags6 & 0x08),    // Four-screen VRAM
    };
  }

  /**
   * Convert Uint8Array to binary string (format JSNES expects).
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  static bytesToBinaryString(bytes) {
    // Build in chunks to avoid stack overflow from String.fromCharCode.apply
    const CHUNK_SIZE = 8192;
    const parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const end = Math.min(i + CHUNK_SIZE, bytes.length);
      const chunk = bytes.subarray(i, end);
      parts.push(String.fromCharCode.apply(null, chunk));
    }
    return parts.join('');
  }

  // --- Private ---

  #bindDragDrop() {
    this.#boundDragOver = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#dropTarget.classList.add('drag-over');
    };

    this.#boundDragLeave = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#dropTarget.classList.remove('drag-over');
    };

    this.#boundDrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#dropTarget.classList.remove('drag-over');

      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) {
        this.#onError('No file dropped.');
        return;
      }
      this.#readFile(files[0]);
    };

    this.#dropTarget.addEventListener('dragover', this.#boundDragOver);
    this.#dropTarget.addEventListener('dragleave', this.#boundDragLeave);
    this.#dropTarget.addEventListener('drop', this.#boundDrop);
  }

  #bindFileInput() {
    this.#boundInputChange = (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      this.#readFile(files[0]);
      // Reset so the same file can be re-selected
      e.target.value = '';
    };
    this.#fileInput.addEventListener('change', this.#boundInputChange);
  }

  /**
   * Read a File object via FileReader.
   * @param {File} file
   */
  #readFile(file) {
    if (!file.name.toLowerCase().endsWith('.nes')) {
      this.#onError(`Invalid file type: "${file.name}". Expected a .nes file.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      this.#processROM(bytes, file.name);
    };
    reader.onerror = () => {
      this.#onError(`Failed to read file: ${reader.error.message}`);
    };
    reader.readAsArrayBuffer(file);
  }

  /**
   * Validate and convert ROM bytes, then call the onROMLoaded callback.
   * @param {Uint8Array} bytes
   * @param {string} filename
   */
  #processROM(bytes, filename) {
    // Validate magic bytes
    if (!ROMLoader.isValidNES(bytes)) {
      this.#onError(
        `Invalid NES ROM: "${filename}" does not have valid iNES header (expected "NES\\x1a" magic bytes).`
      );
      return;
    }

    // Parse header
    const header = ROMLoader.parseHeader(bytes);

    // Convert to binary string
    const romData = ROMLoader.bytesToBinaryString(bytes);

    /** @type {ROMInfo} */
    const info = {
      name: filename,
      size: bytes.length,
      prgBanks: header.prgBanks,
      chrBanks: header.chrBanks,
      mapper: header.mapper,
      mirroring: header.mirroring,
      battery: header.battery,
      romData,
    };

    this.#onROMLoaded(info);
  }
}
