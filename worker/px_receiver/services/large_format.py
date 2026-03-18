from __future__ import annotations

import math
import shutil
from pathlib import Path
from dataclasses import dataclass
from uuid import uuid4

from PIL import Image, ImageOps
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from px_receiver.config import expand_path
from px_receiver.models import LargeFormatBatch, LargeFormatBatchStatus, LargeFormatJob, LargeFormatJobStatus, LargeFormatPlacement, WorkerSettings, now_iso

MM_PER_INCH = 25.4
POINTS_PER_INCH = 72
SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
MAX_EXACT_LAYOUT_ITEMS = 12


@dataclass(slots=True)
class RowPlacement:
    item_index: int
    width_mm: float
    height_mm: float
    rotated: bool


@dataclass(slots=True)
class RowOption:
    mask: int
    row_height_mm: float
    used_width_mm: float
    placements: list[RowPlacement]


def inches_to_mm(value: float) -> float:
    return value * MM_PER_INCH


def mm_to_points(value: float) -> float:
    return (value / MM_PER_INCH) * POINTS_PER_INCH


def round_mm(value: float) -> float:
    return round(value, 2)


def large_format_photozone_input_path(settings: WorkerSettings) -> Path:
    return expand_path(settings.large_format_photozone_input_folder_path)


def large_format_postsnap_input_path(settings: WorkerSettings) -> Path:
    return expand_path(settings.large_format_postsnap_input_folder_path)


def large_format_input_paths(settings: WorkerSettings) -> dict[str, Path]:
    return {
        "photozone": large_format_photozone_input_path(settings),
        "postsnap": large_format_postsnap_input_path(settings),
    }


def large_format_output_path(settings: WorkerSettings) -> Path:
    return expand_path(settings.large_format_output_folder_path)


def large_format_hot_folder_path(settings: WorkerSettings) -> Path:
    return expand_path(settings.large_format_hot_folder_path)


def inspect_image(path: Path) -> tuple[float | None, float | None, bool, str | None]:
    if path.suffix.lower() not in SUPPORTED_IMAGE_EXTENSIONS:
        return None, None, False, "Only image files are supported in this large-format v1 branch."

    with Image.open(path) as image:
        dpi_info = image.info.get("dpi")
        dpi_x = None
        dpi_y = None
        if isinstance(dpi_info, tuple) and len(dpi_info) >= 2:
          dpi_x = float(dpi_info[0]) if dpi_info[0] else None
          dpi_y = float(dpi_info[1]) if dpi_info[1] else None

        if not dpi_x or not dpi_y:
            return None, None, False, "Image is missing usable DPI metadata, so physical print size cannot be confirmed."

        width_in = image.width / dpi_x
        height_in = image.height / dpi_y
        needs_border = detect_light_edge(image)
        return width_in, height_in, needs_border, None


def detect_light_edge(image: Image.Image) -> bool:
    sample = ImageOps.exif_transpose(image).convert("RGB")
    sample.thumbnail((64, 64))
    width, height = sample.size
    if width == 0 or height == 0:
        return False

    luminance_total = 0.0
    saturation_total = 0.0
    count = 0

    def visit(x: int, y: int) -> None:
        nonlocal luminance_total, saturation_total, count
        r, g, b = sample.getpixel((x, y))
        luminance_total += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
        saturation_total += rgb_to_saturation(r, g, b)
        count += 1

    for x in range(width):
        visit(x, 0)
        if height > 1:
            visit(x, height - 1)

    for y in range(1, height - 1):
        visit(0, y)
        if width > 1:
            visit(width - 1, y)

    if count == 0:
        return False

    average_luminance = luminance_total / count
    average_saturation = saturation_total / count
    return average_luminance >= 0.9 and average_saturation <= 0.12


def rgb_to_saturation(r: int, g: int, b: int) -> float:
    r_n = r / 255
    g_n = g / 255
    b_n = b / 255
    max_value = max(r_n, g_n, b_n)
    min_value = min(r_n, g_n, b_n)
    lightness = (max_value + min_value) / 2
    delta = max_value - min_value
    if delta == 0:
        return 0
    return delta / (1 - abs(2 * lightness - 1))


