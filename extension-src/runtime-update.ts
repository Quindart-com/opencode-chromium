export const runtimeSetupCommand = "npx -y opencode-chromium@latest setup --all";

export function requiresRuntimeSetup(value: { state?: string; code?: string; controllerSupported?: boolean } | null | undefined) {
  return value?.controllerSupported === false || [value?.state, value?.code].some(code =>
    code === "bridge_required" || code === "reconnect_required" || code === "unmanaged_runtime");
}
