// Everything this viewer is allowed to know, browsable. Candidates are loaded in pages and
// run through core's filter until the visible list is full — filtering after a fixed fetch
// would let hidden DM_ONLY rows crowd out knowledge the viewer actually has.

import { requireMember } from "@/lib/campaign";
import { prisma } from "@hearth/db";
import { filterKnowledge } from "@hearth/core";

const TYPES = [
  "NPC",
  "LOCATION",
  "EVENT",
  "FACT",
  "LORE",
  "ITEM",
  "THREAD",
] as const;

const PAGE = 200;
const WANT = 120;

async function loadPage(campaignId: string, take: number, cursor?: string) {
  const rows = await prisma.knowledgeUnit.findMany({
    where: { campaignId },
    orderBy: { id: "asc" },
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      campaignId: true,
      baseVisibility: true,
      title: true,
      content: true,
      type: true,
      source: true,
      imageStoragePath: true,
      grants: { select: { characterId: true, partyId: true } },
    },
  });
  return rows.map((r) => ({
    ...r,
    grantedCharacterIds: r.grants
      .map((g) => g.characterId)
      .filter((v): v is string => v !== null),
    grantedPartyIds: r.grants
      .map((g) => g.partyId)
      .filter((v): v is string => v !== null),
  }));
}

export default async function MemoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ type?: string }>;
}) {
  const { campaignId } = await params;
  const { type } = await searchParams;
  const { viewer } = await requireMember(campaignId);

  const known: Awaited<ReturnType<typeof loadPage>> = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20 && known.length < WANT; i++) {
    const page = await loadPage(campaignId, PAGE, cursor);
    if (page.length === 0) break;
    known.push(...filterKnowledge(viewer, page));
    cursor = page[page.length - 1]!.id;
    if (page.length < PAGE) break;
  }

  const active = TYPES.find((t) => t === type?.toUpperCase());
  const shown = active ? known.filter((u) => u.type === active) : known;
  const counts = new Map<string, number>();
  for (const u of known) counts.set(u.type, (counts.get(u.type) ?? 0) + 1);

  return (
    <section className="section">
      <div className="filters">
        <a className={`chip${!active ? " on" : ""}`} href="?">
          All {known.length}
        </a>
        {TYPES.filter((t) => counts.get(t)).map((t) => (
          <a
            key={t}
            className={`chip${active === t ? " on" : ""}`}
            href={`?type=${t.toLowerCase()}`}
          >
            {t.toLowerCase()} {counts.get(t)}
          </a>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="muted">
          Nothing here yet. Record a session in Discord and this fills in.
        </p>
      ) : (
        <div className="stack">
          {shown.map((u) => (
            <article key={u.id} className="card">
              <div className="card-head">
                <span className="tag">{u.type}</span>
                {u.baseVisibility === "DM_ONLY" && (
                  <span className="tag secret">DM only</span>
                )}
              </div>
              <h2 className="card-title">{u.title}</h2>
              <p className="card-body">{u.content}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
