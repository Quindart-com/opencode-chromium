export interface RuntimeRelease {
  root: string;
  version: string;
  contractVersion: number;
  installedAt?: string;
  activatedAt?: string;
}

export interface RuntimeActivation {
  schemaVersion?: 1 | 2;
  root: string;
  version?: string | null;
  desired?: RuntimeRelease;
  fallback?: RuntimeRelease;
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
  approvedMajor?: number;
}

export function desiredRuntime(activation: RuntimeActivation): RuntimeRelease {
  return activation.desired ?? {
    root: activation.root,
    version: activation.version ?? "0.0.0",
    contractVersion: 1,
  };
}

export function selectDesiredRuntime(activation: RuntimeActivation, desired: RuntimeRelease, fallback = desiredRuntime(activation)): RuntimeActivation {
  return {
    ...activation,
    schemaVersion: 2,
    root: desired.root,
    version: desired.version,
    desired,
    ...(fallback.root === desired.root ? {} : { fallback }),
    stagedRelease: undefined,
    generation: (activation.generation ?? 0) + 1,
  };
}
