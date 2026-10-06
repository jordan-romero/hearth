// Claude beside the page (docs/workspace.md §4): the DM's writing partner in the workspace. It
// reads the open page, searches the whole campaign, follows the relationship graph, and PROPOSES
// text — nothing reaches a page until the DM clicks Insert.
//
// Every tool runs with the campaign from the request, never one the model names, and as the DM
// (who may see everything in their own campaign). The loop streams text as it's written and
// reports each tool call, so the panel shows what Claude is doing.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@hearth/db";
import type { Viewer } from "@hearth/core";
import { retrieveContext } from "./retrieve.js";
import { gatherSubjectContext } from "./graph-context.js";
import { getPage, getWorkspaceTree } from "./workspace.js";
import { markdownToPage } from "./markdown-to-page.js";
import { extractHighlights } from "./highlights.js";
import type { PmNode } from "./page-markdown.js";
import { addUsage, logUsage, noUsage, usageOf } from "./usage.js";

export const ASSISTANT_MODEL = "claude-sonnet-5-5";
const MAX_ROUNDS = 10;
const MAX_TOOL_CHARS = 24_000;
const MAX_PAGE_CHARS = 30_000;

/** What the panel receives, one JSON object per line. */
export type AssistantEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; label: string }
  | {
      type: "proposal";
      id: string;
      placement: Placement;
      summary: string;
      markdown: string;
      doc: PmNode;
    }
  | { type: "done"; messages: Anthropic.Beta.BetaMessageParam[] }
  | { type: "error"; message: string };

export type Placement = "cursor" | "replace_selection" | "end";

/** The conversation as each turn returns it — sent back unchanged on the next turn. */
export type AssistantHistory = Anthropic.Beta.BetaMessageParam[];

export interface OpenPage {
  pageId: string | null;
  /** The text the DM has selected, if any. */
  selection: string;
}

