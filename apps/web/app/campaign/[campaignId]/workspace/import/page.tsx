// Import: bring a DM's existing notes into the workspace, once. Afterwards Hearth is where they
// live and get edited.

import {
  getWorkspaceTree,
  listImports,
  IMPORTABLE_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  supportsDirectUpload,
} from "@hearth/agents";
import { requireDm } from "@/lib/campaign";
import { ImportWizard } from "./import-wizard";
import { OneNotePanel } from "./onenote-panel";
import { SubmitButton } from "./submit-button";
import { RefreshWhileRunning } from "../refresh";
import { undoImportAction } from "./actions";

export default async function ImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ onenote?: string; onenoteError?: string }>;
}) {
  const { campaignId } = await params;
  const { onenote, onenoteError } = await searchParams;
  await requireDm(campaignId);
  const [{ folders }, imports] = await Promise.all([
    getWorkspaceTree(campaignId),
    listImports(campaignId),
  ]);

  // Folder paths for the destination picker: "World / Factions".
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (id: string) => {
    const parts: string[] = [];
    for (
      let f = byId.get(id);
      f;
      f = f.parentId ? byId.get(f.parentId) : undefined
    )
      parts.unshift(f.name);
    return parts.join(" / ");
  };
  const destinations = folders
    .map((f) => ({ id: f.id, path: pathOf(f.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return (
    <div className="ws-home-page">
      <h2 className="ws-title-static">Import notes</h2>
      <p className="muted" style={{ margin: 0, maxWidth: "62ch" }}>
        Bring in what you already have, once. Folders become folders and every
        file becomes a page you can edit here. From then on, Hearth is where
        your notes live.
      </p>

      <ImportWizard
        campaignId={campaignId}
        folders={destinations}
        accept={IMPORTABLE_EXTENSIONS}
        maxBytes={MAX_UPLOAD_BYTES}
        direct={supportsDirectUpload()}
      />

      <OneNotePanel
        campaignId={campaignId}
        destinations={destinations}
        notice={onenote}
        error={onenoteError}
      />

      {imports.some((b) => b.status === "RUNNING") && (
        <RefreshWhileRunning everyMs={3000} />
      )}

      {imports.length > 0 && (
        <section>
          <h3 className="section-h">Past imports</h3>
          <ul className="ws-recent">
            {imports.map((b) => (
              <li key={b.id}>
                <span>
                  <strong>{b.label}</strong>
                  <span className="muted small">
                    {" "}
                    ·{" "}
                    {b.createdAt.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    · {b.pagesCreated} {b.pagesCreated === 1 ? "page" : "pages"}
                    {b.filesSkipped > 0 && `, ${b.filesSkipped} skipped`}
                    {b.status === "RUNNING" && " · importing…"}
                    {b.source === "ONENOTE" && " · OneNote"}
                  </span>
                  {b.message && (
                    <span className="imp-message">{b.message}</span>
                  )}
                </span>
                {b.undoneAt ? (
                  <span className="muted small">
                    undone — its pages are in the trash
                  </span>
                ) : (
                  b.pagesCreated > 0 && (
                    <form
                      action={undoImportAction.bind(null, campaignId, b.id)}
                    >
                      <SubmitButton className="ws-link" pendingLabel="Undoing…">
                        Undo import
                      </SubmitButton>
                    </form>
                  )
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
