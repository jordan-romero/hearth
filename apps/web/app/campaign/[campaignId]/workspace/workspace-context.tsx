"use client";

// What every part of the workspace shares: the page list (with titles as typed), and how to open
// a page. While a page is open, opening another swaps it into the same editor and only changes the
// address (no server round trip); from anywhere else it's an ordinary navigation.

import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  fetchDocs,
  getDoc,
  iconOf,
  titleOf,
  useStoreVersion,
} from "./page-store";

export interface WorkspacePage {
  id: string;
  folderId: string | null;
  title: string;
  icon: string | null;
}
export interface WorkspaceFolder {
  id: string;
  parentId: string | null;
  name: string;
}

interface WorkspaceApi {
  campaignId: string;
  base: string;
  pages: WorkspacePage[];
  folders: WorkspaceFolder[];
  /** Open a page (at a heading, optionally): in place when the editor is showing, else by
   * navigating. */
  openPage: (id: string, heading?: string | null) => void;
  /** Fetch a page ahead (hover, focus) so opening it is instant. */
  warmPage: (id: string) => void;
}

const Ctx = createContext<WorkspaceApi | null>(null);

export function useWorkspace(): WorkspaceApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useWorkspace outside WorkspaceProvider");
  return api;
}

/** The id of the page open at this address, if it's a page (not its history). */
export function openPageId(base: string, pathname: string): string | null {
  const m = pathname.match(/\/p\/([^/]+)$/);
  return pathname.startsWith(`${base}/p/`) && m
    ? decodeURIComponent(m[1]!)
    : null;
}

/** Run after the editor has swapped pages (two frames: React, then the editor's DOM). */
function afterSwitch(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/** Scroll the open page to a heading by its text. */
export function scrollToHeading(heading: string) {
  const want = heading.trim().replace(/\s+/g, " ").toLowerCase();
  const el = [
    ...document.querySelectorAll<HTMLElement>(
      ".ws-prose h1, .ws-prose h2, .ws-prose h3, .ws-prose h4",
    ),
  ].find(
    (h) => h.textContent?.trim().replace(/\s+/g, " ").toLowerCase() === want,
  );
  el?.scrollIntoView({ block: "start", behavior: "smooth" });
}

/** How many pages to fetch ahead in the background, so most clicks need nothing from the server. */
const BACKGROUND_LIMIT = 300;

export function WorkspaceProvider({
  campaignId,
  pages: serverPages,
  folders,
  children,
}: {
  campaignId: string;
  pages: WorkspacePage[];
  folders: WorkspaceFolder[];
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const base = `/campaign/${campaignId}/workspace`;
  const storeVersion = useStoreVersion();

  // Titles as typed in this tab win over the server's list until it catches up.
  const pages = useMemo(
    () =>
      serverPages.map((p) => ({
        ...p,
        title: titleOf(p.id, p.title),
        icon: iconOf(p.id, p.icon),
      })),
    // storeVersion: titles live in the store, so a change there recomputes this.
    [serverPages, storeVersion],
  );

  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const openPage = useCallback(
    (id: string, heading?: string | null) => {
      const path = `${base}/p/${encodeURIComponent(id)}`;
      const href = `${path}${heading ? `#${encodeURIComponent(heading)}` : ""}`;
      if (openPageId(base, pathnameRef.current)) {
        // The editor is showing: it follows the address. Next.js keeps its router in step with
        // pushState, so back and forward work as usual.
        if (window.location.pathname + window.location.hash !== href)
          window.history.pushState(null, "", href);
        if (!getDoc(id)) void fetchDocs(base, [id]);
        // Once the page is showing, go to the heading.
        if (heading) afterSwitch(() => scrollToHeading(heading));
      } else {
        router.push(href);
      }
    },
    [base, router],
  );

  const warmPage = useCallback(
    (id: string) => {
      if (!getDoc(id)) void fetchDocs(base, [id]);
    },
    [base],
  );

  // Fetch the workspace's pages in the background, a batch at a time, once the browser is idle.
  const ids = useMemo(() => serverPages.map((p) => p.id), [serverPages]);
  useEffect(() => {
    let cancelled = false;
    const idle = (fn: () => void) => {
      if (typeof window.requestIdleCallback === "function")
        window.requestIdleCallback(fn, { timeout: 3000 });
      else setTimeout(fn, 1500);
    };
    const run = async () => {
      const missing = ids
        .filter((id) => !getDoc(id))
        .slice(0, BACKGROUND_LIMIT);
      for (let i = 0; i < missing.length && !cancelled; i += 25) {
        await fetchDocs(base, missing.slice(i, i + 25));
      }
    };
    idle(() => void run());
    return () => {
      cancelled = true;
    };
  }, [ids, base]);

  const api = useMemo(
    () => ({ campaignId, base, pages, folders, openPage, warmPage }),
    [campaignId, base, pages, folders, openPage, warmPage],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
