"use client";

import { AlertTriangle, CircleAlert, Info } from "lucide-react";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { formatDateTime } from "@/lib/utils";

const levelIcons = {
  info: Info,
  warning: AlertTriangle,
  error: CircleAlert,
};

const levelStyles = {
  info: "text-cyan-700 bg-cyan-100",
  warning: "text-amber-700 bg-amber-100",
  error: "text-rose-700 bg-rose-100",
};

export function LogsView() {
  const { recentLogs } = useWorkerStoreContext();

  return (
    <section className="rounded-3xl border border-white/70 bg-panel p-6 shadow-panel">
      <div className="space-y-3">
        {recentLogs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-sm text-slate-500">
            No log entries yet. Worker events will appear here.
          </div>
        ) : (
          recentLogs.map((log) => {
            const Icon = levelIcons[log.level];
            return (
              <div key={log.id} className="grid gap-4 rounded-2xl border border-slate-200 p-4 md:grid-cols-[170px,130px,1fr]">
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Timestamp</p>
                  <p className="mt-1 font-medium text-slate-800">{formatDateTime(log.timestamp)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Level</p>
                  <span className={`mt-1 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${levelStyles[log.level]}`}>
                    <Icon className="h-3.5 w-3.5" />
                    {log.level}
                  </span>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-slate-500">{log.scope}</p>
                  <p className="mt-1 leading-6 text-slate-700">{log.message}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
