// The campaign graph — who and what the campaign talks about, and how they're connected.
//
// Built the way sources are: a model proposes, code decides. The model names entities and the
// relationships a document states, each pinned to exact words in a passage. Code keeps an entity
// only if its name really appears in the words quoted for it, an alias only if the document
// actually uses it, and a relationship only if its quote is verbatim and both ends are named in
// that passage. Which facts and passages are about an entity is then worked out by code from
// names alone — no model choosing — so asking about someone can gather everything about them.
//
// Documents are read in windows of passages, so a long notebook is never one enormous reply, and
// every window's entities are merged into one list before relationships are read.

import Anthropic from "@anthropic-ai/sdk";
import {
  locateQuote,
  type ProvenancePassage,
  type RejectReason,
} from "./provenance.js";

export const GRAPH_MODEL = "claude-sonnet-5";

/** Passages per call. A window is a few thousand words — small enough that nothing is skimmed. */
export const GRAPH_WINDOW = 40;

export const ENTITY_KINDS = [
  "PERSON",
  "PLACE",
  "FACTION",
  "ITEM",
  "CREATURE",
  "OTHER",
] as const;
export type EntityKindName = (typeof ENTITY_KINDS)[number];

const MAX_NAME = 80;
const MAX_RELATION = 60;

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

/** The form names are compared in: accents and punctuation folded, case ignored, a leading "the"
 * dropped. Exact after that — "Moira" and "Morwyn" never meet. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

function normalizedText(text: string): string {
  return ` ${normalizeName(text)} `;
}

/** Whether any of these names occurs in the text as whole words. */
export function nameAppears(names: string[], text: string): boolean {
  const hay = normalizedText(text);
  return names.some((n) => {
    const needle = normalizeName(n);
    return needle.length > 0 && hay.includes(` ${needle} `);
  });
}

// ── Entities ─────────────────────────────────────────────────────────────────────────────────────

export interface Evidence {
  passageId: string;
  quote: string;
}

export interface GraphEntity {
  kind: EntityKindName;
  name: string;
  /** Every name it goes by, the primary name first. Unique by normalized form. */
  aliases: string[];
  evidence: Evidence[];
}

export type EntityRejectReason = RejectReason | "no-name" | "name-not-in-quote";

export interface EntityVerification {
  entities: GraphEntity[];
  rejected: Record<string, number>;
  droppedAliases: number;
}

function uniqueByNormal(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const key = normalizeName(n);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(n.trim());
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Keep the proposed entities whose names really appear in the words quoted for them. An alias is
 * kept only if the document uses it somewhere — an invented alias would wrongly match passages. */
export function verifyEntities(
  input: unknown,
  passages: Map<string, ProvenancePassage>,
): EntityVerification {
  const rejected: Record<string, number> = {};
  const reject = (r: string) => (rejected[r] = (rejected[r] ?? 0) + 1);
  const docText = [...passages.values()].map((p) => normalizedText(p.text));
  const usedInDocument = (alias: string) => {
    const needle = ` ${normalizeName(alias)} `;
    return needle.trim().length > 0 && docText.some((t) => t.includes(needle));
  };

  const entities: GraphEntity[] = [];
  let droppedAliases = 0;
  const list = (input as { entities?: unknown })?.entities;
  for (const raw of Array.isArray(list) ? list : []) {
    const item = raw as Record<string, unknown>;
    const name = str(item.name);
    if (!normalizeName(name) || name.length > MAX_NAME) {
      reject("no-name");
      continue;
    }
    const located = locateQuote(str(item.quote), passages, str(item.passage));
    if ("reason" in located) {
      reject(located.reason);
      continue;
    }
    const proposedAliases = Array.isArray(item.aliases)
      ? item.aliases.map(str).filter((a) => a && a.length <= MAX_NAME)
      : [];
    const aliases = uniqueByNormal([name, ...proposedAliases]).filter(
      (a, i) => i === 0 || usedInDocument(a),
    );
    droppedAliases +=
      uniqueByNormal([name, ...proposedAliases]).length - aliases.length;
    if (!nameAppears(aliases, str(item.quote))) {
      reject("name-not-in-quote");
      continue;
    }
    const kind = ENTITY_KINDS.includes(
      str(item.kind).toUpperCase() as EntityKindName,
    )
      ? (str(item.kind).toUpperCase() as EntityKindName)
      : "OTHER";
    entities.push({
      kind,
      name,
      aliases,
      evidence: [{ passageId: located.passage.id, quote: str(item.quote) }],
    });
  }
  return { entities, rejected, droppedAliases };
}

export interface MergeResult {
  entities: GraphEntity[];
  /** Aliases shared by two differently-named entities: removed from both rather than guessed. */
  ambiguousAliases: string[];
}

/** Fold entities that are the same: the same primary name, or one's primary name is another's
 * alias. Two entities that merely share a secondary alias ("the Captain") are NOT merged — that
 * alias is ambiguous and is dropped from both, because merging two people is far worse than
 * missing a nickname. */
export function mergeEntities(entities: GraphEntity[]): MergeResult {
  const merged: GraphEntity[] = [];
  const byPrimary = new Map<string, GraphEntity>();

  const absorb = (into: GraphEntity, from: GraphEntity) => {
    into.aliases = uniqueByNormal([...into.aliases, ...from.aliases]);
    const seen = new Set(into.evidence.map((e) => `${e.passageId}:${e.quote}`));
    for (const e of from.evidence)
      if (!seen.has(`${e.passageId}:${e.quote}`)) into.evidence.push(e);
  };

  for (const entity of entities) {
    const copy: GraphEntity = {
      ...entity,
      aliases: [...entity.aliases],
      evidence: [...entity.evidence],
    };
    const primary = normalizeName(copy.name);
    const target =
      byPrimary.get(primary) ??
      merged.find((m) => m.aliases.some((a) => normalizeName(a) === primary)) ??
      copy.aliases
        .map((a) => byPrimary.get(normalizeName(a)))
        .find((m): m is GraphEntity => m !== undefined);
    if (target) {
      absorb(target, copy);
    } else {
      merged.push(copy);
      byPrimary.set(primary, copy);
    }
  }

  // A secondary alias claimed by more than one entity is ambiguous.
  const owners = new Map<string, Set<GraphEntity>>();
  for (const m of merged)
    for (const a of m.aliases.slice(1)) {
      const key = normalizeName(a);
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key)!.add(m);
    }
  const primaries = new Set(merged.map((m) => normalizeName(m.name)));
  const ambiguous = [...owners]
    .filter(
      ([key, set]) => set.size > 1 || (primaries.has(key) && set.size > 0),
    )
    .map(([key]) => key);
  const drop = new Set(ambiguous);
  for (const m of merged)
    m.aliases = [
      m.aliases[0]!,
      ...m.aliases.slice(1).filter((a) => !drop.has(normalizeName(a))),
    ];

  return { entities: merged, ambiguousAliases: ambiguous };
}

