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
  return {
    a: mix3(a.a, b.a),
    b: mix3(a.b, b.b),
    c: mix3(a.c, b.c),
    d: mix3(a.d, b.d)
  };
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type);
  if (!s) throw new Error("WebGL: createShader failed");
  gl.shaderSource(s, src);
  gl.compileShader(s);
  const ok = gl.getShaderParameter(s, gl.COMPILE_STATUS);
  if (!ok) {
    const log = gl.getShaderInfoLog(s) || "unknown";
    gl.deleteShader(s);
    throw new Error(`WebGL shader compile failed: ${log}`);
  }
  return s;
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader) {
  const p = gl.createProgram();
  if (!p) throw new Error("WebGL: createProgram failed");
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  const ok = gl.getProgramParameter(p, gl.LINK_STATUS);
  if (!ok) {
    const log = gl.getProgramInfoLog(p) || "unknown";
    gl.deleteProgram(p);
    throw new Error(`WebGL program link failed: ${log}`);
  }
  return p;
}

export class WebGl2Renderer {
  readonly backend = "WebGL2";

  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private ro: ResizeObserver;

  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private texA: WebGLTexture;
  private texB: WebGLTexture;

  private uRes: WebGLUniformLocation;
  private uTime: WebGLUniformLocation;
  private uBpm: WebGLUniformLocation;
  private uEnergy: WebGLUniformLocation;
  private uBeat: WebGLUniformLocation;
  private uModeA: WebGLUniformLocation;
  private uModeB: WebGLUniformLocation;
  private uBlend: WebGLUniformLocation;
  private uDropPulse: WebGLUniformLocation;
  private uIntensity: WebGLUniformLocation;
  private uSeed: WebGLUniformLocation;
  private uNebula: WebGLUniformLocation;
  private uPalA: WebGLUniformLocation;
  private uPalB: WebGLUniformLocation;
  private uPalC: WebGLUniformLocation;
  private uPalD: WebGLUniformLocation;
  private uSpectrum0: WebGLUniformLocation;
  private uUser: WebGLUniformLocation;
  private uTexBlend: WebGLUniformLocation;

  private spectrum = new Float32Array(64);

  private preset: PresetSpec | null = null;
  private transitionState: TransitionState | null = null;
  private seed = Math.floor(Math.random() * 1_000_000_000);

  private user = {
    textureStrength: 0.8,
    warpStrength: 0.85,
    strobeStrength: 0.7,
    brightness: 1,
    grainStrength: 0.7
  };

