from __future__ import annotations

import base64
import os
import tempfile
from pathlib import Path

from urllib import error, parse, request
import json

from px_receiver.services.http import urlopen_with_tls


def _get_base_url(api_base: str | None = None) -> str:
    return (api_base or os.getenv("SHIPSTATION_API_BASE") or "https://api.shipstation.com").rstrip("/")


def _get_headers(api_key: str | None = None) -> dict[str, str]:
    api_key = (api_key or os.getenv("SHIPSTATION_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("ShipStation API key is not configured on this machine.")
    return {
        "API-Key": api_key,
        "Content-Type": "application/json",
    }


def _request_json(method: str, url: str, payload: dict | None = None, *, api_key: str | None = None) -> dict:
    body = None if payload is None else json.dumps(payload).encode()
    req = request.Request(url, data=body, headers=_get_headers(api_key), method=method)
    try:
        with urlopen_with_tls(req, timeout=20) as response:
            raw = response.read().decode()
            return json.loads(raw) if raw else {}
    except error.HTTPError as exc:
        detail = exc.read().decode(errors="ignore")
        raise RuntimeError(f"ShipStation request failed ({exc.code}): {detail or exc.reason}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"ShipStation request failed: {exc.reason}") from exc


def _normalize_label_response(payload: dict, *, api_key: str | None = None) -> bytes:
    if payload.get("labelData"):
        return base64.b64decode(payload["labelData"])

    if payload.get("labelDownload"):
        return _download_binary(str(payload["labelDownload"]), api_key=api_key)

    label_download = payload.get("label_download") or {}
    if isinstance(label_download, dict):
        href = label_download.get("href") or label_download.get("pdf")
        if href:
            return _download_binary(str(href), api_key=api_key)

    raise RuntimeError("ShipStation did not return printable label data.")


def _download_binary(url: str, *, api_key: str | None = None) -> bytes:
    req = request.Request(url, headers=_get_headers(api_key), method="GET")
    try:
        with urlopen_with_tls(req, timeout=20) as response:
            return response.read()
    except error.HTTPError as exc:
        detail = exc.read().decode(errors="ignore")
        raise RuntimeError(f"ShipStation label download failed ({exc.code}): {detail or exc.reason}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"ShipStation label download failed: {exc.reason}") from exc


def _find_shipment_id_with_params(
    order_number: str,
    *,
    param_names: tuple[str, ...],
    api_key: str | None = None,
    api_base: str | None = None,
) -> str | None:
    base_url = _get_base_url(api_base)
    for param_name in param_names:
        page = 1
        while True:
            query = parse.urlencode({param_name: order_number, "page": page, "pageSize": 200})
            payload = _request_json("GET", f"{base_url}/v2/shipments?{query}", api_key=api_key)
            shipments = payload.get("shipments") or payload.get("data") or []

            for shipment in shipments:
                shipment_id = shipment.get("shipmentId") or shipment.get("shipment_id") or shipment.get("id")
                shipment_number = shipment.get("shipmentNumber") or shipment.get("shipment_number")
                related_order = shipment.get("orderNumber") or shipment.get("order_number")
                if shipment_id and (
                    str(shipment_number) == str(order_number) or str(related_order) == str(order_number)
                ):
                    return str(shipment_id)
                if shipment_id and len(shipments) == 1:
                    return str(shipment_id)

            total_pages = payload.get("pages") or payload.get("totalPages")
            if total_pages and page >= int(total_pages):
                break
            if len(shipments) < 200:
                break
            page += 1

    return None


def find_shipment_id(order_number: str, *, api_key: str | None = None, api_base: str | None = None) -> str:
    fast_match = _find_shipment_id_with_params(
        order_number,
        param_names=("shipment_number", "shipmentNumber"),
        api_key=api_key,
        api_base=api_base,
    )
    if fast_match:
        return fast_match

    fallback_match = _find_shipment_id_with_params(
        order_number,
        param_names=("orderNumber", "order_number"),
        api_key=api_key,
        api_base=api_base,
    )
    if fallback_match:
        return fallback_match

    raise RuntimeError(f"No ShipStation shipment found for {order_number}.")


def create_shipping_label_pdf(
    *,
    shipment_id: str | None = None,
    order_number: str | None = None,
    api_key: str | None = None,
    api_base: str | None = None,
) -> Path:
    target_shipment_id = shipment_id or (
        find_shipment_id(order_number, api_key=api_key, api_base=api_base) if order_number else None
    )
    if not target_shipment_id:
        raise RuntimeError("No shipment ID is available for this order.")

    payload = _request_json(
        "POST",
        f"{_get_base_url(api_base)}/v2/labels/shipment/{target_shipment_id}",
        {},
        api_key=api_key,
    )
    label_bytes = _normalize_label_response(payload, api_key=api_key)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as temp_file:
        temp_file.write(label_bytes)
        return Path(temp_file.name)
