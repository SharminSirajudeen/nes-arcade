/**
 * MemoryHacker - Real-time NES memory modification engine.
 *
 * Manages a registry of named memory addresses with:
 * - Live value reading every frame (post-frame hook)
 * - "Freeze" mode: write a value every frame so the game can't change it
 * - "Set once" mode: write a value a single time
 * - Support for user-defined custom addresses
 * - Memory search/scan for discovering unknown addresses
 *
 * This is the brain of the control panel.
 */

/**
 * @typedef {Object} HackEntry
 * @property {string}  id          - Unique identifier
 * @property {string}  label       - Human-readable label
 * @property {number}  address     - CPU memory address (0x0000 - 0xFFFF)
 * @property {number}  currentValue - Last read value
 * @property {number|null} frozenValue - If non-null, this value is written every frame
 * @property {boolean} frozen      - Whether this entry is actively frozen
 * @property {string}  category    - Grouping category (e.g., "player", "bullets", "score")
 * @property {number}  min         - Min valid value for UI sliders
 * @property {number}  max         - Max valid value for UI sliders
 * @property {boolean} readOnly    - If true, display only, no writes
 * @property {boolean} custom      - Whether this was added by the user at runtime
 */

/** Known Galaga NES RAM addresses */
const GALAGA_ADDRESSES = [
  {
    id: 'player_x',
    label: 'Player X Position',
    address: 0x0203,
    category: 'player',
    min: 0,
    max: 255,
    readOnly: false,
  },
  {
    id: 'lives',
    label: 'Lives',
    address: 0x0487,
    category: 'player',
    min: 0,
    max: 99,
    readOnly: false,
  },
  {
    id: 'bullet1_flag',
    label: 'Bullet 1 Active',
    address: 0x02E0,
    category: 'bullets',
    min: 0,
    max: 1,
    readOnly: false,
  },
  {
    id: 'bullet1_y',
    label: 'Bullet 1 Y',
    address: 0x02E1,
    category: 'bullets',
    min: 0,
    max: 255,
    readOnly: false,
  },
  {
    id: 'bullet1_x',
    label: 'Bullet 1 X',
    address: 0x02E2,
    category: 'bullets',
    min: 0,
    max: 255,
    readOnly: false,
  },
  {
    id: 'bullet2_flag',
    label: 'Bullet 2 Active',
    address: 0x02E8,
    category: 'bullets',
    min: 0,
    max: 1,
    readOnly: false,
  },
  {
    id: 'bullet2_y',
    label: 'Bullet 2 Y',
    address: 0x02E9,
    category: 'bullets',
    min: 0,
    max: 255,
    readOnly: false,
  },
  {
    id: 'bullet2_x',
    label: 'Bullet 2 X',
    address: 0x02EA,
    category: 'bullets',
    min: 0,
    max: 255,
    readOnly: false,
  },
  // Score: 7 bytes at 0x00E0-0x00E6 (BCD, each byte is one digit)
  {
    id: 'score_digit_0',
    label: 'Score Digit 1 (highest)',
    address: 0x00E0,
    category: 'score',
    min: 0,
    max: 9,
    readOnly: false,
  },
  {
    id: 'score_digit_1',
    label: 'Score Digit 2',
    address: 0x00E1,
    category: 'score',
    min: 0,
    max: 9,
    readOnly: false,
  },
  {
    id: 'score_digit_2',
    label: 'Score Digit 3',
    address: 0x00E2,
    category: 'score',
    min: 0,
    max: 9,
    readOnly: false,
  },
  {
    id: 'score_digit_3',
    label: 'Score Digit 4',
    address: 0x00E3,
    category: 'score',
    min: 0,
    max: 9,
    readOnly: false,
  },
  {
    id: 'score_digit_4',
    label: 'Score Digit 5',
    address: 0x00E4,
    category: 'score',
    min: 0,
    max: 9,
    readOnly: false,
  },
  {
    id: 'score_digit_5',
    label: 'Score Digit 6',
    address: 0x00E5,
    category: 'score',
    min: 0,
    max: 9,
    readOnly: false,
  },
  {
    id: 'score_digit_6',
    label: 'Score Digit 7 (lowest)',
    address: 0x00E6,
    category: 'score',
    min: 0,
    max: 9,
    readOnly: false,
  },
];

export class MemoryHacker {
  /** @type {import('./EmulatorCore.js').EmulatorCore} */
  #emulator = null;

  /** @type {Map<string, HackEntry>} */
  #registry = new Map();

  /** @type {Function|null} Unsubscribe for pre-frame hook */
  #unsubPreFrame = null;
  /** @type {Function|null} Unsubscribe for post-frame hook */
  #unsubPostFrame = null;

  /** @type {Array<(entries: HackEntry[]) => void>} */
  #listeners = [];

  // Memory scanner state
  /** @type {Map<number, number>|null} Previous frame snapshot for scanning */
  #scanSnapshot = null;
  /** @type {Set<number>|null} Candidate addresses from ongoing scan */
  #scanCandidates = null;

  /**
   * @param {import('./EmulatorCore.js').EmulatorCore} emulator
   */
  constructor(emulator) {
    this.#emulator = emulator;
  }

