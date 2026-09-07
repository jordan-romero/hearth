// Correcting the memory — "that's wrong, here's what actually happened".
//
// Why this exists: extraction sometimes records a fact wrongly (it once decided an NPC was a
// player's wife when she was his mother), and a wrong fact is worse than a missing one — /ask
// reports it faithfully and confidently, forever. So the table needs a way to fix canon.
//
// Two design constraints shape everything here:
//
//  1. A correction is its own durable record, never an edit to the offending unit. Finalizing a
//     session DELETES and recreates its SESSION units, so an in-place edit would silently
//     vanish on the next extraction.
//  2. The DM owns canon. A player proposes; the DM approves. Same propose→approve shape as a
//     reveal, just initiated from the other side. A DM correcting something IS the approval.
//
// Targets are resolved when the correction is proposed, so the DM applies exactly what they
// were shown rather than whatever a second model pass would decide at approval time.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@hearth/db";
import type { Viewer } from "@hearth/core";
import { embedTexts, toVectorLiteral } from "./embeddings.js";
import { retrieveContext } from "./retrieve.js";

const MODEL = "claude-sonnet-5"; // judging contradictions is reasoning, not recall

const ANALYSIS_TOOL: Anthropic.Tool = {
  name: "record_correction",
  description:
    "Record which stored facts a correction contradicts, and the corrected fact to store.",
  input_schema: {
    type: "object",
    properties: {
      contradicts: {
        type: "array",
        description:
          "The stored entries that state something the correction says is wrong. Only entries that genuinely conflict — not merely related ones. Empty if none do.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "The fact's id." },
            rewrite: {
              type: "string",
              description:
                "For a FACT: the whole fact rewritten so it is true, KEEPING everything about it that was already correct — fix only the mistaken part. Use an empty string to retire it instead, which is always what happens to a PASSAGE (those are quotes from an uploaded document and are never rewritten).",
            },
          },
          required: ["id", "rewrite"],
        },
      },
      newFactTitle: {
        type: "string",
        description:
          "Short title for a NEW fact, if the correction asserts something none of the rewrites already say. Empty string if the rewrites cover it.",
      },
      newFactContent: {
        type: "string",
        description:
          "The new fact as a plain, self-contained statement of what is true. Empty string if not needed. No meta-commentary about the correction itself.",
      },
    },
    required: ["contradicts", "newFactTitle", "newFactContent"],
  },
};

const ANALYSIS_SYSTEM = `You maintain the canon of a tabletop RPG campaign.

Someone at the table says the memory got something wrong. You are given their correction and the stored facts most related to it, each with an id.

You are given two kinds of entry. A FACT is a distilled statement the memory holds. A PASSAGE is a quote from a document the DM uploaded — passages are never rewritten, only retired, because the document itself is their source of truth.

Decide which stored entries CONTRADICT the correction — facts that assert something the correction says is untrue. Be strict: a fact that merely mentions the same people or place is not a contradiction. Only list facts that would still be wrong once the correction is accepted.

For each one, REWRITE it so it is true. This matters: a fact is usually mostly right with one thing wrong, and the rest of it is knowledge the table would lose. "Moraine, daughter of Morwyn and his late wife Moira" becomes "Moraine, daughter of Morwyn" — it does NOT disappear. Change only what is actually mistaken and keep every other detail intact.

Then, only if the correction asserts something none of your rewrites now say, add it as a new fact. If the rewrites already cover it, leave the new fact empty rather than saying the same thing twice.

Write in the same voice as the stored facts: plain statements of what IS the case, never what was wrong. "Moira was Morwyn's mother" — never "Moira was not his wife" or "correction: …". Someone reading it later should not be able to tell it came from a correction.`;

/**
 * Drop anything the model named that wasn't offered to it.
 *
 * This is the security boundary of a correction: candidates come from filtered retrieval, so a
 * proposer only ever sees what they're allowed to. Without this, a model that invented or echoed
 * an id could edit — or retire — a fact the proposer was never permitted to know existed.
 * Exported so that guarantee is testable without a database or a model call.
 */
