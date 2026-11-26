import { createHash, generateKeyPairSync, randomUUID, sign, createPublicKey } from "node:crypto";
import fs from "node:fs";
import { request as httpsRequest } from "node:https";
import type { TcpNetConnectOpts } from "node:net";
import path from "node:path";
import { z } from "zod";
import { runtimeDirectory } from "../control/state.ts";
import { fieldsForTask } from "./intent.ts";

// Deployment configuration belongs to the local installation. Only accept a hosted HTTPS origin.
export function configuredRegistryOrigin() {
  let origin = process.env.OPENCODE_BROWSER_SITE_REGISTRY_ORIGIN;
  if (!origin) {
    try { origin = fs.readFileSync(path.join(runtimeDirectory(), "site-registry-origin"), "utf8").trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!origin || !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.convex\.site$/.test(origin))
    throw Object.assign(new Error("SITE_REGISTRY_UNCONFIGURED"), { code: "SITE_REGISTRY_UNCONFIGURED", retryable: false });
  return origin;
}
export const pilotSite = "news.ycombinator.com";
const identityPaths = (profile: string) => {
  if (!profile || profile.length > 256) throw Error("A browser profile is required");
  const dir = path.join(
    runtimeDirectory(),
    "site-registry",
    createHash("sha256").update(profile).digest("hex"),
  );
  return { dir, key: path.join(dir, "install.pem"), enabled: path.join(dir, "enabled") };
};
export function siteGrant(profile: string) {
  try {
    const grant = fs.readFileSync(identityPaths(profile).enabled, "utf8");
    return grant.startsWith(configuredRegistryOrigin() + "\n") ? grant : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export function siteEnabled(profile: string) {
  return siteGrant(profile) !== null;
}
export function configureSite(profile: string, enabled: boolean, includePackages = false) {
  const files = identityPaths(profile);
  if (!enabled) {
    fs.rmSync(files.enabled, { force: true });
    return;
  }
  const origin = configuredRegistryOrigin();
  fs.mkdirSync(files.dir, { mode: 0o700, recursive: true });
  if (!fs.existsSync(files.key)) {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pending = files.key + "." + randomUUID();
    fs.writeFileSync(pending, pair.privateKey.export({ format: "pem", type: "pkcs8" }), {
      mode: 0o600,
      flag: "wx",
    });
    try {
      fs.linkSync(pending, files.key);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      fs.unlinkSync(pending);
    }
  }
  const current = siteGrant(profile);
  if (current !== null && (!includePackages || current.endsWith("\npublic-packages-v1"))) return;
  const pending = files.enabled + "." + randomUUID();
  try {
    fs.writeFileSync(pending, origin + "\n" + randomUUID() + (includePackages ? "\npublic-packages-v1" : ""), { mode: 0o600, flag: "wx" });
    fs.renameSync(pending, files.enabled);
  } finally { fs.rmSync(pending, { force: true }); }
}
export async function registryRequest(
  profile: string,
  route: "lookup" | "read" | "submit" | "withdraw",
  input: unknown,
) {
  const files = identityPaths(profile);
  if (route !== "withdraw" && !siteEnabled(profile)) throw Error("SITE_REGISTRY_DISABLED");
  const registryOrigin = configuredRegistryOrigin();
  return signedRegistryRequest(registryOrigin, route, input, fs.readFileSync(files.key));
}

export async function signedRegistryRequest(registryOrigin: string, route: "lookup" | "read" | "submit" | "withdraw" | "patterns" | "forget-patterns", input: unknown, key: Buffer | string, signal?: AbortSignal) {
  if (registryOrigin !== configuredRegistryOrigin()) throw Error("SITE_DESTINATION_CHANGED");
  const pub = createPublicKey(key).export({ format: "jwk" });
  const owner = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x!, "base64url"),
    Buffer.from(pub.y!, "base64url"),
  ]).toString("base64");
  const stamp = String(Date.now()),
    nonce = randomUUID(),
    resource = "/v1/" + route,
    body = JSON.stringify(input);
  const proof = sign("sha256", Buffer.from([registryOrigin, resource, stamp, nonce, body].join("\n")), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64");
  // Keep the address-family fallback local to registry traffic. The short Node default
  // can abandon reachable addresses on a higher-latency connection.
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const connection: Pick<TcpNetConnectOpts, "autoSelectFamily" | "autoSelectFamilyAttemptTimeout"> = {
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 1500,
    };
    const request = httpsRequest(
      registryOrigin + resource,
      {
        method: "POST",
        ...connection,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
        headers: {
          "Content-Type": "application/json",
          "X-Proof": proof,
          "X-Time": stamp,
          "X-Install": owner,
          "X-Nonce": nonce,
        },
      },
      resolve,
    );
    request.on("error", reject);
    request.end(body);
  });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) {
      response.destroy();
      throw Error("SITE_RESPONSE_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (response.statusCode !== 200) {
    const { error: code } = z.object({ error: z.string() }).parse(data);
    throw Object.assign(new Error(code), {
      code,
      status: response.statusCode,
      retryAfter: response.headers["retry-after"],
    });
  }
  return data;
}

