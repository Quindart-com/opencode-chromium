// API reference: https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus
export function releaseDecision(status, version) {
  const published = status?.publishedItemRevisionStatus;
  const submitted = status?.submittedItemRevisionStatus;
  const versions = (revision) => (revision?.distributionChannels ?? []).map((channel) => channel.crxVersion);
  if (status?.takenDown) return { action: "blocked", reason: "The store item is taken down; review its dashboard." };
  if (submitted) return { action: "blocked", reason: `A submission is still present (${submitted.state ?? "unknown"}). Check its review status before uploading another release.` };
  if (published?.state === "PUBLISHED" && versions(published).includes(version)) return { action: "published", reason: "The requested version is already published." };
  return { action: "upload", reason: "No outstanding submission was reported." };
}

export async function fetchReleaseState({ clientId, clientSecret, refreshToken, extensionId, publisherId, fetcher = fetch }) {
  const tokenResponse = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(30000),
  });
  if (!tokenResponse.ok) throw new Error(`Store authorization failed (${tokenResponse.status})`);
  const token = await tokenResponse.json();
  if (typeof token.access_token !== "string") throw new Error("Store authorization returned no access token");
  const response = await fetcher(`https://chromewebstore.googleapis.com/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:fetchStatus`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Store status lookup failed (${response.status}); no upload attempted`);
  const status = await response.json();
  if (!status || status.itemId !== extensionId) throw new Error("Store status returned an unexpected item");
  return status;
}
