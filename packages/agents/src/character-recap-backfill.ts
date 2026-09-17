// Write per-character recaps for a session that finished before they existed — the same
// writeRecapsForSession the worker runs when a session finishes. Prints counts only.
//
// Usage:
//   pnpm --filter @hearth/agents recap:characters --session <id> [--yes]

import { prisma } from "@hearth/db";
import { writeRecapsForSession } from "./character-recap.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sessionId = arg("session");
try {
  if (!sessionId) throw new Error("--session <id> is required");
  const attended = await prisma.sessionAttendance.count({
    where: { gameSessionId: sessionId, characterId: { not: null } },
  });
  console.log(
    `recap:characters: ${attended} character(s) recorded in the session — one model call each, ` +
      `the transcript cached after the first`,
  );
  if (!process.argv.includes("--yes")) {
    console.log("Re-run with --yes to write them.");
  } else {
    console.log(JSON.stringify(await writeRecapsForSession(sessionId)));
  }
} finally {
  await prisma.$disconnect();
}
