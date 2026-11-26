// Offline admission benchmark. Observe the real pilot's outbound request at the HTTPS boundary.
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { disposableDirectory } from "../browser/browser.mjs";

const output = process.argv[2];
if (!output || fs.existsSync(output))
  throw Error("Supply a new output filename");
const tmp = disposableDirectory();
process.env.OPENCODE_BROWSER_RUNTIME_DIR = tmp.env.OPENCODE_BROWSER_RUNTIME_DIR;
process.env.OPENCODE_BROWSER_SITE_REGISTRY_ORIGIN = "https://fixture-registry.convex.site";
const original = https.request;
let sent;
https.request = () => {
  const req = new EventEmitter();
  req.end = (body) => {
    sent = JSON.parse(body);
    req.emit("error", new Error("CAPTURED_LOCALLY"));
  };
  return req;
};
syncBuiltinESMExports();
try {
  const { createSiteOperations } =
    await import("../../dist/browser/site-operations.js");
  const { configureSite } = await import("../../dist/site-registry/client.js");
  const origin = "https://news.ycombinator.com/item?id=";
  const defaultUrl = origin + "1";
  const rows = [
    { task: "headline", words: "title" },
    { task: "title of story 1", words: "title" },
    { task: "who wrote this story and what is their karma", words: "by karma" },
    { task: "how many comments", words: "descendants" },
    { task: "title of story 8863" },
    { task: "change the title" },
    { task: "headline and my password" },
    { task: "headline", url: "https://example.org/item?id=1" },
    { task: "headline", url: origin + "1&id=8863" },
    { task: "headline", consent: false },
    { task: "title of the latest story" },
    { task: "latest score of this story", words: "score" },
  ];
  const expectedDeclines = {
    4: "requested resource differs",
    5: "write",
    6: "unsupported field",
    7: "unsupported origin",
    8: "ambiguous resource",
    9: "consent off",
    10: "unbound relative story",
  };
  for (const [i, row] of rows.entries()) {
    const url = row.url ?? defaultUrl;
    sent = null;
    configureSite("routing-baseline", row.consent !== false);
    const op = createSiteOperations(async () => ({
      profile: "routing-baseline",
      url,
    })).browser_site_read;
    try {
      await op.execute(
        { tabId: 1, task: row.task },
        { sessionId: "benchmark" },
      );
    } catch (e) {
      row.outcome = e.message;
    }
    row.observedRequest = sent;
    row.expected = row.words
      ? { item: 1, words: row.words }
      : expectedDeclines[i];
    row.correct = row.words
      ? sent?.item === 1 && sent?.words === row.words
      : !sent &&
        /SITE_(REGISTRY_DISABLED|TASK_UNSUPPORTED|UNSUPPORTED_RESOURCE|RESOURCE_MISMATCH)/.test(
          row.outcome ?? "",
        );
  }
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(
    output,
    JSON.stringify(
      {
        scope:
          "Production site read admission; HTTPS intercepted before transport, no remote calls",
        rows,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    rows.filter((r) => r.correct).length +
      "/" +
      rows.length +
      " admission decisions matched",
  );
} finally {
  https.request = original;
  syncBuiltinESMExports();
  tmp.remove();
}
