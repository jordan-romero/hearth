// The corpus: everything a viewer is allowed to see, assembled whole.
//
// Retrieval picks a handful of pieces and hopes they were the right ones. That works until the
// question names something an embedding can't distinguish — one character from another with a
// similar name, one numbered session from another — and then the answer is confidently wrong.
// A campaign's whole library is small enough to hand over in full (Ondera's ten documents are
// ~178k tokens), so the model can read it and decide for itself.
//
// Two rules shape everything here:
//
//   1. The permission spine still decides. Nothing enters a corpus that canView() would reject
//      for that viewer — a bug here leaks the campaign to a player, rather than returning the
//      wrong passage, so the filter runs over every row before assembly and the pure half of
//      this module is tested adversarially.
//
//   2. The shared part comes first, byte-for-byte stable. Prompt caching only pays when the
//      prefix is identical between calls, so the material everyone in the campaign can see is
//      assembled in a deterministic order and placed ahead of anything viewer-specific. The
//      DM's corpus is one cacheable block per campaign; a player's is that same shared block
//      plus a short tail of what was revealed to them alone.

import {
  canView,
  type FilterableKnowledgeUnit,
  type Viewer,
} from "@hearth/core";
import { prisma } from "@hearth/db";

/** Rough size of a corpus in tokens. Deliberately crude — it gates a budget, it isn't billing. */
export const charsPerToken = 4;
export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / charsPerToken);

/** How much of the library to hand over. Above this, the caller falls back to retrieval. */
export const DEFAULT_BUDGET_TOKENS = 150_000;

/** A document passage, with the grants needed to filter it. */
export interface CorpusChunk extends FilterableKnowledgeUnit {
  sourceDocumentId: string;
  docName: string;
  chunkIndex: number;
  text: string;
}

/** An extracted fact, with the grants needed to filter it. */
export interface CorpusUnit extends FilterableKnowledgeUnit {
  title: string;
  content: string;
  type: string;
  authorName: string | null;
}

/**
 * What goes in the prompt. `shared` is identical for everyone in the campaign and is what the
 * cache is keyed on; `personal` is what this viewer alone may see and must never be cached
 * across viewers.
 */
export interface Corpus {
  shared: string;
  personal: string;
  /** What made it in, and what didn't — so a thin answer can be explained rather than guessed at. */
  manifest: {
    documents: string[];
    factCount: number;
    passageCount: number;
    tokens: number;
    /** Documents dropped because the budget ran out, largest-first order preserved. */
    omittedDocuments: string[];
    /** True when nothing was dropped: the viewer's whole permitted library is in the prompt. */
    complete: boolean;
  };
}

/** Everyone in the campaign sees these, so they can sit in the cacheable prefix. */
function isShared(item: FilterableKnowledgeUnit): boolean {
  return item.baseVisibility === "EVERYONE" || item.baseVisibility === "PUBLIC";
}

function renderUnit(unit: CorpusUnit): string {
  // A journal note is written in the first person; without the author it reads as the asker's.
  const by = unit.authorName
    ? ` — ${unit.authorName}'s own note, in their words`
    : "";
  return `[fact] ${unit.title} (${unit.type}${by}): ${unit.content}`;
}

function renderChunk(chunk: CorpusChunk): string {
  return `[${chunk.docName} #${chunk.chunkIndex}] ${chunk.text}`;
}

/**
 * Assemble the corpus from rows already loaded. Pure: no I/O, so the permission behaviour can
 * be tested exhaustively without a database.
 *
 * Ordering is deterministic — documents by name, passages by index within a document, facts by
 * id — because the shared block is a cache key. Two calls with the same permitted material must
 * produce byte-identical text.
 */
