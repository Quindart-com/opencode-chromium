#!/usr/bin/env node
// Deterministic store-art generator. Every rendered string comes from DEMO_FIXTURE
// below - never from a live popup, real profile, or local machine state.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storeDir = path.join(root, "store");

const DEMO_FIXTURE = {
  product: "OPENCODE-CHROMIUM",
  tagline: "BROWSER AUTOMATION FOR AI CODING AGENTS",
  subline: "LOCAL · PRIVATE · OPENCODE + CODEX + MCP",
  connection: [
    "STATUS: READY",
    "PROFILE: DEMO",
    "PROFILE ID: DEMO-PROFILE",
    "MODEL CACHE: LOCAL",
  ],
  memory: [
    "ACTIONS: 148",
    "CHAINS: 32",
    "REPLAY SUCCESS: 82%",
    "STEPS REUSED: 184",
  ],
  footer: "DEMO DATA - GENERATED ART, NOT A REAL PROFILE",
};

const FONT = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  "3": [0x0e, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  " ": [0, 0, 0, 0, 0, 0, 0],
  ":": [0x00, 0x04, 0x00, 0x00, 0x04, 0x00, 0x00],
  "·": [0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00],
  "-": [0x00, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x00],
  "+": [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04],
  "/": [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  "%": [0x19, 0x1a, 0x02, 0x04, 0x08, 0x0b, 0x13],
  ",": [0x00, 0x00, 0x00, 0x00, 0x04, 0x04, 0x08],
};

const COLORS = {
  bgTop: [11, 18, 32],
  bgBottom: [22, 35, 63],
  accent: [45, 212, 191],
  accent2: [99, 102, 241],
  text: [237, 242, 255],
  muted: [148, 163, 184],
  card: [17, 27, 48],
  cardBorder: [56, 76, 120],
};

function createCanvas(width, height) {
  return { width, height, pixels: new Uint8Array(width * height * 4) };
}

function blendPixel(canvas, x, y, [r, g, b], alpha = 255) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const offset = (y * canvas.width + x) * 4;
  canvas.pixels[offset] = r;
  canvas.pixels[offset + 1] = g;
  canvas.pixels[offset + 2] = b;
  canvas.pixels[offset + 3] = alpha;
}

function gradientBackground(canvas) {
  for (let y = 0; y < canvas.height; y += 1) {
    const t = y / (canvas.height - 1);
    const r = Math.round(COLORS.bgTop[0] + (COLORS.bgBottom[0] - COLORS.bgTop[0]) * t);
    const g = Math.round(COLORS.bgTop[1] + (COLORS.bgBottom[1] - COLORS.bgTop[1]) * t);
    const b = Math.round(COLORS.bgTop[2] + (COLORS.bgBottom[2] - COLORS.bgTop[2]) * t);
    for (let x = 0; x < canvas.width; x += 1) blendPixel(canvas, x, y, [r, g, b]);
  }
}

function drawRect(canvas, x, y, width, height, color) {
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) blendPixel(canvas, x + dx, y + dy, color);
  }
}

function drawFrame(canvas, x, y, width, height, color, thickness = 2) {
  drawRect(canvas, x, y, width, thickness, color);
  drawRect(canvas, x, y + height - thickness, width, thickness, color);
  drawRect(canvas, x, y, thickness, height, color);
  drawRect(canvas, x + width - thickness, y, thickness, height, color);
}

function textWidth(text, scale) {
  return text.length * (5 + 1) * scale - scale;
}

function drawText(canvas, originX, originY, text, scale, color) {
  const normalized = String(text).toUpperCase();
  let cursor = originX;
  for (const char of normalized) {
    const glyph = FONT[char] ?? FONT[" "];
    for (let row = 0; row < 7; row += 1) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col += 1) {
        if ((bits >> (4 - col)) & 1) {
          drawRect(canvas, cursor + col * scale, originY + row * scale, scale, scale, color);
        }
      }
    }
    cursor += (5 + 1) * scale;
  }
  return cursor;
}

