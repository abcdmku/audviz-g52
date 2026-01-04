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
    const ch0 = input?.[0];
    if (!ch0) return true;

    let sumSq = 0;
    for (let i = 0; i < ch0.length; i++) {
      const s = ch0[i];
      sumSq += s * s;

      this.buf[this.bufIndex++] = s;
      if (this.bufIndex >= this.frameSize) {
        const out = new Float32Array(this.buf);
        const level = Math.sqrt(sumSq / ch0.length);
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

