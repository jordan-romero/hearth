// Everything under /p shares one page host, so the editor survives moving between pages (see
// page-host.tsx). DM-only, like the rest of the workspace.

import { getTableColors } from "@hearth/agents";
import { requireDm } from "@/lib/campaign";
import { PageHost } from "./page-host";

export default async function PagesLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  const [, colors] = await Promise.all([
    requireDm(campaignId),
    getTableColors(campaignId),
  ]);
  return (
    <PageHost
      tableColor={colors.table}
      characters={colors.characters.map(({ id, name, color }) => ({
        id,
        name,
        color,
      }))}
    >
      {children}
    </PageHost>
  );
}
