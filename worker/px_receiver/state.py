from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path

from px_receiver.models import LargeFormatActivity, LargeFormatBatch, LargeFormatJob, JobRecord, LogRecord, ScanRecord, now_iso, parse_iso

RETENTION_DAYS = 7


@dataclass(slots=True)
class LocalState:
    processed_jobs: dict[str, str] = field(default_factory=dict)
    retries: dict[str, int] = field(default_factory=dict)
    inflight_actions: dict[str, dict] = field(default_factory=dict)
    jobs: list[dict] = field(default_factory=list)
    logs: list[dict] = field(default_factory=list)
    scans: list[dict] = field(default_factory=list)
    large_format_jobs: list[dict] = field(default_factory=list)
    large_format_batches: list[dict] = field(default_factory=list)
    large_format_activity: list[dict] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> "LocalState":
        if not path.exists():
            return cls()

        payload = json.loads(path.read_text())
        return cls(
            processed_jobs=dict(payload.get("processedJobs", {})),
            retries={key: int(value) for key, value in payload.get("retries", {}).items()},
            inflight_actions=dict(payload.get("inflightActions", {})),
            jobs=list(payload.get("jobs", [])),
            logs=list(payload.get("logs", [])),
            scans=list(payload.get("scans", [])),
            large_format_jobs=list(payload.get("largeFormatJobs", [])),
            large_format_batches=list(payload.get("largeFormatBatches", [])),
            large_format_activity=list(payload.get("largeFormatActivity", [])),
        )

    def save(self, path: Path) -> None:
        self.prune_history()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "processedJobs": self.processed_jobs,
                    "retries": self.retries,
                    "inflightActions": self.inflight_actions,
                    "jobs": self.jobs,
                    "logs": self.logs,
                    "scans": self.scans,
                    "largeFormatJobs": self.large_format_jobs,
                    "largeFormatBatches": self.large_format_batches,
                    "largeFormatActivity": self.large_format_activity,
                },
                indent=2,
            )
        )

    def prune_history(self) -> None:
        cutoff = parse_iso(now_iso())
        if cutoff is None:
            return
        cutoff = cutoff - timedelta(days=RETENTION_DAYS)
        self.jobs = self._prune_items(self.jobs, "updatedAt", cutoff, limit=300)
        self.logs = self._prune_items(self.logs, "timestamp", cutoff, limit=500)
        self.scans = self._prune_items(self.scans, "timestamp", cutoff, limit=200)
        self.large_format_jobs = self._prune_items(self.large_format_jobs, "updatedAt", cutoff, limit=500)
        self.large_format_batches = self._prune_items(self.large_format_batches, "updatedAt", cutoff, limit=300)
        self.large_format_activity = self._prune_items(self.large_format_activity, "timestamp", cutoff, limit=500)

    def hydrate_jobs(self) -> list[JobRecord]:
        self.prune_history()
        return [JobRecord.from_payload(job) for job in self.jobs]

    def hydrate_logs(self) -> list[LogRecord]:
        self.prune_history()
        return [LogRecord.from_payload(log) for log in self.logs]

    def hydrate_scans(self) -> list[ScanRecord]:
        self.prune_history()
        return [ScanRecord.from_payload(scan) for scan in self.scans]

    def remember_job(self, job: JobRecord) -> None:
        payload = job.to_payload()
        self.jobs = [payload, *[item for item in self.jobs if item.get("id") != job.id]]
        self.prune_history()

    def remember_log(self, log: LogRecord) -> None:
        payload = log.to_payload()
        self.logs = [payload, *[item for item in self.logs if item.get("id") != log.id]]
        self.prune_history()

    def remember_scan(self, scan: ScanRecord) -> None:
        payload = scan.to_payload()
        self.scans = [payload, *[item for item in self.scans if item.get("id") != scan.id]]
        self.prune_history()

    def hydrate_large_format_jobs(self) -> list[LargeFormatJob]:
        self.prune_history()
        return [LargeFormatJob.from_payload(job) for job in self.large_format_jobs]

    def hydrate_large_format_batches(self) -> list[LargeFormatBatch]:
        self.prune_history()
        return [LargeFormatBatch.from_payload(batch) for batch in self.large_format_batches]

    def hydrate_large_format_activity(self) -> list[LargeFormatActivity]:
        self.prune_history()
        return [LargeFormatActivity.from_payload(entry) for entry in self.large_format_activity]

    def remember_large_format_job(self, job: LargeFormatJob) -> None:
        payload = job.to_payload()
        self.large_format_jobs = [payload, *[item for item in self.large_format_jobs if item.get("id") != job.id]]
        self.prune_history()

    def remember_large_format_batch(self, batch: LargeFormatBatch) -> None:
        payload = batch.to_payload()
        self.large_format_batches = [payload, *[item for item in self.large_format_batches if item.get("id") != batch.id]]
        self.prune_history()

    def remember_large_format_activity(self, entry: LargeFormatActivity) -> None:
        payload = entry.to_payload()
        self.large_format_activity = [payload, *[item for item in self.large_format_activity if item.get("id") != entry.id]]
        self.prune_history()

    def mark_inflight(self, job_id: str, kind: str, original_job: JobRecord | None = None) -> None:
        payload = {
            "kind": kind,
            "startedAt": now_iso(),
        }
        if original_job is not None:
            payload["originalJob"] = original_job.to_payload()
        self.inflight_actions[job_id] = payload

    def clear_inflight(self, job_id: str) -> None:
        self.inflight_actions.pop(job_id, None)

    def _prune_items(self, items: list[dict], key: str, cutoff, limit: int) -> list[dict]:
        kept: list[dict] = []
        for item in items:
            item_time = parse_iso(item.get(key))
            if item_time is None or item_time >= cutoff:
                kept.append(item)
        return kept[:limit]
