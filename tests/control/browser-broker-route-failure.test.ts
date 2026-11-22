import { expect,test } from "bun:test";
import { routeFailureReply } from "../../src/control/browser-broker.ts";

test("a failed request gets a retryable error instead of shutting the broker down", () => {
  const restarting = Object.assign(new Error("Browser worker is restarting"), { code: "worker_restarting" });
  expect(routeFailureReply({ jsonrpc: "2.0", id: 7, method: "ping" }, restarting)).toEqual({ jsonrpc: "2.0", id: 7,
    error: { code: -32000, message: "Browser worker is restarting", data: { code: "worker_restarting", retryable: true, uncertain: false } } });
  const other = routeFailureReply({ id: "a", method: "tabs.list" }, new Error("boom")) as { error: { data: { code: string } } };
  expect(other.error.data.code).toBe("route_failed");
});

test("notifications and responses never get an error reply", () => {
  const error = new Error("x");
  expect(routeFailureReply({ method: "event" }, error)).toBeNull();
  expect(routeFailureReply({ id: 1, result: {} }, error)).toBeNull();
  expect(routeFailureReply(null, error)).toBeNull();
});
