export interface RuntimeActivation {
  root: string;
  version?: string | null;
  sourceRoot?: string;
  linkedAt?: string;
  channel?: "development" | "production";
  fingerprint?: string;
  followBranch?: boolean;
  pendingReload?: boolean;
  stateIsolation?: boolean;
  autoUpdate?: boolean;
  generation?: number;
  stagedRelease?: { root: string; version: string };
}
