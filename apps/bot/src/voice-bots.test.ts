import { describe, it, expect } from "vitest";
import { isBotUser, type GuildMembersLike } from "./voice-bots.js";

function guild(
  cached: Record<string, boolean>,
  fetchable: Record<string, boolean> = {},
): GuildMembersLike {
  return {
    members: {
      cache: {
        get: (id) =>
          id in cached ? { user: { bot: cached[id]! } } : undefined,
      },
      fetch: async (id) => {
        if (!(id in fetchable)) throw new Error("Unknown Member");
        return { user: { bot: fetchable[id]! } };
      },
    },
  };
}

describe("isBotUser", () => {
  it("recognises a music bot like Kenku FM", async () => {
    expect(await isBotUser(guild({ kenku: true }), "kenku")).toBe(true);
  });

  it("records a player", async () => {
    expect(await isBotUser(guild({ player: false }), "player")).toBe(false);
  });

  it("looks up someone who isn't cached yet", async () => {
    expect(await isBotUser(guild({}, { kenku: true }), "kenku")).toBe(true);
  });

  it("treats someone it can't look up as a person, not a bot", async () => {
    expect(await isBotUser(guild({}), "stranger")).toBe(false);
  });
});
