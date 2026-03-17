import type { JobRecord, ReceiverRoute } from "../types/app";

export function normalizeReceiverSource(value?: string | null) {
  const normalized = (value || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!normalized) {
    return "";
  }
  if (normalized === "photo_zone") {
    return "photozone";
  }
  return normalized;
}

export function inferReceiverJobSource(job: Pick<JobRecord, "source" | "orderId" | "deliveryMethod">) {
  const explicit = normalizeReceiverSource(job.source);
  if (explicit) {
    return explicit;
  }

  const deliveryMethod = (job.deliveryMethod || "").trim().toLowerCase();
  const orderId = (job.orderId || "").trim().toLowerCase();
  if (deliveryMethod.includes("wink") || orderId.startsWith("w")) {
    return "wink";
  }

  return "";
}

export function formatReceiverJobSource(job: Pick<JobRecord, "source" | "orderId" | "deliveryMethod">) {
  switch (inferReceiverJobSource(job)) {
    case "wink":
      return "Wink";
    case "photozone":
      return "Photo Zone";
    case "pzpro":
      return "PZPro";
    default:
      return "Unknown";
  }
}

export function formatReceiverJobRoute(job: Pick<JobRecord, "storeId" | "targetLocation" | "targetMachineId" | "assignedMachine">) {
  const location = (job.targetLocation || "").trim();
  const storeId = (job.storeId || "").trim();
  const machineId = (job.targetMachineId || job.assignedMachine || "").trim();
  return [location || null, storeId ? `Store ${storeId}` : null, machineId ? `Machine ${machineId}` : null]
    .filter(Boolean)
    .join(" · ");
}

export function routeMachineId(route: Pick<ReceiverRoute, "defaultMachineId" | "storeId">) {
  return (route.defaultMachineId || route.storeId || "").trim();
}

export function routeMatchesMachineId(route: Pick<ReceiverRoute, "defaultMachineId" | "storeId">, machineId: string) {
  const normalizedMachineId = machineId.trim();
  if (!normalizedMachineId) {
    return false;
  }

  const defaultMachineId = (route.defaultMachineId || "").trim();
  const storeId = (route.storeId || "").trim();
  return normalizedMachineId === defaultMachineId || normalizedMachineId === storeId;
}
