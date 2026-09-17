// The corpus: everything a viewer is allowed to see, assembled whole.
//
// Retrieval picks a handful of pieces and hopes they were the right ones. That works until the
// question names something an embedding can't distinguish — one character from another with a
// similar name, one numbered session from another — and then the answer is confidently wrong.
// A campaign's whole library is small enough to hand over in full (the real campaign's nine
// documents are ~178k tokens, against a million-token context window), so the model can read it
// and decide for itself.
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

/**
 * The model that reads a corpus.
 *
 * Finding the relevant part of a hundred sessions is a different job from summarising a dozen
 * retrieved lines, and a million-token context is what makes handing over a library possible at
 * all. It lives here rather than in each caller so that answering and revealing can't drift onto
 * different models — they send the same cacheable block, and a cache entry is per model.
 */
export const CORPUS_MODEL = "claude-sonnet-5";

/**
 * Rough size of a corpus in tokens. Crude on purpose — it gates a budget, it isn't billing — but
 * it has to be crude in the SAFE direction.
 *
 * The usual "four characters to a token" rule of thumb was wrong here by half: a real ask on the
 * campaign's corpus reported 264,769 tokens for text this estimated at 177,640, which works out
 * at about 2.7 characters per token. Campaign notes are proper nouns, markdown and punctuation,
 * none of which tokenise like prose. Under-counting is the dangerous direction — the guard stays
 * quiet while the real prompt and the real bill climb — so this uses 2.5, measured and rounded
 * down, and errs toward reporting a corpus as larger than it is.
 */
export const charsPerToken = 2.5;
export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / charsPerToken);

/**
 * How much of the library to hand over. Above this, the caller falls back to retrieval.
 *
 * A cost guard, not a capacity limit. Corpus answers run on Sonnet, whose context window is a
 * million tokens, so the real campaign's ~265k library uses about a quarter of it; the original
 * 150k ceiling was dropping three of nine documents for no reason but a number picked before the
 * model was.
 *
 * Half a million leaves that campaign room to roughly double before anything is dropped, which
 * matters because dropping is silent in the only way that counts — the answer just gets worse.
 * At $2 per million input tokens a corpus this size is about a dollar an ask uncached and a dime
 * on a cache read, and a campaign that outgrows it wants searching, not a bigger prompt.
 */
export const DEFAULT_BUDGET_TOKENS = 500_000;

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
  /** The document this was extracted from, or null when it came from play, a journal or a
   * correction. Facts whose document is already in the corpus are left out as duplicates. */
  sourceDocumentId: string | null;
}

/** What a reference in the rendered corpus points at. */
export interface CorpusRef {
  kind: "unit" | "passage";
  id: string;
}

/**
 * What goes in the prompt. `shared` is identical for everyone in the campaign and is what the
 * cache is keyed on; `personal` is what this viewer alone may see and must never be cached
 * across viewers.
 */
export interface Corpus {
  shared: string;
  personal: string;
  /**
   * Reference label ("U12", "P7") to the row it names, built while rendering so the two cannot
   * disagree. This is how a model's answer becomes a real record: it names a label, and only
   * labels in here resolve to anything.
   */
  index: Map<string, CorpusRef>;
  /** What made it in, and what didn't — so a thin answer can be explained rather than guessed at. */
  manifest: {
    documents: string[];
    factCount: number;
    passageCount: number;
    tokens: number;
    /** Documents dropped because the budget ran out, largest-first order preserved. */
    omittedDocuments: string[];
    /** Facts left out because the document they were extracted from is already here. */
    duplicateFactsOmitted: number;
    /** Facts left out because the budget ran out — distinct from the ones that were duplicates. */
    omittedFacts: number;
    /** True when nothing was dropped: the viewer's whole permitted library is in the prompt. */
    complete: boolean;
  };
}

/** Everyone in the campaign sees these, so they can sit in the cacheable prefix. */
function isShared(item: FilterableKnowledgeUnit): boolean {
  return item.baseVisibility === "EVERYONE" || item.baseVisibility === "PUBLIC";
}

// Items are labelled with a short SEQUENTIAL number, never their database id.
//
// Embedding real ids looked tidy and failed badly: asked to copy a 25-character cuid out of a
// 276,000-token prompt, the model returned ids that were the right shape, the right length, and
// entirely invented — near-misses of real ones, resolving to no row at all. Transcribing long
// opaque strings is the thing to ask of a model least. A two-digit number it can copy, and a
// wrong one either misses the index and is dropped or names something real. It is also cheaper:
// five hundred embedded cuids cost more tokens than five hundred numbers.

function renderUnit(unit: CorpusUnit, ref: number): string {
  // A journal note is written in the first person; without the author it reads as the asker's.
  const by = unit.authorName
    ? ` — ${unit.authorName}'s own note, in their words`
    : "";
  return `[U${ref}] ${unit.title} (${unit.type}${by}): ${unit.content}`;
}

