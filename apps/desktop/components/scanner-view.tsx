"use client";

import { useEffect, useState } from "react";
import { Download, ScanLine, Tag } from "lucide-react";
import { saveBundledScannerDriver } from "@/lib/tauri";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { formatDateTime } from "@/lib/utils";
import type { ScanRecord } from "@/types/app";

const scannerStateText: Record<string, string> = {
  disabled: "Scanner not started",
  unavailable: "pyserial unavailable",
  disconnected: "No scanner detected",
  connected: "Scanner connected",
  error: "Scanner error",
};

type ScanAppearance = {
  label: string;
  cardClassName: string;
  badgeClassName: string;
};

function getScanAppearance(scan: ScanRecord): ScanAppearance {
  const code = scan.code.trim();

  if (/^4\d{6}$/.test(code)) {
    return {
      label: "Photo Zone",
      cardClassName: "border-blue-300 bg-blue-950/8",
      badgeClassName: "border-blue-300 bg-blue-950 text-blue-50",
    };
  }

  if (/^\d{12}$/.test(code)) {
    return {
      label: "PostSnap",
      cardClassName: "border-rose-300 bg-rose-50",
      badgeClassName: "border-rose-300 bg-rose-700 text-rose-50",
    };
  }

  if (/^W[\dA-Z]+$/i.test(code)) {
    return {
      label: "Wink",
      cardClassName: "border-amber-300 bg-amber-50",
      badgeClassName: "border-amber-300 bg-amber-300 text-amber-950",
    };
  }

  return {
    label: "Unknown",
    cardClassName: "border-slate-200 bg-white",
    badgeClassName: "border-slate-200 bg-slate-100 text-slate-700",
  };
}

export function ScannerView() {
  const { snapshot, recentScans, reprintScanLabel, isPending } = useWorkerStoreContext();
  const [isDownloadingDriver, setIsDownloadingDriver] = useState(false);
  const [driverDownloadError, setDriverDownloadError] = useState<string | null>(null);
  const [driverDownloadSuccess, setDriverDownloadSuccess] = useState<string | null>(null);

  const downloadDriver = async () => {
    setIsDownloadingDriver(true);
    setDriverDownloadError(null);
    setDriverDownloadSuccess(null);

    try {
      const destination = await saveBundledScannerDriver();
      if (!destination) {
        return;
      }
      setDriverDownloadSuccess(`Driver saved to ${destination}`);
    } catch {
      setDriverDownloadError("Driver download failed in the current app build.");
    } finally {
      setIsDownloadingDriver(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-white/70 bg-panel p-6 shadow-panel">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Input</p>
            <h3 className="mt-2 text-xl font-semibold">Barcode scanner</h3>
          </div>
          <div className="rounded-2xl bg-slate-100 p-3 text-slate-700">
            <ScanLine className="h-5 w-5" />
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 p-4">
            <p className="text-sm text-slate-500">Status</p>
            <p className="mt-2 font-semibold capitalize">{scannerStateText[snapshot.scanner.status] ?? snapshot.scanner.status}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 p-4">
            <p className="text-sm text-slate-500">Port</p>
            <p className="mt-2 font-semibold">{snapshot.scanner.port ?? "Not connected"}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 p-4">
            <p className="text-sm text-slate-500">Last scan</p>
            <p className="mt-2 font-semibold">{snapshot.scanner.lastCode ?? "No scans yet"}</p>
            <p className="mt-1 text-xs text-slate-500">{formatDateTime(snapshot.scanner.lastScanAt)}</p>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-white/70 bg-panel p-6 shadow-panel">
        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">History</p>
        <h3 className="mt-2 text-xl font-semibold">Recent scans</h3>

        <div className="mt-6 space-y-3">
          {recentScans.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-sm text-slate-500">
              No barcode scans received yet.
            </div>
          ) : (
            recentScans.map((scan) => (
              <div
                key={scan.id}
                className={`grid gap-4 rounded-2xl border p-4 md:grid-cols-[180px,1fr,200px] ${getScanAppearance(scan).cardClassName}`}
              >
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Timestamp</p>
                  <p className="mt-1 font-medium text-slate-800">{formatDateTime(scan.timestamp)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Barcode</p>
                  <div className="mt-1 flex items-center gap-2">
                    <p className="font-medium text-slate-800">{scan.code}</p>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${getScanAppearance(scan).badgeClassName}`}
                    >
                      {getScanAppearance(scan).label}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-500">{scan.message ?? "Captured by worker"}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Source</p>
                  <p className="mt-1 font-medium text-slate-800">{scan.source}</p>
                  <p className="mt-1 text-sm capitalize text-slate-500">{scan.status}</p>
                  {scan.canReprintLabel ? (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => void reprintScanLabel(scan.id)}
                      className="mt-3 inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Tag className="h-3.5 w-3.5" />
                      Reprint label
                    </button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-3xl border border-white/70 bg-panel p-6 shadow-panel">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Driver</p>
            <h3 className="mt-2 text-xl font-semibold">Windows Scanner Driver</h3>
            <p className="mt-2 max-w-2xl text-sm text-slate-500">
              Keep a bundled copy of the CH34x Windows driver here so it is always available when a scanner needs reinstalling.
            </p>
            {driverDownloadError ? <p className="mt-2 text-sm text-rose-600">{driverDownloadError}</p> : null}
            {driverDownloadSuccess ? <p className="mt-2 text-sm text-emerald-700">{driverDownloadSuccess}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => void downloadDriver()}
            disabled={isDownloadingDriver}
            className="inline-flex shrink-0 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" />
            {isDownloadingDriver ? "Downloading..." : "Download Driver"}
          </button>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 p-4">
            <p className="text-sm text-slate-500">Filename</p>
            <p className="mt-2 font-semibold text-slate-800">CH34x_Install_Windows_v3_4.EXE</p>
          </div>
          <div className="rounded-2xl border border-slate-200 p-4">
            <p className="text-sm text-slate-500">Platform</p>
            <p className="mt-2 font-semibold text-slate-800">Windows</p>
          </div>
          <div className="rounded-2xl border border-slate-200 p-4">
            <p className="text-sm text-slate-500">Use</p>
            <p className="mt-2 font-semibold text-slate-800">Barcode scanner driver reinstall</p>
          </div>
        </div>
      </section>
    </div>
  );
}
