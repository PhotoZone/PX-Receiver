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
    backend_url: str = "https://backend.example.com"
    machine_id: str = "machine-demo-001"
    machine_name: str = "PX Receiver 01"
    api_token: str = ""
    shipstation_api_key: str = ""
    machine_auth_token: str = ""
    polling_interval_seconds: int = 20
    download_directory: str = "~/Downloads/px-orders"
    hot_folder_path: str = "~/HotFolders/px"
    photo_print_hot_folder_path: str = "//PICSERVER/C8Spool"
    photo_gift_hot_folder_path: str = "~/HotFolders/Sublimation"
    large_format_hot_folder_path: str = "~/HotFolders/Large Format"
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
