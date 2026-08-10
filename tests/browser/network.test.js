import assert from "node:assert/strict";
import test from "node:test";
import { inspectNetworkEvents, networkBodyPreview } from "../../src/browser/network.js";

function requestEvents({ requestId = "1", url = "https://example.test/api/data?token=private", method = "POST" } = {}) {
  return [
    {
      time: "2026-08-06T10:00:00.000Z",
      method: "Network.requestWillBeSent",
      params: {
        requestId,
        type: "Fetch",
        request: {
          url,
          method,
          headers: { Authorization: "Bearer private", "content-type": "application/json" },
          postData: '{"password":"private","ok":true}',
        },
      },
    },
    {
      time: "2026-08-06T10:00:00.100Z",
      method: "Network.responseReceived",
      params: {
        requestId,
        type: "Fetch",
        response: {
          url,
          status: 200,
          statusText: "OK",
          mimeType: "application/json",
          headers: { "set-cookie": "private", "content-type": "application/json" },
          timing: { requestTime: 123, dnsStart: 1 },
        },
      },
    },
    {
      time: "2026-08-06T10:00:00.200Z",
      method: "Network.dataReceived",
      params: { requestId, dataLength: 10, encodedDataLength: 14 },
    },
    {
      time: "2026-08-06T10:00:00.300Z",
      method: "Network.loadingFinished",
      params: { requestId, encodedDataLength: 14 },
    },
  ];
}

test("network inspection projects Playwright-style lifecycle data without secrets by default", async () => {
  const result = await inspectNetworkEvents([
    ...requestEvents(),
    {
      time: "2026-08-06T10:00:01.000Z",
      method: "Network.loadingFailed",
      params: { requestId: "2", errorText: "net::ERR_FAILED" },
    },
  ]);

  assert.equal(result.totalRequests, 2);
  assert.equal(result.events[0].lifecycle, "finished");
  assert.equal(result.events[0].status, 200);
  assert.match(result.events[0].url, /token=\[REDACTED\]/);
  assert.equal("requestHeaders" in result.events[0], false);
  assert.equal("requestBody" in result.events[0], false);
  assert.deepEqual(result.events[1], {
    requestId: "2",
    url: null,
    method: null,
    resourceType: null,
    lifecycle: "failed",
    status: null,
    statusText: null,
    mimeType: null,
    requestAt: null,
    responseAt: null,
    finishedAt: "2026-08-06T10:00:01.000Z",
    error: "net::ERR_FAILED",
  });
});

test("network inspection adds bounded redacted headers and opt-in body previews", async () => {
  const result = await inspectNetworkEvents(requestEvents(), {
    includeHeaders: true,
    includeBody: "both",
    bodyMaxChars: 18,
  }, {
    async getResponseBody() {
      return { body: '{"token":"private","value":"long response"}' };
    },
  });

  const event = result.events[0];
  assert.equal(event.requestHeaders.Authorization, "[REDACTED]");
  assert.equal(event.responseHeaders["set-cookie"], "[REDACTED]");
  assert.match(event.requestBody.preview, /password/);
  assert.doesNotMatch(event.requestBody.preview, /private/);
  assert.equal(event.requestBody.truncated, true);
  assert.doesNotMatch(event.responseBody.preview, /private/);
  assert.equal(result.bodyFetches, 1);
  assert.doesNotMatch(networkBodyPreview("password=private&ok=true").preview, /private/);
});

test("network inspection filters one tab's request records by URL, method, type, and status", async () => {
  const result = await inspectNetworkEvents([
    ...requestEvents({ requestId: "1", url: "https://example.test/api/data", method: "POST" }),
    ...requestEvents({ requestId: "2", url: "https://example.test/static/app.js", method: "GET" }).map((event) => ({
      ...event,
      params: event.method === "Network.responseReceived"
        ? { ...event.params, type: "Script", response: { ...event.params.response, status: 304 } }
        : event.params,
    })),
  ], {
    urlIncludes: "/api/",
    methods: ["post"],
    resourceTypes: ["fetch"],
    statusMin: 200,
    statusMax: 299,
  });

  assert.equal(result.returned, 1);
  assert.equal(result.events[0].requestId, "1");
});
