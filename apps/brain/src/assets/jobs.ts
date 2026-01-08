import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AssetJobStatus, AssetRequest } from "@audviz/protocol";
import { AssetRequestSchema } from "@audviz/protocol";
import {
  backendConfigKey,
  fetchWithTimeout,
  fetchProceduralPng,
  fetchSdWebUiPng,
  hashToSeed,
  sizeKey,
  sizeToDims,
  type AssetBackend
} from "./backends.js";

type AssetMetadata = {
  assetId: string;
  backend: AssetBackend;
  request: AssetRequest;
  createdAt: string;
  contentType: string;
  fileName: string;
  bytes: number;
  backendInfo?: Record<string, unknown>;
};

type JobState = {
  jobId: string;
  status: AssetJobStatus["status"];
  progress?: number;
  assetId?: string;
  error?: string;
  createdAt: number;
  request: AssetRequest;
  backend: AssetBackend;
};

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function cacheDir() {
  return path.resolve(process.cwd(), "..", "..", ".cache", "assets");
}

function assetIdFor(request: AssetRequest, backend: AssetBackend) {
  const size = sizeKey(request.size);
  const seed = request.seed ?? hashToSeed(`${request.type}\n${request.prompt}\n${size}`);
  const tiling = request.tiling ? "1" : "0";
  const neg = request.negativePrompt ?? "";
  const safety = request.safety?.allowNSFW ? "nsfw" : "safe";
  const modelHint = request.modelHint ?? "auto";
  const version = "v1";
  const key = [
    request.type,
    backend,
    backendConfigKey(backend),
    request.format,
    size,
    String(seed),
    tiling,
    safety,
    modelHint,
    neg,
    request.prompt,
    version
  ].join("\n");
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 24);
}

function extForFormat(format: AssetRequest["format"]) {
  if (format === "png") return "png";
  if (format === "jpg") return "jpg";
  return "webp";
}

function contentTypeForFormat(format: AssetRequest["format"]) {
  if (format === "png") return "image/png";
  if (format === "jpg") return "image/jpeg";
  return "image/webp";
}

async function fileExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function encodeToFormat(
  png: Buffer,
  format: AssetRequest["format"]
): Promise<{ bytes: Buffer; contentType: string; ext: string }> {
  const ext = extForFormat(format);
  if (format === "png") return { bytes: png, contentType: "image/png", ext };

  const imported = (await import("sharp")) as any;
  const sharp = (imported?.default ?? imported) as any;

  if (format === "jpg") {
    const bytes = (await sharp(png)
      .flatten({ background: "#000" })
      .jpeg({ quality: 92, chromaSubsampling: "4:2:0" })
      .toBuffer()) as Buffer;
    return { bytes, contentType: "image/jpeg", ext };
  }

  const bytes = (await sharp(png).webp({ quality: 90 }).toBuffer()) as Buffer;
  return { bytes, contentType: "image/webp", ext };
}

export class AssetJobQueue {
  private jobs = new Map<string, JobState>();
  private inFlightByAssetId = new Map<string, string>();
  private backendHealth = new Map<AssetBackend, { ok: boolean; checkedAt: number }>();

  async enqueue(requestInput: unknown): Promise<{ jobId: string }> {
    const parsed = AssetRequestSchema.safeParse(requestInput);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const request = parsed.data;

    const { backend, assetId, fromCache } = await this.chooseBackendAndId(request);

    const existingJobId = this.inFlightByAssetId.get(assetId);
    if (existingJobId) return { jobId: existingJobId };

    const ext = extForFormat(request.format);
    const metaPath = path.join(cacheDir(), `${assetId}.json`);
    const binPath = path.join(cacheDir(), `${assetId}.${ext}`);

    if (fromCache || ((await fileExists(metaPath)) && (await fileExists(binPath)))) {
      const doneJobId = this.newJobId();
      this.jobs.set(doneJobId, {
        jobId: doneJobId,
        status: "done",
        progress: 1,
        assetId,
        createdAt: Date.now(),
        request,
        backend
      });
      return { jobId: doneJobId };
    }

    const jobId = this.newJobId();
    const job: JobState = {
      jobId,
      status: "queued",
      progress: 0,
      createdAt: Date.now(),
      request,
      backend
    };
    this.jobs.set(jobId, job);
    this.inFlightByAssetId.set(assetId, jobId);

    void this.runJob(jobId, assetId, request, backend).finally(() => {
      this.inFlightByAssetId.delete(assetId);
    });

    return { jobId };
  }

