from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from px_receiver.models import AssetKind, AssetRecord, JobRecord, JobStatus, WorkerSettings
from px_receiver.services.backend import _job_from_payload
from px_receiver.worker import WorkerRuntime


class _FakeBackend:
    def __init__(self, jobs: list[JobRecord]) -> None:
        self.jobs = jobs

    def heartbeat(self) -> None:
        return None

    def fetch_jobs(self) -> list[JobRecord]:
        return self.jobs

    def claim_job(self, job_id: str) -> None:  # pragma: no cover - not used in these tests
        return None

    def update_job_status(self, job_id: str, status: JobStatus, message: str | None = None) -> None:  # pragma: no cover
        return None

    def report_job_event(self, job_id: str, event_type: str, payload: dict | None = None) -> None:  # pragma: no cover
        return None

    def download_asset(self, job: JobRecord, asset: AssetRecord) -> tuple[bytes, str]:  # pragma: no cover
        return b"", "application/octet-stream"


class _FakeScannerService:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs

    def start(self) -> None:
        return None

    def stop(self) -> None:
        return None


class ReceiverContractTests(unittest.TestCase):
    def test_job_payload_supports_photozone_and_non_wink_job_ids(self) -> None:
        job = _job_from_payload(
            {
                "id": "photozone-order-12345",
                "order_id": "PZ-10045",
                "source": "photozone",
                "storeId": "002",
                "targetMachineId": "002",
                "targetLocation": "Solihull",
                "product_name": "6x4 Print",
                "assets": [
                    {
                        "id": "asset-1",
                        "kind": "image",
                        "filename": "print.jpg",
                        "download_url": "https://example.com/asset-1",
                    }
                ],
                "status": "pending",
            },
            "002",
        )

        self.assertEqual(job.id, "photozone-order-12345")
        self.assertEqual(job.source, "photozone")
        self.assertEqual(job.store_id, "002")
        self.assertEqual(job.target_machine_id, "002")
        self.assertEqual(job.target_location, "Solihull")

    def test_polling_processes_photozone_jobs_without_local_location_matching(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "receiver-config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "backendUrl": "https://px.photozone.co.uk",
                        "machineId": "002",
                        "machineName": "PX Receiver 02",
                        "apiToken": "token",
                        "machineAuthToken": "machine-token",
                        "pollingIntervalSeconds": 20,
                        "downloadDirectory": temp_dir,
                        "hotFolderPath": temp_dir,
                        "photoPrintHotFolderPath": temp_dir,
                        "photoGiftHotFolderPath": temp_dir,
                        "largeFormatHotFolderPath": temp_dir,
                        "packingSlipPrinterName": "",
                        "shippingLabelPrinterName": "",
                        "useMockBackend": False,
                    }
                )
            )

            job = JobRecord(
                id="photozone-order-12345",
                order_id="PZ-10045",
                source="photozone",
                store_id="002",
                target_machine_id="002",
                target_location="Solihull",
                product_name="6x4 Print",
                printer="Fuji Lab",
                customer_name="Test Customer",
                customer_email=None,
                customer_phone=None,
                delivery_method="Royal Mail Tracked 24",
                shipment_id=None,
                shipping_address_line1=None,
                shipping_address_line2=None,
                shipping_city=None,
                shipping_postcode=None,
                shipping_country=None,
                items=[],
                assets=[AssetRecord(id="asset-1", kind=AssetKind.IMAGE, filename="print.jpg")],
                status=JobStatus.PENDING,
                assigned_machine="002",
            )

            received_job_ids: list[str] = []
            fake_backend = _FakeBackend([job])

            with patch("px_receiver.worker.build_backend_client", return_value=fake_backend), patch(
                "px_receiver.worker.ScannerService",
                _FakeScannerService,
            ):
                runtime = WorkerRuntime(config_path)
                runtime.emit = lambda *args, **kwargs: None
                runtime.emit_log = lambda *args, **kwargs: None
                runtime.emit_health = lambda *args, **kwargs: None
                runtime.receive_job = lambda next_job: received_job_ids.append(next_job.id)
                runtime.poll_once()

            self.assertEqual(received_job_ids, ["photozone-order-12345"])


if __name__ == "__main__":
    unittest.main()
