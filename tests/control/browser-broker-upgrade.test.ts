import { spawn } from "node:child_process";
import { EventEmitter,once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect,test } from "bun:test";
import { activateRelease } from "../../src/control/activation.ts";
import { FrameDecoder,writeFrame } from "../../src/shared/node-framing.ts";

function startBroker(entry: string, dir: string) {
  const child = spawn(process.execPath, [entry,dir], { stdio: ["pipe","pipe","inherit"], windowsHide: true });
  const events = new EventEmitter();
  const decoder = new FrameDecoder({ onMessage: value => events.emit("reply", value) });
  child.stdout.on("data", chunk => decoder.push(chunk));
  return {
    child,
    async hello() {
      const response = once(events, "reply", { signal: AbortSignal.timeout(4000) });
      await writeFrame(child.stdin, { jsonrpc: "2.0", id: 1, method: "profile.hello", params: { browserContractVersion: 1 } });
      return (await response)[0];
    },
  };
}

test("an idle upgrade reconnects the extension so the next worker receives its profile hello", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-broker-upgrade-"));
  const previous = { root: path.join(dir, "previous"), version: "2.0.3" };
  const next = { root: path.join(dir, "next"), version: "2.0.5" };
  const entry = path.join(dir, "broker.ts");
  const broker = new URL("../../src/control/browser-broker.ts", import.meta.url).href;
  const framing = new URL("../../src/shared/node-framing.ts", import.meta.url).href;
  const children: ReturnType<typeof startBroker>["child"][] = [];
  try {
    fs.writeFileSync(entry, `import { runBrowserBroker } from ${JSON.stringify(broker)}; await runBrowserBroker(process.argv[2]);`);
    for (const { root,version } of [previous,next]) {
      const runtime = path.join(root, "native-host", "dist");
      fs.mkdirSync(runtime, { recursive: true });
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
      fs.writeFileSync(path.join(runtime, "runtime.js"), `
        import { FrameDecoder,writeFrame } from ${JSON.stringify(framing)};
        const decoder = new FrameDecoder({ onMessage({ id,method }) {
          const result = method === "runtime.activity" ? { extensionIdle: true } : { nativeHostVersion: ${JSON.stringify(version)} };
          void writeFrame(process.stdout, { jsonrpc: "2.0", id, result });
        } });
        process.stdin.on("data", chunk => decoder.push(chunk));
      `);
    }
    fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify(previous));
    fs.writeFileSync(path.join(dir, "update-check.json"), JSON.stringify({ nextCheckAt: Date.now() + 60000 }));

    const original = startBroker(entry, dir);
    children.push(original.child);
    expect(await original.hello()).toMatchObject({ result: { nativeHostVersion: previous.version } });
    expect(await activateRelease(dir, next)).toBe(true);
    expect(await once(original.child, "close", { signal: AbortSignal.timeout(8000) })).toEqual([0,null]);

    const replacement = startBroker(entry, dir);
    children.push(replacement.child);
    expect(await replacement.hello()).toMatchObject({ result: { nativeHostVersion: next.version } });
    const closed = once(replacement.child, "close", { signal: AbortSignal.timeout(4000) });
    replacement.child.stdin.end();
    expect(await closed).toEqual([0,null]);
  } finally {
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(async child => {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 15000);
