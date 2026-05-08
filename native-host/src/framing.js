const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;

export function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  #buffer = Buffer.alloc(0);
  #maxFrameBytes;
  #onMessage;

  constructor({ onMessage, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES }) {
    this.#onMessage = onMessage;
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > this.#maxFrameBytes) {
        throw new Error(`Frame exceeds limit: ${length} bytes`);
      }

      if (this.#buffer.length < 4 + length) return;

      const payload = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      this.#onMessage(JSON.parse(payload.toString("utf8")));
    }
  }
}

export function writeFrame(stream, message) {
  return new Promise((resolve, reject) => {
    stream.write(encodeFrame(message), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
