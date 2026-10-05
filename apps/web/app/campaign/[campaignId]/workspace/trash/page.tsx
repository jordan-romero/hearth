// Pages in the trash: out of the tree and out of the memory, until restored.

import Link from "next/link";
import { listTrash } from "@hearth/agents";
import { requireDm } from "@/lib/campaign";
import { restorePageAction } from "../actions";

export default async function Trash({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  await requireDm(campaignId);
  const pages = await listTrash(campaignId);

  return (
    <div className="ws-home-page">
      <h2 className="ws-title-static">Trash</h2>
      {pages.length === 0 ? (
        <p className="muted">Nothing in the trash.</p>
      ) : (
        <ul className="ws-recent">
          {pages.map((p) => (
            <li key={p.id}>
              <Link href={`/campaign/${campaignId}/workspace/p/${p.id}`}>
                {p.title || "Untitled"}
              </Link>
              <form
                action={async () => {
                  "use server";
                  await restorePageAction(campaignId, p.id);
                }}
              >
                <button className="ws-link" type="submit">
                  Restore
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
