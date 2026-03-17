"use client";

import { AlertTriangle, Layers3, MonitorPlay, RefreshCw, ScanLine } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { formatReceiverJobSource, inferReceiverJobSource } from "@/lib/receiver-contract";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { cn, formatDateTime } from "@/lib/utils";
import type { JobRecord, ScanRecord } from "@/types/app";

function describeAssets(job: JobRecord) {
  const names = job.assets.map((asset) => asset.filename);
  if (names.length === 0) {
    return "No files attached";
  }
  if (names.length <= 2) {
    return names.join(", ");
  }

  return `${names[0]} and ${names.length - 1} more`;
}

function normalizePrinterRoute(value?: string | null) {
  return (value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function inferOutputRoute(job: JobRecord) {
  const route = normalizePrinterRoute(job.printer);
  if (route) {
    return route;
  }

  if (job.assets.some((asset) => asset.kind === "control" && ["condition.txt", "end.txt"].includes(asset.filename.trim().toLowerCase()))) {
    return "fuji";
  }

  return "";
}

function StatCard({
  label,
  value,
  tone = "default",
  icon: Icon,
}: {
  label: string;
  value: string | number;
  tone?: "default" | "success" | "warn" | "danger";
  icon: React.ComponentType<{ className?: string }>;
}) {
  const toneClasses = {
    default: "border-slate-700 bg-slate-900/88 text-slate-200",
    success: "border-emerald-500/20 bg-emerald-500/12 text-emerald-200",
    warn: "border-amber-500/20 bg-amber-500/12 text-amber-200",
    danger: "border-rose-500/20 bg-rose-500/12 text-rose-200",
  };

  return (
    <article className="rounded-[1.5rem] border border-white/10 bg-[#0c1826]/88 px-5 py-4 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.28em] text-slate-500">{label}</p>
          <p className="mt-2 text-[1.8rem] font-semibold tracking-tight text-white">{value}</p>
        </div>
        <div className={cn("rounded-2xl border p-2.5", toneClasses[tone])}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </article>
  );
}

function CompactJobRow({ job }: { job: JobRecord }) {
  const route = inferOutputRoute(job);
  const routeLabel = route === "fuji_lab" || route === "fuji"
    ? "Fuji"
    : route === "sublimation"
      ? "Sublimation"
      : route === "large_format"
        ? "Large Format"
        : "Default";
  const sourceBadgeClass = inferReceiverJobSource(job) === "photozone"
    ? "border-blue-500/20 bg-blue-500/10 text-blue-100"
    : inferReceiverJobSource(job) === "pzpro"
      ? "border-rose-500/20 bg-rose-500/10 text-rose-100"
      : inferReceiverJobSource(job) === "wink"
        ? "border-amber-500/20 bg-amber-500/10 text-amber-100"
        : "border-white/10 bg-white/[0.04] text-slate-300";

  return (
    <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 md:grid-cols-[1fr,1.2fr,140px] md:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-base font-semibold text-white">{job.orderId}</p>
          <span className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]", sourceBadgeClass)}>
            {formatReceiverJobSource(job)}
          </span>
        </div>
        <p className="truncate text-sm text-slate-400">{job.customerName || job.id}</p>
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-100">{job.productName}</p>
        <p className="truncate text-xs text-slate-500">{describeAssets(job)} · {routeLabel}</p>
      </div>
      <div className="md:justify-self-end">
        <StatusBadge value={job.status} kind="job" />
      </div>
    </div>
  );
}

function getScanTone(scan: ScanRecord) {
  const code = scan.code.trim();

  if (/^4\d{6}$/.test(code)) {
    return {
      label: "Photo Zone",
      className: "border-blue-500/20 bg-blue-500/10 text-blue-50",
    };
  }

  if (/^\d{12}$/.test(code)) {
    return {
      label: "PostSnap",
      className: "border-rose-500/20 bg-rose-500/10 text-rose-50",
    };
  }

  if (/^W[\dA-Z]+$/i.test(code)) {
    return {
      label: "Wink",
      className: "border-amber-500/20 bg-amber-500/10 text-amber-50",
    };
  }

  return {
    label: "Unknown",
    className: "border-white/10 bg-white/[0.03] text-slate-100",
  };
}

function CompactScanRow({ scan }: { scan: ScanRecord }) {
  const tone = getScanTone(scan);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-base font-semibold text-white">{scan.code}</p>
            <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]", tone.className)}>
              {tone.label}
            </span>
          </div>
          <p className="mt-1 truncate text-sm text-slate-300">{scan.message ?? "Captured by worker"}</p>
        </div>
        <p className="shrink-0 text-xs text-slate-500">{formatDateTime(scan.timestamp)}</p>
      </div>
    </div>
  );
}