export function keepVisible<T extends { id: string }>(
  proposed: T[],
  visibleIds: string[],
): T[] {
  const visible = new Set(visibleIds);
  return proposed.filter((p) => visible.has(p.id));
}

export interface CorrectionProposal {
  /** Null when nothing in the memory contradicted the statement — nothing was persisted. */
  id: string | null;
  statement: string;
  status: string;
  /** The facts this changes, each with its replacement — what the DM sees before approving. */
  targets: { id: string; title: string; content: string; rewrite: string }[];
  /** An extra fact, when the rewrites don't already say what the correction says. */
  newFactTitle: string | null;
  newFactContent: string | null;
  /** True when the proposer was the DM, so it applied immediately. */
  autoApproved: boolean;
}

/**
 * Propose a correction. The proposer's own permissions bound it: candidates come through the
 * normal filtered retrieval, so a player can only ever retire a fact they can already see —
 * a correction can't be used to probe for DM secrets.
 */
export async function proposeCorrection(
  viewer: Viewer,
  membershipId: string,
  statement: string,
  wasWrong?: string,
): Promise<CorrectionProposal> {
  const query = `${statement} ${wasWrong ?? ""}`.trim();
  // Facts AND document passages: /ask grounds answers on both, so a correction that couldn't
  // touch a passage would leave the wrong version reachable through the original upload.
  const { units, chunks } = await retrieveContext(viewer, query, {
    unitLimit: 12,
    chunkLimit: 6,
  });
  const candidates = [
    ...units.map((u) => ({
      id: u.id,
      title: u.title,
      content: u.content,
      kind: "FACT" as const,
    })),
    ...chunks.map((c) => ({
      id: c.id,
      title: `passage from ${c.docName}`,
      content: c.text,
      kind: "PASSAGE" as const,
    })),
  ];

  const numbered = candidates
    .map((u) => `[${u.id}] (${u.kind}) ${u.title}\n${u.content}`)
    .join("\n\n");

  const client = new Anthropic();
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: ANALYSIS_SYSTEM,
    tools: [ANALYSIS_TOOL],
    tool_choice: { type: "tool", name: ANALYSIS_TOOL.name },
    messages: [
      {
        role: "user",
        content:
          `The correction: ${statement}` +
          (wasWrong ? `\n\nWhat the memory said: ${wasWrong}` : "") +
          `\n\nStored facts:\n${numbered || "(nothing related is stored)"}`,
      },
    ],
  });

  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("correction analysis returned no result");
  }
  const out = block.input as {
    contradicts: { id: string; rewrite: string }[];
    newFactTitle: string;
    newFactContent: string;
  };

  const rewrites = keepVisible(
    out.contradicts ?? [],
    candidates.map((c) => c.id),
  ).map((r) => {
    const kind = candidates.find((c) => c.id === r.id)?.kind ?? "FACT";
    // A passage is a quote from a document; rewriting one would put words in the document's
    // mouth. Retire it and let the correction's own fact carry the truth.
    return kind === "PASSAGE" ? { ...r, rewrite: "", kind } : { ...r, kind };
  });
  const targetIds = rewrites.map((r) => r.id);

  // Nothing to change and nothing to add: don't leave a PENDING row that no one will ever
  // decide on. The caller reports that the memory didn't contradict them.
  if (rewrites.length === 0 && !(out.newFactTitle && out.newFactContent)) {
    return {
      id: null,
      statement,
      status: "NOOP",
      targets: [],
      newFactTitle: null,
      newFactContent: null,
      autoApproved: false,
    };
  }

  const correction = await prisma.correction.create({
    data: {
      campaignId: viewer.campaignId,
      statement,
      wasWrong,
      proposedByMembershipId: membershipId,
      targetUnitIds: targetIds,
      rewrites,
      resultTitle: out.newFactTitle || null,
      resultContent: out.newFactContent || null,
    },
  });

  // The DM proposing IS the approval — there is no one above them to ask.
  if (viewer.role === "DM") {
    await applyCorrection(correction.id, membershipId, viewer.campaignId);
  }

  const targets = rewrites.map((r) => {
    const original = candidates.find((c) => c.id === r.id);
    return {
      id: r.id,
      title: original?.title ?? "(unknown)",
      content: original?.content ?? "",
      rewrite: r.rewrite,
    };
  });

  return {
    id: correction.id,
    statement,
    status: viewer.role === "DM" ? "APPROVED" : "PENDING",
    targets,
    newFactTitle: out.newFactTitle || null,
    newFactContent: out.newFactContent || null,
    autoApproved: viewer.role === "DM",
  };
}

