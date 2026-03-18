"use client";

import { createContext, useContext, useEffect, useState, useTransition } from "react";
import { defaultSnapshot } from "@/lib/defaults";
import { approveLargeFormatBatch, checkForAppUpdate, createManualLargeFormatBatch, deleteLargeFormatJob, downloadLatestAppBuild, forceCompleteWorkerJob, getSnapshot, listenToWorkerEvents, pausePolling, pollNow, printWorkerLabel, printWorkerPackingSlip, processLargeFormatNow, recoverRemoteJob, regenerateLargeFormatBatch, relaunchApp, removeLargeFormatBatch, removeLocalWorkerJob, reprintJob, reprintWorkerScanLabel, restartWorker, resumePolling, retryJob, scanLargeFormatNow, sendLargeFormatBatch, updateSettings } from "@/lib/tauri";
import type { AppUpdateStatus, JobRecord, LargeFormatBatch, LogRecord, ScanRecord, WorkerEvent, WorkerSettings, WorkerSnapshot } from "@/types/app";

function reduceEvent(snapshot: WorkerSnapshot, event: WorkerEvent): WorkerSnapshot {
  switch (event.type) {
    case "snapshot":
      return event.payload;
    case "log":
      return {
        ...snapshot,
        logs: [event.payload, ...snapshot.logs].slice(0, 250),
      };
    case "job":
      return {
        ...snapshot,
        jobs: [event.payload, ...snapshot.jobs.filter((job) => job.id !== event.payload.id)].slice(0, 150),
      };
    case "scan":
      return {
        ...snapshot,
        scanner: {
          ...snapshot.scanner,
          lastScanAt: event.payload.timestamp,
          lastCode: event.payload.code,
          recentScans: [event.payload, ...snapshot.scanner.recentScans.filter((scan) => scan.id !== event.payload.id)].slice(0, 50),
        },
      };
    case "scanner":
      return {
        ...snapshot,
        scanner: event.payload,
      };
    case "health":
      return {
        ...snapshot,
        ...event.payload,
      };
    default:
      return snapshot;
  }
}