function SectionCard({
  eyebrow,
  title,
  children,
  className,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <article className={cn("min-h-0 rounded-[1.75rem] border border-white/10 bg-[#0c1826]/88 p-5 shadow-[0_22px_60px_rgba(2,6,23,0.34)]", className)}>
      <p className="text-[11px] uppercase tracking-[0.28em] text-slate-500">{eyebrow}</p>
      <h3 className="mt-2 text-xl font-semibold text-white">{title}</h3>
      <div className="mt-4 min-h-0">{children}</div>
    </article>
  );
}

export function DashboardView() {
  const { snapshot, recentScans, refreshNow, isPending } = useWorkerStoreContext();
  const jobs = snapshot.jobs;

  const outstandingJobs = jobs.filter((job) => job.status !== "completed");
  const erroredJobs = jobs.filter((job) => job.status === "failed");
  const printingJobs = jobs.filter((job) => job.status === "processing");
  const waitingJobs = jobs.filter((job) => ["pending", "downloading"].includes(job.status));
  const nextJobs = [...outstandingJobs].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(0, 5);
  const fujiOutstanding = outstandingJobs.filter((job) => {
    const route = inferOutputRoute(job);
    return route === "fuji_lab" || route === "fuji";
  });
  const sublimationOutstanding = outstandingJobs.filter((job) => inferOutputRoute(job) === "sublimation");
  const largeFormatOutstanding = outstandingJobs.filter((job) => inferOutputRoute(job) === "large_format");
  const latestScans = recentScans.slice(0, 5);
  return (
    <div className="grid h-[calc(100vh-10.75rem)] gap-4 overflow-hidden grid-rows-[auto,auto,minmax(0,1fr)]">
      <section className="rounded-[2rem] border border-cyan-500/12 bg-[linear-gradient(145deg,#0d1a28_0%,#0a2431_56%,#0a2b34_100%)] px-6 py-5 text-white shadow-[0_22px_60px_rgba(2,6,23,0.4)]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-100/45">Queue</p>
            <div className="mt-3 flex items-end gap-4">
              <p className="text-5xl font-semibold tracking-tight">{outstandingJobs.length}</p>
              <p className="pb-2 text-sm text-white/65">
                {waitingJobs.length} Waiting · {printingJobs.length} Printing
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-200">
            <span>{snapshot.currentActivity}</span>
            <span className="hidden h-1 w-1 rounded-full bg-white/30 sm:block" />
            <span className="text-white/60">Synced {formatDateTime(snapshot.lastSyncAt)}</span>
            <button
              type="button"
              onClick={refreshNow}
              title="Refresh now"
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-200 transition hover:border-white/20 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isPending}
            >
              {isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Fuji Lab" value={fujiOutstanding.length} icon={ScanLine} />
        <StatCard label="Sublimation" value={sublimationOutstanding.length} tone="success" icon={Layers3} />
        <StatCard label="Large Format" value={largeFormatOutstanding.length} tone="warn" icon={MonitorPlay} />
        <StatCard label="Orders With Errors" value={erroredJobs.length} tone={erroredJobs.length > 0 ? "danger" : "default"} icon={AlertTriangle} />
      </section>

      <section className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1.35fr),minmax(360px,0.65fr)]">
        <SectionCard eyebrow="Queue" title="Next Orders" className="flex min-h-0 flex-col">
          <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
            {nextJobs.length > 0 ? (
              nextJobs.map((job) => <CompactJobRow key={job.id} job={job} />)
            ) : (
              <div className="rounded-2xl border border-dashed border-white/12 p-4 text-sm text-slate-400">
                No Outstanding Orders. This Machine Is Clear.
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard eyebrow="Scanner" title="Latest scans" className="flex min-h-0 flex-col">
          <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
            {latestScans.length > 0 ? (
              latestScans.map((scan) => <CompactScanRow key={scan.id} scan={scan} />)
            ) : (
              <div className="rounded-2xl border border-dashed border-white/12 p-4 text-sm text-slate-400">
                No barcode scans received yet.
              </div>
            )}
          </div>
        </SectionCard>
      </section>
    </div>
  );
}
