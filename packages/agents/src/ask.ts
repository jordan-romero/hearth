// ask() — the whole product in miniature: retrieve (filtered) → Claude answers
// from ONLY what the viewer may know. The filter runs before this, so the model
// is never handed a secret it could leak.

import Anthropic from "@anthropic-ai/sdk";
import {
  gatherSubjectContext,
  questionEntities,
  wantsBriefing,
  type SubjectContext,
} from "./graph-context.js";
import { answerWithGraph } from "./graph-agent.js";
import type { Viewer } from "@hearth/core";
import { prisma } from "@hearth/db";
import { retrieveContext } from "./retrieve.js";
import { buildCorpus, CORPUS_MODEL, type Corpus } from "./corpus.js";
import { noKnowledgeReply } from "./no-knowledge.js";

// Live Q&A runs on Haiku — it's grounded answer-from-context, not deep reasoning,
// and Haiku is ~3x cheaper (see the pricing model). Extraction stays on Sonnet.
const MODEL = "claude-haiku-4-5";

// Corpus answers run on CORPUS_MODEL (imported below, alongside the corpus itself, so /ask and
// /reveal can't drift onto different models — they share a cache entry, and a cache entry is per
// model). Retrieval-backed answers stay on Haiku.

// Player view: answer as the character, strictly from what they may know. Retrieval has
// already stripped anything hidden from them, so the model can't leak — but it must not
// hint that hidden things exist either.
const SYSTEM_PLAYER = `You are the living memory of a Dungeons & Dragons campaign, answering a player as their character.
Use ONLY the knowledge entries and document excerpts provided in the user's message.
Rules:
- Everything provided to you IS what this character knows. The material has already been filtered to exactly what they are permitted to know, so if a piece is in front of you, the character knows it — report it plainly.
- This holds even when the text labels itself a "secret", says it is "hidden" or "guarded", or says "the party has not learned it". That wording describes the wider world, not this asker; the fact that it was provided means the character HAS learned it. Never refuse to state something, and never say the character doesn't know it, when it is present in the provided material.
- An entry marked as someone's OWN NOTE is written in that person's voice: their "I" means them, not the asker. Knowing about it is not having done it. Say what THEY did — "Morwyn found a copper ring" — and never turn their "I" into the asker's "you".
- If the answer is genuinely not supported by what's provided, say the asker's character has no knowledge of it. Never speculate or draw on outside knowledge.
- NEVER imply that information exists but is hidden or withheld. If it isn't provided, then from the asker's perspective it simply is not known — answer as if that is the whole truth.
- Be concise and in-world. Never name the documents, files or entries you drew on: sources are for the DM only, and a document's name can give away what its contents don't.`;

// DM view: the asker OWNS all of this, including their private notes. Report everything.
const SYSTEM_DM = `You are the campaign memory, answering the DUNGEON MASTER — the author and owner of this campaign's material, private DM-only notes and secrets included.
Use ONLY the knowledge entries and document excerpts provided in the user's message.
Rules:
- Report everything the provided material contains, plainly and completely. The asker IS the DM, so DM-only notes and secrets are theirs to see — never withhold, redact, or hedge them. If a document is marked "DM only", that is exactly who is asking.
- If the answer is not supported by what's provided, say so plainly. Never speculate or draw on outside knowledge.
- Be concise. Note which entries or documents you drew on (by title) in parentheses.`;

// DM view when the question names someone or something in the campaign graph: a briefing, not a
// summary. Scott, after a live session: it needs to "pull everything when he asks and give him the
// full context" — so completeness beats brevity here.
const SYSTEM_DM_BRIEFING = `You are the campaign memory, briefing the DUNGEON MASTER on a subject from their campaign. The DM owns all of this material, private notes and secrets included — never withhold, redact or hedge.

You are given everything the campaign's records hold about the subject: its connections, the facts and document passages that mention it, anything said about it at the table, and which players have been told what.

Write a complete briefing from that material — the DM is asking because they need all of it, so do not summarise it away. Use short headed sections, skipping any with nothing in it:
- Who or what it is
- Connections — people, places, factions and things it's tied to, and how
- History — what has happened involving it, in order, naming the session or document section when the material does
- Secrets and hidden details
- What the players know — by character, from what they've been told and what was said at the table
- Open threads — unresolved questions, debts, plans, loose ends

Use ONLY the material provided. Never speculate or draw on outside knowledge. If the material disagrees with itself, say so and give both versions. After each section, note in parentheses the documents it drew on.`;

export interface AskResult {
  answer: string;
  sources: { title: string; type: string }[];
}

