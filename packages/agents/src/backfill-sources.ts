// Backfill provenance for facts that were extracted from documents before sources were recorded.
//
// Two steps, deliberately separate:
//
//   propose  Ask the model for each fact's sources, verify every quote in code, and save the
//            verified result to a local file. Writes nothing to the database. Prints counts only —
//            the campaign's text never reaches the terminal, because the people running this may
//            be players in it.
//
//   apply    Read that file, re-verify each quote against the passage as it is now, add the links,
//            and mark each checked fact SOURCED or UNSOURCED (unsourced facts are not used). Never deletes or recreates a fact or passage: a reveal (KnowledgeGrant) is
//            deleted with either, so rebuilding would silently take back what players already know.
//
// Usage:
//   pnpm --filter @hearth/agents backfill:sources propose --campaign <id> --out <file> [--doc <id>] [--max-docs <n>] [--keep-rejected] [--yes]
//   pnpm --filter @hearth/agents backfill:sources retry   --campaign <id> --in <file> [--doc <id>] [--group-size <n>] [--yes]
//   pnpm --filter @hearth/agents backfill:sources apply   --campaign <id> --in <file>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@hearth/db";
import {
  checkQuote,
  groupFacts,
  proposeSources,
  renderFacts,
  renderPassages,
  verifySources,
  type FoundSource,
  type ProvenanceFact,
  type ProvenancePassage,
  type ProvenanceUsage,
  type RejectReason,
  type RejectedSource,
} from "./provenance.js";
// Sonnet 5, per million tokens. Cache writes here use the 5-minute TTL (1.25x); reads are 0.1x.
import { PRICE } from "./usage.js";

const CHARS_PER_TOKEN = 2.5; // measured against this campaign's corpus; errs high
const CONCURRENCY = 4;
const CONFIRM_ABOVE_DOLLARS = 1;

interface DocResult {
  docId: string;
  passages: number;
  facts: number;
  /** Facts whose group came back — checked, whether or not a source was found. */
  checkedFactIds: string[];
  sources: FoundSource[];
  /** Only with --keep-rejected, for diagnosis. Campaign text — the file stays private. */
  rejectedSources?: RejectedSource[];
  rejected: Record<RejectReason, number>;
  /** Verbatim quotes the model credited to the wrong passage, re-attached by code. */
  relabelled?: number;
  failedGroups: number;
  usage: ProvenanceUsage;
}

interface ResultsFile {
  campaignId: string;
  createdAt: string;
  docs: DocResult[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dollars = (u: ProvenanceUsage) =>
  (u.input * PRICE.input +
    u.output * PRICE.output +
    u.cacheWrite * PRICE.cacheWrite +
    u.cacheRead * PRICE.cacheRead) /
  1_000_000;

const addUsage = (a: ProvenanceUsage, b: ProvenanceUsage): ProvenanceUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
});

const noRejects = (): Record<RejectReason, number> => ({
  "unknown-fact": 0,
  "unknown-passage": 0,
  "too-short": 0,
  "too-long": 0,
  "not-in-passage": 0,
});

// Explicit selects throughout: this must run before the migration is applied, when the
// KnowledgeUnit table doesn't have the new column the generated client knows about.
async function loadDoc(docId: string) {
  const passages: ProvenancePassage[] = await prisma.documentChunk.findMany({
    where: { sourceDocumentId: docId, supersededByCorrectionId: null },
    select: { id: true, chunkIndex: true, text: true },
    orderBy: { chunkIndex: "asc" },
  });
  const facts: ProvenanceFact[] = await prisma.knowledgeUnit.findMany({
    where: { sourceDocumentId: docId, supersededByCorrectionId: null },
    select: { id: true, title: true, content: true },
    orderBy: { createdAt: "asc" },
  });
  return { passages, facts };
}

