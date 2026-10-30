export type UsagePeriod = "7d" | "30d" | "last-week" | "last-year" | "all";
export interface UsageQuery { provider?: string; period?: UsagePeriod }
export interface UsageTotals {
  calls: number; selected: number; abstained: number; tests: number; inputTokens: number; outputTokens: number;
  reportedCost: number; costReportedCalls: number; usageReportedCalls: number; averageMs: number; lastMs: number;
}
export interface UsageProvider extends UsageTotals { id: string; provider: string; route: string; model: string | null }
export interface UsageDay extends UsageTotals { date: string; endDate?: string }
export interface UsageReport extends UsageTotals {
  window: string; period: UsagePeriod; selectedProvider: string; providers: UsageProvider[]; daily: UsageDay[];
}
