export { ArtifactStore, artifactUriTemplate } from "../../core/artifacts.js";

export function artifactContent(artifact) {
  const binary = !artifact.mimeType.startsWith("text/") && artifact.mimeType !== "application/json";
  return {
    uri: artifact.uri,
    mimeType: artifact.mimeType,
    ...(binary ? { blob: artifact.data.toString("base64") } : { text: artifact.data.toString("utf8") }),
  };
}
