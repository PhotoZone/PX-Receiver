"use client";

import { useEffect, useState } from "react";
import { FolderOpen, RefreshCw, RotateCcw, Save } from "lucide-react";
import { routeMachineId, routeMatchesMachineId } from "@/lib/receiver-contract";
import { fetchReceiverRoutes, getInstalledPrinters, getLastSuccessfulPxSearch, loginReceiverStore, openPathInOs, pickFolder } from "@/lib/tauri";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import type { InstalledPrinter, ReceiverRoute, ReceiverStoreLoginResponse, WorkerSettings } from "@/types/app";

type SettingsTab = "overview" | "connection" | "printing" | "storage" | "large_format";

const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "connection", label: "Connection" },
  { id: "printing", label: "Printing" },
  { id: "storage", label: "Storage" },
  { id: "large_format", label: "Large Format" },
];

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
      <span className="text-sm font-medium text-slate-200">{label}</span>
      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/40"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => void browse()}
          disabled={isPicking}
          className="inline-flex shrink-0 items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FolderOpen className="h-4 w-4" />
          Browse
        </button>
        <button
          type="button"
          onClick={() => void openFolder()}
          disabled={isOpening || !value.trim()}
          className="inline-flex shrink-0 items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
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
      <span className="text-sm font-medium text-slate-200">{label}</span>
      <div className="flex gap-2">
        <select
          className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40"
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
          className="inline-flex shrink-0 items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
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
    <section className="rounded-[1.75rem] border border-white/10 bg-[#0c1826]/88 p-6 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
      <div>
        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">{eyebrow}</p>
        <h4 className="mt-2 text-lg font-semibold text-slate-100">{title}</h4>
        {description ? <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">{description}</p> : null}
      </div>
      <div className="mt-6 grid gap-5 md:grid-cols-2">{children}</div>
    </section>
  );
}

