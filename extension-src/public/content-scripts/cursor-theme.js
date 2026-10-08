/*
 * Agent cursor artwork.
 *
 * The pointer silhouette, the glow/outline paint stack, the per-session colour
 * palette and the action animations are ported from the Cua Driver cursor
 * overlay, which is MIT licensed:
 *
 *   https://github.com/trycua/cua
 *   libs/cua-driver/rust/crates/cursor-overlay
 *   Copyright (c) 2026 Cua AI, Inc.
 *   SPDX-License-Identifier: MIT
 *
 * The original rasterizes bounded vector frames with tiny-skia. A page cannot,
 * so the same geometry is emitted as inline SVG and the glow ramp is expressed
 * as per-stroke opacity. Everything else (canvas, hotspot, palette, mixes,
 * badge metrics) follows the source values.
 */

const OPENCODE_CURSOR_THEME_VERSION = 1;

if ((globalThis.__opencodeCursorThemeVersion ?? 0) < OPENCODE_CURSOR_THEME_VERSION) {
  globalThis.__opencodeCursorThemeVersion = OPENCODE_CURSOR_THEME_VERSION;

  const CANVAS = 128;
  const DISPLAY_SIZE = 42;
  const HOTSPOT = { x: 55, y: 30 };
  const DEFAULT_FILL = [94, 192, 232];

  // session_fill_rgba: named sessions hash into a fixed palette so concurrent
  // runs stay visually distinct without an agent-controlled styling argument.
  const SESSION_FILLS = [
    [178, 132, 255], [247, 132, 170], [96, 218, 174], [244, 178, 66], [76, 204, 224],
    [221, 113, 236], [232, 82, 98], [184, 220, 54], [80, 126, 236],
  ];

  function hashSession(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function sessionColor(cursorId) {
    const id = typeof cursorId === "string" ? cursorId : "";
    if (!id || id === "default") return DEFAULT_FILL.slice();
    const suffix = /[-_.](\d{1,3})$/.exec(id);
    if (suffix) return SESSION_FILLS[(Number(suffix[1]) - 1 + SESSION_FILLS.length * 4) % SESSION_FILLS.length].slice();
    const letter = /[-_.]([a-z])$/.exec(id);
    if (letter) return SESSION_FILLS[(letter[1].charCodeAt(0) - 97) % SESSION_FILLS.length].slice();
    return SESSION_FILLS[hashSession(id) % SESSION_FILLS.length].slice();
  }

  function mix(base, session, ratio) {
    return [
      Math.round(base[0] * (1 - ratio) + session[0] * ratio),
      Math.round(base[1] * (1 - ratio) + session[1] * ratio),
      Math.round(base[2] * (1 - ratio) + session[2] * ratio),
    ];
  }

  function cssColor(color) {
    return `rgb(${color[0]},${color[1]},${color[2]})`;
  }

  function rgba(color, alpha) {
    return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
  }

  const round = (value) => Math.round(value * 100) / 100;
  const point = (value) => `${round(value[0])} ${round(value[1])}`;

  // --- geometry -------------------------------------------------------------

  function bezierPath(vertices) {
    const segments = vertices.map(([vertex, , out], index) => {
      const next = vertices[(index + 1) % vertices.length];
      const control1 = [vertex[0] + out[0], vertex[1] + out[1]];
      const control2 = [next[0][0] + next[1][0], next[0][1] + next[1][1]];
      return `C${point(control1)} ${point(control2)} ${point(next[0])}`;
    });
    return `M${point(vertices[0][0])}${segments.join("")}Z`;
  }

  // The authored pointer: tip at the hotspot, body swept down and to the right.
  const POINTER_PATH = bezierPath([
    [[55, 30], [0, 0], [-7, -2]],
    [[43, 41], [-1, -8], [0, 0]],
    [[64, 98], [0, 0], [3, 8]],
    [[77, 99], [-4, 7], [0, 0]],
    [[86, 79], [0, 0], [2, -4]],
    [[95, 70], [-4, 2], [0, 0]],
    [[108, 63], [0, 0], [7, -4]],
    [[107, 50], [7, 3], [0, 0]],
  ]);

  // [stroke width in canvas units, glow intensity] from widest and faintest
  // inward. The source values are rasterizer intensities, not alphas: feeding
  // them in directly composites eight strokes into a solid blob that swallows
  // the action cue, so they are scaled into opacity here.
  const GLOW_STOPS = [[44, 2.0], [36, 2.4], [29, 3.0], [23, 3.8], [18, 4.8], [14, 6.0], [10, 7.5], [7, 9.5]];
  const POINTER_GLOW_DIVISOR = 72;
  const CUE_GLOW_DIVISOR = 40;
  const POINTER_OUTLINE = 5;
  const CUE_GLOW_OFFSETS = [13, 9, 6, 3];
  const CUE_GLOW_INTENSITY = [2.4, 3.1, 4.0, 5.2];

  function roundedRect(cx, cy, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    const left = cx - width / 2;
    const right = cx + width / 2;
    const top = cy - height / 2;
    const bottom = cy + height / 2;
    return `M${point([left + r, top])}H${point([right - r, top])}A${r} ${r} 0 0 1 ${point([right, top + r])}` +
      `V${point([bottom - r])}A${r} ${r} 0 0 1 ${point([right - r, bottom])}H${point([left + r, bottom])}` +
      `A${r} ${r} 0 0 1 ${point([left, bottom - r])}V${point([top + r])}A${r} ${r} 0 0 1 ${point([left + r, top])}Z`;
  }

  function circle(cx, cy, radius) {
    return `M${point([cx - radius, cy])}A${radius} ${radius} 0 1 0 ${point([cx + radius, cy])}A${radius} ${radius} 0 1 0 ${point([cx - radius, cy])}Z`;
  }

  function polyline(points, closed = false) {
    const [first, ...rest] = points;
    return `M${point(first)}${rest.map((item) => `L${point(item)}`).join("")}${closed ? "Z" : ""}`;
  }

  function arc(cx, cy, radius, fromDegrees, toDegrees) {
    const from = fromDegrees * Math.PI / 180;
    const to = toDegrees * Math.PI / 180;
    const large = Math.abs(toDegrees - fromDegrees) > 180 ? 1 : 0;
    const clockwise = toDegrees < fromDegrees ? 1 : 0;
    return `M${point([cx + Math.cos(from) * radius, cy + Math.sin(from) * radius])}` +
      `A${radius} ${radius} 0 ${large} ${clockwise} ${point([cx + Math.cos(to) * radius, cy + Math.sin(to) * radius])}`;
  }

  function gear(cx, cy, outer, inner, teeth) {
    const parts = [circle(cx, cy, inner)];
    for (let index = 0; index < teeth; index += 1) {
      const angle = (index / teeth) * Math.PI * 2;
      const nx = Math.cos(angle);
      const ny = Math.sin(angle);
      const tx = -ny;
      const ty = nx;
      const base = outer * 0.55;
      const tip = outer;
      const half = 3.2;
      parts.push(polyline([
        [cx + nx * base + tx * half, cy + ny * base + ty * half],
        [cx + nx * tip + tx * half * 0.7, cy + ny * tip + ty * half * 0.7],
        [cx + nx * tip - tx * half * 0.7, cy + ny * tip - ty * half * 0.7],
        [cx + nx * base - tx * half, cy + ny * base - ty * half],
      ], true));
    }
    return parts.join(" ");
  }

  // --- animation ------------------------------------------------------------

  function keyframes(progress, frames) {
    if (!frames.length) return 0;
    if (progress <= frames[0][0]) return frames[0][1];
    for (let index = 1; index < frames.length; index += 1) {
      const [stop, value] = frames[index];
      if (progress <= stop) {
        const [previousStop, previousValue] = frames[index - 1];
        const span = stop - previousStop || 1;
        return previousValue + (value - previousValue) * ((progress - previousStop) / span);
      }
    }
    return frames[frames.length - 1][1];
  }

  const at = (value) => () => value;
  const px = (value) => `${round(value)}`;
  const place = (x, y) => `translate(${round(x)} ${round(y)})`;

  // Cue geometry is authored left of and above the tip, matching the source
  // preview stills. Each layer animates through its own transform and opacity.
  const CHEVRON_UP = polyline([[23, 31], [31, 22], [39, 31]]);
  const CHEVRON_DOWN = polyline([[23, 49], [31, 58], [39, 49]]);
  const KEY_CAP = roundedRect(32, 31, 28, 28, 6);

  const ACTIONS = {
    idle: {
      mode: "resting",
      duration: 4000,
      stillFrame: 0,
      layers: [],
    },
    observe: {
      mode: "loop",
      duration: 1600,
      stillFrame: 0.5,
      glowWidth: 4.5,
      layers: [
        { d: arc(55, 30, 21, 152, 232), width: 4.5, scale: (p) => keyframes(p, [[0, 0.88], [0.25, 1], [0.5, 1.08], [1, 1.08]]), opacity: (p) => keyframes(p, [[0, 0], [0.18, 1], [0.72, 1], [1, 0]]) },
        { d: arc(55, 30, 31, 158, 226), width: 4.5, scale: (p) => keyframes(p, [[0, 0.88], [0.35, 1], [0.6, 1.08], [1, 1.08]]), opacity: (p) => keyframes(p, [[0, 0], [0.26, 1], [0.8, 1], [1, 0]]) },
      ],
    },
    click: {
      mode: "oneshot",
      duration: 670,
      stillFrame: 0.35,
      glowWidth: 4,
      pointer: { scale: (p) => keyframes(p, [[0, 1], [0.3, 0.93], [0.6, 1.03], [1, 1]]) },
      layers: [
        { d: polyline([[42, 14], [37, 6]]), width: 4, scale: (p) => keyframes(p, [[0, 1.1], [0.5, 1.3], [1, 1.5]]), opacity: (p) => keyframes(p, [[0, 1], [0.55, 0.7], [1, 0]]) },
        { d: polyline([[30, 20], [20, 15]]), width: 4, scale: (p) => keyframes(p, [[0, 1.1], [0.5, 1.3], [1, 1.5]]), opacity: (p) => keyframes(p, [[0, 1], [0.55, 0.7], [1, 0]]) },
        { d: polyline([[26, 30], [15, 30]]), width: 4, scale: (p) => keyframes(p, [[0, 1.1], [0.5, 1.3], [1, 1.5]]), opacity: (p) => keyframes(p, [[0, 1], [0.55, 0.7], [1, 0]]) },
      ],
    },
    drag: {
      mode: "held",
      duration: 1600,
      stillFrame: 0.5,
      glowWidth: 4,
      group: {
        dx: (p) => keyframes(p, [[0, 0], [0.5, 7], [1, 0]]),
        dy: (p) => keyframes(p, [[0, 0], [0.5, 3], [1, 0]]),
      },
      layers: [
        { d: polyline([[30, 18], [18, 26]]), width: 4, opacity: (p) => keyframes(p, [[0, 0.2], [0.35, 1], [0.7, 1], [1, 0.2]]) },
        { d: polyline([[34, 26], [22, 34]]), width: 4, opacity: (p) => keyframes(p, [[0, 0.2], [0.35, 1], [0.7, 1], [1, 0.2]]) },
      ],
    },
    scroll: {
      mode: "loop",
      duration: 1600,
      stillFrame: 0.5,
      glowWidth: 4,
      group: { dy: (p) => keyframes(p, [[0, 4], [0.5, -4], [1, 4]]) },
      layers: [
        { d: CHEVRON_UP, width: 4, opacity: (p) => keyframes(p, [[0, 0.42], [0.5, 1], [1, 0.42]]) },
        { d: CHEVRON_DOWN, width: 4, opacity: (p) => keyframes(p, [[0, 0.42], [0.5, 1], [1, 0.42]]) },
      ],
    },
    text: {
      mode: "held",
      duration: 1600,
      stillFrame: 0.4,
      glowWidth: 4,
      layers: [
        {
          d: `M26 18V44M21 18H31M21 44H31`,
          width: 4,
          // A hard caret blink: on/off at 33% and 62%, exactly like the source.
          opacity: (p) => (p > 0.33 && p < 0.4) || (p > 0.62 && p < 0.7) ? 0.18 : 1,
        },
      ],
    },
    key: {
      mode: "oneshot",
      duration: 1600,
      stillFrame: 0.35,
      glowWidth: 3.5,
      group: { dy: (p) => keyframes(p, [[0, 0], [0.28, 3], [0.55, -1], [1, 0]]), scale: (p) => keyframes(p, [[0, 1], [0.28, 0.92], [0.55, 1.03], [1, 1]]) },
      layers: [
        { d: KEY_CAP, width: 3.5, filled: true, opacity: at(1) },
        { d: polyline([[32, 45], [32, 52]]), width: 3.5, opacity: (p) => keyframes(p, [[0, 1], [0.8, 1], [1, 0]]) },
        { d: polyline([[25, 56], [32, 61], [39, 56]]), width: 3.5, opacity: (p) => keyframes(p, [[0, 1], [0.8, 1], [1, 0]]) },
      ],
    },
    navigate: {
      mode: "oneshot",
      duration: 1600,
      stillFrame: 0.5,
      glowWidth: 4,
      group: { dx: (p) => keyframes(p, [[0, -10], [0.5, -5], [1, -1]]) },
      layers: [
        { d: polyline([[15, 29], [25, 40], [15, 51]]), width: 4, opacity: at(1) },
        { d: polyline([[29, 29], [39, 40], [29, 51]]), width: 4, opacity: (p) => keyframes(p, [[0, 0.35], [0.5, 1], [1, 1]]) },
      ],
    },
    app: {
      mode: "oneshot",
      duration: 1600,
      stillFrame: 0.35,
      glowWidth: 3.5,
      group: { scale: (p) => keyframes(p, [[0, 0.2], [0.5, 1.12], [1, 1]]) },
      layers: [
        { d: roundedRect(21, 20, 10, 10, 2), width: 3.5, filled: true, opacity: at(1) },
        { d: roundedRect(33, 20, 10, 10, 2), width: 3.5, filled: true, opacity: at(1) },
        { d: roundedRect(21, 32, 10, 10, 2), width: 3.5, filled: true, opacity: at(1) },
        { d: roundedRect(33, 32, 10, 10, 2), width: 3.5, filled: true, opacity: at(1) },
      ],
    },
    transfer: {
      mode: "loop",
      duration: 1600,
      stillFrame: 0.5,
      glowWidth: 4,
      group: { dy: (p) => keyframes(p, [[0, 6], [0.5, -6], [1, 6]]) },
      layers: [
        { d: polyline([[22, 46], [22, 20]]) + polyline([[16, 27], [22, 20], [28, 27]]), width: 4, opacity: at(1) },
        { d: polyline([[37, 22], [37, 48]]) + polyline([[31, 41], [37, 48], [43, 41]]), width: 4, opacity: at(1) },
      ],
    },
    record: {
      mode: "loop",
      duration: 1600,
      stillFrame: 0.5,
      glowWidth: 4,
      group: { scale: (p) => keyframes(p, [[0, 0.72], [0.5, 1.14], [1, 0.72]]) },
      layers: [
        { d: circle(32, 31, 15), width: 4, opacity: at(1) },
        { d: circle(32, 31, 5), width: 4, filled: true, opacity: at(1) },
      ],
    },
    system: {
      mode: "loop",
      duration: 1600,
      stillFrame: 0.5,
      glowWidth: 3.5,
      group: { rotate: (p) => keyframes(p, [[0, -18], [0.6, 50], [1, 0]]) },
      layers: [{ d: gear(32, 31, 13, 4, 8), width: 3.5, opacity: at(1) }],
    },
  };

  const ACTION_IDS = Object.keys(ACTIONS);

  // --- paint ----------------------------------------------------------------

  function glowStrokes(d, color, width, divisor) {
    return CUE_GLOW_OFFSETS.map((offset, index) =>
      `<path d="${d}" fill="none" stroke="${cssColor(color)}" stroke-opacity="${round(CUE_GLOW_INTENSITY[index] / divisor)}" stroke-width="${round(width + offset)}" stroke-linecap="round" stroke-linejoin="round"/>`,
    ).join("");
  }

  function cuePaint(d, color, width, filled) {
    const core = filled
      ? `<path d="${d}" fill="${cssColor(color)}" stroke="#fff" stroke-width="${round(width + 1.5)}" stroke-linejoin="round"/>`
      : `<path d="${d}" fill="none" stroke="#fff" stroke-width="${round(width + 1.5)}" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<path d="${d}" fill="none" stroke="${cssColor(color)}" stroke-width="${round(Math.max(width - 1, 1.5))}" stroke-linecap="round" stroke-linejoin="round"/>`;
    return glowStrokes(d, color, width, CUE_GLOW_DIVISOR) + core;
  }

  function pointerMarkup(color) {
    const glows = GLOW_STOPS.map(([width, intensity]) =>
      `<path d="${POINTER_PATH}" fill="none" stroke="${cssColor(color)}" stroke-opacity="${round(intensity / POINTER_GLOW_DIVISOR)}" stroke-width="${width}" stroke-linejoin="round"/>`,
    ).join("");
    return glows + `<path d="${POINTER_PATH}" fill="${cssColor(color)}" stroke="#fff" stroke-width="${POINTER_OUTLINE}" stroke-linejoin="round"/>`;
  }

  function cueMarkup(actionId, color) {
    const action = ACTIONS[actionId] ?? ACTIONS.idle;
    if (!action.layers.length) return "";
    const width = action.glowWidth ?? 4;
    return action.layers.map((layer, index) =>
      `<g data-layer="${index}">${cuePaint(layer.d, color, layer.width ?? width, layer.filled === true)}</g>`,
    ).join("");
  }

  function actionMotion(actionId, progress) {
    const action = ACTIONS[actionId] ?? ACTIONS.idle;
    const p = Math.max(0, Math.min(1, progress));
    const group = action.group ?? {};
    const pointer = action.pointer ?? {};
    return {
      group: { dx: group.dx ? group.dx(p) : 0, dy: group.dy ? group.dy(p) : 0, scale: group.scale ? group.scale(p) : 1, rotate: group.rotate ? group.rotate(p) : 0 },
      pointer: { scale: pointer.scale ? pointer.scale(p) : 1 },
      layers: action.layers.map((layer) => ({
        opacity: layer.opacity ? layer.opacity(p) : 1,
        scale: layer.scale ? layer.scale(p) : 1,
      })),
    };
  }

  function staticProgress(actionId) {
    const action = ACTIONS[actionId] ?? ACTIONS.idle;
    const still = action.stillFrame ?? 0;
    return action.duration > 0 ? still : 0;
  }

  // Tool and step names are mapped to action ids by the layers that own them:
  // the runtime maps tools and step actions (src/browser/cursor.js) and the
  // background maps gesture batches to CDP input (cursor-state.js). This module
  // only turns an action id into artwork.

  function chipGlyph(actionId) {
    const strokes = {
      click: polyline([[8, 5], [14, 12]]) + polyline([[5, 8], [12, 7]]),
      drag: polyline([[6, 7], [16, 11]]) + polyline([[6, 11], [16, 15]]),
      scroll: polyline([[8, 10], [11, 6], [14, 10]]) + polyline([[8, 12], [11, 16], [14, 12]]),
      text: `M8 6V15M6 6H10M6 15H10`,
      key: roundedRect(11, 11, 12, 12, 2),
      navigate: polyline([[6, 7], [11, 11], [6, 15]]),
      app: roundedRect(8, 8, 5, 5, 1) + roundedRect(14, 8, 5, 5, 1) + roundedRect(8, 14, 5, 5, 1) + roundedRect(14, 14, 5, 5, 1),
      transfer: polyline([[9, 15], [9, 7]]) + polyline([[6, 10], [9, 7], [12, 10]]),
      record: circle(11, 11, 5),
      system: gear(11, 11, 7, 2, 6),
      observe: arc(14, 12, 8, 150, 240) + arc(14, 12, 12, 155, 235),
    };
    const d = strokes[actionId];
    if (!d) return "";
    return `<svg viewBox="0 0 22 22" width="18" height="18" aria-hidden="true"><path d="${d}" fill="none" stroke="rgba(255,255,255,.93)" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  // Packaged cursor geometry accepts only inert SVG elements and attributes.
  function replaceArtwork(target, markup) {
    const parsed = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">' + markup + '</svg>', 'image/svg+xml');
    const tags = new Set(['svg', 'g', 'path']);
    const attributes = new Set(['xmlns', 'd', 'fill', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'data-layer', 'viewBox', 'width', 'height', 'aria-hidden']);
    for (const element of parsed.querySelectorAll('*')) {
      if (!tags.has(element.localName)) { element.remove(); continue; }
      for (const attribute of [...element.attributes]) if (!attributes.has(attribute.name)) element.removeAttribute(attribute.name);
    }
    target.replaceChildren(...[...parsed.documentElement.childNodes].map(node => document.importNode(node, true)));
  }

  globalThis.__opencodeCursorTheme = {
    replaceArtwork,
    version: OPENCODE_CURSOR_THEME_VERSION,
    CANVAS,
    DISPLAY_SIZE,
    HOTSPOT,
    DEFAULT_FILL,
    SESSION_FILLS,
    ACTION_IDS,
    ACTIONS,
    sessionColor,
    mix,
    cssColor,
    rgba,
    pointerPath: POINTER_PATH,
    pointerMarkup,
    cueMarkup,
    actionMotion,
    staticProgress,
    chipGlyph,
  };
}
