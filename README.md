# audviz-g52

Local-first DJ visualizer: audio capture + analysis (“brain”) -> control signals -> WebGPU visualizer, with an optional local asset generator.

## Prereqs

- Node.js 20+ (Node 22 works)
- Chrome 113+ (WebGPU enabled by default on most modern installs)

## Quick start (dev)

In one terminal:

```powershell
npm install
npm run dev
```

Then:

- Open the Brain capture UI: `http://localhost:8766/`
- Open the Visualizer UI: check the Vite terminal output (usually `http://localhost:5173/`)
- Click **Start capture** in the Brain UI, then watch the visualizer react.

## Ports

- Brain service (WS + capture UI): `8766`
- Asset generator service: `8790`
- Visualizer dev server (Vite): `5173`

## Experimental: video generation (Brain API)

Brain exposes a job-based “video” API that stitches a short clip from sparse AI keyframes (base FPS) and fills intermediate frames via a lightweight interpolator (currently `blend`).

- Start a job: `POST http://localhost:8766/api/video/generate`
- Stream frames as they are produced (SSE): `GET http://localhost:8766/api/video/jobs/:jobId/stream`
- Poll status: `GET http://localhost:8766/api/video/jobs/:jobId`
- Fetch a frame image: `GET http://localhost:8766/api/video/frames/:frameId`

Example (PowerShell):

```powershell
$job = Invoke-RestMethod -Method Post -Uri http://localhost:8766/api/video/generate -ContentType application/json -Body (@{
  prompt = "stormy cyberpunk alley, cinematic, volumetric fog"
  durationSec = 2
  baseFps = 4
  fps = 24
  size = @{ w = 1280; h = 720 }
  format = "jpg"
  backendHint = "auto" # or: procedural | sdwebui
} | ConvertTo-Json)

curl -N http://localhost:8766/api/video/jobs/$($job.jobId)/stream
```

## Notes

- Browser capture uses `getUserMedia()` (mic/line-in). For system audio, route audio through a loopback/virtual device (e.g. VB-Cable) and select it as the input.

## Using free textures (no AI generation)

The visualizer supports loading a texture directly from a remote image URL (Brain proxies the download to avoid CORS, resizes to a square PNG, and caches it locally).

- Use a CC0/public-domain texture site like Poly Haven or ambientCG, copy a direct image URL (`.jpg`/`.png`), then paste it into **Texture URL** in the Visualizer UI and click **Load URL**.
- Turn off **Auto textures** if you don’t want the app to keep generating new textures per scene.

## Optional AI config

- **Gemini (AI Director, cloud)**: set `GEMINI_API_KEY` (optionally `AI_INTERPRETER=auto|gemini`) in the Brain environment.
  - PowerShell:
    - `$env:GEMINI_API_KEY="YOUR_KEY_HERE"`
    - `$env:AI_INTERPRETER="gemini"` (optional)
    - `npm run dev`
- **MTG-Jamendo / ONNX audio classification (Brain worker, optional)**:
  - Install runtime: `npm i -w @audviz/brain onnxruntime-node`
  - Point Brain at your model: `MTG_JAMENDO_MODEL_PATH=...` (or `GENRE_MODEL_PATH=...`)
  - If your model outputs tag logits, provide labels: `GENRE_LABELS_PATH=path/to/labels.json` (array of strings)
