// Answer a specific question by following the campaign graph, hop by hop.
//
// "What's Morwyn's mother's name, and how did she die?" is three short hops — find Morwyn, follow
// her relationships to her mother, look up how the mother died — not one enormous read. The model
// gets a few tools over the campaign's records and decides which hops to make, within a small
// budget of steps. Everything a tool returns is filtered to what the asker may see, in code; the
// model never sees the rest. When the targeted tools come up empty, it can ask to read the whole
// library, and the question is answered that way instead.

import Anthropic from "@anthropic-ai/sdk";
import { canView, type Viewer } from "@hearth/core";
import { prisma } from "@hearth/db";
import { CORPUS_MODEL, loadCorpusMaterial } from "./corpus.js";
import { withShortNames } from "./graph-context.js";
import { normalizeName } from "./graph.js";
import { retrieveContext } from "./retrieve.js";

/** Tool rounds before the model must answer with what it has. */
export const MAX_STEPS = 6;
const MAX_LIST = 40;
const MAX_PASSAGES = 6;

const SYSTEM_DM = `You answer the DUNGEON MASTER's question about their campaign, using tools over the campaign's records. The DM owns all of this material, secrets included: never withhold or hedge.

Work like a researcher following links, not a reader skimming everything:
1. find_entity for each person, place or thing the question names.
2. connections to follow relationships. They're directional ("X is mother of Y" is stored on both X and Y) — read the relation, and follow it to the entity the answer is actually about. For "Morwyn's mother", that's the mother, not Morwyn.
3. facts and passages for that entity. Give passages a few words to look for (for how someone died: died, death, killed, slain, buried) to get just the relevant text.
4. If the graph has no link, try passages of the entity you do have, with words for what you're after, then search.
5. read_everything only when targeted tools can't find it.

Stop as soon as you can answer. Then write:
- First, the direct answer to exactly what was asked, in a sentence or two.
- Then only the supporting detail that matters.
- Then a line starting "Sources:" naming the documents and quoting the few words each answer rests on.
If the records don't say, say so plainly and name what you checked. Use only what the tools return; never speculate or draw on outside knowledge.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "find_entity",
    description:
      "Find people, places, factions, items or creatures in the campaign by name, nickname or partial name. Returns handles like #1 to use with the other tools.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "connections",
    description:
      "Relationships of an entity, in both directions, each with the words that state it. Optionally narrow with a filter matched against the relation and the other entity's name (e.g. 'mother', 'leads').",
    input_schema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "A handle like #1." },
        filter: { type: "string" },
      },
      required: ["entity"],
    },
  },
  {
    name: "facts",
    description: "Short facts recorded about an entity.",
    input_schema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "A handle like #1." },
      },
      required: ["entity"],
    },
  },
  {
    name: "passages",
    description:
      "The campaign's own text wherever it mentions an entity. Give words to keep only passages containing any of them (word beginnings match: 'die' finds 'died').",
    input_schema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "A handle like #1." },
        words: { type: "array", items: { type: "string" } },
      },
      required: ["entity"],
    },
  },
  {
    name: "search",
    description:
      "Search all of the campaign's records by meaning and exact words, for when the graph has no link.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "read_everything",
    description:
      "Give up on targeted lookups and answer from the whole library instead. Last resort.",
    input_schema: { type: "object", properties: {} },
  },
];

interface AgentState {
  viewer: Viewer;
  handles: Map<string, string>; // "#1" → entity id
  handleOf: Map<string, string>; // entity id → "#1"
  aliases: { entityId: string; alias: string }[] | null;
  documents: Set<string>;
}

function handle(state: AgentState, entityId: string): string {
  let h = state.handleOf.get(entityId);
  if (!h) {
    h = `#${state.handles.size + 1}`;
    state.handles.set(h, entityId);
    state.handleOf.set(entityId, h);
  }
  return h;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function visibleChunks(viewer: Viewer, chunkIds: string[]) {
  if (chunkIds.length === 0) return [];
  const { chunks } = await loadCorpusMaterial(viewer, {
    unitIds: [],
    chunkIds,
  });
  return chunks.filter((c) => canView(viewer, c));
}

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────

