"use client";

// The workspace's pages, kept in the browser so opening one is instant (docs/notes-feel.md §2.5).
// Filled by the page route (the server's copy), by fetching ahead (hover, and the whole workspace
// in the background), and by the editor's own saves. Titles typed in the editor show here at
// once, so the sidebar follows without a reload.
//
// A copy here can be older than the server's (another tab, Claude, a restore). The editor treats
// it as a starting point: it re-checks the page when it opens one, and saves carry the revision
// they were based on, so a stale copy can cause a "changed elsewhere" notice but never lost work.

import { useSyncExternalStore } from "react";
import type { PageDoc } from "@/lib/page-docs";

export type { PageDoc };

interface Entry extends PageDoc {
  /** When the server last confirmed this copy (ms). */
  checkedAt: number;
}

const docs = new Map<string, Entry>();
const titles = new Map<string, string>();
const icons = new Map<string, string | null>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDoc(id: string): Entry | undefined {
  return docs.get(id);
}

/** Take a copy of a page; an older revision than the one kept is ignored. */
export function putDoc(doc: PageDoc, checkedAt = Date.now()) {
  const kept = docs.get(doc.id);
  if (kept && kept.revision > doc.revision) return;
  docs.set(doc.id, { ...doc, checkedAt });
  changed();
}

/** The editor saved: this is now the page as the server has it. */
export function savedDoc(
  id: string,
  saved: { revision: number; title: string; content: PageDoc["content"] },
) {
  const kept = docs.get(id);
  if (!kept) return;
  docs.set(id, { ...kept, ...saved, checkedAt: Date.now() });
  setTitle(id, saved.title);
}

/** A title as the DM types it, before it's saved. */
export function setTitle(id: string, title: string) {
  if (titles.get(id) === title) return;
  titles.set(id, title);
  changed();
}

/** An icon as just picked in this tab (null: removed). */
export function setIcon(id: string, icon: string | null) {
  icons.set(id, icon);
  const kept = docs.get(id);
  if (kept) docs.set(id, { ...kept, icon });
  changed();
}

/** The latest icon for a page: as picked in this tab, else as the server sent it. */
export function iconOf(id: string, fallback: string | null): string | null {
  return icons.has(id) ? icons.get(id)! : fallback;
}

/** The latest title for a page: as typed in this tab, else as the server sent it. */
export function titleOf(id: string, fallback: string): string {
  return titles.get(id) ?? fallback;
}

/** Re-render when any page or title changes. */
export function useStoreVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

const inFlight = new Map<string, Promise<void>>();

/** Fetch pages into the store (deduplicated; at most 25 a request). */
export async function fetchDocs(base: string, ids: readonly string[]) {
  const todo = [...new Set(ids)].filter((id) => !inFlight.has(id));
  for (let i = 0; i < todo.length; i += 25) {
    const batch = todo.slice(i, i + 25);
    const request = (async () => {
      const res = await fetch(
        `${base}/page-data?ids=${batch.map(encodeURIComponent).join(",")}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      for (const doc of (await res.json()) as PageDoc[]) putDoc(doc);
    })()
      .catch(() => {
        /* fetching ahead is a convenience; opening the page fetches it again */
      })
      .finally(() => {
        for (const id of batch) inFlight.delete(id);
      });
    for (const id of batch) inFlight.set(id, request);
    await request;
  }
  await Promise.all(ids.map((id) => inFlight.get(id)));
}
