"use client";

// Rendered only while something is still in progress (an import running). Re-fetches the page
// every few seconds so progress shows without a reload; once nothing is running, the page stops
// rendering this and the polling stops with it.

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function RefreshWhileRunning({ everyMs = 4000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  return null;
}