  get(jobId: string): AssetJobStatus | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      ok: true,
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      assetId: job.assetId,
      error: job.error
    };
  }

  async getAsset(assetId: string): Promise<{ meta: AssetMetadata; bytes: Buffer } | null> {
    const metaPath = path.join(cacheDir(), `${assetId}.json`);
    if (!(await fileExists(metaPath))) return null;
    const metaRaw = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(metaRaw) as AssetMetadata;
    const filePath = path.join(cacheDir(), meta.fileName);
    const bytes = await fs.readFile(filePath);
    return { meta, bytes };
  }

  private newJobId() {
    return crypto.randomBytes(12).toString("hex");
  }

  private backendCandidatesFor(request: AssetRequest): AssetBackend[] {
    if (request.type === "lut") return ["procedural"];

    const hint = request.modelHint ?? "auto";
    if (hint === "local") return ["sdwebui", "procedural"];
    if (hint === "cloud") return ["sdwebui", "procedural"];
    return ["sdwebui", "procedural"];
  }

  private async backendIsReady(backend: AssetBackend) {
    const now = Date.now();
    const cached = this.backendHealth.get(backend);
    if (cached && now - cached.checkedAt < 2500) return cached.ok;

    let ok = false;
    try {
      if (backend === "procedural") {
        const r = await fetchWithTimeout(
          "http://127.0.0.1:8790/health",
          { method: "GET" },
          800
        );
        ok = r.ok;
      } else if (backend === "sdwebui") {
        const base = (process.env.SD_WEBUI_URL ?? "").trim().replace(/\/+$/, "");
        if (!base) ok = false;
        else {
          const r = await fetchWithTimeout(
            `${base}/sdapi/v1/options`,
            { method: "GET" },
            1200
          );
          ok = r.ok;
        }
      }
    } catch {
      ok = false;
    }

    this.backendHealth.set(backend, { ok, checkedAt: now });
    return ok;
  }

  private async chooseBackendAndId(request: AssetRequest): Promise<{
    backend: AssetBackend;
    assetId: string;
    fromCache: boolean;
  }> {
    const candidates = this.backendCandidatesFor(request);
    const ext = extForFormat(request.format);

    for (const backend of candidates) {
      const assetId = assetIdFor(request, backend);
      const metaPath = path.join(cacheDir(), `${assetId}.json`);
      const binPath = path.join(cacheDir(), `${assetId}.${ext}`);
      if ((await fileExists(metaPath)) && (await fileExists(binPath))) {
        return { backend, assetId, fromCache: true };
      }
    }

    for (const backend of candidates) {
      if (backend === "sdwebui" && !(process.env.SD_WEBUI_URL ?? "").trim()) continue;
      if (await this.backendIsReady(backend)) {
        return { backend, assetId: assetIdFor(request, backend), fromCache: false };
      }
    }

    const fallback = candidates[candidates.length - 1] ?? "procedural";
    return { backend: fallback, assetId: assetIdFor(request, fallback), fromCache: false };
  }

  private async runJob(jobId: string, assetId: string, request: AssetRequest, backend: AssetBackend) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = "running";
    job.progress = 0.05;

    try {
      const seed =
        request.seed ?? hashToSeed(`${request.type}\n${request.prompt}\n${sizeKey(request.size)}`);

      await fs.mkdir(cacheDir(), { recursive: true });
      job.progress = 0.15;

      let png: Buffer;
      let backendInfo: Record<string, unknown> | undefined;

      if (backend === "procedural") {
        const out = await fetchProceduralPng(request, seed);
        png = out.buf;
        backendInfo = out.backendId ? { id: out.backendId } : undefined;
      } else if (backend === "sdwebui") {
        const out = await fetchSdWebUiPng(request, seed);
        png = out.buf;
        backendInfo = out.backendInfo ? { info: out.backendInfo } : undefined;
      } else {
        throw new Error(`Unknown backend: ${backend}`);
      }
      job.progress = 0.85;

      const encoded = await encodeToFormat(png, request.format);
      const fileName = `${assetId}.${encoded.ext}`;
      const binPath = path.join(cacheDir(), fileName);
      await fs.writeFile(binPath, encoded.bytes);

      const meta: AssetMetadata = {
        assetId,
        backend,
        request: { ...request, seed },
        createdAt: new Date().toISOString(),
        contentType: encoded.contentType ?? contentTypeForFormat(request.format),
        fileName,
        bytes: encoded.bytes.byteLength,
        backendInfo
      };
      const metaPath = path.join(cacheDir(), `${assetId}.json`);
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");

      job.status = "done";
      job.progress = 1;
      job.assetId = assetId;
    } catch (err) {
      job.status = "error";
      job.progress = clamp01(job.progress ?? 0);
      job.error = String(err instanceof Error ? err.message : err);
    }
  }
}
