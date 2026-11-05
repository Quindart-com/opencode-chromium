import { expect, test } from "bun:test";
import { popupPalette, readPageColors } from "../../extension-src/entrypoints/popup/page-palette";

test("page colors are bounded and cannot inject CSS", () => {
  for (const value of [null, {}, ["url(https://example.com)"], ["rgb(999 0 0)"], ["rgba(0,0,0,0)"], ["rgb(NaN 1 2)"]]) expect(popupPalette(value)).toBeNull();
  expect(popupPalette(Array(8).fill("invalid").concat("rgb(0 0 0)"))).toBeNull();
  expect(popupPalette(["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"])?.dark).toBe(false);
});

test("bright and dark page colors remain inside safe canvas ranges", () => {
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
    const palette = popupPalette([`rgb(${r} ${g} ${b})`])!;
    const channels = palette.background.match(/\d+/g)!.map(Number);
    for (const channel of channels) expect(palette.dark ? channel <= 72 : channel >= 229).toBe(true);
    const linear = (v: number) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
    const luminance = (c: number[]) => c.reduce((sum, v, i) => sum + linear(v) * [ .2126, .7152, .0722 ][i]!, 0);
    const background = luminance(channels), foreground = luminance(palette.dark ? [180, 195, 219] : [82, 97, 123]);
    expect((Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05)).toBeGreaterThanOrEqual(4.5);
  }
});

test("page probe reads only bounded computed background colors", () => {
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  let reads = 0;
  const node = { parentElement: null };
  Object.assign(globalThis, {
    document: { body: node, documentElement: node, elementFromPoint: () => node },
    innerWidth: 1000, innerHeight: 800,
    getComputedStyle: () => { reads++; return { backgroundColor: "rgb(12, 34, 56)" }; },
  });
  try {
    const result = readPageColors();
    expect(result).toEqual(Array(5).fill("rgb(12, 34, 56)"));
    expect(reads).toBeLessThanOrEqual(8);
  } finally {
    for (const key of ["document", "innerWidth", "innerHeight", "getComputedStyle"]) {
      if (originals[key]) Object.defineProperty(globalThis, key, originals[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
