#!/usr/bin/env node
/* global console */

let fs;
let os;
let path;
let process;
let execFileSync;
let expectedExtensionId;
let expectedHostName;

const CHROME_NATIVE_HOST_MANIFEST_PATH_ENV =
  "CODEX_CHROME_NATIVE_HOST_MANIFEST_PATH";
const CHROME_EXTENSION_ID_CONFIG_FILENAME = "extension-id.json";
const WINDOWS_NATIVE_HOST_REGISTRY_KEY_PREFIX =
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts";

function usage() {
  console.error("Usage: scripts/check-native-host-manifest.js [--json]");
  console.error("");
  console.error(
    `Expected extension ID is read from scripts/${CHROME_EXTENSION_ID_CONFIG_FILENAME}.`,
  );
  console.error(
    `Optional manifest-file override: ${CHROME_NATIVE_HOST_MANIFEST_PATH_ENV}=/path/to/native-host.json`,
  );
}

function getNativeHostManifestLocation() {
  if (process.env[CHROME_NATIVE_HOST_MANIFEST_PATH_ENV]) {
    return {
      manifestPath: path.resolve(
        process.env[CHROME_NATIVE_HOST_MANIFEST_PATH_ENV],
      ),
      registryKey: null,
      registryManifestPath: null,
      registryKeyExists: null,
    };
  }

  if (process.platform === "darwin") {
    return {
      manifestPath: path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
        `${expectedHostName}.json`,
      ),
      registryKey: null,
      registryManifestPath: null,
      registryKeyExists: null,
    };
  }

  if (process.platform === "win32") {
    const registryKey = `${WINDOWS_NATIVE_HOST_REGISTRY_KEY_PREFIX}\\${expectedHostName}`;
    const registryManifestPath = readWindowsRegistryDefaultValue(registryKey);

    return {
      manifestPath: registryManifestPath || getDefaultWindowsManifestPath(),
      registryKey,
      registryManifestPath,
      registryKeyExists: registryManifestPath != null,
    };
  }

  throw new Error(
    `Unsupported platform for native host manifest check: ${process.platform}. This script supports macOS and Windows.`,
  );
}

function getDefaultWindowsManifestPath() {
  return path.join(
    os.homedir(),
    "AppData",
    "Local",
    "OpenAI",
    "extension",
    `${expectedHostName}.json`,
  );
}

function readWindowsRegistryDefaultValue(registryKey) {
  let output;
  try {
    output = execFileSync("reg", ["query", registryKey, "/ve"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }

  return readRegistryValue(output, "(Default)");
}

function readRegistryValue(output, valueName) {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(.*?)\s+REG_\w+\s+(.+?)\s*$/);
    if (match && match[1] === valueName) return stripRegistryString(match[2]);
  }

  return null;
}

function stripRegistryString(value) {
  return value.replace(/^"(.*)"$/, "$1");
}

function getNativeHostManifestLocationProblem(location, manifestExists) {
  const problems = [];

  if (location.registryKeyExists === false) {
    problems.push(
      `Windows native host registry key does not exist: ${location.registryKey}`,
    );
  }

  if (!manifestExists) {
    problems.push(
      `Native host manifest does not exist: ${location.manifestPath}`,
    );
  }

  return problems.length > 0 ? problems.join("; ") : null;
}

