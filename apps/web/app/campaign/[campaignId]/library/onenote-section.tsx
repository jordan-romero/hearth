// The library's OneNote panel: connect a Microsoft account, choose the sections to import, see how
// the last import went. The import itself runs in the worker; this page only asks for it.
//
// Every action re-checks the DM — a server action is its own entry point.

import { revalidatePath } from "next/cache";
import { requireDm } from "@/lib/campaign";
import {
  chooseOneNoteSections,
  disconnectOneNote,
  getOneNoteConnection,
  listOneNoteSections,
  oneNoteConfigured,
  requestOneNoteSync,
  OneNoteAuthError,
  type OneNoteSection as Section,
} from "@hearth/agents";
import { RefreshWhileReading } from "./refresh";

const OUTCOME: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "OneNote connected — choose what to import." },
  cancelled: { ok: false, text: "OneNote wasn't connected." },
  failed: { ok: false, text: "Couldn't connect OneNote — try again." },
  unavailable: { ok: false, text: "OneNote isn't set up on this server yet." },
};

export async function OneNoteSection({
  campaignId,
  outcome,
}: {
  campaignId: string;
  outcome?: string;
}) {
  if (!oneNoteConfigured()) return null;

  const conn = await getOneNoteConnection(campaignId);
  const libraryPath = `/campaign/${campaignId}/library`;
  const connectHref = `/api/onenote/connect?campaignId=${encodeURIComponent(campaignId)}`;
  const notice = outcome ? OUTCOME[outcome] : undefined;

  async function save(formData: FormData) {
    "use server";
    await requireDm(campaignId);
    const ids = formData.getAll("section").map(String);
    await chooseOneNoteSections(
      campaignId,
      ids,
      formData.get("extract") !== null,
    );
    revalidatePath(libraryPath);
  }

  async function syncNow() {
    "use server";
    await requireDm(campaignId);
    await requestOneNoteSync(campaignId);
    revalidatePath(libraryPath);
  }

  async function disconnect() {
    "use server";
    await requireDm(campaignId);
    await disconnectOneNote(campaignId);
    revalidatePath(libraryPath);
  }

  let sections: Section[] | null = null;
  let expired = false;
  if (conn) {
    try {
      sections = await listOneNoteSections(campaignId);
    } catch (err) {
      if (err instanceof OneNoteAuthError) expired = true;
      else console.error("listing OneNote sections failed:", err);
    }
  }

  const byNotebook = new Map<string, Section[]>();
  for (const s of sections ?? []) {
    byNotebook.set(s.notebook, [...(byNotebook.get(s.notebook) ?? []), s]);
  }
  const chosen = new Set(conn?.sectionIds ?? []);

  return (
    <section className="section" id="onenote">
      <h2 className="section-h">OneNote</h2>
      {notice && (
        <p
          className={`notice ${notice.ok ? "ok" : "error"}`}
          style={{ marginTop: 0 }}
        >
          {notice.text}
        </p>
      )}

      {!conn ? (
        <div className="panel">
          <p style={{ marginTop: 0 }}>
            Bring your OneNote notebooks in. Pick the sections you want and
            every page becomes a document here — kept up to date when you edit
            it in OneNote. Like everything you add, it stays yours until you
            reveal it.
          </p>
          <a className="btn" href={connectHref}>
            Connect OneNote
          </a>
        </div>
      ) : (
        <div className="panel">
          {conn.syncing && <RefreshWhileReading everyMs={5000} />}
          <div className="panel-head">
            <span className="muted small">
              Connected as{" "}
              <strong>{conn.accountName ?? "your Microsoft account"}</strong>
              {conn.syncing
                ? " · importing…"
                : conn.lastSyncAt
                  ? ` · last import ${conn.lastSyncAt.toLocaleString(
                      undefined,
                      {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      },
                    )}: ${conn.lastSyncResult ?? ""}`
                  : ""}
            </span>
            <div className="dropzone-actions" style={{ marginTop: 0 }}>
              {conn.sectionIds.length > 0 && !conn.syncing && (
                <form action={syncNow}>
                  <button className="btn ghost" type="submit">
                    Import changes now
                  </button>
                </form>
              )}
              <form action={disconnect}>
                <button className="btn ghost" type="submit">
                  Disconnect
                </button>
              </form>
            </div>
          </div>

          {expired ? (
            <p className="notice error">
              Microsoft needs you to sign in again.{" "}
              <a href={connectHref}>Reconnect OneNote</a>
            </p>
          ) : sections === null ? (
            <p className="notice error">
              Couldn&rsquo;t reach OneNote just now — reload to try again.
            </p>
          ) : sections.length === 0 ? (
            <p className="muted">This account has no OneNote sections.</p>
          ) : (
            <form action={save} className="onenote-form">
              {[...byNotebook].map(([notebook, list]) => (
                <fieldset key={notebook} className="onenote-notebook">
                  <legend>{notebook}</legend>
                  {list.map((s) => (
                    <label key={s.id} className="check">
                      <input
                        type="checkbox"
                        name="section"
                        value={s.id}
                        defaultChecked={chosen.has(s.id)}
                      />
                      {s.name}
                    </label>
                  ))}
                </fieldset>
              ))}
              <label className="check">
                <input
                  type="checkbox"
                  name="extract"
                  defaultChecked={conn.extractUnits}
                />
                Also pull out NPCs, places and facts
              </label>
              <p className="muted small" style={{ margin: 0 }}>
                Unticking a section takes its pages back out of the library.
              </p>
              <div>
                <button className="btn" type="submit" disabled={conn.syncing}>
                  Save and import
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
