import { z } from "zod";
import {
  NETWORK_INSPECT_ARGS,
  NETWORK_INSPECT_MANIFEST,
  NETWORK_INSPECT_SCHEMA,
} from "./network-capability.js";

function inputSchemaFor(required = []) {
  const requiredValue = z.custom((value) => value !== undefined, { message: "Required" });
  return z.object(Object.fromEntries(required.map((field) => [field, requiredValue]))).passthrough();
}

const PACKS = {
  core: {
    description: "Navigate, find, interact, assert, and observe a controlled browser.",
    capabilities: ["navigation.navigate", "navigation.reload", "forms.fill", "forms.type", "events.read"],
  },
  navigation: {
    description: "Navigation and tab movement capabilities.",
    capabilities: ["navigation.navigate", "navigation.reload", "navigation.back", "navigation.forward"],
  },
  forms: {
    description: "Form, keyboard, and selection capabilities.",
    capabilities: ["forms.fill", "forms.replaceText", "forms.fillForm", "forms.type", "forms.press", "forms.select"],
  },
  visual: {
    description: "DOM-first visual maps and screenshot artifacts.",
    capabilities: ["visual.map", "visual.screenshot"],
  },
  downloads: {
    description: "Read and clear browser download lifecycle events.",
    capabilities: ["downloads.events", "downloads.clear"],
  },
  events: {
    description: "Read projected console and network events.",
    capabilities: ["events.console", "events.network", "events.clear"],
  },
  network: {
    description: "Deep, tab-scoped request and response inspection with bounded redacted detail.",
    capabilities: ["network.inspect"],
  },
  clipboard: {
    description: "Read or write controlled-tab clipboard text after approval.",
    capabilities: ["clipboard.read", "clipboard.write"],
  },
  uploads: {
    description: "Set controlled file inputs after approval.",
    capabilities: ["uploads.setFileInput"],
  },
  diagnostics: {
    description: "Inspect profiles, tabs, capabilities, and raw CDP diagnostics.",
    capabilities: ["diagnostics.profiles", "diagnostics.tabs", "diagnostics.cdp"],
  },
  advanced: {
    description: "Advanced browser primitives available on explicit request.",
    capabilities: ["advanced.drag", "advanced.domSnapshot", "advanced.inspect", "advanced.locator"],
  },
  legacy: {
    description: "All 49 granular browser operations for compatibility and regression testing.",
    capabilities: [],
  },
};

const BUILT_INS = {
  "navigation.navigate": { operation: "browser_navigate", safety: "read", required: ["tabId", "url"], example: { url: "https://example.com" } },
  "navigation.reload": { operation: "browser_reload", safety: "read", required: ["tabId"] },
  "navigation.back": { operation: "browser_back", safety: "read", required: ["tabId"] },
  "navigation.forward": { operation: "browser_forward", safety: "read", required: ["tabId"] },
  "forms.fill": { operation: "browser_locator_fill", safety: "write", required: ["tabId", "selector", "value"] },
  "forms.replaceText": { operation: "browser_locator_fill", safety: "write", required: ["tabId", "selector", "value"] },
  "forms.fillForm": { operation: "browser_locator_fill", safety: "write", required: ["tabId", "selector", "value"] },
  "forms.type": { operation: "browser_type", safety: "write", required: ["tabId", "text"] },
  "forms.press": { operation: "browser_keypress", safety: "write", required: ["tabId", "key"] },
  "forms.select": { operation: "browser_locator_fill", safety: "write", required: ["tabId", "selector", "value"] },
  "visual.map": { operation: "browser_visual_map", safety: "read", required: ["tabId"] },
  "visual.screenshot": { operation: "browser_screenshot", safety: "read", required: ["tabId"] },
  "downloads.events": { operation: "browser_download_events", safety: "read", required: [] },
  "downloads.clear": { operation: "browser_clear_download_events", safety: "write", required: [] },
  "events.console": { operation: "browser_console_logs", safety: "read", required: ["tabId"] },
  "events.network": { operation: "browser_network_events", safety: "read", required: ["tabId"] },
  "events.clear": { operation: "browser_clear_events", safety: "write", required: ["tabId"] },
  "network.inspect": {
    operation: "browser_network_inspect",
    safety: "sensitive-read",
    required: ["tabId"],
    schema: NETWORK_INSPECT_SCHEMA,
    args: NETWORK_INSPECT_ARGS,
    description: "Inspect one controlled tab's request/response lifecycle, failures, timing, filters, and opt-in bounded bodies.",
    example: { tabId: "<tabId>", urlIncludes: "/api/", includeHeaders: true },
    manifest: NETWORK_INSPECT_MANIFEST,
  },
  "clipboard.read": { operation: "browser_clipboard_read_text", safety: "sensitive-read", required: ["tabId"] },
  "clipboard.write": { operation: "browser_clipboard_write_text", safety: "write", required: ["tabId", "text"] },
  "uploads.setFileInput": { operation: "browser_set_file_input", safety: "write", required: ["tabId", "selector", "files"] },
  "diagnostics.profiles": { operation: "browser_list_profiles", safety: "read", required: [] },
  "diagnostics.tabs": { operation: "browser_list_tabs", safety: "read", required: [] },
  "diagnostics.cdp": { operation: "browser_cdp", safety: "write", required: ["tabId", "method"] },
  "advanced.drag": { operation: "browser_drag", safety: "write", required: ["tabId", "path"] },
  "advanced.domSnapshot": { operation: "browser_dom_snapshot", safety: "read", required: ["tabId"] },
  "advanced.inspect": { operation: "browser_page_inspect", safety: "read", required: ["tabId"] },
  "advanced.locator": { operation: "browser_locator_text", safety: "read", required: ["tabId", "selector"] },
};

