/**
 * AudioWorklet processor that downsamples mic input to 16 kHz mono PCM (Int16).
 * Sends chunks of ~200 ms (3200 samples at 16 kHz) to the main thread.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.inputCount = 0;
    this.outputCount = 0;
    this.buffer = [];
    this.CHUNK = 3200; // 200 ms at 16 kHz
  }

  process(inputs) {
    const chan = inputs[0]?.[0];
    if (!chan) return true;

    for (let i = 0; i < chan.length; i++) {
      this.inputCount++;
      const expected = Math.floor(this.inputCount / this.ratio);
      if (expected > this.outputCount) {
        this.buffer.push(chan[i]);
        this.outputCount++;
      }
    }

    while (this.buffer.length >= this.CHUNK) {
      const slice = this.buffer.splice(0, this.CHUNK);
      const pcm = new Int16Array(this.CHUNK);
      for (let j = 0; j < this.CHUNK; j++) {
        const s = Math.max(-1, Math.min(1, slice[j]));
        pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage({ pcm: pcm.buffer }, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
