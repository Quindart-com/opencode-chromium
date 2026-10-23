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
}
