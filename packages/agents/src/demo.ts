// Watch the filter hold, live, on the seeded Ondera campaign.
// Run: pnpm --filter @hearth/agents demo

import { prisma } from "@hearth/db";
import type { Viewer } from "@hearth/core";
import { ask } from "./ask.js";

const CAMPAIGN = "seed-ondera";
const PARTY = "seed-party-shepherds";

const dm: Viewer = {
  campaignId: CAMPAIGN,
  role: "DM",
  characterId: null,
  partyId: null,
};
const morwyn: Viewer = {
  campaignId: CAMPAIGN,
  role: "PLAYER",
  characterId: "seed-char-morwyn",
  partyId: PARTY,
};
const ildin: Viewer = {
  campaignId: CAMPAIGN,
  role: "PLAYER",
  characterId: "seed-char-ildin",
  partyId: PARTY,
};

async function askAs(label: string, viewer: Viewer, question: string) {
  const { answer, sources } = await ask(viewer, question);
  console.log(`\n── ${label} ──`);
  console.log(`Q: ${question}`);
  console.log(`A: ${answer}`);
  console.log(
    `   [sources: ${sources.map((s) => s.title).join(" · ") || "none"}]`,
  );
}

async function main() {
  const q1 = "Is the Shadow Seeker still influencing Ildin?";
  console.log(
    "\n════════ Q1 (DM-only secret vs. a player's suspicion) ════════",
  );
  await askAs("DM", dm, q1);
  await askAs("Ildin (player)", ildin, q1);

  const q2 = "Did Arvid do anything suspicious before Ildin's trial?";
  console.log("\n\n════════ Q2 (revealed to Morwyn only) ════════");
  await askAs("DM", dm, q2);
  await askAs("Morwyn (player)", morwyn, q2);
  await askAs("Ildin (player)", ildin, q2);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
