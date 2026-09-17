// Compare answering strategies on questions whose answers the campaign's records already hold.
//
// Questions are built from the graph's own verified relationships — "Who is Y's mother?" when the
// records say X is mother of Y; "Where does Y's mother live?" when they also say where X lives — so
// each has a known answer, and grading is code: does the answer name it? Each question goes to the
// graph agent and to the full-library read. Only counts are printed: the people running this may be
// players in the campaign.
//
// Bias to keep in mind: every question comes from a relationship the graph has, which favours the
// graph agent. Questions the graph can't express are not measured here.
//
// Usage:
//   pnpm --filter @hearth/agents graph:eval --campaign <id> [--single 12] [--double 8] [--yes]
//   pnpm --filter @hearth/agents graph:eval --campaign <id> --mode passages [--n 20] [--yes]
//
// The passages mode removes the bias: a model writes one specific question from each of a random
// sample of passages, with the answer that passage gives, and a model judges each answer against the
// passage. Nothing about the question depends on the graph having recorded it.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@hearth/db";
import type { Viewer } from "@hearth/core";
import { answerFromLibrary } from "./ask.js";
import { answerWithGraph } from "./graph-agent.js";
import { questionEntities } from "./graph-context.js";
import { normalizeName, uniqueShortNames, type GraphEntity } from "./graph.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Ent {
  id: string;
  name: string;
  names: string[];
}
interface Rel {
  subject: Ent;
  relation: string;
  object: Ent;
}
export interface EvalQuestion {
  kind: "single" | "double";
  question: string;
  expected: Ent[];
}

const ROLE =
  /^(?:is )?(?:the )?(mother|father|sister|brother|son|daughter|wife|husband|uncle|aunt|grandmother|grandfather|mentor|apprentice) of$/;
const LEADS = /^(leads|rules|commands|founded|owns|runs)$/;
const KILLED = /^(killed|murdered|slew)$/;
const LIVES = /^(lives in|resides in|dwells in)$/;

/** Questions with known answers, grouped so that "who is Y's mother?" accepts any recorded mother. */
export function buildQuestions(relations: Rel[]): EvalQuestion[] {
  const byKey = new Map<string, EvalQuestion>();
  const add = (kind: EvalQuestion["kind"], question: string, answer: Ent) => {
    const q = byKey.get(question) ?? { kind, question, expected: [] };
    if (!q.expected.some((e) => e.id === answer.id)) q.expected.push(answer);
    byKey.set(question, q);
  };
  const livesIn = new Map<string, Ent[]>();
  for (const r of relations)
    if (LIVES.test(r.relation))
      livesIn.set(r.subject.id, [
        ...(livesIn.get(r.subject.id) ?? []),
        r.object,
      ]);

  for (const r of relations) {
    const role = ROLE.exec(r.relation);
    if (role) {
      add("single", `Who is ${r.object.name}'s ${role[1]}?`, r.subject);
      for (const home of livesIn.get(r.subject.id) ?? [])
        add("double", `Where does ${r.object.name}'s ${role[1]} live?`, home);
    } else if (LEADS.test(r.relation)) {
      add("single", `Who ${r.relation} ${r.object.name}?`, r.subject);
    } else if (KILLED.test(r.relation)) {
      add("single", `Who killed ${r.object.name}?`, r.subject);
    } else if (LIVES.test(r.relation)) {
      add("single", `Where does ${r.subject.name} live?`, r.object);
    }
  }
  return [...byKey.values()];
}

/** Whether an answer names any expected entity — by a full name, or a short name only it has. */
export function answerNames(
  answer: string,
  expected: Ent[],
  shortNames: Map<string, string[]>,
): boolean {
  const hay = ` ${normalizeName(answer)} `;
  return expected.some((e) =>
    [...e.names, ...(shortNames.get(e.id) ?? [])].some((n) => {
      const needle = normalizeName(n);
      return needle.length >= 3 && hay.includes(` ${needle} `);
    }),
  );
}

