// The front door: sign in with Discord, then pick a campaign. Identity comes from the same
// Discord account the bot already knows, so there's no separate signup.

import Link from "next/link";
import { auth } from "@/auth";
import { listCampaignsForDiscordUser } from "@hearth/agents";
import { Landing } from "./_landing/Landing";

export default async function Home() {
  const session = await auth();

  if (!session?.discordUserId) return <Landing />;

  const campaigns = await listCampaignsForDiscordUser(session.discordUserId);

  return (
    <main className="wrap">
      <p className="eyebrow">Hearth</p>
      <h1>Your campaigns</h1>

      {campaigns.length === 0 ? (
        <p className="muted" style={{ maxWidth: "56ch" }}>
          This Discord account isn&rsquo;t in a campaign yet. Join one from your
          table&rsquo;s Discord server with <code>/join</code>, then come back.
        </p>
      ) : (
        <div className="stack" style={{ marginTop: 24 }}>
          {campaigns.map((c) => (
            <Link
              key={c.campaignId}
              className="card"
              href={`/campaign/${c.campaignId}`}
            >
              <span className="tag">
                {c.role === "DM" ? "Dungeon Master" : "Player"}
              </span>
              <h2 style={{ margin: "6px 0 0" }}>{c.name}</h2>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
