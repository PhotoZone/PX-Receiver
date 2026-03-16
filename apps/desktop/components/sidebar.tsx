"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, FolderKanban, LayoutDashboard, Logs, ScanLine, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/jobs/unified", label: "Order Queue", icon: FolderKanban },
  { href: "/jobs", label: "Wink", icon: FolderKanban },
  { href: "/jobs/photo-zone", label: "Photo Zone", icon: FolderKanban },
  { href: "/jobs/pzpro", label: "PZPro", icon: FolderKanban },
  { href: "/scanner", label: "Scanner", icon: ScanLine },
  { href: "/logs", label: "Logs", icon: Logs },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 flex min-h-screen w-72 self-stretch flex-col border-r border-white/70 bg-ink px-5 py-6 text-white">
      <div className="mb-10 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/10">
          <Activity className="h-5 w-5" />
        </div>
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-white/55">PX Receiver</p>
          <h1 className="text-lg font-semibold">Desktop Agent</h1>
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
                "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-bold transition",
                active ? "bg-white text-ink" : "text-white/70 hover:bg-white/10 hover:text-white",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto rounded-3xl border border-white/10 bg-white/5 p-4 text-sm text-white/75">
        <p className="font-medium text-white">Operational mode</p>
        <p className="mt-2 leading-6">
          Keep this app running in the tray or menu bar so assigned jobs can download in the background.
        </p>
      </div>
    </aside>
  );
}
