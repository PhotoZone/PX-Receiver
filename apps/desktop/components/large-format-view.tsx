"use client";

import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { openPathInOs, toLocalAssetPreviewUrl } from "@/lib/tauri";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { cn, formatDateTime } from "@/lib/utils";

const batchStyles = {
  pending: "border border-slate-700 bg-slate-900/80 text-slate-200",
  ready: "border border-emerald-500/30 bg-emerald-500/15 text-emerald-200",
  approved: "border border-cyan-500/30 bg-cyan-500/15 text-cyan-200",
  printing: "border border-amber-500/30 bg-amber-500/15 text-amber-200",
  sent: "border border-blue-500/30 bg-blue-500/15 text-blue-200",
  failed: "border border-rose-500/30 bg-rose-500/15 text-rose-200",
  cancelled: "border border-zinc-500/30 bg-zinc-500/15 text-zinc-200",
} as const;

const jobStyles = {
  waiting: "border border-sky-500/30 bg-sky-500/15 text-sky-200",
  needs_review: "border border-amber-500/30 bg-amber-500/15 text-amber-200",
  batched: "border border-indigo-500/30 bg-indigo-500/15 text-indigo-200",
  ready: "border border-emerald-500/30 bg-emerald-500/15 text-emerald-200",
  failed: "border border-rose-500/30 bg-rose-500/15 text-rose-200",
} as const;

const sourceStyles = {
  photozone: {
    label: "Photo Zone",
    cardClassName: "border-blue-500/20 bg-blue-500/10",
    badgeClassName: "border-blue-400/30 bg-blue-500/80 text-blue-50",
  },
  postsnap: {
    label: "PostSnap",
    cardClassName: "border-rose-500/20 bg-rose-500/10",
    badgeClassName: "border-rose-400/30 bg-rose-600 text-rose-50",
  },
  unknown: {
    label: "Unknown",
    cardClassName: "border-white/10 bg-white/[0.03]",
    badgeClassName: "border-white/10 bg-white/10 text-slate-200",
  },
} as const;

const MM_PER_INCH = 25.4;
const MAX_EXACT_LAYOUT_ITEMS = 12;

function inchesToMm(value: number) {
  return value * MM_PER_INCH;
}

function buildSortVariants(items: Array<{ id: string; widthIn: number; heightIn: number }>) {
  const variants: Array<Array<{ id: string; widthIn: number; heightIn: number }>> = [];
  const seen = new Set<string>();
  const strategies = [
    (item: { widthIn: number; heightIn: number }) => [Math.max(item.widthIn, item.heightIn), Math.min(item.widthIn, item.heightIn)],
    (item: { widthIn: number; heightIn: number }) => [Math.min(item.widthIn, item.heightIn), Math.max(item.widthIn, item.heightIn)],
    (item: { widthIn: number; heightIn: number }) => [item.widthIn * item.heightIn, Math.max(item.widthIn, item.heightIn)],
    (item: { widthIn: number; heightIn: number }) => [item.widthIn, item.heightIn],
    (item: { widthIn: number; heightIn: number }) => [item.heightIn, item.widthIn],
  ];

  for (const strategy of strategies) {
    for (const direction of [1, -1]) {
      const ordered = [...items].sort((left, right) => {
        const leftKey = strategy(left);
        const rightKey = strategy(right);
        for (let index = 0; index < Math.max(leftKey.length, rightKey.length); index += 1) {
          const leftValue = leftKey[index] ?? 0;
          const rightValue = rightKey[index] ?? 0;
          if (leftValue !== rightValue) {
            return (rightValue - leftValue) * direction;
          }
        }
        return left.id.localeCompare(right.id);
      });
      const signature = ordered.map((item) => item.id).join("|");
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      variants.push(ordered);
    }
  }

  return variants;
}

function bitCount(value: number) {
  let remaining = value;
  let count = 0;
  while (remaining > 0) {
    count += remaining & 1;
    remaining >>= 1;
  }
  return count;
}

