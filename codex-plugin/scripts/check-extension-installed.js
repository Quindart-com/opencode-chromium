#!/usr/bin/env node
/* global console */

let fs;
let os;
let path;
let process;

const CHROME_PREFERENCES_PATH_ENV = "CODEX_CHROME_PREFERENCES_PATH";
const CHROME_USER_DATA_DIR_ENV = "CODEX_CHROME_USER_DATA_DIR";
const CHROME_EXTENSION_ID_CONFIG_FILENAME = "extension-id.json";
const EXIT_INSTALLED_AND_ENABLED = 0;
const EXIT_INSTALLED_NOT_ENABLED = 1;
const EXIT_NOT_INSTALLED = 2;
const EXIT_RUNTIME_ERROR = 3;

async function loadNodeModules() {
  fs = await import("node:fs");
  os = await import("node:os");
  path = await import("node:path");
  process = (await import("node:process")).default;
}

function usage() {
  const extensionId = loadRemoteChromeExtensionId();
  console.error("Usage: scripts/check-extension-installed.js [--json]");
  console.error("");
  console.error(
    `Default extension ID is configured in scripts/${CHROME_EXTENSION_ID_CONFIG_FILENAME} (${extensionId}).`,
  );
  console.error(
    `Optional profile-root override: ${CHROME_USER_DATA_DIR_ENV}=/path/to/chrome-root`,
  );
  console.error(
    `Optional preferences-file override: ${CHROME_PREFERENCES_PATH_ENV}=/path/to/Profile/Preferences`,
  );
}

function resolveChromeUserDataDirectory() {
  if (process.env[CHROME_USER_DATA_DIR_ENV])
    return path.resolve(process.env[CHROME_USER_DATA_DIR_ENV]);

  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
  }

  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Google",
      "Chrome",
      "User Data",
    );
  }

  return path.join(os.homedir(), ".config", "google-chrome");
}

function resolveChromePreferencesPath() {
  if (process.env[CHROME_PREFERENCES_PATH_ENV])
    return path.resolve(process.env[CHROME_PREFERENCES_PATH_ENV]);

  const userDataDirectory = resolveChromeUserDataDirectory();
  const profileDirectory = resolveChromeProfileDirectory(userDataDirectory);
  return path.join(userDataDirectory, profileDirectory, "Preferences");
}

function resolveChromeProfilePath() {
  return path.dirname(resolveChromePreferencesPath());
}

function loadRemoteChromeExtensionId() {
  const configPath = resolveSiblingScriptPath(
    CHROME_EXTENSION_ID_CONFIG_FILENAME,
  );
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config || typeof config.extensionId !== "string")
    throw new Error(`Could not read extensionId from ${configPath}.`);

  return config.extensionId;
}

function resolveSiblingScriptPath(filename) {
  const scriptPath = path.resolve(process.argv[1] || ".");
  return path.join(path.dirname(scriptPath), filename);
}

function resolveChromeProfileDirectory(userDataDirectory) {
  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;

  const latestProfile = findLatestChromeProfile(userDataDirectory);
  if (latestProfile) return latestProfile;

  throw new Error(
    `Could not find a Chrome profile directory with Preferences in ${userDataDirectory}.`,
  );
}

function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {
  const localState = readJsonFileIfPresent(
    path.join(userDataDirectory, "Local State"),
  );
  const profile = localState?.profile;
  if (!profile || typeof profile !== "object") return null;

  if (isUsableChromeProfile(userDataDirectory, profile.last_used))
    return profile.last_used;

  if (Array.isArray(profile.last_active_profiles)) {
    return chooseLatestUsableChromeProfile(
      userDataDirectory,
      profile.last_active_profiles,
    );
  }

  return null;
}

function chooseLatestUsableChromeProfile(
  userDataDirectory,
  profileDirectories,
) {
  const usableProfiles = profileDirectories.filter((profileDirectory) => {
    return isUsableChromeProfile(userDataDirectory, profileDirectory);
  });
  if (usableProfiles.length === 0) return null;

  return usableProfiles.sort(compareChromeProfileDirectories).at(-1);
}

