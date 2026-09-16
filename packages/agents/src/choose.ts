// Which of these did the DM mean? Nearest-by-meaning can rank the wrong thing first — "Moira"
// looks like "Morwyn" to an embedding, "session 1" like "session 81" — and /reveal is one-way,
// so committing to the top hit turns a near-miss into a wrong reveal.
//
// So retrieval hands over a wide set and the model picks, reading each candidate the way a
// person would. It returns several, in order, for the DM to choose between: the judgment that
// can't be automated safely stays with the DM, and the model's job is only to put plausible
// options in front of them.

import Anthropic from "@anthropic-ai/sdk";
import type { RetrievedUnit, RetrievedChunk } from "./retrieve.js";
import { CORPUS_MODEL, type Corpus } from "./corpus.js";

// Picking among candidates is reading comprehension, not deep reasoning — the same call ask()
// makes, on the same cheap model.
const MODEL = "claude-haiku-4-5";

const SYSTEM = `You help a Dungeon Master find the right thing to reveal from their campaign memory.
You are given what they asked for and a numbered list of candidates already retrieved from their library.
Choose the candidates that genuinely match what they asked for, best first.
Rules:
- Match on what the text IS ABOUT, not on surface similarity. A different person with a similar-looking name (Moira vs Morwyn), or a different numbered session (session 1 vs session 81), is NOT a match.
- Prefer a specific entry that answers the request over a broad one that merely mentions it.
- Include only genuine matches. If only one candidate matches, return only that one. If none match, return an empty list — that is a useful answer, not a failure.
- Never invent a reference that is not in the list.
Reply with ONLY a JSON array, at most 4 entries, each {"ref": "<the reference, e.g. U3 or P2>", "why": "<at most 8 words on why it matches>"}.`;

/** One thing the DM could release, in the order the model ranked it. */
export interface RevealCandidate {
  kind: "unit" | "passage";
  /** KnowledgeUnit id, or DocumentChunk id for a passage candidate. */
  id: string;
  title: string;
  body: string;
  /** The model's short note on why this matches — absent when ranking fell back. */
  why?: string;
}

function asCandidates(
  units: RetrievedUnit[],
  chunks: RetrievedChunk[],
): { refs: Map<string, RevealCandidate>; lines: string[] } {
  const refs = new Map<string, RevealCandidate>();
  const lines: string[] = [];
  units.forEach((u, i) => {
    const ref = `U${i + 1}`;
    refs.set(ref, {
      kind: "unit",
      id: u.id,
      title: u.title,
      body: u.content,
    });
    lines.push(`[${ref}] ${u.title} (${u.type}): ${u.content}`);
  });
  // One candidate per passage, never the document it sits in. Revealing a document opens every
  // page of it, and a campaign's session log can be a hundred sessions long — so offering the
  // document as the answer to "tell them about session 1" means offering to release everything.
  // A passage is the smallest honest unit, and the DM can pick another if one isn't enough.
  chunks.forEach((c, i) => {
    const ref = `P${i + 1}`;
    refs.set(ref, {
      kind: "passage",
      id: c.id,
      title: c.docName,
      body: c.text,
    });
    lines.push(`[${ref}] a passage from "${c.docName}": ${c.text}`);
  });
  return { refs, lines };
}

/**
 * Read the model's reply as a ranking. Returns null when it isn't one — the caller then shows
 * retrieval order rather than nothing. Forgiving about a reply that wraps its JSON in prose or
 * a code fence, strict about what it accepts as an entry.
 */
export function parseRankingReply(
  text: string,
): { ref: string; why: string }[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const picks: { ref: string; why: string }[] = [];
  for (const row of parsed) {
    if (typeof row !== "object" || row === null || !("ref" in row)) continue;
    const ref = String((row as { ref: unknown }).ref)
      .trim()
      .toUpperCase();
    if (!/^[UP]\d+$/.test(ref)) continue;
    const why =
      "why" in row ? String((row as { why: unknown }).why).trim() : "";
    picks.push({ ref, why });
  }
  return picks;
}

/** Retrieval order, unranked — what we show when the model can't be reached. */
function fallback(
  refs: Map<string, RevealCandidate>,
  limit: number,
): RevealCandidate[] {
  return [...refs.values()].slice(0, limit);
}

/**
 * Rank retrieved candidates by what the DM actually asked for. Never throws: if the model is
 * unreachable or answers with anything but the expected JSON, the DM still gets the retrieved
 * candidates in retrieval order — a worse ordering, never an empty screen.
 */
