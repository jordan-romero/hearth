// Backfill page links for pages written or imported before page links existed: literal
// "[[Title]]" text becomes a link to the page with that title, and every link between pages is
// recorded so backlinks ("Mentioned in") are complete. Idempotent; safe to run again.
//
// Prints counts only — page text never reaches the terminal.
//
// Usage:
//   pnpm --filter @hearth/agents backfill:links --campaign <id>
//   pnpm --filter @hearth/agents backfill:links --all

import { prisma } from "@hearth/db";
import { relinkPages } from "./workspace.js";
import { getQueue } from "./queue.js";

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--campaign");
  const campaignId = at >= 0 ? args[at + 1] : undefined;
  if (!campaignId && !args.includes("--all")) {
    console.error("Pass --campaign <id>, or --all for every campaign.");
    process.exit(1);
  }
  const campaigns = campaignId
    ? [{ id: campaignId }]
    : await prisma.campaign.findMany({ select: { id: true } });

  for (const { id } of campaigns) {
    const pages = await prisma.page.findMany({
      where: { campaignId: id, archivedAt: null },
      select: { id: true },
    });
    const changed = await relinkPages(
      id,
      pages.map((p) => p.id),
    );
    const links = await prisma.pageLink.count({ where: { campaignId: id } });
    console.log(
      `${id}: ${pages.length} pages, ${changed} updated, ${links} links between pages`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await (await getQueue()).stop({ graceful: true }).catch(() => {});
    await prisma.$disconnect();
  });
