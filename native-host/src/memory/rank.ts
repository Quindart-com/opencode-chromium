export function dot(first: ArrayLike<number> | null | undefined, second: ArrayLike<number> | null | undefined) {
  if (!first || !second || first.length !== second.length) return Number.NaN;
  const length = first.length;
  let total = 0;
  for (let index = 0; index < length; index += 1) total += (first[index] ?? Number.NaN) * (second[index] ?? Number.NaN);
  return total;
}

export function norm(values: ArrayLike<number>) {
  return Math.sqrt(dot(values, values));
}

export function cosineDistance(first: ArrayLike<number>, second: ArrayLike<number>) {
  return dot(first, second); // rows are normalized at embedding time
}

export function confidence(confirmed: number, failed: number) {
  return (confirmed + 1) / (confirmed + failed + 1);
}

export function scoreFor(similarity: number, confirmed: number, failed: number) {
  return similarity * confidence(confirmed, failed);
}

export function float32FromBuffer(buffer: Uint8Array): Float32Array {
  if (buffer.byteLength % Float32Array.BYTES_PER_ELEMENT) throw new RangeError("Invalid embedding byte length");
  const aligned = buffer.byteOffset % Float32Array.BYTES_PER_ELEMENT ? new Uint8Array(buffer) : buffer;
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

export function bufferFromFloat32(values: ArrayLike<number>) {
  const copy = new Float32Array(values);
  return Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
}

export function embedRowsFromBuffer(buffer: Uint8Array) {
  return float32FromBuffer(buffer);
}

export function embedBufferFromRows(rows: readonly ArrayLike<number>[]) {
  const flat = new Float32Array(rows.reduce((length, row) => length + row.length, 0));
  let offset = 0;
  for (const row of rows) { flat.set(row, offset); offset += row.length; }
  return Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
}
