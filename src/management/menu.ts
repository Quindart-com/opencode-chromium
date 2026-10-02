import readline from "node:readline";
import type { Harness } from "./harnesses.js";

/** The menu owns terminal raw mode only while selection is pending. */
export async function selectHarnesses(rows: Harness[]): Promise<string[]> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Noninteractive setup requires --targets codex,opencode,claude-code,claude-desktop,dsh");
  const selected = new Set(rows.filter(row => row.managed && row.supported).map(row => row.id));
  let current = 0;
  let rendered = false;
  const render = () => {
    if (rendered) process.stdout.write(`\x1b[${rows.length + 1}A`);
    process.stdout.write("\x1b[2KArrow keys: move · Space: select · Enter: apply · Esc: cancel\n");
    for (const [index, row] of rows.entries()) process.stdout.write(`\x1b[2K${index === current ? ">" : " "} [${selected.has(row.id) ? "x" : " "}] ${row.label} ${row.version ?? "version unknown"} · ${row.supported ? row.detected ? row.managed ? "managed" : "detected" : "not detected" : "unsupported"}\n`);
    rendered = true;
  };
  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  render();
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const onKey = (_text: string, key: readline.Key) => {
        if (key.name === "return" || key.name === "escape" || key.ctrl && key.name === "c") {
          process.stdin.off("keypress", onKey);
          if (key.name === "return") resolve([...selected]); else reject(new Error("Setup cancelled; no configuration changed"));
          return;
        }
        if (key.name === "up") current = (current + rows.length - 1) % rows.length;
        if (key.name === "down") current = (current + 1) % rows.length;
        const row = rows[current];
        if (key.name === "space" && row?.supported) {
          if (selected.has(row.id)) selected.delete(row.id); else selected.add(row.id);
        }
        render();
      };
      process.stdin.on("keypress", onKey);
    });
  } finally { process.stdin.setRawMode(wasRaw); process.stdin.pause(); }
}
