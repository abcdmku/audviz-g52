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
  const signalDot = el("span", { class: "dot demo" });
  const signalPill = el("span", { class: "pill" }, [signalDot, "Signal: demo"]);
  const backendPill = el("span", { class: "pill" }, ["Renderer: …"]);

  const title = el("div", { class: "title" }, [
    el("h1", {}, ["audviz visualizer"]),
    el("div", { style: "display:flex; gap: 8px; align-items: center;" }, [
      backendPill,
      wsPill,
      signalPill
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

  const autoToggle = el("input", { type: "checkbox" }) as HTMLInputElement;
  autoToggle.checked = true;
  const autoTextureToggle = el("input", {
    type: "checkbox"
  }) as HTMLInputElement;
  autoTextureToggle.checked = true;

  const promptInput = el("input", {
    type: "text",
    placeholder: 'e.g. "neon cyber tunnel", "fiery volcano", "kaleidoscope"'
  }) as HTMLInputElement;
  const applyPromptBtn = el("button", {}, ["Apply"]) as HTMLButtonElement;
  const genTexBtn = el("button", { class: "secondary" }, ["Regenerate texture"]) as HTMLButtonElement;
  const openCaptureBtn = el("button", { class: "secondary" }, [
    "Open capture UI"
  ]) as HTMLButtonElement;
  const toggleUiBtn = el("button", { class: "secondary" }, [
    "Hide UI"
  ]) as HTMLButtonElement;

  const bpmEl = el("span", {}, ["-"]);
  const framesEl = el("span", {}, ["0"]);
  const sectionEl = el("span", {}, ["-"]);
  const energyBar = el("div");
  const meter = el("div", { class: "meter" }, [energyBar]);

  const kv = el("div", { class: "kv" }, [
    el("div", {}, ["BPM"]),
    bpmEl,
    el("div", {}, ["Frames"]),
    framesEl,
    el("div", {}, ["Section"]),
    sectionEl,
    el("div", {}, ["Energy"]),
    meter,
    el("div", {}, ["Preset"]),
    presetSelect
  ]);

  const autoRow = el("div", { style: "margin: 10px 0; display:flex; gap: 10px; align-items:center;" }, [
    autoToggle,
    el("div", { style: "font-size:12px; color: var(--muted);" }, ["Auto scene switching (drops/builds/high-intensity)"])
  ]);
  const textureRow = el("div", { style: "margin: 0 0 10px; display:flex; gap: 10px; align-items:center;" }, [
    autoTextureToggle,
    el("div", { style: "font-size:12px; color: var(--muted);" }, ["Auto textures (generated + unique per scene)"])
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

  panel.append(title, kv, autoRow, textureRow, promptRow, foot);
  layout.appendChild(panel);
  root.appendChild(layout);

  const renderer: AnyRenderer = await createRenderer(canvas);
  backendPill.textContent = `Renderer: ${"backend" in renderer ? renderer.backend : "WebGPU"}`;
  let activePreset = PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!;
  renderer.setPreset(activePreset);
  // Ensure we start with a real generated texture (so scenes don't feel flat).
  // This is a best-effort call; it silently disables itself if asset-gen isn't running.
  void (async () => {
    await new Promise((r) => setTimeout(r, 50));
    maybeAutoTexture(activePreset, "scene");
  })();

  let targetPreset: PresetSpec | null = null;
  let transition = 0; // 0..1
  let dropPulse = 0;
  let lastSection = "";

  const sessionSeed = Math.floor(Math.random() * 2 ** 31);
  if ("setSeed" in renderer && typeof renderer.setSeed === "function") {
    renderer.setSeed(sessionSeed);
  }
  let texReqId = 0;
  let lastTextureAt = 0;
  let textureCounter = 0;
  let assetGenHealthy: boolean | null = null;

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
  let lastSignalAt = -Infinity;
  let signalState: "demo" | "waiting" | "live" = "demo";

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
    if ("section" in msg) {
      lastSection = msg.section;
      sectionEl.textContent = msg.section;
      if (autoToggle.checked) {
        handleSectionSwitch(msg.section);
      }
      if (msg.section === "Drop") {
        dropPulse = 1;
        maybeAutoTexture(activePreset, "drop");
      }
      return;
    }
  };

  ws.connect();
  void checkAssetGenHealth();

  presetSelect.addEventListener("change", () => {
    const id = presetSelect.value as PresetId;
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    transitionTo(p, "manual");
  });

  applyPromptBtn.addEventListener("click", () => {
    const prompt = promptInput.value.trim();
    if (!prompt) return;
    const mapped = mapPromptToPreset(prompt);
    const preset = PRESETS.find((p) => p.id === mapped.presetId) ?? activePreset;
    transitionTo(applyPresetOverride(preset, mapped), "prompt");
  });

  genTexBtn.addEventListener("click", async () => {
    await generateAndApplyTexture(activePreset, "manual");
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
  let lastAutoSwitchAt = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const signalAgeMs = now - lastSignalAt;
    const live = wsConnected && signalAgeMs < 1200;
    const nextSignalState: typeof signalState = !wsConnected
      ? "demo"
      : live
        ? "live"
        : "waiting";

    if (nextSignalState !== signalState) {
      // Prevent demo visuals from masquerading as real audio once WS connects.
      if (signalState === "demo" && nextSignalState !== "demo") {
        energy = 0;
        beatPulse = 0;
        dropPulse = 0;
        spectrum.fill(0);
      }
      signalState = nextSignalState;

      signalDot.classList.toggle("ok", signalState === "live");
      signalDot.classList.toggle("warn", signalState === "waiting");
      signalDot.classList.toggle("demo", signalState === "demo");
      signalPill.lastChild!.textContent =
        signalState === "live"
          ? "Signal: live"
          : signalState === "waiting"
            ? "Signal: waiting"
            : "Signal: demo";
    }

    if (signalState === "demo") {
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
    } else if (signalState === "waiting") {
      energy = energy * 0.92;
      bpmConfidence = bpmConfidence * 0.92;
      for (let i = 0; i < spectrum.length; i++) spectrum[i] = spectrum[i]! * 0.85;
    }

    beatPulse = Math.max(0, beatPulse - dt * 3.2);
    dropPulse = Math.max(0, dropPulse - dt * 0.9);
    energyBar.style.width = `${Math.round(energy * 100)}%`;

    // Transition timing: ~2 beats feels musical.
    if (targetPreset) {
      const beatSec = 60 / Math.max(1, bpm);
      const dur = Math.max(0.35, beatSec * 2);
      transition = Math.min(1, transition + dt / dur);
      if ("setTransition" in renderer && typeof renderer.setTransition === "function") {
        renderer.setTransition(activePreset, targetPreset, transition, dropPulse);
      } else {
        // Canvas2D: swap at end
        if (transition >= 1) renderer.setPreset(targetPreset);
      }
      if (transition >= 1) {
        activePreset = targetPreset;
        targetPreset = null;
        transition = 0;
        presetSelect.value = activePreset.id;
      }
    } else {
      if ("setTransition" in renderer && typeof renderer.setTransition === "function") {
        renderer.setTransition(activePreset, activePreset, 0, dropPulse);
      }
    }

    // Auto: if energy stays extreme without section labels, do a morph.
    if (autoToggle.checked) {
      const intense = energy > 0.82;
      if (!targetPreset && intense && now - lastAutoSwitchAt > 3500) {
        lastAutoSwitchAt = now;
        const next = pickAutoPreset("peak");
        transitionTo(next, "auto-peak");
      }
    }

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

  function transitionTo(preset: PresetSpec, _reason: string) {
    // If a custom override came from prompt, it may not exist in PRESETS; still allow.
    targetPreset = preset;
    transition = 0;
    if (!("setTransition" in renderer)) {
      // ensure at least palette changes immediately on Canvas2D
      renderer.setPreset(activePreset);
    }
    maybeAutoTexture(preset, "scene");
  }

  function handleSectionSwitch(section: string) {
    if (section === "Drop") {
      transitionTo(pickAutoPreset("drop"), "drop");
      return;
    }
    if (section === "Break") {
      transitionTo(pickAutoPreset("break"), "break");
      return;
    }
    if (section === "Build") {
      transitionTo(pickAutoPreset("build"), "build");
      return;
    }
  }

  function pickAutoPreset(kind: "drop" | "break" | "build" | "peak"): PresetSpec {
    const pools: Record<typeof kind, PresetId[]> = {
      drop: ["warp", "strobeGrid", "strobeGeo", "tunnel"],
      break: ["plasma", "nebula", "kaleido"],
      build: ["nebula", "tunnel", "kaleido"],
      peak: ["warp", "nebula", "strobeGrid", "strobeGeo", "kaleido"]
    };
    const ids = pools[kind];
    // Add BPM bias: faster => tunnel/grid, slower => nebula/warp.
    const biased =
      bpm > 140 && kind !== "break"
        ? [...ids, "tunnel", "strobeGrid"]
        : bpm < 110
          ? [...ids, "nebula", "warp"]
          : ids;
    const id = biased[Math.floor(Math.random() * biased.length)]!;
    return PRESETS.find((p) => p.id === id)!;
  }

  async function checkAssetGenHealth() {
    try {
      const res = await fetch("http://localhost:8790/health");
      assetGenHealthy = res.ok;
    } catch {
      assetGenHealthy = false;
    }
  }

  function buildTexturePrompt(preset: PresetSpec) {
    const fromInput = promptInput.value.trim();
    const p = (fromInput || preset.texturePrompt || preset.name).trim();
    // Bias toward seamless/high-frequency details, since it drives shader/warp sampling.
    return `${p}, high detail, seamless, abstract texture`;
  }

  function maybeAutoTexture(preset: PresetSpec, reason: "scene" | "drop") {
    if (!autoTextureToggle.checked) return;
    const now = performance.now();
    if (reason === "drop" && now - lastTextureAt < 6500) return;
    if (assetGenHealthy === false) return;
    // Let health check settle; if unknown, we still try once.
    void generateAndApplyTexture(preset, reason);
  }

  async function generateAndApplyTexture(preset: PresetSpec, _reason: "scene" | "drop" | "manual") {
    const prompt = buildTexturePrompt(preset);
    if (!prompt) return;

    const myId = ++texReqId;
    textureCounter++;
    genTexBtn.disabled = true;
    try {
      const seed = (sessionSeed + (textureCounter + 1) * 1013 + Math.floor(performance.now())) & 0x7fffffff;
      const res = await fetch("http://localhost:8790/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, size: 768, seed })
      });
      if (!res.ok) throw new Error(`asset-gen ${res.status}`);
      const data = await res.json();
      if (!data?.pngBase64) throw new Error("Bad asset-gen response");
      if (myId !== texReqId) return; // newer request won
      await renderer.setTextureFromBase64Png(data.pngBase64);
      lastTextureAt = performance.now();
    } catch {
      assetGenHealthy = false;
    } finally {
      if (myId === texReqId) genTexBtn.disabled = false;
    }
  }
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