function findLatestChromeProfile(userDataDirectory) {
  if (!fs.existsSync(userDataDirectory)) {
    throw new Error(
      `Chrome user data directory does not exist: ${userDataDirectory}`,
    );
  }

  const profileDirectories = fs
    .readdirSync(userDataDirectory, { withFileTypes: true })
    .filter((entry) => {
      return (
        entry.isDirectory() &&
        (entry.name === "Default" || /^Profile \d+$/.test(entry.name))
      );
    })
    .map((entry) => entry.name);

  return chooseLatestUsableChromeProfile(userDataDirectory, profileDirectories);
}

function getChromeExtensionInstallStatus() {
  const extensionId = loadRemoteChromeExtensionId();
  const profilePath = resolveChromeProfilePath();
  const preferences = getChromeExtensionPreferences(profilePath, extensionId);
  const extensionsDirectory = path.join(profilePath, "Extensions");
  const extensionPath = path.join(extensionsDirectory, extensionId);
  const versions =
    fs.existsSync(extensionPath) && fs.statSync(extensionPath).isDirectory()
      ? fs
          .readdirSync(extensionPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : [];
  const installed = versions.length > 0;
  const disabled =
    preferences.state === 0 || preferences.disableReasons.length > 0;
  const enabled = installed && preferences.registered && !disabled;

  return {
    extensionId,
    preferencesPath: preferences.preferencesPath,
    profilePath,
    extensionsDirectory,
    extensionPath,
    installed,
    registered: preferences.registered,
    enabled,
    disabled,
    exitCode: getExitCode({ enabled, installed }),
    state: preferences.state,
    disableReasons: preferences.disableReasons,
    versions,
  };
}

function getChromeExtensionPreferences(profilePath, extensionId) {
  const preferencesPaths = [
    path.join(profilePath, "Secure Preferences"),
    path.join(profilePath, "Preferences"),
  ];
  for (const preferencesPath of preferencesPaths) {
    const preferences = readJsonFileIfPresent(preferencesPath);
    const extensionSettings = preferences?.extensions?.settings?.[extensionId];
    if (!extensionSettings || typeof extensionSettings !== "object") continue;

    return {
      preferencesPath,
      registered: true,
      state:
        typeof extensionSettings.state === "number"
          ? extensionSettings.state
          : null,
      disableReasons: getDisableReasons(extensionSettings.disable_reasons),
    };
  }

  return {
    preferencesPath: null,
    registered: false,
    state: null,
    disableReasons: [],
  };
}

function getDisableReasons(disableReasons) {
  if (Array.isArray(disableReasons)) return disableReasons;
  if (typeof disableReasons === "number" && disableReasons !== 0)
    return [disableReasons];
  return [];
}

function readJsonFileIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isUsableChromeProfile(userDataDirectory, profileDirectory) {
  if (typeof profileDirectory !== "string" || profileDirectory.length === 0)
    return false;

  return fs.existsSync(
    path.join(userDataDirectory, profileDirectory, "Preferences"),
  );
}

function compareChromeProfileDirectories(first, second) {
  return (
    chromeProfileDirectorySortKey(first) - chromeProfileDirectorySortKey(second)
  );
}

function chromeProfileDirectorySortKey(profileDirectory) {
  if (profileDirectory === "Default") return 0;

  const match = profileDirectory.match(/^Profile (\d+)$/);
  if (!match) return -1;

  return Number(match[1]);
}

function getExitCode({ enabled, installed }) {
  if (enabled) return EXIT_INSTALLED_AND_ENABLED;
  if (installed) return EXIT_INSTALLED_NOT_ENABLED;
  return EXIT_NOT_INSTALLED;
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
    process.exit(EXIT_RUNTIME_ERROR);
  }

  const result = getChromeExtensionInstallStatus();
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Checked Chrome profile: ${result.profilePath}`);
    console.log(`Extension ID: ${result.extensionId}`);
    console.log(`Extension path: ${result.extensionPath}`);
    console.log(`Installed: ${result.installed ? "yes" : "no"}`);
    console.log(
      `Registered in Chrome preferences: ${result.registered ? "yes" : "no"}`,
    );
    console.log(`Enabled: ${result.enabled ? "yes" : "no"}`);
    if (result.disabled)
      console.log(`Disable reasons: ${result.disableReasons.join(", ")}`);
    if (result.versions.length > 0)
      console.log(`Installed versions: ${result.versions.join(", ")}`);
  }

  process.exit(result.exitCode);
}

void loadNodeModules()
  .then(() => {
    main();
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    (process || globalThis.process)?.exit(EXIT_RUNTIME_ERROR);
  });
