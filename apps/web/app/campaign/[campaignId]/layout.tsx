// The shell every campaign page sits in: who you are, which campaign, and the nav between
// its views. Membership is checked here as well as in each page — the layout can't be relied
// on for authorization, but it can fail fast and render the right identity.

import Link from "next/link";
import { requireMember, viewerLabel } from "@/lib/campaign";
import { CampaignNav } from "./nav";

export default async function CampaignLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  const { viewer, campaign } = await requireMember(campaignId);

  return (
    <div className="wrap">
      <header className="campaign-header">
        <div>
          <Link className="back" href="/">
            ← all campaigns
          </Link>
          <h1>{campaign.name}</h1>
        </div>
        <span className={`role-pill ${viewer.role === "DM" ? "dm" : ""}`}>
          {viewerLabel(viewer)}
        </span>
      </header>

      <CampaignNav campaignId={campaignId} isDm={viewer.role === "DM"} />

      {children}
    </div>
  );
}
