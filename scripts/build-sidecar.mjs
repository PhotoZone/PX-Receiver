import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const workerRoot = join(repoRoot, "worker");
const binariesRoot = join(repoRoot, "src-tauri", "binaries");
const isWindows = process.platform === "win32";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function resolvePython() {
  const python = isWindows
    ? join(workerRoot, ".venv", "Scripts", "python.exe")
    : join(workerRoot, ".venv", "bin", "python3");

  if (!existsSync(python)) {
    throw new Error(`Python worker virtualenv is missing at ${python}`);
  }

  return python;
}

function resolveTargetBinaryName() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      return "px-worker-aarch64-apple-darwin";
    }
    if (process.arch === "x64") {
      return "px-worker-x86_64-apple-darwin";
    }
  }

  if (process.platform === "win32" && process.arch === "x64") {
    return "px-worker-x86_64-pc-windows-msvc.exe";
  }

  if (process.platform === "linux" && process.arch === "x64") {
    return "px-worker-x86_64-unknown-linux-gnu";
  }

  throw new Error(`Unsupported sidecar target for ${process.platform}/${process.arch}`);
}

const python = resolvePython();
const distName = isWindows ? "px-worker.exe" : "px-worker";
const distBinary = join(workerRoot, "dist", distName);
const targetBinary = join(binariesRoot, resolveTargetBinaryName());

rmSync(join(workerRoot, "build"), { recursive: true, force: true });
rmSync(join(workerRoot, "dist"), { recursive: true, force: true });

run(python, ["-m", "pip", "install", "pyinstaller"], { cwd: workerRoot });
run(
  python,
  ["-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--name", "px-worker", "px_receiver/__main__.py"],
  { cwd: workerRoot },
);

if (!existsSync(distBinary)) {
  throw new Error(`Built worker binary was not created at ${distBinary}`);
}

mkdirSync(binariesRoot, { recursive: true });
copyFileSync(distBinary, targetBinary);

console.log(`Sidecar ready: ${targetBinary}`);
