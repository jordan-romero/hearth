"use client";

// Rendered only while some document is still being read. Re-fetches the page every few seconds
// so a status flips to "in the memory" without the DM reloading; once nothing is pending, the
// page stops rendering this and the polling stops with it.

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function RefreshWhileReading({ everyMs = 4000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  return null;
}
