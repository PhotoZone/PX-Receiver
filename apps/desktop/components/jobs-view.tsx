"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Check, MapPin, Printer, Search, Tag, X } from "lucide-react";
import { formatReceiverJobRoute, formatReceiverJobSource, inferReceiverJobSource } from "@/lib/receiver-contract";
import { openPathInOs, searchReceiverOrders, toAssetUrl, toAuthenticatedAssetUrl, toLocalAssetPreviewUrl } from "@/lib/tauri";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { cn, formatDateTime } from "@/lib/utils";
import type { AssetRecord, JobItemRecord, JobRecord, JobStatus } from "@/types/app";
import { StatusBadge } from "@/components/status-badge";

const filters: Array<JobStatus | "all"> = ["all", "pending", "downloading", "downloaded", "processing", "completed", "failed"];
const finishKeywords = ["gloss", "glossy", "lustre", "luster", "matte", "matt", "satin", "silk", "pearl", "metallic"];
const borderKeywords = ["borderless", "white border", "black border", "no border", "mirror border", "thin border", "full border"];
const imageExtensionPattern = /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i;
const remoteUrlPattern = /^(https?:|data:|blob:)/i;

function normalizeFinish(value?: string | null) {
  const normalized = (value || "").trim().toLowerCase().replace(/\s*[-–—]+\s*$/, "");
  switch (normalized) {
    case "gloss":
    case "glossy":
      return "Glossy";
    case "lustre":
    case "luster":
      return "Lustre";
    case "matte":
    case "matt":
      return "Matte";
    case "satin":
      return "Satin";
    case "silk":
      return "Silk";
    case "pearl":
      return "Pearl";
    case "metallic":
      return "Metallic";
    default:
      return value?.trim() || null;
  }
}

function toTitleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function extractMatch(source: string, patterns: string[]) {
  for (const pattern of patterns) {
    const match = source.match(new RegExp(`\\b${pattern.replace(/\s+/g, "\\s+")}\\b`, "i"));
    if (match) {
      return toTitleCase(match[0]);
    }
  }

  return null;
}

function inferFallbackItem(job: JobRecord): JobItemRecord {
  const raw = job.productName.trim();
  const finish = normalizeFinish(extractMatch(raw, finishKeywords));
  const explicitBorder = raw.match(/border\s*:\s*([^,|/;]+)/i)?.[1]?.trim() ?? null;
  const border = explicitBorder ? toTitleCase(explicitBorder) : extractMatch(raw, borderKeywords);
  const name = raw
    .replace(/\(([^)]*)\)/g, " ")
    .replace(/finish\s*:\s*[^,|/;]+/gi, " ")
    .replace(/border\s*:\s*[^,|/;]+/gi, " ")
    .replace(new RegExp(`\\b(${finishKeywords.join("|")})\\b`, "gi"), " ")
    .replace(/\b(borderless|white border|black border|no border|mirror border|thin border|full border)\b/gi, " ")
    .replace(/\s*[-|/,:;]\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return {
    name: name || raw || "Item",
    quantity: 1,
    finish,
    border,
  };
}

function getDisplayItems(job: JobRecord) {
  const items = job.items.length > 0 ? job.items : [inferFallbackItem(job)];
  return items.map((item) => ({
    ...item,
    finish: normalizeFinish(item.finish),
  }));
}

function getFilterLabel(filter: JobStatus | "all") {
  if (filter === "all") {
    return "All";
  }

  if (filter === "pending") {
    return "Awaiting Download";
  }

  if (filter === "processing") {
    return "Printing";
  }

  return toTitleCase(filter);
}

function getRemoteLoadLabel(job: JobRecord) {
  if (job.status === "completed") {
    return "Load Completed Order";
  }

  return "Load from PX";
}

function getSourceBadgeClass(job: JobRecord) {
  switch (inferReceiverJobSource(job)) {
    case "photozone":
      return "border-blue-500/20 bg-blue-500/10 text-blue-100";
    case "pzpro":
      return "border-rose-500/20 bg-rose-500/10 text-rose-100";
    case "wink":
      return "border-amber-500/20 bg-amber-500/10 text-amber-100";
    default:
      return "border-white/10 bg-white/[0.04] text-slate-300";
  }
}