function buildExactEstimate(params: {
  items: Array<{ id: string; widthIn: number; heightIn: number }>;
  printableWidthMm: number;
  leftMarginMm: number;
  gapMm: number;
  leaderMm: number;
  trailerMm: number;
  maxBatchLengthMm: number;
  captionHeightMm: number;
}) {
  const orientationCache = params.items.map((item) => {
    const widthMm = inchesToMm(item.widthIn);
    const heightMm = inchesToMm(item.heightIn);
    const orientations: Array<{ widthMm: number; heightMm: number }> = [];
    if (widthMm <= params.printableWidthMm) {
      orientations.push({ widthMm, heightMm });
    }
    if (heightMm <= params.printableWidthMm && Math.abs(widthMm - heightMm) > 0.01) {
      orientations.push({ widthMm: heightMm, heightMm: widthMm });
    }
    return orientations;
  });

  const rowOptions = new Map<number, { rowHeightMm: number; usedWidthMm: number }>();

  for (let mask = 1; mask < 1 << params.items.length; mask += 1) {
    const indices: number[] = [];
    for (let index = 0; index < params.items.length; index += 1) {
      if (mask & (1 << index)) {
        indices.push(index);
      }
    }

    let best: { rowHeightMm: number; usedWidthMm: number } | null = null;

    const explore = (position: number, usedWidthMm: number, rowHeightMm: number) => {
      if (position >= indices.length) {
        const candidate = { rowHeightMm, usedWidthMm };
        if (!best || candidate.rowHeightMm < best.rowHeightMm || (candidate.rowHeightMm === best.rowHeightMm && candidate.usedWidthMm > best.usedWidthMm)) {
          best = candidate;
        }
        return;
      }

      for (const orientation of orientationCache[indices[position]]) {
        const nextUsedWidthMm = usedWidthMm + orientation.widthMm + (position > 0 ? params.gapMm : 0);
        if (nextUsedWidthMm > params.printableWidthMm) {
          continue;
        }
        explore(position + 1, nextUsedWidthMm, Math.max(rowHeightMm, orientation.heightMm + params.captionHeightMm));
      }
    };

    explore(0, 0, 0);
    if (best) {
      rowOptions.set(mask, best);
    }
  }

  const areaByMask = new Map<number, number>([[0, 0]]);
  for (let mask = 1; mask < 1 << params.items.length; mask += 1) {
    const leastBit = mask & -mask;
    const index = Math.round(Math.log2(leastBit));
    areaByMask.set(mask, (areaByMask.get(mask ^ leastBit) ?? 0) + inchesToMm(params.items[index].widthIn) * inchesToMm(params.items[index].heightIn));
  }

  const bestForMask = new Map<number, number>([[0, 0]]);

  for (let placedMask = 0; placedMask < 1 << params.items.length; placedMask += 1) {
    const currentHeightMm = bestForMask.get(placedMask);
    if (currentHeightMm == null) {
      continue;
    }
    const remainingMask = ((1 << params.items.length) - 1) ^ placedMask;
    for (let subset = remainingMask; subset > 0; subset = (subset - 1) & remainingMask) {
      const option = rowOptions.get(subset);
      if (!option) {
        continue;
      }
      const nextHeightMm = currentHeightMm + option.rowHeightMm + (placedMask === 0 ? 0 : params.gapMm);
      const totalLengthMm = params.leaderMm + nextHeightMm + params.trailerMm;
      if (totalLengthMm > params.maxBatchLengthMm) {
        continue;
      }
      const nextMask = placedMask | subset;
      const existing = bestForMask.get(nextMask);
      if (existing == null || nextHeightMm < existing) {
        bestForMask.set(nextMask, nextHeightMm);
      }
    }
  }

  let bestResult: { placedCount: number; usedLengthMm: number; wastePercent: number } | null = null;
  for (const [mask, heightMm] of bestForMask.entries()) {
    if (mask === 0) {
      continue;
    }
    const placedCount = bitCount(mask);
    const usedLengthMm = params.leaderMm + heightMm + params.trailerMm;
    const sheetArea = (params.printableWidthMm + params.leftMarginMm) * usedLengthMm;
    const totalArea = areaByMask.get(mask) ?? 0;
    const wastePercent = sheetArea <= 0 ? 0 : ((sheetArea - totalArea) / sheetArea) * 100;
    const candidate = { placedCount, usedLengthMm, wastePercent };
    if (
      !bestResult ||
      candidate.placedCount > bestResult.placedCount ||
      (candidate.placedCount === bestResult.placedCount &&
        (candidate.usedLengthMm < bestResult.usedLengthMm ||
          (candidate.usedLengthMm === bestResult.usedLengthMm && candidate.wastePercent < bestResult.wastePercent)))
    ) {
      bestResult = candidate;
    }
  }

  return bestResult;
}

