"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Download, ScanLine, Tag } from "lucide-react";
import { saveBundledScannerDriver } from "@/lib/tauri";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { cn, formatDateTime } from "@/lib/utils";
import type { ScanRecord } from "@/types/app";

const scannerStateText: Record<string, string> = {
  disabled: "Scanner Not Started",
  unavailable: "Pyserial Unavailable",
  disconnected: "No Scanner Detected",
  connected: "Scanner Connected",
  error: "Scanner Error",
};

type ScanAppearance = {
  key: "photozone" | "postsnap" | "wink" | "unknown";
  label: string;
  cardClassName: string;
  badgeClassName: string;
  sectionClassName: string;
};

function getScanAppearance(scan: ScanRecord): ScanAppearance {
  const code = scan.code.trim();

  if (/^4\d{7}$/.test(code)) {
    return {
      key: "photozone",
      label: "Photo Zone",
      cardClassName: "border-blue-500/20 bg-blue-500/10",
      badgeClassName: "border-blue-400/30 bg-blue-500/80 text-blue-50",
      sectionClassName: "border-blue-500/20 bg-blue-500/[0.06]",
    };
  }

  if (/^\d{12}$/.test(code)) {
    return {
      key: "postsnap",
      label: "PostSnap",
      cardClassName: "border-rose-500/20 bg-rose-500/10",
      badgeClassName: "border-rose-400/30 bg-rose-600 text-rose-50",
      sectionClassName: "border-rose-500/20 bg-rose-500/[0.06]",
    };
  }

  if (/^W[\dA-Z]+$/i.test(code)) {
    return {
      key: "wink",
      label: "Wink",
      cardClassName: "border-amber-500/20 bg-amber-500/10",
      badgeClassName: "border-amber-400/30 bg-amber-300 text-amber-950",
      sectionClassName: "border-amber-500/20 bg-amber-500/[0.06]",
    };
  }

  return {
    key: "unknown",
    label: "Unknown",
    cardClassName: "border-white/10 bg-white/[0.03]",
    badgeClassName: "border-white/10 bg-white/10 text-slate-200",
    sectionClassName: "border-white/10 bg-white/[0.03]",
  };
}