export function createCapabilityRegistry({ operations = {}, invoke } = {}) {
  const definitions = new Map();
  for (const [name, definition] of Object.entries(BUILT_INS)) {
    if (!operations[definition.operation]) continue;
    definitions.set(name, {
      name,
      version: "1",
      description: definition.description ?? `${name} via the shared browser operation engine.`,
      safety: definition.safety,
      required: definition.required,
      inputSchema: definition.schema ?? inputSchemaFor(definition.required),
      example: definition.example ?? Object.fromEntries(definition.required.map((field) => [field, `<${field}>`])),
      ...(definition.manifest ? { manifest: definition.manifest } : {}),
      async execute(input, context = {}) {
        const parsed = (definition.schema ?? inputSchemaFor(definition.required)).parse(input ?? {});
        return invoke(definition.operation, parsed, context);
      },
    });
  }
  for (const [name, operation] of Object.entries(operations)) {
    if (operation.capabilityOnly === true) continue;
    const capabilityName = `legacy.${name}`;
    definitions.set(capabilityName, {
      name: capabilityName,
      version: "1",
      description: `Compatibility capability for ${name}.`,
      safety: /(?:write|click|type|fill|upload|close|submit|publish|clipboard)/i.test(name) ? "write" : "read",
      required: [],
      inputSchema: z.object(operation.args ?? {}).passthrough(),
      example: {},
      async execute(input, context = {}) {
        return operation.execute(input ?? {}, context);
      },
    });
  }
  return {
    get(name) { return definitions.get(name); },
    has(name) { return definitions.has(name); },
    names() { return [...definitions.keys()]; },
    manifest(pack = "core") {
      const packDefinition = PACKS[pack];
      if (!packDefinition) {
        const error = new Error(`Unknown capability pack: ${pack}`);
        error.code = "CAPABILITY_PACK_NOT_FOUND";
        throw error;
      }
      const names = pack === "legacy" ? [...definitions.keys()].filter((name) => name.startsWith("legacy.")) : packDefinition.capabilities;
      return {
        pack,
        version: "1",
        description: packDefinition.description,
        capabilities: names.map((name) => {
          const item = definitions.get(name);
          return item ? {
            name,
            version: item.version,
            description: item.description,
            required: item.required,
            safety: item.safety,
            example: item.example,
            ...(item.manifest ? item.manifest : {}),
          } : null;
        }).filter(Boolean),
      };
    },
    validate(name, input) {
      const definition = definitions.get(name);
      if (!definition) {
        const error = new Error(`Unknown browser capability: ${name}`);
        error.code = "CAPABILITY_NOT_FOUND";
        throw error;
      }
      return definition.inputSchema.parse(input ?? {});
    },
  };
}

export function capabilityPacks() {
  return Object.fromEntries(Object.entries(PACKS).map(([name, value]) => [name, { name, ...value, version: "1" }]));
}
