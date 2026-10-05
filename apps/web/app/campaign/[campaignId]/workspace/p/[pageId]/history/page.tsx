// A page's history: every sitting of edits, newest first, with a way back to any of them.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getPage, listPageVersions } from "@hearth/agents";
import { requireDm } from "@/lib/campaign";
import { restoreVersionAction } from "../../../actions";

const CAUSE: Record<string, string> = {
  DM: "You",
  CLAUDE: "Claude",
  SESSION: "From a session",
  IMPORT: "Imported",
  RESTORE: "Restored",
};

export default async function PageHistory({
  params,
}: {
  params: Promise<{ campaignId: string; pageId: string }>;
}) {
  const { campaignId, pageId } = await params;
  await requireDm(campaignId);
  const page = await getPage(campaignId, pageId);
  if (!page) notFound();
  const versions = await listPageVersions(campaignId, pageId);

  return (
    <article className="ws-page">
      <div className="ws-page-bar">
        <Link
          className="ws-link"
          href={`/campaign/${campaignId}/workspace/p/${pageId}`}
        >
          ← Back to {page.title || "Untitled"}
        </Link>
      </div>
      <h2 className="ws-title-static">History</h2>
      {versions.length === 0 ? (
        <p className="muted">No edits saved yet.</p>
      ) : (
        <ol className="ws-history">
          {versions.map((v, i) => (
            <li key={v.id}>
              <details>
                <summary>
                  <span>
                    {v.updatedAt.toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="tag">{CAUSE[v.cause] ?? v.cause}</span>
                  {i === 0 && <span className="muted small">current</span>}
                </summary>
                <pre className="ws-version-text">{v.markdown || "(empty)"}</pre>
                {i > 0 && (
                  <form
                    action={restoreVersionAction.bind(
                      null,
                      campaignId,
                      pageId,
                      v.id,
                    )}
                  >
                    <button className="btn ghost" type="submit">
                      Restore this version
                    </button>
                  </form>
                )}
              </details>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
