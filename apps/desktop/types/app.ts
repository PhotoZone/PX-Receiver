export type HealthState = "healthy" | "paused" | "error" | "offline" | "processing";

export type JobStatus =
  | "pending"
  | "downloading"
  | "downloaded"
  | "processing"
  | "completed"
  | "failed";

export type LogLevel = "info" | "warning" | "error";

export type AssetKind = "image" | "pdf" | "control" | "other";
export type ScannerStatus = "disabled" | "unavailable" | "disconnected" | "connected" | "error";

export type WorkerSettings = {
  backendUrl: string;
  machineId: string;
  machineName: string;
  apiToken: string;
  shipstationApiKey: string;
  slackWebhookUrl?: string;
  scannerMode?: "auto" | "mac_hid" | "windows_com" | "disabled";
  machineAuthToken?: string;
  pollingIntervalSeconds: number;
  downloadDirectory: string;
  hotFolderPath: string;
  photoPrintHotFolderPath: string;
  photoGiftHotFolderPath: string;
  largeFormatHotFolderPath: string;
  largeFormatPhotozoneInputFolderPath: string;
  largeFormatPostsnapInputFolderPath: string;
  largeFormatOutputFolderPath: string;
  largeFormatBatchingIntervalMinutes: number;
  largeFormatRollWidthIn: number;
  largeFormatGapMm: number;
  largeFormatLeaderMm: number;
  largeFormatTrailerMm: number;
  largeFormatLeftMarginMm: number;
  largeFormatMaxBatchLengthMm: number;
  largeFormatAutoSend: boolean;
  largeFormatDirectPrint: boolean;
  largeFormatPrinterName: string;
  largeFormatAutoApproveEnabled: boolean;
  largeFormatAutoApproveMaxWastePercent: number;
  largeFormatAutoBorderIfLightEdge: boolean;
  largeFormatEdgeBorderMm: number;
  largeFormatPrintFilenameCaptions: boolean;
  largeFormatFilenameCaptionHeightMm: number;
  largeFormatFilenameCaptionFontSizePt: number;
  packingSlipPrinterName: string;
  shippingLabelPrinterName: string;
  useMockBackend: boolean;
};

export type LargeFormatJobStatus = "waiting" | "needs_review" | "batched" | "ready" | "failed";
export type LargeFormatBatchStatus = "pending" | "ready" | "approved" | "printing" | "sent" | "failed" | "cancelled";

export type LargeFormatPlacement = {
  jobId: string;
  filename: string;
  xMm: number;
  yMm: number;
  placedWidthMm: number;
  placedHeightMm: number;
  rotated: boolean;
  sortOrder: number;
  addBlackBorder: boolean;
};

export type LargeFormatJob = {
  id: string;
  filename: string;
  originalPath: string;
  widthIn?: number | null;
  heightIn?: number | null;
  mediaType: string;
  quantity: number;
  source: string;
  status: LargeFormatJobStatus;
  createdAt: string;
  updatedAt: string;
  parseSource?: string | null;
  notes?: string | null;
  needsBorder: boolean;
  batchId?: string | null;
};

export type LargeFormatBatch = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: LargeFormatBatchStatus;
  mediaType: string;
  rollWidthIn: number;
  gapMm: number;
  leaderMm: number;
  trailerMm: number;
  captionHeightMm: number;
  usedLengthMm: number;
  wastePercent: number;
  outputPdfPath?: string | null;
  hotFolderSentAt?: string | null;
  notes?: string | null;
  placements: LargeFormatPlacement[];
};

export type LargeFormatActivity = {
  id: string;
  timestamp: string;
  event: string;
  message: string;
  level: LogLevel;
};

export type LargeFormatState = {
  jobs: LargeFormatJob[];
  batches: LargeFormatBatch[];
  activity: LargeFormatActivity[];
  activeBatchId?: string | null;
  lastScanAt?: string | null;
  lastProcessedAt?: string | null;
};

export type InstalledPrinter = {
  name: string;
  isDefault: boolean;
};

export type ReceiverRoute = {
  source: string;
  storeKey?: string | null;
  storeId: string;
  label: string;
  location?: string | null;
  defaultMachineId?: string | null;
};

export type ReceiverRoutesResponse = {
  routes: ReceiverRoute[];
  stores: ReceiverRoute[];
  manualOverrideAllowed: boolean;
};

export type ReceiverStoreLoginResponse = ReceiverRoutesResponse & {
  token: string;
  tokenType: string;
  user: {
    username: string;
    displayName: string;
    location: string;
    storeScope?: string | null;
  };
};

export type AssetRecord = {
  id: string;
  kind: AssetKind;
  filename: string;
  downloadUrl?: string | null;
  contentType?: string | null;
  localPath?: string | null;
  thumbnailPath?: string | null;
};

export type PrintInstructions = {
  autoPrintPdf: boolean;
  printerName?: string | null;
  copies: number;
};

export type JobItemRecord = {
  name: string;
  quantity: number;
  finish?: string | null;
  border?: string | null;
  imageUrl?: string | null;
};

export type ScanRecord = {
  id: string;
  code: string;
  source: string;
  timestamp: string;
  status: string;
  message?: string | null;
  jobId?: string | null;
  orderId?: string | null;
  canReprintLabel?: boolean;
  shippingLabelPath?: string | null;
};

export type ScannerState = {
  status: ScannerStatus;
  port?: string | null;
  lastScanAt?: string | null;
  lastCode?: string | null;
  recentScans: ScanRecord[];
};

export type JobRecord = {
  id: string;
  orderId: string;
  source?: string | null;
  storeId?: string | null;
  targetMachineId?: string | null;
  targetLocation?: string | null;
  orderedAt?: string | null;
  productName: string;
  printer?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  deliveryMethod?: string | null;
  shipmentId?: string | null;
  shippingLabelPath?: string | null;
  shippingAddressLine1?: string | null;
  shippingAddressLine2?: string | null;
  shippingCity?: string | null;
  shippingPostcode?: string | null;
  shippingCountry?: string | null;
  items: JobItemRecord[];
  assets: AssetRecord[];
  status: JobStatus;
  assignedMachine: string;
  localPath?: string | null;
  localPaths: Record<string, string>;
  printInstructions?: PrintInstructions | null;
  lastError?: string | null;
  updatedAt: string;
  createdAt: string;
  attempts: number;
};

export type LogRecord = {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  scope: string;
};

export type WorkerSnapshot = {
  health: HealthState;
  pollingPaused: boolean;
  queueCount: number;
  lastSyncAt?: string | null;
  activeJobId?: string | null;
  currentActivity: string;
  settings: WorkerSettings;
  scanner: ScannerState;
  jobs: JobRecord[];
  logs: LogRecord[];
  largeFormat: LargeFormatState;
};

export type AppUpdateStatus = {
  currentVersion: string;
  latestVersion?: string | null;
  isUpdateAvailable: boolean;
  downloadUrl: string;
  releaseUrl: string;
  message?: string | null;
  checkedAt: string;
};

export type WorkerEvent =
  | { type: "snapshot"; payload: WorkerSnapshot }
  | { type: "log"; payload: LogRecord }
  | { type: "job"; payload: JobRecord }
  | { type: "scan"; payload: ScanRecord }
  | { type: "scanner"; payload: ScannerState }
  | { type: "health"; payload: Pick<WorkerSnapshot, "health" | "pollingPaused" | "activeJobId" | "currentActivity" | "lastSyncAt" | "queueCount"> };
