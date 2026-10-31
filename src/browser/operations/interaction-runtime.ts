type ScrollSnapshot = { window: { scrollLeft: number; scrollTop: number }; target: { scrollLeft: number; scrollTop: number } | null };
import type { BrowserContext } from "../../core/tool-definition.ts";
import type { BrowserOperationDependencies as Dependencies } from "../operation-definition.ts";
import { keyDispatchEvents,parseKeyPress } from "../keyboard.ts";
import { focusExpression,selectionSnapshotExpression } from './focus-expressions.ts';
import { interactionHelpersSource } from './interaction-helpers.ts';
export { keyDispatchEvents,parseKeyPress } from "../keyboard.ts";
export { pageInspectExpression,visualMapExpression } from './inspection-expressions.ts';
export { pageSearchUnitsExpression } from './snapshot-expressions.ts';

// The browser operation engine is intentionally adapter-neutral. MCP, OpenCode,
// and direct SDK adapters all consume this same operation registry.

type EditableOptions = { selectAll?: boolean; cursorAtEnd?: boolean; includeSelect?: boolean };
type InputGestureStep = { method: string; commandParams: object; cursor?: unknown; delayMs?: number };

export function selectorClickTargetExpression(selector: string) {
  return `(() => {
    ${interactionHelpersSource()}
    return clickTarget(querySelectorStrict(${JSON.stringify(selector)}));
  })()`;
}

