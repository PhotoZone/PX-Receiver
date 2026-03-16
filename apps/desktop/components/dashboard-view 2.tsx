"use client";

import { AlertTriangle, CheckCircle2, Clock3, PauseCircle, Printer, RefreshCw, ShoppingBag, TimerReset } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { cn, formatDateTime, truncateMiddle } from "@/lib/utils";
import type { JobRecord } from "@/types/app";

function isSameLocalDay(value: string | null | undefined, reference = new Date()) {
  if (!value) {
    return false;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return (
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate()
  );
}

function summarizeHotFolders(downloadDirectory: string, defaultHotFolder: string, photoPrintHotFolder: string, photoGiftHotFolder: string, largeFormatHotFolder: string) {
  const routes = [
    photoPrintHotFolder ? `Photo Print -> ${truncateMiddle(photoPrintHotFolder, 12)}` : null,
    photoGiftHotFolder ? `Photo Gift -> ${truncateMiddle(photoGiftHotFolder, 12)}` : null,
    largeFormatHotFolder ? `Large Format -> ${truncateMiddle(largeFormatHotFolder, 12)}` : null,
    `Other -> ${truncateMiddle(defaultHotFolder || downloadDirectory, 12)}`,
  ].filter(Boolean);

  return routes.join(" | ");
}

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

function StatCard({
  label,
  value,
  hint,
  tone = "default",
  icon: Icon,
}: {
  label: string;
  value: string | number;
  hint: string;
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
    <article className="rounded-3xl border border-white/70 bg-panel p-5 shadow-panel">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-4 text-4xl font-semibold tracking-tight text-slate-900">{value}</p>
        </div>
        <div className={cn("rounded-2xl p-3", toneClasses[tone])}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-4 text-sm leading-6 text-slate-600">{hint}</p>
    </article>
  );
}

function JobRow({ job }: { job: JobRecord }) {
  return (
    <div className="grid gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-4 md:grid-cols-[1.1fr,1.4fr,140px] md:items-center">
      <div>
        <p className="font-semibold text-slate-900">{job.orderId}</p>
        <p className="mt-1 text-sm text-slate-500">{job.id}</p>
      </div>
      <div>
        <p className="font-medium text-slate-800">{job.productName}</p>
        <p className="mt-1 text-sm text-slate-500">{describeAssets(job)}</p>
      </div>
      <div className="md:justify-self-end">
        <StatusBadge value={job.status} kind="job" />
      </div>
    </div>
  );
}

export function DashboardView() {
  const { snapshot, activeJob } = useWorkerStoreContext();
  const jobs = snapshot.jobs;

  const outstandingJobs = jobs.filter((job) => job.status !== "completed");
  const completedToday = jobs.filter((job) => job.status === "completed" && isSameLocalDay(job.updatedAt));
  const failedJobs = jobs.filter((job) => job.status === "failed");
  const readyToOutput = jobs.filter((job) => job.status === "downloaded");
  const pendingIntake = jobs.filter((job) => job.status === "pending" || job.status === "downloading");
  const recentlyCompleted = [...completedToday].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 4);
  const nextJobs = [...outstandingJobs].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(0, 5);

  const outputStatus = snapshot.pollingPaused ? "Paused" : "Running";
  const printerLabel = snapshot.settings.packingSlipPrinterName || "Job/default printer";

  return (
    <div className="space-y-8">
      <section className="grid gap-5 xl:grid-cols-[1.5fr,1fr]">
        <article className="rounded-[2rem] border border-white/70 bg-panel p-6 shadow-panel">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Overview</p>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-3xl font-semibold tracking-tight text-slate-900">Order desk</h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                See what still needs producing, what has gone out today, and whether this machine is ready to keep dispatching.
              </p>
            </div>
            <StatusBadge value={snapshot.health} kind="health" />
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Current activity</p>
              <p className="mt-2 text-lg font-semibold text-slate-900">{snapshot.currentActivity}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Last sync</p>
              <p className="mt-2 text-lg font-semibold text-slate-900">{formatDateTime(snapshot.lastSyncAt)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Output</p>
              <p className="mt-2 text-lg font-semibold text-slate-900">{outputStatus}</p>
            </div>
          </div>
        </article>

        <article className="rounded-[2rem] border border-white/70 bg-ink p-6 text-white shadow-panel">
          <p className="text-xs uppercase tracking-[0.24em] text-white/55">Now producing</p>
          {activeJob ? (
            <div className="mt-4 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-2xl font-semibold">{activeJob.productName}</p>
                  <p className="mt-1 text-sm text-white/70">Order {activeJob.orderId}</p>
                </div>
                <StatusBadge value={activeJob.status} kind="job" />
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-white/80">
                {describeAssets(activeJob)}
              </div>
            </div>
          ) : (
            <div className="mt-4 rounded-2xl border border-dashed border-white/15 bg-white/5 p-5 text-sm leading-6 text-white/75">
              No job is active right now. The receiver is waiting for the next assigned order.
            </div>
          )}
        </article>
      </section>

      <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Outstanding orders"
          value={outstandingJobs.length}
          hint="Everything still waiting to be received, released, printed, or retried."
          icon={ShoppingBag}
        />
        <StatCard
          label="Completed today"
          value={completedToday.length}
          hint="Orders this machine has finished since local midnight."
          tone="success"
          icon={CheckCircle2}
        />
        <StatCard
          label="Ready to output"
          value={readyToOutput.length}
          hint="Orders already downloaded and ready for hot-folder release or packing-slip print."
          tone="warn"
          icon={Clock3}
        />
        <StatCard
          label="Needs attention"
          value={failedJobs.length}
          hint="Orders currently in a failed state and likely to need a retry or investigation."
          tone={failedJobs.length > 0 ? "danger" : "default"}
          icon={AlertTriangle}
        />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.25fr,1fr]">
        <article className="rounded-3xl border border-white/70 bg-panel p-6 shadow-panel">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Queue</p>
              <h3 className="mt-2 text-xl font-semibold">Next orders to work through</h3>
            </div>
            <div className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700">
              {pendingIntake.length} awaiting intake
            </div>
          </div>

          <div className="mt-6 space-y-3">
            {nextJobs.length > 0 ? (
              nextJobs.map((job) => <JobRow key={job.id} job={job} />)
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 p-5 text-sm text-slate-600">
                No outstanding orders. This machine is clear.
              </div>
            )}
          </div>
        </article>

        <article className="rounded-3xl border border-white/70 bg-panel p-6 shadow-panel">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Machine readiness</p>
          <h3 className="mt-2 text-xl font-semibold">Output and routing</h3>

          <div className="mt-6 space-y-4 text-sm">
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="flex items-center gap-3">
                <PauseCircle className="h-4 w-4 text-slate-500" />
                <p className="font-medium text-slate-800">Output status</p>
              </div>
              <p className="mt-2 text-slate-600">{snapshot.pollingPaused ? "Paused from the desktop UI" : "Active and dispatching automatically"}</p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="flex items-center gap-3">
                <Printer className="h-4 w-4 text-slate-500" />
                <p className="font-medium text-slate-800">Packing slip printer</p>
              </div>
              <p className="mt-2 text-slate-600">{printerLabel}</p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="flex items-center gap-3">
                <TimerReset className="h-4 w-4 text-slate-500" />
                <p className="font-medium text-slate-800">Polling cadence</p>
              </div>
              <p className="mt-2 text-slate-600">Checks for new orders every {snapshot.settings.pollingIntervalSeconds} seconds.</p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="flex items-center gap-3">
                <RefreshCw className="h-4 w-4 text-slate-500" />
                <p className="font-medium text-slate-800">Hot-folder routes</p>
              </div>
              <p className="mt-2 leading-6 text-slate-600">
                {summarizeHotFolders(
                  snapshot.settings.downloadDirectory,
                  snapshot.settings.hotFolderPath,
                  snapshot.settings.photoPrintHotFolderPath,
                  snapshot.settings.photoGiftHotFolderPath,
                  snapshot.settings.largeFormatHotFolderPath,
                )}
              </p>
            </div>
          </div>
        </article>
      </section>

      <section className="grid gap-5 xl:grid-cols-[1fr,1fr]">
        <article className="rounded-3xl border border-white/70 bg-panel p-6 shadow-panel">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Today</p>
          <h3 className="mt-2 text-xl font-semibold">Recently completed</h3>

          <div className="mt-6 space-y-3">
            {recentlyCompleted.length > 0 ? (
              recentlyCompleted.map((job) => (
                <div key={job.id} className="rounded-2xl border border-slate-200 px-4 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold text-slate-900">{job.orderId}</p>
                      <p className="mt-1 text-sm text-slate-600">{job.productName}</p>
                    </div>
                    <p className="text-sm font-medium text-slate-500">{formatDateTime(job.updatedAt)}</p>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 p-5 text-sm text-slate-600">
                Nothing has been completed yet today.
              </div>
            )}
          </div>
        </article>

        <article className="rounded-3xl border border-white/70 bg-panel p-6 shadow-panel">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Attention</p>
          <h3 className="mt-2 text-xl font-semibold">Orders needing follow-up</h3>

          <div className="mt-6 space-y-3">
            {failedJobs.length > 0 ? (
              failedJobs.slice(0, 4).map((job) => (
                <div key={job.id} className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold text-rose-900">{job.orderId}</p>
                      <p className="mt-1 text-sm text-rose-800">{job.productName}</p>
                      <p className="mt-2 text-sm text-rose-700">{job.lastError || "Dispatch failed."}</p>
                    </div>
                    <StatusBadge value={job.status} kind="job" />
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 p-5 text-sm text-slate-600">
                No failed orders. Nothing currently needs intervention.
              </div>
            )}
          </div>
        </article>
      </section>
    </div>
  );
}
