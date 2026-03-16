"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Check, MapPin, Printer, Search, Tag, X } from "lucide-react";
import { searchReceiverOrders, toAssetUrl, toAuthenticatedAssetUrl, toLocalAssetPreviewUrl } from "@/lib/tauri";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { cn, formatDateTime } from "@/lib/utils";
import type { AssetRecord, JobItemRecord, JobRecord, JobStatus } from "@/types/app";
import { StatusBadge } from "@/components/status-badge";

const filters: Array<JobStatus | "all"> = ["all", "pending", "downloading", "downloaded", "processing", "completed", "failed"];
const finishKeywords = ["gloss", "glossy", "lustre", "luster", "matte", "matt", "satin", "silk", "pearl", "metallic"];
const borderKeywords = ["borderless", "white border", "black border", "no border", "mirror border", "thin border", "full border"];
const imageExtensionPattern = /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i;
const remoteUrlPattern = /^(https?:|data:|blob:)/i;

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
  const finish = extractMatch(raw, finishKeywords);
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
  return job.items.length > 0 ? job.items : [inferFallbackItem(job)];
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

function formatDeliveryMethod(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "wink collection") {
    return "Studio";
  }

  return value || "Not provided";
}

function inferJobSource(job: Pick<JobRecord, "source" | "orderId" | "deliveryMethod">) {
  const explicit = (job.source || "").trim().toLowerCase();
  if (explicit) {
    return explicit;
  }

  const orderId = (job.orderId || "").trim().toLowerCase();
  const deliveryMethod = (job.deliveryMethod || "").trim().toLowerCase();

  if (orderId.startsWith("w") || deliveryMethod.includes("wink")) {
    return "wink";
  }

  return "";
}

function formatJobSource(job: Pick<JobRecord, "source" | "orderId" | "deliveryMethod">) {
  switch (inferJobSource(job)) {
    case "wink":
      return "Wink";
    case "photo_zone":
      return "Photo Zone";
    case "pzpro":
      return "PZPro";
    default:
      return "Unknown";
  }
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
    return <div className="h-16 w-16 animate-pulse rounded-2xl border border-slate-200 bg-slate-100" />;
  }

  if (!resolvedSrc) {
    return (
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-400">
        No Image
      </div>
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt={item.name}
      className="h-16 w-16 rounded-2xl border border-slate-200 object-cover"
      onError={() => {
        setResolvedSrc(null);
        setActiveIndex((current) => current + 1);
      }}
    />
  );
}

