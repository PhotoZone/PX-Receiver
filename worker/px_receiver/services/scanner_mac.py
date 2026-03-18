from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable

from px_receiver.models import LogLevel

try:
    from pynput import keyboard
except Exception:  # noqa: BLE001
    keyboard = None


ScanCallback = Callable[[str, str], None]
StatusCallback = Callable[[str, str | None], None]
LogCallback = Callable[[LogLevel, str, str], None]

SCANNER_PREFIX = "@@"
SCANNER_TERMINATOR = "enter"
MAX_INTERKEY_GAP_SECONDS = 0.12
DUPLICATE_DEBOUNCE_SECONDS = 1.5
PERMISSION_HINT = (
    "macOS scanner mode requires Input Monitoring permission. "
    "Enable it in System Settings > Privacy & Security > Input Monitoring, "
    "then relaunch PX Receiver."
)


class MacHIDScannerListener:
    """Global macOS HID listener for keyboard-mode barcode scanners.

    The Tera HW0009 is configured with a distinct prefix and Enter suffix so
    we can ignore normal typing and only forward fast scanner bursts.
    """

    def __init__(
        self,
        *,
        on_scan: ScanCallback,
        on_status: StatusCallback,
        on_log: LogCallback,
    ) -> None:
        self.on_scan = on_scan
        self.on_status = on_status
        self.on_log = on_log
        self.lock = threading.Lock()
        self.listener: keyboard.Listener | None = None if keyboard else None
        self.buffer: list[str] = []
        self.last_key_at = 0.0
        self.last_scan_code = ""
        self.last_scan_at = 0.0
        self.debug_enabled = os.environ.get("PX_RECEIVER_DEBUG", "").strip().lower() in {"1", "true", "yes", "on"}

    def start(self) -> None:
        if keyboard is None:
            self.on_status("unavailable", None)
            self.on_log(LogLevel.WARNING, "pynput is not installed; macOS scanner support disabled", "scanner")
            return
        if self.listener is not None:
            return

        try:
            self.listener = keyboard.Listener(on_press=self._on_press, suppress=False)
            self.listener.start()
            self.on_status("connected", "macOS HID keyboard listener")
            self.on_log(
                LogLevel.INFO,
                "Mac listener started. Expecting Tera HW0009 in HID mode with @@ prefix and Enter suffix.",
                "scanner",
            )
        except Exception as exc:  # noqa: BLE001
            self.listener = None
            self.on_status("error", None)
            self.on_log(LogLevel.WARNING, f"{PERMISSION_HINT} Listener error: {exc}", "scanner")

    def stop(self) -> None:
        listener = self.listener
        self.listener = None
        if listener is not None:
            listener.stop()
            try:
                listener.join(timeout=2.5)
            except RuntimeError:
                pass
        with self.lock:
            self.buffer.clear()
            self.last_key_at = 0.0

    def _log_debug(self, message: str) -> None:
        if self.debug_enabled:
            self.on_log(LogLevel.INFO, message, "scanner")

    def _reset_buffer_locked(self, reason: str) -> None:
        if self.buffer:
            self._log_debug(f"Scanner buffer reset due to {reason}.")
        self.buffer.clear()
        self.last_key_at = 0.0

    def _on_press(self, key: object) -> None:
        now = time.monotonic()
        with self.lock:
            if self.last_key_at and now - self.last_key_at > MAX_INTERKEY_GAP_SECONDS:
                self._reset_buffer_locked("slow typing")

            token = self._normalize_key(key)
            if token is None:
                return

            if token == "<backspace>":
                if self.buffer:
                    self.buffer.pop()
                self.last_key_at = now
                return

            if token == "<enter>":
                self._finalize_scan_locked()
                self.last_key_at = 0.0
                return

            self.buffer.append(token)
            self.last_key_at = now

    def _normalize_key(self, key: object) -> str | None:
        if keyboard is None:
            return None
        if key == keyboard.Key.enter:
            return "<enter>"
        if key == keyboard.Key.backspace:
            return "<backspace>"

        char = getattr(key, "char", None)
        if char is None:
            return None

        if char in {"\r", "\n"}:
            return "<enter>"
        if char == "\b":
            return "<backspace>"
        return char

    def _finalize_scan_locked(self) -> None:
        raw_value = "".join(self.buffer).strip()
        self.buffer.clear()
        if not raw_value:
            return
        if not raw_value.startswith(SCANNER_PREFIX):
            self._log_debug(f"Ignored non-scanner input without prefix: {raw_value!r}")
            return

        barcode = raw_value[len(SCANNER_PREFIX):].strip()
        if not barcode:
            self._log_debug("Ignored scanner burst with empty payload after prefix.")
            return

        now = time.monotonic()
        if barcode == self.last_scan_code and now - self.last_scan_at <= DUPLICATE_DEBOUNCE_SECONDS:
            self.on_log(LogLevel.INFO, f"Duplicate scan suppressed: {barcode}", "scanner")
            return

        self.last_scan_code = barcode
        self.last_scan_at = now
        self.on_log(LogLevel.INFO, f"Valid scan received from macOS HID listener: {barcode}", "scanner")

        try:
            self.on_scan(barcode, "mac-hid")
        except Exception as exc:  # noqa: BLE001
            self.on_log(LogLevel.ERROR, f"Downstream processing failure for {barcode}: {exc}", "scanner")
        else:
            self.on_log(LogLevel.INFO, f"Downstream processing completed for {barcode}", "scanner")