export function assembleCorpus(
  viewer: Viewer,
  units: CorpusUnit[],
  chunks: CorpusChunk[],
  budgetTokens = DEFAULT_BUDGET_TOKENS,
): Corpus {
  // The spine, first and over everything. Cross-campaign rows are rejected here too, so a
  // mis-scoped query upstream cannot put another campaign's material in front of the model.
  const visibleUnits = units.filter((u) => canView(viewer, u));
  const visibleChunks = chunks.filter((c) => canView(viewer, c));

  const byDoc = new Map<string, CorpusChunk[]>();
  for (const chunk of visibleChunks) {
    const list = byDoc.get(chunk.docName);
    if (list) list.push(chunk);
    else byDoc.set(chunk.docName, [chunk]);
  }
  const docNames = [...byDoc.keys()].sort();

  const documents: string[] = [];
  const omittedDocuments: string[] = [];
  const sharedParts: string[] = [];
  const personalParts: string[] = [];
  let passageCount = 0;
  let tokens = 0;

  // What can sit in the cacheable prefix. For a player that is only campaign-wide material:
  // anything revealed to them alone differs per viewer and would poison a shared cache. For the
  // DM it is everything — a DM's corpus is the whole campaign, identical on every call and
  // never handed to anyone else, so splitting it by visibility would leave the one viewer whose
  // library is entirely DM_ONLY with nothing cached at all.
  const cacheable = (item: FilterableKnowledgeUnit): boolean =>
    viewer.role === "DM" || isShared(item);

  const sharedFacts = visibleUnits
    .filter(cacheable)
    .sort((a, b) => a.id.localeCompare(b.id));
  const personalFacts = visibleUnits
    .filter((u) => !cacheable(u))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Facts before passages: they are the campaign's distilled state, and if the budget runs out
  // mid-way the summary is worth more than the raw text it came from.
  if (sharedFacts.length > 0) {
    const text = sharedFacts.map(renderUnit).join("\n");
    sharedParts.push(`Known facts:\n${text}`);
    tokens += estimateTokens(text);
  }

  for (const docName of docNames) {
    const passages = byDoc
      .get(docName)!
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
    const text = passages.map(renderChunk).join("\n");
    const cost = estimateTokens(text);
    // A document goes in whole or not at all: half a document reads as a complete one, and the
    // model would answer from it as if nothing were missing.
    if (tokens + cost > budgetTokens) {
      omittedDocuments.push(docName);
      continue;
    }
    tokens += cost;
    passageCount += passages.length;
    documents.push(docName);
    // A document is cacheable only when every passage in it is; a document holding anything
    // revealed to this viewer alone belongs in the personal block, never in the shared cache.
    (passages.every(cacheable) ? sharedParts : personalParts).push(
      `Document "${docName}":\n${text}`,
    );
  }

  if (personalFacts.length > 0) {
    const text = personalFacts.map(renderUnit).join("\n");
    personalParts.push(`Known to you specifically:\n${text}`);
    tokens += estimateTokens(text);
  }

  return {
    shared: sharedParts.join("\n\n"),
    personal: personalParts.join("\n\n"),
    manifest: {
      documents,
      factCount: visibleUnits.length,
      passageCount,
      tokens,
      omittedDocuments,
      complete: omittedDocuments.length === 0,
    },
  };
}

interface GrantRow {
  knowledgeUnitId: string | null;
  documentChunkId: string | null;
  sourceDocumentId: string | null;
  characterId: string | null;
  partyId: string | null;
}

/** Grants that apply to a unit, a passage, or a passage's whole document. */
function grantsFor(
  grants: GrantRow[],
  match: (g: GrantRow) => boolean,
): Pick<FilterableKnowledgeUnit, "grantedCharacterIds" | "grantedPartyIds"> {
  const mine = grants.filter(match);
  return {
    grantedCharacterIds: mine
      .filter((g) => g.characterId)
      .map((g) => g.characterId!),
    grantedPartyIds: mine.filter((g) => g.partyId).map((g) => g.partyId!),
  };
}

/**
 * Load a campaign's material and assemble what this viewer may see.
 *
 * Superseded facts and passages are left out: a correction retires them, and an answer grounded
 * in one the table has disowned is a wrong answer the corpus can't be talked out of.
 */
export async function buildCorpus(
  viewer: Viewer,
  budgetTokens = DEFAULT_BUDGET_TOKENS,
): Promise<Corpus> {
  const [unitRows, chunkRows, grants] = await Promise.all([
    prisma.knowledgeUnit.findMany({
      where: {
        campaignId: viewer.campaignId,
        supersededByCorrectionId: null,
      },
      select: {
        id: true,
        campaignId: true,
        baseVisibility: true,
        title: true,
        content: true,
        type: true,
        authorMembership: {
          select: { characters: { select: { name: true } } },
        },
      },
    }),
    prisma.documentChunk.findMany({
      where: {
        campaignId: viewer.campaignId,
        supersededByCorrectionId: null,
      },
      select: {
        id: true,
        campaignId: true,
        baseVisibility: true,
        chunkIndex: true,
        text: true,
        sourceDocumentId: true,
        sourceDocument: { select: { name: true } },
      },
    }),
    prisma.knowledgeGrant.findMany({
      // A grant has no campaign of its own — it is scoped through whatever it targets.
      where: {
        OR: [
          { knowledgeUnit: { campaignId: viewer.campaignId } },
          { documentChunk: { campaignId: viewer.campaignId } },
          { sourceDocument: { campaignId: viewer.campaignId } },
        ],
      },
      select: {
        knowledgeUnitId: true,
        documentChunkId: true,
        sourceDocumentId: true,
        characterId: true,
        partyId: true,
      },
    }),
  ]);

  const units: CorpusUnit[] = unitRows.map((r) => ({
    id: r.id,
    campaignId: r.campaignId,
    baseVisibility: r.baseVisibility,
    title: r.title,
    content: r.content,
    type: r.type,
    authorName: r.authorMembership?.characters[0]?.name ?? null,
    ...grantsFor(grants, (g) => g.knowledgeUnitId === r.id),
  }));

  const chunks: CorpusChunk[] = chunkRows.map((r) => ({
    id: r.id,
    campaignId: r.campaignId,
    baseVisibility: r.baseVisibility,
    chunkIndex: r.chunkIndex,
    text: r.text,
    sourceDocumentId: r.sourceDocumentId,
    docName: r.sourceDocument.name,
    // A document-level reveal opens every passage in it, so those grants count here too.
    ...grantsFor(
      grants,
      (g) =>
        g.documentChunkId === r.id || g.sourceDocumentId === r.sourceDocumentId,
    ),
  }));

  return assembleCorpus(viewer, units, chunks, budgetTokens);
}
