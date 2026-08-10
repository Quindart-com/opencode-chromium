export class ProfileSelectionError extends Error {
  constructor(code, message, profiles = []) {
    super(message);
    this.name = "ProfileSelectionError";
    this.code = code;
    this.profiles = profiles;
    this.retryable = code === "PROFILE_DISCONNECTED";
    this.uncertain = false;
  }
}

export function publicProfile(profile) {
  return {
    profileId: profile.profileId,
    profileLabel: profile.profileLabel ?? null,
    profileFingerprint: profile.profileFingerprint ?? profile.profileId,
    connectionId: profile.connectionId ?? null,
    connectionGeneration: profile.connectionGeneration ?? null,
    browserName: profile.browserName ?? null,
    browserVersion: profile.browserVersion ?? null,
    extensionVersion: profile.extensionVersion ?? null,
  };
}

export function selectProfile(profiles, requested = null) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (list.length === 0) throw new ProfileSelectionError("NO_BROWSER_PROFILE", "No connected browser profiles are available.");
  if (requested) {
    const exactId = list.find((profile) => profile.profileId === requested);
    if (exactId) return exactId;
    const matches = list.filter((profile) => profile.profileLabel?.toLocaleLowerCase() === String(requested).toLocaleLowerCase());
    if (matches.length > 1) throw new ProfileSelectionError("PROFILE_LABEL_AMBIGUOUS", `More than one connected profile is labeled ${requested}. Select by profile ID.`, matches.map(publicProfile));
    if (matches.length === 1) return matches[0];
    throw new ProfileSelectionError("PROFILE_DISCONNECTED", `Connected browser profile not found: ${requested}`, list.map(publicProfile));
  }
  if (list.length === 1) return list[0];
  throw new ProfileSelectionError("PROFILE_SELECTION_REQUIRED", "Multiple browser profiles are connected; provide an exact profile ID or label.", list.map(publicProfile));
}

export function assertProfileSession(session, profile) {
  if (!session?.profileId || session.profileId === profile.profileId) return;
  const error = new ProfileSelectionError("PROFILE_SWITCH_REQUIRES_NEW_SESSION", "A browser session is bound to one profile; open a new session before switching profiles.");
  throw error;
}
