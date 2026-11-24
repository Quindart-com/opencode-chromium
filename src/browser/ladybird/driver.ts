import { spawn } from "node:child_process";
import { BrowserRuntimeError } from "../../core/errors.ts";
import { record } from "../../shared/values.ts";
import type { LadybirdConfig } from "./config.ts";

// The shell watches the parent's pipe so an interrupted MCP process also
// terminates the driver. The driver owns and removes its temporary profile.
const supervisor = [
  "exec 3<&0",
  '"$@" </dev/null &',
  "driver=$!",
  '( IFS= read -r stop <&3; kill -TERM "$driver" 2>/dev/null ) &',
  "watcher=$!",
  'wait "$driver"; result=$?',
  'kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null',
  'exit "$result"',
].join("\n");

// WSL serializes Windows argv into a Linux command. Quote each argument
// inside the one fixed shell command so paths with spaces are preserved.
function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function launchLadybird(config: LadybirdConfig) {
  const args = [config.driver, "--headless", "--force-cpu-painting", "--listen-address", "127.0.0.1", "--port", "0"];
  const encoded = Buffer.from("set -- " + args.map(shellQuote).join(" ") + "\n" + supervisor).toString("base64");
  const child = config.distro
    ? spawn("wsl.exe", ["--distribution", config.distro, "--exec", "sh", "-c",
        'exec sh -c "$(echo ' + encoded + ' | base64 -d)"'],
      { windowsHide: true })
    : spawn("/bin/sh", ["-c", supervisor, "ladybird", ...args], { windowsHide: true });
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-3000); });
  const exited = new Promise<void>(resolve => {
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
  const listening = new Promise<number>((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output = (output + chunk).slice(-4000);
      const port = Number(/Listening on 127\.0\.0\.1:(\d+)\r?\n/.exec(output)?.[1]);
      if (port > 0 && port <= 65535) resolve(port);
    });
    child.once("error", reject);
    child.once("close", code => reject(new Error("WebDriver exited before listening (" + String(code) + ").")));
  });
  return {
    async endpoint() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const port = await Promise.race([listening, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out waiting for Ladybird WebDriver.")), 15000);
        })]);
        return "http://127.0.0.1:" + port;
      } finally { clearTimeout(timer); }
    },
    async close() {
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([exited, new Promise<void>(resolve => {
          timer = setTimeout(() => { child.kill(); resolve(); }, 4000);
        })]);
      } finally { clearTimeout(timer); }
    },
    startupLog() { return stderr.trim(); },
  };
}

export type LadybirdDriver = ReturnType<typeof launchLadybird>;

export class WebDriverError extends BrowserRuntimeError {
  readonly webdriverCode: string;
  constructor(webdriverCode: string, message: string) {
    const stale = ["stale element reference", "no such element"].includes(webdriverCode);
    const timedOut = ["timeout", "script timeout"].includes(webdriverCode);
    const code = stale ? "STALE_TARGET" : timedOut ? "TIMEOUT" : webdriverCode === "unexpected alert open" ? "DIALOG_OPEN" : "LADYBIRD_WEBDRIVER_ERROR";
    super(message, { code, uncertain: timedOut });
    this.webdriverCode = webdriverCode;
  }
}

export async function driverRequest(endpoint: string, method: string, target: string, body?: object, timeoutMs = 10000) {
  let response: Response;
  try {
    response = await fetch(endpoint + target, {
      method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    const connected = timedOut || !["ECONNREFUSED", "ENETUNREACH"].includes(String(record(record(cause).cause).code));
    const command = target.replace(/^\/session\/[^/]+/, "").replace(/\/element\/[^/]+/, "/element/:id") || "/session";
    throw new BrowserRuntimeError(timedOut ? "Ladybird WebDriver timed out on " + method + " " + command + "." : "Could not reach Ladybird WebDriver over loopback.", {
      code: timedOut ? "TIMEOUT" : "LADYBIRD_DISCONNECTED", uncertain: connected && method !== "GET", cause,
    });
  }
  let result: Record<string, unknown>;
  try { result = record(await response.json()); }
  catch (cause) {
    throw new BrowserRuntimeError("Ladybird WebDriver returned an unreadable response.", {
      code: "LADYBIRD_DISCONNECTED", uncertain: method !== "GET", cause,
    });
  }
  const value = record(result.value);
  if (!response.ok || typeof value.error === "string") {
    throw new WebDriverError(String(value.error ?? response.status), String(value.message ?? "Ladybird WebDriver returned an error."));
  }
  return result.value;
}
