import crypto from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import {
  type AiInterpretRequest,
  type VisualPlan,
  AssetGenerateResponseSchema,
  AssetJobStatusSchema,
  VideoGenerateResponseSchema,
  VideoJobStatusSchema,
  VisualPlanSchema,
  type BrainToVisualizerMessage,
  safeParseAiInterpretRequest,
  safeParseVisualizerToBrainMessage
} from "@audviz/protocol";
import { AnalysisEngine } from "./analysis/engine.js";
import { mapPromptToVisualPlan } from "./ai/heuristic-mapper.js";
import { interpretWithGemini } from "./ai/llm/gemini.js";
import { sanitizeVisualPlan } from "./ai/sanitize-plan.js";
import { AssetJobQueue } from "./assets/jobs.js";
import { VideoJobQueue } from "./video/jobs.js";

const PORT = Number(process.env.PORT ?? 8766);
const WS_PATH = "/ws";

type ClientRole = "unknown" | "visualizer" | "capture";

type Client = {
  ws: WebSocket;
  role: ClientRole;
};

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "brain" }));
app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    clients: {
      capture: clients.filter((c) => c.role === "capture").length,
      visualizer: clients.filter((c) => c.role === "visualizer").length
    },
    analysis: engine?.getStatus() ?? null
  });
});

const assetJobs = new AssetJobQueue();
const videoJobs = new VideoJobQueue();

function cacheDir() {
  return path.resolve(process.cwd(), "..", "..", ".cache", "assets");
}

async function fileExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isBlockedHostname(hostname: string) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  const m172 = /^172\.(\d+)\./.exec(h);
  if (m172) {
    const n = Number(m172[1]);
    if (Number.isFinite(n) && n >= 16 && n <= 31) return true;
  }
  if (/^169\.254\./.test(h)) return true;
  return false;
}

async function readResponseWithLimit(res: Response, maxBytes: number) {
  if (!res.body) throw new Error("Empty response body");
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`File too large (>${maxBytes} bytes)`);
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks, total);
}

app.get("/api/ai/status", (_req, res) => {
  const mode = (process.env.AI_INTERPRETER ?? "auto").toLowerCase();
  const geminiConfigured = Boolean(
    (process.env.GEMINI_API_KEY ?? "").trim() ||
      (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "").trim()
  );
  const geminiModel = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
  res.json({
    ok: true,
    interpreter: mode,
    providers: {
      gemini: { configured: geminiConfigured, model: geminiModel }
    }
  });
});

function lastUserPrompt(parsed: AiInterpretRequest) {
  const lastUser = [...parsed.messages].reverse().find((m) => m.role === "user");
  return lastUser?.content?.trim() ?? "";
}

async function interpretPrompt(parsed: AiInterpretRequest): Promise<VisualPlan> {
  const mode = (process.env.AI_INTERPRETER ?? "auto").toLowerCase();
  const wantGemini = mode === "gemini" || mode === "auto";
  const canGemini = Boolean(
    (process.env.GEMINI_API_KEY ?? "").trim() ||
      (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "").trim()
  );

  if (wantGemini && canGemini) {
    try {
      const plan = await interpretWithGemini(parsed);
      return sanitizeVisualPlan(plan, parsed);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[ai] Gemini interpret failed: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && (err as any).cause) {
        // eslint-disable-next-line no-console
        console.warn("[ai] Gemini details:", (err as any).cause);
      }
    }
  }

  const prompt = lastUserPrompt(parsed);
  const plan: VisualPlan = mapPromptToVisualPlan(prompt);
  const validated = VisualPlanSchema.parse(plan);
  const sanitized = sanitizeVisualPlan(validated, parsed);
  if (wantGemini && !canGemini) {
    sanitized.warnings = [...sanitized.warnings, "Cloud LLM not configured; used local heuristic mapper."];
  } else if (wantGemini && canGemini) {
    sanitized.warnings = [...sanitized.warnings, "Cloud LLM failed; used local heuristic mapper. Check Brain console for details."];
  }
  return sanitized;
}

