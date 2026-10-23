import { createRequire } from "node:module";

const readPng = createRequire(import.meta.url)("pngjs").PNG.sync.read as (input: Buffer, options: { checkCRC: boolean }) => unknown;

// Limits deliberately stay below the provider's experimental image allowance.
// JPEG/PNG dimensions are checked before any request leaves the native host.
export function boundedJevImage(image: string): boolean {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!match) return false;
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length > 200_000 || bytes.toString("base64") !== match[2]) return false;
  let width = 0, height = 0;
  if (match[1] === "png") {
    if (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.toString("ascii", 12, 16) !== "IHDR") return false;
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL" || offset + length + 12 > bytes.length) return false;
      offset += length + 12;
    }
    if (offset !== bytes.length) return false;
    if (width < 280 || height < 280 || width > 768 || height > 768) return false;
    try { readPng(bytes, { checkCRC: true }); } catch { return false; }
  } else {
    if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return false;
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset] !== 255) return false;
      const marker = bytes[offset + 1], length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return false;
      if (marker === 192) { height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break; }
      if (marker === 218) return false;
      offset += 2 + length;
    }
  }
  return width >= 280 && height >= 280 && width <= 768 && height <= 768;
}
