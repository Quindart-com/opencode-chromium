import { expect,test } from "bun:test";
import { parseMaterialColor,readableGlass,type GlassPalette } from "../../extension-src/page-panel/material-safety.ts";

const color = (value: string) => parseMaterialColor(value)!;
const light: GlassPalette = { ink: color("#172033"), muted: color("#43516A"), control: color("#172033"), success: color("#1D6B49"), glass: color("rgb(255 255 255 / .1)"), field: color("rgb(255 255 255 / .12)") };
const dark: GlassPalette = { ink: color("#F2F5FC"), muted: color("#BDCAE0"), control: color("#F3F5FC"), success: color("#96D6AF"), glass: color("rgb(22 34 56 / .1)"), field: color("rgb(22 34 56 / .12)") };

test("glass stays available on matching light and dark page backgrounds", () => {
  expect(readableGlass([1, 1, 1], light)).toBe(true);
  expect(readableGlass([.07, .1, .15], dark)).toBe(true);
});
test("transparent foregrounds choose a solid fallback on incompatible backdrops", () => {
  expect(readableGlass([0, 0, 0], light)).toBe(false);
  expect(readableGlass([1, 1, 1], dark)).toBe(false);
  expect(readableGlass([.5, .5, .5], dark)).toBe(false);
});
test("invalid color channels cannot establish safe contrast", () => {
  expect(readableGlass([NaN, 1, 1], light)).toBe(false);
  expect(readableGlass([1, 1, 1], { ...light, ink: [0, 0, 0, 0] })).toBe(false);
});
test("CSS color parsing supports legacy, modern and sRGB notation without pixel reads", () => {
  expect(color("rgba(255, 0, 128, 0.5)")).toEqual([1, 0, 128 / 255, .5]);
  expect(color("rgb(100% 0% 50% / 25%)")).toEqual([1, 0, .5, .25]);
  expect(color("color(srgb 1 0 .5 / .25)")).toEqual([1, 0, .5, .25]);
  expect(color("#ffffff80")).toEqual([1, 1, 1, 128 / 255]);
});
test("unsupported color spaces and malformed CSS select the conservative fallback", () => {
  for (const value of ["color(display-p3 1 0 0)", "CanvasText", "rgb(255 bad 0)", "rgb(0.5garbage 0 0)", "rgb(256 0 0)"]) expect(parseMaterialColor(value)).toBeNull();
});
