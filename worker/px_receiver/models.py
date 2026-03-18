from __future__ import annotations

from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any
from uuid import uuid4


def now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class HealthState(StrEnum):
    HEALTHY = "healthy"
    PAUSED = "paused"
    ERROR = "error"
    OFFLINE = "offline"
    PROCESSING = "processing"


class JobStatus(StrEnum):
    PENDING = "pending"
    DOWNLOADING = "downloading"
    DOWNLOADED = "downloaded"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class LogLevel(StrEnum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class LargeFormatJobStatus(StrEnum):
    WAITING = "waiting"
    NEEDS_REVIEW = "needs_review"
    BATCHED = "batched"
    READY = "ready"
    FAILED = "failed"


class LargeFormatBatchStatus(StrEnum):
    PENDING = "pending"
    READY = "ready"
    APPROVED = "approved"
    PRINTING = "printing"
    SENT = "sent"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AssetKind(StrEnum):
    IMAGE = "image"
    PDF = "pdf"
    CONTROL = "control"
    OTHER = "other"

    @classmethod
    def from_payload(cls, value: Any) -> "AssetKind":
        normalized = str(value or cls.OTHER.value).strip().lower()
        if normalized == cls.IMAGE.value:
            return cls.IMAGE
        if normalized == cls.PDF.value:
            return cls.PDF
        if normalized == cls.CONTROL.value:
            return cls.OTHER
        return cls.OTHER


@dataclass(slots=True)
class WorkerSettings:
    backend_url: str = "https://px.photozone.co.uk"
    machine_id: str = "machine-demo-001"
    machine_name: str = "PX Receiver 01"
    api_token: str = ""
    shipstation_api_key: str = ""
    slack_webhook_url: str = ""
    scanner_mode: str = "auto"
    machine_auth_token: str = ""
    polling_interval_seconds: int = 20
    download_directory: str = "~/Downloads/px-orders"
    hot_folder_path: str = "~/HotFolders/px"
    photo_print_hot_folder_path: str = "//PICSERVER/C8Spool"
    photo_gift_hot_folder_path: str = "~/HotFolders/Sublimation"
    large_format_hot_folder_path: str = "~/HotFolders/Large Format"
    large_format_photozone_input_folder_path: str = "~/HotFolders/Photo Zone Large Format Hot Folder"
    large_format_postsnap_input_folder_path: str = "~/HotFolders/Postsnap Large Format Hot Folder"
    large_format_output_folder_path: str = "~/HotFolders/Large Format/Output"
    large_format_batching_interval_minutes: int = 10
    large_format_roll_width_in: float = 36.0
    large_format_gap_mm: float = 8.0
    large_format_leader_mm: float = 50.0
    large_format_trailer_mm: float = 50.0
    large_format_left_margin_mm: float = 5.0
    large_format_max_batch_length_mm: float = 1750.0
    large_format_auto_send: bool = False
    large_format_direct_print: bool = False
    large_format_printer_name: str = ""
    large_format_auto_approve_enabled: bool = True
    large_format_auto_approve_max_waste_percent: float = 20.0
    large_format_auto_border_if_light_edge: bool = True
    large_format_edge_border_mm: float = 1.0
    large_format_print_filename_captions: bool = True
    large_format_filename_caption_height_mm: float = 6.0
    large_format_filename_caption_font_size_pt: float = 9.0
    packing_slip_printer_name: str = ""
    shipping_label_printer_name: str = ""
    use_mock_backend: bool = True

    def to_payload(self) -> dict[str, Any]:
        return to_camel_dict(self)


@dataclass(slots=True)
class AssetRecord:
    id: str
    kind: AssetKind
    filename: str
    download_url: str | None = None
    content_type: str | None = None
    local_path: str | None = None
    thumbnail_path: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return to_camel_dict(self)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "AssetRecord":
        return cls(
            id=str(payload.get("id", "")),
            kind=AssetKind.from_payload(payload.get("kind", AssetKind.OTHER.value)),
            filename=payload.get("filename", "asset.bin"),
            download_url=payload.get("downloadUrl") or payload.get("download_url"),
            content_type=payload.get("contentType") or payload.get("content_type"),
            local_path=payload.get("localPath") or payload.get("local_path"),
            thumbnail_path=payload.get("thumbnailPath") or payload.get("thumbnail_path"),
        )


@dataclass(slots=True)
class PrintInstructions:
    auto_print_pdf: bool = False
    printer_name: str | None = None
    copies: int = 1

    def to_payload(self) -> dict[str, Any]:
        return to_camel_dict(self)

    @classmethod
    def from_payload(cls, payload: dict[str, Any] | None) -> "PrintInstructions | None":
        if not payload:
            return None
        return cls(
            auto_print_pdf=bool(payload.get("autoPrintPdf", payload.get("auto_print_pdf", False))),
            printer_name=payload.get("printerName") or payload.get("printer_name"),
            copies=int(payload.get("copies", 1)),
        )


@dataclass(slots=True)
class JobItemRecord:
    name: str
    quantity: int = 1
    finish: str | None = None
    border: str | None = None
    image_url: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return to_camel_dict(self)

    @classmethod
    def from_payload(cls, payload: dict[str, Any] | str) -> "JobItemRecord":
        if isinstance(payload, str):
            return cls(name=payload)

        border_value = payload.get("border")
        if isinstance(border_value, bool):
            border_value = "Borderless" if border_value is False else "Border"

        return cls(
            name=str(payload.get("name", payload.get("productName", payload.get("product_name", "Item")))),
            quantity=int(payload.get("quantity", 1) or 1),
            finish=payload.get("finish"),
            border=border_value,
            image_url=payload.get("imageUrl", payload.get("image_url")),
        )


@dataclass(slots=True)
class ScanRecord:
    id: str
    code: str
    source: str
    timestamp: str = field(default_factory=now_iso)
    status: str = "captured"
    message: str | None = None
    job_id: str | None = None
    order_id: str | None = None
    can_reprint_label: bool = False
    shipping_label_path: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return to_camel_dict(self)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "ScanRecord":
        return cls(
            id=str(payload.get("id", "")),
            code=str(payload.get("code", "")),
            source=str(payload.get("source", "")),
            timestamp=payload.get("timestamp", now_iso()),
            status=payload.get("status", "captured"),
            message=payload.get("message"),
            job_id=payload.get("jobId", payload.get("job_id")),
            order_id=payload.get("orderId", payload.get("order_id")),
            can_reprint_label=bool(payload.get("canReprintLabel", payload.get("can_reprint_label", False))),
            shipping_label_path=payload.get("shippingLabelPath", payload.get("shipping_label_path")),
        )


@dataclass(slots=True)
class ScannerState:
    status: str = "disabled"
    port: str | None = None
    last_scan_at: str | None = None
    last_code: str | None = None
    recent_scans: list[ScanRecord] = field(default_factory=list)

    def to_payload(self) -> dict[str, Any]:
        return to_camel_dict(self)


@dataclass(slots=True)
class JobRecord:
    id: str
    order_id: str
    source: str | None
    store_id: str | None
    target_machine_id: str | None
    target_location: str | None
    ordered_at: str | None
    product_name: str
    printer: str | None
    customer_name: str | None
    customer_email: str | None
    customer_phone: str | None
    delivery_method: str | None
    shipment_id: str | None
    shipping_label_path: str | None
    shipping_address_line1: str | None
    shipping_address_line2: str | None
    shipping_city: str | None
    shipping_postcode: str | None
    shipping_country: str | None
    items: list[JobItemRecord]
    assets: list[AssetRecord]
    status: JobStatus
    assigned_machine: str
    local_path: str | None = None
    local_paths: dict[str, str] = field(default_factory=dict)
    print_instructions: PrintInstructions | None = None
    last_error: str | None = None
    updated_at: str = field(default_factory=now_iso)
    created_at: str = field(default_factory=now_iso)
    attempts: int = 0

    def to_payload(self) -> dict[str, Any]:
        return to_camel_dict(self)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "JobRecord":
        return cls(
            id=str(payload.get("id", "")),
            order_id=str(payload.get("orderId", payload.get("order_id", ""))),
            source=payload.get("source"),
            store_id=payload.get("storeId", payload.get("store_id")),
            target_machine_id=payload.get("targetMachineId", payload.get("target_machine_id")),
            target_location=payload.get("targetLocation", payload.get("target_location")),
            ordered_at=payload.get("orderedAt", payload.get("ordered_at")),
            product_name=payload.get("productName", payload.get("product_name", "Unknown product")),
            printer=payload.get("printer"),
            customer_name=payload.get("customerName", payload.get("customer_name")),
            customer_email=payload.get("customerEmail", payload.get("customer_email")),
            customer_phone=payload.get("customerPhone", payload.get("customer_phone")),
            delivery_method=payload.get("deliveryMethod", payload.get("delivery_method")),
            shipment_id=payload.get("shipmentId", payload.get("shipment_id")),
            shipping_label_path=payload.get("shippingLabelPath", payload.get("shipping_label_path")),
            shipping_address_line1=payload.get("shippingAddressLine1", payload.get("shipping_address_line1")),
            shipping_address_line2=payload.get("shippingAddressLine2", payload.get("shipping_address_line2")),
            shipping_city=payload.get("shippingCity", payload.get("shipping_city")),
            shipping_postcode=payload.get("shippingPostcode", payload.get("shipping_postcode")),
            shipping_country=payload.get("shippingCountry", payload.get("shipping_country")),
            items=[JobItemRecord.from_payload(item) for item in payload.get("items", [])],
            assets=[AssetRecord.from_payload(asset) for asset in payload.get("assets", [])],
            status=JobStatus(payload.get("status", JobStatus.PENDING.value)),
            assigned_machine=payload.get("assignedMachine", payload.get("assigned_machine", "")),
            local_path=payload.get("localPath") or payload.get("local_path"),
            local_paths=payload.get("localPaths") or payload.get("local_paths") or {},
            print_instructions=PrintInstructions.from_payload(payload.get("printInstructions") or payload.get("print_instructions")),
            last_error=payload.get("lastError") or payload.get("last_error"),
            updated_at=payload.get("updatedAt", payload.get("updated_at", now_iso())),
            created_at=payload.get("createdAt", payload.get("created_at", now_iso())),
            attempts=int(payload.get("attempts", 0)),
        )


@dataclass(slots=True)
class LogRecord:
    level: LogLevel
    message: str
    scope: str
    id: str = field(default_factory=lambda: str(uuid4()))
    timestamp: str = field(default_factory=now_iso)

    def to_payload(self) -> dict[str, Any]:
        return to_camel_dict(self)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "LogRecord":
        return cls(
            id=str(payload.get("id", str(uuid4()))),
            timestamp=payload.get("timestamp", now_iso()),
            level=LogLevel(payload.get("level", LogLevel.INFO.value)),
            message=payload.get("message", ""),
            scope=payload.get("scope", "worker"),
        )


@dataclass(slots=True)
class LargeFormatPlacement:
    job_id: str
    filename: str
    x_mm: float
    y_mm: float
    placed_width_mm: float
    placed_height_mm: float
    rotated: bool = False
    sort_order: int = 0
    add_black_border: bool = False

    def to_payload(self) -> dict[str, Any]:
        return to_camel_dict(self)


@dataclass(slots=True)
class LargeFormatJob:
    id: str
    filename: str
    original_path: str
    width_in: float | None
    height_in: float | None
    media_type: str = "lustre"
    quantity: int = 1
    source: str = "unknown"
    status: LargeFormatJobStatus = LargeFormatJobStatus.WAITING
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    parse_source: str | None = None
    notes: str | None = None
    needs_border: bool = False
    batch_id: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return to_camel_dict(self)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "LargeFormatJob":
        return cls(
            id=str(payload.get("id", "")),
            filename=str(payload.get("filename", "")),
            original_path=str(payload.get("originalPath", payload.get("original_path", ""))),
            width_in=float(payload["widthIn"]) if payload.get("widthIn") is not None else None,
            height_in=float(payload["heightIn"]) if payload.get("heightIn") is not None else None,
            media_type=str(payload.get("mediaType", payload.get("media_type", "lustre")) or "lustre"),
            quantity=int(payload.get("quantity", 1) or 1),
            source=str(payload.get("source", "unknown") or "unknown"),
            status=LargeFormatJobStatus(payload.get("status", LargeFormatJobStatus.WAITING.value)),
            created_at=payload.get("createdAt", payload.get("created_at", now_iso())),
            updated_at=payload.get("updatedAt", payload.get("updated_at", now_iso())),
            parse_source=payload.get("parseSource", payload.get("parse_source")),
            notes=payload.get("notes"),
            needs_border=bool(payload.get("needsBorder", payload.get("needs_border", False))),
            batch_id=payload.get("batchId", payload.get("batch_id")),
        )


@dataclass(slots=True)
class LargeFormatBatch:
    id: str
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    status: LargeFormatBatchStatus = LargeFormatBatchStatus.PENDING
    media_type: str = "lustre"
    roll_width_in: float = 36.0
    gap_mm: float = 8.0
    leader_mm: float = 50.0
    trailer_mm: float = 50.0
    caption_height_mm: float = 0.0
    used_length_mm: float = 0.0
    waste_percent: float = 0.0
    output_pdf_path: str | None = None
    hot_folder_sent_at: str | None = None
    notes: str | None = None
    placements: list[LargeFormatPlacement] = field(default_factory=list)

    def to_payload(self) -> dict[str, Any]:
        return to_camel_dict(self)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "LargeFormatBatch":
        return cls(
            id=str(payload.get("id", "")),
            created_at=payload.get("createdAt", payload.get("created_at", now_iso())),
            updated_at=payload.get("updatedAt", payload.get("updated_at", now_iso())),
            status=LargeFormatBatchStatus(payload.get("status", LargeFormatBatchStatus.PENDING.value)),
            media_type=str(payload.get("mediaType", payload.get("media_type", "lustre")) or "lustre"),
            roll_width_in=float(payload.get("rollWidthIn", payload.get("roll_width_in", 36.0)) or 36.0),
            gap_mm=float(payload.get("gapMm", payload.get("gap_mm", 8.0)) or 8.0),
            leader_mm=float(payload.get("leaderMm", payload.get("leader_mm", 50.0)) or 50.0),
            trailer_mm=float(payload.get("trailerMm", payload.get("trailer_mm", 50.0)) or 50.0),
            caption_height_mm=float(payload.get("captionHeightMm", payload.get("caption_height_mm", 0.0)) or 0.0),
            used_length_mm=float(payload.get("usedLengthMm", payload.get("used_length_mm", 0.0)) or 0.0),
            waste_percent=float(payload.get("wastePercent", payload.get("waste_percent", 0.0)) or 0.0),
            output_pdf_path=payload.get("outputPdfPath", payload.get("output_pdf_path")),
            hot_folder_sent_at=payload.get("hotFolderSentAt", payload.get("hot_folder_sent_at")),
            notes=payload.get("notes"),
            placements=[
                LargeFormatPlacement(
                    job_id=str(item.get("jobId", item.get("job_id", ""))),
                    filename=str(item.get("filename", "")),
                    x_mm=float(item.get("xMm", item.get("x_mm", 0.0)) or 0.0),
                    y_mm=float(item.get("yMm", item.get("y_mm", 0.0)) or 0.0),
                    placed_width_mm=float(item.get("placedWidthMm", item.get("placed_width_mm", 0.0)) or 0.0),
                    placed_height_mm=float(item.get("placedHeightMm", item.get("placed_height_mm", 0.0)) or 0.0),
                    rotated=bool(item.get("rotated", False)),
                    sort_order=int(item.get("sortOrder", item.get("sort_order", 0)) or 0),
                    add_black_border=bool(item.get("addBlackBorder", item.get("add_black_border", False))),
                )
                for item in payload.get("placements", [])
            ],
        )


@dataclass(slots=True)
class LargeFormatActivity:
    event: str
    message: str
    level: LogLevel = LogLevel.INFO
    id: str = field(default_factory=lambda: str(uuid4()))
    timestamp: str = field(default_factory=now_iso)

    def to_payload(self) -> dict[str, Any]:
        return to_camel_dict(self)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "LargeFormatActivity":
        return cls(
            id=str(payload.get("id", str(uuid4()))),
            timestamp=payload.get("timestamp", now_iso()),
            event=str(payload.get("event", "event")),
            message=str(payload.get("message", "")),
            level=LogLevel(payload.get("level", LogLevel.INFO.value)),
        )


@dataclass(slots=True)
class LargeFormatState:
    jobs: list[LargeFormatJob] = field(default_factory=list)
    batches: list[LargeFormatBatch] = field(default_factory=list)
    activity: list[LargeFormatActivity] = field(default_factory=list)
    active_batch_id: str | None = None
    last_scan_at: str | None = None
    last_processed_at: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "jobs": [job.to_payload() for job in self.jobs],
            "batches": [batch.to_payload() for batch in self.batches],
            "activity": [entry.to_payload() for entry in self.activity],
            "activeBatchId": self.active_batch_id,
            "lastScanAt": self.last_scan_at,
            "lastProcessedAt": self.last_processed_at,
        }


