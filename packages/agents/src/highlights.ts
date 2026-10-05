// Highlights on workspace pages, as knowledge (docs/workspace.md §2).
//
// The editor marks canon text with a `canon` mark carrying { id, known, everyone }. Unmarked
// text is the DM's working prep. Each highlight becomes ONE KnowledgeUnit (keyed by the mark's
// id), and that is the only way page text reaches a player:
//
//   canon, nobody knows yet  → DM_ONLY, no grants
//   known by some characters → DM_ONLY + a CHARACTER grant each (logged as reveals)
//   the whole table knows    → EVERYONE
//
// Re-saving the page updates units in place, so a reveal survives rewording. A highlight that
// disappears is deleted only if no player was ever shown it; otherwise it is left exactly as it
// was — what someone was told stays told — and still carries its highlight id, so if the text
// comes back (an undo, a restored version) it picks up the same knowledge instead of a copy.

import { prisma, type BaseVisibility } from "@hearth/db";
import type { PmNode } from "./page-markdown.js";
import { embedTexts, toVectorLiteral } from "./embeddings.js";
import { revealTo } from "./reveal.js";

export const CANON_MARK = "canon";

export interface PageHighlight {
  id: string;
  text: string;
  /** Character ids that know it. */
  known: string[];
  /** The whole table knows it. */
  everyone: boolean;
}

/**
 * Every highlight on a page, in order. A highlight split across blocks (or around other
 * formatting) is one highlight: its pieces are joined, with " … " between blocks.
 */
export function extractHighlights(doc: PmNode): PageHighlight[] {
  const byId = new Map<string, PageHighlight & { lastBlock: number }>();
  let block = 0;

  const walk = (node: PmNode, inTextBlock: boolean) => {
    if (node.type === "text") {
      const mark = node.marks?.find((m) => m.type === CANON_MARK);
      const id = typeof mark?.attrs?.id === "string" ? mark.attrs.id : null;
      if (!mark || !id) return;
      const known = Array.isArray(mark.attrs?.known)
        ? (mark.attrs.known as unknown[]).filter(
            (k): k is string => typeof k === "string",
          )
        : [];
      const existing = byId.get(id);
      if (existing) {
        existing.text +=
          (existing.lastBlock === block ? "" : " … ") + (node.text ?? "");
        existing.lastBlock = block;
      } else {
        byId.set(id, {
          id,
          text: node.text ?? "",
          known: [...new Set(known)],
          everyone: mark.attrs?.everyone === true,
          lastBlock: block,
        });
      }
      return;
    }
    const isTextBlock = !!node.content?.some((c) => c.type === "text");
    if (isTextBlock && !inTextBlock) block++;
    for (const child of node.content ?? [])
      walk(child, isTextBlock || inTextBlock);
  };
  walk(doc, false);

  return [...byId.values()]
    .map((h) => ({
      id: h.id,
      text: h.text.replace(/\s+/g, " ").trim(),
      known: h.known,
      everyone: h.everyone,
    }))
    .filter((h) => h.text.length > 0);
}

/** A short title for a highlight's unit: its first words, cut on a word boundary. */
export function highlightTitle(text: string, max = 80): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface HighlightSyncResult {
  created: number;
  updated: number;
  removed: number;
  kept: number;
}

/**
 * Bring a page's highlight units in line with the page. Runs in the worker with page indexing.
 * Grants change through revealTo / a logged revoke, so the reveal history shows every change.
 */
