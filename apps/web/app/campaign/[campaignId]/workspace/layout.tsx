// The DM's workspace: the folder tree on the left, the open page on the right. DM-only — checked
// here and again in every page and action under it.

import { requireDm, workspaceTree } from "@/lib/campaign";
import { WorkspaceTree } from "./tree";
import { WorkspaceProvider } from "./workspace-context";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  const [, tree] = await Promise.all([
    requireDm(campaignId),
    workspaceTree(campaignId),
  ]);

  const pages = tree.pages.map((p) => ({
    id: p.id,
    folderId: p.folderId,
    title: p.title,
    icon: p.icon,
  }));
  return (
    <WorkspaceProvider
      campaignId={campaignId}
      pages={pages}
      folders={tree.folders}
    >
      <div className="workspace">
        <aside className="ws-side" aria-label="Workspace pages">
          <WorkspaceTree
            campaignId={campaignId}
            folders={tree.folders}
            pages={pages}
          />
        </aside>
        <div className="ws-main">{children}</div>
      </div>
    </WorkspaceProvider>
  );
}
