export const CURSOR_ACTIONS = ["idle", "observe", "click", "drag", "scroll", "text", "key", "navigate", "app", "transfer", "record", "system"] as const;
export type CursorAction = typeof CURSOR_ACTIONS[number];