def build_large_format_job(path: Path, source: str) -> LargeFormatJob:
    width_in, height_in, needs_border, error = inspect_image(path)
    status = LargeFormatJobStatus.WAITING if width_in and height_in else LargeFormatJobStatus.NEEDS_REVIEW
    return LargeFormatJob(
        id=str(uuid4()),
        filename=path.name,
        original_path=str(path),
        width_in=width_in,
        height_in=height_in,
        media_type="lustre",
        quantity=1,
        source=source,
        status=status,
        parse_source="image-dpi" if width_in and height_in else "needs-review",
        notes=error,
        needs_border=needs_border,
    )


def _candidate_orientations(job: LargeFormatJob, printable_width_mm: float) -> list[tuple[float, float, bool]]:
    width_mm = inches_to_mm(job.width_in or 0)
    height_mm = inches_to_mm(job.height_in or 0)
    candidates: list[tuple[float, float, bool]] = []
    if width_mm <= printable_width_mm:
        candidates.append((width_mm, height_mm, False))
    if height_mm <= printable_width_mm and not math.isclose(width_mm, height_mm):
        candidates.append((height_mm, width_mm, True))
    return candidates


def _job_sort_variants(jobs: list[LargeFormatJob]) -> list[tuple[str, list[LargeFormatJob]]]:
    items = [job for job in jobs if job.width_in and job.height_in]
    variants: list[tuple[str, list[LargeFormatJob]]] = []
    seen_signatures: set[tuple[str, ...]] = set()

    strategies = [
        ("longest-edge", lambda job: (max(job.width_in or 0, job.height_in or 0), min(job.width_in or 0, job.height_in or 0))),
        ("shortest-edge", lambda job: (min(job.width_in or 0, job.height_in or 0), max(job.width_in or 0, job.height_in or 0))),
        ("area", lambda job: ((job.width_in or 0) * (job.height_in or 0), max(job.width_in or 0, job.height_in or 0))),
        ("width", lambda job: (job.width_in or 0, job.height_in or 0)),
        ("height", lambda job: (job.height_in or 0, job.width_in or 0)),
    ]

    for name, key_fn in strategies:
        for suffix, reverse in (("desc", True), ("asc", False)):
            ordered = sorted(items, key=key_fn, reverse=reverse)
            signature = tuple(job.id for job in ordered)
            if signature in seen_signatures:
                continue
            seen_signatures.add(signature)
            variants.append((f"{name}-{suffix}", ordered))

    return variants


def _bit_count(value: int) -> int:
    return value.bit_count()


def _row_options_exact(
    jobs: list[LargeFormatJob],
    *,
    printable_width_mm: float,
    caption_height_mm: float,
    gap_mm: float,
) -> dict[int, RowOption]:
    options: dict[int, RowOption] = {}
    orientation_cache = {
        index: _candidate_orientations(job, printable_width_mm)
        for index, job in enumerate(jobs)
    }

    for mask in range(1, 1 << len(jobs)):
        indices = [index for index in range(len(jobs)) if mask & (1 << index)]
        best_option: RowOption | None = None

        def explore(position: int, current: list[RowPlacement], used_width_mm: float, row_height_mm: float) -> None:
            nonlocal best_option
            if position >= len(indices):
                ordered = sorted(current, key=lambda item: (-item.width_mm, -item.height_mm, item.item_index))
                option = RowOption(mask=mask, row_height_mm=round_mm(row_height_mm), used_width_mm=round_mm(used_width_mm), placements=ordered)
                if best_option is None:
                    best_option = option
                    return
                if option.row_height_mm < best_option.row_height_mm:
                    best_option = option
                    return
                if math.isclose(option.row_height_mm, best_option.row_height_mm) and option.used_width_mm > best_option.used_width_mm:
                    best_option = option
                return

            item_index = indices[position]
            for width_mm, height_mm, rotated in orientation_cache[item_index]:
                next_used_width_mm = used_width_mm + width_mm + (gap_mm if current else 0.0)
                if next_used_width_mm > printable_width_mm:
                    continue
                explore(
                    position + 1,
                    [*current, RowPlacement(item_index=item_index, width_mm=width_mm, height_mm=height_mm, rotated=rotated)],
                    next_used_width_mm,
                    max(row_height_mm, height_mm + caption_height_mm),
                )

        explore(0, [], 0.0, 0.0)
        if best_option is not None:
            options[mask] = best_option

    return options


