from __future__ import annotations

import json
from urllib import request

from px_receiver.models import JobRecord, WorkerSettings
from px_receiver.services.http import urlopen_with_tls


def notify_order_failure(
    settings: WorkerSettings,
    job: JobRecord,
    *,
    stage: str,
    error_message: str,
) -> None:
    webhook_url = str(settings.slack_webhook_url or "").strip()
    if not webhook_url:
        return

    lines = [
        ":warning: PX Receiver Order Failure",
        f"*Order:* {job.order_id}",
        f"*Job:* {job.id}",
        f"*Stage:* {stage}",
        f"*Customer:* {job.customer_name or 'Unknown Customer'}",
        f"*Product:* {job.product_name}",
        f"*Machine:* {settings.machine_name or settings.machine_id}",
        f"*Error:* {error_message}",
    ]

    payload = json.dumps({"text": "\n".join(lines)}).encode("utf-8")
    req = request.Request(
        webhook_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen_with_tls(req, timeout=10) as response:  # noqa: S310
        if response.status >= 400:
            raise RuntimeError(f"Slack webhook returned HTTP {response.status}")