@dataclass(slots=True)
class WorkerSnapshot:
    health: HealthState
    polling_paused: bool
    queue_count: int
    last_sync_at: str | None
    active_job_id: str | None
    current_activity: str
    settings: WorkerSettings
    scanner: ScannerState
    jobs: list[JobRecord]
    logs: list[LogRecord]
    large_format: LargeFormatState = field(default_factory=LargeFormatState)

    def to_payload(self) -> dict[str, Any]:
        return {
            "health": self.health.value,
            "pollingPaused": self.polling_paused,
            "queueCount": self.queue_count,
            "lastSyncAt": self.last_sync_at,
            "activeJobId": self.active_job_id,
            "currentActivity": self.current_activity,
            "settings": self.settings.to_payload(),
            "scanner": self.scanner.to_payload(),
            "jobs": [job.to_payload() for job in self.jobs],
            "logs": [log.to_payload() for log in self.logs],
            "largeFormat": self.large_format.to_payload(),
        }


def to_camel_dict(instance: Any) -> dict[str, Any]:
    raw = asdict(instance)
    payload: dict[str, Any] = {}
    for key, value in raw.items():
        camel = snake_to_camel(key)
        payload[camel] = serialize_value(value)
    return payload


def serialize_value(value: Any) -> Any:
    if isinstance(value, StrEnum):
        return value.value
    if isinstance(value, dict):
        return {snake_to_camel(str(key)): serialize_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [serialize_value(item) for item in value]
    if is_dataclass(value):
        return to_camel_dict(value)
    return value


def snake_to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return "".join([head, *[part.capitalize() for part in tail]])
