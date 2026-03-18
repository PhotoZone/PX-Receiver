# PX Receiver Worker

This package contains the local Python worker process launched by the Tauri desktop shell.

It is intentionally separate from the Next.js UI so filesystem and machine-specific operations stay outside the frontend.

## macOS scanner mode

- Windows continues to use the existing COM-port scanner path exactly as before.
- On macOS, scanner input uses a global HID keyboard listener via `pynput`.
- The Tera HW0009 must be configured in HID mode with prefix `@@` and suffix `Enter`.
- PX Receiver requires Input Monitoring permission on macOS:
  `System Settings > Privacy & Security > Input Monitoring`
- The macOS listener only accepts fast prefixed scanner bursts and ignores normal typing as much as possible before handing the barcode into the existing downstream label/scan processing flow.
