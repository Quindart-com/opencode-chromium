import { EmbedQueue, MemoryStore, memoryRootDir, embeddingEnabled } from "../memory/index.js";
import { embedMemoryTexts } from "../../native-host/src/semantic-search.js";

function openCliStore() {
  const root = memoryRootDir();
  let queue = null;
  if (embeddingEnabled()) {
    queue = new EmbedQueue({
      embed: async (texts) => embedMemoryTexts(texts),
      onResults: (rows, model, dims, embeddingProfile) => {
        store?.applyEmbeddings(rows, model, dims, embeddingProfile);
      },
    });
    queue.setQueryEmbedder(async (query) => {
      const result = await embedMemoryTexts([query]);
      return { vector: result?.vectors?.[0] ?? null, model: result?.model ?? null, dims: result?.dims ?? null, embeddingProfile: result?.embeddingProfile ?? null };
    });
  }
  let store = new MemoryStore({ root, embedQueue: queue });
  if (queue) queue.onResults = (rows, model, dims, embeddingProfile) => store.applyEmbeddings(rows, model, dims, embeddingProfile);
  return store;
}

function parseLimit(value, fallback = 50) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) throw new Error("Limit must be an integer between 1 and 200.");
  return parsed;
}

function parseK(value) {
  if (value === undefined) return 8;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) throw new Error("k must be an integer between 1 and 20.");
  return parsed;
}

function parseDays(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) throw new Error("Purge days must be an integer between 1 and 365.");
  return parsed;
}

const USAGE = {
  enable: "opencode-chromium memory enable [--json]",
  disable: "opencode-chromium memory disable [--json]",
  pause: "opencode-chromium memory pause [--json]",
  resume: "opencode-chromium memory resume [--json]",
  status: "opencode-chromium memory status [--json]",
  list: "opencode-chromium memory list [limit] [--json]",
  show: "opencode-chromium memory show <fingerprint|id> [--json]",
  search: "opencode-chromium memory search \"<query>\" [--k 8] [--kind all|action|chain] [--hostname domain] [--json]",
  chains: "opencode-chromium memory chains [list|show <id|fingerprint>] [--json]",
  prune: "opencode-chromium memory prune [--days N] [--json]",
  reindex: "opencode-chromium memory reindex [--json]",
  config: "opencode-chromium memory config <get|set> <key> [value] [--json]",
  stats: "opencode-chromium memory stats [--json]",
  delete: "opencode-chromium memory delete --yes [--json]",
};

function commandUsage(command) {
  return USAGE[command] ?? "opencode-chromium memory <command> [options]";
}

