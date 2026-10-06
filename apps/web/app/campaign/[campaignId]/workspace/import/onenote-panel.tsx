// OneNote on the Import screen: connect a Microsoft account, tick the sections to bring in,
// choose where they go. The import runs in the worker; its progress shows under Past imports.
// Every action re-checks the DM — a server action is its own entry point.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  disconnectOneNote,
  getOneNoteConnection,
  listOneNoteSections,
  oneNoteConfigured,
  startOneNoteImport,
  OneNoteAuthError,
  WorkspaceError,
  type OneNoteSection,
} from "@hearth/agents";
import { requireDm } from "@/lib/campaign";
import { SubmitButton } from "./submit-button";

const NOTICES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "OneNote connected. Choose what to bring in." },
  cancelled: { ok: false, text: "OneNote wasn't connected." },
  failed: { ok: false, text: "Couldn't connect OneNote — try again." },
  unavailable: { ok: false, text: "OneNote isn't set up on this server yet." },
  started: {
    ok: true,
    text: "Importing from OneNote — it shows under Past imports as it goes.",
  },
};

export async function OneNotePanel({
  campaignId,
  destinations,
  notice,
  error,
}: {
  campaignId: string;
  destinations: { id: string; path: string }[];
  notice?: string;
  error?: string;
}) {
  if (!oneNoteConfigured()) return null;
  const importPath = `/campaign/${campaignId}/workspace/import`;
  const connectHref = `/api/onenote/connect?campaignId=${encodeURIComponent(campaignId)}`;
  const conn = await getOneNoteConnection(campaignId);

  async function start(formData: FormData) {
    "use server";
    await requireDm(campaignId);
    const sectionIds = formData.getAll("section").map(String);
    const destination = String(formData.get("destination") ?? "") || null;
    let outcome = "started";
    let message = "";
    try {
      await startOneNoteImport(campaignId, {
        sectionIds,
        destinationFolderId: destination,
        label: String(formData.get("label") ?? "OneNote"),
      });
    } catch (err) {
      if (!(err instanceof WorkspaceError)) throw err;
      outcome = "";
      message = err.message;
    }
    revalidatePath(`/campaign/${campaignId}/workspace`, "layout");
    redirect(
      `${importPath}?${outcome ? `onenote=${outcome}` : `onenoteError=${encodeURIComponent(message)}`}#onenote`,
    );
  }

  async function disconnect() {
    "use server";
    await requireDm(campaignId);
    await disconnectOneNote(campaignId);
    revalidatePath(importPath);
  }

  let sections: OneNoteSection[] | null = null;
  let expired = false;
  if (conn) {
    try {
      sections = await listOneNoteSections(campaignId);
    } catch (err) {
      if (err instanceof OneNoteAuthError) expired = true;
      else console.error("listing OneNote sections failed:", err);
    }
  }
  const byNotebook = new Map<string, OneNoteSection[]>();
  for (const s of sections ?? []) {
    const nb = s.path[0] ?? "Notebook";
    byNotebook.set(nb, [...(byNotebook.get(nb) ?? []), s]);
  }
  const shown = notice ? NOTICES[notice] : undefined;

  return (
    <section className="imp-onenote" id="onenote">
      <h3 className="section-h">OneNote</h3>
      {shown && (
        <p className={`notice ${shown.ok ? "ok" : "error"}`}>{shown.text}</p>
      )}
      {error && <p className="notice error">{error}</p>}

      {!conn ? (
        <div className="imp-options">
          <p style={{ margin: 0 }}>
            Bring your OneNote notebooks in. Notebooks and sections become
            folders and every page becomes a page here. You sign in with
            Microsoft and choose what to import.
          </p>
          <div>
            <a className="btn" href={connectHref}>
              Connect OneNote
            </a>
          </div>
        </div>
      ) : (
        <div className="imp-options">
          <div className="panel-head" style={{ margin: 0 }}>
            <span className="muted small">
              Connected as{" "}
              <strong>{conn.accountName ?? "your Microsoft account"}</strong>
            </span>
            <form action={disconnect}>
              <button className="ws-link" type="submit">
                Disconnect
              </button>
            </form>
          </div>

          {expired ? (
            <p className="notice error" style={{ margin: 0 }}>
              Microsoft needs you to sign in again.{" "}
              <a href={connectHref}>Reconnect OneNote</a>
            </p>
          ) : sections === null ? (
            <p className="notice error" style={{ margin: 0 }}>
              Couldn&rsquo;t reach OneNote just now — reload to try again.
            </p>
          ) : sections.length === 0 ? (
            <p className="muted">This account has no OneNote sections.</p>
          ) : (
            <form action={start} className="onenote-form">
              {[...byNotebook].map(([notebook, list]) => (
                <fieldset key={notebook} className="onenote-notebook">
                  <legend>{notebook}</legend>
                  {list.map((s) => (
                    <label key={s.id} className="check">
                      <input
                        type="checkbox"
                        name="section"
                        value={s.id}
                        defaultChecked
                      />
                      {[...s.path.slice(1), s.name].join(" / ")}
                    </label>
                  ))}
                </fieldset>
              ))}
              <label className="imp-field">
                <span>Put it in</span>
                <select
                  className="ws-select"
                  name="destination"
                  defaultValue=""
                >
                  <option value="">Top level of the workspace</option>
                  {destinations.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.path}
                    </option>
                  ))}
                </select>
              </label>
              <input
                type="hidden"
                name="label"
                value={[...byNotebook.keys()].join(", ").slice(0, 200)}
              />
              <p className="muted small" style={{ margin: 0 }}>
                Each notebook becomes a folder. Pages arrive as working notes.
                Pages you&rsquo;ve already imported are skipped, so running this
                again only brings in what&rsquo;s new.
              </p>
              <div>
                <SubmitButton pendingLabel="Starting import…">
                  Import from OneNote
                </SubmitButton>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
