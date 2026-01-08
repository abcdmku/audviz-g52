import { Worker } from "node:worker_threads";
import { CLASSIFIER_SAMPLE_RATE, CLASSIFIER_WINDOW_SAMPLES } from "./classifier-config.js";

type GenreDist = Record<string, number>;

type WorkerResultMsg = {
  type: "result";
  id: number;
  timeSec: number;
  genreDist: GenreDist;
};

type WorkerErrMsg = { type: "error"; id?: number; message: string };

type WorkerInMsg = {
  type: "classify";
  id: number;
  timeSec: number;
  sampleRate: number;
  bpm: number;
  energy: number;
  pcm: Float32Array;
};

class FloatRingBuffer {
  private buf: Float32Array;
  private write = 0;
  private used = 0;

  constructor(capacity: number) {
    this.buf = new Float32Array(Math.max(1, Math.floor(capacity)));
  }

  get size() {
    return this.used;
  }

  push(samples: Float32Array) {
    if (samples.length === 0) return;
    const cap = this.buf.length;
    let src = samples;
    if (src.length > cap) src = src.subarray(src.length - cap);

    const n = src.length;
    const endSpace = cap - this.write;
    if (n <= endSpace) {
      this.buf.set(src, this.write);
      this.write += n;
      if (this.write === cap) this.write = 0;
    } else {
      this.buf.set(src.subarray(0, endSpace), this.write);
      this.buf.set(src.subarray(endSpace), 0);
      this.write = n - endSpace;
    }
    this.used = Math.min(cap, this.used + n);
  }

  readLatest(n: number) {
    const cap = this.buf.length;
    const count = Math.max(0, Math.min(this.used, Math.floor(n)));
    const out = new Float32Array(count);
    if (count === 0) return out;

    const start = (this.write - count + cap) % cap;
    if (start + count <= cap) {
      out.set(this.buf.subarray(start, start + count));
    } else {
      const first = cap - start;
      out.set(this.buf.subarray(start));
      out.set(this.buf.subarray(0, count - first), first);
    }
    return out;
  }
}

class LinearResampler {
  private ratio: number;
  private pos = 0;
  private tail = 0;
  private hasTail = false;

  constructor(
    private inRate: number,
    private outRate: number
  ) {
    this.ratio = inRate / outRate;
  }

  process(input: Float32Array) {
    if (input.length === 0) return new Float32Array(0);
    if (this.inRate === this.outRate) return input.slice();

    const available = input.length - 1 - this.pos;
    const outLen = available >= 0 ? Math.floor(available / this.ratio) + 1 : 0;
    const out = new Float32Array(outLen);

    for (let i = 0; i < outLen; i++) {
      const i0 = Math.floor(this.pos);
      const frac = this.pos - i0;
      const s0 = i0 === -1 ? (this.hasTail ? this.tail : input[0] ?? 0) : input[i0] ?? 0;
      const s1 = input[i0 + 1] ?? input[input.length - 1] ?? 0;
      out[i] = s0 + (s1 - s0) * frac;
      this.pos += this.ratio;
    }

    this.tail = input[input.length - 1] ?? 0;
    this.hasTail = true;
    this.pos -= input.length;
    if (this.pos < -1) this.pos = -1;
    return out;
  }
}

export class AudioClassifierClient {
  private worker: Worker | null = null;
  private resampler: LinearResampler;
  private ring = new FloatRingBuffer(CLASSIFIER_SAMPLE_RATE * 12);
  private requestId = 0;
  private inFlight = false;
  private lastSentAt = -Infinity;

  constructor(
    inputSampleRate: number,
    private onGenreDist: (dist: GenreDist, timeSec: number) => void
  ) {
    this.resampler = new LinearResampler(inputSampleRate, CLASSIFIER_SAMPLE_RATE);
    this.worker = this.spawnWorker();
  }

  dispose() {
    try {
      this.worker?.terminate();
    } catch {
      // ignore
    }
    this.worker = null;
  }

  pushPcmFrame(frame: Float32Array) {
    const resampled = this.resampler.process(frame);
    this.ring.push(resampled);
  }

  maybeClassify(timeSec: number, ctx: { bpm: number; energy: number }) {
    if (!this.worker) return;
    if (this.inFlight) return;
    if (timeSec - this.lastSentAt < 1.0) return;
    if (this.ring.size < CLASSIFIER_WINDOW_SAMPLES) return;

    const pcm = this.ring.readLatest(CLASSIFIER_WINDOW_SAMPLES);
    if (pcm.length !== CLASSIFIER_WINDOW_SAMPLES) return;

    const id = ++this.requestId;
    const msg: WorkerInMsg = {
      type: "classify",
      id,
      timeSec,
      sampleRate: CLASSIFIER_SAMPLE_RATE,
      bpm: ctx.bpm,
      energy: ctx.energy,
      pcm
    };

    this.inFlight = true;
    this.lastSentAt = timeSec;
    this.worker.postMessage(msg, [pcm.buffer]);
  }

  private spawnWorker() {
    const isTs = import.meta.url.endsWith(".ts");
    const workerUrl = new URL(
      `./classifier-worker.${isTs ? "ts" : "js"}`,
      import.meta.url
    );

    const worker = new Worker(workerUrl, {
      execArgv: isTs ? ["--import", "tsx"] : []
    });

    worker.on("message", (msg: WorkerResultMsg | WorkerErrMsg) => {
      if (!msg || typeof msg !== "object") return;
      if ((msg as any).type === "result") {
        this.inFlight = false;
        const r = msg as WorkerResultMsg;
        this.onGenreDist(r.genreDist ?? {}, r.timeSec);
        return;
      }
      if ((msg as any).type === "error") {
        this.inFlight = false;
        return;
      }
    });

    worker.on("error", () => {
      this.inFlight = false;
    });

    worker.on("exit", () => {
      this.inFlight = false;
      this.worker = null;
    });

    return worker;
  }
}
