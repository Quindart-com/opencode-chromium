// Cursor overlay state shared by the background runtime and the injected
// content scripts. The artwork lives in cursor-theme.js; this
// module only decides which cursor a message belongs to, what label it carries
// and which semantic action is playing.

export const CURSOR_SCRIPTS: ["/cursor-theme.js", "/cursor.js"] = ["/cursor-theme.js", "/cursor.js"];

import type { CursorAction } from "../../../src/shared/cursor-actions.ts";
export type { CursorAction } from "../../../src/shared/cursor-actions.ts";
export interface CursorIdentity { cursorId?: string; cursor_id?: string; session_id?: string; sessionId?: string }
export interface GestureStep {
  method: string;
  commandParams?: { text?: string; type?: string; buttons?: number };
  command_params?: { text?: string; type?: string; buttons?: number };
}
export interface CursorState {
  x: number;
  y: number;
  visible: boolean;
  moveSequence: number;
  cursorId: string;
  label: string;
  action?: CursorAction;
}

const GESTURE_ACTIONS: Readonly<Record<string, CursorAction>> = {
  "Input.insertText": "text",
  "Input.dispatchTouchEvent": "click",
};

export function cursorIdFromParams(params: CursorIdentity = {}): string {
  const id = params.cursorId ?? params.cursor_id ?? params.session_id ?? params.sessionId;
  return typeof id === "string" && id.length > 0 ? id : "default";
}

// A gesture batch is already expressed as CDP input, so the animation follows
// what the browser is actually asked to do. Drag is inferred from the pointer
// still being held down when the move is dispatched.
export function gestureAction(step: GestureStep | undefined, held = false): CursorAction | null {
  const method = step?.method;
  if (!method) return null;
  const action = GESTURE_ACTIONS[method];
  if (action) return action;
  if (method === "Input.dispatchKeyEvent") {
    const params = step?.commandParams ?? step?.command_params ?? {};
    return typeof params.text === "string" && params.text.length > 0 ? "text" : "key";
  }
  if (method !== "Input.dispatchMouseEvent") return null;
  const params = step?.commandParams ?? step?.command_params ?? {};
  if (params.type === "mouseWheel") return "scroll";
  if (params.type === "mouseMoved") return held && (params.buttons ?? 0) > 0 ? "drag" : null;
  if (params.type === "mousePressed" || params.type === "mouseReleased") return held && (params.buttons ?? 0) > 0 ? "drag" : "click";
  return null;
}

export function cursorLabel(session: { name?: string | null } | null | undefined, cursorId: string): string {
  const explicit = typeof session?.name === "string" && session.name.trim() ? session.name : null;
  if (explicit) return explicit;
  const id = cursorId === "default" ? "opencode" : cursorId;
  return id.length > 28 ? `${id.slice(0, 24)}…` : id;
}

export function cursorState({ cursorId, session, x, y, visible, moveSequence, action }: {
  cursorId: string;
  session?: { name?: string | null } | null;
  x: number;
  y: number;
  visible?: boolean;
  moveSequence: number;
  action?: CursorAction | null;
}): CursorState {
  return {
    x: Number(x),
    y: Number(y),
    visible: visible !== false,
    moveSequence,
    cursorId,
    label: cursorLabel(session, cursorId),
    ...(action ? { action } : {}),
  };
}