export async function rankRevealCandidates(
  question: string,
  units: RetrievedUnit[],
  chunks: RetrievedChunk[],
  limit = 4,
): Promise<RevealCandidate[]> {
  const { refs, lines } = asCandidates(units, chunks);
  if (refs.size === 0) return [];
  if (refs.size === 1) return fallback(refs, limit);

  try {
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `The DM asked to reveal: "${question}"\n\nCandidates:\n${lines.join("\n")}`,
        },
      ],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const picks = parseRankingReply(text);
    if (!picks) return fallback(refs, limit);

    const ranked: RevealCandidate[] = [];
    for (const pick of picks) {
      const candidate = refs.get(pick.ref);
      // An invented reference is dropped rather than guessed at — this list becomes buttons
      // that reveal things, so it may only contain what retrieval actually returned.
      if (!candidate || ranked.some((r) => r.id === candidate.id)) continue;
      ranked.push(pick.why ? { ...candidate, why: pick.why } : candidate);
      if (ranked.length >= limit) break;
    }
    // An empty list is a real answer ("nothing here matches"), but only when the model said so
    // in a well-formed reply — which it did, to get here.
    return ranked;
  } catch (err) {
    console.error(
      "reveal ranking failed, falling back to retrieval order:",
      err,
    );
    return fallback(refs, limit);
  }
}

// ─── Choosing from the whole library ─────────────────────────────────────────
// Ranking a retrieved shortlist only ever reorders what similarity already chose, so the wrong
// Moira can still be the only Moira on offer. Given the corpus, the model picks from everything
// the viewer may see instead — the same material /ask reads, in the same cacheable block, so a
// reveal during a session reads a cache that is already warm.

const CORPUS_SYSTEM = `You help a Dungeon Master find the right thing to reveal to their players.
You are given the campaign's material and what the DM asked to reveal. Every fact is labelled [U1], [U2], … and every document passage [P1], [P2], ….
Find the items that genuinely match the request, best first.
Rules:
- Match on what the text IS ABOUT, not on surface similarity. A different person with a similar-looking name (Moira vs Morwyn), or a different numbered session (session 1 vs session 81), is NOT a match.
- Prefer the passage or fact that actually answers the request over one that merely mentions it. If a recap or an entry spans several passages, name the FIRST passage of it — the whole piece is released together.
- Return only genuine matches, at most 4. If nothing matches, return an empty list; that is a useful answer, not a failure.
- Use the labels exactly as they appear. Never invent one.
Answer immediately, without deliberating at length: the material is in front of you and the DM is waiting.
Reply with ONLY a JSON array, at most 4 entries, each {"ref": "<a label such as P17 or U4>", "why": "<at most 8 words on why it matches>"}.`;

/** A thing the DM could release, named by id. The caller resolves it to its content. */
export interface RevealPick {
  kind: "unit" | "passage";
  id: string;
  why?: string;
}

/** A reference the model named, before it has been looked up in the corpus index. */
interface RawPick {
  ref: string;
  why: string;
}

/**
 * Read the model's reply as a list of corpus references.
 *
 * Kept separate from parseRankingReply rather than widening it: that one guards a different
 * shape (positional refs) and is tested against it, and loosening a guard to serve a second
 * caller is how both stop being guarded. Ids here are only ever accepted if they also turn out
 * to exist — this is a shape check, not a trust boundary.
 */
export function parseCorpusPicks(text: string): RawPick[] | null {
  // Read the entries, not the wrapper.
  //
  // Two failures taught this. A reply cut off mid-entry made JSON.parse throw, discarding every
  // good pick before the truncation; and a reply that was a single bare object rather than an
  // array — a correct answer, with the right label — was thrown away for want of a bracket. Both
  // reached the DM as "nothing in your library matches", on a library that plainly matched.
  //
  // So each object is read on its own, wherever it appears. A truncated tail costs one candidate
  // instead of all of them, and the brackets are incidental. This is safe to be generous about
  // because a label means nothing until it is found in the corpus index.
  const picks: RawPick[] = [];
  let sawObject = false;
  for (const raw of text.matchAll(/\{[^{}]*\}/g)) {
    let row: unknown;
    try {
      row = JSON.parse(raw[0]);
    } catch {
      continue; // an incomplete object at the end — nothing to salvage from it
    }
    sawObject = true;
    if (typeof row !== "object" || row === null || !("ref" in row)) continue;
    const ref = String((row as { ref: unknown }).ref)
      .trim()
      .toUpperCase();
    // A label, not an id: "U12" or "P7". Anything else is dropped here, and even a well-formed
    // label means nothing until it is found in the corpus index.
    if (!/^[UP]\d{1,5}$/.test(ref)) continue;
    const why =
      "why" in row ? String((row as { why: unknown }).why).trim() : "";
    picks.push({ ref, why });
  }
  // An empty list is a real answer ("nothing matched") only when the reply actually was one.
  // Prose, or a reply with no complete object in it, is a failure and has to say so — the DM
  // deserves to know the difference between "there is nothing" and "I couldn't read the reply".
  if (picks.length === 0 && !sawObject && !/\[\s*\]/.test(text)) return null;
  return picks;
}

