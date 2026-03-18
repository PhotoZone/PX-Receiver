import fs from "node:fs";
import path from "node:path";

const [, , nextVersion] = process.argv;

if (!nextVersion || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(nextVersion)) {
  console.error("Usage: node scripts/set-version.mjs <semver>");
  process.exit(1);
}

const root = process.cwd();

function updateJson(filePath) {
  const absolutePath = path.join(root, filePath);
  const payload = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  payload.version = nextVersion;
  if (filePath === "src-tauri/tauri.conf.json") {
    const updaterConfig = payload.plugins?.updater;
    if (updaterConfig) {
      updaterConfig.endpoints = [resolveUpdaterEndpoint()];
    }
  }
  fs.writeFileSync(absolutePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function resolveUpdaterEndpoint() {
  let assetName = "latest.json";

  if (process.platform === "darwin") {
    assetName = process.arch === "x64" ? "latest-macos-intel.json" : "latest-macos-apple-silicon.json";
  } else if (process.platform === "win32") {
    assetName = "latest-windows-x64.json";
  }

  return `https://github.com/PhotoZone/PX-Receiver/releases/latest/download/${assetName}`;
}

function updateCargoToml(filePath) {
  const absolutePath = path.join(root, filePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  const pattern = /(^|\n)version = ".*?"(\r?\n|$)/;
  if (!pattern.test(source)) {
    throw new Error(`Could not update version in ${filePath}`);
  }

  const updated = source.replace(pattern, `$1version = "${nextVersion}"$2`);
  fs.writeFileSync(absolutePath, updated);
}

updateJson("package.json");
updateJson("src-tauri/tauri.conf.json");
updateCargoToml("src-tauri/Cargo.toml");

console.log(`Set app version to ${nextVersion}`);
