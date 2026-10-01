import { memoryReplayThreshold } from "../memory/index.js";

// Provider selection is only recall. The caller separately binds every step,
// resolves live targets, and applies approvals before any recipe can execute.
type ReplayCandidate = { deterministic?: boolean; failed_count?: number; decisionConfidence?: number; similarity?: number };
export function replayGateRejection(match: ReplayCandidate, memoryState?: { embedding_profile?: string | null }) {
  if (match.deterministic === true) return null;
  if (Number(match.failed_count ?? 0) > 0) return "negative_lesson";
  if (match.decisionConfidence !== undefined) return Number(match.decisionConfidence) >= 0.95 ? null : "below_similarity";
  const similarity = Number(match.similarity);
  if (!Number.isFinite(similarity) || similarity < memoryReplayThreshold(memoryState?.embedding_profile ?? null)) return "below_similarity";
  return null;
}
