// The DM's library — campaign material that feeds the memory.
//
// Gated twice over, deliberately. requireDm refuses a player outright (the hidden nav tab is
// presentation, not protection), and everything ingested here lands DM_ONLY unless the DM
// marks it as something the players already have, so nothing reaches a player by accident.
// Players never see this page.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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
import { UploadForm, type FinishInput } from "./upload-form";

// Parsing happens in the worker, but a server-side upload still travels through this request.
export const maxDuration = 60;

const STATUS_LABEL: Record<string, string> = {
  PENDING: "queued",
  PARSING: "reading",
  PARSED: "in the memory",
  FAILED: "failed",
};

type Outcome = {
  error?: string;
  added?: string;
  already?: string;
  /** Name of a document this upload replaces once it has been read. */
  replaced?: string;
};

export default async function LibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<Outcome>;
}) {
  const { campaignId } = await params;
  const { error, added, already, replaced } = await searchParams;
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

  async function upload(formData: FormData) {
    "use server";
    await requireDm(campaignId);

    const file = formData.get("file");
    const f = file instanceof File ? file : null;
    const problem = uploadProblem(f?.name ?? "", f?.size ?? 0);
    if (problem || !f) redirectTo(campaignId, { error: problem ?? undefined });

    const extractUnits = formData.get("extract") !== null;
    const forPlayers = formData.get("forPlayers") !== null;
    const data = Buffer.from(await f.arrayBuffer());
    let result: Awaited<ReturnType<typeof ingestUpload>> | undefined;
    try {
      result = await ingestUpload(
        campaignId,
        f.name,
        data,
        f.type || undefined,
        extractUnits,
        forPlayers,
      );
    } catch (err) {
      console.error("library upload failed:", err);
      redirectTo(campaignId, {
        error: "Couldn't store that file — try again.",
      });
    }
    revalidatePath(`/campaign/${campaignId}/library`);
    redirectTo(
      campaignId,
      result?.alreadyAdded
        ? { already: result.name }
        : {
            added: f.name,
            ...(result?.replaces ? { replaced: f.name } : {}),
          },
    );
  }

  async function prepareUpload(fileName: string, size: number) {
    "use server";
    await requireDm(campaignId);
    const problem = uploadProblem(String(fileName), Number(size));
    if (problem) return { error: problem };
    return prepareDirectUpload(campaignId, String(fileName));
  }

  async function finishUpload(input: FinishInput) {
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
      return {
        href: libraryHref(
          campaignId,
          result.alreadyAdded
            ? { already: result.name }
            : {
                added: String(input.fileName),
                ...(result.replaces
                  ? { replaced: String(input.fileName) }
                  : {}),
              },
        ),
      };
    } catch (err) {
      if (err instanceof UploadRejectedError) {
        return { href: libraryHref(campaignId, { error: err.message }) };
      }
      console.error("library direct upload failed:", err);
      return {
        href: libraryHref(campaignId, {
          error: "Couldn't add that file — try again.",
        }),
      };
    }
  }

  return (
    <>
      <section className="section">
        <h2 className="section-h">Add material</h2>
        <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
          Notes, lore, handouts, a session log — up to{" "}
          {MAX_UPLOAD_BYTES / 1024 / 1024}MB. What you add stays yours alone
          until you reveal it — players can&rsquo;t reach it with{" "}
          <code>/ask</code> — unless you mark it as something the players
          already have.
        </p>

        <UploadForm
          accept={SUPPORTED_UPLOAD_EXTENSIONS.join(",")}
          direct={supportsDirectUpload()}
          upload={upload}
          prepareUpload={prepareUpload}
          finishUpload={finishUpload}
        />

        {error && <p className="notice error">{error}</p>}
        {replaced && (
          <p className="note">
            This replaces the earlier <strong>{replaced}</strong>. The old
            version is kept for anything already revealed from it, but new
            answers will be written from this one.
          </p>
        )}
        {added && (
          <p className="notice ok">
            Added <strong>{added}</strong> — reading it into the memory now.
          </p>
        )}
        {already && (
          <p className="notice ok">
            <strong>{already}</strong> is already in the library, so nothing new
            was added.
          </p>
        )}
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

/** Server actions can't return values to a form post, so outcomes ride back in the URL. */
function libraryHref(campaignId: string, outcome: Outcome): string {
  const q = new URLSearchParams();
  if (outcome.error) q.set("error", outcome.error);
  if (outcome.added) q.set("added", outcome.added);
  if (outcome.already) q.set("already", outcome.already);
  if (outcome.replaced) q.set("replaced", outcome.replaced);
  return `/campaign/${campaignId}/library?${q.toString()}`;
}

function redirectTo(campaignId: string, outcome: Outcome): never {
  redirect(libraryHref(campaignId, outcome));
}
