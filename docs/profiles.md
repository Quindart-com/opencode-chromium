# Profiles and sessions

The live registry distinguishes stable profile fingerprint, human label, transient connection ID, browser family/version, extension version, and connection generation.

- One connected profile is selected automatically.
- An exact profile ID or exact label selects a requested profile.
- Multiple profiles require explicit selection.
- Duplicate labels return `PROFILE_LABEL_AMBIGUOUS`; use an ID.
- A disconnected selected profile returns `PROFILE_DISCONNECTED`; the session never falls back to another profile.
- Reconnects invalidate stale tab handles and a session cannot claim another profile's tab.

Use `browser_session` for `open`, `new-tab`, `claim-tab`, `release-tab`, and `name`. Prefer new tabs for ordinary work. Claim an already-open page only after the user's explicit request or permission. Discover candidates with `{"action":"open","scope":"user"}`, then pass the chosen `tabId` to `{"action":"claim-tab","tabId":123}` using the same session and profile. Only ungrouped, unclaimed tabs are listed or accepted; tabs in any group are excluded, even when that group has no active owner. Claiming moves the page into the session's group without navigating or reloading it. `release-tab` leaves it open and ungrouped.

Call `browser_finalize` when finished. Every tab remains open for human review, the existing session group retains its name and turns blue, and ownership is released. No `keep` list is necessary. Numeric keep entries and entries with an omitted status default to `deliverable`, which has the same review behavior.

On browsers without tab-group APIs, tabs stay open and ownership is released without a colored group.

Only explicit `status: "handoff"` retains ownership for unfinished work in the green session group. Other tabs move into a separate blue review group so handoffs and blocked tabs remain active. Mark a handoff again after a later turn only if work still needs to continue. Finalization never closes tabs, and a partial cleanup preserves ownership of blocked tabs for recovery. Blue review groups remain unavailable to claiming; the user can ungroup a page before explicitly authorizing a new claim.
