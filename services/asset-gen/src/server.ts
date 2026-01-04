import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express from "express";
import { PNG } from "pngjs";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.HOST ?? "127.0.0.1";

const GenerateRequestSchema = z.object({
  prompt: z.string().min(1).max(400),
  size: z.number().int().min(64).max(2048).optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional()
});

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
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

function derivePalette(prompt: string, seed: number) {
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
  }

  const a = hslToRgb(baseHue, sat, lumA);
  const b = hslToRgb((baseHue + 80) % 360, sat * 0.9, lumB);
  const c = hslToRgb((baseHue + 160) % 360, sat * 0.75, lumB * 0.9);
  return { a, b, c };
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function noise2(rand: () => number, x: number, y: number) {
  // Simple hash-like noise (not coherent), good enough for texture grit.
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  const f = v - Math.floor(v);
  return (f + rand() * 0.15) % 1;
}

async function generatePng(prompt: string, size: number, seed: number) {
  const png = new PNG({ width: size, height: size });
  const rand = mulberry32(seed);
  const pal = derivePalette(prompt, seed);

  const swirl = prompt.toLowerCase().includes("swirl") || prompt.toLowerCase().includes("tunnel");
  const sharp = prompt.toLowerCase().includes("grid") || prompt.toLowerCase().includes("tech");

  for (let y = 0; y < size; y++) {
    const fy = y / (size - 1);
    for (let x = 0; x < size; x++) {
      const fx = x / (size - 1);
      const cx = fx - 0.5;
      const cy = fy - 0.5;

      const r = Math.sqrt(cx * cx + cy * cy);
      const a = Math.atan2(cy, cx);

      let t = fx * 0.7 + fy * 0.3;
      if (swirl) t = (a / (Math.PI * 2) + 0.5) * 0.65 + r * 0.35;

      const grit = noise2(rand, x * 0.02, y * 0.02);
      const band = 0.5 + 0.5 * Math.sin((t * 10 + grit * 3) * Math.PI);
      const v = 0.55 * band + 0.45 * grit;

      let g = v;
      if (sharp) {
        const gx = Math.abs(((fx * 24) % 1) - 0.5);
        const gy = Math.abs(((fy * 24) % 1) - 0.5);
        const grid = 1 - smoothstep(0.46, 0.5, Math.min(gx, gy));
        g = clamp01(g * 0.75 + grid * 0.65);
      }

      const mix1 = clamp01(g);
      const mix2 = clamp01((g - 0.4) / 0.6);
      const c0 = pal.a;
      const c1 = pal.b;
      const c2 = pal.c;

      const rr = (c0[0] * (1 - mix1) + c1[0] * mix1) * (1 - mix2) + c2[0] * mix2;
      const gg = (c0[1] * (1 - mix1) + c1[1] * mix1) * (1 - mix2) + c2[1] * mix2;
      const bb = (c0[2] * (1 - mix1) + c1[2] * mix1) * (1 - mix2) + c2[2] * mix2;

      const idx = (y * size + x) << 2;
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
  const size = parsed.data.size ?? 512;
  const seed = parsed.data.seed ?? hashToSeed(prompt);

  const id = crypto
    .createHash("sha1")
    .update(`${prompt}\n${size}\n${seed}`)
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

  const png = await generatePng(prompt, size, seed);
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