def _build_layout_exact(
    settings: WorkerSettings,
    jobs: list[LargeFormatJob],
    *,
    printable_width_mm: float,
    caption_height_mm: float,
    max_batch_length_mm: float,
) -> tuple[str, list[LargeFormatPlacement], float, float]:
    row_options = _row_options_exact(
        jobs,
        printable_width_mm=printable_width_mm,
        caption_height_mm=caption_height_mm,
        gap_mm=settings.large_format_gap_mm,
    )
    if not row_options:
        raise RuntimeError("No large-format jobs fit within the current batch constraints.")

    areas_by_index = {
        index: inches_to_mm(job.width_in or 0) * inches_to_mm(job.height_in or 0)
        for index, job in enumerate(jobs)
    }
    area_by_mask: dict[int, float] = {0: 0.0}
    for mask in range(1, 1 << len(jobs)):
        least_bit = mask & -mask
        index = least_bit.bit_length() - 1
        area_by_mask[mask] = area_by_mask[mask ^ least_bit] + areas_by_index[index]

    best_for_mask: dict[int, tuple[float, list[RowOption]]] = {0: (0.0, [])}

    for placed_mask in range(1 << len(jobs)):
        current = best_for_mask.get(placed_mask)
        if current is None:
            continue
        current_height_mm, current_rows = current
        remaining = ((1 << len(jobs)) - 1) ^ placed_mask
        subset = remaining
        while subset:
            option = row_options.get(subset)
            if option is not None:
                additional_height_mm = option.row_height_mm + (settings.large_format_gap_mm if current_rows else 0.0)
                next_height_mm = current_height_mm + additional_height_mm
                total_length_mm = settings.large_format_leader_mm + next_height_mm + settings.large_format_trailer_mm
                next_mask = placed_mask | subset
                existing = best_for_mask.get(next_mask)
                if total_length_mm <= max_batch_length_mm and (
                    existing is None or next_height_mm < existing[0]
                ):
                    best_for_mask[next_mask] = (next_height_mm, [*current_rows, option])
            subset = (subset - 1) & remaining

    best_mask = 0
    best_score: tuple[int, float, float] | None = None
    for mask, (height_mm, _) in best_for_mask.items():
        if mask == 0:
            continue
        score = (_bit_count(mask), -(settings.large_format_leader_mm + height_mm + settings.large_format_trailer_mm), area_by_mask[mask])
        if best_score is None or score > best_score:
            best_score = score
            best_mask = mask

    if best_mask == 0:
        first_job = jobs[0]
        raise RuntimeError(
            f"{first_job.filename} exceeds the maximum batch length of {round_mm(max_batch_length_mm)} mm and needs manual review."
        )

    used_rows = best_for_mask[best_mask][1]
    cursor_y = settings.large_format_leader_mm
    placements: list[LargeFormatPlacement] = []
    sort_order = 0

    for row_index, row in enumerate(used_rows):
        if row_index > 0:
            previous_row = used_rows[row_index - 1]
            cursor_y += previous_row.row_height_mm + settings.large_format_gap_mm

        cursor_x = settings.large_format_left_margin_mm
        for placement in row.placements:
            job = jobs[placement.item_index]
            placements.append(
                LargeFormatPlacement(
                    job_id=job.id,
                    filename=job.filename,
                    x_mm=round_mm(cursor_x),
                    y_mm=round_mm(cursor_y),
                    placed_width_mm=round_mm(placement.width_mm),
                    placed_height_mm=round_mm(placement.height_mm),
                    rotated=placement.rotated,
                    sort_order=sort_order,
                    add_black_border=job.needs_border and settings.large_format_auto_border_if_light_edge,
                )
            )
            sort_order += 1
            cursor_x += placement.width_mm + settings.large_format_gap_mm

    final_height_mm = best_for_mask[best_mask][0]
    used_length_mm = round_mm(settings.large_format_leader_mm + final_height_mm + settings.large_format_trailer_mm)
    total_area = area_by_mask[best_mask]
    roll_width_mm = inches_to_mm(settings.large_format_roll_width_in)
    waste_percent = round(
        0 if used_length_mm <= 0 else ((roll_width_mm * used_length_mm - total_area) / (roll_width_mm * used_length_mm)) * 100,
        1,
    )
    return "exact-shelf-dp", placements, used_length_mm, waste_percent


