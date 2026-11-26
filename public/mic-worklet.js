// Average each input interval into one 16 kHz sample, then send 50 ms packets.
class RoomMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(800);
    this.index = this.phase = this.sum = this.count = 0;
  }
  process(inputs) {
    for (const value of inputs[0]?.[0] || []) {
      this.sum += value;
      this.count++;
      this.phase += 16000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      this.samples[this.index++] = Math.max(-1, Math.min(1, this.sum / this.count)) * 32767;
      this.sum = this.count = 0;
      if (this.index === this.samples.length) {
        this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
        this.samples = new Int16Array(800);
        this.index = 0;
      }
    }
    return true;
  }
}
registerProcessor("room-microphone", RoomMicrophone);
