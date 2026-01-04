# PRD: AI Director (Chat) + AI Asset Generation + Real‑Time Music Classification

Repo: `audviz-g52`  
Status: Draft (implementation-ready)  
Last updated: 2026-01-04

This PRD describes how to implement the missing “proper AI” pieces referenced in `.prompt/overall.md` using the current codebase structure:

- **AI Director (chat)**: natural language → structured visual intent → safe application to presets + parameter mappings + asset requests.
- **AI Asset Generation**: local + cloud image generation (Stable Diffusion-class) producing textures/LUTs/env maps/keyframes with caching and live-safe integration.
- **Real-time music classification**: on-device models that continuously infer track characteristics (genre/mood/section/etc.) and emit them to the visualizer.

---

## 1) Background / Current State (repo reality)

Today the repo implements a local-first prototype:

- `apps/brain`: Node/Express + WebSocket server (`8766`) with a browser capture UI (mic/line-in) streaming PCM frames to `AnalysisEngine`.
  - `apps/brain/src/analysis/engine.ts` performs DSP/heuristics (FFT, spectral flux, thresholding) for BPM, beats, “Build/Drop/Break” heuristics, energy, spectrum bins.
- `apps/visualizer`: browser UI + renderers (WebGPU/WebGL2/Canvas2D) receiving control signals over WS and applying preset switching.
  - Prompt mapping is **keyword rules** (`apps/visualizer/src/visuals/prompt.ts`).
- `services/asset-gen`: Node/Express service (`8790`) that generates **procedural PNGs** from prompt keywords + seed, with disk cache.

What’s missing compared to `.prompt/overall.md`:

- No LLM/chat-based prompt interpretation into structured visual configurations.
- No diffusion-class (or equivalent) image generation pipeline (local/cloud) and no asset types beyond a single texture PNG.
- No ML-based music classification (genre/mood/section), only heuristics.

This PRD defines what to build next, while keeping the “live” constraints front and center (latency, stability, offline-first, graceful fallback).

---

## 2) Goals

### 2.1 Product goals

1. **Chat-driven creative control**: DJs can type natural language (“make it a neon cyber tunnel, less strobe, more dreamy”) and reliably get an appropriate preset + palette + parameters + assets without thinking in shader knobs.
2. **High-quality AI assets**: on-demand textures/LUTs/envmaps/keyframes generated locally or via cloud, cached, and swapped in without frame hitching.
3. **Real-time music intelligence**: on-device classification that outputs stable genre/mood/section signals that the visualizer can use for smarter auto scenes and style suggestions.
4. **Live reliability**: visuals never freeze because AI is slow or offline; AI features degrade gracefully to deterministic fallbacks.

### 2.2 Engineering goals

- Pluggable backends for both **LLM** and **image generation** (local, cloud, or hybrid).
- Strict schemas + validation for all model outputs (no “LLM free-text drives code”).
- Clear boundaries:
  - Visualizer has **no secrets** (no cloud API keys).
  - Brain (local service / eventual native app) holds credentials and proxies cloud calls.
- Performance budgets that keep 1080p60 rendering stable.

---

## 3) Non-Goals (v1)

- Training new foundation models from scratch.
- Full “self-hosted cloud” infra. Cloud use assumes a managed provider or a thin hosted API in front of a provider.
- Perfect audio segmentation (verse/chorus) across all genres; v1 targets a DJ-centric label set (Intro/Build/Drop/Break/Outro + optional “Vocal/NoVocal”).
- A fully-fledged preset authoring IDE. v1 focuses on chat → safe patch application + asset binding.

---

## 4) Personas & Primary Use Cases

### Personas

- **DJ (live)**: needs fast, predictable changes and zero crashes; prefers simple “do what I mean” prompts.
- **VJ / visual operator**: wants more control, can iterate prompts, may pre-generate assets.
- **Developer**: wants debuggable model outputs, reproducibility (seed), and clear failure reporting.

### Top use cases

