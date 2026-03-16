import { cn } from "@/lib/utils";
import type { HealthState, JobStatus } from "@/types/app";

const jobStyles: Record<JobStatus, string> = {
  pending: "bg-slate-100 text-slate-700",
  downloading: "bg-cyan-100 text-cyan-800",
  downloaded: "bg-sky-100 text-sky-800",
  processing: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
};

const healthStyles: Record<HealthState, string> = {
  healthy: "bg-emerald-100 text-emerald-800",
  paused: "bg-amber-100 text-amber-800",
  processing: "bg-cyan-100 text-cyan-800",
  offline: "bg-slate-200 text-slate-700",
  error: "bg-rose-100 text-rose-800",
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
        "inline-flex rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]",
        style,
      )}
    >
      {label}
    </span>
  );
}
