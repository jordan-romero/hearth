// The workspace's front page: the pages touched most recently, and a way to start a new one.

import Link from "next/link";
import { getWorkspaceTree } from "@hearth/agents";
import { requireDm } from "@/lib/campaign";
import { NewPageButton } from "./new-page-button";

export default async function WorkspaceHome({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  await requireDm(campaignId);
  const { folders, pages } = await getWorkspaceTree(campaignId);
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const recent = [...pages]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 12);

  return (
    <div className="ws-home-page">
      <div className="ws-home-head">
        <h2 className="ws-title-static">Your workspace</h2>
        <NewPageButton campaignId={campaignId} />
      </div>
      {recent.length === 0 ? (
        <div className="ws-empty-state">
          <p>
            This is where your campaign lives: NPCs, places, factions, session
            prep, the Emperor&rsquo;s speech. Make folders however you like and
            write pages inside them.
          </p>
          <p className="muted small">
            Everything here is yours alone. Players only ever learn what you
            reveal.
          </p>
        </div>
      ) : (
        <section>
          <h3 className="section-h">Recently edited</h3>
          <ul className="ws-recent">
            {recent.map((p) => (
              <li key={p.id}>
                <Link href={`/campaign/${campaignId}/workspace/p/${p.id}`}>
                  {p.title || "Untitled"}
                </Link>
                <span className="muted small">
                  {p.folderId ? folderName.get(p.folderId) : "Top level"} ·{" "}
                  {p.updatedAt.toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