1. **Change visual theme via chat** during a calm section; apply on next beat; generate new assets in background.
2. **Auto style suggestions** based on detected genre/mood/section; user can accept or override.
3. **Pre-generate a “show pack”**: a set of prompts + assets cached locally before performance.
4. **Offline gig**: all core visuals + basic prompt mapping work with no internet.

---

## 5) User Experience (Visualizer)

### 5.1 AI Director panel (new)

Add an “AI Director” panel alongside the existing controls:

- Chat transcript (user + assistant).
- “Apply” / “Preview” flow:
  - Assistant response includes a **structured “plan”**: preset, palette, parameter changes, assets to generate, transition method.
  - User can **Apply**, **Edit**, **Undo**, **Regenerate**, or “Apply palette only / Apply preset only”.
- “Live safe” controls:
  - Apply timing: **Immediate**, **On next beat**, **In N beats**, **At next Drop**.
  - “Do not switch scenes, only change palette/texture”.
- Status chips:
  - AI backend: Local / Cloud / Offline fallback.
  - Asset generation: queue length + current job progress.

### 5.2 Prompt input behavior (updated)

Keep the existing single-line prompt input as “Quick prompt”, but route it through the same interpretation pipeline:

- Quick prompt = one-shot chat message (“system: make it…”).
- If AI is unavailable, fall back to current keyword mapper (existing behavior).

### 5.3 Asset progress UX

When an asset is requested:

- Show a progress line: “Generating: seamless lava texture (768px)…”.
- If generation > threshold (e.g., 6s), show “Still working…” but do not block visuals.
- When ready, swap in on the configured timing (beat-synced crossfade by default).

---

## 6) System Architecture (target)

### 6.1 Components

**Visualizer (browser)**
- Renders at 60 FPS (WebGPU preferred).
- Hosts UI and applies *validated* “visual patches”.
- Requests AI interpretation + assets via local Brain HTTP API.

**Brain (local service; today Node, future native app)**
- Audio capture + analysis pipeline.
- Hosts local HTTP API and WS for the visualizer.
- Holds secrets/config and proxies cloud calls.
- Runs real-time classifiers (local model inference).

**Asset backends (pluggable)**
- **Procedural** (existing `services/asset-gen`) as fallback and fast option.
- **Local diffusion worker** (new): separate process/service (recommended) to avoid blocking.
- **Cloud provider** (new): REST API integration.

### 6.2 High-level data flow

1. Audio capture → Brain → analysis + classification → WS → Visualizer (beats, bpm, energy, section, genre/mood, etc.)
2. User chat prompt → Visualizer → Brain `/api/ai/interpret` → (LLM/local) → returns `VisualPlan`
3. Visualizer applies safe parts immediately (palette/params) and triggers assets via Brain `/api/assets/*`
4. Assets generated (local or cloud) → cached → delivered as URL/binary → uploaded to GPU → transitioned live-safe

---

## 7) AI Director: Prompt → Structured Visual Plan

### 7.1 Core requirement

The system must convert chat text into a **strict, schema-validated** `VisualPlan` that can be applied without executing arbitrary model output.

### 7.2 `VisualPlan` (v1 schema)

`VisualPlan` is the only thing the visualizer can apply. It contains:

- `assistantMessage: string` (for UI only; not executed)
- `patch: VisualPatch`
- `assetRequests: AssetRequest[]`
- `apply: { timing: "now" | "nextBeat" | "beats" | "nextDrop"; beats?: number; transition: TransitionSpec }`
- `confidence: number` (0..1)
- `warnings: string[]`

#### `VisualPatch`

Minimal set aligned with current code + planned growth:

- `presetId?: PresetId` (existing)
- `palette?: Palette` (existing shape)
- `texturePrompt?: string` (existing, drives texture generation)
- `params?: Record<string, number | boolean | string>` (new; for renderer-specific shader params)
- `audioMappings?: AudioMapping[]` (new; maps audio signals to params)

#### `AudioMapping` (v1)