  private texBlend = 0; // 0..1
  private textureCrossfadeActive = false;
  private textureCrossfadeSec = 0.75;

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
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false
    });
    if (!gl) throw new Error("WebGL2 not available in this browser");
    return new WebGl2Renderer(canvas, gl);
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    this.program = linkProgram(gl, vs, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    const vao = gl.createVertexArray();
    if (!vao) throw new Error("WebGL: createVertexArray failed");
    this.vao = vao;
    gl.bindVertexArray(this.vao);

    const initTex = () => {
      const tex = gl.createTexture();
      if (!tex) throw new Error("WebGL: createTexture failed");
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([255, 255, 255, 255])
      );
      return tex;
    };
    this.texA = initTex();
    this.texB = initTex();

    gl.useProgram(this.program);
    const loc = (name: string) => {
      const u = gl.getUniformLocation(this.program, name);
      if (!u) throw new Error(`WebGL missing uniform: ${name}`);
      return u;
    };
    this.uRes = loc("uRes");
    this.uTime = loc("uTime");
    this.uBpm = loc("uBpm");
    this.uEnergy = loc("uEnergy");
    this.uBeat = loc("uBeat");
    this.uModeA = loc("uModeA");
    this.uModeB = loc("uModeB");
    this.uBlend = loc("uBlend");
    this.uDropPulse = loc("uDropPulse");
    this.uIntensity = loc("uIntensity");
    this.uSeed = loc("uSeed");
    this.uNebula = loc("uNebula");
    this.uPalA = loc("uPalA");
    this.uPalB = loc("uPalB");
    this.uPalC = loc("uPalC");
    this.uPalD = loc("uPalD");
    this.uSpectrum0 = loc("uSpectrum[0]");
    this.uUser = loc("uUser");
    this.uTexBlend = loc("uTexBlend");

    const uTex = gl.getUniformLocation(this.program, "uTex");
    if (!uTex) throw new Error("WebGL missing uniform: uTex");
    gl.uniform1i(uTex, 0);
    const uTex2 = gl.getUniformLocation(this.program, "uTex2");
    if (!uTex2) throw new Error("WebGL missing uniform: uTex2");
    gl.uniform1i(uTex2, 1);

    gl.uniform1f(this.uTexBlend, 0);
    gl.uniform4f(
      this.uUser,
      this.user.textureStrength,
      this.user.warpStrength,
      this.user.strobeStrength,
      this.user.brightness
    );

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.ro = new ResizeObserver(() => this.resizeToClientSize());
    this.ro.observe(canvas);
    this.resizeToClientSize();
  }

  setSeed(seed: number) {
    this.seed = ((seed | 0) >>> 0) % 1_000_000;
    this.rngState = (this.seed || 1) >>> 0;
    this.nebulaInitialized = false;
  }

  setUserParams(params: Record<string, number>) {
    const n = (k: keyof typeof this.user) => {
      const v = params[k];
      return typeof v === "number" && Number.isFinite(v) ? v : this.user[k];
    };
    this.user.textureStrength = Math.max(0, Math.min(1, n("textureStrength")));
    this.user.warpStrength = Math.max(0, Math.min(1, n("warpStrength")));
    this.user.strobeStrength = Math.max(0, Math.min(1, n("strobeStrength")));
    this.user.brightness = Math.max(0.25, Math.min(2, n("brightness")));
    this.user.grainStrength = Math.max(0, Math.min(1, n("grainStrength")));

    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform4f(
      this.uUser,
      this.user.textureStrength,
      this.user.warpStrength,
      this.user.strobeStrength,
      this.user.brightness
    );
  }

  setPreset(preset: PresetSpec) {
    this.preset = preset;
    this.transitionState = {
      modeA: preset.mode,
      modeB: preset.mode,
      blend: 0,
      dropPulse: 0,
      palette: preset.palette
    };
    this.applyPalette(preset.palette);
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

  async setTextureFromBlob(blob: Blob, opts?: { immediate?: boolean }) {
    const bmp = await createImageBitmap(blob);

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, opts?.immediate ? this.texA : this.texB);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.generateMipmap(gl.TEXTURE_2D);

    this.texBlend = 0;
    this.textureCrossfadeActive = !opts?.immediate;
    gl.useProgram(this.program);
    gl.uniform1f(this.uTexBlend, 0);
  }

  async setTextureFromBase64Png(pngBase64: string) {
    const bin = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([bin], { type: "image/png" });
    await this.setTextureFromBlob(blob);
  }

  render(state: RenderState) {
    const modeA = this.transitionState?.modeA ?? this.preset?.mode ?? 0;
    const modeB = this.transitionState?.modeB ?? this.preset?.mode ?? 0;
    const dropPulse = this.transitionState?.dropPulse ?? 0;

    const nebulaVisible = modeA >= 4.5 || modeB >= 4.5;
    const desiredDprCap = nebulaVisible ? 1.5 : 2;
    if (this.dprCap !== desiredDprCap) {
      this.dprCap = desiredDprCap;
      this.resizeToClientSize();
    }

    const canvas = this.canvas;
    const w = canvas.width;
    const h = canvas.height;
    if (w <= 1 || h <= 1) return;

    const low = avg(state.spectrum, 0, 10);
    const mid = avg(state.spectrum, 10, 28);
    const high = avg(state.spectrum, 28, 64);
    const intensity = clamp01(state.energy * state.energy * 0.8 + high * 0.35 + mid * 0.15);

    const dt = this.lastTime ? Math.min(0.1, Math.max(0, state.time - this.lastTime)) : 0;
    this.lastTime = state.time;

    if (this.textureCrossfadeActive) {
      this.texBlend = Math.min(1, this.texBlend + (dt > 0 ? dt / this.textureCrossfadeSec : 0));
      if (this.texBlend >= 1) {
        const tmp = this.texA;
        this.texA = this.texB;
        this.texB = tmp;
        this.texBlend = 0;
        this.textureCrossfadeActive = false;
      }
    }
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

    const n = Math.min(state.spectrum.length, this.spectrum.length);
    for (let i = 0; i < n; i++) this.spectrum[i] = state.spectrum[i] ?? 0;
    for (let i = n; i < this.spectrum.length; i++) this.spectrum[i] = 0;

    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texB);

    gl.uniform2f(this.uRes, w, h);
    gl.uniform1f(this.uTime, state.time);
    gl.uniform1f(this.uBpm, state.bpm);
    gl.uniform1f(this.uEnergy, clamp01(state.energy));
    gl.uniform1f(this.uBeat, beatForShader);
    gl.uniform1f(this.uModeA, modeA);
    gl.uniform1f(this.uModeB, modeB);
    gl.uniform1f(this.uBlend, this.transitionState?.blend ?? 0);
    gl.uniform1f(this.uDropPulse, dropPulse);
    gl.uniform1f(this.uIntensity, intensity);
    gl.uniform1f(this.uSeed, this.seed);
    gl.uniform1f(this.uTexBlend, this.textureCrossfadeActive ? this.texBlend : 0);
    gl.uniform4f(
      this.uNebula,
      this.nebulaShape[0] ?? 0.5,
      this.nebulaShape[1] ?? 0.5,
      this.nebulaShape[2] ?? 0.5,
      this.nebulaShape[3] ?? 0.5
    );
    gl.uniform1fv(this.uSpectrum0, this.spectrum);

    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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

    // uNebula is intentionally normalized (0..1) so the shader can remap as it likes.
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

  private resizeToClientSize() {
    const dpr = Math.min(devicePixelRatio, this.dprCap);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  private applyPalette(palette: Palette) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform3f(this.uPalA, palette.a[0], palette.a[1], palette.a[2]);
    gl.uniform3f(this.uPalB, palette.b[0], palette.b[1], palette.b[2]);
    gl.uniform3f(this.uPalC, palette.c[0], palette.c[1], palette.c[2]);
    gl.uniform3f(this.uPalD, palette.d[0], palette.d[1], palette.d[2]);
  }
}

