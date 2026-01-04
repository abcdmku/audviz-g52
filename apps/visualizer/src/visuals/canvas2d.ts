import type { Palette, PresetSpec } from "./presets.js";

type RenderState = {
  time: number;
  bpm: number;
  energy: number;
  beat: number;
  spectrum: Float32Array;
};

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function toCssRgb(rgb: [number, number, number], a = 1) {
  const r = Math.round(clamp01(rgb[0]) * 255);
  const g = Math.round(clamp01(rgb[1]) * 255);
  const b = Math.round(clamp01(rgb[2]) * 255);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export class Canvas2dRenderer {
  readonly backend = "Canvas2D";

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;

  private palette: Palette | null = null;
  private texture: ImageBitmap | null = null;
  private seed = 0;
  private noisePattern: CanvasPattern | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Failed to get 2D context");
    this.ctx = ctx;

    this.ro = new ResizeObserver(() => this.resizeToClientSize());
    this.ro.observe(canvas);
    this.resizeToClientSize();
  }

  setPreset(preset: PresetSpec) {
    this.palette = preset.palette;
  }

  setSeed(seed: number) {
    this.seed = seed | 0;
    this.noisePattern = this.buildNoisePattern(this.seed);
  }

  async setTextureFromBase64Png(pngBase64: string) {
    const bin = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([bin], { type: "image/png" });
    this.texture = await createImageBitmap(blob);
  }

  render(state: RenderState) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w <= 1 || h <= 1) return;

    const pal = this.palette ?? {
      a: [0.02, 0.02, 0.05],
      b: [0.0, 0.8, 1.0],
      c: [0.6, 0.2, 1.0],
      d: [1.0, 0.4, 0.6]
    };

    const energy = clamp01(state.energy);
    const beat = clamp01(state.beat);

    const seedPhase = ((this.seed >>> 0) % 10000) / 10000;
    const cx = w * (0.45 + 0.12 * Math.sin(seedPhase * Math.PI * 2));
    const cy = h * (0.52 + 0.1 * Math.cos(seedPhase * Math.PI * 2));

    // Background gradient
    const g = this.ctx.createRadialGradient(
      cx,
      cy,
      10,
      cx,
      cy,
      Math.max(w, h) * 0.7
    );
    g.addColorStop(0, toCssRgb(pal.b, 0.22 + energy * 0.25));
    g.addColorStop(0.5, toCssRgb(pal.c, 0.18 + energy * 0.15));
    g.addColorStop(1, toCssRgb(pal.a, 1));
    this.ctx.fillStyle = g;
    this.ctx.fillRect(0, 0, w, h);

    // Film-grain / grit (seeded) to avoid "flat gradient" look
    if (this.noisePattern) {
      this.ctx.save();
      this.ctx.globalCompositeOperation = "overlay";
      this.ctx.globalAlpha = 0.06 + energy * 0.06;
      this.ctx.fillStyle = this.noisePattern;
      this.ctx.translate(Math.sin(state.time * 0.7) * 40, Math.cos(state.time * 0.63) * 35);
      this.ctx.fillRect(-80, -80, w + 160, h + 160);
      this.ctx.restore();
    }

    // Optional texture overlay
    if (this.texture) {
      const scale = 1.2 + energy * 0.6;
      const tw = this.texture.width * scale;
      const th = this.texture.height * scale;
      const x = (w - tw) * 0.5 + Math.sin(state.time * 0.22 + seedPhase * 6.0) * (28 + energy * 22);
      const y = (h - th) * 0.5 + Math.cos(state.time * 0.2 - seedPhase * 5.0) * (26 + energy * 18);
      this.ctx.globalCompositeOperation = "screen";
      this.ctx.globalAlpha = 0.16 + energy * 0.26;
      this.ctx.drawImage(this.texture, x, y, tw, th);
      this.ctx.globalAlpha = 1;
      this.ctx.globalCompositeOperation = "source-over";
    }

    // Spectrum bars
    const bins = Math.min(64, state.spectrum.length);
    const barW = w / bins;
    const baseY = h * 0.92;
    this.ctx.save();
    this.ctx.globalCompositeOperation = "screen";
    for (let i = 0; i < bins; i++) {
      const v = clamp01(state.spectrum[i] ?? 0);
      const bh = v * (h * (0.22 + energy * 0.28));
      const x = i * barW;
      const c = i % 3 === 0 ? pal.b : i % 3 === 1 ? pal.d : pal.c;
      this.ctx.fillStyle = toCssRgb(c, 0.22 + v * 0.4);
      this.ctx.fillRect(x, baseY - bh, Math.max(1, barW - 1), bh);
    }
    this.ctx.restore();

    // Beat flash vignette
    if (beat > 0.001) {
      const vg = this.ctx.createRadialGradient(
        w * 0.5,
        h * 0.5,
        Math.min(w, h) * 0.15,
        w * 0.5,
        h * 0.5,
        Math.max(w, h) * 0.65
      );
      vg.addColorStop(0, toCssRgb(pal.d, 0));
      vg.addColorStop(1, toCssRgb(pal.d, 0.18 * beat));
      this.ctx.fillStyle = vg;
      this.ctx.fillRect(0, 0, w, h);
    }
  }

  private buildNoisePattern(seed: number) {
    const s = Math.max(1, seed | 0) >>> 0;
    let t = s;
    const rand = () => {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    const oc = document.createElement("canvas");
    oc.width = 192;
    oc.height = 192;
    const octx = oc.getContext("2d");
    if (!octx) return null;
    const img = octx.createImageData(oc.width, oc.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.floor(rand() * 255);
      img.data[i + 0] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    return this.ctx.createPattern(oc, "repeat");
  }

  private resizeToClientSize() {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * devicePixelRatio));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * devicePixelRatio));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
  }
}