- `source`: `"energy" | "beat" | "bpm" | "spectrum.bass" | "spectrum.mid" | "spectrum.treble" | "genre" | "mood" | "section"`
- `targetParam`: string
- `curve`: `"linear" | "exp" | "smoothstep"`
- `scale`: number
- `bias`: number
- `clamp`: `[min, max]`

#### `TransitionSpec`

- `type`: `"cut" | "crossfade" | "beatCrossfade"`
- `durationMs?: number`
- `durationBeats?: number`

### 7.3 Interpretation backends (pluggable)

#### A) Cloud LLM (recommended for best UX)

Brain calls a chat model with:

- System prompt describing allowed outputs + schemas.
- A “capability manifest”:
  - available presets (`id`, `name`, short description tags)
  - allowed params and ranges per renderer/preset
  - available asset types + size limits
  - current visual state (current preset, palette, active assets)
  - optional music context (current BPM/energy/section/genre/mood)

The model **must** return valid JSON for `VisualPlan`.

Guardrails:
- Parse/validate with Zod.
- Reject/repair invalid JSON (1 retry with “return valid JSON”).
- If still invalid, fall back to local heuristic mapper.

#### B) Local “embedding + rules” mapper (offline / low cost)

Run locally in Brain (or in Visualizer if no secrets needed):

- Extract tags/colors from prompt (rule-based).
- Compute embedding (CLIP text encoder or sentence-transformer) and match to embedded preset descriptions.
- Output a deterministic `VisualPlan` with:
  - nearest preset
  - palette derived from tags
  - texturePrompt derived from prompt
  - no free-form `params` except a small curated set

### 7.4 API: Interpret prompt

Brain endpoint (new):

- `POST /api/ai/interpret`

Request:

```json
{
  "messages": [{"role":"user","content":"make it neon cyber tunnel with lava accents"}],
  "state": {
    "currentPresetId": "tunnel",
    "currentPalette": {"a":[...], "b":[...], "c":[...], "d":[...]},
    "renderer": "WebGPU"
  },
  "capabilities": { "presets": [...], "assetTypes": ["texture","lut","envmap","keyframe"], "paramSchema": {...} },
  "musicContext": { "bpm": 128.2, "energy": 0.74, "section": "Build", "genre": {"top":"Techno","prob":0.66} }
}
```

Response: `VisualPlan`

### 7.5 Acceptance criteria (AI Director)

- Returns a valid `VisualPlan` (or explicit fallback) for 99%+ of prompts in a curated test suite.
- Applying a plan never crashes the visualizer (schema validation + bounds checks).
- “Apply on next beat” performs transition within ±1 frame of the next beat message (given WS timing).

---

## 8) AI Asset Generation (Textures, LUTs, Env Maps, Keyframes)

### 8.1 Asset types (v1)

1. **Seamless textures** (primary v1): `512..2048`, tileable preferred.
2. **Color LUTs**: small 2D/3D LUT representation (start with 2D LUT image).
3. **Environment maps**: equirectangular `1024x512` or `2048x1024`.
4. **Drop keyframes**: single images or short sequences (v1: single image; v1.1: N frames).

### 8.2 `AssetRequest` schema (v1)

- `type`: `"texture" | "lut" | "envmap" | "keyframe"`
- `prompt`: string
- `negativePrompt?`: string
- `size`: number (or `{w,h}` for envmap)
- `seed?`: number
- `format`: `"png" | "jpg" | "webp"`
- `tiling?`: boolean (textures)
- `safety`: `{ allowNSFW: false }` (default false; future)
- `modelHint?`: `"local" | "cloud" | "auto"`

### 8.3 Generation decision logic (local vs cloud)

Decision is made in Brain, based on:

- User plan: Local-only vs Cloud-assisted.
- Availability: is local model installed? is cloud configured?
- Live performance constraints:
  - if GPU contention detected (optional), prefer cloud
  - if offline, force local/procedural
- Asset type:
  - LUTs can be local procedural or lightweight model
  - textures/envmaps/keyframes prefer diffusion-class model

### 8.4 API: asset generation

Brain endpoints (new; visualizer calls these, never providers directly):

