import FFT from "fft.js";
import { parentPort } from "node:worker_threads";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CLASSIFIER_FFT_SIZE,
  CLASSIFIER_FRAMES,
  CLASSIFIER_HOP_SIZE,
  CLASSIFIER_MEL_BINS
} from "./classifier-config.js";
import { GENRE_LABELS } from "./labels.js";

type GenreDist = Record<string, number>;

type ClassifyMsg = {
  type: "classify";
  id: number;
  timeSec: number;
  sampleRate: number;
  bpm: number;
  energy: number;
  pcm: Float32Array;
};

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function hzToMel(hz: number) {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number) {
  return 700 * (10 ** (mel / 2595) - 1);
}

type MelBank = {
  bins: number[];
  sampleRate: number;
};

function buildMelBank(sampleRate: number) {
  const fMin = 0;
  const fMax = sampleRate / 2;
  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);

  const points = new Array(CLASSIFIER_MEL_BINS + 2)
    .fill(0)
    .map((_, i) => melMin + ((melMax - melMin) * i) / (CLASSIFIER_MEL_BINS + 1))
    .map(melToHz)
    .map((hz) => Math.floor(((CLASSIFIER_FFT_SIZE + 1) * hz) / sampleRate));

  return { bins: points, sampleRate } satisfies MelBank;
}

const hann = (() => {
  const w = new Float32Array(CLASSIFIER_FFT_SIZE);
  for (let i = 0; i < w.length; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (w.length - 1)));
  }
  return w;
})();

const fft = new FFT(CLASSIFIER_FFT_SIZE);
const fftIn = new Float32Array(CLASSIFIER_FFT_SIZE);
const fftOut = fft.createComplexArray();

let melBank: MelBank | null = null;

function computeLogMelFrames(pcm: Float32Array, sampleRate: number) {
  if (!melBank || melBank.sampleRate !== sampleRate) {
    melBank = buildMelBank(sampleRate);
  }
  const bins = melBank.bins;

  const nfftBins = CLASSIFIER_FFT_SIZE / 2 + 1;
  const power = new Float32Array(nfftBins);
  const frames = new Float32Array(CLASSIFIER_FRAMES * CLASSIFIER_MEL_BINS);

  for (let f = 0; f < CLASSIFIER_FRAMES; f++) {
    const start = f * CLASSIFIER_HOP_SIZE;
    for (let i = 0; i < CLASSIFIER_FFT_SIZE; i++) {
      const s = pcm[start + i] ?? 0;
      fftIn[i] = s * (hann[i] ?? 1);
    }
    fft.realTransform(fftOut as any, fftIn as any);
    fft.completeSpectrum(fftOut as any);

    for (let k = 0; k < nfftBins; k++) {
      const re = fftOut[2 * k] ?? 0;
      const im = fftOut[2 * k + 1] ?? 0;
      power[k] = re * re + im * im;
    }

    for (let m = 0; m < CLASSIFIER_MEL_BINS; m++) {
      const left = bins[m] ?? 0;
      const center = bins[m + 1] ?? left + 1;
      const right = bins[m + 2] ?? center + 1;

      let sum = 0;
      const leftDen = Math.max(1, center - left);
      const rightDen = Math.max(1, right - center);

      for (let k = left; k < center && k < nfftBins; k++) {
        const w = (k - left) / leftDen;
        sum += (power[k] ?? 0) * w;
      }
      for (let k = center; k < right && k < nfftBins; k++) {
        const w = (right - k) / rightDen;
        sum += (power[k] ?? 0) * w;
      }

      const idx = f * CLASSIFIER_MEL_BINS + m;
      frames[idx] = Math.log1p(Math.max(0, sum));
    }
  }

  return frames;
}