export function SettingsView() {
  const { snapshot, appUpdate, updateSettings, restartWorker, relaunchApp, checkForUpdates, downloadLatestBuild, isPending } = useWorkerStoreContext();
  const [formState, setFormState] = useState<WorkerSettings>(snapshot.settings);
  const [activeTab, setActiveTab] = useState<SettingsTab>("large_format");
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
  const [storeLoginUsername, setStoreLoginUsername] = useState("");
  const [storeLoginPassword, setStoreLoginPassword] = useState("");
  const [storeLoginStatus, setStoreLoginStatus] = useState<string | null>(null);
  const [storeLoginError, setStoreLoginError] = useState<string | null>(null);
  const [isLoggingInToStore, setIsLoggingInToStore] = useState(false);
  const [storeRouteScope, setStoreRouteScope] = useState<string[] | null>(null);

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
    const timeoutId = window.setTimeout(() => {
      void loadPrinters();
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const timeoutId = window.setTimeout(() => {
      void loadRoutes();
    }, 0);

    const loadRoutes = async () => {
      setIsLoadingRoutes(true);
      try {
        const payload = await fetchReceiverRoutes(formState);
        if (!active) {
          return;
        }
        const nextRoutes = filterRoutesByScope(payload.stores?.length ? payload.stores : payload.routes ?? []);
        setRoutes(nextRoutes);
        setManualStoreOverrideAllowed(payload.manualOverrideAllowed);
        setRouteError(null);

        const selectedRoute = nextRoutes.find((route) => routeMatchesMachineId(route, formState.machineId));
        if (!selectedRoute && nextRoutes.length > 0 && (!formState.machineId || formState.machineId === "machine-demo-001")) {
          setFormState((current) => ({
            ...current,
            machineId: routeMachineId(nextRoutes[0]) || current.machineId,
          }));
        }
        if (formState.machineId && !nextRoutes.some((route) => routeMatchesMachineId(route, formState.machineId))) {
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

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [formState.backendUrl, formState.apiToken, formState.machineAuthToken, storeRouteScope]);

  const updateField = <K extends keyof WorkerSettings>(key: K, value: WorkerSettings[K]) => {
    setFormState((current) => ({ ...current, [key]: value }));
  };

  const filterRoutesByScope = (nextRoutes: ReceiverRoute[]) => {
    if (!storeRouteScope?.length) {
      return nextRoutes;
    }
    return nextRoutes.filter((route) => route.storeKey && storeRouteScope.includes(route.storeKey));
  };

  const applyStoreScopedRoutes = (payload: ReceiverStoreLoginResponse, machineId: string) => {
    const nextRoutes = filterRoutesByScope(payload.stores?.length ? payload.stores : payload.routes ?? []);
    setRoutes(nextRoutes);
    setManualStoreOverrideAllowed(payload.manualOverrideAllowed);
    setManualStoreOverride(false);
    setRouteError(null);
    if (machineId && !nextRoutes.some((route) => routeMatchesMachineId(route, machineId))) {
      setManualStoreOverride(true);
    }
  };

  const openConfiguredFolder = async (path: string) => {
    await openPathInOs(path);
  };

  const lastWorkerError = snapshot.logs.find((entry) => entry.level === "error") ?? null;
  const lastAuthLog = snapshot.logs.find((entry) => entry.scope === "auth") ?? null;
  const backendAuthState = snapshot.health === "error" && snapshot.currentActivity.toLowerCase().includes("startup")
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
      <div className="flex flex-wrap justify-end gap-3 rounded-[1.5rem] border border-white/10 bg-[#0c1826]/88 p-4 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
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
          className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
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
          className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/[0.08]"
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
          className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isCheckingForUpdates ? "animate-spin" : ""}`} />
          {appUpdate?.isUpdateAvailable ? "Install update" : "Check for updates"}
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-2xl bg-cyan-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          Save settings
        </button>
      </div>
      {updateStatusMessage ? <p className="text-sm text-slate-400">{updateStatusMessage}</p> : null}
      {operationsError ? <p className="text-sm text-rose-600">{operationsError}</p> : null}

      <div className="rounded-[1.5rem] border border-white/10 bg-[#0c1826]/88 p-3 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
        <div className="flex flex-wrap gap-2">
          {settingsTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={activeTab === tab.id
                ? "rounded-2xl bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950"
                : "rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/[0.08]"}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "overview" ? (
        <SettingsSection
          eyebrow="Operations"
          title="Runtime Controls"
          description=""
        >
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:col-span-2">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Backend auth</p>
              <p className="mt-2 text-sm font-semibold text-slate-100">{backendAuthState}</p>
              <p className="mt-1 text-xs text-slate-500">{lastAuthLog?.message || snapshot.currentActivity}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Last worker error</p>
              <p className="mt-2 text-sm font-semibold text-slate-100">{lastWorkerError ? lastWorkerError.message : "None"}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Last PX search</p>
              <p className="mt-2 text-sm font-semibold text-slate-100">
                {lastSuccessfulPxSearch ? `${lastSuccessfulPxSearch.query} (${lastSuccessfulPxSearch.resultCount})` : "No successful PX search yet"}
              </p>
              <p className="mt-1 text-xs text-slate-500">{lastSuccessfulPxSearch?.searchedAt || ""}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Current activity</p>
              <p className="mt-2 text-sm font-semibold text-slate-100">{snapshot.currentActivity}</p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:col-span-2">
          <p className="text-sm font-medium text-slate-100">Current hot-folder targets</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {hotFolderTargets.map((target) => (
              <div key={target.label} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <p className="text-xs uppercase tracking-[0.14em] text-slate-500">{target.label}</p>
                <p className="mt-2 break-all text-sm font-medium text-slate-100">{target.path || "Not configured"}</p>
              </div>
            ))}
          </div>
        </div>
        </SettingsSection>
      ) : null}

      {activeTab === "connection" ? (
        <SettingsSection
          eyebrow="Connection"
          title="Backend And Store"
          description=""
        >
        <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:col-span-2">
          <div>
            <p className="text-sm font-medium text-slate-100">Store login</p>
            <p className="mt-1 text-sm text-slate-400">
              Sign in with the PX store account to load the correct store route and bootstrap token instead of pasting raw machine IDs.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <input
              className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/40"
              value={storeLoginUsername}
              onChange={(event) => setStoreLoginUsername(event.target.value)}
              placeholder="PX username"
              autoComplete="username"
            />
            <input
              className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/40"
              type="password"
              value={storeLoginPassword}
              onChange={(event) => setStoreLoginPassword(event.target.value)}
              placeholder="PX password"
              autoComplete="current-password"
            />
            <button
              type="button"
              disabled={isLoggingInToStore}
              onClick={() => {
                setIsLoggingInToStore(true);
                setStoreLoginError(null);
                setStoreLoginStatus(null);
                void loginReceiverStore(formState.backendUrl, storeLoginUsername, storeLoginPassword)
                  .then(async (payload) => {
                    const scopedRoutes = payload.stores?.length ? payload.stores : payload.routes ?? [];
                    const nextMachineId =
                      scopedRoutes.find((route) => routeMatchesMachineId(route, formState.machineId))
                        ? formState.machineId
                        : routeMachineId(scopedRoutes[0]) || formState.machineId;
                    setStoreRouteScope(scopedRoutes.map((route) => route.storeKey).filter((value): value is string => Boolean(value)));
                    const nextSettings: WorkerSettings = {
                      ...formState,
                      apiToken: payload.token,
                      machineAuthToken: "",
                      machineId: nextMachineId,
                      useMockBackend: false,
                    };
                    setFormState(nextSettings);
                    applyStoreScopedRoutes(payload, nextMachineId);
                    setStoreLoginPassword("");
                    setStoreLoginStatus(
                      `Signed in as ${payload.user.displayName}${payload.user.location ? ` · ${payload.user.location}` : ""}.`
                    );
                    await updateSettings(nextSettings);
                  })
                  .catch((error: unknown) => {
                    setStoreLoginError(error instanceof Error ? error.message : "PX store login failed.");
                  })
                  .finally(() => {
                    setIsLoggingInToStore(false);
                  });
              }}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-cyan-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoggingInToStore ? "Signing in..." : "Use store login"}
            </button>
          </div>
          {storeLoginStatus ? <p className="text-xs text-emerald-700">{storeLoginStatus}</p> : null}
          {storeLoginError ? <p className="text-xs text-rose-600">{storeLoginError}</p> : null}
        </div>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Backend API URL</span>
          <input className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none ring-0 transition focus:border-cyan-400/40" value={formState.backendUrl} onChange={(event) => updateField("backendUrl", event.target.value)} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Machine name</span>
          <input className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" value={formState.machineName} onChange={(event) => updateField("machineName", event.target.value)} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Scanner mode</span>
          <select
            className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40"
            value={formState.scannerMode || "auto"}
            onChange={(event) => updateField("scannerMode", event.target.value as WorkerSettings["scannerMode"])}
          >
            <option value="auto">Auto detect</option>
            <option value="mac_hid">macOS HID keyboard</option>
            <option value="windows_com">Windows COM scanner</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-slate-200">Store route</span>
            {manualStoreOverrideAllowed ? (
              <button
                type="button"
                onClick={() => setManualStoreOverride((current) => !current)}
                className="text-xs font-medium text-slate-500 transition hover:text-cyan-300"
              >
                {manualStoreOverride ? "Use dropdown" : "Enter manually"}
              </button>
            ) : null}
          </div>

          {manualStoreOverride || routes.length === 0 ? (
            <input
              className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40"
              value={formState.machineId}
              onChange={(event) => updateField("machineId", event.target.value)}
              placeholder="Machine ID"
            />
          ) : (
            <select
              className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40"
              value={routes.find((route) => routeMatchesMachineId(route, formState.machineId))?.storeId ?? ""}
              onChange={(event) => {
                const selectedRoute = routes.find((route) => route.storeId === event.target.value);
                updateField("machineId", selectedRoute ? routeMachineId(selectedRoute) : event.target.value);
              }}
            >
              <option value="" disabled>
                Select a store route
              </option>
              {routes.map((route) => (
                <option key={`${route.source}-${route.storeId}`} value={route.storeId}>
                  {route.label}{route.defaultMachineId ? ` · ${route.defaultMachineId}` : ""}
                </option>
              ))}
            </select>
          )}

          {isLoadingRoutes ? <p className="text-xs text-slate-500">Loading available store routes...</p> : null}
          {routeError ? <p className="text-xs text-rose-600">{routeError}</p> : null}
          {!routeError && !manualStoreOverride ? (
            <p className="text-xs text-slate-500">The selected route applies its PX default machine ID automatically.</p>
          ) : null}
        </div>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">API token</span>
          <input className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="password" value={formState.apiToken} onChange={(event) => updateField("apiToken", event.target.value)} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">ShipStation API key</span>
          <input
            className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40"
            type="password"
            value={formState.shipstationApiKey}
            onChange={(event) => updateField("shipstationApiKey", event.target.value)}
          />
        </label>

        <label className="space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-slate-200">Slack webhook URL</span>
          <input
            className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/40"
            type="password"
            value={formState.slackWebhookUrl ?? ""}
            onChange={(event) => updateField("slackWebhookUrl", event.target.value)}
            placeholder="https://hooks.slack.com/services/..."
          />
          <p className="text-xs text-slate-500">Used only for order-level receive or print failures.</p>
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Polling interval (seconds)</span>
          <input className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="number" min={5} max={300} value={formState.pollingIntervalSeconds} onChange={(event) => updateField("pollingIntervalSeconds", Number(event.target.value))} />
        </label>

        </SettingsSection>
      ) : null}

      {activeTab === "printing" ? (
        <SettingsSection
          eyebrow="Printing"
          title="Output Printers"
          description=""
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
      ) : null}

      {activeTab === "storage" ? (
        <SettingsSection
          eyebrow="Storage"
          title="Downloads And Hot Folders"
          description=""
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
      ) : null}

      {activeTab === "large_format" ? (
        <SettingsSection
          eyebrow="Large Format"
          title="Hot-Folder Batching"
          description="Standalone large-format workflow for Lustre prints only. Incoming files are treated as already sized. The worker scans separate Photo Zone and PostSnap local hot folders into one shared queue, batches waiting images, generates a combined PDF, and can either send approved output into the large-format hot folder or print directly via macOS. ICC/profile handling stays downstream in the Canon/macOS preset workflow, not in PX-Receiver."
        >
        <FolderField
          label="Photo Zone Large Format Hot Folder"
          value={formState.largeFormatPhotozoneInputFolderPath}
          onChange={(value) => updateField("largeFormatPhotozoneInputFolderPath", value)}
          placeholder="Photo Zone large-format input folder"
          onOpen={openConfiguredFolder}
        />

        <FolderField
          label="PostSnap Large Format Hot Folder"
          value={formState.largeFormatPostsnapInputFolderPath}
          onChange={(value) => updateField("largeFormatPostsnapInputFolderPath", value)}
          placeholder="PostSnap large-format input folder"
          onOpen={openConfiguredFolder}
        />

        <FolderField
          label="Large Format output folder"
          value={formState.largeFormatOutputFolderPath}
          onChange={(value) => updateField("largeFormatOutputFolderPath", value)}
          placeholder="Generated combined PDFs are written here"
          onOpen={openConfiguredFolder}
        />

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Batching interval (minutes)</span>
          <input className="min-w-0 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="number" min="1" value={formState.largeFormatBatchingIntervalMinutes} onChange={(event) => updateField("largeFormatBatchingIntervalMinutes", Number(event.target.value))} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Roll width (in)</span>
          <input className="min-w-0 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="number" step="0.1" value={formState.largeFormatRollWidthIn} onChange={(event) => updateField("largeFormatRollWidthIn", Number(event.target.value))} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Gap between prints (mm)</span>
          <input className="min-w-0 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="number" step="0.1" value={formState.largeFormatGapMm} onChange={(event) => updateField("largeFormatGapMm", Number(event.target.value))} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Leader allowance (mm)</span>
          <input className="min-w-0 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="number" step="0.1" value={formState.largeFormatLeaderMm} onChange={(event) => updateField("largeFormatLeaderMm", Number(event.target.value))} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Trailer allowance (mm)</span>
          <input className="min-w-0 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="number" step="0.1" value={formState.largeFormatTrailerMm} onChange={(event) => updateField("largeFormatTrailerMm", Number(event.target.value))} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Left margin (mm)</span>
          <input className="min-w-0 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="number" step="0.1" min="0" value={formState.largeFormatLeftMarginMm} onChange={(event) => updateField("largeFormatLeftMarginMm", Number(event.target.value))} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Max batch length (mm)</span>
          <input className="min-w-0 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="number" step="1" min="1" value={formState.largeFormatMaxBatchLengthMm} onChange={(event) => updateField("largeFormatMaxBatchLengthMm", Number(event.target.value))} />
          <p className="text-xs leading-5 text-slate-500">Default is 1750 mm, roughly capped around two A1 pieces plus spacing, to keep guillotine finishing manageable.</p>
        </label>

        <PrinterField
          label="Large Format printer"
          value={formState.largeFormatPrinterName}
          emptyOptionLabel="Choose a printer"
          printers={printers}
          isLoadingPrinters={isLoadingPrinters}
          onChange={(value) => updateField("largeFormatPrinterName", value)}
          onRefresh={() => {
            void loadPrinters();
          }}
        />

        <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-200">
          <input type="checkbox" checked={formState.largeFormatAutoApproveEnabled} onChange={(event) => updateField("largeFormatAutoApproveEnabled", event.target.checked)} />
          Auto-approve batches when waste is below the threshold
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Auto-approve max waste (%)</span>
          <input className="min-w-0 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="number" step="0.1" value={formState.largeFormatAutoApproveMaxWastePercent} onChange={(event) => updateField("largeFormatAutoApproveMaxWastePercent", Number(event.target.value))} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Edge border thickness (mm)</span>
          <input className="min-w-0 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="number" step="0.1" value={formState.largeFormatEdgeBorderMm} onChange={(event) => updateField("largeFormatEdgeBorderMm", Number(event.target.value))} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Filename caption reserve (mm)</span>
          <input className="min-w-0 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="number" step="0.1" value={formState.largeFormatFilenameCaptionHeightMm} onChange={(event) => updateField("largeFormatFilenameCaptionHeightMm", Number(event.target.value))} />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-slate-200">Filename caption font size (pt)</span>
          <input className="min-w-0 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40" type="number" step="0.5" value={formState.largeFormatFilenameCaptionFontSizePt} onChange={(event) => updateField("largeFormatFilenameCaptionFontSizePt", Number(event.target.value))} />
        </label>

        <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-200">
          <input type="checkbox" checked={formState.largeFormatAutoSend} onChange={(event) => updateField("largeFormatAutoSend", event.target.checked)} />
          Auto-send approved large-format batches
        </label>

        <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-200">
          <input type="checkbox" checked={formState.largeFormatDirectPrint} onChange={(event) => updateField("largeFormatDirectPrint", event.target.checked)} />
          Direct print instead of hot folder
        </label>

        <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-200">
          <input type="checkbox" checked={formState.largeFormatAutoBorderIfLightEdge} onChange={(event) => updateField("largeFormatAutoBorderIfLightEdge", event.target.checked)} />
          Add a 1 mm black border when the image edge is white/off-white
        </label>

        <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-200">
          <input type="checkbox" checked={formState.largeFormatPrintFilenameCaptions} onChange={(event) => updateField("largeFormatPrintFilenameCaptions", event.target.checked)} />
          Print the filename beneath each image
        </label>
        </SettingsSection>
      ) : null}
    </form>
  );
}