function ItemList({ items }: { items: JobItemRecord[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={`${item.name}-${index}`} className="flex items-center gap-3">
          <span className="inline-flex h-[27px] min-w-[27px] shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-semibold text-slate-700">
            {item.quantity}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-[13px] font-medium text-slate-900">{item.name}</p>
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
}: {
  job: JobRecord;
  onClose: () => void;
  assetAuthToken?: string | null;
}) {
  const items = getDisplayItems(job);
  const isCollectionOrder = job.deliveryMethod?.toLowerCase().includes("collection") ?? false;
  const addressLines = [
    job.shippingAddressLine1,
    job.shippingAddressLine2,
    [job.shippingCity, job.shippingPostcode].filter(Boolean).join(" ").trim() || null,
    job.shippingCountry,
  ].filter(Boolean) as string[];

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
      <div className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-[2rem] bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Order Detail</p>
            <h3 className="mt-2 text-2xl font-semibold text-slate-900">Order {job.orderId}</h3>
            <p className="mt-2 text-sm text-slate-600">
              {job.customerName || "Unknown customer"} · {formatDeliveryMethod(job.deliveryMethod)}
            </p>
            <p className="mt-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{formatJobSource(job)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-2xl border border-slate-200 p-3 text-slate-600 transition hover:bg-slate-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid max-h-[calc(90vh-88px)] gap-6 overflow-y-auto p-6 xl:grid-cols-[1.45fr,0.95fr]">
          <section className="space-y-6">
            <article className="rounded-3xl border border-slate-200 bg-slate-50/60 p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Items</p>
              <div className="mt-4 space-y-4">
                {items.map((item, index) => (
                  <div key={`${item.name}-${index}`} className="flex items-start gap-4 rounded-2xl border border-slate-200 bg-white p-4">
                    <AssetThumbnail job={job} item={item} asset={getImageAsset(job, index)} authToken={assetAuthToken} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-base font-semibold text-slate-900">{item.name}</p>
                          <p className="mt-1 text-sm text-slate-600">Quantity {item.quantity}</p>
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

            <article className="rounded-3xl border border-slate-200 bg-white p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Files</p>
              <div className="mt-4 space-y-3">
                {job.assets.length === 0 ? (
                  <p className="text-sm text-slate-500">No files attached.</p>
                ) : (
                  job.assets.map((asset) => (
                    <div key={asset.id} className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-slate-900">{asset.filename}</p>
                        <p className="mt-1 text-xs uppercase tracking-[0.14em] text-slate-500">{asset.kind}</p>
                      </div>
                      <p className="max-w-sm truncate text-xs text-slate-500">{asset.localPath || asset.downloadUrl || "No local path yet"}</p>
                    </div>
                  ))
                )}
              </div>
            </article>
          </section>

          <aside className="space-y-6">
            <article className="rounded-3xl border border-slate-200 bg-white p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Customer</p>
              <div className="mt-4 space-y-3 text-sm text-slate-700">
                <p className="font-medium text-slate-900">{job.customerName || "Unknown customer"}</p>
                <p>{job.customerEmail || "Email not available"}</p>
                <p>{job.customerPhone || "Phone not available"}</p>
              </div>
            </article>

            <article className="rounded-3xl border border-slate-200 bg-white p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Shipping</p>
              <div className="mt-4 space-y-4 text-sm text-slate-700">
                <div>
                  <p className="font-medium text-slate-900">Requested Method</p>
                  <p className="mt-1">{formatDeliveryMethod(job.deliveryMethod)}</p>
                </div>
                {!isCollectionOrder ? (
                  <div>
                    <div className="flex items-center gap-2 text-slate-900">
                      <MapPin className="h-4 w-4" />
                      <p className="font-medium">Address</p>
                    </div>
                    <div className="mt-2 space-y-1">
                      {addressLines.length > 0 ? addressLines.map((line) => <p key={line}>{line}</p>) : <p>Address details not available in this feed.</p>}
                    </div>
                  </div>
                ) : null}
              </div>
            </article>

            <article className="rounded-3xl border border-slate-200 bg-white p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Order Summary</p>
              <div className="mt-4 space-y-3 text-sm text-slate-700">
                <div className="flex items-center justify-between gap-4">
                  <span>Updated</span>
                  <span>{formatDateTime(job.updatedAt)}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Created</span>
                  <span>{formatDateTime(job.createdAt)}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Attempts</span>
                  <span>{job.attempts}</span>
                </div>
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
  const orderedAt = formatOrderDateParts(job.createdAt);
  const canReprint = ["completed", "downloaded", "processing", "failed"].includes(job.status) && !isPending;
  const canPrintPackingSlip = job.assets.some((asset) => asset.kind === "pdf" && Boolean(asset.localPath)) && !isPending;
  const canPrintLabel = Boolean(job.shipmentId || job.orderId) && !isPending;
  const canForceComplete = job.status === "processing" && !isPending;

  return (
    <tr className="cursor-pointer border-t border-slate-200 align-top transition hover:bg-slate-50/80" onClick={onOpen}>
      <td className="px-4 py-4 text-[13px] font-semibold text-slate-900">
        <div className="space-y-2">
          <p>{job.orderId}</p>
          {canPrintPackingSlip ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                printPackingSlip(job.id);
              }}
              className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-700 transition hover:border-slate-300 hover:bg-white"
            >
              Packing Slip
            </button>
          ) : null}
        </div>
      </td>
      {showSourceColumn ? (
        <td className="px-4 py-4 text-[13px] text-slate-700">
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">
            {formatJobSource(job)}
          </span>
        </td>
      ) : null}
      <td className="whitespace-nowrap px-4 py-4 text-[13px] text-slate-700">
        <div className="space-y-1">
          <p className="font-semibold text-slate-900">{orderedAt.time}</p>
          {orderedAt.date ? <p className="text-xs text-slate-500">{orderedAt.date}</p> : null}
        </div>
      </td>
      <td className="px-4 py-4 text-[13px] text-slate-700">{job.customerName || "Unknown customer"}</td>
      <td className="min-w-[320px] px-4 py-4">
        <ItemList items={items} />
      </td>
      <td className="px-4 py-4 text-[13px] text-slate-700">{formatDeliveryMethod(job.deliveryMethod)}</td>
      <td className="px-4 py-4">
        <StatusBadge value={job.status} kind="job" />
      </td>
      <td className="px-4 py-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!canReprint}
            title="Reprint"
            onClick={(event) => {
              event.stopPropagation();
              reprintJob(job.id);
            }}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Printer className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={!canPrintLabel}
            title="Print Label"
            onClick={(event) => {
              event.stopPropagation();
              printLabel(job.id);
            }}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
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
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
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
      if (sourceFilter && inferJobSource(job) !== sourceFilter.toLowerCase()) {
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

    if (!normalizedQuery || searchableJobs.length > 0 || snapshot.settings.useMockBackend) {
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
        <section className="rounded-3xl border border-white/70 bg-panel p-4 shadow-panel">
          <div className="space-y-4">
            <label className="relative mx-auto block w-full max-w-xl">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search order number, customer, item, finish, border, or delivery"
                className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-11 pr-4 text-sm outline-none transition focus:border-accent"
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
                    statusFilter === filter ? "bg-ink text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200",
                  )}
                >
                  <span className="font-bold">{getFilterLabel(filter)}</span>
                  <span
                    className={cn(
                      "ml-2 inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold",
                      statusFilter === filter ? "bg-white/15 text-white" : "bg-white text-slate-700",
                    )}
                  >
                    {filterCounts[filter]}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-panel">
          {jobs.length === 0 ? (
            <div className="space-y-4 p-8 text-center text-sm text-slate-600">
              <p>No orders match the current search or filter.</p>
              {normalizedQuery ? (
                <div className="mx-auto max-w-3xl space-y-3 text-left">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">PX Search</p>
                    {isSearchingRemote ? <p className="mt-2 text-sm text-slate-600">Searching PX for older orders...</p> : null}
                    {!isSearchingRemote && remoteSearchError ? <p className="mt-2 text-sm text-rose-600">{remoteSearchError}</p> : null}
                    {!isSearchingRemote && !remoteSearchError && recoveringRemoteJobId ? (
                      <p className="mt-2 text-sm text-slate-600">
                        {recoveredRemoteJob?.status === "completed" ? "Loading completed PX order..." : "Loading PX order..."}
                      </p>
                    ) : null}
                    {!isSearchingRemote && !remoteSearchError && resolvedRecoveryError ? (
                      <div className="mt-2 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                        {resolvedRecoveryError}
                      </div>
                    ) : null}
                    {!isSearchingRemote && !remoteSearchError && remoteMatches.length === 0 ? (
                      <p className="mt-2 text-sm text-slate-600">No PX matches found for this search.</p>
                    ) : null}
                    {!isSearchingRemote && !remoteSearchError && remoteMatches.length === 1 && remoteMatches[0]?.status !== "completed" && !recoveringRemoteJobId ? (
                      <p className="mt-2 text-sm text-slate-600">Found one PX match. Recovering it now...</p>
                    ) : null}
                    {!isSearchingRemote && !remoteSearchError && remoteMatches.length === 1 && remoteMatches[0]?.status === "completed" ? (
                      <p className="mt-2 text-sm text-slate-600">Found a completed PX order. Load it explicitly to inspect it or trigger a reprint.</p>
                    ) : null}
                    {!isSearchingRemote && !remoteSearchError && remoteMatches.length > 1 ? (
                      <p className="mt-2 text-sm text-slate-600">Multiple PX matches found. Check the status and customer details, then load the correct order.</p>
                    ) : null}
                  </div>
                  {remoteMatches.map((job) => (
                    <div key={`remote-${job.id}`} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 px-4 py-4">
                      <div>
                        <p className="font-semibold text-slate-900">{job.orderId}</p>
                        <p className="mt-1 text-sm text-slate-600">{job.customerName || "Unknown customer"} · {job.productName}</p>
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
                        className="inline-flex items-center rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
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
                <thead className="bg-slate-50 text-left">
                  <tr className="text-xs uppercase tracking-[0.16em] text-slate-500">
                    <th className="px-4 py-3 font-medium">Order</th>
                    {showSourceColumn ? <th className="px-4 py-3 font-medium">Source</th> : null}
                    <th className="px-4 py-3 font-medium">Ordered</th>
                    <th className="px-4 py-3 font-medium">Customer</th>
                    <th className="px-4 py-3 font-medium">Items</th>
                    <th className="px-4 py-3 font-medium">Delivery</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
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

      {selectedJob ? <OrderDetailModal job={selectedJob} onClose={() => setSelectedJobId(null)} assetAuthToken={assetAuthToken} /> : null}
    </>
  );
}