function bandsFromMelFrames(frames: Float32Array) {
  const m = CLASSIFIER_MEL_BINS;
  const framesCount = CLASSIFIER_FRAMES;
  const meanMel = new Float32Array(m);

  for (let f = 0; f < framesCount; f++) {
    const off = f * m;
    for (let i = 0; i < m; i++) {
      meanMel[i] = (meanMel[i] ?? 0) + (frames[off + i] ?? 0);
    }
  }
  for (let i = 0; i < m; i++) {
    meanMel[i] = (meanMel[i] ?? 0) / Math.max(1, framesCount);
  }

  let max = 1e-6;
  for (let i = 0; i < m; i++) max = Math.max(max, meanMel[i] ?? 0);
  for (let i = 0; i < m; i++) meanMel[i] = clamp01((meanMel[i] ?? 0) / max);

  const bass = mean(Array.from(meanMel.subarray(0, Math.floor(m * 0.22))));
  const mid = mean(
    Array.from(meanMel.subarray(Math.floor(m * 0.22), Math.floor(m * 0.58)))
  );
  const treble = mean(Array.from(meanMel.subarray(Math.floor(m * 0.58))));

  return { bass: clamp01(bass), mid: clamp01(mid), treble: clamp01(treble) };
}

function computeGenreDistHeuristic(input: {
  bpm: number;
  energy: number;
  bass: number;
  mid: number;
  treble: number;
}): GenreDist {
  const bpm = Math.max(60, Math.min(190, input.bpm));
  const energy = clamp01(input.energy);
  const bass = clamp01(input.bass);
  const mid = clamp01(input.mid);
  const treble = clamp01(input.treble);

  const scores: Record<(typeof GENRE_LABELS)[number], number> = {
    Techno: 0.25,
    House: 0.25,
    "Drum & Bass": 0.12,
    Trance: 0.12,
    Dubstep: 0.12,
    "Hip-Hop": 0.12,
    Ambient: 0.12
  };

  if (bpm >= 155) {
    scores["Drum & Bass"] += 1.1 * (0.4 + 0.6 * energy) * (0.6 + 0.4 * treble);
    scores.Techno += 0.15 * energy;
  } else if (bpm >= 135) {
    scores.Techno += 0.75 * (0.35 + 0.65 * energy) * (0.5 + 0.5 * bass);
    scores.Trance += 0.55 * (0.3 + 0.7 * energy) * (0.55 + 0.45 * treble);
    scores.Dubstep +=
      0.6 *
      (0.25 + 0.75 * energy) *
      (0.65 + 0.35 * bass) *
      (0.75 - 0.35 * treble);
  } else if (bpm >= 115) {
    scores.House += 0.85 * (0.35 + 0.65 * energy) * (0.4 + 0.6 * mid);
    scores.Techno += 0.35 * (0.25 + 0.75 * energy);
  } else {
    scores["Hip-Hop"] += 0.95 * (0.3 + 0.7 * bass) * (0.35 + 0.65 * energy);
    scores.Ambient += 0.35 * (1 - energy) * (0.6 + 0.4 * (1 - treble));
  }

  if (energy < 0.35) scores.Ambient += (0.35 - energy) * 2.2;

  const vec = GENRE_LABELS.map((g) => Math.max(1e-4, scores[g]));
  const sum = vec.reduce((a, b) => a + b, 0);
  const out: GenreDist = {};
  for (let i = 0; i < GENRE_LABELS.length; i++) {
    const label = GENRE_LABELS[i]!;
    out[label] = clamp01(vec[i]! / sum);
  }
  return out;
}

function resolveGenreModelPath() {
  const mtg = (process.env.MTG_JAMENDO_MODEL_PATH ?? "").trim();
  if (mtg) return mtg;

  const direct = (process.env.GENRE_MODEL_PATH ?? "").trim();
  if (direct) return direct;
  const dir = (process.env.MODELS_DIR ?? "").trim();
  if (dir) return path.resolve(dir, "genre.onnx");
  return path.resolve(process.cwd(), "..", "..", "models", "genre.onnx");
}

