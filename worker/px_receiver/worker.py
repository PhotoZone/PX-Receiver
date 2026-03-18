from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from px_receiver.config import build_runtime_paths, load_settings, save_settings
from uuid import uuid4

from px_receiver.models import AssetKind, AssetRecord, HealthState, JobRecord, JobStatus, LargeFormatActivity, LargeFormatBatch, LargeFormatBatchStatus, LargeFormatJob, LargeFormatJobStatus, LargeFormatState, LogLevel, LogRecord, PrintInstructions, ScanRecord, ScannerState, WorkerSettings, WorkerSnapshot, now_iso
from px_receiver.services.backend import BackendClient, build_backend_client
from px_receiver.services.filesystem import cache_external_shipping_label_pdf, cache_shipping_label_pdf, prune_working_directories, release_asset_to_hot_folder, write_job_asset
from px_receiver.services.large_format import (
    build_large_format_job,
    create_layout_batch,
    large_format_input_paths,
    large_format_output_path,
    render_batch_pdf,
    send_batch_to_hot_folder,
)
from px_receiver.services.printer import print_pdf
from px_receiver.services.scanner import ScannerService
from px_receiver.services.shipstation import create_shipping_label_pdf
from px_receiver.services.slack import notify_order_failure
from px_receiver.state import LocalState

