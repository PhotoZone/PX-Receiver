import { cn } from "@/lib/utils";
import type { HealthState, JobStatus } from "@/types/app";

const jobStyles: Record<JobStatus, string> = {
  pending: "border border-slate-700 bg-slate-900/90 text-slate-200",
  downloading: "border border-cyan-500/30 bg-cyan-500/15 text-cyan-200",
  downloaded: "border border-sky-500/30 bg-sky-500/15 text-sky-200",
  processing: "border border-amber-500/30 bg-amber-500/15 text-amber-200",
  completed: "border border-emerald-500/30 bg-emerald-500/15 text-emerald-200",
  failed: "border border-rose-500/30 bg-rose-500/15 text-rose-200",
};

const healthStyles: Record<HealthState, string> = {
  healthy: "border border-emerald-500/30 bg-emerald-500/15 text-emerald-200",
  paused: "border border-amber-500/30 bg-amber-500/15 text-amber-200",
  processing: "border border-cyan-500/30 bg-cyan-500/15 text-cyan-200",
  offline: "border border-slate-700 bg-slate-900/90 text-slate-300",
  error: "border border-rose-500/30 bg-rose-500/15 text-rose-200",
};

type Props = {
  value: JobStatus | HealthState;
  kind: "job" | "health";
};

export function StatusBadge({ value, kind }: Props) {
  const style = kind === "job" ? jobStyles[value as JobStatus] : healthStyles[value as HealthState];
  const label = kind === "job"
    ? value === "pending"
      ? "Awaiting Download"
      : value === "processing"
        ? "Printing"
        : value
    : value;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase leading-none tracking-[0.18em] whitespace-nowrap",
        style,
      )}
    >
      {label}
    </span>
  );
}
