// Provenance — where a fact came from. For each fact extracted from a document, find the passage
// (or passages) that support it and the exact words that do.
//
// The model proposes; code decides. A proposed source is kept only if its quote really appears in
// the passage it names, so a source can be found but never invented. That check is what makes it
// safe, later, to build on facts — to reveal them precisely, to ground generated content, to learn
// new ones — without a model's paraphrase quietly becoming canon.
//
// Labels, not ids: passages are [P1], facts [F1], numbered per document, and resolved through an
// index built in the same pass as the text. The corpus reveal learned this the hard way — asked to
// copy database ids, the model returned well-formed ids that existed nowhere.

import Anthropic from "@anthropic-ai/sdk";

export const PROVENANCE_MODEL = "claude-sonnet-5";

/** Facts per call. The document is cached, so more calls cost little input; smaller groups keep
 * each reply well inside max_tokens, and a failed call loses a group rather than a document. */
export const FACTS_PER_CALL = 60;

/** A quote shorter than this proves nothing — a name alone appears in many passages. */
export const MIN_QUOTE_CHARS = 20;
/** Long enough for a full supporting sentence; longer means copying the passage, not citing it. */
export const MAX_QUOTE_CHARS = 400;

export interface ProvenancePassage {
  id: string;
  chunkIndex: number;
  text: string;
}

export interface ProvenanceFact {
  id: string;
  title: string;
  content: string;
}

export interface FoundSource {
  factId: string;
  chunkId: string;
  quote: string;
}

export type RejectReason =
  | "unknown-fact"
  | "unknown-passage"
  | "too-short"
  | "too-long"
  | "not-in-passage";

/** A proposed source that failed verification — kept only for diagnosis, in private files. */
export interface RejectedSource {
  factId: string | null;
  chunkId: string | null;
  quote: string;
  reason: RejectReason;
}

export interface LinkResult {
  sources: FoundSource[];
  /** Sources whose quote was verbatim in the document but not in the passage the model named,
   * re-attached by code to the nearest passage that does contain it. */
  relabelled: number;
  rejectedSources: RejectedSource[];
  /** Facts that came back with at least one verified source. */
  linkedFactIds: Set<string>;
  rejected: Record<RejectReason, number>;
}

/** Fold the differences a faithful copy can still have: typographic quotes and dashes, runs of
 * whitespace (the chunker and the model both reflow text), and case. Anything past that is a
 * different sentence. */
export function normalizeForQuote(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Why a quote fails against a passage, or null if it holds. */
export function checkQuote(
  quote: string,
  passageText: string,
): RejectReason | null {
  const q = normalizeForQuote(quote);
  if (q.length < MIN_QUOTE_CHARS) return "too-short";
  if (q.length > MAX_QUOTE_CHARS) return "too-long";
  return normalizeForQuote(passageText).includes(q) ? null : "not-in-passage";
}

export function renderPassages(passages: ProvenancePassage[]): {
  text: string;
  index: Map<string, ProvenancePassage>;
} {
  const index = new Map<string, ProvenancePassage>();
  const lines = [...passages]
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((p, i) => {
      const label = `P${i + 1}`;
      index.set(label, p);
      return `[${label}] ${p.text}`;
    });
  return { text: lines.join("\n\n"), index };
}

export function renderFacts(facts: ProvenanceFact[]): {
  text: string;
  index: Map<string, ProvenanceFact>;
} {
  const index = new Map<string, ProvenanceFact>();
  const lines = facts.map((f, i) => {
    const label = `F${i + 1}`;
    index.set(label, f);
    return `[${label}] ${f.title}: ${f.content}`;
  });
  return { text: lines.join("\n"), index };
}

export function groupFacts<T>(facts: T[], size = FACTS_PER_CALL): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < facts.length; i += size)
    groups.push(facts.slice(i, i + size));
  return groups;
}

const label = (value: unknown) =>
  typeof value === "string" ? value.trim().toUpperCase() : "";

/** Turn the model's proposed sources into verified ones. Every rejection is counted by reason, so
 * a run can tell "extraction paraphrased" from "the model mislabelled" without anyone reading the
 * campaign's text. */