export function createInteractionRuntime(dependencies: Dependencies) {
  const { cdp, runtimeEvaluate, pointCursor, inputGesture, activate, finiteNumber, pageBackend } = dependencies;
function domNodeClickTargetExpression(nodeId: string) {
  return `(() => {
    ${interactionHelpersSource()}
    return clickTarget(nodeByIdStrict(${JSON.stringify(nodeId)}));
  })()`;
}

function backgroundClickExpression(targetExpression: string, options: { button?: string; clickCount?: number; trusted?: boolean } = {}) {
  const clickOptions = {
    button: options.button ?? "left",
    clickCount: options.clickCount ?? 1,
  };
  return `(() => {
    ${interactionHelpersSource()}
    const element = ${targetExpression};
    const target = clickTarget(element);
    ${options.trusted ? "" : `backgroundClick(element, target, ${JSON.stringify(clickOptions)});`}
    return target;
  })()`;
}

function domNodeClickExpression(nodeId: string, options: { trusted?: boolean } = {}) {
  return backgroundClickExpression(`nodeByIdStrict(${JSON.stringify(nodeId)})`, options);
}

function domNodeHoverTargetExpression(nodeId: string) {
  return `(() => {
    ${interactionHelpersSource()}
    return hoverTarget(nodeByIdStrict(${JSON.stringify(nodeId)}));
  })()`;
}

function domNodeEditableExpression(nodeId: string, options: EditableOptions = {}) {
  return `(() => {
    ${interactionHelpersSource()}
    return prepareEditable(nodeByIdStrict(${JSON.stringify(nodeId)}), ${JSON.stringify(options)});
  })()`;
}

function selectorClickExpression(selector: string, options: { trusted?: boolean } = {}) {
  return backgroundClickExpression(`querySelectorStrict(${JSON.stringify(selector)})`, options);
}

function clickAtPointExpression(x: number, y: number, options: { button?: string; trusted?: boolean; clickCount?: number } = {}) {
  finiteNumber(x, "x");
  finiteNumber(y, "y");
  const clickOptions = {
    button: options.button ?? "left",
    clickCount: options.clickCount ?? 1,
  };
  return `(() => {
    ${interactionHelpersSource()}
    const point = { x: ${JSON.stringify(x)}, y: ${JSON.stringify(y)} };
    const element = document.elementFromPoint(point.x, point.y);
    if (!element) throw new Error('No element at viewport point: ' + point.x + ', ' + point.y);
    if (element.matches('iframe,frame')) agentFail('FRAME_TARGET_REQUIRED', 'Choose a frameId from frames.list before interacting with embedded controls.');
    assertPointerInteractable(element);
    visibleRect(element);
    ${options.trusted ? "" : `backgroundClick(element, point, ${JSON.stringify(clickOptions)});`}
    return {
      x: point.x,
      y: point.y,
      tagName: element.localName,
      text: (element.innerText || element.value || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
    };
  })()`;
}

function hoverAtPointExpression(x: number, y: number) {
  finiteNumber(x, "x");
  finiteNumber(y, "y");
  return `(() => {
    ${interactionHelpersSource()}
    const point = { x: ${JSON.stringify(x)}, y: ${JSON.stringify(y)} };
    const element = document.elementFromPoint(point.x, point.y);
    if (!element) throw new Error('No element at viewport point: ' + point.x + ', ' + point.y);
    assertPointerInteractable(element);
    visibleRect(element);
    backgroundHover(element, point);
    return {
      x: point.x,
      y: point.y,
      tagName: element.localName,
      text: (element.innerText || element.value || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
    };
  })()`;
}

function selectorHoverTargetExpression(selector: string) {
  return `(() => {
    ${interactionHelpersSource()}
    return hoverTarget(querySelectorStrict(${JSON.stringify(selector)}));
  })()`;
}

function selectorEditableExpression(selector: string, options: EditableOptions = {}) {
  return `(() => {
    ${interactionHelpersSource()}
    return prepareEditable(querySelectorStrict(${JSON.stringify(selector)}), ${JSON.stringify(options)});
  })()`;
}

function selectorTextExpression(selector: string) {
  return `(() => {
    ${interactionHelpersSource()}
    const element = querySelectorStrict(${JSON.stringify(selector)});
    return { text: (element.innerText || element.value || element.textContent || '').trim(), observation: agentObservation('selector') };
  })()`;
}

function focusedEditableSnapshotExpression(options: { includeSelect?: boolean } = {}) {
  return `(() => {
    ${interactionHelpersSource()}
    const element = focusedEditableElement(${JSON.stringify(Boolean(options.includeSelect))});
    if (!element) throw new Error('No editable element is focused');
    const kind = editableKind(element, ${JSON.stringify(Boolean(options.includeSelect))});
    if (kind === 'select' && !${JSON.stringify(Boolean(options.includeSelect))}) throw new Error('Focused element is not text-editable');
    return editableSnapshot(element, kind);
  })()`;
}

// The cursor lands on the element a typing action will change, so the pointer
// is not left somewhere else while text appears.
function focusedEditableTargetExpression() {
  return `(() => {
    ${interactionHelpersSource()}
    const element = focusedEditableElement(false);
    return element ? hoverTarget(element) : null;
  })()`;
}

function verifyFocusedEditableExpression(before: unknown, options: { insertedText?: string; expectedValue?: string; includeSelect?: boolean } = {}) {
  return `(() => {
    ${interactionHelpersSource()}
    const before = ${JSON.stringify(before)};
    const expectedValue = ${JSON.stringify(options.expectedValue)};
    const insertedText = ${JSON.stringify(options.insertedText ?? "")};
    const element = focusedEditableElement(${JSON.stringify(Boolean(options.includeSelect))});
    if (!element) throw new Error('No editable element is focused after input');
    const kind = editableKind(element, ${JSON.stringify(Boolean(options.includeSelect))});
    const after = editableSnapshot(element, kind);
    if (expectedValue !== undefined && after.value !== expectedValue) {
      throw new Error('Input verification failed: expected value ' + JSON.stringify(expectedValue) + ' but got ' + JSON.stringify(after.value));
    }
    if (expectedValue === undefined && insertedText.length > 0 && after.value === before.value && after.selectionStart === before.selectionStart && after.selectionEnd === before.selectionEnd && after.selectedText === before.selectedText) {
      throw new Error('Input verification failed: focused element did not change');
    }
    return after;
  })()`;
}

function setFocusedSelectValueExpression(value: string) {
  return `(() => {
    ${interactionHelpersSource()}
    return setFocusedSelectValue(${JSON.stringify(value)});
  })()`;
}

async function clickPoint(context: BrowserContext, tabId: number, x: number, y: number, button: "left" | "middle" | "right" = "left") {
  finiteNumber(x, "x");
  finiteNumber(y, "y");
  await activate(context, tabId);
  return pageBackend.click(context, tabId, (trusted: boolean) => clickAtPointExpression(x, y, { button, trusted }), { button });
}

async function hoverPoint(context: BrowserContext, tabId: number, x: number, y: number) {
  finiteNumber(x, "x");
  finiteNumber(y, "y");
  await activate(context, tabId);
  return pageBackend.hover(context, tabId, await runtimeEvaluate(context, tabId, hoverAtPointExpression(x, y), { userGesture: false }));
}

async function insertTextAndVerify(context: BrowserContext, tabId: number, before: unknown, text: string, options: { expectedValue?: string; includeSelect?: boolean } = {}) {
  const chunkSize = 16384;
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    await cdp(context, tabId, "Input.insertText", { text: text.slice(offset, offset + chunkSize) });
  }
  return runtimeEvaluate(context, tabId, verifyFocusedEditableExpression(before, {
    insertedText: text,
    expectedValue: options.expectedValue,
    includeSelect: options.includeSelect,
  }));
}

