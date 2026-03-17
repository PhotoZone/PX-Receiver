"use client";

import { AlertTriangle, Layers3, MonitorPlay, RefreshCw, ScanLine } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { cn, formatDateTime } from "@/lib/utils";
import type { JobRecord } from "@/types/app";

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
    default: "bg-slate-100 text-slate-700",
    success: "bg-emerald-100 text-emerald-700",
    warn: "bg-amber-100 text-amber-700",
    danger: "bg-rose-100 text-rose-700",
  };

  return (
    <article className="rounded-3xl border border-white/70 bg-panel px-4 py-4 shadow-panel">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{value}</p>
        </div>
        <div className={cn("rounded-2xl p-3", toneClasses[tone])}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </article>
  );
}

function CompactJobRow({ job }: { job: JobRecord }) {
  return (
    <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 md:grid-cols-[1fr,1.2fr,120px] md:items-center">
      <div className="min-w-0">
        <p className="truncate font-semibold text-slate-900">{job.orderId}</p>
        <p className="truncate text-xs text-slate-500">{job.customerName || job.id}</p>
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-800">{job.productName}</p>
        <p className="truncate text-xs text-slate-500">{describeAssets(job)}</p>
      </div>
      <div className="md:justify-self-end">
        <StatusBadge value={job.status} kind="job" />
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
    <article className={cn("min-h-0 rounded-3xl border border-white/70 bg-panel p-5 shadow-panel", className)}>
      <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{eyebrow}</p>
      <h3 className="mt-2 text-lg font-semibold text-slate-900">{title}</h3>
      <div className="mt-4 min-h-0">{children}</div>
    </article>
  );
}

export function DashboardView() {
  const { snapshot, refreshNow, isPending } = useWorkerStoreContext();
  const jobs = snapshot.jobs;

  const outstandingJobs = jobs.filter((job) => job.status !== "completed");
  const erroredJobs = jobs.filter((job) => job.status === "failed");
  const pendingIntake = jobs.filter((job) => job.status === "pending" || job.status === "downloading");
  const nextJobs = [...outstandingJobs].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(0, 5);
  const fujiOutstanding = outstandingJobs.filter((job) => {
    const route = inferOutputRoute(job);
    return route === "fuji_lab" || route === "fuji";
  });
  const sublimationOutstanding = outstandingJobs.filter((job) => inferOutputRoute(job) === "sublimation");
  const largeFormatOutstanding = outstandingJobs.filter((job) => inferOutputRoute(job) === "large_format");
  const defaultOutstanding = outstandingJobs.filter((job) => {
    const route = inferOutputRoute(job);
    return !route || route === "none";
  });

  const outputStatus = snapshot.pollingPaused ? "Paused" : "Running";

  return (
    <div className="grid h-[calc(100vh-10.75rem)] gap-4 overflow-hidden grid-rows-[auto,auto,minmax(0,1fr)]">
      <section className="grid gap-4 xl:grid-cols-[1.15fr,1fr]">
        <article className="rounded-[2rem] border border-white/70 bg-panel px-5 py-5 shadow-panel">
          <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl bg-slate-50 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Current activity</p>
                <p className="mt-2 line-clamp-2 text-sm font-semibold text-slate-900">{snapshot.currentActivity}</p>
              </div>
              <div className="rounded-2xl bg-slate-50 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Last sync</p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">{formatDateTime(snapshot.lastSyncAt)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={refreshNow}
                    title="Refresh now"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isPending}
                  >
                    {isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="rounded-2xl bg-slate-50 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Output</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">{outputStatus}</p>
              </div>
          </div>
        </article>

        <article className="rounded-[2rem] border border-white/70 bg-ink px-5 py-5 text-white shadow-panel">
          <p className="text-xs uppercase tracking-[0.24em] text-white/55">Live summary</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.14em] text-white/55">Queue count</p>
              <p className="mt-2 text-2xl font-semibold">{outstandingJobs.length}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.14em] text-white/55">Station state</p>
              <p className="mt-2 text-lg font-semibold">{snapshot.pollingPaused ? "Output paused" : "Watching for work"}</p>
              <p className="mt-1 text-sm text-white/70">{snapshot.currentActivity}</p>
            </div>
          </div>
        </article>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Fuji Lab" value={fujiOutstanding.length} icon={ScanLine} />
        <StatCard label="Sublimation" value={sublimationOutstanding.length} tone="success" icon={Layers3} />
        <StatCard label="Large Format" value={largeFormatOutstanding.length} tone="warn" icon={MonitorPlay} />
        <StatCard label="Orders With Errors" value={erroredJobs.length} tone={erroredJobs.length > 0 ? "danger" : "default"} icon={AlertTriangle} />
      </section>

      <section className="grid min-h-0 gap-4">
        <SectionCard eyebrow="Queue" title="Next orders" className="flex min-h-0 flex-col">
          <div className="mb-3 flex items-center justify-between gap-4">
            <div className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-slate-700">
              {pendingIntake.length} awaiting intake
            </div>
          </div>
          <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
            {nextJobs.length > 0 ? (
              nextJobs.map((job) => <CompactJobRow key={job.id} job={job} />)
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">
                No outstanding orders. This machine is clear.
              </div>
            )}
          </div>
        </SectionCard>
      </section>
    </div>
  );
}