function formatAssetLabel(asset: AssetRecord) {
  const filename = asset.filename.trim();
  const normalized = filename.toLowerCase();
  if (normalized === "condition.txt") {
    return "Fuji Condition";
  }
  if (asset.kind === "pdf") {
    return "Packing Slip";
  }

  return filename;
}

function shouldDisplayAsset(asset: AssetRecord) {
  return asset.filename.trim().toLowerCase() !== "end.txt";
}

function formatAssetKindLabel(asset: AssetRecord) {
  const filename = asset.filename.trim().toLowerCase();
  if (filename === "condition.txt") {
    return "control";
  }

  return asset.kind;
}

function getPxOrderUrl(job: JobRecord, backendUrl: string) {
  const match = job.id.match(/-order-(\d+)$/);
  if (!match) {
    return null;
  }

  const base = backendUrl.trim().replace(/\/+$/, "");
  if (!base) {
    return null;
  }

  return `${base}/orders/${match[1]}/`;
}

function formatDeliveryMethod(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "wink collection") {
    return "Studio";
  }

  return value || "Not provided";
}

function renderCustomerName(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "Unknown customer";
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    return trimmed;
  }

  const surname = parts.pop()!;
  const firstNames = parts.join(" ");

  return (
    <>
      {firstNames} <strong className="font-semibold text-slate-100">{surname}</strong>
    </>
  );
}

function formatOrderDateParts(value?: string | null) {
  if (!value) {
    return { time: "Never", date: "" };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { time: value, date: "" };
  }

  return {
    time: new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date),
    date: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
    }).format(date),
  };
}

function looksLikeImage(value?: string | null) {
  return Boolean(value && imageExtensionPattern.test(value));
}

function isRemoteUrl(value?: string | null) {
  return Boolean(value && remoteUrlPattern.test(value));
}

function isImageContentType(value?: string | null) {
  return Boolean(value && value.toLowerCase().startsWith("image/"));
}

function assetSupportsThumbnail(asset: AssetRecord) {
  return asset.kind === "image"
    || Boolean(asset.thumbnailPath)
    || isImageContentType(asset.contentType)
    || looksLikeImage(asset.filename)
    || looksLikeImage(asset.localPath)
    || looksLikeImage(asset.downloadUrl);
}

function getImageAsset(job: JobRecord, index: number) {
  const thumbnailAssets = job.assets.filter(assetSupportsThumbnail);
  return thumbnailAssets[index] ?? thumbnailAssets[0] ?? null;
}

function getThumbnailCandidates(job: JobRecord, item: JobItemRecord, asset: AssetRecord | null) {
  const directCandidates = [
    asset?.thumbnailPath,
    asset?.localPath,
    asset ? job.localPaths[asset.filename] ?? null : null,
    item.imageUrl,
    asset?.downloadUrl,
  ];

  const fallbackCandidates = job.assets
    .filter(assetSupportsThumbnail)
    .flatMap((entry) => [entry.thumbnailPath, entry.localPath, job.localPaths[entry.filename] ?? null, entry.downloadUrl]);

  return [...directCandidates, ...fallbackCandidates].filter((value, index, values): value is string => {
    if (!value) {
      return false;
    }

    if (!looksLikeImage(value) && !isRemoteUrl(value)) {
      return false;
    }

    return values.indexOf(value) === index;
  });
}

