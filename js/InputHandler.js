/**
 * InputHandler - Keyboard and Gamepad input mapping for JSNES.
 *
 * Default keyboard mapping:
 *   Arrows  -> D-pad
 *   Z       -> A (fire)
 *   X       -> B
 *   Enter   -> Start
 *   Shift   -> Select
 *
 * Gamepad API:
 *   Standard gamepad mapping (Xbox/PS layout):
 *   D-pad or left stick -> D-pad
 *   A/Cross (0)         -> A
 *   B/Circle (1)        -> B
 *   Start (9)           -> Start
 *   Back/Select (8)     -> Select
 */

// JSNES controller button constants
const BUTTONS = {
  A:      0,
  B:      1,
  SELECT: 2,
  START:  3,
  UP:     4,
  DOWN:   5,
  LEFT:   6,
  RIGHT:  7,
};

/** Default keyboard -> NES button mapping */
const DEFAULT_KEY_MAP = {
  'ArrowUp':    BUTTONS.UP,
  'ArrowDown':  BUTTONS.DOWN,
  'ArrowLeft':  BUTTONS.LEFT,
  'ArrowRight': BUTTONS.RIGHT,
  'KeyZ':       BUTTONS.A,
  'KeyX':       BUTTONS.B,
  'Enter':      BUTTONS.START,
  'ShiftRight': BUTTONS.SELECT,
  'ShiftLeft':  BUTTONS.SELECT,
};

/** Standard gamepad button indices -> NES buttons */
const GAMEPAD_MAP = {
  0:  BUTTONS.A,      // A / Cross
  1:  BUTTONS.B,      // B / Circle
  8:  BUTTONS.SELECT,  // Back / Select
  9:  BUTTONS.START,   // Start
  12: BUTTONS.UP,      // D-pad up
  13: BUTTONS.DOWN,    // D-pad down
  14: BUTTONS.LEFT,    // D-pad left
  15: BUTTONS.RIGHT,   // D-pad right
};

const STICK_THRESHOLD = 0.5;

export class InputHandler {
  /** @type {import('./EmulatorCore.js').EmulatorCore | null} */
  #emulator = null;
  #player = 1;
  #keyMap = { ...DEFAULT_KEY_MAP };
  #pressedKeys = new Set();

  // Gamepad state
  #gamepadIndex = null;
  #gamepadPollId = null;
  #gamepadPrevButtons = new Set();

  // Lifecycle
  #boundKeyDown = null;
  #boundKeyUp = null;
  #boundGamepadConnected = null;
  #boundGamepadDisconnected = null;
  #active = false;

  /**
   * @param {import('./EmulatorCore.js').EmulatorCore} emulator
   * @param {number} [player=1]
   */
  constructor(emulator, player = 1) {
    this.#emulator = emulator;
    this.#player = player;
  }

