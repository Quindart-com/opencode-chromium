# Profiles and sessions

The live registry distinguishes stable profile fingerprint, human label, transient connection ID, browser family/version, extension version, and connection generation.

- One connected profile is selected automatically.
- An exact profile ID or exact label selects a requested profile.
- Multiple profiles require explicit selection.
- Duplicate labels return `PROFILE_LABEL_AMBIGUOUS`; use an ID.
- A disconnected selected profile returns `PROFILE_DISCONNECTED`; the session never falls back to another profile.
- Reconnects invalidate stale tab handles and a session cannot claim another profile's tab.

Use `browser_session` for `open`, `new-tab`, `claim-tab`, `release-tab`, and `name`. Call `browser_finalize` to release claimed tabs, close owned temporary tabs, and preserve only handoff or deliverable tabs.
