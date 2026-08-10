#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, ["run", "build"], { cwd: root, stdio: "inherit" });
const output = execFileSync(process.execPath, ["pm", "pack", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
process.stdout.write(output);
