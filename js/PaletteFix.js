/**
 * PaletteFix — Replaces JSNES's inaccurate color palette with the Nestopia palette.
 *
 * This is the exact same palette used by retrogames.cz (EmulatorJS + Nestopia core).
 * Extracted from the Nestopia emulator's default palette.
 */

// Nestopia default palette — 64 NES colors as 0xRRGGBB
// Mapped to standard NES PPU indices 0x00-0x3F
const NESTOPIA_PALETTE = [
  // Row 0 (0x00-0x0F): darkest
  0x636363, 0x00298c, 0x1010a5, 0x3a00a5, 0x5a007b, 0x6b0042, 0x6b0800, 0x522100,
  0x313100, 0x084a00, 0x005200, 0x005208, 0x00424a, 0x000000, 0x000000, 0x000000,
  // Row 1 (0x10-0x1F): medium
  0xadadad, 0x1963d6, 0x4242ff, 0x7329ff, 0x9c19ce, 0xb5217b, 0xb53121, 0x9c4a00,
  0x6b6b00, 0x3a8400, 0x109400, 0x008c31, 0x007b8c, 0x000000, 0x000000, 0x000000,
  // Row 2 (0x20-0x2F): bright
  0xffffff, 0x63adff, 0x9494ff, 0xc573ff, 0xef6bff, 0xff6bce, 0xff8473, 0xe69c21,
  0xbdbd00, 0x8cd600, 0x5ae631, 0x42de84, 0x4acede, 0x525252, 0x000000, 0x000000,
  // Row 3 (0x30-0x3F): lightest/pastel
  0xffffff, 0xbddeff, 0xd6d6ff, 0xe6c5ff, 0xf7c5ff, 0xffc5e6, 0xffcec5, 0xf7d6a5,
  0xe6e694, 0xceef94, 0xbdf7ad, 0xb5f7ce, 0xb5efef, 0xb5b5b5, 0x000000, 0x000000,
];

/**
 * Apply the Nestopia-accurate palette to the JSNES PPU.
 * @param {object} emulatorCore - The EmulatorCore instance
 */
export function applyAccuratePalette(emulatorCore) {
  const nes = emulatorCore.nes;
  if (!nes || !nes.ppu || !nes.ppu.palTable) return;

  const palTable = nes.ppu.palTable;

  // Overwrite curTable
  _writePalette(palTable.curTable);

  // Overwrite all 8 emphasis table variants
  if (palTable.emphTable) {
    for (let emph = 0; emph < 8; emph++) {
      if (palTable.emphTable[emph]) {
        _writeEmphasisPalette(palTable.emphTable[emph], emph);
      }
    }
  }

  // Re-apply every frame in case emphasis bits change curTable pointer
  emulatorCore.addPostFrameHook(() => {
    _writePalette(palTable.curTable);
  });
}

function _writePalette(table) {
  for (let i = 0; i < 64; i++) {
    table[i] = NESTOPIA_PALETTE[i];
  }
}

function _writeEmphasisPalette(table, emph) {
  // NES emphasis bits attenuate color channels
  const rAttn = (emph & 1) ? 0.75 : 1.0;
  const gAttn = (emph & 2) ? 0.75 : 1.0;
  const bAttn = (emph & 4) ? 0.75 : 1.0;

  for (let i = 0; i < 64; i++) {
    const base = NESTOPIA_PALETTE[i];
    let r = (base >> 16) & 0xFF;
    let g = (base >> 8) & 0xFF;
    let b = base & 0xFF;

    if (emph !== 0) {
      r = Math.round(r * gAttn * bAttn);
      g = Math.round(g * rAttn * bAttn);
      b = Math.round(b * rAttn * gAttn);
    }

    table[i] = (r << 16) | (g << 8) | b;
  }
}
