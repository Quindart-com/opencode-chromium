import { canonicalRecipeSteps, parseRecipeJson } from "./recipe.js";
import type { MemoryStore } from "./store.js";

type Row = { id: number; safe_summary: string; recipe_json: string; confirmed_count: number; failed_count: number };
export function candidateRecipes(store: Pick<MemoryStore, "db">,
  { hostname, profileId, stepCount }: { hostname?: string; profileId?: string; stepCount?: number } = {}) {
  if (!hostname || !profileId || stepCount === undefined || !Number.isInteger(stepCount) || stepCount < 1) return [];
  const rows = store.db.prepare("SELECT c.id, c.safe_summary, c.recipe_json, c.confirmed_count, c.failed_count FROM memory_chains_v2 c " +
    "JOIN memory_chain_profiles p ON p.item_id = c.id WHERE p.profile_id = ? AND c.replaced_by IS NULL " +
    "AND c.failed_count = 0 AND c.confirmed_count > 0 AND c.safe_summary != '' AND json_array_length(c.recipe_json) = ? " +
    "AND NOT EXISTS (SELECT 1 FROM json_each(c.recipe_json) s WHERE json_extract(s.value, '$.hostname') IS NOT ?) " +
    "ORDER BY c.last_seen DESC LIMIT 16").all(profileId, stepCount, hostname) as Row[];
  return rows.map(row => ({ id: row.id, signature: row.safe_summary, failed_count: row.failed_count,
    confirmed_count: row.confirmed_count, steps: canonicalRecipeSteps(parseRecipeJson(row.recipe_json)) }));
}
