// A campaign as its members see it. Session recaps are table-shared, but the knowledge list
// runs through the SAME permission filter the bot uses — so a player's page shows only what
// their character knows, and the DM's shows everything. No filtering logic lives here.

import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@hearth/db";
import { resolveMember } from "@hearth/agents";
import { filterKnowledge } from "@hearth/core";

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  const session = await auth();
  if (!session?.discordUserId) {
    return (
      <main className="wrap">
        <h1>Sign in first</h1>
        <p className="muted">
          <Link href="/">Back to the front door</Link>
        </p>
      </main>
    );
  }

  // Membership IS the authorization check — a non-member gets a 404, not a hint that the
  // campaign exists.
  const viewer = await resolveMember(campaignId, session.discordUserId);
  if (!viewer) notFound();

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { name: true },
  });
  if (!campaign) notFound();

  const sessions = await prisma.gameSession.findMany({
    where: { campaignId, recap: { not: null } },
    orderBy: { number: "desc" },
    take: 10,
    select: { id: true, number: true, title: true, recap: true },
  });

  // Load candidates, then filter in core — the same shape as retrieval in the bot.
  const rows = await prisma.knowledgeUnit.findMany({
    where: { campaignId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      campaignId: true,
      baseVisibility: true,
      title: true,
      type: true,
      grants: { select: { characterId: true, partyId: true } },
    },
  });
  const candidates = rows.map((r) => ({
    ...r,
    grantedCharacterIds: r.grants
      .map((g) => g.characterId)
      .filter((v): v is string => v !== null),
    grantedPartyIds: r.grants
      .map((g) => g.partyId)
      .filter((v): v is string => v !== null),
  }));
  const known = filterKnowledge(viewer, candidates);

  return (
    <main className="wrap">
      <p className="eyebrow">
        {viewer.role === "DM"
          ? "Dungeon Master"
          : (viewer.characterName ?? "Player")}
      </p>
      <h1>{campaign.name}</h1>

      <section style={{ marginTop: 36 }}>
        <h2>Sessions</h2>
        {sessions.length === 0 ? (
          <p className="muted">
            No sessions recorded yet. Start one in Discord with{" "}
            <code>/record</code>.
          </p>
        ) : (
          <div className="stack">
            {sessions.map((s) => (
              <article key={s.id} className="card">
                <span className="tag">Session {s.number}</span>
                <h2 style={{ margin: "6px 0 8px", fontSize: 18 }}>
                  {s.title ?? `Session ${s.number}`}
                </h2>
                <p className="muted" style={{ margin: 0 }}>
                  {s.recap}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: 44 }}>
        <h2>
          What {viewer.role === "DM" ? "the campaign" : "you"} know
          {viewer.role === "DM" ? "s" : ""}{" "}
          <span className="muted" style={{ fontSize: 15, fontWeight: 400 }}>
            ({known.length})
          </span>
        </h2>
        {known.length === 0 ? (
          <p className="muted">
            Nothing yet — play a session, and this fills in.
          </p>
        ) : (
          <div className="stack">
            {known.map((u) => (
              <div key={u.id} className="card">
                <span className="tag">{u.type}</span>
                <div style={{ marginTop: 4 }}>{u.title}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <p style={{ marginTop: 40 }}>
        <Link href="/">← All campaigns</Link>
      </p>
    </main>
  );
}
