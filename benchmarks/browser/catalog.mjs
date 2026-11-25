import { createHash } from "node:crypto";

export const hash = value => createHash("sha256").update(value).digest("hex");
export const viewport = { width: 1100, height: 900 };

const apps = {
  invoices: { noun: "invoice", verb: "Approve", other: "Preview", paraphrase: "Authorize payment for", count: 48 },
  preferences: { noun: "team", verb: "Save", other: "Reset", paraphrase: "Store the settings for", count: 9 },
  tickets: { noun: "ticket", verb: "Assign", other: "Details for", paraphrase: "Take ownership of", count: 56 },
  checkout: { noun: "order", verb: "Confirm", other: "Cancel", paraphrase: "Complete checkout for", count: 5 },
  feed: { noun: "entry", verb: "Pin", other: "Dismiss", paraphrase: "Keep at the top", count: 16 },
  shadow: { noun: "switch", verb: "Enable", other: "Disable", paraphrase: "Turn on", count: 5 },
};

// The index oracles and rendering data stay in the fixture process. The driver
// receives the goal and the URL, plus observations made by the selected tool.
const cases = [
  ["invoice-first", "invoices", 1], ["invoice-visible", "invoices", 6],
  ["invoice-late", "invoices", 47], ["invoice-500", "invoices", 499, { dense: true }],
  ["invoice-paraphrase", "invoices", 4, { holdout: true }], ["invoice-tail", "invoices", 48, { holdout: true }],
  ["prefs-first", "preferences", 1], ["prefs-middle", "preferences", 5],
  ["prefs-last", "preferences", 9], ["prefs-rename", "preferences", 2, { edit: true }],
  ["prefs-paraphrase", "preferences", 7, { holdout: true, edit: true }],
  ["ticket-first", "tickets", 1], ["ticket-visible", "tickets", 5], ["ticket-next", "tickets", 10],
  ["ticket-offscreen", "tickets", 35], ["ticket-tail", "tickets", 56], ["ticket-paraphrase", "tickets", 15, { holdout: true }],
  ["checkout-first", "checkout", 1], ["checkout-second", "checkout", 2],
  ["checkout-last", "checkout", 5], ["checkout-paraphrase", "checkout", 4, { holdout: true }],
  ["feed-first", "feed", 1], ["feed-middle", "feed", 8],
  ["feed-late", "feed", 15], ["feed-paraphrase", "feed", 3, { holdout: true }],
  ["shadow-first", "shadow", 1], ["shadow-last", "shadow", 5],
  ["shadow-paraphrase", "shadow", 3, { holdout: true }],
  ["ticket-ambiguous", "tickets", 2, { guard: "AMBIGUOUS_TARGET" }],
  ["invoice-disabled", "invoices", 2, { guard: "TARGET_MISSING" }],
];

const smoke = ["invoice-first", "invoice-late", "prefs-rename", "ticket-visible", "feed-first"];
const probeCases = [
  ["probe-wrong", "invoices", 2, { fault: "wrong" }],
  ["probe-duplicate", "invoices", 2, { fault: "duplicate" }],
  ["probe-read-denied", "invoices", 2, { fault: "lookup" }],
  ["probe-after-click", "invoices", 2, { fault: "confirmation" }],
];

export function schedule({ seed, suite, round, client, inputMode = "auto" }) {
  const selected = suite === "faults" ? probeCases : cases.filter(([id]) => suite === "full" || smoke.includes(id));
  const order = item => hash(JSON.stringify([seed, round, client, item[0]]));
  return [...selected].sort((a, b) => order(a).localeCompare(order(b))).map(([id, app, index, options = {}]) => {
    const config = apps[app];
    const stem = `${hash(seed).slice(0, 5)}-${round.toString(36)}-${client.toString(36)}`.toUpperCase();
    const entityOf = n => `${config.noun} ${stem}-${String(n).padStart(3, "0")}`;
    const entity = entityOf(index);
    const value = options.edit ? `Équipe Rivière ${stem}` : null;
    const verb = options.holdout ? config.paraphrase : config.verb;
    const goal = value ? `Set the display name for ${entity} to “${value}” and ${verb.toLowerCase()} its settings.` : `${verb} ${entity}.`;
    const count = options.dense ? 500 : config.count;
    return {
      id, app, round, client, count, entityOf, index, goal, holdout: !!options.holdout,
      allowedActions: value ? ["read", "fill", "click"] : ["read", "click"],
      guard: options.guard ?? null, fault: options.fault ?? null,
      initial: { mutations: 0, draft: value ? `Original ${entity}` : null },
      expected: options.guard ? null : { effect: `${config.verb.toLowerCase()}:${entity}`, value: app === "preferences" ? value ?? `Original ${entity}` : null },
      framed: app === "checkout", slow: client === 1 && suite === "load", requireTrusted: inputMode === "pointer",
    };
  });
}

const escapeHtml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const title = value => value[0].toUpperCase() + value.slice(1);

