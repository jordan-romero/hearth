// One workspace page, open in the editor.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getPage, getTableColors, getWorkspaceTree } from "@hearth/agents";
import { requireDm } from "@/lib/campaign";
import { PageEditor } from "./editor";
import { archivePageAction, restorePageAction } from "../../actions";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ campaignId: string; pageId: string }>;
}) {
  const { campaignId, pageId } = await params;
  await requireDm(campaignId);
  const page = await getPage(campaignId, pageId);
  if (!page) notFound();

  // Breadcrumb: the folders above this page.
  const [{ folders }, colors] = await Promise.all([
    getWorkspaceTree(campaignId),
    getTableColors(campaignId),
  ]);
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
      />
    </article>
  );
}
