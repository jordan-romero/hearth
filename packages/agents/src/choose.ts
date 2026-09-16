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
Reply with ONLY a JSON array, at most 4 entries, each {"ref": "<the reference, e.g. U3 or D2>", "why": "<at most 8 words on why it matches>"}.`;

/** One thing the DM could release, in the order the model ranked it. */
export interface RevealCandidate {
  kind: "unit" | "doc";
  /** KnowledgeUnit id, or SourceDocument id for a whole-document candidate. */
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
  // One candidate per document, not per passage: revealing a document releases all of it, so
  // the DM should be choosing a document, not a passage that happens to sit inside one.
  const seen = new Set<string>();
  chunks.forEach((c) => {
    if (seen.has(c.sourceDocumentId)) return;
    seen.add(c.sourceDocumentId);
    const ref = `D${seen.size}`;
    refs.set(ref, {
      kind: "doc",
      id: c.sourceDocumentId,
      title: c.docName,
      body: c.text,
    });
    lines.push(
      `[${ref}] the WHOLE document "${c.docName}", which contains: ${c.text}`,
    );
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
    if (!/^[UD]\d+$/.test(ref)) continue;
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
