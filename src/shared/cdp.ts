import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";

type NativeCdpMethod = keyof ProtocolMapping.Commands;
export type CdpMethod = NativeCdpMethod | "Page.traverseHistory";
type NativeParams<K extends NativeCdpMethod> = ProtocolMapping.Commands[K]["paramsType"] extends [] ? Record<string, never> : NonNullable<ProtocolMapping.Commands[K]["paramsType"][0]>;
export type CdpParams<K extends CdpMethod> = K extends "Page.traverseHistory" ? { delta: number } : K extends NativeCdpMethod ? K extends "Page.getFrameTree" ? { maxDepth?: number; maxFrames?: number } : K extends "Runtime.evaluate" ? Omit<NativeParams<K>, "contextId"> & { contextId?: number | string } : NativeParams<K> : never;
export type CdpResult<K extends CdpMethod> = K extends "Page.traverseHistory" ? object : K extends "Page.createIsolatedWorld" ? { executionContextId: number | string } : K extends NativeCdpMethod ? ProtocolMapping.Commands[K]["returnType"] : never;
export type CdpRequest = <K extends CdpMethod>(method: K, params: CdpParams<K>) => Promise<CdpResult<K>>;
export type TabCdpRequest = <K extends CdpMethod>(tabId: number, method: K, params: CdpParams<K>, timeoutMs?: number) => Promise<CdpResult<K>>;
export type PageCdpRequest<Context = unknown> = <K extends CdpMethod>(context: Context, tabId: number, method: K, params: CdpParams<K>, timeoutMs?: number) => Promise<CdpResult<K>>;
export type CdpCommand = { [K in CdpMethod]: [K, CdpParams<K>] }[CdpMethod];