export function useWorkerStore() {
  const [snapshot, setSnapshot] = useState<WorkerSnapshot>(defaultSnapshot);
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let mounted = true;

    void getSnapshot().then((next) => {
      if (mounted) {
        setSnapshot(next);
      }
    });

    let teardown: () => void = () => {};
    void listenToWorkerEvents((event) => {
      if (!mounted) {
        return;
      }

      setSnapshot((current) => reduceEvent(current, event));
    }).then((unlisten) => {
      teardown = unlisten;
    });

    return () => {
      mounted = false;
      teardown();
    };
  }, []);

  useEffect(() => {
    let active = true;

    void checkForAppUpdate().then((status) => {
      if (active && status) {
        setAppUpdate(status);
      }
    }).catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  const updateSnapshot = async (promise: Promise<WorkerSnapshot>) => {
    const next = await promise;
    startTransition(() => {
      setSnapshot(next);
    });
    return next;
  };

  return {
    snapshot,
    appUpdate,
    isPending,
    updateSettings: (settings: WorkerSettings) => updateSnapshot(updateSettings(settings)),
    togglePolling: () =>
      updateSnapshot(snapshot.pollingPaused ? resumePolling() : pausePolling()),
    refreshNow: () => updateSnapshot(pollNow()),
    scanLargeFormatNow: () => updateSnapshot(scanLargeFormatNow()),
    processLargeFormatNow: () => updateSnapshot(processLargeFormatNow()),
    createManualLargeFormatBatch: (jobId: string) => updateSnapshot(createManualLargeFormatBatch(jobId)),
    approveLargeFormatBatch: (batchId: string) => updateSnapshot(approveLargeFormatBatch(batchId)),
    sendLargeFormatBatch: (batchId: string) => updateSnapshot(sendLargeFormatBatch(batchId)),
    regenerateLargeFormatBatch: (batchId: string) => updateSnapshot(regenerateLargeFormatBatch(batchId)),
    removeLargeFormatBatch: (batchId: string) => updateSnapshot(removeLargeFormatBatch(batchId)),
    deleteLargeFormatJob: (jobId: string) => updateSnapshot(deleteLargeFormatJob(jobId)),
    retryJob: (jobId: string) => updateSnapshot(retryJob(jobId)),
    removeLocalJob: (jobId: string) => updateSnapshot(removeLocalWorkerJob(jobId)),
    recoverRemoteJob: (job: JobRecord) => updateSnapshot(recoverRemoteJob(job)),
    reprintJob: (jobId: string) => updateSnapshot(reprintJob(jobId)),
    printPackingSlip: (jobId: string) => updateSnapshot(printWorkerPackingSlip(jobId)),
    printLabel: (jobId: string) => updateSnapshot(printWorkerLabel(jobId)),
    reprintScanLabel: (scanId: string) => updateSnapshot(reprintWorkerScanLabel(scanId)),
    forceCompleteJob: (jobId: string) => updateSnapshot(forceCompleteWorkerJob(jobId)),
    restartWorker: () => updateSnapshot(restartWorker()),
    relaunchApp: () => relaunchApp(),
    checkForUpdates: async () => {
      const next = await checkForAppUpdate();
      setAppUpdate(next);
      return next;
    },
    downloadLatestBuild: () => downloadLatestAppBuild(),
    recentJobs: snapshot.jobs,
    recentLogs: snapshot.logs,
    recentScans: snapshot.scanner.recentScans,
    activeJob: snapshot.jobs.find((job) => job.id === snapshot.activeJobId) ?? null,
    activeLargeFormatBatch: snapshot.largeFormat.batches.find((batch) => batch.id === snapshot.largeFormat.activeBatchId) ?? null,
  } satisfies {
    snapshot: WorkerSnapshot;
    appUpdate: AppUpdateStatus | null;
    isPending: boolean;
    updateSettings: (settings: WorkerSettings) => Promise<WorkerSnapshot>;
    togglePolling: () => Promise<WorkerSnapshot>;
    refreshNow: () => Promise<WorkerSnapshot>;
    scanLargeFormatNow: () => Promise<WorkerSnapshot>;
    processLargeFormatNow: () => Promise<WorkerSnapshot>;
    createManualLargeFormatBatch: (jobId: string) => Promise<WorkerSnapshot>;
    approveLargeFormatBatch: (batchId: string) => Promise<WorkerSnapshot>;
    sendLargeFormatBatch: (batchId: string) => Promise<WorkerSnapshot>;
    regenerateLargeFormatBatch: (batchId: string) => Promise<WorkerSnapshot>;
    removeLargeFormatBatch: (batchId: string) => Promise<WorkerSnapshot>;
    deleteLargeFormatJob: (jobId: string) => Promise<WorkerSnapshot>;
    retryJob: (jobId: string) => Promise<WorkerSnapshot>;
    removeLocalJob: (jobId: string) => Promise<WorkerSnapshot>;
    recoverRemoteJob: (job: JobRecord) => Promise<WorkerSnapshot>;
    reprintJob: (jobId: string) => Promise<WorkerSnapshot>;
    printPackingSlip: (jobId: string) => Promise<WorkerSnapshot>;
    printLabel: (jobId: string) => Promise<WorkerSnapshot>;
    reprintScanLabel: (scanId: string) => Promise<WorkerSnapshot>;
    forceCompleteJob: (jobId: string) => Promise<WorkerSnapshot>;
    restartWorker: () => Promise<WorkerSnapshot>;
    relaunchApp: () => Promise<void>;
    checkForUpdates: () => Promise<AppUpdateStatus | null>;
    downloadLatestBuild: () => Promise<void>;
    recentJobs: JobRecord[];
    recentLogs: LogRecord[];
    recentScans: ScanRecord[];
    activeJob: JobRecord | null;
    activeLargeFormatBatch: LargeFormatBatch | null;
  };
}

type WorkerStore = ReturnType<typeof useWorkerStore>;

const WorkerStoreContext = createContext<WorkerStore | null>(null);

export function WorkerStoreProvider({ children }: { children: React.ReactNode }) {
  const store = useWorkerStore();
  return <WorkerStoreContext.Provider value={store}>{children}</WorkerStoreContext.Provider>;
}

export function useWorkerStoreContext() {
  const context = useContext(WorkerStoreContext);
  if (!context) {
    throw new Error("WorkerStoreProvider is missing");
  }

  return context;
}