app.post("/api/ai/interpret", async (req, res) => {
  const parsed: AiInterpretRequest | null = safeParseAiInterpretRequest(req.body);
  if (!parsed) {
    res.status(400).json({ ok: false, error: "Invalid request" });
    return;
  }

  const prompt = lastUserPrompt(parsed);
  if (!prompt) {
    res.status(400).json({ ok: false, error: "Missing user message" });
    return;
  }

  try {
    const plan = await interpretPrompt(parsed);
    res.json(VisualPlanSchema.parse(plan));
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});

app.post("/api/assets/generate", async (req, res) => {
  try {
    const { jobId } = await assetJobs.enqueue(req.body);
    res.json(AssetGenerateResponseSchema.parse({ ok: true, jobId }));
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});

app.get("/api/assets/health", async (_req, res) => {
  const fetchOk = async (url: string, timeoutMs: number) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: controller.signal });
      return r.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };

  let proceduralOk = false;
  try {
    proceduralOk = await fetchOk("http://127.0.0.1:8790/health", 800);
  } catch {
    proceduralOk = false;
  }

  const sdUrl = (process.env.SD_WEBUI_URL ?? "").trim().replace(/\/+$/, "");
  const sdConfigured = Boolean(sdUrl);
  const sdOk = sdConfigured ? await fetchOk(`${sdUrl}/sdapi/v1/options`, 1200) : false;

  res.json({
    ok: true,
    backends: {
      procedural: {
        ok: proceduralOk,
        url: "http://127.0.0.1:8790"
      },
      sdwebui: {
        ok: sdOk,
        configured: sdConfigured,
        url: sdUrl || null
      }
    }
  });
});

app.get("/api/assets/jobs/:jobId", (req, res) => {
  const status = assetJobs.get(req.params.jobId);
  if (!status) {
    res.status(404).json({ ok: false, error: "Unknown jobId" });
    return;
  }
  res.json(AssetJobStatusSchema.parse(status));
});