const SYSTEM = `You are the writing partner of a tabletop RPG Dungeon Master, working inside Hearth, where their campaign lives. You sit beside the page they are writing.

The campaign has two kinds of material:
- Canon: what is true in the world. Session facts, and passages the DM has highlighted as canon (with who in the party knows them).
- Working prep: everything else on the DM's pages — drafts, ideas, prepared story that hasn't happened yet. Useful, but not established.

How to work:
- Ground suggestions in the campaign. Use search_campaign, read_page, list_pages and get_entity before answering anything about people, places, factions or events. Prefer several targeted searches over one vague one.
- Say where things come from: name the page or session ("from NPCs / Vess", "Session 12"). Flag working prep as prep ("your notes suggest…, not yet canon").
- You may invent — names, NPCs, lines of a speech — when the DM asks for it, but never present an invention as established canon, and keep it consistent with what the campaign already says.
- When you write text meant for the page (a paragraph, a list of NPCs, a rewrite of their selection), call propose_edit with it in markdown. The DM sees it as a card and decides whether to insert it; you never change pages yourself. Keep your chat reply short when you propose — the card holds the content.
- Be concise and concrete. No preamble.`;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_campaign",
    description:
      "Search everything in this campaign: the DM's pages and imports, session recaps and transcripts-derived facts, uploaded documents. Combines exact-word and meaning search. Returns passages and facts with their source, and whether each fact is canon and who knows it.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, in plain words.",
        },
        limit: {
          type: "integer",
          description: "How many results of each kind, 1-15. Default 8.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "read_page",
    description:
      "Read one workspace page in full, as markdown, with its folder path and which passages are highlighted as canon. Use the page ids from list_pages or the open page.",
    input_schema: {
      type: "object",
      properties: { page_id: { type: "string" } },
      required: ["page_id"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "list_pages",
    description:
      "List the DM's workspace: every folder and page, with page ids.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "get_entity",
    description:
      "Everything the campaign's relationship graph and material says about a person, place, faction or item by name: aliases, who they're connected to and how, and the passages about them.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "propose_edit",
    description:
      "Offer text for the open page. The DM sees it as a card with an Insert button; nothing changes until they click. Write it in markdown (headings, lists, bold, tables are fine).",
    input_schema: {
      type: "object",
      properties: {
        placement: {
          type: "string",
          enum: ["cursor", "replace_selection", "end"],
          description:
            "cursor: insert where the DM's cursor is. replace_selection: replace the text they selected. end: append to the page.",
        },
        markdown: { type: "string", description: "The text to insert." },
        summary: {
          type: "string",
          description:
            "A few words saying what this is, e.g. '5 NPCs for the crowd'.",
        },
      },
      required: ["placement", "markdown", "summary"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
];

const str = (v: unknown, max = 2000): string | null =>
  typeof v === "string" && v.trim() ? v.slice(0, max) : null;

const cap = (s: string) =>
  s.length > MAX_TOOL_CHARS
    ? `${s.slice(0, MAX_TOOL_CHARS)}\n\n[…truncated]`
    : s;

/** A short line for the panel describing a tool call, so the DM sees what Claude is doing. */
function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "search_campaign":
      return `Searching the campaign for “${str(input.query, 80) ?? "…"}”`;
    case "read_page":
      return "Reading a page";
    case "list_pages":
      return "Looking through your pages";
    case "get_entity":
      return `Looking up ${str(input.name, 60) ?? "someone"}`;
    case "propose_edit":
      return "Drafting a suggestion";
    default:
      return name;
  }
}

async function folderPathOf(
  campaignId: string,
  folderId: string | null,
): Promise<string> {
  const { folders } = await getWorkspaceTree(campaignId);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  for (
    let f = folderId ? byId.get(folderId) : undefined;
    f;
    f = f.parentId ? byId.get(f.parentId) : undefined
  ) {
    parts.unshift(f.name);
  }
  return parts.join(" / ");
}

type ToolOutcome = {
  content: string;
  isError?: boolean;
  proposal?: Extract<AssistantEvent, { type: "proposal" }>;
};

export async function runAssistantTool(
  viewer: Viewer,
  id: string,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const campaignId = viewer.campaignId;
  switch (name) {
    case "search_campaign": {
      const query = str(input.query, 500);
      if (!query) return { content: "query is required", isError: true };
      const limit = Math.min(Math.max(Number(input.limit) || 8, 1), 15);
      const { units, chunks } = await retrieveContext(viewer, query, {
        unitLimit: limit,
        chunkLimit: limit,
      });
      const names = new Map(
        (
          await prisma.character.findMany({
            where: { campaignId },
            select: { id: true, name: true },
          })
        ).map((c) => [c.id, c.name]),
      );
      const facts = units.map((u) => {
        const knownBy =
          u.baseVisibility !== "DM_ONLY"
            ? "the whole table"
            : u.grantedCharacterIds.length
              ? u.grantedCharacterIds
                  .map((c) => names.get(c) ?? "a character")
                  .join(", ")
              : "nobody yet";
        const state =
          u.canon === "WORKING" ? "working prep" : `canon, known by ${knownBy}`;
        return `- [${u.type}] ${u.title}: ${u.content} (${state})`;
      });
      const passages = chunks.map(
        (c) => `--- from “${c.docName}” ---\n${c.text}`,
      );
      if (!facts.length && !passages.length)
        return { content: "Nothing in the campaign matches that." };
      return {
        content: cap(
          [
            facts.length ? `Facts:\n${facts.join("\n")}` : "",
            passages.length ? `Passages:\n${passages.join("\n\n")}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      };
    }
    case "read_page": {
      const pageId = str(input.page_id, 100);
      const page = pageId ? await getPage(campaignId, pageId) : null;
      if (!page || page.archivedAt)
        return { content: "No such page in this campaign.", isError: true };
      const path = await folderPathOf(campaignId, page.folderId);
      const md =
        (
          await prisma.page.findUnique({
            where: { id: page.id },
            select: { markdown: true },
          })
        )?.markdown ?? "";
      const canon = extractHighlights(page.content);
      return {
        content: cap(
          `# ${page.title || "Untitled"}\n(${path ? `in ${path}` : "top level"}, id ${page.id})\n\n${md || "(empty page)"}` +
            (canon.length
              ? `\n\nHighlighted as canon:\n${canon.map((h) => `- “${h.text}” (${h.everyone ? "whole table knows" : h.known.length ? `${h.known.length} character(s) know` : "nobody knows yet"})`).join("\n")}`
              : "\n\n(No passages on this page are marked canon; it's working prep.)"),
        ),
      };
    }
    case "list_pages": {
      const { folders, pages } = await getWorkspaceTree(campaignId);
      const byId = new Map(folders.map((f) => [f.id, f]));
      const pathOf = (fid: string | null): string => {
        const parts: string[] = [];
        for (
          let f = fid ? byId.get(fid) : undefined;
          f;
          f = f.parentId ? byId.get(f.parentId) : undefined
        )
          parts.unshift(f.name);
        return parts.join(" / ") || "(top level)";
      };
      const lines = pages
        .map(
          (p) =>
            `${pathOf(p.folderId)} :: ${p.title || "Untitled"} (id ${p.id})`,
        )
        .sort();
      return {
        content: cap(
          lines.length ? lines.join("\n") : "The workspace has no pages yet.",
        ),
      };
    }
    case "get_entity": {
      const name = str(input.name, 120);
      if (!name) return { content: "name is required", isError: true };
      const subject = await gatherSubjectContext(viewer, name);
      if (!subject)
        return {
          content: `The campaign graph has nobody or nothing called “${name}”. Try search_campaign.`,
        };
      return {
        content: cap(
          [subject.text, subject.corpus.shared, subject.corpus.personal]
            .filter(Boolean)
            .join("\n\n"),
        ),
      };
    }
    case "propose_edit": {
      const markdown = str(input.markdown, 40_000);
      const summary = str(input.summary, 120) ?? "Suggested text";
      const placement = input.placement;
      if (!markdown) return { content: "markdown is required", isError: true };
      if (
        placement !== "cursor" &&
        placement !== "replace_selection" &&
        placement !== "end"
      ) {
        return {
          content: "placement must be cursor, replace_selection or end",
          isError: true,
        };
      }
      return {
        content:
          "Shown to the DM as a suggestion card. It is not on the page unless they insert it.",
        proposal: {
          type: "proposal",
          id,
          placement,
          summary,
          markdown,
          doc: markdownToPage(markdown),
        },
      };
    }
    default:
      return { content: `Unknown tool ${name}`, isError: true };
  }
}

/** The first user turn carries the open page; later turns name it so Claude can re-read it. */
export async function openPageContext(
  campaignId: string,
  open: OpenPage,
  full: boolean,
): Promise<string> {
  if (!open.pageId) return "The DM has no page open.";
  const page = await getPage(campaignId, open.pageId);
  if (!page) return "The DM has no page open.";
  const selection = open.selection.trim()
    ? `\nThey have selected: “${open.selection.trim().slice(0, 4000)}”`
    : "";
  if (!full)
    return `The DM is on the page “${page.title || "Untitled"}” (id ${page.id}).${selection}`;
  const path = await folderPathOf(campaignId, page.folderId);
  const md =
    (
      await prisma.page.findUnique({
        where: { id: page.id },
        select: { markdown: true },
      })
    )?.markdown ?? "";
  const body =
    md.length > MAX_PAGE_CHARS
      ? `${md.slice(0, MAX_PAGE_CHARS)}\n[…the rest is long; use read_page]`
      : md;
  return `The DM is writing the page “${page.title || "Untitled"}” (${path ? `in ${path}` : "top level"}, id ${page.id}).${selection}\n\n<open_page>\n${body || "(empty so far)"}\n</open_page>`;
}

const client = new Anthropic();

/**
 * Run one turn of the conversation: Claude reads, searches and proposes until it's done, streaming
 * events as it goes. `history` is the conversation so far as returned by the previous turn's
 * `done` event (append-only — thinking blocks in it must come back unchanged).
 */
export async function runAssistant(input: {
  viewer: Viewer;
  history: Anthropic.Beta.BetaMessageParam[];
  userText: string;
  open: OpenPage;
  emit: (e: AssistantEvent) => void;
}): Promise<void> {
  const { viewer, emit } = input;
  if (viewer.role !== "DM")
    throw new Error("the workspace assistant is the DM's");
  const context = await openPageContext(
    viewer.campaignId,
    input.open,
    input.history.length === 0,
  );
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...input.history,
    { role: "user", content: `${context}\n\n${input.userText}` },
  ];
  let usage = noUsage();

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const stream = client.beta.messages.stream({
        model: ASSISTANT_MODEL,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system: [
          { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
        ],
        tools: TOOLS,
        messages,
      });
      stream.on("text", (delta) => emit({ type: "text", delta }));

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        // Typed API errors propagate; anything else is a tool input that couldn't be parsed —
        // re-issue the round once rather than run on garbage.
        if (err instanceof Anthropic.APIError || round === MAX_ROUNDS - 1)
          throw err;
        console.error("[assistant] unparseable tool input, re-issuing:", err);
        continue;
      }
      usage = addUsage(usage, usageOf(message as unknown as Anthropic.Message));
      messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "refusal") {
        emit({
          type: "error",
          message: "Claude declined to continue with that request.",
        });
        break;
      }
      if (message.stop_reason === "pause_turn") continue;
      const toolUses = message.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      if (toolUses.length === 0) break; // end_turn (or another terminal stop)
      if (message.stop_reason === "max_tokens") {
        emit({
          type: "error",
          message:
            "That answer ran too long and was cut off. Try asking for less at once.",
        });
        break;
      }

      const results = await Promise.all(
        toolUses.map(
          async (t): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
            const toolInput =
              t.input && typeof t.input === "object"
                ? (t.input as Record<string, unknown>)
                : {};
            emit({ type: "tool", label: toolLabel(t.name, toolInput) });
            try {
              const outcome = await runAssistantTool(
                viewer,
                t.id,
                t.name,
                toolInput,
              );
              if (outcome.proposal) emit(outcome.proposal);
              return {
                type: "tool_result",
                tool_use_id: t.id,
                content: outcome.content,
                is_error: outcome.isError,
              };
            } catch (err) {
              console.error(`[assistant] tool ${t.name} failed:`, err);
              return {
                type: "tool_result",
                tool_use_id: t.id,
                content: "That lookup failed.",
                is_error: true,
              };
            }
          },
        ),
      );
      messages.push({ role: "user", content: results });
    }
    emit({ type: "done", messages });
  } catch (err) {
    console.error("[assistant] failed:", err);
    emit({
      type: "error",
      message:
        err instanceof Anthropic.RateLimitError
          ? "Claude is busy right now — try again in a moment."
          : "Something went wrong talking to Claude. Try again.",
    });
  } finally {
    logUsage("assistant", usage, `campaign ${viewer.campaignId}`);
  }
}