- `POST /api/assets/generate` → returns a `jobId`
- `GET /api/assets/jobs/:jobId` → status/progress + final `assetId` + URL
- `GET /api/assets/:assetId` → binary (image)

`/generate` should be async to support multi-second jobs.

### 8.5 Caching & IDs

All assets are content-addressed:

- `assetId = sha1(type + model + prompt + negativePrompt + size + seed + tiling + version)`
- Cache location (dev): `.cache/assets/`
  - `assetId.json` (metadata)
  - `assetId.png|webp|jpg` (binary)

Cache rules:
- Always re-use identical requests.
- Allow “re-roll” by changing seed.
- LRU eviction policy configurable (default: keep last N GB).

### 8.6 Backends

#### Procedural backend (existing)

Use current `services/asset-gen/src/server.ts` as:

- Fast fallback backend
- “No models installed” mode
- Deterministic textures for demo

#### Local diffusion backend (new)

Recommendation: separate worker process to isolate heavy deps and GPU usage.

Options (choose one for v1):
- Python `diffusers` service (HTTP) with SD1.5/SD2.1 for local plan; supports tiling.
- ComfyUI integration (call local ComfyUI via API; requires user install or bundled distribution).
- Native engine (future): onnx/directml/metal for tighter packaging.

v1 requirement:
- Provide a single “blessed” local path with documented install + health check.
- Brain chooses it when available.

#### Cloud backend (new)

Integrate a hosted diffusion service (SDXL-class) behind Brain:

- Auth stored only in Brain.
- Rate limit + per-user usage accounting.
- Return assets via signed URL or direct bytes.

### 8.7 Live-safe integration in visualizer

Requirements:
- Asset upload must not hitch frames:
  - decode via `createImageBitmap` off-main-thread when possible
  - upload textures on next animation frame boundary
- Switching textures uses:
  - crossfade uniform (preferred), or
  - two-texture blend for N frames, then swap

Acceptance:
- While generating assets, renderer continues at target FPS on recommended hardware.
- Asset apply occurs on configured timing (next beat/crossfade).

---

## 9) Real-Time Music Classification (Models in Brain)

### 9.1 Outputs (v1)

Brain should emit:

- Beat events (already)
- BPM + confidence (already)
- Energy (already)
- Spectrum bins (already)
- **Genre**: top label + probability + optional full distribution
- **Mood** (optional but recommended): e.g. `valence` and `arousal` in 0..1
- **Section**: `Intro | Build | Drop | Break | Outro` (model or hybrid)
- **Vocal presence** (optional): boolean + confidence

### 9.2 Update rates

- `beat`: per beat, low latency
- `bpm`: when stable / on change (or 1–2 Hz)
- `energy`: ~30 Hz
- `spectrum`: ~20 Hz
- `genre/mood`: 0.5–2 Hz (sliding window, smoothed)
- `section`: on boundary + occasional refresh (≤ 1 Hz)

### 9.3 Pipeline (streaming)

Maintain a ring buffer of PCM audio in Brain:

1. Resample to model sample rate (commonly 16k or 22.05k) if needed.
2. Compute log-mel spectrogram features in a worker thread.
3. Run model inference (ONNX recommended) in a worker thread:
   - genre classifier
   - mood regressor
   - (optional) section model or boundary detector
4. Post-process:
   - EMA smoothing over time
   - hysteresis for top-genre changes (avoid rapid flips)
   - confidence calibration
5. Emit messages to visualizer over WS.

### 9.4 Model packaging & updates

v1 constraints:
- Models must run offline.
- Models should be distributed as files (prefer `.onnx`) and loaded by Brain.

Packaging approach:
- Default: ship with a small set of models in a `models/` directory (not committed to repo for dev; downloaded at install time).
- Provide `/api/models/status` and `/api/models/download` hooks (future) for managed updates.
- Verify integrity with checksum/signature (future).

### 9.5 Protocol changes (`@audviz/protocol`)

Extend `BrainToVisualizerMessageSchema` to include:

