// Presentation helpers for the bot (kept out of @hearth/core — the core stays pure logic).
// Builders so /ask, reveals, /journal, and /npc share one consistent look, colored by the
// campaign's chosen theme (Campaign.theme, default "firelight").

import { EmbedBuilder } from "discord.js";
import type { Viewer } from "@hearth/core";

// Per-campaign color themes. Each gives a player + DM shade so a viewer's role still reads,
// but the whole palette shifts with the table's chosen theme. Unknown themes fall back to
// firelight (also the schema default).
const THEMES: Record<string, { player: number; dm: number }> = {
  firelight: { player: 0xe8833a, dm: 0xd4a017 }, // warm ember + hearth gold
  arcane: { player: 0x7c3aed, dm: 0x4f46e5 }, // violet + indigo
  verdant: { player: 0x2e9e5b, dm: 0x15803d }, // grove greens
  bloodmoon: { player: 0xc2410c, dm: 0x9f1239 }, // ember + crimson
  frost: { player: 0x38bdf8, dm: 0x2563eb }, // ice blues
};
const DEFAULT_THEME = "firelight";

/** The accent color for a theme + role. Falls back to firelight for unknown themes. */
export function themeColor(theme: string, role: string): number {
  const t = THEMES[theme] ?? THEMES[DEFAULT_THEME]!;
  return role === "DM" ? t.dm : t.player;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface AnswerLike {
  answer: string;
  sources: { title: string; type: string }[];
}

/** In-world title naming WHO is recalling. `/ask` is "remembering" (you already knew it);
 * reveals are "discovering" (newly shown). The DM is the keeper of the whole record, so they
 * get Hearth itself rather than a character name. */
function recallTitle(role: string, characterName: string | null): string {
  if (role === "DM") return "🔥 Hearth recalls…";
  return `🧠 ${characterName ?? "Your character"} remembers…`;
}

/** The themed embed for an /ask answer — colored by the campaign theme + who's asking, an
 * in-world "{who} remembers" title, the question as context, answer as body, deduped sources
 * in the footer. The no-knowledge line rides through here too (just no sources). */
export function answerEmbed(
  viewer: Viewer,
  characterName: string | null,
  question: string,
  result: AnswerLike,
  theme: string = DEFAULT_THEME,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(themeColor(theme, viewer.role))
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
 * party" (posted to the reveals channel). The reveal IS the announcement, so content rides
 * along. Colored with the theme's player shade (it's shown to players). */
export function revealEmbed(
  subjectLabel: string,
  itemTitle: string,
  body: string,
  theme: string = DEFAULT_THEME,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(themeColor(theme, "PLAYER"))
    .setTitle(`✨ ${subjectLabel} discovered…`)
    .setDescription(truncate(`**${itemTitle}**\n${body}`, 4096));
}

export interface NpcCard {
  name: string;
  race: string;
  role: string;
  appearance: string;
  demeanor: string;
  voice: string;
  ties: string;
  hook: string;
  secret: string;
}

/** The generated-NPC draft card. DM-facing (gold in firelight), with the matched portrait as
 * the thumbnail (passed as an `attachment://` filename) and the DM-only secret shown. */
export function npcEmbed(
  npc: NpcCard,
  portraitLabel: string | null,
  theme: string = DEFAULT_THEME,
  thumbnailFilename?: string,
): EmbedBuilder {
  const dash = (s: string) => truncate(s?.trim() || "—", 1024);
  const embed = new EmbedBuilder()
    .setColor(themeColor(theme, "DM"))
    .setAuthor({ name: "🎭 Generated NPC" })
    .setTitle(truncate(npc.name, 256))
    .setDescription(
      truncate(`**${npc.race} · ${npc.role}**\n${npc.appearance}`, 4096),
    )
    .addFields(
      { name: "Demeanor", value: dash(npc.demeanor), inline: true },
      { name: "Voice", value: dash(npc.voice), inline: true },
      { name: "Ties", value: dash(npc.ties) },
      { name: "Hook", value: dash(npc.hook) },
      { name: "🔒 DM secret", value: dash(npc.secret) },
    )
    .setFooter({
      text: portraitLabel
        ? `matched portrait · ${portraitLabel} · origin GENERATED`
        : "no portrait matched · origin GENERATED",
    });
  if (thumbnailFilename)
    embed.setThumbnail(`attachment://${thumbnailFilename}`);
  return embed;
}

/** The player-facing NPC card, for sharing to a channel — NO DM secret, no ties/hook (those
 * are DM planning notes). Just who the party sees and how they carry themselves. */
export function npcShareEmbed(
  npc: NpcCard,
  theme: string = DEFAULT_THEME,
  thumbnailFilename?: string,
): EmbedBuilder {
  const dash = (s: string) => truncate(s?.trim() || "—", 1024);
  const embed = new EmbedBuilder()
    .setColor(themeColor(theme, "PLAYER"))
    .setAuthor({ name: "✨ You encounter…" })
    .setTitle(truncate(npc.name, 256))
    .setDescription(
      truncate(`**${npc.race} · ${npc.role}**\n${npc.appearance}`, 4096),
    )
    .addFields(
      { name: "Demeanor", value: dash(npc.demeanor), inline: true },
      { name: "Manner", value: dash(npc.voice), inline: true },
    );
  if (thumbnailFilename)
    embed.setThumbnail(`attachment://${thumbnailFilename}`);
  return embed;
}

/** A filesystem/attachment-safe version of a name (for portrait + card downloads). */
export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "npc";
}

/** The downloadable NPC card (.md) — for the DM's notes / VTT. */
export function npcCardMarkdown(
  npc: NpcCard,
  portraitLabel: string | null,
): string {
  return [
    `# ${npc.name}`,
    `${npc.race} · ${npc.role}`,
    ``,
    npc.appearance,
    ``,
    `**Demeanor** — ${npc.demeanor}`,
    `**Voice** — ${npc.voice}`,
    `**Ties** — ${npc.ties}`,
    `**Hook** — ${npc.hook}`,
    ``,
    `> DM secret: ${npc.secret}`,
    ``,
    portraitLabel
      ? `_Portrait: ${portraitLabel} · generated by Hearth_`
      : `_Generated by Hearth_`,
  ].join("\n");
}

/** Confirmation shown after a player records a `/journal` entry. */
export function journalEmbed(
  characterName: string | null,
  content: string,
  theme: string = DEFAULT_THEME,
): EmbedBuilder {
  const whose = characterName ? `${characterName}'s` : "Your";
  return new EmbedBuilder()
    .setColor(themeColor(theme, "PLAYER"))
    .setAuthor({ name: `📔 Noted in ${whose} journal` })
    .setDescription(truncate(content, 4096))
    .setFooter({ text: "Only you and the DM can see this." });
}