async function findEntity(state: AgentState, name: string): Promise<string> {
  const q = normalizeName(name);
  if (!q) return "Give a name to look for.";
  state.aliases ??= withShortNames(
    await prisma.entityAlias.findMany({
      where: { campaignId: state.viewer.campaignId },
      select: { entityId: true, alias: true },
    }),
  );
  const score = new Map<string, number>();
  for (const a of state.aliases) {
    const n = normalizeName(a.alias);
    const s =
      n === q
        ? 3
        : n.length >= 4 && ` ${q} `.includes(` ${n} `)
          ? 2
          : q.length >= 4 && n.includes(q)
            ? 1
            : 0;
    if (s > (score.get(a.entityId) ?? 0)) score.set(a.entityId, s);
  }
  const ids = [...score]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id]) => id);
  if (ids.length === 0)
    return `No entity in the graph matches "${name}". Try search.`;
  const rows = await prisma.entity.findMany({
    where: { id: { in: ids }, campaignId: state.viewer.campaignId },
    select: {
      id: true,
      name: true,
      kind: true,
      aliases: { select: { alias: true } },
    },
  });
  return ids
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => {
      const also = [...new Set(r.aliases.map((a) => a.alias))].filter(
        (a) => a !== r.name,
      );
      return `${handle(state, r.id)} ${r.name} (${r.kind.toLowerCase()}${also.length ? `; also called ${also.join(", ")}` : ""})`;
    })
    .join("\n");
}

async function connections(
  state: AgentState,
  entity: string,
  filter: string,
): Promise<string> {
  const id = state.handles.get(entity);
  if (!id) return `Unknown handle ${entity}. Use find_entity first.`;
  const rows = await prisma.entityRelation.findMany({
    where: {
      campaignId: state.viewer.campaignId,
      OR: [{ subjectId: id }, { objectId: id }],
    },
    select: {
      subjectId: true,
      objectId: true,
      relation: true,
      subject: { select: { name: true } },
      object: { select: { name: true } },
      sources: {
        select: {
          quote: true,
          documentChunkId: true,
          transcriptSegmentId: true,
        },
      },
    },
  });
  const f = normalizeName(filter);
  const matching = rows.filter(
    (r) =>
      !f ||
      normalizeName(
        `${r.relation} ${r.subject.name} ${r.object.name}`,
      ).includes(f),
  );
  const chunkIds = [
    ...new Set(
      matching.flatMap((r) =>
        r.sources.flatMap((s) =>
          s.documentChunkId ? [s.documentChunkId] : [],
        ),
      ),
    ),
  ];
  const visible = new Map(
    (await visibleChunks(state.viewer, chunkIds)).map((c) => [c.id, c]),
  );
  const lines: string[] = [];
  for (const r of matching) {
    // Shown only if the asker can see words that state it; table talk was heard by everyone.
    const source =
      r.sources.find(
        (s) => s.documentChunkId && visible.has(s.documentChunkId),
      ) ?? r.sources.find((s) => s.transcriptSegmentId);
    if (!source) continue;
    const where = source.documentChunkId
      ? visible.get(source.documentChunkId)!.docName
      : "a session transcript";
    if (source.documentChunkId) state.documents.add(where);
    lines.push(
      `${handle(state, r.subjectId)} ${r.subject.name} — ${r.relation} → ${handle(state, r.objectId)} ${r.object.name}  ["${source.quote}", ${where}]`,
    );
    if (lines.length >= MAX_LIST) break;
  }
  return lines.length
    ? lines.join("\n")
    : filter
      ? `No relationships of ${entity} match "${filter}". Try without a filter, or passages.`
      : `No recorded relationships for ${entity}. Try passages or facts.`;
}

async function facts(state: AgentState, entity: string): Promise<string> {
  const id = state.handles.get(entity);
  if (!id) return `Unknown handle ${entity}. Use find_entity first.`;
  const links = await prisma.factEntity.findMany({
    where: { entityId: id },
    select: { knowledgeUnitId: true },
  });
  if (links.length === 0)
    return `No facts recorded about ${entity}. Try passages.`;
  const { units } = await loadCorpusMaterial(state.viewer, {
    unitIds: links.map((l) => l.knowledgeUnitId),
    chunkIds: [],
  });
  const seen = units.filter((u) => canView(state.viewer, u));
  return seen.length
    ? seen
        .slice(0, MAX_LIST)
        .map((u) => `- ${u.title}: ${u.content}`)
        .join("\n") +
        (seen.length > MAX_LIST ? `\n(${seen.length - MAX_LIST} more)` : "")
    : `No facts about ${entity} that can be shown.`;
}

/** Whether a passage contains any of the words, matching word beginnings ("die" → "died"). */
export function containsAnyWord(text: string, words: string[]): boolean {
  const wanted = words.map(normalizeName).filter((w) => w.length >= 3);
  if (wanted.length === 0) return true;
  const tokens = normalizeName(text).split(" ");
  return wanted.some((w) => {
    const parts = w.split(" ");
    if (parts.length > 1) return ` ${tokens.join(" ")} `.includes(` ${w}`);
    return tokens.some((t) => t.startsWith(w));
  });
}

