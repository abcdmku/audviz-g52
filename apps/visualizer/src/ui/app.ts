import {
  AssetGenerateResponseSchema,
  AssetJobStatusSchema,
  type AssetRequest,
  type AudioMapping,
  VideoFrameMetaSchema,
  VideoGenerateResponseSchema,
  VideoJobStatusSchema,
  type VisualPlan,
  safeParseBrainToVisualizerMessage,
  safeParseVisualPlan
} from "@audviz/protocol";
import { VisualizerWsClient } from "../ws/client.js";
import {
  DEFAULT_PRESET_ID,
  PRESETS,
  type PresetId,
  type PresetSpec
} from "../visuals/presets.js";
import { mapPromptToPreset } from "../visuals/prompt.js";
import { createRenderer, type AnyRenderer } from "../visuals/renderer-factory.js";
import {
  DEFAULT_PARAMS,
  aiParamSchema,
  clampParam,
  coerceParamKey,
  type ParamKey
} from "../visuals/params.js";

const BRAIN_PORT = 8766;
const BRAIN_HOST = window.location.hostname || "localhost";
const BRAIN_HTTP = `http://${BRAIN_HOST}:${BRAIN_PORT}`;
const BRAIN_WS = `ws://${BRAIN_HOST}:${BRAIN_PORT}/ws`;

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
  const textureUrlInput = el("input", {
    type: "text",
    placeholder: "https://… (CC0/public-domain texture image URL)"
  }) as HTMLInputElement;
  const loadTexUrlBtn = el("button", { class: "secondary" }, ["Load URL"]) as HTMLButtonElement;
  const openCaptureBtn = el("button", { class: "secondary" }, [
    "Open capture UI"
  ]) as HTMLButtonElement;
  const toggleUiBtn = el("button", { class: "secondary" }, [
    "Hide UI"
  ]) as HTMLButtonElement;

  const bpmEl = el("span", {}, ["-"]);
  const framesEl = el("span", {}, ["0"]);
  const sectionEl = el("span", {}, ["-"]);
  const genreEl = el("span", {}, ["-"]);
  const moodEl = el("span", {}, ["-"]);
  const energyBar = el("div");
  const meter = el("div", { class: "meter" }, [energyBar]);

  const kv = el("div", { class: "kv" }, [
    el("div", {}, ["BPM"]),
    bpmEl,
    el("div", {}, ["Frames"]),
    framesEl,
    el("div", {}, ["Section"]),
    sectionEl,
    el("div", {}, ["Genre"]),
    genreEl,
    el("div", {}, ["Mood"]),
    moodEl,
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

  const textureUrlRow = el("div", { class: "row" }, [
    el("div", {}, [el("label", {}, ["Texture URL"]), textureUrlInput]),
    el("div", {}, [el("label", {}, [" "]), loadTexUrlBtn])
  ]);

  const promptRow = el("div", { class: "row" }, [
    el("div", {}, [el("label", {}, ["Prompt"]), promptInput]),
    el("div", {}, [el("label", {}, [" "]), applyPromptBtn])
  ]);

  const videoDurationInput = el("input", { type: "text", value: "2" }) as HTMLInputElement;
  const videoFpsInput = el("input", { type: "text", value: "24" }) as HTMLInputElement;
  const videoBaseFpsInput = el("input", { type: "text", value: "4" }) as HTMLInputElement;

  const videoBackendSelect = el("select") as HTMLSelectElement;
  for (const opt of [
    ["auto", "Auto"],
    ["procedural", "Procedural"],
    ["sdwebui", "SD WebUI"]
  ] as const) {
    const o = document.createElement("option");
    o.value = opt[0];
    o.textContent = opt[1];
    videoBackendSelect.appendChild(o);
  }
  videoBackendSelect.value = "auto";

  const genVideoBtn = el("button", { class: "secondary" }, ["Generate video"]) as HTMLButtonElement;
  const stopVideoBtn = el("button", { class: "secondary" }, ["Stop"]) as HTMLButtonElement;
  stopVideoBtn.disabled = true;

  const videoRow = el("div", { class: "row" }, [
    el("div", {}, [el("label", {}, ["Video sec"]), videoDurationInput]),
    el("div", {}, [el("label", {}, ["FPS"]), videoFpsInput]),
    el("div", {}, [el("label", {}, ["Base FPS"]), videoBaseFpsInput]),
    el("div", {}, [el("label", {}, ["Backend"]), videoBackendSelect]),
    el("div", {}, [el("label", {}, [" "]), genVideoBtn]),
    el("div", {}, [el("label", {}, [" "]), stopVideoBtn])
  ]);

  const aiDot = el("span", { class: "dot demo" });
  const aiPill = el("span", { class: "pill" }, [aiDot, "AI: offline"]);
  const assetsDot = el("span", { class: "dot demo" });
  const assetsPill = el("span", { class: "pill" }, [assetsDot, "Assets: idle"]);
  const videoDot = el("span", { class: "dot demo" });
  const videoPill = el("span", { class: "pill" }, [videoDot, "Video: idle"]);

  const aiHeader = el("div", { class: "aiHeader" }, [
    el("div", { class: "aiTitle" }, ["AI Director"]),
    el("div", { class: "aiChips" }, [aiPill, assetsPill, videoPill])
  ]);

  const chatLog = el("div", { class: "chat" });

  const aiInput = el("input", {
    type: "text",
    placeholder: 'e.g. "neon cyber tunnel, less strobe, dreamy"'
  }) as HTMLInputElement;
  const aiSendBtn = el("button", { class: "secondary" }, ["Preview"]) as HTMLButtonElement;

  const aiInputRow = el("div", { class: "row" }, [
    el("div", {}, [el("label", {}, ["AI Prompt"]), aiInput]),
    el("div", {}, [el("label", {}, [" "]), aiSendBtn])
  ]);

  const timingSelect = el("select") as HTMLSelectElement;
  for (const opt of [
    ["now", "Immediate"],
    ["nextBeat", "On next beat"],
    ["beats", "In N beats"],
    ["nextDrop", "At next Drop"]
  ] as const) {
    const o = document.createElement("option");
    o.value = opt[0];
    o.textContent = opt[1];
    timingSelect.appendChild(o);
  }
  timingSelect.value = "nextBeat";

  const beatsInput = el("input", {
    type: "text",
    value: "2"
  }) as HTMLInputElement;

  const applyPlanBtn = el("button", {}, ["Apply"]) as HTMLButtonElement;
  const applyPaletteBtn = el("button", { class: "secondary" }, ["Palette only"]) as HTMLButtonElement;
  const applyPresetBtn = el("button", { class: "secondary" }, ["Preset only"]) as HTMLButtonElement;
  const undoBtn = el("button", { class: "secondary" }, ["Undo"]) as HTMLButtonElement;
  const regenBtn = el("button", { class: "secondary" }, ["Regenerate"]) as HTMLButtonElement;

  const planDetails = document.createElement("details");
  planDetails.className = "planDetails";
  const planDetailsSummary = document.createElement("summary");
  planDetailsSummary.textContent = "Latest plan (JSON)";
  const planPre = document.createElement("pre");
  planPre.className = "planJson";
  planPre.textContent = "";
  planDetails.append(planDetailsSummary, planPre);

  const aiControls = el("div", { class: "aiControls" }, [
    el("div", {}, [el("label", {}, ["Apply timing"]), timingSelect]),
    el("div", {}, [el("label", {}, ["Beats"]), beatsInput]),
    applyPlanBtn,
    applyPaletteBtn,
    applyPresetBtn,
    undoBtn,
    regenBtn
  ]);

  const foot = el("div", { class: "foot" }, [openCaptureBtn, genTexBtn, el("div", {}, [toggleUiBtn])]);

  panel.append(
    title,
    kv,
    autoRow,
    textureRow,
    textureUrlRow,
    promptRow,
    videoRow,
    aiHeader,
    chatLog,
    aiInputRow,
    aiControls,
    planDetails,
    foot
  );
  layout.appendChild(panel);
  root.appendChild(layout);

  let currentParams: Record<ParamKey, number> = { ...DEFAULT_PARAMS };

  const renderer: AnyRenderer = await createRenderer(canvas);
  backendPill.textContent = `Renderer: ${"backend" in renderer ? renderer.backend : "WebGPU"}`;
  let activePreset = PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!;
  renderer.setPreset(activePreset);
  // Ensure we start with a real generated texture (so scenes don't feel flat).
  // This is a best-effort call; it silently disables itself if the Brain asset API isn't available.
  void (async () => {
    await new Promise((r) => setTimeout(r, 50));
    maybeAutoTexture(activePreset, "scene");
  })();

  let targetPreset: PresetSpec | null = null;
  let transition = 0; // 0..1
  let transitionSpec: VisualPlan["apply"]["transition"] | null = null;
  let dropPulse = 0;
  let lastSection = "";

  const sessionSeed = Math.floor(Math.random() * 2 ** 31);
  if ("setSeed" in renderer && typeof renderer.setSeed === "function") {
    renderer.setSeed(sessionSeed);
  }
  if ("setUserParams" in renderer && typeof renderer.setUserParams === "function") {
    renderer.setUserParams(currentParams);
  }
  let texReqId = 0;
  let lastTextureAt = 0;
  let textureCounter = 0;
  let aiTextureCounter = 0;
  let assetsHealthy: boolean | null = null;
  let assetsBusy = false;
  let aiCloudReady: boolean | null = null;
  let videoBusy = false;
  let videoSource: EventSource | null = null;
  let videoFrameToken = 0;
  let videoFramesReceived = 0;

  const ws = new VisualizerWsClient(BRAIN_WS);
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

  let lastPlan: VisualPlan | null = null;
  let lastPlanPrompt: string | null = null;
  let currentMappings: AudioMapping[] = [];
  let undoState:
    | { preset: PresetSpec; params: Record<ParamKey, number>; mappings: AudioMapping[] }
    | null = null;
  let pendingApplyToken = 0;

  let genreTop = "";
  let genreProb = 0;
  let moodValence = 0.5;
  let moodArousal = 0.5;
  const runtimeParams: Record<ParamKey, number> = { ...DEFAULT_PARAMS };

  const beatWaiters: Array<() => void> = [];
  const dropWaiters: Array<() => void> = [];

  function drain(waiters: Array<() => void>) {
    const fns = waiters.splice(0);
    for (const fn of fns) fn();
  }

  function waitForNextBeat(timeoutMs = 3000) {
    return new Promise<void>((resolve) => {
      const t = window.setTimeout(resolve, timeoutMs);
      beatWaiters.push(() => {
        window.clearTimeout(t);
        resolve();
      });
    });
  }

  async function waitForBeats(count: number) {
    const n = Math.max(1, Math.min(128, Math.floor(count)));
    for (let i = 0; i < n; i++) await waitForNextBeat();
  }

  function waitForNextDrop(timeoutMs = 20_000) {
    return new Promise<void>((resolve) => {
      const t = window.setTimeout(resolve, timeoutMs);
      dropWaiters.push(() => {
        window.clearTimeout(t);
        resolve();
      });
    });
  }

  ws.onMessage = (raw) => {
    const msg = safeParseBrainToVisualizerMessage(raw);
    if (!msg) return;
    lastSignalAt = performance.now();
    if ("event" in msg && msg.event === "beat") {
      beatPulse = 1;
      drain(beatWaiters);
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
    if ("genre" in msg) {
      const g = (msg as any).genre as any;
      const top = typeof g === "string" ? g : (g?.top as string | undefined);
      const prob = typeof g === "string" ? ((msg as any).prob as number | undefined) : (g?.prob as number | undefined);
      if (top) {
        genreTop = top;
        genreProb = typeof prob === "number" && Number.isFinite(prob) ? Math.max(0, Math.min(1, prob)) : 0;
        const pct = prob != null ? ` (${Math.round(prob * 100)}%)` : "";
        genreEl.textContent = `${top}${pct}`;
      }
      return;
    }
    if ("mood" in msg) {
      const m = (msg as any).mood as any;
      if (m && typeof m.valence === "number" && typeof m.arousal === "number") {
        moodValence = Math.max(0, Math.min(1, m.valence));
        moodArousal = Math.max(0, Math.min(1, m.arousal));
        moodEl.textContent = `V ${m.valence.toFixed(2)} / A ${m.arousal.toFixed(2)}`;
      }
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
        drain(dropWaiters);
        maybeAutoTexture(activePreset, "drop");
      }
      return;
    }
  };

  ws.connect();
  void checkAssetsHealth();
  void checkAiStatus();

  applyPlanBtn.disabled = true;
  applyPaletteBtn.disabled = true;
  applyPresetBtn.disabled = true;
  undoBtn.disabled = true;
  regenBtn.disabled = true;

  function syncTimingUi() {
    const isBeats = timingSelect.value === "beats";
    beatsInput.toggleAttribute("disabled", !isBeats);
    beatsInput.style.opacity = isBeats ? "1" : "0.6";
  }
  timingSelect.addEventListener("change", syncTimingUi);
  syncTimingUi();

  presetSelect.addEventListener("change", () => {
    const id = presetSelect.value as PresetId;
    if (id !== "aiVideo") stopVideo();
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    transitionTo(p, "manual");
  });

  genVideoBtn.addEventListener("click", () => {
    void startVideo();
  });

  stopVideoBtn.addEventListener("click", () => {
    stopVideo();
  });

  applyPromptBtn.addEventListener("click", () => {
    const prompt = promptInput.value.trim();
    if (!prompt) return;
    aiInput.value = prompt;
    void previewAndApplyPrompt(prompt, { autoApply: true });
  });

  aiSendBtn.addEventListener("click", () => {
    const prompt = aiInput.value.trim();
    if (!prompt) return;
    promptInput.value = prompt;
    void previewAndApplyPrompt(prompt, { autoApply: false });
  });

  aiInput.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    const prompt = aiInput.value.trim();
    if (!prompt) return;
    promptInput.value = prompt;
    void previewAndApplyPrompt(prompt, { autoApply: false });
  });

  applyPlanBtn.addEventListener("click", () => {
    if (!lastPlan) return;
    void applyVisualPlan(lastPlan, "full");
  });

  applyPaletteBtn.addEventListener("click", () => {
    if (!lastPlan) return;
    void applyVisualPlan(lastPlan, "palette");
  });

  applyPresetBtn.addEventListener("click", () => {
    if (!lastPlan) return;
    void applyVisualPlan(lastPlan, "preset");
  });

  undoBtn.addEventListener("click", () => {
    if (!undoState) return;
    pendingApplyToken++;
    currentParams = { ...undoState.params };
    currentMappings = [...undoState.mappings];
    renderer.setUserParams(currentParams);
    transitionTo(undoState.preset, "undo", {
      autoTexture: false,
      transition: { type: "crossfade", durationBeats: 2 }
    });
    undoState = null;
    undoBtn.disabled = true;
  });

  regenBtn.addEventListener("click", () => {
    if (!lastPlanPrompt) return;
    aiInput.value = lastPlanPrompt;
    void previewAndApplyPrompt(lastPlanPrompt, { autoApply: false, regenerate: true });
  });

  genTexBtn.addEventListener("click", async () => {
    await generateAndApplyTexture(activePreset, "manual");
  });

  loadTexUrlBtn.addEventListener("click", async () => {
    const url = textureUrlInput.value.trim();
    if (!url) return;
    await fetchAndApplyTextureUrl(url, pendingApplyToken);
  });

  openCaptureBtn.addEventListener("click", () => {
    window.open(`${BRAIN_HTTP}/`, "_blank", "noopener,noreferrer");
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

  function clamp01(x: number) {
    return Math.max(0, Math.min(1, x));
  }

  function smoothstep01(x: number) {
    const t = clamp01(x);
    return t * t * (3 - 2 * t);
  }

  function avgSpectrum(start: number, end: number) {
    const s = Math.max(0, start | 0);
    const e = Math.max(s + 1, end | 0);
    let sum = 0;
    let count = 0;
    for (let i = s; i < e && i < spectrum.length; i++) {
      sum += spectrum[i] ?? 0;
      count++;
    }
    return count ? sum / count : 0;
  }

  function applyAudioMappings() {
    runtimeParams.textureStrength = currentParams.textureStrength;
    runtimeParams.warpStrength = currentParams.warpStrength;
    runtimeParams.strobeStrength = currentParams.strobeStrength;
    runtimeParams.brightness = currentParams.brightness;
    runtimeParams.grainStrength = currentParams.grainStrength;

    if (!currentMappings.length) {
      renderer.setUserParams(runtimeParams);
      return;
    }

    const bass = avgSpectrum(0, 10);
    const mid = avgSpectrum(10, 28);
    const treble = avgSpectrum(28, 64);
    const bpm01 = clamp01((bpm - 60) / 120);
    const section01 =
      lastSection === "Drop"
        ? 1
        : lastSection === "Build"
          ? 0.7
          : lastSection === "Break"
            ? 0.25
            : lastSection === "Intro" || lastSection === "Outro"
              ? 0.2
              : 0;

    for (const m of currentMappings) {
      const target = coerceParamKey(m.targetParam);
      if (!target) continue;

      let src = 0;
      if (m.source === "energy") src = energy;
      else if (m.source === "beat") src = beatPulse;
      else if (m.source === "bpm") src = bpm01;
      else if (m.source === "spectrum.bass") src = bass;
      else if (m.source === "spectrum.mid") src = mid;
      else if (m.source === "spectrum.treble") src = treble;
      else if (m.source === "genre") src = genreProb;
      else if (m.source === "mood") src = moodArousal;
      else if (m.source === "section") src = section01;

      let curved = clamp01(src);
      if (m.curve === "exp") curved = Math.pow(curved, 2.2);
      else if (m.curve === "smoothstep") curved = smoothstep01(curved);

      const scaled = curved * m.scale + m.bias;
      const clamped = Math.max(m.clamp[0], Math.min(m.clamp[1], scaled));
      runtimeParams[target] = clampParam(target, clamped);
    }

    renderer.setUserParams(runtimeParams);
  }

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
      const spec = transitionSpec;
      const dur =
        spec?.durationMs != null
          ? Math.max(0.05, spec.durationMs / 1000)
          : spec?.durationBeats != null
            ? Math.max(0.05, beatSec * spec.durationBeats)
            : Math.max(0.35, beatSec * 2);
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
        transitionSpec = null;
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

    applyAudioMappings();

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

  function setPillState(pill: HTMLElement, dotEl: HTMLElement, kind: "ok" | "warn" | "demo", text: string) {
    dotEl.classList.toggle("ok", kind === "ok");
    dotEl.classList.toggle("warn", kind === "warn");
    dotEl.classList.toggle("demo", kind === "demo");
    pill.lastChild!.textContent = text;
  }

  function appendChatMessage(role: "user" | "assistant" | "system", content: string) {
    const msg = el("div", { class: `chatMsg ${role}` }, [
      el("div", { class: "chatRole" }, [role]),
      el("div", { class: "chatContent" }, [content])
    ]);
    chatLog.appendChild(msg);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function renderPlan(plan: VisualPlan | null) {
    planPre.textContent = plan ? JSON.stringify(plan, null, 2) : "";
    applyPlanBtn.disabled = !plan;
    applyPaletteBtn.disabled = !plan?.patch.palette;
    applyPresetBtn.disabled = !plan?.patch.presetId;
    regenBtn.disabled = !lastPlanPrompt;
  }

  function buildFallbackPlan(prompt: string): VisualPlan {
    const mapped = mapPromptToPreset(prompt);
    const patch: VisualPlan["patch"] = {
      presetId: mapped.presetId,
      palette: mapped.palette,
      texturePrompt: mapped.texturePrompt
    };

    const texturePrompt = mapped.texturePrompt
      ? `${mapped.texturePrompt}, seamless tileable texture, high detail, cohesive pattern`
      : null;
    const assetRequests: AssetRequest[] = texturePrompt
      ? [
          {
            type: "texture",
            prompt: texturePrompt,
            size: 768,
            format: "png",
            tiling: true,
            safety: { allowNSFW: false },
            modelHint: "auto"
          }
        ]
      : [];

    return {
      assistantMessage: "Offline fallback: applied keyword mapping.",
      patch,
      assetRequests,
      apply: { timing: "nextBeat", transition: { type: "beatCrossfade", durationBeats: 2 } },
      confidence: 0.35,
      warnings: ["AI service unavailable; used offline mapper."]
    };
  }

  async function requestPlan(prompt: string): Promise<{ plan: VisualPlan; backend: "brain" | "fallback" }> {
    const body = {
      messages: [{ role: "user", content: prompt }],
      state: {
        currentPresetId: activePreset.id,
        currentPalette: activePreset.palette,
        renderer: "backend" in renderer ? renderer.backend : "WebGPU"
      },
      capabilities: {
        presets: PRESETS.map((p) => ({ id: p.id, name: p.name })),
        assetTypes: ["texture", "lut", "envmap", "keyframe"],
        paramSchema: aiParamSchema()
      },
      musicContext: {
        bpm,
        energy,
        section: lastSection || undefined
      }
    };

    try {
      const res = await fetch(`${BRAIN_HTTP}/api/ai/interpret`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`brain /api/ai/interpret ${res.status}`);
      const json = (await res.json()) as unknown;
      const plan = safeParseVisualPlan(json);
      if (!plan) throw new Error("Invalid VisualPlan from Brain");
      return { plan, backend: "brain" };
    } catch {
      return { plan: buildFallbackPlan(prompt), backend: "fallback" };
    }
  }

  async function previewAndApplyPrompt(
    prompt: string,
    opts: { autoApply: boolean; regenerate?: boolean }
  ) {
    const trimmed = prompt.trim();
    if (!trimmed) return;

    lastPlanPrompt = trimmed;
    appendChatMessage("user", trimmed);

    const { plan, backend } = await requestPlan(trimmed);
    lastPlan = plan;
    renderPlan(lastPlan);

    if (backend === "brain") {
      const warns = plan.warnings?.join(" | ").toLowerCase() ?? "";
      if (warns.includes("cloud llm failed")) {
        setPillState(aiPill, aiDot, "warn", "AI: cloud fallback");
      } else if (warns.includes("cloud llm not configured")) {
        setPillState(aiPill, aiDot, "ok", "AI: local");
      } else {
        setPillState(aiPill, aiDot, "ok", aiCloudReady ? "AI: cloud" : "AI: local");
      }
    } else {
      setPillState(aiPill, aiDot, "warn", "AI: offline fallback");
    }

    appendChatMessage("assistant", plan.assistantMessage);
    if (plan.warnings?.length) {
      appendChatMessage("system", `Warnings: ${plan.warnings.join(" | ")}`);
    }

    if (opts.autoApply) {
      void applyVisualPlan(plan, "full");
    }
  }

  function buildApplySpec(plan: VisualPlan) {
    const timing = timingSelect.value as VisualPlan["apply"]["timing"];
    const beats = Math.max(1, Math.min(128, Math.floor(Number(beatsInput.value || "2"))));
    return {
      timing,
      beats: timing === "beats" ? beats : undefined,
      transition: plan.apply.transition
    } satisfies VisualPlan["apply"];
  }

  async function applyVisualPlan(plan: VisualPlan, mode: "full" | "palette" | "preset") {
    const token = ++pendingApplyToken;

    // Kick off asset generation immediately (non-blocking).
    void applyAssetRequests(plan.assetRequests, token);

    const apply = buildApplySpec(plan);
    if (apply.timing === "nextBeat") await waitForNextBeat();
    else if (apply.timing === "beats") await waitForBeats(apply.beats ?? 2);
    else if (apply.timing === "nextDrop") await waitForNextDrop();

    if (token !== pendingApplyToken) return;

    undoState = {
      preset: activePreset,
      params: { ...currentParams },
      mappings: [...currentMappings]
    };
    undoBtn.disabled = false;

    applyParamPatch(plan);

    const nextPreset = buildPresetFromPlan(plan, mode);
    transitionTo(nextPreset, "ai", { autoTexture: false, transition: apply.transition });
  }

  function applyParamPatch(plan: VisualPlan) {
    const patch = plan.patch;

    if (patch.params) {
      for (const [k, raw] of Object.entries(patch.params)) {
        const key = coerceParamKey(k);
        if (!key) continue;
        const num =
          typeof raw === "number"
            ? raw
            : typeof raw === "boolean"
              ? raw
                ? 1
                : 0
              : null;
        if (typeof num !== "number" || !Number.isFinite(num)) continue;
        currentParams[key] = clampParam(key, num);
      }
    }

    currentMappings = Array.isArray(patch.audioMappings) ? patch.audioMappings : [];
    renderer.setUserParams(currentParams);
  }

  function buildPresetFromPlan(plan: VisualPlan, mode: "full" | "palette" | "preset"): PresetSpec {
    const patch = plan.patch;

    const wantsPreset = mode !== "palette";
    const wantsPalette = mode !== "preset";

    const desiredId = wantsPreset ? patch.presetId : undefined;
    const base =
      desiredId && PRESETS.some((p) => p.id === (desiredId as PresetId))
        ? (PRESETS.find((p) => p.id === (desiredId as PresetId)) as PresetSpec)
        : activePreset;

    const palette = wantsPalette ? (patch.palette ?? base.palette) : activePreset.palette;
    const texturePrompt = wantsPalette
      ? (patch.texturePrompt ?? base.texturePrompt)
      : activePreset.texturePrompt;

    return { ...base, palette, texturePrompt };
  }

  async function applyAssetRequests(requests: AssetRequest[], token: number) {
    const texture = requests.find((r) => r.type === "texture");
    if (!texture) return;

    const seed =
      texture.seed ?? ((sessionSeed + (++aiTextureCounter + 1) * 1337 + Date.now()) & 0x7fffffff);
    const req: AssetRequest = { ...texture, seed };
    await generateAndApplyTextureRequest(req, token);
  }

  async function fetchAndApplyTextureUrl(url: string, token: number) {
    if (token !== pendingApplyToken) return;

    const myId = ++texReqId;
    loadTexUrlBtn.disabled = true;
    assetsBusy = true;
    setPillState(assetsPill, assetsDot, "warn", "Assets: fetching URL");

    try {
      const res = await fetch(`${BRAIN_HTTP}/api/assets/fetch-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, size: 768 })
      });
      if (!res.ok) throw new Error(`brain /api/assets/fetch-url ${res.status}`);
      const blob = await res.blob();

      if (token !== pendingApplyToken) return;
      if (myId !== texReqId) return; // newer request won
      await waitForNextBeat();
      if (token !== pendingApplyToken) return;
      if (myId !== texReqId) return;
      await new Promise(requestAnimationFrame);
      await renderer.setTextureFromBlob(blob);
      lastTextureAt = performance.now();

      setPillState(assetsPill, assetsDot, "ok", "Assets: ready");
    } catch {
      setPillState(assetsPill, assetsDot, "warn", "Assets: URL failed");
    } finally {
      assetsBusy = false;
      if (myId === texReqId) loadTexUrlBtn.disabled = false;
      void checkAssetsHealth();
    }
  }

  async function generateAndApplyTextureRequest(
    request: AssetRequest,
    token: number,
    opts?: { disableButton?: boolean }
  ) {
    if (token !== pendingApplyToken) return;

    const myId = ++texReqId;
    if (opts?.disableButton) genTexBtn.disabled = true;
    assetsBusy = true;
    setPillState(assetsPill, assetsDot, "warn", "Assets: queued");

    try {
      const genRes = await fetch(`${BRAIN_HTTP}/api/assets/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
      });
      if (!genRes.ok) throw new Error(`brain /api/assets/generate ${genRes.status}`);
      const genJson = (await genRes.json()) as unknown;
      const genParsed = AssetGenerateResponseSchema.safeParse(genJson);
      if (!genParsed.success) throw new Error("Invalid generate response");

      const { jobId } = genParsed.data;
      let assetId: string | undefined;
      for (;;) {
        const stRes = await fetch(`${BRAIN_HTTP}/api/assets/jobs/${jobId}`);
        if (!stRes.ok) throw new Error(`brain /api/assets/jobs ${stRes.status}`);
        const stJson = (await stRes.json()) as unknown;
        const stParsed = AssetJobStatusSchema.safeParse(stJson);
        if (!stParsed.success) throw new Error("Invalid job status response");
        const st = stParsed.data;

        if (st.status === "done") {
          assetId = st.assetId;
          break;
        }
        if (st.status === "error") {
          throw new Error(st.error || "Asset job failed");
        }

        const pct = st.progress != null ? Math.round(st.progress * 100) : null;
        setPillState(
          assetsPill,
          assetsDot,
          "warn",
          `Assets: ${st.status}${pct != null ? ` (${pct}%)` : ""}`
        );
        await new Promise((r) => setTimeout(r, 400));
      }

      if (!assetId) throw new Error("Missing assetId");
      const assetRes = await fetch(`${BRAIN_HTTP}/api/assets/${assetId}`);
      if (!assetRes.ok) throw new Error(`brain /api/assets/:assetId ${assetRes.status}`);
      const blob = await assetRes.blob();

      if (token !== pendingApplyToken) return;
      if (myId !== texReqId) return; // newer request won
      await waitForNextBeat();
      if (token !== pendingApplyToken) return;
      if (myId !== texReqId) return;
      await new Promise(requestAnimationFrame);
      await renderer.setTextureFromBlob(blob);
      lastTextureAt = performance.now();

      setPillState(assetsPill, assetsDot, "ok", "Assets: ready");
    } catch {
      assetsHealthy = false;
      setPillState(assetsPill, assetsDot, "warn", "Assets: unavailable");
    } finally {
      assetsBusy = false;
      if (opts?.disableButton && myId === texReqId) genTexBtn.disabled = false;
      void checkAssetsHealth();
    }
  }

  function transitionTo(
    preset: PresetSpec,
    _reason: string,
    opts?: { transition?: VisualPlan["apply"]["transition"]; autoTexture?: boolean }
  ) {
    const spec = opts?.transition;
    if (spec?.type === "cut") {
      targetPreset = null;
      transition = 0;
      transitionSpec = null;
      activePreset = preset;
      renderer.setPreset(activePreset);
      presetSelect.value = activePreset.id;
      if (opts?.autoTexture !== false) maybeAutoTexture(preset, "scene");
      return;
    }

    // If a custom override came from prompt, it may not exist in PRESETS; still allow.
    targetPreset = preset;
    transition = 0;
    transitionSpec = spec ?? null;
    if (!("setTransition" in renderer)) {
      // ensure at least palette changes immediately on Canvas2D
      renderer.setPreset(activePreset);
    }
    if (opts?.autoTexture !== false) maybeAutoTexture(preset, "scene");
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

    const genreBias: Partial<Record<string, Partial<Record<typeof kind, PresetId[]>>>> = {
      Techno: {
        drop: ["warp", "strobeGeo", "tunnel"],
        peak: ["warp", "strobeGrid", "strobeGeo", "tunnel"],
        break: ["nebula", "plasma"],
        build: ["tunnel", "nebula"]
      },
      House: {
        drop: ["tunnel", "plasma"],
        peak: ["tunnel", "warp", "plasma"],
        break: ["plasma", "nebula"],
        build: ["nebula", "tunnel"]
      },
      "Drum & Bass": {
        drop: ["strobeGrid", "tunnel", "warp"],
        peak: ["strobeGrid", "strobeGeo", "tunnel", "warp"],
        break: ["kaleido", "nebula"],
        build: ["tunnel", "kaleido"]
      },
      Trance: {
        drop: ["tunnel", "kaleido"],
        peak: ["kaleido", "tunnel", "nebula"],
        break: ["nebula", "kaleido"],
        build: ["kaleido", "tunnel"]
      },
      Dubstep: {
        drop: ["warp", "strobeGeo"],
        peak: ["warp", "strobeGeo", "strobeGrid"],
        break: ["nebula", "plasma"],
        build: ["nebula", "tunnel"]
      },
      "Hip-Hop": {
        drop: ["warp", "plasma"],
        peak: ["warp", "strobeGeo", "plasma"],
        break: ["plasma", "nebula"],
        build: ["nebula", "kaleido"]
      },
      Ambient: {
        drop: ["nebula", "kaleido"],
        peak: ["nebula", "kaleido", "plasma"],
        break: ["nebula", "plasma", "kaleido"],
        build: ["nebula", "kaleido"]
      }
    };

    // Add BPM bias: faster => tunnel/grid, slower => nebula/warp.
    const biased =
      bpm > 140 && kind !== "break"
        ? [...ids, "tunnel", "strobeGrid"]
        : bpm < 110
          ? [...ids, "nebula", "warp"]
          : ids;

    const g = genreTop?.trim();
    const gProb = genreProb;
    const extra = g && gProb >= 0.55 ? genreBias[g]?.[kind] : undefined;
    const weighted = extra?.length ? [...biased, ...extra] : biased;
    const id = weighted[Math.floor(Math.random() * weighted.length)]!;
    return PRESETS.find((p) => p.id === id)!;
  }

  async function checkAssetsHealth() {
    try {
      const res = await fetch(`${BRAIN_HTTP}/api/assets/health`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as any;
      const backends = data?.backends as Record<string, any> | undefined;
      assetsHealthy = Boolean(
        backends &&
          Object.values(backends).some((b) => Boolean((b as any)?.ok))
      );
    } catch {
      assetsHealthy = false;
    }

    if (!assetsBusy) {
      setPillState(
        assetsPill,
        assetsDot,
        assetsHealthy ? "ok" : "warn",
        assetsHealthy ? "Assets: ready" : "Assets: offline"
      );
    }
  }

  async function checkAiStatus() {
    try {
      const res = await fetch(`${BRAIN_HTTP}/api/ai/status`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as any;
      const interpreter = String(data?.interpreter ?? "").toLowerCase();
      const openaiConfigured = Boolean(data?.providers?.openai?.configured);
      const geminiConfigured = Boolean(data?.providers?.gemini?.configured);
      const cloudWanted =
        interpreter === "auto" || interpreter === "openai" || interpreter === "gemini";
      aiCloudReady = cloudWanted && (openaiConfigured || geminiConfigured);
      setPillState(aiPill, aiDot, "ok", aiCloudReady ? "AI: cloud" : "AI: local");
    } catch {
      aiCloudReady = null;
      setPillState(aiPill, aiDot, "warn", "AI: offline");
    }
  }

  function stopVideo() {
    videoBusy = false;
    videoFrameToken++;
    videoFramesReceived = 0;

    if (videoSource) {
      try {
        videoSource.close();
      } catch {
        // ignore
      }
      videoSource = null;
    }

    genVideoBtn.disabled = false;
    stopVideoBtn.disabled = true;
    setPillState(videoPill, videoDot, "demo", "Video: idle");
  }

  async function startVideo() {
    if (videoBusy) stopVideo();
    videoBusy = true;
    genVideoBtn.disabled = true;
    stopVideoBtn.disabled = false;
    setPillState(videoPill, videoDot, "warn", "Video: starting…");

    const toNum = (input: HTMLInputElement, fallback: number) => {
      const n = Number(String(input.value ?? "").trim());
      return Number.isFinite(n) ? n : fallback;
    };

    const prompt = promptInput.value.trim() || "abstract cinematic visuals";
    const durationSec = Math.max(0.1, Math.min(60, toNum(videoDurationInput, 2)));
    const fps = Math.max(1, Math.min(120, Math.round(toNum(videoFpsInput, 24))));
    const baseFps = Math.max(1, Math.min(fps, Math.round(toNum(videoBaseFpsInput, 4))));

    const req = {
      prompt,
      durationSec,
      baseFps,
      fps,
      size: { w: 1280, h: 720 },
      format: "jpg",
      bpm,
      energy,
      backendHint: videoBackendSelect.value
    };

    try {
      const res = await fetch(`${BRAIN_HTTP}/api/video/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req)
      });
      if (!res.ok) throw new Error(`brain /api/video/generate ${res.status}`);
      const json = (await res.json()) as unknown;
      const parsed = VideoGenerateResponseSchema.safeParse(json);
      if (!parsed.success) throw new Error("Invalid video generate response");

      const { jobId } = parsed.data;

      const videoPreset = PRESETS.find((p) => p.id === "aiVideo");
      if (videoPreset) {
        transitionTo(videoPreset, "video", {
          transition: { type: "cut" },
          autoTexture: false
        });
      }

      const token = ++videoFrameToken;
      videoFramesReceived = 0;

      const es = new EventSource(`${BRAIN_HTTP}/api/video/jobs/${jobId}/stream`);
      videoSource = es;

      const fetchLatestFrame = async (url: string) => {
        const r = await fetch(`${BRAIN_HTTP}${url}`);
        if (!r.ok) throw new Error(`frame fetch ${r.status}`);
        const blob = await r.blob();
        if (token !== videoFrameToken) return;
        await renderer.setTextureFromBlob(blob, { immediate: true });
        videoFramesReceived++;
        setPillState(videoPill, videoDot, "warn", `Video: streaming (${videoFramesReceived})`);
      };

      es.addEventListener("frame", (ev) => {
        if (token !== videoFrameToken) return;
        const data = (ev as MessageEvent).data;
        let obj: unknown;
        try {
          obj = JSON.parse(String(data ?? ""));
        } catch {
          return;
        }
        const f = VideoFrameMetaSchema.safeParse(obj);
        if (!f.success) return;
        void fetchLatestFrame(f.data.url);
      });

      es.addEventListener("status", (ev) => {
        if (token !== videoFrameToken) return;
        const data = (ev as MessageEvent).data;
        let obj: unknown;
        try {
          obj = JSON.parse(String(data ?? ""));
        } catch {
          return;
        }
        const st = VideoJobStatusSchema.safeParse(obj);
        if (!st.success) return;

        if (st.data.status === "done") {
          setPillState(videoPill, videoDot, "ok", `Video: done (${videoFramesReceived})`);
          genVideoBtn.disabled = false;
          stopVideoBtn.disabled = true;
          videoBusy = false;
          try {
            es.close();
          } catch {
            // ignore
          }
          if (videoSource === es) videoSource = null;
          return;
        }

        if (st.data.status === "error") {
          setPillState(videoPill, videoDot, "warn", `Video: error${st.data.error ? ` (${st.data.error})` : ""}`);
          genVideoBtn.disabled = false;
          stopVideoBtn.disabled = true;
          videoBusy = false;
          try {
            es.close();
          } catch {
            // ignore
          }
          if (videoSource === es) videoSource = null;
        }
      });

      es.onerror = () => {
        if (token !== videoFrameToken) return;
        setPillState(videoPill, videoDot, "warn", "Video: stream error");
      };
    } catch {
      setPillState(videoPill, videoDot, "warn", "Video: unavailable");
      genVideoBtn.disabled = false;
      stopVideoBtn.disabled = true;
      videoBusy = false;
      if (videoSource) {
        try {
          videoSource.close();
        } catch {
          // ignore
        }
        videoSource = null;
      }
    }
  }

  function buildTexturePrompt(preset: PresetSpec) {
    const fromInput = promptInput.value.trim();
    const p = (fromInput || preset.texturePrompt || preset.name).trim();
    // Bias toward seamless/cohesive detail, since it drives shader/warp sampling.
    return `${p}, seamless tileable texture, high detail, cohesive pattern`;
  }

  function maybeAutoTexture(preset: PresetSpec, reason: "scene" | "drop") {
    if (!autoTextureToggle.checked) return;
    const now = performance.now();
    if (reason === "drop" && now - lastTextureAt < 6500) return;
    if (assetsHealthy === false) return;
    // Let health check settle; if unknown, we still try once.
    void generateAndApplyTexture(preset, reason);
  }

  async function generateAndApplyTexture(preset: PresetSpec, _reason: "scene" | "drop" | "manual") {
    const prompt = buildTexturePrompt(preset);
    if (!prompt) return;

    textureCounter++;
    const seed =
      (sessionSeed + (textureCounter + 1) * 1013 + Math.floor(performance.now())) &
      0x7fffffff;

    const req: AssetRequest = {
      type: "texture",
      prompt,
      size: 768,
      seed,
      format: "png",
      tiling: true,
      safety: { allowNSFW: false },
      modelHint: "auto"
    };

    await generateAndApplyTextureRequest(req, pendingApplyToken, {
      disableButton: _reason === "manual"
    });
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
