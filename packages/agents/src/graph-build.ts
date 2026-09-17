// Grow a campaign's graph from its material — one path for everything.
//
// A document upload, a finished session, and bringing an existing campaign in all go through
// buildGraph: read the source in windows, verify what the model proposes (graph.ts), merge it into
// the entities the campaign already has, and re-link which facts and passages mention whom. Nothing
// is rebuilt: entities, aliases, relationships and links are only ever added.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@hearth/db";
import {
  findMentions,
  factsAbout,
  mergeEntities,
  normalizeName,
  proposeEntities,
  proposeRelations,
  renderEntities,
  renderWindow,
  verifyEntities,
  verifyRelations,
  windows,
  type GraphEntity,
  type GraphRelation,
  type GraphUsage,
} from "./graph.js";
import { renderPassages, type ProvenancePassage } from "./provenance.js";

/** Something the graph can be read from: a document's passages, or a session's transcript cut into
 * passage-sized spans. `resolve` says which real row a verified quote belongs to. */
export interface GraphSource {
  label: string;
  passages: ProvenancePassage[];
  resolve(
    passageId: string,
    quote: string,
  ): { documentChunkId: string } | { transcriptSegmentId: string };
}

export interface GraphBuildReport {
  sources: number;
  failedWindows: number;
  entitiesFound: number;
  entitiesTotal: number;
  aliasesDropped: number;
  ambiguousAliases: number;
  relations: number;
  rejected: Record<string, number>;
  usage: GraphUsage;
}

const RELATION_CONCURRENCY = 4;
/** Transcript spans are cut to about a document passage's size. */
const SPAN_CHARS = 1500;

// ── Sources ──────────────────────────────────────────────────────────────────────────────────────

export async function documentSource(
  sourceDocumentId: string,
): Promise<GraphSource> {
  const passages = await prisma.documentChunk.findMany({
    where: { sourceDocumentId, supersededByCorrectionId: null },
    select: { id: true, chunkIndex: true, text: true },
    orderBy: { chunkIndex: "asc" },
  });
  return {
    label: `document ${sourceDocumentId}`,
    passages,
    resolve: (passageId) => ({ documentChunkId: passageId }),
  };
}

/** A session's final transcript as passages: consecutive lines grouped into spans, each line still
 * its own row, so a verified quote is attributed to the line that says it. */
export async function sessionSource(
  gameSessionId: string,
): Promise<GraphSource> {
  const segments = await prisma.transcriptSegment.findMany({
    where: { recording: { gameSessionId }, isLive: false },
    orderBy: [{ recording: { startedAt: "asc" } }, { startMs: "asc" }],
    select: { id: true, text: true },
  });
  const spans = spansOf(segments);
  const bySpan = new Map(spans.map((s) => [s.passage.id, s.segments]));
  return {
    label: `session ${gameSessionId}`,
    passages: spans.map((s) => s.passage),
    resolve: (passageId, quote) => ({
      transcriptSegmentId: segmentFor(bySpan.get(passageId) ?? [], quote),
    }),
  };
}

export function spansOf(segments: { id: string; text: string }[]): {
  passage: ProvenancePassage;
  segments: { id: string; text: string }[];
}[] {
  const spans: {
    passage: ProvenancePassage;
    segments: { id: string; text: string }[];
  }[] = [];
  let current: { id: string; text: string }[] = [];
  const flush = () => {
    if (!current.length) return;
    spans.push({
      passage: {
        id: current[0]!.id,
        chunkIndex: spans.length,
        text: current.map((s) => s.text).join("\n"),
      },
      segments: current,
    });
    current = [];
  };
  let size = 0;
  for (const s of segments) {
    if (size + s.text.length > SPAN_CHARS && current.length) {
      flush();
      size = 0;
    }
    current.push(s);
    size += s.text.length + 1;
  }
  flush();
  return spans;
}

/** The line a quote came from: the one containing it, else the one it starts in, else the span's
 * first line (a quote running across two utterances). */
export function segmentFor(
  segments: { id: string; text: string }[],
  quote: string,
): string {
  const q = normalizeName(quote);
  const whole = segments.find((s) => normalizeName(s.text).includes(q));
  if (whole) return whole.id;
  const head = q.split(" ").slice(0, 4).join(" ");
  const start = segments.find(
    (s) => head && normalizeName(s.text).includes(head),
  );
  return (start ?? segments[0])!.id;
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

const noUsage = (): GraphUsage => ({
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
});
const add = (a: GraphUsage, b: GraphUsage): GraphUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
});
const tally = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

