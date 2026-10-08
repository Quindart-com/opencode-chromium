export function chromeReleaseConfig({ dryRun, zip, extensionId, publisherId, accessToken }) {
  return {
    dryRun,
    chrome: {
      apiVersion: "v2",
      zip,
      extensionId,
      publisherId,
      serviceAccountAccessToken: accessToken,
      publishType: "DEFAULT_PUBLISH",
      cancelPending: false,
    },
  };
}