/** Log an ask for history + in-house eval. Best-effort — never breaks answering. */
async function logAsk(
  viewer: Viewer,
  question: string,
  result: AskResult,
  askedByMembershipId?: string,
): Promise<void> {
  try {
    await prisma.askLog.create({
      data: {
        campaignId: viewer.campaignId,
        askedByMembershipId: askedByMembershipId ?? null,
        characterId: viewer.characterId,
        role: viewer.role,
        question,
        answer: result.answer,
        sources: result.sources,
      },
    });
  } catch (err) {
    console.error("askLog write failed:", err);
  }
}

/**
 * Answer from the viewer's whole permitted library rather than from retrieved fragments.
 *
 * The shared block is marked for caching: it is byte-identical between calls for everyone in the
 * campaign, so the second question of a session re-reads it at a fraction of the price. The
 * personal block is never cached — it differs per viewer, and a shared cache holding one
 * character's secrets is exactly the leak the permission spine exists to prevent.
 */
async function askFromCorpus(
  viewer: Viewer,
  question: string,
  corpus: Corpus,
  opts: { askedByMembershipId?: string; log?: boolean },
): Promise<AskResult> {
  const blocks: Anthropic.TextBlockParam[] = [];
  if (corpus.shared) {
    blocks.push({
      type: "text",
      text: `Campaign material:\n\n${corpus.shared}`,
      // An hour, not the default five minutes. A table asks a question, plays for twenty
      // minutes, then asks another — at five minutes the cache is cold nearly every time and
      // each question pays the full write. The longer write costs 2x base instead of 1.25x and
      // reads stay at a tenth, so one write per session beats ten.
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  }
  if (corpus.personal) {
    blocks.push({
      type: "text",
      text: `Known to the asker alone:\n\n${corpus.personal}`,
    });
  }
  blocks.push({ type: "text", text: `Question: ${question}` });

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const started = Date.now();
  const msg = await client.messages.create({
    model: CORPUS_MODEL,
    max_tokens: 800,
    system: viewer.role === "DM" ? SYSTEM_DM : SYSTEM_PLAYER,
    messages: [{ role: "user", content: blocks }],
  });
  // What this actually cost, so the decision to send a whole library can be judged on numbers
  // rather than assumed. A cache read is a fraction of the price of the same tokens uncached.
  const usage = msg.usage as Anthropic.Usage & {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  console.log(
    `[corpus ask] ${corpus.manifest.documents.length} docs, ${corpus.manifest.factCount} facts, ` +
      `in=${usage.input_tokens} cacheWrite=${usage.cache_creation_input_tokens ?? 0} ` +
      `cacheRead=${usage.cache_read_input_tokens ?? 0} out=${usage.output_tokens} ` +
      `${Date.now() - started}ms`,
  );

  const answer = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const result: AskResult = {
    answer,
    sources: corpus.manifest.documents.map((name) => ({
      title: name,
      type: "DOCUMENT",
    })),
  };
  if (opts.log !== false)
    await logAsk(viewer, question, result, opts.askedByMembershipId);
  return result;
}

export async function ask(
  viewer: Viewer,
  question: string,
  opts: { askedByMembershipId?: string } = {},
): Promise<AskResult> {
  // A question naming someone or something in the campaign graph gets everything about it,
  // gathered by code. Anything else — and any failure, including a campaign whose graph hasn't
  // been built — falls through to reading the whole library, exactly as before.
  //
  // DM only, for now. Gathering everything about an entity joins up all its names, and for a player
  // that join can be the spoiler: asking about "the Widow" and getting Moira's history reveals they
  // are the same person. Players need a rule for which names their character knows first.
  //
  // Only when the DM asks for the whole picture. A pointed question — "what's Morwyn's mother's name
  // and how did she die?" — is not a request for everything about Morwyn: the briefing answers the
  // wrong question, at length, and can miss the answer entirely when it's written about the mother
  // in passages that never mention Morwyn. Those go to the full library, which reads everything.
  if (viewer.role === "DM" && wantsBriefing(question)) {
    try {
      const subject = await gatherSubjectContext(viewer, question);
      if (subject) return await askFromSubject(viewer, question, subject, opts);
    } catch (err) {
      console.error("[graph ask] falling back to the full library:", err);
    }
  }

  // A specific question about someone or something in the graph: follow the links to the answer
  // (find them, follow their relationships, look up the detail) instead of reading everything. The
  // agent can still ask for the whole library, and any failure falls through to it.
  if (viewer.role === "DM") {
    try {
      if ((await questionEntities(viewer, question)).length > 0) {
        const graph = await answerWithGraph(viewer, question);
        console.log(
          `[graph agent] steps=${graph.steps} tools=${graph.tools.join(",")} ` +
            `in=${graph.usage.input} out=${graph.usage.output} answered=${graph.answer !== null}`,
        );
        if (graph.answer) {
          const result: AskResult = {
            answer: graph.answer,
            sources: graph.documents.map((title) => ({
              title,
              type: "DOCUMENT",
            })),
          };
          await logAsk(viewer, question, result, opts.askedByMembershipId);
          return result;
        }
      }
    } catch (err) {
      console.error("[graph agent] falling back to the full library:", err);
    }
  }

  // Read the whole library when it fits.
  //
  // Retrieval hands the model a handful of pieces chosen by similarity, which is exactly the
  // step that gets "Moira" and "Morwyn" confused, or session 1 and session 81. When the viewer's
  // permitted material fits in a prompt there is no reason to choose for the model at all — give
  // it everything it may see and let it read. Retrieval stays as the path for a library too big
  // to hand over whole, and for anything the corpus had to leave out.
  const corpus = await buildCorpus(viewer);
  if (corpus.manifest.complete && corpus.manifest.tokens > 0) {
    return askFromCorpus(viewer, question, corpus, opts);
  }

  const { units, chunks } = await retrieveContext(viewer, question);

  // Nothing retrieved → nothing to ground on. Skip the model and return a canned line
  // (no cost, no chance of the LLM hinting that hidden knowledge exists).
  if (units.length === 0 && chunks.length === 0) {
    const result: AskResult = {
      answer: noKnowledgeReply(viewer.role),
      sources: [],
    };
    await logAsk(viewer, question, result, opts.askedByMembershipId);
    return result;
  }

  const unitLines = units.map((u, i) => {
    // Journal notes are written in the first person, so a shared one has to say whose it is or
    // the answer will hand the asker someone else's experience as their own.
    const by = u.authorName
      ? ` — ${u.authorName}'s own note, in their words`
      : "";
    return `[U${i + 1}] ${u.title} (${u.type}${by}): ${u.content}`;
  });
  const chunkLines = chunks.map(
    (c, i) => `[D${i + 1}] from "${c.docName}": ${c.text}`,
  );
  const sections: string[] = [];
  if (unitLines.length)
    sections.push(
      `Knowledge entries the asker may know:\n${unitLines.join("\n")}`,
    );
  if (chunkLines.length)
    sections.push(`Relevant document excerpts:\n${chunkLines.join("\n")}`);
  const context =
    sections.join("\n\n") ||
    "(no relevant knowledge is available to this character)";

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: viewer.role === "DM" ? SYSTEM_DM : SYSTEM_PLAYER,
    messages: [
      { role: "user", content: `${context}\n\nQuestion: ${question}` },
    ],
  });

  const answer = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const result: AskResult = {
    answer,
    sources: [
      ...units.map((u) => ({ title: u.title, type: u.type })),
      ...chunks.map((c) => ({ title: c.docName, type: "DOCUMENT" })),
    ],
  };
  await logAsk(viewer, question, result, opts.askedByMembershipId);
  return result;
}

async function askFromSubject(
  viewer: Viewer,
  question: string,
  subject: SubjectContext,
  opts: { askedByMembershipId?: string },
): Promise<AskResult> {
  const material = [
    subject.text,
    subject.corpus.shared,
    subject.corpus.personal,
  ]
    .filter(Boolean)
    .join("\n\n");
  const client = new Anthropic();
  const started = Date.now();
  const msg = await client.messages
    .stream({
      model: CORPUS_MODEL,
      // A briefing can be long, and max_tokens covers thinking too; a player's answer stays short.
      max_tokens: viewer.role === "DM" ? 16000 : 4000,
      system: viewer.role === "DM" ? SYSTEM_DM_BRIEFING : SYSTEM_PLAYER,
      messages: [
        {
          role: "user",
          content: `Campaign material:\n\n${material}\n\nQuestion: ${question}`,
        },
      ],
    })
    .finalMessage();
  console.log(
    `[graph ask] subjects=${subject.subjects.length} docs=${subject.corpus.manifest.documents.length} ` +
      `facts=${subject.corpus.manifest.factCount} passages=${subject.corpus.manifest.passageCount} ` +
      `in=${msg.usage.input_tokens} out=${msg.usage.output_tokens} stop=${msg.stop_reason} ` +
      `${Date.now() - started}ms`,
  );
  const answer = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  const result: AskResult = {
    answer: answer || noKnowledgeReply(viewer.role),
    sources: subject.corpus.manifest.documents.map((name) => ({
      title: name,
      type: "DOCUMENT",
    })),
  };
  await logAsk(viewer, question, result, opts.askedByMembershipId);
  return result;
}

/** The full-library answer on its own, without logging — for comparing answering strategies. */
export async function answerFromLibrary(
  viewer: Viewer,
  question: string,
): Promise<AskResult | null> {
  const corpus = await buildCorpus(viewer);
  if (!corpus.manifest.complete || corpus.manifest.tokens === 0) return null;
  return askFromCorpus(viewer, question, corpus, { log: false });
}