async function propose(campaignId: string, outPath: string) {
  const only = arg("doc");
  const maxDocs = Number(arg("max-docs") ?? Infinity);
  const docs = await prisma.sourceDocument.findMany({
    where: { campaignId, status: "PARSED", ...(only ? { id: only } : {}) },
    select: { id: true },
  });

  const results: ResultsFile = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, "utf8")) as ResultsFile)
    : { campaignId, createdAt: new Date().toISOString(), docs: [] };
  if (results.campaignId !== campaignId)
    throw new Error(`${outPath} is for another campaign`);
  const done = new Set(results.docs.map((d) => d.docId));

  // Smallest first, so the first document measured is the cheapest one to be wrong about.
  const loaded = [];
  for (const doc of docs) {
    if (done.has(doc.id)) continue;
    loaded.push({ docId: doc.id, ...(await loadDoc(doc.id)) });
  }
  loaded.sort(
    (a, b) =>
      a.passages.reduce((n, p) => n + p.text.length, 0) -
      b.passages.reduce((n, p) => n + p.text.length, 0),
  );
  const todo = loaded.filter((d) => d.facts.length > 0).slice(0, maxDocs);

  // Rough cost before spending anything: one cache write per document, a cached read for every
  // further group, and generous output.
  const estimate = todo.reduce((sum, d) => {
    const docTokens =
      d.passages.reduce((n, p) => n + p.text.length, 0) / CHARS_PER_TOKEN;
    const groups = Math.ceil(d.facts.length / 60);
    return (
      sum +
      dollars({
        cacheWrite: docTokens,
        cacheRead: docTokens * (groups - 1),
        input:
          d.facts.reduce((n, f) => n + f.title.length + f.content.length, 0) /
          CHARS_PER_TOKEN,
        output: d.facts.length * 250,
      })
    );
  }, 0);
  console.log(
    `propose: ${todo.length} document(s), ${todo.reduce((n, d) => n + d.facts.length, 0)} facts, ` +
      `${todo.reduce((n, d) => n + d.passages.length, 0)} passages — estimated ~$${estimate.toFixed(2)}` +
      (done.size ? ` (${done.size} already in ${outPath}, skipped)` : ""),
  );
  if (estimate > CONFIRM_ABOVE_DOLLARS && !process.argv.includes("--yes")) {
    console.log(
      `Over $${CONFIRM_ABOVE_DOLLARS}. Re-run with --yes to spend it.`,
    );
    return;
  }

  const client = new Anthropic();
  let n = done.size;
  for (const doc of todo) {
    n++;
    const passages = renderPassages(doc.passages);
    const groups = groupFacts(doc.facts);
    const result: DocResult = {
      docId: doc.docId,
      passages: doc.passages.length,
      facts: doc.facts.length,
      checkedFactIds: [],
      sources: [],
      rejected: noRejects(),
      failedGroups: 0,
      usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    };

    const runGroup = async (group: ProvenanceFact[]) => {
      const facts = renderFacts(group);
      try {
        const reply = await proposeSources(client, passages.text, facts.text);
        result.usage = addUsage(result.usage, reply.usage);
        if (!reply.input || reply.stopReason === "max_tokens") {
          // A cut-off reply could omit facts it would have linked; don't record them as checked.
          result.failedGroups++;
          console.log(
            `  doc ${n}: a group came back ${reply.stopReason ?? "empty"} — not counted as checked`,
          );
          return;
        }
        const verified = verifySources(
          reply.input,
          passages.index,
          facts.index,
        );
        result.sources.push(...verified.sources);
        result.relabelled = (result.relabelled ?? 0) + verified.relabelled;
        if (process.argv.includes("--keep-rejected"))
          (result.rejectedSources ??= []).push(...verified.rejectedSources);
        for (const [reason, count] of Object.entries(verified.rejected))
          result.rejected[reason as RejectReason] += count;
        result.checkedFactIds.push(...group.map((f) => f.id));
      } catch (err) {
        result.failedGroups++;
        console.log(
          `  doc ${n}: a group failed — ${err instanceof Error ? err.name : "error"}`,
        );
      }
    };

    // The first group writes the document to the cache; the rest then read it, in parallel.
    const started = Date.now();
    await runGroup(groups[0]!);
    const rest = groups.slice(1);
    for (let i = 0; i < rest.length; i += CONCURRENCY) {
      await Promise.all(rest.slice(i, i + CONCURRENCY).map(runGroup));
    }

    results.docs.push(result);
    writeFileSync(outPath, JSON.stringify(results, null, 2)); // after every document: resumable
    report(`doc ${n}`, result, Date.now() - started);
  }

  const total = results.docs.reduce(
    (acc, d) => ({
      facts: acc.facts + d.facts,
      checked: acc.checked + d.checkedFactIds.length,
      linked: acc.linked + new Set(d.sources.map((s) => s.factId)).size,
      sources: acc.sources + d.sources.length,
      usage: addUsage(acc.usage, d.usage),
    }),
    {
      facts: 0,
      checked: 0,
      linked: 0,
      sources: 0,
      usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    },
  );
  console.log(
    `\nall documents in file: facts=${total.facts} checked=${total.checked} ` +
      `linked=${total.linked} (${pct(total.linked, total.checked)}) sources=${total.sources} ` +
      `cost=$${dollars(total.usage).toFixed(2)}`,
  );
}