let ort: any | null = null;
let session: any | null = null;
let sessionInput: string | null = null;
let sessionOutput: string | null = null;
let sessionTried = false;

async function ensureOnnxSession() {
  if (sessionTried) return session != null;
  sessionTried = true;

  const modelPath = resolveGenreModelPath();
  try {
    await fs.access(modelPath);
  } catch {
    return false;
  }

  try {
    const imported = (await import("onnxruntime-node")) as any;
    ort = imported?.default ?? imported;
  } catch {
    return false;
  }

  try {
    session = await ort.InferenceSession.create(modelPath);
    sessionInput = session.inputNames?.[0] ?? null;
    sessionOutput = session.outputNames?.[0] ?? null;
    return Boolean(session && sessionInput && sessionOutput);
  } catch {
    session = null;
    sessionInput = null;
    sessionOutput = null;
    return false;
  }
}

function softmax(vec: Float32Array) {
  let max = -Infinity;
  for (let i = 0; i < vec.length; i++) max = Math.max(max, vec[i] ?? -Infinity);
  const out = new Float32Array(vec.length);
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = Math.exp((vec[i] ?? 0) - max);
    out[i] = v;
    sum += v;
  }
  const inv = sum > 1e-8 ? 1 / sum : 0;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * inv;
  return out;
}

function transposeFramesMel(frames: Float32Array) {
  const out = new Float32Array(CLASSIFIER_FRAMES * CLASSIFIER_MEL_BINS);
  for (let f = 0; f < CLASSIFIER_FRAMES; f++) {
    for (let m = 0; m < CLASSIFIER_MEL_BINS; m++) {
      out[m * CLASSIFIER_FRAMES + f] = frames[f * CLASSIFIER_MEL_BINS + m] ?? 0;
    }
  }
  return out;
}

function sigmoid(x: number) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

type TagLabel = { idx: number; label: string; score: number };

function normalizeMaybeSigmoid(raw: Float32Array) {
  let in01 = true;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i] ?? 0;
    if (v < 0 || v > 1) {
      in01 = false;
      break;
    }
  }
  if (in01) return raw;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = sigmoid(raw[i] ?? 0);
  return out;
}

async function loadLabelsFile() {
  const p = (process.env.GENRE_LABELS_PATH ?? "").trim();
  if (!p) return null;
  try {
    const raw = await fs.readFile(p, "utf8");
    const json = JSON.parse(raw) as unknown;
    if (!Array.isArray(json)) return null;
    const labels = json.filter((x) => typeof x === "string") as string[];
    return labels.length ? labels : null;
  } catch {
    return null;
  }
}

let cachedLabels: string[] | null | "loading" = null;
async function getModelLabels() {
  if (cachedLabels === "loading") return null;
  if (Array.isArray(cachedLabels)) return cachedLabels;
  cachedLabels = "loading";
  cachedLabels = await loadLabelsFile();
  return Array.isArray(cachedLabels) ? cachedLabels : null;
}

