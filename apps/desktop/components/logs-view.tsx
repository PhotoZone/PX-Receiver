"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CircleAlert, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { formatDateTime } from "@/lib/utils";

const levelIcons = {
  info: Info,
  warning: AlertTriangle,
  error: CircleAlert,
};

const levelStyles = {
  info: "border border-cyan-500/20 text-cyan-200 bg-cyan-500/12",
  warning: "border border-amber-500/20 text-amber-200 bg-amber-500/12",
  error: "border border-rose-500/20 text-rose-200 bg-rose-500/12",
};

export function LogsView() {
  const { recentLogs } = useWorkerStoreContext();
  const [hiddenScopes, setHiddenScopes] = useState<string[]>(["poller"]);
  const [levelFilter, setLevelFilter] = useState<"all" | "info" | "warning" | "error">("all");

  const scopes = useMemo(
    () => Array.from(new Set(recentLogs.map((log) => log.scope))).sort(),
    [recentLogs],
  );

  const filteredLogs = useMemo(() => {
    return recentLogs.filter((log) => {
      if (levelFilter !== "all" && log.level !== levelFilter) {
        return false;
      }
      if (hiddenScopes.includes(log.scope)) {
        return false;
      }
      return true;
    });
  }, [hiddenScopes, levelFilter, recentLogs]);

  const toggleScope = (scope: string) => {
    setHiddenScopes((current) =>
      current.includes(scope) ? current.filter((value) => value !== scope) : [...current, scope],
    );
  };

  return (
    <section className="rounded-[1.75rem] border border-white/10 bg-[#0c1826]/88 p-6 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {(["all", "info", "warning", "error"] as const).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => setLevelFilter(level)}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition",
                levelFilter === level
                  ? "bg-cyan-500/16 text-white"
                  : "bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]",
              )}
            >
              {level}
            </button>
          ))}
        </div>

        {scopes.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {scopes.map((scope) => {
              const hidden = hiddenScopes.includes(scope);
              return (
                <button
                  key={scope}
                  type="button"
                  onClick={() => toggleScope(scope)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition",
                    hidden
                      ? "border-white/10 bg-white/[0.02] text-slate-500"
                      : "border-white/10 bg-white/[0.06] text-slate-200 hover:bg-white/[0.1]",
                  )}
                >
                  {hidden ? `Show ${scope}` : `Hide ${scope}`}
                </button>
              );
            })}
          </div>
        ) : null}

        {filteredLogs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-8 text-sm text-slate-400">
            No log entries match the current filters.
          </div>
        ) : (
          filteredLogs.map((log) => {
            const Icon = levelIcons[log.level];
            return (
              <div key={log.id} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="flex flex-wrap items-start gap-3">
                  <p className="min-w-[7.5rem] text-xs font-medium text-slate-400">{formatDateTime(log.timestamp)}</p>
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${levelStyles[log.level]}`}>
                    <Icon className="h-3.5 w-3.5" />
                    {log.level}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-300">
                    {log.scope}
                  </span>
                  <p className="min-w-0 flex-1 text-sm leading-5 text-slate-200">{log.message}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