const pct = (a: number, b: number) =>
  b ? `${Math.round((a / b) * 100)}%` : "n/a";

function report(name: string, d: DocResult, ms: number) {
  const linked = new Set(d.sources.map((s) => s.factId)).size;
  const rejected = Object.entries(d.rejected)
    .filter(([, c]) => c > 0)
    .map(([r, c]) => `${r}=${c}`)
    .join(" ");
  console.log(
    `${name}: passages=${d.passages} facts=${d.facts} checked=${d.checkedFactIds.length} ` +
      `linked=${linked} (${pct(linked, d.checkedFactIds.length)}) unlinked=${d.checkedFactIds.length - linked} ` +
      `sources=${d.sources.length} relabelled=${d.relabelled ?? 0} rejected[${rejected || "none"}] failedGroups=${d.failedGroups} ` +
      `in=${d.usage.input} out=${d.usage.output} cacheWrite=${d.usage.cacheWrite} cacheRead=${d.usage.cacheRead} ` +
      `$${dollars(d.usage).toFixed(2)} ${Math.round(ms / 1000)}s`,
  );
}

async function apply(campaignId: string, inPath: string) {
  const results = JSON.parse(readFileSync(inPath, "utf8")) as ResultsFile;
  if (results.campaignId !== campaignId)
    throw new Error(`${inPath} is for another campaign`);

  let written = 0;
  let stale = 0;
  let sourced = 0;
  let unsourced = 0;
  let unsourcedWithReveals = 0;
  for (const doc of results.docs) {
    // Re-verify against the database as it is now: a passage retired or a fact corrected since
    // the proposal was made must not get a link.
    const { passages, facts } = await loadDoc(doc.docId);
    const passageText = new Map(passages.map((p) => [p.id, p.text]));
    const liveFacts = new Set(facts.map((f) => f.id));
    const keep = doc.sources.filter((s) => {
      const text = passageText.get(s.chunkId);
      const ok =
        liveFacts.has(s.factId) &&
        text !== undefined &&
        checkQuote(s.quote, text) === null;
      if (!ok) stale++;
      return ok;
    });
    // Only facts whose group actually came back are judged. A fact in a failed group stays
    // UNCHECKED — not having been looked at is not the same as having no source.
    const checkedIds = doc.checkedFactIds.filter((id) => liveFacts.has(id));
    const withSource = new Set(keep.map((s) => s.factId));
    const sourcedIds = checkedIds.filter((id) => withSource.has(id));
    const unsourcedIds = checkedIds.filter((id) => !withSource.has(id));

    await prisma.$transaction([
      prisma.factSource.createMany({
        data: keep.map((s) => ({
          knowledgeUnitId: s.factId,
          documentChunkId: s.chunkId,
          quote: s.quote,
        })),
        skipDuplicates: true,
      }),
      prisma.knowledgeUnit.updateMany({
        where: { id: { in: sourcedIds } },
        data: { provenance: "SOURCED" },
      }),
      // Never downgrade a fact that already has a verified source from an earlier run.
      prisma.knowledgeUnit.updateMany({
        where: { id: { in: unsourcedIds }, sources: { none: {} } },
        data: { provenance: "UNSOURCED" },
      }),
    ]);
    written += keep.length;
    sourced += sourcedIds.length;
    unsourced += unsourcedIds.length;
    // A reveal already granted on an unsourced fact is left alone — taking back what a player was
    // told is worse than a doubtful fact they already have — but it's worth knowing about.
    unsourcedWithReveals += await prisma.knowledgeUnit.count({
      where: { id: { in: unsourcedIds }, grants: { some: {} } },
    });
  }
  console.log(
    `apply: sources written=${written} skipped-as-stale=${stale} ` +
      `SOURCED=${sourced} UNSOURCED=${unsourced} unsourced-but-already-revealed=${unsourcedWithReveals}`,
  );
}

/** A second look at facts the first pass left without a source, in small groups. On a large
 * document most unlinked facts had no proposal at all — skipped in a group of sixty, not
 * unsupported — so a narrower ask finds many of them. Adds to the same results file. */
