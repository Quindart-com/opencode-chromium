import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createSiteResolver,
  validateSiteRead,
  readSiteTask,
  registryRequest,
  siteGrant,
  storyId,
} from "../site-registry/client.ts";
import { fieldsForTask } from "../site-registry/intent.ts";
import { packageField, packageResource, readPackage, type PackageField } from "../site-registry/package-read.ts";
import type { BrowserContext } from "../core/tool-definition.ts";
import { defineObjectOperation } from "./operation-definition.ts";
import { assertNavigationAllowed } from "./url-policy.ts";

export const resolveArgs = { tabId: z.number().int().positive(), task: z.string().trim().min(1).max(100) };
export const readArgs = {
  tabId: z.number().int().positive(),
  handle: z.string().uuid().optional(),
  task: resolveArgs.task.optional(),
};
type TabBinding = { profile: string; url: string };
export function createSiteOperations(
  getTab: (context: BrowserContext, tabId: number) => Promise<TabBinding>,
) {
  const resolve = createSiteResolver();
  // Cache only verified capability metadata. Public package values are always fetched fresh.
  const packages = new Map<string, { revision: number | null; until: number }>();
  const packageStarts: number[] = [];
  let packageRetryAt = 0;
  async function fetchPackage(name: NonNullable<ReturnType<typeof packageResource>>, field: PackageField) {
    const now = Date.now();
    while (packageStarts.length && packageStarts[0]! <= now - 60000) packageStarts.shift();
    if (now < packageRetryAt || packageStarts.length >= 12) throw Object.assign(Error("SITE_PROVIDER_THROTTLED"), { retryable: false });
    packageStarts.push(now);
    try { return await readPackage(name, field); } catch (error) {
      if (error instanceof Error && [403, 429].includes(Number(Reflect.get(error, "status")))) {
        const header = Reflect.get(error, "retryAfter");
        const retry = typeof header === "string" && /^\d+$/.test(header) ? now + Number(header) * 1000 : Date.parse(String(header));
        packageRetryAt = Math.max(now + 60000, Number.isFinite(retry) ? retry : 0);
      }
      throw error;
    }
  }
  async function packageRevision(profile: string, grant: string, field: PackageField) {
    const key = JSON.stringify([profile, grant, field]);
    const hit = packages.get(key);
    if (hit && hit.until > Date.now()) return { revision: hit.revision, cached: true };
    const { revision } = z.strictObject({ revision: z.number().int().positive().nullable() }).parse(
      await registryRequest(profile, "lookup", { site: "npm", field }));
    if (packages.size >= 64) packages.delete(packages.keys().next().value!);
    packages.set(key, { revision, until: Date.now() + (revision ? 60000 : 5000) });
    return { revision, cached: false };
  }
  const handles = new Map<string, { scope: string; version: number; key: string; fields: string[]; until: number }>();
  async function binding(context: BrowserContext, tabId: number) {
    const { profile, url } = await getTab(context, tabId);
    const grant = siteGrant(profile);
    if (grant === null) throw Error("SITE_REGISTRY_DISABLED");
    assertNavigationAllowed(url, context.urlPolicy);
    const name = packageResource(url);
    if (name && !grant.endsWith("\npublic-packages-v1")) throw Error("SITE_REGISTRY_DISABLED");
    const item = name ? undefined : storyId(url),
      session = context.sessionId ?? context.sessionID;
    if (!session) throw Error("SITE_SESSION_REQUIRED");
    return { profile, grant, item, name, scope: JSON.stringify([session, profile, grant, tabId, name ?? item]) };
  }
  return {
    browser_site_resolve: defineObjectOperation({
      capabilityOnly: true,
      args: resolveArgs,
      description: "Find verified public reads for this story or supported npm package.",
      async execute({ tabId, task }, context) {
        const { profile, grant, scope, item, name } = await binding(context, tabId);
        const field = name ? packageField(task) : null;
        const { revision, cached: packageCached } = field ? await packageRevision(profile, grant, field) : { revision: null, cached: false };
        const { matches, cached } = name
          ? { matches: field && revision ? [{ key: field, version: revision, title: "Read package " + field }] : [], cached: packageCached }
          : await resolve(profile, task, item);
        const fields = name ? (field ? [field] : []) : fieldsForTask(task, item);
        return {
          cached,
          matches: matches.map(({ key, version, title }) => {
            const handle = randomUUID();
            if (handles.size >= 256) handles.delete(handles.keys().next().value!);
            handles.set(handle, { scope, key, version, fields, until: Date.now() + 60000 });
            return { handle, key, title, version };
          }),
        };
      },
    }),
    browser_site_read: defineObjectOperation({
      capabilityOnly: true,
      args: readArgs,
      description: "Invoke a verified read using a task or its session-bound handle.",
      async execute({ tabId, handle, task }, context) {
        const { profile, grant, scope, item, name } = await binding(context, tabId);
        if (Boolean(task) === Boolean(handle)) throw Error("Pass exactly one of task or handle.");
        const hit = handle ? handles.get(handle) : undefined;
        if (handle && (!hit || hit.scope !== scope || hit.until <= Date.now())) throw Error("SITE_HANDLE_MISMATCH");
        if (name) {
          const field = packageField(task ?? hit!.key);
          if (!field) throw Error("SITE_TASK_UNSUPPORTED");
          const { revision } = await packageRevision(profile, grant, field);
          if (!revision || (hit && revision !== hit.version)) throw Error("SITE_REVOKED_OR_MISSING");
          if ((await binding(context, tabId)).scope !== scope) throw Error("SITE_HANDLE_MISMATCH");
          const data = await fetchPackage(name, field);
          if ((await binding(context, tabId)).scope !== scope) throw Error("SITE_HANDLE_MISMATCH");
          return { data, source: "Public npm registry", retrievedAt: new Date().toISOString() };
        }
        if (item === undefined) throw Error("SITE_UNSUPPORTED_RESOURCE");
        const response = task
          ? await readSiteTask(profile, task, item)
          : await registryRequest(profile, "read", { key: hit!.key, version: hit!.version, item });
        if ((await binding(context, tabId)).scope !== scope) throw Error("SITE_HANDLE_MISMATCH");
        const { data } = validateSiteRead(response, item, task ? fieldsForTask(task, item) : hit!.fields);
        return { data, source: "Hacker News public API", retrievedAt: new Date().toISOString() };
      },
    }),
  };
}