function renderChunk(chunk: CorpusChunk, ref: number): string {
  return `[P${ref}] ${chunk.docName} #${chunk.chunkIndex}: ${chunk.text}`;
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
  opts: {
    /** Leave out facts whose document is present. Right for a whole library, where the document
     * holds everything its facts say; wrong for a few passages gathered about one subject, where
     * the facts from the rest of that document are the point. */
    dedupeFacts?: boolean;
  } = {},
): Corpus {
  const dedupeFacts = opts.dedupeFacts ?? true;
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

  // Documents first, then only the facts that aren't already inside them.
  //
  // Every extracted fact comes FROM a document, so sending both sends the same content twice. In
  // the real campaign all 980 facts were derived from uploads: including them turned a 178k-token
  // library into 233k, past what a context window holds, which forced whole documents to be
  // dropped. A fact whose source document is in the corpus adds nothing the model can't read for
  // itself. What survives the cut is what has no document behind it — play, journals, corrections.
  const includedDocIds = new Set<string>();

  // Labels run across the whole corpus, not per document, so "P17" means one thing. Built here,
  // beside the text it labels, because an index assembled separately is an index that can drift.
  const index = new Map<string, CorpusRef>();
  let nextPassageRef = 0;
  let nextUnitRef = 0;

  for (const docName of docNames) {
    const passages = byDoc
      .get(docName)!
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
    // Render before the budget check, since a dropped document must not consume labels — the
    // numbering has to describe what is actually in the prompt.
    const startRef = nextPassageRef;
    const text = passages
      .map((passage, i) => renderChunk(passage, startRef + i + 1))
      .join("\n");
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
    passages.forEach((passage, i) => {
      index.set(`P${startRef + i + 1}`, { kind: "passage", id: passage.id });
      includedDocIds.add(passage.sourceDocumentId);
    });
    nextPassageRef += passages.length;
    // A document is cacheable only when every passage in it is; a document holding anything
    // revealed to this viewer alone belongs in the personal block, never in the shared cache.
    (passages.every(cacheable) ? sharedParts : personalParts).push(
      `Document "${docName}":\n${text}`,
    );
  }

  // A dropped document's facts are kept: they are the only trace of it left in the corpus.
  const keptFacts = visibleUnits.filter(
    (u) =>
      !dedupeFacts ||
      !u.sourceDocumentId ||
      !includedDocIds.has(u.sourceDocumentId),
  );
  const duplicateFactsOmitted = visibleUnits.length - keptFacts.length;

  const sharedFacts = keptFacts
    .filter(cacheable)
    .sort((a, b) => a.id.localeCompare(b.id));
  const personalFacts = keptFacts
    .filter((u) => !cacheable(u))
    .sort((a, b) => a.id.localeCompare(b.id));

  // The budget is a ceiling, not a suggestion. Appending facts without checking it is how a
  // prompt quietly grows past what the model will accept — the real campaign's corpus reported
  // 164,773 tokens against a budget of 150,000 before this check existed.
  let omittedFacts = 0;

  // Labels are only spent on facts that actually go in: registering them before the budget check
  // would leave the index naming material the model never saw.
  const renderFacts = (facts: CorpusUnit[]): string => {
    const startRef = nextUnitRef;
    return facts
      .map((fact, i) => renderUnit(fact, startRef + i + 1))
      .join("\n");
  };
  const registerFacts = (facts: CorpusUnit[]): void => {
    facts.forEach((fact, i) => {
      index.set(`U${nextUnitRef + i + 1}`, { kind: "unit", id: fact.id });
    });
    nextUnitRef += facts.length;
  };

  if (sharedFacts.length > 0) {
    const text = renderFacts(sharedFacts);
    const cost = estimateTokens(text);
    if (tokens + cost > budgetTokens) omittedFacts += sharedFacts.length;
    else {
      sharedParts.push(`Known facts:\n${text}`);
      registerFacts(sharedFacts);
      tokens += cost;
    }
  }

  if (personalFacts.length > 0) {
    const text = renderFacts(personalFacts);
    const cost = estimateTokens(text);
    if (tokens + cost > budgetTokens) omittedFacts += personalFacts.length;
    else {
      personalParts.push(`Known to you specifically:\n${text}`);
      registerFacts(personalFacts);
      tokens += cost;
    }
  }

  return {
    shared: sharedParts.join("\n\n"),
    personal: personalParts.join("\n\n"),
    index,
    manifest: {
      documents,
      // What is actually in the prompt, not what was visible — the deduplicated facts are gone.
      factCount: keptFacts.length,
      passageCount,
      tokens,
      omittedDocuments,
      duplicateFactsOmitted,
      omittedFacts,
      // Whole means whole: a corpus that had to leave anything behind must say so, or a caller
      // will answer from a gap believing it saw everything.
      complete: omittedDocuments.length === 0 && omittedFacts === 0,
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
  const { units, chunks } = await loadCorpusMaterial(viewer);
  return assembleCorpus(viewer, units, chunks, budgetTokens);
}

/** A campaign's facts and passages with the grants needed to filter them — all of it, or only the
 * rows named. Filtering itself happens in assembleCorpus, so nothing loaded here reaches a viewer
 * who may not see it. */
export async function loadCorpusMaterial(
  viewer: Viewer,
  only: { unitIds?: string[]; chunkIds?: string[] } = {},
): Promise<{ units: CorpusUnit[]; chunks: CorpusChunk[] }> {
  const [unitRows, chunkRows, grants] = await Promise.all([
    prisma.knowledgeUnit.findMany({
      where: {
        campaignId: viewer.campaignId,
        supersededByCorrectionId: null,
        // Untraceable document facts are never used (see FactProvenance).
        provenance: { not: "UNSOURCED" },
        ...(only.unitIds ? { id: { in: only.unitIds } } : {}),
      },
      select: {
        id: true,
        campaignId: true,
        baseVisibility: true,
        title: true,
        content: true,
        type: true,
        sourceDocumentId: true,
        authorMembership: {
          select: { characters: { select: { name: true } } },
        },
      },
    }),
    prisma.documentChunk.findMany({
      where: {
        campaignId: viewer.campaignId,
        supersededByCorrectionId: null,
        ...(only.chunkIds ? { id: { in: only.chunkIds } } : {}),
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
    sourceDocumentId: r.sourceDocumentId,
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

  return { units, chunks };
}
