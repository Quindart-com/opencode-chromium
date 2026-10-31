import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { z } from "zod";
import { defineObjectOperation } from "../browser/operation-definition.ts";
import { record } from "../shared/values.ts";
import type { RuntimePort } from "./runtime-port.ts";

const MAX_PIXELS = 2_000_000;
const MAX_PNG_BYTES = 4_000_000;
const tabId = z.number().int().positive();
function fail(code: string, message: string | undefined): never { throw Object.assign(new Error(message), { code, uncertain: false, retryable: false }); }

function decodePng(bytes: Buffer) {
  if (bytes.length > MAX_PNG_BYTES || bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fail("DIFF_IMAGE_INVALID", "Pixel diffs require a bounded PNG screenshot.");
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > MAX_PIXELS) fail("DIFF_IMAGE_LIMIT", "Use a viewport or clip of at most two million pixels.");
  return PNG.sync.read(bytes, { checkCRC: true });
}

export function pixelDiff(before: Buffer, after: Buffer, threshold = 0.1) {
  const a = decodePng(before), b = decodePng(after);
  if (a.width !== b.width || a.height !== b.height) fail("DIFF_SIZE_MISMATCH", "Viewport dimensions changed; capture a new baseline.");
  const output = new PNG({ width: a.width, height: a.height });
  let changedPixels = 0;
  let left = a.width, top = a.height, right = -1, bottom = -1;
  for (let offset = 0; offset < a.data.length; offset += 4) {
    let difference = 0;
    for (let c = 0; c < 3; c++) {
      const first = 255 + (a.data[offset + c]! - 255) * a.data[offset + 3]! / 255;
      const second = 255 + (b.data[offset + c]! - 255) * b.data[offset + 3]! / 255;
      difference = Math.max(difference, Math.abs(first - second));
    }
    const changed = difference > threshold * 255;
    if (changed) {
      changedPixels++;
      const pixel = offset / 4, x = pixel % a.width, y = Math.floor(pixel / a.width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    const gray = Math.round(220 + (b.data[offset]! + b.data[offset + 1]! + b.data[offset + 2]!) / 3 * 0.12);
    output.data.set(changed ? [230, 40, 110, 255] : [gray, gray, gray, 255], offset);
  }
  return {
    width: a.width, height: a.height, changedPixels,
    changedRatio: changedPixels / (a.width * a.height), threshold,
    bounds: changedPixels ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null,
    image: PNG.sync.write(output),
  };
}

const nodeSchema = z.object({ selector: z.string().nullable().optional(), tagName: z.string().nullable().optional(), role: z.string().nullable().optional(), name: z.string().nullable().optional(), text: z.string().nullable().optional(), disabled: z.boolean().optional() });
type SemanticNode = z.infer<typeof nodeSchema>;
const clipSchema = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), width: z.number().positive().max(1600), height: z.number().positive().max(1200) });
const captureSchema = z.object({ tabId, kind: z.enum(["snapshot", "pixels", "both"]).default("snapshot"), clip: clipSchema.optional() });
const baselineSchema = z.object({ version: z.literal(1), type: z.literal("observation-baseline"), profileId: z.string().nullable(), tabId,
  kind: z.enum(["snapshot", "pixels", "both"]), clip: clipSchema.nullable(), urlIdentity: z.string(), nodes: z.array(nodeSchema).max(500).optional(), image: z.string().optional() });
