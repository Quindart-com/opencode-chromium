// This module is copied alongside the managed broker. Keep it Node-only.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
export function controlToken(dir: string) {
  const file = path.join(dir, "control-token");
  const read = () => {
    const token = fs.readFileSync(file, "utf8").trim();
    if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid controller credential");
    return token;
  };
  try { return read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const token = randomBytes(32).toString("hex");
  try { fs.writeFileSync(file, token, { flag: "wx",mode: 0o600 }); return token; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return read(); throw error; }
}
