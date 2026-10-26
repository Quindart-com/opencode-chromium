import { beforeDeadline } from "../../../src/shared/deadline.ts";

type Pending = { method: string; phase: string; startedAt: string };
type Dialog = { type: string; openedAt: string; sessionId?: string };
export class CommandHealth {
  private readonly queues = new Map<number, Promise<void>>();
  private readonly pending = new Map<number, Pending>();
  private readonly dialogs = new Map<number, Dialog>();
  private readonly failures = new Map<number, string>();
  private readonly generations = new Map<number, number>();
  private readonly successes = new Map<number, string>();
  private readonly lifecycle = new Map<number, Set<Promise<unknown>>>();
  private readonly quarantined = new Map<number, Promise<unknown>>();

  track<T>(tabId: number, task: Promise<T>) {
    const tasks = this.lifecycle.get(tabId) ?? new Set<Promise<unknown>>();
    tasks.add(task); this.lifecycle.set(tabId, tasks);
    const clear = () => { tasks.delete(task); if (!tasks.size) this.lifecycle.delete(tabId); };
    void task.then(clear, clear);
  }

  generation(tabId: number) { return this.generations.get(tabId) ?? 0; }
  idle() { return this.queues.size === 0 && this.pending.size === 0 && this.lifecycle.size === 0 && this.quarantined.size === 0; }
  invalidate(tabId: number) { this.generations.set(tabId, this.generation(tabId) + 1); }
  dialog(tabId: number) { return this.dialogs.get(tabId); }
  event(tabId: number, method: string, params: Record<string, unknown>, sessionId?: string) {
    if (method === "Page.javascriptDialogOpening") this.dialogs.set(tabId, { type: String(params.type ?? "unknown"), openedAt: new Date().toISOString(), ...(sessionId ? { sessionId } : {}) });
    if (method === "Page.javascriptDialogClosed") { this.dialogs.delete(tabId); this.failures.delete(tabId); }
  }
  recovered(tabId: number) { this.failures.delete(tabId); }
  removed(tabId: number) { this.invalidate(tabId); this.dialogs.delete(tabId); this.failures.delete(tabId); this.successes.delete(tabId); }
  snapshot(tabIds: Iterable<number>) {
    return [...tabIds].map(tabId => ({ tabId, actionable: this.dialogs.has(tabId) || this.failures.has(tabId) || this.lifecycle.has(tabId) || this.quarantined.has(tabId) ? false : this.pending.has(tabId) || !this.successes.has(tabId) ? null : true, lastSuccessfulCommandAt: this.successes.get(tabId) ?? null,
      pending: this.pending.get(tabId) ?? null, dialog: this.dialogs.get(tabId) ?? null, error: this.failures.get(tabId) ?? null }));
  }
  async run<T>(tabId: number, operation: () => Promise<T>, deadlineAt = Date.now() + 10000, method = "browser command"): Promise<T> {
    const previous = this.queues.get(tabId) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stored = previous.catch(() => {}).then(() => gate);
    this.queues.set(tabId, stored);
    try {
      await beforeDeadline(() => previous.catch(() => {}), deadlineAt, { tabId, method, phase: "queue", executionState: "not_started" });
      if (this.lifecycle.get(tabId)?.size || this.quarantined.has(tabId)) throw Object.assign(new Error("Previous browser command is still completing. Inspect tab health before retrying."), { code: "TAB_UNHEALTHY", uncertain: false, executionState: "not_started", details: { tabId, method, phase: "queue" } });
      const pending = { method, phase: "command", startedAt: new Date().toISOString() };
      this.pending.set(tabId, pending);
      const task = Promise.resolve().then(operation);
      try {
        const result = await beforeDeadline(() => task, deadlineAt, { tabId, method, phase: "command", dialogType: this.dialog(tabId)?.type });
        this.failures.delete(tabId);
        this.successes.set(tabId, new Date().toISOString());
        return result;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "TIMEOUT") {
          this.invalidate(tabId);
          this.quarantined.set(tabId, task);
          const clear = () => { if (this.quarantined.get(tabId) === task) this.quarantined.delete(tabId); };
          void task.then(clear, clear);
          if ("details" in error && error.details && typeof error.details === "object") Object.assign(error.details, { dialogType: this.dialog(tabId)?.type });
        }
        this.failures.set(tabId, error instanceof Error ? error.message : String(error));
        throw error;
      } finally { if (this.pending.get(tabId) === pending) this.pending.delete(tabId); }
    } finally { release(); if (this.queues.get(tabId) === stored) this.queues.delete(tabId); }
  }
}
