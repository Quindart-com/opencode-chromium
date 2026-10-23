export function daysBetween(now: number, thenMs: number) {
  return Math.max(0, (now - thenMs) / (24 * 60 * 60 * 1000));
}

export function chainLengthWeight(chainLength: number) {
  return 1 + Math.log2(1 + Math.max(0, chainLength));
}

export function recencyWeight(ageDays: number, purgeDays: number) {
  const halfLife = Math.max(1, purgeDays * 0.5);
  return Math.exp(-ageDays / halfLife);
}

export function negativeValue({ chainLength = 0, ageDays = 0, purgeDays = 7 }) {
  return chainLengthWeight(chainLength) * recencyWeight(ageDays, purgeDays);
}

export function negligibleThreshold(purgeDays: number) {
  return recencyWeight(purgeDays, purgeDays) * chainLengthWeight(0);
}