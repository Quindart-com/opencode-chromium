import process from "node:process";
import {
  DEFAULT_QUERY_EVENTS,
  HistoryStore,
  MAX_QUERY_EVENTS,
  historyRootDir,
  withHistoryLock,
} from "../history/index.js";

function parseLimit(value) {
  if (value === undefined) return DEFAULT_QUERY_EVENTS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_QUERY_EVENTS) {
    throw new Error(`Limit must be an integer between 1 and ${MAX_QUERY_EVENTS}.`);
  }
  return parsed;
}

function parseSequence(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Sequence must be a positive integer.");
  return parsed;
}

function commandUsage(command) {
  return {
    enable: "opencode-chromium history enable [--json]",
    disable: "opencode-chromium history disable [--json]",
    pause: "opencode-chromium history pause [--json]",
    resume: "opencode-chromium history resume [--json]",
    status: "opencode-chromium history status [--json]",
    list: "opencode-chromium history list [limit] [--json]",
    show: "opencode-chromium history show <sequence> [--json]",
    delete: "opencode-chromium history delete --yes [--json]",
  }[command];
}

export async function runHistoryCommand(argv) {
  const [subcommand = "status", ...rest] = argv;
  const json = rest.includes("--json");
  const root = historyRootDir();
  const store = new HistoryStore({ root });
  let result;

  switch (subcommand) {
    case "enable": {
      result = await withHistoryLock(root, () => store.enable());
      break;
    }
    case "disable": {
      result = await withHistoryLock(root, () => store.disable());
      break;
    }
    case "pause": {
      result = await withHistoryLock(root, () => store.pause());
      break;
    }
    case "resume": {
      result = await withHistoryLock(root, () => store.resume());
      break;
    }
    case "status": {
      result = store.status();
      break;
    }
    case "list": {
      const limitValue = rest.find((arg) => !arg.startsWith("--"));
      result = store.list({ limit: parseLimit(limitValue) });
      break;
    }
    case "show": {
      const sequence = rest.find((arg) => !arg.startsWith("--"));
      if (!sequence) throw new Error("history show requires a sequence number.\nUsage: " + commandUsage("show"));
      result = store.show(parseSequence(sequence));
      break;
    }
    case "delete": {
      if (!rest.includes("--yes")) {
        throw new Error("history delete requires --yes. This destroys the encrypted store and its local key.\nUsage: " + commandUsage("delete"));
      }
      result = await withHistoryLock(root, () => store.hardDelete());
      break;
    }
    default: {
      throw new Error(`Unknown history subcommand: ${subcommand}\nUsage: opencode-chromium history <enable|disable|pause|resume|status|list|show|delete>`);
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const body = await humanSummary(subcommand, result);
    const notice = subcommand === "enable"
      ? "Experimental Computer History: records only bounded metadata (capability, hostname, outcome).\nNever stores typed text, screenshots, URLs and paths, arguments, or results.\nEncrypted locally; key at the store root; delete with `opencode-chromium history delete --yes`.\n\n"
      : "";
    process.stdout.write(`${notice}${body}`);
  }
}

async function humanSummary(subcommand, result) {
  if (subcommand === "status") {
    const status = result;
    return [
      `history: ${status.health}`,
      `  enabled: ${status.enabled}`,
      `  paused: ${status.paused}`,
      `  encrypted: ${status.encrypted}`,
      `  profile: ${status.profile}`,
      `  retention: ${status.retention_days} days`,
      `  storage: ${bytes(status.bytes_used)} / ${bytes(status.quota_bytes)}`,
      `  dropped events: ${status.dropped_events}`,
      `  store: \`${historyRootDir()}\``,
      "",
    ].join("\n");
  }
  if (subcommand === "list") {
    const lines = result.events.map((event) => `#${event.data.sequence} ${event.type} ${event.time}${event.data.application?.hostname ? ` › ${event.data.application.hostname}` : ""}`).join("\n");
    return `${lines || "no events in the retention window"}\n`;
  }
  if (subcommand === "show") {
    if (!result.event) return "no event with that sequence\n";
    return `${JSON.stringify(result.event, null, 2)}\n`;
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

function bytes(value) {
  const units = ["B", "KiB", "MiB"];
  let amount = Number(value) || 0;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export default runHistoryCommand;