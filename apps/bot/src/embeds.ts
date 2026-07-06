// Presentation helpers for the bot (kept out of @hearth/core — the core stays pure logic).
// A small brand palette + builders so /ask, reveals, and /npc share one consistent look.

import { EmbedBuilder } from "discord.js";
import type { Viewer } from "@hearth/core";

/** Brand colors. Violet = a character's own memory; gold = the DM/owner view. */
export const BRAND = {
  player: 0x7c3aed,
  dm: 0xd4af37,
} as const;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface AnswerLike {
  answer: string;
  sources: { title: string; type: string }[];
}

/** In-world title naming WHO is recalling. `/ask` is "remembering" (you already knew it);
 * reveals will be "discovering" (newly shown) in their own builder. The DM is the keeper of
 * the whole record, so they get the chronicle rather than a character name. */
function recallTitle(role: string, characterName: string | null): string {
  if (role === "DM") return "🔥 Hearth recalls…";
  return `🧠 ${characterName ?? "Your character"} remembers…`;
}

/** The themed embed for an /ask answer — colored by who's asking, an in-world "{who}
 * remembers" title, the question as context, answer as body, deduped sources in the footer.
 * The no-knowledge line rides through here too (it just has no sources), so it reads as
 * intentional rather than an error. */
export function answerEmbed(
  viewer: Viewer,
  characterName: string | null,
  question: string,
  result: AnswerLike,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(viewer.role === "DM" ? BRAND.dm : BRAND.player)
    .setAuthor({ name: truncate(`❓ ${question}`, 256) })
    .setTitle(recallTitle(viewer.role, characterName))
    .setDescription(truncate(result.answer, 4096));

  const sources = [...new Set(result.sources.map((s) => s.title))];
  if (sources.length > 0) {
    embed.setFooter({
      text: truncate(`Drawn from: ${sources.join(", ")}`, 2048),
    });
  }
  return embed;
}

/** The announcement embed when the DM reveals something — "discovered" (newly shown), the
 * counterpart to /ask's "remembers". `subjectLabel` is "You" (DM'd to one player) or "The
 * party" (posted to the reveals channel). The reveal IS the announcement, so the content
 * rides along. */
export function revealEmbed(
  subjectLabel: string,
  itemTitle: string,
  body: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(BRAND.player)
    .setTitle(`✨ ${subjectLabel} discovered…`)
    .setDescription(truncate(`**${itemTitle}**\n${body}`, 4096));
}
