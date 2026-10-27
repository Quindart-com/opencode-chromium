export const RESERVATION_USD = 0.2;
export const BUDGET_USD = 5;
export interface PricingModel { id: string; context_length: number; pricing: { prompt: string; completion: string } }

export function validatePricing(catalog: PricingModel[], ids: string[]): void {
  for (const id of ids) {
    const model = catalog.find(row => row.id === id) ?? catalog.find(row => row.id === id.replace(/-\d{8}$/, ""));
    const price = Number(model?.pricing?.prompt);
    if (!model || !Number.isFinite(model.context_length) || model.context_length <= 0 || model.context_length > 1_050_000 ||
      !Number.isFinite(price) || price <= 0 || price > 0.0000001 || Number(model.pricing?.completion) !== 0) {
      throw new Error("Model price or context cannot be safely bounded");
    }
  }
}

export function reserve(reserved: number): number | null {
  if (!Number.isFinite(reserved) || reserved < 0 || reserved + RESERVATION_USD > BUDGET_USD + 1e-9) return null;
  return Math.round((reserved + RESERVATION_USD) * 100) / 100;
}
