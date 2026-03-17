"use client";

import { useEffect, useState } from "react";
import { FolderOpen, RefreshCw, RotateCcw, Save } from "lucide-react";
import { fetchReceiverRoutes, getInstalledPrinters, getLastSuccessfulPxSearch, openFolderInOs, pickFolder } from "@/lib/tauri";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import type { InstalledPrinter, ReceiverRoute, WorkerSettings } from "@/types/app";

type FolderFieldProps = {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onOpen?: (value: string) => void;
};

function FolderField({ label, value, placeholder, onChange, onOpen }: FolderFieldProps) {
  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);

  const browse = async () => {
    setIsPicking(true);
    try {
      const selected = await pickFolder(value);
      setError(null);
      if (selected) {
        onChange(selected);
      }
    } catch {
      setError("Native folder picker is unavailable in the current app build.");
    } finally {
      setIsPicking(false);
    }
  };

  const openFolder = async () => {
    if (!onOpen || !value.trim()) {
      return;
    }

    setIsOpening(true);
    try {
      await onOpen(value);
      setError(null);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Unable to open this folder from the current app build.");
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <label className="space-y-2">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-accent"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => void browse()}
          disabled={isPicking}
          className="inline-flex shrink-0 items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FolderOpen className="h-4 w-4" />
          Browse
        </button>
        <button
          type="button"
          onClick={() => void openFolder()}
          disabled={isOpening || !value.trim()}
          className="inline-flex shrink-0 items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FolderOpen className="h-4 w-4" />
          Open
        </button>
      </div>
      {error ? <p className="text-xs text-rose-600">{error}</p> : null}
    </label>
  );
}

type PrinterFieldProps = {
  label: string;
  value: string;
  emptyOptionLabel: string;
  printers: InstalledPrinter[];
  isLoadingPrinters: boolean;
  onChange: (value: string) => void;
  onRefresh: () => void;
};

