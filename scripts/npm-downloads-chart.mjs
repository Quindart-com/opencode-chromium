#!/usr/bin/env node

/**
 * Self-hosted NPM weekly-download history chart.
 *
 * Rebuilds assets/npm-downloads.json from the first-party NPM Downloads API
 * (daily range data aggregated into ISO weeks) and renders two themed charts:
 * assets/npm-downloads.svg (light) and assets/npm-downloads-dark.svg (dark).
 * The README embeds both through a <picture> element so the chart matches the
 * GitHub theme without an external chart service.
 *
 * Usage: node scripts/npm-downloads-chart.mjs
 * Env:   NPM_DOWNLOADS_PACKAGE (default opencode-chromium)
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

const PACKAGE = process.env.NPM_DOWNLOADS_PACKAGE ?? "opencode-chromium";
const dataFile = path.resolve("assets", "npm-downloads.json");
const lightFile = path.resolve("assets", "npm-downloads.svg");
const darkFile = path.resolve("assets", "npm-downloads-dark.svg");
const WIDTH = 680;
const HEIGHT = 220;
const PAD = { left: 46, right: 24, top: 24, bottom: 40 };
const MAX_WEEKS = 52;

function isoWeekMonday(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - weekday);
  return day;
}

function shortDate(iso) {
  const [year, month, day] = iso.split("-");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[Number(month) - 1]} ${Number(day)}`;
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

async function fetchDownloadHistory() {
  const encoded = encodeURIComponent(PACKAGE);
  const response = await fetch(`https://api.npmjs.org/downloads/range/last-year/${encoded}`, {
    headers: { Accept: "application/json", "User-Agent": "opencode-chromium-npm-downloads-chart" },
  });
  if (!response.ok) throw new Error(`NPM Downloads API returned ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.downloads)) throw new Error("NPM Downloads API returned an invalid range payload");

  const daily = payload.downloads
    .filter((entry) => typeof entry?.day === "string" && Number.isInteger(entry.downloads) && entry.downloads >= 0)
    .map((entry) => ({ date: entry.day, downloads: entry.downloads }))
    .sort((first, second) => (first.date < second.date ? -1 : 1));
  if (daily.length === 0) throw new Error("NPM Downloads API produced no daily data");

  const weekly = new Map();
  for (const entry of daily) {
    const weekStart = isoWeekMonday(new Date(`${entry.date}T00:00:00Z`));
    const key = weekStart.toISOString().slice(0, 10);
    weekly.set(key, (weekly.get(key) ?? 0) + entry.downloads);
  }
  const weeks = [...weekly.entries()]
    .sort(([first], [second]) => (first < second ? -1 : 1))
    .map(([date, downloads]) => ({ date, downloads }));

  // The current week is still in progress; drop it so completed weeks only.
  const currentWeek = isoWeekMonday(new Date()).toISOString().slice(0, 10);
  if (weeks.at(-1)?.date === currentWeek) weeks.pop();

  // Trim leading zero periods so the chart starts when the package launched.
  const firstActiveWeek = weeks.findIndex((week) => week.downloads > 0);
  const activeWeeks = (firstActiveWeek > 0 ? weeks.slice(firstActiveWeek) : weeks).slice(-MAX_WEEKS);
  if (activeWeeks.length >= 8) return { granularity: "week", series: activeWeeks };

  const today = new Date().toISOString().slice(0, 10);
  const completedDays = daily.filter((entry) => entry.date < today);
  const firstActiveDay = completedDays.findIndex((entry) => entry.downloads > 0);
  const activeDays = (firstActiveDay > 0 ? completedDays.slice(firstActiveDay) : completedDays).slice(-60);
  if (activeDays.length === 0) throw new Error("NPM Downloads API produced no completed days");
  return { granularity: "day", series: activeDays };
}

function renderSvg(series, granularity, theme) {
  const { background, titleColor, valueColor, textColor, faintColor, gridColor, lineColor, areaTop, areaBottom, dotColor } = theme;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const maxDownloads = Math.max(...series.map((entry) => entry.downloads), 1);
  const magnitude = 10 ** Math.floor(Math.log10(maxDownloads));
  const niceMax = Math.ceil(maxDownloads / (magnitude / 2)) * (magnitude / 2);
  const xAt = (index) => PAD.left + (series.length === 1 ? plotW / 2 : (plotW * index) / (series.length - 1));
  const yAt = (value) => PAD.top + plotH - (plotH * value) / niceMax;

  const points = series.map((entry, index) => [xAt(index), yAt(entry.downloads)]);
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${points.at(-1)[0].toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${points[0][0].toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`;
  const last = series.at(-1);
  const [lastX, lastY] = points.at(-1);
  const labelX = Math.min(lastX, WIDTH - PAD.right - 8);
  const labelY = Math.max(PAD.top + 12, lastY - 10);
  const first = series[0];
  const mid = series[Math.floor((series.length - 1) / 2)];

  const ticks = [0, 0.5, 1].map((fraction) => {
    const value = Math.round(niceMax * fraction);
    const y = yAt(value);
    return `<path d="M${PAD.left},${y.toFixed(1)}H${WIDTH - PAD.right}" stroke="${gridColor}" stroke-width="${fraction === 0 ? 1.2 : 1}" stroke-dasharray="${fraction === 0 ? "none" : "3 5"}" fill="none"/>
  <text x="${PAD.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10.5" fill="${faintColor}">${formatNumber(value)}</text>`;
  }).join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="NPM downloads for ${esc(PACKAGE)}, ${granularity === "week" ? "weekly" : "daily"}">
  <rect width="${WIDTH}" height="${HEIGHT}" rx="12" fill="${background}"/>
  <text x="${PAD.left}" y="18" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="13.5" font-weight="700" fill="${titleColor}">NPM downloads · ${granularity === "week" ? "weekly" : "daily"}</text>
  <text x="${WIDTH - PAD.right}" y="18" text-anchor="end" font-size="12" font-weight="600" fill="${valueColor}">${formatNumber(last.downloads)} ${granularity === "week" ? "last week" : "yesterday"}</text>
  ${ticks}
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${areaTop}"/>
      <stop offset="1" stop-color="${areaBottom}"/>
    </linearGradient>
  </defs>
  <path d="${area}" fill="url(#area)" stroke="none"/>
  <path d="${line}" stroke="${lineColor}" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" fill="${dotColor}" stroke="${background}" stroke-width="1.6"/>
  <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="end" font-size="10.5" font-weight="600" fill="${textColor}">${formatNumber(last.downloads)}</text>
  <text x="${PAD.left}" y="${HEIGHT - 10}" font-size="10.5" fill="${faintColor}">${esc(shortDate(first.date))}</text>
  <text x="${((PAD.left + WIDTH - PAD.right) / 2).toFixed(1)}" y="${HEIGHT - 10}" text-anchor="middle" font-size="10.5" fill="${faintColor}">${esc(shortDate(mid.date))}</text>
  <text x="${WIDTH - PAD.right}" y="${HEIGHT - 10}" text-anchor="end" font-size="10.5" fill="${faintColor}">${esc(shortDate(last.date))}</text>
</svg>
`;
}

try {
  const { granularity, series } = await fetchDownloadHistory();
  const lightTheme = {
    background: "#ffffff", titleColor: "#1f2328", valueColor: "#0969da", textColor: "#1f2328",
    faintColor: "#59636e", gridColor: "#d1d9e0", lineColor: "#0969da",
    areaTop: "rgba(9,105,218,0.20)", areaBottom: "rgba(9,105,218,0.02)", dotColor: "#0969da",
  };
  const darkTheme = {
    background: "#0d1117", titleColor: "#e6edf3", valueColor: "#4493f8", textColor: "#e6edf3",
    faintColor: "#9198a1", gridColor: "#21262d", lineColor: "#4493f8",
    areaTop: "rgba(68,147,248,0.24)", areaBottom: "rgba(68,147,248,0.02)", dotColor: "#4493f8",
  };
  writeFileSync(dataFile, `${JSON.stringify({ granularity, series }, null, 2)}\n`, "utf8");
  writeFileSync(lightFile, renderSvg(series, granularity, lightTheme), "utf8");
  writeFileSync(darkFile, renderSvg(series, granularity, darkTheme), "utf8");
  console.log(JSON.stringify({ package: PACKAGE, granularity, points: series.length, range: [series[0].date, series.at(-1).date], latest: series.at(-1).downloads, data: dataFile, light: lightFile, dark: darkFile }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