export function renderEntities(entities: GraphEntity[]): {
  text: string;
  index: Map<string, GraphEntity>;
} {
  const index = new Map<string, GraphEntity>();
  const lines = entities.map((e, i) => {
    const label = `E${i + 1}`;
    index.set(label, e);
    const also = e.aliases.slice(1);
    return `[${label}] ${e.name} (${e.kind}${also.length ? `; also called ${also.join(", ")}` : ""})`;
  });
  return { text: lines.join("\n"), index };
}

// ── Relationships ────────────────────────────────────────────────────────────────────────────────

export interface GraphRelation {
  subject: GraphEntity;
  relation: string;
  object: GraphEntity;
  evidence: Evidence;
}

/** Keep relationships whose quote is verbatim and whose passage names both ends. The quote may say
 * "she" — the passage must still name who "she" is, or the link is a guess. */
export function verifyRelations(
  input: unknown,
  passages: Map<string, ProvenancePassage>,
  entities: Map<string, GraphEntity>,
): { relations: GraphRelation[]; rejected: Record<string, number> } {
  const rejected: Record<string, number> = {};
  const reject = (r: string) => (rejected[r] = (rejected[r] ?? 0) + 1);
  const relations: GraphRelation[] = [];
  const seen = new Set<string>();

  const list = (input as { relations?: unknown })?.relations;
  for (const raw of Array.isArray(list) ? list : []) {
    const item = raw as Record<string, unknown>;
    const subject = entities.get(str(item.subject).toUpperCase());
    const object = entities.get(str(item.object).toUpperCase());
    if (!subject || !object) {
      reject("unknown-entity");
      continue;
    }
    if (subject === object) {
      reject("self-relation");
      continue;
    }
    const relation = str(item.relation).toLowerCase().replace(/\s+/g, " ");
    if (!relation || relation.length > MAX_RELATION) {
      reject("bad-relation");
      continue;
    }
    const located = locateQuote(str(item.quote), passages, str(item.passage));
    if ("reason" in located) {
      reject(located.reason);
      continue;
    }
    if (
      !nameAppears(subject.aliases, located.passage.text) ||
      !nameAppears(object.aliases, located.passage.text)
    ) {
      reject("ends-not-named");
      continue;
    }
    const key = `${normalizeName(subject.name)}|${relation}|${normalizeName(object.name)}|${located.passage.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relations.push({
      subject,
      relation,
      object,
      evidence: { passageId: located.passage.id, quote: str(item.quote) },
    });
  }
  return { relations, rejected };
}

// ── Links worked out by code ─────────────────────────────────────────────────────────────────────

/** Which passages mention each entity by any of its names. */
export function findMentions(
  entities: GraphEntity[],
  passages: ProvenancePassage[],
): Map<GraphEntity, string[]> {
  const texts = passages.map((p) => ({
    id: p.id,
    hay: normalizedText(p.text),
  }));
  const out = new Map<GraphEntity, string[]>();
  for (const e of entities) {
    const needles = e.aliases
      .map((a) => ` ${normalizeName(a)} `)
      .filter((n) => n.trim());
    out.set(
      e,
      texts
        .filter((t) => needles.some((n) => t.hay.includes(n)))
        .map((t) => t.id),
    );
  }
  return out;
}

/** Which entities each fact is about: its title names one, or its text mentions one. Extraction
 * titles a fact with its subject's name, so the title is the strong signal. */
export function factsAbout(
  entities: GraphEntity[],
  facts: { id: string; title: string; content: string }[],
): Map<string, GraphEntity[]> {
  const out = new Map<string, GraphEntity[]>();
  for (const f of facts) {
    const about = entities.filter((e) =>
      nameAppears(e.aliases, `${f.title} ${f.content}`),
    );
    if (about.length) out.set(f.id, about);
  }
  return out;
}

// ── Model calls ──────────────────────────────────────────────────────────────────────────────────

export function windows<T>(items: T[], size = GRAPH_WINDOW): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** Render a window of a document with its document-wide labels, so a label means the same passage
 * in every call. */
export function renderWindow(
  window: ProvenancePassage[],
  labels: Map<string, ProvenancePassage>,
): string {
  const labelOf = new Map([...labels].map(([l, p]) => [p.id, l]));
  return window.map((p) => `[${labelOf.get(p.id)}] ${p.text}`).join("\n\n");
}

const ENTITY_SYSTEM = `You are mapping a tabletop RPG campaign. You are given part of one of the DM's documents, split into labelled passages, and a list of entities already found elsewhere.

List every named person, place, faction or organisation, notable item, and named creature in these passages that the campaign cares about. Skip generic unnamed things ("a guard", "the tavern") unless the text treats them as a specific, recurring one.

For each, record with record_entities:
- name: as the text writes it. If it is an entity already listed, use exactly that listed name.
- kind: PERSON, PLACE, FACTION, ITEM, CREATURE or OTHER.
- aliases: other names, titles or spellings THESE passages use for the same one. Only ones the text actually uses. Never include pronouns.
- passage and quote: one passage label, and words copied exactly from that passage that name it (under 300 characters).

Never invent a label, a name or an alias. If two names might be the same entity but the text doesn't make it clear, list them separately.`;

const RELATION_SYSTEM = `You are mapping how the people, places and things in a tabletop RPG campaign are connected. You are given part of one of the DM's documents, split into labelled passages, and the list of entities [E1], [E2], … in the campaign.

Record, with record_relations, every relationship these passages STATE between two listed entities: family, alliance, enmity, leadership, membership, ownership, location, employment, a debt, a killing, a secret one keeps about another — whatever the text says.

For each:
- subject and object: entity labels.
- relation: a short phrase reading "subject relation object" — present tense unless it happened once ("leads", "is sister of", "lives in", "killed", "owes money to"). At most six words.
- passage and quote: one passage label, and words copied exactly from that passage that state it (under 300 characters).

Only what the passages state, not what you infer. Never invent a label.`;

const ENTITY_TOOL: Anthropic.Tool = {
  name: "record_entities",
  description: "Record the named entities in these passages.",
  input_schema: {
    type: "object",
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            kind: { type: "string", enum: [...ENTITY_KINDS] },
            aliases: { type: "array", items: { type: "string" } },
            passage: { type: "string" },
            quote: { type: "string" },
          },
          required: ["name", "kind", "passage", "quote"],
        },
      },
    },
    required: ["entities"],
  },
};

