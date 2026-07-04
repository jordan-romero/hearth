// Manually link a Discord account to a Hearth user — the temporary identity
// bridge until Discord login / the DM roster populates `discordUserId` on its own.
//
// Usage: pnpm --filter @hearth/agents link <seedUserId> <discordUserId>

import { prisma } from "@hearth/db";

const [userId, discordUserId] = process.argv.slice(2);
if (!userId || !discordUserId) {
  console.error("usage: link <seedUserId> <discordUserId>");
  process.exit(1);
}

const user = await prisma.user.update({
  where: { id: userId },
  data: { discordUserId },
});
console.log(`Linked ${user.name} (${user.id}) → Discord ${user.discordUserId}`);
await prisma.$disconnect();
