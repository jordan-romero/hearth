// The colors that mean "who knows this", everywhere in Hearth: one per character, one for the
// whole table. Characters without a color of their own use a default by order of creation.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTableColors, setTableColors } from "@hearth/agents";
import { requireDm } from "@/lib/campaign";

export default async function TableColorsPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { campaignId } = await params;
  const { saved } = await searchParams;
  await requireDm(campaignId);
  const colors = await getTableColors(campaignId);

  async function save(formData: FormData) {
    "use server";
    await requireDm(campaignId);
    await setTableColors(campaignId, {
      table: String(formData.get("table") ?? ""),
      characters: colors.characters.map((c) => ({
        id: c.id,
        color: formData.get(`reset-${c.id}`)
          ? null
          : String(formData.get(`c-${c.id}`) ?? ""),
      })),
    });
    revalidatePath(`/campaign/${campaignId}`, "layout");
    redirect(`/campaign/${campaignId}/workspace/colors?saved=1`);
  }

  return (
    <div className="ws-home-page">
      <h2 className="ws-title-static">Table colors</h2>
      <p className="muted" style={{ margin: 0, maxWidth: "60ch" }}>
        These colors show who knows what across Hearth: highlights on your
        pages, and anywhere else knowledge is shown. Pick ones you&rsquo;ll
        recognise at a glance.
      </p>
      {saved && <p className="notice ok">Colors saved.</p>}
      <form action={save} className="ws-colors">
        <label className="ws-color-row" htmlFor="table">
          <input
            id="table"
            name="table"
            type="color"
            defaultValue={colors.table}
          />
          <span>
            <strong>Whole table</strong>
            <span className="muted small"> · everyone knows it</span>
          </span>
        </label>
        {colors.characters.length === 0 ? (
          <p className="muted">
            No characters yet. They appear here once players join with{" "}
            <code>/join</code> in Discord.
          </p>
        ) : (
          colors.characters.map((c) => (
            <div key={c.id} className="ws-color-row">
              <input
                id={`c-${c.id}`}
                name={`c-${c.id}`}
                type="color"
                defaultValue={c.color}
                aria-label={`${c.name}'s color`}
              />
              <label htmlFor={`c-${c.id}`}>
                <strong>{c.name}</strong>
                {!c.custom && <span className="muted small"> · default</span>}
              </label>
              {c.custom && (
                <label className="check muted small">
                  <input type="checkbox" name={`reset-${c.id}`} /> use default
                </label>
              )}
            </div>
          ))
        )}
        <div>
          <button className="btn" type="submit">
            Save colors
          </button>
        </div>
      </form>
    </div>
  );
}
