type Color = [number, number, number];

// Executed in the isolated world. Read only computed colors, never page content,
// images, screenshots, or storage. Do not insert nodes or modify page styles.
export function readPageColors(): string[] {
  const colors: string[] = [];
  const add = (element: Element | null) => {
    if (element && colors.length < 8) colors.push(getComputedStyle(element).backgroundColor);
  };
  add(document.body);
  add(document.documentElement);
  for (const [x, y] of [[.75, .15], [.5, .5], [.9, .8]] as const) {
    let element = document.elementFromPoint(innerWidth * x, innerHeight * y);
    for (let depth = 0; element && depth < 2; depth++, element = element.parentElement) add(element);
  }
  return colors;
}

export function popupPalette(input: unknown): { background: string; dark: boolean } | null {
  if (!Array.isArray(input)) return null;
  const colors: Color[] = [];
  for (const value of input.slice(0, 8)) {
    if (typeof value !== "string" || value.length > 80) continue;
    const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(value);
    if (!match) continue;
    const channels = match.slice(1, 4).map(Number);
    const alpha = match[4] === undefined ? 1 : Number(match[4]);
    if (channels.some(c => !Number.isFinite(c) || c < 0 || c > 255) || !Number.isFinite(alpha) || alpha < .5 || alpha > 1) continue;
    colors.push(channels as Color);
  }
  const base = colors[0];
  if (!base) return null;
  const luminance = base.map(c => { const v = c / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }) as Color;
  const dark = luminance[0] * .2126 + luminance[1] * .7152 + luminance[2] * .0722 < .25;
  // Keep the canvas inside a narrow luminance range, regardless of site colors.
  // The text palette and opaque accessibility surfaces change together.
  const anchor: Color = dark ? [23, 32, 51] : [255, 255, 255];
  const indices = [0, 1, 2] as const;
  const tint = indices.map(i => Math.round(anchor[i] * .9 + colors.reduce((sum, c) => sum + c[i], 0) / colors.length * .1));
  return { background: `rgb(${tint.join(" ")})`, dark };
}
