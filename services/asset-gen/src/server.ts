import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express from "express";
import { PNG } from "pngjs";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.HOST ?? "127.0.0.1";

const SizeSchema = z.union([
  z.number().int().min(64).max(4096),
  z
    .object({
      w: z.number().int().min(64).max(4096),
      h: z.number().int().min(64).max(4096)
    })
    .strict()
]);

const GenerateRequestSchema = z.object({
  type: z.enum(["texture", "lut", "envmap", "keyframe"]).optional(),
  prompt: z.string().min(1).max(800),
  size: SizeSchema.optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
  tiling: z.boolean().optional()
});

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function clampInt(x: number, lo: number, hi: number) {
  const n = Number.isFinite(x) ? Math.trunc(x) : lo;
  return Math.max(lo, Math.min(hi, n));
}

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hashToSeed(input: string) {
  const h = crypto.createHash("sha256").update(input).digest();
  return h.readUInt32LE(0) & 0x7fffffff;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (0 <= hp && hp < 1) [r, g, b] = [c, x, 0];
  else if (1 <= hp && hp < 2) [r, g, b] = [x, c, 0];
  else if (2 <= hp && hp < 3) [r, g, b] = [0, c, x];
  else if (3 <= hp && hp < 4) [r, g, b] = [0, x, c];
  else if (4 <= hp && hp < 5) [r, g, b] = [x, 0, c];
  else if (5 <= hp && hp < 6) [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

type Palette = {
  baseHue: number;
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  d: [number, number, number];
};

function derivePalette(prompt: string, seed: number): Palette {
  const p = prompt.toLowerCase();
  const rand = mulberry32(seed);

  let baseHue = Math.floor(rand() * 360);
  let sat = 0.85;
  let lumA = 0.12;
  let lumB = 0.55;

  if (p.includes("fire") || p.includes("lava") || p.includes("volcano")) {
    baseHue = 20;
    sat = 0.95;
    lumA = 0.08;
    lumB = 0.62;
  } else if (p.includes("ice") || p.includes("glacier") || p.includes("frost")) {
    baseHue = 195;
    sat = 0.8;
    lumA = 0.1;
    lumB = 0.6;
  } else if (p.includes("neon") || p.includes("cyber") || p.includes("synth")) {
    baseHue = 265;
    sat = 1.0;
    lumA = 0.08;
    lumB = 0.58;
  } else if (p.includes("forest") || p.includes("nature") || p.includes("jungle")) {
    baseHue = 120;
    sat = 0.85;
    lumA = 0.08;
    lumB = 0.52;
  } else if (p.includes("desert") || p.includes("sand")) {
    baseHue = 38;
    sat = 0.72;
    lumA = 0.12;
    lumB = 0.62;
  } else if (p.includes("ocean") || p.includes("water")) {
    baseHue = 205;
    sat = 0.85;
    lumA = 0.08;
    lumB = 0.58;
  } else if (p.includes("metal") || p.includes("chrome")) {
    baseHue = 210;
    sat = 0.35;
    lumA = 0.1;
    lumB = 0.7;
  }

  const a = hslToRgb(baseHue, sat, lumA);
  const b = hslToRgb((baseHue + 70) % 360, sat * 0.92, (lumA + lumB) * 0.5);
  const c = hslToRgb((baseHue + 150) % 360, sat * 0.78, lumB);
  const d = hslToRgb((baseHue + 310) % 360, sat * 0.85, lumB * 0.92);
  return { baseHue, a, b, c, d };
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function lerp3(a: [number, number, number], b: [number, number, number], t: number) {
  return [
    lerp(a[0], b[0], t),
    lerp(a[1], b[1], t),
    lerp(a[2], b[2], t)
  ] as [number, number, number];
}

function add3(a: [number, number, number], b: [number, number, number]) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] as [number, number, number];
}

function mul3(a: [number, number, number], s: number) {
  return [a[0] * s, a[1] * s, a[2] * s] as [number, number, number];
}

function fract(x: number) {
  return x - Math.floor(x);
}

function mod(n: number, m: number) {
  const r = n % m;
  return r < 0 ? r + m : r;
}

function fadeQuint(t: number) {
  // 6t^5 - 15t^4 + 10t^3
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function hashFloat01(n: number) {
  let x = n | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function makeNoiseGrid(seed: number, period: number) {
  const rand = mulberry32(seed);
  const grid = new Float32Array(period * period);
  for (let i = 0; i < grid.length; i++) {
    grid[i] = rand();
  }
  return grid;
}

function gridAt(grid: Float32Array, period: number, xi: number, yi: number) {
  const x = mod(xi, period);
  const y = mod(yi, period);
  return grid[x + y * period] ?? 0;
}

function valueNoise2D(grid: Float32Array, period: number, u: number, v: number) {
  const x = u * period;
  const y = v * period;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xf = x - x0;
  const yf = y - y0;

  const u1 = fadeQuint(xf);
  const v1 = fadeQuint(yf);

  const v00 = gridAt(grid, period, x0, y0);
  const v10 = gridAt(grid, period, x0 + 1, y0);
  const v01 = gridAt(grid, period, x0, y0 + 1);
  const v11 = gridAt(grid, period, x0 + 1, y0 + 1);

  const a = lerp(v00, v10, u1);
  const b = lerp(v01, v11, u1);
  return lerp(a, b, v1);
}

type NoiseBank = {
  period: number;
  base: Float32Array[];
  warpX: Float32Array[];
  warpY: Float32Array[];
  detail: Float32Array[];
};

function makeNoiseBank(seed: number, period: number): NoiseBank {
  const mk = (s: number, count: number) =>
    Array.from({ length: count }, (_, i) => makeNoiseGrid((s + i * 1013) & 0x7fffffff, period));

  return {
    period,
    base: mk(seed, 5),
    warpX: mk((seed + 9001) & 0x7fffffff, 3),
    warpY: mk((seed + 1337) & 0x7fffffff, 3),
    detail: mk((seed + 4242) & 0x7fffffff, 2)
  };
}

function fbm(
  bank: NoiseBank,
  grids: Float32Array[],
  u: number,
  v: number,
  gain = 0.5,
  octaves = grids.length,
  lacunarity = 2
) {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  const n = Math.min(grids.length, Math.max(1, Math.floor(octaves)));
  for (let i = 0; i < n; i++) {
    sum += amp * valueNoise2D(grids[i]!, bank.period, u * freq, v * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

function ridged(x: number) {
  return 1 - Math.abs(2 * x - 1);
}

type TextureStyle = {
  kind: "tech" | "organic" | "cloud" | "generic";
  warp: number;
  contrast: number;
  gridFreq: number;
  scanFreq: number;
};

function chooseTextureStyle(prompt: string, seed: number): TextureStyle {
  const p = prompt.toLowerCase();
  const rand = mulberry32(seed ^ 0x9e3779b9);

  const techKeys = ["cyber", "neon", "tech", "grid", "circuit", "scanline"];
  const cloudKeys = ["nebula", "cloud", "smoke", "mist", "dreamy"];
  const organicKeys = ["organic", "lava", "fire", "liquid", "fluid", "marble", "stone"];

  const hasAny = (keys: string[]) => keys.some((k) => p.includes(k));

  const kind = hasAny(techKeys)
    ? ("tech" as const)
    : hasAny(cloudKeys)
      ? ("cloud" as const)
      : hasAny(organicKeys)
        ? ("organic" as const)
        : ("generic" as const);

  const warp = kind === "tech" ? 0.18 : kind === "cloud" ? 0.32 : 0.26;
  const contrast = kind === "tech" ? 1.25 : kind === "cloud" ? 1.05 : 1.15;

  const gridFreq = kind === "tech" ? clampInt(10 + rand() * 14, 10, 24) : 0;
  const scanFreq = kind === "tech" ? clampInt(4 + rand() * 10, 4, 14) : 0;

  return { kind, warp, contrast, gridFreq, scanFreq };
}

function chooseNoisePeriod(w: number, h: number) {
  // Aim for large coherent shapes (~96px cells) instead of TV static.
  const target = Math.round(Math.min(w, h) / 96);
  return clampInt(target, 4, 32);
}

function sampleTexture(
  pal: Palette,
  bank: NoiseBank,
  style: TextureStyle,
  u: number,
  v: number
) {
  const warpOctaves = style.kind === "tech" ? 1 : 2;
  const baseOctaves =
    style.kind === "cloud" ? 4 : style.kind === "organic" ? 4 : 3;

  const wx = fbm(bank, bank.warpX, u, v, 0.62, warpOctaves, 2);
  const wy = fbm(bank, bank.warpY, u + 11.1, v + 5.7, 0.62, warpOctaves, 2);
  const uu = u + (wx - 0.5) * style.warp;
  const vv = v + (wy - 0.5) * style.warp;

  const base = fbm(bank, bank.base, uu, vv, 0.45, baseOctaves, 2);
  const det = fbm(bank, bank.detail, uu + 2.3, vv - 4.1, 0.5, 1, 2);
  const r = ridged(base);

  // Blend a coherent base with gentle detail (keeps it "texture" not "TV static").
  let value = clamp01(base * 0.92 + r * 0.08 + (det - 0.5) * 0.04);

  // Contrast shaping.
  value = clamp01(Math.pow(value, 1 / style.contrast));

  // Tech overlays.
  let grid = 0;
  let scan = 0;
  if (style.kind === "tech" && style.gridFreq > 0) {
    const gx = Math.abs(fract(uu * style.gridFreq) - 0.5);
    const gy = Math.abs(fract(vv * style.gridFreq) - 0.5);
    const lineX = 1 - smoothstep(0.02, 0.1, gx);
    const lineY = 1 - smoothstep(0.02, 0.1, gy);
    grid = clamp01(Math.max(lineX, lineY));

    if (style.scanFreq > 0) {
      scan = 0.5 + 0.5 * Math.sin((vv * style.scanFreq + base * 0.8) * Math.PI * 2);
      scan = clamp01((scan - 0.5) * 0.65 + 0.35);
    }
  }

  const m1 = smoothstep(0.08, 0.92, value);
  const m2 = smoothstep(0.35, 0.97, r);

  let col = lerp3(pal.a, pal.b, m1);
  col = lerp3(col, pal.c, m2 * 0.65);

  if (style.kind === "tech") {
    const accent = clamp01(grid * 0.95 + scan * 0.35);
    col = lerp3(col, pal.d, accent);
  } else if (style.kind === "organic") {
    const hot = smoothstep(0.65, 0.92, r);
    col = lerp3(col, pal.d, hot * 0.45);
  }

  // Subtle grain so it doesn't look banded in shaders, but never dominates.
  const xi = mod(Math.floor(uu * 8192), 8192);
  const yi = mod(Math.floor(vv * 8192), 8192);
  const gi =
    (Math.imul(xi, 0x1b873593) ^
      Math.imul(yi, 0x85ebca6b) ^
      Math.imul(pal.baseHue | 0, 0xc2b2ae35)) |
    0;
  const grain = (hashFloat01(gi) - 0.5) * 0.006;
  col = add3(col, [grain, grain, grain]);

  return [
    clamp01(col[0]),
    clamp01(col[1]),
    clamp01(col[2])
  ] as [number, number, number];
}

async function generatePng(opts: {
  type: "texture" | "lut" | "envmap" | "keyframe";
  prompt: string;
  width: number;
  height: number;
  seed: number;
  tiling: boolean;
}) {
  const { prompt, seed } = opts;
  const png = new PNG({ width: opts.width, height: opts.height });
  const pal = derivePalette(prompt, seed);
  const style = chooseTextureStyle(prompt, seed);
  const bank = makeNoiseBank(seed, chooseNoisePeriod(opts.width, opts.height));

  if (opts.type === "lut") {
    const w = opts.width;
    const h = opts.height;
    const cube = Math.max(2, Math.round(Math.cbrt(w * h)));
    const denom = Math.max(1, cube - 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx3 = y * w + x;
        const rI = idx3 % cube;
        const gI = Math.floor(idx3 / cube) % cube;
        const bI = Math.floor(idx3 / (cube * cube));

        const rr = rI / denom;
        const gg = gI / denom;
        const bb = Math.min(denom, bI) / denom;

        const idx = (y * w + x) << 2;
        png.data[idx + 0] = Math.round(clamp01(rr) * 255);
        png.data[idx + 1] = Math.round(clamp01(gg) * 255);
        png.data[idx + 2] = Math.round(clamp01(bb) * 255);
        png.data[idx + 3] = 255;
      }
    }
    return PNG.sync.write(png, { colorType: 6 });
  }

  for (let y = 0; y < opts.height; y++) {
    const fy =
      opts.tiling ? y / Math.max(1, opts.height - 1) : y / Math.max(1, opts.height);
    for (let x = 0; x < opts.width; x++) {
      const fx =
        opts.tiling ? x / Math.max(1, opts.width - 1) : x / Math.max(1, opts.width);

      const [rr, gg, bb] = sampleTexture(pal, bank, style, fx, fy);

      const idx = (y * opts.width + x) << 2;
      png.data[idx + 0] = Math.round(clamp01(rr) * 255);
      png.data[idx + 1] = Math.round(clamp01(gg) * 255);
      png.data[idx + 2] = Math.round(clamp01(bb) * 255);
      png.data[idx + 3] = 255;
    }
  }

  const buf = PNG.sync.write(png, { colorType: 6 });
  return buf;
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "asset-gen" }));

app.post("/generate", async (req, res) => {
  const parsed = GenerateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  const { prompt } = parsed.data;
  const type = parsed.data.type ?? "texture";
  const size = parsed.data.size ?? (type === "envmap" ? { w: 1024, h: 512 } : 512);
  const dims = typeof size === "number" ? { w: size, h: size } : { w: size.w, h: size.h };
  const seed = parsed.data.seed ?? hashToSeed(prompt);
  const tiling = Boolean(parsed.data.tiling);

  const algo = "procedural:v3";
  const id = crypto
    .createHash("sha1")
    .update(`${algo}\n${type}\n${prompt}\n${dims.w}x${dims.h}\n${seed}\n${tiling ? "tiling" : "no-tiling"}`)
    .digest("hex")
    .slice(0, 16);

  const cacheDir = path.resolve(process.cwd(), "..", "..", ".cache", "assets");
  await fs.mkdir(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, `${id}.png`);

  try {
    const cached = await fs.readFile(outPath);
    res.json({
      ok: true,
      id,
      pngBase64: cached.toString("base64")
    });
    return;
  } catch {
    // cache miss
  }

  const png = await generatePng({ type, prompt, width: dims.w, height: dims.h, seed, tiling });
  await fs.writeFile(outPath, png);

  res.json({
    ok: true,
    id,
    pngBase64: png.toString("base64")
  });
});

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[asset-gen] http://${HOST}:${PORT}`);
});

