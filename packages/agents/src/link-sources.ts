// Link a newly uploaded document's facts to their sources, as part of ingesting it.
//
// Without this, every fact from a future upload would stay UNCHECKED forever. The same two passes
// that took the live campaign to 96% run here: sources for every fact in groups of sixty, then a
// second, narrower look at the facts the first pass left without one — on a long document most of
// those were skipped in a big group, not unsupported.
//
// Additive only, like the backfill: sources are written beside facts and passages, never by
// recreating either, and a fact that already has a source is never marked UNSOURCED.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@hearth/db";
import {
  groupFacts,
  proposeSources,
  renderFacts,
  renderPassages,
  verifySources,
  type FoundSource,
  type ProvenanceFact,
} from "./provenance.js";

/** The second pass's group size — small enough that the model looks at each fact. */
const RETRY_GROUP = 15;

export interface LinkOutcome {
  facts: number;
  sourced: number;
  unsourced: number;
  /** Facts in a group that failed or was cut off: left UNCHECKED, not judged. */
  unchecked: number;
}

/** Split judged facts by whether any verified source was found. Facts never judged (a failed
 * group) are in neither list — not having been looked at is not the same as having no source. */
export function sourceStatus(
  checkedFactIds: Iterable<string>,
  sources: FoundSource[],
): { sourced: string[]; unsourced: string[] } {
  const withSource = new Set(sources.map((s) => s.factId));
  const sourced: string[] = [];
  const unsourced: string[] = [];
  for (const id of new Set(checkedFactIds))
    (withSource.has(id) ? sourced : unsourced).push(id);
  return { sourced, unsourced };
}

export async function linkFactsForDocument(
  sourceDocumentId: string,
  client: Anthropic = new Anthropic(),
): Promise<LinkOutcome> {
  const [passageRows, facts] = await Promise.all([
    prisma.documentChunk.findMany({
      where: { sourceDocumentId, supersededByCorrectionId: null },
      select: { id: true, chunkIndex: true, text: true },
    }),
    prisma.knowledgeUnit.findMany({
      where: { sourceDocumentId, supersededByCorrectionId: null },
      select: { id: true, title: true, content: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  if (facts.length === 0 || passageRows.length === 0)
    return {
      facts: facts.length,
      sourced: 0,
      unsourced: 0,
      unchecked: facts.length,
    };

  const passages = renderPassages(passageRows);
  const sources: FoundSource[] = [];
  const checked = new Set<string>();

  const run = async (groups: ProvenanceFact[][]) => {
    // The first group writes the document to the cache; the rest read it.
    const one = async (group: ProvenanceFact[]) => {
      const rendered = renderFacts(group);
      try {
        const reply = await proposeSources(
          client,
          passages.text,
          rendered.text,
        );
        if (!reply.input || reply.stopReason === "max_tokens") return;
        sources.push(
          ...verifySources(reply.input, passages.index, rendered.index).sources,
        );
        for (const f of group) checked.add(f.id);
      } catch (err) {
        console.error(`[sources] a group failed for ${sourceDocumentId}:`, err);
      }
    };
    if (groups.length === 0) return;
    await one(groups[0]!);
    for (let i = 1; i < groups.length; i += 4)
      await Promise.all(groups.slice(i, i + 4).map(one));
  };

  await run(groupFacts(facts));
  const linked = new Set(sources.map((s) => s.factId));
  // A fact is only judged unsourced once the second, closer look has also finished for it. If the
  // retry fails, a fact the first pass merely skipped must stay UNCHECKED, not be written off.
  checked.clear();
  for (const id of linked) checked.add(id);
  await run(
    groupFacts(
      facts.filter((f) => !linked.has(f.id)),
      RETRY_GROUP,
    ),
  );

  const unique = new Map(sources.map((s) => [`${s.factId}:${s.chunkId}`, s]));
  const { sourced, unsourced } = sourceStatus(checked, [...unique.values()]);

  await prisma.$transaction([
    prisma.factSource.createMany({
      data: [...unique.values()].map((s) => ({
        knowledgeUnitId: s.factId,
        documentChunkId: s.chunkId,
        quote: s.quote,
      })),
      skipDuplicates: true,
    }),
    prisma.knowledgeUnit.updateMany({
      where: { id: { in: sourced } },
      data: { provenance: "SOURCED" },
    }),
    prisma.knowledgeUnit.updateMany({
      where: { id: { in: unsourced }, sources: { none: {} } },
      data: { provenance: "UNSOURCED" },
    }),
  ]);

  return {
    facts: facts.length,
    sourced: sourced.length,
    unsourced: unsourced.length,
    unchecked: facts.length - checked.size,
  };
}