interface Extraction {
  entities: GraphEntity[];
  relations: GraphRelation[];
  report: GraphBuildReport;
}

/** Read one source against the entities already known. Pure apart from the model calls. */
export async function extractGraph(
  client: Anthropic,
  known: GraphEntity[],
  source: GraphSource,
): Promise<Extraction> {
  const report: GraphBuildReport = {
    sources: 1,
    failedWindows: 0,
    entitiesFound: 0,
    entitiesTotal: 0,
    aliasesDropped: 0,
    ambiguousAliases: 0,
    relations: 0,
    rejected: {},
    usage: noUsage(),
  };
  const labels = renderPassages(source.passages).index;
  const parts = windows(source.passages);

  // Entities, window by window, each seeing what earlier windows found.
  let entities = [...known];
  for (const part of parts) {
    try {
      const reply = await proposeEntities(
        client,
        entities,
        renderWindow(part, labels),
      );
      report.usage = add(report.usage, reply.usage);
      if (!reply.input || reply.stopReason === "max_tokens") {
        report.failedWindows++;
        continue;
      }
      const verified = verifyEntities(reply.input, labels);
      report.entitiesFound += verified.entities.length;
      report.aliasesDropped += verified.droppedAliases;
      tally(report.rejected, verified.rejected);
      entities = mergeEntities([...entities, ...verified.entities]).entities;
    } catch (err) {
      report.failedWindows++;
      console.error(`[graph] entity window failed in ${source.label}:`, err);
    }
  }
  const merged = mergeEntities(entities);
  entities = merged.entities;
  report.ambiguousAliases = merged.ambiguousAliases.length;
  report.entitiesTotal = entities.length;

  // Relationships, against the full list, windows in parallel.
  const rendered = renderEntities(entities);
  const relations: GraphRelation[] = [];
  for (let i = 0; i < parts.length; i += RELATION_CONCURRENCY) {
    await Promise.all(
      parts.slice(i, i + RELATION_CONCURRENCY).map(async (part) => {
        try {
          const reply = await proposeRelations(
            client,
            rendered.text,
            renderWindow(part, labels),
          );
          report.usage = add(report.usage, reply.usage);
          if (!reply.input || reply.stopReason === "max_tokens") {
            report.failedWindows++;
            return;
          }
          const verified = verifyRelations(reply.input, labels, rendered.index);
          relations.push(...verified.relations);
          tally(report.rejected, verified.rejected);
        } catch (err) {
          report.failedWindows++;
          console.error(
            `[graph] relation window failed in ${source.label}:`,
            err,
          );
        }
      }),
    );
  }
  report.relations = relations.length;
  return { entities, relations, report };
}

// ── Saving ───────────────────────────────────────────────────────────────────────────────────────

type KnownEntity = GraphEntity & { id?: string };

