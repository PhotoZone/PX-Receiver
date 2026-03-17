from __future__ import annotations

import base64
import json
from abc import ABC, abstractmethod
from dataclasses import replace
from typing import Any
from urllib import error, parse, request

from px_receiver.models import AssetKind, AssetRecord, JobItemRecord, JobRecord, JobStatus, PrintInstructions, WorkerSettings, now_iso


class BackendClient(ABC):
    def __init__(self, settings: WorkerSettings) -> None:
        self.settings = settings

    @abstractmethod
    def register_machine(self) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def authenticate_machine(self) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def heartbeat(self) -> None:
        raise NotImplementedError

    @abstractmethod
    def fetch_jobs(self) -> list[JobRecord]:
        raise NotImplementedError

    @abstractmethod
    def claim_job(self, job_id: str) -> None:
        raise NotImplementedError

    @abstractmethod
    def update_job_status(self, job_id: str, status: JobStatus, message: str | None = None) -> None:
        raise NotImplementedError

    @abstractmethod
    def report_job_event(self, job_id: str, event_type: str, payload: dict[str, Any] | None = None) -> None:
        raise NotImplementedError

    @abstractmethod
    def download_asset(self, job: JobRecord, asset: AssetRecord) -> tuple[bytes, str]:
        raise NotImplementedError


class MockBackendClient(BackendClient):
    def __init__(self, settings: WorkerSettings) -> None:
        super().__init__(settings)
        self._jobs = [
            JobRecord(
                id="job-1001",
                order_id="PX-5001",
                source="mock",
                store_id="002",
                target_machine_id=settings.machine_id,
                target_location="Solihull",
                ordered_at=now_iso(),
                product_name="A1 Poster",
                printer="Fuji Lab",
                customer_name="Sarah Turner",
                customer_email="sarah@example.com",
                customer_phone="07700 900123",
                delivery_method="Royal Mail Tracked 24",
                shipment_id="shipment-5001",
                shipping_address_line1="12 Orchard Lane",
                shipping_address_line2=None,
                shipping_city="Solihull",
                shipping_postcode="B91 1AA",
                shipping_country="GB",
                items=[
                    JobItemRecord(name="A1 Poster", quantity=1, finish="Gloss", border="Borderless"),
                ],
                assets=[
                    AssetRecord(id="asset-1", kind=AssetKind.IMAGE, filename="poster-front.jpg"),
                    AssetRecord(id="asset-2", kind=AssetKind.PDF, filename="ticket.pdf"),
                ],
                status=JobStatus.PENDING,
                assigned_machine=settings.machine_id,
                print_instructions=PrintInstructions(auto_print_pdf=False, printer_name=None, copies=1),
            ),
            JobRecord(
                id="job-1002",
                order_id="PX-5002",
                source="mock",
                store_id="001",
                target_machine_id=settings.machine_id,
                target_location="Stratford",
                ordered_at=now_iso(),
                product_name="Window Vinyl",
                printer="Large Format",
                customer_name="Chris Patel",
                customer_email="chris@example.com",
                customer_phone="07700 900456",
                delivery_method="DPD Next Day",
                shipment_id="shipment-5002",
                shipping_address_line1="84 High Street",
                shipping_address_line2="Unit 4",
                shipping_city="Birmingham",
                shipping_postcode="B1 2CD",
                shipping_country="GB",
                items=[
                    JobItemRecord(name="Window Vinyl", quantity=2, finish="Matte", border="White Border"),
                    JobItemRecord(name="Install Guide", quantity=1),
                ],
                assets=[
                    AssetRecord(id="asset-3", kind=AssetKind.IMAGE, filename="window-vinyl.png"),
                    AssetRecord(id="asset-4", kind=AssetKind.IMAGE, filename="installation-guide.jpg"),
                    AssetRecord(id="asset-5", kind=AssetKind.PDF, filename="job-sheet.pdf"),
                ],
                status=JobStatus.PENDING,
                assigned_machine=settings.machine_id,
                print_instructions=PrintInstructions(auto_print_pdf=False, printer_name=None, copies=1),
            ),
        ]
        self._claimed: set[str] = set()

    def register_machine(self) -> dict[str, Any]:
        return {"machineId": self.settings.machine_id, "registeredAt": now_iso()}

    def authenticate_machine(self) -> dict[str, Any]:
        return {"authenticated": True, "machine": {"machine_id": self.settings.machine_id}}

    def heartbeat(self) -> None:
        return None

    def fetch_jobs(self) -> list[JobRecord]:
        return [replace(job) for job in self._jobs]

    def claim_job(self, job_id: str) -> None:
        self._claimed.add(job_id)

    def update_job_status(self, job_id: str, status: JobStatus, message: str | None = None) -> None:
        for index, job in enumerate(self._jobs):
            if job.id == job_id:
                self._jobs[index] = replace(
                    job,
                    status=status,
                    last_error=message if status == JobStatus.FAILED else None,
                    updated_at=now_iso(),
                    attempts=job.attempts + 1 if status == JobStatus.FAILED else job.attempts,
                )
                return

    def report_job_event(self, job_id: str, event_type: str, payload: dict[str, Any] | None = None) -> None:
        return None

    def download_asset(self, job: JobRecord, asset: AssetRecord) -> tuple[bytes, str]:
        if asset.kind == AssetKind.PDF:
            content = (
                "%PDF-1.4\n"
                "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
                "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n"
                "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R>>endobj\n"
                "4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 36 96 Td (PX Receiver Mock PDF) Tj ET\nendstream endobj\n"
                "xref\n0 5\n0000000000 65535 f \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n0\n%%EOF"
            ).encode()
            return content, "application/pdf"

        content = f"Mock asset for {job.id}/{asset.filename}\nGenerated by PX Receiver worker.\n".encode()
        return content, "application/octet-stream"