export function verifySources(
  input: unknown,
  passages: Map<string, ProvenancePassage>,
  facts: Map<string, ProvenanceFact>,
): LinkResult {
  const rejected: Record<RejectReason, number> = {
    "unknown-fact": 0,
    "unknown-passage": 0,
    "too-short": 0,
    "too-long": 0,
    "not-in-passage": 0,
  };
  const sources: FoundSource[] = [];
  const rejectedSources: RejectedSource[] = [];
  const seen = new Set<string>();
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  let relabelled = 0;

  // In a long document the model copies real words but names the wrong passage — on the
  // campaign's largest document, 142 of 160 rejected quotes were verbatim one to fifty passages
  // away. The words are the evidence; the label is bookkeeping. So when the quote isn't where the
  // model said, look for it in the rest of this document and attach it to the nearest passage that
  // really contains it. Nothing is accepted that isn't verbatim in the source.
  const ordered = [...passages.values()];
  const position = new Map(ordered.map((p, i) => [p.id, i]));
  let normalized: string[] | null = null;
  const nearestContaining = (quote: string, from: number) => {
    normalized ??= ordered.map((p) => normalizeForQuote(p.text));
    const q = normalizeForQuote(quote);
    let best = -1;
    normalized.forEach((t, i) => {
      if (
        t.includes(q) &&
        (best < 0 || Math.abs(i - from) < Math.abs(best - from))
      )
        best = i;
    });
    return best < 0 ? null : ordered[best]!;
  };

  // One source per fact per passage — the table's unique key, and a second quote from the same
  // passage adds nothing a reader of that passage wouldn't see.
  const addSource = (factId: string, chunkId: string, quote: string) => {
    const key = `${factId}:${chunkId}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ factId, chunkId, quote: quote.trim() });
  };

  const entries = (input as { facts?: unknown })?.facts;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const fact = facts.get(label((entry as { fact?: unknown })?.fact));
    const proposed = (entry as { sources?: unknown })?.sources;
    const list = Array.isArray(proposed) ? proposed : [];
    if (!fact) {
      rejected["unknown-fact"] += list.length || 1;
      for (const item of list)
        rejectedSources.push({
          factId: null,
          chunkId: null,
          quote: text((item as { quote?: unknown })?.quote),
          reason: "unknown-fact",
        });
      continue;
    }
    for (const item of list) {
      const passage = passages.get(
        label((item as { passage?: unknown })?.passage),
      );
      const quote = (item as { quote?: unknown })?.quote;
      if (!passage) {
        const found =
          checkQuote(text(quote), "") === "not-in-passage"
            ? nearestContaining(text(quote), 0)
            : null;
        if (found) {
          relabelled++;
          addSource(fact.id, found.id, text(quote));
          continue;
        }
        rejected["unknown-passage"]++;
        rejectedSources.push({
          factId: fact.id,
          chunkId: null,
          quote: text(quote),
          reason: "unknown-passage",
        });
        continue;
      }
      const reason = checkQuote(
        typeof quote === "string" ? quote : "",
        passage.text,
      );
      if (reason === "not-in-passage") {
        const found = nearestContaining(text(quote), position.get(passage.id)!);
        if (found) {
          relabelled++;
          addSource(fact.id, found.id, text(quote));
          continue;
        }
      }
      if (reason) {
        rejected[reason]++;
        rejectedSources.push({
          factId: fact.id,
          chunkId: passage.id,
          quote: text(quote),
          reason,
        });
        continue;
      }
      addSource(fact.id, passage.id, text(quote));
    }
  }

  return {
    sources,
    relabelled,
    rejectedSources,
    linkedFactIds: new Set(sources.map((s) => s.factId)),
    rejected,
  };
}

export const PROVENANCE_SYSTEM = `You are checking a tabletop RPG campaign's memory against its source. You are given one of the DM's documents, split into numbered passages [P1], [P2], …, and a list of facts [F1], [F2], … that were extracted from that document earlier.

For each fact, find the passage or passages that support it, and copy the exact words from each passage that do. Record them with the record_sources tool.

Rules:
- A quote must be copied exactly from the passage you name — same words, same order. Do not paraphrase, summarise, fix spelling, or join words from different places.
- Quote a sentence or clause: at least a few words and under 300 characters. If the support is longer, quote its most specific part. A bare name is not a quote.
- A fact may have been assembled from several places in the document; give one source for each place.
- If no passage supports a fact, leave that fact out. Do not guess — a missing source is useful information, a wrong one is not.
- Use only the labels shown. Never invent a label.`;

export const SOURCES_TOOL: Anthropic.Tool = {
  name: "record_sources",
  description:
    "Record, for each fact, the passages that support it and the exact supporting words.",
  input_schema: {
    type: "object",
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fact: { type: "string", description: "The fact's label, e.g. F3." },
            sources: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  passage: {
                    type: "string",
                    description: "The passage's label, e.g. P12.",
                  },
                  quote: {
                    type: "string",
                    description:
                      "Words copied exactly from that passage that support the fact.",
                  },
                },
                required: ["passage", "quote"],
              },
            },
          },
          required: ["fact", "sources"],
        },
      },
    },
    required: ["facts"],
  },
};

export interface ProvenanceUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Ask for sources for one group of facts from one document. The passages are the cached prefix,
 * so every group after the first reads the document at a tenth of the price. */
export async function proposeSources(
  client: Anthropic,
  passagesText: string,
  factsText: string,
): Promise<{
  input: unknown;
  usage: ProvenanceUsage;
  stopReason: string | null;
}> {
  const msg = await client.messages
    .stream({
      model: PROVENANCE_MODEL,
      // Quotes for sixty facts, several sources each — about 10k tokens at the outside.
      max_tokens: 32000,
      system: PROVENANCE_SYSTEM,
      tools: [SOURCES_TOOL],
      tool_choice: { type: "tool", name: SOURCES_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `The document:\n\n${passagesText}`,
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: `The facts:\n\n${factsText}` },
          ],
        },
      ],
    })
    .finalMessage();

  const block = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  const usage = msg.usage as Anthropic.Usage & {
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  return {
    input: block?.input ?? null,
    stopReason: msg.stop_reason,
    usage: {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
    },
  };
}
