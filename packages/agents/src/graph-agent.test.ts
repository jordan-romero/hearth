import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  answerWithGraph,
  containsAnyWord,
  isNotFound,
  MAX_STEPS,
} from "./graph-agent.js";

const dm = {
  campaignId: "c1",
  role: "DM" as const,
  characterId: null,
  partyId: null,
};

// A model that replies from a script. It never touches the database: the tools it calls here are
// ones that don't need it.
function scripted(
  turns: (
    req: { tool_choice?: { type: string } },
    n: number,
  ) => Anthropic.Message["content"],
) {
  let n = 0;
  const requests: { tool_choice?: { type: string } }[] = [];
  const client = {
    messages: {
      stream: (req: { tool_choice?: { type: string } }) => ({
        finalMessage: async () => {
          requests.push(req);
          const content = turns(req, n++);
          return {
            content,
            stop_reason: content.some((b) => b.type === "tool_use")
              ? "tool_use"
              : "end_turn",
            usage: { input_tokens: 100, output_tokens: 10 },
          };
        },
      }),
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const text = (t: string) =>
  ({ type: "text", text: t, citations: null }) as Anthropic.TextBlock;
const call = (name: string, input: object, id = `t${Math.random()}`) =>
  ({ type: "tool_use", id, name, input }) as Anthropic.ToolUseBlock;

describe("answerWithGraph", () => {
  it("returns the answer the model writes", async () => {
    const { client } = scripted(() => [
      text("Her mother was Elspeth.\n\nSources: NPCs.md"),
    ]);
    const out = await answerWithGraph(dm, "Who is Wren's mother?", client);
    expect(out.answer).toContain("Elspeth");
    expect(out.steps).toBe(0);
  });

  it("hands the question to the whole library when the model asks to", async () => {
    const { client } = scripted(() => [call("read_everything", {})]);
    const out = await answerWithGraph(dm, "What happened in the war?", client);
    expect(out.answer).toBeNull();
    expect(out.tools).toEqual(["read_everything"]);
  });

  it("hands the question to the whole library when the graph doesn't have the answer", async () => {
    const { client } = scripted(() => [text("NOT_FOUND")]);
    const out = await answerWithGraph(dm, "How did Wren's mother die?", client);
    expect(out.answer).toBeNull();
    expect(out.notFound).toBe(true);
  });

  it("stops after its step budget and makes the model answer with what it has", async () => {
    const { client, requests } = scripted((req) =>
      req.tool_choice?.type === "none"
        ? [text("The records don't say.")]
        : [call("no_such_tool", {})],
    );
    const out = await answerWithGraph(dm, "Who?", client);
    expect(requests).toHaveLength(MAX_STEPS + 1);
    expect(requests.at(-1)!.tool_choice).toEqual({ type: "none" });
    expect(out.answer).toBe("The records don't say.");
  });

  it("tells the model a handle it never looked up is unknown, instead of guessing", async () => {
    const results: string[] = [];
    const { client } = scripted((_req, n) =>
      n === 0 ? [call("facts", { entity: "#7" }, "t1")] : [text("Done.")],
    );
    const original = client.messages.stream;
    (client.messages as { stream: unknown }).stream = (req: {
      messages: Anthropic.MessageParam[];
    }) => {
      const last = req.messages.at(-1)!;
      if (Array.isArray(last.content))
        for (const b of last.content)
          if (b.type === "tool_result") results.push(String(b.content));
      return (original as (r: unknown) => unknown)(req);
    };
    await answerWithGraph(dm, "Tell me facts", client);
    expect(results[0]).toMatch(/Unknown handle #7/);
  });
});

describe("containsAnyWord", () => {
  it("matches word beginnings", () => {
    expect(containsAnyWord("She died of a fever.", ["die"])).toBe(true);
    expect(containsAnyWord("Her death was quiet.", ["death"])).toBe(true);
  });

  it("does not match inside a word", () => {
    expect(containsAnyWord("She was studied closely.", ["die"])).toBe(false);
  });

  it("matches a phrase", () => {
    expect(containsAnyWord("Lost at sea in the storm.", ["at sea"])).toBe(true);
  });

  it("keeps everything when no usable words are given", () => {
    expect(containsAnyWord("Anything.", [])).toBe(true);
  });
});

describe("isNotFound", () => {
  it("recognises the marker, and only the marker", () => {
    expect(isNotFound("NOT_FOUND")).toBe(true);
    expect(isNotFound("  not found\nI checked connections.")).toBe(true);
    expect(isNotFound("Her mother was not found guilty.")).toBe(false);
  });
});
