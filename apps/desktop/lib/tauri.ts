"use client";

import { defaultSnapshot } from "@/lib/defaults";
import type { AppUpdateStatus, InstalledPrinter, JobRecord, ReceiverRoutesResponse, ReceiverStoreLoginResponse, WorkerEvent, WorkerSnapshot, WorkerSettings } from "@/types/app";

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const localAssetPreviewCache = new Map<string, string>();
const authenticatedAssetPreviewCache = new Map<string, string>();
const pxSearchStatusKey = "px:lastSuccessfulSearch";

async function resolveCore() {
  return import("@tauri-apps/api/core");
}

async function resolveEvent() {
  return import("@tauri-apps/api/event");
}

async function resolvePath() {
  return import("@tauri-apps/api/path");
}

export async function getSnapshot(): Promise<WorkerSnapshot> {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("get_worker_snapshot");
}

export async function updateSettings(settings: WorkerSettings) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("update_worker_settings", { settings });
}

export async function pausePolling() {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("pause_worker_polling");
}

export async function resumePolling() {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("resume_worker_polling");
}

export async function pollNow() {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("poll_worker_now");
}

export async function scanLargeFormatNow() {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("scan_large_format_now");
}

export async function processLargeFormatNow() {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("process_large_format_now");
}

export async function approveLargeFormatBatch(batchId: string) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("approve_large_format_batch", { batchId });
}

export async function sendLargeFormatBatch(batchId: string) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("send_large_format_batch", { batchId });
}

export async function regenerateLargeFormatBatch(batchId: string) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("regenerate_large_format_batch", { batchId });
}

export async function removeLargeFormatBatch(batchId: string) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("remove_large_format_batch", { batchId });
}

export async function deleteLargeFormatJob(jobId: string) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("delete_large_format_job", { jobId });
}

export async function retryJob(jobId: string) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("retry_worker_job", { jobId });
}

export async function recoverRemoteJob(job: JobRecord) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("recover_remote_job", { job });
}

export async function reprintJob(jobId: string) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("reprint_worker_job", { jobId });
}

export async function printWorkerPackingSlip(jobId: string) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("print_worker_packing_slip", { jobId });
}

export async function printWorkerLabel(jobId: string) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("print_worker_label", { jobId });
}

export async function reprintWorkerScanLabel(scanId: string) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("reprint_worker_scan_label", { scanId });
}

export async function forceCompleteWorkerJob(jobId: string) {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("force_complete_worker_job", { jobId });
}

export async function restartWorker() {
  if (!isTauri()) {
    return defaultSnapshot;
  }

  const { invoke } = await resolveCore();
  return invoke<WorkerSnapshot>("restart_worker_runtime");
}

export async function relaunchApp() {
  if (!isTauri()) {
    return;
  }

  const { invoke } = await resolveCore();
  await invoke("relaunch_application");
}

export async function downloadLatestAppBuild() {
  if (!isTauri()) {
    return;
  }

  const { invoke } = await resolveCore();
  await invoke("download_latest_app_build");
}

export async function checkForAppUpdate() {
  if (!isTauri()) {
    return null as AppUpdateStatus | null;
  }

  const { invoke } = await resolveCore();
  return invoke<AppUpdateStatus>("check_for_app_update");
}

export async function openPathInOs(path: string) {
  if (!path) {
    return;
  }

  if (!isTauri()) {
    return;
  }

  const { invoke } = await resolveCore();
  await invoke("open_path_in_os", { path });
}

export async function pickFolder(initialPath?: string | null) {
  if (!isTauri()) {
    return null;
  }

  const { invoke } = await resolveCore();
  return invoke<string | null>("pick_folder", { initialPath: initialPath ?? null });
}

export async function getInstalledPrinters() {
  if (!isTauri()) {
    return [] as InstalledPrinter[];
  }

  const { invoke } = await resolveCore();
  return invoke<InstalledPrinter[]>("get_installed_printers");
}

export async function saveBundledScannerDriver() {
  if (!isTauri()) {
    return null;
  }

  const { invoke } = await resolveCore();
  return invoke<string | null>("save_scanner_driver");
}

export async function listenToWorkerEvents(handler: (event: WorkerEvent) => void) {
  if (!isTauri()) {
    return () => undefined;
  }

  const { listen } = await resolveEvent();
  const unlisten = await listen<WorkerEvent>("worker://event", ({ payload }) => handler(payload));
  return unlisten;
}