function controls(task, n) {
  const entity = task.entityOf(n);
  const config = apps[task.app];
  const verb = config.verb.toLowerCase();
  const button = (label, effect, disabled = false) => `<button data-effect="${escapeHtml(`${effect}:${entity}`)}"${disabled ? " disabled" : ""}>${escapeHtml(label)}</button>`;
  const enabled = task.guard !== "TARGET_MISSING" || n !== task.index;
  const action = button(`${config.verb} ${entity}${enabled ? "" : " (unavailable)"}`, verb, !enabled);
  const duplicate = task.guard === "AMBIGUOUS_TARGET" && n === task.index ? button(`${config.verb} ${entity}`, "duplicate-label") : "";
  const draft = task.app === "preferences" ? `<label>Display name for ${entity} <input data-entity="${entity}" aria-label="Display name for ${entity}" placeholder="Display name for ${entity}" value="Original ${entity}"></label>` : "";
  const alternate = button(`${config.other} ${entity}`, config.other.toLowerCase());
  return task.holdout ? `${draft} ${alternate} ${action} ${duplicate}` : `${draft} ${action} ${duplicate} ${alternate}`;
}

function content(task) {
  const rows = Array.from({ length: task.count }, (_, index) => {
    const n = index + 1;
    const label = title(task.entityOf(n));
    const actions = controls(task, n);
    if (task.app === "invoices") return `<tr><th scope="row">${label}</th><td>November ${n % 28 + 1}</td><td>${n * 17}</td><td>${actions}</td></tr>`;
    if (task.app === "preferences") return `<fieldset><legend>${label}</legend>${actions}</fieldset>`;
    if (task.app === "tickets") return `<article><b>${label}</b> Review build status <button data-effect="open:${task.entityOf(n)}">Details</button> ${actions}</article>`;
    if (task.app === "shadow") return `<benchmark-switch><template>${actions}</template></benchmark-switch>`;
    return `<section><h2>${label}</h2>${actions}</section>`;
  }).join("");
  if (task.app === "invoices") return `<table><thead><tr><th>Customer</th><th>Due</th><th>Balance</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
  return rows;
}

// Executed only inside the generated document. Every user-facing control has
// an effect, including neighbors and the duplicate label in the guard case.
function instrument(endpoint, channel, changing) {
  let seq = 0;
  const journal = (type, fields) => fetch(endpoint, { method: "POST", keepalive: true,
    body: JSON.stringify({ type, seq: ++seq, ...fields }) });
  document.addEventListener("click", async event => {
    const control = event.composedPath().find(node => node?.dataset?.effect);
    if (!control) return;
    const value = control.closest("fieldset")?.querySelector("input")?.value ?? null;
    const response = await journal("effect", { key: control.dataset.effect, trusted: event.isTrusted, value });
    if (response.ok) document.querySelector("output").textContent = "Change recorded";
  });
  document.addEventListener("input", event => {
    if (event.target.dataset.entity) void journal("draft", { key: event.target.dataset.entity, value: event.target.value });
    if (event.target.id === "sentinel") void journal("typing", { value: event.target.value, trusted: event.isTrusted });
  });
  customElements.define("benchmark-switch", class extends HTMLElement {
    connectedCallback() {
      this.attachShadow({ mode: "open" }).append(this.querySelector("template").content.cloneNode(true));
    }
  });
  if (changing) {
    const revisions = document.querySelector("#revision");
    let revision = 0;
    setInterval(() => { revisions.textContent = `Feed revision ${++revision}`; }, 90);
  }
  if (channel === "sentinel") {
    const showFocus = () => void journal("focus", { focused: document.hasFocus(), visible: !document.hidden });
    window.addEventListener("focus", showFocus);
    window.addEventListener("blur", showFocus);
    document.addEventListener("visibilitychange", showFocus);
  }
  void journal("ready", { width: innerWidth, height: innerHeight, ua: navigator.userAgent, documentHeight: document.documentElement.scrollHeight });
}

export function render(task, { endpoint, frameUrl, channel = "main" }) {
  const heading = task?.app ? title(task.app) : "Browser sentinel";
  const body = channel === "sentinel" ? '<label>Foreground sentinel <input id="sentinel"></label>'
    : channel === "claim" ? '<button data-effect="unexpected-claim-action">Claim test tab</button>'
    : task.framed && channel === "main" ? `<iframe title="Checkout actions" src="${escapeHtml(frameUrl)}"></iframe>`
    : content(task);
  const script = `(${instrument.toString().replaceAll("\r\n", "\n")})(${JSON.stringify(endpoint)},${JSON.stringify(channel)},${task?.app === "feed"})`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${heading}</title><style>
    body{font:16px sans-serif;margin:14px}header{position:sticky;top:0;background:white;padding:5px;z-index:1}
    td,th,fieldset,article,section{padding:5px;text-align:left}button,input{font:inherit}h2{font-size:16px;margin:4px 0}
    iframe{width:99%;height:625px}benchmark-switch{display:block;margin:12px}</style>
    <main><header><h1>${heading}</h1><output role="status">Pending</output><span id="revision"></span></header>${body}</main><script>${script}</script></html>`;
}

export function fixtureHash(task) {
  const options = { endpoint: "/event/fixture", frameUrl: "http://127.0.0.1:1/frame/fixture" };
  const main = render(task, options);
  const frame = task.framed ? render(task, { ...options, channel: "frame" }) : "";
  return hash(JSON.stringify([main, frame, task.goal, task.expected, task.allowedActions, task.fault, task.guard, task.slow, task.requireTrusted]));
}
