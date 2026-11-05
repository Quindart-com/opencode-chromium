import { browser } from "wxt/browser";
import { popupPalette, readPageColors } from "./page-palette";

export async function applyPagePalette(): Promise<void> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//i.test(tab.url ?? "")) return;
    const results = await browser.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: readPageColors });
    const palette = popupPalette(results[0]?.result);
    if (!palette) return;
    document.documentElement.style.setProperty("--page-canvas", palette.background);
    document.documentElement.dataset.popupTheme = palette.dark ? "dark" : "light";
  } catch {
    // Browser-internal pages and sites without script access use the base palette.
  }
}