class HttpBackendClient(BackendClient):
    def __init__(self, settings: WorkerSettings) -> None:
        super().__init__(settings)
        self._bootstrap_headers = self._build_headers(settings.api_token)
        self._machine_headers = self._build_headers(settings.machine_auth_token or settings.api_token)

    def register_machine(self) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/machines/register",
            {
                "name": self.settings.machine_name,
                "machine_name": self.settings.machine_name,
                "machine_id": self.settings.machine_id,
            },
            headers=self._bootstrap_headers,
        )

    def authenticate_machine(self) -> dict[str, Any]:
        token = self.settings.machine_auth_token or self.settings.api_token
        return self._request(
            "POST",
            "/api/machines/auth",
            {"machine_id": self.settings.machine_id, "token": token},
            headers=self._machine_headers,
        )

    def heartbeat(self) -> None:
        self._request("POST", "/api/heartbeat", {"machine_id": self.settings.machine_id}, headers=self._machine_headers)

    def fetch_jobs(self) -> list[JobRecord]:
        payload = self._request("GET", f"/api/jobs?{parse.urlencode({'machine_id': self.settings.machine_id})}", headers=self._machine_headers)
        jobs: list[JobRecord] = []
        for item in payload.get("results", []):
            jobs.append(_job_from_payload(item, self.settings.machine_id))
        return jobs

    def claim_job(self, job_id: str) -> None:
        self._request("POST", f"/api/jobs/{job_id}/claim", {"machine_id": self.settings.machine_id}, headers=self._machine_headers)

    def update_job_status(self, job_id: str, status: JobStatus, message: str | None = None) -> None:
        self._request(
            "POST",
            f"/api/jobs/{job_id}/status",
            {"status": status.value, "message": message, "machine_id": self.settings.machine_id},
            headers=self._machine_headers,
        )

    def report_job_event(self, job_id: str, event_type: str, payload: dict[str, Any] | None = None) -> None:
        self._request(
            "POST",
            f"/api/jobs/{job_id}/events",
            {
                "event_type": event_type,
                "payload": payload or {},
                "machine_id": self.settings.machine_id,
            },
            headers=self._machine_headers,
        )

    def download_asset(self, job: JobRecord, asset: AssetRecord) -> tuple[bytes, str]:
        if asset.download_url:
            endpoint = asset.download_url
            payload = self._request_url("GET", endpoint)
            if isinstance(payload, dict) and "content" in payload:
                raw = base64.b64decode(payload["content"])
                return raw, payload.get("contentType", asset.content_type or "application/octet-stream")
            raise RuntimeError(f"Asset download response for {asset.filename} did not contain content")

        endpoint = f"/api/jobs/{job.id}/download?{parse.urlencode({'asset_id': asset.id})}"
        download_endpoint = f"/api/jobs/{job.id}/download?{parse.urlencode({'asset_id': asset.id, 'machine_id': self.settings.machine_id})}"
        payload = self._request("GET", download_endpoint, headers=self._machine_headers)
        raw = base64.b64decode(payload["content"])
        return raw, payload.get("content_type", asset.content_type or "application/octet-stream")

    def _build_headers(self, token: str) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def _request(self, method: str, endpoint: str, payload: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> dict[str, Any]:
        url = f"{self.settings.backend_url.rstrip('/')}{endpoint}"
        return self._request_url(method, url, payload, headers=headers)

    def _request_url(self, method: str, url: str, payload: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload).encode()
        req = request.Request(
            url,
            data=body,
            headers=headers or self._machine_headers,
            method=method,
        )
        try:
            with request.urlopen(req, timeout=20) as response:
                raw = response.read().decode()
                return json.loads(raw) if raw else {}
        except error.HTTPError as exc:
            raise RuntimeError(f"HTTP {exc.code} from backend: {exc.reason}") from exc
        except error.URLError as exc:
            raise RuntimeError(f"Backend connection failed: {exc.reason}") from exc


def build_backend_client(settings: WorkerSettings) -> BackendClient:
    return MockBackendClient(settings) if settings.use_mock_backend else HttpBackendClient(settings)


def _job_from_payload(item: dict[str, Any], machine_id: str) -> JobRecord:
    assets = [
        AssetRecord(
            id=str(asset.get("id", asset.get("filename", "asset"))),
            kind=AssetKind.from_payload(asset.get("kind", AssetKind.OTHER.value)),
            filename=asset.get("filename", "asset.bin"),
            download_url=asset.get("download_url") or asset.get("downloadUrl"),
            content_type=asset.get("content_type") or asset.get("contentType"),
            local_path=asset.get("local_path") or asset.get("localPath"),
        )
        for asset in item.get("assets", [])
    ]

    print_payload = item.get("print") or item.get("print_instructions") or {}
    print_instructions = PrintInstructions(
        auto_print_pdf=bool(print_payload.get("auto_print_pdf", print_payload.get("autoPrintPdf", False))),
        printer_name=print_payload.get("printer_name") or print_payload.get("printerName"),
        copies=int(print_payload.get("copies", 1)),
    )

    item_payloads = item.get("items") or item.get("line_items") or item.get("order_items") or []

    return JobRecord(
        id=str(item["id"]),
        order_id=str(item.get("order_id", item.get("orderId", ""))),
        source=item.get("source"),
        store_id=item.get("store_id", item.get("storeId")),
        target_machine_id=item.get("target_machine_id", item.get("targetMachineId")),
        target_location=item.get("target_location", item.get("targetLocation")),
        ordered_at=item.get("ordered_at", item.get("orderedAt", item.get("order_date", item.get("orderDate")))),
        product_name=item.get("product_name", item.get("productName", "Unknown product")),
        printer=item.get("printer"),
        customer_name=item.get("customer_name", item.get("customerName")) or item.get("contact_name") or item.get("contactName"),
        customer_email=item.get("customer_email", item.get("customerEmail")) or item.get("contact_email") or item.get("contactEmail"),
        customer_phone=item.get("customer_phone", item.get("customerPhone")) or item.get("contact_phone") or item.get("contactPhone"),
        delivery_method=item.get("delivery_method", item.get("deliveryMethod")) or item.get("shipping_method") or item.get("shippingMethod"),
        shipment_id=item.get("shipment_id", item.get("shipmentId")),
        shipping_address_line1=item.get("shipping_address_line1", item.get("shippingAddressLine1")),
        shipping_address_line2=item.get("shipping_address_line2", item.get("shippingAddressLine2")),
        shipping_city=item.get("shipping_city", item.get("shippingCity")),
        shipping_postcode=item.get("shipping_postcode", item.get("shippingPostcode")),
        shipping_country=item.get("shipping_country", item.get("shippingCountry")),
        items=[JobItemRecord.from_payload(payload) for payload in item_payloads],
        assets=assets,
        status=JobStatus(item.get("status", JobStatus.PENDING.value)),
        assigned_machine=item.get("assigned_machine", item.get("assignedMachine", machine_id)),
        local_path=item.get("local_path") or item.get("localPath"),
        local_paths=item.get("local_paths") or item.get("localPaths") or {},
        print_instructions=print_instructions if assets else None,
        last_error=item.get("last_error") or item.get("lastError"),
        updated_at=item.get(
            "updated_at",
            item.get("updatedAt", item.get("status_updated_at", item.get("statusUpdatedAt", now_iso()))),
        ),
        created_at=item.get("created_at", item.get("createdAt", now_iso())),
        attempts=int(item.get("attempts", 0)),
    )
