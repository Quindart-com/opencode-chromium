import type { Browser,WxtBrowser } from "wxt/browser";
import type { UrlPolicyConfig } from "../../../src/browser/url-policy.ts";
import type { TabCdpRequest } from "../../../src/shared/cdp.ts";

export interface ExtensionSession {
  tabIds: Set<number>;
  tabOrigins: Map<number, string>;
  name: string | null;
  groupId: number | null;
  activeTabId: number | null;
  currentTurnId: string | null;
  urlPolicy?: UrlPolicyConfig;
  navigationWarnings?: { tabId: number; code: string }[];
}

export interface TabOwner {
  sessionId: string;
  session: ExtensionSession;
  origin: string;
}

export interface TraceBuffer {
  chunks: string[];
  eventCount: number;
  overflowed: boolean;
  complete: boolean;
  endTime: number | null;
  startedAt: string;
}

export type ChromeCall = <T>(fn: (done: (result: T) => void) => void) => Promise<T>;
export type WithTabLock = <T>(tabId: number, action: () => Promise<T>) => Promise<T>;

export interface AttachDependencies {
  chrome: WxtBrowser;
  withTabLock: WithTabLock;
  attachedTabs: Map<number, string>;
  isBrowserInternalUrl(url: string | undefined): boolean;
  getTab(tabId: number): Promise<Browser.tabs.Tab>;
  chromeCall: ChromeCall;
}

export interface DebuggerDependencies extends AttachDependencies {
  DEBUGGER_VERSION: string;
  errorMessage(error: unknown): string;
  sendCdpCommand: TabCdpRequest;
  DEFAULT_CDP_TIMEOUT_MS: number;
}

export interface UploadFile {
  name: string;
  size: number;
  preview?: string;
  path: string;
}
export interface UploadInfo { token: string; files: UploadFile[] }
export interface UploadDependencies {
  chrome: WxtBrowser;
  describe(files: string[]): Promise<UploadInfo>;
  snapshot(token: string): Promise<{ files: string[] }>;
  release(token: string): Promise<unknown>;
  timeoutMs?: number;
}

export type UploadMessage =
  | { type: "GET_UPLOAD_SETTINGS" }
  | { type: "SET_UPLOAD_SETTINGS"; allowWithoutConfirmation: boolean }
  | { type: "GET_UPLOAD_REQUEST"; token: string }
  | { type: "RESOLVE_UPLOAD_REQUEST"; token: string; allow: boolean };
