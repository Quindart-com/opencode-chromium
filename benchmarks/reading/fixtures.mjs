import { createHash } from "node:crypto";
import { createServer } from "node:http";

export async function readFixtures(seed) {
  const num = (name, index = 0) =>
    10000 +
    (createHash("sha256")
      .update(JSON.stringify([seed, name, index]))
      .digest()
      .readUInt32BE() %
      90000);
  const page = (title, content) =>
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><style>body{font:20px system-ui;margin:32px;line-height:1.6}td,th{padding:4px 15px;text-align:left}canvas{display:block}</style><main><h1>${title}</h1>${content}</main></html>`;
  const amount = (key) => String(num(key));
  const item = "INV-" + num("invoice"),
    other = "INV-" + num("other");
  const board = (index) =>
    page(
      "Operations board",
      `<p>Team North · Available units: ${num("north", index)}</p><p>Team South · Available units: ${num("south", index)}</p>`,
    );
  const tasks = [],
    pages = new Map();
  function add(id, prompt, expected, html, evidence = "page") {
    const url = "/case/" + id;
    tasks.push({ id, prompt, url, expected, evidence });
    pages.set(url, html);
  }
  add(
    "article",
    "Give the current edition's release code exactly.",
    amount("release"),
    page(
      "Release notes",
      `<p>Previous edition · Release code ${num("old")}</p><p>Current edition · Release code ${num("release")}</p>`,
    ),
  );
  add(
    "table",
    `What is the balance for invoice ${item}? Return the integer.`,
    amount("balance"),
    page(
      "Invoice directory",
      "<table><tr><th>Invoice</th><th>Balance</th></tr>" +
        Array.from(
          { length: 120 },
          (_, i) =>
            `<tr><td>${i === 96 ? item : "REF-" + (1000 + i)}</td><td>${i === 96 ? num("balance") : num("row", i)}</td></tr>`,
        ).join("") +
        "</table>",
    ),
  );
  add(
    "personal",
    "How many units does the selected workspace have? Return the integer.",
    amount("private"),
    page(
      "Workspace",
      `<p>Public directory · Available units: ${num("dir")}</p><p>Selected workspace: Harbor</p><p>Harbor · Available units: ${num("private")}</p><p>Last workspace, Grove · Available units: ${num("other-private")}</p>`,
    ),
  );
  const snapshot = page(
    "Transit status",
    `<p>Displayed arrival board · Last saved at 09:00 · Seats available: ${num("saved")}</p><a href="/published/seats">Open live public timetable</a>`,
  );
  pages.set(
    "/published/seats",
    page("Live public timetable", `<p>Seats available: ${num("live")}</p>`),
  );
  add(
    "displayed",
    "How many seats does this displayed board show? Return the integer.",
    amount("saved"),
    snapshot,
  );
  add(
    "published",
    "Get the latest available seat count from the live public timetable. Return the integer.",
    amount("live"),
    snapshot,
    "published",
  );
  add(
    "other-resource",
    `Using only this displayed record, give the balance for ${other}. If a different record is open, answer resource-mismatch.`,
    "resource-mismatch",
    page(
      "Invoice record",
      `<p>Invoice: ${item} · Balance: ${num("balance")}</p>`,
    ),
  );
  add(
    "repeat-a",
    "What is Team South's available unit count? Return the integer.",
    String(num("south", 1)),
    board(1),
  );
  add(
    "repeat-b",
    "Read Team South's available units from this updated board. Return the integer.",
    String(num("south", 2)),
    board(2),
  );
  add(
    "canvas",
    "Read the numeric dispatch code painted on the current board.",
    amount("canvas"),
    page(
      "Dispatch board",
      `<canvas width="520" height="130" aria-label="Painted dispatch board"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="white";c.fillRect(0,0,520,130);c.fillStyle="black";c.font="bold 44px sans-serif";c.fillText("Dispatch: ${num("canvas")}",16,82)</script>`,
    ),
    "image",
  );
  add(
    "denied",
    "Read the invoice balance if this page allows it. If it denies access, answer access-denied and stop.",
    "access-denied",
    page(
      "Access denied",
      "<p>Your workspace has no access to this invoice.</p>",
    ),
  );
  const server = createServer((req, res) => {
    const html = pages.get(req.url);
    res.writeHead(!html ? 404 : req.url === "/case/denied" ? 403 : 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html ?? "");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    tasks,
    origin: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}
