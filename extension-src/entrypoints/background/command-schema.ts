import { z } from "zod/mini";
import { CURSOR_ACTIONS } from "../../../src/shared/cursor-actions.ts";
const commandSchema = z.looseObject({
    url: z.optional(z.string()), enabled: z.optional(z.boolean()), files: z.optional(z.array(z.string())),
    data: z.optional(z.looseObject({ files: z.optional(z.array(z.string())) })),
    objectId: z.optional(z.string()), nodeId: z.optional(z.number()), backendNodeId: z.optional(z.number()),
    x: z.optional(z.number()), y: z.optional(z.number()), text: z.optional(z.string()),
    type: z.optional(z.string()), buttons: z.optional(z.number()),
});
const cursorSchema = z.object({ x: z.number(), y: z.number(), visible: z.optional(z.boolean()) });
const stepSchema = z.object({
    method: z.string(), commandParams: z.optional(commandSchema), command_params: z.optional(commandSchema),
    cursor: z.optional(cursorSchema), timeoutMs: z.optional(z.number()), delayMs: z.optional(z.number()), delay_ms: z.optional(z.number()),
});
const keepSchema = z.union([z.int(), z.object({
        tabId: z.optional(z.int()), tab_id: z.optional(z.int()), tab: z.optional(z.object({ id: z.int() })),
        status: z.optional(z.enum(["handoff", "deliverable"])),
    })]);
export const commandParamsSchema = z.looseObject({
    creationRequestId: z.optional(z.string()),
    session_id: z.optional(z.string()), sessionId: z.optional(z.string()), turn_id: z.optional(z.string()), turnId: z.optional(z.string()),
    frameId: z.optional(z.string()), deadlineAt: z.optional(z.number()),
    tabId: z.optional(z.int()), tab_id: z.optional(z.int()), target: z.optional(z.object({ tabId: z.optional(z.int()) })),
    url_policy: z.optional(z.object({ allowedOrigins: z.optional(z.array(z.string())), blockedOrigins: z.optional(z.array(z.string())) })),
    cursorId: z.optional(z.string()), cursor_id: z.optional(z.string()), x: z.optional(z.number()), y: z.optional(z.number()),
    moveSequence: z.optional(z.int()), move_sequence: z.optional(z.int()), visible: z.optional(z.boolean()),
    action: z.optional(z.enum(CURSOR_ACTIONS)), waitForArrival: z.optional(z.boolean()),
    timeoutMs: z.optional(z.number()), timeout_ms: z.optional(z.number()), method: z.optional(z.string()),
    commandParams: z.optional(commandSchema), command_params: z.optional(commandSchema), steps: z.optional(z.array(stepSchema)),
    methods: z.optional(z.array(z.string())), methodPrefix: z.optional(z.string()), limit: z.optional(z.int()),
    active: z.optional(z.boolean()), foreground: z.optional(z.boolean()), clear: z.optional(z.boolean()),
    label: z.optional(z.nullable(z.string())), name: z.optional(z.string()), query: z.optional(z.string()), from: z.optional(z.string()), to: z.optional(z.string()),
    bypassCache: z.optional(z.boolean()), keep: z.optional(z.array(keepSchema)), command: z.optional(z.unknown()),
    blockedTabs: z.optional(z.array(z.object({ tabId: z.int(), reason: z.string(), profileId: z.optional(z.nullable(z.string())) }))),
    pageUrl: z.optional(z.string()), decisionState: z.optional(z.string()),
});
export type CommandParams = z.infer<typeof commandParamsSchema>;
export type CdpCommandParams = z.infer<typeof commandSchema>;
export type KeepItem = z.infer<typeof keepSchema>;