function AssetThumbnail({
  job,
  item,
  asset,
  authToken,
}: {
  job: JobRecord;
  item: JobItemRecord;
  asset: AssetRecord | null;
  authToken?: string | null;
}) {
  const [sources, setSources] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isResolving, setIsResolving] = useState(false);

  useEffect(() => {
    let mounted = true;
    const candidates = getThumbnailCandidates(job, item, asset);
    setSources(candidates);
    setActiveIndex(0);
    if (candidates.length === 0) {
      setIsResolving(false);
      return () => {
        mounted = false;
      };
    }
    return () => {
      mounted = false;
    };
  }, [asset?.downloadUrl, asset?.filename, asset?.localPath, asset?.thumbnailPath, authToken, item.imageUrl, job]);

  const candidate = sources[activeIndex] ?? null;
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    if (!candidate) {
      setResolvedSrc(null);
      setIsResolving(false);
      return () => {
        mounted = false;
      };
    }

    setIsResolving(true);
    void (async () => {
      try {
        const next = isRemoteUrl(candidate)
          ? await toAuthenticatedAssetUrl(candidate, authToken)
          : await toLocalAssetPreviewUrl(candidate);
        if (!mounted) {
          return;
        }
        setResolvedSrc(next);
      } catch {
        if (!mounted) {
          return;
        }
        setResolvedSrc(null);
        setActiveIndex((current) => current + 1);
      } finally {
        if (mounted) {
          setIsResolving(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [candidate, authToken]);

  if (!resolvedSrc && isResolving) {
    return <div className="h-14 w-14 animate-pulse rounded-xl border border-white/10 bg-white/10" />;
  }

  if (!resolvedSrc) {
    return (
      <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-[10px] font-semibold text-slate-500">
        No Image
      </div>
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt={item.name}
      className="h-14 w-14 rounded-xl border border-white/10 object-cover"
      onError={() => {
        setResolvedSrc(null);
        setActiveIndex((current) => current + 1);
      }}
    />
  );
}

function ItemList({ items }: { items: JobItemRecord[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, index) => (
        <li key={`${item.name}-${index}`} className="flex items-center gap-2.5">
          <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-1.5 text-[11px] font-semibold text-slate-200">
            {item.quantity}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-[13px] font-medium text-slate-100">{item.name}</p>
              {item.finish || (item.border && item.border.toLowerCase() !== "borderless") ? (
                <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                  {item.finish ? <span className="crm-pill crm-pill--finish">{item.finish}</span> : null}
                  {item.border && item.border.toLowerCase() !== "borderless" ? <span className="crm-pill crm-pill--border">{item.border}</span> : null}
                </div>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function OrderDetailModal({
  job,
  onClose,
  assetAuthToken,
  backendUrl,
}: {
  job: JobRecord;
  onClose: () => void;
  assetAuthToken?: string | null;
  backendUrl: string;
}) {
  const items = getDisplayItems(job);
  const visibleAssets = job.assets.filter(shouldDisplayAsset);
  const pxOrderUrl = getPxOrderUrl(job, backendUrl);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-6" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-[2rem] border border-white/10 bg-[#08111c] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Order Detail</p>
            <h3 className="mt-2 text-2xl font-semibold text-slate-100">Order {job.orderId}</h3>
            <p className="mt-2 text-sm text-slate-400">
              {renderCustomerName(job.customerName)} · {formatDeliveryMethod(job.deliveryMethod)}
            </p>
            <p className="mt-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{formatReceiverJobSource(job)}</p>
            {formatReceiverJobRoute(job) ? <p className="mt-2 text-xs text-slate-500">{formatReceiverJobRoute(job)}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            {pxOrderUrl ? (
              <button
                type="button"
                onClick={() => {
                  void openPathInOs(pxOrderUrl);
                }}
                className="inline-flex items-center rounded-2xl border border-white/10 px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/[0.04]"
              >
                Open in PX
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-2xl border border-white/10 p-3 text-slate-400 transition hover:bg-white/[0.04]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="grid max-h-[calc(90vh-88px)] gap-6 overflow-y-auto p-6 xl:grid-cols-[1.55fr,0.95fr]">
          <section className="space-y-6">
            <article className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Items</p>
              <div className="mt-4 space-y-4">
                {items.map((item, index) => (
                  <div key={`${item.name}-${index}`} className="flex items-start gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <AssetThumbnail job={job} item={item} asset={getImageAsset(job, index)} authToken={assetAuthToken} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-base font-semibold text-slate-100">{item.name}</p>
                          <p className="mt-1 text-sm text-slate-400">Quantity {item.quantity}</p>
                        </div>
                        {item.finish || (item.border && item.border.toLowerCase() !== "borderless") ? (
                          <div className="flex flex-wrap gap-2">
                            {item.finish ? <span className="crm-pill crm-pill--finish">{item.finish}</span> : null}
                            {item.border && item.border.toLowerCase() !== "borderless" ? <span className="crm-pill crm-pill--border">{item.border}</span> : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </section>

          <aside className="space-y-6">
            <article className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Files</p>
              <div className="mt-4 space-y-2.5">
                {visibleAssets.length === 0 ? (
                  <p className="text-sm text-slate-500">No files attached.</p>
                ) : (
                  visibleAssets.map((asset) => (
                    <button
                      key={asset.id}
                      type="button"
                      disabled={!asset.localPath}
                      onClick={() => {
                        if (asset.localPath) {
                          const normalized = asset.localPath.replace(/\\/g, "/");
                          const folderPath = normalized.includes("/")
                            ? normalized.slice(0, normalized.lastIndexOf("/")) || normalized
                            : normalized;
                          void openPathInOs(folderPath);
                        }
                      }}
                      className="block w-full rounded-2xl border border-white/10 px-3 py-2.5 text-left transition hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-100">{formatAssetLabel(asset)}</p>
                          <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-slate-500">{formatAssetKindLabel(asset)}</p>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </article>

            <article className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Order Summary</p>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <div className="flex items-center justify-between gap-4">
                  <span>Order Placed</span>
                  <span>{formatDateTime(job.orderedAt || job.createdAt)}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Order Downloaded</span>
                  <span>{formatDateTime(job.updatedAt)}</span>
                </div>
                {job.status === "completed" ? (
                  <div className="flex items-center justify-between gap-4">
                    <span>Order Completed</span>
                    <span>{formatDateTime(job.updatedAt)}</span>
                  </div>
                ) : null}
                {job.lastError ? (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-900">
                    <p className="text-xs uppercase tracking-[0.14em] text-rose-700">Last Error</p>
                    <p className="mt-2 text-sm">{job.lastError}</p>
                  </div>
                ) : null}
              </div>
            </article>
          </aside>
        </div>
      </div>
    </div>
  );
}

function JobRow({
  job,
  isPending,
  showSourceColumn,
  reprintJob,
  printPackingSlip,
  printLabel,
  forceCompleteJob,
  onOpen,
}: {
  job: JobRecord;
  isPending: boolean;
  showSourceColumn: boolean;
  reprintJob: (jobId: string) => void;
  printPackingSlip: (jobId: string) => void;
  printLabel: (jobId: string) => void;
  forceCompleteJob: (jobId: string) => void;
  onOpen: () => void;
}) {
  const items = getDisplayItems(job);
  const orderedAt = formatOrderDateParts(job.orderedAt || job.createdAt);
  const canReprint = ["completed", "downloaded", "processing", "failed"].includes(job.status) && !isPending;
  const canPrintPackingSlip = job.assets.some((asset) => asset.kind === "pdf" && Boolean(asset.localPath)) && !isPending;
  const canPrintLabel = Boolean(job.shipmentId || job.orderId) && !isPending;
  const hasCachedLabel = Boolean(job.shippingLabelPath);
  const canForceComplete = job.status === "processing" && !isPending;

  return (
    <tr className="cursor-pointer border-t border-white/10 align-top transition hover:bg-white/[0.03]" onClick={onOpen}>
      <td className="px-4 py-3 text-[13px] font-semibold text-slate-100">
        <div className="space-y-2">
          <p>{job.orderId}</p>
          {canPrintPackingSlip ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                printPackingSlip(job.id);
              }}
              className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-300 transition hover:border-white/20 hover:bg-white/[0.08]"
            >
              Packing Slip
            </button>
          ) : null}
        </div>
      </td>
      {showSourceColumn ? (
        <td className="px-4 py-3 text-[13px] text-slate-300">
          <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]", getSourceBadgeClass(job))}>
            {formatReceiverJobSource(job)}
          </span>
        </td>
      ) : null}
      <td className="whitespace-nowrap px-4 py-3 text-[13px] text-slate-300">
        <div className="space-y-1">
          <p className="font-semibold text-slate-100">{orderedAt.time}</p>
          {orderedAt.date ? <p className="text-xs text-slate-500">{orderedAt.date}</p> : null}
        </div>
      </td>
      <td className="px-4 py-3 text-[13px] text-slate-300">{renderCustomerName(job.customerName)}</td>
      <td className="min-w-[320px] px-4 py-3">
        <ItemList items={items} />
      </td>
      <td className="px-4 py-3 text-[13px] text-slate-300">{formatDeliveryMethod(job.deliveryMethod)}</td>
      <td className="px-4 py-3">
        <StatusBadge value={job.status} kind="job" />
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!canReprint}
            title="Reprint"
            onClick={(event) => {
              event.stopPropagation();
              reprintJob(job.id);
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-slate-300 transition hover:border-white/20 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Printer className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={!canPrintLabel}
            title={hasCachedLabel ? "Reprint Label" : "Print Label"}
            onClick={(event) => {
              event.stopPropagation();
              printLabel(job.id);
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-slate-300 transition hover:border-white/20 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Tag className="h-4 w-4" />
          </button>
          {canForceComplete ? (
            <button
              type="button"
              title="Mark Complete"
              onClick={(event) => {
                event.stopPropagation();
                forceCompleteJob(job.id);
              }}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-slate-300 transition hover:border-white/20 hover:bg-white/[0.06]"
            >
              <Check className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

export function JobsView({
  queueLabel = "Wink",
  queueDescription = "Assigned orders waiting to be downloaded, printed, completed, or recovered.",
  sourceFilter,
}: {
  queueLabel?: string;
  queueDescription?: string;
  sourceFilter?: string | null;
}) {
  const { snapshot, recentJobs, reprintJob, recoverRemoteJob, printPackingSlip, printLabel, forceCompleteJob, isPending } = useWorkerStoreContext();
  const [statusFilter, setStatusFilter] = useState<JobStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [remoteMatches, setRemoteMatches] = useState<JobRecord[]>([]);
  const [isSearchingRemote, setIsSearchingRemote] = useState(false);
  const [remoteSearchError, setRemoteSearchError] = useState<string | null>(null);
  const [autoRecoveredRemoteKey, setAutoRecoveredRemoteKey] = useState<string | null>(null);
  const [recoveringRemoteJobId, setRecoveringRemoteJobId] = useState<string | null>(null);
  const [remoteRecoveryError, setRemoteRecoveryError] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();

  const searchableJobs = useMemo(() => {
    return recentJobs.filter((job) => {
      if (sourceFilter && inferReceiverJobSource(job) !== sourceFilter.toLowerCase()) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      const haystack = [
        job.orderId,
        job.customerName ?? "",
        job.customerEmail ?? "",
        job.deliveryMethod ?? "",
        job.productName,
        job.lastError ?? "",
        job.shippingAddressLine1 ?? "",
        job.shippingPostcode ?? "",
        ...getDisplayItems(job).flatMap((item) => [item.name, item.finish ?? "", item.border ?? ""]),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [recentJobs, normalizedQuery, sourceFilter]);

  const jobs = useMemo(() => {
    return searchableJobs.filter((job) => {
      if (statusFilter === "all") {
        return normalizedQuery ? true : job.status !== "completed";
      }

      if (job.status !== statusFilter) {
        return false;
      }
      return true;
    });
  }, [searchableJobs, statusFilter]);

  const filterCounts = useMemo(() => {
    return filters.reduce<Record<JobStatus | "all", number>>(
      (counts, filter) => {
        counts[filter] = filter === "all"
          ? searchableJobs.filter((job) => normalizedQuery ? true : job.status !== "completed").length
          : searchableJobs.filter((job) => job.status === filter).length;
        return counts;
      },
      {
        all: 0,
        pending: 0,
        downloading: 0,
        downloaded: 0,
        processing: 0,
        completed: 0,
        failed: 0,
      },
    );
  }, [normalizedQuery, searchableJobs]);

  const selectedJob = useMemo(
    () => recentJobs.find((job) => job.id === selectedJobId) ?? null,
    [recentJobs, selectedJobId],
  );
  const assetAuthToken = snapshot.settings.machineAuthToken || snapshot.settings.apiToken || null;
  const showSourceColumn = !sourceFilter;

  const handleRecoverRemoteJob = async (job: JobRecord) => {
    if (job.status === "completed") {
      setStatusFilter("completed");
    } else if (statusFilter === "completed") {
      setStatusFilter("all");
    }
    setRecoveringRemoteJobId(job.id);
    setRemoteRecoveryError(null);
    try {
      const nextSnapshot = await recoverRemoteJob(job);
      const recoveredJob = nextSnapshot.jobs.find((item) => item.id === job.id);
      if (recoveredJob?.lastError) {
        setRemoteRecoveryError(recoveredJob.lastError);
      }
      setSelectedJobId(job.id);
    } catch (error: unknown) {
      setRemoteRecoveryError(error instanceof Error ? error.message : "PX recovery failed.");
    } finally {
      setRecoveringRemoteJobId(null);
    }
  };

  useEffect(() => {
    let active = true;

    if (!normalizedQuery || searchableJobs.length > 0) {
      setRemoteMatches([]);
      setRemoteSearchError(null);
      setRemoteRecoveryError(null);
      setIsSearchingRemote(false);
      setAutoRecoveredRemoteKey(null);
      return () => {
        active = false;
      };
    }

    setIsSearchingRemote(true);
    const timeoutId = window.setTimeout(() => {
      void searchReceiverOrders(snapshot.settings, deferredQuery).then((results) => {
        if (!active) {
          return;
        }
        setRemoteMatches(results);
        setRemoteSearchError(null);
        setIsSearchingRemote(false);
      }).catch((error: unknown) => {
        if (!active) {
          return;
        }
        setRemoteMatches([]);
        setRemoteSearchError(error instanceof Error ? error.message : "PX search failed.");
        setIsSearchingRemote(false);
      });
    }, 450);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [deferredQuery, normalizedQuery, searchableJobs.length, snapshot.settings]);

  useEffect(() => {
    if (
      isSearchingRemote
      || remoteSearchError
      || remoteMatches.length !== 1
      || remoteMatches[0]?.status === "completed"
      || searchableJobs.length > 0
    ) {
      return;
    }

    const [job] = remoteMatches;
    const recoveryKey = `${normalizedQuery}:${job.id}`;
    if (autoRecoveredRemoteKey === recoveryKey) {
      return;
    }

    setAutoRecoveredRemoteKey(recoveryKey);
    void handleRecoverRemoteJob(job);
  }, [autoRecoveredRemoteKey, isSearchingRemote, normalizedQuery, remoteMatches, remoteSearchError, searchableJobs.length, statusFilter]);

  const recoveredRemoteJob = recoveringRemoteJobId
    ? recentJobs.find((job) => job.id === recoveringRemoteJobId) ?? remoteMatches.find((job) => job.id === recoveringRemoteJobId) ?? null
    : null;
  const resolvedRecoveryError = remoteRecoveryError || recoveredRemoteJob?.lastError || null;

  return (
    <>
      <div className="space-y-4">
        <section className="rounded-[1.75rem] border border-white/10 bg-[#0c1826]/88 p-4 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{queueLabel}</p>
                <p className="mt-2 text-sm text-slate-400">{queueDescription}</p>
              </div>
            </div>
            <label className="relative mx-auto block w-full max-w-xl">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search order number, customer, item, finish, border, or delivery"
                className="w-full rounded-2xl border border-white/10 bg-white/[0.04] py-3 pl-11 pr-4 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/40"
              />
            </label>

            <div className="flex flex-wrap justify-center gap-2">
              {filters.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setStatusFilter(filter)}
                  className={cn(
                    "rounded-full px-4 py-2 text-sm font-bold transition",
                    statusFilter === filter ? "bg-cyan-500/16 text-white" : "bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]",
                  )}
                >
                  <span className="font-bold">{getFilterLabel(filter)}</span>
                  <span
                    className={cn(
                      "ml-2 inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold",
                      statusFilter === filter ? "bg-white/15 text-white" : "bg-white/[0.08] text-slate-200",
                    )}
                  >
                    {filterCounts[filter]}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#0c1826]/88 shadow-[0_22px_60px_rgba(2,6,23,0.34)]">
          {jobs.length === 0 ? (
            <div className="space-y-4 p-8 text-center text-sm text-slate-400">
              <p>No orders match the current search or filter.</p>
              {normalizedQuery ? (
                <div className="mx-auto max-w-3xl space-y-3 text-left">
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">PX Search</p>
                    {isSearchingRemote ? <p className="mt-2 text-sm text-slate-300">Searching PX for older orders...</p> : null}
                    {!isSearchingRemote && remoteSearchError ? <p className="mt-2 text-sm text-rose-600">{remoteSearchError}</p> : null}
                    {!isSearchingRemote && !remoteSearchError && recoveringRemoteJobId ? (
                      <p className="mt-2 text-sm text-slate-300">
                        {recoveredRemoteJob?.status === "completed" ? "Loading completed PX order..." : "Loading PX order..."}
                      </p>
                    ) : null}
                    {!isSearchingRemote && !remoteSearchError && resolvedRecoveryError ? (
                      <div className="mt-2 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                        {resolvedRecoveryError}
                      </div>
                    ) : null}
                    {!isSearchingRemote && !remoteSearchError && remoteMatches.length === 0 ? (
                      <p className="mt-2 text-sm text-slate-300">No PX matches found for this search.</p>
                    ) : null}
                    {!isSearchingRemote && !remoteSearchError && remoteMatches.length === 1 && remoteMatches[0]?.status !== "completed" && !recoveringRemoteJobId ? (
                      <p className="mt-2 text-sm text-slate-300">Found one PX match. Recovering it now...</p>
                    ) : null}
                    {!isSearchingRemote && !remoteSearchError && remoteMatches.length === 1 && remoteMatches[0]?.status === "completed" ? (
                      <p className="mt-2 text-sm text-slate-300">Found a completed PX order. Load it explicitly to inspect it or trigger a reprint.</p>
                    ) : null}
                    {!isSearchingRemote && !remoteSearchError && remoteMatches.length > 1 ? (
                      <p className="mt-2 text-sm text-slate-300">Multiple PX matches found. Check the status and customer details, then load the correct order.</p>
                    ) : null}
                  </div>
                  {remoteMatches.map((job) => (
                    <div key={`remote-${job.id}`} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 px-4 py-4">
                      <div>
                        <p className="font-semibold text-slate-100">{job.orderId}</p>
                        <p className="mt-1 text-sm text-slate-400">{renderCustomerName(job.customerName)} · {job.productName}</p>
                        <div className="mt-2">
                          <StatusBadge value={job.status} kind="job" />
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={recoveringRemoteJobId === job.id}
                        onClick={() => {
                          void handleRecoverRemoteJob(job);
                        }}
                        className="inline-flex items-center rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-100 transition hover:border-white/20 hover:bg-white/[0.08]"
                      >
                        {recoveringRemoteJobId === job.id ? "Loading..." : getRemoteLoadLabel(job)}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full table-auto">
                <thead className="bg-white/[0.03] text-left">
                  <tr className="text-xs uppercase tracking-[0.16em] text-slate-500">
                    <th className="px-4 py-2.5 font-medium">Order</th>
                    {showSourceColumn ? <th className="px-4 py-2.5 font-medium">Source</th> : null}
                    <th className="px-4 py-2.5 font-medium">Ordered</th>
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium">Items</th>
                    <th className="px-4 py-2.5 font-medium">Delivery</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      isPending={isPending}
                      showSourceColumn={showSourceColumn}
                      reprintJob={reprintJob}
                      printPackingSlip={printPackingSlip}
                      printLabel={printLabel}
                      forceCompleteJob={forceCompleteJob}
                      onOpen={() => setSelectedJobId(job.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {selectedJob ? (
        <OrderDetailModal
          job={selectedJob}
          onClose={() => setSelectedJobId(null)}
          assetAuthToken={assetAuthToken}
          backendUrl={snapshot.settings.backendUrl}
        />
      ) : null}
    </>
  );
}
