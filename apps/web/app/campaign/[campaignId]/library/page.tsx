// The DM's library — campaign material that feeds the memory.
//
// Gated twice over, deliberately. requireDm refuses a player outright (the hidden nav tab is
// presentation, not protection), and everything ingested here lands DM_ONLY, so even after
// upload nothing reaches a player until the DM reveals it. Players never see this page and
// never see its contents by accident.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDm } from "@/lib/campaign";
import {
  ingestUpload,
  listDocuments,
  isSupportedUpload,
  SUPPORTED_UPLOAD_EXTENSIONS,
} from "@hearth/agents";

// Parsing happens in the worker, but the file still travels through this request.
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
  searchParams: Promise<{ error?: string; added?: string }>;
}) {
  const { campaignId } = await params;
  const { error, added } = await searchParams;
  await requireDm(campaignId);

  const docs = await listDocuments(campaignId);
  const parsed = docs.filter((d) => d.status === "PARSED");
  const totalUnits = docs.reduce((n, d) => n + d._count.knowledgeUnits, 0);
  const totalChunks = docs.reduce((n, d) => n + d._count.chunks, 0);

  async function upload(formData: FormData) {
    "use server";
    // Re-check inside the action: a server action is its own entry point, and the page's
    // guard says nothing about who is posting to it.
    await requireDm(campaignId);

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      redirectTo(campaignId, "Choose a file first.");
    }
    const f = file as File;
    if (!isSupportedUpload(f.name)) {
      redirectTo(
        campaignId,
        `Hearth can read ${SUPPORTED_UPLOAD_EXTENSIONS.join(", ")} — not that.`,
      );
    }
    const extractUnits = formData.get("extract") !== null;
    const data = Buffer.from(await f.arrayBuffer());
    await ingestUpload(
      campaignId,
      f.name,
      data,
      f.type || undefined,
      extractUnits,
    );
    revalidatePath(`/campaign/${campaignId}/library`);
    redirectTo(campaignId, undefined, f.name);
  }

  return (
    <>
      <section className="section">
        <h2 className="section-h">Add material</h2>
        <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
          Notes, lore, handouts, a session log. Everything you add is yours
          alone until you reveal it — players can&rsquo;t reach it with{" "}
          <code>/ask</code>.
        </p>

        <form className="upload-form" action={upload}>
          <input
            type="file"
            name="file"
            accept={SUPPORTED_UPLOAD_EXTENSIONS.join(",")}
            aria-label="Document to add"
            required
          />
          <label className="check">
            <input type="checkbox" name="extract" defaultChecked />
            Also pull out NPCs, places and facts
          </label>
          <button className="btn" type="submit">
            Add to memory
          </button>
        </form>

        {error && <p className="notice error">{error}</p>}
        {added && (
          <p className="notice ok">
            Added <strong>{added}</strong> — reading it into the memory now.
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
                  </span>
                </div>
                <span className={`status ${d.status.toLowerCase()}`}>
                  {STATUS_LABEL[d.status] ?? d.status.toLowerCase()}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

/** Server actions can't return values to a page, so outcomes ride back in the URL. */
function redirectTo(campaignId: string, error?: string, added?: string): never {
  const q = new URLSearchParams();
  if (error) q.set("error", error);
  if (added) q.set("added", added);
  redirect(`/campaign/${campaignId}/library?${q.toString()}`);
}
