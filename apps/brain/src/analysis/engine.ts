import FFT from "fft.js";
import type { BrainToVisualizerMessage } from "@audviz/protocol";
import { AudioClassifierClient } from "./classifier-client.js";
import { GENRE_LABELS } from "./labels.js";

type EngineConfig = {
  sampleRate: number;
  channels: 1 | 2;
  frameSize: number;
  spectrumBins: number;
};

type EngineOptions = {
  onMessage: (msg: BrainToVisualizerMessage) => void;
};

type Status = {
  sampleRate: number | null;
  channels: number | null;
  frameSize: number | null;
  spectrumBins: number;
  seconds: number;
  bpm: number | null;
  bpmConfidence: number;
  energy: number;
  silence: boolean;
};

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function rms(frame: Float32Array) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function variance(values: number[], m: number) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) {
    const d = v - m;
    sum += d * d;
  }
  return sum / values.length;
}

function avgRange(values: number[], start: number, end: number) {
  const s = Math.max(0, start | 0);
  const e = Math.max(s, end | 0);
  let sum = 0;
  let count = 0;
  for (let i = s; i < e && i < values.length; i++) {
    sum += values[i] ?? 0;
    count++;
  }
  return count ? sum / count : 0;
}

export class AnalysisEngine {
  private cfg: EngineConfig = {
    sampleRate: 0,
    channels: 1,
    frameSize: 1024,
    spectrumBins: 64
  };
  private configured = false;
  private fft: FFT | null = null;
  private onMessage: EngineOptions["onMessage"];

  private tmpFrame: Float32Array | null = null;
  private frameIndex = 0;
  private sampleCounter = 0;

  private energyEma = 0;
  private energyFloor = 0.002;
  private energyCeil = 0.08;

  private prevMag: Float32Array | null = null;
  private fluxHistory: number[] = [];
  private fluxTimes: number[] = [];
  private lastBeatTime = -999;
  private beatTimes: number[] = [];

  private lastEnergySentAt = 0;
  private lastSpectrumSentAt = 0;
  private lastClassSentAt = 0;
  private silence = true;
  private silenceSince = 0;

  private bpm: number | null = null;
  private bpmConfidence = 0;

  private shortEnergy = 0;
  private longEnergy = 0;
  private energyDelta = 0;
  private lastSection: string | null = null;
  private lastSectionAt = -999;
  private lastDropAt = -999;
  private lastBreakAt = -999;

  private lastSpectrumBins: number[] | null = null;
  private genreEma: number[] | null = null;
  private genreTop: (typeof GENRE_LABELS)[number] = "Techno";
  private lastGenreChangeAt = -999;
  private moodValenceEma = 0.5;
  private moodArousalEma = 0.5;
  private vocalProbEma = 0;

  private classifier: AudioClassifierClient | null = null;
  private workerGenreDist: Record<string, number> | null = null;
  private workerGenreAt = -999;

  constructor(opts: EngineOptions) {
    this.onMessage = opts.onMessage;
  }

  configure(partial: Partial<EngineConfig>) {
    this.cfg = { ...this.cfg, ...partial };
    if (this.cfg.sampleRate > 0 && this.cfg.frameSize > 0) {
      this.configured = true;
      this.fft = new FFT(this.cfg.frameSize);
      this.tmpFrame = new Float32Array(this.cfg.frameSize);
      this.prevMag = new Float32Array(this.cfg.frameSize / 2);
      this.fluxHistory = [];
      this.fluxTimes = [];
      this.beatTimes = [];
      this.lastBeatTime = -999;
      this.frameIndex = 0;
      this.sampleCounter = 0;
      this.energyEma = 0;
      this.bpm = null;
      this.bpmConfidence = 0;
      this.silence = true;
      this.silenceSince = 0;
      this.shortEnergy = 0;
      this.longEnergy = 0;
      this.energyDelta = 0;
      this.lastSection = null;
      this.lastSectionAt = -999;
      this.lastDropAt = -999;
      this.lastBreakAt = -999;

      this.lastSpectrumBins = null;
      this.genreEma = null;
      this.genreTop = "Techno";
      this.lastGenreChangeAt = -999;
      this.moodValenceEma = 0.5;
      this.moodArousalEma = 0.5;
      this.vocalProbEma = 0;

      this.workerGenreDist = null;
      this.workerGenreAt = -999;

      try {
        this.classifier?.dispose();
      } catch {
        // ignore
      }
      this.classifier = null;
      const mode = (process.env.AUDIO_CLASSIFIER ?? "worker").toLowerCase();
      if (mode !== "off") {
        this.classifier = new AudioClassifierClient(this.cfg.sampleRate, (dist, at) => {
          this.workerGenreDist = dist;
          this.workerGenreAt = at;
        });
      }
    }
  }

