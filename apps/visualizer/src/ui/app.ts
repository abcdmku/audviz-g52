import { safeParseBrainToVisualizerMessage } from "@audviz/protocol";
import { VisualizerWsClient } from "../ws/client.js";
import {
  DEFAULT_PRESET_ID,
  PRESETS,
  type PresetId,
  type PresetSpec
} from "../visuals/presets.js";
import { mapPromptToPreset } from "../visuals/prompt.js";
import { createRenderer, type AnyRenderer } from "../visuals/renderer-factory.js";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<HTMLElement | string> = []
) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

export async function createApp() {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("Missing #app");
  root.innerHTML = "";

  const layout = el("div", { class: "layout" });
  const canvas = el("canvas");
  layout.appendChild(canvas);

  const panel = el("div", { class: "panel" });
  const dot = el("span", { class: "dot" });
  const wsPill = el("span", { class: "pill" }, [dot, "WS: disconnected"]);
  const backendPill = el("span", { class: "pill" }, ["Renderer: …"]);

  const title = el("div", { class: "title" }, [
    el("h1", {}, ["audviz visualizer"]),
    el("div", { style: "display:flex; gap: 8px; align-items: center;" }, [
      backendPill,
      wsPill
    ])
  ]);

  const presetSelect = el("select") as HTMLSelectElement;
  for (const p of PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    presetSelect.appendChild(opt);
  }
  presetSelect.value = DEFAULT_PRESET_ID;

  const promptInput = el("input", {
    type: "text",
    placeholder: 'e.g. "neon cyber tunnel", "fiery volcano", "kaleidoscope"'
  }) as HTMLInputElement;
  const applyPromptBtn = el("button", {}, ["Apply"]) as HTMLButtonElement;
  const genTexBtn = el("button", { class: "secondary" }, [
    "Generate texture"
  ]) as HTMLButtonElement;
  const openCaptureBtn = el("button", { class: "secondary" }, [
    "Open capture UI"
  ]) as HTMLButtonElement;
  const toggleUiBtn = el("button", { class: "secondary" }, [
    "Hide UI"
  ]) as HTMLButtonElement;

  const bpmEl = el("span", {}, ["-"]);
  const framesEl = el("span", {}, ["0"]);
  const energyBar = el("div");
  const meter = el("div", { class: "meter" }, [energyBar]);

  const kv = el("div", { class: "kv" }, [
    el("div", {}, ["BPM"]),
    bpmEl,
    el("div", {}, ["Frames"]),
    framesEl,
    el("div", {}, ["Energy"]),
    meter,
    el("div", {}, ["Preset"]),
    presetSelect
  ]);

  const promptRow = el("div", { class: "row" }, [
    el("div", {}, [el("label", {}, ["Prompt"]), promptInput]),
    el("div", {}, [el("label", {}, [" "]), applyPromptBtn])
  ]);

  const foot = el("div", { class: "foot" }, [
    openCaptureBtn,
    genTexBtn,
    el("div", {}, [toggleUiBtn])
  ]);

  panel.append(title, kv, promptRow, foot);
  layout.appendChild(panel);
  root.appendChild(layout);

  const renderer: AnyRenderer = await createRenderer(canvas);
  backendPill.textContent = `Renderer: ${"backend" in renderer ? renderer.backend : "WebGPU"}`;
  let activePreset = PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!;
  renderer.setPreset(activePreset);

  const ws = new VisualizerWsClient("ws://localhost:8766/ws");
  let wsConnected = false;
  ws.onStatus = (connected) => {
    wsConnected = connected;
    dot.classList.toggle("ok", connected);
    wsPill.lastChild!.textContent = connected
      ? "WS: connected"
      : "WS: disconnected";
  };

  let beatPulse = 0;
  const spectrum = new Float32Array(64);
  let energy = 0;
  let bpm = 120;
  let bpmConfidence = 0;
  let lastSignalAt = performance.now();

  ws.onMessage = (raw) => {
    const msg = safeParseBrainToVisualizerMessage(raw);
    if (!msg) return;
    lastSignalAt = performance.now();
    if ("event" in msg && msg.event === "beat") {
      beatPulse = 1;
      return;
    }
    if ("energy" in msg) {
      energy = msg.energy;
      return;
    }
    if ("bpm" in msg) {
      bpm = msg.bpm;
      bpmConfidence = msg.confidence;
      bpmEl.textContent = `${bpm.toFixed(1)} (${Math.round(bpmConfidence * 100)}%)`;
      return;
    }
    if ("spectrum" in msg) {
      const bins = msg.spectrum;
      const n = Math.min(bins.length, spectrum.length);
      for (let i = 0; i < n; i++) spectrum[i] = bins[i] ?? 0;
      return;
    }
  };

  ws.connect();

  presetSelect.addEventListener("change", () => {
    const id = presetSelect.value as PresetId;
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    activePreset = p;
    renderer.setPreset(activePreset);
  });

  applyPromptBtn.addEventListener("click", () => {
    const prompt = promptInput.value.trim();
    if (!prompt) return;
    const mapped = mapPromptToPreset(prompt);
    const preset = PRESETS.find((p) => p.id === mapped.presetId) ?? activePreset;
    activePreset = applyPresetOverride(preset, mapped);
    presetSelect.value = activePreset.id;
    renderer.setPreset(activePreset);
  });

  genTexBtn.addEventListener("click", async () => {
    const prompt = (promptInput.value || activePreset.texturePrompt || "").trim();
    if (!prompt) return;
    genTexBtn.disabled = true;
    try {
      const res = await fetch("http://localhost:8790/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, size: 512 })
      });
      if (!res.ok) throw new Error(`asset-gen ${res.status}`);
      const data = await res.json();
      if (!data?.pngBase64) throw new Error("Bad asset-gen response");
      await renderer.setTextureFromBase64Png(data.pngBase64);
    } finally {
      genTexBtn.disabled = false;
    }
  });

  openCaptureBtn.addEventListener("click", () => {
    window.open("http://localhost:8766/", "_blank", "noopener,noreferrer");
  });

  toggleUiBtn.addEventListener("click", () => {
    const hidden = panel.classList.toggle("hidden");
    toggleUiBtn.textContent = hidden ? "Show UI" : "Hide UI";
  });

  let last = performance.now();
  let frameCount = 0;
  let lastFpsUpdate = performance.now();
  let prevBeatPhase = 0;
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const demoMode = !wsConnected || now - lastSignalAt > 1200;
    if (demoMode) {
      const t = now / 1000;
      const demoEnergy = 0.35 + 0.25 * Math.sin(t * 0.9) + 0.15 * Math.sin(t * 2.1);
      energy = Math.max(energy * 0.9, Math.max(0.05, Math.min(1, demoEnergy)));
      const phase = (t * (bpm / 60)) % 1;
      if (phase < prevBeatPhase) beatPulse = 1;
      prevBeatPhase = phase;
      for (let i = 0; i < spectrum.length; i++) {
        const x = i / spectrum.length;
        spectrum[i] =
          0.15 +
          0.35 * (0.5 + 0.5 * Math.sin(t * 2.2 + x * 18)) +
          0.25 * (0.5 + 0.5 * Math.sin(t * 0.9 + x * 6));
      }
    }

    beatPulse = Math.max(0, beatPulse - dt * 3.2);
    energyBar.style.width = `${Math.round(energy * 100)}%`;

    renderer.render({
      time: now / 1000,
      bpm,
      energy,
      beat: beatPulse,
      spectrum
    });

    frameCount++;
    if (now - lastFpsUpdate > 500) {
      framesEl.textContent = String(frameCount);
      lastFpsUpdate = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function applyPresetOverride(
  preset: PresetSpec,
  mapped: { presetId: PresetId; palette?: PresetSpec["palette"]; texturePrompt?: string }
): PresetSpec {
  return {
    ...preset,
    palette: mapped.palette ?? preset.palette,
    texturePrompt: mapped.texturePrompt ?? preset.texturePrompt
  };
}
