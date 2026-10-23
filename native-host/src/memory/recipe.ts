import { createHash } from "node:crypto";
import { z } from "zod";
import { MAX_CHAIN_STEPS } from "./config.ts";
import { sanitizeTarget } from "./privacy.ts";
export const recipeSchema = z.object({
  position: z.number().int().nullable().default(null), action: z.string().max(64).nullable().default(null), hostname: z.string().nullable().default(null),
  target_label: z.string().nullable().default(null), target_role: z.string().nullable().default(null), selector: z.string().nullable().default(null),
  requiresRuntimeValue: z.boolean().default(false), requiresRuntimeUrl: z.boolean().default(false), success: z.boolean().default(false),
});
export type RecipeStep = z.infer<typeof recipeSchema>;
type RecipeInput = { position?: number | null; action?: unknown; hostname?: unknown; target?: unknown; success?: boolean };

// Recipe identity lives in exactly one place. Stored chain fingerprints and
// request-side lookup keys are both built from these helpers, so the two can
// never drift apart and silently disable deterministic replay.
//
// `recipeStepFields` preserves the key order that shipped in v1.7.2: the
// canonical JSON is hashed, so reordering keys would invalidate the
// fingerprints already stored in users' databases.
const REQUIRES_RUNTIME_VALUE_ACTIONS = new Set(["fill", "replaceText", "select", "type"]);
const REQUIRES_RUNTIME_URL_ACTIONS = new Set(["navigate"]);
const CHAIN_FINGERPRINT_PREFIX = "chain:v2:";

export function shortFingerprint(value: string) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function requiresRuntimeValueFor(action: string) {
  return REQUIRES_RUNTIME_VALUE_ACTIONS.has(action);
}

function requiresRuntimeUrlFor(action: string) {
  return REQUIRES_RUNTIME_URL_ACTIONS.has(action);
}

function safeRecipeAction(action: unknown) {
  return typeof action === "string" && action.length > 0 && action.length <= 64 ? action : null;
}

// Key order is part of the fingerprint contract; do not reorder these fields.
function recipeStepFields(step: Partial<RecipeStep>) {
  return {
    position: step.position ?? null,
    action: step.action ?? null,
    hostname: step.hostname ?? null,
    target_label: step.target_label ?? null,
    target_role: step.target_role ?? null,
    selector: step.selector ?? null,
    requiresRuntimeValue: step.requiresRuntimeValue === true,
    requiresRuntimeUrl: step.requiresRuntimeUrl === true,
  };
}

export function canonicalRecipeSteps(steps: readonly Partial<RecipeStep>[]) {
  if (!Array.isArray(steps)) return [];
  return steps
    .slice()
    .sort((first, second) => (first?.position ?? 0) - (second?.position ?? 0))
    .map((step, position) => ({ ...recipeStepFields(step ?? {}), position }));
}

// The stored fingerprint drops `success`: a recipe is replayable whether the
// recorded run of a given step succeeded or not.
export function chainV2Fingerprint(steps: readonly Partial<RecipeStep>[]) {
  return shortFingerprint(CHAIN_FINGERPRINT_PREFIX + JSON.stringify(canonicalRecipeSteps(steps)));
}

export function recipeRecord({ position = null, action = null, hostname = null, target = null, success = true }: RecipeInput = {}) {
  const safeAction = safeRecipeAction(action);
  if (!safeAction) return null;
  const safe = sanitizeTarget(target ?? {});
  return {
    position: Number.isInteger(position) ? position : null,
    action: safeAction,
    hostname: typeof hostname === "string" ? hostname.toLowerCase() : null,
    target_label: safe.label,
    target_role: safe.role,
    selector: safe.selector,
    requiresRuntimeValue: requiresRuntimeValueFor(safeAction),
    requiresRuntimeUrl: requiresRuntimeUrlFor(safeAction),
    success: success === true,
  };
}

// Build the lookup key for an incoming browser_run request. The request carries
// one hostname (resolved from the tab or a leading navigate), so multi-host
// chains never take the deterministic path and fall through to semantic recall.
// Nothing here is persisted; the key is compared and discarded.
function requestStepsAsRecipes(steps: readonly RecipeInput[], hostname: string | null = null) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_CHAIN_STEPS) return null;
  const recipes = [];
  for (const [position, step] of steps.entries()) {
    const recipe = recipeRecord({ position, action: step?.action, hostname, target: step?.target });
    if (!recipe) return null;
    recipes.push(recipe);
  }
  return recipes;
}

export function requestRecipeFingerprint(steps: readonly RecipeInput[], hostname: string | null = null) {
  const recipes = requestStepsAsRecipes(steps, hostname);
  return recipes ? chainV2Fingerprint(recipes) : null;
}

export function parseRecipeJson(recipeJson: string | null): RecipeStep[] {
  try {
    const parsed: unknown = (JSON.parse(recipeJson ?? "[]") as unknown);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(value => { const result = recipeSchema.safeParse(value); return result.success ? [result.data] : []; });
  } catch {
    return [];
  }
}