function PrinterField({
  label,
  value,
  emptyOptionLabel,
  printers,
  isLoadingPrinters,
  onChange,
  onRefresh,
}: PrinterFieldProps) {
  return (
    <label className="space-y-2">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="flex gap-2">
        <select
          className="min-w-0 flex-1 rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-accent"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{emptyOptionLabel}</option>
          {printers.map((printer) => (
            <option key={printer.name} value={printer.name}>
              {printer.name}{printer.isDefault ? " (Default)" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoadingPrinters}
          className="inline-flex shrink-0 items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>
    </label>
  );
}

function SettingsSection({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-panel">
      <div>
        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">{eyebrow}</p>
        <h4 className="mt-2 text-lg font-semibold text-slate-900">{title}</h4>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{description}</p>
      </div>
      <div className="mt-6 grid gap-5 md:grid-cols-2">{children}</div>
    </section>
  );
}

export function SettingsView() {
  const { snapshot, appUpdate, updateSettings, restartWorker, relaunchApp, checkForUpdates, downloadLatestBuild, isPending } = useWorkerStoreContext();
  const [formState, setFormState] = useState<WorkerSettings>(snapshot.settings);
  const [printers, setPrinters] = useState<InstalledPrinter[]>([]);
  const [isLoadingPrinters, setIsLoadingPrinters] = useState(false);
  const [printerError, setPrinterError] = useState<string | null>(null);
  const [routes, setRoutes] = useState<ReceiverRoute[]>([]);
  const [isLoadingRoutes, setIsLoadingRoutes] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [manualStoreOverrideAllowed, setManualStoreOverrideAllowed] = useState(true);
  const [manualStoreOverride, setManualStoreOverride] = useState(false);
  const [lastSuccessfulPxSearch, setLastSuccessfulPxSearch] = useState(getLastSuccessfulPxSearch());
  const [isRestartingWorker, setIsRestartingWorker] = useState(false);
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);
  const [operationsError, setOperationsError] = useState<string | null>(null);
  const [updateStatusMessage, setUpdateStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    setFormState(snapshot.settings);
  }, [snapshot.settings]);

  useEffect(() => {
    setLastSuccessfulPxSearch(getLastSuccessfulPxSearch());
  }, [snapshot.jobs, snapshot.logs]);

  useEffect(() => {
    setManualStoreOverride(false);
  }, [snapshot.settings.machineId]);

  const loadPrinters = async () => {
    setIsLoadingPrinters(true);
    try {
      const next = await getInstalledPrinters();
      setPrinters(next);
      setPrinterError(null);
    } catch {
      setPrinterError("Installed printers are unavailable in the current app build.");
    } finally {
      setIsLoadingPrinters(false);
    }
  };

  useEffect(() => {
    void loadPrinters();
  }, []);

  useEffect(() => {
    let active = true;

    const loadRoutes = async () => {
      setIsLoadingRoutes(true);
      try {
        const payload = await fetchReceiverRoutes(formState);
        if (!active) {
          return;
        }
        const nextRoutes = payload.stores?.length ? payload.stores : payload.routes ?? [];
        setRoutes(nextRoutes);
        setManualStoreOverrideAllowed(payload.manualOverrideAllowed);
        setRouteError(null);

        const selectedRoute = nextRoutes.find((route) => route.storeId === formState.machineId);
        if (!selectedRoute && nextRoutes.length > 0 && (!formState.machineId || formState.machineId === "machine-demo-001")) {
          setFormState((current) => ({
            ...current,
            machineId: nextRoutes[0].storeId || nextRoutes[0].defaultMachineId || current.machineId,
          }));
        }
        if (formState.machineId && !nextRoutes.some((route) => route.storeId === formState.machineId)) {
          setManualStoreOverride(true);
        }
      } catch {
        if (active) {
          setRoutes([]);
          setRouteError("Store routes are unavailable right now. You can still enter a Store ID manually.");
        }
      } finally {
        if (active) {
          setIsLoadingRoutes(false);
        }
      }
    };

    void loadRoutes();

    return () => {
      active = false;
    };
  }, [formState.backendUrl, formState.apiToken, formState.machineAuthToken, formState.useMockBackend]);

  const updateField = <K extends keyof WorkerSettings>(key: K, value: WorkerSettings[K]) => {
    setFormState((current) => ({ ...current, [key]: value }));
  };

  const openConfiguredFolder = async (path: string) => {
    await openFolderInOs(path);
  };

  const lastWorkerError = snapshot.logs.find((entry) => entry.level === "error") ?? null;
  const lastAuthLog = snapshot.logs.find((entry) => entry.scope === "auth") ?? null;
  const backendAuthState = formState.useMockBackend
    ? "Mock backend enabled"
    : snapshot.health === "error" && snapshot.currentActivity.toLowerCase().includes("startup")
      ? "Startup check failed"
      : (snapshot.settings.machineAuthToken || "").trim()
        ? "Machine token present"
        : formState.apiToken.trim()
          ? "API token configured"
          : "No backend credentials configured";
  const hotFolderTargets = [
    { label: "Default", path: formState.hotFolderPath },
    { label: "Fuji", path: formState.photoPrintHotFolderPath || formState.hotFolderPath },
    { label: "Sublimation", path: formState.photoGiftHotFolderPath || formState.hotFolderPath },
    { label: "Large Format", path: formState.largeFormatHotFolderPath || formState.hotFolderPath },
  ];

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void updateSettings(formState);
      }}
    >
      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="button"
          disabled={isRestartingWorker}
          onClick={() => {
            setIsRestartingWorker(true);
            setOperationsError(null);
            void restartWorker().catch((error: unknown) => {
              setOperationsError(error instanceof Error ? error.message : "Failed to restart worker.");
            }).finally(() => {
              setIsRestartingWorker(false);
            });
          }}
          className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw className="h-4 w-4" />
          Restart worker
        </button>
        <button
          type="button"
          onClick={() => {
            setOperationsError(null);
            void relaunchApp().catch((error: unknown) => {
              setOperationsError(error instanceof Error ? error.message : "Failed to relaunch app.");
            });
          }}
          className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-accent hover:text-accent"
        >
          <RotateCcw className="h-4 w-4" />
          Relaunch app
        </button>
        <button
          type="button"
          onClick={() => {
            setOperationsError(null);
            setUpdateStatusMessage(null);
            setIsCheckingForUpdates(true);
            void checkForUpdates().then((status) => {
              if (!status) {
                setUpdateStatusMessage("Update checks are unavailable in the current app build.");
                return;
              }

              setUpdateStatusMessage(status.message ?? null);
              if (status.isUpdateAvailable) {
                return downloadLatestBuild();
              }
            }).catch((error: unknown) => {
              setOperationsError(error instanceof Error ? error.message : "Failed to check for updates.");
            }).finally(() => {
              setIsCheckingForUpdates(false);
            });
          }}
          disabled={isCheckingForUpdates}
          className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isCheckingForUpdates ? "animate-spin" : ""}`} />
          {appUpdate?.isUpdateAvailable ? "Download update" : "Check for updates"}
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-2xl bg-accent px-4 py-3 text-sm font-medium text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          Save settings
        </button>
      </div>
      {updateStatusMessage ? <p className="text-sm text-slate-600">{updateStatusMessage}</p> : null}
      {operationsError ? <p className="text-sm text-rose-600">{operationsError}</p> : null}

      <SettingsSection
        eyebrow="Operations"
        title="Runtime Controls"
        description="Quick actions and current runtime details for support and recovery."
      >
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 md:col-span-2">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Backend auth</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{backendAuthState}</p>
              <p className="mt-1 text-xs text-slate-500">{lastAuthLog?.message || snapshot.currentActivity}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Last worker error</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{lastWorkerError ? lastWorkerError.message : "None"}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Last PX search</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">
                {lastSuccessfulPxSearch ? `${lastSuccessfulPxSearch.query} (${lastSuccessfulPxSearch.resultCount})` : "No successful PX search yet"}
              </p>
              <p className="mt-1 text-xs text-slate-500">{lastSuccessfulPxSearch?.searchedAt || ""}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Current activity</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{snapshot.currentActivity}</p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 md:col-span-2">
          <p className="text-sm font-medium text-slate-900">Current hot-folder targets</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {hotFolderTargets.map((target) => (
              <div key={target.label} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.14em] text-slate-500">{target.label}</p>
                <p className="mt-2 break-all text-sm font-medium text-slate-900">{target.path || "Not configured"}</p>
              </div>
            ))}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Connection"
        title="Backend And Store"
        description="How this station identifies itself and connects to the assigned store order feed."
      >
        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-700">Backend API URL</span>
          <input className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none ring-0 transition focus:border-accent" value={formState.backendUrl} onChange={(event) => updateField("backendUrl", event.target.value)} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-700">Machine name</span>
          <input className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-accent" value={formState.machineName} onChange={(event) => updateField("machineName", event.target.value)} />
        </label>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-slate-700">Store</span>
            {manualStoreOverrideAllowed ? (
              <button
                type="button"
                onClick={() => setManualStoreOverride((current) => !current)}
                className="text-xs font-medium text-slate-500 transition hover:text-accent"
              >
                {manualStoreOverride ? "Use dropdown" : "Enter manually"}
              </button>
            ) : null}
          </div>

          {manualStoreOverride || routes.length === 0 ? (
            <input
              className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-accent"
              value={formState.machineId}
              onChange={(event) => updateField("machineId", event.target.value)}
              placeholder="Store ID"
            />
          ) : (
            <select
              className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-accent"
              value={routes.some((route) => route.storeId === formState.machineId) ? formState.machineId : ""}
              onChange={(event) => updateField("machineId", event.target.value)}
            >
              <option value="" disabled>
                Select a store
              </option>
              {routes.map((route) => (
                <option key={`${route.source}-${route.storeId}`} value={route.storeId}>
                  {route.label}
                </option>
              ))}
            </select>
          )}

          {isLoadingRoutes ? <p className="text-xs text-slate-500">Loading available stores...</p> : null}
          {routeError ? <p className="text-xs text-rose-600">{routeError}</p> : null}
        </div>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-700">API token</span>
          <input className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-accent" type="password" value={formState.apiToken} onChange={(event) => updateField("apiToken", event.target.value)} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-700">Polling interval (seconds)</span>
          <input className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-accent" type="number" min={5} max={300} value={formState.pollingIntervalSeconds} onChange={(event) => updateField("pollingIntervalSeconds", Number(event.target.value))} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-700">Use mock backend</span>
          <select className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-accent" value={String(formState.useMockBackend)} onChange={(event) => updateField("useMockBackend", event.target.value === "true")}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </label>
      </SettingsSection>

      <SettingsSection
        eyebrow="Printing"
        title="Output Printers"
        description="Choose the printer for packing slips separately from the printer used for shipping labels."
      >
        <PrinterField
          label="Packing slip printer"
          value={formState.packingSlipPrinterName}
          emptyOptionLabel="Use job/default printer"
          printers={printers}
          isLoadingPrinters={isLoadingPrinters}
          onChange={(value) => updateField("packingSlipPrinterName", value)}
          onRefresh={() => void loadPrinters()}
        />

        <PrinterField
          label="Shipping label printer"
          value={formState.shippingLabelPrinterName}
          emptyOptionLabel="Use default printer"
          printers={printers}
          isLoadingPrinters={isLoadingPrinters}
          onChange={(value) => updateField("shippingLabelPrinterName", value)}
          onRefresh={() => void loadPrinters()}
        />

        <div className="md:col-span-2">
          {printerError ? <p className="text-xs text-rose-600">{printerError}</p> : null}
          {!printerError && printers.length === 0 ? <p className="text-xs text-slate-500">No installed printers detected.</p> : null}
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Storage"
        title="Downloads And Hot Folders"
        description="Choose where orders download locally and where each printer route is released for production."
      >
        <FolderField label="Download directory" value={formState.downloadDirectory} onChange={(value) => updateField("downloadDirectory", value)} onOpen={openConfiguredFolder} />

        <FolderField label="Default hot folder" value={formState.hotFolderPath} onChange={(value) => updateField("hotFolderPath", value)} onOpen={openConfiguredFolder} />

        <FolderField
          label="Fuji Printer hot folder"
          value={formState.photoPrintHotFolderPath}
          onChange={(value) => updateField("photoPrintHotFolderPath", value)}
          placeholder="Used when printer route is Fuji Lab"
          onOpen={openConfiguredFolder}
        />

        <FolderField
          label="Sublimation hot folder"
          value={formState.photoGiftHotFolderPath}
          onChange={(value) => updateField("photoGiftHotFolderPath", value)}
          placeholder="Used when printer route is Sublimation"
          onOpen={openConfiguredFolder}
        />

        <FolderField
          label="Large Format hot folder"
          value={formState.largeFormatHotFolderPath}
          onChange={(value) => updateField("largeFormatHotFolderPath", value)}
          placeholder="Used when printer route is Large Format"
          onOpen={openConfiguredFolder}
        />
      </SettingsSection>
    </form>
  );
}
