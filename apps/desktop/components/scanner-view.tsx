"use client";

import { useEffect, useState } from "react";
import { Download, ScanLine } from "lucide-react";
import { saveBundledScannerDriver } from "@/lib/tauri";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { formatDateTime } from "@/lib/utils";

const scannerStateText: Record<string, string> = {
  disabled: "Scanner not started",
  unavailable: "pyserial unavailable",
  disconnected: "No scanner detected",
  connected: "Scanner connected",
  error: "Scanner error",
};

export function ScannerView() {
  const { snapshot, recentScans } = useWorkerStoreContext();
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
              <div key={scan.id} className="grid gap-4 rounded-2xl border border-slate-200 p-4 md:grid-cols-[180px,1fr,160px]">
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Timestamp</p>
                  <p className="mt-1 font-medium text-slate-800">{formatDateTime(scan.timestamp)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Barcode</p>
                  <p className="mt-1 font-medium text-slate-800">{scan.code}</p>
                  <p className="mt-1 text-sm text-slate-500">{scan.message ?? "Captured by worker"}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Source</p>
                  <p className="mt-1 font-medium text-slate-800">{scan.source}</p>
                  <p className="mt-1 text-sm capitalize text-slate-500">{scan.status}</p>
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
