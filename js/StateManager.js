/**
 * StateManager - Save/load emulator states to localStorage and files.
 *
 * Features:
 * - Multiple named save slots in localStorage
 * - Export state as downloadable JSON file
 * - Import state from uploaded JSON file
 * - Auto-save on configurable interval
 * - Metadata: timestamp, ROM name, score snapshot
 */

const STORAGE_PREFIX = 'nes_galaga_state_';
const STORAGE_INDEX_KEY = 'nes_galaga_state_index';
const MAX_SLOTS = 10;

/**
 * @typedef {Object} SaveSlot
 * @property {string}  id        - Slot identifier
 * @property {string}  label     - User-visible label
 * @property {string}  romName   - Name of the ROM when saved
 * @property {number}  timestamp - Unix timestamp of save
 * @property {number}  score     - Score at time of save
 * @property {Object}  state     - The JSNES state object
 */

export class StateManager {
  /** @type {import('./EmulatorCore.js').EmulatorCore} */
  #emulator = null;
  /** @type {import('./MemoryHacker.js').MemoryHacker|null} */
  #hacker = null;
  #romName = '';
  #autoSaveTimer = null;

  /**
   * @param {import('./EmulatorCore.js').EmulatorCore} emulator
   * @param {import('./MemoryHacker.js').MemoryHacker} [hacker]
   */
  constructor(emulator, hacker) {
    this.#emulator = emulator;
    this.#hacker = hacker || null;
  }

  /** @param {string} name */
  setROMName(name) {
    this.#romName = name;
  }

  // --- Save to localStorage ---

  /**
   * Save the current emulator state to a named slot.
   * @param {string} slotId - Slot identifier (e.g., "slot_0")
   * @param {string} [label] - Human-readable label
   * @returns {boolean} true if saved successfully
   */
  saveToSlot(slotId, label) {
    const state = this.#emulator.saveState();
    if (!state) return false;

    const score = this.#hacker ? this.#hacker.readScore() : 0;

    /** @type {SaveSlot} */
    const slot = {
      id: slotId,
      label: label || `Save ${slotId}`,
      romName: this.#romName,
      timestamp: Date.now(),
      score,
      state,
    };

    try {
      const json = JSON.stringify(slot);
      localStorage.setItem(STORAGE_PREFIX + slotId, json);
      this.#updateIndex(slotId, {
        label: slot.label,
        romName: slot.romName,
        timestamp: slot.timestamp,
        score: slot.score,
      });
      return true;
    } catch (err) {
      console.error('StateManager: Failed to save -', err.message);
      // localStorage might be full
      if (err.name === 'QuotaExceededError') {
        console.warn('StateManager: localStorage full. Consider clearing old saves.');
      }
      return false;
    }
  }

  /**
   * Load a state from a named slot.
   * @param {string} slotId
   * @returns {boolean} true if loaded successfully
   */
  loadFromSlot(slotId) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + slotId);
      if (!raw) return false;

      const slot = JSON.parse(raw);
      return this.#emulator.loadState(slot.state);
    } catch (err) {
      console.error('StateManager: Failed to load -', err.message);
      return false;
    }
  }

  /**
   * Delete a save slot.
   * @param {string} slotId
   */
  deleteSlot(slotId) {
    localStorage.removeItem(STORAGE_PREFIX + slotId);
    this.#removeFromIndex(slotId);
  }

  /**
   * Get metadata for all save slots (without loading full state data).
   * @returns {Array<{id: string, label: string, romName: string, timestamp: number, score: number}>}
   */
  listSlots() {
    try {
      const raw = localStorage.getItem(STORAGE_INDEX_KEY);
      if (!raw) return [];
      const index = JSON.parse(raw);
      return Object.entries(index).map(([id, meta]) => ({ id, ...meta }));
    } catch {
      return [];
    }
  }

  // --- Quick save/load (slot "quick") ---

  /** Quick save to a special slot */
  quickSave() {
    return this.saveToSlot('quick', 'Quick Save');
  }

  /** Quick load from the special slot */
  quickLoad() {
    return this.loadFromSlot('quick');
  }

  // --- Export/Import as files ---

  /**
   * Export the current state as a downloadable JSON file.
   * @param {string} [filename]
   */
  exportToFile(filename) {
    const state = this.#emulator.saveState();
    if (!state) return;

    const score = this.#hacker ? this.#hacker.readScore() : 0;

    const data = {
      format: 'nes-galaga-savestate',
      version: 1,
      romName: this.#romName,
      timestamp: Date.now(),
      score,
      state,
    };

    const json = JSON.stringify(data);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `galaga_save_${Date.now()}.json`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Import a state from a JSON file.
   * @param {File} file
   * @returns {Promise<boolean>}
   */
  importFromFile(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data.state || data.format !== 'nes-galaga-savestate') {
            console.error('StateManager: Invalid save file format.');
            resolve(false);
            return;
          }
          const ok = this.#emulator.loadState(data.state);
          resolve(ok);
        } catch (err) {
          console.error('StateManager: Failed to parse save file -', err.message);
          resolve(false);
        }
      };
      reader.onerror = () => {
        console.error('StateManager: Failed to read file.');
        resolve(false);
      };
      reader.readAsText(file);
    });
  }

  // --- Auto-save ---

  /**
   * Start auto-saving at an interval.
   * @param {number} intervalMs - Milliseconds between saves (default 30s)
   */
  startAutoSave(intervalMs = 30000) {
    this.stopAutoSave();
    this.#autoSaveTimer = setInterval(() => {
      if (this.#emulator.isRunning) {
        this.saveToSlot('autosave', 'Auto Save');
      }
    }, intervalMs);
  }

  /** Stop auto-saving */
  stopAutoSave() {
    if (this.#autoSaveTimer !== null) {
      clearInterval(this.#autoSaveTimer);
      this.#autoSaveTimer = null;
    }
  }

  // --- Private ---

  /**
   * Update the slot index in localStorage (lightweight metadata only).
   * @param {string} slotId
   * @param {Object} meta
   */
  #updateIndex(slotId, meta) {
    try {
      const raw = localStorage.getItem(STORAGE_INDEX_KEY);
      const index = raw ? JSON.parse(raw) : {};
      index[slotId] = meta;
      localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(index));
    } catch {
      // Silently degrade if index update fails
    }
  }

  /**
   * Remove a slot from the index.
   * @param {string} slotId
   */
  #removeFromIndex(slotId) {
    try {
      const raw = localStorage.getItem(STORAGE_INDEX_KEY);
      if (!raw) return;
      const index = JSON.parse(raw);
      delete index[slotId];
      localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(index));
    } catch {
      // Silently degrade
    }
  }
}
