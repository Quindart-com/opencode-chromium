// Runs in the renderer. Bound the composited text contrast over both black and
// white webpages; merely comparing an alpha fill with a foreground misses this.
export function glassTextContrast(element, backdrops = [[0, 0, 0], [1, 1, 1]]) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = value => {
    context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data].map(channel => channel / 255);
  };
  const blend = (front, back) => front.slice(0, 3).map((channel, index) => channel * front[3] + back[index] * (1 - front[3]));
  const luminance = color => color.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const layers = [];
  for (let node = element; node; node = node.parentElement ?? node.getRootNode().host) {
    // Explicit backdrops describe the body's painted image/gradient, not just its
    // fallback backgroundColor; stop before that color can conceal those samples.
    if (node === document.body || node === document.documentElement) break;
    layers.push(rgba(getComputedStyle(node).backgroundColor));
    if (node.id.startsWith('opencode-page-panel-')) break;
  }
  const foreground = rgba(getComputedStyle(element).color);
  return Math.min(...backdrops.map(base => {
    const background = layers.toReversed().reduce((color, layer) => blend(layer, color), base);
    const text = luminance(blend(foreground, background)), surface = luminance(background);
    return (Math.max(text, surface) + .05) / (Math.min(text, surface) + .05);
  }));
}