export async function syncPageHighlights(
  pageId: string,
): Promise<HighlightSyncResult> {
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { campaignId: true, content: true, archivedAt: true },
  });
  const result: HighlightSyncResult = {
    created: 0,
    updated: 0,
    removed: 0,
    kept: 0,
  };
  if (!page) return result;
  const { campaignId } = page;

  // A page in the trash contributes no highlights (its units are handled like deleted ones).
  const highlights = page.archivedAt
    ? []
    : extractHighlights(page.content as unknown as PmNode);

  const [existing, characters, dm] = await Promise.all([
    prisma.knowledgeUnit.findMany({
      where: { sourcePageId: pageId, highlightId: { not: null } },
      select: {
        id: true,
        highlightId: true,
        content: true,
        baseVisibility: true,
        grants: { select: { id: true, characterId: true, partyId: true } },
      },
    }),
    prisma.character.findMany({ where: { campaignId }, select: { id: true } }),
    prisma.membership.findFirst({
      where: { campaignId, role: "DM" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    }),
  ]);
  if (!dm)
    throw new Error(`campaign ${campaignId} has no DM to attribute reveals to`);
  const validCharacters = new Set(characters.map((c) => c.id));
  const byHighlight = new Map(existing.map((u) => [u.highlightId!, u]));
  const toEmbed: { id: string; text: string }[] = [];

  for (const h of highlights) {
    const baseVisibility = h.everyone ? "EVERYONE" : "DM_ONLY";
    const known = h.everyone
      ? []
      : h.known.filter((id) => validCharacters.has(id));
    const title = highlightTitle(h.text);
    let unit = byHighlight.get(h.id);

    if (!unit) {
      // The same id on another page (a highlight copied between pages) belongs to that page.
      const elsewhere = await prisma.knowledgeUnit.findUnique({
        where: { highlightId: h.id },
        select: { id: true },
      });
      if (elsewhere) continue;
      const created = await prisma.knowledgeUnit.create({
        data: {
          campaignId,
          type: "FACT",
          source: "DM_ADDED",
          origin: "AUTHORED",
          canon: "CANON",
          baseVisibility,
          title,
          content: h.text,
          highlightId: h.id,
          sourcePageId: pageId,
        },
        select: { id: true },
      });
      unit = {
        id: created.id,
        highlightId: h.id,
        content: h.text,
        baseVisibility,
        grants: [],
      };
      toEmbed.push({ id: created.id, text: `${title}. ${h.text}` });
      result.created++;
      if (baseVisibility === "EVERYONE") {
        await logVisibility(unit.id, "DM_ONLY", "EVERYONE", dm.id);
      }
    } else if (
      unit.content !== h.text ||
      unit.baseVisibility !== baseVisibility
    ) {
      await prisma.knowledgeUnit.update({
        where: { id: unit.id },
        data: { title, content: h.text, baseVisibility, canon: "CANON" },
      });
      if (unit.content !== h.text)
        toEmbed.push({ id: unit.id, text: `${title}. ${h.text}` });
      if (unit.baseVisibility !== baseVisibility) {
        await logVisibility(
          unit.id,
          unit.baseVisibility,
          baseVisibility,
          dm.id,
        );
      }
      result.updated++;
    }

    // Who knows it: reveal to newly-added characters, revoke from removed ones.
    const have = new Set(
      unit.grants.flatMap((g) => (g.characterId ? [g.characterId] : [])),
    );
    for (const characterId of known) {
      if (!have.has(characterId)) {
        await revealTo({ unitId: unit.id }, { characterId }, dm.id);
      }
    }
    const want = new Set(known);
    for (const g of unit.grants) {
      if (g.characterId && !want.has(g.characterId)) {
        await revoke(unit.id, g.id, g.characterId, dm.id);
      }
    }
  }

  // Highlights no longer on the page.
  const present = new Set(highlights.map((h) => h.id));
  for (const u of existing) {
    if (present.has(u.highlightId!)) continue;
    const everShown = u.baseVisibility !== "DM_ONLY" || u.grants.length > 0;
    if (everShown) {
      result.kept++; // someone was told this; it stays theirs
    } else {
      await prisma.knowledgeUnit.delete({ where: { id: u.id } });
      result.removed++;
    }
  }

  if (toEmbed.length > 0) {
    const vectors = await embedTexts(
      toEmbed.map((e) => e.text),
      "document",
    );
    for (const [i, e] of toEmbed.entries()) {
      const vec = vectors[i];
      if (vec) {
        await prisma.$executeRaw`UPDATE "KnowledgeUnit" SET embedding = ${toVectorLiteral(vec)}::vector WHERE id = ${e.id}`;
      }
    }
  }
  return result;
}

async function revoke(
  unitId: string,
  grantId: string,
  characterId: string,
  byMembershipId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.knowledgeGrant.delete({ where: { id: grantId } }),
    prisma.revealEvent.create({
      data: {
        knowledgeUnitId: unitId,
        action: "REVOKE",
        scope: "CHARACTER",
        characterId,
        byMembershipId,
      },
    }),
  ]);
}

function logVisibility(
  unitId: string,
  from: BaseVisibility,
  to: BaseVisibility,
  byMembershipId: string,
) {
  return prisma.revealEvent.create({
    data: {
      knowledgeUnitId: unitId,
      action: "CHANGE_VISIBILITY",
      fromVisibility: from,
      toVisibility: to,
      byMembershipId,
    },
  });
}

// ─── Colors ──────────────────────────────────────────────────────────────────

/** Used until the DM picks: distinct on light and dark grounds, colorblind-aware order. */
export const DEFAULT_CHARACTER_COLORS = [
  "#3f7fbf",
  "#b5487a",
  "#3d9a6b",
  "#8a5cc2",
  "#c46a2b",
  "#2f9aa8",
  "#a0832b",
  "#c24d4d",
];
export const DEFAULT_TABLE_COLOR = "#c99a2e";

export interface TableColors {
  table: string;
  characters: { id: string; name: string; color: string; custom: boolean }[];
}

/** Every character's color (theirs, or a default by order of creation) and the table's. */
export async function getTableColors(campaignId: string): Promise<TableColors> {
  const [campaign, characters] = await Promise.all([
    prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { tableColor: true },
    }),
    prisma.character.findMany({
      where: { campaignId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, color: true },
    }),
  ]);
  return {
    table: campaign?.tableColor ?? DEFAULT_TABLE_COLOR,
    characters: characters.map((c, i) => ({
      id: c.id,
      name: c.name,
      color:
        c.color ??
        DEFAULT_CHARACTER_COLORS[i % DEFAULT_CHARACTER_COLORS.length]!,
      custom: !!c.color,
    })),
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Save the DM's colors. Ids are checked against the campaign; bad colors are ignored. */
export async function setTableColors(
  campaignId: string,
  input: { table?: string; characters: { id: string; color: string | null }[] },
): Promise<void> {
  const ours = new Set(
    (
      await prisma.character.findMany({
        where: { campaignId },
        select: { id: true },
      })
    ).map((c) => c.id),
  );
  await prisma.$transaction([
    ...(input.table && HEX.test(input.table)
      ? [
          prisma.campaign.update({
            where: { id: campaignId },
            data: { tableColor: input.table },
          }),
        ]
      : []),
    ...input.characters
      .filter((c) => ours.has(c.id) && (c.color === null || HEX.test(c.color)))
      .map((c) =>
        prisma.character.update({
          where: { id: c.id },
          data: { color: c.color },
        }),
      ),
  ]);
}
