type RGB = [number, number, number];
type RGBA = [number, number, number, number];
export type GlassPalette = { ink: RGBA; muted: RGBA; control: RGBA; success: RGBA; glass: RGBA; field: RGBA };
const mix = (front: RGBA, back: RGB): RGB => front.slice(0, 3).map((channel, index) => channel * front[3] + back[index]! * (1 - front[3])) as RGB;
const luminance = (color: RGB) => color.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index]!, 0);
const ratio = (a: RGB, b: RGB) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };

/** Check the actual transparent material states, including the white active tab. */
export function readableGlass(background: RGB, palette: GlassPalette): boolean {
  if (![...background, ...Object.values(palette).flat()].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return false;
  const shell = mix(palette.glass, background), card = mix(palette.glass, shell);
  const text = [shell, card].every(surface => [palette.ink, palette.muted, palette.success].every(ink => ratio(mix(ink, surface), surface) >= 4.5));
  return text && [mix(palette.glass, card), mix(palette.field, card), mix([1, 1, 1, .3], shell)].every(surface => ratio(mix(palette.control, surface), surface) >= 4.5);
}

/** Unknown color spaces choose a solid fallback; no pixel/fingerprinting APIs. */
export function parseMaterialColor(value: string): RGBA | null {
  value = value.trim();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return [1, 3, 5, 7].map((start, index) => index === 3 && value.length === 7 ? 1 : Number.parseInt(value.slice(start, start + 2), 16) / 255) as RGBA;
  const srgb = value.startsWith("color(srgb ");
  const match = value.match(srgb ? /^color\(srgb (.*)\)$/ : /^rgba?\((.*)\)$/);
  if (!match) return null;
  const parts = match[1]!.replace(/[,/]/g, " ").trim().split(/\s+/);
  if (parts.length !== 3 && parts.length !== 4) return null;
  if (!parts.every(part => /^(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(part))) return null;
  const parsed = parts.map((part, index) => Number.parseFloat(part) / (part.endsWith("%") ? 100 : index === 3 || srgb ? 1 : 255));
  if (parsed.length === 3) parsed.push(1);
  return parsed.every(part => Number.isFinite(part) && part >= 0 && part <= 1) ? parsed as RGBA : null;
}

/** Conservative CSS-color sampling, not a pixel/photograph contrast guarantee. */
export function needsSolidMaterial(host: HTMLElement): boolean {
  if (!CSS.supports("backdrop-filter", "blur(1px)")) return true;
  const viewport = window.visualViewport;
  if ((viewport?.width ?? innerWidth) < 480) return true;
  const style = getComputedStyle(host);
  const values = ["--ink", "--muted", "--control-ink", "--success", "--glass", "--field"].map(name => parseMaterialColor(style.getPropertyValue(name)));
  if (values.some(value => !value)) return true;
  const palette: GlassPalette = { ink: values[0]!, muted: values[1]!, control: values[2]!, success: values[3]!, glass: values[4]!, field: values[5]! };
  const bounds = host.getBoundingClientRect(), height = bounds.height || innerHeight - 36;
  for (const x of [.15, .5, .85]) for (const y of [.1, .5, .9]) {
    const px = Math.max(0, Math.min(innerWidth - 1, bounds.left + bounds.width * x));
    const py = Math.max(0, Math.min(innerHeight - 1, bounds.top + height * y));
    const element = document.elementsFromPoint(px, py).find(item => item !== host);
    if (!element) return true;
    const layers: RGBA[] = [];
    for (let node: Element | null = element, depth = 0; node; node = node.parentElement, depth++) {
      if (depth >= 32) return true;
      const behind = getComputedStyle(node);
      if (/^(IMG|SVG|CANVAS|VIDEO|IFRAME)$/.test(node.tagName.toUpperCase()) || behind.backgroundImage !== "none" || behind.filter !== "none" || behind.mixBlendMode !== "normal" || Number(behind.opacity) !== 1 || behind.animationName !== "none") return true;
      const fill = parseMaterialColor(behind.backgroundColor);
      if (!fill) return true;
      layers.push(fill);
      if (fill[3] === 1) break;
    }
    const background = layers.toReversed().reduce<RGB>((back, layer) => mix(layer, back), [1, 1, 1]);
    if (!readableGlass(background, palette)) return true;
  }
  return false;
}
