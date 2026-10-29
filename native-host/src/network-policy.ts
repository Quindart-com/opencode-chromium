import net from "node:net";

/** Apply only inside our standalone native host, never inside a harness. */
export function configureNetworkFamilyFallback() {
  if (process.versions.bun) return;
  // Node's 250 ms address-family race can abandon a working address on a
  // higher-latency connection. Keep both families and allow one second per
  // attempt; existing request deadlines still bound the complete operation.
  const current = net.getDefaultAutoSelectFamilyAttemptTimeout();
  if (current < 1000) net.setDefaultAutoSelectFamilyAttemptTimeout(1000);
}