def _build_layout_attempt(
    settings: WorkerSettings,
    jobs: list[LargeFormatJob],
    *,
    printable_width_mm: float,
    caption_height_mm: float,
    max_batch_length_mm: float,
) -> tuple[list[LargeFormatPlacement], float, float]:
    placements: list[LargeFormatPlacement] = []
    cursor_x = settings.large_format_left_margin_mm
    cursor_y = settings.large_format_leader_mm
    row_height = 0.0
    total_area = 0.0

    for index, job in enumerate(jobs):
        candidates = _candidate_orientations(job, printable_width_mm)
        if not candidates:
            raise RuntimeError(f"{job.filename} exceeds the configured roll width.")

        chosen_width_mm = 0.0
        chosen_height_mm = 0.0
        chosen_rotated = False
        chosen_row_break = False
        best_score: tuple[float, float, float, float] | None = None

        for width_mm, height_mm, rotated in candidates:
            fits_current_row = cursor_x == settings.large_format_left_margin_mm or (cursor_x + settings.large_format_gap_mm + width_mm) <= (settings.large_format_left_margin_mm + printable_width_mm)
            projected_row_height = max(row_height, height_mm + caption_height_mm) if fits_current_row else (height_mm + caption_height_mm)
            projected_length = cursor_y + projected_row_height + settings.large_format_trailer_mm
            projected_used_width = width_mm if cursor_x == settings.large_format_left_margin_mm or not fits_current_row else (cursor_x - settings.large_format_left_margin_mm) + settings.large_format_gap_mm + width_mm
            wasted_row_width = printable_width_mm - projected_used_width
            score = (
                projected_length,
                projected_row_height,
                wasted_row_width,
                width_mm,
            )
            if best_score is None or score < best_score:
                best_score = score
                chosen_width_mm = width_mm
                chosen_height_mm = height_mm
                chosen_rotated = rotated
                chosen_row_break = not fits_current_row and cursor_x > 0

        if chosen_row_break:
            cursor_y += row_height + settings.large_format_gap_mm
            cursor_x = settings.large_format_left_margin_mm
            row_height = 0.0

        placement_x = settings.large_format_left_margin_mm if cursor_x == settings.large_format_left_margin_mm else cursor_x + settings.large_format_gap_mm
        projected_row_height = max(row_height, chosen_height_mm + caption_height_mm)
        projected_used_length_mm = cursor_y + projected_row_height + settings.large_format_trailer_mm
        if projected_used_length_mm > max_batch_length_mm:
            if placements:
                break
            raise RuntimeError(
                f"{job.filename} exceeds the maximum batch length of {round_mm(max_batch_length_mm)} mm and needs manual review."
            )

        placements.append(
            LargeFormatPlacement(
                job_id=job.id,
                filename=job.filename,
                x_mm=round_mm(placement_x),
                y_mm=round_mm(cursor_y),
                placed_width_mm=round_mm(chosen_width_mm),
                placed_height_mm=round_mm(chosen_height_mm),
                rotated=chosen_rotated,
                sort_order=index,
                add_black_border=job.needs_border and settings.large_format_auto_border_if_light_edge,
            )
        )
        cursor_x = placement_x + chosen_width_mm
        row_height = projected_row_height
        total_area += chosen_width_mm * chosen_height_mm

    if not placements:
        raise RuntimeError("No large-format jobs fit within the current batch constraints.")

    used_length_mm = round_mm(cursor_y + row_height + settings.large_format_trailer_mm)
    roll_width_mm = inches_to_mm(settings.large_format_roll_width_in)
    waste_percent = round(0 if used_length_mm <= 0 else ((roll_width_mm * used_length_mm - total_area) / (roll_width_mm * used_length_mm)) * 100, 1)
    return placements, used_length_mm, waste_percent


