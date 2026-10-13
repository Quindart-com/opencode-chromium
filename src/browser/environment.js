const NETWORK_PRESETS = Object.freeze({
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  "slow-2g": { offline: false, latency: 2000, downloadThroughput: 250 * 1024 / 8, uploadThroughput: 50 * 1024 / 8 },
  "slow-3g": { offline: false, latency: 1500, downloadThroughput: 400 * 1024 / 8, uploadThroughput: 400 * 1024 / 8 },
  "fast-3g": { offline: false, latency: 560, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 },
  "slow-4g": { offline: false, latency: 170, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 },
  online: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
});

function networkConditions(value) {
  if (typeof value === "string") return NETWORK_PRESETS[value] ?? NETWORK_PRESETS.online;
  return { offline: value.offline ?? false, latency: value.latency ?? 0,
    downloadThroughput: value.downloadThroughput ?? -1, uploadThroughput: value.uploadThroughput ?? -1 };
}

// Bookkeeping is keyed by the caller's session, profile, and tab. A reset never
// removes another session's preload scripts or changes untracked overrides.
export function createEnvironmentController({ command, backend, keyFor, enableNetwork = (context, tabId) => command(context, tabId, "Network.enable", {}) }) {
  const records = new Map();
  return {
    async apply(context, tabId, env) {
      if (await backend.configure(context, tabId, env)) return;
      const key = await keyFor(context, tabId);
      const record = records.get(key) ?? { fields: new Set(), scripts: new Set() };
      records.set(key, record);
      if (env.network !== undefined || env.headers !== undefined) await enableNetwork(context, tabId);
      const apply = async (field, method, params) => {
        // Preserve cleanup intent if dispatch succeeds but its response is lost.
        record.fields.add(field);
        return command(context, tabId, method, params);
      };
      if (env.viewport) {
        await apply("viewport", "Emulation.setDeviceMetricsOverride", {
          width: env.viewport.width, height: env.viewport.height,
          deviceScaleFactor: env.viewport.deviceScaleFactor ?? 1, mobile: env.viewport.mobile ?? false,
        });
        if (env.viewport.touch !== undefined) await apply("touch", "Emulation.setTouchEmulationEnabled", { enabled: env.viewport.touch });
      }
      if (env.cpuThrottling !== undefined) await apply("cpuThrottling", "Emulation.setCPUThrottlingRate", { rate: env.cpuThrottling });
      if (env.network !== undefined) await apply("network", "Network.emulateNetworkConditions", networkConditions(env.network));
      if (env.geolocation) await apply("geolocation", "Emulation.setGeolocationOverride", {
        latitude: env.geolocation.latitude, longitude: env.geolocation.longitude, accuracy: env.geolocation.accuracy ?? 0,
      });
      if (env.colorScheme) await apply("colorScheme", "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: env.colorScheme }] });
      if (env.userAgent !== undefined) await apply("userAgent", "Emulation.setUserAgentOverride", { userAgent: env.userAgent });
      if (env.headers !== undefined) await apply("headers", "Network.setExtraHTTPHeaders", { headers: env.headers });
      if (env.initScripts?.length) {
        record.pendingPreloads = (record.pendingPreloads ?? 0) + 1;
        const result = await command(context, tabId, "Page.addScriptToEvaluateOnNewDocument", { source: env.initScripts.join("\n") });
        if (typeof result?.identifier !== "string") throw new Error("Browser did not return the preload script identifier required for cleanup");
        record.scripts.add(result.identifier);
        record.pendingPreloads--;
      }
    },
    async reset(context, tabId) {
      if (await backend.reset(context, tabId)) return;
      const key = await keyFor(context, tabId);
      const record = records.get(key);
      if (!record) return;
      const errors = [];
      if (record.fields.has("network") || record.fields.has("headers")) {
        try { await enableNetwork(context, tabId); } catch (error) { errors.push(error); }
      }
      for (const identifier of record.scripts) {
        try {
          await command(context, tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier });
          record.scripts.delete(identifier);
        } catch (error) { errors.push(error); }
      }
      const resets = {
        viewport: ["Emulation.clearDeviceMetricsOverride", {}],
        touch: ["Emulation.setTouchEmulationEnabled", { enabled: false }],
        cpuThrottling: ["Emulation.setCPUThrottlingRate", { rate: 1 }],
        network: ["Network.emulateNetworkConditions", NETWORK_PRESETS.online],
        colorScheme: ["Emulation.setEmulatedMedia", {}],
        geolocation: ["Emulation.clearGeolocationOverride", {}],
        userAgent: ["Emulation.setUserAgentOverride", { userAgent: "" }],
        headers: ["Network.setExtraHTTPHeaders", { headers: {} }],
      };
      for (const field of record.fields) {
        const [method, params] = resets[field];
        try {
          await command(context, tabId, method, params);
          record.fields.delete(field);
        } catch (error) { errors.push(error); }
      }
      if (record.pendingPreloads) errors.push(new Error("A preload script was not acknowledged; close the affected tab before finalization because its cleanup cannot be verified"));
      if (!record.fields.size && !record.scripts.size && !record.pendingPreloads) records.delete(key);
      if (errors.length) throw new AggregateError(errors, record.pendingPreloads ? "Browser environment cleanup cannot be verified; close the affected tab before finalization" : "Browser environment cleanup failed; retry reset before handing off the tab");
    },
    forgetSession(prefix) {
      for (const key of records.keys()) if (key.startsWith(prefix)) records.delete(key);
    },
  };
}
