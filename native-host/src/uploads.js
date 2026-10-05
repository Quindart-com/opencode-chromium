import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const MAX_FILE_BYTES = 256 * 1024 * 1024;
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function checkedPath(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\\/]\.\.([\\/]|$)/.test(file)) throw new Error("Upload requires an absolute file path without parent traversal");
  const real = fs.realpathSync(file);
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Upload must be a regular file of at most 256 MiB");
  const roots = (process.env.AGENT_BROWSER_ALLOWED_FILE_ROOTS ?? "").split(/[,;]/).filter(Boolean).map(root => fs.realpathSync(root.trim()));
  if (roots.length && !roots.some(root => { const relative = path.relative(root, real); return !relative.startsWith("..") && !path.isAbsolute(relative); })) throw new Error("Upload is outside allowed file roots");
  return { real, stat };
}
function preview(file, size) {
  if (size > 256 * 1024) return undefined;
  const bytes = fs.readFileSync(file);
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" :
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg" :
    bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "image/webp" : undefined;
  return mime ? { data: `data:${mime};base64,${bytes.toString("base64")}`, digest: createHash("sha256").update(bytes).digest("hex") } : undefined;
}

/** Only the extension's native messaging connection may invoke these methods. */
export function createUploadFiles({ snapshotLifetimeMs = 24 * 60 * 60 * 1000 } = {}) {
  const requests = new Map();
  const release = token => {
    const request = requests.get(token);
    if (!request) return;
    requests.delete(token);
    clearTimeout(request.timer);
    if (request.directory) fs.rmSync(request.directory, { recursive: true, force: true });
  };
  process.once("exit", () => { for (const token of requests.keys()) release(token); });
  return async (method, params = {}) => {
    if (method === "uploads.describe") {
      if (!Array.isArray(params.files) || !params.files.length || params.files.length > 20) throw new Error("Select 1–20 upload files");
      const files = [];
      let total = 0;
      let previewBudget = 256 * 1024;
      for (const file of params.files) {
        const { real, stat } = checkedPath(file);
        total += stat.size;
        if (total > 512 * 1024 * 1024) throw new Error("Upload batch exceeds 512 MiB");
        const hash = await digest(real);
        const image = stat.size <= previewBudget ? preview(real, stat.size) : undefined;
        if (image && image.digest !== hash) throw new Error("File changed while preparing upload preview");
        if (image) previewBudget -= stat.size;
        files.push({ path: real, name: path.basename(real), size: stat.size, digest: hash, preview: image?.data });
      }
      const token = randomUUID();
      const timer = setTimeout(() => release(token), 120000); timer.unref?.();
      requests.set(token, { files, timer });
      return { token, files: files.map(({ digest, ...file }) => file) };
    }
    if (method === "uploads.snapshot") {
      const request = requests.get(params.token);
      if (!request || request.directory) throw new Error("Upload approval expired or was already used");
      request.directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-upload-"));
      clearTimeout(request.timer);
      request.timer = setTimeout(() => release(params.token), snapshotLifetimeMs); request.timer.unref?.();
      fs.chmodSync(request.directory, 0o700);
      try {
        const files = [];
        for (const [index, file] of request.files.entries()) {
          const { real } = checkedPath(file.path);
          const directory = path.join(request.directory, String(index)); fs.mkdirSync(directory, { mode: 0o700 });
          const target = path.join(directory, file.name);
          fs.copyFileSync(real, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
          if (await digest(target) !== file.digest) throw new Error("File changed while waiting for approval. Request a new upload.");
          files.push(target);
        }
        return { files };
      } catch (error) { release(params.token); throw error; }
    }
    if (method === "uploads.release") { release(params.token); return { released: true }; }
    return undefined;
  };
}
