# Web Worker Architecture Migration — Runbook

## Goal
Move NES emulation + audio generation to a Web Worker so audio plays at correct speed on slow devices. Main thread only handles rendering, input, and UI.

## Why
Single-threaded architecture starves audio on slow phones. The NES APU generates 44,100 audio samples/sec tied to CPU emulation. When rendering blocks the main thread, fewer frames run, fewer samples generated, audio slows down like a "dying toy."

## Architecture

```
MAIN THREAD                           WORKER THREAD
───────────                           ─────────────
main.js (orchestrator)                nes-worker.js
  WorkerBridge.js (proxy)         ←→    EmulatorCore (JSNES)
  Renderer.js (canvas)            ←     MemoryHacker (RAM hacks)
  InputHandler.js (keyboard/touch) →    PaletteFix (palette)
  ROMLoader.js (drag-drop)        →    ModEngine (speed/fire/lives)
  StateManagerUI (localStorage)   ←→   
  AudioEngine.js (Web Audio)      ←    Audio via SharedArrayBuffer

    ←── frame pixels (Transferable Uint32Array, 245KB, 60/sec)
    ←── audio samples (SharedArrayBuffer ring buffer, continuous)
    ──→ input buttons (postMessage, ~20 bytes, sporadic)
    ──→ mod commands (postMessage, ~30 bytes, rare)
    ←→  save states (postMessage, ~500KB, rare)
```

