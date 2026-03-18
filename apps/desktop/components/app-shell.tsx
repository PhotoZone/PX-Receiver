"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { Download, LoaderCircle, PauseCircle, PlayCircle, RefreshCw, X } from "lucide-react";
import { routeMachineId } from "@/lib/receiver-contract";
import { loginReceiverStore } from "@/lib/tauri";
import { Sidebar } from "@/components/sidebar";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import type { ReceiverRoute, ReceiverStoreLoginResponse, WorkerSettings } from "@/types/app";

type Props = {
  children: React.ReactNode;
};

const PX_BACKEND_URL = "https://px.photozone.co.uk";

function LoginGate({
  settings,
  updateSettings,
  restartWorker,
}: {
  settings: WorkerSettings;
  updateSettings: (settings: WorkerSettings) => Promise<unknown>;
  restartWorker: () => Promise<unknown>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [machineName, setMachineName] = useState(settings.machineName || "PX Receiver");
  const [routes, setRoutes] = useState<ReceiverRoute[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [pendingLogin, setPendingLogin] = useState<ReceiverStoreLoginResponse | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const applyLogin = async (payload: ReceiverStoreLoginResponse, selectedRoute?: ReceiverRoute) => {
    const availableRoutes = payload.stores?.length ? payload.stores : payload.routes ?? [];
    const resolvedRoute = selectedRoute ?? availableRoutes.find((route) => route.storeId === selectedStoreId) ?? availableRoutes[0];
    const nextSettings: WorkerSettings = {
      ...settings,
      backendUrl: PX_BACKEND_URL,
      apiToken: payload.token,
      machineAuthToken: "",
      machineName: machineName.trim() || settings.machineName,
      machineId: resolvedRoute ? routeMachineId(resolvedRoute) : settings.machineId,
      useMockBackend: false,
    };
    await updateSettings(nextSettings);
    await restartWorker();
  };

  const submitCredentials = async () => {
    setIsSubmitting(true);
    setError(null);
    setStatusMessage(null);
    try {
      const payload = await loginReceiverStore(PX_BACKEND_URL, username, password);
      const nextRoutes = payload.stores?.length ? payload.stores : payload.routes ?? [];
      setRoutes(nextRoutes);
      if (nextRoutes.length > 1) {
        setPendingLogin(payload);
        setSelectedStoreId(nextRoutes[0]?.storeId ?? "");
        setPassword("");
        setStatusMessage(`Signed in as ${payload.user.displayName}. Choose the store route for this machine.`);
        return;
      }
      await applyLogin(payload, nextRoutes[0]);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Store login failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const completeRouteSelection = async () => {
    if (!pendingLogin) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const selectedRoute = routes.find((route) => route.storeId === selectedStoreId);
      await applyLogin(pendingLogin, selectedRoute);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Failed to finish receiver setup.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.12),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(16,185,129,0.08),_transparent_24%),linear-gradient(180deg,#06111b_0%,#08131f_46%,#0b1623_100%)] px-6 py-10">
      <div className="absolute inset-0 bg-[linear-gradient(120deg,transparent_0%,rgba(255,255,255,0.03)_35%,transparent_65%)]" />
      <div className="relative w-full max-w-xl rounded-[2rem] border border-white/10 bg-[#0c1826]/92 p-8 shadow-[0_32px_80px_rgba(2,6,23,0.42)] backdrop-blur">
        <div className="flex flex-col items-center text-center">
          <Image
            src="/photozone-logo.png"
            alt="Photo Zone"
            width={240}
            height={72}
            priority
            className="h-auto w-48"
          />
          <p className="mt-6 text-xs uppercase tracking-[0.34em] text-slate-500">Receiver Sign In</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">Connect This Machine</h1>
          <p className="mt-3 max-w-md text-sm leading-6 text-slate-400">
            Sign in with the PX store account, then bind this app to the correct store route for this workstation.
          </p>
        </div>

        <div className="mt-8 space-y-4">
          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-200">Machine Name</span>
            <input
              value={machineName}
              onChange={(event) => setMachineName(event.target.value)}
              className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/40"
            />
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-200">PX Username</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/40"
              />
            </label>
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-200">PX Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/40"
              />
            </label>
          </div>
          {pendingLogin && routes.length > 1 ? (
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-200">Store Route</span>
              <select
                value={selectedStoreId}
                onChange={(event) => setSelectedStoreId(event.target.value)}
                className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400/40"
              >
                {routes.map((route) => (
                  <option key={`${route.storeKey}-${route.storeId}`} value={route.storeId}>
                    {route.label}{route.defaultMachineId ? ` · ${route.defaultMachineId}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {statusMessage ? <p className="mt-4 text-sm text-slate-400">{statusMessage}</p> : null}
        {error ? <p className="mt-4 text-sm text-rose-600">{error}</p> : null}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => void (pendingLogin ? completeRouteSelection() : submitCredentials())}
            className="inline-flex items-center gap-2 rounded-2xl bg-cyan-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            {pendingLogin ? "Finish Setup" : "Sign In"}
          </button>
        </div>
      </div>
    </div>
  );
}

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

function formatHeaderTime(value?: string | null) {
  if (!value) {
    return "No sync yet";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function AppShell({ children }: Props) {
  const pathname = usePathname();
  const { snapshot, appUpdate, isPending, togglePolling, refreshNow, downloadLatestBuild, updateSettings, restartWorker } = useWorkerStoreContext();
  const pageTitle = useMemo(() => getPageTitle(pathname), [pathname]);
  const scansToday = useMemo(() => {
    const today = new Date().toDateString();
    return snapshot.scanner.recentScans.filter((scan) => {
      const timestamp = scan.timestamp ? new Date(scan.timestamp) : null;
      return timestamp && !Number.isNaN(timestamp.getTime()) && timestamp.toDateString() === today;
    }).length;
  }, [snapshot.scanner.recentScans]);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);
  const showUpdateBanner = Boolean(
    appUpdate?.isUpdateAvailable
      && appUpdate.latestVersion
      && appUpdate.latestVersion !== dismissedUpdateVersion,
  );
  const needsLogin = !snapshot.settings.apiToken.trim()
    && !(snapshot.settings.machineAuthToken || "").trim();

  if (needsLogin) {
    return (
      <LoginGate
        settings={snapshot.settings}
        updateSettings={updateSettings}
        restartWorker={restartWorker}
      />
    );
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-h-screen flex-1 flex-col">
        <header className="border-b border-white/10 bg-[#08111c]/70 px-8 py-5 backdrop-blur-xl">
          {showUpdateBanner ? (
            <div className="mb-4 flex items-center justify-between gap-4 rounded-3xl border border-emerald-500/20 bg-emerald-500/10 px-5 py-4">
              <div>
                <p className="text-sm font-semibold text-emerald-100">
                  Update available: {appUpdate?.latestVersion}
                </p>
                <p className="mt-1 text-sm text-emerald-200/80">
                  {appUpdate?.message}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void downloadLatestBuild()}
                  className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-emerald-500"
                >
                  <Download className="h-4 w-4" />
                  Install Update
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedUpdateVersion(appUpdate?.latestVersion ?? null)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-emerald-500/20 text-emerald-100 transition hover:bg-emerald-500/10"
                  title="Dismiss update notice"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : null}
            <div className="flex items-center justify-between gap-6">
              <div>
                <p className="text-[11px] uppercase tracking-[0.32em] text-slate-500">Production console</p>
                <h2 className="mt-2 text-[2rem] font-semibold tracking-tight text-white">{pageTitle}</h2>
              </div>

            <div className="flex items-center gap-4">
              <div className="flex min-w-[5.5rem] flex-col items-end text-right">
                <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Scans today</p>
                <p className="mt-1 min-h-[1.5rem] text-base font-semibold leading-6 text-slate-100">{scansToday}</p>
              </div>

              <div className="flex min-w-[6.5rem] flex-col items-end text-right">
                <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Last sync</p>
                <p className="mt-1 min-h-[1.5rem] text-base font-medium leading-6 text-slate-200">{formatHeaderTime(snapshot.lastSyncAt)}</p>
              </div>

              <button
                type="button"
                onClick={refreshNow}
                title="Refresh now"
                className="inline-flex h-10 min-w-[6.75rem] items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-sm font-medium text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isPending}
              >
                {isPending ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Refresh
              </button>

              <button
                type="button"
                onClick={togglePolling}
                className="inline-flex h-10 min-w-[6.75rem] items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-sm font-medium text-white transition hover:bg-white/10"
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
