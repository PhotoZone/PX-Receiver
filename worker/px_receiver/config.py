from __future__ import annotations

import json
from pathlib import Path

from px_receiver.models import WorkerSettings


def load_settings(config_path: Path) -> WorkerSettings:
    defaults = WorkerSettings()
    if not config_path.exists():
        settings = defaults
        save_settings(config_path, settings)
        return settings

    payload = json.loads(config_path.read_text())
    return WorkerSettings(
        backend_url=payload.get("backendUrl", defaults.backend_url),
        machine_id=payload.get("machineId", defaults.machine_id),
        machine_name=payload.get("machineName", defaults.machine_name),
        api_token=payload.get("apiToken", defaults.api_token),
        machine_auth_token=payload.get("machineAuthToken", defaults.machine_auth_token),
        polling_interval_seconds=int(payload.get("pollingIntervalSeconds", defaults.polling_interval_seconds)),
        download_directory=payload.get("downloadDirectory", defaults.download_directory),
        hot_folder_path=payload.get("hotFolderPath", defaults.hot_folder_path),
        photo_print_hot_folder_path=payload.get("photoPrintHotFolderPath", defaults.photo_print_hot_folder_path),
        photo_gift_hot_folder_path=payload.get("photoGiftHotFolderPath", defaults.photo_gift_hot_folder_path),
        large_format_hot_folder_path=payload.get("largeFormatHotFolderPath", defaults.large_format_hot_folder_path),
        packing_slip_printer_name=payload.get("packingSlipPrinterName", defaults.packing_slip_printer_name),
        shipping_label_printer_name=payload.get("shippingLabelPrinterName", defaults.shipping_label_printer_name),
        use_mock_backend=bool(payload.get("useMockBackend", defaults.use_mock_backend)),
    )


def save_settings(config_path: Path, settings: WorkerSettings) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "backendUrl": settings.backend_url,
        "machineId": settings.machine_id,
        "machineName": settings.machine_name,
        "apiToken": settings.api_token,
        "machineAuthToken": settings.machine_auth_token,
        "pollingIntervalSeconds": settings.polling_interval_seconds,
        "downloadDirectory": settings.download_directory,
        "hotFolderPath": settings.hot_folder_path,
        "photoPrintHotFolderPath": settings.photo_print_hot_folder_path,
        "photoGiftHotFolderPath": settings.photo_gift_hot_folder_path,
        "largeFormatHotFolderPath": settings.large_format_hot_folder_path,
        "packingSlipPrinterName": settings.packing_slip_printer_name,
        "shippingLabelPrinterName": settings.shipping_label_printer_name,
        "useMockBackend": settings.use_mock_backend,
    }
    config_path.write_text(json.dumps(payload, indent=2))


def build_runtime_paths(config_path: Path) -> dict[str, Path]:
    root = config_path.parent
    state_path = root / "receiver-state.json"
    log_path = root / "worker.log"
    return {
        "config": config_path,
        "state": state_path,
        "log": log_path,
    }


def expand_path(value: str) -> Path:
    return Path(value).expanduser().resolve()
