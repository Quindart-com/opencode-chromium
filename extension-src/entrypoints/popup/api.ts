import { browser } from "wxt/browser";

export type NativeStatus = {
  state?: string;
  hostName?: string;
  error?: string | null;
  lastChecked?: string | null;
};

export type Profile = {
  profileId?: string;
  profileIdMasked?: string;
  profileLabel: string | null;
};

export type SemanticModel = {
  id: string;
  label: string;
  description?: string;
  role?: "adaptive" | "deep";
  default?: boolean;
  parameters?: string;
  dimensions?: number;
  contextLength?: string;
  embedding?: { id?: string };
  reranker?: { id?: string };
  benchmark?: { label?: string; value?: string | number };
  cache?: { cached?: boolean };
};

export type SemanticState = {
  settings?: { enabled?: boolean; modelId?: string };
  models?: SemanticModel[];
  load?: {
    state?: string;
    modelId?: string;
    progress?: number;
    component?: string;
    error?: string;
  };
  cache?: { kind?: string };
};

export type MemoryStatus = {
  health: string;
  enabled: boolean;
  paused?: boolean;
  counts: {
    signatures: number;
    chains: number;
    failure_contexts: number;
    confirmed_total: number;
    failed_total: number;
  };
  memory_hits: number;
  quota_bytes: number;
  bytes_used: number;
  power_user: boolean;
  purge_days: number;
  recent_daily?: Array<{ confirmed: number; failed: number }>;
};

export type MemoryResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error?: string };

export async function sendMessage<T>(message: object): Promise<T> {
  return (await browser.runtime.sendMessage(message)) as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function responseError(response: { error?: unknown } | null | undefined): string | null {
  if (!response?.error) return null;
  return String(response.error);
}

export async function memoryCall<T>(method: string, params: object = {}): Promise<T> {
  const response = await sendMessage<MemoryResponse<T>>({ type: "MEMORY_CALL", method, params });
  if (!response?.ok) throw new Error(response?.error ?? `${method} failed`);
  return response.result;
}

export const MB = 1024 * 1024;

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