/** The campaign's current entities, in the shape extraction merges into. */
export async function loadKnownEntities(
  campaignId: string,
): Promise<KnownEntity[]> {
  const rows = await prisma.entity.findMany({
    where: { campaignId },
    select: {
      id: true,
      kind: true,
      name: true,
      aliases: { select: { alias: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    aliases: [
      r.name,
      ...r.aliases.map((a) => a.alias).filter((a) => a !== r.name),
    ],
    evidence: [],
  }));
}

/** Add what one source contributed. Entities are matched to existing rows by id (carried through
 * merging) or, failing that, by primary name. */
export async function saveGraph(
  campaignId: string,
  source: GraphSource,
  extraction: Extraction,
): Promise<void> {
  const ids = new Map<GraphEntity, string>();
  for (const e of extraction.entities as KnownEntity[]) {
    let id = e.id;
    if (!id) {
      const existing = await prisma.entityAlias.findFirst({
        where: { campaignId, normalized: normalizeName(e.name) },
        select: { entityId: true },
      });
      id =
        existing?.entityId ??
        (
          await prisma.entity.create({
            data: { campaignId, kind: e.kind, name: e.name },
            select: { id: true },
          })
        ).id;
    }
    ids.set(e, id);
    await prisma.entityAlias.createMany({
      data: e.aliases.map((alias) => ({
        entityId: id!,
        campaignId,
        alias,
        normalized: normalizeName(alias),
      })),
      skipDuplicates: true,
    });
  }

  for (const r of extraction.relations) {
    const subjectId = ids.get(r.subject);
    const objectId = ids.get(r.object);
    if (!subjectId || !objectId) continue;
    const relation = await prisma.entityRelation.upsert({
      where: {
        subjectId_relation_objectId: {
          subjectId,
          relation: r.relation,
          objectId,
        },
      },
      create: { campaignId, subjectId, relation: r.relation, objectId },
      update: {},
      select: { id: true },
    });
    await prisma.relationSource.createMany({
      data: [
        {
          relationId: relation.id,
          quote: r.evidence.quote,
          ...source.resolve(r.evidence.passageId, r.evidence.quote),
        },
      ],
      skipDuplicates: true,
    });
  }
}

/** Re-work-out, in code, which passages, transcript lines and facts mention each entity. Run after
 * any change: a new alias found in one document is a mention in every other. */
export async function relinkGraph(
  campaignId: string,
): Promise<{ mentions: number; factLinks: number }> {
  const [entityRows, chunks, segments, facts] = await Promise.all([
    prisma.entity.findMany({
      where: { campaignId },
      select: {
        id: true,
        kind: true,
        name: true,
        aliases: { select: { alias: true } },
      },
    }),
    prisma.documentChunk.findMany({
      where: { campaignId, supersededByCorrectionId: null },
      select: { id: true, chunkIndex: true, text: true },
    }),
    prisma.transcriptSegment.findMany({
      where: { isLive: false, recording: { gameSession: { campaignId } } },
      select: { id: true, text: true },
    }),
    prisma.knowledgeUnit.findMany({
      where: { campaignId, supersededByCorrectionId: null },
      select: { id: true, title: true, content: true },
    }),
  ]);
  const entities = entityRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    aliases: [r.name, ...r.aliases.map((a) => a.alias)],
    evidence: [],
  }));

  const chunkMentions = findMentions(entities, chunks);
  const segmentMentions = findMentions(
    entities,
    segments.map((s, i) => ({ id: s.id, chunkIndex: i, text: s.text })),
  );
  const mentionRows = [
    ...[...chunkMentions].flatMap(([e, ids]) =>
      ids.map((documentChunkId) => ({
        entityId: (e as KnownEntity).id!,
        documentChunkId,
      })),
    ),
    ...[...segmentMentions].flatMap(([e, ids]) =>
      ids.map((transcriptSegmentId) => ({
        entityId: (e as KnownEntity).id!,
        transcriptSegmentId,
      })),
    ),
  ];
  const factRows = [...factsAbout(entities, facts)].flatMap(
    ([knowledgeUnitId, about]) =>
      about.map((e) => ({ knowledgeUnitId, entityId: (e as KnownEntity).id! })),
  );

  const written = await prisma.$transaction([
    prisma.entityMention.createMany({
      data: mentionRows,
      skipDuplicates: true,
    }),
    prisma.factEntity.createMany({ data: factRows, skipDuplicates: true }),
  ]);
  return { mentions: written[0].count, factLinks: written[1].count };
}

// ── The one entry point ──────────────────────────────────────────────────────────────────────────

/** Grow the graph from these sources, in order. With `save: false` nothing is written — the
 * entities found still carry forward from one source to the next, so a dry run over a whole
 * campaign reports what a real run would build. */
export async function buildGraph(
  campaignId: string,
  sources: GraphSource[],
  opts: { save: boolean; client?: Anthropic } = { save: true },
): Promise<GraphBuildReport> {
  const client = opts.client ?? new Anthropic();
  const total: GraphBuildReport = {
    sources: 0,
    failedWindows: 0,
    entitiesFound: 0,
    entitiesTotal: 0,
    aliasesDropped: 0,
    ambiguousAliases: 0,
    relations: 0,
    rejected: {},
    usage: noUsage(),
  };
  // A dry run can run before the graph tables exist (the migration ships with this code), so it
  // starts from nothing rather than failing; a real build must be able to read what's there.
  let known: GraphEntity[] = opts.save
    ? await loadKnownEntities(campaignId)
    : await loadKnownEntities(campaignId).catch(() => []);
  for (const source of sources) {
    if (source.passages.length === 0) continue;
    const extraction = await extractGraph(client, known, source);
    if (opts.save) {
      await saveGraph(campaignId, source, extraction);
      known = await loadKnownEntities(campaignId);
    } else {
      known = extraction.entities;
    }
    const r = extraction.report;
    total.sources++;
    total.failedWindows += r.failedWindows;
    total.entitiesFound += r.entitiesFound;
    total.entitiesTotal = r.entitiesTotal;
    total.aliasesDropped += r.aliasesDropped;
    total.ambiguousAliases = r.ambiguousAliases;
    total.relations += r.relations;
    tally(total.rejected, r.rejected);
    total.usage = add(total.usage, r.usage);
  }
  if (opts.save && total.sources > 0) await relinkGraph(campaignId);
  return total;
}