async function fillFocusedEditable(context: BrowserContext, tabId: number, before: { kind: string; value: string }, value: string) {
  if (before.kind === "select") {
    const after = await runtimeEvaluate(context, tabId, setFocusedSelectValueExpression(value));
    return { filled: true, tabId, kind: after.kind, value: after.value, valueLength: after.value.length, valueHash: after.valueHash };
  }

  if (value.length === 0 && before.value.length > 0) {
    const parsed = parseKeyPress("Backspace");
    for (const event of keyDispatchEvents(parsed)) await cdp(context, tabId, "Input.dispatchKeyEvent", event);
    const after = await runtimeEvaluate(context, tabId, verifyFocusedEditableExpression(before, { expectedValue: "" }));
    return { filled: true, tabId, kind: after.kind, valueLength: after.value.length, valueHash: after.valueHash };
  }

  const after = await insertTextAndVerify(context, tabId, before, value, { expectedValue: value });
  return { filled: true, tabId, kind: after.kind, valueLength: after.value.length, valueHash: after.valueHash };
}

async function pressKey(context: BrowserContext, tabId: number, key: string, target: { nodeId?: string; selector?: string } = {}) {
  const parsed = parseKeyPress(key);
  await activate(context, tabId);
  if (parsed.selectAll) await runtimeEvaluate(context, tabId, selectionSnapshotExpression());

  const steps: InputGestureStep[] = [];
  if (target.nodeId || target.selector) steps.push({ method: "Runtime.evaluate", commandParams: { expression: focusExpression(target), returnByValue: true } });
  steps.push(...keyDispatchEvents(parsed).map(event => ({ method: "Input.dispatchKeyEvent", commandParams: event })));
  await inputGesture(context, tabId, steps, Math.max(1, (context.deadlineAt ?? Date.now() + 10000) - Date.now()));

  const after = parsed.selectAll
    ? await runtimeEvaluate(context, tabId, selectionSnapshotExpression(true))
    : null;

  return { pressed: key, tabId, parsed: { key: parsed.primary.key, code: parsed.primary.code, modifiers: parsed.modifiers }, verification: after };
}

function sleep(ms: number|undefined) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrollPoint(context: BrowserContext, tabId: number, x: number | undefined, y: number | undefined) {
  if (x !== undefined) finiteNumber(x, "x");
  if (y !== undefined) finiteNumber(y, "y");

  if (x !== undefined && y !== undefined) return { x, y };

  const viewport = await runtimeEvaluate(
    context,
    tabId,
    "({ width: window.innerWidth || 800, height: window.innerHeight || 600 })",
    { timeoutMs: 3000, runtimeTimeoutMs: 1000 },
  ).catch(() => ({ width: 800, height: 600 }));
  return {
    x: x ?? Math.max(1, Math.floor((viewport.width ?? 800) / 2)),
    y: y ?? Math.max(1, Math.floor((viewport.height ?? 600) / 2)),
  };
}

