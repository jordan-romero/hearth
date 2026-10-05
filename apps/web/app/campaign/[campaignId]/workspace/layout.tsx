// The DM's workspace: the folder tree on the left, the open page on the right. DM-only — checked
// here and again in every page and action under it.

import { getWorkspaceTree } from "@hearth/agents";
import { requireDm } from "@/lib/campaign";
import { WorkspaceTree } from "./tree";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  await requireDm(campaignId);
  const tree = await getWorkspaceTree(campaignId);

  return (
    <div className="workspace">
      <aside className="ws-side" aria-label="Workspace pages">
        <WorkspaceTree
          campaignId={campaignId}
          folders={tree.folders}
          pages={tree.pages.map((p) => ({
            id: p.id,
            folderId: p.folderId,
            title: p.title,
          }))}
        />
      </aside>
      <div className="ws-main">{children}</div>
    </div>
  );
}