MAX_SCAN_ACTIONS_PER_SESSION = 1
A1_LONG_EDGE_IN = 33.1
A1_SHORT_EDGE_IN = 23.4
A_SIZE_TOLERANCE_IN = 0.2


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
        hydrated_large_format_jobs = self.local_state.hydrate_large_format_jobs()
        hydrated_large_format_batches = self.local_state.hydrate_large_format_batches()
        hydrated_large_format_activity = self.local_state.hydrate_large_format_activity()
        self.snapshot.scanner = ScannerState(
            recent_scans=hydrated_scans,
            last_scan_at=hydrated_scans[0].timestamp if hydrated_scans else None,
            last_code=hydrated_scans[0].code if hydrated_scans else None,
        )
        self.snapshot.large_format = LargeFormatState(
            jobs=hydrated_large_format_jobs,
            batches=hydrated_large_format_batches,
            activity=hydrated_large_format_activity,
            active_batch_id=hydrated_large_format_batches[0].id if hydrated_large_format_batches else None,
        )
        self.snapshot.queue_count = sum(
            1 for item in self.snapshot.jobs if item.status in {JobStatus.PENDING, JobStatus.DOWNLOADING, JobStatus.DOWNLOADED, JobStatus.PROCESSING}
        )
        self.backend = build_backend_client(self.settings)
        self.command_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self.download_result_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self.stop_event = threading.Event()
        self.retry_queue: set[str] = set()
        self.scan_action_counts: dict[str, int] = {}
        self.alerted_failure_keys: set[str] = set()
        self.active_downloads: dict[str, threading.Thread] = {}
        self.next_poll_at = 0.0
        self.next_large_format_scan_at = 0.0
        self.next_large_format_process_at = 0.0
        self.scanner = ScannerService(
            on_scan=self.handle_scan,
            on_status=self.handle_scanner_status,
            on_log=self.emit_log,
            scanner_mode=self.settings.scanner_mode,
        )

    def rebuild_scanner(self) -> None:
        self.scanner.stop()
        self.scanner = ScannerService(
            on_scan=self.handle_scan,
            on_status=self.handle_scanner_status,
            on_log=self.emit_log,
            scanner_mode=self.settings.scanner_mode,
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
                if self.path_exists_safe(asset.local_path, scope="state", identifier=f"{job.id}/{asset.filename}")
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

    def emit_large_format_activity(self, event: str, message: str, level: LogLevel = LogLevel.INFO) -> None:
        entry = LargeFormatActivity(event=event, message=message, level=level)
        self.snapshot.large_format.activity = [entry, *self.snapshot.large_format.activity][:250]
        self.local_state.remember_large_format_activity(entry)
        self.local_state.save(self.paths["state"])
        self.emit_snapshot()

    def remember_large_format_job(self, job: LargeFormatJob) -> None:
        self.snapshot.large_format.jobs = [job, *[item for item in self.snapshot.large_format.jobs if item.id != job.id]][:250]
        self.local_state.remember_large_format_job(job)
        self.local_state.save(self.paths["state"])

    def remember_large_format_batch(self, batch: LargeFormatBatch) -> None:
        self.snapshot.large_format.batches = [batch, *[item for item in self.snapshot.large_format.batches if item.id != batch.id]][:120]
        self.snapshot.large_format.active_batch_id = batch.id
        self.local_state.remember_large_format_batch(batch)
        self.local_state.save(self.paths["state"])

    def scan_large_format_folder(self) -> None:
        input_dirs = large_format_input_paths(self.settings)
        output_dir = large_format_output_path(self.settings)
        for input_dir in input_dirs.values():
            input_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)

        existing_paths = {item.original_path for item in self.snapshot.large_format.jobs}
        discovered = 0
        skipped_existing = 0
        file_count = 0
        imported_waiting = 0
        imported_review = 0
        scanned_labels = ", ".join(f"{source}={path}" for source, path in input_dirs.items())
        self.emit_log(
            LogLevel.INFO,
            f"Scanning large-format input folders: {scanned_labels}",
            "large-format",
        )
        for source, input_dir in input_dirs.items():
            for entry in sorted(input_dir.iterdir(), key=lambda item: item.name.lower()):
                if not entry.is_file():
                    continue
                file_count += 1
                if str(entry) in existing_paths:
                    skipped_existing += 1
                    continue
                job = build_large_format_job(entry, source)
                self.remember_large_format_job(job)
                discovered += 1
                if job.status == LargeFormatJobStatus.WAITING:
                    imported_waiting += 1
                    self.emit_log(
                        LogLevel.INFO,
                        f"Imported large-format file {entry.name} from {source} as waiting.",
                        "large-format",
                    )
                else:
                    imported_review += 1
                    self.emit_log(
                        LogLevel.WARNING,
                        f"Imported large-format file {entry.name} from {source} as needs review: {job.notes or 'Unknown validation issue.'}",
                        "large-format",
                    )

        self.snapshot.large_format.last_scan_at = now_iso()
        self.local_state.save(self.paths["state"])
        if discovered:
            self.emit_large_format_activity(
                "scan.completed",
                f"Scanned Photo Zone and PostSnap large-format hot folders and added {discovered} new job(s) ({imported_waiting} waiting, {imported_review} needs review, {skipped_existing} already known).",
            )
        else:
            self.emit_log(
                LogLevel.INFO,
                f"Large-format scan found {file_count} file(s); added 0 new jobs and skipped {skipped_existing} already-known path(s).",
                "large-format",
            )
            self.emit_snapshot()

    def is_a1_large_format_job(self, job: LargeFormatJob) -> bool:
        if not job.width_in or not job.height_in:
            return False

        long_edge = max(job.width_in, job.height_in)
        short_edge = min(job.width_in, job.height_in)
        return (
            abs(long_edge - A1_LONG_EDGE_IN) <= A_SIZE_TOLERANCE_IN
            and abs(short_edge - A1_SHORT_EDGE_IN) <= A_SIZE_TOLERANCE_IN
        )

    def select_large_format_batch_jobs(self, waiting_jobs: list[LargeFormatJob]) -> list[LargeFormatJob]:
        a1_jobs = [job for job in waiting_jobs if self.is_a1_large_format_job(job)]
        if a1_jobs:
            return a1_jobs
        return waiting_jobs

    def process_large_format_batches(self) -> None:
        waiting_jobs = [job for job in self.snapshot.large_format.jobs if job.status == LargeFormatJobStatus.WAITING]
        if not waiting_jobs:
            self.snapshot.large_format.last_processed_at = now_iso()
            self.emit_snapshot()
            return

        selected_jobs = self.select_large_format_batch_jobs(waiting_jobs)

        try:
            batch = create_layout_batch(self.settings, selected_jobs)
        except RuntimeError as exc:
            blocked_job = selected_jobs[0]
            updated_job = replace(
                blocked_job,
                status=LargeFormatJobStatus.NEEDS_REVIEW,
                updated_at=now_iso(),
                notes=str(exc),
            )
            self.remember_large_format_job(updated_job)
            self.snapshot.large_format.last_processed_at = now_iso()
            self.emit_large_format_activity("batch.validation_failed", str(exc), LogLevel.WARNING)
            return

        jobs_by_id = {job.id: job for job in self.snapshot.large_format.jobs}
        output_path = render_batch_pdf(self.settings, batch, jobs_by_id)
        batch.output_pdf_path = output_path
        batch.status = LargeFormatBatchStatus.READY
        batch.updated_at = now_iso()
        self.remember_large_format_batch(batch)

        included_job_ids = {placement.job_id for placement in batch.placements}
        for job in selected_jobs:
            if job.id not in included_job_ids:
                continue
            updated_job = replace(job, status=LargeFormatJobStatus.BATCHED, updated_at=now_iso(), batch_id=batch.id)
            self.remember_large_format_job(updated_job)

        self.snapshot.large_format.last_processed_at = now_iso()
        deferred_count = max(0, len(waiting_jobs) - len(included_job_ids))
        message = f"Created large-format batch {batch.id[-8:]} from {len(included_job_ids)} job(s). Estimated length {batch.used_length_mm:.0f} mm."
        if len(selected_jobs) != len(waiting_jobs) and all(self.is_a1_large_format_job(job) for job in selected_jobs):
            message += " A1 jobs were batched separately for cleaner finishing."
        if deferred_count:
            message += f" Left {deferred_count} job(s) waiting to stay within the {self.settings.large_format_max_batch_length_mm:.0f} mm max length."
        self.emit_large_format_activity(
            "batch.created",
            message,
        )

        if self.settings.large_format_auto_approve_enabled and batch.waste_percent <= self.settings.large_format_auto_approve_max_waste_percent:
            self.approve_large_format_batch(batch.id)
            self.emit_large_format_activity(
                "batch.auto_approved",
                f"Auto-approved large-format batch {batch.id[-8:]} because waste {batch.waste_percent:.1f}% is within the {self.settings.large_format_auto_approve_max_waste_percent:.1f}% threshold.",
            )
            if self.settings.large_format_auto_send:
                self.send_large_format_batch(batch.id)

    def create_manual_large_format_batch(self, job_id: str) -> None:
        job = next((item for item in self.snapshot.large_format.jobs if item.id == job_id), None)
        if job is None:
            self.emit_large_format_activity("batch.error", f"Manual batch requested for unknown large-format job {job_id}.", LogLevel.WARNING)
            return
        if job.status != LargeFormatJobStatus.WAITING:
            self.emit_large_format_activity(
                "batch.error",
                f"Manual batch requested for {job.filename}, but only waiting jobs can be forced into an urgent batch.",
                LogLevel.WARNING,
            )
            return

        try:
            batch = create_layout_batch(self.settings, [job])
        except RuntimeError as exc:
            updated_job = replace(
                job,
                status=LargeFormatJobStatus.NEEDS_REVIEW,
                updated_at=now_iso(),
                notes=str(exc),
            )
            self.remember_large_format_job(updated_job)
            self.snapshot.large_format.last_processed_at = now_iso()
            self.emit_large_format_activity("batch.validation_failed", str(exc), LogLevel.WARNING)
            return

        jobs_by_id = {item.id: item for item in self.snapshot.large_format.jobs}
        output_path = render_batch_pdf(self.settings, batch, jobs_by_id)
        batch.output_pdf_path = output_path
        batch.status = LargeFormatBatchStatus.READY
        batch.updated_at = now_iso()
        self.remember_large_format_batch(batch)
        self.remember_large_format_job(replace(job, status=LargeFormatJobStatus.BATCHED, updated_at=now_iso(), batch_id=batch.id))
        self.snapshot.large_format.last_processed_at = now_iso()
        self.emit_large_format_activity(
            "batch.created",
            f"Created urgent large-format batch {batch.id[-8:]} for {job.filename}. Estimated length {batch.used_length_mm:.0f} mm.",
        )

        if self.settings.large_format_auto_approve_enabled and batch.waste_percent <= self.settings.large_format_auto_approve_max_waste_percent:
            self.approve_large_format_batch(batch.id)
            self.emit_large_format_activity(
                "batch.auto_approved",
                f"Auto-approved urgent batch {batch.id[-8:]} because waste {batch.waste_percent:.1f}% is within the {self.settings.large_format_auto_approve_max_waste_percent:.1f}% threshold.",
            )
            if self.settings.large_format_auto_send:
                self.send_large_format_batch(batch.id)

    def approve_large_format_batch(self, batch_id: str) -> None:
        batch = next((item for item in self.snapshot.large_format.batches if item.id == batch_id), None)
        if batch is None:
            self.emit_large_format_activity("batch.error", f"Approval requested for unknown large-format batch {batch_id}.", LogLevel.WARNING)
            return
        updated = replace(batch, status=LargeFormatBatchStatus.APPROVED, updated_at=now_iso())
        self.remember_large_format_batch(updated)
        self.emit_large_format_activity("batch.approved", f"Approved large-format batch {batch_id[-8:]}.")

    def send_large_format_batch(self, batch_id: str) -> None:
        batch = next((item for item in self.snapshot.large_format.batches if item.id == batch_id), None)
        if batch is None:
            self.emit_large_format_activity("batch.error", f"Send requested for unknown large-format batch {batch_id}.", LogLevel.WARNING)
            return
        if self.settings.large_format_direct_print:
            if not batch.output_pdf_path:
                self.emit_large_format_activity("batch.error", f"Cannot print batch {batch_id[-8:]} because no PDF has been generated.", LogLevel.WARNING)
                return
            printer_name = self.settings.large_format_printer_name.strip()
            cups_job_id = print_pdf(
                Path(batch.output_pdf_path),
                PrintInstructions(
                    auto_print_pdf=True,
                    printer_name=printer_name or None,
                    copies=1,
                ),
            )
            destination = f"Printing via {printer_name or 'default macOS printer'}"
            if cups_job_id:
                destination = f"{destination} ({cups_job_id})"
            event_message = (
                f"Submitted large-format batch {batch_id[-8:]} to printer {printer_name}."
                if printer_name
                else f"Submitted large-format batch {batch_id[-8:]} to the default macOS printer."
            )
            if cups_job_id:
                event_message += f" CUPS job {cups_job_id}."
            updated = replace(batch, status=LargeFormatBatchStatus.PRINTING, updated_at=now_iso(), notes=destination)
        else:
            destination = send_batch_to_hot_folder(self.settings, batch)
            event_message = f"Sent large-format batch {batch_id[-8:]} to {destination}."
            updated = replace(batch, status=LargeFormatBatchStatus.SENT, updated_at=now_iso(), hot_folder_sent_at=now_iso(), notes=destination)
        self.remember_large_format_batch(updated)
        if self.settings.large_format_direct_print:
            self.emit_large_format_activity("batch.printing", event_message)
        else:
            for job in [item for item in self.snapshot.large_format.jobs if item.batch_id == batch_id]:
                self.remember_large_format_job(replace(job, status=LargeFormatJobStatus.READY, updated_at=now_iso()))
            self.emit_large_format_activity("batch.sent", event_message)

    def regenerate_large_format_batch(self, batch_id: str) -> None:
        batch = next((item for item in self.snapshot.large_format.batches if item.id == batch_id), None)
        if batch is None:
            self.emit_large_format_activity("batch.error", f"Regenerate requested for unknown large-format batch {batch_id}.", LogLevel.WARNING)
            return
        if batch.status == LargeFormatBatchStatus.SENT:
            self.emit_large_format_activity("batch.error", f"Cannot regenerate batch {batch_id[-8:]} because it has already been sent to the hot folder.", LogLevel.WARNING)
            return

        batch_jobs = [item for item in self.snapshot.large_format.jobs if item.batch_id == batch_id]
        if not batch_jobs:
            self.emit_large_format_activity("batch.error", f"Cannot regenerate batch {batch_id[-8:]} because no jobs are attached to it.", LogLevel.WARNING)
            return

        if batch.output_pdf_path:
            try:
                if Path(batch.output_pdf_path).exists():
                    Path(batch.output_pdf_path).unlink()
            except OSError as exc:
                self.emit_large_format_activity("batch.warning", f"Could not remove previous PDF for batch {batch_id[-8:]}: {exc}", LogLevel.WARNING)

        try:
            regenerated = create_layout_batch(self.settings, batch_jobs)
            jobs_by_id = {job.id: job for job in self.snapshot.large_format.jobs}
            regenerated.output_pdf_path = render_batch_pdf(self.settings, regenerated, jobs_by_id)
            regenerated.status = LargeFormatBatchStatus.READY
            regenerated.updated_at = now_iso()
        except RuntimeError as exc:
            self.emit_large_format_activity("batch.validation_failed", f"Regeneration failed for batch {batch_id[-8:]}: {exc}", LogLevel.WARNING)
            return

        regenerated = replace(regenerated, id=batch.id, created_at=batch.created_at, hot_folder_sent_at=None)
        self.remember_large_format_batch(regenerated)

        included_job_ids = {placement.job_id for placement in regenerated.placements}
        for job in batch_jobs:
            next_status = LargeFormatJobStatus.BATCHED if job.id in included_job_ids else LargeFormatJobStatus.WAITING
            next_batch_id = regenerated.id if job.id in included_job_ids else None
            self.remember_large_format_job(replace(job, status=next_status, batch_id=next_batch_id, updated_at=now_iso()))

        self.snapshot.large_format.last_processed_at = now_iso()
        self.emit_large_format_activity(
            "batch.regenerated",
            f"Regenerated large-format batch {batch_id[-8:]} with length {regenerated.used_length_mm:.0f} mm and waste {regenerated.waste_percent:.1f}%.",
        )

    def delete_large_format_job(self, job_id: str) -> None:
        job = next((item for item in self.snapshot.large_format.jobs if item.id == job_id), None)
        if job is None:
            self.emit_large_format_activity("job.error", f"Delete requested for unknown large-format job {job_id}.", LogLevel.WARNING)
            return

        attached_batch = next((item for item in self.snapshot.large_format.batches if item.id == job.batch_id), None) if job.batch_id else None
        if attached_batch is not None and attached_batch.status == LargeFormatBatchStatus.SENT:
            self.emit_large_format_activity("job.error", f"Cannot delete {job.filename} because batch {attached_batch.id[-8:]} has already been sent.", LogLevel.WARNING)
            return

        deleted_source = False
        source_path = Path(job.original_path)
        input_dirs = list(large_format_input_paths(self.settings).values())
        try:
            if source_path.exists():
                for input_dir in input_dirs:
                    try:
                        source_path.relative_to(input_dir)
                        source_path.unlink()
                        deleted_source = True
                        break
                    except ValueError:
                        continue
        except OSError as exc:
            self.emit_large_format_activity("job.warning", f"Could not delete source file for {job.filename}: {exc}", LogLevel.WARNING)

        self.snapshot.large_format.jobs = [item for item in self.snapshot.large_format.jobs if item.id != job_id]
        self.local_state.large_format_jobs = [item for item in self.local_state.large_format_jobs if item.get("id") != job_id]

        if attached_batch is not None:
            remaining_batch_jobs = [item for item in self.snapshot.large_format.jobs if item.batch_id == attached_batch.id]
            if not remaining_batch_jobs:
                if attached_batch.output_pdf_path:
                    try:
                        pdf_path = Path(attached_batch.output_pdf_path)
                        if pdf_path.exists():
                            pdf_path.unlink()
                    except OSError as exc:
                        self.emit_large_format_activity("batch.warning", f"Could not remove generated PDF for batch {attached_batch.id[-8:]}: {exc}", LogLevel.WARNING)
                self.snapshot.large_format.batches = [item for item in self.snapshot.large_format.batches if item.id != attached_batch.id]
                self.local_state.large_format_batches = [item for item in self.local_state.large_format_batches if item.get("id") != attached_batch.id]
                self.emit_large_format_activity("batch.removed", f"Removed empty large-format batch {attached_batch.id[-8:]} after deleting its last job.")
            else:
                self.regenerate_large_format_batch(attached_batch.id)

        self.snapshot.large_format.active_batch_id = self.snapshot.large_format.batches[0].id if self.snapshot.large_format.batches else None
        self.local_state.save(self.paths["state"])
        suffix = " and removed its source file." if deleted_source else "."
        self.emit_large_format_activity("job.deleted", f"Deleted large-format job {job.filename}{suffix}")
        self.emit_snapshot()

    def remove_large_format_batch(self, batch_id: str) -> None:
        batch = next((item for item in self.snapshot.large_format.batches if item.id == batch_id), None)
        if batch is None:
            self.emit_large_format_activity("batch.error", f"Remove requested for unknown large-format batch {batch_id}.", LogLevel.WARNING)
            return
        if batch.status == LargeFormatBatchStatus.SENT:
            self.emit_large_format_activity("batch.error", f"Cannot remove batch {batch_id[-8:]} because it has already been sent to the hot folder.", LogLevel.WARNING)
            return

        if batch.output_pdf_path:
            try:
                if Path(batch.output_pdf_path).exists():
                    Path(batch.output_pdf_path).unlink()
            except OSError as exc:
                self.emit_large_format_activity("batch.warning", f"Could not remove generated PDF for batch {batch_id[-8:]}: {exc}", LogLevel.WARNING)

        self.snapshot.large_format.batches = [item for item in self.snapshot.large_format.batches if item.id != batch_id]
        self.local_state.large_format_batches = [item for item in self.local_state.large_format_batches if item.get("id") != batch_id]

        reset_count = 0
        next_jobs: list[LargeFormatJob] = []
        for job in self.snapshot.large_format.jobs:
            if job.batch_id == batch_id:
                reset_count += 1
                updated_job = replace(job, batch_id=None, status=LargeFormatJobStatus.WAITING, updated_at=now_iso())
                next_jobs.append(updated_job)
                self.local_state.remember_large_format_job(updated_job)
            else:
                next_jobs.append(job)
        self.snapshot.large_format.jobs = next_jobs
        self.snapshot.large_format.active_batch_id = self.snapshot.large_format.batches[0].id if self.snapshot.large_format.batches else None
        self.next_large_format_process_at = time.time() + max(60, self.settings.large_format_batching_interval_minutes * 60)
        self.local_state.save(self.paths["state"])
        self.emit_large_format_activity(
            "batch.removed",
            f"Removed large-format batch {batch_id[-8:]} and returned {reset_count} file(s) to waiting. Automatic re-batching is deferred until the next interval.",
        )
        self.emit_snapshot()

    def emit_scan(self, scan: ScanRecord) -> None:
        self.snapshot.scanner.recent_scans = [scan, *self.snapshot.scanner.recent_scans][:50]
        self.snapshot.scanner.last_scan_at = scan.timestamp
        self.snapshot.scanner.last_code = scan.code
        self.local_state.remember_scan(scan)
        self.local_state.save(self.paths["state"])
        self.emit("scan", scan.to_payload())

    def emit_scanner_status(self) -> None:
        self.emit("scanner", self.snapshot.scanner.to_payload())

    def clear_failure_alerts(self, job_id: str) -> None:
        self.alerted_failure_keys = {
            key for key in self.alerted_failure_keys if not key.startswith(f"{job_id}:")
        }

    def alert_order_failure(self, job: JobRecord, *, stage: str, error_message: str) -> None:
        key = f"{job.id}:{stage}:{error_message.strip()}"
        if not error_message.strip() or key in self.alerted_failure_keys:
            return

        try:
            notify_order_failure(
                self.settings,
                job,
                stage=stage,
                error_message=error_message,
            )
            self.alerted_failure_keys.add(key)
            self.emit_log(
                LogLevel.INFO,
                f"Slack alert sent for {job.id} ({stage})",
                "slack",
            )
        except Exception as exc:  # noqa: BLE001
            self.emit_log(
                LogLevel.WARNING,
                f"Slack alert failed for {job.id} ({stage}): {exc}",
                "slack",
            )

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

    def should_print_shipping_label_for_scan(self, job: JobRecord) -> bool:
        source = str(job.source or "").strip().casefold()
        delivery_method = str(job.delivery_method or "").strip().casefold()

        if source == "wink":
            return "home delivery" in delivery_method

        return True

    def classify_scan_code(self, code: str) -> str:
        normalized = str(code or "").strip()
        if not normalized:
            return "unknown"
        if normalized.casefold().startswith("w"):
            return "wink"
        if len(normalized) == 8 and normalized.startswith("4") and normalized.isdigit():
            return "photozone"
        if self.normalize_postsnap_order_number(normalized):
            return "postsnap"
        return "unknown"

    def normalize_postsnap_order_number(self, code: str) -> str | None:
        normalized = str(code or "").strip()
        if len(normalized) < 12:
            return None

        base = normalized[:12]
        if not base.isdigit():
            return None

        suffix = normalized[12:].strip()
        if not suffix:
            return base

        compact_suffix = suffix.replace(" ", "")
        if compact_suffix.startswith("-") and len(compact_suffix) > 1 and compact_suffix[1:].isalnum():
            return base

        return None

    def scan_action_key(self, reference: str) -> str:
        return str(reference or "").strip().upper()

    def can_process_scan_action(self, reference: str) -> bool:
        key = self.scan_action_key(reference)
        if not key:
            return True
        return self.scan_action_counts.get(key, 0) < MAX_SCAN_ACTIONS_PER_SESSION

    def record_scan_action(self, reference: str) -> None:
        key = self.scan_action_key(reference)
        if not key:
            return
        self.scan_action_counts[key] = self.scan_action_counts.get(key, 0) + 1

    def emit_blocked_scan(self, code: str, source: str, message: str, *, order_id: str | None = None) -> None:
        self.emit_log(LogLevel.WARNING, message, "scanner")
        self.emit_scan(
            ScanRecord(
                id=str(uuid4()),
                code=code,
                source=source,
                status="blocked",
                order_id=order_id,
                message=message,
            )
        )

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
            self.handle_unmatched_scan(code, source)
            return

        self.emit_log(LogLevel.INFO, f"Barcode scanned: {code}", "scanner")
        if not self.can_process_scan_action(matched_job.order_id):
            self.emit_blocked_scan(
                code,
                source,
                f"Scan ignored for {matched_job.order_id}: maximum of {MAX_SCAN_ACTIONS_PER_SESSION} actions reached this session.",
                order_id=matched_job.order_id,
            )
            return
        self.safe_backend_report_job_event(
            matched_job.id,
            "scan_confirmed",
            {
                "scanned_at": now_iso(),
                "scan_code": code,
                "machine_id": self.settings.machine_id,
            },
        )
        if self.should_print_shipping_label_for_scan(matched_job):
            label_path = self.print_shipping_label_for_order_number(
                matched_job.order_id,
                source=source,
                job_id=matched_job.id,
            )
            if label_path:
                self.record_scan_action(matched_job.order_id)
            return

        self.emit_scan(
            ScanRecord(
                id=str(uuid4()),
                code=code,
                source=source,
                status="matched",
                job_id=matched_job.id,
                order_id=matched_job.order_id,
                can_reprint_label=False,
                message=f"Matched {matched_job.order_id}; marking completed.",
            )
        )
        if self.complete_job_from_scan(matched_job.id):
            self.record_scan_action(matched_job.order_id)

    def handle_unmatched_scan(self, code: str, source: str) -> None:
        scan_kind = self.classify_scan_code(code)
        if scan_kind in {"photozone", "postsnap"}:
            self.handle_postsnap_scan(code, source)
            return

        scan = ScanRecord(
            id=str(uuid4()),
            code=code,
            source=source,
            status="unmatched",
            message="Barcode received, but no matching job was found.",
        )
        self.emit_log(LogLevel.WARNING, f"Barcode scanned with no matching job: {code}", "scanner")
        self.emit_scan(scan)

    def handle_postsnap_scan(self, code: str, source: str) -> None:
        order_number = self.normalize_postsnap_order_number(code) or code
        if not self.can_process_scan_action(order_number):
            self.emit_blocked_scan(
                code,
                source,
                f"Scan ignored for {order_number}: maximum of {MAX_SCAN_ACTIONS_PER_SESSION} actions reached this session.",
                order_id=order_number,
            )
            return
        self.emit_log(LogLevel.INFO, f"Barcode scanned and resolved via ShipStation: {code} -> {order_number}", "scanner")
        if self.print_shipping_label_for_order_number(order_number, source=source):
            self.record_scan_action(order_number)

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

        if name == "reprint_scan_label":
            scan_id = str(command.get("scan_id", ""))
            if scan_id:
                self.reprint_scan_label(scan_id)
            return

        if name == "force_complete_job":
            job_id = str(command.get("job_id", ""))
            if job_id:
                self.force_complete_job(job_id)
            return

        if name == "scan_large_format_now":
            self.scan_large_format_folder()
            return

        if name == "process_large_format_now":
            self.process_large_format_batches()
            return

        if name == "create_manual_large_format_batch":
            job_id = str(command.get("job_id", ""))
            if job_id:
                self.create_manual_large_format_batch(job_id)
            return

        if name == "approve_large_format_batch":
            batch_id = str(command.get("batch_id", ""))
            if batch_id:
                self.approve_large_format_batch(batch_id)
            return

        if name == "send_large_format_batch":
            batch_id = str(command.get("batch_id", ""))
            if batch_id:
                self.send_large_format_batch(batch_id)
            return

        if name == "regenerate_large_format_batch":
            batch_id = str(command.get("batch_id", ""))
            if batch_id:
                self.regenerate_large_format_batch(batch_id)
            return

        if name == "remove_large_format_batch":
            batch_id = str(command.get("batch_id", ""))
            if batch_id:
                self.remove_large_format_batch(batch_id)
            return

        if name == "delete_large_format_job":
            job_id = str(command.get("job_id", ""))
            if job_id:
                self.delete_large_format_job(job_id)
            return

        if name == "update_settings":
            was_using_mock_backend = self.settings.use_mock_backend
            payload = command.get("settings", {})
            legacy_large_format_input = payload.get("largeFormatInputFolderPath", self.settings.large_format_photozone_input_folder_path)
            self.settings = WorkerSettings(
                backend_url=payload.get("backendUrl", self.settings.backend_url),
                machine_id=payload.get("machineId", self.settings.machine_id),
                machine_name=payload.get("machineName", self.settings.machine_name),
                api_token=payload.get("apiToken", self.settings.api_token),
                shipstation_api_key=payload.get("shipstationApiKey", self.settings.shipstation_api_key),
                slack_webhook_url=payload.get("slackWebhookUrl", self.settings.slack_webhook_url),
                scanner_mode=payload.get("scannerMode", self.settings.scanner_mode),
                machine_auth_token=payload.get("machineAuthToken", self.settings.machine_auth_token),
                polling_interval_seconds=int(payload.get("pollingIntervalSeconds", self.settings.polling_interval_seconds)),
                download_directory=payload.get("downloadDirectory", self.settings.download_directory),
                hot_folder_path=payload.get("hotFolderPath", self.settings.hot_folder_path),
                photo_print_hot_folder_path=payload.get("photoPrintHotFolderPath", self.settings.photo_print_hot_folder_path),
                photo_gift_hot_folder_path=payload.get("photoGiftHotFolderPath", self.settings.photo_gift_hot_folder_path),
                large_format_hot_folder_path=payload.get("largeFormatHotFolderPath", self.settings.large_format_hot_folder_path),
                large_format_photozone_input_folder_path=payload.get("largeFormatPhotozoneInputFolderPath", legacy_large_format_input),
                large_format_postsnap_input_folder_path=payload.get("largeFormatPostsnapInputFolderPath", self.settings.large_format_postsnap_input_folder_path),
                large_format_output_folder_path=payload.get("largeFormatOutputFolderPath", self.settings.large_format_output_folder_path),
                large_format_batching_interval_minutes=int(payload.get("largeFormatBatchingIntervalMinutes", self.settings.large_format_batching_interval_minutes)),
                large_format_roll_width_in=float(payload.get("largeFormatRollWidthIn", self.settings.large_format_roll_width_in)),
                large_format_gap_mm=float(payload.get("largeFormatGapMm", self.settings.large_format_gap_mm)),
                large_format_leader_mm=float(payload.get("largeFormatLeaderMm", self.settings.large_format_leader_mm)),
                large_format_trailer_mm=float(payload.get("largeFormatTrailerMm", self.settings.large_format_trailer_mm)),
                large_format_left_margin_mm=float(payload.get("largeFormatLeftMarginMm", self.settings.large_format_left_margin_mm)),
                large_format_max_batch_length_mm=float(payload.get("largeFormatMaxBatchLengthMm", self.settings.large_format_max_batch_length_mm)),
                large_format_auto_send=bool(payload.get("largeFormatAutoSend", self.settings.large_format_auto_send)),
                large_format_direct_print=bool(payload.get("largeFormatDirectPrint", self.settings.large_format_direct_print)),
                large_format_printer_name=payload.get("largeFormatPrinterName", self.settings.large_format_printer_name),
                large_format_auto_approve_enabled=bool(payload.get("largeFormatAutoApproveEnabled", self.settings.large_format_auto_approve_enabled)),
                large_format_auto_approve_max_waste_percent=float(payload.get("largeFormatAutoApproveMaxWastePercent", self.settings.large_format_auto_approve_max_waste_percent)),
                large_format_auto_border_if_light_edge=bool(payload.get("largeFormatAutoBorderIfLightEdge", self.settings.large_format_auto_border_if_light_edge)),
                large_format_edge_border_mm=float(payload.get("largeFormatEdgeBorderMm", self.settings.large_format_edge_border_mm)),
                large_format_print_filename_captions=bool(payload.get("largeFormatPrintFilenameCaptions", self.settings.large_format_print_filename_captions)),
                large_format_filename_caption_height_mm=float(payload.get("largeFormatFilenameCaptionHeightMm", self.settings.large_format_filename_caption_height_mm)),
                large_format_filename_caption_font_size_pt=float(payload.get("largeFormatFilenameCaptionFontSizePt", self.settings.large_format_filename_caption_font_size_pt)),
                packing_slip_printer_name=payload.get("packingSlipPrinterName", self.settings.packing_slip_printer_name),
                shipping_label_printer_name=payload.get("shippingLabelPrinterName", self.settings.shipping_label_printer_name),
                use_mock_backend=bool(payload.get("useMockBackend", self.settings.use_mock_backend)),
            )
            self.snapshot.settings = self.settings
            self.configure_backend()
            self.rebuild_scanner()
            self.scanner.start()
            save_settings(self.config_path, self.settings)
            if was_using_mock_backend and not self.settings.use_mock_backend:
                self.snapshot.jobs = self.purge_mock_jobs(self.snapshot.jobs, persist_changes=True)
                self.snapshot.queue_count = sum(
                    1 for item in self.snapshot.jobs if item.status in {JobStatus.PENDING, JobStatus.DOWNLOADING, JobStatus.DOWNLOADED, JobStatus.PROCESSING}
                )
            self.next_poll_at = 0.0
            self.next_large_format_scan_at = 0.0
            self.next_large_format_process_at = 0.0
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

    def path_exists_safe(self, path: str | None, *, scope: str, identifier: str) -> bool:
        if not path:
            return False

        try:
            return Path(path).exists()
        except OSError as exc:
            self.emit_log(
                LogLevel.WARNING,
                f"Ignored invalid path for {identifier}: {path} ({exc})",
                scope,
            )
            return False

    def has_all_local_assets(self, job: JobRecord) -> bool:
        return bool(job.assets) and all(
            self.path_exists_safe(asset.local_path, scope="state", identifier=f"{job.id}/{asset.filename}")
            for asset in job.assets
        )

    def has_active_download(self) -> bool:
        self.active_downloads = {
            job_id: thread for job_id, thread in self.active_downloads.items() if thread.is_alive()
        }
        return bool(self.active_downloads)

    def process_download_results(self) -> None:
        while True:
            try:
                result = self.download_result_queue.get_nowait()
            except queue.Empty:
                return

            job_id = str(result.get("job_id", ""))
            self.active_downloads.pop(job_id, None)
            job = next((item for item in self.snapshot.jobs if item.id == job_id), None)
            if job is None:
                self.local_state.clear_inflight(job_id)
                self.local_state.save(self.paths["state"])
                continue

            if result.get("ok"):
                asset_paths = result.get("asset_paths", {})
                updated_assets = [
                    AssetRecord.from_payload(asset_payload)
                    for asset_payload in result.get("assets", [])
                    if isinstance(asset_payload, dict)
                ]
                for log_message in result.get("logs", []):
                    self.emit_log(LogLevel.INFO, str(log_message), "download")
                updated_job = self.update_job_state(
                    job,
                    JobStatus.DOWNLOADED,
                    local_path=next(iter(asset_paths.values()), None),
                    local_paths=asset_paths if isinstance(asset_paths, dict) else {},
                    assets=updated_assets or job.assets,
                    last_error=None,
                )
                self.safe_backend_update_job_status(updated_job.id, JobStatus.DOWNLOADED)
                self.local_state.clear_inflight(updated_job.id)
                self.local_state.save(self.paths["state"])
                self.emit_log(LogLevel.INFO, f"Job {updated_job.id} received and held locally", "receiver")
                continue

            error_message = str(result.get("error", "Unknown download failure"))
            self.safe_backend_update_job_status(job.id, JobStatus.FAILED, error_message)
            failed = self.update_job_state(job, JobStatus.FAILED, last_error=error_message)
            self.local_state.clear_inflight(job.id)
            self.local_state.save(self.paths["state"])
            self.emit_log(LogLevel.ERROR, f"Job {failed.id} failed during receive: {error_message}", "receiver")
            self.alert_order_failure(failed, stage="receive", error_message=error_message)
            self.snapshot.health = HealthState.ERROR

    def start_background_receive(self, job: JobRecord) -> bool:
        if self.has_active_download() or job.id in self.active_downloads:
            return False

        self.local_state.mark_inflight(job.id, "receive", job)
        self.local_state.save(self.paths["state"])
        try:
            self.backend.claim_job(job.id)
            queued_job = self.update_job_state(job, JobStatus.DOWNLOADING)
            self.safe_backend_update_job_status(job.id, JobStatus.DOWNLOADING)
            self.emit_log(LogLevel.INFO, f"Queued background receive for {job.id}", "receiver")
        except Exception as exc:  # noqa: BLE001
            self.safe_backend_update_job_status(job.id, JobStatus.FAILED, str(exc))
            failed = self.update_job_state(job, JobStatus.FAILED, last_error=str(exc))
            self.local_state.clear_inflight(job.id)
            self.local_state.save(self.paths["state"])
            self.emit_log(LogLevel.ERROR, f"Job {failed.id} failed before background receive: {exc}", "receiver")
            self.alert_order_failure(failed, stage="receive", error_message=str(exc))
            self.snapshot.health = HealthState.ERROR
            return False

        worker_settings = self.settings
        worker_backend = self.backend
        result_queue = self.download_result_queue

        def run_download() -> None:
            try:
                asset_paths: dict[str, str] = {}
                updated_assets: list[dict[str, Any]] = []
                log_messages: list[str] = []
                for asset in queued_job.assets:
                    content, content_type = worker_backend.download_asset(queued_job, asset)
                    destination, thumbnail = write_job_asset(worker_settings, queued_job, asset, content)
                    asset_paths[asset.filename] = str(destination)
                    updated_assets.append(
                        replace(
                            asset,
                            content_type=content_type or asset.content_type,
                            local_path=str(destination),
                            thumbnail_path=str(thumbnail) if thumbnail else None,
                        ).to_payload()
                    )
                    log_messages.append(f"Saved {asset.filename} to {destination}")

                result_queue.put(
                    {
                        "ok": True,
                        "job_id": queued_job.id,
                        "asset_paths": asset_paths,
                        "assets": updated_assets,
                        "logs": log_messages,
                    }
                )
            except Exception as exc:  # noqa: BLE001
                result_queue.put({"ok": False, "job_id": queued_job.id, "error": str(exc)})

        thread = threading.Thread(target=run_download, name=f"receive-{job.id}", daemon=True)
        self.active_downloads[job.id] = thread
        thread.start()
        return True

    def poll_once(self) -> None:
        self.process_download_results()
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

        existing_jobs = {item.id: item for item in self.snapshot.jobs}
        for job in jobs:
            existing = existing_jobs.get(job.id)
            if existing is None:
                self.emit_job(job)
                continue

            refreshed = replace(
                existing,
                status=job.status,
                source=job.source,
                store_id=job.store_id,
                target_machine_id=job.target_machine_id,
                target_location=job.target_location,
                ordered_at=job.ordered_at,
                product_name=job.product_name,
                printer=job.printer,
                customer_name=job.customer_name,
                customer_email=job.customer_email,
                customer_phone=job.customer_phone,
                delivery_method=job.delivery_method,
                shipment_id=job.shipment_id,
                shipping_address_line1=job.shipping_address_line1,
                shipping_address_line2=job.shipping_address_line2,
                shipping_city=job.shipping_city,
                shipping_postcode=job.shipping_postcode,
                shipping_country=job.shipping_country,
                items=job.items,
                print_instructions=job.print_instructions,
                last_error=job.last_error,
                created_at=job.created_at,
                updated_at=job.updated_at,
            )

            if refreshed.to_payload() != existing.to_payload():
                self.emit_job(refreshed)

        for job in jobs:
            if job.id in self.active_downloads:
                continue
            if self.should_skip_job(job):
                continue
            if job.status in {JobStatus.PENDING, JobStatus.FAILED} or job.id in self.retry_queue:
                self.start_background_receive(job)
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
        shipping_label_path: str | None = None,
    ) -> JobRecord:
        updated = replace(
            job,
            status=status,
            local_path=local_path if local_path is not None else job.local_path,
            local_paths=local_paths if local_paths is not None else job.local_paths,
            assets=assets if assets is not None else job.assets,
            last_error=last_error,
            shipping_label_path=shipping_label_path if shipping_label_path is not None else job.shipping_label_path,
            updated_at=now_iso(),
            attempts=job.attempts + (1 if status == JobStatus.FAILED else 0),
        )
        if status != JobStatus.FAILED:
            self.clear_failure_alerts(job.id)
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
            self.alert_order_failure(failed, stage="receive", error_message=str(exc))
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
            self.alert_order_failure(failed, stage="dispatch", error_message=str(exc))
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
                self.alert_order_failure(failed, stage="dispatch", error_message=str(exc))
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
            self.alert_order_failure(restored, stage="reprint", error_message=str(exc))
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

    def print_shipping_label(self, job_id: str) -> Path | None:
        job = next((item for item in self.snapshot.jobs if item.id == job_id), None)
        if job is None:
            self.emit_log(LogLevel.WARNING, f"Label print requested for unknown job {job_id}", "control")
            return None

        cached_label_path = Path(job.shipping_label_path) if job.shipping_label_path else None
        if cached_label_path and cached_label_path.exists():
            self.emit_log(LogLevel.INFO, f"Reprinting cached shipping label for {job.order_id}", "label")
            try:
                self._print_label_pdf(job, cached_label_path)
                self.emit_log(LogLevel.INFO, f"Reprinted shipping label for {job.order_id}", "label")
                self.safe_backend_report_job_event(
                    job_id,
                    "shipping_label_reprinted",
                    {
                        "printed_at": now_iso(),
                        "machine_id": self.settings.machine_id,
                    },
                )
                return cached_label_path
            except Exception as exc:  # noqa: BLE001
                self.emit_log(LogLevel.ERROR, f"Shipping label reprint failed for {job.order_id}: {exc}", "label")
                self.safe_backend_report_job_event(
                    job_id,
                    "shipping_label_reprint_failed",
                    {
                        "failed_at": now_iso(),
                        "machine_id": self.settings.machine_id,
                        "error": str(exc),
                    },
                )
                return None

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
            label_path = create_shipping_label_pdf(
                shipment_id=job.shipment_id,
                order_number=job.order_id,
                api_key=self.settings.shipstation_api_key,
            )
            cached_label_path = cache_shipping_label_pdf(self.settings, job, label_path)
            updated_job = self.update_job_state(
                job,
                job.status,
                local_path=job.local_path,
                local_paths=job.local_paths,
                assets=job.assets,
                last_error=job.last_error,
                shipping_label_path=str(cached_label_path),
            )
            self._print_label_pdf(updated_job, cached_label_path)
            self.emit_log(LogLevel.INFO, f"Printed shipping label for {job.order_id}", "label")
            self.safe_backend_report_job_event(
                job_id,
                "shipping_label_printed",
                {
                    "printed_at": now_iso(),
                    "machine_id": self.settings.machine_id,
                },
            )
            return cached_label_path
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
            return None

    def _print_label_pdf(self, job: JobRecord, label_path: Path) -> None:
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

    def print_shipping_label_for_order_number(
        self,
        order_number: str,
        *,
        source: str,
        job_id: str | None = None,
    ) -> Path | None:
        if job_id:
            self.safe_backend_report_job_event(
                job_id,
                "shipping_label_requested",
                {
                    "requested_at": now_iso(),
                    "machine_id": self.settings.machine_id,
                },
            )
        try:
            label_path = create_shipping_label_pdf(
                order_number=order_number,
                api_key=self.settings.shipstation_api_key,
            )
            cached_label_path = cache_external_shipping_label_pdf(self.settings, order_number, label_path)
            self._print_label_pdf_for_scan(cached_label_path)
            self.emit_scan(
                ScanRecord(
                    id=str(uuid4()),
                    code=order_number,
                    source=source,
                    status="matched",
                    order_id=order_number,
                    can_reprint_label=True,
                    shipping_label_path=str(cached_label_path),
                    message=f"Matched {order_number}; printed label.",
                )
            )
            self.emit_log(LogLevel.INFO, f"Printed ShipStation label for {order_number}", "label")
            if job_id:
                self.safe_backend_report_job_event(
                    job_id,
                    "shipping_label_printed",
                    {
                        "printed_at": now_iso(),
                        "machine_id": self.settings.machine_id,
                    },
                )
            return cached_label_path
        except Exception as exc:  # noqa: BLE001
            self.emit_scan(
                ScanRecord(
                    id=str(uuid4()),
                    code=order_number,
                    source=source,
                    status="failed",
                    message=f"ShipStation label failed: {exc}",
                )
            )
            self.emit_log(LogLevel.ERROR, f"ShipStation label print failed for {order_number}: {exc}", "label")
            if job_id:
                self.safe_backend_report_job_event(
                    job_id,
                    "shipping_label_failed",
                    {
                        "failed_at": now_iso(),
                        "machine_id": self.settings.machine_id,
                        "error": str(exc),
                    },
                )
            return None

    def _print_label_pdf_for_scan(self, label_path: Path) -> None:
        print_pdf(
            label_path,
            PrintInstructions(
                auto_print_pdf=True,
                printer_name=self.settings.shipping_label_printer_name.strip() or None,
                copies=1,
            ),
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

    def complete_job_from_scan(self, job_id: str, *, resolved_job: JobRecord | None = None) -> bool:
        job = next((item for item in self.snapshot.jobs if item.id == job_id), None) or resolved_job
        if job is None:
            self.emit_log(LogLevel.WARNING, f"Scan completion requested for unknown job {job_id}", "scanner")
            return False

        if resolved_job is not None and all(existing.id != resolved_job.id for existing in self.snapshot.jobs):
            self.emit_job(resolved_job)

        self.emit_log(LogLevel.INFO, f"Completing {job_id} from barcode scan", "scanner")

        try:
            completed_job = self.update_job_state(
                job,
                JobStatus.COMPLETED,
                local_path=job.local_path,
                local_paths=job.local_paths,
                assets=job.assets,
                last_error=None,
            )
            self.safe_backend_update_job_status(job.id, JobStatus.COMPLETED, "Completed from barcode scan")
            self.safe_backend_report_job_event(
                job_id,
                "scan_completed",
                {
                    "completed_at": now_iso(),
                    "machine_id": self.settings.machine_id,
                    "resolution": "barcode_scan_completed",
                },
            )
            self.local_state.processed_jobs[job.id] = completed_job.local_path or completed_job.order_id
            self.retry_queue.discard(job.id)
            self.local_state.save(self.paths["state"])
            self.emit_log(LogLevel.INFO, f"Job {job_id} marked completed from barcode scan", "scanner")
            return True
        except Exception as exc:  # noqa: BLE001
            self.emit_log(LogLevel.ERROR, f"Barcode completion failed for {job_id}: {exc}", "scanner")
            return False

    def reprint_scan_label(self, scan_id: str) -> None:
        scan = next((item for item in self.snapshot.scanner.recent_scans if item.id == scan_id), None)
        if scan is None:
            self.emit_log(LogLevel.WARNING, f"Scan label reprint requested for unknown scan {scan_id}", "scanner")
            return

        label_path = Path(scan.shipping_label_path) if scan.shipping_label_path else None
        if label_path is None or not label_path.exists():
            self.emit_log(LogLevel.WARNING, f"No cached label available for scan {scan.code}", "scanner")
            return

        try:
            self._print_label_pdf_for_scan(label_path)
            self.emit_log(LogLevel.INFO, f"Reprinted scanned label for {scan.code}", "label")
        except Exception as exc:  # noqa: BLE001
            self.emit_log(LogLevel.ERROR, f"Scanned label reprint failed for {scan.code}: {exc}", "label")

    def run(self) -> None:
        self.start_command_listener()
        self.scanner.start()
        self.register()

        while not self.stop_event.is_set():
            self.process_pending_commands()
            self.process_download_results()

            if time.time() >= self.next_large_format_scan_at:
                try:
                    self.scan_large_format_folder()
                except Exception as exc:  # noqa: BLE001
                    self.emit_large_format_activity("scan.failed", f"Large-format folder scan failed: {exc}", LogLevel.ERROR)
                self.next_large_format_scan_at = time.time() + 5

            if time.time() >= self.next_large_format_process_at:
                try:
                    self.process_large_format_batches()
                except Exception as exc:  # noqa: BLE001
                    self.emit_large_format_activity("batch.failed", f"Large-format processing failed: {exc}", LogLevel.ERROR)
                self.next_large_format_process_at = time.time() + max(60, self.settings.large_format_batching_interval_minutes * 60)

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