function labelsToTags(probs: Float32Array, labels: string[] | null): TagLabel[] {
  const out: TagLabel[] = [];
  for (let i = 0; i < probs.length; i++) {
    const label = labels?.[i] ?? `tag_${i}`;
    out.push({ idx: i, label, score: clamp01(probs[i] ?? 0) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function toCoreGenreDist(tags: TagLabel[]): GenreDist | null {
  const scores: Record<(typeof GENRE_LABELS)[number], number> = {
    Techno: 0,
    House: 0,
    "Drum & Bass": 0,
    Trance: 0,
    Dubstep: 0,
    "Hip-Hop": 0,
    Ambient: 0
  };

  let used = 0;
  for (const t of tags.slice(0, 40)) {
    const s = clamp01(t.score);
    if (s < 0.05) break;
    const label = t.label.toLowerCase();
    if (label.includes("techno")) scores.Techno += s;
    else if (label.includes("house")) scores.House += s;
    else if (label.includes("trance")) scores.Trance += s;
    else if (label.includes("drum") || label.includes("dnb") || label.includes("drumandbass") || label.includes("drum&bass"))
      scores["Drum & Bass"] += s;
    else if (label.includes("dubstep")) scores.Dubstep += s;
    else if (label.includes("hip hop") || label.includes("hip-hop") || label.includes("rap")) scores["Hip-Hop"] += s;
    else if (label.includes("ambient") || label.includes("chill") || label.includes("downtempo")) scores.Ambient += s;
    else continue;
    used++;
  }

  if (!used) return null;
  const vec = GENRE_LABELS.map((g) => Math.max(1e-6, scores[g]));
  const sum = vec.reduce((a, b) => a + b, 0);
  const dist: GenreDist = {};
  for (let i = 0; i < GENRE_LABELS.length; i++) dist[GENRE_LABELS[i]!] = vec[i]! / sum;
  return dist;
}

async function tryPredictGenreWithOnnx(frames: Float32Array): Promise<GenreDist | null> {
  if (!(await ensureOnnxSession())) return null;
  if (!session || !sessionInput || !sessionOutput || !ort) return null;

  const framesT = transposeFramesMel(frames);
  const candidates: Array<{ data: Float32Array; dims: number[] }> = [
    { data: frames, dims: [1, CLASSIFIER_FRAMES, CLASSIFIER_MEL_BINS] },
    { data: framesT, dims: [1, CLASSIFIER_MEL_BINS, CLASSIFIER_FRAMES] },
    { data: frames, dims: [1, 1, CLASSIFIER_FRAMES, CLASSIFIER_MEL_BINS] },
    { data: framesT, dims: [1, 1, CLASSIFIER_MEL_BINS, CLASSIFIER_FRAMES] }
  ];

  for (const c of candidates) {
    try {
      const feeds: Record<string, unknown> = {};
      feeds[sessionInput] = new ort.Tensor("float32", c.data, c.dims);
      const results = (await session.run(feeds)) as Record<string, any>;
      const out = results[sessionOutput];
      const data = (out?.data as Float32Array | undefined) ?? null;
      if (!data) continue;

      if (data.length === GENRE_LABELS.length) {
        const probs = softmax(data);
        const dist: GenreDist = {};
        for (let i = 0; i < GENRE_LABELS.length; i++) dist[GENRE_LABELS[i]!] = probs[i] ?? 0;
        return dist;
      }

      // MTG-Jamendo (and similar) taggers are often multi-label; map tags -> core genres using labels if provided.
      const labels = await getModelLabels();
      const probs = normalizeMaybeSigmoid(data);
      const tags = labelsToTags(probs, labels);
      const mapped = toCoreGenreDist(tags);
      if (mapped) return mapped;
    } catch {
      // try next shape
    }
  }
  return null;
}

async function classify(msg: ClassifyMsg) {
  const frames = computeLogMelFrames(msg.pcm, msg.sampleRate);
  const bands = bandsFromMelFrames(frames);

  const fromOnnx = await tryPredictGenreWithOnnx(frames);
  const dist = fromOnnx ?? computeGenreDistHeuristic({ bpm: msg.bpm, energy: msg.energy, ...bands });

  parentPort?.postMessage({ type: "result", id: msg.id, timeSec: msg.timeSec, genreDist: dist });
}

parentPort?.on("message", (raw: unknown) => {
  const msg = raw as Partial<ClassifyMsg>;
  if (!msg || msg.type !== "classify" || !(msg.pcm instanceof Float32Array)) return;
  if (typeof msg.id !== "number") return;
  void classify(msg as ClassifyMsg).catch((err) => {
    parentPort?.postMessage({
      type: "error",
      id: msg.id,
      message: String(err instanceof Error ? err.message : err)
    });
  });
});
