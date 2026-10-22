// Image decisions never need a desktop-sized upload. Decode locally, preserve
// the viewport aspect ratio and send at most 768 pixels on the longest edge.
export async function prepareJevScreenshot(base64) {
  if (base64.length > 4_000_000) return undefined;
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  if (!boundedSourceJpeg(bytes)) return undefined;
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  try {
    const scale = Math.max(Math.min(1, Math.sqrt(110592 / (bitmap.width * bitmap.height))), 280 / Math.min(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
    // Tiny or extreme-aspect viewports cannot meet TypeSafe's image minimum.
    if (width < 280 || height < 280 || width > 768 || height > 768) return undefined;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, width, height);
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.45 });
    if (jpeg.type !== "image/jpeg" || jpeg.size > 200_000) return undefined;
    const output = new Uint8Array(await jpeg.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < output.length; offset += 8192) binary += String.fromCharCode(...output.subarray(offset, offset + 8192));
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } finally { bitmap.close(); }
}

function boundedSourceJpeg(bytes) {
  if (bytes[0] !== 255 || bytes[1] !== 216) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 2; offset + 8 < bytes.length;) {
    const marker = bytes[offset + 1], length = view.getUint16(offset + 2);
    if (bytes[offset] !== 255 || length < 2 || offset + length + 2 > bytes.length) return false;
    if (marker === 192 || marker === 194) {
      const height = view.getUint16(offset + 5), width = view.getUint16(offset + 7);
      return width > 0 && height > 0 && width * height <= 16_000_000;
    }
    offset += length + 2;
  }
  return false;
}
