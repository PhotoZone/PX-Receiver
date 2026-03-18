from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

from px_receiver.models import PrintInstructions

try:
    import win32api  # type: ignore[import-not-found]
    import win32print  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001
    win32api = None
    win32print = None


def extract_cups_job_id(output: str) -> str | None:
    match = re.search(r"request id is\s+([^\s]+)", output, re.IGNORECASE)
    if match:
        return match.group(1)
    return None


def print_pdf(pdf_path: Path, instructions: PrintInstructions | None) -> str | None:
    if instructions is None or not instructions.auto_print_pdf:
        return None

    copies = max(1, instructions.copies)
    printer_name = instructions.printer_name

    if sys.platform == "darwin":
        command = ["lp", "-n", str(copies)]
        if printer_name:
            command.extend(["-d", printer_name])
        command.append(str(pdf_path))
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        return extract_cups_job_id((result.stdout or "") + "\n" + (result.stderr or ""))

    if sys.platform.startswith("win"):
        print_pdf_windows(pdf_path, printer_name=printer_name, copies=copies)
        return None

    raise RuntimeError(f"PDF printing is not implemented for platform {sys.platform}")


def print_pdf_windows(pdf_path: Path, *, printer_name: str | None, copies: int) -> None:
    if not pdf_path.exists():
        raise RuntimeError(f"PDF file not found: {pdf_path}")

    selected_printer = printer_name or get_default_windows_printer()
    if selected_printer and not printer_exists_windows(selected_printer):
        raise RuntimeError(f"Printer not found on Windows machine: {selected_printer}")

    sumatra_path = get_sumatra_path()
    if sumatra_path:
        for _ in range(copies):
            command = [str(sumatra_path), "-silent"]
            if selected_printer:
                command.extend(["-print-to", selected_printer])
            else:
                command.append("-print-to-default")
            command.append(str(pdf_path))
            subprocess.run(command, check=True)
        return

    if selected_printer and win32api is not None:
        for _ in range(copies):
            win32api.ShellExecute(0, "printto", str(pdf_path), f'"{selected_printer}"', ".", 0)
        return

    if hasattr(os, "startfile"):
        for _ in range(copies):
            os.startfile(str(pdf_path), "print")  # type: ignore[attr-defined]
        return

    raise RuntimeError(
        "Windows printing is unavailable. Install SumatraPDF or ensure a Windows print handler is available."
    )


def get_sumatra_path() -> Path | None:
    if not sys.platform.startswith("win"):
        return None

    repo_worker_dir = Path(__file__).resolve().parents[2]
    candidates = [
        repo_worker_dir / "bin" / "SumatraPDF.exe",
        Path(sys.executable).resolve().parent / "SumatraPDF.exe",
    ]

    local_appdata = os.getenv("LOCALAPPDATA")
    if local_appdata:
        candidates.append(Path(local_appdata) / "SumatraPDF" / "SumatraPDF.exe")

    candidates.extend(
        [
            Path(r"C:\Program Files\SumatraPDF\SumatraPDF.exe"),
            Path(r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe"),
        ]
    )

    for candidate in candidates:
        if candidate.exists():
            return candidate

    return None


def printer_exists_windows(printer_name: str) -> bool:
    if win32print is None:
        return True

    return printer_name in get_available_windows_printers()


def get_available_windows_printers() -> list[str]:
    if win32print is None:
        return []

    printers = win32print.EnumPrinters(2)
    return [printer[2] for printer in printers]


def get_default_windows_printer() -> str | None:
    if win32print is None:
        return None

    try:
        return str(win32print.GetDefaultPrinter())
    except Exception:  # noqa: BLE001
        return None