function drawCard(canvas, x, y, width, height, title, sections) {
  drawRect(canvas, x, y, width, height, COLORS.card);
  drawFrame(canvas, x, y, width, height, COLORS.cardBorder);
  drawRect(canvas, x, y, width, 40, COLORS.accent2);
  drawText(canvas, x + 18, y + 13, title, 2, COLORS.text);
  let cursorY = y + 62;
  for (const section of sections) {
    if (section.heading) {
      drawText(canvas, x + 18, cursorY, section.heading, 2, COLORS.accent);
      cursorY += 26;
    }
    for (const row of section.rows) {
      drawText(canvas, x + 18, cursorY, row, 2, COLORS.text);
      cursorY += 26;
    }
    cursorY += 14;
  }
}

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(canvas) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.width, 0);
  ihdr.writeUInt32BE(canvas.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((canvas.width * 4 + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    raw[y * (canvas.width * 4 + 1)] = 0;
    Buffer.from(canvas.pixels.buffer, y * canvas.width * 4, canvas.width * 4).copy(raw, y * (canvas.width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderBanner() {
  const canvas = createCanvas(1400, 560);
  gradientBackground(canvas);
  drawRect(canvas, 0, 548, 1400, 12, COLORS.accent);
  drawText(canvas, 70, 92, DEMO_FIXTURE.product, 7, COLORS.text);
  drawText(canvas, 70, 170, DEMO_FIXTURE.tagline, 3, COLORS.accent);
  drawText(canvas, 70, 216, DEMO_FIXTURE.subline, 2, COLORS.muted);
  let chipX = 70;
  for (const row of [DEMO_FIXTURE.connection[0], DEMO_FIXTURE.memory[0], DEMO_FIXTURE.memory[2]]) {
    const label = row.replace(":", " ·");
    const width = textWidth(label, 2) + 28;
    drawRect(canvas, chipX, 268, width, 36, COLORS.card);
    drawFrame(canvas, chipX, 268, width, 36, COLORS.cardBorder, 1);
    drawText(canvas, chipX + 14, 278, label, 2, COLORS.text);
    chipX += width + 16;
  }
  drawText(canvas, 70, 340, "REAL BROWSER  ·  REAL PAGES  ·  LEAN CONTEXT", 2, COLORS.muted);
  drawText(canvas, 70, 376, "NOTHING LEAVES YOUR DEVICE", 2, COLORS.muted);
  const cardX = 830;
  const cardY = 70;
  drawCard(canvas, cardX, cardY, 500, 420, DEMO_FIXTURE.product, [
    { heading: "CONNECTION", rows: DEMO_FIXTURE.connection },
    { heading: "MEMORY", rows: DEMO_FIXTURE.memory.slice(0, 3) },
  ]);
  drawText(canvas, cardX + 18, cardY + 384, DEMO_FIXTURE.footer, 1, COLORS.muted);
  return encodePng(canvas);
}

function renderScreenshot() {
  const canvas = createCanvas(1280, 800);
  gradientBackground(canvas);
  const cardX = 300;
  const cardY = 90;
  drawCard(canvas, cardX, cardY, 680, 620, DEMO_FIXTURE.product, [
    { heading: "CONNECTION", rows: DEMO_FIXTURE.connection },
    { heading: "MEMORY", rows: DEMO_FIXTURE.memory },
  ]);
  drawText(canvas, cardX + 18, cardY + 584, DEMO_FIXTURE.footer, 1, COLORS.muted);
  drawText(canvas, 70, 744, "OPENCODE + CODEX + MCP  ·  LOCAL NATIVE MESSAGING HOST", 2, COLORS.muted);
  return encodePng(canvas);
}

fs.mkdirSync(storeDir, { recursive: true });
fs.writeFileSync(path.join(storeDir, "opencode-chromium-1400x560.png"), renderBanner());
fs.writeFileSync(path.join(storeDir, "opencode-chromium-1280x800.png"), renderScreenshot());
console.log(JSON.stringify({ ok: true, fixtureOnly: true, written: ["store/opencode-chromium-1400x560.png", "store/opencode-chromium-1280x800.png"] }));
