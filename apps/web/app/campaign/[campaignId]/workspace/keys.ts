"use client";

// Key names as the DM's keyboard shows them: ⌘ and ⇧ on a Mac, Ctrl and Shift on Windows and
// Linux. The shortcuts themselves accept either modifier everywhere; only the labels differ.

import { useEffect, useState } from "react";

export interface KeyNames {
  /** "⌘" on a Mac, "Ctrl" elsewhere. */
  mod: string;
  /** "⇧" on a Mac, "Shift" elsewhere. */
  shift: string;
}

const PC: KeyNames = { mod: "Ctrl", shift: "Shift" };
const MAC: KeyNames = { mod: "⌘", shift: "⇧" };

function isMac() {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent;
  return /mac|iphone|ipad/i.test(platform);
}

/** Starts as the PC names (what the server renders), then switches on a Mac. */
export function useKeys(): KeyNames {
  const [keys, setKeys] = useState(PC);
  useEffect(() => setKeys(isMac() ? MAC : PC), []);
  return keys;
}
