import { useCallback,useEffect,useState } from "react";
import { t } from "../../i18n";
import { errorMessage,memoryCall,type MemoryProfiles,type MemoryStatus } from "./api";

export const MEMORY_POLL_MS = 2500;
export const MEMORY_REQUEST_TIMEOUT_MS = 10000;

export type MemoryScope = { scope: string; selectedProfiles: string[] };
export type MemorySnapshot = { status: MemoryStatus | null; profiles: MemoryProfiles | null; error: string };

type Fetcher = <T>(method: string, params?: object) => Promise<T>;
interface Entry {
  key: string; scope: MemoryScope; snapshot: MemorySnapshot;
  listeners: Set<() => void>; timer: ReturnType<typeof setTimeout> | null; request: number;
}
const EMPTY: MemorySnapshot = { status: null, profiles: null, error: "" };
const entries = new Map<string, Entry>();
let fetcher: Fetcher = memoryCall;

/** Test seam: replaces the transport used for memory calls. */
export function setMemoryFetcher(next: Fetcher | null): void { fetcher = next ?? memoryCall; }

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Memory request timed out")), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
const scopeKey = (scope: MemoryScope) => `${scope.scope}|${scope.scope === "selected" ? scope.selectedProfiles.join(",") : ""}`;
const publish = (entry: Entry, snapshot: MemorySnapshot) => { entry.snapshot = snapshot; for (const listener of [...entry.listeners]) listener(); };

async function load(entry: Entry): Promise<void> {
  const id = ++entry.request;
  const { scope, selectedProfiles } = entry.scope;
  let known: MemoryProfiles | null = entry.snapshot.profiles;
  try {
    known = await withTimeout(fetcher<MemoryProfiles>("memory.profiles"), MEMORY_REQUEST_TIMEOUT_MS / 2).catch(() => null);
    if (id !== entry.request || entries.get(entry.key) !== entry) return;
    const profileIds = scope === "all" ? null : scope === "current" ? known?.currentProfileId ? [known.currentProfileId] : null : scope === "unknown" ? [] : selectedProfiles;
    const next = await withTimeout(fetcher<MemoryStatus>("memory.stats", { profileIds, includeUnattributed: scope === "unknown" }), MEMORY_REQUEST_TIMEOUT_MS);
    if (id !== entry.request || entries.get(entry.key) !== entry) return;
    if (next.supported === false) throw new Error(t("memorySqlite"));
    publish(entry, { status: next, profiles: known, error: "" });
  } catch (error) {
    if (id !== entry.request || entries.get(entry.key) !== entry) return;
    publish(entry, { ...entry.snapshot, profiles: known, error: errorMessage(error) });
  }
}

function schedule(entry: Entry): void {
  entry.timer = setTimeout(async () => {
    if (entries.get(entry.key) !== entry) return;
    if (typeof document === "undefined" || document.visibilityState === "visible") await load(entry);
    if (entries.get(entry.key) === entry) schedule(entry);
  }, MEMORY_POLL_MS);
}

/** Ref-counted: every consumer of the same scope shares one poller. */
export function subscribeMemoryStatus(scope: MemoryScope, listener: () => void): { unsubscribe(): void; refresh(): Promise<void>; snapshot(): MemorySnapshot } {
  const key = scopeKey(scope);
  let entry = entries.get(key);
  if (!entry) {
    entry = { key, scope, snapshot: EMPTY, listeners: new Set(), timer: null, request: 0 };
    entries.set(key, entry);
    const created = entry;
    void load(created).then(() => { if (entries.get(key) === created) schedule(created); });
  }
  const active = entry;
  active.listeners.add(listener);
  return {
    snapshot: () => active.snapshot,
    refresh: () => entries.get(key) === active ? load(active) : Promise.resolve(),
    unsubscribe() {
      active.listeners.delete(listener);
      if (active.listeners.size === 0 && entries.get(key) === active) {
        entries.delete(key); ++active.request;
        if (active.timer) clearTimeout(active.timer);
      }
    },
  };
}

export function useMemoryStatus(scope: MemoryScope, available: boolean): MemorySnapshot & { refresh(): Promise<void> } {
  const key = scopeKey(scope);
  const [snapshot, setSnapshot] = useState<MemorySnapshot>(EMPTY);
  const [handle, setHandle] = useState<ReturnType<typeof subscribeMemoryStatus> | null>(null);
  useEffect(() => {
    setSnapshot(EMPTY);
    if (!available) { setHandle(null); return; }
    let live = true;
    const subscription = subscribeMemoryStatus(scope, () => { if (live) setSnapshot(subscription.snapshot()); });
    setSnapshot(subscription.snapshot());
    setHandle(subscription);
    return () => { live = false; subscription.unsubscribe(); };
  }, [key, available]);
  const refresh = useCallback(() => handle?.refresh() ?? Promise.resolve(), [handle]);
  return { ...snapshot, refresh };
}
