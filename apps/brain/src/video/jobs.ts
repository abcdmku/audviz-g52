import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import type {
  VideoFrameMeta,
  VideoGenerateRequest,
  VideoJobStatus
} from "@audviz/protocol";
import { VideoGenerateRequestSchema } from "@audviz/protocol";
import type { AssetRequest } from "@audviz/protocol";
import {
  fetchProceduralPng,
  fetchSdWebUiPng,
  fetchWithTimeout,
  hashToSeed,
  type AssetBackend
} from "../assets/backends.js";

type FrameRecord = {
  meta: VideoFrameMeta;
  fileName: string;
};

type VideoJobState = {
  jobId: string;
  status: VideoJobStatus["status"];
  progress?: number;
  videoId?: string;
  frames: VideoFrameMeta[];
  error?: string;
  createdAt: number;
  request: VideoGenerateRequest;
};

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function cacheDir() {
  return path.resolve(process.cwd(), "..", "..", ".cache", "video");
}

function framesDir() {
  return path.join(cacheDir(), "frames");
}

function sizeToDims(size: VideoGenerateRequest["size"]): { w: number; h: number } {
  if (typeof size === "number") return { w: size, h: size };
  return { w: size.w, h: size.h };
}

function chooseBaseDims(out: { w: number; h: number }) {
  const maxDim = Math.max(out.w, out.h);
  if (maxDim <= 768) return out;
  const scale = 512 / maxDim;
  return {
    w: Math.max(64, Math.round(out.w * scale)),
    h: Math.max(64, Math.round(out.h * scale))
  };
}

function extForFormat(format: VideoGenerateRequest["format"]) {
  if (format === "png") return "png";
  if (format === "jpg") return "jpg";
  return "webp";
}