const RELATION_TOOL: Anthropic.Tool = {
  name: "record_relations",
  description:
    "Record the relationships these passages state between listed entities.",
  input_schema: {
    type: "object",
    properties: {
      relations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            subject: { type: "string" },
            relation: { type: "string" },
            object: { type: "string" },
            passage: { type: "string" },
            quote: { type: "string" },
          },
          required: ["subject", "relation", "object", "passage", "quote"],
        },
      },
    },
    required: ["relations"],
  },
};

export interface GraphUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

async function callTool(
  client: Anthropic,
  system: string,
  tool: Anthropic.Tool,
  listText: string,
  passagesText: string,
): Promise<{ input: unknown; usage: GraphUsage; stopReason: string | null }> {
  const msg = await client.messages
    .stream({
      model: GRAPH_MODEL,
      max_tokens: 32000,
      // The entity list comes first and is cached: it's the same for every window of a pass.
      system: [
        { type: "text", text: system },
        {
          type: "text",
          text: listText,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: `The passages:\n\n${passagesText}` }],
    })
    .finalMessage();
  const block = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  const u = msg.usage as Anthropic.Usage & {
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  return {
    input: block?.input ?? null,
    stopReason: msg.stop_reason,
    usage: {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    },
  };
}

export function proposeEntities(
  client: Anthropic,
  known: GraphEntity[],
  passagesText: string,
) {
  const list = known.length
    ? `Entities already found:\n${renderEntities(known).text}`
    : "No entities found yet.";
  return callTool(client, ENTITY_SYSTEM, ENTITY_TOOL, list, passagesText);
}

export function proposeRelations(
  client: Anthropic,
  entitiesText: string,
  passagesText: string,
) {
  return callTool(
    client,
    RELATION_SYSTEM,
    RELATION_TOOL,
    `The campaign's entities:\n${entitiesText}`,
    passagesText,
  );
}
