from __future__ import annotations

import re
import shutil
from pathlib import Path

from px_receiver.config import expand_path
from px_receiver.models import AssetKind, AssetRecord, JobRecord, WorkerSettings

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover - optional runtime dependency
    Image = None
    ImageOps = None

WORKING_RETENTION_DAYS = 7


def _slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    return slug.strip("-") or "job"


def working_root(settings: WorkerSettings) -> Path:
    return expand_path(settings.download_directory) / "orders"


def job_working_dir(settings: WorkerSettings, job: JobRecord) -> Path:
    return working_root(settings) / _slugify(job.order_id)


def originals_dir(settings: WorkerSettings, job: JobRecord) -> Path:
    return job_working_dir(settings, job) / "originals"


def thumbs_dir(settings: WorkerSettings, job: JobRecord) -> Path:
    return job_working_dir(settings, job) / "thumbs"


def normalize_printer_route(value: str | None) -> str:
    return (value or "").strip().casefold().replace("-", "_").replace(" ", "_")


def asset_can_thumbnail(asset: AssetRecord) -> bool:
    content_type = (asset.content_type or "").strip().casefold()
    extension = Path(asset.filename).suffix.strip(".").casefold()
    return asset.kind == AssetKind.IMAGE or content_type.startswith("image/") or extension in {
        "avif",
        "bmp",
        "gif",
        "heic",
        "heif",
        "jpeg",
        "jpg",
        "png",
        "tif",
        "tiff",
        "webp",
    }


def create_thumbnail(settings: WorkerSettings, job: JobRecord, asset: AssetRecord, source: Path) -> Path | None:
    if Image is None or ImageOps is None or not asset_can_thumbnail(asset):
        return None

    target_dir = thumbs_dir(settings, job)
    target_dir.mkdir(parents=True, exist_ok=True)
    destination = target_dir / f"{Path(asset.filename).stem}.jpg"

    try:
        with Image.open(source) as image:
            thumbnail = ImageOps.exif_transpose(image)
            thumbnail.thumbnail((320, 320))
            if thumbnail.mode not in {"RGB", "L"}:
                thumbnail = thumbnail.convert("RGB")
            thumbnail.save(destination, format="JPEG", quality=82, optimize=True)
    except Exception:
        return None

    return destination


def write_job_asset(settings: WorkerSettings, job: JobRecord, asset: AssetRecord, content: bytes) -> tuple[Path, Path | None]:
    target_dir = originals_dir(settings, job)
    target_dir.mkdir(parents=True, exist_ok=True)
    destination = target_dir / asset.filename
    destination.write_bytes(content)
    thumbnail = create_thumbnail(settings, job, asset, destination)

    return destination, thumbnail


def resolve_hot_folder(settings: WorkerSettings, job: JobRecord) -> str:
    printer_route = normalize_printer_route(job.printer)
    if printer_route in {"fuji_lab", "fuji"}:
        return settings.photo_print_hot_folder_path.strip() or settings.hot_folder_path.strip()
    if printer_route == "sublimation":
        return settings.photo_gift_hot_folder_path.strip() or settings.hot_folder_path.strip()
    if printer_route == "large_format":
        return settings.large_format_hot_folder_path.strip() or settings.hot_folder_path.strip()
    if printer_route == "none":
        return settings.hot_folder_path.strip()

    product_name = job.product_name.strip().casefold()
    if product_name == "photo print":
        return settings.photo_print_hot_folder_path.strip() or settings.hot_folder_path.strip()
    if product_name == "photo gift":
        return settings.photo_gift_hot_folder_path.strip() or settings.hot_folder_path.strip()
    if product_name == "large format":
        return settings.large_format_hot_folder_path.strip() or settings.hot_folder_path.strip()
    return settings.hot_folder_path.strip()


def uses_fuji_hot_folder(settings: WorkerSettings, job: JobRecord) -> bool:
    hot_folder = resolve_hot_folder(settings, job)
    photo_print_folder = settings.photo_print_hot_folder_path.strip()
    return bool(photo_print_folder and hot_folder == photo_print_folder)


def release_asset_to_hot_folder(settings: WorkerSettings, job: JobRecord, asset: AssetRecord) -> Path | None:
    hot_folder = resolve_hot_folder(settings, job)
    if not hot_folder or asset.kind == AssetKind.PDF or not asset.local_path:
        return None

    source = Path(asset.local_path)
    if not source.exists():
        raise RuntimeError(f"Held asset missing on disk: {source}")

    hot_folder_path = expand_path(hot_folder)
    hot_folder_path.mkdir(parents=True, exist_ok=True)
    destination_root = hot_folder_path
    if uses_fuji_hot_folder(settings, job):
        destination_root = hot_folder_path / _slugify(job.order_id)
        destination_root.mkdir(parents=True, exist_ok=True)
    destination = destination_root / asset.filename
    shutil.copy2(source, destination)
    return destination


def prune_working_directories(settings: WorkerSettings, jobs: list[JobRecord]) -> None:
    root = working_root(settings)
    if not root.exists():
        return

    keep = {_slugify(job.order_id) for job in jobs}
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        if entry.name in keep:
            continue
        shutil.rmtree(entry, ignore_errors=True)