export async function runMemoryCommand(argv) {
  const [subcommand = "status", ...rest] = argv;
  const json = rest.includes("--json");
  const store = openCliStore();
  let result;

  try {
    switch (subcommand) {
      case "enable": {
        result = store.enable();
        break;
      }
      case "disable": {
        result = store.disable();
        break;
      }
      case "pause": {
        result = store.pause();
        break;
      }
      case "resume": {
        result = store.resume();
        break;
      }
      case "status": {
        result = store.status();
        break;
      }
      case "list": {
        result = store.list({ limit: parseLimit(rest.find((value) => /^\d+$/.test(value))) });
        break;
      }
      case "show": {
        const target = rest.find((value) => !value.startsWith("--"));
        if (!target) throw new Error("memory show requires a fingerprint or id.");
        const numeric = Number(target);
        result = Number.isInteger(numeric) && numeric > 0 ? store.showSignature(numeric) : store.showSignature(target);
        break;
      }
      case "search": {
        const query = rest.find((value) => !value.startsWith("--"));
        if (!query) throw new Error("memory search requires a query string.");
        const kIndex = rest.indexOf("--k");
        const kindIndex = rest.indexOf("--kind");
        const hostIndex = rest.indexOf("--hostname");
        result = await store.search({
          query,
          limit: kIndex !== -1 ? parseK(rest[kIndex + 1]) : 8,
          kind: kindIndex !== -1 && ["all", "action", "chain"].includes(rest[kindIndex + 1]) ? rest[kindIndex + 1] : "all",
          hostname: hostIndex !== -1 ? rest[hostIndex + 1] : null,
        });
        break;
      }
      case "chains": {
        const target = rest.find((value) => !value.startsWith("--"));
        if (target && target !== "list") {
          const numeric = Number(target);
          result = Number.isInteger(numeric) && numeric > 0 ? store.chainShow(numeric) : store.chainShow(target);
        } else {
          result = store.chainsList({ limit: parseLimit(rest.find((value) => /^\d+$/.test(value)), 20) });
        }
        break;
      }
      case "prune": {
        const daysIndex = rest.indexOf("--days");
        result = store.prune({ days: daysIndex !== -1 ? Number(rest[daysIndex + 1]) : undefined });
        break;
      }
      case "reindex": {
        result = await store.reindex({ embed: async (texts) => embedMemoryTexts(texts) });
        break;
      }
      case "config": {
        const action = rest[0];
        if (action === "get") {
          const key = rest[1];
          const status = store.status();
          const keys = {
            quota_bytes: status.quota_bytes,
            purge_days: status.purge_days,
            power_user: status.power_user,
            model_id: status.model_id,
            dims: status.dims,
            enabled: status.enabled,
            paused: status.paused,
          };
          if (key) {
            if (!(key in keys)) throw new Error(`Unknown config key: ${key}`);
            result = { key, value: keys[key] };
          } else {
            result = { config: keys };
          }
        } else if (action === "set") {
          const key = String(rest[1] ?? "").replace(/-/g, "_");
          const value = rest[2];
          if (!key || value === undefined) throw new Error("memory config set requires a key and value.");
          const parsed = key === "power_user" ? value === "true" || value === "1" : Number(value);
          result = store.configure({
            quota_bytes: key === "quota_bytes" ? parsed : undefined,
            purge_days: key === "purge_days" ? parsed : undefined,
            power_user: key === "power_user" ? parsed : undefined,
          });
        } else {
          throw new Error("memory config requires 'get' or 'set'.");
        }
        break;
      }
      case "delete": {
        if (!rest.includes("--yes")) throw new Error("memory delete requires --yes to confirm.");
        result = await store.hardDelete();
        break;
      }
      case "help": {
        console.log(commandUsage(subcommand));
        return;
      }
      default: {
        throw new Error(`Unknown memory command: ${subcommand}`);
      }
    }
  } finally {
    try {
      store.close();
    } catch {
      // already closed (hardDelete closes internally)
    }
  }

  console.log(json || subcommand === "delete" ? JSON.stringify(result, null, 2) : prettyStatus(result, subcommand));
}

function prettyStatus(result, subcommand) {
  if (subcommand === "status" && result?.counts) {
    const rate = result.counts.confirmed_total + result.counts.failed_total > 0
      ? Math.round((result.counts.confirmed_total / (result.counts.confirmed_total + result.counts.failed_total)) * 100)
      : 100;
    return [
      `enabled:      ${result.enabled}`,
      `paused:       ${result.paused}`,
      `health:       ${result.health}`,
      `profile:      ${result.profile}`,
      `model:        ${result.model_id ?? "not loaded"} (${result.dims ?? "?"} dims)`,
      `signatures:   ${result.counts.signatures}`,
      `chains:       ${result.counts.chains}`,
      `negatives:    ${result.counts.failure_contexts}`,
      `success rate: ${rate}% (${result.counts.confirmed_total} confirmed / ${result.counts.failed_total} failed)`,
      `memory hits:  ${result.memory_hits}`,
      `quota:        ${formatBytes(Number(result.quota_bytes))} (${formatBytes(result.bytes_used)} used)${result.over_quota ? " OVER" : ""}`,
      `purge:        every ${result.purge_days} days${result.power_user ? " (power user)" : ""}`,
      `last prune:   ${result.last_prune_at ?? "never"}`,
    ].join("\n");
  }
  return JSON.stringify(result, null, 2);
}

function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export { commandUsage as memoryHelp };