const vertSrc = `#version 300 es
precision highp float;
void main() {
  vec2 pos[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
    vec2(-1.0,  3.0)
  );
  gl_Position = vec4(pos[gl_VertexID], 0.0, 1.0);
}
`;

const fragSrc = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uRes;
uniform float uTime;
uniform float uBpm;
uniform float uEnergy;
uniform float uBeat;
uniform float uModeA;
uniform float uModeB;
uniform float uBlend;
uniform float uDropPulse;
uniform float uIntensity;
uniform float uSeed;
uniform vec4 uNebula;

uniform vec3 uPalA;
uniform vec3 uPalB;
uniform vec3 uPalC;
uniform vec3 uPalD;

uniform sampler2D uTex;
uniform sampler2D uTex2;
uniform float uTexBlend;
uniform vec4 uUser; // (texStrength, warpStrength, strobeStrength, brightness)
uniform float uSpectrum[64];

vec3 palette(float t) {
  return uPalA + uPalB * cos(6.28318 * (uPalC * t + uPalD));
}

float hash21(vec2 p) {
  float h = dot(p, vec2(127.1, 311.7)) + uSeed * 0.017;
  return fract(sin(h) * 43758.5453);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float spectrumBand(int start, int endExclusive) {
  float sum = 0.0;
  float count = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= start && i < endExclusive) {
      sum += uSpectrum[i];
      count += 1.0;
    }
  }
  return sum / max(1.0, count);
}

