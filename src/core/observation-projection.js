import { safeNetworkUrl } from '../browser/network.js';
const PREVIEW_KEY_PRIORITY = ["ok","status","sessionId","profileId","tabId","url","title","query","scope","totalCandidates","totalUnits","totalNodes","totalEvents","returned","truncated","mode","result","results","elements","nodes","events","console","network","node_id","axNodeId","kind","role","name","label","value","text","method","type","statusCode","requestId","timestamp","error","summary","settle","observation","target","contextRoot","ancestors","siblings","nearbyInteractives","children","requested","screenshotClip"];
export function clippedText(value, limit) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function projectValue(value, options, depth = 0) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return clippedText(value, options.stringLimit);
  if (depth >= options.depthLimit) {
    if (Array.isArray(value)) return `[${value.length} items omitted]`;
    return "[nested value omitted]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, options.arrayLimit).map((item) => projectValue(item, options, depth + 1));
  }
  if (typeof value !== "object") return String(value);
  const keys = Object.keys(value);
  const ordered = [
    ...PREVIEW_KEY_PRIORITY.filter((key) => Object.hasOwn(value, key)),
    ...keys.filter((key) => !PREVIEW_KEY_PRIORITY.includes(key)).sort(),
  ].slice(0, options.objectLimit);
  return Object.fromEntries(ordered.map((key) => {
    const child = value[key];
    if (["base64", "data", "body", "postData"].includes(key) && typeof child === "string" && child.length > options.stringLimit) {
      return [key, `[${child.length} characters omitted]`];
    }
    return [key, projectValue(child, options, depth + 1)];
  }));
}

export function fitInlinePreview(payload, maxChars) {
  const configurations = [
    { arrayLimit: 20, objectLimit: 30, stringLimit: 500, depthLimit: 7 },
    { arrayLimit: 10, objectLimit: 24, stringLimit: 280, depthLimit: 6 },
    { arrayLimit: 5, objectLimit: 18, stringLimit: 180, depthLimit: 5 },
    { arrayLimit: 2, objectLimit: 14, stringLimit: 120, depthLimit: 4 },
  ];
  for (const options of configurations) {
    const projected = projectValue(payload, options);
    if (JSON.stringify(projected).length <= maxChars) return projected;
  }
  const result = projectValue(payload.result, { arrayLimit: 1, objectLimit: 10, stringLimit: 100, depthLimit: 3 });
  return {
    ok: payload.ok,
    status: payload.status,
    sessionId: payload.sessionId,
    ...(payload.profileId ? { profileId: payload.profileId } : {}),
    ...(payload.tabId ? { tabId: payload.tabId } : {}),
    result,
  };
}

export function axValue(field) {
  return field && typeof field === "object" && "value" in field ? field.value : field ?? null;
}

export function summarizeAccessibilitySnapshot(snapshot, limit = 40) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const usefulRoles = new Set([
    "RootWebArea", "WebArea", "heading", "link", "button", "textbox", "searchbox", "combobox",
    "checkbox", "radio", "switch", "tab", "menuitem", "dialog", "alert", "status", "listbox", "option",
  ]);
  const useful = nodes.filter((node) => {
    if (node?.ignored === true) return false;
    const role = String(axValue(node?.role) ?? "");
    return usefulRoles.has(role) || Boolean(axValue(node?.name)) || Boolean(axValue(node?.value));
  });
  const selected = useful.slice(0, limit).map((node) => ({
    axNodeId: node.nodeId ?? null,
    backendDOMNodeId: node.backendDOMNodeId ?? null,
    role: axValue(node.role),
    name: clippedText(axValue(node.name), 180) || null,
    value: clippedText(axValue(node.value), 180) || null,
    description: clippedText(axValue(node.description), 180) || null,
  }));
  return { totalNodes: nodes.length, usefulNodes: useful.length, returned: selected.length, truncated: useful.length > selected.length, nodes: selected };
}

export function summarizeNetworkEvents(response, limit = 30) {
  const events = Array.isArray(response?.events) ? response.events : [];
  const meaningful = events.map((event) => {
    const params = event?.params ?? {};
    const request = params.request ?? {};
    const responseValue = params.response ?? {};
    return {
      method: event.method ?? null,
      timestamp: event.time ?? params.timestamp ?? null,
      requestId: params.requestId ?? null,
      type: params.type ?? null,
      url: clippedText(safeNetworkUrl(responseValue.url ?? request.url ?? params.documentURL), 300) || null,
      httpMethod: request.method ?? null,
      statusCode: responseValue.status ?? null,
      mimeType: responseValue.mimeType ?? null,
      error: clippedText(params.errorText ?? params.blockedReason, 240) || null,
    };
  });
  const selected = meaningful.slice(-limit);
  return { totalEvents: events.length, returned: selected.length, truncated: events.length > selected.length, events: selected };
}