async function passages(
  state: AgentState,
  entity: string,
  words: string[],
): Promise<string> {
  const id = state.handles.get(entity);
  if (!id) return `Unknown handle ${entity}. Use find_entity first.`;
  const mentions = await prisma.entityMention.findMany({
    where: { entityId: id, documentChunkId: { not: null } },
    select: { documentChunkId: true },
  });
  const chunks = (
    await visibleChunks(
      state.viewer,
      mentions.map((m) => m.documentChunkId!),
    )
  )
    .filter((c) => containsAnyWord(c.text, words))
    .sort(
      (a, b) =>
        a.docName.localeCompare(b.docName) || a.chunkIndex - b.chunkIndex,
    );
  if (chunks.length === 0)
    return words.length
      ? `No passages mentioning ${entity} contain ${words.join(", ")}. Try other words, or search.`
      : `No passages mention ${entity}.`;
  const shown = chunks.slice(0, MAX_PASSAGES);
  for (const c of shown) state.documents.add(c.docName);
  return (
    shown
      .map((c) => `[${c.docName}, passage ${c.chunkIndex}]\n${c.text}`)
      .join("\n\n") +
    (chunks.length > MAX_PASSAGES
      ? `\n\n(${chunks.length - MAX_PASSAGES} more passages match — add words to narrow.)`
      : "")
  );
}

async function search(state: AgentState, query: string): Promise<string> {
  const { units, chunks } = await retrieveContext(state.viewer, query, {
    unitLimit: 8,
    chunkLimit: 5,
  });
  for (const c of chunks) state.documents.add(c.docName);
  const parts = [
    ...units.map((u) => `- ${u.title}: ${u.content}`),
    ...chunks.map((c) => `[${c.docName}]\n${c.text}`),
  ];
  return parts.length ? parts.join("\n\n") : `Nothing found for "${query}".`;
}

// ── The loop ─────────────────────────────────────────────────────────────────────────────────────

export interface AgentAnswer {
  /** Null when the agent asked to read the whole library instead. */
  answer: string | null;
  steps: number;
  tools: string[];
  documents: string[];
  usage: { input: number; output: number };
}

export async function answerWithGraph(
  viewer: Viewer,
  question: string,
  client: Anthropic = new Anthropic(),
): Promise<AgentAnswer> {
  const state: AgentState = {
    viewer,
    handles: new Map(),
    handleOf: new Map(),
    aliases: null,
    documents: new Set(),
  };
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: question },
  ];
  const used: string[] = [];
  const usage = { input: 0, output: 0 };

  for (let step = 0; ; step++) {
    const final = step >= MAX_STEPS;
    const msg = await client.messages
      .stream({
        model: CORPUS_MODEL,
        max_tokens: 8000,
        system: SYSTEM_DM,
        tools: TOOLS,
        // Out of steps: answer with what's been found.
        ...(final ? { tool_choice: { type: "none" as const } } : {}),
        messages,
      })
      .finalMessage();
    usage.input += msg.usage.input_tokens;
    usage.output += msg.usage.output_tokens;
    messages.push({ role: "assistant", content: msg.content });

    const calls = msg.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (msg.stop_reason !== "tool_use" || calls.length === 0 || final) {
      const answer = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return {
        answer: answer || null,
        steps: step,
        tools: used,
        documents: [...state.documents],
        usage,
      };
    }
    if (calls.some((c) => c.name === "read_everything")) {
      used.push("read_everything");
      return {
        answer: null,
        steps: step + 1,
        tools: used,
        documents: [],
        usage,
      };
    }

    const results = await Promise.all(
      calls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
        used.push(call.name);
        const input = (call.input ?? {}) as Record<string, unknown>;
        let content: string;
        try {
          content =
            call.name === "find_entity"
              ? await findEntity(state, str(input.name))
              : call.name === "connections"
                ? await connections(state, str(input.entity), str(input.filter))
                : call.name === "facts"
                  ? await facts(state, str(input.entity))
                  : call.name === "passages"
                    ? await passages(
                        state,
                        str(input.entity),
                        Array.isArray(input.words) ? input.words.map(str) : [],
                      )
                    : call.name === "search"
                      ? await search(state, str(input.query))
                      : `Unknown tool ${call.name}.`;
        } catch (err) {
          content = `That lookup failed: ${err instanceof Error ? err.message : "error"}.`;
        }
        return { type: "tool_result", tool_use_id: call.id, content };
      }),
    );
    messages.push({ role: "user", content: results });
  }
}
