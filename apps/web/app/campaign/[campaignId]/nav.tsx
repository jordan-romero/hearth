"use client";

// Client-side only so the current tab can be highlighted from the pathname. Nothing here
// decides what a viewer may see — that's the filter's job on each page.

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Tab {
  slug: string;
  label: string;
  playerOnly?: boolean;
}

const TABS: Tab[] = [
  { slug: "", label: "Overview" },
  { slug: "ask", label: "Ask" },
  { slug: "memory", label: "Memory" },
  { slug: "journal", label: "Journal", playerOnly: true },
];

export function CampaignNav({
  campaignId,
  isDm,
}: {
  campaignId: string;
  isDm: boolean;
}) {
  const pathname = usePathname();
  const base = `/campaign/${campaignId}`;

  return (
    <nav className="tabs" aria-label="Campaign sections">
      {TABS.filter((t) => !(t.playerOnly && isDm)).map((t) => {
        const href = t.slug ? `${base}/${t.slug}` : base;
        const active = pathname === href;
        return (
          <Link
            key={t.slug}
            href={href}
            className={`tab${active ? " active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
