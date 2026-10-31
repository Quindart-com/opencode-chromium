import { z } from "zod";

export const recipeSchema = z.object({
  position: z.number().int().nullable().default(null), action: z.string().max(64).nullable().default(null), hostname: z.string().nullable().default(null),
  target_label: z.string().nullable().default(null), target_role: z.string().nullable().default(null), selector: z.string().nullable().default(null),
  requiresRuntimeValue: z.boolean().default(false), requiresRuntimeUrl: z.boolean().default(false), success: z.boolean().default(false),
});
export type RecipeStep = z.infer<typeof recipeSchema>;
