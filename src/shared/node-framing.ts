import type { Writable } from "node:stream";

const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const json = JSON.stringify(message);
  if (json === undefined) throw new Error("A frame must contain a JSON value");
  const payload = Buffer.from(json, "utf8");
  if (payload.length > DEFAULT_MAX_FRAME_BYTES) throw new Error("Outgoing frame exceeds limit");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Copies each byte once, including frames delivered a byte at a time. */
export class FrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private payload: Buffer | null = null;
  private payloadBytes = 0;
  private readonly maxFrameBytes: number;
  private readonly onMessage: (message: unknown) => void;

  constructor({ onMessage, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES }: { onMessage: (message: unknown) => void; maxFrameBytes?: number }) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new Error("Invalid frame limit");
    this.onMessage = onMessage;
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.payload === null) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        this.header.set(chunk.subarray(offset, offset + count), this.headerBytes);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes < 4) return;
        const length = this.header.readUInt32LE(0);
        if (length === 0 || length > this.maxFrameBytes) throw new Error(`Invalid frame length: ${length} bytes`);
        this.payload = Buffer.allocUnsafe(length);
        this.payloadBytes = 0;
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
      this.payload.set(chunk.subarray(offset, offset + count), this.payloadBytes);
      this.payloadBytes += count;
      offset += count;
      if (this.payloadBytes === this.payload.length) {
        const text = this.payload.toString("utf8");
        this.payload = null;
        this.headerBytes = 0;
        this.onMessage(JSON.parse(text) as unknown);
      }
    }
  }
}

export function writeFrame(stream: Pick<Writable, "write">, message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(encodeFrame(message), (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
