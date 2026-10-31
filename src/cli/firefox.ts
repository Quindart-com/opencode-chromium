import fs from "node:fs";
import net from "node:net";
import { firefoxConfigPath,validateEndpoint } from "../../native-host/src/firefox/backend.ts";
import { atomicWrite } from "../management/transaction.js";
import { readProfileRegistrations } from "../shared/profile-registry.ts";
import { record } from "../shared/values.ts";

export async function firefoxHealth(profileId: string) {
  const file = firefoxConfigPath(profileId);
  if (!fs.existsSync(file)) return { profileId, configured: false, reachable: false, instruction: `Run opencode-chromium firefox configure --profile ${profileId} --port PORT, then launch that profile with --remote-debugging-port PORT.` };
  const endpoint = validateEndpoint(record(JSON.parse(fs.readFileSync(file, "utf8")) as unknown).endpoint);
  const url = new URL(endpoint);
  const reachable = await new Promise<boolean>(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(url.port) });
    const finish = (value: boolean): void => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => finish(false));
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
  });
  return { profileId, configured: true, endpoint, reachable, identityVerified: false, instruction: reachable ? "The loopback port is reachable. Browser identity is verified by the extension tab bridge when automation attaches." : "Launch the selected Firefox/LibreWolf profile with the configured remote port. Check browser privacy settings if its Remote Agent is disabled. Do not restart a browser with active agent sessions." };
}

export async function runFirefoxCommand(argv: string[]) {
  const at = (name: string): string | undefined => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const profileId = at("--profile");
  if (!profileId) throw new Error("Choose a connected Firefox profile with --profile PROFILE_ID");
  const file = firefoxConfigPath(profileId);
  if (argv[0] === "status") return firefoxHealth(profileId);
  if (argv[0] !== "configure") throw new Error("Usage: firefox configure --profile PROFILE_ID --port PORT | firefox status --profile PROFILE_ID");
  const port = Number(at("--port"));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a loopback port between 1024 and 65535");
  const endpoint = validateEndpoint(`ws://127.0.0.1:${port}/session`);
  const profile = readProfileRegistrations().find(item => item.profileId === profileId);
  if (!profile) throw new Error("Connect the Firefox extension first, then copy its profile ID from Profiles");
  if (!/Firefox|LibreWolf/i.test(profile.browserName ?? "")) throw new Error("The selected profile is not registered by a Firefox-based browser");
  if (!argv.includes("--dry-run")) atomicWrite(file, JSON.stringify({ endpoint }, null, 2) + "\n");
  return { profileId, endpoint, dryRun: argv.includes("--dry-run"), launchArguments: ["--remote-debugging-port", String(port)], instruction: "Add these arguments when launching the selected profile. Configuration does not restart your browser. The extension verifies tab identity before attaching." };
}
