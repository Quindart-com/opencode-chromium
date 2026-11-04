import { browser } from "wxt/browser";
import { installPagePanel } from "../page-panel/controller.tsx";

export default defineUnlistedScript(() => {
  const scope = globalThis as typeof globalThis & { __opencodePagePanelDispose?: () => void };
  scope.__opencodePagePanelDispose?.();
  scope.__opencodePagePanelDispose = installPagePanel(browser);
});