function readNativeHostManifest(filePath) {
  try {
    return readJsonFile(filePath);
  } catch (error) {
    throw new Error(
      `Could not read native host manifest ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function resolveSiblingScriptPath(filename) {
  const scriptPath = path.resolve(process.argv[1] || ".");
  return path.join(path.dirname(scriptPath), filename);
}

function loadExpectedExtensionId() {
  return loadExpectedChromeExtensionConfig().extensionId;
}

function loadExpectedChromeExtensionConfig() {
  const configPath = resolveSiblingScriptPath(
    CHROME_EXTENSION_ID_CONFIG_FILENAME,
  );
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config || typeof config.extensionId !== "string")
    throw new Error(`Could not read extensionId from ${configPath}.`);

  return config;
}

function loadExpectedHostName() {
  const config = loadExpectedChromeExtensionConfig();
  const scriptPath = resolveSiblingScriptPath("installManifest.mjs");
  if (!fs.existsSync(scriptPath)) {
    if (typeof config.extensionHostName === "string")
      return config.extensionHostName;

    throw new Error(`Could not find installManifest.mjs at ${scriptPath}.`);
  }

  const scriptSource = fs.readFileSync(scriptPath, "utf8");
  const match = scriptSource.match(/extensionHostName:"([^"]+)"/);
  if (!match || !match[1])
    throw new Error(`Could not read extensionHostName from ${scriptPath}.`);

  return match[1];
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getNativeHostManifestStatus() {
  const location = getNativeHostManifestLocation();
  const expectedOrigin = `chrome-extension://${expectedExtensionId}/`;
  const exists = fs.existsSync(location.manifestPath);
  const locationProblem = getNativeHostManifestLocationProblem(
    location,
    exists,
  );

  if (locationProblem) {
    return {
      manifestPath: location.manifestPath,
      registryKey: location.registryKey,
      registryManifestPath: location.registryManifestPath,
      expectedHostName,
      expectedExtensionId,
      expectedOrigin,
      exists,
      correct: false,
      problem: locationProblem,
    };
  }

  const manifest = readNativeHostManifest(location.manifestPath);
  const allowedOrigins = Array.isArray(manifest.allowed_origins)
    ? manifest.allowed_origins
    : [];
  const nameMatches = manifest.name === expectedHostName;
  const hasExpectedOrigin = allowedOrigins.includes(expectedOrigin);
  const registryMatchesManifestPath =
    location.registryManifestPath == null ||
    path.resolve(location.registryManifestPath) ===
      path.resolve(location.manifestPath);
  const correct =
    nameMatches && hasExpectedOrigin && registryMatchesManifestPath;

  return {
    manifestPath: location.manifestPath,
    registryKey: location.registryKey,
    registryManifestPath: location.registryManifestPath,
    expectedHostName,
    actualHostName: manifest.name,
    expectedExtensionId,
    expectedOrigin,
    allowedOrigins,
    exists,
    nameMatches,
    hasExpectedOrigin,
    registryMatchesManifestPath,
    correct,
    problem: correct
      ? null
      : describeManifestProblem({
          nameMatches,
          hasExpectedOrigin,
          registryMatchesManifestPath,
        }),
  };
}

function describeManifestProblem({
  nameMatches,
  hasExpectedOrigin,
  registryMatchesManifestPath,
}) {
  const problems = [];
  if (!nameMatches)
    problems.push(`manifest name does not match ${expectedHostName}`);
  if (!hasExpectedOrigin) {
    problems.push(
      `allowed_origins does not include chrome-extension://${expectedExtensionId}/`,
    );
  }
  if (!registryMatchesManifestPath) {
    problems.push(
      "registry manifest path does not match checked manifest path",
    );
  }

  return problems.join("; ");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    process.exit(0);
  }

  const json = args.includes("--json");
  const positionalArgs = args.filter((arg) => arg !== "--json");
  if (positionalArgs.length > 0) {
    usage();
    process.exit(2);
  }

  const result = getNativeHostManifestStatus();
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Native host manifest: ${result.manifestPath}`);
    if (result.registryKey)
      console.log(`Windows registry key: ${result.registryKey}`);
    if (result.registryManifestPath) {
      console.log(
        `Windows registry manifest path: ${result.registryManifestPath}`,
      );
    }
    console.log(`Expected host name: ${result.expectedHostName}`);
    if (result.actualHostName)
      console.log(`Actual host name: ${result.actualHostName}`);
    console.log(`Expected extension ID: ${result.expectedExtensionId}`);
    console.log(`Expected allowed origin: ${result.expectedOrigin}`);
    if (result.allowedOrigins)
      console.log(`Allowed origins: ${result.allowedOrigins.join(", ")}`);
    console.log(`Correct: ${result.correct ? "yes" : "no"}`);
    if (result.problem) console.log(`Problem: ${result.problem}`);
  }

  process.exit(result.correct ? 0 : 1);
}

try {
  Promise.all([
    import("node:fs"),
    import("node:os"),
    import("node:path"),
    import("node:process"),
    import("node:child_process"),
  ])
    .then(
      ([fsModule, osModule, pathModule, processModule, childProcessModule]) => {
        fs = fsModule;
        os = osModule;
        path = pathModule;
        process = processModule.default;
        ({ execFileSync } = childProcessModule);
        expectedExtensionId = loadExpectedExtensionId();
        expectedHostName = loadExpectedHostName();
        main();
      },
    )
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
