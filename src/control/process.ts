import { spawn } from "node:child_process";

export class ProcessFailure extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) { super(message, options.cause ? { cause: options.cause } : undefined); this.name = "ProcessFailure"; }
}

export async function runProcess(executable: string, args: readonly string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, stdio: "ignore" });
    let settled = false;
    let terminationError: ProcessFailure | undefined;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const stop = (error: ProcessFailure) => {
      terminationError ??= error;
      if (child.exitCode === null && child.signalCode === null && !child.kill()) finish(terminationError);
    };
    const abort = () => stop(new ProcessFailure("Update cancelled"));
    const timer = setTimeout(() => stop(new ProcessFailure("Update timed out")), options.timeoutMs);
    child.once("error", error => finish(new ProcessFailure("Could not start update process", { cause: error })));
    child.once("close", code => finish(terminationError ?? (code === 0 ? undefined : new ProcessFailure(`Update process exited with code ${code ?? "signal"}`))));
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
  });
}