  /** Start listening for input events */
  bind() {
    if (this.#active) return;
    this.#active = true;

    this.#boundKeyDown = (e) => this.#onKeyDown(e);
    this.#boundKeyUp = (e) => this.#onKeyUp(e);
    this.#boundGamepadConnected = (e) => this.#onGamepadConnected(e);
    this.#boundGamepadDisconnected = (e) => this.#onGamepadDisconnected(e);

    document.addEventListener('keydown', this.#boundKeyDown);
    document.addEventListener('keyup', this.#boundKeyUp);
    window.addEventListener('gamepadconnected', this.#boundGamepadConnected);
    window.addEventListener('gamepaddisconnected', this.#boundGamepadDisconnected);

    // Check if a gamepad is already connected
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i]) {
        this.#gamepadIndex = i;
        this.#startGamepadPolling();
        break;
      }
    }
  }

  /** Stop listening for input events */
  unbind() {
    if (!this.#active) return;
    this.#active = false;

    document.removeEventListener('keydown', this.#boundKeyDown);
    document.removeEventListener('keyup', this.#boundKeyUp);
    window.removeEventListener('gamepadconnected', this.#boundGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this.#boundGamepadDisconnected);

    this.#stopGamepadPolling();
    this.#pressedKeys.clear();
  }

  /**
   * Override default key mapping.
   * @param {Object<string, number>} map - { KeyCode: BUTTONS.* }
   */
  setKeyMap(map) {
    this.#keyMap = { ...map };
  }

  /** @returns {Object<string, number>} Current key mapping */
  get keyMap() {
    return { ...this.#keyMap };
  }

  /** @returns {{ A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 }} */
  static get BUTTONS() {
    return { ...BUTTONS };
  }

  /** @returns {boolean} Whether a gamepad is connected */
  get gamepadConnected() {
    return this.#gamepadIndex !== null;
  }

  // --- Private: Keyboard ---

  /** @param {KeyboardEvent} e */
  #onKeyDown(e) {
    const button = this.#keyMap[e.code];
    if (button === undefined) return;

    e.preventDefault();

    // Avoid repeat events from key held down
    if (this.#pressedKeys.has(e.code)) return;
    this.#pressedKeys.add(e.code);

    this.#emulator.buttonDown(this.#player, button);
  }

  /** @param {KeyboardEvent} e */
  #onKeyUp(e) {
    const button = this.#keyMap[e.code];
    if (button === undefined) return;

    e.preventDefault();
    this.#pressedKeys.delete(e.code);
    this.#emulator.buttonUp(this.#player, button);
  }

  // --- Private: Gamepad ---

  /** @param {GamepadEvent} e */
  #onGamepadConnected(e) {
    this.#gamepadIndex = e.gamepad.index;
    console.log(`Gamepad connected: ${e.gamepad.id}`);
    this.#startGamepadPolling();
  }

  /** @param {GamepadEvent} e */
  #onGamepadDisconnected(e) {
    if (e.gamepad.index === this.#gamepadIndex) {
      console.log('Gamepad disconnected');
      this.#gamepadIndex = null;
      this.#stopGamepadPolling();
      this.#gamepadPrevButtons.clear();
    }
  }

  #startGamepadPolling() {
    if (this.#gamepadPollId !== null) return;

    const poll = () => {
      if (this.#gamepadIndex === null) return;

      const gamepads = navigator.getGamepads();
      const gp = gamepads[this.#gamepadIndex];
      if (!gp) return;

      const currentButtons = new Set();

      // Digital buttons
      for (const [gpIdx, nesBtn] of Object.entries(GAMEPAD_MAP)) {
        const idx = Number(gpIdx);
        if (gp.buttons[idx] && gp.buttons[idx].pressed) {
          currentButtons.add(nesBtn);
        }
      }

      // Left analog stick -> D-pad
      if (gp.axes.length >= 2) {
        const x = gp.axes[0];
        const y = gp.axes[1];
        if (x < -STICK_THRESHOLD) currentButtons.add(BUTTONS.LEFT);
        if (x > STICK_THRESHOLD) currentButtons.add(BUTTONS.RIGHT);
        if (y < -STICK_THRESHOLD) currentButtons.add(BUTTONS.UP);
        if (y > STICK_THRESHOLD) currentButtons.add(BUTTONS.DOWN);
      }

      // Diff with previous frame to send press/release events
      for (const btn of currentButtons) {
        if (!this.#gamepadPrevButtons.has(btn)) {
          this.#emulator.buttonDown(this.#player, btn);
        }
      }
      for (const btn of this.#gamepadPrevButtons) {
        if (!currentButtons.has(btn)) {
          this.#emulator.buttonUp(this.#player, btn);
        }
      }

      this.#gamepadPrevButtons = currentButtons;
      this.#gamepadPollId = requestAnimationFrame(poll);
    };

    this.#gamepadPollId = requestAnimationFrame(poll);
  }

  #stopGamepadPolling() {
    if (this.#gamepadPollId !== null) {
      cancelAnimationFrame(this.#gamepadPollId);
      this.#gamepadPollId = null;
    }
  }
}