/**
 * Pick what to reveal by reading the viewer's whole permitted library.
 *
 * Returns an empty list both when nothing matches and when the model can't be reached — there is
 * no retrieval order to fall back on here, and inventing candidates for a one-way action is worse
 * than saying "nothing matched". The caller decides what to do with an empty list.
 */
export async function chooseFromCorpus(
  question: string,
  corpus: Corpus,
  limit = 4,
): Promise<RevealPick[]> {
  if (!corpus.shared && !corpus.personal) return [];

  const blocks: Anthropic.TextBlockParam[] = [];
  if (corpus.shared) {
    // Byte-identical to what ask() sends, prefix included, so both share one cache entry.
    blocks.push({
      type: "text",
      text: `Campaign material:\n\n${corpus.shared}`,
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  }
  if (corpus.personal) {
    blocks.push({
      type: "text",
      text: `Known to the asker alone:\n\n${corpus.personal}`,
    });
  }
  blocks.push({
    type: "text",
    text: `The DM asked to reveal: "${question}"`,
  });

  try {
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY
    const started = Date.now();
    const msg = await client.messages.create({
      model: CORPUS_MODEL,
      // Room to think AND answer. max_tokens caps total output, thinking included, and this
      // model thinks before replying — at 400 a question needing a moment's thought spent the
      // whole budget on it and returned no text at all; at 2000 it thought for 23 seconds and
      // was cut off mid-entry. The reply is ~300 characters, so this is nearly all headroom.
      max_tokens: 8000,
      system: CORPUS_SYSTEM,
      messages: [{ role: "user", content: blocks }],
    });
    const usage = msg.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    console.log(
      `[corpus reveal] in=${usage.input_tokens} ` +
        `cacheWrite=${usage.cache_creation_input_tokens ?? 0} ` +
        `cacheRead=${usage.cache_read_input_tokens ?? 0} ${Date.now() - started}ms`,
    );
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const picks = parseCorpusPicks(text);
    // "Nothing matched" and "I couldn't read the reply" look identical to the DM — an empty list
    // either way — so say which happened. A reveal that finds nothing in a library that plainly
    // contains the answer is a bug, and without this line there is nothing to look at.
    if (!picks || picks.length === 0) {
      console.log(
        `[corpus reveal] no picks for ${JSON.stringify(question)}: ` +
          `${picks ? "model returned an empty list" : "reply did not parse"}, ` +
          // stop=max_tokens with no text means the budget went on thinking — the failure that
          // masqueraded as "nothing matched" and took three runs to find without this.
          `stop=${msg.stop_reason}, textLen=${text.length}, ` +
          `prefix=${JSON.stringify(text.slice(0, 160))}`,
      );
    }
    if (!picks) return [];

    // A label becomes a real record here, or it becomes nothing. The model can only have named
    // something in the corpus it was given; anything else — a label for an item that wasn't
    // included, or one it made up — finds no entry and is dropped rather than guessed at.
    const resolved: RevealPick[] = [];
    const seen = new Set<string>();
    for (const pick of picks) {
      const ref = corpus.index.get(pick.ref);
      if (!ref || seen.has(ref.id)) continue;
      seen.add(ref.id);
      resolved.push({
        kind: ref.kind,
        id: ref.id,
        ...(pick.why ? { why: pick.why } : {}),
      });
      if (resolved.length >= limit) break;
    }
    if (resolved.length === 0 && picks.length > 0) {
      console.log(
        `[corpus reveal] ${picks.length} label(s) named for ${JSON.stringify(question)}, ` +
          `none in the index: ${picks.map((p) => p.ref).join(", ")}`,
      );
    }
    return resolved;
  } catch (err) {
    console.error("corpus reveal choice failed:", err);
    return [];
  }
}
