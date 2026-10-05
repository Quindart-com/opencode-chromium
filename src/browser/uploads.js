import fs from "node:fs";
import path from "node:path";

function validateUploadFiles(files, filePolicy = null) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("browser_set_file_input requires at least one file");
  for (const file of files) {
    if (filePolicy) {
      filePolicy.assertAllowed(file);
      continue;
    }
    if (typeof file !== "string" || file.length === 0) throw new Error("File paths must be non-empty strings");
    if (!path.isAbsolute(file)) throw new Error(`File path must be absolute: ${file}`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new Error(`File does not exist: ${file}`);
    }
    if (!stat.isFile()) throw new Error(`Path is not a file: ${file}`);
  }
}

function attributesMap(attributes = []) {
  const map = new Map();
  for (let index = 0; index < attributes.length; index += 2) {
    map.set(String(attributes[index]).toLowerCase(), attributes[index + 1] ?? "");
  }
  return map;
}

function fileUploadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Upload refused|File changed|Upload destination changed|Upload approval expired/.test(message)) {
    return Object.assign(new Error(message), { code: "UPLOAD_NOT_AUTHORIZED", uncertain: false, retryable: false });
  }
  if (message === "Not allowed" || /not allowed/i.test(message)) {
    return new Error('File upload was blocked by Chrome. In chrome://extensions, open Details for the agent-browser extension and enable "Allow access to file URLs."');
  }
  return error;
}

export function fileInputExpression(nodeId, selector = "input[type=file]") {
  return `(() => {
    const nodeByIdStrict = id => {
      const node = window.__agentBrowserDomNodeMap?.get(id);
      if (!node) throw new Error('Unknown DOM node id. Take a fresh snapshot first.');
      if (!node.isConnected) throw new Error('DOM node is detached. Take a fresh snapshot first.');
      return node;
    };
    const target = ${nodeId ? `nodeByIdStrict(${JSON.stringify(nodeId)})` : "document"};
    if (target.matches?.('input[type=file]')) return target;
    if (target.control?.matches?.('input[type=file]')) return target.control;
    const inputs = target.querySelectorAll(${JSON.stringify(selector)});
    if (inputs.length !== 1) throw new Error('Upload target must identify exactly one file input; found ' + inputs.length);
    return inputs[0];
  })()`;
}

export function createFileInputOperation({ tool, cdp, enableCdpDomains, stringify }) {
  return tool({
    description: "Set files on a specific file input by page node ID or CSS selector using CDP.",
    args: {
      tabId: tool.schema.number().int().positive(),
      nodeId: tool.schema.string().optional(),
      selector: tool.schema.string().optional(),
      files: tool.schema.array(tool.schema.string()).describe("Absolute file paths to attach"),
    },
    async execute(args, context) {
      validateUploadFiles(args.files, context?.filePolicy);
      await enableCdpDomains(context, args.tabId, ["DOM"], { optional: true });
      const result = await cdp(context, args.tabId, "Runtime.evaluate", {
        expression: fileInputExpression(args.nodeId, args.selector), returnByValue: false,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      const objectId = result.result?.objectId;
      if (!objectId) throw new Error("No file input resolved from upload target");
      try {
        const description = await cdp(context, args.tabId, "DOM.describeNode", { objectId, depth: 0 });
        const attributes = attributesMap(description.node?.attributes);
        if (description.node?.localName !== "input" || String(attributes.get("type") ?? "").toLowerCase() !== "file") {
          throw new Error(`Selector does not match an input[type=file]: ${args.selector}`);
        }
        if (args.files.length > 1 && !attributes.has("multiple")) {
          throw new Error(`File input does not accept multiple files: ${args.selector}`);
        }
        try {
          await cdp(context, args.tabId, "DOM.setFileInputFiles", { objectId, files: args.files }, 120000);
        } catch (error) {
          throw fileUploadError(error);
        }
        return stringify({ set: true, tabId: args.tabId, files: args.files.length });
      } finally {
        await cdp(context, args.tabId, "Runtime.releaseObject", { objectId }).catch(() => {});
      }
    },
  });
}
