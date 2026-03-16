# PX Receiver

Cross-platform desktop receiver for downloading and processing new PX order jobs locally on macOS and Windows.

This starter is built around three explicit layers:

- `src-tauri/`: native desktop host, system tray behavior, worker lifecycle, and UI bridge
- `apps/desktop/`: Next.js App Router UI rendered inside Tauri
- `worker/`: Python sidecar responsible for polling, downloading, writing files, and status reporting

## File Tree

```text
.
|-- README.md
|-- apps
|   `-- desktop
|       |-- app
|       |   |-- globals.css
|       |   |-- jobs/page.tsx
|       |   |-- layout.tsx
|       |   |-- logs/page.tsx
|       |   |-- page.tsx
|       |   `-- settings/page.tsx
|       |-- components
|       |   |-- app-shell.tsx
|       |   |-- dashboard-view.tsx
|       |   |-- jobs-view.tsx
|       |   |-- logs-view.tsx
|       |   |-- settings-view.tsx
|       |   |-- sidebar.tsx
|       |   `-- status-badge.tsx
|       |-- lib
|       |   |-- defaults.ts
|       |   |-- tauri.ts
|       |   |-- use-worker-store.ts
|       |   `-- utils.ts
|       |-- types/app.ts
|       |-- eslint.config.mjs
|       |-- next.config.ts
|       |-- package.json
|       |-- postcss.config.js
|       |-- tailwind.config.ts
|       `-- tsconfig.json
|-- docs
|   `-- architecture.md
|-- package.json
|-- src-tauri
|   |-- Cargo.toml
|   |-- build.rs
|   |-- src
|   |   |-- lib.rs
|   |   |-- main.rs
|   |   `-- worker.rs
|   `-- tauri.conf.json
`-- worker
    |-- README.md
    |-- pyproject.toml
    `-- px_receiver
        |-- __init__.py
        |-- __main__.py
        |-- config.py
        |-- models.py
        |-- state.py
        |-- worker.py
        `-- services
            |-- backend.py
            `-- filesystem.py
```

## What Works In This Starter

- machine registration/auth bootstrap
- polling loop with pause/resume
- mock backend adapter with a real HTTP adapter boundary ready for Django
- job claiming, file download, local disk writes, hot-folder copy
- job status transitions: `pending`, `downloading`, `downloaded`, `processing`, `completed`, `failed`
- retry flow for failed jobs
- desktop dashboard, jobs, logs, and settings screens
- Tauri tray behavior with hide/open/quit actions
- JSON event bridge from Python worker to the Next.js UI through Rust
- persisted worker config and local processed-job state

## Development Setup

### 1. Install toolchains

- Node.js 20+
- Rust stable with Tauri prerequisites
- Python 3.11+

macOS Tauri prerequisites: install Xcode Command Line Tools.

Windows Tauri prerequisites: install Microsoft C++ Build Tools and WebView2 runtime.

### 2. Install JavaScript dependencies

```bash
npm install
```

### 3. Install the Python worker in a virtual environment

```bash
cd worker
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cd ..
```

On Windows PowerShell:

```powershell
cd worker
py -3.11 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e .
cd ..
```

### 4. Run in desktop development mode

From the repo root:

```bash
npm run tauri:dev
```

This starts the Next.js dev server, launches the Tauri shell, and spawns the Python worker with `python3 -m px_receiver --config ...` on macOS or `python -m px_receiver --config ...` on Windows.

## Build And Packaging

### Web build

```bash
npm run build:web
```

### Package the Python sidecar

For production packaging, compile the worker into a standalone binary and place it in `src-tauri/binaries/` using the platform-specific filenames Tauri expects:

- macOS Apple Silicon: `src-tauri/binaries/px-worker-aarch64-apple-darwin`
- Windows x64: `src-tauri/binaries/px-worker-x86_64-pc-windows-msvc.exe`

Example with PyInstaller:

```bash
cd worker
source .venv/bin/activate
pip install pyinstaller
pyinstaller --onefile --name px-worker px_receiver/__main__.py
```

Copy the generated executable into `src-tauri/binaries/` and rename it to the expected target filename before running `tauri build`.

### Desktop package

```bash
npm run tauri:build
```

### CI builds

GitHub Actions can build both desktop targets from the same repo without a local Windows machine:

- run the `Build Desktop` workflow manually from the Actions tab
- or push a tag like `v0.1.0`

The workflow builds:

- macOS on `macos-14`, uploading `.app` and `.dmg` artifacts
- Windows on `windows-2022`, uploading `.msi` and NSIS `.exe` artifacts

When triggered by a tag like `v0.1.0`, the workflow also publishes stable GitHub Release assets:

- `PX-Receiver-macOS.dmg`
- `PX-Receiver-Windows-x64.msi`
- `PX-Receiver-Windows-x64-setup.exe`

That makes these permanent latest-version links usable from PX:

- `https://github.com/PhotoZone/PX-Receiver/releases/latest/download/PX-Receiver-macOS.dmg`
- `https://github.com/PhotoZone/PX-Receiver/releases/latest/download/PX-Receiver-Windows-x64.msi`
- `https://github.com/PhotoZone/PX-Receiver/releases/latest/download/PX-Receiver-Windows-x64-setup.exe`

## Platform Notes

### macOS

- Menu bar / tray behavior is handled by Tauri. Closing the window hides the app instead of stopping the worker.
- Use notarization/signing later in CI for distribution builds.
- The worker writes config and local state to the Tauri app config directory.

### Windows

- The same codebase packages separately for Windows once the sidecar is built for Windows.
- WebView2 must be present on the target machine.
- Paths are handled in Python via `pathlib`, so folder mapping logic stays cross-platform.
- PDF printing on Windows now supports:
  - explicit named-printer printing via SumatraPDF when available
  - default-printer fallback via Windows shell handlers
- For reliable silent PDF printing in packaged Windows builds, bundle `SumatraPDF.exe` next to the worker or in `worker/bin/`.

## Backend Integration Notes

The Python worker is the only layer that talks to the backend. The UI does not directly own order download logic or filesystem access.

Current adapters:

- `MockBackendClient`: local starter behavior for UI and worker testing
- `HttpBackendClient`: real HTTP boundary for Django endpoints such as:
  - `POST /api/machines/register`
  - `POST /api/machines/auth`
  - `GET /api/jobs?machine_id=...`
  - `POST /api/jobs/{id}/claim`
  - `POST /api/jobs/{id}/status`
  - `GET /api/jobs/{id}/download`
  - `POST /api/heartbeat`

To connect to Django, replace endpoint payload mapping in [backend.py](/Users/danielwragg/Library/Mobile Documents/com~apple~CloudDocs/Scripts/downloader/worker/px_receiver/services/backend.py) and switch `Use mock backend` off in the Settings screen.

## Operational Design Summary

- Tauri manages the desktop window, tray, lifecycle, and worker process bridge.
- Next.js renders the operator UI and sends control commands through Tauri commands.
- Python handles polling, claiming, downloading, local writes, duplicate avoidance, retries, and backend updates.

More detail is in [architecture.md](/Users/danielwragg/Library/Mobile Documents/com~apple~CloudDocs/Scripts/downloader/docs/architecture.md).