export async function toAssetUrl(path?: string | null) {
  if (!path) {
    return null;
  }

  if (/^(https?:|data:|blob:)/i.test(path)) {
    return path;
  }

  if (!isTauri()) {
    return path;
  }

  const { convertFileSrc } = await resolveCore();
  return convertFileSrc(path);
}

export async function toLocalAssetPreviewUrl(path?: string | null) {
  if (!path) {
    return null;
  }

  if (/^(https?:|data:|blob:)/i.test(path)) {
    return path;
  }

  const cached = localAssetPreviewCache.get(path);
  if (cached) {
    return cached;
  }

  if (!isTauri()) {
    return path;
  }

  const { invoke } = await resolveCore();
  const preview = await invoke<string>("read_local_asset_preview", { path });
  localAssetPreviewCache.set(path, preview);
  return preview;
}

export async function toAuthenticatedAssetUrl(path?: string | null, token?: string | null) {
  if (!path) {
    return null;
  }

  if (!/^(https?:|data:|blob:)/i.test(path)) {
    return toAssetUrl(path);
  }

  if (!token || !isTauri()) {
    return path;
  }

  const cacheKey = `${token}:${path}`;
  const cached = authenticatedAssetPreviewCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const { invoke } = await resolveCore();
  const cachedPath = await invoke<string>("fetch_asset_preview", { url: path, token });
  const preview = await toAssetUrl(cachedPath);
  if (preview) {
    authenticatedAssetPreviewCache.set(cacheKey, preview);
  }
  return preview;
}

export async function getBundledDriverUrl() {
  const driverFilename = "CH34x_Install_Windows_v3_4.EXE";

  if (!isTauri()) {
    return `/drivers/${driverFilename}`;
  }

  const [{ resolveResource }, { convertFileSrc }] = await Promise.all([resolvePath(), resolveCore()]);
  const resourcePath = await resolveResource(driverFilename);
  return convertFileSrc(resourcePath);
}

async function readErrorDetail(response: Response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  try {
    if (contentType.includes("application/json")) {
      const payload = await response.json() as Record<string, unknown>;
      const detail = payload.detail ?? payload.error ?? payload.message;
      return typeof detail === "string" && detail.trim() ? detail.trim() : null;
    }

    const text = (await response.text()).trim();
    return text || null;
  } catch {
    return null;
  }
}

function describeFetchError(error: unknown) {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message || "Unknown request failure";
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return "Unknown request failure";
}

async function searchReceiverOrdersViaFetch(backendUrl: string, token: string, query: string, machineId?: string) {
  const params = new URLSearchParams({ query });
  if (machineId?.trim()) {
    params.set("machine_id", machineId.trim());
  }

  let response: Response;
  try {
    response = await fetch(`${backendUrl}/api/receiver/orders/search?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    throw new Error(`Failed to search PX orders for "${query}" at ${backendUrl}: ${describeFetchError(error)}`);
  }

  return response;
}

export async function fetchReceiverRoutes(settings: Pick<WorkerSettings, "backendUrl" | "apiToken" | "machineAuthToken" | "useMockBackend">) {
  const backendUrl = settings.backendUrl.trim().replace(/\/+$/, "");
  const token = (settings.machineAuthToken || settings.apiToken || "").trim();
  if (!backendUrl || !token) {
    return { routes: [], stores: [], manualOverrideAllowed: true } satisfies ReceiverRoutesResponse;
  }

  if (isTauri()) {
    const { invoke } = await resolveCore();
    return invoke<ReceiverRoutesResponse>("fetch_receiver_routes_native", { backendUrl, token });
  }

  let response: Response;
  try {
    response = await fetch(`${backendUrl}/api/receiver/routes`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    throw new Error(`Failed to load PX routes from ${backendUrl}: ${describeFetchError(error)}`);
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail
      ? `Failed to load PX routes (${response.status}): ${detail}`
      : `Failed to load PX routes (${response.status})`);
  }

  return response.json() as Promise<ReceiverRoutesResponse>;
}

export async function loginReceiverStore(backendUrl: string, username: string, password: string) {
  const normalizedBackendUrl = backendUrl.trim().replace(/\/+$/, "");
  const normalizedUsername = username.trim();
  if (!normalizedBackendUrl || !normalizedUsername || !password) {
    throw new Error("Backend URL, username, and password are required.");
  }

  if (isTauri()) {
    const { invoke } = await resolveCore();
    return invoke<ReceiverStoreLoginResponse>("login_receiver_store_native", {
      backendUrl: normalizedBackendUrl,
      username: normalizedUsername,
      password,
    });
  }

  let response: Response;
  try {
    response = await fetch(`${normalizedBackendUrl}/api/receiver/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: normalizedUsername, password }),
    });
  } catch (error) {
    throw new Error(`Failed to sign in to PX receiver bootstrap at ${normalizedBackendUrl}: ${describeFetchError(error)}`);
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail
      ? `PX store login failed (${response.status}): ${detail}`
      : `PX store login failed (${response.status})`);
  }

  return response.json() as Promise<ReceiverStoreLoginResponse>;
}

