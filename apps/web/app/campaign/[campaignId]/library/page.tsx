// The DM's library — campaign material that feeds the memory.
//
// Gated twice over, deliberately. requireDm refuses a player outright (the hidden nav tab is
// presentation, not protection), and everything ingested here lands DM_ONLY unless the DM
// marks it as something the players already have, so nothing reaches a player by accident.
// Players never see this page.

import { revalidatePath } from "next/cache";
import { requireDm } from "@/lib/campaign";
import {
  ingestDirectUpload,
  ingestUpload,
  listDocuments,
  prepareDirectUpload,
  supportsDirectUpload,
  uploadProblem,
  UploadRejectedError,
  SUPPORTED_UPLOAD_EXTENSIONS,
  MAX_UPLOAD_BYTES,
} from "@hearth/agents";
import { UploadForm, type FileOutcome, type FinishInput } from "./upload-form";
import { RefreshWhileReading } from "./refresh";
import { OneNoteSection } from "./onenote-section";

// Parsing happens in the worker, but a server-side upload still travels through this request.
export const maxDuration = 60;

const STATUS_LABEL: Record<string, string> = {
  PENDING: "queued",
  PARSING: "reading",
  PARSED: "in the memory",
  FAILED: "failed",
};

export default async function LibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ onenote?: string }>;
}) {
  const { campaignId } = await params;
  const { onenote } = await searchParams;
  await requireDm(campaignId);

  const docs = await listDocuments(campaignId);
  // A replaced version still has its passages and facts, but nothing reads them any more, so
  // counting them here would overstate what the memory actually answers from.
  const current = docs.filter((d) => !d.supersededById);
  const parsed = current.filter((d) => d.status === "PARSED");
  const totalUnits = current.reduce((n, d) => n + d._count.knowledgeUnits, 0);
  const totalChunks = current.reduce((n, d) => n + d._count.chunks, 0);

  // Every action below re-checks the DM: a server action is its own entry point, and the page's
  // guard says nothing about who is calling it.

  async function uploadOne(formData: FormData): Promise<FileOutcome> {
    "use server";
    await requireDm(campaignId);

    const file = formData.get("file");
    const f = file instanceof File ? file : null;
    // A file from a folder is named by its path inside it, so two notes.md files in different
    // folders stay two documents instead of one replacing the other.
    const name = String(formData.get("name") || f?.name || "");
    const problem = uploadProblem(name, f?.size ?? 0);
    if (problem || !f)
      return { kind: "error", message: problem ?? "Choose a file first." };

    try {
      const result = await ingestUpload(
        campaignId,
        name,
        Buffer.from(await f.arrayBuffer()),
        f.type || undefined,
        formData.get("extract") !== null,
        formData.get("forPlayers") !== null,
      );
      revalidatePath(`/campaign/${campaignId}/library`);
      return outcomeOf(result);
    } catch (err) {
      console.error("library upload failed:", err);
      return {
        kind: "error",
        message: "Couldn't store that file — try again.",
      };
    }
  }

  async function prepareUpload(fileName: string, size: number) {
    "use server";
    await requireDm(campaignId);
    const problem = uploadProblem(String(fileName), Number(size));
    if (problem) return { error: problem };
    return prepareDirectUpload(campaignId, String(fileName));
  }

  async function finishUpload(input: FinishInput): Promise<FileOutcome> {
    "use server";
    await requireDm(campaignId);
    try {
      const result = await ingestDirectUpload(
        campaignId,
        String(input.key),
        String(input.fileName),
        input.mimeType ? String(input.mimeType) : undefined,
        input.extractUnits === true,
        input.forPlayers === true,
      );
      revalidatePath(`/campaign/${campaignId}/library`);
      return outcomeOf(result);
    } catch (err) {
      if (err instanceof UploadRejectedError) {
        return { kind: "error", message: err.message };
      }
      console.error("library direct upload failed:", err);
      return { kind: "error", message: "Couldn't add that file — try again." };
    }
  }

  // While anything is still being read, keep the list live so the DM sees it land.
  const reading = current.some(
    (d) => d.status === "PENDING" || d.status === "PARSING",
  );

  return (
    <>
      <section className="section">
        <h2 className="section-h">Add material</h2>
        <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
          Notes, lore, handouts, session logs — one file or a whole folder of
          them. What you add stays yours alone until you reveal it — players
          can&rsquo;t reach it with <code>/ask</code> — unless you mark it as
          something the players already have.
        </p>

        <UploadForm
          accept={SUPPORTED_UPLOAD_EXTENSIONS}
          maxBytes={MAX_UPLOAD_BYTES}
          direct={supportsDirectUpload()}
          uploadOne={uploadOne}
          prepareUpload={prepareUpload}
          finishUpload={finishUpload}
        />
      </section>

      {docs.length > 0 && (
        <section className="stats">
          <div className="stat">
            <span className="stat-n">{docs.length}</span>
            <span className="stat-l">documents</span>
          </div>
          <div className="stat">
            <span className="stat-n">{parsed.length}</span>
            <span className="stat-l">fully read</span>
          </div>
          <div className="stat">
            <span className="stat-n">{totalUnits}</span>
            <span className="stat-l">facts extracted</span>
          </div>
          <div className="stat">
            <span className="stat-n">{totalChunks}</span>
            <span className="stat-l">searchable passages</span>
          </div>
        </section>
      )}

      <OneNoteSection campaignId={campaignId} outcome={onenote} />

      {reading && <RefreshWhileReading />}

      <section className="section">
        <h2 className="section-h">In the library</h2>
        {docs.length === 0 ? (
          <p className="muted">
            Nothing yet. Add a document above, or use <code>/upload</code> in
            Discord.
          </p>
        ) : (
          <div className="stack">
            {docs.map((d) => (
              <article key={d.id} className="card doc">
                <div className="doc-main">
                  <h3 className="card-title">{d.name}</h3>
                  <span className="muted small">
                    {d.createdAt.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                    {d._count.chunks > 0 &&
                      ` · ${d._count.chunks} passages · ${d._count.knowledgeUnits} facts`}
                    {d.baseVisibility === "EVERYONE" &&
                      " · players can see this"}
                  </span>
                  {d.supersededById && (
                    // Kept, not deleted: whatever was revealed from it still reaches the players
                    // who were shown it.
                    <span className="muted small">
                      Replaced by a newer upload — no longer used in answers.
                    </span>
                  )}
                </div>
                <span className={`status ${d.status.toLowerCase()}`}>
                  {d.supersededById
                    ? "replaced"
                    : (STATUS_LABEL[d.status] ?? d.status.toLowerCase())}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function outcomeOf(result: {
  alreadyAdded: boolean;
  name: string;
  replaces?: unknown;
}): FileOutcome {
  return result.alreadyAdded
    ? { kind: "already", existingName: result.name }
    : { kind: "added", replaced: !!result.replaces };
}
