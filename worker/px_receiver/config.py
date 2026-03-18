from __future__ import annotations

import json
import os
from pathlib import Path

from px_receiver.models import WorkerSettings


def load_settings(config_path: Path) -> WorkerSettings:
    defaults = WorkerSettings()
    if not config_path.exists():
        settings = defaults
        save_settings(config_path, settings)
        return settings

    payload = json.loads(config_path.read_text())
    legacy_large_format_input = payload.get("largeFormatInputFolderPath")
    return WorkerSettings(
        backend_url=payload.get("backendUrl", defaults.backend_url),
        machine_id=payload.get("machineId", defaults.machine_id),
        machine_name=payload.get("machineName", defaults.machine_name),
        api_token=payload.get("apiToken", defaults.api_token),
        shipstation_api_key=payload.get("shipstationApiKey", defaults.shipstation_api_key),
        slack_webhook_url=payload.get("slackWebhookUrl", defaults.slack_webhook_url),
        scanner_mode=payload.get("scannerMode", defaults.scanner_mode),
        machine_auth_token=payload.get("machineAuthToken", defaults.machine_auth_token),
        polling_interval_seconds=int(payload.get("pollingIntervalSeconds", defaults.polling_interval_seconds)),
        download_directory=payload.get("downloadDirectory", defaults.download_directory),
        hot_folder_path=payload.get("hotFolderPath", defaults.hot_folder_path),
        photo_print_hot_folder_path=payload.get("photoPrintHotFolderPath", defaults.photo_print_hot_folder_path),
        photo_gift_hot_folder_path=payload.get("photoGiftHotFolderPath", defaults.photo_gift_hot_folder_path),
        large_format_hot_folder_path=payload.get("largeFormatHotFolderPath", defaults.large_format_hot_folder_path),
        large_format_photozone_input_folder_path=payload.get(
            "largeFormatPhotozoneInputFolderPath",
            legacy_large_format_input or defaults.large_format_photozone_input_folder_path,
        ),
        large_format_postsnap_input_folder_path=payload.get("largeFormatPostsnapInputFolderPath", defaults.large_format_postsnap_input_folder_path),
        large_format_output_folder_path=payload.get("largeFormatOutputFolderPath", defaults.large_format_output_folder_path),
        large_format_batching_interval_minutes=int(payload.get("largeFormatBatchingIntervalMinutes", defaults.large_format_batching_interval_minutes)),
        large_format_roll_width_in=float(payload.get("largeFormatRollWidthIn", defaults.large_format_roll_width_in)),
        large_format_gap_mm=float(payload.get("largeFormatGapMm", defaults.large_format_gap_mm)),
        large_format_leader_mm=float(payload.get("largeFormatLeaderMm", defaults.large_format_leader_mm)),
        large_format_trailer_mm=float(payload.get("largeFormatTrailerMm", defaults.large_format_trailer_mm)),
        large_format_left_margin_mm=float(payload.get("largeFormatLeftMarginMm", defaults.large_format_left_margin_mm)),
        large_format_max_batch_length_mm=float(payload.get("largeFormatMaxBatchLengthMm", defaults.large_format_max_batch_length_mm)),
        large_format_auto_send=bool(payload.get("largeFormatAutoSend", defaults.large_format_auto_send)),
        large_format_direct_print=bool(payload.get("largeFormatDirectPrint", defaults.large_format_direct_print)),
        large_format_printer_name=payload.get("largeFormatPrinterName", defaults.large_format_printer_name),
        large_format_auto_approve_enabled=bool(payload.get("largeFormatAutoApproveEnabled", defaults.large_format_auto_approve_enabled)),
        large_format_auto_approve_max_waste_percent=float(payload.get("largeFormatAutoApproveMaxWastePercent", defaults.large_format_auto_approve_max_waste_percent)),
        large_format_auto_border_if_light_edge=bool(payload.get("largeFormatAutoBorderIfLightEdge", defaults.large_format_auto_border_if_light_edge)),
        large_format_edge_border_mm=float(payload.get("largeFormatEdgeBorderMm", defaults.large_format_edge_border_mm)),
        large_format_print_filename_captions=bool(payload.get("largeFormatPrintFilenameCaptions", defaults.large_format_print_filename_captions)),
        large_format_filename_caption_height_mm=float(payload.get("largeFormatFilenameCaptionHeightMm", defaults.large_format_filename_caption_height_mm)),
        large_format_filename_caption_font_size_pt=float(payload.get("largeFormatFilenameCaptionFontSizePt", defaults.large_format_filename_caption_font_size_pt)),
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
        "shipstationApiKey": settings.shipstation_api_key,
        "slackWebhookUrl": settings.slack_webhook_url,
        "scannerMode": settings.scanner_mode,
        "machineAuthToken": settings.machine_auth_token,
        "pollingIntervalSeconds": settings.polling_interval_seconds,
        "downloadDirectory": settings.download_directory,
        "hotFolderPath": settings.hot_folder_path,
        "photoPrintHotFolderPath": settings.photo_print_hot_folder_path,
        "photoGiftHotFolderPath": settings.photo_gift_hot_folder_path,
        "largeFormatHotFolderPath": settings.large_format_hot_folder_path,
        "largeFormatPhotozoneInputFolderPath": settings.large_format_photozone_input_folder_path,
        "largeFormatPostsnapInputFolderPath": settings.large_format_postsnap_input_folder_path,
        "largeFormatOutputFolderPath": settings.large_format_output_folder_path,
        "largeFormatBatchingIntervalMinutes": settings.large_format_batching_interval_minutes,
        "largeFormatRollWidthIn": settings.large_format_roll_width_in,
        "largeFormatGapMm": settings.large_format_gap_mm,
        "largeFormatLeaderMm": settings.large_format_leader_mm,
        "largeFormatTrailerMm": settings.large_format_trailer_mm,
        "largeFormatLeftMarginMm": settings.large_format_left_margin_mm,
        "largeFormatMaxBatchLengthMm": settings.large_format_max_batch_length_mm,
        "largeFormatAutoSend": settings.large_format_auto_send,
        "largeFormatDirectPrint": settings.large_format_direct_print,
        "largeFormatPrinterName": settings.large_format_printer_name,
        "largeFormatAutoApproveEnabled": settings.large_format_auto_approve_enabled,
        "largeFormatAutoApproveMaxWastePercent": settings.large_format_auto_approve_max_waste_percent,
        "largeFormatAutoBorderIfLightEdge": settings.large_format_auto_border_if_light_edge,
        "largeFormatEdgeBorderMm": settings.large_format_edge_border_mm,
        "largeFormatPrintFilenameCaptions": settings.large_format_print_filename_captions,
        "largeFormatFilenameCaptionHeightMm": settings.large_format_filename_caption_height_mm,
        "largeFormatFilenameCaptionFontSizePt": settings.large_format_filename_caption_font_size_pt,
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
    path = Path(value).expanduser()

    # UNC and mapped-network paths on Windows can raise OSError 22 when forced
    # through resolve() even though the path string itself is valid.
    if os.name == "nt":
        return path

    return path.resolve()
