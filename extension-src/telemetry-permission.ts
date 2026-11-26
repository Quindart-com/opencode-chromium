/** Firefox's technical-data choice is independent of the diagnostics preference. */
export async function telemetryPermission(isFirefox: boolean, getAll: () => Promise<unknown>): Promise<boolean> {
  if (!isFirefox) return true;
  try {
    const permissions = await getAll();
    if (!permissions || typeof permissions !== "object" || !("data_collection" in permissions)) return false;
    const data = permissions.data_collection;
    return Array.isArray(data) && data.includes("technicalAndInteraction");
  } catch { return false; }
}
