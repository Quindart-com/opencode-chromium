export type Rgb = readonly [number, number, number];
export type Point = { x: number; y: number };
export type { CursorAction as ActionId } from "../src/shared/cursor-actions.ts";
import type { CursorAction as ActionId } from "../src/shared/cursor-actions.ts";
type MotionValue = (progress: number) => number;
export interface ActionDefinition {
  mode: "resting" | "loop" | "oneshot" | "held";
  duration: number;
  stillFrame: number;
  glowWidth?: number;
  group?: { dx?: MotionValue; dy?: MotionValue; scale?: MotionValue; rotate?: MotionValue };
  pointer?: { scale?: MotionValue };
  layers: { d: string; width?: number; filled?: boolean; scale?: MotionValue; opacity?: MotionValue }[];
}
export interface ActionMotion {
  group: { dx: number; dy: number; scale: number; rotate: number };
  pointer: { scale: number };
  layers: { opacity: number; scale: number }[];
}
export interface CursorTheme {
  version: number;
  CANVAS: number;
  DISPLAY_SIZE: number;
  HOTSPOT: Point;
  DEFAULT_FILL: Rgb;
  SESSION_FILLS: readonly Rgb[];
  ACTION_IDS: string[];
  ACTIONS: Record<ActionId, ActionDefinition>;
  replaceArtwork(target: Element, markup: string): void;
  sessionColor(id: string): Rgb;
  mix(base: Rgb, session: Rgb, ratio: number): Rgb;
  cssColor(color: Rgb): string;
  rgba(color: Rgb, alpha: number): string;
  pointerPath: string;
  pointerMarkup(color: Rgb): string;
  cueMarkup(action: string, color: Rgb): string;
  actionMotion(action: string, progress: number): ActionMotion;
  staticProgress(action: string): number;
  chipGlyph(action: string): string;
}

export interface CursorInspection {
  cursorId: string; x: number; y: number; target: Point; fill: number[]; heading: number;
  action: ActionId; visible: boolean; label: string | null; labelVisible: boolean;
  transform: string; artTransform: string; cueAction: ActionId | null; layers: number;
}

declare global {
  var __opencodeFileGuard: ((event: MouseEvent) => void) | undefined;
  var __opencodeCursorThemeVersion: number | undefined;
  var __opencodeCursorInstalledVersion: number | undefined;
  var __opencodeCursorTheme: CursorTheme | undefined;
  var __opencodeCursorInspect: (() => CursorInspection[]) | undefined;
}

export interface GlidePlan { from: Point; to: Point; control1: Point; control2: Point; distance: number; duration: number; startedAt: number }
export interface CursorEntry {
  cursorId: string; session: Rgb; cursor: HTMLDivElement; art: SVGSVGElement; cue: SVGGElement; pointer: SVGGElement;
  badge: HTMLDivElement; chip: HTMLSpanElement; label: HTMLSpanElement; labelText: string | null;
  current: Point; target: Point; heading: number; plan: GlidePlan | null; action: ActionId;
  actionStartedAt: number; actionUntil: number; labelTimer: ReturnType<typeof setTimeout> | null;
  moveSequence: number; pendingArrival: number | null; raf: number | null; frame: number; visible: boolean;
  seeded: boolean; cueAction: ActionId | null; layerNodes: SVGElement[]; chipAction: ActionId | null;
}