function estimateBatchNow(params: {
  jobs: Array<{ widthIn?: number | null; heightIn?: number | null }>;
  rollWidthIn: number;
  gapMm: number;
  leaderMm: number;
  trailerMm: number;
  leftMarginMm: number;
  maxBatchLengthMm: number;
  captionHeightMm: number;
}) {
  const printableWidthMm = Math.max(1, inchesToMm(params.rollWidthIn) - params.leftMarginMm);
  const items = params.jobs
    .filter((job) => job.widthIn && job.heightIn)
    .map((job, index) => ({ id: `job-${index}`, widthIn: job.widthIn!, heightIn: job.heightIn! }));

  if (items.length === 0) {
    return null;
  }

  if (items.length <= MAX_EXACT_LAYOUT_ITEMS) {
    return buildExactEstimate({
      items,
      printableWidthMm,
      leftMarginMm: params.leftMarginMm,
      gapMm: params.gapMm,
      leaderMm: params.leaderMm,
      trailerMm: params.trailerMm,
      maxBatchLengthMm: params.maxBatchLengthMm,
      captionHeightMm: params.captionHeightMm,
    });
  }

  let bestResult: { placedCount: number; usedLengthMm: number; wastePercent: number } | null = null;

  for (const orderedItems of buildSortVariants(items)) {
    let cursorX = params.leftMarginMm;
    let cursorY = params.leaderMm;
    let rowHeight = 0;
    let totalArea = 0;
    let placedCount = 0;
    let blocked = false;

    for (const item of orderedItems) {
      const orientations: Array<{ widthMm: number; heightMm: number }> = [];
      const widthMm = inchesToMm(item.widthIn);
      const heightMm = inchesToMm(item.heightIn);

      if (widthMm <= printableWidthMm) {
        orientations.push({ widthMm, heightMm });
      }

      if (heightMm <= printableWidthMm && Math.abs(widthMm - heightMm) > 0.01) {
        orientations.push({ widthMm: heightMm, heightMm: widthMm });
      }

      if (orientations.length === 0) {
        blocked = true;
        break;
      }

      let chosen: { widthMm: number; heightMm: number; rowBreak: boolean } | null = null;
      let bestScore: [number, number, number, number] | null = null;

      for (const orientation of orientations) {
        const fitsCurrentRow = cursorX === params.leftMarginMm || (cursorX + params.gapMm + orientation.widthMm) <= (params.leftMarginMm + printableWidthMm);
        const projectedRowHeight = fitsCurrentRow ? Math.max(rowHeight, orientation.heightMm + params.captionHeightMm) : orientation.heightMm + params.captionHeightMm;
        const projectedLength = cursorY + projectedRowHeight + params.trailerMm;
        const projectedUsedWidth = cursorX === params.leftMarginMm || !fitsCurrentRow ? orientation.widthMm : (cursorX - params.leftMarginMm) + params.gapMm + orientation.widthMm;
        const wastedRowWidth = printableWidthMm - projectedUsedWidth;
        const score: [number, number, number, number] = [projectedLength, projectedRowHeight, wastedRowWidth, orientation.widthMm];

        if (!bestScore || score[0] < bestScore[0] || (score[0] === bestScore[0] && (score[1] < bestScore[1] || (score[1] === bestScore[1] && (score[2] < bestScore[2] || (score[2] === bestScore[2] && score[3] < bestScore[3])))))) {
          bestScore = score;
          chosen = {
            widthMm: orientation.widthMm,
            heightMm: orientation.heightMm,
            rowBreak: !fitsCurrentRow && cursorX > params.leftMarginMm,
          };
        }
      }

      if (!chosen) {
        blocked = true;
        break;
      }

      if (chosen.rowBreak) {
        cursorY += rowHeight + params.gapMm;
        cursorX = params.leftMarginMm;
        rowHeight = 0;
      }

      const placementX = cursorX === params.leftMarginMm ? params.leftMarginMm : cursorX + params.gapMm;
      const projectedRowHeight = Math.max(rowHeight, chosen.heightMm + params.captionHeightMm);
      const projectedUsedLengthMm = cursorY + projectedRowHeight + params.trailerMm;
      if (projectedUsedLengthMm > params.maxBatchLengthMm) {
        if (placedCount === 0) {
          blocked = true;
        }
        break;
      }

      cursorX = placementX + chosen.widthMm;
      rowHeight = projectedRowHeight;
      totalArea += chosen.widthMm * chosen.heightMm;
      placedCount += 1;
    }

    if (blocked || placedCount === 0) {
      continue;
    }

    const usedLengthMm = cursorY + rowHeight + params.trailerMm;
    const sheetArea = (printableWidthMm + params.leftMarginMm) * usedLengthMm;
    const wastePercent = sheetArea <= 0 ? 0 : ((sheetArea - totalArea) / sheetArea) * 100;
    const candidate = { placedCount, usedLengthMm, wastePercent };

    if (
      !bestResult ||
      candidate.placedCount > bestResult.placedCount ||
      (candidate.placedCount === bestResult.placedCount &&
        (candidate.usedLengthMm < bestResult.usedLengthMm ||
          (candidate.usedLengthMm === bestResult.usedLengthMm && candidate.wastePercent < bestResult.wastePercent)))
    ) {
      bestResult = candidate;
    }
  }

  return bestResult;
}