type PxSearchStatus = {
  query: string;
  resultCount: number;
  searchedAt: string;
};

function recordLastSuccessfulPxSearch(query: string, resultCount: number) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(pxSearchStatusKey, JSON.stringify({
    query,
    resultCount,
    searchedAt: new Date().toISOString(),
  } satisfies PxSearchStatus));
}

export function getLastSuccessfulPxSearch(): PxSearchStatus | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(pxSearchStatusKey);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as PxSearchStatus;
  } catch {
    return null;
  }
}

type ReceiverOrderSearchResponse =
  | JobRecord[]
  | {
      results?: JobRecord[];
      jobs?: JobRecord[];
      result?: JobRecord | null;
      job?: JobRecord | null;
    };

type SearchAssetRecord = JobRecord["assets"][number] & {
  download_url?: string | null;
  content_type?: string | null;
  local_path?: string | null;
  thumbnail_path?: string | null;
};

type SearchPrintInstructions = JobRecord["printInstructions"] & {
  auto_print_pdf?: boolean;
  printer_name?: string | null;
};

type SearchJobItemRecord = JobRecord["items"][number] & {
  image_url?: string | null;
};

type SearchJobRecord = Omit<JobRecord, "assets" | "items" | "printInstructions"> & {
  source?: string | null;
  store_id?: string | null;
  target_machine_id?: string | null;
  target_location?: string | null;
  ordered_at?: string | null;
  order_id?: string;
  product_name?: string;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  delivery_method?: string | null;
  shipment_id?: string | null;
  shipping_label_path?: string | null;
  shipping_address_line1?: string | null;
  shipping_address_line2?: string | null;
  shipping_city?: string | null;
  shipping_postcode?: string | null;
  shipping_country?: string | null;
  assigned_machine?: string;
  local_path?: string | null;
  local_paths?: Record<string, string>;
  printInstructions?: SearchPrintInstructions | null;
  print_instructions?: SearchPrintInstructions | null;
  last_error?: string | null;
  updated_at?: string;
  created_at?: string;
  assets: SearchAssetRecord[];
  items: SearchJobItemRecord[];
};

function normalizeSearchAssetRecord(asset: SearchAssetRecord) {
  return {
    ...asset,
    id: asset.id ?? asset.filename ?? "",
    kind: asset.kind ?? "other",
    filename: asset.filename ?? "asset.bin",
    downloadUrl: asset.downloadUrl ?? asset.download_url ?? null,
    contentType: asset.contentType ?? asset.content_type ?? null,
    localPath: asset.localPath ?? asset.local_path ?? null,
    thumbnailPath: asset.thumbnailPath ?? asset.thumbnail_path ?? null,
  };
}

function normalizeSearchJobItemRecord(item: SearchJobItemRecord) {
  return {
    ...item,
    name: item.name ?? "Item",
    quantity: typeof item.quantity === "number" ? item.quantity : 1,
    imageUrl: item.imageUrl ?? item.image_url ?? null,
  };
}

function normalizeSearchPrintInstructions(printInstructions: SearchPrintInstructions | null | undefined) {
  if (!printInstructions) {
    return null;
  }

  return {
    ...printInstructions,
    autoPrintPdf: printInstructions.autoPrintPdf ?? printInstructions.auto_print_pdf ?? false,
    printerName: printInstructions.printerName ?? printInstructions.printer_name ?? null,
    copies: typeof printInstructions.copies === "number" ? printInstructions.copies : 1,
  };
}

