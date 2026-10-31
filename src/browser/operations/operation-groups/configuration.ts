import { z } from "zod";
import { record } from "../../../shared/values.ts";
import { browserRequest } from "../../client.ts";
import { defineBrowserOperation,type BrowserOperationDependencies as Dependencies } from "../../operation-definition.ts";
export { keyDispatchEvents,parseKeyPress } from "../../keyboard.ts";
export { pageInspectExpression,visualMapExpression } from '../inspection-expressions.ts';
export { pageSearchUnitsExpression } from '../snapshot-expressions.ts';

// The browser operation engine is intentionally adapter-neutral. MCP, OpenCode,
// and direct SDK adapters all consume this same operation registry.

const tool = Object.assign(defineBrowserOperation, { schema: z });
export function createConfigurationOperations(dependencies: Dependencies) {
  const { usedProfilesBySession, sessionKey, sessionParams, targetProfileIdsForSession, extensionRequest, clearSessionCache, stringify, environmentController, applyEnvironment, resetEnvironment } = dependencies;
  return {
      browser_configure: tool({
        description: "Apply persistent emulation, network, and initialization overrides to a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          environment: tool.schema.object({
            reset: tool.schema.boolean().optional().describe("Clear all applied overrides instead of applying new ones."),
            viewport: tool.schema.object({
              width: tool.schema.number().int().positive(),
              height: tool.schema.number().int().positive(),
              deviceScaleFactor: tool.schema.number().min(0).optional(),
              mobile: tool.schema.boolean().optional(),
              touch: tool.schema.boolean().optional(),
            }).optional(),
            network: tool.schema.union([
              tool.schema.enum(["offline", "slow-2g", "slow-3g", "fast-3g", "slow-4g", "online"]),
              tool.schema.object({
                offline: tool.schema.boolean().optional(),
                latency: tool.schema.number().min(0).optional(),
                downloadThroughput: tool.schema.number().optional(),
                uploadThroughput: tool.schema.number().optional(),
              }),
            ]).optional(),
            cpuThrottling: tool.schema.number().min(1).optional(),
            colorScheme: tool.schema.enum(["light", "dark", "no-preference"]).optional(),
            geolocation: tool.schema.object({
              latitude: tool.schema.number(),
              longitude: tool.schema.number(),
              accuracy: tool.schema.number().min(0).optional(),
            }).optional(),
            userAgent: tool.schema.string().max(500).optional(),
            headers: tool.schema.record(tool.schema.string(), tool.schema.string()).optional(),
            initScripts: tool.schema.array(tool.schema.string().max(20000)).max(50).optional(),
          }),
        },
        async execute(args, context) {
          const environment = args.environment ?? {};
          await extensionRequest(context, "getTab", { tabId: args.tabId });
          if (environment.reset === true) await resetEnvironment(context, args.tabId);
          else await applyEnvironment(context, args.tabId, environment);
          return stringify({ configured: true, tabId: args.tabId, reset: environment.reset === true });
        },
      }),

browser_finalize: tool({
        description: "End the session: preserve all tabs in a blue group for human review and release ownership. Only explicit keep status 'handoff' retains a tab for later work in the green session group.",
        args: {
          keep: tool.schema.array(
            tool.schema.union([
              tool.schema.number().int().positive(),
              tool.schema.object({
                tabId: tool.schema.number().int().positive(),
                status: tool.schema.enum(["handoff", "deliverable"]).default("deliverable"),
                profileId: tool.schema.string().optional(),
              }),
            ]),
          ).default([]),
          blockedTabs: tool.schema.array(tool.schema.object({ tabId: tool.schema.number().int().positive(), profileId: tool.schema.string().nullable(), reason: tool.schema.string() })).default([]),
        },
        async execute(args, context) {
          const profileIds = await targetProfileIdsForSession(context);
          const keep: { tabId: number; status: "handoff" | "deliverable"; profileId?: string }[] = args.keep.map((item) => (typeof item === "number" ? { tabId: item, status: "deliverable" as const } : item));
          if (profileIds.length > 1 && keep.some((item) => !item.profileId)) {
            throw new Error("browser_finalize keep items must include profileId when multiple browser profiles were used");
          }

          const results: Record<string, unknown> = {};
          await Promise.all(profileIds.map(async (profileId: string) => {
            const profileKeep = keep
              .filter((item) => !item.profileId || item.profileId === profileId)
              .map(({ tabId, status }) => ({ tabId, status }));
            const blockedTabs = args.blockedTabs.filter(tab => !tab.profileId || tab.profileId === profileId);
            try { results[profileId] = await browserRequest("finalizeTabs", sessionParams(context, { profile_id: profileId, keep: profileKeep, blockedTabs }), { profileId }); }
            catch (error) { results[profileId] = { partial: true, error: error instanceof Error ? error.message : String(error) }; }
            if (!record(results[profileId]).partial) {
              clearSessionCache(context, profileId);
              environmentController.forgetSession(`${sessionKey(context)}:${profileId}:`);
            }
          }));
          const partial = Object.values(results).some(value => record(value).partial === true);
          if (!partial) usedProfilesBySession.delete(sessionKey(context));
          return stringify({ partial, profiles: results });
        },
      }),
  };
}
