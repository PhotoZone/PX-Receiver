from __future__ import annotations

import sys
import threading
import time
from collections.abc import Callable
from typing import Any

from px_receiver.models import LogLevel

try:
    import serial
    import serial.tools.list_ports
except Exception:  # noqa: BLE001
    serial = None


ScanCallback = Callable[[str, str], None]
StatusCallback = Callable[[str, str | None], None]
LogCallback = Callable[[LogLevel, str, str], None]

SCANNER_KEYWORDS = (
    "scanner",
    "barcode",
    "honeywell",
    "zebra",
    "symbol",
    "datalogic",
    "socket",
    "ch340",
    "ch341",
    "wch",
    "usb-serial",
    "usb serial",
    "serial",
    "prolific",
    "ftdi",
)

SYSTEM_PORT_PREFIXES = (
    "/dev/cu.debug",
    "/dev/cu.Bluetooth",
    "/dev/tty.Bluetooth",
)


class WindowsSerialScannerListener:
    """Existing Windows serial/COM scanner flow, intentionally kept unchanged."""

    def __init__(
        self,
        *,
        on_scan: ScanCallback,
        on_status: StatusCallback,
        on_log: LogCallback,
        baudrate: int = 9600,
    ) -> None:
        self.on_scan = on_scan
        self.on_status = on_status
        self.on_log = on_log
        self.baudrate = baudrate
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2.5)
        self.thread = None

    def _run(self) -> None:
        if serial is None:
            self.on_status("unavailable", None)
            self.on_log(LogLevel.WARNING, "pyserial is not installed; scanner support disabled", "scanner")
            return

        while not self.stop_event.is_set():
            port_name = self._find_scanner_port()
            if not port_name:
                self.on_status("disconnected", None)
                time.sleep(5)
                continue

            self.on_status("connected", port_name)
            self.on_log(LogLevel.INFO, f"Scanner connected on {port_name}", "scanner")

            try:
                with serial.Serial(port_name, self.baudrate, timeout=1) as connection:
                    while not self.stop_event.is_set():
                        raw = connection.readline().decode("utf-8", errors="ignore").strip()
                        if not raw:
                            continue
                        self.on_scan(raw, port_name)
            except Exception as exc:  # noqa: BLE001
                self.on_status("error", port_name)
                self.on_log(LogLevel.ERROR, f"Scanner read failed on {port_name}: {exc}", "scanner")
                time.sleep(3)

    def _find_scanner_port(self) -> str | None:
        assert serial is not None
        ports = sorted(
            serial.tools.list_ports.comports(),
            key=self._port_priority,
            reverse=True,
        )
        for port in ports:
            if not self._looks_like_scanner_port(port):
                continue
            try:
                with serial.Serial(port.device, self.baudrate, timeout=1):
                    return port.device
            except Exception:
                continue
        return None

    def _looks_like_scanner_port(self, port: Any) -> bool:
        device = str(getattr(port, "device", "") or "")
        if any(device.startswith(prefix) for prefix in SYSTEM_PORT_PREFIXES):
            return False

        searchable = " ".join(
            str(value or "").lower()
            for value in (
                getattr(port, "description", ""),
                getattr(port, "manufacturer", ""),
                getattr(port, "product", ""),
                getattr(port, "hwid", ""),
            )
        )

        if any(keyword in searchable for keyword in SCANNER_KEYWORDS):
            return True

        # Trust generic USB serial bridges on Windows if they expose a plausible
        # device label, even when the scanner vendor name itself is missing.
        has_usb_identity = getattr(port, "vid", None) is not None or getattr(port, "pid", None) is not None
        descriptive_label = getattr(port, "description", "") not in {"", "n/a", None}
        return bool(has_usb_identity and descriptive_label)

    def _port_priority(self, port: Any) -> int:
        searchable = " ".join(
            str(value or "").lower()
            for value in (
                getattr(port, "device", ""),
                getattr(port, "description", ""),
                getattr(port, "manufacturer", ""),
                getattr(port, "product", ""),
                getattr(port, "hwid", ""),
            )
        )

        score = 0
        if any(keyword in searchable for keyword in SCANNER_KEYWORDS):
            score += 10
        if getattr(port, "vid", None) is not None or getattr(port, "pid", None) is not None:
            score += 5
        if str(getattr(port, "device", "") or "").upper().startswith("COM"):
            score += 2
        return score


class ScannerService:
    def __init__(
        self,
        *,
        on_scan: ScanCallback,
        on_status: StatusCallback,
        on_log: LogCallback,
        baudrate: int = 9600,
    ) -> None:
        self.on_scan = on_scan
        self.on_status = on_status
        self.on_log = on_log
        self.baudrate = baudrate
        self.delegate: WindowsSerialScannerListener | Any | None = None

    def start(self) -> None:
        if self.delegate is not None:
            return

        if sys.platform == "win32":
            self.on_log(LogLevel.INFO, "Scanner platform selected: Windows COM-port listener", "scanner")
            self.delegate = WindowsSerialScannerListener(
                on_scan=self.on_scan,
                on_status=self.on_status,
                on_log=self.on_log,
                baudrate=self.baudrate,
            )
        elif sys.platform == "darwin":
            from px_receiver.services.scanner_mac import MacHIDScannerListener

            self.on_log(LogLevel.INFO, "Scanner platform selected: macOS HID keyboard listener", "scanner")
            self.delegate = MacHIDScannerListener(
                on_scan=self.on_scan,
                on_status=self.on_status,
                on_log=self.on_log,
            )
        else:
            self.on_status("unavailable", None)
            self.on_log(
                LogLevel.WARNING,
                f"Scanner support is only available on Windows COM ports or macOS HID mode. Unsupported platform: {sys.platform}",
                "scanner",
            )
            return

        self.delegate.start()

    def stop(self) -> None:
        if self.delegate is None:
            return
        self.delegate.stop()
        self.delegate = None
