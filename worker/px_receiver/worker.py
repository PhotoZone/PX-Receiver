from __future__ import annotations

import argparse
import json
import queue
import sys
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from px_receiver.config import build_runtime_paths, load_settings, save_settings
from uuid import uuid4

from px_receiver.models import AssetKind, AssetRecord, HealthState, JobRecord, JobStatus, LogLevel, LogRecord, PrintInstructions, ScanRecord, ScannerState, WorkerSettings, WorkerSnapshot, now_iso
from px_receiver.services.backend import BackendClient, build_backend_client
from px_receiver.services.filesystem import prune_working_directories, release_asset_to_hot_folder, write_job_asset
from px_receiver.services.printer import print_pdf
from px_receiver.services.scanner import ScannerService
from px_receiver.services.shipstation import create_shipping_label_pdf
from px_receiver.state import LocalState


class WorkerRuntime:
    def __init__(self, config_path: Path) -> None:
        self.config_path = config_path
        self.paths = build_runtime_paths(config_path)
        self.settings = load_settings(config_path)
        self.local_state = LocalState.load(self.paths["state"])
        hydrated_jobs = self.reconcile_hydrated_jobs(self.local_state.hydrate_jobs())
        hydrated_jobs = self.purge_mock_jobs(hydrated_jobs, persist_changes=True)
        self.snapshot = WorkerSnapshot(
            health=HealthState.OFFLINE,
            polling_paused=False,
            queue_count=0,
            last_sync_at=None,
            active_job_id=None,
            current_activity="Starting worker",
            settings=self.settings,
            scanner=ScannerState(),
            jobs=hydrated_jobs,
            logs=self.local_state.hydrate_logs(),
        )
        prune_working_directories(self.settings, self.snapshot.jobs)
        hydrated_scans = self.local_state.hydrate_scans()
        self.snapshot.scanner = ScannerState(
            recent_scans=hydrated_scans,
            last_scan_at=hydrated_scans[0].timestamp if hydrated_scans else None,
            last_code=hydrated_scans[0].code if hydrated_scans else None,
        )
        self.snapshot.queue_count = sum(
            1 for item in self.snapshot.jobs if item.status in {JobStatus.PENDING, JobStatus.DOWNLOADING, JobStatus.DOWNLOADED, JobStatus.PROCESSING}
        )
        self.backend = build_backend_client(self.settings)
        self.command_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self.stop_event = threading.Event()
        self.retry_queue: set[str] = set()
        self.next_poll_at = 0.0
        self.scanner = ScannerService(
            on_scan=self.handle_scan,
            on_status=self.handle_scanner_status,
            on_log=self.emit_log,
        )

    def is_mock_job(self, job: JobRecord) -> bool:
        return job.source == "mock" or job.id in {"job-1001", "job-1002"}

    def purge_mock_jobs(self, jobs: list[JobRecord], *, persist_changes: bool) -> list[JobRecord]:
        if self.settings.use_mock_backend:
            return jobs

        filtered_jobs = [job for job in jobs if not self.is_mock_job(job)]
        if not persist_changes or len(filtered_jobs) == len(jobs):
            return filtered_jobs

        self.local_state.jobs = []
        for job in filtered_jobs:
            self.local_state.remember_job(job)
        for job_id in ["job-1001", "job-1002"]:
            self.local_state.processed_jobs.pop(job_id, None)
            self.local_state.retries.pop(job_id, None)
            self.local_state.clear_inflight(job_id)
        self.local_state.save(self.paths["state"])
        return filtered_jobs

    def reconcile_hydrated_jobs(self, jobs: list[JobRecord]) -> list[JobRecord]:
        reconciled: list[JobRecord] = []
        updated = False

        for job in jobs:
            inflight = self.local_state.inflight_actions.get(job.id)
            original_job = None
            if inflight and isinstance(inflight.get("originalJob"), dict):
                try:
                    original_job = JobRecord.from_payload(inflight["originalJob"])
                except Exception:  # noqa: BLE001
                    original_job = None
            asset_local_paths = {
                asset.filename: asset.local_path
                for asset in job.assets
                if asset.local_path and Path(asset.local_path).exists()
            }
            all_assets_local = bool(job.assets) and len(asset_local_paths) == len(job.assets)
            primary_local_path = next(iter(asset_local_paths.values()), job.local_path)
            next_job = job

            if asset_local_paths and (job.local_paths != asset_local_paths or job.local_path != primary_local_path):
                next_job = replace(
                    next_job,
                    local_paths=asset_local_paths,
                    local_path=primary_local_path,
                )
                updated = True

            if next_job.status == JobStatus.DOWNLOADING and all_assets_local:
                next_job = replace(
                    next_job,
                    status=JobStatus.DOWNLOADED,
                    updated_at=now_iso(),
                )
                updated = True

            if inflight:
                kind = str(inflight.get("kind", "")).strip().lower()
                if kind == "recover":
                    if all_assets_local:
                        next_job = replace(
                            next_job,
                            status=original_job.status if original_job else next_job.status,
                            updated_at=now_iso(),
                            last_error=None,
                        )
                    else:
                        next_job = replace(
                            original_job or next_job,
                            updated_at=now_iso(),
                            last_error="PX recovery was interrupted before all files finished downloading. Try loading the order from PX again.",
                        )
                    self.local_state.clear_inflight(job.id)
                    updated = True
                elif kind == "reprint":
                    if all_assets_local:
                        next_job = replace(
                            next_job,
                            status=JobStatus.DOWNLOADED,
                            updated_at=now_iso(),
                            last_error="Previous reprint was interrupted before dispatch. Files are ready locally for another reprint.",
                        )
                    else:
                        next_job = replace(
                            original_job or next_job,
                            updated_at=now_iso(),
                            last_error="Previous reprint was interrupted before the refreshed files finished downloading. Reprint again to retry.",
                        )
                    self.local_state.clear_inflight(job.id)
                    updated = True
                elif kind == "receive" and not all_assets_local:
                    next_job = replace(
                        original_job or next_job,
                        status=JobStatus.FAILED,
                        updated_at=now_iso(),
                        last_error="Receive was interrupted before all files finished downloading. Retry the job to continue.",
                    )
                    self.local_state.clear_inflight(job.id)
                    updated = True
                elif kind == "receive" and all_assets_local:
                    self.local_state.clear_inflight(job.id)
                    updated = True

            reconciled.append(next_job)

        if updated:
            self.local_state.jobs = []
            for job in reconciled:
                self.local_state.remember_job(job)
            self.local_state.save(self.paths["state"])

        return reconciled

    def emit(self, event_type: str, payload: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps({"type": event_type, "payload": payload}) + "\n")
        sys.stdout.flush()

    def emit_snapshot(self) -> None:
        self.emit("snapshot", self.snapshot.to_payload())

    def emit_log(self, level: LogLevel, message: str, scope: str = "worker") -> None:
        log = LogRecord(level=level, message=message, scope=scope)
        self.snapshot.logs.insert(0, log)
        self.snapshot.logs = self.snapshot.logs[:250]
        self.local_state.remember_log(log)
        self.local_state.save(self.paths["state"])
        self.emit("log", log.to_payload())

    def emit_scan(self, scan: ScanRecord) -> None:
        self.snapshot.scanner.recent_scans = [scan, *self.snapshot.scanner.recent_scans][:50]
        self.snapshot.scanner.last_scan_at = scan.timestamp
        self.snapshot.scanner.last_code = scan.code
        self.local_state.remember_scan(scan)
        self.local_state.save(self.paths["state"])
        self.emit("scan", scan.to_payload())

    def emit_scanner_status(self) -> None:
        self.emit("scanner", self.snapshot.scanner.to_payload())

    def emit_job(self, job: JobRecord) -> None:
        self.snapshot.jobs = [existing for existing in self.snapshot.jobs if existing.id != job.id]
        self.snapshot.jobs.insert(0, job)
        self.snapshot.jobs = self.snapshot.jobs[:150]
        self.snapshot.queue_count = sum(
            1 for item in self.snapshot.jobs if item.status in {JobStatus.PENDING, JobStatus.DOWNLOADING, JobStatus.DOWNLOADED, JobStatus.PROCESSING}
        )
        self.local_state.remember_job(job)
        self.local_state.save(self.paths["state"])
        prune_working_directories(self.settings, self.local_state.hydrate_jobs())
        self.emit("job", job.to_payload())

    def emit_health(self) -> None:
        self.emit(
            "health",
            {
                "health": self.snapshot.health.value,
                "pollingPaused": self.snapshot.polling_paused,
                "activeJobId": self.snapshot.active_job_id,
                "currentActivity": self.snapshot.current_activity,
                "lastSyncAt": self.snapshot.last_sync_at,
                "queueCount": self.snapshot.queue_count,
            },
        )

    def update_snapshot(self, **kwargs: Any) -> None:
        for key, value in kwargs.items():
            setattr(self.snapshot, key, value)
        self.emit_health()

    def configure_backend(self) -> None:
        self.backend = build_backend_client(self.settings)

    def safe_backend_update_job_status(self, job_id: str, status: JobStatus, message: str | None = None) -> bool:
        try:
            self.backend.update_job_status(job_id, status, message)
            return True
        except Exception as exc:  # noqa: BLE001
            self.emit_log(
                LogLevel.WARNING,
                f"Backend status update failed for {job_id} -> {status.value}: {exc}",
                "backend",
            )
            return False

    def safe_backend_report_job_event(
        self,
        job_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
    ) -> bool:
        try:
            self.backend.report_job_event(job_id, event_type, payload)
            return True
        except Exception as exc:  # noqa: BLE001
            self.emit_log(
                LogLevel.WARNING,
                f"Backend event report failed for {job_id} ({event_type}): {exc}",
                "backend",
            )
            return False

    def handle_scanner_status(self, status: str, port: str | None) -> None:
        self.snapshot.scanner.status = status
        self.snapshot.scanner.port = port
        self.emit_scanner_status()

    def find_job_for_scan(self, code: str) -> JobRecord | None:
        normalized = str(code or "").strip()
        if not normalized:
            return None

        normalized_lower = normalized.casefold()
        for job in self.snapshot.jobs:
            candidates = {
                str(job.order_id or "").strip(),
                str(job.shipment_id or "").strip(),
                str(job.id or "").strip(),
            }
            candidates = {candidate for candidate in candidates if candidate}
            if any(candidate.casefold() == normalized_lower for candidate in candidates):
                return job

        return None

    def handle_scan(self, code: str, source: str) -> None:
        matched_job = self.find_job_for_scan(code)
        if matched_job is None:
            scan = ScanRecord(
                id=str(uuid4()),
                code=code,
                source=source,
                status="unmatched",
                message="Barcode received, but no matching job was found.",
            )
            self.emit_log(LogLevel.WARNING, f"Barcode scanned with no matching job: {code}", "scanner")
            self.emit_scan(scan)
            return

        scan = ScanRecord(
            id=str(uuid4()),
            code=code,
            source=source,
            status="matched",
            message=f"Matched {matched_job.order_id}; printing label.",
        )
        self.emit_log(LogLevel.INFO, f"Barcode scanned: {code}", "scanner")
        self.emit_scan(scan)
        self.safe_backend_report_job_event(
            matched_job.id,
            "scan_confirmed",
            {
                "scanned_at": now_iso(),
                "scan_code": code,
                "machine_id": self.settings.machine_id,
            },
        )
        self.print_shipping_label(matched_job.id)

    def register(self) -> None:
        try:
            if self.settings.machine_auth_token:
                self.backend.authenticate_machine()
                self.snapshot.health = HealthState.HEALTHY
                self.snapshot.current_activity = "Connected to backend"
                self.emit_log(LogLevel.INFO, "Authenticated using saved machine token", "auth")
                self.emit_snapshot()
                return
        except Exception as exc:
            self.emit_log(LogLevel.WARNING, f"Saved machine token rejected, falling back to registration: {exc}", "auth")
            self.settings = replace(self.settings, machine_auth_token="")
            save_settings(self.config_path, self.settings)
            self.configure_backend()

        registration = self.backend.register_machine()
        issued_token = str(registration.get("token") or "").strip()
        if issued_token and issued_token != self.settings.machine_auth_token:
            self.settings = replace(self.settings, machine_auth_token=issued_token)
            self.snapshot.settings = self.settings
            save_settings(self.config_path, self.settings)
            self.configure_backend()
            self.emit_log(LogLevel.INFO, "Stored issued machine token from backend registration", "auth")
        self.snapshot.health = HealthState.HEALTHY
        self.snapshot.current_activity = "Connected to backend"
        self.emit_log(LogLevel.INFO, "Machine registration/authenticated session initialized", "auth")
        self.emit_snapshot()

    def start_command_listener(self) -> None:
        def read_commands() -> None:
            for line in sys.stdin:
                raw = line.strip()
                if not raw:
                    continue
                try:
                    self.command_queue.put(json.loads(raw))
                except json.JSONDecodeError:
                    self.emit_log(LogLevel.WARNING, f"Discarded invalid command payload: {raw}", "bridge")

        thread = threading.Thread(target=read_commands, daemon=True)
        thread.start()

    def apply_command(self, command: dict[str, Any]) -> None:
        name = command.get("command")
        if name == "pause":
            self.snapshot.polling_paused = True
            self.snapshot.health = HealthState.PAUSED
            self.snapshot.current_activity = "Receiving orders, output paused"
            self.emit_log(LogLevel.INFO, "Output paused from desktop UI", "control")
            self.emit_health()
            return

        if name == "resume":
            self.snapshot.polling_paused = False
            self.snapshot.health = HealthState.HEALTHY
            self.snapshot.current_activity = "Receiving and dispatching output"
            self.emit_log(LogLevel.INFO, "Output resumed from desktop UI", "control")
            self.emit_health()
            return

        if name == "poll_now":
            self.snapshot.current_activity = "Refreshing queue"
            if not self.snapshot.polling_paused:
                self.snapshot.health = HealthState.PROCESSING
            self.emit_log(LogLevel.INFO, "Manual refresh requested from desktop UI", "control")
            self.emit_health()
            try:
                self.poll_once()
                self.next_poll_at = time.time() + self.settings.polling_interval_seconds
            except Exception as exc:  # noqa: BLE001
                self.snapshot.health = HealthState.ERROR
                self.snapshot.current_activity = "Receive error"
                self.emit_log(LogLevel.ERROR, f"Manual refresh failed: {exc}", "poller")
                self.emit_health()
            return

        if name == "retry_job":
            job_id = str(command.get("job_id", ""))
            if job_id:
                self.retry_queue.add(job_id)
                self.local_state.retries[job_id] = self.local_state.retries.get(job_id, 0) + 1
                self.local_state.save(self.paths["state"])
                self.emit_log(LogLevel.INFO, f"Queued retry for job {job_id}", "control")
            return

        if name == "recover_job":
            payload = command.get("job")
            if isinstance(payload, dict):
                self.recover_job(JobRecord.from_payload(payload))
            return

        if name == "reprint_job":
            job_id = str(command.get("job_id", ""))
            if job_id:
                self.reprint_job(job_id)
            return

        if name == "print_packing_slip":
            job_id = str(command.get("job_id", ""))
            if job_id:
                self.print_packing_slip(job_id)
            return

        if name == "print_label":
            job_id = str(command.get("job_id", ""))
            if job_id:
                self.print_shipping_label(job_id)
            return

        if name == "force_complete_job":
            job_id = str(command.get("job_id", ""))
            if job_id:
                self.force_complete_job(job_id)
            return

        if name == "update_settings":
            was_using_mock_backend = self.settings.use_mock_backend
            payload = command.get("settings", {})
            self.settings = WorkerSettings(
                backend_url=payload.get("backendUrl", self.settings.backend_url),
                machine_id=payload.get("machineId", self.settings.machine_id),
                machine_name=payload.get("machineName", self.settings.machine_name),
                api_token=payload.get("apiToken", self.settings.api_token),
                machine_auth_token=payload.get("machineAuthToken", self.settings.machine_auth_token),
                polling_interval_seconds=int(payload.get("pollingIntervalSeconds", self.settings.polling_interval_seconds)),
                download_directory=payload.get("downloadDirectory", self.settings.download_directory),
                hot_folder_path=payload.get("hotFolderPath", self.settings.hot_folder_path),
                photo_print_hot_folder_path=payload.get("photoPrintHotFolderPath", self.settings.photo_print_hot_folder_path),
                photo_gift_hot_folder_path=payload.get("photoGiftHotFolderPath", self.settings.photo_gift_hot_folder_path),
                large_format_hot_folder_path=payload.get("largeFormatHotFolderPath", self.settings.large_format_hot_folder_path),
                packing_slip_printer_name=payload.get("packingSlipPrinterName", self.settings.packing_slip_printer_name),
                shipping_label_printer_name=payload.get("shippingLabelPrinterName", self.settings.shipping_label_printer_name),
                use_mock_backend=bool(payload.get("useMockBackend", self.settings.use_mock_backend)),
            )
            self.snapshot.settings = self.settings
            self.configure_backend()
            save_settings(self.config_path, self.settings)
            if was_using_mock_backend and not self.settings.use_mock_backend:
                self.snapshot.jobs = self.purge_mock_jobs(self.snapshot.jobs, persist_changes=True)
                self.snapshot.queue_count = sum(
                    1 for item in self.snapshot.jobs if item.status in {JobStatus.PENDING, JobStatus.DOWNLOADING, JobStatus.DOWNLOADED, JobStatus.PROCESSING}
                )
            self.next_poll_at = 0.0
            self.emit_log(LogLevel.INFO, "Worker settings updated", "config")
            self.emit_snapshot()
            return

        if name == "shutdown":
            self.emit_log(LogLevel.INFO, "Worker shutdown requested", "control")
            self.scanner.stop()
            self.stop_event.set()

    def process_pending_commands(self) -> None:
        while True:
            try:
                command = self.command_queue.get_nowait()
            except queue.Empty:
                return
            self.apply_command(command)

    def should_skip_job(self, job: JobRecord) -> bool:
        path = self.local_state.processed_jobs.get(job.id)
        if not path or job.id in self.retry_queue:
            return False

        try:
            return Path(path).exists()
        except OSError as exc:
            self.local_state.processed_jobs.pop(job.id, None)
            self.local_state.save(self.paths["state"])
            self.emit_log(
                LogLevel.WARNING,
                f"Ignored invalid processed job path for {job.id}: {path} ({exc})",
                "state",
            )
            return False

    def has_all_local_assets(self, job: JobRecord) -> bool:
        return bool(job.assets) and all(
            asset.local_path and Path(asset.local_path).exists()
            for asset in job.assets
        )

    def poll_once(self) -> None:
        self.snapshot.last_sync_at = now_iso()
        self.snapshot.current_activity = "Receiving assigned jobs"
        self.snapshot.health = HealthState.PAUSED if self.snapshot.polling_paused else HealthState.HEALTHY
        self.emit_health()

        self.backend.heartbeat()
        jobs = self.backend.fetch_jobs()
        self.snapshot.queue_count = len([job for job in jobs if job.status != JobStatus.COMPLETED])
        self.emit_log(LogLevel.INFO, f"Fetched {len(jobs)} jobs from backend", "poller")
        if jobs:
            summary = ", ".join(f"{job.id}:{job.status.value}" for job in jobs[:10])
            self.emit_log(LogLevel.INFO, f"Backend jobs: {summary}", "poller")

        known_job_ids = {item.id for item in self.snapshot.jobs}
        for job in jobs:
            if job.id not in known_job_ids:
                self.emit_job(job)
                known_job_ids.add(job.id)

        for job in jobs:
            if self.should_skip_job(job):
                continue
            if job.status in {JobStatus.PENDING, JobStatus.FAILED} or job.id in self.retry_queue:
                self.receive_job(job)
                continue
            if job.status in {JobStatus.DOWNLOADED, JobStatus.PROCESSING}:
                self.resume_dispatchable_job(job, report_backend_status=job.status == JobStatus.DOWNLOADED)

        self.snapshot.last_sync_at = now_iso()
        if not self.snapshot.active_job_id:
            self.snapshot.current_activity = "Receiving orders, output paused" if self.snapshot.polling_paused else "Idle and waiting for jobs"
            self.snapshot.health = HealthState.PAUSED if self.snapshot.polling_paused else HealthState.HEALTHY
        self.emit_health()

    def update_job_state(
        self,
        job: JobRecord,
        status: JobStatus,
        *,
        local_path: str | None = None,
        local_paths: dict[str, str] | None = None,
        assets: list[AssetRecord] | None = None,
        last_error: str | None = None,
    ) -> JobRecord:
        updated = replace(
            job,
            status=status,
            local_path=local_path if local_path is not None else job.local_path,
            local_paths=local_paths if local_paths is not None else job.local_paths,
            assets=assets if assets is not None else job.assets,
            last_error=last_error,
            updated_at=now_iso(),
            attempts=job.attempts + (1 if status == JobStatus.FAILED else 0),
        )
        self.emit_job(updated)
        return updated

    def download_job_assets(self, job: JobRecord) -> tuple[JobRecord, list[Path]]:
        self.emit_log(LogLevel.INFO, f"Downloading {len(job.assets)} assets for {job.id}", "download")

        asset_paths: dict[str, str] = {}
        updated_assets: list[AssetRecord] = []
        pdf_paths: list[Path] = []

        for asset in job.assets:
            content, content_type = self.backend.download_asset(job, asset)
            destination, thumbnail = write_job_asset(self.settings, job, asset, content)
            asset_paths[asset.filename] = str(destination)
            updated_asset = replace(
                asset,
                content_type=content_type or asset.content_type,
                local_path=str(destination),
                thumbnail_path=str(thumbnail) if thumbnail else None,
            )
            updated_assets.append(updated_asset)
            if asset.kind == AssetKind.PDF:
                pdf_paths.append(destination)
            self.emit_log(LogLevel.INFO, f"Saved {asset.filename} to {destination}", "download")

        primary_path = next(iter(asset_paths.values()), None)
        updated_job = self.update_job_state(
            job,
            JobStatus.DOWNLOADED,
            local_path=primary_path,
            local_paths=asset_paths,
            assets=updated_assets,
            last_error=None,
        )
        return updated_job, pdf_paths

    def recover_job(self, job: JobRecord) -> None:
        self.snapshot.active_job_id = job.id
        self.snapshot.health = HealthState.PROCESSING
        self.snapshot.current_activity = f"Recovering {job.id}"
        self.emit_health()

        original_status = job.status
        self.local_state.mark_inflight(job.id, "recover", job)
        self.local_state.save(self.paths["state"])
        try:
            recovering = self.update_job_state(
                job,
                JobStatus.DOWNLOADING,
                local_path=None,
                local_paths={},
                assets=job.assets,
                last_error=None,
            )
            recovered, _pdf_paths = self.download_job_assets(recovering)
            restored = self.update_job_state(
                recovered,
                original_status,
                local_path=recovered.local_path,
                local_paths=recovered.local_paths,
                assets=recovered.assets,
                last_error=None,
            )
            if original_status == JobStatus.COMPLETED:
                self.local_state.processed_jobs[restored.id] = restored.local_path or restored.order_id
            self.local_state.clear_inflight(job.id)
            self.local_state.save(self.paths["state"])
            self.emit_log(LogLevel.INFO, f"Recovered {job.order_id} from PX search", "search")
        except Exception as exc:  # noqa: BLE001
            failed = self.update_job_state(job, job.status, last_error=str(exc))
            self.local_state.clear_inflight(job.id)
            self.local_state.save(self.paths["state"])
            self.emit_log(LogLevel.ERROR, f"Failed to recover {failed.order_id}: {exc}", "search")
            self.snapshot.health = HealthState.ERROR
        finally:
            self.snapshot.active_job_id = None
            self.snapshot.health = HealthState.PAUSED if self.snapshot.polling_paused else HealthState.HEALTHY
            self.snapshot.current_activity = "Receiving orders, output paused" if self.snapshot.polling_paused else "Idle and waiting for jobs"
            self.emit_health()

    def receive_job(self, job: JobRecord) -> None:
        self.snapshot.active_job_id = job.id
        self.snapshot.health = HealthState.PROCESSING
        self.snapshot.current_activity = f"Receiving {job.id}"
        self.emit_health()

        self.local_state.mark_inflight(job.id, "receive", job)
        self.local_state.save(self.paths["state"])
        try:
            self.backend.claim_job(job.id)
            job = self.update_job_state(job, JobStatus.DOWNLOADING)
            self.safe_backend_update_job_status(job.id, JobStatus.DOWNLOADING)
            job, _pdf_paths = self.download_job_assets(job)
            self.safe_backend_update_job_status(job.id, JobStatus.DOWNLOADED)
            self.local_state.clear_inflight(job.id)
            self.local_state.save(self.paths["state"])
            self.emit_log(LogLevel.INFO, f"Job {job.id} received and held locally", "receiver")
        except Exception as exc:  # noqa: BLE001
            self.safe_backend_update_job_status(job.id, JobStatus.FAILED, str(exc))
            failed = self.update_job_state(job, JobStatus.FAILED, last_error=str(exc))
            self.local_state.clear_inflight(job.id)
            self.local_state.save(self.paths["state"])
            self.emit_log(LogLevel.ERROR, f"Job {failed.id} failed during receive: {exc}", "receiver")
            self.snapshot.health = HealthState.ERROR
        finally:
            self.snapshot.active_job_id = None
            self.snapshot.health = HealthState.PAUSED if self.snapshot.polling_paused else HealthState.HEALTHY
            self.snapshot.current_activity = "Receiving orders, output paused" if self.snapshot.polling_paused else "Idle and waiting for jobs"
            self.emit_health()

    def resume_dispatchable_job(self, job: JobRecord, *, report_backend_status: bool) -> None:
        self.snapshot.active_job_id = job.id
        self.snapshot.health = HealthState.PROCESSING
        self.snapshot.current_activity = f"Resuming {job.id}"
        self.emit_health()

        local_job = next((item for item in self.snapshot.jobs if item.id == job.id), job)
        self.local_state.mark_inflight(job.id, "recover", local_job)
        self.local_state.save(self.paths["state"])
        try:
            dispatch_job = local_job
            if not self.has_all_local_assets(local_job):
                recovering = self.update_job_state(
                    local_job,
                    JobStatus.DOWNLOADING,
                    local_path=None,
                    local_paths={},
                    assets=job.assets,
                    last_error=None,
                )
                dispatch_job, _pdf_paths = self.download_job_assets(recovering)
                self.emit_log(LogLevel.INFO, f"Job {job.id} re-downloaded for dispatch", "receiver")

            dispatch_job = self.update_job_state(
                dispatch_job,
                JobStatus.DOWNLOADED,
                local_path=dispatch_job.local_path,
                local_paths=dispatch_job.local_paths,
                assets=dispatch_job.assets,
                last_error=None,
            )
            succeeded = self.dispatch_job(dispatch_job, report_backend_status=report_backend_status)
            if succeeded:
                self.local_state.clear_inflight(job.id)
                self.local_state.save(self.paths["state"])
        except Exception as exc:  # noqa: BLE001
            failed = self.update_job_state(local_job, JobStatus.FAILED, last_error=str(exc))
            self.local_state.clear_inflight(job.id)
            self.local_state.save(self.paths["state"])
            self.emit_log(LogLevel.ERROR, f"Job {failed.id} failed while resuming dispatch: {exc}", "receiver")
            self.snapshot.health = HealthState.ERROR
        finally:
            self.snapshot.active_job_id = None
            self.snapshot.health = HealthState.PAUSED if self.snapshot.polling_paused else HealthState.HEALTHY
            self.snapshot.current_activity = "Receiving orders, output paused" if self.snapshot.polling_paused else "Idle and waiting for jobs"
            self.emit_health()

    def dispatch_ready_jobs(self) -> None:
        ready_jobs = [job for job in self.snapshot.jobs if job.status == JobStatus.DOWNLOADED]
        for job in sorted(ready_jobs, key=lambda item: item.created_at):
            self.dispatch_job(job)

    def dispatch_job(self, job: JobRecord, *, report_backend_status: bool = True, restore_on_failure: JobRecord | None = None) -> bool:
        self.snapshot.active_job_id = job.id
        self.snapshot.health = HealthState.PROCESSING
        self.snapshot.current_activity = f"Dispatching {job.id}"
        self.emit_health()

        try:
            job = self.update_job_state(
                job,
                JobStatus.PROCESSING,
                local_path=job.local_path,
                local_paths=job.local_paths,
                assets=job.assets,
            )
            if report_backend_status:
                self.safe_backend_update_job_status(job.id, JobStatus.PROCESSING)

            for asset in job.assets:
                if asset.kind != AssetKind.PDF:
                    destination = release_asset_to_hot_folder(self.settings, job, asset)
                    if destination:
                        self.emit_log(LogLevel.INFO, f"Released {asset.filename} to {destination}", "output")

            for asset in job.assets:
                if asset.kind == AssetKind.PDF and asset.local_path:
                    pdf_path = Path(asset.local_path)
                    self.snapshot.current_activity = f"Printing {pdf_path.name}"
                    self.emit_health()
                    instructions = job.print_instructions
                    if instructions and instructions.auto_print_pdf and self.settings.packing_slip_printer_name.strip():
                        instructions = replace(
                            instructions,
                            printer_name=self.settings.packing_slip_printer_name.strip(),
                        )
                    print_pdf(pdf_path, instructions)
                    self.emit_log(LogLevel.INFO, f"Printed {pdf_path.name}", "printer")

            self.local_state.processed_jobs[job.id] = job.local_path or job.order_id
            self.retry_queue.discard(job.id)
            self.local_state.save(self.paths["state"])
            self.emit_log(LogLevel.INFO, f"Job {job.id} dispatched and now awaiting completion", "output")
            return True
        except Exception as exc:  # noqa: BLE001
            if report_backend_status:
                self.safe_backend_update_job_status(job.id, JobStatus.FAILED, str(exc))
                failed = self.update_job_state(job, JobStatus.FAILED, last_error=str(exc))
                self.emit_log(LogLevel.ERROR, f"Job {failed.id} failed during dispatch: {exc}", "output")
            elif restore_on_failure is not None:
                restored = self.update_job_state(
                    restore_on_failure,
                    restore_on_failure.status,
                    local_path=restore_on_failure.local_path,
                    local_paths=restore_on_failure.local_paths,
                    assets=restore_on_failure.assets,
                    last_error=restore_on_failure.last_error,
                )
                self.emit_log(LogLevel.ERROR, f"Reprint dispatch failed for {restored.id}: {exc}", "reprint")
            else:
                self.emit_log(LogLevel.ERROR, f"Dispatch failed for {job.id}: {exc}", "output")
            self.snapshot.health = HealthState.ERROR
            return False
        finally:
            self.snapshot.active_job_id = None
            self.snapshot.health = HealthState.PAUSED if self.snapshot.polling_paused else HealthState.HEALTHY
            self.snapshot.current_activity = "Receiving orders, output paused" if self.snapshot.polling_paused else "Idle and waiting for jobs"
            self.emit_health()

    def reprint_job(self, job_id: str) -> None:
        job = next((item for item in self.snapshot.jobs if item.id == job_id), None)
        if job is None:
            self.emit_log(LogLevel.WARNING, f"Reprint requested for unknown job {job_id}", "control")
            return

        if job.status not in {JobStatus.DOWNLOADED, JobStatus.PROCESSING, JobStatus.COMPLETED, JobStatus.FAILED}:
            self.emit_log(LogLevel.WARNING, f"Job {job_id} is not ready for reprint", "control")
            return

        self.emit_log(LogLevel.INFO, f"Starting reprint for {job_id}", "reprint")
        self.safe_backend_report_job_event(
            job_id,
            "reprint_requested",
            {
                "requested_at": now_iso(),
                "machine_id": self.settings.machine_id,
            },
        )

        self.snapshot.active_job_id = job.id
        self.snapshot.health = HealthState.PROCESSING
        self.snapshot.current_activity = f"Reprinting {job.id}"
        self.emit_health()

        succeeded = False
        reprint_error: str | None = None
        original_job = job
        self.local_state.mark_inflight(job.id, "reprint", original_job)
        self.local_state.save(self.paths["state"])
        try:
            self.local_state.processed_jobs.pop(job.id, None)
            self.local_state.save(self.paths["state"])
            reprint_job = original_job
            if self.has_all_local_assets(original_job):
                self.emit_log(LogLevel.INFO, f"Using held files for reprint of {job.id}", "reprint")
            else:
                reprint_job = self.update_job_state(
                    job,
                    JobStatus.DOWNLOADING,
                    local_path=None,
                    local_paths={},
                    assets=job.assets,
                    last_error=None,
                )
                reprint_job, _pdf_paths = self.download_job_assets(reprint_job)
                self.emit_log(LogLevel.INFO, f"Job {job.id} re-downloaded for reprint", "reprint")

            succeeded = self.dispatch_job(reprint_job, report_backend_status=False, restore_on_failure=original_job)
            if succeeded:
                self.update_job_state(
                    original_job,
                    original_job.status,
                    local_path=reprint_job.local_path,
                    local_paths=reprint_job.local_paths,
                    assets=reprint_job.assets,
                    last_error=original_job.last_error,
                )
                self.local_state.clear_inflight(job.id)
                self.local_state.save(self.paths["state"])
        except Exception as exc:  # noqa: BLE001
            reprint_error = str(exc)
            restored = self.update_job_state(
                original_job,
                original_job.status,
                local_path=original_job.local_path,
                local_paths=original_job.local_paths,
                assets=original_job.assets,
                last_error=original_job.last_error,
            )
            self.local_state.clear_inflight(job.id)
            self.local_state.save(self.paths["state"])
            self.emit_log(LogLevel.ERROR, f"Job {restored.id} failed during reprint receive: {exc}", "reprint")
            self.snapshot.health = HealthState.ERROR
        finally:
            if not succeeded:
                self.local_state.clear_inflight(job.id)
                self.local_state.save(self.paths["state"])
            if not succeeded and reprint_error is None:
                reprint_error = "Reprint dispatch failed"
            self.safe_backend_report_job_event(
                job_id,
                "reprint_completed" if succeeded else "reprint_failed",
                {
                    "completed_at": now_iso(),
                    "machine_id": self.settings.machine_id,
                    "error": reprint_error,
                },
            )
            self.snapshot.active_job_id = None
            self.snapshot.health = HealthState.PAUSED if self.snapshot.polling_paused else HealthState.HEALTHY
            self.snapshot.current_activity = "Receiving orders, output paused" if self.snapshot.polling_paused else "Idle and waiting for jobs"
            self.emit_health()

    def print_shipping_label(self, job_id: str) -> None:
        job = next((item for item in self.snapshot.jobs if item.id == job_id), None)
        if job is None:
            self.emit_log(LogLevel.WARNING, f"Label print requested for unknown job {job_id}", "control")
            return

        self.emit_log(LogLevel.INFO, f"Starting shipping label print for {job_id}", "label")
        self.safe_backend_report_job_event(
            job_id,
            "shipping_label_requested",
            {
                "requested_at": now_iso(),
                "machine_id": self.settings.machine_id,
            },
        )

        try:
            label_path = create_shipping_label_pdf(shipment_id=job.shipment_id, order_number=job.order_id)
            print_pdf(
                label_path,
                replace(
                    job.print_instructions,
                    auto_print_pdf=True,
                    printer_name=self.settings.shipping_label_printer_name.strip() or None,
                    copies=1,
                )
                if job.print_instructions
                else PrintInstructions(
                    auto_print_pdf=True,
                    printer_name=self.settings.shipping_label_printer_name.strip() or None,
                    copies=1,
                ),
            )
            self.emit_log(LogLevel.INFO, f"Printed shipping label for {job.order_id}", "label")
            self.safe_backend_report_job_event(
                job_id,
                "shipping_label_printed",
                {
                    "printed_at": now_iso(),
                    "machine_id": self.settings.machine_id,
                },
            )
        except Exception as exc:  # noqa: BLE001
            self.emit_log(LogLevel.ERROR, f"Shipping label print failed for {job.order_id}: {exc}", "label")
            self.safe_backend_report_job_event(
                job_id,
                "shipping_label_failed",
                {
                    "failed_at": now_iso(),
                    "machine_id": self.settings.machine_id,
                    "error": str(exc),
                },
            )

    def print_packing_slip(self, job_id: str) -> None:
        job = next((item for item in self.snapshot.jobs if item.id == job_id), None)
        if job is None:
            self.emit_log(LogLevel.WARNING, f"Packing slip print requested for unknown job {job_id}", "control")
            return

        pdf_asset = next((asset for asset in job.assets if asset.kind == AssetKind.PDF and asset.local_path), None)
        if pdf_asset is None:
            self.emit_log(LogLevel.WARNING, f"No packing slip PDF available for {job.order_id}", "printer")
            return

        self.emit_log(LogLevel.INFO, f"Starting packing slip print for {job_id}", "printer")
        try:
            instructions = job.print_instructions
            if instructions and self.settings.packing_slip_printer_name.strip():
                instructions = replace(
                    instructions,
                    auto_print_pdf=True,
                    printer_name=self.settings.packing_slip_printer_name.strip(),
                )
            elif instructions:
                instructions = replace(instructions, auto_print_pdf=True)
            else:
                instructions = PrintInstructions(
                    auto_print_pdf=True,
                    printer_name=self.settings.packing_slip_printer_name.strip() or None,
                    copies=1,
                )

            print_pdf(Path(pdf_asset.local_path), instructions)
            self.emit_log(LogLevel.INFO, f"Printed packing slip for {job.order_id}", "printer")
            self.safe_backend_report_job_event(
                job_id,
                "packing_slip_printed",
                {
                    "printed_at": now_iso(),
                    "machine_id": self.settings.machine_id,
                },
            )
        except Exception as exc:  # noqa: BLE001
            self.emit_log(LogLevel.ERROR, f"Packing slip print failed for {job.order_id}: {exc}", "printer")
            self.safe_backend_report_job_event(
                job_id,
                "packing_slip_failed",
                {
                    "failed_at": now_iso(),
                    "machine_id": self.settings.machine_id,
                    "error": str(exc),
                },
            )

    def force_complete_job(self, job_id: str) -> None:
        job = next((item for item in self.snapshot.jobs if item.id == job_id), None)
        if job is None:
            self.emit_log(LogLevel.WARNING, f"Force complete requested for unknown job {job_id}", "control")
            return

        self.emit_log(LogLevel.INFO, f"Force completing {job_id}", "control")

        try:
            completed_job = self.update_job_state(
                job,
                JobStatus.COMPLETED,
                local_path=job.local_path,
                local_paths=job.local_paths,
                assets=job.assets,
                last_error=None,
            )
            self.safe_backend_update_job_status(job.id, JobStatus.COMPLETED, "Force completed from desktop UI")
            self.safe_backend_report_job_event(
                job_id,
                "issue_resolved",
                {
                    "resolved_at": now_iso(),
                    "machine_id": self.settings.machine_id,
                    "resolution": "force_completed",
                },
            )
            self.local_state.processed_jobs[job.id] = completed_job.local_path or completed_job.order_id
            self.retry_queue.discard(job.id)
            self.local_state.save(self.paths["state"])
            self.emit_log(LogLevel.INFO, f"Job {job_id} marked completed from desktop UI", "control")
        except Exception as exc:  # noqa: BLE001
            self.emit_log(LogLevel.ERROR, f"Force complete failed for {job_id}: {exc}", "control")

    def run(self) -> None:
        self.start_command_listener()
        self.register()
        self.scanner.start()

        while not self.stop_event.is_set():
            self.process_pending_commands()

            if time.time() >= self.next_poll_at:
                try:
                    self.poll_once()
                except Exception as exc:  # noqa: BLE001
                    self.snapshot.health = HealthState.ERROR
                    self.snapshot.current_activity = "Receive error"
                    self.emit_log(LogLevel.ERROR, f"Polling cycle failed: {exc}", "poller")
                    self.emit_health()
                self.next_poll_at = time.time() + self.settings.polling_interval_seconds

            if not self.snapshot.polling_paused:
                self.dispatch_ready_jobs()

            time.sleep(0.5)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PX receiver Python worker")
    parser.add_argument("--config", required=True, help="Path to the JSON configuration file")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    runtime = WorkerRuntime(Path(args.config))
    runtime.run()
