// The campaign at a glance: how much it remembers, and the story so far in reverse order.
// Recaps are table-shared (everyone heard the session), so they need no per-viewer filtering.

import Link from "next/link";
import { requireMember } from "@/lib/campaign";
import { prisma } from "@hearth/db";

export default async function CampaignOverview({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  const { viewer } = await requireMember(campaignId);

  const [sessions, unitCount, docCount, characters] = await Promise.all([
    prisma.gameSession.findMany({
      where: { campaignId, recap: { not: null } },
      orderBy: { number: "desc" },
      take: 20,
      select: {
        id: true,
        number: true,
        title: true,
        recap: true,
        occurredAt: true,
      },
    }),
    // Superseded facts aren't part of the memory any more — counting them would overstate it.
    prisma.knowledgeUnit.count({
      where: { campaignId, supersededByCorrectionId: null },
    }),
    prisma.sourceDocument.count({ where: { campaignId, status: "PARSED" } }),
    prisma.character.findMany({
      where: { campaignId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, ancestry: true, class: true },
    }),
  ]);

  return (
    <>
      <section className="stats">
        <div className="stat">
          <span className="stat-n">{sessions.length}</span>
          <span className="stat-l">sessions recapped</span>
        </div>
        <div className="stat">
          <span className="stat-n">{unitCount}</span>
          <span className="stat-l">things remembered</span>
        </div>
        <div className="stat">
          <span className="stat-n">{docCount}</span>
          <span className="stat-l">documents ingested</span>
        </div>
        <div className="stat">
          <span className="stat-n">{characters.length}</span>
          <span className="stat-l">characters</span>
        </div>
      </section>

      {characters.length > 0 && (
        <section className="section">
          <h2 className="section-h">The party</h2>
          <div className="party">
            {characters.map((c) => (
              <div key={c.id} className="party-member">
                <span className="party-name">{c.name}</span>
                {(c.ancestry || c.class) && (
                  <span className="muted small">
                    {[c.ancestry, c.class].filter(Boolean).join(" · ")}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <h2 className="section-h">The story so far</h2>
        {sessions.length === 0 ? (
          <p className="muted">
            No sessions recorded yet. Start one in Discord with{" "}
            <code>/record</code>, and the recap lands here when you{" "}
            <code>/stop</code>.
          </p>
        ) : (
          <div className="stack">
            {sessions.map((s) => (
              <article key={s.id} className="card">
                <div className="card-head">
                  <span className="tag">Session {s.number}</span>
                  {s.occurredAt && (
                    <time
                      className="muted small"
                      dateTime={s.occurredAt.toISOString()}
                    >
                      {s.occurredAt.toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </time>
                  )}
                </div>
                {s.title && <h3 className="card-title">{s.title}</h3>}
                <p className="card-body">{s.recap}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <p className="muted">
        Ask it anything on the{" "}
        <Link href={`/campaign/${campaignId}/ask`}>Ask</Link> tab
        {viewer.role === "DM"
          ? " — you'll see everything, secrets included."
          : " — you'll get what your character knows."}
      </p>
    </>
  );
}
