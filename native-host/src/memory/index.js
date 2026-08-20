export { MemoryStore, openMemoryStore } from "./store.js";
export { MemoryCapture } from "./capture.js";
export { EmbedQueue } from "./embed.js";
export { buildSignature, fingerprintFor, verbForCapability } from "./signature.js";
export { stepsOf, appendOverlap, mergeChains, correctChainStep, composeChainFor, composeChainEmbedding, chainFingerprint } from "./compose.js";
export { negativeValue, chainLengthWeight, recencyWeight, negligibleThreshold, daysBetween } from "./purge.js";
export {
  MEMORY_ENV_DIR,
  MEMORY_ENV_FORCE,
  MEMORY_ENV_EMBED,
  SCHEMA_VERSION,
  DEFAULT_QUOTA_BYTES,
  MIN_QUOTA_BYTES,
  MAX_QUOTA_BYTES,
  DEFAULT_PURGE_DAYS,
  DEFAULT_QUERY_EVENTS,
  MAX_QUERY_EVENTS,
  MAX_SEARCH_RESULTS,
  STORAGE_PROFILE,
  memoryRootDir,
  databasePath,
  memoryEnabledForServer,
  embeddingEnabled,
  sqliteImplementation,
} from "./config.js";