function Pill({ value, kind }: { value: keyof typeof batchStyles | keyof typeof jobStyles; kind: "batch" | "job" }) {
  const style = kind === "batch" ? batchStyles[value as keyof typeof batchStyles] : jobStyles[value as keyof typeof jobStyles];
  return <span className={cn("inline-flex rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]", style)}>{value.replace(/_/g, " ")}</span>;
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <article className="rounded-[1.5rem] border border-white/10 bg-[#0c1826]/88 px-5 py-4 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
      <p className="text-[11px] uppercase tracking-[0.28em] text-slate-500">{label}</p>
      <p className="mt-2 text-[1.8rem] font-semibold tracking-tight text-white">{value}</p>
      <p className="mt-2 text-sm text-slate-400">{hint}</p>
    </article>
  );
}

function formatMediaType(value: string) {
  if (value.trim().toLowerCase() === "lustre") {
    return "Lustre";
  }

  return value;
}

function getLargeFormatSourceAppearance(source: string | null | undefined) {
  const key = (source ?? "").trim().toLowerCase();
  if (key === "photozone") {
    return sourceStyles.photozone;
  }
  if (key === "postsnap") {
    return sourceStyles.postsnap;
  }
  return sourceStyles.unknown;
}

function LargeFormatThumbnail({ path, alt }: { path: string; alt: string }) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void toLocalAssetPreviewUrl(path).then((resolved) => {
      if (active) {
        setPreviewSrc(resolved);
      }
    }).catch(() => {
      if (active) {
        setPreviewSrc(null);
      }
    });

    return () => {
      active = false;
    };
  }, [path]);

  return (
    <div className="h-14 w-14 overflow-hidden rounded-xl border border-white/10 bg-white/[0.04]">
      {previewSrc ? (
        <img src={previewSrc} alt={alt} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-[0.18em] text-slate-500">No Preview</div>
      )}
    </div>
  );
}

function LargeFormatPreviewImage({ path, alt }: { path: string; alt: string }) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void toLocalAssetPreviewUrl(path).then((resolved) => {
      if (active) {
        setPreviewSrc(resolved);
      }
    }).catch(() => {
      if (active) {
        setPreviewSrc(null);
      }
    });

    return () => {
      active = false;
    };
  }, [path]);

  if (!previewSrc) {
    return <div className="flex min-h-[320px] w-full items-center justify-center text-sm text-slate-400">Preview unavailable.</div>;
  }

  return <img src={previewSrc} alt={alt} className="max-h-[72vh] w-auto max-w-full rounded-xl object-contain" />;
}

