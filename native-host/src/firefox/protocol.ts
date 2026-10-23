import type { Commands } from "webdriver-bidi-protocol";

// The generated specification uses enums; JSON transports use their literal values.
type WireValue<T> = T extends string ? `${T}` : T extends readonly unknown[] ? { [K in keyof T]: WireValue<T[K]> } : T extends object ? { [K in keyof T]: WireValue<T[K]> } : T;
export type BidiParams<K extends keyof Commands> = WireValue<Commands[K]["params"]>;
export type BidiSend = <K extends keyof Commands>(method: K, params: BidiParams<K>, timeoutMs?: number) => Promise<Commands[K]["returnType"]>;

export interface BridgedFrame {
  frame: { id: string; url: string };
  childFrames: BridgedFrame[];
  truncated: boolean;
}
