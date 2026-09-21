import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { extractSession, SESSION_WINDOW } from "./extract.js";

// A stand-in for the model. It sees each request's tool and text, and answers like the real thing
// would — including cutting a reply off, which is the failure this exists for.
type Reply = { input: Record<string, unknown> | null; stop?: string };
function fakeClient(answer: (tool: string, text: string) => Reply) {
  const calls: { tool: string; chars: number }[] = [];
  const client = {
    messages: {
      stream: (req: {
        tools: { name: string }[];
        messages: { content: string }[];
      }) => ({
        finalMessage: async () => {
          const tool = req.tools[0]!.name;
          const text = req.messages[0]!.content;
          calls.push({ tool, chars: text.length });
          const reply = answer(tool, text);
          return {
            stop_reason: reply.stop ?? "tool_use",
            content: reply.input
              ? [{ type: "tool_use", name: tool, input: reply.input }]
              : [],
          };
        },
      }),
    },
  } as unknown as Anthropic;
  return { client, calls };
}

// Invented table talk, one speaker line per line — as the worker builds it.
const line = (i: number) =>
  `DM: The ferry reaches Gull Rock as the tide turns, and the bell rings ${i} times.`;
const transcript = (lines: number) =>
  Array.from({ length: lines }, (_, i) => line(i)).join("\n");

describe("extractSession — who learned each fact", () => {
  it("keeps every part's view of who learned a subject, for the worker to narrow", async () => {
    // The same subject comes up twice: once in front of the group, once in a private scene. The
    // merged fact holds both halves, so both proposals have to survive — granting it to the party
    // because one part said so would hand out what only one character heard.
    const long = transcript(1200);
    let part = 0;
    const { client } = fakeClient((tool) =>
      tool === "record_recap"
        ? { input: { recap: "The ferry crossed." } }
        : {
            input: {
              units: [
                {
                  type: "NPC",
                  title: "The ferryman",
                  content: `Part ${++part}.`,
                  audience: part === 1 ? "party" : ["Morwyn"],
                },
              ],
            },
          },
    );
    const { units } = await extractSession(long, client);

    expect(units).toHaveLength(1);
    expect(units[0]!.audiences).toContain("party");
    expect(units[0]!.audiences).toContainEqual(["Morwyn"]);
  });

  it("records no audience when the model didn't give one", async () => {
    // Which means the fact reaches nobody until the DM decides — never everyone by default.
    const { client } = fakeClient((tool) =>
      tool === "record_recap"
        ? { input: { recap: "Quiet session." } }
        : {
            input: {
              units: [
                { type: "EVENT", title: "The bell", content: "It rang." },
              ],
            },
          },
    );
    const { units } = await extractSession(transcript(5), client);
    expect(units[0]!.audiences).toEqual([undefined]);
  });

  it("ignores an audience that is neither the party nor a list of names", async () => {
    const { client } = fakeClient((tool) =>
      tool === "record_recap"
        ? { input: { recap: "Quiet session." } }
        : {
            input: {
              units: [
                {
                  type: "EVENT",
                  title: "The bell",
                  content: "It rang.",
                  audience: "everyone in the world",
                },
              ],
            },
          },
    );
    const { units } = await extractSession(transcript(5), client);
    expect(units[0]!.audiences).toEqual([undefined]);
  });
});

describe("extractSession", () => {
  it("reads a long session in parts and never cuts a line in two", async () => {
    const long = transcript(1200); // well past one part
    const { client, calls } = fakeClient((tool, text) =>
      tool === "record_recap"
        ? { input: { recap: "The ferry crossed." } }
        : {
            input: {
              units: [
                {
                  type: "LOCATION",
                  title: "Gull Rock",
                  content: `Part of ${text.length} chars.`,
                },
              ],
            },
          },
    );
    const result = await extractSession(long, client);

    const unitCalls = calls.filter((c) => c.tool === "record_units");
    expect(unitCalls.length).toBeGreaterThan(1);
    // The recap reads the whole transcript in one call.
    expect(calls.filter((c) => c.tool === "record_recap")).toHaveLength(1);
    expect(calls.find((c) => c.tool === "record_recap")!.chars).toBeGreaterThan(
      long.length,
    );
    expect(result.recap).toBe("The ferry crossed.");
    // The same subject from every part becomes one fact.
    expect(result.units.filter((u) => u.title === "Gull Rock")).toHaveLength(1);
  });

  it("splits a part whose reply was cut off, instead of losing every fact after the cut", async () => {
    const part = transcript(200); // one part
    expect(part.length).toBeLessThan(SESSION_WINDOW);
    let firstUnitsCall = true;
    const { client, calls } = fakeClient((tool, text) => {
      if (tool === "record_recap") return { input: { recap: "Recap." } };
      if (firstUnitsCall) {
        firstUnitsCall = false;
        return { input: { units: [] }, stop: "max_tokens" };
      }
      return {
        input: {
          units: [
            {
              type: "EVENT",
              title: `Half of ${text.length}`,
              content: "Something happened.",
            },
          ],
        },
      };
    });
    const result = await extractSession(part, client);
    // One cut-off call, then the part re-read in pieces — split at line breaks, so it can take
    // more than two pieces to stay under half. Every piece's facts survive.
    const unitCalls = calls.filter((c) => c.tool === "record_units");
    expect(unitCalls.length).toBeGreaterThanOrEqual(3);
    expect(unitCalls.slice(1).every((c) => c.chars < unitCalls[0]!.chars)).toBe(
      true,
    );
    expect(result.units).toHaveLength(unitCalls.length - 1);
  });

  it("fails loudly when the recap is cut off, so the session can be re-run", async () => {
    const { client } = fakeClient((tool) =>
      tool === "record_recap"
        ? { input: { recap: "Half a rec" }, stop: "max_tokens" }
        : { input: { units: [] } },
    );
    await expect(extractSession(transcript(10), client)).rejects.toThrow(
      /recap was cut off/,
    );
  });

  it("drops malformed units without failing the session", async () => {
    const { client } = fakeClient((tool) =>
      tool === "record_recap"
        ? { input: { recap: "Recap." } }
        : {
            input: {
              units: [
                { type: "NPC", title: "Tobin", content: "Rows the ferry." },
                { type: "NPC", title: "", content: "No title." },
                { type: "WIZARD", title: "Bad type", content: "Unknown kind." },
                null,
              ],
            },
          },
    );
    const result = await extractSession(transcript(10), client);
    expect(result.units.map((u) => u.title)).toEqual(["Tobin"]);
  });
});