export function LargeFormatView() {
  const [confirmingBatchId, setConfirmingBatchId] = useState<string | null>(null);
  const [confirmingJobId, setConfirmingJobId] = useState<string | null>(null);
  const [previewingJobId, setPreviewingJobId] = useState<string | null>(null);
  const {
    snapshot,
    isPending,
    scanLargeFormatNow,
    processLargeFormatNow,
    approveLargeFormatBatch,
    removeLargeFormatBatch,
    deleteLargeFormatJob,
    sendLargeFormatBatch,
    activeLargeFormatBatch,
  } = useWorkerStoreContext();
  const jobs = snapshot.largeFormat.jobs;
  const batches = snapshot.largeFormat.batches;
  const waitingJobs = jobs.filter((job) => job.status === "waiting");
  const reviewJobs = jobs.filter((job) => job.status === "needs_review");
  const readyBatches = batches.filter((batch) => batch.status === "ready" || batch.status === "approved");
  const confirmingBatch = batches.find((batch) => batch.id === confirmingBatchId) ?? null;
  const confirmingJob = jobs.find((job) => job.id === confirmingJobId) ?? null;
  const previewingJob = jobs.find((job) => job.id === previewingJobId) ?? null;
  const wasteIfBatchedNow = useMemo(
    () =>
      estimateBatchNow({
        jobs: waitingJobs,
        rollWidthIn: snapshot.settings.largeFormatRollWidthIn,
        gapMm: snapshot.settings.largeFormatGapMm,
        leaderMm: snapshot.settings.largeFormatLeaderMm,
        trailerMm: snapshot.settings.largeFormatTrailerMm,
        leftMarginMm: snapshot.settings.largeFormatLeftMarginMm,
        maxBatchLengthMm: snapshot.settings.largeFormatMaxBatchLengthMm,
        captionHeightMm: snapshot.settings.largeFormatPrintFilenameCaptions ? snapshot.settings.largeFormatFilenameCaptionHeightMm : 0,
      }),
    [
      waitingJobs,
      snapshot.settings.largeFormatFilenameCaptionHeightMm,
      snapshot.settings.largeFormatGapMm,
      snapshot.settings.largeFormatLeaderMm,
      snapshot.settings.largeFormatLeftMarginMm,
      snapshot.settings.largeFormatMaxBatchLengthMm,
      snapshot.settings.largeFormatPrintFilenameCaptions,
      snapshot.settings.largeFormatRollWidthIn,
      snapshot.settings.largeFormatTrailerMm,
    ],
  );

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-cyan-500/12 bg-[linear-gradient(145deg,#0d1a28_0%,#0a2431_56%,#0a2b34_100%)] px-6 py-5 text-white shadow-[0_22px_60px_rgba(2,6,23,0.4)]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-100/45">Large Format</p>
            <div className="mt-3 flex items-end gap-4">
              <p className="text-5xl font-semibold tracking-tight">{waitingJobs.length}</p>
              <p className="pb-2 text-sm text-white/65">waiting images in the hot-folder queue</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={isPending}
              onClick={() => void scanLargeFormatNow()}
              className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-slate-100 transition hover:bg-white/10 disabled:opacity-50"
            >
              Scan Input Folder
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => void processLargeFormatNow()}
              className="rounded-2xl bg-cyan-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:opacity-50"
            >
              Process Batch Now
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Waiting Jobs" value={waitingJobs.length} hint="Lustre jobs ready for the next batch." />
        <StatCard
          label="Waste If Batched Now"
          value={wasteIfBatchedNow ? `${wasteIfBatchedNow.wastePercent.toFixed(1)}%` : "N/A"}
          hint={wasteIfBatchedNow ? `Estimated length ${Math.max(wasteIfBatchedNow.usedLengthMm / 1000, 0.01).toFixed(2)} m.` : "Need valid waiting jobs with confirmed physical size."}
        />
        <StatCard label="Needs Review" value={reviewJobs.length} hint="Usually missing DPI metadata or unsupported file type." />
        <StatCard label="Ready Batches" value={readyBatches.length} hint="Generated PDFs awaiting approval or send." />
        <StatCard label="Active Batch" value={activeLargeFormatBatch ? activeLargeFormatBatch.id.slice(-8) : "None"} hint="Most recent large-format batch." />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <article className="rounded-[1.75rem] border border-white/10 bg-[#0c1826]/88 p-6 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Input Queue</p>
              <h3 className="mt-2 text-lg font-semibold text-slate-100">Large-format jobs</h3>
            </div>
            <p className="text-sm text-slate-400">{snapshot.largeFormat.lastScanAt ? `Last scan ${formatDateTime(snapshot.largeFormat.lastScanAt)}` : "No scan yet"}</p>
          </div>
          <div className="mt-5 space-y-3">
            {jobs.length === 0 ? <div className="rounded-2xl border border-dashed border-white/12 p-4 text-sm text-slate-400">No large-format files discovered yet.</div> : null}
            {jobs.map((job) => {
              const sourceAppearance = getLargeFormatSourceAppearance(job.source);
              return (
              <div key={job.id} className={cn("rounded-2xl border px-4 py-3", sourceAppearance.cardClassName)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <button
                      type="button"
                      onClick={() => setPreviewingJobId(job.id)}
                      className="shrink-0 transition hover:opacity-90"
                    >
                      <LargeFormatThumbnail path={job.originalPath} alt={job.filename} />
                    </button>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-white">{job.filename}</p>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                            sourceAppearance.badgeClassName,
                          )}
                        >
                          {sourceAppearance.label}
                        </span>
                        <span className="text-xs font-medium text-slate-300">
                          {job.widthIn && job.heightIn ? `${job.widthIn.toFixed(2)}" × ${job.heightIn.toFixed(2)}"` : "Needs physical size review"}
                        </span>
                        <span className="text-xs font-medium text-slate-300">{formatMediaType(job.mediaType)}</span>
                        {job.needsBorder ? <span className="text-xs font-medium text-slate-400">Auto border</span> : null}
                      </div>
                      {job.notes ? <p className="mt-1 text-xs text-amber-200">{job.notes}</p> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Pill value={job.status} kind="job" />
                    <button
                      type="button"
                      disabled={isPending || job.status === "ready"}
                      onClick={() => setConfirmingJobId(job.id)}
                      className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-full border border-rose-500/20 bg-rose-500/10 text-rose-100 transition hover:bg-rose-500/20 disabled:opacity-40"
                      aria-label={`Delete ${job.filename}`}
                      title="Delete image"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )})}
          </div>
        </article>

        <article className="rounded-[1.75rem] border border-white/10 bg-[#0c1826]/88 p-6 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Output</p>
              <h3 className="mt-2 text-lg font-semibold text-slate-100">Generated batches</h3>
            </div>
            <p className="text-sm text-slate-400">{snapshot.largeFormat.lastProcessedAt ? `Last processed ${formatDateTime(snapshot.largeFormat.lastProcessedAt)}` : "No batch yet"}</p>
          </div>
          <div className="mt-5 space-y-3">
            {batches.length === 0 ? <div className="rounded-2xl border border-dashed border-white/12 p-4 text-sm text-slate-400">No large-format batches generated yet.</div> : null}
            {batches.map((batch) => (
              <div key={batch.id} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">{batch.id.slice(-8)}</p>
                    <p className="mt-1 text-sm text-slate-400">
                      {formatMediaType(batch.mediaType)} · {batch.rollWidthIn}" roll · {Math.round(batch.usedLengthMm)} mm length · {batch.wastePercent.toFixed(1)}% waste
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Auto-approve target: {snapshot.settings.largeFormatAutoApproveEnabled ? `<= ${snapshot.settings.largeFormatAutoApproveMaxWastePercent.toFixed(1)}% waste` : "disabled"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">{formatDateTime(batch.createdAt)}</p>
                  </div>
                  <Pill value={batch.status} kind="batch" />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={isPending || batch.status !== "ready"}
                    onClick={() => void approveLargeFormatBatch(batch.id)}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-white/10 disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={isPending || !["ready", "approved"].includes(batch.status)}
                    onClick={() => void sendLargeFormatBatch(batch.id)}
                    className="rounded-xl bg-cyan-400 px-3 py-2 text-xs font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:opacity-40"
                  >
                    {snapshot.settings.largeFormatDirectPrint ? "Print" : "Send to Hot Folder"}
                  </button>
                  <button
                    type="button"
                    disabled={isPending || batch.status === "sent" || batch.status === "printing"}
                    onClick={() => setConfirmingBatchId(batch.id)}
                    className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-100 transition hover:bg-rose-500/20 disabled:opacity-40"
                  >
                    Remove Batch
                  </button>
                  {batch.outputPdfPath ? (
                    <button
                      type="button"
                      onClick={() => void openPathInOs(batch.outputPdfPath!)}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-white/10"
                    >
                      Open PDF
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>

      <article className="rounded-[1.75rem] border border-white/10 bg-[#0c1826]/88 p-6 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Activity</p>
        <h3 className="mt-2 text-lg font-semibold text-slate-100">Large-format log</h3>
        <div className="mt-5 space-y-3">
          {snapshot.largeFormat.activity.length === 0 ? <div className="rounded-2xl border border-dashed border-white/12 p-4 text-sm text-slate-400">No large-format activity yet.</div> : null}
          {snapshot.largeFormat.activity.slice(0, 12).map((entry) => (
            <div key={entry.id} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-white">{entry.event}</p>
                <span className="text-xs uppercase tracking-[0.16em] text-slate-500">{entry.level}</span>
              </div>
              <p className="mt-2 text-sm text-slate-400">{entry.message}</p>
            </div>
          ))}
        </div>
      </article>

      {confirmingBatch ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-6"
          onClick={() => {
            if (!isPending) {
              setConfirmingBatchId(null);
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-[1.75rem] border border-white/10 bg-[#08111c] p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Confirm Remove</p>
            <h3 className="mt-2 text-xl font-semibold text-slate-100">Remove batch {confirmingBatch.id.slice(-8)}?</h3>
            <p className="mt-3 text-sm leading-6 text-slate-400">
              This deletes the generated PDF and returns the batch&apos;s files to the waiting queue for later re-batching.
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                disabled={isPending}
                onClick={() => setConfirmingBatchId(null)}
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-40"
              >
                Keep Batch
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={async () => {
                  await removeLargeFormatBatch(confirmingBatch.id);
                  setConfirmingBatchId(null);
                }}
                className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/20 disabled:opacity-40"
              >
                Remove Batch
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmingJob ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-6"
          onClick={() => {
            if (!isPending) {
              setConfirmingJobId(null);
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-[1.75rem] border border-white/10 bg-[#08111c] p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Delete Queue Item</p>
            <h3 className="mt-2 text-xl font-semibold text-slate-100">Delete {confirmingJob.filename}?</h3>
            <p className="mt-3 text-sm leading-6 text-slate-400">
              This removes the image from the large-format queue and deletes the source file from the watched input folder when possible.
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                disabled={isPending}
                onClick={() => setConfirmingJobId(null)}
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-40"
              >
                Keep Image
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={async () => {
                  await deleteLargeFormatJob(confirmingJob.id);
                  setConfirmingJobId(null);
                }}
                className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/20 disabled:opacity-40"
              >
                Delete Image
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {previewingJob ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-6"
          onClick={() => setPreviewingJobId(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#08111c] p-4 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 border-b border-white/10 px-2 pb-4">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Image Preview</p>
                <h3 className="mt-2 truncate text-lg font-semibold text-slate-100">{previewingJob.filename}</h3>
              </div>
              <button
                type="button"
                onClick={() => setPreviewingJobId(null)}
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
              >
                Close
              </button>
            </div>
            <div className="mt-4 flex max-h-[calc(90vh-96px)] items-center justify-center overflow-auto rounded-2xl bg-slate-950/50 p-4">
              <LargeFormatPreviewImage path={previewingJob.originalPath} alt={previewingJob.filename} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