vec2 rotate2(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

float triWave(float x) {
  return abs(fract(x) - 0.5) * 2.0;
}

float sdEquilateralTriangle(vec2 pIn, float r) {
  const float k = 1.7320508; // sqrt(3)
  vec2 p = vec2(abs(pIn.x), pIn.y);
  p.x = p.x - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) {
    p = vec2(p.x - k * p.y, -k * p.x - p.y) * 0.5;
  }
  p.x = p.x - clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

float shapeSdf(int kind, vec2 p, float r) {
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

vec3 scene(float mode, vec2 uv, float time, float bpm, float energy, float beat, vec3 texc, vec3 texScreen, float low, float mid, float high, float intensity) {
  vec3 col = vec3(0.0);

  if (mode >= 5.75) {
    col = max(texScreen, vec3(0.0));
    col *= (0.85 + energy * 0.35);
    col += beat * palette(0.92) * (0.03 + 0.05 * intensity);
    return col;
  }

  if (mode < 0.5) {
    vec2 p = uv * (2.2 + energy * 1.8);
    p += vec2(sin(p.y * 1.7 + time * 0.9), cos(p.x * 1.3 - time * 0.7)) * (0.25 + intensity * 0.55);
    float n = noise2(p * 1.2 + vec2(time * 0.6, -time * 0.35));
    float v = sin(p.x + time * 1.2) + sin(p.y * 1.3 - time) + sin((p.x + p.y) * 0.7 + time * 0.8);
    float k = 0.5 + 0.5 * sin(v + n * (3.0 + high * 2.0));
    col = palette(k + energy * 0.18 + (mid + high) * 0.25);
    col += beat * vec3(0.9, 0.6, 0.8);
  } else if (mode < 1.5) {
    float speed = (bpm / 60.0) * (0.28 + intensity * 0.55);
    float t = time * speed;
    float r = length(uv);
    float a = atan(uv.y, uv.x);
    float z = 1.0 / max(0.12, r);
    float wob = sin(t * 1.8 + z * 0.8) * (0.1 + intensity * 0.35);
    vec2 w = vec2((a / 6.28318) + wob, z * 0.11 + t * 0.28);
    vec3 tex2 = texture(uTex, fract(w)).xyz;
    float rings = sin(z * (6.0 + mid * 10.0) + t * (5.0 + high * 8.0)) * 0.5 + 0.5;
    float grid = smoothstep(0.93, 1.0, sin((a * (8.0 + low * 10.0) + z * 2.0) + t * 2.0) * 0.5 + 0.5);
    float k = rings * 0.65 + grid * 0.35 + energy * 0.2;
    col = palette(k + (low + high) * 0.25);
    col = mix(col, col * tex2 * 1.7, 0.52);
    col = col + (texc - 0.5) * 0.25 * (0.3 + intensity) * uUser.x;
    col = col + beat * vec3(1.2, 1.0, 0.4);
  } else if (mode < 2.5) {
    vec2 p = uv;
    float m = 8.0 + floor(low * 6.0);
    float ang = atan(p.y, p.x);
    float rad = length(p);
    float seg = 6.28318 / m;
    float ang2 = abs(fract((ang + seg * 0.5) / seg) * seg - seg * 0.5);
    p = vec2(cos(ang2), sin(ang2)) * rad;
    p = rotate2(p, sin(time * 0.35) * 0.15);
    p = p * (1.9 + energy * 2.2);
    float n = noise2(p * 1.4 + vec2(-time * 0.4, time * 0.6));
    vec3 tex2 = texture(uTex, fract(p * 0.09 + 0.5)).xyz;
    float k = 0.55 + 0.45 * sin((7.0 + high * 10.0) * rad - time * 2.0 + n * (2.5 + mid * 3.0));
    col = palette(k + (mid + high) * 0.22);
    col = mix(col, col * tex2 * 1.55, 0.48);
    col = col + beat * vec3(0.6, 1.0, 0.7);
  } else if (mode < 3.5) {
    float speed = (bpm / 60.0) * (0.18 + intensity * 0.65);
    float t = time * speed;
    vec3 ro = vec3(0.0, 0.0, -2.6);
    ro.x = sin(t * 0.6) * (0.35 + intensity * 0.6);
    ro.y = cos(t * 0.45) * (0.18 + intensity * 0.35);
    vec3 rd = normalize(vec3(uv, 1.45));

    float total = 0.0;
    float glow = 0.0;
    float hit = 0.0;
    vec3 p3 = ro;
    for (int i = 0; i < 72; i++) {
      p3 = ro + rd * total;
      p3.z = p3.z + t * 2.0;
      float zf = fract(p3.z) - 0.5;
      vec3 q = vec3(p3.x, p3.y, zf);
      q.x = abs(q.x);
      float box = max(max(q.x - (0.55 + low * 0.25), abs(q.y) - (0.22 + energy * 0.18)), abs(q.z) - 0.36);
      float cyl = length(vec2(q.x - 0.3, q.y)) - (0.18 + mid * 0.12);
      float d = min(box, cyl);
      d = d - 0.02 - beat * 0.04;
      glow += 0.06 / max(0.02, abs(d));
      if (d < 0.001) { hit = 1.0; break; }
      total += d * (0.55 + intensity * 0.25);
      if (total > 9.0) { break; }
    }

    float fog = exp(-total * (0.18 + intensity * 0.12));
    vec3 base = palette(0.25 + mid * 0.35 + sin(t * 0.2) * 0.1);
    col = base * (0.25 + 0.85 * fog);
    col += glow * palette(0.7 + high * 0.25) * (0.05 + intensity * 0.22);
    col += hit * (0.6 + 0.4 * beat) * palette(0.9);
  } else if (mode < 4.5) {
    if (mode < 4.25) {
      // Strobe Grid (classic)
      float speed = (bpm / 60.0) * (0.25 + intensity * 0.75);
      float t = time * speed;
      vec2 p = uv * (3.0 + intensity * 4.0);
      float gx = abs(fract(p.x + sin(t * 0.5) * 0.2) - 0.5);
      float gy = abs(fract(p.y + cos(t * 0.45) * 0.2) - 0.5);
      float g = 1.0 - smoothstep(0.46 - high * 0.1, 0.5, min(gx, gy));
      float stripes = smoothstep(0.9, 1.0, sin((p.y * 7.0 + t * 4.0) + sin(p.x * 2.0)) * 0.5 + 0.5);
      float strobe = smoothstep(0.6, 1.0, beat + intensity * 0.25) * uUser.z;
      float k = g * 0.75 + stripes * 0.25;
      col = palette(k + mid * 0.35);
      col = col * (0.25 + 1.6 * strobe);
      col = col + (texc - 0.5) * 0.35 * (0.2 + intensity) * uUser.x;
    } else {
      // Strobe Geometry (triangular background + beat-morphing shapes)
      float speed = (bpm / 60.0) * (0.22 + intensity * 0.9);
      float t = time * speed;

      float scale = 3.0 + intensity * 4.2;
      vec2 p = uv * scale;

      // Triangular facets background (no wavy scanlines)
      vec2 bgp = p * 0.9 + vec2(t * 0.55, -t * 0.35);
      float tt0 = triWave(bgp.x + 0.13 * sin(t * 0.6));
      float tt1 = triWave(bgp.x * 0.5 + bgp.y * 0.8660254 + t * 0.17);
      float tt2 = triWave(-bgp.x * 0.5 + bgp.y * 0.8660254 - t * 0.14);
      float tri = max(tt0, max(tt1, tt2));
      float triLines = smoothstep(0.84 - high * 0.1, 0.985, tri);
      float facet = (tt0 + tt1 + tt2) / 3.0;

      vec2 cell = floor(p);
      vec2 fu = fract(p) - vec2(0.5);
      vec2 f = fu;

      // per-cell rotation + beat twist
      float h2 = hash21(cell);
      f = rotate2(f, (h2 - 0.5) * (0.55 + intensity * 0.9) + beat * 0.45);

      float pulse = pow(clamp(beat + intensity * 0.12, 0.0, 1.0), 0.35);

      // Cycle shapes on the beat: square -> circle -> triangle -> diamond -> ...
      float beatPos = time * (bpm / 60.0);
      float beatIdx = floor(beatPos);
      float beatPhase = fract(beatPos);
      int kindOffset = int(mod(floor(uSeed), 4.0));
      int kindA = (int(mod(beatIdx, 4.0)) + kindOffset) % 4;
      int kindB = (kindA + 1) % 4;
      float m = beatPhase * beatPhase * (3.0 - 2.0 * beatPhase);

      // Expand on beat
      float r = 0.16 + 0.09 * intensity + pulse * 0.26;
      float dA = shapeSdf(kindA, f, r);
      float dB = shapeSdf(kindB, f, r);
      float d = mix(dA, dB, m);

      float edge = 0.01 + 0.014 * (0.6 + intensity);
      float fill = 1.0 - smoothstep(0.0, edge, d);
      float outline = 1.0 - smoothstep(edge, edge * 3.2, abs(d));

      float frame = smoothstep(0.475 - high * 0.04, 0.5, max(abs(fu.x), abs(fu.y)));
      float strobe = smoothstep(0.25, 1.0, pulse + intensity * 0.25) * uUser.z;

      float k = fract(facet * 0.85 + h2 * 0.35 + mid * 0.22 + time * 0.02);
      col = palette(k + mid * 0.2) * (0.06 + 0.22 * triLines);
      col = col + palette(k + 0.35 + high * 0.15) * (0.12 + 1.6 * strobe) * (outline * 0.95 + fill * 0.35);
      col = col + palette(k + 0.75) * (0.05 + 1.1 * strobe) * frame * (0.25 + 0.75 * triLines);
      col = col + (texc - 0.5) * 0.25 * (0.2 + intensity) * uUser.x;
    }
  } else {
    // Fractal Nebula (vibe-synced morphing)
    vec4 sh = clamp(uNebula, 0.0, 1.0);
    float detail = mix(0.9, 1.55, sh.x);
    float warpMul = mix(0.45, 1.65, sh.y);
    float swirl = (sh.z * 2.0 - 1.0) * mix(0.08, 0.35, 0.6 * sh.y + 0.4 * sh.w);
    float structure = sh.w;
    float fold = smoothstep(0.15, 0.85, structure);
    float ridge = smoothstep(0.25, 1.0, structure);

    float beatFlow = beat;
    float drop = clamp(uDropPulse, 0.0, 1.0);
    float beatK = beatFlow * 2.0 - 1.0;

    float motionCoef = 0.05 + intensity * 0.25 + drop * 0.22;
    float baseSpeed = (bpm / 60.0) * motionCoef * (1.0 + 0.2 * sh.y + 0.12 * abs(swirl));
    float t = time * baseSpeed;
    float beatOffset = beatFlow * (0.08 + intensity * 0.18 + drop * 0.55);
    float tb = t + beatOffset;
    float beatWarp = 1.0 + beatK * (0.06 + intensity * 0.1 + drop * 0.22);
    float beatZoom = 1.0 + beatK * (0.012 + intensity * 0.03 + drop * 0.05);
    float beatTwist = beatK * (0.25 + intensity * 0.5 + drop * 0.9);

    vec3 q = vec3(uv * (1.1 + energy * 1.9) * detail * beatZoom, tb);
    q.xy = mix(q.xy, abs(q.xy), fold);
    q = q + vec3(
        sin(q.y * (1.15 + 0.55 * detail) + tb * 0.12 + swirl * 2.2 + beatTwist * 0.9),
        cos(q.x * (1.05 + 0.5 * detail) - tb * 0.1 - swirl * 2.0 - beatTwist * 0.9),
        0.0
      ) * (0.24 + intensity * 0.76) * (1.0 + drop * 0.35) * warpMul * beatWarp;
    float acc = 0.0;
    vec3 colAcc = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float fi = float(i);
      float s = (1.25 + fi * 0.38) * detail;
      vec2 tt = vec2(tb * (0.22 + 0.18 * warpMul), -tb * (0.19 + 0.16 * warpMul));
      float n = noise2(q.xy * s + tt + vec2(structure * 2.7, swirl * 3.1));
      float dCenter = abs(n - 0.5);
      float dEdge = min(n, 1.0 - n);
      float d = mix(dCenter, dEdge, ridge);
      float w = exp(-d * (4.0 + high * 6.0 + ridge * 8.0));
      acc += w;
      colAcc += palette(n + fi * 0.06 + structure * 0.12) * w;
      q.xy = rotate2(q.xy, 0.14 + n * 0.26 + swirl * 0.22 + beatK * (0.02 + intensity * 0.05 + drop * 0.08));
      q.xy =
        q.xy +
        vec2(
          sin(q.y * (0.9 + 0.4 * detail) - tb * 0.35),
          cos(q.x * (0.8 + 0.5 * detail) + tb * 0.33)
        ) *
          (0.03 + 0.06 * warpMul) *
          (0.35 + 0.65 * ridge);
    }
    col = colAcc / max(0.001, acc);
    col = col + beatFlow * vec3(0.35, 0.5, 0.8) * (0.05 + 0.11 * intensity + 0.18 * drop);
  }
  return col;
}

void main() {
  vec2 res = uRes;
  float time = uTime;
  float bpm = max(1.0, uBpm);
  float energy = clamp(uEnergy, 0.0, 1.0);
  float beat = clamp(uBeat, 0.0, 1.0);
  float modeA = uModeA;
  float modeB = uModeB;
  float blend = clamp(uBlend, 0.0, 1.0);
  float dropPulse = clamp(uDropPulse, 0.0, 1.0);
  float intensity = clamp(uIntensity, 0.0, 1.0) * mix(0.35, 1.25, clamp(uUser.y, 0.0, 1.0));

  vec2 uv0 = (gl_FragCoord.xy / res.xy) * 2.0 - 1.0;
  vec2 uv = vec2(uv0.x * (res.x / res.y), uv0.y);

  float low = spectrumBand(0, 10);
  float mid = spectrumBand(10, 28);
  float high = spectrumBand(28, 64);

  vec2 texUv = fract(uv * 0.12 + vec2(0.5, 0.5) + vec2(sin(time * 0.05), cos(time * 0.04)) * 0.05);
  vec3 texA = texture(uTex, texUv).xyz;
  vec3 texB = texture(uTex2, texUv).xyz;
  vec3 texTile = mix(texA, texB, clamp(uTexBlend, 0.0, 1.0));

  vec2 screenUv = gl_FragCoord.xy / res.xy;
  vec3 sA = texture(uTex, screenUv).xyz;
  vec3 sB = texture(uTex2, screenUv).xyz;
  vec3 texScreen = mix(sA, sB, clamp(uTexBlend, 0.0, 1.0));

  vec3 colA = scene(modeA, uv, time, bpm, energy, beat, texTile, texScreen, low, mid, high, intensity);
  vec3 colB = scene(modeB, uv, time, bpm, energy, beat, texTile, texScreen, low, mid, high, intensity);
  vec3 col = mix(colA, colB, blend);

  float vign = smoothstep(1.1, 0.2, length(uv));
  col += dropPulse * vign * palette(0.92) * (0.12 + intensity * 0.24);

  col = col * (0.55 + energy * 0.8) * uUser.w;
  col = max(col, vec3(0.0));
  col = pow(col, vec3(0.9));
  outColor = vec4(col, 1.0);
}
`;
