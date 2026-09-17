// Everything about a subject, gathered by code.
//
// When a question names someone or something in the campaign graph, this collects what the asker
// may see about it — its facts, its connections one and two steps out, every passage that mentions
// it, what was said about it at the table, and, for the DM, which characters already know what —
// and hands that whole set to the model to write from. No model decides what's relevant: the graph
// does. Permission filtering is the corpus's (assembleCorpus + canView), so a player is never given
// more than they could already see.

import { canView, type Viewer } from "@hearth/core";
import { prisma } from "@hearth/db";
import { assembleCorpus, loadCorpusMaterial, type Corpus } from "./corpus.js";
import { normalizeName, uniqueShortNames, type GraphEntity } from "./graph.js";

/** A generous ceiling for one subject's material — far above what almost any subject has. */
const SUBJECT_BUDGET_TOKENS = 150_000;
/** Names this short match too much by accident ("Al", "Ed"). */
const MIN_ALIAS_CHARS = 3;
const MAX_SECOND_HOP = 60;
const MAX_TRANSCRIPT_LINES = 200;

export interface AliasRow {
  entityId: string;
  alias: string;
}

/** The entities a question names, by whole-word match on any of their names. Longer names win
 * where they overlap, so "Captain Hale Morrow" isn't also read as "Hale". */
export function matchEntities(question: string, aliases: AliasRow[]): string[] {
  let hay = ` ${normalizeName(question)} `;
  const candidates = aliases
    .map((a) => ({ ...a, needle: normalizeName(a.alias) }))
    .filter((a) => a.needle.length >= MIN_ALIAS_CHARS)
    .sort((a, b) => b.needle.length - a.needle.length);
  const matched: string[] = [];
  for (const a of candidates) {
    const token = ` ${a.needle} `;
    if (!hay.includes(token)) continue;
    if (!matched.includes(a.entityId)) matched.push(a.entityId);
    hay = hay.split(token).join(" ");
  }
  return matched;
}

/** Add each entity's unambiguous short names ("Moira" for Moira Vane, when nobody else is a Moira),
 * so a question can use the name people actually say. */
export function withShortNames(aliases: AliasRow[]): AliasRow[] {
  const byEntity = new Map<string, GraphEntity>();
  for (const a of aliases) {
    const e = byEntity.get(a.entityId);
    if (e) e.aliases.push(a.alias);
    else
      byEntity.set(a.entityId, {
        kind: "OTHER",
        name: a.alias,
        aliases: [a.alias],
        evidence: [],
      });
  }
  const short = uniqueShortNames([...byEntity.values()]);
  const extra = [...byEntity].flatMap(([entityId, e]) =>
    (short.get(e) ?? []).map((alias) => ({ entityId, alias })),
  );
  return [...aliases, ...extra];
}

export interface SubjectContext {
  subjects: string[];
  corpus: Corpus;
  /** Everything besides the corpus, already rendered. */
  text: string;
}

interface RelationRow {
  subjectId: string;
  objectId: string;
  relation: string;
  subject: { name: string };
  object: { name: string };
  sources: {
    documentChunkId: string | null;
    transcriptSegmentId: string | null;
  }[];
}

