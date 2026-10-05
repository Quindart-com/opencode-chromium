import { isMap, isSeq, isScalar, parseDocument, type Document, type YAMLSeq } from "yaml";

export function deepSeekManaged(before: string): boolean {
  const doc = parseDocument(before, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] });
  if (doc.errors.length || !isSeq(doc.contents)) return false;
  const rows = doc.contents.items.flatMap(row => {
    const insert = isMap(row) ? row.get("insert") : null;
    return isSeq(insert) ? insert.items : [row];
  });
  return rows.some(row => isMap(row) && ["mcp-browser", "mcp-opencode-browser-plugin"].includes(String(row.get("id"))) && String(row.get("disabled")) !== "true");
}

/** Edit a Cordis patch without evaluating !!js expressions or rewriting other rows. */
export function planDeepSeek(before: string, serverPath: string, interpreter: string, remove = false): string {
  const doc = parseDocument(before.trim() ? before : "[]\n", {
    customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }],
    uniqueKeys: true,
  }) as Document;
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error("Invalid DeepSeek Harness YAML patch; no files changed");
  const rows = doc.contents.items;
  const candidates = rows.flatMap((row, index) => {
    const insert = isMap(row) ? row.get("insert") : null;
    return isSeq(insert) ? insert.items.map((item, nestedIndex) => ({ row: item, index, parent: insert, nestedIndex })) :
      [{ row, index, parent: null as YAMLSeq | null, nestedIndex: 0 }];
  });
  const owned = candidates.filter(({ row }) =>
    isMap(row) && ["mcp-browser", "mcp-opencode-browser-plugin"].includes(String(row.get("id"))));
  if (owned.length > 1) throw new Error("Duplicate DeepSeek browser rows require manual migration; no files changed");
  const entry = owned[0];
  if (remove) {
    if (!entry) return before;
    if (entry.parent) {
      entry.parent.items.splice(entry.nestedIndex, 1);
      if (!entry.parent.items.length) rows.splice(entry.index, 1);
    } else {
      // This row overrides a bundle-owned client; deleting it would reactivate the bundle's config.
      if (!isMap(entry.row)) throw new Error("Invalid DeepSeek browser row");
      if (entry.row.get("disabled") === true) return before;
      entry.row.set("disabled", true);
    }
  } else if (entry && isMap(entry.row)) {
    const row = entry.row;
    const config = row.get("config");
    if (!isMap(config)) throw new Error("DeepSeek browser config must be a mapping; no files changed");
    const args = config.get("args");
    if (config.get("transport") === "stdio" && config.get("command") === interpreter &&
        isSeq(args) && args.items.length === 1 && String(args.items[0]) === serverPath && row.get("disabled") !== true) return before;
    row.set("disabled", false);
    config.set("transport", "stdio");
    config.set("command", interpreter);
    if (isSeq(args) && args.items.length === 1 && isScalar(args.items[0])) args.items[0].value = serverPath;
    else config.set("args", doc.createNode([serverPath]));
    config.delete("url");
    if (!config.has("toolCallTimeoutMs")) config.set("toolCallTimeoutMs", 120000);
  } else {
    doc.contents.add({ insert: [{ id: "mcp-opencode-browser-plugin", name: "@deepseek-ai/dsh-mcp-client",
      config: { serverName: "opencode-browser-plugin", transport: "stdio", command: interpreter,
        args: [serverPath], toolCallTimeoutMs: 120000 } }] });
  }
  return doc.toString();
}