/**
 * Apply an approved correction: replace each contradicted fact with its corrected version and
 * retire the original. Originals are marked, not deleted, so the audit trail still points at
 * something real and the DM can see exactly what changed.
 */
export async function applyCorrection(
  correctionId: string,
  reviewerMembershipId: string,
  campaignId: string,
): Promise<{
  rewritten: number;
  retiredFacts: number;
  retiredPassages: number;
  added: boolean;
}> {
  // Scope to the reviewer's own campaign. The id arrives from a Discord interaction, and a
  // correction belonging to another table must never be applicable from this one — the
  // reviewer isn't its DM, whatever role they hold here.
  const correction = await prisma.correction.findFirst({
    where: { id: correctionId, campaignId },
  });
  if (!correction) throw new Error(`correction ${correctionId} not found`);

  // Claim it atomically BEFORE doing any work. A read-then-check would let two clicks (or two
  // processes) both pass the check and apply the same correction twice, and would also let a
  // REJECTED correction through. Whoever flips PENDING→APPROVED first owns it.
  const claimed = await prisma.correction.updateMany({
    where: { id: correctionId, campaignId, status: "PENDING" },
    data: {
      status: "APPROVED",
      reviewedByMembershipId: reviewerMembershipId,
      reviewedAt: new Date(),
    },
  });
  if (claimed.count === 0) {
    throw new Error("that correction is not awaiting a decision");
  }

  const rewrites = (correction.rewrites ?? []) as {
    id: string;
    rewrite: string;
    kind?: "FACT" | "PASSAGE";
  }[];
  const chunkIds = rewrites
    .filter((r) => r.kind === "PASSAGE")
    .map((r) => r.id);
  const unitRewrites = rewrites.filter((r) => r.kind !== "PASSAGE");

  // Load the originals so replacements can inherit their shape. Scoped to the campaign so a
  // stale id can't reach across tenants.
  const originals = await prisma.knowledgeUnit.findMany({
    where: {
      id: { in: unitRewrites.map((r) => r.id) },
      campaignId: correction.campaignId,
      // Another correction may have retired this since the proposal was made. Rewriting from
      // its stale content would resurrect a fact the table has already moved past.
      supersededByCorrectionId: null,
    },
    include: { grants: true },
  });

  const toEmbed: { id: string; text: string }[] = [];
  let rewritten = 0;
  let retiredPassages = 0;

  await prisma.$transaction(async (tx) => {
    for (const original of originals) {
      const text = rewrites.find((r) => r.id === original.id)?.rewrite?.trim();
      // An empty rewrite means nothing in the fact was salvageable — retire it outright.
      if (text) {
        const replacement = await tx.knowledgeUnit.create({
          data: {
            campaignId: original.campaignId,
            type: original.type,
            // CORRECTION, not the original source: re-extracting a session deletes and
            // recreates its SESSION units, which would take a corrected copy with it.
            source: "CORRECTION",
            origin: original.origin,
            // Inherit visibility and grants — a correction fixes what a fact SAYS, never who
            // may see it. Defaulting to EVERYONE here would turn a fixed typo into a leak.
            baseVisibility: original.baseVisibility,
            title: original.title,
            content: text,
            gameSessionId: original.gameSessionId,
            sourceDocumentId: original.sourceDocumentId,
            authorMembershipId: original.authorMembershipId,
            imageStoragePath: original.imageStoragePath,
            subjectId: original.subjectId,
            objectId: original.objectId,
          },
        });
        if (original.grants.length > 0) {
          await tx.knowledgeGrant.createMany({
            data: original.grants.map((g) => ({
              knowledgeUnitId: replacement.id,
              characterId: g.characterId,
              partyId: g.partyId,
              revealedByMembershipId: g.revealedByMembershipId,
            })),
          });
        }
        toEmbed.push({
          id: replacement.id,
          text: `${replacement.title}. ${text}`,
        });
        rewritten++;
      }
      await tx.knowledgeUnit.update({
        where: { id: original.id },
        data: { supersededByCorrectionId: correction.id },
      });
    }

    // Retire contradicted document passages. They aren't rewritten — the document is their
    // source of truth — so retrieval simply stops reaching them.
    if (chunkIds.length > 0) {
      const retired = await tx.documentChunk.updateMany({
        where: {
          id: { in: chunkIds },
          campaignId: correction.campaignId,
          supersededByCorrectionId: null,
        },
        data: { supersededByCorrectionId: correction.id },
      });
      retiredPassages = retired.count;
    }

    // An extra fact, only when the rewrites didn't already cover what was said.
    let resultUnitId: string | undefined;
    if (correction.resultTitle && correction.resultContent) {
      const added = await tx.knowledgeUnit.create({
        data: {
          campaignId: correction.campaignId,
          type: "FACT",
          source: "CORRECTION",
          origin: "AUTHORED",
          // A standalone correction states what the table itself believes, so it's table-visible.
          baseVisibility: "EVERYONE",
          title: correction.resultTitle,
          content: correction.resultContent,
        },
      });
      resultUnitId = added.id;
      toEmbed.push({
        id: added.id,
        text: `${correction.resultTitle}. ${correction.resultContent}`,
      });
    }

    if (resultUnitId) {
      await tx.correction.update({
        where: { id: correction.id },
        data: { resultUnitId },
      });
    }
  });

  // Embed outside the transaction — a slow API call shouldn't hold locks, and an unembedded
  // unit is merely unsearchable, not wrong.
  if (toEmbed.length > 0) {
    const vectors = await embedTexts(
      toEmbed.map((t) => t.text),
      "document",
    );
    for (let i = 0; i < toEmbed.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      await prisma.$executeRaw`UPDATE "KnowledgeUnit" SET embedding = ${toVectorLiteral(vec)}::vector WHERE id = ${toEmbed[i]!.id}`;
    }
  }

  return {
    rewritten,
    retiredFacts: originals.length - rewritten,
    retiredPassages,
    added: Boolean(correction.resultTitle && correction.resultContent),
  };
}

/** The DM decided the memory was right. Nothing changes but the record of the decision. */
export async function rejectCorrection(
  correctionId: string,
  reviewerMembershipId: string,
  campaignId: string,
  reviewNote?: string,
): Promise<void> {
  // Campaign-scoped for the same reason as applying one.
  const { count } = await prisma.correction.updateMany({
    where: { id: correctionId, campaignId, status: "PENDING" },
    data: {
      status: "REJECTED",
      reviewedByMembershipId: reviewerMembershipId,
      reviewedAt: new Date(),
      reviewNote,
    },
  });
  if (count === 0) {
    throw new Error("that correction is not awaiting a decision");
  }
}

/** Corrections awaiting the DM, oldest first. */
export async function pendingCorrections(campaignId: string) {
  return prisma.correction.findMany({
    where: { campaignId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: {
      proposedBy: {
        include: { characters: { where: { campaignId }, take: 1 } },
      },
    },
  });
}