function contentTypeForFormat(format: VideoGenerateRequest["format"]) {
  if (format === "png") return "image/png";
  if (format === "jpg") return "image/jpeg";
  return "image/webp";
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function keySeed(base: number, k: number) {
  return (base + k * 10_007) & 0x7fffffff;
}

async function fileExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function encodeFrame(
  inputPng: Buffer,
  opts: { format: VideoGenerateRequest["format"]; w: number; h: number }
): Promise<Buffer> {
  const imported = (await import("sharp")) as any;
  const sharp = (imported?.default ?? imported) as any;

  let img = sharp(inputPng).ensureAlpha();
  img = img.resize(opts.w, opts.h, { fit: "fill", kernel: "lanczos3" });

  if (opts.format === "png") return (await img.png().toBuffer()) as Buffer;
  if (opts.format === "jpg") {
    return (await img
      .flatten({ background: "#000" })
      .jpeg({ quality: 90, chromaSubsampling: "4:2:0" })
      .toBuffer()) as Buffer;
  }
  return (await img.webp({ quality: 88 }).toBuffer()) as Buffer;
}

async function blendPng(aPng: Buffer, bPng: Buffer, t: number): Promise<Buffer> {
  const imported = (await import("sharp")) as any;
  const sharp = (imported?.default ?? imported) as any;
  const opacity = clamp01(t);
  return (await sharp(aPng)
    .ensureAlpha()
    .composite([{ input: bPng, blend: "over", opacity }])
    .png()
    .toBuffer()) as Buffer;
}

function stableVideoKey(req: VideoGenerateRequest) {
  const s = sizeToDims(req.size);
  const tags = (req.styleTags ?? []).slice().sort().join(",");
  return [
    "video:v1",
    `prompt=${req.prompt}`,
    `neg=${req.negativePrompt ?? ""}`,
    `tags=${tags}`,
    `bpm=${req.bpm ?? ""}`,
    `energy=${req.energy ?? ""}`,
    `dur=${req.durationSec}`,
    `baseFps=${req.baseFps}`,
    `fps=${req.fps}`,
    `size=${s.w}x${s.h}`,
    `seed=${req.seed ?? ""}`,
    `fmt=${req.format}`,
    `backend=${req.backendHint ?? "auto"}`,
    `interp=${req.interpolation}`,
    `up=${req.upscaler}`
  ].join("\n");
}

async function backendIsReady(backend: AssetBackend) {
  try {
    if (backend === "procedural") {
      const r = await fetchWithTimeout("http://127.0.0.1:8790/health", { method: "GET" }, 800);
      return r.ok;
    }
    const base = (process.env.SD_WEBUI_URL ?? "").trim().replace(/\/+$/, "");
    if (!base) return false;
    const r = await fetchWithTimeout(`${base}/sdapi/v1/options`, { method: "GET" }, 1200);
    return r.ok;
  } catch {
    return false;
  }
}

async function chooseBackend(hint: VideoGenerateRequest["backendHint"]): Promise<AssetBackend> {
  if (hint === "procedural") return "procedural";
  if (hint === "sdwebui") {
    if (await backendIsReady("sdwebui")) return "sdwebui";
    return "procedural";
  }

  const sdConfigured = Boolean((process.env.SD_WEBUI_URL ?? "").trim());
  if (sdConfigured && (await backendIsReady("sdwebui"))) return "sdwebui";
  return "procedural";
}

export class VideoJobQueue {
  private jobs = new Map<string, VideoJobState>();
  private inFlightByVideoId = new Map<string, string>();
  private framesIndex = new Map<string, FrameRecord>();
  private events = new EventEmitter();

  async enqueue(requestInput: unknown): Promise<{ jobId: string }> {
    const request = VideoGenerateRequestSchema.parse(requestInput);
    const videoId = crypto
      .createHash("sha1")
      .update(stableVideoKey(request))
      .digest("hex")
      .slice(0, 24);

    const existing = this.inFlightByVideoId.get(videoId);
    if (existing) return { jobId: existing };

    const cachedMetaPath = path.join(cacheDir(), `${videoId}.json`);
    if (await fileExists(cachedMetaPath)) {
      const cachedRaw = await fs.readFile(cachedMetaPath, "utf8");
      const cached = JSON.parse(cachedRaw) as { frames?: FrameRecord[] };
      const frames: VideoFrameMeta[] = [];
      for (const fr of cached.frames ?? []) {
        if (!fr?.meta?.frameId || !fr?.fileName) continue;
        this.framesIndex.set(fr.meta.frameId, fr);
        frames.push(fr.meta);
      }

      const doneJobId = crypto.randomBytes(12).toString("hex");
      this.jobs.set(doneJobId, {
        jobId: doneJobId,
        status: "done",
        progress: 1,
        videoId,
        frames,
        createdAt: Date.now(),
        request
      });
      return { jobId: doneJobId };
    }

    const jobId = crypto.randomBytes(12).toString("hex");
    const job: VideoJobState = {
      jobId,
      status: "queued",
      progress: 0,
      videoId,
      frames: [],
      createdAt: Date.now(),
      request
    };
    this.jobs.set(jobId, job);
    this.inFlightByVideoId.set(videoId, jobId);

    void this.runJob(jobId, request, videoId).finally(() => {
      this.inFlightByVideoId.delete(videoId);
    });

    return { jobId };
  }

  get(jobId: string): VideoJobStatus | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      ok: true,
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      videoId: job.videoId,
      frames: job.status === "done" ? job.frames : undefined,
      error: job.error
    };
  }

  subscribe(jobId: string, cb: (ev: any) => void) {
    const key = `job:${jobId}`;
    this.events.on(key, cb);
    return () => this.events.off(key, cb);
  }

  async getFrame(frameId: string): Promise<{ meta: VideoFrameMeta; bytes: Buffer; fileName: string } | null> {
    const rec = this.framesIndex.get(frameId);
    if (!rec) return null;
    const p = path.join(framesDir(), rec.fileName);
    const bytes = await fs.readFile(p);
    return { meta: rec.meta, bytes, fileName: rec.fileName };
  }

  private emit(jobId: string, ev: any) {
    this.events.emit(`job:${jobId}`, ev);
  }

  private async waitForBackendAsset(
    backend: AssetBackend,
    request: AssetRequest,
    seed: number
  ): Promise<Buffer> {
    if (backend === "procedural") {
      const out = await fetchProceduralPng(request, seed);
      return out.buf;
    }
    const out = await fetchSdWebUiPng(request, seed);
    return out.buf;
  }

  private async runJob(jobId: string, request: VideoGenerateRequest, videoId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = "running";
    job.progress = 0.02;
    this.emit(jobId, { type: "status", status: this.get(jobId) });

    try {
      if (request.interpolation !== "blend") {
        throw new Error(
          `Unsupported interpolation '${request.interpolation}' (implemented: blend)`
        );
      }
      if (request.upscaler !== "sharp" && request.upscaler !== "none") {
        throw new Error(
          `Unsupported upscaler '${request.upscaler}' (implemented: sharp|none)`
        );
      }

      const backend = await chooseBackend(request.backendHint ?? "auto");
      if (backend === "procedural" && !(await backendIsReady("procedural"))) {
        throw new Error("procedural backend not ready");
      }

      const out = sizeToDims(request.size);
      const base = chooseBaseDims(out);
      const baseSeed = request.seed ?? hashToSeed(stableVideoKey(request));

      const totalFrames = Math.max(1, Math.round(request.durationSec * request.fps));
      const keyStep = Math.max(1, Math.round(request.fps / Math.max(1, request.baseFps)));

      const keyIndices: number[] = [];
      for (let i = 0; i < totalFrames; i += keyStep) keyIndices.push(i);
      if (keyIndices[keyIndices.length - 1] !== totalFrames - 1) keyIndices.push(totalFrames - 1);

      const keyPngs = new Map<number, Buffer>();
      for (let k = 0; k < keyIndices.length; k++) {
        const idx = keyIndices[k]!;
        job.progress = clamp01(0.05 + 0.3 * (k / Math.max(1, keyIndices.length - 1)));
        this.emit(jobId, { type: "status", status: this.get(jobId) });

        const seed = keySeed(baseSeed, k);
        const styleTags = (request.styleTags ?? []).map((t) => t.trim()).filter(Boolean);
        const prompt =
          styleTags.length > 0 ? `${request.prompt}, ${styleTags.join(", ")}` : request.prompt;

        const assetReq: AssetRequest = {
          type: "keyframe",
          prompt,
          negativePrompt: request.negativePrompt,
          size: { w: base.w, h: base.h },
          seed,
          format: "png",
          tiling: false,
          safety: { allowNSFW: false },
          modelHint: "auto"
        };
        const png = await this.waitForBackendAsset(backend, assetReq, seed);
        keyPngs.set(idx, png);
      }

      await fs.mkdir(framesDir(), { recursive: true });

      const ext = extForFormat(request.format);
      const contentType = contentTypeForFormat(request.format);

      const frameRecords: FrameRecord[] = [];
      let rendered = 0;

      for (let s = 0; s < keyIndices.length - 1; s++) {
        const aIdx = keyIndices[s]!;
        const bIdx = keyIndices[s + 1]!;
        const aPng = keyPngs.get(aIdx)!;
        const bPng = keyPngs.get(bIdx)!;
        const span = Math.max(1, bIdx - aIdx);

        for (let i = aIdx; i <= bIdx; i++) {
          if (s > 0 && i === aIdx) continue;
          const t = span === 0 ? 0 : (i - aIdx) / span;

          const blended = t <= 0 ? aPng : t >= 1 ? bPng : await blendPng(aPng, bPng, t);
          const outBytes =
            request.upscaler === "none"
              ? await encodeFrame(blended, { format: request.format, w: base.w, h: base.h })
              : await encodeFrame(blended, { format: request.format, w: out.w, h: out.h });

          const frameId = crypto
            .createHash("sha1")
            .update(`${videoId}\n${i}\n${ext}`)
            .digest("hex")
            .slice(0, 24);
          const fileName = `${frameId}.${ext}`;
          await fs.writeFile(path.join(framesDir(), fileName), outBytes);

          const meta: VideoFrameMeta = {
            frameId,
            index: i,
            timeMs: Math.round((i / request.fps) * 1000),
            contentType,
            url: `/api/video/frames/${frameId}`
          };

          const rec: FrameRecord = { meta, fileName };
          this.framesIndex.set(frameId, rec);
          job.frames.push(meta);
          frameRecords.push(rec);
          rendered++;

          job.progress = clamp01(0.35 + 0.65 * (rendered / totalFrames));
          this.emit(jobId, { type: "frame", frame: meta });
          if (rendered % 6 === 0) this.emit(jobId, { type: "status", status: this.get(jobId) });
        }
      }

      const metaPath = path.join(cacheDir(), `${videoId}.json`);
      await fs.mkdir(cacheDir(), { recursive: true });
      await fs.writeFile(metaPath, JSON.stringify({ videoId, frames: frameRecords }, null, 2), "utf8");

      job.status = "done";
      job.progress = 1;
      this.emit(jobId, { type: "status", status: this.get(jobId) });
    } catch (err) {
      job.status = "error";
      job.progress = clamp01(job.progress ?? 0);
      job.error = String(err instanceof Error ? err.message : err);
      this.emit(jobId, { type: "status", status: this.get(jobId) });
    }
  }
}
