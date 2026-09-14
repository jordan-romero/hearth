// One character: their light sheet, the sessions they sat in on, and what has been revealed to
// them. Knowledge the whole table shares is left off — it would be identical on every page.

import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMember } from "@/lib/campaign";
import { prisma } from "@hearth/db";
import { filterKnownToCharacter } from "@hearth/core";

const KNOWN_LIMIT = 200;
const BIO_MAX = 4000;

function abilityScores(stats: unknown): [string, string][] {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return [];
  return Object.entries(stats as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === "string" || typeof entry[1] === "number",
    )
    .map(([key, value]) => [key, String(value)]);
}

export default async function CharacterPage({
  params,
}: {
  params: Promise<{ campaignId: string; characterId: string }>;
}) {
  const { campaignId, characterId } = await params;
  const { viewer } = await requireMember(campaignId);

  const character = await prisma.character.findFirst({
    where: { id: characterId, campaignId },
    select: {
      id: true,
      name: true,
      ancestry: true,
      class: true,
      level: true,
      pronouns: true,
      status: true,
      bio: true,
      stats: true,
      partyId: true,
      tokenStoragePath: true,
      party: { select: { name: true } },
    },
  });
  if (!character) notFound();

  const [attendance, candidates] = await Promise.all([
    prisma.sessionAttendance.findMany({
      where: { characterId: character.id, gameSession: { campaignId } },
      orderBy: { gameSession: { number: "desc" } },
      select: {
        gameSession: {
          select: { id: true, number: true, title: true, occurredAt: true },
        },
      },
    }),
    prisma.knowledgeUnit.findMany({
      where: {
        campaignId,
        supersededByCorrectionId: null,
        grants: {
          some: {
            OR: [
              { characterId: character.id },
              ...(character.partyId ? [{ partyId: character.partyId }] : []),
            ],
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: KNOWN_LIMIT,
      select: {
        id: true,
        campaignId: true,
        baseVisibility: true,
        title: true,
        content: true,
        type: true,
        source: true,
        grants: { select: { characterId: true, partyId: true } },
      },
    }),
  ]);

  const known = filterKnownToCharacter(
    viewer,
    { campaignId, characterId: character.id, partyId: character.partyId },
    candidates.map((u) => ({
      ...u,
      grantedCharacterIds: u.grants
        .map((g) => g.characterId)
        .filter((v): v is string => v !== null),
      grantedPartyIds: u.grants
        .map((g) => g.partyId)
        .filter((v): v is string => v !== null),
    })),
  );

  async function saveBio(formData: FormData) {
    "use server";
    // A server action is its own entry point, so check again who is posting: only a
    // character's own player may rewrite their backstory.
    const { viewer: author } = await requireMember(campaignId);
    if (author.characterId !== characterId) return;
    const bio = String(formData.get("bio") ?? "")
      .trim()
      .slice(0, BIO_MAX);
    await prisma.character.update({
      where: { id: characterId },
      data: { bio: bio || null },
    });
    revalidatePath(`/campaign/${campaignId}/characters/${characterId}`);
  }

  const isOwn = viewer.characterId === character.id;
  const meta = [
    `Level ${character.level}`,
    [character.ancestry, character.class].filter(Boolean).join(" "),
    character.pronouns,
    character.party?.name,
  ].filter(Boolean);
  const scores = abilityScores(character.stats);

  return (
    <>
      <Link className="back" href={`/campaign/${campaignId}`}>
        ← overview
      </Link>

      <section className="sheet">
        {character.tokenStoragePath && (
          <img
            className="token"
            src={`/campaign/${campaignId}/characters/${character.id}/token`}
            alt={`${character.name}'s token`}
            width={96}
            height={96}
          />
        )}
        <h2 className="sheet-name">
          {character.name}
          {character.status !== "ACTIVE" && (
            <span className="status">{character.status.toLowerCase()}</span>
          )}
        </h2>
        <p className="sheet-meta">{meta.join(" · ")}</p>
        {!isOwn && character.bio && (
          <p className="sheet-bio">{character.bio}</p>
        )}
        {scores.length > 0 && (
          <dl className="abilities">
            {scores.map(([key, value]) => (
              <div key={key} className="ability">
                <dt className="ability-k">{key}</dt>
                <dd className="ability-v">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {isOwn && (
        <section className="section">
          <form className="journal-form" action={saveBio}>
            <label className="section-h" htmlFor="bio">
              Backstory
            </label>
            <textarea
              id="bio"
              name="bio"
              rows={6}
              maxLength={BIO_MAX}
              defaultValue={character.bio ?? ""}
              placeholder="Where they came from, what they want, who they left behind…"
            />
            <button className="btn" type="submit">
              Save backstory
            </button>
          </form>
        </section>
      )}

      <section className="section">
        <h2 className="section-h">
          {isOwn
            ? "What's been revealed to you"
            : "What's been revealed to them"}
        </h2>
        {known.length === 0 ? (
          <p className="muted">
            Nothing here beyond what the whole table knows.
          </p>
        ) : (
          <div className="stack">
            {known.map((u) => (
              <article key={u.id} className="card">
                <div className="card-head">
                  <span className="tag">
                    {u.source === "PLAYER_NOTE"
                      ? "journal"
                      : u.grantedCharacterIds.includes(character.id)
                        ? u.type.toLowerCase()
                        : "party"}
                  </span>
                </div>
                <h3 className="card-title">{u.title}</h3>
                <p className="card-body">{u.content}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2 className="section-h">Sessions played</h2>
        {attendance.length === 0 ? (
          <p className="muted">No recorded sessions yet.</p>
        ) : (
          <ul className="sessions">
            {attendance.map(({ gameSession: s }) => (
              <li key={s.id} className="session-row">
                <span className="tag">Session {s.number}</span>
                <span>{s.title ?? "Untitled session"}</span>
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
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
