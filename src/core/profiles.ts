export interface BrowserProfile {
  profileId: string;
  profileLabel?: string | null;
  profileFingerprint?: string | null;
  connectionId?: string | null;
  connectionGeneration?: number | null;
  browserName?: string | null;
  browserVersion?: string | null;
  extensionVersion?: string | null;
}

export class ProfileSelectionError extends Error {
  readonly code: string;
  readonly profiles: BrowserProfile[];
  readonly retryable: boolean;
  readonly uncertain = false;
  constructor(code: string, message: string | undefined, profiles: BrowserProfile[] = []) {
    super(message);
    this.name = "ProfileSelectionError";
    this.code = code;
    this.profiles = profiles;
    this.retryable = code === "PROFILE_DISCONNECTED";
  }
}

export function publicProfile(profile: BrowserProfile) {
  return {
    profileId: profile.profileId, profileLabel: profile.profileLabel ?? null,
    profileFingerprint: profile.profileFingerprint ?? profile.profileId,
    connectionId: profile.connectionId ?? null, connectionGeneration: profile.connectionGeneration ?? null,
    browserName: profile.browserName ?? null, browserVersion: profile.browserVersion ?? null,
    extensionVersion: profile.extensionVersion ?? null,
  };
}

export function selectProfile<T extends BrowserProfile>(profiles: readonly T[], requested: string | null = null): T {
  if (profiles.length === 0) throw new ProfileSelectionError("NO_BROWSER_PROFILE", "No connected browser profiles are available.");
  if (requested) {
    const exactId = profiles.find(profile => profile.profileId === requested);
    if (exactId) return exactId;
    const matches = profiles.filter(profile => profile.profileLabel?.toLocaleLowerCase() === requested.toLocaleLowerCase());
    if (matches.length > 1) throw new ProfileSelectionError("PROFILE_LABEL_AMBIGUOUS", `More than one connected profile is labeled ${requested}. Select by profile ID.`, matches.map(publicProfile));
    const match = matches[0];
    if (match) return match;
    throw new ProfileSelectionError("PROFILE_DISCONNECTED", `Connected browser profile not found: ${requested}`, profiles.map(publicProfile));
  }
  const single = profiles[0];
  if (profiles.length === 1 && single) return single;
  throw new ProfileSelectionError("PROFILE_SELECTION_REQUIRED", "Multiple browser profiles are connected; provide an exact profile ID or label.", profiles.map(publicProfile));
}

export function assertProfileSession(session: { profileId?: string | null }, profile: Pick<BrowserProfile, "profileId">): void {
  if (!session.profileId || session.profileId === profile.profileId) return;
  throw new ProfileSelectionError("PROFILE_SWITCH_REQUIRES_NEW_SESSION", "A browser session is bound to one profile; open a new session before switching profiles.");
}
