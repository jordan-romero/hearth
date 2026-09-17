import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { chooseRecap, writeCharacterRecaps } from "./character-recap.js";

// Invented names only.

function fakeClient(
  reply: (
    prompt: string,
  ) => { input: Record<string, unknown> | null; stop?: string } | Error,
) {
  const prompts: string[] = [];
  const client = {
    messages: {
      stream: (req: { messages: { content: { text: string }[] }[] }) => ({
        finalMessage: async () => {
          const prompt = req.messages[0]!.content.map((c) => c.text).join("\n");
          prompts.push(prompt);
          const r = reply(prompt);
          if (r instanceof Error) throw r;
          return {
            stop_reason: r.stop ?? "tool_use",
            content: r.input
              ? [
                  {
                    type: "tool_use",
                    name: "record_character_recap",
                    input: r.input,
                  },
                ]
              : [],
          };
        },
      }),
    },
  } as unknown as Anthropic;
  return { client, prompts };
}

const tobin = { id: "c-tobin", name: "Tobin", class: "Ranger" };
const wren = { id: "c-wren", name: "Wren", pronouns: "she/her" };
const ash = { id: "c-ash", name: "Ash" };

describe("writeCharacterRecaps", () => {
  it("writes one recap per character, naming who it's for", async () => {
    const { client, prompts } = fakeClient((p) => ({
      input: {
        summary: `Summary for ${p.includes("Tobin (Ranger)") ? "Tobin" : "Wren"}`,
        in_character: "I remember the ferry.",
      },
    }));
    const { recaps, failed } = await writeCharacterRecaps(
      "DM: The ferry docks.",
      [tobin, wren],
      client,
    );
    expect(failed).toBe(0);
    expect(recaps.map((r) => r.characterId).sort()).toEqual([
      "c-tobin",
      "c-wren",
    ]);
    expect(prompts.some((p) => p.includes("Wren (she/her)"))).toBe(true);
  });

  it("leaves out a recap that was cut off or empty, and keeps the others", async () => {
    const { client } = fakeClient((p) =>
      p.includes("for Tobin")
        ? {
            input: { summary: "Half a sum", in_character: "I" },
            stop: "max_tokens",
          }
        : p.includes("for Ash")
          ? new Error("network")
          : { input: { summary: "Wren's night.", in_character: "My night." } },
    );
    const { recaps, failed } = await writeCharacterRecaps(
      "DM: …",
      [tobin, wren, ash],
      client,
    );
    expect(recaps.map((r) => r.characterId)).toEqual(["c-wren"]);
    expect(failed).toBe(2);
  });
});

describe("chooseRecap", () => {
  const own = { summary: "What Wren saw.", inCharacter: "What I saw." };

  it("gives the DM the whole table's recap", () => {
    expect(chooseRecap("DM", "Everything.", own, true)).toEqual({
      kind: "table",
      text: "Everything.",
    });
  });

  it("gives a player their character's recap — never the table's when theirs exists", () => {
    expect(
      chooseRecap("PLAYER", "Everything, secrets too.", own, false),
    ).toEqual({
      kind: "character",
      text: "What Wren saw.",
      voice: false,
    });
  });

  it("in their character's voice when asked", () => {
    expect(chooseRecap("PLAYER", "Everything.", own, true)).toEqual({
      kind: "character",
      text: "What I saw.",
      voice: true,
    });
  });

  it("never shows a player the table's recap, even when their character has none", () => {
    expect(
      chooseRecap("PLAYER", "Everything, secrets too.", null, false),
    ).toEqual({ kind: "none" });
    expect(
      chooseRecap("PLAYER", "Everything, secrets too.", null, true),
    ).toEqual({ kind: "none" });
  });
});
