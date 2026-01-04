class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { frameSize = 1024, channels = 1 } = options?.processorOptions || {};
    this.frameSize = frameSize;
    this.channels = channels;
    this.buf = new Float32Array(frameSize);
    this.bufIndex = 0;
  }

  process(inputs) {
    const input = inputs?.[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      return true;
    }

    let sumSq = 0;
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      // Downmix to mono (handles mono/stereo inputs; avoids missing right-only devices).
      let s = 0;
      let count = 0;
      for (let ch = 0; ch < input.length; ch++) {
        const buf = input[ch];
        if (!buf) continue;
        s += buf[i] ?? 0;
        count++;
      }
      if (count) s /= count;
      sumSq += s * s;

      this.buf[this.bufIndex++] = s;
      if (this.bufIndex >= this.frameSize) {
        const out = new Float32Array(this.buf);
        const level = Math.sqrt(sumSq / n);
        this.port.postMessage(
          { frame: out.buffer, level: Math.min(1, level * 4) },
          [out.buffer]
        );
        this.bufIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
