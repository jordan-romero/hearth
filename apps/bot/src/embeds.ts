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

/** The themed embed for an /ask answer — colored by who's asking, question as context,
 * answer as the body, deduped sources in the footer. The no-knowledge line rides through
 * here too (it just has no sources), so it reads as intentional rather than an error. */
export function answerEmbed(
  viewer: Viewer,
  question: string,
  result: AnswerLike,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(viewer.role === "DM" ? BRAND.dm : BRAND.player)
    .setAuthor({ name: truncate(`❓ ${question}`, 256) })
    .setTitle("🔮 The Memory Speaks")
    .setDescription(truncate(result.answer, 4096));

  const sources = [...new Set(result.sources.map((s) => s.title))];
  if (sources.length > 0) {
    embed.setFooter({
      text: truncate(`Drawn from: ${sources.join(", ")}`, 2048),
    });
  }
  return embed;
}
