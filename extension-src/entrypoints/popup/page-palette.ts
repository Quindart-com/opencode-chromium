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

export function popupPalette(input: unknown): { background: string; solid: string; dark: boolean } | null {
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
  const luminance = (color: Color) => color.reduce((sum, c, i) => {
    const v = c / 255;
    return sum + (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) * ([.2126, .7152, .0722] as const)[i]!;
  }, 0);
  const dark = luminance(base) < .25;
  // Preserve the page's hue, including neutral black/gray. Adjust brightness
  // only when contrast requires it; never mix in a fixed brand-colored canvas.
  let canvas: Color = [...base];
  for (let attempt = 0; attempt < 100 && (dark ? luminance(canvas) > .025 : luminance(canvas) < .82); attempt++) {
    canvas = canvas.map(c => Math.round(dark ? c * .95 : c + (255 - c) * .05)) as Color;
  }
  const solid = canvas.map(c => Math.round(c + (255 - c) * (dark ? .06 : .2)));
  return { background: `rgb(${canvas.join(" ")})`, solid: `rgb(${solid.join(" ")})`, dark };
}