function scrollSnapshotExpression(x: number, y: number) {
  return `(() => {
    const point = { x: ${JSON.stringify(x)}, y: ${JSON.stringify(y)} };
    const root = document.scrollingElement || document.documentElement;
    const metrics = (element) => ({
      tag: element === root ? "window" : element.tagName,
      id: element === root ? null : (element.id || null),
      className: element === root ? null : (typeof element.className === "string" ? element.className.slice(0, 120) : null),
      scrollLeft: element === root ? window.scrollX : element.scrollLeft,
      scrollTop: element === root ? window.scrollY : element.scrollTop,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      clientWidth: element === root ? window.innerWidth : element.clientWidth,
      clientHeight: element === root ? window.innerHeight : element.clientHeight,
    });
    const isScrollable = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      const style = getComputedStyle(element);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const canY = /(auto|scroll|overlay)/.test(overflowY) && element.scrollHeight > element.clientHeight + 1;
      const canX = /(auto|scroll|overlay)/.test(overflowX) && element.scrollWidth > element.clientWidth + 1;
      return canY || canX;
    };
    let target = document.elementFromPoint(point.x, point.y);
    for (let element = target; element; element = element.parentElement) {
      if (isScrollable(element)) {
        target = element;
        break;
      }
    }
    if (!target || !isScrollable(target)) target = root;
    return { point, window: metrics(root), target: metrics(target) };
  })()`;
}

function scrollFallbackExpression(x: number, y: number, scrollX: number, scrollY: number) {
  return `(() => {
    const snapshot = ${scrollSnapshotExpression(x, y)};
    const root = document.scrollingElement || document.documentElement;
    const target = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    const isScrollable = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      const style = getComputedStyle(element);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const canY = /(auto|scroll|overlay)/.test(overflowY) && element.scrollHeight > element.clientHeight + 1;
      const canX = /(auto|scroll|overlay)/.test(overflowX) && element.scrollWidth > element.clientWidth + 1;
      return canY || canX;
    };
    let scrollTarget = target;
    for (let element = target; element; element = element.parentElement) {
      if (isScrollable(element)) {
        scrollTarget = element;
        break;
      }
    }
    if (!scrollTarget || !isScrollable(scrollTarget)) scrollTarget = root;
    if (scrollTarget === root) window.scrollBy({ left: ${JSON.stringify(scrollX)}, top: ${JSON.stringify(scrollY)}, behavior: "auto" });
    else scrollTarget.scrollBy({ left: ${JSON.stringify(scrollX)}, top: ${JSON.stringify(scrollY)}, behavior: "auto" });
    return { before: snapshot, after: ${scrollSnapshotExpression(x, y)} };
  })()`;
}

function didScroll(before: ScrollSnapshot, after: ScrollSnapshot) {
  return before?.window?.scrollLeft !== after?.window?.scrollLeft
    || before?.window?.scrollTop !== after?.window?.scrollTop
    || before?.target?.scrollLeft !== after?.target?.scrollLeft
    || before?.target?.scrollTop !== after?.target?.scrollTop;
}

async function scrollTab(context: BrowserContext, tabId: number, args: { scrollX: number; scrollY: number; x?: number; y?: number }) {
  finiteNumber(args.scrollX, "scrollX");
  finiteNumber(args.scrollY, "scrollY");
  await activate(context, tabId);
  const point = await scrollPoint(context, tabId, args.x, args.y);
  await pointCursor(context, tabId, point, "scroll");
  const before = await runtimeEvaluate(context, tabId, scrollSnapshotExpression(point.x, point.y), { timeoutMs: 3000, runtimeTimeoutMs: 1000 });
  if (args.scrollX === 0 && args.scrollY === 0) {
    return { scrolled: false, fallbackUsed: false, tabId, ...point, scrollX: args.scrollX, scrollY: args.scrollY, before, after: before };
  }

  const result = await runtimeEvaluate(context, tabId, scrollFallbackExpression(point.x, point.y, args.scrollX, args.scrollY), {
    timeoutMs: 3000,
    runtimeTimeoutMs: 1000,
    userGesture: false,
  });
  return { scrolled: didScroll(result.before, result.after), fallbackUsed: true, tabId, ...point, scrollX: args.scrollX, scrollY: args.scrollY, before, after: result.after };
}

  return { domNodeClickTargetExpression, backgroundClickExpression, domNodeClickExpression, domNodeHoverTargetExpression, domNodeEditableExpression, selectorClickTargetExpression, selectorClickExpression, clickAtPointExpression, hoverAtPointExpression, selectorHoverTargetExpression, selectorEditableExpression, selectorTextExpression, focusedEditableSnapshotExpression, focusedEditableTargetExpression, verifyFocusedEditableExpression, setFocusedSelectValueExpression, clickPoint, hoverPoint, insertTextAndVerify, fillFocusedEditable, pressKey, sleep, scrollPoint, scrollSnapshotExpression, scrollFallbackExpression, didScroll, scrollTab };
}
