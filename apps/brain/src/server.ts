import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import {
  type BrainToVisualizerMessage,
  safeParseVisualizerToBrainMessage
} from "@audviz/protocol";
import { AnalysisEngine } from "./analysis/engine.js";

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
