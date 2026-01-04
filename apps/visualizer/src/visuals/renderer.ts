import type { Palette, PresetSpec } from "./presets.js";

type RenderState = {
  time: number;
  bpm: number;
  energy: number;
  beat: number;
  spectrum: Float32Array;
};

type TransitionState = {
  modeA: number;
  modeB: number;
  blend: number;
  dropPulse: number;
  palette: Palette;
};

export class WebGpuRenderer {
  readonly backend = "WebGPU";
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline;
  private paramsBuffer: GPUBuffer;
  private spectrumBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;

  private params = new Float32Array(8 * 4); // 8 vec4s
  private spectrum = new Float32Array(64);

  private texture: GPUTexture;
  private sampler: GPUSampler;
  private textureView: GPUTextureView;

  private preset: PresetSpec | null = null;
  private transitionState: TransitionState | null = null;
  private seed = 0;

  // Nebula morph (vibe-synced fractal shape changes)
  private rngState = 1 >>> 0;
  private lastTime = 0;
  private dprCap = 2;

  // Beat flow (smooth beat-synced 0..1 wave; used to avoid harsh flashing in nebula mode)
  private beatClock = 0;
  private beatPeriod = 0.5;
  private prevBeatPulseForFlow = 0;

  private prevBeat = 0;
  private prevDropPulse = 0;
  private beatCount = 0;
  private nextNebulaBeat = 0;
  private lastNebulaChange = 0;
  private nebulaFrom = new Float32Array([0.5, 0.5, 0.5, 0.5]);
  private nebulaTo = new Float32Array([0.5, 0.5, 0.5, 0.5]);
  private nebulaShape = new Float32Array([0.5, 0.5, 0.5, 0.5]);
  private nebulaMorph = 1;
  private nebulaMorphDur = 1;
  private nebulaInitialized = false;

  static async create(canvas: HTMLCanvasElement) {
    if (!navigator.gpu) throw new Error("WebGPU not available in this browser");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No WebGPU adapter");
    const device = await adapter.requestDevice();

    const format = navigator.gpu.getPreferredCanvasFormat();
    await WebGpuRenderer.assertWebGpuHealthy(device, format);

    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Failed to get webgpu context");
    context.configure({ device, format, alphaMode: "premultiplied" });

    return new WebGpuRenderer(device, context, format);
  }

