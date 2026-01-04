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

## Notes

- Browser capture uses `getUserMedia()` (mic/line-in). For system audio, route audio through a loopback/virtual device (e.g. VB-Cable) and select it as the input.