  /** Initialize the registry with known Galaga addresses and hook into the frame loop */
  init() {
    // Register all known addresses
    for (const addr of GALAGA_ADDRESSES) {
      this.#registry.set(addr.id, {
        ...addr,
        currentValue: 0,
        frozenValue: null,
        frozen: false,
        custom: false,
      });
    }

    // Hook into the emulator frame loop
    this.#unsubPreFrame = this.#emulator.addPreFrameHook(() => this.#preFrame());
    this.#unsubPostFrame = this.#emulator.addPostFrameHook(() => this.#postFrame());
  }

  /** Clean up hooks */
  destroy() {
    if (this.#unsubPreFrame) this.#unsubPreFrame();
    if (this.#unsubPostFrame) this.#unsubPostFrame();
    this.#registry.clear();
    this.#listeners = [];
  }

  /**
   * Get all registered entries.
   * @returns {HackEntry[]}
   */
  getAll() {
    return Array.from(this.#registry.values());
  }

  /**
   * Get entries filtered by category.
   * @param {string} category
   * @returns {HackEntry[]}
   */
  getByCategory(category) {
    return this.getAll().filter((e) => e.category === category);
  }

  /**
   * Get a single entry by ID.
   * @param {string} id
   * @returns {HackEntry|undefined}
   */
  get(id) {
    return this.#registry.get(id);
  }

  /**
   * Get all unique categories.
   * @returns {string[]}
   */
  getCategories() {
    const cats = new Set();
    for (const entry of this.#registry.values()) {
      cats.add(entry.category);
    }
    return Array.from(cats);
  }

  /**
   * Write a value once to a registered address.
   * @param {string} id
   * @param {number} value
   */
  setOnce(id, value) {
    const entry = this.#registry.get(id);
    if (!entry || entry.readOnly) return;

    const clamped = Math.max(entry.min, Math.min(entry.max, value)) & 0xFF;
    this.#emulator.writeMemory(entry.address, clamped);
    entry.currentValue = clamped;
    this.#notifyListeners();
  }

  /**
   * Freeze an address: write this value every frame.
   * @param {string} id
   * @param {number} value
   */
  freeze(id, value) {
    const entry = this.#registry.get(id);
    if (!entry || entry.readOnly) return;

    entry.frozenValue = Math.max(entry.min, Math.min(entry.max, value)) & 0xFF;
    entry.frozen = true;
    this.#notifyListeners();
  }

  /**
   * Unfreeze an address (stop writing every frame).
   * @param {string} id
   */
  unfreeze(id) {
    const entry = this.#registry.get(id);
    if (!entry) return;

    entry.frozen = false;
    entry.frozenValue = null;
    this.#notifyListeners();
  }

  /**
   * Toggle freeze state for an address.
   * @param {string} id
   * @param {number} [value] - Value to freeze at; defaults to current value
   */
  toggleFreeze(id, value) {
    const entry = this.#registry.get(id);
    if (!entry) return;

    if (entry.frozen) {
      this.unfreeze(id);
    } else {
      this.freeze(id, value !== undefined ? value : entry.currentValue);
    }
  }

  /**
   * Add a custom address at runtime.
   * @param {Object} params
   * @param {string} params.label
   * @param {number} params.address
   * @param {string} [params.category='custom']
   * @param {number} [params.min=0]
   * @param {number} [params.max=255]
   * @returns {string} The generated ID
   */
  addCustomAddress({ label, address, category = 'custom', min = 0, max = 255 }) {
    const id = `custom_${address.toString(16).padStart(4, '0')}`;

    // Don't duplicate
    if (this.#registry.has(id)) return id;

    this.#registry.set(id, {
      id,
      label,
      address,
      category,
      min,
      max,
      currentValue: this.#emulator.readMemory(address),
      frozenValue: null,
      frozen: false,
      readOnly: false,
      custom: true,
    });

    this.#notifyListeners();
    return id;
  }

  /**
   * Remove a custom address.
   * @param {string} id
   */
  removeCustomAddress(id) {
    const entry = this.#registry.get(id);
    if (!entry || !entry.custom) return;
    this.#registry.delete(id);
    this.#notifyListeners();
  }

  /**
   * Read the composite score as a number from the 7 BCD digit bytes.
   * @returns {number}
   */
  readScore() {
    let score = 0;
    for (let i = 0; i < 7; i++) {
      const digit = this.#emulator.readMemory(0x00E0 + i) & 0x0F;
      score = score * 10 + digit;
    }
    return score;
  }

  /**
   * Set the score by writing individual BCD digit bytes.
   * @param {number} score - 0 to 9999999
   */
  writeScore(score) {
    const clamped = Math.max(0, Math.min(9999999, Math.floor(score)));
    const str = clamped.toString().padStart(7, '0');
    for (let i = 0; i < 7; i++) {
      this.#emulator.writeMemory(0x00E0 + i, parseInt(str[i], 10));
    }
  }

  /**
   * Direct memory read for arbitrary address (not in registry).
   * @param {number} address
   * @returns {number}
   */
  peek(address) {
    return this.#emulator.readMemory(address);
  }

  /**
   * Direct memory write for arbitrary address (not in registry).
   * @param {number} address
   * @param {number} value
   */
  poke(address, value) {
    this.#emulator.writeMemory(address, value & 0xFF);
  }

  // --- Memory Scanner ---

  /**
   * Start a new scan: snapshot all of zero-page + work RAM (0x0000-0x07FF).
   * Call this, then change something in-game, then call scanChanged/scanEqual/scanForValue.
   */
  scanStart() {
    this.#scanSnapshot = new Map();
    this.#scanCandidates = null;
    // NES internal RAM is 0x0000-0x07FF (2KB, mirrored)
    for (let addr = 0; addr < 0x0800; addr++) {
      this.#scanSnapshot.set(addr, this.#emulator.readMemory(addr));
    }
    return 0x0800; // Number of candidates
  }

  /**
   * Narrow scan: keep only addresses whose value changed since last snapshot.
   * @returns {number} Remaining candidate count
   */
  scanChanged() {
    return this.#scanFilter((addr) => {
      const prev = this.#scanSnapshot.get(addr);
      const curr = this.#emulator.readMemory(addr);
      this.#scanSnapshot.set(addr, curr); // Update snapshot
      return curr !== prev;
    });
  }

  /**
   * Narrow scan: keep only addresses whose value stayed the same.
   * @returns {number} Remaining candidate count
   */
  scanUnchanged() {
    return this.#scanFilter((addr) => {
      const prev = this.#scanSnapshot.get(addr);
      const curr = this.#emulator.readMemory(addr);
      return curr === prev;
    });
  }

  /**
   * Narrow scan: keep only addresses currently holding a specific value.
   * @param {number} value
   * @returns {number} Remaining candidate count
   */
  scanForValue(value) {
    return this.#scanFilter((addr) => {
      const curr = this.#emulator.readMemory(addr);
      this.#scanSnapshot.set(addr, curr);
      return curr === (value & 0xFF);
    });
  }

  /**
   * Narrow scan: keep only addresses whose value increased.
   * @returns {number} Remaining candidate count
   */
  scanIncreased() {
    return this.#scanFilter((addr) => {
      const prev = this.#scanSnapshot.get(addr);
      const curr = this.#emulator.readMemory(addr);
      this.#scanSnapshot.set(addr, curr);
      return curr > prev;
    });
  }

  /**
   * Narrow scan: keep only addresses whose value decreased.
   * @returns {number} Remaining candidate count
   */
  scanDecreased() {
    return this.#scanFilter((addr) => {
      const prev = this.#scanSnapshot.get(addr);
      const curr = this.#emulator.readMemory(addr);
      this.#scanSnapshot.set(addr, curr);
      return curr < prev;
    });
  }

  /**
   * Get current scan results (address -> current value).
   * @param {number} [limit=50]
   * @returns {Array<{address: number, value: number}>}
   */
  scanResults(limit = 50) {
    const candidates = this.#scanCandidates || this.#scanSnapshot;
    if (!candidates) return [];

    const results = [];
    for (const [addr] of candidates) {
      if (results.length >= limit) break;
      results.push({
        address: addr,
        value: this.#emulator.readMemory(addr),
      });
    }
    return results;
  }

  /** Reset the scanner */
  scanReset() {
    this.#scanSnapshot = null;
    this.#scanCandidates = null;
  }

  // --- Change listeners ---

  /**
   * Register a listener that fires after each frame with updated entries.
   * @param {(entries: HackEntry[]) => void} fn
   * @returns {Function} Unsubscribe
   */
  onChange(fn) {
    this.#listeners.push(fn);
    return () => {
      const idx = this.#listeners.indexOf(fn);
      if (idx !== -1) this.#listeners.splice(idx, 1);
    };
  }

  // --- Private ---

  /** Pre-frame: apply frozen values BEFORE the CPU runs this frame */
  #preFrame() {
    for (const entry of this.#registry.values()) {
      if (entry.frozen && entry.frozenValue !== null && !entry.readOnly) {
        this.#emulator.writeMemory(entry.address, entry.frozenValue);
      }
    }
  }

  /** Post-frame: read current values AFTER the CPU ran this frame */
  #postFrame() {
    let changed = false;
    for (const entry of this.#registry.values()) {
      const val = this.#emulator.readMemory(entry.address);
      if (val !== entry.currentValue) {
        entry.currentValue = val;
        changed = true;
      }
    }
    if (changed) {
      this.#notifyListeners();
    }
  }

  #notifyListeners() {
    const entries = this.getAll();
    for (let i = 0; i < this.#listeners.length; i++) {
      this.#listeners[i](entries);
    }
  }

  /**
   * Internal scan filter helper.
   * @param {(addr: number) => boolean} predicate
   * @returns {number}
   */
  #scanFilter(predicate) {
    const source = this.#scanCandidates || this.#scanSnapshot;
    if (!source) return 0;

    const next = new Map();
    for (const [addr, val] of source) {
      if (predicate(addr)) {
        next.set(addr, this.#emulator.readMemory(addr));
      }
    }
    this.#scanCandidates = next;
    return next.size;
  }
}