function ScanLane({
  title,
  scans,
}: {
  title: string;
  scans: ScanRecord[];
}) {
  const appearance = scans[0] ? getScanAppearance(scans[0]) : null;

  return (
    <article
      className={cn(
        "flex min-h-[18rem] flex-col rounded-[1.5rem] border p-4",
        appearance?.sectionClassName ?? "border-white/10 bg-white/[0.03]",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-lg font-semibold text-white">{title}</h4>
        </div>
        <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-slate-200">
          {scans.length}
        </div>
      </div>

      <div className="mt-4 flex-1 space-y-3 overflow-y-auto pr-1">
        {scans.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
            No scans yet.
          </div>
        ) : (
          scans.map((scan) => {
            const scanAppearance = getScanAppearance(scan);
            return (
              <div key={scan.id} className={cn("rounded-2xl border p-4", scanAppearance.cardClassName)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium text-slate-100">{scan.code}</p>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                          scanAppearance.badgeClassName,
                        )}
                      >
                        {scanAppearance.label}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-slate-300">{scan.message ?? "Captured by worker"}</p>
                    <div className="mt-2 flex items-center gap-3 text-xs text-slate-400">
                      <span>{formatDateTime(scan.timestamp)}</span>
                      <span className="capitalize">{scan.status}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </article>
  );
}

export function ScannerView() {
  const { snapshot, recentScans, reprintScanLabel, isPending } = useWorkerStoreContext();
  const [isDownloadingDriver, setIsDownloadingDriver] = useState(false);
  const [driverDownloadError, setDriverDownloadError] = useState<string | null>(null);
  const [driverDownloadSuccess, setDriverDownloadSuccess] = useState<string | null>(null);
  const [isDriverOpen, setIsDriverOpen] = useState(false);

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

  const winkScans = recentScans.filter((scan) => getScanAppearance(scan).key === "wink");
  const photoZoneScans = recentScans.filter((scan) => getScanAppearance(scan).key === "photozone");
  const postSnapScans = recentScans.filter((scan) => getScanAppearance(scan).key === "postsnap");

  return (
    <div className="space-y-6">
      <section className="rounded-[1.75rem] border border-white/10 bg-[#0c1826]/88 p-6 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[11px] tracking-[0.12em] text-slate-500">Input</p>
            <h3 className="mt-2 text-2xl font-semibold text-white">Barcode Scanner</h3>
          </div>
          <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/12 p-3 text-cyan-200">
            <ScanLine className="h-5 w-5" />
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-sm text-slate-500">Status</p>
            <p className="mt-2 text-lg font-semibold capitalize text-white">{scannerStateText[snapshot.scanner.status] ?? snapshot.scanner.status}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-sm text-slate-500">Port</p>
            <p className="mt-2 text-lg font-semibold text-white">{snapshot.scanner.port ?? "Not connected"}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-sm text-slate-500">Last Scan</p>
            <p className="mt-2 text-lg font-semibold text-white">{snapshot.scanner.lastCode ?? "No scans yet"}</p>
            <p className="mt-1 text-xs text-slate-500">{formatDateTime(snapshot.scanner.lastScanAt)}</p>
          </div>
        </div>
      </section>

      <section className="rounded-[1.75rem] border border-white/10 bg-[#0c1826]/88 p-6 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[11px] tracking-[0.12em] text-slate-500">History</p>
            <h3 className="mt-2 text-2xl font-semibold text-white">Recent Scans</h3>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">
            <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1">Photo Zone {photoZoneScans.length}</span>
            <span className="rounded-full border border-rose-500/20 bg-rose-500/10 px-3 py-1">PostSnap {postSnapScans.length}</span>
            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1">Wink {winkScans.length}</span>
          </div>
        </div>

        <div className="mt-6 grid gap-4 xl:grid-cols-3">
          <ScanLane title="Photo Zone" scans={photoZoneScans} />
          <ScanLane title="PostSnap" scans={postSnapScans} />
          <ScanLane title="Wink" scans={winkScans} />
        </div>

        {recentScans.some((scan) => scan.canReprintLabel) ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {recentScans.filter((scan) => scan.canReprintLabel).slice(0, 6).map((scan) => (
              <button
                key={scan.id}
                type="button"
                disabled={isPending}
                onClick={() => void reprintScanLabel(scan.id)}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-100 transition hover:border-white/20 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Tag className="h-3.5 w-3.5" />
                Reprint {scan.code}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="rounded-[1.75rem] border border-white/10 bg-[#0c1826]/88 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
        <button
          type="button"
          onClick={() => setIsDriverOpen((current) => !current)}
          className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
        >
          <div>
            <p className="text-[11px] tracking-[0.12em] text-slate-500">Driver</p>
            <h3 className="mt-2 text-xl font-semibold text-white">Windows Scanner Driver</h3>
          </div>
          <ChevronDown className={`h-5 w-5 text-slate-400 transition ${isDriverOpen ? "rotate-180" : ""}`} />
        </button>

        {isDriverOpen ? (
          <div className="border-t border-white/10 px-6 pb-6 pt-2">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="max-w-2xl text-sm text-slate-400">
                  Keep a bundled copy of the CH34x Windows driver here so it is always available when a scanner needs reinstalling.
                </p>
                {driverDownloadError ? <p className="mt-2 text-sm text-rose-600">{driverDownloadError}</p> : null}
                {driverDownloadSuccess ? <p className="mt-2 text-sm text-emerald-700">{driverDownloadSuccess}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => void downloadDriver()}
                disabled={isDownloadingDriver}
                className="inline-flex shrink-0 items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-slate-100 transition hover:border-white/20 hover:bg-white/10"
              >
                <Download className="h-4 w-4" />
                {isDownloadingDriver ? "Downloading..." : "Download Driver"}
              </button>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-sm text-slate-500">Filename</p>
                <p className="mt-2 font-semibold text-slate-100">CH34x_Install_Windows_v3_4.EXE</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-sm text-slate-500">Platform</p>
                <p className="mt-2 font-semibold text-slate-100">Windows</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-sm text-slate-500">Use</p>
                <p className="mt-2 font-semibold text-slate-100">Barcode Scanner Driver Reinstall</p>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
