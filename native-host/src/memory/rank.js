export function dot(first, second) {
  const length = Math.min(first.length, second.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) total += first[index] * second[index];
  return total;
}

export function norm(values) {
  return Math.sqrt(dot(values, values));
}

export function cosineDistance(first, second) {
  return dot(first, second); // rows are normalized at embedding time
}

export function confidence(confirmed, failed) {
  return (confirmed + 1) / (confirmed + failed + 1);
}

export function scoreFor(similarity, confirmed, failed) {
  return similarity * confidence(confirmed, failed);
}

export function float32FromBuffer(buffer) {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

export function bufferFromFloat32(values) {
  const copy = new Float32Array(values);
  return Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
}

export function embedRowsFromBuffer(buffer) {
  return float32FromBuffer(buffer);
}

export function embedBufferFromRows(rows) {
  const flat = new Float32Array(rows.flat());
  return Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
}