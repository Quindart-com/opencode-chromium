export const publicPackages = ["react", "typescript", "lodash"] as const;
export type PublicPackage = typeof publicPackages[number];
export type PackageField = "version" | "license";
export function packageResource(url: string): PublicPackage | null {
  for (const name of publicPackages) {
    const page = "https://www.npmjs.com/package/" + name;
    if (url === page || url === page + "/") return name;
  }
  return null;
}
export function packageField(label: string): PackageField | null {
  const match = /^(?:(?:get|read|show|what is) (?:the )?)?(?:(?:current|latest|package) )?(version|license)(?: of this package)?\??$/.exec(label.trim().toLowerCase());
  return match ? match[1] as PackageField : null;
}
export async function readPackage(name: PublicPackage, field: PackageField, revision: "latest" | "18.2.0" | "5.0.4" = "latest", request = fetch) {
  if (!publicPackages.includes(name) || !["version", "license"].includes(field) || !["latest", "18.2.0", "5.0.4"].includes(revision)) throw Error("SITE_TASK_UNSUPPORTED");
  const response = await request("https://registry.npmjs.org/" + name + "/" + revision, {
    credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Object.assign(Error("SITE_PROVIDER_UNAVAILABLE"), { status: response.status, retryAfter: response.headers.get("retry-after") });
  const reader = response.body?.getReader();
  if (!reader) throw Error("SITE_SCHEMA_MISMATCH");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 131072) throw Error("SITE_RESPONSE_TOO_LARGE");
      text += decoder.decode(part.value, { stream: true });
    }
  } finally { await reader.cancel(); }
  const manifest = JSON.parse(text + decoder.decode());
  if (manifest?.name !== name || (revision !== "latest" && manifest.version !== revision)) throw Error("SITE_RESOURCE_MISMATCH");
  const value = manifest[field];
  const form = field === "version" ? /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/ : /^[A-Za-z0-9() .+-]+$/;
  if (typeof value !== "string" || !value.length || value.length > 96 || !form.test(value)) throw Error("SITE_SCHEMA_MISMATCH");
  return { name, [field]: value };
}
export async function verifyPackage(field: PackageField, request = fetch) {
  for (const [name, revision, license] of [["react", "18.2.0", "MIT"], ["typescript", "5.0.4", "Apache-2.0"]] as const) {
    const value = await readPackage(name, field, revision, request);
    if (value[field] !== (field === "license" ? license : revision)) throw Error("SITE_REFERENCE_MISMATCH");
  }
}
