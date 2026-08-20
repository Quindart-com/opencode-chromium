(() => {
  const $ = (id) => document.getElementById(id);
  const MB = 1024 * 1024;

  let settings = null;

  async function memoryCall(method, params = {}) {
    const response = await chrome.runtime.sendMessage({ type: "MEMORY_CALL", method, params });
    if (!response?.ok) throw new Error(response?.error ?? `${method} failed`);
    return response.result;
  }

  function formatBytes(bytes) {
    const units = ["B", "KiB", "MiB", "GiB"];
    let value = Number(bytes) || 0;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function setHealth(status) {
    const pill = $("health-pill");
    pill.textContent = status.health ?? "unknown";
    pill.className = `pill ${status.health === "ready" ? "pill-ok" : ["paused", "disabled"].includes(status.health) ? "pill-warn" : "pill-bad"}`;
  }

  function showError(error) {
    $("capture-note").textContent = error instanceof Error ? error.message : String(error);
  }

  async function refreshStatus() {
    try {
      settings = await memoryCall("memory.stats");
    } catch (error) {
      settings = null;
      showError(error);
      return;
    }
    setHealth(settings);
    $("capture-note").textContent = settings.enabled
      ? `Capture is ${settings.paused ? "paused" : "enabled"} — ${settings.counts.signatures} signatures, ${settings.counts.chains} chains, ${settings.counts.failure_contexts} negative lessons.`
      : "Capture is off. Enable it to start building action memory.";
    $("quota-slider").value = Math.round(Number(settings.quota_bytes) / MB / 100) * 100;
    $("quota-value").textContent = formatBytes(settings.quota_bytes);
    $("power-user").checked = settings.power_user === true;
    $("purge-days").value = settings.purge_days;
    renderDashboard(settings);
  }

  function renderDashboard(status) {
    const total = status.counts.confirmed_total + status.counts.failed_total;
    const rate = total > 0 ? Math.round((status.counts.confirmed_total / total) * 100) : 100;
    $("success-badge").textContent = `${rate}%`;
    $("hero-line").textContent = total > 0
      ? `${status.counts.confirmed_total} confirmed actions out of ${total} — your memory keeps the routes that work.`
      : "No actions recorded yet. Run your first automation and come back — success builds your memory.";
    $("stat-signatures").textContent = status.counts.signatures;
    $("stat-chains").textContent = status.counts.chains;
    $("stat-negatives").textContent = status.counts.failure_contexts;
    $("stat-hits").textContent = status.memory_hits;
    $("quota-usage").textContent = `${formatBytes(status.bytes_used)} of ${formatBytes(status.quota_bytes)} used`;
    const fill = Math.min(100, (status.bytes_used / Math.max(1, Number(status.quota_bytes))) * 100);
    $("quota-fill").style.width = `${fill}%`;
    renderChart(status);
  }

  function renderChart(status) {
    const container = $("chart");
    const empty = $("chart-empty");
    const points = dailySeries(status);
    if (points.length === 0) {
      container.replaceChildren();
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";
    container.replaceChildren(buildChart(points));
  }

  function dailySeries(status) {
    const days = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let offset = 13; offset >= 0; offset -= 1) {
      const day = new Date(today);
      day.setDate(day.getDate() - offset);
      days.push({ label: day.toLocaleDateString(undefined, { month: "short", day: "numeric" }), key: day.toISOString().slice(0, 10), confirmed: 0, failed: 0, signatures: 0 });
    }
    const byDay = new Map(days.map((day) => [day.key, day]));
    for (const event of status.recent_daily ?? []) {
      const day = byDay.get(String(event.day));
      if (day) {
        day.confirmed = event.confirmed;
        day.failed = event.failed;
        day.signatures = event.signatures;
      }
    }
    return days;
  }

  function buildChart(points) {
    const width = Math.max(560, points.length * 54);
    const height = 180;
    const pad = 30;
    const maxValue = Math.max(1, ...points.map((point) => point.confirmed + point.failed));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Confirmed versus failed actions per day");

    const plotWidth = width - pad * 2;
    const plotHeight = height - pad * 2;

    points.forEach((point, index) => {
      const x = pad + (index / Math.max(1, points.length - 1)) * plotWidth;
      const total = point.confirmed + point.failed;
      if (total === 0) return;

      const confirmedHeight = (point.confirmed / maxValue) * plotHeight;
      const failedHeight = (point.failed / maxValue) * plotHeight;
      const barWidth = Math.min(34, plotWidth / points.length * 0.6);

      const failedRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      failedRect.setAttribute("x", x - barWidth / 2);
      failedRect.setAttribute("y", pad + plotHeight - failedHeight);
      failedRect.setAttribute("width", barWidth);
      failedRect.setAttribute("height", failedHeight);
      failedRect.setAttribute("fill", "#cf222e");
      failedRect.setAttribute("opacity", "0.75");

      const confirmedRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      confirmedRect.setAttribute("x", x - barWidth / 2);
      confirmedRect.setAttribute("y", pad + plotHeight - failedHeight - confirmedHeight);
      confirmedRect.setAttribute("width", barWidth);
      confirmedRect.setAttribute("height", confirmedHeight);
      confirmedRect.setAttribute("fill", "#1a7f37");
      confirmedRect.setAttribute("rx", 2);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", x);
      label.setAttribute("y", height - 8);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", "9");
      label.setAttribute("fill", "#59636e");
      label.textContent = point.label;

      svg.append(confirmedRect, failedRect, label);
    });
    return svg;
  }

  function wireButtons() {
    const action = async (method, label) => {
      try {
        await memoryCall(method);
        await refreshStatus();
        $("capture-note").textContent = `Memory ${label}.`;
      } catch (error) {
        showError(error);
      }
    };
    $("memory-enable").addEventListener("click", () => action("memory.enable", "enabled"));
    $("memory-disable").addEventListener("click", () => action("memory.disable", "disabled"));
    $("memory-pause").addEventListener("click", () => action("memory.pause", "paused"));
    $("memory-resume").addEventListener("click", () => action("memory.resume", "resumed"));
    $("prune-now").addEventListener("click", async () => {
      try {
        const result = await memoryCall("memory.prune", {});
        $("capture-note").textContent = `Pruned ${result.removed} aged and ${result.evicted} evicted negative lessons.`;
        await refreshStatus();
      } catch (error) {
        showError(error);
      }
    });
    $("export-json").addEventListener("click", async () => {
      const payload = await memoryCall("memory.export");
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `action-memory-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
    $("import-json").addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        const result = await memoryCall("memory.import", payload);
        $("share-note").textContent = `Imported ${result.imported} signatures.`;
        await refreshStatus();
      } catch (error) {
        $("share-note").textContent = `Import failed: ${error instanceof Error ? error.message : error}`;
      }
    });
    $("quota-slider").addEventListener("change", async (event) => {
      try {
        await memoryCall("memory.configure", { quota_bytes: Number(event.target.value) * MB });
        await refreshStatus();
      } catch (error) {
        showError(error);
      }
    });
    $("power-user").addEventListener("change", async (event) => {
      try {
        await memoryCall("memory.configure", { power_user: event.target.checked });
        await refreshStatus();
      } catch (error) {
        showError(error);
      }
    });
    $("purge-days").addEventListener("change", async (event) => {
      try {
        await memoryCall("memory.configure", { purge_days: Number(event.target.value) });
        await refreshStatus();
      } catch (error) {
        showError(error);
      }
    });
  }

  function wireTabs() {
    const tabs = document.querySelectorAll(".tab");
    for (const tab of tabs) {
      tab.addEventListener("click", () => {
        for (const other of tabs) other.classList.remove("active");
        tab.classList.add("active");
        $("panel-maintenance").classList.toggle("active", tab.id === "tab-maintenance");
        $("panel-dashboard").classList.toggle("active", tab.id === "tab-dashboard");
      });
    }
  }

  function init() {
    wireTabs();
    wireButtons();
    void refreshStatus();
    chrome.runtime.onMessage?.addListener?.((message) => {
      if (message?.kind === "MEMORY_CHANGED") void refreshStatus();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();