/** A small deterministic shuffle, so reruns ask the same questions. */
function sample<T>(items: T[], n: number, seed = 7): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.slice(0, n);
}

const JUDGE_MODEL = "claude-sonnet-5";

async function forcedTool(
  client: Anthropic,
  system: string,
  tool: Anthropic.Tool,
  content: string,
): Promise<Record<string, unknown> | null> {
  const msg = await client.messages
    .stream({
      model: JUDGE_MODEL,
      max_tokens: 4000,
      system,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content }],
    })
    .finalMessage();
  const block = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  return (block?.input as Record<string, unknown> | undefined) ?? null;
}

/** One specific question the passage answers, naming who or what it's about, with its answer. */
async function questionFromPassage(
  client: Anthropic,
  passage: string,
): Promise<{ question: string; answer: string } | null> {
  const input = await forcedTool(
    client,
    `You write test questions for a tabletop RPG campaign's memory. Given one passage of the DM's notes, write ONE specific question a DM might ask that this passage answers — the kind of detail someone would look up ("How did Elspeth Vane die?", "Who does Tobin owe money to?"). Name the person, place or thing it's about, so the question makes sense without the passage. The answer must be short and stated in the passage. If the passage has no such specific, answerable detail, set skip to true.`,
    {
      name: "record_question",
      description: "Record the question and its answer.",
      input_schema: {
        type: "object",
        properties: {
          skip: { type: "boolean" },
          question: { type: "string" },
          answer: { type: "string" },
        },
        required: ["skip"],
      },
    },
    `Passage:\n\n${passage}`,
  );
  if (!input || input.skip === true) return null;
  const question =
    typeof input.question === "string" ? input.question.trim() : "";
  const answer = typeof input.answer === "string" ? input.answer.trim() : "";
  return question && answer ? { question, answer } : null;
}

type Verdict = "correct" | "partial" | "wrong";

async function judge(
  client: Anthropic,
  question: string,
  reference: string,
  passage: string,
  answer: string,
): Promise<Verdict> {
  const input = await forcedTool(
    client,
    `You grade an answer to a question about a tabletop RPG campaign. You get the question, the reference answer, the passage it comes from, and the answer to grade. correct: it gives the reference answer (wording may differ; extra accurate detail is fine). partial: it gets part of it, or hedges between the right answer and a wrong one. wrong: it misses it, contradicts it, or says the records don't say.`,
    {
      name: "record_verdict",
      description: "Record the grade.",
      input_schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["correct", "partial", "wrong"] },
        },
        required: ["verdict"],
      },
    },
    `Question: ${question}\n\nReference answer: ${reference}\n\nPassage:\n${passage}\n\nAnswer to grade:\n${answer}`,
  );
  const v = input?.verdict;
  return v === "correct" || v === "partial" ? v : "wrong";
}

/** What /ask does for a DM's specific question: the agent when the question names a graph entity
 * (falling back to the library when it comes up empty), otherwise the library. */
async function askedTheWayAskDoes(
  dm: Viewer,
  question: string,
  track: {
    viaAgent: number;
    agentFellBack: number;
    agentUsage: { input: number; output: number };
  },
): Promise<{ answer: string | null; via: "agent" | "library" }> {
  if ((await questionEntities(dm, question)).length > 0) {
    track.viaAgent++;
    const a = await answerWithGraph(dm, question);
    track.agentUsage.input += a.usage.input;
    track.agentUsage.output += a.usage.output;
    if (a.answer) return { answer: a.answer, via: "agent" };
    track.agentFellBack++;
  }
  return {
    answer: (await answerFromLibrary(dm, question))?.answer ?? null,
    via: "library",
  };
}