function normalizeSearchJobRecord(job: SearchJobRecord): JobRecord {
  return {
    ...job,
    id: job.id ?? "",
    orderId: job.orderId ?? job.order_id ?? "",
    source: job.source ?? null,
    storeId: job.storeId ?? job.store_id ?? null,
    targetMachineId: job.targetMachineId ?? job.target_machine_id ?? null,
    targetLocation: job.targetLocation ?? job.target_location ?? null,
    orderedAt: job.orderedAt ?? job.ordered_at ?? null,
    productName: job.productName ?? job.product_name ?? "",
    customerName: job.customerName ?? job.customer_name ?? null,
    customerEmail: job.customerEmail ?? job.customer_email ?? null,
    customerPhone: job.customerPhone ?? job.customer_phone ?? null,
    deliveryMethod: job.deliveryMethod ?? job.delivery_method ?? null,
    shipmentId: job.shipmentId ?? job.shipment_id ?? null,
    shippingLabelPath: job.shippingLabelPath ?? job.shipping_label_path ?? null,
    shippingAddressLine1: job.shippingAddressLine1 ?? job.shipping_address_line1 ?? null,
    shippingAddressLine2: job.shippingAddressLine2 ?? job.shipping_address_line2 ?? null,
    shippingCity: job.shippingCity ?? job.shipping_city ?? null,
    shippingPostcode: job.shippingPostcode ?? job.shipping_postcode ?? null,
    shippingCountry: job.shippingCountry ?? job.shipping_country ?? null,
    status: job.status ?? "pending",
    assignedMachine: job.assignedMachine ?? job.assigned_machine ?? "",
    localPath: job.localPath ?? job.local_path ?? null,
    localPaths: job.localPaths ?? job.local_paths ?? {},
    printInstructions: normalizeSearchPrintInstructions(job.printInstructions ?? job.print_instructions),
    lastError: job.lastError ?? job.last_error ?? null,
    updatedAt: job.updatedAt ?? job.updated_at ?? "",
    createdAt: job.createdAt ?? job.created_at ?? "",
    attempts: typeof job.attempts === "number" ? job.attempts : 0,
    assets: (job.assets ?? []).map(normalizeSearchAssetRecord),
    items: (job.items ?? []).map(normalizeSearchJobItemRecord),
  };
}

export async function searchReceiverOrders(
  settings: Pick<WorkerSettings, "backendUrl" | "apiToken" | "machineAuthToken" | "useMockBackend" | "machineId">,
  query: string,
) {
  const backendUrl = settings.backendUrl.trim().replace(/\/+$/, "");
  const token = (settings.machineAuthToken || settings.apiToken || "").trim();
  const normalizedQuery = query.trim();
  if (!backendUrl || !token || !normalizedQuery) {
    return [] as JobRecord[];
  }

  let payload: ReceiverOrderSearchResponse;
  if (isTauri()) {
    const { invoke } = await resolveCore();
    payload = await invoke<ReceiverOrderSearchResponse>("search_receiver_orders_native", {
      backendUrl,
      token,
      machineId: settings.machineId,
      query: normalizedQuery,
    });
  } else {
    let response = await searchReceiverOrdersViaFetch(backendUrl, token, normalizedQuery, settings.machineId);

    if (response.status === 404) {
      response = await searchReceiverOrdersViaFetch(backendUrl, token, normalizedQuery);
      if (response.status === 404) {
        return [] as JobRecord[];
      }
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(detail
        ? `Failed to search PX orders (${response.status}): ${detail}`
        : `Failed to search PX orders (${response.status})`);
    }

    payload = (await response.json()) as ReceiverOrderSearchResponse;
  }
  let results: JobRecord[] = [];
  if (Array.isArray(payload)) {
    results = payload.map((job) => normalizeSearchJobRecord(job as SearchJobRecord));
  } else if (Array.isArray(payload.results)) {
    results = payload.results.map((job) => normalizeSearchJobRecord(job as SearchJobRecord));
  } else if (Array.isArray(payload.jobs)) {
    results = payload.jobs.map((job) => normalizeSearchJobRecord(job as SearchJobRecord));
  } else if (payload.result) {
    results = [normalizeSearchJobRecord(payload.result as SearchJobRecord)];
  } else if (payload.job) {
    results = [normalizeSearchJobRecord(payload.job as SearchJobRecord)];
  }

  recordLastSuccessfulPxSearch(normalizedQuery, results.length);
  return results;
}
