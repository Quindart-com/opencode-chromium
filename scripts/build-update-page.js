import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const escape = text => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
export function releaseNotesHtml(directory) {
  return fs.readdirSync(directory).filter(file => /^\d+\.\d+\.\d+\.md$/.test(file)).sort((a, b) => {
    const first = a.split(".").map(Number), second = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (first[i] !== second[i]) return second[i] - first[i];
    return 0;
  }).map(file => {
    const version = file.slice(0, -3);
    const items = fs.readFileSync(path.join(directory, file), "utf8").split(/\r?\n/).filter(line => line.startsWith("- ")).map(line => `<li>${escape(line.slice(2)).replace(/`([^`]+)`/g, "<code>$1</code>")}</li>`);
    if (!items.length) return `<article id="v${version}"><h2>Version ${version}</h2><p><a href="https://github.com/Quindart-com/opencode-chromium/blob/master/docs/releases/${file}">Read the version ${version} release notes</a></p></article>`;
    return `<article id="v${version}"><h2><a href="#v${version}">Version ${version}</a></h2><ul>${items.slice(0, 4).join("")}</ul>${items.length > 4 ? `<details><summary>All ${items.length} changes</summary><ul>${items.slice(4).join("")}</ul></details>` : ""}</article>`;
  }).join("\n");
}
export function buildUpdatePage() {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (!fs.existsSync(path.join(root, "docs/releases", `${version}.md`))) throw new Error("Missing current release notes");
  fs.mkdirSync(path.join(root, "docs/_includes"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/_includes/release-notes.html"), releaseNotesHtml(path.join(root, "docs/releases")));
  fs.copyFileSync(path.join(root, "assets/logo.svg"), path.join(root, "docs/updates/logo.svg"));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildUpdatePage();