export async function gatherSubjectContext(
  viewer: Viewer,
  question: string,
): Promise<SubjectContext | null> {
  const aliases = await prisma.entityAlias.findMany({
    where: { campaignId: viewer.campaignId },
    select: { entityId: true, alias: true },
  });
  const ids = matchEntities(question, withShortNames(aliases));
  if (ids.length === 0) return null;

  const entities = await prisma.entity.findMany({
    where: { id: { in: ids }, campaignId: viewer.campaignId },
    select: {
      id: true,
      name: true,
      kind: true,
      aliases: { select: { alias: true } },
    },
  });

  const relationSelect = {
    subjectId: true,
    objectId: true,
    relation: true,
    subject: { select: { name: true } },
    object: { select: { name: true } },
    sources: { select: { documentChunkId: true, transcriptSegmentId: true } },
  } as const;
  const firstHop: RelationRow[] = await prisma.entityRelation.findMany({
    where: {
      campaignId: viewer.campaignId,
      OR: [{ subjectId: { in: ids } }, { objectId: { in: ids } }],
    },
    select: relationSelect,
  });
  const neighbours = [
    ...new Set(
      firstHop
        .flatMap((r) => [r.subjectId, r.objectId])
        .filter((id) => !ids.includes(id)),
    ),
  ];
  const secondHop: RelationRow[] = neighbours.length
    ? await prisma.entityRelation.findMany({
        where: {
          campaignId: viewer.campaignId,
          OR: [
            { subjectId: { in: neighbours } },
            { objectId: { in: neighbours } },
          ],
          NOT: { OR: [{ subjectId: { in: ids } }, { objectId: { in: ids } }] },
        },
        select: relationSelect,
        take: MAX_SECOND_HOP,
      })
    : [];

  const [factLinks, mentions] = await Promise.all([
    prisma.factEntity.findMany({
      where: { entityId: { in: [...ids, ...neighbours] } },
      select: { knowledgeUnitId: true },
    }),
    prisma.entityMention.findMany({
      where: { entityId: { in: ids } },
      select: { documentChunkId: true, transcriptSegmentId: true },
    }),
  ]);
  const unitIds = [...new Set(factLinks.map((f) => f.knowledgeUnitId))];
  const chunkIds = [
    ...new Set(
      mentions.flatMap((m) => (m.documentChunkId ? [m.documentChunkId] : [])),
    ),
  ];
  const segmentIds = [
    ...new Set(
      mentions.flatMap((m) =>
        m.transcriptSegmentId ? [m.transcriptSegmentId] : [],
      ),
    ),
  ];

  // The subject's facts and passages, filtered to this viewer by the corpus.
  const material = await loadCorpusMaterial(viewer, { unitIds, chunkIds });
  const corpus = assembleCorpus(
    viewer,
    material.units,
    material.chunks,
    SUBJECT_BUDGET_TOKENS,
    { dedupeFacts: false },
  );

  // A connection is shown only if the asker can see a passage that states it. Transcript lines
  // were said aloud at the table, so a campaign member heard them.
  const relationChunkIds = [
    ...new Set(
      [...firstHop, ...secondHop].flatMap((r) =>
        r.sources.flatMap((s) =>
          s.documentChunkId ? [s.documentChunkId] : [],
        ),
      ),
    ),
  ];
  const statedIn = await loadCorpusMaterial(viewer, {
    unitIds: [],
    chunkIds: relationChunkIds,
  });
  const visibleChunks = new Set(
    statedIn.chunks.filter((c) => canView(viewer, c)).map((c) => c.id),
  );
  const visible = (r: RelationRow) =>
    r.sources.some(
      (s) =>
        s.transcriptSegmentId !== null ||
        (s.documentChunkId !== null && visibleChunks.has(s.documentChunkId)),
    );
  const line = (r: RelationRow) =>
    `- ${r.subject.name} ${r.relation} ${r.object.name}`;
  const connections = [...new Set(firstHop.filter(visible).map(line))];
  const further = [...new Set(secondHop.filter(visible).map(line))];

  const transcript = segmentIds.length
    ? await prisma.transcriptSegment.findMany({
        where: { id: { in: segmentIds }, isLive: false },
        orderBy: [{ recording: { startedAt: "asc" } }, { startMs: "asc" }],
        take: MAX_TRANSCRIPT_LINES,
        select: {
          text: true,
          character: { select: { name: true } },
          recording: { select: { gameSession: { select: { number: true } } } },
        },
      })
    : [];

  const whoKnows =
    viewer.role === "DM" ? await whoKnowsWhat(unitIds, chunkIds) : [];

  const nothingVisible =
    corpus.manifest.tokens === 0 &&
    connections.length === 0 &&
    further.length === 0 &&
    transcript.length === 0;
  if (nothingVisible) return null;

  const parts: string[] = [];
  // Only the DM is told who the subject is by every name. An entity's other names can be the
  // secret itself ("the Widow" is the missing queen), so a player's material names things only
  // where the passages and facts they can already see do.
  if (viewer.role === "DM")
    parts.push(
      `The question is about: ${entities
        .map((e) => {
          const also = e.aliases
            .map((a) => a.alias)
            .filter((a) => a !== e.name);
          return `${e.name} (${e.kind.toLowerCase()}${also.length ? `; also called ${also.join(", ")}` : ""})`;
        })
        .join("; ")}`,
    );
  if (connections.length) parts.push(`Connections:\n${connections.join("\n")}`);
  if (further.length)
    parts.push(`Connections one step further out:\n${further.join("\n")}`);
  if (whoKnows.length)
    parts.push(
      `What the players have been told (revealed to them):\n${whoKnows.join("\n")}`,
    );
  if (transcript.length) {
    const bySession = new Map<number, string[]>();
    for (const t of transcript) {
      const n = t.recording.gameSession.number;
      const who = t.character?.name ?? "Someone at the table";
      bySession.set(n, [...(bySession.get(n) ?? []), `  ${who}: ${t.text}`]);
    }
    parts.push(
      `Said at the table:\n${[...bySession]
        .map(([n, lines]) => `Session ${n}:\n${lines.join("\n")}`)
        .join("\n")}`,
    );
  }

  return {
    subjects: entities.map((e) => e.name),
    corpus,
    text: parts.join("\n\n"),
  };
}

/** For the DM: which characters and parties have been shown which of these facts and passages. */
async function whoKnowsWhat(
  unitIds: string[],
  chunkIds: string[],
): Promise<string[]> {
  if (unitIds.length === 0 && chunkIds.length === 0) return [];
  const docIds = chunkIds.length
    ? (
        await prisma.documentChunk.findMany({
          where: { id: { in: chunkIds } },
          select: { sourceDocumentId: true },
        })
      ).map((c) => c.sourceDocumentId)
    : [];
  const grants = await prisma.knowledgeGrant.findMany({
    where: {
      OR: [
        { knowledgeUnitId: { in: unitIds } },
        { documentChunkId: { in: chunkIds } },
        { sourceDocumentId: { in: [...new Set(docIds)] } },
      ],
    },
    select: {
      character: { select: { name: true } },
      party: { select: { name: true } },
      knowledgeUnit: { select: { title: true } },
      documentChunk: {
        select: {
          chunkIndex: true,
          sourceDocument: { select: { name: true } },
        },
      },
      sourceDocument: { select: { name: true } },
    },
  });
  const byWho = new Map<string, Set<string>>();
  for (const g of grants) {
    const who =
      g.character?.name ?? (g.party ? `the party "${g.party.name}"` : null);
    if (!who) continue;
    const what =
      g.knowledgeUnit?.title ??
      (g.documentChunk
        ? `a passage of ${g.documentChunk.sourceDocument.name}`
        : g.sourceDocument
          ? `all of ${g.sourceDocument.name}`
          : null);
    if (!what) continue;
    if (!byWho.has(who)) byWho.set(who, new Set());
    byWho.get(who)!.add(what);
  }
  return [...byWho].map(([who, what]) => `- ${who}: ${[...what].join("; ")}`);
}