- `genre`: either keep current `{ genre: string, prob: number }` or upgrade to:
  - `{ genre: { top: string, prob: number, dist?: Record<string, number> } }`
- `mood`: `{ mood: { valence: number, arousal: number, confidence: number } }`
- `vocal`: `{ vocal: { present: boolean, prob: number } }`
- (optional) `bands`: `{ bands: { bass: number, mid: number, treble: number } }`

All values must be bounded and validated.

### 9.6 Acceptance criteria (classification)

- Genre stabilizes to a plausible top label within 10 seconds for a curated test set of tracks; does not flip more than once per 15 seconds unless confidence drops.
- Section events occur with <2s delay and are “DJ-useful” (Build/Drop/Break alignment).
- Inference does not cause WS dropouts or audio processing overruns on typical laptops (worker-thread isolation).

---

## 10) Performance / Reliability Requirements

### Latency targets

- Audio→visual beat latency: <100ms end-to-end (existing goal).
- Prompt interpretation latency:
  - Local mapping: <150ms
  - Cloud LLM: <2s (p95) for non-streaming; streaming optional
- Asset generation latency:
  - Local diffusion: ~3–10s depending on GPU
  - Cloud diffusion: ~2–6s including network

### Reliability

- If AI endpoints fail, visualizer continues with last known visuals + existing deterministic mapping.
- If cloud unavailable, automatically fall back to local/procedural.
- Timeouts:
  - LLM: 8–12s max with fallback
  - Image gen: job-based; visualizer never blocks waiting

---

## 11) Security / Privacy

- Visualizer must not embed API keys.
- Brain stores cloud credentials locally (env var or encrypted config in future).
- No raw audio leaves the machine by default.
- Telemetry is opt-in only; never logs full user prompts unless explicitly enabled (default: store hashes/derived tags only).

---

## 12) Telemetry & Usage Tracking (Cloud plan readiness)

Minimum viable tracking (opt-in / cloud):

- Count of:
  - LLM calls (tokens in/out)
  - image generations (type/size/model)
- Performance metrics:
  - generation latency
  - failures/timeouts
- Store locally; optionally sync to backend when signed in.

---

## 13) Milestones (implementation plan)

### M0 — Schema + plumbing (1–2 days)

- Add shared schemas (`VisualPlan`, `AssetRequest`) and validation.
- Add Brain HTTP endpoints stubs (`/api/ai/interpret`, `/api/assets/*`) with mocked responses.
- Visualizer: add AI Director panel UI that can call the endpoints and apply a plan.

### M1 — Real-time classification (3–7 days)

- Add ring buffer + feature extraction worker.
- Integrate first ONNX model (genre) + smoothing + WS messages.
- Visualizer: display genre + allow genre-driven auto preset bias.

### M2 — Asset jobs + caching (3–7 days)

- Implement job queue + cache in Brain.
- Wire procedural backend through Brain (visualizer stops calling `8790` directly).
- Visualizer: apply texture when job finishes (beat-crossfade).

### M3 — Cloud LLM interpretation (2–5 days)

- Add LLM provider interface + one implementation.
- Implement strict JSON output + retries + fallback.
- Add “capability manifest” and renderer param schema.

### M4 — Diffusion backend (local or cloud) (time varies)

- Choose v1 backend (cloud first is usually fastest).
- Add generation parameters (tiling, negative prompts, formats).
- Integrate envmap + keyframe types (optional).

---

## 14) Open Questions / Risks

1. **Where should AI services live long-term?** In the product vision it’s a native Brain app; in repo today it’s Node. This PRD assumes Brain hosts the API/proxy.
2. **GPU contention** (local diffusion + WebGPU): needs measurement; may require guardrails (resolution caps, scheduling).
3. **Model selection/licensing**: choose models that are redistributable for local plan; ensure cloud provider ToS allows intended use.
4. **Prompt injection / unsafe outputs**: mitigated by strict schema, but still needs test suite and hard bounds.
5. **Renderer param explosion**: keep `params` small and curated in v1; expand with a versioned param schema.