app.get("/api/assets/:assetId", async (req, res) => {
  const assetId = String(req.params.assetId ?? "").trim();
  if (!assetId) {
    res.status(400).json({ ok: false, error: "Missing assetId" });
    return;
  }
  try {
    const asset = await assetJobs.getAsset(assetId);
    if (!asset) {
      res.status(404).json({ ok: false, error: "Asset not found" });
      return;
    }
    res.setHeader("content-type", asset.meta.contentType);
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.send(asset.bytes);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});

// Proxy a remote CC0/public-domain texture/image URL (avoids browser CORS), resize to a square texture, and cache it.
app.post("/api/assets/fetch-url", async (req, res) => {
  const urlRaw = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const sizeInput = req.body?.size;
  const size =
    typeof sizeInput === "number" && Number.isFinite(sizeInput)
      ? Math.max(64, Math.min(2048, Math.floor(sizeInput)))
      : 768;

  if (!urlRaw) {
    res.status(400).json({ ok: false, error: "Missing url" });
    return;
  }

  let url: URL;
  try {
    url = new URL(urlRaw);
  } catch {
    res.status(400).json({ ok: false, error: "Invalid url" });
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    res.status(400).json({ ok: false, error: "Only http/https urls are allowed" });
    return;
  }
  if (isBlockedHostname(url.hostname)) {
    res.status(400).json({ ok: false, error: "Blocked hostname" });
    return;
  }

  const version = "v1";
  const id = crypto
    .createHash("sha1")
    .update(`${version}\n${size}\n${url.toString()}`)
    .digest("hex")
    .slice(0, 24);

  const dir = path.join(cacheDir(), "external");
  const filePath = path.join(dir, `${id}.png`);
  const metaPath = path.join(dir, `${id}.json`);

  try {
    if (await fileExists(filePath)) {
      res.setHeader("content-type", "image/png");
      res.setHeader("cache-control", "public, max-age=86400");
      res.send(await fs.readFile(filePath));
      return;
    }
  } catch {
    // cache read failed -> refetch
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let fetched: Response;
    try {
      fetched = await fetch(url.toString(), {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          // Some CDNs require an Accept to serve an image variant.
          accept: "image/*,*/*;q=0.8"
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!fetched.ok) {
      res.status(502).json({ ok: false, error: `Fetch failed (${fetched.status})` });
      return;
    }

    const contentLength = Number(fetched.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 15_000_000) {
      res.status(413).json({ ok: false, error: "File too large" });
      return;
    }

    const bytes = await readResponseWithLimit(fetched, 15_000_000);

    const imported = (await import("sharp")) as any;
    const sharp = (imported?.default ?? imported) as any;

    const png = (await sharp(bytes)
      .resize(size, size, { fit: "cover" })
      .png({ compressionLevel: 9 })
      .toBuffer()) as Buffer;

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, png);
    await fs.writeFile(
      metaPath,
      JSON.stringify(
        {
          id,
          url: url.toString(),
          size,
          createdAt: new Date().toISOString(),
          contentType: "image/png",
          fileName: `${id}.png`,
          bytes: png.byteLength
        },
        null,
        2
      ),
      "utf8"
    );

    res.setHeader("content-type", "image/png");
    res.setHeader("cache-control", "public, max-age=86400");
    res.send(png);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});

app.post("/api/video/generate", async (req, res) => {
  try {
    const { jobId } = await videoJobs.enqueue(req.body);
    res.json(VideoGenerateResponseSchema.parse({ ok: true, jobId }));
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});

app.get("/api/video/jobs/:jobId", (req, res) => {
  const status = videoJobs.get(req.params.jobId);
  if (!status) {
    res.status(404).json({ ok: false, error: "Unknown jobId" });
    return;
  }
  res.json(VideoJobStatusSchema.parse(status));
});

app.get("/api/video/jobs/:jobId/stream", (req, res) => {
  const jobId = String(req.params.jobId ?? "");
  const status = videoJobs.get(jobId);
  if (!status) {
    res.status(404).json({ ok: false, error: "Unknown jobId" });
    return;
  }

  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("status", status);

  const unsub = videoJobs.subscribe(jobId, (ev) => {
    if (ev?.type === "frame") sendEvent("frame", ev.frame);
    else if (ev?.type === "status") sendEvent("status", ev.status);
  });

  req.on("close", () => {
    unsub();
    try {
      res.end();
    } catch {
      // ignore
    }
  });
});

app.get("/api/video/frames/:frameId", async (req, res) => {
  const frameId = String(req.params.frameId ?? "").trim();
  if (!frameId) {
    res.status(400).json({ ok: false, error: "Missing frameId" });
    return;
  }

  try {
    const out = await videoJobs.getFrame(frameId);
    if (!out) {
      res.status(404).json({ ok: false, error: "Frame not found" });
      return;
    }
    res.setHeader("content-type", out.meta.contentType);
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.send(out.bytes);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
app.use(express.static(publicDir));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

const clients: Client[] = [];
let engine: AnalysisEngine | null = null;

function broadcastToVisualizers(msg: BrainToVisualizerMessage) {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    if (c.role !== "visualizer") continue;
    if (c.ws.readyState !== c.ws.OPEN) continue;
    c.ws.send(data);
  }
}

function closeOtherCaptures(current: Client) {
  for (const c of clients) {
    if (c === current) continue;
    if (c.role !== "capture") continue;
    try {
      c.ws.close(4000, "Another capture client connected");
    } catch {
      // ignore
    }
  }
}

function sendStatus(ws: WebSocket, status: Record<string, unknown>) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: "status", ...status }));
}

wss.on("connection", (ws) => {
  const client: Client = { ws, role: "unknown" };
  clients.push(client);

  const helloTimeout = setTimeout(() => {
    if (client.role === "unknown") {
      try {
        ws.close(4001, "Expected hello");
      } catch {
        // ignore
      }
    }
  }, 2000);

  ws.on("message", (data, isBinary) => {
    if (!engine) {
      engine = new AnalysisEngine({
        onMessage: broadcastToVisualizers
      });
    }

    if (!isBinary) {
      const text = data.toString("utf8");
      const parsed = safeParseVisualizerToBrainMessage(
        (() => {
          try {
            return JSON.parse(text);
          } catch {
            return null;
          }
        })()
      );
      if (!parsed) return;

      if (parsed.type === "hello") {
        clearTimeout(helloTimeout);
        client.role = parsed.client;
        if (client.role === "capture") closeOtherCaptures(client);
        sendStatus(ws, { role: client.role });
        return;
      }

      if (client.role === "capture" && parsed.type === "pcm") {
        engine.configure({
          sampleRate: parsed.sampleRate,
          channels: parsed.channels === 2 ? 2 : 1,
          frameSize: parsed.frames
        });
        sendStatus(ws, { configured: true, ...engine.getStatus() });
        return;
      }

      if (client.role === "visualizer" && parsed.type === "config") {
        if (parsed.spectrumBins) engine.configure({ spectrumBins: parsed.spectrumBins });
        sendStatus(ws, { configured: true, ...engine.getStatus() });
        return;
      }
      return;
    }

    if (client.role !== "capture") return;
    engine.pushPcmFrame(data as Buffer);
  });

  ws.on("close", () => {
    clearTimeout(helloTimeout);
    const idx = clients.indexOf(client);
    if (idx >= 0) clients.splice(idx, 1);
  });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "", `http://${request.headers.host}`);
  if (url.pathname !== WS_PATH) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[brain] http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[brain] ws://localhost:${PORT}${WS_PATH}`);
});
