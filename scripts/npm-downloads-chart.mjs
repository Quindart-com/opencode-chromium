#!/usr/bin/env node

/**
 * Self-hosted NPM weekly-download history chart.
 *
 * Appends the latest completed week of downloads to
 * assets/npm-downloads.json and renders assets/npm-downloads.svg. The chart
 * is generated from the first-party NPM Downloads API inside a repository
 * workflow, so the README can display the metric without depending on an
 * external chart service.
 *
 * Usage: node scripts/npm-downloads-chart.mjs
 * Env:   NPM_DOWNLOADS_PACKAGE (default opencode-chromium)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PACKAGE = process.env.NPM_DOWNLOADS_PACKAGE ?? "opencode-chromium";
const dataFile = path.resolve("assets", "npm-downloads.json");
const outFile = path.resolve("assets", "npm-downloads.svg");
const WIDTH = 680;
const HEIGHT = 250;
const PAD = { left: 48, right: 20, top: 40, bottom: 56 };

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function shortDate(iso) {
  return iso.slice(0, 10);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

try {
  const encodedPackage = encodeURIComponent(PACKAGE);
  const response = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodedPackage}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "opencode-chromium-npm-downloads-chart",
    },
  });
  if (!response.ok) throw new Error(`NPM Downloads API returned ${response.status}`);

  const point = await response.json();
  const downloads = Number.isInteger(point.downloads) && point.downloads >= 0 ? point.downloads : null;
  if (downloads === null) throw new Error("NPM Downloads API returned an invalid download count");

  let history = [];
  try {
    history = JSON.parse(readFileSync(dataFile, "utf8"));
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }
  history = history.filter(
    (entry) =>
      entry &&
      typeof entry.date === "string" &&
      Number.isInteger(entry.downloads) &&
      entry.downloads >= 0,
  );

  const periodEnd = typeof point.end === "string" ? point.end : isoToday();
  const last = history.at(-1);
  if (!last || last.date !== periodEnd || last.downloads !== downloads) {
    history.push({ date: periodEnd, downloads });
  }

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const maxDownloads = Math.max(...history.map((entry) => entry.downloads), 1);
  const xAt = (index) => PAD.left + (history.length === 1 ? plotW / 2 : (plotW * index) / (history.length - 1));
  const yAt = (value) => PAD.top + plotH - (plotH * value) / maxDownloads;

  const line = history
    .map((entry, index) => `${index === 0 ? "M" : "L"}${xAt(index).toFixed(1)},${yAt(entry.downloads).toFixed(1)}`)
    .join(" ");
  const baseline = `M${PAD.left},${PAD.top + plotH}H${WIDTH - PAD.right}`;
  const dots = history
    .map((entry, index) => `<circle cx="${xAt(index).toFixed(1)}" cy="${yAt(entry.downloads).toFixed(1)}" r="3.5" fill="#0969da"/>`)
    .join("\n  ");
  const first = history[0];
  const lastEntry = history.at(-1);
  const updated = lastEntry?.date ?? periodEnd;
  const generated = isoToday();

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="NPM weekly download history for ${esc(PACKAGE)}">
  <rect width="${WIDTH}" height="${HEIGHT}" rx="10" fill="#ffffff"/>
  <text x="${PAD.left}" y="26" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="15" font-weight="700" fill="#1f2328">NPM weekly downloads</text>
  <text x="${WIDTH - PAD.right}" y="26" text-anchor="end" font-family="inherit" font-size="12" fill="#59636e">${formatNumber(downloads)} downloads</text>
  <path d="${baseline}" stroke="#d1d9e0" stroke-width="1.5" fill="none"/>
  <path d="${line}" stroke="#0969da" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  ${dots}
  <text x="${PAD.left}" y="${PAD.top + plotH + 26}" font-family="inherit" font-size="11" fill="#59636e">${first ? esc(shortDate(first.date)) : ""}</text>
  <text x="${WIDTH - PAD.right}" y="${PAD.top + plotH + 26}" text-anchor="end" font-family="inherit" font-size="11" fill="#59636e">${esc(shortDate(updated))}</text>
  <text x="${PAD.left}" y="${PAD.top - 6}" font-family="inherit" font-size="11" fill="#59636e">${formatNumber(maxDownloads)}</text>
  <text x="${PAD.left}" y="${HEIGHT - 8}" font-family="inherit" font-size="10" fill="#8c959f">Updated ${esc(generated)} · generated from the NPM Downloads API by a repository workflow</text>
</svg>
`;
  writeFileSync(dataFile, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  writeFileSync(outFile, svg, "utf8");
  console.log(
    JSON.stringify(
      { package: PACKAGE, downloads, period: { start: point.start ?? null, end: periodEnd }, points: history.length, data: dataFile, svg: outFile },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
