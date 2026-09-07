// A player's private notes. Writing goes through the same addJournalNote the bot's /journal
// uses, so an entry made here is indistinguishable from one made at the table.

import { revalidatePath } from "next/cache";
import { requireMember } from "@/lib/campaign";
import { prisma } from "@hearth/db";
import { addJournalNote } from "@hearth/agents";

export default async function JournalPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  const { viewer } = await requireMember(campaignId);

  if (!viewer.characterId) {
    return (
      <section className="section">
        <p className="muted">
          Journals belong to a character. Join the campaign in Discord with{" "}
          <code>/join</code> to start one — the DM keeps notes with{" "}
          <code>/upload</code> instead.
        </p>
      </section>
    );
  }

  const entries = await prisma.knowledgeUnit.findMany({
    where: {
      campaignId,
      source: "PLAYER_NOTE",
      authorMembershipId: viewer.membershipId,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, content: true, createdAt: true },
  });

  async function addEntry(formData: FormData) {
    "use server";
    const text = String(formData.get("entry") ?? "").trim();
    if (!text) return;
    // Re-resolve inside the action: never trust ids that round-tripped through the client.
    const { viewer: v } = await requireMember(campaignId);
    if (!v.characterId) return;
    await addJournalNote(campaignId, v.membershipId, v.characterId, text);
    revalidatePath(`/campaign/${campaignId}/journal`);
  }

  return (
    <section className="section">
      <form className="journal-form" action={addEntry}>
        <textarea
          name="entry"
          rows={3}
          placeholder="What do you want to remember?"
          aria-label="New journal entry"
          required
        />
        <button className="btn" type="submit">
          Save entry
        </button>
      </form>
      <p className="hint">Only you and the DM can see these.</p>

      {entries.length === 0 ? (
        <p className="muted">No entries yet.</p>
      ) : (
        <div className="stack">
          {entries.map((e) => (
            <article key={e.id} className="card">
              <time className="tag" dateTime={e.createdAt.toISOString()}>
                {e.createdAt.toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </time>
              <p className="card-body">{e.content}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