async function retry(campaignId: string, path: string, groupSize: number) {
  const results = JSON.parse(readFileSync(path, "utf8")) as ResultsFile;
  if (results.campaignId !== campaignId)
    throw new Error(`${path} is for another campaign`);

  const work = [];
  const only = arg("doc");
  for (const [i, doc] of results.docs.entries()) {
    if (only && doc.docId !== only) continue;
    const linked = new Set(doc.sources.map((s) => s.factId));
    const { passages, facts } = await loadDoc(doc.docId);
    const unlinked = facts.filter((f) => !linked.has(f.id));
    if (unlinked.length) work.push({ i, doc, passages, unlinked });
  }

  const estimate = work.reduce((sum, w) => {
    const docTokens =
      w.passages.reduce((n, p) => n + p.text.length, 0) / CHARS_PER_TOKEN;
    const groups = Math.ceil(w.unlinked.length / groupSize);
    return (
      sum +
      dollars({
        cacheWrite: docTokens,
        cacheRead: docTokens * (groups - 1),
        input: 0,
        output: w.unlinked.length * 300,
      })
    );
  }, 0);
  console.log(
    `retry: ${work.length} document(s), ${work.reduce((n, w) => n + w.unlinked.length, 0)} unlinked facts, ` +
      `groups of ${groupSize} — estimated ~$${estimate.toFixed(2)}`,
  );
  if (!process.argv.includes("--yes")) {
    console.log("Estimate only. Re-run with --yes to spend it.");
    return;
  }

  const client = new Anthropic();
  let before = 0;
  let after = 0;
  let spent: ProvenanceUsage = {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
  };
  for (const w of work) {
    const passages = renderPassages(w.passages);
    const doc = w.doc;
    const linkedBefore = new Set(doc.sources.map((s) => s.factId)).size;
    let usage: ProvenanceUsage = {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
    };
    let relabelled = 0;
    let failed = 0;
    const seen = new Set(doc.sources.map((s) => `${s.factId}:${s.chunkId}`));

    const runGroup = async (group: ProvenanceFact[]) => {
      const facts = renderFacts(group);
      try {
        const reply = await proposeSources(client, passages.text, facts.text);
        usage = addUsage(usage, reply.usage);
        if (!reply.input || reply.stopReason === "max_tokens") {
          failed++;
          return;
        }
        const verified = verifySources(
          reply.input,
          passages.index,
          facts.index,
        );
        relabelled += verified.relabelled;
        for (const s of verified.sources) {
          const key = `${s.factId}:${s.chunkId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          doc.sources.push(s);
        }
        for (const f of group)
          if (!doc.checkedFactIds.includes(f.id)) doc.checkedFactIds.push(f.id);
      } catch {
        failed++;
      }
    };

    const groups = groupFacts(w.unlinked, groupSize);
    await runGroup(groups[0]!);
    const rest = groups.slice(1);
    for (let g = 0; g < rest.length; g += CONCURRENCY)
      await Promise.all(rest.slice(g, g + CONCURRENCY).map(runGroup));

    doc.usage = addUsage(doc.usage, usage);
    doc.relabelled = (doc.relabelled ?? 0) + relabelled;
    results.docs[w.i] = doc;
    writeFileSync(path, JSON.stringify(results, null, 2));

    const linkedAfter = new Set(doc.sources.map((s) => s.factId)).size;
    before += linkedBefore;
    after += linkedAfter;
    spent = addUsage(spent, usage);
    console.log(
      `doc ${w.i + 1}: retried=${w.unlinked.length} recovered=${linkedAfter - linkedBefore} ` +
        `relabelled=${relabelled} failedGroups=${failed} $${dollars(usage).toFixed(2)}`,
    );
  }
  const linkedAll = results.docs.reduce(
    (n, d) => n + new Set(d.sources.map((s) => s.factId)).size,
    0,
  );
  const factsAll = results.docs.reduce((n, d) => n + d.facts, 0);
  console.log(
    `\nretry recovered=${after - before} cost=$${dollars(spent).toFixed(2)} | ` +
      `all documents: linked=${linkedAll}/${factsAll} (${pct(linkedAll, factsAll)})`,
  );
}

const [command] = process.argv.slice(2);
const campaignId = arg("campaign");
try {
  if (!campaignId) throw new Error("--campaign <id> is required");
  if (command === "propose") {
    const out = arg("out");
    if (!out) throw new Error("--out <file> is required");
    await propose(campaignId, out);
  } else if (command === "retry") {
    const path = arg("in");
    if (!path) throw new Error("--in <file> is required");
    await retry(campaignId, path, Number(arg("group-size") ?? 15));
  } else if (command === "apply") {
    const input = arg("in");
    if (!input) throw new Error("--in <file> is required");
    await apply(campaignId, input);
  } else {
    throw new Error(
      "usage: backfill-sources propose|retry|apply --campaign <id> ...",
    );
  }
} finally {
  await prisma.$disconnect();
}