  getStatus(): Status {
    return {
      sampleRate: this.configured ? this.cfg.sampleRate : null,
      channels: this.configured ? this.cfg.channels : null,
      frameSize: this.configured ? this.cfg.frameSize : null,
      spectrumBins: this.cfg.spectrumBins,
      seconds: this.configured
        ? this.sampleCounter / this.cfg.sampleRate
        : 0,
      bpm: this.bpm,
      bpmConfidence: this.bpmConfidence,
      energy: clamp01(this.energyEma),
      silence: this.silence
    };
  }

  pushPcmFrame(buffer: Buffer) {
    if (!this.configured || !this.tmpFrame || !this.fft) return;
    if (buffer.byteLength !== this.cfg.frameSize * 4) return;

    const frame = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      this.cfg.frameSize
    );
    this.processFrame(frame);
  }

  private processFrame(frame: Float32Array) {
    const t = this.sampleCounter / this.cfg.sampleRate;
    this.sampleCounter += frame.length;
    this.frameIndex++;

    this.classifier?.pushPcmFrame(frame);

    const e = rms(frame);
    const alpha = 0.08;
    this.energyEma = this.energyEma * (1 - alpha) + e * alpha;

    // adaptive normalization
    this.energyFloor = Math.min(this.energyFloor * 0.9995 + e * 0.0005, 0.05);
    this.energyCeil = Math.max(this.energyCeil * 0.9995 + e * 0.0005, 0.06);
    const energyNorm = clamp01(
      (this.energyEma - this.energyFloor) / (this.energyCeil - this.energyFloor)
    );

    this.updateSectionHeuristics(t, energyNorm);

    const silenceNow = energyNorm < 0.03;
    if (silenceNow) {
      if (!this.silence) this.silenceSince = t;
      this.silence = true;
    } else {
      if (this.silence && t - this.silenceSince > 0.3) {
        this.silence = false;
        this.onMessage({ silence: false });
      }
    }
    if (this.silence && t - this.silenceSince > 1.0) {
      // only send once
      if (!silenceNow) return;
      if (this.silenceSince !== 0 && Math.abs(t - this.silenceSince - 1.0) < 0.03) {
        this.onMessage({ silence: true });
      }
    }

    // Send energy at ~30Hz
    if (t - this.lastEnergySentAt >= 1 / 30) {
      this.lastEnergySentAt = t;
      this.onMessage({ energy: energyNorm });
    }

    const { mag, flux } = this.computeSpectrumAndFlux(frame);
    this.pushFlux(t, flux);

    const beat = this.detectBeat(t);
    if (beat) {
      this.onMessage({ event: "beat", time: t, phase: 0 });
    }

    // send spectrum at ~20Hz
    if (t - this.lastSpectrumSentAt >= 1 / 20) {
      this.lastSpectrumSentAt = t;
      const bins = this.downsampleSpectrum(mag, this.cfg.spectrumBins);
      this.lastSpectrumBins = bins;
      this.onMessage({ spectrum: bins });
    }

    // classification at ~1Hz (heuristic v1; replace with model inference later)
    if (t - this.lastClassSentAt >= 1.0 && this.lastSpectrumBins) {
      this.lastClassSentAt = t;
      this.emitClassification(t, energyNorm, this.lastSpectrumBins);
    }

    this.classifier?.maybeClassify(t, { bpm: this.bpm ?? 120, energy: energyNorm });
  }

  private updateSectionHeuristics(t: number, energy: number) {
    // Short/long moving averages to detect "drop" style energy surges.
    const shortA = 0.25;
    const longA = 0.02;

    const prevShort = this.shortEnergy;
    this.shortEnergy = this.shortEnergy * (1 - shortA) + energy * shortA;
    this.longEnergy = this.longEnergy * (1 - longA) + energy * longA;
    this.energyDelta = this.shortEnergy - prevShort;

    const cooldown = 2.5;
    const sectionCooldown = 1.0;

    const canEmit = t - this.lastSectionAt > sectionCooldown;

    const isDrop =
      canEmit &&
      t - this.lastDropAt > cooldown &&
      this.longEnergy < 0.42 &&
      this.shortEnergy > 0.68 &&
      this.energyDelta > 0.08;

    const isBreak =
      canEmit &&
      t - this.lastBreakAt > cooldown &&
      this.longEnergy > 0.55 &&
      this.shortEnergy < 0.33 &&
      this.energyDelta < -0.06;

    if (isDrop) {
      this.lastDropAt = t;
      this.emitSection(t, "Drop");
      return;
    }

    if (isBreak) {
      this.lastBreakAt = t;
      this.emitSection(t, "Break");
      return;
    }

    // Build: sustained rise (helps drive pre-drop switching)
    const build =
      canEmit &&
      this.longEnergy < 0.6 &&
      this.shortEnergy > 0.45 &&
      this.energyDelta > 0.02 &&
      t - this.lastDropAt > 1.0;
    if (build) {
      this.emitSection(t, "Build");
    }
  }

  private emitSection(t: number, section: string) {
    if (this.lastSection === section) return;
    this.lastSection = section;
    this.lastSectionAt = t;
    this.onMessage({ section });
  }

  private computeSpectrumAndFlux(frame: Float32Array) {
    if (!this.fft || !this.prevMag) throw new Error("FFT not initialized");

    const out = this.fft.createComplexArray();
    this.fft.realTransform(out, frame);
    this.fft.completeSpectrum(out);

    const half = this.cfg.frameSize / 2;
    const mag = new Float32Array(half);
    let flux = 0;
    for (let i = 0; i < half; i++) {
      const re = out[2 * i] ?? 0;
      const im = out[2 * i + 1] ?? 0;
      const m = Math.sqrt(re * re + im * im);
      mag[i] = m;
      const diff = m - this.prevMag[i]!;
      if (diff > 0) flux += diff;
      this.prevMag[i] = m;
    }
    flux = flux / half;
    return { mag, flux };
  }

  private pushFlux(t: number, flux: number) {
    // Keep ~8 seconds of history (frameSize 1024 @ 48k => ~375 frames)
    const maxLen = Math.ceil((8 * this.cfg.sampleRate) / this.cfg.frameSize);
    this.fluxHistory.push(flux);
    this.fluxTimes.push(t);
    if (this.fluxHistory.length > maxLen) {
      this.fluxHistory.shift();
      this.fluxTimes.shift();
    }
  }

  private detectBeat(t: number) {
    const n = this.fluxHistory.length;
    if (n < 12) return false;

    const lookback = 8; // ~170ms at 1024/48k
    const window = this.fluxHistory.slice(Math.max(0, n - 1 - lookback), n);
    const m = mean(window);
    const threshold = m * 2.2;

    const cur = this.fluxHistory[n - 1]!;
    const prev = this.fluxHistory[n - 2]!;
    const prev2 = this.fluxHistory[n - 3]!;

    // rising edge + over threshold
    const peakish = prev > prev2 && cur < prev;
    const candidate = prev > threshold && peakish;

    if (!candidate) return false;

    const beatTime = this.fluxTimes[n - 2]!;
    if (beatTime - this.lastBeatTime < 0.22) return false; // avoid double triggers
    this.lastBeatTime = beatTime;

    this.beatTimes.push(beatTime);
    if (this.beatTimes.length > 16) this.beatTimes.shift();

    this.updateBpmEstimate();
    return true;
  }

  private updateBpmEstimate() {
    if (this.beatTimes.length < 6) return;
    const intervals: number[] = [];
    for (let i = 1; i < this.beatTimes.length; i++) {
      intervals.push(this.beatTimes[i]! - this.beatTimes[i - 1]!);
    }
    const avg = mean(intervals);
    if (avg <= 0) return;
    let bpm = 60 / avg;

    // fold into a reasonable range
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;

    const m = mean(intervals);
    const v = variance(intervals, m);
    const jitter = Math.sqrt(v);
    const confidence = clamp01(1 - jitter / 0.08);

    const prevBpm = this.bpm;
    this.bpm = Math.round(bpm * 10) / 10;
    this.bpmConfidence = confidence;

    if (!prevBpm || Math.abs(prevBpm - this.bpm) > 0.5) {
      this.onMessage({ bpm: this.bpm, confidence: this.bpmConfidence });
    } else if (Math.random() < 0.1) {
      // occasional refresh
      this.onMessage({ bpm: this.bpm, confidence: this.bpmConfidence });
    }
  }

  private downsampleSpectrum(mag: Float32Array, bins: number) {
    const out = new Array<number>(bins).fill(0);
    const len = mag.length;
    const step = len / bins;
    for (let b = 0; b < bins; b++) {
      const start = Math.floor(b * step);
      const end = Math.floor((b + 1) * step);
      let sum = 0;
      let count = 0;
      for (let i = start; i < end; i++) {
        const v = mag[i] ?? 0;
        sum += v;
        count++;
      }
      const avg = count ? sum / count : 0;
      // compress dynamic range
      out[b] = Math.log1p(avg) / 6;
    }
    // normalize to ~0..1
    const max = Math.max(...out, 1e-6);
    for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i]! / max);
    return out;
  }

  private emitClassification(t: number, energy: number, bins: number[]) {
    const n = bins.length;
    if (n < 8) return;

    const b0 = Math.max(1, Math.floor((n * 10) / 64));
    const b1 = Math.max(b0 + 1, Math.floor((n * 28) / 64));
    const bass = clamp01(avgRange(bins, 0, b0));
    const mid = clamp01(avgRange(bins, b0, b1));
    const treble = clamp01(avgRange(bins, b1, n));

    this.onMessage({ bands: { bass, mid, treble } });

    const bpm = this.bpm ?? 120;
    const rawDist =
      this.workerGenreDist && t - this.workerGenreAt < 4.5
        ? this.workerGenreDist
        : this.computeGenreDist({ bpm, energy, bass, mid, treble });
    const genre = this.updateGenreState(t, rawDist);
    this.onMessage({ genre });

    const mood = this.computeMood({ bpm, energy, bass, mid, treble });
    this.onMessage({ mood });

    const vocal = this.computeVocal({ energy, bass, mid, treble });
    this.onMessage({ vocal });
  }

  private computeGenreDist(input: {
    bpm: number;
    energy: number;
    bass: number;
    mid: number;
    treble: number;
  }): Record<string, number> {
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
      scores.Dubstep += 0.6 * (0.25 + 0.75 * energy) * (0.65 + 0.35 * bass) * (0.75 - 0.35 * treble);
    } else if (bpm >= 115) {
      scores.House += 0.85 * (0.35 + 0.65 * energy) * (0.4 + 0.6 * mid);
      scores.Techno += 0.35 * (0.25 + 0.75 * energy);
    } else {
      scores["Hip-Hop"] += 0.95 * (0.3 + 0.7 * bass) * (0.35 + 0.65 * energy);
      scores.Ambient += 0.35 * (1 - energy) * (0.6 + 0.4 * (1 - treble));
    }

    // Ambient boost on low energy regardless of BPM.
    if (energy < 0.35) scores.Ambient += (0.35 - energy) * 2.2;

    // Normalize to probs.
    const vec = GENRE_LABELS.map((g) => Math.max(1e-4, scores[g]));
    const sum = vec.reduce((a, b) => a + b, 0);
    const out: Record<string, number> = {};
    for (let i = 0; i < GENRE_LABELS.length; i++) {
      const label = GENRE_LABELS[i]!;
      out[label] = clamp01(vec[i]! / sum);
    }
    return out;
  }

  private updateGenreState(t: number, dist: Record<string, number>) {
    const alpha = 0.25;
    const cur = GENRE_LABELS.map((g) => clamp01(dist[g] ?? 0));
    if (!this.genreEma) {
      this.genreEma = cur;
    } else {
      for (let i = 0; i < cur.length; i++) {
        this.genreEma[i] = this.genreEma[i]! * (1 - alpha) + cur[i]! * alpha;
      }
      const sum = this.genreEma.reduce((a, b) => a + b, 0);
      if (sum > 1e-6) {
        for (let i = 0; i < this.genreEma.length; i++) {
          this.genreEma[i] = (this.genreEma[i] ?? 0) / sum;
        }
      }
    }

    let topIdx = 0;
    let topProb = this.genreEma[0] ?? 0;
    for (let i = 1; i < this.genreEma.length; i++) {
      const p = this.genreEma[i] ?? 0;
      if (p > topProb) {
        topProb = p;
        topIdx = i;
      }
    }
    const proposedTop = GENRE_LABELS[topIdx] ?? "Techno";

    const curIdx = GENRE_LABELS.indexOf(this.genreTop);
    const curProb = curIdx >= 0 ? (this.genreEma[curIdx] ?? 0) : 0;

    const timeSinceChange = t - this.lastGenreChangeAt;
    const shouldHold =
      proposedTop !== this.genreTop &&
      timeSinceChange < 15 &&
      curProb > 0.55 &&
      topProb < curProb + 0.12;

    if (!shouldHold && proposedTop !== this.genreTop) {
      this.genreTop = proposedTop;
      this.lastGenreChangeAt = t;
    }

    const finalIdx = GENRE_LABELS.indexOf(this.genreTop);
    const finalProb = finalIdx >= 0 ? (this.genreEma[finalIdx] ?? topProb) : topProb;

    const outDist: Record<string, number> = {};
    for (let i = 0; i < GENRE_LABELS.length; i++) {
      const label = GENRE_LABELS[i]!;
      outDist[label] = clamp01(this.genreEma[i] ?? 0);
    }

    return { top: this.genreTop, prob: clamp01(finalProb), dist: outDist };
  }

  private computeMood(input: {
    bpm: number;
    energy: number;
    bass: number;
    mid: number;
    treble: number;
  }): { valence: number; arousal: number; confidence: number } {
    const bpm = Math.max(60, Math.min(190, input.bpm));
    const energy = clamp01(input.energy);
    const bass = clamp01(input.bass);
    const mid = clamp01(input.mid);
    const treble = clamp01(input.treble);

    const bpmDrive = clamp01((bpm - 80) / 100);
    const arousalRaw = clamp01(0.55 * energy + 0.25 * bpmDrive + 0.2 * bass);
    const valenceRaw = clamp01(0.55 + 0.35 * (treble - 0.75 * bass) + 0.1 * (mid - 0.5));

    const alpha = 0.18;
    this.moodValenceEma = this.moodValenceEma * (1 - alpha) + valenceRaw * alpha;
    this.moodArousalEma = this.moodArousalEma * (1 - alpha) + arousalRaw * alpha;

    const confidence = clamp01(0.35 + 0.65 * (0.6 * energy + 0.4 * (1 - Math.abs(mid - treble))));

    return {
      valence: clamp01(this.moodValenceEma),
      arousal: clamp01(this.moodArousalEma),
      confidence
    };
  }

  private computeVocal(input: {
    energy: number;
    bass: number;
    mid: number;
    treble: number;
  }): { present: boolean; prob: number } {
    const energy = clamp01(input.energy);
    const bass = clamp01(input.bass);
    const mid = clamp01(input.mid);
    const treble = clamp01(input.treble);

    const raw = clamp01((mid - 0.6 * bass) * 1.4 + (treble - 0.25) * 0.35 + (energy - 0.2) * 0.25);
    const alpha = 0.2;
    this.vocalProbEma = this.vocalProbEma * (1 - alpha) + raw * alpha;
    const prob = clamp01(this.vocalProbEma);
    return { present: prob > 0.6, prob };
  }
}
