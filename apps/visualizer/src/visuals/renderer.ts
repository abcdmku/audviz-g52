import type { Palette, PresetSpec } from "./presets.js";

type RenderState = {
  time: number;
  bpm: number;
  energy: number;
  beat: number;
  spectrum: Float32Array;
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

  private params = new Float32Array(6 * 4); // 6 vec4s
  private spectrum = new Float32Array(64);

  private texture: GPUTexture;
  private sampler: GPUSampler;
  private textureView: GPUTextureView;

  private preset: PresetSpec | null = null;

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
    const w = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
    const h = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));

    // params vec4 packing:
    // v0: (w, h, time, mode)
    // v1: (bpm, energy, beat, _)
    this.params[0] = w;
    this.params[1] = h;
    this.params[2] = state.time;
    this.params[3] = this.preset?.mode ?? 0;
    this.params[4] = state.bpm;
    this.params[5] = state.energy;
    this.params[6] = state.beat;
    this.params[7] = 0;

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

  private resizeToClientSize() {
    const canvas = this.context.canvas as HTMLCanvasElement;
    const w = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
    const h = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
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
    write(2, palette.a);
    write(3, palette.b);
    write(4, palette.c);
    write(5, palette.d);
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
  let h = dot(p, vec2<f32>(127.1, 311.7));
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

@fragment
fn fsMain(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let res = params.v0.xy;
  let time = params.v0.z;
  let mode = params.v0.w;
  let bpm = max(1.0, params.v1.x);
  let energy = clamp(params.v1.y, 0.0, 1.0);
  let beat = clamp(params.v1.z, 0.0, 1.0);

  let uv0 = (pos.xy / res.xy) * 2.0 - 1.0;
  let uv = vec2<f32>(uv0.x * (res.x / res.y), uv0.y);

  let spec = spectrumEnergy();
  let speed = (bpm / 60.0) * 0.35 + 0.25;
  let t = time * speed;

  var col = vec3<f32>(0.0);

  if (mode < 0.5) {
    // Plasma bloom
    let p = uv * (2.2 + energy * 1.6);
    let n = noise(p * 1.2 + vec2<f32>(t * 0.6, -t * 0.35));
    let v = sin(p.x + t * 1.2) + sin(p.y * 1.3 - t) + sin((p.x + p.y) * 0.7 + t * 0.8);
    let k = 0.5 + 0.5 * sin(v + n * 3.0);
    col = palette(k + energy * 0.15 + spec * 0.25);
    col = col + beat * vec3<f32>(0.9, 0.6, 0.8);
  } else if (mode < 1.5) {
    // Neon tunnel
    let r = length(uv);
    let a = atan2(uv.y, uv.x);
    let z = 1.0 / max(0.15, r);
    let w = vec2<f32>(a / 6.28318, z * 0.12 + t * 0.35);
    let texc = textureSample(tex, samp, fract(w)).xyz;
    let rings = sin(z * 6.0 + t * 5.0) * 0.5 + 0.5;
    let grid = smoothstep(0.92, 1.0, sin((a * 8.0 + z * 2.0) + t * 2.0) * 0.5 + 0.5);
    let k = rings * 0.65 + grid * 0.35 + energy * 0.2;
    col = palette(k + spec * 0.35);
    col = mix(col, col * texc * 1.6, 0.45);
    col = col + beat * vec3<f32>(1.2, 1.0, 0.4);
  } else {
    // Kaleidoscope
    var p = uv;
    let m = 6.0;
    let ang = atan2(p.y, p.x);
    let rad = length(p);
    let seg = 6.28318 / m;
    let ang2 = abs(fract((ang + seg * 0.5) / seg) * seg - seg * 0.5);
    p = vec2<f32>(cos(ang2), sin(ang2)) * rad;
    p = p * (1.8 + energy * 1.5);
    let n = noise(p * 1.4 + vec2<f32>(-t * 0.4, t * 0.6));
    let texc = textureSample(tex, samp, fract(p * 0.08 + 0.5)).xyz;
    let k = 0.55 + 0.45 * sin(6.0 * rad - t * 2.0 + n * 2.5);
    col = palette(k + spec * 0.25);
    col = mix(col, col * texc * 1.4, 0.4);
    col = col + beat * vec3<f32>(0.6, 1.0, 0.7);
  }

  col = col * (0.55 + energy * 0.8);
  col = max(col, vec3<f32>(0.0));
  col = pow(col, vec3<f32>(0.9));
  return vec4<f32>(col, 1.0);
}
`;