  private constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat) {
    this.device = device;
    this.context = context;
    this.format = format;

    const shader = device.createShaderModule({ code: wgsl });

    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shader,
        entryPoint: "vsMain"
      },
      fragment: {
        module: shader,
        entryPoint: "fsMain",
        targets: [{ format }]
      },
      primitive: { topology: "triangle-list" }
    });

    this.paramsBuffer = device.createBuffer({
      size: this.params.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.spectrumBuffer = device.createBuffer({
      size: this.spectrum.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    // 1x1 fallback texture
    this.texture = device.createTexture({
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    device.queue.writeTexture(
      { texture: this.texture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 }
    );
    this.textureView = this.texture.createView();
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear"
    });

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.spectrumBuffer } },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: this.textureView }
      ]
    });

    const ro = new ResizeObserver(() => this.resizeToClientSize());
    ro.observe(this.context.canvas as HTMLCanvasElement);
    this.resizeToClientSize();
  }

  setPreset(preset: PresetSpec) {
    this.preset = preset;
    this.applyPalette(preset.palette);
    this.transitionState = {
      modeA: preset.mode,
      modeB: preset.mode,
      blend: 0,
      dropPulse: 0,
      palette: preset.palette
    };
  }

  setSeed(seed: number) {
    this.seed = ((seed | 0) >>> 0) % 1_000_000;
    this.rngState = (this.seed || 1) >>> 0;
    this.nebulaInitialized = false;
  }

  setTransition(a: PresetSpec, b: PresetSpec, blend: number, dropPulse: number) {
    const palette = mixPalette(a.palette, b.palette, blend);
    this.transitionState = {
      modeA: a.mode,
      modeB: b.mode,
      blend,
      dropPulse,
      palette
    };
    this.applyPalette(palette);
  }

  async setTextureFromBase64Png(pngBase64: string) {
    const bin = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([bin], { type: "image/png" });
    const bmp = await createImageBitmap(blob);
    const tex = this.device.createTexture({
      size: [bmp.width, bmp.height, 1],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT
    });
    this.device.queue.copyExternalImageToTexture(
      { source: bmp },
      { texture: tex },
      { width: bmp.width, height: bmp.height }
    );
    this.texture.destroy();
    this.texture = tex;
    this.textureView = tex.createView();

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.spectrumBuffer } },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: this.textureView }
      ]
    });
  }

  render(state: RenderState) {
    const canvas = this.context.canvas as HTMLCanvasElement;

    // params vec4 packing:
    // v0: (w, h, time, modeA)
    // v1: (bpm, energy, beat, modeB)
    // v2: (blend, dropPulse, intensity, seed)
    // v3: (nebulaShape.x, nebulaShape.y, nebulaShape.z, nebulaShape.w)
    const modeA = this.transitionState?.modeA ?? this.preset?.mode ?? 0;
    const modeB = this.transitionState?.modeB ?? this.preset?.mode ?? 0;
    const nebulaVisible = modeA >= 4.5 || modeB >= 4.5;
    const desiredDprCap = nebulaVisible ? 1.5 : 2;
    if (this.dprCap !== desiredDprCap) {
      this.dprCap = desiredDprCap;
      this.resizeToClientSize();
    }
    const w = canvas.width;
    const h = canvas.height;
    this.params[0] = w;
    this.params[1] = h;
    this.params[2] = state.time;
    this.params[3] = modeA;
    this.params[4] = state.bpm;
    this.params[5] = state.energy;
    this.params[7] = modeB;

    const low = avg(state.spectrum, 0, 10);
    const mid = avg(state.spectrum, 10, 28);
    const high = avg(state.spectrum, 28, 64);
    const intensity = clamp01(state.energy * state.energy * 0.8 + high * 0.35 + mid * 0.15);

    this.params[8] = this.transitionState?.blend ?? 0;
    const dropPulse = this.transitionState?.dropPulse ?? 0;
    this.params[9] = dropPulse;
    this.params[10] = intensity;
    this.params[11] = this.seed;

    // Nebula shape morphing follows the track's "vibe": denser/faster changes at high intensity.
    const dt = this.lastTime ? Math.min(0.1, Math.max(0, state.time - this.lastTime)) : 0;
    this.lastTime = state.time;
    const vibe = clamp01(0.55 * intensity + 0.25 * high + 0.2 * clamp01(state.energy));
    const beatPulse = clamp01(state.beat);
    const beatFlow = this.updateBeatFlow(dt, state.bpm, beatPulse);
    this.updateNebulaShape({
      time: state.time,
      dt,
      bpm: state.bpm,
      beat: beatPulse,
      dropPulse: clamp01(dropPulse),
      vibe,
      nebulaVisible
    });
    const beatForShader = nebulaVisible ? beatFlow : beatPulse;
    this.params[6] = beatForShader;
    this.params[12] = this.nebulaShape[0] ?? 0.5;
    this.params[13] = this.nebulaShape[1] ?? 0.5;
    this.params[14] = this.nebulaShape[2] ?? 0.5;
    this.params[15] = this.nebulaShape[3] ?? 0.5;

    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);

    const n = Math.min(state.spectrum.length, this.spectrum.length);
    for (let i = 0; i < n; i++) this.spectrum[i] = state.spectrum[i] ?? 0;
    this.device.queue.writeBuffer(this.spectrumBuffer, 0, this.spectrum);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 }
        }
      ]
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private updateBeatFlow(dt: number, bpm: number, beatPulse: number) {
    const onset = beatPulse > 0.85 && this.prevBeatPulseForFlow <= 0.85;
    this.prevBeatPulseForFlow = beatPulse;

    const bpmPeriod = 60 / Math.max(1, bpm);
    if (!(this.beatPeriod > 0) || !Number.isFinite(this.beatPeriod)) this.beatPeriod = bpmPeriod;

    if (dt > 0 && Number.isFinite(dt)) this.beatClock += dt;

    if (onset) {
      const measured = this.beatClock || bpmPeriod;
      const minP = Math.max(0.15, bpmPeriod * 0.5);
      const maxP = Math.min(2.5, bpmPeriod * 2.0);
      const clamped = Math.max(minP, Math.min(maxP, measured));
      this.beatPeriod = this.beatPeriod * 0.8 + clamped * 0.2;
      this.beatClock = 0;
    } else if (dt > 0) {
      // Slowly drift toward the current BPM estimate when beats are missing.
      const relax = 1 - Math.exp(-dt * 0.5);
      this.beatPeriod = this.beatPeriod + (bpmPeriod - this.beatPeriod) * relax;
    }

    // Cosine wave keeps continuity across phase wrap (no "flash" on reset).
    const phase = this.beatPeriod > 0 ? this.beatClock / this.beatPeriod : 0;
    const frac = phase - Math.floor(phase);
    return clamp01(0.5 + 0.5 * Math.cos(frac * Math.PI * 2));
  }

  private resizeToClientSize() {
    const canvas = this.context.canvas as HTMLCanvasElement;
    const dpr = Math.min(devicePixelRatio, this.dprCap);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "premultiplied"
    });
  }

  private applyPalette(palette: Palette) {
    const write = (offsetVec4: number, rgb: [number, number, number]) => {
      const i = offsetVec4 * 4;
      this.params[i + 0] = rgb[0];
      this.params[i + 1] = rgb[1];
      this.params[i + 2] = rgb[2];
      this.params[i + 3] = 1;
    };
    write(4, palette.a);
    write(5, palette.b);
    write(6, palette.c);
    write(7, palette.d);
  }

  private rand01() {
    // xorshift32
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = (x >>> 0) || 1;
    return (this.rngState >>> 0) / 4294967296;
  }

  private randomNebulaTarget(vibe: number, punch: number) {
    const jitter = 0.35 + 0.65 * punch;
    const r = () => this.rand01();
    const j = () => (r() - 0.5) * 2;

    // v3 is intentionally normalized (0..1) so the shader can remap as it likes.
    const detail = clamp01(0.25 + vibe * 0.6 + j() * 0.28 * jitter);
    const warp = clamp01(0.15 + vibe * 0.75 + j() * 0.34 * jitter);
    const swirl = clamp01(0.5 + j() * 0.45 * jitter);
    const structure = clamp01(0.1 + vibe * 0.7 + j() * 0.32 * jitter);
    return new Float32Array([detail, warp, swirl, structure]);
  }

  private updateNebulaShape(args: {
    time: number;
    dt: number;
    bpm: number;
    beat: number;
    dropPulse: number;
    vibe: number;
    nebulaVisible: boolean;
  }) {
    const { time, dt, bpm, beat, dropPulse, vibe, nebulaVisible } = args;

    const dropBoost = clamp01(dropPulse);
    const beatsPerChange = Math.max(1, Math.round(6 - vibe * 4 - dropBoost * 2));
    if (!this.nebulaInitialized) {
      const init = this.randomNebulaTarget(vibe, 0.4);
      this.nebulaFrom.set(init);
      this.nebulaTo.set(init);
      this.nebulaShape.set(init);
      this.nebulaMorph = 1;
      this.nebulaMorphDur = 1;
      this.nebulaInitialized = true;
      this.beatCount = 0;
      this.nextNebulaBeat = beatsPerChange;
      this.lastNebulaChange = time;
      this.prevBeat = beat;
      this.prevDropPulse = dropPulse;
      return;
    }

    const beatOnset = beat > 0.85 && this.prevBeat <= 0.85;
    this.prevBeat = beat;
    if (beatOnset) this.beatCount++;

    const dropOnset = dropPulse > 0.65 && this.prevDropPulse <= 0.65;
    this.prevDropPulse = dropPulse;

    const sinceLast = time - this.lastNebulaChange;
    const fallbackInterval = (8 - vibe * 5) * (1 - dropBoost * 0.35); // seconds (~2..8)

    let trigger = false;
    let punch = 0.4;
    if (nebulaVisible && dropOnset) {
      trigger = true;
      punch = 1.0;
    } else if (nebulaVisible && beatOnset && this.beatCount >= this.nextNebulaBeat) {
      trigger = true;
      punch = 0.35 + 0.45 * vibe + 0.25 * dropBoost;
    } else if (nebulaVisible && sinceLast > fallbackInterval) {
      trigger = true;
      punch = 0.3 + 0.35 * vibe + 0.15 * dropBoost;
    }

    if (trigger) {
      this.nebulaFrom.set(this.nebulaShape);
      this.nebulaTo.set(this.randomNebulaTarget(vibe, punch));
      this.nebulaMorph = 0;
      const beatSec = 60 / Math.max(1, bpm);
      const baseDur = beatSec * (2.1 - vibe * 0.9);
      this.nebulaMorphDur = Math.max(0.22, baseDur * (1 - dropBoost * 0.45));
      this.lastNebulaChange = time;
      this.nextNebulaBeat = this.beatCount + beatsPerChange;
    }

    if (this.nebulaMorph >= 1 || dt <= 0) return;

    this.nebulaMorph = Math.min(1, this.nebulaMorph + dt / Math.max(0.001, this.nebulaMorphDur));
    const t = this.nebulaMorph;
    const u = t * t * (3 - 2 * t); // smoothstep
    for (let i = 0; i < 4; i++) {
      this.nebulaShape[i] = this.nebulaFrom[i]! + (this.nebulaTo[i]! - this.nebulaFrom[i]!) * u;
    }
  }

  private static async assertWebGpuHealthy(device: GPUDevice, format: GPUTextureFormat) {
    // Detect shader compilation errors early so the renderer factory can fall back to Canvas2D.
    const testShader = device.createShaderModule({ code: wgsl });
    const info = await testShader.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length) {
      const formatted = errors
        .map((m) => `${m.lineNum}:${m.linePos} ${m.message}`)
        .join("\n");
      throw new Error(`WGSL compile error:\n${formatted}`);
    }

    device.pushErrorScope("validation");
    device.createRenderPipeline({
      layout: "auto",
      vertex: { module: testShader, entryPoint: "vsMain" },
      fragment: {
        module: testShader,
        entryPoint: "fsMain",
        targets: [{ format }]
      },
      primitive: { topology: "triangle-list" }
    });
    const err = await device.popErrorScope();
    if (err) throw new Error(`WebGPU validation error: ${err.message}`);
  }
}

