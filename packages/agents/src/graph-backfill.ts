// Build the graph for a campaign that already has material — the same buildGraph that uploads and
// finished sessions use, run over everything the campaign has, oldest first.
//
//   estimate  No model calls. What a build would cost, from the size of the material.
//   propose   A dry run: reads everything with the model and verifies it, writes nothing, prints
//             counts only (the people running this may be players in the campaign).
//   apply     The real thing. Additive: entities, aliases, relationships and links are only added.
//
// Usage:
//   pnpm --filter @hearth/agents graph:build estimate --campaign <id>
//   pnpm --filter @hearth/agents graph:build propose  --campaign <id> [--doc <id>] --yes
//   pnpm --filter @hearth/agents graph:build apply    --campaign <id> --yes

import { prisma } from "@hearth/db";
import {
  buildGraph,
  documentSource,
  sessionSource,
  type GraphBuildReport,
  type GraphSource,
} from "./graph-build.js";

// Sonnet 5 per million tokens; cache writes at the 5-minute rate.
const PRICE = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
const CHARS_PER_TOKEN = 2.5;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function sourcesFor(campaignId: string): Promise<GraphSource[]> {
  const only = arg("doc");
  const docs = await prisma.sourceDocument.findMany({
    where: { campaignId, status: "PARSED", ...(only ? { id: only } : {}) },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const sessions = only
    ? []
    : await prisma.gameSession.findMany({
        where: { campaignId, status: "COMPLETE" },
        select: { id: true },
        orderBy: { number: "asc" },
      });
  const out: GraphSource[] = [];
  for (const d of docs) out.push(await documentSource(d.id));
  for (const s of sessions) out.push(await sessionSource(s.id));
  return out.filter((s) => s.passages.length > 0);
}

const dollars = (u: GraphBuildReport["usage"]) =>
  (u.input * PRICE.input +
    u.output * PRICE.output +
    u.cacheWrite * PRICE.cacheWrite +
    u.cacheRead * PRICE.cacheRead) /
  1_000_000;

function print(report: GraphBuildReport) {
  console.log(
    JSON.stringify(
      { ...report, cost: `$${dollars(report.usage).toFixed(2)}` },
      null,
      2,
    ),
  );
}

const [command] = process.argv.slice(2);
const campaignId = arg("campaign");
try {
  if (!campaignId) throw new Error("--campaign <id> is required");
  const sources = await sourcesFor(campaignId);
  const chars = sources.reduce(
    (n, s) => n + s.passages.reduce((m, p) => m + p.text.length, 0),
    0,
  );
  const tokens = chars / CHARS_PER_TOKEN;
  // Each source is read twice (entities, then relationships) with the entity list alongside, and the
  // model writes — and thinks — a lot per window. Calibrated on the live campaign's dry run: about
  // 2.6x the material in input and 0.8x in output. The first estimate assumed 0.2x output and came
  // in at half the real $3.74.
  const estimate =
    (tokens * 2.6 * PRICE.input + tokens * 0.8 * PRICE.output) / 1_000_000;
  console.log(
    `${command}: ${sources.length} source(s), ~${Math.round(tokens / 1000)}k tokens — estimated ~$${estimate.toFixed(2)}`,
  );

  if (command === "estimate") {
    // nothing else
  } else if (command === "propose" || command === "apply") {
    if (!process.argv.includes("--yes")) {
      console.log("Re-run with --yes to spend it.");
    } else {
      print(
        await buildGraph(campaignId, sources, { save: command === "apply" }),
      );
    }
  } else {
    throw new Error(
      "usage: graph:build estimate|propose|apply --campaign <id>",
    );
  }
} finally {
  await prisma.$disconnect();
}
