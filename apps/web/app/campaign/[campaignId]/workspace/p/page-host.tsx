"use client";

// Holds the open page across page changes. It sits in the layout above /p/[pageId], so moving
// between pages doesn't rebuild it: the address changes and the editor swaps documents, from the
// page store when the page is already there (usually), else as soon as it arrives. The page route
// itself only hands the server's copy to the store (PageData). Other routes under /p (a page's
// history) render as usual.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  archivePageAction,
  linkMentionsAction,
  restorePageAction,
} from "../actions";
import {
  fetchDocs,
  getDoc,
  useStoreVersion,
  type PageDoc,
} from "../page-store";
import { openPageId, useWorkspace } from "../workspace-context";
import { PageEditor, type TableCharacter } from "./[pageId]/editor";
import PageLoading from "./[pageId]/loading";

/** How old a kept copy may be before opening it also asks the server for a newer one. */
const RECHECK_MS = 2000;

export function PageHost({
  tableColor,
  characters,
  children,
}: {
  tableColor: string;
  characters: TableCharacter[];
  children: ReactNode;
}) {
  const { base } = useWorkspace();
  const pathname = usePathname();
  const id = openPageId(base, pathname);
  useStoreVersion();
  const doc = id ? getDoc(id) : undefined;
  const [missing, setMissing] = useState<string | null>(null);
  // While the next page is on its way, the editor stays (hidden) on the last one.
  const shown = useRef<PageDoc | undefined>(undefined);
  if (doc) shown.current = doc;

  // Check the page with the server when it opens: shown at once from the store, updated if the
  // server has a newer copy.
  useEffect(() => {
    if (!id) return;
    const kept = getDoc(id);
    if (kept && Date.now() - kept.checkedAt < RECHECK_MS) return;
    void fetchDocs(base, [id]).then(() => {
      if (!getDoc(id)) setMissing(id);
    });
  }, [id, base]);

  if (!id) return <>{children}</>;
  if (missing === id && !doc) return <>{children}</>; // the route's own "not found"

  return (
    <>
      {/* The route's part: it fills the store; its loading skeleton isn't needed here. */}
      <div hidden>{children}</div>
      {!doc && <PageLoading />}
      {shown.current && (
        <div hidden={!doc}>
          <PageView
            doc={shown.current}
            tableColor={tableColor}
            characters={characters}
          />
        </div>
      )}
    </>
  );
}

function PageView({
  doc,
  tableColor,
  characters,
}: {
  doc: PageDoc;
  tableColor: string;
  characters: TableCharacter[];
}) {
  const { campaignId, base, pages, folders, openPage } = useWorkspace();
  const router = useRouter();
  const [restoring, setRestoring] = useState(false);

  // Breadcrumb: the folders above this page.
  const byId = new Map(folders.map((f) => [f.id, f]));
  const crumbs: string[] = [];
  for (let id = doc.folderId; id; id = byId.get(id)?.parentId ?? null) {
    const f = byId.get(id);
    if (!f) break;
    crumbs.unshift(f.name);
  }

  const open = (e: React.MouseEvent, id: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    openPage(id);
  };

  return (
    <article className="ws-page">
      <div className="ws-page-bar">
        <span className="ws-crumbs">
          {crumbs.length ? crumbs.join(" / ") : "Top level"}
        </span>
        <div className="ws-page-actions">
          {doc.originalFileName && (
            <a
              className="ws-link"
              href={`${base}/p/${doc.id}/original`}
              title="Download the file this page was imported from"
            >
              Original: {doc.originalFileName}
            </a>
          )}
          <Link className="ws-link" href={`${base}/p/${doc.id}/history`}>
            History
          </Link>
          {doc.archivedAt ? (
            <button
              className="ws-link"
              type="button"
              disabled={restoring}
              onClick={async () => {
                setRestoring(true);
                await restorePageAction(campaignId, doc.id);
                await fetchDocs(base, [doc.id]);
                setRestoring(false);
                router.refresh();
              }}
            >
              Restore from trash
            </button>
          ) : (
            <form action={archivePageAction.bind(null, campaignId, doc.id)}>
              <button className="ws-link" type="submit">
                Move to trash
              </button>
            </form>
          )}
        </div>
      </div>
      {doc.archivedAt && (
        <p className="notice error">
          This page is in the trash. Restore it to edit.
        </p>
      )}
      <PageEditor
        campaignId={campaignId}
        doc={doc}
        tableColor={tableColor}
        characters={characters}
        pages={pages.map(({ id, title }) => ({ id, title }))}
        openPage={openPage}
      />
      {doc.backlinks.length > 0 && (
        <aside className="ws-backlinks" aria-label="Pages that link here">
          <h2 className="ws-backlinks-title">Mentioned in</h2>
          <ul>
            {doc.backlinks.map((b) => (
              <li key={b.id}>
                <Link href={`${base}/p/${b.id}`} onClick={(e) => open(e, b.id)}>
                  {pages.find((p) => p.id === b.id)?.title ||
                    b.title ||
                    "Untitled"}
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      )}
      <UnlinkedMentions doc={doc} />
    </article>
  );
}

interface Mention {
  id: string;
  title: string;
  snippet: string;
}

/** Pages that name this one in plain text without linking it, each with a one-click "Link". */
function UnlinkedMentions({ doc }: { doc: PageDoc }) {
  const { campaignId, base, openPage } = useWorkspace();
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`${base}/page-data/mentions?id=${encodeURIComponent(doc.id)}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((m: Mention[]) => live && setMentions(m))
      .catch(() => live && setMentions([]));
    return () => {
      live = false;
    };
    // The title matters too: a renamed page has different mentions.
  }, [base, doc.id, doc.title, doc.revision, nonce]);

  if (mentions.length === 0) return null;

  async function link(from: string) {
    setBusy(from);
    const result = await linkMentionsAction(campaignId, from, doc.id).catch(
      () => null,
    );
    setBusy(null);
    if (result?.ok) {
      await fetchDocs(base, [from, doc.id]); // their text, and this page's "Mentioned in"
      setNonce((n) => n + 1);
    }
  }

  return (
    <aside className="ws-mentions" aria-label="Unlinked mentions">
      <button
        type="button"
        className="ws-backlinks-title ws-mentions-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▾" : "▸"} Unlinked mentions ({mentions.length})
      </button>
      {open && (
        <ul>
          {mentions.map((m) => (
            <li key={m.id}>
              <div className="ws-mention-head">
                <a
                  href={`${base}/p/${m.id}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                    e.preventDefault();
                    openPage(m.id);
                  }}
                >
                  {m.title || "Untitled"}
                </a>
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={busy === m.id}
                  onClick={() => void link(m.id)}
                  title={`Turn “${doc.title}” there into a link to this page`}
                >
                  {busy === m.id ? "Linking…" : "Link"}
                </button>
              </div>
              <p className="muted small">{m.snippet}</p>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
