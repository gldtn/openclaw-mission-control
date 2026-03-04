"use client";

import { useGatewayStatusStore } from "@/lib/gateway-status-store";
import { WifiOff } from "lucide-react";

export function GatewayOfflineBanner() {
  const { status } = useGatewayStatusStore();

  if (status === "online" || status === "loading") return null;

  const isOffline = status === "offline";

  return (
    <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-6 py-3 dark:border-amber-900/40 dark:bg-amber-950/30">
      <div className="flex items-center gap-3 text-sm">
        <WifiOff className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-amber-800 dark:text-amber-200">
          {isOffline
            ? "Gateway is unreachable — data may be stale. Retrying automatically\u2026"
            : "Gateway is degraded — some features may be unavailable. Retrying automatically\u2026"}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
          Retrying
        </span>
      </div>
    </div>
  );
}