// Only task vocabulary leaves the machine. Resource identifiers and prose stay local.
export function taskWords(hint: string, item?: number) {
  return fieldsForTask(hint, item).join(" ");
}
const matches = z.object({
  matches: z
    .array(
      z.object({ key: z.string().max(48), title: z.string().max(80), version: z.number().int().positive() }),
    )
    .max(3),
});
type Matches = z.infer<typeof matches>["matches"];
export function createSiteResolver(request = registryRequest, { persist = false } = {}) {
  const cache = new Map<string, { until: number; matches: Matches }>();
  return async (profile: string, hint: string, item?: number) => {
    const grant = siteGrant(profile);
    if (grant === null) throw Error("SITE_REGISTRY_DISABLED");
    const words = taskWords(hint, item);
    if (!words) return { matches: [], cached: false };
    const key = JSON.stringify([profile, grant, words]),
      hit = cache.get(key);
    if (hit && hit.until > Date.now()) return { matches: hit.matches, cached: true };
    const filename = path.join(identityPaths(profile).dir, "lookup-" + words.replaceAll(" ", "-") + ".json");
    if (persist) {
      try {
        const row = JSON.parse(fs.readFileSync(filename, "utf8"));
        const cached = matches.safeParse(row);
        if (
          cached.success &&
          row.grant === grant &&
          row.until > Date.now() &&
          row.until <= Date.now() + 60000
        )
          return { ...cached.data, cached: true };
      } catch {
        /* Missing, expired or incomplete cache entries are refetched. */
      }
    }
    const result = matches.parse(await request(profile, "lookup", { site: pilotSite, words })).matches;
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    const entry = { until: Date.now() + (result.length ? 60000 : 5000), matches: result };
    cache.set(key, entry);
    if (persist) {
      const temp = filename + "." + randomUUID();
      try {
        fs.writeFileSync(temp, JSON.stringify({ ...entry, grant }), { flag: "wx", mode: 0o600 });
        fs.renameSync(temp, filename);
      } catch {
        /* Persistence is optional when a cache file is locked or storage is full. */
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
    return { matches: result, cached: false };
  };
}
export function validateSiteRead(response: unknown, item: number, fields: string[]) {
  const shape: Record<string, z.ZodType> = { id: z.literal(item) };
  for (const field of fields) shape[field] = field === "by" || field === "title" ? z.string().max(512) : z.number().int();
  return z.object({ data: z.strictObject(shape) }).parse(response);
}

export async function readSiteTask(profile: string, task: string, item: number) {
  if (!siteEnabled(profile)) throw Error("SITE_REGISTRY_DISABLED");
  const words = taskWords(task, item);
  if (!words) throw Error("SITE_TASK_UNSUPPORTED");
  return validateSiteRead(await registryRequest(profile, "read", { words, item }), item, words.split(" "));
}
export function storyId(url: string) {
  const tab = new URL(url),
    id = tab.searchParams.get("id");
  if (
    tab.origin !== "https://" + pilotSite ||
    tab.pathname !== "/item" ||
    tab.username ||
    tab.password ||
    !id ||
    !/^[1-9]\d{0,9}$/.test(id) ||
    tab.searchParams.getAll("id").length !== 1
  )
    throw Error("SITE_UNSUPPORTED_RESOURCE");
  return Number(id);
}
