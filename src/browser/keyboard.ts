import type { CdpParams } from "../shared/cdp.ts";
interface KeyDefinition { key: string; code: string; windowsVirtualKeyCode: number; text?: string; location?: number }
const MODIFIER_DEFINITIONS = {
  Alt: { bit: 1, key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, location: 1 },
  Control: { bit: 2, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, location: 1 },
  Meta: { bit: 4, key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, location: 1 },
  Shift: { bit: 8, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, location: 1 },
};

const KEY_NAME_ALIASES: Record<string, string> = {
  Ctrl: "Control",
  Cmd: "Meta",
  Command: "Meta",
  Esc: "Escape",
  Return: "Enter",
  Space: " ",
  Spacebar: " ",
};

const SPECIAL_KEY_DEFINITIONS: Partial<Record<string, KeyDefinition>> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  Insert: { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 },
  " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

const PRINTABLE_CODE_BY_KEY: Partial<Record<string, string>> = {
  "0": "Digit0",
  "1": "Digit1",
  "2": "Digit2",
  "3": "Digit3",
  "4": "Digit4",
  "5": "Digit5",
  "6": "Digit6",
  "7": "Digit7",
  "8": "Digit8",
  "9": "Digit9",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "`": "Backquote",
};

type Modifier = keyof typeof MODIFIER_DEFINITIONS;
function isModifier(key: string): key is Modifier { return Object.hasOwn(MODIFIER_DEFINITIONS, key); }
const KEY_NAME_CANONICAL = new Map<string, string>();
for (const [key, value] of Object.entries(KEY_NAME_ALIASES)) KEY_NAME_CANONICAL.set(key.toLocaleLowerCase(), value);
for (const key of [...Object.keys(MODIFIER_DEFINITIONS), ...Object.keys(SPECIAL_KEY_DEFINITIONS)]) KEY_NAME_CANONICAL.set(key.toLocaleLowerCase(), key);

function normalizeKeyName(key: string) {
  const raw = String(key);
  const canonical = KEY_NAME_CANONICAL.get(raw.toLocaleLowerCase());
  if (canonical !== undefined) return canonical;
  if (/^f([1-9]|1[0-2])$/i.test(raw)) return raw.toUpperCase();
  return raw;
}

function keyDefinition(key: string, modifiers: Set<string> = new Set(), rawPrimary = key): KeyDefinition {
  const normalized = normalizeKeyName(key);
  const special = SPECIAL_KEY_DEFINITIONS[normalized];
  if (special) return { ...special };

  if (/^F([1-9]|1[0-2])$/.test(normalized)) {
    const number = Number(normalized.slice(1));
    return { key: normalized, code: normalized, windowsVirtualKeyCode: 111 + number };
  }

  if (normalized.length === 1 && /^[a-z]$/i.test(normalized)) {
    const upper = normalized.toUpperCase();
    const text = modifiers.size ? undefined : rawPrimary;
    const key = modifiers.has("Control") || modifiers.has("Meta") || modifiers.has("Alt")
      ? upper.toLowerCase()
      : rawPrimary;
    return { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text };
  }

  if (normalized.length === 1) {
    const code = PRINTABLE_CODE_BY_KEY[normalized];
    if (!code) throw new Error(`Unsupported key: ${rawPrimary}`);
    return { key: normalized, code, windowsVirtualKeyCode: normalized.toUpperCase().charCodeAt(0), text: modifiers.size ? undefined : normalized };
  }

  throw new Error(`Unsupported key: ${rawPrimary}`);
}

export function parseKeyPress(key: string) {
  if (typeof key !== "string" || key.length === 0) throw new Error("Key must be a non-empty string");

  const parts = key.includes("+") ? key.split("+").filter(Boolean) : [key];
  const modifiers: Modifier[] = [];
  let primary = null;

  for (const part of parts) {
    const normalized = normalizeKeyName(part.trim());
    if (isModifier(normalized)) {
      if (!modifiers.includes(normalized)) modifiers.push(normalized);
      continue;
    }
    if (primary !== null) throw new Error(`Key chord must contain only one non-modifier key: ${key}`);
    primary = part.trim();
  }

  if (!primary) throw new Error(`Key chord is missing a key: ${key}`);

  const modifierSet = new Set(modifiers);
  const primaryDefinition = keyDefinition(primary, modifierSet, primary);
  const modifierBits = modifiers.reduce((bits, modifier) => bits | MODIFIER_DEFINITIONS[modifier].bit, 0);
  const selectAll = primaryDefinition.code === "KeyA" && (modifierSet.has("Control") || modifierSet.has("Meta")) && !modifierSet.has("Alt");

  return {
    original: key,
    modifiers,
    modifierBits,
    primary: primaryDefinition,
    text: primaryDefinition.text,
    selectAll,
  };
}

export function keyDispatchEvents(parsed: ReturnType<typeof parseKeyPress>): CdpParams<"Input.dispatchKeyEvent">[] {
  const events: CdpParams<"Input.dispatchKeyEvent">[] = [];
  let activeModifierBits = 0;

  for (const modifier of parsed.modifiers) {
    const { bit: _bit, ...definition } = MODIFIER_DEFINITIONS[modifier];
    activeModifierBits |= MODIFIER_DEFINITIONS[modifier].bit;
    events.push({ type: "rawKeyDown", modifiers: activeModifierBits, ...definition });
  }

  const primaryDownType = parsed.modifierBits || !parsed.text ? "rawKeyDown" : "keyDown";
  events.push({
    type: primaryDownType,
    modifiers: parsed.modifierBits,
    ...parsed.primary,
    text: parsed.modifierBits ? undefined : parsed.text,
    unmodifiedText: parsed.modifierBits ? undefined : parsed.text,
    commands: parsed.selectAll ? ["selectAll"] : undefined,
  });
  events.push({ type: "keyUp", modifiers: parsed.modifierBits, ...parsed.primary, text: undefined, unmodifiedText: undefined, commands: undefined });

  for (const modifier of [...parsed.modifiers].reverse()) {
    const { bit: _bit, ...definition } = MODIFIER_DEFINITIONS[modifier];
    activeModifierBits &= ~MODIFIER_DEFINITIONS[modifier].bit;
    events.push({ type: "keyUp", modifiers: activeModifierBits, ...definition, text: undefined, unmodifiedText: undefined });
  }

  return events;
}