## Prerequisites
- COOP/COEP headers on Vercel for SharedArrayBuffer
- ringbuf.js (Mozilla's wait-free ring buffer, ~3KB)
- jsnes.min.js vendored locally (for Worker importScripts)

## Step-by-Step Plan

### Step 1: Vendor dependencies locally
**What:** Download jsnes.min.js and ringbuf.js to serve locally instead of from CDN
**Why:** Worker needs importScripts (can't use <script> tags). SharedArrayBuffer ring buffer needs ringbuf.js. Local files work offline (PWA).
**Files to create:**
- `/js/vendor/jsnes.min.js` (from unpkg)
- `/js/vendor/ringbuf.js` (from github.com/padenot/ringbuf.js)
**Files to modify:**
- `index.html` — change script src from unpkg to local
- `service-worker.js` — add vendor files to cache list
**Test:** Page loads and game works identically with local jsnes

### Step 2: Add COOP/COEP headers
**What:** Add Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers
**Why:** Required for SharedArrayBuffer (audio ring buffer)
**Files to modify:**
- `vercel.json` — add headers for all routes
- `index.html` — add `crossorigin="anonymous"` to any remaining cross-origin resources
**Test:** `console.log(crossOriginIsolated)` returns `true` in browser. Google Fonts still load.

### Step 3: Create the Worker (nes-worker.js)
**What:** New file that runs JSNES in a dedicated thread
**Contains:**
- `importScripts('./vendor/jsnes.min.js')`
- JSNES NES instance with onFrame and onAudioSample callbacks
- Frame loop via `setInterval(tick, 1000/60)` (NOT requestAnimationFrame)
- Message handler for: load-rom, button-down/up, start, pause, resume, reset, set-mod, freeze, save-state, load-state, apply-palette, dual-shot-fire, scan-start/changed/etc.
- onFrame: convert frameBuffer to Uint32Array, postMessage as Transferable
- onAudioSample: write interleaved samples to SharedArrayBuffer ring buffer
- Mod logic (speed multiplier, firepower, lives freeze, dual fighter) runs in post-frame hook INSIDE the Worker
- PaletteFix runs inside the Worker after loadROM and loadState
- MemoryHacker runs inside the Worker with pre/post frame hooks
**Data out:**
- Frame pixels: `postMessage({type:'frame', pixels}, [pixels.buffer])` — Transferable
- Audio: written directly to SharedArrayBuffer (no postMessage needed)
- Hack updates: `postMessage({type:'hack-update', entries})` — throttled to 15fps
- Save state data: `postMessage({type:'state-saved', state, score})`
- FPS: piggybacked on frame message
**Data in:**
- All via `onmessage` handler
**Test:** Worker loads, accepts a ROM, runs frames, posts pixel data

### Step 4: Create WorkerBridge.js
**What:** Main-thread proxy that presents same API as EmulatorCore but forwards to Worker
**Interface:**
```js
class WorkerBridge {
  constructor(worker) // stores worker reference
  loadROM(romData)    // postMessage({type:'load-rom', romData})
  start()             // postMessage({type:'start'})
  pause()             // postMessage({type:'pause'})
  resume()            // postMessage({type:'resume'})
  reset()             // postMessage({type:'reset'})
  buttonDown(p, b)    // postMessage({type:'button-down', player:p, button:b})
  buttonUp(p, b)      // postMessage({type:'button-up', player:p, button:b})
  setMod(mod, value)  // postMessage({type:'set-mod', mod, value})
  saveState()         // postMessage({type:'save-state'}), returns Promise
  loadState(state)    // postMessage({type:'load-state', state})
  onFrame(callback)   // registers callback for incoming frame data
  onHackUpdate(cb)    // registers callback for memory hack value updates
}
```
**Why:** InputHandler, main.js, and touch controls can use this instead of EmulatorCore with minimal changes. Same method names, just async under the hood.
**Test:** WorkerBridge.buttonDown sends message, Worker receives it

### Step 5: Rewrite AudioEngine for SharedArrayBuffer
**What:** AudioEngine no longer receives writeSample() calls. Instead, it reads from SharedArrayBuffer ring buffer that the Worker writes to.
**Architecture:**
```
Worker writes → SharedArrayBuffer ring buffer ← ScriptProcessorNode reads
```
**Setup flow:**
1. Main thread creates SharedArrayBuffer via `RingBuffer.getStorageForCapacity()`
2. Main thread sends SAB to Worker via postMessage (SAB is transferable)
3. Worker stores SAB, creates RingBuffer writer
4. Worker's onAudioSample pushes interleaved L/R samples to ring buffer
5. Main thread's ScriptProcessorNode onaudioprocess reads from ring buffer
**Fallback:** If `crossOriginIsolated === false`, Worker batches ~735 samples per frame into Float32Array, posts as Transferable. ScriptProcessorNode reads from a local ring buffer filled by message handler.
**Key detail:** Batch audio writes in Worker — don't call ringbuf.push() per sample (44,100/sec). Collect samples during nes.frame() (~735), push once after frame completes.
**Test:** Audio plays correctly on slow device. No dying toy effect.

### Step 6: Update Renderer.js
**What:** Renderer receives Uint32Array from Worker postMessage instead of directly from JSNES callback
**Changes:**
- Remove the pixel format conversion (Worker does it now)
- Accept pre-converted Uint32Array and blit directly
- Method: `renderFrame(pixels)` where pixels is a Uint32Array already in ABGR format
**Performance:** Pre-allocate ImageData once. Use `imageData.data.set(new Uint8Array(pixels.buffer))` for fast blit.
**Test:** Video renders correctly, same visual output as before

### Step 7: Update main.js orchestration
**What:** main.js becomes the coordinator. No longer owns EmulatorCore directly.
**Changes:**
- Replace `new EmulatorCore()` with `new Worker('js/nes-worker.js')` + `new WorkerBridge(worker)`
- Replace `new AudioEngine()` with SharedArrayBuffer-based AudioEngine
- InputHandler gets WorkerBridge instead of EmulatorCore
- Touch controls send messages via WorkerBridge
- Mod slider handlers call `bridge.setMod(mod, value)` instead of setting local mods object
- Save/load: bridge.saveState() returns Promise, main.js stores in localStorage
- initSpeedHack() REMOVED from main.js — mod logic moves to Worker
- Remove `window._emu` (EmulatorCore no longer on main thread)
- Add `window._bridge` for debugging
**ROM loading flow:**
1. ROMLoader reads file, converts to binary string (unchanged)
2. main.js calls `bridge.loadROM(romData)` instead of `emulator.loadROM(romData)`
3. Worker receives ROM, loads into JSNES, applies palette, starts frame loop
**Test:** Full game works — load ROM, play, mods work, save/load works

### Step 8: Update service-worker.js
**What:** Add new files to cache list
**Add:**
- `/js/nes-worker.js`
- `/js/WorkerBridge.js`
- `/js/vendor/jsnes.min.js`
- `/js/vendor/ringbuf.js`
**Bump:** CACHE_NAME version
**Test:** PWA works offline

### Step 9: Fallback for non-crossOriginIsolated environments
**What:** If SharedArrayBuffer unavailable, fall back to single-thread architecture
**Detection:**
```js
if (typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated) {
  // Worker + SharedArrayBuffer path
} else {
  // Original single-thread path (current code)
}
```
**Why:** Some browsers/contexts don't support COOP/COEP. The app should still work, just with the old audio behavior on slow devices.
**Implementation:** Keep current EmulatorCore.js as fallback. main.js checks at startup and chooses path.
**Test:** Disable COOP headers, verify app falls back to single-thread and still works

### Step 10: Deploy and test
**Deploy to Vercel with:**
- COOP/COEP headers in vercel.json
- All new files
- ROM (password protected)
- PWA manifest + service worker
**Test on:**
- Fast device (Mac/desktop): should work identically
- iPhone Safari: iOS fullscreen, PWA, touch controls
- Slow Android phone: AUDIO MUST PLAY AT CORRECT SPEED (the whole point)
- Background tab: audio should continue (Worker setInterval not throttled)

## Files Summary

| File | Action | Thread |
|------|--------|--------|
| `js/nes-worker.js` | CREATE | Worker |
| `js/WorkerBridge.js` | CREATE | Main |
| `js/vendor/jsnes.min.js` | CREATE (download) | Worker |
| `js/vendor/ringbuf.js` | CREATE (download) | Both |
| `js/EmulatorCore.js` | KEEP as fallback | Main (fallback only) |
| `js/AudioEngine.js` | REWRITE | Main |
| `js/Renderer.js` | MINOR UPDATE | Main |
| `js/main.js` | MAJOR UPDATE | Main |
| `js/MemoryHacker.js` | MOVE logic to Worker | Worker |
| `js/PaletteFix.js` | MOVE to Worker | Worker |
| `js/InputHandler.js` | UPDATE (use bridge) | Main |
| `js/ROMLoader.js` | NO CHANGE | Main |
| `js/StateManager.js` | SPLIT (serialize in Worker, store in Main) | Both |
| `service-worker.js` | UPDATE cache list | Main |
| `vercel.json` | ADD COOP/COEP headers | Server |
| `index.html` | UPDATE script refs | Main |
| `middleware.js` | NO CHANGE | Server |
| `manifest.json` | NO CHANGE | Main |
| `styles.css` | NO CHANGE | Main |

## Risk Mitigation
- **Don't break what works:** Keep current single-thread code as fallback
- **Test each step:** Every step has a test criteria before moving to next
- **Incremental:** Each step produces a working (if incomplete) app
- **Rollback:** Git commit after each step. Can revert any step independently.
