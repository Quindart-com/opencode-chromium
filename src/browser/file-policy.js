import fs from "node:fs";
import path from "node:path";

function blocked(message) {
  const error = new Error(message);
  error.code = "FILE_POLICY_BLOCKED";
  error.retryable = false;
  error.uncertain = false;
  return error;
}

export function createFilePolicy(config = {}) {
  const allowedFileRoots = (config.allowedFileRoots ?? [])
    .map(String)
    .filter((value) => value.length > 0)
    .map((root) => path.resolve(root));
  return {
    allowedFileRoots,
    assertAllowed(filePath) {
      if (typeof filePath !== "string" || filePath.length === 0) throw blocked("File paths must be non-empty strings");
      if (!path.isAbsolute(filePath)) throw blocked(`File path must be absolute: ${filePath}`);
      if (/[\\/]\.\.([\\/]|$)/.test(filePath)) throw blocked(`File path must not contain parent traversal: ${filePath}`);

      let real;
      try {
        real = fs.realpathSync(filePath);
      } catch (error) {
        if (error?.code === "ENOENT") throw blocked(`File does not exist: ${filePath}`);
        throw blocked(`File is not readable: ${filePath}`);
      }
      let stat;
      try {
        stat = fs.statSync(real);
      } catch {
        throw blocked(`File is not readable: ${filePath}`);
      }
      if (!stat.isFile()) throw blocked(`Path is not a file: ${filePath}`);

      if (allowedFileRoots.length > 0) {
        const insideRoot = allowedFileRoots.some((root) => {
          const relative = path.relative(root, real);
          return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
        });
        if (!insideRoot) throw blocked(`File is outside the allowed roots: ${filePath}`);
      }
      return { filePath: real, allowedFileRoots };
    },
  };
}

export function filePolicyFromEnv(env = process.env) {
  const split = (value) => (value ?? "").split(/[,;]/).map((item) => item.trim()).filter(Boolean);
  return createFilePolicy({ allowedFileRoots: split(env.AGENT_BROWSER_ALLOWED_FILE_ROOTS) });
}