def create_layout_batch(settings: WorkerSettings, jobs: list[LargeFormatJob]) -> LargeFormatBatch:
    roll_width_mm = inches_to_mm(settings.large_format_roll_width_in)
    printable_width_mm = max(1.0, roll_width_mm - settings.large_format_left_margin_mm)
    caption_height_mm = settings.large_format_filename_caption_height_mm if settings.large_format_print_filename_captions else 0.0
    max_batch_length_mm = max(
        settings.large_format_max_batch_length_mm,
        settings.large_format_leader_mm + settings.large_format_trailer_mm + 1,
    )
    items = [job for job in jobs if job.width_in and job.height_in]
    if not items:
        raise RuntimeError("No large-format jobs fit within the current batch constraints.")

    if len(items) <= MAX_EXACT_LAYOUT_ITEMS:
        strategy_name, placements, used_length_mm, waste_percent = _build_layout_exact(
            settings,
            items,
            printable_width_mm=printable_width_mm,
            caption_height_mm=caption_height_mm,
            max_batch_length_mm=max_batch_length_mm,
        )
    else:
        best_result: tuple[tuple[float, float, float], str, list[LargeFormatPlacement], float, float] | None = None
        last_error: RuntimeError | None = None

        for strategy_name, ordered_jobs in _job_sort_variants(items):
            try:
                placements, used_length_mm, waste_percent = _build_layout_attempt(
                    settings,
                    ordered_jobs,
                    printable_width_mm=printable_width_mm,
                    caption_height_mm=caption_height_mm,
                    max_batch_length_mm=max_batch_length_mm,
                )
            except RuntimeError as exc:
                last_error = exc
                continue

            score = (-len(placements), used_length_mm, waste_percent)
            if best_result is None or score < best_result[0]:
                best_result = (score, strategy_name, placements, used_length_mm, waste_percent)

        if best_result is None:
            raise last_error or RuntimeError("No large-format jobs fit within the current batch constraints.")

        _, strategy_name, placements, used_length_mm, waste_percent = best_result

    return LargeFormatBatch(
        id=str(uuid4()),
        status=LargeFormatBatchStatus.PENDING,
        media_type="lustre",
        roll_width_in=settings.large_format_roll_width_in,
        gap_mm=settings.large_format_gap_mm,
        leader_mm=settings.large_format_leader_mm,
        trailer_mm=settings.large_format_trailer_mm,
        caption_height_mm=caption_height_mm,
        used_length_mm=used_length_mm,
        waste_percent=waste_percent,
        notes=f"Layout strategy {strategy_name}. Left margin {round_mm(settings.large_format_left_margin_mm)} mm. Max batch length {round_mm(max_batch_length_mm)} mm.",
        placements=placements,
    )


def render_batch_pdf(settings: WorkerSettings, batch: LargeFormatBatch, jobs_by_id: dict[str, LargeFormatJob]) -> str:
    output_dir = large_format_output_path(settings)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"large-format-batch-{batch.id}.pdf"
    pdf = canvas.Canvas(str(output_path), pagesize=(mm_to_points(inches_to_mm(batch.roll_width_in)), mm_to_points(batch.used_length_mm)))

    for placement in batch.placements:
        job = jobs_by_id.get(placement.job_id)
        if job is None:
            continue

        x = mm_to_points(placement.x_mm)
        y = mm_to_points(batch.used_length_mm - placement.y_mm - placement.placed_height_mm)
        width = mm_to_points(placement.placed_width_mm)
        height = mm_to_points(placement.placed_height_mm)

        pdf.setStrokeColorRGB(0.86, 0.89, 0.93)
        pdf.setLineWidth(0.5)
        pdf.rect(x, y, width, height, stroke=1, fill=0)

        source_path = Path(job.original_path)
        with Image.open(source_path) as image:
            source = ImageOps.exif_transpose(image).convert("RGB")
            if placement.rotated:
                source = source.rotate(90, expand=True)
            pdf.drawImage(ImageReader(source), x, y, width=width, height=height, preserveAspectRatio=False, mask="auto")

        if placement.add_black_border:
            pdf.setStrokeColorRGB(0, 0, 0)
            pdf.setLineWidth(mm_to_points(settings.large_format_edge_border_mm))
            border_offset = mm_to_points(settings.large_format_edge_border_mm) / 2
            pdf.rect(x + border_offset, y + border_offset, width - border_offset * 2, height - border_offset * 2, stroke=1, fill=0)

        if settings.large_format_print_filename_captions:
            pdf.setFillColorRGB(0.12, 0.14, 0.18)
            pdf.setFont("Helvetica", settings.large_format_filename_caption_font_size_pt)
            pdf.drawString(x, y - mm_to_points(1.5) - settings.large_format_filename_caption_font_size_pt, job.filename[:80])

    pdf.showPage()
    pdf.save()
    return str(output_path)


def send_batch_to_hot_folder(settings: WorkerSettings, batch: LargeFormatBatch) -> str:
    if not batch.output_pdf_path:
        raise RuntimeError("Batch does not have an output PDF to send.")
    hot_folder = large_format_hot_folder_path(settings)
    hot_folder.mkdir(parents=True, exist_ok=True)
    destination = hot_folder / Path(batch.output_pdf_path).name
    shutil.copy2(batch.output_pdf_path, destination)
    return str(destination)