type Baseline = z.infer<typeof baselineSchema>;
function semanticNodes(snapshot: unknown): SemanticNode[] {
  const source = record(snapshot).nodes;
  return (Array.isArray(source) ? source : []).slice(0, 500).map(value => { const node = record(value); return nodeSchema.parse({ ...node, name: node.ariaName }); });
}
export function snapshotDiff(before: SemanticNode[], after: SemanticNode[], limit = 40) {
  const old = new Map(before.map(node => [node.selector, node])), next = new Map(after.map(node => [node.selector, node]));
  const added: SemanticNode[] = [], removed: SemanticNode[] = [], changed: { before: SemanticNode; after: SemanticNode }[] = [];
  for (const [selector, node] of next) {
    const previous = old.get(selector);
    if (!previous) added.push(node);
    else if (JSON.stringify(previous) !== JSON.stringify(node)) changed.push({ before: previous, after: node });
  }
  for (const [selector, node] of old) if (!next.has(selector)) removed.push(node);
  return { counts: { added: added.length, removed: removed.length, changed: changed.length }, added: added.slice(0, limit), removed: removed.slice(0, limit), changed: changed.slice(0, limit), truncated: Math.max(added.length, removed.length, changed.length) > limit };
}
export function createObservationOperations(runtime: RuntimePort) {
  const compareSchema = z.object({ tabId, baseline: z.string().max(300), threshold: z.number().min(0).max(1).default(0.1), limit: z.number().int().min(1).max(100).default(40) });
  async function capture(input: z.output<typeof captureSchema>, sessionId: string): Promise<Baseline> {
    const session = runtime.getSession(sessionId);
    const snapshot = z.looseObject({ url: z.string().optional(), viewport: z.object({ width: z.number(), height: z.number() }).optional() }).parse(await runtime.invoke("browser_dom_snapshot", { tabId: input.tabId }, sessionId));
    const payload: Baseline = { version: 1, type: "observation-baseline", profileId: session.profileId, tabId: input.tabId, kind: input.kind, clip: input.clip ?? null, urlIdentity: createHash("sha256").update(snapshot.url ?? "").digest("hex") };
    if (input.kind !== "pixels") payload.nodes = semanticNodes(snapshot);
    if (input.kind !== "snapshot") {
      const shot = z.object({ base64: z.string() }).parse(await runtime.invoke("browser_screenshot", { tabId: input.tabId, format: "png", allowFormatFallback: false, fullPage: false,
        clip: input.clip ?? { x: 0, y: 0, width: Math.min(snapshot.viewport?.width ?? 1280, 1600), height: Math.min(snapshot.viewport?.height ?? 800, 1200), scale: 1 } }, sessionId));
      const bytes = Buffer.from(shot.base64, "base64"); decodePng(bytes);
      payload.image = runtime.artifacts.create({ sessionId, mimeType: "image/png", data: bytes, label: "diff-baseline-image" }).uri;
    }
    return payload;
  }
  return {
    browser_observation_capture: defineObjectOperation({ capabilityOnly: true, args: captureSchema.shape, async execute(input, context) {
      const sessionId = context.sessionID ?? context.sessionId ?? "opencode";
      const value = await capture(input, sessionId);
      const artifact = runtime.artifacts.create({ sessionId, mimeType: "application/json", data: value, label: "diff-baseline" });
      return { baseline: artifact.uri, kind: input.kind, capturedAt: artifact.createdAt, image: value.image ?? null };
    } }),
    browser_observation_diff: defineObjectOperation({ capabilityOnly: true, args: compareSchema.shape, async execute(input, context) {
      const sessionId = context.sessionID ?? context.sessionId ?? "opencode";
      const artifact = runtime.artifacts.read(input.baseline, { sessionId });
      if (!artifact || artifact.label !== "diff-baseline") fail("DIFF_BASELINE_MISSING", "Baseline expired, missing, or belongs to another session.");
      const before = baselineSchema.parse((JSON.parse(artifact.data.toString("utf8")) as unknown));
      if (before.profileId !== runtime.getSession(sessionId).profileId || before.tabId !== input.tabId) fail("DIFF_SCOPE_MISMATCH", "Compare the baseline in its original browser profile and tab.");
      const after = await capture({ tabId: input.tabId, kind: before.kind, clip: before.clip ?? undefined }, sessionId);
      if (before.urlIdentity !== after.urlIdentity) fail("DIFF_NAVIGATION_CHANGED", "The tab navigated; capture a baseline for the current page.");
      const result: { kind: Baseline["kind"]; snapshot?: ReturnType<typeof snapshotDiff>; pixels?: Omit<ReturnType<typeof pixelDiff>, "image"> & { artifact: string } } = { kind: before.kind };
      if (before.nodes) result.snapshot = snapshotDiff(before.nodes, after.nodes ?? [], input.limit);
      if (before.image && after.image) {
        const first = runtime.artifacts.read(before.image, { sessionId }), second = runtime.artifacts.read(after.image, { sessionId });
        if (!first || !second) fail("DIFF_BASELINE_MISSING", "Screenshot baseline expired; capture a new baseline.");
        const { image, ...metrics } = pixelDiff(first.data, second.data, input.threshold);
        result.pixels = { ...metrics, artifact: runtime.artifacts.create({ sessionId, mimeType: "image/png", data: image, label: "pixel-diff" }).uri };
      }
      return result;
    } }),
  };
}