const wgsl = /* wgsl */ `
struct Params {
  v0: vec4<f32>, // (w,h,time,mode)
  v1: vec4<f32>, // (bpm, energy, beat, _)
  v2: vec4<f32>, // (blend, dropPulse, intensity, seed)
  v3: vec4<f32>, // (nebulaShape0..3)
  palA: vec4<f32>,
  palB: vec4<f32>,
  palC: vec4<f32>,
  palD: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> spectrum: array<f32, 64>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var tex: texture_2d<f32>;

@vertex
fn vsMain(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  return vec4<f32>(pos[idx], 0.0, 1.0);
}

fn palette(t: f32) -> vec3<f32> {
  let a = params.palA.xyz;
  let b = params.palB.xyz;
  let c = params.palC.xyz;
  let d = params.palD.xyz;
  return a + b * cos(6.28318 * (c * t + d));
}

fn hash21(p: vec2<f32>) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7)) + params.v2.w * 0.017;
  return fract(sin(h) * 43758.5453);
}

fn noise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  let u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

fn spectrumEnergy() -> f32 {
  var sum = 0.0;
  for (var i = 0u; i < 64u; i = i + 1u) {
    sum = sum + spectrum[i];
  }
  return sum / 64.0;
}

fn spectrumBand(start: u32, endExclusive: u32) -> f32 {
  var sum = 0.0;
  var count = 0.0;
  var i = start;
  loop {
    if (i >= endExclusive) { break; }
    sum = sum + spectrum[i];
    count = count + 1.0;
    i = i + 1u;
  }
  return sum / max(1.0, count);
}

fn rotate2(p: vec2<f32>, a: f32) -> vec2<f32> {
  let c = cos(a);
  let s = sin(a);
  return vec2<f32>(c * p.x - s * p.y, s * p.x + c * p.y);
}

fn triWave(x: f32) -> f32 {
  return abs(fract(x) - 0.5) * 2.0;
}

fn sdEquilateralTriangle(pIn: vec2<f32>, r: f32) -> f32 {
  let k = 1.7320508; // sqrt(3)
  var p = vec2<f32>(abs(pIn.x), pIn.y);
  p.x = p.x - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) {
    p = vec2<f32>(p.x - k * p.y, -k * p.x - p.y) * 0.5;
  }
  p.x = p.x - clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

fn shapeSdf(kind: i32, p: vec2<f32>, r: f32) -> f32 {
  if (kind == 0) {
    // square
    return max(abs(p.x), abs(p.y)) - r;
  } else if (kind == 1) {
    // circle
    return length(p) - r;
  } else if (kind == 2) {
    // triangle
    return sdEquilateralTriangle(p, r * 1.22);
  } else {
    // diamond (rotated square)
    return (abs(p.x) + abs(p.y)) - (r * 1.32);
  }
}

fn scene(mode: f32, uv: vec2<f32>, time: f32, bpm: f32, energy: f32, beat: f32, texc: vec3<f32>, low: f32, mid: f32, high: f32, intensity: f32) -> vec3<f32> {
  var col = vec3<f32>(0.0);

  if (mode < 0.5) {
    // Plasma bloom (upgraded: domain warping + spectrum shimmer)
    var p = uv * (2.2 + energy * 1.8);
    p = p + vec2<f32>(sin(p.y * 1.7 + time * 0.9), cos(p.x * 1.3 - time * 0.7)) * (0.25 + intensity * 0.55);
    let n = noise(p * 1.2 + vec2<f32>(time * 0.6, -time * 0.35));
    let v = sin(p.x + time * 1.2) + sin(p.y * 1.3 - time) + sin((p.x + p.y) * 0.7 + time * 0.8);
    let k = 0.5 + 0.5 * sin(v + n * (3.0 + high * 2.0));
    col = palette(k + energy * 0.18 + (mid + high) * 0.25);
    col = col + beat * vec3<f32>(0.9, 0.6, 0.8);
  } else if (mode < 1.5) {
    // Neon tunnel (upgraded: speed + chroma + glitch stripes)
    let speed = (bpm / 60.0) * (0.28 + intensity * 0.55);
    let t = time * speed;
    let r = length(uv);
    let a = atan2(uv.y, uv.x);
    let z = 1.0 / max(0.12, r);
    let wob = sin(t * 1.8 + z * 0.8) * (0.1 + intensity * 0.35);
    let w = vec2<f32>((a / 6.28318) + wob, z * 0.11 + t * 0.28);
    let tex2 = textureSample(tex, samp, fract(w)).xyz;
    let rings = sin(z * (6.0 + mid * 10.0) + t * (5.0 + high * 8.0)) * 0.5 + 0.5;
    let grid = smoothstep(0.93, 1.0, sin((a * (8.0 + low * 10.0) + z * 2.0) + t * 2.0) * 0.5 + 0.5);
    let k = rings * 0.65 + grid * 0.35 + energy * 0.2;
    col = palette(k + (low + high) * 0.25);
    col = mix(col, col * tex2 * 1.7, 0.52);
    // micro chromatic wobble
    col = col + (texc - 0.5) * 0.25 * (0.3 + intensity);
    col = col + beat * vec3<f32>(1.2, 1.0, 0.4);
  } else if (mode < 2.5) {
    // Kaleidoscope (upgraded: deeper symmetry + texture folding)
    var p = uv;
    let m = 8.0 + floor(low * 6.0);
    let ang = atan2(p.y, p.x);
    let rad = length(p);
    let seg = 6.28318 / m;
    let ang2 = abs(fract((ang + seg * 0.5) / seg) * seg - seg * 0.5);
    p = vec2<f32>(cos(ang2), sin(ang2)) * rad;
    p = rotate2(p, sin(time * 0.35) * 0.15);
    p = p * (1.9 + energy * 2.2);
    let n = noise(p * 1.4 + vec2<f32>(-time * 0.4, time * 0.6));
    let tex2 = textureSample(tex, samp, fract(p * 0.09 + 0.5)).xyz;
    let k = 0.55 + 0.45 * sin((7.0 + high * 10.0) * rad - time * 2.0 + n * (2.5 + mid * 3.0));
    col = palette(k + (mid + high) * 0.22);
    col = mix(col, col * tex2 * 1.55, 0.48);
    col = col + beat * vec3<f32>(0.6, 1.0, 0.7);
  } else if (mode < 3.5) {
    // Warp Cathedral (ray-marched repeating arches)
    let speed = (bpm / 60.0) * (0.18 + intensity * 0.65);
    let t = time * speed;
    var ro = vec3<f32>(0.0, 0.0, -2.6);
    ro.x = sin(t * 0.6) * (0.35 + intensity * 0.6);
    ro.y = cos(t * 0.45) * (0.18 + intensity * 0.35);
    let rd = normalize(vec3<f32>(uv, 1.45));

    // distance field
    var total = 0.0;
    var glow = 0.0;
    var hit = 0.0;
    var p3 = ro;
    for (var i = 0u; i < 72u; i = i + 1u) {
      p3 = ro + rd * total;
      // repeat in z
      p3.z = p3.z + t * 2.0;
      let cell = floor(p3.z);
      let zf = fract(p3.z) - 0.5;
      // arch: cylinders + box
      let q = vec3<f32>(p3.x, p3.y, zf);
      q.x = abs(q.x);
      let box = max(max(q.x - (0.55 + low * 0.25), abs(q.y) - (0.22 + energy * 0.18)), abs(q.z) - 0.36);
      let cyl = length(vec2<f32>(q.x - 0.3, q.y)) - (0.18 + mid * 0.12);
      let d = min(box, cyl);
      d = d - 0.02 - beat * 0.04;
      glow = glow + 0.06 / max(0.02, abs(d));
      if (d < 0.001) { hit = 1.0; break; }
      total = total + d * (0.55 + intensity * 0.25);
      if (total > 9.0) { break; }
    }

    let fog = exp(-total * (0.18 + intensity * 0.12));
    let base = palette(0.25 + mid * 0.35 + sin(t * 0.2) * 0.1);
    col = base * (0.25 + 0.85 * fog);
    col = col + glow * palette(0.7 + high * 0.25) * (0.05 + intensity * 0.22);
    col = col + hit * (0.6 + 0.4 * beat) * palette(0.9);
  } else if (mode < 4.5) {
    if (mode < 4.25) {
      // Strobe Grid (classic)
      let speed = (bpm / 60.0) * (0.25 + intensity * 0.75);
      let t = time * speed;
      let p = uv * (3.0 + intensity * 4.0);
      let gx = abs(fract(p.x + sin(t * 0.5) * 0.2) - 0.5);
      let gy = abs(fract(p.y + cos(t * 0.45) * 0.2) - 0.5);
      let g = 1.0 - smoothstep(0.46 - high * 0.1, 0.5, min(gx, gy));
      let stripes = smoothstep(0.9, 1.0, sin((p.y * 7.0 + t * 4.0) + sin(p.x * 2.0)) * 0.5 + 0.5);
      let strobe = smoothstep(0.6, 1.0, beat + intensity * 0.25);
      let k = g * 0.75 + stripes * 0.25;
      col = palette(k + mid * 0.35);
      col = col * (0.25 + 1.6 * strobe);
      col = col + (texc - 0.5) * 0.35 * (0.2 + intensity);
    } else {
      // Strobe Geometry (triangular background + beat-morphing shapes)
      let speed = (bpm / 60.0) * (0.22 + intensity * 0.9);
      let t = time * speed;

      let scale = 3.0 + intensity * 4.2;
      let p = uv * scale;

      // Triangular facets background (no wavy scanlines)
      let bgp = p * 0.9 + vec2<f32>(t * 0.55, -t * 0.35);
      let tt0 = triWave(bgp.x + 0.13 * sin(t * 0.6));
      let tt1 = triWave(bgp.x * 0.5 + bgp.y * 0.8660254 + t * 0.17);
      let tt2 = triWave(-bgp.x * 0.5 + bgp.y * 0.8660254 - t * 0.14);
      let tri = max(tt0, max(tt1, tt2));
      let triLines = smoothstep(0.84 - high * 0.1, 0.985, tri);
      let facet = (tt0 + tt1 + tt2) / 3.0;

      let cell = floor(p);
      let fu = fract(p) - vec2<f32>(0.5, 0.5);
      var f = fu;

      // per-cell rotation + beat twist
      let h = hash21(cell);
      f = rotate2(f, (h - 0.5) * (0.55 + intensity * 0.9) + beat * 0.45);

      let pulse = pow(clamp(beat + intensity * 0.12, 0.0, 1.0), 0.35);

      // Cycle shapes on the beat: square -> circle -> triangle -> diamond -> ...
      let beatPos = time * (bpm / 60.0);
      let beatIdx = floor(beatPos);
      let beatPhase = fract(beatPos);
      let kindOffset = i32(params.v2.w) % 4;
      let kindA = (i32(beatIdx) + kindOffset) % 4;
      let kindB = (kindA + 1) % 4;
      let m = beatPhase * beatPhase * (3.0 - 2.0 * beatPhase);

      // Expand on beat
      let r = 0.16 + 0.09 * intensity + pulse * 0.26;
      let dA = shapeSdf(kindA, f, r);
      let dB = shapeSdf(kindB, f, r);
      let d = mix(dA, dB, m);

      let edge = 0.01 + 0.014 * (0.6 + intensity);
      let fill = 1.0 - smoothstep(0.0, edge, d);
      let outline = 1.0 - smoothstep(edge, edge * 3.2, abs(d));

      let frame = smoothstep(0.475 - high * 0.04, 0.5, max(abs(fu.x), abs(fu.y)));
      let strobe = smoothstep(0.25, 1.0, pulse + intensity * 0.25);

      let k = fract(facet * 0.85 + h * 0.35 + mid * 0.22 + time * 0.02);
      col = palette(k + mid * 0.2) * (0.06 + 0.22 * triLines);
      col = col + palette(k + 0.35 + high * 0.15) * (0.12 + 1.6 * strobe) * (outline * 0.95 + fill * 0.35);
      col = col + palette(k + 0.75) * (0.05 + 1.1 * strobe) * frame * (0.25 + 0.75 * triLines);
      col = col + (texc - 0.5) * 0.25 * (0.2 + intensity);
    }
  } else {
    // Fractal Nebula (vibe-synced morphing)
    let sh = clamp(params.v3, vec4<f32>(0.0), vec4<f32>(1.0));
    let detail = mix(0.9, 1.55, sh.x);
    let warpMul = mix(0.45, 1.65, sh.y);
    let swirl = (sh.z * 2.0 - 1.0) * mix(0.08, 0.35, 0.6 * sh.y + 0.4 * sh.w);
    let structure = sh.w;
    let fold = smoothstep(0.15, 0.85, structure);
    let ridge = smoothstep(0.25, 1.0, structure);

    let beatFlow = beat;
    let drop = clamp(params.v2.y, 0.0, 1.0);
    let beatK = beatFlow * 2.0 - 1.0;

    let motionCoef = 0.05 + intensity * 0.25 + drop * 0.22;
    let baseSpeed = (bpm / 60.0) * motionCoef * (1.0 + 0.2 * sh.y + 0.12 * abs(swirl));
    let t = time * baseSpeed;
    let beatOffset = beatFlow * (0.08 + intensity * 0.18 + drop * 0.55);
    let tb = t + beatOffset;
    let beatWarp = 1.0 + beatK * (0.06 + intensity * 0.1 + drop * 0.22);
    let beatZoom = 1.0 + beatK * (0.012 + intensity * 0.03 + drop * 0.05);
    let beatTwist = beatK * (0.25 + intensity * 0.5 + drop * 0.9);

    var q = vec3<f32>(uv * (1.1 + energy * 1.9) * detail * beatZoom, tb);
    q.xy = mix(q.xy, abs(q.xy), fold);
    q = q + vec3<f32>(
        sin(q.y * (1.15 + 0.55 * detail) + tb * 0.12 + swirl * 2.2 + beatTwist * 0.9),
        cos(q.x * (1.05 + 0.5 * detail) - tb * 0.1 - swirl * 2.0 - beatTwist * 0.9),
        0.0
      ) * (0.24 + intensity * 0.76) * (1.0 + drop * 0.35) * warpMul * beatWarp;
    var acc = 0.0;
    var colAcc = vec3<f32>(0.0);
    for (var i = 0u; i < 8u; i = i + 1u) {
      let fi = f32(i);
      let s = (1.25 + fi * 0.38) * detail;
      let tt = vec2<f32>(tb * (0.22 + 0.18 * warpMul), -tb * (0.19 + 0.16 * warpMul));
      let n = noise(q.xy * s + tt + vec2<f32>(structure * 2.7, swirl * 3.1));
      let dCenter = abs(n - 0.5);
      let dEdge = min(n, 1.0 - n);
      let d = mix(dCenter, dEdge, ridge);
      let w = exp(-d * (4.0 + high * 6.0 + ridge * 8.0));
      acc = acc + w;
      colAcc = colAcc + palette(n + fi * 0.06 + structure * 0.12) * w;
      q.xy = rotate2(q.xy, 0.14 + n * 0.26 + swirl * 0.22 + beatK * (0.02 + intensity * 0.05 + drop * 0.08));
      q.xy =
        q.xy +
        vec2<f32>(
          sin(q.y * (0.9 + 0.4 * detail) - tb * 0.35),
          cos(q.x * (0.8 + 0.5 * detail) + tb * 0.33)
        ) *
          (0.03 + 0.06 * warpMul) *
          (0.35 + 0.65 * ridge);
    }
    col = colAcc / max(0.001, acc);
    col = col + beatFlow * vec3<f32>(0.35, 0.5, 0.8) * (0.05 + 0.11 * intensity + 0.18 * drop);
  }

  return col;
}

@fragment
fn fsMain(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let res = params.v0.xy;
  let time = params.v0.z;
  let modeA = params.v0.w;
  let bpm = max(1.0, params.v1.x);
  let energy = clamp(params.v1.y, 0.0, 1.0);
  let beat = clamp(params.v1.z, 0.0, 1.0);
  let modeB = params.v1.w;
  let blend = clamp(params.v2.x, 0.0, 1.0);
  let dropPulse = clamp(params.v2.y, 0.0, 1.0);
  let intensity = clamp(params.v2.z, 0.0, 1.0);
  // params.v2.w is a per-session seed used by the hash/noise functions.
  // params.v3 is a 0..1 vec4 controlling nebula shape morphing.

  let uv0 = (pos.xy / res.xy) * 2.0 - 1.0;
  let uv = vec2<f32>(uv0.x * (res.x / res.y), uv0.y);

  let low = spectrumBand(0u, 10u);
  let mid = spectrumBand(10u, 28u);
  let high = spectrumBand(28u, 64u);

  let texUv = fract(uv * 0.12 + vec2<f32>(0.5, 0.5) + vec2<f32>(sin(time * 0.05), cos(time * 0.04)) * 0.05);
  let texc = textureSample(tex, samp, texUv).xyz;

  let colA = scene(modeA, uv, time, bpm, energy, beat, texc, low, mid, high, intensity);
  let colB = scene(modeB, uv, time, bpm, energy, beat, texc, low, mid, high, intensity);
  var col = mix(colA, colB, blend);

  // Drop flash / morph accent (subtle vignette + chroma lift)
  let vign = smoothstep(1.1, 0.2, length(uv));
  col = col + dropPulse * vign * palette(0.92) * (0.12 + intensity * 0.24);

  col = col * (0.55 + energy * 0.8);
  col = max(col, vec3<f32>(0.0));
  col = pow(col, vec3<f32>(0.9));
  return vec4<f32>(col, 1.0);
}
`;

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function avg(arr: Float32Array, start: number, end: number) {
  let sum = 0;
  let count = 0;
  for (let i = start; i < end && i < arr.length; i++) {
    sum += arr[i] ?? 0;
    count++;
  }
  return count ? sum / count : 0;
}

function mixPalette(a: Palette, b: Palette, t: number): Palette {
  const mix3 = (x: [number, number, number], y: [number, number, number]) => [
    x[0] + (y[0] - x[0]) * t,
    x[1] + (y[1] - x[1]) * t,
    x[2] + (y[2] - x[2]) * t
  ] as [number, number, number];
  return { a: mix3(a.a, b.a), b: mix3(a.b, b.b), c: mix3(a.c, b.c), d: mix3(a.d, b.d) };
}
