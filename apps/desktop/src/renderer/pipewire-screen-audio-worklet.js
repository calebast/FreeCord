class FreeCordPipeWireSource extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffers = [];
    this.bufferOffset = 0;
    this.queuedFrames = 0;
    this.port.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const input = new Int16Array(event.data, 0, Math.floor(event.data.byteLength / 2));
      const frames = Math.floor(input.length / 2);
      if (frames === 0) return;
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        left[frame] = input[frame * 2] / 32768;
        right[frame] = input[frame * 2 + 1] / 32768;
      }
      this.buffers.push({ left, right });
      this.queuedFrames += frames;
      while (this.queuedFrames > 96_000 && this.buffers.length > 1) {
        const removedOffset = this.bufferOffset;
        const removed = this.buffers.shift();
        this.queuedFrames -= removed.left.length - removedOffset;
        this.bufferOffset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const leftOutput = output?.[0];
    const rightOutput = output?.[1] ?? leftOutput;
    if (!leftOutput || !rightOutput) return true;
    leftOutput.fill(0);
    rightOutput.fill(0);

    let written = 0;
    while (written < leftOutput.length && this.buffers.length > 0) {
      const current = this.buffers[0];
      const available = current.left.length - this.bufferOffset;
      const count = Math.min(available, leftOutput.length - written);
      leftOutput.set(current.left.subarray(this.bufferOffset, this.bufferOffset + count), written);
      rightOutput.set(current.right.subarray(this.bufferOffset, this.bufferOffset + count), written);
      written += count;
      this.bufferOffset += count;
      this.queuedFrames -= count;
      if (this.bufferOffset >= current.left.length) {
        this.buffers.shift();
        this.bufferOffset = 0;
      }
    }
    return true;
  }
}

registerProcessor("freecord-pipewire-source", FreeCordPipeWireSource);
