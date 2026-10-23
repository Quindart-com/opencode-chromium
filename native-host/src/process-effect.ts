import { Cause,Data,Effect,Exit } from "effect";
import { spawn } from "node:child_process";

export class ProcessFailure extends Data.TaggedError("ProcessFailure")<{
  message: string;
  cause?: unknown;
}> {}

/** Own the child and its listeners for the entire operation, including cancellation. */
export async function runProcess(executable: string, args: readonly string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<void> {
  const operation = Effect.acquireUseRelease(
    Effect.try({
      try: () => spawn(executable, args, { cwd: options.cwd, windowsHide: true, stdio: "ignore" }),
      catch: cause => new ProcessFailure({ message: "Could not start update process", cause }),
    }),
    child => Effect.callback<void, ProcessFailure>(resume => {
      const error = (cause: Error) => resume(Effect.fail(new ProcessFailure({ message: "Update process failed", cause })));
      const exit = (code: number | null) => resume(code === 0 ? Effect.void : Effect.fail(new ProcessFailure({ message: `Update process exited with code ${code ?? "signal"}` })));
      child.once("error", error);
      child.once("exit", exit);
      return Effect.sync(() => { child.removeListener("error", error); child.removeListener("exit", exit); });
    }),
    child => Effect.promise(async () => { if (child.pid && child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill(); await closed; } }),
  ).pipe(Effect.timeoutOrElse({ duration: options.timeoutMs, orElse: () => Effect.fail(new ProcessFailure({ message: "Update timed out" })) }));
  const exit = await Effect.runPromiseExit(operation, { signal: options.signal });
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
}
