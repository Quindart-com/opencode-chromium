// Which semantic cursor animation a tool or step represents, and the targets
// that should move the cursor before the action lands.
//
// The cursor itself is rendered by the extension (cursor.js)
// from the artwork in cursor-theme.js. This module owns only
// the mapping from our own tool and step vocabulary to that artwork's action
// ids, so a tool rename never silently stops animating.

import type { CursorAction } from "../shared/cursor-actions.ts";
import { CURSOR_ACTIONS } from "../shared/cursor-actions.ts";

const TOOL_ACTIONS: Partial<Record<CursorAction, string[]>> = {
  observe: ["browser_page_search", "browser_page_inspect", "browser_visual_map", "browser_dom_snapshot", "browser_snapshot",
    "browser_screenshot", "browser_get_tab", "browser_list_tabs", "browser_selected_tab", "browser_list_profiles",
    "browser_selected_profile", "browser_status", "browser_capabilities", "browser_history", "browser_console_logs",
    "browser_network_events", "browser_download_events", "browser_clear_events", "browser_clear_download_events",
    "browser_dialog_events", "browser_locator_count", "browser_locator_text", "browser_clipboard_read_text",
    "browser_enable_inspection", "browser_cdp"],
  click: ["browser_click", "browser_double_click", "browser_dom_click", "browser_locator_click"],
  drag: ["browser_drag"],
  scroll: ["browser_scroll"],
  text: ["browser_type", "browser_dom_type", "browser_locator_fill", "browser_clipboard_write_text"],
  key: ["browser_keypress"],
  navigate: ["browser_move", "browser_navigate", "browser_back", "browser_forward", "browser_reload", "browser_new_tab",
    "browser_close_tab", "browser_claim_tab"],
  transfer: ["browser_finalize"],
  record: ["browser_trace_record", "browser_trace_analyze"],
  system: ["browser_configure", "browser_select_profile", "browser_name_session", "browser_turn_end", "browser_handle_dialog"],
};

const STEP_ACTIONS: Readonly<Record<string, CursorAction>> = {
  find: "observe", assert: "observe", screenshot: "observe", search: "observe", inspect: "observe", visual: "observe",
  extract: "observe", events: "observe", downloads: "observe", clipboardRead: "observe",
  click: "click", doubleClick: "click", drag: "drag", scroll: "scroll", type: "text", fill: "text",
  replaceText: "text", fillForm: "text", press: "key", navigate: "navigate", back: "navigate", forward: "navigate",
  reload: "navigate", newTab: "navigate", close: "navigate", upload: "transfer", transfer: "transfer",
  record: "record", capability: "system",
};

const LOOKUP = new Map<string, CursorAction>();
for (const action of CURSOR_ACTIONS) for (const name of TOOL_ACTIONS[action] ?? []) LOOKUP.set(name, action);

export function cursorActionForTool(name: string) {
  return LOOKUP.get(name) ?? null;
}

export function cursorActionForStep(action: string) {
  return STEP_ACTIONS[action] ?? null;
}

export function isCursorAction(action: unknown): action is CursorAction {
  return typeof action === "string" && CURSOR_ACTIONS.some(value => value === action);
}

export function cursorPoint(target: { x?: unknown; y?: unknown } | null | undefined) {
  if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) return { x: Number(target.x), y: Number(target.y) };
  return null;
}
