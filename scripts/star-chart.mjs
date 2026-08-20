#!/usr/bin/env node

/**
 * Self-hosted star history chart.
 *
 * Appends the current stargazer count to assets/star-history.json and renders
 * assets/star-history.svg. GitHub restricted third-party star-scraping (the
 * star-history services are unusable for everyone right now), so the chart is
 * generated from the first-party GitHub API inside a repository workflow and
 * rendered from the repository itself — it can never be restricted and always
 * shows the current data.
 *
 * Usage: node scripts/star-chart.mjs
 * Env:   STAR_CHART_REPO (default Quindart-com/opencode-chromium)
 *        GITHUB_TOKEN / GH_TOKEN (optional; used by the workflow)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = process.env.STAR_CHART_REPO ?? "Quindart-com/opencode-chromium";
const dataFile = path.resolve("assets", "star-history.json");
const outFile = path.resolve("assets", "star-history.svg");
const WIDTH = 680;
const HEIGHT = 250;
const PAD = { left: 48, right: 20, top: 40, bottom: 56 };

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function shortDate(iso) {
  return iso.slice(0, 10);
}

function esc(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

try {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "opencode-chromium-star-chart" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${REPO}`, { headers });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  const repo = await response.json();
  const stars = Number.isInteger(repo.stargazers_count) ? repo.stargazers_count : 0;

  let history = [];
  try {
    history = JSON.parse(readFileSync(dataFile, "utf8"));
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }
  history = history.filter((entry) => entry && typeof entry.date === "string" && Number.isInteger(entry.stars));
  const today = isoToday();
  const last = history.at(-1);
  if (!last || last.date !== today || last.stars !== stars) {
    history.push({ date: today, stars });
  }

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const maxStars = Math.max(...history.map((entry) => entry.stars), 1);
  const xAt = (index) => PAD.left + (history.length === 1 ? plotW / 2 : (plotW * index) / (history.length - 1));
  const yAt = (stars) => PAD.top + plotH - (plotH * stars) / maxStars;

  const line = history.map((entry, index) => `${index === 0 ? "M" : "L"}${xAt(index).toFixed(1)},${yAt(entry.stars).toFixed(1)}`).join(" ");
  const baseline = `M${PAD.left},${PAD.top + plotH}H${WIDTH - PAD.right}`;
  const dots = history.map((entry, index) => `<circle cx="${xAt(index).toFixed(1)}" cy="${yAt(entry.stars).toFixed(1)}" r="3.5" fill="#0969da"/>`).join("\n  ");
  const first = history[0];
  const lastEntry = history.at(-1);
  const updated = lastEntry?.date ?? today;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="Star history for ${esc(REPO)}">
  <rect width="${WIDTH}" height="${HEIGHT}" rx="10" fill="#ffffff"/>
  <text x="${PAD.left}" y="26" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="15" font-weight="700" fill="#1f2328">Star history</text>
  <text x="${WIDTH - PAD.right}" y="26" text-anchor="end" font-family="inherit" font-size="12" fill="#59636e">${stars} stars</text>
  <path d="${baseline}" stroke="#d1d9e0" stroke-width="1.5" fill="none"/>
  <path d="${line}" stroke="#0969da" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  ${dots}
  <text x="${PAD.left}" y="${PAD.top + plotH + 26}" font-family="inherit" font-size="11" fill="#59636e">${first ? esc(shortDate(first.date)) : ""}</text>
  <text x="${WIDTH - PAD.right}" y="${PAD.top + plotH + 26}" text-anchor="end" font-family="inherit" font-size="11" fill="#59636e">${esc(shortDate(updated))}</text>
  <text x="${PAD.left}" y="${PAD.top - 6}" font-family="inherit" font-size="11" fill="#59636e">${maxStars} ★</text>
  <text x="${PAD.left}" y="${HEIGHT - 8}" font-family="inherit" font-size="10" fill="#8c959f">Updated ${esc(updated)} · generated from the GitHub API by a repository workflow</text>
</svg>
`;
  writeFileSync(dataFile, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  writeFileSync(outFile, svg, "utf8");
  console.log(JSON.stringify({ repo: REPO, stars, points: history.length, data: dataFile, svg: outFile }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}