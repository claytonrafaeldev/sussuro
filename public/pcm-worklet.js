class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(Math.round(sampleRate / 10));
    this.used = 0;
    this.waiting = false;
    this.stopped = false;
    this.port.onmessage = ({ data }) => { if (data === 'ack') this.waiting = false; };
  }
  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let mono = 0;
      for (const channel of channels) mono += channel[index] / channels.length;
      this.buffer[this.used++] = mono;
      if (this.used === this.buffer.length) {
        if (this.waiting) {
          this.stopped = true; this.port.postMessage({ overflow: true }); return false;
        }
        this.waiting = true;
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(Math.round(sampleRate / 10));
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('sussurro-pcm', PcmCapture);
