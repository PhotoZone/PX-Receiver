"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderKanban, LayoutDashboard, Logs, Printer, ScanLine, Settings2 } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { inferReceiverJobSource } from "@/lib/receiver-contract";
import { useWorkerStoreContext } from "@/lib/use-worker-store";
import { cn } from "@/lib/utils";

const items = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/jobs/unified", label: "Order Queue", icon: FolderKanban },
  { href: "/jobs", label: "Wink", icon: FolderKanban },
  { href: "/jobs/photo-zone", label: "Photo Zone", icon: FolderKanban },
  { href: "/jobs/pzpro", label: "PZPro", icon: FolderKanban },
  { href: "/large-format", label: "Large Format", icon: Printer },
  { href: "/scanner", label: "Scanner", icon: ScanLine },
  { href: "/logs", label: "Logs", icon: Logs },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

export function Sidebar() {
  const pathname = usePathname();
  const { snapshot } = useWorkerStoreContext();
  const outstandingJobs = snapshot.jobs.filter((job) => job.status !== "completed");
  const countsByHref: Record<string, number> = {
    "/jobs/unified": outstandingJobs.length,
    "/jobs": outstandingJobs.filter((job) => inferReceiverJobSource(job) === "wink").length,
    "/jobs/photo-zone": outstandingJobs.filter((job) => inferReceiverJobSource(job) === "photozone").length,
    "/jobs/pzpro": outstandingJobs.filter((job) => inferReceiverJobSource(job) === "pzpro").length,
    "/large-format": snapshot.largeFormat.jobs.filter((job) => ["waiting", "needs_review", "batched"].includes(job.status)).length,
  };

  return (
    <aside className="sticky top-0 flex min-h-screen w-72 self-stretch flex-col border-r border-white/10 bg-[#08111c]/90 px-5 py-6 text-slate-100 backdrop-blur">
      <div className="mb-10 rounded-[1.75rem] border border-white/10 bg-white/5 px-4 py-6 text-center">
        <Image
          src="/photozone-logo.png"
          alt="Photo Zone"
          width={180}
          height={54}
          className="mx-auto h-auto w-40"
          priority
        />
        <div>
          <div className="mt-3 flex justify-center">
            <StatusBadge value={snapshot.health} kind="health" />
          </div>
          <p className="mt-3 text-[11px] uppercase tracking-[0.34em] text-slate-400">PX Receiver</p>
        </div>
      </div>

      <nav className="space-y-2">
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.href === "/jobs" ? pathname === item.href : pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold transition",
                active
                  ? "border border-cyan-400/30 bg-cyan-400/14 text-white shadow-[0_8px_24px_rgba(34,211,238,0.12)]"
                  : "border border-transparent text-slate-300 hover:border-white/10 hover:bg-white/6 hover:text-white",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span>{item.label}</span>
                {typeof countsByHref[item.href] === "number" ? (
                  <span
                    className={cn(
                      "inline-flex min-w-[1.75rem] items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                      active ? "bg-white/10 text-white" : "bg-white/8 text-slate-300",
                    )}
                  >
                    {countsByHref[item.href]}
                  </span>
                ) : null}
              </span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
