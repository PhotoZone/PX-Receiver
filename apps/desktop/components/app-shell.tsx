"use client";

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { Download, LoaderCircle, PauseCircle, PlayCircle, RefreshCw, X } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { StatusBadge } from "@/components/status-badge";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { formatDateTime } from "@/lib/utils";

type Props = {
  children: React.ReactNode;
};

function getPageTitle(pathname: string) {
  switch (pathname) {
    case "/":
      return "Dashboard";
    case "/jobs/unified":
      return "Order Queue";
    case "/jobs":
      return "Wink";
    case "/jobs/photo-zone":
      return "Photo Zone";
    case "/jobs/pzpro":
      return "PZPro";
    case "/scanner":
      return "Scanner";
    case "/logs":
      return "Logs";
    case "/settings":
      return "Settings";
    default:
      return "PX Receiver";
  }
}

export function AppShell({ children }: Props) {
  const pathname = usePathname();
  const { snapshot, appUpdate, isPending, togglePolling, refreshNow, downloadLatestBuild } = useWorkerStoreContext();
  const pageTitle = useMemo(() => getPageTitle(pathname), [pathname]);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);
  const showUpdateBanner = Boolean(
    appUpdate?.isUpdateAvailable
      && appUpdate.latestVersion
      && appUpdate.latestVersion !== dismissedUpdateVersion,
  );

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-h-screen flex-1 flex-col">
        <header className="border-b border-slate-200/80 bg-white/85 px-8 py-5 backdrop-blur">
          {showUpdateBanner ? (
            <div className="mb-4 flex items-center justify-between gap-4 rounded-3xl border border-emerald-200 bg-emerald-50 px-5 py-4">
              <div>
                <p className="text-sm font-semibold text-emerald-900">
                  Update available: {appUpdate?.latestVersion}
                </p>
                <p className="mt-1 text-sm text-emerald-800">
                  {appUpdate?.message}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void downloadLatestBuild()}
                  className="inline-flex items-center gap-2 rounded-2xl bg-emerald-700 px-4 py-3 text-sm font-medium text-white transition hover:bg-emerald-800"
                >
                  <Download className="h-4 w-4" />
                  Download update
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedUpdateVersion(appUpdate?.latestVersion ?? null)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-emerald-200 text-emerald-800 transition hover:bg-emerald-100"
                  title="Dismiss update notice"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-6">
            <div>
              <h2 className="text-2xl font-semibold">{pageTitle}</h2>
            </div>

            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Last sync</p>
                <div className="mt-1 flex items-center justify-end gap-2">
                  <p className="text-sm font-medium text-slate-700">{formatDateTime(snapshot.lastSyncAt)}</p>
                  <button
                    type="button"
                    onClick={refreshNow}
                    title="Refresh now"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isPending}
                  >
                    {isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <StatusBadge value={snapshot.health} kind="health" />

              <button
                type="button"
                onClick={togglePolling}
                className="inline-flex items-center gap-2 rounded-2xl bg-ink px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                {isPending ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : snapshot.pollingPaused ? (
                  <PlayCircle className="h-4 w-4" />
                ) : (
                  <PauseCircle className="h-4 w-4" />
                )}
                {snapshot.pollingPaused ? "Resume" : "Pause"}
              </button>
            </div>
          </div>
        </header>

        <main className="flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
