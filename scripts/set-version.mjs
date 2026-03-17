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
  fs.writeFileSync(absolutePath, `${JSON.stringify(payload, null, 2)}\n`);
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
