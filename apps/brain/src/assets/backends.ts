import crypto from "node:crypto";
import type { AssetRequest } from "@audviz/protocol";

export type AssetBackend = "procedural" | "sdwebui";

export function hashToSeed(input: string) {
  const h = crypto.createHash("sha256").update(input).digest();
  return h.readUInt32LE(0) & 0x7fffffff;
}

export function sizeKey(size: AssetRequest["size"]) {
  return typeof size === "number" ? String(size) : `${size.w}x${size.h}`;
}

export function sizeToDims(size: AssetRequest["size"]): { w: number; h: number } {
  if (typeof size === "number") return { w: size, h: size };
  return { w: size.w, h: size.h };
}

export function backendConfigKey(backend: AssetBackend) {
  if (backend === "procedural") return "procedural:v3";
  const url = (process.env.SD_WEBUI_URL ?? "").trim();
  const model = (process.env.SD_WEBUI_MODEL ?? "").trim();
  const sampler = (process.env.SD_WEBUI_SAMPLER ?? "").trim();
  const steps = Number(process.env.SD_WEBUI_STEPS ?? 24);
  const cfgScale = Number(process.env.SD_WEBUI_CFG_SCALE ?? 7);
  return [
    "sdwebui:v1",
    `url=${url || "unset"}`,
    `model=${model || "default"}`,
    `sampler=${sampler || "default"}`,
    `steps=${Number.isFinite(steps) ? steps : 24}`,
    `cfg=${Number.isFinite(cfgScale) ? cfgScale : 7}`
  ].join(";");
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchProceduralPng(request: AssetRequest, seed: number) {
  const res = await fetch("http://127.0.0.1:8790/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: request.type,
      prompt: request.prompt,
      size: request.size,
      seed,
      tiling: Boolean(request.tiling)
    })
  });
  if (!res.ok) throw new Error(`asset-gen ${res.status}`);
  const data = (await res.json()) as { pngBase64?: string; id?: string };
  if (!data?.pngBase64) throw new Error("asset-gen: bad response");
  const buf = Buffer.from(data.pngBase64, "base64");
  return { buf, backendId: data.id };
}

export async function fetchSdWebUiPng(request: AssetRequest, seed: number) {
  const base = (process.env.SD_WEBUI_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("SD_WEBUI_URL not set");

  const steps = Number(process.env.SD_WEBUI_STEPS ?? 24);
  const cfgScale = Number(process.env.SD_WEBUI_CFG_SCALE ?? 7);
  const sampler = (process.env.SD_WEBUI_SAMPLER ?? "").trim();
  const model = (process.env.SD_WEBUI_MODEL ?? "").trim();

  const { w, h } = sizeToDims(request.size);

  const body: Record<string, unknown> = {
    prompt: request.prompt,
    negative_prompt: request.negativePrompt ?? "",
    seed,
    steps: Number.isFinite(steps) ? Math.max(1, Math.min(80, Math.floor(steps))) : 24,
    cfg_scale: Number.isFinite(cfgScale) ? Math.max(1, Math.min(30, cfgScale)) : 7,
    width: Math.max(64, Math.min(2048, Math.floor(w))),
    height: Math.max(64, Math.min(2048, Math.floor(h))),
    batch_size: 1,
    n_iter: 1
  };

  if (request.type === "texture") {
    body.tiling = Boolean(request.tiling);
  }

  if (sampler) body.sampler_name = sampler;
  if (model) {
    body.override_settings = { sd_model_checkpoint: model };
  }

  const res = await fetchWithTimeout(
    `${base}/sdapi/v1/txt2img`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    60_000
  );
  if (!res.ok) throw new Error(`sd-webui ${res.status}`);
  const data = (await res.json()) as { images?: string[]; info?: unknown };
  const first = data.images?.[0];
  if (!first) throw new Error("sd-webui: empty images");
  const b64 = first.includes(",") ? first.split(",").pop()! : first;
  const buf = Buffer.from(b64, "base64");
  return { buf, backendInfo: data.info };
}

