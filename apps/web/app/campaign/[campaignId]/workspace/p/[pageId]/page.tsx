// One workspace page. The page host (../page-host.tsx) shows it in the shared editor; this route
// fetches the server's copy, so opening a page by its address (or reloading) always starts from
// the latest, and hands it to the page store.

import { notFound } from "next/navigation";
import { requireDm } from "@/lib/campaign";
import { getPageDocs } from "@/lib/page-docs";
import { PageData } from "./page-data";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ campaignId: string; pageId: string }>;
}) {
  const { campaignId, pageId } = await params;
  // Both at once; nothing is returned unless the DM check passes (Promise.all rejects first).
  const [, [doc]] = await Promise.all([
    requireDm(campaignId),
    getPageDocs(campaignId, [pageId]),
  ]);
  if (!doc) notFound();
  return <PageData doc={doc} />;
}
