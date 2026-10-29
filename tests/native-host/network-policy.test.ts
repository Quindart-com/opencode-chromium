import { expect,test } from "bun:test";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("native-host network policy preserves longer custom timeouts and never changes its parent harness", async () => {
  const before = net.getDefaultAutoSelectFamilyAttemptTimeout(), run = promisify(execFile);
  const module = new URL("../../native-host/src/network-policy.ts", import.meta.url).href;
  for (const initial of [250, 2000]) {
    const code = `import net from 'node:net'; import {configureNetworkFamilyFallback} from ${JSON.stringify(module)}; configureNetworkFamilyFallback(); console.log(net.getDefaultAutoSelectFamilyAttemptTimeout());`;
    const result = await run("node", [`--network-family-autoselection-attempt-timeout=${initial}`, "--input-type=module", "-e", code], { windowsHide: true });
    expect(Number(result.stdout.trim())).toBe(Math.max(initial, 1000));
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(before);
  }
});
