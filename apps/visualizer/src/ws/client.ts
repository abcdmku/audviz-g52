export class VisualizerWsClient {
  private url: string;
  private ws: WebSocket | null = null;

  onMessage: ((data: unknown) => void) | null = null;
  onStatus: ((connected: boolean) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener("open", () => {
      this.onStatus?.(true);
      this.ws?.send(JSON.stringify({ type: "hello", client: "visualizer" }));
      this.ws?.send(JSON.stringify({ type: "config", spectrumBins: 64 }));
    });

    this.ws.addEventListener("close", () => {
      this.onStatus?.(false);
      setTimeout(() => this.connect(), 800);
    });

    this.ws.addEventListener("error", () => {
      this.onStatus?.(false);
    });

    this.ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        this.onMessage?.(JSON.parse(ev.data));
      } catch {
        // ignore
      }
    });
  }
}

