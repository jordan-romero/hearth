// One workspace page, open in the editor.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getBacklinks, getPage, getTableColors } from "@hearth/agents";
import { requireDm, workspaceTree } from "@/lib/campaign";
import { PageEditor } from "./editor";
import { archivePageAction, restorePageAction } from "../../actions";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ campaignId: string; pageId: string }>;
}) {
  const { campaignId, pageId } = await params;
  // Everything at once, so a click costs one round of queries. Nothing is shown unless the DM
  // check passes: if it fails, Promise.all rejects (a redirect or 404) and the rest is dropped.
  const [, page, { folders, pages }, colors, backlinks] = await Promise.all([
    requireDm(campaignId),
    getPage(campaignId, pageId),
    workspaceTree(campaignId),
    getTableColors(campaignId),
    getBacklinks(campaignId, pageId),
  ]);
  if (!page) notFound();

  // Breadcrumb: the folders above this page.
  const byId = new Map(folders.map((f) => [f.id, f]));
  const crumbs: string[] = [];
  for (let id = page.folderId; id; id = byId.get(id)?.parentId ?? null) {
    const f = byId.get(id);
    if (!f) break;
    crumbs.unshift(f.name);
  }

  const archive = archivePageAction.bind(null, campaignId, pageId);
  const restore = restorePageAction.bind(null, campaignId, pageId);

  return (
    <article className="ws-page">
      <div className="ws-page-bar">
        <span className="ws-crumbs">
          {crumbs.length ? crumbs.join(" / ") : "Top level"}
        </span>
        <div className="ws-page-actions">
          {page.originalFileName && (
            <a
              className="ws-link"
              href={`/campaign/${campaignId}/workspace/p/${pageId}/original`}
              title="Download the file this page was imported from"
            >
              Original: {page.originalFileName}
            </a>
          )}
          <Link
            className="ws-link"
            href={`/campaign/${campaignId}/workspace/p/${pageId}/history`}
          >
            History
          </Link>
          {page.archivedAt ? (
            <form
              action={async () => {
                "use server";
                await restore();
              }}
            >
              <button className="ws-link" type="submit">
                Restore from trash
              </button>
            </form>
          ) : (
            <form action={archive}>
              <button className="ws-link" type="submit">
                Move to trash
              </button>
            </form>
          )}
        </div>
      </div>
      {page.archivedAt && (
        <p className="notice error">
          This page is in the trash. Restore it to edit.
        </p>
      )}
      <PageEditor
        key={page.id}
        campaignId={campaignId}
        pageId={page.id}
        initialTitle={page.title}
        initialContent={page.content}
        initialRevision={page.revision}
        readOnly={!!page.archivedAt}
        tableColor={colors.table}
        characters={colors.characters.map(({ id, name, color }) => ({
          id,
          name,
          color,
        }))}
        folderId={page.folderId}
        pages={pages.map(({ id, title }) => ({ id, title }))}
      />
      {backlinks.length > 0 && (
        <aside className="ws-backlinks" aria-label="Pages that link here">
          <h2 className="ws-backlinks-title">Mentioned in</h2>
          <ul>
            {backlinks.map((b) => (
              <li key={b.id}>
                <Link href={`/campaign/${campaignId}/workspace/p/${b.id}`}>
                  {b.title || "Untitled"}
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </article>
  );
}