async function passagesMode(campaignId: string) {
  const n = Number(arg("n") ?? 20);
  const chunks = await prisma.documentChunk.findMany({
    where: { campaignId, supersededByCorrectionId: null },
    select: { id: true, text: true },
  });
  const picked = sample(
    chunks.filter((c) => c.text.length > 400),
    Math.round(n * 1.5), // some passages have nothing specific to ask; they're skipped
  );
  console.log(
    `graph:eval passages: ${chunks.length} passages; trying ${picked.length} to get ${n} questions, ` +
      `each answered the way /ask does it and by the full library, then judged`,
  );
  if (!process.argv.includes("--yes")) {
    console.log(
      `Estimated ~$${(1.1 + n * 0.1).toFixed(2)} (question writing, both answers, two judgements each). Re-run with --yes.`,
    );
    return;
  }

  const client = new Anthropic();
  const dm: Viewer = {
    campaignId,
    role: "DM",
    characterId: null,
    partyId: null,
  };
  const tally = {
    ask: { correct: 0, partial: 0, wrong: 0 },
    library: { correct: 0, partial: 0, wrong: 0 },
    askBetter: 0,
    libraryBetter: 0,
    errors: 0,
  };
  const track = {
    viaAgent: 0,
    agentFellBack: 0,
    agentUsage: { input: 0, output: 0 },
  };
  const rank = { correct: 2, partial: 1, wrong: 0 } as const;
  let asked = 0;
  for (const chunk of picked) {
    if (asked >= n) break;
    try {
      const q = await questionFromPassage(client, chunk.text);
      if (!q) continue;
      asked++;
      const viaAsk = await askedTheWayAskDoes(dm, q.question, track);
      // When /ask itself read the library, that is the library's answer too — no need to pay twice.
      const viaLibrary =
        viaAsk.via === "library"
          ? viaAsk.answer
          : ((await answerFromLibrary(dm, q.question))?.answer ?? null);
      const a = viaAsk.answer
        ? await judge(client, q.question, q.answer, chunk.text, viaAsk.answer)
        : "wrong";
      const l =
        viaAsk.via === "library"
          ? a
          : viaLibrary
            ? await judge(client, q.question, q.answer, chunk.text, viaLibrary)
            : "wrong";
      tally.ask[a]++;
      tally.library[l]++;
      if (rank[a] > rank[l]) tally.askBetter++;
      if (rank[l] > rank[a]) tally.libraryBetter++;
    } catch {
      tally.errors++;
    }
  }
  console.log(
    JSON.stringify(
      {
        questions: asked,
        askAsItWorks: {
          ...tally.ask,
          wentToAgent: track.viaAgent,
          agentFellBackToLibrary: track.agentFellBack,
          agentCost: `$${((track.agentUsage.input * 2 + track.agentUsage.output * 10) / 1e6).toFixed(2)}`,
        },
        libraryOnly: tally.library,
        askBetter: tally.askBetter,
        libraryBetter: tally.libraryBetter,
        errors: tally.errors,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const campaignId = arg("campaign");
  if (!campaignId) throw new Error("--campaign <id> is required");
  if (arg("mode") === "passages") return passagesMode(campaignId);
  const singles = Number(arg("single") ?? 12);
  const doubles = Number(arg("double") ?? 8);

  const entities = await prisma.entity.findMany({
    where: { campaignId },
    select: {
      id: true,
      kind: true,
      name: true,
      aliases: { select: { alias: true } },
    },
  });
  const ents = new Map<string, Ent>(
    entities.map((e) => [
      e.id,
      {
        id: e.id,
        name: e.name,
        names: [e.name, ...e.aliases.map((a) => a.alias)],
      },
    ]),
  );
  const graphEntities: (GraphEntity & { id: string })[] = entities.map((e) => ({
    id: e.id,
    kind: e.kind,
    name: e.name,
    aliases: ents.get(e.id)!.names,
    evidence: [],
  }));
  const short = new Map(
    [...uniqueShortNames(graphEntities)].map(([e, words]) => [
      (e as GraphEntity & { id: string }).id,
      words,
    ]),
  );
  const rows = await prisma.entityRelation.findMany({
    where: { campaignId },
    select: { subjectId: true, relation: true, objectId: true },
  });
  const relations: Rel[] = rows.map((r) => ({
    subject: ents.get(r.subjectId)!,
    relation: r.relation,
    object: ents.get(r.objectId)!,
  }));
  const all = buildQuestions(relations);
  const chosen = [
    ...sample(
      all.filter((q) => q.kind === "single"),
      singles,
    ),
    ...sample(
      all.filter((q) => q.kind === "double"),
      doubles,
    ),
  ];
  console.log(
    `graph:eval: ${all.filter((q) => q.kind === "single").length} one-hop and ` +
      `${all.filter((q) => q.kind === "double").length} two-hop questions available; ` +
      `asking ${chosen.length}, each two ways`,
  );
  if (!process.argv.includes("--yes")) {
    console.log(
      "Estimated ~$" +
        (1.1 + chosen.length * 0.1).toFixed(2) +
        " (one full-library cache write, then ~$0.05 per library answer and ~$0.05 per agent answer). Re-run with --yes.",
    );
    return;
  }

  const dm: Viewer = {
    campaignId,
    role: "DM",
    characterId: null,
    partyId: null,
  };
  const score = {
    agent: {
      single: 0,
      double: 0,
      fellBack: 0,
      failed: 0,
      steps: 0,
      ms: 0,
      input: 0,
      output: 0,
    },
    library: { single: 0, double: 0, failed: 0, ms: 0 },
    agentOnly: 0,
    libraryOnly: 0,
  };
  for (const q of chosen) {
    let agentOk = false;
    let libraryOk = false;
    // When the agent asks for the whole library, /ask answers from it — so that's the agent path's
    // answer too.
    let fellBack = false;
    try {
      const t = Date.now();
      const a = await answerWithGraph(dm, q.question);
      score.agent.ms += Date.now() - t;
      score.agent.steps += a.steps;
      score.agent.input += a.usage.input;
      score.agent.output += a.usage.output;
      if (a.answer === null) {
        score.agent.fellBack++;
        fellBack = true;
      }
      agentOk = a.answer !== null && answerNames(a.answer, q.expected, short);
    } catch {
      score.agent.failed++;
    }
    try {
      const t = Date.now();
      const l = await answerFromLibrary(dm, q.question);
      score.library.ms += Date.now() - t;
      libraryOk = !!l && answerNames(l.answer, q.expected, short);
    } catch {
      score.library.failed++;
    }
    if (fellBack) agentOk = libraryOk;
    if (agentOk) score.agent[q.kind]++;
    if (libraryOk) score.library[q.kind]++;
    if (agentOk && !libraryOk) score.agentOnly++;
    if (libraryOk && !agentOk) score.libraryOnly++;
  }
  const n = {
    single: chosen.filter((q) => q.kind === "single").length,
    double: chosen.filter((q) => q.kind === "double").length,
  };
  console.log(
    JSON.stringify(
      {
        asked: n,
        agent: {
          oneHopCorrect: `${score.agent.single}/${n.single}`,
          twoHopCorrect: `${score.agent.double}/${n.double}`,
          askedForWholeLibrary: score.agent.fellBack,
          errors: score.agent.failed,
          avgToolRounds: +(score.agent.steps / chosen.length).toFixed(1),
          avgSeconds: +(score.agent.ms / chosen.length / 1000).toFixed(1),
          cost: `$${((score.agent.input * 2 + score.agent.output * 10) / 1e6).toFixed(2)}`,
        },
        library: {
          oneHopCorrect: `${score.library.single}/${n.single}`,
          twoHopCorrect: `${score.library.double}/${n.double}`,
          errors: score.library.failed,
          avgSeconds: +(score.library.ms / chosen.length / 1000).toFixed(1),
        },
        rightOnlyWithAgent: score.agentOnly,
        rightOnlyWithLibrary: score.libraryOnly,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1]?.endsWith("graph-eval.ts")) {
  try {
    await main();
  } finally {
    await prisma.$disconnect();
  }
}
