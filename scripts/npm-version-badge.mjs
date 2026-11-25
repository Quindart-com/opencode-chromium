// Serve the README badge from the repository. Use npm's published version as
// the source so a release updates the badge even if the image service is down.
import { writeFile } from "node:fs/promises";

const name = "opencode-chromium";
const response = await fetch(`https://registry.npmjs.org/${name}/latest`, {
  headers: { Accept: "application/json" },
  signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
const metadata = await response.json();
if (metadata?.name !== name || typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
  throw new Error("npm registry returned invalid release metadata");
}

const label = `v${metadata.version}`;
const labelWidth = Math.max(45, Math.ceil(label.length * 5.8) + 10);
const width = 35 + labelWidth;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="npm: ${label}">
  <title>npm: ${label}</title>
  <clipPath id="badge"><rect width="${width}" height="20" rx="3"/></clipPath>
  <g clip-path="url(#badge)"><rect width="35" height="20" fill="#555"/><rect x="35" width="${labelWidth}" height="20" fill="#2563eb"/></g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana, Geneva, sans-serif" font-size="11">
    <text x="17.5" y="14">npm</text><text x="${35 + labelWidth / 2}" y="14">${label}</text>
  </g>
</svg>
`;
await writeFile(new URL("../assets/npm-version.svg", import.meta.url), svg);
